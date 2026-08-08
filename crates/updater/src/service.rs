use std::{
    cmp::Ordering,
    collections::{BTreeSet, VecDeque},
    fmt,
    fs::{self, File, OpenOptions},
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use mish_state_machine::{
    Disposition, EffectExecutor as KernelEffectExecutor, Machine as _, RunnerConfig, RunnerHandle,
    TransitionObserver, spawn_runner,
};
use reqwest::{
    Client, RequestBuilder, Response, StatusCode,
    header::{
        ACCEPT, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE,
        LOCATION, RANGE, USER_AGENT,
    },
};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncWriteExt,
    sync::broadcast,
    time::{timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::{
    UpdateChannel, UpdatePolicy, UpdaterAdapter, UpdaterError, VerifiedMetadata,
    VerifyMetadataRequest, parse_version, validate_channel_version,
};

mod check_machine;
mod continuation_machine;
mod install_adapter;
use check_machine::{
    CheckCompletion, CheckEffect, CheckEffectOutcome, CheckInput, CheckMachine, CheckOperation,
    CheckProjection, CheckState, CheckTaskFailure,
};
use continuation_machine::{
    ContinuationCompletion, ContinuationEffect, ContinuationEffectOutcome, ContinuationInput,
    ContinuationMachine, ContinuationOperation, ContinuationState, ContinuationTaskFailure,
    EffectCorrelation as ContinuationCorrelation, MachineProgress,
};
pub use install_adapter::{
    LocalCandidateInstallAdapter, LocalInstallError, LocalInstallEvidence, LocalInstallRequest,
    LocalInstallSeam, LocalInstallSeamError,
};

const STORE_SCHEMA_VERSION: u8 = 1;
const CANDIDATE_SCHEMA_VERSION: u8 = 2;
const RECOVERY_SCHEMA_VERSION: u8 = 1;
const STORE_ENTRY_LIMIT: usize = 64;
const ACCEPTED_METADATA_LIMIT: usize = 32;
const STATE_FILE: &str = "state.json";
const RECOVERY_FILE: &str = "recovery.json";
const ACCEPTED_FILE: &str = "accepted.json";
const PARTIAL_DIRECTORY: &str = "partial";
const PARTIAL_PAYLOAD: &str = "payload.part";
const PARTIAL_MANIFEST: &str = "manifest.json";
const CANDIDATE_DIRECTORY: &str = "candidate";
const CANDIDATE_PAYLOAD: &str = "payload";
const CANDIDATE_MANIFEST: &str = "manifest.json";
const STRONG_ETAG_MAX_BYTES: usize = 256;
const CHECK_EVIDENCE_LIMIT: usize = 64;
const CHECK_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const ALPHA_RELEASE_LIST_LIMIT: usize = 32;
const RELEASE_ASSET_LIST_LIMIT: usize = 64;
const GITHUB_API_VERSION: &str = "2026-03-10";
const GITHUB_USER_AGENT: &str = "Mish-Updater-Discovery/1";
const GITHUB_REPOSITORY_RELEASE_PATH: &str = "/Asuka109/mish/releases/download/";
const GITHUB_ALPHA_RELEASES_PATH: &str = "/repos/Asuka109/mish/releases";
const GITHUB_EXACT_RELEASE_TAG_PATH: &str = "/repos/Asuka109/mish/releases/tags/";
const GITHUB_STABLE_LATEST_API_PATH: &str = "/repos/Asuka109/mish/releases/latest";
const GITHUB_STABLE_LATEST_PATH: &str = "/Asuka109/mish/releases/latest/download/";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Verifying,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidateIdentity {
    pub artifact_name: String,
    pub artifact_sha256: String,
    pub artifact_signature_sha256: String,
    pub artifact_size: u64,
    pub channel: UpdateChannel,
    pub metadata_sha256: String,
    pub source_sha: String,
    pub version: String,
}

impl UpdateCandidateIdentity {
    fn from_verified(metadata: &VerifiedMetadata) -> Self {
        Self {
            artifact_name: metadata.artifact_name.clone(),
            artifact_sha256: metadata.artifact_sha256.clone(),
            artifact_signature_sha256: digest(metadata.artifact_signature.as_bytes()),
            artifact_size: metadata.artifact_size,
            channel: metadata.channel,
            metadata_sha256: metadata.metadata_sha256.clone(),
            source_sha: metadata.source_sha.clone(),
            version: metadata.version.clone(),
        }
    }

    fn resume_identity(&self, release: &AuthenticatedReleaseRecord) -> String {
        let mut hasher = Sha256::new();
        for value in [
            self.channel_name(),
            self.version.as_str(),
            self.source_sha.as_str(),
            self.artifact_name.as_str(),
            self.artifact_sha256.as_str(),
            &self.artifact_size.to_string(),
            self.artifact_signature_sha256.as_str(),
            self.metadata_sha256.as_str(),
            &release.digest(),
        ] {
            hasher.update((value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
        format!("{:x}", hasher.finalize())
    }

    fn channel_name(&self) -> &'static str {
        match self.channel {
            UpdateChannel::Alpha => "alpha",
            UpdateChannel::Stable => "stable",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    pub authority_id: String,
    pub revision: u64,
    pub configured: bool,
    pub phase: UpdatePhase,
    pub operation_id: Option<String>,
    pub channel: Option<UpdateChannel>,
    pub candidate: Option<UpdateCandidateIdentity>,
    pub progress: Option<UpdateProgress>,
    pub resumable: bool,
    pub terminal_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckTransitionEvidence {
    pub sequence: u64,
    pub machine_authority_sha256: Option<String>,
    pub scope_epoch: Option<u64>,
    pub admitted_revision: Option<u64>,
    pub effect_id: Option<u64>,
    pub progress_sequence: Option<u64>,
    pub operation_id_sha256: Option<String>,
    pub from: String,
    pub input: String,
    pub to: String,
    pub disposition: String,
}

impl UpdaterSnapshot {
    fn idle(authority_id: String, configured: bool) -> Self {
        Self {
            authority_id,
            revision: 0,
            configured,
            phase: UpdatePhase::Idle,
            operation_id: None,
            channel: None,
            candidate: None,
            progress: None,
            resumable: false,
            terminal_reason: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdateOperationError {
    Busy,
    Cancelled,
    InvalidOperationKey,
    InvalidResponse,
    Network,
    NotConfigured,
    OperationMismatch,
    OversizedMetadata,
    OversizedPayload,
    RangeMismatch,
    RedirectRejected,
    StoreIo,
    StoreUnsafe,
    Timeout,
    Verification(UpdaterError),
}

impl UpdateOperationError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::InvalidOperationKey => "invalid-operation-key",
            Self::InvalidResponse => "invalid-response",
            Self::Network => "network",
            Self::NotConfigured => "not-configured",
            Self::OperationMismatch => "operation-mismatch",
            Self::OversizedMetadata => "oversized-metadata",
            Self::OversizedPayload => "oversized-payload",
            Self::RangeMismatch => "range-mismatch",
            Self::RedirectRejected => "redirect-rejected",
            Self::StoreIo => "store-io",
            Self::StoreUnsafe => "store-unsafe",
            Self::Timeout => "timeout",
            Self::Verification(error) => error.code(),
        }
    }
}

impl fmt::Display for UpdateOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for UpdateOperationError {}

impl From<UpdaterError> for UpdateOperationError {
    fn from(value: UpdaterError) -> Self {
        Self::Verification(value)
    }
}

#[derive(Clone, Debug)]
pub struct UpdaterLimits {
    pub connect_timeout: Duration,
    pub idle_timeout: Duration,
    pub request_timeout: Duration,
    pub max_metadata_bytes: u64,
    pub max_signature_bytes: u64,
    pub max_artifact_bytes: u64,
    pub stale_partial_age: Duration,
}

impl Default for UpdaterLimits {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(15),
            request_timeout: Duration::from_secs(15 * 60),
            max_metadata_bytes: 256 * 1024,
            max_signature_bytes: 16 * 1024,
            max_artifact_bytes: 512 * 1024 * 1024,
            stale_partial_age: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AvailableCandidate {
    metadata: VerifiedMetadata,
    metadata_bytes: Vec<u8>,
    metadata_signature: String,
    release: AuthenticatedReleaseRecord,
}

impl AvailableCandidate {
    fn identity(&self) -> UpdateCandidateIdentity {
        UpdateCandidateIdentity::from_verified(&self.metadata)
    }

    fn persisted(&self, operation_id: &str) -> PersistedCandidate {
        PersistedCandidate {
            schema_version: CANDIDATE_SCHEMA_VERSION,
            operation_id: operation_id.to_owned(),
            identity: self.identity(),
            metadata_base64: STANDARD.encode(&self.metadata_bytes),
            metadata_signature: self.metadata_signature.clone(),
            release: self.release.clone(),
        }
    }
}

struct RuntimeState {
    snapshot: UpdaterSnapshot,
    accepted: AcceptedMetadata,
    available: Option<AvailableCandidate>,
    release_context_bound: bool,
    operation_admission_pending: bool,
}

struct ConfiguredUpdater {
    adapter: Arc<UpdaterAdapter>,
    client: Client,
    endpoint: Url,
    fixture_rewrite: Option<Url>,
    limits: UpdaterLimits,
    policy: UpdatePolicy,
    store: CandidateStore,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubReleaseAsset {
    id: u64,
    name: String,
    state: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    id: u64,
    tag_name: String,
    draft: bool,
    prerelease: bool,
    immutable: bool,
    published_at: Option<String>,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticatedReleaseAsset {
    id: u64,
    name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticatedReleaseRecord {
    assets: Vec<AuthenticatedReleaseAsset>,
    channel: UpdateChannel,
    id: u64,
    published_at: String,
    tag: String,
    version: String,
}

impl AuthenticatedReleaseRecord {
    fn digest(&self) -> String {
        digest(
            &serde_json::to_vec(self)
                .expect("authenticated Release record serialization is infallible"),
        )
    }

    fn validates(&self, channel: UpdateChannel, version: &str) -> bool {
        if self.id == 0
            || self.channel != channel
            || self.version != version
            || self.tag != format!("v{version}")
            || self.published_at.is_empty()
            || self.assets.len() > RELEASE_ASSET_LIST_LIMIT
        {
            return false;
        }
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        self.assets.iter().all(|asset| {
            asset.id != 0
                && !asset.name.is_empty()
                && ids.insert(asset.id)
                && names.insert(asset.name.as_str())
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ReleaseHint {
    record: AuthenticatedReleaseRecord,
    tag: String,
    version: String,
    listed_assets: Option<BTreeSet<String>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum DiscoveryOutcome {
    Available(Box<AvailableCandidate>),
    Unchanged,
}

type CheckEffectFuture = Pin<Box<dyn Future<Output = CheckCompletion> + Send + 'static>>;

trait CheckEffectExecutor: Send + Sync {
    fn execute(&self, effect: CheckEffect, cancellation: CancellationToken) -> CheckEffectFuture;
}

struct ProductionCheckEffectExecutor {
    configured: Arc<ConfiguredUpdater>,
    state: Arc<Mutex<RuntimeState>>,
}

impl CheckEffectExecutor for ProductionCheckEffectExecutor {
    fn execute(&self, effect: CheckEffect, cancellation: CancellationToken) -> CheckEffectFuture {
        let configured = self.configured.clone();
        let state = self.state.clone();
        Box::pin(async move {
            match effect {
                CheckEffect::Discover {
                    correlation,
                    channel,
                } => {
                    let result = discover(&configured, &state, channel, &cancellation).await;
                    CheckCompletion {
                        correlation,
                        outcome: CheckEffectOutcome::Discovery(result),
                    }
                }
                CheckEffect::CommitAvailable {
                    correlation,
                    candidate,
                } => {
                    let result = configured.store.persist_available(&candidate, &correlation);
                    CheckCompletion {
                        correlation,
                        outcome: CheckEffectOutcome::Commit(result),
                    }
                }
                CheckEffect::Cancel { correlation } => CheckCompletion {
                    correlation,
                    outcome: CheckEffectOutcome::TaskFailed(CheckTaskFailure::CompletionConflict),
                },
            }
        })
    }
}

struct CheckKernelExecutor {
    inner: Arc<dyn CheckEffectExecutor>,
}

impl KernelEffectExecutor<CheckMachine> for CheckKernelExecutor {
    fn execute(
        &self,
        effect: CheckEffect,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = CheckInput> + Send + 'static>> {
        let completion = self.inner.execute(effect, cancellation);
        Box::pin(async move { CheckInput::EffectCompleted(completion.await) })
    }
}

struct CheckProjectionObserver {
    evidence: Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
    state: Arc<Mutex<RuntimeState>>,
    updates: broadcast::Sender<UpdaterSnapshot>,
}

impl TransitionObserver<CheckMachine> for CheckProjectionObserver {
    fn transitioned(
        &self,
        previous: &CheckState,
        input: &CheckInput,
        current: &CheckState,
        disposition: Disposition,
    ) {
        record_projected_check_evidence(&self.evidence, previous, input, current, disposition);
        let check_requested = matches!(input, CheckInput::CheckRequested { .. });
        let should_project = !matches!(
            disposition,
            Disposition::Rejected | Disposition::Unchanged | Disposition::Retired
        ) && matches!(
            input,
            CheckInput::CheckRequested { .. } | CheckInput::EffectCompleted(_)
        );
        if !check_requested && !should_project {
            return;
        }
        let mut state = self.state.lock().expect("updater state poisoned");
        if check_requested {
            state.operation_admission_pending = false;
        }
        if should_project {
            project_check_state_locked(current, &mut state, &self.updates);
        }
    }
}

struct CheckRuntime {
    next_scope_epoch: AtomicU64,
    runner: RunnerHandle<CheckMachine>,
    state: Arc<Mutex<RuntimeState>>,
}

impl CheckRuntime {
    fn spawn(
        state: Arc<Mutex<RuntimeState>>,
        updates: broadcast::Sender<UpdaterSnapshot>,
        evidence: Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
        executor: Arc<dyn CheckEffectExecutor>,
    ) -> Self {
        let observer = Arc::new(CheckProjectionObserver {
            evidence,
            state: state.clone(),
            updates,
        });
        let runner = spawn_runner(
            Arc::new(CheckMachine),
            CheckState::idle(),
            Arc::new(CheckKernelExecutor { inner: executor }),
            observer,
            RunnerConfig {
                evidence_limit: CHECK_EVIDENCE_LIMIT,
                shutdown_grace: CHECK_SHUTDOWN_GRACE,
                ..RunnerConfig::default()
            },
        );
        Self {
            next_scope_epoch: AtomicU64::new(1),
            runner,
            state,
        }
    }

    async fn start(
        &self,
        operation_id: String,
        channel: UpdateChannel,
    ) -> Result<UpdaterSnapshot, UpdateOperationError> {
        let snapshot = {
            let mut state = self.state.lock().expect("updater state poisoned");
            if state.operation_admission_pending {
                return Err(UpdateOperationError::Busy);
            }
            // Reserve the outer cutover before the bounded runner admits the
            // command so download admission cannot cross this Check request.
            state.operation_admission_pending = true;
            state.snapshot.clone()
        };
        let operation = CheckOperation {
            machine_authority: snapshot.authority_id.clone(),
            scope_epoch: self.next_scope_epoch.fetch_add(1, AtomicOrdering::AcqRel),
            operation_id,
            admitted_revision: snapshot.revision.saturating_add(1),
            channel,
            baseline: Box::new(CheckProjection::from_snapshot(&snapshot)),
        };
        let admission = self
            .runner
            .admit(CheckInput::CheckRequested {
                operation,
                outer_phase: snapshot.phase,
                outer_operation_id: snapshot.operation_id,
                outer_channel: snapshot.channel,
            })
            .await;
        if admission.is_err() {
            self.state
                .lock()
                .expect("updater state poisoned")
                .operation_admission_pending = false;
        }
        admission?;
        Ok(self
            .state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .clone())
    }

    async fn cancel(&self, operation_id: String) -> Result<UpdaterSnapshot, UpdateOperationError> {
        self.runner
            .admit(CheckInput::CancelRequested { operation_id })
            .await?;
        Ok(self
            .state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .clone())
    }

    async fn shutdown(&self) {
        let _ = self.runner.shutdown().await;
    }
}

fn record_projected_check_evidence(
    evidence: &Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
    previous: &CheckState,
    input: &CheckInput,
    current: &CheckState,
    disposition: Disposition,
) {
    let correlation = CheckMachine.input_correlation(previous, input);
    let mut evidence = evidence
        .lock()
        .expect("updater Check evidence lock poisoned");
    let sequence = evidence
        .back()
        .map_or(1, |entry| entry.sequence.saturating_add(1));
    if evidence.len() == CHECK_EVIDENCE_LIMIT {
        evidence.pop_front();
    }
    let disposition = match (disposition, previous.label(), input.label()) {
        (Disposition::Unchanged, "committing-available", "cancel-requested") => "cancel-too-late",
        (_, _, "effect-completion-conflict") => "retired-completion",
        (Disposition::Unchanged, _, _) => "duplicate",
        (Disposition::Retired, _, _) => "retired-completion",
        _ => "applied",
    };
    evidence.push_back(UpdaterCheckTransitionEvidence {
        sequence,
        machine_authority_sha256: correlation
            .as_ref()
            .map(|value| digest(value.machine_authority.as_bytes())),
        scope_epoch: correlation.as_ref().map(|value| value.scope_epoch),
        admitted_revision: correlation.as_ref().map(|value| value.admitted_revision),
        effect_id: correlation.as_ref().map(|value| value.effect_id),
        progress_sequence: None,
        operation_id_sha256: correlation
            .as_ref()
            .map(|value| digest(value.operation_id.as_bytes())),
        from: previous.label().to_owned(),
        input: input.label().to_owned(),
        to: current.label().to_owned(),
        disposition: disposition.to_owned(),
    });
}

fn project_check_state_locked(
    machine: &CheckState,
    state: &mut RuntimeState,
    updates: &broadcast::Sender<UpdaterSnapshot>,
) {
    let projection = machine.projection();
    let changed = state.snapshot.phase != projection.phase
        || state.snapshot.operation_id != projection.operation_id
        || state.snapshot.channel != projection.channel
        || state.snapshot.candidate != projection.candidate
        || state.snapshot.progress != projection.progress
        || state.snapshot.resumable != projection.resumable
        || state.snapshot.terminal_reason != projection.terminal_reason;
    if !changed {
        return;
    }
    state.snapshot.revision = state.snapshot.revision.saturating_add(1);
    state.snapshot.phase = projection.phase;
    state.snapshot.operation_id = projection.operation_id;
    state.snapshot.channel = projection.channel;
    state.snapshot.candidate = projection.candidate;
    state.snapshot.progress = projection.progress;
    state.snapshot.resumable = projection.resumable;
    state.snapshot.terminal_reason = projection.terminal_reason;
    match machine {
        CheckState::Stable {
            available: Some((_, candidate)),
        } => {
            state.available = Some(candidate.clone());
            state.release_context_bound = true;
        }
        CheckState::Retired {
            terminal: check_machine::RetiredTerminal::Available { candidate },
            ..
        } => {
            state.available = Some(candidate.as_ref().clone());
            state.release_context_bound = true;
        }
        CheckState::NoUpdate { .. }
        | CheckState::Unchanged { .. }
        | CheckState::Failed { .. }
        | CheckState::Cancelled { .. }
        | CheckState::Retired { .. } => {}
        CheckState::Checking { .. }
        | CheckState::CommittingAvailable { .. }
        | CheckState::Stable { available: None } => {}
    }
    publish(updates, &state.snapshot);
}

struct ContinuationKernelExecutor {
    configured: Arc<ConfiguredUpdater>,
    runner: Arc<Mutex<Option<RunnerHandle<ContinuationMachine>>>>,
}

impl KernelEffectExecutor<ContinuationMachine> for ContinuationKernelExecutor {
    fn execute(
        &self,
        effect: ContinuationEffect,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ContinuationInput> + Send + 'static>> {
        let configured = self.configured.clone();
        let runner = self.runner.clone();
        Box::pin(async move {
            let completion = match effect {
                ContinuationEffect::Download {
                    correlation,
                    candidate,
                } => {
                    let (correlation, result) = download_artifact_effect(
                        configured,
                        correlation,
                        candidate.as_ref().clone(),
                        cancellation,
                        runner,
                    )
                    .await;
                    ContinuationCompletion {
                        correlation,
                        outcome: ContinuationEffectOutcome::Download(result),
                    }
                }
                ContinuationEffect::Verify {
                    mut correlation,
                    candidate,
                } => {
                    let adapter = configured.adapter.clone();
                    let metadata = candidate.metadata.clone();
                    let payload_path = configured.store.partial_payload_path();
                    let artifact_name = metadata.artifact_name.clone();
                    let signature = metadata.artifact_signature.clone();
                    let verification = tokio::task::spawn_blocking(move || {
                        adapter.verify_payload_file(
                            &metadata,
                            &artifact_name,
                            &payload_path,
                            &signature,
                        )
                    });
                    let result = tokio::select! {
                        _ = cancellation.cancelled() => Err(UpdateOperationError::Cancelled),
                        result = verification => result
                            .map_err(|_| UpdateOperationError::StoreIo)
                            .and_then(|result| result.map_err(UpdateOperationError::Verification)),
                    };
                    correlation.progress_sequence = correlation.progress_sequence.saturating_add(1);
                    ContinuationCompletion {
                        correlation,
                        outcome: ContinuationEffectOutcome::Verify(result),
                    }
                }
                ContinuationEffect::CommitCandidate {
                    mut correlation,
                    candidate,
                } => {
                    let store = configured.store.clone();
                    let commit_correlation = correlation.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        store.publish_candidate(&candidate, &commit_correlation)
                    })
                    .await
                    .map_err(|_| UpdateOperationError::StoreIo)
                    .and_then(|result| result);
                    correlation.progress_sequence = correlation.progress_sequence.saturating_add(1);
                    ContinuationCompletion {
                        correlation,
                        outcome: ContinuationEffectOutcome::Commit(result),
                    }
                }
                ContinuationEffect::FinalizeFailure {
                    mut correlation,
                    candidate,
                    discard_partial,
                } => {
                    let store = configured.store.clone();
                    let operation_id = correlation.machine.operation_id.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        if discard_partial {
                            store.discard_partial()?;
                            Ok(PartialInfo::default())
                        } else {
                            match store.partial_info(&candidate, &operation_id) {
                                Ok(partial) => Ok(partial),
                                Err(UpdateOperationError::StoreIo) => Ok(PartialInfo::default()),
                                Err(error) => Err(error),
                            }
                        }
                    })
                    .await
                    .map_err(|_| UpdateOperationError::StoreIo)
                    .and_then(|result| result);
                    correlation.progress_sequence = correlation.progress_sequence.saturating_add(1);
                    ContinuationCompletion {
                        correlation,
                        outcome: ContinuationEffectOutcome::Finalize(result),
                    }
                }
                ContinuationEffect::ReverifyCandidate {
                    mut correlation,
                    candidate,
                } => {
                    let store = configured.store.clone();
                    let adapter = configured.adapter.clone();
                    let persisted = candidate.persisted(&correlation.machine.operation_id);
                    let recovery_correlation = correlation.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        match store.verify_ready(&adapter, &candidate, &persisted) {
                            Ok(()) => store.record_reverified(&candidate, &recovery_correlation),
                            Err(error) => {
                                store.discard_managed_state()?;
                                Err(error)
                            }
                        }
                    })
                    .await
                    .map_err(|_| UpdateOperationError::StoreIo)
                    .and_then(|result| result);
                    correlation.progress_sequence = correlation.progress_sequence.saturating_add(1);
                    ContinuationCompletion {
                        correlation,
                        outcome: ContinuationEffectOutcome::Recovery(result),
                    }
                }
                ContinuationEffect::Cancel { correlation } => ContinuationCompletion {
                    correlation,
                    outcome: ContinuationEffectOutcome::TaskFailed(
                        ContinuationTaskFailure::CompletionConflict,
                    ),
                },
            };
            ContinuationInput::EffectCompleted(completion)
        })
    }
}

struct ContinuationProjectionObserver {
    evidence: Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
    state: Arc<Mutex<RuntimeState>>,
    updates: broadcast::Sender<UpdaterSnapshot>,
}

impl TransitionObserver<ContinuationMachine> for ContinuationProjectionObserver {
    fn transitioned(
        &self,
        previous: &ContinuationState,
        input: &ContinuationInput,
        current: &ContinuationState,
        disposition: Disposition,
    ) {
        record_continuation_evidence(&self.evidence, previous, input, current, disposition);
        let requested = matches!(input, ContinuationInput::DownloadRequested { .. });
        let should_project = !matches!(
            disposition,
            Disposition::Rejected | Disposition::Unchanged | Disposition::Retired
        );
        if !requested && !should_project {
            return;
        }
        let mut state = self.state.lock().expect("updater state poisoned");
        if requested {
            state.operation_admission_pending = false;
        }
        if !should_project {
            return;
        }
        let Some(projection) = current.projection() else {
            return;
        };
        if !requested
            && (state.snapshot.phase == UpdatePhase::Checking
                || state.snapshot.operation_id.as_deref() != Some(&projection.operation_id))
        {
            return;
        }
        let changed = state.snapshot.phase != projection.phase
            || state.snapshot.operation_id.as_deref() != Some(&projection.operation_id)
            || state.snapshot.channel != Some(projection.channel)
            || state.snapshot.candidate.as_ref() != Some(&projection.candidate)
            || state.snapshot.progress != projection.progress
            || state.snapshot.resumable != projection.resumable
            || state.snapshot.terminal_reason != projection.terminal_reason;
        if !changed {
            return;
        }
        state.snapshot.revision = state.snapshot.revision.saturating_add(1);
        state.snapshot.phase = projection.phase;
        state.snapshot.operation_id = Some(projection.operation_id);
        state.snapshot.channel = Some(projection.channel);
        state.snapshot.candidate = Some(projection.candidate);
        state.snapshot.progress = projection.progress;
        state.snapshot.resumable = projection.resumable;
        state.snapshot.terminal_reason = projection.terminal_reason;
        if matches!(
            current,
            ContinuationState::Ready { .. }
                | ContinuationState::Retired {
                    terminal: continuation_machine::RetiredTerminal::Ready,
                    ..
                }
        ) {
            if let Some(operation) = current.operation() {
                state.accepted.record(&operation.candidate.metadata);
            }
            if !matches!(
                input,
                ContinuationInput::EffectCompleted(ContinuationCompletion {
                    outcome: ContinuationEffectOutcome::Recovery(Ok(())),
                    ..
                })
            ) {
                state.release_context_bound = true;
            }
        }
        publish(&self.updates, &state.snapshot);
    }
}

fn record_continuation_evidence(
    evidence: &Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
    previous: &ContinuationState,
    input: &ContinuationInput,
    current: &ContinuationState,
    disposition: Disposition,
) {
    let correlation = ContinuationMachine.input_correlation(previous, input);
    let progress_sequence = match input {
        ContinuationInput::PartialCommitted { correlation, .. } => {
            Some(correlation.progress_sequence)
        }
        ContinuationInput::EffectCompleted(ContinuationCompletion {
            outcome: ContinuationEffectOutcome::TaskFailed(_),
            ..
        }) => previous
            .progress()
            .map(|progress| progress.sequence.saturating_add(1)),
        ContinuationInput::EffectCompleted(ContinuationCompletion { correlation, .. }) => {
            Some(correlation.progress_sequence)
        }
        ContinuationInput::DownloadRequested { .. } => Some(0),
        _ => previous.progress().map(|progress| progress.sequence),
    };
    let mut evidence = evidence
        .lock()
        .expect("updater continuation evidence lock poisoned");
    let sequence = evidence
        .back()
        .map_or(1, |entry| entry.sequence.saturating_add(1));
    if evidence.len() == CHECK_EVIDENCE_LIMIT {
        evidence.pop_front();
    }
    let disposition = match (disposition, previous.label(), input.label()) {
        (Disposition::Unchanged, "committing-candidate", "cancel-requested") => "cancel-too-late",
        (_, _, "effect-completion-conflict") => "retired-completion",
        (Disposition::Unchanged, _, _) => "duplicate",
        (Disposition::Retired, _, _) => "retired-completion",
        _ => disposition.label(),
    };
    evidence.push_back(UpdaterCheckTransitionEvidence {
        sequence,
        machine_authority_sha256: correlation
            .as_ref()
            .map(|value| digest(value.machine_authority.as_bytes())),
        scope_epoch: correlation.as_ref().map(|value| value.scope_epoch),
        admitted_revision: correlation.as_ref().map(|value| value.admitted_revision),
        effect_id: correlation.as_ref().map(|value| value.effect_id),
        progress_sequence,
        operation_id_sha256: correlation
            .as_ref()
            .map(|value| digest(value.operation_id.as_bytes())),
        from: previous.label().into(),
        input: input.label().into(),
        to: current.label().into(),
        disposition: disposition.into(),
    });
}

struct ContinuationRuntime {
    next_scope_epoch: AtomicU64,
    runner: RunnerHandle<ContinuationMachine>,
    state: Arc<Mutex<RuntimeState>>,
}

impl ContinuationRuntime {
    fn spawn(
        initial: ContinuationState,
        state: Arc<Mutex<RuntimeState>>,
        updates: broadcast::Sender<UpdaterSnapshot>,
        evidence: Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
        configured: Arc<ConfiguredUpdater>,
    ) -> Self {
        let runner_slot = Arc::new(Mutex::new(None));
        let runner = spawn_runner(
            Arc::new(ContinuationMachine),
            initial,
            Arc::new(ContinuationKernelExecutor {
                configured,
                runner: runner_slot.clone(),
            }),
            Arc::new(ContinuationProjectionObserver {
                evidence,
                state: state.clone(),
                updates,
            }),
            RunnerConfig {
                evidence_limit: CHECK_EVIDENCE_LIMIT,
                shutdown_grace: CHECK_SHUTDOWN_GRACE,
                ..RunnerConfig::default()
            },
        );
        *runner_slot
            .lock()
            .expect("continuation runner slot poisoned") = Some(runner.clone());
        Self {
            next_scope_epoch: AtomicU64::new(1),
            runner,
            state,
        }
    }

    async fn start(&self, operation_id: String) -> Result<UpdaterSnapshot, UpdateOperationError> {
        let (snapshot, available, resumed_bytes) = {
            let mut state = self.state.lock().expect("updater state poisoned");
            if state.operation_admission_pending {
                return Err(UpdateOperationError::Busy);
            }
            let available = state
                .available
                .clone()
                .ok_or(UpdateOperationError::OperationMismatch)?;
            let resumed_bytes = available.metadata.artifact_size.min(
                state
                    .snapshot
                    .progress
                    .as_ref()
                    .map_or(0, |value| value.downloaded_bytes),
            );
            state.operation_admission_pending = true;
            (state.snapshot.clone(), available, resumed_bytes)
        };
        let operation = ContinuationOperation {
            machine_authority: snapshot.authority_id.clone(),
            scope_epoch: self.next_scope_epoch.fetch_add(1, AtomicOrdering::AcqRel),
            operation_id,
            admitted_revision: snapshot.revision.saturating_add(1),
            candidate: available,
        };
        let admission = self
            .runner
            .admit(ContinuationInput::DownloadRequested {
                operation: Box::new(operation),
                outer: Box::new(snapshot),
                resumed_bytes,
            })
            .await;
        if admission.is_err() {
            self.state
                .lock()
                .expect("updater state poisoned")
                .operation_admission_pending = false;
        }
        admission?;
        Ok(self
            .state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .clone())
    }

    async fn cancel(&self, operation_id: String) -> Result<UpdaterSnapshot, UpdateOperationError> {
        self.runner
            .admit(ContinuationInput::CancelRequested { operation_id })
            .await?;
        Ok(self
            .state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .clone())
    }

    async fn recover(&self) -> Result<(), UpdateOperationError> {
        self.runner
            .admit(ContinuationInput::RecoverRequested)
            .await?;
        timeout(Duration::from_secs(15), async {
            while matches!(self.runner.snapshot(), ContinuationState::Recovering { .. }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| UpdateOperationError::Timeout)
    }

    async fn shutdown(&self) {
        let _ = self.runner.shutdown().await;
    }
}

pub struct UpdaterService {
    check: Option<CheckRuntime>,
    continuation: Option<ContinuationRuntime>,
    check_evidence: Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
    configured: Option<Arc<ConfiguredUpdater>>,
    state: Arc<Mutex<RuntimeState>>,
    updates: broadcast::Sender<UpdaterSnapshot>,
    install_admission: Arc<Mutex<install_adapter::InstallAdmissionState>>,
}

async fn download_artifact_effect(
    configured: Arc<ConfiguredUpdater>,
    mut correlation: ContinuationCorrelation,
    available: AvailableCandidate,
    cancel: CancellationToken,
    runner: Arc<Mutex<Option<RunnerHandle<ContinuationMachine>>>>,
) -> (ContinuationCorrelation, Result<(), UpdateOperationError>) {
    let deadline = tokio::time::Instant::now() + configured.limits.request_timeout;
    let result = timeout_at(
        deadline,
        download_artifact_inner(&configured, &available, &cancel, &mut correlation, &runner),
    )
    .await
    .map_err(|_| UpdateOperationError::Timeout)
    .and_then(|result| result);
    correlation.progress_sequence = correlation.progress_sequence.saturating_add(1);
    (correlation, result)
}

async fn download_artifact_inner(
    configured: &ConfiguredUpdater,
    available: &AvailableCandidate,
    cancel: &CancellationToken,
    correlation: &mut ContinuationCorrelation,
    runner: &Arc<Mutex<Option<RunnerHandle<ContinuationMachine>>>>,
) -> Result<(), UpdateOperationError> {
    let operation_id = correlation.machine.operation_id.as_str();
    let mut partial = configured.store.prepare_partial(available, operation_id)?;
    let expected_size = available.metadata.artifact_size;
    if partial.size == expected_size {
        return Ok(());
    }
    let logical_url = Url::parse(&available.metadata.artifact_url)
        .map_err(|_| UpdateOperationError::InvalidResponse)?;
    let download_url = request_url(configured, &logical_url)?;
    let mut request = configured
        .client
        .get(download_url.clone())
        .header(ACCEPT_ENCODING, "identity");
    if partial.size > 0 {
        if partial.etag.is_none() {
            configured.store.reset_partial(available, operation_id)?;
            partial = PartialInfo::default();
            request = configured
                .client
                .get(download_url)
                .header(ACCEPT_ENCODING, "identity");
        }
        if partial.size > 0 {
            let etag = partial
                .etag
                .as_deref()
                .expect("etag checked for resumable partial");
            request = request
                .header(RANGE, format!("bytes={}-", partial.size))
                .header(IF_RANGE, etag);
        }
    }
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(UpdateOperationError::Cancelled),
        response = request.send() => response.map_err(map_reqwest_error)?,
    };
    if response.status().is_redirection() {
        return Err(UpdateOperationError::RedirectRejected);
    }
    ensure_identity_encoding(&response)?;
    let (mut offset, append) = classify_download_response(&response, &partial, expected_size)?;
    if !append {
        configured.store.reset_partial(available, operation_id)?;
        offset = 0;
    }
    let etag = strong_etag(&response);
    if append && etag.as_deref() != partial.etag.as_deref() {
        return Err(UpdateOperationError::RangeMismatch);
    }
    if !append {
        configured
            .store
            .set_partial_etag(available, operation_id, etag.as_deref())?;
    }
    let payload_path = configured.store.partial_payload_path();
    let mut options = tokio::fs::OpenOptions::new();
    options.create(false).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut payload = options
        .open(&payload_path)
        .await
        .map_err(|_| UpdateOperationError::StoreIo)?;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                payload.flush().await.map_err(|_| UpdateOperationError::StoreIo)?;
                payload.sync_all().await.map_err(|_| UpdateOperationError::StoreIo)?;
                return Err(UpdateOperationError::Cancelled);
            }
            next = timeout(configured.limits.idle_timeout, stream.next()) =>
                next.map_err(|_| UpdateOperationError::Timeout)?,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(map_reqwest_error)?;
        offset = offset
            .checked_add(chunk.len() as u64)
            .ok_or(UpdateOperationError::OversizedPayload)?;
        if offset > expected_size || offset > configured.limits.max_artifact_bytes {
            return Err(UpdateOperationError::OversizedPayload);
        }
        payload
            .write_all(&chunk)
            .await
            .map_err(|_| UpdateOperationError::StoreIo)?;
        // A progress event is published only after the private partial bytes are
        // durable. This is the partial-download commit point.
        payload
            .flush()
            .await
            .map_err(|_| UpdateOperationError::StoreIo)?;
        payload
            .sync_all()
            .await
            .map_err(|_| UpdateOperationError::StoreIo)?;
        correlation.progress_sequence = correlation.progress_sequence.saturating_add(1);
        configured
            .store
            .record_partial_commit(available, correlation, offset)?;
        let progress_correlation = correlation.clone();
        let runner = runner
            .lock()
            .expect("continuation runner slot poisoned")
            .clone()
            .ok_or(UpdateOperationError::Busy)?;
        runner
            .admit(ContinuationInput::PartialCommitted {
                correlation: progress_correlation,
                downloaded_bytes: offset,
            })
            .await?;
    }
    payload
        .flush()
        .await
        .map_err(|_| UpdateOperationError::StoreIo)?;
    payload
        .sync_all()
        .await
        .map_err(|_| UpdateOperationError::StoreIo)?;
    if offset != expected_size {
        return Err(UpdateOperationError::Verification(
            UpdaterError::ArtifactSizeMismatch,
        ));
    }
    Ok(())
}

impl UpdaterService {
    pub fn unconfigured(authority_id: impl Into<String>) -> Self {
        let snapshot = UpdaterSnapshot::idle(authority_id.into(), false);
        let (updates, _) = broadcast::channel(32);
        Self {
            check: None,
            continuation: None,
            check_evidence: Arc::new(Mutex::new(VecDeque::new())),
            configured: None,
            state: Arc::new(Mutex::new(RuntimeState {
                snapshot,
                accepted: AcceptedMetadata::empty(),
                available: None,
                release_context_bound: false,
                operation_admission_pending: false,
            })),
            updates,
            install_admission: Arc::new(Mutex::new(
                install_adapter::InstallAdmissionState::default(),
            )),
        }
    }

    pub async fn configured(
        authority_id: impl Into<String>,
        public_key: &str,
        policy: UpdatePolicy,
        endpoint: Url,
        store_root: PathBuf,
        limits: UpdaterLimits,
    ) -> Result<Self, UpdateOperationError> {
        validate_production_endpoint(&endpoint, policy.selected_channel)?;
        Self::configured_inner(
            authority_id.into(),
            public_key,
            policy,
            endpoint,
            store_root,
            limits,
            None,
        )
        .await
    }

    async fn configured_inner(
        authority_id: String,
        public_key: &str,
        policy: UpdatePolicy,
        endpoint: Url,
        store_root: PathBuf,
        limits: UpdaterLimits,
        fixture_rewrite: Option<Url>,
    ) -> Result<Self, UpdateOperationError> {
        let adapter = Arc::new(UpdaterAdapter::new(public_key)?);
        let client = Client::builder()
            .connect_timeout(limits.connect_timeout)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if trusted_release_redirect(attempt.previous(), attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .pool_max_idle_per_host(1);
        // Fixture URLs are loopback-only and must not inherit a CI or host
        // proxy that can route them away from the in-process test server.
        let client = if fixture_rewrite.is_some() {
            client.no_proxy()
        } else {
            client
        }
        .build()
        .map_err(|_| UpdateOperationError::Network)?;
        let store = CandidateStore::open(store_root)?;
        let recovered = store.recover(&adapter, &policy, &limits)?;
        let snapshot = recovered.snapshot(authority_id);
        let (updates, _) = broadcast::channel(32);
        let configured = Arc::new(ConfiguredUpdater {
            adapter,
            client,
            endpoint,
            fixture_rewrite,
            limits,
            policy,
            store,
        });
        let continuation_initial =
            recovered
                .available
                .as_ref()
                .map_or_else(ContinuationState::stable, |candidate| {
                    let operation = ContinuationOperation {
                        machine_authority: snapshot.authority_id.clone(),
                        scope_epoch: 0,
                        operation_id: recovered
                            .operation_id
                            .clone()
                            .unwrap_or_else(|| "recovered".into()),
                        admitted_revision: snapshot.revision,
                        candidate: candidate.clone(),
                    };
                    let progress = MachineProgress {
                        downloaded_bytes: recovered
                            .progress
                            .as_ref()
                            .map_or(0, |value| value.downloaded_bytes),
                        total_bytes: candidate.metadata.artifact_size,
                        sequence: 0,
                    };
                    match recovered.phase {
                        _ if recovered.needs_reverification => {
                            ContinuationState::recovery_required(operation, progress)
                        }
                        UpdatePhase::Failed
                            if recovered.terminal_reason.as_deref() == Some("interrupted") =>
                        {
                            ContinuationState::interrupted(operation, progress, recovered.resumable)
                        }
                        _ => ContinuationState::stable(),
                    }
                });
        let state = Arc::new(Mutex::new(RuntimeState {
            snapshot,
            accepted: recovered.accepted,
            available: recovered.available,
            release_context_bound: false,
            operation_admission_pending: false,
        }));
        let check_evidence = Arc::new(Mutex::new(VecDeque::new()));
        let check = CheckRuntime::spawn(
            state.clone(),
            updates.clone(),
            check_evidence.clone(),
            Arc::new(ProductionCheckEffectExecutor {
                configured: configured.clone(),
                state: state.clone(),
            }),
        );
        let continuation = ContinuationRuntime::spawn(
            continuation_initial,
            state.clone(),
            updates.clone(),
            check_evidence.clone(),
            configured.clone(),
        );
        let service = Self {
            check: Some(check),
            continuation: Some(continuation),
            check_evidence,
            configured: Some(configured),
            state,
            updates,
            install_admission: Arc::new(Mutex::new(
                install_adapter::InstallAdmissionState::default(),
            )),
        };
        if recovered.needs_reverification {
            service
                .continuation
                .as_ref()
                .expect("configured updater has a continuation runtime")
                .recover()
                .await?;
            // No subscriber can exist before construction returns. The fresh
            // process publishes the reverified result as its revision-zero
            // baseline while retaining the complete internal transition evidence.
            service
                .state
                .lock()
                .expect("updater state poisoned")
                .snapshot
                .revision = 0;
        }
        Ok(service)
    }

    pub fn snapshot(&self) -> UpdaterSnapshot {
        self.state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .clone()
    }

    pub fn local_candidate_install_adapter(self: &Arc<Self>) -> LocalCandidateInstallAdapter {
        LocalCandidateInstallAdapter::disabled(self.clone())
    }

    #[cfg(test)]
    fn proof_local_candidate_install_adapter(self: &Arc<Self>) -> LocalCandidateInstallAdapter {
        LocalCandidateInstallAdapter::proof_only(self.clone())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<UpdaterSnapshot> {
        self.updates.subscribe()
    }

    pub fn subscribe_with_snapshot(
        &self,
    ) -> (broadcast::Receiver<UpdaterSnapshot>, UpdaterSnapshot) {
        let receiver = self.updates.subscribe();
        (receiver, self.snapshot())
    }

    pub fn check_transition_evidence(&self) -> Vec<UpdaterCheckTransitionEvidence> {
        self.check_evidence
            .lock()
            .expect("updater Check evidence lock poisoned")
            .iter()
            .cloned()
            .collect()
    }

    pub async fn start_check(
        &self,
        operation_id: &str,
        channel: UpdateChannel,
    ) -> Result<UpdaterSnapshot, UpdateOperationError> {
        let configured = self.require_configured()?;
        validate_operation_id(operation_id)?;
        if channel != configured.policy.selected_channel {
            return Err(UpdateOperationError::Verification(
                UpdaterError::ChannelMismatch,
            ));
        }
        self.check
            .as_ref()
            .expect("configured updater has a Check runtime")
            .start(operation_id.to_owned(), channel)
            .await
    }

    pub async fn start_download(
        &self,
        operation_id: &str,
    ) -> Result<UpdaterSnapshot, UpdateOperationError> {
        self.require_configured()?;
        validate_operation_id(operation_id)?;
        self.continuation
            .as_ref()
            .expect("configured updater has a continuation runtime")
            .start(operation_id.to_owned())
            .await
    }

    pub async fn cancel(
        &self,
        operation_id: &str,
    ) -> Result<UpdaterSnapshot, UpdateOperationError> {
        self.require_configured()?;
        validate_operation_id(operation_id)?;
        let checking = self
            .state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .phase
            == UpdatePhase::Checking;
        if checking {
            self.check
                .as_ref()
                .expect("configured updater has a Check runtime")
                .cancel(operation_id.to_owned())
                .await
        } else {
            self.continuation
                .as_ref()
                .expect("configured updater has a continuation runtime")
                .cancel(operation_id.to_owned())
                .await
        }
    }

    pub async fn shutdown(&self) {
        if let Some(check) = &self.check {
            check.shutdown().await;
        }
        if let Some(continuation) = &self.continuation {
            continuation.shutdown().await;
        }
    }

    fn require_configured(&self) -> Result<&ConfiguredUpdater, UpdateOperationError> {
        self.configured
            .as_deref()
            .ok_or(UpdateOperationError::NotConfigured)
    }
}

async fn discover(
    configured: &ConfiguredUpdater,
    state: &Mutex<RuntimeState>,
    channel: UpdateChannel,
    cancel: &CancellationToken,
) -> Result<DiscoveryOutcome, UpdateOperationError> {
    let metadata_name = channel.metadata_name();
    let metadata_signature_name = format!("{metadata_name}.sig");
    let hint = match channel {
        UpdateChannel::Alpha => discover_alpha_release(configured, cancel).await?,
        UpdateChannel::Stable => {
            let published = discover_stable_release(configured, cancel).await?;
            validate_stable_latest_asset(configured, metadata_name, &published, cancel).await?;
            validate_stable_latest_asset(configured, &metadata_signature_name, &published, cancel)
                .await?;
            published
        }
    };
    require_listed_asset(&hint, metadata_name)?;
    require_listed_asset(&hint, &metadata_signature_name)?;
    let metadata_url = immutable_release_asset_url(&hint.version, metadata_name)?;
    let signature_url = immutable_release_asset_url(&hint.version, &metadata_signature_name)?;
    let metadata = fetch_bounded(
        configured,
        &metadata_url,
        configured.limits.max_metadata_bytes,
        cancel,
    )
    .await?;
    let signature = fetch_bounded(
        configured,
        &signature_url,
        configured.limits.max_signature_bytes,
        cancel,
    )
    .await?;
    let metadata_signature =
        String::from_utf8(signature).map_err(|_| UpdateOperationError::InvalidResponse)?;
    let verified = configured.adapter.verify_metadata(VerifyMetadataRequest {
        accepted_metadata_sha256: &[],
        metadata: &metadata,
        metadata_signature: metadata_signature.trim(),
        policy: configured.policy.clone(),
    })?;
    if verified.channel != channel || verified.version != hint.version {
        return Err(UpdateOperationError::Verification(
            UpdaterError::ChannelMismatch,
        ));
    }
    if verified.artifact_size > configured.limits.max_artifact_bytes {
        return Err(UpdateOperationError::OversizedPayload);
    }
    let artifact_signature_name = format!("{}.sig", verified.artifact_name);
    require_listed_asset(&hint, &verified.artifact_name)?;
    require_listed_asset(&hint, &artifact_signature_name)?;
    if channel == UpdateChannel::Stable {
        for asset_name in [&verified.artifact_name, &artifact_signature_name] {
            validate_stable_latest_asset(configured, asset_name, &hint, cancel).await?;
        }
    }
    let artifact_signature_url =
        immutable_release_asset_url(&hint.version, &artifact_signature_name)?;
    let artifact_signature = match fetch_bounded(
        configured,
        &artifact_signature_url,
        configured.limits.max_signature_bytes,
        cancel,
    )
    .await
    {
        Err(UpdateOperationError::InvalidResponse) => {
            return Err(UpdateOperationError::Verification(
                UpdaterError::MissingArtifactSignature,
            ));
        }
        result => result?,
    };
    let artifact_signature =
        String::from_utf8(artifact_signature).map_err(|_| UpdateOperationError::InvalidResponse)?;
    let artifact_signature = artifact_signature.trim();
    if artifact_signature.is_empty() {
        return Err(UpdateOperationError::Verification(
            UpdaterError::MissingArtifactSignature,
        ));
    }
    if artifact_signature != verified.artifact_signature {
        return Err(UpdateOperationError::Verification(
            UpdaterError::ArtifactSignatureMismatch,
        ));
    }
    let candidate = AvailableCandidate {
        metadata: verified,
        metadata_bytes: metadata,
        metadata_signature: metadata_signature.trim().to_owned(),
        release: hint.record,
    };
    classify_discovery(state, candidate)
}

async fn discover_alpha_release(
    configured: &ConfiguredUpdater,
    cancel: &CancellationToken,
) -> Result<ReleaseHint, UpdateOperationError> {
    let body = fetch_github_api(configured, &configured.endpoint, cancel).await?;
    let releases = serde_json::from_slice::<Vec<GitHubRelease>>(&body)
        .map_err(|_| UpdateOperationError::InvalidResponse)?;
    select_alpha_release(releases)
}

async fn discover_stable_release(
    configured: &ConfiguredUpdater,
    cancel: &CancellationToken,
) -> Result<ReleaseHint, UpdateOperationError> {
    let logical_url = Url::parse(&format!(
        "https://api.github.com{GITHUB_STABLE_LATEST_API_PATH}"
    ))
    .map_err(|_| UpdateOperationError::NotConfigured)?;
    let body = fetch_github_api(configured, &logical_url, cancel).await?;
    let release = serde_json::from_slice::<GitHubRelease>(&body)
        .map_err(|_| UpdateOperationError::InvalidResponse)?;
    release_hint(release, UpdateChannel::Stable)
}

async fn fetch_github_api(
    configured: &ConfiguredUpdater,
    logical_url: &Url,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, UpdateOperationError> {
    let request_url = request_url(configured, logical_url)?;
    let request = configured
        .client
        .get(request_url)
        .header(ACCEPT_ENCODING, "identity")
        .header(ACCEPT, "application/vnd.github+json")
        .header("x-github-api-version", GITHUB_API_VERSION)
        .header(USER_AGENT, GITHUB_USER_AGENT);
    fetch_bounded_request(
        request,
        configured.limits.max_metadata_bytes,
        configured,
        cancel,
    )
    .await
}

fn select_alpha_release(releases: Vec<GitHubRelease>) -> Result<ReleaseHint, UpdateOperationError> {
    if releases.len() > ALPHA_RELEASE_LIST_LIMIT {
        return Err(UpdateOperationError::InvalidResponse);
    }
    let mut seen_versions = BTreeSet::new();
    let mut selected: Option<(Version, ReleaseHint)> = None;
    for release in releases {
        if release.draft
            || !release.prerelease
            || !release.immutable
            || release.published_at.as_deref().is_none_or(str::is_empty)
        {
            continue;
        }
        let hint = release_hint(release, UpdateChannel::Alpha)?;
        let version = hint.version.clone();
        let parsed = parse_version(&version).map_err(|_| UpdateOperationError::InvalidResponse)?;
        if !seen_versions.insert(version) {
            return Err(UpdateOperationError::Verification(
                UpdaterError::VersionDigestConflict,
            ));
        }
        if selected
            .as_ref()
            .is_none_or(|(selected_version, _)| parsed > *selected_version)
        {
            selected = Some((parsed, hint));
        }
    }
    selected
        .map(|(_, hint)| hint)
        .ok_or(UpdateOperationError::InvalidResponse)
}

fn release_hint(
    release: GitHubRelease,
    channel: UpdateChannel,
) -> Result<ReleaseHint, UpdateOperationError> {
    if release.id == 0
        || release.draft
        || release.prerelease != (channel == UpdateChannel::Alpha)
        || !release.immutable
        || release.published_at.as_deref().is_none_or(str::is_empty)
        || release.assets.len() > RELEASE_ASSET_LIST_LIMIT
    {
        return Err(UpdateOperationError::InvalidResponse);
    }
    let version = release
        .tag_name
        .strip_prefix('v')
        .ok_or(UpdateOperationError::InvalidResponse)?
        .to_owned();
    let parsed = parse_version(&version).map_err(|_| UpdateOperationError::InvalidResponse)?;
    validate_channel_version(&parsed, channel).map_err(UpdateOperationError::Verification)?;
    let mut asset_ids = BTreeSet::new();
    let mut assets = BTreeSet::new();
    let mut authenticated_assets = Vec::with_capacity(release.assets.len());
    for asset in release.assets {
        if asset.id == 0
            || asset.state != "uploaded"
            || !asset_ids.insert(asset.id)
            || !assets.insert(asset.name.clone())
        {
            return Err(UpdateOperationError::InvalidResponse);
        }
        authenticated_assets.push(AuthenticatedReleaseAsset {
            id: asset.id,
            name: asset.name,
        });
    }
    authenticated_assets.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    let tag = release.tag_name;
    let record = AuthenticatedReleaseRecord {
        assets: authenticated_assets,
        channel,
        id: release.id,
        published_at: release
            .published_at
            .expect("published Release timestamp was validated"),
        tag: tag.clone(),
        version: version.clone(),
    };
    Ok(ReleaseHint {
        record,
        tag,
        version,
        listed_assets: Some(assets),
    })
}

async fn validate_stable_latest_asset(
    configured: &ConfiguredUpdater,
    asset_name: &str,
    published: &ReleaseHint,
    cancel: &CancellationToken,
) -> Result<(), UpdateOperationError> {
    let logical_url = configured
        .endpoint
        .join(asset_name)
        .map_err(|_| UpdateOperationError::NotConfigured)?;
    let request_url = request_url(configured, &logical_url)?;
    let deadline = tokio::time::Instant::now() + configured.limits.request_timeout;
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(UpdateOperationError::Cancelled),
        response = timeout_at(deadline, configured.client
            .get(request_url)
            .header(ACCEPT_ENCODING, "identity")
            .send()) => response
                .map_err(|_| UpdateOperationError::Timeout)?
                .map_err(map_reqwest_error)?,
    };
    if !response.status().is_redirection() {
        return Err(UpdateOperationError::InvalidResponse);
    }
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(UpdateOperationError::InvalidResponse)?;
    let location = Url::parse(location).map_err(|_| UpdateOperationError::InvalidResponse)?;
    if trusted_release_asset_destination(&location) {
        return Ok(());
    }
    let version = exact_release_asset_version(&location, asset_name, UpdateChannel::Stable)?;
    if version == published.version && format!("v{version}") == published.tag {
        Ok(())
    } else {
        Err(UpdateOperationError::InvalidResponse)
    }
}

fn require_listed_asset(hint: &ReleaseHint, name: &str) -> Result<(), UpdateOperationError> {
    if hint
        .listed_assets
        .as_ref()
        .is_some_and(|assets| !assets.contains(name))
    {
        Err(UpdateOperationError::InvalidResponse)
    } else {
        Ok(())
    }
}

fn classify_discovery(
    state: &Mutex<RuntimeState>,
    candidate: AvailableCandidate,
) -> Result<DiscoveryOutcome, UpdateOperationError> {
    let state = state.lock().expect("updater state poisoned");
    if let Some(existing) = &state.available {
        match parse_version(&candidate.metadata.version)
            .expect("authenticated version is canonical")
            .cmp(&parse_version(&existing.metadata.version).expect("verified version is canonical"))
        {
            Ordering::Less => {
                return Err(UpdateOperationError::Verification(
                    UpdaterError::DowngradeRejected,
                ));
            }
            Ordering::Equal
                if candidate.identity() == existing.identity()
                    && candidate.release == existing.release =>
            {
                return Ok(DiscoveryOutcome::Unchanged);
            }
            Ordering::Equal => {
                return Err(UpdateOperationError::Verification(
                    UpdaterError::VersionDigestConflict,
                ));
            }
            Ordering::Greater => {}
        }
    }
    match state.accepted.compare(&candidate.metadata) {
        Some(Ordering::Less) => Err(UpdateOperationError::Verification(
            UpdaterError::DowngradeRejected,
        )),
        Some(Ordering::Equal)
            if state
                .accepted
                .digests
                .contains(&candidate.metadata.metadata_sha256) =>
        {
            Ok(DiscoveryOutcome::Unchanged)
        }
        Some(Ordering::Equal) => Err(UpdateOperationError::Verification(
            UpdaterError::VersionDigestConflict,
        )),
        Some(Ordering::Greater) | None
            if state
                .accepted
                .digests
                .contains(&candidate.metadata.metadata_sha256) =>
        {
            Err(UpdateOperationError::Verification(
                UpdaterError::MetadataReplay,
            ))
        }
        Some(Ordering::Greater) | None => Ok(DiscoveryOutcome::Available(Box::new(candidate))),
    }
}

async fn fetch_bounded(
    configured: &ConfiguredUpdater,
    logical_url: &Url,
    maximum: u64,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, UpdateOperationError> {
    let request_url = request_url(configured, logical_url)?;
    let request = configured
        .client
        .get(request_url)
        .header(ACCEPT_ENCODING, "identity");
    fetch_bounded_request(request, maximum, configured, cancel).await
}

async fn fetch_bounded_request(
    request: RequestBuilder,
    maximum: u64,
    configured: &ConfiguredUpdater,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, UpdateOperationError> {
    let deadline = tokio::time::Instant::now() + configured.limits.request_timeout;
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(UpdateOperationError::Cancelled),
        response = timeout_at(deadline, request.send()) => response
                .map_err(|_| UpdateOperationError::Timeout)?
                .map_err(map_reqwest_error)?,
    };
    reject_redirect_or_status(&response)?;
    ensure_identity_encoding(&response)?;
    if response
        .content_length()
        .is_some_and(|length| length > maximum)
    {
        return Err(UpdateOperationError::OversizedMetadata);
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(UpdateOperationError::Cancelled),
            next = timeout_at(deadline, timeout(configured.limits.idle_timeout, stream.next())) =>
                next
                    .map_err(|_| UpdateOperationError::Timeout)?
                    .map_err(|_| UpdateOperationError::Timeout)?,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(map_reqwest_error)?;
        if (body.len() as u64)
            .checked_add(chunk.len() as u64)
            .is_none_or(|length| length > maximum)
        {
            return Err(UpdateOperationError::OversizedMetadata);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
fn publish(updates: &broadcast::Sender<UpdaterSnapshot>, snapshot: &UpdaterSnapshot) {
    let _ = updates.send(snapshot.clone());
}

fn validate_operation_id(value: &str) -> Result<(), UpdateOperationError> {
    if (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Ok(())
    } else {
        Err(UpdateOperationError::InvalidOperationKey)
    }
}

fn validate_production_endpoint(
    endpoint: &Url,
    channel: UpdateChannel,
) -> Result<(), UpdateOperationError> {
    let common = endpoint.scheme() == "https"
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.fragment().is_none();
    let valid = match channel {
        UpdateChannel::Alpha => {
            common
                && endpoint.host_str() == Some("api.github.com")
                && endpoint.path() == GITHUB_ALPHA_RELEASES_PATH
                && endpoint
                    .query_pairs()
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect::<Vec<_>>()
                    == [
                        ("per_page".to_owned(), ALPHA_RELEASE_LIST_LIMIT.to_string()),
                        ("page".to_owned(), "1".to_owned()),
                    ]
        }
        UpdateChannel::Stable => {
            common
                && endpoint.host_str() == Some("github.com")
                && endpoint.path() == GITHUB_STABLE_LATEST_PATH
                && endpoint.query().is_none()
        }
    };
    if valid {
        Ok(())
    } else {
        Err(UpdateOperationError::NotConfigured)
    }
}

fn immutable_release_asset_url(
    version: &str,
    asset_name: &str,
) -> Result<Url, UpdateOperationError> {
    let url = Url::parse(&format!(
        "https://github.com{GITHUB_REPOSITORY_RELEASE_PATH}v{version}/{asset_name}"
    ))
    .map_err(|_| UpdateOperationError::InvalidResponse)?;
    let channel = if version.contains('-') {
        UpdateChannel::Alpha
    } else {
        UpdateChannel::Stable
    };
    exact_release_asset_version(&url, asset_name, channel)?;
    Ok(url)
}

fn exact_release_asset_version(
    url: &Url,
    asset_name: &str,
    channel: UpdateChannel,
) -> Result<String, UpdateOperationError> {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(UpdateOperationError::InvalidResponse);
    }
    let segments = url
        .path_segments()
        .ok_or(UpdateOperationError::InvalidResponse)?
        .collect::<Vec<_>>();
    let [owner, repository, releases, download, tag, asset] = segments.as_slice() else {
        return Err(UpdateOperationError::InvalidResponse);
    };
    if *owner != "Asuka109"
        || *repository != "mish"
        || *releases != "releases"
        || *download != "download"
        || *asset != asset_name
    {
        return Err(UpdateOperationError::InvalidResponse);
    }
    let version = tag
        .strip_prefix('v')
        .ok_or(UpdateOperationError::InvalidResponse)?;
    let parsed = parse_version(version).map_err(|_| UpdateOperationError::InvalidResponse)?;
    validate_channel_version(&parsed, channel).map_err(UpdateOperationError::Verification)?;
    Ok(version.to_owned())
}

fn trusted_release_redirect(previous: &[Url], destination: &Url) -> bool {
    if previous.len() != 1 {
        return false;
    }
    let source = &previous[0];
    let trusted_source = trusted_immutable_release_source(source);
    trusted_source && trusted_release_asset_destination(destination)
}

fn trusted_release_asset_destination(destination: &Url) -> bool {
    destination.scheme() == "https"
        && destination.username().is_empty()
        && destination.password().is_none()
        && destination.fragment().is_none()
        && match destination.host_str() {
            Some("release-assets.githubusercontent.com") => destination
                .path()
                .starts_with("/github-production-release-asset/"),
            Some("objects.githubusercontent.com") => destination
                .path()
                .starts_with("/github-production-release-asset-"),
            _ => false,
        }
}

fn trusted_immutable_release_source(source: &Url) -> bool {
    if source.scheme() != "https"
        || source.host_str() != Some("github.com")
        || !source.username().is_empty()
        || source.password().is_some()
        || source.query().is_some()
        || source.fragment().is_some()
    {
        return false;
    }
    let Some(segments) = source.path_segments().map(Iterator::collect::<Vec<_>>) else {
        return false;
    };
    let [owner, repository, releases, download, tag, asset] = segments.as_slice() else {
        return false;
    };
    if *owner != "Asuka109"
        || *repository != "mish"
        || *releases != "releases"
        || *download != "download"
        || asset.is_empty()
    {
        return false;
    }
    tag.strip_prefix('v')
        .and_then(|version| parse_version(version).ok())
        .is_some_and(|version| {
            validate_channel_version(&version, UpdateChannel::Alpha).is_ok()
                || validate_channel_version(&version, UpdateChannel::Stable).is_ok()
        })
}

fn request_url(
    configured: &ConfiguredUpdater,
    logical_url: &Url,
) -> Result<Url, UpdateOperationError> {
    if let Some(rewrite) = &configured.fixture_rewrite {
        if logical_url.host_str() == Some("api.github.com") {
            let fixture_path = if logical_url.path() == GITHUB_STABLE_LATEST_API_PATH {
                "api/releases/latest"
            } else if logical_url.path() == GITHUB_ALPHA_RELEASES_PATH {
                "api/releases"
            } else if let Some(tag) = logical_url
                .path()
                .strip_prefix(GITHUB_EXACT_RELEASE_TAG_PATH)
                .filter(|tag| !tag.is_empty() && !tag.contains('/'))
            {
                return rewrite
                    .join(&format!("api/releases/tags/{tag}"))
                    .map_err(|_| UpdateOperationError::InvalidResponse);
            } else {
                return Err(UpdateOperationError::InvalidResponse);
            };
            return rewrite
                .join(fixture_path)
                .map_err(|_| UpdateOperationError::InvalidResponse);
        }
        let segments = logical_url
            .path_segments()
            .ok_or(UpdateOperationError::InvalidResponse)?
            .collect::<Vec<_>>();
        let file = segments
            .last()
            .filter(|value| !value.is_empty())
            .ok_or(UpdateOperationError::InvalidResponse)?;
        let fixture_path = if logical_url.path().starts_with(GITHUB_STABLE_LATEST_PATH) {
            format!("latest/{file}")
        } else if let [_, _, "releases", "download", tag, _] = segments.as_slice() {
            format!("release/{tag}/{file}")
        } else {
            return Err(UpdateOperationError::InvalidResponse);
        };
        return rewrite
            .join(&fixture_path)
            .map_err(|_| UpdateOperationError::InvalidResponse);
    }
    Ok(logical_url.clone())
}

fn map_reqwest_error(error: reqwest::Error) -> UpdateOperationError {
    if error.is_timeout() {
        UpdateOperationError::Timeout
    } else if error.is_redirect() {
        UpdateOperationError::RedirectRejected
    } else {
        UpdateOperationError::Network
    }
}

fn reject_redirect_or_status(response: &Response) -> Result<(), UpdateOperationError> {
    if response.status().is_redirection() {
        return Err(UpdateOperationError::RedirectRejected);
    }
    if response.status() != StatusCode::OK {
        return Err(UpdateOperationError::InvalidResponse);
    }
    Ok(())
}

fn ensure_identity_encoding(response: &Response) -> Result<(), UpdateOperationError> {
    if response
        .headers()
        .get(CONTENT_ENCODING)
        .is_some_and(|value| value.as_bytes() != b"identity")
    {
        return Err(UpdateOperationError::InvalidResponse);
    }
    Ok(())
}

fn classify_download_response(
    response: &Response,
    partial: &PartialInfo,
    expected_size: u64,
) -> Result<(u64, bool), UpdateOperationError> {
    match response.status() {
        StatusCode::OK => {
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|length| length != expected_size)
            {
                return Err(UpdateOperationError::InvalidResponse);
            }
            Ok((0, false))
        }
        StatusCode::PARTIAL_CONTENT if partial.size > 0 => {
            let expected = format!(
                "bytes {}-{}/{}",
                partial.size,
                expected_size.saturating_sub(1),
                expected_size
            );
            if response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                != Some(expected.as_str())
            {
                return Err(UpdateOperationError::RangeMismatch);
            }
            let remaining = expected_size.saturating_sub(partial.size);
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|length| length != remaining)
            {
                return Err(UpdateOperationError::RangeMismatch);
            }
            Ok((partial.size, true))
        }
        status if status.is_redirection() => Err(UpdateOperationError::RedirectRejected),
        _ => Err(UpdateOperationError::InvalidResponse),
    }
}

fn strong_etag(response: &Response) -> Option<String> {
    let value = response.headers().get(ETAG)?.to_str().ok()?;
    (value.len() <= STRONG_ETAG_MAX_BYTES
        && value.starts_with('"')
        && value.ends_with('"')
        && !value.starts_with("W/"))
    .then(|| value.to_owned())
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartialInfo {
    size: u64,
    etag: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedCandidate {
    schema_version: u8,
    operation_id: String,
    identity: UpdateCandidateIdentity,
    metadata_base64: String,
    metadata_signature: String,
    release: AuthenticatedReleaseRecord,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartialManifest {
    candidate: PersistedCandidate,
    etag: Option<String>,
    resume_identity: String,
    updated_at_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedState {
    schema_version: u8,
    phase: PersistedPhase,
    candidate: PersistedCandidate,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PersistedPhase {
    Available,
    Ready,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryRecord {
    schema_version: u8,
    candidate: UpdateCandidateIdentity,
    ownership: RecoveryOwnership,
    commit: RecoveryCommit,
    evidence: RecoveryEvidence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryOwnership {
    machine_authority_sha256: String,
    scope_epoch: u64,
    operation_id: String,
    admitted_revision: u64,
    effect_id: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RecoveryCommit {
    Available,
    PartialDownload,
    CandidateCommitStarted,
    CandidateCommitted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryEvidence {
    progress_sequence: u64,
    committed_bytes: u64,
    strong_etag_sha256: Option<String>,
}

impl RecoveryRecord {
    fn check_available(
        candidate: &AvailableCandidate,
        correlation: &check_machine::EffectCorrelation,
    ) -> Self {
        Self {
            schema_version: RECOVERY_SCHEMA_VERSION,
            candidate: candidate.identity(),
            ownership: RecoveryOwnership {
                machine_authority_sha256: digest(correlation.machine_authority.as_bytes()),
                scope_epoch: correlation.scope_epoch,
                operation_id: correlation.operation_id.clone(),
                admitted_revision: correlation.admitted_revision,
                effect_id: correlation.effect_id,
            },
            commit: RecoveryCommit::Available,
            evidence: RecoveryEvidence {
                progress_sequence: 0,
                committed_bytes: 0,
                strong_etag_sha256: None,
            },
        }
    }

    fn continuation(
        candidate: &AvailableCandidate,
        correlation: &ContinuationCorrelation,
        commit: RecoveryCommit,
        partial: PartialInfo,
    ) -> Self {
        Self {
            schema_version: RECOVERY_SCHEMA_VERSION,
            candidate: candidate.identity(),
            ownership: RecoveryOwnership {
                machine_authority_sha256: digest(correlation.machine.machine_authority.as_bytes()),
                scope_epoch: correlation.machine.scope_epoch,
                operation_id: correlation.machine.operation_id.clone(),
                admitted_revision: correlation.machine.admitted_revision,
                effect_id: correlation.machine.effect_id,
            },
            commit,
            evidence: RecoveryEvidence {
                progress_sequence: correlation.progress_sequence,
                committed_bytes: partial.size,
                strong_etag_sha256: partial.etag.map(|etag| digest(etag.as_bytes())),
            },
        }
    }

    fn validates(&self, persisted: &PersistedCandidate) -> bool {
        self.schema_version == RECOVERY_SCHEMA_VERSION
            && self.candidate == persisted.identity
            && self.ownership.operation_id == persisted.operation_id
            && valid_digest(&self.ownership.machine_authority_sha256)
            && validate_operation_id(&self.ownership.operation_id).is_ok()
            && self.evidence.committed_bytes <= self.candidate.artifact_size
            && self
                .evidence
                .strong_etag_sha256
                .as_deref()
                .is_none_or(valid_digest)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptedMetadata {
    schema_version: u8,
    digests: Vec<String>,
    alpha_high_water: Option<String>,
    stable_high_water: Option<String>,
}

impl AcceptedMetadata {
    fn empty() -> Self {
        Self {
            schema_version: STORE_SCHEMA_VERSION,
            digests: Vec::new(),
            alpha_high_water: None,
            stable_high_water: None,
        }
    }

    fn high_water(&self, channel: UpdateChannel) -> Option<&str> {
        match channel {
            UpdateChannel::Alpha => self.alpha_high_water.as_deref(),
            UpdateChannel::Stable => self.stable_high_water.as_deref(),
        }
    }

    fn compare(&self, metadata: &VerifiedMetadata) -> Option<Ordering> {
        let high_water = self.high_water(metadata.channel)?;
        Some(
            parse_version(&metadata.version)
                .expect("authenticated version is canonical")
                .cmp(&parse_version(high_water).expect("persisted high-water version is valid")),
        )
    }

    fn require_newer(&self, metadata: &VerifiedMetadata) -> Result<(), UpdateOperationError> {
        match self.compare(metadata) {
            Some(Ordering::Less) => Err(UpdateOperationError::Verification(
                UpdaterError::DowngradeRejected,
            )),
            Some(Ordering::Equal) => Err(UpdateOperationError::Verification(
                UpdaterError::EqualVersionRejected,
            )),
            Some(Ordering::Greater) | None => Ok(()),
        }
    }

    fn record(&mut self, metadata: &VerifiedMetadata) {
        self.digests
            .retain(|digest| digest != &metadata.metadata_sha256);
        self.digests.push(metadata.metadata_sha256.clone());
        if self.digests.len() > ACCEPTED_METADATA_LIMIT {
            self.digests
                .drain(..self.digests.len() - ACCEPTED_METADATA_LIMIT);
        }
        if self
            .compare(metadata)
            .is_none_or(|ordering| ordering.is_gt())
        {
            match metadata.channel {
                UpdateChannel::Alpha => self.alpha_high_water = Some(metadata.version.clone()),
                UpdateChannel::Stable => self.stable_high_water = Some(metadata.version.clone()),
            }
        }
    }

    fn validate(&self) -> bool {
        self.schema_version == STORE_SCHEMA_VERSION
            && self.digests.len() <= ACCEPTED_METADATA_LIMIT
            && self.digests.iter().all(|value| valid_digest(value))
            && self
                .alpha_high_water
                .as_deref()
                .is_none_or(|version| valid_channel_version(version, UpdateChannel::Alpha))
            && self
                .stable_high_water
                .as_deref()
                .is_none_or(|version| valid_channel_version(version, UpdateChannel::Stable))
    }
}

#[derive(Clone)]
struct CandidateStore {
    root: PathBuf,
}

struct RecoveredState {
    accepted: AcceptedMetadata,
    available: Option<AvailableCandidate>,
    operation_id: Option<String>,
    phase: UpdatePhase,
    resumable: bool,
    terminal_reason: Option<String>,
    progress: Option<UpdateProgress>,
    needs_reverification: bool,
}

impl RecoveredState {
    fn idle(accepted: AcceptedMetadata) -> Self {
        Self {
            accepted,
            available: None,
            operation_id: None,
            phase: UpdatePhase::Idle,
            resumable: false,
            terminal_reason: None,
            progress: None,
            needs_reverification: false,
        }
    }

    fn snapshot(&self, authority_id: String) -> UpdaterSnapshot {
        let candidate = self.available.as_ref().map(AvailableCandidate::identity);
        UpdaterSnapshot {
            authority_id,
            revision: 0,
            configured: true,
            phase: self.phase,
            operation_id: self.operation_id.clone(),
            channel: candidate.as_ref().map(|candidate| candidate.channel),
            candidate,
            progress: self.progress.clone(),
            resumable: self.resumable,
            terminal_reason: self.terminal_reason.clone(),
        }
    }
}

impl CandidateStore {
    fn open(root: PathBuf) -> Result<Self, UpdateOperationError> {
        if !root.is_absolute() {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        ensure_directory(&root, 0o700)?;
        let root = fs::canonicalize(root).map_err(|_| UpdateOperationError::StoreIo)?;
        ensure_private_directory(&root)?;
        let store = Self { root };
        store.cleanup_unrecognized()?;
        Ok(store)
    }

    fn recover(
        &self,
        adapter: &UpdaterAdapter,
        policy: &UpdatePolicy,
        limits: &UpdaterLimits,
    ) -> Result<RecoveredState, UpdateOperationError> {
        let accepted = self.read_accepted()?;
        if let Ok(state) = self.read_json::<PersistedState>(&self.root.join(STATE_FILE))
            && state.schema_version == STORE_SCHEMA_VERSION
            && let Ok(recovery) = self.read_json::<RecoveryRecord>(&self.root.join(RECOVERY_FILE))
            && recovery.validates(&state.candidate)
        {
            let accepted_for_candidate = accepted
                .digests
                .iter()
                .filter(|digest| *digest != &state.candidate.identity.metadata_sha256)
                .cloned()
                .collect::<Vec<_>>();
            if let Ok(available) = decode_persisted_candidate(
                adapter,
                policy,
                &accepted_for_candidate,
                &state.candidate,
            ) {
                match state.phase {
                    PersistedPhase::Ready => {
                        if !matches!(
                            recovery.commit,
                            RecoveryCommit::CandidateCommitStarted
                                | RecoveryCommit::CandidateCommitted
                        ) {
                            self.discard_managed_state()?;
                            return Ok(RecoveredState::idle(accepted));
                        }
                        let accepted_identity = accepted
                            .digests
                            .contains(&available.metadata.metadata_sha256);
                        let high_water_allows = match accepted.compare(&available.metadata) {
                            Some(Ordering::Less) => false,
                            Some(Ordering::Equal) => accepted_identity,
                            Some(Ordering::Greater) | None => true,
                        };
                        if high_water_allows {
                            return Ok(RecoveredState {
                                accepted,
                                available: Some(available.clone()),
                                operation_id: Some(state.candidate.operation_id),
                                phase: UpdatePhase::Failed,
                                resumable: false,
                                terminal_reason: Some("recovery-required".into()),
                                progress: Some(UpdateProgress {
                                    downloaded_bytes: available.metadata.artifact_size,
                                    total_bytes: available.metadata.artifact_size,
                                }),
                                needs_reverification: true,
                            });
                        }
                        self.discard_candidate()?;
                    }
                    PersistedPhase::Available => {
                        if recovery.commit == RecoveryCommit::CandidateCommitStarted {
                            let accepted_identity = accepted
                                .digests
                                .contains(&available.metadata.metadata_sha256);
                            let high_water_allows = match accepted.compare(&available.metadata) {
                                Some(Ordering::Less) => false,
                                Some(Ordering::Equal) => accepted_identity,
                                Some(Ordering::Greater) | None => true,
                            };
                            if high_water_allows
                                && self.inspect_candidate(&available, &state.candidate).is_ok()
                            {
                                return Ok(RecoveredState {
                                    accepted,
                                    available: Some(available.clone()),
                                    operation_id: Some(state.candidate.operation_id),
                                    phase: UpdatePhase::Failed,
                                    resumable: false,
                                    terminal_reason: Some("recovery-required".into()),
                                    progress: Some(UpdateProgress {
                                        downloaded_bytes: available.metadata.artifact_size,
                                        total_bytes: available.metadata.artifact_size,
                                    }),
                                    needs_reverification: true,
                                });
                            }
                            self.discard_managed_state()?;
                            return Ok(RecoveredState::idle(accepted));
                        }
                        if !matches!(
                            recovery.commit,
                            RecoveryCommit::Available | RecoveryCommit::PartialDownload
                        ) {
                            self.discard_managed_state()?;
                            return Ok(RecoveredState::idle(accepted));
                        }
                        if accepted.require_newer(&available.metadata).is_err() {
                            self.discard_managed_state()?;
                            return Ok(RecoveredState {
                                accepted,
                                available: None,
                                operation_id: None,
                                phase: UpdatePhase::Idle,
                                resumable: false,
                                terminal_reason: None,
                                progress: None,
                                needs_reverification: false,
                            });
                        }
                        let partial = self
                            .partial_info(&available, &state.candidate.operation_id)
                            .ok();
                        let resumable = partial
                            .as_ref()
                            .is_some_and(|partial| partial.size > 0 && partial.etag.is_some());
                        let stale = self.partial_is_stale(limits)?;
                        if stale {
                            self.discard_partial()?;
                        }
                        let progress = partial.filter(|_| !stale).map(|partial| UpdateProgress {
                            downloaded_bytes: partial.size,
                            total_bytes: available.metadata.artifact_size,
                        });
                        return Ok(RecoveredState {
                            accepted,
                            available: Some(available),
                            operation_id: Some(state.candidate.operation_id),
                            phase: if progress.is_some() {
                                UpdatePhase::Failed
                            } else {
                                UpdatePhase::Available
                            },
                            resumable: resumable && !stale,
                            terminal_reason: progress.as_ref().map(|_| "interrupted".to_owned()),
                            progress,
                            needs_reverification: false,
                        });
                    }
                }
            }
        }
        self.discard_managed_state()?;
        Ok(RecoveredState {
            accepted,
            available: None,
            operation_id: None,
            phase: UpdatePhase::Idle,
            resumable: false,
            terminal_reason: None,
            progress: None,
            needs_reverification: false,
        })
    }

    fn persist_available(
        &self,
        available: &AvailableCandidate,
        correlation: &check_machine::EffectCorrelation,
    ) -> Result<(), UpdateOperationError> {
        let operation_id = correlation.operation_id.as_str();
        let persisted = available.persisted(operation_id);
        if self
            .read_json::<PartialManifest>(&self.root.join(PARTIAL_DIRECTORY).join(PARTIAL_MANIFEST))
            .ok()
            .is_some_and(|manifest| {
                manifest.resume_identity != persisted.identity.resume_identity(&persisted.release)
            })
        {
            self.discard_partial()?;
        }
        self.write_json_atomic(
            &self.root.join(STATE_FILE),
            &PersistedState {
                schema_version: STORE_SCHEMA_VERSION,
                phase: PersistedPhase::Available,
                candidate: persisted,
            },
            0o600,
        )?;
        self.write_json_atomic(
            &self.root.join(RECOVERY_FILE),
            &RecoveryRecord::check_available(available, correlation),
            0o600,
        )
    }

    fn prepare_partial(
        &self,
        available: &AvailableCandidate,
        operation_id: &str,
    ) -> Result<PartialInfo, UpdateOperationError> {
        let persisted = available.persisted(operation_id);
        let expected_resume = persisted.identity.resume_identity(&persisted.release);
        let directory = self.root.join(PARTIAL_DIRECTORY);
        if directory.exists() {
            let manifest = self
                .read_json::<PartialManifest>(&directory.join(PARTIAL_MANIFEST))
                .ok();
            let payload = directory.join(PARTIAL_PAYLOAD);
            if manifest.as_ref().is_none_or(|manifest| {
                manifest.candidate.operation_id != operation_id
                    || manifest.resume_identity != expected_resume
                    || manifest.candidate.identity != persisted.identity
            }) || validate_private_file(&payload, None).is_err()
            {
                self.discard_partial()?;
            }
        }
        if !directory.exists() {
            ensure_directory(&directory, 0o700)?;
            create_private_file(&directory.join(PARTIAL_PAYLOAD), 0o600)?;
            self.write_json_atomic(
                &directory.join(PARTIAL_MANIFEST),
                &PartialManifest {
                    candidate: persisted,
                    etag: None,
                    resume_identity: expected_resume,
                    updated_at_seconds: now_seconds(),
                },
                0o600,
            )?;
        }
        self.partial_info(available, operation_id)
    }

    fn partial_info(
        &self,
        available: &AvailableCandidate,
        operation_id: &str,
    ) -> Result<PartialInfo, UpdateOperationError> {
        let directory = self.root.join(PARTIAL_DIRECTORY);
        ensure_private_directory(&directory)?;
        validate_exact_entries(&directory, &[PARTIAL_MANIFEST, PARTIAL_PAYLOAD])?;
        let manifest = self.read_json::<PartialManifest>(&directory.join(PARTIAL_MANIFEST))?;
        if manifest.resume_identity != available.identity().resume_identity(&available.release)
            || manifest.candidate != available.persisted(operation_id)
        {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        let payload = directory.join(PARTIAL_PAYLOAD);
        let metadata = validate_private_file(&payload, None)?;
        if metadata.len() > available.metadata.artifact_size {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        Ok(PartialInfo {
            size: metadata.len(),
            etag: manifest.etag,
        })
    }

    fn partial_payload_path(&self) -> PathBuf {
        self.root.join(PARTIAL_DIRECTORY).join(PARTIAL_PAYLOAD)
    }

    fn reset_partial(
        &self,
        available: &AvailableCandidate,
        operation_id: &str,
    ) -> Result<(), UpdateOperationError> {
        self.discard_partial()?;
        self.prepare_partial(available, operation_id)?;
        Ok(())
    }

    fn set_partial_etag(
        &self,
        available: &AvailableCandidate,
        operation_id: &str,
        etag: Option<&str>,
    ) -> Result<(), UpdateOperationError> {
        let directory = self.root.join(PARTIAL_DIRECTORY);
        let persisted = available.persisted(operation_id);
        self.write_json_atomic(
            &directory.join(PARTIAL_MANIFEST),
            &PartialManifest {
                resume_identity: persisted.identity.resume_identity(&persisted.release),
                candidate: persisted,
                etag: etag.map(str::to_owned),
                updated_at_seconds: now_seconds(),
            },
            0o600,
        )
    }

    fn record_partial_commit(
        &self,
        available: &AvailableCandidate,
        correlation: &ContinuationCorrelation,
        committed_bytes: u64,
    ) -> Result<(), UpdateOperationError> {
        let partial = self.partial_info(available, &correlation.machine.operation_id)?;
        if partial.size != committed_bytes {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        self.write_json_atomic(
            &self.root.join(RECOVERY_FILE),
            &RecoveryRecord::continuation(
                available,
                correlation,
                RecoveryCommit::PartialDownload,
                partial,
            ),
            0o600,
        )
    }

    fn publish_candidate(
        &self,
        available: &AvailableCandidate,
        correlation: &ContinuationCorrelation,
    ) -> Result<(), UpdateOperationError> {
        let operation_id = correlation.machine.operation_id.as_str();
        let partial = self.partial_info(available, operation_id)?;
        if partial.size != available.metadata.artifact_size {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        self.write_json_atomic(
            &self.root.join(RECOVERY_FILE),
            &RecoveryRecord::continuation(
                available,
                correlation,
                RecoveryCommit::CandidateCommitStarted,
                partial,
            ),
            0o600,
        )?;
        self.discard_candidate()?;
        let temporary = self
            .root
            .join(format!("candidate.new-{}", Uuid::new_v4().simple()));
        ensure_directory(&temporary, 0o700)?;
        fs::rename(
            self.partial_payload_path(),
            temporary.join(CANDIDATE_PAYLOAD),
        )
        .map_err(|_| UpdateOperationError::StoreIo)?;
        let persisted = available.persisted(operation_id);
        self.write_json_atomic(&temporary.join(CANDIDATE_MANIFEST), &persisted, 0o400)?;
        set_permissions(&temporary.join(CANDIDATE_PAYLOAD), 0o400)?;
        sync_directory(&temporary)?;
        set_permissions(&temporary, 0o500)?;
        fs::rename(&temporary, self.root.join(CANDIDATE_DIRECTORY))
            .map_err(|_| UpdateOperationError::StoreIo)?;
        sync_directory(&self.root)?;
        self.discard_partial()?;
        self.write_json_atomic(
            &self.root.join(STATE_FILE),
            &PersistedState {
                schema_version: STORE_SCHEMA_VERSION,
                phase: PersistedPhase::Ready,
                candidate: persisted.clone(),
            },
            0o600,
        )?;
        let mut accepted = self.read_accepted()?;
        accepted.record(&available.metadata);
        self.write_accepted(&accepted)?;
        self.write_json_atomic(
            &self.root.join(RECOVERY_FILE),
            &RecoveryRecord::continuation(
                available,
                correlation,
                RecoveryCommit::CandidateCommitted,
                PartialInfo {
                    size: available.metadata.artifact_size,
                    etag: None,
                },
            ),
            0o600,
        )
    }

    fn verify_ready(
        &self,
        adapter: &UpdaterAdapter,
        available: &AvailableCandidate,
        expected: &PersistedCandidate,
    ) -> Result<(), UpdateOperationError> {
        let payload = self.inspect_candidate(available, expected)?;
        adapter
            .verify_payload_file(
                &available.metadata,
                &available.metadata.artifact_name,
                &payload,
                &available.metadata.artifact_signature,
            )
            .map_err(UpdateOperationError::Verification)
    }

    fn inspect_candidate(
        &self,
        available: &AvailableCandidate,
        expected: &PersistedCandidate,
    ) -> Result<PathBuf, UpdateOperationError> {
        let directory = self.root.join(CANDIDATE_DIRECTORY);
        ensure_private_directory(&directory)?;
        validate_exact_entries(&directory, &[CANDIDATE_MANIFEST, CANDIDATE_PAYLOAD])?;
        let manifest = self.read_json::<PersistedCandidate>(&directory.join(CANDIDATE_MANIFEST))?;
        if &manifest != expected {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        let payload = directory.join(CANDIDATE_PAYLOAD);
        validate_private_file(&payload, Some(available.metadata.artifact_size))?;
        Ok(payload)
    }

    fn record_reverified(
        &self,
        available: &AvailableCandidate,
        correlation: &ContinuationCorrelation,
    ) -> Result<(), UpdateOperationError> {
        let mut accepted = self.read_accepted()?;
        accepted.record(&available.metadata);
        self.write_accepted(&accepted)?;
        self.write_json_atomic(
            &self.root.join(RECOVERY_FILE),
            &RecoveryRecord::continuation(
                available,
                correlation,
                RecoveryCommit::CandidateCommitted,
                PartialInfo {
                    size: available.metadata.artifact_size,
                    etag: None,
                },
            ),
            0o600,
        )
    }

    fn partial_is_stale(&self, limits: &UpdaterLimits) -> Result<bool, UpdateOperationError> {
        let manifest_path = self.root.join(PARTIAL_DIRECTORY).join(PARTIAL_MANIFEST);
        if !manifest_path.exists() {
            return Ok(false);
        }
        let manifest = self.read_json::<PartialManifest>(&manifest_path)?;
        let now = now_seconds();
        if manifest.updated_at_seconds > now.saturating_add(300) {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        Ok(now.saturating_sub(manifest.updated_at_seconds) > limits.stale_partial_age.as_secs())
    }

    fn cleanup_unrecognized(&self) -> Result<(), UpdateOperationError> {
        let entries = fs::read_dir(&self.root)
            .map_err(|_| UpdateOperationError::StoreIo)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| UpdateOperationError::StoreIo)?;
        if entries.len() > STORE_ENTRY_LIMIT {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        let recognized = BTreeSet::from([
            STATE_FILE,
            RECOVERY_FILE,
            ACCEPTED_FILE,
            PARTIAL_DIRECTORY,
            CANDIDATE_DIRECTORY,
        ]);
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                remove_entry_without_following(&entry.path())?;
                continue;
            };
            if recognized.contains(name) {
                continue;
            }
            if name.starts_with("state.json.tmp-")
                || name.starts_with("accepted.json.tmp-")
                || name.starts_with("recovery.json.tmp-")
                || name.starts_with("manifest.json.tmp-")
                || name.starts_with("candidate.new-")
            {
                remove_entry_without_following(&entry.path())?;
                continue;
            }
            remove_entry_without_following(&entry.path())?;
        }
        Ok(())
    }

    fn discard_managed_state(&self) -> Result<(), UpdateOperationError> {
        self.discard_partial()?;
        self.discard_candidate()?;
        remove_file_if_present(&self.root.join(STATE_FILE))?;
        remove_file_if_present(&self.root.join(RECOVERY_FILE))
    }

    fn discard_partial(&self) -> Result<(), UpdateOperationError> {
        remove_entry_without_following(&self.root.join(PARTIAL_DIRECTORY))
    }

    fn discard_candidate(&self) -> Result<(), UpdateOperationError> {
        remove_entry_without_following(&self.root.join(CANDIDATE_DIRECTORY))
    }

    fn read_accepted(&self) -> Result<AcceptedMetadata, UpdateOperationError> {
        let path = self.root.join(ACCEPTED_FILE);
        if !path.exists() {
            return Ok(AcceptedMetadata::empty());
        }
        let accepted = self.read_json::<AcceptedMetadata>(&path)?;
        if !accepted.validate() {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        Ok(accepted)
    }

    fn write_accepted(&self, accepted: &AcceptedMetadata) -> Result<(), UpdateOperationError> {
        self.write_json_atomic(&self.root.join(ACCEPTED_FILE), accepted, 0o600)
    }

    fn read_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &Path,
    ) -> Result<T, UpdateOperationError> {
        let metadata = validate_private_file(path, None)?;
        if metadata.len() > 512 * 1024 {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        let bytes = fs::read(path).map_err(|_| UpdateOperationError::StoreIo)?;
        serde_json::from_slice(&bytes).map_err(|_| UpdateOperationError::StoreUnsafe)
    }

    fn write_json_atomic<T: Serialize>(
        &self,
        path: &Path,
        value: &T,
        mode: u32,
    ) -> Result<(), UpdateOperationError> {
        let parent = path.parent().ok_or(UpdateOperationError::StoreUnsafe)?;
        ensure_private_directory(parent)?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(UpdateOperationError::StoreUnsafe)?;
        let temporary = parent.join(format!("{file_name}.tmp-{}", Uuid::new_v4().simple()));
        let bytes = serde_json::to_vec(value).map_err(|_| UpdateOperationError::StoreIo)?;
        let mut file = open_new_private_file(&temporary, mode)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| UpdateOperationError::StoreIo)?;
        fs::rename(&temporary, path).map_err(|_| UpdateOperationError::StoreIo)?;
        set_permissions(path, mode)?;
        sync_directory(parent)
    }
}

fn decode_persisted_candidate(
    adapter: &UpdaterAdapter,
    policy: &UpdatePolicy,
    accepted: &[String],
    persisted: &PersistedCandidate,
) -> Result<AvailableCandidate, UpdateOperationError> {
    if persisted.schema_version != CANDIDATE_SCHEMA_VERSION {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    validate_operation_id(&persisted.operation_id)?;
    let metadata_bytes = STANDARD
        .decode(&persisted.metadata_base64)
        .map_err(|_| UpdateOperationError::StoreUnsafe)?;
    let metadata = adapter.verify_metadata(VerifyMetadataRequest {
        accepted_metadata_sha256: accepted,
        metadata: &metadata_bytes,
        metadata_signature: &persisted.metadata_signature,
        policy: policy.clone(),
    })?;
    if !persisted
        .release
        .validates(metadata.channel, &metadata.version)
        || UpdateCandidateIdentity::from_verified(&metadata) != persisted.identity
    {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    Ok(AvailableCandidate {
        metadata,
        metadata_bytes,
        metadata_signature: persisted.metadata_signature.clone(),
        release: persisted.release.clone(),
    })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_channel_version(value: &str, channel: UpdateChannel) -> bool {
    parse_version(value)
        .ok()
        .is_some_and(|version| validate_channel_version(&version, channel).is_ok())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn ensure_directory(path: &Path, mode: u32) -> Result<(), UpdateOperationError> {
    if path.exists() {
        ensure_private_directory(path)?;
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|_| UpdateOperationError::StoreIo)?;
    set_permissions(path, mode)?;
    ensure_private_directory(path)
}

fn ensure_private_directory(path: &Path) -> Result<(), UpdateOperationError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UpdateOperationError::StoreUnsafe)?;
    if !metadata.file_type().is_dir() {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    validate_owner_and_mode(&metadata, true)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), UpdateOperationError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| UpdateOperationError::StoreIo)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), UpdateOperationError> {
    Ok(())
}

fn validate_exact_entries(directory: &Path, expected: &[&str]) -> Result<(), UpdateOperationError> {
    let entries = fs::read_dir(directory)
        .map_err(|_| UpdateOperationError::StoreIo)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| UpdateOperationError::StoreIo)?;
    if entries.len() != expected.len() || entries.len() > STORE_ENTRY_LIMIT {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if entries.iter().all(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| expected.contains(name))
    }) {
        Ok(())
    } else {
        Err(UpdateOperationError::StoreUnsafe)
    }
}

fn validate_private_file(
    path: &Path,
    expected_size: Option<u64>,
) -> Result<fs::Metadata, UpdateOperationError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UpdateOperationError::StoreUnsafe)?;
    if !metadata.file_type().is_file() {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    validate_owner_and_mode(&metadata, false)?;
    if expected_size.is_some_and(|size| metadata.len() != size) {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    Ok(metadata)
}

#[cfg(unix)]
fn validate_owner_and_mode(
    metadata: &fs::Metadata,
    directory: bool,
) -> Result<(), UpdateOperationError> {
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || (!directory && metadata.nlink() != 1)
    {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_owner_and_mode(
    _metadata: &fs::Metadata,
    _directory: bool,
) -> Result<(), UpdateOperationError> {
    Ok(())
}

fn create_private_file(path: &Path, mode: u32) -> Result<(), UpdateOperationError> {
    open_new_private_file(path, mode).map(|_| ())
}

fn open_new_private_file(path: &Path, mode: u32) -> Result<File, UpdateOperationError> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| UpdateOperationError::StoreIo)?;
    set_permissions(path, mode)?;
    Ok(file)
}

#[cfg(unix)]
fn set_permissions(path: &Path, mode: u32) -> Result<(), UpdateOperationError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| UpdateOperationError::StoreIo)
}

#[cfg(not(unix))]
fn set_permissions(_path: &Path, _mode: u32) -> Result<(), UpdateOperationError> {
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<(), UpdateOperationError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(UpdateOperationError::StoreIo),
    }
}

fn remove_entry_without_following(path: &Path) -> Result<(), UpdateOperationError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(UpdateOperationError::StoreIo),
    };
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        validate_owner_and_mode(&metadata, true)?;
        set_permissions(path, 0o700)?;
        let entries = fs::read_dir(path)
            .map_err(|_| UpdateOperationError::StoreIo)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| UpdateOperationError::StoreIo)?;
        if entries.len() > STORE_ENTRY_LIMIT {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        for entry in entries {
            remove_entry_without_following(&entry.path())?;
        }
        fs::remove_dir(path).map_err(|_| UpdateOperationError::StoreIo)
    } else {
        fs::remove_file(path).map_err(|_| UpdateOperationError::StoreIo)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        net::{Ipv4Addr, SocketAddr},
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use axum::{
        Router,
        body::{Body, Bytes},
        extract::{Path as AxumPath, State},
        http::{HeaderMap, Response as HttpResponse, header},
        response::IntoResponse,
        routing::get,
    };
    use futures_util::stream;
    use tempfile::TempDir;
    use tokio::{
        net::TcpListener,
        sync::{Barrier, Notify},
        task::{JoinHandle, JoinSet},
    };

    use super::*;
    use crate::InstalledUpdate;

    const PUBLIC_KEY: &str =
        include_str!("../../../scripts/fixtures/macos-updater/updater-fixture.key.pub");
    const METADATA: &[u8] =
        include_bytes!("../../../scripts/fixtures/macos-updater/mish-alpha.json");
    const METADATA_SIGNATURE: &str =
        include_str!("../../../scripts/fixtures/macos-updater/mish-alpha.json.sig");
    const ARTIFACT: &[u8] = include_bytes!(
        "../../../scripts/fixtures/macos-updater/Mish-0.1.1-alpha.2-aarch64.app.tar.gz"
    );
    const ARTIFACT_SIGNATURE: &str = include_str!(
        "../../../scripts/fixtures/macos-updater/Mish-0.1.1-alpha.2-aarch64.app.tar.gz.sig"
    );
    const STABLE_METADATA: &[u8] =
        include_bytes!("../../../scripts/fixtures/macos-updater/mish-stable.json");
    const STABLE_METADATA_SIGNATURE: &str =
        include_str!("../../../scripts/fixtures/macos-updater/mish-stable.json.sig");
    const STABLE_ARTIFACT: &[u8] =
        include_bytes!("../../../scripts/fixtures/macos-updater/Mish-0.1.1-aarch64.app.tar.gz");
    const STABLE_ARTIFACT_SIGNATURE: &str =
        include_str!("../../../scripts/fixtures/macos-updater/Mish-0.1.1-aarch64.app.tar.gz.sig");

    #[derive(Clone)]
    enum FakeDiscovery {
        Barrier {
            release: Arc<Notify>,
            started: Arc<Notify>,
        },
        CompletionConflict,
        Immediate,
        Panic,
        Pending,
    }

    #[derive(Clone)]
    enum FakeCommit {
        Barrier {
            release: Arc<Notify>,
            started: Arc<Notify>,
        },
        Failure(UpdateOperationError),
        Immediate,
    }

    struct FakeCheckEffectExecutor {
        candidate: AvailableCandidate,
        discovery: FakeDiscovery,
        commit: FakeCommit,
    }

    impl CheckEffectExecutor for FakeCheckEffectExecutor {
        fn execute(
            &self,
            effect: CheckEffect,
            _cancellation: CancellationToken,
        ) -> CheckEffectFuture {
            let candidate = self.candidate.clone();
            let discovery = self.discovery.clone();
            let commit = self.commit.clone();
            Box::pin(async move {
                match effect {
                    CheckEffect::Discover {
                        mut correlation, ..
                    } => match discovery {
                        FakeDiscovery::Barrier { release, started } => {
                            started.notify_one();
                            release.notified().await;
                            CheckCompletion {
                                correlation,
                                outcome: CheckEffectOutcome::Discovery(Ok(
                                    DiscoveryOutcome::Available(Box::new(candidate)),
                                )),
                            }
                        }
                        FakeDiscovery::CompletionConflict => {
                            correlation.scope_epoch = correlation.scope_epoch.saturating_add(1);
                            CheckCompletion {
                                correlation,
                                outcome: CheckEffectOutcome::Discovery(Ok(
                                    DiscoveryOutcome::Available(Box::new(candidate)),
                                )),
                            }
                        }
                        FakeDiscovery::Immediate => CheckCompletion {
                            correlation,
                            outcome: CheckEffectOutcome::Discovery(Ok(
                                DiscoveryOutcome::Available(Box::new(candidate)),
                            )),
                        },
                        FakeDiscovery::Panic => panic!("injected Check effect panic"),
                        FakeDiscovery::Pending => std::future::pending().await,
                    },
                    CheckEffect::CommitAvailable { correlation, .. } => match commit {
                        FakeCommit::Barrier { release, started } => {
                            started.notify_one();
                            release.notified().await;
                            CheckCompletion {
                                correlation,
                                outcome: CheckEffectOutcome::Commit(Ok(())),
                            }
                        }
                        FakeCommit::Failure(error) => CheckCompletion {
                            correlation,
                            outcome: CheckEffectOutcome::Commit(Err(error)),
                        },
                        FakeCommit::Immediate => CheckCompletion {
                            correlation,
                            outcome: CheckEffectOutcome::Commit(Ok(())),
                        },
                    },
                    CheckEffect::Cancel { correlation } => CheckCompletion {
                        correlation,
                        outcome: CheckEffectOutcome::TaskFailed(
                            CheckTaskFailure::CompletionConflict,
                        ),
                    },
                }
            })
        }
    }

    fn fake_candidate() -> AvailableCandidate {
        AvailableCandidate {
            metadata: crate::VerifiedMetadata {
                artifact_name: "Mish-0.1.1-alpha.2-aarch64.app.tar.gz".into(),
                artifact_sha256: "a".repeat(64),
                artifact_signature: "private signature material".into(),
                artifact_size: 16,
                artifact_url: "https://credential@example.invalid/private".into(),
                channel: UpdateChannel::Alpha,
                channel_switch: false,
                metadata_sha256: "b".repeat(64),
                skipped_version: false,
                source_sha: "c".repeat(40),
                version: "0.1.1-alpha.2".into(),
            },
            metadata_bytes: b"raw private metadata body".to_vec(),
            metadata_signature: "private metadata signature".into(),
            release: AuthenticatedReleaseRecord {
                assets: vec![AuthenticatedReleaseAsset {
                    id: 11,
                    name: "Mish-0.1.1-alpha.2-aarch64.app.tar.gz".into(),
                }],
                channel: UpdateChannel::Alpha,
                id: 7,
                published_at: "2026-07-27T00:00:00Z".into(),
                tag: "v0.1.1-alpha.2".into(),
                version: "0.1.1-alpha.2".into(),
            },
        }
    }

    type FakeCheckRuntime = (
        Arc<CheckRuntime>,
        Arc<Mutex<RuntimeState>>,
        Arc<Mutex<VecDeque<UpdaterCheckTransitionEvidence>>>,
    );

    fn fake_check_runtime(discovery: FakeDiscovery) -> FakeCheckRuntime {
        fake_check_runtime_with_commit(discovery, FakeCommit::Immediate)
    }

    fn fake_check_runtime_with_commit(
        discovery: FakeDiscovery,
        commit: FakeCommit,
    ) -> FakeCheckRuntime {
        let snapshot = UpdaterSnapshot::idle("test-authority".into(), true);
        let state = Arc::new(Mutex::new(RuntimeState {
            snapshot,
            accepted: AcceptedMetadata::empty(),
            available: None,
            release_context_bound: false,
            operation_admission_pending: false,
        }));
        let (updates, _) = broadcast::channel(32);
        let evidence = Arc::new(Mutex::new(VecDeque::new()));
        let runtime = Arc::new(CheckRuntime::spawn(
            state.clone(),
            updates,
            evidence.clone(),
            Arc::new(FakeCheckEffectExecutor {
                candidate: fake_candidate(),
                discovery,
                commit,
            }),
        ));
        (runtime, state, evidence)
    }

    async fn wait_runtime_phase(
        state: &Arc<Mutex<RuntimeState>>,
        phase: UpdatePhase,
    ) -> UpdaterSnapshot {
        timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = state.lock().unwrap().snapshot.clone();
                if snapshot.phase == phase {
                    return snapshot;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn bounded_inbox_serializes_single_flight_admission() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (runtime, state, _) = fake_check_runtime(FakeDiscovery::Barrier {
            release: release.clone(),
            started: started.clone(),
        });
        let mut commands = JoinSet::new();
        for index in 0..64 {
            let runtime = runtime.clone();
            commands.spawn(async move {
                runtime
                    .start(format!("operation-{index}"), UpdateChannel::Alpha)
                    .await
            });
        }
        started.notified().await;
        let mut admitted = 0;
        let mut busy = 0;
        while let Some(result) = commands.join_next().await {
            match result.unwrap() {
                Ok(snapshot) => {
                    admitted += 1;
                    assert_eq!(snapshot.phase, UpdatePhase::Checking);
                }
                Err(UpdateOperationError::Busy) => busy += 1,
                Err(error) => panic!("unexpected admission result: {error:?}"),
            }
        }
        assert_eq!(admitted, 1);
        assert_eq!(busy, 63);
        release.notify_one();
        wait_runtime_phase(&state, UpdatePhase::Available).await;
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn barrier_completion_cannot_cross_cancel_linearization() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (runtime, state, evidence) = fake_check_runtime(FakeDiscovery::Barrier {
            release: release.clone(),
            started: started.clone(),
        });
        let checking = runtime
            .start("operation-a".into(), UpdateChannel::Alpha)
            .await
            .unwrap();
        assert_eq!(checking.phase, UpdatePhase::Checking);
        started.notified().await;
        let cancelling = runtime.cancel("operation-a".into()).await.unwrap();
        assert_eq!(cancelling.phase, UpdatePhase::Checking);
        release.notify_one();
        let cancelled = wait_runtime_phase(&state, UpdatePhase::Cancelled).await;
        assert_eq!(cancelled.operation_id.as_deref(), Some("operation-a"));
        assert!(cancelled.candidate.is_none());
        let rendered = serde_json::to_string(&*evidence.lock().unwrap()).unwrap();
        assert!(rendered.contains("checking-cancel-requested"));
        assert!(!rendered.contains("credential"));
        assert!(!rendered.contains("raw private metadata"));
        assert!(!rendered.contains("signature material"));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn commit_barrier_is_cancel_cutoff_and_commit_failure_is_terminal() {
        let commit_started = Arc::new(Notify::new());
        let commit_release = Arc::new(Notify::new());
        let (runtime, state, evidence) = fake_check_runtime_with_commit(
            FakeDiscovery::Immediate,
            FakeCommit::Barrier {
                release: commit_release.clone(),
                started: commit_started.clone(),
            },
        );
        runtime
            .start("operation-a".into(), UpdateChannel::Alpha)
            .await
            .unwrap();
        commit_started.notified().await;

        let too_late = runtime.cancel("operation-a".into()).await.unwrap();
        assert_eq!(too_late.phase, UpdatePhase::Checking);
        assert!(
            evidence
                .lock()
                .unwrap()
                .iter()
                .any(|record| record.disposition == "cancel-too-late")
        );

        commit_release.notify_one();
        let available = wait_runtime_phase(&state, UpdatePhase::Available).await;
        assert!(available.candidate.is_some());
        runtime.shutdown().await;

        let (runtime, state, _) = fake_check_runtime_with_commit(
            FakeDiscovery::Immediate,
            FakeCommit::Failure(UpdateOperationError::StoreIo),
        );
        runtime
            .start("operation-b".into(), UpdateChannel::Alpha)
            .await
            .unwrap();
        let failed = wait_runtime_phase(&state, UpdatePhase::Failed).await;
        assert_eq!(failed.terminal_reason.as_deref(), Some("store-io"));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn panic_and_conflicting_completion_finalize_without_stuck_checking() {
        for (discovery, expected) in [
            (FakeDiscovery::Panic, "effect-panicked"),
            (
                FakeDiscovery::CompletionConflict,
                "effect-completion-conflict",
            ),
        ] {
            let (runtime, state, evidence) = fake_check_runtime(discovery);
            runtime
                .start("operation-a".into(), UpdateChannel::Alpha)
                .await
                .unwrap();
            let failed = wait_runtime_phase(&state, UpdatePhase::Failed).await;
            assert_eq!(failed.terminal_reason.as_deref(), Some(expected));
            if expected == "effect-completion-conflict" {
                assert!(
                    evidence
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|record| { record.disposition == "retired-completion" })
                );
            }
            runtime.shutdown().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn paused_time_shutdown_aborts_and_finalizes_uncooperative_effect() {
        let (runtime, state, evidence) = fake_check_runtime(FakeDiscovery::Pending);
        runtime
            .start("operation-a".into(), UpdateChannel::Alpha)
            .await
            .unwrap();
        let shutdown = {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                runtime.shutdown().await;
            })
        };
        tokio::task::yield_now().await;
        tokio::time::advance(CHECK_SHUTDOWN_GRACE + Duration::from_millis(1)).await;
        shutdown.await.unwrap();
        let snapshot = state.lock().unwrap().snapshot.clone();
        assert_eq!(snapshot.phase, UpdatePhase::Cancelled);
        assert!(
            evidence
                .lock()
                .unwrap()
                .iter()
                .any(|record| { record.input == "effect-aborted" && record.to == "retired" })
        );
    }

    #[tokio::test]
    async fn evidence_is_bounded_and_contains_complete_nonsecret_correlation() {
        let (runtime, state, evidence) = fake_check_runtime(FakeDiscovery::Immediate);
        for index in 0..40 {
            runtime
                .start(format!("secret-operation-{index}"), UpdateChannel::Alpha)
                .await
                .unwrap();
            wait_runtime_phase(&state, UpdatePhase::Available).await;
        }
        let evidence = evidence.lock().unwrap().clone();
        assert_eq!(evidence.len(), CHECK_EVIDENCE_LIMIT);
        assert!(evidence.iter().all(|record| {
            record
                .machine_authority_sha256
                .as_ref()
                .is_some_and(|value| value.len() == 64)
                && record.scope_epoch.is_some()
                && record.admitted_revision.is_some()
                && record.effect_id.is_some()
                && record
                    .operation_id_sha256
                    .as_ref()
                    .is_some_and(|value| value.len() == 64)
        }));
        let rendered = serde_json::to_string(&evidence).unwrap();
        assert!(!rendered.contains("test-authority"));
        assert!(!rendered.contains("secret-operation"));
        assert!(!rendered.contains("example.invalid"));
        assert!(!rendered.contains("private"));
        runtime.shutdown().await;
    }

    #[derive(Clone, Copy, Debug)]
    enum MetadataMode {
        Good,
        BadSignature,
        Oversized,
        Slow,
    }

    #[derive(Clone, Copy, Debug)]
    enum ArtifactMode {
        Success,
        Slow,
        IgnoreRange,
        Corrupt,
        Truncated,
        Oversized,
        Redirect,
    }

    #[derive(Clone, Copy, Debug)]
    enum ArtifactSignatureMode {
        Good,
        Missing,
        Substituted,
    }

    #[derive(Clone, Copy, Debug)]
    enum ReleaseMode {
        Draft,
        Good,
        Mutable,
        Partial,
    }

    #[derive(Clone, Copy, Debug)]
    enum StableVisibility {
        DirectCdn,
        Hidden,
        Mutable,
        Published,
        SplitVersion,
        UntrustedCdn,
    }

    struct FixtureState {
        metadata_mode: Mutex<MetadataMode>,
        artifact_mode: Mutex<ArtifactMode>,
        artifact_signature_mode: Mutex<ArtifactSignatureMode>,
        release_mode: Mutex<ReleaseMode>,
        stable_visibility: Mutex<StableVisibility>,
        ranges: Mutex<Vec<Option<String>>>,
        artifact_requests: AtomicUsize,
        release_requests: AtomicUsize,
        authorization_seen: AtomicBool,
    }

    struct FixtureServer {
        base: Url,
        join: JoinHandle<()>,
        state: Arc<FixtureState>,
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            self.join.abort();
        }
    }

    async fn fixture_server() -> FixtureServer {
        let state = Arc::new(FixtureState {
            metadata_mode: Mutex::new(MetadataMode::Good),
            artifact_mode: Mutex::new(ArtifactMode::Success),
            artifact_signature_mode: Mutex::new(ArtifactSignatureMode::Good),
            release_mode: Mutex::new(ReleaseMode::Good),
            stable_visibility: Mutex::new(StableVisibility::Published),
            ranges: Mutex::new(Vec::new()),
            artifact_requests: AtomicUsize::new(0),
            release_requests: AtomicUsize::new(0),
            authorization_seen: AtomicBool::new(false),
        });
        let app = Router::new()
            .route("/api/releases", get(releases))
            .route("/api/releases/latest", get(stable_api_latest))
            .route(
                "/api/releases/tags/v0.1.1-alpha.2",
                get(exact_alpha_release),
            )
            .route("/api/releases/tags/v0.1.1", get(exact_stable_release))
            .route("/latest/{asset}", get(stable_latest))
            .route("/release/v0.1.1-alpha.2/mish-alpha.json", get(metadata))
            .route(
                "/release/v0.1.1-alpha.2/mish-alpha.json.sig",
                get(metadata_signature),
            )
            .route(
                "/release/v0.1.1-alpha.2/Mish-0.1.1-alpha.2-aarch64.app.tar.gz",
                get(artifact),
            )
            .route(
                "/release/v0.1.1-alpha.2/Mish-0.1.1-alpha.2-aarch64.app.tar.gz.sig",
                get(artifact_signature),
            )
            .route(
                "/release/v0.1.1/mish-stable.json",
                get(|| async { STABLE_METADATA }),
            )
            .route(
                "/release/v0.1.1/mish-stable.json.sig",
                get(|| async { STABLE_METADATA_SIGNATURE }),
            )
            .route(
                "/release/v0.1.1/Mish-0.1.1-aarch64.app.tar.gz",
                get(stable_artifact),
            )
            .route(
                "/release/v0.1.1/Mish-0.1.1-aarch64.app.tar.gz.sig",
                get(|| async { STABLE_ARTIFACT_SIGNATURE }),
            )
            .route("/redirected", get(|| async { ARTIFACT }))
            .with_state(state.clone());
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        FixtureServer {
            base: Url::parse(&format!("http://{address}/")).unwrap(),
            join,
            state,
        }
    }

    async fn releases(
        State(state): State<Arc<FixtureState>>,
        headers: HeaderMap,
    ) -> impl IntoResponse {
        state.release_requests.fetch_add(1, Ordering::SeqCst);
        state
            .authorization_seen
            .store(headers.contains_key("authorization"), Ordering::SeqCst);
        let release = alpha_release_json(&state);
        axum::Json(serde_json::json!([release]))
    }

    async fn exact_alpha_release(
        State(state): State<Arc<FixtureState>>,
        headers: HeaderMap,
    ) -> impl IntoResponse {
        state.release_requests.fetch_add(1, Ordering::SeqCst);
        state
            .authorization_seen
            .store(headers.contains_key("authorization"), Ordering::SeqCst);
        axum::Json(alpha_release_json(&state))
    }

    fn alpha_release_json(state: &FixtureState) -> serde_json::Value {
        let mode = *state.release_mode.lock().unwrap();
        let mut assets = vec![
            serde_json::json!({"id": 1, "name": "mish-alpha.json", "state": "uploaded"}),
            serde_json::json!({"id": 2, "name": "mish-alpha.json.sig", "state": "uploaded"}),
            serde_json::json!({"id": 3, "name": "Mish-0.1.1-alpha.2-aarch64.app.tar.gz", "state": "uploaded"}),
            serde_json::json!({"id": 4, "name": "Mish-0.1.1-alpha.2-aarch64.app.tar.gz.sig", "state": "uploaded"}),
        ];
        if matches!(mode, ReleaseMode::Partial) {
            assets.pop();
        }
        serde_json::json!({
            "id": 41,
            "tag_name": "v0.1.1-alpha.2",
            "draft": matches!(mode, ReleaseMode::Draft),
            "prerelease": true,
            "immutable": !matches!(mode, ReleaseMode::Mutable),
            "published_at": if matches!(mode, ReleaseMode::Draft) {
                serde_json::Value::Null
            } else {
                serde_json::Value::String("2026-08-01T00:00:00Z".into())
            },
            "assets": assets,
        })
    }

    async fn stable_api_latest(
        State(state): State<Arc<FixtureState>>,
        headers: HeaderMap,
    ) -> HttpResponse<Body> {
        state.release_requests.fetch_add(1, Ordering::SeqCst);
        state
            .authorization_seen
            .store(headers.contains_key("authorization"), Ordering::SeqCst);
        let visibility = *state.stable_visibility.lock().unwrap();
        if matches!(visibility, StableVisibility::Hidden) {
            return HttpResponse::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
        let body = serde_json::to_vec(&stable_release_json(&state)).unwrap();
        HttpResponse::builder()
            .status(StatusCode::OK)
            .header(CONTENT_LENGTH, body.len())
            .body(Body::from(body))
            .unwrap()
    }

    async fn exact_stable_release(
        State(state): State<Arc<FixtureState>>,
        headers: HeaderMap,
    ) -> HttpResponse<Body> {
        state.release_requests.fetch_add(1, Ordering::SeqCst);
        state
            .authorization_seen
            .store(headers.contains_key("authorization"), Ordering::SeqCst);
        let body = serde_json::to_vec(&stable_release_json(&state)).unwrap();
        HttpResponse::builder()
            .status(StatusCode::OK)
            .header(CONTENT_LENGTH, body.len())
            .body(Body::from(body))
            .unwrap()
    }

    fn stable_release_json(state: &FixtureState) -> serde_json::Value {
        let visibility = *state.stable_visibility.lock().unwrap();
        serde_json::json!({
            "id": 51,
            "tag_name": "v0.1.1",
            "draft": false,
            "prerelease": false,
            "immutable": !matches!(visibility, StableVisibility::Mutable),
            "published_at": "2026-08-01T00:00:00Z",
            "assets": [
                {"id": 11, "name": "mish-stable.json", "state": "uploaded"},
                {"id": 12, "name": "mish-stable.json.sig", "state": "uploaded"},
                {"id": 13, "name": "Mish-0.1.1-aarch64.app.tar.gz", "state": "uploaded"},
                {"id": 14, "name": "Mish-0.1.1-aarch64.app.tar.gz.sig", "state": "uploaded"},
            ],
        })
    }

    async fn stable_latest(
        State(state): State<Arc<FixtureState>>,
        AxumPath(asset): AxumPath<String>,
    ) -> HttpResponse<Body> {
        let visibility = *state.stable_visibility.lock().unwrap();
        if matches!(visibility, StableVisibility::Hidden) {
            return HttpResponse::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
        if matches!(visibility, StableVisibility::DirectCdn) {
            return HttpResponse::builder()
                .status(StatusCode::FOUND)
                .header(
                    LOCATION,
                    "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=read",
                )
                .body(Body::empty())
                .unwrap();
        }
        if matches!(visibility, StableVisibility::UntrustedCdn) {
            return HttpResponse::builder()
                .status(StatusCode::FOUND)
                .header(LOCATION, "https://example.com/release-asset")
                .body(Body::empty())
                .unwrap();
        }
        let split =
            matches!(visibility, StableVisibility::SplitVersion) && asset == "mish-stable.json.sig";
        let version = if split { "0.1.2" } else { "0.1.1" };
        HttpResponse::builder()
            .status(StatusCode::FOUND)
            .header(
                LOCATION,
                format!("https://github.com/Asuka109/mish/releases/download/v{version}/{asset}"),
            )
            .body(Body::empty())
            .unwrap()
    }

    async fn metadata(State(state): State<Arc<FixtureState>>) -> impl IntoResponse {
        let mode = *state.metadata_mode.lock().unwrap();
        if matches!(mode, MetadataMode::Slow) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        match mode {
            MetadataMode::Oversized => vec![b'x'; 4096],
            _ => METADATA.to_vec(),
        }
    }

    async fn metadata_signature(State(state): State<Arc<FixtureState>>) -> impl IntoResponse {
        match *state.metadata_mode.lock().unwrap() {
            MetadataMode::BadSignature => b"not-a-signature".to_vec(),
            _ => METADATA_SIGNATURE.as_bytes().to_vec(),
        }
    }

    async fn artifact_signature(State(state): State<Arc<FixtureState>>) -> HttpResponse<Body> {
        match *state.artifact_signature_mode.lock().unwrap() {
            ArtifactSignatureMode::Good => HttpResponse::builder()
                .status(StatusCode::OK)
                .body(Body::from(ARTIFACT_SIGNATURE))
                .unwrap(),
            ArtifactSignatureMode::Missing => HttpResponse::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap(),
            ArtifactSignatureMode::Substituted => HttpResponse::builder()
                .status(StatusCode::OK)
                .body(Body::from("untrusted-signature"))
                .unwrap(),
        }
    }

    async fn artifact(
        State(state): State<Arc<FixtureState>>,
        headers: HeaderMap,
    ) -> HttpResponse<Body> {
        state.artifact_requests.fetch_add(1, Ordering::SeqCst);
        let range = headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        state.ranges.lock().unwrap().push(range.clone());
        let mode = *state.artifact_mode.lock().unwrap();
        if matches!(mode, ArtifactMode::Redirect) {
            return HttpResponse::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "/redirected")
                .body(Body::empty())
                .unwrap();
        }

        let mut bytes = match mode {
            ArtifactMode::Corrupt => {
                let mut bytes = ARTIFACT.to_vec();
                bytes[0] ^= 1;
                bytes
            }
            ArtifactMode::Truncated => ARTIFACT[..ARTIFACT.len() - 1].to_vec(),
            ArtifactMode::Oversized => {
                let mut bytes = ARTIFACT.to_vec();
                bytes.push(b'x');
                bytes
            }
            _ => ARTIFACT.to_vec(),
        };
        let requested_offset = range
            .as_deref()
            .and_then(|value| value.strip_prefix("bytes="))
            .and_then(|value| value.strip_suffix('-'))
            .and_then(|value| value.parse::<usize>().ok());
        let respects_range = requested_offset.is_some()
            && !matches!(mode, ArtifactMode::IgnoreRange | ArtifactMode::Truncated);
        let status = if respects_range {
            let offset = requested_offset.unwrap();
            bytes = bytes[offset..].to_vec();
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        };
        let response_length = bytes.len();
        let body = if matches!(mode, ArtifactMode::Slow) {
            Body::from_stream(stream::unfold(
                (bytes, 0_usize),
                |(bytes, offset)| async move {
                    if offset >= bytes.len() {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    Some((
                        Ok::<_, Infallible>(Bytes::copy_from_slice(&bytes[offset..offset + 1])),
                        (bytes, offset + 1),
                    ))
                },
            ))
        } else if matches!(mode, ArtifactMode::Truncated | ArtifactMode::Oversized) {
            Body::from_stream(stream::once(async move {
                Ok::<_, Infallible>(Bytes::from(bytes))
            }))
        } else {
            Body::from(bytes.clone())
        };
        let mut response = HttpResponse::builder()
            .status(status)
            .header(ETAG, "\"fixture-v1\"");
        if !matches!(mode, ArtifactMode::Truncated | ArtifactMode::Oversized) {
            response = response.header(CONTENT_LENGTH, response_length);
        }
        if respects_range {
            let offset = requested_offset.unwrap();
            response = response.header(
                CONTENT_RANGE,
                format!("bytes {}-{}/{}", offset, ARTIFACT.len() - 1, ARTIFACT.len()),
            );
        }
        response.body(body).unwrap()
    }

    async fn stable_artifact(State(state): State<Arc<FixtureState>>) -> HttpResponse<Body> {
        state.artifact_requests.fetch_add(1, Ordering::SeqCst);
        HttpResponse::builder()
            .status(StatusCode::OK)
            .header(ETAG, "\"stable-fixture-v1\"")
            .header(CONTENT_LENGTH, STABLE_ARTIFACT.len())
            .body(Body::from(STABLE_ARTIFACT))
            .unwrap()
    }

    fn policy() -> UpdatePolicy {
        UpdatePolicy {
            installed: InstalledUpdate {
                channel: UpdateChannel::Alpha,
                version: "0.1.1-alpha.1".into(),
            },
            selected_channel: UpdateChannel::Alpha,
        }
    }

    fn alpha_endpoint() -> Url {
        Url::parse(&format!(
            "https://api.github.com{GITHUB_ALPHA_RELEASES_PATH}?per_page={ALPHA_RELEASE_LIST_LIMIT}&page=1"
        ))
        .unwrap()
    }

    fn stable_policy() -> UpdatePolicy {
        UpdatePolicy {
            installed: InstalledUpdate {
                channel: UpdateChannel::Stable,
                version: "0.1.0".into(),
            },
            selected_channel: UpdateChannel::Stable,
        }
    }

    fn stable_endpoint() -> Url {
        Url::parse(&format!("https://github.com{GITHUB_STABLE_LATEST_PATH}")).unwrap()
    }

    fn limits() -> UpdaterLimits {
        UpdaterLimits {
            connect_timeout: Duration::from_secs(1),
            idle_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_secs(4),
            max_metadata_bytes: 256 * 1024,
            max_signature_bytes: 16 * 1024,
            max_artifact_bytes: 1024 * 1024,
            stale_partial_age: Duration::from_secs(3600),
        }
    }

    async fn configured_service(
        server: &FixtureServer,
        root: &Path,
        authority: &str,
        limits: UpdaterLimits,
    ) -> Arc<UpdaterService> {
        Arc::new(
            UpdaterService::configured_inner(
                authority.into(),
                PUBLIC_KEY.trim(),
                policy(),
                alpha_endpoint(),
                root.to_path_buf(),
                limits,
                Some(server.base.clone()),
            )
            .await
            .unwrap(),
        )
    }

    async fn configured_service_with_fake_check(
        server: &FixtureServer,
        root: &Path,
        discovery: FakeDiscovery,
    ) -> Arc<UpdaterService> {
        let mut service = UpdaterService::configured_inner(
            "test-authority".into(),
            PUBLIC_KEY.trim(),
            policy(),
            alpha_endpoint(),
            root.to_path_buf(),
            limits(),
            Some(server.base.clone()),
        )
        .await
        .unwrap();
        service
            .check
            .as_ref()
            .expect("configured service has a Check runtime")
            .shutdown()
            .await;
        let check = CheckRuntime::spawn(
            service.state.clone(),
            service.updates.clone(),
            service.check_evidence.clone(),
            Arc::new(FakeCheckEffectExecutor {
                candidate: fake_candidate(),
                discovery,
                commit: FakeCommit::Immediate,
            }),
        );
        service.check = Some(check);
        Arc::new(service)
    }

    async fn configured_stable_service(server: &FixtureServer, root: &Path) -> Arc<UpdaterService> {
        Arc::new(
            UpdaterService::configured_inner(
                "stable-authority".into(),
                PUBLIC_KEY.trim(),
                stable_policy(),
                stable_endpoint(),
                root.to_path_buf(),
                limits(),
                Some(server.base.clone()),
            )
            .await
            .unwrap(),
        )
    }

    async fn wait_phase(service: &UpdaterService, phase: UpdatePhase) -> UpdaterSnapshot {
        timeout(Duration::from_secs(8), async {
            loop {
                let snapshot = service.snapshot();
                if snapshot.phase == phase {
                    return snapshot;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    async fn discover_available(service: &Arc<UpdaterService>, operation_id: &str) {
        service
            .start_check(operation_id, UpdateChannel::Alpha)
            .await
            .unwrap();
        let snapshot = wait_phase(service, UpdatePhase::Available).await;
        assert_eq!(snapshot.operation_id.as_deref(), Some(operation_id));
        assert_eq!(
            snapshot.candidate.as_ref().unwrap().artifact_size,
            ARTIFACT.len() as u64
        );
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("/private/")
        );
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("github.com")
        );
    }

    fn local_install_request(
        snapshot: &UpdaterSnapshot,
        operation_id: &str,
    ) -> LocalInstallRequest {
        LocalInstallRequest {
            operation_id: operation_id.into(),
            expected_authority_id: snapshot.authority_id.clone(),
            expected_ready_operation_id: snapshot.operation_id.clone().unwrap(),
            expected_revision: snapshot.revision,
            expected_candidate: snapshot.candidate.clone().unwrap(),
        }
    }

    fn accept_local_install(_: &[u8]) -> Result<(), LocalInstallSeamError> {
        Ok(())
    }

    fn reject_malformed_local_install(_: &[u8]) -> Result<(), LocalInstallSeamError> {
        Err(LocalInstallSeamError::MalformedPackage)
    }

    fn panic_local_install(_: &[u8]) -> Result<(), LocalInstallSeamError> {
        panic!("injected seam panic")
    }

    async fn prepare_ready_candidate(
        server: &FixtureServer,
        root: &Path,
    ) -> (Arc<UpdaterService>, UpdaterSnapshot) {
        let service = configured_service(server, root, "install-process", limits()).await;
        discover_available(&service, "download-operation").await;
        service.start_download("download-operation").await.unwrap();
        let ready = wait_phase(&service, UpdatePhase::Ready).await;
        (service, ready)
    }

    async fn prepare_ready_stable_candidate(
        server: &FixtureServer,
        root: &Path,
    ) -> (Arc<UpdaterService>, UpdaterSnapshot) {
        let service = configured_stable_service(server, root).await;
        service
            .start_check("stable-download", UpdateChannel::Stable)
            .await
            .unwrap();
        wait_phase(&service, UpdatePhase::Available).await;
        service.start_download("stable-download").await.unwrap();
        let ready = wait_phase(&service, UpdatePhase::Ready).await;
        (service, ready)
    }

    #[tokio::test]
    async fn local_install_proof_reads_and_hands_off_the_exact_candidate_once_without_payload_network()
     {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let (service, ready) = prepare_ready_candidate(&server, &root).await;
        let artifact_requests = server.state.artifact_requests.load(Ordering::SeqCst);
        let release_requests = server.state.release_requests.load(Ordering::SeqCst);
        let handoffs = Arc::new(AtomicUsize::new(0));
        let observed = handoffs.clone();
        let evidence = service
            .proof_local_candidate_install_adapter()
            .install(
                local_install_request(&ready, "install-proof"),
                CancellationToken::new(),
                move |bytes: &[u8]| {
                    assert_eq!(bytes, ARTIFACT);
                    observed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap();

        assert_eq!(handoffs.load(Ordering::SeqCst), 1);
        assert_eq!(evidence.payload_reads, 1);
        assert_eq!(evidence.payload_handoffs, 1);
        assert_eq!(evidence.payload_network_downloads, 0);
        assert_eq!(
            evidence.candidate_sha256,
            ready.candidate.unwrap().artifact_sha256
        );
        assert_eq!(
            server.state.artifact_requests.load(Ordering::SeqCst),
            artifact_requests
        );
        assert_eq!(
            server.state.release_requests.load(Ordering::SeqCst),
            release_requests
        );
    }

    #[tokio::test]
    async fn restart_rebinds_one_exact_release_record_without_redownloading_payload() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let (original, _) = prepare_ready_candidate(&server, &root).await;
        original.shutdown().await;
        drop(original);
        let recovered = configured_service(&server, &root, "restarted-process", limits()).await;
        let ready = recovered.snapshot();
        assert_eq!(ready.phase, UpdatePhase::Ready);
        assert!(!recovered.state.lock().unwrap().release_context_bound);
        let artifact_requests = server.state.artifact_requests.load(Ordering::SeqCst);
        let release_requests = server.state.release_requests.load(Ordering::SeqCst);

        let evidence = recovered
            .proof_local_candidate_install_adapter()
            .install(
                local_install_request(&ready, "restart-install-proof"),
                CancellationToken::new(),
                |bytes: &[u8]| {
                    assert_eq!(bytes, ARTIFACT);
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert_eq!(evidence.payload_network_downloads, 0);
        assert!(recovered.state.lock().unwrap().release_context_bound);
        assert_eq!(
            server.state.release_requests.load(Ordering::SeqCst),
            release_requests + 1
        );
        assert_eq!(
            server.state.artifact_requests.load(Ordering::SeqCst),
            artifact_requests
        );
    }

    #[tokio::test]
    async fn recovery_record_is_bounded_and_unknown_candidate_commit_is_only_reverified() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let service = configured_service(&server, &root, "record-process", limits()).await;
        discover_available(&service, "record-operation").await;

        let available_bytes = fs::read(root.join(RECOVERY_FILE)).unwrap();
        let available_text = String::from_utf8(available_bytes.clone()).unwrap();
        let available: RecoveryRecord = serde_json::from_slice(&available_bytes).unwrap();
        assert_eq!(available.schema_version, RECOVERY_SCHEMA_VERSION);
        assert_eq!(available.commit, RecoveryCommit::Available);
        assert_eq!(available.evidence.committed_bytes, 0);
        for secret in [
            "metadataBase64",
            "\"metadataSignature\":",
            "\"artifactSignature\":",
            "https://",
            root.to_str().unwrap(),
        ] {
            assert!(!available_text.contains(secret));
        }

        service.start_download("record-operation").await.unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        let committed: RecoveryRecord =
            serde_json::from_slice(&fs::read(root.join(RECOVERY_FILE)).unwrap()).unwrap();
        assert_eq!(committed.commit, RecoveryCommit::CandidateCommitted);
        assert_eq!(
            committed.evidence.committed_bytes,
            committed.candidate.artifact_size
        );

        let mut unknown = committed;
        unknown.commit = RecoveryCommit::CandidateCommitStarted;
        let persisted: PersistedState = service
            .configured
            .as_ref()
            .unwrap()
            .store
            .read_json(&root.join(STATE_FILE))
            .unwrap();
        service
            .configured
            .as_ref()
            .unwrap()
            .store
            .write_json_atomic(
                &root.join(STATE_FILE),
                &PersistedState {
                    phase: PersistedPhase::Available,
                    ..persisted
                },
                0o600,
            )
            .unwrap();
        service
            .configured
            .as_ref()
            .unwrap()
            .store
            .write_json_atomic(&root.join(RECOVERY_FILE), &unknown, 0o600)
            .unwrap();
        let artifact_requests = server.state.artifact_requests.load(Ordering::SeqCst);
        service.shutdown().await;
        drop(service);

        let recovered = configured_service(&server, &root, "recovery-process", limits()).await;
        assert_eq!(recovered.snapshot().phase, UpdatePhase::Ready);
        assert_eq!(
            server.state.artifact_requests.load(Ordering::SeqCst),
            artifact_requests,
            "restart observes and re-verifies; it never replays the payload download"
        );
        let evidence = recovered.check_transition_evidence();
        assert!(evidence.iter().any(|entry| {
            entry.from == "recovery-required"
                && entry.input == "recover-requested"
                && entry.to == "recovering"
        }));
        assert!(
            evidence
                .iter()
                .any(|entry| { entry.input == "reverification-succeeded" && entry.to == "ready" })
        );
    }

    #[tokio::test]
    async fn stable_restart_rebind_is_exact_version_and_never_downloads_the_payload_again() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("stable-updates");
        let (original, _) = prepare_ready_stable_candidate(&server, &root).await;
        original.shutdown().await;
        drop(original);
        let recovered = configured_stable_service(&server, &root).await;
        let ready = recovered.snapshot();
        assert_eq!(ready.phase, UpdatePhase::Ready);
        let artifact_requests = server.state.artifact_requests.load(Ordering::SeqCst);
        let release_requests = server.state.release_requests.load(Ordering::SeqCst);

        recovered
            .proof_local_candidate_install_adapter()
            .install(
                local_install_request(&ready, "stable-install-proof"),
                CancellationToken::new(),
                |bytes: &[u8]| {
                    assert_eq!(bytes, STABLE_ARTIFACT);
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert_eq!(
            server.state.release_requests.load(Ordering::SeqCst),
            release_requests + 1
        );
        assert_eq!(
            server.state.artifact_requests.load(Ordering::SeqCst),
            artifact_requests
        );
    }

    #[tokio::test]
    async fn local_install_negative_paths_are_deterministic_redacted_and_non_destructive() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let (service, ready) = prepare_ready_candidate(&server, &root).await;
        let disabled = service
            .local_candidate_install_adapter()
            .install(
                local_install_request(&ready, "disabled-proof"),
                CancellationToken::new(),
                panic_local_install,
            )
            .await;
        assert_eq!(disabled, Err(LocalInstallError::CapabilityDisabled));

        let adapter = service.proof_local_candidate_install_adapter();
        let mut stale = local_install_request(&ready, "stale-proof");
        stale.expected_revision = stale.expected_revision.saturating_add(1);
        assert_eq!(
            adapter
                .install(stale, CancellationToken::new(), accept_local_install)
                .await,
            Err(LocalInstallError::StaleRevision)
        );
        let mut replaced = local_install_request(&ready, "replaced-proof");
        replaced.expected_ready_operation_id = "other-download".into();
        assert_eq!(
            adapter
                .install(replaced, CancellationToken::new(), accept_local_install)
                .await,
            Err(LocalInstallError::ReplacedOperation)
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            adapter
                .install(
                    local_install_request(&ready, "cancelled-proof"),
                    cancellation,
                    accept_local_install
                )
                .await,
            Err(LocalInstallError::Cancelled)
        );
        assert_eq!(
            adapter
                .install(
                    local_install_request(&ready, "malformed-proof"),
                    CancellationToken::new(),
                    reject_malformed_local_install
                )
                .await,
            Err(LocalInstallError::MalformedPackage)
        );
        let task_failure = adapter
            .install(
                local_install_request(&ready, "panic-proof"),
                CancellationToken::new(),
                panic_local_install,
            )
            .await;
        assert_eq!(task_failure, Err(LocalInstallError::TaskFinalization));

        let duplicate_request = local_install_request(&ready, "duplicate-proof");
        adapter
            .install(
                duplicate_request.clone(),
                CancellationToken::new(),
                accept_local_install,
            )
            .await
            .unwrap();
        assert_eq!(
            adapter
                .install(
                    duplicate_request,
                    CancellationToken::new(),
                    accept_local_install,
                )
                .await,
            Err(LocalInstallError::Duplicate)
        );

        for error in [
            LocalInstallError::CapabilityDisabled,
            LocalInstallError::StaleRevision,
            LocalInstallError::ReplacedOperation,
            LocalInstallError::Cancelled,
            LocalInstallError::MalformedPackage,
            LocalInstallError::TaskFinalization,
            LocalInstallError::Duplicate,
        ] {
            assert!(!error.code().contains('/'));
            assert!(!error.code().contains("github"));
            assert!(!error.code().contains("signature"));
        }
        assert_eq!(service.snapshot(), ready);
    }

    #[tokio::test]
    async fn restart_offline_drift_oversize_and_store_tampering_fail_closed_while_ready_remains() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let offline_root = temporary.path().join("offline");
        let (original, _) = prepare_ready_candidate(&server, &offline_root).await;
        original.shutdown().await;
        drop(original);
        let recovered =
            configured_service(&server, &offline_root, "offline-restart", limits()).await;
        let offline_ready = recovered.snapshot();
        drop(server);
        assert_eq!(
            recovered
                .proof_local_candidate_install_adapter()
                .install(
                    local_install_request(&offline_ready, "offline-proof"),
                    CancellationToken::new(),
                    accept_local_install
                )
                .await,
            Err(LocalInstallError::ContextUnavailable)
        );
        assert_eq!(recovered.snapshot(), offline_ready);
        assert!(!recovered.state.lock().unwrap().release_context_bound);

        let server = fixture_server().await;
        let drift_root = temporary.path().join("drift");
        let (original, _) = prepare_ready_candidate(&server, &drift_root).await;
        original.shutdown().await;
        drop(original);
        let drifted = configured_service(&server, &drift_root, "drift-restart", limits()).await;
        let drift_ready = drifted.snapshot();
        *server.state.release_mode.lock().unwrap() = ReleaseMode::Partial;
        assert_eq!(
            drifted
                .proof_local_candidate_install_adapter()
                .install(
                    local_install_request(&drift_ready, "drift-proof"),
                    CancellationToken::new(),
                    accept_local_install
                )
                .await,
            Err(LocalInstallError::ReleaseDrift)
        );
        assert_eq!(drifted.snapshot(), drift_ready);

        *server.state.release_mode.lock().unwrap() = ReleaseMode::Good;
        let oversized_root = temporary.path().join("oversized");
        let (original, _) = prepare_ready_candidate(&server, &oversized_root).await;
        original.shutdown().await;
        drop(original);
        let mut small_limits = limits();
        small_limits.max_artifact_bytes = ARTIFACT.len() as u64 - 1;
        let oversized =
            configured_service(&server, &oversized_root, "oversized-restart", small_limits).await;
        let oversized_ready = oversized.snapshot();
        assert_eq!(
            oversized
                .proof_local_candidate_install_adapter()
                .install(
                    local_install_request(&oversized_ready, "oversized-proof"),
                    CancellationToken::new(),
                    accept_local_install
                )
                .await,
            Err(LocalInstallError::OversizedPackage)
        );

        let tampered_root = temporary.path().join("tampered");
        let (tampered, tampered_ready) = prepare_ready_candidate(&server, &tampered_root).await;
        set_permissions(
            &tampered_root
                .join(CANDIDATE_DIRECTORY)
                .join(CANDIDATE_PAYLOAD),
            0o600,
        )
        .unwrap();
        assert_eq!(
            tampered
                .proof_local_candidate_install_adapter()
                .install(
                    local_install_request(&tampered_ready, "tampered-proof"),
                    CancellationToken::new(),
                    accept_local_install
                )
                .await,
            Err(LocalInstallError::StoreUnsafe)
        );
        assert_eq!(tampered.snapshot(), tampered_ready);
    }

    #[tokio::test]
    async fn local_install_rejects_every_persisted_candidate_binding_drift() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let (service, ready) = prepare_ready_candidate(&server, &root).await;
        let configured = service.configured.as_ref().unwrap();
        let available = service.state.lock().unwrap().available.clone().unwrap();
        let original = available.persisted(ready.operation_id.as_deref().unwrap());
        let candidate_directory = root.join(CANDIDATE_DIRECTORY);
        let manifest_path = candidate_directory.join(CANDIDATE_MANIFEST);

        for drift in [
            "field",
            "artifact",
            "digest",
            "signature",
            "channel",
            "version",
            "source",
            "release",
            "release-artifact",
        ] {
            let mut tampered = original.clone();
            match drift {
                "field" => tampered.schema_version = tampered.schema_version.saturating_add(1),
                "artifact" => tampered.identity.artifact_name.push_str(".substituted"),
                "digest" => tampered.identity.artifact_sha256 = "00".repeat(32),
                "signature" => tampered.metadata_signature.push('A'),
                "channel" => tampered.identity.channel = UpdateChannel::Stable,
                "version" => tampered.identity.version = "0.1.1-alpha.3".into(),
                "source" => tampered.identity.source_sha = "11".repeat(32),
                "release" => tampered.release.id = tampered.release.id.saturating_add(1),
                "release-artifact" => {
                    tampered.release.assets[0].id = tampered.release.assets[0].id.saturating_add(1);
                }
                _ => unreachable!(),
            }
            set_permissions(&candidate_directory, 0o700).unwrap();
            configured
                .store
                .write_json_atomic(&manifest_path, &tampered, 0o400)
                .unwrap();
            set_permissions(&candidate_directory, 0o500).unwrap();

            let result = service
                .proof_local_candidate_install_adapter()
                .install(
                    local_install_request(&ready, &format!("{drift}-drift-proof")),
                    CancellationToken::new(),
                    accept_local_install,
                )
                .await;
            assert_eq!(result, Err(LocalInstallError::StoreUnsafe), "{drift}");
        }

        set_permissions(&candidate_directory, 0o700).unwrap();
        configured
            .store
            .write_json_atomic(&manifest_path, &original, 0o400)
            .unwrap();
        set_permissions(&candidate_directory, 0o500).unwrap();

        let payload_path = candidate_directory.join(CANDIDATE_PAYLOAD);
        let mut substituted_payload = ARTIFACT.to_vec();
        substituted_payload[0] ^= 1;
        set_permissions(&payload_path, 0o600).unwrap();
        fs::write(&payload_path, substituted_payload).unwrap();
        set_permissions(&payload_path, 0o400).unwrap();
        assert_eq!(
            service
                .proof_local_candidate_install_adapter()
                .install(
                    local_install_request(&ready, "payload-digest-drift-proof"),
                    CancellationToken::new(),
                    accept_local_install,
                )
                .await,
            Err(LocalInstallError::VerificationFailed)
        );
        assert_eq!(service.snapshot(), ready);
    }

    #[tokio::test]
    async fn success_is_revisioned_operation_keyed_immutable_and_restart_safe() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let service = configured_service(&server, &root, "process-a", limits()).await;
        assert_eq!(
            service
                .start_check("wrong-channel", UpdateChannel::Stable)
                .await,
            Err(UpdateOperationError::Verification(
                UpdaterError::ChannelMismatch
            ))
        );
        assert_eq!(service.snapshot().phase, UpdatePhase::Idle);
        let checking = service
            .start_check("operation-a", UpdateChannel::Alpha)
            .await
            .unwrap();
        assert_eq!(checking.phase, UpdatePhase::Checking);
        assert_eq!(
            service
                .start_check("operation-a", UpdateChannel::Alpha)
                .await
                .unwrap()
                .revision,
            checking.revision
        );
        assert_eq!(
            service
                .start_check("operation-b", UpdateChannel::Alpha)
                .await,
            Err(UpdateOperationError::Busy)
        );
        wait_phase(&service, UpdatePhase::Available).await;
        service.start_download("operation-a").await.unwrap();
        let ready = wait_phase(&service, UpdatePhase::Ready).await;
        assert_eq!(
            ready.progress,
            Some(UpdateProgress {
                downloaded_bytes: ARTIFACT.len() as u64,
                total_bytes: ARTIFACT.len() as u64,
            })
        );
        assert_eq!(
            fs::read(root.join(CANDIDATE_DIRECTORY).join(CANDIDATE_PAYLOAD)).unwrap(),
            ARTIFACT
        );
        validate_private_file(
            &root.join(CANDIDATE_DIRECTORY).join(CANDIDATE_PAYLOAD),
            Some(ARTIFACT.len() as u64),
        )
        .unwrap();

        drop(service);
        let restarted = configured_service(&server, &root, "process-b", limits()).await;
        let recovered = restarted.snapshot();
        assert_eq!(recovered.authority_id, "process-b");
        assert_eq!(recovered.revision, 0);
        assert_eq!(recovered.phase, UpdatePhase::Ready);
        assert_eq!(recovered.operation_id.as_deref(), Some("operation-a"));
        restarted
            .configured
            .as_ref()
            .unwrap()
            .store
            .discard_candidate()
            .unwrap();
        assert!(!root.join(CANDIDATE_DIRECTORY).exists());
    }

    #[tokio::test]
    async fn check_and_download_admission_share_one_atomic_outer_cutover() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let service = configured_service(
            &server,
            &temporary.path().join("updates"),
            "process-a",
            limits(),
        )
        .await;
        discover_available(&service, "operation-a").await;
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::Slow;

        let barrier = Arc::new(Barrier::new(3));
        let check = {
            let barrier = barrier.clone();
            let service = service.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                service
                    .start_check("operation-b", UpdateChannel::Alpha)
                    .await
            })
        };
        let download = {
            let barrier = barrier.clone();
            let service = service.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                service.start_download("operation-a").await
            })
        };
        barrier.wait().await;
        let check = check.await.unwrap();
        let download = download.await.unwrap();

        assert_ne!(check.is_ok(), download.is_ok());
        if check.is_ok() {
            assert_eq!(download, Err(UpdateOperationError::OperationMismatch));
            wait_phase(&service, UpdatePhase::Failed).await;
        } else {
            assert_eq!(check, Err(UpdateOperationError::Busy));
            service.cancel("operation-a").await.unwrap();
            wait_phase(&service, UpdatePhase::Cancelled).await;
        }
        service.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_check_start_and_cancel_never_report_an_unrouted_success() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let service = configured_service_with_fake_check(
            &server,
            &temporary.path().join("updates"),
            FakeDiscovery::Barrier {
                release: release.clone(),
                started: started.clone(),
            },
        )
        .await;

        for index in 0..64 {
            let operation_id = format!("operation-{index}");
            let barrier = Arc::new(Barrier::new(3));
            let start = {
                let barrier = barrier.clone();
                let operation_id = operation_id.clone();
                let service = service.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    service
                        .start_check(&operation_id, UpdateChannel::Alpha)
                        .await
                })
            };
            let cancel = {
                let barrier = barrier.clone();
                let operation_id = operation_id.clone();
                let service = service.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    service.cancel(&operation_id).await
                })
            };
            barrier.wait().await;
            assert_eq!(start.await.unwrap().unwrap().phase, UpdatePhase::Checking);
            let cancel = cancel.await.unwrap();
            started.notified().await;
            release.notify_one();

            match cancel {
                Ok(snapshot) => {
                    assert_eq!(snapshot.phase, UpdatePhase::Checking);
                    wait_phase(&service, UpdatePhase::Cancelled).await;
                }
                Err(UpdateOperationError::OperationMismatch) => {
                    wait_phase(&service, UpdatePhase::Available).await;
                }
                result => panic!("unexpected cancellation result: {result:?}"),
            }
        }
        service.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_rejects_candidate_with_foreign_nested_entry() {
        use std::os::unix::fs::PermissionsExt;

        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let service = configured_service(&server, &root, "process-a", limits()).await;
        discover_available(&service, "nested-entry").await;
        service.start_download("nested-entry").await.unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        drop(service);

        let candidate = root.join(CANDIDATE_DIRECTORY);
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(candidate.join("foreign"), b"remove").unwrap();
        let restarted = configured_service(&server, &root, "process-b", limits()).await;
        assert_eq!(restarted.snapshot().phase, UpdatePhase::Failed);
        assert_eq!(
            restarted.snapshot().terminal_reason.as_deref(),
            Some("store-unsafe")
        );
        assert!(!candidate.exists());
    }

    #[tokio::test]
    async fn cancellation_keeps_only_strong_etag_partial_and_range_resume_finishes() {
        let server = fixture_server().await;
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::Slow;
        let temporary = TempDir::new().unwrap();
        let service = configured_service(
            &server,
            &temporary.path().join("updates"),
            "process",
            limits(),
        )
        .await;
        discover_available(&service, "resume-operation").await;
        service.start_download("resume-operation").await.unwrap();
        timeout(Duration::from_secs(4), async {
            loop {
                if service
                    .snapshot()
                    .progress
                    .is_some_and(|progress| progress.downloaded_bytes >= 3)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        service.cancel("resume-operation").await.unwrap();
        let cancelled = wait_phase(&service, UpdatePhase::Cancelled).await;
        assert!(cancelled.resumable);
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::Success;
        service.start_download("resume-operation").await.unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        assert!(server.state.ranges.lock().unwrap().iter().any(|range| {
            range
                .as_deref()
                .is_some_and(|value| value.starts_with("bytes="))
        }));
    }

    #[tokio::test]
    async fn server_ignoring_range_discards_partial_and_restarts_from_zero() {
        let server = fixture_server().await;
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::Slow;
        let temporary = TempDir::new().unwrap();
        let service = configured_service(
            &server,
            &temporary.path().join("updates"),
            "process",
            limits(),
        )
        .await;
        discover_available(&service, "restart-operation").await;
        service.start_download("restart-operation").await.unwrap();
        timeout(Duration::from_secs(4), async {
            loop {
                if service
                    .snapshot()
                    .progress
                    .is_some_and(|progress| progress.downloaded_bytes >= 2)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        service.cancel("restart-operation").await.unwrap();
        wait_phase(&service, UpdatePhase::Cancelled).await;
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::IgnoreRange;
        service.start_download("restart-operation").await.unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        assert!(server.state.artifact_requests.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn metadata_limits_signature_timeout_redirect_and_payload_failures_are_typed_and_redacted()
     {
        for (metadata_mode, expected) in [
            (MetadataMode::BadSignature, "metadata-signature-invalid"),
            (MetadataMode::Oversized, "oversized-metadata"),
            (MetadataMode::Slow, "timeout"),
        ] {
            let server = fixture_server().await;
            *server.state.metadata_mode.lock().unwrap() = metadata_mode;
            let temporary = TempDir::new().unwrap();
            let mut test_limits = limits();
            if matches!(metadata_mode, MetadataMode::Oversized) {
                test_limits.max_metadata_bytes = 1024;
            }
            if matches!(metadata_mode, MetadataMode::Slow) {
                test_limits.request_timeout = Duration::from_millis(50);
            }
            let service = configured_service(
                &server,
                &temporary.path().join("updates"),
                "process",
                test_limits,
            )
            .await;
            service
                .start_check("failure-operation", UpdateChannel::Alpha)
                .await
                .unwrap();
            let failed = wait_phase(&service, UpdatePhase::Failed).await;
            assert_eq!(failed.terminal_reason.as_deref(), Some(expected));
            let rendered = serde_json::to_string(&failed).unwrap();
            assert!(!rendered.contains("http://"));
            assert!(!rendered.contains(temporary.path().to_str().unwrap()));
        }

        for (signature_mode, expected) in [
            (ArtifactSignatureMode::Missing, "missing-artifact-signature"),
            (
                ArtifactSignatureMode::Substituted,
                "artifact-signature-mismatch",
            ),
        ] {
            let server = fixture_server().await;
            *server.state.artifact_signature_mode.lock().unwrap() = signature_mode;
            let temporary = TempDir::new().unwrap();
            let service = configured_service(
                &server,
                &temporary.path().join("updates"),
                "process",
                limits(),
            )
            .await;
            service
                .start_check("sidecar-failure", UpdateChannel::Alpha)
                .await
                .unwrap();
            let failed = wait_phase(&service, UpdatePhase::Failed).await;
            assert_eq!(failed.terminal_reason.as_deref(), Some(expected));
            assert_eq!(server.state.artifact_requests.load(Ordering::SeqCst), 0);
        }

        for (artifact_mode, expected) in [
            (ArtifactMode::Redirect, "redirect-rejected"),
            (ArtifactMode::Corrupt, "artifact-digest-mismatch"),
            (ArtifactMode::Truncated, "artifact-size-mismatch"),
            (ArtifactMode::Oversized, "oversized-payload"),
        ] {
            let server = fixture_server().await;
            *server.state.artifact_mode.lock().unwrap() = artifact_mode;
            let temporary = TempDir::new().unwrap();
            let service = configured_service(
                &server,
                &temporary.path().join("updates"),
                "process",
                limits(),
            )
            .await;
            discover_available(&service, "payload-failure").await;
            service.start_download("payload-failure").await.unwrap();
            let failed = wait_phase(&service, UpdatePhase::Failed).await;
            assert_eq!(failed.terminal_reason.as_deref(), Some(expected));
            assert!(
                !temporary
                    .path()
                    .join("updates")
                    .join(CANDIDATE_DIRECTORY)
                    .exists()
            );
        }
    }

    #[tokio::test]
    async fn identical_rediscovery_restores_ready_without_replay_or_payload_download() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let service = configured_service(
            &server,
            &temporary.path().join("updates"),
            "process",
            limits(),
        )
        .await;
        discover_available(&service, "first").await;
        service.start_download("first").await.unwrap();
        let original = wait_phase(&service, UpdatePhase::Ready).await;
        service
            .start_check("second", UpdateChannel::Alpha)
            .await
            .unwrap();
        let rediscovered = wait_phase(&service, UpdatePhase::Ready).await;
        assert_eq!(rediscovered.operation_id, original.operation_id);
        assert_eq!(rediscovered.candidate, original.candidate);
        assert_eq!(rediscovered.terminal_reason, None);
        assert!(rediscovered.revision > original.revision);
        assert_eq!(server.state.artifact_requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn alpha_listing_is_single_anonymous_semver_discovery_and_partial_publication_fails_closed()
     {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let service = configured_service(&server, &root, "process", limits()).await;
        discover_available(&service, "published").await;
        let preserved = service.state.lock().unwrap().available.clone().unwrap();
        assert_eq!(server.state.release_requests.load(Ordering::SeqCst), 1);
        assert!(!server.state.authorization_seen.load(Ordering::SeqCst));
        assert_eq!(server.state.artifact_requests.load(Ordering::SeqCst), 0);

        *server.state.release_mode.lock().unwrap() = ReleaseMode::Draft;
        service
            .start_check("draft-hidden", UpdateChannel::Alpha)
            .await
            .unwrap();
        let failed = wait_phase(&service, UpdatePhase::Failed).await;
        assert_eq!(failed.terminal_reason.as_deref(), Some("invalid-response"));
        assert_eq!(
            service.state.lock().unwrap().available,
            Some(preserved.clone())
        );

        *server.state.release_mode.lock().unwrap() = ReleaseMode::Mutable;
        service
            .start_check("mutable-hidden", UpdateChannel::Alpha)
            .await
            .unwrap();
        let failed = wait_phase(&service, UpdatePhase::Failed).await;
        assert_eq!(failed.terminal_reason.as_deref(), Some("invalid-response"));
        assert_eq!(
            service.state.lock().unwrap().available,
            Some(preserved.clone())
        );

        *server.state.release_mode.lock().unwrap() = ReleaseMode::Partial;
        service
            .start_check("partial-hidden", UpdateChannel::Alpha)
            .await
            .unwrap();
        let failed = wait_phase(&service, UpdatePhase::Failed).await;
        assert_eq!(failed.terminal_reason.as_deref(), Some("invalid-response"));
        assert_eq!(service.state.lock().unwrap().available, Some(preserved));
        assert_eq!(server.state.artifact_requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn stable_latest_binds_all_assets_to_one_published_immutable_release() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let service = configured_stable_service(&server, &temporary.path().join("updates")).await;
        service
            .start_check("stable-published", UpdateChannel::Stable)
            .await
            .unwrap();
        let available = wait_phase(&service, UpdatePhase::Available).await;
        assert_eq!(server.state.release_requests.load(Ordering::SeqCst), 1);
        assert!(!server.state.authorization_seen.load(Ordering::SeqCst));
        assert_eq!(
            available
                .candidate
                .as_ref()
                .map(|candidate| candidate.version.as_str()),
            Some("0.1.1")
        );
        service.start_download("stable-published").await.unwrap();
        let ready = wait_phase(&service, UpdatePhase::Ready).await;
        assert_eq!(
            ready.progress.as_ref().map(|progress| progress.total_bytes),
            Some(STABLE_ARTIFACT.len() as u64)
        );

        let server = fixture_server().await;
        *server.state.stable_visibility.lock().unwrap() = StableVisibility::DirectCdn;
        let temporary = TempDir::new().unwrap();
        let service = configured_stable_service(&server, &temporary.path().join("updates")).await;
        service
            .start_check("stable-direct-cdn", UpdateChannel::Stable)
            .await
            .unwrap();
        wait_phase(&service, UpdatePhase::Available).await;

        for visibility in [
            StableVisibility::Hidden,
            StableVisibility::Mutable,
            StableVisibility::SplitVersion,
            StableVisibility::UntrustedCdn,
        ] {
            let server = fixture_server().await;
            *server.state.stable_visibility.lock().unwrap() = visibility;
            let temporary = TempDir::new().unwrap();
            let service =
                configured_stable_service(&server, &temporary.path().join("updates")).await;
            service
                .start_check("stable-fail-closed", UpdateChannel::Stable)
                .await
                .unwrap();
            let failed = wait_phase(&service, UpdatePhase::Failed).await;
            assert_eq!(failed.terminal_reason.as_deref(), Some("invalid-response"));
            assert!(service.state.lock().unwrap().available.is_none());
        }
    }

    #[test]
    fn alpha_selection_ignores_order_and_rejects_malformed_or_duplicate_versions() {
        fn release(id: u64, version: &str) -> GitHubRelease {
            GitHubRelease {
                id,
                tag_name: format!("v{version}"),
                draft: false,
                prerelease: true,
                immutable: true,
                published_at: Some("2026-08-01T00:00:00Z".into()),
                assets: vec![GitHubReleaseAsset {
                    id: id.saturating_mul(10),
                    name: "mish-alpha.json".into(),
                    state: "uploaded".into(),
                }],
            }
        }

        let selected = select_alpha_release(vec![
            release(2, "0.1.1-alpha.2"),
            release(4, "0.1.1-alpha.4"),
            release(3, "0.1.1-alpha.3"),
        ])
        .unwrap();
        assert_eq!(selected.version, "0.1.1-alpha.4");
        assert_eq!(
            select_alpha_release(vec![release(1, "0.1.1-beta.1")]),
            Err(UpdateOperationError::Verification(
                UpdaterError::WrongChannelVersion
            ))
        );
        assert_eq!(
            select_alpha_release(vec![
                release(1, "0.1.1-alpha.2"),
                release(2, "0.1.1-alpha.2"),
            ]),
            Err(UpdateOperationError::Verification(
                UpdaterError::VersionDigestConflict
            ))
        );
    }

    #[test]
    fn candidate_identity_is_idempotent_but_same_version_digest_conflict_is_hard() {
        let existing = fake_candidate();
        let state = Mutex::new(RuntimeState {
            snapshot: UpdaterSnapshot::idle("authority".into(), true),
            accepted: AcceptedMetadata::empty(),
            available: Some(existing.clone()),
            release_context_bound: true,
            operation_admission_pending: false,
        });
        assert_eq!(
            classify_discovery(&state, existing.clone()),
            Ok(DiscoveryOutcome::Unchanged)
        );

        let mut release_conflict = existing.clone();
        release_conflict.release.id += 1;
        assert_eq!(
            classify_discovery(&state, release_conflict),
            Err(UpdateOperationError::Verification(
                UpdaterError::VersionDigestConflict
            ))
        );

        let mut conflict = existing.clone();
        conflict.metadata.metadata_sha256 = "d".repeat(64);
        assert_eq!(
            classify_discovery(&state, conflict),
            Err(UpdateOperationError::Verification(
                UpdaterError::VersionDigestConflict
            ))
        );

        let mut stale = existing;
        stale.metadata.version = "0.1.1-alpha.1".into();
        assert_eq!(
            classify_discovery(&state, stale),
            Err(UpdateOperationError::Verification(
                UpdaterError::DowngradeRejected
            ))
        );
    }

    #[test]
    fn bounded_digest_history_keeps_a_monotonic_channel_high_water() {
        let adapter = UpdaterAdapter::new(PUBLIC_KEY.trim()).unwrap();
        let mut metadata = adapter
            .verify_metadata(VerifyMetadataRequest {
                accepted_metadata_sha256: &[],
                metadata: METADATA,
                metadata_signature: METADATA_SIGNATURE.trim(),
                policy: policy(),
            })
            .unwrap();
        let mut accepted = AcceptedMetadata::empty();
        for sequence in 2..=40 {
            metadata.version = format!("0.1.1-alpha.{sequence}");
            metadata.metadata_sha256 = digest(metadata.version.as_bytes());
            accepted.record(&metadata);
        }
        assert_eq!(accepted.digests.len(), ACCEPTED_METADATA_LIMIT);
        assert_eq!(accepted.alpha_high_water.as_deref(), Some("0.1.1-alpha.40"));
        assert!(accepted.validate());

        metadata.version = "0.1.1-alpha.2".into();
        assert_eq!(
            accepted.require_newer(&metadata),
            Err(UpdateOperationError::Verification(
                UpdaterError::DowngradeRejected
            ))
        );
        metadata.version = "0.1.1-alpha.40".into();
        assert_eq!(
            accepted.require_newer(&metadata),
            Err(UpdateOperationError::Verification(
                UpdaterError::EqualVersionRejected
            ))
        );
        metadata.version = "0.1.1-alpha.41".into();
        assert!(accepted.require_newer(&metadata).is_ok());
    }

    #[tokio::test]
    async fn restart_marks_safe_partial_interrupted_and_resumable_without_terminal_success() {
        let server = fixture_server().await;
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::Slow;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let service = configured_service(&server, &root, "process-a", limits()).await;
        discover_available(&service, "restart-resume").await;
        service.start_download("restart-resume").await.unwrap();
        timeout(Duration::from_secs(4), async {
            loop {
                if service
                    .snapshot()
                    .progress
                    .is_some_and(|progress| progress.downloaded_bytes >= 2)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        service.cancel("restart-resume").await.unwrap();
        wait_phase(&service, UpdatePhase::Cancelled).await;
        drop(service);

        let restarted = configured_service(&server, &root, "process-b", limits()).await;
        let snapshot = restarted.snapshot();
        assert_eq!(snapshot.phase, UpdatePhase::Failed);
        assert_eq!(snapshot.terminal_reason.as_deref(), Some("interrupted"));
        assert!(snapshot.resumable);
        assert_ne!(snapshot.phase, UpdatePhase::Ready);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_never_follows_symlinks_and_hard_linked_partials_are_restarted() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let unrelated = temporary.path().join("unrelated");
        fs::write(&unrelated, b"keep").unwrap();
        std::os::unix::fs::symlink(&unrelated, root.join("foreign-link")).unwrap();
        fs::write(root.join("foreign-file"), b"remove").unwrap();
        CandidateStore::open(root.clone()).unwrap();
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
        assert!(!root.join("foreign-link").exists());
        assert!(!root.join("foreign-file").exists());

        let server = fixture_server().await;
        let service = configured_service(&server, &root, "process", limits()).await;
        discover_available(&service, "hard-link").await;
        let configured = service.configured.as_ref().unwrap();
        let available = service.state.lock().unwrap().available.clone().unwrap();
        configured
            .store
            .prepare_partial(&available, "hard-link")
            .unwrap();
        let extra_link = temporary.path().join("extra-link");
        fs::hard_link(configured.store.partial_payload_path(), &extra_link).unwrap();
        service.start_download("hard-link").await.unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        assert!(extra_link.exists());
        assert_eq!(
            fs::read(root.join(CANDIDATE_DIRECTORY).join(CANDIDATE_PAYLOAD)).unwrap(),
            ARTIFACT
        );
    }

    #[test]
    fn production_endpoint_and_operation_identifiers_are_closed_over_exact_inputs() {
        assert!(validate_production_endpoint(&alpha_endpoint(), UpdateChannel::Alpha).is_ok());
        assert!(validate_production_endpoint(&stable_endpoint(), UpdateChannel::Stable).is_ok());
        for endpoint in [
            "http://api.github.com/repos/Asuka109/mish/releases?per_page=32&page=1",
            "https://token@api.github.com/repos/Asuka109/mish/releases?per_page=32&page=1",
            "https://api.github.com/repos/other/mish/releases?per_page=32&page=1",
            "https://api.github.com/repos/Asuka109/mish/releases?per_page=31&page=1",
            "https://api.github.com/repos/Asuka109/mish/releases?per_page=32&page=2",
            "https://api.github.com/repos/Asuka109/mish/releases?page=1&per_page=32",
        ] {
            assert_eq!(
                validate_production_endpoint(&Url::parse(endpoint).unwrap(), UpdateChannel::Alpha,),
                Err(UpdateOperationError::NotConfigured)
            );
        }
        let source = Url::parse(
            "https://github.com/Asuka109/mish/releases/download/v0.1.1-alpha.2/mish-alpha.json",
        )
        .unwrap();
        let release_asset = Url::parse(
            "https://release-assets.githubusercontent.com/github-production-release-asset/123/456?sp=read",
        )
        .unwrap();
        assert!(trusted_release_redirect(
            std::slice::from_ref(&source),
            &release_asset
        ));
        for destination in [
            "http://release-assets.githubusercontent.com/github-production-release-asset/123/456",
            "https://example.com/github-production-release-asset/123/456",
            "https://release-assets.githubusercontent.com/other/123/456",
        ] {
            assert!(!trusted_release_redirect(
                std::slice::from_ref(&source),
                &Url::parse(destination).unwrap(),
            ));
        }
        assert!(!trusted_release_redirect(
            &[source.clone(), release_asset.clone()],
            &release_asset,
        ));
        assert!(validate_operation_id("browser-client.operation-1").is_ok());
        for operation_id in ["", "../escape", "credential=secret", "with space"] {
            assert_eq!(
                validate_operation_id(operation_id),
                Err(UpdateOperationError::InvalidOperationKey)
            );
        }
    }
}
