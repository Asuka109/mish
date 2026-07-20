use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use futures_util::future::BoxFuture;
use mish_bridge::{
    PrivilegedCoreHost, PrivilegedCoreHostError, PrivilegedCoreLaunchRequest, PrivilegedCoreProcess,
};
use mish_runtime::{
    LoopbackProxyEndpoint, TUN_HELPER_EXPECTED_VERSION, TUN_HELPER_MAX_MESSAGE_BYTES,
    TUN_HELPER_PROTOCOL_VERSION, TunHelperAvailability, TunHelperError, TunHelperFailureKind,
    TunHelperHealth, TunHelperLifecycleOperation, TunHelperObservation, TunHelperPlatform,
    TunHelperSnapshot,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    process::{Child, Command},
    sync::Mutex,
    time::timeout,
};

pub const DEV_TUN_SERVICE_LABEL: &str = "com.asuka109.mish.tun-helper.dev";
pub const DEV_TUN_SERVICE_CORE_PATH: &str =
    "/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev";
pub const DEV_TUN_SERVICE_HELPER_PATH: &str =
    "/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev";
pub const DEV_TUN_SERVICE_PLIST_PATH: &str =
    "/Library/LaunchDaemons/com.asuka109.mish.tun-helper.dev.plist";
pub const DEV_TUN_SERVICE_SOCKET_PREFIX: &str = "/var/run/com.asuka109.mish.tun-helper";
const CONFIG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

