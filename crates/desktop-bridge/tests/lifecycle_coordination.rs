use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use futures_util::future::{BoxFuture, ready};
use mish_bridge::{DesktopLifecycleCoordinator, DesktopRuntimeHost, LifecycleEventDisposition};
use mish_runtime::{
    CaptureFailureKind, CaptureJournal, CaptureJournalStore, CapturePlatform, CaptureReconciler,
    CaptureRequest, CaptureSelection, CaptureTransitionError, CoreError, CorePhase, CoreRuntime,
    CoreStatus, LoopbackProxyEndpoint, ManualProxyState, MishRuntime, NetworkServiceProxyState,
    PlatformLifecycleEvent, PlatformLifecycleEventKind, PlatformLifecycleEventSource,
    RuntimeObservationPauseReason, StatusAdapterKind, StatusDataSource, StatusSnapshot,
    SystemProxyPhase, TrafficDataPhase, TrafficDataSnapshot, TrafficDataSource,
};
use mish_settings::{
    DnsObservation, FileSettingsRepository, NetworkDnsObservation, NetworkDnsObservationError,
    NetworkDnsPhase, NetworkDnsPlatform, NetworkDnsSource, NetworkInterfaceKind,
    NetworkInterfaceObservation, SettingsAdapterKind, SettingsCapabilities, SettingsService,
};
use tokio::sync::{Notify, broadcast};

struct FakePlatformEventSource {
    events: broadcast::Sender<PlatformLifecycleEvent>,
}

impl FakePlatformEventSource {
    fn new() -> Self {
        let (events, _) = broadcast::channel(16);
        Self { events }
    }

    fn emit(&self, sequence: u64, kind: PlatformLifecycleEventKind) {
        self.events
            .send(PlatformLifecycleEvent { kind, sequence })
            .unwrap();
    }
}

impl PlatformLifecycleEventSource for FakePlatformEventSource {
    fn subscribe(&self) -> broadcast::Receiver<PlatformLifecycleEvent> {
        self.events.subscribe()
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

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        self.set_phase(CorePhase::Running);
        Box::pin(ready(Ok(self.status.lock().unwrap().clone())))
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        self.set_phase(CorePhase::Stopped);
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
    services: Mutex<HashMap<String, NetworkServiceProxyState>>,
}

impl FakeCapturePlatform {
    fn new(service: NetworkServiceProxyState) -> Self {
        Self {
            active_service: Mutex::new(service.service_id.clone()),
            listener_ready: Mutex::new(true),
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

    fn set_listener_ready(&self, ready: bool) {
        *self.listener_ready.lock().unwrap() = ready;
    }
}

impl CapturePlatform for FakeCapturePlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        let service = self.active_service.lock().unwrap().clone();
        Box::pin(ready(Ok(self.services.lock().unwrap()[&service].clone())))
    }

    fn observe_service(
        &self,
        service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
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
    coordinator: DesktopLifecycleCoordinator,
    core: Arc<TestCore>,
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
        Some(capture),
    );
    let host = DesktopRuntimeHost::new(runtime.clone());
    Fixture {
        coordinator: DesktopLifecycleCoordinator::new(host),
        core,
        platform,
        runtime,
        source,
    }
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
        [
            RuntimeObservationPauseReason::Sleep,
            RuntimeObservationPauseReason::NetworkChanged,
        ]
    );
    assert_eq!(fixture.source.resume_count(), 1);
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
    settings.refresh_network_dns().await;
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
