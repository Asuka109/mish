use std::{future::Future, pin::Pin, sync::Arc};

use mish_state_machine::{
    CorrelatedEffect, Correlation, Disposition, EffectBatch, EffectExecutor, EffectMode, Machine,
    TaskFailure, Transition, TransitionObserver,
};
use tokio_util::sync::CancellationToken;

use super::{
    CaptureAuditReason, CaptureOperation, CaptureOperationPhase, CaptureOperationStatus,
    CapturePreflight, CaptureRecoveryAction, CaptureRequest, CaptureRuntimeStatus,
    CaptureTransitionError, ConfirmedCaptureObserver,
};

const MUTATION_EFFECT_ID: u64 = 1;
const OBSERVATION_EFFECT_ID: u64 = 2;
const AUDIT_EFFECT_ID: u64 = 3;
const RECOVERY_EFFECT_ID: u64 = 4;
const FINALIZER_EFFECT_ID: u64 = 5;
const SHUTDOWN_EFFECT_ID: u64 = 6;
const AUDIT_COMMIT_EFFECT_ID: u64 = 7;
const PREFLIGHT_EFFECT_ID: u64 = 8;

type PreflightReply = Arc<
    std::sync::Mutex<
        Option<tokio::sync::oneshot::Sender<Result<CapturePreflight, CaptureTransitionError>>>,
    >,
>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TransitionMode {
    Ordinary,
    Prepared,
    RuntimeReplacement,
}

