use mish_runtime::{
    ApplicationDiagnosticEvent, ApplicationNotification, ApplicationNotificationContent,
    CaptureAuditReason, CaptureOperation, CapturePreflight, CaptureRecoveryAction, CaptureRequest,
    CaptureTransitionError, CoreStatus, EventsSnapshot, MishRuntime,
    NotificationPresentationClaimResult, NotificationPresentationCompletion,
    NotificationPresentationCompletionResult, NotificationPresentationIdentity,
    NotificationPublication, NotificationSnapshot, NotificationValidationError, ProviderAuthority,
    ProviderCommandExecution, ProviderCommandResult, ProviderKind, ProviderSnapshot,
    ProviderUpdateFailure, RoutingMode, StatusAdapterKind, StatusCommand, StatusCommandError,
    StatusSnapshot, TrafficCommandAuthority, TrafficCommandExecution, TrafficCommandFailureKind,
    TrafficCommandOperation, TrafficCommandResult,
    TrafficOperationFailedApplicationNotificationData,
};
use mish_state_authority::StateMutationAuthority;
use serde_json::Value;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub struct DesktopRuntimeHost {
    application_snapshots: crate::snapshot_order::ApplicationSnapshotAuthority,
    mutation_authority: Option<StateMutationAuthority>,
    runtime: watch::Sender<MishRuntime>,
}

fn traffic_failure_id(failure: TrafficCommandFailureKind) -> &'static str {
    match failure {
        TrafficCommandFailureKind::Unsupported => "unsupported",
        TrafficCommandFailureKind::InvalidRequest => "invalid-request",
        TrafficCommandFailureKind::Conflict => "conflict",
        TrafficCommandFailureKind::StaleSnapshot => "stale-snapshot",
        TrafficCommandFailureKind::StaleConnection => "stale-connection",
        TrafficCommandFailureKind::Timeout => "timeout",
        TrafficCommandFailureKind::Disconnected => "disconnected",
        TrafficCommandFailureKind::VersionDrift => "version-drift",
        TrafficCommandFailureKind::ControllerRejected => "controller-rejected",
        TrafficCommandFailureKind::RuntimeReplaced => "runtime-replaced",
        TrafficCommandFailureKind::PartialRemaining => "partial-remaining",
        TrafficCommandFailureKind::InconsistentObservation => "inconsistent-observation",
    }
}

impl DesktopRuntimeHost {
    pub fn new(runtime: MishRuntime) -> Self {
        Self::with_optional_mutation_authority(runtime, None)
    }

    pub fn with_mutation_authority(
        runtime: MishRuntime,
        mutation_authority: StateMutationAuthority,
    ) -> Self {
        Self::with_optional_mutation_authority(runtime, Some(mutation_authority))
    }

    fn with_optional_mutation_authority(
        runtime: MishRuntime,
        mutation_authority: Option<StateMutationAuthority>,
    ) -> Self {
        let (runtime, _) = watch::channel(runtime);
        Self {
            application_snapshots: crate::snapshot_order::ApplicationSnapshotAuthority::new(),
            mutation_authority,
            runtime,
        }
    }

    pub fn current(&self) -> MishRuntime {
        self.runtime.borrow().clone()
    }

    pub fn set_system_proxy_takeover_policy(
        &self,
        policy: mish_runtime::SystemProxyTakeoverPolicy,
    ) {
        self.current().set_system_proxy_takeover_policy(policy);
    }

    pub fn set_policy_group_connection_cleanup_enabled(&self, enabled: bool) {
        self.current()
            .set_policy_group_connection_cleanup_enabled(enabled);
    }

    pub fn replace(&self, runtime: MishRuntime) {
        let current = self.current();
        let notifications = current.notification_center();
        let recent_traffic = current.recent_traffic();
        if current.active_profile_identity() != runtime.active_profile_identity() {
            recent_traffic.stop();
        } else {
            recent_traffic.suspend();
        }
        self.runtime.send_replace(
            runtime
                .with_notification_center(notifications)
                .with_recent_traffic(recent_traffic),
        );
        self.application_snapshots.retire_runtime();
    }

    pub fn suspend_recent_traffic(&self) {
        self.current().suspend_recent_traffic();
    }

    pub fn resume_recent_traffic(&self, continuity: mish_runtime::RecentTrafficContinuity) {
        self.current().resume_recent_traffic(continuity);
    }

    pub fn discontinue_recent_traffic(&self) {
        self.current().discontinue_recent_traffic();
    }

    pub fn subscribe_changes(&self) -> watch::Receiver<MishRuntime> {
        self.runtime.subscribe()
    }

