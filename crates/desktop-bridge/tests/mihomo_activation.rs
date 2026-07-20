use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::ws::Message as AxumMessage,
    extract::{State, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{
    FutureExt,
    future::{BoxFuture, ready},
};
use mish_bridge::{
    ActivationFailureKind, ActivationOutcome, ActivationTiming, DesktopMihomoProcess,
    DesktopMihomoProcessConfig, DesktopRuntimeHost, ManagedMihomoResolver, ManagedRuntimePolicy,
    MihomoActivationError, MihomoActivationManager, MihomoResolveError,
    ProfileActivationCoordinator, ProfileActivationPhase, ReqwestHttpsSourceReader,
    RuntimeConfigGenerator,
};
use mish_profile::{
    FileProfileRepository, Fingerprint, HttpsSourceReader, ImmutableRevision,
    NORMALIZED_ARTIFACT_SCHEMA_VERSION, NormalizedArtifact, PROFILE_SCHEMA_VERSION, ProfileAttempt,
    ProfileId, ProfileMetadata, ProfilePatch, ProfilePatchOperation, ProfilePatchSet,
    ProfileRecord, ProfileRefreshTrigger, ProfileService, ProfileSource, ProfileSourceType,
    ProfileStatus, Provenance, RedirectTarget, RevisionId, RuleInsertPosition, SensitiveUrl,
    SourceContent, SourceReadError, SourceReadPolicy, SourceSummary, StdLocalSourceReader,
    StructuredRule, Timestamp, ValidationResult, ValidationStatus,
};
use mish_runtime::{
    CaptureAuditReason, CaptureJournal, CaptureJournalStore, CapturePlatform, CaptureReconciler,
    CaptureRecoveryAction, CaptureRequest, CaptureSelection, CaptureTransitionError,
    LoopbackProxyEndpoint, ManualProxyState, MishRuntime, NetworkServiceProxyState, RoutingMode,
    StatusAdapterKind, TunHelperAvailability, TunHelperHealth, TunHelperLifecyclePhase,
    TunHelperSnapshot,
};
use serde_json::json;
use serde_norway::Value;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const P0_PROFILE: &[u8] = include_bytes!("fixtures/p0-profile.yaml");

#[tokio::test]
async fn empty_app_data_startup_keeps_service_presets_across_runtime_hydration_and_relaunch() {
    let root = tempfile::tempdir().unwrap();
    let app_data_root = root.path().join("app-data");
    assert!(!app_data_root.exists());

    let profile_root = app_data_root.join("profiles");
    let importing = ProfileService::new(
        profile_root.clone(),
        StdLocalSourceReader,
        FixtureHttpsReader::new(P0_PROFILE),
        SourceReadPolicy::default(),
    );
    let preview = importing
        .preflight_local(
            fixture("p0-profile.yaml"),
            Some("Cold start fixture".to_owned()),
        )
        .await
        .unwrap();
    let profiles = importing.save_preview(&preview.preview_id).await.unwrap();
    let profile_id = profiles.profiles[0].id.clone();
    drop(importing);

    let controller = P0Controller::start().await;
    let profiles = Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let manager = Arc::new(MihomoActivationManager::new(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            app_data_root.join("runtime"),
        ),
        activation_timing(Duration::from_secs(2)),
    ));
    let safe_runtime = MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
        DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        },
    )));
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    assert_default_service_presets(&host.status_snapshot(StatusAdapterKind::Rpc).await);

    let address = controller.address;
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host.clone(),
        safe_runtime,
        move || ManagedRuntimePolicy::new(address, "cold-start-controller-authentication"),
    ));
    let mut updates = coordinator.subscribe();
    coordinator
        .activate(&Uuid::new_v4().to_string(), &profile_id)
        .await
        .unwrap();
    let activated = wait_for_activation(&coordinator, &mut updates).await;
    assert_eq!(activated.phase, ProfileActivationPhase::Success);

    let first_launch = host.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(first_launch["runtime"]["phase"], "healthy");
    assert_default_service_presets(&first_launch);
    assert_eq!(first_launch["probeResults"], json!([]));

    coordinator.shutdown().await.unwrap();
    let subsequent_runtime = MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
        DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        },
    )));
    let subsequent_launch = DesktopRuntimeHost::new(subsequent_runtime)
        .status_snapshot(StatusAdapterKind::Rpc)
        .await;
    assert_eq!(subsequent_launch["runtime"]["phase"], "inactive");
    assert_default_service_presets(&subsequent_launch);
    assert_eq!(subsequent_launch["probeResults"], json!([]));

    controller.shutdown().await;
}

