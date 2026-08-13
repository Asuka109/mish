//! Closed Android Route-selection scenarios backed by the production Shared
//! Rust transcript schema. This feature is test-only and contains no adapter,
//! loopback bridge, network endpoint, config byte, or credential.

pub use tauri_plugin_mish_vpn::simulated_routes::{
    Event, ResultKind, Scenario, TRANSCRIPT_LIMIT, Transcript, run,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_route_matrix_preserves_zero_mutation_failures_and_full_baselines() {
        for scenario in [
            Scenario::Success,
            Scenario::Duplicate,
            Scenario::InvalidRelation,
            Scenario::Replacement,
            Scenario::Cancellation,
            Scenario::MalformedResponse,
            Scenario::Ordering,
            Scenario::Recreation,
            Scenario::DelayedStaleCommand,
        ] {
            let transcript = run(scenario);
            assert!(transcript.full_baseline);
            assert!(!transcript.events.is_empty());
            assert!(transcript.events.len() <= TRANSCRIPT_LIMIT);
            assert_eq!(
                Transcript::parse(&serde_json::to_string(&transcript).unwrap()),
                Ok(transcript)
            );
        }

        for scenario in [
            Scenario::InvalidRelation,
            Scenario::Replacement,
            Scenario::Cancellation,
            Scenario::MalformedResponse,
            Scenario::Recreation,
            Scenario::DelayedStaleCommand,
        ] {
            assert_eq!(run(scenario).mutation_count, 0, "{scenario:?}");
        }
        assert_eq!(run(Scenario::Duplicate).mutation_count, 1);
        assert_eq!(
            run(Scenario::Duplicate)
                .events
                .iter()
                .filter(|event| event.result == ResultKind::Duplicate)
                .count(),
            1,
        );
        assert_eq!(
            run(Scenario::Success)
                .events
                .iter()
                .map(|event| (event.result, event.mutation_count, event.snapshot_order))
                .collect::<Vec<_>>(),
            vec![
                (ResultKind::Snapshot, 0, 1),
                (ResultKind::Admitted, 0, 1),
                (ResultKind::Applied, 1, 2),
            ]
        );
        let replacement = run(Scenario::DelayedStaleCommand);
        assert_eq!(replacement.events[1].runtime_authority, 2);
        assert_eq!(replacement.events[1].profile_revision, 2);
        assert_eq!(replacement.events[2].result, ResultKind::Retired);
        let recreation = run(Scenario::Recreation);
        assert_eq!(
            recreation.events[0].runtime_authority,
            recreation.events[1].runtime_authority
        );
        assert_eq!(recreation.events[1].snapshot_order, 2);
    }

    #[test]
    fn transcript_rejects_unknown_fields_overflow_and_non_monotonic_time() {
        let transcript = run(Scenario::Success);
        let encoded = serde_json::to_string(&transcript).unwrap();
        for forbidden in [
            "Alpha",
            "Beta",
            ".invalid",
            "profile-a",
            "runtime-a",
            "operation-2",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "{forbidden} entered transcript"
            );
        }
        assert!(Transcript::parse(&encoded.replacen("{", r#"{"secret":"redacted","#, 1)).is_err());

        let mut value = serde_json::to_value(&transcript).unwrap();
        value["events"] =
            serde_json::Value::Array(vec![value["events"][0].clone(); TRANSCRIPT_LIMIT + 1]);
        assert!(Transcript::parse(&value.to_string()).is_err());

        let mut invalid_time = serde_json::to_value(&transcript).unwrap();
        invalid_time["events"][0]["logicalTime"] = serde_json::json!(2);
        assert!(Transcript::parse(&invalid_time.to_string()).is_err());

        let mut mutation_regression = serde_json::to_value(run(Scenario::Duplicate)).unwrap();
        mutation_regression["events"][2]["mutationCount"] = serde_json::json!(0);
        assert!(Transcript::parse(&mutation_regression.to_string()).is_err());
    }
}
