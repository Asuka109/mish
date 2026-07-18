use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use axum::{
    Json, Router,
    extract::{Request, State, WebSocketUpgrade, ws::Message as AxumMessage},
    http::{StatusCode, header::AUTHORIZATION},
    middleware::{Next, from_fn},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt, future::BoxFuture, future::ready};
use mish_bridge::{
    ControllerObservationConfig, ControllerStatusSource, ControllerStatusSourceError,
    LoopbackServerConfig, ProfileMappingContext, compose_desktop_runtime, start_loopback_server,
};
use mish_runtime::{CoreError, CorePhase, CoreRuntime, CoreStatus, MishRuntime, StatusAdapterKind};
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    sync::{RwLock, oneshot, watch},
    task::JoinHandle,
    time::{Duration, Instant, sleep, timeout},
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use url::Url;

const ORIGIN: &str = "http://controller-source.test";
const TOKEN: &str = "controller-source-token";
const CONTROLLER_SECRET: &str = "fake-controller-secret";

struct TestLifecycle {
    stopped: AtomicBool,
}

impl TestLifecycle {
    fn status(&self) -> CoreStatus {
        CoreStatus {
            error: None,
            phase: if self.stopped.load(Ordering::Acquire) {
                CorePhase::Stopped
            } else {
                CorePhase::Running
            },
            pid: Some(42),
            version: Some("Mihomo Meta v1.19.29".into()),
        }
    }
}

impl CoreRuntime for TestLifecycle {
    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(TestLifecycle::status(self)))
    }

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        self.stopped.store(false, Ordering::Release);
        Box::pin(ready(Ok(TestLifecycle::status(self))))
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        self.stopped.store(true, Ordering::Release);
        Box::pin(ready(Ok(TestLifecycle::status(self))))
    }
}

struct FakeControllerState {
    active_streams: AtomicUsize,
    available: watch::Sender<bool>,
    configs: RwLock<Value>,
    connections: RwLock<Value>,
    memory: watch::Sender<Value>,
    proxies: RwLock<Value>,
    rules: RwLock<Value>,
    traffic: watch::Sender<Value>,
    version: RwLock<String>,
}

struct FakeController {
    address: SocketAddr,
    join: JoinHandle<()>,
    shutdown: Option<oneshot::Sender<()>>,
    state: Arc<FakeControllerState>,
}

impl FakeController {
    async fn start() -> Self {
        let (available, _) = watch::channel(true);
        let (traffic, _) = watch::channel(traffic(3, 4, 30, 40));
        let (memory, _) = watch::channel(json!({"inuse": 4096, "oslimit": 8192}));
        let state = Arc::new(FakeControllerState {
            active_streams: AtomicUsize::new(0),
            available,
            configs: RwLock::new(configs("rule")),
            connections: RwLock::new(connections("connection-a")),
            memory,
            proxies: RwLock::new(proxies()),
            rules: RwLock::new(rules()),
            traffic,
            version: RwLock::new("v1.19.29".into()),
        });
        let app = Router::new()
            .route("/version", get(version_endpoint))
            .route("/configs", get(configs_endpoint))
            .route("/proxies", get(proxies_endpoint))
            .route("/rules", get(rules_endpoint))
            .route("/connections", get(connections_endpoint))
            .route("/traffic", get(traffic_endpoint))
            .route("/memory", get(memory_endpoint))
            .with_state(state.clone())
            .layer(from_fn(require_controller_auth));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let join = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .unwrap();
        });
        Self {
            address,
            join,
            shutdown: Some(shutdown_tx),
            state,
        }
    }

    fn base_url(&self) -> Url {
        Url::parse(&format!("http://{}", self.address)).unwrap()
    }

    fn set_available(&self, available: bool) {
        self.state.available.send_replace(available);
    }

    async fn shutdown(mut self) {
        self.set_available(false);
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.join.await.unwrap();
    }
}

async fn require_controller_auth(request: Request, next: Next) -> Response {
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == format!("Bearer {CONTROLLER_SECRET}"));
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

