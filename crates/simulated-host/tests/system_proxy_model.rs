use std::sync::Arc;

use mish_runtime::{
    CaptureAuditReason, CaptureFailureKind, CaptureOperationPhase, CaptureRequest,
    CaptureSelection, StatusAdapterKind, SystemProxyPhase, SystemProxyTakeoverPolicy,
};
use mish_simulated_host::{
    EffectKind, EffectResultKind, InjectedFailure, InjectedFailureKind, ScenarioRuntime,
    ScheduledChange, SimulatedHostScenario, SyntheticAuthorityId, SyntheticProxyState,
    SyntheticRuntimeId, SyntheticService,
};

fn system_proxy_request(active: bool) -> CaptureRequest {
    CaptureRequest {
        active,
        selection: CaptureSelection {
            system_proxy: true,
            tun: false,
        },
    }
}

async fn settle_until(mut predicate: impl FnMut() -> bool) {
    for _ in 0..512 {
        if predicate() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("system proxy model did not settle within the scheduler budget");
}

#[tokio::test]
async fn complete_typed_baselines_round_trip_through_the_real_application_capture_path() {
    for preset in [
        SyntheticProxyState::Disabled,
        SyntheticProxyState::Manual,
        SyntheticProxyState::DisabledPopulated,
        SyntheticProxyState::Pac,
        SyntheticProxyState::AutoDiscovery,
    ] {
        let scenario =
            ScenarioRuntime::build(SimulatedHostScenario::system_proxy_transaction(preset))
                .await
                .unwrap();
        if matches!(
            preset,
            SyntheticProxyState::Pac | SyntheticProxyState::AutoDiscovery
        ) {
            scenario.capture.set_system_proxy_takeover_policy(
                SystemProxyTakeoverPolicy::ReplaceReversiblePacOrAutoDiscovery,
            );
        }
        let baseline = scenario.host.actual_proxy_state();

        scenario
            .runtime_host
            .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
            .await
            .unwrap();
        let applied = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            applied.runtime.capture_operation.phase,
            CaptureOperationPhase::Applied
        );
        assert_eq!(
            applied.runtime.system_proxy.phase,
            SystemProxyPhase::Applied
        );
        assert!(applied.runtime.system_proxy_enabled);
        let native = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Native)
            .await;
        assert_eq!(
            native.runtime.capture_operation.phase,
            applied.runtime.capture_operation.phase
        );
        assert_eq!(native.runtime.system_proxy, applied.runtime.system_proxy);
        assert_eq!(
            scenario.host.journal_snapshot().unwrap().prior,
            baseline,
            "{preset:?} must be journaled without normalization"
        );
        let managed = scenario.host.actual_proxy_state();
        assert_eq!(managed.http, managed.https);
        assert_eq!(managed.http, managed.socks);
        assert!(managed.http.enabled);
        assert!(!managed.http.authenticated);
        assert!(!managed.pac_enabled);
        assert!(!managed.auto_discovery_enabled);
        assert!(managed.bypass_domains.len() >= baseline.bypass_domains.len());

        scenario
            .runtime_host
            .set_capture(system_proxy_request(false), StatusAdapterKind::Rpc)
            .await
            .unwrap();
        let stopped = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            stopped.runtime.capture_operation.phase,
            CaptureOperationPhase::Applied
        );
        assert_eq!(stopped.runtime.system_proxy.phase, SystemProxyPhase::Off);
        assert!(!stopped.runtime.system_proxy_enabled);
        assert_eq!(scenario.host.actual_proxy_state(), baseline);
        assert_eq!(scenario.host.observed_proxy_state(), baseline);
        assert!(scenario.host.journal_snapshot().is_none());
    }
}

#[tokio::test]
async fn protected_and_unsafe_takeovers_reject_without_model_writes_or_applied_projection() {
    for preset in [
        SyntheticProxyState::Pac,
        SyntheticProxyState::AutoDiscovery,
        SyntheticProxyState::Authenticated,
        SyntheticProxyState::UnsafeIncomplete,
    ] {
        let scenario =
            ScenarioRuntime::build(SimulatedHostScenario::system_proxy_transaction(preset))
                .await
                .unwrap();
        let baseline = scenario.host.actual_proxy_state();
        let error = scenario
            .runtime_host
            .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
            .await
            .unwrap_err();
        assert_eq!(error.kind, CaptureFailureKind::TakeoverRejected);
        assert_eq!(scenario.host.actual_proxy_state(), baseline);
        assert_eq!(scenario.host.observation().proxy_actual_revision, 0);
        assert!(scenario.host.journal_snapshot().is_none());
        assert!(
            !scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| {
                    matches!(
                        event.effect_kind,
                        EffectKind::CaptureApply
                            | EffectKind::CaptureWriteAutoDiscovery
                            | EffectKind::CaptureWritePac
                            | EffectKind::CaptureWriteHttp
                            | EffectKind::CaptureWriteHttps
                            | EffectKind::CaptureWriteSocks
                            | EffectKind::CaptureWriteBypass
                    )
                })
        );
        let terminal = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_ne!(
            terminal.runtime.capture_operation.phase,
            CaptureOperationPhase::Applied
        );
    }
}

