use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};

use futures_util::future::{BoxFuture, ready};
use mish_runtime::{
    ApplicationDiagnosticEvent, CaptureJournal, CaptureJournalStore, CapturePlatform,
    CaptureReconciler, CaptureRequest, CaptureSelection, CaptureTransitionError, CoreError,
    CoreErrorKind, CorePhase, CoreRuntime, CoreStatus, CoreStatusEventSink, LoopbackProxyEndpoint,
    ManualProxyState, MishRuntime, NetworkServiceProxyState, NotificationPresentationCompletion,
    NotificationPresentationFoldReason, NotificationPresentationIdentity,
    NotificationPresentationPhase, ProfileSummary, RecentTrafficObservation,
    RuntimeShutdownFailure, StatusAdapterKind, StatusDataSource, StatusSnapshot,
};
use tokio::{
    sync::Notify,
    time::{Duration, timeout},
};

struct EmbeddedCore;

impl CoreRuntime for EmbeddedCore {
    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: Some("embedded-test".into()),
        }))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Ok(CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: None,
            version: Some("embedded-test".into()),
        })))
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Ok(CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: Some("embedded-test".into()),
        })))
    }
}

struct UnavailableCore;

struct SuppliedStatusSource;

struct PublishingStatusSource {
    observation: Mutex<Option<RecentTrafficObservation>>,
    sink: OnceLock<CoreStatusEventSink>,
}

struct ShutdownRecordingSource {
    order: Arc<Mutex<Vec<&'static str>>>,
}

struct ShutdownRecordingCore {
    order: Arc<Mutex<Vec<&'static str>>>,
}

struct UnreadableShutdownJournal;

impl CaptureJournalStore for UnreadableShutdownJournal {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        Err(CaptureTransitionError::new(
            mish_runtime::CaptureFailureKind::InvalidRecovery,
            "Synthetic unreadable shutdown journal",
        ))
    }

    fn save(&self, _journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        unreachable!("shutdown must fail before saving an unreadable journal")
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        unreachable!("shutdown must not clear an unreadable journal")
    }
}

struct ShutdownCapturePlatform;

struct UnobservableUnownedShutdownPlatform;

struct BlockingShutdownObservationPlatform {
    block_next_observation: AtomicBool,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    state: Mutex<NetworkServiceProxyState>,
}

struct RecordingShutdownPlatform {
    order: Arc<Mutex<Vec<&'static str>>>,
    state: Mutex<NetworkServiceProxyState>,
}

#[derive(Default)]
struct MemoryShutdownJournal(Mutex<Option<CaptureJournal>>);

impl CaptureJournalStore for MemoryShutdownJournal {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        *self.0.lock().unwrap() = Some(journal.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

impl CapturePlatform for RecordingShutdownPlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.state.lock().unwrap().clone())))
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.state.lock().unwrap().clone())))
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        self.order.lock().unwrap().push("capture");
        *self.state.lock().unwrap() = target;
        Box::pin(ready(Ok(())))
    }
}

impl CapturePlatform for ShutdownCapturePlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(disabled_proxy_state())))
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(disabled_proxy_state())))
    }

    fn apply_service(
        &self,
        _target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        unreachable!("an unreadable journal must fail before a proxy write")
    }
}

impl CapturePlatform for UnobservableUnownedShutdownPlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Err(CaptureTransitionError::new(
            mish_runtime::CaptureFailureKind::ObservationFailed,
            "Synthetic unobservable System Proxy state",
        ))))
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        unreachable!("an unowned shutdown must not observe a service")
    }

    fn apply_service(
        &self,
        _target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        unreachable!("an unowned shutdown must not mutate System Proxy")
    }
}

impl CapturePlatform for BlockingShutdownObservationPlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(async {
            if self.block_next_observation.swap(false, Ordering::AcqRel) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            Ok(self.state.lock().unwrap().clone())
        })
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.state.lock().unwrap().clone())))
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        *self.state.lock().unwrap() = target;
        Box::pin(ready(Ok(())))
    }
}

fn disabled_proxy_state() -> NetworkServiceProxyState {
    NetworkServiceProxyState {
        auto_discovery_enabled: false,
        bypass_domains: Vec::new(),
        http: ManualProxyState::disabled(),
        https: ManualProxyState::disabled(),
        pac_enabled: false,
        pac_url: String::new(),
        service_id: "shutdown-fixture".into(),
        socks: ManualProxyState::disabled(),
    }
}

impl StatusDataSource for SuppliedStatusSource {
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        let mut snapshot = StatusSnapshot::lifecycle_only(core, adapter_kind);
        snapshot.active_profile_id = "supplied-profile".into();
        snapshot.profiles = vec![ProfileSummary {
            id: "supplied-profile".into(),
            label: "Supplied profile".into(),
        }];
        snapshot
    }
}

