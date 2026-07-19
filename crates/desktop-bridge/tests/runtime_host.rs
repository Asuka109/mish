use std::sync::Arc;

use futures_util::future::BoxFuture;
use mish_bridge::DesktopRuntimeHost;
use mish_runtime::{
    CoreError, CorePhase, CoreRuntime, CoreStatus, EventLevel, EventRecord, EventSource,
    EventSourcePhase, EventSourceStatus, EventsDataPhase, EventsDataSource, EventsSnapshot,
    MishRuntime, StatusAdapterKind, StatusDataSource, StatusSnapshot, TrafficCommandAuthority,
    TrafficCommandExecution, TrafficCommandOperation, TrafficDataSnapshot, TrafficDataSource,
};
use tokio::sync::{Notify, broadcast};

struct RunningCore;

impl CoreRuntime for RunningCore {
    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(async {
            CoreStatus {
                error: None,
                phase: CorePhase::Running,
                pid: Some(1),
                version: Some("v1.19.29".into()),
            }
        })
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async { Ok(self.status().await) })
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async {
            Ok(CoreStatus {
                error: None,
                phase: CorePhase::Stopped,
                pid: None,
                version: Some("v1.19.29".into()),
            })
        })
    }
}

struct ProfileSource {
    command_continue: Option<Arc<Notify>>,
    command_started: Option<Arc<Notify>>,
    event_updates: broadcast::Sender<()>,
    profile_id: &'static str,
}

impl StatusDataSource for ProfileSource {
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        let mut snapshot = StatusSnapshot::lifecycle_only(core, adapter_kind);
        snapshot.active_profile_id = self.profile_id.into();
        snapshot.profiles[0].id = self.profile_id.into();
        snapshot
    }
}

impl TrafficDataSource for ProfileSource {
    fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot {
        let mut snapshot = TrafficDataSnapshot::unavailable(adapter_kind);
        snapshot.profile_id = self.profile_id.into();
        snapshot
    }

    fn supports_traffic_command(&self, _operation: TrafficCommandOperation) -> bool {
        self.command_started.is_some()
    }

    fn close_connection(
        &self,
        _authority: TrafficCommandAuthority,
        _connection_id: String,
    ) -> BoxFuture<'_, TrafficCommandExecution> {
        Box::pin(async move {
            self.command_started.as_ref().unwrap().notify_one();
            self.command_continue.as_ref().unwrap().notified().await;
            TrafficCommandExecution::success(TrafficCommandOperation::CloseConnection, 1)
        })
    }
}

impl EventsDataSource for ProfileSource {
    fn events_snapshot(&self, adapter_kind: StatusAdapterKind) -> EventsSnapshot {
        EventsSnapshot {
            adapter_kind,
            events: vec![EventRecord {
                detail: None,
                id: format!("{}:1", self.profile_id),
                level: EventLevel::Info,
                message: "runtime replacement boundary".into(),
                observed_at: 1,
                sequence: 1,
                source: EventSource::Application,
            }],
            phase: EventsDataPhase::Ready,
            profile_id: self.profile_id.into(),
            reconnect_count: 0,
            sequence: 1,
            session_id: Some(format!("events-{}", self.profile_id)),
            source_statuses: vec![EventSourceStatus {
                detail: None,
                phase: EventSourcePhase::Ready,
                source: EventSource::Application,
            }],
        }
    }

    fn subscribe_events(&self) -> broadcast::Receiver<()> {
        self.event_updates.subscribe()
    }
}

fn runtime(profile_id: &'static str) -> MishRuntime {
    let (event_updates, _) = broadcast::channel(1);
    let source = Arc::new(ProfileSource {
        command_continue: None,
        command_started: None,
        event_updates,
        profile_id,
    });
    MishRuntime::with_data_sources_and_events(
        Arc::new(RunningCore),
        source.clone(),
        source.clone(),
        source,
    )
}

