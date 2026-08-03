#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::VecDeque;

use mish_state_machine::{
    CorrelatedEffect, Correlation, EffectBatch, EffectMode, Machine, TaskFailure, Transition,
};
use serde::{Deserialize, Serialize};

const OPERATION_HISTORY_LIMIT: usize = 16;

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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PlatformEventKind {
    Observation,
    ConsentResult,
    NotificationResult,
    ActivationProgress,
    ActivationCompleted,
    ActivationFailed,
    StopCompleted,
    NetworkChanged,
    CoreExited,
    Revoked,
    ServiceDestroyed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PlatformFailureKind {
    CleanupFailed,
    ConfigurationNotLoaded,
    CoreExited,
    CoreStartFailed,
    CoreUnavailable,
    NetworkUnavailable,
    PermissionRevoked,
    PublicRequestFailed,
    TunEstablishFailed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PlatformRecoveryEvidence {
    None,
    ForegroundExpected,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlatformFacts {
    pub activation_failure: Option<PlatformFailureKind>,
    pub activation_session_id: Option<String>,
    pub active_network: bool,
    pub config_failure_injection_available: bool,
    pub core_abi_version: Option<u8>,
    pub core_availability: String,
    pub core_commit: Option<String>,
    pub core_config_state: String,
    pub core_running: bool,
    pub core_version: Option<String>,
    pub core_wrapper_revision: Option<String>,
    pub event: PlatformEventKind,
    pub fact_sequence: u64,
    pub loaded_config_digest: Option<String>,
    pub loaded_config_revision: Option<String>,
    pub notification_permission: String,
    pub observed_at_millis: u64,
    pub platform_session_id: String,
    pub protected_socket_count: u64,
    pub public_request_observed: bool,
    pub recovery_evidence: PlatformRecoveryEvidence,
    pub routes_applied: bool,
    pub service_foreground: bool,
    pub dns_applied: bool,
    pub tun_established: bool,
    pub validated_config_digest: Option<String>,
    pub validated_config_revision: Option<String>,
    pub vpn_permission: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LifecycleState {
    pub authority_id: String,
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
}

impl LifecycleState {
    pub(crate) fn initial(authority_id: String, session_id: String, facts: PlatformFacts) -> Self {
        let (phase, failure) = match facts.recovery_evidence {
            PlatformRecoveryEvidence::ForegroundExpected | PlatformRecoveryEvidence::Invalid => (
                LifecyclePhase::RecoveryRequired,
                Some(LifecycleFailure::InvalidRecoveryEvidence),
            ),
            PlatformRecoveryEvidence::None if facts.vpn_permission == "required" => {
                (LifecyclePhase::PermissionRequired, None)
            }
            PlatformRecoveryEvidence::None => (LifecyclePhase::Stopped, None),
        };
        Self {
            authority_id,
            revision: 1,
            sequence: 1,
            session_id,
            phase,
            failure,
            facts,
            active: None,
            operations: VecDeque::new(),
        }
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
        if facts.platform_session_id != self.facts.platform_session_id
            || facts.fact_sequence <= self.facts.fact_sequence
        {
            return Err(LifecycleFailure::StalePlatformAuthority);
        }
        self.facts = facts.clone();
        Ok(())
    }

    fn apply_effect_facts(&mut self, facts: &PlatformFacts) -> Result<(), LifecycleFailure> {
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
            && self.facts.vpn_permission == "granted"
    }

    fn platform_clean(&self) -> bool {
        !self.facts.core_running
            && !self.facts.dns_applied
            && !self.facts.public_request_observed
            && !self.facts.routes_applied
            && !self.facts.service_foreground
            && !self.facts.tun_established
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
        failure: TaskFailure,
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
            LifecycleInput::TaskFailed {
                correlation,
                failure: _,
            } => reduce_task_failed(state, correlation),
            LifecycleInput::Shutdown => reduce_shutdown(state),
        }
    }

    fn state_label(&self, state: &Self::State) -> &'static str {
        match state.phase {
            LifecyclePhase::Stopped => "stopped",
            LifecyclePhase::PermissionRequired => "permission-required",
            LifecyclePhase::Starting => "starting",
            LifecyclePhase::Running => "running",
            LifecyclePhase::Stopping => "stopping",
            LifecyclePhase::Failed => "failed",
            LifecyclePhase::RecoveryRequired => "recovery-required",
            LifecyclePhase::Unavailable => "unavailable",
        }
    }

    fn input_label(&self, input: &Self::Input) -> &'static str {
        match input {
            LifecycleInput::Command { .. } => "command",
            LifecycleInput::EffectCompleted { .. } => "effect-completed",
            LifecycleInput::EffectFailed { .. } => "effect-failed",
            LifecycleInput::PlatformObserved(_) => "platform-observed",
            LifecycleInput::Cancel { .. } => "cancel",
            LifecycleInput::TaskFailed { .. } => "task-failed",
            LifecycleInput::Shutdown => "shutdown",
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

    fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
        LifecycleInput::TaskFailed {
            correlation,
            failure,
        }
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
            if state.facts.vpn_permission != "granted" {
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
            let start_failure = if state.facts.core_availability != "available" {
                Some(LifecycleFailure::CoreUnavailable)
            } else if state.facts.core_config_state != "loaded"
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
            if !state.facts.service_foreground && state.phase == LifecyclePhase::Stopped {
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
    let Some(active) = state.active.as_ref() else {
        return Transition::Retired;
    };
    if !active.correlation.same_operation(correlation) {
        return Transition::Retired;
    }
    if active.cancellation.is_some() && action == PlatformAction::StartForegroundService {
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

    let (phase, outcome, failure) = match action {
        PlatformAction::RequestNotificationPermission => {
            (next.phase, LifecycleOperationOutcome::Completed, None)
        }
        PlatformAction::RequestVpnConsent if facts.vpn_permission == "granted" => (
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
        PlatformAction::StopForegroundService if next.platform_clean() => (
            LifecyclePhase::Stopped,
            active
                .cancellation
                .unwrap_or(LifecycleOperationOutcome::Completed),
            active.cancellation.map(|outcome| {
                if outcome == LifecycleOperationOutcome::Unknown {
                    LifecycleFailure::Timeout
                } else {
                    LifecycleFailure::Cancelled
                }
            }),
        ),
        PlatformAction::StartForegroundService | PlatformAction::StopForegroundService => (
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
    let Some(active) = state.active.as_ref() else {
        return Transition::Retired;
    };
    if active.correlation.operation_id != correlation.operation_id {
        return Transition::Retired;
    }
    let mut next = state.clone();
    if action == PlatformAction::StartForegroundService && correlation.effect_id == 1 {
        next.phase = LifecyclePhase::Stopping;
        next.failure = Some(LifecycleFailure::PlatformFailure);
        if let Some(active) = next.active.as_mut() {
            active.cancellation = Some(LifecycleOperationOutcome::Unknown);
        }
        next.advance();
        let cleanup = LifecycleEffect::spawn(
            PlatformAction::StopForegroundService,
            correlation.with_effect(2),
        );
        Transition::EffectEmitting {
            state: next,
            effects: EffectBatch::one(cleanup),
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
        let terminal = match active.command {
            LifecycleCommandKind::RequestNotificationPermission
                if facts.event == PlatformEventKind::NotificationResult =>
            {
                Some((next.phase, LifecycleOperationOutcome::Completed, None))
            }
            LifecycleCommandKind::RequestVpnConsent
                if facts.event == PlatformEventKind::ConsentResult
                    && facts.vpn_permission == "granted" =>
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
            LifecycleCommandKind::Start
                if facts.event == PlatformEventKind::StopCompleted
                    && active.cancellation.is_some()
                    && next.platform_clean() =>
            {
                let outcome = active
                    .cancellation
                    .expect("cancelled operation lost its terminal outcome");
                Some((
                    LifecyclePhase::Stopped,
                    outcome,
                    Some(if outcome == LifecycleOperationOutcome::Unknown {
                        LifecycleFailure::Timeout
                    } else {
                        LifecycleFailure::Cancelled
                    }),
                ))
            }
            LifecycleCommandKind::Stop
                if facts.event == PlatformEventKind::StopCompleted && next.platform_clean() =>
            {
                Some((
                    LifecyclePhase::Stopped,
                    LifecycleOperationOutcome::Completed,
                    None,
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
        PlatformEventKind::StopCompleted if next.platform_clean() => {
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
                && facts.vpn_permission == "required" =>
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
        .as_ref()
        .filter(|active| active.correlation.operation_id == operation_id)
    else {
        return Transition::Unchanged;
    };
    let mut next = state.clone();
    let mut effects = vec![LifecycleEffect::cancel(active.correlation.clone())];
    let consequential = matches!(
        active.command,
        LifecycleCommandKind::Start | LifecycleCommandKind::Stop
    );
    if consequential {
        next.phase = LifecyclePhase::Stopping;
        if let Some(active) = next.active.as_mut() {
            active.cancellation = Some(if timed_out {
                LifecycleOperationOutcome::Unknown
            } else {
                LifecycleOperationOutcome::Cancelled
            });
        }
        effects.push(LifecycleEffect::spawn(
            PlatformAction::StopForegroundService,
            active.correlation.with_effect(2),
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
    if state.active.is_none() && !state.facts.service_foreground {
        return Transition::Unchanged;
    }
    let mut next = state.clone();
    if state.active.is_some() {
        if let Some(next_active) = next.active.as_mut() {
            next_active.cancellation = Some(LifecycleOperationOutcome::Unknown);
        }
    }
    next.phase = if state.active.is_some() {
        LifecyclePhase::Stopping
    } else {
        LifecyclePhase::RecoveryRequired
    };
    next.failure = Some(LifecycleFailure::Cancelled);
    next.advance();
    let correlation = state.active.as_ref().map_or_else(
        || Correlation {
            machine_authority: state.authority_id.clone(),
            scope_epoch: 1,
            operation_id: "shutdown-cleanup".into(),
            admitted_revision: next.revision,
            effect_id: 1,
        },
        |active| active.correlation.with_effect(2),
    );
    let cleanup = LifecycleEffect::spawn(PlatformAction::StopForegroundService, correlation);
    let effects = if let Some(active) = state.active.as_ref() {
        EffectBatch::from_first(
            LifecycleEffect::cancel(active.correlation.clone()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MobileVpnCommandResult;

    fn facts(sequence: u64) -> PlatformFacts {
        PlatformFacts {
            activation_failure: None,
            activation_session_id: None,
            active_network: false,
            config_failure_injection_available: false,
            core_abi_version: None,
            core_availability: "available".into(),
            core_commit: None,
            core_config_state: "loaded".into(),
            core_running: false,
            core_version: None,
            core_wrapper_revision: None,
            event: PlatformEventKind::Observation,
            fact_sequence: sequence,
            loaded_config_digest: Some("a".repeat(64)),
            loaded_config_revision: Some("revision-a".into()),
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

        let mut stopped = cleaning.facts.clone();
        stopped.event = PlatformEventKind::StopCompleted;
        stopped.fact_sequence += 1;
        let terminal =
            next_state(machine.reduce(&cleaning, &LifecycleInput::PlatformObserved(stopped)));
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

        let mut stopped = cleaning.facts.clone();
        stopped.event = PlatformEventKind::StopCompleted;
        stopped.fact_sequence += 1;
        let terminal = next_state(machine.reduce(
            &cleaning,
            &LifecycleInput::EffectCompleted {
                action: PlatformAction::StopForegroundService,
                correlation: start_correlation.with_effect(2),
                facts: stopped,
            },
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
        let mut stopped_facts = stopping.facts.clone();
        stopped_facts.event = PlatformEventKind::StopCompleted;
        stopped_facts.fact_sequence = 4;
        stopped_facts.service_foreground = false;
        let stopped = next_state(machine.reduce(
            &stopping,
            &LifecycleInput::EffectCompleted {
                action: PlatformAction::StopForegroundService,
                correlation: stop_correlation,
                facts: stopped_facts,
            },
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

    #[test]
    fn evidence_labels_and_failures_never_include_platform_payloads() {
        let machine = LifecycleMachine;
        let mut secret = facts(2);
        secret.core_commit = Some("credential-user:password@example.invalid".into());
        assert_eq!(
            machine.input_label(&LifecycleInput::PlatformObserved(secret)),
            "platform-observed"
        );
        assert_eq!(
            LifecycleFailure::PlatformFailure,
            LifecycleFailure::PlatformFailure
        );
    }
}