#[tokio::test]
async fn macos_p0_fixture_journey_imports_operates_restarts_recovers_and_stops() {
    let root = tempfile::tempdir().unwrap();
    let profile_root = root.path().join("profiles");
    let importing = ProfileService::new(
        profile_root.clone(),
        StdLocalSourceReader,
        FixtureHttpsReader::new(P0_PROFILE),
        SourceReadPolicy::default(),
    );

    let local_preview = importing
        .preflight_local(fixture("p0-profile.yaml"), Some("Local fixture".to_owned()))
        .await
        .unwrap();
    assert_eq!(local_preview.source_type, ProfileSourceType::LocalFile);
    assert_eq!(local_preview.proxy_count, 1);
    assert_eq!(local_preview.group_count, 1);
    assert_eq!(local_preview.rule_count, 2);
    let local_snapshot = importing
        .save_preview(&local_preview.preview_id)
        .await
        .unwrap();
    let local_profile_id = local_snapshot
        .profiles
        .iter()
        .find(|profile| profile.label == "Local fixture")
        .unwrap()
        .id
        .clone();

    let https_preview = importing
        .preflight_https(
            "https://fixture.invalid/profile.yaml",
            Some("HTTPS fixture".to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(https_preview.source_type, ProfileSourceType::Https);
    let https_snapshot = importing
        .save_preview(&https_preview.preview_id)
        .await
        .unwrap();
    let https_profile_id = https_snapshot
        .profiles
        .iter()
        .find(|profile| profile.label == "HTTPS fixture")
        .unwrap()
        .id
        .clone();

    let failure_preview = importing
        .preflight_local(
            fixture("p0-activation-failure.yaml"),
            Some("Activation failure fixture".to_owned()),
        )
        .await
        .unwrap();
    let failure_snapshot = importing
        .save_preview(&failure_preview.preview_id)
        .await
        .unwrap();
    let failure_profile_id = failure_snapshot
        .profiles
        .iter()
        .find(|profile| profile.label == "Activation failure fixture")
        .unwrap()
        .id
        .clone();
    drop(importing);

    let controller = P0Controller::start().await;
    let profiles =
        Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root.clone()).unwrap());
    let platform = Arc::new(MemoryCapturePlatform::default());
    let journal = Arc::new(MemoryCaptureJournal::default());
    let capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    ));
    let manager = Arc::new(MihomoActivationManager::new_with_capture(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            root.path().join("runtime"),
        ),
        activation_timing(Duration::from_secs(2)),
        Some(capture.clone()),
    ));
    let safe_runtime = MishRuntime::with_capture(
        Arc::new(DesktopMihomoProcess::new(DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        })),
        capture,
    );
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    let address = controller.address;
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host.clone(),
        safe_runtime,
        move || ManagedRuntimePolicy::new(address, "fixture-controller-authentication"),
    ));
    let mut updates = coordinator.subscribe();

    coordinator
        .activate(&Uuid::new_v4().to_string(), &local_profile_id)
        .await
        .unwrap();
    let activated = wait_for_activation(&coordinator, &mut updates).await;
    assert_eq!(activated.phase, ProfileActivationPhase::Success);
    assert_eq!(
        activated.active_profile_id.as_deref(),
        Some(local_profile_id.as_str())
    );

    let status = host.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(status["runtime"]["phase"], "healthy");
    assert_eq!(status["routingMode"], "rule");
    assert_eq!(status["groups"][0]["label"], "synthetic-group");
    assert_eq!(
        host.traffic_snapshot(StatusAdapterKind::Rpc)["phase"],
        "ready"
    );
    let events = wait_for_events(&host).await;
    assert_eq!(events["phase"], "ready");
    assert!(!events["events"].as_array().unwrap().is_empty());

    for (mode, expected) in [
        (RoutingMode::Global, "global"),
        (RoutingMode::Direct, "direct"),
        (RoutingMode::Rule, "rule"),
    ] {
        let changed = host
            .set_routing_mode(mode, StatusAdapterKind::Rpc)
            .await
            .unwrap();
        assert_eq!(changed["routingMode"], expected);
    }

    let applied = host
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
        .await
        .unwrap();
    assert_eq!(applied["runtime"]["systemProxy"]["phase"], "applied");

    coordinator
        .activate(&Uuid::new_v4().to_string(), &https_profile_id)
        .await
        .unwrap();
    let switched = wait_for_activation(&coordinator, &mut updates).await;
    assert_eq!(switched.phase, ProfileActivationPhase::Success);
    assert_eq!(
        switched.active_profile_id.as_deref(),
        Some(https_profile_id.as_str())
    );
    assert_eq!(
        host.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["systemProxy"]["phase"],
        "applied"
    );

    let before_restart = host.current();
    coordinator
        .activate(&Uuid::new_v4().to_string(), &https_profile_id)
        .await
        .unwrap();
    let restarted = wait_for_activation(&coordinator, &mut updates).await;
    assert_eq!(restarted.phase, ProfileActivationPhase::Success);
    assert!(!before_restart.is_same_instance(&host.current()));
    assert_eq!(
        host.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["systemProxy"]["phase"],
        "applied"
    );

    coordinator
        .activate(&Uuid::new_v4().to_string(), &failure_profile_id)
        .await
        .unwrap();
    let failed = wait_for_activation(&coordinator, &mut updates).await;
    assert_eq!(failed.phase, ProfileActivationPhase::Failure);
    assert_eq!(
        failed.failure,
        Some(mish_bridge::ProfileActivationFailure::Validation)
    );
    assert_eq!(
        failed.active_profile_id.as_deref(),
        Some(https_profile_id.as_str())
    );
    assert_eq!(
        host.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["systemProxy"]["phase"],
        "applied"
    );

    platform.set_state(disabled_capture_service());
    host.audit_capture(CaptureAuditReason::Periodic)
        .await
        .unwrap();
    let drifted = host.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(drifted["runtime"]["systemProxy"]["phase"], "drift");
    assert_eq!(
        drifted["runtime"]["systemProxy"]["recoveryActions"],
        json!(["repair", "leave-as-is"])
    );
    let repaired = host
        .recover_system_proxy(CaptureRecoveryAction::Repair, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    assert_eq!(repaired["runtime"]["systemProxy"]["phase"], "applied");

    coordinator.stop(&Uuid::new_v4().to_string()).await.unwrap();
    let stopped = wait_for_activation(&coordinator, &mut updates).await;
    assert_eq!(stopped.phase, ProfileActivationPhase::Success);
    assert!(stopped.safe_stopped);
    assert!(stopped.active_profile_id.is_none());
    let stopped_status = host.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(stopped_status["runtime"]["phase"], "inactive");
    assert_eq!(stopped_status["runtime"]["systemProxy"]["phase"], "off");
    assert_eq!(platform.state(), disabled_capture_service());
    assert!(journal.load().unwrap().is_none());

    coordinator.shutdown().await.unwrap();
    let remaining = coordinator.delete_profile(&https_profile_id).await.unwrap();
    assert!(
        remaining
            .profiles
            .iter()
            .all(|profile| profile.id != https_profile_id)
    );
    drop(updates);
    drop(coordinator);

    let reimporting = ProfileService::new(
        profile_root.clone(),
        StdLocalSourceReader,
        FixtureHttpsReader::new(P0_PROFILE),
        SourceReadPolicy::default(),
    );
    let reimport_preview = reimporting
        .preflight_https(
            "https://fixture.invalid/profile.yaml",
            Some("HTTPS fixture reimported".to_owned()),
        )
        .await
        .unwrap();
    let reimport_snapshot = reimporting
        .save_preview(&reimport_preview.preview_id)
        .await
        .unwrap();
    let reimported_profile_id = reimport_snapshot
        .profiles
        .iter()
        .find(|profile| profile.label == "HTTPS fixture reimported")
        .unwrap()
        .id
        .clone();
    assert_ne!(reimported_profile_id, https_profile_id);
    drop(reimporting);

    let restarted_profiles =
        Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let restarted_capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    ));
    let restarted_manager = Arc::new(MihomoActivationManager::new_with_capture(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            root.path().join("runtime"),
        ),
        activation_timing(Duration::from_secs(2)),
        Some(restarted_capture.clone()),
    ));
    restarted_manager.shutdown().await.unwrap();
    let restarted_safe_runtime = MishRuntime::with_capture(
        Arc::new(DesktopMihomoProcess::new(DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        })),
        restarted_capture,
    );
    let restarted_host = DesktopRuntimeHost::new(restarted_safe_runtime.clone());
    let restarted_coordinator = Arc::new(ProfileActivationCoordinator::new(
        restarted_profiles,
        restarted_manager,
        restarted_host.clone(),
        restarted_safe_runtime,
        move || ManagedRuntimePolicy::new(address, "fixture-controller-authentication"),
    ));
    let mut restarted_updates = restarted_coordinator.subscribe();

    restarted_coordinator
        .activate(&Uuid::new_v4().to_string(), &reimported_profile_id)
        .await
        .unwrap();
    let reactivated = wait_for_activation(&restarted_coordinator, &mut restarted_updates).await;
    assert_eq!(reactivated.phase, ProfileActivationPhase::Success);
    assert_eq!(
        reactivated.active_profile_id.as_deref(),
        Some(reimported_profile_id.as_str())
    );
    let restarted_status = restarted_host.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(restarted_status["runtime"]["systemProxy"]["phase"], "off");
    assert!(
        !restarted_status["runtime"]["captureSelection"]["systemProxy"]
            .as_bool()
            .unwrap()
    );

    let reapplied = restarted_host
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
        .await
        .unwrap();
    assert_eq!(reapplied["runtime"]["systemProxy"]["phase"], "applied");

    restarted_coordinator.shutdown().await.unwrap();
    controller.shutdown().await;
}

