use std::sync::Arc;

use futures_util::future::BoxFuture;
use mish_bridge::DesktopRuntimeHost;
use mish_runtime::{
    CaptureFailureKind, CaptureRecoveryAction, CoreError, CorePhase, CoreRuntime, CoreStatus,
    EventLevel, EventRecord, EventSource, EventSourcePhase, EventSourceStatus, EventsDataPhase,
    EventsDataSource, EventsSnapshot, MishRuntime, NotificationPublication, NotificationSeverity,
    ProviderAuthority, ProviderCapabilityAvailability, ProviderCommandExecution,
    ProviderCommandOperation, ProviderHealth, ProviderKind, ProviderSnapshot, ProviderSourceType,
    ProviderUpdateState, RoutingMode, RuntimeProvider, StatusAdapterKind, StatusCommand,
    StatusCommandError, StatusCommandErrorKind, StatusDataSource, StatusSnapshot,
    TrafficCommandAuthority, TrafficCommandExecution, TrafficCommandOperation, TrafficDataSnapshot,
    TrafficDataSource,
};
use mish_state_authority::StateMutationAuthority;
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

struct StatusCommandBarrier {
    admitted: Arc<Notify>,
    continue_to_mutation: Arc<Notify>,
    mutated: Arc<Notify>,
    continue_to_response: Arc<Notify>,
}

struct ProfileSource {
    command_continue: Option<Arc<Notify>>,
    command_started: Option<Arc<Notify>>,
    event_updates: broadcast::Sender<()>,
    provider_continue: Option<Arc<Notify>>,
    provider_started: Option<Arc<Notify>>,
    profile_id: &'static str,
    status_command_barrier: Option<Arc<StatusCommandBarrier>>,
}

impl StatusDataSource for ProfileSource {
    fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
        let mut snapshot = StatusSnapshot::lifecycle_only(core, adapter_kind);
        snapshot.active_profile_id = self.profile_id.into();
        snapshot.profiles[0].id = self.profile_id.into();
        snapshot
    }

    fn profile_id(&self) -> Option<String> {
        Some(self.profile_id.into())
    }

    fn supports_command(&self, command: StatusCommand) -> bool {
        matches!(
            command,
            StatusCommand::Routing | StatusCommand::Group | StatusCommand::GroupDelay
        ) && self.status_command_barrier.is_some()
    }

    fn set_routing_mode(
        &self,
        _mode: RoutingMode,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        self.run_status_command()
    }

    fn select_group_child(
        &self,
        _group_id: String,
        _child_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        self.run_status_command()
    }

    fn start_group_delay_test(
        &self,
        _group_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        self.run_status_command()
    }

    fn cancel_group_delay_test(
        &self,
        _test_id: String,
    ) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        self.run_status_command()
    }

    fn provider_snapshot(&self) -> ProviderSnapshot {
        ProviderSnapshot {
            authority: Some(ProviderAuthority {
                profile_id: self.profile_id.into(),
                runtime_fingerprint: format!("fingerprint-{}", self.profile_id),
            }),
            capability: ProviderCapabilityAvailability::Supported,
            observation_failure: None,
            observed_at: Some(1),
            providers: vec![RuntimeProvider {
                behavior: None,
                healthy_record_count: Some(1),
                health: ProviderHealth::Available,
                id: format!("provider-{}", self.profile_id),
                kind: ProviderKind::Proxy,
                label: "Synthetic provider".into(),
                record_count: 1,
                source_type: ProviderSourceType::Http,
                updated_at: Some("2026-07-19T01:02:03Z".into()),
                update: ProviderUpdateState::idle(),
            }],
            remotely_cancellable: false,
        }
    }

    fn update_provider(
        &self,
        _authority: ProviderAuthority,
        provider_id: String,
    ) -> BoxFuture<'_, ProviderCommandExecution> {
        Box::pin(async move {
            if let Some(started) = &self.provider_started {
                started.notify_one();
                self.provider_continue.as_ref().unwrap().notified().await;
            }
            ProviderCommandExecution {
                failed: Vec::new(),
                failure: None,
                operation: ProviderCommandOperation::UpdateOne,
                succeeded_provider_ids: vec![provider_id],
            }
        })
    }
}

impl ProfileSource {
    fn run_status_command(&self) -> BoxFuture<'_, Result<(), StatusCommandError>> {
        Box::pin(async move {
            let barrier = self.status_command_barrier.as_ref().unwrap();
            barrier.admitted.notify_one();
            barrier.continue_to_mutation.notified().await;
            barrier.mutated.notify_one();
            barrier.continue_to_response.notified().await;
            Ok(())
        })
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
                application: Some(mish_runtime::ApplicationEvent::new(
                    mish_runtime::ApplicationEventContent::ControllerSessionStarted(
                        mish_runtime::ControllerSessionStartedApplicationEventData {},
                    ),
                    Vec::new(),
                )),
                evidence: None,
                id: format!("{}:1", self.profile_id),
                level: EventLevel::Info,
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
        provider_continue: None,
        provider_started: None,
        profile_id,
        status_command_barrier: None,
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
        provider_continue: None,
        provider_started: None,
        profile_id,
        status_command_barrier: None,
    });
    MishRuntime::with_data_sources_and_events(
        Arc::new(RunningCore),
        source.clone(),
        source.clone(),
        source,
    )
}

