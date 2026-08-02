use std::{
    collections::VecDeque,
    fmt,
    fs::{self, File, OpenOptions},
    io::Read,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, Mutex},
};

use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
    AuthenticatedReleaseRecord, AvailableCandidate, CANDIDATE_DIRECTORY, CANDIDATE_MANIFEST,
    CANDIDATE_PAYLOAD, CandidateStore, ConfiguredUpdater, GITHUB_EXACT_RELEASE_TAG_PATH,
    PersistedCandidate, RELEASE_ASSET_LIST_LIMIT, UpdateCandidateIdentity, UpdateOperationError,
    UpdatePhase, UpdaterService, fetch_github_api, release_hint, validate_exact_entries,
    validate_operation_id,
};

const SETTLED_OPERATION_LIMIT: usize = 32;
const MANIFEST_BYTE_LIMIT: u64 = 512 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalInstallRequest {
    pub operation_id: String,
    pub expected_authority_id: String,
    pub expected_ready_operation_id: String,
    pub expected_revision: u64,
    pub expected_candidate: UpdateCandidateIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalInstallEvidence {
    pub candidate_sha256: String,
    pub operation_id_sha256: String,
    pub payload_handoffs: u8,
    pub payload_network_downloads: u8,
    pub payload_reads: u8,
    pub release_record_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalInstallSeamError {
    MalformedPackage,
    Rejected,
}

pub trait LocalInstallSeam: Send {
    fn install(self, bytes: &[u8]) -> Result<(), LocalInstallSeamError>;
}

impl<F> LocalInstallSeam for F
where
    F: for<'a> FnOnce(&'a [u8]) -> Result<(), LocalInstallSeamError> + Send,
{
    fn install(self, bytes: &[u8]) -> Result<(), LocalInstallSeamError> {
        self(bytes)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalInstallError {
    Cancelled,
    CandidateUnavailable,
    CapabilityDisabled,
    ContextUnavailable,
    Duplicate,
    InvalidOperation,
    MalformedPackage,
    OversizedPackage,
    ReleaseDrift,
    ReplacedOperation,
    SeamRejected,
    StaleRevision,
    StoreUnsafe,
    TaskFinalization,
    VerificationFailed,
}

impl LocalInstallError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::CandidateUnavailable => "candidate-unavailable",
            Self::CapabilityDisabled => "capability-disabled",
            Self::ContextUnavailable => "installation-context-unavailable",
            Self::Duplicate => "duplicate",
            Self::InvalidOperation => "invalid-operation-key",
            Self::MalformedPackage => "malformed-package",
            Self::OversizedPackage => "oversized-package",
            Self::ReleaseDrift => "release-drift",
            Self::ReplacedOperation => "replaced-operation",
            Self::SeamRejected => "install-seam-rejected",
            Self::StaleRevision => "stale-revision",
            Self::StoreUnsafe => "store-unsafe",
            Self::TaskFinalization => "task-finalization",
            Self::VerificationFailed => "verification-failed",
        }
    }
}

impl fmt::Display for LocalInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for LocalInstallError {}

#[derive(Clone, Copy)]
enum InstallCapability {
    Disabled,
    #[cfg(test)]
    ProofOnly,
}

pub struct LocalCandidateInstallAdapter {
    capability: InstallCapability,
    service: Arc<UpdaterService>,
}

impl LocalCandidateInstallAdapter {
    pub(super) fn disabled(service: Arc<UpdaterService>) -> Self {
        Self {
            capability: InstallCapability::Disabled,
            service,
        }
    }

    #[cfg(test)]
    pub(super) fn proof_only(service: Arc<UpdaterService>) -> Self {
        Self {
            capability: InstallCapability::ProofOnly,
            service,
        }
    }

