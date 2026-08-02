use std::{
    fmt,
    sync::{Arc, Mutex, Weak},
    time::Instant,
};

use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

mod application_order;
mod capture;
mod events;
mod lifecycle;
mod notifications;
mod provider;
mod proxy_diagnostic;
mod recent_traffic;
mod status;
mod traffic;
mod tun_helper;

pub use application_order::*;
pub use capture::*;
pub use events::*;
pub use lifecycle::*;
pub use mish_presentation_contract::*;
pub use notifications::*;
pub use provider::*;
pub use proxy_diagnostic::*;
pub use recent_traffic::*;
pub use status::*;
pub use traffic::*;
pub use tun_helper::*;

fn capture_failure_presentation_id(failure: CaptureFailureKind) -> &'static str {
    match failure {
        CaptureFailureKind::ApplyFailed => "apply-failed",
        CaptureFailureKind::CapabilityUnavailable => "capability-unavailable",
        CaptureFailureKind::ConfirmationFailed => "confirmation-failed",
        CaptureFailureKind::ConfigurationRequired => "configuration-required",
        CaptureFailureKind::CoreUnhealthy => "core-unhealthy",
        CaptureFailureKind::ExternalDrift => "external-drift",
        CaptureFailureKind::InvalidRecovery => "invalid-recovery",
        CaptureFailureKind::ListenerUnavailable => "listener-unavailable",
        CaptureFailureKind::ObservationFailed => "observation-failed",
        CaptureFailureKind::PermissionDenied => "permission-denied",
        CaptureFailureKind::PersistenceFailed => "persistence-failed",
        CaptureFailureKind::RollbackFailed => "rollback-failed",
        CaptureFailureKind::RuntimeTransition => "runtime-transition",
        CaptureFailureKind::TakeoverRejected => "takeover-rejected",
        CaptureFailureKind::UnsafeExistingConfiguration => "unsafe-existing-configuration",
        CaptureFailureKind::UnsupportedSelection => "unsupported-selection",
    }
}

fn system_proxy_observation_stage_presentation_id(
    stage: SystemProxyObservationStage,
) -> &'static str {
    match stage {
        SystemProxyObservationStage::DefaultRoute => "default-route",
        SystemProxyObservationStage::NetworkServiceOrder => "network-service-order",
        SystemProxyObservationStage::NetworkServiceResolution => "network-service-resolution",
        SystemProxyObservationStage::ProxyConfiguration => "proxy-configuration",
    }
}

fn system_proxy_takeover_rejection_presentation_id(
    rejection: SystemProxyTakeoverRejection,
) -> &'static str {
    match rejection {
        SystemProxyTakeoverRejection::AuthenticatedProxy => "authenticated-proxy",
        SystemProxyTakeoverRejection::IncompleteObservation => "incomplete-observation",
        SystemProxyTakeoverRejection::InvalidState => "invalid-state",
        SystemProxyTakeoverRejection::ProtectedAutoDiscovery => "protected-auto-discovery",
        SystemProxyTakeoverRejection::ProtectedPac => "protected-pac",
        SystemProxyTakeoverRejection::UnrecoverableState => "unrecoverable-state",
    }
}

fn capture_failure_action_ids(
    error: &CaptureTransitionError,
    system_proxy_phase: Option<SystemProxyPhase>,
) -> Vec<ApplicationActionId> {
    if error.takeover_rejection.is_some() {
        vec![
            ApplicationActionId::OpenSystemProxySettings,
            ApplicationActionId::ShowSystemProxySettingsSteps,
        ]
    } else if error.kind == CaptureFailureKind::ConfigurationRequired {
        vec![ApplicationActionId::OpenProfiles]
    } else if error.kind == CaptureFailureKind::ExternalDrift
        && system_proxy_phase == Some(SystemProxyPhase::Drift)
    {
        vec![ApplicationActionId::Repair, ApplicationActionId::LeaveAsIs]
    } else {
        Vec::new()
    }
}

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeShutdownFailure {
    CaptureRestoration,
    CoreStop,
}

struct RuntimeStatusEvents {
    recent_traffic_observer: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    updates: broadcast::Sender<CoreStatus>,
}

/// Tracks elapsed time only while at least one capture mode is authoritatively applied.
struct ProxySessionUptime {
    started_at: Option<Instant>,
}

