use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures_util::future::{BoxFuture, pending, ready};
use mish_bridge::{
    DesktopLifecycleCoordinator, DesktopRuntimeHost, LifecycleAuthorityState,
    LifecycleEventDisposition, LifecycleRecoveryState,
};
use mish_runtime::{
    CaptureFailureKind, CaptureJournal, CaptureJournalStore, CaptureOperationPhase,
    CapturePlatform, CaptureReconciler, CaptureRequest, CaptureSelection, CaptureTransitionError,
    CoreError, CoreLifecycleCommand, CoreLifecycleMutation, CorePhase, CoreRuntime, CoreStatus,
    LoopbackProxyEndpoint, ManualProxyState, MishRuntime, NetworkServiceProxyState,
    NotificationSeverity, PlatformLifecycleEvent, PlatformLifecycleEventKind,
    PlatformLifecycleEventSource, PlatformSleepObservation, PlatformSleepObservationError,
    PlatformSleepState, RuntimeObservationPauseReason, StatusAdapterKind, StatusDataSource,
    StatusSnapshot, SystemProxyPhase, TrafficDataPhase, TrafficDataSnapshot, TrafficDataSource,
};
use mish_settings::{
    DnsObservation, FileSettingsRepository, NetworkDnsObservation, NetworkDnsObservationError,
    NetworkDnsPhase, NetworkDnsPlatform, NetworkDnsSource, NetworkInterfaceKind,
    NetworkInterfaceObservation, SettingsAdapterKind, SettingsCapabilities, SettingsService,
};
use tokio::sync::{Notify, broadcast};

struct FakePlatformEventSource {
    events: broadcast::Sender<PlatformLifecycleEvent>,
    observation: Mutex<FakeSleepObservation>,
}

#[derive(Clone, Copy)]
enum FakeSleepObservation {
    Pending,
    Ready(Result<PlatformSleepObservation, PlatformSleepObservationError>),
}

impl FakePlatformEventSource {
    fn new() -> Self {
        let (events, _) = broadcast::channel(16);
        Self {
            events,
            observation: Mutex::new(FakeSleepObservation::Ready(Ok(PlatformSleepObservation {
                sequence: 0,
                state: PlatformSleepState::Awake,
            }))),
        }
    }

    fn emit(&self, sequence: u64, kind: PlatformLifecycleEventKind) {
        let state = match kind {
            PlatformLifecycleEventKind::Sleep => PlatformSleepState::Sleeping,
            PlatformLifecycleEventKind::Wake => PlatformSleepState::Awake,
            PlatformLifecycleEventKind::NetworkChanged => self
                .ready_observation()
                .map_or(PlatformSleepState::Awake, |observation| observation.state),
        };
        self.set_observation(sequence, state);
        self.events
            .send(PlatformLifecycleEvent { kind, sequence })
            .unwrap();
    }

    fn set_observation(&self, sequence: u64, state: PlatformSleepState) {
        *self.observation.lock().unwrap() =
            FakeSleepObservation::Ready(Ok(PlatformSleepObservation { sequence, state }));
    }

    fn fail_observation(&self) {
        *self.observation.lock().unwrap() =
            FakeSleepObservation::Ready(Err(PlatformSleepObservationError::Unavailable));
    }

    fn block_observation(&self) {
        *self.observation.lock().unwrap() = FakeSleepObservation::Pending;
    }

    fn ready_observation(&self) -> Option<PlatformSleepObservation> {
        match *self.observation.lock().unwrap() {
            FakeSleepObservation::Ready(Ok(observation)) => Some(observation),
            FakeSleepObservation::Pending | FakeSleepObservation::Ready(Err(_)) => None,
        }
    }
}

impl PlatformLifecycleEventSource for FakePlatformEventSource {
    fn subscribe(&self) -> broadcast::Receiver<PlatformLifecycleEvent> {
        self.events.subscribe()
    }

    fn observe_sleep_state(
        &self,
    ) -> BoxFuture<'_, Result<PlatformSleepObservation, PlatformSleepObservationError>> {
        match *self.observation.lock().unwrap() {
            FakeSleepObservation::Pending => Box::pin(pending()),
            FakeSleepObservation::Ready(observation) => Box::pin(ready(observation)),
        }
    }
}

struct TestCore {
    status: Mutex<CoreStatus>,
}

impl TestCore {
    fn running() -> Self {
        Self {
            status: Mutex::new(CoreStatus {
                error: None,
                phase: CorePhase::Running,
                pid: Some(42),
                version: Some("v1.19.29".into()),
            }),
        }
    }

    fn set_phase(&self, phase: CorePhase) {
        let mut status = self.status.lock().unwrap();
        status.phase = phase;
        status.pid = matches!(phase, CorePhase::Running).then_some(42);
        status.error = matches!(phase, CorePhase::Failed).then(|| "Synthetic core failure".into());
    }
}

