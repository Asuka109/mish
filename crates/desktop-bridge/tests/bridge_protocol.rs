use std::{
    env, fs,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener as StdTcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use futures_util::{
    SinkExt, StreamExt,
    future::{BoxFuture, ready},
};
use mish_bridge::{
    ActivationTiming, BridgeShutdownOutcome, BrowserAsset, BrowserAssetSource,
    BrowserPairingPrompt, DesktopMihomoProcess, DesktopMihomoProcessConfig, DesktopRuntimeHost,
    LoopbackPortSelection, LoopbackServerConfig, ManagedMihomoResolver, ManagedRuntimePolicy,
    MihomoActivationManager, ProfileActivationCoordinator, ProfileFileActionError,
    ProfileFileActionPlatform, ProfileFileActions, ReqwestHttpsSourceReader, ServiceProbeConfig,
    start_loopback_server, start_loopback_server_with_runtime_host,
};
use mish_runtime::{
    ApplicationDiagnosticEvent, CaptureJournal, CaptureJournalStore, CapturePlatform,
    CaptureReconciler, CaptureTransitionError, CoreError, CorePhase, CoreRuntime, CoreStatus,
    LoopbackProxyEndpoint, MishRuntime, NetworkServiceProxyState,
};
use mish_settings::{
    DnsObservation, LoadedSettings, NetworkDnsObservation, NetworkDnsObservationError,
    NetworkDnsPlatform, NetworkDnsSource, NetworkInterfaceKind, NetworkInterfaceObservation,
    OnboardingPreferences, OnboardingWelcomeInvitation, SettingsCapabilities, SettingsPreferences,
    SettingsRepository, SettingsRepositoryError, SettingsService, StartupPlatform,
    StartupPlatformError, WindowSurfacePlatform, WindowSurfacePlatformError,
    WindowSurfacePreference,
};
use serde_json::{Value, json};
use tokio::{
    sync::Mutex as AsyncMutex,
    time::{Duration, timeout},
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

const TOKEN: &str = "test-token-123456789";
const ORIGIN: &str = "http://mish.test";

struct BrowserAssets;

#[derive(Default)]
struct RecordingPairingPrompt(Mutex<Vec<String>>);

impl BrowserPairingPrompt for RecordingPairingPrompt {
    fn show_pin(&self, pin: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(pin.to_owned());
        Ok(())
    }
}

#[derive(Default)]
struct RecordingProfileFilePlatform {
    opened: Mutex<Vec<PathBuf>>,
}

impl ProfileFileActionPlatform for RecordingProfileFilePlatform {
    fn open_directory(&self, path: &Path) -> Result<(), ProfileFileActionError> {
        self.opened.lock().unwrap().push(path.to_owned());
        Ok(())
    }
}

impl BrowserAssetSource for BrowserAssets {
    fn get(&self, path: &str) -> Option<BrowserAsset> {
        match path {
            "index.html" => Some(BrowserAsset {
                bytes: b"<!doctype html><title>Mish</title>".to_vec(),
                content_type: "text/html; charset=utf-8".into(),
            }),
            "assets/app.js" => Some(BrowserAsset {
                bytes: b"export const mish = true;".to_vec(),
                content_type: "text/javascript; charset=utf-8".into(),
            }),
            _ => None,
        }
    }
}

struct RunningCore;

impl CoreRuntime for RunningCore {
    fn configured(&self) -> bool {
        true
    }

    fn owns_local_proxy(&self, _endpoint: &LoopbackProxyEndpoint) -> BoxFuture<'_, bool> {
        Box::pin(ready(true))
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: None,
            version: Some("rpc-fixture".into()),
        }))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move { Ok(self.status().await) })
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Ok(CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: Some("rpc-fixture".into()),
        })))
    }
}

struct RunningCoreWithoutManagedListener;

impl CoreRuntime for RunningCoreWithoutManagedListener {
    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: Some(4242),
            version: Some("rpc-fixture".into()),
        }))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move { Ok(self.status().await) })
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(ready(Ok(CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: Some("rpc-fixture".into()),
        })))
    }
}

struct MemoryCapturePlatform(std::sync::Mutex<NetworkServiceProxyState>);

impl CapturePlatform for MemoryCapturePlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.0.lock().unwrap().clone())))
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.0.lock().unwrap().clone())))
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        *self.0.lock().unwrap() = target;
        Box::pin(ready(Ok(())))
    }
}

struct SlowCapturePlatform {
    apply_started: tokio::sync::Notify,
    apply_release: tokio::sync::Notify,
    state: std::sync::Mutex<NetworkServiceProxyState>,
}

impl SlowCapturePlatform {
    fn new(state: NetworkServiceProxyState) -> Self {
        Self {
            apply_started: tokio::sync::Notify::new(),
            apply_release: tokio::sync::Notify::new(),
            state: std::sync::Mutex::new(state),
        }
    }
}

impl CapturePlatform for SlowCapturePlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.state.lock().unwrap().clone())))
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.state.lock().unwrap().clone())))
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        Box::pin(async move {
            self.apply_started.notify_one();
            self.apply_release.notified().await;
            *self.state.lock().unwrap() = target;
            Ok(())
        })
    }
}

#[derive(Default)]
struct MemoryCaptureJournal(std::sync::Mutex<Option<CaptureJournal>>);

impl CaptureJournalStore for MemoryCaptureJournal {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        *self.0.lock().unwrap() = Some(journal.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Default)]
struct MemorySettingsRepository(std::sync::Mutex<SettingsPreferences>);

impl SettingsRepository for MemorySettingsRepository {
    fn load(&self) -> Result<LoadedSettings, SettingsRepositoryError> {
        Ok(LoadedSettings {
            needs_persistence: false,
            preferences: *self.0.lock().unwrap(),
        })
    }

    fn save(&self, preferences: &SettingsPreferences) -> Result<(), SettingsRepositoryError> {
        *self.0.lock().unwrap() = *preferences;
        Ok(())
    }
}

#[derive(Default)]
struct MemoryStartupPlatform(std::sync::atomic::AtomicBool);

impl StartupPlatform for MemoryStartupPlatform {
    fn is_enabled(&self) -> Result<bool, StartupPlatformError> {
        Ok(self.0.load(std::sync::atomic::Ordering::SeqCst))
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), StartupPlatformError> {
        self.0.store(enabled, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Default)]
struct MemoryWindowSurfacePlatform(std::sync::Mutex<WindowSurfacePreference>);

impl WindowSurfacePlatform for MemoryWindowSurfacePlatform {
    fn set_surface(
        &self,
        surface: WindowSurfacePreference,
    ) -> Result<(), WindowSurfacePlatformError> {
        *self.0.lock().unwrap() = surface;
        Ok(())
    }
}

struct MemoryNetworkDnsPlatform;

impl NetworkDnsPlatform for MemoryNetworkDnsPlatform {
    fn observe(&self) -> BoxFuture<'_, Result<NetworkDnsObservation, NetworkDnsObservationError>> {
        Box::pin(ready(Ok(NetworkDnsObservation {
            dns: DnsObservation {
                resolver_count: 1,
                scoped_resolver_count: 1,
                search_domains: vec!["private.example".into()],
                servers: vec!["192.0.2.53".into()],
            },
            interfaces: vec![NetworkInterfaceObservation {
                interface: "en0".into(),
                interface_kind: NetworkInterfaceKind::Ethernet,
                ipv4_available: true,
                ipv6_available: false,
                service: Some("Office LAN".into()),
            }],
            source: NetworkDnsSource::MacosSystemConfiguration,
        })))
    }
}

