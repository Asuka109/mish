use std::{
    collections::HashSet,
    sync::atomic::{AtomicU64, Ordering},
};

use axum::extract::ws::{Message, WebSocket};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use mish_profile::{
    ImportError, ProfilePatch, ProfileRefreshPolicy, ProfileRefreshTrigger, ProfileServiceError,
    RepositoryError,
};
use mish_runtime::{
    ApplicationDiagnosticEvent, ApplicationNotification, ApplicationNotificationContent,
    CapabilityAvailability, CaptureFailureKind, CaptureRecoveryAction, CaptureRequest,
    CaptureSelection, CaptureTransitionError, CoreError, CoreErrorKind, CoreStatus,
    NotificationPublication, NotificationSeverity, ProviderAuthority, ProviderKind, RoutingMode,
    SettingsOperationFailedApplicationNotificationData, StatusAdapterKind, StatusCommand,
    StatusCommandError, StatusCommandErrorKind, SystemProxyTakeoverPolicy, TrafficCommandAuthority,
    TrafficCommandOperation,
};
use mish_settings::{
    AppearancePreference, LanguagePreference, ManagedPortPreferences, OnboardingWelcomeAction,
    ProcessDiscoveryMode, SettingsAdapterKind, SettingsService, SettingsServiceError,
    StartupPreferences, WindowCloseBehavior, WindowSurfacePreference,
};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_SUBSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);
const PROCESS_ICON_MAX_BYTES: usize = 262_144;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authentication {
    client_name: String,
    client_version: String,
    token: String,
}

#[derive(Clone)]
pub(crate) struct ProtocolState {
    pub auth_token: String,
    pub profile_activation: Option<std::sync::Arc<crate::ProfileActivationCoordinator>>,
    pub profile_file_actions: Option<std::sync::Arc<crate::ProfileFileActions>>,
    pub profile_service: Option<std::sync::Arc<crate::DesktopProfileService>>,
    pub process_icon_resolver: Option<std::sync::Arc<dyn crate::ProcessIconResolver>>,
    pub runtime: crate::DesktopRuntimeHost,
    pub service_probes: Option<crate::service_probes::ServiceProbeService>,
    pub settings_service: Option<std::sync::Arc<SettingsService>>,
    pub socket_shutdown: CancellationToken,
}

impl ProtocolState {
    async fn status_snapshot(&self) -> Value {
        let mut snapshot = self
            .runtime
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        if let Some(service_probes) = &self.service_probes {
            service_probes.overlay(&mut snapshot);
        }
        serde_json::to_value(snapshot).expect("Status state must serialize")
    }

