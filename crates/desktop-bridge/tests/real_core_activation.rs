use std::{env, net::TcpListener, path::PathBuf, time::Duration};

use mish_bridge::{
    ActivationTiming, ManagedMihomoResolver, ManagedRuntimePolicy, MihomoActivationManager,
};
use mish_profile::{
    Fingerprint, ImmutableRevision, NORMALIZED_ARTIFACT_SCHEMA_VERSION, NormalizedArtifact,
    PROFILE_SCHEMA_VERSION, ProfileId, ProfileMetadata, ProfilePatchSet, ProfileRecord,
    ProfileSource, ProfileSourceType, ProfileStatus, Provenance, RevisionId, SourceSummary,
    Timestamp, ValidationResult, ValidationStatus,
};
use mish_runtime::StatusAdapterKind;
use uuid::Uuid;

#[tokio::test]
async fn activates_the_explicitly_prepared_pinned_core() {
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
    manager.shutdown().await.unwrap();
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
