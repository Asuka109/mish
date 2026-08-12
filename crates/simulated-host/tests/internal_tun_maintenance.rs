use std::{
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    os::unix::fs::PermissionsExt,
    sync::Arc,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use mish_bridge::{
    BridgeShutdownOutcome, LoopbackPortSelection, LoopbackServerConfig,
    TunHelperRemovalCleanupOutcome, TunHelperRemovalLifecyclePhase,
    TunHelperRemovalObservationOutcome, TunHelperRemovalOccurrenceFailure,
    TunHelperRemovalOccurrenceStore, start_loopback_server_with_runtime_host,
};
use mish_platform_macos::internal_tun_maintenance::{
    EnrollmentTransition, MaintenanceCommitPoint, MaintenanceKind, MaintenanceTerminalOutcome,
};
use mish_runtime::{
    CaptureRequest, CaptureSelection, CoreLifecycleMutation, CoreLifecycleOperation, RuntimePhase,
    StatusAdapterKind, TunHelperFailureKind, TunHelperRemovalCapability,
};
use mish_settings::{SettingsAdapterKind, SettingsServiceError};
use mish_simulated_host::{
    EffectKind, EffectResultKind, InjectedFailure, InjectedFailureKind, MAX_TRANSCRIPT_LIMIT,
    MaintenanceCompletionInjection, MaintenanceFault, MaintenanceFaultKind, MaintenanceObservation,
    MaintenanceScenario, MaintenanceScenarioRuntime, ManagedEndpointOwner, ScenarioObservation,
    ScheduledChange, SimulatedHostScenario, SyntheticMaintenanceInitial, SyntheticOwnership,
    SyntheticPackageProjection, SyntheticPackageVersion, SyntheticProxyState, TEST_AUTH_TOKEN,
};
use mish_state_machine::Disposition;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const RPC_ORIGIN: &str = "http://mish.test";

type RpcSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn rpc_socket(address: SocketAddr) -> RpcSocket {
    let mut request = format!("ws://{address}/rpc").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", RPC_ORIGIN.parse().unwrap());
    connect_async(request).await.unwrap().0
}

async fn rpc_next(socket: &mut RpcSocket) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("RPC response timed out")
            .expect("RPC socket closed")
            .expect("RPC websocket failed");
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn rpc_request(socket: &mut RpcSocket, value: Value) -> Value {
    let id = value["id"].clone();
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
    loop {
        let response = rpc_next(socket).await;
        if response["id"] == id {
            return response;
        }
    }
}

async fn rpc_request_after_send(
    socket: &mut RpcSocket,
    value: Value,
    sent: oneshot::Sender<()>,
) -> Value {
    let id = value["id"].clone();
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
    let _ = sent.send(());
    loop {
        let response = rpc_next(socket).await;
        if response["id"] == id {
            return response;
        }
    }
}

async fn rpc_authenticate(socket: &mut RpcSocket) {
    let response = rpc_request(
        socket,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "rpc.authenticate",
            "params": {
                "clientName": "internal-tun-maintenance-simulator",
                "clientVersion": "1",
                "token": TEST_AUTH_TOKEN,
            },
        }),
    )
    .await;
    assert_eq!(response["result"]["authenticated"], true);
    let compatibility = rpc_request(
        socket,
        json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "bridge.getInfo",
            "params": {
                "clientProtocolVersion": mish_bridge::bridge_protocol::BRIDGE_PROTOCOL_VERSION
            }
        }),
    )
    .await;
    assert_eq!(compatibility["result"]["compatibility"], "compatible");
}

fn rpc_config(scenario: &MaintenanceScenarioRuntime) -> LoopbackServerConfig {
    rpc_config_with_occurrences(
        scenario,
        Arc::new(TunHelperRemovalOccurrenceStore::in_memory()),
    )
}

fn rpc_config_with_occurrences(
    scenario: &MaintenanceScenarioRuntime,
    occurrences: Arc<TunHelperRemovalOccurrenceStore>,
) -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec![RPC_ORIGIN.into()],
        auth_token: TEST_AUTH_TOKEN.into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        port_selection: LoopbackPortSelection::Fixed,
        browser_assets: None,
        browser_pairing_prompt: None,
        max_message_bytes: 1_048_576,
        // This bridge composition intentionally exercises the authenticated application
        // command boundary without a desktop-driver/Profile activation request. The runtime,
        // Capture, Helper, and package machines remain the production implementations.
        profile_activation: None,
        profile_file_actions: None,
        profile_service: Some(scenario.profile_service.clone()),
        process_icon_resolver: None,
        service_probes: None,
        settings_service: Some(scenario.settings_service.clone()),
        tun_helper_removal_occurrences: Some(occurrences),
        updater_service: None,
    }
}

fn notification<'a>(snapshot: &'a Value, kind: &str) -> &'a Value {
    snapshot["result"]["notifications"]
        .as_array()
        .expect("notification snapshot is an array")
        .iter()
        .find(|record| record["presentation"]["kind"] == kind)
        .expect("expected semantic notification")
}

fn capture_request(active: bool) -> CaptureRequest {
    CaptureRequest {
        active,
        selection: CaptureSelection {
            system_proxy: false,
            tun: true,
        },
    }
}

fn capture_handoff_request() -> CaptureRequest {
    CaptureRequest {
        active: false,
        selection: CaptureSelection {
            system_proxy: false,
            tun: false,
        },
    }
}

fn maintenance_scenario(
    initial: SyntheticMaintenanceInitial,
    target: SyntheticPackageVersion,
    faults: Vec<MaintenanceFault>,
) -> MaintenanceScenario {
    MaintenanceScenario {
        faults,
        initial,
        pause_at: None,
        pause_until: None,
        target,
    }
}

async fn build(
    initial: SyntheticMaintenanceInitial,
    target: SyntheticPackageVersion,
    faults: Vec<MaintenanceFault>,
) -> MaintenanceScenarioRuntime {
    MaintenanceScenarioRuntime::build(
        SimulatedHostScenario::internal_tun_maintenance(),
        maintenance_scenario(initial, target, faults),
    )
    .await
    .unwrap()
}

async fn build_on(
    host: SimulatedHostScenario,
    initial: SyntheticMaintenanceInitial,
    target: SyntheticPackageVersion,
    faults: Vec<MaintenanceFault>,
) -> MaintenanceScenarioRuntime {
    MaintenanceScenarioRuntime::build(host, maintenance_scenario(initial, target, faults))
        .await
        .unwrap()
}

async fn activate_then_handoff(scenario: &MaintenanceScenarioRuntime) {
    tokio::time::timeout(
        Duration::from_secs(2),
        scenario
            .runtime_host
            .current()
            .set_capture(capture_request(true), StatusAdapterKind::Rpc),
    )
    .await
    .expect("capture activation must settle")
    .unwrap();
    handoff_capture(scenario).await;
}

async fn handoff_capture(scenario: &MaintenanceScenarioRuntime) {
    tokio::time::timeout(
        Duration::from_secs(2),
        scenario
            .runtime_host
            .current()
            .set_capture(capture_handoff_request(), StatusAdapterKind::Rpc),
    )
    .await
    .expect("application capture handoff must settle")
    .unwrap();
}

async fn shutdown_with_profile_coordinator(scenario: &MaintenanceScenarioRuntime) {
    scenario
        .runtime_host
        .current()
        .shutdown(
            &CoreLifecycleOperation::new("simulated-profile", 100, "bridge-shutdown", 100, 100)
                .unwrap(),
        )
        .await
        .unwrap();
}

async fn repair(
    scenario: &MaintenanceScenarioRuntime,
) -> Result<mish_settings::SettingsSnapshot, SettingsServiceError> {
    tokio::time::timeout(
        Duration::from_secs(2),
        scenario.settings_service.repair_tun_helper(),
    )
    .await
    .expect("package lifecycle must settle")
}