impl PublishingStatusSource {
    fn publish(&self, observation: RecentTrafficObservation) {
        *self.observation.lock().unwrap() = Some(observation);
        self.sink
            .get()
            .expect("runtime must attach the source sink")
            .publish(CoreStatus {
                error: None,
                phase: CorePhase::Running,
                pid: None,
                version: Some("embedded-test".into()),
            });
    }
}

impl StatusDataSource for PublishingStatusSource {
    fn attach_status_event_sink(&self, sink: CoreStatusEventSink) {
        let _ = self.sink.set(sink);
    }

    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        StatusSnapshot::lifecycle_only(core, adapter_kind)
    }

    fn profile_id(&self) -> Option<String> {
        Some("profile-a".into())
    }

    fn recent_traffic_observation(&self) -> Option<RecentTrafficObservation> {
        self.observation.lock().unwrap().clone()
    }
}

impl StatusDataSource for ShutdownRecordingSource {
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        StatusSnapshot::lifecycle_only(core, adapter_kind)
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.order.lock().unwrap().push("status-source");
        })
    }
}

impl CoreRuntime for ShutdownRecordingCore {
    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: None,
            version: Some("embedded-test".into()),
        }))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move { Ok(self.status().await) })
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            self.order.lock().unwrap().push("core");
            Ok(CoreStatus {
                error: None,
                phase: CorePhase::Stopped,
                pid: None,
                version: Some("embedded-test".into()),
            })
        })
    }
}

impl CoreRuntime for UnavailableCore {
    fn configured(&self) -> bool {
        false
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: None,
        }))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Err(CoreError::unavailable(
            "No mobile core installed",
        ))))
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Err(CoreError::stop_failed("Core rejected stop"))))
    }
}

struct EventReportingCore {
    events: Mutex<Option<CoreStatusEventSink>>,
}

impl EventReportingCore {
    fn report(&self, status: CoreStatus) {
        self.events
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .publish(status);
    }
}

impl CoreRuntime for EventReportingCore {
    fn attach_status_event_sink(&self, sink: CoreStatusEventSink) {
        *self.events.lock().unwrap() = Some(sink);
    }

    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: None,
            version: Some("embedded-test".into()),
        }))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Ok(CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: None,
            version: Some("embedded-test".into()),
        })))
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Ok(CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: Some("embedded-test".into()),
        })))
    }
}

#[tokio::test]
async fn runtime_drives_an_injected_core_and_publishes_status() {
    let runtime = MishRuntime::new(Arc::new(EmbeddedCore));
    let mut updates = runtime.subscribe_status();

    assert!(runtime.core_configured());
    let status = runtime.start_core().await.unwrap();
    assert!(matches!(status.phase, CorePhase::Running));

    let update = updates.recv().await.unwrap();
    assert!(matches!(update.phase, CorePhase::Running));

    let snapshot = runtime.snapshot_from_status(&update, StatusAdapterKind::Native);
    assert_eq!(snapshot["adapterKind"], "native");
    assert_eq!(snapshot["runtime"]["phase"], "healthy");
    assert_eq!(snapshot["services"].as_array().unwrap().len(), 6);
    assert_eq!(snapshot["services"][0]["id"], "google");
}