fn settings_service() -> Arc<SettingsService> {
    let preferences = SettingsPreferences {
        onboarding: OnboardingPreferences {
            welcome_invitation: Some(OnboardingWelcomeInvitation {
                completed_at: None,
                created_at: 1,
                first_opened_at: None,
                last_dismissed_at: None,
                prompted_at: None,
                version: 2,
            }),
        },
        ..SettingsPreferences::default()
    };
    Arc::new(
        SettingsService::load_with_platforms(
            Arc::new(MemorySettingsRepository(Mutex::new(preferences))),
            Some(Arc::new(MemoryStartupPlatform::default())),
            Some(Arc::new(MemoryWindowSurfacePlatform::default())),
            SettingsCapabilities::macos(true),
            None,
            Some(Arc::new(MemoryNetworkDnsPlatform)),
        )
        .unwrap(),
    )
}

fn capture_runtime() -> MishRuntime {
    capture_runtime_parts().0
}

fn capture_runtime_parts() -> (MishRuntime, Arc<MemoryCapturePlatform>) {
    let platform = Arc::new(MemoryCapturePlatform(std::sync::Mutex::new(
        NetworkServiceProxyState {
            auto_discovery_enabled: false,
            http: mish_runtime::ManualProxyState::disabled(),
            https: mish_runtime::ManualProxyState::disabled(),
            pac_enabled: false,
            pac_url: "(null)".into(),
            service_id: "rpc-fixture-service".into(),
            socks: mish_runtime::ManualProxyState::disabled(),
        },
    )));
    let capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        Arc::new(MemoryCaptureJournal::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    ));
    (
        MishRuntime::with_capture(Arc::new(RunningCore), capture),
        platform,
    )
}

fn slow_capture_runtime_parts() -> (MishRuntime, Arc<SlowCapturePlatform>) {
    let platform = Arc::new(SlowCapturePlatform::new(NetworkServiceProxyState {
        auto_discovery_enabled: false,
        http: mish_runtime::ManualProxyState::disabled(),
        https: mish_runtime::ManualProxyState::disabled(),
        pac_enabled: false,
        pac_url: "(null)".into(),
        service_id: "slow-rpc-fixture-service".into(),
        socks: mish_runtime::ManualProxyState::disabled(),
    }));
    let capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        Arc::new(MemoryCaptureJournal::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    ));
    (
        MishRuntime::with_capture(Arc::new(RunningCore), capture),
        platform,
    )
}

fn config() -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec![ORIGIN.into()],
        auth_token: TOKEN.into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        port_selection: LoopbackPortSelection::Fixed,
        browser_assets: None,
        browser_pairing_prompt: None,
        max_message_bytes: 1_048_576,
        profile_activation: None,
        profile_file_actions: None,
        profile_service: None,
        service_probes: None,
        settings_service: None,
    }
}

fn stable_port_test_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

#[tokio::test]
async fn sequential_port_selection_starts_at_6474_when_available() {
    let _lock = stable_port_test_lock().lock().await;
    let mut bridge_config = config();
    bridge_config.bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 6474);
    bridge_config.port_selection = LoopbackPortSelection::SequentialFallback;

    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    assert_eq!(
        bridge.address,
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 6474)
    );
    bridge.shutdown().await;
}

#[tokio::test]
async fn sequential_port_selection_retains_first_available_listener() {
    let _lock = stable_port_test_lock().lock().await;
    let first = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 6474)).unwrap();
    let second = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 6475)).unwrap();
    let mut bridge_config = config();
    bridge_config.bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 6474);
    bridge_config.port_selection = LoopbackPortSelection::SequentialFallback;

    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    assert_eq!(
        bridge.address,
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 6476)
    );
    assert!(StdTcpListener::bind((Ipv4Addr::LOCALHOST, 6476)).is_err());

    bridge.shutdown().await;
    drop(second);
    drop(first);
}

#[tokio::test]
async fn fixed_and_ephemeral_port_selection_preserve_existing_semantics() {
    let fixed_port = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut fixed_config = config();
    fixed_config.bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), fixed_port);
    let fixed_bridge = start_loopback_server(fixed_config, runtime(no_core()))
        .await
        .unwrap();
    assert_eq!(fixed_bridge.address.port(), fixed_port);
    fixed_bridge.shutdown().await;

    let ephemeral_bridge = start_loopback_server(config(), runtime(no_core()))
        .await
        .unwrap();
    assert_ne!(ephemeral_bridge.address.port(), 0);
    ephemeral_bridge.shutdown().await;
}

fn runtime(config: DesktopMihomoProcessConfig) -> MishRuntime {
    MishRuntime::new(Arc::new(DesktopMihomoProcess::new(config)))
}

fn no_core() -> DesktopMihomoProcessConfig {
    DesktopMihomoProcessConfig {
        binary: None,
        config_directory: None,
        config_file: None,
    }
}

async fn socket(
    address: SocketAddr,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = format!("ws://{address}/rpc").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", ORIGIN.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn request(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    value: Value,
) -> Value {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
    let Message::Text(response) = socket.next().await.unwrap().unwrap() else {
        panic!("expected text response")
    };
    serde_json::from_str(&response).unwrap()
}

async fn authenticate(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let response = request(
        socket,
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "rpc.authenticate",
            "params": {"clientName": "integration-test", "clientVersion": "1", "token": TOKEN}
        }),
    )
    .await;
    assert_eq!(response["result"]["authenticated"], true);
}

async fn next_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    let Message::Text(message) = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("notification timeout")
        .expect("socket closed")
        .expect("websocket failure")
    else {
        panic!("expected text notification")
    };
    serde_json::from_str(&message).unwrap()
}

#[tokio::test]
async fn authoritative_application_notifications_reach_every_events_client() {
    let runtime = runtime(no_core());
    let runtime_host = DesktopRuntimeHost::new(runtime.clone());
    let bridge = start_loopback_server_with_runtime_host(config(), runtime_host)
        .await
        .unwrap();
    let mut first = socket(bridge.address).await;
    let mut second = socket(bridge.address).await;
    authenticate(&mut first).await;
    authenticate(&mut second).await;

    for (id, socket) in [(2, &mut first), (3, &mut second)] {
        let subscribed = request(
            socket,
            json!({"jsonrpc":"2.0", "id":id, "method":"events.subscribe", "params":{}}),
        )
        .await;
        assert!(subscribed["result"]["subscriptionId"].is_string());
    }

    runtime.record_application_event(ApplicationDiagnosticEvent::settings_failure());

    for socket in [&mut first, &mut second] {
        let notification = next_json(socket).await;
        assert_eq!(notification["method"], "events.snapshot");
        assert_eq!(
            notification["params"]["snapshot"]["events"][0]["notificationKind"],
            "settings-failure"
        );
    }

    bridge.shutdown().await;
}

