#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use mish_profile::{
    FileProfileRepository, Fingerprint, NORMALIZED_ARTIFACT_SCHEMA_VERSION,
    PROFILE_PATCH_SCHEMA_VERSION, PROFILE_SCHEMA_VERSION, ProfileId, ProfileMetadata,
    ProfilePatchSet, ProfileRecord, ProfileRefreshPolicy, ProfileRefreshState, ProfileSource,
    ProfileSourceType, RepositoryError, RevisionId, Timestamp,
};
use mish_settings::{
    FileSettingsRepository, SettingsAdapterKind, SettingsPreferences, SettingsRepository,
    SettingsService,
};
use mish_state_authority::{StateMutationAuthority, StateMutationPermit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const LOCAL_BACKUP_FORMAT_VERSION: u32 = 1;
pub const LOCAL_BACKUP_MAX_BYTES: usize = 8 * 1_024 * 1_024;
const LOCAL_BACKUP_MAX_PROFILES: usize = 128;
const RESTORE_JOURNAL_FILE: &str = ".restore-journal.json";
const RESTORE_JOURNAL_VERSION: u32 = 1;
const RESTORE_JOURNAL_MAX_BYTES: u64 = 32_768;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalBackupScope {
    pub patches: bool,
    pub profiles: bool,
    pub schedules: bool,
    pub settings: bool,
    pub source_locators: bool,
}

impl LocalBackupScope {
    fn validate(self) -> Result<(), LocalBackupError> {
        if !self.patches && !self.profiles && !self.schedules && !self.settings {
            return Err(LocalBackupError::InvalidScope);
        }
        if self.source_locators && !self.profiles {
            return Err(LocalBackupError::InvalidScope);
        }
        Ok(())
    }

    const fn touches_profiles(self) -> bool {
        self.patches || self.profiles || self.schedules
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupPreview {
    pub content_bytes: usize,
    pub excluded_sensitive_data: Vec<LocalBackupSensitiveData>,
    pub file_type: &'static str,
    pub format_version: u32,
    pub included: LocalBackupIncludedCounts,
    pub included_sensitive_data: Vec<LocalBackupSensitiveData>,
    pub max_bytes: usize,
    pub preview_id: String,
    pub scope: LocalBackupScope,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalBackupSensitiveData {
    CredentialsAndProfileContents,
    SubscriptionUrlsAndFullPaths,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupIncludedCounts {
    pub patches: usize,
    pub profiles: usize,
    pub schedules: usize,
    pub settings: usize,
}

#[derive(Clone, Debug)]
pub struct PreparedLocalBackup {
    pub bytes: Vec<u8>,
    pub preview: LocalBackupPreview,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum LocalRestoreConflictResolution {
    KeepExisting,
    UseBackup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalRestoreConflictKind {
    ActiveProfile,
    DuplicateFingerprint,
    IdMismatch,
    MissingProfile,
    RevisionMismatch,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRestoreConflict {
    pub backup_fingerprint: String,
    pub backup_revision: String,
    pub current_fingerprint: Option<String>,
    pub current_revision: Option<String>,
    pub kind: LocalRestoreConflictKind,
    pub label: String,
    pub profile_id: String,
    pub replace_allowed: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRestoreActionCounts {
    pub add: usize,
    pub replace: usize,
    pub skip: usize,
    pub update: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRestorePreview {
    pub actions: LocalRestoreActionCounts,
    pub conflicts: Vec<LocalRestoreConflict>,
    pub content_bytes: usize,
    pub file_type: &'static str,
    pub format_version: u32,
    pub included: LocalBackupIncludedCounts,
    pub excluded_sensitive_data: Vec<LocalBackupSensitiveData>,
    pub included_sensitive_data: Vec<LocalBackupSensitiveData>,
    pub max_bytes: usize,
    pub preview_id: String,
    pub scope: LocalBackupScope,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRestoreResult {
    pub applied: LocalRestoreActionCounts,
    pub settings_snapshot: mish_settings::SettingsSnapshot,
}

#[derive(Clone, Debug)]
pub struct PreparedLocalRestore {
    manifest: LocalBackupManifest,
    pub preview: LocalRestorePreview,
    state_digest: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum LocalBackupError {
    #[error("the local backup scope is invalid")]
    InvalidScope,
    #[error("the local backup manifest is invalid")]
    InvalidManifest,
    #[error("the local backup format is unsupported")]
    UnsupportedVersion,
    #[error("the local backup exceeded its fixed size limit")]
    SizeLimitExceeded,
    #[error("local backup storage is unavailable")]
    Storage,
    #[error("local state changed after the restore preview")]
    StateChanged,
    #[error("another Profile or Settings mutation is in progress")]
    Busy,
    #[error("local restore requires startup recovery before state can be used")]
    RecoveryRequired,
}

#[derive(Clone)]
pub struct LocalBackupService {
    application_version: &'static str,
    authority: StateMutationAuthority,
    root: PathBuf,
    settings: Arc<SettingsService>,
}

impl LocalBackupService {
    pub fn recover_pending(root: &Path) -> Result<(), LocalBackupError> {
        RestoreTransaction::recover(root)
    }

    pub fn new(
        root: PathBuf,
        settings: Arc<SettingsService>,
        application_version: &'static str,
    ) -> Self {
        Self {
            application_version,
            authority: settings.mutation_authority(),
            root,
            settings,
        }
    }

    pub fn prepare_export(
        &self,
        preview_id: String,
        scope: LocalBackupScope,
        created_at: u64,
    ) -> Result<PreparedLocalBackup, LocalBackupError> {
        let _permit = self
            .authority
            .try_acquire()
            .map_err(|_| LocalBackupError::Busy)?;
        scope.validate()?;
        let repository = FileProfileRepository::new(self.root.join("profile-store"));
        let mut entries = Vec::new();
        if scope.touches_profiles() {
            let metadata = repository.list_metadata().map_err(map_repository_error)?;
            if metadata.len() > LOCAL_BACKUP_MAX_PROFILES {
                return Err(LocalBackupError::SizeLimitExceeded);
            }
            for metadata in metadata {
                let record = repository
                    .load(&metadata.id)
                    .map_err(map_repository_error)?;
                entries.push(export_profile(record, scope));
            }
        }

        let manifest = LocalBackupManifest {
            created_at,
            format_version: LOCAL_BACKUP_FORMAT_VERSION,
            producer: LocalBackupProducer {
                application: "Mish".to_owned(),
                application_version: self.application_version.to_owned(),
            },
            profiles: entries,
            schema_versions: LocalBackupSchemaVersions {
                normalized_artifact: NORMALIZED_ARTIFACT_SCHEMA_VERSION,
                patches: PROFILE_PATCH_SCHEMA_VERSION,
                profile: PROFILE_SCHEMA_VERSION,
                settings: 3,
            },
            scope,
            settings: scope
                .settings
                .then(|| self.settings.snapshot(SettingsAdapterKind::Rpc).preferences),
        };
        validate_manifest(&manifest)?;
        let bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|_| LocalBackupError::InvalidManifest)?;
        if bytes.len() > LOCAL_BACKUP_MAX_BYTES {
            return Err(LocalBackupError::SizeLimitExceeded);
        }
        let included = included_counts(&manifest);
        Ok(PreparedLocalBackup {
            preview: LocalBackupPreview {
                content_bytes: bytes.len(),
                excluded_sensitive_data: sensitive_data(false, scope),
                file_type: "application/json",
                format_version: LOCAL_BACKUP_FORMAT_VERSION,
                included,
                included_sensitive_data: sensitive_data(true, scope),
                max_bytes: LOCAL_BACKUP_MAX_BYTES,
                preview_id,
                scope,
            },
            bytes,
        })
    }

    pub fn prepare_restore(
        &self,
        preview_id: String,
        bytes: &[u8],
        active_profile_id: Option<&str>,
    ) -> Result<PreparedLocalRestore, LocalBackupError> {
        let permit = self.try_begin_restore()?;
        self.prepare_restore_authorized(&permit, preview_id, bytes, active_profile_id)
    }

    pub fn prepare_restore_authorized(
        &self,
        permit: &StateMutationPermit,
        preview_id: String,
        bytes: &[u8],
        active_profile_id: Option<&str>,
    ) -> Result<PreparedLocalRestore, LocalBackupError> {
        self.authority
            .validate(permit)
            .map_err(|_| LocalBackupError::Busy)?;
        if bytes.len() > LOCAL_BACKUP_MAX_BYTES {
            return Err(LocalBackupError::SizeLimitExceeded);
        }
        let manifest: LocalBackupManifest =
            serde_json::from_slice(bytes).map_err(|_| LocalBackupError::InvalidManifest)?;
        validate_manifest(&manifest)?;
        let (actions, conflicts) = self.restore_plan(&manifest, active_profile_id)?;
        let state_digest = self.state_digest(active_profile_id)?;
        Ok(PreparedLocalRestore {
            preview: LocalRestorePreview {
                actions,
                conflicts,
                content_bytes: bytes.len(),
                file_type: "application/json",
                format_version: manifest.format_version,
                included: included_counts(&manifest),
                excluded_sensitive_data: sensitive_data(false, manifest.scope),
                included_sensitive_data: sensitive_data(true, manifest.scope),
                max_bytes: LOCAL_BACKUP_MAX_BYTES,
                preview_id,
                scope: manifest.scope,
            },
            manifest,
            state_digest,
        })
    }

    pub fn try_begin_restore(&self) -> Result<StateMutationPermit, LocalBackupError> {
        self.authority
            .try_acquire()
            .map_err(|_| LocalBackupError::Busy)
    }

    pub fn commit_restore(
        &self,
        prepared: PreparedLocalRestore,
        resolution: LocalRestoreConflictResolution,
        restored_at: u64,
        active_profile_id: Option<&str>,
    ) -> Result<LocalRestoreResult, LocalBackupError> {
        let permit = self.try_begin_restore()?;
        self.commit_restore_authorized(
            &permit,
            prepared,
            resolution,
            restored_at,
            active_profile_id,
        )
    }

    pub fn commit_restore_authorized(
        &self,
        permit: &StateMutationPermit,
        prepared: PreparedLocalRestore,
        resolution: LocalRestoreConflictResolution,
        restored_at: u64,
        active_profile_id: Option<&str>,
    ) -> Result<LocalRestoreResult, LocalBackupError> {
        self.authority
            .validate(permit)
            .map_err(|_| LocalBackupError::Busy)?;
        if self.state_digest(active_profile_id)? != prepared.state_digest {
            return Err(LocalBackupError::StateChanged);
        }
        let repository = FileProfileRepository::new(self.root.join("profile-store"));
        let mut desired = BTreeMap::new();
        for metadata in repository.list_metadata().map_err(map_repository_error)? {
            let record = repository
                .load(&metadata.id)
                .map_err(map_repository_error)?;
            desired.insert(metadata.id.as_str().to_owned(), record);
        }

        let mut applied = LocalRestoreActionCounts::default();
        if prepared.manifest.scope.touches_profiles() {
            let context = RestoreApplyContext {
                active_profile_id,
                resolution,
                restored_at,
                root: &self.root,
                scope: prepared.manifest.scope,
            };
            for entry in &prepared.manifest.profiles {
                apply_restore_entry(&mut desired, entry, &context, &mut applied)?;
            }
        }

        let transaction = match RestoreTransaction::stage(
            &self.root,
            prepared
                .manifest
                .scope
                .touches_profiles()
                .then_some(desired),
            prepared.manifest.settings,
        ) {
            Ok(transaction) => transaction,
            Err(error) => {
                if error == LocalBackupError::RecoveryRequired {
                    self.authority.make_unavailable_until_restart();
                }
                return Err(error);
            }
        };
        if let Err(error) = transaction.commit() {
            if error == LocalBackupError::RecoveryRequired {
                self.authority.make_unavailable_until_restart();
            }
            return Err(error);
        }
        if prepared.manifest.scope.touches_profiles() {
            self.materialize_profile_directory()?;
        }
        if let Some(preferences) = prepared.manifest.settings {
            self.settings
                .accept_restored_preferences_authorized(permit, preferences)
                .map_err(|_| LocalBackupError::Busy)?;
        }
        if prepared.manifest.scope.settings {
            applied.update += 1;
        }
        Ok(LocalRestoreResult {
            applied,
            settings_snapshot: self.settings.snapshot(SettingsAdapterKind::Rpc),
        })
    }

    fn materialize_profile_directory(&self) -> Result<(), LocalBackupError> {
        let directory = self.root.join("profiles");
        create_private_restore_dir(&directory)?;
        for entry in fs::read_dir(&directory).map_err(|_| LocalBackupError::Storage)? {
            let path = entry.map_err(|_| LocalBackupError::Storage)?.path();
            if matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("yaml" | "yml")
            ) {
                fs::remove_file(path).map_err(|_| LocalBackupError::Storage)?;
            }
        }
        let repository = FileProfileRepository::new(self.root.join("profile-store"));
        let writer = StdRestoreFilesystem;
        for metadata in repository.list_metadata().map_err(map_repository_error)? {
            let record = repository
                .load(&metadata.id)
                .map_err(map_repository_error)?;
            let file_name = materialized_profile_file_name(&record)?;
            writer
                .write_private_atomic(&directory.join(file_name), &record.source_bytes)
                .map_err(map_restore_failure)?;
        }
        Ok(())
    }

    fn restore_plan(
        &self,
        manifest: &LocalBackupManifest,
        active_profile_id: Option<&str>,
    ) -> Result<(LocalRestoreActionCounts, Vec<LocalRestoreConflict>), LocalBackupError> {
        let repository = FileProfileRepository::new(self.root.join("profile-store"));
        let metadata = repository.list_metadata().map_err(map_repository_error)?;
        let by_id = metadata
            .iter()
            .map(|metadata| (metadata.id.as_str(), metadata))
            .collect::<BTreeMap<_, _>>();
        let mut actions = LocalRestoreActionCounts::default();
        let mut conflicts = Vec::new();

        for entry in &manifest.profiles {
            let current = by_id.get(entry.id.as_str()).copied();
            let duplicate = metadata.iter().find(|metadata| {
                metadata.id != entry.id
                    && metadata.revision.id == entry.revision
                    && metadata.artifact.fingerprint == entry.fingerprint
            });
            let conflict = profile_conflict(entry, current, duplicate, active_profile_id);
            if let Some(conflict) = conflict {
                actions.skip += 1;
                conflicts.push(conflict);
            } else if entry.profile.is_some() {
                if current.is_some() {
                    actions.replace += 1;
                } else {
                    actions.add += 1;
                }
            } else {
                actions.update += 1;
            }
        }
        if manifest.scope.settings {
            actions.update += 1;
        }
        Ok((actions, conflicts))
    }

    fn state_digest(&self, active_profile_id: Option<&str>) -> Result<String, LocalBackupError> {
        let repository = FileProfileRepository::new(self.root.join("profile-store"));
        let mut hasher = Sha256::new();
        for metadata in repository.list_metadata().map_err(map_repository_error)? {
            let record = repository
                .load(&metadata.id)
                .map_err(map_repository_error)?;
            update_digest(&mut hasher, &record.metadata)?;
            update_digest(&mut hasher, &record.source)?;
            hasher.update(&record.source_bytes);
            hasher.update(&record.normalized_bytes);
            update_digest(&mut hasher, &record.patches)?;
        }
        update_digest(
            &mut hasher,
            &self.settings.snapshot(SettingsAdapterKind::Rpc).preferences,
        )?;
        update_digest(&mut hasher, &active_profile_id)?;
        Ok(format!("{:x}", hasher.finalize()))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalBackupManifest {
    created_at: u64,
    format_version: u32,
    producer: LocalBackupProducer,
    profiles: Vec<LocalBackupProfile>,
    schema_versions: LocalBackupSchemaVersions,
    scope: LocalBackupScope,
    settings: Option<SettingsPreferences>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalBackupProducer {
    application: String,
    application_version: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalBackupSchemaVersions {
    normalized_artifact: u32,
    patches: u32,
    profile: u32,
    settings: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalBackupProfile {
    fingerprint: Fingerprint,
    id: ProfileId,
    label: String,
    patches: Option<ProfilePatchSet>,
    profile: Option<LocalBackupProfileContent>,
    revision: RevisionId,
    schedule: Option<ProfileRefreshPolicy>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalBackupProfileContent {
    metadata: ProfileMetadata,
    normalized_bytes_base64: String,
    source: LocalBackupProfileSource,
    source_bytes_base64: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum LocalBackupProfileSource {
    Embedded,
    Https { url: String },
    LocalFile { path: PathBuf },
}

fn export_profile(mut record: ProfileRecord, scope: LocalBackupScope) -> LocalBackupProfile {
    let id = record.metadata.id.clone();
    let label = record.metadata.label.clone();
    let revision = record.metadata.revision.id.clone();
    let fingerprint = record.metadata.artifact.fingerprint.clone();
    let schedule = scope.schedules.then_some(record.metadata.refresh.policy);
    let patches = scope.patches.then_some(record.patches.clone());
    let profile = scope.profiles.then(|| {
        record.metadata.last_attempt = None;
        record.metadata.last_success = None;
        record.metadata.refresh = ProfileRefreshState::default();
        record.metadata.status.active = false;
        record.metadata.status.error = false;
        record.metadata.status.stale = false;
        record.metadata.status.updating = false;
        let source = if scope.source_locators {
            match &record.source {
                ProfileSource::Https { url } => LocalBackupProfileSource::Https {
                    url: url.expose().to_owned(),
                },
                ProfileSource::LocalFile { path } => LocalBackupProfileSource::LocalFile {
                    path: path.expose().to_path_buf(),
                },
            }
        } else {
            LocalBackupProfileSource::Embedded
        };
        LocalBackupProfileContent {
            metadata: record.metadata,
            normalized_bytes_base64: BASE64.encode(record.normalized_bytes),
            source,
            source_bytes_base64: BASE64.encode(record.source_bytes),
        }
    });
    LocalBackupProfile {
        fingerprint,
        id,
        label,
        patches,
        profile,
        revision,
        schedule,
    }
}

fn validate_manifest(manifest: &LocalBackupManifest) -> Result<(), LocalBackupError> {
    if manifest.format_version != LOCAL_BACKUP_FORMAT_VERSION
        || manifest.schema_versions.profile != PROFILE_SCHEMA_VERSION
        || manifest.schema_versions.normalized_artifact != NORMALIZED_ARTIFACT_SCHEMA_VERSION
        || manifest.schema_versions.patches != PROFILE_PATCH_SCHEMA_VERSION
        || manifest.schema_versions.settings != 3
    {
        return Err(LocalBackupError::UnsupportedVersion);
    }
    manifest.scope.validate()?;
    if manifest.producer.application != "Mish"
        || manifest.producer.application_version.is_empty()
        || manifest.producer.application_version.len() > 64
        || manifest.profiles.len() > LOCAL_BACKUP_MAX_PROFILES
        || manifest.scope.settings != manifest.settings.is_some()
        || (!manifest.scope.touches_profiles() && !manifest.profiles.is_empty())
    {
        return Err(LocalBackupError::InvalidManifest);
    }
    let mut ids = HashSet::new();
    for entry in &manifest.profiles {
        if !ids.insert(entry.id.as_str())
            || entry.label.trim().is_empty()
            || entry.label.len() > 256
            || manifest.scope.profiles != entry.profile.is_some()
            || manifest.scope.patches != entry.patches.is_some()
            || manifest.scope.schedules != entry.schedule.is_some()
        {
            return Err(LocalBackupError::InvalidManifest);
        }
        let Some(content) = &entry.profile else {
            continue;
        };
        if matches!(content.source, LocalBackupProfileSource::Embedded)
            == manifest.scope.source_locators
        {
            return Err(LocalBackupError::InvalidManifest);
        }
        let source_bytes = decode_bounded(&content.source_bytes_base64)?;
        let normalized_bytes = decode_bounded(&content.normalized_bytes_base64)?;
        if RevisionId::from_source(&source_bytes) != entry.revision
            || Fingerprint::from_normalized_artifact(&normalized_bytes) != entry.fingerprint
            || content.metadata.id != entry.id
            || content.metadata.revision.id != entry.revision
            || content.metadata.artifact.fingerprint != entry.fingerprint
            || content.metadata.status.active
            || content.metadata.status.updating
        {
            return Err(LocalBackupError::InvalidManifest);
        }
        validate_source(&content.source)?;
        if let Some(patches) = &entry.patches
            && !patches.is_bound_to(&entry.revision, &entry.fingerprint)
        {
            return Err(LocalBackupError::InvalidManifest);
        }
    }
    Ok(())
}

fn validate_source(source: &LocalBackupProfileSource) -> Result<(), LocalBackupError> {
    match source {
        LocalBackupProfileSource::Embedded => Ok(()),
        LocalBackupProfileSource::Https { url } => ProfileSource::https(url)
            .map(|_| ())
            .map_err(|_| LocalBackupError::InvalidManifest),
        LocalBackupProfileSource::LocalFile { path } => ProfileSource::local_file(path.clone())
            .map(|_| ())
            .map_err(|_| LocalBackupError::InvalidManifest),
    }
}

fn decode_bounded(value: &str) -> Result<Vec<u8>, LocalBackupError> {
    if value.len() > LOCAL_BACKUP_MAX_BYTES.saturating_mul(4) / 3 + 4 {
        return Err(LocalBackupError::SizeLimitExceeded);
    }
    BASE64
        .decode(value)
        .map_err(|_| LocalBackupError::InvalidManifest)
}

fn profile_conflict(
    entry: &LocalBackupProfile,
    current: Option<&ProfileMetadata>,
    duplicate: Option<&ProfileMetadata>,
    active_profile_id: Option<&str>,
) -> Option<LocalRestoreConflict> {
    let (kind, conflicting, replace_allowed) = if let Some(current) = current {
        if current.status.active || active_profile_id == Some(current.id.as_str()) {
            (
                LocalRestoreConflictKind::ActiveProfile,
                Some(current),
                false,
            )
        } else if current.revision.id != entry.revision
            || current.artifact.fingerprint != entry.fingerprint
        {
            (
                if entry.profile.is_some() {
                    LocalRestoreConflictKind::IdMismatch
                } else {
                    LocalRestoreConflictKind::RevisionMismatch
                },
                Some(current),
                entry.profile.is_some(),
            )
        } else {
            let duplicate = duplicate?;
            let replace_allowed = entry.profile.is_some()
                && active_profile_id != Some(duplicate.id.as_str())
                && !duplicate.status.active;
            (
                LocalRestoreConflictKind::DuplicateFingerprint,
                Some(duplicate),
                replace_allowed,
            )
        }
    } else if let Some(duplicate) = duplicate {
        let replace_allowed = entry.profile.is_some()
            && active_profile_id != Some(duplicate.id.as_str())
            && !duplicate.status.active;
        (
            LocalRestoreConflictKind::DuplicateFingerprint,
            Some(duplicate),
            replace_allowed,
        )
    } else if entry.profile.is_none() {
        (LocalRestoreConflictKind::MissingProfile, None, false)
    } else {
        return None;
    };
    Some(LocalRestoreConflict {
        backup_fingerprint: entry.fingerprint.as_str().to_owned(),
        backup_revision: entry.revision.as_str().to_owned(),
        current_fingerprint: conflicting
            .map(|value| value.artifact.fingerprint.as_str().to_owned()),
        current_revision: conflicting.map(|value| value.revision.id.as_str().to_owned()),
        kind,
        label: entry.label.clone(),
        profile_id: entry.id.as_str().to_owned(),
        replace_allowed,
    })
}

struct RestoreApplyContext<'a> {
    active_profile_id: Option<&'a str>,
    resolution: LocalRestoreConflictResolution,
    restored_at: u64,
    root: &'a Path,
    scope: LocalBackupScope,
}

fn apply_restore_entry(
    desired: &mut BTreeMap<String, ProfileRecord>,
    entry: &LocalBackupProfile,
    context: &RestoreApplyContext<'_>,
    applied: &mut LocalRestoreActionCounts,
) -> Result<(), LocalBackupError> {
    let current_metadata = desired
        .get(entry.id.as_str())
        .map(|record| &record.metadata);
    let duplicate_id = desired
        .iter()
        .find(|(id, record)| {
            id.as_str() != entry.id.as_str()
                && record.metadata.revision.id == entry.revision
                && record.metadata.artifact.fingerprint == entry.fingerprint
        })
        .map(|(id, _)| id.clone());
    let duplicate_metadata = duplicate_id
        .as_ref()
        .and_then(|id| desired.get(id))
        .map(|record| &record.metadata);
    if let Some(conflict) = profile_conflict(
        entry,
        current_metadata,
        duplicate_metadata,
        context.active_profile_id,
    ) {
        if context.resolution == LocalRestoreConflictResolution::KeepExisting
            || !conflict.replace_allowed
        {
            applied.skip += 1;
            return Ok(());
        }
        desired.remove(entry.id.as_str());
        if let Some(duplicate_id) = duplicate_id {
            desired.remove(&duplicate_id);
        }
    }

    if let Some(content) = &entry.profile {
        let existed = desired.contains_key(entry.id.as_str());
        let record = restore_record(
            context.root,
            entry,
            content,
            context.scope,
            context.restored_at,
        )?;
        desired.insert(entry.id.as_str().to_owned(), record);
        if existed {
            applied.replace += 1;
        } else {
            applied.add += 1;
        }
        return Ok(());
    }

    let Some(mut record) = desired.remove(entry.id.as_str()) else {
        applied.skip += 1;
        return Ok(());
    };
    if let Some(patches) = &entry.patches {
        record.patches = patches.clone();
    }
    if let Some(policy) = entry.schedule {
        apply_schedule(&mut record, policy, context.restored_at);
    }
    desired.insert(entry.id.as_str().to_owned(), record);
    applied.update += 1;
    Ok(())
}

fn restore_record(
    root: &Path,
    entry: &LocalBackupProfile,
    content: &LocalBackupProfileContent,
    scope: LocalBackupScope,
    restored_at: u64,
) -> Result<ProfileRecord, LocalBackupError> {
    let source_bytes = decode_bounded(&content.source_bytes_base64)?;
    let normalized_bytes = decode_bounded(&content.normalized_bytes_base64)?;
    let source = match &content.source {
        LocalBackupProfileSource::Embedded => ProfileSource::local_file(
            root.join("profiles")
                .join(entry.id.as_str())
                .join("source/revisions")
                .join(format!("{}.yaml", entry.revision.as_str())),
        ),
        LocalBackupProfileSource::Https { url } => ProfileSource::https(url),
        LocalBackupProfileSource::LocalFile { path } => ProfileSource::local_file(path.clone()),
    }
    .map_err(|_| LocalBackupError::InvalidManifest)?;
    let mut metadata = content.metadata.clone();
    metadata.provenance.source = source.safe_summary();
    metadata.refresh = ProfileRefreshState::default();
    metadata.status.active = false;
    metadata.status.error = false;
    metadata.status.stale = false;
    metadata.status.updating = false;
    let patches = entry.patches.clone().unwrap_or_else(|| {
        ProfilePatchSet::empty(&metadata.revision.id, &metadata.artifact.fingerprint)
    });
    let mut record = ProfileRecord {
        metadata,
        normalized_bytes,
        patches,
        source,
        source_bytes,
    };
    if scope.schedules {
        apply_schedule(
            &mut record,
            entry.schedule.unwrap_or(ProfileRefreshPolicy::Off),
            restored_at,
        );
    }
    Ok(record)
}

fn apply_schedule(record: &mut ProfileRecord, policy: ProfileRefreshPolicy, restored_at: u64) {
    let policy = if record.source.source_type() == ProfileSourceType::Https {
        policy
    } else {
        ProfileRefreshPolicy::Off
    };
    record.metadata.refresh = ProfileRefreshState {
        next_run_at: policy.interval_milliseconds().map(|interval| {
            Timestamp::from_unix_milliseconds(restored_at.saturating_add(interval))
        }),
        policy,
        ..ProfileRefreshState::default()
    };
}

fn included_counts(manifest: &LocalBackupManifest) -> LocalBackupIncludedCounts {
    LocalBackupIncludedCounts {
        patches: manifest
            .profiles
            .iter()
            .filter_map(|profile| profile.patches.as_ref())
            .map(|patches| patches.patches.len())
            .sum(),
        profiles: manifest
            .profiles
            .iter()
            .filter(|profile| profile.profile.is_some())
            .count(),
        schedules: manifest
            .profiles
            .iter()
            .filter(|profile| profile.schedule.is_some())
            .count(),
        settings: usize::from(manifest.settings.is_some()),
    }
}

fn sensitive_data(included: bool, scope: LocalBackupScope) -> Vec<LocalBackupSensitiveData> {
    [
        (
            LocalBackupSensitiveData::CredentialsAndProfileContents,
            scope.profiles,
        ),
        (
            LocalBackupSensitiveData::SubscriptionUrlsAndFullPaths,
            scope.source_locators,
        ),
    ]
    .into_iter()
    .filter_map(|(category, selected)| (selected == included).then_some(category))
    .collect()
}

fn update_digest<T: Serialize>(hasher: &mut Sha256, value: &T) -> Result<(), LocalBackupError> {
    let bytes = serde_json::to_vec(value).map_err(|_| LocalBackupError::InvalidManifest)?;
    hasher.update(bytes);
    Ok(())
}

fn map_repository_error(_error: RepositoryError) -> LocalBackupError {
    LocalBackupError::Storage
}

fn materialized_profile_file_name(record: &ProfileRecord) -> Result<String, LocalBackupError> {
    let source = record.source.safe_summary();
    let source_path = Path::new(&source.display);
    let source_is_private_revision = source_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| {
            stem.len() == 64
                && stem
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    let candidate = if source.source_type == ProfileSourceType::LocalFile
        && !source_is_private_revision
        && matches!(
            source_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("yaml" | "yml")
        ) {
        source.display
    } else {
        let label = record.metadata.label.trim();
        if label.ends_with(".yaml") || label.ends_with(".yml") {
            label.to_owned()
        } else {
            format!("{label}.yaml")
        }
    };
    let path = Path::new(&candidate);
    if path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(LocalBackupError::InvalidManifest);
    }
    Ok(candidate)
}

struct RestoreTransaction<F = StdRestoreFilesystem> {
    filesystem: Arc<F>,
    journal: RestoreJournal,
    root: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RestoreJournalPhase {
    Committed,
    Committing,
    RollingBack,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RestoreComponentKind {
    Profiles,
    Settings,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreJournalComponent {
    had_original: bool,
    kind: RestoreComponentKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreJournal {
    components: Vec<RestoreJournalComponent>,
    phase: RestoreJournalPhase,
    transaction_id: String,
    version: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RestoreCheckpoint {
    ComponentOriginalMoved(RestoreComponentKind),
    ComponentStagedMoved(RestoreComponentKind),
    DataSynced,
    JournalCommitted,
    JournalCommitting,
    JournalRollingBack,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RestoreFilesystemFailure {
    Crash,
    Io,
}

trait RestoreFilesystem: Send + Sync {
    fn checkpoint(&self, _checkpoint: RestoreCheckpoint) -> Result<(), RestoreFilesystemFailure> {
        Ok(())
    }

    fn rename(&self, source: &Path, destination: &Path) -> Result<(), RestoreFilesystemFailure>;
    fn remove_dir_all(&self, path: &Path) -> Result<(), RestoreFilesystemFailure>;
    fn remove_file(&self, path: &Path) -> Result<(), RestoreFilesystemFailure>;
    fn sync_directory(&self, path: &Path) -> Result<(), RestoreFilesystemFailure>;
    fn write_private_atomic(
        &self,
        destination: &Path,
        bytes: &[u8],
    ) -> Result<(), RestoreFilesystemFailure>;
}

#[derive(Default)]
struct StdRestoreFilesystem;

impl RestoreFilesystem for StdRestoreFilesystem {
    fn rename(&self, source: &Path, destination: &Path) -> Result<(), RestoreFilesystemFailure> {
        fs::rename(source, destination).map_err(|_| RestoreFilesystemFailure::Io)
    }

    fn remove_dir_all(&self, path: &Path) -> Result<(), RestoreFilesystemFailure> {
        if path.exists() {
            fs::remove_dir_all(path).map_err(|_| RestoreFilesystemFailure::Io)?;
        }
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> Result<(), RestoreFilesystemFailure> {
        if path.exists() {
            fs::remove_file(path).map_err(|_| RestoreFilesystemFailure::Io)?;
        }
        Ok(())
    }

    fn sync_directory(&self, path: &Path) -> Result<(), RestoreFilesystemFailure> {
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| RestoreFilesystemFailure::Io)
    }

    fn write_private_atomic(
        &self,
        destination: &Path,
        bytes: &[u8],
    ) -> Result<(), RestoreFilesystemFailure> {
        let parent = destination.parent().ok_or(RestoreFilesystemFailure::Io)?;
        let temporary = parent.join(format!(".restore-journal.tmp-{}", Uuid::new_v4()));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options
                .open(&temporary)
                .map_err(|_| RestoreFilesystemFailure::Io)?;
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| RestoreFilesystemFailure::Io)?;
            self.rename(&temporary, destination)?;
            self.sync_directory(parent)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

impl RestoreTransaction<StdRestoreFilesystem> {
    fn stage(
        root: &Path,
        profiles: Option<BTreeMap<String, ProfileRecord>>,
        settings: Option<SettingsPreferences>,
    ) -> Result<Self, LocalBackupError> {
        Self::stage_with_filesystem(root, profiles, settings, Arc::new(StdRestoreFilesystem))
    }

    fn recover(root: &Path) -> Result<(), LocalBackupError> {
        Self::recover_with_filesystem(root, Arc::new(StdRestoreFilesystem))
    }
}

impl<F> RestoreTransaction<F>
where
    F: RestoreFilesystem + 'static,
{
    fn stage_with_filesystem(
        root: &Path,
        profiles: Option<BTreeMap<String, ProfileRecord>>,
        settings: Option<SettingsPreferences>,
        filesystem: Arc<F>,
    ) -> Result<Self, LocalBackupError> {
        ensure_safe_component(root, &root.join("profile-store"))?;
        ensure_safe_component(root, &root.join("settings.json"))?;
        ensure_safe_component(root, &root.join(RESTORE_JOURNAL_FILE))?;
        if root.join(RESTORE_JOURNAL_FILE).exists() {
            return Err(LocalBackupError::RecoveryRequired);
        }
        let transaction_id = Uuid::new_v4();
        let stage_root = root.join(format!(".restore-stage-{transaction_id}"));
        let rollback_root = root.join(format!(".restore-rollback-{transaction_id}"));
        create_private_restore_dir(&stage_root)?;
        let mut stage_guard = TemporaryRestoreRoot::new(stage_root.clone());
        let mut components = Vec::new();
        if let Some(profiles) = profiles {
            let repository = FileProfileRepository::new(stage_root.join("profile-store"));
            create_private_restore_dir(&stage_root.join("profile-store"))?;
            for record in profiles.into_values() {
                repository.save(&record).map_err(map_repository_error)?;
            }
            components.push(RestoreJournalComponent {
                had_original: root.join("profile-store").exists(),
                kind: RestoreComponentKind::Profiles,
            });
        }
        if let Some(settings) = settings {
            let repository = FileSettingsRepository::new(stage_root.join("settings.json"));
            repository
                .save(&settings)
                .map_err(|_| LocalBackupError::Storage)?;
            components.push(RestoreJournalComponent {
                had_original: root.join("settings.json").exists(),
                kind: RestoreComponentKind::Settings,
            });
        }
        create_private_restore_dir(&rollback_root)?;
        if filesystem
            .sync_directory(&stage_root)
            .and_then(|()| filesystem.sync_directory(&rollback_root))
            .and_then(|()| filesystem.sync_directory(root))
            .is_err()
        {
            let _ = fs::remove_dir_all(&rollback_root);
            return Err(LocalBackupError::Storage);
        }
        let transaction = Self {
            filesystem,
            journal: RestoreJournal {
                components,
                phase: RestoreJournalPhase::Committing,
                transaction_id: transaction_id.to_string(),
                version: RESTORE_JOURNAL_VERSION,
            },
            root: root.to_path_buf(),
        };
        stage_guard.commit();
        Ok(transaction)
    }

    fn commit(self) -> Result<(), LocalBackupError> {
        self.write_journal()?;
        if let Err(failure) = self
            .filesystem
            .checkpoint(RestoreCheckpoint::JournalCommitting)
            .and_then(|()| self.commit_components())
        {
            if failure == RestoreFilesystemFailure::Crash {
                return Err(LocalBackupError::RecoveryRequired);
            }
            return self.rollback_after_failure();
        }
        let mut committed = self.journal.clone();
        committed.phase = RestoreJournalPhase::Committed;
        self.write_specific_journal(&committed)?;
        self.filesystem
            .checkpoint(RestoreCheckpoint::JournalCommitted)
            .map_err(map_restore_failure)?;
        self.cleanup(&committed)?;
        Ok(())
    }

    fn commit_components(&self) -> Result<(), RestoreFilesystemFailure> {
        for component in &self.journal.components {
            let paths = self.component_paths(component.kind);
            if component.had_original {
                self.filesystem
                    .rename(&paths.destination, &paths.original)?;
                self.filesystem.sync_directory(&self.root)?;
                self.filesystem.sync_directory(
                    paths
                        .original
                        .parent()
                        .ok_or(RestoreFilesystemFailure::Io)?,
                )?;
                self.filesystem
                    .checkpoint(RestoreCheckpoint::ComponentOriginalMoved(component.kind))?;
            }
            self.filesystem.rename(&paths.staged, &paths.destination)?;
            self.filesystem.sync_directory(&self.root)?;
            self.filesystem
                .sync_directory(paths.staged.parent().ok_or(RestoreFilesystemFailure::Io)?)?;
            self.filesystem
                .checkpoint(RestoreCheckpoint::ComponentStagedMoved(component.kind))?;
        }
        self.filesystem.sync_directory(&self.root)?;
        self.filesystem.checkpoint(RestoreCheckpoint::DataSynced)
    }

    fn rollback_after_failure(&self) -> Result<(), LocalBackupError> {
        let mut rolling_back = self.journal.clone();
        rolling_back.phase = RestoreJournalPhase::RollingBack;
        if self.write_specific_journal(&rolling_back).is_err()
            || self
                .filesystem
                .checkpoint(RestoreCheckpoint::JournalRollingBack)
                .is_err()
            || self.rollback_components(&rolling_back).is_err()
            || self.cleanup(&rolling_back).is_err()
        {
            return Err(LocalBackupError::RecoveryRequired);
        }
        Err(LocalBackupError::Storage)
    }

    fn rollback_components(
        &self,
        journal: &RestoreJournal,
    ) -> Result<(), RestoreFilesystemFailure> {
        for component in journal.components.iter().rev() {
            let paths = self.component_paths(component.kind);
            if component.had_original {
                if paths.original.exists() {
                    if !paths.staged.exists() && paths.destination.exists() {
                        self.filesystem.rename(&paths.destination, &paths.staged)?;
                    }
                    if !paths.destination.exists() {
                        self.filesystem
                            .rename(&paths.original, &paths.destination)?;
                    }
                }
            } else if !paths.staged.exists() && paths.destination.exists() {
                self.filesystem.rename(&paths.destination, &paths.staged)?;
            }
        }
        self.filesystem.sync_directory(&self.root)
    }

    fn recover_with_filesystem(root: &Path, filesystem: Arc<F>) -> Result<(), LocalBackupError> {
        let journal_path = root.join(RESTORE_JOURNAL_FILE);
        ensure_safe_component(root, &journal_path)?;
        if !journal_path.exists() {
            return Ok(());
        }
        let metadata =
            fs::symlink_metadata(&journal_path).map_err(|_| LocalBackupError::RecoveryRequired)?;
        if !metadata.is_file() || metadata.len() > RESTORE_JOURNAL_MAX_BYTES {
            return Err(LocalBackupError::RecoveryRequired);
        }
        validate_private_restore_file(root, &metadata)?;
        let bytes = fs::read(&journal_path).map_err(|_| LocalBackupError::RecoveryRequired)?;
        let journal: RestoreJournal =
            serde_json::from_slice(&bytes).map_err(|_| LocalBackupError::RecoveryRequired)?;
        validate_restore_journal(&journal)?;
        ensure_safe_component(root, &root.join("profile-store"))?;
        ensure_safe_component(root, &root.join("settings.json"))?;
        let (stage_root, rollback_root) = restore_roots(root, &journal.transaction_id);
        validate_restore_workspace(root, &stage_root)?;
        validate_restore_workspace(root, &rollback_root)?;
        let transaction = Self {
            filesystem,
            journal: journal.clone(),
            root: root.to_path_buf(),
        };
        match journal.phase {
            RestoreJournalPhase::Committed => transaction.cleanup(&journal),
            RestoreJournalPhase::Committing | RestoreJournalPhase::RollingBack => {
                let mut rolling_back = journal;
                rolling_back.phase = RestoreJournalPhase::RollingBack;
                transaction.write_specific_journal(&rolling_back)?;
                transaction
                    .rollback_components(&rolling_back)
                    .map_err(|_| LocalBackupError::RecoveryRequired)?;
                transaction.cleanup(&rolling_back)
            }
        }
    }

    fn write_journal(&self) -> Result<(), LocalBackupError> {
        self.write_specific_journal(&self.journal)
    }

    fn write_specific_journal(&self, journal: &RestoreJournal) -> Result<(), LocalBackupError> {
        let bytes = serde_json::to_vec_pretty(journal).map_err(|_| LocalBackupError::Storage)?;
        self.filesystem
            .write_private_atomic(&self.root.join(RESTORE_JOURNAL_FILE), &bytes)
            .map_err(map_restore_failure)
    }

    fn cleanup(&self, journal: &RestoreJournal) -> Result<(), LocalBackupError> {
        let (stage_root, rollback_root) = restore_roots(&self.root, &journal.transaction_id);
        self.filesystem
            .remove_dir_all(&rollback_root)
            .and_then(|()| self.filesystem.remove_dir_all(&stage_root))
            .and_then(|()| self.filesystem.sync_directory(&self.root))
            .and_then(|()| {
                self.filesystem
                    .remove_file(&self.root.join(RESTORE_JOURNAL_FILE))
            })
            .map_err(|_| LocalBackupError::RecoveryRequired)?;
        if self.filesystem.sync_directory(&self.root).is_err() {
            let _ = self.write_specific_journal(journal);
            return Err(LocalBackupError::RecoveryRequired);
        }
        Ok(())
    }

    fn component_paths(&self, kind: RestoreComponentKind) -> RestoreComponentPaths {
        let (stage_root, rollback_root) = restore_roots(&self.root, &self.journal.transaction_id);
        match kind {
            RestoreComponentKind::Profiles => RestoreComponentPaths {
                destination: self.root.join("profile-store"),
                original: rollback_root.join("profile-store"),
                staged: stage_root.join("profile-store"),
            },
            RestoreComponentKind::Settings => RestoreComponentPaths {
                destination: self.root.join("settings.json"),
                original: rollback_root.join("settings.json"),
                staged: stage_root.join("settings.json"),
            },
        }
    }
}

struct RestoreComponentPaths {
    destination: PathBuf,
    original: PathBuf,
    staged: PathBuf,
}

fn restore_roots(root: &Path, transaction_id: &str) -> (PathBuf, PathBuf) {
    (
        root.join(format!(".restore-stage-{transaction_id}")),
        root.join(format!(".restore-rollback-{transaction_id}")),
    )
}

fn validate_restore_journal(journal: &RestoreJournal) -> Result<(), LocalBackupError> {
    if journal.version != RESTORE_JOURNAL_VERSION
        || journal.components.is_empty()
        || Uuid::parse_str(&journal.transaction_id).is_err()
    {
        return Err(LocalBackupError::RecoveryRequired);
    }
    let mut kinds = HashSet::new();
    if journal.components.len() > 2
        || journal
            .components
            .iter()
            .any(|component| !kinds.insert(component.kind as u8))
    {
        return Err(LocalBackupError::RecoveryRequired);
    }
    Ok(())
}

fn create_private_restore_dir(path: &Path) -> Result<(), LocalBackupError> {
    fs::create_dir(path).map_err(|_| LocalBackupError::Storage)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| LocalBackupError::Storage)?;
    Ok(())
}

fn map_restore_failure(failure: RestoreFilesystemFailure) -> LocalBackupError {
    match failure {
        RestoreFilesystemFailure::Crash => LocalBackupError::RecoveryRequired,
        RestoreFilesystemFailure::Io => LocalBackupError::Storage,
    }
}

struct TemporaryRestoreRoot {
    committed: bool,
    path: PathBuf,
}

impl TemporaryRestoreRoot {
    fn new(path: PathBuf) -> Self {
        Self {
            committed: false,
            path,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TemporaryRestoreRoot {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn ensure_safe_component(root: &Path, path: &Path) -> Result<(), LocalBackupError> {
    if !root.is_absolute() {
        return Err(LocalBackupError::Storage);
    }
    if fs::symlink_metadata(root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(LocalBackupError::Storage);
    }
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(LocalBackupError::Storage);
    }
    Ok(())
}

fn validate_private_restore_file(
    root: &Path,
    metadata: &fs::Metadata,
) -> Result<(), LocalBackupError> {
    #[cfg(unix)]
    {
        let root_metadata =
            fs::symlink_metadata(root).map_err(|_| LocalBackupError::RecoveryRequired)?;
        if metadata.permissions().mode() & 0o777 != 0o600 || metadata.uid() != root_metadata.uid() {
            return Err(LocalBackupError::RecoveryRequired);
        }
    }
    Ok(())
}

fn validate_restore_workspace(root: &Path, path: &Path) -> Result<(), LocalBackupError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(LocalBackupError::RecoveryRequired),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(LocalBackupError::RecoveryRequired);
    }
    #[cfg(unix)]
    {
        let root_metadata =
            fs::symlink_metadata(root).map_err(|_| LocalBackupError::RecoveryRequired)?;
        if metadata.permissions().mode() & 0o777 != 0o700 || metadata.uid() != root_metadata.uid() {
            return Err(LocalBackupError::RecoveryRequired);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::{FutureExt, future::BoxFuture};
    use mish_profile::{
        HttpsSourceReader, ImportPreflight, ImportRequest, LocalSourceReader, ProfileId,
        SensitivePath, SensitiveUrl, SourceContent, SourceReadError, SourceReadPolicy,
    };
    use mish_settings::{SettingsCapabilities, SettingsService};
    use tempfile::tempdir;

    use super::*;

    const VALID_PROFILE: &str = r#"
proxies:
  - name: fictional-node
    type: socks5
    server: 192.0.2.10
    port: 1080
    password: not-a-real-password
proxy-groups:
  - name: Fictional group
    type: select
    proxies: [fictional-node]
rules:
  - MATCH,Fictional group
"#;

    #[derive(Clone)]
    struct FixedReader(Vec<u8>);

    impl LocalSourceReader for FixedReader {
        fn read<'a>(
            &'a self,
            _path: &'a SensitivePath,
            _policy: &'a SourceReadPolicy,
        ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
            let bytes = self.0.clone();
            async move {
                Ok(SourceContent {
                    bytes,
                    content_type: None,
                    final_url: None,
                    redirects: 0,
                })
            }
            .boxed()
        }
    }

    impl HttpsSourceReader for FixedReader {
        fn read<'a>(
            &'a self,
            _url: &'a SensitiveUrl,
            _policy: &'a SourceReadPolicy,
        ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
            let bytes = self.0.clone();
            async move {
                Ok(SourceContent {
                    bytes,
                    content_type: Some("application/yaml".to_owned()),
                    final_url: None,
                    redirects: 0,
                })
            }
            .boxed()
        }
    }

    async fn profile_record(contents: &str, id: ProfileId) -> ProfileRecord {
        let reader = FixedReader(contents.as_bytes().to_vec());
        ImportPreflight::new(reader.clone(), reader, SourceReadPolicy::default())
            .run(ImportRequest {
                label: Some("Work profile".to_owned()),
                source: ProfileSource::local_file("/tmp/work-profile.yaml".into()).unwrap(),
            })
            .await
            .unwrap()
            .into_record(id, Timestamp::from_unix_milliseconds(10))
    }

    fn service(root: &Path) -> LocalBackupService {
        let settings = Arc::new(
            SettingsService::load(
                Arc::new(FileSettingsRepository::new(root.join("settings.json"))),
                None,
                None,
                SettingsCapabilities {
                    background_launch: mish_settings::SettingsAvailability::Unavailable,
                    backup_restore: mish_settings::SettingsAvailability::Supported,
                    expert_configuration: mish_settings::SettingsAvailability::Unavailable,
                    launch_at_login: mish_settings::SettingsAvailability::Unavailable,
                    native_sidebar_material: mish_settings::SettingsAvailability::Unavailable,
                    network_dns: mish_settings::SettingsAvailability::Unavailable,
                    status_bar: mish_settings::SettingsAvailability::Unavailable,
                    tun: mish_settings::SettingsAvailability::Unavailable,
                    updates: mish_settings::SettingsAvailability::Unavailable,
                    window_lifecycle: mish_settings::SettingsAvailability::Unavailable,
                },
            )
            .unwrap(),
        );
        LocalBackupService::new(root.to_path_buf(), settings, "0.1.0-test")
    }

    #[test]
    fn default_safe_scope_excludes_both_sensitive_categories() {
        let root = tempdir().unwrap();
        let prepared = service(root.path())
            .prepare_export(
                "preview-1".to_owned(),
                LocalBackupScope {
                    patches: true,
                    profiles: false,
                    schedules: true,
                    settings: true,
                    source_locators: false,
                },
                100,
            )
            .unwrap();

        assert!(prepared.preview.included_sensitive_data.is_empty());
        assert_eq!(prepared.preview.excluded_sensitive_data.len(), 2);
        assert!(prepared.bytes.len() < LOCAL_BACKUP_MAX_BYTES);
        let manifest: serde_json::Value = serde_json::from_slice(&prepared.bytes).unwrap();
        assert_eq!(manifest["formatVersion"], 1);
        assert!(manifest.get("runtime").is_none());
        assert!(manifest.get("capture").is_none());
    }

    #[test]
    fn restore_rejects_unknown_fields_and_unsupported_versions() {
        let root = tempdir().unwrap();
        let service = service(root.path());
        let prepared = service
            .prepare_export(
                "preview-1".to_owned(),
                LocalBackupScope {
                    patches: false,
                    profiles: false,
                    schedules: false,
                    settings: true,
                    source_locators: false,
                },
                100,
            )
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&prepared.bytes).unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert_eq!(
            service
                .prepare_restore(
                    "restore-1".to_owned(),
                    &serde_json::to_vec(&value).unwrap(),
                    None,
                )
                .unwrap_err(),
            LocalBackupError::InvalidManifest
        );
        value.as_object_mut().unwrap().remove("unexpected");
        value["formatVersion"] = serde_json::json!(2);
        assert_eq!(
            service
                .prepare_restore(
                    "restore-1".to_owned(),
                    &serde_json::to_vec(&value).unwrap(),
                    None,
                )
                .unwrap_err(),
            LocalBackupError::UnsupportedVersion
        );
    }

    #[test]
    fn settings_restore_commits_without_platform_adapters() {
        let source_root = tempdir().unwrap();
        let source = service(source_root.path());
        let mut preferences = source
            .settings
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences;
        preferences.language = mish_settings::LanguagePreference::Zh;
        source
            .settings
            .accept_restored_preferences(preferences)
            .unwrap();
        let backup = source
            .prepare_export(
                "export-1".to_owned(),
                LocalBackupScope {
                    patches: false,
                    profiles: false,
                    schedules: false,
                    settings: true,
                    source_locators: false,
                },
                100,
            )
            .unwrap();

        let destination_root = tempdir().unwrap();
        let destination = service(destination_root.path());
        let prepared = destination
            .prepare_restore("restore-1".to_owned(), &backup.bytes, None)
            .unwrap();
        let result = destination
            .commit_restore(
                prepared,
                LocalRestoreConflictResolution::KeepExisting,
                200,
                None,
            )
            .unwrap();

        assert_eq!(
            result.settings_snapshot.preferences.language,
            mish_settings::LanguagePreference::Zh
        );
        assert!(!destination_root.path().join(".restore-stage-test").exists());
    }

    #[tokio::test]
    async fn profile_contents_round_trip_to_a_private_inactive_embedded_source() {
        let source_root = tempdir().unwrap();
        let source = service(source_root.path());
        let record = profile_record(VALID_PROFILE, ProfileId::new()).await;
        let profile_id = record.metadata.id.clone();
        FileProfileRepository::new(source_root.path().join("profile-store"))
            .save(&record)
            .unwrap();
        let backup = source
            .prepare_export(
                "export-1".to_owned(),
                LocalBackupScope {
                    patches: true,
                    profiles: true,
                    schedules: true,
                    settings: false,
                    source_locators: false,
                },
                100,
            )
            .unwrap();

        let destination_root = tempdir().unwrap();
        let destination = service(destination_root.path());
        let prepared = destination
            .prepare_restore("restore-1".to_owned(), &backup.bytes, None)
            .unwrap();
        assert_eq!(prepared.preview.actions.add, 1);
        destination
            .commit_restore(
                prepared,
                LocalRestoreConflictResolution::KeepExisting,
                200,
                None,
            )
            .unwrap();

        let restored = FileProfileRepository::new(destination_root.path().join("profile-store"))
            .load(&profile_id)
            .unwrap();
        assert_eq!(restored.source_bytes, record.source_bytes);
        assert_eq!(restored.normalized_bytes, record.normalized_bytes);
        assert!(!restored.metadata.status.active);
        assert_eq!(restored.metadata.refresh.policy, ProfileRefreshPolicy::Off);
        let ProfileSource::LocalFile { path } = restored.source else {
            panic!("embedded restore should use a private local source");
        };
        assert!(path.expose().starts_with(destination_root.path()));
    }

    #[test]
    fn restore_preview_expires_after_authoritative_state_changes() {
        let source_root = tempdir().unwrap();
        let source = service(source_root.path());
        let backup = source
            .prepare_export(
                "export-1".to_owned(),
                LocalBackupScope {
                    patches: false,
                    profiles: false,
                    schedules: false,
                    settings: true,
                    source_locators: false,
                },
                100,
            )
            .unwrap();
        let destination_root = tempdir().unwrap();
        let destination = service(destination_root.path());
        let prepared = destination
            .prepare_restore("restore-1".to_owned(), &backup.bytes, None)
            .unwrap();
        let mut changed = destination
            .settings
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences;
        changed.language = mish_settings::LanguagePreference::Zh;
        destination
            .settings
            .accept_restored_preferences(changed)
            .unwrap();

        assert_eq!(
            destination
                .commit_restore(
                    prepared,
                    LocalRestoreConflictResolution::KeepExisting,
                    200,
                    None,
                )
                .unwrap_err(),
            LocalBackupError::StateChanged
        );
    }

    #[test]
    fn restore_returns_typed_busy_instead_of_overwriting_an_in_progress_mutation() {
        let root = tempdir().unwrap();
        let service = service(root.path());
        let backup = service
            .prepare_export(
                "export-1".to_owned(),
                LocalBackupScope {
                    patches: false,
                    profiles: false,
                    schedules: false,
                    settings: true,
                    source_locators: false,
                },
                100,
            )
            .unwrap();
        let prepared = service
            .prepare_restore("restore-1".to_owned(), &backup.bytes, None)
            .unwrap();
        let permit = service.try_begin_restore().unwrap();

        assert!(matches!(
            service
                .settings
                .set_language(mish_settings::LanguagePreference::Zh),
            Err(mish_settings::SettingsServiceError::Busy)
        ));
        assert_eq!(
            service
                .commit_restore(
                    prepared,
                    LocalRestoreConflictResolution::KeepExisting,
                    200,
                    None,
                )
                .unwrap_err(),
            LocalBackupError::Busy
        );
        drop(permit);
    }

    #[tokio::test]
    async fn active_profile_transition_expires_preview_and_active_replacement_is_never_allowed() {
        let source_root = tempdir().unwrap();
        let source = service(source_root.path());
        let record = profile_record(VALID_PROFILE, ProfileId::new()).await;
        let profile_id = record.metadata.id.as_str().to_owned();
        FileProfileRepository::new(source_root.path().join("profile-store"))
            .save(&record)
            .unwrap();
        let backup = source
            .prepare_export(
                "export-1".to_owned(),
                LocalBackupScope {
                    patches: false,
                    profiles: true,
                    schedules: false,
                    settings: false,
                    source_locators: false,
                },
                100,
            )
            .unwrap();

        let destination_root = tempdir().unwrap();
        let destination = service(destination_root.path());
        let mut current = record;
        current.metadata.label = "Current active label".to_owned();
        FileProfileRepository::new(destination_root.path().join("profile-store"))
            .save(&current)
            .unwrap();

        let stale = destination
            .prepare_restore("restore-stale".to_owned(), &backup.bytes, None)
            .unwrap();
        assert_eq!(
            destination
                .commit_restore(
                    stale,
                    LocalRestoreConflictResolution::UseBackup,
                    200,
                    Some(&profile_id),
                )
                .unwrap_err(),
            LocalBackupError::StateChanged
        );

        let active = destination
            .prepare_restore(
                "restore-active".to_owned(),
                &backup.bytes,
                Some(&profile_id),
            )
            .unwrap();
        assert_eq!(
            active.preview.conflicts[0].kind,
            LocalRestoreConflictKind::ActiveProfile
        );
        assert!(!active.preview.conflicts[0].replace_allowed);
        let result = destination
            .commit_restore(
                active,
                LocalRestoreConflictResolution::UseBackup,
                200,
                Some(&profile_id),
            )
            .unwrap();
        assert_eq!(result.applied.skip, 1);
        let persisted = FileProfileRepository::new(destination_root.path().join("profile-store"))
            .load(&ProfileId::parse(profile_id).unwrap())
            .unwrap();
        assert_eq!(persisted.metadata.label, "Current active label");
    }

    struct InjectedFilesystem {
        crash_at: Option<RestoreCheckpoint>,
        crashed: std::sync::atomic::AtomicBool,
        fail_rename_calls: Vec<usize>,
        rename_calls: std::sync::atomic::AtomicUsize,
        standard: StdRestoreFilesystem,
    }

    impl InjectedFilesystem {
        fn crashing_at(checkpoint: RestoreCheckpoint) -> Self {
            Self {
                crash_at: Some(checkpoint),
                crashed: std::sync::atomic::AtomicBool::new(false),
                fail_rename_calls: Vec::new(),
                rename_calls: std::sync::atomic::AtomicUsize::new(0),
                standard: StdRestoreFilesystem,
            }
        }

        fn failing_renames(calls: Vec<usize>) -> Self {
            Self {
                crash_at: None,
                crashed: std::sync::atomic::AtomicBool::new(false),
                fail_rename_calls: calls,
                rename_calls: std::sync::atomic::AtomicUsize::new(0),
                standard: StdRestoreFilesystem,
            }
        }
    }

    impl RestoreFilesystem for InjectedFilesystem {
        fn checkpoint(
            &self,
            checkpoint: RestoreCheckpoint,
        ) -> Result<(), RestoreFilesystemFailure> {
            if self.crash_at == Some(checkpoint)
                && !self.crashed.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return Err(RestoreFilesystemFailure::Crash);
            }
            Ok(())
        }

        fn rename(
            &self,
            source: &Path,
            destination: &Path,
        ) -> Result<(), RestoreFilesystemFailure> {
            let call = self
                .rename_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            if self.fail_rename_calls.contains(&call) {
                return Err(RestoreFilesystemFailure::Io);
            }
            self.standard.rename(source, destination)
        }

        fn remove_dir_all(&self, path: &Path) -> Result<(), RestoreFilesystemFailure> {
            self.standard.remove_dir_all(path)
        }

        fn remove_file(&self, path: &Path) -> Result<(), RestoreFilesystemFailure> {
            self.standard.remove_file(path)
        }

        fn sync_directory(&self, path: &Path) -> Result<(), RestoreFilesystemFailure> {
            self.standard.sync_directory(path)
        }

        fn write_private_atomic(
            &self,
            destination: &Path,
            bytes: &[u8],
        ) -> Result<(), RestoreFilesystemFailure> {
            self.standard.write_private_atomic(destination, bytes)
        }
    }

    fn transaction_fixture(
        filesystem: Arc<InjectedFilesystem>,
    ) -> (
        tempfile::TempDir,
        RestoreTransaction<InjectedFilesystem>,
        SettingsPreferences,
    ) {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("profile-store")).unwrap();
        fs::write(root.path().join("profile-store/original"), b"profile-state").unwrap();
        let original_settings = SettingsPreferences::default();
        FileSettingsRepository::new(root.path().join("settings.json"))
            .save(&original_settings)
            .unwrap();
        let mut replacement_settings = original_settings;
        replacement_settings.language = mish_settings::LanguagePreference::Zh;
        let transaction = RestoreTransaction::stage_with_filesystem(
            root.path(),
            Some(BTreeMap::new()),
            Some(replacement_settings),
            filesystem,
        )
        .unwrap();
        (root, transaction, original_settings)
    }

    fn assert_original_generation(root: &Path, settings: SettingsPreferences) {
        assert_eq!(
            fs::read(root.join("profile-store/original")).unwrap(),
            b"profile-state"
        );
        assert_eq!(
            FileSettingsRepository::new(root.join("settings.json"))
                .load()
                .unwrap()
                .preferences,
            settings
        );
    }

    fn assert_invalid_recovery_journal_is_preserved(mutate: impl FnOnce(&Path)) {
        let (root, transaction, original_settings) = transaction_fixture(Arc::new(
            InjectedFilesystem::crashing_at(RestoreCheckpoint::JournalCommitting),
        ));
        assert_eq!(
            transaction.commit().unwrap_err(),
            LocalBackupError::RecoveryRequired
        );
        let journal = root.path().join(RESTORE_JOURNAL_FILE);
        mutate(&journal);

        assert_eq!(
            RestoreTransaction::recover(root.path()).unwrap_err(),
            LocalBackupError::RecoveryRequired
        );
        assert_original_generation(root.path(), original_settings);
        assert!(journal.exists());
    }

    #[test]
    fn ordinary_multi_component_failure_rolls_back_every_completed_rename() {
        let (root, transaction, original_settings) =
            transaction_fixture(Arc::new(InjectedFilesystem::failing_renames(vec![2])));

        assert_eq!(transaction.commit().unwrap_err(), LocalBackupError::Storage);
        assert_original_generation(root.path(), original_settings);
        assert!(!root.path().join(RESTORE_JOURNAL_FILE).exists());
    }

    #[test]
    fn rollback_failure_preserves_the_journal_for_startup_recovery() {
        let (root, transaction, original_settings) =
            transaction_fixture(Arc::new(InjectedFilesystem::failing_renames(vec![2, 3])));

        assert_eq!(
            transaction.commit().unwrap_err(),
            LocalBackupError::RecoveryRequired
        );
        assert!(root.path().join(RESTORE_JOURNAL_FILE).exists());
        RestoreTransaction::recover(root.path()).unwrap();
        assert_original_generation(root.path(), original_settings);
        assert!(!root.path().join(RESTORE_JOURNAL_FILE).exists());
    }

    #[test]
    fn every_commit_crash_point_recovers_idempotently_without_mixed_generations() {
        let checkpoints = [
            RestoreCheckpoint::JournalCommitting,
            RestoreCheckpoint::ComponentOriginalMoved(RestoreComponentKind::Profiles),
            RestoreCheckpoint::ComponentStagedMoved(RestoreComponentKind::Profiles),
            RestoreCheckpoint::ComponentOriginalMoved(RestoreComponentKind::Settings),
            RestoreCheckpoint::ComponentStagedMoved(RestoreComponentKind::Settings),
            RestoreCheckpoint::DataSynced,
            RestoreCheckpoint::JournalCommitted,
        ];
        for checkpoint in checkpoints {
            let (root, transaction, original_settings) =
                transaction_fixture(Arc::new(InjectedFilesystem::crashing_at(checkpoint)));
            assert_eq!(
                transaction.commit().unwrap_err(),
                LocalBackupError::RecoveryRequired,
                "checkpoint {checkpoint:?}"
            );
            assert!(root.path().join(RESTORE_JOURNAL_FILE).exists());
            #[cfg(unix)]
            assert_eq!(
                fs::metadata(root.path().join(RESTORE_JOURNAL_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );

            RestoreTransaction::recover(root.path()).unwrap();
            RestoreTransaction::recover(root.path()).unwrap();
            assert!(!root.path().join(RESTORE_JOURNAL_FILE).exists());
            if checkpoint == RestoreCheckpoint::JournalCommitted {
                assert!(!root.path().join("profile-store/original").exists());
                assert_eq!(
                    FileSettingsRepository::new(root.path().join("settings.json"))
                        .load()
                        .unwrap()
                        .preferences
                        .language,
                    mish_settings::LanguagePreference::Zh
                );
            } else {
                assert_original_generation(root.path(), original_settings);
            }
        }
    }

    #[test]
    fn startup_recovery_rejects_a_non_private_journal_without_mutating_state() {
        let (root, transaction, original_settings) = transaction_fixture(Arc::new(
            InjectedFilesystem::crashing_at(RestoreCheckpoint::JournalCommitting),
        ));
        assert_eq!(
            transaction.commit().unwrap_err(),
            LocalBackupError::RecoveryRequired
        );
        let journal = root.path().join(RESTORE_JOURNAL_FILE);
        fs::set_permissions(&journal, fs::Permissions::from_mode(0o644)).unwrap();

        assert_eq!(
            RestoreTransaction::recover(root.path()).unwrap_err(),
            LocalBackupError::RecoveryRequired
        );
        assert_original_generation(root.path(), original_settings);
        assert!(journal.exists());
    }

    #[test]
    fn startup_recovery_rejects_corrupt_stale_and_oversized_journals() {
        assert_invalid_recovery_journal_is_preserved(|journal| {
            fs::write(journal, b"{").unwrap();
        });
        assert_invalid_recovery_journal_is_preserved(|journal| {
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
            value["version"] = 0.into();
            fs::write(journal, serde_json::to_vec(&value).unwrap()).unwrap();
        });
        assert_invalid_recovery_journal_is_preserved(|journal| {
            fs::write(journal, vec![b'x'; RESTORE_JOURNAL_MAX_BYTES as usize + 1]).unwrap();
        });
    }

    #[test]
    fn startup_recovery_rejects_a_non_private_transaction_workspace() {
        let (root, transaction, original_settings) = transaction_fixture(Arc::new(
            InjectedFilesystem::crashing_at(RestoreCheckpoint::JournalCommitting),
        ));
        let (stage_root, _) = restore_roots(root.path(), &transaction.journal.transaction_id);
        assert_eq!(
            transaction.commit().unwrap_err(),
            LocalBackupError::RecoveryRequired
        );
        fs::set_permissions(&stage_root, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            RestoreTransaction::recover(root.path()).unwrap_err(),
            LocalBackupError::RecoveryRequired
        );
        assert_original_generation(root.path(), original_settings);
        assert!(root.path().join(RESTORE_JOURNAL_FILE).exists());
    }
}
