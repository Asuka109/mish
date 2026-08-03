use std::{
    env,
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
    DesktopRuntimeHost, LoopbackPortSelection, LoopbackServerConfig, ProfileActivationCoordinator,
    start_loopback_server_with_runtime_host,
};
use mish_platform_macos::internal_tun_maintenance::MaintenanceCommitPoint;
use mish_runtime::{CaptureAuditReason, CaptureReconciler};
use mish_settings::{SettingsAdapterKind, SettingsService};
use mish_simulated_host::{
    EffectKind, InjectedFailure, InjectedFailureKind, MaintenanceScenario,
    MaintenanceScenarioRuntime, ScenarioRuntime, SimulatedHost, SimulatedHostScenario,
    SyntheticMaintenanceInitial, SyntheticPackageVersion, SyntheticProxyState, TEST_AUTH_TOKEN,
    TEST_CONTROL_KEY,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::net::TcpListener;

const HARNESS_SCENARIO_ENV: &str = "MISH_SIMULATED_SCENARIO";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HarnessScenario {
    Cancelled,
    CommitDrift,
    ConfirmedRollback,
    EarlyConflict,
    HelperInstall,
    HelperRepair,
    RecoveryRequired,
    Replacement,
}

impl HarnessScenario {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "cancelled" => Some(Self::Cancelled),
            "commit-drift" => Some(Self::CommitDrift),
            "confirmed-rollback" => Some(Self::ConfirmedRollback),
            "early-conflict" => Some(Self::EarlyConflict),
            "helper-install" => Some(Self::HelperInstall),
            "helper-repair" => Some(Self::HelperRepair),
            "recovery-required" => Some(Self::RecoveryRequired),
            "replacement" => Some(Self::Replacement),
            _ => None,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::CommitDrift => "commit-drift",
            Self::ConfirmedRollback => "confirmed-rollback",
            Self::EarlyConflict => "early-conflict",
            Self::HelperInstall => "helper-install",
            Self::HelperRepair => "helper-repair",
            Self::RecoveryRequired => "recovery-required",
            Self::Replacement => "replacement",
        }
    }

    const fn uses_activation(self) -> bool {
        matches!(
            self,
            Self::Cancelled | Self::CommitDrift | Self::EarlyConflict
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessDescriptor {
    auth_token: &'static str,
    control_key: &'static str,
    control_url: String,
    rpc_url: String,
    scenario: &'static str,
}

enum HarnessRuntime {
    Maintenance(Arc<MaintenanceScenarioRuntime>),
    Standard(Arc<ScenarioRuntime>),
}

impl HarnessRuntime {
    fn activation(&self) -> Arc<ProfileActivationCoordinator> {
        match self {
            Self::Maintenance(runtime) => runtime.activation.clone(),
            Self::Standard(runtime) => runtime.activation.clone(),
        }
    }

    fn capture(&self) -> Arc<CaptureReconciler> {
        match self {
            Self::Maintenance(runtime) => runtime.capture.clone(),
            Self::Standard(runtime) => runtime.capture.clone(),
        }
    }

    fn host(&self) -> Arc<SimulatedHost> {
        match self {
            Self::Maintenance(runtime) => runtime.host.clone(),
            Self::Standard(runtime) => runtime.host.clone(),
        }
    }

    fn profile_service(&self) -> Arc<mish_bridge::DesktopProfileService> {
        match self {
            Self::Maintenance(runtime) => runtime.profile_service.clone(),
            Self::Standard(runtime) => runtime.profile_service.clone(),
        }
    }

    fn runtime_host(&self) -> DesktopRuntimeHost {
        match self {
            Self::Maintenance(runtime) => runtime.runtime_host.clone(),
            Self::Standard(runtime) => runtime.runtime_host.clone(),
        }
    }

    fn settings_service(&self) -> Option<Arc<SettingsService>> {
        match self {
            Self::Maintenance(runtime) => Some(runtime.settings_service.clone()),
            Self::Standard(_) => None,
        }
    }

    fn replace_runtime(&self) -> Option<Arc<CaptureReconciler>> {
        match self {
            Self::Maintenance(_) => None,
            Self::Standard(runtime) => Some(runtime.replace_runtime()),
        }
    }
}

#[derive(Clone)]
struct HarnessState {
    capture: Arc<std::sync::Mutex<Arc<CaptureReconciler>>>,
    runtime: Arc<HarnessRuntime>,
    scenario: HarnessScenario,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceSignals {
    journal_present: bool,
    maintenance: Option<Value>,
    pending_proxy_propagation: bool,
    preparation_phase: mish_simulated_host::PreparationPhase,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessEvidence {
    logical_time: u64,
    scenario: &'static str,
    signals: EvidenceSignals,
    terminal_authority: Value,
    transcript: mish_simulated_host::SemanticTranscript,
}

fn bridge_config(state: &HarnessState) -> LoopbackServerConfig {
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
        profile_activation: state
            .scenario
            .uses_activation()
            .then(|| state.runtime.activation()),
        profile_file_actions: None,
        profile_service: Some(state.runtime.profile_service()),
        process_icon_resolver: None,
        service_probes: None,
        settings_service: state.runtime.settings_service(),
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

async fn evidence(state: &HarnessState) -> HarnessEvidence {
    let observation = state.runtime.host().observation();
    let capture = serde_json::to_value(
        state
            .capture
            .lock()
            .expect("harness capture lock poisoned")
            .status(),
    )
    .expect("closed Capture projection must serialize");
    let notifications = serde_json::to_value(state.runtime.runtime_host().notification_snapshot())
        .expect("closed Notification snapshot must serialize");
    let bounded_notifications = notifications["notifications"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .take(8)
        .map(|record| {
            json!({
                "failure": record["presentation"]["data"]["failure"],
                "kind": record["presentation"]["kind"],
                "operation": record["presentation"]["data"]["operation"],
                "outcome": record["presentation"]["data"]["outcome"],
                "pinned": record["pinned"],
                "presentationPhase": record["presentationState"]["phase"],
                "resolved": record["resolved"],
                "revision": record["revision"],
            })
        })
        .collect::<Vec<_>>();
    let helper = state.runtime.settings_service().map(|settings| {
        let snapshot = serde_json::to_value(settings.snapshot(SettingsAdapterKind::Rpc))
            .expect("closed Settings snapshot must serialize");
        json!({
            "availability": snapshot["tunHelper"]["availability"],
            "health": snapshot["tunHelper"]["health"],
            "lastFailure": snapshot["tunHelper"]["lastFailure"],
            "phase": snapshot["tunHelper"]["phase"],
            "revision": snapshot["revision"],
        })
    });
    let maintenance = observation.maintenance.as_ref().map(|maintenance| {
        json!({
            "activeOperation": maintenance.active_operation,
            "captureRestorePending": maintenance.capture_restore_pending,
            "journalPresent": maintenance.journal_present,
            "package": maintenance.package,
            "recoveryRequired": maintenance.recovery_required,
        })
    });
    let terminal_identity = observation.transcript.events.last().map(|event| {
        json!({
            "admittedRevision": event.admitted_revision,
            "authorityId": event.authority_id,
            "runtimeId": event.runtime_id,
            "scopeEpoch": event.scope_epoch,
        })
    });
    let terminal_scope_epoch = terminal_identity
        .as_ref()
        .map(|identity| identity["scopeEpoch"].clone());
    HarnessEvidence {
        logical_time: observation.logical_time,
        scenario: state.scenario.name(),
        signals: EvidenceSignals {
            journal_present: observation.journal_present,
            maintenance,
            pending_proxy_propagation: observation.pending_proxy_propagation,
            preparation_phase: observation.preparation_phase,
        },
        terminal_authority: json!({
            "captureOperation": {
                "operationId": capture["captureOperation"]["operationId"],
                "phase": capture["captureOperation"]["phase"],
                "scopeEpoch": terminal_scope_epoch,
            },
            "identity": terminal_identity,
            "notifications": bounded_notifications,
            "runtimePhase": observation.core_phase,
            "systemProxy": {
                "enabled": capture["systemProxyEnabled"],
                "failure": capture["systemProxy"]["failure"],
                "observed": capture["systemProxy"]["observed"],
                "phase": capture["systemProxy"]["phase"],
            },
            "tun": {
                "enabled": capture["tunEnabled"],
                "failure": capture["tun"]["failure"],
                "observed": capture["tun"]["observed"],
                "phase": capture["tun"]["phase"],
            },
            "tunHelper": helper,
        }),
        transcript: observation.transcript,
    }
}

async fn advance(
    State(state): State<HarnessState>,
    Path((logical_time, key)): Path<(u64, String)>,
) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    if state.runtime.host().advance_to(logical_time).is_err() {
        return cors(StatusCode::CONFLICT);
    }
    cors(Json(evidence(&state).await))
}

async fn observation(State(state): State<HarnessState>, Path(key): Path<String>) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    cors(Json(evidence(&state).await))
}

async fn audit_system_proxy(
    State(state): State<HarnessState>,
    Path(key): Path<String>,
) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    let _ = state
        .runtime
        .runtime_host()
        .audit_capture(CaptureAuditReason::NetworkChanged)
        .await;
    cors(Json(evidence(&state).await))
}

async fn cancel_activation(State(state): State<HarnessState>, Path(key): Path<String>) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    let activation = state.runtime.activation();
    let snapshot = activation.activation_snapshot().await;
    let Some(command_id) = snapshot.command_id else {
        return cors(StatusCode::CONFLICT);
    };
    let _ = activation.cancel(&command_id).await;
    cors(Json(evidence(&state).await))
}

async fn replace_runtime(State(state): State<HarnessState>, Path(key): Path<String>) -> Response {
    if key != TEST_CONTROL_KEY {
        return cors(StatusCode::FORBIDDEN);
    }
    let Some(capture) = state.runtime.replace_runtime() else {
        return cors(StatusCode::CONFLICT);
    };
    *state.capture.lock().expect("harness capture lock poisoned") = capture;
    cors(Json(evidence(&state).await))
}

fn rollback_scenario(recovery_required: bool) -> SimulatedHostScenario {
    let mut scenario = SimulatedHostScenario::system_proxy_transaction(SyntheticProxyState::Manual);
    scenario.failures.push(InjectedFailure {
        after_effect: None,
        effect: EffectKind::CaptureWriteHttps,
        kind: InjectedFailureKind::Operation,
        occurrence: 1,
    });
    if recovery_required {
        scenario.failures.push(InjectedFailure {
            after_effect: Some(EffectKind::CaptureWriteHttps),
            effect: EffectKind::CaptureObserve,
            kind: InjectedFailureKind::Observation,
            occurrence: 1,
        });
    }
    scenario
}

async fn build_runtime(
    scenario: HarnessScenario,
) -> Result<HarnessRuntime, Box<dyn std::error::Error>> {
    match scenario {
        HarnessScenario::Cancelled | HarnessScenario::CommitDrift => {
            Ok(HarnessRuntime::Standard(Arc::new(
                ScenarioRuntime::build(SimulatedHostScenario::ownership_changes_before_commit())
                    .await?,
            )))
        }
        HarnessScenario::ConfirmedRollback => Ok(HarnessRuntime::Standard(Arc::new(
            ScenarioRuntime::build(rollback_scenario(false)).await?,
        ))),
        HarnessScenario::EarlyConflict => Ok(HarnessRuntime::Standard(Arc::new(
            ScenarioRuntime::build(SimulatedHostScenario::initial_foreign_listener()).await?,
        ))),
        HarnessScenario::HelperInstall | HarnessScenario::HelperRepair => {
            let initial = if scenario == HarnessScenario::HelperInstall {
                SyntheticMaintenanceInitial::Absent
            } else {
                SyntheticMaintenanceInitial::RepairRequired
            };
            let runtime = Arc::new(
                MaintenanceScenarioRuntime::build(
                    SimulatedHostScenario::internal_tun_maintenance(),
                    MaintenanceScenario {
                        faults: Vec::new(),
                        initial,
                        pause_at: None,
                        pause_until: None,
                        target: SyntheticPackageVersion::V2,
                    },
                )
                .await?,
            );
            runtime
                .maintenance
                .pause_at(MaintenanceCommitPoint::IntentPersisted, 1)?;
            Ok(HarnessRuntime::Maintenance(runtime))
        }
        HarnessScenario::RecoveryRequired => Ok(HarnessRuntime::Standard(Arc::new(
            ScenarioRuntime::build(rollback_scenario(true)).await?,
        ))),
        HarnessScenario::Replacement => {
            let mut definition = SimulatedHostScenario::system_proxy_transaction(
                SyntheticProxyState::DisabledPopulated,
            );
            definition.propagation_delay = 5;
            Ok(HarnessRuntime::Standard(Arc::new(
                ScenarioRuntime::build(definition).await?,
            )))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scenario_value = env::var(HARNESS_SCENARIO_ENV)
        .map_err(|_| format!("{HARNESS_SCENARIO_ENV} must select a closed harness scenario"))?;
    let scenario = HarnessScenario::parse(&scenario_value)
        .ok_or_else(|| format!("unsupported simulated scenario: {scenario_value}"))?;
    let runtime = Arc::new(build_runtime(scenario).await?);
    let state = HarnessState {
        capture: Arc::new(std::sync::Mutex::new(runtime.capture())),
        runtime,
        scenario,
    };
    let bridge = start_loopback_server_with_runtime_host(
        bridge_config(&state),
        state.runtime.runtime_host(),
    )
    .await?;
    let control_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let control_address = control_listener.local_addr()?;
    let control_shutdown = tokio_util::sync::CancellationToken::new();
    let control_shutdown_signal = control_shutdown.clone();
    let control = Router::new()
        .route("/advance/{logical_time}/{key}", post(advance))
        .route("/audit-system-proxy/{key}", post(audit_system_proxy))
        .route("/cancel-activation/{key}", post(cancel_activation))
        .route("/observation/{key}", get(observation))
        .route("/replace-runtime/{key}", post(replace_runtime))
        .with_state(state);
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
            scenario: scenario.name(),
        })?
    );
    std::io::stdout().flush()?;

    tokio::signal::ctrl_c().await?;
    control_shutdown.cancel();
    let _ = control_task.await;
    let _ = bridge.shutdown().await;
    Ok(())
}
