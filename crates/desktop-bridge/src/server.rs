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
use mish_runtime::{MishRuntime, PlatformLifecycleEventSource};
use mish_settings::SettingsService;
use serde_json::json;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

use crate::lifecycle::spawn_lifecycle_coordination;
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
    pub settings_service: Option<Arc<SettingsService>>,
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
    start_loopback_server_with_runtime_host_and_lifecycle(config, runtime, None).await
}

pub async fn start_loopback_server_with_runtime_host_and_lifecycle(
    config: LoopbackServerConfig,
    runtime: DesktopRuntimeHost,
    lifecycle_source: Option<Arc<dyn PlatformLifecycleEventSource>>,
) -> Result<LoopbackServerHandle, String> {
    if !config.bind.ip().is_loopback() {
        return Err("The Mish desktop bridge may only bind to a loopback address".into());
    }
    if config.auth_token.len() < 16 {
        return Err("MISH_BRIDGE_TOKEN must contain at least 16 characters".into());
    }
    if let (Some(profiles), Some(settings)) = (&config.profile_service, &config.settings_service)
        && !profiles
            .mutation_authority()
            .is_same_authority(&settings.mutation_authority())
    {
        return Err("Profile and Settings services must share one mutation authority".into());
    }
    if let (Some(profiles), Some(activation)) =
        (&config.profile_service, &config.profile_activation)
        && !profiles
            .mutation_authority()
            .is_same_authority(&activation.mutation_authority())
    {
        return Err("Profile service and activation must share one mutation authority".into());
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
    let profile_activation = config.profile_activation.clone();
    let state = Arc::new(HttpState {
        allowed_hosts,
        allowed_origins,
        protocol: ProtocolState {
            auth_token: config.auth_token,
            profile_activation: config.profile_activation,
            profile_service: config.profile_service,
            runtime: runtime.clone(),
            settings_service: config.settings_service,
        },
        max_message_bytes: config.max_message_bytes,
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/rpc", get(rpc))
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (audit_shutdown_tx, audit_shutdown_rx) = oneshot::channel();
    let audit_join =
        spawn_lifecycle_coordination(runtime.clone(), lifecycle_source, audit_shutdown_rx);
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
