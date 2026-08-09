use std::{
    collections::{BTreeSet, HashMap},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State, WebSocketUpgrade, ws::Message as AxumMessage},
    http::{StatusCode, header::AUTHORIZATION},
    middleware::{Next, from_fn},
    response::{IntoResponse, Response},
    routing::{delete, get, put},
};
use futures_util::{SinkExt, StreamExt, future::BoxFuture, future::ready};
use mish_bridge::{
    ControllerObservationConfig, ControllerStatusSource, ControllerStatusSourceError,
    LoopbackServerConfig, ProfileMappingContext, compose_desktop_runtime, start_loopback_server,
};
use mish_runtime::{
    CoreError, CoreLifecycleCommand, CoreLifecycleMutation, CoreLifecycleOperation, CorePhase,
    CoreRuntime, CoreStatus, GroupSelectionCleanupFailure, GroupSelectionCleanupMode,
    GroupSelectionCleanupPhase, MishRuntime, PolicyGroupConnectionCleanupPreference,
    ProviderCommandOperation, ProviderCommandPhase, ProviderCommandResult, ProviderKind,
    ProviderUpdateFailure, ProviderUpdatePhase, RoutingMode, RuntimeObservationPauseReason,
    StatusAdapterKind, StatusCommand, StatusCommandErrorKind, StatusDataSource, TrafficDataSource,
    TrafficSourceEvidencePhase, TrafficSourceRuntimeContext,
};
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    sync::{RwLock, broadcast, oneshot, watch},
    task::JoinHandle,
    time::{Duration, Instant, sleep, timeout},
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use url::Url;

const ORIGIN: &str = "http://controller-source.test";
const TOKEN: &str = "controller-source-token";
const CONTROLLER_SECRET: &str = "fake-controller-secret";

fn core_operation() -> CoreLifecycleOperation {
    CoreLifecycleOperation::new("controller-source-test", 1, "shutdown", 1, 1).unwrap()
}

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

    fn execute_lifecycle(
        &self,
        command: CoreLifecycleCommand,
    ) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        self.stopped.store(
            command.mutation() == CoreLifecycleMutation::Stop,
            Ordering::Release,
        );
        Box::pin(ready(Ok(TestLifecycle::status(self))))
    }
}

struct FakeControllerState {
    active_streams: AtomicUsize,
    apply_mutations: AtomicBool,
    available: watch::Sender<bool>,
    configs: RwLock<Value>,
    connections: RwLock<Value>,
    connection_close_delay_milliseconds: AtomicUsize,
    group_selection_delay_milliseconds: AtomicUsize,
    close_limit: AtomicUsize,
    close_all_count: AtomicUsize,
    closed_connection_ids: Mutex<Vec<String>>,
    delay_mode: AtomicUsize,
    delay_requests: Mutex<Vec<String>>,
    disappearing_connection_ids: Mutex<BTreeSet<String>>,
    logs: broadcast::Sender<Value>,
    logs_available: watch::Sender<bool>,
    memory: watch::Sender<Value>,
    mutation_count: AtomicUsize,
    mutation_status: AtomicUsize,
    late_connection: Mutex<Option<Value>>,
    proxies: RwLock<Value>,
    proxy_providers: RwLock<Value>,
    rejected_provider: Mutex<Option<String>>,
    rejected_connection_ids: Mutex<BTreeSet<String>>,
    rule_providers: RwLock<Value>,
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
        let (logs, _) = broadcast::channel(2_048);
        let (logs_available, _) = watch::channel(true);
        let state = Arc::new(FakeControllerState {
            active_streams: AtomicUsize::new(0),
            apply_mutations: AtomicBool::new(true),
            available,
            configs: RwLock::new(configs("rule")),
            connections: RwLock::new(connections("connection-a")),
            connection_close_delay_milliseconds: AtomicUsize::new(0),
            group_selection_delay_milliseconds: AtomicUsize::new(0),
            close_limit: AtomicUsize::new(usize::MAX),
            close_all_count: AtomicUsize::new(0),
            closed_connection_ids: Mutex::new(Vec::new()),
            delay_mode: AtomicUsize::new(0),
            delay_requests: Mutex::new(Vec::new()),
            disappearing_connection_ids: Mutex::new(BTreeSet::new()),
            logs,
            logs_available,
            memory,
            mutation_count: AtomicUsize::new(0),
            mutation_status: AtomicUsize::new(StatusCode::NO_CONTENT.as_u16().into()),
            late_connection: Mutex::new(None),
            proxies: RwLock::new(proxies()),
            proxy_providers: RwLock::new(proxy_providers()),
            rejected_provider: Mutex::new(None),
            rejected_connection_ids: Mutex::new(BTreeSet::new()),
            rule_providers: RwLock::new(rule_providers()),
            rules: RwLock::new(rules()),
            traffic,
            version: RwLock::new("v1.19.29".into()),
        });
        let app = Router::new()
            .route("/version", get(version_endpoint))
            .route(
                "/configs",
                get(configs_endpoint).patch(set_configs_endpoint),
            )
            .route("/proxies", get(proxies_endpoint))
            .route("/proxies/{proxy}/delay", get(proxy_delay_endpoint))
            .route(
                "/proxies/{group}",
                axum::routing::put(select_group_endpoint),
            )
            .route("/rules", get(rules_endpoint))
            .route("/providers/proxies", get(proxy_providers_endpoint))
            .route("/providers/rules", get(rule_providers_endpoint))
            .route(
                "/providers/proxies/{provider}",
                put(update_provider_endpoint),
            )
            .route("/providers/rules/{provider}", put(update_provider_endpoint))
            .route(
                "/connections",
                get(connections_endpoint).delete(close_all_connections_endpoint),
            )
            .route("/connections/{id}", delete(close_connection_endpoint))
            .route("/traffic", get(traffic_endpoint))
            .route("/memory", get(memory_endpoint))
            .route("/logs", get(logs_endpoint))
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

    fn set_logs_available(&self, available: bool) {
        self.state.logs_available.send_replace(available);
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

async fn proxy_delay_endpoint(
    Path(proxy): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    State(state): State<Arc<FakeControllerState>>,
) -> Response {
    state
        .delay_requests
        .lock()
        .expect("delay requests poisoned")
        .push(proxy.clone());
    if query.get("url").map(String::as_str) != Some(mish_mihomo_controller::ROUTE_DELAY_TEST_URL)
        || query.get("timeout").map(String::as_str) != Some("5000")
        || query.get("expected").map(String::as_str) != Some("204")
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match state.delay_mode.load(Ordering::Acquire) {
        1 => sleep(Duration::from_millis(700)).await,
        2 => sleep(Duration::from_millis(100)).await,
        3 if proxy != "DIRECT" => sleep(Duration::from_millis(700)).await,
        _ => {}
    }
    match proxy.as_str() {
        "DIRECT" => Json(json!({"delay": 42})).into_response(),
        "节点 🚄" => StatusCode::GATEWAY_TIMEOUT.into_response(),
        _ => Json(json!({"delay": 88})).into_response(),
    }
}

async fn set_configs_endpoint(
    State(state): State<Arc<FakeControllerState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(object) = body.as_object().filter(|object| object.len() == 1) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(mode) = object
        .get("mode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "rule" | "global" | "direct"))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    state.mutation_count.fetch_add(1, Ordering::AcqRel);
    if state.apply_mutations.load(Ordering::Acquire) {
        *state.configs.write().await = configs(mode);
    }
    StatusCode::from_u16(state.mutation_status.load(Ordering::Acquire) as u16)
        .unwrap()
        .into_response()
}

async fn select_group_endpoint(
    axum::extract::Path(group): axum::extract::Path<String>,
    State(state): State<Arc<FakeControllerState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(child) = body.get("name").and_then(Value::as_str) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    state.mutation_count.fetch_add(1, Ordering::AcqRel);
    if state.apply_mutations.load(Ordering::Acquire) {
        let delay = state
            .group_selection_delay_milliseconds
            .load(Ordering::Acquire);
        if delay == 0 {
            let mut proxies = state.proxies.write().await;
            proxies["proxies"][group]["now"] = json!(child);
        } else {
            let state = state.clone();
            let child = child.to_owned();
            tokio::spawn(async move {
                sleep(Duration::from_millis(delay as u64)).await;
                let mut proxies = state.proxies.write().await;
                proxies["proxies"][group]["now"] = json!(child);
            });
        }
    }
    StatusCode::from_u16(state.mutation_status.load(Ordering::Acquire) as u16)
        .unwrap()
        .into_response()
}

async fn rules_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    unary(&state, &state.rules).await
}

async fn proxy_providers_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    unary(&state, &state.proxy_providers).await
}

async fn rule_providers_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    unary(&state, &state.rule_providers).await
}

async fn update_provider_endpoint(
    Path(provider): Path<String>,
    State(state): State<Arc<FakeControllerState>>,
) -> Response {
    state.mutation_count.fetch_add(1, Ordering::AcqRel);
    if state
        .rejected_provider
        .lock()
        .expect("rejected provider poisoned")
        .as_deref()
        == Some(&provider)
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn connections_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    if !available(&state) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let snapshot = state.connections.read().await.clone();
    let late = state
        .late_connection
        .lock()
        .expect("late connection poisoned")
        .take();
    if let Some(late) = late {
        state.connections.write().await["connections"]
            .as_array_mut()
            .expect("fixture connections")
            .push(late);
    }
    Json(snapshot).into_response()
}

