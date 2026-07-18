use std::sync::{Arc, Mutex};

use futures_util::future::{BoxFuture, ready};
use mish_runtime::{
    CoreError, CoreErrorKind, CorePhase, CoreRuntime, CoreStatus, CoreStatusEventSink, MishRuntime,
    StatusAdapterKind,
};
use tokio::time::{Duration, timeout};

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
