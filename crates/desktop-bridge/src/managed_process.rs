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
    status: CoreStatus,
}

#[derive(Clone)]
pub struct DesktopMihomoProcess {
    config: DesktopMihomoProcessConfig,
    expected_version: Option<&'static str>,
    inner: Arc<Mutex<Inner>>,
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
        Self {
            config,
            expected_version,
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                generation: 0,
                status: CoreStatus {
                    error: None,
                    phase: CorePhase::Stopped,
                    pid: None,
                    version: None,
                },
            })),
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
            .stderr(Stdio::null());
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
        let status = inner.status.clone();
        drop(inner);
        if let Some(update) = update {
            self.publish_status(update);
        }
        status
    }

    pub async fn start(&self) -> Result<CoreStatus, String> {
        if !self.configured() {
            return Err("Mihomo requires an explicit binary and configuration path".into());
        }
        let mut inner = self.inner.lock().await;
        if inner.child.is_some() {
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

        let mut command = self.command();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let message = "Unable to start managed Mihomo".to_owned();
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                return Err(message);
            }
        };
        let pid = child.id();
        tokio::time::sleep(Duration::from_millis(150)).await;
        match child.try_wait() {
            Ok(Some(exit)) => {
                let message = format!("Mihomo exited during startup with {exit}");
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                inner.status.version = Some(version);
                return Err(message);
            }
            Err(_) => {
                let message = "Unable to inspect Mihomo during startup".to_owned();
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                return Err(message);
            }
            Ok(None) => {}
        }
        inner.child = Some(child);
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
        let output = match timeout(deadline, Command::new(binary).arg("-v").output()).await {
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
        let Some(mut child) = inner.child.take() else {
            inner.status.phase = CorePhase::Stopped;
            inner.status.pid = None;
            return Ok(inner.status.clone());
        };
        inner.status.phase = CorePhase::Stopping;

        if let Some(pid) = child.id() {
            #[cfg(unix)]
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            )
            .map_err(|_| "Unable to stop managed Mihomo".to_owned())?;
        }
        if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            child
                .start_kill()
                .map_err(|_| "Unable to kill managed Mihomo".to_owned())?;
            child
                .wait()
                .await
                .map_err(|_| "Unable to reap managed Mihomo".to_owned())?;
        }
        inner.status.phase = CorePhase::Stopped;
        inner.status.pid = None;
        inner.status.error = None;
        Ok(inner.status.clone())
    }

    fn monitor_child(&self, generation: u64) {
        let inner = Arc::downgrade(&self.inner);
        let status_events = self.status_events.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let update = {
                    let mut inner = inner.lock().await;
                    if inner.generation != generation || inner.child.is_none() {
                        return;
                    }
                    inspect_child(&mut inner)
                };
                let Some(update) = update else {
                    continue;
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