async fn settle_until(mut predicate: impl FnMut() -> bool) {
    for _ in 0..512 {
        if predicate() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("simulated maintenance did not settle within the scheduler budget");
}

#[tokio::test]
async fn helper_removal_capability_is_authoritative_across_runtime_health_and_capture_states() {
    let capture_on = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V1,
        Vec::new(),
    )
    .await;
    assert!(capture_on.capture.status().capture_selection.tun);
    assert_eq!(
        capture_on.helper.refresh().await.removal,
        TunHelperRemovalCapability::Available
    );

    handoff_capture(&capture_on).await;
    assert!(!capture_on.capture.status().capture_selection.tun);
    assert_eq!(
        capture_on
            .settings_service
            .snapshot(SettingsAdapterKind::Rpc)
            .tun_helper
            .removal,
        TunHelperRemovalCapability::Available
    );

    let repair_required = build(
        SyntheticMaintenanceInitial::RepairRequired,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    assert_eq!(
        repair_required.helper.refresh().await.removal,
        TunHelperRemovalCapability::Available
    );

    let mut core_failed_host = SimulatedHostScenario::internal_tun_maintenance();
    core_failed_host.failures = vec![InjectedFailure {
        after_effect: None,
        effect: EffectKind::CoreObserve,
        kind: InjectedFailureKind::Observation,
        occurrence: 1,
    }];
    let core_failed = build_on(
        core_failed_host,
        SyntheticMaintenanceInitial::RepairRequired,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    let status = core_failed
        .runtime_host
        .current()
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(status.runtime.phase, RuntimePhase::Error);
    assert_eq!(
        core_failed.helper.refresh().await.removal,
        TunHelperRemovalCapability::Available
    );

    let mut listener_conflict_host = SimulatedHostScenario::internal_tun_maintenance();
    listener_conflict_host.initial_endpoint_owner = ManagedEndpointOwner::Foreign;
    let listener_conflict = build_on(
        listener_conflict_host,
        SyntheticMaintenanceInitial::RepairRequired,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    assert_eq!(
        listener_conflict.host.observation().endpoint_owner,
        ManagedEndpointOwner::Foreign
    );
    assert_eq!(
        listener_conflict.helper.refresh().await.removal,
        TunHelperRemovalCapability::Available
    );
    let removed = listener_conflict
        .settings_service
        .remove_tun_helper()
        .await
        .unwrap();
    assert_eq!(
        removed.tun_helper.removal,
        TunHelperRemovalCapability::NotInstalled
    );
    assert_eq!(
        listener_conflict.host.observation().endpoint_owner,
        ManagedEndpointOwner::Foreign
    );
}

#[tokio::test]
async fn healthy_v1_repair_uses_real_capture_helper_and_package_machines() {
    let scenario = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    let initial_capture = scenario.capture.status();
    assert!(initial_capture.tun_enabled);
    assert!(initial_capture.tun.desired);

    tokio::time::timeout(
        Duration::from_secs(2),
        scenario
            .runtime_host
            .current()
            .set_capture(capture_request(true), StatusAdapterKind::Rpc),
    )
    .await
    .expect("capture handoff must settle")
    .unwrap();
    let active = scenario.host.maintenance_observation().unwrap();
    assert_eq!(active.tun, SyntheticOwnership::Mish);
    assert_eq!(active.route, SyntheticOwnership::Mish);
    assert_eq!(active.dns, SyntheticOwnership::Mish);

    handoff_capture(&scenario).await;
    let before = scenario.host.maintenance_observation().unwrap();
    let snapshot = repair(&scenario).await.unwrap();
    assert_eq!(
        snapshot.tun_helper.health,
        mish_runtime::TunHelperHealth::Healthy
    );

    let after = scenario.host.maintenance_observation().unwrap();
    assert_eq!(before.installation_id, Some("1".repeat(64)));
    assert_eq!(after.installation_id, Some("2".repeat(64)));
    assert_ne!(after.artifacts, before.artifacts);
    assert_eq!(after.socket_generation, before.socket_generation + 1);
    assert_eq!(after.core_process, SyntheticOwnership::Mish);
    assert_eq!(after.tun, SyntheticOwnership::Absent);
    assert_eq!(after.route, SyntheticOwnership::Absent);
    assert_eq!(after.dns, SyntheticOwnership::Absent);
    let journal = scenario.maintenance.journal_snapshot().unwrap();
    let artifacts = after.artifacts.as_ref().unwrap();
    assert_eq!(artifacts.package_version, "0.1.0-internal-tun-alpha.7");
    assert_eq!(artifacts.application_sha256, "b".repeat(64));
    assert_eq!(artifacts.core_sha256, "c".repeat(64));
    assert_eq!(artifacts.helper_sha256, "d".repeat(64));
    assert_eq!(artifacts.manifest_sha256, "e".repeat(64));
    assert_eq!(artifacts.plist_sha256, "f".repeat(64));
    let admitted = journal.artifacts.new.as_ref().unwrap();
    assert_eq!(admitted.application_sha256, artifacts.application_sha256);
    assert_eq!(admitted.core_sha256, artifacts.core_sha256);
    assert_eq!(admitted.helper_sha256, artifacts.helper_sha256);
    assert_eq!(admitted.manifest_sha256, artifacts.manifest_sha256);
    assert_eq!(admitted.plist_sha256, artifacts.plist_sha256);
    assert_eq!(journal.intent.requested_manifest_sha256, "e".repeat(64));
    assert_eq!(
        journal.identity.old_generation,
        before.enrollment_generation
    );
    assert_eq!(journal.identity.new_generation, after.enrollment_generation);
    assert_eq!(
        journal.terminal.unwrap().outcome,
        MaintenanceTerminalOutcome::Committed
    );
    assert_eq!(journal.identity.old_installation_id, before.installation_id);
    assert_eq!(journal.identity.new_installation_id, after.installation_id);
    assert_eq!(journal.identity.old_key_id, before.key_id);
    assert_eq!(journal.identity.new_key_id, after.key_id);
    assert_eq!(
        after.key_id, before.key_id,
        "upgrade preserves the client key"
    );
    assert!(
        journal
            .capture
            .accepted_operation_id
            .starts_with("capture:")
    );
    assert_eq!(after.unrelated, before.unrelated);

    let scenario = scenario.restart().await.unwrap();
    let restored = scenario.host.maintenance_observation().unwrap();
    assert_eq!(restored.tun, SyntheticOwnership::Mish);
    assert_eq!(restored.route, SyntheticOwnership::Mish);
    assert_eq!(restored.dns, SyntheticOwnership::Mish);
}

#[tokio::test]
async fn maintenance_transcript_preserves_handoff_and_commit_order() {
    let scenario = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    handoff_capture(&scenario).await;
    repair(&scenario).await.unwrap();

    let events = scenario.host.observation().transcript.events;
    let first_maintenance = events
        .iter()
        .position(|event| event.effect_kind == EffectKind::MaintenanceJournalPersist)
        .expect("maintenance intent persistence must be recorded");
    let effects = events[first_maintenance..]
        .iter()
        .map(|event| event.effect_kind)
        .collect::<Vec<_>>();
    assert_eq!(
        effects,
        vec![
            EffectKind::MaintenanceJournalPersist,
            EffectKind::MaintenanceCaptureReconcile,
            EffectKind::MaintenanceJournalPersist,
            EffectKind::MaintenanceBackupArtifacts,
            EffectKind::MaintenanceAuthorize,
            EffectKind::MaintenanceCommitService,
            EffectKind::MaintenanceStageArtifacts,
            EffectKind::MaintenanceStageArtifacts,
            EffectKind::MaintenanceCommitEnrollment,
            EffectKind::MaintenanceCommitReceipt,
            EffectKind::MaintenanceCommitService,
            EffectKind::MaintenanceStartService,
            EffectKind::MaintenanceVerify,
            EffectKind::MaintenanceObserve,
        ]
    );
    assert_eq!(
        effects
            .iter()
            .filter(|effect| **effect == EffectKind::MaintenanceCaptureReconcile)
            .count(),
        1,
        "Capture handoff is one boundary invocation, not a journal cassette entry"
    );
    assert!(
        events
            .windows(2)
            .all(|window| { window[0].logical_time <= window[1].logical_time })
    );
}

#[tokio::test]
async fn foreign_core_or_dns_ownership_blocks_maintenance_without_claiming_success() {
    for (core, dns) in [
        (SyntheticOwnership::Unrelated, SyntheticOwnership::Absent),
        (SyntheticOwnership::Absent, SyntheticOwnership::Unrelated),
    ] {
        let scenario = build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V2,
            Vec::new(),
        )
        .await;
        handoff_capture(&scenario).await;
        scenario
            .maintenance
            .set_network_ownership(
                core,
                SyntheticOwnership::Absent,
                SyntheticOwnership::Absent,
                dns,
            )
            .unwrap();
        let before = scenario.host.maintenance_observation().unwrap();

        let error = repair(&scenario).await.unwrap_err();
        assert!(matches!(
            error,
            SettingsServiceError::TunHelper(TunHelperFailureKind::ObservationForeign)
        ));
        let helper = scenario.helper.refresh().await;
        assert_eq!(
            helper.last_failure,
            Some(TunHelperFailureKind::ObservationForeign)
        );
        assert_eq!(helper.removal, TunHelperRemovalCapability::Available);

        let after = scenario.host.maintenance_observation().unwrap();
        assert_eq!(after.core_process, before.core_process);
        assert_eq!(after.dns, before.dns);
        assert_eq!(after.tun, before.tun);
        assert_eq!(after.route, before.route);
        assert!(scenario.maintenance.journal_snapshot().is_none());
        assert!(
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .all(|event| event.effect_kind != EffectKind::MaintenanceAuthorize)
        );
    }
}

#[tokio::test]
async fn internal_tun_set_tun_fault_matrix_is_fail_closed_and_recoverable() {
    for failure in [
        TunHelperFailureKind::OperationFailed,
        TunHelperFailureKind::PermissionDenied,
    ] {
        let scenario = build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await;
        let before = scenario.host.maintenance_observation().unwrap();
        scenario
            .maintenance
            .fail_next_tun_mutation(failure)
            .unwrap();

        scenario
            .helper
            .set_tun_enabled(false)
            .await
            .expect_err("Internal TUN failure must settle");
        let after = scenario.host.maintenance_observation().unwrap();
        assert_eq!(after.tun, before.tun, "{failure:?} must not mutate TUN");
        assert_eq!(
            after.route, before.route,
            "{failure:?} must not mutate routes"
        );
        assert_eq!(after.dns, before.dns, "{failure:?} must not mutate DNS");
        assert_eq!(
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .rev()
                .find(|event| event.effect_kind == EffectKind::MaintenanceSetTun)
                .map(|event| event.result_kind),
            Some(EffectResultKind::FailedClosed)
        );

        scenario
            .helper
            .set_tun_enabled(false)
            .await
            .expect("one-shot Internal TUN failure must be recoverable");
        assert_eq!(
            scenario.host.maintenance_observation().unwrap().tun,
            SyntheticOwnership::Absent
        );
    }

    for ownership in [SyntheticOwnership::Partial, SyntheticOwnership::Unrelated] {
        let scenario = build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await;
        scenario
            .maintenance
            .set_network_ownership(
                SyntheticOwnership::Mish,
                SyntheticOwnership::Mish,
                ownership,
                SyntheticOwnership::Mish,
            )
            .unwrap();
        let before = scenario.host.maintenance_observation().unwrap();

        let rejected = scenario.helper.set_tun_enabled(false).await;
        assert!(
            rejected.is_err(),
            "{ownership:?} ownership must reject disable"
        );
        let after = scenario.host.maintenance_observation().unwrap();
        assert_eq!(
            after, before,
            "{ownership:?} must remain observable and unchanged"
        );

        scenario
            .maintenance
            .set_network_ownership(
                SyntheticOwnership::Mish,
                SyntheticOwnership::Mish,
                SyntheticOwnership::Mish,
                SyntheticOwnership::Mish,
            )
            .unwrap();
        scenario
            .helper
            .set_tun_enabled(false)
            .await
            .expect("clearing synthetic ownership must permit a fresh disable");
        let recovered = scenario.host.maintenance_observation().unwrap();
        assert_eq!(recovered.tun, SyntheticOwnership::Absent);
        assert_eq!(recovered.route, SyntheticOwnership::Absent);
        assert_eq!(recovered.dns, SyntheticOwnership::Absent);
    }

    let mut host = SimulatedHostScenario::internal_tun_maintenance();
    host.failures.push(InjectedFailure {
        after_effect: None,
        effect: EffectKind::MaintenanceSetTun,
        kind: InjectedFailureKind::Operation,
        occurrence: 2,
    });
    let scenario = build_on(
        host,
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V1,
        Vec::new(),
    )
    .await;
    scenario
        .helper
        .set_tun_enabled(false)
        .await
        .expect_err("the bounded second Internal TUN mutation must fail");
    assert_eq!(
        scenario
            .host
            .observation()
            .transcript
            .events
            .iter()
            .rev()
            .find(|event| event.effect_kind == EffectKind::MaintenanceSetTun)
            .map(|event| event.result_kind),
        Some(EffectResultKind::InjectedFailure)
    );
    scenario
        .helper
        .set_tun_enabled(false)
        .await
        .expect("the third occurrence is outside the bounded injected failure");
    assert_eq!(
        scenario.host.maintenance_observation().unwrap().tun,
        SyntheticOwnership::Absent
    );
}

#[tokio::test]
async fn rejected_package_operation_clears_active_operation_and_preserves_terminal_projection() {
    let scenario = build(
        SyntheticMaintenanceInitial::HealthyV2,
        SyntheticPackageVersion::V1,
        Vec::new(),
    )
    .await;

    assert!(repair(&scenario).await.is_err());
    let observation = scenario.host.maintenance_observation().unwrap();
    assert_eq!(observation.active_operation, None);
    assert!(!observation.recovery_required);
    assert_eq!(
        observation.package,
        SyntheticPackageProjection::HealthyDisabled
    );
    assert_eq!(
        scenario
            .maintenance
            .journal_snapshot()
            .unwrap()
            .terminal
            .unwrap()
            .outcome,
        MaintenanceTerminalOutcome::Rejected
    );
}

#[tokio::test]
async fn maintenance_fault_targets_one_bounded_commit_point_occurrence() {
    let scenario = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        vec![MaintenanceFault {
            at: MaintenanceCommitPoint::PriorServiceDetached,
            kind: MaintenanceFaultKind::PermissionDenied,
            occurrence: 2,
        }],
    )
    .await;
    handoff_capture(&scenario).await;

    repair(&scenario).await.unwrap();
    activate_then_handoff(&scenario).await;
    assert_eq!(
        scenario
            .maintenance
            .journal_snapshot()
            .unwrap()
            .terminal
            .unwrap()
            .outcome,
        MaintenanceTerminalOutcome::Committed
    );

    let rejected = scenario.settings_service.remove_tun_helper().await;
    assert!(matches!(
        rejected,
        Err(SettingsServiceError::TunHelper(
            TunHelperFailureKind::PermissionDenied
        ))
    ));
    assert_eq!(
        scenario
            .maintenance
            .journal_snapshot()
            .unwrap()
            .terminal
            .unwrap()
            .outcome,
        MaintenanceTerminalOutcome::RolledBack
    );

    let removed = scenario.settings_service.remove_tun_helper().await.unwrap();
    assert_eq!(
        removed.tun_helper.removal,
        TunHelperRemovalCapability::NotInstalled
    );
    let observation = scenario.host.maintenance_observation().unwrap();
    assert!(observation.installation_id.is_none());
    assert_eq!(observation.core_process, SyntheticOwnership::Absent);
    assert_eq!(observation.dns, SyntheticOwnership::Absent);
}

#[tokio::test]
async fn reinstall_repair_upgrade_downgrade_rotation_reset_and_uninstall_are_typed() {
    let identical = build(
        SyntheticMaintenanceInitial::HealthyV2,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    let identical_before = identical.host.maintenance_observation().unwrap();
    let installed = tokio::time::timeout(
        Duration::from_secs(2),
        identical.settings_service.install_tun_helper(),
    )
    .await
    .expect("identical install must settle")
    .unwrap();
    assert_eq!(
        installed.tun_helper.health,
        mish_runtime::TunHelperHealth::Healthy
    );
    let identical_after = identical.host.maintenance_observation().unwrap();
    assert_eq!(
        identical_after.installation_id,
        identical_before.installation_id
    );
    assert_eq!(identical_after.key_id, identical_before.key_id);
    assert_eq!(
        identical
            .maintenance
            .journal_snapshot()
            .unwrap()
            .terminal
            .unwrap()
            .outcome,
        MaintenanceTerminalOutcome::Identical
    );

    let repaired = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V1,
        Vec::new(),
    )
    .await;
    activate_then_handoff(&repaired).await;
    let repair_before = repaired.host.maintenance_observation().unwrap();
    repair(&repaired).await.unwrap();
    let repair_after = repaired.host.maintenance_observation().unwrap();
    let repair_journal = repaired.maintenance.journal_snapshot().unwrap();
    assert_eq!(repair_journal.intent.kind, MaintenanceKind::Repair);
    assert_eq!(repair_after.installation_id, repair_before.installation_id);
    assert_eq!(repair_after.key_id, repair_before.key_id);

    let downgrade = build(
        SyntheticMaintenanceInitial::HealthyV2,
        SyntheticPackageVersion::V1,
        Vec::new(),
    )
    .await;
    let error = repair(&downgrade).await.unwrap_err();
    assert!(matches!(
        error,
        SettingsServiceError::TunHelper(TunHelperFailureKind::VersionMismatch)
    ));
    assert_eq!(
        downgrade
            .maintenance
            .journal_snapshot()
            .unwrap()
            .terminal
            .unwrap()
            .outcome,
        MaintenanceTerminalOutcome::Rejected
    );

    let keys = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    let before_rotation = keys.host.maintenance_observation().unwrap();
    keys.maintenance.rotate_key_with_dual_proof().unwrap();
    let rotated = keys.host.maintenance_observation().unwrap();
    assert_ne!(rotated.key_id, before_rotation.key_id);
    assert_eq!(
        rotated.enrollment_generation,
        before_rotation
            .enrollment_generation
            .map(|generation| generation + 1)
    );
    handoff_capture(&keys).await;
    repair(&keys).await.unwrap();
    let upgraded_after_rotation = keys.host.maintenance_observation().unwrap();
    assert_eq!(
        upgraded_after_rotation.installation_id,
        Some("2".repeat(64))
    );
    assert_eq!(upgraded_after_rotation.key_id, rotated.key_id);
    assert!(keys.maintenance.reset_lost_key(false).is_err());
    let before_reset = keys.host.maintenance_observation().unwrap();
    keys.maintenance.reset_lost_key(true).unwrap();
    let reset = keys.host.maintenance_observation().unwrap();
    assert_ne!(reset.key_id, before_reset.key_id);
    assert_eq!(
        reset.enrollment_generation,
        before_reset
            .enrollment_generation
            .map(|generation| generation + 1)
    );
    keys.maintenance.rotate_key_with_dual_proof().unwrap();
    let rotated_after_reset = keys.host.maintenance_observation().unwrap();
    assert_ne!(rotated_after_reset.key_id, reset.key_id);

    let uninstall = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V1,
        Vec::new(),
    )
    .await;
    activate_then_handoff(&uninstall).await;
    let unrelated = uninstall.host.maintenance_observation().unwrap().unrelated;
    let removed = tokio::time::timeout(
        Duration::from_secs(2),
        uninstall.settings_service.remove_tun_helper(),
    )
    .await
    .expect("uninstall must settle")
    .unwrap();
    assert_eq!(
        removed.tun_helper.health,
        mish_runtime::TunHelperHealth::NotInstalled
    );
    let absent = uninstall.host.maintenance_observation().unwrap();
    assert_eq!(absent.filesystem, SyntheticOwnership::Absent);
    assert_eq!(absent.service, SyntheticOwnership::Absent);
    assert_eq!(absent.helper_process, SyntheticOwnership::Absent);
    assert_eq!(absent.socket, SyntheticOwnership::Absent);
    assert_eq!(absent.core_process, SyntheticOwnership::Absent);
    assert_eq!(absent.tun, SyntheticOwnership::Absent);
    assert_eq!(absent.route, SyntheticOwnership::Absent);
    assert_eq!(absent.dns, SyntheticOwnership::Absent);
    assert_eq!(absent.unrelated, unrelated);
    let journal = uninstall.maintenance.journal_snapshot().unwrap();
    assert_eq!(journal.intent.kind, MaintenanceKind::Uninstall);
    assert_eq!(
        journal.identity.enrollment_transition,
        EnrollmentTransition::Removed
    );
    assert_eq!(
        journal.terminal.unwrap().outcome,
        MaintenanceTerminalOutcome::Uninstalled
    );
}