#[tokio::test]
async fn browser_client_serves_spa_assets_and_consumes_one_launch_nonce() {
    let mut bridge_config = config();
    bridge_config.browser_assets = Some(Arc::new(BrowserAssets));
    bridge_config.browser_pairing_prompt = Some(Arc::new(RecordingPairingPrompt::default()));
    bridge_config.settings_service = Some(settings_service());
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let browser = bridge.browser_client().expect("browser client handle");
    let nonce = "a".repeat(64);
    let launch_url = browser.issue_launch_url(nonce.clone()).unwrap();
    assert_eq!(
        launch_url,
        format!("http://{}/#mish-browser-pin={nonce}", bridge.address)
    );
    assert!(!launch_url.contains(TOKEN));
    let second_nonce = "b".repeat(64);
    assert_eq!(
        browser.issue_launch_url(second_nonce.clone()).unwrap(),
        format!("http://{}/#mish-browser-pin={second_nonce}", bridge.address)
    );

    let client = reqwest::Client::new();
    let root = client
        .get(format!("http://{}/", bridge.address))
        .send()
        .await
        .unwrap();
    assert_eq!(root.status(), reqwest::StatusCode::OK);
    assert_eq!(
        root.headers()["content-security-policy"],
        format!(
            "default-src 'self'; connect-src 'self' ws://{}/rpc; font-src 'self'; frame-src 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'",
            bridge.address
        )
    );
    assert_eq!(root.headers()["referrer-policy"], "no-referrer");
    assert!(root.text().await.unwrap().contains("<title>Mish</title>"));

    let nested_route = client
        .get(format!("http://{}/profiles", bridge.address))
        .send()
        .await
        .unwrap();
    assert_eq!(nested_route.status(), reqwest::StatusCode::OK);
    assert!(
        nested_route
            .text()
            .await
            .unwrap()
            .contains("<title>Mish</title>")
    );
    let missing_asset = client
        .get(format!("http://{}/assets/missing.js", bridge.address))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_asset.status(), reqwest::StatusCode::NOT_FOUND);

    let bootstrap_url = format!("http://{}/browser-bootstrap", bridge.address);
    let rejected_origin = client
        .post(&bootstrap_url)
        .header("Authorization", format!("Mish-Browser-Pin {nonce}"))
        .header("X-Mish-Browser-Proof", "b".repeat(64))
        .header("Origin", "https://attacker.example")
        .send()
        .await
        .unwrap();
    assert_eq!(rejected_origin.status(), reqwest::StatusCode::FORBIDDEN);

    let accepted = client
        .post(&bootstrap_url)
        .header("Authorization", format!("Mish-Browser-Pin {nonce}"))
        .header("X-Mish-Browser-Proof", "b".repeat(64))
        .header("Origin", format!("http://{}", bridge.address))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), reqwest::StatusCode::OK);
    assert_eq!(accepted.headers()["cache-control"], "no-store");
    let session_cookie = accepted.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert!(
        accepted.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly")
    );
    assert!(
        accepted.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("SameSite=Strict")
    );
    let payload: Value = serde_json::from_str(&accepted.text().await.unwrap()).unwrap();
    assert_eq!(payload["authToken"], TOKEN);
    assert_eq!(payload["rpcUrl"], format!("ws://{}/rpc", bridge.address));
    assert_eq!(payload["settingsSnapshot"]["adapterKind"], "rpc");
    assert_eq!(
        payload["settingsSnapshot"]["capabilities"]["nativeSidebarMaterial"],
        "unavailable"
    );
    assert_eq!(payload["localBackup"], false);
    assert_eq!(payload["supportBundleExport"], false);

    let replay = client
        .post(&bootstrap_url)
        .header("Authorization", format!("Mish-Browser-Pin {nonce}"))
        .header("X-Mish-Browser-Proof", "b".repeat(64))
        .header("Origin", format!("http://{}", bridge.address))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), reqwest::StatusCode::UNAUTHORIZED);

    let refreshed = client
        .post(&bootstrap_url)
        .header("Cookie", session_cookie)
        .header("Origin", format!("http://{}", bridge.address))
        .header("X-Mish-Browser-Proof", "b".repeat(64))
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), reqwest::StatusCode::OK);
    let refreshed_payload: Value = serde_json::from_str(&refreshed.text().await.unwrap()).unwrap();
    assert_eq!(refreshed_payload["authToken"], TOKEN);
    bridge.shutdown().await;
}

#[tokio::test]
async fn browser_client_pairs_with_a_short_lived_pin_and_port_scoped_proof() {
    let prompt = Arc::new(RecordingPairingPrompt::default());
    let mut bridge_config = config();
    bridge_config.browser_assets = Some(Arc::new(BrowserAssets));
    bridge_config.browser_pairing_prompt = Some(prompt.clone());
    bridge_config.settings_service = Some(settings_service());
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let origin = format!("http://{}", bridge.address);
    let client = reqwest::Client::new();

    let started = client
        .post(format!("{origin}/browser-pairing"))
        .header("Origin", &origin)
        .send()
        .await
        .unwrap();
    assert_eq!(started.status(), reqwest::StatusCode::OK);
    let challenge: Value = serde_json::from_str(&started.text().await.unwrap()).unwrap();
    let challenge_id = challenge["challengeId"].as_str().unwrap();
    assert_eq!(challenge_id.len(), 64);
    assert_eq!(challenge["expiresInSeconds"], 120);
    let pin = prompt.0.lock().unwrap().first().unwrap().clone();
    assert_eq!(pin.len(), 6);
    assert!(pin.bytes().all(|byte| byte.is_ascii_digit()));

    let proof = "c".repeat(64);
    let wrong_pin = if pin == "999999" { "000000" } else { "999999" };
    let wrong = client
        .post(format!("{origin}/browser-pairing/complete"))
        .header("Content-Type", "application/json")
        .header("Origin", &origin)
        .header("X-Mish-Browser-Proof", &proof)
        .body(json!({"challengeId": challenge_id, "pin": wrong_pin}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

    let accepted = client
        .post(format!("{origin}/browser-pairing/complete"))
        .header("Content-Type", "application/json")
        .header("Origin", &origin)
        .header("X-Mish-Browser-Proof", &proof)
        .body(json!({"challengeId": challenge_id, "pin": pin}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), reqwest::StatusCode::OK);
    let session_cookie = accepted.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert!(!session_cookie.contains(TOKEN));
    assert!(!session_cookie.contains(challenge_id));
    assert!(!session_cookie.contains(&pin));

    let missing_proof = client
        .post(format!("{origin}/browser-bootstrap"))
        .header("Cookie", &session_cookie)
        .header("Origin", &origin)
        .send()
        .await
        .unwrap();
    assert_eq!(missing_proof.status(), reqwest::StatusCode::UNAUTHORIZED);

    let refreshed = client
        .post(format!("{origin}/browser-bootstrap"))
        .header("Cookie", session_cookie)
        .header("Origin", &origin)
        .header("X-Mish-Browser-Proof", proof)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), reqwest::StatusCode::OK);
    bridge.shutdown().await;
}

#[tokio::test]
async fn browser_pairing_locks_after_five_failed_pin_attempts() {
    let prompt = Arc::new(RecordingPairingPrompt::default());
    let mut bridge_config = config();
    bridge_config.browser_assets = Some(Arc::new(BrowserAssets));
    bridge_config.browser_pairing_prompt = Some(prompt.clone());
    bridge_config.settings_service = Some(settings_service());
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let origin = format!("http://{}", bridge.address);
    let client = reqwest::Client::new();
    let started = client
        .post(format!("{origin}/browser-pairing"))
        .header("Origin", &origin)
        .send()
        .await
        .unwrap();
    let challenge: Value = serde_json::from_str(&started.text().await.unwrap()).unwrap();
    let challenge_id = challenge["challengeId"].as_str().unwrap();
    let pin = prompt.0.lock().unwrap().first().unwrap().clone();
    let wrong_pin = if pin == "999999" { "000000" } else { "999999" };

    for attempt in 1..=5 {
        let response = client
            .post(format!("{origin}/browser-pairing/complete"))
            .header("Content-Type", "application/json")
            .header("Origin", &origin)
            .header("X-Mish-Browser-Proof", "d".repeat(64))
            .body(json!({"challengeId": challenge_id, "pin": wrong_pin}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if attempt == 5 {
                reqwest::StatusCode::TOO_MANY_REQUESTS
            } else {
                reqwest::StatusCode::UNAUTHORIZED
            }
        );
    }

    let locked = client
        .post(format!("{origin}/browser-pairing"))
        .header("Origin", &origin)
        .send()
        .await
        .unwrap();
    assert_eq!(locked.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(prompt.0.lock().unwrap().len(), 1);
    bridge.shutdown().await;
}

#[tokio::test]
async fn rejects_unauthenticated_and_malformed_requests() {
    let bridge = start_loopback_server(config(), runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;

    let unauthenticated = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":1, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(unauthenticated["error"]["code"], -32001);

    let unauthenticated_events = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"events.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(unauthenticated_events["error"]["code"], -32001);

    let unauthenticated_diagnostics = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":3, "method":"diagnostics.getHistory", "params":{}}),
    )
    .await;
    assert_eq!(unauthenticated_diagnostics["error"]["code"], -32001);

    let unauthenticated_traffic_mutation = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"traffic.closeConnection",
            "params":{
                "authority":{"profileId":"local", "sequence":0, "sessionId":"session"},
                "connectionId":"connection"
            }
        }),
    )
    .await;
    assert_eq!(unauthenticated_traffic_mutation["error"]["code"], -32001);

    let unauthenticated_provider_mutation = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"profiles.updateProvider",
            "params":{
                "authority":{
                    "profileId":"profile",
                    "runtimeFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                },
                "providerId":"provider:private"
            }
        }),
    )
    .await;
    assert_eq!(unauthenticated_provider_mutation["error"]["code"], -32001);
    assert!(
        !unauthenticated_provider_mutation
            .to_string()
            .contains("provider:private")
    );

    let unauthenticated_patch_mutation = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"profiles.replacePatches",
            "params":{
                "authority":{
                    "artifactFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "profileId":"00000000-0000-4000-8000-000000000000",
                    "sourceRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                },
                "patches":[],
                "schemaVersion":1
            }
        }),
    )
    .await;
    assert_eq!(unauthenticated_patch_mutation["error"]["code"], -32001);

    ws.send(Message::Text("{".into())).await.unwrap();
    let Message::Text(response) = ws.next().await.unwrap().unwrap() else {
        panic!("expected text response")
    };
    let malformed: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(malformed["error"]["code"], -32700);
    bridge.shutdown().await;
}

