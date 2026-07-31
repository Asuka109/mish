use std::{
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mish_bridge::{
    LoopbackPortSelection, LoopbackServerConfig, start_loopback_server_with_runtime_host,
};
use mish_runtime::{CaptureAuditReason, CaptureRequest, CaptureSelection, StatusAdapterKind};
use mish_simulated_host::{
    ScenarioRuntime, SimulatedHostScenario, TEST_AUTH_TOKEN, TEST_CONTROL_KEY,
};
use serde::Serialize;
use tokio::net::TcpListener;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessDescriptor {
    auth_token: &'static str,
    control_key: &'static str,
    control_url: String,
    rpc_url: String,
}

#[derive(Clone)]
struct HarnessState {
    scenario: Arc<ScenarioRuntime>,
}

fn bridge_config(scenario: &ScenarioRuntime) -> LoopbackServerConfig {
    LoopbackServerConfig {
        allowed_origins: vec![
            "http://localhost:63315".into(),
            "http://127.0.0.1:63315".into(),
        ],
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

fn cors(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

async fn advance(
    State(state): State<HarnessState>,
    Path((key, logical_time)): Path<(String, u64)>,
) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    match state.scenario.host.advance_to(logical_time) {
        Ok(()) => cors(Json(state.scenario.host.observation())),
        Err(_) => cors(StatusCode::CONFLICT),
    }
}

async fn observation(State(state): State<HarnessState>, Path(key): Path<String>) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    cors(Json(state.scenario.host.observation()))
}

async fn prime_system_proxy(
    State(state): State<HarnessState>,
    Path(key): Path<String>,
) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    let logical_time = state.scenario.host.observation().logical_time;
    if logical_time < 21 && state.scenario.host.advance_to(21).is_err() {
        return cors(StatusCode::CONFLICT);
    }
    let activation = state.scenario.activation.clone();
    tokio::spawn(async move {
        let _ = activation
            .set_capture(
                CaptureRequest {
                    active: true,
                    selection: CaptureSelection {
                        system_proxy: true,
                        tun: false,
                    },
                },
                StatusAdapterKind::Rpc,
            )
            .await;
    });
    cors(StatusCode::ACCEPTED)
}

async fn audit_system_proxy(
    State(state): State<HarnessState>,
    Path(key): Path<String>,
) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    let _ = state
        .scenario
        .runtime_host
        .audit_capture(CaptureAuditReason::NetworkChanged)
        .await;
    cors(Json(state.scenario.host.observation()))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario =
        Arc::new(ScenarioRuntime::build(SimulatedHostScenario::browser_journey()).await?);
    let bridge = start_loopback_server_with_runtime_host(
        bridge_config(&scenario),
        scenario.runtime_host.clone(),
    )
    .await?;
    let control_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let control_address = control_listener.local_addr()?;
    let control_shutdown = tokio_util::sync::CancellationToken::new();
    let control_shutdown_signal = control_shutdown.clone();
    let control = Router::new()
        .route("/advance/{key}/{logical_time}", post(advance))
        .route("/audit-system-proxy/{key}", post(audit_system_proxy))
        .route("/observation/{key}", get(observation))
        .route("/prime-system-proxy/{key}", post(prime_system_proxy))
        .with_state(HarnessState {
            scenario: scenario.clone(),
        });
    let control_task = tokio::spawn(async move {
        axum::serve(control_listener, control)
            .with_graceful_shutdown(control_shutdown_signal.cancelled_owned())
            .await
    });

    println!(
        "{}",
        serde_json::to_string(&HarnessDescriptor {
            auth_token: TEST_AUTH_TOKEN,
            control_key: TEST_CONTROL_KEY,
            control_url: format!("http://{control_address}"),
            rpc_url: format!("ws://{}/rpc", bridge.address),
        })?
    );
    std::io::stdout().flush()?;

    tokio::signal::ctrl_c().await?;
    control_shutdown.cancel();
    let _ = control_task.await;
    let _ = bridge.shutdown().await;
    Ok(())
}
