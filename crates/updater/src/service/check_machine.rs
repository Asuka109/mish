use super::{
    AvailableCandidate, UpdateCandidateIdentity, UpdateChannel, UpdateOperationError, UpdatePhase,
    UpdateProgress, UpdaterError,
};

pub(super) const DISCOVER_EFFECT_ID: u64 = 1;
pub(super) const COMMIT_AVAILABLE_EFFECT_ID: u64 = 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CheckOperation {
    pub machine_authority: String,
    pub scope_epoch: u64,
    pub operation_id: String,
    pub admitted_revision: u64,
    pub channel: UpdateChannel,
}

impl CheckOperation {
    pub fn correlation(&self, effect_id: u64) -> EffectCorrelation {
        EffectCorrelation {
            machine_authority: self.machine_authority.clone(),
            scope_epoch: self.scope_epoch,
            operation_id: self.operation_id.clone(),
            admitted_revision: self.admitted_revision,
            effect_id,
        }
    }

    fn accepts(&self, correlation: &EffectCorrelation, effect_id: u64) -> bool {
        correlation.machine_authority == self.machine_authority
            && correlation.scope_epoch == self.scope_epoch
            && correlation.operation_id == self.operation_id
            && correlation.admitted_revision == self.admitted_revision
            && correlation.effect_id == effect_id
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct EffectCorrelation {
    pub machine_authority: String,
    pub scope_epoch: u64,
    pub operation_id: String,
    pub admitted_revision: u64,
    pub effect_id: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CheckTaskFailure {
    Aborted,
    CompletionConflict,
    Panicked,
}

impl CheckTaskFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Aborted => "effect-aborted",
            Self::CompletionConflict => "effect-completion-conflict",
            Self::Panicked => "effect-panicked",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CheckFailure {
    Operation(UpdateOperationError),
    Task(CheckTaskFailure),
}

impl CheckFailure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Operation(error) => error.code(),
            Self::Task(error) => error.code(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RetiredTerminal {
    Available { candidate: Box<AvailableCandidate> },
    Cancelled,
    Failed { failure: CheckFailure },
    Stable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CheckState {
    Stable {
        available: Option<(CheckOperation, AvailableCandidate)>,
    },
    Checking {
        operation: CheckOperation,
        cancel_requested: bool,
        shutdown_requested: bool,
    },
    CommittingAvailable {
        operation: CheckOperation,
        candidate: AvailableCandidate,
        shutdown_requested: bool,
    },
    NoUpdate {
        operation: CheckOperation,
        reason: UpdateOperationError,
    },
    Failed {
        operation: CheckOperation,
        failure: CheckFailure,
    },
    Cancelled {
        operation: CheckOperation,
    },
    Retired {
        operation: Option<CheckOperation>,
        terminal: RetiredTerminal,
    },
}

impl CheckState {
    pub fn idle() -> Self {
        Self::Stable { available: None }
    }

    pub fn operation(&self) -> Option<&CheckOperation> {
        match self {
            Self::Stable {
                available: Some((operation, _)),
            }
            | Self::Checking { operation, .. }
            | Self::CommittingAvailable { operation, .. }
            | Self::NoUpdate { operation, .. }
            | Self::Failed { operation, .. }
            | Self::Cancelled { operation }
            | Self::Retired {
                operation: Some(operation),
                ..
            } => Some(operation),
            Self::Stable { available: None }
            | Self::Retired {
                operation: None, ..
            } => None,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Stable { available: Some(_) } => "stable-available",
            Self::Stable { available: None } => "stable-idle",
            Self::Checking {
                cancel_requested: true,
                ..
            } => "checking-cancel-requested",
            Self::Checking { .. } => "checking",
            Self::CommittingAvailable { .. } => "committing-available",
            Self::NoUpdate { .. } => "no-update",
            Self::Failed { .. } => "failed",
            Self::Cancelled { .. } => "cancelled",
            Self::Retired { .. } => "retired",
        }
    }

    pub fn projection(&self) -> CheckProjection {
        match self {
            Self::Stable {
                available: Some((operation, candidate)),
            } => CheckProjection::available(operation, candidate),
            Self::Stable { available: None } => CheckProjection::idle(),
            Self::Checking { operation, .. } | Self::CommittingAvailable { operation, .. } => {
                CheckProjection::checking(operation)
            }
            Self::NoUpdate { operation, reason } => {
                CheckProjection::failed(operation, reason.code())
            }
            Self::Failed { operation, failure } => {
                CheckProjection::failed(operation, failure.code())
            }
            Self::Cancelled { operation } => CheckProjection::cancelled(operation),
            Self::Retired {
                operation,
                terminal,
            } => match terminal {
                RetiredTerminal::Available { candidate } => CheckProjection::available(
                    operation.as_ref().expect("available operation"),
                    candidate,
                ),
                RetiredTerminal::Cancelled => {
                    CheckProjection::cancelled(operation.as_ref().expect("cancelled operation"))
                }
                RetiredTerminal::Failed { failure } => CheckProjection::failed(
                    operation.as_ref().expect("failed operation"),
                    failure.code(),
                ),
                RetiredTerminal::Stable => CheckProjection::idle(),
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CheckProjection {
    pub phase: UpdatePhase,
    pub operation_id: Option<String>,
    pub channel: Option<UpdateChannel>,
    pub candidate: Option<UpdateCandidateIdentity>,
    pub progress: Option<UpdateProgress>,
    pub resumable: bool,
    pub terminal_reason: Option<String>,
}

impl CheckProjection {
    fn idle() -> Self {
        Self {
            phase: UpdatePhase::Idle,
            operation_id: None,
            channel: None,
            candidate: None,
            progress: None,
            resumable: false,
            terminal_reason: None,
        }
    }

    fn checking(operation: &CheckOperation) -> Self {
        Self {
            phase: UpdatePhase::Checking,
            operation_id: Some(operation.operation_id.clone()),
            channel: Some(operation.channel),
            candidate: None,
            progress: None,
            resumable: false,
            terminal_reason: None,
        }
    }

    fn available(operation: &CheckOperation, candidate: &AvailableCandidate) -> Self {
        Self {
            phase: UpdatePhase::Available,
            operation_id: Some(operation.operation_id.clone()),
            channel: Some(operation.channel),
            candidate: Some(candidate.identity()),
            progress: None,
            resumable: false,
            terminal_reason: None,
        }
    }

    fn failed(operation: &CheckOperation, reason: &str) -> Self {
        Self {
            phase: UpdatePhase::Failed,
            operation_id: Some(operation.operation_id.clone()),
            channel: Some(operation.channel),
            candidate: None,
            progress: None,
            resumable: false,
            terminal_reason: Some(reason.to_owned()),
        }
    }

    fn cancelled(operation: &CheckOperation) -> Self {
        Self {
            phase: UpdatePhase::Cancelled,
            operation_id: Some(operation.operation_id.clone()),
            channel: Some(operation.channel),
            candidate: None,
            progress: None,
            resumable: false,
            terminal_reason: Some(UpdateOperationError::Cancelled.code().to_owned()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CheckEffect {
    Discover {
        correlation: EffectCorrelation,
        channel: UpdateChannel,
    },
    CommitAvailable {
        correlation: EffectCorrelation,
        candidate: Box<AvailableCandidate>,
    },
    Cancel {
        correlation: EffectCorrelation,
    },
}

impl CheckEffect {
    pub fn correlation(&self) -> &EffectCorrelation {
        match self {
            Self::Discover { correlation, .. }
            | Self::CommitAvailable { correlation, .. }
            | Self::Cancel { correlation } => correlation,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CheckEffectOutcome {
    Discovery(Result<Box<AvailableCandidate>, UpdateOperationError>),
    Commit(Result<(), UpdateOperationError>),
    TaskFailed(CheckTaskFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CheckCompletion {
    pub correlation: EffectCorrelation,
    pub outcome: CheckEffectOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CheckInput {
    CheckRequested {
        operation: CheckOperation,
        outer_phase: UpdatePhase,
        outer_operation_id: Option<String>,
        outer_channel: Option<UpdateChannel>,
    },
    CancelRequested {
        operation_id: String,
    },
    EffectCompleted(CheckCompletion),
    ShutdownRequested,
}

impl CheckInput {
    pub fn label(&self) -> &'static str {
        match self {
            Self::CheckRequested { .. } => "check-requested",
            Self::CancelRequested { .. } => "cancel-requested",
            Self::EffectCompleted(CheckCompletion {
                outcome: CheckEffectOutcome::Discovery(Ok(_)),
                ..
            }) => "discovery-succeeded",
            Self::EffectCompleted(CheckCompletion {
                outcome: CheckEffectOutcome::Discovery(Err(_)),
                ..
            }) => "discovery-failed",
            Self::EffectCompleted(CheckCompletion {
                outcome: CheckEffectOutcome::Commit(Ok(())),
                ..
            }) => "commit-succeeded",
            Self::EffectCompleted(CheckCompletion {
                outcome: CheckEffectOutcome::Commit(Err(_)),
                ..
            }) => "commit-failed",
            Self::EffectCompleted(CheckCompletion {
                outcome: CheckEffectOutcome::TaskFailed(CheckTaskFailure::Aborted),
                ..
            }) => "effect-aborted",
            Self::EffectCompleted(CheckCompletion {
                outcome: CheckEffectOutcome::TaskFailed(CheckTaskFailure::CompletionConflict),
                ..
            }) => "effect-completion-conflict",
            Self::EffectCompleted(CheckCompletion {
                outcome: CheckEffectOutcome::TaskFailed(CheckTaskFailure::Panicked),
                ..
            }) => "effect-panicked",
            Self::ShutdownRequested => "shutdown-requested",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DecisionDisposition {
    Applied,
    CancelTooLate,
    Duplicate,
    RetiredCompletion,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CheckDecision {
    pub next: CheckState,
    pub effects: Vec<CheckEffect>,
    pub disposition: DecisionDisposition,
}

impl CheckDecision {
    fn applied(next: CheckState, effects: Vec<CheckEffect>) -> Self {
        Self {
            next,
            effects,
            disposition: DecisionDisposition::Applied,
        }
    }

    fn unchanged(state: &CheckState, disposition: DecisionDisposition) -> Self {
        Self {
            next: state.clone(),
            effects: Vec::new(),
            disposition,
        }
    }
}

pub(super) fn reduce(
    state: &CheckState,
    input: CheckInput,
) -> Result<CheckDecision, UpdateOperationError> {
    match input {
        CheckInput::CheckRequested {
            operation,
            outer_phase,
            outer_operation_id,
            outer_channel,
        } => {
            if outer_operation_id.as_deref() == Some(operation.operation_id.as_str())
                && outer_phase != UpdatePhase::Idle
            {
                return if outer_channel == Some(operation.channel) {
                    Ok(CheckDecision::unchanged(
                        state,
                        DecisionDisposition::Duplicate,
                    ))
                } else {
                    Err(UpdateOperationError::OperationMismatch)
                };
            }
            if matches!(
                state,
                CheckState::Checking { .. } | CheckState::CommittingAvailable { .. }
            ) || matches!(
                outer_phase,
                UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Verifying
            ) {
                return Err(UpdateOperationError::Busy);
            }
            let correlation = operation.correlation(DISCOVER_EFFECT_ID);
            Ok(CheckDecision::applied(
                CheckState::Checking {
                    operation: operation.clone(),
                    cancel_requested: false,
                    shutdown_requested: false,
                },
                vec![CheckEffect::Discover {
                    correlation,
                    channel: operation.channel,
                }],
            ))
        }
        CheckInput::CancelRequested { operation_id } => {
            let Some(operation) = state.operation() else {
                return Err(UpdateOperationError::OperationMismatch);
            };
            if operation.operation_id != operation_id {
                return Err(UpdateOperationError::OperationMismatch);
            }
            match state {
                CheckState::Checking {
                    operation,
                    cancel_requested: false,
                    shutdown_requested,
                } => Ok(CheckDecision::applied(
                    CheckState::Checking {
                        operation: operation.clone(),
                        cancel_requested: true,
                        shutdown_requested: *shutdown_requested,
                    },
                    vec![CheckEffect::Cancel {
                        correlation: operation.correlation(DISCOVER_EFFECT_ID),
                    }],
                )),
                CheckState::Checking {
                    cancel_requested: true,
                    ..
                }
                | CheckState::Stable { .. }
                | CheckState::NoUpdate { .. }
                | CheckState::Failed { .. }
                | CheckState::Cancelled { .. }
                | CheckState::Retired { .. } => Ok(CheckDecision::unchanged(
                    state,
                    DecisionDisposition::Duplicate,
                )),
                CheckState::CommittingAvailable { .. } => Ok(CheckDecision::unchanged(
                    state,
                    DecisionDisposition::CancelTooLate,
                )),
            }
        }
        CheckInput::EffectCompleted(completion) => reduce_completion(state, completion),
        CheckInput::ShutdownRequested => match state {
            CheckState::Checking {
                operation,
                cancel_requested,
                ..
            } => {
                let effects = if *cancel_requested {
                    Vec::new()
                } else {
                    vec![CheckEffect::Cancel {
                        correlation: operation.correlation(DISCOVER_EFFECT_ID),
                    }]
                };
                Ok(CheckDecision::applied(
                    CheckState::Checking {
                        operation: operation.clone(),
                        cancel_requested: true,
                        shutdown_requested: true,
                    },
                    effects,
                ))
            }
            CheckState::CommittingAvailable {
                operation,
                candidate,
                ..
            } => Ok(CheckDecision::applied(
                CheckState::CommittingAvailable {
                    operation: operation.clone(),
                    candidate: candidate.clone(),
                    shutdown_requested: true,
                },
                Vec::new(),
            )),
            CheckState::Stable {
                available: Some((operation, candidate)),
            } => Ok(CheckDecision::applied(
                CheckState::Retired {
                    operation: Some(operation.clone()),
                    terminal: RetiredTerminal::Available {
                        candidate: Box::new(candidate.clone()),
                    },
                },
                Vec::new(),
            )),
            CheckState::NoUpdate { operation, reason } => Ok(CheckDecision::applied(
                CheckState::Retired {
                    operation: Some(operation.clone()),
                    terminal: RetiredTerminal::Failed {
                        failure: CheckFailure::Operation(*reason),
                    },
                },
                Vec::new(),
            )),
            CheckState::Failed { operation, failure } => Ok(CheckDecision::applied(
                CheckState::Retired {
                    operation: Some(operation.clone()),
                    terminal: RetiredTerminal::Failed {
                        failure: failure.clone(),
                    },
                },
                Vec::new(),
            )),
            CheckState::Cancelled { operation } => Ok(CheckDecision::applied(
                CheckState::Retired {
                    operation: Some(operation.clone()),
                    terminal: RetiredTerminal::Cancelled,
                },
                Vec::new(),
            )),
            CheckState::Stable { available: None } => Ok(CheckDecision::applied(
                CheckState::Retired {
                    operation: None,
                    terminal: RetiredTerminal::Stable,
                },
                Vec::new(),
            )),
            CheckState::Retired { .. } => Ok(CheckDecision::unchanged(
                state,
                DecisionDisposition::Duplicate,
            )),
        },
    }
}

fn reduce_completion(
    state: &CheckState,
    completion: CheckCompletion,
) -> Result<CheckDecision, UpdateOperationError> {
    match state {
        CheckState::Checking {
            operation,
            cancel_requested,
            shutdown_requested,
        } => {
            if !operation.accepts(&completion.correlation, DISCOVER_EFFECT_ID) {
                return Ok(CheckDecision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            let outcome = completion.outcome;
            if *cancel_requested {
                return Ok(CheckDecision::applied(
                    if *shutdown_requested {
                        CheckState::Retired {
                            operation: Some(operation.clone()),
                            terminal: RetiredTerminal::Cancelled,
                        }
                    } else {
                        CheckState::Cancelled {
                            operation: operation.clone(),
                        }
                    },
                    Vec::new(),
                ));
            }
            if let CheckEffectOutcome::TaskFailed(failure) = outcome {
                return Ok(CheckDecision::applied(
                    CheckState::Failed {
                        operation: operation.clone(),
                        failure: CheckFailure::Task(failure),
                    },
                    Vec::new(),
                ));
            }
            let CheckEffectOutcome::Discovery(result) = outcome else {
                return Ok(CheckDecision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            };
            match result {
                Ok(candidate) => Ok(CheckDecision::applied(
                    CheckState::CommittingAvailable {
                        operation: operation.clone(),
                        candidate: candidate.as_ref().clone(),
                        shutdown_requested: false,
                    },
                    vec![CheckEffect::CommitAvailable {
                        correlation: operation.correlation(COMMIT_AVAILABLE_EFFECT_ID),
                        candidate,
                    }],
                )),
                Err(reason) if is_no_update(reason) => Ok(CheckDecision::applied(
                    CheckState::NoUpdate {
                        operation: operation.clone(),
                        reason,
                    },
                    Vec::new(),
                )),
                Err(reason) => Ok(CheckDecision::applied(
                    CheckState::Failed {
                        operation: operation.clone(),
                        failure: CheckFailure::Operation(reason),
                    },
                    Vec::new(),
                )),
            }
        }
        CheckState::CommittingAvailable {
            operation,
            candidate,
            shutdown_requested,
        } => {
            if !operation.accepts(&completion.correlation, COMMIT_AVAILABLE_EFFECT_ID) {
                return Ok(CheckDecision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            match completion.outcome {
                CheckEffectOutcome::Commit(Ok(())) => Ok(CheckDecision::applied(
                    if *shutdown_requested {
                        CheckState::Retired {
                            operation: Some(operation.clone()),
                            terminal: RetiredTerminal::Available {
                                candidate: Box::new(candidate.clone()),
                            },
                        }
                    } else {
                        CheckState::Stable {
                            available: Some((operation.clone(), candidate.clone())),
                        }
                    },
                    Vec::new(),
                )),
                CheckEffectOutcome::Commit(Err(reason)) => Ok(CheckDecision::applied(
                    if *shutdown_requested {
                        CheckState::Retired {
                            operation: Some(operation.clone()),
                            terminal: RetiredTerminal::Failed {
                                failure: CheckFailure::Operation(reason),
                            },
                        }
                    } else {
                        CheckState::Failed {
                            operation: operation.clone(),
                            failure: CheckFailure::Operation(reason),
                        }
                    },
                    Vec::new(),
                )),
                CheckEffectOutcome::TaskFailed(failure) => Ok(CheckDecision::applied(
                    if *shutdown_requested {
                        CheckState::Retired {
                            operation: Some(operation.clone()),
                            terminal: RetiredTerminal::Failed {
                                failure: CheckFailure::Task(failure),
                            },
                        }
                    } else {
                        CheckState::Failed {
                            operation: operation.clone(),
                            failure: CheckFailure::Task(failure),
                        }
                    },
                    Vec::new(),
                )),
                CheckEffectOutcome::Discovery(_) => Ok(CheckDecision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                )),
            }
        }
        CheckState::Stable { .. }
        | CheckState::NoUpdate { .. }
        | CheckState::Failed { .. }
        | CheckState::Cancelled { .. }
        | CheckState::Retired { .. } => Ok(CheckDecision::unchanged(
            state,
            DecisionDisposition::RetiredCompletion,
        )),
    }
}

fn is_no_update(error: UpdateOperationError) -> bool {
    matches!(
        error,
        UpdateOperationError::Verification(
            UpdaterError::EqualVersionRejected | UpdaterError::MetadataReplay
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation_token(id: &str, scope_epoch: u64, revision: u64) -> CheckOperation {
        CheckOperation {
            machine_authority: "authority-a".into(),
            scope_epoch,
            operation_id: id.into(),
            admitted_revision: revision,
            channel: UpdateChannel::Alpha,
        }
    }

    fn candidate(version: &str) -> AvailableCandidate {
        AvailableCandidate {
            metadata: crate::VerifiedMetadata {
                artifact_name: format!("Mish-{version}.app.tar.gz"),
                artifact_sha256: "a".repeat(64),
                artifact_signature: "signature-material-is-internal".into(),
                artifact_size: 42,
                artifact_url: format!("https://credential@example.invalid/{version}"),
                channel: UpdateChannel::Alpha,
                channel_switch: false,
                metadata_sha256: "b".repeat(64),
                skipped_version: false,
                source_sha: "c".repeat(40),
                version: version.into(),
            },
            metadata_bytes: b"raw metadata body".to_vec(),
            metadata_signature: "metadata signature material".into(),
        }
    }

    fn request(state: &CheckState, operation: CheckOperation) -> CheckDecision {
        reduce(
            state,
            CheckInput::CheckRequested {
                operation,
                outer_phase: UpdatePhase::Idle,
                outer_operation_id: None,
                outer_channel: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn transition_table_has_explicit_commit_and_terminal_states() {
        let operation = operation_token("operation-a", 7, 11);
        let checking = request(&CheckState::idle(), operation.clone()).next;
        assert!(matches!(checking, CheckState::Checking { .. }));

        let committing = reduce(
            &checking,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: operation.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Ok(Box::new(candidate("1.0.1-alpha.1")))),
            }),
        )
        .unwrap();
        assert!(matches!(
            committing.next,
            CheckState::CommittingAvailable { .. }
        ));
        assert!(matches!(
            committing.effects.as_slice(),
            [CheckEffect::CommitAvailable { .. }]
        ));

        let available = reduce(
            &committing.next,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: operation.correlation(COMMIT_AVAILABLE_EFFECT_ID),
                outcome: CheckEffectOutcome::Commit(Ok(())),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(
            available,
            CheckState::Stable { available: Some(_) }
        ));

        let no_update_operation = operation_token("operation-b", 8, 13);
        let checking = request(&available, no_update_operation.clone()).next;
        let no_update = reduce(
            &checking,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: no_update_operation.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Err(UpdateOperationError::Verification(
                    UpdaterError::EqualVersionRejected,
                ))),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(no_update, CheckState::NoUpdate { .. }));
        assert_eq!(no_update.projection().phase, UpdatePhase::Failed);
        assert_eq!(
            no_update.projection().terminal_reason.as_deref(),
            Some("equal-version-rejected")
        );
    }

    #[test]
    fn cancellation_linearizes_before_discovery_but_is_too_late_after_commit_point() {
        let operation = operation_token("operation-a", 1, 1);
        let checking = request(&CheckState::idle(), operation.clone()).next;
        let cancelling = reduce(
            &checking,
            CheckInput::CancelRequested {
                operation_id: operation.operation_id.clone(),
            },
        )
        .unwrap();
        assert!(matches!(
            cancelling.effects.as_slice(),
            [CheckEffect::Cancel { .. }]
        ));
        let cancelled = reduce(
            &cancelling.next,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: operation.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Ok(Box::new(candidate("1.0.1-alpha.1")))),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(cancelled, CheckState::Cancelled { .. }));

        let operation = operation_token("operation-b", 2, 3);
        let checking = request(&cancelled, operation.clone()).next;
        let committing = reduce(
            &checking,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: operation.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Ok(Box::new(candidate("1.0.1-alpha.2")))),
            }),
        )
        .unwrap()
        .next;
        let cancellation = reduce(
            &committing,
            CheckInput::CancelRequested {
                operation_id: operation.operation_id.clone(),
            },
        )
        .unwrap();
        assert_eq!(cancellation.disposition, DecisionDisposition::CancelTooLate);
        assert_eq!(cancellation.next, committing);
    }

    #[test]
    fn duplicate_and_competing_commands_have_deterministic_admission() {
        let operation = operation_token("operation-a", 1, 1);
        let checking = request(&CheckState::idle(), operation.clone()).next;
        let duplicate = reduce(
            &checking,
            CheckInput::CheckRequested {
                operation: operation.clone(),
                outer_phase: UpdatePhase::Checking,
                outer_operation_id: Some(operation.operation_id.clone()),
                outer_channel: Some(operation.channel),
            },
        )
        .unwrap();
        assert_eq!(duplicate.disposition, DecisionDisposition::Duplicate);
        assert_eq!(duplicate.next, checking);

        let mut wrong_channel = operation.clone();
        wrong_channel.channel = UpdateChannel::Stable;
        assert_eq!(
            reduce(
                &checking,
                CheckInput::CheckRequested {
                    operation: wrong_channel,
                    outer_phase: UpdatePhase::Checking,
                    outer_operation_id: Some(operation.operation_id.clone()),
                    outer_channel: Some(operation.channel),
                },
            ),
            Err(UpdateOperationError::OperationMismatch)
        );

        assert_eq!(
            reduce(
                &checking,
                CheckInput::CheckRequested {
                    operation: operation_token("operation-b", 2, 3),
                    outer_phase: UpdatePhase::Checking,
                    outer_operation_id: Some(operation.operation_id),
                    outer_channel: Some(operation.channel),
                },
            ),
            Err(UpdateOperationError::Busy)
        );
    }

    #[test]
    fn every_correlation_mismatch_and_equal_revision_conflict_is_retired_unchanged() {
        let operation = operation_token("operation-a", 4, 9);
        let checking = request(&CheckState::idle(), operation.clone()).next;
        let mut mismatches = Vec::new();
        let mut correlation = operation.correlation(DISCOVER_EFFECT_ID);
        correlation.machine_authority = "other-authority".into();
        mismatches.push(correlation);
        let mut correlation = operation.correlation(DISCOVER_EFFECT_ID);
        correlation.scope_epoch += 1;
        mismatches.push(correlation);
        let mut correlation = operation.correlation(DISCOVER_EFFECT_ID);
        correlation.operation_id = "other-operation".into();
        mismatches.push(correlation);
        let mut correlation = operation.correlation(DISCOVER_EFFECT_ID);
        correlation.admitted_revision += 1;
        mismatches.push(correlation);
        let mut correlation = operation.correlation(DISCOVER_EFFECT_ID);
        correlation.effect_id += 1;
        mismatches.push(correlation);

        for correlation in mismatches {
            let decision = reduce(
                &checking,
                CheckInput::EffectCompleted(CheckCompletion {
                    correlation,
                    outcome: CheckEffectOutcome::Discovery(Ok(Box::new(candidate(
                        "1.0.1-alpha.1",
                    )))),
                }),
            )
            .unwrap();
            assert_eq!(decision.disposition, DecisionDisposition::RetiredCompletion);
            assert_eq!(decision.next, checking);
        }

        let committing = reduce(
            &checking,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: operation.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Ok(Box::new(candidate("1.0.1-alpha.1")))),
            }),
        )
        .unwrap()
        .next;
        let conflicting_equal_revision = reduce(
            &committing,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: operation.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Ok(Box::new(candidate("9.9.9-alpha.9")))),
            }),
        )
        .unwrap();
        assert_eq!(
            conflicting_equal_revision.disposition,
            DecisionDisposition::RetiredCompletion
        );
        assert_eq!(conflicting_equal_revision.next, committing);
    }

    #[test]
    fn task_failures_and_shutdown_have_deterministic_final_states() {
        for failure in [
            CheckTaskFailure::Panicked,
            CheckTaskFailure::Aborted,
            CheckTaskFailure::CompletionConflict,
        ] {
            let operation = operation_token(failure.code(), 1, 1);
            let checking = request(&CheckState::idle(), operation.clone()).next;
            let terminal = reduce(
                &checking,
                CheckInput::EffectCompleted(CheckCompletion {
                    correlation: operation.correlation(DISCOVER_EFFECT_ID),
                    outcome: CheckEffectOutcome::TaskFailed(failure),
                }),
            )
            .unwrap()
            .next;
            assert_eq!(
                terminal.projection().terminal_reason.as_deref(),
                Some(failure.code())
            );
        }

        let timeout_operation = operation_token("timeout", 2, 3);
        let checking = request(&CheckState::idle(), timeout_operation.clone()).next;
        let timeout = reduce(
            &checking,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: timeout_operation.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Err(UpdateOperationError::Timeout)),
            }),
        )
        .unwrap()
        .next;
        assert_eq!(
            timeout.projection().terminal_reason.as_deref(),
            Some("timeout")
        );

        let checking = request(&timeout, operation_token("shutdown", 3, 5)).next;
        let shutdown = reduce(&checking, CheckInput::ShutdownRequested)
            .unwrap()
            .next;
        let next = shutdown.operation().unwrap().clone();
        let retired = reduce(
            &shutdown,
            CheckInput::EffectCompleted(CheckCompletion {
                correlation: next.correlation(DISCOVER_EFFECT_ID),
                outcome: CheckEffectOutcome::Discovery(Err(UpdateOperationError::Cancelled)),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(
            retired,
            CheckState::Retired {
                terminal: RetiredTerminal::Cancelled,
                ..
            }
        ));
    }

    #[test]
    fn bounded_model_sequences_never_project_illegal_public_combinations() {
        let mut states = vec![CheckState::idle()];
        for sequence in 0..6_u64 {
            let mut next_states = Vec::new();
            for state in &states {
                let operation = operation_token(
                    &format!("model-{sequence}"),
                    sequence + 1,
                    sequence.saturating_mul(2).saturating_add(1),
                );
                let inputs = [
                    CheckInput::CancelRequested {
                        operation_id: operation.operation_id.clone(),
                    },
                    CheckInput::ShutdownRequested,
                    CheckInput::EffectCompleted(CheckCompletion {
                        correlation: operation.correlation(DISCOVER_EFFECT_ID),
                        outcome: CheckEffectOutcome::Discovery(Err(UpdateOperationError::Timeout)),
                    }),
                ];
                for input in inputs {
                    if let Ok(decision) = reduce(state, input) {
                        assert_projection_invariant(&decision.next.projection());
                        next_states.push(decision.next);
                    }
                }
                if let Ok(decision) = reduce(
                    state,
                    CheckInput::CheckRequested {
                        operation,
                        outer_phase: UpdatePhase::Idle,
                        outer_operation_id: None,
                        outer_channel: None,
                    },
                ) {
                    assert_projection_invariant(&decision.next.projection());
                    next_states.push(decision.next);
                }
            }
            states.extend(next_states);
            states.truncate(512);
        }
    }

    fn assert_projection_invariant(projection: &CheckProjection) {
        match projection.phase {
            UpdatePhase::Idle => {
                assert!(projection.operation_id.is_none());
                assert!(projection.channel.is_none());
                assert!(projection.candidate.is_none());
                assert!(projection.terminal_reason.is_none());
            }
            UpdatePhase::Checking => {
                assert!(projection.operation_id.is_some());
                assert!(projection.channel.is_some());
                assert!(projection.candidate.is_none());
                assert!(projection.terminal_reason.is_none());
            }
            UpdatePhase::Available => {
                assert!(projection.operation_id.is_some());
                assert!(projection.channel.is_some());
                assert!(projection.candidate.is_some());
                assert!(projection.terminal_reason.is_none());
            }
            UpdatePhase::Failed | UpdatePhase::Cancelled => {
                assert!(projection.operation_id.is_some());
                assert!(projection.channel.is_some());
                assert!(projection.candidate.is_none());
                assert!(projection.terminal_reason.is_some());
            }
            UpdatePhase::Downloading | UpdatePhase::Verifying | UpdatePhase::Ready => {
                panic!("Check projection may not manufacture download-owned phases")
            }
        }
        assert!(projection.progress.is_none());
        assert!(!projection.resumable);
    }
}