#[tokio::test]
async fn settings_rpc_is_authenticated_bounded_and_reports_confirmed_privacy() {
    let mut bridge_config = config();
    bridge_config.settings_service = Some(settings_service());
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;

    let unauthenticated = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":1, "method":"settings.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(unauthenticated["error"]["code"], -32001);
    authenticate(&mut ws).await;

    let initial = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"settings.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(initial["result"]["adapterKind"], "rpc");
    assert_eq!(initial["result"]["privacy"]["loopbackOnly"], "confirmed");
    assert_eq!(initial["result"]["privacy"]["authenticated"], "confirmed");
    assert_eq!(initial["result"]["privacy"]["originValidated"], "confirmed");
    assert_eq!(initial["result"]["privacy"]["lanControl"], "unavailable");
    assert_eq!(
        initial["result"]["tunHelper"]["availability"],
        "unavailable"
    );
    assert!(initial["result"].get("authToken").is_none());

    let prompted = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":27, "method":"settings.setOnboardingWelcomeState",
            "params":{"action":"prompt"}
        }),
    )
    .await;
    assert!(
        prompted["result"]["preferences"]["onboarding"]["welcomeInvitation"]["promptedAt"]
            .is_number()
    );
    assert!(
        prompted["result"]["preferences"]["onboarding"]["welcomeInvitation"]["firstOpenedAt"]
            .is_null()
    );

    let opened = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":24, "method":"settings.setOnboardingWelcomeState",
            "params":{"action":"open"}
        }),
    )
    .await;
    assert!(
        opened["result"]["preferences"]["onboarding"]["welcomeInvitation"]["firstOpenedAt"]
            .is_number()
    );
    assert!(
        opened["result"]["preferences"]["onboarding"]["welcomeInvitation"]["completedAt"].is_null()
    );

    let dismissed = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":25, "method":"settings.setOnboardingWelcomeState",
            "params":{"action":"dismiss"}
        }),
    )
    .await;
    assert!(
        dismissed["result"]["preferences"]["onboarding"]["welcomeInvitation"]["lastDismissedAt"]
            .is_number()
    );
    assert!(
        dismissed["result"]["preferences"]["onboarding"]["welcomeInvitation"]["completedAt"]
            .is_null()
    );

    let completed = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":26, "method":"settings.setOnboardingWelcomeState",
            "params":{"action":"complete"}
        }),
    )
    .await;
    assert!(
        completed["result"]["preferences"]["onboarding"]["welcomeInvitation"]["completedAt"]
            .is_number()
    );

    let arbitrary_network_argument = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":20, "method":"settings.refreshNetworkDns",
            "params":{"interface":"en0", "dns":"private.example"}
        }),
    )
    .await;
    assert_eq!(arbitrary_network_argument["error"]["code"], -32602);
    assert!(
        !arbitrary_network_argument
            .to_string()
            .contains("private.example")
    );

    let network = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":23, "method":"settings.refreshNetworkDns", "params":{}
        }),
    )
    .await;
    assert_eq!(network["result"]["networkDns"]["phase"], "ready");
    assert_eq!(
        network["result"]["networkDns"]["source"],
        "macos-system-configuration"
    );
    assert_eq!(
        network["result"]["networkDns"]["interfaces"][0]["interface"],
        "en0"
    );
    assert_eq!(network["result"]["networkDns"]["dns"]["resolverCount"], 1);

    let arbitrary_helper_argument = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":21, "method":"settings.installTunHelper",
            "params":{"path":"/private/helper"}
        }),
    )
    .await;
    assert_eq!(arbitrary_helper_argument["error"]["code"], -32602);
    assert!(
        !arbitrary_helper_argument
            .to_string()
            .contains("/private/helper")
    );

    let unavailable_helper = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":22, "method":"settings.installTunHelper", "params":{}
        }),
    )
    .await;
    assert_eq!(unavailable_helper["error"]["code"], -32020);

    let appearance = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"settings.setAppearance",
            "params":{"appearance":"dark"}
        }),
    )
    .await;
    assert_eq!(appearance["result"]["preferences"]["appearance"], "dark");

    let window_surface = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":4, "method":"settings.setWindowSurface",
            "params":{"surface":"opaque"}
        }),
    )
    .await;
    assert_eq!(
        window_surface["result"]["preferences"]["windowSurface"],
        "opaque"
    );

    let startup = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":5, "method":"settings.setStartup",
            "params":{"startup":{"launchAtLogin":true,"launchProxyWhenMishLaunches":false,"loginLaunchBehavior":"background"}}
        }),
    )
    .await;
    assert_eq!(startup["result"]["startupRegistration"]["phase"], "applied");
    assert_eq!(startup["result"]["startupRegistration"]["observed"], true);

    let proxy_launch = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":23, "method":"settings.setLaunchProxyWhenMishLaunches",
            "params":{"launchProxyWhenMishLaunches":true}
        }),
    )
    .await;
    assert_eq!(
        proxy_launch["result"]["preferences"]["startup"]["launchProxyWhenMishLaunches"],
        true
    );
    assert_eq!(
        proxy_launch["result"]["startupRegistration"]["observed"],
        true
    );

    let managed_ports = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":28, "method":"settings.setManagedPorts",
            "params":{"managedPorts":{"controller":19090,"proxy":17890}}
        }),
    )
    .await;
    assert_eq!(
        managed_ports["result"]["preferences"]["managedPorts"],
        json!({"controller":19090,"proxy":17890})
    );

    let available_ports = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":29, "method":"settings.findManagedPorts", "params":{}}),
    )
    .await;
    assert!(available_ports["result"]["preferences"]["managedPorts"]["controller"].is_number());
    assert_ne!(
        available_ports["result"]["preferences"]["managedPorts"]["controller"],
        available_ports["result"]["preferences"]["managedPorts"]["proxy"]
    );

    let close_behavior = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":6, "method":"settings.setWindowCloseBehavior",
            "params":{"behavior":"quit"}
        }),
    )
    .await;
    assert_eq!(
        close_behavior["result"]["preferences"]["windowCloseBehavior"],
        "quit"
    );
    assert_eq!(
        close_behavior["result"]["preferences"]["startup"]["loginLaunchBehavior"],
        "background"
    );

    for (id, method, params) in [
        (
            7,
            "settings.setAppearance",
            json!({"appearance":"dark", "path":"/tmp/secret"}),
        ),
        (
            8,
            "settings.setLanguage",
            json!({"language":"zh", "command":"open"}),
        ),
        (
            9,
            "settings.setStartup",
            json!({"startup":{"launchAtLogin":true,"launchProxyWhenMishLaunches":false,"loginLaunchBehavior":"background","configuration":{}}}),
        ),
        (
            10,
            "settings.setWindowCloseBehavior",
            json!({"behavior":"quit","path":"/tmp/secret"}),
        ),
        (
            11,
            "settings.setWindowSurface",
            json!({"surface":"opaque","blur":24}),
        ),
        (
            12,
            "settings.setOnboardingWelcomeState",
            json!({"action":"complete","command":"start-core"}),
        ),
    ] {
        let rejected = request(
            &mut ws,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .await;
        assert_eq!(rejected["error"]["code"], -32602);
    }

    let ambiguous_ports = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":13, "method":"settings.setManagedPorts",
            "params":{"managedPorts":{"controller":17890,"proxy":17890}}
        }),
    )
    .await;
    assert_eq!(ambiguous_ports["error"]["code"], -32041);

    let events = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":14, "method":"events.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(
        events["result"]["events"][0]["notificationKind"],
        "settings-failure"
    );

    bridge.shutdown().await;
}