    pub fn core_configured(&self) -> bool {
        self.current().core_configured()
    }

    pub async fn core_status(&self) -> CoreStatus {
        self.current().core_status().await
    }

    pub async fn set_capture(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        self.current().set_capture(request, adapter_kind).await
    }

    pub async fn set_capture_deferred(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        self.current()
            .set_capture_deferred(request, adapter_kind)
            .await
    }

    pub async fn preflight_capture(
        &self,
        request: &CaptureRequest,
    ) -> Result<CapturePreflight, CaptureTransitionError> {
        self.current().preflight_capture(request).await
    }

    pub async fn preflight_capture_cancellable(
        &self,
        request: &CaptureRequest,
        cancellation: CancellationToken,
    ) -> Result<CapturePreflight, CaptureTransitionError> {
        self.current()
            .preflight_capture_cancellable(request, cancellation)
            .await
    }

    pub async fn set_capture_with_preflight(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        preflight: CapturePreflight,
    ) -> Result<Value, CaptureTransitionError> {
        self.current()
            .set_capture_with_preflight(request, adapter_kind, preflight)
            .await
    }

    pub async fn set_capture_with_admitted_preflight(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        preflight: CapturePreflight,
        operation: &CaptureOperation,
    ) -> Result<Value, CaptureTransitionError> {
        self.current()
            .set_capture_with_admitted_preflight(request, adapter_kind, preflight, operation)
            .await
    }

    pub async fn set_capture_with_admitted_preflight_deferred(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        preflight: CapturePreflight,
        operation: &CaptureOperation,
    ) -> Result<Value, CaptureTransitionError> {
        self.current()
            .set_capture_with_admitted_preflight_deferred(
                request,
                adapter_kind,
                preflight,
                operation,
            )
            .await
    }

    pub async fn recover_system_proxy(
        &self,
        action: CaptureRecoveryAction,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        let _permit = self
            .mutation_authority
            .as_ref()
            .map(StateMutationAuthority::try_acquire)
            .transpose()
            .map_err(|_| {
                CaptureTransitionError::new(
                    mish_runtime::CaptureFailureKind::InvalidRecovery,
                    "Another state recovery operation is in progress",
                )
            })?;
        self.current()
            .recover_system_proxy(action, adapter_kind)
            .await
    }

    pub async fn test_local_proxy(
        &self,
    ) -> Result<mish_runtime::LocalProxyTestResult, CaptureTransitionError> {
        self.current().test_local_proxy().await
    }

    pub fn supports_status_command(&self, command: StatusCommand) -> bool {
        self.current().supports_status_command(command)
    }

    pub fn provides_status_command(&self, command: StatusCommand) -> bool {
        self.current().provides_status_command(command)
    }

    pub fn supports_traffic_command(&self, operation: TrafficCommandOperation) -> bool {
        self.current().supports_traffic_command(operation)
    }

    pub async fn close_connection(
        &self,
        authority: TrafficCommandAuthority,
        connection_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Value {
        let ticket = self
            .application_snapshots
            .begin(crate::snapshot_order::SnapshotStream::Traffic);
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let execution = runtime.close_connection(authority, connection_id).await;
        self.finish_traffic_command(runtime, execution, adapter_kind, changes, ticket)
    }

    pub async fn close_all_active(
        &self,
        authority: TrafficCommandAuthority,
        adapter_kind: StatusAdapterKind,
    ) -> Value {
        let ticket = self
            .application_snapshots
            .begin(crate::snapshot_order::SnapshotStream::Traffic);
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let execution = runtime.close_all_active(authority).await;
        self.finish_traffic_command(runtime, execution, adapter_kind, changes, ticket)
    }

    pub async fn close_filtered_visible(
        &self,
        authority: TrafficCommandAuthority,
        connection_ids: Vec<String>,
        adapter_kind: StatusAdapterKind,
    ) -> Value {
        let ticket = self
            .application_snapshots
            .begin(crate::snapshot_order::SnapshotStream::Traffic);
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let execution = runtime
            .close_filtered_visible(authority, connection_ids)
            .await;
        self.finish_traffic_command(runtime, execution, adapter_kind, changes, ticket)
    }

    pub async fn set_routing_mode(
        &self,
        mode: RoutingMode,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let result = runtime.set_routing_mode_typed(mode, adapter_kind).await;
        self.finish_status_command(runtime, result, adapter_kind, changes)
            .await
    }

    pub async fn select_group_child(
        &self,
        group_id: String,
        child_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let result = runtime
            .select_group_child_typed(group_id, child_id, adapter_kind)
            .await;
        self.finish_status_command(runtime, result, adapter_kind, changes)
            .await
    }

    pub async fn start_group_delay_test(
        &self,
        group_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let result = runtime
            .start_group_delay_test_typed(group_id, adapter_kind)
            .await;
        self.finish_status_command(runtime, result, adapter_kind, changes)
            .await
    }

    pub async fn cancel_group_delay_test(
        &self,
        test_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let result = runtime
            .cancel_group_delay_test_typed(test_id, adapter_kind)
            .await;
        self.finish_status_command(runtime, result, adapter_kind, changes)
            .await
    }

    pub async fn audit_capture(
        &self,
        reason: CaptureAuditReason,
    ) -> Result<bool, CaptureTransitionError> {
        self.current().audit_capture(reason).await
    }

    pub async fn status_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        loop {
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let snapshot = runtime.status_snapshot(adapter_kind).await;
            if !changes.has_changed().unwrap_or(false) {
                return snapshot;
            }
        }
    }

