//! Typed lifecycle for the Internal TUN Alpha package controller.

use mish_state_machine::{
    CorrelatedEffect, Correlation, EffectBatch, Machine, TaskFailure, Transition,
};

const STAGE_EFFECT_ID: u64 = 1;
const AUTHORIZE_EFFECT_ID: u64 = 2;
const COMMIT_EFFECT_ID: u64 = 3;
const START_EFFECT_ID: u64 = 4;
const VERIFY_EFFECT_ID: u64 = 5;
const ROLLBACK_EFFECT_ID: u64 = 6;
const FINALIZE_UNINSTALL_EFFECT_ID: u64 = 7;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageOperationKind {
    Install,
    Repair,
    Uninstall,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservedPackageState {
    Absent,
    HealthyDisabled,
    RepairRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageOperation {
    pub correlation: Correlation,
    pub initial: ObservedPackageState,
    pub kind: PackageOperationKind,
}

impl PackageOperation {
    fn effect(&self, effect_id: u64) -> Correlation {
        self.correlation.with_effect(effect_id)
    }

    fn accepts(&self, correlation: &Correlation, effect_id: u64) -> bool {
        self.correlation.same_operation(correlation) && correlation.effect_id == effect_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageSuccess {
    pub generation: u64,
    pub installation_id: String,
    pub key_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageFailure {
    pub code: String,
    pub recovery_required: bool,
}

impl PackageFailure {
    pub fn clean(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            recovery_required: false,
        }
    }

    pub fn recovery_required(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            recovery_required: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PackageState {
    Absent {
        failure: Option<PackageFailure>,
    },
    Staging {
        operation: PackageOperation,
    },
    AwaitingAuthorization {
        operation: PackageOperation,
    },
    Installing {
        operation: PackageOperation,
    },
    Starting {
        operation: PackageOperation,
    },
    Verifying {
        operation: PackageOperation,
        candidate: PackageSuccess,
    },
    HealthyDisabled {
        operation: PackageOperation,
        result: PackageSuccess,
    },
    ObservedHealthyDisabled,
    RollingBack {
        operation: PackageOperation,
        failure: PackageFailure,
    },
    RepairRequired {
        operation: Option<PackageOperation>,
        failure: PackageFailure,
    },
    Uninstalling {
        operation: PackageOperation,
    },
    Retired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PackageProjection {
    InFlight { state: &'static str },
    Absent,
    HealthyDisabled(PackageSuccess),
    Failed(PackageFailure),
    Retired,
}

impl PackageState {
    pub fn initial(observed: ObservedPackageState) -> Self {
        match observed {
            ObservedPackageState::Absent => Self::Absent { failure: None },
            ObservedPackageState::HealthyDisabled => Self::ObservedHealthyDisabled,
            ObservedPackageState::RepairRequired => Self::RepairRequired {
                operation: None,
                failure: PackageFailure::recovery_required("observed-repair-required"),
            },
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Absent { .. } => "absent",
            Self::Staging { .. } => "staging",
            Self::AwaitingAuthorization { .. } => "awaiting-authorization",
            Self::Installing { .. } => "installing",
            Self::Starting { .. } => "starting",
            Self::Verifying { .. } => "verifying",
            Self::HealthyDisabled { .. } | Self::ObservedHealthyDisabled => "healthy-disabled",
            Self::RollingBack { .. } => "rolling-back",
            Self::RepairRequired { .. } => "repair-required",
            Self::Uninstalling { .. } => "uninstalling",
            Self::Retired => "retired",
        }
    }

    pub fn projection(&self) -> PackageProjection {
        match self {
            Self::Absent { failure: None } => PackageProjection::Absent,
            Self::Absent {
                failure: Some(failure),
            }
            | Self::RepairRequired { failure, .. } => PackageProjection::Failed(failure.clone()),
            Self::HealthyDisabled { result, .. } => {
                PackageProjection::HealthyDisabled(result.clone())
            }
            Self::Retired => PackageProjection::Retired,
            Self::ObservedHealthyDisabled
            | Self::Staging { .. }
            | Self::AwaitingAuthorization { .. }
            | Self::Installing { .. }
            | Self::Starting { .. }
            | Self::Verifying { .. }
            | Self::RollingBack { .. }
            | Self::Uninstalling { .. } => PackageProjection::InFlight {
                state: self.label(),
            },
        }
    }

    fn observed(&self) -> Option<ObservedPackageState> {
        match self {
            Self::Absent { .. } => Some(ObservedPackageState::Absent),
            Self::HealthyDisabled { .. } | Self::ObservedHealthyDisabled => {
                Some(ObservedPackageState::HealthyDisabled)
            }
            Self::RepairRequired { .. } => Some(ObservedPackageState::RepairRequired),
            _ => None,
        }
    }

    fn operation(&self) -> Option<&PackageOperation> {
        match self {
            Self::Staging { operation }
            | Self::AwaitingAuthorization { operation }
            | Self::Installing { operation }
            | Self::Starting { operation }
            | Self::Verifying { operation, .. }
            | Self::HealthyDisabled { operation, .. }
            | Self::RollingBack { operation, .. }
            | Self::Uninstalling { operation } => Some(operation),
            Self::RepairRequired {
                operation: Some(operation),
                ..
            } => Some(operation),
            Self::Absent { .. }
            | Self::ObservedHealthyDisabled
            | Self::RepairRequired {
                operation: None, ..
            }
            | Self::Retired => None,
        }
    }
}

#[derive(Debug)]
pub enum PackageEffect {
    Stage { correlation: Correlation },
    Authorize { correlation: Correlation },
    CommitReceipt { correlation: Correlation },
    AwaitReady { correlation: Correlation },
    Verify { correlation: Correlation },
    Rollback { correlation: Correlation },
    FinalizeUninstall { correlation: Correlation },
}

impl CorrelatedEffect for PackageEffect {
    fn correlation(&self) -> &Correlation {
        match self {
            Self::Stage { correlation }
            | Self::Authorize { correlation }
            | Self::CommitReceipt { correlation }
            | Self::AwaitReady { correlation }
            | Self::Verify { correlation }
            | Self::Rollback { correlation }
            | Self::FinalizeUninstall { correlation } => correlation,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PackageEffectOutcome {
    Staged,
    Authorized,
    ReceiptCommitted,
    Ready(PackageSuccess),
    Verified(PackageSuccess),
    RolledBack,
    UninstallFinalized,
    Failed(PackageFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PackageInput {
    Begin(PackageOperation),
    EffectCompleted {
        correlation: Correlation,
        outcome: PackageEffectOutcome,
    },
    Shutdown,
}

impl PackageInput {
    fn label(&self) -> &'static str {
        match self {
            Self::Begin(_) => "begin",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::Staged,
                ..
            } => "staged",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::Authorized,
                ..
            } => "authorized",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::ReceiptCommitted,
                ..
            } => "receipt-committed",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::Ready(_),
                ..
            } => "ready-observed",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::Verified(_),
                ..
            } => "verified",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::RolledBack,
                ..
            } => "rolled-back",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::UninstallFinalized,
                ..
            } => "uninstall-finalized",
            Self::EffectCompleted {
                outcome: PackageEffectOutcome::Failed(_),
                ..
            } => "effect-failed",
            Self::Shutdown => "shutdown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageMachineError {
    Busy,
    OperationMismatch,
}

pub struct PackageMachine;

impl Machine for PackageMachine {
    type State = PackageState;
    type Input = PackageInput;
    type Effect = PackageEffect;
    type Error = PackageMachineError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        match input {
            PackageInput::Begin(operation) => {
                if let Some(active) = state.operation()
                    && active.correlation.same_operation(&operation.correlation)
                {
                    return Transition::Unchanged;
                }
                if state
                    .observed()
                    .is_some_and(|observed| observed != operation.initial)
                {
                    return Transition::Rejected(PackageMachineError::OperationMismatch);
                }
                if matches!(
                    state,
                    PackageState::Staging { .. }
                        | PackageState::AwaitingAuthorization { .. }
                        | PackageState::Installing { .. }
                        | PackageState::Starting { .. }
                        | PackageState::Verifying { .. }
                        | PackageState::RollingBack { .. }
                        | PackageState::Uninstalling { .. }
                ) {
                    return Transition::Rejected(PackageMachineError::Busy);
                }
                Transition::EffectEmitting {
                    state: PackageState::Staging {
                        operation: operation.clone(),
                    },
                    effects: EffectBatch::one(PackageEffect::Stage {
                        correlation: operation.effect(STAGE_EFFECT_ID),
                    }),
                }
            }
            PackageInput::EffectCompleted {
                correlation,
                outcome,
            } => reduce_completion(state, correlation, outcome),
            PackageInput::Shutdown => match state.operation() {
                Some(operation)
                    if matches!(
                        state,
                        PackageState::Staging { .. }
                            | PackageState::AwaitingAuthorization { .. }
                            | PackageState::Installing { .. }
                            | PackageState::Starting { .. }
                            | PackageState::Verifying { .. }
                            | PackageState::RollingBack { .. }
                            | PackageState::Uninstalling { .. }
                    ) =>
                {
                    Transition::RecoveryRequired(PackageState::RepairRequired {
                        operation: Some(operation.clone()),
                        failure: PackageFailure::recovery_required("shutdown-during-lifecycle"),
                    })
                }
                _ => Transition::Accepted(PackageState::Retired),
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
            PackageInput::Begin(operation) => Some(operation.correlation.clone()),
            PackageInput::EffectCompleted { correlation, .. } => Some(correlation.clone()),
            PackageInput::Shutdown => state
                .operation()
                .map(|operation| operation.correlation.clone()),
        }
    }

    fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
        let (operation, effect_id) = match state {
            PackageState::Staging { operation } => (operation, STAGE_EFFECT_ID),
            PackageState::AwaitingAuthorization { operation } => (operation, AUTHORIZE_EFFECT_ID),
            PackageState::Installing { operation } => (operation, COMMIT_EFFECT_ID),
            PackageState::Starting { operation } => (operation, START_EFFECT_ID),
            PackageState::Verifying { operation, .. } => (operation, VERIFY_EFFECT_ID),
            PackageState::RollingBack { operation, .. } => (operation, ROLLBACK_EFFECT_ID),
            PackageState::Uninstalling { operation } => (operation, FINALIZE_UNINSTALL_EFFECT_ID),
            _ => return false,
        };
        operation.accepts(correlation, effect_id)
    }

    fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
        let code = match failure {
            TaskFailure::Aborted => "effect-aborted",
            TaskFailure::CompletionConflict => "effect-completion-conflict",
            TaskFailure::Panicked => "effect-panicked",
        };
        PackageInput::EffectCompleted {
            correlation,
            outcome: PackageEffectOutcome::Failed(PackageFailure::recovery_required(code)),
        }
    }

    fn shutdown(&self) -> Self::Input {
        PackageInput::Shutdown
    }

    fn unavailable(&self) -> Self::Error {
        PackageMachineError::Busy
    }
}

fn reduce_completion(
    state: &PackageState,
    correlation: &Correlation,
    outcome: &PackageEffectOutcome,
) -> Transition<PackageState, PackageEffect, PackageMachineError> {
    let Some(operation) = state.operation() else {
        return Transition::Retired;
    };
    let expected = match state {
        PackageState::Staging { .. } => STAGE_EFFECT_ID,
        PackageState::AwaitingAuthorization { .. } => AUTHORIZE_EFFECT_ID,
        PackageState::Installing { .. } => COMMIT_EFFECT_ID,
        PackageState::Starting { .. } => START_EFFECT_ID,
        PackageState::Verifying { .. } => VERIFY_EFFECT_ID,
        PackageState::RollingBack { .. } => ROLLBACK_EFFECT_ID,
        PackageState::Uninstalling { .. } => FINALIZE_UNINSTALL_EFFECT_ID,
        _ => return Transition::Retired,
    };
    if !operation.accepts(correlation, expected) {
        return Transition::Retired;
    }
    if let PackageEffectOutcome::Failed(failure) = outcome {
        return failure_transition(operation, state, failure.clone());
    }
    match (state, outcome) {
        (PackageState::Staging { .. }, PackageEffectOutcome::Staged) => {
            Transition::EffectEmitting {
                state: PackageState::AwaitingAuthorization {
                    operation: operation.clone(),
                },
                effects: EffectBatch::one(PackageEffect::Authorize {
                    correlation: operation.effect(AUTHORIZE_EFFECT_ID),
                }),
            }
        }
        (PackageState::AwaitingAuthorization { .. }, PackageEffectOutcome::Authorized)
            if operation.kind == PackageOperationKind::Uninstall =>
        {
            Transition::EffectEmitting {
                state: PackageState::Uninstalling {
                    operation: operation.clone(),
                },
                effects: EffectBatch::one(PackageEffect::FinalizeUninstall {
                    correlation: operation.effect(FINALIZE_UNINSTALL_EFFECT_ID),
                }),
            }
        }
        (PackageState::AwaitingAuthorization { .. }, PackageEffectOutcome::Authorized) => {
            Transition::EffectEmitting {
                state: PackageState::Installing {
                    operation: operation.clone(),
                },
                effects: EffectBatch::one(PackageEffect::CommitReceipt {
                    correlation: operation.effect(COMMIT_EFFECT_ID),
                }),
            }
        }
        (PackageState::Installing { .. }, PackageEffectOutcome::ReceiptCommitted) => {
            Transition::EffectEmitting {
                state: PackageState::Starting {
                    operation: operation.clone(),
                },
                effects: EffectBatch::one(PackageEffect::AwaitReady {
                    correlation: operation.effect(START_EFFECT_ID),
                }),
            }
        }
        (PackageState::Starting { .. }, PackageEffectOutcome::Ready(candidate)) => {
            Transition::EffectEmitting {
                state: PackageState::Verifying {
                    operation: operation.clone(),
                    candidate: candidate.clone(),
                },
                effects: EffectBatch::one(PackageEffect::Verify {
                    correlation: operation.effect(VERIFY_EFFECT_ID),
                }),
            }
        }
        (PackageState::Verifying { .. }, PackageEffectOutcome::Verified(result)) => {
            Transition::Committed(PackageState::HealthyDisabled {
                operation: operation.clone(),
                result: result.clone(),
            })
        }
        (PackageState::RollingBack { failure, .. }, PackageEffectOutcome::RolledBack) => {
            if operation.initial == ObservedPackageState::Absent {
                Transition::Failed(PackageState::Absent {
                    failure: Some(failure.clone()),
                })
            } else {
                Transition::RecoveryRequired(PackageState::RepairRequired {
                    operation: Some(operation.clone()),
                    failure: failure.clone(),
                })
            }
        }
        (PackageState::Uninstalling { .. }, PackageEffectOutcome::UninstallFinalized) => {
            Transition::Committed(PackageState::Absent { failure: None })
        }
        _ => Transition::Retired,
    }
}

fn failure_transition(
    operation: &PackageOperation,
    state: &PackageState,
    failure: PackageFailure,
) -> Transition<PackageState, PackageEffect, PackageMachineError> {
    if failure.recovery_required {
        return Transition::RecoveryRequired(PackageState::RepairRequired {
            operation: Some(operation.clone()),
            failure,
        });
    }
    if matches!(
        state,
        PackageState::Installing { .. }
            | PackageState::Starting { .. }
            | PackageState::Verifying { .. }
    ) {
        return Transition::EffectEmitting {
            state: PackageState::RollingBack {
                operation: operation.clone(),
                failure,
            },
            effects: EffectBatch::one(PackageEffect::Rollback {
                correlation: operation.effect(ROLLBACK_EFFECT_ID),
            }),
        };
    }
    let terminal = if operation.initial == ObservedPackageState::Absent {
        PackageState::Absent {
            failure: Some(failure),
        }
    } else {
        PackageState::RepairRequired {
            operation: Some(operation.clone()),
            failure,
        }
    };
    Transition::Failed(terminal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(kind: PackageOperationKind) -> PackageOperation {
        PackageOperation {
            correlation: Correlation {
                machine_authority: "package-authority".into(),
                scope_epoch: 1,
                operation_id: "operation-a".into(),
                admitted_revision: 1,
                effect_id: 0,
            },
            initial: ObservedPackageState::Absent,
            kind,
        }
    }

    #[test]
    fn install_transition_table_requires_observed_health_before_commit() {
        let machine = PackageMachine;
        let operation = operation(PackageOperationKind::Install);
        let mut state = PackageState::initial(ObservedPackageState::Absent);
        let steps = [
            PackageEffectOutcome::Staged,
            PackageEffectOutcome::Authorized,
            PackageEffectOutcome::ReceiptCommitted,
            PackageEffectOutcome::Ready(PackageSuccess {
                generation: 1,
                installation_id: "installation".into(),
                key_id: "key".into(),
            }),
            PackageEffectOutcome::Verified(PackageSuccess {
                generation: 1,
                installation_id: "installation".into(),
                key_id: "key".into(),
            }),
        ];
        let Transition::EffectEmitting { state: next, .. } =
            machine.reduce(&state, &PackageInput::Begin(operation.clone()))
        else {
            panic!("install must stage");
        };
        state = next;
        for (index, outcome) in steps.into_iter().enumerate() {
            let correlation = operation.effect((index + 1) as u64);
            let transition = machine.reduce(
                &state,
                &PackageInput::EffectCompleted {
                    correlation,
                    outcome,
                },
            );
            state = match transition {
                Transition::EffectEmitting { state, .. } | Transition::Committed(state) => state,
                other => panic!("unexpected transition: {other:?}"),
            };
        }
        assert!(matches!(state, PackageState::HealthyDisabled { .. }));
    }

    #[test]
    fn stale_duplicate_replacement_and_failure_recovery_are_explicit() {
        let machine = PackageMachine;
        let operation = operation(PackageOperationKind::Install);
        let initial = PackageState::initial(ObservedPackageState::Absent);
        let Transition::EffectEmitting { state, .. } =
            machine.reduce(&initial, &PackageInput::Begin(operation.clone()))
        else {
            panic!("install must stage");
        };
        assert!(matches!(
            machine.reduce(&state, &PackageInput::Begin(operation.clone())),
            Transition::Unchanged
        ));
        let mut replacement = operation.clone();
        replacement.correlation.operation_id = "operation-b".into();
        assert!(matches!(
            machine.reduce(&state, &PackageInput::Begin(replacement)),
            Transition::Rejected(PackageMachineError::Busy)
        ));
        let mut stale = operation.effect(STAGE_EFFECT_ID);
        stale.scope_epoch += 1;
        assert!(matches!(
            machine.reduce(
                &state,
                &PackageInput::EffectCompleted {
                    correlation: stale,
                    outcome: PackageEffectOutcome::Staged,
                }
            ),
            Transition::Retired
        ));
        let failure = PackageFailure::recovery_required("cleanup-unconfirmed");
        assert!(matches!(
            machine.reduce(
                &state,
                &PackageInput::EffectCompleted {
                    correlation: operation.effect(STAGE_EFFECT_ID),
                    outcome: PackageEffectOutcome::Failed(failure),
                }
            ),
            Transition::RecoveryRequired(PackageState::RepairRequired { .. })
        ));
    }

    #[test]
    fn repair_rollback_and_uninstall_require_correlated_completion() {
        let machine = PackageMachine;
        let mut repair = operation(PackageOperationKind::Repair);
        repair.initial = ObservedPackageState::RepairRequired;
        let initial = PackageState::initial(ObservedPackageState::RepairRequired);
        let Transition::EffectEmitting { state, .. } =
            machine.reduce(&initial, &PackageInput::Begin(repair.clone()))
        else {
            panic!("repair must start from an observed repair-required state");
        };
        assert_eq!(state.label(), "staging");

        let mut wrong_initial = repair.clone();
        wrong_initial.correlation.operation_id = "operation-b".into();
        wrong_initial.initial = ObservedPackageState::HealthyDisabled;
        assert!(matches!(
            machine.reduce(&initial, &PackageInput::Begin(wrong_initial)),
            Transition::Rejected(PackageMachineError::OperationMismatch)
        ));

        let install = operation(PackageOperationKind::Install);
        let initial = PackageState::initial(ObservedPackageState::Absent);
        let Transition::EffectEmitting { state, .. } =
            machine.reduce(&initial, &PackageInput::Begin(install.clone()))
        else {
            panic!("install must stage");
        };
        let Transition::EffectEmitting { state, .. } = machine.reduce(
            &state,
            &PackageInput::EffectCompleted {
                correlation: install.effect(STAGE_EFFECT_ID),
                outcome: PackageEffectOutcome::Staged,
            },
        ) else {
            panic!("install must await authorization");
        };
        let Transition::EffectEmitting { state, .. } = machine.reduce(
            &state,
            &PackageInput::EffectCompleted {
                correlation: install.effect(AUTHORIZE_EFFECT_ID),
                outcome: PackageEffectOutcome::Authorized,
            },
        ) else {
            panic!("install must enter receipt commit");
        };
        let Transition::EffectEmitting { state, .. } = machine.reduce(
            &state,
            &PackageInput::EffectCompleted {
                correlation: install.effect(COMMIT_EFFECT_ID),
                outcome: PackageEffectOutcome::Failed(PackageFailure::clean("receipt-failed")),
            },
        ) else {
            panic!("post-mutation failure must enter rollback");
        };
        assert_eq!(state.label(), "rolling-back");
        assert!(matches!(
            machine.reduce(
                &state,
                &PackageInput::EffectCompleted {
                    correlation: install.effect(ROLLBACK_EFFECT_ID),
                    outcome: PackageEffectOutcome::RolledBack,
                },
            ),
            Transition::Failed(PackageState::Absent { failure: Some(_) })
        ));

        let mut uninstall = operation(PackageOperationKind::Uninstall);
        uninstall.initial = ObservedPackageState::HealthyDisabled;
        let initial = PackageState::initial(ObservedPackageState::HealthyDisabled);
        let Transition::EffectEmitting { state, .. } =
            machine.reduce(&initial, &PackageInput::Begin(uninstall.clone()))
        else {
            panic!("uninstall must stage");
        };
        let Transition::EffectEmitting { state, .. } = machine.reduce(
            &state,
            &PackageInput::EffectCompleted {
                correlation: uninstall.effect(STAGE_EFFECT_ID),
                outcome: PackageEffectOutcome::Staged,
            },
        ) else {
            panic!("uninstall must await authorization");
        };
        let Transition::EffectEmitting { state, .. } = machine.reduce(
            &state,
            &PackageInput::EffectCompleted {
                correlation: uninstall.effect(AUTHORIZE_EFFECT_ID),
                outcome: PackageEffectOutcome::Authorized,
            },
        ) else {
            panic!("authorized uninstall must enter finalization");
        };
        assert_eq!(state.label(), "uninstalling");
        let Transition::Committed(absent) = machine.reduce(
            &state,
            &PackageInput::EffectCompleted {
                correlation: uninstall.effect(FINALIZE_UNINSTALL_EFFECT_ID),
                outcome: PackageEffectOutcome::UninstallFinalized,
            },
        ) else {
            panic!("uninstall commits only after final observation");
        };
        assert_eq!(absent.projection(), PackageProjection::Absent);
    }
}