fn assert_default_service_presets(snapshot: &serde_json::Value) {
    let service_ids = snapshot["services"]
        .as_array()
        .unwrap()
        .iter()
        .map(|service| service["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        service_ids,
        [
            "google",
            "github",
            "cloudflare",
            "baidu",
            "apple",
            "microsoft",
        ]
    );
}

#[test]
fn generated_runtime_config_reasserts_application_and_capture_policy() {
    let normalized = br#"
port: 1234
mixed-port: 7890
allow-lan: true
bind-address: 0.0.0.0
external-controller: 0.0.0.0:9999
external-controller-tls: 0.0.0.0:9443
external-controller-unix: /private/controller.sock
external-controller-pipe: private-pipe
external-controller-cors:
  allow-origins: ['*']
external-ui: /private/ui
external-ui-name: private-ui
external-ui-url: https://private.invalid/ui.zip
external-doh-server: https://private.invalid/dns-query
authentication: [private:credential]
skip-auth-prefixes: [192.0.2.0/24]
lan-allowed-ips: [192.0.2.1]
lan-disallowed-ips: [192.0.2.2]
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
dns:
  enable: true
  listen: 0.0.0.0:53
interface-name: private-interface
routing-mark: 1234
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

    let generated = RuntimeConfigGenerator::generate_with_review(normalized, &policy).unwrap();
    let document: Value = serde_norway::from_slice(&generated.bytes).unwrap();
    let root = document.as_mapping().unwrap();

    assert_eq!(root["port"].as_i64(), Some(0));
    assert_eq!(root["socks-port"].as_i64(), Some(0));
    assert_eq!(root["redir-port"].as_i64(), Some(0));
    assert_eq!(root["tproxy-port"].as_i64(), Some(0));
    assert_eq!(
        root["mixed-port"].as_i64(),
        Some(i64::from(LoopbackProxyEndpoint::managed().port()))
    );
    assert_eq!(policy.proxy_endpoint(), &LoopbackProxyEndpoint::managed());
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
    assert!(root["dns"].as_mapping().unwrap().get("listen").is_none());
    for removed in [
        "authentication",
        "skip-auth-prefixes",
        "lan-allowed-ips",
        "lan-disallowed-ips",
        "external-controller-tls",
        "external-controller-unix",
        "external-controller-pipe",
        "external-controller-cors",
        "external-ui",
        "external-ui-name",
        "external-ui-url",
        "external-doh-server",
        "interface-name",
        "routing-mark",
    ] {
        assert!(root.get(removed).is_none(), "{removed} remained in runtime");
    }
    assert!(root["proxies"].as_sequence().is_some());
    assert!(root["rules"].as_sequence().is_some());

    let identities: HashSet<_> = generated
        .classifications
        .iter()
        .map(|item| item.field_identity.as_str())
        .collect();
    for managed in [
        "port",
        "socks-port",
        "redir-port",
        "tproxy-port",
        "mixed-port",
        "allow-lan",
        "bind-address",
        "authentication",
        "skip-auth-prefixes",
        "lan-allowed-ips",
        "lan-disallowed-ips",
        "external-controller",
        "secret",
        "external-controller-tls",
        "external-controller-unix",
        "external-controller-pipe",
        "external-controller-cors",
        "external-ui",
        "external-ui-name",
        "external-ui-url",
        "external-doh-server",
        "mode",
        "log-level",
        "profile.store-selected",
        "profile.store-fake-ip",
        "listeners",
        "interface-name",
        "routing-mark",
        "tun",
        "sniffer.enable",
        "dns.listen",
    ] {
        assert!(
            identities.contains(managed),
            "missing policy report for {managed}"
        );
    }
}

#[test]
fn patch_preview_and_activation_use_the_same_runtime_generator() {
    let normalized = br#"
mixed-port: 7890
proxies:
  - name: synthetic-node
    type: direct
rules:
  - MATCH,DIRECT
"#;
    let mut record = profile_record(normalized);
    let editor = mish_profile::profile_patch_editor(
        &record.metadata.id,
        &record.metadata.revision.id,
        &record.metadata.artifact.fingerprint,
        &record.normalized_bytes,
        &record.patches,
    )
    .unwrap();
    let direct = editor
        .catalog
        .outbounds
        .iter()
        .find(|entity| entity.label == "DIRECT")
        .unwrap()
        .id
        .clone();
    let (patches, _) = mish_profile::bind_and_apply_profile_patches(
        &record.normalized_bytes,
        &record.metadata.revision.id,
        &record.metadata.artifact.fingerprint,
        vec![ProfilePatch {
            enabled: true,
            id: Uuid::new_v4().to_string(),
            operation: ProfilePatchOperation::RuleInsert {
                position: RuleInsertPosition::Prefix,
                rule: StructuredRule::Match { target_id: direct },
            },
        }],
    )
    .unwrap();
    record.patches = patches;

    let policy = ManagedRuntimePolicy::new(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43123),
        "application-controller-secret",
    )
    .unwrap();

    let preview = RuntimeConfigGenerator::generate_record_with_review(&record, &policy).unwrap();
    let activation = RuntimeConfigGenerator::generate_record(&record, &policy).unwrap();
    assert_eq!(activation, preview.bytes);
    let document: Value = serde_norway::from_slice(&activation).unwrap();
    assert_eq!(document["rules"][0].as_str(), Some("MATCH,DIRECT"));
    assert_eq!(document["rules"][1].as_str(), Some("MATCH,DIRECT"));
    assert_eq!(document["mixed-port"].as_i64(), Some(7890));
    assert_eq!(
        document["external-controller"].as_str(),
        Some("127.0.0.1:43123")
    );
}