#[tokio::test]
async fn authenticates_and_serves_contract_compatible_status() {
    let bridge = start_loopback_server(config(), runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let info = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"bridge.getInfo", "params":{}}),
    )
    .await;
    assert_eq!(info["result"]["protocolVersion"], 18);
    assert_eq!(
        info["result"]["statusCommands"],
        json!({"group": false, "groupDelay": false, "routing": false, "services": false})
    );
    assert_eq!(
        info["result"]["trafficCommands"],
        json!({"closeAllActive": false, "closeConnection": false})
    );
    assert_eq!(info["result"]["bridgeVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["result"]["coreConfigured"], false);

    let snapshot = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":3, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(snapshot["result"]["adapterKind"], "rpc");
    assert_eq!(snapshot["result"]["runtime"]["phase"], "inactive");
    assert_eq!(
        snapshot["result"]["runtime"]["captureSelection"],
        json!({"systemProxy": false, "tun": false})
    );

    let traffic = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":4, "method":"traffic.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(traffic["result"]["adapterKind"], "rpc");
    assert_eq!(traffic["result"]["phase"], "unavailable");
    assert_eq!(traffic["result"]["activeConnections"], json!([]));
    assert_eq!(traffic["result"]["rules"], json!([]));

    let subscription = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":5, "method":"traffic.subscribe", "params":{}}),
    )
    .await;
    assert_eq!(subscription["result"]["snapshot"]["phase"], "unavailable");
    let subscription_id = subscription["result"]["subscriptionId"].as_str().unwrap();
    assert!(subscription_id.starts_with("traffic-"));

    let invalid = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":6, "method":"traffic.getSnapshot", "params":{"extra":true}}),
    )
    .await;
    assert_eq!(invalid["error"]["code"], -32602);

    let events = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":7, "method":"events.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(events["result"]["adapterKind"], "rpc");
    assert_eq!(events["result"]["phase"], "unavailable");
    assert_eq!(events["result"]["events"], json!([]));
    assert_eq!(
        events["result"]["sourceStatuses"].as_array().unwrap().len(),
        4
    );

    let events_subscription = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":8, "method":"events.subscribe", "params":{}}),
    )
    .await;
    assert_eq!(
        events_subscription["result"]["snapshot"]["phase"],
        "unavailable"
    );
    assert!(
        events_subscription["result"]["subscriptionId"]
            .as_str()
            .unwrap()
            .starts_with("events-")
    );

    let invalid_events = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":9, "method":"events.getSnapshot", "params":{"extra":true}}),
    )
    .await;
    assert_eq!(invalid_events["error"]["code"], -32602);

    let diagnostic_history = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":10, "method":"diagnostics.getHistory", "params":{}}),
    )
    .await;
    assert_eq!(diagnostic_history["result"]["adapterKind"], "rpc");
    assert_eq!(diagnostic_history["result"]["runs"], json!([]));

    let arbitrary_probe = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":11,
            "method":"diagnostics.startRun",
            "params":{"url":"https://secret.invalid", "timeout":999999}
        }),
    )
    .await;
    assert_eq!(arbitrary_probe["error"]["code"], -32602);

    let started = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":12, "method":"diagnostics.startRun", "params":{}}),
    )
    .await;
    let run_id = started["result"]["activeRunId"]
        .as_str()
        .expect("diagnostic run ID");
    assert_eq!(started["result"]["runs"][0]["status"], "running");
    let cancelled = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":13,
            "method":"diagnostics.cancelRun",
            "params":{"runId":run_id}
        }),
    )
    .await;
    assert_eq!(cancelled["result"]["activeRunId"], Value::Null);
    assert_eq!(cancelled["result"]["runs"][0]["status"], "cancelled");

    for (id, method, params) in [
        (14, "diagnostics.previewSupportBundle", json!({})),
        (
            15,
            "diagnostics.saveSupportBundle",
            json!({"path":"/synthetic/private/bundle.json", "contents":"secret"}),
        ),
    ] {
        let unavailable_export = request(
            &mut ws,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .await;
        assert_eq!(unavailable_export["error"]["code"], -32601);
    }

    let unavailable = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":16, "method":"core.start", "params":{}}),
    )
    .await;
    assert_eq!(unavailable["error"]["code"], -32010);
    bridge.shutdown().await;
}

#[tokio::test]
async fn service_probes_remain_available_while_core_is_stopped() {
    let mut bridge_config = config();
    bridge_config.service_probes = Some(ServiceProbeConfig { state_path: None });
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let info = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"bridge.getInfo", "params":{}}),
    )
    .await;
    assert_eq!(info["result"]["statusCommands"]["services"], true);

    let snapshot = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":3, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(snapshot["result"]["runtime"]["phase"], "inactive");
    assert_eq!(
        snapshot["result"]["serviceProbePolicy"]["intervalSeconds"],
        5
    );
    assert_eq!(snapshot["result"]["services"].as_array().unwrap().len(), 6);
    assert_eq!(
        snapshot["result"]["probeResults"].as_array().unwrap().len(),
        6
    );
    assert!(
        snapshot["result"]["probeResults"]
            .as_array()
            .unwrap()
            .iter()
            .all(|result| result["routeTarget"] == "direct")
    );

    let updated = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"status.setServiceProbeInterval",
            "params":{"intervalSeconds":10}
        }),
    )
    .await;
    assert_eq!(
        updated["result"]["serviceProbePolicy"]["intervalSeconds"],
        10
    );

    let rejected = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"status.upsertServiceMonitor",
            "params":{"draft":{
                "icon":"https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Map/globe-fill.svg",
                "label":"Local metadata",
                "url":"http://169.254.169.254/latest/meta-data"
            }}
        }),
    )
    .await;
    assert_eq!(rejected["error"]["code"], -32602);

    let missing_probe = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":6,
            "method":"status.testServiceMonitor",
            "params":{"monitorId":"missing-service"}
        }),
    )
    .await;
    assert_eq!(missing_probe["error"]["code"], -32004);

    bridge.shutdown().await;
}