pub fn development_socket_path(uid: u32) -> PathBuf {
    PathBuf::from(format!("{DEV_TUN_SERVICE_SOCKET_PREFIX}.{uid}.sock"))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceRequest {
    command: ServiceCommand,
    protocol_version: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum ServiceCommand {
    Health,
    Observe {
        launch_token: String,
    },
    OwnsListener {
        host: String,
        launch_token: String,
        port: u16,
    },
    Start {
        binary: PathBuf,
        config_directory: PathBuf,
        config_file: PathBuf,
        expected_version: String,
        launch_token: String,
    },
    Stop {
        launch_token: String,
    },
    StopAll,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceResponse {
    error: Option<ServiceErrorCode>,
    ok: bool,
    status: ServiceStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ServiceErrorCode {
    InvalidRequest,
    Rejected,
    OperationFailed,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceStatus {
    core: Option<ServiceCoreStatus>,
    helper_version: String,
    installation_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceCoreStatus {
    launch_token: String,
    pid: u32,
    tun_enabled: bool,
}

impl From<ServiceCoreStatus> for PrivilegedCoreProcess {
    fn from(status: ServiceCoreStatus) -> Self {
        Self::new(status.pid, status.launch_token, status.tun_enabled)
    }
}

#[derive(Clone, Debug)]
pub struct MacOsTunServiceClient {
    lifecycle: Option<DevelopmentTunLifecycle>,
    socket_path: PathBuf,
}

#[derive(Clone, Debug)]
struct DevelopmentTunLifecycle {
    repository_root: PathBuf,
    script_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevelopmentInstallerResult {
    kind: Option<TunHelperFailureKind>,
    ok: bool,
}

impl MacOsTunServiceClient {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            lifecycle: None,
            socket_path,
        }
    }

    pub fn development() -> Self {
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        Self::new(development_socket_path(uid))
    }

    pub fn development_with_lifecycle(repository_root: PathBuf) -> Self {
        let mut client = Self::development();
        client.lifecycle = Some(DevelopmentTunLifecycle {
            script_path: repository_root.join("scripts/manage-macos-tun-service.ts"),
            repository_root,
        });
        client
    }

    async fn request(&self, command: ServiceCommand) -> Result<ServiceStatus, ServiceClientError> {
        let request = ServiceRequest {
            command,
            protocol_version: TUN_HELPER_PROTOCOL_VERSION,
        };
        let bytes = serde_json::to_vec(&request).map_err(|_| ServiceClientError::Protocol)?;
        if bytes.len() > TUN_HELPER_MAX_MESSAGE_BYTES {
            return Err(ServiceClientError::Protocol);
        }
        let operation = async {
            let mut stream = UnixStream::connect(&self.socket_path)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            stream
                .write_u32(bytes.len() as u32)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            stream
                .write_all(&bytes)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            let length = stream
                .read_u32()
                .await
                .map_err(|_| ServiceClientError::Unavailable)? as usize;
            if length > TUN_HELPER_MAX_MESSAGE_BYTES {
                return Err(ServiceClientError::Protocol);
            }
            let mut response = vec![0; length];
            stream
                .read_exact(&mut response)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            let response: ServiceResponse =
                serde_json::from_slice(&response).map_err(|_| ServiceClientError::Protocol)?;
            if !response.ok {
                return Err(match response.error {
                    Some(ServiceErrorCode::Rejected | ServiceErrorCode::InvalidRequest) => {
                        ServiceClientError::Rejected
                    }
                    Some(ServiceErrorCode::OperationFailed) | None => {
                        ServiceClientError::OperationFailed
                    }
                });
            }
            Ok(response.status)
        };
        timeout(REQUEST_TIMEOUT, operation)
            .await
            .map_err(|_| ServiceClientError::Unavailable)?
    }

    async fn health(&self) -> Result<ServiceStatus, ServiceClientError> {
        self.request(ServiceCommand::Health).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceClientError {
    Unavailable,
    Protocol,
    Rejected,
    OperationFailed,
}

fn map_host_error(error: ServiceClientError) -> PrivilegedCoreHostError {
    match error {
        ServiceClientError::Unavailable | ServiceClientError::Protocol => {
            PrivilegedCoreHostError::Unavailable
        }
        ServiceClientError::Rejected => PrivilegedCoreHostError::Rejected,
        ServiceClientError::OperationFailed => PrivilegedCoreHostError::OperationFailed,
    }
}

impl PrivilegedCoreHost for MacOsTunServiceClient {
    fn start(
        &self,
        request: PrivilegedCoreLaunchRequest,
    ) -> BoxFuture<'_, Result<PrivilegedCoreProcess, PrivilegedCoreHostError>> {
        Box::pin(async move {
            let status = self
                .request(ServiceCommand::Start {
                    binary: request.binary().to_path_buf(),
                    config_directory: request.config_directory().to_path_buf(),
                    config_file: request.config_file().to_path_buf(),
                    expected_version: request.expected_version().to_owned(),
                    launch_token: request.launch_token().to_owned(),
                })
                .await
                .map_err(map_host_error)?;
            status
                .core
                .map(Into::into)
                .ok_or(PrivilegedCoreHostError::OperationFailed)
        })
    }

    fn observe(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<Option<PrivilegedCoreProcess>, PrivilegedCoreHostError>> {
        Box::pin(async move {
            let status = self
                .request(ServiceCommand::Observe {
                    launch_token: process.launch_token().to_owned(),
                })
                .await
                .map_err(map_host_error)?;
            Ok(status.core.map(Into::into))
        })
    }

    fn stop(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<(), PrivilegedCoreHostError>> {
        Box::pin(async move {
            self.request(ServiceCommand::Stop {
                launch_token: process.launch_token().to_owned(),
            })
            .await
            .map(|_| ())
            .map_err(map_host_error)
        })
    }

    fn owns_listener(
        &self,
        process: PrivilegedCoreProcess,
        endpoint: LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<bool, PrivilegedCoreHostError>> {
        Box::pin(async move {
            let status = self
                .request(ServiceCommand::OwnsListener {
                    host: endpoint.host().to_string(),
                    launch_token: process.launch_token().to_owned(),
                    port: endpoint.port(),
                })
                .await
                .map_err(map_host_error)?;
            Ok(status.core.is_some())
        })
    }
}

impl TunHelperPlatform for MacOsTunServiceClient {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
        TunHelperSnapshot::unavailable(
            TunHelperAvailability::PermissionRequired,
            TunHelperHealth::NotInstalled,
            TunHelperFailureKind::PermissionDenied,
        )
    }

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>> {
        Box::pin(async move {
            match self.health().await {
                Ok(status) => Ok(TunHelperObservation::healthy_installation(
                    status.helper_version,
                    status.installation_id,
                )),
                Err(ServiceClientError::Unavailable) => Ok(TunHelperObservation::not_installed()),
                Err(_) => Err(TunHelperError::new(
                    TunHelperFailureKind::ProtocolMismatch,
                    "The development TUN service returned an invalid response",
                )),
            }
        })
    }

    fn run_lifecycle(
        &self,
        operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async move {
            let lifecycle = self.lifecycle.as_ref().ok_or_else(|| {
                TunHelperError::new(
                    TunHelperFailureKind::RegistrationRequiresApproval,
                    "The development helper installer requires explicit application wiring",
                )
            })?;
            let repository_root = lifecycle.repository_root.canonicalize().map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development helper repository root is unavailable",
                )
            })?;
            let script_metadata = fs::symlink_metadata(&lifecycle.script_path).map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development helper installer is unavailable",
                )
            })?;
            // SAFETY: getuid has no preconditions and only returns the real user ID.
            let current_uid = unsafe { libc::getuid() };
            if script_metadata.file_type().is_symlink()
                || !script_metadata.is_file()
                || script_metadata.uid() != current_uid
                || script_metadata.permissions().mode() & 0o022 != 0
            {
                return Err(TunHelperError::new(
                    TunHelperFailureKind::IdentityRejected,
                    "The development helper installer metadata was rejected",
                ));
            }
            let script_path = lifecycle.script_path.canonicalize().map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development helper installer is unavailable",
                )
            })?;
            if !script_path.starts_with(&repository_root)
                || script_path.file_name().and_then(|name| name.to_str())
                    != Some("manage-macos-tun-service.ts")
            {
                return Err(TunHelperError::new(
                    TunHelperFailureKind::IdentityRejected,
                    "The development helper installer identity was rejected",
                ));
            }
            let action = match operation {
                TunHelperLifecycleOperation::Install => "install",
                TunHelperLifecycleOperation::Repair => "repair",
                TunHelperLifecycleOperation::Remove => "uninstall",
            };
            let node = development_node_executable(current_uid).ok_or_else(|| {
                TunHelperError::new(
                    TunHelperFailureKind::InstallerUnavailable,
                    "The development helper installer could not locate a trusted Node executable",
                )
            })?;
            let output = Command::new(node)
                .arg(script_path)
                .arg(action)
                .current_dir(repository_root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .await
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::InstallerUnavailable,
                        "The development helper installer could not start",
                    )
                })?;
            let result = serde_json::from_slice::<DevelopmentInstallerResult>(&output.stdout)
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::InstallerUnavailable,
                        "The development helper installer did not return a valid result",
                    )
                })?;
            if !output.status.success() || !result.ok {
                return Err(TunHelperError::new(
                    result
                        .kind
                        .unwrap_or(TunHelperFailureKind::InstallerUnavailable),
                    "The development helper installer reported a bounded lifecycle failure",
                ));
            }
            Ok(())
        })
    }

    fn observe_tun(&self) -> BoxFuture<'_, Result<bool, TunHelperError>> {
        Box::pin(async move {
            self.health()
                .await
                .map(|status| status.core.is_some_and(|core| core.tun_enabled))
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::ConnectionFailed,
                        "The development TUN service could not be reached",
                    )
                })
        })
    }

    fn set_tun_enabled(&self, enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async move {
            let status = if enabled {
                self.health().await
            } else {
                self.request(ServiceCommand::StopAll).await
            }
            .map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development TUN service operation failed",
                )
            })?;
            if enabled && !status.core.is_some_and(|core| core.tun_enabled) {
                return Err(TunHelperError::new(
                    TunHelperFailureKind::ConfirmationFailed,
                    "The privileged Mihomo Core did not enable TUN",
                ));
            }
            Ok(())
        })
    }
}