impl CoreRuntime for TestCore {
    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(self.status.lock().unwrap().clone()))
    }

    fn execute_lifecycle(
        &self,
        command: CoreLifecycleCommand,
    ) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        self.set_phase(if command.mutation() == CoreLifecycleMutation::Start {
            CorePhase::Running
        } else {
            CorePhase::Stopped
        });
        Box::pin(ready(Ok(self.status.lock().unwrap().clone())))
    }
}

#[derive(Default)]
struct ObservationState {
    pauses: Vec<RuntimeObservationPauseReason>,
    resumes: usize,
}

struct RecordingSource {
    block_sleep: Option<(Arc<Notify>, Arc<Notify>)>,
    state: Mutex<ObservationState>,
}

impl RecordingSource {
    fn new() -> Self {
        Self {
            block_sleep: None,
            state: Mutex::new(ObservationState::default()),
        }
    }

    fn blocking_sleep(started: Arc<Notify>, release: Arc<Notify>) -> Self {
        Self {
            block_sleep: Some((started, release)),
            state: Mutex::new(ObservationState::default()),
        }
    }

    fn pauses(&self) -> Vec<RuntimeObservationPauseReason> {
        self.state.lock().unwrap().pauses.clone()
    }

    fn resume_count(&self) -> usize {
        self.state.lock().unwrap().resumes
    }
}

impl StatusDataSource for RecordingSource {
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        StatusSnapshot::lifecycle_only(core, adapter_kind)
    }

    fn profile_id(&self) -> Option<String> {
        Some("profile-a".into())
    }

    fn pause_observations(&self, reason: RuntimeObservationPauseReason) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.state.lock().unwrap().pauses.push(reason);
            if reason == RuntimeObservationPauseReason::Sleep
                && let Some((started, release)) = &self.block_sleep
            {
                started.notify_one();
                release.notified().await;
            }
        })
    }

    fn resume_observations(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.state.lock().unwrap().resumes += 1;
        })
    }
}

impl TrafficDataSource for RecordingSource {
    fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot {
        let mut snapshot = TrafficDataSnapshot::unavailable(adapter_kind);
        snapshot.phase = TrafficDataPhase::Ready;
        snapshot.session_id = Some("recording-session".into());
        snapshot
    }
}

#[derive(Default)]
struct RecordingNetworkDnsPlatform(AtomicUsize);

impl NetworkDnsPlatform for RecordingNetworkDnsPlatform {
    fn observe(&self) -> BoxFuture<'_, Result<NetworkDnsObservation, NetworkDnsObservationError>> {
        self.0.fetch_add(1, Ordering::AcqRel);
        Box::pin(ready(Ok(NetworkDnsObservation {
            dns: DnsObservation {
                resolver_count: 1,
                scoped_resolver_count: 0,
                search_domains: Vec::new(),
                servers: vec!["192.0.2.53".into()],
            },
            interfaces: vec![NetworkInterfaceObservation {
                interface: "en0".into(),
                interface_kind: NetworkInterfaceKind::Ethernet,
                ipv4_available: true,
                ipv6_available: false,
                service: Some("Test Ethernet".into()),
            }],
            source: NetworkDnsSource::MacosSystemConfiguration,
        })))
    }
}

#[derive(Default)]
struct MemoryJournal {
    journal: Mutex<Option<CaptureJournal>>,
}

impl CaptureJournalStore for MemoryJournal {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        Ok(self.journal.lock().unwrap().clone())
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        *self.journal.lock().unwrap() = Some(journal.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        *self.journal.lock().unwrap() = None;
        Ok(())
    }
}

struct FakeCapturePlatform {
    active_service: Mutex<String>,
    listener_ready: Mutex<bool>,
    observations: AtomicUsize,
    services: Mutex<HashMap<String, NetworkServiceProxyState>>,
}

impl FakeCapturePlatform {
    fn new(service: NetworkServiceProxyState) -> Self {
        Self {
            active_service: Mutex::new(service.service_id.clone()),
            listener_ready: Mutex::new(true),
            observations: AtomicUsize::new(0),
            services: Mutex::new(HashMap::from([(service.service_id.clone(), service)])),
        }
    }

    fn service(&self, service_id: &str) -> NetworkServiceProxyState {
        self.services.lock().unwrap()[service_id].clone()
    }

    fn switch_service(&self, service: NetworkServiceProxyState) {
        *self.active_service.lock().unwrap() = service.service_id.clone();
        self.services
            .lock()
            .unwrap()
            .insert(service.service_id.clone(), service);
    }

    fn replace_service(&self, service: NetworkServiceProxyState) {
        self.services
            .lock()
            .unwrap()
            .insert(service.service_id.clone(), service);
    }

    fn set_listener_ready(&self, ready: bool) {
        *self.listener_ready.lock().unwrap() = ready;
    }