async fn close_connection_endpoint(
    axum::extract::Path(id): axum::extract::Path<String>,
    State(state): State<Arc<FakeControllerState>>,
) -> Response {
    state.mutation_count.fetch_add(1, Ordering::AcqRel);
    state
        .closed_connection_ids
        .lock()
        .expect("closed connection IDs poisoned")
        .push(id.clone());
    let close_delay = Duration::from_millis(
        state
            .connection_close_delay_milliseconds
            .load(Ordering::Acquire) as u64,
    );
    if !close_delay.is_zero() {
        sleep(close_delay).await;
    }
    if state
        .disappearing_connection_ids
        .lock()
        .expect("disappearing connection IDs poisoned")
        .remove(&id)
    {
        let mut connections = state.connections.write().await;
        connections["connections"] = Value::Array(
            connections["connections"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|connection| connection["id"] != id)
                .cloned()
                .collect(),
        );
        return StatusCode::NOT_FOUND.into_response();
    }
    if state
        .rejected_connection_ids
        .lock()
        .expect("rejected connection IDs poisoned")
        .contains(&id)
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let status =
        StatusCode::from_u16(state.mutation_status.load(Ordering::Acquire) as u16).unwrap();
    if !status.is_success() {
        return status.into_response();
    }
    if state.apply_mutations.load(Ordering::Acquire) {
        let mut connections = state.connections.write().await;
        connections["connections"] = Value::Array(
            connections["connections"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|connection| connection["id"] != id)
                .cloned()
                .collect(),
        );
    }
    status.into_response()
}

