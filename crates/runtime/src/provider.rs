use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Proxy,
    Rule,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderSourceType {
    File,
    Http,
    Compatible,
    Inline,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderHealth {
    Available,
    Degraded,
    Unavailable,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCapabilityAvailability {
    Supported,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderUpdatePhase {
    Idle,
    Pending,
    Success,
    Failure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderUpdateFailure {
    Conflict,
    Disconnected,
    InconsistentObservation,
    NotFound,
    RuntimeReplaced,
    StaleAuthority,
    Timeout,
    UpdateRejected,
    VersionDrift,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpdateState {
    pub attempted_at: Option<u64>,
    pub failure: Option<ProviderUpdateFailure>,
    pub finished_at: Option<u64>,
    pub phase: ProviderUpdatePhase,
}

impl ProviderUpdateState {
    pub const fn idle() -> Self {
        Self {
            attempted_at: None,
            failure: None,
            finished_at: None,
            phase: ProviderUpdatePhase::Idle,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProvider {
    pub behavior: Option<String>,
    pub healthy_record_count: Option<usize>,
    pub health: ProviderHealth,
    pub id: String,
    pub kind: ProviderKind,
    pub label: String,
    pub record_count: usize,
    pub source_type: ProviderSourceType,
    pub updated_at: Option<String>,
    pub update: ProviderUpdateState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthority {
    pub profile_id: String,
    pub runtime_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub authority: Option<ProviderAuthority>,
    pub capability: ProviderCapabilityAvailability,
    pub observation_failure: Option<ProviderUpdateFailure>,
    pub observed_at: Option<u64>,
    pub providers: Vec<RuntimeProvider>,
    pub remotely_cancellable: bool,
}

impl ProviderSnapshot {
    pub const fn unavailable() -> Self {
        Self {
            authority: None,
            capability: ProviderCapabilityAvailability::Unavailable,
            observation_failure: None,
            observed_at: None,
            providers: Vec::new(),
            remotely_cancellable: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCommandOperation {
    UpdateOne,
    UpdateAll,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandExecution {
    pub failed: Vec<(String, ProviderUpdateFailure)>,
    pub failure: Option<ProviderUpdateFailure>,
    pub operation: ProviderCommandOperation,
    pub succeeded_provider_ids: Vec<String>,
}

impl ProviderCommandExecution {
    pub fn failure(
        operation: ProviderCommandOperation,
        provider_id: Option<String>,
        failure: ProviderUpdateFailure,
    ) -> Self {
        Self {
            failed: provider_id.into_iter().map(|id| (id, failure)).collect(),
            failure: Some(failure),
            operation,
            succeeded_provider_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandFailureItem {
    pub failure: ProviderUpdateFailure,
    pub provider_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCommandPhase {
    Success,
    Partial,
    Failure,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandResult {
    pub failed: Vec<ProviderCommandFailureItem>,
    pub failure: Option<ProviderUpdateFailure>,
    pub operation: ProviderCommandOperation,
    pub phase: ProviderCommandPhase,
    pub snapshot: ProviderSnapshot,
    pub succeeded_provider_ids: Vec<String>,
}

impl ProviderCommandResult {
    pub fn new(execution: ProviderCommandExecution, snapshot: ProviderSnapshot) -> Self {
        let phase = if execution.failure.is_none() && execution.failed.is_empty() {
            ProviderCommandPhase::Success
        } else if execution.succeeded_provider_ids.is_empty() {
            ProviderCommandPhase::Failure
        } else {
            ProviderCommandPhase::Partial
        };
        Self {
            failed: execution
                .failed
                .into_iter()
                .map(|(provider_id, failure)| ProviderCommandFailureItem {
                    failure,
                    provider_id,
                })
                .collect(),
            failure: execution.failure,
            operation: execution.operation,
            phase,
            snapshot,
            succeeded_provider_ids: execution.succeeded_provider_ids,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_partial_success_without_collapsing_provider_failures() {
        let result = ProviderCommandResult::new(
            ProviderCommandExecution {
                failed: vec![("provider-b".into(), ProviderUpdateFailure::UpdateRejected)],
                failure: None,
                operation: ProviderCommandOperation::UpdateAll,
                succeeded_provider_ids: vec!["provider-a".into()],
            },
            ProviderSnapshot::unavailable(),
        );

        assert_eq!(result.phase, ProviderCommandPhase::Partial);
        assert_eq!(result.succeeded_provider_ids, ["provider-a"]);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].provider_id, "provider-b");
        assert_eq!(
            result.failed[0].failure,
            ProviderUpdateFailure::UpdateRejected
        );
    }
}
