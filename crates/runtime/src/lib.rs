use std::{
    fmt,
    sync::{Arc, Mutex, Weak},
};

use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

mod capture;
mod diagnostics;
mod events;
mod lifecycle;
mod provider;
mod status;
mod traffic;
mod tun_helper;

pub use capture::*;
pub use diagnostics::*;
pub use events::*;
pub use lifecycle::*;
pub use provider::*;
pub use status::*;
pub use traffic::*;
pub use tun_helper::*;

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
    fn pause_observations(&self, _reason: RuntimeObservationPauseReason) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }
    fn resume_observations(&self) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }
    fn supports_command(&self, _command: StatusCommand) -> bool {
        false
    }
    fn run_proxy_diagnostic(
        &self,
    ) -> BoxFuture<'_, Result<ProxyDiagnosticObservation, ProxyDiagnosticFailure>> {
        unavailable_proxy_diagnostic()
    }
    fn set_routing_mode(
        &self,
        _mode: RoutingMode,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(std::future::ready(Err(StatusCommandError::unsupported())))
    }
    fn select_group_child(
        &self,
        _group_id: String,
        _child_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(std::future::ready(Err(StatusCommandError::unsupported())))
    }
    fn start_group_delay_test(
        &self,
        _group_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(std::future::ready(Err(StatusCommandError::unsupported())))
    }
    fn cancel_group_delay_test(
        &self,
        _test_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(std::future::ready(Err(StatusCommandError::unsupported())))
    }
    fn provider_snapshot(&self) -> ProviderSnapshot {
        ProviderSnapshot::unavailable()
    }
    fn update_provider(
        &self,
        _authority: ProviderAuthority,
        provider_id: String,
    ) -> BoxFuture<'_, ProviderCommandExecution> {
        Box::pin(std::future::ready(ProviderCommandExecution::failure(
            ProviderCommandOperation::UpdateOne,
            Some(provider_id),
            ProviderUpdateFailure::Disconnected,
        )))
    }
    fn update_all_providers(
        &self,
        _authority: ProviderAuthority,
        kind: ProviderKind,
    ) -> BoxFuture<'_, ProviderCommandExecution> {
        let _ = kind;
        Box::pin(std::future::ready(ProviderCommandExecution::failure(
            ProviderCommandOperation::UpdateAll,
            None,
            ProviderUpdateFailure::Disconnected,
        )))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StatusCommand {
    Routing,
    Group,
    GroupDelay,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatusCommandErrorKind {
    Unsupported,
    InvalidRequest,
    NotFound,
    Conflict,
    Timeout,
    Disconnected,
    VersionDrift,
    InconsistentObservation,
    UnsupportedGroup,
    StaleMembership,
}

#[derive(Clone, Debug)]
pub struct StatusCommandError {
    pub kind: StatusCommandErrorKind,
    message: &'static str,
}

impl StatusCommandError {
    pub const fn new(kind: StatusCommandErrorKind, message: &'static str) -> Self {
        Self { kind, message }
    }

    pub const fn unsupported() -> Self {
        Self::new(
            StatusCommandErrorKind::Unsupported,
            "This Status command is not available in the current runtime",
        )
    }
}

impl fmt::Display for StatusCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for StatusCommandError {}

pub trait TrafficDataSource: Send + Sync {
    fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot;
    fn supports_traffic_command(&self, _operation: TrafficCommandOperation) -> bool {
        false
    }
    fn close_connection(
        &self,
        _authority: TrafficCommandAuthority,
        _connection_id: String,
    ) -> BoxFuture<'_, TrafficCommandExecution> {
        Box::pin(std::future::ready(TrafficCommandExecution::failure(
            TrafficCommandOperation::CloseConnection,
            TrafficCommandFailureKind::Unsupported,
            0,
            Vec::new(),
        )))
    }
    fn close_all_active(
        &self,
        _authority: TrafficCommandAuthority,
    ) -> BoxFuture<'_, TrafficCommandExecution> {
        Box::pin(std::future::ready(TrafficCommandExecution::failure(
            TrafficCommandOperation::CloseAllActive,
            TrafficCommandFailureKind::Unsupported,
            0,
            Vec::new(),
        )))
    }
}

pub trait EventsDataSource: Send + Sync {
    fn events_snapshot(&self, adapter_kind: StatusAdapterKind) -> EventsSnapshot;
    fn subscribe_events(&self) -> broadcast::Receiver<()>;
    fn record_application_event(&self, _event: ApplicationDiagnosticEvent) {}
}

struct LifecycleStatusDataSource {
    application_events: Mutex<ApplicationEventBuffer>,
    event_updates: broadcast::Sender<()>,
}

impl LifecycleStatusDataSource {
    fn new() -> Self {
        let (event_updates, _) = broadcast::channel(1);
        Self {
            application_events: Mutex::new(ApplicationEventBuffer::new()),
            event_updates,
        }
    }
}

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