fn development_node_executable(current_uid: u32) -> Option<PathBuf> {
    let mut candidates = std::env::var_os("npm_node_execpath")
        .map(PathBuf::from)
        .into_iter()
        .chain(
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
                .map(|directory| directory.join("node")),
        )
        .chain([
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
        ]);
    candidates.find_map(|candidate| {
        if !candidate.is_absolute() {
            return None;
        }
        let metadata = fs::symlink_metadata(&candidate).ok()?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || (metadata.uid() != 0 && metadata.uid() != current_uid)
            || metadata.permissions().mode() & 0o022 != 0
        {
            return None;
        }
        candidate.canonicalize().ok()
    })
}

pub struct TunServiceConfig {
    pub allowed_binary: PathBuf,
    pub allowed_uid: u32,
    pub installation_id: String,
    pub require_root: bool,
    pub runtime_root: PathBuf,
    pub socket_path: PathBuf,
}

impl TunServiceConfig {
    pub fn from_environment() -> Result<Self, &'static str> {
        let allowed_uid = std::env::var("MISH_TUN_SERVICE_ALLOWED_UID")
            .map_err(|_| "missing allowed UID")?
            .parse()
            .map_err(|_| "invalid allowed UID")?;
        let installation_id = std::env::var("MISH_TUN_SERVICE_INSTALLATION_ID")
            .map_err(|_| "missing installation ID")?;
        if !valid_installation_id(&installation_id) {
            return Err("invalid installation ID");
        }
        Ok(Self {
            allowed_binary: required_path("MISH_TUN_SERVICE_CORE_BINARY")?,
            allowed_uid,
            installation_id,
            require_root: true,
            runtime_root: required_path("MISH_TUN_SERVICE_RUNTIME_ROOT")?,
            socket_path: required_path("MISH_TUN_SERVICE_SOCKET")?,
        })
    }
}