#[tokio::test]
async fn post_enrollment_rollback_restores_credentials_for_followup_maintenance() {
    let scenario = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        vec![MaintenanceFault {
            at: MaintenanceCommitPoint::ReceiptCommitted,
            kind: MaintenanceFaultKind::DiskFull,
            occurrence: 1,
        }],
    )
    .await;
    handoff_capture(&scenario).await;
    assert!(repair(&scenario).await.is_err());
    let rolled_back = scenario.host.maintenance_observation().unwrap();
    assert_eq!(rolled_back.installation_id, Some("1".repeat(64)));
    assert_eq!(
        scenario
            .maintenance
            .journal_snapshot()
            .unwrap()
            .terminal
            .unwrap()
            .outcome,
        MaintenanceTerminalOutcome::RolledBack
    );

    scenario
        .maintenance
        .configure(SyntheticPackageVersion::V2, Vec::new())
        .unwrap();
    scenario.maintenance.rotate_key_with_dual_proof().unwrap();
    repair(&scenario).await.unwrap();
    let recovered = scenario.host.maintenance_observation().unwrap();
    assert_eq!(recovered.installation_id, Some("2".repeat(64)));
}

#[tokio::test]
async fn runner_injections_retire_stale_and_deduplicate_equal_stage_completions() {
    for (injection, expected) in [
        (
            MaintenanceCompletionInjection::StaleStage,
            Disposition::Retired,
        ),
        (
            MaintenanceCompletionInjection::EqualStage,
            Disposition::EffectEmitting,
        ),
    ] {
        let scenario = build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V2,
            Vec::new(),
        )
        .await;
        handoff_capture(&scenario).await;
        scenario
            .maintenance
            .pause_at(MaintenanceCommitPoint::IntentPersisted, 1)
            .unwrap();
        let settings = scenario.settings_service.clone();
        let operation = tokio::spawn(async move { settings.repair_tun_helper().await });
        settle_until(|| scenario.maintenance.journal_snapshot().is_some()).await;

        let admitted = tokio::time::timeout(
            Duration::from_secs(2),
            scenario.maintenance.inject_stage_completion(injection),
        )
        .await
        .expect("injected completion must be admitted")
        .unwrap();
        assert_eq!(admitted, expected, "{injection:?}");

        scenario.host.advance_to(1).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), operation)
                .await
                .expect("maintenance must settle after injected completion")
                .unwrap()
                .is_ok(),
            "{injection:?} must not alter the terminal maintenance result"
        );
        assert_eq!(
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .filter(|event| event.effect_kind == EffectKind::MaintenanceAuthorize)
                .count(),
            1,
            "{injection:?} must not start a second authorization effect"
        );
    }
}