#[tokio::test]
async fn preliminary_and_commit_observations_reject_scheduled_proxy_or_service_drift() {
    for change in [
        ScheduledChange::ProxyState {
            at: 2,
            state: SyntheticProxyState::Manual,
        },
        ScheduledChange::ActiveService {
            at: 2,
            service: SyntheticService::Secondary,
        },
    ] {
        let mut definition =
            SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Disabled);
        definition.scheduled_changes = vec![change];
        let scenario = ScenarioRuntime::build(definition).await.unwrap();
        let runtime = scenario.runtime_host.current();
        let preflight = runtime
            .preflight_capture(&system_proxy_request(true))
            .await
            .unwrap();
        scenario.host.advance_to(2).unwrap();
        let drifted = scenario.host.actual_proxy_state();
        let error = runtime
            .set_capture_with_preflight(
                system_proxy_request(true),
                StatusAdapterKind::Rpc,
                preflight,
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind, CaptureFailureKind::ExternalDrift);
        assert_eq!(scenario.host.actual_proxy_state(), drifted);
        assert!(scenario.host.journal_snapshot().is_none());
        assert_eq!(scenario.host.observation().proxy_actual_revision, 1);
        assert!(
            !scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| { matches!(event.effect_kind, EffectKind::CaptureApply) })
        );
        let terminal = runtime.status_snapshot_typed(StatusAdapterKind::Rpc).await;
        assert_eq!(
            terminal.runtime.capture_operation.phase,
            CaptureOperationPhase::Failed
        );
        assert_eq!(terminal.runtime.system_proxy.phase, SystemProxyPhase::Drift);
        assert!(!terminal.runtime.system_proxy_enabled);
    }
}

#[tokio::test]
async fn every_ordered_write_failure_runs_real_compensation_and_restores_the_exact_baseline() {
    let boundaries = [
        EffectKind::CaptureWriteAutoDiscovery,
        EffectKind::CaptureWritePac,
        EffectKind::CaptureWriteHttp,
        EffectKind::CaptureWriteHttps,
        EffectKind::CaptureWriteSocks,
        EffectKind::CaptureWriteBypass,
    ];
    for boundary in boundaries {
        let mut definition =
            SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Manual);
        definition.failures.push(InjectedFailure {
            after_effect: None,
            effect: boundary,
            kind: InjectedFailureKind::Operation,
            occurrence: 1,
        });
        let scenario = ScenarioRuntime::build(definition).await.unwrap();
        let baseline = scenario.host.actual_proxy_state();
        let error = scenario
            .runtime_host
            .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
            .await
            .unwrap_err();
        assert_eq!(error.kind, CaptureFailureKind::ApplyFailed);
        assert_eq!(scenario.host.actual_proxy_state(), baseline, "{boundary:?}");
        assert_eq!(
            scenario.host.observed_proxy_state(),
            baseline,
            "{boundary:?}"
        );
        assert!(scenario.host.journal_snapshot().is_none(), "{boundary:?}");
        let transcript = scenario.host.observation().transcript;
        assert!(transcript.events.iter().any(|event| {
            event.effect_kind == boundary && event.result_kind == EffectResultKind::InjectedFailure
        }));
        let terminal = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            terminal.runtime.capture_operation.phase,
            CaptureOperationPhase::Failed
        );
        assert_eq!(
            terminal.runtime.system_proxy.phase,
            SystemProxyPhase::Failed
        );
        assert!(!terminal.runtime.system_proxy_enabled);
    }
}

