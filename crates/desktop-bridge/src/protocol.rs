use std::{
    collections::HashSet,
    sync::atomic::{AtomicU64, Ordering},
};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use mish_profile::{
    ImportError, ProfilePatch, ProfileRefreshPolicy, ProfileRefreshTrigger, ProfileServiceError,
    RepositoryError,
};
use mish_runtime::{
    CaptureRecoveryAction, CaptureRequest, CaptureSelection, CaptureTransitionError, CoreError,
    CoreErrorKind, CoreStatus, ProviderAuthority, ProviderKind, RoutingMode, StatusAdapterKind,
    StatusCommand, StatusCommandError, StatusCommandErrorKind, TrafficCommandAuthority,
    TrafficCommandOperation,
};
use mish_settings::{
    AppearancePreference, LanguagePreference, SettingsAdapterKind, SettingsService,
    SettingsServiceError, StartupPreferences, WindowCloseBehavior, WindowSurfacePreference,
};
use tokio::sync::broadcast;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_SUBSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);

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
    pub profile_service: Option<std::sync::Arc<crate::DesktopProfileService>>,
    pub runtime: crate::DesktopRuntimeHost,
    pub settings_service: Option<std::sync::Arc<SettingsService>>,
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
struct SetCaptureParams {
    active: bool,
    selection: CaptureSelection,
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
struct SetStartupParams {
    startup: StartupPreferences,
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

struct SocketSubscriptions {
    event_ids: HashSet<String>,
    event_updates: broadcast::Receiver<()>,
    profile_ids: HashSet<String>,
    profile_updates: broadcast::Receiver<crate::ProfileActivationSnapshot>,
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
struct CancelGroupDelayTestParams {
    test_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelDiagnosticRunParams {
    run_id: String,
}

pub(crate) async fn serve_socket(socket: WebSocket, state: ProtocolState) {
    let (mut sender, mut receiver) = socket.split();
    let mut runtime_changes = state.runtime.subscribe_changes();
    let initial_runtime = runtime_changes.borrow_and_update().clone();
    let status_updates = initial_runtime.subscribe_status();
    let traffic_updates = initial_runtime.subscribe_status();
    let event_updates = initial_runtime.subscribe_events();
    let (inactive_profile_updates, inactive_profile_receiver) = broadcast::channel(1);
    let _inactive_profile_updates = inactive_profile_updates;
    let profile_updates = state
        .profile_activation
        .as_ref()
        .map(|activation| activation.subscribe())
        .unwrap_or(inactive_profile_receiver);
    let mut authenticated = false;
    let mut subscriptions = SocketSubscriptions {
        event_ids: HashSet::new(),
        event_updates,
        profile_ids: HashSet::new(),
        profile_updates,
        status_ids: HashSet::new(),
        status_updates,
        traffic_ids: HashSet::new(),
        traffic_updates,
    };

    loop {
        tokio::select! {
            biased;
            changed = runtime_changes.changed() => {
                if changed.is_err() { break; }
                let runtime = runtime_changes.borrow_and_update().clone();
                subscriptions.status_updates = runtime.subscribe_status();
                subscriptions.traffic_updates = runtime.subscribe_status();
                subscriptions.event_updates = runtime.subscribe_events();
                if authenticated && !subscriptions.status_ids.is_empty() {
                    let snapshot = state.runtime.status_snapshot(StatusAdapterKind::Rpc).await;
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
            update = subscriptions.status_updates.recv(), if authenticated && !subscriptions.status_ids.is_empty() => {
                let Ok(_) = update else { continue };
                let status_snapshot = state.runtime.status_snapshot(StatusAdapterKind::Rpc).await;
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
        }
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
            | "profiles.getSnapshot"
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
            "protocolVersion": 13,
            "statusCommands": {
                "group": state.runtime.supports_status_command(StatusCommand::Group),
                "groupDelay": state.runtime.supports_status_command(StatusCommand::GroupDelay),
                "routing": state.runtime.supports_status_command(StatusCommand::Routing),
            },
            "trafficCommands": {
                "closeAllActive": state.runtime.supports_traffic_command(TrafficCommandOperation::CloseAllActive),
                "closeConnection": state.runtime.supports_traffic_command(TrafficCommandOperation::CloseConnection),
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
        "status.getSnapshot" => state.runtime.status_snapshot(StatusAdapterKind::Rpc).await,
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
                Ok(snapshot) => snapshot,
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
                Ok(snapshot) => snapshot,
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
                Ok(snapshot) => snapshot,
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
                Ok(snapshot) => snapshot,
                Err(error) => return Some(status_command_error_response(id, error)),
            }
        }
        "status.subscribe" => {
            if subscription_count(
                &subscriptions.event_ids,
                &subscriptions.profile_ids,
                &subscriptions.status_ids,
                &subscriptions.traffic_ids,
            ) >= 16
            {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            subscriptions.status_updates = state.runtime.current().subscribe_status();
            let subscription_id = format!(
                "status-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions.status_ids.insert(subscription_id.clone());
            let snapshot = state.runtime.status_snapshot(StatusAdapterKind::Rpc).await;
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
        "traffic.subscribe" => {
            if subscription_count(
                &subscriptions.event_ids,
                &subscriptions.profile_ids,
                &subscriptions.status_ids,
                &subscriptions.traffic_ids,
            ) >= 16
            {
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
            if subscription_count(
                &subscriptions.event_ids,
                &subscriptions.profile_ids,
                &subscriptions.status_ids,
                &subscriptions.traffic_ids,
            ) >= 16
            {
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
            if subscription_count(
                &subscriptions.event_ids,
                &subscriptions.profile_ids,
                &subscriptions.status_ids,
                &subscriptions.traffic_ids,
            ) >= 16
            {
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
            match service.save_preview(&params.preview_id).await {
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
            match state
                .runtime
                .set_capture(
                    CaptureRequest {
                        active: params.active,
                        selection: params.selection,
                    },
                    StatusAdapterKind::Rpc,
                )
                .await
            {
                Ok(snapshot) => snapshot,
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
                Ok(snapshot) => snapshot,
                Err(error) => return Some(capture_error_response(id, error)),
            }
        }
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
                Err(error) => return Some(settings_error_response(id, error)),
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
                Err(error) => return Some(settings_error_response(id, error)),
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
                Err(error) => return Some(settings_error_response(id, error)),
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
                Err(error) => return Some(settings_error_response(id, error)),
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
                Err(error) => return Some(settings_error_response(id, error)),
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
                Err(error) => return Some(settings_error_response(id, error)),
            }
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
                Err(error) => return Some(settings_error_response(id, error)),
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
                Err(error) => return Some(settings_error_response(id, error)),
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

fn constant_time_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.as_bytes().ct_eq(right.as_bytes()).into()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8_192
}

fn valid_traffic_authority(authority: &TrafficCommandAuthority) -> bool {
    valid_identifier(&authority.profile_id) && valid_identifier(&authority.session_id)
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

fn settings_error_response(id: Value, error: SettingsServiceError) -> Value {
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

fn subscription_count(
    events: &HashSet<String>,
    profiles: &HashSet<String>,
    status: &HashSet<String>,
    traffic: &HashSet<String>,
) -> usize {
    events.len() + profiles.len() + status.len() + traffic.len()
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