async fn close_all_connections_endpoint(State(state): State<Arc<FakeControllerState>>) -> Response {
    state.mutation_count.fetch_add(1, Ordering::AcqRel);
    state.close_all_count.fetch_add(1, Ordering::AcqRel);
    let status =
        StatusCode::from_u16(state.mutation_status.load(Ordering::Acquire) as u16).unwrap();
    if !status.is_success() {
        return status.into_response();
    }
    if state.apply_mutations.load(Ordering::Acquire) {
        let close_limit = state.close_limit.load(Ordering::Acquire);
        let mut connections = state.connections.write().await;
        let remaining = connections["connections"]
            .as_array()
            .unwrap()
            .iter()
            .skip(close_limit)
            .cloned()
            .collect();
        connections["connections"] = Value::Array(remaining);
    }
    status.into_response()
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

async fn logs_endpoint(
    State(state): State<Arc<FakeControllerState>>,
    websocket: WebSocketUpgrade,
) -> Response {
    if !available(&state) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if !*state.logs_available.borrow() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    websocket
        .on_upgrade(move |socket| stream_logs(socket, state))
        .into_response()
}

async fn stream_logs(mut socket: axum::extract::ws::WebSocket, state: Arc<FakeControllerState>) {
    state.active_streams.fetch_add(1, Ordering::AcqRel);
    let _guard = StreamGuard(&state.active_streams);
    let mut values = state.logs.subscribe();
    let mut availability = state.available.subscribe();
    let mut logs_available = state.logs_available.subscribe();
    loop {
        tokio::select! {
            value = values.recv() => {
                let Ok(value) = value else { return };
                if socket.send(AxumMessage::Text(value.to_string().into())).await.is_err() {
                    return;
                }
            }
            changed = availability.changed() => {
                if changed.is_err() || !*availability.borrow_and_update() {
                    return;
                }
            }
            changed = logs_available.changed() => {
                if changed.is_err() || !*logs_available.borrow_and_update() {
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
    group["all"] = json!(["DIRECT", "节点 🚄"]);
    group["now"] = json!("DIRECT");
    let node = proxy("节点 🚄", "VLESS");
    let mut automatic = proxy("AUTO", "URLTest");
    automatic["all"] = json!(["DIRECT", "节点 🚄"]);
    automatic["now"] = json!("DIRECT");
    let mut other = proxy("OTHER", "Selector");
    other["all"] = json!(["DIRECT"]);
    other["now"] = json!("DIRECT");
    json!({"proxies": {
        "DIRECT": direct,
        "节点 🚄": node,
        "SELECT": group,
        "AUTO": automatic,
        "OTHER": other
    }})
}

fn many_slow_proxies() -> Value {
    let child_labels = (0..8)
        .map(|index| format!("取消候选 {index} 🚦"))
        .collect::<Vec<_>>();
    let mut values = serde_json::Map::new();
    for label in &child_labels {
        values.insert(label.clone(), proxy(label, "VLESS"));
    }
    let mut group = proxy("SELECT", "Selector");
    group["all"] = json!(child_labels);
    group["now"] = json!("取消候选 0 🚦");
    values.insert("SELECT".into(), group);
    json!({"proxies": values})
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

fn proxy_providers() -> Value {
    json!({"providers": {
        "proxy-a": {
            "name": "proxy-a",
            "type": "Proxy",
            "vehicleType": "HTTP",
            "updatedAt": "2026-07-19T00:00:00Z",
            "url": "https://private.invalid/list?token=redacted",
            "proxies": [{"alive": true, "server": "192.0.2.8"}]
        },
        "proxy-b": {
            "name": "proxy-b",
            "type": "Proxy",
            "vehicleType": "File",
            "updatedAt": "2026-07-19T00:00:00Z",
            "path": "/private/provider.yaml",
            "proxies": [{"alive": false, "server": "192.0.2.9"}]
        }
    }})
}

fn rule_providers() -> Value {
    json!({"providers": {
        "rules-a": {
            "behavior": "Domain",
            "name": "rules-a",
            "type": "Rule",
            "ruleCount": 7,
            "updatedAt": "2026-07-19T00:00:00Z",
            "vehicleType": "HTTP",
            "payload": ["private.invalid"]
        }
    }})
}

fn connections(id: &str) -> Value {
    connections_many(&[id])
}

fn connections_many(ids: &[&str]) -> Value {
    json!({
        "downloadTotal": 100,
        "uploadTotal": 50,
        "memory": 4096,
        "connections": ids.iter().map(|id| connection_value(
            id,
            &["DIRECT", "SELECT"],
            "tcp",
        )).collect::<Vec<_>>()
    })
}

fn connection_value(id: &str, chains: &[&str], network: &str) -> Value {
    json!({
        "id": id,
        "metadata": {
            "network": network,
            "type": if network == "udp" { "UDP" } else { "HTTP" },
            "sourceIP": "192.0.2.1",
            "destinationIP": "198.51.100.1",
            "sourcePort": "50000",
            "destinationPort": "443"
        },
        "upload": 50,
        "download": 100,
        "start": "2026-07-19T00:00:00Z",
        "chains": chains,
        "rule": "MATCH",
        "rulePayload": ""
    })
}

fn connection_snapshot(values: Vec<Value>) -> Value {
    json!({
        "downloadTotal": 100,
        "uploadTotal": 50,
        "memory": 4096,
        "connections": values
    })
}

fn traffic(up: i64, down: i64, up_total: i64, down_total: i64) -> Value {
    json!({"up": up, "down": down, "upTotal": up_total, "downTotal": down_total})
}

fn source_config(fake: &FakeController) -> ControllerObservationConfig {
    source_config_for_profile(fake, "profile-test", "Controller test profile")
}

fn source_config_for_profile(
    fake: &FakeController,
    profile_id: &str,
    profile_label: &str,
) -> ControllerObservationConfig {
    let profile =
        ProfileMappingContext::new(profile_id, "sha256:controller-source-test", profile_label)
            .unwrap();
    let mut config = ControllerObservationConfig::new(fake.base_url(), profile);
    config.secret = Some(CONTROLLER_SECRET.into());
    config.connect_timeout = Duration::from_millis(250);
    config.request_timeout = Duration::from_millis(250);
    config.refresh_interval = Duration::from_millis(40);
    config.reconnect_delay = Duration::from_millis(30);
    config.confirmation_timeout = Duration::from_millis(150);
    config
}

async fn selector_target_ids(runtime: &MishRuntime) -> (String, String, String) {
    let snapshot = runtime.status_snapshot_typed(StatusAdapterKind::Rpc).await;
    let group_id = snapshot
        .groups
        .iter()
        .find(|group| group.label == "SELECT")
        .unwrap()
        .id
        .clone();
    let direct_child_id = snapshot
        .nodes
        .iter()
        .find(|node| node.label == "DIRECT")
        .unwrap()
        .id
        .clone();
    let new_child_id = snapshot
        .nodes
        .iter()
        .find(|node| node.label == "节点 🚄")
        .unwrap()
        .id
        .clone();
    (group_id, direct_child_id, new_child_id)
}

fn bridge_config() -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec![ORIGIN.into()],
        auth_token: TOKEN.into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        port_selection: mish_bridge::LoopbackPortSelection::Fixed,
        browser_assets: None,
        browser_pairing_prompt: None,
        max_message_bytes: 1_048_576,
        profile_activation: None,
        profile_file_actions: None,
        profile_service: None,
        process_icon_resolver: None,
        service_probes: None,
        settings_service: None,
        tun_helper_removal_occurrences: None,
        updater_service: None,
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
    let compatibility = rpc_request(
        socket,
        json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "bridge.getInfo",
            "params": {
                "clientProtocolVersion": mish_bridge::bridge_protocol::BRIDGE_PROTOCOL_VERSION
            }
        }),
    )
    .await;
    assert_eq!(compatibility["result"]["compatibility"], "compatible");
}

async fn runtime_snapshot_until(
    runtime: &MishRuntime,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    timeout(Duration::from_secs(3), async {
        loop {
            let snapshot = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
            if predicate(&snapshot) {
                return snapshot;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("matching runtime snapshot was not published")
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
    let runtime = MishRuntime::with_data_sources(lifecycle.clone(), source.clone(), source.clone());
    let runtime_view = runtime.clone();
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
    assert_eq!(
        subscription["result"]["snapshot"]["services"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    assert_eq!(
        subscription["result"]["snapshot"]["probeResults"],
        json!([])
    );
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
    let initial_traffic = runtime_view.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(initial_traffic["phase"], "ready");
    assert_eq!(initial_traffic["sessionId"], "controller-1");
    assert_eq!(
        initial_traffic["activeConnections"][0]["destinationHost"],
        Value::Null
    );
    assert_eq!(
        initial_traffic["activeConnections"][0]["destinationIp"],
        "198.51.100.1"
    );
    assert_eq!(
        initial_traffic["activeConnections"][0]["downloadBytes"],
        "100"
    );
    assert_eq!(
        initial_traffic["activeConnections"][0]["routeChain"],
        json!(["SELECT", "DIRECT"])
    );
    assert_eq!(initial_traffic["rules"][0]["priority"], 0);

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
    let refreshed_traffic = runtime_view.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(refreshed_traffic["activeConnections"], json!([]));
    assert!(
        refreshed_traffic["sequence"].as_u64().unwrap()
            > initial_traffic["sequence"].as_u64().unwrap()
    );

    fake.state.traffic.send_replace(traffic(33, -1, 330, 440));
    let invalid = next_snapshot(&mut websocket, |snapshot| {
        snapshot["runtime"]["phase"] == "error"
            && snapshot["runtime"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("could not be mapped safely"))
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
    let stale_traffic = runtime_view.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(stale_traffic["phase"], "stale");
    assert_eq!(stale_traffic["sessionId"], "controller-1");

    fake.set_available(true);
    let reconnected = next_snapshot(&mut websocket, |snapshot| {
        snapshot["runtime"]["phase"] == "healthy"
            && snapshot["traffic"]["downloadBytesPerSecond"] == 44
    })
    .await;
    assert_eq!(reconnected["routingMode"], "direct");
    let reconnected_traffic = runtime_view.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(reconnected_traffic["phase"], "ready");
    assert_eq!(reconnected_traffic["sessionId"], "controller-2");
    assert_eq!(reconnected_traffic["reconnectCount"], 1);

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    assert!(source.is_closed());
    assert!(
        !lifecycle.stopped.load(Ordering::Acquire),
        "a transport-only bridge cannot mutate Core without a Profile coordinator",
    );
    wait_for(Duration::from_secs(1), || {
        fake.state.active_streams.load(Ordering::Acquire) == 0
    })
    .await;
    fake.shutdown().await;
}

#[tokio::test]
async fn lifecycle_pause_invalidates_old_controller_authority_before_a_new_session_is_ready() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources_and_events(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
    );
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"] == "ready"
    })
    .await;
    let initial = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
    let initial_session = initial["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(initial["activeConnections"][0]["id"], "connection-a");

    source
        .pause_observations(RuntimeObservationPauseReason::Sleep)
        .await;
    let sleeping = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(sleeping["phase"], "stale");
    assert_eq!(sleeping["sessionId"], initial_session);
    assert_eq!(sleeping["activeConnections"][0]["id"], "connection-a");
    assert_eq!(
        source.traffic_support_evidence().last().unwrap().phase,
        TrafficSourceEvidencePhase::FailedReconciling,
        "sleep must gap the live generation before observation authority advances"
    );

    source
        .pause_observations(RuntimeObservationPauseReason::NetworkChanged)
        .await;
    let invalidated = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(invalidated["phase"], "unavailable");
    assert_eq!(invalidated["sessionId"], Value::Null);
    assert_eq!(invalidated["activeConnections"], json!([]));
    assert_eq!(
        runtime.events_snapshot(StatusAdapterKind::Rpc)["sessionId"],
        Value::Null
    );
    *fake.state.connections.write().await = connections("connection-b");

    source.resume_observations().await;
    wait_for(Duration::from_secs(1), || {
        let traffic = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
        traffic["phase"] == "ready" && traffic["activeConnections"][0]["id"] == "connection-b"
    })
    .await;
    let recovered = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_ne!(recovered["sessionId"], initial_session);
    assert_eq!(recovered["activeConnections"][0]["id"], "connection-b");

    source.close().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn runtime_and_capture_replacement_require_a_complete_internal_traffic_baseline() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(10);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"] == "ready"
    })
    .await;
    let before = runtime.traffic_snapshot_typed(StatusAdapterKind::Rpc);

    source.set_runtime_context(TrafficSourceRuntimeContext {
        capture_session_id: Some("replacement-capture-private".into()),
        runtime_id: "replacement-runtime-private".into(),
    });
    assert_eq!(
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"],
        "stale"
    );
    assert!(
        !runtime.supports_traffic_command(mish_runtime::TrafficCommandOperation::CloseConnection)
    );

    let execution = runtime
        .close_connection(
            mish_runtime::TrafficCommandAuthority {
                profile_id: before.profile_id.clone(),
                sequence: before.sequence,
                session_id: before.session_id.clone().unwrap(),
            },
            "connection-a".into(),
        )
        .await;
    assert_eq!(
        execution.failure,
        Some(mish_runtime::TrafficCommandFailureKind::StaleSnapshot)
    );
    assert_eq!(execution.target_count, 1);
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 0);
    let evidence = source.traffic_support_evidence();
    assert!(
        evidence
            .iter()
            .any(|record| record.phase == TrafficSourceEvidencePhase::Replacing)
    );
    let serialized = serde_json::to_string(&evidence).unwrap();
    for secret in [
        "replacement-capture-private",
        "replacement-runtime-private",
        "connection-a",
    ] {
        assert!(!serialized.contains(secret));
    }

    source
        .pause_observations(RuntimeObservationPauseReason::NetworkChanged)
        .await;
    source.resume_observations().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"] == "ready"
    })
    .await;
    let replacement = runtime.traffic_snapshot_typed(StatusAdapterKind::Rpc);
    assert_ne!(replacement.session_id, before.session_id);
    let execution = runtime
        .close_connection(
            mish_runtime::TrafficCommandAuthority {
                profile_id: replacement.profile_id,
                sequence: replacement.sequence,
                session_id: replacement.session_id.unwrap(),
            },
            "connection-a".into(),
        )
        .await;
    assert_eq!(execution.failure, None);
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);

    source.close().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn provider_updates_are_authorized_reobserved_and_keep_partial_failures() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;

    let initial = timeout(Duration::from_secs(3), async {
        loop {
            let snapshot = runtime.provider_snapshot();
            if snapshot.providers.len() == 3 {
                break snapshot;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("provider inventory was not observed");
    let serialized = serde_json::to_string(&initial).unwrap();
    for private in [
        "private.invalid",
        "redacted",
        "/private/provider.yaml",
        "192.0.2.8",
        "192.0.2.9",
    ] {
        assert!(!serialized.contains(private));
    }
    assert!(!initial.remotely_cancellable);

    *fake
        .state
        .rejected_provider
        .lock()
        .expect("rejected provider poisoned") = Some("proxy-b".into());
    let authority = initial.authority.clone().unwrap();
    let execution = runtime
        .update_all_providers(authority, ProviderKind::Proxy)
        .await;
    let result = ProviderCommandResult::new(execution, runtime.provider_snapshot());

    assert_eq!(result.operation, ProviderCommandOperation::UpdateAll);
    assert_eq!(result.phase, ProviderCommandPhase::Partial);
    assert_eq!(result.succeeded_provider_ids.len(), 1);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(
        result.failed[0].failure,
        ProviderUpdateFailure::UpdateRejected
    );
    let succeeded = result
        .snapshot
        .providers
        .iter()
        .find(|provider| provider.label == "proxy-a")
        .unwrap();
    let failed = result
        .snapshot
        .providers
        .iter()
        .find(|provider| provider.label == "proxy-b")
        .unwrap();
    assert_eq!(succeeded.update.phase, ProviderUpdatePhase::Success);
    assert_eq!(failed.update.phase, ProviderUpdatePhase::Failure);
    assert_eq!(
        failed.update.failure,
        Some(ProviderUpdateFailure::UpdateRejected)
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn controller_commands_revalidate_and_publish_only_confirmed_snapshots() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    assert!(!source.supports_command(StatusCommand::GroupDelay));
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
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
    let snapshot = if subscription["result"]["snapshot"]["groups"]
        .as_array()
        .is_some_and(|groups| !groups.is_empty())
    {
        subscription["result"]["snapshot"].clone()
    } else {
        next_snapshot(&mut websocket, |snapshot| {
            snapshot["groups"]
                .as_array()
                .is_some_and(|groups| !groups.is_empty())
        })
        .await
    };
    let groups = snapshot["groups"].as_array().unwrap();
    let selector = groups
        .iter()
        .find(|group| group["label"] == "SELECT")
        .unwrap();
    let automatic = groups
        .iter()
        .find(|group| group["label"] == "AUTO")
        .unwrap();
    let other = groups
        .iter()
        .find(|group| group["label"] == "OTHER")
        .unwrap();
    assert_eq!(automatic["type"], "url-test");
    let node = snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["label"] == "节点 🚄")
        .unwrap();

    let hostile = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":3, "method":"status.setRoutingMode", "params":{"mode":"global", "extra":true}}),
    )
    .await;
    assert_eq!(hostile["error"]["code"], -32602);
    let unsupported_mode = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":31, "method":"status.setRoutingMode", "params":{"mode":"script"}}),
    )
    .await;
    assert_eq!(unsupported_mode["error"]["code"], -32602);
    let hostile_group = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":32, "method":"status.selectGroupChild", "params":{"groupId":selector["id"], "childId":node["id"], "extra":true}}),
    )
    .await;
    assert_eq!(hostile_group["error"]["code"], -32602);
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 0);

    let routing = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":4, "method":"status.setRoutingMode", "params":{"mode":"global"}}),
    )
    .await;
    assert_eq!(routing["result"]["routingMode"], "global");

    let unsupported = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":5, "method":"status.selectGroupChild", "params":{"groupId":automatic["id"], "childId":node["id"]}}),
    )
    .await;
    assert_eq!(unsupported["error"]["data"]["kind"], "unsupported-group");
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);

    let cross_group = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":51, "method":"status.selectGroupChild", "params":{"groupId":other["id"], "childId":node["id"]}}),
    )
    .await;
    assert_eq!(cross_group["error"]["data"]["kind"], "stale-membership");
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);

    let selection = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":6, "method":"status.selectGroupChild", "params":{"groupId":selector["id"], "childId":node["id"]}}),
    )
    .await;
    assert_eq!(
        selection["result"]["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["label"] == "SELECT")
            .unwrap()["selectedChildId"],
        node["id"]
    );

    fake.state.mutation_status.store(
        StatusCode::INTERNAL_SERVER_ERROR.as_u16().into(),
        Ordering::Release,
    );
    fake.state.apply_mutations.store(false, Ordering::Release);
    let rejected = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":61, "method":"status.setRoutingMode", "params":{"mode":"rule"}}),
    )
    .await;
    assert_eq!(rejected["error"]["data"]["kind"], "rejected");
    let refreshed_after_rejection = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":62, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(refreshed_after_rejection["result"]["routingMode"], "global");
    fake.state
        .mutation_status
        .store(StatusCode::NO_CONTENT.as_u16().into(), Ordering::Release);

    let mut raced = proxies();
    raced["proxies"]["SELECT"]["all"] = json!(["DIRECT"]);
    raced["proxies"]["SELECT"]["now"] = json!("DIRECT");
    *fake.state.proxies.write().await = raced;
    let before_race = fake.state.mutation_count.load(Ordering::Acquire);
    let stale = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":7, "method":"status.selectGroupChild", "params":{"groupId":selector["id"], "childId":node["id"]}}),
    )
    .await;
    assert_eq!(stale["error"]["data"]["kind"], "stale-membership");
    assert!(!stale.to_string().contains("节点 🚄"));
    assert!(!stale.to_string().contains(CONTROLLER_SECRET));
    assert_eq!(
        fake.state.mutation_count.load(Ordering::Acquire),
        before_race
    );

    let timeout_response = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":8, "method":"status.setRoutingMode", "params":{"mode":"direct"}}),
    )
    .await;
    assert_eq!(timeout_response["error"]["data"]["kind"], "timeout");
    let refreshed = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":9, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(refreshed["result"]["routingMode"], "global");
    assert_eq!(
        refreshed["result"]["runtime"]["captureSelection"],
        snapshot["runtime"]["captureSelection"]
    );
    let expected_other_selection = other["selectedChildId"].clone();
    assert_eq!(
        refreshed["result"]["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["label"] == "OTHER")
            .unwrap()["selectedChildId"],
        expected_other_selection
    );

    fake.state.apply_mutations.store(true, Ordering::Release);
    *fake.state.configs.write().await = json!({"mode": 42});
    let malformed = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":81, "method":"status.setRoutingMode", "params":{"mode":"global"}}),
    )
    .await;
    assert_eq!(
        malformed["error"]["data"]["kind"],
        "inconsistent-observation"
    );
    assert!(!malformed.to_string().contains(CONTROLLER_SECRET));
    *fake.state.configs.write().await = configs("global");

    *fake.state.version.write().await = "v1.20.0".into();
    let version_drift = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":91, "method":"status.setRoutingMode", "params":{"mode":"rule"}}),
    )
    .await;
    assert_eq!(version_drift["error"]["data"]["kind"], "version-drift");
    *fake.state.version.write().await = "v1.19.29".into();

    let stopped = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":63, "method":"core.stop", "params":{}}),
    )
    .await;
    assert_eq!(stopped["error"]["code"], -32601);

    fake.set_available(false);
    let disconnected = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":10, "method":"status.setRoutingMode", "params":{"mode":"rule"}}),
    )
    .await;
    assert_eq!(disconnected["error"]["data"]["kind"], "disconnected");

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn group_selection_accepts_an_exact_controller_update_after_the_primary_deadline() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.group_confirmation_grace = Duration::from_millis(150);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;
    let (group_id, _, new_child_id) = selector_target_ids(&runtime).await;
    fake.state
        .group_selection_delay_milliseconds
        .store(225, Ordering::Release);

    let selected = runtime
        .select_group_child_typed(group_id, new_child_id.clone(), StatusAdapterKind::Rpc)
        .await
        .unwrap();
    assert_eq!(
        selected
            .groups
            .iter()
            .find(|group| group.label == "SELECT")
            .and_then(|group| group.selected_child_id.as_ref()),
        Some(&new_child_id)
    );
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_selection_still_times_out_without_an_exact_confirmation_during_the_grace_period() {
    let fake = FakeController::start().await;
    fake.state.apply_mutations.store(false, Ordering::Release);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.confirmation_timeout = Duration::from_millis(50);
    config.group_confirmation_grace = Duration::from_millis(100);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;
    let (group_id, _, new_child_id) = selector_target_ids(&runtime).await;

    let error = runtime
        .select_group_child_typed(group_id, new_child_id, StatusAdapterKind::Rpc)
        .await
        .unwrap_err();
    assert_eq!(error.kind, StatusCommandErrorKind::Timeout);
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_selection_cleanup_closes_only_fresh_old_direct_child_connections() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let cleanup_preference = PolicyGroupConnectionCleanupPreference::default();
    cleanup_preference.set_enabled(true);
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    config.connection_cleanup_preference = cleanup_preference.clone();
    config.cleanup_interval = Duration::from_millis(15);
    config.cleanup_timeout = Duration::from_millis(500);
    config.cleanup_quiet_scans = 2;
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources_and_events(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
    );
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;

    let initial = runtime.status_snapshot_typed(StatusAdapterKind::Rpc).await;
    let selector = initial
        .groups
        .iter()
        .find(|group| group.label == "SELECT")
        .unwrap();
    let group_id = selector.id.clone();
    let new_child_id = initial
        .nodes
        .iter()
        .find(|node| node.label == "节点 🚄")
        .unwrap()
        .id
        .clone();

    *fake.state.connections.write().await = connection_snapshot(vec![
        connection_value("target-flat", &["DIRECT", "SELECT"], "tcp"),
        connection_value("target-nested", &["节点 🚄", "DIRECT", "SELECT"], "tcp"),
        connection_value("target-udp", &["DIRECT", "SELECT"], "udp"),
        connection_value("already-gone", &["DIRECT", "SELECT"], "tcp"),
        connection_value("new-path", &["节点 🚄", "SELECT"], "tcp"),
        connection_value("unrelated-group", &["DIRECT", "OTHER"], "tcp"),
        connection_value("indirect-old-child", &["DIRECT", "OTHER", "SELECT"], "tcp"),
        connection_value("reversed-chain", &["SELECT", "DIRECT"], "tcp"),
        connection_value("duplicate-group", &["DIRECT", "SELECT", "SELECT"], "tcp"),
        connection_value(
            "duplicate-old-child",
            &["DIRECT", "DIRECT", "SELECT"],
            "tcp",
        ),
        connection_value("unmapped-chain", &["unmapped", "DIRECT", "SELECT"], "tcp"),
        connection_value("missing-group", &["DIRECT"], "tcp"),
    ]);
    *fake
        .state
        .late_connection
        .lock()
        .expect("late connection poisoned") = Some(connection_value(
        "late-target",
        &["DIRECT", "SELECT"],
        "tcp",
    ));
    fake.state
        .disappearing_connection_ids
        .lock()
        .expect("disappearing connection IDs poisoned")
        .insert("already-gone".into());

    let selected = runtime
        .select_group_child_typed(group_id.clone(), new_child_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    let cleanup = selected.group_selection_operation;
    assert!(cleanup.selection_confirmed);
    assert_eq!(
        cleanup.cleanup_mode,
        GroupSelectionCleanupMode::OldDirectChild
    );
    assert_eq!(cleanup.cleanup_phase, GroupSelectionCleanupPhase::Completed);
    assert_eq!(cleanup.target_count, 5);
    assert_eq!(cleanup.closed_count, 5);
    assert_eq!(cleanup.failed_count, 0);
    assert!(cleanup.scan_count >= 3);
    assert_eq!(fake.state.close_all_count.load(Ordering::Acquire), 0);
    let closed = fake
        .state
        .closed_connection_ids
        .lock()
        .expect("closed connection IDs poisoned")
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    assert_eq!(
        closed,
        [
            "already-gone",
            "late-target",
            "target-flat",
            "target-nested",
            "target-udp",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    let remaining = fake.state.connections.read().await["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|connection| connection["id"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    for preserved in [
        "new-path",
        "unrelated-group",
        "indirect-old-child",
        "reversed-chain",
        "duplicate-group",
        "duplicate-old-child",
        "unmapped-chain",
        "missing-group",
    ] {
        assert!(
            remaining.contains(preserved),
            "{preserved} must be preserved"
        );
    }

    let event_snapshot = runtime.events_snapshot(StatusAdapterKind::Rpc);
    let cleanup_event = event_snapshot["events"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|event| event["application"]["kind"] == "route.old-child-cleanup")
        .unwrap();
    let event_json = cleanup_event.to_string();
    for private in [
        "192.0.2.1",
        "198.51.100.1",
        "节点 🚄",
        "DIRECT",
        "SELECT",
        "target-flat",
        "late-target",
    ] {
        assert!(!event_json.contains(private));
    }

    cleanup_preference.set_enabled(false);
    *fake.state.connections.write().await = connection_snapshot(vec![connection_value(
        "off-preserves-existing",
        &["节点 🚄", "SELECT"],
        "tcp",
    )]);
    let refreshed = runtime.status_snapshot_typed(StatusAdapterKind::Rpc).await;
    let direct_child_id = refreshed
        .nodes
        .iter()
        .find(|node| node.label == "DIRECT")
        .unwrap()
        .id
        .clone();
    let close_count_before = fake
        .state
        .closed_connection_ids
        .lock()
        .expect("closed connection IDs poisoned")
        .len();
    let selected = runtime
        .select_group_child_typed(group_id, direct_child_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    assert_eq!(
        selected.group_selection_operation.cleanup_mode,
        GroupSelectionCleanupMode::Off
    );
    assert_eq!(
        selected.group_selection_operation.cleanup_phase,
        GroupSelectionCleanupPhase::Skipped
    );
    assert_eq!(
        fake.state
            .closed_connection_ids
            .lock()
            .expect("closed connection IDs poisoned")
            .len(),
        close_count_before
    );
    assert_eq!(
        fake.state.connections.read().await["connections"][0]["id"],
        "off-preserves-existing"
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_selection_cleanup_reports_individual_close_rejection_as_partial() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let cleanup_preference = PolicyGroupConnectionCleanupPreference::default();
    cleanup_preference.set_enabled(true);
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    config.connection_cleanup_preference = cleanup_preference;
    config.cleanup_interval = Duration::from_millis(10);
    config.cleanup_timeout = Duration::from_millis(300);
    config.cleanup_quiet_scans = 2;
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;
    let (group_id, _, new_child_id) = selector_target_ids(&runtime).await;
    *fake.state.connections.write().await = connection_snapshot(vec![
        connection_value("close-succeeds", &["DIRECT", "SELECT"], "tcp"),
        connection_value("close-rejected", &["DIRECT", "SELECT"], "udp"),
    ]);
    fake.state
        .rejected_connection_ids
        .lock()
        .expect("rejected connection IDs poisoned")
        .insert("close-rejected".into());

    let selected = runtime
        .select_group_child_typed(group_id, new_child_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    let cleanup = selected.group_selection_operation;
    assert!(cleanup.selection_confirmed);
    assert_eq!(cleanup.cleanup_phase, GroupSelectionCleanupPhase::Partial);
    assert_eq!(
        cleanup.cleanup_failure,
        Some(GroupSelectionCleanupFailure::ControllerRejected)
    );
    assert_eq!(cleanup.target_count, 2);
    assert_eq!(cleanup.closed_count, 1);
    assert_eq!(cleanup.failed_count, 1);
    assert_eq!(fake.state.close_all_count.load(Ordering::Acquire), 0);
    assert_eq!(
        fake.state.connections.read().await["connections"][0]["id"],
        "close-rejected"
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_selection_cleanup_reports_a_bounded_quiet_scan_timeout() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let cleanup_preference = PolicyGroupConnectionCleanupPreference::default();
    cleanup_preference.set_enabled(true);
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    config.connection_cleanup_preference = cleanup_preference;
    config.cleanup_interval = Duration::from_millis(20);
    config.cleanup_timeout = Duration::from_millis(60);
    config.cleanup_quiet_scans = 100;
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;
    let (group_id, _, new_child_id) = selector_target_ids(&runtime).await;
    *fake.state.connections.write().await = connection_snapshot(Vec::new());

    let selected = runtime
        .select_group_child_typed(group_id, new_child_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    let cleanup = selected.group_selection_operation;
    assert!(cleanup.selection_confirmed);
    assert_eq!(cleanup.cleanup_phase, GroupSelectionCleanupPhase::Partial);
    assert_eq!(
        cleanup.cleanup_failure,
        Some(GroupSelectionCleanupFailure::Timeout)
    );
    assert_eq!(cleanup.target_count, 0);
    assert_eq!(cleanup.closed_count, 0);
    assert!(cleanup.scan_count < 100);
    assert_eq!(fake.state.close_all_count.load(Ordering::Acquire), 0);

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn runtime_replacement_terminates_group_selection_cleanup() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let cleanup_preference = PolicyGroupConnectionCleanupPreference::default();
    cleanup_preference.set_enabled(true);
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    config.connection_cleanup_preference = cleanup_preference;
    config.cleanup_interval = Duration::from_millis(25);
    config.cleanup_timeout = Duration::from_secs(2);
    config.cleanup_quiet_scans = 100;
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources_and_events(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
    );
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;
    let (group_id, _, new_child_id) = selector_target_ids(&runtime).await;
    *fake.state.connections.write().await = connection_snapshot(Vec::new());
    let command_source = source.clone();
    let command = tokio::spawn(async move {
        command_source
            .select_group_child(group_id, new_child_id)
            .await
    });
    timeout(Duration::from_secs(1), async {
        loop {
            if fake.state.proxies.read().await["proxies"]["SELECT"]["now"] == "节点 🚄" {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("selection was not applied");

    source
        .pause_observations(RuntimeObservationPauseReason::CoreUnavailable)
        .await;
    command.await.unwrap().unwrap();
    let cleanup = runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await
        .group_selection_operation;
    assert!(cleanup.selection_confirmed);
    assert_eq!(cleanup.cleanup_phase, GroupSelectionCleanupPhase::Skipped);
    assert_eq!(
        cleanup.cleanup_failure,
        Some(GroupSelectionCleanupFailure::RuntimeReplaced)
    );
    assert_eq!(fake.state.close_all_count.load(Ordering::Acquire), 0);

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_selection_cleanup_stops_when_catalog_membership_changes() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let cleanup_preference = PolicyGroupConnectionCleanupPreference::default();
    cleanup_preference.set_enabled(true);
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    config.connection_cleanup_preference = cleanup_preference;
    config.cleanup_interval = Duration::from_millis(30);
    config.cleanup_timeout = Duration::from_secs(1);
    config.cleanup_quiet_scans = 10;
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;
    let (group_id, _, new_child_id) = selector_target_ids(&runtime).await;
    *fake.state.connections.write().await = connection_snapshot(vec![connection_value(
        "closed-before-catalog-change",
        &["DIRECT", "SELECT"],
        "tcp",
    )]);
    let command_source = source.clone();
    let command_group_id = group_id.clone();
    let command = tokio::spawn(async move {
        command_source
            .select_group_child(command_group_id, new_child_id)
            .await
    });
    wait_for(Duration::from_secs(1), || {
        fake.state
            .closed_connection_ids
            .lock()
            .expect("closed connection IDs poisoned")
            .iter()
            .any(|id| id == "closed-before-catalog-change")
    })
    .await;
    let mut changed = proxies();
    changed["proxies"]["SELECT"]["now"] = json!("节点 🚄");
    changed["proxies"]["SELECT"]["all"] = json!(["DIRECT", "节点 🚄", "EXTRA"]);
    changed["proxies"]["EXTRA"] = proxy("EXTRA", "VLESS");
    *fake.state.proxies.write().await = changed;

    command.await.unwrap().unwrap();
    let cleanup = runtime
        .status_snapshot_typed(StatusAdapterKind::Rpc)
        .await
        .group_selection_operation;
    assert_eq!(cleanup.cleanup_phase, GroupSelectionCleanupPhase::Partial);
    assert_eq!(
        cleanup.cleanup_failure,
        Some(GroupSelectionCleanupFailure::StaleRevision)
    );
    assert_eq!(cleanup.target_count, 1);
    assert_eq!(cleanup.closed_count, 1);
    assert_eq!(fake.state.close_all_count.load(Ordering::Acquire), 0);

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn second_group_switch_cancels_and_supersedes_the_old_cleanup() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let cleanup_preference = PolicyGroupConnectionCleanupPreference::default();
    cleanup_preference.set_enabled(true);
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    config.connection_cleanup_preference = cleanup_preference;
    config.cleanup_interval = Duration::from_millis(25);
    config.cleanup_timeout = Duration::from_secs(2);
    config.cleanup_quiet_scans = 10;
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources_and_events(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
    );
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;
    let (group_id, direct_child_id, new_child_id) = selector_target_ids(&runtime).await;
    *fake.state.connections.write().await = connection_snapshot(vec![connection_value(
        "first-switch-in-flight",
        &["DIRECT", "SELECT"],
        "tcp",
    )]);
    fake.state
        .connection_close_delay_milliseconds
        .store(150, Ordering::Release);

    let first_source = source.clone();
    let first_group_id = group_id.clone();
    let first = tokio::spawn(async move {
        first_source
            .select_group_child(first_group_id, new_child_id)
            .await
    });
    timeout(Duration::from_secs(1), async {
        loop {
            if fake.state.proxies.read().await["proxies"]["SELECT"]["now"] == "节点 🚄" {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("first selection was not applied");
    wait_for(Duration::from_secs(1), || {
        fake.state
            .closed_connection_ids
            .lock()
            .expect("closed connection IDs poisoned")
            .iter()
            .any(|id| id == "first-switch-in-flight")
    })
    .await;

    let second_source = source.clone();
    let second = tokio::spawn(async move {
        second_source
            .select_group_child(group_id, direct_child_id)
            .await
    });
    sleep(Duration::from_millis(25)).await;
    assert_eq!(
        fake.state.proxies.read().await["proxies"]["SELECT"]["now"],
        "节点 🚄",
        "the second PUT must wait until the in-flight old cleanup exits"
    );
    second.await.unwrap().unwrap();
    first.await.unwrap().unwrap();
    let final_snapshot = runtime.status_snapshot_typed(StatusAdapterKind::Rpc).await;
    let selected_group = final_snapshot
        .groups
        .iter()
        .find(|group| group.label == "SELECT")
        .unwrap();
    let direct_id = final_snapshot
        .nodes
        .iter()
        .find(|node| node.label == "DIRECT")
        .unwrap()
        .id
        .as_str();
    assert_eq!(selected_group.selected_child_id.as_deref(), Some(direct_id));
    assert_eq!(
        final_snapshot.group_selection_operation.cleanup_phase,
        GroupSelectionCleanupPhase::Completed
    );
    assert_eq!(
        final_snapshot.group_selection_operation.cleanup_failure,
        None
    );
    assert_eq!(fake.state.close_all_count.load(Ordering::Acquire), 0);

    let cleanup_events = runtime.events_snapshot(StatusAdapterKind::Rpc)["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["application"]["kind"] == "route.old-child-cleanup")
        .map(|event| event["application"]["data"]["phase"].clone())
        .collect::<Vec<_>>();
    assert!(cleanup_events.contains(&json!("partial")));
    assert_eq!(cleanup_events.last(), Some(&json!("completed")));

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn closing_the_source_cancels_a_pending_routing_confirmation_with_a_typed_failure() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.confirmation_timeout = Duration::from_secs(5);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        source.supports_command(StatusCommand::Routing)
    })
    .await;
    fake.state.apply_mutations.store(false, Ordering::Release);
    let mutations_before = fake.state.mutation_count.load(Ordering::Acquire);
    let command_source = source.clone();
    let command =
        tokio::spawn(async move { command_source.set_routing_mode(RoutingMode::Global).await });
    wait_for(Duration::from_secs(1), || {
        fake.state.mutation_count.load(Ordering::Acquire) > mutations_before
    })
    .await;

    source.close().await;
    let error = command.await.unwrap().unwrap_err();

    assert_eq!(error.kind, StatusCommandErrorKind::Cancelled);
    assert!(!error.to_string().contains(CONTROLLER_SECRET));
    assert_eq!(
        runtime.status_snapshot(StatusAdapterKind::Rpc).await["routingMode"],
        "rule"
    );
    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn traffic_close_connection_confirms_disappearance_and_rejects_stale_ids() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"] == "ready"
    })
    .await;
    let bridge = start_loopback_server(bridge_config(), runtime)
        .await
        .unwrap();
    let mut websocket = socket(bridge.address).await;
    authenticate(&mut websocket).await;

    let before = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":2, "method":"traffic.getSnapshot", "params":{}}),
    )
    .await["result"]
        .clone();
    let hostile = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"traffic.closeConnection",
            "params":{
                "authority": traffic_authority(&before),
                "connectionId":"connection-a",
                "url":"https://private.example.invalid/"
            }
        }),
    )
    .await;
    assert_eq!(hostile["error"]["code"], -32602);
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 0);

    let cross_profile = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":31,
            "method":"traffic.closeConnection",
            "params":{
                "authority":{
                    "profileId":"other-profile",
                    "sequence":before["sequence"],
                    "sessionId":before["sessionId"]
                },
                "connectionId":"connection-a"
            }
        }),
    )
    .await;
    assert_eq!(cross_profile["result"]["failure"], "stale-snapshot");
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 0);

    let closed = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"traffic.closeConnection",
            "params":{
                "authority":traffic_authority(&cross_profile["result"]["snapshot"]),
                "connectionId":"connection-a"
            }
        }),
    )
    .await;
    assert_eq!(closed["result"]["status"], "success");
    assert_eq!(closed["result"]["targetCount"], 1);
    assert_eq!(closed["result"]["snapshot"]["activeConnections"], json!([]));
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);

    let already_closed = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"traffic.closeConnection",
            "params":{
                "authority":traffic_authority(&closed["result"]["snapshot"]),
                "connectionId":"connection-a"
            }
        }),
    )
    .await;
    assert_eq!(already_closed["result"]["status"], "failure");
    assert_eq!(already_closed["result"]["failure"], "stale-connection");
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);
    assert!(
        !already_closed
            .to_string()
            .contains("private.example.invalid")
    );
    assert!(!already_closed.to_string().contains(CONTROLLER_SECRET));

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn traffic_close_all_targets_the_complete_current_snapshot() {
    let fake = FakeController::start().await;
    *fake.state.connections.write().await = connections_many(&["connection-a", "connection-b"]);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["activeConnections"]
            .as_array()
            .is_some_and(|connections| connections.len() == 2)
    })
    .await;
    let bridge = start_loopback_server(bridge_config(), runtime)
        .await
        .unwrap();
    let mut websocket = socket(bridge.address).await;
    authenticate(&mut websocket).await;
    let before = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":2, "method":"traffic.getSnapshot", "params":{}}),
    )
    .await["result"]
        .clone();
    let closed = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"traffic.closeAllActive",
            "params":{"authority":traffic_authority(&before)}
        }),
    )
    .await;
    assert_eq!(closed["result"]["status"], "success");
    assert_eq!(closed["result"]["operation"], "close-all-active");
    assert_eq!(closed["result"]["targetCount"], 2);
    assert_eq!(closed["result"]["snapshot"]["activeConnections"], json!([]));
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 1);

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn traffic_close_filtered_visible_is_idempotent_without_closing_newer_connections() {
    let fake = FakeController::start().await;
    *fake.state.connections.write().await =
        connections_many(&["connection-a", "connection-b", "connection-c"]);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_millis(20);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["activeConnections"]
            .as_array()
            .is_some_and(|connections| connections.len() == 3)
    })
    .await;
    let bridge = start_loopback_server(bridge_config(), runtime.clone())
        .await
        .unwrap();
    let mut websocket = socket(bridge.address).await;
    authenticate(&mut websocket).await;
    let before = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":2, "method":"traffic.getSnapshot", "params":{}}),
    )
    .await["result"]
        .clone();

    *fake.state.connections.write().await = connections_many(&[
        "connection-a",
        "connection-b",
        "connection-c",
        "connection-newer",
    ]);
    wait_for(Duration::from_secs(1), || {
        let snapshot = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
        snapshot["sequence"].as_u64() > before["sequence"].as_u64()
            && snapshot["activeConnections"]
                .as_array()
                .is_some_and(|connections| connections.len() == 4)
    })
    .await;
    let closed = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"traffic.closeFilteredVisible",
            "params":{
                "authority":traffic_authority(&before),
                "connectionIds":["connection-a", "connection-b"]
            }
        }),
    )
    .await;
    assert_eq!(closed["result"]["status"], "success");
    assert_eq!(closed["result"]["operation"], "close-filtered-visible");
    assert_eq!(closed["result"]["targetCount"], 2);
    assert_eq!(
        closed["result"]["snapshot"]["activeConnections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|connection| connection["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["connection-c", "connection-newer"]
    );
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 2);

    let mut replaced_session_authority = traffic_authority(&closed["result"]["snapshot"]);
    replaced_session_authority["sessionId"] = json!("controller-replaced");
    let replaced_session = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"traffic.closeFilteredVisible",
            "params":{
                "authority":replaced_session_authority,
                "connectionIds":["connection-c"]
            }
        }),
    )
    .await;
    assert_eq!(replaced_session["result"]["status"], "failure");
    assert_eq!(replaced_session["result"]["failure"], "stale-snapshot");
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 2);

    *fake.state.connections.write().await =
        connections_many(&["connection-newer", "connection-latest"]);
    let partially_closed = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"traffic.closeFilteredVisible",
            "params":{
                "authority":traffic_authority(&closed["result"]["snapshot"]),
                "connectionIds":["connection-c", "connection-newer"]
            }
        }),
    )
    .await;
    assert_eq!(partially_closed["result"]["status"], "success");
    assert_eq!(partially_closed["result"]["targetCount"], 2);
    assert_eq!(
        partially_closed["result"]["snapshot"]["activeConnections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|connection| connection["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["connection-latest"]
    );
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 3);

    let already_closed = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":6,
            "method":"traffic.closeFilteredVisible",
            "params":{
                "authority":traffic_authority(&partially_closed["result"]["snapshot"]),
                "connectionIds":["connection-c", "connection-newer"]
            }
        }),
    )
    .await;
    assert_eq!(already_closed["result"]["status"], "success");
    assert_eq!(already_closed["result"]["targetCount"], 2);
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 3);

    let duplicate = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":7,
            "method":"traffic.closeFilteredVisible",
            "params":{
                "authority":traffic_authority(&already_closed["result"]["snapshot"]),
                "connectionIds":["connection-latest", "connection-latest"]
            }
        }),
    )
    .await;
    assert_eq!(duplicate["error"]["code"], -32602);
    assert_eq!(fake.state.mutation_count.load(Ordering::Acquire), 3);

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn traffic_close_failures_refresh_authoritative_state_without_fake_success() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"] == "ready"
    })
    .await;
    let bridge = start_loopback_server(bridge_config(), runtime)
        .await
        .unwrap();
    let mut websocket = socket(bridge.address).await;
    authenticate(&mut websocket).await;
    let before = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":2, "method":"traffic.getSnapshot", "params":{}}),
    )
    .await["result"]
        .clone();

    fake.state
        .mutation_status
        .store(StatusCode::FORBIDDEN.as_u16().into(), Ordering::Release);
    let rejected = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"traffic.closeConnection",
            "params":{"authority":traffic_authority(&before), "connectionId":"connection-a"}
        }),
    )
    .await;
    assert_eq!(rejected["result"]["failure"], "controller-rejected");
    assert_eq!(
        rejected["result"]["snapshot"]["activeConnections"][0]["id"],
        "connection-a"
    );

    fake.state
        .mutation_status
        .store(StatusCode::NO_CONTENT.as_u16().into(), Ordering::Release);
    fake.state.apply_mutations.store(false, Ordering::Release);
    let timed_out = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"traffic.closeConnection",
            "params":{
                "authority":traffic_authority(&rejected["result"]["snapshot"]),
                "connectionId":"connection-a"
            }
        }),
    )
    .await;
    assert_eq!(timed_out["result"]["failure"], "timeout");
    assert_eq!(
        timed_out["result"]["snapshot"]["activeConnections"][0]["id"],
        "connection-a"
    );

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn traffic_close_all_reports_partial_remaining_targets() {
    let fake = FakeController::start().await;
    *fake.state.connections.write().await = connections_many(&["connection-a", "connection-b"]);
    fake.state.close_limit.store(1, Ordering::Release);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let mut config = source_config(&fake);
    config.refresh_interval = Duration::from_secs(5);
    let source = ControllerStatusSource::new(config, lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["activeConnections"]
            .as_array()
            .is_some_and(|connections| connections.len() == 2)
    })
    .await;
    let bridge = start_loopback_server(bridge_config(), runtime)
        .await
        .unwrap();
    let mut websocket = socket(bridge.address).await;
    authenticate(&mut websocket).await;
    let before = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":2, "method":"traffic.getSnapshot", "params":{}}),
    )
    .await["result"]
        .clone();
    let partial = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"traffic.closeAllActive",
            "params":{"authority":traffic_authority(&before)}
        }),
    )
    .await;
    assert_eq!(partial["result"]["failure"], "partial-remaining");
    assert_eq!(partial["result"]["targetCount"], 2);
    assert_eq!(
        partial["result"]["remainingConnectionIds"],
        json!(["connection-b"])
    );
    assert_eq!(
        partial["result"]["snapshot"]["activeConnections"][0]["id"],
        "connection-b"
    );

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    fake.shutdown().await;
}