impl ProxySessionUptime {
    fn observe(&mut self, capture: Option<&CaptureRuntimeStatus>, now: Instant) -> u64 {
        let active =
            capture.is_some_and(|status| status.system_proxy_enabled || status.tun_enabled);
        if active {
            let started_at = self.started_at.get_or_insert(now);
            now.saturating_duration_since(*started_at).as_secs()
        } else {
            self.started_at = None;
            0
        }
    }
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
        if let Some(observer) = events
            .recent_traffic_observer
            .lock()
            .expect("recent Traffic observer lock poisoned")
            .clone()
        {
            observer();
        }
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
    fn owns_local_proxy(&self, _endpoint: &LoopbackProxyEndpoint) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(false))
    }
    fn status(&self) -> BoxFuture<'_, CoreStatus>;
    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>>;
    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>>;
}

pub trait StatusDataSource: Send + Sync {
    fn attach_status_event_sink(&self, _sink: CoreStatusEventSink) {}
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot;
    fn profile_id(&self) -> Option<String> {
        None
    }
    fn recent_traffic_observation(&self) -> Option<RecentTrafficObservation> {
        None
    }
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
    fn set_policy_group_connection_cleanup_enabled(&self, _enabled: bool) {}
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
    Cancelled,
    Rejected,
    RuntimeReplaced,
    VersionDrift,
    InconsistentObservation,
    UnsupportedGroup,
    StaleMembership,
}

#[derive(Clone, Debug)]
pub struct StatusCommandError {
    pub kind: StatusCommandErrorKind,
    pub reconciliation: Option<StatusSnapshot>,
    message: &'static str,
}

impl StatusCommandError {
    pub const fn new(kind: StatusCommandErrorKind, message: &'static str) -> Self {
        Self {
            kind,
            reconciliation: None,
            message,
        }
    }

    pub const fn unsupported() -> Self {
        Self::new(
            StatusCommandErrorKind::Unsupported,
            "This Status command is not available in the current runtime",
        )
    }

    pub const fn runtime_replaced() -> Self {
        Self::new(
            StatusCommandErrorKind::RuntimeReplaced,
            "The Status runtime was replaced before the command completed",
        )
    }

