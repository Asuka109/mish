use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use futures_util::future::BoxFuture;
use mish_runtime::LoopbackProxyEndpoint;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const MANAGED_CORE_TOKEN_ENV: &str = "MISH_MANAGED_CORE_TOKEN";
const OWNERSHIP_FILE: &str = "core-ownership.json";
const LEASE_FILE: &str = "desktop-instance.lock";
const OWNERSHIP_SCHEMA_VERSION: u32 = 1;
const MAX_OWNERSHIP_BYTES: u64 = 16 * 1024;
const RECOVERY_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedCoreLaunchSpec {
    binary: PathBuf,
    config_directory: PathBuf,
    config_file: PathBuf,
    generation_id: String,
    launch_token: String,
}

impl ManagedCoreLaunchSpec {
    pub fn binary(&self) -> &Path {
        &self.binary
    }

    pub fn config_directory(&self) -> &Path {
        &self.config_directory
    }

    pub fn config_file(&self) -> &Path {
        &self.config_file
    }

    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    pub fn launch_token(&self) -> &str {
        &self.launch_token
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedProcessObservation {
    binary: PathBuf,
    config_directory: PathBuf,
    config_file: PathBuf,
    launch_token: String,
    pid: u32,
    started_at: u64,
}

impl ManagedProcessObservation {
    pub fn new(
        pid: u32,
        started_at: u64,
        binary: PathBuf,
        config_directory: PathBuf,
        config_file: PathBuf,
        launch_token: String,
    ) -> Self {
        Self {
            binary,
            config_directory,
            config_file,
            launch_token,
            pid,
            started_at,
        }
    }

    pub fn from_launch(pid: u32, started_at: u64, spec: &ManagedCoreLaunchSpec) -> Self {
        Self::new(
            pid,
            started_at,
            spec.binary.clone(),
            spec.config_directory.clone(),
            spec.config_file.clone(),
            spec.launch_token.clone(),
        )
    }

    pub fn launch_token(&self) -> &str {
        &self.launch_token
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ManagedProcessPlatformError {
    #[error("managed process identity could not be observed")]
    ObservationFailed,
    #[error("managed process signal could not be delivered")]
    SignalFailed,
    #[error("managed process exit could not be confirmed")]
    WaitFailed,
    #[error("managed listener ownership could not be confirmed")]
    ListenerInspectionFailed,
}

pub trait ManagedProcessPlatform: Send + Sync {
    fn prepare_launch(
        &self,
        _spec: &ManagedCoreLaunchSpec,
    ) -> Result<(), ManagedProcessPlatformError> {
        Ok(())
    }

    fn inspect(
        &self,
        pid: u32,
    ) -> Result<Option<ManagedProcessObservation>, ManagedProcessPlatformError>;
    fn find_launch(
        &self,
        spec: &ManagedCoreLaunchSpec,
    ) -> Result<Vec<ManagedProcessObservation>, ManagedProcessPlatformError>;
    fn terminate(&self, pid: u32) -> Result<(), ManagedProcessPlatformError>;
    fn kill(&self, pid: u32) -> Result<(), ManagedProcessPlatformError>;
    fn wait_for_exit(
        &self,
        pid: u32,
        deadline: Duration,
    ) -> BoxFuture<'_, Result<bool, ManagedProcessPlatformError>>;
    fn owns_listener(
        &self,
        process: &ManagedProcessObservation,
        endpoint: &LoopbackProxyEndpoint,
    ) -> Result<bool, ManagedProcessPlatformError>;
}

#[derive(Debug)]
pub struct ManagedRuntimeLease {
    file: File,
}

impl ManagedRuntimeLease {
    pub fn acquire(runtime_root: &Path) -> Result<Self, ManagedCoreOwnershipError> {
        prepare_private_directory(runtime_root)?;
        let path = runtime_root.join(LEASE_FILE);
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(path)
            .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = file
                .metadata()
                .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
            if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
                return Err(ManagedCoreOwnershipError::InvalidStorage);
            }
            // SAFETY: flock operates on the live file descriptor and does not outlive it.
            let result = unsafe {
                libc::flock(
                    std::os::fd::AsRawFd::as_raw_fd(&file),
                    libc::LOCK_EX | libc::LOCK_NB,
                )
            };
            if result != 0 {
                return Err(ManagedCoreOwnershipError::InstanceAlreadyRunning);
            }
        }
        Ok(Self { file })
    }
}

impl Drop for ManagedRuntimeLease {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // SAFETY: the descriptor belongs to self and remains open for this call.
            let _ =
                unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&self.file), libc::LOCK_UN) };
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ManagedCoreOwnershipError {
    #[error("another Mish desktop instance owns the managed runtime")]
    InstanceAlreadyRunning,
    #[error("managed Core ownership storage is unavailable")]
    StorageUnavailable,
    #[error("managed Core ownership storage is invalid")]
    InvalidStorage,
    #[error("managed Core ownership record is invalid")]
    InvalidRecord,
    #[error("managed Core process identity could not be confirmed")]
    IdentityMismatch,
    #[error("managed Core process recovery is ambiguous")]
    AmbiguousRecovery,
    #[error("managed Core process could not be terminated and reaped")]
    TerminationFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedCoreProcess {
    generation_id: String,
    observation: ManagedProcessObservation,
}

impl ManagedCoreProcess {
    pub fn pid(&self) -> u32 {
        self.observation.pid
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedCoreLaunch {
    spec: ManagedCoreLaunchSpec,
}

impl ManagedCoreLaunch {
    pub fn spec(&self) -> &ManagedCoreLaunchSpec {
        &self.spec
    }

    pub fn launch_token(&self) -> &str {
        self.spec.launch_token()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedCoreRecoveryOutcome {
    NoRecord,
    ClearedIncompleteLaunch,
    ClearedExitedProcess,
    Recovered { pid: u32 },
}

impl ManagedCoreRecoveryOutcome {
    pub fn recovered_pid(self) -> Option<u32> {
        match self {
            Self::Recovered { pid } => Some(pid),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum OwnershipPhase {
    Launching,
    Running,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipRecord {
    binary: PathBuf,
    config_directory: PathBuf,
    config_file: PathBuf,
    generation_id: String,
    instance_id: String,
    launch_token: String,
    phase: OwnershipPhase,
    pid: Option<u32>,
    process_started_at: Option<u64>,
    schema_version: u32,
}

impl OwnershipRecord {
    fn spec(&self) -> ManagedCoreLaunchSpec {
        ManagedCoreLaunchSpec {
            binary: self.binary.clone(),
            config_directory: self.config_directory.clone(),
            config_file: self.config_file.clone(),
            generation_id: self.generation_id.clone(),
            launch_token: self.launch_token.clone(),
        }
    }

    fn matches(&self, observation: &ManagedProcessObservation) -> bool {
        self.pid.is_none_or(|pid| pid == observation.pid)
            && self
                .process_started_at
                .is_none_or(|started_at| started_at == observation.started_at)
            && self.binary == observation.binary
            && self.config_directory == observation.config_directory
            && self.config_file == observation.config_file
            && self.launch_token == observation.launch_token
    }
}

pub struct ManagedCoreOwnership {
    _lease: ManagedRuntimeLease,
    instance_id: String,
    platform: Arc<dyn ManagedProcessPlatform>,
    runtime_root: PathBuf,
}

impl ManagedCoreOwnership {
    pub fn new(
        runtime_root: PathBuf,
        platform: Arc<dyn ManagedProcessPlatform>,
        lease: ManagedRuntimeLease,
    ) -> Result<Self, ManagedCoreOwnershipError> {
        let runtime_root = runtime_root
            .canonicalize()
            .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
        Ok(Self {
            _lease: lease,
            instance_id: Uuid::new_v4().to_string(),
            platform,
            runtime_root,
        })
    }

    pub fn begin_launch(
        &self,
        binary: PathBuf,
        config_directory: PathBuf,
        config_file: PathBuf,
    ) -> Result<ManagedCoreLaunch, ManagedCoreOwnershipError> {
        if self.load_record()?.is_some() {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
        let binary = canonical_regular_file(&binary)?;
        let config_directory = canonical_private_directory(&config_directory)?;
        let config_file = canonical_private_file(&config_file)?;
        validate_candidate_paths(&self.runtime_root, &config_directory, &config_file)?;
        let spec = ManagedCoreLaunchSpec {
            binary,
            config_directory,
            config_file,
            generation_id: Uuid::new_v4().to_string(),
            launch_token: Uuid::new_v4().to_string(),
        };
        self.platform
            .prepare_launch(&spec)
            .map_err(|_| ManagedCoreOwnershipError::IdentityMismatch)?;
        self.write_record(&OwnershipRecord {
            binary: spec.binary.clone(),
            config_directory: spec.config_directory.clone(),
            config_file: spec.config_file.clone(),
            generation_id: spec.generation_id.clone(),
            instance_id: self.instance_id.clone(),
            launch_token: spec.launch_token.clone(),
            phase: OwnershipPhase::Launching,
            pid: None,
            process_started_at: None,
            schema_version: OWNERSHIP_SCHEMA_VERSION,
        })?;
        Ok(ManagedCoreLaunch { spec })
    }

    pub async fn commit_launch(
        &self,
        launch: &ManagedCoreLaunch,
        pid: u32,
    ) -> Result<ManagedCoreProcess, ManagedCoreOwnershipError> {
        let current = self
            .load_record()?
            .ok_or(ManagedCoreOwnershipError::InvalidRecord)?;
        if current.phase != OwnershipPhase::Launching
            || current.generation_id != launch.spec.generation_id
            || current.spec() != launch.spec
        {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        let observation = loop {
            match self.platform.inspect(pid) {
                Ok(Some(observation)) => break observation,
                Ok(None) | Err(_) if Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok(None) | Err(_) => return Err(ManagedCoreOwnershipError::IdentityMismatch),
            }
        };
        if !current.matches(&observation) {
            return Err(ManagedCoreOwnershipError::IdentityMismatch);
        }
        self.write_record(&OwnershipRecord {
            phase: OwnershipPhase::Running,
            pid: Some(pid),
            process_started_at: Some(observation.started_at),
            ..current
        })?;
        Ok(ManagedCoreProcess {
            generation_id: launch.spec.generation_id.clone(),
            observation,
        })
    }

    pub fn abort_launch(
        &self,
        launch: &ManagedCoreLaunch,
    ) -> Result<(), ManagedCoreOwnershipError> {
        self.clear_generation(&launch.spec.generation_id)
    }

    pub fn clear_process(
        &self,
        process: &ManagedCoreProcess,
    ) -> Result<(), ManagedCoreOwnershipError> {
        self.clear_generation(&process.generation_id)
    }

    pub fn has_record(&self) -> Result<bool, ManagedCoreOwnershipError> {
        self.load_record().map(|record| record.is_some())
    }

    pub fn process_owns_listener(
        &self,
        process: &ManagedCoreProcess,
        endpoint: &LoopbackProxyEndpoint,
    ) -> bool {
        let Ok(Some(current)) = self.platform.inspect(process.pid()) else {
            return false;
        };
        if current != process.observation {
            return false;
        }
        self.platform
            .owns_listener(&current, endpoint)
            .unwrap_or(false)
    }

    pub async fn recover_startup(
        &self,
    ) -> Result<ManagedCoreRecoveryOutcome, ManagedCoreOwnershipError> {
        let Some(record) = self.load_record()? else {
            return Ok(ManagedCoreRecoveryOutcome::NoRecord);
        };
        let observation = match record.phase {
            OwnershipPhase::Launching => {
                let matches = self
                    .platform
                    .find_launch(&record.spec())
                    .map_err(|_| ManagedCoreOwnershipError::IdentityMismatch)?
                    .into_iter()
                    .filter(|observation| record.matches(observation))
                    .collect::<Vec<_>>();
                match matches.as_slice() {
                    [] => {
                        self.clear_record()?;
                        return Ok(ManagedCoreRecoveryOutcome::ClearedIncompleteLaunch);
                    }
                    [observation] => observation.clone(),
                    _ => return Err(ManagedCoreOwnershipError::AmbiguousRecovery),
                }
            }
            OwnershipPhase::Running => {
                let pid = record.pid.ok_or(ManagedCoreOwnershipError::InvalidRecord)?;
                let Some(observation) = self
                    .platform
                    .inspect(pid)
                    .map_err(|_| ManagedCoreOwnershipError::IdentityMismatch)?
                else {
                    self.clear_record()?;
                    return Ok(ManagedCoreRecoveryOutcome::ClearedExitedProcess);
                };
                if !record.matches(&observation) {
                    return Err(ManagedCoreOwnershipError::IdentityMismatch);
                }
                observation
            }
        };

        self.platform
            .terminate(observation.pid)
            .map_err(|_| ManagedCoreOwnershipError::TerminationFailed)?;
        let exited = self
            .platform
            .wait_for_exit(observation.pid, RECOVERY_GRACE)
            .await
            .map_err(|_| ManagedCoreOwnershipError::TerminationFailed)?;
        if !exited {
            let current = self
                .platform
                .inspect(observation.pid)
                .map_err(|_| ManagedCoreOwnershipError::TerminationFailed)?
                .ok_or(ManagedCoreOwnershipError::TerminationFailed)?;
            if current != observation {
                return Err(ManagedCoreOwnershipError::IdentityMismatch);
            }
            self.platform
                .kill(observation.pid)
                .map_err(|_| ManagedCoreOwnershipError::TerminationFailed)?;
            if !self
                .platform
                .wait_for_exit(observation.pid, RECOVERY_GRACE)
                .await
                .map_err(|_| ManagedCoreOwnershipError::TerminationFailed)?
            {
                return Err(ManagedCoreOwnershipError::TerminationFailed);
            }
        }
        self.clear_record()?;
        Ok(ManagedCoreRecoveryOutcome::Recovered {
            pid: observation.pid,
        })
    }

    fn clear_generation(&self, generation_id: &str) -> Result<(), ManagedCoreOwnershipError> {
        let Some(record) = self.load_record()? else {
            return Ok(());
        };
        if record.generation_id != generation_id {
            return Err(ManagedCoreOwnershipError::IdentityMismatch);
        }
        self.clear_record()
    }

    fn record_path(&self) -> PathBuf {
        self.runtime_root.join(OWNERSHIP_FILE)
    }

    fn load_record(&self) -> Result<Option<OwnershipRecord>, ManagedCoreOwnershipError> {
        let path = self.record_path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ManagedCoreOwnershipError::StorageUnavailable),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_OWNERSHIP_BYTES
        {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(ManagedCoreOwnershipError::InvalidRecord);
            }
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(path)
            .map_err(|_| ManagedCoreOwnershipError::InvalidRecord)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_OWNERSHIP_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ManagedCoreOwnershipError::InvalidRecord)?;
        if bytes.len() as u64 > MAX_OWNERSHIP_BYTES {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
        let record: OwnershipRecord =
            serde_json::from_slice(&bytes).map_err(|_| ManagedCoreOwnershipError::InvalidRecord)?;
        self.validate_record(&record)?;
        Ok(Some(record))
    }

    fn validate_record(&self, record: &OwnershipRecord) -> Result<(), ManagedCoreOwnershipError> {
        if record.schema_version != OWNERSHIP_SCHEMA_VERSION
            || Uuid::parse_str(&record.instance_id).is_err()
            || Uuid::parse_str(&record.generation_id).is_err()
            || Uuid::parse_str(&record.launch_token).is_err()
            || !record.binary.is_absolute()
            || !record.config_directory.is_absolute()
            || !record.config_file.is_absolute()
            || !matches!(
                (record.phase, record.pid, record.process_started_at),
                (OwnershipPhase::Launching, None, None)
                    | (OwnershipPhase::Running, Some(_), Some(_))
            )
        {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
        validate_candidate_paths(
            &self.runtime_root,
            &record.config_directory,
            &record.config_file,
        )?;
        if canonical_private_directory(&record.config_directory)? != record.config_directory
            || canonical_private_file(&record.config_file)? != record.config_file
        {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
        Ok(())
    }

    fn write_record(&self, record: &OwnershipRecord) -> Result<(), ManagedCoreOwnershipError> {
        let bytes = serde_json::to_vec_pretty(record)
            .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
        let temporary = self
            .runtime_root
            .join(format!(".core-ownership-{}", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
        fs::rename(&temporary, self.record_path())
            .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
        sync_directory(&self.runtime_root)
    }

    fn clear_record(&self) -> Result<(), ManagedCoreOwnershipError> {
        match fs::remove_file(self.record_path()) {
            Ok(()) => sync_directory(&self.runtime_root),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ManagedCoreOwnershipError::StorageUnavailable),
        }
    }
}

fn prepare_private_directory(path: &Path) -> Result<(), ManagedCoreOwnershipError> {
    fs::create_dir_all(path).map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ManagedCoreOwnershipError::InvalidStorage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
    }
    Ok(())
}

fn canonical_regular_file(path: &Path) -> Result<PathBuf, ManagedCoreOwnershipError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ManagedCoreOwnershipError::InvalidRecord)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ManagedCoreOwnershipError::InvalidRecord);
    }
    path.canonicalize()
        .map_err(|_| ManagedCoreOwnershipError::InvalidRecord)
}

fn canonical_private_file(path: &Path) -> Result<PathBuf, ManagedCoreOwnershipError> {
    let canonical = canonical_regular_file(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata =
            fs::metadata(&canonical).map_err(|_| ManagedCoreOwnershipError::InvalidRecord)?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
    }
    Ok(canonical)
}

fn canonical_private_directory(path: &Path) -> Result<PathBuf, ManagedCoreOwnershipError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ManagedCoreOwnershipError::InvalidRecord)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ManagedCoreOwnershipError::InvalidRecord);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ManagedCoreOwnershipError::InvalidRecord);
        }
    }
    path.canonicalize()
        .map_err(|_| ManagedCoreOwnershipError::InvalidRecord)
}

fn validate_candidate_paths(
    runtime_root: &Path,
    config_directory: &Path,
    config_file: &Path,
) -> Result<(), ManagedCoreOwnershipError> {
    let candidates = runtime_root.join("candidates");
    let Some(candidate_root) = config_directory.parent() else {
        return Err(ManagedCoreOwnershipError::InvalidRecord);
    };
    if config_directory.file_name().and_then(|name| name.to_str()) != Some("home")
        || config_file != candidate_root.join("config.yaml")
        || candidate_root.parent() != Some(candidates.as_path())
        || candidate_root
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| Uuid::parse_str(name).is_err())
    {
        return Err(ManagedCoreOwnershipError::InvalidRecord);
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ManagedCoreOwnershipError> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ManagedCoreOwnershipError::StorageUnavailable)?;
    Ok(())
}

#[derive(Default)]
pub struct RealManagedProcessPlatform;

impl ManagedProcessPlatform for RealManagedProcessPlatform {
    fn inspect(
        &self,
        pid: u32,
    ) -> Result<Option<ManagedProcessObservation>, ManagedProcessPlatformError> {
        inspect_process(pid)
    }

    fn find_launch(
        &self,
        spec: &ManagedCoreLaunchSpec,
    ) -> Result<Vec<ManagedProcessObservation>, ManagedProcessPlatformError> {
        let mut matches = Vec::new();
        for pid in list_process_ids()? {
            if process_binary(pid)?.as_deref() != Some(spec.binary()) {
                continue;
            }
            if let Some(process) = inspect_process(pid)?
                && process.launch_token == spec.launch_token
            {
                matches.push(process);
            }
        }
        Ok(matches)
    }

    fn terminate(&self, pid: u32) -> Result<(), ManagedProcessPlatformError> {
        send_signal(pid, libc::SIGTERM)
    }

    fn kill(&self, pid: u32) -> Result<(), ManagedProcessPlatformError> {
        send_signal(pid, libc::SIGKILL)
    }

    fn wait_for_exit(
        &self,
        pid: u32,
        deadline: Duration,
    ) -> BoxFuture<'_, Result<bool, ManagedProcessPlatformError>> {
        Box::pin(async move {
            let expires = Instant::now() + deadline;
            loop {
                if inspect_process(pid)?.is_none() {
                    return Ok(true);
                }
                if Instant::now() >= expires {
                    return Ok(false);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
    }

    fn owns_listener(
        &self,
        process: &ManagedProcessObservation,
        endpoint: &LoopbackProxyEndpoint,
    ) -> Result<bool, ManagedProcessPlatformError> {
        let current = inspect_process(process.pid)?;
        if current.as_ref() != Some(process) {
            return Ok(false);
        }
        let address: SocketAddr = format!("{}:{}", endpoint.host(), endpoint.port())
            .parse()
            .map_err(|_| ManagedProcessPlatformError::ListenerInspectionFailed)?;
        let executable = if cfg!(target_os = "macos") {
            "/usr/sbin/lsof"
        } else {
            "/usr/bin/lsof"
        };
        let output = std::process::Command::new(executable)
            .args([
                "-nP".to_owned(),
                "-a".to_owned(),
                "-p".to_owned(),
                process.pid.to_string(),
                format!("-iTCP@{address}"),
                "-sTCP:LISTEN".to_owned(),
                "-Fpn".to_owned(),
            ])
            .output()
            .map_err(|_| ManagedProcessPlatformError::ListenerInspectionFailed)?;
        if !output.status.success() {
            return Ok(false);
        }
        let text = String::from_utf8(output.stdout)
            .map_err(|_| ManagedProcessPlatformError::ListenerInspectionFailed)?;
        let owns = text.lines().any(|line| line == format!("p{}", process.pid))
            && text.lines().any(|line| line == format!("n{address}"));
        Ok(owns && inspect_process(process.pid)?.as_ref() == Some(process))
    }
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: i32) -> Result<(), ManagedProcessPlatformError> {
    let pid = i32::try_from(pid).map_err(|_| ManagedProcessPlatformError::SignalFailed)?;
    // SAFETY: kill is called with a validated positive PID and a fixed signal.
    if unsafe { libc::kill(pid, signal) } == 0 {
        Ok(())
    } else {
        Err(ManagedProcessPlatformError::SignalFailed)
    }
}

#[cfg(not(unix))]
fn send_signal(_pid: u32, _signal: i32) -> Result<(), ManagedProcessPlatformError> {
    Err(ManagedProcessPlatformError::SignalFailed)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn process_binary(pid: u32) -> Result<Option<PathBuf>, ManagedProcessPlatformError> {
    #[cfg(target_os = "linux")]
    {
        let path = PathBuf::from(format!("/proc/{pid}/exe"));
        return match fs::read_link(path) {
            Ok(path) => Ok(Some(path)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(ManagedProcessPlatformError::ObservationFailed),
        };
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStringExt;

        let pid = i32::try_from(pid).map_err(|_| ManagedProcessPlatformError::ObservationFailed)?;
        let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: path is a valid output buffer and the PID conversion succeeded.
        let length = unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if length <= 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::EINVAL)) {
                return Ok(None);
            }
            return Err(ManagedProcessPlatformError::ObservationFailed);
        }
        path.truncate(length as usize);
        Ok(Some(PathBuf::from(OsString::from_vec(path))))
    }
}

#[cfg(target_os = "linux")]
fn inspect_process(
    pid: u32,
) -> Result<Option<ManagedProcessObservation>, ManagedProcessPlatformError> {
    use std::os::unix::ffi::OsStringExt;

    let root = PathBuf::from(format!("/proc/{pid}"));
    let stat = match fs::read_to_string(root.join("stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ManagedProcessPlatformError::ObservationFailed),
    };
    let close = stat
        .rfind(')')
        .ok_or(ManagedProcessPlatformError::ObservationFailed)?;
    let started_at = stat[close + 1..]
        .split_whitespace()
        .nth(19)
        .and_then(|value| value.parse().ok())
        .ok_or(ManagedProcessPlatformError::ObservationFailed)?;
    let binary = fs::read_link(root.join("exe"))
        .map_err(|_| ManagedProcessPlatformError::ObservationFailed)?;
    let arguments = split_nul(
        fs::read(root.join("cmdline"))
            .map_err(|_| ManagedProcessPlatformError::ObservationFailed)?,
    );
    let environment = split_nul(
        fs::read(root.join("environ"))
            .map_err(|_| ManagedProcessPlatformError::ObservationFailed)?,
    );
    observation_from_parts(
        pid,
        started_at,
        binary,
        arguments.into_iter().map(OsString::from_vec).collect(),
        environment,
    )
    .map(Some)
}

#[cfg(target_os = "linux")]
fn list_process_ids() -> Result<Vec<u32>, ManagedProcessPlatformError> {
    let entries =
        fs::read_dir("/proc").map_err(|_| ManagedProcessPlatformError::ObservationFailed)?;
    Ok(entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
        .collect())
}

#[cfg(target_os = "macos")]
fn inspect_process(
    pid: u32,
) -> Result<Option<ManagedProcessObservation>, ManagedProcessPlatformError> {
    use std::os::unix::ffi::OsStringExt;

    let pid_i32 = i32::try_from(pid).map_err(|_| ManagedProcessPlatformError::ObservationFailed)?;
    let mut info = MacProcBsdInfo::default();
    // SAFETY: info is a writable repr(C) buffer of the exact requested flavor size.
    let read = unsafe {
        proc_pidinfo(
            pid_i32,
            3,
            0,
            std::ptr::from_mut(&mut info).cast(),
            std::mem::size_of::<MacProcBsdInfo>() as i32,
        )
    };
    if read == 0 {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::EINVAL)) {
            return Ok(None);
        }
        return Err(ManagedProcessPlatformError::ObservationFailed);
    }
    if read as usize != std::mem::size_of::<MacProcBsdInfo>() {
        return Err(ManagedProcessPlatformError::ObservationFailed);
    }
    let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: path is a valid output buffer and pid_i32 was validated above.
    let path_length = unsafe { proc_pidpath(pid_i32, path.as_mut_ptr().cast(), path.len() as u32) };
    if path_length <= 0 {
        return Err(ManagedProcessPlatformError::ObservationFailed);
    }
    path.truncate(path_length as usize);
    let binary = PathBuf::from(OsString::from_vec(path));
    let (arguments, environment) = macos_arguments(pid_i32)?;
    observation_from_parts(
        pid,
        info.pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
        binary,
        arguments.into_iter().map(OsString::from_vec).collect(),
        environment,
    )
    .map(Some)
}

#[cfg(target_os = "macos")]
fn list_process_ids() -> Result<Vec<u32>, ManagedProcessPlatformError> {
    // SAFETY: a null buffer requests the required byte count.
    let count = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(ManagedProcessPlatformError::ObservationFailed);
    }
    let mut pids = vec![0_i32; count as usize + 32];
    // SAFETY: pids is a writable buffer whose byte size is supplied exactly.
    let read = unsafe {
        proc_listallpids(
            pids.as_mut_ptr().cast(),
            (pids.len() * std::mem::size_of::<i32>()) as i32,
        )
    };
    if read < 0 {
        return Err(ManagedProcessPlatformError::ObservationFailed);
    }
    pids.truncate(read as usize);
    Ok(pids
        .into_iter()
        .filter_map(|pid| u32::try_from(pid).ok())
        .collect())
}

#[cfg(target_os = "macos")]
type ProcessArgumentsAndEnvironment = (Vec<Vec<u8>>, Vec<Vec<u8>>);

#[cfg(target_os = "macos")]
fn macos_arguments(
    pid: i32,
) -> Result<ProcessArgumentsAndEnvironment, ManagedProcessPlatformError> {
    let mut bytes = vec![0_u8; 1024 * 1024];
    let mut length = bytes.len();
    let mut mib = [libc::CTL_KERN, 49, pid];
    // SAFETY: mib and output buffer are valid for the documented KERN_PROCARGS2 query.
    let result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as u32,
            bytes.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length < std::mem::size_of::<i32>() {
        return Err(ManagedProcessPlatformError::ObservationFailed);
    }
    bytes.truncate(length);
    let argc = i32::from_ne_bytes(
        bytes[..4]
            .try_into()
            .map_err(|_| ManagedProcessPlatformError::ObservationFailed)?,
    );
    let argc = usize::try_from(argc).map_err(|_| ManagedProcessPlatformError::ObservationFailed)?;
    let mut cursor = 4;
    cursor = skip_c_string(&bytes, cursor)?;
    while cursor < bytes.len() && bytes[cursor] == 0 {
        cursor += 1;
    }
    let mut arguments = Vec::with_capacity(argc);
    for _ in 0..argc {
        let (value, next) = read_c_string(&bytes, cursor)?;
        arguments.push(value.to_vec());
        cursor = next;
    }
    let environment = split_nul(bytes[cursor..].to_vec());
    Ok((arguments, environment))
}

#[cfg(target_os = "macos")]
fn skip_c_string(bytes: &[u8], cursor: usize) -> Result<usize, ManagedProcessPlatformError> {
    read_c_string(bytes, cursor).map(|(_, next)| next)
}

#[cfg(target_os = "macos")]
fn read_c_string(
    bytes: &[u8],
    cursor: usize,
) -> Result<(&[u8], usize), ManagedProcessPlatformError> {
    let relative = bytes
        .get(cursor..)
        .ok_or(ManagedProcessPlatformError::ObservationFailed)?
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(ManagedProcessPlatformError::ObservationFailed)?;
    Ok((&bytes[cursor..cursor + relative], cursor + relative + 1))
}

fn split_nul(bytes: Vec<u8>) -> Vec<Vec<u8>> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(<[u8]>::to_vec)
        .collect()
}