    fn observation_count(&self) -> usize {
        self.observations.load(Ordering::Acquire)
    }
}

impl CapturePlatform for FakeCapturePlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        self.observations.fetch_add(1, Ordering::AcqRel);
        let service = self.active_service.lock().unwrap().clone();
        Box::pin(ready(Ok(self.services.lock().unwrap()[&service].clone())))
    }

    fn observe_service(
        &self,
        service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        self.observations.fetch_add(1, Ordering::AcqRel);
        Box::pin(ready(Ok(self.services.lock().unwrap()[service_id].clone())))
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        self.services
            .lock()
            .unwrap()
            .insert(target.service_id.clone(), target);
        Box::pin(ready(Ok(())))
    }

    fn confirm_proxy_listener(
        &self,
        _endpoint: &LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        if *self.listener_ready.lock().unwrap() {
            return Box::pin(ready(Ok(())));
        }
        Box::pin(ready(Err(CaptureTransitionError::new(
            CaptureFailureKind::ListenerUnavailable,
            "Synthetic listener failure",
        ))))
    }
}

struct Fixture {
    capture: Arc<CaptureReconciler>,
    coordinator: DesktopLifecycleCoordinator,
    core: Arc<TestCore>,
    host: DesktopRuntimeHost,
    platform: Arc<FakeCapturePlatform>,
    runtime: MishRuntime,
    source: Arc<RecordingSource>,
}

fn fixture(source: Arc<RecordingSource>) -> Fixture {
    let core = Arc::new(TestCore::running());
    let platform = Arc::new(FakeCapturePlatform::new(disabled_service("service-a")));
    let capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        Arc::new(MemoryJournal::default()),
        LoopbackProxyEndpoint::managed(),
    ));
    let runtime = MishRuntime::with_data_sources_and_capture(
        core.clone(),
        source.clone(),
        source.clone(),
        Some(capture.clone()),
    );
    let host = DesktopRuntimeHost::new(runtime.clone());
    Fixture {
        capture,
        coordinator: DesktopLifecycleCoordinator::new(host.clone()),
        core,
        host,
        platform,
        runtime,
        source,
    }
}

#[tokio::test]
async fn planned_runtime_handoff_does_not_restore_capture_before_the_owner_commits() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    let transition = fixture.capture.clone().begin_runtime_transition().unwrap();
    fixture
        .capture
        .reconcile_runtime_transition(
            &transition,
            CaptureRequest {
                active: false,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            false,
        )
        .await
        .unwrap();

    fixture
        .coordinator
        .handle_core_availability(true)
        .await
        .unwrap();

    let status = fixture
        .runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(status.runtime.system_proxy.phase, SystemProxyPhase::Off);
    assert!(!status.runtime.system_proxy.desired);
    assert_eq!(
        fixture.platform.service("service-a"),
        disabled_service("service-a")
    );
    assert!(
        fixture
            .runtime
            .notification_snapshot()
            .notifications
            .is_empty()
    );
    drop(transition);
}

#[tokio::test]
async fn runtime_replacement_does_not_restore_an_inactive_capture_selection() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    fixture
        .runtime
        .set_capture(
            CaptureRequest {
                active: false,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            StatusAdapterKind::Rpc,
        )
        .await
        .unwrap();

    fixture
        .coordinator
        .handle_runtime_replacement(true)
        .await
        .unwrap();

    let status = fixture
        .runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert!(status.runtime.capture_selection.system_proxy);
    assert_eq!(status.runtime.system_proxy.phase, SystemProxyPhase::Off);
    assert!(!status.runtime.system_proxy.desired);
    assert_eq!(
        fixture.platform.service("service-a"),
        disabled_service("service-a")
    );
}

async fn enable_capture(runtime: &MishRuntime) {
    runtime
        .set_capture(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            StatusAdapterKind::Rpc,
        )
        .await
        .unwrap();
}

async fn deliver(
    source: &FakePlatformEventSource,
    receiver: &mut broadcast::Receiver<PlatformLifecycleEvent>,
    coordinator: &DesktopLifecycleCoordinator,
    sequence: u64,
    kind: PlatformLifecycleEventKind,
) -> Result<LifecycleEventDisposition, mish_bridge::LifecycleCoordinationError> {
    source.emit(sequence, kind);
    coordinator
        .handle_platform_event(receiver.recv().await.unwrap())
        .await
}

#[tokio::test]
async fn fake_sleep_and_wake_events_pause_then_rebuild_observation_authority() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = FakePlatformEventSource::new();
    let mut receiver = events.subscribe();

    deliver(
        &events,
        &mut receiver,
        &fixture.coordinator,
        1,
        PlatformLifecycleEventKind::Sleep,
    )
    .await
    .unwrap();
    deliver(
        &events,
        &mut receiver,
        &fixture.coordinator,
        2,
        PlatformLifecycleEventKind::Wake,
    )
    .await
    .unwrap();

    assert_eq!(
        fixture.source.pauses(),
        [RuntimeObservationPauseReason::Sleep]
    );
    assert_eq!(fixture.source.resume_count(), 1);
}

