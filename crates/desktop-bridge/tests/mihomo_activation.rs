use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::WebSocketUpgrade,
    extract::ws::Message as AxumMessage,
    response::{IntoResponse, Response},
    routing::get,
};
use mish_bridge::{
    ActivationFailureKind, ActivationOutcome, ActivationTiming, ManagedMihomoResolver,
    ManagedRuntimePolicy, MihomoActivationError, MihomoActivationManager, MihomoResolveError,
    RuntimeConfigGenerator,
};
use mish_profile::{
    FileProfileRepository, Fingerprint, ImmutableRevision, NORMALIZED_ARTIFACT_SCHEMA_VERSION,
    NormalizedArtifact, PROFILE_SCHEMA_VERSION, ProfileAttempt, ProfileId, ProfileMetadata,
    ProfileRecord, ProfileSource, ProfileStatus, Provenance, RevisionId, SourceSummary, Timestamp,
    ValidationResult, ValidationStatus,
};
use mish_runtime::StatusAdapterKind;
use serde_json::json;
use serde_norway::Value;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use uuid::Uuid;

#[test]
fn generated_runtime_config_reasserts_application_and_capture_policy() {
    let normalized = br#"
port: 1234
mixed-port: 7890
allow-lan: true
bind-address: 0.0.0.0
external-controller: 0.0.0.0:9999
secret: source-secret
log-level: debug
mode: global
listeners:
  - name: unsafe-listener
tun:
  enable: true
sniffer:
  enable: true
profile:
  store-selected: true
  store-fake-ip: true
proxies:
  - name: synthetic-node
    type: direct
rules:
  - MATCH,DIRECT
"#;
    let policy = ManagedRuntimePolicy::new(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43123),
        "application-controller-secret",
    )
    .unwrap();

    let generated = RuntimeConfigGenerator::generate(normalized, &policy).unwrap();
    let document: Value = serde_norway::from_slice(&generated).unwrap();
    let root = document.as_mapping().unwrap();

    assert_eq!(root["port"].as_i64(), Some(0));
    assert_eq!(root["socks-port"].as_i64(), Some(0));
    assert_eq!(root["redir-port"].as_i64(), Some(0));
    assert_eq!(root["tproxy-port"].as_i64(), Some(0));
    assert_eq!(root["mixed-port"].as_i64(), Some(0));
    assert_eq!(root["allow-lan"].as_bool(), Some(false));
    assert_eq!(root["bind-address"].as_str(), Some("127.0.0.1"));
    assert_eq!(
        root["external-controller"].as_str(),
        Some("127.0.0.1:43123")
    );
    assert_eq!(
        root["secret"].as_str(),
        Some("application-controller-secret")
    );
    assert_eq!(root["log-level"].as_str(), Some("warning"));
    assert_eq!(root["mode"].as_str(), Some("rule"));
    assert!(root["listeners"].as_sequence().unwrap().is_empty());
    assert_eq!(root["tun"]["enable"].as_bool(), Some(false));
    assert_eq!(root["sniffer"]["enable"].as_bool(), Some(false));
    assert_eq!(root["profile"]["store-selected"].as_bool(), Some(false));
    assert_eq!(root["profile"]["store-fake-ip"].as_bool(), Some(false));
    assert!(root["proxies"].as_sequence().is_some());
    assert!(root["rules"].as_sequence().is_some());
}

#[test]
fn generated_runtime_config_rejects_provider_path_escape_without_echoing_it() {
    let normalized = br#"
proxy-providers:
  private-provider:
    type: file
    path: ../../do-not-leak-private-provider.yaml
rules:
  - MATCH,DIRECT
"#;
    let policy = ManagedRuntimePolicy::new(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43123),
        "application-controller-secret",
    )
    .unwrap();

    let error = RuntimeConfigGenerator::generate(normalized, &policy).unwrap_err();

    assert_eq!(
        error,
        mish_bridge::RuntimeConfigGenerationError::UnsafeManagedPath
    );
    assert!(!error.to_string().contains("do-not-leak"));
}