fn blocking_runtime(
    profile_id: &'static str,
    command_started: Arc<Notify>,
    command_continue: Arc<Notify>,
) -> MishRuntime {
    let (event_updates, _) = broadcast::channel(1);
    let source = Arc::new(ProfileSource {
        command_continue: Some(command_continue),
        command_started: Some(command_started),
        event_updates,
        profile_id,
    });
    MishRuntime::with_data_sources_and_events(
        Arc::new(RunningCore),
        source.clone(),
        source.clone(),
        source,
    )
}

#[tokio::test]
async fn replacing_the_runtime_changes_status_traffic_and_events_as_one_profile_context() {
    let host = DesktopRuntimeHost::new(runtime("profile-a"));
    let mut changes = host.subscribe_changes();

    host.replace(runtime("profile-b"));

    changes.changed().await.unwrap();
    let status = host.status_snapshot(StatusAdapterKind::Rpc).await;
    let traffic = host.traffic_snapshot(StatusAdapterKind::Rpc);
    let events = host.events_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(status["activeProfileId"], "profile-b");
    assert_eq!(traffic["profileId"], "profile-b");
    assert_eq!(events["profileId"], "profile-b");
    assert_eq!(events["sessionId"], "events-profile-b");
    assert_eq!(events["events"][0]["id"], "profile-b:1");
}

#[tokio::test]
async fn replacing_the_runtime_during_a_traffic_command_returns_the_new_authority() {
    let command_started = Arc::new(Notify::new());
    let command_continue = Arc::new(Notify::new());
    let host = DesktopRuntimeHost::new(blocking_runtime(
        "profile-a",
        command_started.clone(),
        command_continue.clone(),
    ));
    let command_host = host.clone();
    let command = tokio::spawn(async move {
        command_host
            .close_connection(
                TrafficCommandAuthority {
                    profile_id: "profile-a".into(),
                    sequence: 1,
                    session_id: "session-a".into(),
                },
                "connection-a".into(),
                StatusAdapterKind::Rpc,
            )
            .await
    });

    command_started.notified().await;
    host.replace(runtime("profile-b"));
    command_continue.notify_one();
    let result = command.await.unwrap();

    assert_eq!(result["status"], "failure");
    assert_eq!(result["failure"], "runtime-replaced");
    assert_eq!(result["snapshot"]["profileId"], "profile-b");
}

#[tokio::test]
async fn any_runtime_replacement_during_a_traffic_command_invalidates_the_result() {
    let command_started = Arc::new(Notify::new());
    let command_continue = Arc::new(Notify::new());
    let original = blocking_runtime(
        "profile-a",
        command_started.clone(),
        command_continue.clone(),
    );
    let host = DesktopRuntimeHost::new(original.clone());
    let command_host = host.clone();
    let command = tokio::spawn(async move {
        command_host
            .close_connection(
                TrafficCommandAuthority {
                    profile_id: "profile-a".into(),
                    sequence: 1,
                    session_id: "session-a".into(),
                },
                "connection-a".into(),
                StatusAdapterKind::Rpc,
            )
            .await
    });

    command_started.notified().await;
    host.replace(original);
    command_continue.notify_one();
    let result = command.await.unwrap();

    assert_eq!(result["status"], "failure");
    assert_eq!(result["failure"], "runtime-replaced");
    assert_eq!(result["snapshot"]["profileId"], "profile-a");
}

#[tokio::test]
async fn runtime_replacement_invalidates_the_active_diagnostic_run_before_switching_context() {
    let host = DesktopRuntimeHost::new(runtime("profile-a"));
    let started = host.start_diagnostic_run(StatusAdapterKind::Rpc);
    assert!(started.active_run_id.is_some());

    host.replace(runtime("profile-b"));

    let history = host.diagnostic_history(StatusAdapterKind::Rpc);
    assert_eq!(history.active_run_id, None);
    assert_eq!(
        history.runs[0].status,
        mish_runtime::DiagnosticRunStatus::Invalidated
    );
    assert!(
        history.runs[0]
            .checks
            .iter()
            .all(|check| !check.scope.contains("profile-b"))
    );
}