#[tokio::test]
async fn restart_observes_only_exact_authority_before_complete_compensate_or_recovery_required() {
    let complete = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        vec![MaintenanceFault {
            at: MaintenanceCommitPoint::ServiceStarted,
            kind: MaintenanceFaultKind::CoreExited,
            occurrence: 1,
        }],
    )
    .await;
    activate_then_handoff(&complete).await;
    assert!(repair(&complete).await.is_err());
    let incomplete = complete.maintenance.journal_snapshot().unwrap();
    assert!(incomplete.terminal.is_none());
    assert!(
        complete
            .host
            .maintenance_observation()
            .unwrap()
            .recovery_required
    );
    let complete = complete.restart().await.unwrap();
    let completed = complete.maintenance.journal_snapshot().unwrap();
    assert_eq!(
        completed.terminal.unwrap().outcome,
        MaintenanceTerminalOutcome::Committed
    );
    let recovered = complete.host.maintenance_observation().unwrap();
    assert!(!recovered.recovery_required);
    assert_eq!(recovered.tun, SyntheticOwnership::Mish);

    let compensate = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    activate_then_handoff(&compensate).await;
    compensate
        .maintenance
        .pause_at(MaintenanceCommitPoint::IntentPersisted, 1)
        .unwrap();
    let settings = compensate.settings_service.clone();
    let operation = tokio::spawn(async move { settings.repair_tun_helper().await });
    settle_until(|| compensate.maintenance.journal_snapshot().is_some()).await;
    compensate.maintenance.abort_active().await;
    assert!(operation.await.unwrap().is_err());
    let compensate = compensate.restart().await.unwrap();
    let compensated = compensate.maintenance.journal_snapshot().unwrap();
    assert_eq!(
        compensated.terminal.unwrap().outcome,
        MaintenanceTerminalOutcome::RolledBack
    );
    let restored = compensate.host.maintenance_observation().unwrap();
    assert_eq!(
        restored
            .artifacts
            .as_ref()
            .map(|artifacts| artifacts.package_version.as_str()),
        Some("0.1.0-internal-tun-alpha.5")
    );
    assert_eq!(restored.tun, SyntheticOwnership::Mish);

    let recovery_required = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        vec![MaintenanceFault {
            at: MaintenanceCommitPoint::ServiceStarted,
            kind: MaintenanceFaultKind::ReplacedArtifact,
            occurrence: 1,
        }],
    )
    .await;
    activate_then_handoff(&recovery_required).await;
    assert!(repair(&recovery_required).await.is_err());
    let recovery_required = recovery_required.restart().await.unwrap();
    let journal = recovery_required.maintenance.journal_snapshot().unwrap();
    assert_eq!(
        journal.terminal.unwrap().outcome,
        MaintenanceTerminalOutcome::BoundedDisabled
    );
    let bounded = recovery_required.host.maintenance_observation().unwrap();
    assert!(bounded.recovery_required);
    assert_eq!(bounded.service, SyntheticOwnership::Absent);
    assert_eq!(bounded.tun, SyntheticOwnership::Absent);
    assert_eq!(bounded.route, SyntheticOwnership::Absent);
    assert_eq!(bounded.dns, SyntheticOwnership::Absent);
}