    pub fn with_reconciliation(mut self, snapshot: StatusSnapshot) -> Self {
        self.reconciliation = Some(snapshot);
        self
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
    fn close_filtered_visible(
        &self,
        _authority: TrafficCommandAuthority,
        _connection_ids: Vec<String>,
    ) -> BoxFuture<'_, TrafficCommandExecution> {
        Box::pin(std::future::ready(TrafficCommandExecution::failure(
            TrafficCommandOperation::CloseFilteredVisible,
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

    fn profile_id(&self) -> Option<String> {
        Some("local".into())
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
    notifications: NotificationCenter,
    recent_traffic: RecentTraffic,
    status_source: Arc<dyn StatusDataSource>,
    traffic_source: Arc<dyn TrafficDataSource>,
    uptime: Arc<Mutex<ProxySessionUptime>>,
    identity: Arc<()>,
}

#[derive(Clone, Copy)]
enum CaptureNotificationMode {
    Immediate,
    Deferred,
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
        let events = Arc::new(RuntimeStatusEvents {
            recent_traffic_observer: Mutex::new(None),
            updates,
        });
        core.attach_status_event_sink(CoreStatusEventSink {
            events: Arc::downgrade(&events),
        });
        status_source.attach_status_event_sink(CoreStatusEventSink {
            events: Arc::downgrade(&events),
        });
        let runtime = Self {
            capture,
            core,
            events,
            events_source,
            notifications: NotificationCenter::new(),
            recent_traffic: RecentTraffic::new(),
            status_source,
            traffic_source,
            uptime: Arc::new(Mutex::new(ProxySessionUptime { started_at: None })),
            identity: Arc::new(()),
        };
        runtime.install_recent_traffic_source_observer();
        runtime.install_recent_traffic_capture_observer();
        runtime
    }

    pub fn core_configured(&self) -> bool {
        self.core.configured()
    }

    pub fn with_notification_center(mut self, notifications: NotificationCenter) -> Self {
        self.notifications = notifications;
        self
    }

    pub fn notification_center(&self) -> NotificationCenter {
        self.notifications.clone()
    }

    pub fn recent_traffic(&self) -> RecentTraffic {
        self.recent_traffic.clone()
    }

    pub fn with_recent_traffic(mut self, recent_traffic: RecentTraffic) -> Self {
        self.recent_traffic = recent_traffic;
        self.install_recent_traffic_source_observer();
        self.install_recent_traffic_capture_observer();
        self
    }

    fn install_recent_traffic_source_observer(&self) {
        let recent_traffic = self.recent_traffic.clone();
        let status_source = self.status_source.clone();
        *self
            .events
            .recent_traffic_observer
            .lock()
            .expect("recent Traffic observer lock poisoned") = Some(Arc::new(move || {
            if recent_traffic.snapshot().phase == RecentTrafficPhase::Active
                && let Some(observation) = status_source.recent_traffic_observation()
            {
                recent_traffic.observe(observation);
            }
        }));
    }

    fn install_recent_traffic_capture_observer(&self) {
        let Some(capture) = &self.capture else {
            return;
        };
        let recent_traffic = self.recent_traffic.clone();
        let status_source = self.status_source.clone();
        capture.set_confirmed_observer(Arc::new(move |capture_status| {
            let active = capture_status.system_proxy_enabled || capture_status.tun_enabled;
            if active {
                if recent_traffic.snapshot().phase == RecentTrafficPhase::Idle {
                    let observation = status_source.recent_traffic_observation();
                    let profile_id = observation
                        .as_ref()
                        .map(|value| value.profile_id.clone())
                        .or_else(|| status_source.profile_id());
                    if let Some(profile_id) = profile_id {
                        recent_traffic.capture_applied(&profile_id, observation);
                    }
                }
            } else if capture_status.capture_selection.system_proxy
                || capture_status.capture_selection.tun
            {
                recent_traffic.suspend();
            } else {
                recent_traffic.stop();
            }
        }));
    }

    pub fn active_profile_identity(&self) -> Option<String> {
        self.status_source.profile_id()
    }

    pub fn suspend_recent_traffic(&self) -> RecentTrafficSnapshot {
        self.recent_traffic.suspend()
    }

    pub fn discontinue_recent_traffic(&self) -> RecentTrafficSnapshot {
        self.recent_traffic.stop()
    }

    pub fn resume_recent_traffic(
        &self,
        continuity: RecentTrafficContinuity,
    ) -> RecentTrafficSnapshot {
        if continuity == RecentTrafficContinuity::Discontinue {
            return self.recent_traffic.stop();
        }
        let Some(capture) = &self.capture else {
            return self.recent_traffic.stop();
        };
        let capture = capture.status();
        if !capture.system_proxy_enabled && !capture.tun_enabled {
            if !capture.capture_selection.system_proxy && !capture.capture_selection.tun {
                return self.recent_traffic.stop();
            }
            return self.recent_traffic.snapshot();
        }
        let observation = self.status_source.recent_traffic_observation();
        let profile_id = observation
            .as_ref()
            .map(|value| value.profile_id.clone())
            .or_else(|| self.status_source.profile_id());
        self.recent_traffic
            .resume(continuity, profile_id.as_deref(), observation)
    }

    pub async fn core_status(&self) -> CoreStatus {
        self.core.status().await
    }

    pub async fn publish_current_status(&self) {
        let status = self.core.status().await;
        self.publish_status(&status);
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
        self.set_capture_with_notification_mode(
            request,
            adapter_kind,
            CaptureNotificationMode::Immediate,
        )
        .await
    }

    /// Reconciles Capture as one step of a larger backend transition. The coordinator must
    /// publish or resolve the single user-visible outcome after the transaction is terminal.
    pub async fn set_capture_deferred(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        self.set_capture_with_notification_mode(
            request,
            adapter_kind,
            CaptureNotificationMode::Deferred,
        )
        .await
    }

    pub async fn set_capture_runtime_transition(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        transition: &CaptureRuntimeTransition,
    ) -> Result<Value, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable in this runtime",
            ));
        };
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let explicit_active = request.active;
        let result = capture
            .reconcile_runtime_transition(transition, request, healthy)
            .await;
        self.finish_capture_reconciliation(
            result,
            explicit_active,
            &core,
            adapter_kind,
            CaptureNotificationMode::Deferred,
        )
    }

