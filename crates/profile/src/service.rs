use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    AtomicWriter, AttemptOutcome, FileProfileRepository, HttpsSourceReader, ImportError,
    ImportPreflight, ImportRequest, LocalSourceReader, PolicyDisposition, PreflightReport,
    ProfileAttempt, ProfileId, ProfileMetadata, ProfileSource, ProfileSourceType, RepositoryError,
    SourceReadPolicy, StdAtomicWriter, Timestamp, ValidationIssueCode,
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
    pub refresh: ProfileCapabilityAvailability,
    pub save: ProfileCapabilityAvailability,
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
    pub id: String,
    pub label: String,
    pub last_attempt: Option<ProfileAttemptView>,
    pub last_known_valid: bool,
    pub last_success_at: Option<u64>,
    pub source: crate::SourceSummary,
    pub status: crate::ProfileStatus,
    pub warning_codes: Vec<ValidationIssueCode>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub adapter_kind: ProfileAdapterKind,
    pub capabilities: ProfileCapabilities,
    pub profiles: Vec<ProfileListItem>,
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
    pub disabled: usize,
    pub overridden: usize,
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
    https_reader: H,
    local_reader: L,
    pending: Mutex<PendingPreflights>,
    policy: SourceReadPolicy,
    repository: FileProfileRepository<W>,
}

impl<L, H> ProfileService<L, H, StdAtomicWriter>
where
    L: LocalSourceReader,
    H: HttpsSourceReader,
{
    pub fn new(root: PathBuf, local_reader: L, https_reader: H, policy: SourceReadPolicy) -> Self {
        Self {
            https_reader,
            local_reader,
            pending: Mutex::new(PendingPreflights::default()),
            policy,
            repository: FileProfileRepository::new(root),
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
        Self {
            https_reader,
            local_reader,
            pending: Mutex::new(PendingPreflights::default()),
            policy,
            repository: FileProfileRepository::with_writer(root, writer),
        }
    }

    pub fn snapshot(&self) -> Result<ProfileSnapshot, ProfileServiceError> {
        let profiles = self
            .repository
            .list_metadata()?
            .into_iter()
            .map(profile_list_item)
            .collect();
        Ok(ProfileSnapshot {
            adapter_kind: ProfileAdapterKind::Rpc,
            capabilities: ProfileCapabilities {
                activation: ProfileCapabilityAvailability::Unavailable,
                deletion: ProfileCapabilityAvailability::Supported,
                https_import: ProfileCapabilityAvailability::Supported,
                local_file_import: ProfileCapabilityAvailability::PermissionRequired,
                refresh: ProfileCapabilityAvailability::Supported,
                save: ProfileCapabilityAvailability::Supported,
            },
            profiles,
        })
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
        let report = self.take_pending(preview_id).await?;
        let record = report.into_record(ProfileId::new(), Timestamp::now());
        self.repository.save(&record)?;
        self.snapshot()
    }

    pub async fn refresh(&self, profile_id: &str) -> Result<ProfileSnapshot, ProfileServiceError> {
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        let current = self.repository.load(&id)?;
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
                let mut refreshed = report.into_record(id, Timestamp::now());
                refreshed.metadata.provenance.imported_at = current.metadata.provenance.imported_at;
                self.repository.update(&refreshed)?;
                self.snapshot()
            }
            Err(error) => {
                let mut failed = current;
                failed.metadata.last_attempt = Some(ProfileAttempt {
                    attempted_at: Timestamp::now(),
                    outcome: AttemptOutcome::Failed,
                });
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
        Ok(self.repository.load(&id)?)
    }

    pub fn delete(&self, profile_id: &str) -> Result<ProfileSnapshot, ProfileServiceError> {
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
        self.repository.delete(&id)?;
        self.snapshot()
    }

    pub fn delete_authorized(
        &self,
        profile_id: &str,
        active_profile_id: Option<&str>,
    ) -> Result<ProfileSnapshot, ProfileServiceError> {
        if active_profile_id == Some(profile_id) {
            return Err(ProfileServiceError::ActiveProfileDeletionDisabled);
        }
        let id = ProfileId::parse(profile_id.to_owned()).map_err(|_| RepositoryError::NotFound)?;
        self.repository.delete(&id)?;
        self.snapshot()
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

fn profile_list_item(metadata: ProfileMetadata) -> ProfileListItem {
    let warning_codes = metadata
        .validation
        .warnings
        .iter()
        .map(|warning| warning.code)
        .collect();
    ProfileListItem {
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
        source: metadata.provenance.source,
        status: metadata.status,
        warning_codes,
    }
}

fn profile_preview(preview_id: &str, report: &PreflightReport) -> ProfilePreview {
    let mut counts = PreviewClassificationCounts {
        disabled: 0,
        overridden: 0,
        preserved: 0,
        rejected: 0,
    };
    for classification in &report.classifications {
        match classification.disposition {
            PolicyDisposition::Disabled => counts.disabled += 1,
            PolicyDisposition::Overridden => counts.overridden += 1,
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