#[tokio::test]
async fn every_commit_boundary_and_fault_family_stays_bounded_and_preserves_unrelated_state() {
    let boundaries = [
        MaintenanceCommitPoint::IntentPersisted,
        MaintenanceCommitPoint::CaptureReconciled,
        MaintenanceCommitPoint::PriorArtifactsBackedUp,
        MaintenanceCommitPoint::PriorServiceDetached,
        MaintenanceCommitPoint::HelperReplaced,
        MaintenanceCommitPoint::CoreReplaced,
        MaintenanceCommitPoint::EnrollmentCommitted,
        MaintenanceCommitPoint::ReceiptCommitted,
        MaintenanceCommitPoint::LaunchDaemonCommitted,
        MaintenanceCommitPoint::ServiceStarted,
        MaintenanceCommitPoint::Verified,
    ];
    for boundary in boundaries {
        let scenario = build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V2,
            vec![MaintenanceFault {
                at: boundary,
                kind: MaintenanceFaultKind::DiskFull,
                occurrence: 1,
            }],
        )
        .await;
        activate_then_handoff(&scenario).await;
        let before = scenario.host.maintenance_observation().unwrap();
        assert!(repair(&scenario).await.is_err(), "{boundary:?}");
        let after = scenario.host.maintenance_observation().unwrap();
        assert_eq!(after.unrelated, before.unrelated, "{boundary:?}");
        assert_eq!(
            scenario
                .maintenance
                .journal_snapshot()
                .unwrap()
                .terminal
                .unwrap()
                .outcome,
            MaintenanceTerminalOutcome::RolledBack,
            "{boundary:?}"
        );
        assert_eq!(
            after
                .artifacts
                .as_ref()
                .map(|artifacts| artifacts.package_version.as_str()),
            Some("0.1.0-internal-tun-alpha.5"),
            "{boundary:?}"
        );
    }

    let cases = [
        (
            MaintenanceFaultKind::AdministratorCancelled,
            MaintenanceCommitPoint::PriorServiceDetached,
            Some(MaintenanceTerminalOutcome::RolledBack),
        ),
        (
            MaintenanceFaultKind::PermissionDenied,
            MaintenanceCommitPoint::HelperReplaced,
            Some(MaintenanceTerminalOutcome::RolledBack),
        ),
        (
            MaintenanceFaultKind::InterruptedCopy,
            MaintenanceCommitPoint::CoreReplaced,
            Some(MaintenanceTerminalOutcome::RolledBack),
        ),
        (
            MaintenanceFaultKind::CleanupFailure,
            MaintenanceCommitPoint::ServiceStarted,
            Some(MaintenanceTerminalOutcome::BoundedDisabled),
        ),
        (
            MaintenanceFaultKind::CoreExited,
            MaintenanceCommitPoint::ServiceStarted,
            None,
        ),
        (
            MaintenanceFaultKind::ProcessTerminated,
            MaintenanceCommitPoint::ReceiptCommitted,
            None,
        ),
        (
            MaintenanceFaultKind::CorruptArtifact,
            MaintenanceCommitPoint::ServiceStarted,
            None,
        ),
        (
            MaintenanceFaultKind::ReplacedArtifact,
            MaintenanceCommitPoint::ServiceStarted,
            None,
        ),
        (
            MaintenanceFaultKind::StaleCompletion,
            MaintenanceCommitPoint::ReceiptCommitted,
            None,
        ),
    ];
    for (kind, boundary, terminal) in cases {
        let scenario = build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V2,
            vec![MaintenanceFault {
                at: boundary,
                kind,
                occurrence: 1,
            }],
        )
        .await;
        activate_then_handoff(&scenario).await;
        let unrelated = scenario.host.maintenance_observation().unwrap().unrelated;
        assert!(repair(&scenario).await.is_err(), "{kind:?} at {boundary:?}");
        let after = scenario.host.maintenance_observation().unwrap();
        assert_eq!(after.unrelated, unrelated, "{kind:?}");
        assert_eq!(
            scenario
                .maintenance
                .journal_snapshot()
                .unwrap()
                .terminal
                .as_ref()
                .map(|value| value.outcome),
            terminal,
            "{kind:?}"
        );
    }

    let panic = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        vec![MaintenanceFault {
            at: MaintenanceCommitPoint::CaptureReconciled,
            kind: MaintenanceFaultKind::Panic,
            occurrence: 1,
        }],
    )
    .await;
    activate_then_handoff(&panic).await;
    assert!(repair(&panic).await.is_err());
    assert!(
        panic
            .maintenance
            .journal_snapshot()
            .unwrap()
            .terminal
            .is_none()
    );
}