#[tokio::test]
async fn startup_observation_closes_the_pre_subscription_sleep_window() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = Arc::new(FakePlatformEventSource::new());
    events.set_observation(4, PlatformSleepState::Sleeping);
    let coordinator = DesktopLifecycleCoordinator::with_platform_source(fixture.host, None, events);

    coordinator.initialize_platform_authority().await;

    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.generation, 1);
    assert_eq!(authority.sequence, 4);
    assert_eq!(authority.state, LifecycleAuthorityState::Sleeping);
    assert_eq!(authority.recovery, LifecycleRecoveryState::Current);
    assert_eq!(
        fixture.source.pauses(),
        [RuntimeObservationPauseReason::Sleep]
    );
    assert_eq!(fixture.source.resume_count(), 0);
}

#[tokio::test]
async fn lifecycle_boundaries_mark_network_dns_stale_before_reobservation() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let root = tempfile::tempdir().unwrap();
    let platform = Arc::new(RecordingNetworkDnsPlatform::default());
    let settings = Arc::new(
        SettingsService::load_with_platforms(
            Arc::new(FileSettingsRepository::new(
                root.path().join("settings.json"),
            )),
            None,
            None,
            SettingsCapabilities::macos(false),
            None,
            Some(platform.clone()),
        )
        .unwrap(),
    );
    let coordinator = DesktopLifecycleCoordinator::with_settings(
        DesktopRuntimeHost::new(fixture.runtime.clone()),
        Some(settings.clone()),
    );
    let mut updates = settings.subscribe();
    let initial = settings.snapshot(SettingsAdapterKind::Rpc);
    let ready = settings.refresh_network_dns().await;
    assert_eq!(
        updates
            .recv()
            .await
            .expect("startup observation publication"),
        ready
    );
    assert_eq!(ready.revision, initial.revision);
    assert!(ready.application_order.order > initial.application_order.order);
    assert_eq!(
        settings
            .snapshot(SettingsAdapterKind::Rpc)
            .network_dns
            .phase,
        NetworkDnsPhase::Ready
    );

    coordinator
        .handle_platform_event(PlatformLifecycleEvent {
            kind: PlatformLifecycleEventKind::Sleep,
            sequence: 1,
        })
        .await
        .unwrap();
    let sleep_stale = updates
        .recv()
        .await
        .expect("sleep invalidation publication");
    assert_eq!(sleep_stale.network_dns.phase, NetworkDnsPhase::Stale);
    assert_eq!(sleep_stale.revision, ready.revision);
    assert!(sleep_stale.application_order.order > ready.application_order.order);
    assert_eq!(
        settings
            .snapshot(SettingsAdapterKind::Rpc)
            .network_dns
            .phase,
        NetworkDnsPhase::Stale
    );

    coordinator
        .handle_platform_event(PlatformLifecycleEvent {
            kind: PlatformLifecycleEventKind::Wake,
            sequence: 2,
        })
        .await
        .unwrap();
    let wake_stale = updates.recv().await.expect("wake invalidation publication");
    let wake_ready = updates.recv().await.expect("wake refresh publication");
    assert_eq!(wake_stale.network_dns.phase, NetworkDnsPhase::Stale);
    assert_eq!(wake_ready.network_dns.phase, NetworkDnsPhase::Ready);
    assert_eq!(wake_ready.revision, ready.revision);
    assert!(wake_ready.application_order.order > wake_stale.application_order.order);
    assert_eq!(
        settings
            .snapshot(SettingsAdapterKind::Rpc)
            .network_dns
            .phase,
        NetworkDnsPhase::Ready
    );

    coordinator.handle_core_availability(false).await.unwrap();
    assert_eq!(
        settings
            .snapshot(SettingsAdapterKind::Rpc)
            .network_dns
            .phase,
        NetworkDnsPhase::Stale
    );
    coordinator.handle_core_availability(true).await.unwrap();
    assert_eq!(
        settings
            .snapshot(SettingsAdapterKind::Rpc)
            .network_dns
            .phase,
        NetworkDnsPhase::Ready
    );
    assert_eq!(platform.0.load(Ordering::Acquire), 3);
}

#[tokio::test]
async fn network_change_restores_the_old_service_before_applying_explicit_intent_to_the_new_one() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    let prior_a = disabled_service("service-a");
    let prior_b = disabled_service("service-b");
    fixture.platform.switch_service(prior_b.clone());
    let events = FakePlatformEventSource::new();
    let mut receiver = events.subscribe();

    deliver(
        &events,
        &mut receiver,
        &fixture.coordinator,
        1,
        PlatformLifecycleEventKind::NetworkChanged,
    )
    .await
    .unwrap();

    assert_eq!(fixture.platform.service("service-a"), prior_a);
    assert!(
        fixture
            .platform
            .service("service-b")
            .is_mish_endpoint(&LoopbackProxyEndpoint::managed())
    );
    assert_eq!(fixture.source.resume_count(), 1);
}

