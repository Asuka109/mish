use mish_runtime::{
    CaptureAuditReason, CaptureRecoveryAction, CaptureRequest, CaptureTransitionError, CoreError,
    CoreStatus, MishRuntime, RoutingMode, StatusAdapterKind, StatusCommand, StatusCommandError,
    TrafficCommandAuthority, TrafficCommandExecution, TrafficCommandFailureKind,
    TrafficCommandOperation, TrafficCommandResult,
};
use serde_json::Value;
use tokio::sync::watch;

#[derive(Clone)]
pub struct DesktopRuntimeHost {
    runtime: watch::Sender<MishRuntime>,
}

impl DesktopRuntimeHost {
    pub fn new(runtime: MishRuntime) -> Self {
        let (runtime, _) = watch::channel(runtime);
        Self { runtime }
    }

    pub fn current(&self) -> MishRuntime {
        self.runtime.borrow().clone()
    }

    pub fn replace(&self, runtime: MishRuntime) {
        self.runtime.send_replace(runtime);
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

    pub async fn start_core(&self) -> Result<CoreStatus, CoreError> {
        self.current().start_core().await
    }

    pub async fn stop_core(&self) -> Result<CoreStatus, CoreError> {
        self.current().stop_core().await
    }

    pub async fn set_capture(
        &self,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        self.current().set_capture(request, adapter_kind).await
    }

    pub async fn recover_system_proxy(
        &self,
        action: CaptureRecoveryAction,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        self.current()
            .recover_system_proxy(action, adapter_kind)
            .await
    }

    pub fn supports_status_command(&self, command: StatusCommand) -> bool {
        self.current().supports_status_command(command)
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
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let execution = runtime.close_connection(authority, connection_id).await;
        self.finish_traffic_command(runtime, execution, adapter_kind, changes)
    }

    pub async fn close_all_active(
        &self,
        authority: TrafficCommandAuthority,
        adapter_kind: StatusAdapterKind,
    ) -> Value {
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let execution = runtime.close_all_active(authority).await;
        self.finish_traffic_command(runtime, execution, adapter_kind, changes)
    }

    pub async fn set_routing_mode(
        &self,
        mode: RoutingMode,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.current().set_routing_mode(mode, adapter_kind).await
    }

    pub async fn select_group_child(
        &self,
        group_id: String,
        child_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.current()
            .select_group_child(group_id, child_id, adapter_kind)
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

    pub fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        loop {
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let snapshot = serde_json::to_value(runtime.traffic_snapshot_typed(adapter_kind))
                .expect("Traffic state must serialize");
            if !changes.has_changed().unwrap_or(false) {
                return snapshot;
            }
        }
    }

    pub fn events_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        self.current().events_snapshot(adapter_kind)
    }

    fn finish_traffic_command(
        &self,
        runtime: MishRuntime,
        execution: TrafficCommandExecution,
        adapter_kind: StatusAdapterKind,
        mut changes: watch::Receiver<MishRuntime>,
    ) -> Value {
        let mut runtime_replaced = changes.has_changed().unwrap_or(true);

        loop {
            let current = changes.borrow_and_update().clone();
            runtime_replaced |= !runtime.is_same_instance(&current);
            let execution = if runtime_replaced {
                TrafficCommandExecution::failure(
                    execution.operation,
                    TrafficCommandFailureKind::RuntimeReplaced,
                    execution.target_count,
                    execution.remaining_connection_ids.clone(),
                )
            } else {
                execution.clone()
            };
            let result = serde_json::to_value(TrafficCommandResult::new(
                execution,
                current.traffic_snapshot_typed(adapter_kind),
            ))
            .expect("Traffic command result must serialize");
            if !changes.has_changed().unwrap_or(true) {
                return result;
            }
            runtime_replaced = true;
        }
    }
}
