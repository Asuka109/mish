use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

use mish_runtime::{CaptureFailureKind, TunHelperFailureKind, TunHelperRemovalOutcome};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const TUN_HELPER_REMOVAL_OCCURRENCE_LIMIT: usize = 16;
pub const TUN_HELPER_REMOVAL_OCCURRENCE_MAX_BYTES: u64 = 32 * 1024;
const TUN_HELPER_REMOVAL_OCCURRENCE_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperRemovalAdmittedState {
    NotInstalled,
    RepairRequired,
    Repairing,
    Replacing,
    Running,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperRemovalLifecyclePhase {
    Admitted,
    CaptureShutdown,
    RemovalObservation,
    PrivilegedMaintenance,
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperRemovalObservationOutcome {
    ConfirmedSafe,
    Foreign,
    Incomplete,
    NotStarted,
    Removed,
    Stale,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperRemovalCleanupOutcome {
    ConfirmedAbsent,
    Incomplete,
    NotRequired,
    NotStarted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperRemovalCaptureFailure {
    ApplyFailed,
    CapabilityUnavailable,
    ConfirmationFailed,
    ConfigurationRequired,
    CoreUnhealthy,
    ExternalDrift,
    InvalidRecovery,
    ListenerUnavailable,
    ObservationFailed,
    PermissionDenied,
    PersistenceFailed,
    RollbackFailed,
    RuntimeTransition,
    TakeoverRejected,
    UnsafeExistingConfiguration,
    UnsupportedSelection,
}

impl From<CaptureFailureKind> for TunHelperRemovalCaptureFailure {
    fn from(kind: CaptureFailureKind) -> Self {
        match kind {
            CaptureFailureKind::ApplyFailed => Self::ApplyFailed,
            CaptureFailureKind::CapabilityUnavailable => Self::CapabilityUnavailable,
            CaptureFailureKind::ConfirmationFailed => Self::ConfirmationFailed,
            CaptureFailureKind::ConfigurationRequired => Self::ConfigurationRequired,
            CaptureFailureKind::CoreUnhealthy => Self::CoreUnhealthy,
            CaptureFailureKind::ExternalDrift => Self::ExternalDrift,
            CaptureFailureKind::InvalidRecovery => Self::InvalidRecovery,
            CaptureFailureKind::ListenerUnavailable => Self::ListenerUnavailable,
            CaptureFailureKind::ObservationFailed => Self::ObservationFailed,
            CaptureFailureKind::PermissionDenied => Self::PermissionDenied,
            CaptureFailureKind::PersistenceFailed => Self::PersistenceFailed,
            CaptureFailureKind::RollbackFailed => Self::RollbackFailed,
            CaptureFailureKind::RuntimeTransition => Self::RuntimeTransition,
            CaptureFailureKind::TakeoverRejected => Self::TakeoverRejected,
            CaptureFailureKind::UnsafeExistingConfiguration => Self::UnsafeExistingConfiguration,
            CaptureFailureKind::UnsupportedSelection => Self::UnsupportedSelection,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "domain", content = "kind")]
pub enum TunHelperRemovalOccurrenceFailure {
    Capture(TunHelperRemovalCaptureFailure),
    Helper(TunHelperFailureKind),
    InstallationUnconfirmed,
    ProcessInterrupted,
    SettingsUnavailable,
}

impl TunHelperRemovalOccurrenceFailure {
    pub fn notification_id(self) -> &'static str {
        match self {
            Self::Capture(kind) => match kind {
                TunHelperRemovalCaptureFailure::ApplyFailed => "apply-failed",
                TunHelperRemovalCaptureFailure::CapabilityUnavailable => "capability-unavailable",
                TunHelperRemovalCaptureFailure::ConfirmationFailed => "confirmation-failed",
                TunHelperRemovalCaptureFailure::ConfigurationRequired => "configuration-required",
                TunHelperRemovalCaptureFailure::CoreUnhealthy => "core-unhealthy",
                TunHelperRemovalCaptureFailure::ExternalDrift => "external-drift",
                TunHelperRemovalCaptureFailure::InvalidRecovery => "invalid-recovery",
                TunHelperRemovalCaptureFailure::ListenerUnavailable => "listener-unavailable",
                TunHelperRemovalCaptureFailure::ObservationFailed => "observation-failed",
                TunHelperRemovalCaptureFailure::PermissionDenied => "permission-denied",
                TunHelperRemovalCaptureFailure::PersistenceFailed => "persistence-failed",
                TunHelperRemovalCaptureFailure::RollbackFailed => "rollback-failed",
                TunHelperRemovalCaptureFailure::RuntimeTransition => "runtime-transition",
                TunHelperRemovalCaptureFailure::TakeoverRejected => "takeover-rejected",
                TunHelperRemovalCaptureFailure::UnsafeExistingConfiguration => {
                    "unsafe-existing-configuration"
                }
                TunHelperRemovalCaptureFailure::UnsupportedSelection => "unsupported-selection",
            },
            Self::Helper(kind) => match kind {
                TunHelperFailureKind::AuthorizationCancelled => "authorization-cancelled",
                TunHelperFailureKind::ConfirmationFailed => "confirmation-failed",
                TunHelperFailureKind::ConnectionFailed => "connection-failed",
                TunHelperFailureKind::IdentityRejected => "identity-rejected",
                TunHelperFailureKind::InstallationFailed => "installation-failed",
                TunHelperFailureKind::InstallerUnavailable => "installer-unavailable",
                TunHelperFailureKind::InvalidSignature => "invalid-signature",
                TunHelperFailureKind::MessageTooLarge => "message-too-large",
                TunHelperFailureKind::OperationFailed => "operation-failed",
                TunHelperFailureKind::ObservationForeign => "observation-foreign",
                TunHelperFailureKind::ObservationPartial => "observation-partial",
                TunHelperFailureKind::ObservationStale => "observation-stale",
                TunHelperFailureKind::PermissionDenied => "permission-denied",
                TunHelperFailureKind::PreparationFailed => "preparation-failed",
                TunHelperFailureKind::ProtocolMismatch => "protocol-mismatch",
                TunHelperFailureKind::RegistrationFailed => "registration-failed",
                TunHelperFailureKind::RegistrationRequiresApproval => {
                    "registration-requires-approval"
                }
                TunHelperFailureKind::Unpackaged => "unpackaged",
                TunHelperFailureKind::UnsignedApp => "unsigned-app",
                TunHelperFailureKind::UnsupportedSystem => "unsupported-system",
                TunHelperFailureKind::VersionMismatch => "version-mismatch",
            },
            Self::InstallationUnconfirmed => "helper-installation-unconfirmed",
            Self::ProcessInterrupted => "process-interrupted",
            Self::SettingsUnavailable => "capability-unavailable",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunHelperRemovalOccurrence {
    pub admitted_revision: u64,
    pub admitted_state: TunHelperRemovalAdmittedState,
    pub cleanup: TunHelperRemovalCleanupOutcome,
    pub failure: Option<TunHelperRemovalOccurrenceFailure>,
    pub lifecycle_phase: TunHelperRemovalLifecyclePhase,
    pub observation: TunHelperRemovalObservationOutcome,
    pub operation_id: String,
    pub outcome: TunHelperRemovalOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveTunHelperRemovalOccurrence {
    admitted_revision: u64,
    admitted_state: TunHelperRemovalAdmittedState,
    cleanup: TunHelperRemovalCleanupOutcome,
    lifecycle_phase: TunHelperRemovalLifecyclePhase,
    observation: TunHelperRemovalObservationOutcome,
    operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TunHelperRemovalOccurrenceJournal {
    active: Option<ActiveTunHelperRemovalOccurrence>,
    next_revision: u64,
    records: VecDeque<TunHelperRemovalOccurrence>,
    schema_version: u16,
}

impl Default for TunHelperRemovalOccurrenceJournal {
    fn default() -> Self {
        Self {
            active: None,
            next_revision: 1,
            records: VecDeque::new(),
            schema_version: TUN_HELPER_REMOVAL_OCCURRENCE_SCHEMA_VERSION,
        }
    }
}

impl TunHelperRemovalOccurrenceJournal {
    fn validate(&self) -> Result<(), TunHelperRemovalOccurrenceStoreError> {
        if self.schema_version != TUN_HELPER_REMOVAL_OCCURRENCE_SCHEMA_VERSION
            || self.next_revision == 0
            || self.records.len() > TUN_HELPER_REMOVAL_OCCURRENCE_LIMIT
            || self.active.as_ref().is_some_and(|active| {
                !valid_identity(active.admitted_revision, &active.operation_id)
                    || active.lifecycle_phase == TunHelperRemovalLifecyclePhase::Completed
                    || active.cleanup == TunHelperRemovalCleanupOutcome::ConfirmedAbsent
                    || active.observation == TunHelperRemovalObservationOutcome::Removed
            })
            || self.records.iter().any(|record| {
                !valid_identity(record.admitted_revision, &record.operation_id)
                    || (record.outcome == TunHelperRemovalOutcome::Removed
                        && (record.lifecycle_phase != TunHelperRemovalLifecyclePhase::Completed
                            || record.failure.is_some()
                            || record.cleanup != TunHelperRemovalCleanupOutcome::ConfirmedAbsent
                            || record.observation != TunHelperRemovalObservationOutcome::Removed))
                    || (record.outcome != TunHelperRemovalOutcome::Removed
                        && (record.failure.is_none()
                            || record.lifecycle_phase == TunHelperRemovalLifecyclePhase::Completed
                            || record.cleanup == TunHelperRemovalCleanupOutcome::ConfirmedAbsent
                            || record.observation == TunHelperRemovalObservationOutcome::Removed))
            })
        {
            return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
        }
        let mut prior = 0;
        let mut operation_ids =
            HashSet::with_capacity(self.records.len() + usize::from(self.active.is_some()));
        for record in &self.records {
            if record.admitted_revision <= prior
                || record.admitted_revision >= self.next_revision
                || !operation_ids.insert(record.operation_id.as_str())
            {
                return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
            }
            prior = record.admitted_revision;
        }
        if self.active.as_ref().is_some_and(|active| {
            active.admitted_revision <= prior
                || active.admitted_revision >= self.next_revision
                || !operation_ids.insert(active.operation_id.as_str())
        }) {
            return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
        }
        Ok(())
    }
}

fn valid_identity(revision: u64, operation_id: &str) -> bool {
    revision > 0 && Uuid::parse_str(operation_id).is_ok_and(|uuid| uuid.to_string() == operation_id)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TunHelperRemovalAdmission {
    pub admitted_revision: u64,
    pub operation_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TunHelperRemovalOccurrenceStoreError {
    Busy,
    Invalid,
    StaleOperation,
    Storage,
}

enum TunHelperRemovalOccurrencePersistence {
    Memory,
    PrivateFile(PathBuf),
}

pub struct TunHelperRemovalOccurrenceStore {
    journal: Mutex<TunHelperRemovalOccurrenceJournal>,
    persistence: TunHelperRemovalOccurrencePersistence,
}

impl TunHelperRemovalOccurrenceStore {
    pub fn in_memory() -> Self {
        Self {
            journal: Mutex::new(TunHelperRemovalOccurrenceJournal::default()),
            persistence: TunHelperRemovalOccurrencePersistence::Memory,
        }
    }

    pub fn open_private_file(path: PathBuf) -> Result<Self, TunHelperRemovalOccurrenceStoreError> {
        validate_private_parent(&path)?;
        let mut journal = load_private_journal(&path)?.unwrap_or_default();
        if let Some(active) = journal.active.take() {
            journal.records.push_back(TunHelperRemovalOccurrence {
                admitted_revision: active.admitted_revision,
                admitted_state: active.admitted_state,
                cleanup: if active.lifecycle_phase
                    >= TunHelperRemovalLifecyclePhase::PrivilegedMaintenance
                {
                    TunHelperRemovalCleanupOutcome::Incomplete
                } else {
                    TunHelperRemovalCleanupOutcome::NotRequired
                },
                failure: Some(TunHelperRemovalOccurrenceFailure::ProcessInterrupted),
                lifecycle_phase: active.lifecycle_phase,
                observation: TunHelperRemovalObservationOutcome::Incomplete,
                operation_id: active.operation_id,
                outcome: TunHelperRemovalOutcome::ObservationIncomplete,
            });
            trim_records(&mut journal.records);
            journal.validate()?;
            write_private_journal(&path, &journal)?;
        }
        Ok(Self {
            journal: Mutex::new(journal),
            persistence: TunHelperRemovalOccurrencePersistence::PrivateFile(path),
        })
    }

    pub fn admit(
        &self,
        operation_id: String,
        admitted_state: TunHelperRemovalAdmittedState,
    ) -> Result<TunHelperRemovalAdmission, TunHelperRemovalOccurrenceStoreError> {
        if Uuid::parse_str(&operation_id).is_err() {
            return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
        }
        let mut journal = self
            .journal
            .lock()
            .expect("removal occurrence store poisoned");
        if journal.active.is_some() {
            return Err(TunHelperRemovalOccurrenceStoreError::Busy);
        }
        if journal
            .records
            .iter()
            .any(|record| record.operation_id == operation_id)
        {
            return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
        }
        let mut next = journal.clone();
        let admitted_revision = next.next_revision;
        next.next_revision = next
            .next_revision
            .checked_add(1)
            .ok_or(TunHelperRemovalOccurrenceStoreError::Invalid)?;
        next.active = Some(ActiveTunHelperRemovalOccurrence {
            admitted_revision,
            admitted_state,
            cleanup: TunHelperRemovalCleanupOutcome::NotStarted,
            lifecycle_phase: TunHelperRemovalLifecyclePhase::Admitted,
            observation: TunHelperRemovalObservationOutcome::NotStarted,
            operation_id: operation_id.clone(),
        });
        self.persist(&next)?;
        *journal = next;
        Ok(TunHelperRemovalAdmission {
            admitted_revision,
            operation_id,
        })
    }

    pub fn advance(
        &self,
        admission: &TunHelperRemovalAdmission,
        lifecycle_phase: TunHelperRemovalLifecyclePhase,
        observation: TunHelperRemovalObservationOutcome,
        cleanup: TunHelperRemovalCleanupOutcome,
    ) -> Result<(), TunHelperRemovalOccurrenceStoreError> {
        let mut journal = self
            .journal
            .lock()
            .expect("removal occurrence store poisoned");
        let mut next = journal.clone();
        let active = matching_active_mut(&mut next, admission)?;
        if lifecycle_phase < active.lifecycle_phase {
            return Err(TunHelperRemovalOccurrenceStoreError::StaleOperation);
        }
        active.lifecycle_phase = lifecycle_phase;
        active.observation = observation;
        active.cleanup = cleanup;
        self.persist(&next)?;
        *journal = next;
        Ok(())
    }

    pub fn finish(
        &self,
        admission: &TunHelperRemovalAdmission,
        outcome: TunHelperRemovalOutcome,
        failure: Option<TunHelperRemovalOccurrenceFailure>,
        observation: TunHelperRemovalObservationOutcome,
        cleanup: TunHelperRemovalCleanupOutcome,
    ) -> Result<TunHelperRemovalOccurrence, TunHelperRemovalOccurrenceStoreError> {
        let mut journal = self
            .journal
            .lock()
            .expect("removal occurrence store poisoned");
        let mut next = journal.clone();
        let active = matching_active_mut(&mut next, admission)?.clone();
        let occurrence = TunHelperRemovalOccurrence {
            admitted_revision: active.admitted_revision,
            admitted_state: active.admitted_state,
            cleanup,
            failure,
            lifecycle_phase: if outcome == TunHelperRemovalOutcome::Removed {
                TunHelperRemovalLifecyclePhase::Completed
            } else {
                active.lifecycle_phase
            },
            observation,
            operation_id: active.operation_id,
            outcome,
        };
        next.active = None;
        next.records.push_back(occurrence.clone());
        trim_records(&mut next.records);
        next.validate()?;
        self.persist(&next)?;
        *journal = next;
        Ok(occurrence)
    }

    pub fn records(&self) -> Vec<TunHelperRemovalOccurrence> {
        self.journal
            .lock()
            .expect("removal occurrence store poisoned")
            .records
            .iter()
            .cloned()
            .collect()
    }

    fn persist(
        &self,
        journal: &TunHelperRemovalOccurrenceJournal,
    ) -> Result<(), TunHelperRemovalOccurrenceStoreError> {
        journal.validate()?;
        match &self.persistence {
            TunHelperRemovalOccurrencePersistence::Memory => Ok(()),
            TunHelperRemovalOccurrencePersistence::PrivateFile(path) => {
                write_private_journal(path, journal)
            }
        }
    }
}

fn matching_active_mut<'a>(
    journal: &'a mut TunHelperRemovalOccurrenceJournal,
    admission: &TunHelperRemovalAdmission,
) -> Result<&'a mut ActiveTunHelperRemovalOccurrence, TunHelperRemovalOccurrenceStoreError> {
    journal
        .active
        .as_mut()
        .filter(|active| {
            active.operation_id == admission.operation_id
                && active.admitted_revision == admission.admitted_revision
        })
        .ok_or(TunHelperRemovalOccurrenceStoreError::StaleOperation)
}

fn trim_records(records: &mut VecDeque<TunHelperRemovalOccurrence>) {
    while records.len() > TUN_HELPER_REMOVAL_OCCURRENCE_LIMIT {
        records.pop_front();
    }
}

fn load_private_journal(
    path: &Path,
) -> Result<Option<TunHelperRemovalOccurrenceJournal>, TunHelperRemovalOccurrenceStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_private_file(&metadata)?;
            if metadata.len() > TUN_HELPER_REMOVAL_OCCURRENCE_MAX_BYTES {
                return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
            }
            let mut bytes = Vec::new();
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)
                .and_then(|file| {
                    file.take(TUN_HELPER_REMOVAL_OCCURRENCE_MAX_BYTES + 1)
                        .read_to_end(&mut bytes)
                })
                .map_err(|_| TunHelperRemovalOccurrenceStoreError::Storage)?;
            if bytes.len() as u64 > TUN_HELPER_REMOVAL_OCCURRENCE_MAX_BYTES {
                return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
            }
            let journal: TunHelperRemovalOccurrenceJournal = serde_json::from_slice(&bytes)
                .map_err(|_| TunHelperRemovalOccurrenceStoreError::Invalid)?;
            journal.validate()?;
            Ok(Some(journal))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(TunHelperRemovalOccurrenceStoreError::Storage),
    }
}

fn write_private_journal(
    path: &Path,
    journal: &TunHelperRemovalOccurrenceJournal,
) -> Result<(), TunHelperRemovalOccurrenceStoreError> {
    journal.validate()?;
    let bytes =
        serde_json::to_vec(journal).map_err(|_| TunHelperRemovalOccurrenceStoreError::Invalid)?;
    if bytes.len() as u64 > TUN_HELPER_REMOVAL_OCCURRENCE_MAX_BYTES {
        return Err(TunHelperRemovalOccurrenceStoreError::Invalid);
    }
    validate_private_parent(path)?;
    let parent = path
        .parent()
        .ok_or(TunHelperRemovalOccurrenceStoreError::Storage)?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        validate_private_file(&metadata)?;
    }
    let temporary = parent.join(format!(".tun-helper-removal.{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| TunHelperRemovalOccurrenceStoreError::Storage)?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|_| TunHelperRemovalOccurrenceStoreError::Storage)?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|_| TunHelperRemovalOccurrenceStoreError::Storage)?;
        fs::rename(&temporary, path).map_err(|_| TunHelperRemovalOccurrenceStoreError::Storage)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| TunHelperRemovalOccurrenceStoreError::Storage)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_private_parent(path: &Path) -> Result<(), TunHelperRemovalOccurrenceStoreError> {
    let parent = path
        .parent()
        .ok_or(TunHelperRemovalOccurrenceStoreError::Storage)?;
    let parent_metadata =
        fs::symlink_metadata(parent).map_err(|_| TunHelperRemovalOccurrenceStoreError::Storage)?;
    // SAFETY: getuid has no preconditions and only returns the real user ID.
    let uid = unsafe { libc::getuid() };
    if parent_metadata.file_type().is_symlink()
        || !parent_metadata.is_dir()
        || parent_metadata.uid() != uid
        || parent_metadata.permissions().mode() & 0o022 != 0
    {
        return Err(TunHelperRemovalOccurrenceStoreError::Storage);
    }
    Ok(())
}

fn validate_private_file(
    metadata: &fs::Metadata,
) -> Result<(), TunHelperRemovalOccurrenceStoreError> {
    // SAFETY: getuid has no preconditions and only returns the real user ID.
    let uid = unsafe { libc::getuid() };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(TunHelperRemovalOccurrenceStoreError::Storage);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(value: u128) -> String {
        Uuid::from_u128(value).to_string()
    }

    #[test]
    fn failure_then_success_remains_ordered_bounded_and_redacted() {
        let store = TunHelperRemovalOccurrenceStore::in_memory();
        let failed = store
            .admit(operation(1), TunHelperRemovalAdmittedState::Running)
            .unwrap();
        store
            .advance(
                &failed,
                TunHelperRemovalLifecyclePhase::PrivilegedMaintenance,
                TunHelperRemovalObservationOutcome::ConfirmedSafe,
                TunHelperRemovalCleanupOutcome::NotStarted,
            )
            .unwrap();
        store
            .finish(
                &failed,
                TunHelperRemovalOutcome::AuthorizationCancelled,
                Some(TunHelperRemovalOccurrenceFailure::Helper(
                    TunHelperFailureKind::AuthorizationCancelled,
                )),
                TunHelperRemovalObservationOutcome::ConfirmedSafe,
                TunHelperRemovalCleanupOutcome::NotRequired,
            )
            .unwrap();
        let succeeded = store
            .admit(operation(2), TunHelperRemovalAdmittedState::Running)
            .unwrap();
        store
            .finish(
                &succeeded,
                TunHelperRemovalOutcome::Removed,
                None,
                TunHelperRemovalObservationOutcome::Removed,
                TunHelperRemovalCleanupOutcome::ConfirmedAbsent,
            )
            .unwrap();

        let records = store.records();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].operation_id, operation(1));
        assert_eq!(records[0].admitted_revision, 1);
        assert_eq!(
            records[0].lifecycle_phase,
            TunHelperRemovalLifecyclePhase::PrivilegedMaintenance
        );
        assert_eq!(records[1].operation_id, operation(2));
        assert_eq!(records[1].admitted_revision, 2);
        let encoded = serde_json::to_string(&records).unwrap();
        for forbidden in ["password", "privateKey", "/Users/", "rawOutput", "profile"] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn private_restart_reconciles_active_once_before_the_next_admission() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.path().join("occurrences.json");
        {
            let store = TunHelperRemovalOccurrenceStore::open_private_file(path.clone()).unwrap();
            store
                .admit(operation(1), TunHelperRemovalAdmittedState::Repairing)
                .unwrap();
        }
        let restarted = TunHelperRemovalOccurrenceStore::open_private_file(path.clone()).unwrap();
        let records = restarted.records();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].failure,
            Some(TunHelperRemovalOccurrenceFailure::ProcessInterrupted)
        );
        assert_eq!(
            records[0].outcome,
            TunHelperRemovalOutcome::ObservationIncomplete
        );
        assert_eq!(
            records[0].lifecycle_phase,
            TunHelperRemovalLifecyclePhase::Admitted
        );
        let retry = restarted
            .admit(operation(2), TunHelperRemovalAdmittedState::RepairRequired)
            .unwrap();
        assert_eq!(retry.admitted_revision, 2);

        drop(restarted);
        let read_back = TunHelperRemovalOccurrenceStore::open_private_file(path).unwrap();
        assert_eq!(read_back.records().len(), 2);
        assert_eq!(
            read_back.records()[1].failure,
            Some(TunHelperRemovalOccurrenceFailure::ProcessInterrupted)
        );
    }

    #[test]
    fn duplicate_completion_and_foreign_operation_are_rejected() {
        let store = TunHelperRemovalOccurrenceStore::in_memory();
        let admission = store
            .admit(operation(1), TunHelperRemovalAdmittedState::Running)
            .unwrap();
        store
            .finish(
                &admission,
                TunHelperRemovalOutcome::Removed,
                None,
                TunHelperRemovalObservationOutcome::Removed,
                TunHelperRemovalCleanupOutcome::ConfirmedAbsent,
            )
            .unwrap();
        assert_eq!(
            store.finish(
                &admission,
                TunHelperRemovalOutcome::Removed,
                None,
                TunHelperRemovalObservationOutcome::Removed,
                TunHelperRemovalCleanupOutcome::ConfirmedAbsent,
            ),
            Err(TunHelperRemovalOccurrenceStoreError::StaleOperation)
        );
        assert_eq!(
            store.admit(operation(1), TunHelperRemovalAdmittedState::Running),
            Err(TunHelperRemovalOccurrenceStoreError::Invalid)
        );
        let foreign = TunHelperRemovalAdmission {
            admitted_revision: 2,
            operation_id: operation(2),
        };
        assert_eq!(
            store.advance(
                &foreign,
                TunHelperRemovalLifecyclePhase::CaptureShutdown,
                TunHelperRemovalObservationOutcome::NotStarted,
                TunHelperRemovalCleanupOutcome::NotStarted,
            ),
            Err(TunHelperRemovalOccurrenceStoreError::StaleOperation)
        );
    }

    #[test]
    fn retention_is_exactly_bounded_without_reusing_operation_identity() {
        let store = TunHelperRemovalOccurrenceStore::in_memory();
        for revision in 1..=(TUN_HELPER_REMOVAL_OCCURRENCE_LIMIT as u128 + 4) {
            let admission = store
                .admit(
                    operation(revision),
                    TunHelperRemovalAdmittedState::NotInstalled,
                )
                .unwrap();
            store
                .finish(
                    &admission,
                    TunHelperRemovalOutcome::Removed,
                    None,
                    TunHelperRemovalObservationOutcome::Removed,
                    TunHelperRemovalCleanupOutcome::ConfirmedAbsent,
                )
                .unwrap();
        }
        let records = store.records();
        assert_eq!(records.len(), TUN_HELPER_REMOVAL_OCCURRENCE_LIMIT);
        assert_eq!(records.first().unwrap().admitted_revision, 5);
        assert_eq!(
            records.last().unwrap().admitted_revision,
            TUN_HELPER_REMOVAL_OCCURRENCE_LIMIT as u64 + 4
        );
        assert!(records.windows(2).all(|pair| {
            pair[0].admitted_revision < pair[1].admitted_revision
                && pair[0].operation_id != pair[1].operation_id
        }));
    }

    #[test]
    fn private_store_rejects_unsafe_metadata_links_and_oversized_content() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();

        let permissive = root.path().join("permissive.json");
        fs::write(&permissive, b"{}").unwrap();
        fs::set_permissions(&permissive, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            TunHelperRemovalOccurrenceStore::open_private_file(permissive),
            Err(TunHelperRemovalOccurrenceStoreError::Storage)
        ));

        let target = root.path().join("target.json");
        fs::write(&target, b"{}").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let linked = root.path().join("linked.json");
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        assert!(matches!(
            TunHelperRemovalOccurrenceStore::open_private_file(linked),
            Err(TunHelperRemovalOccurrenceStoreError::Storage)
        ));

        let oversized = root.path().join("oversized.json");
        fs::write(
            &oversized,
            vec![b'x'; TUN_HELPER_REMOVAL_OCCURRENCE_MAX_BYTES as usize + 1],
        )
        .unwrap();
        fs::set_permissions(&oversized, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(
            TunHelperRemovalOccurrenceStore::open_private_file(oversized),
            Err(TunHelperRemovalOccurrenceStoreError::Invalid)
        ));

        let writable_parent = root.path().join("writable");
        fs::create_dir(&writable_parent).unwrap();
        fs::set_permissions(&writable_parent, fs::Permissions::from_mode(0o770)).unwrap();
        assert!(matches!(
            TunHelperRemovalOccurrenceStore::open_private_file(
                writable_parent.join("occurrences.json")
            ),
            Err(TunHelperRemovalOccurrenceStoreError::Storage)
        ));
    }

    #[test]
    fn failed_persistence_does_not_advance_the_in_memory_journal() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.path().join("occurrences.json");
        let store = TunHelperRemovalOccurrenceStore::open_private_file(path).unwrap();

        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(
            store.admit(operation(1), TunHelperRemovalAdmittedState::Running),
            Err(TunHelperRemovalOccurrenceStoreError::Storage)
        );

        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let admission = store
            .admit(operation(1), TunHelperRemovalAdmittedState::Running)
            .unwrap();
        assert_eq!(admission.admitted_revision, 1);
    }
}
