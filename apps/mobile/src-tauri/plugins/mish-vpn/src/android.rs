use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
    time::Duration,
};

use mish_state_machine::{
    Correlation, EffectExecutor, RunnerConfig, RunnerHandle, TransitionObserver, spawn_runner,
};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Runtime,
    ipc::{Channel, InvokeResponseBody},
    plugin::{PluginApi, PluginHandle},
};
use tokio::sync::{Mutex, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    MobileConfigCancelRequest, MobileConfigCancelResult, MobileConfigLoadCancellation,
    MobileConfigLoadFailure, MobileConfigLoadOutcome, MobileConfigLoadRequest,
    MobileConfigLoadResult, MobileConfigLoadTiming, MobileConfigRollback,
    MobileConfigValidationFailure, MobileConfigValidationRequest, MobileConfigValidationResult,
    MobileVpnCommandRequest, MobileVpnCommandResult, MobileVpnSnapshot, Result,
    lifecycle::{
        ActivationAuthority, LifecycleCommandKind, LifecycleEffect, LifecycleInput,
        LifecycleMachine, LifecycleState, PlatformAction, PlatformFacts,
    },
    mobile_traffic::{
        MobileTrafficAuthority, MobileTrafficCloseRequest, MobileTrafficCommandResult,
        NativeTrafficCloseResult, NativeTrafficSnapshot,
    },
    models::{MobileConfigValidationOutcome, MobileVpnEvent},
    observation::{ObservationAdmission, PlatformObservationIngress},
};

const PLUGIN_IDENTIFIER: &str = "com.asuka109.mish.vpn";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

static MOBILE_ROUTES: OnceLock<Arc<Mutex<Option<crate::mobile_routes::MobileRouteAuthority>>>> =
    OnceLock::new();
static MOBILE_ROUTE_CONFIG_GATE: OnceLock<Arc<Mutex<()>>> = OnceLock::new();

#[derive(Clone)]
pub struct MishVpn<R: Runtime> {
    handle: PluginHandle<R>,
    lifecycle: Arc<Mutex<Option<Arc<LifecycleRuntime>>>>,
    traffic: Arc<Mutex<MobileTrafficAuthority>>,
    route_config_gate: Arc<Mutex<()>>,
    routes: Arc<Mutex<Option<crate::mobile_routes::MobileRouteAuthority>>>,
}

struct LifecycleRuntime {
    ingress: PlatformObservationIngress,
    runner: RunnerHandle<LifecycleMachine>,
    updates: watch::Receiver<LifecycleState>,
}

