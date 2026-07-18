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

#[derive(Clone, Debug)]
pub struct DesktopSidecarConfig {
    pub binary: Option<PathBuf>,
    pub config_directory: Option<PathBuf>,
    pub config_file: Option<PathBuf>,
}

struct Inner {
    child: Option<Child>,
    generation: u64,
    status: CoreStatus,
}

#[derive(Clone)]
pub struct DesktopSidecar {
    config: DesktopSidecarConfig,
    inner: Arc<Mutex<Inner>>,
    status_events: Arc<OnceLock<CoreStatusEventSink>>,
}

impl DesktopSidecar {
    pub fn new(config: DesktopSidecarConfig) -> Self {
        Self {
            config,
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
        let binary = self.config.binary.as_ref().expect("checked configuration");
        let version_output = match Command::new(binary).arg("-v").output().await {
            Ok(output) => output,
            Err(error) => {
                let message = format!("Unable to execute Mihomo: {error}");
                inner.status.phase = CorePhase::Failed;
                inner.status.error = Some(message.clone());
                return Err(message);
            }
        };
        if !version_output.status.success() {
            let message = String::from_utf8_lossy(&version_output.stderr)
                .trim()
                .to_owned();
            inner.status.phase = CorePhase::Failed;
            inner.status.error = Some(message.clone());
            return Err(format!("Mihomo version check failed: {message}"));
        }
        let version = String::from_utf8_lossy(&version_output.stdout)
            .trim()
            .to_owned();

        let mut command = Command::new(binary);
        if let Some(directory) = &self.config.config_directory {
            command.arg("-d").arg(directory);
        }
        if let Some(file) = &self.config.config_file {
            command.arg("-f").arg(file);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("Unable to start Mihomo: {error}");
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
            Err(error) => {
                let message = format!("Unable to inspect Mihomo during startup: {error}");
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
            .map_err(|error| format!("Unable to stop Mihomo: {error}"))?;
        }
        if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            child
                .start_kill()
                .map_err(|error| format!("Unable to kill Mihomo: {error}"))?;
            child
                .wait()
                .await
                .map_err(|error| format!("Unable to reap Mihomo: {error}"))?;
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
        Err(error) => {
            inner.status.error = Some(format!("Unable to inspect Mihomo: {error}"));
            inner.status.phase = CorePhase::Failed;
            Some(inner.status.clone())
        }
    }
}

impl CoreRuntime for DesktopSidecar {
    fn attach_status_event_sink(&self, sink: CoreStatusEventSink) {
        let _ = self.status_events.set(sink);
    }

    fn configured(&self) -> bool {
        DesktopSidecar::configured(self)
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(DesktopSidecar::status(self))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            if !self.configured() {
                return Err(CoreError::unavailable(
                    "Mihomo requires an explicit binary and configuration path",
                ));
            }
            DesktopSidecar::start(self)
                .await
                .map_err(CoreError::start_failed)
        })
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            DesktopSidecar::stop(self)
                .await
                .map_err(CoreError::stop_failed)
        })
    }
}