#[tokio::test]
async fn core_crash_and_restart_drop_old_authority_and_restore_explicit_capture_intent() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    let started = fixture.runtime.recent_traffic().snapshot();
    fixture.core.set_phase(CorePhase::Failed);

    fixture
        .coordinator
        .handle_core_availability(false)
        .await
        .unwrap();

    assert_eq!(
        fixture.platform.service("service-a"),
        disabled_service("service-a")
    );
    assert_eq!(
        fixture.source.pauses(),
        [RuntimeObservationPauseReason::CoreUnavailable]
    );
    let suspended = fixture.runtime.recent_traffic().snapshot();
    assert_eq!(suspended.phase, mish_runtime::RecentTrafficPhase::Suspended);
    assert_eq!(suspended.session_id, started.session_id);

    fixture.core.set_phase(CorePhase::Running);
    fixture
        .coordinator
        .handle_core_availability(true)
        .await
        .unwrap();

    assert!(
        fixture
            .platform
            .service("service-a")
            .is_mish_endpoint(&LoopbackProxyEndpoint::managed())
    );
    assert_eq!(fixture.source.resume_count(), 1);
    let resumed = fixture.runtime.recent_traffic().snapshot();
    assert_eq!(resumed.phase, mish_runtime::RecentTrafficPhase::Active);
    assert_eq!(resumed.session_id, started.session_id);
}

#[tokio::test]
async fn failed_restart_recovery_is_typed_and_never_published_as_applied() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    fixture.core.set_phase(CorePhase::Failed);
    fixture
        .coordinator
        .handle_core_availability(false)
        .await
        .unwrap();
    fixture.platform.set_listener_ready(false);
    fixture.core.set_phase(CorePhase::Running);

    let error = fixture
        .coordinator
        .handle_core_availability(true)
        .await
        .unwrap_err();

    assert_eq!(
        error.capture_failure,
        CaptureFailureKind::ListenerUnavailable
    );
    let snapshot = fixture
        .runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(
        snapshot.runtime.system_proxy.phase,
        SystemProxyPhase::Failed
    );
    assert!(!snapshot.runtime.system_proxy_enabled);
    assert_eq!(
        snapshot.recent_traffic.phase,
        mish_runtime::RecentTrafficPhase::Idle
    );
}

#[tokio::test]
async fn pending_aggregate_launch_does_not_commit_a_transient_capture_failure() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    fixture.platform.set_listener_ready(false);
    let _operation = fixture
        .runtime
        .publish_capture_pending(&CaptureRequest {
            active: true,
            selection: CaptureSelection {
                system_proxy: true,
                tun: false,
            },
        })
        .await
        .unwrap();

    let error = fixture
        .coordinator
        .handle_core_availability(true)
        .await
        .unwrap_err();

    assert_eq!(error.capture_failure, CaptureFailureKind::RuntimeTransition);
    assert_eq!(
        fixture
            .runtime
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await
            .runtime
            .capture_operation
            .phase,
        mish_runtime::CaptureOperationPhase::Pending
    );
    assert!(
        fixture
            .runtime
            .notification_snapshot()
            .notifications
            .is_empty()
    );
}

#[tokio::test]
async fn self_induced_network_change_does_not_interrupt_a_pending_capture_operation() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let _operation = fixture
        .runtime
        .publish_capture_pending(&CaptureRequest {
            active: true,
            selection: CaptureSelection {
                system_proxy: false,
                tun: true,
            },
        })
        .await
        .unwrap();

    assert_eq!(
        fixture
            .coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::NetworkChanged,
                sequence: 1,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::Applied
    );
    assert!(fixture.source.pauses().is_empty());
    assert_eq!(
        fixture
            .runtime
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await
            .runtime
            .capture_operation
            .phase,
        mish_runtime::CaptureOperationPhase::Pending
    );
}

#[tokio::test]
async fn periodic_lifecycle_audits_publish_only_a_real_capture_transition() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    let terminal = fixture
        .runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await
        .runtime
        .capture_operation;
    let mut updates = fixture.runtime.subscribe_capture().unwrap();

    for _ in 0..3 {
        fixture.coordinator.periodic_audit().await.unwrap();
        let audited = fixture
            .runtime
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(audited.runtime.capture_operation, terminal);
        assert_eq!(
            updates.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        );
    }

    let mut drifted = fixture.platform.service("service-a");
    drifted.http.host = "external.proxy.example".into();
    drifted.https.host = "external.proxy.example".into();
    fixture.platform.replace_service(drifted);
    fixture.coordinator.periodic_audit().await.unwrap();

    let pending = updates.recv().await.unwrap();
    let recovery_required = updates.recv().await.unwrap();
    assert_eq!(
        pending.capture_operation.phase,
        CaptureOperationPhase::Pending
    );
    assert_eq!(
        recovery_required.capture_operation.phase,
        CaptureOperationPhase::RecoveryRequired
    );
    assert_ne!(
        recovery_required.capture_operation.operation_id,
        terminal.operation_id
    );
}