#[cfg(unix)]
fn observation_from_parts(
    pid: u32,
    started_at: u64,
    binary: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<Vec<u8>>,
) -> Result<ManagedProcessObservation, ManagedProcessPlatformError> {
    use std::os::unix::ffi::OsStrExt;

    let mut config_directory = None;
    let mut config_file = None;
    let mut index = 1;
    while index + 1 < arguments.len() {
        match arguments[index].as_os_str().as_bytes() {
            b"-d" => config_directory = Some(PathBuf::from(&arguments[index + 1])),
            b"-f" => config_file = Some(PathBuf::from(&arguments[index + 1])),
            _ => {}
        }
        index += 2;
    }
    let prefix = format!("{MANAGED_CORE_TOKEN_ENV}=");
    let launch_token = environment
        .iter()
        .find_map(|entry| {
            entry
                .strip_prefix(prefix.as_bytes())
                .and_then(|value| String::from_utf8(value.to_vec()).ok())
        })
        .ok_or(ManagedProcessPlatformError::ObservationFailed)?;
    Ok(ManagedProcessObservation {
        binary,
        config_directory: config_directory.ok_or(ManagedProcessPlatformError::ObservationFailed)?,
        config_file: config_file.ok_or(ManagedProcessPlatformError::ObservationFailed)?,
        launch_token,
        pid,
        started_at,
    })
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default)]
struct MacProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [libc::c_char; 16],
    pbi_name: [libc::c_char; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut libc::c_void, size: i32) -> i32;
    fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
    fn proc_listallpids(buffer: *mut libc::c_void, size: i32) -> i32;
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn inspect_process(
    _pid: u32,
) -> Result<Option<ManagedProcessObservation>, ManagedProcessPlatformError> {
    Err(ManagedProcessPlatformError::ObservationFailed)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn list_process_ids() -> Result<Vec<u32>, ManagedProcessPlatformError> {
    Err(ManagedProcessPlatformError::ObservationFailed)
}
