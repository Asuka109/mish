use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use futures_util::{SinkExt, StreamExt};
use mish_agent::{AgentConfig, CoreConfig, start_agent};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

const TOKEN: &str = "test-token-123456789";
const ORIGIN: &str = "http://mish.test";

fn config(core: CoreConfig) -> AgentConfig {
    AgentConfig {
        allowed_origins: vec![ORIGIN.into()],
        auth_token: TOKEN.into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        core,
        max_message_bytes: 1_048_576,
    }
}

fn no_core() -> CoreConfig {
    CoreConfig {
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

#[tokio::test]
async fn rejects_unauthenticated_and_malformed_requests() {
    let agent = start_agent(config(no_core())).await.unwrap();
    let mut ws = socket(agent.address).await;

    let unauthenticated = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":1, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(unauthenticated["error"]["code"], -32001);

    ws.send(Message::Text("{".into())).await.unwrap();
    let Message::Text(response) = ws.next().await.unwrap().unwrap() else {
        panic!("expected text response")
    };
    let malformed: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(malformed["error"]["code"], -32700);
    agent.shutdown().await;
}

#[tokio::test]
async fn authenticates_and_serves_contract_compatible_status() {
    let agent = start_agent(config(no_core())).await.unwrap();
    let mut ws = socket(agent.address).await;
    authenticate(&mut ws).await;

    let info = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":2, "method":"agent.getInfo", "params":{}}),
    )
    .await;
    assert_eq!(info["result"]["protocolVersion"], 1);
    assert_eq!(info["result"]["coreConfigured"], false);

    let snapshot = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":3, "method":"status.getSnapshot", "params":{}}),
    )
    .await;
    assert_eq!(snapshot["result"]["adapterKind"], "rpc");
    assert_eq!(snapshot["result"]["runtime"]["phase"], "inactive");

    let unavailable = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":4, "method":"core.start", "params":{}}),
    )
    .await;
    assert_eq!(unavailable["error"]["code"], -32010);
    agent.shutdown().await;
}

#[tokio::test]
async fn rejects_an_untrusted_websocket_origin() {
    let agent = start_agent(config(no_core())).await.unwrap();
    let mut request = format!("ws://{}/rpc", agent.address)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://attacker.example".parse().unwrap());
    let error = tokio_tungstenite::connect_async(request).await.unwrap_err();
    assert!(error.to_string().contains("403"));
    agent.shutdown().await;
}

#[tokio::test]
async fn manages_an_explicit_sidecar_and_stops_it_during_shutdown() {
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-mihomo.sh");
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let agent = start_agent(config(CoreConfig {
        binary: Some(binary),
        config_directory: Some(directory),
        config_file: None,
    }))
    .await
    .unwrap();
    let mut ws = socket(agent.address).await;
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
    agent.shutdown().await;
}

#[tokio::test]
async fn refuses_non_loopback_binding() {
    let mut unsafe_config = config(no_core());
    unsafe_config.bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
    let error = match start_agent(unsafe_config).await {
        Ok(agent) => {
            agent.shutdown().await;
            panic!("unsafe binding was accepted")
        }
        Err(error) => error,
    };
    assert!(error.contains("loopback"));
}