    pub async fn install<S: LocalInstallSeam>(
        &self,
        request: LocalInstallRequest,
        cancellation: CancellationToken,
        seam: S,
    ) -> Result<LocalInstallEvidence, LocalInstallError> {
        if matches!(self.capability, InstallCapability::Disabled) {
            return Err(LocalInstallError::CapabilityDisabled);
        }
        validate_operation_id(&request.operation_id)
            .map_err(|_| LocalInstallError::InvalidOperation)?;
        let _lease = InstallAdmissionLease::begin(
            self.service.install_admission.clone(),
            &request.operation_id,
        )?;
        let configured = self
            .service
            .configured
            .as_deref()
            .ok_or(LocalInstallError::CapabilityDisabled)?;
        let (candidate, context_bound) = self.ready_candidate(&request)?;
        if candidate.metadata.artifact_size > configured.limits.max_artifact_bytes {
            return Err(LocalInstallError::OversizedPackage);
        }
        let mut machine = InstallProofMachine::admit(context_bound);
        cancelled(&cancellation)?;
        if !context_bound {
            rebind_exact_release(configured, &candidate.release, &cancellation).await?;
            self.bind_reverified_context(&request, &candidate)?;
            machine.apply(InstallProofInput::Rebound)?;
        }
        cancelled(&cancellation)?;
        self.ensure_still_current(&request)?;
        let store = configured.store.clone();
        let verifier = configured.adapter.clone();
        let release_record_sha256 = candidate.release.digest();
        let expected = candidate.persisted(&request.expected_ready_operation_id);
        let maximum = configured.limits.max_artifact_bytes;
        let bytes = tokio::task::spawn_blocking(move || {
            store.reopen_verified_bytes(&verifier, &candidate, &expected, maximum)
        })
        .await
        .map_err(|_| LocalInstallError::TaskFinalization)??;
        machine.apply(InstallProofInput::Read)?;
        cancelled(&cancellation)?;
        self.ensure_still_current(&request)?;
        machine.apply(InstallProofInput::HandoffStarted)?;
        let handoff = catch_unwind(AssertUnwindSafe(|| seam.install(&bytes)))
            .map_err(|_| LocalInstallError::TaskFinalization)?;
        match handoff {
            Ok(()) => machine.apply(InstallProofInput::HandoffFinished)?,
            Err(LocalInstallSeamError::MalformedPackage) => {
                return Err(LocalInstallError::MalformedPackage);
            }
            Err(LocalInstallSeamError::Rejected) => {
                return Err(LocalInstallError::SeamRejected);
            }
        }
        debug_assert_eq!(machine.state, InstallProofState::Complete);
        Ok(LocalInstallEvidence {
            candidate_sha256: request.expected_candidate.artifact_sha256,
            operation_id_sha256: super::digest(request.operation_id.as_bytes()),
            payload_handoffs: 1,
            payload_network_downloads: 0,
            payload_reads: 1,
            release_record_sha256,
        })
    }

    fn ready_candidate(
        &self,
        request: &LocalInstallRequest,
    ) -> Result<(AvailableCandidate, bool), LocalInstallError> {
        let state = self.service.state.lock().expect("updater state poisoned");
        if state.snapshot.authority_id != request.expected_authority_id {
            return Err(LocalInstallError::StaleRevision);
        }
        if state.snapshot.operation_id.as_deref()
            != Some(request.expected_ready_operation_id.as_str())
        {
            return Err(LocalInstallError::ReplacedOperation);
        }
        if state.snapshot.phase != UpdatePhase::Ready {
            return Err(LocalInstallError::CandidateUnavailable);
        }
        if state.snapshot.candidate.as_ref() != Some(&request.expected_candidate) {
            return Err(LocalInstallError::ReplacedOperation);
        }
        if state.snapshot.revision != request.expected_revision {
            return Err(LocalInstallError::StaleRevision);
        }
        let candidate = state
            .available
            .clone()
            .ok_or(LocalInstallError::CandidateUnavailable)?;
        if candidate.identity() != request.expected_candidate {
            return Err(LocalInstallError::ReplacedOperation);
        }
        Ok((candidate, state.release_context_bound))
    }

    fn ensure_still_current(&self, request: &LocalInstallRequest) -> Result<(), LocalInstallError> {
        self.ready_candidate(request).map(|_| ())
    }