#[tokio::test]
async fn authenticated_profile_rpc_exposes_only_safe_operations_and_redacted_errors() {
    let root = env::temp_dir().join(format!("mish-bridge-profiles-{}", uuid::Uuid::new_v4()));
    let mut bridge_config = config();
    bridge_config.profile_service = Some(Arc::new(
        ReqwestHttpsSourceReader::profile_service(root.clone()).unwrap(),
    ));
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let snapshot = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"profiles.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(snapshot["result"]["adapterKind"], "rpc");
    assert_eq!(
        snapshot["result"]["capabilities"]["activation"],
        "unavailable"
    );
    assert_eq!(
        snapshot["result"]["capabilities"]["localFileImport"],
        "permission-required"
    );
    assert_eq!(
        snapshot["result"]["capabilities"]["scheduling"],
        "unavailable"
    );
    assert_eq!(snapshot["result"]["profiles"], json!([]));

    const PRIVATE_PATH: &str = "/private/hidden/profile.yaml";
    let local_rpc = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"profiles.preflightLocal",
            "params":{"path":PRIVATE_PATH}
        }),
    )
    .await;
    assert_eq!(local_rpc["error"]["code"], -32601);
    assert!(!local_rpc.to_string().contains(PRIVATE_PATH));

    const RAW_URL: &str =
        "https://user:private-password@profiles.example/config.yaml?token=private-token";
    let invalid_remote = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":4, "method":"profiles.preflightHttps",
            "params":{"url":RAW_URL}
        }),
    )
    .await;
    assert_eq!(invalid_remote["error"]["code"], -32040);
    let error_json = invalid_remote.to_string();
    assert!(!error_json.contains("private-password"));
    assert!(!error_json.contains("private-token"));

    const RAW_CONFIG: &str = "secret: private-runtime-secret";
    let arbitrary_config = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":5, "method":"profiles.save",
            "params":{
                "previewId":"preview-only",
                "configBytes":RAW_CONFIG,
                "path":"/private/runtime.yaml"
            }
        }),
    )
    .await;
    assert_eq!(arbitrary_config["error"]["code"], -32602);
    assert!(
        !arbitrary_config
            .to_string()
            .contains("private-runtime-secret")
    );

    const PRIVATE_PROVIDER_ID: &str = "provider:private-token";
    let invalid_provider_authority = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":6, "method":"profiles.updateProvider",
            "params":{
                "authority":{"profileId":"profile", "runtimeFingerprint":"not-a-fingerprint"},
                "providerId":PRIVATE_PROVIDER_ID
            }
        }),
    )
    .await;
    assert_eq!(invalid_provider_authority["error"]["code"], -32020);
    assert!(
        !invalid_provider_authority
            .to_string()
            .contains(PRIVATE_PROVIDER_ID)
    );
    assert!(
        !arbitrary_config
            .to_string()
            .contains("/private/runtime.yaml")
    );

    const PRIVATE_PATCH_VALUE: &str = "private.example";
    let arbitrary_patch = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":7, "method":"profiles.replacePatches",
            "params":{
                "authority":{
                    "artifactFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "profileId":"00000000-0000-4000-8000-000000000000",
                    "sourceRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                },
                "patches":[{
                    "enabled":true,
                    "id":"00000000-0000-4000-8000-000000000001",
                    "operation":{
                        "kind":"rule-insert",
                        "position":"prefix",
                        "rawYaml":PRIVATE_PATCH_VALUE
                    }
                }],
                "schemaVersion":1
            }
        }),
    )
    .await;
    assert_eq!(arbitrary_patch["error"]["code"], -32602);
    assert!(!arbitrary_patch.to_string().contains(PRIVATE_PATCH_VALUE));

    bridge.shutdown().await;
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn authenticated_profile_file_action_opens_the_shared_directory() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("profiles");
    let platform = Arc::new(RecordingProfileFilePlatform::default());
    let actions = Arc::new(ProfileFileActions::new(directory.clone(), platform.clone()));
    let mut bridge_config = config();
    bridge_config.profile_file_actions = Some(actions);
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let opened = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"profiles.openDirectory", "params":{}}),
    )
    .await;
    assert_eq!(opened["result"], true);

    assert_eq!(platform.opened.lock().unwrap().as_slice(), &[directory]);

    bridge.shutdown().await;
}

#[tokio::test]
async fn authenticated_profile_file_action_creates_and_imports_a_basic_profile() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("profiles");
    let platform = Arc::new(RecordingProfileFilePlatform::default());
    let actions = Arc::new(ProfileFileActions::new(directory.clone(), platform));
    let service =
        Arc::new(ReqwestHttpsSourceReader::profile_service(root.path().to_path_buf()).unwrap());
    let mut bridge_config = config();
    bridge_config.profile_file_actions = Some(actions);
    bridge_config.profile_service = Some(service);
    let bridge = start_loopback_server(bridge_config, runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let created = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"profiles.create",
            "params":{"fileName":"new-profile.yaml"}
        }),
    )
    .await;

    assert_eq!(
        created["result"]["profiles"][0]["fileName"],
        "new-profile.yaml"
    );
    assert_eq!(
        fs::read_to_string(directory.join("new-profile.yaml")).unwrap(),
        "mode: rule\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n"
    );

    bridge.shutdown().await;
}

#[tokio::test]
async fn profile_rpc_reports_safe_stopped_startup_and_a_missing_managed_binary() {
    let root = env::temp_dir().join(format!(
        "mish-bridge-missing-binary-{}",
        uuid::Uuid::new_v4()
    ));
    let profile_service =
        Arc::new(ReqwestHttpsSourceReader::profile_service(root.join("profiles")).unwrap());
    let safe_runtime = runtime(no_core());
    let runtime_host = DesktopRuntimeHost::new(safe_runtime.clone());
    let activation = Arc::new(ProfileActivationCoordinator::new(
        profile_service.clone(),
        Arc::new(MihomoActivationManager::new(
            ManagedMihomoResolver::development(
                root.join("explicitly-unavailable-mihomo"),
                root.join("runtime"),
            ),
            ActivationTiming::default(),
        )),
        runtime_host.clone(),
        safe_runtime,
        || ManagedRuntimePolicy::new(SocketAddr::from((Ipv4Addr::LOCALHOST, 1)), "unused"),
    ));
    let mut bridge_config = config();
    bridge_config.profile_activation = Some(activation);
    bridge_config.profile_service = Some(profile_service);
    let bridge = start_loopback_server_with_runtime_host(bridge_config, runtime_host)
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let snapshot = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"profiles.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(snapshot["result"]["activation"]["phase"], "idle");
    assert_eq!(
        snapshot["result"]["activation"]["startupPolicy"],
        "safe-stopped"
    );
    assert_eq!(
        snapshot["result"]["activation"]["availability"],
        "missing-binary"
    );
    assert_eq!(
        snapshot["result"]["capabilities"]["activation"],
        "unavailable"
    );

    const PRIVATE_PROVIDER_ID: &str = "provider:private-token";
    let invalid_provider_authority = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"profiles.updateProvider",
            "params":{
                "authority":{"profileId":"profile", "runtimeFingerprint":"not-a-fingerprint"},
                "providerId":PRIVATE_PROVIDER_ID
            }
        }),
    )
    .await;
    assert_eq!(invalid_provider_authority["error"]["code"], -32602);
    assert!(
        !invalid_provider_authority
            .to_string()
            .contains(PRIVATE_PROVIDER_ID)
    );

    let rejected = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":4, "method":"profiles.activate",
            "params":{"commandId":uuid::Uuid::new_v4().to_string(), "profileId":uuid::Uuid::new_v4().to_string()}
        }),
    )
    .await;
    assert_eq!(rejected["error"]["code"], -32020);
    assert!(!rejected.to_string().contains(root.to_str().unwrap()));

    bridge.shutdown().await;
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn rejects_all_network_changing_status_commands_without_fake_success() {
    let bridge = start_loopback_server(config(), runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let before = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    for (id, method, params) in [
        (3, "status.setRoutingMode", json!({"mode": "global"})),
        (
            4,
            "status.setCapture",
            json!({"active": true, "selection": {"systemProxy": true, "tun": true}}),
        ),
        (
            5,
            "status.selectGroupChild",
            json!({"groupId": "group:synthetic", "childId": "proxy:synthetic"}),
        ),
    ] {
        let response = request(
            &mut ws,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .await;
        assert_eq!(
            response["error"]["code"],
            if method == "status.setCapture" {
                json!(-32050)
            } else {
                json!(-32020)
            }
        );
        assert!(response.get("result").is_none());
    }

    for (id, method, params) in [
        (
            7,
            "traffic.closeConnection",
            json!({
                "authority":{"profileId":"local", "sequence":0, "sessionId":"session"},
                "connectionId": "fixture"
            }),
        ),
        (
            8,
            "traffic.closeAllActive",
            json!({"authority":{"profileId":"local", "sequence":0, "sessionId":"session"}}),
        ),
    ] {
        let response = request(
            &mut ws,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .await;
        assert_eq!(response["result"]["status"], "failure");
        assert_eq!(response["result"]["failure"], "unsupported");
        assert_eq!(response["result"]["snapshot"]["phase"], "unavailable");
    }

    let after = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":6, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(after["result"], before["result"]);
    bridge.shutdown().await;
}

#[tokio::test]
async fn authenticated_capture_rpc_returns_only_confirmed_reconciled_state() {
    let bridge = start_loopback_server(config(), capture_runtime())
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let before = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(before["result"]["capabilities"]["systemProxy"], "supported");
    assert_eq!(before["result"]["capabilities"]["tun"], "unavailable");
    assert_eq!(before["result"]["runtime"]["systemProxy"]["phase"], "off");

    let enabled = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"status.setCapture",
            "params":{"active":true,"selection":{"systemProxy":true,"tun":false}}
        }),
    )
    .await;
    assert!(enabled.get("error").is_none());
    assert_eq!(enabled["result"]["runtime"]["systemProxyEnabled"], true);
    assert_eq!(
        enabled["result"]["runtime"]["systemProxy"]["phase"],
        "applied"
    );
    assert_eq!(
        enabled["result"]["runtime"]["systemProxy"]["observed"],
        "mish"
    );

    let tun = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":4, "method":"status.setCapture",
            "params":{"active":true,"selection":{"systemProxy":true,"tun":true}}
        }),
    )
    .await;
    assert_eq!(tun["error"]["code"], -32050);
    assert_eq!(tun["error"]["data"]["kind"], "capability-unavailable");
    assert!(tun.get("result").is_none());
    let after_rejected_tun = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":5, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(
        after_rejected_tun["result"]["runtime"]["systemProxy"]["phase"],
        "applied"
    );
    assert_eq!(
        after_rejected_tun["result"]["runtime"]["captureSelection"]["tun"],
        false
    );
    bridge.shutdown().await;
}

