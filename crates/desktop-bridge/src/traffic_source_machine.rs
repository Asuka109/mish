use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use mish_runtime::{
    TrafficCommandAuthority, TrafficCommandExecution, TrafficCommandFailureKind,
    TrafficCommandOperation, TrafficSourceEvidencePhase, TrafficTransitionDisposition,
};
use mish_state_machine::{
    CorrelatedEffect, Correlation, Disposition, EffectBatch, EffectMode, Machine, TaskFailure,
    Transition, TransitionObserver,
};

pub(crate) const TRAFFIC_COMMAND_LEDGER_LIMIT: usize = 32;
pub(crate) const TRAFFIC_TRANSITION_EVIDENCE_LIMIT: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrafficSourceContext {
    pub(crate) capture_id: Option<String>,
    pub(crate) controller_generation: u64,
    pub(crate) profile_id: String,
    pub(crate) runtime_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrafficSourceStamp {
    pub(crate) context: TrafficSourceContext,
    pub(crate) sequence: u64,
    pub(crate) session_id: String,
}

impl TrafficSourceStamp {
    pub(crate) fn same_session(&self, other: &Self) -> bool {
        self.context == other.context && self.session_id == other.session_id
    }

    pub(crate) fn matches_command_authority(&self, authority: &TrafficCommandAuthority) -> bool {
        self.context.profile_id == authority.profile_id
            && self.session_id == authority.session_id
            && self.sequence == authority.sequence
    }

    pub(crate) fn matches_session_authority(&self, authority: &TrafficCommandAuthority) -> bool {
        self.context.profile_id == authority.profile_id && self.session_id == authority.session_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TrafficSourceEndReason {
    CoreExited,
    NetworkChanged,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TrafficSourceGapReason {
    Cancelled,
    CompletionConflict,
    ObservationFailed,
    Panicked,
    SequenceGap,
    Sleep,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TrafficSourceAuthority {
    Binding {
        context: TrafficSourceContext,
    },
    Live(TrafficSourceStamp),
    Replacing {
        candidate: TrafficSourceContext,
        retired: Option<TrafficSourceStamp>,
    },
    Ended {
        last: Option<TrafficSourceStamp>,
        reason: TrafficSourceEndReason,
    },
    FailedReconciling {
        context: TrafficSourceContext,
        last: Option<TrafficSourceStamp>,
        reason: TrafficSourceGapReason,
    },
    Retired {
        last: Option<TrafficSourceStamp>,
        reason: TrafficSourceEndReason,
    },
}

impl TrafficSourceAuthority {
    pub(crate) fn live(&self) -> Option<&TrafficSourceStamp> {
        match self {
            Self::Live(stamp) => Some(stamp),
            _ => None,
        }
    }

    fn last(&self) -> Option<TrafficSourceStamp> {
        match self {
            Self::Live(stamp) => Some(stamp.clone()),
            Self::Replacing { retired, .. }
            | Self::Ended { last: retired, .. }
            | Self::FailedReconciling { last: retired, .. }
            | Self::Retired { last: retired, .. } => retired.clone(),
            Self::Binding { .. } => None,
        }
    }

    fn current_context(&self) -> Option<&TrafficSourceContext> {
        match self {
            Self::Binding { context }
            | Self::Replacing {
                candidate: context, ..
            }
            | Self::FailedReconciling { context, .. } => Some(context),
            Self::Live(stamp) => Some(&stamp.context),
            Self::Ended { .. } | Self::Retired { .. } => None,
        }
    }

    fn phase(&self) -> TrafficSourceEvidencePhase {
        match self {
            Self::Binding { .. } => TrafficSourceEvidencePhase::Binding,
            Self::Live(_) => TrafficSourceEvidencePhase::Live,
            Self::Replacing { .. } => TrafficSourceEvidencePhase::Replacing,
            Self::Ended { .. } => TrafficSourceEvidencePhase::Ended,
            Self::FailedReconciling { .. } => TrafficSourceEvidencePhase::FailedReconciling,
            Self::Retired { .. } => TrafficSourceEvidencePhase::Retired,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrafficCommandRequest {
    pub(crate) admitted_target_count: usize,
    pub(crate) authority: TrafficCommandAuthority,
    pub(crate) operation: TrafficCommandOperation,
    pub(crate) operation_id: String,
    pub(crate) requested_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrafficCommandRecord {
    pub(crate) execution: TrafficCommandExecution,
    pub(crate) request: TrafficCommandRequest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingTrafficCommand {
    correlation: Correlation,
    request: TrafficCommandRequest,
    source: TrafficSourceStamp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrafficSourceMachineState {
    pub(crate) authority: TrafficSourceAuthority,
    machine_authority: String,
    pending: Option<PendingTrafficCommand>,
    completed: VecDeque<TrafficCommandRecord>,
    revision: u64,
}

impl TrafficSourceMachineState {
    pub(crate) fn binding(machine_authority: String, context: TrafficSourceContext) -> Self {
        Self {
            authority: TrafficSourceAuthority::Binding { context },
            machine_authority,
            pending: None,
            completed: VecDeque::with_capacity(TRAFFIC_COMMAND_LEDGER_LIMIT),
            revision: 0,
        }
    }

    pub(crate) fn command_result(&self, operation_id: &str) -> Option<TrafficCommandExecution> {
        self.completed
            .iter()
            .find(|record| record.request.operation_id == operation_id)
            .map(|record| record.execution.clone())
    }

    pub(crate) fn command_is_pending(&self, operation_id: &str) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.request.operation_id == operation_id)
    }

    pub(crate) fn effect_is_current_for_source(
        &self,
        correlation: &Correlation,
        source: &TrafficSourceStamp,
    ) -> bool {
        self.pending.as_ref().is_some_and(|pending| {
            pending.correlation == *correlation
                && pending.source.same_session(source)
                && self
                    .authority
                    .live()
                    .is_some_and(|current| current.same_session(source))
        })
    }

    fn next_revision(&self) -> u64 {
        self.revision
            .checked_add(1)
            .expect("Traffic source-machine revision exhausted")
    }

    fn with_authority(&self, authority: TrafficSourceAuthority) -> Self {
        let mut next = self.clone();
        next.authority = authority;
        next.revision = self.next_revision();
        next
    }

    fn finish(&self, request: TrafficCommandRequest, execution: TrafficCommandExecution) -> Self {
        let mut next = self.clone();
        next.pending = None;
        next.revision = self.next_revision();
        next.completed
            .push_back(TrafficCommandRecord { execution, request });
        while next.completed.len() > TRAFFIC_COMMAND_LEDGER_LIMIT {
            next.completed.pop_front();
        }
        next
    }

    fn fail_pending(
        &self,
        failure: TrafficCommandFailureKind,
    ) -> (Self, Option<TrafficSourceEffect>) {
        let Some(pending) = &self.pending else {
            return (self.clone(), None);
        };
        let target_ids = pending.request.requested_ids.clone().unwrap_or_default();
        let next = self.finish(
            pending.request.clone(),
            TrafficCommandExecution::failure(
                pending.request.operation,
                failure,
                pending.request.admitted_target_count,
                target_ids,
            ),
        );
        (
            next,
            Some(TrafficSourceEffect::Cancel(pending.correlation.clone())),
        )
    }
}

#[derive(Clone, Debug)]
pub(crate) enum TrafficSourceInput {
    BeginBinding(TrafficSourceContext),
    Baseline(TrafficSourceStamp),
    Observation(TrafficSourceStamp),
    Gap {
        context: TrafficSourceContext,
        reason: TrafficSourceGapReason,
    },
    End(TrafficSourceEndReason),
    Request(TrafficCommandRequest),
    Completed {
        correlation: Correlation,
        execution: TrafficCommandExecution,
        source: TrafficSourceStamp,
    },
    EffectFailed {
        correlation: Correlation,
        failure: TaskFailure,
    },
    Shutdown,
}

#[derive(Clone, Debug)]
pub(crate) enum TrafficSourceEffect {
    Execute(Box<TrafficCommandEffect>),
    Cancel(Correlation),
}

#[derive(Clone, Debug)]
pub(crate) struct TrafficCommandEffect {
    pub(crate) correlation: Correlation,
    pub(crate) request: TrafficCommandRequest,
    pub(crate) source: TrafficSourceStamp,
}

impl CorrelatedEffect for TrafficSourceEffect {
    fn correlation(&self) -> &Correlation {
        match self {
            Self::Execute(effect) => &effect.correlation,
            Self::Cancel(correlation) => correlation,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TrafficSourceMachineError {
    Conflict,
    InvalidAuthority,
    Retired,
}

pub(crate) struct TrafficSourceMachine;

impl TrafficSourceMachine {
    fn transition_authority(
        state: &TrafficSourceMachineState,
        authority: TrafficSourceAuthority,
        command_failure: TrafficCommandFailureKind,
    ) -> Transition<TrafficSourceMachineState, TrafficSourceEffect, TrafficSourceMachineError> {
        let (mut next, cancel) = state.fail_pending(command_failure);
        next.authority = authority;
        if next.revision == state.revision {
            next.revision = state.next_revision();
        }
        match cancel {
            Some(cancel) => Transition::EffectEmitting {
                state: next,
                effects: EffectBatch::one(cancel),
            },
            None => Transition::Committed(next),
        }
    }

    fn command_matches_pending(
        pending: &PendingTrafficCommand,
        request: &TrafficCommandRequest,
    ) -> bool {
        pending.request == *request
    }
}

impl Machine for TrafficSourceMachine {
    type State = TrafficSourceMachineState;
    type Input = TrafficSourceInput;
    type Effect = TrafficSourceEffect;
    type Error = TrafficSourceMachineError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        if matches!(state.authority, TrafficSourceAuthority::Retired { .. }) {
            return match input {
                TrafficSourceInput::Shutdown => Transition::Unchanged,
                TrafficSourceInput::Request(_) => {
                    Transition::Rejected(TrafficSourceMachineError::Retired)
                }
                _ => Transition::Retired,
            };
        }
        match input {
            TrafficSourceInput::BeginBinding(context) => {
                if matches!(
                    &state.authority,
                    TrafficSourceAuthority::Binding { context: current }
                        if current == context
                ) {
                    return Transition::Unchanged;
                }
                let retired = state.authority.last();
                Self::transition_authority(
                    state,
                    TrafficSourceAuthority::Replacing {
                        candidate: context.clone(),
                        retired,
                    },
                    TrafficCommandFailureKind::RuntimeReplaced,
                )
            }
            TrafficSourceInput::Baseline(stamp) => {
                let context_matches = match &state.authority {
                    TrafficSourceAuthority::Binding { context }
                    | TrafficSourceAuthority::Replacing {
                        candidate: context, ..
                    }
                    | TrafficSourceAuthority::FailedReconciling { context, .. } => {
                        context == &stamp.context
                    }
                    TrafficSourceAuthority::Live(current) => current.same_session(stamp),
                    TrafficSourceAuthority::Ended { .. }
                    | TrafficSourceAuthority::Retired { .. } => false,
                };
                if !context_matches || stamp.sequence == 0 || stamp.session_id.is_empty() {
                    return Transition::Rejected(TrafficSourceMachineError::InvalidAuthority);
                }
                if let Some(current) = state.authority.live() {
                    if current == stamp {
                        return Transition::Unchanged;
                    }
                    if stamp.sequence < current.sequence {
                        return Transition::Retired;
                    }
                }
                Transition::Committed(
                    state.with_authority(TrafficSourceAuthority::Live(stamp.clone())),
                )
            }
            TrafficSourceInput::Observation(stamp) => {
                let Some(current) = state.authority.live() else {
                    return Transition::Retired;
                };
                if !current.same_session(stamp) || stamp.sequence < current.sequence {
                    return Transition::Retired;
                }
                if stamp.sequence == current.sequence {
                    return Transition::Unchanged;
                }
                if stamp.sequence != current.sequence.saturating_add(1) {
                    return Self::transition_authority(
                        state,
                        TrafficSourceAuthority::FailedReconciling {
                            context: stamp.context.clone(),
                            last: Some(current.clone()),
                            reason: TrafficSourceGapReason::SequenceGap,
                        },
                        TrafficCommandFailureKind::InconsistentObservation,
                    );
                }
                Transition::Committed(
                    state.with_authority(TrafficSourceAuthority::Live(stamp.clone())),
                )
            }
            TrafficSourceInput::Gap { context, reason } => {
                if state.authority.current_context() != Some(context) {
                    return Transition::Retired;
                }
                Self::transition_authority(
                    state,
                    TrafficSourceAuthority::FailedReconciling {
                        context: context.clone(),
                        last: state.authority.last(),
                        reason: *reason,
                    },
                    TrafficCommandFailureKind::Disconnected,
                )
            }
            TrafficSourceInput::End(reason) => Self::transition_authority(
                state,
                TrafficSourceAuthority::Ended {
                    last: state.authority.last(),
                    reason: *reason,
                },
                TrafficCommandFailureKind::RuntimeReplaced,
            ),
            TrafficSourceInput::Request(request) => {
                if let Some(record) = state
                    .completed
                    .iter()
                    .find(|record| record.request.operation_id == request.operation_id)
                {
                    return if record.request == *request {
                        Transition::Unchanged
                    } else {
                        Transition::Rejected(TrafficSourceMachineError::Conflict)
                    };
                }
                if let Some(pending) = &state.pending {
                    return if Self::command_matches_pending(pending, request) {
                        Transition::Unchanged
                    } else {
                        Transition::Rejected(TrafficSourceMachineError::Conflict)
                    };
                }
                let Some(source) = state.authority.live() else {
                    return Transition::Rejected(TrafficSourceMachineError::InvalidAuthority);
                };
                let authority_matches = match request.operation {
                    TrafficCommandOperation::CloseFilteredVisible => {
                        source.matches_session_authority(&request.authority)
                    }
                    TrafficCommandOperation::CloseConnection
                    | TrafficCommandOperation::CloseAllActive => {
                        source.matches_command_authority(&request.authority)
                    }
                };
                if !authority_matches {
                    return Transition::Rejected(TrafficSourceMachineError::InvalidAuthority);
                }
                let admitted_revision = state.next_revision();
                let correlation = Correlation {
                    admitted_revision,
                    effect_id: 1,
                    machine_authority: state.machine_authority.clone(),
                    operation_id: request.operation_id.clone(),
                    scope_epoch: source.context.controller_generation,
                };
                let mut next = state.clone();
                next.revision = admitted_revision;
                next.pending = Some(PendingTrafficCommand {
                    correlation: correlation.clone(),
                    request: request.clone(),
                    source: source.clone(),
                });
                Transition::EffectEmitting {
                    state: next,
                    effects: EffectBatch::one(TrafficSourceEffect::Execute(Box::new(
                        TrafficCommandEffect {
                            correlation,
                            request: request.clone(),
                            source: source.clone(),
                        },
                    ))),
                }
            }
            TrafficSourceInput::Completed {
                correlation,
                execution,
                source,
            } => {
                let Some(pending) = &state.pending else {
                    return Transition::Retired;
                };
                if pending.correlation != *correlation
                    || !pending.source.same_session(source)
                    || !state
                        .authority
                        .live()
                        .is_some_and(|current| current.same_session(source))
                {
                    return Transition::Retired;
                }
                Transition::Committed(state.finish(pending.request.clone(), execution.clone()))
            }
            TrafficSourceInput::EffectFailed {
                correlation,
                failure,
            } => {
                let Some(pending) = &state.pending else {
                    return Transition::Retired;
                };
                if pending.correlation != *correlation {
                    return Transition::Retired;
                }
                let reason = match failure {
                    TaskFailure::Aborted => TrafficSourceGapReason::Cancelled,
                    TaskFailure::CompletionConflict => TrafficSourceGapReason::CompletionConflict,
                    TaskFailure::Panicked => TrafficSourceGapReason::Panicked,
                };
                let target_ids = pending.request.requested_ids.clone().unwrap_or_default();
                let mut next = state.finish(
                    pending.request.clone(),
                    TrafficCommandExecution::failure(
                        pending.request.operation,
                        TrafficCommandFailureKind::InconsistentObservation,
                        pending.request.admitted_target_count,
                        target_ids,
                    ),
                );
                next.authority = TrafficSourceAuthority::FailedReconciling {
                    context: pending.source.context.clone(),
                    last: Some(pending.source.clone()),
                    reason,
                };
                Transition::RecoveryRequired(next)
            }
            TrafficSourceInput::Shutdown => {
                let (mut next, cancel) =
                    state.fail_pending(TrafficCommandFailureKind::Disconnected);
                next.authority = TrafficSourceAuthority::Retired {
                    last: state.authority.last(),
                    reason: TrafficSourceEndReason::Shutdown,
                };
                if next.revision == state.revision {
                    next.revision = state.next_revision();
                }
                match cancel {
                    Some(cancel) => Transition::EffectEmitting {
                        state: next,
                        effects: EffectBatch::one(cancel),
                    },
                    None => Transition::Committed(next),
                }
            }
        }
    }

    fn input_correlation(&self, _state: &Self::State, input: &Self::Input) -> Option<Correlation> {
        match input {
            TrafficSourceInput::Completed { correlation, .. }
            | TrafficSourceInput::EffectFailed { correlation, .. } => Some(correlation.clone()),
            _ => None,
        }
    }

    fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
        state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.correlation == *correlation)
    }

    fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
        TrafficSourceInput::EffectFailed {
            correlation,
            failure,
        }
    }

    fn shutdown(&self) -> Self::Input {
        TrafficSourceInput::Shutdown
    }

    fn unavailable(&self) -> Self::Error {
        TrafficSourceMachineError::Retired
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrafficTransitionEvidence {
    pub(crate) disposition: TrafficTransitionDisposition,
    pub(crate) effect_sequence: Option<u64>,
    pub(crate) failure: Option<TrafficCommandFailureKind>,
    pub(crate) operation: Option<TrafficCommandOperation>,
    pub(crate) phase: TrafficSourceEvidencePhase,
    pub(crate) revision: u64,
    pub(crate) target_count: Option<usize>,
}

#[derive(Default)]
pub(crate) struct TrafficTransitionEvidenceBuffer {
    records: Mutex<VecDeque<TrafficTransitionEvidence>>,
}

impl TrafficTransitionEvidenceBuffer {
    pub(crate) fn snapshot(&self) -> Vec<TrafficTransitionEvidence> {
        self.records
            .lock()
            .expect("Traffic transition evidence lock poisoned")
            .iter()
            .cloned()
            .collect()
    }
}

pub(crate) struct TrafficSourceObserver {
    pub(crate) evidence: Arc<TrafficTransitionEvidenceBuffer>,
    pub(crate) updates: tokio::sync::broadcast::Sender<()>,
}

impl TransitionObserver<TrafficSourceMachine> for TrafficSourceObserver {
    fn transitioned(
        &self,
        _previous: &TrafficSourceMachineState,
        input: &TrafficSourceInput,
        current: &TrafficSourceMachineState,
        disposition: Disposition,
    ) {
        let (operation, effect_sequence, target_count, failure) = match input {
            TrafficSourceInput::Request(request) => (
                Some(request.operation),
                current
                    .pending
                    .as_ref()
                    .map(|pending| pending.correlation.effect_id),
                Some(request.admitted_target_count),
                None,
            ),
            TrafficSourceInput::Completed { execution, .. } => (
                Some(execution.operation),
                Some(1),
                Some(execution.target_count),
                execution.failure,
            ),
            TrafficSourceInput::EffectFailed { .. } => (
                None,
                Some(1),
                None,
                Some(TrafficCommandFailureKind::InconsistentObservation),
            ),
            _ => (None, None, None, None),
        };
        let evidence = TrafficTransitionEvidence {
            disposition: transition_disposition(disposition),
            effect_sequence,
            failure,
            operation,
            phase: current.authority.phase(),
            revision: current.revision,
            target_count,
        };
        let mut records = self
            .evidence
            .records
            .lock()
            .expect("Traffic transition evidence lock poisoned");
        records.push_back(evidence);
        while records.len() > TRAFFIC_TRANSITION_EVIDENCE_LIMIT {
            records.pop_front();
        }
        drop(records);
        let _ = self.updates.send(());
    }
}

fn transition_disposition(disposition: Disposition) -> TrafficTransitionDisposition {
    match disposition {
        Disposition::Accepted => TrafficTransitionDisposition::Accepted,
        Disposition::Rejected => TrafficTransitionDisposition::Rejected,
        Disposition::Unchanged => TrafficTransitionDisposition::Unchanged,
        Disposition::EffectEmitting => TrafficTransitionDisposition::EffectEmitting,
        Disposition::Committed => TrafficTransitionDisposition::Committed,
        Disposition::Cancelled => TrafficTransitionDisposition::Cancelled,
        Disposition::Failed => TrafficTransitionDisposition::Failed,
        Disposition::Retired => TrafficTransitionDisposition::Retired,
        Disposition::RecoveryRequired => TrafficTransitionDisposition::RecoveryRequired,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use mish_state_machine::{EffectExecutor, RunnerConfig, spawn_runner};
    use tokio_util::sync::CancellationToken;

    use super::*;

    struct PanickingExecutor {
        executions: Arc<AtomicUsize>,
    }

    impl EffectExecutor<TrafficSourceMachine> for PanickingExecutor {
        fn execute(
            &self,
            _effect: TrafficSourceEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = TrafficSourceInput> + Send + 'static>> {
            self.executions.fetch_add(1, Ordering::Relaxed);
            Box::pin(async move { panic!("injected Traffic effect panic") })
        }
    }

    fn context(generation: u64) -> TrafficSourceContext {
        TrafficSourceContext {
            capture_id: Some("capture-secret".into()),
            controller_generation: generation,
            profile_id: "profile-secret".into(),
            runtime_id: "runtime-secret".into(),
        }
    }

    fn stamp(generation: u64, session: &str, sequence: u64) -> TrafficSourceStamp {
        TrafficSourceStamp {
            context: context(generation),
            sequence,
            session_id: session.into(),
        }
    }

    fn request(operation_id: &str, source: &TrafficSourceStamp) -> TrafficCommandRequest {
        TrafficCommandRequest {
            admitted_target_count: 1,
            authority: TrafficCommandAuthority {
                profile_id: source.context.profile_id.clone(),
                sequence: source.sequence,
                session_id: source.session_id.clone(),
            },
            operation: TrafficCommandOperation::CloseConnection,
            operation_id: operation_id.into(),
            requested_ids: Some(vec!["connection-secret".into()]),
        }
    }

    fn live() -> TrafficSourceMachineState {
        let state = TrafficSourceMachineState::binding("machine-secret".into(), context(1));
        match TrafficSourceMachine.reduce(&state, &TrafficSourceInput::Baseline(stamp(1, "s1", 1)))
        {
            Transition::Committed(state) => state,
            _ => panic!("baseline must commit"),
        }
    }

    #[test]
    fn model_requires_a_complete_baseline_and_recovers_only_from_another_baseline() {
        let state = live();
        let state = match TrafficSourceMachine
            .reduce(&state, &TrafficSourceInput::Observation(stamp(1, "s1", 4)))
        {
            Transition::Committed(state) => state,
            _ => panic!("gap must establish failed reconciliation"),
        };
        assert!(matches!(
            state.authority,
            TrafficSourceAuthority::FailedReconciling {
                reason: TrafficSourceGapReason::SequenceGap,
                ..
            }
        ));
        assert!(matches!(
            TrafficSourceMachine
                .reduce(&state, &TrafficSourceInput::Observation(stamp(1, "s1", 5))),
            Transition::Retired
        ));
        let recovered = match TrafficSourceMachine
            .reduce(&state, &TrafficSourceInput::Baseline(stamp(1, "s1", 5)))
        {
            Transition::Committed(state) => state,
            _ => panic!("complete baseline must recover"),
        };
        assert_eq!(recovered.authority.live().unwrap().sequence, 5);
    }

    #[test]
    fn duplicate_operation_identity_is_idempotent_and_conflicting_reuse_is_rejected() {
        let state = live();
        let request = request("operation-1", state.authority.live().unwrap());
        let pending = match TrafficSourceMachine
            .reduce(&state, &TrafficSourceInput::Request(request.clone()))
        {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("first command must emit one effect"),
        };
        assert!(matches!(
            TrafficSourceMachine.reduce(&pending, &TrafficSourceInput::Request(request.clone())),
            Transition::Unchanged
        ));
        let mut conflict = request.clone();
        conflict.operation = TrafficCommandOperation::CloseAllActive;
        conflict.requested_ids = None;
        assert!(matches!(
            TrafficSourceMachine.reduce(&pending, &TrafficSourceInput::Request(conflict.clone())),
            Transition::Rejected(TrafficSourceMachineError::Conflict)
        ));

        let active = pending.pending.as_ref().unwrap();
        let completed = match TrafficSourceMachine.reduce(
            &pending,
            &TrafficSourceInput::Completed {
                correlation: active.correlation.clone(),
                execution: TrafficCommandExecution::success(request.operation, 1),
                source: active.source.clone(),
            },
        ) {
            Transition::Committed(state) => state,
            _ => panic!("matching completion must commit"),
        };
        assert!(matches!(
            TrafficSourceMachine.reduce(&completed, &TrafficSourceInput::Request(request)),
            Transition::Unchanged
        ));
        assert!(matches!(
            TrafficSourceMachine.reduce(&completed, &TrafficSourceInput::Request(conflict)),
            Transition::Rejected(TrafficSourceMachineError::Conflict)
        ));
    }

    #[test]
    fn replacement_retires_a_pending_effect_and_late_completion_cannot_commit() {
        let state = live();
        let request = request("operation-1", state.authority.live().unwrap());
        let pending =
            match TrafficSourceMachine.reduce(&state, &TrafficSourceInput::Request(request)) {
                Transition::EffectEmitting { state, .. } => state,
                _ => panic!("command must be pending"),
            };
        let correlation = pending.pending.as_ref().unwrap().correlation.clone();
        let source = pending.pending.as_ref().unwrap().source.clone();
        let replacing = match TrafficSourceMachine
            .reduce(&pending, &TrafficSourceInput::BeginBinding(context(2)))
        {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("replacement must cancel the effect"),
        };
        assert_eq!(
            replacing.command_result("operation-1").unwrap().failure,
            Some(TrafficCommandFailureKind::RuntimeReplaced)
        );
        assert!(matches!(
            TrafficSourceMachine.reduce(
                &replacing,
                &TrafficSourceInput::Completed {
                    correlation,
                    execution: TrafficCommandExecution::success(
                        TrafficCommandOperation::CloseConnection,
                        1,
                    ),
                    source,
                }
            ),
            Transition::Retired
        ));
    }

    #[test]
    fn stale_gap_from_a_replaced_context_cannot_override_current_authority() {
        let state = live();
        let replacing = match TrafficSourceMachine
            .reduce(&state, &TrafficSourceInput::BeginBinding(context(2)))
        {
            Transition::Committed(state) => state,
            _ => panic!("replacement must commit"),
        };
        let current = match TrafficSourceMachine
            .reduce(&replacing, &TrafficSourceInput::Baseline(stamp(2, "s2", 1)))
        {
            Transition::Committed(state) => state,
            _ => panic!("replacement baseline must commit"),
        };
        assert!(matches!(
            TrafficSourceMachine.reduce(
                &current,
                &TrafficSourceInput::Gap {
                    context: context(1),
                    reason: TrafficSourceGapReason::ObservationFailed,
                },
            ),
            Transition::Retired
        ));
        assert_eq!(current.authority.live().unwrap(), &stamp(2, "s2", 1));
    }

    #[test]
    fn cancellation_gap_is_terminal_and_a_cancelled_completion_cannot_overwrite_it() {
        let state = live();
        let request = request("operation-1", state.authority.live().unwrap());
        let pending =
            match TrafficSourceMachine.reduce(&state, &TrafficSourceInput::Request(request)) {
                Transition::EffectEmitting { state, .. } => state,
                _ => panic!("command must be pending"),
            };
        let correlation = pending.pending.as_ref().unwrap().correlation.clone();
        let source = pending.pending.as_ref().unwrap().source.clone();
        let cancelled = match TrafficSourceMachine.reduce(
            &pending,
            &TrafficSourceInput::Gap {
                context: context(1),
                reason: TrafficSourceGapReason::Cancelled,
            },
        ) {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("cancellation must cancel the owned effect"),
        };
        assert_eq!(
            cancelled.command_result("operation-1").unwrap().failure,
            Some(TrafficCommandFailureKind::Disconnected)
        );
        assert!(matches!(
            TrafficSourceMachine.reduce(
                &cancelled,
                &TrafficSourceInput::Completed {
                    correlation,
                    execution: TrafficCommandExecution::success(
                        TrafficCommandOperation::CloseConnection,
                        1,
                    ),
                    source,
                }
            ),
            Transition::Retired
        ));
    }

    #[test]
    fn end_requires_rebinding_and_a_complete_reconnect_baseline() {
        let state = live();
        let ended = match TrafficSourceMachine.reduce(
            &state,
            &TrafficSourceInput::End(TrafficSourceEndReason::CoreExited),
        ) {
            Transition::Committed(state) => state,
            _ => panic!("Core exit must end the current source"),
        };
        assert!(matches!(
            ended.authority,
            TrafficSourceAuthority::Ended {
                reason: TrafficSourceEndReason::CoreExited,
                ..
            }
        ));
        assert!(matches!(
            TrafficSourceMachine
                .reduce(&ended, &TrafficSourceInput::Observation(stamp(1, "s1", 2))),
            Transition::Retired
        ));
        assert!(matches!(
            TrafficSourceMachine.reduce(&ended, &TrafficSourceInput::Baseline(stamp(1, "s2", 1))),
            Transition::Rejected(TrafficSourceMachineError::InvalidAuthority)
        ));
        let binding = match TrafficSourceMachine
            .reduce(&ended, &TrafficSourceInput::BeginBinding(context(2)))
        {
            Transition::Committed(state) => state,
            _ => panic!("reconnect must establish a new binding"),
        };
        let live = match TrafficSourceMachine
            .reduce(&binding, &TrafficSourceInput::Baseline(stamp(2, "s2", 1)))
        {
            Transition::Committed(state) => state,
            _ => panic!("complete reconnect baseline must restore live authority"),
        };
        assert_eq!(live.authority.live().unwrap(), &stamp(2, "s2", 1));
    }

    #[test]
    fn shutdown_finalizes_pending_work_and_retires_late_completion() {
        let state = live();
        let pending = match TrafficSourceMachine.reduce(
            &state,
            &TrafficSourceInput::Request(request("operation-1", state.authority.live().unwrap())),
        ) {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("command must be pending"),
        };
        let active = pending.pending.as_ref().unwrap();
        let correlation = active.correlation.clone();
        let source = active.source.clone();
        let retired = match TrafficSourceMachine.reduce(&pending, &TrafficSourceInput::Shutdown) {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("shutdown must cancel owned work"),
        };
        assert!(matches!(
            retired.authority,
            TrafficSourceAuthority::Retired {
                reason: TrafficSourceEndReason::Shutdown,
                ..
            }
        ));
        assert_eq!(
            retired.command_result("operation-1").unwrap().failure,
            Some(TrafficCommandFailureKind::Disconnected)
        );
        assert!(matches!(
            TrafficSourceMachine.reduce(
                &retired,
                &TrafficSourceInput::Completed {
                    correlation,
                    execution: TrafficCommandExecution::success(
                        TrafficCommandOperation::CloseConnection,
                        1,
                    ),
                    source,
                },
            ),
            Transition::Retired
        ));
    }

    #[test]
    fn close_all_retirement_preserves_the_admitted_target_count() {
        let state = live();
        let source = state.authority.live().unwrap();
        let request = TrafficCommandRequest {
            admitted_target_count: 3,
            authority: TrafficCommandAuthority {
                profile_id: source.context.profile_id.clone(),
                sequence: source.sequence,
                session_id: source.session_id.clone(),
            },
            operation: TrafficCommandOperation::CloseAllActive,
            operation_id: "close-all-operation".into(),
            requested_ids: None,
        };
        let pending =
            match TrafficSourceMachine.reduce(&state, &TrafficSourceInput::Request(request)) {
                Transition::EffectEmitting { state, .. } => state,
                _ => panic!("close-all must be admitted"),
            };
        let replacing = match TrafficSourceMachine
            .reduce(&pending, &TrafficSourceInput::BeginBinding(context(2)))
        {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("replacement must cancel close-all"),
        };
        let execution = replacing.command_result("close-all-operation").unwrap();
        assert_eq!(
            execution.failure,
            Some(TrafficCommandFailureKind::RuntimeReplaced)
        );
        assert_eq!(execution.target_count, 3);
    }

    #[test]
    fn every_monotonic_sequence_prefix_preserves_one_live_authority() {
        for length in 1..128_u64 {
            let mut state = live();
            for sequence in 2..=length {
                state = match TrafficSourceMachine.reduce(
                    &state,
                    &TrafficSourceInput::Observation(stamp(1, "s1", sequence)),
                ) {
                    Transition::Committed(state) => state,
                    _ => panic!("monotonic observation must commit"),
                };
                assert_eq!(state.authority.live().unwrap().sequence, sequence);
            }
        }
    }

    #[test]
    fn transition_evidence_is_bounded_and_contains_no_domain_identifiers() {
        let evidence = Arc::new(TrafficTransitionEvidenceBuffer::default());
        let (updates, _) = tokio::sync::broadcast::channel(1);
        let observer = TrafficSourceObserver {
            evidence: evidence.clone(),
            updates,
        };
        let mut state = live();
        for sequence in 2..=100 {
            let input = TrafficSourceInput::Observation(stamp(1, "s1", sequence));
            let next = match TrafficSourceMachine.reduce(&state, &input) {
                Transition::Committed(next) => next,
                _ => unreachable!(),
            };
            observer.transitioned(&state, &input, &next, Disposition::Committed);
            state = next;
        }
        let records = evidence.snapshot();
        assert_eq!(records.len(), TRAFFIC_TRANSITION_EVIDENCE_LIMIT);
        let serialized = format!("{records:?}");
        for secret in [
            "profile-secret",
            "runtime-secret",
            "capture-secret",
            "session-secret",
            "connection-secret",
        ] {
            assert!(!serialized.contains(secret));
        }
    }

    #[tokio::test]
    async fn injected_close_all_effect_panic_preserves_count_and_requires_reconciliation() {
        let executions = Arc::new(AtomicUsize::new(0));
        let evidence = Arc::new(TrafficTransitionEvidenceBuffer::default());
        let (updates, _) = tokio::sync::broadcast::channel(8);
        let runner = spawn_runner(
            Arc::new(TrafficSourceMachine),
            live(),
            Arc::new(PanickingExecutor {
                executions: executions.clone(),
            }),
            Arc::new(TrafficSourceObserver { evidence, updates }),
            RunnerConfig::default(),
        );
        let source = runner.snapshot().authority.live().unwrap().clone();
        runner
            .admit(TrafficSourceInput::Request(TrafficCommandRequest {
                admitted_target_count: 3,
                authority: TrafficCommandAuthority {
                    profile_id: source.context.profile_id.clone(),
                    sequence: source.sequence,
                    session_id: source.session_id.clone(),
                },
                operation: TrafficCommandOperation::CloseAllActive,
                operation_id: "operation-panic".into(),
                requested_ids: None,
            }))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if runner
                    .snapshot()
                    .command_result("operation-panic")
                    .is_some()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("panic finalizer must be bounded");
        let state = runner.snapshot();
        assert_eq!(executions.load(Ordering::Relaxed), 1);
        let execution = state.command_result("operation-panic").unwrap();
        assert_eq!(
            execution.failure,
            Some(TrafficCommandFailureKind::InconsistentObservation)
        );
        assert_eq!(execution.target_count, 3);
        assert!(matches!(
            state.authority,
            TrafficSourceAuthority::FailedReconciling {
                reason: TrafficSourceGapReason::Panicked,
                ..
            }
        ));
        let _ = runner.shutdown().await;
    }
}
