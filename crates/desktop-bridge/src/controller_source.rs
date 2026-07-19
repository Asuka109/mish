use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::{StreamExt, future::BoxFuture};
use mish_mihomo_controller::{
    ConnectionSnapshot, ControllerClient, ControllerError, ControllerLimits, ControllerStream,
    Endpoint, HttpTransportConfig, LogMessage, MemorySnapshot,
    ProviderKind as ControllerProviderKind, ProviderVehicleType, ProxyCatalog,
    ProxyProviderCatalog, RoutingMode as ControllerRoutingMode, RuleProviderCatalog,
    TrafficSnapshot, shared_http_transport,
};
use mish_runtime::{
    CaptureSelection, CorePhase, CoreRuntime, CoreStatus, CoreStatusEventSink, EVENTS_BUFFER_LIMIT,
    EventLevel, EventRecord, EventSource, EventSourcePhase, EventSourceStatus, EventsDataPhase,
    EventsDataSource, EventsSnapshot, GroupDelayChildPhase, GroupDelayChildResult,
    GroupDelayFailure, GroupDelayPolicy, GroupDelayTest, GroupDelayTestPhase, ProfileSummary,
    ProviderAuthority, ProviderCapabilityAvailability, ProviderCommandExecution,
    ProviderCommandOperation, ProviderHealth, ProviderKind, ProviderSnapshot, ProviderSourceType,
    ProviderUpdateFailure, ProviderUpdatePhase, ProviderUpdateState, ProxyDiagnosticFailure,
    ProxyDiagnosticObservation, RoutingMode, RuntimeObservationPauseReason, RuntimePhase,
    RuntimeProvider, StatusAdapterKind, StatusCommand, StatusCommandError, StatusCommandErrorKind,
    StatusDataSource, StatusSnapshot, TrafficCommandAuthority, TrafficCommandExecution,
    TrafficCommandFailureKind, TrafficCommandOperation, TrafficDataPhase, TrafficDataSnapshot,
    TrafficDataSource,
};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{
    sync::{Mutex as AsyncMutex, broadcast},
    task::JoinHandle,
    time::{MissedTickBehavior, interval},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::event_redaction::redact_event_text;
use crate::{
    ControllerObservationBatch, ControllerStatusMapper, ProfileMappingContext,
    SelectionTargetError, StatusMappingError,
};

const STARTING_MESSAGE: &str = "Connecting to the configured Mihomo Controller";
static NEXT_EVENT_SOURCE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_GROUP_DELAY_TEST_ID: AtomicU64 = AtomicU64::new(1);

pub struct ControllerObservationConfig {
    pub base_url: Url,
    pub secret: Option<String>,
    pub profile: ProfileMappingContext,
    pub limits: ControllerLimits,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub refresh_interval: Duration,
    pub reconnect_delay: Duration,
    pub confirmation_timeout: Duration,
}

impl ControllerObservationConfig {
    pub fn new(base_url: Url, profile: ProfileMappingContext) -> Self {
        Self {
            base_url,
            secret: None,
            profile,
            limits: ControllerLimits::default(),
            connect_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(10),
            refresh_interval: Duration::from_secs(2),
            reconnect_delay: Duration::from_secs(1),
            confirmation_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Error)]
pub enum ControllerStatusSourceError {
    #[error("controller observation timing values must be greater than zero")]
    InvalidTiming,
    #[error("desktop controller observation requires an explicit loopback base URL")]
    NonLoopbackController,
    #[error(transparent)]
    Controller(#[from] ControllerError),
    #[error(transparent)]
    Mapping(#[from] StatusMappingError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControllerInitialObservation {
    Pending,
    Ready,
    VersionMismatch,
    InvalidSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum ObservationChannel {
    Command,
    Session,
    Refresh,
    Traffic,
    Memory,
}

struct SourceState {
    diagnostics: BTreeMap<ObservationChannel, String>,
    initial_observation: ControllerInitialObservation,
    event_phase: EventsDataPhase,
    mapper: Option<ControllerStatusMapper>,
    providers: ProviderSnapshot,
    event_reconnect_count: u64,
    event_sequence: u64,
    event_session_id: Option<String>,
    event_session_number: u64,
    events: VecDeque<EventRecord>,
    group_delay_test: GroupDelayTest,
    running_since: Option<Instant>,
    traffic_reconnect_count: u64,
    traffic_sequence: u64,
    traffic_session_id: Option<String>,
    traffic_session_number: u64,
}

impl SourceState {
    fn new() -> Self {
        Self {
            diagnostics: BTreeMap::new(),
            initial_observation: ControllerInitialObservation::Pending,
            event_phase: EventsDataPhase::Connecting,
            mapper: None,
            providers: ProviderSnapshot::unavailable(),
            event_reconnect_count: 0,
            event_sequence: 0,
            event_session_id: None,
            event_session_number: 0,
            events: VecDeque::with_capacity(EVENTS_BUFFER_LIMIT),
            group_delay_test: GroupDelayTest::idle(),
            running_since: None,
            traffic_reconnect_count: 0,
            traffic_sequence: 0,
            traffic_session_id: None,
            traffic_session_number: 0,
        }
    }

    fn uptime_seconds(&mut self, core: &CoreStatus) -> u64 {
        if matches!(core.phase, CorePhase::Running) {
            let started = self.running_since.get_or_insert_with(Instant::now);
            started.elapsed().as_secs()
        } else {
            self.running_since = None;
            0
        }
    }
}

fn invalidate_source_state(inner: &SourceInner, reason: RuntimeObservationPauseReason) {
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    state.group_delay_test = GroupDelayTest::idle();
    state.running_since = None;

    match reason {
        RuntimeObservationPauseReason::Sleep => {
            state.diagnostics.insert(
                ObservationChannel::Session,
                "Mihomo Controller observations paused while the system is sleeping".into(),
            );
            state.event_phase = if state.event_session_id.is_some() {
                EventsDataPhase::Stale
            } else {
                EventsDataPhase::Unavailable
            };
        }
        RuntimeObservationPauseReason::CoreUnavailable
        | RuntimeObservationPauseReason::NetworkChanged => {
            state.diagnostics.clear();
            state.diagnostics.insert(
                ObservationChannel::Session,
                match reason {
                    RuntimeObservationPauseReason::CoreUnavailable => {
                        "Mihomo Controller authority was invalidated after the core became unavailable"
                    }
                    RuntimeObservationPauseReason::NetworkChanged => {
                        "Mihomo Controller authority was invalidated after the network changed"
                    }
                    RuntimeObservationPauseReason::Sleep => unreachable!(),
                }
                .into(),
            );
            state.initial_observation = ControllerInitialObservation::Pending;
            state.mapper = None;
            state.traffic_sequence = 0;
            state.traffic_session_id = None;
            state.event_phase = EventsDataPhase::Unavailable;
            state.event_sequence = 0;
            state.event_session_id = None;
            state.events.clear();
        }
    }
}

struct SourceInner {
    authority: AsyncMutex<()>,
    cancellation: CancellationToken,
    client: ControllerClient,
    command: AsyncMutex<()>,
    confirmation_timeout: Duration,
    lifecycle: Arc<dyn CoreRuntime>,
    observation_generation: AtomicU64,
    observations_active: AtomicBool,
    event_source_id: u64,
    event_updates: broadcast::Sender<()>,
    group_delay_control: Mutex<Option<(String, CancellationToken)>>,
    profile: ProfileMappingContext,
    reconnect_delay: Duration,
    refresh_interval: Duration,
    state: Mutex<SourceState>,
    status_events: OnceLock<CoreStatusEventSink>,
}

pub struct ControllerStatusSource {
    closed: AtomicBool,
    inner: Arc<SourceInner>,
    group_delay_task: AsyncMutex<Option<JoinHandle<()>>>,
    observation_task: AsyncMutex<Option<ObservationTask>>,
}

struct ObservationTask {
    cancellation: CancellationToken,
    join: JoinHandle<()>,
}

impl ControllerStatusSource {
    pub fn new(
        config: ControllerObservationConfig,
        lifecycle: Arc<dyn CoreRuntime>,
    ) -> Result<Arc<Self>, ControllerStatusSourceError> {
        if config.connect_timeout.is_zero()
            || config.request_timeout.is_zero()
            || config.refresh_interval.is_zero()
            || config.reconnect_delay.is_zero()
            || config.confirmation_timeout.is_zero()
        {
            return Err(ControllerStatusSourceError::InvalidTiming);
        }
        if !is_loopback_url(&config.base_url) {
            return Err(ControllerStatusSourceError::NonLoopbackController);
        }
        let mut transport_config = HttpTransportConfig::new(config.base_url);
        transport_config.secret = config.secret;
        transport_config.connect_timeout = config.connect_timeout;
        transport_config.request_timeout = config.request_timeout;
        let client =
            ControllerClient::new(shared_http_transport(transport_config)?, config.limits)?;
        let (event_updates, _) = broadcast::channel(32);
        Ok(Arc::new(Self {
            closed: AtomicBool::new(false),
            inner: Arc::new(SourceInner {
                authority: AsyncMutex::new(()),
                cancellation: CancellationToken::new(),
                client,
                command: AsyncMutex::new(()),
                confirmation_timeout: config.confirmation_timeout,
                lifecycle,
                observation_generation: AtomicU64::new(0),
                observations_active: AtomicBool::new(false),
                event_source_id: NEXT_EVENT_SOURCE_ID.fetch_add(1, Ordering::Relaxed),
                event_updates,
                group_delay_control: Mutex::new(None),
                profile: config.profile,
                reconnect_delay: config.reconnect_delay,
                refresh_interval: config.refresh_interval,
                state: Mutex::new(SourceState::new()),
                status_events: OnceLock::new(),
            }),
            group_delay_task: AsyncMutex::new(None),
            observation_task: AsyncMutex::new(None),
        }))
    }

    pub async fn start(self: &Arc<Self>) {
        self.resume_observation_task().await;
    }

    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.inner.cancellation.cancel();
        self.stop_observation_task().await;
        if let Some((_, cancellation)) = self
            .inner
            .group_delay_control
            .lock()
            .expect("group delay control poisoned")
            .as_ref()
        {
            cancellation.cancel();
        }
        self.inner.client.shutdown();
        if let Some(task) = self.group_delay_task.lock().await.take() {
            let _ = task.await;
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn initial_observation(&self) -> ControllerInitialObservation {
        self.inner
            .state
            .lock()
            .expect("controller source state poisoned")
            .initial_observation
    }

    async fn stop_observation_task(&self) {
        let task = self.observation_task.lock().await.take();
        if let Some(task) = task {
            task.cancellation.cancel();
            let _ = task.join.await;
        }
        self.inner
            .observations_active
            .store(false, Ordering::Release);
    }

    async fn resume_observation_task(&self) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let mut task = self.observation_task.lock().await;
        if task.is_some() {
            return;
        }
        let generation = self
            .inner
            .observation_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("controller source state poisoned");
            if state.mapper.is_none() {
                state.diagnostics.remove(&ObservationChannel::Session);
                state.event_phase = EventsDataPhase::Connecting;
            }
        }
        self.inner
            .observations_active
            .store(true, Ordering::Release);
        let cancellation = CancellationToken::new();
        let inner = self.inner.clone();
        let task_cancellation = cancellation.clone();
        *task = Some(ObservationTask {
            cancellation,
            join: tokio::spawn(run_collectors(inner, task_cancellation, generation)),
        });
        drop(task);
        publish_change(&self.inner).await;
        publish_event_change(&self.inner);
    }

    async fn pause_observation_task(&self, reason: RuntimeObservationPauseReason) {
        self.inner
            .observation_generation
            .fetch_add(1, Ordering::AcqRel);
        self.inner
            .observations_active
            .store(false, Ordering::Release);
        if let Some((_, cancellation)) = self
            .inner
            .group_delay_control
            .lock()
            .expect("group delay control poisoned")
            .as_ref()
        {
            cancellation.cancel();
        }
        self.stop_observation_task().await;
        {
            let _authority = self.inner.authority.lock().await;
            invalidate_source_state(&self.inner, reason);
        }
        publish_change(&self.inner).await;
        publish_event_change(&self.inner);
    }
}

fn is_loopback_url(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

impl Drop for ControllerStatusSource {
    fn drop(&mut self) {
        self.inner.cancellation.cancel();
        self.inner.client.shutdown();
    }
}

impl StatusDataSource for ControllerStatusSource {
    fn attach_status_event_sink(&self, sink: CoreStatusEventSink) {
        let _ = self.inner.status_events.set(sink);
    }

    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("controller source state poisoned");
        let uptime_seconds = state.uptime_seconds(core);
        let mut snapshot = match &state.mapper {
            Some(mapper) => mapper
                .snapshot(core, adapter_kind, uptime_seconds)
                .expect("stored controller mapper has the required observations"),
            None => pending_snapshot(&self.inner.profile, core, adapter_kind),
        };
        if let Some(message) = state.diagnostics.values().next_back() {
            snapshot.runtime.phase = RuntimePhase::Error;
            snapshot.runtime.message = message.clone();
        } else if state.mapper.is_none() {
            snapshot.runtime.phase = RuntimePhase::Connecting;
            snapshot.runtime.message = STARTING_MESSAGE.into();
        }
        snapshot.group_delay_policy = GroupDelayPolicy {
            id: mish_mihomo_controller::ROUTE_DELAY_POLICY_ID.into(),
            timeout_milliseconds: mish_mihomo_controller::ROUTE_DELAY_TIMEOUT_MILLISECONDS,
        };
        snapshot.group_delay_test = state.group_delay_test.clone();
        snapshot
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.close())
    }

    fn pause_observations(&self, reason: RuntimeObservationPauseReason) -> BoxFuture<'_, ()> {
        Box::pin(self.pause_observation_task(reason))
    }

    fn resume_observations(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.resume_observation_task())
    }

    fn supports_command(&self, command: StatusCommand) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self.inner.observations_active.load(Ordering::Acquire)
            && self
                .inner
                .state
                .lock()
                .expect("controller source state poisoned")
                .initial_observation
                == ControllerInitialObservation::Ready
            && matches!(
                command,
                StatusCommand::Routing | StatusCommand::Group | StatusCommand::GroupDelay
            )
    }

    fn run_proxy_diagnostic(
        &self,
    ) -> BoxFuture<'_, Result<ProxyDiagnosticObservation, ProxyDiagnosticFailure>> {
        Box::pin(self.run_scoped_proxy_diagnostic())
    }

    fn set_routing_mode(&self, mode: RoutingMode) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(async move { self.run_routing_command(mode).await })
    }

    fn select_group_child(
        &self,
        group_id: String,
        child_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(async move { self.run_group_command(&group_id, &child_id).await })
    }

    fn start_group_delay_test(
        &self,
        group_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(async move { self.begin_group_delay_test(group_id).await })
    }

    fn cancel_group_delay_test(
        &self,
        test_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(async move { self.cancel_group_delay(&test_id).await })
    }

    fn provider_snapshot(&self) -> ProviderSnapshot {
        self.inner
            .state
            .lock()
            .expect("controller source state poisoned")
            .providers
            .clone()
    }

    fn update_provider(
        &self,
        authority: ProviderAuthority,
        provider_id: String,
    ) -> BoxFuture<'_, ProviderCommandExecution> {
        Box::pin(async move { self.run_provider_update(authority, provider_id).await })
    }

    fn update_all_providers(
        &self,
        authority: ProviderAuthority,
        kind: ProviderKind,
    ) -> BoxFuture<'_, ProviderCommandExecution> {
        Box::pin(async move { self.run_all_provider_updates(authority, kind).await })
    }
}