impl EventsDataSource for LifecycleStatusDataSource {
    fn events_snapshot(&self, adapter_kind: StatusAdapterKind) -> EventsSnapshot {
        self.application_events
            .lock()
            .expect("application event state poisoned")
            .snapshot(adapter_kind)
    }

    fn subscribe_events(&self) -> broadcast::Receiver<()> {
        self.event_updates.subscribe()
    }

    fn record_application_event(&self, event: ApplicationDiagnosticEvent) {
        let inserted = self
            .application_events
            .lock()
            .expect("application event state poisoned")
            .push(event);
        if inserted {
            let _ = self.event_updates.send(());
        }
    }
}

#[derive(Clone)]
pub struct MishRuntime {
    capture: Option<Arc<CaptureReconciler>>,
    core: Arc<dyn CoreRuntime>,
    events: Arc<RuntimeStatusEvents>,
    events_source: Arc<dyn EventsDataSource>,
    status_source: Arc<dyn StatusDataSource>,
    traffic_source: Arc<dyn TrafficDataSource>,
    identity: Arc<()>,
}

impl MishRuntime {
    pub fn new(core: Arc<dyn CoreRuntime>) -> Self {
        let source = Arc::new(LifecycleStatusDataSource::new());
        Self::with_data_sources_events_and_capture(
            core,
            source.clone(),
            source.clone(),
            source,
            None,
        )
    }

