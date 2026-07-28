use mish_state_machine::{
    CorrelatedEffect, Correlation, EffectBatch, Machine, TaskFailure, Transition,
};

use super::{ServiceCommand, ServiceDiagnosticCode, ServiceResponse, unknown_tun_observation};

const EXECUTE_EFFECT_ID: u64 = 1;
const VERIFY_EFFECT_ID: u64 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ObservedLifecycle {
    Disabled { core_running: bool },
    Enabled,
    RecoveryRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DesiredLifecycle {
    Disabled,
    PreparedDisabled,
    Enabled,
    Current,
    StopObserved,
}

impl DesiredLifecycle {
    pub(super) fn accepts(self, observed: ObservedLifecycle) -> bool {
        match self {
            Self::Disabled => {
                observed
                    == ObservedLifecycle::Disabled {
                        core_running: false,
                    }
            }
            Self::PreparedDisabled => {
                matches!(
                    observed,
                    ObservedLifecycle::Disabled { core_running: true } | ObservedLifecycle::Enabled
                )
            }
            Self::Enabled => observed == ObservedLifecycle::Enabled,
            Self::Current => observed != ObservedLifecycle::RecoveryRequired,
            Self::StopObserved => true,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct LifecycleOperation {
    pub correlation: Correlation,
    pub command: ServiceCommand,
    pub peer_pid: u32,
    pub request_id: String,
}

impl LifecycleOperation {
    fn effect(&self, effect_id: u64) -> Correlation {
        self.correlation.with_effect(effect_id)
    }

    fn desired(&self) -> DesiredLifecycle {
        match self.command {
            ServiceCommand::Start { .. } => DesiredLifecycle::PreparedDisabled,
            ServiceCommand::Enable => DesiredLifecycle::Enabled,
            ServiceCommand::Stop { .. } => DesiredLifecycle::StopObserved,
            ServiceCommand::Disable | ServiceCommand::StopAll => DesiredLifecycle::Disabled,
            ServiceCommand::Health
            | ServiceCommand::Status
            | ServiceCommand::Observe { .. }
            | ServiceCommand::OwnsListener { .. } => DesiredLifecycle::Current,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct LifecycleTerminal {
    pub operation: LifecycleOperation,
    pub response: ServiceResponse,
}

pub(super) type TunLifecycleProjection = ServiceResponse;

#[derive(Clone, Debug)]
pub(super) enum TunLifecycleState {
    Disabled {
        core_running: bool,
        terminal: Option<LifecycleTerminal>,
    },
    Starting {
        operation: LifecycleOperation,
    },
    Applying {
        operation: LifecycleOperation,
    },
    Verifying {
        operation: LifecycleOperation,
        preliminary: ServiceResponse,
    },
    Observing {
        operation: LifecycleOperation,
    },
    Enabled {
        terminal: Option<LifecycleTerminal>,
    },
    Restoring {
        operation: LifecycleOperation,
    },
    RecoveryRequired {
        terminal: Option<LifecycleTerminal>,
    },
    Retired,
}

impl TunLifecycleState {
    pub(super) fn initial(recovery_required: bool) -> Self {
        if recovery_required {
            Self::RecoveryRequired { terminal: None }
        } else {
            Self::Disabled {
                core_running: false,
                terminal: None,
            }
        }
    }

    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Disabled { .. } => "disabled",
            Self::Starting { .. } => "starting",
            Self::Applying { .. } => "applying",
            Self::Verifying { .. } | Self::Observing { .. } => "verifying",
            Self::Enabled { .. } => "enabled",
            Self::Restoring { .. } => "restoring",
            Self::RecoveryRequired { .. } => "recovery-required",
            Self::Retired => "retired",
        }
    }

    pub(super) fn terminal(&self, operation_id: &str) -> Option<TunLifecycleProjection> {
        let terminal = match self {
            Self::Disabled {
                terminal: Some(terminal),
                ..
            }
            | Self::Enabled {
                terminal: Some(terminal),
            }
            | Self::RecoveryRequired {
                terminal: Some(terminal),
            } => terminal,
            _ => return None,
        };
        (terminal.operation.correlation.operation_id == operation_id)
            .then(|| terminal.response.clone())
    }

    fn active(&self) -> Option<&LifecycleOperation> {
        match self {
            Self::Starting { operation }
            | Self::Applying { operation }
            | Self::Verifying { operation, .. }
            | Self::Observing { operation }
            | Self::Restoring { operation } => Some(operation),
            _ => None,
        }
    }

    fn terminal_operation(&self) -> Option<&LifecycleOperation> {
        match self {
            Self::Disabled {
                terminal: Some(terminal),
                ..
            }
            | Self::Enabled {
                terminal: Some(terminal),
            }
            | Self::RecoveryRequired {
                terminal: Some(terminal),
            } => Some(&terminal.operation),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub(super) enum TunLifecycleEffect {
    Execute {
        correlation: Correlation,
        command: ServiceCommand,
        peer_pid: u32,
        request_id: String,
    },
    Verify {
        correlation: Correlation,
        desired: DesiredLifecycle,
        observed: ObservedLifecycle,
        response: ServiceResponse,
    },
}

impl CorrelatedEffect for TunLifecycleEffect {
    fn correlation(&self) -> &Correlation {
        match self {
            Self::Execute { correlation, .. } | Self::Verify { correlation, .. } => correlation,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) enum TunLifecycleOutcome {
    Executed {
        observed: ObservedLifecycle,
        response: ServiceResponse,
    },
    Verified {
        desired: DesiredLifecycle,
        observed: ObservedLifecycle,
        response: ServiceResponse,
    },
    Failed {
        response: ServiceResponse,
    },
}

#[derive(Clone, Debug)]
pub(super) enum TunLifecycleInput {
    Command(LifecycleOperation),
    EffectCompleted {
        correlation: Correlation,
        outcome: TunLifecycleOutcome,
    },
    Acknowledge {
        operation_id: String,
    },
    Shutdown,
}

impl TunLifecycleInput {
    fn label(&self) -> &'static str {
        match self {
            Self::Command(_) => "command",
            Self::EffectCompleted {
                outcome: TunLifecycleOutcome::Executed { .. },
                ..
            } => "operation-executed",
            Self::EffectCompleted {
                outcome: TunLifecycleOutcome::Verified { .. },
                ..
            } => "observation-verified",
            Self::EffectCompleted {
                outcome: TunLifecycleOutcome::Failed { .. },
                ..
            } => "effect-failed",
            Self::Acknowledge { .. } => "acknowledge",
            Self::Shutdown => "shutdown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TunLifecycleError {
    Busy,
}

pub(super) struct TunLifecycleMachine;

impl Machine for TunLifecycleMachine {
    type State = TunLifecycleState;
    type Input = TunLifecycleInput;
    type Effect = TunLifecycleEffect;
    type Error = TunLifecycleError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        match input {
            TunLifecycleInput::Command(operation) => {
                if state
                    .active()
                    .or_else(|| state.terminal_operation())
                    .is_some_and(|current| {
                        current.correlation.same_operation(&operation.correlation)
                    })
                {
                    return Transition::Unchanged;
                }
                if state.active().is_some() || state.terminal_operation().is_some() {
                    return Transition::Rejected(TunLifecycleError::Busy);
                }
                let next = match operation.command {
                    ServiceCommand::Start { .. } => TunLifecycleState::Starting {
                        operation: operation.clone(),
                    },
                    ServiceCommand::Enable => TunLifecycleState::Applying {
                        operation: operation.clone(),
                    },
                    ServiceCommand::Stop { .. }
                    | ServiceCommand::Disable
                    | ServiceCommand::StopAll => TunLifecycleState::Restoring {
                        operation: operation.clone(),
                    },
                    ServiceCommand::Health
                    | ServiceCommand::Status
                    | ServiceCommand::Observe { .. }
                    | ServiceCommand::OwnsListener { .. } => TunLifecycleState::Observing {
                        operation: operation.clone(),
                    },
                };
                Transition::EffectEmitting {
                    state: next,
                    effects: EffectBatch::one(TunLifecycleEffect::Execute {
                        correlation: operation.effect(EXECUTE_EFFECT_ID),
                        command: operation.command.clone(),
                        peer_pid: operation.peer_pid,
                        request_id: operation.request_id.clone(),
                    }),
                }
            }
            TunLifecycleInput::EffectCompleted {
                correlation,
                outcome,
            } => reduce_completion(state, correlation, outcome),
            TunLifecycleInput::Acknowledge { operation_id } => acknowledge(state, operation_id),
            TunLifecycleInput::Shutdown => {
                if state.active().is_some() {
                    Transition::RecoveryRequired(TunLifecycleState::RecoveryRequired {
                        terminal: None,
                    })
                } else {
                    Transition::Accepted(TunLifecycleState::Retired)
                }
            }
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
            TunLifecycleInput::Command(operation) => Some(operation.correlation.clone()),
            TunLifecycleInput::EffectCompleted { correlation, .. } => Some(correlation.clone()),
            TunLifecycleInput::Acknowledge { .. } | TunLifecycleInput::Shutdown => state
                .active()
                .map(|operation| operation.correlation.clone()),
        }
    }

    fn task_failed(&self, correlation: Correlation, _failure: TaskFailure) -> Self::Input {
        TunLifecycleInput::EffectCompleted {
            correlation,
            outcome: TunLifecycleOutcome::Failed {
                response: ServiceResponse::error(
                    ServiceDiagnosticCode::StopFailed,
                    None,
                    unknown_tun_observation(),
                    "",
                ),
            },
        }
    }

    fn shutdown(&self) -> Self::Input {
        TunLifecycleInput::Shutdown
    }

    fn unavailable(&self) -> Self::Error {
        TunLifecycleError::Busy
    }
}

fn reduce_completion(
    state: &TunLifecycleState,
    correlation: &Correlation,
    outcome: &TunLifecycleOutcome,
) -> Transition<TunLifecycleState, TunLifecycleEffect, TunLifecycleError> {
    let Some(operation) = state.active() else {
        return Transition::Retired;
    };
    let expected_effect = if matches!(state, TunLifecycleState::Verifying { .. }) {
        VERIFY_EFFECT_ID
    } else {
        EXECUTE_EFFECT_ID
    };
    if !operation.correlation.same_operation(correlation)
        || correlation.effect_id != expected_effect
    {
        return Transition::Retired;
    }
    match outcome {
        TunLifecycleOutcome::Failed { response } => terminal_transition(
            operation,
            response.clone(),
            ObservedLifecycle::RecoveryRequired,
        ),
        TunLifecycleOutcome::Executed { observed, response } => {
            let is_read_only = matches!(
                operation.command,
                ServiceCommand::Status
                    | ServiceCommand::Observe { .. }
                    | ServiceCommand::OwnsListener { .. }
            );
            if !response.ok || is_read_only {
                return terminal_transition(operation, response.clone(), *observed);
            }
            Transition::EffectEmitting {
                state: TunLifecycleState::Verifying {
                    operation: operation.clone(),
                    preliminary: response.clone(),
                },
                effects: EffectBatch::one(TunLifecycleEffect::Verify {
                    correlation: operation.effect(VERIFY_EFFECT_ID),
                    desired: operation.desired(),
                    observed: *observed,
                    response: response.clone(),
                }),
            }
        }
        TunLifecycleOutcome::Verified {
            desired,
            observed,
            response,
        } => {
            let response = match state {
                TunLifecycleState::Verifying { preliminary, .. } if response.ok => {
                    preliminary.clone()
                }
                _ => response.clone(),
            };
            let observed = if desired.accepts(*observed) {
                *observed
            } else {
                ObservedLifecycle::RecoveryRequired
            };
            terminal_transition(operation, response, observed)
        }
    }
}

fn terminal_transition(
    operation: &LifecycleOperation,
    response: ServiceResponse,
    observed: ObservedLifecycle,
) -> Transition<TunLifecycleState, TunLifecycleEffect, TunLifecycleError> {
    let failed = !response.ok;
    let terminal = Some(LifecycleTerminal {
        operation: operation.clone(),
        response,
    });
    match observed {
        ObservedLifecycle::Disabled { core_running } => {
            let state = TunLifecycleState::Disabled {
                core_running,
                terminal,
            };
            if failed {
                Transition::Failed(state)
            } else {
                Transition::Committed(state)
            }
        }
        ObservedLifecycle::Enabled => {
            let state = TunLifecycleState::Enabled { terminal };
            if failed {
                Transition::Failed(state)
            } else {
                Transition::Committed(state)
            }
        }
        ObservedLifecycle::RecoveryRequired => {
            Transition::RecoveryRequired(TunLifecycleState::RecoveryRequired { terminal })
        }
    }
}

fn acknowledge(
    state: &TunLifecycleState,
    operation_id: &str,
) -> Transition<TunLifecycleState, TunLifecycleEffect, TunLifecycleError> {
    let matches =
        |terminal: &LifecycleTerminal| terminal.operation.correlation.operation_id == operation_id;
    match state {
        TunLifecycleState::Disabled {
            core_running,
            terminal: Some(terminal),
        } if matches(terminal) => Transition::Accepted(TunLifecycleState::Disabled {
            core_running: *core_running,
            terminal: None,
        }),
        TunLifecycleState::Enabled {
            terminal: Some(terminal),
        } if matches(terminal) => {
            Transition::Accepted(TunLifecycleState::Enabled { terminal: None })
        }
        TunLifecycleState::RecoveryRequired {
            terminal: Some(terminal),
        } if matches(terminal) => {
            Transition::Accepted(TunLifecycleState::RecoveryRequired { terminal: None })
        }
        _ => Transition::Retired,
    }
}

#[cfg(test)]
mod tests {
    use mish_state_machine::Disposition;

    use super::*;

    fn operation(command: ServiceCommand) -> LifecycleOperation {
        LifecycleOperation {
            correlation: Correlation {
                machine_authority: "helper-authority".into(),
                scope_epoch: 3,
                operation_id: "operation-a".into(),
                admitted_revision: 5,
                effect_id: 0,
            },
            command,
            peer_pid: 42,
            request_id: "request-a".into(),
        }
    }

    fn response(ok: bool) -> ServiceResponse {
        let mut response = ServiceResponse::ok(None, unknown_tun_observation(), "installation");
        response.ok = ok;
        response
    }

    #[test]
    fn start_apply_verify_restore_table_never_commits_from_desire_alone() {
        let machine = TunLifecycleMachine;
        let start = operation(ServiceCommand::Start {
            binary: "/fixed/core".into(),
            config_directory: "/fixed/home".into(),
            config_file: "/fixed/config".into(),
            expected_version: "v1.0.0".into(),
            launch_token: "launch-token".into(),
        });
        let initial = TunLifecycleState::initial(false);
        let Transition::EffectEmitting {
            state: starting, ..
        } = machine.reduce(&initial, &TunLifecycleInput::Command(start.clone()))
        else {
            panic!("start must emit an owned effect");
        };
        assert_eq!(starting.label(), "starting");
        assert!(starting.terminal("operation-a").is_none());
        let Transition::EffectEmitting {
            state: verifying, ..
        } = machine.reduce(
            &starting,
            &TunLifecycleInput::EffectCompleted {
                correlation: start.effect(EXECUTE_EFFECT_ID),
                outcome: TunLifecycleOutcome::Executed {
                    observed: ObservedLifecycle::Disabled { core_running: true },
                    response: response(true),
                },
            },
        )
        else {
            panic!("start completion must be re-observed");
        };
        assert_eq!(verifying.label(), "verifying");
        let Transition::Committed(enabled) = machine.reduce(
            &verifying,
            &TunLifecycleInput::EffectCompleted {
                correlation: start.effect(VERIFY_EFFECT_ID),
                outcome: TunLifecycleOutcome::Verified {
                    desired: DesiredLifecycle::PreparedDisabled,
                    observed: ObservedLifecycle::Enabled,
                    response: response(true),
                },
            },
        ) else {
            panic!("verified enabled observation must commit");
        };
        assert_eq!(enabled.label(), "enabled");
        assert!(enabled.terminal("operation-a").is_some());

        let Transition::Accepted(enabled) = acknowledge(&enabled, "operation-a") else {
            panic!("matching terminal acknowledgement must clear the barrier");
        };
        let restore = operation(ServiceCommand::Disable);
        let Transition::EffectEmitting {
            state: restoring, ..
        } = machine.reduce(&enabled, &TunLifecycleInput::Command(restore))
        else {
            panic!("disable must enter restoring");
        };
        assert_eq!(restoring.label(), "restoring");
    }

    #[test]
    fn stale_duplicate_replacement_and_failure_recovery_are_deterministic() {
        let machine = TunLifecycleMachine;
        let operation = operation(ServiceCommand::Enable);
        let initial = TunLifecycleState::initial(false);
        let Transition::EffectEmitting {
            state: applying, ..
        } = machine.reduce(&initial, &TunLifecycleInput::Command(operation.clone()))
        else {
            panic!("enable must apply");
        };
        assert_eq!(applying.label(), "applying");
        assert!(matches!(
            machine.reduce(&applying, &TunLifecycleInput::Command(operation.clone())),
            Transition::Unchanged
        ));
        let mut replacement = operation.clone();
        replacement.correlation.operation_id = "operation-b".into();
        assert!(matches!(
            machine.reduce(&applying, &TunLifecycleInput::Command(replacement)),
            Transition::Rejected(TunLifecycleError::Busy)
        ));
        let mut stale = operation.effect(EXECUTE_EFFECT_ID);
        stale.scope_epoch += 1;
        assert!(matches!(
            machine.reduce(
                &applying,
                &TunLifecycleInput::EffectCompleted {
                    correlation: stale,
                    outcome: TunLifecycleOutcome::Executed {
                        observed: ObservedLifecycle::Enabled,
                        response: response(true),
                    },
                }
            ),
            Transition::Retired
        ));
        let transition = machine.reduce(
            &applying,
            &TunLifecycleInput::EffectCompleted {
                correlation: operation.effect(EXECUTE_EFFECT_ID),
                outcome: TunLifecycleOutcome::Failed {
                    response: response(false),
                },
            },
        );
        assert_eq!(transition.disposition(), Disposition::RecoveryRequired);
        assert!(matches!(
            transition,
            Transition::RecoveryRequired(TunLifecycleState::RecoveryRequired { .. })
        ));
    }

    #[test]
    fn apply_and_restore_commit_only_after_verified_observation() {
        let machine = TunLifecycleMachine;
        let enable = operation(ServiceCommand::Enable);
        let initial = TunLifecycleState::initial(false);
        let Transition::EffectEmitting {
            state: applying, ..
        } = machine.reduce(&initial, &TunLifecycleInput::Command(enable.clone()))
        else {
            panic!("enable must enter applying");
        };
        let Transition::EffectEmitting {
            state: verifying, ..
        } = machine.reduce(
            &applying,
            &TunLifecycleInput::EffectCompleted {
                correlation: enable.effect(EXECUTE_EFFECT_ID),
                outcome: TunLifecycleOutcome::Executed {
                    observed: ObservedLifecycle::Enabled,
                    response: response(true),
                },
            },
        )
        else {
            panic!("apply result must be verified");
        };
        let Transition::Committed(enabled) = machine.reduce(
            &verifying,
            &TunLifecycleInput::EffectCompleted {
                correlation: enable.effect(VERIFY_EFFECT_ID),
                outcome: TunLifecycleOutcome::Verified {
                    desired: DesiredLifecycle::Enabled,
                    observed: ObservedLifecycle::Enabled,
                    response: response(true),
                },
            },
        ) else {
            panic!("verified enabled observation must commit");
        };
        let Transition::Accepted(enabled) = acknowledge(&enabled, "operation-a") else {
            panic!("terminal response must be acknowledged");
        };

        let mut disable = operation(ServiceCommand::Disable);
        disable.correlation.operation_id = "operation-b".into();
        let Transition::EffectEmitting {
            state: restoring, ..
        } = machine.reduce(&enabled, &TunLifecycleInput::Command(disable.clone()))
        else {
            panic!("disable must enter restoring");
        };
        let observed = ObservedLifecycle::Disabled {
            core_running: false,
        };
        let Transition::EffectEmitting {
            state: verifying, ..
        } = machine.reduce(
            &restoring,
            &TunLifecycleInput::EffectCompleted {
                correlation: disable.effect(EXECUTE_EFFECT_ID),
                outcome: TunLifecycleOutcome::Executed {
                    observed,
                    response: response(true),
                },
            },
        )
        else {
            panic!("restore result must be verified");
        };
        assert!(matches!(
            machine.reduce(
                &verifying,
                &TunLifecycleInput::EffectCompleted {
                    correlation: disable.effect(VERIFY_EFFECT_ID),
                    outcome: TunLifecycleOutcome::Verified {
                        desired: DesiredLifecycle::Disabled,
                        observed,
                        response: response(true),
                    },
                },
            ),
            Transition::Committed(TunLifecycleState::Disabled {
                core_running: false,
                ..
            })
        ));
    }
}