fn required_path(name: &str) -> Result<PathBuf, &'static str> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("missing or invalid service path")
}

struct ServiceProcess {
    child: Child,
    launch_token: String,
    pid: u32,
    tun_enabled: bool,
}

#[derive(Default)]
struct ServiceState {
    process: Option<ServiceProcess>,
}

pub async fn run_tun_service(config: TunServiceConfig) -> Result<(), &'static str> {
    if config.require_root {
        // SAFETY: geteuid has no preconditions and only returns the effective user ID.
        if unsafe { libc::geteuid() } != 0 {
            return Err("the TUN service must run as root");
        }
    }
    let allowed_binary = validate_regular_file(
        &config.allowed_binary,
        config.allowed_uid,
        config.require_root,
    )?;
    let runtime_root = validate_runtime_root(&config.runtime_root, config.allowed_uid)?;
    if let Ok(metadata) = fs::symlink_metadata(&config.socket_path) {
        if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
            return Err("the service socket path is unsafe");
        }
        fs::remove_file(&config.socket_path)
            .map_err(|_| "the stale socket could not be removed")?;
    }
    let listener = UnixListener::bind(&config.socket_path).map_err(|_| "socket bind failed")?;
    fs::set_permissions(&config.socket_path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "socket permissions failed")?;
    // SAFETY: the socket path is a live path owned by this process and the CString is terminated.
    let socket = std::ffi::CString::new(config.socket_path.as_os_str().as_encoded_bytes())
        .map_err(|_| "socket path was invalid")?;
    if unsafe { libc::chown(socket.as_ptr(), config.allowed_uid, u32::MAX) } != 0 {
        return Err("socket ownership failed");
    }
    let state = Arc::new(Mutex::new(ServiceState::default()));
    let installation_id: Arc<str> = config.installation_id.into();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| "termination handler failed")?;
    loop {
        #[cfg(unix)]
        let accepted = tokio::select! {
            accepted = listener.accept() => Some(accepted),
            _ = terminate.recv() => None,
        };
        #[cfg(not(unix))]
        let accepted = Some(listener.accept().await);
        let Some(accepted) = accepted else {
            break;
        };
        let (stream, _) = accepted.map_err(|_| "socket accept failed")?;
        if peer_uid(&stream)? != config.allowed_uid {
            continue;
        }
        let state = state.clone();
        let allowed_binary = allowed_binary.clone();
        let runtime_root = runtime_root.clone();
        let installation_id = installation_id.clone();
        let allowed_uid = config.allowed_uid;
        tokio::spawn(async move {
            let _ = handle_connection(
                stream,
                state,
                allowed_uid,
                &allowed_binary,
                &runtime_root,
                &installation_id,
            )
            .await;
        });
    }
    let mut state = state.lock().await;
    stop_process(&mut state)
        .await
        .map_err(|_| "managed Core cleanup failed")?;
    drop(state);
    fs::remove_file(&config.socket_path).map_err(|_| "socket cleanup failed")?;
    Ok(())
}