fn blocking_provider_runtime(
    profile_id: &'static str,
    provider_started: Arc<Notify>,
    provider_continue: Arc<Notify>,
) -> MishRuntime {
    let (event_updates, _) = broadcast::channel(1);
    let source = Arc::new(ProfileSource {
        command_continue: None,
        command_started: None,
        event_updates,
        provider_continue: Some(provider_continue),
        provider_started: Some(provider_started),
        profile_id,
        status_command_barrier: None,
    });
    MishRuntime::with_data_sources_and_events(
        Arc::new(RunningCore),
        source.clone(),
        source.clone(),
        source,
    )
}

fn blocking_status_runtime(
    profile_id: &'static str,
    command_started: Arc<Notify>,
    command_continue: Arc<Notify>,
) -> MishRuntime {
    let continue_to_mutation = Arc::new(Notify::new());
    continue_to_mutation.notify_one();
    let mutated = Arc::new(Notify::new());
    let continue_to_response = command_continue;
    let barrier = Arc::new(StatusCommandBarrier {
        admitted: command_started,
        continue_to_mutation,
        mutated,
        continue_to_response,
    });
    status_barrier_runtime(profile_id, barrier)
}

fn status_barrier_runtime(
    profile_id: &'static str,
    barrier: Arc<StatusCommandBarrier>,
) -> MishRuntime {
    let (event_updates, _) = broadcast::channel(1);
    let source = Arc::new(ProfileSource {
        command_continue: None,
        command_started: None,
        event_updates,
        provider_continue: None,
        provider_started: None,
        profile_id,
        status_command_barrier: Some(barrier),
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
    let recent = host
        .current()
        .recent_traffic()
        .capture_applied("profile-a", None);

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
    assert_eq!(status["recentTraffic"]["authorityId"], recent.authority_id);
    assert_eq!(status["recentTraffic"]["phase"], "idle");
    assert!(status["recentTraffic"]["revision"].as_u64().unwrap() > recent.revision);
}

#[test]
fn replacing_the_runtime_preserves_the_authoritative_notification_center() {
    let host = DesktopRuntimeHost::new(runtime("profile-a"));
    let published = host
        .publish_notification(NotificationPublication {
            dedupe_key: "profile.saved".into(),
            pinned: false,
            presentation: mish_runtime::ApplicationNotification::new(
                mish_runtime::ApplicationNotificationContent::ProfileSaved(
                    mish_runtime::ProfileSavedApplicationNotificationData {},
                ),
                Vec::new(),
            ),
            replaces: Vec::new(),
            resolved: false,
            severity: NotificationSeverity::Success,
        })
        .unwrap();

    host.replace(runtime("profile-b"));

    assert_eq!(host.notification_snapshot(), published);
}

#[tokio::test]
async fn same_profile_runtime_replacement_suspends_recent_traffic_for_coordinator_decision() {
    let host = DesktopRuntimeHost::new(runtime("profile-a"));
    let started = host
        .current()
        .recent_traffic()
        .capture_applied("profile-a", None);

    host.replace(runtime("profile-a"));

    let snapshot = host
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await
        .recent_traffic;
    assert_eq!(snapshot.authority_id, started.authority_id);
    assert_eq!(snapshot.session_id, started.session_id);
    assert_eq!(snapshot.phase, mish_runtime::RecentTrafficPhase::Suspended);
    assert!(snapshot.revision > started.revision);
}

#[tokio::test]
async fn system_proxy_recovery_cannot_overlap_an_authoritative_restore() {
    let authority = StateMutationAuthority::new();
    let restore_permit = authority.try_acquire().unwrap();
    let host = DesktopRuntimeHost::with_mutation_authority(runtime("profile-a"), authority);

    let error = host
        .recover_system_proxy(CaptureRecoveryAction::Repair, StatusAdapterKind::Rpc)
        .await
        .unwrap_err();

    assert_eq!(error.kind, CaptureFailureKind::InvalidRecovery);
    drop(restore_permit);
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
async fn replacing_the_runtime_during_a_routing_command_returns_a_typed_failure() {
    let command_started = Arc::new(Notify::new());
    let command_continue = Arc::new(Notify::new());
    let host = DesktopRuntimeHost::new(blocking_status_runtime(
        "profile-a",
        command_started.clone(),
        command_continue.clone(),
    ));
    let command_host = host.clone();
    let command = tokio::spawn(async move {
        command_host
            .set_routing_mode(RoutingMode::Global, StatusAdapterKind::Rpc)
            .await
    });

    command_started.notified().await;
    host.replace(runtime("profile-b"));
    command_continue.notify_one();
    let error = command.await.unwrap().unwrap_err();

    assert_eq!(error.kind, StatusCommandErrorKind::RuntimeReplaced);
    assert_eq!(
        error
            .reconciliation
            .as_ref()
            .map(|snapshot| snapshot.active_profile_id.as_str()),
        Some("profile-b")
    );
    assert_eq!(
        host.status_snapshot(StatusAdapterKind::Rpc).await["activeProfileId"],
        "profile-b"
    );
}

#[tokio::test]
async fn replacement_before_group_mutation_uses_the_admitted_runtime_and_reconciles_current_state()
{
    let barrier = Arc::new(StatusCommandBarrier {
        admitted: Arc::new(Notify::new()),
        continue_to_mutation: Arc::new(Notify::new()),
        mutated: Arc::new(Notify::new()),
        continue_to_response: Arc::new(Notify::new()),
    });
    let host = DesktopRuntimeHost::new(status_barrier_runtime("profile-a", barrier.clone()));
    let command_host = host.clone();
    let command = tokio::spawn(async move {
        command_host
            .select_group_child("group-a".into(), "child-a".into(), StatusAdapterKind::Rpc)
            .await
    });

    barrier.admitted.notified().await;
    host.replace(runtime("profile-b"));
    barrier.continue_to_mutation.notify_one();
    barrier.mutated.notified().await;
    barrier.continue_to_response.notify_one();
    let error = command.await.unwrap().unwrap_err();

    assert_eq!(error.kind, StatusCommandErrorKind::RuntimeReplaced);
    assert_eq!(error.reconciliation.unwrap().active_profile_id, "profile-b");
}

#[tokio::test]
async fn replacement_after_group_delay_start_mutation_rejects_the_old_terminal_success() {
    let barrier = Arc::new(StatusCommandBarrier {
        admitted: Arc::new(Notify::new()),
        continue_to_mutation: Arc::new(Notify::new()),
        mutated: Arc::new(Notify::new()),
        continue_to_response: Arc::new(Notify::new()),
    });
    let host = DesktopRuntimeHost::new(status_barrier_runtime("profile-a", barrier.clone()));
    let command_host = host.clone();
    let command = tokio::spawn(async move {
        command_host
            .start_group_delay_test("group-a".into(), StatusAdapterKind::Rpc)
            .await
    });

    barrier.admitted.notified().await;
    barrier.continue_to_mutation.notify_one();
    barrier.mutated.notified().await;
    host.replace(runtime("profile-b"));
    barrier.continue_to_response.notify_one();
    let error = command.await.unwrap().unwrap_err();

    assert_eq!(error.kind, StatusCommandErrorKind::RuntimeReplaced);
    assert_eq!(error.reconciliation.unwrap().active_profile_id, "profile-b");
}

#[tokio::test]
async fn replacement_while_group_delay_cancel_is_blocked_rejects_the_old_terminal_success() {
    let barrier = Arc::new(StatusCommandBarrier {
        admitted: Arc::new(Notify::new()),
        continue_to_mutation: Arc::new(Notify::new()),
        mutated: Arc::new(Notify::new()),
        continue_to_response: Arc::new(Notify::new()),
    });
    let host = DesktopRuntimeHost::new(status_barrier_runtime("profile-a", barrier.clone()));
    let command_host = host.clone();
    let command = tokio::spawn(async move {
        command_host
            .cancel_group_delay_test("delay-a".into(), StatusAdapterKind::Rpc)
            .await
    });

    barrier.admitted.notified().await;
    barrier.continue_to_mutation.notify_one();
    barrier.mutated.notified().await;
    host.replace(runtime("profile-b"));
    barrier.continue_to_response.notify_one();
    let error = command.await.unwrap().unwrap_err();

    assert_eq!(error.kind, StatusCommandErrorKind::RuntimeReplaced);
    assert_eq!(error.reconciliation.unwrap().active_profile_id, "profile-b");
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
async fn runtime_replacement_discards_an_uncancellable_provider_update_result() {
    let provider_started = Arc::new(Notify::new());
    let provider_continue = Arc::new(Notify::new());
    let host = DesktopRuntimeHost::new(blocking_provider_runtime(
        "profile-a",
        provider_started.clone(),
        provider_continue.clone(),
    ));
    let command_host = host.clone();
    let command = tokio::spawn(async move {
        command_host
            .update_provider(
                ProviderAuthority {
                    profile_id: "profile-a".into(),
                    runtime_fingerprint: "fingerprint-profile-a".into(),
                },
                "provider-profile-a".into(),
            )
            .await
    });

    provider_started.notified().await;
    host.replace(runtime("profile-b"));
    provider_continue.notify_one();
    let result = command.await.unwrap();

    assert_eq!(result.phase, mish_runtime::ProviderCommandPhase::Failure);
    assert_eq!(
        result.failure,
        Some(mish_runtime::ProviderUpdateFailure::RuntimeReplaced)
    );
    assert_eq!(result.snapshot.authority.unwrap().profile_id, "profile-b");
    assert!(!result.snapshot.remotely_cancellable);
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
