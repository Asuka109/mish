use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use futures_util::future::BoxFuture;
use tokio::{
    process::{Child, Command},
    sync::Mutex,
    time::timeout,
};

use mish_runtime::{CoreError, CorePhase, CoreRuntime, CoreStatus, CoreStatusEventSink};
use thiserror::Error;
use uuid::Uuid;

use crate::{MANAGED_CORE_TOKEN_ENV, ManagedCoreLaunch, ManagedCoreOwnership, ManagedCoreProcess};

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ManagedProcessValidationError {
    #[error("Mihomo validation requires managed configuration")]
    NotConfigured,
    #[error("unable to execute the managed Mihomo version check")]
    VersionCheckFailed,
    #[error("managed Mihomo version does not match the pinned version")]
    VersionMismatch,
    #[error("Mihomo configuration validation timed out")]
    Timeout,
    #[error("unable to validate the managed Mihomo configuration")]
    ExecutionFailed,
    #[error("Mihomo rejected the managed runtime configuration")]
    ConfigurationRejected,
}

#[derive(Clone)]
pub struct DesktopMihomoProcessConfig {
    pub binary: Option<PathBuf>,
    pub config_directory: Option<PathBuf>,
    pub config_file: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivilegedCoreLaunchRequest {
    binary: PathBuf,
    config_directory: PathBuf,
    config_file: PathBuf,
    expected_version: String,
    launch_token: String,
}

impl PrivilegedCoreLaunchRequest {
    pub fn new(
        binary: PathBuf,
        config_directory: PathBuf,
        config_file: PathBuf,
        expected_version: impl Into<String>,
    ) -> Self {
        Self {
            binary,
            config_directory,
            config_file,
            expected_version: expected_version.into(),
            launch_token: Uuid::new_v4().to_string(),
        }
    }

    pub fn binary(&self) -> &std::path::Path {
        &self.binary
    }

    pub fn config_directory(&self) -> &std::path::Path {
        &self.config_directory
    }

    pub fn config_file(&self) -> &std::path::Path {
        &self.config_file
    }

    pub fn expected_version(&self) -> &str {
        &self.expected_version
    }