#[test]
fn tun_policy_requires_explicit_selection_and_a_healthy_exact_version() {
    let helper = TunHelperSnapshot {
        availability: TunHelperAvailability::Available,
        expected_version: "2".to_owned(),
        health: TunHelperHealth::Healthy,
        installation_id: None,
        installed_version: Some("2".to_owned()),
        last_failure: None,
        phase: TunHelperLifecyclePhase::Idle,
    };
    let policy = ManagedRuntimePolicy::new(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43123),
        "application-controller-secret",
    )
    .unwrap()
    .with_tun_enabled(&helper, true)
    .unwrap();
    let generated = RuntimeConfigGenerator::generate(
        br#"
tun:
  enable: false
  device: source-controlled
  route-address: [0.0.0.0/0]
rules: [MATCH,DIRECT]
"#,
        &policy,
    )
    .unwrap();
    let document: Value = serde_norway::from_slice(&generated).unwrap();
    let tun = document["tun"].as_mapping().unwrap();

    assert_eq!(tun["enable"].as_bool(), Some(true));
    assert_eq!(tun["stack"].as_str(), Some("gvisor"));
    assert_eq!(tun["auto-route"].as_bool(), Some(true));
    assert_eq!(tun["auto-detect-interface"].as_bool(), Some(true));
    assert_eq!(tun["strict-route"].as_bool(), Some(true));
    assert_eq!(tun["dns-hijack"][0].as_str(), Some("any:53"));
    assert!(tun.get("device").is_none());
    assert!(tun.get("route-address").is_none());

    let unhealthy = TunHelperSnapshot::browser_unavailable();
    assert_eq!(
        ManagedRuntimePolicy::new(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43124),
            "application-controller-secret",
        )
        .unwrap()
        .with_tun_enabled(&unhealthy, true)
        .unwrap_err(),
        mish_bridge::RuntimeConfigGenerationError::TunHelperUnavailable
    );
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
async fn startup_records_an_explicit_safe_stopped_state_without_a_binary() {
    let root = std::env::temp_dir().join(format!("mish-safe-startup-{}", Uuid::new_v4()));
    let manager = MihomoActivationManager::new(
        ManagedMihomoResolver::development(
            root.join("missing-explicit-binary"),
            root.join("runtime"),
        ),
        ActivationTiming::default(),
    );

    manager.shutdown().await.unwrap();

    let persisted = std::fs::read_to_string(root.join("runtime/activation-state.json")).unwrap();
    let state: serde_json::Value = serde_json::from_str(&persisted).unwrap();
    assert!(state["activeProfileId"].is_null());
    assert!(state["activeFingerprint"].is_null());
    assert!(state["activeRuntimeId"].is_null());
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
    let events = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let events = runtime.events_snapshot(StatusAdapterKind::Rpc);
            if events["phase"] == "unavailable" {
                break events;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("missing /logs did not become unavailable");
    assert_eq!(events["sourceStatuses"][0]["phase"], "unavailable");
    assert_eq!(events["sourceStatuses"][1]["phase"], "ready");
    assert_eq!(events["events"].as_array().unwrap().len(), 1);
    assert_eq!(events["events"][0]["source"], "application");
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
    assert_eq!(candidate_count(&root), 0);
    controller.shutdown().await;
}

#[tokio::test]
async fn repository_backed_activation_atomically_replaces_the_profile_context() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-coordinator-{}", Uuid::new_v4()));
    let profile_root = root.join("profile-store");
    let record = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    FileProfileRepository::new(profile_root.join("profile-store"))
        .save(&record)
        .unwrap();
    let profiles = Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let manager = Arc::new(activation_manager(&root, Duration::from_secs(2)));
    let safe_runtime = MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
        DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        },
    )));
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    let address = controller.address;
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host.clone(),
        safe_runtime,
        move || ManagedRuntimePolicy::new(address, "synthetic-coordinator-secret"),
    ));
    let mut updates = coordinator.subscribe();
    let command_id = Uuid::new_v4().to_string();

    let pending = coordinator
        .activate(&command_id, record.metadata.id.as_str())
        .await
        .unwrap();

    assert_eq!(pending.phase, ProfileActivationPhase::Pending);
    let completed = loop {
        updates.recv().await.unwrap();
        let snapshot = coordinator.activation_snapshot().await;
        if snapshot.phase != ProfileActivationPhase::Pending {
            break snapshot;
        }
    };
    assert_eq!(completed.phase, ProfileActivationPhase::Success);
    assert_eq!(
        completed.active_profile_id.as_deref(),
        Some(record.metadata.id.as_str())
    );
    let status = host.status_snapshot(StatusAdapterKind::Rpc).await;
    let traffic = host.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(status["activeProfileId"], record.metadata.id.as_str());
    assert_eq!(traffic["profileId"], record.metadata.id.as_str());

    coordinator.shutdown().await.unwrap();
    controller.shutdown().await;
}