#[derive(Clone, Debug)]
pub(super) struct StableCapture {
    pub last_error: Option<CaptureTransitionError>,
    pub projection: CaptureRuntimeStatus,
    pub next_operation_id: u64,
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub(super) struct ActiveOperation {
    pub correlation: Correlation,
    pub mode: TransitionMode,
    pub pending: CaptureRuntimeStatus,
    pub public_pending: CaptureRuntimeStatus,
    pub previous: CaptureRuntimeStatus,
    pub public_operation_id: String,
    pub request: CaptureRequest,
}

impl ActiveOperation {
    fn public_operation(&self) -> CaptureOperation {
        CaptureOperation {
            correlation: self.correlation.clone(),
            previous: self.previous.clone(),
            public_operation_id: self.public_operation_id.clone(),
            request: self.request.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TransitionStage {
    Reserved,
    Preflighting,
    Mutating,
    Finalizing,
}

#[derive(Clone, Debug)]
pub(super) struct TransitioningCapture {
    pub deferred_failure: Option<CaptureTransitionError>,
    pub operation: ActiveOperation,
    pub stable: StableCapture,
    pub stage: TransitionStage,
}

#[derive(Clone, Debug)]
pub(super) struct ReconcilingCapture {
    pub operation: ActiveOperation,
    pub stable: StableCapture,
}

#[derive(Clone, Debug)]
pub(super) struct RecoveryRequiredCapture {
    pub error: Option<CaptureTransitionError>,
    pub next_operation_id: u64,
    pub projection: CaptureRuntimeStatus,
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub(super) struct ShuttingDownCapture {
    pub correlation: Correlation,
    pub projection: CaptureRuntimeStatus,
}

#[derive(Clone, Debug)]
pub(super) struct RetiredCapture {
    pub error: Option<CaptureTransitionError>,
    pub projection: CaptureRuntimeStatus,
}

#[derive(Clone, Debug)]
pub(super) enum CaptureState {
    Stable(StableCapture),
    Transitioning(TransitioningCapture),
    Reconciling(ReconcilingCapture),
    RecoveryRequired(RecoveryRequiredCapture),
    ShuttingDown(ShuttingDownCapture),
    Retired(RetiredCapture),
}

impl CaptureState {
    pub fn projection(&self) -> &CaptureRuntimeStatus {
        match self {
            Self::Stable(state) => &state.projection,
            Self::Transitioning(state) => &state.operation.pending,
            Self::Reconciling(state) => &state.operation.pending,
            Self::RecoveryRequired(state) => &state.projection,
            Self::ShuttingDown(state) => &state.projection,
            Self::Retired(state) => &state.projection,
        }
    }

    pub fn confirmed_projection(&self) -> &CaptureRuntimeStatus {
        match self {
            Self::Transitioning(state) => &state.operation.previous,
            Self::Reconciling(state) => &state.operation.previous,
            _ => self.projection(),
        }
    }

    pub fn active_operation(&self) -> Option<&ActiveOperation> {
        match self {
            Self::Transitioning(state) => Some(&state.operation),
            Self::Reconciling(state) => Some(&state.operation),
            _ => None,
        }
    }

    pub fn operation(&self) -> Option<CaptureOperation> {
        self.active_operation()
            .map(ActiveOperation::public_operation)
    }

    pub fn revision(&self) -> u64 {
        match self {
            Self::Stable(state) => state.revision,
            Self::Transitioning(state) => state.operation.correlation.admitted_revision,
            Self::Reconciling(state) => state.operation.correlation.admitted_revision,
            Self::RecoveryRequired(state) => state.revision,
            Self::ShuttingDown(state) => state.correlation.admitted_revision,
            Self::Retired(_) => 0,
        }
    }

    pub fn last_error(&self) -> Option<&CaptureTransitionError> {
        match self {
            Self::Stable(state) => state.last_error.as_ref(),
            Self::RecoveryRequired(state) => state.error.as_ref(),
            Self::Retired(state) => state.error.as_ref(),
            _ => None,
        }
    }

    fn base(&self) -> Option<StableCapture> {
        match self {
            Self::Stable(state) => Some(state.clone()),
            Self::RecoveryRequired(state) => Some(StableCapture {
                last_error: state.error.clone(),
                projection: state.projection.clone(),
                next_operation_id: state.next_operation_id,
                revision: state.revision,
            }),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct AuditOutcome {
    pub error: Option<CaptureTransitionError>,
    pub mutated: bool,
    pub status: CaptureRuntimeStatus,
}

#[derive(Clone, Debug)]
pub(super) struct EffectOutcome {
    pub error: Option<CaptureTransitionError>,
    pub status: CaptureRuntimeStatus,
}

#[derive(Clone, Debug)]
pub(super) enum CaptureInput {
    Preflight {
        cancellation: CancellationToken,
        reply: PreflightReply,
        request: CaptureRequest,
    },
    PreflightFinished {
        correlation: Correlation,
    },
    Reserve {
        request: CaptureRequest,
        mode: TransitionMode,
    },
    Start {
        core_healthy: bool,
        mode: TransitionMode,
        operation_prefix: Option<String>,
        preflight: Option<Box<CapturePreflight>>,
        request: CaptureRequest,
    },
    ExecuteReserved {
        core_healthy: bool,
        operation: CaptureOperation,
        preflight: Option<Box<CapturePreflight>>,
        request: CaptureRequest,
    },
    FailReserved {
        error: CaptureTransitionError,
        operation: CaptureOperation,
    },
    MutationFinished {
        correlation: Correlation,
        outcome: EffectOutcome,
    },
    ObservationFinished {
        correlation: Correlation,
        outcome: EffectOutcome,
    },
    Audit {
        core_healthy: bool,
        reason: CaptureAuditReason,
    },
    AuditFinished {
        correlation: Correlation,
        outcome: AuditOutcome,
    },
    AuditCommitted {
        correlation: Correlation,
        outcome: AuditOutcome,
    },
    Recover {
        action: CaptureRecoveryAction,
        core_healthy: bool,
    },
    RecoveryFinished {
        correlation: Correlation,
        outcome: EffectOutcome,
    },
    Finalized {
        correlation: Correlation,
        outcome: EffectOutcome,
    },
    TaskFailed {
        correlation: Correlation,
        failure: TaskFailure,
    },
    TaskCancelled {
        correlation: Correlation,
    },
    Shutdown,
    ShutdownFinished {
        correlation: Correlation,
        result: Result<CaptureRuntimeStatus, CaptureTransitionError>,
    },
}

#[derive(Debug)]
pub(super) enum CaptureEffect {
    Preflight {
        cancellation: CancellationToken,
        correlation: Correlation,
        reply: PreflightReply,
        request: CaptureRequest,
    },
    Mutate {
        core_healthy: bool,
        correlation: Correlation,
        preflight: Option<Box<CapturePreflight>>,
        previous: CaptureRuntimeStatus,
        request: CaptureRequest,
    },
    Observe {
        core_healthy: bool,
        correlation: Correlation,
        request: CaptureRequest,
    },
    Audit {
        core_healthy: bool,
        correlation: Correlation,
        previous: CaptureRuntimeStatus,
        reason: CaptureAuditReason,
    },
    CommitAudit {
        correlation: Correlation,
        outcome: AuditOutcome,
    },
    Recover {
        action: CaptureRecoveryAction,
        core_healthy: bool,
        correlation: Correlation,
        request: CaptureRequest,
    },
    Finalize {
        core_healthy: bool,
        correlation: Correlation,
        request: CaptureRequest,
    },
    Cancel(Correlation),
    Shutdown {
        correlation: Correlation,
        previous: CaptureRuntimeStatus,
    },
}

impl CorrelatedEffect for CaptureEffect {
    fn correlation(&self) -> &Correlation {
        match self {
            Self::Preflight { correlation, .. }
            | Self::Mutate { correlation, .. }
            | Self::Observe { correlation, .. }
            | Self::Audit { correlation, .. }
            | Self::CommitAudit { correlation, .. }
            | Self::Recover { correlation, .. }
            | Self::Finalize { correlation, .. }
            | Self::Shutdown { correlation, .. }
            | Self::Cancel(correlation) => correlation,
        }
    }

    fn mode(&self) -> EffectMode {
        if matches!(self, Self::Cancel(_)) {
            EffectMode::Cancel
        } else {
            EffectMode::Spawn
        }
    }
}

pub(super) trait CaptureEffects: Send + Sync + 'static {
    fn preflight(
        &self,
        request: CaptureRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<CapturePreflight, CaptureTransitionError>> + Send + 'static>,
    >;

    fn mutate(
        &self,
        request: CaptureRequest,
        core_healthy: bool,
        preflight: Option<CapturePreflight>,
        previous: CaptureRuntimeStatus,
    ) -> Pin<Box<dyn Future<Output = EffectOutcome> + Send + 'static>>;

    fn observe(
        &self,
        request: CaptureRequest,
        core_healthy: bool,
    ) -> Pin<Box<dyn Future<Output = EffectOutcome> + Send + 'static>>;

    fn audit(
        &self,
        reason: CaptureAuditReason,
        core_healthy: bool,
        previous: CaptureRuntimeStatus,
    ) -> Pin<Box<dyn Future<Output = AuditOutcome> + Send + 'static>>;

    fn recover(
        &self,
        action: CaptureRecoveryAction,
        core_healthy: bool,
        request: CaptureRequest,
    ) -> Pin<Box<dyn Future<Output = EffectOutcome> + Send + 'static>>;

    fn shutdown(
        &self,
        previous: CaptureRuntimeStatus,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<CaptureRuntimeStatus, CaptureTransitionError>>
                + Send
                + 'static,
        >,
    >;
}

pub(super) struct CaptureExecutor {
    pub effects: Arc<dyn CaptureEffects>,
}

impl EffectExecutor<CaptureMachine> for CaptureExecutor {
    fn execute(
        &self,
        effect: CaptureEffect,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = CaptureInput> + Send + 'static>> {
        let effects = self.effects.clone();
        Box::pin(async move {
            match effect {
                CaptureEffect::Preflight {
                    cancellation: request_cancellation,
                    correlation,
                    reply,
                    request,
                } => {
                    let result = tokio::select! {
                        result = effects.preflight(request) => result,
                        _ = cancellation.cancelled() => {
                            Err(super::runtime_transition_error())
                        }
                        _ = request_cancellation.cancelled() => {
                            Err(super::runtime_transition_error())
                        }
                    };
                    if let Some(reply) = reply
                        .lock()
                        .expect("Capture preflight reply lock poisoned")
                        .take()
                    {
                        let _ = reply.send(result);
                    }
                    CaptureInput::PreflightFinished { correlation }
                }
                CaptureEffect::Mutate {
                    core_healthy,
                    correlation,
                    preflight,
                    previous,
                    request,
                } => {
                    let outcome = tokio::select! {
                        outcome = effects.mutate(
                            request,
                            core_healthy,
                            preflight.map(|preflight| *preflight),
                            previous,
                        ) => outcome,
                        _ = cancellation.cancelled() => {
                            return CaptureInput::TaskCancelled { correlation };
                        }
                    };
                    CaptureInput::MutationFinished {
                        correlation,
                        outcome,
                    }
                }
                CaptureEffect::Observe {
                    core_healthy,
                    correlation,
                    request,
                } => {
                    let outcome = tokio::select! {
                        outcome = effects.observe(request, core_healthy) => outcome,
                        _ = cancellation.cancelled() => {
                            return CaptureInput::TaskCancelled { correlation };
                        }
                    };
                    CaptureInput::ObservationFinished {
                        correlation,
                        outcome,
                    }
                }
                CaptureEffect::Audit {
                    core_healthy,
                    correlation,
                    previous,
                    reason,
                } => {
                    let outcome = tokio::select! {
                        outcome = effects.audit(reason, core_healthy, previous) => outcome,
                        _ = cancellation.cancelled() => {
                            return CaptureInput::TaskCancelled { correlation };
                        }
                    };
                    CaptureInput::AuditFinished {
                        correlation,
                        outcome,
                    }
                }
                CaptureEffect::CommitAudit {
                    correlation,
                    outcome,
                } => CaptureInput::AuditCommitted {
                    correlation,
                    outcome,
                },
                CaptureEffect::Recover {
                    action,
                    core_healthy,
                    correlation,
                    request,
                } => {
                    let outcome = tokio::select! {
                        outcome = effects.recover(action, core_healthy, request) => outcome,
                        _ = cancellation.cancelled() => {
                            return CaptureInput::TaskCancelled { correlation };
                        }
                    };
                    CaptureInput::RecoveryFinished {
                        correlation,
                        outcome,
                    }
                }
                CaptureEffect::Finalize {
                    core_healthy,
                    correlation,
                    request,
                } => {
                    let outcome = effects.observe(request, core_healthy).await;
                    CaptureInput::Finalized {
                        correlation,
                        outcome,
                    }
                }
                CaptureEffect::Shutdown {
                    correlation,
                    previous,
                } => {
                    let result = effects.shutdown(previous).await;
                    CaptureInput::ShutdownFinished {
                        correlation,
                        result,
                    }
                }
                CaptureEffect::Cancel(correlation) => CaptureInput::TaskCancelled { correlation },
            }
        })
    }
}

#[derive(Clone)]
pub(super) struct CaptureMachine {
    pub machine_authority: String,
    pub scope_epoch: u64,
}

impl CaptureMachine {
    fn operation(
        &self,
        stable: &StableCapture,
        request: CaptureRequest,
        mode: TransitionMode,
        operation_prefix: Option<&str>,
    ) -> Result<(StableCapture, ActiveOperation), CaptureTransitionError> {
        let operation_number = stable.next_operation_id;
        let next_operation_id = operation_number
            .checked_add(1)
            .ok_or_else(super::runtime_transition_error)?;
        let admitted_revision = stable
            .revision
            .checked_add(1)
            .ok_or_else(super::runtime_transition_error)?;
        let public_operation_id = operation_number.to_string();
        let correlation = Correlation {
            machine_authority: self.machine_authority.clone(),
            scope_epoch: self.scope_epoch,
            operation_id: operation_prefix.map_or_else(
                || public_operation_id.clone(),
                |prefix| format!("{prefix}-{public_operation_id}"),
            ),
            admitted_revision,
            effect_id: 0,
        };
        let mut pending = stable.projection.clone();
        pending.capture_operation = CaptureOperationStatus {
            operation_id: Some(public_operation_id.clone()),
            phase: CaptureOperationPhase::Pending,
            scope_epoch: self.machine_authority.clone(),
        };
        pending.capture_selection = request.selection.clone();
        let system_proxy_involved = request.selection.system_proxy
            || stable.projection.capture_selection.system_proxy
            || stable.projection.system_proxy.desired
            || stable.projection.system_proxy_enabled;
        if system_proxy_involved {
            pending.system_proxy.desired = request.active && request.selection.system_proxy;
            pending.system_proxy.failure = None;
            pending.system_proxy.phase = super::SystemProxyPhase::Pending;
        }
        let tun_involved = request.selection.tun
            || stable.projection.capture_selection.tun
            || stable.projection.tun.desired
            || stable.projection.tun_enabled;
        if tun_involved {
            pending.tun.desired = request.active && request.selection.tun;
            pending.tun.failure = None;
            pending.tun.phase = super::TunPhase::Pending;
        }
        let public_pending = pending.clone();
        Ok((
            StableCapture {
                last_error: stable.last_error.clone(),
                projection: stable.projection.clone(),
                next_operation_id,
                revision: admitted_revision,
            },
            ActiveOperation {
                correlation,
                mode,
                pending,
                public_pending,
                previous: stable.projection.clone(),
                public_operation_id,
                request,
            },
        ))
    }

    fn finish(
        &self,
        stable: StableCapture,
        operation: &ActiveOperation,
        mut projection: CaptureRuntimeStatus,
        phase: CaptureOperationPhase,
    ) -> CaptureState {
        projection.capture_operation = CaptureOperationStatus {
            operation_id: Some(operation.public_operation_id.clone()),
            phase,
            scope_epoch: operation.pending.capture_operation.scope_epoch.clone(),
        };
        if phase == CaptureOperationPhase::RecoveryRequired {
            CaptureState::RecoveryRequired(RecoveryRequiredCapture {
                error: None,
                next_operation_id: stable.next_operation_id,
                projection,
                revision: stable.revision,
            })
        } else {
            CaptureState::Stable(StableCapture {
                last_error: None,
                projection,
                ..stable
            })
        }
    }

    fn recovery(
        &self,
        stable: StableCapture,
        operation: &ActiveOperation,
        mut projection: CaptureRuntimeStatus,
        error: CaptureTransitionError,
    ) -> CaptureState {
        projection.capture_operation = CaptureOperationStatus {
            operation_id: Some(operation.public_operation_id.clone()),
            phase: CaptureOperationPhase::RecoveryRequired,
            scope_epoch: operation.pending.capture_operation.scope_epoch.clone(),
        };
        CaptureState::RecoveryRequired(RecoveryRequiredCapture {
            error: Some(error),
            next_operation_id: stable.next_operation_id,
            projection,
            revision: stable.revision,
        })
    }

    fn failed(
        &self,
        stable: StableCapture,
        operation: &ActiveOperation,
        mut projection: CaptureRuntimeStatus,
        error: CaptureTransitionError,
    ) -> CaptureState {
        projection.capture_operation = CaptureOperationStatus {
            operation_id: Some(operation.public_operation_id.clone()),
            phase: CaptureOperationPhase::Failed,
            scope_epoch: operation.pending.capture_operation.scope_epoch.clone(),
        };
        CaptureState::Stable(StableCapture {
            last_error: Some(error),
            projection,
            ..stable
        })
    }

    fn matching(operation: &ActiveOperation, correlation: &Correlation, effect_id: u64) -> bool {
        operation.correlation.same_operation(correlation) && correlation.effect_id == effect_id
    }

    fn finalizer(
        &self,
        stable: StableCapture,
        operation: ActiveOperation,
    ) -> Transition<CaptureState, CaptureEffect, CaptureTransitionError> {
        let correlation = operation.correlation.with_effect(FINALIZER_EFFECT_ID);
        let request = operation.request.clone();
        Transition::EffectEmitting {
            state: CaptureState::Transitioning(TransitioningCapture {
                deferred_failure: None,
                operation,
                stable,
                stage: TransitionStage::Finalizing,
            }),
            effects: EffectBatch::one(CaptureEffect::Finalize {
                core_healthy: false,
                correlation,
                request,
            }),
        }
    }
}

impl Machine for CaptureMachine {
    type State = CaptureState;
    type Input = CaptureInput;
    type Effect = CaptureEffect;
    type Error = CaptureTransitionError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        match input {
            CaptureInput::Preflight {
                cancellation,
                reply,
                request,
            } => match state {
                CaptureState::Stable(_) | CaptureState::RecoveryRequired(_) => {
                    let base = state.base().expect("stable Capture state must have a base");
                    let Ok((stable, mut operation)) = self.operation(
                        &base,
                        request.clone(),
                        TransitionMode::Ordinary,
                        Some("preflight"),
                    ) else {
                        return Transition::Rejected(super::runtime_transition_error());
                    };
                    operation.pending = operation.previous.clone();
                    let correlation = operation.correlation.with_effect(PREFLIGHT_EFFECT_ID);
                    Transition::EffectEmitting {
                        state: CaptureState::Reconciling(ReconcilingCapture { operation, stable }),
                        effects: EffectBatch::one(CaptureEffect::Preflight {
                            cancellation: cancellation.clone(),
                            correlation,
                            reply: reply.clone(),
                            request: request.clone(),
                        }),
                    }
                }
                CaptureState::Transitioning(current)
                    if current.stage == TransitionStage::Reserved
                        && current.operation.request == *request =>
                {
                    let correlation = current
                        .operation
                        .correlation
                        .with_effect(PREFLIGHT_EFFECT_ID);
                    Transition::EffectEmitting {
                        state: CaptureState::Transitioning(TransitioningCapture {
                            deferred_failure: None,
                            stage: TransitionStage::Preflighting,
                            ..current.clone()
                        }),
                        effects: EffectBatch::one(CaptureEffect::Preflight {
                            cancellation: cancellation.clone(),
                            correlation,
                            reply: reply.clone(),
                            request: request.clone(),
                        }),
                    }
                }
                _ => Transition::Rejected(super::runtime_transition_error()),
            },
            CaptureInput::PreflightFinished { correlation } => match state {
                CaptureState::Reconciling(current)
                    if Self::matching(&current.operation, correlation, PREFLIGHT_EFFECT_ID) =>
                {
                    Transition::Accepted(CaptureState::Stable(StableCapture {
                        last_error: None,
                        projection: current.operation.previous.clone(),
                        next_operation_id: current.stable.next_operation_id - 1,
                        revision: current.stable.revision - 1,
                    }))
                }
                CaptureState::Transitioning(current)
                    if current.stage == TransitionStage::Preflighting
                        && Self::matching(&current.operation, correlation, PREFLIGHT_EFFECT_ID) =>
                {
                    if let Some(error) = &current.deferred_failure {
                        if error.kind == super::CaptureFailureKind::RollbackFailed {
                            return Transition::RecoveryRequired(self.recovery(
                                current.stable.clone(),
                                &current.operation,
                                current.operation.previous.clone(),
                                error.clone(),
                            ));
                        }
                        return Transition::Failed(self.failed(
                            current.stable.clone(),
                            &current.operation,
                            current.operation.previous.clone(),
                            error.clone(),
                        ));
                    }
                    Transition::Accepted(CaptureState::Transitioning(TransitioningCapture {
                        deferred_failure: None,
                        stage: TransitionStage::Reserved,
                        ..current.clone()
                    }))
                }
                _ => Transition::Retired,
            },
            CaptureInput::Reserve { request, mode } => {
                let Some(base) = state.base() else {
                    return Transition::Rejected(super::runtime_transition_error());
                };
                let Ok((stable, operation)) = self.operation(&base, request.clone(), *mode, None)
                else {
                    return Transition::Rejected(super::runtime_transition_error());
                };
                Transition::Accepted(CaptureState::Transitioning(TransitioningCapture {
                    deferred_failure: None,
                    operation,
                    stable,
                    stage: TransitionStage::Reserved,
                }))
            }
            CaptureInput::Start {
                core_healthy,
                mode,
                operation_prefix,
                preflight,
                request,
            } => {
                let Some(base) = state.base() else {
                    return Transition::Rejected(super::runtime_transition_error());
                };
                let Ok((stable, operation)) =
                    self.operation(&base, request.clone(), *mode, operation_prefix.as_deref())
                else {
                    return Transition::Rejected(super::runtime_transition_error());
                };
                let correlation = operation.correlation.with_effect(MUTATION_EFFECT_ID);
                let previous = operation.previous.clone();
                Transition::EffectEmitting {
                    state: CaptureState::Transitioning(TransitioningCapture {
                        deferred_failure: None,
                        operation,
                        stable,
                        stage: TransitionStage::Mutating,
                    }),
                    effects: EffectBatch::one(CaptureEffect::Mutate {
                        core_healthy: *core_healthy,
                        correlation,
                        preflight: preflight.clone(),
                        previous,
                        request: request.clone(),
                    }),
                }
            }
            CaptureInput::ExecuteReserved {
                core_healthy,
                operation: token,
                preflight,
                request,
            } => {
                let CaptureState::Transitioning(current) = state else {
                    return Transition::Retired;
                };
                if current.stage != TransitionStage::Reserved
                    || !current
                        .operation
                        .correlation
                        .same_operation(&token.correlation)
                    || current.operation.request != *request
                    || token.request != *request
                {
                    return Transition::Retired;
                }
                let correlation = current
                    .operation
                    .correlation
                    .with_effect(MUTATION_EFFECT_ID);
                Transition::EffectEmitting {
                    state: CaptureState::Transitioning(TransitioningCapture {
                        deferred_failure: None,
                        stage: TransitionStage::Mutating,
                        ..current.clone()
                    }),
                    effects: EffectBatch::one(CaptureEffect::Mutate {
                        core_healthy: *core_healthy,
                        correlation,
                        preflight: preflight.clone(),
                        previous: current.operation.previous.clone(),
                        request: request.clone(),
                    }),
                }
            }
            CaptureInput::FailReserved {
                error,
                operation: token,
            } => {
                let terminal = state.projection();
                let matches_terminal = terminal.capture_operation.scope_epoch
                    == token.correlation.machine_authority
                    && terminal.capture_operation.operation_id.as_deref()
                        == Some(token.public_operation_id.as_str())
                    && terminal.capture_operation.phase != CaptureOperationPhase::Pending;
                if matches_terminal
                    && matches!(
                        state,
                        CaptureState::Stable(_) | CaptureState::RecoveryRequired(_)
                    )
                {
                    let (next_operation_id, revision) = match state {
                        CaptureState::Stable(current) => {
                            (current.next_operation_id, current.revision)
                        }
                        CaptureState::RecoveryRequired(current) => {
                            (current.next_operation_id, current.revision)
                        }
                        _ => unreachable!(),
                    };
                    if error.kind == super::CaptureFailureKind::RollbackFailed {
                        let mut projection = terminal.clone();
                        projection.capture_operation.phase =
                            CaptureOperationPhase::RecoveryRequired;
                        return Transition::RecoveryRequired(CaptureState::RecoveryRequired(
                            RecoveryRequiredCapture {
                                error: Some(error.clone()),
                                next_operation_id,
                                projection,
                                revision,
                            },
                        ));
                    }
                    let mut projection = token.previous.clone();
                    projection.capture_operation = CaptureOperationStatus {
                        operation_id: Some(token.public_operation_id.clone()),
                        phase: CaptureOperationPhase::Failed,
                        scope_epoch: token.correlation.machine_authority.clone(),
                    };
                    return Transition::Failed(CaptureState::Stable(StableCapture {
                        last_error: Some(error.clone()),
                        next_operation_id,
                        projection,
                        revision,
                    }));
                }
                let CaptureState::Transitioning(current) = state else {
                    return Transition::Retired;
                };
                if !current
                    .operation
                    .correlation
                    .same_operation(&token.correlation)
                {
                    return Transition::Retired;
                }
                if current.stage == TransitionStage::Preflighting {
                    if current.deferred_failure.is_some() {
                        return Transition::Unchanged;
                    }
                    return Transition::EffectEmitting {
                        state: CaptureState::Transitioning(TransitioningCapture {
                            deferred_failure: Some(error.clone()),
                            ..current.clone()
                        }),
                        effects: EffectBatch::one(CaptureEffect::Cancel(
                            current
                                .operation
                                .correlation
                                .with_effect(PREFLIGHT_EFFECT_ID),
                        )),
                    };
                }
                if current.stage != TransitionStage::Reserved {
                    return Transition::Retired;
                }
                if error.kind == super::CaptureFailureKind::RollbackFailed {
                    Transition::RecoveryRequired(self.recovery(
                        current.stable.clone(),
                        &current.operation,
                        current.operation.previous.clone(),
                        error.clone(),
                    ))
                } else {
                    Transition::Failed(self.failed(
                        current.stable.clone(),
                        &current.operation,
                        current.operation.previous.clone(),
                        error.clone(),
                    ))
                }
            }
            CaptureInput::MutationFinished {
                correlation,
                outcome,
            }
            | CaptureInput::RecoveryFinished {
                correlation,
                outcome,
            } => {
                let CaptureState::Transitioning(current) = state else {
                    return Transition::Retired;
                };
                let expected = if matches!(input, CaptureInput::MutationFinished { .. }) {
                    MUTATION_EFFECT_ID
                } else {
                    RECOVERY_EFFECT_ID
                };
                if !Self::matching(&current.operation, correlation, expected) {
                    return Transition::Retired;
                }
                match &outcome.error {
                    None => {
                        let mut operation = current.operation.clone();
                        if matches!(input, CaptureInput::RecoveryFinished { .. }) {
                            operation.request = CaptureRequest {
                                active: outcome.status.system_proxy.desired
                                    || outcome.status.tun.desired,
                                selection: outcome.status.capture_selection.clone(),
                            };
                        }
                        let observation = current
                            .operation
                            .correlation
                            .with_effect(OBSERVATION_EFFECT_ID);
                        Transition::EffectEmitting {
                            state: CaptureState::Reconciling(ReconcilingCapture {
                                operation: operation.clone(),
                                stable: current.stable.clone(),
                            }),
                            effects: EffectBatch::one(CaptureEffect::Observe {
                                core_healthy: true,
                                correlation: observation,
                                request: operation.request,
                            }),
                        }
                    }
                    Some(error) if error.kind == super::CaptureFailureKind::RollbackFailed => {
                        Transition::RecoveryRequired(self.recovery(
                            current.stable.clone(),
                            &current.operation,
                            outcome.status.clone(),
                            error.clone(),
                        ))
                    }
                    Some(error) => Transition::Failed(self.failed(
                        current.stable.clone(),
                        &current.operation,
                        outcome.status.clone(),
                        error.clone(),
                    )),
                }
            }
            CaptureInput::ObservationFinished {
                correlation,
                outcome,
            } => {
                let CaptureState::Reconciling(current) = state else {
                    return Transition::Retired;
                };
                if !Self::matching(&current.operation, correlation, OBSERVATION_EFFECT_ID) {
                    return Transition::Retired;
                }
                match &outcome.error {
                    None => Transition::Committed(self.finish(
                        current.stable.clone(),
                        &current.operation,
                        outcome.status.clone(),
                        CaptureOperationPhase::Applied,
                    )),
                    Some(error) => Transition::RecoveryRequired(self.recovery(
                        current.stable.clone(),
                        &current.operation,
                        outcome.status.clone(),
                        error.clone(),
                    )),
                }
            }
            CaptureInput::Audit {
                core_healthy,
                reason,
            } => {
                let Some(base) = state.base() else {
                    return Transition::Unchanged;
                };
                let request = CaptureRequest {
                    active: base.projection.system_proxy.desired || base.projection.tun.desired,
                    selection: base.projection.capture_selection.clone(),
                };
                let Ok((stable, mut operation)) =
                    self.operation(&base, request, TransitionMode::Ordinary, Some("audit"))
                else {
                    return Transition::Rejected(super::runtime_transition_error());
                };
                operation.pending = operation.previous.clone();
                let correlation = operation.correlation.with_effect(AUDIT_EFFECT_ID);
                Transition::EffectEmitting {
                    state: CaptureState::Reconciling(ReconcilingCapture { operation, stable }),
                    effects: EffectBatch::one(CaptureEffect::Audit {
                        core_healthy: *core_healthy,
                        correlation,
                        previous: base.projection,
                        reason: *reason,
                    }),
                }
            }
            CaptureInput::AuditFinished {
                correlation,
                outcome,
            } => {
                let CaptureState::Reconciling(current) = state else {
                    return Transition::Retired;
                };
                if !Self::matching(&current.operation, correlation, AUDIT_EFFECT_ID) {
                    return Transition::Retired;
                }
                let changed = outcome.mutated || outcome.error.is_some();
                if !changed {
                    return Transition::Accepted(CaptureState::Stable(StableCapture {
                        last_error: None,
                        projection: current.operation.previous.clone(),
                        next_operation_id: current.stable.next_operation_id - 1,
                        revision: current.stable.revision - 1,
                    }));
                }
                let mut operation = current.operation.clone();
                operation.pending = operation.public_pending.clone();
                let commit = operation.correlation.with_effect(AUDIT_COMMIT_EFFECT_ID);
                Transition::EffectEmitting {
                    state: CaptureState::Transitioning(TransitioningCapture {
                        deferred_failure: None,
                        operation,
                        stable: current.stable.clone(),
                        stage: TransitionStage::Mutating,
                    }),
                    effects: EffectBatch::one(CaptureEffect::CommitAudit {
                        correlation: commit,
                        outcome: outcome.clone(),
                    }),
                }
            }
            CaptureInput::AuditCommitted {
                correlation,
                outcome,
            } => {
                let CaptureState::Transitioning(current) = state else {
                    return Transition::Retired;
                };
                if !Self::matching(&current.operation, correlation, AUDIT_COMMIT_EFFECT_ID) {
                    return Transition::Retired;
                }
                if let Some(error) = &outcome.error {
                    return Transition::RecoveryRequired(self.recovery(
                        current.stable.clone(),
                        &current.operation,
                        outcome.status.clone(),
                        error.clone(),
                    ));
                }
                let phase = if outcome.status.system_proxy.phase == super::SystemProxyPhase::Drift
                    || outcome.status.tun.phase == super::TunPhase::Drift
                {
                    CaptureOperationPhase::RecoveryRequired
                } else {
                    CaptureOperationPhase::Applied
                };
                let next = self.finish(
                    current.stable.clone(),
                    &current.operation,
                    outcome.status.clone(),
                    phase,
                );
                if phase == CaptureOperationPhase::RecoveryRequired {
                    Transition::RecoveryRequired(next)
                } else {
                    Transition::Committed(next)
                }
            }
            CaptureInput::Recover {
                action,
                core_healthy,
            } => {
                let Some(base) = state.base() else {
                    return Transition::Rejected(super::runtime_transition_error());
                };
                let request = CaptureRequest {
                    active: base.projection.system_proxy.desired || base.projection.tun.desired,
                    selection: base.projection.capture_selection.clone(),
                };
                let Ok((stable, operation)) =
                    self.operation(&base, request.clone(), TransitionMode::Ordinary, None)
                else {
                    return Transition::Rejected(super::runtime_transition_error());
                };
                let correlation = operation.correlation.with_effect(RECOVERY_EFFECT_ID);
                Transition::EffectEmitting {
                    state: CaptureState::Transitioning(TransitioningCapture {
                        deferred_failure: None,
                        operation,
                        stable,
                        stage: TransitionStage::Mutating,
                    }),
                    effects: EffectBatch::one(CaptureEffect::Recover {
                        action: *action,
                        core_healthy: *core_healthy,
                        correlation,
                        request,
                    }),
                }
            }
            CaptureInput::TaskFailed {
                correlation,
                failure: _,
            }
            | CaptureInput::TaskCancelled { correlation } => {
                let Some(operation) = state.active_operation() else {
                    return Transition::Retired;
                };
                if !operation.correlation.same_operation(correlation) {
                    return Transition::Retired;
                }
                if let CaptureState::Transitioning(current) = state
                    && current.stage == TransitionStage::Preflighting
                    && correlation.effect_id == PREFLIGHT_EFFECT_ID
                    && let Some(error) = &current.deferred_failure
                {
                    if error.kind == super::CaptureFailureKind::RollbackFailed {
                        return Transition::RecoveryRequired(self.recovery(
                            current.stable.clone(),
                            &current.operation,
                            current.operation.previous.clone(),
                            error.clone(),
                        ));
                    }
                    return Transition::Failed(self.failed(
                        current.stable.clone(),
                        &current.operation,
                        current.operation.previous.clone(),
                        error.clone(),
                    ));
                }
                let stable = match state {
                    CaptureState::Transitioning(current) => current.stable.clone(),
                    CaptureState::Reconciling(current) => current.stable.clone(),
                    _ => unreachable!(),
                };
                self.finalizer(stable, operation.clone())
            }
            CaptureInput::Finalized {
                correlation,
                outcome,
            } => {
                let CaptureState::Transitioning(current) = state else {
                    return Transition::Retired;
                };
                if current.stage != TransitionStage::Finalizing
                    || !Self::matching(&current.operation, correlation, FINALIZER_EFFECT_ID)
                {
                    return Transition::Retired;
                }
                let error = outcome.error.clone().unwrap_or_else(|| {
                    CaptureTransitionError::new(
                        super::CaptureFailureKind::RuntimeTransition,
                        "Capture effect was cancelled or terminated before completion",
                    )
                });
                Transition::RecoveryRequired(self.recovery(
                    current.stable.clone(),
                    &current.operation,
                    outcome.status.clone(),
                    error,
                ))
            }
            CaptureInput::Shutdown => {
                let projection = state.confirmed_projection().clone();
                let revision = state.revision().saturating_add(1);
                let correlation = Correlation {
                    machine_authority: self.machine_authority.clone(),
                    scope_epoch: self.scope_epoch,
                    operation_id: "shutdown".into(),
                    admitted_revision: revision,
                    effect_id: SHUTDOWN_EFFECT_ID,
                };
                let cancel = state.active_operation().map(|operation| {
                    CaptureEffect::Cancel(match state {
                        CaptureState::Transitioning(current) => match current.stage {
                            TransitionStage::Reserved => operation.correlation.clone(),
                            TransitionStage::Preflighting => {
                                operation.correlation.with_effect(PREFLIGHT_EFFECT_ID)
                            }
                            TransitionStage::Mutating => {
                                operation.correlation.with_effect(MUTATION_EFFECT_ID)
                            }
                            TransitionStage::Finalizing => {
                                operation.correlation.with_effect(FINALIZER_EFFECT_ID)
                            }
                        },
                        CaptureState::Reconciling(_) => {
                            operation.correlation.with_effect(OBSERVATION_EFFECT_ID)
                        }
                        _ => operation.correlation.clone(),
                    })
                });
                let shutdown = CaptureEffect::Shutdown {
                    correlation: correlation.clone(),
                    previous: projection.clone(),
                };
                let effects = match cancel {
                    Some(cancel) => EffectBatch::from_first(cancel, vec![shutdown]),
                    None => EffectBatch::one(shutdown),
                };
                Transition::EffectEmitting {
                    state: CaptureState::ShuttingDown(ShuttingDownCapture {
                        correlation,
                        projection,
                    }),
                    effects,
                }
            }
            CaptureInput::ShutdownFinished {
                correlation,
                result,
            } => {
                let CaptureState::ShuttingDown(current) = state else {
                    return Transition::Retired;
                };
                if current.correlation != *correlation {
                    return Transition::Retired;
                }
                let projection = result
                    .as_ref()
                    .ok()
                    .cloned()
                    .unwrap_or_else(|| current.projection.clone());
                Transition::Cancelled(CaptureState::Retired(RetiredCapture {
                    error: result.as_ref().err().cloned(),
                    projection,
                }))
            }
        }
    }

    fn state_label(&self, state: &Self::State) -> &'static str {
        match state {
            CaptureState::Stable(_) => "stable",
            CaptureState::Transitioning(state)
                if state.operation.mode == TransitionMode::RuntimeReplacement =>
            {
                "transitioning-runtime-replacement"
            }
            CaptureState::Transitioning(_) => "transitioning",
            CaptureState::Reconciling(_) => "reconciling",
            CaptureState::RecoveryRequired(_) => "recovery-required",
            CaptureState::ShuttingDown(_) => "shutting-down",
            CaptureState::Retired(_) => "retired",
        }
    }

    fn input_label(&self, input: &Self::Input) -> &'static str {
        match input {
            CaptureInput::Preflight { .. } => "preflight",
            CaptureInput::PreflightFinished { .. } => "preflight-finished",
            CaptureInput::Reserve { .. } => "reserve",
            CaptureInput::Start { .. } => "start",
            CaptureInput::ExecuteReserved { .. } => "execute-reserved",
            CaptureInput::FailReserved { .. } => "fail-reserved",
            CaptureInput::MutationFinished { .. } => "mutation-finished",
            CaptureInput::ObservationFinished { .. } => "observation-finished",
            CaptureInput::Audit { .. } => "audit",
            CaptureInput::AuditFinished { .. } => "audit-finished",
            CaptureInput::AuditCommitted { .. } => "audit-committed",
            CaptureInput::Recover { .. } => "recover",
            CaptureInput::RecoveryFinished { .. } => "recovery-finished",
            CaptureInput::Finalized { .. } => "finalized",
            CaptureInput::TaskFailed { failure, .. } => match failure {
                TaskFailure::Aborted => "task-aborted",
                TaskFailure::CompletionConflict => "task-completion-conflict",
                TaskFailure::Panicked => "task-panicked",
            },
            CaptureInput::TaskCancelled { .. } => "task-cancelled",
            CaptureInput::Shutdown => "shutdown",
            CaptureInput::ShutdownFinished { .. } => "shutdown-finished",
        }
    }

    fn input_correlation(&self, _state: &Self::State, input: &Self::Input) -> Option<Correlation> {
        match input {
            CaptureInput::PreflightFinished { correlation } => Some(correlation.clone()),
            CaptureInput::ExecuteReserved { operation, .. }
            | CaptureInput::FailReserved { operation, .. } => Some(operation.correlation.clone()),
            CaptureInput::MutationFinished { correlation, .. }
            | CaptureInput::ObservationFinished { correlation, .. }
            | CaptureInput::AuditFinished { correlation, .. }
            | CaptureInput::AuditCommitted { correlation, .. }
            | CaptureInput::RecoveryFinished { correlation, .. }
            | CaptureInput::Finalized { correlation, .. }
            | CaptureInput::TaskFailed { correlation, .. }
            | CaptureInput::TaskCancelled { correlation }
            | CaptureInput::ShutdownFinished { correlation, .. } => Some(correlation.clone()),
            CaptureInput::Preflight { .. }
            | CaptureInput::Reserve { .. }
            | CaptureInput::Start { .. }
            | CaptureInput::Audit { .. }
            | CaptureInput::Recover { .. }
            | CaptureInput::Shutdown => None,
        }
    }

    fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
        CaptureInput::TaskFailed {
            correlation,
            failure,
        }
    }

    fn shutdown(&self) -> Self::Input {
        CaptureInput::Shutdown
    }

    fn unavailable(&self) -> Self::Error {
        super::runtime_transition_error()
    }
}

pub(super) struct CaptureProjectionObserver {
    pub confirmed: Arc<std::sync::Mutex<Option<ConfirmedCaptureObserver>>>,
    pub machine_updates: tokio::sync::watch::Sender<u64>,
    pub updates: tokio::sync::broadcast::Sender<CaptureRuntimeStatus>,
}

impl TransitionObserver<CaptureMachine> for CaptureProjectionObserver {
    fn transitioned(
        &self,
        previous: &CaptureState,
        _input: &CaptureInput,
        current: &CaptureState,
        _disposition: Disposition,
    ) {
        self.machine_updates.send_modify(|revision| {
            *revision = revision.saturating_add(1);
        });
        let before = previous.projection();
        let after = current.projection();
        if before == after {
            return;
        }
        if !matches!(
            after.capture_operation.phase,
            CaptureOperationPhase::Pending
        ) && !matches!(
            current,
            CaptureState::ShuttingDown(_) | CaptureState::Retired(_)
        ) && let Some(observer) = self
            .confirmed
            .lock()
            .expect("confirmed Capture observer lock poisoned")
            .clone()
        {
            observer(after);
        }
        let _ = self.updates.send(after.clone());
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use mish_state_machine::{Disposition, RunnerConfig, spawn_runner};
    use tokio::sync::{Notify, watch};

    use super::*;
    use crate::{
        CaptureFailureKind, CaptureOperationStatus, CaptureSelection, SystemProxyObservedState,
        SystemProxyPhase, SystemProxyRuntimeStatus, TunPhase, TunRuntimeStatus,
    };

    fn machine() -> CaptureMachine {
        CaptureMachine {
            machine_authority: "capture-scope".into(),
            scope_epoch: 7,
        }
    }

    fn off_status() -> CaptureRuntimeStatus {
        CaptureRuntimeStatus {
            capture_operation: CaptureOperationStatus::idle("capture-scope".into()),
            capture_selection: CaptureSelection {
                system_proxy: false,
                tun: false,
            },
            system_proxy: SystemProxyRuntimeStatus {
                desired: false,
                failure: None,
                observed: SystemProxyObservedState::Disabled,
                phase: SystemProxyPhase::Off,
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled: false,
            tun: TunRuntimeStatus::off(),
            tun_enabled: false,
        }
    }

    fn initial() -> CaptureState {
        CaptureState::Stable(StableCapture {
            last_error: None,
            projection: off_status(),
            next_operation_id: 1,
            revision: 0,
        })
    }

    fn request() -> CaptureRequest {
        CaptureRequest {
            active: true,
            selection: CaptureSelection {
                system_proxy: true,
                tun: false,
            },
        }
    }

    fn transition_state(
        transition: Transition<CaptureState, CaptureEffect, CaptureTransitionError>,
    ) -> CaptureState {
        match transition {
            Transition::Accepted(state)
            | Transition::Committed(state)
            | Transition::Cancelled(state)
            | Transition::Failed(state)
            | Transition::RecoveryRequired(state)
            | Transition::EffectEmitting { state, .. } => state,
            other => panic!("transition did not carry state: {:?}", other.disposition()),
        }
    }

    #[test]
    fn transition_table_requires_mutation_and_authoritative_observation_before_applied() {
        let machine = machine();
        let transitioning = transition_state(machine.reduce(
            &initial(),
            &CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::Ordinary,
                operation_prefix: None,
                preflight: None,
                request: request(),
            },
        ));
        assert!(matches!(transitioning, CaptureState::Transitioning(_)));
        assert_eq!(
            transitioning.projection().capture_operation.phase,
            CaptureOperationPhase::Pending
        );
        assert_eq!(transitioning.projection().tun.phase, TunPhase::Off);

        let operation = transitioning.active_operation().unwrap().clone();
        let reconciling = transition_state(machine.reduce(
            &transitioning,
            &CaptureInput::MutationFinished {
                correlation: operation.correlation.with_effect(MUTATION_EFFECT_ID),
                outcome: EffectOutcome {
                    error: None,
                    status: operation.pending.clone(),
                },
            },
        ));
        assert!(matches!(reconciling, CaptureState::Reconciling(_)));
        assert_eq!(
            reconciling.projection().capture_operation.phase,
            CaptureOperationPhase::Pending
        );

        let mut observed = off_status();
        observed.capture_selection = request().selection;
        observed.system_proxy.desired = true;
        observed.system_proxy.observed = SystemProxyObservedState::Mish;
        observed.system_proxy.phase = SystemProxyPhase::Applied;
        observed.system_proxy_enabled = true;
        let committed = machine.reduce(
            &reconciling,
            &CaptureInput::ObservationFinished {
                correlation: operation.correlation.with_effect(OBSERVATION_EFFECT_ID),
                outcome: EffectOutcome {
                    error: None,
                    status: observed,
                },
            },
        );
        assert_eq!(committed.disposition(), Disposition::Committed);
        let stable = transition_state(committed);
        assert!(matches!(stable, CaptureState::Stable(_)));
        assert_eq!(
            stable.projection().capture_operation.phase,
            CaptureOperationPhase::Applied
        );
    }

    #[test]
    fn runtime_replacement_prefixes_internal_correlation_without_changing_public_operation_id() {
        let machine = machine();
        let transitioning = transition_state(machine.reduce(
            &initial(),
            &CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::RuntimeReplacement,
                operation_prefix: Some("profile-command".into()),
                preflight: None,
                request: request(),
            },
        ));
        let CaptureState::Transitioning(current) = transitioning else {
            panic!("runtime replacement must enter the Capture transition machine");
        };
        assert_eq!(
            current.operation.correlation.operation_id,
            "profile-command-1"
        );
        assert_eq!(
            current
                .operation
                .pending
                .capture_operation
                .operation_id
                .as_deref(),
            Some("1")
        );
    }

    #[test]
    fn pending_projection_only_marks_capture_backends_involved_in_the_request() {
        let machine = machine();
        let tun_request = CaptureRequest {
            active: true,
            selection: CaptureSelection {
                system_proxy: false,
                tun: true,
            },
        };
        let transitioning = transition_state(machine.reduce(
            &initial(),
            &CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::Ordinary,
                operation_prefix: None,
                preflight: None,
                request: tun_request,
            },
        ));

        assert_eq!(
            transitioning.projection().capture_operation.phase,
            CaptureOperationPhase::Pending
        );
        assert_eq!(
            transitioning.projection().system_proxy.phase,
            SystemProxyPhase::Off,
            "a TUN-only transition must not present System Proxy as pending"
        );
        assert!(!transitioning.projection().system_proxy.desired);
        assert_eq!(transitioning.projection().tun.phase, TunPhase::Pending);
        assert!(transitioning.projection().tun.desired);
    }

    #[test]
    fn duplicate_stale_and_equal_revision_conflicts_never_mutate_the_active_operation() {
        let machine = machine();
        let reserved = transition_state(machine.reduce(
            &initial(),
            &CaptureInput::Reserve {
                request: request(),
                mode: TransitionMode::Prepared,
            },
        ));
        assert_eq!(
            machine
                .reduce(
                    &reserved,
                    &CaptureInput::Reserve {
                        request: request(),
                        mode: TransitionMode::Prepared,
                    },
                )
                .disposition(),
            Disposition::Rejected
        );

        let token = reserved.operation().unwrap();
        let mut conflicting = token.clone();
        conflicting.correlation.operation_id = "equal-revision-conflict".into();
        assert_eq!(
            machine
                .reduce(
                    &reserved,
                    &CaptureInput::ExecuteReserved {
                        core_healthy: true,
                        operation: conflicting,
                        preflight: None,
                        request: request(),
                    },
                )
                .disposition(),
            Disposition::Retired
        );

        let operation = reserved.active_operation().unwrap();
        let mut stale = operation.correlation.with_effect(MUTATION_EFFECT_ID);
        stale.admitted_revision = stale.admitted_revision.saturating_sub(1);
        assert_eq!(
            machine
                .reduce(
                    &reserved,
                    &CaptureInput::MutationFinished {
                        correlation: stale,
                        outcome: EffectOutcome {
                            error: None,
                            status: off_status(),
                        },
                    },
                )
                .disposition(),
            Disposition::Retired
        );
        assert_eq!(
            reserved.projection().capture_operation.phase,
            CaptureOperationPhase::Pending
        );
    }

    #[test]
    fn reserved_failure_cancels_preflight_before_publishing_terminal_state() {
        let machine = machine();
        let reserved = transition_state(machine.reduce(
            &initial(),
            &CaptureInput::Reserve {
                request: request(),
                mode: TransitionMode::Prepared,
            },
        ));
        let operation = reserved.operation().unwrap();
        let (reply, _response) = tokio::sync::oneshot::channel();
        let preflighting = transition_state(machine.reduce(
            &reserved,
            &CaptureInput::Preflight {
                cancellation: CancellationToken::new(),
                reply: Arc::new(Mutex::new(Some(reply))),
                request: request(),
            },
        ));
        assert!(matches!(
            preflighting,
            CaptureState::Transitioning(TransitioningCapture {
                stage: TransitionStage::Preflighting,
                ..
            })
        ));

        let cancellation = machine.reduce(
            &preflighting,
            &CaptureInput::FailReserved {
                error: CaptureTransitionError::new(
                    CaptureFailureKind::RuntimeTransition,
                    "Profile activation failed during Capture preflight",
                ),
                operation: operation.clone(),
            },
        );
        assert_eq!(cancellation.disposition(), Disposition::EffectEmitting);
        let cancellation = transition_state(cancellation);
        assert_eq!(
            cancellation.projection().capture_operation.phase,
            CaptureOperationPhase::Pending,
            "the public operation stays Pending until preflight cleanup finishes"
        );

        let terminal = machine.reduce(
            &cancellation,
            &CaptureInput::PreflightFinished {
                correlation: operation.correlation.with_effect(PREFLIGHT_EFFECT_ID),
            },
        );
        assert_eq!(terminal.disposition(), Disposition::Failed);
        assert_eq!(
            transition_state(terminal)
                .projection()
                .capture_operation
                .phase,
            CaptureOperationPhase::Failed
        );
    }

    #[test]
    fn bounded_model_never_reaches_applied_without_a_successful_observation() {
        let machine = machine();
        for mutation_error in [None, Some(CaptureFailureKind::ApplyFailed)] {
            for observation_error in [None, Some(CaptureFailureKind::ObservationFailed)] {
                let transitioning = transition_state(machine.reduce(
                    &initial(),
                    &CaptureInput::Start {
                        core_healthy: true,
                        mode: TransitionMode::Ordinary,
                        operation_prefix: None,
                        preflight: None,
                        request: request(),
                    },
                ));
                let operation = transitioning.active_operation().unwrap().clone();
                let mutation = machine.reduce(
                    &transitioning,
                    &CaptureInput::MutationFinished {
                        correlation: operation.correlation.with_effect(MUTATION_EFFECT_ID),
                        outcome: EffectOutcome {
                            error: mutation_error.map(|kind| {
                                CaptureTransitionError::new(kind, "injected mutation failure")
                            }),
                            status: operation.pending.clone(),
                        },
                    },
                );
                let after_mutation = transition_state(mutation);
                assert_ne!(
                    after_mutation.projection().capture_operation.phase,
                    CaptureOperationPhase::Applied
                );

                if mutation_error.is_some() {
                    assert!(!matches!(after_mutation, CaptureState::Reconciling(_)));
                    continue;
                }

                let mut observed = off_status();
                observed.capture_selection = request().selection;
                observed.system_proxy.desired = true;
                observed.system_proxy.observed = SystemProxyObservedState::Mish;
                observed.system_proxy.phase = SystemProxyPhase::Applied;
                observed.system_proxy_enabled = true;
                let terminal = transition_state(machine.reduce(
                    &after_mutation,
                    &CaptureInput::ObservationFinished {
                        correlation: operation.correlation.with_effect(OBSERVATION_EFFECT_ID),
                        outcome: EffectOutcome {
                            error: observation_error.map(|kind| {
                                CaptureTransitionError::new(kind, "injected observation failure")
                            }),
                            status: observed,
                        },
                    },
                ));
                assert_eq!(
                    terminal.projection().capture_operation.phase == CaptureOperationPhase::Applied,
                    observation_error.is_none()
                );
            }
        }
    }

    #[test]
    fn replacement_before_during_and_after_retires_the_foreign_completion() {
        let old_machine = machine();
        let old_transitioning = transition_state(old_machine.reduce(
            &initial(),
            &CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::Ordinary,
                operation_prefix: None,
                preflight: None,
                request: request(),
            },
        ));
        let old_operation = old_transitioning.active_operation().unwrap().clone();

        let new_machine = CaptureMachine {
            machine_authority: "replacement-authority".into(),
            scope_epoch: 8,
        };
        let mut foreign = old_operation.correlation.with_effect(MUTATION_EFFECT_ID);
        foreign.machine_authority = new_machine.machine_authority.clone();
        foreign.scope_epoch = new_machine.scope_epoch;
        assert_eq!(
            old_machine
                .reduce(
                    &initial(),
                    &CaptureInput::MutationFinished {
                        correlation: foreign.clone(),
                        outcome: EffectOutcome {
                            error: None,
                            status: off_status(),
                        },
                    },
                )
                .disposition(),
            Disposition::Retired
        );
        assert_eq!(
            old_machine
                .reduce(
                    &old_transitioning,
                    &CaptureInput::MutationFinished {
                        correlation: foreign,
                        outcome: EffectOutcome {
                            error: None,
                            status: off_status(),
                        },
                    },
                )
                .disposition(),
            Disposition::Retired
        );

        let replacement = transition_state(new_machine.reduce(
            &CaptureState::Stable(StableCapture {
                last_error: None,
                projection: off_status(),
                next_operation_id: 1,
                revision: 0,
            }),
            &CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::RuntimeReplacement,
                operation_prefix: None,
                preflight: None,
                request: request(),
            },
        ));
        assert_eq!(
            new_machine
                .reduce(
                    &replacement,
                    &CaptureInput::MutationFinished {
                        correlation: old_operation.correlation.with_effect(MUTATION_EFFECT_ID),
                        outcome: EffectOutcome {
                            error: None,
                            status: off_status(),
                        },
                    },
                )
                .disposition(),
            Disposition::Retired
        );
        assert_eq!(
            replacement.projection().capture_operation.phase,
            CaptureOperationPhase::Pending
        );
    }

    #[test]
    fn cancellation_panic_abort_and_completion_conflict_all_enter_owned_finalization() {
        let machine = machine();
        for failure in [
            TaskFailure::Aborted,
            TaskFailure::CompletionConflict,
            TaskFailure::Panicked,
        ] {
            let transitioning = transition_state(machine.reduce(
                &initial(),
                &CaptureInput::Start {
                    core_healthy: true,
                    mode: TransitionMode::Ordinary,
                    operation_prefix: None,
                    preflight: None,
                    request: request(),
                },
            ));
            let correlation = transitioning
                .active_operation()
                .unwrap()
                .correlation
                .with_effect(MUTATION_EFFECT_ID);
            let finalizing = machine.reduce(
                &transitioning,
                &CaptureInput::TaskFailed {
                    correlation,
                    failure,
                },
            );
            assert_eq!(finalizing.disposition(), Disposition::EffectEmitting);
            let finalizing = transition_state(finalizing);
            assert!(matches!(
                finalizing,
                CaptureState::Transitioning(TransitioningCapture {
                    stage: TransitionStage::Finalizing,
                    ..
                })
            ));
        }
    }

    #[derive(Clone, Copy)]
    enum TestMode {
        Barrier,
        Panic,
        PausedObservation,
    }

    struct TestEffects {
        mode: TestMode,
        release: Arc<Notify>,
        started: Arc<Notify>,
    }

    impl TestEffects {
        fn outcome(status: CaptureRuntimeStatus) -> EffectOutcome {
            EffectOutcome {
                error: None,
                status,
            }
        }
    }

    impl CaptureEffects for TestEffects {
        fn preflight(
            &self,
            _request: CaptureRequest,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<CapturePreflight, CaptureTransitionError>>
                    + Send
                    + 'static,
            >,
        > {
            Box::pin(future::ready(Ok(CapturePreflight {
                reconciler_id: 7,
                system_proxy: None,
            })))
        }

        fn mutate(
            &self,
            _request: CaptureRequest,
            _core_healthy: bool,
            _preflight: Option<CapturePreflight>,
            previous: CaptureRuntimeStatus,
        ) -> Pin<Box<dyn Future<Output = EffectOutcome> + Send + 'static>> {
            let mode = self.mode;
            let release = self.release.clone();
            let started = self.started.clone();
            Box::pin(async move {
                started.notify_one();
                match mode {
                    TestMode::Barrier => {
                        release.notified().await;
                        Self::outcome(previous)
                    }
                    TestMode::Panic => panic!("injected Capture mutation panic"),
                    TestMode::PausedObservation => Self::outcome(previous),
                }
            })
        }

        fn observe(
            &self,
            _request: CaptureRequest,
            _core_healthy: bool,
        ) -> Pin<Box<dyn Future<Output = EffectOutcome> + Send + 'static>> {
            let mode = self.mode;
            Box::pin(async move {
                if matches!(mode, TestMode::PausedObservation) {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                if matches!(mode, TestMode::Panic) {
                    return EffectOutcome {
                        error: Some(CaptureTransitionError::new(
                            CaptureFailureKind::ObservationFailed,
                            "finalizer observation failed",
                        )),
                        status: off_status(),
                    };
                }
                Self::outcome(off_status())
            })
        }

        fn audit(
            &self,
            _reason: CaptureAuditReason,
            _core_healthy: bool,
            previous: CaptureRuntimeStatus,
        ) -> Pin<Box<dyn Future<Output = AuditOutcome> + Send + 'static>> {
            Box::pin(future::ready(AuditOutcome {
                error: None,
                mutated: false,
                status: previous,
            }))
        }

        fn recover(
            &self,
            _action: CaptureRecoveryAction,
            _core_healthy: bool,
            _request: CaptureRequest,
        ) -> Pin<Box<dyn Future<Output = EffectOutcome> + Send + 'static>> {
            Box::pin(future::ready(Self::outcome(off_status())))
        }

