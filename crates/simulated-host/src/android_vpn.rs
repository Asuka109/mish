//! Android VPN lifecycle scenarios backed by the production Rust reducer.
//!
//! This module is a test-only projection: it does not own a second lifecycle
//! or emulate Kotlin. The feature simply exposes the closed transcript replay
//! supplied by `tauri-plugin-mish-vpn` so the repository SimulatedHost gate can
//! run the same deterministic matrix as the mobile authority.

pub use tauri_plugin_mish_vpn::simulated_host::{
    EffectKind, ResultKind, Scenario, Transcript, TranscriptEvent, run,
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
        ] {
            let transcript = run(scenario);
            assert_eq!(transcript.schema_version, 1);
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
}