#[tokio::test]
async fn authenticated_rpc_projects_maintenance_pending_finalizing_and_serializes_duplicates() {
    let operation_id = "43500000-0000-4000-8000-000000000001";
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V2,
            Vec::new(),
        )
        .await,
    );
    scenario
        .maintenance
        .pause_at(MaintenanceCommitPoint::IntentPersisted, 1)
        .unwrap();
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config(&scenario),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut notifications = rpc_socket(bridge.address).await;
    let mut commander = rpc_socket(bridge.address).await;
    let mut duplicate = rpc_socket(bridge.address).await;
    for socket in [&mut notifications, &mut commander, &mut duplicate] {
        rpc_authenticate(socket).await;
    }
    let subscribed = rpc_request(
        &mut notifications,
        json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"notifications.subscribe",
            "params":{
                "clientId":"internal-tun-maintenance-notifications",
                "sessionId":"internal-tun-maintenance-session-1"
            }
        }),
    )
    .await;
    assert!(subscribed["result"]["subscriptionId"].is_string());
    let capture = rpc_request(
        &mut commander,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"status.setCapture",
            "params":{"active":true, "selection":{"systemProxy":false, "tun":true}},
        }),
    )
    .await;
    assert_eq!(
        capture["result"]["runtime"]["tun"]["phase"], "applied",
        "capture response: {capture}"
    );

    let repair = tokio::spawn(async move {
        rpc_request(
            &mut commander,
            json!({
                "jsonrpc":"2.0", "id":4, "method":"settings.repairTunHelper",
                "params":{"operationId": operation_id}
            }),
        )
        .await
    });
    settle_until(|| scenario.maintenance.journal_snapshot().is_some()).await;
    let settings_during_lifecycle = rpc_request(
        &mut duplicate,
        json!({"jsonrpc":"2.0", "id":40, "method":"settings.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(
        settings_during_lifecycle["result"]["tunHelper"]["removal"],
        "maintenance-pending"
    );
    assert_eq!(
        settings_during_lifecycle["result"]["tunHelperOperation"]["operationId"],
        operation_id
    );
    assert_eq!(
        settings_during_lifecycle["result"]["tunHelperOperation"]["phase"],
        "finalizing"
    );
    let during_lifecycle = scenario.capture.status();
    assert!(
        during_lifecycle.capture_selection.tun && during_lifecycle.tun_enabled,
        "the Helper lifecycle must not pre-apply or discard the prior Capture intent"
    );

    let mut outcomes = Vec::new();
    let mut finalizing_pinned = false;
    for _ in 0..8 {
        let update = rpc_next(&mut notifications).await;
        if update["method"] != "notifications.snapshot" {
            continue;
        }
        let Some(record) = update["params"]["snapshot"]["notifications"]
            .as_array()
            .and_then(|records| {
                records
                    .iter()
                    .find(|record| record["presentation"]["kind"] == "tun-helper.lifecycle")
            })
        else {
            continue;
        };
        let outcome = record["presentation"]["data"]["outcome"]
            .as_str()
            .expect("bounded lifecycle outcome")
            .to_owned();
        if outcome == "finalizing" {
            finalizing_pinned = record["pinned"] == true;
        }
        outcomes.push(outcome.clone());
        if outcome == "finalizing" {
            break;
        }
    }
    assert!(outcomes.iter().any(|outcome| outcome == "pending"));
    assert!(outcomes.iter().any(|outcome| outcome == "finalizing"));
    assert!(finalizing_pinned);

    let (sent, sent_rx) = oneshot::channel();
    let duplicate = tokio::spawn(async move {
        rpc_request_after_send(
            &mut duplicate,
            json!({
                "jsonrpc":"2.0", "id":5, "method":"settings.repairTunHelper",
                "params":{"operationId": operation_id}
            }),
            sent,
        )
        .await
    });
    sent_rx.await.unwrap();
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    assert!(
        !duplicate.is_finished(),
        "the duplicate authenticated command must wait behind the live lifecycle"
    );
    assert_eq!(
        scenario
            .host
            .observation()
            .transcript
            .events
            .iter()
            .filter(|event| event.effect_kind == EffectKind::MaintenanceJournalPersist)
            .count(),
        1,
        "the duplicate cannot begin a competing maintenance journal"
    );

    scenario.host.advance_to(1).unwrap();
    let repaired = tokio::time::timeout(Duration::from_secs(2), repair)
        .await
        .expect("first repair must settle")
        .unwrap();
    assert!(repaired["result"].is_object());
    let after_first_repair = scenario.capture.status();
    assert!(
        !after_first_repair.capture_selection.tun && !after_first_repair.tun_enabled,
        "a successful maintenance lifecycle must hand off through Capture before reporting success"
    );
    let duplicate = tokio::time::timeout(Duration::from_secs(2), duplicate)
        .await
        .expect("serialized identical repair must settle")
        .unwrap();
    assert!(duplicate["result"].is_object());
    assert_eq!(
        duplicate["result"]["tunHelperOperation"]["operationId"],
        operation_id
    );
    assert_eq!(
        duplicate["result"]["tunHelperOperation"]["phase"],
        "terminal"
    );
    let transcript = scenario.host.observation().transcript;
    assert_eq!(
        transcript
            .events
            .iter()
            .filter(|event| event.effect_kind == EffectKind::MaintenanceAuthorize)
            .count(),
        1,
        "the same admitted operation may authorize only once"
    );
    assert!(
        transcript
            .events
            .iter()
            .filter(|event| event.effect_kind == EffectKind::MaintenanceAuthorize)
            .all(|event| Some(event.admitted_revision)
                == repaired["result"]["tunHelperOperation"]["admittedRevision"].as_u64()),
        "the platform transcript and Settings terminal must share the admitted revision"
    );

    let terminal = rpc_request(
        &mut notifications,
        json!({"jsonrpc":"2.0", "id":6, "method":"notifications.getSnapshot", "params":{}}),
    )
    .await;
    let lifecycles = terminal["result"]["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|record| record["presentation"]["kind"] == "tun-helper.lifecycle")
        .collect::<Vec<_>>();
    assert_eq!(
        lifecycles.len(),
        1,
        "one admitted operation has one notification"
    );
    assert!(lifecycles.iter().all(|record| record["pinned"] == false));
    assert!(
        lifecycles
            .iter()
            .all(|record| { record["presentation"]["data"]["outcome"] == "applied" })
    );

    shutdown_with_profile_coordinator(&scenario).await;
    drop(notifications);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn authenticated_active_tun_removal_hands_off_capture_before_authorization() {
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await,
    );
    assert!(scenario.capture.status().tun_enabled);
    let unrelated = scenario.host.maintenance_observation().unwrap().unrelated;
    let occurrences = Arc::new(TunHelperRemovalOccurrenceStore::in_memory());
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config_with_occurrences(&scenario, occurrences.clone()),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut socket = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut socket).await;

    let removed = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":2, "method":"settings.removeTunHelper", "params":{}}),
    )
    .await;
    assert_eq!(removed["result"]["tunHelper"]["removal"], "not-installed");
    assert!(!scenario.capture.status().tun_enabled);
    let after = scenario.host.maintenance_observation().unwrap();
    for owner in [
        after.core_process,
        after.dns,
        after.filesystem,
        after.helper_process,
        after.route,
        after.service,
        after.socket,
        after.tun,
    ] {
        assert_eq!(owner, SyntheticOwnership::Absent);
    }
    assert_eq!(after.unrelated, unrelated);

    let transcript = &scenario.host.observation().transcript.events;
    let capture_handoff = transcript
        .iter()
        .position(|event| event.effect_kind == EffectKind::MaintenanceCaptureReconcile)
        .expect("Capture reconciliation must be recorded");
    let authorization = transcript
        .iter()
        .position(|event| event.effect_kind == EffectKind::MaintenanceAuthorize)
        .expect("administrator authorization must be recorded");
    assert!(capture_handoff < authorization);

    let notifications = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":3, "method":"notifications.getSnapshot", "params":{}}),
    )
    .await;
    let lifecycle = notification(&notifications, "tun-helper.lifecycle");
    assert_eq!(lifecycle["presentation"]["data"]["outcome"], "removed");
    assert_eq!(lifecycle["severity"], "success");
    assert_eq!(lifecycle["pinned"], false);

    let retained = occurrences.records();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].admitted_revision, 1);
    assert!(retained.iter().all(|record| {
        record.outcome == mish_runtime::TunHelperRemovalOutcome::Removed
            && record.cleanup == TunHelperRemovalCleanupOutcome::ConfirmedAbsent
    }));

    shutdown_with_profile_coordinator(&scenario).await;
    drop(socket);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn removal_evidence_write_failure_keeps_the_terminal_notification_truthful() {
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await,
    );
    scenario
        .maintenance
        .pause_at(MaintenanceCommitPoint::IntentPersisted, 1)
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let occurrences = Arc::new(
        TunHelperRemovalOccurrenceStore::open_private_file(
            root.path().join("internal-tun-removal-occurrences.json"),
        )
        .unwrap(),
    );
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config_with_occurrences(&scenario, occurrences.clone()),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut commander = rpc_socket(bridge.address).await;
    let mut observer = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut commander).await;
    rpc_authenticate(&mut observer).await;

    let removal = tokio::spawn(async move {
        rpc_request(
            &mut commander,
            json!({"jsonrpc":"2.0", "id":2, "method":"settings.removeTunHelper", "params":{}}),
        )
        .await
    });
    settle_until(|| scenario.maintenance.journal_snapshot().is_some()).await;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
    scenario.host.advance_to(1).unwrap();

    let rejected = tokio::time::timeout(Duration::from_secs(2), removal)
        .await
        .expect("removal must settle after the evidence write fails")
        .unwrap();
    assert_eq!(rejected["error"]["code"], -32057);
    assert_eq!(
        rejected["error"]["data"]["kind"],
        "removal-evidence-unavailable"
    );
    assert_eq!(
        scenario
            .settings_service
            .snapshot(SettingsAdapterKind::Rpc)
            .tun_helper
            .removal,
        TunHelperRemovalCapability::NotInstalled
    );
    let pending_terminal = occurrences.records();
    assert_eq!(pending_terminal.len(), 1);
    assert_eq!(
        pending_terminal[0].outcome,
        mish_runtime::TunHelperRemovalOutcome::Removed
    );

    let notifications = rpc_request(
        &mut observer,
        json!({"jsonrpc":"2.0", "id":3, "method":"notifications.getSnapshot", "params":{}}),
    )
    .await;
    let lifecycle = notification(&notifications, "tun-helper.lifecycle");
    assert_eq!(lifecycle["presentation"]["data"]["outcome"], "removed");
    assert_eq!(lifecycle["pinned"], false);

    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let retry = rpc_request(
        &mut observer,
        json!({"jsonrpc":"2.0", "id":4, "method":"settings.removeTunHelper", "params":{}}),
    )
    .await;
    assert_eq!(retry["error"]["code"], -32055);
    let persisted = occurrences.records();
    assert_eq!(persisted.len(), 2);
    assert_eq!(persisted[0], pending_terminal[0]);
    assert_eq!(persisted[1].admitted_revision, 2);
    assert_eq!(
        persisted[1].failure,
        Some(TunHelperRemovalOccurrenceFailure::InstallationUnconfirmed)
    );

    shutdown_with_profile_coordinator(&scenario).await;
    drop(observer);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn unavailable_removal_evidence_disables_only_removal_admission() {
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await,
    );
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config_with_occurrences(
            &scenario,
            Arc::new(TunHelperRemovalOccurrenceStore::unavailable()),
        ),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut socket = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut socket).await;

    let snapshot = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":2, "method":"settings.getSnapshot", "params":{}}),
    )
    .await;
    assert!(snapshot["result"].is_object());
    let rejected = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":3, "method":"settings.removeTunHelper", "params":{}}),
    )
    .await;
    assert_eq!(rejected["error"]["code"], -32057);
    assert_eq!(
        rejected["error"]["data"]["kind"],
        "removal-evidence-unavailable"
    );

    shutdown_with_profile_coordinator(&scenario).await;
    drop(socket);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn incomplete_cleanup_observation_blocks_removal_before_maintenance() {
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await,
    );
    handoff_capture(&scenario).await;
    scenario
        .maintenance
        .set_network_ownership(
            SyntheticOwnership::Absent,
            SyntheticOwnership::Absent,
            SyntheticOwnership::Partial,
            SyntheticOwnership::Absent,
        )
        .unwrap();
    let before = scenario.host.maintenance_observation().unwrap();
    let occurrences = Arc::new(TunHelperRemovalOccurrenceStore::in_memory());
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config_with_occurrences(&scenario, occurrences.clone()),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut socket = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut socket).await;

    let rejected = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":2, "method":"settings.removeTunHelper", "params":{}}),
    )
    .await;
    assert_eq!(
        rejected["error"]["data"]["outcome"],
        "observation-incomplete"
    );
    assert_eq!(rejected["error"]["data"]["kind"], "observation-partial");
    assert!(scenario.maintenance.journal_snapshot().is_none());
    let retained = occurrences.records();
    assert_eq!(retained.len(), 1);
    assert_eq!(
        retained[0].failure,
        Some(TunHelperRemovalOccurrenceFailure::Helper(
            TunHelperFailureKind::ObservationPartial
        ))
    );
    assert_eq!(
        retained[0].observation,
        TunHelperRemovalObservationOutcome::Incomplete
    );
    let after = scenario.host.maintenance_observation().unwrap();
    assert_eq!(after.installation_id, before.installation_id);
    assert_eq!(after.route, SyntheticOwnership::Partial);
    assert_eq!(after.unrelated, before.unrelated);
    assert!(
        scenario
            .host
            .observation()
            .transcript
            .events
            .iter()
            .all(|event| event.effect_kind != EffectKind::MaintenanceAuthorize)
    );

    let notifications = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":3, "method":"notifications.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(
        notification(&notifications, "tun-helper.lifecycle")["presentation"]["data"]["outcome"],
        "observation-incomplete"
    );

    drop(socket);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Failed { .. }
    ));
}

#[tokio::test]
async fn foreign_cleanup_observation_is_retained_without_mutating_owned_state() {
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await,
    );
    handoff_capture(&scenario).await;
    scenario
        .maintenance
        .set_network_ownership(
            SyntheticOwnership::Absent,
            SyntheticOwnership::Absent,
            SyntheticOwnership::Unrelated,
            SyntheticOwnership::Absent,
        )
        .unwrap();
    let before = scenario.host.maintenance_observation().unwrap();
    let occurrences = Arc::new(TunHelperRemovalOccurrenceStore::in_memory());
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config_with_occurrences(&scenario, occurrences.clone()),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut socket = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut socket).await;

    let rejected = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":2, "method":"settings.removeTunHelper", "params":{}}),
    )
    .await;
    assert_eq!(
        rejected["error"]["data"]["outcome"],
        "observation-incomplete"
    );
    assert_eq!(rejected["error"]["data"]["kind"], "observation-foreign");
    assert!(scenario.maintenance.journal_snapshot().is_none());
    let retained = occurrences.records();
    assert_eq!(retained.len(), 1);
    assert_eq!(
        retained[0].failure,
        Some(TunHelperRemovalOccurrenceFailure::Helper(
            TunHelperFailureKind::ObservationForeign
        ))
    );
    assert_eq!(
        retained[0].observation,
        TunHelperRemovalObservationOutcome::Foreign
    );
    let after = scenario.host.maintenance_observation().unwrap();
    assert_eq!(after.installation_id, before.installation_id);
    assert_eq!(after.route, SyntheticOwnership::Unrelated);
    assert_eq!(after.unrelated, before.unrelated);

    drop(socket);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Failed { .. }
    ));
}

