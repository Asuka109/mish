use std::sync::Arc;

use mish_runtime::{CoreLifecycleMutation, CoreLifecycleOperation, MishRuntime};
use mish_simulated_host::{
    EffectKind, EffectResultKind, SimulatedHost, SimulatedHostScenario, SyntheticProxyState,
};

#[tokio::test]
async fn core_cleanup_transcript_records_signal_stop_and_normal_wait() {
    let host = Arc::new(
        SimulatedHost::new(SimulatedHostScenario::system_proxy_transaction(
            SyntheticProxyState::Disabled,
        ))
        .unwrap(),
    );
    let runtime = MishRuntime::new(host.clone());
    let operation =
        CoreLifecycleOperation::new("activation-test", 1, "normal-cleanup", 1, 1).unwrap();

    runtime
        .execute_core_lifecycle(&operation, CoreLifecycleMutation::Stop)
        .await
        .unwrap();

    let events = host.observation().transcript.events;
    let signal = events
        .iter()
        .position(|event| {
            event.effect_kind == EffectKind::CoreSignal
                && event.result_kind == EffectResultKind::Signalled
        })
        .unwrap();
    let stop = events
        .iter()
        .position(|event| {
            event.effect_kind == EffectKind::CoreStop
                && event.result_kind == EffectResultKind::Stopped
        })
        .unwrap();
    let wait = events
        .iter()
        .position(|event| {
            event.effect_kind == EffectKind::CoreWaitForExit
                && event.result_kind == EffectResultKind::Exited
        })
        .unwrap();
    assert!(signal < stop && stop < wait);
}

#[tokio::test]
async fn core_start_transcript_records_both_commit_identity_barriers() {
    let host =
        Arc::new(SimulatedHost::new(SimulatedHostScenario::internal_tun_maintenance()).unwrap());
    let runtime = MishRuntime::new(host.clone());
    let operation =
        CoreLifecycleOperation::new("activation-test", 1, "identity-commit", 1, 1).unwrap();

    runtime
        .execute_core_lifecycle(&operation, CoreLifecycleMutation::Start)
        .await
        .unwrap();

    let events = host.observation().transcript.events;
    let commit_positions = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            (event.effect_kind == EffectKind::CoreIdentityCommit
                && event.result_kind == EffectResultKind::Verified)
                .then_some(index)
        })
        .collect::<Vec<_>>();
    let start = events
        .iter()
        .position(|event| {
            event.effect_kind == EffectKind::CoreStart
                && event.result_kind == EffectResultKind::Started
        })
        .unwrap();
    assert_eq!(commit_positions.len(), 2);
    assert!(
        commit_positions
            .into_iter()
            .all(|position| position < start)
    );
}