#[tokio::test]
async fn unconfirmed_compensation_is_recovery_required_and_never_false_idle_or_applied() {
    let mut definition =
        SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Manual);
    definition.failures.extend([
        InjectedFailure {
            after_effect: None,
            effect: EffectKind::CaptureWriteHttps,
            kind: InjectedFailureKind::Operation,
            occurrence: 1,
        },
        InjectedFailure {
            after_effect: Some(EffectKind::CaptureWriteHttps),
            effect: EffectKind::CaptureObserve,
            kind: InjectedFailureKind::Observation,
            occurrence: 1,
        },
    ]);
    let scenario = ScenarioRuntime::build(definition).await.unwrap();
    let error = scenario
        .runtime_host
        .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
        .await
        .unwrap_err();
    assert_eq!(error.kind, CaptureFailureKind::RollbackFailed);
    let terminal = scenario
        .runtime_host
        .current()
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(
        terminal.runtime.capture_operation.phase,
        CaptureOperationPhase::RecoveryRequired
    );
    assert_eq!(terminal.runtime.system_proxy.phase, SystemProxyPhase::Drift);
    assert!(!terminal.runtime.system_proxy_enabled);
    assert!(scenario.host.journal_snapshot().is_some());
    let notifications =
        serde_json::to_string(&scenario.runtime_host.notification_snapshot()).unwrap();
    assert!(notifications.contains("capture.failure"));
    assert!(notifications.contains("rollback-failed"));
}

#[tokio::test]
async fn confirmation_retries_on_logical_time_and_duplicate_work_cannot_replace_authority() {
    let mut definition =
        SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::DisabledPopulated);
    definition.propagation_delay = 5;
    let scenario = Arc::new(ScenarioRuntime::build(definition).await.unwrap());
    let runtime = scenario.runtime_host.current();
    let enable = tokio::spawn(async move {
        runtime
            .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
            .await
    });
    settle_until(|| scenario.host.observation().pending_proxy_propagation).await;
    let pending = scenario
        .runtime_host
        .current()
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(
        pending.runtime.capture_operation.phase,
        CaptureOperationPhase::Pending
    );
    assert_eq!(
        pending.runtime.system_proxy.phase,
        SystemProxyPhase::Pending
    );
    assert!(!enable.is_finished());
    let duplicate = scenario
        .runtime_host
        .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
        .await
        .unwrap_err();
    assert_eq!(duplicate.kind, CaptureFailureKind::RuntimeTransition);

    scenario.host.advance_to(5).unwrap();
    enable.await.unwrap().unwrap();
    let applied = scenario
        .runtime_host
        .current()
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(
        applied.runtime.capture_operation.phase,
        CaptureOperationPhase::Applied
    );
    assert_eq!(
        applied.runtime.system_proxy.phase,
        SystemProxyPhase::Applied
    );
    assert_eq!(
        scenario.host.observation().proxy_actual_revision,
        scenario.host.observation().proxy_observed_revision
    );
    let observations = scenario
        .host
        .observation()
        .transcript
        .events
        .iter()
        .filter(|event| event.effect_kind == EffectKind::CaptureObserve)
        .map(|event| event.logical_time)
        .collect::<Vec<_>>();
    assert!(observations.windows(2).any(|times| times == [0, 5]));
}

#[tokio::test]
async fn restart_reobserves_the_real_journal_and_completes_compensates_or_exposes_drift() {
    // Complete: the replacement proves an already-managed state instead of trusting the journal.
    let complete = ScenarioRuntime::build(SimulatedHostScenario::system_proxy_transaction(
        SyntheticProxyState::Disabled,
    ))
    .await
    .unwrap();
    complete
        .runtime_host
        .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
        .await
        .unwrap();
    let writes_before = complete.host.observation().proxy_actual_revision;
    let terminated_capture = Arc::downgrade(&complete.capture);
    let complete = complete.terminate_and_restart();
    assert!(terminated_capture.upgrade().is_none());
    complete
        .runtime_host
        .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
        .await
        .unwrap();
    assert_eq!(
        complete.host.observation().proxy_actual_revision,
        writes_before
    );
    assert_eq!(
        complete
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await
            .runtime
            .capture_operation
            .phase,
        CaptureOperationPhase::Applied
    );

    // Compensate: a fresh Runtime starts with no desired state and restores the exact journal.
    let compensate = ScenarioRuntime::build(SimulatedHostScenario::system_proxy_transaction(
        SyntheticProxyState::Manual,
    ))
    .await
    .unwrap();
    let baseline = compensate.host.actual_proxy_state();
    compensate
        .runtime_host
        .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
        .await
        .unwrap();
    let compensate = compensate.terminate_and_restart();
    compensate
        .runtime_host
        .audit_capture(CaptureAuditReason::Restart)
        .await
        .unwrap();
    assert_eq!(compensate.host.actual_proxy_state(), baseline);
    assert!(compensate.host.journal_snapshot().is_none());
    compensate
        .runtime_host
        .audit_capture(CaptureAuditReason::Restart)
        .await
        .unwrap();
    assert_eq!(compensate.host.actual_proxy_state(), baseline);

    // Actionable drift: unrelated external fields are not overwritten during restart.
    let mut drift_definition =
        SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Disabled);
    drift_definition.scheduled_changes = vec![ScheduledChange::ProxyState {
        at: 3,
        state: SyntheticProxyState::Manual,
    }];
    let drift = ScenarioRuntime::build(drift_definition).await.unwrap();
    drift
        .runtime_host
        .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
        .await
        .unwrap();
    drift.host.advance_to(3).unwrap();
    let external = drift.host.actual_proxy_state();
    let drift = drift.terminate_and_restart();
    let error = drift
        .runtime_host
        .audit_capture(CaptureAuditReason::Restart)
        .await
        .unwrap_err();
    assert_eq!(error.kind, CaptureFailureKind::ExternalDrift);
    assert_eq!(drift.host.actual_proxy_state(), external);
    assert!(drift.host.journal_snapshot().is_some());
    let recovery = drift
        .runtime_host
        .current()
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(
        recovery.runtime.capture_operation.phase,
        CaptureOperationPhase::RecoveryRequired
    );
    assert_eq!(recovery.runtime.system_proxy.phase, SystemProxyPhase::Drift);
}