#[tokio::test]
async fn removal_failures_publish_distinct_outcomes_and_cancellation_can_retry() {
    let cases = [
        (
            MaintenanceFaultKind::AdministratorCancelled,
            MaintenanceCommitPoint::PriorServiceDetached,
            "authorization-cancelled",
            true,
        ),
        (
            MaintenanceFaultKind::PermissionDenied,
            MaintenanceCommitPoint::PriorServiceDetached,
            "authorization-failed",
            false,
        ),
        (
            MaintenanceFaultKind::CleanupFailure,
            MaintenanceCommitPoint::ServiceStarted,
            "removal-failed",
            false,
        ),
    ];
    for (kind, at, expected_outcome, retries) in cases {
        let scenario = Arc::new(
            build(
                SyntheticMaintenanceInitial::HealthyV1,
                SyntheticPackageVersion::V1,
                vec![MaintenanceFault {
                    at,
                    kind,
                    occurrence: 1,
                }],
            )
            .await,
        );
        let unrelated = scenario.host.maintenance_observation().unwrap().unrelated;
        let occurrences = Arc::new(TunHelperRemovalOccurrenceStore::in_memory());
        let bridge = start_loopback_server_with_runtime_host(
            rpc_config_with_occurrences(&scenario, occurrences.clone()),
            scenario.runtime_host.clone(),
        )
        .await
        .unwrap();
        let mut socket = rpc_socket(bridge.address).await;
        rpc_authenticate(&mut socket).await;

        let rejected = rpc_request(
            &mut socket,
            json!({"jsonrpc":"2.0", "id":2, "method":"settings.removeTunHelper", "params":{}}),
        )
        .await;
        assert_eq!(
            rejected["error"]["data"]["outcome"], expected_outcome,
            "{kind:?}"
        );
        let after = scenario.host.maintenance_observation().unwrap();
        assert_eq!(after.unrelated, unrelated, "{kind:?}");
        assert!(after.installation_id.is_some(), "{kind:?}");
        let retained_failure = occurrences.records();
        assert_eq!(retained_failure.len(), 1, "{kind:?}");
        assert_eq!(retained_failure[0].admitted_revision, 1, "{kind:?}");
        assert_eq!(
            retained_failure[0].lifecycle_phase,
            TunHelperRemovalLifecyclePhase::PrivilegedMaintenance,
            "{kind:?}"
        );
        assert_eq!(
            retained_failure[0].observation,
            TunHelperRemovalObservationOutcome::ConfirmedSafe,
            "{kind:?}"
        );
        assert_eq!(
            retained_failure[0].cleanup,
            if expected_outcome == "removal-failed" {
                TunHelperRemovalCleanupOutcome::Incomplete
            } else {
                TunHelperRemovalCleanupOutcome::NotRequired
            },
            "{kind:?}"
        );
        assert!(
            matches!(
                retained_failure[0].failure,
                Some(TunHelperRemovalOccurrenceFailure::Helper(_))
            ),
            "{kind:?}"
        );

        let notifications = rpc_request(
            &mut socket,
            json!({"jsonrpc":"2.0", "id":3, "method":"notifications.getSnapshot", "params":{}}),
        )
        .await;
        assert!(
            notifications["result"]["notifications"]
                .as_array()
                .unwrap()
                .iter()
                .any(|record| {
                    record["presentation"]["kind"] == "tun-helper.lifecycle"
                        && record["presentation"]["data"]["outcome"] == expected_outcome
                }),
            "{kind:?}"
        );

        if retries {
            scenario
                .maintenance
                .configure(SyntheticPackageVersion::V1, Vec::new())
                .unwrap();
            let retried = rpc_request(
                &mut socket,
                json!({"jsonrpc":"2.0", "id":4, "method":"settings.removeTunHelper", "params":{}}),
            )
            .await;
            assert_eq!(retried["result"]["tunHelper"]["removal"], "not-installed");
            let retained = occurrences.records();
            assert_eq!(retained.len(), 2);
            assert_eq!(retained[0], retained_failure[0]);
            assert_eq!(retained[1].admitted_revision, 2);
            assert_ne!(retained[0].operation_id, retained[1].operation_id);
            assert_eq!(
                retained[1].outcome,
                mish_runtime::TunHelperRemovalOutcome::Removed
            );
            assert_eq!(
                retained[1].cleanup,
                TunHelperRemovalCleanupOutcome::ConfirmedAbsent
            );

            let after_retry_notifications = rpc_request(
                &mut socket,
                json!({"jsonrpc":"2.0", "id":5, "method":"notifications.getSnapshot", "params":{}}),
            )
            .await;
            let lifecycle_outcomes = after_retry_notifications["result"]["notifications"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|record| record["presentation"]["kind"] == "tun-helper.lifecycle")
                .map(|record| record["presentation"]["data"]["outcome"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert!(lifecycle_outcomes.contains(&expected_outcome));
            assert!(lifecycle_outcomes.contains(&"removed"));

            let duplicate_retry = rpc_request(
                &mut socket,
                json!({"jsonrpc":"2.0", "id":6, "method":"settings.removeTunHelper", "params":{}}),
            )
            .await;
            assert_eq!(
                duplicate_retry["error"]["data"]["outcome"],
                "observation-incomplete"
            );
            let after_duplicate = occurrences.records();
            assert_eq!(after_duplicate.len(), 3);
            assert_eq!(after_duplicate[0], retained_failure[0]);
            assert_eq!(after_duplicate[1], retained[1]);
            assert_eq!(after_duplicate[2].admitted_revision, 3);
            assert_eq!(
                after_duplicate[2].failure,
                Some(TunHelperRemovalOccurrenceFailure::InstallationUnconfirmed)
            );
            assert_eq!(
                scenario
                    .settings_service
                    .snapshot(SettingsAdapterKind::Rpc)
                    .tun_helper
                    .removal,
                TunHelperRemovalCapability::NotInstalled
            );
        }

        shutdown_with_profile_coordinator(&scenario).await;
        drop(socket);
        assert!(matches!(
            bridge.shutdown().await,
            BridgeShutdownOutcome::Confirmed(_)
        ));
    }
}

#[tokio::test]
async fn interrupted_removal_is_reconciled_and_republished_before_a_restart_retry() {
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await,
    );
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.path().join("internal-tun-removal-occurrences.json");
    {
        let before_restart = TunHelperRemovalOccurrenceStore::open_private_file(path.clone())
            .expect("private removal store");
        let admission = before_restart
            .admit(
                "00000000-0000-0000-0000-000000000001".into(),
                mish_bridge::TunHelperRemovalAdmittedState::Running,
            )
            .unwrap();
        before_restart
            .advance(
                &admission,
                TunHelperRemovalLifecyclePhase::PrivilegedMaintenance,
                TunHelperRemovalObservationOutcome::ConfirmedSafe,
                TunHelperRemovalCleanupOutcome::NotStarted,
            )
            .unwrap();
    }
    let occurrences = Arc::new(
        TunHelperRemovalOccurrenceStore::open_private_file(path)
            .expect("restart must reconcile the interrupted occurrence"),
    );
    let interrupted = occurrences.records();
    assert_eq!(interrupted.len(), 1);
    assert_eq!(
        interrupted[0].failure,
        Some(TunHelperRemovalOccurrenceFailure::ProcessInterrupted)
    );
    assert_eq!(
        interrupted[0].cleanup,
        TunHelperRemovalCleanupOutcome::Incomplete
    );
    assert_eq!(
        interrupted[0].lifecycle_phase,
        TunHelperRemovalLifecyclePhase::PrivilegedMaintenance
    );

    let bridge = start_loopback_server_with_runtime_host(
        rpc_config_with_occurrences(&scenario, occurrences.clone()),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut socket = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut socket).await;
    let restored = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":2, "method":"notifications.getSnapshot", "params":{}}),
    )
    .await;
    let restored_lifecycle = notification(&restored, "tun-helper.lifecycle");
    assert_eq!(
        restored_lifecycle["presentation"]["data"]["outcome"],
        "observation-incomplete"
    );
    assert_eq!(
        restored_lifecycle["presentation"]["data"]["failure"],
        "process-interrupted"
    );
    assert_eq!(restored_lifecycle["resolved"], true);

    let retried = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":3, "method":"settings.removeTunHelper", "params":{}}),
    )
    .await;
    assert_eq!(retried["result"]["tunHelper"]["removal"], "not-installed");
    let retained = occurrences.records();
    assert_eq!(retained.len(), 2);
    assert_eq!(retained[0], interrupted[0]);
    assert_eq!(retained[1].admitted_revision, 2);
    assert_eq!(
        retained[1].outcome,
        mish_runtime::TunHelperRemovalOutcome::Removed
    );

    shutdown_with_profile_coordinator(&scenario).await;
    drop(socket);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn capture_shutdown_failure_blocks_helper_removal_before_authorization() {
    let scenario = Arc::new(
        build(
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V1,
            Vec::new(),
        )
        .await,
    );
    scenario
        .maintenance
        .fail_next_tun_mutation(TunHelperFailureKind::OperationFailed)
        .unwrap();
    let before = scenario.host.maintenance_observation().unwrap();
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config(&scenario),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut socket = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut socket).await;

    let rejected = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":2, "method":"settings.removeTunHelper", "params":{}}),
    )
    .await;
    assert_eq!(rejected["error"]["data"]["outcome"], "shutdown-failed");
    assert!(scenario.maintenance.journal_snapshot().is_none());
    let after = scenario.host.maintenance_observation().unwrap();
    assert_eq!(after.installation_id, before.installation_id);
    assert_eq!(after.unrelated, before.unrelated);
    assert!(
        scenario
            .host
            .observation()
            .transcript
            .events
            .iter()
            .all(|event| event.effect_kind != EffectKind::MaintenanceAuthorize)
    );

    shutdown_with_profile_coordinator(&scenario).await;
    drop(socket);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn authenticated_rpc_projects_early_failure_actionable_recovery_and_terminal_cleanup() {
    let mut host_scenario = SimulatedHostScenario::internal_tun_maintenance();
    host_scenario.scheduled_changes = vec![ScheduledChange::ProxyState {
        at: 1,
        state: SyntheticProxyState::Manual,
    }];
    let scenario = Arc::new(
        MaintenanceScenarioRuntime::build(
            host_scenario,
            maintenance_scenario(
                SyntheticMaintenanceInitial::HealthyV1,
                SyntheticPackageVersion::V2,
                Vec::new(),
            ),
        )
        .await
        .unwrap(),
    );
    let bridge = start_loopback_server_with_runtime_host(
        rpc_config(&scenario),
        scenario.runtime_host.clone(),
    )
    .await
    .unwrap();
    let mut socket = rpc_socket(bridge.address).await;
    rpc_authenticate(&mut socket).await;
    let enabled = rpc_request(
        &mut socket,
        json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"status.setCapture",
            "params":{"active":true, "selection":{"systemProxy":true, "tun":false}},
        }),
    )
    .await;
    assert_eq!(
        enabled["result"]["runtime"]["systemProxy"]["phase"], "applied",
        "capture response: {enabled}"
    );

    // Selecting System Proxy relinquishes the initially active TUN and stops its synthetic
    // Core. Re-start through the real Core runtime before applying the authenticated repair.
    scenario
        .runtime_host
        .current()
        .execute_core_lifecycle(
            &CoreLifecycleOperation::new("simulated-profile", 1, "repair-drift", 1, 1).unwrap(),
            CoreLifecycleMutation::Start,
        )
        .await
        .unwrap();
    scenario.host.advance_to(1).unwrap();
    let drift = rpc_request(
        &mut socket,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"status.setCapture",
            "params":{"active":true, "selection":{"systemProxy":true, "tun":false}},
        }),
    )
    .await;
    assert_eq!(drift["error"]["data"]["kind"], "external-drift");
    assert_eq!(
        drift["error"]["data"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "drift"
    );
    let failure_snapshot = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":4, "method":"notifications.getSnapshot", "params":{}}),
    )
    .await;
    let failure = notification(&failure_snapshot, "capture.failure");
    assert_eq!(failure["resolved"], false);
    assert_eq!(failure["presentation"]["data"]["failure"], "external-drift");
    assert_eq!(
        failure["presentation"]["actionIds"],
        json!(["repair", "leave-as-is"])
    );

    let recovered = rpc_request(
        &mut socket,
        json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"status.recoverSystemProxy",
            "params":{"action":"repair"},
        }),
    )
    .await;
    assert_eq!(
        recovered["result"]["runtime"]["systemProxy"]["phase"], "applied",
        "recovery response: {recovered}"
    );
    let terminal = rpc_request(
        &mut socket,
        json!({"jsonrpc":"2.0", "id":6, "method":"notifications.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(notification(&terminal, "capture.failure")["resolved"], true);
    assert!(
        !terminal.to_string().contains("simulated.yaml"),
        "the authenticated projection stays bounded and profile-free"
    );

    shutdown_with_profile_coordinator(&scenario).await;
    drop(socket);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn maintenance_model_matrix_has_bounded_private_transcripts_and_preserves_unrelated_state() {
    let cases = [
        (
            SyntheticMaintenanceInitial::Absent,
            SyntheticPackageVersion::V1,
            "install",
        ),
        (
            SyntheticMaintenanceInitial::HealthyV1,
            SyntheticPackageVersion::V2,
            "repair",
        ),
        (
            SyntheticMaintenanceInitial::HealthyV2,
            SyntheticPackageVersion::V2,
            "install",
        ),
        (
            SyntheticMaintenanceInitial::RepairRequired,
            SyntheticPackageVersion::V2,
            "repair",
        ),
    ];
    for (initial, target, operation) in cases {
        let scenario = build(initial, target, Vec::new()).await;
        let unrelated = scenario.host.maintenance_observation().unwrap().unrelated;
        if operation == "repair" && initial == SyntheticMaintenanceInitial::HealthyV1 {
            handoff_capture(&scenario).await;
        }
        let result = if operation == "install" {
            scenario.settings_service.install_tun_helper().await
        } else {
            scenario.settings_service.repair_tun_helper().await
        };
        assert!(
            result.is_ok(),
            "{initial:?} {operation} must settle: {result:?}"
        );

        let observation = scenario.host.observation();
        let maintenance = observation.maintenance.as_ref().unwrap();
        assert_eq!(maintenance.unrelated, unrelated, "{initial:?} {operation}");
        assert!(
            observation.transcript.events.len() <= MAX_TRANSCRIPT_LIMIT,
            "{initial:?} {operation} exceeded the closed transcript bound"
        );
        let serialized = serde_json::to_string(&observation).unwrap();
        let decoded: ScenarioObservation = serde_json::from_str(&serialized).unwrap();
        assert_eq!(decoded, observation);
        for forbidden in [
            "simulated.yaml",
            "simulated-controller-secret",
            "PRIVATE KEY",
            "MISH_BRIDGE_TOKEN",
            "/Users/",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{initial:?} {operation} leaked {forbidden} into its semantic transcript"
            );
        }
    }

    for forbidden_input in [
        json!({
            "initial":"absent",
            "target":"v1",
            "profile":"raw-profile-content",
        }),
        json!({
            "initial":"absent",
            "target":"v1",
            "privateKey":"raw-private-key",
        }),
    ] {
        assert!(
            serde_json::from_value::<MaintenanceScenario>(forbidden_input).is_err(),
            "maintenance input accepts an unbounded private fixture field"
        );
    }
}

#[tokio::test]
async fn internal_tun_schema_rejects_unknown_nested_fields_and_unbounded_fault_inputs() {
    let valid_fault = json!({
        "at": "prior-service-detached",
        "kind": "permission-denied",
        "occurrence": 1,
    });
    for input in [
        json!({
            "initial": "absent",
            "target": "v1",
            "faults": [{
                "at": "intent-persisted",
                "kind": "disk-full",
                "privatePath": "/Users/test/secret",
            }],
        }),
        json!({
            "initial": "absent",
            "target": "v1",
            "faults": [valid_fault.clone()],
            "privateKey": "BEGIN PRIVATE KEY",
        }),
    ] {
        assert!(
            serde_json::from_value::<MaintenanceScenario>(input).is_err(),
            "private or unknown maintenance input was admitted"
        );
    }

    for occurrence in [0, 17] {
        let input = json!({
            "initial": "absent",
            "target": "v1",
            "faults": [{
                "at": "prior-service-detached",
                "kind": "permission-denied",
                "occurrence": occurrence,
            }],
        });
        assert!(
            serde_json::from_value::<MaintenanceScenario>(input).is_err(),
            "fault occurrence {occurrence} escaped its bounded schema"
        );
    }

    let oversized = (0..17).map(|_| valid_fault.clone()).collect::<Vec<_>>();
    assert!(
        serde_json::from_value::<MaintenanceScenario>(json!({
            "initial": "absent",
            "target": "v1",
            "faults": oversized,
        }))
        .is_err(),
        "fault list exceeded the bounded schema"
    );
    assert!(
        serde_json::from_value::<MaintenanceScenario>(json!({
            "initial": "absent",
            "target": "v1",
            "pauseAt": "intent-persisted",
        }))
        .is_err(),
        "unpaired logical pause was admitted"
    );

    let scenario = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        Vec::new(),
    )
    .await;
    let maintenance = scenario.host.maintenance_observation().unwrap();
    let serialized = serde_json::to_string(&maintenance).unwrap();
    for forbidden in [
        "privateKey",
        "BEGIN PRIVATE KEY",
        "rawHostState",
        "/Users/",
        "simulated-controller-secret",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "Internal TUN observation leaked {forbidden}"
        );
    }

    let mut unknown = serde_json::to_value(&maintenance).unwrap();
    unknown
        .as_object_mut()
        .unwrap()
        .insert("rawHostState".into(), json!("private"));
    assert!(
        serde_json::from_value::<MaintenanceObservation>(unknown).is_err(),
        "top-level observation accepted an unknown field"
    );

    let mut unknown_artifact = serde_json::to_value(&maintenance).unwrap();
    unknown_artifact["artifacts"]
        .as_object_mut()
        .unwrap()
        .insert("path".into(), json!("/Users/test/secret"));
    assert!(
        serde_json::from_value::<MaintenanceObservation>(unknown_artifact).is_err(),
        "artifact identity accepted a private path field"
    );

    let mut unknown_unrelated = serde_json::to_value(&maintenance).unwrap();
    unknown_unrelated["unrelated"]
        .as_object_mut()
        .unwrap()
        .insert("rawProcess".into(), json!("private"));
    assert!(
        serde_json::from_value::<MaintenanceObservation>(unknown_unrelated).is_err(),
        "unrelated synthetic state accepted an unknown field"
    );
}
