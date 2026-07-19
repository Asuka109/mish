use std::{
    fmt,
    sync::{Arc, Weak},
};

use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

mod capture;
mod status;
mod traffic;

pub use capture::*;
pub use status::*;
pub use traffic::*;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CorePhase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub error: Option<String>,
    pub phase: CorePhase,
    pub pid: Option<u32>,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoreErrorKind {
    Unavailable,
    StartFailed,
    StopFailed,
}

#[derive(Clone, Debug)]
pub struct CoreError {
    pub kind: CoreErrorKind,
    message: String,
}

struct RuntimeStatusEvents {
    updates: broadcast::Sender<CoreStatus>,
}

#[derive(Clone)]
pub struct CoreStatusEventSink {
    events: Weak<RuntimeStatusEvents>,
}

impl CoreStatusEventSink {
    pub fn publish(&self, status: CoreStatus) {
        let Some(events) = self.events.upgrade() else {
            return;
        };
        let _ = events.updates.send(status);
    }
}

impl CoreError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            kind: CoreErrorKind::Unavailable,
            message: message.into(),
        }
    }

    pub fn start_failed(message: impl Into<String>) -> Self {
        Self {
            kind: CoreErrorKind::StartFailed,
            message: message.into(),
        }
    }

    pub fn stop_failed(message: impl Into<String>) -> Self {
        Self {
            kind: CoreErrorKind::StopFailed,
            message: message.into(),
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CoreError {}

pub trait CoreRuntime: Send + Sync {
    fn attach_status_event_sink(&self, _sink: CoreStatusEventSink) {}
    fn configured(&self) -> bool;
    fn status(&self) -> BoxFuture<'_, CoreStatus>;
    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>>;
    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>>;
}

pub trait StatusDataSource: Send + Sync {
    fn attach_status_event_sink(&self, _sink: CoreStatusEventSink) {}
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot;
    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }
}

pub trait TrafficDataSource: Send + Sync {
    fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot;
}

#[derive(Default)]
struct LifecycleStatusDataSource;

impl StatusDataSource for LifecycleStatusDataSource {
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        StatusSnapshot::lifecycle_only(core, adapter_kind)
    }
}

impl TrafficDataSource for LifecycleStatusDataSource {
    fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot {
        TrafficDataSnapshot::unavailable(adapter_kind)
    }
}

#[derive(Clone)]
pub struct MishRuntime {
    capture: Option<Arc<CaptureReconciler>>,
    core: Arc<dyn CoreRuntime>,
    events: Arc<RuntimeStatusEvents>,
    status_source: Arc<dyn StatusDataSource>,
    traffic_source: Arc<dyn TrafficDataSource>,
}

impl MishRuntime {
    pub fn new(core: Arc<dyn CoreRuntime>) -> Self {
        let source = Arc::new(LifecycleStatusDataSource);
        Self::with_data_sources_and_capture(core, source.clone(), source, None)
    }

    pub fn with_status_source(
        core: Arc<dyn CoreRuntime>,
        status_source: Arc<dyn StatusDataSource>,
    ) -> Self {
        Self::with_data_sources_and_capture(
            core,
            status_source,
            Arc::new(LifecycleStatusDataSource),
            None,
        )
    }

    pub fn with_data_sources(
        core: Arc<dyn CoreRuntime>,
        status_source: Arc<dyn StatusDataSource>,
        traffic_source: Arc<dyn TrafficDataSource>,
    ) -> Self {
        Self::with_data_sources_and_capture(core, status_source, traffic_source, None)
    }

    pub fn with_capture(core: Arc<dyn CoreRuntime>, capture: Arc<CaptureReconciler>) -> Self {
        let source = Arc::new(LifecycleStatusDataSource);
        Self::with_data_sources_and_capture(core, source.clone(), source, Some(capture))
    }

    pub fn with_data_sources_and_capture(
        core: Arc<dyn CoreRuntime>,
        status_source: Arc<dyn StatusDataSource>,
        traffic_source: Arc<dyn TrafficDataSource>,
        capture: Option<Arc<CaptureReconciler>>,
    ) -> Self {
        let (updates, _) = broadcast::channel(32);
        let events = Arc::new(RuntimeStatusEvents { updates });
        core.attach_status_event_sink(CoreStatusEventSink {
            events: Arc::downgrade(&events),
        });
        status_source.attach_status_event_sink(CoreStatusEventSink {
            events: Arc::downgrade(&events),
        });
        Self {
            capture,
            core,
            events,
            status_source,
            traffic_source,
        }
    }

    pub fn core_configured(&self) -> bool {
        self.core.configured()
    }

    pub async fn core_status(&self) -> CoreStatus {
        self.core.status().await
    }

    pub async fn start_core(&self) -> Result<CoreStatus, CoreError> {
        let status = self.core.start().await?;
        self.publish_status(&status);
        Ok(status)
    }

    pub async fn stop_core(&self) -> Result<CoreStatus, CoreError> {
        let status = self.core.stop().await?;
        self.publish_status(&status);
        Ok(status)
    }

    pub async fn status_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        self.snapshot_from_status(&self.core.status().await, adapter_kind)
    }

    pub async fn set_capture(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable in this runtime",
            ));
        };
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let result = capture.reconcile(request, healthy).await;
        self.publish_status(&core);
        result?;
        Ok(self.snapshot_from_status(&core, adapter_kind))
    }

    pub async fn recover_system_proxy(
        &self,
        action: CaptureRecoveryAction,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable in this runtime",
            ));
        };
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let result = capture.recover(action, healthy).await;
        self.publish_status(&core);
        result?;
        Ok(self.snapshot_from_status(&core, adapter_kind))
    }

    pub async fn audit_capture(
        &self,
        reason: CaptureAuditReason,
    ) -> Result<bool, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Ok(false);
        };
        let before = capture.status();
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let result = capture.audit(reason, healthy).await;
        let after = capture.status();
        if before == after {
            result?;
            return Ok(false);
        }
        self.publish_status(&core);
        result?;
        Ok(true)
    }

    pub fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        serde_json::to_value(self.traffic_source.traffic_snapshot(adapter_kind))
            .expect("Traffic state must serialize")
    }

    pub fn snapshot_from_status(
        &self,
        status: &CoreStatus,
        adapter_kind: StatusAdapterKind,
    ) -> Value {
        let mut snapshot = self.status_source.snapshot(status, adapter_kind);
        if let Some(capture) = &self.capture {
            let capture_status = capture.status();
            snapshot.capabilities.system_proxy = capture.availability();
            snapshot.capabilities.tun = CapabilityAvailability::Unavailable;
            snapshot.runtime.capture_selection = capture_status.capture_selection;
            snapshot.runtime.system_proxy = capture_status.system_proxy;
            snapshot.runtime.system_proxy_enabled = capture_status.system_proxy_enabled;
            snapshot.runtime.tun_enabled = false;
        }
        serde_json::to_value(snapshot).expect("Status state must serialize")
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<CoreStatus> {
        self.events.updates.subscribe()
    }

    pub async fn shutdown(&self) -> Result<CoreStatus, CoreError> {
        if let Some(capture) = &self.capture {
            let selection = capture.status().capture_selection;
            let _ = capture
                .reconcile(
                    CaptureRequest {
                        active: false,
                        selection,
                    },
                    false,
                )
                .await;
        }
        self.status_source.shutdown().await;
        self.stop_core().await
    }

    fn publish_status(&self, status: &CoreStatus) {
        let _ = self.events.updates.send(status.clone());
    }
}
