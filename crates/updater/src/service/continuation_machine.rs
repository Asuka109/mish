use super::{
    AvailableCandidate, PartialInfo, UpdateCandidateIdentity, UpdateChannel, UpdateOperationError,
    UpdatePhase, UpdateProgress, UpdaterSnapshot,
};
use mish_state_machine::{
    CorrelatedEffect, Correlation, EffectBatch, EffectMode, Machine, TaskFailure, Transition,
};

pub(super) const DOWNLOAD_EFFECT_ID: u64 = 1;
pub(super) const VERIFY_EFFECT_ID: u64 = 2;
pub(super) const COMMIT_CANDIDATE_EFFECT_ID: u64 = 3;
pub(super) const FINALIZE_EFFECT_ID: u64 = 4;
pub(super) const REVERIFY_EFFECT_ID: u64 = 5;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ContinuationOperation {
    pub machine_authority: String,
    pub scope_epoch: u64,
    pub operation_id: String,
    pub admitted_revision: u64,
    pub candidate: AvailableCandidate,
}

impl ContinuationOperation {
    pub fn correlation(&self, effect_id: u64, progress_sequence: u64) -> EffectCorrelation {
        EffectCorrelation {
            machine: Correlation {
                machine_authority: self.machine_authority.clone(),
                scope_epoch: self.scope_epoch,
                operation_id: self.operation_id.clone(),
                admitted_revision: self.admitted_revision,
                effect_id,
            },
            progress_sequence,
        }
    }