fn traffic_authority(snapshot: &Value) -> Value {
    json!({
        "profileId": snapshot["profileId"],
        "sequence": snapshot["sequence"],
        "sessionId": snapshot["sessionId"],
    })
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
            .contains("Controller version is unsupported")
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    assert!(source.is_closed());
    fake.shutdown().await;
}

#[tokio::test]
async fn event_stream_failures_do_not_block_status_traffic_or_commands() {
    let fake = FakeController::start().await;
    fake.set_logs_available(false);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources_and_events(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
    );
    source.start().await;

    wait_for(Duration::from_secs(1), || {
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"] == "ready"
            && runtime.events_snapshot(StatusAdapterKind::Rpc)["phase"] == "unavailable"
    })
    .await;
    let status = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
    let traffic = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
    let unavailable = runtime.events_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(status["runtime"]["phase"], "healthy");
    assert_eq!(traffic["phase"], "ready");
    assert_eq!(unavailable["events"].as_array().unwrap().len(), 1);
    assert_eq!(unavailable["events"][0]["source"], "application");
    assert_eq!(unavailable["sourceStatuses"][0]["phase"], "unavailable");

    source.set_routing_mode(RoutingMode::Global).await.unwrap();
    assert_eq!(
        runtime.status_snapshot(StatusAdapterKind::Rpc).await["routingMode"],
        "global"
    );

    let unavailable_session = unavailable["sessionId"].as_str().unwrap().to_owned();
    fake.set_logs_available(true);
    wait_for(Duration::from_secs(1), || {
        let events = runtime.events_snapshot(StatusAdapterKind::Rpc);
        events["phase"] == "ready" && events["sessionId"] != unavailable_session
    })
    .await;
    let recovered = runtime.events_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(recovered["reconnectCount"], 1);
    assert_eq!(recovered["events"].as_array().unwrap().len(), 1);

    fake.state
        .logs
        .send(json!({"level": "warning", "message": 42, "fields": []}))
        .unwrap();
    wait_for(Duration::from_secs(1), || {
        runtime.events_snapshot(StatusAdapterKind::Rpc)["phase"] == "stale"
    })
    .await;
    source.set_routing_mode(RoutingMode::Rule).await.unwrap();
    assert_eq!(
        runtime.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["phase"],
        "healthy"
    );
    assert_eq!(
        runtime.traffic_snapshot(StatusAdapterKind::Rpc)["phase"],
        "ready"
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn controller_events_are_bounded_redacted_and_restart_at_reconnect_boundaries() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources_and_events(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
    );
    source.start().await;

    wait_for(Duration::from_secs(1), || {
        runtime.events_snapshot(StatusAdapterKind::Rpc)["phase"] == "ready"
    })
    .await;
    let first_session = runtime.events_snapshot(StatusAdapterKind::Rpc)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();

    fake.state
        .logs
        .send(json!({
            "time": "08:00:00",
            "level": "warning",
            "message": "failed https://fixture-user:fixture-pass@subscription.example.invalid/list?token=synthetic from /synthetic/private/profile.yaml at 198.51.100.23",
            "fields": [{"key": "token", "value": "abcdefghijklmnopqrstuvwxyz123456"}]
        }))
        .unwrap();
    wait_for(Duration::from_secs(1), || {
        runtime.events_snapshot(StatusAdapterKind::Rpc)["sequence"] == 2
    })
    .await;
    let redacted = runtime.events_snapshot(StatusAdapterKind::Rpc).to_string();
    for sensitive in [
        "fixture-user",
        "subscription.example.invalid",
        "/synthetic/private/profile.yaml",
        "198.51.100.23",
        "abcdefghijklmnopqrstuvwxyz123456",
    ] {
        assert!(!redacted.contains(sensitive));
    }
    assert!(redacted.contains("[redacted-url]"));
    assert!(redacted.contains("[redacted-path]"));

    for index in 0..1_050 {
        fake.state
            .logs
            .send(json!({
                "time": "08:00:01",
                "level": "info",
                "message": format!("synthetic event {index}"),
                "fields": []
            }))
            .unwrap();
    }
    wait_for(Duration::from_secs(3), || {
        runtime.events_snapshot(StatusAdapterKind::Rpc)["sequence"] == 1_052
    })
    .await;
    let bounded = runtime.events_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(bounded["events"].as_array().unwrap().len(), 1_024);
    assert_eq!(bounded["events"][0]["sequence"], 29);

    fake.set_available(false);
    wait_for(Duration::from_secs(1), || {
        runtime.events_snapshot(StatusAdapterKind::Rpc)["phase"] == "stale"
    })
    .await;
    fake.set_available(true);
    wait_for(Duration::from_secs(2), || {
        let snapshot = runtime.events_snapshot(StatusAdapterKind::Rpc);
        snapshot["phase"] == "ready" && snapshot["sessionId"] != first_session
    })
    .await;
    let reconnected = runtime.events_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(reconnected["reconnectCount"], 1);
    assert_eq!(reconnected["events"].as_array().unwrap().len(), 1);
    assert_eq!(reconnected["events"][0]["source"], "application");

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_delay_rpc_is_authenticated_private_group_scoped_and_partial() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    let runtime_view = runtime.clone();
    source.start().await;
    let ready = runtime_snapshot_until(&runtime_view, |snapshot| {
        snapshot["groups"]
            .as_array()
            .is_some_and(|groups| !groups.is_empty())
    })
    .await;
    let selector = ready["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["label"] == "SELECT")
        .unwrap();
    assert!(source.supports_command(StatusCommand::GroupDelay));
    let selector_id = selector["id"].as_str().unwrap().to_owned();
    let direct_id = ready["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["label"] == "DIRECT")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let unicode_id = ready["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["label"] == "节点 🚄")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let bridge = start_loopback_server(bridge_config(), runtime)
        .await
        .unwrap();
    let mut websocket = socket(bridge.address).await;
    let unauthenticated = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":1, "method":"status.startGroupDelayTest", "params":{"groupId":selector_id}}),
    )
    .await;
    assert_eq!(unauthenticated["error"]["code"], -32001);
    authenticate(&mut websocket).await;
    let hostile = rpc_request(
        &mut websocket,
        json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"status.startGroupDelayTest",
            "params":{"groupId":selector_id, "url":"https://private.example.invalid", "timeout":1}
        }),
    )
    .await;
    assert_eq!(hostile["error"]["code"], -32602);
    assert!(
        fake.state
            .delay_requests
            .lock()
            .expect("delay requests poisoned")
            .is_empty()
    );

    let started = rpc_request(
        &mut websocket,
        json!({"jsonrpc":"2.0", "id":3, "method":"status.startGroupDelayTest", "params":{"groupId":selector_id}}),
    )
    .await;
    assert_eq!(started["result"]["groupDelayTest"]["groupId"], selector_id);
    let terminal = runtime_snapshot_until(&runtime_view, |snapshot| {
        snapshot["groupDelayTest"]["phase"] == "partial"
    })
    .await;
    assert_eq!(terminal["groupDelayTest"]["profileId"], "profile-test");
    let children = terminal["groupDelayTest"]["children"].as_array().unwrap();
    let direct = children
        .iter()
        .find(|child| child["childId"] == direct_id)
        .unwrap();
    assert_eq!(direct["phase"], "success");
    assert_eq!(direct["latencyMilliseconds"], 42);
    assert!(direct["observedAt"].as_u64().is_some());
    let unicode = children
        .iter()
        .find(|child| child["childId"] == unicode_id)
        .unwrap();
    assert_eq!(unicode["phase"], "failed");
    assert_eq!(unicode["failure"], "timeout");
    assert_eq!(unicode["latencyMilliseconds"], Value::Null);
    let requests = fake
        .state
        .delay_requests
        .lock()
        .expect("delay requests poisoned")
        .clone();
    assert_eq!(requests, vec!["DIRECT", "节点 🚄"]);
    let serialized = terminal["groupDelayTest"].to_string();
    assert!(!serialized.contains(CONTROLLER_SECRET));
    assert!(!serialized.contains(mish_mihomo_controller::ROUTE_DELAY_TEST_URL));
    assert!(!serialized.contains("private.example.invalid"));

    websocket.close(None).await.unwrap();
    bridge.shutdown().await;
    fake.shutdown().await;
}

