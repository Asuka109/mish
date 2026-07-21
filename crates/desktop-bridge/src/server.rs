use std::{
    collections::{HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Body,
    extract::{ConnectInfo, State, WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mish_runtime::{MishRuntime, PlatformLifecycleEventSource};
use mish_settings::{SettingsAdapterKind, SettingsAvailability, SettingsService};
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

use crate::lifecycle::spawn_lifecycle_coordination;
use crate::protocol::{ProtocolState, serve_socket};
use crate::{
    DesktopProfileService, DesktopRuntimeHost, ProfileActivationCoordinator, ProfileFileActions,
    ServiceProbeConfig,
};

#[derive(Clone)]
pub struct LoopbackServerConfig {
    pub allowed_origins: Vec<String>,
    pub auth_token: String,
    pub bind: SocketAddr,
    pub browser_assets: Option<Arc<dyn BrowserAssetSource>>,
    pub max_message_bytes: usize,
    pub profile_activation: Option<Arc<ProfileActivationCoordinator>>,
    pub profile_file_actions: Option<Arc<ProfileFileActions>>,
    pub profile_service: Option<Arc<DesktopProfileService>>,
    pub service_probes: Option<ServiceProbeConfig>,
    pub settings_service: Option<Arc<SettingsService>>,
}

pub struct BrowserAsset {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

pub trait BrowserAssetSource: Send + Sync {
    fn get(&self, path: &str) -> Option<BrowserAsset>;
}

#[derive(Clone)]
pub struct BrowserClientHandle {
    address: SocketAddr,
    pending_nonce: Arc<Mutex<Option<String>>>,
}

impl BrowserClientHandle {
    pub fn issue_launch_url(&self, nonce: String) -> Result<String, String> {
        if nonce.len() != 64
            || !nonce
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err("Browser launch nonce must be 32-byte hexadecimal data".into());
        }
        *self
            .pending_nonce
            .lock()
            .map_err(|_| "Browser launch state is unavailable")? = Some(nonce.clone());
        Ok(format!(
            "http://{}/#mish-browser-bootstrap={nonce}",
            self.address
        ))
    }
}

struct BrowserHttpState {
    assets: Arc<dyn BrowserAssetSource>,
    auth_token: String,
    pending_nonce: Arc<Mutex<Option<String>>>,
    rpc_url: String,
    sessions: Arc<Mutex<VecDeque<String>>>,
    settings_service: Arc<SettingsService>,
}

struct HttpState {
    allowed_hosts: HashSet<String>,
    allowed_origins: HashSet<String>,
    browser: Option<BrowserHttpState>,
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
    service_probes: Option<crate::service_probes::ServiceProbeService>,
    browser_client: Option<BrowserClientHandle>,
}

impl LoopbackServerHandle {
    pub fn browser_client(&self) -> Option<BrowserClientHandle> {
        self.browser_client.clone()
    }

    pub async fn shutdown(mut self) {
        if let Some(shutdown) = self.audit_shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.audit_join.await;
        if let Some(profile_activation) = &self.profile_activation {
            let _ = profile_activation.shutdown().await;
        }
        if let Some(service_probes) = &self.service_probes {
            service_probes.shutdown();
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
    if config.browser_assets.is_some() && config.settings_service.is_none() {
        return Err("Browser client hosting requires the Settings service".into());
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
    let mut allowed_origins = HashSet::from([
        format!("http://{authority}"),
        format!("http://localhost:{}", address.port()),
    ]);
    allowed_origins.extend(config.allowed_origins);
    let profile_activation = config.profile_activation.clone();
    let settings_service = config.settings_service.clone();
    let service_probes = config
        .service_probes
        .map(crate::service_probes::ServiceProbeService::new);
    if let Some(service_probes) = &service_probes {
        service_probes.start();
    }
    let pending_browser_nonce = Arc::new(Mutex::new(None));
    let browser = config.browser_assets.map(|assets| BrowserHttpState {
        assets,
        auth_token: config.auth_token.clone(),
        pending_nonce: pending_browser_nonce.clone(),
        rpc_url: format!("ws://{authority}/rpc"),
        sessions: Arc::new(Mutex::new(VecDeque::new())),
        settings_service: settings_service
            .clone()
            .expect("browser Settings service checked before server startup"),
    });
    let browser_client = browser.as_ref().map(|_| BrowserClientHandle {
        address,
        pending_nonce: pending_browser_nonce,
    });
    let state = Arc::new(HttpState {
        allowed_hosts,
        allowed_origins,
        browser,
        protocol: ProtocolState {
            auth_token: config.auth_token,
            profile_activation: config.profile_activation,
            profile_file_actions: config.profile_file_actions,
            profile_service: config.profile_service,
            runtime: runtime.clone(),
            service_probes: service_probes.clone(),
            settings_service: config.settings_service,
        },
        max_message_bytes: config.max_message_bytes,
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/rpc", get(rpc))
        .route("/browser-bootstrap", post(browser_bootstrap))
        .fallback(browser_asset)
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (audit_shutdown_tx, audit_shutdown_rx) = oneshot::channel();
    let audit_join = spawn_lifecycle_coordination(
        runtime.clone(),
        lifecycle_source,
        settings_service,
        audit_shutdown_rx,
    );
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
        service_probes,
        browser_client,
    })
}

async fn browser_bootstrap(
    State(state): State<Arc<HttpState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !peer.ip().is_loopback() || !valid_host(&state, &headers) || !valid_origin(&state, &headers)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(browser) = &state.browser else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let launch_nonce = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Mish-Browser "));
    let accepted_launch = launch_nonce.and_then(|nonce| {
        browser.pending_nonce.lock().ok().and_then(|mut pending| {
            let expected = pending.as_ref()?;
            let matches = bool::from(expected.as_bytes().ct_eq(nonce.as_bytes()));
            matches.then(|| pending.take()).flatten()
        })
    });
    if launch_nonce.is_some() && accepted_launch.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if accepted_launch.is_none() && !has_browser_session(browser, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let mut settings_snapshot = browser.settings_service.snapshot(SettingsAdapterKind::Rpc);
    settings_snapshot.capabilities.backup_restore = SettingsAvailability::Unavailable;
    settings_snapshot.capabilities.native_sidebar_material = SettingsAvailability::Unavailable;
    settings_snapshot.capabilities.window_lifecycle = SettingsAvailability::Unavailable;
    if let Some(session) = &accepted_launch {
        let Ok(mut sessions) = browser.sessions.lock() else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        if sessions.len() >= 8 {
            sessions.pop_front();
        }
        sessions.push_back(session.clone());
    }
    secure_json_response(
        json!({
            "authToken": browser.auth_token,
            "localBackup": false,
            "rpcUrl": browser.rpc_url,
            "settingsSnapshot": settings_snapshot,
            "supportBundleExport": false,
        }),
        accepted_launch.as_deref(),
    )
}

async fn browser_asset(
    State(state): State<Arc<HttpState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if !matches!(method, Method::GET | Method::HEAD) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    if !peer.ip().is_loopback() || !valid_host(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(browser) = &state.browser else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(path) = safe_asset_path(uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let asset = browser.assets.get(path).or_else(|| {
        if Path::new(path).extension().is_none() {
            browser.assets.get("index.html")
        } else {
            None
        }
    });
    let Some(asset) = asset else {
        return StatusCode::NOT_FOUND.into_response();
    };
    secure_asset_response(asset, method == Method::HEAD, &browser.rpc_url)
}

fn safe_asset_path(path: &str) -> Option<&str> {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    (!path.contains(['\\', '\0', '%'])
        && path
            .split('/')
            .all(|component| !matches!(component, "." | "..")))
    .then_some(path)
}

fn secure_asset_response(asset: BrowserAsset, head_only: bool, rpc_url: &str) -> Response {
    let length = asset.bytes.len();
    let body = if head_only {
        Body::empty()
    } else {
        Body::from(asset.bytes)
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.content_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_SECURITY_POLICY,
            browser_content_security_policy(rpc_url),
        )
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("cross-origin-resource-policy", "same-origin")
        .header(
            "permissions-policy",
            "camera=(), microphone=(), geolocation=()",
        )
        .header("x-content-type-options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn has_browser_session(browser: &BrowserHttpState, headers: &HeaderMap) -> bool {
    let Some(session) = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                cookie
                    .trim()
                    .strip_prefix("mish_browser_session=")
                    .map(str::to_owned)
            })
        })
    else {
        return false;
    };
    browser.sessions.lock().is_ok_and(|sessions| {
        sessions
            .iter()
            .any(|expected| bool::from(expected.as_bytes().ct_eq(session.as_bytes())))
    })
}

fn secure_json_response(value: serde_json::Value, browser_session: Option<&str>) -> Response {
    let mut response = axum::Json(value).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    headers.insert(
        "cross-origin-resource-policy",
        "same-origin".parse().unwrap(),
    );
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    if let Some(session) = browser_session {
        headers.insert(
            header::SET_COOKIE,
            format!(
                "mish_browser_session={session}; HttpOnly; SameSite=Strict; Path=/browser-bootstrap"
            )
            .parse()
            .unwrap(),
        );
    }
    response
}

fn browser_content_security_policy(rpc_url: &str) -> String {
    format!(
        "default-src 'self'; connect-src 'self' {rpc_url}; font-src 'self'; frame-src 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    )
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
