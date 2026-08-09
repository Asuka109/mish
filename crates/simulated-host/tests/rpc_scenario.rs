use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use futures_util::{SinkExt, StreamExt};
use mish_bridge::{
    BridgeShutdownOutcome, LoopbackPortSelection, LoopbackServerConfig,
    start_loopback_server_with_runtime_host,
};
use mish_simulated_host::{
    EffectKind, EffectResultKind, PreparationPhase, ScenarioRuntime, SimulatedHostScenario,
    SyntheticProxyState, TEST_AUTH_TOKEN,
};
use serde_json::{Value, json};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const ORIGIN: &str = "http://mish.test";

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn socket(address: SocketAddr) -> Socket {
    let mut request = format!("ws://{address}/rpc").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", ORIGIN.parse().unwrap());
    connect_async(request).await.unwrap().0
}

async fn next_json(socket: &mut Socket) -> Value {
    loop {
        let message = socket.next().await.unwrap().unwrap();
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn request(socket: &mut Socket, value: Value) -> Value {
    let id = value["id"].clone();
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
    loop {
        let response = next_json(socket).await;
        if response["id"] == id {
            return response;
        }
    }
}

async fn authenticate(socket: &mut Socket) {
    let response = request(
        socket,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "rpc.authenticate",
            "params": {
                "clientName": "simulated-host-rpc-test",
                "clientVersion": "1",
                "token": TEST_AUTH_TOKEN
            }
        }),
    )
    .await;
    assert_eq!(response["result"]["authenticated"], true);
    let compatibility = request(
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

fn config(scenario: &ScenarioRuntime) -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec![ORIGIN.into()],
        auth_token: TEST_AUTH_TOKEN.into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        port_selection: LoopbackPortSelection::Fixed,
        browser_assets: None,
        browser_pairing_prompt: None,
        max_message_bytes: 1_048_576,
        profile_activation: Some(scenario.activation.clone()),
        profile_file_actions: None,
        profile_service: Some(scenario.profile_service.clone()),
        process_icon_resolver: None,
        service_probes: None,
        settings_service: None,
        updater_service: None,
    }
}