#[tokio::test]
async fn capture_survives_activation_and_restores_on_core_stop_and_shutdown() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-capture-activation-{}", Uuid::new_v4()));
    let profile_root = root.join("profile-store");
    let record = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let replacement = profile_record(b"proxies: []\nrules: [MATCH,REJECT]\n");
    let repository = FileProfileRepository::new(profile_root.join("profile-store"));
    repository.save(&record).unwrap();
    repository.save(&replacement).unwrap();
    let profiles = Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let platform = Arc::new(MemoryCapturePlatform::default());
    let journal = Arc::new(MemoryCaptureJournal::default());
    let capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    ));
    let manager = Arc::new(MihomoActivationManager::new_with_capture(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            root.join("runtime"),
        ),
        activation_timing(Duration::from_secs(2)),
        Some(capture.clone()),
    ));
    let safe_runtime = MishRuntime::with_capture(
        Arc::new(DesktopMihomoProcess::new(DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        })),
        capture,
    );
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    let address = controller.address;
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host.clone(),
        safe_runtime,
        move || ManagedRuntimePolicy::new(address, "synthetic-capture-secret"),
    ));
    let mut updates = coordinator.subscribe();

    coordinator
        .activate(&Uuid::new_v4().to_string(), record.metadata.id.as_str())
        .await
        .unwrap();
    while coordinator.activation_snapshot().await.phase == ProfileActivationPhase::Pending {
        updates.recv().await.unwrap();
    }

    let activated = host.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(activated["capabilities"]["systemProxy"], "supported");
    assert_eq!(activated["runtime"]["systemProxy"]["phase"], "off");
    assert_eq!(
        activated["runtime"]["captureSelection"]["systemProxy"],
        false
    );
    assert!(journal.load().unwrap().is_none());

    let applied = host
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
        .await
        .unwrap();
    assert_eq!(applied["runtime"]["systemProxy"]["phase"], "applied");
    assert!(
        platform
            .state()
            .is_mish_endpoint(&LoopbackProxyEndpoint::managed())
    );
    assert_eq!(candidate_count(&root), 1);

    coordinator
        .activate(
            &Uuid::new_v4().to_string(),
            replacement.metadata.id.as_str(),
        )
        .await
        .unwrap();
    while coordinator.activation_snapshot().await.phase == ProfileActivationPhase::Pending {
        updates.recv().await.unwrap();
    }
    let switched = coordinator.activation_snapshot().await;
    assert_eq!(switched.phase, ProfileActivationPhase::Success);
    assert_eq!(
        switched.active_profile_id.as_deref(),
        Some(replacement.metadata.id.as_str())
    );
    assert_eq!(
        host.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["systemProxy"]["phase"],
        "applied"
    );
    assert!(
        platform
            .state()
            .is_mish_endpoint(&LoopbackProxyEndpoint::managed())
    );

    host.stop_core().await.unwrap();
    host.audit_capture(CaptureAuditReason::CoreHealthChanged)
        .await
        .unwrap();
    assert_eq!(
        host.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["systemProxy"]["phase"],
        "off"
    );
    assert_eq!(platform.state(), disabled_capture_service());
    assert!(journal.load().unwrap().is_none());

    host.start_core().await.unwrap();
    host.set_capture(
        CaptureRequest {
            active: true,
            selection: CaptureSelection {
                system_proxy: true,
                tun: false,
            },
        },
        StatusAdapterKind::Rpc,
    )
    .await
    .unwrap();
    coordinator.shutdown().await.unwrap();
    assert_eq!(platform.state(), disabled_capture_service());
    assert!(journal.load().unwrap().is_none());
    assert_eq!(candidate_count(&root), 0);

    controller.shutdown().await;
}