impl ControllerStatusSource {
    async fn run_provider_update(
        &self,
        authority: ProviderAuthority,
        provider_id: String,
    ) -> ProviderCommandExecution {
        let operation = ProviderCommandOperation::UpdateOne;
        let Ok(_command) = self.inner.command.try_lock() else {
            return ProviderCommandExecution::failure(
                operation,
                Some(provider_id),
                ProviderUpdateFailure::Conflict,
            );
        };
        let _authority = self.inner.authority.lock().await;
        if !provider_authority_matches(&self.inner.profile, &authority) {
            return ProviderCommandExecution::failure(
                operation,
                Some(provider_id),
                ProviderUpdateFailure::StaleAuthority,
            );
        }
        if let Err(failure) = refresh_provider_inventory_kind(&self.inner, None).await {
            return ProviderCommandExecution::failure(operation, Some(provider_id), failure);
        }
        let target = {
            let state = self
                .inner
                .state
                .lock()
                .expect("controller source state poisoned");
            state
                .providers
                .providers
                .iter()
                .find(|provider| provider.id == provider_id)
                .map(|provider| (provider.kind, provider.label.clone()))
        };
        let Some((kind, label)) = target else {
            return ProviderCommandExecution::failure(
                operation,
                Some(provider_id),
                ProviderUpdateFailure::NotFound,
            );
        };
        mark_provider_pending(&self.inner, std::slice::from_ref(&provider_id));
        publish_change(&self.inner).await;

        if let Err(error) = self.inner.client.verify_version().await {
            let failure = map_provider_error(&error);
            finish_provider_update(&self.inner, &provider_id, Some(failure));
            publish_change(&self.inner).await;
            return ProviderCommandExecution::failure(operation, Some(provider_id), failure);
        }
        if let Err(error) = self
            .inner
            .client
            .update_provider(controller_provider_kind(kind), &label)
            .await
        {
            let failure = map_provider_error(&error);
            finish_provider_update(&self.inner, &provider_id, Some(failure));
            publish_change(&self.inner).await;
            return ProviderCommandExecution::failure(operation, Some(provider_id), failure);
        }
        if let Err(failure) = refresh_provider_inventory_kind(&self.inner, Some(kind)).await {
            finish_provider_update(&self.inner, &provider_id, Some(failure));
            publish_change(&self.inner).await;
            return ProviderCommandExecution::failure(operation, Some(provider_id), failure);
        }
        let confirmed = self
            .provider_snapshot()
            .providers
            .iter()
            .any(|provider| provider.id == provider_id);
        let failure = (!confirmed).then_some(ProviderUpdateFailure::InconsistentObservation);
        finish_provider_update(&self.inner, &provider_id, failure);
        publish_change(&self.inner).await;
        match failure {
            Some(failure) => {
                ProviderCommandExecution::failure(operation, Some(provider_id), failure)
            }
            None => ProviderCommandExecution {
                failed: Vec::new(),
                failure: None,
                operation,
                succeeded_provider_ids: vec![provider_id],
            },
        }
    }

    async fn run_all_provider_updates(
        &self,
        authority: ProviderAuthority,
        kind: ProviderKind,
    ) -> ProviderCommandExecution {
        let operation = ProviderCommandOperation::UpdateAll;
        let Ok(_command) = self.inner.command.try_lock() else {
            return ProviderCommandExecution::failure(
                operation,
                None,
                ProviderUpdateFailure::Conflict,
            );
        };
        let _authority = self.inner.authority.lock().await;
        if !provider_authority_matches(&self.inner.profile, &authority) {
            return ProviderCommandExecution::failure(
                operation,
                None,
                ProviderUpdateFailure::StaleAuthority,
            );
        }
        if let Err(failure) = refresh_provider_inventory_kind(&self.inner, Some(kind)).await {
            return ProviderCommandExecution::failure(operation, None, failure);
        }
        let targets: Vec<(String, String)> = self
            .provider_snapshot()
            .providers
            .into_iter()
            .filter(|provider| provider.kind == kind)
            .map(|provider| (provider.id, provider.label))
            .collect();
        if targets.is_empty() {
            return ProviderCommandExecution::failure(
                operation,
                None,
                ProviderUpdateFailure::NotFound,
            );
        }
        mark_provider_pending(
            &self.inner,
            &targets.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        );
        publish_change(&self.inner).await;

        let mut failed = Vec::new();
        let mut accepted = Vec::new();
        if let Err(error) = self.inner.client.verify_version().await {
            let failure = map_provider_error(&error);
            for (provider_id, _) in &targets {
                finish_provider_update(&self.inner, provider_id, Some(failure));
                failed.push((provider_id.clone(), failure));
            }
            publish_change(&self.inner).await;
            return ProviderCommandExecution {
                failed,
                failure: Some(failure),
                operation,
                succeeded_provider_ids: Vec::new(),
            };
        }
        for (provider_id, label) in &targets {
            match self
                .inner
                .client
                .update_provider(controller_provider_kind(kind), label)
                .await
            {
                Ok(()) => accepted.push(provider_id.clone()),
                Err(error) => {
                    let failure = map_provider_error(&error);
                    finish_provider_update(&self.inner, provider_id, Some(failure));
                    failed.push((provider_id.clone(), failure));
                }
            }
        }
        let observation_failure = refresh_provider_inventory_kind(&self.inner, Some(kind))
            .await
            .err();
        let observed_ids: BTreeSet<String> = self
            .provider_snapshot()
            .providers
            .iter()
            .map(|provider| provider.id.clone())
            .collect();
        let mut succeeded_provider_ids = Vec::new();
        for provider_id in accepted {
            let failure = observation_failure.or_else(|| {
                (!observed_ids.contains(&provider_id))
                    .then_some(ProviderUpdateFailure::InconsistentObservation)
            });
            finish_provider_update(&self.inner, &provider_id, failure);
            if let Some(failure) = failure {
                failed.push((provider_id, failure));
            } else {
                succeeded_provider_ids.push(provider_id);
            }
        }
        publish_change(&self.inner).await;
        ProviderCommandExecution {
            failed,
            failure: None,
            operation,
            succeeded_provider_ids,
        }
    }