    pub fn with_status_source(
        core: Arc<dyn CoreRuntime>,
        status_source: Arc<dyn StatusDataSource>,
    ) -> Self {
        Self::with_data_sources_and_capture(
            core,
            status_source,
            Arc::new(LifecycleStatusDataSource::new()),
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

    pub fn with_data_sources_and_events(
        core: Arc<dyn CoreRuntime>,
        status_source: Arc<dyn StatusDataSource>,
        traffic_source: Arc<dyn TrafficDataSource>,
        events_source: Arc<dyn EventsDataSource>,
    ) -> Self {
        Self::with_data_sources_events_and_capture(
            core,
            status_source,
            traffic_source,
            events_source,
            None,
        )
    }

    pub fn with_capture(core: Arc<dyn CoreRuntime>, capture: Arc<CaptureReconciler>) -> Self {
        let source = Arc::new(LifecycleStatusDataSource::new());
        Self::with_data_sources_events_and_capture(
            core,
            source.clone(),
            source.clone(),
            source,
            Some(capture),
        )
    }

    pub fn with_data_sources_and_capture(
        core: Arc<dyn CoreRuntime>,
        status_source: Arc<dyn StatusDataSource>,
        traffic_source: Arc<dyn TrafficDataSource>,
        capture: Option<Arc<CaptureReconciler>>,
    ) -> Self {
        let events_source = Arc::new(LifecycleStatusDataSource::new());
        Self::with_data_sources_events_and_capture(
            core,
            status_source,
            traffic_source,
            events_source,
            capture,
        )
    }

    pub fn with_data_sources_events_and_capture(
        core: Arc<dyn CoreRuntime>,
        status_source: Arc<dyn StatusDataSource>,
        traffic_source: Arc<dyn TrafficDataSource>,
        events_source: Arc<dyn EventsDataSource>,
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
            events_source,
            status_source,
            traffic_source,
            identity: Arc::new(()),
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
        serde_json::to_value(self.status_snapshot_typed(adapter_kind).await)
            .expect("Status state must serialize")
    }

    pub async fn status_snapshot_typed(&self, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        self.snapshot_typed_from_status(&self.core.status().await, adapter_kind)
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
        if let Err(error) = result {
            self.record_application_event(ApplicationDiagnosticEvent::capture_failure(error.kind));
            return Err(error);
        }
        Ok(self.snapshot_from_status(&core, adapter_kind))
    }

    pub async fn test_local_proxy(&self) -> Result<LocalProxyTestResult, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "The local proxy listener is unavailable in this runtime",
            ));
        };
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        Ok(capture.test_local_proxy(healthy).await)
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
        if let Err(error) = result {
            self.record_application_event(ApplicationDiagnosticEvent::capture_failure(error.kind));
            return Err(error);
        }
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
            return match result {
                Ok(_) => Ok(false),
                Err(error) => {
                    self.record_application_event(ApplicationDiagnosticEvent::capture_failure(
                        error.kind,
                    ));
                    Err(error)
                }
            };
        }
        self.publish_status(&core);
        match result {
            Ok(_) => Ok(true),
            Err(error) => {
                self.record_application_event(ApplicationDiagnosticEvent::capture_failure(
                    error.kind,
                ));
                Err(error)
            }
        }
    }

    pub async fn restore_capture_intent(&self) -> Result<bool, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Ok(false);
        };
        let before = capture.status();
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let selection = before.capture_selection.clone();
        let result = if selection.system_proxy || selection.tun {
            capture
                .reconcile(
                    CaptureRequest {
                        active: true,
                        selection,
                    },
                    healthy,
                )
                .await
        } else {
            capture
                .audit(CaptureAuditReason::CoreHealthChanged, healthy)
                .await
        };
        let after = capture.status();
        if before != after {
            self.publish_status(&core);
        }
        match result {
            Ok(_) => Ok(before != after),
            Err(error) => {
                self.record_application_event(ApplicationDiagnosticEvent::capture_failure(
                    error.kind,
                ));
                Err(error)
            }
        }
    }

    pub async fn pause_observations(&self, reason: RuntimeObservationPauseReason) {
        self.status_source.pause_observations(reason).await;
    }

    pub async fn resume_observations(&self) {
        self.status_source.resume_observations().await;
    }

    pub fn supports_status_command(&self, command: StatusCommand) -> bool {
        self.status_source.supports_command(command)
    }

    pub async fn set_routing_mode(
        &self,
        mode: RoutingMode,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.status_source.set_routing_mode(mode).await?;
        Ok(self.status_snapshot(adapter_kind).await)
    }

    pub async fn select_group_child(
        &self,
        group_id: String,
        child_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.status_source
            .select_group_child(group_id, child_id)
            .await?;
        Ok(self.status_snapshot(adapter_kind).await)
    }

    pub async fn start_group_delay_test(
        &self,
        group_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.status_source.start_group_delay_test(group_id).await?;
        Ok(self.status_snapshot(adapter_kind).await)
    }

    pub async fn cancel_group_delay_test(
        &self,
        test_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.status_source.cancel_group_delay_test(test_id).await?;
        Ok(self.status_snapshot(adapter_kind).await)
    }

    pub fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        serde_json::to_value(self.traffic_snapshot_typed(adapter_kind))
            .expect("Traffic state must serialize")
    }

    pub fn provider_snapshot(&self) -> ProviderSnapshot {
        self.status_source.provider_snapshot()
    }

    pub async fn update_provider(
        &self,
        authority: ProviderAuthority,
        provider_id: String,
    ) -> ProviderCommandExecution {
        self.status_source
            .update_provider(authority, provider_id)
            .await
    }

    pub async fn update_all_providers(
        &self,
        authority: ProviderAuthority,
        kind: ProviderKind,
    ) -> ProviderCommandExecution {
        self.status_source
            .update_all_providers(authority, kind)
            .await
    }

    pub fn traffic_snapshot_typed(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot {
        self.traffic_source.traffic_snapshot(adapter_kind)
    }

    pub fn supports_traffic_command(&self, operation: TrafficCommandOperation) -> bool {
        self.traffic_source.supports_traffic_command(operation)
    }

    pub async fn close_connection(
        &self,
        authority: TrafficCommandAuthority,
        connection_id: String,
    ) -> TrafficCommandExecution {
        self.traffic_source
            .close_connection(authority, connection_id)
            .await
    }

    pub async fn close_all_active(
        &self,
        authority: TrafficCommandAuthority,
    ) -> TrafficCommandExecution {
        self.traffic_source.close_all_active(authority).await
    }

    pub fn is_same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.identity, &other.identity)
    }

    pub fn events_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        serde_json::to_value(self.events_source.events_snapshot(adapter_kind))
            .expect("Events state must serialize")
    }

    pub fn events_snapshot_typed(&self, adapter_kind: StatusAdapterKind) -> EventsSnapshot {
        self.events_source.events_snapshot(adapter_kind)
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<()> {
        self.events_source.subscribe_events()
    }

    pub fn record_application_event(&self, event: ApplicationDiagnosticEvent) {
        self.events_source.record_application_event(event);
    }

    pub fn run_proxy_diagnostic(
        &self,
    ) -> BoxFuture<'_, Result<ProxyDiagnosticObservation, ProxyDiagnosticFailure>> {
        self.status_source.run_proxy_diagnostic()
    }

    pub fn snapshot_from_status(
        &self,
        status: &CoreStatus,
        adapter_kind: StatusAdapterKind,
    ) -> Value {
        serde_json::to_value(self.snapshot_typed_from_status(status, adapter_kind))
            .expect("Status state must serialize")
    }

    pub fn snapshot_typed_from_status(
        &self,
        status: &CoreStatus,
        adapter_kind: StatusAdapterKind,
    ) -> StatusSnapshot {
        let mut snapshot = self.status_source.snapshot(status, adapter_kind);
        if let Some(capture) = &self.capture {
            let capture_status = capture.status();
            snapshot.capabilities.system_proxy = capture.availability();
            snapshot.capabilities.tun = capture.tun_availability();
            snapshot.runtime.capture_selection = capture_status.capture_selection;
            snapshot.runtime.system_proxy = capture_status.system_proxy;
            snapshot.runtime.system_proxy_enabled = capture_status.system_proxy_enabled;
            snapshot.runtime.tun = capture_status.tun;
            snapshot.runtime.tun_enabled = capture_status.tun_enabled;
        }
        snapshot
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