async fn version_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    if !available(&state) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    Json(json!({"meta": true, "version": state.version.read().await.clone()})).into_response()
}

async fn configs_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    unary(&state, &state.configs).await
}

async fn proxies_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    unary(&state, &state.proxies).await
}

async fn rules_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    unary(&state, &state.rules).await
}

async fn connections_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    unary(&state, &state.connections).await
}

async fn unary(state: &FakeControllerState, value: &RwLock<Value>) -> Response {
    if !available(state) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    Json(value.read().await.clone()).into_response()
}

async fn traffic_endpoint(
    State(state): State<Arc<FakeControllerState>>,
    websocket: WebSocketUpgrade,
) -> Response {
    stream_endpoint(state.clone(), websocket, state.traffic.subscribe())
}

async fn memory_endpoint(
    State(state): State<Arc<FakeControllerState>>,
    websocket: WebSocketUpgrade,
) -> Response {
    stream_endpoint(state.clone(), websocket, state.memory.subscribe())
}

fn stream_endpoint(
    state: Arc<FakeControllerState>,
    websocket: WebSocketUpgrade,
    values: watch::Receiver<Value>,
) -> Response {
    if !available(&state) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    websocket
        .on_upgrade(move |socket| stream_values(socket, state, values))
        .into_response()
}

async fn stream_values(
    mut socket: axum::extract::ws::WebSocket,
    state: Arc<FakeControllerState>,
    mut values: watch::Receiver<Value>,
) {
    state.active_streams.fetch_add(1, Ordering::AcqRel);
    let _guard = StreamGuard(&state.active_streams);
    let mut availability = state.available.subscribe();
    let initial = values.borrow().to_string();
    if socket
        .send(AxumMessage::Text(initial.into()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            changed = values.changed() => {
                if changed.is_err() {
                    return;
                }
                let next = values.borrow_and_update().to_string();
                if socket.send(AxumMessage::Text(next.into())).await.is_err() {
                    return;
                }
            }
            changed = availability.changed() => {
                if changed.is_err() || !*availability.borrow_and_update() {
                    return;
                }
            }
            incoming = socket.recv() => {
                if incoming.is_none() {
                    return;
                }
            }
        }
    }
}

struct StreamGuard<'a>(&'a AtomicUsize);

impl Drop for StreamGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn available(state: &FakeControllerState) -> bool {
    *state.available.borrow()
}

fn configs(mode: &str) -> Value {
    json!({
        "mode": mode,
        "tun": {"enable": false},
        "allow-lan": false,
        "ipv6": false,
        "port": 0,
        "socks-port": 0,
        "redir-port": 0,
        "tproxy-port": 0,
        "mixed-port": 0,
        "log-level": "info",
        "tcp-concurrent": false,
        "find-process-mode": "off",
        "sniffing": false,
        "interface-name": ""
    })
}

fn proxy(name: &str, kind: &str) -> Value {
    json!({
        "name": name,
        "type": kind,
        "alive": true,
        "udp": true,
        "uot": false,
        "xudp": false,
        "tfo": false,
        "mptcp": false,
        "smux": false,
        "history": []
    })
}

fn proxies() -> Value {
    let mut direct = proxy("DIRECT", "Direct");
    direct["history"] = json!([{"time": "2026-07-19T00:00:00Z", "delay": 7}]);
    let mut group = proxy("SELECT", "Selector");
    group["all"] = json!(["DIRECT"]);
    group["now"] = json!("DIRECT");
    json!({"proxies": {"DIRECT": direct, "SELECT": group}})
}

fn rules() -> Value {
    json!({"rules": [{
        "index": 0,
        "type": "MATCH",
        "payload": "",
        "proxy": "SELECT",
        "size": -1
    }]})
}