#[tokio::test]
async fn runtime_preserves_typed_core_failures_without_publishing_success() {
    let runtime = MishRuntime::new(Arc::new(UnavailableCore));
    let mut updates = runtime.subscribe_status();

    let error = runtime.start_core().await.unwrap_err();
    assert!(matches!(error.kind, CoreErrorKind::Unavailable));
    assert!(
        timeout(Duration::from_millis(20), updates.recv())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn runtime_uses_an_injected_transport_neutral_status_source() {
    let runtime =
        MishRuntime::with_status_source(Arc::new(EmbeddedCore), Arc::new(SuppliedStatusSource));
    let snapshot = runtime.status_snapshot(StatusAdapterKind::Native).await;

    assert_eq!(snapshot["activeProfileId"], "supplied-profile");
    assert_eq!(snapshot["profiles"][0]["label"], "Supplied profile");
    assert_eq!(snapshot["adapterKind"], "native");
}

#[tokio::test]
async fn source_publication_advances_recent_traffic_without_a_snapshot_reader() {
    let source = Arc::new(PublishingStatusSource {
        observation: Mutex::new(Some(RecentTrafficObservation {
            source_generation: 1,
            source_sequence: 1,
            profile_id: "profile-a".into(),
            downloaded_bytes: 100,
            uploaded_bytes: 200,
            download_bytes_per_second: 10,
            upload_bytes_per_second: 20,
        })),
        sink: OnceLock::new(),
    });
    let runtime = MishRuntime::with_status_source(Arc::new(EmbeddedCore), source.clone());
    let started = runtime
        .recent_traffic()
        .capture_applied("profile-a", source.recent_traffic_observation());

    source.publish(RecentTrafficObservation {
        source_generation: 1,
        source_sequence: 2,
        profile_id: "profile-a".into(),
        downloaded_bytes: 130,
        uploaded_bytes: 250,
        download_bytes_per_second: 30,
        upload_bytes_per_second: 50,
    });

    let advanced = runtime.recent_traffic().snapshot();
    assert!(advanced.revision > started.revision);
    assert_eq!(advanced.downloaded_bytes, 30);
    assert_eq!(advanced.uploaded_bytes, 50);
    assert_eq!(advanced.download_bytes_per_second, 30);
    assert_eq!(advanced.upload_bytes_per_second, 50);
}

#[tokio::test]
async fn runtime_forwards_adapter_reported_lifecycle_events() {
    let core = Arc::new(EventReportingCore {
        events: Mutex::new(None),
    });
    let runtime = MishRuntime::new(core.clone());
    let mut updates = runtime.subscribe_status();

    core.report(CoreStatus {
        error: Some("Embedded core exited".into()),
        phase: CorePhase::Failed,
        pid: None,
        version: Some("embedded-test".into()),
    });

    let update = updates.recv().await.unwrap();
    assert!(matches!(update.phase, CorePhase::Failed));
    assert_eq!(update.error.as_deref(), Some("Embedded core exited"));
}

#[tokio::test]
async fn runtime_shuts_down_status_source_before_core_lifecycle() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let runtime = MishRuntime::with_status_source(
        Arc::new(ShutdownRecordingCore {
            order: order.clone(),
        }),
        Arc::new(ShutdownRecordingSource {
            order: order.clone(),
        }),
    );

    runtime.shutdown().await.unwrap();

    assert_eq!(*order.lock().unwrap(), ["status-source", "core"]);
}

#[tokio::test]
async fn runtime_does_not_stop_core_when_capture_restoration_is_unconfirmed() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::new(CaptureReconciler::new(
        Arc::new(ShutdownCapturePlatform),
        Arc::new(UnreadableShutdownJournal),
        LoopbackProxyEndpoint::managed(),
    ));
    let runtime = MishRuntime::with_capture(
        Arc::new(ShutdownRecordingCore {
            order: order.clone(),
        }),
        capture,
    );

    assert!(matches!(
        runtime.shutdown().await,
        Err(RuntimeShutdownFailure::CaptureRestoration)
    ));
    assert!(order.lock().unwrap().is_empty());
}

#[tokio::test]
async fn runtime_stops_without_observing_system_proxy_when_it_has_no_capture_authority() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::new(CaptureReconciler::new(
        Arc::new(UnobservableUnownedShutdownPlatform),
        Arc::new(MemoryShutdownJournal::default()),
        LoopbackProxyEndpoint::managed(),
    ));
    let runtime = MishRuntime::with_capture(
        Arc::new(ShutdownRecordingCore {
            order: order.clone(),
        }),
        capture,
    );

    runtime.shutdown().await.unwrap();

    assert_eq!(*order.lock().unwrap(), ["core"]);
}

#[tokio::test]
async fn runtime_does_not_skip_capture_reconciliation_during_an_uncommitted_operation() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let capture = Arc::new(CaptureReconciler::new(
        Arc::new(BlockingShutdownObservationPlatform {
            block_next_observation: AtomicBool::new(true),
            entered: entered.clone(),
            release: release.clone(),
            state: Mutex::new(disabled_proxy_state()),
        }),
        Arc::new(MemoryShutdownJournal::default()),
        LoopbackProxyEndpoint::managed(),
    ));
    let runtime = MishRuntime::with_capture(
        Arc::new(ShutdownRecordingCore {
            order: order.clone(),
        }),
        capture.clone(),
    );
    let observation_started = entered.notified();
    let operation = tokio::spawn(async move {
        capture
            .reconcile(
                CaptureRequest {
                    active: true,
                    selection: CaptureSelection {
                        system_proxy: true,
                        tun: false,
                    },
                },
                true,
            )
            .await
    });
    observation_started.await;

    assert!(matches!(
        runtime.shutdown().await,
        Err(RuntimeShutdownFailure::CaptureRestoration)
    ));
    assert!(order.lock().unwrap().is_empty());

    release.notify_one();
    operation.await.unwrap().unwrap();
    runtime.shutdown().await.unwrap();
    assert_eq!(*order.lock().unwrap(), ["core"]);
}