#[tokio::test]
async fn capture_pending_is_shared_and_rejects_a_second_client_command() {
    let (runtime, platform) = slow_capture_runtime_parts();
    let bridge = start_loopback_server(config(), runtime).await.unwrap();
    let mut first = socket(bridge.address).await;
    let mut second = socket(bridge.address).await;
    authenticate(&mut first).await;
    authenticate(&mut second).await;
    let first_subscription = request(
        &mut first,
        json!({"jsonrpc":"2.0","id":2,"method":"status.subscribe","params":{}}),
    )
    .await;
    let second_subscription = request(
        &mut second,
        json!({"jsonrpc":"2.0","id":2,"method":"status.subscribe","params":{}}),
    )
    .await;
    assert!(first_subscription["result"]["subscriptionId"].is_string());
    assert!(second_subscription["result"]["subscriptionId"].is_string());

    first
        .send(Message::Text(
            json!({
                "jsonrpc":"2.0", "id":3, "method":"status.setCapture",
                "params":{"active":true,"selection":{"systemProxy":true,"tun":false}}
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    platform.apply_started.notified().await;

    for socket in [&mut first, &mut second] {
        let Message::Text(message) = socket.next().await.unwrap().unwrap() else {
            panic!("expected pending status notification")
        };
        let notification: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(
            notification["params"]["snapshot"]["runtime"]["systemProxy"]["phase"],
            "pending"
        );
    }

    let duplicate = request(
        &mut second,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"status.setCapture",
            "params":{"active":false,"selection":{"systemProxy":true,"tun":false}}
        }),
    )
    .await;
    assert_eq!(duplicate["error"]["code"], -32050);
    assert_eq!(duplicate["error"]["data"]["kind"], "runtime-transition");

    platform.apply_release.notify_one();
    let mut first_applied = false;
    while !first_applied {
        let Message::Text(message) = first.next().await.unwrap().unwrap() else {
            continue;
        };
        let value: Value = serde_json::from_str(&message).unwrap();
        first_applied = value["params"]["snapshot"]["runtime"]["systemProxy"]["phase"] == "applied";
    }
    let applied = request(
        &mut second,
        json!({"jsonrpc":"2.0","id":4,"method":"status.getSnapshot","params":{}}),
    )
    .await;
    let applied_phase = if applied["method"] == "status.snapshot" {
        &applied["params"]["snapshot"]["runtime"]["systemProxy"]["phase"]
    } else {
        &applied["result"]["runtime"]["systemProxy"]["phase"]
    };
    assert_eq!(applied_phase, "applied");
    drop(first);
    drop(second);
    drop(bridge);
}

#[tokio::test]
async fn local_proxy_rpc_tests_the_listener_without_changing_system_proxy_state() {
    let (runtime, platform) = capture_runtime_parts();
    let prior = platform.0.lock().unwrap().clone();
    let bridge = start_loopback_server(config(), runtime).await.unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let tested = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"status.testLocalProxy", "params":{}
        }),
    )
    .await;

    assert_eq!(
        tested["result"],
        json!({"host":"127.0.0.1", "phase":"ready", "port":7890})
    );
    assert_eq!(*platform.0.lock().unwrap(), prior);

    let arbitrary_target = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"status.testLocalProxy",
            "params":{"host":"192.168.1.1", "port":8080}
        }),
    )
    .await;
    assert_eq!(arbitrary_target["error"]["code"], -32602);
    assert_eq!(*platform.0.lock().unwrap(), prior);

    let snapshot = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":4, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(snapshot["result"]["runtime"]["systemProxy"]["phase"], "off");
    assert_eq!(snapshot["result"]["runtime"]["systemProxyEnabled"], false);
    bridge.shutdown().await;
}

#[tokio::test]
async fn local_proxy_rpc_rejects_an_external_listener_not_owned_by_the_current_runtime() {
    let platform = Arc::new(MemoryCapturePlatform(std::sync::Mutex::new(
        NetworkServiceProxyState {
            auto_discovery_enabled: false,
            http: mish_runtime::ManualProxyState::disabled(),
            https: mish_runtime::ManualProxyState::disabled(),
            pac_enabled: false,
            pac_url: "(null)".into(),
            service_id: "external-listener-fixture-service".into(),
            socks: mish_runtime::ManualProxyState::disabled(),
        },
    )));
    let prior = platform.0.lock().unwrap().clone();
    let capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        Arc::new(MemoryCaptureJournal::default()),
        LoopbackProxyEndpoint::managed(),
    ));
    let runtime = MishRuntime::with_capture(Arc::new(RunningCoreWithoutManagedListener), capture);
    let bridge = start_loopback_server(config(), runtime).await.unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let tested = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"status.testLocalProxy", "params":{}
        }),
    )
    .await;

    assert_eq!(
        tested["result"],
        json!({"host":"127.0.0.1", "phase":"listener-unavailable", "port":7890})
    );
    assert_eq!(*platform.0.lock().unwrap(), prior);
    bridge.shutdown().await;
}

