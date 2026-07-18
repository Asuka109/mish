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
use mish_runtime::MishRuntime;
use serde_json::json;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

use crate::DesktopProfileService;
use crate::protocol::{ProtocolState, serve_socket};

#[derive(Clone)]
pub struct LoopbackServerConfig {
    pub allowed_origins: Vec<String>,
    pub auth_token: String,
    pub bind: SocketAddr,
    pub max_message_bytes: usize,
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
    join: JoinHandle<()>,
    shutdown: Option<oneshot::Sender<()>>,
    runtime: MishRuntime,
}

impl LoopbackServerHandle {
    pub async fn shutdown(mut self) {
        let _ = self.runtime.shutdown().await;
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
    if !config.bind.ip().is_loopback() {
        return Err("The Mish desktop bridge may only bind to a loopback address".into());
    }
    if config.auth_token.len() < 16 {
        return Err("MISH_BRIDGE_TOKEN must contain at least 16 characters".into());
    }
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
    let state = Arc::new(HttpState {
        allowed_hosts,
        allowed_origins,
        protocol: ProtocolState {
            auth_token: config.auth_token,
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
        join,
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