#[tokio::test]
async fn diagnostic_proxy_probe_is_fixed_scoped_redacted_and_non_mutating() {
    let fake = FakeController::start().await;
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    runtime_snapshot_until(&runtime, |snapshot| {
        snapshot["groups"]
            .as_array()
            .is_some_and(|groups| !groups.is_empty())
    })
    .await;

    let mutations_before = fake.state.mutation_count.load(Ordering::Acquire);
    let observation = runtime.run_proxy_diagnostic().await.unwrap();
    assert!(observation.group_id.starts_with("group:"));
    assert!(
        observation.child_id.starts_with("proxy:") || observation.child_id.starts_with("group:")
    );
    assert!(observation.latency_milliseconds > 0);
    assert_eq!(
        fake.state.mutation_count.load(Ordering::Acquire),
        mutations_before
    );
    assert_eq!(
        fake.state
            .delay_requests
            .lock()
            .expect("delay requests poisoned")
            .len(),
        1
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_delay_cancel_preserves_already_confirmed_results() {
    let fake = FakeController::start().await;
    fake.state.delay_mode.store(3, Ordering::Release);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    let ready = runtime_snapshot_until(&runtime, |snapshot| {
        snapshot["groups"]
            .as_array()
            .is_some_and(|groups| !groups.is_empty())
    })
    .await;
    let selector = ready["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["label"] == "SELECT")
        .unwrap();
    runtime
        .start_group_delay_test(
            selector["id"].as_str().unwrap().to_owned(),
            StatusAdapterKind::Rpc,
        )
        .await
        .unwrap();
    let progressed = runtime_snapshot_until(&runtime, |snapshot| {
        snapshot["groupDelayTest"]["children"]
            .as_array()
            .is_some_and(|children| children.iter().any(|child| child["phase"] == "success"))
    })
    .await;
    let test_id = progressed["groupDelayTest"]["testId"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancelled = runtime
        .cancel_group_delay_test(test_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    assert_eq!(cancelled["groupDelayTest"]["phase"], "cancelled");
    let children = cancelled["groupDelayTest"]["children"].as_array().unwrap();
    assert_eq!(
        children
            .iter()
            .filter(|child| child["phase"] == "success")
            .count(),
        1
    );
    assert_eq!(
        children
            .iter()
            .filter(|child| child["phase"] == "cancelled")
            .count(),
        1
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_delay_revalidates_membership_before_publishing_results() {
    let fake = FakeController::start().await;
    fake.state.delay_mode.store(2, Ordering::Release);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    let ready = runtime_snapshot_until(&runtime, |snapshot| {
        snapshot["groups"]
            .as_array()
            .is_some_and(|groups| !groups.is_empty())
    })
    .await;
    let selector = ready["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["label"] == "SELECT")
        .unwrap();
    let group_id = selector["id"].as_str().unwrap().to_owned();
    let unicode_id = ready["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["label"] == "节点 🚄")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    runtime
        .start_group_delay_test(group_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    wait_for(Duration::from_secs(1), || {
        fake.state
            .delay_requests
            .lock()
            .expect("delay requests poisoned")
            .len()
            == 2
    })
    .await;
    fake.state.proxies.write().await["proxies"]["SELECT"]["all"] = json!(["DIRECT"]);

    let terminal = runtime_snapshot_until(&runtime, |snapshot| {
        matches!(
            snapshot["groupDelayTest"]["phase"].as_str(),
            Some("partial" | "failed")
        )
    })
    .await;
    let unicode = terminal["groupDelayTest"]["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|child| child["childId"] == unicode_id)
        .unwrap();
    assert_eq!(unicode["phase"], "failed");
    assert_eq!(unicode["failure"], "stale-membership");
    assert_eq!(unicode["latencyMilliseconds"], Value::Null);

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn group_delay_cancel_stops_unstarted_work_and_never_reports_success() {
    let fake = FakeController::start().await;
    *fake.state.proxies.write().await = many_slow_proxies();
    fake.state.delay_mode.store(1, Ordering::Release);
    let lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(source_config(&fake), lifecycle.clone()).unwrap();
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    let ready = runtime_snapshot_until(&runtime, |snapshot| {
        snapshot["groups"]
            .as_array()
            .is_some_and(|groups| groups.iter().any(|group| group["label"] == "SELECT"))
    })
    .await;
    let group_id = ready["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["label"] == "SELECT")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    runtime
        .start_group_delay_test(group_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    wait_for(Duration::from_secs(1), || {
        fake.state
            .delay_requests
            .lock()
            .expect("delay requests poisoned")
            .len()
            == 4
    })
    .await;
    let active = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
    let test_id = active["groupDelayTest"]["testId"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancelled = runtime
        .cancel_group_delay_test(test_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    assert_eq!(cancelled["groupDelayTest"]["phase"], "cancelled");
    sleep(Duration::from_millis(800)).await;
    let final_snapshot = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(final_snapshot["groupDelayTest"]["phase"], "cancelled");
    assert_eq!(
        fake.state
            .delay_requests
            .lock()
            .expect("delay requests poisoned")
            .len(),
        4
    );
    assert!(
        final_snapshot["groupDelayTest"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .all(|child| child["phase"] == "cancelled")
    );

    runtime.shutdown(&core_operation()).await.unwrap();
    fake.shutdown().await;
}

#[tokio::test]
async fn runtime_replacement_cancels_old_profile_delay_context() {
    let fake = FakeController::start().await;
    *fake.state.proxies.write().await = many_slow_proxies();
    fake.state.delay_mode.store(1, Ordering::Release);
    let first_lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let first_source =
        ControllerStatusSource::new(source_config(&fake), first_lifecycle.clone()).unwrap();
    let first_runtime =
        MishRuntime::with_data_sources(first_lifecycle, first_source.clone(), first_source.clone());
    first_source.start().await;
    let ready = runtime_snapshot_until(&first_runtime, |snapshot| {
        snapshot["groups"]
            .as_array()
            .is_some_and(|groups| !groups.is_empty())
    })
    .await;
    let group_id = ready["groups"][0]["id"].as_str().unwrap().to_owned();
    first_runtime
        .start_group_delay_test(group_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    wait_for(Duration::from_secs(1), || {
        fake.state
            .delay_requests
            .lock()
            .expect("delay requests poisoned")
            .len()
            == 4
    })
    .await;
    first_runtime.shutdown(&core_operation()).await.unwrap();
    let old = first_runtime.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(old["groupDelayTest"]["phase"], "cancelled");

    *fake.state.proxies.write().await = proxies();
    fake.state.delay_mode.store(0, Ordering::Release);
    let replacement_lifecycle = Arc::new(TestLifecycle {
        stopped: AtomicBool::new(false),
    });
    let replacement_source = ControllerStatusSource::new(
        source_config_for_profile(&fake, "profile-replacement", "Replacement profile"),
        replacement_lifecycle.clone(),
    )
    .unwrap();
    let replacement_runtime = MishRuntime::with_data_sources(
        replacement_lifecycle,
        replacement_source.clone(),
        replacement_source.clone(),
    );
    replacement_source.start().await;
    let replacement = runtime_snapshot_until(&replacement_runtime, |snapshot| {
        snapshot["activeProfileId"] == "profile-replacement"
            && snapshot["runtime"]["phase"] == "healthy"
    })
    .await;
    assert_eq!(replacement["groupDelayTest"]["phase"], "idle");
    assert_eq!(replacement["groupDelayTest"]["profileId"], Value::Null);

    replacement_runtime
        .shutdown(&core_operation())
        .await
        .unwrap();
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
    runtime.shutdown(&core_operation()).await.unwrap();
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
