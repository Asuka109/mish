use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

use mish_state_authority::{StateMutationAuthority, StateMutationPermit};
use serde::Serialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    AtomicWriter, AttemptOutcome, FileProfileRepository, Fingerprint, HttpsSourceReader,
    ImportError, ImportPreflight, ImportRequest, LocalSourceReader, PolicyDisposition,
    PreflightReport, ProfileAttempt, ProfileId, ProfilePatch, ProfilePatchEditor,
    ProfilePatchError, ProfileRefreshPolicy, ProfileRefreshState, ProfileSelectionAuthority,
    ProfileSelectionSnapshot, ProfileSource, ProfileSourceType, ProfileSuccess, RepositoryError,
    RevisionId, SourceReadPolicy, StdAtomicWriter, Timestamp, ValidationIssueCode,
};

const MAX_PENDING_PREFLIGHTS: usize = 4;
const PREFLIGHT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileAdapterKind {
    Rpc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileCapabilityAvailability {
    Supported,
    PermissionRequired,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCapabilities {
    pub activation: ProfileCapabilityAvailability,
    pub deletion: ProfileCapabilityAvailability,
    pub https_import: ProfileCapabilityAvailability,
    pub local_file_import: ProfileCapabilityAvailability,
    pub patches: ProfileCapabilityAvailability,
    pub refresh: ProfileCapabilityAvailability,
    pub scheduling: ProfileCapabilityAvailability,
    pub save: ProfileCapabilityAvailability,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRefreshStateView {
    pub consecutive_failures: u8,
    pub last_failure_at: Option<u64>,
    pub last_success_at: Option<u64>,
    pub next_run_at: Option<u64>,
    pub policy: ProfileRefreshPolicy,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAttemptView {
    pub attempted_at: u64,
    pub outcome: AttemptOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileListItem {
    pub effective_fingerprint: String,
    pub file_name: String,
    pub id: String,
    pub label: String,
    pub last_attempt: Option<ProfileAttemptView>,
    pub last_known_valid: bool,
    pub last_success_at: Option<u64>,
    pub refresh: ProfileRefreshStateView,
    pub source: crate::SourceSummary,
    pub status: crate::ProfileStatus,
    pub runtime_provenance: crate::RuntimeProvenanceReview,
    pub warning_codes: Vec<ValidationIssueCode>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub adapter_kind: ProfileAdapterKind,
    pub capabilities: ProfileCapabilities,
    pub profiles: Vec<ProfileListItem>,
    pub selection: ProfileSelectionSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewSensitiveDataNotice {
    None,
    SourceUrlContainsSensitiveData,
    ConfigurationContainsSensitiveData,
    SourceAndConfigurationContainSensitiveData,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewClassificationCounts {
    pub application_overridden: usize,
    pub disabled: usize,
    pub platform_overridden: usize,
    pub preserved: usize,
    pub rejected: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreview {
    pub classification_counts: PreviewClassificationCounts,
    pub group_count: usize,
    pub label: String,
    pub preview_id: String,
    pub proxy_count: usize,
    pub rule_count: usize,
    pub runtime_provenance: crate::RuntimeProvenanceReview,
    pub sensitive_data_notice: PreviewSensitiveDataNotice,
    pub source_type: ProfileSourceType,
    pub warning_codes: Vec<ValidationIssueCode>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileServiceError {
    #[error("profile import could not be validated")]
    Import(#[source] ImportError),
    #[error("profile storage operation failed")]
    Repository(#[source] RepositoryError),
    #[error("profile preflight is no longer available")]
    PreviewNotFound,
    #[error("active profiles cannot be deleted until transactional activation is available")]
    ActiveProfileDeletionDisabled,
    #[error("scheduled refresh is available only for HTTPS profile sources")]
    SchedulingUnavailable,
    #[error("another Profile or Settings mutation is in progress")]
    Busy,
    #[error(transparent)]
    Patch(#[from] ProfilePatchError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileRefreshTrigger {
    Manual,
    Scheduled,
}

impl From<ImportError> for ProfileServiceError {
    fn from(error: ImportError) -> Self {
        Self::Import(error)
    }
}

impl From<RepositoryError> for ProfileServiceError {
    fn from(error: RepositoryError) -> Self {
        Self::Repository(error)
    }
}

struct PendingPreflight {
    created_at: Instant,
    report: PreflightReport,
}

#[derive(Default)]
struct PendingPreflights {
    order: VecDeque<String>,
    reports: HashMap<String, PendingPreflight>,
}

pub struct ProfileService<L, H, W = StdAtomicWriter> {
    authority: StateMutationAuthority,
    profile_directory: PathBuf,
    https_reader: H,
    local_reader: L,
    observed_directory_revisions: Mutex<HashMap<String, RevisionId>>,
    pending: Mutex<PendingPreflights>,
    policy: SourceReadPolicy,
    repository: FileProfileRepository<W>,
    selection: ProfileSelectionAuthority,
}

impl<L, H> ProfileService<L, H, StdAtomicWriter>
where
    L: LocalSourceReader,
    H: HttpsSourceReader,
{
    pub fn new(root: PathBuf, local_reader: L, https_reader: H, policy: SourceReadPolicy) -> Self {
        Self::with_authority(
            root,
            local_reader,
            https_reader,
            policy,
            StateMutationAuthority::new(),
        )
    }

    pub fn with_authority(
        root: PathBuf,
        local_reader: L,
        https_reader: H,
        policy: SourceReadPolicy,
        authority: StateMutationAuthority,
    ) -> Self {
        let profile_directory = root.join("profiles");
        let selection = ProfileSelectionAuthority::load(&root);
        Self {
            authority,
            profile_directory,
            https_reader,
            local_reader,
            observed_directory_revisions: Mutex::new(HashMap::new()),
            pending: Mutex::new(PendingPreflights::default()),
            policy,
            repository: FileProfileRepository::new(root.join("profile-store")),
            selection,
        }
    }
}

impl<L, H, W> ProfileService<L, H, W>
where
    L: LocalSourceReader,
    H: HttpsSourceReader,
    W: AtomicWriter,
{
    pub fn with_writer(
        root: PathBuf,
        local_reader: L,
        https_reader: H,
        policy: SourceReadPolicy,
        writer: W,
    ) -> Self {
        let profile_directory = root.join("profiles");
        let selection = ProfileSelectionAuthority::load(&root);
        Self {
            authority: StateMutationAuthority::new(),
            profile_directory,
            https_reader,
            local_reader,
            observed_directory_revisions: Mutex::new(HashMap::new()),
            pending: Mutex::new(PendingPreflights::default()),
            policy,
            repository: FileProfileRepository::with_writer(root.join("profile-store"), writer),
            selection,
        }
    }

    pub fn snapshot(&self) -> Result<ProfileSnapshot, ProfileServiceError> {
        let profiles = self
            .repository
            .list_metadata_with_effective_fingerprints()?
            .into_iter()
            .map(|(metadata, effective_fingerprint)| {
                let source = self.repository.load(&metadata.id)?.source.display_summary();
                Ok(profile_list_item(metadata, effective_fingerprint, source))
            })
            .collect::<Result<Vec<_>, RepositoryError>>()?;
        let selection = self.selection.reconcile(&profiles)?;
        Ok(ProfileSnapshot {
            adapter_kind: ProfileAdapterKind::Rpc,
            capabilities: ProfileCapabilities {
                activation: ProfileCapabilityAvailability::Unavailable,
                deletion: ProfileCapabilityAvailability::Supported,
                https_import: ProfileCapabilityAvailability::Supported,
                local_file_import: ProfileCapabilityAvailability::PermissionRequired,
                patches: ProfileCapabilityAvailability::Supported,
                refresh: ProfileCapabilityAvailability::Supported,
                scheduling: ProfileCapabilityAvailability::Supported,
                save: ProfileCapabilityAvailability::Supported,
            },
            profiles,
            selection,
        })
    }

    pub fn confirmed_selection(&self) -> Result<ProfileSelectionSnapshot, ProfileServiceError> {
        Ok(self.snapshot()?.selection)
    }

    pub async fn select_profile(
        &self,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        let permit = self
            .authority
            .acquire()
            .await
            .map_err(|_| ProfileServiceError::Busy)?;
        self.validate_permit(&permit)?;
        let profiles = self.snapshot()?.profiles;
        self.selection.select(&profiles, profile_id)?;
        self.snapshot()
    }

    pub fn mutation_authority(&self) -> StateMutationAuthority {
        self.authority.clone()
    }

    pub async fn preflight_https(
        &self,
        url: &str,
        label: Option<String>,
    ) -> Result<ProfilePreview, ProfileServiceError> {
        let source = ProfileSource::https(url)
            .map_err(|error| ProfileServiceError::Import(ImportError::SourceValidation(error)))?;
        self.preflight(source, label).await
    }

    pub async fn preflight_local(
        &self,
        path: PathBuf,
        label: Option<String>,
    ) -> Result<ProfilePreview, ProfileServiceError> {
        let source = ProfileSource::local_file(path)
            .map_err(|error| ProfileServiceError::Import(ImportError::SourceValidation(error)))?;
        self.preflight(source, label).await
    }

    pub async fn save_preview(
        &self,
        preview_id: &str,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        let permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        self.save_preview_authorized(&permit, preview_id).await
    }

    pub async fn save_preview_authorized(
        &self,
        permit: &StateMutationPermit,
        preview_id: &str,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        self.validate_permit(permit)?;
        let report = self.take_pending(preview_id).await?;
        let mut record = report.into_record(ProfileId::new(), Timestamp::now());
        let materialized_path = self.materialized_path(&record)?;
        if materialized_path.exists() {
            return Err(RepositoryError::AlreadyExists.into());
        }
        self.write_materialized(&record)?;
        if record.source.source_type() == ProfileSourceType::LocalFile {
            record.source = ProfileSource::local_file(materialized_path.clone())
                .map_err(ImportError::SourceValidation)?;
            record.metadata.provenance.source = record.source.safe_summary();
        }
        if let Err(error) = self.repository.save(&record) {
            let _ = remove_materialized_file(&materialized_path);
            return Err(error.into());
        }
        self.snapshot()
    }

    pub async fn refresh(&self, profile_id: &str) -> Result<ProfileSnapshot, ProfileServiceError> {
        let permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        self.refresh_authorized(&permit, profile_id, ProfileRefreshTrigger::Manual)
            .await
    }

    pub async fn refresh_scheduled(
        &self,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        let permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        self.refresh_authorized(&permit, profile_id, ProfileRefreshTrigger::Scheduled)
            .await
    }

    pub async fn refresh_authorized(
        &self,
        permit: &StateMutationPermit,
        profile_id: &str,
        trigger: ProfileRefreshTrigger,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        self.validate_permit(permit)?;
        self.refresh_with_trigger(profile_id, trigger).await
    }

    pub fn mark_refresh_pending_authorized(
        &self,
        permit: &StateMutationPermit,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        self.validate_permit(permit)?;
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let mut current = self.repository.load(&id)?;
        current.metadata.status.updating = true;
        self.repository.update(&current)?;
        self.snapshot()
    }

    pub fn set_refresh_policy(
        &self,
        profile_id: &str,
        policy: ProfileRefreshPolicy,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        let permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        self.set_refresh_policy_authorized(&permit, profile_id, policy)
    }

    pub fn detach_subscription(
        &self,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        let _permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let mut current = self.repository.load(&id)?;
        if current.source.source_type() != ProfileSourceType::Https {
            return Err(ProfileServiceError::SchedulingUnavailable);
        }
        let path = self.materialized_path(&current)?;
        current.source = ProfileSource::local_file(path).map_err(ImportError::SourceValidation)?;
        current.metadata.provenance.source = current.source.safe_summary();
        current.metadata.refresh = ProfileRefreshState::default();
        self.repository.replace_source(&current)?;
        self.snapshot()
    }

    pub fn set_refresh_policy_authorized(
        &self,
        permit: &StateMutationPermit,
        profile_id: &str,
        policy: ProfileRefreshPolicy,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        self.validate_permit(permit)?;
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let mut current = self.repository.load(&id)?;
        if current.source.source_type() != ProfileSourceType::Https
            && policy != ProfileRefreshPolicy::Off
        {
            return Err(ProfileServiceError::SchedulingUnavailable);
        }
        current.metadata.refresh.policy = policy;
        current.metadata.refresh.consecutive_failures = 0;
        current.metadata.refresh.next_run_at = next_regular_run(policy, Timestamp::now());
        self.repository.update(&current)?;
        self.snapshot()
    }

    pub fn due_scheduled_profile_ids(
        &self,
        now: Timestamp,
    ) -> Result<Vec<String>, ProfileServiceError> {
        Ok(self
            .repository
            .list_metadata()?
            .into_iter()
            .filter(|metadata| {
                metadata.provenance.source.source_type == ProfileSourceType::Https
                    && metadata.refresh.policy != ProfileRefreshPolicy::Off
                    && metadata.refresh.next_run_at.is_some_and(|next| next <= now)
            })
            .map(|metadata| metadata.id.as_str().to_owned())
            .collect())
    }

    pub async fn reconcile_profile_directory(&self) -> Result<bool, ProfileServiceError> {
        let _permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        fs::create_dir_all(&self.profile_directory)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        let directory_metadata = fs::symlink_metadata(&self.profile_directory)
            .map_err(|_| RepositoryError::ReadFailed)?;
        if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
            return Err(RepositoryError::UnsafeStoragePath.into());
        }

        let mut records = HashMap::new();
        for metadata in self.repository.list_metadata()? {
            let record = self.repository.load(&metadata.id)?;
            records.insert(
                profile_file_name(&record.metadata.label, &record.source.display_summary()),
                record,
            );
        }

        let mut paths = fs::read_dir(&self.profile_directory)
            .map_err(|_| RepositoryError::ReadFailed)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| is_yaml_path(path))
            .collect::<Vec<_>>();
        paths.sort();

        let preflight =
            ImportPreflight::new(&self.local_reader, &self.https_reader, self.policy.clone());
        let observed = self.observed_directory_revisions.lock().await.clone();
        let mut next_observed = HashMap::new();
        let mut changed = false;
        for path in paths {
            match fs::symlink_metadata(&path) {
                Ok(metadata)
                    if metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && metadata.len() <= self.policy.max_bytes as u64 => {}
                _ => continue,
            }
            let Some(file_name) = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
            else {
                continue;
            };
            let source_bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let source_revision = RevisionId::from_source(&source_bytes);
            let current = records.remove(&file_name);
            next_observed.insert(file_name.clone(), source_revision.clone());
            if observed.get(&file_name) == Some(&source_revision)
                || current.as_ref().is_some_and(|record| {
                    source_revision == record.metadata.revision.id && !record.metadata.status.error
                })
            {
                continue;
            }
            let source = match ProfileSource::local_file(path.clone()) {
                Ok(source) => source,
                Err(_) => continue,
            };
            let report = preflight
                .run(ImportRequest {
                    label: Some(file_name),
                    source,
                })
                .await;
            match (current, report) {
                (None, Ok(report)) => {
                    let record = report.into_record(ProfileId::new(), Timestamp::now());
                    self.repository.save(&record)?;
                    changed = true;
                }
                (Some(current), Ok(report)) => {
                    let completed_at = Timestamp::now();
                    let mut refreshed =
                        report.into_record(current.metadata.id.clone(), completed_at);
                    refreshed.metadata.provenance.imported_at =
                        current.metadata.provenance.imported_at;
                    refreshed.metadata.status.active = current.metadata.status.active;
                    if current.source.source_type() == ProfileSourceType::Https {
                        refreshed.source = current.source.clone();
                        refreshed.metadata.provenance.source = current.source.safe_summary();
                        refreshed.metadata.refresh = current.metadata.refresh.clone();
                    }
                    match crate::bind_and_apply_profile_patches(
                        &refreshed.normalized_bytes,
                        &refreshed.metadata.revision.id,
                        &refreshed.metadata.artifact.fingerprint,
                        current.patches.patches.clone(),
                    ) {
                        Ok((patches, _)) => {
                            refreshed.patches = patches;
                            if refreshed.source == current.source {
                                self.repository.update(&refreshed)?;
                            } else {
                                self.repository.replace_source(&refreshed)?;
                            }
                        }
                        Err(_) => self.mark_directory_profile_invalid(current)?,
                    }
                    changed = true;
                }
                (Some(current), Err(_)) => {
                    self.mark_directory_profile_invalid(current)?;
                    changed = true;
                }
                (None, Err(_)) => {}
            }
        }

        for (file_name, mut record) in records {
            if record.metadata.status.active {
                if !record.metadata.status.error || !record.metadata.status.stale {
                    record.metadata.status.error = true;
                    record.metadata.status.stale = true;
                    self.repository.update(&record)?;
                    changed = true;
                }
            } else {
                self.repository.delete(&record.metadata.id)?;
                changed = true;
            }
            next_observed.remove(&file_name);
        }
        *self.observed_directory_revisions.lock().await = next_observed;
        Ok(changed)
    }

    fn mark_directory_profile_invalid(
        &self,
        mut record: crate::ProfileRecord,
    ) -> Result<(), RepositoryError> {
        record.metadata.last_attempt = Some(ProfileAttempt {
            attempted_at: Timestamp::now(),
            outcome: AttemptOutcome::Failed,
        });
        record.metadata.status.error = true;
        record.metadata.status.stale = true;
        record.metadata.status.updating = false;
        record.metadata.status.valid = record.metadata.last_success.is_some();
        self.repository.update(&record)
    }

    async fn refresh_with_trigger(
        &self,
        profile_id: &str,
        trigger: ProfileRefreshTrigger,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let mut current = self.repository.load(&id)?;
        current.metadata.status.updating = true;
        self.repository.update(&current)?;
        let source = current.source.clone();
        let label = current.metadata.label.clone();
        let preflight =
            ImportPreflight::new(&self.local_reader, &self.https_reader, self.policy.clone());
        match preflight
            .run(ImportRequest {
                label: Some(label),
                source,
            })
            .await
        {
            Ok(report) => {
                let completed_at = Timestamp::now();
                let mut refreshed = report.into_record(id, completed_at);
                refreshed.metadata.provenance.imported_at = current.metadata.provenance.imported_at;
                refreshed.metadata.refresh = current.metadata.refresh;
                match crate::bind_and_apply_profile_patches(
                    &refreshed.normalized_bytes,
                    &refreshed.metadata.revision.id,
                    &refreshed.metadata.artifact.fingerprint,
                    current.patches.patches.clone(),
                ) {
                    Ok((patches, _)) => refreshed.patches = patches,
                    Err(error) => {
                        refreshed.patches = current.patches;
                        refreshed.metadata.last_success = current.metadata.last_success;
                        refreshed.metadata.last_attempt = Some(ProfileAttempt {
                            attempted_at: completed_at,
                            outcome: AttemptOutcome::Failed,
                        });
                        refreshed.metadata.refresh.last_failure_at = Some(completed_at);
                        if trigger == ProfileRefreshTrigger::Scheduled {
                            refreshed.metadata.refresh.consecutive_failures = refreshed
                                .metadata
                                .refresh
                                .consecutive_failures
                                .saturating_add(1);
                            refreshed.metadata.refresh.next_run_at =
                                next_backed_off_run(&refreshed.metadata.refresh, completed_at);
                        } else if refreshed.metadata.refresh.policy != ProfileRefreshPolicy::Off {
                            refreshed.metadata.refresh.next_run_at =
                                next_regular_run(refreshed.metadata.refresh.policy, completed_at);
                        }
                        refreshed.metadata.status.error = true;
                        refreshed.metadata.status.stale = true;
                        refreshed.metadata.status.updating = false;
                        refreshed.metadata.status.valid = false;
                        self.repository.update(&refreshed)?;
                        return Err(ProfileServiceError::Patch(error));
                    }
                }
                refreshed.metadata.refresh.consecutive_failures = 0;
                refreshed.metadata.refresh.last_success_at = Some(completed_at);
                refreshed.metadata.refresh.next_run_at =
                    next_regular_run(refreshed.metadata.refresh.policy, completed_at);
                self.write_materialized(&refreshed)?;
                self.repository.update(&refreshed)?;
                self.snapshot()
            }
            Err(error) => {
                let mut failed = current;
                let completed_at = Timestamp::now();
                failed.metadata.last_attempt = Some(ProfileAttempt {
                    attempted_at: completed_at,
                    outcome: AttemptOutcome::Failed,
                });
                failed.metadata.refresh.last_failure_at = Some(completed_at);
                if trigger == ProfileRefreshTrigger::Scheduled {
                    failed.metadata.refresh.consecutive_failures = failed
                        .metadata
                        .refresh
                        .consecutive_failures
                        .saturating_add(1);
                    failed.metadata.refresh.next_run_at =
                        next_backed_off_run(&failed.metadata.refresh, completed_at);
                } else if failed.metadata.refresh.policy != ProfileRefreshPolicy::Off {
                    failed.metadata.refresh.next_run_at =
                        next_regular_run(failed.metadata.refresh.policy, completed_at);
                }
                failed.metadata.status.error = true;
                failed.metadata.status.stale = true;
                failed.metadata.status.updating = false;
                failed.metadata.status.valid = failed.metadata.last_success.is_some();
                self.repository.update(&failed)?;
                Err(ProfileServiceError::Import(error))
            }
        }
    }

    pub fn activation_record(
        &self,
        profile_id: &str,
    ) -> Result<crate::ProfileRecord, ProfileServiceError> {
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let record = self.repository.load(&id)?;
        crate::apply_profile_patches(
            &record.normalized_bytes,
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
            &record.patches,
        )?;
        Ok(record)
    }

    pub fn route_catalog(
        &self,
        profile_id: &str,
    ) -> Result<crate::ProfileRouteCatalog, ProfileServiceError> {
        let record = self.activation_record(profile_id)?;
        Ok(crate::profile_route_catalog(&record)?)
    }

    pub fn patch_editor(
        &self,
        profile_id: &str,
        source_revision: &str,
        artifact_fingerprint: &str,
    ) -> Result<ProfilePatchEditor, ProfileServiceError> {
        let record =
            self.authorized_patch_record(profile_id, source_revision, artifact_fingerprint)?;
        Ok(crate::profile_patch_editor(
            &record.metadata.id,
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
            &record.normalized_bytes,
            &record.patches,
        )?)
    }

    pub fn replace_patches(
        &self,
        profile_id: &str,
        source_revision: &str,
        artifact_fingerprint: &str,
        patches: Vec<ProfilePatch>,
    ) -> Result<ProfilePatchEditor, ProfileServiceError> {
        let permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        self.replace_patches_authorized(
            &permit,
            profile_id,
            source_revision,
            artifact_fingerprint,
            patches,
        )
    }

    pub fn replace_patches_authorized(
        &self,
        permit: &StateMutationPermit,
        profile_id: &str,
        source_revision: &str,
        artifact_fingerprint: &str,
        patches: Vec<ProfilePatch>,
    ) -> Result<ProfilePatchEditor, ProfileServiceError> {
        self.validate_permit(permit)?;
        let mut record =
            self.authorized_patch_record(profile_id, source_revision, artifact_fingerprint)?;
        let (patch_set, _) = crate::bind_and_apply_profile_patches(
            &record.normalized_bytes,
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
            patches,
        )?;
        record.patches = patch_set;
        let completed_at = Timestamp::now();
        record.metadata.last_attempt = Some(ProfileAttempt {
            attempted_at: completed_at,
            outcome: AttemptOutcome::Succeeded,
        });
        record.metadata.last_success = Some(ProfileSuccess {
            fingerprint: record.metadata.artifact.fingerprint.clone(),
            revision_id: record.metadata.revision.id.clone(),
            succeeded_at: completed_at,
        });
        record.metadata.status.error = false;
        record.metadata.status.stale = false;
        record.metadata.status.valid = true;
        self.repository.update(&record)?;
        Ok(crate::profile_patch_editor(
            &record.metadata.id,
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
            &record.normalized_bytes,
            &record.patches,
        )?)
    }

    fn authorized_patch_record(
        &self,
        profile_id: &str,
        source_revision: &str,
        artifact_fingerprint: &str,
    ) -> Result<crate::ProfileRecord, ProfileServiceError> {
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let record = self.repository.load(&id)?;
        let revision = RevisionId::from_source(&record.source_bytes);
        let fingerprint = Fingerprint::from_normalized_artifact(&record.normalized_bytes);
        if revision.as_str() != source_revision
            || fingerprint.as_str() != artifact_fingerprint
            || revision != record.metadata.revision.id
            || fingerprint != record.metadata.artifact.fingerprint
        {
            return Err(ProfilePatchError::StaleAuthority.into());
        }
        Ok(record)
    }

    pub fn delete(&self, profile_id: &str) -> Result<ProfileSnapshot, ProfileServiceError> {
        let permit = self
            .authority
            .try_acquire()
            .map_err(|_| ProfileServiceError::Busy)?;
        self.delete_with_permit(&permit, profile_id)
    }

    fn delete_with_permit(
        &self,
        permit: &StateMutationPermit,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        self.validate_permit(permit)?;
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let metadata = self
            .repository
            .list_metadata()?
            .into_iter()
            .find(|metadata| metadata.id == id)
            .ok_or(RepositoryError::NotFound)?;
        if metadata.status.active {
            return Err(ProfileServiceError::ActiveProfileDeletionDisabled);
        }
        let record = self.repository.load(&id)?;
        let materialized_path = self.materialized_path(&record)?;
        self.repository.delete(&id)?;
        remove_materialized_file(&materialized_path)?;
        self.snapshot()
    }

    pub fn delete_authorized(
        &self,
        permit: &StateMutationPermit,
        profile_id: &str,
        active_profile_id: Option<&str>,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        self.validate_permit(permit)?;
        if active_profile_id == Some(profile_id) {
            return Err(ProfileServiceError::ActiveProfileDeletionDisabled);
        }
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let record = self.repository.load(&id)?;
        let materialized_path = self.materialized_path(&record)?;
        self.repository.delete(&id)?;
        remove_materialized_file(&materialized_path)?;
        self.snapshot()
    }

    fn validate_permit(&self, permit: &StateMutationPermit) -> Result<(), ProfileServiceError> {
        self.authority
            .validate(permit)
            .map_err(|_| ProfileServiceError::Busy)
    }

    fn materialized_path(&self, record: &crate::ProfileRecord) -> Result<PathBuf, RepositoryError> {
        let file_name = profile_file_name(&record.metadata.label, &record.source.display_summary());
        let path = Path::new(&file_name);
        if path.components().count() != 1
            || !matches!(path.components().next(), Some(Component::Normal(_)))
            || !matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("yaml" | "yml")
            )
        {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        Ok(self.profile_directory.join(path))
    }

    fn write_materialized(&self, record: &crate::ProfileRecord) -> Result<(), RepositoryError> {
        fs::create_dir_all(&self.profile_directory)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        let directory_metadata = fs::symlink_metadata(&self.profile_directory)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        StdAtomicWriter
            .write(&self.materialized_path(record)?, &record.source_bytes)
            .map_err(|_| RepositoryError::AtomicWriteFailed)
    }

    async fn preflight(
        &self,
        source: ProfileSource,
        label: Option<String>,
    ) -> Result<ProfilePreview, ProfileServiceError> {
        let report =
            ImportPreflight::new(&self.local_reader, &self.https_reader, self.policy.clone())
                .run(ImportRequest { label, source })
                .await?;
        self.store_pending(report).await
    }

    async fn store_pending(
        &self,
        report: PreflightReport,
    ) -> Result<ProfilePreview, ProfileServiceError> {
        let preview_id = Uuid::new_v4().to_string();
        let preview = profile_preview(&preview_id, &report);
        let mut pending = self.pending.lock().await;
        pending.remove_expired();
        while pending.reports.len() >= MAX_PENDING_PREFLIGHTS {
            let Some(expired_id) = pending.order.pop_front() else {
                break;
            };
            pending.reports.remove(&expired_id);
        }
        pending.order.push_back(preview_id.clone());
        pending.reports.insert(
            preview_id,
            PendingPreflight {
                created_at: Instant::now(),
                report,
            },
        );
        Ok(preview)
    }

    async fn take_pending(&self, preview_id: &str) -> Result<PreflightReport, ProfileServiceError> {
        let mut pending = self.pending.lock().await;
        pending.remove_expired();
        pending.order.retain(|id| id != preview_id);
        pending
            .reports
            .remove(preview_id)
            .map(|pending| pending.report)
            .ok_or(ProfileServiceError::PreviewNotFound)
    }
}

impl PendingPreflights {
    fn remove_expired(&mut self) {
        let now = Instant::now();
        self.reports
            .retain(|_, pending| now.duration_since(pending.created_at) <= PREFLIGHT_TTL);
        self.order.retain(|id| self.reports.contains_key(id));
    }
}

fn profile_list_item(
    metadata: crate::ProfileMetadata,
    effective_fingerprint: Fingerprint,
    source: crate::SourceSummary,
) -> ProfileListItem {
    let warning_codes = metadata
        .validation
        .warnings
        .iter()
        .map(|warning| warning.code)
        .collect();
    ProfileListItem {
        effective_fingerprint: effective_fingerprint.as_str().to_owned(),
        file_name: profile_file_name(&metadata.label, &source),
        id: metadata.id.as_str().to_owned(),
        label: metadata.label,
        last_attempt: metadata.last_attempt.map(|attempt| ProfileAttemptView {
            attempted_at: attempt.attempted_at.as_unix_milliseconds(),
            outcome: attempt.outcome,
        }),
        last_known_valid: metadata.last_success.is_some(),
        last_success_at: metadata
            .last_success
            .map(|success| success.succeeded_at.as_unix_milliseconds()),
        refresh: ProfileRefreshStateView {
            consecutive_failures: metadata.refresh.consecutive_failures,
            last_failure_at: metadata
                .refresh
                .last_failure_at
                .map(Timestamp::as_unix_milliseconds),
            last_success_at: metadata
                .refresh
                .last_success_at
                .map(Timestamp::as_unix_milliseconds),
            next_run_at: metadata
                .refresh
                .next_run_at
                .map(Timestamp::as_unix_milliseconds),
            policy: metadata.refresh.policy,
        },
        source,
        status: metadata.status,
        runtime_provenance: metadata.runtime_provenance,
        warning_codes,
    }
}

fn profile_file_name(label: &str, source: &crate::SourceSummary) -> String {
    if source.source_type == crate::ProfileSourceType::LocalFile {
        return source.display.clone();
    }
    let trimmed = label.trim();
    if trimmed.ends_with(".yaml") || trimmed.ends_with(".yml") {
        return trimmed.to_owned();
    }
    format!("{trimmed}.yaml")
}

fn remove_materialized_file(path: &Path) -> Result<(), RepositoryError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(RepositoryError::AtomicWriteFailed),
    }
}

fn is_yaml_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("yaml" | "yml")
    )
}

fn next_regular_run(policy: ProfileRefreshPolicy, completed_at: Timestamp) -> Option<Timestamp> {
    policy.interval_milliseconds().map(|interval| {
        Timestamp::from_unix_milliseconds(
            completed_at.as_unix_milliseconds().saturating_add(interval),
        )
    })
}

fn next_backed_off_run(
    refresh: &ProfileRefreshState,
    completed_at: Timestamp,
) -> Option<Timestamp> {
    let interval = refresh.policy.interval_milliseconds()?;
    let multiplier = 1_u64 << refresh.consecutive_failures.min(3);
    Some(Timestamp::from_unix_milliseconds(
        completed_at
            .as_unix_milliseconds()
            .saturating_add(interval.saturating_mul(multiplier)),
    ))
}

fn profile_preview(preview_id: &str, report: &PreflightReport) -> ProfilePreview {
    let mut counts = PreviewClassificationCounts {
        application_overridden: 0,
        disabled: 0,
        platform_overridden: 0,
        preserved: 0,
        rejected: 0,
    };
    for classification in &report.classifications {
        match classification.disposition {
            PolicyDisposition::Disabled => counts.disabled += 1,
            PolicyDisposition::ApplicationOverridden => counts.application_overridden += 1,
            PolicyDisposition::PlatformOverridden => counts.platform_overridden += 1,
            PolicyDisposition::Preserved => counts.preserved += 1,
            PolicyDisposition::Rejected => counts.rejected += 1,
        }
    }
    ProfilePreview {
        classification_counts: counts,
        group_count: report.summary.group_count,
        label: report.summary.label.clone(),
        preview_id: preview_id.to_owned(),
        proxy_count: report.summary.proxy_count,
        rule_count: report.summary.rule_count,
        runtime_provenance: report.provenance_review.clone(),
        sensitive_data_notice: match report.summary.sensitive_data_notice {
            crate::SensitiveDataNotice::None => PreviewSensitiveDataNotice::None,
            crate::SensitiveDataNotice::SourceUrlContainsSensitiveData => {
                PreviewSensitiveDataNotice::SourceUrlContainsSensitiveData
            }
            crate::SensitiveDataNotice::ConfigurationContainsSensitiveData => {
                PreviewSensitiveDataNotice::ConfigurationContainsSensitiveData
            }
            crate::SensitiveDataNotice::SourceAndConfigurationContainSensitiveData => {
                PreviewSensitiveDataNotice::SourceAndConfigurationContainSensitiveData
            }
        },
        source_type: report.summary.source_type,
        warning_codes: report
            .summary
            .warnings
            .iter()
            .map(|warning| warning.code)
            .collect(),
    }
}

impl<T> LocalSourceReader for &T
where
    T: LocalSourceReader,
{
    fn read<'a>(
        &'a self,
        path: &'a crate::SensitivePath,
        policy: &'a SourceReadPolicy,
    ) -> futures_util::future::BoxFuture<'a, Result<crate::SourceContent, crate::SourceReadError>>
    {
        (*self).read(path, policy)
    }
}

impl<T> HttpsSourceReader for &T
where
    T: HttpsSourceReader,
{
    fn read<'a>(
        &'a self,
        url: &'a crate::SensitiveUrl,
        policy: &'a SourceReadPolicy,
    ) -> futures_util::future::BoxFuture<'a, Result<crate::SourceContent, crate::SourceReadError>>
    {
        (*self).read(url, policy)
    }
}
