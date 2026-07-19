use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use axum::{
    Router,
    extract::{ConnectInfo, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use mish_runtime::{CaptureAuditReason, CorePhase, MishRuntime};
use serde_json::json;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

use crate::protocol::{ProtocolState, serve_socket};
use crate::{DesktopProfileService, DesktopRuntimeHost, ProfileActivationCoordinator};

#[derive(Clone)]
pub struct LoopbackServerConfig {
    pub allowed_origins: Vec<String>,
    pub auth_token: String,
    pub bind: SocketAddr,
    pub max_message_bytes: usize,
    pub profile_activation: Option<Arc<ProfileActivationCoordinator>>,
    pub profile_service: Option<Arc<DesktopProfileService>>,
}

struct HttpState {
    allowed_hosts: HashSet<String>,
    allowed_origins: HashSet<String>,
    protocol: ProtocolState,
    max_message_bytes: usize,
}

pub struct LoopbackServerHandle {
    pub address: SocketAddr,
    audit_join: JoinHandle<()>,
    audit_shutdown: Option<oneshot::Sender<()>>,
    join: JoinHandle<()>,
    profile_activation: Option<Arc<ProfileActivationCoordinator>>,
    shutdown: Option<oneshot::Sender<()>>,
    runtime: DesktopRuntimeHost,
}

impl LoopbackServerHandle {
    pub async fn shutdown(mut self) {
        if let Some(shutdown) = self.audit_shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.audit_join.await;
        if let Some(profile_activation) = &self.profile_activation {
            let _ = profile_activation.shutdown().await;
        }
        let _ = self.runtime.current().shutdown().await;
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.join.await;
    }
}

pub async fn start_loopback_server(
    config: LoopbackServerConfig,
    runtime: MishRuntime,
) -> Result<LoopbackServerHandle, String> {
    start_loopback_server_with_runtime_host(config, DesktopRuntimeHost::new(runtime)).await
}

pub async fn start_loopback_server_with_runtime_host(
    config: LoopbackServerConfig,
    runtime: DesktopRuntimeHost,
) -> Result<LoopbackServerHandle, String> {
    if !config.bind.ip().is_loopback() {
        return Err("The Mish desktop bridge may only bind to a loopback address".into());
    }
    if config.auth_token.len() < 16 {
        return Err("MISH_BRIDGE_TOKEN must contain at least 16 characters".into());
    }
    let _ = runtime.audit_capture(CaptureAuditReason::Restart).await;
    let listener = TcpListener::bind(config.bind)
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let authority = address.to_string();
    let mut allowed_hosts =
        HashSet::from([authority.clone(), format!("localhost:{}", address.port())]);
    if matches!(address.ip(), IpAddr::V6(_)) {
        allowed_hosts.insert(format!("[::1]:{}", address.port()));
    }
    let allowed_origins = if config.allowed_origins.is_empty() {
        HashSet::from([
            format!("http://{authority}"),
            format!("http://localhost:{}", address.port()),
        ])
    } else {
        config.allowed_origins.into_iter().collect()
    };
    let profile_activation = config.profile_activation.clone();
    let state = Arc::new(HttpState {
        allowed_hosts,
        allowed_origins,
        protocol: ProtocolState {
            auth_token: config.auth_token,
            profile_activation: config.profile_activation,
            profile_service: config.profile_service,
            runtime: runtime.clone(),
        },
        max_message_bytes: config.max_message_bytes,
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/rpc", get(rpc))
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (audit_shutdown_tx, mut audit_shutdown_rx) = oneshot::channel();
    let audit_runtime = runtime.clone();
    let mut audit_runtime_changes = audit_runtime.subscribe_changes();
    let initial_audit_runtime = audit_runtime_changes.borrow_and_update().clone();
    let mut audit_updates = initial_audit_runtime.subscribe_status();
    let audit_join = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            tokio::select! {
                biased;
                _ = &mut audit_shutdown_rx => break,
                changed = audit_runtime_changes.changed() => {
                    if changed.is_err() { break; }
                    let runtime = audit_runtime_changes.borrow_and_update().clone();
                    audit_updates = runtime.subscribe_status();
                    let _ = runtime.audit_capture(CaptureAuditReason::Restart).await;
                }
                update = audit_updates.recv() => {
                    let Ok(status) = update else { continue };
                    if !matches!(status.phase, CorePhase::Running) {
                        let _ = audit_runtime
                            .audit_capture(CaptureAuditReason::CoreHealthChanged)
                            .await;
                    }
                }
                _ = interval.tick() => {
                    let _ = audit_runtime.audit_capture(CaptureAuditReason::Periodic).await;
                }
            }
        }
    });
    let join = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await;
    });
    Ok(LoopbackServerHandle {
        address,
        audit_join,
        audit_shutdown: Some(audit_shutdown_tx),
        join,
        profile_activation,
        shutdown: Some(shutdown_tx),
        runtime,
    })
}

async fn health(
    State(state): State<Arc<HttpState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !peer.ip().is_loopback() || !valid_host(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    axum::Json(json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")})).into_response()
}

async fn rpc(
    ws: WebSocketUpgrade,
    State(state): State<Arc<HttpState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !peer.ip().is_loopback() || !valid_host(&state, &headers) || !valid_origin(&state, &headers)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(state.max_message_bytes)
        .max_frame_size(state.max_message_bytes)
        .on_upgrade(move |socket| serve_socket(socket, state.protocol.clone()))
}

fn valid_host(state: &HttpState, headers: &HeaderMap) -> bool {
    headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| state.allowed_hosts.contains(host))
}

fn valid_origin(state: &HttpState, headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| state.allowed_origins.contains(origin))
}