#[test]
fn managed_binary_resolution_is_explicit_and_offline() {
    let root = std::env::temp_dir().join(format!("mish-resolver-{}", Uuid::new_v4()));
    let development_binary = root.join("prepared/mihomo");
    std::fs::create_dir_all(development_binary.parent().unwrap()).unwrap();
    std::fs::write(&development_binary, b"synthetic binary").unwrap();

    let development = ManagedMihomoResolver::development(
        development_binary.clone(),
        root.join("development-runtime"),
    )
    .resolve()
    .unwrap();
    assert_eq!(development.binary(), development_binary);

    let resource_directory = root.join("resources");
    std::fs::create_dir_all(&resource_directory).unwrap();
    let production_binary =
        resource_directory.join(ManagedMihomoResolver::production_sidecar_name());
    std::fs::write(&production_binary, b"synthetic sidecar").unwrap();
    let production =
        ManagedMihomoResolver::production(resource_directory, root.join("production-runtime"))
            .resolve()
            .unwrap();
    assert_eq!(production.binary(), production_binary);

    let packaged_directory = root.join("packaged-resources");
    std::fs::create_dir_all(&packaged_directory).unwrap();
    let packaged_binary = packaged_directory.join(ManagedMihomoResolver::production_runtime_name());
    std::fs::write(&packaged_binary, b"synthetic packaged sidecar").unwrap();
    let packaged = ManagedMihomoResolver::production(
        packaged_directory,
        root.join("packaged-production-runtime"),
    )
    .resolve()
    .unwrap();
    assert_eq!(packaged.binary(), packaged_binary);

    let missing = ManagedMihomoResolver::production(
        root.join("missing-resources"),
        root.join("missing-runtime"),
    )
    .resolve()
    .unwrap_err();
    assert_eq!(missing, MihomoResolveError::BinaryMissing);
    assert!(!missing.to_string().contains(root.to_str().unwrap()));
}

