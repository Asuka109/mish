use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use futures_util::{StreamExt, future::BoxFuture};
use mish_mihomo_controller::{
    ControllerClient, ControllerError, ControllerLimits, ControllerStream, Endpoint,
    HttpTransportConfig, MemorySnapshot, RoutingMode as ControllerRoutingMode, TrafficSnapshot,
    shared_http_transport,
};
use mish_runtime::{
    CaptureSelection, CorePhase, CoreRuntime, CoreStatus, CoreStatusEventSink, ProfileSummary,
    RoutingMode, RuntimePhase, StatusAdapterKind, StatusCommand, StatusCommandError,
    StatusCommandErrorKind, StatusDataSource, StatusSnapshot, TrafficDataPhase,
    TrafficDataSnapshot, TrafficDataSource,
};
use thiserror::Error;
use tokio::{
    sync::Mutex as AsyncMutex,
    task::JoinHandle,
    time::{MissedTickBehavior, interval},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    ControllerObservationBatch, ControllerStatusMapper, ProfileMappingContext,
    SelectionTargetError, StatusMappingError,
};

const STARTING_MESSAGE: &str = "Connecting to the configured Mihomo Controller";

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
    mapper: Option<ControllerStatusMapper>,
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
            mapper: None,
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

struct SourceInner {
    authority: AsyncMutex<()>,
    cancellation: CancellationToken,
    client: ControllerClient,
    command: AsyncMutex<()>,
    confirmation_timeout: Duration,
    lifecycle: Arc<dyn CoreRuntime>,
    profile: ProfileMappingContext,
    reconnect_delay: Duration,
    refresh_interval: Duration,
    state: Mutex<SourceState>,
    status_events: OnceLock<CoreStatusEventSink>,
}

pub struct ControllerStatusSource {
    closed: AtomicBool,
    inner: Arc<SourceInner>,
    started: AtomicBool,
    task: AsyncMutex<Option<JoinHandle<()>>>,
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
        Ok(Arc::new(Self {
            closed: AtomicBool::new(false),
            inner: Arc::new(SourceInner {
                authority: AsyncMutex::new(()),
                cancellation: CancellationToken::new(),
                client,
                command: AsyncMutex::new(()),
                confirmation_timeout: config.confirmation_timeout,
                lifecycle,
                profile: config.profile,
                reconnect_delay: config.reconnect_delay,
                refresh_interval: config.refresh_interval,
                state: Mutex::new(SourceState::new()),
                status_events: OnceLock::new(),
            }),
            started: AtomicBool::new(false),
            task: AsyncMutex::new(None),
        }))
    }

    pub async fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut task = self.task.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let inner = self.inner.clone();
        *task = Some(tokio::spawn(run_collector(inner)));
    }

    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.inner.cancellation.cancel();
        self.inner.client.shutdown();
        if let Some(task) = self.task.lock().await.take() {
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
        snapshot
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.close())
    }

    fn supports_command(&self, command: StatusCommand) -> bool {
        !self.closed.load(Ordering::Acquire)
            && matches!(command, StatusCommand::Routing | StatusCommand::Group)
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
}

impl ControllerStatusSource {
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
        let stale = state.diagnostics.contains_key(&ObservationChannel::Session)
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
}

async fn run_collector(inner: Arc<SourceInner>) {
    loop {
        if inner.cancellation.is_cancelled() {
            return;
        }
        match observe_session(&inner).await {
            Ok(()) => return,
            Err(_) if inner.cancellation.is_cancelled() => return,
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
            _ = tokio::time::sleep(inner.reconnect_delay) => {}
        }
    }
}

async fn observe_session(inner: &Arc<SourceInner>) -> Result<(), ControllerStatusSourceError> {
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
    apply_observations(
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
                ).await;
            }
            sample = memory.next() => {
                let sample = stream_item(sample, &inner.client, Endpoint::Memory)?;
                apply_channel_observation(
                    inner,
                    ObservationChannel::Memory,
                    ControllerObservationBatch { memory: Some(sample), ..Default::default() },
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
                ).await;
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
) {
    match apply_observations(inner, batch, false).await {
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

async fn apply_observations(
    inner: &Arc<SourceInner>,
    batch: ControllerObservationBatch,
    new_session: bool,
) -> Result<(), StatusMappingError> {
    let traffic_changed = batch.connections.is_some() || batch.rules.is_some();
    {
        let mut state = inner
            .state
            .lock()
            .expect("controller source state poisoned");
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
    inner
        .state
        .lock()
        .expect("controller source state poisoned")
        .diagnostics
        .insert(
            channel,
            format!("Mihomo Controller observation failed: {detail}"),
        );
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
