use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use mish_bridge::{
    ActivationTiming, LoopbackServerConfig, ManagedMihomoResolver, ManagedRuntimePolicy,
    MihomoActivationManager, start_loopback_server,
};
use mish_profile::{
    Fingerprint, ImmutableRevision, NORMALIZED_ARTIFACT_SCHEMA_VERSION, NormalizedArtifact,
    PROFILE_SCHEMA_VERSION, ProfileId, ProfileMetadata, ProfilePatchSet, ProfileRecord,
    ProfileSource, ProfileSourceType, ProfileStatus, Provenance, RevisionId, SourceSummary,
    Timestamp, ValidationResult, ValidationStatus,
};
use mish_runtime::StatusAdapterKind;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use uuid::Uuid;

const ORIGIN: &str = "http://real-core-activation.test";
const TOKEN: &str = "real-core-activation-token";

#[tokio::test]
async fn activates_the_pinned_core_and_confirms_modes_through_authenticated_rpc() {
    let Some(binary) = env::var_os("MIHOMO_BIN").map(PathBuf::from) else {
        eprintln!("skipped: set MIHOMO_BIN to opt in to transactional real-core activation");
        return;
    };
    assert!(binary.is_file(), "MIHOMO_BIN did not point to a file");
    let controller_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let controller_address = controller_listener.local_addr().unwrap();
    drop(controller_listener);
    let runtime_root = env::temp_dir().join(format!("mish-real-activation-{}", Uuid::new_v4()));
    let manager = MihomoActivationManager::new(
        ManagedMihomoResolver::development(binary, runtime_root),
        ActivationTiming {
            config_validation_timeout: Duration::from_secs(5),
            geodata_preparation_timeout: Duration::from_secs(5 * 60),
            controller_connect_timeout: Duration::from_secs(1),
            controller_request_timeout: Duration::from_secs(2),
            readiness_timeout: Duration::from_secs(10),
            refresh_interval: Duration::from_secs(2),
            reconnect_delay: Duration::from_millis(50),
        },
    );
    let policy =
        ManagedRuntimePolicy::new(controller_address, "synthetic-activation-token").unwrap();
    let record = record();

    let committed = manager.activate(&record, &policy).await.unwrap();

    assert_eq!(committed.profile_id(), record.metadata.id.as_str());
    let runtime = manager.active_runtime().await.unwrap();
    let status = runtime.core_status().await;
    assert_eq!(status.version.as_deref(), Some("v1.19.29"));
    let snapshot = runtime.status_snapshot(StatusAdapterKind::Rpc).await;
    assert_eq!(snapshot["runtime"]["phase"], "healthy");
    assert_eq!(snapshot["runtime"]["systemProxyEnabled"], false);
    assert_eq!(snapshot["runtime"]["tunEnabled"], false);
    assert_eq!(snapshot["groups"][0]["label"], "synthetic-group");

    let bridge = start_loopback_server(bridge_config(), runtime.clone())
        .await
        .unwrap();
    let mut socket = socket(bridge.address).await;
    authenticate(&mut socket).await;
    for (id, mode) in [(2, "global"), (3, "direct"), (4, "rule")] {
        let changed = rpc_request(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "status.setRoutingMode",
                "params": {"mode": mode}
            }),
        )
        .await;
        assert_eq!(changed["result"]["routingMode"], mode);
        assert_eq!(
            runtime.status_snapshot(StatusAdapterKind::Native).await["routingMode"],
            mode
        );
    }

    socket.close(None).await.unwrap();
    bridge.shutdown().await;
    manager.shutdown().await.unwrap();
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
            "params": {"clientName": "real-core-test", "clientVersion": "1", "token": TOKEN}
        }),
    )
    .await;
    assert_eq!(response["result"]["authenticated"], true);
}

async fn rpc_request(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    request: Value,
) -> Value {
    socket
        .send(Message::Text(request.to_string().into()))
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

fn record() -> ProfileRecord {
    let normalized_bytes = br#"
ipv6: false
dns:
  enable: false
proxies:
  - name: synthetic-node
    type: direct
    udp: true
proxy-groups:
  - name: synthetic-group
    type: select
    proxies:
      - synthetic-node
      - DIRECT
      - REJECT
rules:
  - DOMAIN-SUFFIX,fixture.invalid,synthetic-group
  - MATCH,DIRECT
"#
    .to_vec();
    let source_bytes = normalized_bytes.clone();
    let revision_id = RevisionId::from_source(&source_bytes);
    let fingerprint = Fingerprint::from_normalized_artifact(&normalized_bytes);
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
            id: ProfileId::new(),
            label: "Synthetic real-core activation".into(),
            last_attempt: None,
            last_success: None,
            refresh: Default::default(),
            provenance: Provenance {
                imported_at: timestamp,
                source: SourceSummary {
                    display: "synthetic.yaml".into(),
                    source_type: ProfileSourceType::LocalFile,
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
        normalized_bytes,
        source: ProfileSource::local_file(PathBuf::from("/synthetic/profile.yaml")).unwrap(),
        source_bytes,
    }
}