#[tokio::test]
async fn invalid_capture_recovery_blocks_reactivation_with_a_redacted_actionable_event() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-invalid-capture-{}", Uuid::new_v4()));
    let profile_root = root.join("profile-store");
    let record = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    FileProfileRepository::new(profile_root.join("profile-store"))
        .save(&record)
        .unwrap();
    let profiles = Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let platform = Arc::new(MemoryCapturePlatform::default());
    let journal = Arc::new(MemoryCaptureJournal::default());
    let capture = Arc::new(CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    ));
    let manager = Arc::new(MihomoActivationManager::new_with_capture(
        ManagedMihomoResolver::development(
            fixture("fake-activation-mihomo.sh"),
            root.join("runtime"),
        ),
        activation_timing(Duration::from_secs(2)),
        Some(capture.clone()),
    ));
    let safe_runtime = MishRuntime::with_capture(
        Arc::new(DesktopMihomoProcess::new(DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        })),
        capture,
    );
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    let address = controller.address;
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host.clone(),
        safe_runtime,
        move || ManagedRuntimePolicy::new(address, "synthetic-invalid-capture-secret"),
    ));
    let mut updates = coordinator.subscribe();

    coordinator
        .activate(&Uuid::new_v4().to_string(), record.metadata.id.as_str())
        .await
        .unwrap();
    assert_eq!(
        wait_for_activation(&coordinator, &mut updates).await.phase,
        ProfileActivationPhase::Success
    );
    host.set_capture(
        CaptureRequest {
            active: true,
            selection: CaptureSelection {
                system_proxy: true,
                tun: false,
            },
        },
        StatusAdapterKind::Rpc,
    )
    .await
    .unwrap();
    journal.invalidate();
    assert_eq!(
        journal.load().unwrap_err().kind,
        mish_runtime::CaptureFailureKind::InvalidRecovery
    );
    let captured = host.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(captured["runtime"]["systemProxy"]["desired"], true);
    assert_eq!(captured["runtime"]["systemProxy"]["phase"], "applied");

    for attempt in 0..2 {
        if attempt > 0 {
            let capture_error = host
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
                .await
                .unwrap_err();
            assert_eq!(
                capture_error.kind,
                mish_runtime::CaptureFailureKind::InvalidRecovery
            );
        }
        let pending = coordinator
            .activate(&Uuid::new_v4().to_string(), record.metadata.id.as_str())
            .await
            .unwrap();
        assert_eq!(pending.phase, ProfileActivationPhase::Pending);
        let failed = wait_for_activation(&coordinator, &mut updates).await;
        assert_eq!(failed.phase, ProfileActivationPhase::Failure);
        assert_eq!(
            failed.failure,
            Some(mish_bridge::ProfileActivationFailure::Capture)
        );
        assert_eq!(
            failed.active_profile_id.as_deref(),
            Some(record.metadata.id.as_str())
        );
        assert_eq!(
            host.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["systemProxy"]["phase"],
            "drift"
        );
    }

    let events = host.events_snapshot(StatusAdapterKind::Rpc);
    let activation_event = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["message"] == "Profile activation failed")
        .unwrap();
    assert_eq!(activation_event["source"], "application");
    assert!(
        activation_event["detail"]
            .as_str()
            .unwrap()
            .contains("System Proxy recovery")
    );
    let serialized_events = events.to_string();
    assert!(!serialized_events.contains("synthetic-invalid-capture-secret"));
    assert!(!serialized_events.contains("profile.yaml"));

    host.recover_system_proxy(CaptureRecoveryAction::LeaveAsIs, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    platform.set_state(disabled_capture_service());
    coordinator.shutdown().await.unwrap();
    controller.shutdown().await;
}

#[tokio::test]
async fn coordinator_republishes_the_restored_runtime_after_commit_failure() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-coordinator-rollback-{}", Uuid::new_v4()));
    let profile_root = root.join("profile-store");
    let prior = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let candidate = profile_record(b"proxies: []\nrules: [MATCH,REJECT]\n");
    let repository = FileProfileRepository::new(profile_root.join("profile-store"));
    repository.save(&prior).unwrap();
    repository.save(&candidate).unwrap();
    let profiles = Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let manager = Arc::new(activation_manager(&root, Duration::from_secs(2)));
    let safe_runtime = MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
        DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        },
    )));
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    let address = controller.address;
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host.clone(),
        safe_runtime,
        move || ManagedRuntimePolicy::new(address, "synthetic-rollback-secret"),
    ));
    let mut updates = coordinator.subscribe();
    coordinator
        .activate(&Uuid::new_v4().to_string(), prior.metadata.id.as_str())
        .await
        .unwrap();
    while coordinator.activation_snapshot().await.phase == ProfileActivationPhase::Pending {
        updates.recv().await.unwrap();
    }

    let state_path = root.join("runtime/activation-state.json");
    let saved_state = root.join("runtime/activation-state.saved");
    std::fs::rename(&state_path, &saved_state).unwrap();
    std::fs::create_dir(&state_path).unwrap();
    coordinator
        .activate(&Uuid::new_v4().to_string(), candidate.metadata.id.as_str())
        .await
        .unwrap();
    while coordinator.activation_snapshot().await.phase == ProfileActivationPhase::Pending {
        updates.recv().await.unwrap();
    }

    let failed = coordinator.activation_snapshot().await;
    assert_eq!(failed.phase, ProfileActivationPhase::Failure);
    assert_eq!(
        failed.failure,
        Some(mish_bridge::ProfileActivationFailure::StateCommit)
    );
    assert_eq!(
        failed.active_profile_id.as_deref(),
        Some(prior.metadata.id.as_str())
    );
    let status = host.status_snapshot(StatusAdapterKind::Rpc).await;
    let traffic = host.traffic_snapshot(StatusAdapterKind::Rpc);
    assert_eq!(status["activeProfileId"], prior.metadata.id.as_str());
    assert_eq!(status["runtime"]["phase"], "healthy");
    assert_eq!(traffic["profileId"], prior.metadata.id.as_str());

    std::fs::rename(&state_path, root.join("runtime/activation-state.blocked")).unwrap();
    std::fs::rename(saved_state, &state_path).unwrap();
    coordinator.shutdown().await.unwrap();
    controller.shutdown().await;
}

#[tokio::test]
async fn duplicate_profile_activation_is_deduplicated_and_cancellable() {
    let root = std::env::temp_dir().join(format!("mish-coordinator-cancel-{}", Uuid::new_v4()));
    let profile_root = root.join("profile-store");
    let record = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    FileProfileRepository::new(profile_root.join("profile-store"))
        .save(&record)
        .unwrap();
    let profiles = Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let manager = Arc::new(activation_manager(&root, Duration::from_secs(5)));
    let safe_runtime = MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
        DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        },
    )));
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    let unavailable = unused_loopback_address();
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host,
        safe_runtime,
        move || ManagedRuntimePolicy::new(unavailable, "synthetic-cancel-secret"),
    ));
    let first_command = Uuid::new_v4().to_string();
    let duplicate_command = Uuid::new_v4().to_string();
    let mut updates = coordinator.subscribe();

    let first = coordinator
        .activate(&first_command, record.metadata.id.as_str())
        .await
        .unwrap();
    assert!(matches!(
        coordinator.mutation_authority().try_acquire(),
        Err(mish_state_authority::StateMutationError::Busy)
    ));
    assert!(matches!(
        coordinator
            .refresh_profile(record.metadata.id.as_str(), ProfileRefreshTrigger::Manual)
            .await,
        Err(mish_bridge::ProfileActivationCoordinatorError::Busy)
    ));
    let duplicate = coordinator
        .activate(&duplicate_command, record.metadata.id.as_str())
        .await
        .unwrap();
    assert_eq!(duplicate.command_id, first.command_id);
    coordinator.cancel(&first_command).await.unwrap();

    let completed = loop {
        updates.recv().await.unwrap();
        let snapshot = coordinator.activation_snapshot().await;
        if snapshot.phase != ProfileActivationPhase::Pending {
            break snapshot;
        }
    };
    assert_eq!(completed.phase, ProfileActivationPhase::Failure);
    assert_eq!(
        completed.failure,
        Some(mish_bridge::ProfileActivationFailure::Cancelled)
    );
    assert!(completed.safe_stopped);
}