        fn shutdown(
            &self,
            previous: CaptureRuntimeStatus,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<CaptureRuntimeStatus, CaptureTransitionError>>
                    + Send
                    + 'static,
            >,
        > {
            Box::pin(future::ready(Ok(previous)))
        }
    }

    fn runner(
        mode: TestMode,
    ) -> (
        mish_state_machine::RunnerHandle<CaptureMachine>,
        Arc<Notify>,
        Arc<Notify>,
        watch::Receiver<u64>,
    ) {
        let release = Arc::new(Notify::new());
        let started = Arc::new(Notify::new());
        let (updates, _) = tokio::sync::broadcast::channel(8);
        let (machine_updates, receiver) = watch::channel(0);
        let runner = spawn_runner(
            Arc::new(machine()),
            initial(),
            Arc::new(CaptureExecutor {
                effects: Arc::new(TestEffects {
                    mode,
                    release: release.clone(),
                    started: started.clone(),
                }),
            }),
            Arc::new(CaptureProjectionObserver {
                confirmed: Arc::new(Mutex::new(None)),
                machine_updates,
                updates,
            }),
            RunnerConfig {
                shutdown_grace: Duration::from_millis(20),
                ..RunnerConfig::default()
            },
        );
        (runner, release, started, receiver)
    }

