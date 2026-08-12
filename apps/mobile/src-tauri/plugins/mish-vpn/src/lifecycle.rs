#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::VecDeque;

use mish_state_machine::{
    CorrelatedEffect, Correlation, EffectBatch, EffectMode, Machine, TaskFailure, Transition,
};
use serde::{Deserialize, Serialize};

#[cfg(feature = "simulated-host")]
pub(crate) use crate::generated::platform_facts::PlatformLifecycleAuthority;
pub(crate) use crate::generated::platform_facts::{
    CoreConfigState, PlatformAvailability, PlatformEventKind, PlatformFacts, PlatformFailureKind,
    PlatformRecoveryEvidence, VpnPermission,
};

const OPERATION_HISTORY_LIMIT: usize = 16;
const MAX_CLEANUP_RETRIES: u8 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecyclePhase {
    Stopped,
    PermissionRequired,
    Starting,
    Running,
    Stopping,
    Failed,
    RecoveryRequired,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleCommandKind {
    RequestNotificationPermission,
    RequestVpnConsent,
    Start,
    Stop,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleOperationOutcome {
    Pending,
    Completed,
    Rejected,
    Cancelled,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleFailure {
    Busy,
    Cancelled,
    ConfigurationNotLoaded,
    CoreFailure,
    CoreUnavailable,
    InvalidCommand,
    InvalidRecoveryEvidence,
    NetworkUnavailable,
    PermissionDenied,
    PlatformFailure,
    PublicRequestFailed,
    ServiceDestroyed,
    StalePlatformAuthority,
    Timeout,
    TunFailure,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleOperation {
    pub failure: Option<LifecycleFailure>,
    pub kind: LifecycleCommandKind,
    pub operation_id: String,
    pub outcome: LifecycleOperationOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LifecycleState {
    pub authority_id: String,
    pub scope_epoch: u64,
    pub revision: u64,
    pub sequence: u64,
    pub session_id: String,
    pub phase: LifecyclePhase,
    pub failure: Option<LifecycleFailure>,
    pub facts: PlatformFacts,
    active: Option<ActiveOperation>,
    operations: VecDeque<LifecycleOperation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ActiveOperation {
    command: LifecycleCommandKind,
    correlation: Correlation,
    cancellation: Option<LifecycleOperationOutcome>,
    cleanup: Option<CleanupBarrier>,
}

/// Product-level ordering for a native cleanup effect.
///
/// The shared state-machine runner still owns the effect task and its
/// finalizer. This record only prevents the product reducer from publishing a
/// clean terminal phase until the matching result and callback have both been
/// observed and the returned platform facts prove that no Mish-owned resource
/// or recovery obligation remains.
#[derive(Clone, Debug, Eq, PartialEq)]
struct CleanupBarrier {
    effect_id: u64,
    effect_completed: bool,
    callback_observed: bool,
    observed_failure: bool,
    retries: u8,
}

impl CleanupBarrier {
    fn new(effect_id: u64) -> Self {
        Self {
            effect_id,
            effect_completed: false,
            callback_observed: false,
            observed_failure: false,
            retries: 0,
        }
    }
}

impl LifecycleState {
    pub(crate) fn initial(authority_id: String, session_id: String, facts: PlatformFacts) -> Self {
        let platform_active = facts.service_foreground
            || facts.core_running
            || facts.tun_established
            || facts.active_network
            || facts.public_request_observed
            || facts.protected_socket_count > 0
            || facts.activation_session_id.is_some()
            || facts.lifecycle_authority.is_some()
            || facts.recovery_evidence != PlatformRecoveryEvidence::None;
        let recovery_expected =
            facts.recovery_evidence == PlatformRecoveryEvidence::ForegroundExpected;
        let recovered = (platform_active || recovery_expected)
            .then_some(facts.lifecycle_authority.as_ref())
            .flatten()
            .filter(|authority| authority.valid());
        let authority_id = recovered
            .map(|authority| authority.machine_authority.clone())
            .unwrap_or(authority_id);
        let scope_epoch = recovered.map_or(1, |authority| authority.scope_epoch);
        let revision = recovered.map_or(1, |authority| authority.admitted_revision.max(1));
        let session_id = if platform_active || recovery_expected {
            facts.activation_session_id.clone().unwrap_or(session_id)
        } else {
            session_id
        };
        let recovered_authority = recovered.is_some();
        let (phase, failure) = match facts.recovery_evidence {
            PlatformRecoveryEvidence::ForegroundExpected | PlatformRecoveryEvidence::Invalid => (
                LifecyclePhase::RecoveryRequired,
                Some(LifecycleFailure::InvalidRecoveryEvidence),
            ),
            PlatformRecoveryEvidence::None if platform_active && recovered.is_none() => (
                LifecyclePhase::RecoveryRequired,
                Some(LifecycleFailure::InvalidRecoveryEvidence),
            ),
            PlatformRecoveryEvidence::None if facts.vpn_permission == VpnPermission::Required => {
                (LifecyclePhase::PermissionRequired, None)
            }
            PlatformRecoveryEvidence::None => (LifecyclePhase::Stopped, None),
        };
        let mut state = Self {
            authority_id,
            scope_epoch,
            revision,
            sequence: 1,
            session_id,
            phase,
            failure,
            facts,
            active: None,
            operations: VecDeque::new(),
        };
        if platform_active && recovered_authority && state.activation_ready() {
            state.phase = LifecyclePhase::Running;
            state.failure = None;
        } else if platform_active && state.phase == LifecyclePhase::Stopped {
            state.phase = LifecyclePhase::RecoveryRequired;
            state.failure = Some(LifecycleFailure::InvalidRecoveryEvidence);
        }
        state
    }

    pub(crate) fn operation(&self, operation_id: &str) -> Option<&LifecycleOperation> {
        if let Some(active) = &self.active
            && active.correlation.operation_id == operation_id
        {
            return self.operations.iter().rev().find(|record| {
                record.operation_id == operation_id
                    && record.outcome == LifecycleOperationOutcome::Pending
            });
        }
        self.operations
            .iter()
            .rev()
            .find(|record| record.operation_id == operation_id)
    }

    pub(crate) fn latest_operation(&self) -> Option<LifecycleOperation> {
        self.operations.back().cloned()
    }

    fn advance(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.sequence = self.sequence.saturating_add(1);
    }

    fn apply_facts(&mut self, facts: &PlatformFacts) -> Result<(), LifecycleFailure> {
        facts
            .validate()
            .map_err(|_| LifecycleFailure::PlatformFailure)?;
        if facts.platform_session_id != self.facts.platform_session_id
            || facts.fact_sequence <= self.facts.fact_sequence
        {
            return Err(LifecycleFailure::StalePlatformAuthority);
        }
        self.facts = facts.clone();
        Ok(())
    }

    fn apply_effect_facts(&mut self, facts: &PlatformFacts) -> Result<(), LifecycleFailure> {
        facts
            .validate()
            .map_err(|_| LifecycleFailure::PlatformFailure)?;
        if facts.platform_session_id != self.facts.platform_session_id
            || facts.fact_sequence < self.facts.fact_sequence
            || (facts.fact_sequence == self.facts.fact_sequence && facts != &self.facts)
        {
            return Err(LifecycleFailure::StalePlatformAuthority);
        }
        if facts.fact_sequence > self.facts.fact_sequence {
            self.facts = facts.clone();
        }
        Ok(())
    }

    fn begin(&mut self, command: LifecycleCommandKind, correlation: Correlation) {
        self.active = Some(ActiveOperation {
            command,
            correlation: correlation.clone(),
            cancellation: None,
            cleanup: (command == LifecycleCommandKind::Stop)
                .then(|| CleanupBarrier::new(correlation.effect_id)),
        });
        self.push_operation(LifecycleOperation {
            failure: None,
            kind: command,
            operation_id: correlation.operation_id,
            outcome: LifecycleOperationOutcome::Pending,
        });
    }

    fn activation_ready(&self) -> bool {
        self.facts.activation_session_id.as_deref() == Some(self.session_id.as_str())
            && self.facts.active_network
            && self.facts.core_running
            && self.facts.dns_applied
            && self.facts.protected_socket_count > 0
            && self.facts.public_request_observed
            && self.facts.routes_applied
            && self.facts.service_foreground
            && self.facts.tun_established
            && self.facts.vpn_permission == VpnPermission::Granted
    }

    pub(crate) fn platform_clean(&self) -> bool {
        Self::facts_platform_clean(&self.facts)
    }

    pub(crate) fn facts_platform_clean(facts: &PlatformFacts) -> bool {
        !facts.active_network
            && !facts.core_running
            && !facts.dns_applied
            && !facts.public_request_observed
            && !facts.routes_applied
            && !facts.service_foreground
            && !facts.tun_established
            && facts.protected_socket_count == 0
            && facts.activation_session_id.is_none()
            && facts.lifecycle_authority.is_none()
            && facts.recovery_evidence == PlatformRecoveryEvidence::None
    }

    fn cleanup_observation_matches(active: &ActiveOperation, facts: &PlatformFacts) -> bool {
        let Some(cleanup) = active.cleanup.as_ref() else {
            return false;
        };
        if Self::facts_platform_clean(facts) {
            // The Android store clears its lifecycle authority only after all
            // owned cleanup work succeeds. A clean StopCompleted snapshot is
            // therefore the one authority-free callback we admit.
            return facts.lifecycle_authority.is_none();
        }
        let Some(authority) = facts.lifecycle_authority.as_ref() else {
            return false;
        };
        authority.machine_authority == active.correlation.machine_authority
            && authority.scope_epoch == active.correlation.scope_epoch
            && authority.operation_id == active.correlation.operation_id
            && authority.admitted_revision == active.correlation.admitted_revision
            && authority.effect_identity == cleanup.effect_id.to_string()
    }

    fn finish(
        &mut self,
        command: LifecycleCommandKind,
        operation_id: String,
        outcome: LifecycleOperationOutcome,
        failure: Option<LifecycleFailure>,
    ) {
        self.active = None;
        self.push_operation(LifecycleOperation {
            failure,
            kind: command,
            operation_id,
            outcome,
        });
    }

    fn push_operation(&mut self, operation: LifecycleOperation) {
        if self
            .operations
            .back()
            .is_some_and(|current| current.operation_id == operation.operation_id)
        {
            self.operations.pop_back();
        }
        if self.operations.len() == OPERATION_HISTORY_LIMIT {
            self.operations.pop_front();
        }
        self.operations.push_back(operation);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlatformAction {
    RequestNotificationPermission,
    RequestVpnConsent,
    StartForegroundService,
    StopForegroundService,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ActivationAuthority {
    pub config_digest: String,
    pub config_revision: String,
    pub fact_sequence: u64,
    pub platform_session_id: String,
    pub product_session_id: String,
    pub machine_authority: String,
    pub scope_epoch: u64,
    pub operation_id: String,
    pub admitted_revision: u64,
    pub effect_identity: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LifecycleEffect {
    pub action: PlatformAction,
    pub activation: Option<ActivationAuthority>,
    pub correlation: Correlation,
    mode: EffectMode,
}

impl LifecycleEffect {
    fn spawn(action: PlatformAction, correlation: Correlation) -> Self {
        Self {
            action,
            activation: None,
            correlation,
            mode: EffectMode::Spawn,
        }
    }

    fn start(correlation: Correlation, state: &LifecycleState) -> Self {
        Self {
            action: PlatformAction::StartForegroundService,
            activation: Some(ActivationAuthority {
                config_digest: state
                    .facts
                    .loaded_config_digest
                    .clone()
                    .expect("start admission requires a loaded configuration digest"),
                config_revision: state
                    .facts
                    .loaded_config_revision
                    .clone()
                    .expect("start admission requires a loaded configuration revision"),
                fact_sequence: state.facts.fact_sequence,
                platform_session_id: state.facts.platform_session_id.clone(),
                product_session_id: state.session_id.clone(),
                machine_authority: correlation.machine_authority.clone(),
                scope_epoch: correlation.scope_epoch,
                operation_id: correlation.operation_id.clone(),
                admitted_revision: correlation.admitted_revision,
                effect_identity: correlation.effect_id.to_string(),
            }),
            correlation,
            mode: EffectMode::Spawn,
        }
    }

    fn cancel(correlation: Correlation) -> Self {
        Self {
            action: PlatformAction::StopForegroundService,
            activation: None,
            correlation,
            mode: EffectMode::Cancel,
        }
    }
}

impl CorrelatedEffect for LifecycleEffect {
    fn correlation(&self) -> &Correlation {
        &self.correlation
    }

    fn mode(&self) -> EffectMode {
        self.mode
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum LifecycleInput {
    Command {
        command: LifecycleCommandKind,
        correlation: Correlation,
        new_session_id: Option<String>,
    },
    EffectCompleted {
        action: PlatformAction,
        correlation: Correlation,
        facts: PlatformFacts,
    },
    EffectFailed {
        action: PlatformAction,
        correlation: Correlation,
    },
    PlatformObserved(PlatformFacts),
    Cancel {
        operation_id: String,
        timed_out: bool,
    },
    TaskFailed {
        correlation: Correlation,
    },
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LifecycleMachineError {
    Unavailable,
}

pub(crate) struct LifecycleMachine;

impl Machine for LifecycleMachine {
    type State = LifecycleState;
    type Input = LifecycleInput;
    type Effect = LifecycleEffect;
    type Error = LifecycleMachineError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        match input {
            LifecycleInput::Command {
                command,
                correlation,
                new_session_id,
            } => reduce_command(state, *command, correlation, new_session_id.as_deref()),
            LifecycleInput::EffectCompleted {
                action,
                correlation,
                facts,
            } => reduce_effect_completed(state, *action, correlation, facts),
            LifecycleInput::EffectFailed {
                action,
                correlation,
            } => reduce_effect_failed(state, *action, correlation),
            LifecycleInput::PlatformObserved(facts) => reduce_platform_observation(state, facts),
            LifecycleInput::Cancel {
                operation_id,
                timed_out,
            } => reduce_cancel(state, operation_id, *timed_out),
            LifecycleInput::TaskFailed { correlation } => reduce_task_failed(state, correlation),
            LifecycleInput::Shutdown => reduce_shutdown(state),
        }
    }

    fn input_correlation(&self, state: &Self::State, input: &Self::Input) -> Option<Correlation> {
        match input {
            LifecycleInput::Command { correlation, .. }
            | LifecycleInput::EffectCompleted { correlation, .. }
            | LifecycleInput::EffectFailed { correlation, .. }
            | LifecycleInput::TaskFailed { correlation, .. } => Some(correlation.clone()),
            LifecycleInput::Cancel { operation_id, .. } => state
                .active
                .as_ref()
                .filter(|active| active.correlation.operation_id == *operation_id)
                .map(|active| active.correlation.clone()),
            LifecycleInput::PlatformObserved(_) | LifecycleInput::Shutdown => None,
        }
    }

    fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
        if let Some(active) = state.active.as_ref() {
            let expected_effect_id = active
                .cleanup
                .as_ref()
                .map_or(active.correlation.effect_id, |cleanup| cleanup.effect_id);
            return active.correlation.same_operation(correlation)
                && correlation.effect_id == expected_effect_id;
        }
        false
    }

    fn task_failed(&self, correlation: Correlation, _failure: TaskFailure) -> Self::Input {
        LifecycleInput::TaskFailed { correlation }
    }

    fn shutdown(&self) -> Self::Input {
        LifecycleInput::Shutdown
    }

    fn unavailable(&self) -> Self::Error {
        LifecycleMachineError::Unavailable
    }
}

fn reduce_command(
    state: &LifecycleState,
    command: LifecycleCommandKind,
    correlation: &Correlation,
    new_session_id: Option<&str>,
) -> Transition<LifecycleState, LifecycleEffect, LifecycleMachineError> {
    if let Some(existing) = state.operation(&correlation.operation_id) {
        let _ = existing;
        return Transition::Unchanged;
    }
    if state.active.is_some() {
        let mut next = state.clone();
        next.advance();
        next.push_operation(LifecycleOperation {
            failure: Some(LifecycleFailure::Busy),
            kind: command,
            operation_id: correlation.operation_id.clone(),
            outcome: LifecycleOperationOutcome::Rejected,
        });
        return Transition::Committed(next);
    }

    let action = match command {
        LifecycleCommandKind::RequestNotificationPermission => {
            PlatformAction::RequestNotificationPermission
        }
        LifecycleCommandKind::RequestVpnConsent => PlatformAction::RequestVpnConsent,
        LifecycleCommandKind::Start => {
            if state.phase == LifecyclePhase::RecoveryRequired {
                let mut next = state.clone();
                next.advance();
                next.push_operation(LifecycleOperation {
                    failure: Some(LifecycleFailure::InvalidRecoveryEvidence),
                    kind: command,
                    operation_id: correlation.operation_id.clone(),
                    outcome: LifecycleOperationOutcome::Rejected,
                });
                return Transition::Committed(next);
            }
            if state.facts.vpn_permission != VpnPermission::Granted {
                let mut next = state.clone();
                next.phase = LifecyclePhase::PermissionRequired;
                next.failure = Some(LifecycleFailure::PermissionDenied);
                next.advance();
                next.finish(
                    command,
                    correlation.operation_id.clone(),
                    LifecycleOperationOutcome::Rejected,
                    Some(LifecycleFailure::PermissionDenied),
                );
                return Transition::Committed(next);
            }
            let start_failure = if state.facts.core_availability != PlatformAvailability::Available
            {
                Some(LifecycleFailure::CoreUnavailable)
            } else if state.facts.core_config_state != CoreConfigState::Loaded
                || state.facts.loaded_config_digest.is_none()
                || state.facts.loaded_config_revision.is_none()
            {
                Some(LifecycleFailure::ConfigurationNotLoaded)
            } else {
                None
            };
            if let Some(failure) = start_failure {
                let mut next = state.clone();
                next.phase = LifecyclePhase::Failed;
                next.failure = Some(failure);
                next.advance();
                next.finish(
                    command,
                    correlation.operation_id.clone(),
                    LifecycleOperationOutcome::Rejected,
                    Some(failure),
                );
                return Transition::Committed(next);
            }
            if state.activation_ready() && state.phase == LifecyclePhase::Running {
                let mut next = state.clone();
                next.advance();
                next.finish(
                    command,
                    correlation.operation_id.clone(),
                    LifecycleOperationOutcome::Completed,
                    None,
                );
                return Transition::Committed(next);
            }
            PlatformAction::StartForegroundService
        }
        LifecycleCommandKind::Stop => {
            if state.phase == LifecyclePhase::Stopped && state.platform_clean() {
                let mut next = state.clone();
                next.advance();
                next.finish(
                    command,
                    correlation.operation_id.clone(),
                    LifecycleOperationOutcome::Completed,
                    None,
                );
                return Transition::Committed(next);
            }
            PlatformAction::StopForegroundService
        }
    };

    let mut next = state.clone();
    next.advance();
    if command == LifecycleCommandKind::Start {
        next.session_id = new_session_id.unwrap_or(&state.session_id).to_owned();
        next.phase = LifecyclePhase::Starting;
    } else if command == LifecycleCommandKind::Stop {
        next.phase = LifecyclePhase::Stopping;
    }
    next.failure = None;
    next.begin(command, correlation.clone());
    let effect = if action == PlatformAction::StartForegroundService {
        LifecycleEffect::start(correlation.clone(), &next)
    } else {
        LifecycleEffect::spawn(action, correlation.clone())
    };
    Transition::EffectEmitting {
        state: next,
        effects: EffectBatch::one(effect),
    }
}

fn reduce_effect_completed(
    state: &LifecycleState,
    action: PlatformAction,
    correlation: &Correlation,
    facts: &PlatformFacts,
) -> Transition<LifecycleState, LifecycleEffect, LifecycleMachineError> {
    let Some(active) = state.active.clone() else {
        return Transition::Retired;
    };
    let expected_effect_id = active
        .cleanup
        .as_ref()
        .map_or(active.correlation.effect_id, |cleanup| cleanup.effect_id);
    if !active.correlation.same_operation(correlation)
        || correlation.effect_id != expected_effect_id
    {
        return Transition::Retired;
    }
    if action == PlatformAction::StopForegroundService
        && facts.event == PlatformEventKind::StopCompleted
        && !LifecycleState::cleanup_observation_matches(&active, facts)
    {
        return Transition::Retired;
    }
    let mut next = state.clone();
    if let Err(failure) = next.apply_effect_facts(facts) {
        next.phase = LifecyclePhase::RecoveryRequired;
        next.failure = Some(failure);
        next.advance();
        next.finish(
            active.command,
            correlation.operation_id.clone(),
            LifecycleOperationOutcome::Unknown,
            Some(failure),
        );
        return Transition::RecoveryRequired(next);
    }

    if action == PlatformAction::StopForegroundService {
        let platform_clean = next.platform_clean();
        let cleanup = {
            let Some(cleanup) = next
                .active
                .as_mut()
                .and_then(|active| active.cleanup.as_mut())
            else {
                return Transition::Retired;
            };
            cleanup.effect_completed = true;
            if facts.event == PlatformEventKind::StopCompleted && !platform_clean {
                cleanup.observed_failure = true;
            }
            cleanup.clone()
        };
        let cleanup_ready = cleanup.effect_completed
            && cleanup.callback_observed
            && !cleanup.observed_failure
            && facts.event == PlatformEventKind::StopCompleted
            && platform_clean;
        if cleanup_ready {
            let outcome = active
                .cancellation
                .unwrap_or(LifecycleOperationOutcome::Completed);
            let failure = active.cancellation.map(|outcome| {
                if outcome == LifecycleOperationOutcome::Unknown {
                    LifecycleFailure::Timeout
                } else {
                    LifecycleFailure::Cancelled
                }
            });
            next.phase = LifecyclePhase::Stopped;
            next.failure = failure;
            next.advance();
            next.finish(
                active.command,
                correlation.operation_id.clone(),
                outcome,
                failure,
            );
            return Transition::Committed(next);
        }
        // A failed native result is not enough to advance the cleanup
        // generation. Wait for the matching callback snapshot first so a
        // late callback from the failed generation cannot be consumed by the
        // retry generation.
        if cleanup.observed_failure && cleanup.effect_completed && cleanup.callback_observed {
            if cleanup.retries < MAX_CLEANUP_RETRIES {
                let retry_effect_id = cleanup.effect_id.saturating_add(1);
                if let Some(current) = next.active.as_mut()
                    && let Some(retry) = current.cleanup.as_mut()
                {
                    retry.retries += 1;
                    retry.effect_id = retry_effect_id;
                    retry.effect_completed = false;
                    retry.callback_observed = false;
                    retry.observed_failure = false;
                    if current.command != LifecycleCommandKind::Stop
                        && current.cancellation.is_none()
                    {
                        current.cancellation = Some(LifecycleOperationOutcome::Unknown);
                    }
                }
                next.phase = LifecyclePhase::Stopping;
                next.failure = Some(LifecycleFailure::PlatformFailure);
                next.advance();
                return Transition::EffectEmitting {
                    state: next,
                    effects: EffectBatch::one(LifecycleEffect::spawn(
                        PlatformAction::StopForegroundService,
                        correlation.with_effect(retry_effect_id),
                    )),
                };
            }
            next.phase = LifecyclePhase::RecoveryRequired;
            next.failure = Some(LifecycleFailure::PlatformFailure);
            next.advance();
            next.finish(
                active.command,
                correlation.operation_id.clone(),
                LifecycleOperationOutcome::Unknown,
                next.failure,
            );
            return Transition::RecoveryRequired(next);
        }
        next.phase = LifecyclePhase::Stopping;
        next.failure = active.cancellation.map(|outcome| {
            if outcome == LifecycleOperationOutcome::Unknown {
                LifecycleFailure::Timeout
            } else {
                LifecycleFailure::Cancelled
            }
        });
        next.advance();
        return Transition::Committed(next);
    }

    let (phase, outcome, failure) = match action {
        PlatformAction::RequestNotificationPermission => {
            (next.phase, LifecycleOperationOutcome::Completed, None)
        }
        PlatformAction::RequestVpnConsent if facts.vpn_permission == VpnPermission::Granted => (
            LifecyclePhase::Stopped,
            LifecycleOperationOutcome::Completed,
            None,
        ),
        PlatformAction::RequestVpnConsent => (
            LifecyclePhase::PermissionRequired,
            LifecycleOperationOutcome::Rejected,
            Some(LifecycleFailure::PermissionDenied),
        ),
        PlatformAction::StartForegroundService if next.activation_ready() => (
            LifecyclePhase::Running,
            LifecycleOperationOutcome::Completed,
            None,
        ),
        PlatformAction::StartForegroundService if facts.activation_failure.is_some() => (
            LifecyclePhase::Failed,
            LifecycleOperationOutcome::Rejected,
            facts.activation_failure.map(platform_failure),
        ),
        PlatformAction::StartForegroundService => (
            LifecyclePhase::RecoveryRequired,
            LifecycleOperationOutcome::Unknown,
            Some(LifecycleFailure::PlatformFailure),
        ),
        PlatformAction::StopForegroundService => (
            LifecyclePhase::RecoveryRequired,
            LifecycleOperationOutcome::Unknown,
            Some(LifecycleFailure::PlatformFailure),
        ),
    };
    next.phase = phase;
    next.failure = failure;
    next.advance();
    next.finish(
        active.command,
        correlation.operation_id.clone(),
        outcome,
        failure,
    );
    if phase == LifecyclePhase::RecoveryRequired {
        Transition::RecoveryRequired(next)
    } else {
        Transition::Committed(next)
    }
}

fn reduce_task_failed(
    state: &LifecycleState,
    correlation: &Correlation,
) -> Transition<LifecycleState, LifecycleEffect, LifecycleMachineError> {
    let Some(active) = state.active.as_ref() else {
        return Transition::Retired;
    };
    let action = match active.command {
        LifecycleCommandKind::RequestNotificationPermission => {
            PlatformAction::RequestNotificationPermission
        }
        LifecycleCommandKind::RequestVpnConsent => PlatformAction::RequestVpnConsent,
        LifecycleCommandKind::Start => PlatformAction::StartForegroundService,
        LifecycleCommandKind::Stop => PlatformAction::StopForegroundService,
    };
    reduce_effect_failed(state, action, correlation)
}

fn reduce_effect_failed(
    state: &LifecycleState,
    action: PlatformAction,
    correlation: &Correlation,
) -> Transition<LifecycleState, LifecycleEffect, LifecycleMachineError> {
    let Some(active) = state.active.clone() else {
        return Transition::Retired;
    };
    let expected_effect_id = active
        .cleanup
        .as_ref()
        .map_or(active.correlation.effect_id, |cleanup| cleanup.effect_id);
    if active.correlation.operation_id != correlation.operation_id
        || correlation.effect_id != expected_effect_id
    {
        return Transition::Retired;
    }
    let mut next = state.clone();
    if action == PlatformAction::StartForegroundService && active.cleanup.is_none() {
        let next_effect_id = correlation.effect_id.saturating_add(1);
        next.phase = LifecyclePhase::Stopping;
        next.failure = Some(LifecycleFailure::PlatformFailure);
        if let Some(active) = next.active.as_mut() {
            active.cancellation = Some(LifecycleOperationOutcome::Unknown);
            active.cleanup = Some(CleanupBarrier::new(next_effect_id));
        }
        next.advance();
        let cleanup = LifecycleEffect::spawn(
            PlatformAction::StopForegroundService,
            correlation.with_effect(next_effect_id),
        );
        Transition::EffectEmitting {
            state: next,
            effects: EffectBatch::one(cleanup),
        }
    } else if action == PlatformAction::StopForegroundService {
        let Some(cleanup) = next
            .active
            .as_mut()
            .and_then(|active| active.cleanup.as_mut())
        else {
            return Transition::Retired;
        };
        if cleanup.retries < MAX_CLEANUP_RETRIES {
            cleanup.retries += 1;
            let retry_effect_id = correlation.effect_id.saturating_add(1);
            cleanup.effect_id = retry_effect_id;
            cleanup.effect_completed = false;
            cleanup.callback_observed = false;
            cleanup.observed_failure = false;
            next.phase = LifecyclePhase::Stopping;
            next.failure = Some(LifecycleFailure::PlatformFailure);
            if let Some(active) = next.active.as_mut()
                && active.command != LifecycleCommandKind::Stop
                && active.cancellation.is_none()
            {
                active.cancellation = Some(LifecycleOperationOutcome::Unknown);
            }
            let retry = LifecycleEffect::spawn(
                PlatformAction::StopForegroundService,
                correlation.with_effect(retry_effect_id),
            );
            next.advance();
            Transition::EffectEmitting {
                state: next,
                effects: EffectBatch::one(retry),
            }
        } else {
            next.phase = LifecyclePhase::RecoveryRequired;
            next.failure = Some(LifecycleFailure::PlatformFailure);
            next.advance();
            next.finish(
                active.command,
                correlation.operation_id.clone(),
                LifecycleOperationOutcome::Unknown,
                next.failure,
            );
            Transition::RecoveryRequired(next)
        }
    } else {
        next.phase = LifecyclePhase::RecoveryRequired;
        next.failure = Some(LifecycleFailure::PlatformFailure);
        next.advance();
        next.finish(
            active.command,
            correlation.operation_id.clone(),
            LifecycleOperationOutcome::Unknown,
            Some(LifecycleFailure::PlatformFailure),
        );
        Transition::RecoveryRequired(next)
    }
}

fn reduce_platform_observation(
    state: &LifecycleState,
    facts: &PlatformFacts,
) -> Transition<LifecycleState, LifecycleEffect, LifecycleMachineError> {
    let mut next = state.clone();
    if next.apply_facts(facts).is_err() {
        return Transition::Retired;
    }

    if let Some(active) = next.active.clone() {
        // Consequential cleanup requires two independent observations: the
        // native effect task must have returned, and the matching platform
        // callback must have published a clean, obligation-free snapshot.
        if let Some(mut cleanup) = active.cleanup.clone()
            && facts.event == PlatformEventKind::StopCompleted
        {
            if !LifecycleState::cleanup_observation_matches(&active, facts) {
                return Transition::Retired;
            }
            cleanup.callback_observed = true;
            cleanup.observed_failure |= !next.platform_clean();
            if let Some(current) = next.active.as_mut() {
                current.cleanup = Some(cleanup.clone());
            }
            if cleanup.effect_completed && !cleanup.observed_failure && next.platform_clean() {
                let outcome = active
                    .cancellation
                    .unwrap_or(LifecycleOperationOutcome::Completed);
                let failure = active.cancellation.map(|outcome| {
                    if outcome == LifecycleOperationOutcome::Unknown {
                        LifecycleFailure::Timeout
                    } else {
                        LifecycleFailure::Cancelled
                    }
                });
                next.phase = LifecyclePhase::Stopped;
                next.failure = failure;
                next.advance();
                next.finish(
                    active.command,
                    active.correlation.operation_id,
                    outcome,
                    failure,
                );
                return Transition::Committed(next);
            }
            if cleanup.effect_completed && cleanup.observed_failure {
                if cleanup.retries < MAX_CLEANUP_RETRIES {
                    let retry_effect_id = cleanup.effect_id.saturating_add(1);
                    if let Some(current) = next.active.as_mut()
                        && let Some(retry) = current.cleanup.as_mut()
                    {
                        retry.retries += 1;
                        retry.effect_id = retry_effect_id;
                        retry.effect_completed = false;
                        retry.callback_observed = false;
                        retry.observed_failure = false;
                        if current.command != LifecycleCommandKind::Stop
                            && current.cancellation.is_none()
                        {
                            current.cancellation = Some(LifecycleOperationOutcome::Unknown);
                        }
                    }
                    next.phase = LifecyclePhase::Stopping;
                    next.failure = Some(LifecycleFailure::PlatformFailure);
                    next.advance();
                    return Transition::EffectEmitting {
                        state: next,
                        effects: EffectBatch::one(LifecycleEffect::spawn(
                            PlatformAction::StopForegroundService,
                            active.correlation.with_effect(retry_effect_id),
                        )),
                    };
                }
                next.phase = LifecyclePhase::RecoveryRequired;
                next.failure = Some(LifecycleFailure::PlatformFailure);
                next.advance();
                next.finish(
                    active.command,
                    active.correlation.operation_id,
                    LifecycleOperationOutcome::Unknown,
                    next.failure,
                );
                return Transition::RecoveryRequired(next);
            }
            next.phase = LifecyclePhase::Stopping;
            next.failure = active.cancellation.map(|outcome| {
                if outcome == LifecycleOperationOutcome::Unknown {
                    LifecycleFailure::Timeout
                } else {
                    LifecycleFailure::Cancelled
                }
            });
            next.advance();
            return Transition::Committed(next);
        }

        let terminal = match active.command {
            LifecycleCommandKind::RequestNotificationPermission
                if facts.event == PlatformEventKind::NotificationResult =>
            {
                Some((next.phase, LifecycleOperationOutcome::Completed, None))
            }
            LifecycleCommandKind::RequestVpnConsent
                if facts.event == PlatformEventKind::ConsentResult
                    && facts.vpn_permission == VpnPermission::Granted =>
            {
                Some((
                    LifecyclePhase::Stopped,
                    LifecycleOperationOutcome::Completed,
                    None,
                ))
            }
            LifecycleCommandKind::RequestVpnConsent
                if facts.event == PlatformEventKind::ConsentResult =>
            {
                Some((
                    LifecyclePhase::PermissionRequired,
                    LifecycleOperationOutcome::Rejected,
                    Some(LifecycleFailure::PermissionDenied),
                ))
            }
            LifecycleCommandKind::Start
                if facts.event == PlatformEventKind::ActivationCompleted
                    && next.activation_ready() =>
            {
                Some((
                    LifecyclePhase::Running,
                    LifecycleOperationOutcome::Completed,
                    None,
                ))
            }
            LifecycleCommandKind::Start if facts.event == PlatformEventKind::ActivationFailed => {
                Some((
                    LifecyclePhase::Failed,
                    LifecycleOperationOutcome::Rejected,
                    Some(
                        facts
                            .activation_failure
                            .map(platform_failure)
                            .unwrap_or(LifecycleFailure::PlatformFailure),
                    ),
                ))
            }
            _ => None,
        };
        if let Some((phase, outcome, failure)) = terminal {
            next.phase = phase;
            next.failure = failure;
            next.advance();
            next.finish(
                active.command,
                active.correlation.operation_id,
                outcome,
                failure,
            );
            return Transition::Committed(next);
        }

        if matches!(
            facts.event,
            PlatformEventKind::ActivationProgress | PlatformEventKind::NetworkChanged
        ) {
            next.phase = if active.cancellation.is_some() {
                LifecyclePhase::Stopping
            } else {
                LifecyclePhase::Starting
            };
            next.failure = None;
            next.advance();
            return Transition::Committed(next);
        }
    }

    let mut active_unknown = None;
    match facts.event {
        PlatformEventKind::Revoked => {
            next.phase = LifecyclePhase::PermissionRequired;
            next.failure = Some(LifecycleFailure::PermissionDenied);
            active_unknown = next.active.as_ref().map(|active| active.command);
        }
        PlatformEventKind::ServiceDestroyed => {
            next.phase = if next.platform_clean() {
                LifecyclePhase::Failed
            } else {
                LifecyclePhase::RecoveryRequired
            };
            next.failure = Some(LifecycleFailure::ServiceDestroyed);
            active_unknown = next.active.as_ref().map(|active| active.command);
        }
        PlatformEventKind::CoreExited => {
            next.phase = LifecyclePhase::Failed;
            next.failure = Some(LifecycleFailure::CoreFailure);
            active_unknown = next.active.as_ref().map(|active| active.command);
        }
        PlatformEventKind::ActivationFailed => {
            next.phase = LifecyclePhase::Failed;
            next.failure = Some(
                facts
                    .activation_failure
                    .map(platform_failure)
                    .unwrap_or(LifecycleFailure::PlatformFailure),
            );
            active_unknown = next.active.as_ref().map(|active| active.command);
        }
        PlatformEventKind::ActivationCompleted if next.activation_ready() => {
            next.phase = LifecyclePhase::Running;
            next.failure = None;
        }
        PlatformEventKind::NetworkChanged if !facts.active_network => {
            next.phase = LifecyclePhase::Unavailable;
            next.failure = Some(LifecycleFailure::NetworkUnavailable);
        }
        PlatformEventKind::NetworkChanged if next.activation_ready() => {
            next.phase = LifecyclePhase::Running;
            next.failure = None;
        }
        PlatformEventKind::NetworkChanged => {
            next.phase = LifecyclePhase::Starting;
            next.failure = None;
        }
        PlatformEventKind::StopCompleted if next.active.is_none() && next.platform_clean() => {
            next.phase = LifecyclePhase::Stopped;
            next.failure = None;
        }
        _ if facts.recovery_evidence != PlatformRecoveryEvidence::None => {
            next.phase = LifecyclePhase::RecoveryRequired;
            next.failure = Some(LifecycleFailure::InvalidRecoveryEvidence);
            active_unknown = next.active.as_ref().map(|active| active.command);
        }
        PlatformEventKind::Observation
            if state.phase == LifecyclePhase::Unavailable && !facts.service_foreground =>
        {
            next.phase = LifecyclePhase::RecoveryRequired;
            next.failure = Some(LifecycleFailure::ServiceDestroyed);
        }
        PlatformEventKind::Observation
            if state.phase != LifecyclePhase::Starting
                && state.phase != LifecyclePhase::Stopping
                && facts.vpn_permission == VpnPermission::Required =>
        {
            next.phase = LifecyclePhase::PermissionRequired;
            next.failure = None;
        }
        _ => {}
    }
    if let Some(command) = active_unknown {
        let operation_id = next
            .active
            .as_ref()
            .expect("active operation disappeared")
            .correlation
            .operation_id
            .clone();
        next.finish(
            command,
            operation_id,
            LifecycleOperationOutcome::Unknown,
            next.failure,
        );
    }
    next.advance();
    if next.phase == LifecyclePhase::RecoveryRequired {
        Transition::RecoveryRequired(next)
    } else {
        Transition::Committed(next)
    }
}

fn platform_failure(failure: PlatformFailureKind) -> LifecycleFailure {
    match failure {
        PlatformFailureKind::ConfigurationNotLoaded => LifecycleFailure::ConfigurationNotLoaded,
        PlatformFailureKind::CoreExited | PlatformFailureKind::CoreStartFailed => {
            LifecycleFailure::CoreFailure
        }
        PlatformFailureKind::CoreUnavailable => LifecycleFailure::CoreUnavailable,
        PlatformFailureKind::NetworkUnavailable => LifecycleFailure::NetworkUnavailable,
        PlatformFailureKind::PermissionRevoked => LifecycleFailure::PermissionDenied,
        PlatformFailureKind::PublicRequestFailed => LifecycleFailure::PublicRequestFailed,
        PlatformFailureKind::TunEstablishFailed => LifecycleFailure::TunFailure,
        PlatformFailureKind::CleanupFailed => LifecycleFailure::PlatformFailure,
    }
}

fn reduce_cancel(
    state: &LifecycleState,
    operation_id: &str,
    timed_out: bool,
) -> Transition<LifecycleState, LifecycleEffect, LifecycleMachineError> {
    let Some(active) = state
        .active
        .clone()
        .filter(|active| active.correlation.operation_id == operation_id)
    else {
        return Transition::Unchanged;
    };
    let mut next = state.clone();
    let consequential = matches!(
        active.command,
        LifecycleCommandKind::Start | LifecycleCommandKind::Stop
    );
    let current_effect_id = active
        .cleanup
        .as_ref()
        .map_or(active.correlation.effect_id, |cleanup| cleanup.effect_id);
    let next_effect_id = current_effect_id.saturating_add(1);
    let mut effects = vec![LifecycleEffect::cancel(
        active.correlation.with_effect(current_effect_id),
    )];
    if consequential {
        next.phase = LifecyclePhase::Stopping;
        if let Some(active) = next.active.as_mut() {
            active.cancellation = Some(if timed_out {
                LifecycleOperationOutcome::Unknown
            } else {
                LifecycleOperationOutcome::Cancelled
            });
            active.cleanup = Some(CleanupBarrier::new(next_effect_id));
        }
        effects.push(LifecycleEffect::spawn(
            PlatformAction::StopForegroundService,
            active.correlation.with_effect(next_effect_id),
        ));
    }
    let outcome = if timed_out || consequential {
        LifecycleOperationOutcome::Unknown
    } else {
        LifecycleOperationOutcome::Cancelled
    };
    let failure = if timed_out {
        LifecycleFailure::Timeout
    } else {
        LifecycleFailure::Cancelled
    };
    next.failure = consequential.then_some(failure);
    next.advance();
    if !consequential {
        next.finish(
            active.command,
            operation_id.to_owned(),
            outcome,
            Some(failure),
        );
    }
    Transition::EffectEmitting {
        state: next,
        effects: EffectBatch::from_first(effects.remove(0), effects),
    }
}

fn reduce_shutdown(
    state: &LifecycleState,
) -> Transition<LifecycleState, LifecycleEffect, LifecycleMachineError> {
    if state.active.is_none() && state.platform_clean() {
        return Transition::Unchanged;
    }
    let mut next = state.clone();
    let (current, cleanup_correlation) = if let Some(active) = state.active.clone() {
        let current_effect_id = active
            .cleanup
            .as_ref()
            .map_or(active.correlation.effect_id, |cleanup| cleanup.effect_id);
        (
            Some(active.clone()),
            active
                .correlation
                .with_effect(current_effect_id.saturating_add(1)),
        )
    } else {
        let correlation = Correlation {
            machine_authority: state.authority_id.clone(),
            scope_epoch: state.scope_epoch,
            operation_id: "shutdown-cleanup".into(),
            admitted_revision: state.revision.saturating_add(1),
            effect_id: 1,
        };
        (None, correlation)
    };
    if let Some(active) = next.active.as_mut() {
        if active.command != LifecycleCommandKind::Stop && active.cancellation.is_none() {
            active.cancellation = Some(LifecycleOperationOutcome::Unknown);
        }
        active.cleanup = Some(CleanupBarrier::new(cleanup_correlation.effect_id));
    } else {
        next.active = Some(ActiveOperation {
            command: LifecycleCommandKind::Stop,
            correlation: cleanup_correlation.clone(),
            cancellation: Some(LifecycleOperationOutcome::Unknown),
            cleanup: Some(CleanupBarrier::new(cleanup_correlation.effect_id)),
        });
        next.push_operation(LifecycleOperation {
            failure: Some(LifecycleFailure::Cancelled),
            kind: LifecycleCommandKind::Stop,
            operation_id: cleanup_correlation.operation_id.clone(),
            outcome: LifecycleOperationOutcome::Pending,
        });
    }
    next.phase = LifecyclePhase::Stopping;
    next.failure = Some(LifecycleFailure::Cancelled);
    next.advance();
    let cleanup =
        LifecycleEffect::spawn(PlatformAction::StopForegroundService, cleanup_correlation);
    let effects = if let Some(active) = current {
        EffectBatch::from_first(
            LifecycleEffect::cancel(
                active.correlation.with_effect(
                    active
                        .cleanup
                        .as_ref()
                        .map_or(active.correlation.effect_id, |cleanup| cleanup.effect_id),
                ),
            ),
            vec![cleanup],
        )
    } else {
        EffectBatch::one(cleanup)
    };
    Transition::EffectEmitting {
        state: next,
        effects,
    }
}

/// Closed, feature-gated replay of the real Android lifecycle machine.
///
/// The repository SimulatedHost consumes this module rather than maintaining a
/// second VPN reducer. It deliberately exposes only synthetic identities,
/// effect/result enums, logical revisions, and terminal phase evidence.
#[cfg(feature = "simulated-host")]
pub mod simulated_host {
    use mish_state_machine::{Correlation, Disposition, Machine, Transition};
    use serde::{Deserialize, Serialize};

    use super::{
        CoreConfigState, LifecycleCommandKind, LifecycleFailure, LifecycleInput, LifecycleMachine,
        LifecycleOperationOutcome, LifecyclePhase, LifecycleState, PlatformAction,
        PlatformEventKind, PlatformFacts, PlatformLifecycleAuthority, PlatformRecoveryEvidence,
        VpnPermission,
    };
    use crate::generated::platform_facts::{NotificationPermission, PlatformAvailability};

    const TRANSCRIPT_SCHEMA_VERSION: u8 = 2;
    pub const TRANSCRIPT_LIMIT: usize = 32;

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum Scenario {
        Success,
        Failure,
        Timeout,
        Cancellation,
        Replacement,
        LateCompletion,
        CleanupRetry,
        FinalizerBarrier,
        Recreation,
        AdmissionRejected,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum EffectKind {
        Command,
        Cancel,
        Stop,
        Callback,
        LateCompletion,
        Replacement,
        Admission,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum ResultKind {
        Pending,
        Applied,
        Failed,
        Retried,
        Cancelled,
        TimedOut,
        Replaced,
        Retired,
        RecoveryRequired,
        Rejected,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct TranscriptEvent {
        pub authority_id: u8,
        pub runtime_id: u8,
        pub scope_epoch: u64,
        pub operation_id: u8,
        pub admitted_revision: u64,
        pub effect_id: u64,
        pub logical_time: u64,
        pub effect: EffectKind,
        pub result: ResultKind,
    }

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct Transcript {
        pub schema_version: u8,
        pub scenario: Scenario,
        pub events: Vec<TranscriptEvent>,
        pub final_phase: LifecyclePhase,
        pub final_failure: Option<LifecycleFailure>,
        pub final_outcome: Option<LifecycleOperationOutcome>,
        pub stopped_clean: bool,
        pub stale_completion_retired: bool,
    }

    impl Transcript {
        pub fn parse(encoded: &str) -> Result<Self, &'static str> {
            let transcript: Self =
                serde_json::from_str(encoded).map_err(|_| "android transcript schema rejected")?;
            if transcript.schema_version != TRANSCRIPT_SCHEMA_VERSION
                || transcript.events.is_empty()
                || transcript.events.len() > TRANSCRIPT_LIMIT
                || transcript.events.iter().enumerate().any(|(index, event)| {
                    event.authority_id == 0
                        || event.runtime_id == 0
                        || event.scope_epoch == 0
                        || event.operation_id == 0
                        || event.admitted_revision == 0
                        || event.effect_id == 0
                        || event.logical_time != index as u64 + 1
                })
            {
                return Err("android transcript bounds rejected");
            }
            Ok(transcript)
        }
    }

    struct SimulatedHost {
        state: LifecycleState,
        events: Vec<TranscriptEvent>,
        stale_completion_retired: bool,
    }

    impl SimulatedHost {
        fn new() -> Self {
            Self {
                state: LifecycleState::initial(
                    "vpn-authority-1".into(),
                    "vpn-session-1".into(),
                    facts(1),
                ),
                events: Vec::new(),
                stale_completion_retired: false,
            }
        }

        fn active_stop() -> Self {
            let mut host = Self::new();
            host.state.facts = active_facts(1);
            host.state.phase = LifecyclePhase::Running;
            host
        }

        fn correlation(&self, operation_id: u8) -> Correlation {
            Correlation {
                machine_authority: self.state.authority_id.clone(),
                scope_epoch: self.state.scope_epoch,
                operation_id: format!("op-{operation_id}"),
                admitted_revision: self.state.revision.saturating_add(1),
                effect_id: 1,
            }
        }

        fn current_cleanup(&self) -> Correlation {
            let active = self
                .state
                .active
                .as_ref()
                .expect("scenario cleanup must retain an active operation");
            let effect_id = active
                .cleanup
                .as_ref()
                .map_or(active.correlation.effect_id, |cleanup| cleanup.effect_id);
            active.correlation.with_effect(effect_id)
        }

        fn apply(
            &mut self,
            input: LifecycleInput,
            effect: EffectKind,
            result: ResultKind,
            correlation: Option<&Correlation>,
        ) -> Disposition {
            let transition = LifecycleMachine.reduce(&self.state, &input);
            let disposition = transition.disposition();
            match transition {
                Transition::Accepted(state)
                | Transition::Committed(state)
                | Transition::Cancelled(state)
                | Transition::Failed(state)
                | Transition::RecoveryRequired(state)
                | Transition::EffectEmitting { state, .. } => self.state = state,
                Transition::Retired => {
                    self.stale_completion_retired = true;
                }
                Transition::Unchanged => {}
                Transition::Rejected(error) => panic!("simulated lifecycle rejected: {error:?}"),
            }
            if self.events.len() == TRANSCRIPT_LIMIT {
                panic!("simulated Android lifecycle transcript overflow");
            }
            let correlation = correlation.cloned().or_else(|| {
                self.state
                    .active
                    .as_ref()
                    .map(|active| active.correlation.clone())
            });
            let correlation = correlation.expect("scenario event must carry correlation");
            self.events.push(TranscriptEvent {
                authority_id: 1,
                runtime_id: 1,
                scope_epoch: correlation.scope_epoch,
                operation_id: 1,
                admitted_revision: correlation.admitted_revision,
                effect_id: correlation.effect_id,
                logical_time: self.events.len() as u64 + 1,
                effect,
                result,
            });
            disposition
        }

        fn stop_result(&mut self, sequence: u64, clean: bool) {
            let correlation = self.current_cleanup();
            let facts = if clean {
                clean_facts(sequence, PlatformEventKind::StopCompleted)
            } else {
                active_facts_for(sequence, &correlation)
            };
            self.apply(
                LifecycleInput::EffectCompleted {
                    action: PlatformAction::StopForegroundService,
                    correlation: correlation.clone(),
                    facts,
                },
                EffectKind::Stop,
                if clean {
                    ResultKind::Applied
                } else {
                    ResultKind::Failed
                },
                Some(&correlation),
            );
        }

        fn stop_callback(&mut self, sequence: u64, clean: bool) -> Disposition {
            let correlation = self.current_cleanup();
            let facts = if clean {
                clean_facts(sequence, PlatformEventKind::StopCompleted)
            } else {
                active_facts_for(sequence, &correlation)
            };
            self.apply(
                LifecycleInput::PlatformObserved(facts),
                EffectKind::Callback,
                if clean {
                    ResultKind::Applied
                } else {
                    ResultKind::Failed
                },
                Some(&correlation),
            )
        }

        fn transcript(self, scenario: Scenario) -> Transcript {
            let operation = self.state.latest_operation();
            Transcript {
                schema_version: TRANSCRIPT_SCHEMA_VERSION,
                scenario,
                events: self.events,
                final_phase: self.state.phase,
                final_failure: self.state.failure,
                final_outcome: operation.map(|operation| operation.outcome),
                stopped_clean: self.state.phase == LifecyclePhase::Stopped
                    && LifecycleState::facts_platform_clean(&self.state.facts),
                stale_completion_retired: self.stale_completion_retired,
            }
        }
    }

    pub fn run(scenario: Scenario) -> Transcript {
        match scenario {
            Scenario::Success | Scenario::FinalizerBarrier => {
                let mut host = SimulatedHost::active_stop();
                let correlation = host.correlation(1);
                host.apply(
                    LifecycleInput::Command {
                        command: LifecycleCommandKind::Stop,
                        correlation,
                        new_session_id: None,
                    },
                    EffectKind::Command,
                    ResultKind::Pending,
                    None,
                );
                host.stop_result(2, true);
                host.stop_callback(3, true);
                host.transcript(scenario)
            }
            Scenario::Failure => {
                let mut host = SimulatedHost::active_stop();
                let correlation = host.correlation(1);
                host.apply(
                    LifecycleInput::Command {
                        command: LifecycleCommandKind::Stop,
                        correlation,
                        new_session_id: None,
                    },
                    EffectKind::Command,
                    ResultKind::Pending,
                    None,
                );
                for sequence in [2, 3, 4, 5, 6, 7] {
                    host.stop_result(sequence, false);
                    if host.state.active.is_none() {
                        break;
                    }
                    host.stop_callback(sequence + 1, false);
                    if host.state.active.is_none() {
                        break;
                    }
                }
                host.transcript(scenario)
            }
            Scenario::CleanupRetry => {
                let mut host = SimulatedHost::active_stop();
                let correlation = host.correlation(1);
                host.apply(
                    LifecycleInput::Command {
                        command: LifecycleCommandKind::Stop,
                        correlation,
                        new_session_id: None,
                    },
                    EffectKind::Command,
                    ResultKind::Pending,
                    None,
                );
                host.stop_result(2, false);
                host.stop_callback(3, false);
                host.stop_result(4, true);
                host.stop_callback(5, true);
                host.transcript(scenario)
            }
            Scenario::Timeout | Scenario::Cancellation => {
                let mut host = SimulatedHost::new();
                let correlation = host.correlation(1);
                host.apply(
                    LifecycleInput::Command {
                        command: LifecycleCommandKind::Start,
                        correlation: correlation.clone(),
                        new_session_id: Some("vpn-session-2".into()),
                    },
                    EffectKind::Command,
                    ResultKind::Pending,
                    None,
                );
                let correlation = host
                    .state
                    .active
                    .as_ref()
                    .expect("start must be active")
                    .correlation
                    .clone();
                host.apply(
                    LifecycleInput::Cancel {
                        operation_id: correlation.operation_id.clone(),
                        timed_out: scenario == Scenario::Timeout,
                    },
                    EffectKind::Cancel,
                    if scenario == Scenario::Timeout {
                        ResultKind::TimedOut
                    } else {
                        ResultKind::Cancelled
                    },
                    Some(&correlation),
                );
                host.stop_result(2, true);
                host.stop_callback(3, true);
                host.transcript(scenario)
            }
            Scenario::Replacement => {
                let mut host = SimulatedHost::new();
                let old = host.correlation(1);
                host.state = LifecycleState::initial(
                    "vpn-authority-2".into(),
                    "vpn-session-2".into(),
                    facts(4),
                );
                let disposition = host.apply(
                    LifecycleInput::EffectCompleted {
                        action: PlatformAction::StartForegroundService,
                        correlation: old.clone(),
                        facts: clean_facts(5, PlatformEventKind::ActivationCompleted),
                    },
                    EffectKind::Replacement,
                    ResultKind::Replaced,
                    Some(&old),
                );
                assert_eq!(disposition, Disposition::Retired);
                host.transcript(scenario)
            }
            Scenario::LateCompletion => {
                let mut host = SimulatedHost::new();
                let old = host.correlation(1);
                host.apply(
                    LifecycleInput::Command {
                        command: LifecycleCommandKind::Start,
                        correlation: old.clone(),
                        new_session_id: Some("vpn-session-2".into()),
                    },
                    EffectKind::Command,
                    ResultKind::Pending,
                    Some(&old),
                );
                let active = host
                    .state
                    .active
                    .as_ref()
                    .expect("start must be active")
                    .correlation
                    .clone();
                host.apply(
                    LifecycleInput::Cancel {
                        operation_id: active.operation_id.clone(),
                        timed_out: false,
                    },
                    EffectKind::Cancel,
                    ResultKind::Cancelled,
                    Some(&active),
                );
                host.stop_result(2, true);
                host.stop_callback(3, true);
                let disposition = host.apply(
                    LifecycleInput::EffectCompleted {
                        action: PlatformAction::StartForegroundService,
                        correlation: old.clone(),
                        facts: clean_facts(4, PlatformEventKind::ActivationCompleted),
                    },
                    EffectKind::LateCompletion,
                    ResultKind::Retired,
                    Some(&old),
                );
                assert_eq!(disposition, Disposition::Retired);
                host.transcript(scenario)
            }
            Scenario::Recreation => {
                let mut host = SimulatedHost::active_stop();
                let persisted = host
                    .state
                    .facts
                    .lifecycle_authority
                    .clone()
                    .expect("active scenario must carry persisted authority");
                let mut recovered = facts(2);
                recovered.activation_session_id = Some("vpn-session-1".into());
                recovered.lifecycle_authority = Some(persisted);
                recovered.recovery_evidence = PlatformRecoveryEvidence::ForegroundExpected;
                host.state = LifecycleState::initial(
                    "replacement-authority".into(),
                    "replacement-session".into(),
                    recovered,
                );
                let correlation = host.correlation(1);
                host.apply(
                    LifecycleInput::Command {
                        command: LifecycleCommandKind::Stop,
                        correlation,
                        new_session_id: None,
                    },
                    EffectKind::Command,
                    ResultKind::Pending,
                    None,
                );
                host.stop_result(3, true);
                host.stop_callback(4, true);
                host.transcript(scenario)
            }
            Scenario::AdmissionRejected => {
                let mut host = SimulatedHost::new();
                host.state.facts.core_config_state = CoreConfigState::Unloaded;
                host.state.facts.loaded_config_digest = None;
                host.state.facts.loaded_config_revision = None;
                let correlation = host.correlation(1);
                let disposition = host.apply(
                    LifecycleInput::Command {
                        command: LifecycleCommandKind::Start,
                        correlation: correlation.clone(),
                        new_session_id: Some("vpn-session-2".into()),
                    },
                    EffectKind::Admission,
                    ResultKind::Rejected,
                    Some(&correlation),
                );
                assert_eq!(disposition, Disposition::Committed);
                host.transcript(scenario)
            }
        }
    }

    fn facts(sequence: u64) -> PlatformFacts {
        PlatformFacts {
            activation_failure: None,
            activation_session_id: None,
            active_network: false,
            config_failure_injection_available: false,
            core_abi_version: Some(1),
            core_availability: PlatformAvailability::Available,
            core_commit: Some("e26714a181ac0e2fa803453c0a8e9a9ce94e31cb".into()),
            core_config_state: CoreConfigState::Loaded,
            core_running: false,
            core_version: Some("v1.19.29".into()),
            core_wrapper_revision: Some("mish-mobile-core-v1".into()),
            dns_applied: false,
            event: PlatformEventKind::Observation,
            fact_sequence: sequence,
            facts_version: super::super::generated::platform_facts::ANDROID_PLATFORM_FACTS_VERSION,
            loaded_config_digest: Some("a".repeat(64)),
            loaded_config_revision: Some("revision-a".into()),
            lifecycle_authority: None,
            notification_permission: NotificationPermission::NotRequired,
            observed_at_millis: sequence,
            platform_session_id: "platform-session-1".into(),
            protected_socket_count: 0,
            public_request_observed: false,
            recovery_evidence: PlatformRecoveryEvidence::None,
            routes_applied: false,
            service_foreground: false,
            tun_established: false,
            validated_config_digest: None,
            validated_config_revision: None,
            vpn_permission: VpnPermission::Granted,
        }
    }

    fn active_facts(sequence: u64) -> PlatformFacts {
        let mut facts = facts(sequence);
        facts.activation_session_id = Some("vpn-session-1".into());
        facts.active_network = true;
        facts.core_running = true;
        facts.dns_applied = true;
        facts.lifecycle_authority = Some(PlatformLifecycleAuthority {
            machine_authority: "vpn-authority-1".into(),
            scope_epoch: 1,
            operation_id: "op-1".into(),
            admitted_revision: 2,
            effect_identity: "1".into(),
        });
        facts.protected_socket_count = 1;
        facts.public_request_observed = true;
        facts.routes_applied = true;
        facts.service_foreground = true;
        facts.tun_established = true;
        facts
    }

    fn active_facts_for(sequence: u64, correlation: &Correlation) -> PlatformFacts {
        let mut facts = active_facts(sequence);
        facts.lifecycle_authority = Some(PlatformLifecycleAuthority {
            machine_authority: correlation.machine_authority.clone(),
            scope_epoch: correlation.scope_epoch,
            operation_id: correlation.operation_id.clone(),
            admitted_revision: correlation.admitted_revision,
            effect_identity: correlation.effect_id.to_string(),
        });
        facts.event = PlatformEventKind::StopCompleted;
        facts
    }

    fn clean_facts(sequence: u64, event: PlatformEventKind) -> PlatformFacts {
        let mut facts = facts(sequence);
        facts.event = event;
        facts
    }
}

#[cfg(all(test, feature = "tauri-runtime"))]
mod tests {
    use super::*;
    use crate::generated::platform_facts::PlatformLifecycleAuthority;
    use crate::models::MobileVpnCommandResult;

    fn facts(sequence: u64) -> PlatformFacts {
        PlatformFacts {
            activation_failure: None,
            activation_session_id: None,
            active_network: false,
            config_failure_injection_available: false,
            core_abi_version: Some(1),
            core_availability: "available".into(),
            core_commit: Some("e26714a181ac0e2fa803453c0a8e9a9ce94e31cb".into()),
            core_config_state: "loaded".into(),
            core_running: false,
            core_version: Some("v1.19.29".into()),
            core_wrapper_revision: Some("mish-mobile-core-v1".into()),
            event: PlatformEventKind::Observation,
            fact_sequence: sequence,
            facts_version: crate::generated::platform_facts::ANDROID_PLATFORM_FACTS_VERSION,
            loaded_config_digest: Some("a".repeat(64)),
            loaded_config_revision: Some("revision-a".into()),
            lifecycle_authority: None,
            notification_permission: "not-required".into(),
            observed_at_millis: sequence,
            platform_session_id: "platform-1".into(),
            protected_socket_count: 0,
            public_request_observed: false,
            recovery_evidence: PlatformRecoveryEvidence::None,
            routes_applied: false,
            service_foreground: false,
            dns_applied: false,
            tun_established: false,
            validated_config_digest: None,
            validated_config_revision: None,
            vpn_permission: "granted".into(),
        }
    }

    fn correlation(operation: &str, revision: u64) -> Correlation {
        Correlation {
            machine_authority: "authority-1".into(),
            scope_epoch: 1,
            operation_id: operation.into(),
            admitted_revision: revision,
            effect_id: 1,
        }
    }

    fn state() -> LifecycleState {
        LifecycleState::initial("authority-1".into(), "session-1".into(), facts(1))
    }

    fn start_correlation_with_effect(state: &LifecycleState, effect_id: u64) -> Correlation {
        state
            .active
            .as_ref()
            .expect("cleanup barrier must retain an active operation")
            .correlation
            .with_effect(effect_id)
    }

    #[test]
    fn lifecycle_recreation_adopts_the_live_platform_authority_for_stop() {
        let mut recovery = facts(41);
        recovery.activation_session_id = None;
        recovery.loaded_config_digest = None;
        recovery.loaded_config_revision = None;
        recovery.lifecycle_authority = Some(PlatformLifecycleAuthority {
            machine_authority: "persisted-authority".into(),
            scope_epoch: 7,
            operation_id: "persisted-start".into(),
            admitted_revision: 23,
            effect_identity: "1".into(),
        });
        recovery.recovery_evidence = PlatformRecoveryEvidence::ForegroundExpected;

        let recreated = LifecycleState::initial(
            "new-rust-authority".into(),
            "new-rust-session".into(),
            recovery,
        );
        assert_eq!(recreated.authority_id, "persisted-authority");
        assert_eq!(recreated.scope_epoch, 7);
        assert_eq!(recreated.revision, 23);
        assert_eq!(recreated.session_id, "new-rust-session");
        assert_eq!(recreated.phase, LifecyclePhase::RecoveryRequired);

        let stop = Correlation {
            machine_authority: recreated.authority_id.clone(),
            scope_epoch: recreated.scope_epoch,
            operation_id: "stop-after-recreation".into(),
            admitted_revision: recreated.revision + 1,
            effect_id: 1,
        };
        let stopping = next_state(LifecycleMachine.reduce(
            &recreated,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Stop,
                correlation: stop.clone(),
                new_session_id: None,
            },
        ));
        assert_eq!(stopping.phase, LifecyclePhase::Stopping);
        assert_eq!(
            stopping.active.as_ref().unwrap().correlation,
            stop,
            "the recreated coordinator must issue a successor under the persisted machine",
        );
    }

    fn next_state(
        transition: Transition<LifecycleState, LifecycleEffect, LifecycleMachineError>,
    ) -> LifecycleState {
        match transition {
            Transition::Accepted(state)
            | Transition::Committed(state)
            | Transition::Cancelled(state)
            | Transition::Failed(state)
            | Transition::RecoveryRequired(state)
            | Transition::EffectEmitting { state, .. } => state,
            transition => panic!(
                "transition did not carry state: {:?}",
                transition.disposition()
            ),
        }
    }

    #[test]
    fn real_start_commits_only_after_every_same_session_observation() {
        let machine = LifecycleMachine;
        let mut initial = state();
        initial.facts.core_availability = "available".into();
        initial.facts.core_config_state = "loaded".into();
        initial.facts.loaded_config_digest = Some("a".repeat(64));
        initial.facts.loaded_config_revision = Some("revision-a".into());
        let start_correlation = correlation("start-1", 2);
        let starting = next_state(machine.reduce(
            &initial,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: start_correlation,
                new_session_id: Some("session-2".into()),
            },
        ));
        assert_eq!(starting.phase, LifecyclePhase::Starting);
        assert_eq!(
            starting.operation("start-1").unwrap().outcome,
            LifecycleOperationOutcome::Pending
        );

        let mut observed = facts(2);
        observed.event = PlatformEventKind::ActivationProgress;
        observed.service_foreground = true;
        observed.activation_session_id = Some("session-2".into());
        let foreground_only = next_state(machine.reduce(
            &starting,
            &LifecycleInput::PlatformObserved(observed.clone()),
        ));
        assert_eq!(foreground_only.phase, LifecyclePhase::Starting);
        assert_eq!(
            foreground_only.operation("start-1").unwrap().outcome,
            LifecycleOperationOutcome::Pending
        );

        observed.event = PlatformEventKind::ActivationCompleted;
        observed.fact_sequence = 3;
        observed.active_network = true;
        observed.core_running = true;
        observed.dns_applied = true;
        observed.protected_socket_count = 1;
        observed.public_request_observed = true;
        observed.routes_applied = true;
        observed.tun_established = true;
        observed.core_availability = "available".into();
        observed.core_config_state = "loaded".into();
        observed.loaded_config_digest = Some("a".repeat(64));
        observed.loaded_config_revision = Some("revision-a".into());
        let terminal = next_state(machine.reduce(
            &foreground_only,
            &LifecycleInput::PlatformObserved(observed),
        ));
        assert_eq!(terminal.phase, LifecyclePhase::Running);
        assert_eq!(
            terminal.operation("start-1").unwrap().outcome,
            LifecycleOperationOutcome::Completed
        );
        assert_eq!(terminal.session_id, "session-2");
    }

    #[test]
    fn stale_stop_callback_cannot_commit_stopped_over_an_active_start() {
        let machine = LifecycleMachine;
        let start = correlation("start-stale-stop", 2);
        let starting = next_state(machine.reduce(
            &state(),
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: start,
                new_session_id: Some("session-stale-stop".into()),
            },
        ));
        let mut stale = starting.facts.clone();
        stale.fact_sequence += 1;
        stale.event = PlatformEventKind::StopCompleted;
        let transition = machine.reduce(&starting, &LifecycleInput::PlatformObserved(stale));
        let observed = next_state(transition);
        assert_eq!(observed.phase, LifecyclePhase::Starting);
        assert!(observed.active.is_some());
        assert_ne!(observed.phase, LifecyclePhase::Stopped);
    }

    #[test]
    fn stale_cleanup_authority_is_retired_without_advancing_the_barrier() {
        let machine = LifecycleMachine;
        let mut running = state();
        running.phase = LifecyclePhase::Running;
        running.facts.service_foreground = true;
        running.facts.activation_session_id = Some("session-1".into());
        let stop = correlation("stop-stale-callback", 2);
        let stopping = next_state(machine.reduce(
            &running,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Stop,
                correlation: stop,
                new_session_id: None,
            },
        ));
        let mut stale = stopping.facts.clone();
        stale.fact_sequence += 1;
        stale.event = PlatformEventKind::StopCompleted;
        stale.lifecycle_authority = Some(PlatformLifecycleAuthority {
            machine_authority: "authority-1".into(),
            scope_epoch: 1,
            operation_id: "old-operation".into(),
            admitted_revision: 1,
            effect_identity: "1".into(),
        });
        assert!(matches!(
            machine.reduce(&stopping, &LifecycleInput::PlatformObserved(stale)),
            Transition::Retired
        ));
        assert_eq!(stopping.phase, LifecyclePhase::Stopping);
        assert_eq!(
            stopping
                .active
                .as_ref()
                .unwrap()
                .cleanup
                .as_ref()
                .unwrap()
                .effect_id,
            1
        );
        assert!(
            !stopping
                .active
                .as_ref()
                .unwrap()
                .cleanup
                .as_ref()
                .unwrap()
                .callback_observed
        );
    }

    #[test]
    fn cancelled_start_stays_pending_until_cleanup_and_rejects_duplicates() {
        let machine = LifecycleMachine;
        let mut initial = state();
        initial.facts.core_availability = "available".into();
        initial.facts.core_config_state = "loaded".into();
        initial.facts.loaded_config_digest = Some("b".repeat(64));
        initial.facts.loaded_config_revision = Some("revision-b".into());
        let start_correlation = correlation("start-cancel", 2);
        let starting = next_state(machine.reduce(
            &initial,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: start_correlation,
                new_session_id: Some("session-cancel".into()),
            },
        ));
        let cleaning = next_state(machine.reduce(
            &starting,
            &LifecycleInput::Cancel {
                operation_id: "start-cancel".into(),
                timed_out: false,
            },
        ));
        assert_eq!(cleaning.phase, LifecyclePhase::Stopping);
        assert_eq!(
            cleaning.operation("start-cancel").unwrap().outcome,
            LifecycleOperationOutcome::Pending
        );

        let duplicate = next_state(machine.reduce(
            &cleaning,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: correlation("duplicate", cleaning.revision + 1),
                new_session_id: Some("session-duplicate".into()),
            },
        ));
        assert_eq!(
            duplicate.operation("duplicate").unwrap().failure,
            Some(LifecycleFailure::Busy)
        );

        let mut stopped_result = cleaning.facts.clone();
        stopped_result.event = PlatformEventKind::StopCompleted;
        stopped_result.fact_sequence += 1;
        let waiting = next_state(machine.reduce(
            &cleaning,
            &LifecycleInput::EffectCompleted {
                action: PlatformAction::StopForegroundService,
                correlation: start_correlation_with_effect(&cleaning, 2),
                facts: stopped_result.clone(),
            },
        ));
        assert_eq!(waiting.phase, LifecyclePhase::Stopping);
        let mut stopped_callback = stopped_result;
        stopped_callback.fact_sequence += 1;
        let terminal = next_state(machine.reduce(
            &waiting,
            &LifecycleInput::PlatformObserved(stopped_callback),
        ));
        assert_eq!(terminal.phase, LifecyclePhase::Stopped);
        assert_eq!(
            terminal.operation("start-cancel").unwrap().outcome,
            LifecycleOperationOutcome::Cancelled
        );
    }

    #[test]
    fn shutdown_keeps_consequential_work_pending_until_cleanup_completes() {
        let machine = LifecycleMachine;
        let start_correlation = correlation("shutdown-start", 2);
        let starting = next_state(machine.reduce(
            &state(),
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: start_correlation.clone(),
                new_session_id: Some("shutdown-session".into()),
            },
        ));
        let cleaning = next_state(machine.reduce(&starting, &LifecycleInput::Shutdown));
        assert_eq!(cleaning.phase, LifecyclePhase::Stopping);
        assert_eq!(
            cleaning.operation("shutdown-start").unwrap().outcome,
            LifecycleOperationOutcome::Pending
        );

        let mut stopped_result = cleaning.facts.clone();
        stopped_result.event = PlatformEventKind::StopCompleted;
        stopped_result.fact_sequence += 1;
        let waiting = next_state(machine.reduce(
            &cleaning,
            &LifecycleInput::EffectCompleted {
                action: PlatformAction::StopForegroundService,
                correlation: start_correlation.with_effect(2),
                facts: stopped_result.clone(),
            },
        ));
        assert_eq!(waiting.phase, LifecyclePhase::Stopping);
        let mut stopped_callback = stopped_result;
        stopped_callback.fact_sequence += 1;
        let terminal = next_state(machine.reduce(
            &waiting,
            &LifecycleInput::PlatformObserved(stopped_callback),
        ));
        assert_eq!(terminal.phase, LifecyclePhase::Stopped);
        assert_eq!(
            terminal.operation("shutdown-start").unwrap().outcome,
            LifecycleOperationOutcome::Unknown
        );
    }

    #[test]
    fn consent_notification_and_stop_settle_from_typed_platform_facts() {
        let machine = LifecycleMachine;
        let mut permission_required_facts = facts(1);
        permission_required_facts.vpn_permission = "required".into();
        permission_required_facts.notification_permission = "required".into();
        let initial = LifecycleState::initial(
            "authority-1".into(),
            "session-1".into(),
            permission_required_facts,
        );

        let consent_correlation = correlation("consent-1", 2);
        let requesting = next_state(machine.reduce(
            &initial,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::RequestVpnConsent,
                correlation: consent_correlation.clone(),
                new_session_id: None,
            },
        ));
        let mut consented_facts = requesting.facts.clone();
        consented_facts.event = PlatformEventKind::ConsentResult;
        consented_facts.fact_sequence = 2;
        consented_facts.vpn_permission = "granted".into();
        let consented = next_state(machine.reduce(
            &requesting,
            &LifecycleInput::EffectCompleted {
                action: PlatformAction::RequestVpnConsent,
                correlation: consent_correlation,
                facts: consented_facts,
            },
        ));
        assert_eq!(consented.phase, LifecyclePhase::Stopped);
        assert_eq!(
            consented.operation("consent-1").unwrap().outcome,
            LifecycleOperationOutcome::Completed
        );

        let notification_correlation = correlation("notification-1", consented.revision + 1);
        let requesting_notification = next_state(machine.reduce(
            &consented,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::RequestNotificationPermission,
                correlation: notification_correlation.clone(),
                new_session_id: None,
            },
        ));
        let mut notified_facts = requesting_notification.facts.clone();
        notified_facts.event = PlatformEventKind::NotificationResult;
        notified_facts.fact_sequence = 3;
        notified_facts.notification_permission = "granted".into();
        let notified = next_state(machine.reduce(
            &requesting_notification,
            &LifecycleInput::EffectCompleted {
                action: PlatformAction::RequestNotificationPermission,
                correlation: notification_correlation,
                facts: notified_facts,
            },
        ));
        assert_eq!(
            notified.operation("notification-1").unwrap().outcome,
            LifecycleOperationOutcome::Completed
        );

        let mut foreground = notified.clone();
        foreground.phase = LifecyclePhase::Unavailable;
        foreground.facts.service_foreground = true;
        let stop_correlation = correlation("stop-1", foreground.revision + 1);
        let stopping = next_state(machine.reduce(
            &foreground,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Stop,
                correlation: stop_correlation.clone(),
                new_session_id: None,
            },
        ));
        assert_eq!(stopping.phase, LifecyclePhase::Stopping);
        let mut stopped_result = stopping.facts.clone();
        stopped_result.event = PlatformEventKind::StopCompleted;
        stopped_result.fact_sequence = 4;
        stopped_result.service_foreground = false;
        let waiting = next_state(machine.reduce(
            &stopping,
            &LifecycleInput::EffectCompleted {
                action: PlatformAction::StopForegroundService,
                correlation: stop_correlation.clone(),
                facts: stopped_result.clone(),
            },
        ));
        assert_eq!(waiting.phase, LifecyclePhase::Stopping);
        let mut stopped_callback = stopped_result;
        stopped_callback.fact_sequence = 5;
        let stopped = next_state(machine.reduce(
            &waiting,
            &LifecycleInput::PlatformObserved(stopped_callback),
        ));
        assert_eq!(stopped.phase, LifecyclePhase::Stopped);
        assert_eq!(
            stopped.operation("stop-1").unwrap().outcome,
            LifecycleOperationOutcome::Completed
        );
    }

    #[test]
    fn duplicate_operation_identity_cannot_replace_the_admitted_command() {
        let machine = LifecycleMachine;
        let correlation = correlation("same", 2);
        let starting = next_state(machine.reduce(
            &state(),
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: correlation.clone(),
                new_session_id: Some("session-2".into()),
            },
        ));
        assert!(matches!(
            machine.reduce(
                &starting,
                &LifecycleInput::Command {
                    command: LifecycleCommandKind::Start,
                    correlation: correlation.clone(),
                    new_session_id: Some("session-2".into()),
                }
            ),
            Transition::Unchanged
        ));
        assert!(matches!(
            machine.reduce(
                &starting,
                &LifecycleInput::Command {
                    command: LifecycleCommandKind::Stop,
                    correlation,
                    new_session_id: None,
                }
            ),
            Transition::Unchanged
        ));
        assert_eq!(
            starting.operation("same").unwrap().kind,
            LifecycleCommandKind::Start
        );
        assert!(starting.active.is_some());
    }

    #[test]
    fn command_result_snapshot_stays_bound_to_the_requested_operation() {
        let machine = LifecycleMachine;
        let first = next_state(machine.reduce(
            &state(),
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Stop,
                correlation: correlation("stop-1", 2),
                new_session_id: None,
            },
        ));
        let second = next_state(machine.reduce(
            &first,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Stop,
                correlation: correlation("stop-2", first.revision + 1),
                new_session_id: None,
            },
        ));

        let result = MobileVpnCommandResult::from_state(&second, "stop-1")
            .expect("the earlier terminal operation must remain addressable");
        assert_eq!(result.operation.operation_id, "stop-1");
        assert_eq!(
            result
                .snapshot
                .operation
                .as_ref()
                .map(|operation| operation.operation_id.as_str()),
            Some("stop-1")
        );
    }

    #[test]
    fn stale_platform_authority_and_late_completion_cannot_replace_truth() {
        let machine = LifecycleMachine;
        let correlation = correlation("start-1", 2);
        let starting = next_state(machine.reduce(
            &state(),
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: correlation.clone(),
                new_session_id: Some("session-2".into()),
            },
        ));
        let cancelled = next_state(machine.reduce(
            &starting,
            &LifecycleInput::Cancel {
                operation_id: "start-1".into(),
                timed_out: false,
            },
        ));
        assert_eq!(cancelled.phase, LifecyclePhase::Stopping);
        assert_eq!(
            cancelled.operation("start-1").unwrap().outcome,
            LifecycleOperationOutcome::Pending
        );
        let mut late = facts(2);
        late.event = PlatformEventKind::ActivationCompleted;
        late.service_foreground = true;
        assert!(matches!(
            machine.reduce(
                &cancelled,
                &LifecycleInput::EffectCompleted {
                    action: PlatformAction::StartForegroundService,
                    correlation,
                    facts: late,
                }
            ),
            Transition::Retired
        ));

        let mut stale_authority = facts(3);
        stale_authority.platform_session_id = "old-platform".into();
        assert!(matches!(
            machine.reduce(
                &cancelled,
                &LifecycleInput::PlatformObserved(stale_authority)
            ),
            Transition::Retired
        ));
    }

    #[test]
    fn broadcast_before_effect_response_is_an_idempotent_confirmation() {
        let machine = LifecycleMachine;
        let correlation = correlation("start-1", 2);
        let starting = next_state(machine.reduce(
            &state(),
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: correlation.clone(),
                new_session_id: Some("session-2".into()),
            },
        ));
        let mut observed = facts(2);
        observed.event = PlatformEventKind::ActivationCompleted;
        observed.activation_session_id = Some("session-2".into());
        observed.active_network = true;
        observed.core_running = true;
        observed.dns_applied = true;
        observed.protected_socket_count = 1;
        observed.public_request_observed = true;
        observed.routes_applied = true;
        observed.service_foreground = true;
        observed.tun_established = true;
        let broadcast = next_state(machine.reduce(
            &starting,
            &LifecycleInput::PlatformObserved(observed.clone()),
        ));
        assert_eq!(broadcast.phase, LifecyclePhase::Running);
        assert_eq!(
            broadcast.operation("start-1").unwrap().outcome,
            LifecycleOperationOutcome::Completed
        );
        assert!(matches!(
            machine.reduce(
                &broadcast,
                &LifecycleInput::EffectCompleted {
                    action: PlatformAction::StartForegroundService,
                    correlation,
                    facts: observed,
                }
            ),
            Transition::Retired
        ));
    }

    #[test]
    fn revoke_destroy_and_invalid_recovery_are_deterministic() {
        let machine = LifecycleMachine;
        for (event, failure) in [
            (
                PlatformEventKind::Revoked,
                LifecycleFailure::PermissionDenied,
            ),
            (
                PlatformEventKind::ServiceDestroyed,
                LifecycleFailure::ServiceDestroyed,
            ),
        ] {
            let mut observed = facts(2);
            observed.event = event;
            observed.vpn_permission = "required".into();
            let next =
                next_state(machine.reduce(&state(), &LifecycleInput::PlatformObserved(observed)));
            assert_eq!(next.failure, Some(failure));
        }

        let mut invalid = facts(1);
        invalid.recovery_evidence = PlatformRecoveryEvidence::Invalid;
        let recovered = LifecycleState::initial("authority-2".into(), "session-2".into(), invalid);
        assert_eq!(recovered.phase, LifecyclePhase::RecoveryRequired);
        let rejected_start = next_state(machine.reduce(
            &recovered,
            &LifecycleInput::Command {
                command: LifecycleCommandKind::Start,
                correlation: correlation("start-before-recovery", 2),
                new_session_id: Some("session-3".into()),
            },
        ));
        assert_eq!(rejected_start.phase, LifecyclePhase::RecoveryRequired);
        assert_eq!(
            rejected_start
                .operation("start-before-recovery")
                .unwrap()
                .failure,
            Some(LifecycleFailure::InvalidRecoveryEvidence)
        );
    }
}