#[tokio::test]
async fn active_profile_deletion_requires_replacement_or_an_explicit_safe_stop() {
    let controller = FakeController::start("v1.19.29").await;
    let root = std::env::temp_dir().join(format!("mish-active-delete-{}", Uuid::new_v4()));
    let profile_root = root.join("profile-store");
    let record = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let replacement = profile_record(b"proxies: []\nrules: [MATCH,REJECT]\n");
    let repository = FileProfileRepository::new(profile_root.join("profile-store"));
    repository.save(&record).unwrap();
    repository.save(&replacement).unwrap();
    let profiles = Arc::new(ReqwestHttpsSourceReader::profile_service(profile_root).unwrap());
    let manager = Arc::new(activation_manager(&root, Duration::from_secs(2)));
    let safe_runtime = MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
        DesktopMihomoProcessConfig {
            binary: None,
            config_directory: None,
            config_file: None,
        },
    )));
    let host = DesktopRuntimeHost::new(safe_runtime.clone());
    let address = controller.address;
    let coordinator = Arc::new(ProfileActivationCoordinator::new(
        profiles,
        manager,
        host.clone(),
        safe_runtime,
        move || ManagedRuntimePolicy::new(address, "synthetic-delete-secret"),
    ));
    let mut updates = coordinator.subscribe();
    coordinator
        .activate(&Uuid::new_v4().to_string(), record.metadata.id.as_str())
        .await
        .unwrap();
    while coordinator.activation_snapshot().await.phase == ProfileActivationPhase::Pending {
        updates.recv().await.unwrap();
    }

    assert!(matches!(
        coordinator
            .delete_profile(record.metadata.id.as_str())
            .await,
        Err(mish_bridge::ProfileActivationCoordinatorError::Conflict)
    ));

    coordinator
        .activate(
            &Uuid::new_v4().to_string(),
            replacement.metadata.id.as_str(),
        )
        .await
        .unwrap();
    while coordinator.activation_snapshot().await.phase == ProfileActivationPhase::Pending {
        updates.recv().await.unwrap();
    }
    let replaced = coordinator.activation_snapshot().await;
    assert_eq!(replaced.phase, ProfileActivationPhase::Success);
    assert_eq!(
        replaced.active_profile_id.as_deref(),
        Some(replacement.metadata.id.as_str())
    );
    coordinator
        .delete_profile(record.metadata.id.as_str())
        .await
        .unwrap();
    assert!(matches!(
        coordinator
            .delete_profile(replacement.metadata.id.as_str())
            .await,
        Err(mish_bridge::ProfileActivationCoordinatorError::Conflict)
    ));

    let stop_command = Uuid::new_v4().to_string();
    coordinator.stop(&stop_command).await.unwrap();
    while coordinator.activation_snapshot().await.phase == ProfileActivationPhase::Pending {
        updates.recv().await.unwrap();
    }
    let stopped = coordinator.activation_snapshot().await;
    assert_eq!(stopped.phase, ProfileActivationPhase::Success);
    assert!(stopped.safe_stopped);
    assert!(stopped.active_profile_id.is_none());
    assert_eq!(
        host.status_snapshot(StatusAdapterKind::Rpc).await["runtime"]["phase"],
        "inactive"
    );

    let profiles = coordinator
        .delete_profile(replacement.metadata.id.as_str())
        .await
        .unwrap();
    assert!(profiles.profiles.is_empty());
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
async fn cancellation_stops_the_candidate_without_committing_a_profile() {
    let root = std::env::temp_dir().join(format!("mish-cancelled-{}", Uuid::new_v4()));
    let manager = activation_manager(&root, Duration::from_secs(5));
    let candidate = profile_record(b"proxies: []\nrules: [MATCH,DIRECT]\n");
    let policy = ManagedRuntimePolicy::new(unused_loopback_address(), "candidate-secret").unwrap();
    let cancellation = CancellationToken::new();
    let trigger = cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        trigger.cancel();
    });

    let error = manager
        .activate_cancellable(&candidate, &policy, cancellation)
        .await
        .unwrap_err();

    assert_eq!(error, MihomoActivationError::Cancelled);
    let managed = manager.managed_state().await;
    assert!(managed.is_safe_stopped());
    assert_eq!(
        managed.last_attempt().unwrap().failure(),
        Some(ActivationFailureKind::Cancelled)
    );
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
        activation_timing(readiness_timeout),
    )
}

fn activation_timing(readiness_timeout: Duration) -> ActivationTiming {
    ActivationTiming {
        config_validation_timeout: Duration::from_secs(1),
        controller_connect_timeout: Duration::from_millis(100),
        controller_request_timeout: Duration::from_millis(100),
        readiness_timeout,
        refresh_interval: Duration::from_secs(1),
        reconnect_delay: Duration::from_millis(25),
    }
}

async fn wait_for_activation(
    coordinator: &ProfileActivationCoordinator,
    updates: &mut tokio::sync::broadcast::Receiver<mish_bridge::ProfileActivationSnapshot>,
) -> mish_bridge::ProfileActivationSnapshot {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = coordinator.activation_snapshot().await;
            if snapshot.phase != ProfileActivationPhase::Pending {
                return snapshot;
            }
            updates.recv().await.unwrap();
        }
    })
    .await
    .expect("profile activation did not complete")
}

