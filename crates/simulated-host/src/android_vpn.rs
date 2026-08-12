//! Android VPN lifecycle scenarios backed by the production Rust reducer.
//!
//! This module is a test-only projection: it does not own a second lifecycle
//! or emulate Kotlin. The feature simply exposes the closed transcript replay
//! supplied by `tauri-plugin-mish-vpn` so the repository SimulatedHost gate can
//! run the same deterministic matrix as the mobile authority.

pub use tauri_plugin_mish_vpn::simulated_host::{
    EffectKind, ResultKind, Scenario, TRANSCRIPT_LIMIT, Transcript, TranscriptEvent, run,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_android_matrix_replays_the_real_rust_authority() {
        for scenario in [
            Scenario::Success,
            Scenario::Failure,
            Scenario::Timeout,
            Scenario::Cancellation,
            Scenario::Replacement,
            Scenario::LateCompletion,
            Scenario::CleanupRetry,
            Scenario::FinalizerBarrier,
            Scenario::Recreation,
            Scenario::AdmissionRejected,
        ] {
            let transcript = run(scenario);
            assert_eq!(transcript.schema_version, 2);
            assert!(!transcript.events.is_empty());
            assert!(transcript.events.len() <= 32);
            assert!(
                transcript
                    .events
                    .iter()
                    .all(|event| event.authority_id == 1 && event.runtime_id == 1)
            );
        }
    }

    #[test]
    fn cleanup_retry_finishes_only_after_the_retry_barrier() {
        let transcript = run(Scenario::CleanupRetry);
        assert!(transcript.stopped_clean);
        assert_eq!(
            transcript.final_outcome,
            Some(tauri_plugin_mish_vpn::LifecycleOperationOutcome::Completed)
        );
        assert!(transcript.events.iter().any(|event| {
            event.effect == EffectKind::Stop && event.result == ResultKind::Failed
        }));
        assert!(transcript.events.iter().any(|event| {
            event.effect == EffectKind::Stop && event.result == ResultKind::Applied
        }));
    }

    #[test]
    fn stale_replacement_and_late_completion_are_retired() {
        assert!(run(Scenario::Replacement).stale_completion_retired);
        assert!(run(Scenario::LateCompletion).stale_completion_retired);
    }

    #[test]
    fn finalizer_and_recreation_reach_clean_only_after_the_observation_barrier() {
        for scenario in [Scenario::FinalizerBarrier, Scenario::Recreation] {
            let transcript = run(scenario);
            assert!(transcript.stopped_clean);
            assert_eq!(
                transcript.final_outcome,
                Some(tauri_plugin_mish_vpn::LifecycleOperationOutcome::Completed)
            );
            let stop = transcript
                .events
                .iter()
                .position(|event| event.effect == EffectKind::Stop)
                .expect("stop result event");
            let callback = transcript
                .events
                .iter()
                .position(|event| event.effect == EffectKind::Callback)
                .expect("cleanup callback event");
            assert!(stop < callback);
        }
    }

    #[test]
    fn admission_rejection_runs_before_any_platform_effect() {
        let transcript = run(Scenario::AdmissionRejected);
        assert_eq!(transcript.events.len(), 1);
        assert_eq!(transcript.events[0].effect, EffectKind::Admission);
        assert_eq!(transcript.events[0].result, ResultKind::Rejected);
        assert_eq!(
            transcript.final_outcome,
            Some(tauri_plugin_mish_vpn::LifecycleOperationOutcome::Rejected)
        );
    }

    #[test]
    fn transcript_schema_rejects_unknown_fields_and_overflow() {
        let transcript = run(Scenario::Cancellation);
        let encoded = serde_json::to_string(&transcript).expect("serialize transcript");
        assert_eq!(Transcript::parse(&encoded), Ok(transcript.clone()));

        let unknown = encoded.replacen("{", r#"{"futureField":true,"#, 1);
        assert!(Transcript::parse(&unknown).is_err());

        let mut value = serde_json::to_value(&transcript).expect("transcript value");
        let first = value["events"][0].clone();
        value["events"] = serde_json::Value::Array(vec![first; TRANSCRIPT_LIMIT + 1]);
        assert!(Transcript::parse(&value.to_string()).is_err());

        let mut invalid_time = serde_json::to_value(&transcript).expect("transcript value");
        invalid_time["events"][0]["logicalTime"] = serde_json::json!(2);
        assert!(Transcript::parse(&invalid_time.to_string()).is_err());
    }
}
