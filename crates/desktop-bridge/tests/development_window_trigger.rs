#![cfg(feature = "development-window-trigger")]

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures_util::future::join_all;
use mish_bridge::{
    BridgeShutdownOutcome, DesktopMihomoProcess, DesktopMihomoProcessConfig, DesktopRuntimeHost,
    DevelopmentWindowTrigger, DevelopmentWindowTriggerConfig, LoopbackPortSelection,
    LoopbackServerConfig, LoopbackServerHandle,
    start_loopback_server_with_runtime_host_lifecycle_and_development_window_trigger,
};
use mish_runtime::MishRuntime;
use reqwest::{Client, StatusCode, header};
use serde_json::json;

#[derive(Default)]
struct SingleWindowAuthority {
    created: AtomicBool,
    creations: AtomicUsize,
    requests: AtomicUsize,
}

impl DevelopmentWindowTrigger for SingleWindowAuthority {
    fn trigger(&self) -> Result<(), String> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        if self
            .created
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.creations.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

struct FailingWindowAuthority;

impl DevelopmentWindowTrigger for FailingWindowAuthority {
    fn trigger(&self) -> Result<(), String> {
        Err("synthetic window failure containing no capability".into())
    }
}

fn config() -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec!["http://127.0.0.1:4173".into()],
        auth_token: "development-window-trigger-test-token".into(),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        port_selection: LoopbackPortSelection::Fixed,
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

async fn start_trigger(
    action: Arc<dyn DevelopmentWindowTrigger>,
    lifetime: Duration,
) -> LoopbackServerHandle {
    let runtime = MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
        DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        },
    )));
    start_loopback_server_with_runtime_host_lifecycle_and_development_window_trigger(
        config(),
        DesktopRuntimeHost::new(runtime),
        None,
        DevelopmentWindowTriggerConfig::with_lifetime(action, lifetime),
    )
    .await
    .expect("development trigger server should start")
}

fn trigger_capability(bridge: &LoopbackServerHandle) -> String {
    let url = bridge
        .development_window_trigger()
        .expect("development trigger handle")
        .issue_url();
    let url = url::Url::parse(&url).expect("valid trigger URL");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/__openWindow");
    assert!(url.query().is_none());
    url.fragment()
        .and_then(|fragment| fragment.strip_prefix("token="))
        .expect("fragment capability")
        .to_owned()
}