#[tokio::test]
async fn capture_recovery_rpc_exposes_drift_and_honors_leave_as_is() {
    let (runtime, platform) = capture_runtime_parts();
    let bridge = start_loopback_server(config(), runtime.clone())
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;
    let subscription = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"status.subscribe", "params":{}}),
    )
    .await;
    let subscription_id = subscription["result"]["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let enabled = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"status.setCapture",
            "params":{"active":true,"selection":{"systemProxy":true,"tun":false}}
        }),
    )
    .await;
    assert_eq!(
        enabled["result"]["runtime"]["systemProxy"]["phase"],
        "applied"
    );
    let Message::Text(pending_notification) = ws.next().await.unwrap().unwrap() else {
        panic!("expected pending status notification")
    };
    let pending_notification: Value = serde_json::from_str(&pending_notification).unwrap();
    assert_eq!(
        pending_notification["params"]["subscriptionId"],
        subscription_id
    );
    assert_eq!(
        pending_notification["params"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "pending"
    );
    let Message::Text(applied_notification) = ws.next().await.unwrap().unwrap() else {
        panic!("expected applied status notification")
    };
    let applied_notification: Value = serde_json::from_str(&applied_notification).unwrap();
    assert_eq!(
        applied_notification["params"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "applied"
    );
    let external = NetworkServiceProxyState {
        http: mish_runtime::ManualProxyState {
            authenticated: false,
            enabled: true,
            host: "external.rpc-fixture.invalid".into(),
            port: 3128,
        },
        ..platform.0.lock().unwrap().clone()
    };
    *platform.0.lock().unwrap() = external.clone();
    runtime
        .audit_capture(mish_runtime::CaptureAuditReason::NetworkChanged)
        .await
        .unwrap();

    let Message::Text(drift_notification) = ws.next().await.unwrap().unwrap() else {
        panic!("expected drift status notification")
    };
    let drift_notification: Value = serde_json::from_str(&drift_notification).unwrap();
    assert_eq!(
        drift_notification["params"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "drift"
    );
    assert!(
        !drift_notification
            .to_string()
            .contains("external.rpc-fixture.invalid")
    );

    let drift = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":4, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(drift["result"]["runtime"]["systemProxy"]["phase"], "drift");
    assert_eq!(
        drift["result"]["runtime"]["systemProxy"]["recoveryActions"],
        json!(["repair", "leave-as-is"])
    );

    let recovered = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":5, "method":"status.recoverSystemProxy",
            "params":{"action":"leave-as-is"}
        }),
    )
    .await;
    assert_eq!(
        recovered["result"]["runtime"]["systemProxy"]["phase"],
        "off"
    );
    assert_eq!(*platform.0.lock().unwrap(), external);
    assert!(
        !recovered
            .to_string()
            .contains("external.rpc-fixture.invalid")
    );
    bridge.shutdown().await;
}

#[tokio::test]
async fn rejects_an_untrusted_websocket_origin() {
    let bridge = start_loopback_server(config(), runtime(no_core()))
        .await
        .unwrap();
    let mut request = format!("ws://{}/rpc", bridge.address)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://attacker.example".parse().unwrap());
    let error = tokio_tungstenite::connect_async(request).await.unwrap_err();
    assert!(error.to_string().contains("403"));
    bridge.shutdown().await;
}

#[tokio::test]
async fn manages_an_explicit_mihomo_process_and_stops_it_during_shutdown() {
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-mihomo.sh");
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let bridge = start_loopback_server(
        config(),
        runtime(DesktopMihomoProcessConfig {
            binary: Some(binary),
            config_directory: Some(directory),
            config_file: None,
        }),
    )
    .await
    .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let subscription = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"status.subscribe", "params":{}}),
    )
    .await;
    assert_eq!(
        subscription["result"]["snapshot"]["runtime"]["phase"],
        "inactive"
    );
    let subscription_id = subscription["result"]["subscriptionId"]
        .as_str()
        .unwrap()
        .to_owned();

    let running = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":3, "method":"core.start", "params":{}}),
    )
    .await;
    assert_eq!(running["result"]["phase"], "running");
    assert_eq!(running["result"]["version"], "Mihomo Meta v-test");
    assert!(running["result"]["pid"].as_u64().is_some());

    let Message::Text(notification) = ws.next().await.unwrap().unwrap() else {
        panic!("expected status notification")
    };
    let notification: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(notification["method"], "status.snapshot");
    assert_eq!(notification["params"]["subscriptionId"], subscription_id);
    assert_eq!(
        notification["params"]["snapshot"]["runtime"]["phase"],
        "healthy"
    );

    let stopped = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":4, "method":"core.stop", "params":{}}),
    )
    .await;
    assert_eq!(stopped["result"]["phase"], "stopped");
    bridge.shutdown().await;
}

#[tokio::test]
async fn subscription_snapshot_is_a_barrier_against_older_lifecycle_events() {
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-mihomo.sh");
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let bridge = start_loopback_server(
        config(),
        runtime(DesktopMihomoProcessConfig {
            binary: Some(binary),
            config_directory: Some(directory),
            config_file: None,
        }),
    )
    .await
    .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    let running = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"core.start", "params":{}}),
    )
    .await;
    assert_eq!(running["result"]["phase"], "running");
    let stopped = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":3, "method":"core.stop", "params":{}}),
    )
    .await;
    assert_eq!(stopped["result"]["phase"], "stopped");

    let subscription = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":4, "method":"status.subscribe", "params":{}}),
    )
    .await;
    assert_eq!(
        subscription["result"]["snapshot"]["runtime"]["phase"],
        "inactive"
    );
    assert!(
        timeout(Duration::from_millis(150), ws.next())
            .await
            .is_err(),
        "pre-subscription lifecycle events must not be replayed after the snapshot barrier"
    );
    bridge.shutdown().await;
}

#[tokio::test]
async fn publishes_status_when_the_managed_process_exits_without_a_stop_command() {
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-mihomo.sh");
    let config_file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/unexpected-exit.yaml");
    let bridge = start_loopback_server(
        config(),
        runtime(DesktopMihomoProcessConfig {
            binary: Some(binary),
            config_directory: None,
            config_file: Some(config_file),
        }),
    )
    .await
    .unwrap();
    let mut ws = socket(bridge.address).await;
    authenticate(&mut ws).await;

    request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"status.subscribe", "params":{}}),
    )
    .await;
    let running = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":3, "method":"core.start", "params":{}}),
    )
    .await;
    assert!(running["result"]["pid"].as_u64().is_some());

    let Message::Text(running_notification) = ws.next().await.unwrap().unwrap() else {
        panic!("expected running status notification")
    };
    let running_notification: Value = serde_json::from_str(&running_notification).unwrap();
    assert_eq!(
        running_notification["params"]["snapshot"]["runtime"]["phase"],
        "healthy"
    );

    let Message::Text(exit_notification) = timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("unexpected exit was not published")
        .unwrap()
        .unwrap()
    else {
        panic!("expected exit status notification")
    };
    let exit_notification: Value = serde_json::from_str(&exit_notification).unwrap();
    assert_eq!(
        exit_notification["params"]["snapshot"]["runtime"]["phase"],
        "error"
    );

    let failed = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":4, "method":"core.getStatus", "params":{}}),
    )
    .await;
    assert_eq!(failed["result"]["phase"], "failed");
    assert_eq!(failed["result"]["pid"], Value::Null);
    bridge.shutdown().await;
}

#[tokio::test]
async fn refuses_non_loopback_binding() {
    let mut unsafe_config = config();
    unsafe_config.bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
    let error = match start_loopback_server(unsafe_config, runtime(no_core())).await {
        Ok(bridge) => {
            bridge.shutdown().await;
            panic!("unsafe binding was accepted")
        }
        Err(error) => error,
    };
    assert!(error.contains("loopback"));
}

#[tokio::test]
async fn shutdown_closes_an_active_rpc_socket_before_reporting_confirmation() {
    let bridge = start_loopback_server(config(), runtime(no_core()))
        .await
        .unwrap();
    let mut ws = socket(bridge.address).await;

    let outcome = timeout(Duration::from_secs(1), bridge.shutdown())
        .await
        .expect("bridge shutdown exceeded the active-socket bound");
    let BridgeShutdownOutcome::Confirmed(report) = outcome else {
        panic!("bridge shutdown was not confirmed")
    };
    assert!(report.permits_exit());
    assert!(matches!(
        timeout(Duration::from_secs(1), ws.next()).await,
        Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_)))
    ));
}