fn connections(id: &str) -> Value {
    json!({
        "downloadTotal": 100,
        "uploadTotal": 50,
        "memory": 4096,
        "connections": [{
            "id": id,
            "metadata": {
                "network": "tcp",
                "type": "HTTP",
                "sourceIP": "192.0.2.1",
                "destinationIP": "198.51.100.1",
                "sourcePort": "50000",
                "destinationPort": "443"
            },
            "upload": 50,
            "download": 100,
            "start": "2026-07-19T00:00:00Z",
            "chains": ["SELECT", "DIRECT"],
            "rule": "MATCH",
            "rulePayload": ""
        }]
    })
}

fn traffic(up: i64, down: i64, up_total: i64, down_total: i64) -> Value {
    json!({"up": up, "down": down, "upTotal": up_total, "downTotal": down_total})
}

fn source_config(fake: &FakeController) -> ControllerObservationConfig {
    let profile = ProfileMappingContext::new(
        "profile-test",
        "sha256:controller-source-test",
        "Controller test profile",
    )
    .unwrap();
    let mut config = ControllerObservationConfig::new(fake.base_url(), profile);
    config.secret = Some(CONTROLLER_SECRET.into());
    config.connect_timeout = Duration::from_millis(250);
    config.request_timeout = Duration::from_millis(250);
    config.refresh_interval = Duration::from_millis(40);
    config.reconnect_delay = Duration::from_millis(30);
    config
}

fn bridge_config() -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec![ORIGIN.into()],
        auth_token: TOKEN.into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        max_message_bytes: 1_048_576,
        profile_service: None,
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

async fn rpc_request(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    value: Value,
) -> Value {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
    loop {
        let Message::Text(response) = socket.next().await.unwrap().unwrap() else {
            continue;
        };
        let response: Value = serde_json::from_str(&response).unwrap();
        if response.get("id").is_some() {
            return response;
        }
    }
}

async fn authenticate(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let response = rpc_request(
        socket,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "rpc.authenticate",
            "params": {"clientName": "source-test", "clientVersion": "1", "token": TOKEN}
        }),
    )
    .await;
    assert_eq!(response["result"]["authenticated"], true);
}

async fn next_snapshot(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    timeout(Duration::from_secs(3), async {
        loop {
            let Message::Text(message) = socket.next().await.unwrap().unwrap() else {
                continue;
            };
            let message: Value = serde_json::from_str(&message).unwrap();
            if message["method"] != "status.snapshot" {
                continue;
            }
            let snapshot = &message["params"]["snapshot"];
            if predicate(snapshot) {
                return snapshot.clone();
            }
        }
    })
    .await
    .expect("matching Status notification was not published")
}