#[tokio::test]
async fn replacement_retires_a_stale_equal_target_completion_from_the_old_runtime() {
    let mut definition =
        SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Disabled);
    definition.propagation_delay = 5;
    let scenario = Arc::new(ScenarioRuntime::build(definition).await.unwrap());
    let old_runtime = scenario.runtime_host.current();
    let old = tokio::spawn(async move {
        old_runtime
            .set_capture(system_proxy_request(true), StatusAdapterKind::Rpc)
            .await
    });
    settle_until(|| scenario.host.observation().pending_proxy_propagation).await;
    scenario.replace_runtime();
    let replacement_before = scenario
        .runtime_host
        .current()
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(
        replacement_before.runtime.capture_operation.phase,
        CaptureOperationPhase::Idle
    );
    scenario.host.advance_to(5).unwrap();
    old.await.unwrap().unwrap();
    let replacement_after = scenario
        .runtime_host
        .current()
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(
        replacement_after.runtime.capture_operation.phase,
        CaptureOperationPhase::Idle
    );
    assert!(!replacement_after.runtime.system_proxy_enabled);
    let old_completion = scenario
        .host
        .observation()
        .transcript
        .events
        .into_iter()
        .find(|event| event.effect_kind == EffectKind::CaptureObserve && event.logical_time == 5)
        .expect("old Runtime confirmation observation");
    assert_eq!(
        old_completion.authority_id,
        SyntheticAuthorityId::CaptureOne
    );
    assert_eq!(old_completion.runtime_id, SyntheticRuntimeId::RuntimeOne);
    assert_eq!(old_completion.operation_id, Some(1));
    assert_eq!(old_completion.admitted_revision, 1);
}

#[test]
fn system_proxy_transcripts_remain_closed_deterministic_and_raw_adapter_free() {
    fn transcript() -> String {
        let host = mish_simulated_host::SimulatedHost::new(
            SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Manual),
        )
        .unwrap();
        host.exercise_effect(EffectKind::CaptureObserve).unwrap();
        host.exercise_effect(EffectKind::CaptureWriteHttp).unwrap();
        serde_json::to_string(&host.observation().transcript).unwrap()
    }
    let first = transcript();
    assert_eq!(first, transcript());
    for forbidden in [
        "networksetup",
        "scutil",
        "rawOutput",
        "proxy.invalid",
        "pac.invalid",
        SYNTHETIC_HOST_PATH_SENTINEL,
        "credential",
        "authentication",
    ] {
        assert!(!first.contains(forbidden), "{forbidden} entered transcript");
    }
}

const SYNTHETIC_HOST_PATH_SENTINEL: &str = "/Users/";

#[tokio::test]
async fn concurrent_preliminary_observations_are_state_preserving_and_transcript_deterministic() {
    async fn run() -> String {
        let host = Arc::new(
            mish_simulated_host::SimulatedHost::new(
                SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Manual),
            )
            .unwrap(),
        );
        let (left, right) = tokio::join!(
            mish_runtime::CapturePlatform::preflight_observe_active(&*host),
            mish_runtime::CapturePlatform::preflight_observe_active(&*host),
        );
        assert_eq!(left.unwrap(), right.unwrap());
        assert_eq!(host.observation().proxy_actual_revision, 0);
        serde_json::to_string(&host.observation().transcript).unwrap()
    }

    assert_eq!(run().await, run().await);
}