async fn handle_connection(
    mut stream: UnixStream,
    state: Arc<Mutex<ServiceState>>,
    allowed_uid: u32,
    allowed_binary: &Path,
    runtime_root: &Path,
    installation_id: &str,
) -> Result<(), ()> {
    let length = stream.read_u32().await.map_err(|_| ())? as usize;
    if length > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await.map_err(|_| ())?;
    let response = match serde_json::from_slice::<ServiceRequest>(&bytes) {
        Ok(request) if request.protocol_version == TUN_HELPER_PROTOCOL_VERSION => {
            execute_request(
                request.command,
                state,
                allowed_uid,
                allowed_binary,
                runtime_root,
                installation_id,
            )
            .await
        }
        _ => ServiceResponse::error(ServiceErrorCode::InvalidRequest, None, installation_id),
    };
    let bytes = serde_json::to_vec(&response).map_err(|_| ())?;
    if bytes.len() > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(());
    }
    stream.write_u32(bytes.len() as u32).await.map_err(|_| ())?;
    stream.write_all(&bytes).await.map_err(|_| ())
}

async fn execute_request(
    command: ServiceCommand,
    state: Arc<Mutex<ServiceState>>,
    allowed_uid: u32,
    allowed_binary: &Path,
    runtime_root: &Path,
    installation_id: &str,
) -> ServiceResponse {
    match command {
        ServiceCommand::Health => status_response(&state, installation_id).await,
        ServiceCommand::Observe { launch_token } => {
            let status = status_response(&state, installation_id).await;
            if status
                .status
                .core
                .as_ref()
                .is_some_and(|core| core.launch_token == launch_token)
            {
                status
            } else {
                ServiceResponse::ok(None, installation_id)
            }
        }
        ServiceCommand::OwnsListener {
            host,
            launch_token,
            port,
        } => {
            let status = status_response(&state, installation_id).await;
            let owns = status.status.core.as_ref().is_some_and(|core| {
                core.launch_token == launch_token
                    && owns_listener(core.pid, &host, port).unwrap_or(false)
            });
            if owns {
                status
            } else {
                ServiceResponse::ok(None, installation_id)
            }
        }
        ServiceCommand::Start {
            binary,
            config_directory,
            config_file,
            expected_version,
            launch_token,
        } => {
            if !valid_token(&launch_token)
                || !valid_version(&expected_version)
                || validate_launch_paths(
                    &binary,
                    &config_directory,
                    &config_file,
                    allowed_binary,
                    runtime_root,
                    allowed_uid,
                )
                .is_err()
            {
                return ServiceResponse::error(ServiceErrorCode::Rejected, None, installation_id);
            }
            let tun_enabled = match read_tun_enabled(&config_file) {
                Ok(enabled) => enabled,
                Err(_) => {
                    return ServiceResponse::error(
                        ServiceErrorCode::Rejected,
                        None,
                        installation_id,
                    );
                }
            };
            if verify_core_version(&binary, &expected_version)
                .await
                .is_err()
            {
                return ServiceResponse::error(ServiceErrorCode::Rejected, None, installation_id);
            }
            let mut state = state.lock().await;
            reap_if_exited(&mut state);
            if state.process.is_some() {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    state.status(),
                    installation_id,
                );
            }
            let child = Command::new(&binary)
                .arg("-d")
                .arg(&config_directory)
                .arg("-f")
                .arg(&config_file)
                .env("MISH_MANAGED_CORE_TOKEN", &launch_token)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            let mut child = match child {
                Ok(child) => child,
                Err(_) => {
                    return ServiceResponse::error(
                        ServiceErrorCode::OperationFailed,
                        None,
                        installation_id,
                    );
                }
            };
            let Some(pid) = child.id() else {
                let _ = child.start_kill();
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    None,
                    installation_id,
                );
            };
            tokio::time::sleep(Duration::from_millis(150)).await;
            if !matches!(child.try_wait(), Ok(None)) {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    None,
                    installation_id,
                );
            }
            state.process = Some(ServiceProcess {
                child,
                launch_token,
                pid,
                tun_enabled,
            });
            ServiceResponse::ok(state.status(), installation_id)
        }
        ServiceCommand::Stop { launch_token } => {
            let mut state = state.lock().await;
            reap_if_exited(&mut state);
            if state
                .process
                .as_ref()
                .is_some_and(|process| process.launch_token != launch_token)
            {
                return ServiceResponse::error(
                    ServiceErrorCode::Rejected,
                    state.status(),
                    installation_id,
                );
            }
            if stop_process(&mut state).await.is_err() {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    state.status(),
                    installation_id,
                );
            }
            ServiceResponse::ok(None, installation_id)
        }
        ServiceCommand::StopAll => {
            let mut state = state.lock().await;
            if stop_process(&mut state).await.is_err() {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    state.status(),
                    installation_id,
                );
            }
            ServiceResponse::ok(None, installation_id)
        }
    }
}

