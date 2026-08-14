use std::sync::Arc;

use mish_bridge::{
    DesktopLifecycleCoordinator, LifecycleAuthorityState, LifecycleEventDisposition,
    LifecycleRecoveryState,
};
use mish_runtime::{PlatformLifecycleEventKind, PlatformLifecycleEventSource};
use mish_simulated_host::{
    EffectKind, EffectResultKind, InjectedFailure, InjectedFailureKind, ScenarioRuntime,
    ScheduledChange, SimulatedHostScenario, SyntheticAuthorityId, SyntheticLifecycleState,
};
use serde_json::json;

#[tokio::test]
async fn lost_wake_replays_one_closed_platform_observation_through_the_real_coordinator() {
    let mut definition = SimulatedHostScenario::lifecycle_recovery();
    definition.scheduled_changes = vec![ScheduledChange::LifecycleState {
        at: 5,
        state: SyntheticLifecycleState::Awake,
    }];
    let scenario = ScenarioRuntime::build(definition).await.unwrap();
    let source: Arc<dyn PlatformLifecycleEventSource> = scenario.host.clone();
    let coordinator = DesktopLifecycleCoordinator::with_platform_source(
        scenario.runtime_host.clone(),
        None,
        source,
    );

    let sleep = scenario
        .host
        .publish_lifecycle_event(PlatformLifecycleEventKind::Sleep);
    assert_eq!(
        coordinator.handle_platform_event(sleep).await.unwrap(),
        LifecycleEventDisposition::Applied
    );
    scenario.host.advance_to(5).unwrap();
    coordinator.reconcile_after_event_gap().await.unwrap();

    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.generation, 2);
    assert_eq!(authority.sequence, 2);
    assert_eq!(authority.state, LifecycleAuthorityState::Awake);
    assert_eq!(authority.recovery, LifecycleRecoveryState::Current);
    let observation = scenario.host.observation();
    assert_eq!(observation.lifecycle_sequence, 2);
    assert_eq!(observation.lifecycle_state, SyntheticLifecycleState::Awake);
    let lifecycle = observation
        .transcript
        .events
        .iter()
        .find(|event| event.effect_kind == EffectKind::LifecycleObserve)
        .expect("bounded lifecycle observation transcript");
    assert_eq!(
        lifecycle.authority_id,
        SyntheticAuthorityId::PlatformLifecycle
    );
    assert_eq!(lifecycle.admitted_revision, 2);
    assert_eq!(lifecycle.operation_id, None);
    assert_eq!(lifecycle.result_kind, EffectResultKind::Awake);
}

#[tokio::test]
async fn observation_failure_is_transcript_backed_and_remains_unknown() {
    let mut definition = SimulatedHostScenario::lifecycle_recovery();
    definition.failures.push(InjectedFailure {
        after_effect: None,
        effect: EffectKind::LifecycleObserve,
        kind: InjectedFailureKind::Observation,
        occurrence: 1,
    });
    let scenario = ScenarioRuntime::build(definition).await.unwrap();
    let source: Arc<dyn PlatformLifecycleEventSource> = scenario.host.clone();
    let coordinator = DesktopLifecycleCoordinator::with_platform_source(
        scenario.runtime_host.clone(),
        None,
        source,
    );

    coordinator.reconcile_after_event_gap().await.unwrap();

    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.state, LifecycleAuthorityState::UnknownAfterGap);
    assert_eq!(
        authority.recovery,
        LifecycleRecoveryState::ObservationUnavailable
    );
    let lifecycle = scenario
        .host
        .observation()
        .transcript
        .events
        .into_iter()
        .find(|event| event.effect_kind == EffectKind::LifecycleObserve)
        .expect("failed lifecycle observation transcript");
    assert_eq!(lifecycle.result_kind, EffectResultKind::InjectedFailure);
}

#[test]
fn lifecycle_scenario_and_transcript_schemas_reject_raw_platform_observations() {
    assert!(
        serde_json::from_value::<SimulatedHostScenario>(json!({
            "initialEndpointOwner": "mish",
            "rawPlatformObservation": "private host output"
        }))
        .is_err()
    );

    let scenario =
        mish_simulated_host::SimulatedHost::new(SimulatedHostScenario::lifecycle_recovery())
            .unwrap();
    let encoded = serde_json::to_value(scenario.observation()).unwrap();
    let text = encoded.to_string();
    assert!(!text.contains("private host output"));
    assert!(!text.contains("rawPlatformObservation"));
}