    fn bind_reverified_context(
        &self,
        request: &LocalInstallRequest,
        candidate: &AvailableCandidate,
    ) -> Result<(), LocalInstallError> {
        let mut state = self.service.state.lock().expect("updater state poisoned");
        if state.snapshot.authority_id != request.expected_authority_id {
            return Err(LocalInstallError::StaleRevision);
        }
        if state.snapshot.phase != UpdatePhase::Ready
            || state.snapshot.operation_id.as_deref()
                != Some(request.expected_ready_operation_id.as_str())
            || state.snapshot.candidate.as_ref() != Some(&request.expected_candidate)
            || state.available.as_ref() != Some(candidate)
        {
            return Err(LocalInstallError::ReplacedOperation);
        }
        if state.snapshot.revision != request.expected_revision {
            return Err(LocalInstallError::StaleRevision);
        }
        state.release_context_bound = true;
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct InstallAdmissionState {
    active: Option<String>,
    settled: VecDeque<String>,
}

struct InstallAdmissionLease {
    admission: Arc<Mutex<InstallAdmissionState>>,
    operation_id: String,
}

impl InstallAdmissionLease {
    fn begin(
        admission: Arc<Mutex<InstallAdmissionState>>,
        operation_id: &str,
    ) -> Result<Self, LocalInstallError> {
        let mut state = admission.lock().expect("install admission poisoned");
        if state.active.as_deref() == Some(operation_id)
            || state.settled.iter().any(|settled| settled == operation_id)
        {
            return Err(LocalInstallError::Duplicate);
        }
        if state.active.is_some() {
            return Err(LocalInstallError::ReplacedOperation);
        }
        state.active = Some(operation_id.to_owned());
        drop(state);
        Ok(Self {
            admission,
            operation_id: operation_id.to_owned(),
        })
    }
}

impl Drop for InstallAdmissionLease {
    fn drop(&mut self) {
        let mut state = self.admission.lock().expect("install admission poisoned");
        if state.active.as_deref() == Some(self.operation_id.as_str()) {
            state.active = None;
        }
        state.settled.push_back(self.operation_id.clone());
        if state.settled.len() > SETTLED_OPERATION_LIMIT {
            state.settled.pop_front();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InstallProofState {
    Rebinding,
    Reading,
    HandoffReady,
    HandingOff,
    Complete,
}

#[derive(Clone, Copy, Debug)]
enum InstallProofInput {
    Rebound,
    Read,
    HandoffStarted,
    HandoffFinished,
}

struct InstallProofMachine {
    state: InstallProofState,
}

impl InstallProofMachine {
    fn admit(context_bound: bool) -> Self {
        Self {
            state: if context_bound {
                InstallProofState::Reading
            } else {
                InstallProofState::Rebinding
            },
        }
    }

    fn apply(&mut self, input: InstallProofInput) -> Result<(), LocalInstallError> {
        self.state = match (self.state, input) {
            (InstallProofState::Rebinding, InstallProofInput::Rebound) => {
                InstallProofState::Reading
            }
            (InstallProofState::Reading, InstallProofInput::Read) => {
                InstallProofState::HandoffReady
            }
            (InstallProofState::HandoffReady, InstallProofInput::HandoffStarted) => {
                InstallProofState::HandingOff
            }
            (InstallProofState::HandingOff, InstallProofInput::HandoffFinished) => {
                InstallProofState::Complete
            }
            _ => return Err(LocalInstallError::TaskFinalization),
        };
        Ok(())
    }
}

fn cancelled(cancellation: &CancellationToken) -> Result<(), LocalInstallError> {
    if cancellation.is_cancelled() {
        Err(LocalInstallError::Cancelled)
    } else {
        Ok(())
    }
}

async fn rebind_exact_release(
    configured: &ConfiguredUpdater,
    expected: &AuthenticatedReleaseRecord,
    cancellation: &CancellationToken,
) -> Result<(), LocalInstallError> {
    if !expected.validates(expected.channel, &expected.version)
        || expected.assets.len() > RELEASE_ASSET_LIST_LIMIT
    {
        return Err(LocalInstallError::ReleaseDrift);
    }
    let url = Url::parse(&format!(
        "https://api.github.com{GITHUB_EXACT_RELEASE_TAG_PATH}{}",
        expected.tag
    ))
    .map_err(|_| LocalInstallError::ReleaseDrift)?;
    let bytes = fetch_github_api(configured, &url, cancellation)
        .await
        .map_err(map_rebind_error)?;
    let release = serde_json::from_slice(&bytes).map_err(|_| LocalInstallError::ReleaseDrift)?;
    let rebound = release_hint(release, expected.channel)
        .map_err(|_| LocalInstallError::ReleaseDrift)?
        .record;
    if &rebound == expected {
        Ok(())
    } else {
        Err(LocalInstallError::ReleaseDrift)
    }
}

fn map_rebind_error(error: UpdateOperationError) -> LocalInstallError {
    match error {
        UpdateOperationError::Cancelled => LocalInstallError::Cancelled,
        UpdateOperationError::Network | UpdateOperationError::Timeout => {
            LocalInstallError::ContextUnavailable
        }
        _ => LocalInstallError::ReleaseDrift,
    }
}

impl CandidateStore {
    fn reopen_verified_bytes(
        &self,
        adapter: &super::UpdaterAdapter,
        candidate: &AvailableCandidate,
        expected: &PersistedCandidate,
        maximum: u64,
    ) -> Result<Vec<u8>, LocalInstallError> {
        if candidate.metadata.artifact_size == 0 || candidate.metadata.artifact_size > maximum {
            return Err(LocalInstallError::OversizedPackage);
        }
        #[cfg(unix)]
        {
            self.reopen_verified_bytes_unix(adapter, candidate, expected)
        }
        #[cfg(not(unix))]
        {
            let _ = (adapter, candidate, expected);
            Err(LocalInstallError::StoreUnsafe)
        }
    }

    #[cfg(unix)]
    fn reopen_verified_bytes_unix(
        &self,
        adapter: &super::UpdaterAdapter,
        candidate: &AvailableCandidate,
        expected: &PersistedCandidate,
    ) -> Result<Vec<u8>, LocalInstallError> {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::OpenOptionsExt;

        let directory_path = self.root.join(CANDIDATE_DIRECTORY);
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&directory_path)
            .map_err(|_| LocalInstallError::StoreUnsafe)?;
        let directory_metadata = directory
            .metadata()
            .map_err(|_| LocalInstallError::StoreUnsafe)?;
        validate_exact_metadata(&directory_metadata, true, 0o500, None, true)?;
        validate_same_path_identity(&directory_path, &directory_metadata)?;
        validate_exact_entries(&directory_path, &[CANDIDATE_MANIFEST, CANDIDATE_PAYLOAD])
            .map_err(|_| LocalInstallError::StoreUnsafe)?;

        let open_at = |name: &str| -> Result<File, LocalInstallError> {
            let name = CString::new(name).map_err(|_| LocalInstallError::StoreUnsafe)?;
            let descriptor = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_RDONLY,
                )
            };
            if descriptor < 0 {
                Err(LocalInstallError::StoreUnsafe)
            } else {
                Ok(unsafe { File::from_raw_fd(descriptor) })
            }
        };

        let manifest_file = open_at(CANDIDATE_MANIFEST)?;
        let manifest_metadata = manifest_file
            .metadata()
            .map_err(|_| LocalInstallError::StoreUnsafe)?;
        validate_exact_metadata(
            &manifest_metadata,
            false,
            0o400,
            Some(MANIFEST_BYTE_LIMIT),
            false,
        )?;
        let mut manifest_bytes = Vec::with_capacity(manifest_metadata.len() as usize);
        manifest_file
            .take(MANIFEST_BYTE_LIMIT.saturating_add(1))
            .read_to_end(&mut manifest_bytes)
            .map_err(|_| LocalInstallError::StoreUnsafe)?;
        if manifest_bytes.len() as u64 > MANIFEST_BYTE_LIMIT {
            return Err(LocalInstallError::StoreUnsafe);
        }
        let manifest: PersistedCandidate =
            serde_json::from_slice(&manifest_bytes).map_err(|_| LocalInstallError::StoreUnsafe)?;
        if &manifest != expected {
            return Err(LocalInstallError::StoreUnsafe);
        }

        let mut payload = open_at(CANDIDATE_PAYLOAD)?;
        let payload_metadata = payload
            .metadata()
            .map_err(|_| LocalInstallError::StoreUnsafe)?;
        validate_exact_metadata(
            &payload_metadata,
            false,
            0o400,
            Some(candidate.metadata.artifact_size),
            true,
        )?;
        validate_same_path_identity(&directory_path, &directory_metadata)?;
        let capacity = usize::try_from(candidate.metadata.artifact_size)
            .map_err(|_| LocalInstallError::OversizedPackage)?;
        let mut bytes = Vec::with_capacity(capacity);
        payload
            .by_ref()
            .take(candidate.metadata.artifact_size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| LocalInstallError::StoreUnsafe)?;
        if bytes.len() as u64 != candidate.metadata.artifact_size {
            return Err(LocalInstallError::StoreUnsafe);
        }
        adapter
            .verify_payload_bytes(
                &candidate.metadata,
                &candidate.metadata.artifact_name,
                &bytes,
                &candidate.metadata.artifact_signature,
            )
            .map_err(|_| LocalInstallError::VerificationFailed)?;
        Ok(bytes)
    }
}

#[cfg(unix)]
fn validate_exact_metadata(
    metadata: &fs::Metadata,
    directory: bool,
    mode: u32,
    size_or_limit: Option<u64>,
    exact_size: bool,
) -> Result<(), LocalInstallError> {
    use std::os::unix::fs::MetadataExt;
    let kind_matches = if directory {
        metadata.file_type().is_dir()
    } else {
        metadata.file_type().is_file()
    };
    let size_matches = size_or_limit.is_none_or(|size| {
        !exact_size && metadata.len() <= size || exact_size && metadata.len() == size
    });
    if !kind_matches
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != mode
        || (!directory && metadata.nlink() != 1)
        || !size_matches
    {
        return Err(LocalInstallError::StoreUnsafe);
    }
    Ok(())
}

#[cfg(unix)]
fn validate_same_path_identity(
    path: &std::path::Path,
    opened: &fs::Metadata,
) -> Result<(), LocalInstallError> {
    use std::os::unix::fs::MetadataExt;
    let current = fs::symlink_metadata(path).map_err(|_| LocalInstallError::StoreUnsafe)?;
    if current.file_type().is_dir()
        && current.dev() == opened.dev()
        && current.ino() == opened.ino()
    {
        Ok(())
    } else {
        Err(LocalInstallError::StoreUnsafe)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TauriUpdateInstallSeam<'a>(&'a tauri_plugin_updater::Update);

    impl LocalInstallSeam for TauriUpdateInstallSeam<'_> {
        fn install(self, bytes: &[u8]) -> Result<(), LocalInstallSeamError> {
            self.0
                .install(bytes)
                .map_err(|_| LocalInstallSeamError::Rejected)
        }
    }

    #[test]
    fn adapter_buffer_matches_the_public_tauri_update_install_signature() {
        fn assert_adapter_seam<S: LocalInstallSeam>() {}
        assert_adapter_seam::<TauriUpdateInstallSeam<'static>>();
    }

    #[test]
    fn reducer_accepts_only_the_exact_install_sequence() {
        let mut rebound = InstallProofMachine::admit(false);
        rebound.apply(InstallProofInput::Rebound).unwrap();
        rebound.apply(InstallProofInput::Read).unwrap();
        rebound.apply(InstallProofInput::HandoffStarted).unwrap();
        rebound.apply(InstallProofInput::HandoffFinished).unwrap();
        assert_eq!(rebound.state, InstallProofState::Complete);

        let mut bound = InstallProofMachine::admit(true);
        assert_eq!(
            bound.apply(InstallProofInput::HandoffStarted),
            Err(LocalInstallError::TaskFinalization)
        );
    }

    #[test]
    fn reducer_rejects_every_out_of_order_input_without_panicking() {
        let states = [
            InstallProofState::Rebinding,
            InstallProofState::Reading,
            InstallProofState::HandoffReady,
            InstallProofState::HandingOff,
            InstallProofState::Complete,
        ];
        let inputs = [
            InstallProofInput::Rebound,
            InstallProofInput::Read,
            InstallProofInput::HandoffStarted,
            InstallProofInput::HandoffFinished,
        ];
        for state in states {
            for input in inputs {
                let mut machine = InstallProofMachine { state };
                let accepted = matches!(
                    (state, input),
                    (InstallProofState::Rebinding, InstallProofInput::Rebound)
                        | (InstallProofState::Reading, InstallProofInput::Read)
                        | (
                            InstallProofState::HandoffReady,
                            InstallProofInput::HandoffStarted
                        )
                        | (
                            InstallProofState::HandingOff,
                            InstallProofInput::HandoffFinished
                        )
                );
                assert_eq!(machine.apply(input).is_ok(), accepted);
            }
        }
    }
}
