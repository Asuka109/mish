use std::{
    env, fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};

use futures_util::{
    SinkExt, StreamExt,
    future::{BoxFuture, ready},
};
use mish_bridge::{
    ActivationTiming, DesktopMihomoProcess, DesktopMihomoProcessConfig, DesktopRuntimeHost,
    LoopbackServerConfig, ManagedMihomoResolver, ManagedRuntimePolicy, MihomoActivationManager,
    ProfileActivationCoordinator, ReqwestHttpsSourceReader, start_loopback_server,
    start_loopback_server_with_runtime_host,
};
use mish_runtime::{
    CaptureJournal, CaptureJournalStore, CapturePlatform, CaptureReconciler,
    CaptureTransitionError, CoreError, CorePhase, CoreRuntime, CoreStatus, LoopbackProxyEndpoint,
    MishRuntime, NetworkServiceProxyState,
};
use serde_json::{Value, json};
use tokio::time::{Duration, timeout};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

const TOKEN: &str = "test-token-123456789";
const ORIGIN: &str = "http://mish.test";

struct RunningCore;

impl CoreRuntime for RunningCore {
    fn configured(&self) -> bool {
        true
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

fn config() -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec![ORIGIN.into()],
        auth_token: TOKEN.into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        max_message_bytes: 1_048_576,
        profile_activation: None,
        profile_service: None,
    }
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

    ws.send(Message::Text("{".into())).await.unwrap();
    let Message::Text(response) = ws.next().await.unwrap().unwrap() else {
        panic!("expected text response")
    };
    let malformed: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(malformed["error"]["code"], -32700);
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
    assert_eq!(info["result"]["protocolVersion"], 3);
    assert_eq!(
        info["result"]["statusCommands"],
        json!({"group": false, "routing": false})
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

    let unavailable = request(
        &mut ws,
        json!({"jsonrpc":"2.0", "id":7, "method":"core.start", "params":{}}),
    )
    .await;
    assert_eq!(unavailable["error"]["code"], -32010);
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

    bridge.shutdown().await;
    let _ = fs::remove_dir_all(root);
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

    let rejected = request(
        &mut ws,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"profiles.activate",
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
            json!({"connectionId": "fixture"}),
        ),
        (8, "traffic.closeAll", json!({})),
    ] {
        let response = request(
            &mut ws,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .await;
        assert_eq!(response["error"]["code"], -32601);
        assert!(response.get("result").is_none());
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
    assert_eq!(tun["error"]["data"]["kind"], "unsupported-selection");
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
    let Message::Text(applied_notification) = ws.next().await.unwrap().unwrap() else {
        panic!("expected applied status notification")
    };
    let applied_notification: Value = serde_json::from_str(&applied_notification).unwrap();
    assert_eq!(
        applied_notification["params"]["subscriptionId"],
        subscription_id
    );
    assert_eq!(
        applied_notification["params"]["snapshot"]["runtime"]["systemProxy"]["phase"],
        "applied"
    );
    let external = NetworkServiceProxyState {
        http: mish_runtime::ManualProxyState {
            authenticated: false,
            enabled: true,
            host: Some("external.rpc-fixture.invalid".into()),
            port: Some(3128),
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
