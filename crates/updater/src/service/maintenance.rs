use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use mish_state_machine::{CorrelatedEffect, Correlation, Machine, TaskFailure, Transition};

use crate::parse_version;

const JOURNAL_SCHEMA_VERSION: u8 = 1;
const JOURNAL_FILE: &str = "journal.json";
const JOURNAL_MAX_BYTES: u64 = 4 * 1024;
const EVIDENCE_LIMIT: usize = 64;
const MAINTENANCE_REVISION_HEADROOM: u64 = 4;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdaterCaptureIntent {
    None,
    RestorePriorCapture,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdaterMaintenanceReconciliation {
    None,
    PreInstallAborted,
    UnknownOutcome,
    ExpectedVersion,
    OldVersion,
    UnexpectedVersion,
    Corrupt,
    Incompatible,
    TerminalCleared,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdaterMaintenanceSnapshot {
    pub reconciliation: UpdaterMaintenanceReconciliation,
    pub capture_intent: Option<UpdaterCaptureIntent>,
    pub expected_version: Option<String>,
    pub observed_version: String,
    pub automatic_activation_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterMaintenanceTransitionEvidence {
    pub sequence: u64,
    pub admitted_revision: Option<u64>,
    pub operation_id_sha256: Option<String>,
    pub from: String,
    pub input: String,
    pub to: String,
    pub disposition: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdaterCaptureOwnershipEvidence {
    pub authority_sha256: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdaterMaintenanceRequest {
    pub operation_id: String,
    pub admitted_revision: u64,
    pub current_version: String,
    pub expected_version: String,
    pub capture_intent: UpdaterCaptureIntent,
    pub capture_ownership: Option<UpdaterCaptureOwnershipEvidence>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdaterMaintenanceError {
    Busy,
    InvalidCaptureOwnership,
    InvalidOperationKey,
    InvalidVersion,
    JournalIo,
    JournalUnsafe,
    OperationMismatch,
    RevisionExhausted,
    StaleRevision,
    TooLateToCancel,
}

impl UpdaterMaintenanceError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::InvalidCaptureOwnership => "invalid-capture-ownership",
            Self::InvalidOperationKey => "invalid-operation-key",
            Self::InvalidVersion => "invalid-version",
            Self::JournalIo => "journal-io",
            Self::JournalUnsafe => "journal-unsafe",
            Self::OperationMismatch => "operation-mismatch",
            Self::RevisionExhausted => "revision-exhausted",
            Self::StaleRevision => "stale-revision",
            Self::TooLateToCancel => "too-late-to-cancel",
        }
    }
}

impl std::fmt::Display for UpdaterMaintenanceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for UpdaterMaintenanceError {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum MaintenanceJournalPhase {
    PreparingMaintenance,
    InstallingIntent,
    Relaunching,
    Recovering,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MaintenanceMachineState {
    Idle,
    Journal(MaintenanceJournalPhase),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MaintenanceMachineInput {
    Begin,
    InstallingIntent,
    Relaunching,
    Cancel,
    RuntimeRetired,
    Startup,
    Complete,
    Fail,
}

#[derive(Clone, Debug)]
enum MaintenanceMachineEffect {}

impl CorrelatedEffect for MaintenanceMachineEffect {
    fn correlation(&self) -> &Correlation {
        match *self {}
    }
}

struct MaintenanceMachine;

impl Machine for MaintenanceMachine {
    type State = MaintenanceMachineState;
    type Input = MaintenanceMachineInput;
    type Effect = MaintenanceMachineEffect;
    type Error = UpdaterMaintenanceError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        use MaintenanceJournalPhase as Phase;
        use MaintenanceMachineInput as Input;
        use MaintenanceMachineState as State;

        match (state, input) {
            (State::Idle, Input::Begin) => {
                Transition::Accepted(State::Journal(Phase::PreparingMaintenance))
            }
            (State::Idle, Input::Startup | Input::RuntimeRetired) => Transition::Unchanged,
            (State::Journal(Phase::PreparingMaintenance), Input::InstallingIntent) => {
                Transition::Committed(State::Journal(Phase::InstallingIntent))
            }
            (State::Journal(Phase::InstallingIntent), Input::InstallingIntent)
            | (State::Journal(Phase::Relaunching), Input::Relaunching)
            | (State::Journal(Phase::Recovering), Input::RuntimeRetired | Input::Startup)
            | (
                State::Journal(Phase::Completed | Phase::Failed | Phase::Cancelled),
                Input::Startup | Input::RuntimeRetired,
            ) => Transition::Unchanged,
            (State::Journal(Phase::InstallingIntent), Input::Relaunching) => {
                Transition::Committed(State::Journal(Phase::Relaunching))
            }
            (State::Journal(Phase::PreparingMaintenance), Input::Cancel | Input::Startup) => {
                Transition::Cancelled(State::Journal(Phase::Cancelled))
            }
            (
                State::Journal(Phase::InstallingIntent | Phase::Relaunching),
                Input::Startup | Input::RuntimeRetired,
            ) => Transition::RecoveryRequired(State::Journal(Phase::Recovering)),
            (State::Journal(Phase::PreparingMaintenance), Input::RuntimeRetired) => {
                Transition::Cancelled(State::Journal(Phase::Cancelled))
            }
            (
                State::Journal(
                    Phase::InstallingIntent
                    | Phase::Relaunching
                    | Phase::Recovering
                    | Phase::Completed
                    | Phase::Failed
                    | Phase::Cancelled,
                ),
                Input::Cancel,
            ) => Transition::Rejected(UpdaterMaintenanceError::TooLateToCancel),
            (State::Journal(Phase::Recovering), Input::Complete) => {
                Transition::Committed(State::Journal(Phase::Completed))
            }
            (State::Journal(Phase::Recovering), Input::Fail) => {
                Transition::Failed(State::Journal(Phase::Failed))
            }
            _ => Transition::Rejected(UpdaterMaintenanceError::OperationMismatch),
        }
    }

    fn input_correlation(&self, _state: &Self::State, _input: &Self::Input) -> Option<Correlation> {
        None
    }

    fn effect_is_current(&self, _state: &Self::State, _correlation: &Correlation) -> bool {
        false
    }

    fn task_failed(&self, _correlation: Correlation, _failure: TaskFailure) -> Self::Input {
        MaintenanceMachineInput::RuntimeRetired
    }

    fn shutdown(&self) -> Self::Input {
        MaintenanceMachineInput::RuntimeRetired
    }

    fn unavailable(&self) -> Self::Error {
        UpdaterMaintenanceError::JournalIo
    }
}

fn reduce_maintenance_phase(
    phase: Option<MaintenanceJournalPhase>,
    input: MaintenanceMachineInput,
) -> Result<Option<MaintenanceJournalPhase>, UpdaterMaintenanceError> {
    let state = phase.map_or(
        MaintenanceMachineState::Idle,
        MaintenanceMachineState::Journal,
    );
    let transition = MaintenanceMachine.reduce(&state, &input);
    match transition {
        Transition::Accepted(next)
        | Transition::Committed(next)
        | Transition::Cancelled(next)
        | Transition::Failed(next)
        | Transition::RecoveryRequired(next) => Ok(match next {
            MaintenanceMachineState::Idle => None,
            MaintenanceMachineState::Journal(phase) => Some(phase),
        }),
        Transition::Unchanged | Transition::Retired => Ok(phase),
        Transition::Rejected(error) => Err(error),
        Transition::EffectEmitting { .. } => Err(UpdaterMaintenanceError::JournalUnsafe),
    }
}

impl MaintenanceJournalPhase {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::PreparingMaintenance => "preparing-maintenance",
            Self::InstallingIntent => "installing-intent",
            Self::Relaunching => "relaunching",
            Self::Recovering => "recovering",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceJournalRecord {
    schema_version: u8,
    revision: u64,
    operation: MaintenanceOperationEvidence,
    versions: MaintenanceVersionEvidence,
    capture: MaintenanceCaptureEvidence,
    phase: MaintenanceJournalPhase,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceOperationEvidence {
    operation_id: String,
    admitted_revision: u64,
    machine_authority_sha256: String,
    recovery_authority_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceVersionEvidence {
    previous: String,
    expected: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceCaptureEvidence {
    intent: UpdaterCaptureIntent,
    ownership: Option<MaintenanceCaptureOwnership>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceCaptureOwnership {
    authority_sha256: String,
    revision: u64,
}

#[derive(Clone, Debug)]
pub(super) struct MaintenanceRuntimeState {
    pub phase: Option<MaintenanceJournalPhase>,
    pub operation_id: Option<String>,
    pub revision: u64,
    pub terminal_reason: Option<String>,
    pub snapshot: Option<UpdaterMaintenanceSnapshot>,
}

impl MaintenanceRuntimeState {
    fn idle(observed_version: String) -> Self {
        Self {
            phase: None,
            operation_id: None,
            revision: 0,
            terminal_reason: None,
            snapshot: Some(UpdaterMaintenanceSnapshot {
                reconciliation: UpdaterMaintenanceReconciliation::None,
                capture_intent: None,
                expected_version: None,
                observed_version,
                automatic_activation_allowed: true,
            }),
        }
    }
}

pub struct UpdaterMaintenanceAuthority {
    machine_authority_sha256: String,
    observed_version: String,
    store: MaintenanceJournalStore,
    state: Mutex<MaintenanceRuntimeState>,
    evidence: Mutex<VecDeque<UpdaterMaintenanceTransitionEvidence>>,
}

impl UpdaterMaintenanceAuthority {
    pub fn open(
        root: PathBuf,
        machine_authority: &str,
        observed_version: &str,
    ) -> Result<Self, UpdaterMaintenanceError> {
        validate_version(observed_version)?;
        let store = MaintenanceJournalStore::open(root)?;
        let machine_authority_sha256 = digest(machine_authority.as_bytes());
        let authority = Self {
            machine_authority_sha256,
            observed_version: observed_version.to_owned(),
            store,
            state: Mutex::new(MaintenanceRuntimeState::idle(observed_version.to_owned())),
            evidence: Mutex::new(VecDeque::with_capacity(EVIDENCE_LIMIT)),
        };
        authority.reconcile_startup()?;
        Ok(authority)
    }

    pub fn begin(
        &self,
        request: UpdaterMaintenanceRequest,
    ) -> Result<u64, UpdaterMaintenanceError> {
        validate_request(&request)?;
        if request.current_version != self.observed_version {
            return Err(UpdaterMaintenanceError::InvalidVersion);
        }
        let mut state = self.state.lock().expect("maintenance state poisoned");
        if let Some(current) = self.store.read_record()? {
            let duplicate = current.operation.operation_id == request.operation_id
                && current.operation.admitted_revision == request.admitted_revision
                && current.operation.machine_authority_sha256 == self.machine_authority_sha256
                && current.versions.previous == request.current_version
                && current.versions.expected == request.expected_version
                && current.capture.intent == request.capture_intent
                && current.capture.ownership == capture_ownership(&request)
                && current.phase == MaintenanceJournalPhase::PreparingMaintenance;
            if duplicate {
                let previous = state.phase;
                self.store.reconfirm_record_durability(&current)?;
                state.phase = Some(current.phase);
                state.operation_id = Some(current.operation.operation_id.clone());
                state.revision = current.revision;
                state.terminal_reason = None;
                state.snapshot = Some(self.snapshot_for(
                    &current,
                    UpdaterMaintenanceReconciliation::None,
                    false,
                ));
                self.record_evidence(
                    previous,
                    "begin",
                    state.phase,
                    "duplicate-durability-reconfirmed",
                    Some(&current),
                );
                return Ok(current.revision);
            }
            return Err(UpdaterMaintenanceError::Busy);
        }
        if request.admitted_revision <= state.revision {
            return Err(UpdaterMaintenanceError::StaleRevision);
        }
        let phase = reduce_maintenance_phase(None, MaintenanceMachineInput::Begin)?
            .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
        let ownership = capture_ownership(&request);
        let record = MaintenanceJournalRecord {
            schema_version: JOURNAL_SCHEMA_VERSION,
            revision: request.admitted_revision,
            operation: MaintenanceOperationEvidence {
                operation_id: request.operation_id.clone(),
                admitted_revision: request.admitted_revision,
                machine_authority_sha256: self.machine_authority_sha256.clone(),
                recovery_authority_sha256: None,
            },
            versions: MaintenanceVersionEvidence {
                previous: request.current_version,
                expected: request.expected_version,
            },
            capture: MaintenanceCaptureEvidence {
                intent: request.capture_intent,
                ownership,
            },
            phase,
        };
        self.store.write_record(&record)?;
        let previous = state.phase;
        state.phase = Some(record.phase);
        state.operation_id = Some(record.operation.operation_id.clone());
        state.revision = record.revision;
        state.terminal_reason = None;
        state.snapshot =
            Some(self.snapshot_for(&record, UpdaterMaintenanceReconciliation::None, false));
        self.record_evidence(previous, "begin", state.phase, "applied", Some(&record));
        Ok(record.revision)
    }

    pub fn mark_installing_intent(
        &self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<u64, UpdaterMaintenanceError> {
        self.transition(
            operation_id,
            expected_revision,
            MaintenanceMachineInput::InstallingIntent,
            "installing-intent-committed",
        )
    }

    pub fn mark_relaunching(
        &self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<u64, UpdaterMaintenanceError> {
        self.transition(
            operation_id,
            expected_revision,
            MaintenanceMachineInput::Relaunching,
            "relaunching-committed",
        )
    }

    pub fn cancel(
        &self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<u64, UpdaterMaintenanceError> {
        let mut state = self.state.lock().expect("maintenance state poisoned");
        if state.phase == Some(MaintenanceJournalPhase::Cancelled)
            && state.operation_id.as_deref() == Some(operation_id)
            && expected_revision.checked_add(1) == Some(state.revision)
        {
            let from = state.phase;
            return self.finish_terminal_cleanup(
                &mut state,
                operation_id,
                MaintenanceJournalPhase::Cancelled,
                "cancel",
                from,
                "cleanup-retried",
            );
        }
        if let Some(record) = self.store.read_record()? {
            let duplicate_terminal = record.operation.operation_id == operation_id
                && record.operation.machine_authority_sha256 == self.machine_authority_sha256
                && record.phase == MaintenanceJournalPhase::Cancelled
                && expected_revision.checked_add(1) == Some(record.revision);
            if duplicate_terminal {
                let previous = state.phase;
                self.store.reconfirm_record_durability(&record)?;
                state.phase = Some(record.phase);
                state.operation_id = Some(record.operation.operation_id.clone());
                state.revision = record.revision;
                state.terminal_reason = Some("cancelled".into());
                state.snapshot = Some(self.snapshot_for(
                    &record,
                    UpdaterMaintenanceReconciliation::UnknownOutcome,
                    false,
                ));
                return self.finish_terminal_cleanup(
                    &mut state,
                    operation_id,
                    MaintenanceJournalPhase::Cancelled,
                    "cancel",
                    previous,
                    "cleanup-retried",
                );
            }
        }
        let mut record = self.owned_record(operation_id, expected_revision)?;
        let next_phase =
            match reduce_maintenance_phase(Some(record.phase), MaintenanceMachineInput::Cancel) {
                Ok(Some(phase)) => phase,
                Ok(None) => return Err(UpdaterMaintenanceError::JournalUnsafe),
                Err(error) => {
                    self.record_evidence(
                        state.phase,
                        "cancel",
                        state.phase,
                        "cancel-too-late",
                        Some(&record),
                    );
                    return Err(error);
                }
            };
        if next_phase == record.phase {
            self.record_evidence(
                state.phase,
                "cancel",
                state.phase,
                "duplicate",
                Some(&record),
            );
            return Ok(record.revision);
        }
        let previous = state.phase;
        advance_revision(&mut record)?;
        record.phase = next_phase;
        self.store.write_record(&record)?;
        state.phase = Some(record.phase);
        state.operation_id = Some(record.operation.operation_id.clone());
        state.revision = record.revision;
        state.terminal_reason = Some("cancelled".into());
        state.snapshot = Some(self.snapshot_for(
            &record,
            UpdaterMaintenanceReconciliation::UnknownOutcome,
            false,
        ));
        self.finish_terminal_cleanup(
            &mut state,
            operation_id,
            MaintenanceJournalPhase::Cancelled,
            "cancel",
            previous,
            "applied",
        )
    }

    pub fn complete_recovery(
        &self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<u64, UpdaterMaintenanceError> {
        self.finish_recovery(
            operation_id,
            expected_revision,
            MaintenanceJournalPhase::Completed,
            "completed",
        )
    }

    pub fn fail_recovery(
        &self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<u64, UpdaterMaintenanceError> {
        self.finish_recovery(
            operation_id,
            expected_revision,
            MaintenanceJournalPhase::Failed,
            "failed",
        )
    }

    pub fn retire_runtime(&self) -> Result<(), UpdaterMaintenanceError> {
        let Some(record) = self.store.read_record()? else {
            return Ok(());
        };
        if !self.owns_record(&record) {
            let phase = self.state.lock().expect("maintenance state poisoned").phase;
            self.record_evidence(
                phase,
                "runtime-retired",
                phase,
                "foreign-operation-retained",
                Some(&record),
            );
            return Ok(());
        }
        let revision = record.revision;
        let operation_id = record.operation.operation_id.clone();
        if record.phase == MaintenanceJournalPhase::PreparingMaintenance {
            self.cancel(&operation_id, revision)?;
            return Ok(());
        }
        if matches!(
            record.phase,
            MaintenanceJournalPhase::InstallingIntent
                | MaintenanceJournalPhase::Relaunching
                | MaintenanceJournalPhase::Recovering
        ) {
            let _ = self.transition_any_unknown_outcome(&operation_id, revision)?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Option<UpdaterMaintenanceSnapshot> {
        self.state
            .lock()
            .expect("maintenance state poisoned")
            .snapshot
            .clone()
    }

    pub fn automatic_activation_allowed(&self) -> bool {
        self.snapshot()
            .is_none_or(|snapshot| snapshot.automatic_activation_allowed)
    }

    pub fn transition_evidence(&self) -> Vec<UpdaterMaintenanceTransitionEvidence> {
        self.evidence
            .lock()
            .expect("maintenance evidence poisoned")
            .iter()
            .cloned()
            .collect()
    }

    pub(super) fn runtime_state(&self) -> MaintenanceRuntimeState {
        self.state
            .lock()
            .expect("maintenance state poisoned")
            .clone()
    }

    fn reconcile_startup(&self) -> Result<(), UpdaterMaintenanceError> {
        let loaded = self.store.load_for_reconciliation()?;
        let mut state = self.state.lock().expect("maintenance state poisoned");
        match loaded {
            LoadedJournal::Absent => {
                reduce_maintenance_phase(None, MaintenanceMachineInput::Startup)?;
                self.record_evidence(None, "startup", None, "no-journal", None);
            }
            LoadedJournal::Corrupt => {
                state.phase = Some(MaintenanceJournalPhase::Failed);
                state.terminal_reason = Some("journal-corrupt".into());
                state.snapshot = Some(UpdaterMaintenanceSnapshot {
                    reconciliation: UpdaterMaintenanceReconciliation::Corrupt,
                    capture_intent: None,
                    expected_version: None,
                    observed_version: self.observed_version.clone(),
                    automatic_activation_allowed: false,
                });
                self.record_evidence(None, "startup", state.phase, "fail-closed-corrupt", None);
            }
            LoadedJournal::Incompatible => {
                state.phase = Some(MaintenanceJournalPhase::Failed);
                state.terminal_reason = Some("journal-incompatible".into());
                state.snapshot = Some(UpdaterMaintenanceSnapshot {
                    reconciliation: UpdaterMaintenanceReconciliation::Incompatible,
                    capture_intent: None,
                    expected_version: None,
                    observed_version: self.observed_version.clone(),
                    automatic_activation_allowed: false,
                });
                self.record_evidence(
                    None,
                    "startup",
                    state.phase,
                    "fail-closed-incompatible",
                    None,
                );
            }
            LoadedJournal::Valid(mut record) => {
                state.operation_id = Some(record.operation.operation_id.clone());
                state.revision = record.revision;
                match record.phase {
                    MaintenanceJournalPhase::PreparingMaintenance => {
                        let previous = Some(record.phase);
                        record.phase = reduce_maintenance_phase(
                            Some(record.phase),
                            MaintenanceMachineInput::Startup,
                        )?
                        .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
                        advance_revision(&mut record)?;
                        self.store.write_record(&record)?;
                        self.store.clear_owned(&record)?;
                        state.phase = Some(record.phase);
                        state.revision = record.revision;
                        state.terminal_reason = Some("pre-install-aborted".into());
                        state.snapshot = Some(self.snapshot_for(
                            &record,
                            UpdaterMaintenanceReconciliation::PreInstallAborted,
                            true,
                        ));
                        self.record_evidence(
                            previous,
                            "startup",
                            state.phase,
                            "pre-install-aborted",
                            Some(&record),
                        );
                    }
                    MaintenanceJournalPhase::InstallingIntent
                    | MaintenanceJournalPhase::Relaunching
                    | MaintenanceJournalPhase::Recovering => {
                        let previous = Some(record.phase);
                        let reconciliation = if self.observed_version == record.versions.expected {
                            UpdaterMaintenanceReconciliation::ExpectedVersion
                        } else if self.observed_version == record.versions.previous {
                            UpdaterMaintenanceReconciliation::OldVersion
                        } else {
                            UpdaterMaintenanceReconciliation::UnexpectedVersion
                        };
                        let next_phase = reduce_maintenance_phase(
                            Some(record.phase),
                            MaintenanceMachineInput::Startup,
                        )?
                        .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
                        if next_phase != record.phase {
                            advance_revision(&mut record)?;
                        }
                        record.phase = next_phase;
                        record.operation.recovery_authority_sha256 =
                            Some(self.machine_authority_sha256.clone());
                        self.store.write_record(&record)?;
                        state.phase = Some(record.phase);
                        state.revision = record.revision;
                        state.terminal_reason = None;
                        state.snapshot = Some(self.snapshot_for(&record, reconciliation, false));
                        self.record_evidence(
                            previous,
                            "startup",
                            state.phase,
                            "recovery-required",
                            Some(&record),
                        );
                    }
                    MaintenanceJournalPhase::Completed
                    | MaintenanceJournalPhase::Failed
                    | MaintenanceJournalPhase::Cancelled => {
                        reduce_maintenance_phase(
                            Some(record.phase),
                            MaintenanceMachineInput::Startup,
                        )?;
                        self.store.clear_owned(&record)?;
                        state.phase = Some(record.phase);
                        state.terminal_reason = match record.phase {
                            MaintenanceJournalPhase::Failed => Some("failed".into()),
                            MaintenanceJournalPhase::Cancelled => Some("cancelled".into()),
                            _ => None,
                        };
                        state.snapshot = Some(self.snapshot_for(
                            &record,
                            UpdaterMaintenanceReconciliation::TerminalCleared,
                            true,
                        ));
                        self.record_evidence(
                            Some(record.phase),
                            "startup",
                            state.phase,
                            "terminal-cleared",
                            Some(&record),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn transition(
        &self,
        operation_id: &str,
        expected_revision: u64,
        machine_input: MaintenanceMachineInput,
        input: &'static str,
    ) -> Result<u64, UpdaterMaintenanceError> {
        let mut state = self.state.lock().expect("maintenance state poisoned");
        let mut record = self.owned_record_for_operation(operation_id)?;
        let duplicate_phase = match machine_input {
            MaintenanceMachineInput::InstallingIntent => MaintenanceJournalPhase::InstallingIntent,
            MaintenanceMachineInput::Relaunching => MaintenanceJournalPhase::Relaunching,
            _ => return Err(UpdaterMaintenanceError::JournalUnsafe),
        };
        if record.phase == duplicate_phase
            && expected_revision.checked_add(1) == Some(record.revision)
        {
            return self.reconfirm_nonterminal_duplicate(&mut state, &record, input);
        }
        if record.revision != expected_revision {
            return Err(UpdaterMaintenanceError::StaleRevision);
        }
        let next_phase = reduce_maintenance_phase(Some(record.phase), machine_input)?
            .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
        if record.phase == next_phase {
            return self.reconfirm_nonterminal_duplicate(&mut state, &record, input);
        }
        let previous = state.phase;
        advance_revision(&mut record)?;
        record.phase = next_phase;
        self.store.write_record(&record)?;
        state.phase = Some(record.phase);
        state.operation_id = Some(record.operation.operation_id.clone());
        state.revision = record.revision;
        state.terminal_reason = None;
        state.snapshot = Some(self.snapshot_for(
            &record,
            UpdaterMaintenanceReconciliation::UnknownOutcome,
            false,
        ));
        self.record_evidence(previous, input, state.phase, "applied", Some(&record));
        Ok(record.revision)
    }

    fn transition_any_unknown_outcome(
        &self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<u64, UpdaterMaintenanceError> {
        let mut state = self.state.lock().expect("maintenance state poisoned");
        let mut record = self.owned_record(operation_id, expected_revision)?;
        let next_phase =
            reduce_maintenance_phase(Some(record.phase), MaintenanceMachineInput::RuntimeRetired)?
                .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
        if record.phase == next_phase {
            return self.reconfirm_nonterminal_duplicate(&mut state, &record, "runtime-retired");
        }
        let previous = state.phase;
        advance_revision(&mut record)?;
        record.phase = next_phase;
        record.operation.recovery_authority_sha256 = Some(self.machine_authority_sha256.clone());
        self.store.write_record(&record)?;
        state.phase = Some(record.phase);
        state.revision = record.revision;
        state.terminal_reason = None;
        state.snapshot = Some(self.snapshot_for(
            &record,
            UpdaterMaintenanceReconciliation::UnknownOutcome,
            false,
        ));
        self.record_evidence(
            previous,
            "runtime-retired",
            state.phase,
            "recovery-required",
            Some(&record),
        );
        Ok(record.revision)
    }

    fn finish_recovery(
        &self,
        operation_id: &str,
        expected_revision: u64,
        terminal: MaintenanceJournalPhase,
        input: &'static str,
    ) -> Result<u64, UpdaterMaintenanceError> {
        let mut state = self.state.lock().expect("maintenance state poisoned");
        if state.phase == Some(terminal)
            && state.operation_id.as_deref() == Some(operation_id)
            && expected_revision.checked_add(1) == Some(state.revision)
        {
            let from = state.phase;
            return self.finish_terminal_cleanup(
                &mut state,
                operation_id,
                terminal,
                input,
                from,
                "cleanup-retried",
            );
        }
        if let Some(record) = self.store.read_record()? {
            let duplicate_terminal = record.operation.operation_id == operation_id
                && record.operation.recovery_authority_sha256.as_deref()
                    == Some(&self.machine_authority_sha256)
                && record.phase == terminal
                && expected_revision.checked_add(1) == Some(record.revision);
            if duplicate_terminal {
                let previous = state.phase;
                self.store.reconfirm_record_durability(&record)?;
                state.phase = Some(record.phase);
                state.operation_id = Some(record.operation.operation_id.clone());
                state.revision = record.revision;
                state.terminal_reason =
                    (terminal == MaintenanceJournalPhase::Failed).then(|| "failed".to_owned());
                state.snapshot = Some(self.snapshot_for(
                    &record,
                    UpdaterMaintenanceReconciliation::UnknownOutcome,
                    false,
                ));
                return self.finish_terminal_cleanup(
                    &mut state,
                    operation_id,
                    terminal,
                    input,
                    previous,
                    "cleanup-retried",
                );
            }
        }
        let mut record = self.owned_record(operation_id, expected_revision)?;
        let machine_input = if terminal == MaintenanceJournalPhase::Completed {
            MaintenanceMachineInput::Complete
        } else {
            MaintenanceMachineInput::Fail
        };
        let next_phase = reduce_maintenance_phase(Some(record.phase), machine_input)?
            .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
        let previous = state.phase;
        advance_revision(&mut record)?;
        record.phase = next_phase;
        self.store.write_record(&record)?;
        state.phase = Some(record.phase);
        state.operation_id = Some(record.operation.operation_id.clone());
        state.revision = record.revision;
        state.terminal_reason =
            (terminal == MaintenanceJournalPhase::Failed).then(|| "failed".to_owned());
        state.snapshot = Some(self.snapshot_for(
            &record,
            UpdaterMaintenanceReconciliation::UnknownOutcome,
            false,
        ));
        self.finish_terminal_cleanup(
            &mut state,
            operation_id,
            terminal,
            input,
            previous,
            "applied",
        )
    }

    fn reconfirm_nonterminal_duplicate(
        &self,
        state: &mut MaintenanceRuntimeState,
        record: &MaintenanceJournalRecord,
        input: &'static str,
    ) -> Result<u64, UpdaterMaintenanceError> {
        let previous = state.phase;
        self.store.reconfirm_record_durability(record)?;
        state.phase = Some(record.phase);
        state.operation_id = Some(record.operation.operation_id.clone());
        state.revision = record.revision;
        state.terminal_reason = None;
        state.snapshot = Some(self.snapshot_for(
            record,
            UpdaterMaintenanceReconciliation::UnknownOutcome,
            false,
        ));
        self.record_evidence(
            previous,
            input,
            state.phase,
            "duplicate-durability-reconfirmed",
            Some(record),
        );
        Ok(record.revision)
    }

    fn finish_terminal_cleanup(
        &self,
        state: &mut MaintenanceRuntimeState,
        operation_id: &str,
        terminal: MaintenanceJournalPhase,
        input: &'static str,
        from: Option<MaintenanceJournalPhase>,
        disposition: &'static str,
    ) -> Result<u64, UpdaterMaintenanceError> {
        let revision = state.revision;
        if state.snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.reconciliation == UpdaterMaintenanceReconciliation::TerminalCleared
                && snapshot.automatic_activation_allowed
        }) {
            self.record_evidence(state.phase, input, state.phase, "duplicate", None);
            return Ok(revision);
        }
        let cleared = match self.clear_terminal_owned(operation_id, revision, terminal) {
            Ok(cleared) => cleared,
            Err(error) => {
                self.record_evidence(from, input, state.phase, "terminal-cleanup-pending", None);
                return Err(error);
            }
        };
        let snapshot = state
            .snapshot
            .as_mut()
            .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
        snapshot.reconciliation = UpdaterMaintenanceReconciliation::TerminalCleared;
        snapshot.automatic_activation_allowed = true;
        self.record_evidence(from, input, state.phase, disposition, cleared.as_ref());
        Ok(revision)
    }

    fn clear_terminal_owned(
        &self,
        operation_id: &str,
        revision: u64,
        terminal: MaintenanceJournalPhase,
    ) -> Result<Option<MaintenanceJournalRecord>, UpdaterMaintenanceError> {
        let Some(record) = self.store.read_record()? else {
            sync_directory(&self.store.root)?;
            return Ok(None);
        };
        let owns_terminal = match terminal {
            MaintenanceJournalPhase::Cancelled => {
                record.operation.machine_authority_sha256 == self.machine_authority_sha256
            }
            MaintenanceJournalPhase::Completed | MaintenanceJournalPhase::Failed => {
                record.operation.recovery_authority_sha256.as_deref()
                    == Some(&self.machine_authority_sha256)
            }
            _ => false,
        };
        if record.operation.operation_id != operation_id
            || record.revision != revision
            || record.phase != terminal
            || !owns_terminal
        {
            return Err(UpdaterMaintenanceError::OperationMismatch);
        }
        self.store.clear_owned(&record)?;
        Ok(Some(record))
    }

    fn owned_record(
        &self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<MaintenanceJournalRecord, UpdaterMaintenanceError> {
        let record = self.owned_record_for_operation(operation_id)?;
        if record.revision != expected_revision {
            return Err(UpdaterMaintenanceError::StaleRevision);
        }
        Ok(record)
    }

    fn owned_record_for_operation(
        &self,
        operation_id: &str,
    ) -> Result<MaintenanceJournalRecord, UpdaterMaintenanceError> {
        let record = self
            .store
            .read_record()?
            .ok_or(UpdaterMaintenanceError::OperationMismatch)?;
        if record.operation.operation_id != operation_id || !self.owns_record(&record) {
            return Err(UpdaterMaintenanceError::OperationMismatch);
        }
        Ok(record)
    }

    fn owns_record(&self, record: &MaintenanceJournalRecord) -> bool {
        if record.phase == MaintenanceJournalPhase::Recovering {
            record.operation.recovery_authority_sha256.as_deref()
                == Some(&self.machine_authority_sha256)
        } else {
            record.operation.machine_authority_sha256 == self.machine_authority_sha256
        }
    }

    fn snapshot_for(
        &self,
        record: &MaintenanceJournalRecord,
        reconciliation: UpdaterMaintenanceReconciliation,
        automatic_activation_allowed: bool,
    ) -> UpdaterMaintenanceSnapshot {
        UpdaterMaintenanceSnapshot {
            reconciliation,
            capture_intent: Some(record.capture.intent),
            expected_version: Some(record.versions.expected.clone()),
            observed_version: self.observed_version.clone(),
            automatic_activation_allowed,
        }
    }

    fn record_evidence(
        &self,
        from: Option<MaintenanceJournalPhase>,
        input: &str,
        to: Option<MaintenanceJournalPhase>,
        disposition: &str,
        record: Option<&MaintenanceJournalRecord>,
    ) {
        let mut evidence = self.evidence.lock().expect("maintenance evidence poisoned");
        if evidence.len() == EVIDENCE_LIMIT {
            evidence.pop_front();
        }
        let sequence = evidence
            .back()
            .map_or(1, |entry| entry.sequence.saturating_add(1));
        evidence.push_back(UpdaterMaintenanceTransitionEvidence {
            sequence,
            admitted_revision: record.map(|record| record.operation.admitted_revision),
            operation_id_sha256: record
                .map(|record| digest(record.operation.operation_id.as_bytes())),
            from: from.map_or("idle", MaintenanceJournalPhase::label).into(),
            input: input.into(),
            to: to.map_or("idle", MaintenanceJournalPhase::label).into(),
            disposition: disposition.into(),
        });
    }
}

fn validate_request(request: &UpdaterMaintenanceRequest) -> Result<(), UpdaterMaintenanceError> {
    validate_operation_id(&request.operation_id)?;
    validate_version(&request.current_version)?;
    validate_version(&request.expected_version)?;
    if request.admitted_revision > u64::MAX - MAINTENANCE_REVISION_HEADROOM {
        return Err(UpdaterMaintenanceError::RevisionExhausted);
    }
    if parse_version(&request.expected_version).ok() <= parse_version(&request.current_version).ok()
    {
        return Err(UpdaterMaintenanceError::InvalidVersion);
    }
    match (request.capture_intent, request.capture_ownership.as_ref()) {
        (UpdaterCaptureIntent::None, None) => Ok(()),
        (UpdaterCaptureIntent::RestorePriorCapture, Some(ownership))
            if valid_digest(&ownership.authority_sha256) =>
        {
            Ok(())
        }
        _ => Err(UpdaterMaintenanceError::InvalidCaptureOwnership),
    }
}

fn advance_revision(record: &mut MaintenanceJournalRecord) -> Result<(), UpdaterMaintenanceError> {
    record.revision = record
        .revision
        .checked_add(1)
        .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
    Ok(())
}

fn capture_ownership(request: &UpdaterMaintenanceRequest) -> Option<MaintenanceCaptureOwnership> {
    request
        .capture_ownership
        .as_ref()
        .map(|ownership| MaintenanceCaptureOwnership {
            authority_sha256: ownership.authority_sha256.clone(),
            revision: ownership.revision,
        })
}

fn validate_operation_id(operation_id: &str) -> Result<(), UpdaterMaintenanceError> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(UpdaterMaintenanceError::InvalidOperationKey);
    }
    Ok(())
}

fn validate_version(version: &str) -> Result<(), UpdaterMaintenanceError> {
    if version.is_empty() || version.len() > 128 || parse_version(version).is_err() {
        return Err(UpdaterMaintenanceError::InvalidVersion);
    }
    Ok(())
}

fn validate_record(record: &MaintenanceJournalRecord) -> bool {
    record.schema_version == JOURNAL_SCHEMA_VERSION
        && record.operation.admitted_revision <= u64::MAX - MAINTENANCE_REVISION_HEADROOM
        && valid_phase_revision(record)
        && validate_operation_id(&record.operation.operation_id).is_ok()
        && valid_digest(&record.operation.machine_authority_sha256)
        && record
            .operation
            .recovery_authority_sha256
            .as_deref()
            .is_none_or(valid_digest)
        && validate_version(&record.versions.previous).is_ok()
        && validate_version(&record.versions.expected).is_ok()
        && parse_version(&record.versions.expected).ok()
            > parse_version(&record.versions.previous).ok()
        && match (&record.capture.intent, &record.capture.ownership) {
            (UpdaterCaptureIntent::None, None) => true,
            (UpdaterCaptureIntent::RestorePriorCapture, Some(ownership)) => {
                valid_digest(&ownership.authority_sha256)
            }
            _ => false,
        }
}

fn valid_phase_revision(record: &MaintenanceJournalRecord) -> bool {
    let Some(offset) = record
        .revision
        .checked_sub(record.operation.admitted_revision)
    else {
        return false;
    };
    match record.phase {
        MaintenanceJournalPhase::PreparingMaintenance => offset == 0,
        MaintenanceJournalPhase::InstallingIntent => offset == 1,
        MaintenanceJournalPhase::Relaunching => offset == 2,
        MaintenanceJournalPhase::Recovering => matches!(offset, 2 | 3),
        MaintenanceJournalPhase::Completed | MaintenanceJournalPhase::Failed => {
            matches!(offset, 3 | 4)
        }
        MaintenanceJournalPhase::Cancelled => offset == 1,
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

enum LoadedJournal {
    Absent,
    Corrupt,
    Incompatible,
    Valid(MaintenanceJournalRecord),
}

struct MaintenanceJournalStore {
    root: PathBuf,
    #[cfg(test)]
    fail_next_clear: AtomicU8,
    #[cfg(test)]
    fail_next_write_sync: AtomicBool,
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum ClearFailurePoint {
    BeforeUnlink = 1,
    AfterUnlink = 2,
}

impl MaintenanceJournalStore {
    fn open(root: PathBuf) -> Result<Self, UpdaterMaintenanceError> {
        if !root.is_absolute() {
            return Err(UpdaterMaintenanceError::JournalUnsafe);
        }
        ensure_private_directory(&root)?;
        let root = fs::canonicalize(root).map_err(|_| UpdaterMaintenanceError::JournalIo)?;
        validate_private_directory(&root)?;
        let store = Self {
            root,
            #[cfg(test)]
            fail_next_clear: AtomicU8::new(0),
            #[cfg(test)]
            fail_next_write_sync: AtomicBool::new(false),
        };
        store.cleanup_temporary_files()?;
        Ok(store)
    }

    fn load_for_reconciliation(&self) -> Result<LoadedJournal, UpdaterMaintenanceError> {
        let path = self.root.join(JOURNAL_FILE);
        match fs::symlink_metadata(&path) {
            Ok(_) => validate_private_file(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LoadedJournal::Absent);
            }
            Err(_) => return Err(UpdaterMaintenanceError::JournalIo),
        }
        let metadata = fs::metadata(&path).map_err(|_| UpdaterMaintenanceError::JournalIo)?;
        if metadata.len() > JOURNAL_MAX_BYTES {
            return Ok(LoadedJournal::Corrupt);
        }
        let bytes = fs::read(&path).map_err(|_| UpdaterMaintenanceError::JournalIo)?;
        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return Ok(LoadedJournal::Corrupt),
        };
        if value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(JOURNAL_SCHEMA_VERSION.into())
        {
            return Ok(LoadedJournal::Incompatible);
        }
        let record: MaintenanceJournalRecord = match serde_json::from_value(value) {
            Ok(record) => record,
            Err(_) => return Ok(LoadedJournal::Corrupt),
        };
        if !validate_record(&record) {
            return Ok(LoadedJournal::Corrupt);
        }
        Ok(LoadedJournal::Valid(record))
    }

    fn read_record(&self) -> Result<Option<MaintenanceJournalRecord>, UpdaterMaintenanceError> {
        match self.load_for_reconciliation()? {
            LoadedJournal::Absent => Ok(None),
            LoadedJournal::Valid(record) => Ok(Some(record)),
            LoadedJournal::Corrupt | LoadedJournal::Incompatible => {
                Err(UpdaterMaintenanceError::JournalUnsafe)
            }
        }
    }

    fn write_record(
        &self,
        record: &MaintenanceJournalRecord,
    ) -> Result<(), UpdaterMaintenanceError> {
        if !validate_record(record) {
            return Err(UpdaterMaintenanceError::JournalUnsafe);
        }
        let bytes = serde_json::to_vec(record).map_err(|_| UpdaterMaintenanceError::JournalIo)?;
        if bytes.len() as u64 > JOURNAL_MAX_BYTES {
            return Err(UpdaterMaintenanceError::JournalUnsafe);
        }
        let temporary = self
            .root
            .join(format!("{JOURNAL_FILE}.tmp-{}", Uuid::new_v4().simple()));
        let mut file = open_new_private_file(&temporary)?;
        let write = file.write_all(&bytes).and_then(|_| file.sync_all());
        if write.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(UpdaterMaintenanceError::JournalIo);
        }
        if fs::rename(&temporary, self.root.join(JOURNAL_FILE)).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(UpdaterMaintenanceError::JournalIo);
        }
        validate_private_file(&self.root.join(JOURNAL_FILE))?;
        #[cfg(test)]
        if self.fail_next_write_sync.swap(false, Ordering::SeqCst) {
            return Err(UpdaterMaintenanceError::JournalIo);
        }
        sync_directory(&self.root)
    }

    fn reconfirm_record_durability(
        &self,
        expected: &MaintenanceJournalRecord,
    ) -> Result<(), UpdaterMaintenanceError> {
        let current = self
            .read_record()?
            .ok_or(UpdaterMaintenanceError::OperationMismatch)?;
        if current != *expected {
            return Err(UpdaterMaintenanceError::OperationMismatch);
        }
        sync_directory(&self.root)
    }

    fn clear_owned(
        &self,
        expected: &MaintenanceJournalRecord,
    ) -> Result<(), UpdaterMaintenanceError> {
        let current = self
            .read_record()?
            .ok_or(UpdaterMaintenanceError::OperationMismatch)?;
        if current != *expected {
            return Err(UpdaterMaintenanceError::OperationMismatch);
        }
        #[cfg(test)]
        let failure = self.fail_next_clear.swap(0, Ordering::SeqCst);
        #[cfg(test)]
        if failure == ClearFailurePoint::BeforeUnlink as u8 {
            return Err(UpdaterMaintenanceError::JournalIo);
        }
        fs::remove_file(self.root.join(JOURNAL_FILE))
            .map_err(|_| UpdaterMaintenanceError::JournalIo)?;
        #[cfg(test)]
        if failure == ClearFailurePoint::AfterUnlink as u8 {
            return Err(UpdaterMaintenanceError::JournalIo);
        }
        sync_directory(&self.root)
    }

    #[cfg(test)]
    fn fail_next_clear(&self, point: ClearFailurePoint) {
        self.fail_next_clear.store(point as u8, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn fail_next_write_sync(&self) {
        self.fail_next_write_sync.store(true, Ordering::SeqCst);
    }

    fn cleanup_temporary_files(&self) -> Result<(), UpdaterMaintenanceError> {
        let entries = fs::read_dir(&self.root)
            .map_err(|_| UpdaterMaintenanceError::JournalIo)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| UpdaterMaintenanceError::JournalIo)?;
        if entries.len() > 16 {
            return Err(UpdaterMaintenanceError::JournalUnsafe);
        }
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(UpdaterMaintenanceError::JournalUnsafe);
            };
            if name == JOURNAL_FILE {
                continue;
            }
            if name.starts_with("journal.json.tmp-") {
                validate_private_file(&entry.path())?;
                fs::remove_file(entry.path()).map_err(|_| UpdaterMaintenanceError::JournalIo)?;
                continue;
            }
            return Err(UpdaterMaintenanceError::JournalUnsafe);
        }
        sync_directory(&self.root)
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), UpdaterMaintenanceError> {
    ensure_private_directory_and_sync_parent(path, sync_directory)
}

fn ensure_private_directory_and_sync_parent(
    path: &Path,
    sync_parent: impl FnOnce(&Path) -> Result<(), UpdaterMaintenanceError>,
) -> Result<(), UpdaterMaintenanceError> {
    match fs::symlink_metadata(path) {
        Ok(_) => validate_private_directory(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_private_directory(path)?;
        }
        Err(_) => return Err(UpdaterMaintenanceError::JournalIo),
    }
    validate_private_directory(path)?;
    let parent = path
        .parent()
        .ok_or(UpdaterMaintenanceError::JournalUnsafe)?;
    sync_parent(parent)
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<(), UpdaterMaintenanceError> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder
        .create(path)
        .map_err(|_| UpdaterMaintenanceError::JournalIo)
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> Result<(), UpdaterMaintenanceError> {
    fs::create_dir(path).map_err(|_| UpdaterMaintenanceError::JournalIo)
}

fn validate_private_directory(path: &Path) -> Result<(), UpdaterMaintenanceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UpdaterMaintenanceError::JournalIo)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(UpdaterMaintenanceError::JournalUnsafe);
    }
    validate_owner_and_mode(&metadata, true)
}

fn validate_private_file(path: &Path) -> Result<(), UpdaterMaintenanceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UpdaterMaintenanceError::JournalIo)?;
    if !metadata.file_type().is_file() {
        return Err(UpdaterMaintenanceError::JournalUnsafe);
    }
    validate_owner_and_mode(&metadata, false)
}

#[cfg(unix)]
fn validate_owner_and_mode(
    metadata: &fs::Metadata,
    directory: bool,
) -> Result<(), UpdaterMaintenanceError> {
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || (!directory && metadata.nlink() != 1)
    {
        return Err(UpdaterMaintenanceError::JournalUnsafe);
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_owner_and_mode(
    _metadata: &fs::Metadata,
    _directory: bool,
) -> Result<(), UpdaterMaintenanceError> {
    Ok(())
}

fn open_new_private_file(path: &Path) -> Result<File, UpdaterMaintenanceError> {
    open_new_private_file_platform(path)
}

#[cfg(unix)]
fn open_new_private_file_platform(path: &Path) -> Result<File, UpdaterMaintenanceError> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| UpdaterMaintenanceError::JournalIo)
}

#[cfg(not(unix))]
fn open_new_private_file_platform(path: &Path) -> Result<File, UpdaterMaintenanceError> {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| UpdaterMaintenanceError::JournalIo)
}

#[cfg(all(test, unix))]
fn set_permissions(path: &Path, mode: u32) -> Result<(), UpdaterMaintenanceError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| UpdaterMaintenanceError::JournalIo)
}

#[cfg(all(test, not(unix)))]
fn set_permissions(_path: &Path, _mode: u32) -> Result<(), UpdaterMaintenanceError> {
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), UpdaterMaintenanceError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| UpdaterMaintenanceError::JournalIo)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn authority(root: &TempDir, observed_version: &str) -> UpdaterMaintenanceAuthority {
        UpdaterMaintenanceAuthority::open(
            root.path().join("maintenance"),
            "process-authority",
            observed_version,
        )
        .unwrap()
    }

    fn request(operation_id: &str) -> UpdaterMaintenanceRequest {
        UpdaterMaintenanceRequest {
            operation_id: operation_id.into(),
            admitted_revision: 7,
            current_version: "0.1.0".into(),
            expected_version: "0.1.1".into(),
            capture_intent: UpdaterCaptureIntent::RestorePriorCapture,
            capture_ownership: Some(UpdaterCaptureOwnershipEvidence {
                authority_sha256: "a".repeat(64),
                revision: 12,
            }),
        }
    }

    #[test]
    fn fresh_journal_root_requires_retryable_parent_durability_confirmation() {
        let root = TempDir::new().unwrap();
        let journal_root = root.path().join("maintenance");
        let mut observed_parent = None;

        assert_eq!(
            ensure_private_directory_and_sync_parent(&journal_root, |parent| {
                observed_parent = Some(parent.to_path_buf());
                Err(UpdaterMaintenanceError::JournalIo)
            }),
            Err(UpdaterMaintenanceError::JournalIo)
        );
        assert_eq!(observed_parent.as_deref(), Some(root.path()));
        validate_private_directory(&journal_root).unwrap();

        ensure_private_directory(&journal_root).unwrap();
        assert!(authority(&root, "0.1.0").automatic_activation_allowed());
    }

    #[test]
    fn legal_transition_table_is_revision_and_operation_scoped() {
        let root = TempDir::new().unwrap();
        let authority = authority(&root, "0.1.0");
        let preparing = authority.begin(request("operation-a")).unwrap();
        assert_eq!(preparing, 7);
        assert_eq!(authority.begin(request("operation-a")).unwrap(), preparing);
        assert_eq!(
            authority.begin(request("operation-b")),
            Err(UpdaterMaintenanceError::Busy)
        );
        let installing = authority
            .mark_installing_intent("operation-a", preparing)
            .unwrap();
        assert_eq!(installing, 8);
        assert_eq!(
            authority.mark_installing_intent("operation-a", preparing),
            Ok(installing)
        );
        assert_eq!(
            authority.mark_relaunching("operation-a", preparing),
            Err(UpdaterMaintenanceError::StaleRevision)
        );
        let relaunching = authority
            .mark_relaunching("operation-a", installing)
            .unwrap();
        assert_eq!(relaunching, 9);
        assert_eq!(
            authority.mark_relaunching("operation-a", installing),
            Ok(relaunching)
        );
        authority.retire_runtime().unwrap();
        let state = authority.runtime_state();
        assert_eq!(state.phase, Some(MaintenanceJournalPhase::Recovering));
        assert_eq!(state.revision, 10);
        assert!(!authority.automatic_activation_allowed());
    }

    #[test]
    fn begin_rejects_a_current_version_not_observed_by_the_authority() {
        let root = TempDir::new().unwrap();
        let authority = authority(&root, "0.1.0");
        let mut stale = request("stale-version");
        stale.current_version = "0.0.9".into();

        assert_eq!(
            authority.begin(stale),
            Err(UpdaterMaintenanceError::InvalidVersion)
        );
        assert_eq!(authority.store.read_record().unwrap(), None);
        assert_eq!(authority.runtime_state().phase, None);
    }

    #[test]
    fn begin_requires_a_strictly_advancing_authority_revision() {
        let root = TempDir::new().unwrap();
        let authority = authority(&root, "0.1.0");
        let mut first = request("first-operation");
        first.admitted_revision = 0;
        assert_eq!(
            authority.begin(first),
            Err(UpdaterMaintenanceError::StaleRevision)
        );

        let revision = authority.begin(request("completed-operation")).unwrap();
        let terminal = authority.cancel("completed-operation", revision).unwrap();
        assert!(!root.path().join("maintenance/journal.json").exists());

        let mut stale = request("stale-operation");
        stale.admitted_revision = terminal;
        assert_eq!(
            authority.begin(stale),
            Err(UpdaterMaintenanceError::StaleRevision)
        );

        let mut advancing = request("advancing-operation");
        advancing.admitted_revision = terminal + 1;
        assert_eq!(authority.begin(advancing), Ok(terminal + 1));
    }

    #[test]
    fn begin_reserves_revision_headroom_for_restart_and_terminal_recovery() {
        for admitted_revision in [u64::MAX, u64::MAX - 3] {
            let root = TempDir::new().unwrap();
            let authority = authority(&root, "0.1.0");
            let mut unsafe_request = request("unsafe-headroom");
            unsafe_request.admitted_revision = admitted_revision;
            assert_eq!(
                authority.begin(unsafe_request),
                Err(UpdaterMaintenanceError::RevisionExhausted)
            );
            assert_eq!(authority.store.read_record().unwrap(), None);
        }

        let root = TempDir::new().unwrap();
        let first = authority(&root, "0.1.0");
        let mut safe_request = request("safe-headroom");
        safe_request.admitted_revision = u64::MAX - MAINTENANCE_REVISION_HEADROOM;
        let revision = first.begin(safe_request).unwrap();
        let revision = first
            .mark_installing_intent("safe-headroom", revision)
            .unwrap();
        first.mark_relaunching("safe-headroom", revision).unwrap();
        first.retire_runtime().unwrap();
        drop(first);

        let replacement = UpdaterMaintenanceAuthority::open(
            root.path().join("maintenance"),
            "replacement-authority",
            "0.1.1",
        )
        .unwrap();
        let recovery_revision = replacement.runtime_state().revision;
        assert_eq!(recovery_revision, u64::MAX - 1);
        drop(replacement);

        let second_replacement = UpdaterMaintenanceAuthority::open(
            root.path().join("maintenance"),
            "second-replacement-authority",
            "0.1.1",
        )
        .unwrap();
        assert_eq!(
            second_replacement.runtime_state().revision,
            recovery_revision
        );
        assert_eq!(
            second_replacement.complete_recovery("safe-headroom", recovery_revision),
            Ok(u64::MAX)
        );
        assert!(second_replacement.automatic_activation_allowed());
        assert!(!root.path().join("maintenance/journal.json").exists());
    }

    #[test]
    fn duplicate_commands_reconfirm_ambiguous_journal_write_durability() {
        let root = TempDir::new().unwrap();
        let authority = authority(&root, "0.1.0");
        authority.store.fail_next_write_sync();
        assert_eq!(
            authority.begin(request("operation-a")),
            Err(UpdaterMaintenanceError::JournalIo)
        );
        assert_eq!(authority.runtime_state().phase, None);
        let preparing = authority.begin(request("operation-a")).unwrap();
        assert_eq!(preparing, 7);
        assert_eq!(
            authority.runtime_state().phase,
            Some(MaintenanceJournalPhase::PreparingMaintenance)
        );

        authority.store.fail_next_write_sync();
        assert_eq!(
            authority.mark_installing_intent("operation-a", preparing),
            Err(UpdaterMaintenanceError::JournalIo)
        );
        assert_eq!(
            authority.runtime_state().phase,
            Some(MaintenanceJournalPhase::PreparingMaintenance)
        );
        let installing = authority
            .mark_installing_intent("operation-a", preparing)
            .unwrap();
        assert_eq!(installing, 8);
        assert_eq!(
            authority.runtime_state().phase,
            Some(MaintenanceJournalPhase::InstallingIntent)
        );

        authority.store.fail_next_write_sync();
        assert_eq!(
            authority.retire_runtime(),
            Err(UpdaterMaintenanceError::JournalIo)
        );
        assert_eq!(
            authority.runtime_state().phase,
            Some(MaintenanceJournalPhase::InstallingIntent)
        );
        authority.retire_runtime().unwrap();
        let recovering = authority.runtime_state().revision;
        authority.store.fail_next_write_sync();
        assert_eq!(
            authority.complete_recovery("operation-a", recovering),
            Err(UpdaterMaintenanceError::JournalIo)
        );
        assert_eq!(
            authority.runtime_state().phase,
            Some(MaintenanceJournalPhase::Recovering)
        );
        assert_eq!(
            authority.complete_recovery("operation-a", recovering),
            Ok(recovering + 1)
        );
        assert!(authority.automatic_activation_allowed());
        assert!(!root.path().join("maintenance/journal.json").exists());
    }

    #[test]
    fn cancellation_linearizes_before_installing_intent_only() {
        let root = TempDir::new().unwrap();
        let authority = authority(&root, "0.1.0");
        let revision = authority.begin(request("cancel-before")).unwrap();
        let cancelled = authority.cancel("cancel-before", revision).unwrap();
        assert_eq!(authority.cancel("cancel-before", revision), Ok(cancelled));
        assert!(!root.path().join("maintenance/journal.json").exists());

        let mut next = request("cancel-after");
        next.admitted_revision = cancelled + 1;
        let revision = authority.begin(next).unwrap();
        let revision = authority
            .mark_installing_intent("cancel-after", revision)
            .unwrap();
        assert_eq!(
            authority.cancel("cancel-after", revision),
            Err(UpdaterMaintenanceError::TooLateToCancel)
        );
        assert!(root.path().join("maintenance/journal.json").exists());
    }

    #[test]
    fn startup_reconciliation_distinguishes_crash_boundaries_and_versions() {
        for (phase, observed, expected_outcome) in [
            (
                MaintenanceJournalPhase::InstallingIntent,
                "0.1.1",
                UpdaterMaintenanceReconciliation::ExpectedVersion,
            ),
            (
                MaintenanceJournalPhase::Relaunching,
                "0.1.0",
                UpdaterMaintenanceReconciliation::OldVersion,
            ),
            (
                MaintenanceJournalPhase::Recovering,
                "0.2.0",
                UpdaterMaintenanceReconciliation::UnexpectedVersion,
            ),
        ] {
            let root = TempDir::new().unwrap();
            let first = authority(&root, "0.1.0");
            let mut revision = first.begin(request("operation-a")).unwrap();
            revision = first
                .mark_installing_intent("operation-a", revision)
                .unwrap();
            if matches!(phase, MaintenanceJournalPhase::Relaunching) {
                first.mark_relaunching("operation-a", revision).unwrap();
            } else if matches!(phase, MaintenanceJournalPhase::Recovering) {
                first.retire_runtime().unwrap();
            }
            drop(first);
            let restarted = authority(&root, observed);
            let snapshot = restarted.snapshot().unwrap();
            assert_eq!(snapshot.reconciliation, expected_outcome);
            assert!(!snapshot.automatic_activation_allowed);
            assert_eq!(
                restarted.runtime_state().phase,
                Some(MaintenanceJournalPhase::Recovering)
            );
        }
    }

    #[test]
    fn pre_install_crash_aborts_and_terminal_cleanup_is_owned() {
        let root = TempDir::new().unwrap();
        let first = authority(&root, "0.1.0");
        first.begin(request("operation-a")).unwrap();
        drop(first);
        let restarted = authority(&root, "0.1.0");
        assert_eq!(
            restarted.snapshot().unwrap().reconciliation,
            UpdaterMaintenanceReconciliation::PreInstallAborted
        );
        assert!(restarted.automatic_activation_allowed());
        assert!(!root.path().join("maintenance/journal.json").exists());
    }

    #[test]
    fn terminal_cleanup_retries_before_and_after_unlink_without_recommitting() {
        for failure in [
            ClearFailurePoint::BeforeUnlink,
            ClearFailurePoint::AfterUnlink,
        ] {
            let root = TempDir::new().unwrap();
            let authority = authority(&root, "0.1.0");
            let revision = authority.begin(request("operation-a")).unwrap();
            let revision = authority
                .mark_installing_intent("operation-a", revision)
                .unwrap();
            authority.retire_runtime().unwrap();
            let recovering_revision = revision.checked_add(1).unwrap();
            authority.store.fail_next_clear(failure);

            assert_eq!(
                authority.complete_recovery("operation-a", recovering_revision),
                Err(UpdaterMaintenanceError::JournalIo)
            );
            let pending = authority.runtime_state();
            assert_eq!(pending.phase, Some(MaintenanceJournalPhase::Completed));
            assert_eq!(pending.revision, recovering_revision + 1);
            assert!(!authority.automatic_activation_allowed());

            assert_eq!(
                authority.complete_recovery("operation-a", recovering_revision),
                Ok(recovering_revision + 1)
            );
            assert!(authority.automatic_activation_allowed());
            assert!(!root.path().join("maintenance/journal.json").exists());
            assert_eq!(
                authority.transition_evidence().last().unwrap().disposition,
                "cleanup-retried"
            );
        }
    }

    #[test]
    fn cancellation_cleanup_retries_the_same_linearized_terminal_revision() {
        let root = TempDir::new().unwrap();
        let authority = authority(&root, "0.1.0");
        let revision = authority.begin(request("operation-a")).unwrap();
        authority
            .store
            .fail_next_clear(ClearFailurePoint::BeforeUnlink);

        assert_eq!(
            authority.cancel("operation-a", revision),
            Err(UpdaterMaintenanceError::JournalIo)
        );
        assert_eq!(
            authority.runtime_state().phase,
            Some(MaintenanceJournalPhase::Cancelled)
        );
        assert!(!authority.automatic_activation_allowed());
        assert_eq!(authority.cancel("operation-a", revision), Ok(revision + 1));
        assert!(authority.automatic_activation_allowed());
        assert!(!root.path().join("maintenance/journal.json").exists());
    }

    #[test]
    fn crash_after_terminal_commit_finishes_cleanup_without_replaying_install() {
        let root = TempDir::new().unwrap();
        let first = authority(&root, "0.1.0");
        let revision = first.begin(request("operation-a")).unwrap();
        first
            .mark_installing_intent("operation-a", revision)
            .unwrap();
        first.retire_runtime().unwrap();
        let mut terminal = first.store.read_record().unwrap().unwrap();
        terminal.revision = terminal.revision.checked_add(1).unwrap();
        terminal.phase = MaintenanceJournalPhase::Completed;
        first.store.write_record(&terminal).unwrap();
        drop(first);

        let restarted = authority(&root, "0.1.1");
        assert_eq!(
            restarted.snapshot().unwrap().reconciliation,
            UpdaterMaintenanceReconciliation::TerminalCleared
        );
        assert!(restarted.automatic_activation_allowed());
        assert!(!root.path().join("maintenance/journal.json").exists());
    }

    #[test]
    fn corrupt_partial_and_incompatible_journals_fail_closed_without_deletion() {
        for contents in [
            b"{\"schemaVersion\":".as_slice(),
            b"{\"schemaVersion\":99}".as_slice(),
            br#"{"schemaVersion":1,"privatePath":"/Users/private"}"#.as_slice(),
        ] {
            let root = TempDir::new().unwrap();
            let directory = root.path().join("maintenance");
            fs::create_dir_all(&directory).unwrap();
            set_permissions(&directory, 0o700).unwrap();
            let journal = directory.join(JOURNAL_FILE);
            fs::write(&journal, contents).unwrap();
            set_permissions(&journal, 0o600).unwrap();
            let restarted = authority(&root, "0.1.0");
            assert!(!restarted.automatic_activation_allowed());
            assert!(journal.exists());
        }
    }

    #[test]
    fn unreachable_phase_revisions_are_corrupt_and_retained() {
        for (phase, unreachable_revision) in [
            (MaintenanceJournalPhase::PreparingMaintenance, u64::MAX),
            (MaintenanceJournalPhase::InstallingIntent, 9),
            (MaintenanceJournalPhase::Relaunching, 10),
            (MaintenanceJournalPhase::Recovering, u64::MAX),
            (MaintenanceJournalPhase::Completed, 9),
            (MaintenanceJournalPhase::Failed, 9),
            (MaintenanceJournalPhase::Cancelled, 9),
        ] {
            let root = TempDir::new().unwrap();
            let first = authority(&root, "0.1.0");
            first.begin(request("unreachable-revision")).unwrap();
            let mut record = first.store.read_record().unwrap().unwrap();
            record.phase = phase;
            record.revision = unreachable_revision;
            let journal = root.path().join("maintenance/journal.json");
            fs::write(&journal, serde_json::to_vec(&record).unwrap()).unwrap();
            drop(first);

            let restarted = UpdaterMaintenanceAuthority::open(
                root.path().join("maintenance"),
                "replacement-authority",
                "0.1.0",
            )
            .unwrap();
            let snapshot = restarted.snapshot().unwrap();
            assert_eq!(
                snapshot.reconciliation,
                UpdaterMaintenanceReconciliation::Corrupt
            );
            assert!(!snapshot.automatic_activation_allowed);
            assert!(journal.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn linked_journals_fail_closed_without_following_or_deleting_targets() {
        use std::os::unix::fs::symlink;

        let linked_root = TempDir::new().unwrap();
        let external_directory = linked_root.path().join("external-maintenance");
        fs::create_dir(&external_directory).unwrap();
        set_permissions(&external_directory, 0o700).unwrap();
        let linked_directory = linked_root.path().join("maintenance");
        symlink(&external_directory, &linked_directory).unwrap();
        assert_eq!(
            UpdaterMaintenanceAuthority::open(linked_directory, "authority", "0.1.0").err(),
            Some(UpdaterMaintenanceError::JournalUnsafe)
        );
        assert!(external_directory.exists());

        let root = TempDir::new().unwrap();
        let directory = root.path().join("maintenance");
        fs::create_dir_all(&directory).unwrap();
        set_permissions(&directory, 0o700).unwrap();
        let external = root.path().join("external.json");
        fs::write(&external, b"external-private-data").unwrap();
        set_permissions(&external, 0o600).unwrap();
        symlink(&external, directory.join(JOURNAL_FILE)).unwrap();
        assert_eq!(
            UpdaterMaintenanceAuthority::open(directory.clone(), "authority", "0.1.0").err(),
            Some(UpdaterMaintenanceError::JournalUnsafe)
        );
        assert_eq!(fs::read(&external).unwrap(), b"external-private-data");

        fs::remove_file(directory.join(JOURNAL_FILE)).unwrap();
        symlink(
            root.path().join("missing-target.json"),
            directory.join(JOURNAL_FILE),
        )
        .unwrap();
        assert_eq!(
            UpdaterMaintenanceAuthority::open(directory.clone(), "replacement", "0.1.0").err(),
            Some(UpdaterMaintenanceError::JournalUnsafe)
        );

        fs::remove_file(directory.join(JOURNAL_FILE)).unwrap();
        let seed = authority(&root, "0.1.0");
        seed.begin(request("operation-a")).unwrap();
        let hardlink = root.path().join("journal-hardlink.json");
        fs::hard_link(directory.join(JOURNAL_FILE), &hardlink).unwrap();
        drop(seed);
        assert_eq!(
            UpdaterMaintenanceAuthority::open(directory, "replacement", "0.1.0").err(),
            Some(UpdaterMaintenanceError::JournalUnsafe)
        );
        assert!(hardlink.exists());
    }

    #[test]
    fn journal_and_diagnostics_never_contain_private_update_material() {
        let root = TempDir::new().unwrap();
        let authority = authority(&root, "0.1.0");
        authority.begin(request("operation-a")).unwrap();
        let journal = fs::read_to_string(root.path().join("maintenance/journal.json")).unwrap();
        let evidence = serde_json::to_string(&authority.transition_evidence()).unwrap();
        for forbidden in [
            "https://",
            "credential",
            "signature",
            "metadata",
            "profile",
            "/Users/",
            "privatePath",
        ] {
            assert!(
                !journal
                    .to_ascii_lowercase()
                    .contains(&forbidden.to_ascii_lowercase())
            );
            assert!(
                !evidence
                    .to_ascii_lowercase()
                    .contains(&forbidden.to_ascii_lowercase())
            );
        }
    }

    #[test]
    fn replacement_adopts_only_the_exact_recovery_operation_and_revision() {
        let root = TempDir::new().unwrap();
        let first = authority(&root, "0.1.0");
        let revision = first.begin(request("operation-a")).unwrap();
        first
            .mark_installing_intent("operation-a", revision)
            .unwrap();
        let replacement = UpdaterMaintenanceAuthority::open(
            root.path().join("maintenance"),
            "replacement-authority",
            "0.1.0",
        )
        .unwrap();
        assert!(!replacement.automatic_activation_allowed());

        let second_replacement = UpdaterMaintenanceAuthority::open(
            root.path().join("maintenance"),
            "second-replacement-authority",
            "0.1.0",
        )
        .unwrap();
        replacement.retire_runtime().unwrap();
        first.retire_runtime().unwrap();
        assert_eq!(second_replacement.runtime_state().revision, 9);
        assert_eq!(
            first.complete_recovery("operation-a", 9),
            Err(UpdaterMaintenanceError::OperationMismatch)
        );
        assert_eq!(
            replacement.complete_recovery("operation-b", 9),
            Err(UpdaterMaintenanceError::OperationMismatch)
        );
        assert_eq!(
            replacement.complete_recovery("operation-a", 9),
            Err(UpdaterMaintenanceError::OperationMismatch)
        );
        assert_eq!(
            replacement.complete_recovery("operation-a", 8),
            Err(UpdaterMaintenanceError::OperationMismatch)
        );
        assert_eq!(
            second_replacement.complete_recovery("operation-a", 8),
            Err(UpdaterMaintenanceError::StaleRevision)
        );
        let completed = second_replacement
            .complete_recovery("operation-a", 9)
            .unwrap();
        assert_eq!(completed, 10);
        assert_eq!(
            second_replacement.complete_recovery("operation-a", 9),
            Ok(completed)
        );
        assert!(!root.path().join("maintenance/journal.json").exists());
    }

    #[test]
    fn adopted_recovery_failure_commits_and_cleans_the_exact_operation() {
        let root = TempDir::new().unwrap();
        let first = authority(&root, "0.1.0");
        let revision = first.begin(request("operation-a")).unwrap();
        first
            .mark_installing_intent("operation-a", revision)
            .unwrap();
        drop(first);

        let replacement = UpdaterMaintenanceAuthority::open(
            root.path().join("maintenance"),
            "replacement-authority",
            "0.1.0",
        )
        .unwrap();
        let revision = replacement.runtime_state().revision;
        let failed = replacement.fail_recovery("operation-a", revision).unwrap();
        assert_eq!(failed, revision + 1);
        assert_eq!(
            replacement.fail_recovery("operation-a", revision),
            Ok(failed)
        );
        assert_eq!(
            replacement.runtime_state().phase,
            Some(MaintenanceJournalPhase::Failed)
        );
        assert!(replacement.automatic_activation_allowed());
        assert!(!root.path().join("maintenance/journal.json").exists());
    }
}