#[tokio::test]
async fn activation_commits_only_after_controller_readiness_and_first_snapshot() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-activation-{}", Uuid::new_v4()));
    let binary = fixture("fake-activation-mihomo.sh");
    let manager = MihomoActivationManager::new(
        ManagedMihomoResolver::development(binary, root.join("runtime")),
        ActivationTiming {
            config_validation_timeout: Duration::from_secs(1),
            controller_connect_timeout: Duration::from_millis(250),
            controller_request_timeout: Duration::from_millis(250),
            readiness_timeout: Duration::from_secs(2),
            refresh_interval: Duration::from_secs(1),
            reconnect_delay: Duration::from_millis(25),
        },
    );
    let policy =
        ManagedRuntimePolicy::new(controller.address, "synthetic-application-secret").unwrap();
    let record = profile_record(
        br#"
proxies:
  - name: synthetic-node
    type: direct
proxy-groups:
  - name: synthetic-group
    type: select
    proxies: [DIRECT]
rules:
  - MATCH,DIRECT
"#,
    );
    let repository = FileProfileRepository::new(root.join("profiles"));
    repository.save(&record).unwrap();
    let persisted = repository.load(&record.metadata.id).unwrap();

    let committed = manager.activate(&persisted, &policy).await.unwrap();

    assert_eq!(committed.profile_id(), record.metadata.id.as_str());
    assert_eq!(
        committed.fingerprint(),
        record.metadata.artifact.fingerprint.as_str()
    );
    let runtime = manager.active_runtime().await.unwrap();
    let snapshot = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(snapshot["activeProfileId"], record.metadata.id.as_str());
    assert_eq!(snapshot["runtime"]["phase"], "healthy");
    assert_eq!(snapshot["groups"][0]["label"], "synthetic-group");
    assert_eq!(snapshot["metrics"]["effectiveRules"], 1);
    let traffic = runtime.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(traffic["phase"], "ready");
    assert_eq!(traffic["profileId"], record.metadata.id.as_str());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let state_mode = std::fs::metadata(root.join("runtime/activation-state.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(state_mode, 0o600);
        let candidate = std::fs::read_dir(root.join("runtime/candidates"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            std::fs::metadata(&candidate).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(candidate.join("config.yaml"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(candidate.join("home"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    manager.shutdown().await.unwrap();
    controller.shutdown().await;
}

#[tokio::test]
async fn invalid_candidate_preserves_prior_core_and_records_a_redacted_attempt() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-rollback-{}", Uuid::new_v4()));
    let manager = MihomoActivationManager::new(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            root.join("private-runtime"),
        ),
        ActivationTiming {
            config_validation_timeout: Duration::from_secs(1),
            controller_connect_timeout: Duration::from_millis(250),
            controller_request_timeout: Duration::from_millis(250),
            readiness_timeout: Duration::from_secs(2),
            refresh_interval: Duration::from_secs(1),
            reconnect_delay: Duration::from_millis(25),
        },
    );
    let policy =
        ManagedRuntimePolicy::new(controller.address, "do-not-leak-controller-secret").unwrap();
    let prior = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    manager.activate(&prior, &policy).await.unwrap();
    let candidate = profile_record(
        br#"
activation-test-invalid: true
proxies:
  - name: do-not-leak-private-node
    type: direct
    password: do-not-leak-proxy-secret
rules:
  - MATCH,DIRECT
"#,
    );

    let error = manager.activate(&candidate, &policy).await.unwrap_err();

    assert_eq!(error, MihomoActivationError::ValidationFailed);
    let error_text = error.to_string();
    for private in [
        root.to_str().unwrap(),
        "do-not-leak-controller-secret",
        "do-not-leak-private-node",
        "do-not-leak-proxy-secret",
    ] {
        assert!(!error_text.contains(private));
    }
    let managed = manager.managed_state().await;
    assert_eq!(
        managed.active_profile_id(),
        Some(prior.metadata.id.as_str())
    );
    let attempt = managed.last_attempt().unwrap();
    assert_eq!(attempt.profile_id(), candidate.metadata.id.as_str());
    assert_eq!(attempt.outcome(), ActivationOutcome::Failed);
    assert_eq!(attempt.failure(), Some(ActivationFailureKind::Validation));
    assert!(attempt.attempted_at_unix_milliseconds() > 0);
    let persisted_state =
        std::fs::read_to_string(root.join("private-runtime/activation-state.json")).unwrap();
    for private in [
        root.to_str().unwrap(),
        "do-not-leak-controller-secret",
        "do-not-leak-private-node",
        "do-not-leak-proxy-secret",
        "http://",
    ] {
        assert!(!persisted_state.contains(private));
    }
    let snapshot = manager
        .active_runtime()
        .await
        .unwrap()
        .status_snapshot(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(snapshot["activeProfileId"], prior.metadata.id.as_str());
    assert_eq!(snapshot["runtime"]["phase"], "healthy");

    manager.shutdown().await.unwrap();
    controller.shutdown().await;
}

#[tokio::test]
async fn candidate_early_exit_rolls_back_to_the_prior_healthy_core() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-early-exit-{}", Uuid::new_v4()));
    let manager = MihomoActivationManager::new(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            root.join("runtime"),
        ),
        ActivationTiming {
            config_validation_timeout: Duration::from_secs(1),
            controller_connect_timeout: Duration::from_millis(100),
            controller_request_timeout: Duration::from_millis(100),
            readiness_timeout: Duration::from_secs(2),
            refresh_interval: Duration::from_secs(1),
            reconnect_delay: Duration::from_millis(25),
        },
    );
    let prior_policy = ManagedRuntimePolicy::new(controller.address, "prior-secret").unwrap();
    let prior = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    manager.activate(&prior, &prior_policy).await.unwrap();
    let candidate =
        profile_record(b"activation-test-early-exit: true\nproxies: []\nrules: [MATCH,DIRECT]\n");
    let unavailable = unused_loopback_address();
    let candidate_policy = ManagedRuntimePolicy::new(unavailable, "candidate-secret").unwrap();

    let error = manager
        .activate(&candidate, &candidate_policy)
        .await
        .unwrap_err();

    assert_eq!(error, MihomoActivationError::EarlyExit);
    let managed = manager.managed_state().await;
    assert_eq!(
        managed.active_profile_id(),
        Some(prior.metadata.id.as_str())
    );
    assert_eq!(
        managed.last_attempt().unwrap().failure(),
        Some(ActivationFailureKind::EarlyExit)
    );
    let status = manager.active_runtime().await.unwrap().core_status().await;
    assert!(matches!(status.phase, mish_runtime::CorePhase::Running));

    manager.shutdown().await.unwrap();
    controller.shutdown().await;
}

#[tokio::test]
async fn controller_timeout_preserves_the_prior_healthy_core() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-timeout-{}", Uuid::new_v4()));
    let manager = activation_manager(&root, Duration::from_millis(250));
    let prior_policy = ManagedRuntimePolicy::new(controller.address, "prior-secret").unwrap();
    let prior = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    manager.activate(&prior, &prior_policy).await.unwrap();
    let candidate = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let candidate_policy =
        ManagedRuntimePolicy::new(unused_loopback_address(), "candidate-secret").unwrap();

    let error = manager
        .activate(&candidate, &candidate_policy)
        .await
        .unwrap_err();

    assert_eq!(error, MihomoActivationError::ReadinessTimeout);
    let managed = manager.managed_state().await;
    assert_eq!(
        managed.active_profile_id(),
        Some(prior.metadata.id.as_str())
    );
    assert_eq!(
        managed.last_attempt().unwrap().failure(),
        Some(ActivationFailureKind::Timeout)
    );
    manager.shutdown().await.unwrap();
    controller.shutdown().await;
}

#[tokio::test]
async fn controller_version_mismatch_preserves_the_prior_healthy_core() {
    let controller = FakeController::start("v1.19.29").await;
    let incompatible = FakeController::start("v1.20.0").await;
    let root = std::env::temp_dir().join(format!("mish-version-{}", Uuid::new_v4()));
    let manager = activation_manager(&root, Duration::from_secs(2));
    let prior_policy = ManagedRuntimePolicy::new(controller.address, "prior-secret").unwrap();
    let prior = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    manager.activate(&prior, &prior_policy).await.unwrap();
    let candidate = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let candidate_policy =
        ManagedRuntimePolicy::new(incompatible.address, "candidate-secret").unwrap();

    let error = manager
        .activate(&candidate, &candidate_policy)
        .await
        .unwrap_err();

    assert_eq!(error, MihomoActivationError::VersionMismatch);
    let managed = manager.managed_state().await;
    assert_eq!(
        managed.active_profile_id(),
        Some(prior.metadata.id.as_str())
    );
    assert_eq!(
        managed.last_attempt().unwrap().failure(),
        Some(ActivationFailureKind::VersionMismatch)
    );
    manager.shutdown().await.unwrap();
    incompatible.shutdown().await;
    controller.shutdown().await;
}

#[tokio::test]
async fn managed_binary_version_mismatch_never_starts_or_commits() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-binary-version-{}", Uuid::new_v4()));
    let manager = MihomoActivationManager::new(
        ManagedMihomoResolver::development(
            fixture("fake-activation-wrong-version.sh"),
            root.join("runtime"),
        ),
        ActivationTiming::default(),
    );
    let policy = ManagedRuntimePolicy::new(controller.address, "candidate-secret").unwrap();
    let candidate = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");

    let error = manager.activate(&candidate, &policy).await.unwrap_err();

    assert_eq!(error, MihomoActivationError::VersionMismatch);
    assert!(!error.to_string().contains("private-build-detail"));
    let managed = manager.managed_state().await;
    assert!(managed.is_safe_stopped());
    assert_eq!(
        managed.last_attempt().unwrap().failure(),
        Some(ActivationFailureKind::VersionMismatch)
    );
    assert!(manager.active_runtime().await.is_none());
    controller.shutdown().await;
}

#[tokio::test]
async fn invalid_controller_snapshot_preserves_the_prior_healthy_core() {
    let controller = FakeController::start("v1.19.29").await;
    let invalid = FakeController::start_with_catalog("v1.19.29", invalid_proxy_catalog()).await;
    let root = std::env::temp_dir().join(format!("mish-controller-failure-{}", Uuid::new_v4()));
    let manager = activation_manager(&root, Duration::from_secs(2));
    let prior_policy = ManagedRuntimePolicy::new(controller.address, "prior-secret").unwrap();
    let prior = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    manager.activate(&prior, &prior_policy).await.unwrap();
    let candidate = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let candidate_policy = ManagedRuntimePolicy::new(invalid.address, "candidate-secret").unwrap();

    let error = manager
        .activate(&candidate, &candidate_policy)
        .await
        .unwrap_err();

    assert_eq!(error, MihomoActivationError::ControllerFailure);
    let managed = manager.managed_state().await;
    assert_eq!(
        managed.active_profile_id(),
        Some(prior.metadata.id.as_str())
    );
    assert_eq!(
        managed.last_attempt().unwrap().failure(),
        Some(ActivationFailureKind::Controller)
    );
    manager.shutdown().await.unwrap();
    invalid.shutdown().await;
    controller.shutdown().await;
}

#[tokio::test]
async fn active_state_commit_failure_restores_the_prior_core() {
    let prior_controller = FakeController::start("v1.19.29").await;
    let candidate_controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-state-commit-{}", Uuid::new_v4()));
    let manager = activation_manager(&root, Duration::from_secs(2));
    let prior_policy = ManagedRuntimePolicy::new(prior_controller.address, "prior-secret").unwrap();
    let prior = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    manager.activate(&prior, &prior_policy).await.unwrap();
    let state_path = root.join("runtime/activation-state.json");
    let saved_state = root.join("runtime/activation-state.saved");
    std::fs::rename(&state_path, &saved_state).unwrap();
    std::fs::create_dir(&state_path).unwrap();
    let candidate = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let candidate_policy =
        ManagedRuntimePolicy::new(candidate_controller.address, "candidate-secret").unwrap();

    let error = manager
        .activate(&candidate, &candidate_policy)
        .await
        .unwrap_err();

    assert_eq!(error, MihomoActivationError::StateCommitFailed);
    let managed = manager.managed_state().await;
    assert_eq!(
        managed.active_profile_id(),
        Some(prior.metadata.id.as_str())
    );
    assert_eq!(
        managed.last_attempt().unwrap().failure(),
        Some(ActivationFailureKind::StateCommit)
    );
    let prior_status = manager.active_runtime().await.unwrap().core_status().await;
    assert!(matches!(
        prior_status.phase,
        mish_runtime::CorePhase::Running
    ));

    let blocked_state = root.join("runtime/activation-state.blocked");
    std::fs::rename(&state_path, blocked_state).unwrap();
    std::fs::rename(saved_state, &state_path).unwrap();
    manager.shutdown().await.unwrap();
    candidate_controller.shutdown().await;
    prior_controller.shutdown().await;
}

fn activation_manager(
    root: &std::path::Path,
    readiness_timeout: Duration,
) -> MihomoActivationManager {
    MihomoActivationManager::new(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            root.join("runtime"),
        ),
        ActivationTiming {
            config_validation_timeout: Duration::from_secs(1),
            controller_connect_timeout: Duration::from_millis(100),
            controller_request_timeout: Duration::from_millis(100),
            readiness_timeout,
            refresh_interval: Duration::from_secs(1),
            reconnect_delay: Duration::from_millis(25),
        },
    )
}

fn unused_loopback_address() -> SocketAddr {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    address
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn profile_record(normalized_bytes: &[u8]) -> ProfileRecord {
    let source_bytes = normalized_bytes.to_vec();
    let revision_id = RevisionId::from_source(&source_bytes);
    let fingerprint = Fingerprint::from_normalized_artifact(normalized_bytes);
    let id = ProfileId::new();
    let timestamp = Timestamp::from_unix_milliseconds(1_784_422_800_000);
    ProfileRecord {
        metadata: ProfileMetadata {
            artifact: NormalizedArtifact {
                byte_length: normalized_bytes.len() as u64,
                fingerprint: fingerprint.clone(),
                revision_id: revision_id.clone(),
                schema_version: NORMALIZED_ARTIFACT_SCHEMA_VERSION,
            },
            id,
            label: "Synthetic activation profile".into(),
            last_attempt: None::<ProfileAttempt>,
            last_success: None,
            provenance: Provenance {
                imported_at: timestamp,
                source: SourceSummary {
                    display: "synthetic.yaml".into(),
                    source_type: mish_profile::ProfileSourceType::LocalFile,
                },
                source_revision: revision_id.clone(),
            },
            revision: ImmutableRevision {
                byte_length: source_bytes.len() as u64,
                created_at: timestamp,
                id: revision_id,
                media_type: Some("application/yaml".into()),
            },
            schema_version: PROFILE_SCHEMA_VERSION,
            status: ProfileStatus {
                active: false,
                error: false,
                stale: false,
                updating: false,
                valid: true,
                warning: false,
            },
            validation: ValidationResult {
                errors: Vec::new(),
                status: ValidationStatus::Valid,
                warnings: Vec::new(),
            },
        },
        normalized_bytes: normalized_bytes.to_vec(),
        source: ProfileSource::local_file(PathBuf::from("/synthetic/profile.yaml")).unwrap(),
        source_bytes,
    }
}

struct FakeController {
    address: SocketAddr,
    join: JoinHandle<()>,
    shutdown: oneshot::Sender<()>,
}

impl FakeController {
    async fn start(version: &'static str) -> Self {
        Self::start_with_catalog(version, proxy_catalog()).await
    }

    async fn start_with_catalog(version: &'static str, catalog: serde_json::Value) -> Self {
        let app = Router::new()
            .route(
                "/version",
                get(move || async move { Json(json!({"meta": true, "version": version})) }),
            )
            .route("/configs", get(|| async { Json(runtime_config()) }))
            .route(
                "/proxies",
                get(move || {
                    let catalog = catalog.clone();
                    async move { Json(catalog) }
                }),
            )
            .route("/rules", get(|| async { Json(rule_list()) }))
            .route("/connections", get(|| async { Json(connections()) }))
            .route("/traffic", get(traffic_stream))
            .route("/memory", get(memory_stream));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown, shutdown_rx) = oneshot::channel();
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
            shutdown,
        }
    }

    async fn shutdown(self) {
        let _ = self.shutdown.send(());
        self.join.await.unwrap();
    }
}

