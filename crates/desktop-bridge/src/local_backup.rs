use std::{
    collections::{BTreeMap, HashSet},
    fs,
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
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const LOCAL_BACKUP_FORMAT_VERSION: u32 = 1;
pub const LOCAL_BACKUP_MAX_BYTES: usize = 8 * 1_024 * 1_024;
const LOCAL_BACKUP_MAX_PROFILES: usize = 128;

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
}

#[derive(Clone)]
pub struct LocalBackupService {
    application_version: &'static str,
    root: PathBuf,
    settings: Arc<SettingsService>,
}

impl LocalBackupService {
    pub fn new(
        root: PathBuf,
        settings: Arc<SettingsService>,
        application_version: &'static str,
    ) -> Self {
        Self {
            application_version,
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
        scope.validate()?;
        let repository = FileProfileRepository::new(self.root.clone());
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
    ) -> Result<PreparedLocalRestore, LocalBackupError> {
        if bytes.len() > LOCAL_BACKUP_MAX_BYTES {
            return Err(LocalBackupError::SizeLimitExceeded);
        }
        let manifest: LocalBackupManifest =
            serde_json::from_slice(bytes).map_err(|_| LocalBackupError::InvalidManifest)?;
        validate_manifest(&manifest)?;
        let (actions, conflicts) = self.restore_plan(&manifest)?;
        let state_digest = self.state_digest()?;
        Ok(PreparedLocalRestore {
            preview: LocalRestorePreview {
                actions,
                conflicts,
                content_bytes: bytes.len(),
                file_type: "application/json",
                format_version: manifest.format_version,
                included: included_counts(&manifest),
                max_bytes: LOCAL_BACKUP_MAX_BYTES,
                preview_id,
                scope: manifest.scope,
            },
            manifest,
            state_digest,
        })
    }

    pub fn commit_restore(
        &self,
        prepared: PreparedLocalRestore,
        resolution: LocalRestoreConflictResolution,
        restored_at: u64,
    ) -> Result<LocalRestoreResult, LocalBackupError> {
        if self.state_digest()? != prepared.state_digest {
            return Err(LocalBackupError::StateChanged);
        }
        let repository = FileProfileRepository::new(self.root.clone());
        let mut desired = BTreeMap::new();
        for metadata in repository.list_metadata().map_err(map_repository_error)? {
            let record = repository
                .load(&metadata.id)
                .map_err(map_repository_error)?;
            desired.insert(metadata.id.as_str().to_owned(), record);
        }

        let mut applied = LocalRestoreActionCounts::default();
        if prepared.manifest.scope.touches_profiles() {
            for entry in &prepared.manifest.profiles {
                apply_restore_entry(
                    &self.root,
                    &mut desired,
                    entry,
                    prepared.manifest.scope,
                    resolution,
                    restored_at,
                    &mut applied,
                )?;
            }
        }

        let transaction = RestoreTransaction::stage(
            &self.root,
            prepared
                .manifest
                .scope
                .touches_profiles()
                .then_some(desired),
            prepared.manifest.settings,
        )?;
        transaction.commit()?;
        if let Some(preferences) = prepared.manifest.settings {
            self.settings.accept_restored_preferences(preferences);
        }
        if prepared.manifest.scope.settings {
            applied.update += 1;
        }
        Ok(LocalRestoreResult {
            applied,
            settings_snapshot: self.settings.snapshot(SettingsAdapterKind::Rpc),
        })
    }

    fn restore_plan(
        &self,
        manifest: &LocalBackupManifest,
    ) -> Result<(LocalRestoreActionCounts, Vec<LocalRestoreConflict>), LocalBackupError> {
        let repository = FileProfileRepository::new(self.root.clone());
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
            let conflict = profile_conflict(entry, current, duplicate);
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

    fn state_digest(&self) -> Result<String, LocalBackupError> {
        let repository = FileProfileRepository::new(self.root.clone());
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
) -> Option<LocalRestoreConflict> {
    let (kind, conflicting, replace_allowed) = if let Some(current) = current {
        if current.status.active {
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
            (
                LocalRestoreConflictKind::DuplicateFingerprint,
                Some(duplicate),
                entry.profile.is_some() && !duplicate.status.active,
            )
        }
    } else if let Some(duplicate) = duplicate {
        (
            LocalRestoreConflictKind::DuplicateFingerprint,
            Some(duplicate),
            entry.profile.is_some() && !duplicate.status.active,
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

fn apply_restore_entry(
    root: &Path,
    desired: &mut BTreeMap<String, ProfileRecord>,
    entry: &LocalBackupProfile,
    scope: LocalBackupScope,
    resolution: LocalRestoreConflictResolution,
    restored_at: u64,
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
    if let Some(conflict) = profile_conflict(entry, current_metadata, duplicate_metadata) {
        if resolution == LocalRestoreConflictResolution::KeepExisting || !conflict.replace_allowed {
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
        let record = restore_record(root, entry, content, scope, restored_at)?;
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
        apply_schedule(&mut record, policy, restored_at);
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

struct RestoreTransaction {
    components: Vec<RestoreComponent>,
    root: PathBuf,
    rollback_root: PathBuf,
    stage_root: PathBuf,
}

struct RestoreComponent {
    destination: PathBuf,
    original: PathBuf,
    staged: PathBuf,
}

impl RestoreTransaction {
    fn stage(
        root: &Path,
        profiles: Option<BTreeMap<String, ProfileRecord>>,
        settings: Option<SettingsPreferences>,
    ) -> Result<Self, LocalBackupError> {
        ensure_safe_component(root, &root.join("profiles"))?;
        ensure_safe_component(root, &root.join("settings.json"))?;
        let transaction_id = Uuid::new_v4();
        let stage_root = root.join(format!(".restore-stage-{transaction_id}"));
        let rollback_root = root.join(format!(".restore-rollback-{transaction_id}"));
        fs::create_dir(&stage_root).map_err(|_| LocalBackupError::Storage)?;
        let mut stage_guard = TemporaryRestoreRoot::new(stage_root.clone());
        let mut components = Vec::new();
        if let Some(profiles) = profiles {
            let repository = FileProfileRepository::new(stage_root.clone());
            fs::create_dir(stage_root.join("profiles")).map_err(|_| LocalBackupError::Storage)?;
            for record in profiles.into_values() {
                repository.save(&record).map_err(map_repository_error)?;
            }
            components.push(RestoreComponent {
                destination: root.join("profiles"),
                original: rollback_root.join("profiles"),
                staged: stage_root.join("profiles"),
            });
        }
        if let Some(settings) = settings {
            let repository = FileSettingsRepository::new(stage_root.join("settings.json"));
            repository
                .save(&settings)
                .map_err(|_| LocalBackupError::Storage)?;
            components.push(RestoreComponent {
                destination: root.join("settings.json"),
                original: rollback_root.join("settings.json"),
                staged: stage_root.join("settings.json"),
            });
        }
        let transaction = Self {
            components,
            root: root.to_path_buf(),
            rollback_root,
            stage_root,
        };
        stage_guard.commit();
        Ok(transaction)
    }

    fn commit(self) -> Result<(), LocalBackupError> {
        self.commit_with_failure(None)
    }

    fn commit_with_failure(
        self,
        fail_after_component_count: Option<usize>,
    ) -> Result<(), LocalBackupError> {
        fs::create_dir(&self.rollback_root).map_err(|_| LocalBackupError::Storage)?;
        let mut moved_originals = Vec::new();
        let mut moved_staged = Vec::new();
        let result = (|| {
            for (index, component) in self.components.iter().enumerate() {
                if component.destination.exists() {
                    fs::rename(&component.destination, &component.original)
                        .map_err(|_| LocalBackupError::Storage)?;
                    moved_originals.push(index);
                }
                fs::rename(&component.staged, &component.destination)
                    .map_err(|_| LocalBackupError::Storage)?;
                moved_staged.push(index);
                if fail_after_component_count == Some(moved_staged.len()) {
                    return Err(LocalBackupError::Storage);
                }
            }
            fs::File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| LocalBackupError::Storage)
        })();
        if let Err(error) = result {
            for index in moved_staged.into_iter().rev() {
                let component = &self.components[index];
                let _ = fs::rename(&component.destination, &component.staged);
            }
            for index in moved_originals.into_iter().rev() {
                let component = &self.components[index];
                let _ = fs::rename(&component.original, &component.destination);
            }
            let _ = fs::remove_dir_all(&self.rollback_root);
            let _ = fs::remove_dir_all(&self.stage_root);
            return Err(error);
        }
        let _ = fs::remove_dir_all(&self.rollback_root);
        let _ = fs::remove_dir_all(&self.stage_root);
        Ok(())
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
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(LocalBackupError::Storage);
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
                .prepare_restore("restore-1".to_owned(), &serde_json::to_vec(&value).unwrap())
                .unwrap_err(),
            LocalBackupError::InvalidManifest
        );
        value.as_object_mut().unwrap().remove("unexpected");
        value["formatVersion"] = serde_json::json!(2);
        assert_eq!(
            service
                .prepare_restore("restore-1".to_owned(), &serde_json::to_vec(&value).unwrap())
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
        source.settings.accept_restored_preferences(preferences);
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
            .prepare_restore("restore-1".to_owned(), &backup.bytes)
            .unwrap();
        let result = destination
            .commit_restore(prepared, LocalRestoreConflictResolution::KeepExisting, 200)
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
        FileProfileRepository::new(source_root.path().to_path_buf())
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
            .prepare_restore("restore-1".to_owned(), &backup.bytes)
            .unwrap();
        assert_eq!(prepared.preview.actions.add, 1);
        destination
            .commit_restore(prepared, LocalRestoreConflictResolution::KeepExisting, 200)
            .unwrap();

        let restored = FileProfileRepository::new(destination_root.path().to_path_buf())
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
            .prepare_restore("restore-1".to_owned(), &backup.bytes)
            .unwrap();
        let mut changed = destination
            .settings
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences;
        changed.language = mish_settings::LanguagePreference::Zh;
        destination.settings.accept_restored_preferences(changed);

        assert_eq!(
            destination
                .commit_restore(prepared, LocalRestoreConflictResolution::KeepExisting, 200,)
                .unwrap_err(),
            LocalBackupError::StateChanged
        );
    }

    #[test]
    fn failed_multi_component_commit_rolls_back_every_completed_rename() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("profiles")).unwrap();
        fs::write(root.path().join("profiles/original"), b"profile-state").unwrap();
        let original_settings = SettingsPreferences::default();
        FileSettingsRepository::new(root.path().join("settings.json"))
            .save(&original_settings)
            .unwrap();
        let mut replacement_settings = original_settings;
        replacement_settings.language = mish_settings::LanguagePreference::Zh;
        let transaction = RestoreTransaction::stage(
            root.path(),
            Some(BTreeMap::new()),
            Some(replacement_settings),
        )
        .unwrap();

        assert_eq!(
            transaction.commit_with_failure(Some(1)).unwrap_err(),
            LocalBackupError::Storage
        );
        assert_eq!(
            fs::read(root.path().join("profiles/original")).unwrap(),
            b"profile-state"
        );
        assert_eq!(
            FileSettingsRepository::new(root.path().join("settings.json"))
                .load()
                .unwrap()
                .preferences,
            original_settings
        );
    }
}