impl ServiceState {
    fn status(&self) -> Option<ServiceCoreStatus> {
        self.process.as_ref().map(|process| ServiceCoreStatus {
            launch_token: process.launch_token.clone(),
            pid: process.pid,
            tun_enabled: process.tun_enabled,
        })
    }
}

impl ServiceResponse {
    fn ok(core: Option<ServiceCoreStatus>, installation_id: &str) -> Self {
        Self {
            error: None,
            ok: true,
            status: ServiceStatus {
                core,
                helper_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                installation_id: installation_id.to_owned(),
            },
        }
    }

    fn error(
        error: ServiceErrorCode,
        core: Option<ServiceCoreStatus>,
        installation_id: &str,
    ) -> Self {
        Self {
            error: Some(error),
            ok: false,
            status: ServiceStatus {
                core,
                helper_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                installation_id: installation_id.to_owned(),
            },
        }
    }
}

async fn status_response(state: &Mutex<ServiceState>, installation_id: &str) -> ServiceResponse {
    let mut state = state.lock().await;
    reap_if_exited(&mut state);
    ServiceResponse::ok(state.status(), installation_id)
}

fn reap_if_exited(state: &mut ServiceState) {
    if state
        .process
        .as_mut()
        .is_some_and(|process| !matches!(process.child.try_wait(), Ok(None)))
    {
        state.process = None;
    }
}

async fn stop_process(state: &mut ServiceState) -> Result<(), ()> {
    let Some(mut process) = state.process.take() else {
        return Ok(());
    };
    // SAFETY: kill receives a positive PID returned for the child owned by this service.
    let _ = unsafe { libc::kill(process.pid as i32, libc::SIGTERM) };
    if !matches!(timeout(STOP_TIMEOUT, process.child.wait()).await, Ok(Ok(_))) {
        process.child.start_kill().map_err(|_| ())?;
        process.child.wait().await.map_err(|_| ())?;
    }
    Ok(())
}

fn validate_regular_file(
    path: &Path,
    allowed_uid: u32,
    root_only: bool,
) -> Result<PathBuf, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "allowed binary is unavailable")?;
    let owner = metadata.uid();
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || (root_only && owner != 0)
        || (!root_only && owner != 0 && owner != allowed_uid)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err("allowed binary metadata is unsafe");
    }
    path.canonicalize().map_err(|_| "allowed binary is invalid")
}

fn validate_runtime_root(path: &Path, allowed_uid: u32) -> Result<PathBuf, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "runtime root is unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != allowed_uid
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("runtime root metadata is unsafe");
    }
    path.canonicalize().map_err(|_| "runtime root is invalid")
}

fn validate_launch_paths(
    binary: &Path,
    config_directory: &Path,
    config_file: &Path,
    allowed_binary: &Path,
    runtime_root: &Path,
    allowed_uid: u32,
) -> Result<(), ()> {
    if validate_regular_file(binary, allowed_uid, false).map_err(|_| ())? != allowed_binary {
        return Err(());
    }
    let directory = validate_owned_private_path(config_directory, allowed_uid, true)?;
    let file = validate_owned_private_path(config_file, allowed_uid, false)?;
    let candidates = runtime_root.join("candidates");
    let candidate = directory.parent().ok_or(())?;
    if directory.file_name().and_then(|name| name.to_str()) != Some("home")
        || candidate.parent() != Some(candidates.as_path())
        || file != candidate.join("config.yaml")
        || candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| uuid::Uuid::parse_str(name).is_err())
    {
        return Err(());
    }
    Ok(())
}