async fn post_trigger(
    client: &Client,
    address: SocketAddr,
    capability: &str,
    request_id: &str,
) -> reqwest::Response {
    let origin = format!("http://{address}");
    client
        .post(format!("{origin}/__openWindow"))
        .header(header::ORIGIN, &origin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(
            serde_json::to_vec(&json!({
                "capability": capability,
                "requestId": request_id,
            }))
            .unwrap(),
        )
        .send()
        .await
        .expect("trigger request")
}

async fn shutdown(bridge: LoopbackServerHandle) {
    assert!(matches!(
        bridge.shutdown().await,
        BridgeShutdownOutcome::Confirmed(_)
    ));
}

#[tokio::test]
async fn trigger_assets_keep_the_capability_in_the_fragment_and_apply_strict_headers() {
    let bridge = start_trigger(
        Arc::new(SingleWindowAuthority::default()),
        Duration::from_secs(60),
    )
    .await;
    let handle = bridge.development_window_trigger().unwrap();
    let url = handle.issue_url();
    let capability = trigger_capability(&bridge);
    let client = Client::new();

    let page = client.get(&url).send().await.unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(page.headers()[header::REFERRER_POLICY], "no-referrer");
    assert!(
        page.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    let body = page.text().await.unwrap();
    assert!(!body.contains(&capability));
    assert!(body.contains("/__openWindow.js"));

    let asset = client
        .get(format!("http://{}/__openWindow.js", bridge.address))
        .send()
        .await
        .unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert!(!asset.text().await.unwrap().contains(&capability));
    assert_eq!(
        client
            .get(format!("http://{}/__openWindow-client.js", bridge.address))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(format!(
                "http://{}/development-window-trigger",
                bridge.address
            ))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    shutdown(bridge).await;
}

#[tokio::test]
async fn repeated_and_concurrent_fresh_requests_create_only_one_window() {
    let action = Arc::new(SingleWindowAuthority::default());
    let bridge = start_trigger(action.clone(), Duration::from_secs(60)).await;
    let capability = trigger_capability(&bridge);
    let client = Client::new();
    let requests = (0..16).map(|index| {
        let client = client.clone();
        let capability = capability.clone();
        let address = bridge.address;
        let request_id = format!("{index:02}{}", "a".repeat(41));
        async move { post_trigger(&client, address, &capability, &request_id).await }
    });
    let responses = join_all(requests).await;

    assert!(
        responses
            .iter()
            .all(|response| response.status() == StatusCode::NO_CONTENT)
    );
    assert_eq!(action.requests.load(Ordering::SeqCst), 16);
    assert_eq!(action.creations.load(Ordering::SeqCst), 1);
    shutdown(bridge).await;
}

#[tokio::test]
async fn exact_replay_malformed_cross_origin_and_localhost_alias_requests_fail_closed() {
    let action = Arc::new(SingleWindowAuthority::default());
    let bridge = start_trigger(action.clone(), Duration::from_secs(60)).await;
    let capability = trigger_capability(&bridge);
    let request_id = "r".repeat(43);
    let client = Client::new();

    assert_eq!(
        post_trigger(&client, bridge.address, &capability, &request_id)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post_trigger(&client, bridge.address, &capability, &request_id)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_trigger(&client, bridge.address, &capability, "short")
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );

    let origin = format!("http://{}", bridge.address);
    let body = json!({ "capability": capability, "requestId": "s".repeat(43) });
    let missing_origin = client
        .post(format!("{origin}/__openWindow"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
    let localhost_alias = client
        .post(format!("{origin}/__openWindow"))
        .header(header::HOST, format!("localhost:{}", bridge.address.port()))
        .header(header::ORIGIN, &origin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(localhost_alias.status(), StatusCode::FORBIDDEN);
    assert_eq!(action.requests.load(Ordering::SeqCst), 1);
    shutdown(bridge).await;
}

#[tokio::test]
async fn expired_and_replaced_process_capabilities_fail_closed() {
    let expired = start_trigger(
        Arc::new(SingleWindowAuthority::default()),
        Duration::from_millis(1),
    )
    .await;
    let expired_capability = trigger_capability(&expired);
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(
        post_trigger(
            &Client::new(),
            expired.address,
            &expired_capability,
            &"e".repeat(43),
        )
        .await
        .status(),
        StatusCode::GONE
    );
    shutdown(expired).await;

    let prior = start_trigger(
        Arc::new(SingleWindowAuthority::default()),
        Duration::from_secs(60),
    )
    .await;
    let prior_capability = trigger_capability(&prior);
    shutdown(prior).await;
    let replacement_action = Arc::new(SingleWindowAuthority::default());
    let replacement = start_trigger(replacement_action.clone(), Duration::from_secs(60)).await;
    assert_eq!(
        post_trigger(
            &Client::new(),
            replacement.address,
            &prior_capability,
            &"p".repeat(43),
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(replacement_action.requests.load(Ordering::SeqCst), 0);
    shutdown(replacement).await;
}

#[tokio::test]
async fn window_failure_is_bounded_and_does_not_stop_the_backend() {
    let bridge = start_trigger(Arc::new(FailingWindowAuthority), Duration::from_secs(60)).await;
    let capability = trigger_capability(&bridge);
    let client = Client::new();
    assert_eq!(
        post_trigger(&client, bridge.address, &capability, &"f".repeat(43))
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        client
            .get(format!("http://{}/health", bridge.address))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    shutdown(bridge).await;
}