    async fn set_capture_with_notification_mode(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        notification_mode: CaptureNotificationMode,
    ) -> Result<Value, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable in this runtime",
            ));
        };
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let explicit_active = request.active;
        let result = capture.reconcile(request, healthy).await;
        self.finish_capture_reconciliation(
            result,
            explicit_active,
            &core,
            adapter_kind,
            notification_mode,
        )
    }

    pub async fn preflight_capture(
        &self,
        request: &CaptureRequest,
    ) -> Result<CapturePreflight, CaptureTransitionError> {
        self.preflight_capture_cancellable(request, CancellationToken::new())
            .await
    }

    pub async fn preflight_capture_cancellable(
        &self,
        request: &CaptureRequest,
        cancellation: CancellationToken,
    ) -> Result<CapturePreflight, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable in this runtime",
            ));
        };
        let result = capture.preflight_cancellable(request, cancellation).await;
        if let Err(error) = &result {
            self.record_capture_failure(error);
        }
        result
    }

    pub async fn set_capture_with_preflight(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        preflight: CapturePreflight,
    ) -> Result<Value, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable in this runtime",
            ));
        };
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let explicit_active = request.active;
        let result = capture
            .reconcile_with_preflight(request, healthy, preflight)
            .await;
        if let Err(error) = result {
            self.record_capture_failure(&error);
            return Err(error);
        }
        let recent_revision = self.recent_traffic.snapshot().revision;
        self.reconcile_recent_traffic_after_capture(explicit_active);
        if self.recent_traffic.snapshot().revision != recent_revision {
            self.publish_status(&core);
        }
        self.notifications.resolve_by_dedupe_key("capture.failure");
        Ok(self.snapshot_from_status(&core, adapter_kind))
    }

    pub async fn set_capture_with_admitted_preflight(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        preflight: CapturePreflight,
        operation: &CaptureOperation,
    ) -> Result<Value, CaptureTransitionError> {
        self.set_capture_with_admitted_preflight_notification_mode(
            request,
            adapter_kind,
            preflight,
            operation,
            CaptureNotificationMode::Immediate,
        )
        .await
    }

    /// Executes an already-admitted Capture operation without publishing an intermediate
    /// notification. The aggregate launch coordinator owns the final transaction outcome.
    pub async fn set_capture_with_admitted_preflight_deferred(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        preflight: CapturePreflight,
        operation: &CaptureOperation,
    ) -> Result<Value, CaptureTransitionError> {
        self.set_capture_with_admitted_preflight_notification_mode(
            request,
            adapter_kind,
            preflight,
            operation,
            CaptureNotificationMode::Deferred,
        )
        .await
    }

    async fn set_capture_with_admitted_preflight_notification_mode(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        preflight: CapturePreflight,
        operation: &CaptureOperation,
        notification_mode: CaptureNotificationMode,
    ) -> Result<Value, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable in this runtime",
            ));
        };
        let core = self.core.status().await;
        let healthy = self.core.configured() && matches!(core.phase, CorePhase::Running);
        let explicit_active = request.active;
        let result = capture
            .reconcile_admitted_with_preflight(request, healthy, preflight, operation)
            .await;
        self.finish_capture_reconciliation(
            result,
            explicit_active,
            &core,
            adapter_kind,
            notification_mode,
        )
    }

    fn finish_capture_reconciliation(
        &self,
        result: Result<CaptureRuntimeStatus, CaptureTransitionError>,
        explicit_active: bool,
        core: &CoreStatus,
        adapter_kind: StatusAdapterKind,
        notification_mode: CaptureNotificationMode,
    ) -> Result<Value, CaptureTransitionError> {
        if let Err(error) = result {
            if matches!(notification_mode, CaptureNotificationMode::Immediate) {
                self.record_capture_failure(&error);
            }
            return Err(error);
        }
        let recent_revision = self.recent_traffic.snapshot().revision;
        self.reconcile_recent_traffic_after_capture(explicit_active);
        if self.recent_traffic.snapshot().revision != recent_revision {
            self.publish_status(core);
        }
        if matches!(notification_mode, CaptureNotificationMode::Immediate) {
            self.notifications.resolve_by_dedupe_key("capture.failure");
        }
        Ok(self.snapshot_from_status(core, adapter_kind))
    }

    pub fn set_system_proxy_takeover_policy(&self, policy: SystemProxyTakeoverPolicy) {
        if let Some(capture) = &self.capture {
            capture.set_system_proxy_takeover_policy(policy);
        }
    }

    pub fn set_policy_group_connection_cleanup_enabled(&self, enabled: bool) {
        self.status_source
            .set_policy_group_connection_cleanup_enabled(enabled);
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
        let owns_listener = healthy
            && self
                .core
                .owns_local_proxy(capture.local_proxy_endpoint())
                .await;
        Ok(capture.test_local_proxy(healthy, owns_listener).await)
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
        if let Err(error) = result {
            self.record_capture_failure(&error);
            return Err(error);
        }
        let recent_revision = self.recent_traffic.snapshot().revision;
        self.reconcile_recent_traffic_after_capture(true);
        if self.recent_traffic.snapshot().revision != recent_revision {
            self.publish_status(&core);
        }
        self.notifications.resolve_by_dedupe_key("capture.failure");
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
                    self.record_capture_failure(&error);
                    Err(error)
                }
            };
        }
        match result {
            Ok(_) => Ok(true),
            Err(error) => {
                self.record_capture_failure(&error);
                Err(error)
            }
        }
    }

    pub async fn restore_capture_intent(&self) -> Result<bool, CaptureTransitionError> {
        let Some(capture) = &self.capture else {
            return Ok(false);
        };
        if capture.runtime_transition_pending() {
            return Ok(false);
        }
        let before = capture.status();
        let aggregate_transition_pending =
            matches!(before.system_proxy.phase, SystemProxyPhase::Pending)
                || matches!(before.tun.phase, TunPhase::Pending);
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
        match result {
            Ok(_) => Ok(before != after),
            Err(error) => {
                if aggregate_transition_pending {
                    self.record_application_event(
                        ApplicationDiagnosticEvent::capture_transition_failure(&error),
                    );
                } else {
                    self.record_capture_failure(&error);
                }
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
        Ok(
            serde_json::to_value(self.set_routing_mode_typed(mode, adapter_kind).await?)
                .expect("Status state must serialize"),
        )
    }

    pub async fn set_routing_mode_typed(
        &self,
        mode: RoutingMode,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        self.status_source.set_routing_mode(mode).await?;
        Ok(self.status_snapshot_typed(adapter_kind).await)
    }

    pub async fn select_group_child(
        &self,
        group_id: String,
        child_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        Ok(serde_json::to_value(
            self.select_group_child_typed(group_id, child_id, adapter_kind)
                .await?,
        )
        .expect("Status state must serialize"))
    }

    pub async fn select_group_child_typed(
        &self,
        group_id: String,
        child_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        self.status_source
            .select_group_child(group_id, child_id)
            .await?;
        Ok(self.status_snapshot_typed(adapter_kind).await)
    }

    pub async fn start_group_delay_test(
        &self,
        group_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        Ok(serde_json::to_value(
            self.start_group_delay_test_typed(group_id, adapter_kind)
                .await?,
        )
        .expect("Status state must serialize"))
    }

    pub async fn start_group_delay_test_typed(
        &self,
        group_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        self.status_source.start_group_delay_test(group_id).await?;
        Ok(self.status_snapshot_typed(adapter_kind).await)
    }

    pub async fn cancel_group_delay_test(
        &self,
        test_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        Ok(serde_json::to_value(
            self.cancel_group_delay_test_typed(test_id, adapter_kind)
                .await?,
        )
        .expect("Status state must serialize"))
    }

    pub async fn cancel_group_delay_test_typed(
        &self,
        test_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        self.status_source.cancel_group_delay_test(test_id).await?;
        Ok(self.status_snapshot_typed(adapter_kind).await)
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

    pub async fn close_filtered_visible(
        &self,
        authority: TrafficCommandAuthority,
        connection_ids: Vec<String>,
    ) -> TrafficCommandExecution {
        self.traffic_source
            .close_filtered_visible(authority, connection_ids)
            .await
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

    pub fn publish_notification(
        &self,
        publication: NotificationPublication,
    ) -> Result<NotificationSnapshot, NotificationValidationError> {
        self.notifications.publish(publication)
    }

    pub fn notification_snapshot(&self) -> NotificationSnapshot {
        self.notifications.snapshot()
    }

    pub fn subscribe_notifications_with_snapshot(
        &self,
    ) -> (
        broadcast::Receiver<NotificationSnapshot>,
        NotificationSnapshot,
    ) {
        self.notifications.subscribe_with_snapshot()
    }

    pub fn subscribe_notifications_with_presentation_claim(
        &self,
        identity: NotificationPresentationIdentity,
    ) -> (
        broadcast::Receiver<NotificationSnapshot>,
        NotificationPresentationClaimResult,
    ) {
        self.notifications
            .subscribe_with_presentation_claim(identity)
    }

    pub fn claim_next_notification_presentation(
        &self,
        identity: NotificationPresentationIdentity,
    ) -> NotificationPresentationClaimResult {
        self.notifications.claim_next_presentation(identity)
    }

    pub fn complete_notification_presentation(
        &self,
        completion: NotificationPresentationCompletion,
    ) -> NotificationPresentationCompletionResult {
        self.notifications.complete_presentation(completion)
    }

    pub fn release_notification_presentation_leases(
        &self,
        identity: &NotificationPresentationIdentity,
    ) -> NotificationSnapshot {
        self.notifications.release_presentation_leases(identity)
    }

    pub fn mark_notifications_read(&self, ids: &[String]) -> NotificationSnapshot {
        self.notifications.mark_read(ids)
    }

    pub fn remove_notification(&self, id: &str) -> NotificationSnapshot {
        self.notifications.remove(id)
    }

    pub fn remove_notification_by_dedupe_key(&self, dedupe_key: &str) -> NotificationSnapshot {
        self.notifications.remove_by_dedupe_key(dedupe_key)
    }

    pub fn resolve_notification(&self, dedupe_key: &str) -> NotificationSnapshot {
        self.notifications.resolve_by_dedupe_key(dedupe_key)
    }

    pub fn record_capture_failure(&self, error: &CaptureTransitionError) {
        self.record_capture_failure_with_selection(error, None);
    }

    /// Records the terminal failure of a coordinator-owned Capture transaction. The explicit
    /// selection keeps the attempted mode actionable even after rollback restored an `Off` state.
    pub fn record_capture_failure_for_selection(
        &self,
        error: &CaptureTransitionError,
        selection: &CaptureSelection,
    ) {
        self.record_capture_failure_with_selection(error, Some(selection));
    }

    fn record_capture_failure_with_selection(
        &self,
        error: &CaptureTransitionError,
        attempted_selection: Option<&CaptureSelection>,
    ) {
        let failure = error.kind;
        let capture_status = self.capture.as_ref().map(|capture| capture.status());
        let action_ids = capture_failure_action_ids(
            error,
            capture_status
                .as_ref()
                .map(|status| status.system_proxy.phase),
        );
        self.record_application_event(ApplicationDiagnosticEvent::capture_transition_failure(
            error,
        ));
        let _ = self.publish_notification(NotificationPublication {
            dedupe_key: "capture.failure".into(),
            pinned: false,
            presentation: ApplicationNotification::new(
                ApplicationNotificationContent::CaptureFailure(
                    CaptureFailureApplicationNotificationData {
                        capture_mode: attempted_selection
                            .and_then(|selection| {
                                if selection.tun {
                                    Some("tun".into())
                                } else if selection.system_proxy {
                                    Some("system-proxy".into())
                                } else {
                                    None
                                }
                            })
                            .or_else(|| {
                                capture_status.as_ref().and_then(|status| {
                                    if matches!(
                                        status.tun.phase,
                                        TunPhase::Failed | TunPhase::Drift
                                    ) {
                                        Some("tun".into())
                                    } else if matches!(
                                        status.system_proxy.phase,
                                        SystemProxyPhase::Failed | SystemProxyPhase::Drift
                                    ) {
                                        Some("system-proxy".into())
                                    } else {
                                        None
                                    }
                                })
                            }),
                        failure: capture_failure_presentation_id(failure).into(),
                        observation_stage: error
                            .observation_stage
                            .map(system_proxy_observation_stage_presentation_id)
                            .map(str::to_owned),
                        takeover_reason: error
                            .takeover_rejection
                            .map(system_proxy_takeover_rejection_presentation_id)
                            .map(str::to_owned),
                    },
                ),
                action_ids,
            ),
            replaces: Vec::new(),
            resolved: false,
            severity: if failure == CaptureFailureKind::CoreUnhealthy {
                NotificationSeverity::Warning
            } else {
                NotificationSeverity::Error
            },
        });
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
            snapshot.metrics.uptime_seconds = self
                .uptime
                .lock()
                .expect("proxy session uptime state poisoned")
                .observe(Some(&capture_status), Instant::now());
            snapshot.capabilities.system_proxy = capture.availability();
            snapshot.capabilities.tun = capture.tun_availability();
            snapshot.runtime.capture_operation = capture_status.capture_operation;
            snapshot.runtime.capture_selection = capture_status.capture_selection;
            snapshot.runtime.system_proxy = capture_status.system_proxy;
            snapshot.runtime.system_proxy_enabled = capture_status.system_proxy_enabled;
            snapshot.runtime.tun = capture_status.tun;
            snapshot.runtime.tun_enabled = capture_status.tun_enabled;
        } else {
            snapshot.metrics.uptime_seconds = self
                .uptime
                .lock()
                .expect("proxy session uptime state poisoned")
                .observe(None, Instant::now());
        }
        snapshot.recent_traffic = self.recent_traffic.snapshot();
        snapshot
    }

    pub fn snapshot_typed_with_capture_status(
        &self,
        status: &CoreStatus,
        adapter_kind: StatusAdapterKind,
        capture_status: CaptureRuntimeStatus,
    ) -> StatusSnapshot {
        let mut snapshot = self.snapshot_typed_from_status(status, adapter_kind);
        snapshot.runtime.capture_operation = capture_status.capture_operation;
        snapshot.runtime.capture_selection = capture_status.capture_selection;
        snapshot.runtime.system_proxy = capture_status.system_proxy;
        snapshot.runtime.system_proxy_enabled = capture_status.system_proxy_enabled;
        snapshot.runtime.tun = capture_status.tun;
        snapshot.runtime.tun_enabled = capture_status.tun_enabled;
        snapshot
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<CoreStatus> {
        self.events.updates.subscribe()
    }

    /// Capture transitions are published independently from Core lifecycle updates so callers
    /// can observe Pending before an OS mutation blocks and reconcile every terminal state.
    pub fn subscribe_capture(&self) -> Option<broadcast::Receiver<CaptureRuntimeStatus>> {
        self.capture.as_ref().map(|capture| capture.subscribe())
    }

    pub fn capture_operation_pending(&self) -> bool {
        self.capture.as_ref().is_some_and(|capture| {
            capture.status().capture_operation.phase == CaptureOperationPhase::Pending
        })
    }

    pub async fn publish_capture_pending(
        &self,
        request: &CaptureRequest,
    ) -> Result<CaptureOperation, CaptureTransitionError> {
        self.capture
            .as_ref()
            .ok_or_else(|| {
                CaptureTransitionError::new(
                    CaptureFailureKind::CapabilityUnavailable,
                    "System Proxy is unavailable in this runtime",
                )
            })?
            .admit_operation(request)
            .await
    }

    pub async fn finish_capture_operation_failure(
        &self,
        operation: &CaptureOperation,
        error: &CaptureTransitionError,
    ) -> Option<CaptureRuntimeStatus> {
        if let Some(capture) = &self.capture {
            return Some(capture.finish_operation_failure(operation, error).await);
        }
        None
    }

    pub async fn reject_capture_operation(
        &self,
        operation: &CaptureOperation,
        error: &CaptureTransitionError,
    ) -> Option<CaptureRuntimeStatus> {
        let status = self
            .finish_capture_operation_failure(operation, error)
            .await;
        self.record_capture_failure(error);
        status
    }

    pub async fn shutdown(&self) -> Result<CoreStatus, RuntimeShutdownFailure> {
        if let Some(capture) = &self.capture {
            capture
                .reconcile_for_shutdown()
                .await
                .map_err(|_| RuntimeShutdownFailure::CaptureRestoration)?;
        }
        self.status_source.shutdown().await;
        self.stop_core()
            .await
            .map_err(|_| RuntimeShutdownFailure::CoreStop)
    }

    fn publish_status(&self, status: &CoreStatus) {
        let _ = self.events.updates.send(status.clone());
    }

    fn reconcile_recent_traffic_after_capture(&self, explicit_active: bool) {
        let Some(capture) = &self.capture else {
            return;
        };
        let status = capture.status();
        if status.system_proxy_enabled || status.tun_enabled {
            let observation = self.status_source.recent_traffic_observation();
            let profile_id = observation
                .as_ref()
                .map(|value| value.profile_id.clone())
                .or_else(|| self.status_source.profile_id());
            if let Some(profile_id) = profile_id {
                self.recent_traffic
                    .capture_applied(&profile_id, observation);
            }
        } else if !explicit_active {
            self.recent_traffic.stop();
        }
    }
}

#[cfg(test)]
mod proxy_session_uptime_tests {
    use std::time::{Duration, Instant};

    use super::{
        CaptureOperationPhase, CaptureOperationStatus, CaptureRuntimeStatus, CaptureSelection,
        ProxySessionUptime, SystemProxyObservedState, SystemProxyPhase, SystemProxyRuntimeStatus,
        TunRuntimeStatus,
    };

    fn capture(system_proxy_enabled: bool, tun_enabled: bool) -> CaptureRuntimeStatus {
        CaptureRuntimeStatus {
            capture_operation: CaptureOperationStatus {
                operation_id: None,
                phase: CaptureOperationPhase::Idle,
                scope_epoch: "runtime-test-capture-scope".into(),
            },
            capture_selection: CaptureSelection {
                system_proxy: true,
                tun: true,
            },
            system_proxy: SystemProxyRuntimeStatus {
                desired: system_proxy_enabled,
                failure: None,
                observed: if system_proxy_enabled {
                    SystemProxyObservedState::Mish
                } else {
                    SystemProxyObservedState::Disabled
                },
                phase: if system_proxy_enabled {
                    SystemProxyPhase::Applied
                } else {
                    SystemProxyPhase::Off
                },
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled,
            tun: TunRuntimeStatus::off(),
            tun_enabled,
        }
    }

    #[test]
    fn proxy_session_uptime_starts_on_first_confirmed_capture_activation() {
        let base = Instant::now();
        let mut uptime = ProxySessionUptime { started_at: None };

        assert_eq!(uptime.observe(Some(&capture(false, false)), base), 0);
        assert_eq!(uptime.observe(Some(&capture(true, false)), base), 0);
        assert_eq!(
            uptime.observe(Some(&capture(true, false)), base + Duration::from_secs(17)),
            17
        );
    }

    #[test]
    fn proxy_session_uptime_continues_while_either_capture_mode_is_confirmed() {
        let base = Instant::now();
        let mut uptime = ProxySessionUptime { started_at: None };

        assert_eq!(uptime.observe(Some(&capture(true, true)), base), 0);
        assert_eq!(
            uptime.observe(Some(&capture(false, true)), base + Duration::from_secs(11)),
            11
        );
        assert_eq!(
            uptime.observe(Some(&capture(true, false)), base + Duration::from_secs(19)),
            19
        );
    }

    #[test]
    fn proxy_session_uptime_resets_across_stop_idle_and_relaunch_when_core_remains_running() {
        let base = Instant::now();
        let mut uptime = ProxySessionUptime { started_at: None };

        assert_eq!(uptime.observe(Some(&capture(true, false)), base), 0);
        assert_eq!(
            uptime.observe(Some(&capture(true, false)), base + Duration::from_secs(23)),
            23
        );
        assert_eq!(
            uptime.observe(Some(&capture(false, false)), base + Duration::from_secs(24),),
            0
        );
        assert_eq!(
            uptime.observe(
                Some(&capture(false, false)),
                base + Duration::from_secs(3_624),
            ),
            0
        );
        assert_eq!(
            uptime.observe(
                Some(&capture(false, true)),
                base + Duration::from_secs(3_624)
            ),
            0
        );
        assert_eq!(
            uptime.observe(
                Some(&capture(false, true)),
                base + Duration::from_secs(3_631)
            ),
            7
        );
    }

    #[test]
    fn proxy_session_uptime_resets_when_no_capture_mode_is_authoritatively_applied() {
        let base = Instant::now();
        let mut uptime = ProxySessionUptime { started_at: None };

        assert_eq!(uptime.observe(Some(&capture(true, false)), base), 0);
        assert_eq!(uptime.observe(None, base + Duration::from_secs(8)), 0);
        assert_eq!(
            uptime.observe(Some(&capture(false, false)), base + Duration::from_secs(9)),
            0
        );
    }
}

#[cfg(test)]
mod capture_failure_notification_tests {
    use super::{
        ApplicationActionId, CaptureFailureKind, CaptureTransitionError, SystemProxyPhase,
        capture_failure_action_ids,
    };

    #[test]
    fn tun_external_drift_does_not_offer_system_proxy_recovery_actions() {
        let actions = capture_failure_action_ids(
            &CaptureTransitionError::new(
                CaptureFailureKind::ExternalDrift,
                "TUN observation is foreign",
            ),
            Some(SystemProxyPhase::Applied),
        );

        assert!(actions.is_empty());
    }

    #[test]
    fn system_proxy_external_drift_retains_bounded_recovery_actions() {
        let actions = capture_failure_action_ids(
            &CaptureTransitionError::new(
                CaptureFailureKind::ExternalDrift,
                "System Proxy observation is foreign",
            ),
            Some(SystemProxyPhase::Drift),
        );

        assert_eq!(
            actions,
            vec![ApplicationActionId::Repair, ApplicationActionId::LeaveAsIs]
        );
    }

    #[test]
    fn missing_configuration_offers_only_safe_profiles_navigation() {
        let actions = capture_failure_action_ids(
            &CaptureTransitionError::new(
                CaptureFailureKind::ConfigurationRequired,
                "A Profile configuration is required",
            ),
            Some(SystemProxyPhase::Off),
        );

        assert_eq!(actions, vec![ApplicationActionId::OpenProfiles]);
    }
}