#[tokio::test]
async fn terminal_capture_failure_is_resolved_without_deleting_history_after_retry() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let request = CaptureRequest {
        active: true,
        selection: CaptureSelection {
            system_proxy: true,
            tun: false,
        },
    };
    fixture.platform.set_listener_ready(false);
    fixture
        .runtime
        .set_capture(request.clone(), StatusAdapterKind::Rpc)
        .await
        .unwrap_err();
    let failed = fixture.runtime.notification_snapshot();
    assert_eq!(failed.notifications.len(), 1);
    assert!(!failed.notifications[0].resolved);
    assert_eq!(
        failed.notifications[0].severity,
        NotificationSeverity::Error
    );

    fixture.platform.set_listener_ready(true);
    fixture
        .runtime
        .set_capture(request, StatusAdapterKind::Rpc)
        .await
        .unwrap();

    let resolved = fixture.runtime.notification_snapshot();
    assert_eq!(resolved.notifications.len(), 1);
    assert_eq!(resolved.notifications[0].id, failed.notifications[0].id);
    assert!(resolved.notifications[0].resolved);
    assert_eq!(
        resolved.notifications[0].severity,
        NotificationSeverity::Error
    );
}

#[tokio::test]
async fn concurrent_older_platform_event_is_ignored_after_a_newer_transition_starts() {
    let sleep_started = Arc::new(Notify::new());
    let sleep_release = Arc::new(Notify::new());
    let fixture = fixture(Arc::new(RecordingSource::blocking_sleep(
        sleep_started.clone(),
        sleep_release.clone(),
    )));
    let newer = fixture.coordinator.clone();
    let newer_task = tokio::spawn(async move {
        newer
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::Sleep,
                sequence: 2,
            })
            .await
    });
    sleep_started.notified().await;
    let older = fixture.coordinator.clone();
    let older_task = tokio::spawn(async move {
        older
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::NetworkChanged,
                sequence: 1,
            })
            .await
    });
    sleep_release.notify_one();

    assert_eq!(
        newer_task.await.unwrap().unwrap(),
        LifecycleEventDisposition::Applied
    );
    assert_eq!(
        older_task.await.unwrap().unwrap(),
        LifecycleEventDisposition::StaleIgnored
    );
    assert_eq!(
        fixture.source.pauses(),
        [RuntimeObservationPauseReason::Sleep]
    );
}

#[tokio::test]
async fn lost_wake_gap_recovers_from_one_authoritative_awake_observation() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    let initial_recent = fixture.runtime.recent_traffic().snapshot();
    let events = Arc::new(FakePlatformEventSource::new());
    let coordinator = DesktopLifecycleCoordinator::with_platform_source(
        fixture.host.clone(),
        None,
        events.clone(),
    );

    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::Sleep,
                sequence: 1,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::Applied
    );
    events.set_observation(3, PlatformSleepState::Awake);
    let capture_observations = fixture.platform.observation_count();

    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::NetworkChanged,
                sequence: 3,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::RecoveredAfterGap
    );

    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.generation, 2);
    assert_eq!(authority.sequence, 3);
    assert_eq!(authority.state, LifecycleAuthorityState::Awake);
    assert_eq!(authority.recovery, LifecycleRecoveryState::Current);
    assert_eq!(fixture.source.resume_count(), 1);
    assert!(fixture.platform.observation_count() > capture_observations);
    let recovered_recent = fixture.runtime.recent_traffic().snapshot();
    assert_eq!(
        recovered_recent.phase,
        mish_runtime::RecentTrafficPhase::Active
    );
    assert_ne!(recovered_recent.session_id, initial_recent.session_id);
}

#[tokio::test]
async fn gap_observation_can_confirm_sleeping_without_resuming_consumers() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = Arc::new(FakePlatformEventSource::new());
    let coordinator =
        DesktopLifecycleCoordinator::with_platform_source(fixture.host, None, events.clone());
    coordinator
        .handle_platform_event(PlatformLifecycleEvent {
            kind: PlatformLifecycleEventKind::Sleep,
            sequence: 1,
        })
        .await
        .unwrap();
    events.set_observation(3, PlatformSleepState::Sleeping);

    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::NetworkChanged,
                sequence: 3,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::RecoveredAfterGap
    );
    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.generation, 2);
    assert_eq!(authority.sequence, 3);
    assert_eq!(authority.state, LifecycleAuthorityState::Sleeping);
    assert_eq!(authority.recovery, LifecycleRecoveryState::Current);
    assert_eq!(fixture.source.resume_count(), 0);
}

