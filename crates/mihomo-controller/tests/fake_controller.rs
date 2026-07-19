use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Router,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{Message, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, put},
};
use futures_util::StreamExt;
use mish_mihomo_controller::{
    ControllerClient, ControllerErrorKind, ControllerLimits, HttpTransport, HttpTransportConfig,
    ROUTE_DELAY_TEST_URL,
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;

const AUTHORIZATION: &str = "Bearer synthetic-controller-token";

#[derive(Clone)]
struct FakeState;

#[derive(Default)]
struct MutationState {
    requests: Mutex<Vec<(String, String, String)>>,
}

type DelayRequest = (String, String, HashMap<String, String>);

#[derive(Default)]
struct DelayState {
    request: Mutex<Option<DelayRequest>>,
}

#[tokio::test]
async fn encodes_unicode_delay_targets_and_keeps_policy_out_of_errors() {
    async fn delay(
        Path(proxy): Path<String>,
        Query(query): Query<HashMap<String, String>>,
        headers: HeaderMap,
        State(state): State<Arc<DelayState>>,
    ) -> Response {
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        *state.request.lock().unwrap() = Some((proxy, authorization, query));
        axum::Json(json!({"delay": 73})).into_response()
    }

    let state = Arc::new(DelayState::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/proxies/{proxy}/delay", get(delay))
        .with_state(state.clone());
    let server = tokio::spawn(axum::serve(listener, app).into_future());

    let mut config = HttpTransportConfig::new(Url::parse(&format!("http://{address}/")).unwrap());
    config.secret = Some("synthetic-controller-token".into());
    let client = ControllerClient::new(
        Arc::new(HttpTransport::new(config).unwrap()),
        ControllerLimits::default(),
    )
    .unwrap();

    assert_eq!(
        client.proxy_delay("节点 / 東京 🚄").await.unwrap().delay,
        73
    );
    let request = state.request.lock().unwrap();
    let (proxy, authorization, query) = request.as_ref().unwrap();
    assert_eq!(proxy, "节点 / 東京 🚄");
    assert_eq!(authorization, AUTHORIZATION);
    assert_eq!(
        query,
        &HashMap::from([
            (
                "expected".into(),
                mish_mihomo_controller::ROUTE_DELAY_EXPECTED_STATUS.into(),
            ),
            (
                "timeout".into(),
                mish_mihomo_controller::ROUTE_DELAY_TIMEOUT_MILLISECONDS.to_string(),
            ),
            (
                "url".into(),
                mish_mihomo_controller::ROUTE_DELAY_TEST_URL.into(),
            ),
        ])
    );
    drop(request);
    server.abort();
}

#[tokio::test]
async fn rejects_zero_delay_without_treating_it_as_success() {
    async fn delay() -> Response {
        axum::Json(json!({"delay": 0})).into_response()
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route("/proxies/{proxy}/delay", get(delay));
    let server = tokio::spawn(axum::serve(listener, app).into_future());
    let client = ControllerClient::new(
        Arc::new(
            HttpTransport::new(HttpTransportConfig::new(
                Url::parse(&format!("http://{address}/")).unwrap(),
            ))
            .unwrap(),
        ),
        ControllerLimits::default(),
    )
    .unwrap();

    let error = client.proxy_delay("fixture-node").await.unwrap_err();
    assert_eq!(error.kind(), ControllerErrorKind::Validation);
    assert!(!error.to_string().contains(ROUTE_DELAY_TEST_URL));
    server.abort();
}

#[tokio::test]
async fn sends_authenticated_strict_unicode_mutations() {
    async fn record_config(
        headers: HeaderMap,
        State(state): State<Arc<MutationState>>,
        body: String,
    ) -> Response {
        record_mutation(headers, state, "/configs".into(), body)
    }

    async fn record_group(
        axum::extract::Path(group): axum::extract::Path<String>,
        headers: HeaderMap,
        State(state): State<Arc<MutationState>>,
        body: String,
    ) -> Response {
        record_mutation(headers, state, format!("/proxies/{group}"), body)
    }

    fn record_mutation(
        headers: HeaderMap,
        state: Arc<MutationState>,
        path: String,
        body: String,
    ) -> Response {
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        state
            .requests
            .lock()
            .unwrap()
            .push((path, authorization, body));
        StatusCode::NO_CONTENT.into_response()
    }

    let state = Arc::new(MutationState::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/configs", put(record_config))
        .route("/proxies/{group}", put(record_group))
        .with_state(state.clone());
    let server = tokio::spawn(axum::serve(listener, app).into_future());

    let mut config = HttpTransportConfig::new(Url::parse(&format!("http://{address}/")).unwrap());
    config.secret = Some("synthetic-controller-token".into());
    let client = ControllerClient::new(
        Arc::new(HttpTransport::new(config).unwrap()),
        ControllerLimits::default(),
    )
    .unwrap();

    client
        .set_routing_mode(mish_mihomo_controller::RoutingMode::Global)
        .await
        .unwrap();
    client
        .select_group_child("策略组 / 東京", "节点 🚄")
        .await
        .unwrap();

    let requests = state.requests.lock().unwrap();
    assert_eq!(
        requests.as_slice(),
        [
            (
                "/configs".into(),
                AUTHORIZATION.into(),
                r#"{"mode":"global"}"#.into(),
            ),
            (
                "/proxies/策略组 / 東京".into(),
                AUTHORIZATION.into(),
                r#"{"name":"节点 🚄"}"#.into(),
            ),
        ]
    );
    drop(requests);
    server.abort();
}

#[tokio::test]
async fn sends_authenticated_connection_delete_commands_and_preserves_rejection() {
    async fn record_delete(
        path: axum::extract::OriginalUri,
        headers: HeaderMap,
        State(state): State<Arc<MutationState>>,
    ) -> Response {
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        state
            .requests
            .lock()
            .unwrap()
            .push((path.0.path().into(), authorization, String::new()));
        if path.0.path().ends_with("rejected") {
            return StatusCode::FORBIDDEN.into_response();
        }
        StatusCode::NO_CONTENT.into_response()
    }

    let state = Arc::new(MutationState::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/connections", delete(record_delete))
        .route("/connections/{id}", delete(record_delete))
        .with_state(state.clone());
    let server = tokio::spawn(axum::serve(listener, app).into_future());

    let mut config = HttpTransportConfig::new(Url::parse(&format!("http://{address}/")).unwrap());
    config.secret = Some("synthetic-controller-token".into());
    let client = ControllerClient::new(
        Arc::new(HttpTransport::new(config).unwrap()),
        ControllerLimits::default(),
    )
    .unwrap();

    client.close_connection("stable-id").await.unwrap();
    client.close_all_connections().await.unwrap();
    let error = client.close_connection("rejected").await.unwrap_err();
    assert_eq!(error.kind(), ControllerErrorKind::HttpStatus);
    assert_eq!(
        state.requests.lock().unwrap().as_slice(),
        [
            (
                "/connections/stable-id".into(),
                AUTHORIZATION.into(),
                String::new(),
            ),
            ("/connections".into(), AUTHORIZATION.into(), String::new(),),
            (
                "/connections/rejected".into(),
                AUTHORIZATION.into(),
                String::new(),
            ),
        ]
    );
    server.abort();
}

#[tokio::test]
async fn reads_pinned_controller_dtos_and_cancels_websocket_streams() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/version", get(version))
        .route("/configs", get(configs))
        .route("/proxies", get(proxies))
        .route("/traffic", get(traffic))
        .route("/memory", get(memory))
        .route("/connections", get(connections))
        .route("/rules", get(rules))
        .with_state(Arc::new(FakeState));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let mut config = HttpTransportConfig::new(
        Url::parse(&format!("http://{address}/")).expect("fake controller URL is valid"),
    );
    config.secret = Some("synthetic-controller-token".into());
    config.connect_timeout = Duration::from_secs(2);
    config.request_timeout = Duration::from_secs(2);
    let transport = Arc::new(HttpTransport::new(config).unwrap());
    let client = ControllerClient::new(transport, ControllerLimits::default()).unwrap();

    assert_eq!(client.verify_version().await.unwrap().version, "v1.19.29");
    let runtime = client.runtime_config().await.unwrap();
    assert_eq!(runtime.mode, mish_mihomo_controller::RoutingMode::Rule);
    assert!(runtime.tun.enable);

    let catalog = client.proxies().await.unwrap();
    let group = catalog.proxies["Synthetic Group"].group().unwrap();
    assert_eq!(group.selected, Some("Synthetic Node"));
    assert_eq!(group.children, &["Synthetic Node"]);
    assert_eq!(catalog.proxies["Synthetic Node"].kind, "Vless");

    let snapshot = client.connections().await.unwrap();
    assert_eq!(snapshot.connections.len(), 1);
    assert_eq!(snapshot.connections[0].chains, ["Synthetic Node"]);
    assert_eq!(snapshot.connections[0].rule, "DomainSuffix");

    let rules = client.rules().await.unwrap();
    assert_eq!(rules.rules.len(), 2);
    assert_eq!(rules.effective_count(), 1);

    assert_eq!(client.traffic_snapshot().await.unwrap().up, 100);
    assert_eq!(client.memory_snapshot().await.unwrap().inuse, 0);

    let mut traffic = client.traffic_stream().await.unwrap();
    let sample = traffic.next().await.unwrap().unwrap();
    assert_eq!(sample.up_total, 300);
    assert_eq!(sample.down_total, 400);
    traffic.cancel();
    assert!(traffic.next().await.is_none());

    let mut memory = client.memory_stream().await.unwrap();
    assert_eq!(memory.next().await.unwrap().unwrap().inuse, 0);

    let mut connections = client.connection_stream().await.unwrap();
    assert_eq!(
        connections.next().await.unwrap().unwrap().connections.len(),
        1
    );
    client.shutdown();
    assert!(memory.next().await.is_none());
    assert!(connections.next().await.is_none());

    let _ = shutdown_tx.send(());
    server.await.unwrap();
}

#[tokio::test]
async fn reports_controller_authentication_failures_without_reading_the_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/version", get(version))
        .with_state(Arc::new(FakeState));
    let server = tokio::spawn(axum::serve(listener, app).into_future());

    let config = HttpTransportConfig::new(Url::parse(&format!("http://{address}/")).unwrap());
    let transport = Arc::new(HttpTransport::new(config).unwrap());
    let client = ControllerClient::new(transport, ControllerLimits::default()).unwrap();

    let error = client.version().await.unwrap_err();
    assert_eq!(error.kind(), ControllerErrorKind::HttpStatus);
    assert!(!error.to_string().contains("synthetic-controller-token"));

    server.abort();
}

async fn version(headers: HeaderMap, State(_state): State<Arc<FakeState>>) -> Response {
    authorized_json(headers, json!({"meta": true, "version": "v1.19.29"}))
}

async fn configs(headers: HeaderMap, State(_state): State<Arc<FakeState>>) -> Response {
    authorized_json(
        headers,
        json!({
            "mode": "rule",
            "tun": {
                "enable": true,
                "device": "synthetic0",
                "stack": "system",
                "auto-route": true,
                "auto-detect-interface": true
            },
            "allow-lan": false,
            "ipv6": true,
            "port": 0,
            "socks-port": 7891,
            "redir-port": 0,
            "tproxy-port": 0,
            "mixed-port": 7890,
            "log-level": "info",
            "tcp-concurrent": true,
            "find-process-mode": "strict",
            "sniffing": true,
            "interface-name": ""
        }),
    )
}

async fn proxies(headers: HeaderMap, State(_state): State<Arc<FakeState>>) -> Response {
    authorized_json(
        headers,
        json!({
            "proxies": {
                "Synthetic Group": {
                    "name": "Synthetic Group",
                    "type": "Selector",
                    "alive": true,
                    "udp": true,
                    "uot": false,
                    "xudp": false,
                    "tfo": false,
                    "mptcp": false,
                    "smux": false,
                    "history": [],
                    "all": ["Synthetic Node"],
                    "now": "Synthetic Node",
                    "hidden": false,
                    "icon": ""
                },
                "Synthetic Node": {
                    "id": "00000000-0000-4000-8000-000000000001",
                    "name": "Synthetic Node",
                    "type": "Vless",
                    "alive": true,
                    "udp": true,
                    "uot": false,
                    "xudp": true,
                    "tfo": true,
                    "mptcp": false,
                    "smux": false,
                    "interface": "",
                    "routing-mark": 0,
                    "provider-name": "",
                    "dialer-proxy": "",
                    "history": [{"time": "2026-01-01T00:00:00Z", "delay": 42}]
                }
            }
        }),
    )
}

async fn rules(headers: HeaderMap, State(_state): State<Arc<FakeState>>) -> Response {
    authorized_json(headers, rules_payload())
}

async fn traffic(
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
    State(_state): State<Arc<FakeState>>,
) -> Response {
    authorized_stream(
        headers,
        websocket,
        json!({"up": 100, "down": 200, "upTotal": 300, "downTotal": 400}),
    )
}

async fn memory(
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
    State(_state): State<Arc<FakeState>>,
) -> Response {
    authorized_stream(headers, websocket, json!({"inuse": 0, "oslimit": 0}))
}

async fn connections(
    headers: HeaderMap,
    websocket: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    State(_state): State<Arc<FakeState>>,
) -> Response {
    match websocket {
        Ok(websocket) => authorized_stream(headers, websocket, connections_payload()),
        Err(_) => authorized_json(headers, connections_payload()),
    }
}

fn authorized_json(headers: HeaderMap, value: Value) -> Response {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    axum::Json(value).into_response()
}

fn authorized_stream(headers: HeaderMap, websocket: WebSocketUpgrade, value: Value) -> Response {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    websocket
        .on_upgrade(move |mut socket| async move {
            let _ = socket.send(Message::Text(value.to_string().into())).await;
            while socket.next().await.is_some() {}
        })
        .into_response()
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(AUTHORIZATION)
}

fn connections_payload() -> Value {
    json!({
        "downloadTotal": 400,
        "uploadTotal": 300,
        "memory": 4096,
        "connections": [{
            "id": "00000000-0000-4000-8000-000000000002",
            "metadata": {
                "network": "tcp",
                "type": "HTTP",
                "sourceIP": "192.0.2.10",
                "destinationIP": "198.51.100.20",
                "sourcePort": "54321",
                "destinationPort": "443",
                "inboundIP": "127.0.0.1",
                "inboundPort": "7890",
                "inboundName": "mixed-in",
                "inboundUser": "",
                "host": "fixture.invalid",
                "dnsMode": "normal",
                "uid": 0,
                "process": "fixture-app",
                "processPath": "/synthetic/fixture-app",
                "specialProxy": "",
                "specialRules": "",
                "remoteDestination": "198.51.100.20",
                "sniffHost": ""
            },
            "upload": 30,
            "download": 40,
            "start": "2026-01-01T00:00:00Z",
            "chains": ["Synthetic Node"],
            "providerChains": [""],
            "rule": "DomainSuffix",
            "rulePayload": "fixture.invalid"
        }]
    })
}

fn rules_payload() -> Value {
    json!({
        "rules": [
            {
                "index": 0,
                "type": "DomainSuffix",
                "payload": "fixture.invalid",
                "proxy": "Synthetic Group",
                "size": -1,
                "extra": {
                    "disabled": false,
                    "hitCount": 1,
                    "hitAt": "2026-01-01T00:00:00Z",
                    "missCount": 0,
                    "missAt": "0001-01-01T00:00:00Z"
                }
            },
            {
                "index": 1,
                "type": "Match",
                "payload": "",
                "proxy": "DIRECT",
                "size": -1,
                "extra": {
                    "disabled": true,
                    "hitCount": 0,
                    "hitAt": "0001-01-01T00:00:00Z",
                    "missCount": 0,
                    "missAt": "0001-01-01T00:00:00Z"
                }
            }
        ]
    })
}