    pub async fn status_snapshot_typed(
        &self,
        adapter_kind: StatusAdapterKind,
    ) -> mish_runtime::StatusSnapshot {
        loop {
            let ticket = self
                .application_snapshots
                .begin(crate::snapshot_order::SnapshotStream::Status);
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let mut snapshot = runtime.status_snapshot_typed(adapter_kind).await;
            if !changes.has_changed().unwrap_or(false) {
                self.application_snapshots
                    .stamp_status(ticket, &mut snapshot);
                return snapshot;
            }
        }
    }

    pub(crate) async fn status_snapshot_unordered_typed(
        &self,
        adapter_kind: StatusAdapterKind,
    ) -> mish_runtime::StatusSnapshot {
        loop {
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let snapshot = runtime.status_snapshot_typed(adapter_kind).await;
            if !changes.has_changed().unwrap_or(false) {
                return snapshot;
            }
        }
    }

    /// Returns the authoritative native Status node catalog and Traffic snapshot
    /// from the same runtime instance. Native consumers can derive local views
    /// without polling Controller data or creating another Traffic authority.
    pub async fn native_traffic_handoff(
        &self,
    ) -> (StatusSnapshot, mish_runtime::TrafficDataSnapshot) {
        loop {
            let status_ticket = self
                .application_snapshots
                .begin(crate::snapshot_order::SnapshotStream::Status);
            let traffic_ticket = self
                .application_snapshots
                .begin(crate::snapshot_order::SnapshotStream::Traffic);
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let mut status = runtime
                .status_snapshot_typed(StatusAdapterKind::Native)
                .await;
            let mut traffic = runtime.traffic_snapshot_typed(StatusAdapterKind::Native);
            if !changes.has_changed().unwrap_or(false) {
                self.application_snapshots
                    .stamp_status(status_ticket, &mut status);
                self.application_snapshots
                    .stamp_traffic(traffic_ticket, &mut traffic);
                return (status, traffic);
            }
        }
    }