    async fn wait_until(
        receiver: &mut watch::Receiver<u64>,
        predicate: impl Fn(&CaptureState) -> bool,
        runner: &mish_state_machine::RunnerHandle<CaptureMachine>,
    ) {
        loop {
            if predicate(&runner.snapshot()) {
                return;
            }
            receiver.changed().await.unwrap();
        }
    }

    #[tokio::test]
    async fn barrier_shutdown_cancels_owned_work_and_retires_after_the_shutdown_finalizer() {
        let (runner, _release, started, _updates) = runner(TestMode::Barrier);
        runner
            .admit(CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::Ordinary,
                operation_prefix: None,
                preflight: None,
                request: request(),
            })
            .await
            .unwrap();
        started.notified().await;
        let retired = runner.shutdown().await;
        assert_eq!(retired.disposition, Disposition::EffectEmitting);
        assert!(matches!(retired.state, CaptureState::Retired(_)));
    }

    #[tokio::test]
    async fn panicked_effect_is_reobserved_and_ends_recovery_required() {
        let (runner, _release, started, mut updates) = runner(TestMode::Panic);
        runner
            .admit(CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::Ordinary,
                operation_prefix: None,
                preflight: None,
                request: request(),
            })
            .await
            .unwrap();
        started.notified().await;
        wait_until(
            &mut updates,
            |state| matches!(state, CaptureState::RecoveryRequired(_)),
            &runner,
        )
        .await;
        assert_eq!(
            runner.snapshot().projection().capture_operation.phase,
            CaptureOperationPhase::RecoveryRequired
        );
        let _ = runner.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn paused_time_observation_barrier_keeps_pending_until_authoritative_completion() {
        let (runner, _release, started, mut updates) = runner(TestMode::PausedObservation);
        runner
            .admit(CaptureInput::Start {
                core_healthy: true,
                mode: TransitionMode::Ordinary,
                operation_prefix: None,
                preflight: None,
                request: request(),
            })
            .await
            .unwrap();
        started.notified().await;
        wait_until(
            &mut updates,
            |state| matches!(state, CaptureState::Reconciling(_)),
            &runner,
        )
        .await;
        assert_eq!(
            runner.snapshot().projection().capture_operation.phase,
            CaptureOperationPhase::Pending
        );
        tokio::time::advance(Duration::from_secs(5)).await;
        wait_until(
            &mut updates,
            |state| matches!(state, CaptureState::Stable(_)),
            &runner,
        )
        .await;
        assert_eq!(
            runner.snapshot().projection().capture_operation.phase,
            CaptureOperationPhase::Applied
        );
        let _ = runner.shutdown().await;
    }
}
