use std::sync::Arc;

use futures_util::future::BoxFuture;
use mish_bridge::DesktopRuntimeHost;
use mish_runtime::{
    CoreError, CorePhase, CoreRuntime, CoreStatus, MishRuntime, StatusAdapterKind,
    StatusDataSource, StatusSnapshot, TrafficDataSnapshot, TrafficDataSource,
};

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

fn runtime(profile_id: &'static str) -> MishRuntime {
    let source = Arc::new(ProfileSource { profile_id });
    MishRuntime::with_data_sources(Arc::new(RunningCore), source.clone(), source)
}

#[tokio::test]
async fn replacing_the_runtime_changes_status_and_traffic_as_one_profile_context() {
    let host = DesktopRuntimeHost::new(runtime("profile-a"));
    let mut changes = host.subscribe_changes();

    host.replace(runtime("profile-b"));

    changes.changed().await.unwrap();
    let status = host.status_snapshot(StatusAdapterKind::Rpc).await;
    let traffic = host.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(status["activeProfileId"], "profile-b");
    assert_eq!(traffic["profileId"], "profile-b");
}
