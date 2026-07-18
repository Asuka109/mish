use std::{
    collections::HashSet,
    sync::atomic::{AtomicU64, Ordering},
};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use mish_runtime::{CoreError, CoreErrorKind, CoreStatus, MishRuntime, StatusAdapterKind};
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
    pub runtime: MishRuntime,
}

pub(crate) async fn serve_socket(socket: WebSocket, state: ProtocolState) {
    let (mut sender, mut receiver) = socket.split();
    let mut updates = state.runtime.subscribe_status();
    let mut authenticated = false;
    let mut subscriptions = HashSet::new();

    loop {
        tokio::select! {
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
                    &mut updates,
                ).await;
                if let Some(response) = response
                    && sender.send(Message::Text(response.to_string().into())).await.is_err()
                {
                    break;
                }
            }
            update = updates.recv(), if authenticated && !subscriptions.is_empty() => {
                let Ok(status) = update else { continue };
                let snapshot = state.runtime.snapshot_from_status(&status, StatusAdapterKind::Rpc);
                for subscription_id in &subscriptions {
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
        }
    }
}

async fn handle_message(
    text: &str,
    state: &ProtocolState,
    authenticated: &mut bool,
    subscriptions: &mut HashSet<String>,
    updates: &mut broadcast::Receiver<CoreStatus>,
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
            "protocolVersion": 2,
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
        "status.subscribe" => {
            if subscriptions.len() >= 16 {
                return Some(error_response(
                    id,
                    -32030,
                    "Subscription limit reached",
                    None,
                ));
            }
            *updates = state.runtime.subscribe_status();
            let subscription_id = format!(
                "status-{}",
                NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed)
            );
            subscriptions.insert(subscription_id.clone());
            let snapshot = state.runtime.status_snapshot(StatusAdapterKind::Rpc).await;
            json!({"snapshot": snapshot, "subscriptionId": subscription_id})
        }
        "status.unsubscribe" => {
            let Some(subscription_id) =
                request.params.get("subscriptionId").and_then(Value::as_str)
            else {
                return Some(error_response(id, -32602, "Invalid params", None));
            };
            json!(subscriptions.remove(subscription_id))
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

fn constant_time_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.as_bytes().ct_eq(right.as_bytes()).into()
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
