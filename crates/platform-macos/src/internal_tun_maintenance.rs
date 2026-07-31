//! Durable, bounded evidence for Internal TUN Alpha maintenance.
//!
//! The journal deliberately stores only identities, digests, closed observation
//! states, and transaction outcomes. It never stores a Profile, generated Core
//! configuration, private installation key, or raw network configuration.

use std::{
    cmp::Ordering,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

use mish_runtime::{TunNetworkObservation, TunObservationComponentState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const INTERNAL_TUN_MAINTENANCE_JOURNAL_SCHEMA_VERSION: u16 = 1;
pub const INTERNAL_TUN_MAINTENANCE_JOURNAL_MAX_BYTES: u64 = 64 * 1024;
pub const INTERNAL_TUN_MAINTENANCE_ROOT: &str =
    "/Library/Application Support/com.asuka109.mish/internal-tun-alpha";
pub const INTERNAL_TUN_MAINTENANCE_JOURNAL_PATH: &str =
    "/Library/Application Support/com.asuka109.mish/internal-tun-alpha/maintenance-journal.json";
pub const INTERNAL_TUN_MAINTENANCE_BACKUP_DIRECTORY: &str =
    "/Library/Application Support/com.asuka109.mish/internal-tun-alpha/maintenance-backup";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceKind {
    Install,
    Repair,
    Upgrade,
    Uninstall,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceCommitPoint {
    IntentPersisted,
    CaptureReconciled,
    PriorArtifactsBackedUp,
    PriorServiceDetached,
    HelperReplaced,
    CoreReplaced,
    EnrollmentCommitted,
    ReceiptCommitted,
    LaunchDaemonCommitted,
    ServiceStarted,
    Verified,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnrollmentTransition {
    NewEnrollment,
    Preserved,
    AdministratorAuthorizedRebind,
    DualProofRotation,
    Removed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceIntent {
    pub admitted_revision: u64,
    pub installing_uid: u32,
    pub kind: MaintenanceKind,
    pub operation_id: String,
    pub requested_manifest_sha256: String,
    pub requested_package_version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceIdentityEvidence {
    pub enrollment_transition: EnrollmentTransition,
    pub new_generation: Option<u64>,
    pub new_installation_id: Option<String>,
    pub new_key_id: Option<String>,
    pub old_generation: Option<u64>,
    pub old_installation_id: Option<String>,
    pub old_key_id: Option<String>,
    pub package_manifest_sha256: String,
    pub service_label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactDigestSet {
    pub application_sha256: String,
    pub core_sha256: String,
    pub helper_sha256: String,
    pub manifest_sha256: String,
    pub package_version: String,
    pub plist_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceArtifactEvidence {
    pub new: Option<ArtifactDigestSet>,
    pub old: Option<ArtifactDigestSet>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceCaptureEvidence {
    pub accepted_operation_id: String,
    pub after: TunNetworkObservation,
    pub before: TunNetworkObservation,
    pub core_was_running: bool,
    pub network_ownership_record_sha256: Option<String>,
    pub restore_capture_on_app_start: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompensationState {
    NotRequired,
    Pending,
    Restored,
    BoundedDisabled,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceCompensation {
    pub artifacts: CompensationState,
    pub cleanup: CompensationState,
    pub enrollment: CompensationState,
    pub network: CompensationState,
    pub reason: Option<String>,
}

impl Default for MaintenanceCompensation {
    fn default() -> Self {
        Self {
            artifacts: CompensationState::NotRequired,
            cleanup: CompensationState::NotRequired,
            enrollment: CompensationState::NotRequired,
            network: CompensationState::NotRequired,
            reason: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceTerminalOutcome {
    Committed,
    Identical,
    RolledBack,
    BoundedDisabled,
    Uninstalled,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceTerminal {
    pub code: String,
    pub outcome: MaintenanceTerminalOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InternalTunMaintenanceJournal {
    pub artifacts: MaintenanceArtifactEvidence,
    pub capture: MaintenanceCaptureEvidence,
    pub commit_point: MaintenanceCommitPoint,
    pub compensation: MaintenanceCompensation,
    pub identity: MaintenanceIdentityEvidence,
    pub intent: MaintenanceIntent,
    pub schema_version: u16,
    pub terminal: Option<MaintenanceTerminal>,
}

impl InternalTunMaintenanceJournal {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != INTERNAL_TUN_MAINTENANCE_JOURNAL_SCHEMA_VERSION
            || self.intent.admitted_revision == 0
            || self.intent.installing_uid == 0
            || !valid_operation_id(&self.intent.operation_id)
            || !valid_operation_id(&self.capture.accepted_operation_id)
            || !valid_digest(&self.intent.requested_manifest_sha256)
            || !valid_digest(&self.identity.package_manifest_sha256)
            || self.intent.requested_manifest_sha256 != self.identity.package_manifest_sha256
            || self.intent.requested_package_version.is_empty()
            || self.intent.requested_package_version.len() > 64
            || self.identity.service_label != "com.asuka109.mish.tun-helper.dev"
            || !valid_optional_digest(self.capture.network_ownership_record_sha256.as_deref())
            || !valid_optional_digest(self.identity.old_installation_id.as_deref())
            || !valid_optional_digest(self.identity.new_installation_id.as_deref())
            || !valid_optional_digest(self.identity.old_key_id.as_deref())
            || !valid_optional_digest(self.identity.new_key_id.as_deref())
            || self.identity.old_generation == Some(0)
            || self.identity.new_generation == Some(0)
            || !valid_observation(&self.capture.before)
            || !valid_observation(&self.capture.after)
            || self
                .artifacts
                .old
                .as_ref()
                .is_some_and(|set| !valid_artifacts(set))
            || self
                .artifacts
                .new
                .as_ref()
                .is_some_and(|set| !valid_artifacts(set))
        {
            return Err("maintenance-journal-invalid");
        }
        if self.capture.core_was_running
            && !self
                .capture
                .before
                .is_fresh_at(self.capture.before.observed_at)
        {
            return Err("maintenance-capture-authority-unknown");
        }
        if self.commit_point >= MaintenanceCommitPoint::CaptureReconciled
            && !self
                .capture
                .after
                .confirms_disabled_at(self.capture.after.observed_at)
        {
            return Err("maintenance-network-not-reconciled");
        }
        if self.terminal.is_some() && self.commit_point != MaintenanceCommitPoint::Verified {
            return Err("maintenance-terminal-before-verification");
        }
        Ok(())
    }

    pub fn is_terminal(&self) -> bool {
        self.terminal.is_some()
    }

    pub fn permits_helper_startup(&self) -> bool {
        matches!(
            self.terminal.as_ref().map(|terminal| terminal.outcome),
            Some(
                MaintenanceTerminalOutcome::Committed
                    | MaintenanceTerminalOutcome::Identical
                    | MaintenanceTerminalOutcome::RolledBack
            )
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryDecision {
    AlreadyTerminal,
    CompleteCommit,
    Compensate,
    RecoveryRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecoveryObservation {
    pub enrollment_matches_new: bool,
    pub enrollment_matches_old: bool,
    pub network_confirmed_disabled: bool,
    pub new_artifacts_verified: bool,
    pub old_artifacts_verified: bool,
}

pub fn decide_recovery(
    journal: &InternalTunMaintenanceJournal,
    observed: RecoveryObservation,
) -> RecoveryDecision {
    if journal.validate().is_err() {
        return RecoveryDecision::RecoveryRequired;
    }
    if journal.is_terminal() {
        return RecoveryDecision::AlreadyTerminal;
    }
    if !observed.network_confirmed_disabled {
        return RecoveryDecision::RecoveryRequired;
    }
    if journal.commit_point >= MaintenanceCommitPoint::EnrollmentCommitted
        && observed.new_artifacts_verified
        && observed.enrollment_matches_new
    {
        return RecoveryDecision::CompleteCommit;
    }
    if (journal.artifacts.old.is_none()
        || (observed.old_artifacts_verified && observed.enrollment_matches_old))
        && journal.commit_point < MaintenanceCommitPoint::EnrollmentCommitted
    {
        return RecoveryDecision::Compensate;
    }
    RecoveryDecision::RecoveryRequired
}

/// Reobserves the root transaction before a replacement Helper opens its socket. Only the exact
/// post-commit artifact/enrollment identity may complete automatically. Earlier, corrupt, or
/// mixed authority remains unavailable for an administrator-authorized repair or uninstall.
pub fn complete_internal_tun_maintenance_on_helper_startup() -> Result<(), &'static str> {
    let Some(mut journal) = load_root_journal()? else {
        return Ok(());
    };
    if journal.is_terminal() {
        return journal
            .permits_helper_startup()
            .then_some(())
            .ok_or("maintenance-recovery-required");
    }
    if journal.commit_point < MaintenanceCommitPoint::EnrollmentCommitted {
        return Err("maintenance-recovery-required");
    }
    let artifacts = journal
        .artifacts
        .new
        .as_ref()
        .ok_or("maintenance-recovery-required")?;
    for (path, mode, digest) in [
        (
            crate::DEV_TUN_SERVICE_HELPER_PATH,
            0o555,
            artifacts.helper_sha256.as_str(),
        ),
        (
            crate::DEV_TUN_SERVICE_CORE_PATH,
            0o555,
            artifacts.core_sha256.as_str(),
        ),
        (
            crate::DEV_TUN_SERVICE_PLIST_PATH,
            0o644,
            artifacts.plist_sha256.as_str(),
        ),
    ] {
        validate_root_file(Path::new(path), mode)?;
        if sha256_file(Path::new(path))? != digest {
            return Err("maintenance-recovery-required");
        }
    }
    let enrollment: StartupEnrollment = read_root_json(
        Path::new(crate::DEV_TUN_SERVICE_ENROLLMENT_PATH),
        0o600,
        16 * 1024,
    )?;
    if enrollment.schema_version != 1
        || enrollment.algorithm != crate::DEV_TUN_INSTALLATION_KEY_ALGORITHM
        || enrollment.public_key_spki.is_empty()
        || enrollment.installing_uid != journal.intent.installing_uid
        || Some(enrollment.generation) != journal.identity.new_generation
        || Some(enrollment.helper_installation_id) != journal.identity.new_installation_id
        || Some(enrollment.key_id) != journal.identity.new_key_id
    {
        return Err("maintenance-recovery-required");
    }
    let receipt: StartupReceipt =
        read_root_json(Path::new(INTERNAL_TUN_ROOT_RECEIPT_PATH), 0o444, 16 * 1024)?;
    if !matches!(receipt.schema_version, 1 | 2)
        || receipt.profile != "internal-tun-alpha"
        || receipt.protocol_version != mish_runtime::TUN_HELPER_PROTOCOL_VERSION
        || receipt.helper_version != mish_runtime::TUN_HELPER_EXPECTED_VERSION
        || receipt.core_version.is_empty()
        || (receipt.schema_version == 2
            && receipt.application_sha256.as_deref() != Some(artifacts.application_sha256.as_str()))
        || receipt.installing_uid != journal.intent.installing_uid
        || receipt.manifest_sha256 != artifacts.manifest_sha256
        || receipt.package_version != artifacts.package_version
        || receipt.helper_sha256 != artifacts.helper_sha256
        || receipt.core_sha256 != artifacts.core_sha256
        || receipt.plist_sha256 != artifacts.plist_sha256
        || receipt.installation_id
            != journal
                .identity
                .new_installation_id
                .as_deref()
                .unwrap_or("")
        || receipt.key_id != journal.identity.new_key_id.as_deref().unwrap_or("")
        || Some(receipt.generation) != journal.identity.new_generation
    {
        return Err("maintenance-recovery-required");
    }
    journal.commit_point = MaintenanceCommitPoint::Verified;
    journal.terminal = Some(MaintenanceTerminal {
        code: "committed".into(),
        outcome: MaintenanceTerminalOutcome::Committed,
    });
    write_root_journal(&journal)
}

const INTERNAL_TUN_ROOT_RECEIPT_PATH: &str =
    "/Library/Application Support/com.asuka109.mish/internal-tun-alpha/receipt.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupEnrollment {
    algorithm: String,
    generation: u64,
    helper_installation_id: String,
    installing_uid: u32,
    key_id: String,
    public_key_spki: String,
    schema_version: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupReceipt {
    #[serde(default)]
    application_sha256: Option<String>,
    core_sha256: String,
    core_version: String,
    generation: u64,
    helper_sha256: String,
    helper_version: String,
    installation_id: String,
    installing_uid: u32,
    key_id: String,
    manifest_sha256: String,
    package_version: String,
    plist_sha256: String,
    profile: String,
    protocol_version: u16,
    schema_version: u16,
}

fn load_root_journal() -> Result<Option<InternalTunMaintenanceJournal>, &'static str> {
    let path = Path::new(INTERNAL_TUN_MAINTENANCE_JOURNAL_PATH);
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let journal: InternalTunMaintenanceJournal =
                read_root_json(path, 0o444, INTERNAL_TUN_MAINTENANCE_JOURNAL_MAX_BYTES)?;
            journal.validate()?;
            Ok(Some(journal))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("maintenance-journal-unavailable"),
    }
}

fn read_root_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    mode: u32,
    maximum_size: u64,
) -> Result<T, &'static str> {
    validate_root_file(path, mode)?;
    let mut bytes = Vec::new();
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .and_then(|file| file.take(maximum_size + 1).read_to_end(&mut bytes))
        .map_err(|_| "maintenance-root-record-unavailable")?;
    if bytes.len() as u64 > maximum_size {
        return Err("maintenance-root-record-size-rejected");
    }
    serde_json::from_slice(&bytes).map_err(|_| "maintenance-root-record-invalid")
}

fn validate_root_file(path: &Path, mode: u32) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "maintenance-root-record-unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o777 != mode
    {
        return Err("maintenance-root-record-metadata-rejected");
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, &'static str> {
    let mut file = File::open(path).map_err(|_| "maintenance-artifact-unavailable")?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "maintenance-artifact-unavailable")?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_root_journal(journal: &InternalTunMaintenanceJournal) -> Result<(), &'static str> {
    journal.validate()?;
    let bytes = serde_json::to_vec(journal).map_err(|_| "maintenance-journal-invalid")?;
    if bytes.len() as u64 > INTERNAL_TUN_MAINTENANCE_JOURNAL_MAX_BYTES {
        return Err("maintenance-journal-size-rejected");
    }
    let root = Path::new(INTERNAL_TUN_MAINTENANCE_ROOT);
    let root_metadata = fs::symlink_metadata(root).map_err(|_| "maintenance-root-unavailable")?;
    if root_metadata.file_type().is_symlink()
        || !root_metadata.is_dir()
        || root_metadata.uid() != 0
        || root_metadata.gid() != 0
        || root_metadata.permissions().mode() & 0o022 != 0
    {
        return Err("maintenance-root-metadata-rejected");
    }
    let temporary = root.join(format!(".maintenance-helper.{}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o444)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| "maintenance-journal-create-failed")?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|_| "maintenance-journal-write-failed")?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o444))
            .map_err(|_| "maintenance-journal-permissions-failed")?;
        fs::rename(&temporary, INTERNAL_TUN_MAINTENANCE_JOURNAL_PATH)
            .map_err(|_| "maintenance-journal-commit-failed")?;
        File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "maintenance-journal-sync-failed")
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn compare_internal_tun_package_versions(
    candidate: &str,
    installed: &str,
) -> Result<Ordering, &'static str> {
    let candidate = parse_internal_tun_package_version(candidate)?;
    let installed = parse_internal_tun_package_version(installed)?;
    Ok(candidate.cmp(&installed))
}

fn parse_internal_tun_package_version(value: &str) -> Result<(u64, u64, u64, u64), &'static str> {
    let (version, revision) = value
        .split_once("-internal-tun-alpha.")
        .ok_or("internal-tun-package-version-invalid")?;
    let mut components = version.split('.');
    let major = parse_version_number(components.next())?;
    let minor = parse_version_number(components.next())?;
    let patch = parse_version_number(components.next())?;
    if components.next().is_some() {
        return Err("internal-tun-package-version-invalid");
    }
    let revision = parse_version_number(Some(revision))?;
    Ok((major, minor, patch, revision))
}

fn parse_version_number(value: Option<&str>) -> Result<u64, &'static str> {
    let value = value.ok_or("internal-tun-package-version-invalid")?;
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("internal-tun-package-version-invalid");
    }
    value
        .parse()
        .map_err(|_| "internal-tun-package-version-invalid")
}

pub fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_optional_digest(value: Option<&str>) -> bool {
    value.is_none_or(valid_digest)
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn valid_artifacts(value: &ArtifactDigestSet) -> bool {
    valid_digest(&value.application_sha256)
        && valid_digest(&value.core_sha256)
        && valid_digest(&value.helper_sha256)
        && valid_digest(&value.manifest_sha256)
        && valid_digest(&value.plist_sha256)
        && !value.package_version.is_empty()
        && value.package_version.len() <= 64
}

fn valid_observation(value: &TunNetworkObservation) -> bool {
    value.schema_version == mish_runtime::TUN_OBSERVATION_SCHEMA_VERSION
        && [value.core, value.dns, value.interface, value.routes]
            .iter()
            .all(|component| {
                matches!(
                    component,
                    TunObservationComponentState::Absent
                        | TunObservationComponentState::Confirmed
                        | TunObservationComponentState::Foreign
                        | TunObservationComponentState::Partial
                        | TunObservationComponentState::Unknown
                )
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(character: char) -> String {
        character.to_string().repeat(64)
    }

    fn artifacts(character: char, version: &str) -> ArtifactDigestSet {
        ArtifactDigestSet {
            application_sha256: digest(character),
            core_sha256: digest(character),
            helper_sha256: digest(character),
            manifest_sha256: digest(character),
            package_version: version.into(),
            plist_sha256: digest(character),
        }
    }

    fn journal(commit_point: MaintenanceCommitPoint) -> InternalTunMaintenanceJournal {
        InternalTunMaintenanceJournal {
            artifacts: MaintenanceArtifactEvidence {
                new: Some(artifacts('b', "0.1.0-internal-tun-alpha.6")),
                old: Some(artifacts('a', "0.1.0-internal-tun-alpha.5")),
            },
            capture: MaintenanceCaptureEvidence {
                accepted_operation_id: "maintenance:operation-a:disable".into(),
                after: TunNetworkObservation::disabled(2),
                before: TunNetworkObservation::enabled(1),
                core_was_running: true,
                network_ownership_record_sha256: Some(digest('c')),
                restore_capture_on_app_start: true,
            },
            commit_point,
            compensation: MaintenanceCompensation::default(),
            identity: MaintenanceIdentityEvidence {
                enrollment_transition: EnrollmentTransition::AdministratorAuthorizedRebind,
                new_generation: Some(1),
                new_installation_id: Some(digest('b')),
                new_key_id: Some(digest('d')),
                old_generation: Some(1),
                old_installation_id: Some(digest('a')),
                old_key_id: Some(digest('d')),
                package_manifest_sha256: digest('b'),
                service_label: "com.asuka109.mish.tun-helper.dev".into(),
            },
            intent: MaintenanceIntent {
                admitted_revision: 1,
                installing_uid: 501,
                kind: MaintenanceKind::Repair,
                operation_id: "operation-a".into(),
                requested_manifest_sha256: digest('b'),
                requested_package_version: "0.1.0-internal-tun-alpha.6".into(),
            },
            schema_version: INTERNAL_TUN_MAINTENANCE_JOURNAL_SCHEMA_VERSION,
            terminal: None,
        }
    }

    #[test]
    fn journal_shape_excludes_private_or_raw_configuration_material() {
        let serialized = serde_json::to_string(&journal(MaintenanceCommitPoint::IntentPersisted))
            .expect("journal must serialize");
        for forbidden in [
            "privateKey",
            "private_key",
            "profile",
            "configFile",
            "config_file",
            "nameserver",
            "proxyPassword",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn package_version_order_is_closed_and_deterministic() {
        assert_eq!(
            compare_internal_tun_package_versions(
                "0.1.0-internal-tun-alpha.4",
                "0.1.0-internal-tun-alpha.4"
            ),
            Ok(Ordering::Equal)
        );
        assert_eq!(
            compare_internal_tun_package_versions(
                "0.1.0-internal-tun-alpha.6",
                "0.1.0-internal-tun-alpha.5"
            ),
            Ok(Ordering::Greater)
        );
        assert_eq!(
            compare_internal_tun_package_versions(
                "0.1.0-internal-tun-alpha.3",
                "0.1.0-internal-tun-alpha.4"
            ),
            Ok(Ordering::Less)
        );
        for invalid in [
            "0.1.0",
            "0.1.0-internal-tun-alpha.04",
            "v0.1.0-internal-tun-alpha.4",
            "0.1-internal-tun-alpha.4",
            "",
        ] {
            assert!(compare_internal_tun_package_versions(invalid, invalid).is_err());
        }
    }

    #[test]
    fn every_pre_enrollment_crash_boundary_compensates_only_with_dual_old_proof() {
        for boundary in [
            MaintenanceCommitPoint::IntentPersisted,
            MaintenanceCommitPoint::CaptureReconciled,
            MaintenanceCommitPoint::PriorArtifactsBackedUp,
            MaintenanceCommitPoint::PriorServiceDetached,
            MaintenanceCommitPoint::HelperReplaced,
            MaintenanceCommitPoint::CoreReplaced,
        ] {
            assert_eq!(
                decide_recovery(
                    &journal(boundary),
                    RecoveryObservation {
                        enrollment_matches_new: false,
                        enrollment_matches_old: true,
                        network_confirmed_disabled: true,
                        new_artifacts_verified: false,
                        old_artifacts_verified: true,
                    }
                ),
                RecoveryDecision::Compensate,
                "boundary {boundary:?}"
            );
        }
    }

    #[test]
    fn every_post_enrollment_crash_boundary_completes_only_with_dual_new_proof() {
        for boundary in [
            MaintenanceCommitPoint::EnrollmentCommitted,
            MaintenanceCommitPoint::ReceiptCommitted,
            MaintenanceCommitPoint::LaunchDaemonCommitted,
            MaintenanceCommitPoint::ServiceStarted,
        ] {
            assert_eq!(
                decide_recovery(
                    &journal(boundary),
                    RecoveryObservation {
                        enrollment_matches_new: true,
                        enrollment_matches_old: false,
                        network_confirmed_disabled: true,
                        new_artifacts_verified: true,
                        old_artifacts_verified: false,
                    }
                ),
                RecoveryDecision::CompleteCommit,
                "boundary {boundary:?}"
            );
        }
    }

    #[test]
    fn unknown_authority_never_guesses_or_replays() {
        for observation in [
            RecoveryObservation {
                enrollment_matches_new: false,
                enrollment_matches_old: false,
                network_confirmed_disabled: true,
                new_artifacts_verified: false,
                old_artifacts_verified: false,
            },
            RecoveryObservation {
                enrollment_matches_new: true,
                enrollment_matches_old: false,
                network_confirmed_disabled: false,
                new_artifacts_verified: true,
                old_artifacts_verified: false,
            },
            RecoveryObservation {
                enrollment_matches_new: false,
                enrollment_matches_old: true,
                network_confirmed_disabled: false,
                new_artifacts_verified: false,
                old_artifacts_verified: true,
            },
        ] {
            assert_eq!(
                decide_recovery(
                    &journal(MaintenanceCommitPoint::EnrollmentCommitted),
                    observation
                ),
                RecoveryDecision::RecoveryRequired
            );
        }
    }

    #[test]
    fn stale_duplicate_and_equal_revision_completion_are_not_new_authority() {
        let current = journal(MaintenanceCommitPoint::ReceiptCommitted);
        for admitted_revision in [0, 1] {
            let mut replacement = current.clone();
            replacement.intent.admitted_revision = admitted_revision;
            replacement.intent.operation_id = if admitted_revision == 1 {
                "equal-revision-replacement".into()
            } else {
                "stale-replacement".into()
            };
            let accepted = replacement.intent.admitted_revision > current.intent.admitted_revision;
            assert!(!accepted);
        }
        let mut duplicate = current.clone();
        duplicate.terminal = Some(MaintenanceTerminal {
            code: "committed".into(),
            outcome: MaintenanceTerminalOutcome::Committed,
        });
        duplicate.commit_point = MaintenanceCommitPoint::Verified;
        assert_eq!(
            decide_recovery(
                &duplicate,
                RecoveryObservation {
                    enrollment_matches_new: true,
                    enrollment_matches_old: false,
                    network_confirmed_disabled: true,
                    new_artifacts_verified: true,
                    old_artifacts_verified: false,
                }
            ),
            RecoveryDecision::AlreadyTerminal
        );
    }

    #[test]
    fn cancellation_abort_panic_and_cleanup_failure_remain_typed_compensation() {
        for reason in [
            "administrator-cancelled",
            "effect-aborted",
            "effect-panicked",
            "cleanup-failed",
            "copy-interrupted",
            "disk-full",
            "permission-denied",
            "core-exit",
            "helper-exit",
        ] {
            let mut failed = journal(MaintenanceCommitPoint::PriorServiceDetached);
            failed.compensation = MaintenanceCompensation {
                artifacts: CompensationState::Pending,
                cleanup: CompensationState::Pending,
                enrollment: CompensationState::Pending,
                network: CompensationState::Restored,
                reason: Some(reason.into()),
            };
            failed
                .validate()
                .expect("typed failure journal must remain valid");
            assert_eq!(
                decide_recovery(
                    &failed,
                    RecoveryObservation {
                        enrollment_matches_new: false,
                        enrollment_matches_old: true,
                        network_confirmed_disabled: true,
                        new_artifacts_verified: false,
                        old_artifacts_verified: true,
                    }
                ),
                RecoveryDecision::Compensate
            );
        }
    }
}
