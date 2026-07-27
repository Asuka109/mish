use std::{
    cmp::Ordering,
    collections::BTreeSet,
    fmt,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use reqwest::{
    Client, Response, StatusCode,
    header::{
        ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, RANGE,
    },
};
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

const STORE_SCHEMA_VERSION: u8 = 1;
const STORE_ENTRY_LIMIT: usize = 64;
const ACCEPTED_METADATA_LIMIT: usize = 32;
const STATE_FILE: &str = "state.json";
const ACCEPTED_FILE: &str = "accepted.json";
const PARTIAL_DIRECTORY: &str = "partial";
const PARTIAL_PAYLOAD: &str = "payload.part";
const PARTIAL_MANIFEST: &str = "manifest.json";
const CANDIDATE_DIRECTORY: &str = "candidate";
const CANDIDATE_PAYLOAD: &str = "payload";
const CANDIDATE_MANIFEST: &str = "manifest.json";
const STRONG_ETAG_MAX_BYTES: usize = 256;

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

    fn resume_identity(&self) -> String {
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

#[derive(Clone)]
struct AvailableCandidate {
    metadata: VerifiedMetadata,
    metadata_bytes: Vec<u8>,
    metadata_signature: String,
}

impl AvailableCandidate {
    fn identity(&self) -> UpdateCandidateIdentity {
        UpdateCandidateIdentity::from_verified(&self.metadata)
    }

    fn persisted(&self, operation_id: &str) -> PersistedCandidate {
        PersistedCandidate {
            schema_version: STORE_SCHEMA_VERSION,
            operation_id: operation_id.to_owned(),
            identity: self.identity(),
            metadata_base64: STANDARD.encode(&self.metadata_bytes),
            metadata_signature: self.metadata_signature.clone(),
        }
    }
}

struct RuntimeState {
    snapshot: UpdaterSnapshot,
    accepted: AcceptedMetadata,
    available: Option<AvailableCandidate>,
    active_cancel: Option<CancellationToken>,
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

pub struct UpdaterService {
    configured: Option<ConfiguredUpdater>,
    state: Mutex<RuntimeState>,
    updates: broadcast::Sender<UpdaterSnapshot>,
}

impl UpdaterService {
    pub fn unconfigured(authority_id: impl Into<String>) -> Self {
        let snapshot = UpdaterSnapshot::idle(authority_id.into(), false);
        let (updates, _) = broadcast::channel(32);
        Self {
            configured: None,
            state: Mutex::new(RuntimeState {
                snapshot,
                accepted: AcceptedMetadata::empty(),
                available: None,
                active_cancel: None,
            }),
            updates,
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
            .pool_max_idle_per_host(1)
            .build()
            .map_err(|_| UpdateOperationError::Network)?;
        let store = CandidateStore::open(store_root)?;
        let recovered = store.recover(&adapter, &policy, &limits)?;
        let snapshot = recovered.snapshot(authority_id);
        let (updates, _) = broadcast::channel(32);
        Ok(Self {
            configured: Some(ConfiguredUpdater {
                adapter,
                client,
                endpoint,
                fixture_rewrite,
                limits,
                policy,
                store,
            }),
            state: Mutex::new(RuntimeState {
                snapshot,
                accepted: recovered.accepted,
                available: recovered.available,
                active_cancel: None,
            }),
            updates,
        })
    }

    pub fn snapshot(&self) -> UpdaterSnapshot {
        self.state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .clone()
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

    pub fn start_check(
        self: &Arc<Self>,
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
        let operation_id = operation_id.to_owned();
        let cancel = CancellationToken::new();
        let snapshot = {
            let mut state = self.state.lock().expect("updater state poisoned");
            if state.snapshot.operation_id.as_deref() == Some(operation_id.as_str())
                && state.snapshot.phase != UpdatePhase::Idle
            {
                return if state.snapshot.channel == Some(channel) {
                    Ok(state.snapshot.clone())
                } else {
                    Err(UpdateOperationError::OperationMismatch)
                };
            }
            if operation_in_flight(state.snapshot.phase) {
                return Err(UpdateOperationError::Busy);
            }
            state.available = None;
            state.active_cancel = Some(cancel.clone());
            transition(
                &mut state.snapshot,
                UpdatePhase::Checking,
                Some(operation_id.clone()),
                Some(channel),
                None,
                None,
                false,
                None,
            );
            publish(&self.updates, &state.snapshot);
            state.snapshot.clone()
        };
        let service = self.clone();
        tokio::spawn(async move {
            service.run_check(operation_id, channel, cancel).await;
        });
        Ok(snapshot)
    }

    pub fn start_download(
        self: &Arc<Self>,
        operation_id: &str,
    ) -> Result<UpdaterSnapshot, UpdateOperationError> {
        let configured = self.require_configured()?;
        validate_operation_id(operation_id)?;
        let operation_id = operation_id.to_owned();
        let cancel = CancellationToken::new();
        let available = {
            let mut state = self.state.lock().expect("updater state poisoned");
            if state.snapshot.operation_id.as_deref() != Some(operation_id.as_str()) {
                return Err(UpdateOperationError::OperationMismatch);
            }
            if matches!(
                state.snapshot.phase,
                UpdatePhase::Downloading | UpdatePhase::Verifying | UpdatePhase::Ready
            ) {
                return Ok(state.snapshot.clone());
            }
            if !matches!(
                state.snapshot.phase,
                UpdatePhase::Available | UpdatePhase::Cancelled | UpdatePhase::Failed
            ) {
                return Err(UpdateOperationError::OperationMismatch);
            }
            let available = state
                .available
                .clone()
                .ok_or(UpdateOperationError::OperationMismatch)?;
            let partial = configured
                .store
                .partial_info(&available, &operation_id)
                .ok();
            let resumed = partial
                .filter(|partial| partial.etag.is_some())
                .map_or(0, |partial| partial.size);
            state.active_cancel = Some(cancel.clone());
            transition(
                &mut state.snapshot,
                UpdatePhase::Downloading,
                Some(operation_id.clone()),
                Some(available.metadata.channel),
                Some(available.identity()),
                Some(UpdateProgress {
                    downloaded_bytes: resumed.min(available.metadata.artifact_size),
                    total_bytes: available.metadata.artifact_size,
                }),
                resumed > 0,
                None,
            );
            publish(&self.updates, &state.snapshot);
            available
        };
        let service = self.clone();
        tokio::spawn(async move {
            service.run_download(operation_id, available, cancel).await;
        });
        Ok(self.snapshot())
    }

    pub fn cancel(&self, operation_id: &str) -> Result<UpdaterSnapshot, UpdateOperationError> {
        self.require_configured()?;
        validate_operation_id(operation_id)?;
        let state = self.state.lock().expect("updater state poisoned");
        if state.snapshot.operation_id.as_deref() != Some(operation_id) {
            return Err(UpdateOperationError::OperationMismatch);
        }
        if let Some(cancel) = &state.active_cancel {
            cancel.cancel();
        }
        Ok(state.snapshot.clone())
    }

    fn require_configured(&self) -> Result<&ConfiguredUpdater, UpdateOperationError> {
        self.configured
            .as_ref()
            .ok_or(UpdateOperationError::NotConfigured)
    }

    async fn run_check(
        self: Arc<Self>,
        operation_id: String,
        channel: UpdateChannel,
        cancel: CancellationToken,
    ) {
        let result = self.discover(channel, &cancel).await;
        match result {
            Ok(available) => {
                let Some(configured) = &self.configured else {
                    return;
                };
                if configured
                    .store
                    .persist_available(&available, &operation_id)
                    .is_err()
                {
                    self.finish_failure(
                        &operation_id,
                        UpdatePhase::Checking,
                        UpdateOperationError::StoreIo,
                    );
                    return;
                }
                let mut state = self.state.lock().expect("updater state poisoned");
                if !current_operation(&state, &operation_id, UpdatePhase::Checking) {
                    return;
                }
                state.active_cancel = None;
                state.available = Some(available.clone());
                transition(
                    &mut state.snapshot,
                    UpdatePhase::Available,
                    Some(operation_id),
                    Some(channel),
                    Some(available.identity()),
                    None,
                    false,
                    None,
                );
                publish(&self.updates, &state.snapshot);
            }
            Err(UpdateOperationError::Cancelled) => {
                self.finish_cancelled(&operation_id, UpdatePhase::Checking, false);
            }
            Err(error) => self.finish_failure(&operation_id, UpdatePhase::Checking, error),
        }
    }

    async fn discover(
        &self,
        channel: UpdateChannel,
        cancel: &CancellationToken,
    ) -> Result<AvailableCandidate, UpdateOperationError> {
        let configured = self.require_configured()?;
        let metadata_url = configured
            .endpoint
            .join(channel.metadata_name())
            .map_err(|_| UpdateOperationError::NotConfigured)?;
        let signature_url = configured
            .endpoint
            .join(&format!("{}.sig", channel.metadata_name()))
            .map_err(|_| UpdateOperationError::NotConfigured)?;
        let metadata = self
            .fetch_bounded(&metadata_url, configured.limits.max_metadata_bytes, cancel)
            .await?;
        let signature = self
            .fetch_bounded(
                &signature_url,
                configured.limits.max_signature_bytes,
                cancel,
            )
            .await?;
        let metadata_signature =
            String::from_utf8(signature).map_err(|_| UpdateOperationError::InvalidResponse)?;
        let accepted = self
            .state
            .lock()
            .expect("updater state poisoned")
            .accepted
            .clone();
        let verified = configured.adapter.verify_metadata(VerifyMetadataRequest {
            accepted_metadata_sha256: &accepted.digests,
            metadata: &metadata,
            metadata_signature: metadata_signature.trim(),
            policy: configured.policy.clone(),
        })?;
        accepted.require_newer(&verified)?;
        if verified.channel != channel {
            return Err(UpdateOperationError::Verification(
                UpdaterError::ChannelMismatch,
            ));
        }
        if verified.artifact_size > configured.limits.max_artifact_bytes {
            return Err(UpdateOperationError::OversizedPayload);
        }
        let artifact_signature_url = Url::parse(&format!("{}.sig", verified.artifact_url))
            .map_err(|_| UpdateOperationError::InvalidResponse)?;
        let artifact_signature = match self
            .fetch_bounded(
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
        let artifact_signature = String::from_utf8(artifact_signature)
            .map_err(|_| UpdateOperationError::InvalidResponse)?;
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
        Ok(AvailableCandidate {
            metadata: verified,
            metadata_bytes: metadata,
            metadata_signature: metadata_signature.trim().to_owned(),
        })
    }

    async fn fetch_bounded(
        &self,
        logical_url: &Url,
        maximum: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, UpdateOperationError> {
        let configured = self.require_configured()?;
        let request_url = request_url(configured, logical_url)?;
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

    async fn run_download(
        self: Arc<Self>,
        operation_id: String,
        available: AvailableCandidate,
        cancel: CancellationToken,
    ) {
        let result = self
            .download_with_deadline(&operation_id, &available, &cancel)
            .await;
        match result {
            Ok(()) => self.finish_ready(&operation_id, available, &cancel).await,
            Err(UpdateOperationError::Cancelled) => {
                let resumable = self
                    .configured
                    .as_ref()
                    .and_then(|configured| {
                        configured
                            .store
                            .partial_info(&available, &operation_id)
                            .ok()
                    })
                    .is_some_and(|partial| partial.size > 0 && partial.etag.is_some());
                self.finish_cancelled(&operation_id, UpdatePhase::Downloading, resumable);
            }
            Err(error) => {
                if matches!(
                    error,
                    UpdateOperationError::InvalidResponse
                        | UpdateOperationError::OversizedPayload
                        | UpdateOperationError::RangeMismatch
                        | UpdateOperationError::Verification(_)
                ) && let Some(configured) = &self.configured
                {
                    let _ = configured.store.discard_partial();
                }
                self.finish_failure(&operation_id, UpdatePhase::Downloading, error);
            }
        }
    }

    async fn download_with_deadline(
        &self,
        operation_id: &str,
        available: &AvailableCandidate,
        cancel: &CancellationToken,
    ) -> Result<(), UpdateOperationError> {
        let configured = self.require_configured()?;
        let deadline = tokio::time::Instant::now() + configured.limits.request_timeout;
        timeout_at(
            deadline,
            self.download_artifact(operation_id, available, cancel),
        )
        .await
        .map_err(|_| UpdateOperationError::Timeout)?
    }

    async fn download_artifact(
        &self,
        operation_id: &str,
        available: &AvailableCandidate,
        cancel: &CancellationToken,
    ) -> Result<(), UpdateOperationError> {
        let configured = self.require_configured()?;
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
            self.publish_progress(operation_id, available, offset);
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

    fn publish_progress(
        &self,
        operation_id: &str,
        available: &AvailableCandidate,
        downloaded_bytes: u64,
    ) {
        let mut state = self.state.lock().expect("updater state poisoned");
        if !current_operation(&state, operation_id, UpdatePhase::Downloading) {
            return;
        }
        let next = UpdateProgress {
            downloaded_bytes: downloaded_bytes.min(available.metadata.artifact_size),
            total_bytes: available.metadata.artifact_size,
        };
        if state.snapshot.progress.as_ref() == Some(&next) {
            return;
        }
        state.snapshot.progress = Some(next);
        state.snapshot.revision = state.snapshot.revision.saturating_add(1);
        publish(&self.updates, &state.snapshot);
    }

    async fn finish_ready(
        &self,
        operation_id: &str,
        available: AvailableCandidate,
        cancel: &CancellationToken,
    ) {
        {
            let mut state = self.state.lock().expect("updater state poisoned");
            if !current_operation(&state, operation_id, UpdatePhase::Downloading) {
                return;
            }
            let progress = state.snapshot.progress.clone();
            transition(
                &mut state.snapshot,
                UpdatePhase::Verifying,
                Some(operation_id.to_owned()),
                Some(available.metadata.channel),
                Some(available.identity()),
                progress,
                false,
                None,
            );
            publish(&self.updates, &state.snapshot);
        }
        let Some(configured) = &self.configured else {
            return;
        };
        let adapter = configured.adapter.clone();
        let metadata = available.metadata.clone();
        let payload_path = configured.store.partial_payload_path();
        let artifact_name = metadata.artifact_name.clone();
        let signature = metadata.artifact_signature.clone();
        let verification = tokio::task::spawn_blocking(move || {
            adapter.verify_payload_file(&metadata, &artifact_name, &payload_path, &signature)
        })
        .await
        .map_err(|_| UpdateOperationError::StoreIo)
        .and_then(|result| result.map_err(UpdateOperationError::Verification));
        if let Err(error) = verification {
            let _ = configured.store.discard_partial();
            self.finish_failure(operation_id, UpdatePhase::Verifying, error);
            return;
        }
        if cancel.is_cancelled() {
            self.finish_cancelled(operation_id, UpdatePhase::Verifying, true);
            return;
        }
        if let Err(error) = configured.store.publish_candidate(&available, operation_id) {
            self.finish_failure(operation_id, UpdatePhase::Verifying, error);
            return;
        }
        let mut state = self.state.lock().expect("updater state poisoned");
        if !current_operation(&state, operation_id, UpdatePhase::Verifying) {
            return;
        }
        state.active_cancel = None;
        state.accepted.record(&available.metadata);
        transition(
            &mut state.snapshot,
            UpdatePhase::Ready,
            Some(operation_id.to_owned()),
            Some(available.metadata.channel),
            Some(available.identity()),
            Some(UpdateProgress {
                downloaded_bytes: available.metadata.artifact_size,
                total_bytes: available.metadata.artifact_size,
            }),
            false,
            None,
        );
        publish(&self.updates, &state.snapshot);
    }

    fn finish_cancelled(&self, operation_id: &str, expected: UpdatePhase, resumable: bool) {
        let mut state = self.state.lock().expect("updater state poisoned");
        if !current_operation(&state, operation_id, expected) {
            return;
        }
        state.active_cancel = None;
        let channel = state.snapshot.channel;
        let candidate = state.snapshot.candidate.clone();
        let progress = state.snapshot.progress.clone();
        transition(
            &mut state.snapshot,
            UpdatePhase::Cancelled,
            Some(operation_id.to_owned()),
            channel,
            candidate,
            progress,
            resumable,
            Some(UpdateOperationError::Cancelled.code().to_owned()),
        );
        publish(&self.updates, &state.snapshot);
    }

    fn finish_failure(
        &self,
        operation_id: &str,
        expected: UpdatePhase,
        error: UpdateOperationError,
    ) {
        let mut state = self.state.lock().expect("updater state poisoned");
        if !current_operation(&state, operation_id, expected) {
            return;
        }
        state.active_cancel = None;
        let resumable = state.available.as_ref().is_some_and(|available| {
            self.configured
                .as_ref()
                .and_then(|configured| configured.store.partial_info(available, operation_id).ok())
                .is_some_and(|partial| {
                    partial.size > 0
                        && partial.size < available.metadata.artifact_size
                        && partial.etag.is_some()
                })
        });
        let channel = state.snapshot.channel;
        let candidate = state.snapshot.candidate.clone();
        let progress = state.snapshot.progress.clone();
        transition(
            &mut state.snapshot,
            UpdatePhase::Failed,
            Some(operation_id.to_owned()),
            channel,
            candidate,
            progress,
            resumable,
            Some(error.code().to_owned()),
        );
        publish(&self.updates, &state.snapshot);
    }
}

fn operation_in_flight(phase: UpdatePhase) -> bool {
    matches!(
        phase,
        UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Verifying
    )
}

fn current_operation(state: &RuntimeState, operation_id: &str, phase: UpdatePhase) -> bool {
    state.snapshot.operation_id.as_deref() == Some(operation_id) && state.snapshot.phase == phase
}

#[allow(clippy::too_many_arguments)]
fn transition(
    snapshot: &mut UpdaterSnapshot,
    phase: UpdatePhase,
    operation_id: Option<String>,
    channel: Option<UpdateChannel>,
    candidate: Option<UpdateCandidateIdentity>,
    progress: Option<UpdateProgress>,
    resumable: bool,
    terminal_reason: Option<String>,
) {
    snapshot.revision = snapshot.revision.saturating_add(1);
    snapshot.phase = phase;
    snapshot.operation_id = operation_id;
    snapshot.channel = channel;
    snapshot.candidate = candidate;
    snapshot.progress = progress;
    snapshot.resumable = resumable;
    snapshot.terminal_reason = terminal_reason;
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
    let expected_path = match channel {
        UpdateChannel::Alpha => "/Asuka109/mish/releases/download/updater-alpha/",
        UpdateChannel::Stable => "/Asuka109/mish/releases/download/updater-stable/",
    };
    if endpoint.scheme() == "https"
        && endpoint.host_str() == Some("github.com")
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.query().is_none()
        && endpoint.fragment().is_none()
        && endpoint.path() == expected_path
    {
        Ok(())
    } else {
        Err(UpdateOperationError::NotConfigured)
    }
}

fn trusted_release_redirect(previous: &[Url], destination: &Url) -> bool {
    if previous.len() != 1 {
        return false;
    }
    let source = &previous[0];
    let trusted_source = source.scheme() == "https"
        && source.host_str() == Some("github.com")
        && source.username().is_empty()
        && source.password().is_none()
        && source.query().is_none()
        && source.fragment().is_none();
    let trusted_destination = destination.scheme() == "https"
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
        };
    trusted_source && trusted_destination
}

fn request_url(
    configured: &ConfiguredUpdater,
    logical_url: &Url,
) -> Result<Url, UpdateOperationError> {
    if let Some(rewrite) = &configured.fixture_rewrite {
        let file = logical_url
            .path_segments()
            .and_then(Iterator::last)
            .filter(|value| !value.is_empty())
            .ok_or(UpdateOperationError::InvalidResponse)?;
        return rewrite
            .join(file)
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
}

impl RecoveredState {
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
        let mut accepted = self.read_accepted()?;
        if let Ok(state) = self.read_json::<PersistedState>(&self.root.join(STATE_FILE))
            && state.schema_version == STORE_SCHEMA_VERSION
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
                        let accepted_identity = accepted
                            .digests
                            .contains(&available.metadata.metadata_sha256);
                        let high_water_allows = match accepted.compare(&available.metadata) {
                            Some(Ordering::Less) => false,
                            Some(Ordering::Equal) => accepted_identity,
                            Some(Ordering::Greater) | None => true,
                        };
                        if high_water_allows
                            && self
                                .verify_ready(adapter, &available, &state.candidate)
                                .is_ok()
                        {
                            let previous = accepted.clone();
                            accepted.record(&available.metadata);
                            if accepted != previous {
                                self.write_accepted(&accepted)?;
                            }
                            return Ok(RecoveredState {
                                accepted,
                                available: Some(available.clone()),
                                operation_id: Some(state.candidate.operation_id),
                                phase: UpdatePhase::Ready,
                                resumable: false,
                                terminal_reason: None,
                                progress: Some(UpdateProgress {
                                    downloaded_bytes: available.metadata.artifact_size,
                                    total_bytes: available.metadata.artifact_size,
                                }),
                            });
                        }
                        self.discard_candidate()?;
                    }
                    PersistedPhase::Available => {
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
        })
    }

    fn persist_available(
        &self,
        available: &AvailableCandidate,
        operation_id: &str,
    ) -> Result<(), UpdateOperationError> {
        let persisted = available.persisted(operation_id);
        if self
            .read_json::<PartialManifest>(&self.root.join(PARTIAL_DIRECTORY).join(PARTIAL_MANIFEST))
            .ok()
            .is_some_and(|manifest| {
                manifest.resume_identity != persisted.identity.resume_identity()
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
        )
    }

    fn prepare_partial(
        &self,
        available: &AvailableCandidate,
        operation_id: &str,
    ) -> Result<PartialInfo, UpdateOperationError> {
        let persisted = available.persisted(operation_id);
        let expected_resume = persisted.identity.resume_identity();
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
        if manifest.resume_identity != available.identity().resume_identity()
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
                resume_identity: persisted.identity.resume_identity(),
                candidate: persisted,
                etag: etag.map(str::to_owned),
                updated_at_seconds: now_seconds(),
            },
            0o600,
        )
    }

    fn publish_candidate(
        &self,
        available: &AvailableCandidate,
        operation_id: &str,
    ) -> Result<(), UpdateOperationError> {
        let partial = self.partial_info(available, operation_id)?;
        if partial.size != available.metadata.artifact_size {
            return Err(UpdateOperationError::StoreUnsafe);
        }
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
        self.write_accepted(&accepted)
    }

    fn verify_ready(
        &self,
        adapter: &UpdaterAdapter,
        available: &AvailableCandidate,
        expected: &PersistedCandidate,
    ) -> Result<(), UpdateOperationError> {
        let directory = self.root.join(CANDIDATE_DIRECTORY);
        ensure_private_directory(&directory)?;
        validate_exact_entries(&directory, &[CANDIDATE_MANIFEST, CANDIDATE_PAYLOAD])?;
        let manifest = self.read_json::<PersistedCandidate>(&directory.join(CANDIDATE_MANIFEST))?;
        if &manifest != expected {
            return Err(UpdateOperationError::StoreUnsafe);
        }
        let payload = directory.join(CANDIDATE_PAYLOAD);
        validate_private_file(&payload, Some(available.metadata.artifact_size))?;
        adapter
            .verify_payload_file(
                &available.metadata,
                &available.metadata.artifact_name,
                &payload,
                &available.metadata.artifact_signature,
            )
            .map_err(UpdateOperationError::Verification)
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
        remove_file_if_present(&self.root.join(STATE_FILE))
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
    if persisted.schema_version != STORE_SCHEMA_VERSION {
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
    if UpdateCandidateIdentity::from_verified(&metadata) != persisted.identity {
        return Err(UpdateOperationError::StoreUnsafe);
    }
    Ok(AvailableCandidate {
        metadata,
        metadata_bytes,
        metadata_signature: persisted.metadata_signature.clone(),
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
        sync::atomic::{AtomicUsize, Ordering},
    };

    use axum::{
        Router,
        body::{Body, Bytes},
        extract::State,
        http::{HeaderMap, Response as HttpResponse, header},
        response::IntoResponse,
        routing::get,
    };
    use futures_util::stream;
    use tempfile::TempDir;
    use tokio::{net::TcpListener, task::JoinHandle};

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

    struct FixtureState {
        metadata_mode: Mutex<MetadataMode>,
        artifact_mode: Mutex<ArtifactMode>,
        artifact_signature_mode: Mutex<ArtifactSignatureMode>,
        ranges: Mutex<Vec<Option<String>>>,
        artifact_requests: AtomicUsize,
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
            ranges: Mutex::new(Vec::new()),
            artifact_requests: AtomicUsize::new(0),
        });
        let app = Router::new()
            .route("/mish-alpha.json", get(metadata))
            .route("/mish-alpha.json.sig", get(metadata_signature))
            .route("/Mish-0.1.1-alpha.2-aarch64.app.tar.gz", get(artifact))
            .route(
                "/Mish-0.1.1-alpha.2-aarch64.app.tar.gz.sig",
                get(artifact_signature),
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

    fn policy() -> UpdatePolicy {
        UpdatePolicy {
            installed: InstalledUpdate {
                channel: UpdateChannel::Alpha,
                version: "0.1.1-alpha.1".into(),
            },
            selected_channel: UpdateChannel::Alpha,
        }
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
                server.base.clone(),
                root.to_path_buf(),
                limits,
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

    #[tokio::test]
    async fn success_is_revisioned_operation_keyed_immutable_and_restart_safe() {
        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let service = configured_service(&server, &root, "process-a", limits()).await;
        assert_eq!(
            service.start_check("wrong-channel", UpdateChannel::Stable),
            Err(UpdateOperationError::Verification(
                UpdaterError::ChannelMismatch
            ))
        );
        assert_eq!(service.snapshot().phase, UpdatePhase::Idle);
        let checking = service
            .start_check("operation-a", UpdateChannel::Alpha)
            .unwrap();
        assert_eq!(checking.phase, UpdatePhase::Checking);
        assert_eq!(
            service
                .start_check("operation-a", UpdateChannel::Alpha)
                .unwrap()
                .revision,
            checking.revision
        );
        assert_eq!(
            service.start_check("operation-b", UpdateChannel::Alpha),
            Err(UpdateOperationError::Busy)
        );
        wait_phase(&service, UpdatePhase::Available).await;
        service.start_download("operation-a").unwrap();
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

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_rejects_candidate_with_foreign_nested_entry() {
        use std::os::unix::fs::PermissionsExt;

        let server = fixture_server().await;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("updates");
        let service = configured_service(&server, &root, "process-a", limits()).await;
        discover_available(&service, "nested-entry").await;
        service.start_download("nested-entry").unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        drop(service);

        let candidate = root.join(CANDIDATE_DIRECTORY);
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(candidate.join("foreign"), b"remove").unwrap();
        let restarted = configured_service(&server, &root, "process-b", limits()).await;
        assert_eq!(restarted.snapshot().phase, UpdatePhase::Idle);
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
        service.start_download("resume-operation").unwrap();
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
        service.cancel("resume-operation").unwrap();
        let cancelled = wait_phase(&service, UpdatePhase::Cancelled).await;
        assert!(cancelled.resumable);
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::Success;
        service.start_download("resume-operation").unwrap();
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
        service.start_download("restart-operation").unwrap();
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
        service.cancel("restart-operation").unwrap();
        wait_phase(&service, UpdatePhase::Cancelled).await;
        *server.state.artifact_mode.lock().unwrap() = ArtifactMode::IgnoreRange;
        service.start_download("restart-operation").unwrap();
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
            service.start_download("payload-failure").unwrap();
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
    async fn accepted_metadata_replay_fails_without_republishing_ready() {
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
        service.start_download("first").unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        service.start_check("second", UpdateChannel::Alpha).unwrap();
        let failed = wait_phase(&service, UpdatePhase::Failed).await;
        assert_eq!(failed.terminal_reason.as_deref(), Some("metadata-replay"));
        assert_eq!(server.state.artifact_requests.load(Ordering::SeqCst), 1);
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
        service.start_download("restart-resume").unwrap();
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
        service.cancel("restart-resume").unwrap();
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
        service.start_download("hard-link").unwrap();
        wait_phase(&service, UpdatePhase::Ready).await;
        assert!(extra_link.exists());
        assert_eq!(
            fs::read(root.join(CANDIDATE_DIRECTORY).join(CANDIDATE_PAYLOAD)).unwrap(),
            ARTIFACT
        );
    }

    #[test]
    fn production_endpoint_and_operation_identifiers_are_closed_over_exact_inputs() {
        assert!(
            validate_production_endpoint(
                &Url::parse("https://github.com/Asuka109/mish/releases/download/updater-alpha/")
                    .unwrap(),
                UpdateChannel::Alpha,
            )
            .is_ok()
        );
        assert!(
            validate_production_endpoint(
                &Url::parse("https://github.com/Asuka109/mish/releases/download/updater-stable/")
                    .unwrap(),
                UpdateChannel::Stable,
            )
            .is_ok()
        );
        for endpoint in [
            "http://github.com/Asuka109/mish/releases/download/updater-alpha/",
            "https://token@github.com/Asuka109/mish/releases/download/updater-alpha/",
            "https://github.com/other/mish/releases/download/updater-alpha/",
            "https://github.com/Asuka109/mish/releases/download/updater-stable/",
            "https://github.com/Asuka109/mish/releases/download/updater-alpha/?token=secret",
        ] {
            assert_eq!(
                validate_production_endpoint(&Url::parse(endpoint).unwrap(), UpdateChannel::Alpha,),
                Err(UpdateOperationError::NotConfigured)
            );
        }
        let source = Url::parse(
            "https://github.com/Asuka109/mish/releases/download/updater-alpha/mish-alpha.json",
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