#[tokio::test]
async fn lagged_broadcast_receiver_recovers_the_latest_platform_sequence() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = Arc::new(FakePlatformEventSource::new());
    let mut receiver = events.subscribe();
    let coordinator =
        DesktopLifecycleCoordinator::with_platform_source(fixture.host, None, events.clone());
    events.emit(1, PlatformLifecycleEventKind::Sleep);
    coordinator
        .handle_platform_event(receiver.recv().await.unwrap())
        .await
        .unwrap();
    events.emit(2, PlatformLifecycleEventKind::Wake);
    for sequence in 3..=20 {
        events.emit(sequence, PlatformLifecycleEventKind::NetworkChanged);
    }
    assert!(matches!(
        receiver.recv().await,
        Err(broadcast::error::RecvError::Lagged(_))
    ));

    coordinator.reconcile_after_event_gap().await.unwrap();

    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.generation, 2);
    assert_eq!(authority.sequence, 20);
    assert_eq!(authority.state, LifecycleAuthorityState::Awake);
    assert_eq!(authority.recovery, LifecycleRecoveryState::Current);
    assert_eq!(fixture.source.resume_count(), 1);
}

#[tokio::test]
async fn sleeping_and_unknown_authority_admit_no_resume_audit_or_network_dns_refresh() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    enable_capture(&fixture.runtime).await;
    let root = tempfile::tempdir().unwrap();
    let network_dns = Arc::new(RecordingNetworkDnsPlatform::default());
    let settings = Arc::new(
        SettingsService::load_with_platforms(
            Arc::new(FileSettingsRepository::new(
                root.path().join("settings.json"),
            )),
            None,
            None,
            SettingsCapabilities::macos(false),
            None,
            Some(network_dns.clone()),
        )
        .unwrap(),
    );
    settings.refresh_network_dns().await;
    let events = Arc::new(FakePlatformEventSource::new());
    let coordinator = DesktopLifecycleCoordinator::with_platform_source(
        fixture.host.clone(),
        Some(settings),
        events.clone(),
    );

    coordinator
        .handle_platform_event(PlatformLifecycleEvent {
            kind: PlatformLifecycleEventKind::Sleep,
            sequence: 1,
        })
        .await
        .unwrap();
    let capture_observations = fixture.platform.observation_count();
    coordinator
        .handle_platform_event(PlatformLifecycleEvent {
            kind: PlatformLifecycleEventKind::NetworkChanged,
            sequence: 2,
        })
        .await
        .unwrap();
    coordinator.periodic_audit().await.unwrap();
    coordinator.handle_core_availability(true).await.unwrap();
    coordinator.handle_runtime_replacement(true).await.unwrap();
    assert_eq!(fixture.source.resume_count(), 0);
    assert_eq!(fixture.platform.observation_count(), capture_observations);
    assert_eq!(network_dns.0.load(Ordering::Acquire), 1);

    events.fail_observation();
    coordinator.reconcile_after_event_gap().await.unwrap();
    assert_eq!(
        coordinator.authority_snapshot().state,
        LifecycleAuthorityState::UnknownAfterGap
    );
    assert_eq!(
        coordinator.authority_snapshot().recovery,
        LifecycleRecoveryState::ObservationUnavailable
    );
    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::NetworkChanged,
                sequence: 3,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::AwaitingRecovery
    );
    assert_eq!(
        coordinator.authority_snapshot().recovery,
        LifecycleRecoveryState::ObservationUnavailable
    );
    coordinator.periodic_audit().await.unwrap();
    coordinator.handle_core_availability(true).await.unwrap();
    coordinator.handle_runtime_replacement(true).await.unwrap();
    assert_eq!(fixture.source.resume_count(), 0);
    assert_eq!(fixture.platform.observation_count(), capture_observations);
    assert_eq!(network_dns.0.load(Ordering::Acquire), 1);
    assert_eq!(
        fixture.runtime.recent_traffic().snapshot().phase,
        mish_runtime::RecentTrafficPhase::Idle
    );

    events.set_observation(4, PlatformSleepState::Awake);
    coordinator.reconcile_after_event_gap().await.unwrap();
    assert_eq!(
        coordinator.authority_snapshot().state,
        LifecycleAuthorityState::Awake
    );
    assert_eq!(fixture.source.resume_count(), 1);
    assert_eq!(network_dns.0.load(Ordering::Acquire), 2);
}

