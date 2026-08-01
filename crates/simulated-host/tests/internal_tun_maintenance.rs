use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use mish_bridge::{
    BridgeShutdownOutcome, LoopbackPortSelection, LoopbackServerConfig,
    start_loopback_server_with_runtime_host,
};
use mish_platform_macos::internal_tun_maintenance::{
    EnrollmentTransition, MaintenanceCommitPoint, MaintenanceKind, MaintenanceTerminalOutcome,
};
use mish_runtime::{CaptureRequest, CaptureSelection, StatusAdapterKind, TunHelperFailureKind};
use mish_settings::SettingsServiceError;
use mish_simulated_host::{
    EffectKind, MAX_TRANSCRIPT_LIMIT, MaintenanceFault, MaintenanceFaultKind, MaintenanceScenario,
    MaintenanceScenarioRuntime, ScenarioObservation, ScheduledChange, SimulatedHostScenario,
    SyntheticMaintenanceInitial, SyntheticOwnership, SyntheticPackageVersion, SyntheticProxyState,
    TEST_AUTH_TOKEN,
};
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
}

fn rpc_config(scenario: &MaintenanceScenarioRuntime) -> LoopbackServerConfig {
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
    assert_eq!(artifacts.package_version, "0.1.0-internal-tun-alpha.6");
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
        SyntheticPackageVersion::V1,
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
async fn restart_observes_only_exact_authority_before_complete_compensate_or_recovery_required() {
    let complete = build(
        SyntheticMaintenanceInitial::HealthyV1,
        SyntheticPackageVersion::V2,
        vec![MaintenanceFault {
            at: MaintenanceCommitPoint::ServiceStarted,
            kind: MaintenanceFaultKind::CoreExited,
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
            vec![MaintenanceFault { at: boundary, kind }],
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
        json!({"jsonrpc":"2.0", "id":2, "method":"notifications.subscribe", "params":{}}),
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
            json!({"jsonrpc":"2.0", "id":4, "method":"settings.repairTunHelper", "params":{}}),
        )
        .await
    });
    settle_until(|| scenario.maintenance.journal_snapshot().is_some()).await;

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
            json!({"jsonrpc":"2.0", "id":5, "method":"settings.repairTunHelper", "params":{}}),
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
    let duplicate = tokio::time::timeout(Duration::from_secs(2), duplicate)
        .await
        .expect("serialized identical repair must settle")
        .unwrap();
    assert!(duplicate["result"].is_object());

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
    assert!(!lifecycles.is_empty());
    assert!(lifecycles.iter().all(|record| record["pinned"] == false));
    assert!(
        lifecycles
            .iter()
            .all(|record| { record["presentation"]["data"]["outcome"] == "applied" })
    );

    drop(notifications);
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
    scenario.runtime_host.current().start_core().await.unwrap();
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