#[tokio::test]
async fn controller_observations_flow_through_rpc_and_preserve_valid_state() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_status_source(lifecycle.clone(), source.clone());
    source.start().await;
    let bridge = start_loopback_server(bridge_config(), runtime)
        .await
        .unwrap();
    let mut websocket = socket(bridge.address).await;
    authenticate(&mut websocket).await;

    let subscription = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":2, "method":"status.subscribe", "params":{}}),
    )
    .await;
    let initial = if subscription["result"]["snapshot"]["groups"]
        .as_array()
        .is_some_and(|groups| !groups.is_empty())
    {
        subscription["result"]["snapshot"].clone()
    } else {
        next_snapshot(&mut websocket, |snapshot| {
            snapshot["groups"]
                .as_array()
                .is_some_and(|groups| !groups.is_empty())
                && snapshot["runtime"]["phase"] == "healthy"
        })
        .await
    };
    assert_eq!(initial["activeProfileId"], "profile-test");
    assert_eq!(initial["routingMode"], "rule");
    assert_eq!(initial["metrics"]["activeConnections"], 1);
    assert_eq!(initial["traffic"]["downloadBytesPerSecond"], 4);

    fake.state.traffic.send_replace(traffic(11, 22, 110, 220));
    let streamed = next_snapshot(&mut websocket, |snapshot| {
        snapshot["traffic"]["downloadBytesPerSecond"] == 22
            && snapshot["runtime"]["phase"] == "healthy"
    })
    .await;
    assert_eq!(streamed["traffic"]["uploadBytesPerSecond"], 11);

    *fake.state.configs.write().await = configs("direct");
    *fake.state.connections.write().await = json!({
        "downloadTotal": 100,
        "uploadTotal": 50,
        "memory": 4096,
        "connections": []
    });
    let refreshed = next_snapshot(&mut websocket, |snapshot| {
        snapshot["routingMode"] == "direct" && snapshot["metrics"]["activeConnections"] == 0
    })
    .await;
    assert_eq!(refreshed["metrics"]["effectiveRules"], 1);

    fake.state.traffic.send_replace(traffic(33, -1, 330, 440));
    let invalid = next_snapshot(&mut websocket, |snapshot| {
        snapshot["runtime"]["phase"] == "error"
            && snapshot["runtime"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("must be non-negative"))
    })
    .await;
    assert_eq!(invalid["traffic"], streamed["traffic"]);
    assert_eq!(invalid["routingMode"], "direct");

    fake.state.traffic.send_replace(traffic(33, 44, 330, 440));
    let recovered_batch = next_snapshot(&mut websocket, |snapshot| {
        snapshot["traffic"]["downloadBytesPerSecond"] == 44
            && snapshot["runtime"]["phase"] == "healthy"
    })
    .await;
    assert_eq!(
        recovered_batch["traffic"]["downloadSeries"],
        json!([4, 22, 44])
    );

    fake.set_available(false);
    let disconnected = next_snapshot(&mut websocket, |snapshot| {
        snapshot["runtime"]["phase"] == "error"
            && snapshot["runtime"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("Controller observation failed"))
    })
    .await;
    assert_eq!(disconnected["traffic"]["downloadBytesPerSecond"], 44);

    fake.set_available(true);
    let reconnected = next_snapshot(&mut websocket, |snapshot| {
        snapshot["runtime"]["phase"] == "healthy"
            && snapshot["traffic"]["downloadBytesPerSecond"] == 44
    })
    .await;
    assert_eq!(reconnected["routingMode"], "direct");

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    assert!(source.is_closed());
    assert!(lifecycle.stopped.load(Ordering::Acquire));
    wait_for(Duration::from_secs(1), || {
        fake.state.active_streams.load(Ordering::Acquire) == 0
    })
    .await;
    fake.shutdown().await;
}

#[tokio::test]
async fn unsupported_controller_version_is_diagnostic_and_blocks_observation() {
    let fake = FakeController::start().await;
    *fake.state.version.write().await = "v1.20.0".into();
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_status_source(lifecycle, source.clone());
    source.start().await;

    timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
            if snapshot["runtime"]["phase"] == "error" {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("unsupported version was not reported");
    let snapshot = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(snapshot["groups"], json!([]));
    assert!(
        snapshot["runtime"]["message"]
            .as_str()
            .unwrap()
            .contains("unsupported; expected v1.19.29")
    );

    runtime.shutdown().await.unwrap();
    assert!(source.is_closed());
    fake.shutdown().await;
}

#[tokio::test]
async fn desktop_composition_without_controller_stays_lifecycle_only() {
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let runtime = compose_desktop_runtime(lifecycle, None).await.unwrap();

    let snapshot = runtime.status_snapshot(StatusAdapterKind::Rpc).await;

    assert_eq!(snapshot["activeProfileId"], "local");
    assert_eq!(snapshot["groups"], json!([]));
    assert_eq!(snapshot["runtime"]["phase"], "healthy");
    runtime.shutdown().await.unwrap();
}

#[test]
fn desktop_controller_configuration_rejects_non_loopback_urls() {
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let profile = ProfileMappingContext::new("profile", "fingerprint", "Profile").unwrap();
    let config = ControllerObservationConfig::new(
        Url::parse("https://controller.example").unwrap(),
        profile,
    );

    assert!(matches!(
        ControllerStatusSource::new(config, lifecycle),
        Err(ControllerStatusSourceError::NonLoopbackController)
    ));
}

async fn wait_for(timeout_after: Duration, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout_after;
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "condition was not met before timeout"
        );
        sleep(Duration::from_millis(10)).await;
    }
}