    async fn run_scoped_proxy_diagnostic(
        &self,
    ) -> Result<ProxyDiagnosticObservation, ProxyDiagnosticFailure> {
        if !self.inner.observations_active.load(Ordering::Acquire) {
            return Err(ProxyDiagnosticFailure::Disconnected);
        }
        let mapper = {
            let state = self
                .inner
                .state
                .lock()
                .expect("controller source state poisoned");
            if state.initial_observation != ControllerInitialObservation::Ready {
                return Err(ProxyDiagnosticFailure::Disconnected);
            }
            state
                .mapper
                .clone()
                .ok_or(ProxyDiagnosticFailure::Disconnected)?
        };
        let snapshot = mapper
            .snapshot(
                &CoreStatus {
                    error: None,
                    phase: CorePhase::Running,
                    pid: None,
                    version: None,
                },
                StatusAdapterKind::Native,
                0,
            )
            .map_err(|_| ProxyDiagnosticFailure::InconsistentObservation)?;
        let group = snapshot
            .groups
            .iter()
            .find(|group| group.selected_child_id.is_some())
            .ok_or(ProxyDiagnosticFailure::NoScopedTarget)?;
        let child_id = group
            .selected_child_id
            .clone()
            .ok_or(ProxyDiagnosticFailure::NoScopedTarget)?;

        self.inner
            .client
            .verify_version()
            .await
            .map_err(map_proxy_diagnostic_error)?;
        let catalog = self
            .inner
            .client
            .proxies()
            .await
            .map_err(map_proxy_diagnostic_error)?;
        let (group_label, targets) = mapper
            .group_delay_targets(&catalog, &group.id)
            .map_err(|_| ProxyDiagnosticFailure::NoScopedTarget)?;
        let child_label = targets
            .iter()
            .find_map(|(current_id, label)| (current_id == &child_id).then(|| label.clone()))
            .ok_or(ProxyDiagnosticFailure::NoScopedTarget)?;
        let delay = self
            .inner
            .client
            .proxy_delay(&child_label)
            .await
            .map_err(map_proxy_diagnostic_error)?;

        self.inner
            .client
            .verify_version()
            .await
            .map_err(map_proxy_diagnostic_error)?;
        let current_catalog = self
            .inner
            .client
            .proxies()
            .await
            .map_err(map_proxy_diagnostic_error)?;
        let (_, current_targets) = mapper
            .group_delay_targets(&current_catalog, &group.id)
            .map_err(|_| ProxyDiagnosticFailure::InconsistentObservation)?;
        if !current_targets
            .iter()
            .any(|(current_id, _)| current_id == &child_id)
        {
            return Err(ProxyDiagnosticFailure::InconsistentObservation);
        }
        if current_catalog
            .proxies
            .get(&group_label)
            .and_then(|group| group.now.as_deref())
            != Some(child_label.as_str())
        {
            return Err(ProxyDiagnosticFailure::InconsistentObservation);
        }

        Ok(ProxyDiagnosticObservation {
            child_id,
            group_id: group.id.clone(),
            latency_milliseconds: u64::from(delay.delay),
        })
    }

    fn require_command_ready(&self) -> Result<(), StatusCommandError> {
        if !self.inner.observations_active.load(Ordering::Acquire) {
            return Err(StatusCommandError::new(
                StatusCommandErrorKind::Disconnected,
                "Controller observations are paused",
            ));
        }
        let state = self
            .inner
            .state
            .lock()
            .expect("controller source state poisoned");
        if state.initial_observation == ControllerInitialObservation::Ready
            && state.mapper.is_some()
        {
            Ok(())
        } else {
            Err(StatusCommandError::new(
                StatusCommandErrorKind::Disconnected,
                "Controller commands are unavailable until the initial catalog is confirmed",
            ))
        }
    }

    async fn run_routing_command(&self, mode: RoutingMode) -> Result<(), StatusCommandError> {
        let result = self.confirm_routing_command(mode).await;
        if let Err(error) = &result {
            record_error(
                &self.inner,
                ObservationChannel::Command,
                command_failure_message(error.kind),
            )
            .await;
            self.refresh_after_command_failure().await;
        } else {
            clear_diagnostic(&self.inner, ObservationChannel::Command).await;
        }
        result
    }