async fn settle_until(mut predicate: impl FnMut() -> bool) {
    for _ in 0..256 {
        if predicate() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("RPC scenario did not settle within the scheduler budget");
}

#[tokio::test]
async fn authenticated_clients_observe_pending_early_conflict_terminal_and_reconnect_baseline() {
    let scenario = Arc::new(
        ScenarioRuntime::build(SimulatedHostScenario::initial_foreign_listener())
            .await
            .unwrap(),
    );
    let bridge =
        start_loopback_server_with_runtime_host(config(&scenario), scenario.runtime_host.clone())
            .await
            .unwrap();
    let mut status = socket(bridge.address).await;
    let mut notifications = socket(bridge.address).await;
    let mut commander = socket(bridge.address).await;
    for client in [&mut status, &mut notifications, &mut commander] {
        authenticate(client).await;
    }
    request(
        &mut status,
        json!({"jsonrpc":"2.0","id":2,"method":"status.subscribe","params":{}}),
    )
    .await;
    request(
        &mut notifications,
        json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"notifications.subscribe",
            "params":{"clientId":"scenario-notifications","sessionId":"scenario-notifications-1"}
        }),
    )
    .await;

    let command = tokio::spawn(async move {
        request(
            &mut commander,
            json!({
                "jsonrpc":"2.0",
                "id":3,
                "method":"status.setCapture",
                "params":{
                    "active":true,
                    "selection":{"systemProxy":true,"tun":false}
                }
            }),
        )
        .await
    });
    settle_until(|| {
        scenario
            .host
            .observation()
            .transcript
            .events
            .iter()
            .any(|event| {
                event.effect_kind == EffectKind::ManagedEndpointOwnershipCheckEarly
                    && event.result_kind == EffectResultKind::ForeignOwned
            })
    })
    .await;

    let mut pending = None;
    for _ in 0..4 {
        let update = next_json(&mut status).await;
        if update["method"] == "status.snapshot"
            && update["params"]["snapshot"]["runtime"]["captureOperation"]["phase"] == "pending"
        {
            pending = Some(update);
            break;
        }
    }
    let pending = pending.expect("status subscription did not publish Pending");
    assert_eq!(
        pending["params"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "pending"
    );

    let early = next_json(&mut notifications).await;
    assert_eq!(early["method"], "notifications.snapshot");
    assert_eq!(
        early["params"]["snapshot"]["notifications"][0]["presentation"]["kind"],
        "profile.activation-listener-conflict"
    );
    assert_eq!(
        scenario.host.observation().preparation_phase,
        PreparationPhase::Finalizing
    );
    assert!(!command.is_finished());

    let mut finalizing = None;
    for _ in 0..4 {
        let update = next_json(&mut status).await;
        if update["method"] == "status.snapshot"
            && update["params"]["snapshot"]["runtime"]["captureOperation"]["phase"] == "finalizing"
        {
            finalizing = Some(update);
            break;
        }
    }
    let finalizing = finalizing.expect("status subscription did not publish Finalizing");
    assert_eq!(
        finalizing["params"]["snapshot"]["runtime"]["captureOperation"]["failure"],
        "listener-unavailable"
    );

    let mut reconnected = socket(bridge.address).await;
    authenticate(&mut reconnected).await;
    let baseline = request(
        &mut reconnected,
        json!({
            "jsonrpc":"2.0",
            "id":2,
            "method":"notifications.subscribe",
            "params":{"clientId":"scenario-reconnected","sessionId":"scenario-reconnected-1"}
        }),
    )
    .await;
    assert_eq!(
        baseline["result"]["snapshot"]["notifications"][0]["presentation"]["kind"],
        "profile.activation-listener-conflict"
    );

    scenario.host.advance_to(20).unwrap();
    let terminal = command.await.unwrap();
    assert_eq!(terminal["error"]["data"]["kind"], "listener-unavailable");
    assert_eq!(
        terminal["error"]["data"]["snapshot"]["runtime"]["captureOperation"]["phase"],
        "failed"
    );
    assert_eq!(
        terminal["error"]["data"]["snapshot"]["runtime"]["captureOperation"]["failure"],
        "listener-unavailable"
    );
    assert_eq!(
        terminal["error"]["data"]["snapshot"]["runtime"]["systemProxyEnabled"],
        false
    );

    drop(status);
    drop(notifications);
    drop(reconnected);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn authenticated_rpc_disable_tracks_logical_propagation_and_matching_terminal_authority() {
    let mut definition =
        SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::DisabledPopulated);
    definition.propagation_delay = 5;
    let scenario = Arc::new(ScenarioRuntime::build(definition).await.unwrap());
    let runtime = scenario.runtime_host.current();
    let enable = tokio::spawn(async move {
        runtime
            .set_capture(
                mish_runtime::CaptureRequest {
                    active: true,
                    selection: mish_runtime::CaptureSelection {
                        system_proxy: true,
                        tun: false,
                    },
                },
                mish_runtime::StatusAdapterKind::Rpc,
            )
            .await
    });
    settle_until(|| scenario.host.observation().pending_proxy_propagation).await;
    scenario.host.advance_to(5).unwrap();
    enable.await.unwrap().unwrap();

    let bridge =
        start_loopback_server_with_runtime_host(config(&scenario), scenario.runtime_host.clone())
            .await
            .unwrap();
    let mut status = socket(bridge.address).await;
    let mut commander = socket(bridge.address).await;
    for client in [&mut status, &mut commander] {
        authenticate(client).await;
    }
    request(
        &mut status,
        json!({"jsonrpc":"2.0","id":2,"method":"status.subscribe","params":{}}),
    )
    .await;

    let command = tokio::spawn(async move {
        request(
            &mut commander,
            json!({
                "jsonrpc":"2.0",
                "id":3,
                "method":"status.setCapture",
                "params":{
                    "active":false,
                    "selection":{"systemProxy":true,"tun":false}
                }
            }),
        )
        .await
    });
    settle_until(|| scenario.host.observation().pending_proxy_propagation).await;

    let mut pending = None;
    for _ in 0..6 {
        let update = next_json(&mut status).await;
        if update["method"] == "status.snapshot"
            && update["params"]["snapshot"]["runtime"]["captureOperation"]["phase"] == "pending"
        {
            pending = Some(update);
            break;
        }
    }
    let pending = pending.expect("status subscription did not publish disable Pending");
    let operation_id =
        pending["params"]["snapshot"]["runtime"]["captureOperation"]["operationId"].clone();
    assert_eq!(
        pending["params"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "pending"
    );
    assert!(!command.is_finished());

    scenario.host.advance_to(10).unwrap();
    let terminal = command.await.unwrap();
    assert_eq!(
        terminal["result"]["runtime"]["captureOperation"]["operationId"],
        operation_id
    );
    assert_eq!(
        terminal["result"]["runtime"]["captureOperation"]["phase"],
        "applied"
    );
    assert_eq!(terminal["result"]["runtime"]["systemProxy"]["phase"], "off");
    assert_eq!(terminal["result"]["runtime"]["systemProxyEnabled"], false);
    assert_eq!(
        serde_json::to_value(scenario.runtime_host.notification_snapshot()).unwrap()["notifications"],
        json!([])
    );
    assert!(scenario.host.journal_snapshot().is_none());

    let mut reconnected = socket(bridge.address).await;
    authenticate(&mut reconnected).await;
    let baseline = request(
        &mut reconnected,
        json!({"jsonrpc":"2.0","id":2,"method":"status.subscribe","params":{}}),
    )
    .await;
    assert_eq!(
        baseline["result"]["snapshot"]["runtime"]["captureOperation"]["operationId"],
        operation_id
    );
    assert_eq!(
        baseline["result"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "off"
    );

    drop(status);
    drop(reconnected);
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}