#[tokio::test]
async fn runtime_restores_capture_before_stopping_core() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let platform = Arc::new(RecordingShutdownPlatform {
        order: order.clone(),
        state: Mutex::new(disabled_proxy_state()),
    });
    let journal = Arc::new(MemoryShutdownJournal::default());
    let capture = Arc::new(CaptureReconciler::new(
        platform,
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    ));
    capture
        .reconcile(
            mish_runtime::CaptureRequest {
                active: true,
                selection: mish_runtime::CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();
    order.lock().unwrap().clear();
    let runtime = MishRuntime::with_capture(
        Arc::new(ShutdownRecordingCore {
            order: order.clone(),
        }),
        capture,
    );

    runtime.shutdown().await.unwrap();

    assert_eq!(*order.lock().unwrap(), ["capture", "core"]);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn runtime_reports_core_stop_failure_after_capture_is_safe() {
    let runtime = MishRuntime::new(Arc::new(UnavailableCore));

    assert!(matches!(
        runtime.shutdown().await,
        Err(RuntimeShutdownFailure::CoreStop)
    ));
}

#[test]
fn safe_stopped_runtime_exposes_bounded_actionable_application_events() {
    let runtime = MishRuntime::new(Arc::new(UnavailableCore));
    runtime.record_application_event(ApplicationDiagnosticEvent::profile_activation_failure(
        "capture",
    ));

    let snapshot = runtime.events_snapshot_typed(StatusAdapterKind::Rpc);

    assert_eq!(snapshot.phase, mish_runtime::EventsDataPhase::Ready);
    assert_eq!(snapshot.events.len(), 1);
    assert_eq!(
        snapshot.events[0].source,
        mish_runtime::EventSource::Application
    );
    assert_eq!(
        snapshot.events[0]
            .application
            .as_ref()
            .expect("semantic application event")
            .kind(),
        "profile.activation-failed"
    );
    let serialized = serde_json::to_value(&snapshot.events[0]).unwrap();
    assert!(serialized.get("message").is_none());
    assert!(serialized.get("detail").is_none());
    assert!(!format!("{snapshot:?}").contains("subscription"));
}

#[test]
fn capture_diagnostics_remain_independent_from_notification_state() {
    let runtime = MishRuntime::new(Arc::new(UnavailableCore));
    runtime.record_application_event(ApplicationDiagnosticEvent::capture_failure(
        mish_runtime::CaptureFailureKind::ExternalDrift,
    ));

    assert_eq!(
        runtime
            .events_snapshot_typed(StatusAdapterKind::Rpc)
            .events
            .len(),
        1
    );
    assert!(runtime.notification_snapshot().notifications.is_empty());
}

#[test]
fn a_repeated_unresolved_capture_failure_does_not_requeue_its_folded_notification() {
    let runtime = MishRuntime::new(Arc::new(UnavailableCore));
    let failure = CaptureTransitionError::new(
        mish_runtime::CaptureFailureKind::ConfirmationFailed,
        "Synthetic repeated TUN confirmation failure",
    );
    runtime.record_capture_failure(&failure);

    let identity = NotificationPresentationIdentity {
        client_id: "desktop-webview".into(),
        session_id: "first-session".into(),
    };
    let first = runtime
        .claim_next_notification_presentation(identity.clone())
        .claim
        .expect("first failure is presentable");
    let completed =
        runtime.complete_notification_presentation(NotificationPresentationCompletion {
            client_id: identity.client_id.clone(),
            id: first.id.clone(),
            lease_generation: first.lease_generation,
            outcome: NotificationPresentationFoldReason::Dismissed,
            revision: first.revision,
            session_id: identity.session_id.clone(),
        });
    assert!(completed.accepted);

    runtime.record_capture_failure(&failure);

    let snapshot = runtime.notification_snapshot();
    assert_eq!(snapshot.notifications.len(), 1);
    assert_eq!(snapshot.notifications[0].id, first.id);
    assert_eq!(
        snapshot.notifications[0].presentation_state.phase,
        NotificationPresentationPhase::Folded
    );
    let repeated = runtime
        .claim_next_notification_presentation(NotificationPresentationIdentity {
            client_id: "desktop-webview".into(),
            session_id: "second-session".into(),
        })
        .claim;
    assert!(repeated.is_none());

    runtime.resolve_notification("capture.failure");
    runtime.record_capture_failure(&failure);

    let recurred = runtime.notification_snapshot();
    assert_eq!(recurred.notifications.len(), 2);
    assert_ne!(recurred.notifications[0].id, recurred.notifications[1].id);
    let next = runtime
        .claim_next_notification_presentation(NotificationPresentationIdentity {
            client_id: "desktop-webview".into(),
            session_id: "third-session".into(),
        })
        .claim
        .expect("a failure that recurs after resolution is a new occurrence");
    assert_ne!(next.id, first.id);
}