async fn traffic_stream(websocket: WebSocketUpgrade) -> Response {
    websocket
        .on_upgrade(|mut socket| async move {
            let _ = socket
                .send(AxumMessage::Text(
                    json!({"up": 0, "down": 0, "upTotal": 0, "downTotal": 0})
                        .to_string()
                        .into(),
                ))
                .await;
            std::future::pending::<()>().await;
        })
        .into_response()
}

async fn memory_stream(websocket: WebSocketUpgrade) -> Response {
    websocket
        .on_upgrade(|mut socket| async move {
            let _ = socket
                .send(AxumMessage::Text(
                    json!({"inuse": 0, "oslimit": 0}).to_string().into(),
                ))
                .await;
            std::future::pending::<()>().await;
        })
        .into_response()
}

fn runtime_config() -> serde_json::Value {
    json!({
        "mode": "rule", "tun": {"enable": false}, "allow-lan": false,
        "ipv6": false, "port": 0, "socks-port": 0, "redir-port": 0,
        "tproxy-port": 0, "mixed-port": 0, "log-level": "warning",
        "tcp-concurrent": false, "find-process-mode": "off", "sniffing": false,
        "interface-name": ""
    })
}

fn proxy_catalog() -> serde_json::Value {
    json!({"proxies": {
        "DIRECT": {
            "name": "DIRECT", "type": "Direct", "alive": true, "udp": true,
            "uot": false, "xudp": false, "tfo": false, "mptcp": false,
            "smux": false, "history": []
        },
        "synthetic-group": {
            "name": "synthetic-group", "type": "Selector", "alive": true,
            "udp": true, "uot": false, "xudp": false, "tfo": false,
            "mptcp": false, "smux": false, "history": [],
            "all": ["DIRECT"], "now": "DIRECT"
        }
    }})
}

fn invalid_proxy_catalog() -> serde_json::Value {
    let mut catalog = proxy_catalog();
    catalog["proxies"]["synthetic-group"]["now"] = json!("missing-child");
    catalog
}

fn rule_list() -> serde_json::Value {
    json!({"rules": [{
        "index": 0, "type": "MATCH", "payload": "", "proxy": "DIRECT", "size": -1
    }]})
}

fn connections() -> serde_json::Value {
    json!({"downloadTotal": 0, "uploadTotal": 0, "memory": 0, "connections": []})
}