#[tokio::test(start_paused = true)]
async fn bounded_platform_observation_timeout_remains_typed_unknown() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = Arc::new(FakePlatformEventSource::new());
    events.block_observation();
    let coordinator = DesktopLifecycleCoordinator::with_platform_source_and_timeout(
        fixture.host,
        None,
        Some(events),
        Duration::from_secs(5),
    );
    let recovery = {
        let coordinator = coordinator.clone();
        tokio::spawn(async move { coordinator.reconcile_after_event_gap().await })
    };
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(5)).await;
    recovery.await.unwrap().unwrap();

    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.state, LifecycleAuthorityState::UnknownAfterGap);
    assert_eq!(
        authority.recovery,
        LifecycleRecoveryState::ObservationTimedOut
    );
    assert_eq!(fixture.source.resume_count(), 0);
}

#[tokio::test]
async fn equal_sequence_observation_cannot_rewrite_the_last_confirmed_state() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = Arc::new(FakePlatformEventSource::new());
    let coordinator =
        DesktopLifecycleCoordinator::with_platform_source(fixture.host, None, events.clone());
    coordinator
        .handle_platform_event(PlatformLifecycleEvent {
            kind: PlatformLifecycleEventKind::Sleep,
            sequence: 1,
        })
        .await
        .unwrap();
    events.set_observation(1, PlatformSleepState::Awake);

    coordinator.reconcile_after_event_gap().await.unwrap();

    let authority = coordinator.authority_snapshot();
    assert_eq!(authority.sequence, 1);
    assert_eq!(authority.state, LifecycleAuthorityState::UnknownAfterGap);
    assert_eq!(authority.recovery, LifecycleRecoveryState::StaleObservation);
    assert_eq!(fixture.source.resume_count(), 0);
}

#[tokio::test]
async fn replacement_runtime_stays_paused_until_awake_authority_is_accepted() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = Arc::new(FakePlatformEventSource::new());
    events.fail_observation();
    let coordinator = DesktopLifecycleCoordinator::with_platform_source(
        fixture.host.clone(),
        None,
        events.clone(),
    );
    coordinator.reconcile_after_event_gap().await.unwrap();

    let replacement_source = Arc::new(RecordingSource::new());
    let replacement = MishRuntime::with_data_sources_and_capture(
        fixture.core.clone(),
        replacement_source.clone(),
        replacement_source.clone(),
        Some(fixture.capture.clone()),
    );
    fixture.host.replace(replacement);
    coordinator.handle_runtime_replacement(true).await.unwrap();
    assert_eq!(
        replacement_source.pauses(),
        [RuntimeObservationPauseReason::LifecycleGap]
    );
    assert_eq!(replacement_source.resume_count(), 0);

    events.set_observation(1, PlatformSleepState::Awake);
    coordinator.reconcile_after_event_gap().await.unwrap();
    assert_eq!(
        coordinator.authority_snapshot().state,
        LifecycleAuthorityState::Awake
    );
    assert_eq!(replacement_source.resume_count(), 1);
}

#[tokio::test]
async fn stale_duplicate_reordered_and_closed_streams_converge_without_reopening_authority() {
    let fixture = fixture(Arc::new(RecordingSource::new()));
    let events = Arc::new(FakePlatformEventSource::new());
    let coordinator = DesktopLifecycleCoordinator::with_platform_source(fixture.host, None, events);

    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::Sleep,
                sequence: 1,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::Applied
    );
    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::Sleep,
                sequence: 1,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::StaleIgnored
    );
    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::Wake,
                sequence: 2,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::Applied
    );
    assert_eq!(
        coordinator
            .handle_platform_event(PlatformLifecycleEvent {
                kind: PlatformLifecycleEventKind::Sleep,
                sequence: 1,
            })
            .await
            .unwrap(),
        LifecycleEventDisposition::StaleIgnored
    );
    assert_eq!(
        coordinator.authority_snapshot().state,
        LifecycleAuthorityState::Awake
    );

    let (closed_sender, mut closed_receiver) = broadcast::channel::<PlatformLifecycleEvent>(1);
    drop(closed_sender);
    assert_eq!(
        closed_receiver.recv().await,
        Err(broadcast::error::RecvError::Closed)
    );
    coordinator.handle_event_stream_closed().await;
    let closed = coordinator.authority_snapshot();
    assert_eq!(closed.generation, 2);
    assert_eq!(closed.sequence, 2);
    assert_eq!(closed.state, LifecycleAuthorityState::UnknownAfterGap);
    assert_eq!(closed.recovery, LifecycleRecoveryState::StreamClosed);
    let resumes = fixture.source.resume_count();
    coordinator.periodic_audit().await.unwrap();
    assert_eq!(fixture.source.resume_count(), resumes);
}

fn disabled_service(service_id: &str) -> NetworkServiceProxyState {
    NetworkServiceProxyState {
        auto_discovery_enabled: false,
        bypass_domains: Vec::new(),
        http: ManualProxyState::disabled(),
        https: ManualProxyState::disabled(),
        pac_enabled: false,
        pac_url: "(null)".into(),
        service_id: service_id.into(),
        socks: ManualProxyState::disabled(),
    }
}
