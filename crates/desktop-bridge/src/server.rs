use std::{
    collections::{HashSet, VecDeque},
    io::ErrorKind,
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Body,
    extract::{ConnectInfo, Json, State, WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mish_runtime::{MishRuntime, PlatformLifecycleEventSource, RuntimeShutdownFailure};
use mish_settings::{SettingsAdapterKind, SettingsAvailability, SettingsService};
use serde::Deserialize;
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use tokio_util::sync::CancellationToken;

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
    pub port_selection: LoopbackPortSelection,
    pub browser_assets: Option<Arc<dyn BrowserAssetSource>>,
    pub browser_pairing_prompt: Option<Arc<dyn BrowserPairingPrompt>>,
    pub max_message_bytes: usize,
    pub profile_activation: Option<Arc<ProfileActivationCoordinator>>,
    pub profile_file_actions: Option<Arc<ProfileFileActions>>,
    pub profile_service: Option<Arc<DesktopProfileService>>,
    pub service_probes: Option<ServiceProbeConfig>,
    pub settings_service: Option<Arc<SettingsService>>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LoopbackPortSelection {
    #[default]
    Fixed,
    SequentialFallback,
}

pub struct BrowserAsset {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

pub trait BrowserAssetSource: Send + Sync {
    fn get(&self, path: &str) -> Option<BrowserAsset>;
}

pub trait BrowserPairingPrompt: Send + Sync {
    fn show_pin(&self, pin: &str) -> Result<(), String>;
}

const BROWSER_PAIRING_ATTEMPTS: u8 = 5;
const BROWSER_PAIRING_LIFETIME: Duration = Duration::from_secs(120);
const BROWSER_PAIRING_LOCKOUT: Duration = Duration::from_secs(60);
const BROWSER_SESSION_LIMIT: usize = 8;
const RPC_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

struct BrowserPairing {
    attempts_remaining: u8,
    challenge_id: String,
    expires_at: Instant,
    pin: String,
}

struct PendingLaunchPin {
    expires_at: Instant,
    pin: String,
}

struct BrowserSession {
    proof: String,
    token: String,
}

#[derive(Clone)]
pub struct BrowserClientHandle {
    address: SocketAddr,
    pending_launch_pins: Arc<Mutex<VecDeque<PendingLaunchPin>>>,
}

impl BrowserClientHandle {
    pub fn issue_launch_url(&self, pin: String) -> Result<String, String> {
        if !valid_browser_secret(&pin) {
            return Err("Browser launch PIN must be 32-byte hexadecimal data".into());
        }
        let mut pending = self
            .pending_launch_pins
            .lock()
            .map_err(|_| "Browser launch state is unavailable")?;
        let now = Instant::now();
        pending.retain(|candidate| candidate.expires_at > now);
        if pending.len() >= BROWSER_SESSION_LIMIT {
            pending.pop_front();
        }
        pending.push_back(PendingLaunchPin {
            expires_at: now + BROWSER_PAIRING_LIFETIME,
            pin: pin.clone(),
        });
        Ok(format!("http://{}/#mish-browser-pin={pin}", self.address))
    }
}

struct BrowserHttpState {
    assets: Arc<dyn BrowserAssetSource>,
    auth_token: String,
    pairing: Arc<Mutex<Option<BrowserPairing>>>,
    pairing_lockout: Arc<Mutex<Option<Instant>>>,
    pairing_prompt: Arc<dyn BrowserPairingPrompt>,
    pending_launch_pins: Arc<Mutex<VecDeque<PendingLaunchPin>>>,
    rpc_url: String,
    sessions: Arc<Mutex<VecDeque<BrowserSession>>>,
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
    audit_join: Option<JoinHandle<()>>,
    audit_shutdown: Option<oneshot::Sender<()>>,
    join: Option<JoinHandle<std::io::Result<()>>>,
    profile_activation: Option<Arc<ProfileActivationCoordinator>>,
    shutdown: Option<oneshot::Sender<()>>,
    runtime: DesktopRuntimeHost,
    service_probes: Option<crate::service_probes::ServiceProbeService>,
    socket_shutdown: CancellationToken,
    browser_client: Option<BrowserClientHandle>,
    terminal_failure: Option<BridgeShutdownFailure>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BridgeShutdownFailure {
    AuditJoin,
    ProfileBackgroundTask,
    ProfileMutationBusy,
    CaptureRestoration,
    CoreStop,
    StateCommit,
    RuntimeCaptureRestoration,
    RuntimeCoreStop,
    RpcServe,
    RpcJoin,
    RpcJoinTimeout,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BridgeShutdownReport {
    pub audit_stopped: bool,
    pub profile_activation_stopped: bool,
    pub capture_restored: bool,
    pub core_stopped: bool,
    pub rpc_closed: bool,
}

impl BridgeShutdownReport {
    pub fn permits_exit(self) -> bool {
        self.audit_stopped
            && self.profile_activation_stopped
            && self.capture_restored
            && self.core_stopped
            && self.rpc_closed
    }
}

pub enum BridgeShutdownOutcome {
    Confirmed(BridgeShutdownReport),
    Failed {
        failure: BridgeShutdownFailure,
        handle: Box<LoopbackServerHandle>,
        report: BridgeShutdownReport,
    },
}

impl LoopbackServerHandle {
    pub fn browser_client(&self) -> Option<BrowserClientHandle> {
        self.browser_client.clone()
    }

    pub async fn shutdown(mut self) -> BridgeShutdownOutcome {
        let mut report = BridgeShutdownReport::default();
        if let Some(failure) = self.terminal_failure {
            return BridgeShutdownOutcome::Failed {
                failure,
                handle: Box::new(self),
                report,
            };
        }
        if let Some(shutdown) = self.audit_shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.audit_join.take()
            && join.await.is_err()
        {
            return BridgeShutdownOutcome::Failed {
                failure: BridgeShutdownFailure::AuditJoin,
                handle: Box::new(self),
                report,
            };
        }
        report.audit_stopped = true;
        if let Some(profile_activation) = &self.profile_activation
            && let Err(failure) = profile_activation.shutdown_for_exit().await
        {
            let failure = match failure {
                crate::ProfileActivationShutdownFailure::BackgroundTask => {
                    BridgeShutdownFailure::ProfileBackgroundTask
                }
                crate::ProfileActivationShutdownFailure::MutationBusy => {
                    BridgeShutdownFailure::ProfileMutationBusy
                }
                crate::ProfileActivationShutdownFailure::CaptureRestoration => {
                    BridgeShutdownFailure::CaptureRestoration
                }
                crate::ProfileActivationShutdownFailure::CoreStop => {
                    BridgeShutdownFailure::CoreStop
                }
                crate::ProfileActivationShutdownFailure::StateCommit => {
                    BridgeShutdownFailure::StateCommit
                }
            };
            return BridgeShutdownOutcome::Failed {
                failure,
                handle: Box::new(self),
                report,
            };
        }
        if self.profile_activation.is_some() {
            report.capture_restored = true;
            report.core_stopped = true;
        }
        report.profile_activation_stopped = true;
        if let Some(service_probes) = &self.service_probes {
            service_probes.shutdown();
        }
        if let Err(failure) = self.runtime.current().shutdown().await {
            return BridgeShutdownOutcome::Failed {
                failure: match failure {
                    RuntimeShutdownFailure::CaptureRestoration => {
                        BridgeShutdownFailure::RuntimeCaptureRestoration
                    }
                    RuntimeShutdownFailure::CoreStop => BridgeShutdownFailure::RuntimeCoreStop,
                },
                handle: Box::new(self),
                report,
            };
        }
        report.capture_restored = true;
        report.core_stopped = true;
        if let Some(shutdown) = self.shutdown.take() {
            self.socket_shutdown.cancel();
            let _ = shutdown.send(());
        }
        if let Some(mut join) = self.join.take() {
            match tokio::time::timeout(RPC_SHUTDOWN_TIMEOUT, &mut join).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(_))) => {
                    self.terminal_failure = Some(BridgeShutdownFailure::RpcServe);
                    return BridgeShutdownOutcome::Failed {
                        failure: BridgeShutdownFailure::RpcServe,
                        handle: Box::new(self),
                        report,
                    };
                }
                Ok(Err(_)) => {
                    self.terminal_failure = Some(BridgeShutdownFailure::RpcJoin);
                    return BridgeShutdownOutcome::Failed {
                        failure: BridgeShutdownFailure::RpcJoin,
                        handle: Box::new(self),
                        report,
                    };
                }
                Err(_) => {
                    self.join = Some(join);
                    return BridgeShutdownOutcome::Failed {
                        failure: BridgeShutdownFailure::RpcJoinTimeout,
                        handle: Box::new(self),
                        report,
                    };
                }
            }
        }
        report.rpc_closed = true;
        BridgeShutdownOutcome::Confirmed(report)
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
    if config.browser_assets.is_some() && config.browser_pairing_prompt.is_none() {
        return Err("Browser client hosting requires the pairing prompt".into());
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
    let listener = bind_loopback_listener(config.bind, config.port_selection).await?;
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
    let pending_launch_pins = Arc::new(Mutex::new(VecDeque::new()));
    let browser = config.browser_assets.map(|assets| BrowserHttpState {
        assets,
        auth_token: config.auth_token.clone(),
        pairing: Arc::new(Mutex::new(None)),
        pairing_lockout: Arc::new(Mutex::new(None)),
        pairing_prompt: config
            .browser_pairing_prompt
            .expect("browser pairing prompt checked before server startup"),
        pending_launch_pins: pending_launch_pins.clone(),
        rpc_url: format!("ws://{authority}/rpc"),
        sessions: Arc::new(Mutex::new(VecDeque::new())),
        settings_service: settings_service
            .clone()
            .expect("browser Settings service checked before server startup"),
    });
    let browser_client = browser.as_ref().map(|_| BrowserClientHandle {
        address,
        pending_launch_pins,
    });
    let socket_shutdown = CancellationToken::new();
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
            socket_shutdown: socket_shutdown.clone(),
        },
        max_message_bytes: config.max_message_bytes,
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/rpc", get(rpc))
        .route("/browser-pairing", post(start_browser_pairing))
        .route("/browser-pairing/complete", post(complete_browser_pairing))
        .route("/browser-bootstrap", post(browser_bootstrap))
        .fallback(browser_asset)
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (audit_shutdown_tx, audit_shutdown_rx) = oneshot::channel();
    let audit_join = spawn_lifecycle_coordination(
        runtime.clone(),
        lifecycle_source,
        settings_service,
        service_probes.clone(),
        audit_shutdown_rx,
    );
    let join = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
    });
    Ok(LoopbackServerHandle {
        address,
        audit_join: Some(audit_join),
        audit_shutdown: Some(audit_shutdown_tx),
        join: Some(join),
        profile_activation,
        shutdown: Some(shutdown_tx),
        runtime,
        service_probes,
        socket_shutdown,
        browser_client,
        terminal_failure: None,
    })
}

async fn bind_loopback_listener(
    bind: SocketAddr,
    port_selection: LoopbackPortSelection,
) -> Result<TcpListener, String> {
    match port_selection {
        LoopbackPortSelection::Fixed => TcpListener::bind(bind)
            .await
            .map_err(|error| format!("failed to bind Mish desktop bridge at {bind}: {error}")),
        LoopbackPortSelection::SequentialFallback => {
            for port in bind.port()..=u16::MAX {
                let candidate = SocketAddr::new(bind.ip(), port);
                match TcpListener::bind(candidate).await {
                    Ok(listener) => return Ok(listener),
                    Err(error) if error.kind() == ErrorKind::AddrInUse => continue,
                    Err(error) => {
                        return Err(format!(
                            "failed to bind Mish desktop bridge at {candidate}: {error}"
                        ));
                    }
                }
            }
            Err(format!(
                "failed to bind Mish desktop bridge: no port is available from {} through {}",
                bind.port(),
                u16::MAX
            ))
        }
    }
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
    let proof = browser_proof(&headers);
    let launch_pin = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Mish-Browser-Pin "));
    let accepted_launch = launch_pin.and_then(|pin| {
        browser
            .pending_launch_pins
            .lock()
            .ok()
            .and_then(|mut pending| {
                let now = Instant::now();
                pending.retain(|candidate| candidate.expires_at > now);
                let index = pending.iter().position(|candidate| {
                    bool::from(candidate.pin.as_bytes().ct_eq(pin.as_bytes()))
                })?;
                pending.remove(index).map(|candidate| candidate.pin)
            })
    });
    if launch_pin.is_some() && accepted_launch.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if accepted_launch.is_none() && !has_browser_session(browser, &headers, proof) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let session = if accepted_launch.is_some() {
        let Some(proof) = proof else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        match establish_browser_session(browser, proof) {
            Ok(session) => Some(session),
            Err(response) => return response,
        }
    } else {
        None
    };
    browser_bootstrap_response(browser, session.as_deref())
}

async fn start_browser_pairing(
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
    let now = Instant::now();
    let Ok(mut lockout) = browser.pairing_lockout.lock() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if lockout.is_some_and(|until| until > now) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    *lockout = None;
    drop(lockout);
    let (challenge_id, should_prompt, pin) = {
        let Ok(mut pending) = browser.pairing.lock() else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        if pending
            .as_ref()
            .is_some_and(|pairing| pairing.expires_at <= now)
        {
            *pending = None;
        }
        if let Some(pairing) = pending.as_ref() {
            (pairing.challenge_id.clone(), false, pairing.pin.clone())
        } else {
            let Ok(pin) = generate_pairing_pin() else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            let Ok(challenge_id) = generate_browser_secret() else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            *pending = Some(BrowserPairing {
                attempts_remaining: BROWSER_PAIRING_ATTEMPTS,
                challenge_id: challenge_id.clone(),
                expires_at: now + BROWSER_PAIRING_LIFETIME,
                pin: pin.clone(),
            });
            (challenge_id, true, pin)
        }
    };
    if should_prompt && browser.pairing_prompt.show_pin(&pin).is_err() {
        if let Ok(mut pending) = browser.pairing.lock()
            && pending
                .as_ref()
                .is_some_and(|pairing| pairing.challenge_id == challenge_id)
        {
            *pending = None;
        }
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    secure_json_response(
        json!({
            "challengeId": challenge_id,
            "expiresInSeconds": BROWSER_PAIRING_LIFETIME.as_secs(),
        }),
        None,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CompleteBrowserPairing {
    challenge_id: String,
    pin: String,
}

async fn complete_browser_pairing(
    State(state): State<Arc<HttpState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CompleteBrowserPairing>,
) -> Response {
    if !peer.ip().is_loopback() || !valid_host(&state, &headers) || !valid_origin(&state, &headers)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(browser) = &state.browser else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(proof) = browser_proof(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !valid_browser_secret(&request.challenge_id) || !valid_pairing_pin(&request.pin) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let accepted = {
        let Ok(mut pending) = browser.pairing.lock() else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        let Some(pairing) = pending.as_mut() else {
            return StatusCode::GONE.into_response();
        };
        if pairing.expires_at <= Instant::now() {
            *pending = None;
            return StatusCode::GONE.into_response();
        }
        let challenge_matches = bool::from(
            pairing
                .challenge_id
                .as_bytes()
                .ct_eq(request.challenge_id.as_bytes()),
        );
        let pin_matches = bool::from(pairing.pin.as_bytes().ct_eq(request.pin.as_bytes()));
        if challenge_matches && pin_matches {
            pending.take();
            true
        } else {
            pairing.attempts_remaining = pairing.attempts_remaining.saturating_sub(1);
            if pairing.attempts_remaining == 0 {
                *pending = None;
                if let Ok(mut lockout) = browser.pairing_lockout.lock() {
                    *lockout = Some(Instant::now() + BROWSER_PAIRING_LOCKOUT);
                }
                return StatusCode::TOO_MANY_REQUESTS.into_response();
            }
            false
        }
    };
    if !accepted {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let session = match establish_browser_session(browser, proof) {
        Ok(session) => session,
        Err(response) => return response,
    };
    browser_bootstrap_response(browser, Some(&session))
}

fn browser_bootstrap_response(browser: &BrowserHttpState, session: Option<&str>) -> Response {
    let mut settings_snapshot = browser.settings_service.snapshot(SettingsAdapterKind::Rpc);
    settings_snapshot.capabilities.backup_restore = SettingsAvailability::Unavailable;
    settings_snapshot.capabilities.native_sidebar_material = SettingsAvailability::Unavailable;
    settings_snapshot.capabilities.window_lifecycle = SettingsAvailability::Unavailable;
    secure_json_response(
        json!({
            "authToken": browser.auth_token,
            "localBackup": false,
            "rpcUrl": browser.rpc_url,
            "settingsSnapshot": settings_snapshot,
            "supportBundleExport": false,
        }),
        session,
    )
}

fn establish_browser_session(browser: &BrowserHttpState, proof: &str) -> Result<String, Response> {
    let token =
        generate_browser_secret().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())?;
    let mut sessions = browser
        .sessions
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())?;
    if sessions.len() >= BROWSER_SESSION_LIMIT {
        sessions.pop_front();
    }
    sessions.push_back(BrowserSession {
        proof: proof.to_owned(),
        token: token.clone(),
    });
    Ok(token)
}

fn generate_pairing_pin() -> Result<String, getrandom::Error> {
    const RANGE: u64 = 1_000_000;
    const LIMIT: u64 = (u32::MAX as u64 + 1) / RANGE * RANGE;
    loop {
        let mut bytes = [0_u8; 4];
        getrandom::fill(&mut bytes)?;
        let value = u64::from(u32::from_le_bytes(bytes));
        if value < LIMIT {
            return Ok(format!("{:06}", value % RANGE));
        }
    }
}

fn generate_browser_secret() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_pairing_pin(pin: &str) -> bool {
    pin.len() == 6 && pin.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_browser_secret(secret: &str) -> bool {
    secret.len() == 64
        && secret
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn browser_proof(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-mish-browser-proof")
        .and_then(|value| value.to_str().ok())
        .filter(|proof| valid_browser_secret(proof))
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

fn has_browser_session(
    browser: &BrowserHttpState,
    headers: &HeaderMap,
    proof: Option<&str>,
) -> bool {
    let Some(proof) = proof else {
        return false;
    };
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
        sessions.iter().any(|expected| {
            bool::from(expected.token.as_bytes().ct_eq(session.as_bytes()))
                && bool::from(expected.proof.as_bytes().ct_eq(proof.as_bytes()))
        })
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
        "default-src 'self'; connect-src 'self' {rpc_url}; font-src 'self'; frame-src 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'"
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

#[cfg(test)]
mod shutdown_report_tests {
    use super::BridgeShutdownReport;

    #[test]
    fn exit_requires_every_ordered_shutdown_confirmation() {
        let confirmed = BridgeShutdownReport {
            audit_stopped: true,
            profile_activation_stopped: true,
            capture_restored: true,
            core_stopped: true,
            rpc_closed: true,
        };
        assert!(confirmed.permits_exit());

        for incomplete in [
            BridgeShutdownReport {
                audit_stopped: false,
                ..confirmed
            },
            BridgeShutdownReport {
                profile_activation_stopped: false,
                ..confirmed
            },
            BridgeShutdownReport {
                capture_restored: false,
                ..confirmed
            },
            BridgeShutdownReport {
                core_stopped: false,
                ..confirmed
            },
            BridgeShutdownReport {
                rpc_closed: false,
                ..confirmed
            },
        ] {
            assert!(!incomplete.permits_exit());
        }
    }
}