    pub fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        serde_json::to_value(self.traffic_snapshot_typed(adapter_kind))
            .expect("Traffic state must serialize")
    }

    pub fn traffic_snapshot_typed(
        &self,
        adapter_kind: StatusAdapterKind,
    ) -> mish_runtime::TrafficDataSnapshot {
        loop {
            let ticket = self
                .application_snapshots
                .begin(crate::snapshot_order::SnapshotStream::Traffic);
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let mut snapshot = runtime.traffic_snapshot_typed(adapter_kind);
            if !changes.has_changed().unwrap_or(false) {
                self.application_snapshots
                    .stamp_traffic(ticket, &mut snapshot);
                return snapshot;
            }
        }
    }

    pub fn provider_snapshot(&self) -> ProviderSnapshot {
        self.current().provider_snapshot()
    }

    pub async fn update_provider(
        &self,
        authority: ProviderAuthority,
        provider_id: String,
    ) -> ProviderCommandResult {
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let execution = runtime
            .update_provider(authority, provider_id.clone())
            .await;
        self.finish_provider_command(runtime, execution, Some(provider_id), changes)
    }

    pub async fn update_all_providers(
        &self,
        authority: ProviderAuthority,
        kind: ProviderKind,
    ) -> ProviderCommandResult {
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let execution = runtime.update_all_providers(authority, kind).await;
        self.finish_provider_command(runtime, execution, None, changes)
    }

    pub fn events_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        serde_json::to_value(self.events_snapshot_typed(adapter_kind))
            .expect("Events state must serialize")
    }

    pub fn events_snapshot_typed(&self, adapter_kind: StatusAdapterKind) -> EventsSnapshot {
        loop {
            let ticket = self
                .application_snapshots
                .begin(crate::snapshot_order::SnapshotStream::Events);
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let mut snapshot = runtime.events_snapshot_typed(adapter_kind);
            if !changes.has_changed().unwrap_or(false) {
                self.application_snapshots
                    .stamp_events(ticket, &mut snapshot);
                return snapshot;
            }
        }
    }

    pub(crate) fn begin_profile_snapshot(&self) -> crate::snapshot_order::SnapshotTicket {
        self.application_snapshots
            .begin(crate::snapshot_order::SnapshotStream::Profiles)
    }

    pub(crate) fn stamp_profile_snapshot(
        &self,
        ticket: crate::snapshot_order::SnapshotTicket,
        snapshot: &mut crate::ManagedProfileSnapshot,
    ) {
        self.application_snapshots.stamp_profiles(ticket, snapshot);
    }

    pub(crate) fn begin_status_snapshot(&self) -> crate::snapshot_order::SnapshotTicket {
        self.application_snapshots
            .begin(crate::snapshot_order::SnapshotStream::Status)
    }

    pub(crate) fn stamp_status_snapshot(
        &self,
        ticket: crate::snapshot_order::SnapshotTicket,
        snapshot: &mut StatusSnapshot,
    ) {
        self.application_snapshots.stamp_status(ticket, snapshot);
    }

    pub fn record_application_event(&self, event: ApplicationDiagnosticEvent) {
        self.current().record_application_event(event);
    }

    pub fn record_capture_failure(&self, error: &CaptureTransitionError) {
        self.current().record_capture_failure(error);
    }

    pub fn record_capture_failure_for_selection(
        &self,
        error: &CaptureTransitionError,
        selection: &mish_runtime::CaptureSelection,
    ) {
        self.current()
            .record_capture_failure_for_selection(error, selection);
    }

    pub fn publish_notification(
        &self,
        publication: NotificationPublication,
    ) -> Result<NotificationSnapshot, NotificationValidationError> {
        self.current().publish_notification(publication)
    }

    pub fn notification_snapshot(&self) -> NotificationSnapshot {
        self.current().notification_snapshot()
    }

    pub fn subscribe_notifications_with_snapshot(
        &self,
    ) -> (
        tokio::sync::broadcast::Receiver<NotificationSnapshot>,
        NotificationSnapshot,
    ) {
        self.current().subscribe_notifications_with_snapshot()
    }

    pub fn subscribe_notifications_with_presentation_claim(
        &self,
        identity: NotificationPresentationIdentity,
    ) -> (
        tokio::sync::broadcast::Receiver<NotificationSnapshot>,
        NotificationPresentationClaimResult,
    ) {
        self.current()
            .subscribe_notifications_with_presentation_claim(identity)
    }

    pub fn claim_next_notification_presentation(
        &self,
        identity: NotificationPresentationIdentity,
    ) -> NotificationPresentationClaimResult {
        self.current()
            .claim_next_notification_presentation(identity)
    }

    pub fn complete_notification_presentation(
        &self,
        completion: NotificationPresentationCompletion,
    ) -> NotificationPresentationCompletionResult {
        self.current()
            .complete_notification_presentation(completion)
    }

    pub fn release_notification_presentation_leases(
        &self,
        identity: &NotificationPresentationIdentity,
    ) -> NotificationSnapshot {
        self.current()
            .release_notification_presentation_leases(identity)
    }

    pub fn mark_notifications_read(&self, ids: &[String]) -> NotificationSnapshot {
        self.current().mark_notifications_read(ids)
    }

    pub fn remove_notification(&self, id: &str) -> NotificationSnapshot {
        self.current().remove_notification(id)
    }

    pub fn remove_notification_by_dedupe_key(&self, dedupe_key: &str) -> NotificationSnapshot {
        self.current().remove_notification_by_dedupe_key(dedupe_key)
    }

    pub fn resolve_notification(&self, dedupe_key: &str) -> NotificationSnapshot {
        self.current().resolve_notification(dedupe_key)
    }

    pub fn resolve_capture_failure_notifications(&self) -> NotificationSnapshot {
        self.current().resolve_capture_failure_notifications()
    }

    pub async fn support_bundle_runtime_snapshot(
        &self,
        adapter_kind: StatusAdapterKind,
    ) -> (CoreStatus, StatusSnapshot, EventsSnapshot) {
        loop {
            let status_ticket = self
                .application_snapshots
                .begin(crate::snapshot_order::SnapshotStream::Status);
            let events_ticket = self
                .application_snapshots
                .begin(crate::snapshot_order::SnapshotStream::Events);
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let core = runtime.core_status().await;
            let mut status = runtime.snapshot_typed_from_status(&core, adapter_kind);
            let mut events = runtime.events_snapshot_typed(adapter_kind);
            if !changes.has_changed().unwrap_or(false) {
                self.application_snapshots
                    .stamp_status(status_ticket, &mut status);
                self.application_snapshots
                    .stamp_events(events_ticket, &mut events);
                return (core, status, events);
            }
        }
    }

    fn finish_traffic_command(
        &self,
        runtime: MishRuntime,
        execution: TrafficCommandExecution,
        adapter_kind: StatusAdapterKind,
        mut changes: watch::Receiver<MishRuntime>,
        mut ticket: crate::snapshot_order::SnapshotTicket,
    ) -> Value {
        let mut runtime_replaced = changes.has_changed().unwrap_or(true);
        let notification_key = format!("traffic.operation-failed:{}", Uuid::new_v4());

        loop {
            let current = changes.borrow_and_update().clone();
            runtime_replaced |= !runtime.is_same_instance(&current);
            let execution = if runtime_replaced {
                ticket = self
                    .application_snapshots
                    .begin(crate::snapshot_order::SnapshotStream::Traffic);
                TrafficCommandExecution::failure(
                    execution.operation,
                    TrafficCommandFailureKind::RuntimeReplaced,
                    execution.target_count,
                    execution.remaining_connection_ids.clone(),
                )
            } else {
                execution.clone()
            };
            if let Some(failure) = execution.failure {
                let failure_id = traffic_failure_id(failure);
                current.record_application_event(ApplicationDiagnosticEvent::traffic_failure(
                    failure_id,
                ));
                let _ = current.publish_notification(NotificationPublication {
                    dedupe_key: notification_key.clone(),
                    pinned: false,
                    presentation: ApplicationNotification::new(
                        ApplicationNotificationContent::TrafficOperationFailed(
                            TrafficOperationFailedApplicationNotificationData {
                                failure: failure_id.into(),
                            },
                        ),
                        Vec::new(),
                    ),
                    replaces: Vec::new(),
                    resolved: false,
                    severity: mish_runtime::NotificationSeverity::Error,
                });
            }
            let mut snapshot = current.traffic_snapshot_typed(adapter_kind);
            self.application_snapshots
                .stamp_traffic(ticket, &mut snapshot);
            let result = serde_json::to_value(TrafficCommandResult::new(execution, snapshot))
                .expect("Traffic command result must serialize");
            if !changes.has_changed().unwrap_or(true) {
                return result;
            }
            runtime_replaced = true;
        }
    }

    async fn finish_status_command(
        &self,
        runtime: MishRuntime,
        result: Result<StatusSnapshot, StatusCommandError>,
        adapter_kind: StatusAdapterKind,
        mut changes: watch::Receiver<MishRuntime>,
    ) -> Result<StatusSnapshot, StatusCommandError> {
        let mut runtime_replaced = changes.has_changed().unwrap_or(true);
        let current = changes.borrow_and_update().clone();
        runtime_replaced |= !runtime.is_same_instance(&current);
        if !runtime_replaced {
            return result;
        }

        loop {
            let current = changes.borrow_and_update().clone();
            let snapshot = current.status_snapshot_typed(adapter_kind).await;
            if !changes.has_changed().unwrap_or(true) {
                return Err(StatusCommandError::runtime_replaced().with_reconciliation(snapshot));
            }
        }
    }

    fn finish_provider_command(
        &self,
        runtime: MishRuntime,
        execution: ProviderCommandExecution,
        provider_id: Option<String>,
        mut changes: watch::Receiver<MishRuntime>,
    ) -> ProviderCommandResult {
        let mut runtime_replaced = changes.has_changed().unwrap_or(true);
        loop {
            let current = changes.borrow_and_update().clone();
            runtime_replaced |= !runtime.is_same_instance(&current);
            let execution = if runtime_replaced {
                ProviderCommandExecution::failure(
                    execution.operation,
                    provider_id.clone(),
                    ProviderUpdateFailure::RuntimeReplaced,
                )
            } else {
                execution.clone()
            };
            let result = ProviderCommandResult::new(execution, current.provider_snapshot());
            if !changes.has_changed().unwrap_or(true) {
                return result;
            }
            runtime_replaced = true;
        }
    }
}