fn validate_owned_private_path(path: &Path, uid: u32, directory: bool) -> Result<PathBuf, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.permissions().mode() & 0o077 != 0
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.len() > CONFIG_MAX_BYTES))
    {
        return Err(());
    }
    path.canonicalize().map_err(|_| ())
}

fn read_tun_enabled(path: &Path) -> Result<bool, ()> {
    let bytes = fs::read(path).map_err(|_| ())?;
    if bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err(());
    }
    let value: serde_norway::Value = serde_norway::from_slice(&bytes).map_err(|_| ())?;
    Ok(value
        .get("tun")
        .and_then(|tun| tun.get("enable"))
        .and_then(serde_norway::Value::as_bool)
        .unwrap_or(false))
}

async fn verify_core_version(binary: &Path, expected: &str) -> Result<(), ()> {
    let output = timeout(REQUEST_TIMEOUT, Command::new(binary).arg("-v").output())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let reported = String::from_utf8(output.stdout).map_err(|_| ())?;
    if output.status.success()
        && reported.split_whitespace().any(|part| {
            part.trim_matches(|value: char| !value.is_ascii_alphanumeric() && value != '.')
                == expected
        })
    {
        Ok(())
    } else {
        Err(())
    }
}

fn valid_token(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_installation_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn owns_listener(pid: u32, host: &str, port: u16) -> Result<bool, ()> {
    if host != "127.0.0.1" {
        return Ok(false);
    }
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args([
            "-nP".to_owned(),
            "-a".to_owned(),
            "-p".to_owned(),
            pid.to_string(),
            format!("-iTCP@{host}:{port}"),
            "-sTCP:LISTEN".to_owned(),
            "-Fpn".to_owned(),
        ])
        .output()
        .map_err(|_| ())?;
    if !output.status.success() {
        return Ok(false);
    }
    let text = String::from_utf8(output.stdout).map_err(|_| ())?;
    Ok(text.lines().any(|line| line == format!("p{pid}"))
        && text.lines().any(|line| line == format!("n{host}:{port}")))
}

#[cfg(target_os = "macos")]
fn peer_uid(stream: &UnixStream) -> Result<u32, &'static str> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: the pointers are valid for writes and the socket descriptor is live.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err("peer identity inspection failed");
    }
    Ok(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> Result<u32, &'static str> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the output buffer and its length are valid for the SO_PEERCRED query.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut _ as *mut libc::c_void,
            &mut length,
        )
    } != 0
    {
        return Err("peer identity inspection failed");
    }
    Ok(credentials.uid)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_uid(_stream: &UnixStream) -> Result<u32, &'static str> {
    Err("peer identity inspection is unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn write_fixture_binary(root: &Path) -> PathBuf {
        let binary = root.join("mihomo-fixture");
        fs::write(
            &binary,
            "#!/bin/sh\nif [ \"$1\" = \"-v\" ]; then echo 'Mihomo Meta v1.19.29'; exit 0; fi\nexec sleep 30\n",
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        binary
    }

    async fn fixture() -> (
        tempfile::TempDir,
        MacOsTunServiceClient,
        PathBuf,
        PathBuf,
        PathBuf,
        tokio::task::JoinHandle<Result<(), &'static str>>,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let binary = write_fixture_binary(temporary.path());
        let runtime_root = temporary.path().join("runtime");
        let candidate = runtime_root
            .join("candidates")
            .join("11111111-1111-4111-8111-111111111111");
        let home = candidate.join("home");
        fs::create_dir_all(&home).unwrap();
        fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(
            runtime_root.join("candidates"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let config_file = candidate.join("config.yaml");
        fs::write(&config_file, "tun:\n  enable: true\n").unwrap();
        fs::set_permissions(&config_file, fs::Permissions::from_mode(0o600)).unwrap();
        let socket_path = temporary.path().join("helper.sock");
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        let installation_id = "a".repeat(64);
        let server = tokio::spawn(run_tun_service(TunServiceConfig {
            allowed_binary: binary.clone(),
            allowed_uid: uid,
            installation_id,
            require_root: false,
            runtime_root,
            socket_path: socket_path.clone(),
        }));
        for _ in 0..100 {
            if socket_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        (
            temporary,
            MacOsTunServiceClient::new(socket_path),
            binary,
            home,
            config_file,
            server,
        )
    }

    #[tokio::test]
    async fn development_service_hosts_and_observes_a_tun_core() {
        let (_temporary, client, binary, home, config_file, server) = fixture().await;
        assert_eq!(
            client.health().await.unwrap().helper_version,
            TUN_HELPER_EXPECTED_VERSION
        );
        assert_eq!(
            client.health().await.unwrap().installation_id,
            "a".repeat(64)
        );
        let request = PrivilegedCoreLaunchRequest::new(binary, home, config_file, "v1.19.29");
        let process = client.start(request).await.unwrap();
        assert!(process.tun_enabled());
        assert_eq!(
            client.observe(process.clone()).await.unwrap(),
            Some(process.clone())
        );
        assert!(client.observe_tun().await.unwrap());
        client.stop(process).await.unwrap();
        assert!(!client.observe_tun().await.unwrap());
        server.abort();
    }

    #[tokio::test]
    async fn development_service_rejects_configuration_outside_the_runtime_root() {
        let (temporary, client, binary, home, _config_file, server) = fixture().await;
        let outside = temporary.path().join("outside.yaml");
        fs::write(&outside, "tun:\n  enable: true\n").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
        let request = PrivilegedCoreLaunchRequest::new(binary, home, outside, "v1.19.29");
        assert_eq!(
            client.start(request).await,
            Err(PrivilegedCoreHostError::Rejected)
        );
        server.abort();
    }

    #[tokio::test]
    async fn development_lifecycle_invokes_only_the_bounded_installer_actions() {
        let repository = tempfile::tempdir().unwrap();
        let scripts = repository.path().join("scripts");
        fs::create_dir(&scripts).unwrap();
        let installer = scripts.join("manage-macos-tun-service.ts");
        fs::write(
            &installer,
            "import { writeFileSync } from 'node:fs';\nwriteFileSync('observed-action.txt', process.argv[2]);\nprocess.stdout.write(JSON.stringify({ ok: true }));\n",
        )
        .unwrap();
        fs::set_permissions(&installer, fs::Permissions::from_mode(0o644)).unwrap();
        let client = MacOsTunServiceClient {
            lifecycle: Some(DevelopmentTunLifecycle {
                repository_root: repository.path().to_path_buf(),
                script_path: installer,
            }),
            socket_path: repository.path().join("unused.sock"),
        };

        for (operation, expected) in [
            (TunHelperLifecycleOperation::Install, "install"),
            (TunHelperLifecycleOperation::Repair, "repair"),
            (TunHelperLifecycleOperation::Remove, "uninstall"),
        ] {
            client.run_lifecycle(operation).await.unwrap();
            assert_eq!(
                fs::read_to_string(repository.path().join("observed-action.txt")).unwrap(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn development_lifecycle_preserves_the_installer_failure_kind() {
        let repository = tempfile::tempdir().unwrap();
        let scripts = repository.path().join("scripts");
        fs::create_dir(&scripts).unwrap();
        let installer = scripts.join("manage-macos-tun-service.ts");
        fs::write(
            &installer,
            "process.stdout.write(JSON.stringify({ ok: false, kind: 'preparation-failed' }));\nprocess.exitCode = 1;\n",
        )
        .unwrap();
        fs::set_permissions(&installer, fs::Permissions::from_mode(0o644)).unwrap();
        let client = MacOsTunServiceClient {
            lifecycle: Some(DevelopmentTunLifecycle {
                repository_root: repository.path().to_path_buf(),
                script_path: installer,
            }),
            socket_path: repository.path().join("unused.sock"),
        };

        let error = client
            .run_lifecycle(TunHelperLifecycleOperation::Install)
            .await
            .unwrap_err();

        assert_eq!(error.kind, TunHelperFailureKind::PreparationFailed);
    }
}