async fn wait_for_events(host: &DesktopRuntimeHost) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = host.events_snapshot(StatusAdapterKind::Rpc);
            if snapshot["phase"] == "ready"
                && snapshot["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty())
            {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture events did not become ready")
}

#[derive(Clone)]
struct FixtureHttpsReader {
    bytes: Arc<Vec<u8>>,
}

impl FixtureHttpsReader {
    fn new(bytes: &[u8]) -> Self {
        Self {
            bytes: Arc::new(bytes.to_vec()),
        }
    }
}

impl HttpsSourceReader for FixtureHttpsReader {
    fn read<'a>(
        &'a self,
        url: &'a SensitiveUrl,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        let bytes = self.bytes.as_ref().clone();
        let final_url = RedirectTarget::parse(url.expose()).unwrap();
        async move {
            Ok(SourceContent {
                bytes,
                content_type: Some("application/yaml".to_owned()),
                final_url: Some(final_url),
                redirects: 0,
            })
        }
        .boxed()
    }
}

struct MemoryCapturePlatform(std::sync::Mutex<NetworkServiceProxyState>);

impl Default for MemoryCapturePlatform {
    fn default() -> Self {
        Self(std::sync::Mutex::new(disabled_capture_service()))
    }
}

impl MemoryCapturePlatform {
    fn state(&self) -> NetworkServiceProxyState {
        self.0.lock().unwrap().clone()
    }

    fn set_state(&self, state: NetworkServiceProxyState) {
        *self.0.lock().unwrap() = state;
    }
}

impl CapturePlatform for MemoryCapturePlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.state())))
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(ready(Ok(self.state())))
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
struct MemoryCaptureJournal {
    invalid: std::sync::Mutex<bool>,
    journal: std::sync::Mutex<Option<CaptureJournal>>,
}

impl MemoryCaptureJournal {
    fn invalidate(&self) {
        *self.invalid.lock().unwrap() = true;
    }
}

impl CaptureJournalStore for MemoryCaptureJournal {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        if *self.invalid.lock().unwrap() {
            return Err(CaptureTransitionError::new(
                mish_runtime::CaptureFailureKind::InvalidRecovery,
                "Synthetic invalid recovery journal",
            ));
        }
        Ok(self.journal.lock().unwrap().clone())
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        *self.journal.lock().unwrap() = Some(journal.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        *self.invalid.lock().unwrap() = false;
        *self.journal.lock().unwrap() = None;
        Ok(())
    }
}

fn disabled_capture_service() -> NetworkServiceProxyState {
    NetworkServiceProxyState {
        auto_discovery_enabled: false,
        http: ManualProxyState::disabled(),
        https: ManualProxyState::disabled(),
        pac_enabled: false,
        service_id: "capture-fixture-service".into(),
        socks: ManualProxyState::disabled(),
    }
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
        patches: ProfilePatchSet::empty(&revision_id, &fingerprint),
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
            refresh: Default::default(),
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
                id: revision_id.clone(),
                media_type: Some("application/yaml".into()),
            },
            runtime_provenance: mish_profile::RuntimeProvenanceReview {
                artifact_fingerprint: fingerprint,
                authority: mish_profile::ProvenanceReviewAuthority::DesktopPolicy,
                items: Vec::new(),
                layers: mish_profile::runtime_layers(),
                source_revision: revision_id,
                unknown_key_count: 0,
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

#[derive(Clone)]
struct P0ControllerState {
    routing_mode: Arc<Mutex<RoutingMode>>,
}

struct P0Controller {
    address: SocketAddr,
    join: JoinHandle<()>,
    shutdown: oneshot::Sender<()>,
}

impl P0Controller {
    async fn start() -> Self {
        let state = P0ControllerState {
            routing_mode: Arc::new(Mutex::new(RoutingMode::Rule)),
        };
        let app = Router::new()
            .route(
                "/version",
                get(|| async { Json(json!({"meta": true, "version": "v1.19.29"})) }),
            )
            .route("/configs", get(p0_runtime_config).put(p0_set_routing_mode))
            .route("/proxies", get(|| async { Json(proxy_catalog()) }))
            .route("/rules", get(|| async { Json(rule_list()) }))
            .route("/connections", get(|| async { Json(connections()) }))
            .route("/traffic", get(traffic_stream))
            .route("/memory", get(memory_stream))
            .route("/logs", get(log_stream))
            .with_state(state);
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

async fn p0_runtime_config(State(state): State<P0ControllerState>) -> Json<serde_json::Value> {
    let mode = *state.routing_mode.lock().unwrap();
    Json(runtime_config_with_mode(mode))
}

async fn p0_set_routing_mode(
    State(state): State<P0ControllerState>,
    Json(body): Json<serde_json::Value>,
) -> StatusCode {
    let Some(mode) = body["mode"].as_str().and_then(|mode| match mode {
        "rule" => Some(RoutingMode::Rule),
        "global" => Some(RoutingMode::Global),
        "direct" => Some(RoutingMode::Direct),
        _ => None,
    }) else {
        return StatusCode::BAD_REQUEST;
    };
    *state.routing_mode.lock().unwrap() = mode;
    StatusCode::NO_CONTENT
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

async fn log_stream(websocket: WebSocketUpgrade) -> Response {
    websocket
        .on_upgrade(|mut socket| async move {
            let _ = socket
                .send(AxumMessage::Text(
                    json!({
                        "time": "08:00:00",
                        "level": "info",
                        "message": "fixture core became ready",
                        "fields": []
                    })
                    .to_string()
                    .into(),
                ))
                .await;
            std::future::pending::<()>().await;
        })
        .into_response()
}

fn runtime_config() -> serde_json::Value {
    runtime_config_with_mode(RoutingMode::Rule)
}

fn candidate_count(root: &Path) -> usize {
    std::fs::read_dir(root.join("runtime/candidates"))
        .map(|entries| entries.flatten().count())
        .unwrap_or(0)
}

fn runtime_config_with_mode(mode: RoutingMode) -> serde_json::Value {
    let mode = match mode {
        RoutingMode::Rule => "rule",
        RoutingMode::Global => "global",
        RoutingMode::Direct => "direct",
    };
    json!({
        "mode": mode, "tun": {"enable": false}, "allow-lan": false,
        "ipv6": false, "port": 0, "socks-port": 0, "redir-port": 0,
        "tproxy-port": 0, "mixed-port": LoopbackProxyEndpoint::managed().port(), "log-level": "warning",
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
