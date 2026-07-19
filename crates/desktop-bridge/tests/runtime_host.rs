use std::sync::Arc;

use futures_util::future::BoxFuture;
use mish_bridge::DesktopRuntimeHost;
use mish_runtime::{
    CoreError, CorePhase, CoreRuntime, CoreStatus, EventLevel, EventRecord, EventSource,
    EventSourcePhase, EventSourceStatus, EventsDataPhase, EventsDataSource, EventsSnapshot,
    MishRuntime, StatusAdapterKind, StatusDataSource, StatusSnapshot, TrafficDataSnapshot,
    TrafficDataSource,
};
use tokio::sync::broadcast;

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