    pub fn launch_token(&self) -> &str {
        &self.launch_token
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivilegedCoreProcess {
    launch_token: String,
    pid: u32,
    tun_enabled: bool,
}

impl PrivilegedCoreProcess {
    pub fn new(pid: u32, launch_token: impl Into<String>, tun_enabled: bool) -> Self {
        Self {
            launch_token: launch_token.into(),
            pid,
            tun_enabled,
        }
    }

    pub fn launch_token(&self) -> &str {
        &self.launch_token
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn tun_enabled(&self) -> bool {
        self.tun_enabled
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum PrivilegedCoreHostError {
    #[error("the privileged Core host is unavailable")]
    Unavailable,
    #[error("the privileged Core host rejected the launch request")]
    Rejected,
    #[error("the privileged Core host operation failed")]
    OperationFailed,
}

pub trait PrivilegedCoreHost: Send + Sync {
    fn start(
        &self,
        request: PrivilegedCoreLaunchRequest,
    ) -> BoxFuture<'_, Result<PrivilegedCoreProcess, PrivilegedCoreHostError>>;

    fn observe(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<Option<PrivilegedCoreProcess>, PrivilegedCoreHostError>>;

    fn stop(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<(), PrivilegedCoreHostError>>;

    fn owns_listener(
        &self,
        process: PrivilegedCoreProcess,
        endpoint: mish_runtime::LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<bool, PrivilegedCoreHostError>>;
}

impl std::fmt::Debug for DesktopMihomoProcessConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DesktopMihomoProcessConfig")
            .field("binary", &self.binary.as_ref().map(|_| "[redacted]"))
            .field(
                "config_directory",
                &self.config_directory.as_ref().map(|_| "[redacted]"),
            )
            .field(
                "config_file",
                &self.config_file.as_ref().map(|_| "[redacted]"),
            )
            .finish()
    }
}

struct Inner {
    child: Option<Child>,
    generation: u64,
    owned_process: Option<ManagedCoreProcess>,
    privileged_process: Option<PrivilegedCoreProcess>,
    status: CoreStatus,
}

#[derive(Clone)]
pub struct DesktopMihomoProcess {
    config: DesktopMihomoProcessConfig,
    expected_version: Option<&'static str>,
    inner: Arc<Mutex<Inner>>,
    ownership: Option<Arc<ManagedCoreOwnership>>,
    privileged_host: Option<Arc<dyn PrivilegedCoreHost>>,
    status_events: Arc<OnceLock<CoreStatusEventSink>>,
}

impl DesktopMihomoProcess {
    pub fn new(config: DesktopMihomoProcessConfig) -> Self {
        Self::with_expected_version(config, None)
    }

    pub fn new_pinned(config: DesktopMihomoProcessConfig, expected_version: &'static str) -> Self {
        Self::with_expected_version(config, Some(expected_version))
    }

    fn with_expected_version(
        config: DesktopMihomoProcessConfig,
        expected_version: Option<&'static str>,
    ) -> Self {
        Self::with_execution_backend(config, expected_version, None, None)
    }

    pub fn new_pinned_owned(
        config: DesktopMihomoProcessConfig,
        expected_version: &'static str,
        ownership: Arc<ManagedCoreOwnership>,
    ) -> Self {
        Self::with_execution_backend(config, Some(expected_version), Some(ownership), None)
    }

    pub fn new_pinned_privileged(
        config: DesktopMihomoProcessConfig,
        expected_version: &'static str,
        host: Arc<dyn PrivilegedCoreHost>,
    ) -> Self {
        Self::with_execution_backend(config, Some(expected_version), None, Some(host))
    }

    fn with_execution_backend(
        config: DesktopMihomoProcessConfig,
        expected_version: Option<&'static str>,
        ownership: Option<Arc<ManagedCoreOwnership>>,
        privileged_host: Option<Arc<dyn PrivilegedCoreHost>>,
    ) -> Self {
        Self {
            config,
            expected_version,
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                generation: 0,
                owned_process: None,
                privileged_process: None,
                status: CoreStatus {
                    error: None,
                    phase: CorePhase::Stopped,
                    pid: None,
                    version: None,
                },
            })),
            ownership,
            privileged_host,
            status_events: Arc::new(OnceLock::new()),
        }
    }

    pub async fn validate_config(
        &self,
        deadline: Duration,
    ) -> Result<(), ManagedProcessValidationError> {
        if !self.configured() {
            return Err(ManagedProcessValidationError::NotConfigured);
        }
        self.checked_version(deadline).await?;
        let mut command = self.command();
        command
            .arg("-t")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        match timeout(deadline, command.status()).await {
            Err(_) => Err(ManagedProcessValidationError::Timeout),
            Ok(Err(_)) => Err(ManagedProcessValidationError::ExecutionFailed),
            Ok(Ok(status)) if !status.success() => {
                Err(ManagedProcessValidationError::ConfigurationRejected)
            }
            Ok(Ok(_)) => Ok(()),
        }
    }

    pub fn configured(&self) -> bool {
        self.config.binary.is_some()
            && (self.config.config_directory.is_some() || self.config.config_file.is_some())
    }

    pub async fn status(&self) -> CoreStatus {
        let mut inner = self.inner.lock().await;
        let update = inspect_child(&mut inner);
        let owned_process = if update.is_some() && inner.child.is_none() {
            inner.owned_process.take()
        } else {
            None
        };
        let privileged_process = inner.privileged_process.clone();
        let status = inner.status.clone();
        drop(inner);
        let _ = self.clear_owned_process(owned_process.as_ref());
        if let Some(update) = update {
            self.publish_status(update);
        }
        if let (Some(host), Some(process)) = (&self.privileged_host, privileged_process) {
            match host.observe(process.clone()).await {
                Ok(Some(observed)) if observed == process => return status,
                Ok(Some(_)) | Ok(None) | Err(_) => {
                    let mut inner = self.inner.lock().await;
                    if inner.privileged_process.as_ref() == Some(&process) {
                        inner.privileged_process = None;
                        inner.status = CoreStatus {
                            error: Some(
                                "The privileged Mihomo process could not be confirmed".into(),
                            ),
                            phase: CorePhase::Failed,
                            pid: None,
                            version: inner.status.version.clone(),
                        };
                        let failed = inner.status.clone();
                        drop(inner);
                        self.publish_status(failed.clone());
                        return failed;
                    }
                }
            }
        }
        status
    }

    pub async fn start(&self) -> Result<CoreStatus, String> {
        if !self.configured() {
            return Err("Mihomo requires an explicit binary and configuration path".into());
        }
        let mut inner = self.inner.lock().await;
        if inner.child.is_some() || inner.privileged_process.is_some() {
            return Ok(inner.status.clone());
        }

        inner.status.phase = CorePhase::Starting;
        inner.status.error = None;
        let version = match self.checked_version(Duration::from_secs(5)).await {
            Ok(version) => version,
            Err(error) => {
                let message = error.to_string();
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                return Err(message);
            }
        };

        if let Some(host) = &self.privileged_host {
            let request = PrivilegedCoreLaunchRequest::new(
                self.config.binary.clone().expect("checked managed binary"),
                self.config
                    .config_directory
                    .clone()
                    .expect("privileged process requires managed home"),
                self.config
                    .config_file
                    .clone()
                    .expect("privileged process requires managed configuration"),
                version.clone(),
            );
            let process = match host.start(request).await {
                Ok(process) => process,
                Err(_) => {
                    let message =
                        "Unable to start Mihomo through the privileged service".to_owned();
                    inner.status.phase = CorePhase::Failed;
                    inner.status.error = Some(message.clone());
                    return Err(message);
                }
            };
            inner.generation = inner.generation.wrapping_add(1);
            let generation = inner.generation;
            inner.status = CoreStatus {
                error: None,
                phase: CorePhase::Running,
                pid: Some(process.pid()),
                version: Some(version),
            };
            inner.privileged_process = Some(process);
            let status = inner.status.clone();
            drop(inner);
            self.monitor_privileged(generation);
            return Ok(status);
        }

        let launch = match &self.ownership {
            Some(ownership) => match ownership.begin_launch(
                self.config.binary.clone().expect("checked managed binary"),
                self.config
                    .config_directory
                    .clone()
                    .expect("owned process requires managed home"),
                self.config
                    .config_file
                    .clone()
                    .expect("owned process requires managed configuration"),
            ) {
                Ok(launch) => Some(launch),
                Err(_) => {
                    let message = "Unable to establish managed Mihomo ownership".to_owned();
                    inner.status.phase = CorePhase::Failed;
                    inner.status.error = Some(message.clone());
                    return Err(message);
                }
            },
            None => None,
        };
        let mut command = self.command();
        if let Some(launch) = &launch {
            command.env(MANAGED_CORE_TOKEN_ENV, launch.launch_token());
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                self.abort_launch(launch.as_ref());
                let message = "Unable to start managed Mihomo".to_owned();
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                return Err(message);
            }
        };
        let pid = child.id();
        let owned_process = match (&self.ownership, launch.as_ref(), pid) {
            (Some(ownership), Some(launch), Some(pid)) => {
                match ownership.commit_launch(launch, pid).await {
                    Ok(process) => Some(process),
                    Err(_) => {
                        let _ = child.start_kill();
                        if child.wait().await.is_ok() {
                            self.abort_launch(Some(launch));
                        }
                        let message = "Unable to confirm managed Mihomo ownership".to_owned();
                        inner.status.phase = CorePhase::Failed;
                        inner.status.error = Some(message.clone());
                        return Err(message);
                    }
                }
            }
            (Some(_), _, _) => {
                let _ = child.start_kill();
                if child.wait().await.is_ok() {
                    self.abort_launch(launch.as_ref());
                }
                let message = "Unable to confirm managed Mihomo ownership".to_owned();
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                return Err(message);
            }
            (None, _, _) => None,
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        match child.try_wait() {
            Ok(Some(exit)) => {
                let _ = self.clear_owned_process(owned_process.as_ref());
                let message = format!("Mihomo exited during startup with {exit}");
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                inner.status.version = Some(version);
                return Err(message);
            }
            Err(_) => {
                let _ = child.start_kill();
                if child.wait().await.is_ok() {
                    let _ = self.clear_owned_process(owned_process.as_ref());
                }
                let message = "Unable to inspect Mihomo during startup".to_owned();
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                return Err(message);
            }
            Ok(None) => {}
        }
        inner.child = Some(child);
        inner.owned_process = owned_process;
        inner.generation = inner.generation.wrapping_add(1);
        let generation = inner.generation;
        inner.status = CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid,
            version: Some(version),
        };
        let status = inner.status.clone();
        drop(inner);
        self.monitor_child(generation);
        Ok(status)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(
            self.config
                .binary
                .as_ref()
                .expect("checked managed Mihomo configuration"),
        );
        if let Some(directory) = &self.config.config_directory {
            command.arg("-d").arg(directory);
        }
        if let Some(file) = &self.config.config_file {
            command.arg("-f").arg(file);
        }
        command
    }

    async fn checked_version(
        &self,
        deadline: Duration,
    ) -> Result<String, ManagedProcessValidationError> {
        let binary = self
            .config
            .binary
            .as_ref()
            .ok_or(ManagedProcessValidationError::NotConfigured)?;
        let mut command = Command::new(binary);
        command.arg("-v").kill_on_drop(true);
        let output = match timeout(deadline, command.output()).await {
            Err(_) => return Err(ManagedProcessValidationError::Timeout),
            Ok(Err(_)) => return Err(ManagedProcessValidationError::VersionCheckFailed),
            Ok(Ok(output)) => output,
        };
        if !output.status.success() {
            return Err(ManagedProcessValidationError::VersionCheckFailed);
        }
        let reported = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if let Some(expected) = self.expected_version {
            let matches = reported
                .split_whitespace()
                .map(|part| {
                    part.trim_matches(|character: char| {
                        !(character.is_ascii_alphanumeric() || character == '.')
                    })
                })
                .any(|part| part == expected);
            if !matches {
                return Err(ManagedProcessValidationError::VersionMismatch);
            }
            return Ok(expected.to_owned());
        }
        Ok(reported)
    }

    pub async fn stop(&self) -> Result<CoreStatus, String> {
        let mut inner = self.inner.lock().await;
        inner.generation = inner.generation.wrapping_add(1);
        if let Some(process) = inner.privileged_process.take() {
            inner.status.phase = CorePhase::Stopping;
            drop(inner);
            let result = self
                .privileged_host
                .as_ref()
                .expect("privileged process requires a host")
                .stop(process)
                .await;
            let mut inner = self.inner.lock().await;
            if result.is_err() {
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some("Unable to stop privileged Mihomo".into());
                return Err("Unable to stop privileged Mihomo".into());
            }
            inner.status.phase = CorePhase::Stopped;
            inner.status.pid = None;
            inner.status.error = None;
            return Ok(inner.status.clone());
        }
        let Some(mut child) = inner.child.take() else {
            inner.status.phase = CorePhase::Stopped;
            inner.status.pid = None;
            return Ok(inner.status.clone());
        };
        let owned_process = inner.owned_process.take();
        inner.status.phase = CorePhase::Stopping;

        if let Some(pid) = child.id() {
            #[cfg(unix)]
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
        let reaped = matches!(
            timeout(Duration::from_secs(5), child.wait()).await,
            Ok(Ok(_))
        );
        if !reaped {
            child
                .start_kill()
                .map_err(|_| "Unable to kill managed Mihomo".to_owned())?;
            child
                .wait()
                .await
                .map_err(|_| "Unable to reap managed Mihomo".to_owned())?;
        }
        self.clear_owned_process(owned_process.as_ref())?;
        inner.status.phase = CorePhase::Stopped;
        inner.status.pid = None;
        inner.status.error = None;
        Ok(inner.status.clone())
    }

    fn monitor_child(&self, generation: u64) {
        let inner = Arc::downgrade(&self.inner);
        let status_events = self.status_events.clone();
        let ownership = self.ownership.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let (update, owned_process) = {
                    let mut inner = inner.lock().await;
                    if inner.generation != generation || inner.child.is_none() {
                        return;
                    }
                    let update = inspect_child(&mut inner);
                    let owned_process = if update.is_some() && inner.child.is_none() {
                        inner.owned_process.take()
                    } else {
                        None
                    };
                    (update, owned_process)
                };
                let Some(update) = update else {
                    continue;
                };
                if let (Some(ownership), Some(process)) = (&ownership, owned_process.as_ref()) {
                    let _ = ownership.clear_process(process);
                }
                if let Some(events) = status_events.get() {
                    events.publish(update);
                }
                return;
            }
        });
    }