impl LifecycleRuntime {
    async fn reconcile(&self, facts: PlatformFacts) -> ObservationAdmission {
        let expected_session = facts.platform_session_id.clone();
        let expected_sequence = facts.fact_sequence;
        let offered = self.ingress.offer(facts);
        if matches!(
            offered,
            ObservationAdmission::RebindRequired | ObservationAdmission::SchemaRejected
        ) {
            return offered;
        }
        let mut updates = self.updates.clone();
        loop {
            let current = self.runner.snapshot();
            if current.facts.platform_session_id != expected_session {
                self.ingress.require_rebind();
                return ObservationAdmission::RebindRequired;
            }
            if current.facts.fact_sequence >= expected_sequence {
                return offered;
            }
            if self.ingress.requires_rebind() {
                return ObservationAdmission::RebindRequired;
            }
            if updates.changed().await.is_err() {
                self.ingress.require_rebind();
                return ObservationAdmission::RebindRequired;
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeListenerPayload {
    event: &'static str,
    handler: Channel<serde_json::Value>,
}

#[derive(Serialize)]
struct EmptyPayload {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformTrafficCloseRequest {
    connection_id: String,
    event_sequence: String,
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformStartRequest {
    config_digest: String,
    config_revision: String,
    fact_sequence: u64,
    platform_session_id: String,
    product_session_id: String,
    machine_authority: String,
    scope_epoch: u64,
    operation_id: String,
    admitted_revision: u64,
    effect_identity: String,
}

impl From<ActivationAuthority> for PlatformStartRequest {
    fn from(value: ActivationAuthority) -> Self {
        Self {
            config_digest: value.config_digest,
            config_revision: value.config_revision,
            fact_sequence: value.fact_sequence,
            platform_session_id: value.platform_session_id,
            product_session_id: value.product_session_id,
            machine_authority: value.machine_authority,
            scope_epoch: value.scope_epoch,
            operation_id: value.operation_id,
            admitted_revision: value.admitted_revision,
            effect_identity: value.effect_identity,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformStopRequest {
    machine_authority: String,
    scope_epoch: u64,
    operation_id: String,
    admitted_revision: u64,
    effect_identity: String,
}

impl From<&Correlation> for PlatformStopRequest {
    fn from(value: &Correlation) -> Self {
        Self {
            machine_authority: value.machine_authority.clone(),
            scope_epoch: value.scope_epoch,
            operation_id: value.operation_id.clone(),
            admitted_revision: value.admitted_revision,
            effect_identity: value.effect_id.to_string(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformConfigValidationRequest {
    config_bytes: Vec<u8>,
    sequence: u64,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlatformConfigValidationResult {
    contract_version: u8,
    failure: Option<MobileConfigValidationFailure>,
    message: String,
    outcome: MobileConfigValidationOutcome,
    sequence: u64,
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformConfigLoadRequest {
    config_bytes: Vec<u8>,
    digest: String,
    inject_failure: bool,
    operation_id: String,
    profile_id: String,
    revision: String,
    sequence: u64,
    session_id: String,
    timeout_millis: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlatformConfigLoadResult {
    cancellation: MobileConfigLoadCancellation,
    contract_version: u8,
    digest: String,
    failure: Option<MobileConfigLoadFailure>,
    facts: PlatformFacts,
    message: String,
    operation_id: String,
    outcome: MobileConfigLoadOutcome,
    revision: String,
    rollback: MobileConfigRollback,
    timing: MobileConfigLoadTiming,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformRouteRequest {
    child_id: Option<String>,
    current_child_id: Option<String>,
    group_id: Option<String>,
    native_child: Option<String>,
    native_current_child: Option<String>,
    native_group: Option<String>,
    operation_id: Option<String>,
    profile_id: Option<String>,
    profile_revision: Option<String>,
    runtime_authority: Option<String>,
}

pub fn init<R: Runtime>(_: &AppHandle<R>, api: PluginApi<R, ()>) -> Result<MishVpn<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MishVpnPlugin")?;
    Ok(MishVpn {
        handle,
        lifecycle: Arc::new(Mutex::new(None)),
        traffic: Arc::new(Mutex::new(MobileTrafficAuthority::default())),
        route_config_gate: MOBILE_ROUTE_CONFIG_GATE
            .get_or_init(|| Arc::new(Mutex::new(())))
            .clone(),
        routes: MOBILE_ROUTES
            .get_or_init(|| Arc::new(Mutex::new(None)))
            .clone(),
    })
}

impl<R: Runtime> MishVpn<R> {
    async fn native_route_result(
        &self,
        request: Option<&crate::MobileRouteCommandRequest>,
        native_labels: Option<(&str, &str, &str)>,
    ) -> Result<crate::mobile_routes::NativeRouteResult> {
        Ok(self
            .handle
            .run_mobile_plugin_async(
                if request.is_some() {
                    "selectRouteChild"
                } else {
                    "getRouteSnapshot"
                },
                PlatformRouteRequest {
                    child_id: request.map(|request| request.child_id.clone()),
                    current_child_id: request.map(|request| request.current_child_id.clone()),
                    group_id: request.map(|request| request.group_id.clone()),
                    native_child: native_labels.map(|(_, _, child)| child.to_owned()),
                    native_current_child: native_labels
                        .map(|(_, current_child, _)| current_child.to_owned()),
                    native_group: native_labels.map(|(group, _, _)| group.to_owned()),
                    operation_id: request.map(|request| request.operation_id.clone()),
                    profile_id: request.map(|request| request.profile_id.clone()),
                    profile_revision: request.map(|request| request.profile_revision.clone()),
                    runtime_authority: request.map(|request| request.runtime_authority.clone()),
                },
            )
            .await?)
    }

    pub async fn get_route_snapshot(&self) -> Result<crate::MobileRouteSnapshot> {
        let _route_config_guard = self.route_config_gate.lock().await;
        let current = self.runtime().await?.runner.snapshot();
        let mut routes = self.routes.lock().await;
        let authority = routes.as_mut().ok_or(crate::Error::RoutesUnavailable)?;
        if authority.runtime_authority() != current.authority_id {
            if current.phase == crate::lifecycle::LifecyclePhase::Stopped
                && current.platform_clean()
            {
                authority
                    .rebind_inactive_runtime(current.authority_id.clone(), current.scope_epoch);
            } else {
                return Err(crate::Error::RoutesUnavailable);
            }
        }
        let native = self.native_route_result(None, None).await?;
        authority
            .project(native, None)
            .map_err(|_| crate::Error::RoutesUnavailable)
    }

    pub async fn select_route_child(
        &self,
        request: crate::MobileRouteCommandRequest,
    ) -> Result<crate::MobileRouteCommandResult> {
        let _route_config_guard = self.route_config_gate.lock().await;
        let initial = self.runtime().await?.runner.snapshot();
        let mut routes = self.routes.lock().await;
        let authority = routes.as_mut().ok_or(crate::Error::RoutesUnavailable)?;
        if authority.runtime_authority() != initial.authority_id {
            if initial.phase == crate::lifecycle::LifecyclePhase::Stopped
                && initial.platform_clean()
            {
                authority
                    .rebind_inactive_runtime(initial.authority_id.clone(), initial.scope_epoch);
            } else {
                return Err(crate::Error::RoutesUnavailable);
            }
        }
        // This mutex is the Route effect/snapshot linearization gate. It keeps
        // stale native reads from being projected after a newer selection and
        // gives cancellation an exact before-effect or too-late ordering.
        let baseline_native = self.native_route_result(None, None).await?;
        let baseline = authority
            .project(baseline_native, None)
            .map_err(|_| crate::Error::RoutesUnavailable)?;
        match authority.duplicate(&request) {
            Ok(Some(mut result)) => {
                result.snapshot = baseline;
                return Ok(result);
            }
            Err(failure) => {
                return Ok(authority.failure_result(
                    request.operation_id.clone(),
                    failure,
                    baseline,
                ));
            }
            Ok(None) => {}
        }
        let (group, current_child, child) = match authority.preflight(&request) {
            Ok(labels) => labels,
            Err(failure) => {
                let result =
                    authority.failure_result(request.operation_id.clone(), failure, baseline);
                authority.remember(request, result.clone());
                return Ok(result);
            }
        };
        let native = self
            .native_route_result(Some(&request), Some((&group, &current_child, &child)))
            .await?;
        let current = self.runtime().await?.runner.snapshot();
        let result = if current.authority_id != initial.authority_id
            || current.session_id != initial.session_id
            || authority.runtime_authority() != current.authority_id
        {
            authority.failure_result(
                request.operation_id.clone(),
                crate::mobile_routes::MobileRouteFailure::RuntimeReplaced,
                baseline,
            )
        } else {
            match authority.project(native, Some(&request.operation_id)) {
                Ok(snapshot) => crate::MobileRouteCommandResult {
                    contract_version: 1,
                    failure: None,
                    operation_id: request.operation_id.clone(),
                    snapshot,
                    status: crate::mobile_routes::MobileRouteCommandStatus::Success,
                },
                Err(failure) => {
                    authority.failure_result(request.operation_id.clone(), failure, baseline)
                }
            }
        };
        authority.remember(request, result.clone());
        Ok(result)
    }

    pub async fn cancel_route_selection(
        &self,
        request: crate::MobileRouteCancelRequest,
    ) -> crate::MobileRouteCancelResult {
        let accepted = self
            .routes
            .lock()
            .await
            .as_mut()
            .is_some_and(|authority| authority.cancel(&request.operation_id));
        crate::MobileRouteCancelResult {
            accepted,
            contract_version: 1,
            operation_id: request.operation_id,
        }
    }

    async fn cleanup_before_replacement(&self, runtime: &LifecycleRuntime) -> Result<bool> {
        let retirement = runtime.runner.shutdown().await;
        if retirement.state.phase == crate::lifecycle::LifecyclePhase::Stopped
            && retirement.state.platform_clean()
        {
            return Ok(true);
        }
        // A forced runner retirement cannot prove that a platform callback,
        // descriptor, or service task is gone. Reconcile a fresh native
        // snapshot before admitting a successor authority; otherwise keep
        // replacement blocked and fail closed.
        let facts: PlatformFacts = self
            .handle
            .run_mobile_plugin_async("getPlatformFacts", EmptyPayload {})
            .await?;
        facts
            .validate()
            .map_err(|_| crate::Error::PlatformFactsSchemaRejected)?;
        Ok(LifecycleState::facts_platform_clean(&facts))
    }

    async fn runtime(&self) -> Result<Arc<LifecycleRuntime>> {
        let mut lifecycle = self.lifecycle.lock().await;
        if let Some(runtime) = lifecycle.as_ref() {
            match runtime.ingress.terminal_admission() {
                None => return Ok(runtime.clone()),
                Some(ObservationAdmission::SchemaRejected) => {
                    let runtime = lifecycle.take().expect("checked lifecycle runtime");
                    runtime.runner.shutdown().await;
                    return Err(crate::Error::PlatformFactsSchemaRejected);
                }
                Some(_) => {
                    if !self.cleanup_before_replacement(runtime).await? {
                        return Err(crate::Error::LifecycleRetirementPending);
                    }
                    lifecycle.take();
                }
            }
        }
        let runtime = Arc::new(self.initialize_lifecycle().await?);
        *lifecycle = Some(runtime.clone());
        Ok(runtime)
    }

    async fn initialize_lifecycle(&self) -> Result<LifecycleRuntime> {
        let ingress = PlatformObservationIngress::unbound();
        let listener_ingress = ingress.clone();
        let channel = Channel::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                listener_ingress.offer_json("");
                return Ok(());
            };
            listener_ingress.offer_json(&json);
            Ok(())
        });
        self.handle
            .run_mobile_plugin_async::<()>(
                "registerListener",
                NativeListenerPayload {
                    event: "facts",
                    handler: channel,
                },
            )
            .await?;
        let facts: PlatformFacts = self
            .handle
            .run_mobile_plugin_async("getPlatformFacts", EmptyPayload {})
            .await?;
        facts
            .validate()
            .map_err(|_| crate::Error::PlatformFactsSchemaRejected)?;
        if ingress.bind_baseline(&facts) == ObservationAdmission::SchemaRejected {
            return Err(crate::Error::PlatformFactsSchemaRejected);
        }
        let initial = LifecycleState::initial(
            Uuid::new_v4().to_string(),
            Uuid::new_v4().to_string(),
            facts,
        );
        let (updates, receiver) = watch::channel(initial.clone());
        let observer = Arc::new(LifecycleObserver {
            app: self.handle.app().clone(),
            updates,
        });
        let executor = Arc::new(AndroidLifecycleExecutor {
            handle: self.handle.clone(),
        });
        let runner = spawn_runner(
            Arc::new(LifecycleMachine),
            initial,
            executor,
            observer,
            RunnerConfig::default(),
        );
        let event_runner = runner.clone();
        let event_ingress = ingress.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match event_ingress.deliver_next(&event_runner).await {
                    ObservationAdmission::Accepted
                    | ObservationAdmission::Coalesced
                    | ObservationAdmission::Stale => {}
                    ObservationAdmission::Backpressured => tokio::task::yield_now().await,
                    ObservationAdmission::RebindRequired | ObservationAdmission::SchemaRejected => {
                        break;
                    }
                }
            }
        });
        Ok(LifecycleRuntime {
            ingress,
            runner,
            updates: receiver,
        })
    }

    pub async fn get_snapshot(&self) -> Result<MobileVpnSnapshot> {
        let runtime = self.runtime().await?;
        let facts: PlatformFacts = self
            .handle
            .run_mobile_plugin_async("getPlatformFacts", EmptyPayload {})
            .await?;
        if matches!(
            runtime.reconcile(facts).await,
            ObservationAdmission::RebindRequired | ObservationAdmission::SchemaRejected
        ) {
            let rebound = self.runtime().await?;
            return Ok(MobileVpnSnapshot::from_lifecycle(
                &rebound.runner.snapshot(),
            ));
        }
        Ok(MobileVpnSnapshot::from_lifecycle(
            &runtime.runner.snapshot(),
        ))
    }

    pub async fn get_core_provenance(&self) -> Result<crate::MobileCoreProvenanceSnapshot> {
        let snapshot: crate::MobileCoreProvenanceSnapshot = self
            .handle
            .run_mobile_plugin_async("getCoreProvenance", EmptyPayload {})
            .await?;
        if !snapshot.validate() {
            return Err(crate::Error::PlatformFactsSchemaRejected);
        }
        Ok(snapshot)
    }

    pub async fn get_traffic_snapshot(&self) -> Result<mish_runtime::TrafficDataSnapshot> {
        let _route_config_guard = self.route_config_gate.lock().await;
        let runtime = self.runtime().await?;
        let state = runtime.runner.snapshot();
        let profile_id = self
            .routes
            .lock()
            .await
            .as_ref()
            .map(|authority| authority.profile_id().to_owned())
            .unwrap_or_else(|| "mobile-profile-unavailable".into());
        let mut traffic = self.traffic.lock().await;
        if state.phase != crate::lifecycle::LifecyclePhase::Running
            || profile_id == "mobile-profile-unavailable"
        {
            return Ok(traffic.unavailable(&state.authority_id, state.scope_epoch, &profile_id));
        }
        let native: NativeTrafficSnapshot = self
            .handle
            .run_mobile_plugin_async("getTrafficSnapshot", EmptyPayload {})
            .await?;
        traffic
            .project(&state.authority_id, state.scope_epoch, &profile_id, native)
            .map_err(|_| crate::Error::TrafficObservationRejected)
    }

    pub async fn close_traffic_connection(
        &self,
        request: MobileTrafficCloseRequest,
    ) -> Result<MobileTrafficCommandResult> {
        let _route_config_guard = self.route_config_gate.lock().await;
        let runtime = self.runtime().await?;
        let state = runtime.runner.snapshot();
        let profile_id = self
            .routes
            .lock()
            .await
            .as_ref()
            .map(|authority| authority.profile_id().to_owned())
            .unwrap_or_else(|| "mobile-profile-unavailable".into());
        let mut traffic = self.traffic.lock().await;
        if let Some(result) = traffic.duplicate(&request) {
            return Ok(result);
        }
        if let Err(failure) = traffic.validate_request(&request) {
            return Ok(traffic.failure(request, failure, false));
        }
        if state.phase != crate::lifecycle::LifecyclePhase::Running
            || state.authority_id != request.runtime_authority_id
            || state.scope_epoch != traffic.current().application_order.epoch
            || profile_id != request.profile_id
        {
            return Ok(traffic.failure(
                request,
                mish_runtime::TrafficCommandFailureKind::RuntimeReplaced,
                false,
            ));
        }

        // This is the required TOCTOU barrier. The native adapter performs a closed,
        // bounded snapshot call immediately before it is allowed to mutate one ID.
        let fresh: NativeTrafficSnapshot = self
            .handle
            .run_mobile_plugin_async("getTrafficSnapshot", EmptyPayload {})
            .await?;
        let native_event_sequence = fresh.event_sequence.clone();
        let native_session_id = fresh.session_id.clone();
        if traffic
            .project(&state.authority_id, state.scope_epoch, &profile_id, fresh)
            .is_err()
        {
            return Ok(traffic.failure(
                request,
                mish_runtime::TrafficCommandFailureKind::InconsistentObservation,
                false,
            ));
        }
        if !traffic.same_scope(&request) {
            return Ok(traffic.failure(
                request,
                mish_runtime::TrafficCommandFailureKind::RuntimeReplaced,
                false,
            ));
        }
        if !traffic.has_connection(&request.connection_id) {
            return Ok(traffic.failure(
                request,
                mish_runtime::TrafficCommandFailureKind::StaleConnection,
                false,
            ));
        }

        let native: NativeTrafficCloseResult = self
            .handle
            .run_mobile_plugin_async(
                "closeTrafficConnection",
                PlatformTrafficCloseRequest {
                    connection_id: request.connection_id.clone(),
                    event_sequence: native_event_sequence,
                    session_id: native_session_id,
                },
            )
            .await?;
        if traffic
            .project(
                &state.authority_id,
                state.scope_epoch,
                &profile_id,
                native.snapshot,
            )
            .is_err()
        {
            return Ok(traffic.failure(
                request,
                mish_runtime::TrafficCommandFailureKind::InconsistentObservation,
                true,
            ));
        }
        let current_state = runtime.runner.snapshot();
        if current_state.authority_id != state.authority_id
            || current_state.scope_epoch != state.scope_epoch
        {
            let current_profile_id = self
                .routes
                .lock()
                .await
                .as_ref()
                .map(|authority| authority.profile_id().to_owned())
                .unwrap_or_else(|| "mobile-profile-unavailable".into());
            if current_state.phase == crate::lifecycle::LifecyclePhase::Running {
                let current_native: NativeTrafficSnapshot = self
                    .handle
                    .run_mobile_plugin_async("getTrafficSnapshot", EmptyPayload {})
                    .await?;
                if traffic
                    .project(
                        &current_state.authority_id,
                        current_state.scope_epoch,
                        &current_profile_id,
                        current_native,
                    )
                    .is_err()
                {
                    traffic.unavailable(
                        &current_state.authority_id,
                        current_state.scope_epoch,
                        &current_profile_id,
                    );
                }
            } else {
                traffic.unavailable(
                    &current_state.authority_id,
                    current_state.scope_epoch,
                    &current_profile_id,
                );
            }
            return Ok(traffic.failure(
                request,
                mish_runtime::TrafficCommandFailureKind::RuntimeReplaced,
                false,
            ));
        }
        if let Some(failure) = native.failure {
            let remains = traffic.has_connection(&request.connection_id);
            return Ok(traffic.failure(request, failure.command_failure(), remains));
        }
        if traffic.has_connection(&request.connection_id) {
            return Ok(traffic.failure(
                request,
                mish_runtime::TrafficCommandFailureKind::PartialRemaining,
                true,
            ));
        }
        let result =
            MobileTrafficCommandResult::success(request.operation_id.clone(), traffic.current());
        Ok(traffic.remember(request, result))
    }

    pub async fn request_notification_permission(
        &self,
        request: MobileVpnCommandRequest,
    ) -> Result<MobileVpnCommandResult> {
        self.execute_command(LifecycleCommandKind::RequestNotificationPermission, request)
            .await
    }

    pub async fn request_vpn_consent(
        &self,
        request: MobileVpnCommandRequest,
    ) -> Result<MobileVpnCommandResult> {
        self.execute_command(LifecycleCommandKind::RequestVpnConsent, request)
            .await
    }

    pub async fn start(&self, request: MobileVpnCommandRequest) -> Result<MobileVpnCommandResult> {
        self.execute_command(LifecycleCommandKind::Start, request)
            .await
    }

    pub async fn stop(&self, request: MobileVpnCommandRequest) -> Result<MobileVpnCommandResult> {
        self.execute_command(LifecycleCommandKind::Stop, request)
            .await
    }

    pub async fn cancel_lifecycle_operation(
        &self,
        request: MobileVpnCommandRequest,
    ) -> Result<MobileVpnCommandResult> {
        let runtime = self.runtime().await?;
        let current = runtime.runner.snapshot();
        if !valid_operation_id(&request.operation_id) {
            return Ok(MobileVpnCommandResult::invalid(
                request.operation_id,
                LifecycleCommandKind::Stop,
                MobileVpnSnapshot::from_lifecycle(&current),
            ));
        }
        let _ = runtime
            .runner
            .admit(LifecycleInput::Cancel {
                operation_id: request.operation_id.clone(),
                timed_out: false,
            })
            .await;
        if let Some(result) =
            MobileVpnCommandResult::from_state(&runtime.runner.snapshot(), &request.operation_id)
        {
            return Ok(result);
        }
        let mut updates = runtime.updates.clone();
        let operation_id = request.operation_id;
        let terminal = async {
            loop {
                if let Some(result) =
                    MobileVpnCommandResult::from_state(&updates.borrow(), &operation_id)
                {
                    return result;
                }
                if updates.changed().await.is_err() {
                    return command_result_or_invalid(
                        &runtime.runner.snapshot(),
                        operation_id.clone(),
                    );
                }
            }
        };
        Ok(tokio::time::timeout(COMMAND_TIMEOUT, terminal)
            .await
            .unwrap_or_else(|_| {
                command_result_or_invalid(&runtime.runner.snapshot(), operation_id.clone())
            }))
    }

    async fn execute_command(
        &self,
        command: LifecycleCommandKind,
        request: MobileVpnCommandRequest,
    ) -> Result<MobileVpnCommandResult> {
        let runtime = self.runtime().await?;
        let initial = runtime.runner.snapshot();
        if !valid_operation_id(&request.operation_id) {
            return Ok(MobileVpnCommandResult::invalid(
                request.operation_id,
                command,
                MobileVpnSnapshot::from_lifecycle(&initial),
            ));
        }
        if initial
            .operation(&request.operation_id)
            .is_some_and(|operation| operation.kind != command)
        {
            return Ok(MobileVpnCommandResult::invalid(
                request.operation_id,
                command,
                MobileVpnSnapshot::from_lifecycle(&initial),
            ));
        }
        if let Some(result) = MobileVpnCommandResult::from_state(&initial, &request.operation_id) {
            return Ok(result);
        }
        let admitted_revision = initial.revision.saturating_add(1);
        let correlation = mish_state_machine::Correlation {
            machine_authority: initial.authority_id.clone(),
            scope_epoch: initial.scope_epoch,
            operation_id: request.operation_id.clone(),
            admitted_revision,
            effect_id: 1,
        };
        let _ = runtime
            .runner
            .admit(LifecycleInput::Command {
                command,
                correlation,
                new_session_id: (command == LifecycleCommandKind::Start)
                    .then(|| Uuid::new_v4().to_string()),
            })
            .await;
        if let Some(result) =
            MobileVpnCommandResult::from_state(&runtime.runner.snapshot(), &request.operation_id)
        {
            return Ok(result);
        }

        let mut updates = runtime.updates.clone();
        let operation_id = request.operation_id.clone();
        let terminal = async {
            loop {
                if let Some(result) =
                    MobileVpnCommandResult::from_state(&updates.borrow(), &operation_id)
                {
                    return result;
                }
                if updates.changed().await.is_err() {
                    return command_result_or_invalid(&runtime.runner.snapshot(), operation_id);
                }
            }
        };
        match tokio::time::timeout(COMMAND_TIMEOUT, terminal).await {
            Ok(result) => Ok(result),
            Err(_) => {
                let _ = runtime
                    .runner
                    .admit(LifecycleInput::Cancel {
                        operation_id: request.operation_id.clone(),
                        timed_out: true,
                    })
                    .await;
                Ok(command_result_or_invalid(
                    &runtime.runner.snapshot(),
                    request.operation_id,
                ))
            }
        }
    }

    pub async fn validate_config(
        &self,
        request: MobileConfigValidationRequest,
    ) -> MobileConfigValidationResult {
        if let Some(result) = MobileConfigValidationResult::preflight(&request) {
            return result;
        }
        let Ok(runtime) = self.runtime().await else {
            return MobileConfigValidationResult::plugin_failure(&request);
        };
        let initial = runtime.runner.snapshot();
        if request.sequence != initial.sequence || request.session_id != initial.session_id {
            return MobileConfigValidationResult::failure(
                MobileConfigValidationFailure::StaleAuthority,
                "The mobile runtime authority is stale.",
                initial.sequence,
                &initial.session_id,
            );
        }
        let platform_request = PlatformConfigValidationRequest {
            config_bytes: request.config_bytes,
            sequence: initial.facts.fact_sequence,
            session_id: initial.facts.platform_session_id.clone(),
        };
        let result = self
            .handle
            .run_mobile_plugin_async::<PlatformConfigValidationResult>(
                "validateConfig",
                platform_request,
            )
            .await;
        let current = runtime.runner.snapshot();
        let Ok(result) = result else {
            return MobileConfigValidationResult::failure(
                MobileConfigValidationFailure::PluginFailure,
                "The Android validation plugin failed safely.",
                current.sequence,
                &current.session_id,
            );
        };
        if current.authority_id != initial.authority_id
            || current.session_id != initial.session_id
            || result.contract_version != 1
            || result.sequence != initial.facts.fact_sequence
            || result.session_id != initial.facts.platform_session_id
            || result.message.len() > 256
        {
            return MobileConfigValidationResult::failure(
                MobileConfigValidationFailure::StaleAuthority,
                "The mobile runtime authority changed during configuration validation.",
                current.sequence,
                &current.session_id,
            );
        }
        MobileConfigValidationResult {
            contract_version: 1,
            failure: result.failure,
            message: result.message,
            outcome: result.outcome,
            sequence: Some(current.sequence),
            session_id: Some(current.session_id),
        }
    }

    pub async fn load_config(&self, request: MobileConfigLoadRequest) -> MobileConfigLoadResult {
        if let Some(result) = MobileConfigLoadResult::preflight(&request) {
            return result;
        }
        // Configuration replacement and Route native effects share this
        // process-wide gate. A command admitted for one committed profile can
        // therefore never reach a replacement Core before its new Route
        // authority is published, including across Activity recreation.
        let _route_config_guard = self.route_config_gate.lock().await;
        let Ok(runtime) = self.runtime().await else {
            return MobileConfigLoadResult::plugin_failure(&request, None);
        };
        let initial = runtime.runner.snapshot();
        if request.sequence != initial.sequence || request.session_id != initial.session_id {
            return MobileConfigLoadResult::failure(
                &request,
                MobileConfigLoadFailure::StaleAuthority,
                "The mobile runtime authority is stale.",
                Some(MobileVpnSnapshot::from_lifecycle(&initial)),
            );
        }
        let platform_request = PlatformConfigLoadRequest {
            config_bytes: request.config_bytes.clone(),
            digest: request.digest.clone(),
            inject_failure: request.inject_failure,
            operation_id: request.operation_id.clone(),
            profile_id: request.profile_id.clone(),
            revision: request.revision.clone(),
            sequence: initial.facts.fact_sequence,
            session_id: initial.facts.platform_session_id.clone(),
            timeout_millis: request.timeout_millis,
        };
        let result = self
            .handle
            .run_mobile_plugin_async::<PlatformConfigLoadResult>("loadConfig", platform_request)
            .await;
        let Ok(result) = result else {
            return MobileConfigLoadResult::plugin_failure(
                &request,
                Some(MobileVpnSnapshot::from_lifecycle(
                    &runtime.runner.snapshot(),
                )),
            );
        };
        if result.contract_version != 1
            || result.message.len() > 256
            || result.operation_id != request.operation_id
            || result.revision != request.revision
            || result.digest != request.digest
        {
            return MobileConfigLoadResult::plugin_failure(
                &request,
                Some(MobileVpnSnapshot::from_lifecycle(
                    &runtime.runner.snapshot(),
                )),
            );
        }
        if result.facts.platform_session_id != initial.facts.platform_session_id
            || result.facts.fact_sequence < initial.facts.fact_sequence
        {
            return MobileConfigLoadResult::failure(
                &request,
                MobileConfigLoadFailure::RuntimeReplaced,
                "The Android platform authority was replaced during configuration loading.",
                Some(MobileVpnSnapshot::from_lifecycle(
                    &runtime.runner.snapshot(),
                )),
            );
        }
        let reconciliation = runtime.reconcile(result.facts).await;
        if reconciliation == ObservationAdmission::SchemaRejected {
            return MobileConfigLoadResult::failure(
                &request,
                MobileConfigLoadFailure::PluginFailure,
                "The Android platform facts schema was rejected.",
                Some(MobileVpnSnapshot::from_lifecycle(
                    &runtime.runner.snapshot(),
                )),
            );
        }
        if reconciliation == ObservationAdmission::RebindRequired {
            let rebound = self.runtime().await.ok();
            return MobileConfigLoadResult::failure(
                &request,
                MobileConfigLoadFailure::RuntimeReplaced,
                "The Android platform adapter was replaced during configuration loading.",
                rebound
                    .as_ref()
                    .map(|runtime| MobileVpnSnapshot::from_lifecycle(&runtime.runner.snapshot())),
            );
        }
        let current = runtime.runner.snapshot();
        if current.authority_id != initial.authority_id || current.session_id != initial.session_id
        {
            return MobileConfigLoadResult::failure(
                &request,
                MobileConfigLoadFailure::RuntimeReplaced,
                "The mobile runtime was replaced during configuration loading.",
                Some(MobileVpnSnapshot::from_lifecycle(&current)),
            );
        }
        // Outcome records the reconciled Core commit point independently from
        // the command's terminal timing. A late committed load reports a
        // timeout failure but must still replace Route authority.
        if result.outcome.committed() {
            let mut routes = self.routes.lock().await;
            *routes = crate::mobile_routes::MobileRouteAuthority::reconcile_committed_profile(
                routes.take(),
                result.outcome == MobileConfigLoadOutcome::NoOp,
                crate::mobile_routes::CommittedRouteProfile {
                    config_bytes: &request.config_bytes,
                    config_digest: &request.digest,
                    profile_id: &request.profile_id,
                    profile_revision: &request.revision,
                    runtime_authority: current.authority_id.clone(),
                    runtime_epoch: current.scope_epoch,
                },
            );
        }
        MobileConfigLoadResult {
            cancellation: result.cancellation,
            contract_version: 1,
            digest: result.digest,
            failure: result.failure,
            message: result.message,
            operation_id: result.operation_id,
            outcome: result.outcome,
            revision: result.revision,
            rollback: result.rollback,
            snapshot: Some(MobileVpnSnapshot::from_lifecycle(&current)),
            timing: result.timing,
        }
    }

    pub fn cancel_config_load(
        &self,
        request: MobileConfigCancelRequest,
    ) -> MobileConfigCancelResult {
        self.handle
            .run_mobile_plugin("cancelConfigLoad", &request)
            .unwrap_or(MobileConfigCancelResult {
                accepted: false,
                contract_version: 1,
                operation_id: request.operation_id,
            })
    }
}

struct AndroidLifecycleExecutor<R: Runtime> {
    handle: PluginHandle<R>,
}

impl<R: Runtime> EffectExecutor<LifecycleMachine> for AndroidLifecycleExecutor<R> {
    fn execute(
        &self,
        effect: LifecycleEffect,
        _cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LifecycleInput> + Send + 'static>> {
        let handle = self.handle.clone();
        Box::pin(async move {
            let result = match effect.action {
                PlatformAction::StartForegroundService => {
                    let Some(activation) = effect.activation.clone() else {
                        return LifecycleInput::EffectFailed {
                            action: effect.action,
                            correlation: effect.correlation,
                        };
                    };
                    handle
                        .run_mobile_plugin_async::<PlatformFacts>(
                            "startPlatformLifecycle",
                            PlatformStartRequest::from(activation),
                        )
                        .await
                }
                PlatformAction::RequestNotificationPermission => {
                    handle
                        .run_mobile_plugin_async::<PlatformFacts>(
                            "requestNotificationPermission",
                            EmptyPayload {},
                        )
                        .await
                }
                PlatformAction::RequestVpnConsent => {
                    handle
                        .run_mobile_plugin_async::<PlatformFacts>(
                            "requestVpnConsent",
                            EmptyPayload {},
                        )
                        .await
                }
                PlatformAction::StopForegroundService => {
                    let request = PlatformStopRequest::from(&effect.correlation);
                    handle
                        .run_mobile_plugin_async::<PlatformFacts>("stopPlatformLifecycle", request)
                        .await
                }
            };
            match result {
                Ok(facts) => LifecycleInput::EffectCompleted {
                    action: effect.action,
                    correlation: effect.correlation,
                    facts,
                },
                Err(_) => LifecycleInput::EffectFailed {
                    action: effect.action,
                    correlation: effect.correlation,
                },
            }
        })
    }
}

struct LifecycleObserver<R: Runtime> {
    app: AppHandle<R>,
    updates: watch::Sender<LifecycleState>,
}

impl<R: Runtime> TransitionObserver<LifecycleMachine> for LifecycleObserver<R> {
    fn transitioned(
        &self,
        previous: &LifecycleState,
        _: &LifecycleInput,
        current: &LifecycleState,
        _: mish_state_machine::Disposition,
    ) {
        if current.sequence <= previous.sequence {
            return;
        }
        self.updates.send_replace(current.clone());
        let _ = self
            .app
            .emit("mish-vpn://snapshot", MobileVpnEvent::from_state(current));
    }
}

fn valid_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.len() <= 128
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn command_result_or_invalid(
    state: &LifecycleState,
    operation_id: String,
) -> MobileVpnCommandResult {
    MobileVpnCommandResult::from_state(state, &operation_id).unwrap_or_else(|| {
        MobileVpnCommandResult::invalid(
            operation_id,
            LifecycleCommandKind::Stop,
            MobileVpnSnapshot::from_lifecycle(state),
        )
    })
}