    async fn status_snapshot_with_capture(
        &self,
        capture_status: mish_runtime::CaptureRuntimeStatus,
    ) -> Value {
        let runtime = self.runtime.current();
        let core = runtime.core_status().await;
        let mut snapshot = runtime.snapshot_typed_with_capture_status(
            &core,
            StatusAdapterKind::Rpc,
            capture_status,
        );
        if let Some(service_probes) = &self.service_probes {
            service_probes.overlay(&mut snapshot);
        }
        serde_json::to_value(snapshot).expect("Status state must serialize")
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfilePreflightHttpsParams {
    #[serde(default)]
    label: Option<String>,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileCreateParams {
    file_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileIdParams {
    profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfilePatchAuthorityParams {
    artifact_fingerprint: String,
    profile_id: String,
    source_revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileReplacePatchesParams {
    authority: ProfilePatchAuthorityParams,
    patches: Vec<ProfilePatch>,
    schema_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileRefreshPolicyParams {
    profile_id: String,
    policy: ProfileRefreshPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateProviderParams {
    authority: ProviderAuthority,
    provider_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAllProvidersParams {
    authority: ProviderAuthority,
    kind: ProviderKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileSaveParams {
    preview_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileActivationParams {
    command_id: String,
    profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetRoutingModeParams {
    mode: RoutingMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertServiceMonitorParams {
    draft: crate::service_probes::ServiceMonitorDraft,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveServiceMonitorParams {
    monitor_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestServiceMonitorParams {
    monitor_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetServiceProbeIntervalParams {
    interval_seconds: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetCaptureParams {
    active: bool,
    #[serde(default)]
    profile_id: Option<String>,
    selection: CaptureSelection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetManagedPortsParams {
    managed_ports: ManagedPortPreferences,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileCommandParams {
    command_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoverSystemProxyParams {
    action: CaptureRecoveryAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetAppearanceParams {
    appearance: AppearancePreference,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetLanguageParams {
    language: LanguagePreference,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetOnboardingWelcomeStateParams {
    action: OnboardingWelcomeAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetStartupParams {
    startup: StartupPreferences,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetLaunchProxyWhenMishLaunchesParams {
    launch_proxy_when_mish_launches: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetWindowCloseBehaviorParams {
    behavior: WindowCloseBehavior,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetWindowSurfaceParams {
    surface: WindowSurfacePreference,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetSystemProxyTakeoverPolicyParams {
    policy: SystemProxyTakeoverPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetProcessDiscoveryModeParams {
    mode: ProcessDiscoveryMode,
}

struct SocketSubscriptions {
    event_ids: HashSet<String>,
    event_updates: broadcast::Receiver<()>,
    notification_ids: HashSet<String>,
    notification_updates: broadcast::Receiver<mish_runtime::NotificationSnapshot>,
    profile_ids: HashSet<String>,
    profile_updates: broadcast::Receiver<crate::ProfileActivationSnapshot>,
    settings_ids: HashSet<String>,
    settings_updates: broadcast::Receiver<mish_settings::SettingsSnapshot>,
    capture_updates: broadcast::Receiver<mish_runtime::CaptureRuntimeStatus>,
    status_ids: HashSet<String>,
    status_updates: broadcast::Receiver<CoreStatus>,
    traffic_ids: HashSet<String>,
    traffic_updates: broadcast::Receiver<CoreStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectGroupChildParams {
    group_id: String,
    child_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseConnectionParams {
    authority: TrafficCommandAuthority,
    connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartGroupDelayTestParams {
    group_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseAllActiveParams {
    authority: TrafficCommandAuthority,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseFilteredVisibleParams {
    authority: TrafficCommandAuthority,
    connection_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetProcessIconParams {
    connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelGroupDelayTestParams {
    test_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelDiagnosticRunParams {
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotificationIdsParams {
    ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotificationIdParams {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotificationDedupeKeyParams {
    dedupe_key: String,
}

pub(crate) async fn serve_socket(socket: WebSocket, state: ProtocolState) {
    let (mut sender, mut receiver) = socket.split();
    let mut runtime_changes = state.runtime.subscribe_changes();
    let initial_runtime = runtime_changes.borrow_and_update().clone();
    let status_updates = initial_runtime.subscribe_status();
    let traffic_updates = initial_runtime.subscribe_status();
    let event_updates = initial_runtime.subscribe_events();
    let (notification_updates, _) = initial_runtime.subscribe_notifications_with_snapshot();
    let (inactive_profile_updates, inactive_profile_receiver) = broadcast::channel(1);
    let _inactive_profile_updates = inactive_profile_updates;
    let profile_updates = state
        .profile_activation
        .as_ref()
        .map(|activation| activation.subscribe())
        .unwrap_or(inactive_profile_receiver);
    let (inactive_service_updates, inactive_service_receiver) = broadcast::channel(1);
    let _inactive_service_updates = inactive_service_updates;
    let mut service_updates = state
        .service_probes
        .as_ref()
        .map(crate::service_probes::ServiceProbeService::subscribe)
        .unwrap_or(inactive_service_receiver);
    let (inactive_capture_updates, inactive_capture_receiver) = broadcast::channel(1);
    let _inactive_capture_updates = inactive_capture_updates;
    let capture_updates = initial_runtime
        .subscribe_capture()
        .unwrap_or(inactive_capture_receiver);
    let (inactive_settings_updates, inactive_settings_receiver) = broadcast::channel(1);
    let _inactive_settings_updates = inactive_settings_updates;
    let settings_updates = state
        .settings_service
        .as_ref()
        .map(|service| service.subscribe())
        .unwrap_or(inactive_settings_receiver);
    let mut authenticated = false;
    let (command_responses, mut command_response_updates) = mpsc::unbounded_channel();
    let mut subscriptions = SocketSubscriptions {
        event_ids: HashSet::new(),
        event_updates,
        notification_ids: HashSet::new(),
        notification_updates,
        profile_ids: HashSet::new(),
        profile_updates,
        settings_ids: HashSet::new(),
        settings_updates,
        capture_updates,
        status_ids: HashSet::new(),
        status_updates,
        traffic_ids: HashSet::new(),
        traffic_updates,
    };

    loop {
        tokio::select! {
            biased;
            _ = state.socket_shutdown.cancelled() => {
                let _ = sender.send(Message::Close(None)).await;
                break;
            }
            changed = runtime_changes.changed() => {
                if changed.is_err() { break; }
                let runtime = runtime_changes.borrow_and_update().clone();
                subscriptions.status_updates = runtime.subscribe_status();
                if let Some(capture_updates) = runtime.subscribe_capture() {
                    subscriptions.capture_updates = capture_updates;
                }
                subscriptions.traffic_updates = runtime.subscribe_status();
                subscriptions.event_updates = runtime.subscribe_events();
                if authenticated && !subscriptions.status_ids.is_empty() {
                    let snapshot = state.status_snapshot().await;
                    for subscription_id in &subscriptions.status_ids {
                        let notification = json!({
                            "jsonrpc": "2.0",
                            "method": "status.snapshot",
                            "params": { "snapshot": snapshot, "subscriptionId": subscription_id },
                        });
                        if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                }
                if authenticated && !subscriptions.traffic_ids.is_empty() {
                    let snapshot = state.runtime.traffic_snapshot(StatusAdapterKind::Rpc);
                    for subscription_id in &subscriptions.traffic_ids {
                        let notification = json!({
                            "jsonrpc": "2.0",
                            "method": "traffic.snapshot",
                            "params": { "snapshot": snapshot, "subscriptionId": subscription_id },
                        });
                        if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                }
                if authenticated && !subscriptions.event_ids.is_empty() {
                    let snapshot = state.runtime.events_snapshot(StatusAdapterKind::Rpc);
                    for subscription_id in &subscriptions.event_ids {
                        let notification = json!({
                            "jsonrpc": "2.0",
                            "method": "events.snapshot",
                            "params": { "snapshot": snapshot, "subscriptionId": subscription_id },
                        });
                        if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                if authenticated && aggregate_capture_request(&text) {
                    let state = state.clone();
                    let responses = command_responses.clone();
                    tokio::spawn(async move {
                        let _ = responses.send(handle_aggregate_capture_request(&text, &state).await);
                    });
                    continue;
                }
                let response = handle_message(
                    &text,
                    &state,
                    &mut authenticated,
                    &mut subscriptions,
                ).await;
                if let Some(response) = response
                    && sender.send(Message::Text(response.to_string().into())).await.is_err()
                {
                    break;
                }
            }
            response = command_response_updates.recv() => {
                let Some(response) = response else { break };
                if let Some(response) = response
                    && sender.send(Message::Text(response.to_string().into())).await.is_err()
                {
                    break;
                }
            }
            update = subscriptions.status_updates.recv(), if authenticated && !subscriptions.status_ids.is_empty() => {
                let Ok(_) = update else { continue };
                let status_snapshot = state.status_snapshot().await;
                for subscription_id in &subscriptions.status_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "status.snapshot",
                        "params": { "snapshot": status_snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            update = subscriptions.capture_updates.recv(), if authenticated && !subscriptions.status_ids.is_empty() => {
                let capture_status = match update {
                    Ok(capture_status) => capture_status,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => continue,
                };
                let status_snapshot = state.status_snapshot_with_capture(capture_status).await;
                for subscription_id in &subscriptions.status_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "status.snapshot",
                        "params": { "snapshot": status_snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            update = service_updates.recv(), if authenticated && !subscriptions.status_ids.is_empty() => {
                match update {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => continue,
                }
                let snapshot = state.status_snapshot().await;
                for subscription_id in &subscriptions.status_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "status.snapshot",
                        "params": { "snapshot": snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            update = subscriptions.traffic_updates.recv(), if authenticated && !subscriptions.traffic_ids.is_empty() => {
                let Ok(_) = update else { continue };
                let traffic_snapshot = state.runtime.traffic_snapshot(StatusAdapterKind::Rpc);
                for subscription_id in &subscriptions.traffic_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "traffic.snapshot",
                        "params": { "snapshot": traffic_snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            update = subscriptions.event_updates.recv(), if authenticated && !subscriptions.event_ids.is_empty() => {
                match update {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => continue,
                }
                let events_snapshot = state.runtime.events_snapshot(StatusAdapterKind::Rpc);
                for subscription_id in &subscriptions.event_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "events.snapshot",
                        "params": { "snapshot": events_snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            update = subscriptions.notification_updates.recv(), if authenticated && !subscriptions.notification_ids.is_empty() => {
                let notification_snapshot = match update {
                    Ok(snapshot) => snapshot,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => state.runtime.notification_snapshot(),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => continue,
                };
                for subscription_id in &subscriptions.notification_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "notifications.snapshot",
                        "params": { "snapshot": notification_snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            update = subscriptions.profile_updates.recv(), if authenticated && !subscriptions.profile_ids.is_empty() => {
                let Ok(_) = update else { continue };
                let Ok(profile_snapshot) = profile_rpc_snapshot(&state).await else { continue };
                for subscription_id in &subscriptions.profile_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "profiles.snapshot",
                        "params": { "snapshot": profile_snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            update = subscriptions.settings_updates.recv(), if authenticated && !subscriptions.settings_ids.is_empty() => {
                let Ok(snapshot) = update else { continue };
                for subscription_id in &subscriptions.settings_ids {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "settings.snapshot",
                        "params": { "snapshot": snapshot, "subscriptionId": subscription_id },
                    });
                    if sender.send(Message::Text(notification.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

fn aggregate_capture_request(text: &str) -> bool {
    serde_json::from_str::<Request>(text).is_ok_and(|request| request.method == "status.setCapture")
}

async fn handle_aggregate_capture_request(text: &str, state: &ProtocolState) -> Option<Value> {
    let request: Request = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(_) => return Some(error_response(Value::Null, -32700, "Parse error", None)),
    };
    let id = request.id.unwrap_or(Value::Null);
    let params: SetCaptureParams = match serde_json::from_value(request.params) {
        Ok(params) => params,
        Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
    };
    match set_aggregate_capture(state, params).await {
        Ok(_) => Some(json!({"jsonrpc": "2.0", "id": id, "result": state.status_snapshot().await})),
        Err(error) => Some(capture_error_response(id, error)),
    }
}

async fn handle_message(
    text: &str,
    state: &ProtocolState,
    authenticated: &mut bool,
    subscriptions: &mut SocketSubscriptions,
) -> Option<Value> {
    let request: Request = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(error) => {
            return Some(error_response(
                Value::Null,
                -32700,
                "Parse error",
                Some(json!({"detail": error.to_string()})),
            ));
        }
    };
    let id = request.id.clone().unwrap_or(Value::Null);
    if request.id.is_none() && request.method == "rpc.cancel" && *authenticated {
        return None;
    }
    if request.jsonrpc != "2.0" || request.id.is_none() {
        return Some(error_response(id, -32600, "Invalid Request", None));
    }
    if !*authenticated && request.method != "rpc.authenticate" {
        return Some(error_response(id, -32001, "Authentication required", None));
    }
    if matches!(
        request.method.as_str(),
        "bridge.getInfo"
            | "core.getStatus"
            | "core.start"
            | "core.stop"
            | "status.getSnapshot"
            | "status.subscribe"
            | "status.testLocalProxy"
            | "profiles.getSnapshot"
            | "profiles.openDirectory"
            | "profiles.subscribe"
            | "traffic.getSnapshot"
            | "traffic.subscribe"
            | "events.getSnapshot"
            | "events.subscribe"
            | "diagnostics.getHistory"
            | "diagnostics.startRun"
            | "settings.getSnapshot"
            | "settings.refreshNetworkDns"
            | "settings.installTunHelper"
            | "settings.repairTunHelper"
            | "settings.removeTunHelper"
    ) && !request
        .params
        .as_object()
        .is_some_and(|params| params.is_empty())
    {
        return Some(error_response(id, -32602, "Invalid params", None));
    }

    let result = match request.method.as_str() {
        "rpc.authenticate" => {
            *authenticated = false;
            let auth: Authentication = match serde_json::from_value(request.params) {
                Ok(value) => value,
                Err(error) => {
                    return Some(error_response(
                        id,
                        -32602,
                        "Invalid params",
                        Some(json!({"detail": error.to_string()})),
                    ));
                }
            };
            if auth.client_name.trim().is_empty()
                || auth.client_version.trim().is_empty()
                || !constant_time_equal(&auth.token, &state.auth_token)
            {
                return Some(error_response(id, -32002, "Authentication failed", None));
            }
            *authenticated = true;
            json!({
                "authenticated": true,
                "sessionId": format!("session-{}", NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)),
            })
        }
        "bridge.getInfo" => json!({
            "bridgeVersion": env!("CARGO_PKG_VERSION"),
            "coreConfigured": state.runtime.core_configured(),
            "protocolVersion": 25,
            "statusCommands": {
                "group": state.runtime.supports_status_command(StatusCommand::Group),
                "groupDelay": state.runtime.supports_status_command(StatusCommand::GroupDelay),
                "routing": state.runtime.supports_status_command(StatusCommand::Routing),
                "services": state.service_probes.is_some(),
            },
            "trafficCommands": {
                "closeAllActive": state.runtime.supports_traffic_command(TrafficCommandOperation::CloseAllActive),
                "closeConnection": state.runtime.supports_traffic_command(TrafficCommandOperation::CloseConnection),
                "closeFilteredVisible": state.runtime.supports_traffic_command(TrafficCommandOperation::CloseFilteredVisible),
            },
        }),
        "core.getStatus" => {
            serde_json::to_value(state.runtime.core_status().await).expect("serializable status")
        }
        "core.start" => match state.runtime.start_core().await {
            Ok(status) => serde_json::to_value(status).expect("serializable status"),
            Err(error) => return Some(core_error_response(id, error)),
        },
        "core.stop" => match state.runtime.stop_core().await {
            Ok(status) => serde_json::to_value(status).expect("serializable status"),
            Err(error) => return Some(core_error_response(id, error)),
        },
        "status.getSnapshot" => state.status_snapshot().await,
        "status.setRoutingMode" => {
            let params: SetRoutingModeParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match state
                .runtime
                .set_routing_mode(params.mode, StatusAdapterKind::Rpc)
                .await
            {
                Ok(_) => state.status_snapshot().await,
                Err(error) => return Some(status_command_error_response(id, error)),
            }
        }
        "status.selectGroupChild" => {
            let params: SelectGroupChildParams =
                match serde_json::from_value::<SelectGroupChildParams>(request.params) {
                    Ok(params)
                        if valid_identifier(&params.group_id)
                            && valid_identifier(&params.child_id) =>
                    {
                        params
                    }
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            match state
                .runtime
                .select_group_child(params.group_id, params.child_id, StatusAdapterKind::Rpc)
                .await
            {
                Ok(_) => state.status_snapshot().await,
                Err(error) => return Some(status_command_error_response(id, error)),
            }
        }
        "status.startGroupDelayTest" => {
            let params: StartGroupDelayTestParams =
                match serde_json::from_value::<StartGroupDelayTestParams>(request.params) {
                    Ok(params) if valid_identifier(&params.group_id) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            match state
                .runtime
                .start_group_delay_test(params.group_id, StatusAdapterKind::Rpc)
                .await
            {
                Ok(_) => state.status_snapshot().await,
                Err(error) => return Some(status_command_error_response(id, error)),
            }
        }
        "status.cancelGroupDelayTest" => {
            let params: CancelGroupDelayTestParams =
                match serde_json::from_value::<CancelGroupDelayTestParams>(request.params) {
                    Ok(params) if valid_identifier(&params.test_id) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            match state
                .runtime
                .cancel_group_delay_test(params.test_id, StatusAdapterKind::Rpc)
                .await
            {
                Ok(_) => state.status_snapshot().await,
                Err(error) => return Some(status_command_error_response(id, error)),
            }
        }
        "status.upsertServiceMonitor" => {
            let params = match serde_json::from_value::<UpsertServiceMonitorParams>(request.params)
            {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            let Some(service_probes) = &state.service_probes else {
                return Some(error_response(
                    id,
                    -32601,
                    "Service probes are unavailable",
                    None,
                ));
            };
            if let Err(error) = service_probes.upsert(params.draft).await {
                return Some(error_response(id, -32602, error.message(), None));
            }
            state.status_snapshot().await
        }
        "status.removeServiceMonitor" => {
            let params = match serde_json::from_value::<RemoveServiceMonitorParams>(request.params)
            {
                Ok(params) if valid_identifier(&params.monitor_id) => params,
                _ => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            let Some(service_probes) = &state.service_probes else {
                return Some(error_response(
                    id,
                    -32601,
                    "Service probes are unavailable",
                    None,
                ));
            };
            if let Err(error) = service_probes.remove(&params.monitor_id) {
                return Some(error_response(id, -32602, error.message(), None));
            }
            state.status_snapshot().await
        }
        "status.testServiceMonitor" => {
            let params = match serde_json::from_value::<TestServiceMonitorParams>(request.params) {
                Ok(params) if valid_identifier(&params.monitor_id) => params,
                _ => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            let Some(service_probes) = &state.service_probes else {
                return Some(error_response(
                    id,
                    -32601,
                    "Service probes are unavailable",
                    None,
                ));
            };
            if let Err(error) = service_probes.test(&params.monitor_id).await {
                let code = match error {
                    crate::service_probes::ServiceProbeError::NotFound => -32004,
                    _ => -32000,
                };
                return Some(error_response(id, code, error.message(), None));
            }
            state.status_snapshot().await
        }
        "status.restoreDefaultServices" => {
            let Some(service_probes) = &state.service_probes else {
                return Some(error_response(
                    id,
                    -32601,
                    "Service probes are unavailable",
                    None,
                ));
            };
            if let Err(error) = service_probes.restore_defaults() {
                return Some(error_response(id, -32000, error.message(), None));
            }
            state.status_snapshot().await
        }
        "status.setServiceProbeInterval" => {
            let params =
                match serde_json::from_value::<SetServiceProbeIntervalParams>(request.params) {
                    Ok(params) => params,
                    Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            let Some(service_probes) = &state.service_probes else {
                return Some(error_response(
                    id,
                    -32601,
                    "Service probes are unavailable",
                    None,
                ));
            };
            if let Err(error) = service_probes.set_interval(params.interval_seconds) {
                return Some(error_response(id, -32602, error.message(), None));
            }
            state.status_snapshot().await
        }
        "status.subscribe" => {
            if subscription_count(subscriptions) >= 16 {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            subscriptions.status_updates = state.runtime.current().subscribe_status();
            if let Some(capture_updates) = state.runtime.current().subscribe_capture() {
                subscriptions.capture_updates = capture_updates;
            }
            let subscription_id = format!(
                "status-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions.status_ids.insert(subscription_id.clone());
            let snapshot = state.status_snapshot().await;
            json!({"snapshot": snapshot, "subscriptionId": subscription_id})
        }
        "status.unsubscribe" => {
            let Some(subscription_id) =
                request.params.get("subscriptionId").and_then(Value::as_str)
            else {
                return Some(error_response(id, -32602, "Invalid params", None));
            };
            json!(subscriptions.status_ids.remove(subscription_id))
        }
        "traffic.getSnapshot" => state.runtime.traffic_snapshot(StatusAdapterKind::Rpc),
        "traffic.getProcessIcon" => {
            let params: GetProcessIconParams =
                match serde_json::from_value::<GetProcessIconParams>(request.params) {
                    Ok(params) if valid_identifier(&params.connection_id) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            let snapshot = state.runtime.traffic_snapshot_typed(StatusAdapterKind::Rpc);
            let process_path = snapshot
                .active_connections
                .iter()
                .find(|connection| connection.id == params.connection_id)
                .and_then(|connection| connection.process_path.as_deref());
            let icon = process_path
                .zip(state.process_icon_resolver.as_deref())
                .and_then(|(path, resolver)| resolver.resolve(std::path::Path::new(path)))
                .filter(|icon| {
                    icon.bytes.len() <= PROCESS_ICON_MAX_BYTES
                        && icon.bytes.starts_with(PNG_SIGNATURE)
                });
            json!({
                "dataUrl": icon.map(|icon| {
                    format!("data:image/png;base64,{}", STANDARD.encode(icon.bytes))
                })
            })
        }
        "traffic.closeConnection" => {
            let params: CloseConnectionParams =
                match serde_json::from_value::<CloseConnectionParams>(request.params) {
                    Ok(params)
                        if valid_identifier(&params.connection_id)
                            && valid_traffic_authority(&params.authority) =>
                    {
                        params
                    }
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            state
                .runtime
                .close_connection(
                    params.authority,
                    params.connection_id,
                    StatusAdapterKind::Rpc,
                )
                .await
        }
        "traffic.closeAllActive" => {
            let params: CloseAllActiveParams =
                match serde_json::from_value::<CloseAllActiveParams>(request.params) {
                    Ok(params) if valid_traffic_authority(&params.authority) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            state
                .runtime
                .close_all_active(params.authority, StatusAdapterKind::Rpc)
                .await
        }
        "traffic.closeFilteredVisible" => {
            let params: CloseFilteredVisibleParams =
                match serde_json::from_value::<CloseFilteredVisibleParams>(request.params) {
                    Ok(params)
                        if valid_traffic_authority(&params.authority)
                            && valid_connection_ids(&params.connection_ids) =>
                    {
                        params
                    }
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            state
                .runtime
                .close_filtered_visible(
                    params.authority,
                    params.connection_ids,
                    StatusAdapterKind::Rpc,
                )
                .await
        }
        "traffic.subscribe" => {
            if subscription_count(subscriptions) >= 16 {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            subscriptions.traffic_updates = state.runtime.current().subscribe_status();
            let subscription_id = format!(
                "traffic-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions.traffic_ids.insert(subscription_id.clone());
            let snapshot = state.runtime.traffic_snapshot(StatusAdapterKind::Rpc);
            json!({"snapshot": snapshot, "subscriptionId": subscription_id})
        }
        "traffic.unsubscribe" => {
            let Some(subscription_id) =
                request.params.get("subscriptionId").and_then(Value::as_str)
            else {
                return Some(error_response(id, -32602, "Invalid params", None));
            };
            json!(subscriptions.traffic_ids.remove(subscription_id))
        }
        "events.getSnapshot" => state.runtime.events_snapshot(StatusAdapterKind::Rpc),
        "events.subscribe" => {
            if subscription_count(subscriptions) >= 16 {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            subscriptions.event_updates = state.runtime.current().subscribe_events();
            let subscription_id = format!(
                "events-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions.event_ids.insert(subscription_id.clone());
            let snapshot = state.runtime.events_snapshot(StatusAdapterKind::Rpc);
            json!({"snapshot": snapshot, "subscriptionId": subscription_id})
        }
        "events.unsubscribe" => {
            let Some(subscription_id) =
                request.params.get("subscriptionId").and_then(Value::as_str)
            else {
                return Some(error_response(id, -32602, "Invalid params", None));
            };
            json!(subscriptions.event_ids.remove(subscription_id))
        }
        "notifications.getSnapshot" => serde_json::to_value(state.runtime.notification_snapshot())
            .expect("serializable notification snapshot"),
        "notifications.publish" => {
            let publication: NotificationPublication = match serde_json::from_value(request.params)
            {
                Ok(publication) => publication,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match state.runtime.publish_notification(publication) {
                Ok(snapshot) => {
                    serde_json::to_value(snapshot).expect("serializable notification snapshot")
                }
                Err(error) => {
                    return Some(error_response(
                        id,
                        -32602,
                        "Invalid notification payload",
                        Some(json!({ "kind": format!("{error:?}") })),
                    ));
                }
            }
        }
        "notifications.markRead" => {
            let params: NotificationIdsParams =
                match serde_json::from_value::<NotificationIdsParams>(request.params) {
                    Ok(params)
                        if params.ids.len() <= 128
                            && params
                                .ids
                                .iter()
                                .all(|id| valid_notification_reference(id, true)) =>
                    {
                        params
                    }
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            serde_json::to_value(state.runtime.mark_notifications_read(&params.ids))
                .expect("serializable notification snapshot")
        }
        "notifications.remove" => {
            let params: NotificationIdParams =
                match serde_json::from_value::<NotificationIdParams>(request.params) {
                    Ok(params) if valid_notification_reference(&params.id, true) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            serde_json::to_value(state.runtime.remove_notification(&params.id))
                .expect("serializable notification snapshot")
        }
        "notifications.removeByDedupeKey" => {
            let params: NotificationDedupeKeyParams =
                match serde_json::from_value::<NotificationDedupeKeyParams>(request.params) {
                    Ok(params) if valid_notification_reference(&params.dedupe_key, true) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            serde_json::to_value(
                state
                    .runtime
                    .remove_notification_by_dedupe_key(&params.dedupe_key),
            )
            .expect("serializable notification snapshot")
        }
        "notifications.subscribe" => {
            if subscription_count(subscriptions) >= 16 {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            let (updates, snapshot) = state.runtime.subscribe_notifications_with_snapshot();
            subscriptions.notification_updates = updates;
            let subscription_id = format!(
                "notifications-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions
                .notification_ids
                .insert(subscription_id.clone());
            json!({"snapshot": snapshot, "subscriptionId": subscription_id})
        }
        "notifications.unsubscribe" => {
            let Some(subscription_id) =
                request.params.get("subscriptionId").and_then(Value::as_str)
            else {
                return Some(error_response(id, -32602, "Invalid params", None));
            };
            json!(subscriptions.notification_ids.remove(subscription_id))
        }
        "diagnostics.getHistory" => {
            serde_json::to_value(state.runtime.diagnostic_history(StatusAdapterKind::Rpc))
                .expect("serializable diagnostic history")
        }
        "diagnostics.startRun" => {
            serde_json::to_value(state.runtime.start_diagnostic_run(StatusAdapterKind::Rpc))
                .expect("serializable diagnostic history")
        }
        "diagnostics.cancelRun" => {
            let params: CancelDiagnosticRunParams =
                match serde_json::from_value::<CancelDiagnosticRunParams>(request.params) {
                    Ok(params) if valid_identifier(&params.run_id) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            serde_json::to_value(
                state
                    .runtime
                    .cancel_diagnostic_run(&params.run_id, StatusAdapterKind::Rpc),
            )
            .expect("serializable diagnostic history")
        }
        "profiles.getSnapshot" => match profile_rpc_snapshot(state).await {
            Ok(snapshot) => snapshot,
            Err(error) => return Some(profile_error_response(id, error)),
        },
        "profiles.create" => {
            let Some(actions) = &state.profile_file_actions else {
                return Some(profile_file_action_error_response(
                    id,
                    crate::ProfileFileActionError::Unavailable,
                ));
            };
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfileCreateParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            if let Err(error) = actions.create_basic_profile(&params.file_name) {
                return Some(profile_file_action_error_response(id, error));
            }
            match service.reconcile_profile_directory().await {
                Ok(_) | Err(ProfileServiceError::Busy) => {}
                Err(error) => return Some(profile_error_response(id, error)),
            }
            publish_profile_update(state).await;
            match profile_rpc_snapshot(state).await {
                Ok(snapshot) => snapshot,
                Err(error) => return Some(profile_error_response(id, error)),
            }
        }
        "profiles.openDirectory" => {
            let Some(actions) = &state.profile_file_actions else {
                return Some(profile_file_action_error_response(
                    id,
                    crate::ProfileFileActionError::Unavailable,
                ));
            };
            match actions.open_profiles_directory() {
                Ok(()) => json!(true),
                Err(error) => return Some(profile_file_action_error_response(id, error)),
            }
        }
        "profiles.getPatches" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfilePatchAuthorityParams = match serde_json::from_value(request.params) {
                Ok(params) if valid_patch_authority(&params) => params,
                _ => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.patch_editor(
                &params.profile_id,
                &params.source_revision,
                &params.artifact_fingerprint,
            ) {
                Ok(editor) => serde_json::to_value(editor).expect("serializable patch editor"),
                Err(error) => return Some(profile_error_response(id, error)),
            }
        }
        "profiles.getRoutes" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfileIdParams =
                match serde_json::from_value::<ProfileIdParams>(request.params) {
                    Ok(params) if valid_identifier(&params.profile_id) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            let catalog = match &state.profile_activation {
                Some(activation) => activation.route_catalog(&params.profile_id),
                None => service.route_catalog(&params.profile_id),
            };
            match catalog {
                Ok(catalog) => serde_json::to_value(catalog).expect("serializable route catalog"),
                Err(error) => return Some(profile_error_response(id, error)),
            }
        }
        "profiles.replacePatches" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfileReplacePatchesParams =
                match serde_json::from_value::<ProfileReplacePatchesParams>(request.params) {
                    Ok(params)
                        if params.schema_version == mish_profile::PROFILE_PATCH_SCHEMA_VERSION
                            && params.patches.len() <= mish_profile::MAX_PROFILE_PATCHES
                            && valid_patch_authority(&params.authority) =>
                    {
                        params
                    }
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            let result = if let Some(activation) = &state.profile_activation {
                activation
                    .replace_patches(
                        &params.authority.profile_id,
                        &params.authority.source_revision,
                        &params.authority.artifact_fingerprint,
                        params.patches,
                    )
                    .await
                    .map_err(|error| profile_activation_error_response(id.clone(), error))
            } else {
                service
                    .replace_patches(
                        &params.authority.profile_id,
                        &params.authority.source_revision,
                        &params.authority.artifact_fingerprint,
                        params.patches,
                    )
                    .map_err(|error| profile_error_response(id.clone(), error))
            };
            match result {
                Ok(editor) => {
                    publish_profile_update(state).await;
                    serde_json::to_value(editor).expect("serializable patch editor")
                }
                Err(response) => return Some(response),
            }
        }
        "profiles.subscribe" => {
            if subscription_count(subscriptions) >= 16 {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            if let Some(activation) = &state.profile_activation {
                subscriptions.profile_updates = activation.subscribe();
            }
            let subscription_id = format!(
                "profiles-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions.profile_ids.insert(subscription_id.clone());
            let snapshot = match profile_rpc_snapshot(state).await {
                Ok(snapshot) => snapshot,
                Err(error) => return Some(profile_error_response(id, error)),
            };
            json!({"snapshot": snapshot, "subscriptionId": subscription_id})
        }
        "profiles.unsubscribe" => {
            let Some(subscription_id) =
                request.params.get("subscriptionId").and_then(Value::as_str)
            else {
                return Some(error_response(id, -32602, "Invalid params", None));
            };
            json!(subscriptions.profile_ids.remove(subscription_id))
        }
        "profiles.activate" => {
            let Some(activation) = &state.profile_activation else {
                return Some(profile_activation_capability_error(id));
            };
            let params: ProfileActivationParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match activation
                .activate(&params.command_id, &params.profile_id)
                .await
            {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable activation"),
                Err(error) => return Some(profile_activation_error_response(id, error)),
            }
        }
        "profiles.cancelActivation" => {
            let Some(activation) = &state.profile_activation else {
                return Some(profile_activation_capability_error(id));
            };
            let params: ProfileCommandParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match activation.cancel(&params.command_id).await {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable activation"),
                Err(error) => return Some(profile_activation_error_response(id, error)),
            }
        }
        "profiles.stop" => {
            let Some(activation) = &state.profile_activation else {
                return Some(profile_activation_capability_error(id));
            };
            let params: ProfileCommandParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match activation.stop(&params.command_id).await {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable activation"),
                Err(error) => return Some(profile_activation_error_response(id, error)),
            }
        }
        "profiles.preflightHttps" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfilePreflightHttpsParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.preflight_https(&params.url, params.label).await {
                Ok(preview) => serde_json::to_value(preview).expect("serializable preview"),
                Err(error) => return Some(profile_error_response(id, error)),
            }
        }
        "profiles.save" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfileSaveParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            let saved = if let Some(activation) = &state.profile_activation {
                activation
                    .save_profile(&params.preview_id)
                    .await
                    .map_err(|error| profile_activation_error_response(id.clone(), error))
            } else {
                service
                    .save_preview(&params.preview_id)
                    .await
                    .map_err(|error| profile_error_response(id.clone(), error))
            };
            match saved {
                Ok(_) => {
                    publish_profile_update(state).await;
                    match profile_rpc_snapshot(state).await {
                        Ok(snapshot) => snapshot,
                        Err(error) => return Some(profile_error_response(id, error)),
                    }
                }
                Err(response) => return Some(response),
            }
        }
        "profiles.refresh" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfileIdParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            let refreshed = if let Some(activation) = &state.profile_activation {
                activation
                    .refresh_profile(&params.profile_id, ProfileRefreshTrigger::Manual)
                    .await
                    .map_err(|error| profile_activation_error_response(id.clone(), error))
            } else {
                service
                    .refresh(&params.profile_id)
                    .await
                    .map_err(|error| profile_error_response(id.clone(), error))
            };
            match refreshed {
                Ok(_) => {
                    publish_profile_update(state).await;
                    match profile_rpc_snapshot(state).await {
                        Ok(snapshot) => snapshot,
                        Err(error) => return Some(profile_error_response(id, error)),
                    }
                }
                Err(response) => return Some(response),
            }
        }
        "profiles.detachSubscription" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfileIdParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.detach_subscription(&params.profile_id) {
                Ok(_) => {
                    publish_profile_update(state).await;
                    match profile_rpc_snapshot(state).await {
                        Ok(snapshot) => snapshot,
                        Err(error) => return Some(profile_error_response(id, error)),
                    }
                }
                Err(error) => return Some(profile_error_response(id, error)),
            }
        }
        "profiles.setRefreshPolicy" => {
            let Some(activation) = &state.profile_activation else {
                return Some(profile_activation_capability_error(id));
            };
            let params: ProfileRefreshPolicyParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match activation
                .set_refresh_policy(&params.profile_id, params.policy)
                .await
            {
                Ok(_) => match profile_rpc_snapshot(state).await {
                    Ok(snapshot) => snapshot,
                    Err(error) => return Some(profile_error_response(id, error)),
                },
                Err(error) => return Some(profile_activation_error_response(id, error)),
            }
        }
        "profiles.updateProvider" => {
            let Some(activation) = &state.profile_activation else {
                return Some(profile_activation_capability_error(id));
            };
            let params: UpdateProviderParams =
                match serde_json::from_value::<UpdateProviderParams>(request.params) {
                    Ok(params)
                        if valid_identifier(&params.provider_id)
                            && valid_provider_authority(&params.authority) =>
                    {
                        params
                    }
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            let result = state
                .runtime
                .update_provider(params.authority, params.provider_id)
                .await;
            activation.publish().await;
            serde_json::to_value(result).expect("serializable provider update")
        }
        "profiles.updateAllProviders" => {
            let Some(activation) = &state.profile_activation else {
                return Some(profile_activation_capability_error(id));
            };
            let params: UpdateAllProvidersParams =
                match serde_json::from_value::<UpdateAllProvidersParams>(request.params) {
                    Ok(params) if valid_provider_authority(&params.authority) => params,
                    _ => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            let result = state
                .runtime
                .update_all_providers(params.authority, params.kind)
                .await;
            activation.publish().await;
            serde_json::to_value(result).expect("serializable provider updates")
        }
        "profiles.delete" => {
            let Some(service) = &state.profile_service else {
                return Some(profile_capability_error(id));
            };
            let params: ProfileIdParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            if let Some(activation) = &state.profile_activation {
                if let Err(error) = activation.delete_profile(&params.profile_id).await {
                    return Some(profile_activation_error_response(id, error));
                }
            } else if let Err(error) = service.delete(&params.profile_id) {
                return Some(profile_error_response(id, error));
            }
            publish_profile_update(state).await;
            match profile_rpc_snapshot(state).await {
                Ok(snapshot) => snapshot,
                Err(error) => return Some(profile_error_response(id, error)),
            }
        }
        "status.setCapture" => {
            let params: SetCaptureParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match set_aggregate_capture(state, params).await {
                Ok(_) => state.status_snapshot().await,
                Err(error) => return Some(capture_error_response(id, error)),
            }
        }
        "status.recoverSystemProxy" => {
            let params: RecoverSystemProxyParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match state
                .runtime
                .recover_system_proxy(params.action, StatusAdapterKind::Rpc)
                .await
            {
                Ok(_) => state.status_snapshot().await,
                Err(error) => return Some(capture_error_response(id, error)),
            }
        }
        "status.testLocalProxy" => match state.runtime.test_local_proxy().await {
            Ok(result) => serde_json::to_value(result).expect("serializable local proxy test"),
            Err(error) => return Some(capture_error_response(id, error)),
        },
        "settings.getSnapshot" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            serde_json::to_value(service.snapshot(SettingsAdapterKind::Rpc))
                .expect("serializable settings snapshot")
        }
        "settings.refreshNetworkDns" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            serde_json::to_value(service.refresh_network_dns().await)
                .expect("serializable settings snapshot")
        }
        "settings.installTunHelper" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            match service.install_tun_helper().await {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.repairTunHelper" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            if let Err(error) = disable_tun_for_helper_lifecycle(state).await {
                return Some(capture_error_response(id, error));
            }
            match service.repair_tun_helper().await {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.removeTunHelper" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            if let Err(error) = disable_tun_for_helper_lifecycle(state).await {
                return Some(capture_error_response(id, error));
            }
            match service.remove_tun_helper().await {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setAppearance" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetAppearanceParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.set_appearance(params.appearance) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setLanguage" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetLanguageParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.set_language(params.language) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setOnboardingWelcomeState" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetOnboardingWelcomeStateParams =
                match serde_json::from_value(request.params) {
                    Ok(params) => params,
                    Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            match service.set_onboarding_welcome_state(params.action) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setStartup" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetStartupParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.set_startup(params.startup) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setLaunchProxyWhenMishLaunches" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetLaunchProxyWhenMishLaunchesParams =
                match serde_json::from_value(request.params) {
                    Ok(params) => params,
                    Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            match service
                .set_launch_proxy_when_mish_launches(params.launch_proxy_when_mish_launches)
            {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setManagedPorts" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetManagedPortsParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.set_managed_ports(params.managed_ports) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setSystemProxyTakeoverPolicy" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetSystemProxyTakeoverPolicyParams =
                match serde_json::from_value(request.params) {
                    Ok(params) => params,
                    Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
                };
            match service.set_system_proxy_takeover_policy(params.policy) {
                Ok(snapshot) => {
                    state
                        .runtime
                        .set_system_proxy_takeover_policy(params.policy);
                    serde_json::to_value(snapshot).expect("serializable settings")
                }
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setProcessDiscoveryMode" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetProcessDiscoveryModeParams = match serde_json::from_value(request.params)
            {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.set_process_discovery_mode(params.mode) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.findManagedPorts" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            match service.find_and_set_managed_ports() {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.subscribe" => {
            if subscription_count(subscriptions) >= 16 {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let (updates, snapshot) = service.subscribe_with_snapshot(SettingsAdapterKind::Rpc);
            subscriptions.settings_updates = updates;
            let subscription_id = format!(
                "settings-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions.settings_ids.insert(subscription_id.clone());
            json!({"snapshot": snapshot, "subscriptionId": subscription_id})
        }
        "settings.unsubscribe" => {
            let Some(subscription_id) =
                request.params.get("subscriptionId").and_then(Value::as_str)
            else {
                return Some(error_response(id, -32602, "Invalid params", None));
            };
            json!(subscriptions.settings_ids.remove(subscription_id))
        }
        "settings.setWindowCloseBehavior" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetWindowCloseBehaviorParams = match serde_json::from_value(request.params)
            {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.set_window_close_behavior(params.behavior) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "settings.setWindowSurface" => {
            let Some(service) = &state.settings_service else {
                return Some(settings_capability_error(id));
            };
            let params: SetWindowSurfaceParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(_) => return Some(error_response(id, -32602, "Invalid params", None)),
            };
            match service.set_window_surface(params.surface) {
                Ok(snapshot) => serde_json::to_value(snapshot).expect("serializable settings"),
                Err(error) => return Some(settings_error_response(state, id, error)),
            }
        }
        "rpc.cancel" => json!(false),
        method if method.starts_with("status.") => {
            return Some(error_response(
                id,
                -32020,
                "Capability is not implemented by the desktop bridge",
                None,
            ));
        }
        _ => return Some(error_response(id, -32601, "Method not found", None)),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

async fn disable_tun_for_helper_lifecycle(
    state: &ProtocolState,
) -> Result<(), CaptureTransitionError> {
    let snapshot = state
        .runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    if !snapshot.runtime.capture_selection.tun && !snapshot.runtime.tun_enabled {
        return Ok(());
    }
    let mut selection = snapshot.runtime.capture_selection;
    selection.tun = false;
    state
        .runtime
        .set_capture(
            CaptureRequest {
                active: snapshot.runtime.system_proxy_enabled,
                selection,
            },
            StatusAdapterKind::Rpc,
        )
        .await
        .map(|_| ())
}

async fn set_capture_with_core_reactivation(
    state: &ProtocolState,
    request: CaptureRequest,
) -> Result<Value, CaptureTransitionError> {
    if let Some(activation) = &state.profile_activation {
        activation
            .set_capture(request, StatusAdapterKind::Rpc)
            .await
    } else {
        state
            .runtime
            .set_capture(request, StatusAdapterKind::Rpc)
            .await
    }
}

/// Single transport-neutral boundary for aggregate proxy launch/stop.  Native menu callers can
/// reuse this through `ProfileActivationCoordinator::launch_proxy` without reproducing Web flow.
async fn set_aggregate_capture(
    state: &ProtocolState,
    params: SetCaptureParams,
) -> Result<Value, CaptureTransitionError> {
    if !params.active {
        return set_capture_with_core_reactivation(
            state,
            CaptureRequest {
                active: false,
                selection: params.selection,
            },
        )
        .await;
    }

    let selection = requested_capture_selection(state, params.selection).await?;
    if let Some(settings) = &state.settings_service {
        settings
            .set_capture_selection(selection.clone())
            .map_err(|_| {
                CaptureTransitionError::new(
                    CaptureFailureKind::RuntimeTransition,
                    "The selected Capture modes could not be remembered",
                )
            })?;
    }
    if let Some(activation) = &state.profile_activation {
        return activation
            .launch_proxy(
                &Uuid::new_v4().to_string(),
                params.profile_id.as_deref(),
                selection,
                StatusAdapterKind::Rpc,
            )
            .await;
    }
    state
        .runtime
        .set_capture(
            CaptureRequest {
                active: true,
                selection,
            },
            StatusAdapterKind::Rpc,
        )
        .await
}

async fn requested_capture_selection(
    state: &ProtocolState,
    selection: CaptureSelection,
) -> Result<CaptureSelection, CaptureTransitionError> {
    let snapshot = state
        .runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await;
    let system_proxy_available =
        capture_capability_available(snapshot.adapter_kind, snapshot.capabilities.system_proxy);
    let tun_available =
        capture_capability_available(snapshot.adapter_kind, snapshot.capabilities.tun);
    if (selection.system_proxy && !system_proxy_available) || (selection.tun && !tun_available) {
        Err(CaptureTransitionError::new(
            CaptureFailureKind::CapabilityUnavailable,
            "The requested Capture mode is unavailable on this system",
        ))
    } else if selection.system_proxy || selection.tun {
        Ok(selection)
    } else {
        Err(CaptureTransitionError::new(
            CaptureFailureKind::UnsupportedSelection,
            "No available Capture mode can be launched on this system",
        ))
    }
}

fn capture_capability_available(
    adapter_kind: StatusAdapterKind,
    availability: CapabilityAvailability,
) -> bool {
    matches!(
        (adapter_kind, availability),
        (
            StatusAdapterKind::Native,
            CapabilityAvailability::FixtureOnly
        ) | (_, CapabilityAvailability::Supported)
    )
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.as_bytes().ct_eq(right.as_bytes()).into()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8_192
}

fn valid_notification_reference(value: &str, allow_colon: bool) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'-' | b'_')
                || (allow_colon && byte == b':')
        })
}

fn valid_traffic_authority(authority: &TrafficCommandAuthority) -> bool {
    valid_identifier(&authority.profile_id) && valid_identifier(&authority.session_id)
}

fn valid_connection_ids(connection_ids: &[String]) -> bool {
    !connection_ids.is_empty()
        && connection_ids.len() <= 20_000
        && connection_ids.iter().all(|id| valid_identifier(id))
        && connection_ids.iter().collect::<HashSet<_>>().len() == connection_ids.len()
}

fn valid_provider_authority(authority: &ProviderAuthority) -> bool {
    valid_identifier(&authority.profile_id)
        && authority.runtime_fingerprint.len() == 64
        && authority
            .runtime_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn error_response(id: Value, code: i32, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({"code": code, "message": message});
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({"jsonrpc": "2.0", "id": id, "error": error})
}

fn core_error_response(id: Value, error: CoreError) -> Value {
    let (code, message) = match error.kind {
        CoreErrorKind::Unavailable => (-32010, "Mihomo is not available"),
        CoreErrorKind::StartFailed => (-32011, "Mihomo could not be started"),
        CoreErrorKind::StopFailed => (-32011, "Mihomo could not be stopped"),
    };
    error_response(
        id,
        code,
        message,
        Some(json!({"detail": error.to_string(), "kind": error.kind})),
    )
}

fn status_command_error_response(id: Value, error: StatusCommandError) -> Value {
    let code = match error.kind {
        StatusCommandErrorKind::Unsupported => -32020,
        StatusCommandErrorKind::InvalidRequest | StatusCommandErrorKind::UnsupportedGroup => -32602,
        StatusCommandErrorKind::NotFound => -32004,
        StatusCommandErrorKind::Conflict | StatusCommandErrorKind::StaleMembership => -32009,
        StatusCommandErrorKind::Timeout => -32050,
        StatusCommandErrorKind::Disconnected => -32051,
        StatusCommandErrorKind::Cancelled => -32800,
        StatusCommandErrorKind::Rejected => -32055,
        StatusCommandErrorKind::RuntimeReplaced => -32054,
        StatusCommandErrorKind::VersionDrift => -32052,
        StatusCommandErrorKind::InconsistentObservation => -32053,
    };
    error_response(
        id,
        code,
        error.to_string().as_str(),
        Some(json!({"kind": error.kind})),
    )
}

fn profile_capability_error(id: Value) -> Value {
    error_response(
        id,
        -32020,
        "Profile storage is not available in this bridge composition",
        None,
    )
}

fn settings_capability_error(id: Value) -> Value {
    error_response(id, -32020, "Application settings are unavailable", None)
}

fn settings_error_response(state: &ProtocolState, id: Value, error: SettingsServiceError) -> Value {
    let failure = match &error {
        SettingsServiceError::CapabilityUnavailable => "capability-unavailable",
        SettingsServiceError::Persistence => "persistence",
        SettingsServiceError::Startup => "startup",
        SettingsServiceError::TunHelper(_) => "tun-helper",
        SettingsServiceError::WindowSurface => "window-surface",
        SettingsServiceError::Busy => "busy",
    };
    state
        .runtime
        .record_application_event(ApplicationDiagnosticEvent::settings_failure(failure));
    let _ = state.runtime.publish_notification(NotificationPublication {
        dedupe_key: format!("settings.operation-failed:{}", Uuid::new_v4()),
        pinned: false,
        presentation: ApplicationNotification::new(
            ApplicationNotificationContent::SettingsOperationFailed(
                SettingsOperationFailedApplicationNotificationData {
                    failure: failure.into(),
                },
            ),
            Vec::new(),
        ),
        replaces: Vec::new(),
        resolved: false,
        severity: NotificationSeverity::Error,
    });
    match error {
        SettingsServiceError::CapabilityUnavailable => settings_capability_error(id),
        SettingsServiceError::Persistence => error_response(
            id,
            -32041,
            "Application settings could not be persisted",
            None,
        ),
        SettingsServiceError::Startup => error_response(
            id,
            -32054,
            "Startup registration could not be confirmed",
            None,
        ),
        SettingsServiceError::TunHelper(kind) => error_response(
            id,
            -32055,
            "TUN helper lifecycle operation could not be confirmed",
            Some(json!({ "kind": kind })),
        ),
        SettingsServiceError::WindowSurface => error_response(
            id,
            -32056,
            "Native window surface could not be applied",
            None,
        ),
        SettingsServiceError::Busy => error_response(
            id,
            -32009,
            "Another Profile or Settings mutation is in progress",
            Some(json!({ "kind": "busy" })),
        ),
    }
}

fn profile_activation_capability_error(id: Value) -> Value {
    error_response(id, -32020, "Profile activation is unavailable", None)
}

async fn profile_rpc_snapshot(state: &ProtocolState) -> Result<Value, ProfileServiceError> {
    let Some(service) = &state.profile_service else {
        return Err(ProfileServiceError::Repository(RepositoryError::NotFound));
    };
    let snapshot = if let Some(activation) = &state.profile_activation {
        activation.managed_profile_snapshot().await?
    } else {
        crate::ManagedProfileSnapshot::unavailable(service.snapshot()?)
    };
    Ok(serde_json::to_value(snapshot).expect("serializable managed profile snapshot"))
}

async fn publish_profile_update(state: &ProtocolState) {
    if let Some(activation) = &state.profile_activation {
        activation.publish().await;
    }
}

fn subscription_count(subscriptions: &SocketSubscriptions) -> usize {
    subscriptions.event_ids.len()
        + subscriptions.notification_ids.len()
        + subscriptions.profile_ids.len()
        + subscriptions.settings_ids.len()
        + subscriptions.status_ids.len()
        + subscriptions.traffic_ids.len()
}

fn profile_activation_error_response(
    id: Value,
    error: crate::ProfileActivationCoordinatorError,
) -> Value {
    use crate::ProfileActivationCoordinatorError;
    match error {
        ProfileActivationCoordinatorError::InvalidCommand => {
            error_response(id, -32602, "Invalid params", None)
        }
        ProfileActivationCoordinatorError::Conflict => {
            error_response(id, -32009, "Profile activation state conflict", None)
        }
        ProfileActivationCoordinatorError::Busy => error_response(
            id,
            -32009,
            "Another Profile or Settings mutation is in progress",
            Some(json!({ "kind": "busy" })),
        ),
        ProfileActivationCoordinatorError::Unavailable
        | ProfileActivationCoordinatorError::PolicyUnavailable => {
            profile_activation_capability_error(id)
        }
        ProfileActivationCoordinatorError::Profile(error) => profile_error_response(id, error),
        ProfileActivationCoordinatorError::ShutdownFailed => error_response(
            id,
            -32042,
            "Managed profile could not reach a safe stopped state",
            None,
        ),
    }
}

fn profile_error_response(id: Value, error: ProfileServiceError) -> Value {
    match error {
        ProfileServiceError::PreviewNotFound => {
            error_response(id, -32004, "Profile preflight was not found", None)
        }
        ProfileServiceError::Repository(RepositoryError::NotFound) => {
            error_response(id, -32004, "Profile was not found", None)
        }
        ProfileServiceError::ActiveProfileDeletionDisabled => error_response(
            id,
            -32009,
            "Active profiles cannot be deleted until transactional activation is available",
            None,
        ),
        ProfileServiceError::SchedulingUnavailable => error_response(
            id,
            -32020,
            "Scheduled refresh is available only for HTTPS profile sources",
            None,
        ),
        ProfileServiceError::Busy => error_response(
            id,
            -32009,
            "Another Profile or Settings mutation is in progress",
            Some(json!({ "kind": "busy" })),
        ),
        ProfileServiceError::Patch(mish_profile::ProfilePatchError::StaleAuthority) => {
            error_response(id, -32009, "Profile patch revision is stale", None)
        }
        ProfileServiceError::Patch(_) => {
            error_response(id, -32040, "Profile patch validation failed", None)
        }
        ProfileServiceError::Import(ImportError::UnsafeDeviceIntegration { field_identity }) => {
            error_response(
                id,
                -32040,
                "Profile validation failed",
                Some(json!({
                    "fieldIdentity": field_identity,
                    "kind": "unsafe-device-integration"
                })),
            )
        }
        ProfileServiceError::Import(ImportError::UnsafeProviderPath { field_identity }) => {
            error_response(
                id,
                -32040,
                "Profile validation failed",
                Some(json!({
                    "fieldIdentity": field_identity,
                    "kind": "unsafe-provider-path"
                })),
            )
        }
        ProfileServiceError::Import(_) => {
            error_response(id, -32040, "Profile validation failed", None)
        }
        ProfileServiceError::Repository(_) => {
            error_response(id, -32041, "Profile storage operation failed", None)
        }
    }
}

fn profile_file_action_error_response(id: Value, error: crate::ProfileFileActionError) -> Value {
    match error {
        crate::ProfileFileActionError::AlreadyExists => error_response(
            id,
            -32009,
            "A profile with this file name already exists",
            Some(json!({ "kind": "already-exists" })),
        ),
        crate::ProfileFileActionError::InvalidFileName => {
            error_response(id, -32602, "Invalid params", None)
        }
        crate::ProfileFileActionError::Unavailable => {
            error_response(id, -32021, "Profile file action failed", None)
        }
    }
}

fn valid_patch_authority(authority: &ProfilePatchAuthorityParams) -> bool {
    valid_identifier(&authority.profile_id)
        && valid_sha256(&authority.source_revision)
        && valid_sha256(&authority.artifact_fingerprint)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn capture_error_response(id: Value, error: CaptureTransitionError) -> Value {
    error_response(
        id,
        -32050,
        "System Proxy reconciliation failed",
        Some(json!({"kind": error.kind})),
    )
}