    fn monitor_privileged(&self, generation: u64) {
        let inner = Arc::downgrade(&self.inner);
        let status_events = self.status_events.clone();
        let Some(host) = self.privileged_host.clone() else {
            return;
        };
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let process = {
                    let inner = inner.lock().await;
                    if inner.generation != generation {
                        return;
                    }
                    let Some(process) = inner.privileged_process.clone() else {
                        return;
                    };
                    process
                };
                if matches!(host.observe(process.clone()).await, Ok(Some(observed)) if observed == process)
                {
                    continue;
                }
                let update = {
                    let mut inner = inner.lock().await;
                    if inner.generation != generation
                        || inner.privileged_process.as_ref() != Some(&process)
                    {
                        return;
                    }
                    inner.privileged_process = None;
                    inner.status = CoreStatus {
                        error: Some("The privileged Mihomo process exited unexpectedly".into()),
                        phase: CorePhase::Failed,
                        pid: None,
                        version: inner.status.version.clone(),
                    };
                    inner.status.clone()
                };
                if let Some(events) = status_events.get() {
                    events.publish(update);
                }
                return;
            }
        });
    }

    fn publish_status(&self, status: CoreStatus) {
        if let Some(events) = self.status_events.get() {
            events.publish(status);
        }
    }

    fn abort_launch(&self, launch: Option<&ManagedCoreLaunch>) {
        if let (Some(ownership), Some(launch)) = (&self.ownership, launch) {
            let _ = ownership.abort_launch(launch);
        }
    }

    fn clear_owned_process(&self, process: Option<&ManagedCoreProcess>) -> Result<(), String> {
        if let (Some(ownership), Some(process)) = (&self.ownership, process) {
            ownership
                .clear_process(process)
                .map_err(|_| "Unable to clear managed Mihomo ownership".to_owned())?;
        }
        Ok(())
    }
}

