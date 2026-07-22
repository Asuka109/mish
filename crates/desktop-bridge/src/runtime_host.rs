use mish_runtime::{
    ApplicationDiagnosticEvent, CaptureAuditReason, CaptureRecoveryAction, CaptureRequest,
    CaptureTransitionError, CoreError, CoreStatus, DiagnosticHistory, EventsSnapshot, MishRuntime,
    ProviderAuthority, ProviderCommandExecution, ProviderCommandResult, ProviderKind,
    ProviderSnapshot, ProviderUpdateFailure, RoutingMode, StatusAdapterKind, StatusCommand,
    StatusCommandError, StatusSnapshot, TrafficCommandAuthority, TrafficCommandExecution,
    TrafficCommandFailureKind, TrafficCommandOperation, TrafficCommandResult,
};
use mish_state_authority::StateMutationAuthority;
use serde_json::Value;
use tokio::sync::watch;

#[derive(Clone)]
pub struct DesktopRuntimeHost {
    diagnostics: crate::DiagnosticCoordinator,
    mutation_authority: Option<StateMutationAuthority>,
    runtime: watch::Sender<MishRuntime>,
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
            diagnostics: crate::DiagnosticCoordinator::new(),
            mutation_authority,
            runtime,
        }
    }

    pub fn current(&self) -> MishRuntime {
        self.runtime.borrow().clone()
    }

    pub fn replace(&self, runtime: MishRuntime) {
        self.diagnostics.invalidate_active();
        self.runtime.send_replace(runtime);
    }

    pub fn invalidate_diagnostics(&self) {
        self.diagnostics.invalidate_active();
    }

    pub fn diagnostic_history(&self, adapter_kind: StatusAdapterKind) -> DiagnosticHistory {
        self.diagnostics.history(adapter_kind)
    }

    pub fn start_diagnostic_run(&self, adapter_kind: StatusAdapterKind) -> DiagnosticHistory {
        self.diagnostics
            .start(self.current(), self.subscribe_changes(), adapter_kind)
    }

    pub fn cancel_diagnostic_run(
        &self,
        run_id: &str,
        adapter_kind: StatusAdapterKind,
    ) -> DiagnosticHistory {
        self.diagnostics.cancel(run_id, adapter_kind)
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
        let mut changes = self.subscribe_changes();
        let runtime = changes.borrow_and_update().clone();
        let result = runtime.set_routing_mode(mode, adapter_kind).await;
        if changes.has_changed().unwrap_or(true)
            || !runtime.is_same_instance(&changes.borrow_and_update())
        {
            return Err(StatusCommandError::runtime_replaced());
        }
        result
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

    pub async fn start_group_delay_test(
        &self,
        group_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.current()
            .start_group_delay_test(group_id, adapter_kind)
            .await
    }

    pub async fn cancel_group_delay_test(
        &self,
        test_id: String,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, StatusCommandError> {
        self.current()
            .cancel_group_delay_test(test_id, adapter_kind)
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
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let status = runtime
                .status_snapshot_typed(StatusAdapterKind::Native)
                .await;
            let traffic = runtime.traffic_snapshot_typed(StatusAdapterKind::Native);
            if !changes.has_changed().unwrap_or(false) {
                return (status, traffic);
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
        self.current().events_snapshot(adapter_kind)
    }

    pub fn record_application_event(&self, event: ApplicationDiagnosticEvent) {
        self.current().record_application_event(event);
    }

    pub async fn support_bundle_runtime_snapshot(
        &self,
        adapter_kind: StatusAdapterKind,
    ) -> (CoreStatus, StatusSnapshot, EventsSnapshot) {
        loop {
            let mut changes = self.subscribe_changes();
            let runtime = changes.borrow_and_update().clone();
            let core = runtime.core_status().await;
            let status = runtime.snapshot_typed_from_status(&core, adapter_kind);
            let events = runtime.events_snapshot_typed(adapter_kind);
            if !changes.has_changed().unwrap_or(false) {
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