    fn accepts(&self, correlation: &EffectCorrelation, effect_id: u64) -> bool {
        correlation.machine.machine_authority == self.machine_authority
            && correlation.machine.scope_epoch == self.scope_epoch
            && correlation.machine.operation_id == self.operation_id
            && correlation.machine.admitted_revision == self.admitted_revision
            && correlation.machine.effect_id == effect_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct EffectCorrelation {
    pub machine: Correlation,
    pub progress_sequence: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ContinuationTaskFailure {
    Aborted,
    CompletionConflict,
    Panicked,
}

impl ContinuationTaskFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Aborted => "effect-aborted",
            Self::CompletionConflict => "effect-completion-conflict",
            Self::Panicked => "effect-panicked",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct MachineProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub sequence: u64,
}

impl MachineProgress {
    fn public(&self) -> UpdateProgress {
        UpdateProgress {
            downloaded_bytes: self.downloaded_bytes,
            total_bytes: self.total_bytes,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RecoveryKind {
    CandidateCommit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum FinalizingStage {
    Downloading,
    Verifying,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum FinalizingTerminal {
    Cancelled,
    Failed { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RetiredTerminal {
    Cancelled { resumable: bool },
    Failed { reason: String, resumable: bool },
    Ready,
    RecoveryRequired { reason: String },
    Stable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ContinuationState {
    Stable,
    Downloading {
        operation: ContinuationOperation,
        progress: MachineProgress,
        cancel_requested: bool,
        shutdown_requested: bool,
    },
    Verifying {
        operation: ContinuationOperation,
        progress: MachineProgress,
        cancel_requested: bool,
        shutdown_requested: bool,
    },
    CommittingCandidate {
        operation: ContinuationOperation,
        progress: MachineProgress,
        shutdown_requested: bool,
    },
    Finalizing {
        operation: ContinuationOperation,
        progress: MachineProgress,
        stage: FinalizingStage,
        terminal: FinalizingTerminal,
        discard_partial: bool,
        shutdown_requested: bool,
    },
    Ready {
        operation: ContinuationOperation,
        progress: MachineProgress,
    },
    Interrupted {
        operation: ContinuationOperation,
        progress: MachineProgress,
        resumable: bool,
    },
    Failed {
        operation: ContinuationOperation,
        progress: MachineProgress,
        reason: String,
        resumable: bool,
    },
    Cancelled {
        operation: ContinuationOperation,
        progress: MachineProgress,
        resumable: bool,
    },
    RecoveryRequired {
        operation: ContinuationOperation,
        progress: MachineProgress,
        kind: RecoveryKind,
        reason: String,
    },
    Recovering {
        operation: ContinuationOperation,
        progress: MachineProgress,
        kind: RecoveryKind,
    },
    Retired {
        operation: Option<ContinuationOperation>,
        progress: Option<MachineProgress>,
        terminal: RetiredTerminal,
    },
}

impl ContinuationState {
    pub fn stable() -> Self {
        Self::Stable
    }

    pub fn interrupted(
        operation: ContinuationOperation,
        progress: MachineProgress,
        resumable: bool,
    ) -> Self {
        Self::Interrupted {
            operation,
            progress,
            resumable,
        }
    }

    pub fn recovery_required(operation: ContinuationOperation, progress: MachineProgress) -> Self {
        Self::RecoveryRequired {
            operation,
            progress,
            kind: RecoveryKind::CandidateCommit,
            reason: "recovery-required".into(),
        }
    }

    pub fn operation(&self) -> Option<&ContinuationOperation> {
        match self {
            Self::Downloading { operation, .. }
            | Self::Verifying { operation, .. }
            | Self::CommittingCandidate { operation, .. }
            | Self::Finalizing { operation, .. }
            | Self::Ready { operation, .. }
            | Self::Interrupted { operation, .. }
            | Self::Failed { operation, .. }
            | Self::Cancelled { operation, .. }
            | Self::RecoveryRequired { operation, .. }
            | Self::Recovering { operation, .. }
            | Self::Retired {
                operation: Some(operation),
                ..
            } => Some(operation),
            Self::Stable
            | Self::Retired {
                operation: None, ..
            } => None,
        }
    }

    pub fn progress(&self) -> Option<&MachineProgress> {
        match self {
            Self::Downloading { progress, .. }
            | Self::Verifying { progress, .. }
            | Self::CommittingCandidate { progress, .. }
            | Self::Finalizing { progress, .. }
            | Self::Ready { progress, .. }
            | Self::Interrupted { progress, .. }
            | Self::Failed { progress, .. }
            | Self::Cancelled { progress, .. }
            | Self::RecoveryRequired { progress, .. }
            | Self::Recovering { progress, .. } => Some(progress),
            Self::Retired { progress, .. } => progress.as_ref(),
            Self::Stable => None,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Downloading {
                cancel_requested: true,
                ..
            } => "downloading-cancel-requested",
            Self::Downloading { .. } => "downloading",
            Self::Verifying {
                cancel_requested: true,
                ..
            } => "verifying-cancel-requested",
            Self::Verifying { .. } => "verifying",
            Self::CommittingCandidate { .. } => "committing-candidate",
            Self::Finalizing { .. } => "finalizing",
            Self::Ready { .. } => "ready",
            Self::Interrupted { .. } => "interrupted",
            Self::Failed { .. } => "failed",
            Self::Cancelled { .. } => "cancelled",
            Self::RecoveryRequired { .. } => "recovery-required",
            Self::Recovering { .. } => "recovering",
            Self::Retired { .. } => "retired",
        }
    }

    pub fn projection(&self) -> Option<ContinuationProjection> {
        let operation = self.operation()?;
        let progress = self.progress().map(MachineProgress::public);
        let base = || ContinuationProjection {
            operation_id: operation.operation_id.clone(),
            channel: operation.candidate.metadata.channel,
            candidate: operation.candidate.identity(),
            progress: progress.clone(),
            phase: UpdatePhase::Failed,
            resumable: false,
            terminal_reason: None,
        };
        let mut projection = base();
        match self {
            Self::Downloading { .. } => projection.phase = UpdatePhase::Downloading,
            Self::Verifying { .. } | Self::CommittingCandidate { .. } | Self::Recovering { .. } => {
                projection.phase = UpdatePhase::Verifying
            }
            Self::Finalizing { stage, .. } => {
                projection.phase = match stage {
                    FinalizingStage::Downloading => UpdatePhase::Downloading,
                    FinalizingStage::Verifying => UpdatePhase::Verifying,
                }
            }
            Self::Ready { .. }
            | Self::Retired {
                terminal: RetiredTerminal::Ready,
                ..
            } => projection.phase = UpdatePhase::Ready,
            Self::Interrupted { resumable, .. } => {
                projection.resumable = *resumable;
                projection.terminal_reason = Some("interrupted".into());
            }
            Self::Failed {
                reason, resumable, ..
            } => {
                projection.resumable = *resumable;
                projection.terminal_reason = Some(reason.clone());
            }
            Self::Cancelled { resumable, .. }
            | Self::Retired {
                terminal: RetiredTerminal::Cancelled { resumable },
                ..
            } => {
                projection.phase = UpdatePhase::Cancelled;
                projection.resumable = *resumable;
                projection.terminal_reason = Some("cancelled".into());
            }
            Self::RecoveryRequired { reason, .. }
            | Self::Retired {
                terminal: RetiredTerminal::RecoveryRequired { reason },
                ..
            } => projection.terminal_reason = Some(reason.clone()),
            Self::Retired {
                terminal: RetiredTerminal::Failed { reason, resumable },
                ..
            } => {
                projection.resumable = *resumable;
                projection.terminal_reason = Some(reason.clone());
            }
            Self::Retired {
                terminal: RetiredTerminal::Stable,
                ..
            }
            | Self::Stable => return None,
        }
        Some(projection)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ContinuationProjection {
    pub phase: UpdatePhase,
    pub operation_id: String,
    pub channel: UpdateChannel,
    pub candidate: UpdateCandidateIdentity,
    pub progress: Option<UpdateProgress>,
    pub resumable: bool,
    pub terminal_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ContinuationEffect {
    Download {
        correlation: EffectCorrelation,
        candidate: Box<AvailableCandidate>,
    },
    Verify {
        correlation: EffectCorrelation,
        candidate: Box<AvailableCandidate>,
    },
    CommitCandidate {
        correlation: EffectCorrelation,
        candidate: Box<AvailableCandidate>,
    },
    FinalizeFailure {
        correlation: EffectCorrelation,
        candidate: Box<AvailableCandidate>,
        discard_partial: bool,
    },
    ReverifyCandidate {
        correlation: EffectCorrelation,
        candidate: Box<AvailableCandidate>,
    },
    Cancel {
        correlation: EffectCorrelation,
    },
}

impl ContinuationEffect {
    pub fn correlation(&self) -> &EffectCorrelation {
        match self {
            Self::Download { correlation, .. }
            | Self::Verify { correlation, .. }
            | Self::CommitCandidate { correlation, .. }
            | Self::FinalizeFailure { correlation, .. }
            | Self::ReverifyCandidate { correlation, .. }
            | Self::Cancel { correlation } => correlation,
        }
    }
}

impl CorrelatedEffect for ContinuationEffect {
    fn correlation(&self) -> &Correlation {
        &self.correlation().machine
    }

    fn mode(&self) -> EffectMode {
        if matches!(self, Self::Cancel { .. }) {
            EffectMode::Cancel
        } else {
            EffectMode::Spawn
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ContinuationEffectOutcome {
    Download(Result<(), UpdateOperationError>),
    Verify(Result<(), UpdateOperationError>),
    Commit(Result<(), UpdateOperationError>),
    Finalize(Result<PartialInfo, UpdateOperationError>),
    Recovery(Result<(), UpdateOperationError>),
    TaskFailed(ContinuationTaskFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ContinuationCompletion {
    pub correlation: EffectCorrelation,
    pub outcome: ContinuationEffectOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ContinuationInput {
    DownloadRequested {
        operation: Box<ContinuationOperation>,
        outer: Box<UpdaterSnapshot>,
        resumed_bytes: u64,
    },
    PartialCommitted {
        correlation: EffectCorrelation,
        downloaded_bytes: u64,
    },
    CancelRequested {
        operation_id: String,
    },
    RecoverRequested,
    EffectCompleted(ContinuationCompletion),
    ShutdownRequested,
}

impl ContinuationInput {
    pub fn label(&self) -> &'static str {
        match self {
            Self::DownloadRequested { .. } => "download-requested",
            Self::PartialCommitted { .. } => "partial-committed",
            Self::CancelRequested { .. } => "cancel-requested",
            Self::RecoverRequested => "recover-requested",
            Self::EffectCompleted(ContinuationCompletion { outcome, .. }) => match outcome {
                ContinuationEffectOutcome::Download(Ok(())) => "download-succeeded",
                ContinuationEffectOutcome::Download(Err(_)) => "download-failed",
                ContinuationEffectOutcome::Verify(Ok(())) => "verification-succeeded",
                ContinuationEffectOutcome::Verify(Err(_)) => "verification-failed",
                ContinuationEffectOutcome::Commit(Ok(())) => "candidate-commit-succeeded",
                ContinuationEffectOutcome::Commit(Err(_)) => "candidate-commit-unknown",
                ContinuationEffectOutcome::Finalize(Ok(_)) => "finalization-succeeded",
                ContinuationEffectOutcome::Finalize(Err(_)) => "finalization-failed",
                ContinuationEffectOutcome::Recovery(Ok(())) => "reverification-succeeded",
                ContinuationEffectOutcome::Recovery(Err(_)) => "reverification-failed",
                ContinuationEffectOutcome::TaskFailed(ContinuationTaskFailure::Aborted) => {
                    "effect-aborted"
                }
                ContinuationEffectOutcome::TaskFailed(
                    ContinuationTaskFailure::CompletionConflict,
                ) => "effect-completion-conflict",
                ContinuationEffectOutcome::TaskFailed(ContinuationTaskFailure::Panicked) => {
                    "effect-panicked"
                }
            },
            Self::ShutdownRequested => "shutdown-requested",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DecisionDisposition {
    Applied,
    CancelTooLate,
    Duplicate,
    RetiredCompletion,
}

struct Decision {
    next: ContinuationState,
    effects: Vec<ContinuationEffect>,
    disposition: DecisionDisposition,
}

impl Decision {
    fn applied(next: ContinuationState, effects: Vec<ContinuationEffect>) -> Self {
        Self {
            next,
            effects,
            disposition: DecisionDisposition::Applied,
        }
    }

    fn unchanged(state: &ContinuationState, disposition: DecisionDisposition) -> Self {
        Self {
            next: state.clone(),
            effects: Vec::new(),
            disposition,
        }
    }
}

fn reduce(
    state: &ContinuationState,
    input: ContinuationInput,
) -> Result<Decision, UpdateOperationError> {
    match input {
        ContinuationInput::DownloadRequested {
            operation,
            outer,
            resumed_bytes,
        } => {
            let operation = *operation;
            if outer.operation_id.as_deref() != Some(operation.operation_id.as_str())
                || outer.candidate.as_ref() != Some(&operation.candidate.identity())
            {
                return Err(UpdateOperationError::OperationMismatch);
            }
            if matches!(
                outer.phase,
                UpdatePhase::Downloading | UpdatePhase::Verifying | UpdatePhase::Ready
            ) {
                return Ok(Decision::unchanged(state, DecisionDisposition::Duplicate));
            }
            if !matches!(
                outer.phase,
                UpdatePhase::Available | UpdatePhase::Cancelled | UpdatePhase::Failed
            ) || matches!(
                state,
                ContinuationState::Downloading { .. }
                    | ContinuationState::Verifying { .. }
                    | ContinuationState::CommittingCandidate { .. }
                    | ContinuationState::Finalizing { .. }
                    | ContinuationState::Recovering { .. }
            ) {
                return Err(UpdateOperationError::Busy);
            }
            let progress = MachineProgress {
                downloaded_bytes: resumed_bytes.min(operation.candidate.metadata.artifact_size),
                total_bytes: operation.candidate.metadata.artifact_size,
                sequence: 0,
            };
            let effect = ContinuationEffect::Download {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, progress.sequence),
                candidate: Box::new(operation.candidate.clone()),
            };
            Ok(Decision::applied(
                ContinuationState::Downloading {
                    operation,
                    progress,
                    cancel_requested: false,
                    shutdown_requested: false,
                },
                vec![effect],
            ))
        }
        ContinuationInput::PartialCommitted {
            correlation,
            downloaded_bytes,
        } => {
            let ContinuationState::Downloading {
                operation,
                progress,
                cancel_requested,
                shutdown_requested,
            } = state
            else {
                return Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            };
            if !operation.accepts(&correlation, DOWNLOAD_EFFECT_ID)
                || correlation.progress_sequence != progress.sequence.saturating_add(1)
                || downloaded_bytes < progress.downloaded_bytes
                || downloaded_bytes > progress.total_bytes
            {
                return Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            Ok(Decision::applied(
                ContinuationState::Downloading {
                    operation: operation.clone(),
                    progress: MachineProgress {
                        downloaded_bytes,
                        total_bytes: progress.total_bytes,
                        sequence: correlation.progress_sequence,
                    },
                    cancel_requested: *cancel_requested,
                    shutdown_requested: *shutdown_requested,
                },
                Vec::new(),
            ))
        }
        ContinuationInput::CancelRequested { operation_id } => reduce_cancel(state, operation_id),
        ContinuationInput::RecoverRequested => {
            let ContinuationState::RecoveryRequired {
                operation,
                progress,
                kind,
                ..
            } = state
            else {
                return Ok(Decision::unchanged(state, DecisionDisposition::Duplicate));
            };
            let sequence = progress.sequence.saturating_add(1);
            Ok(Decision::applied(
                ContinuationState::Recovering {
                    operation: operation.clone(),
                    progress: MachineProgress {
                        sequence,
                        ..progress.clone()
                    },
                    kind: *kind,
                },
                vec![ContinuationEffect::ReverifyCandidate {
                    correlation: operation.correlation(REVERIFY_EFFECT_ID, sequence),
                    candidate: Box::new(operation.candidate.clone()),
                }],
            ))
        }
        ContinuationInput::EffectCompleted(completion) => reduce_completion(state, completion),
        ContinuationInput::ShutdownRequested => reduce_shutdown(state),
    }
}

fn reduce_cancel(
    state: &ContinuationState,
    operation_id: String,
) -> Result<Decision, UpdateOperationError> {
    let Some(operation) = state.operation() else {
        return Err(UpdateOperationError::OperationMismatch);
    };
    if operation.operation_id != operation_id {
        return Err(UpdateOperationError::OperationMismatch);
    }
    match state {
        ContinuationState::Downloading {
            operation,
            progress,
            cancel_requested: false,
            shutdown_requested,
        } => Ok(Decision::applied(
            ContinuationState::Downloading {
                operation: operation.clone(),
                progress: progress.clone(),
                cancel_requested: true,
                shutdown_requested: *shutdown_requested,
            },
            vec![ContinuationEffect::Cancel {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, progress.sequence),
            }],
        )),
        ContinuationState::Verifying {
            operation,
            progress,
            cancel_requested: false,
            shutdown_requested,
        } => Ok(Decision::applied(
            ContinuationState::Verifying {
                operation: operation.clone(),
                progress: progress.clone(),
                cancel_requested: true,
                shutdown_requested: *shutdown_requested,
            },
            vec![ContinuationEffect::Cancel {
                correlation: operation.correlation(VERIFY_EFFECT_ID, progress.sequence),
            }],
        )),
        ContinuationState::CommittingCandidate { .. } => Ok(Decision::unchanged(
            state,
            DecisionDisposition::CancelTooLate,
        )),
        _ => Ok(Decision::unchanged(state, DecisionDisposition::Duplicate)),
    }
}

fn reduce_completion(
    state: &ContinuationState,
    completion: ContinuationCompletion,
) -> Result<Decision, UpdateOperationError> {
    match state {
        ContinuationState::Downloading {
            operation,
            progress,
            cancel_requested,
            shutdown_requested,
        } => {
            if !operation.accepts(&completion.correlation, DOWNLOAD_EFFECT_ID)
                || (!matches!(
                    &completion.outcome,
                    ContinuationEffectOutcome::TaskFailed(_)
                ) && completion.correlation.progress_sequence
                    != progress.sequence.saturating_add(1))
            {
                return Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            if let ContinuationEffectOutcome::TaskFailed(failure) = &completion.outcome {
                return Ok(begin_finalization(
                    operation,
                    progress,
                    FinalizingStage::Downloading,
                    failure.code(),
                    false,
                    *shutdown_requested,
                ));
            }
            if *cancel_requested
                || matches!(
                    completion.outcome,
                    ContinuationEffectOutcome::Download(Err(UpdateOperationError::Cancelled))
                )
            {
                return Ok(begin_cancel_finalization(
                    operation,
                    progress,
                    FinalizingStage::Downloading,
                    *shutdown_requested,
                ));
            }
            match completion.outcome {
                ContinuationEffectOutcome::Download(Ok(())) => {
                    let sequence = completion.correlation.progress_sequence.saturating_add(1);
                    let progress = MachineProgress {
                        downloaded_bytes: progress.total_bytes,
                        total_bytes: progress.total_bytes,
                        sequence,
                    };
                    Ok(Decision::applied(
                        ContinuationState::Verifying {
                            operation: operation.clone(),
                            progress,
                            cancel_requested: false,
                            shutdown_requested: *shutdown_requested,
                        },
                        vec![ContinuationEffect::Verify {
                            correlation: operation.correlation(VERIFY_EFFECT_ID, sequence),
                            candidate: Box::new(operation.candidate.clone()),
                        }],
                    ))
                }
                ContinuationEffectOutcome::Download(Err(error)) => Ok(begin_finalization(
                    operation,
                    progress,
                    FinalizingStage::Downloading,
                    error.code(),
                    fatal_download_error(error),
                    *shutdown_requested,
                )),
                _ => Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                )),
            }
        }
        ContinuationState::Verifying {
            operation,
            progress,
            cancel_requested,
            shutdown_requested,
        } => {
            if !operation.accepts(&completion.correlation, VERIFY_EFFECT_ID)
                || (!matches!(
                    &completion.outcome,
                    ContinuationEffectOutcome::TaskFailed(_)
                ) && completion.correlation.progress_sequence
                    != progress.sequence.saturating_add(1))
            {
                return Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            if let ContinuationEffectOutcome::TaskFailed(failure) = &completion.outcome {
                return Ok(begin_finalization(
                    operation,
                    progress,
                    FinalizingStage::Verifying,
                    failure.code(),
                    false,
                    *shutdown_requested,
                ));
            }
            if *cancel_requested
                || matches!(
                    completion.outcome,
                    ContinuationEffectOutcome::Verify(Err(UpdateOperationError::Cancelled))
                )
            {
                return Ok(begin_cancel_finalization(
                    operation,
                    progress,
                    FinalizingStage::Verifying,
                    *shutdown_requested,
                ));
            }
            match completion.outcome {
                ContinuationEffectOutcome::Verify(Ok(())) => {
                    let sequence = completion.correlation.progress_sequence.saturating_add(1);
                    let progress = MachineProgress {
                        sequence,
                        ..progress.clone()
                    };
                    Ok(Decision::applied(
                        ContinuationState::CommittingCandidate {
                            operation: operation.clone(),
                            progress,
                            shutdown_requested: *shutdown_requested,
                        },
                        vec![ContinuationEffect::CommitCandidate {
                            correlation: operation
                                .correlation(COMMIT_CANDIDATE_EFFECT_ID, sequence),
                            candidate: Box::new(operation.candidate.clone()),
                        }],
                    ))
                }
                ContinuationEffectOutcome::Verify(Err(error)) => Ok(begin_finalization(
                    operation,
                    progress,
                    FinalizingStage::Verifying,
                    error.code(),
                    true,
                    *shutdown_requested,
                )),
                _ => Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                )),
            }
        }
        ContinuationState::CommittingCandidate {
            operation,
            progress,
            shutdown_requested,
        } => {
            if !operation.accepts(&completion.correlation, COMMIT_CANDIDATE_EFFECT_ID)
                || (!matches!(
                    &completion.outcome,
                    ContinuationEffectOutcome::TaskFailed(_)
                ) && completion.correlation.progress_sequence
                    != progress.sequence.saturating_add(1))
            {
                return Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            match completion.outcome {
                ContinuationEffectOutcome::Commit(Ok(())) => {
                    let progress = MachineProgress {
                        sequence: completion.correlation.progress_sequence,
                        ..progress.clone()
                    };
                    Ok(Decision::applied(
                        if *shutdown_requested {
                            ContinuationState::Retired {
                                operation: Some(operation.clone()),
                                progress: Some(progress),
                                terminal: RetiredTerminal::Ready,
                            }
                        } else {
                            ContinuationState::Ready {
                                operation: operation.clone(),
                                progress,
                            }
                        },
                        Vec::new(),
                    ))
                }
                ContinuationEffectOutcome::Commit(Err(error)) => Ok(recovery_required(
                    operation,
                    progress,
                    error.code(),
                    *shutdown_requested,
                )),
                ContinuationEffectOutcome::TaskFailed(failure) => Ok(recovery_required(
                    operation,
                    progress,
                    failure.code(),
                    *shutdown_requested,
                )),
                _ => Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                )),
            }
        }
        ContinuationState::Finalizing {
            operation,
            progress,
            terminal,
            shutdown_requested,
            ..
        } => {
            if !operation.accepts(&completion.correlation, FINALIZE_EFFECT_ID)
                || (!matches!(
                    &completion.outcome,
                    ContinuationEffectOutcome::TaskFailed(_)
                ) && completion.correlation.progress_sequence
                    != progress.sequence.saturating_add(1))
            {
                return Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            match completion.outcome {
                ContinuationEffectOutcome::Finalize(Ok(partial)) => {
                    let resumable = partial.size > 0 && partial.etag.is_some();
                    let progress = MachineProgress {
                        downloaded_bytes: partial.size.min(progress.total_bytes),
                        sequence: completion.correlation.progress_sequence,
                        ..progress.clone()
                    };
                    let next = match terminal {
                        FinalizingTerminal::Cancelled if *shutdown_requested => {
                            ContinuationState::Retired {
                                operation: Some(operation.clone()),
                                progress: Some(progress),
                                terminal: RetiredTerminal::Cancelled { resumable },
                            }
                        }
                        FinalizingTerminal::Cancelled => ContinuationState::Cancelled {
                            operation: operation.clone(),
                            progress,
                            resumable,
                        },
                        FinalizingTerminal::Failed { reason } if *shutdown_requested => {
                            ContinuationState::Retired {
                                operation: Some(operation.clone()),
                                progress: Some(progress),
                                terminal: RetiredTerminal::Failed {
                                    reason: reason.clone(),
                                    resumable,
                                },
                            }
                        }
                        FinalizingTerminal::Failed { reason } => ContinuationState::Failed {
                            operation: operation.clone(),
                            progress,
                            reason: reason.clone(),
                            resumable,
                        },
                    };
                    Ok(Decision::applied(next, Vec::new()))
                }
                ContinuationEffectOutcome::Finalize(Err(error)) => Ok(recovery_required(
                    operation,
                    progress,
                    error.code(),
                    *shutdown_requested,
                )),
                ContinuationEffectOutcome::TaskFailed(failure) => Ok(recovery_required(
                    operation,
                    progress,
                    failure.code(),
                    *shutdown_requested,
                )),
                _ => Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                )),
            }
        }
        ContinuationState::Recovering {
            operation,
            progress,
            kind,
        } => {
            if !operation.accepts(&completion.correlation, REVERIFY_EFFECT_ID)
                || (!matches!(
                    &completion.outcome,
                    ContinuationEffectOutcome::TaskFailed(_)
                ) && completion.correlation.progress_sequence
                    != progress.sequence.saturating_add(1))
            {
                return Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                ));
            }
            match completion.outcome {
                ContinuationEffectOutcome::Recovery(Ok(())) => Ok(Decision::applied(
                    ContinuationState::Ready {
                        operation: operation.clone(),
                        progress: MachineProgress {
                            downloaded_bytes: progress.total_bytes,
                            sequence: completion.correlation.progress_sequence,
                            ..progress.clone()
                        },
                    },
                    Vec::new(),
                )),
                ContinuationEffectOutcome::Recovery(Err(error)) => Ok(Decision::applied(
                    ContinuationState::RecoveryRequired {
                        operation: operation.clone(),
                        progress: MachineProgress {
                            sequence: completion.correlation.progress_sequence,
                            ..progress.clone()
                        },
                        kind: *kind,
                        reason: error.code().into(),
                    },
                    Vec::new(),
                )),
                ContinuationEffectOutcome::TaskFailed(failure) => Ok(Decision::applied(
                    ContinuationState::RecoveryRequired {
                        operation: operation.clone(),
                        progress: MachineProgress {
                            sequence: progress.sequence.saturating_add(1),
                            ..progress.clone()
                        },
                        kind: *kind,
                        reason: failure.code().into(),
                    },
                    Vec::new(),
                )),
                _ => Ok(Decision::unchanged(
                    state,
                    DecisionDisposition::RetiredCompletion,
                )),
            }
        }
        _ => Ok(Decision::unchanged(
            state,
            DecisionDisposition::RetiredCompletion,
        )),
    }
}

fn begin_finalization(
    operation: &ContinuationOperation,
    progress: &MachineProgress,
    stage: FinalizingStage,
    reason: &str,
    discard_partial: bool,
    shutdown_requested: bool,
) -> Decision {
    let sequence = progress.sequence.saturating_add(1);
    let progress = MachineProgress {
        sequence,
        ..progress.clone()
    };
    Decision::applied(
        ContinuationState::Finalizing {
            operation: operation.clone(),
            progress,
            stage,
            terminal: FinalizingTerminal::Failed {
                reason: reason.into(),
            },
            discard_partial,
            shutdown_requested,
        },
        vec![ContinuationEffect::FinalizeFailure {
            correlation: operation.correlation(FINALIZE_EFFECT_ID, sequence),
            candidate: Box::new(operation.candidate.clone()),
            discard_partial,
        }],
    )
}

fn begin_cancel_finalization(
    operation: &ContinuationOperation,
    progress: &MachineProgress,
    stage: FinalizingStage,
    shutdown_requested: bool,
) -> Decision {
    let sequence = progress.sequence.saturating_add(1);
    let progress = MachineProgress {
        sequence,
        ..progress.clone()
    };
    Decision::applied(
        ContinuationState::Finalizing {
            operation: operation.clone(),
            progress,
            stage,
            terminal: FinalizingTerminal::Cancelled,
            discard_partial: false,
            shutdown_requested,
        },
        vec![ContinuationEffect::FinalizeFailure {
            correlation: operation.correlation(FINALIZE_EFFECT_ID, sequence),
            candidate: Box::new(operation.candidate.clone()),
            discard_partial: false,
        }],
    )
}

fn recovery_required(
    operation: &ContinuationOperation,
    progress: &MachineProgress,
    reason: &str,
    shutdown_requested: bool,
) -> Decision {
    Decision::applied(
        if shutdown_requested {
            ContinuationState::Retired {
                operation: Some(operation.clone()),
                progress: Some(progress.clone()),
                terminal: RetiredTerminal::RecoveryRequired {
                    reason: reason.into(),
                },
            }
        } else {
            ContinuationState::RecoveryRequired {
                operation: operation.clone(),
                progress: progress.clone(),
                kind: RecoveryKind::CandidateCommit,
                reason: reason.into(),
            }
        },
        Vec::new(),
    )
}

fn reduce_shutdown(state: &ContinuationState) -> Result<Decision, UpdateOperationError> {
    match state {
        ContinuationState::Downloading {
            operation,
            progress,
            cancel_requested,
            ..
        } => Ok(Decision::applied(
            ContinuationState::Downloading {
                operation: operation.clone(),
                progress: progress.clone(),
                cancel_requested: true,
                shutdown_requested: true,
            },
            if *cancel_requested {
                Vec::new()
            } else {
                vec![ContinuationEffect::Cancel {
                    correlation: operation.correlation(DOWNLOAD_EFFECT_ID, progress.sequence),
                }]
            },
        )),
        ContinuationState::Verifying {
            operation,
            progress,
            cancel_requested,
            ..
        } => Ok(Decision::applied(
            ContinuationState::Verifying {
                operation: operation.clone(),
                progress: progress.clone(),
                cancel_requested: true,
                shutdown_requested: true,
            },
            if *cancel_requested {
                Vec::new()
            } else {
                vec![ContinuationEffect::Cancel {
                    correlation: operation.correlation(VERIFY_EFFECT_ID, progress.sequence),
                }]
            },
        )),
        ContinuationState::CommittingCandidate {
            operation,
            progress,
            ..
        } => Ok(Decision::applied(
            ContinuationState::CommittingCandidate {
                operation: operation.clone(),
                progress: progress.clone(),
                shutdown_requested: true,
            },
            Vec::new(),
        )),
        ContinuationState::Finalizing {
            operation,
            progress,
            stage,
            terminal,
            discard_partial,
            ..
        } => Ok(Decision::applied(
            ContinuationState::Finalizing {
                operation: operation.clone(),
                progress: progress.clone(),
                stage: *stage,
                terminal: terminal.clone(),
                discard_partial: *discard_partial,
                shutdown_requested: true,
            },
            Vec::new(),
        )),
        ContinuationState::Ready {
            operation,
            progress,
        } => Ok(Decision::applied(
            ContinuationState::Retired {
                operation: Some(operation.clone()),
                progress: Some(progress.clone()),
                terminal: RetiredTerminal::Ready,
            },
            Vec::new(),
        )),
        ContinuationState::Interrupted {
            operation,
            progress,
            resumable,
        }
        | ContinuationState::Cancelled {
            operation,
            progress,
            resumable,
        } => Ok(Decision::applied(
            ContinuationState::Retired {
                operation: Some(operation.clone()),
                progress: Some(progress.clone()),
                terminal: RetiredTerminal::Cancelled {
                    resumable: *resumable,
                },
            },
            Vec::new(),
        )),
        ContinuationState::Failed {
            operation,
            progress,
            reason,
            resumable,
        } => Ok(Decision::applied(
            ContinuationState::Retired {
                operation: Some(operation.clone()),
                progress: Some(progress.clone()),
                terminal: RetiredTerminal::Failed {
                    reason: reason.clone(),
                    resumable: *resumable,
                },
            },
            Vec::new(),
        )),
        ContinuationState::RecoveryRequired {
            operation,
            progress,
            reason,
            ..
        } => Ok(Decision::applied(
            ContinuationState::Retired {
                operation: Some(operation.clone()),
                progress: Some(progress.clone()),
                terminal: RetiredTerminal::RecoveryRequired {
                    reason: reason.clone(),
                },
            },
            Vec::new(),
        )),
        ContinuationState::Recovering {
            operation,
            progress,
            ..
        } => Ok(Decision::applied(
            ContinuationState::Retired {
                operation: Some(operation.clone()),
                progress: Some(progress.clone()),
                terminal: RetiredTerminal::RecoveryRequired {
                    reason: "recovery-interrupted".into(),
                },
            },
            Vec::new(),
        )),
        ContinuationState::Stable => Ok(Decision::applied(
            ContinuationState::Retired {
                operation: None,
                progress: None,
                terminal: RetiredTerminal::Stable,
            },
            Vec::new(),
        )),
        ContinuationState::Retired { .. } => {
            Ok(Decision::unchanged(state, DecisionDisposition::Duplicate))
        }
    }
}

fn fatal_download_error(error: UpdateOperationError) -> bool {
    matches!(
        error,
        UpdateOperationError::InvalidResponse
            | UpdateOperationError::OversizedPayload
            | UpdateOperationError::RangeMismatch
            | UpdateOperationError::Verification(_)
    )
}

pub(super) struct ContinuationMachine;

impl Machine for ContinuationMachine {
    type State = ContinuationState;
    type Input = ContinuationInput;
    type Effect = ContinuationEffect;
    type Error = UpdateOperationError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        let decision = match reduce(state, input.clone()) {
            Ok(decision) => decision,
            Err(error) => return Transition::Rejected(error),
        };
        match decision.disposition {
            DecisionDisposition::Duplicate | DecisionDisposition::CancelTooLate => {
                Transition::Unchanged
            }
            DecisionDisposition::RetiredCompletion => Transition::Retired,
            DecisionDisposition::Applied if !decision.effects.is_empty() => {
                let mut effects = decision.effects.into_iter();
                let first = effects.next().expect("checked non-empty effects");
                Transition::EffectEmitting {
                    state: decision.next,
                    effects: EffectBatch::from_first(first, effects.collect()),
                }
            }
            DecisionDisposition::Applied => match decision.next {
                ContinuationState::Ready { .. } => Transition::Committed(decision.next),
                ContinuationState::Cancelled { .. } => Transition::Cancelled(decision.next),
                ContinuationState::Failed { .. } => Transition::Failed(decision.next),
                ContinuationState::RecoveryRequired { .. } => {
                    Transition::RecoveryRequired(decision.next)
                }
                ContinuationState::Retired { .. } => Transition::Accepted(decision.next),
                _ => Transition::Accepted(decision.next),
            },
        }
    }

    fn state_label(&self, state: &Self::State) -> &'static str {
        state.label()
    }

    fn input_label(&self, input: &Self::Input) -> &'static str {
        input.label()
    }

    fn input_correlation(&self, state: &Self::State, input: &Self::Input) -> Option<Correlation> {
        match input {
            ContinuationInput::DownloadRequested { operation, .. } => {
                Some(operation.correlation(DOWNLOAD_EFFECT_ID, 0).machine)
            }
            ContinuationInput::PartialCommitted { correlation, .. }
            | ContinuationInput::EffectCompleted(ContinuationCompletion { correlation, .. }) => {
                Some(correlation.machine.clone())
            }
            ContinuationInput::CancelRequested { .. }
            | ContinuationInput::RecoverRequested
            | ContinuationInput::ShutdownRequested => state
                .operation()
                .map(|operation| operation.correlation(0, 0).machine),
        }
    }

    fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
        ContinuationInput::EffectCompleted(ContinuationCompletion {
            correlation: EffectCorrelation {
                machine: correlation,
                progress_sequence: 0,
            },
            outcome: ContinuationEffectOutcome::TaskFailed(match failure {
                TaskFailure::Aborted => ContinuationTaskFailure::Aborted,
                TaskFailure::CompletionConflict => ContinuationTaskFailure::CompletionConflict,
                TaskFailure::Panicked => ContinuationTaskFailure::Panicked,
            }),
        })
    }

    fn shutdown(&self) -> Self::Input {
        ContinuationInput::ShutdownRequested
    }

    fn unavailable(&self) -> Self::Error {
        UpdateOperationError::Busy
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::{AuthenticatedReleaseAsset, AuthenticatedReleaseRecord};
    use mish_state_machine::{EffectExecutor, NoopObserver, RunnerConfig, spawn_runner};
    use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;

    fn candidate() -> AvailableCandidate {
        AvailableCandidate {
            metadata: crate::VerifiedMetadata {
                artifact_name: "Mish-1.0.1-alpha.1.app.tar.gz".into(),
                artifact_sha256: "a".repeat(64),
                artifact_signature: "private-signature-body".into(),
                artifact_size: 8,
                artifact_url: "https://example.invalid/payload".into(),
                channel: UpdateChannel::Alpha,
                channel_switch: false,
                metadata_sha256: "b".repeat(64),
                skipped_version: false,
                source_sha: "c".repeat(40),
                version: "1.0.1-alpha.1".into(),
            },
            metadata_bytes: b"metadata".to_vec(),
            metadata_signature: "metadata-signature".into(),
            release: AuthenticatedReleaseRecord {
                assets: vec![AuthenticatedReleaseAsset {
                    id: 1,
                    name: "payload".into(),
                }],
                channel: UpdateChannel::Alpha,
                id: 1,
                published_at: "2026-08-04T00:00:00Z".into(),
                tag: "v1.0.1-alpha.1".into(),
                version: "1.0.1-alpha.1".into(),
            },
        }
    }

    fn operation(id: &str) -> ContinuationOperation {
        ContinuationOperation {
            machine_authority: "authority".into(),
            scope_epoch: 7,
            operation_id: id.into(),
            admitted_revision: 11,
            candidate: candidate(),
        }
    }

    fn outer(operation: &ContinuationOperation, phase: UpdatePhase) -> Box<UpdaterSnapshot> {
        Box::new(UpdaterSnapshot {
            authority_id: operation.machine_authority.clone(),
            revision: 10,
            configured: true,
            phase,
            operation_id: Some(operation.operation_id.clone()),
            channel: Some(operation.candidate.metadata.channel),
            candidate: Some(operation.candidate.identity()),
            progress: None,
            resumable: false,
            terminal_reason: None,
        })
    }

    fn start() -> (ContinuationOperation, ContinuationState) {
        let operation = operation("download-a");
        let state = reduce(
            &ContinuationState::stable(),
            ContinuationInput::DownloadRequested {
                operation: Box::new(operation.clone()),
                outer: outer(&operation, UpdatePhase::Available),
                resumed_bytes: 0,
            },
        )
        .unwrap()
        .next;
        (operation, state)
    }

    #[test]
    fn transition_table_names_partial_verify_commit_and_ready_boundaries() {
        let (operation, downloading) = start();
        let partial = reduce(
            &downloading,
            ContinuationInput::PartialCommitted {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 1),
                downloaded_bytes: 8,
            },
        )
        .unwrap()
        .next;
        let verifying = reduce(
            &partial,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 2),
                outcome: ContinuationEffectOutcome::Download(Ok(())),
            }),
        )
        .unwrap();
        assert!(matches!(
            verifying.next,
            ContinuationState::Verifying { .. }
        ));
        assert!(matches!(
            verifying.effects.as_slice(),
            [ContinuationEffect::Verify { .. }]
        ));
        let committing = reduce(
            &verifying.next,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(VERIFY_EFFECT_ID, 4),
                outcome: ContinuationEffectOutcome::Verify(Ok(())),
            }),
        )
        .unwrap();
        assert!(matches!(
            committing.next,
            ContinuationState::CommittingCandidate { .. }
        ));
        let ready = reduce(
            &committing.next,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(COMMIT_CANDIDATE_EFFECT_ID, 6),
                outcome: ContinuationEffectOutcome::Commit(Ok(())),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(ready, ContinuationState::Ready { .. }));
        assert_eq!(ready.projection().unwrap().phase, UpdatePhase::Ready);
    }

    #[test]
    fn cancellation_before_commit_wins_and_after_commit_point_is_too_late() {
        let (operation, downloading) = start();
        let cancelling = reduce(
            &downloading,
            ContinuationInput::CancelRequested {
                operation_id: operation.operation_id.clone(),
            },
        )
        .unwrap();
        assert!(matches!(
            cancelling.effects.as_slice(),
            [ContinuationEffect::Cancel { .. }]
        ));
        let finalizing = reduce(
            &cancelling.next,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 1),
                outcome: ContinuationEffectOutcome::Download(Err(UpdateOperationError::Cancelled)),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(finalizing, ContinuationState::Finalizing { .. }));
        let cancelled = reduce(
            &finalizing,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(FINALIZE_EFFECT_ID, 2),
                outcome: ContinuationEffectOutcome::Finalize(Ok(PartialInfo {
                    size: 3,
                    etag: Some("strong".into()),
                })),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(cancelled, ContinuationState::Cancelled { .. }));

        let progress = MachineProgress {
            downloaded_bytes: 8,
            total_bytes: 8,
            sequence: 5,
        };
        let committing = ContinuationState::CommittingCandidate {
            operation: operation.clone(),
            progress,
            shutdown_requested: false,
        };
        let too_late = reduce(
            &committing,
            ContinuationInput::CancelRequested {
                operation_id: operation.operation_id,
            },
        )
        .unwrap();
        assert_eq!(too_late.disposition, DecisionDisposition::CancelTooLate);
        assert!(matches!(
            too_late.next,
            ContinuationState::CommittingCandidate { .. }
        ));
    }

    #[test]
    fn every_correlation_dimension_and_non_monotonic_progress_retires_unchanged() {
        let (operation, downloading) = start();
        let mut correlations = Vec::new();
        let mut value = operation.correlation(DOWNLOAD_EFFECT_ID, 1);
        value.machine.machine_authority = "other".into();
        correlations.push(value);
        let mut value = operation.correlation(DOWNLOAD_EFFECT_ID, 1);
        value.machine.scope_epoch += 1;
        correlations.push(value);
        let mut value = operation.correlation(DOWNLOAD_EFFECT_ID, 1);
        value.machine.operation_id = "other".into();
        correlations.push(value);
        let mut value = operation.correlation(DOWNLOAD_EFFECT_ID, 1);
        value.machine.admitted_revision += 1;
        correlations.push(value);
        correlations.push(operation.correlation(VERIFY_EFFECT_ID, 1));
        correlations.push(operation.correlation(DOWNLOAD_EFFECT_ID, 2));
        for correlation in correlations {
            let result = reduce(
                &downloading,
                ContinuationInput::PartialCommitted {
                    correlation,
                    downloaded_bytes: 1,
                },
            )
            .unwrap();
            assert_eq!(result.disposition, DecisionDisposition::RetiredCompletion);
            assert_eq!(result.next, downloading);
        }
    }

    #[test]
    fn restart_recovery_can_reach_ready_only_through_reverification() {
        let operation = operation("recovered");
        let progress = MachineProgress {
            downloaded_bytes: 8,
            total_bytes: 8,
            sequence: 9,
        };
        let required = ContinuationState::recovery_required(operation.clone(), progress);
        assert_eq!(
            required.projection().unwrap().terminal_reason.as_deref(),
            Some("recovery-required")
        );
        let recovering = reduce(&required, ContinuationInput::RecoverRequested)
            .unwrap()
            .next;
        assert!(matches!(recovering, ContinuationState::Recovering { .. }));
        let ready = reduce(
            &recovering,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(REVERIFY_EFFECT_ID, 11),
                outcome: ContinuationEffectOutcome::Recovery(Ok(())),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(ready, ContinuationState::Ready { .. }));
    }

    #[test]
    fn failure_injection_covers_download_verify_commit_finalize_and_recovery_boundaries() {
        let (operation, downloading) = start();
        let finalizing_download = reduce(
            &downloading,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 1),
                outcome: ContinuationEffectOutcome::Download(Err(UpdateOperationError::Network)),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(
            finalizing_download,
            ContinuationState::Finalizing { .. }
        ));
        let failed = reduce(
            &finalizing_download,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(FINALIZE_EFFECT_ID, 2),
                outcome: ContinuationEffectOutcome::Finalize(Ok(PartialInfo {
                    size: 3,
                    etag: Some("strong".into()),
                })),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(
            failed,
            ContinuationState::Failed {
                resumable: true,
                ..
            }
        ));

        let (_, downloading) = start();
        let verifying = reduce(
            &downloading,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 1),
                outcome: ContinuationEffectOutcome::Download(Ok(())),
            }),
        )
        .unwrap()
        .next;
        let finalizing_verify = reduce(
            &verifying,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(VERIFY_EFFECT_ID, 3),
                outcome: ContinuationEffectOutcome::Verify(Err(
                    UpdateOperationError::Verification(crate::UpdaterError::ArtifactDigestMismatch),
                )),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(
            finalizing_verify,
            ContinuationState::Finalizing {
                discard_partial: true,
                ..
            }
        ));
        let recovery_required = reduce(
            &finalizing_verify,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(FINALIZE_EFFECT_ID, 4),
                outcome: ContinuationEffectOutcome::Finalize(Err(
                    UpdateOperationError::StoreUnsafe,
                )),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(
            recovery_required,
            ContinuationState::RecoveryRequired { .. }
        ));

        let committing = reduce(
            &verifying,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(VERIFY_EFFECT_ID, 3),
                outcome: ContinuationEffectOutcome::Verify(Ok(())),
            }),
        )
        .unwrap()
        .next;
        for outcome in [
            ContinuationEffectOutcome::Commit(Err(UpdateOperationError::StoreIo)),
            ContinuationEffectOutcome::TaskFailed(ContinuationTaskFailure::Panicked),
            ContinuationEffectOutcome::TaskFailed(ContinuationTaskFailure::Aborted),
        ] {
            let terminal = reduce(
                &committing,
                ContinuationInput::EffectCompleted(ContinuationCompletion {
                    correlation: operation.correlation(COMMIT_CANDIDATE_EFFECT_ID, 5),
                    outcome,
                }),
            )
            .unwrap()
            .next;
            assert!(matches!(
                terminal,
                ContinuationState::RecoveryRequired { .. }
            ));
        }

        let recovery = ContinuationState::recovery_required(
            operation.clone(),
            MachineProgress {
                downloaded_bytes: 8,
                total_bytes: 8,
                sequence: 9,
            },
        );
        let recovering = reduce(&recovery, ContinuationInput::RecoverRequested)
            .unwrap()
            .next;
        let still_required = reduce(
            &recovering,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(REVERIFY_EFFECT_ID, 11),
                outcome: ContinuationEffectOutcome::Recovery(Err(
                    UpdateOperationError::StoreUnsafe,
                )),
            }),
        )
        .unwrap()
        .next;
        assert!(matches!(
            still_required,
            ContinuationState::RecoveryRequired { .. }
        ));
    }

    #[test]
    fn equal_revision_wrong_outcome_and_duplicate_completion_retire_without_mutation() {
        let (operation, downloading) = start();
        let wrong = reduce(
            &downloading,
            ContinuationInput::EffectCompleted(ContinuationCompletion {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 1),
                outcome: ContinuationEffectOutcome::Verify(Ok(())),
            }),
        )
        .unwrap();
        assert_eq!(wrong.disposition, DecisionDisposition::RetiredCompletion);
        assert_eq!(wrong.next, downloading);

        let progressed = reduce(
            &downloading,
            ContinuationInput::PartialCommitted {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 1),
                downloaded_bytes: 2,
            },
        )
        .unwrap()
        .next;
        let duplicate = reduce(
            &progressed,
            ContinuationInput::PartialCommitted {
                correlation: operation.correlation(DOWNLOAD_EFFECT_ID, 1),
                downloaded_bytes: 2,
            },
        )
        .unwrap();
        assert_eq!(
            duplicate.disposition,
            DecisionDisposition::RetiredCompletion
        );
        assert_eq!(duplicate.next, progressed);
    }

    #[test]
    fn bounded_model_never_projects_illegal_public_field_combinations() {
        let mut states = vec![ContinuationState::stable()];
        for sequence in 0..5_u64 {
            let mut next = Vec::new();
            for state in &states {
                let operation = operation(&format!("model-{sequence}"));
                let inputs = [
                    ContinuationInput::CancelRequested {
                        operation_id: operation.operation_id.clone(),
                    },
                    ContinuationInput::ShutdownRequested,
                    ContinuationInput::EffectCompleted(ContinuationCompletion {
                        correlation: operation.correlation(DOWNLOAD_EFFECT_ID, sequence + 1),
                        outcome: ContinuationEffectOutcome::TaskFailed(
                            ContinuationTaskFailure::CompletionConflict,
                        ),
                    }),
                ];
                for input in inputs {
                    if let Ok(decision) = reduce(state, input) {
                        assert_projection_invariant(&decision.next);
                        next.push(decision.next);
                    }
                }
                if let Ok(decision) = reduce(
                    state,
                    ContinuationInput::DownloadRequested {
                        operation: Box::new(operation.clone()),
                        outer: outer(&operation, UpdatePhase::Available),
                        resumed_bytes: sequence.min(8),
                    },
                ) {
                    assert_projection_invariant(&decision.next);
                    next.push(decision.next);
                }
            }
            states.extend(next);
            states.truncate(512);
        }
    }

    fn assert_projection_invariant(state: &ContinuationState) {
        let Some(projection) = state.projection() else {
            return;
        };
        assert!(!projection.operation_id.is_empty());
        assert_eq!(projection.candidate.channel, projection.channel);
        if let Some(progress) = &projection.progress {
            assert!(progress.downloaded_bytes <= progress.total_bytes);
            assert_eq!(progress.total_bytes, projection.candidate.artifact_size);
        }
        match projection.phase {
            UpdatePhase::Downloading | UpdatePhase::Verifying | UpdatePhase::Ready => {
                assert!(projection.terminal_reason.is_none());
            }
            UpdatePhase::Failed | UpdatePhase::Cancelled => {
                assert!(projection.terminal_reason.is_some());
            }
            UpdatePhase::Idle | UpdatePhase::Checking | UpdatePhase::Available => {
                panic!("continuation projection manufactured a Check-owned phase")
            }
        }
    }

    struct BarrierExecutor {
        release: Arc<Notify>,
        started: Arc<Notify>,
    }

    impl EffectExecutor<ContinuationMachine> for BarrierExecutor {
        fn execute(
            &self,
            effect: ContinuationEffect,
            cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = ContinuationInput> + Send + 'static>> {
            let release = self.release.clone();
            let started = self.started.clone();
            Box::pin(async move {
                match effect {
                    ContinuationEffect::Download {
                        mut correlation, ..
                    } => {
                        started.notify_one();
                        let outcome = tokio::select! {
                            _ = cancellation.cancelled() => Err(UpdateOperationError::Cancelled),
                            _ = release.notified() => Ok(()),
                        };
                        correlation.progress_sequence =
                            correlation.progress_sequence.saturating_add(1);
                        ContinuationInput::EffectCompleted(ContinuationCompletion {
                            correlation,
                            outcome: ContinuationEffectOutcome::Download(outcome),
                        })
                    }
                    ContinuationEffect::FinalizeFailure {
                        mut correlation, ..
                    } => {
                        correlation.progress_sequence =
                            correlation.progress_sequence.saturating_add(1);
                        ContinuationInput::EffectCompleted(ContinuationCompletion {
                            correlation,
                            outcome: ContinuationEffectOutcome::Finalize(Ok(PartialInfo {
                                size: 3,
                                etag: Some("strong".into()),
                            })),
                        })
                    }
                    _ => std::future::pending().await,
                }
            })
        }
    }

    #[tokio::test]
    async fn barrier_adapter_cancellation_cannot_cross_the_candidate_commit_cutoff() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let runner = spawn_runner(
            Arc::new(ContinuationMachine),
            ContinuationState::stable(),
            Arc::new(BarrierExecutor {
                release: release.clone(),
                started: started.clone(),
            }),
            Arc::new(NoopObserver),
            RunnerConfig::default(),
        );
        let operation = operation("barrier");
        runner
            .admit(ContinuationInput::DownloadRequested {
                operation: Box::new(operation.clone()),
                outer: outer(&operation, UpdatePhase::Available),
                resumed_bytes: 0,
            })
            .await
            .unwrap();
        started.notified().await;
        runner
            .admit(ContinuationInput::CancelRequested {
                operation_id: operation.operation_id,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !matches!(runner.snapshot(), ContinuationState::Cancelled { .. }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release.notify_waiters();
    }

    struct UncooperativeExecutor {
        started: Arc<Notify>,
    }

    impl EffectExecutor<ContinuationMachine> for UncooperativeExecutor {
        fn execute(
            &self,
            effect: ContinuationEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = ContinuationInput> + Send + 'static>> {
            let started = self.started.clone();
            Box::pin(async move {
                match effect {
                    ContinuationEffect::Download { .. } => {
                        started.notify_one();
                        std::future::pending().await
                    }
                    ContinuationEffect::FinalizeFailure {
                        mut correlation, ..
                    } => {
                        correlation.progress_sequence =
                            correlation.progress_sequence.saturating_add(1);
                        ContinuationInput::EffectCompleted(ContinuationCompletion {
                            correlation,
                            outcome: ContinuationEffectOutcome::Finalize(
                                Ok(PartialInfo::default()),
                            ),
                        })
                    }
                    _ => std::future::pending().await,
                }
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn paused_time_shutdown_aborts_uncooperative_download_and_retires_after_finalizing() {
        let started = Arc::new(Notify::new());
        let runner = spawn_runner(
            Arc::new(ContinuationMachine),
            ContinuationState::stable(),
            Arc::new(UncooperativeExecutor {
                started: started.clone(),
            }),
            Arc::new(NoopObserver),
            RunnerConfig {
                shutdown_grace: Duration::from_secs(1),
                ..RunnerConfig::default()
            },
        );
        let operation = operation("shutdown");
        runner
            .admit(ContinuationInput::DownloadRequested {
                operation: Box::new(operation.clone()),
                outer: outer(&operation, UpdatePhase::Available),
                resumed_bytes: 0,
            })
            .await
            .unwrap();
        started.notified().await;
        let shutdown = tokio::spawn(async move { runner.shutdown().await });
        tokio::time::advance(Duration::from_secs(2)).await;
        let terminal = shutdown.await.unwrap().state;
        assert!(matches!(
            terminal,
            ContinuationState::Retired {
                terminal: RetiredTerminal::Failed { .. },
                ..
            }
        ));
    }
}