fn inspect_child(inner: &mut Inner) -> Option<CoreStatus> {
    let result = inner.child.as_mut()?.try_wait();
    match result {
        Ok(Some(exit)) => {
            inner.child = None;
            inner.status = CoreStatus {
                error: if exit.success() {
                    None
                } else {
                    Some(format!("Mihomo exited with {exit}"))
                },
                phase: if exit.success() {
                    CorePhase::Stopped
                } else {
                    CorePhase::Failed
                },
                pid: None,
                version: inner.status.version.clone(),
            };
            Some(inner.status.clone())
        }
        Ok(None) => None,
        Err(_) => {
            inner.status.error = Some("Unable to inspect managed Mihomo".into());
            inner.status.phase = CorePhase::Failed;
            Some(inner.status.clone())
        }
    }
}

impl CoreRuntime for DesktopMihomoProcess {
    fn attach_status_event_sink(&self, sink: CoreStatusEventSink) {
        let _ = self.status_events.set(sink);
    }

    fn configured(&self) -> bool {
        DesktopMihomoProcess::configured(self)
    }

    fn owns_local_proxy(
        &self,
        endpoint: &mish_runtime::LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, bool> {
        let endpoint = endpoint.clone();
        Box::pin(async move {
            let inner = self.inner.lock().await;
            if let (Some(host), Some(process)) =
                (&self.privileged_host, inner.privileged_process.clone())
            {
                drop(inner);
                return host.owns_listener(process, endpoint).await.unwrap_or(false);
            }
            match (&self.ownership, inner.owned_process.as_ref()) {
                (Some(ownership), Some(process)) => {
                    ownership.process_owns_listener(process, &endpoint)
                }
                (Some(_), None) => false,
                (None, _) => true,
            }
        })
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(DesktopMihomoProcess::status(self))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            if !self.configured() {
                return Err(CoreError::unavailable(
                    "Mihomo requires an explicit binary and configuration path",
                ));
            }
            DesktopMihomoProcess::start(self)
                .await
                .map_err(CoreError::start_failed)
        })
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            DesktopMihomoProcess::stop(self)
                .await
                .map_err(CoreError::stop_failed)
        })
    }
}