    async fn confirm_routing_command(&self, mode: RoutingMode) -> Result<(), StatusCommandError> {
        self.require_command_ready()?;
        let _command = self.inner.command.try_lock().map_err(|_| {
            StatusCommandError::new(
                StatusCommandErrorKind::Conflict,
                "A Status command is already pending",
            )
        })?;
        let _authority = self.inner.authority.lock().await;
        self.inner
            .client
            .verify_version()
            .await
            .map_err(map_command_error)?;
        let expected = match mode {
            RoutingMode::Rule => ControllerRoutingMode::Rule,
            RoutingMode::Global => ControllerRoutingMode::Global,
            RoutingMode::Direct => ControllerRoutingMode::Direct,
        };
        let initial = self
            .inner
            .client
            .runtime_config()
            .await
            .map_err(map_command_error)?;
        apply_observations(
            &self.inner,
            ControllerObservationBatch {
                runtime_config: Some(initial.clone()),
                ..Default::default()
            },
            false,
        )
        .await
        .map_err(map_mapping_error)?;
        if initial.mode == expected {
            return Ok(());
        }
        self.inner
            .client
            .set_routing_mode(expected)
            .await
            .map_err(map_command_error)?;
        let deadline = tokio::time::Instant::now() + self.inner.confirmation_timeout;
        loop {
            self.inner
                .client
                .verify_version()
                .await
                .map_err(map_command_error)?;
            let observed = self
                .inner
                .client
                .runtime_config()
                .await
                .map_err(map_command_error)?;
            let confirmed = observed.mode == expected;
            apply_observations(
                &self.inner,
                ControllerObservationBatch {
                    runtime_config: Some(observed),
                    ..Default::default()
                },
                false,
            )
            .await
            .map_err(map_mapping_error)?;
            if confirmed {
                clear_diagnostic(&self.inner, ObservationChannel::Command).await;
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(StatusCommandError::new(
                    StatusCommandErrorKind::Timeout,
                    "The Controller did not confirm the routing mode before the deadline",
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn run_group_command(
        &self,
        group_id: &str,
        child_id: &str,
    ) -> Result<(), StatusCommandError> {
        let result = self.confirm_group_command(group_id, child_id).await;
        if let Err(error) = &result {
            record_error(
                &self.inner,
                ObservationChannel::Command,
                command_failure_message(error.kind),
            )
            .await;
            self.refresh_after_command_failure().await;
        } else {
            clear_diagnostic(&self.inner, ObservationChannel::Command).await;
        }
        result
    }

    async fn refresh_after_command_failure(&self) {
        let _authority = self.inner.authority.lock().await;
        if self.inner.client.verify_version().await.is_err() {
            return;
        }
        let Ok((runtime_config, proxies)) = tokio::try_join!(
            self.inner.client.runtime_config(),
            self.inner.client.proxies(),
        ) else {
            return;
        };
        let _ = apply_observations(
            &self.inner,
            ControllerObservationBatch {
                runtime_config: Some(runtime_config),
                proxies: Some(proxies),
                ..Default::default()
            },
            false,
        )
        .await;
    }

    async fn confirm_group_command(
        &self,
        group_id: &str,
        child_id: &str,
    ) -> Result<(), StatusCommandError> {
        self.require_command_ready()?;
        let _command = self.inner.command.try_lock().map_err(|_| {
            StatusCommandError::new(
                StatusCommandErrorKind::Conflict,
                "A Status command is already pending",
            )
        })?;
        let _authority = self.inner.authority.lock().await;
        self.inner
            .client
            .verify_version()
            .await
            .map_err(map_command_error)?;
        let initial = self
            .inner
            .client
            .proxies()
            .await
            .map_err(map_command_error)?;
        apply_observations(
            &self.inner,
            ControllerObservationBatch {
                proxies: Some(initial.clone()),
                ..Default::default()
            },
            false,
        )
        .await
        .map_err(map_mapping_error)?;
        let mapper = ControllerStatusMapper::new(self.inner.profile.clone());
        let (group, child) = mapper
            .selection_target(&initial, group_id, child_id)
            .map_err(map_selection_error)?;
        if initial
            .proxies
            .get(&group)
            .and_then(|proxy| proxy.now.as_deref())
            == Some(&child)
        {
            return Ok(());
        }
        self.inner
            .client
            .select_group_child(&group, &child)
            .await
            .map_err(map_command_error)?;
        let deadline = tokio::time::Instant::now() + self.inner.confirmation_timeout;
        loop {
            self.inner
                .client
                .verify_version()
                .await
                .map_err(map_command_error)?;
            let observed = self
                .inner
                .client
                .proxies()
                .await
                .map_err(map_command_error)?;
            apply_observations(
                &self.inner,
                ControllerObservationBatch {
                    proxies: Some(observed.clone()),
                    ..Default::default()
                },
                false,
            )
            .await
            .map_err(map_mapping_error)?;
            let (observed_group, observed_child) = mapper
                .selection_target(&observed, group_id, child_id)
                .map_err(|_| {
                    StatusCommandError::new(
                        StatusCommandErrorKind::StaleMembership,
                        "The policy-group membership changed before confirmation",
                    )
                })?;
            let confirmed = observed
                .proxies
                .get(&observed_group)
                .and_then(|proxy| proxy.now.as_deref())
                == Some(observed_child.as_str());
            if confirmed {
                clear_diagnostic(&self.inner, ObservationChannel::Command).await;
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(StatusCommandError::new(
                    StatusCommandErrorKind::Timeout,
                    "The Controller did not confirm the group selection before the deadline",
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn begin_group_delay_test(&self, group_id: String) -> Result<(), StatusCommandError> {
        self.require_command_ready()?;
        let _command = self.inner.command.try_lock().map_err(|_| {
            StatusCommandError::new(
                StatusCommandErrorKind::Conflict,
                "A Status command is already pending",
            )
        })?;
        {
            let control = self
                .inner
                .group_delay_control
                .lock()
                .expect("group delay control poisoned");
            if control.is_some() {
                return Err(StatusCommandError::new(
                    StatusCommandErrorKind::Conflict,
                    "A group delay test is already pending",
                ));
            }
        }

        let _authority = self.inner.authority.lock().await;
        self.inner
            .client
            .verify_version()
            .await
            .map_err(map_command_error)?;
        let catalog = self
            .inner
            .client
            .proxies()
            .await
            .map_err(map_command_error)?;
        let mapper = ControllerStatusMapper::new(self.inner.profile.clone());
        let (_, targets) = mapper
            .group_delay_targets(&catalog, &group_id)
            .map_err(map_delay_target_error)?;
        if targets.is_empty() {
            return Err(StatusCommandError::new(
                StatusCommandErrorKind::InvalidRequest,
                "The requested policy group has no direct children to test",
            ));
        }
        apply_observations(
            &self.inner,
            ControllerObservationBatch {
                proxies: Some(catalog),
                ..Default::default()
            },
            false,
        )
        .await
        .map_err(map_mapping_error)?;

        let test_id = format!(
            "group-delay-{}",
            NEXT_GROUP_DELAY_TEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        let cancellation = CancellationToken::new();
        {
            let mut control = self
                .inner
                .group_delay_control
                .lock()
                .expect("group delay control poisoned");
            if control.is_some() {
                return Err(StatusCommandError::new(
                    StatusCommandErrorKind::Conflict,
                    "A group delay test is already pending",
                ));
            }
            *control = Some((test_id.clone(), cancellation.clone()));
        }
        {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("controller source state poisoned");
            state.group_delay_test = GroupDelayTest {
                children: targets
                    .iter()
                    .map(|(child_id, _)| GroupDelayChildResult {
                        child_id: child_id.clone(),
                        failure: None,
                        latency_milliseconds: None,
                        observed_at: None,
                        phase: GroupDelayChildPhase::Pending,
                    })
                    .collect(),
                finished_at: None,
                group_id: Some(group_id.clone()),
                phase: GroupDelayTestPhase::Pending,
                profile_id: Some(self.inner.profile.profile_id().into()),
                started_at: Some(now_unix_milliseconds()),
                test_id: Some(test_id.clone()),
            };
        }
        publish_change(&self.inner).await;
        drop(_authority);

        let inner = self.inner.clone();
        let task = tokio::spawn(async move {
            run_group_delay_test(inner, test_id, group_id, targets, cancellation).await;
        });
        if let Some(previous) = self.group_delay_task.lock().await.replace(task)
            && !previous.is_finished()
        {
            previous.abort();
        }
        Ok(())
    }

    async fn cancel_group_delay(&self, test_id: &str) -> Result<(), StatusCommandError> {
        let cancellation = {
            let control = self
                .inner
                .group_delay_control
                .lock()
                .expect("group delay control poisoned");
            match control.as_ref() {
                Some((active_test_id, cancellation)) if active_test_id == test_id => {
                    cancellation.clone()
                }
                Some(_) => {
                    return Err(StatusCommandError::new(
                        StatusCommandErrorKind::Conflict,
                        "The requested delay test is not the active test",
                    ));
                }
                None => {
                    return Err(StatusCommandError::new(
                        StatusCommandErrorKind::NotFound,
                        "The requested delay test is no longer active",
                    ));
                }
            }
        };
        cancellation.cancel();
        mark_group_delay_cancelled(&self.inner, test_id);
        publish_change(&self.inner).await;
        Ok(())
    }
}

fn map_proxy_diagnostic_error(error: ControllerError) -> ProxyDiagnosticFailure {
    use mish_mihomo_controller::ControllerErrorKind;
    match error.kind() {
        ControllerErrorKind::UnsupportedVersion => ProxyDiagnosticFailure::VersionDrift,
        ControllerErrorKind::Timeout => ProxyDiagnosticFailure::Timeout,
        ControllerErrorKind::Shutdown => ProxyDiagnosticFailure::Cancelled,
        ControllerErrorKind::Transport
        | ControllerErrorKind::HttpStatus
        | ControllerErrorKind::StreamEnded => ProxyDiagnosticFailure::Disconnected,
        ControllerErrorKind::InvalidConfiguration
        | ControllerErrorKind::BodyTooLarge
        | ControllerErrorKind::MessageTooLarge
        | ControllerErrorKind::Decode
        | ControllerErrorKind::Validation => ProxyDiagnosticFailure::InconsistentObservation,
    }
}

enum ChildDelayOutcome {
    Success(u16),
    Failure(GroupDelayFailure),
    Cancelled,
}

async fn run_group_delay_test(
    inner: Arc<SourceInner>,
    test_id: String,
    group_id: String,
    targets: Vec<(String, String)>,
    cancellation: CancellationToken,
) {
    {
        let mut state = inner
            .state
            .lock()
            .expect("controller source state poisoned");
        if state.group_delay_test.test_id.as_deref() == Some(&test_id)
            && state.group_delay_test.phase == GroupDelayTestPhase::Pending
        {
            state.group_delay_test.phase = GroupDelayTestPhase::Progress;
        }
    }
    publish_change(&inner).await;

    let mut work =
        futures_util::stream::iter(targets.into_iter().map(|(child_id, child_label)| {
            let inner = inner.clone();
            let cancellation = cancellation.clone();
            let group_id = group_id.clone();
            async move {
                let outcome =
                    run_child_delay(&inner, &group_id, &child_id, &child_label, &cancellation)
                        .await;
                (child_id, outcome)
            }
        }))
        .buffer_unordered(4);

    while let Some((child_id, outcome)) = work.next().await {
        if cancellation.is_cancelled() || inner.cancellation.is_cancelled() {
            break;
        }
        let observed_at = now_unix_milliseconds();
        let changed = {
            let mut state = inner
                .state
                .lock()
                .expect("controller source state poisoned");
            let test = &mut state.group_delay_test;
            if test.test_id.as_deref() != Some(&test_id)
                || !matches!(
                    test.phase,
                    GroupDelayTestPhase::Pending | GroupDelayTestPhase::Progress
                )
            {
                continue;
            }
            let Some(child) = test
                .children
                .iter_mut()
                .find(|child| child.child_id == child_id)
            else {
                continue;
            };
            match outcome {
                ChildDelayOutcome::Success(delay) => {
                    child.latency_milliseconds = Some(delay);
                    child.failure = None;
                    child.phase = GroupDelayChildPhase::Success;
                }
                ChildDelayOutcome::Failure(failure) => {
                    child.latency_milliseconds = None;
                    child.failure = Some(failure);
                    child.phase = GroupDelayChildPhase::Failed;
                }
                ChildDelayOutcome::Cancelled => {
                    child.latency_milliseconds = None;
                    child.failure = Some(GroupDelayFailure::Cancelled);
                    child.phase = GroupDelayChildPhase::Cancelled;
                }
            }
            child.observed_at = Some(observed_at);
            test.phase = GroupDelayTestPhase::Progress;
            true
        };
        if changed {
            publish_change(&inner).await;
        }
    }

    if cancellation.is_cancelled() || inner.cancellation.is_cancelled() {
        mark_group_delay_cancelled(&inner, &test_id);
    } else {
        finish_group_delay_test(&inner, &test_id);
    }
    {
        let mut control = inner
            .group_delay_control
            .lock()
            .expect("group delay control poisoned");
        if control
            .as_ref()
            .is_some_and(|(active_test_id, _)| active_test_id == &test_id)
        {
            *control = None;
        }
    }
    publish_change(&inner).await;
}

async fn run_child_delay(
    inner: &Arc<SourceInner>,
    group_id: &str,
    child_id: &str,
    child_label: &str,
    cancellation: &CancellationToken,
) -> ChildDelayOutcome {
    let delay = tokio::select! {
        biased;
        _ = inner.cancellation.cancelled() => return ChildDelayOutcome::Cancelled,
        _ = cancellation.cancelled() => return ChildDelayOutcome::Cancelled,
        result = inner.client.proxy_delay(child_label) => result,
    };
    if cancellation.is_cancelled() || inner.cancellation.is_cancelled() {
        return ChildDelayOutcome::Cancelled;
    }

    let _authority = inner.authority.lock().await;
    let catalog = match revalidate_group_delay_target(inner, group_id, child_id).await {
        Ok(catalog) => catalog,
        Err(failure) => return ChildDelayOutcome::Failure(failure),
    };
    if cancellation.is_cancelled() || inner.cancellation.is_cancelled() {
        return ChildDelayOutcome::Cancelled;
    }
    if apply_observations(
        inner,
        ControllerObservationBatch {
            proxies: Some(catalog),
            ..Default::default()
        },
        false,
    )
    .await
    .is_err()
    {
        return ChildDelayOutcome::Failure(GroupDelayFailure::InconsistentObservation);
    }
    match delay {
        Ok(delay) => ChildDelayOutcome::Success(delay.delay),
        Err(error) => ChildDelayOutcome::Failure(map_delay_error(&error)),
    }
}

async fn revalidate_group_delay_target(
    inner: &Arc<SourceInner>,
    group_id: &str,
    child_id: &str,
) -> Result<ProxyCatalog, GroupDelayFailure> {
    inner
        .client
        .verify_version()
        .await
        .map_err(|error| map_delay_error(&error))?;
    let catalog = inner
        .client
        .proxies()
        .await
        .map_err(|error| map_delay_error(&error))?;
    let mapper = ControllerStatusMapper::new(inner.profile.clone());
    let (_, targets) = mapper
        .group_delay_targets(&catalog, group_id)
        .map_err(|_| GroupDelayFailure::StaleMembership)?;
    if !targets.iter().any(|(current_id, _)| current_id == child_id) {
        return Err(GroupDelayFailure::StaleMembership);
    }
    Ok(catalog)
}

fn mark_group_delay_cancelled(inner: &SourceInner, test_id: &str) {
    let observed_at = now_unix_milliseconds();
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    let test = &mut state.group_delay_test;
    if test.test_id.as_deref() != Some(test_id) {
        return;
    }
    for child in &mut test.children {
        if child.phase != GroupDelayChildPhase::Pending {
            continue;
        }
        child.failure = Some(GroupDelayFailure::Cancelled);
        child.observed_at = Some(observed_at);
        child.phase = GroupDelayChildPhase::Cancelled;
    }
    test.finished_at = Some(observed_at);
    test.phase = GroupDelayTestPhase::Cancelled;
}

fn finish_group_delay_test(inner: &SourceInner, test_id: &str) {
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    let test = &mut state.group_delay_test;
    if test.test_id.as_deref() != Some(test_id) || test.phase == GroupDelayTestPhase::Cancelled {
        return;
    }
    let success_count = test
        .children
        .iter()
        .filter(|child| child.phase == GroupDelayChildPhase::Success)
        .count();
    test.finished_at = Some(now_unix_milliseconds());
    test.phase = if success_count == test.children.len() {
        GroupDelayTestPhase::Completed
    } else if success_count > 0 {
        GroupDelayTestPhase::Partial
    } else {
        GroupDelayTestPhase::Failed
    };
}

fn map_delay_target_error(error: SelectionTargetError) -> StatusCommandError {
    match error {
        SelectionTargetError::GroupNotFound => StatusCommandError::new(
            StatusCommandErrorKind::NotFound,
            "The requested policy group no longer exists",
        ),
        SelectionTargetError::ChildNotFound | SelectionTargetError::ChildOutsideGroup => {
            StatusCommandError::new(
                StatusCommandErrorKind::StaleMembership,
                "The policy-group membership changed before the delay test started",
            )
        }
        SelectionTargetError::UnsupportedGroup => StatusCommandError::new(
            StatusCommandErrorKind::InvalidRequest,
            "The requested policy group cannot be tested",
        ),
    }
}

fn map_delay_error(error: &ControllerError) -> GroupDelayFailure {
    match error {
        ControllerError::HttpStatus { status: 504, .. } | ControllerError::Timeout { .. } => {
            GroupDelayFailure::Timeout
        }
        ControllerError::UnsupportedVersion { .. } => GroupDelayFailure::VersionDrift,
        ControllerError::Shutdown { .. } => GroupDelayFailure::Cancelled,
        ControllerError::Transport { .. } | ControllerError::StreamEnded { .. } => {
            GroupDelayFailure::Disconnected
        }
        ControllerError::HttpStatus { .. } => GroupDelayFailure::Unavailable,
        ControllerError::InvalidConfiguration { .. }
        | ControllerError::BodyTooLarge { .. }
        | ControllerError::MessageTooLarge { .. }
        | ControllerError::Decode { .. }
        | ControllerError::Validation { .. } => GroupDelayFailure::InconsistentObservation,
    }
}

fn map_selection_error(error: SelectionTargetError) -> StatusCommandError {
    match error {
        SelectionTargetError::GroupNotFound | SelectionTargetError::ChildNotFound => {
            StatusCommandError::new(
                StatusCommandErrorKind::NotFound,
                "The requested policy-group target no longer exists",
            )
        }
        SelectionTargetError::UnsupportedGroup => StatusCommandError::new(
            StatusCommandErrorKind::UnsupportedGroup,
            "The requested group does not support manual selection",
        ),
        SelectionTargetError::ChildOutsideGroup => StatusCommandError::new(
            StatusCommandErrorKind::StaleMembership,
            "The requested child is not a current direct member of the group",
        ),
    }
}

fn map_command_error(error: ControllerError) -> StatusCommandError {
    use mish_mihomo_controller::ControllerErrorKind;
    match error.kind() {
        ControllerErrorKind::UnsupportedVersion => StatusCommandError::new(
            StatusCommandErrorKind::VersionDrift,
            "The Controller version changed outside the supported contract",
        ),
        ControllerErrorKind::Timeout => StatusCommandError::new(
            StatusCommandErrorKind::Timeout,
            "The Controller command timed out",
        ),
        ControllerErrorKind::Shutdown
        | ControllerErrorKind::Transport
        | ControllerErrorKind::HttpStatus
        | ControllerErrorKind::StreamEnded => StatusCommandError::new(
            StatusCommandErrorKind::Disconnected,
            "The Controller disconnected while reconciling the command",
        ),
        _ => StatusCommandError::new(
            StatusCommandErrorKind::InconsistentObservation,
            "The Controller command could not be reconciled safely",
        ),
    }
}

fn map_mapping_error(_error: StatusMappingError) -> StatusCommandError {
    StatusCommandError::new(
        StatusCommandErrorKind::InconsistentObservation,
        "The Controller observation could not be mapped safely",
    )
}

fn command_failure_message(kind: StatusCommandErrorKind) -> &'static str {
    match kind {
        StatusCommandErrorKind::Timeout => "the command confirmation timed out",
        StatusCommandErrorKind::Disconnected => {
            "the Controller disconnected during command reconciliation"
        }
        StatusCommandErrorKind::VersionDrift => {
            "the Controller version changed during command reconciliation"
        }
        StatusCommandErrorKind::StaleMembership => "the requested policy-group membership is stale",
        StatusCommandErrorKind::UnsupportedGroup => {
            "the requested group does not support manual selection"
        }
        StatusCommandErrorKind::NotFound => "the requested command target was not found",
        StatusCommandErrorKind::Conflict => "another Status command is already pending",
        _ => "the command could not be reconciled safely",
    }
}

impl TrafficDataSource for ControllerStatusSource {
    fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot {
        let state = self
            .inner
            .state
            .lock()
            .expect("controller source state poisoned");
        let Some(mapper) = &state.mapper else {
            let mut snapshot = TrafficDataSnapshot::unavailable(adapter_kind);
            snapshot.profile_id = self.inner.profile.profile_id().into();
            return snapshot;
        };
        let stale = !self.inner.observations_active.load(Ordering::Acquire)
            || state.diagnostics.contains_key(&ObservationChannel::Session)
            || state.diagnostics.contains_key(&ObservationChannel::Refresh);
        mapper.traffic_snapshot(
            adapter_kind,
            if stale {
                TrafficDataPhase::Stale
            } else {
                TrafficDataPhase::Ready
            },
            state.traffic_sequence,
            state.traffic_session_id.clone(),
            state.traffic_reconnect_count,
        )
    }

    fn supports_traffic_command(&self, operation: TrafficCommandOperation) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self.inner.observations_active.load(Ordering::Acquire)
            && self
                .inner
                .state
                .lock()
                .expect("controller source state poisoned")
                .initial_observation
                == ControllerInitialObservation::Ready
            && matches!(
                operation,
                TrafficCommandOperation::CloseConnection | TrafficCommandOperation::CloseAllActive
            )
    }

    fn close_connection(
        &self,
        authority: TrafficCommandAuthority,
        connection_id: String,
    ) -> BoxFuture<'_, TrafficCommandExecution> {
        Box::pin(async move {
            self.run_traffic_command(
                TrafficCommandOperation::CloseConnection,
                authority,
                Some(connection_id),
            )
            .await
        })
    }

    fn close_all_active(
        &self,
        authority: TrafficCommandAuthority,
    ) -> BoxFuture<'_, TrafficCommandExecution> {
        Box::pin(async move {
            self.run_traffic_command(TrafficCommandOperation::CloseAllActive, authority, None)
                .await
        })
    }
}

impl ControllerStatusSource {
    async fn run_traffic_command(
        &self,
        operation: TrafficCommandOperation,
        authority: TrafficCommandAuthority,
        connection_id: Option<String>,
    ) -> TrafficCommandExecution {
        let execution = self
            .confirm_traffic_command(operation, authority, connection_id)
            .await;
        if execution.failure.is_some() {
            self.refresh_connections_after_command().await;
        }
        execution
    }

    async fn confirm_traffic_command(
        &self,
        operation: TrafficCommandOperation,
        authority: TrafficCommandAuthority,
        connection_id: Option<String>,
    ) -> TrafficCommandExecution {
        let Ok(_command) = self.inner.command.try_lock() else {
            return TrafficCommandExecution::failure(
                operation,
                TrafficCommandFailureKind::Conflict,
                0,
                Vec::new(),
            );
        };
        let _authority_lock = self.inner.authority.lock().await;
        let current = self.traffic_snapshot(StatusAdapterKind::Rpc);
        if !traffic_authority_matches(&current, &authority) {
            return TrafficCommandExecution::failure(
                operation,
                TrafficCommandFailureKind::StaleSnapshot,
                0,
                Vec::new(),
            );
        }

        let target_ids = match operation {
            TrafficCommandOperation::CloseConnection => {
                let Some(connection_id) = connection_id else {
                    return TrafficCommandExecution::failure(
                        operation,
                        TrafficCommandFailureKind::InvalidRequest,
                        0,
                        Vec::new(),
                    );
                };
                if !current
                    .active_connections
                    .iter()
                    .any(|connection| connection.id == connection_id)
                {
                    return TrafficCommandExecution::failure(
                        operation,
                        TrafficCommandFailureKind::StaleConnection,
                        0,
                        Vec::new(),
                    );
                }
                vec![connection_id]
            }
            TrafficCommandOperation::CloseAllActive => current
                .active_connections
                .iter()
                .map(|connection| connection.id.clone())
                .collect(),
        };
        let target_count = target_ids.len();
        if target_count == 0 {
            return TrafficCommandExecution::success(operation, 0);
        }

        if let Err(error) = self.inner.client.verify_version().await {
            return traffic_controller_failure(operation, target_count, &target_ids, error);
        }
        let initial = match self.inner.client.connections().await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return traffic_controller_failure(operation, target_count, &target_ids, error);
            }
        };
        if apply_connection_observation(&self.inner, initial.clone())
            .await
            .is_err()
        {
            return TrafficCommandExecution::failure(
                operation,
                TrafficCommandFailureKind::InconsistentObservation,
                target_count,
                target_ids,
            );
        }
        let observed_ids = connection_ids(&initial);
        if matches!(operation, TrafficCommandOperation::CloseConnection)
            && !observed_ids.contains(&target_ids[0])
        {
            return TrafficCommandExecution::failure(
                operation,
                TrafficCommandFailureKind::StaleConnection,
                target_count,
                Vec::new(),
            );
        }
        if matches!(operation, TrafficCommandOperation::CloseAllActive)
            && connection_id_set(&observed_ids) != connection_id_set(&target_ids)
        {
            return TrafficCommandExecution::failure(
                operation,
                TrafficCommandFailureKind::StaleSnapshot,
                target_count,
                target_ids,
            );
        }

        let mutation = match operation {
            TrafficCommandOperation::CloseConnection => {
                self.inner.client.close_connection(&target_ids[0]).await
            }
            TrafficCommandOperation::CloseAllActive => {
                self.inner.client.close_all_connections().await
            }
        };
        if let Err(error) = mutation {
            return traffic_controller_failure(operation, target_count, &target_ids, error);
        }

        let deadline = tokio::time::Instant::now() + self.inner.confirmation_timeout;
        loop {
            if let Err(error) = self.inner.client.verify_version().await {
                return traffic_controller_failure(operation, target_count, &target_ids, error);
            }
            let observed = match self.inner.client.connections().await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    return traffic_controller_failure(operation, target_count, &target_ids, error);
                }
            };
            let observed_ids = connection_ids(&observed);
            let remaining = target_ids
                .iter()
                .filter(|id| observed_ids.contains(id))
                .cloned()
                .collect::<Vec<_>>();
            if apply_connection_observation(&self.inner, observed)
                .await
                .is_err()
            {
                return TrafficCommandExecution::failure(
                    operation,
                    TrafficCommandFailureKind::InconsistentObservation,
                    target_count,
                    remaining,
                );
            }
            if remaining.is_empty() {
                return TrafficCommandExecution::success(operation, target_count);
            }
            if tokio::time::Instant::now() >= deadline {
                let failure = if matches!(operation, TrafficCommandOperation::CloseAllActive)
                    && remaining.len() < target_count
                {
                    TrafficCommandFailureKind::PartialRemaining
                } else {
                    TrafficCommandFailureKind::Timeout
                };
                return TrafficCommandExecution::failure(
                    operation,
                    failure,
                    target_count,
                    remaining,
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn refresh_connections_after_command(&self) {
        let _authority = self.inner.authority.lock().await;
        if self.inner.client.verify_version().await.is_err() {
            return;
        }
        let Ok(connections) = self.inner.client.connections().await else {
            return;
        };
        let _ = apply_connection_observation(&self.inner, connections).await;
    }
}

fn traffic_authority_matches(
    snapshot: &TrafficDataSnapshot,
    authority: &TrafficCommandAuthority,
) -> bool {
    snapshot.phase == TrafficDataPhase::Ready
        && snapshot.profile_id == authority.profile_id
        && snapshot.session_id.as_deref() == Some(authority.session_id.as_str())
        && snapshot.sequence == authority.sequence
}

fn connection_ids(snapshot: &ConnectionSnapshot) -> Vec<String> {
    snapshot
        .connections
        .iter()
        .map(|connection| connection.id.clone())
        .collect()
}

fn connection_id_set(ids: &[String]) -> BTreeSet<&str> {
    ids.iter().map(String::as_str).collect()
}

async fn apply_connection_observation(
    inner: &Arc<SourceInner>,
    connections: ConnectionSnapshot,
) -> Result<(), StatusMappingError> {
    apply_observations(
        inner,
        ControllerObservationBatch {
            connections: Some(connections),
            ..Default::default()
        },
        false,
    )
    .await
}

fn traffic_controller_failure(
    operation: TrafficCommandOperation,
    target_count: usize,
    remaining_connection_ids: &[String],
    error: ControllerError,
) -> TrafficCommandExecution {
    use mish_mihomo_controller::ControllerErrorKind;
    let failure = match error.kind() {
        ControllerErrorKind::Timeout => TrafficCommandFailureKind::Timeout,
        ControllerErrorKind::UnsupportedVersion => TrafficCommandFailureKind::VersionDrift,
        ControllerErrorKind::HttpStatus => TrafficCommandFailureKind::ControllerRejected,
        ControllerErrorKind::Shutdown
        | ControllerErrorKind::Transport
        | ControllerErrorKind::StreamEnded => TrafficCommandFailureKind::Disconnected,
        ControllerErrorKind::InvalidConfiguration
        | ControllerErrorKind::BodyTooLarge
        | ControllerErrorKind::MessageTooLarge
        | ControllerErrorKind::Decode
        | ControllerErrorKind::Validation => TrafficCommandFailureKind::InconsistentObservation,
    };
    TrafficCommandExecution::failure(
        operation,
        failure,
        target_count,
        remaining_connection_ids.to_vec(),
    )
}

impl EventsDataSource for ControllerStatusSource {
    fn events_snapshot(&self, adapter_kind: StatusAdapterKind) -> EventsSnapshot {
        let state = self
            .inner
            .state
            .lock()
            .expect("controller source state poisoned");
        let has_session = state.event_session_id.is_some();
        let phase = state.event_phase;
        let core_phase = match phase {
            EventsDataPhase::Ready => EventSourcePhase::Ready,
            EventsDataPhase::Stale => EventSourcePhase::Stale,
            EventsDataPhase::Connecting | EventsDataPhase::Unavailable => {
                EventSourcePhase::Unavailable
            }
        };
        EventsSnapshot {
            adapter_kind,
            events: state.events.iter().cloned().collect(),
            phase,
            profile_id: self.inner.profile.profile_id().into(),
            reconnect_count: state.event_reconnect_count,
            sequence: state.event_sequence,
            session_id: state.event_session_id.clone(),
            source_statuses: vec![
                EventSourceStatus {
                    detail: Some(match phase {
                        EventsDataPhase::Ready => "Live redacted Mihomo Controller events".into(),
                        EventsDataPhase::Stale => {
                            "The Controller event stream has an observation gap".into()
                        }
                        EventsDataPhase::Connecting => {
                            "Connecting to the Mihomo Controller event stream".into()
                        }
                        EventsDataPhase::Unavailable => {
                            "The Mihomo Controller event stream is unavailable".into()
                        }
                    }),
                    phase: core_phase,
                    source: EventSource::Core,
                },
                EventSourceStatus {
                    detail: Some("Local event-session boundary observations".into()),
                    phase: if has_session {
                        EventSourcePhase::Ready
                    } else {
                        EventSourcePhase::Unavailable
                    },
                    source: EventSource::Application,
                },
                EventSourceStatus {
                    detail: Some("RPC request tracing is not collected by this slice".into()),
                    phase: EventSourcePhase::Unavailable,
                    source: EventSource::Rpc,
                },
                EventSourceStatus {
                    detail: Some("Platform-adapter events are not available in this slice".into()),
                    phase: EventSourcePhase::Unavailable,
                    source: EventSource::Platform,
                },
            ],
        }
    }

    fn subscribe_events(&self) -> broadcast::Receiver<()> {
        self.inner.event_updates.subscribe()
    }
}

async fn run_collectors(
    inner: Arc<SourceInner>,
    session_cancellation: CancellationToken,
    generation: u64,
) {
    tokio::join!(
        run_status_collector(inner.clone(), session_cancellation.clone(), generation),
        run_event_collector(inner, session_cancellation, generation),
    );
}

async fn run_status_collector(
    inner: Arc<SourceInner>,
    session_cancellation: CancellationToken,
    generation: u64,
) {
    loop {
        if inner.cancellation.is_cancelled() || session_cancellation.is_cancelled() {
            return;
        }
        match observe_session(&inner, &session_cancellation, generation).await {
            Ok(()) => return,
            Err(_) if inner.cancellation.is_cancelled() || session_cancellation.is_cancelled() => {
                return;
            }
            Err(error) => {
                record_initial_failure(&inner, &error);
                record_error(
                    &inner,
                    ObservationChannel::Session,
                    safe_source_error(&error),
                )
                .await;
            }
        }
        tokio::select! {
            _ = inner.cancellation.cancelled() => return,
            _ = session_cancellation.cancelled() => return,
            _ = tokio::time::sleep(inner.reconnect_delay) => {}
        }
    }
}

async fn observe_session(
    inner: &Arc<SourceInner>,
    session_cancellation: &CancellationToken,
    generation: u64,
) -> Result<(), ControllerStatusSourceError> {
    tokio::select! {
        biased;
        _ = inner.cancellation.cancelled() => Ok(()),
        _ = session_cancellation.cancelled() => Ok(()),
        result = observe_active_session(inner, generation) => result,
    }
}

async fn observe_active_session(
    inner: &Arc<SourceInner>,
    generation: u64,
) -> Result<(), ControllerStatusSourceError> {
    let _authority = inner.authority.lock().await;
    inner.client.verify_version().await?;
    let (mut traffic, mut memory) =
        tokio::try_join!(inner.client.traffic_stream(), inner.client.memory_stream(),)?;
    let (runtime_config, proxies, rules, connections, traffic_sample, memory_sample) = tokio::try_join!(
        inner.client.runtime_config(),
        inner.client.proxies(),
        inner.client.rules(),
        inner.client.connections(),
        next_traffic(&inner.client, &mut traffic),
        next_memory(&inner.client, &mut memory),
    )?;
    let _ = refresh_provider_inventory_kind(inner, None).await;
    apply_session_observations(
        inner,
        ControllerObservationBatch {
            runtime_config: Some(runtime_config),
            proxies: Some(proxies),
            traffic: Some(traffic_sample),
            memory: Some(memory_sample),
            connections: Some(connections),
            rules: Some(rules),
        },
        true,
        generation,
    )
    .await?;
    drop(_authority);

    let mut refresh = interval(inner.refresh_interval);
    refresh.set_missed_tick_behavior(MissedTickBehavior::Skip);
    refresh.tick().await;
    loop {
        tokio::select! {
            _ = inner.cancellation.cancelled() => return Ok(()),
            sample = traffic.next() => {
                let sample = stream_item(sample, &inner.client, Endpoint::Traffic)?;
                apply_channel_observation(
                    inner,
                    ObservationChannel::Traffic,
                    ControllerObservationBatch { traffic: Some(sample), ..Default::default() },
                    generation,
                ).await;
            }
            sample = memory.next() => {
                let sample = stream_item(sample, &inner.client, Endpoint::Memory)?;
                apply_channel_observation(
                    inner,
                    ObservationChannel::Memory,
                    ControllerObservationBatch { memory: Some(sample), ..Default::default() },
                    generation,
                ).await;
            }
            _ = refresh.tick() => {
                let _authority = inner.authority.lock().await;
                let (runtime_config, proxies, rules, connections) = tokio::try_join!(
                    inner.client.runtime_config(),
                    inner.client.proxies(),
                    inner.client.rules(),
                    inner.client.connections(),
                )?;
                apply_channel_observation(
                    inner,
                    ObservationChannel::Refresh,
                    ControllerObservationBatch {
                        runtime_config: Some(runtime_config),
                        proxies: Some(proxies),
                        connections: Some(connections),
                        rules: Some(rules),
                        ..Default::default()
                    },
                    generation,
                ).await;
            }
        }
    }
}

async fn refresh_provider_inventory_kind(
    inner: &Arc<SourceInner>,
    kind: Option<ProviderKind>,
) -> Result<(), ProviderUpdateFailure> {
    if let Err(error) = inner.client.verify_version().await {
        let failure = map_provider_error(&error);
        record_provider_observation_failure(inner, failure);
        return Err(failure);
    }
    let result = match kind {
        None => {
            match tokio::try_join!(
                inner.client.proxy_providers(),
                inner.client.rule_providers(),
            ) {
                Ok((proxy, rule)) => {
                    replace_provider_inventory(inner, Some(proxy), Some(rule));
                    Ok(())
                }
                Err(error) => Err(map_provider_error(&error)),
            }
        }
        Some(ProviderKind::Proxy) => match inner.client.proxy_providers().await {
            Ok(proxy) => {
                replace_provider_inventory(inner, Some(proxy), None);
                Ok(())
            }
            Err(error) => Err(map_provider_error(&error)),
        },
        Some(ProviderKind::Rule) => match inner.client.rule_providers().await {
            Ok(rule) => {
                replace_provider_inventory(inner, None, Some(rule));
                Ok(())
            }
            Err(error) => Err(map_provider_error(&error)),
        },
    };
    if let Err(failure) = result {
        record_provider_observation_failure(inner, failure);
    }
    result
}

fn replace_provider_inventory(
    inner: &SourceInner,
    proxy: Option<ProxyProviderCatalog>,
    rule: Option<RuleProviderCatalog>,
) {
    let observed_at = now_unix_milliseconds();
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    let updates: BTreeMap<String, ProviderUpdateState> = state
        .providers
        .providers
        .iter()
        .map(|provider| (provider.id.clone(), provider.update.clone()))
        .collect();
    let mut providers: Vec<RuntimeProvider> = state.providers.providers.clone();
    if let Some(catalog) = proxy {
        providers.retain(|provider| provider.kind != ProviderKind::Proxy);
        providers.extend(catalog.providers.into_values().map(|provider| {
            let record_count = provider.proxies.len();
            let healthy_record_count = provider.proxies.iter().filter(|proxy| proxy.alive).count();
            let health = if record_count == 0 {
                ProviderHealth::Unknown
            } else if healthy_record_count == record_count {
                ProviderHealth::Available
            } else if healthy_record_count == 0 {
                ProviderHealth::Unavailable
            } else {
                ProviderHealth::Degraded
            };
            let id = provider_id(&inner.profile, ProviderKind::Proxy, &provider.name);
            RuntimeProvider {
                behavior: None,
                healthy_record_count: Some(healthy_record_count),
                health,
                id: id.clone(),
                kind: ProviderKind::Proxy,
                label: provider.name,
                record_count,
                source_type: provider_source_type(provider.vehicle_type),
                updated_at: provider.updated_at,
                update: updates
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(ProviderUpdateState::idle),
            }
        }));
    }
    if let Some(catalog) = rule {
        providers.retain(|provider| provider.kind != ProviderKind::Rule);
        providers.extend(catalog.providers.into_values().map(|provider| {
            let id = provider_id(&inner.profile, ProviderKind::Rule, &provider.name);
            RuntimeProvider {
                behavior: Some(
                    match provider.behavior {
                        mish_mihomo_controller::RuleProviderBehavior::Domain => "Domain",
                        mish_mihomo_controller::RuleProviderBehavior::IPCIDR => "IP-CIDR",
                        mish_mihomo_controller::RuleProviderBehavior::Classical => "Classical",
                    }
                    .to_owned(),
                ),
                healthy_record_count: None,
                health: ProviderHealth::Available,
                id: id.clone(),
                kind: ProviderKind::Rule,
                label: provider.name,
                record_count: provider.rule_count,
                source_type: provider_source_type(provider.vehicle_type),
                updated_at: Some(provider.updated_at),
                update: updates
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(ProviderUpdateState::idle),
            }
        }));
    }
    providers.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.label.cmp(&right.label))
    });
    state.providers = ProviderSnapshot {
        authority: Some(ProviderAuthority {
            profile_id: inner.profile.profile_id().to_owned(),
            runtime_fingerprint: inner.profile.profile_fingerprint().to_owned(),
        }),
        capability: ProviderCapabilityAvailability::Supported,
        observation_failure: None,
        observed_at: Some(observed_at),
        providers,
        remotely_cancellable: false,
    };
}

fn record_provider_observation_failure(inner: &SourceInner, failure: ProviderUpdateFailure) {
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    state.providers.authority = Some(ProviderAuthority {
        profile_id: inner.profile.profile_id().to_owned(),
        runtime_fingerprint: inner.profile.profile_fingerprint().to_owned(),
    });
    state.providers.capability = ProviderCapabilityAvailability::Supported;
    state.providers.observation_failure = Some(failure);
    state.providers.remotely_cancellable = false;
}

fn mark_provider_pending(inner: &SourceInner, provider_ids: &[String]) {
    let attempted_at = now_unix_milliseconds();
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    for provider in &mut state.providers.providers {
        if !provider_ids.contains(&provider.id) {
            continue;
        }
        provider.update = ProviderUpdateState {
            attempted_at: Some(attempted_at),
            failure: None,
            finished_at: None,
            phase: ProviderUpdatePhase::Pending,
        };
    }
}

fn finish_provider_update(
    inner: &SourceInner,
    provider_id: &str,
    failure: Option<ProviderUpdateFailure>,
) {
    let finished_at = now_unix_milliseconds();
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    let Some(provider) = state
        .providers
        .providers
        .iter_mut()
        .find(|provider| provider.id == provider_id)
    else {
        return;
    };
    provider.update.failure = failure;
    provider.update.finished_at = Some(finished_at);
    provider.update.phase = if failure.is_some() {
        ProviderUpdatePhase::Failure
    } else {
        ProviderUpdatePhase::Success
    };
}

fn provider_authority_matches(
    profile: &ProfileMappingContext,
    authority: &ProviderAuthority,
) -> bool {
    authority.profile_id == profile.profile_id()
        && authority.runtime_fingerprint == profile.profile_fingerprint()
}

fn provider_id(profile: &ProfileMappingContext, kind: ProviderKind, label: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"provider\0");
    hash.update(profile.profile_fingerprint().as_bytes());
    hash.update(b"\0");
    hash.update(match kind {
        ProviderKind::Proxy => b"proxy".as_slice(),
        ProviderKind::Rule => b"rule".as_slice(),
    });
    hash.update(b"\0");
    hash.update(label.as_bytes());
    format!("provider:{:x}", hash.finalize())
}

fn provider_source_type(source: ProviderVehicleType) -> ProviderSourceType {
    match source {
        ProviderVehicleType::File => ProviderSourceType::File,
        ProviderVehicleType::HTTP => ProviderSourceType::Http,
        ProviderVehicleType::Compatible => ProviderSourceType::Compatible,
        ProviderVehicleType::Inline => ProviderSourceType::Inline,
    }
}

fn controller_provider_kind(kind: ProviderKind) -> ControllerProviderKind {
    match kind {
        ProviderKind::Proxy => ControllerProviderKind::Proxy,
        ProviderKind::Rule => ControllerProviderKind::Rule,
    }
}

fn map_provider_error(error: &ControllerError) -> ProviderUpdateFailure {
    match error {
        ControllerError::UnsupportedVersion { .. } => ProviderUpdateFailure::VersionDrift,
        ControllerError::Timeout { .. } | ControllerError::HttpStatus { status: 504, .. } => {
            ProviderUpdateFailure::Timeout
        }
        ControllerError::HttpStatus { status: 404, .. } => ProviderUpdateFailure::NotFound,
        ControllerError::HttpStatus { status: 503, .. } => ProviderUpdateFailure::UpdateRejected,
        ControllerError::Transport { .. }
        | ControllerError::Shutdown { .. }
        | ControllerError::StreamEnded { .. } => ProviderUpdateFailure::Disconnected,
        ControllerError::HttpStatus { .. } => ProviderUpdateFailure::UpdateRejected,
        ControllerError::InvalidConfiguration { .. }
        | ControllerError::BodyTooLarge { .. }
        | ControllerError::MessageTooLarge { .. }
        | ControllerError::Decode { .. }
        | ControllerError::Validation { .. } => ProviderUpdateFailure::InconsistentObservation,
    }
}

async fn run_event_collector(
    inner: Arc<SourceInner>,
    session_cancellation: CancellationToken,
    generation: u64,
) {
    loop {
        if inner.cancellation.is_cancelled() || session_cancellation.is_cancelled() {
            return;
        }
        match observe_event_session(&inner, &session_cancellation, generation).await {
            Ok(()) => return,
            Err(_) if inner.cancellation.is_cancelled() || session_cancellation.is_cancelled() => {
                return;
            }
            Err(error) => record_event_failure(&inner, &error),
        }
        tokio::select! {
            _ = inner.cancellation.cancelled() => return,
            _ = session_cancellation.cancelled() => return,
            _ = tokio::time::sleep(inner.reconnect_delay) => {}
        }
    }
}

async fn observe_event_session(
    inner: &Arc<SourceInner>,
    session_cancellation: &CancellationToken,
    generation: u64,
) -> Result<(), ControllerStatusSourceError> {
    tokio::select! {
        biased;
        _ = inner.cancellation.cancelled() => Ok(()),
        _ = session_cancellation.cancelled() => Ok(()),
        result = observe_active_event_session(inner, generation) => result,
    }
}

async fn observe_active_event_session(
    inner: &Arc<SourceInner>,
    generation: u64,
) -> Result<(), ControllerStatusSourceError> {
    inner.client.verify_version().await?;
    let mut logs = inner.client.logs_stream().await?;
    start_event_session(inner, generation);
    loop {
        tokio::select! {
            _ = inner.cancellation.cancelled() => return Ok(()),
            message = logs.next() => {
                let message = stream_item(message, &inner.client, Endpoint::Logs)?;
                apply_log_message(inner, message, generation);
            }
        }
    }
}

fn record_initial_failure(inner: &SourceInner, error: &ControllerStatusSourceError) {
    let failure = match error {
        ControllerStatusSourceError::Controller(error)
            if error.kind() == mish_mihomo_controller::ControllerErrorKind::UnsupportedVersion =>
        {
            Some(ControllerInitialObservation::VersionMismatch)
        }
        ControllerStatusSourceError::Controller(error)
            if matches!(
                error.kind(),
                mish_mihomo_controller::ControllerErrorKind::Decode
                    | mish_mihomo_controller::ControllerErrorKind::Validation
            ) =>
        {
            Some(ControllerInitialObservation::InvalidSnapshot)
        }
        ControllerStatusSourceError::Mapping(_) => {
            Some(ControllerInitialObservation::InvalidSnapshot)
        }
        _ => None,
    };
    let Some(failure) = failure else {
        return;
    };
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    if state.initial_observation == ControllerInitialObservation::Pending {
        state.initial_observation = failure;
    }
}

async fn next_traffic(
    client: &ControllerClient,
    stream: &mut ControllerStream<TrafficSnapshot>,
) -> Result<TrafficSnapshot, ControllerError> {
    stream_item(stream.next().await, client, Endpoint::Traffic)
}

async fn next_memory(
    client: &ControllerClient,
    stream: &mut ControllerStream<MemorySnapshot>,
) -> Result<MemorySnapshot, ControllerError> {
    stream_item(stream.next().await, client, Endpoint::Memory)
}

fn stream_item<T>(
    item: Option<Result<T, ControllerError>>,
    client: &ControllerClient,
    endpoint: Endpoint,
) -> Result<T, ControllerError> {
    match item {
        Some(result) => result,
        None if client.is_shutdown() => Err(ControllerError::Shutdown { endpoint }),
        None => Err(ControllerError::StreamEnded { endpoint }),
    }
}

async fn apply_channel_observation(
    inner: &Arc<SourceInner>,
    channel: ObservationChannel,
    batch: ControllerObservationBatch,
    generation: u64,
) {
    match apply_session_observations(inner, batch, false, generation).await {
        Ok(()) => {
            clear_diagnostic(inner, channel).await;
            if channel == ObservationChannel::Refresh {
                clear_diagnostic(inner, ObservationChannel::Command).await;
            }
        }
        Err(_) => {
            record_error(
                inner,
                channel,
                "the Controller observation could not be mapped safely",
            )
            .await
        }
    }
}

async fn apply_session_observations(
    inner: &Arc<SourceInner>,
    batch: ControllerObservationBatch,
    new_session: bool,
    generation: u64,
) -> Result<(), StatusMappingError> {
    apply_observations_guarded(inner, batch, new_session, Some(generation)).await
}

async fn apply_observations(
    inner: &Arc<SourceInner>,
    batch: ControllerObservationBatch,
    new_session: bool,
) -> Result<(), StatusMappingError> {
    apply_observations_guarded(inner, batch, new_session, None).await
}

async fn apply_observations_guarded(
    inner: &Arc<SourceInner>,
    batch: ControllerObservationBatch,
    new_session: bool,
    generation: Option<u64>,
) -> Result<(), StatusMappingError> {
    let traffic_changed = batch.connections.is_some() || batch.rules.is_some();
    {
        let mut state = inner
            .state
            .lock()
            .expect("controller source state poisoned");
        if generation.is_some_and(|generation| {
            !inner.observations_active.load(Ordering::Acquire)
                || inner.observation_generation.load(Ordering::Acquire) != generation
        }) {
            return Ok(());
        }
        let mut mapper = state
            .mapper
            .clone()
            .unwrap_or_else(|| ControllerStatusMapper::new(inner.profile.clone()));
        mapper.apply(batch)?;
        if new_session {
            state.traffic_session_number = state.traffic_session_number.saturating_add(1);
            state.traffic_reconnect_count = state.traffic_session_number.saturating_sub(1);
            state.traffic_session_id = Some(format!("controller-{}", state.traffic_session_number));
            state.diagnostics.clear();
            state.initial_observation = ControllerInitialObservation::Ready;
        }
        if traffic_changed {
            state.traffic_sequence = state.traffic_sequence.saturating_add(1);
        }
        state.mapper = Some(mapper);
    }
    publish_change(inner).await;
    Ok(())
}

async fn record_error(inner: &Arc<SourceInner>, channel: ObservationChannel, detail: &str) {
    {
        let mut state = inner
            .state
            .lock()
            .expect("controller source state poisoned");
        state.diagnostics.insert(
            channel,
            format!("Mihomo Controller observation failed: {detail}"),
        );
    }
    publish_change(inner).await;
}

fn safe_source_error(error: &ControllerStatusSourceError) -> &'static str {
    match error {
        ControllerStatusSourceError::InvalidTiming => "the observation timing policy is invalid",
        ControllerStatusSourceError::NonLoopbackController => {
            "the Controller endpoint is not loopback-only"
        }
        ControllerStatusSourceError::Mapping(_) => {
            "the Controller observation could not be mapped safely"
        }
        ControllerStatusSourceError::Controller(error) => match error.kind() {
            mish_mihomo_controller::ControllerErrorKind::UnsupportedVersion => {
                "the Controller version is unsupported"
            }
            mish_mihomo_controller::ControllerErrorKind::Decode
            | mish_mihomo_controller::ControllerErrorKind::Validation => {
                "the Controller response schema is invalid"
            }
            mish_mihomo_controller::ControllerErrorKind::Timeout => {
                "the Controller operation timed out"
            }
            mish_mihomo_controller::ControllerErrorKind::Shutdown => {
                "the Controller source is shutting down"
            }
            _ => "the Controller transport is unavailable",
        },
    }
}

async fn clear_diagnostic(inner: &Arc<SourceInner>, channel: ObservationChannel) {
    let changed = inner
        .state
        .lock()
        .expect("controller source state poisoned")
        .diagnostics
        .remove(&channel)
        .is_some();
    if changed {
        publish_change(inner).await;
    }
}

async fn publish_change(inner: &Arc<SourceInner>) {
    let Some(events) = inner.status_events.get() else {
        return;
    };
    let status = tokio::select! {
        _ = inner.cancellation.cancelled() => return,
        status = inner.lifecycle.status() => status,
    };
    events.publish(status);
}

fn start_event_session(inner: &SourceInner, generation: u64) {
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    if !inner.observations_active.load(Ordering::Acquire)
        || inner.observation_generation.load(Ordering::Acquire) != generation
    {
        return;
    }
    reset_event_session(&mut state, inner);
    state.event_phase = EventsDataPhase::Ready;
    push_event(
        &mut state,
        EventLevel::Info,
        EventSource::Application,
        "Controller event session started".into(),
        Some("A new session boundary was created; earlier events are not continuous".into()),
    );
    drop(state);
    publish_event_change(inner);
}

fn record_event_failure(inner: &SourceInner, error: &ControllerStatusSourceError) {
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    let failure_phase = if matches!(
        state.event_phase,
        EventsDataPhase::Ready | EventsDataPhase::Stale
    ) {
        EventsDataPhase::Stale
    } else {
        EventsDataPhase::Unavailable
    };
    if state.event_phase == failure_phase {
        return;
    }
    if state.event_session_id.is_none() {
        reset_event_session(&mut state, inner);
    }
    state.event_phase = failure_phase;
    let (message, detail) = match failure_phase {
        EventsDataPhase::Stale => (
            "Controller event session became stale",
            "Collection will resume in a new session after reconnect",
        ),
        EventsDataPhase::Unavailable => (
            "Controller event stream is unavailable",
            safe_event_source_error(error),
        ),
        EventsDataPhase::Connecting | EventsDataPhase::Ready => unreachable!(),
    };
    push_event(
        &mut state,
        EventLevel::Warning,
        EventSource::Application,
        message.into(),
        Some(detail.into()),
    );
    drop(state);
    publish_event_change(inner);
}

fn reset_event_session(state: &mut SourceState, inner: &SourceInner) {
    state.event_session_number = state.event_session_number.saturating_add(1);
    state.event_reconnect_count = state.event_session_number.saturating_sub(1);
    state.event_session_id = Some(format!(
        "controller-events-{}-{}",
        inner.event_source_id, state.event_session_number
    ));
    state.event_sequence = 0;
    state.events.clear();
}

fn safe_event_source_error(error: &ControllerStatusSourceError) -> &'static str {
    match error {
        ControllerStatusSourceError::Controller(error) => match error.kind() {
            mish_mihomo_controller::ControllerErrorKind::Decode
            | mish_mihomo_controller::ControllerErrorKind::Validation => {
                "The Controller event stream returned an invalid message"
            }
            mish_mihomo_controller::ControllerErrorKind::UnsupportedVersion => {
                "The Controller version is unsupported"
            }
            mish_mihomo_controller::ControllerErrorKind::Timeout => {
                "The Controller event stream timed out"
            }
            _ => "The Controller event stream could not be opened",
        },
        ControllerStatusSourceError::InvalidTiming
        | ControllerStatusSourceError::NonLoopbackController
        | ControllerStatusSourceError::Mapping(_) => {
            "The Controller event source could not be started safely"
        }
    }
}

fn apply_log_message(inner: &Arc<SourceInner>, message: LogMessage, generation: u64) {
    let level = match message.level.as_str() {
        "debug" => EventLevel::Debug,
        "info" => EventLevel::Info,
        "warn" | "warning" => EventLevel::Warning,
        "error" => EventLevel::Error,
        _ => return,
    };
    let detail = if message.fields.is_empty() {
        None
    } else {
        Some(redact_event_text(
            &message
                .fields
                .into_iter()
                .map(|field| format!("{}={}", field.key, field.value))
                .collect::<Vec<_>>()
                .join(" "),
        ))
    };
    let mut state = inner
        .state
        .lock()
        .expect("controller source state poisoned");
    if !inner.observations_active.load(Ordering::Acquire)
        || inner.observation_generation.load(Ordering::Acquire) != generation
    {
        return;
    }
    if state.event_session_id.is_none() {
        return;
    }
    push_event(
        &mut state,
        level,
        EventSource::Core,
        redact_event_text(&message.message),
        detail,
    );
    drop(state);
    publish_event_change(inner);
}

fn push_event(
    state: &mut SourceState,
    level: EventLevel,
    source: EventSource,
    message: String,
    detail: Option<String>,
) {
    let Some(session_id) = &state.event_session_id else {
        return;
    };
    state.event_sequence = state.event_sequence.saturating_add(1);
    state.events.push_back(EventRecord {
        detail,
        id: format!("{session_id}:{}", state.event_sequence),
        level,
        message,
        observed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64,
        sequence: state.event_sequence,
        source,
    });
    while state.events.len() > EVENTS_BUFFER_LIMIT {
        state.events.pop_front();
    }
}

fn now_unix_milliseconds() -> u64 {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(milliseconds).unwrap_or(u64::MAX)
}

fn publish_event_change(inner: &SourceInner) {
    let _ = inner.event_updates.send(());
}

fn pending_snapshot(
    profile: &ProfileMappingContext,
    core: &CoreStatus,
    adapter_kind: StatusAdapterKind,
) -> StatusSnapshot {
    let mut snapshot = StatusSnapshot::lifecycle_only(core, adapter_kind);
    snapshot.active_profile_id = profile.profile_id().into();
    snapshot.profiles = vec![ProfileSummary {
        id: profile.profile_id().into(),
        label: profile.profile_label().into(),
    }];
    snapshot.runtime.capture_selection = CaptureSelection {
        system_proxy: false,
        tun: false,
    };
    snapshot.services.clear();
    snapshot
}
