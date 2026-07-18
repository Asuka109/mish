use std::{
    env, fs,
    future::pending,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use futures_util::{FutureExt, future::BoxFuture};
use mish_profile::{
    AtomicWriter, FileProfileRepository, HttpsSourceReader, ImportError, ImportPreflight,
    ImportRequest, LocalSourceReader, PolicyDisposition, PolicyOwner, ProfileId, ProfileSource,
    RedirectTarget, RejectingHttpsSourceReader, RepositoryComponent, RepositoryError,
    SensitiveDataNotice, SensitivePath, SensitiveUrl, SourceContent, SourceReadError,
    SourceReadPolicy, StdAtomicWriter, StdLocalSourceReader, Timestamp, ValidationIssueCode,
};

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = env::temp_dir().join(format!("mish-profile-test-{}", ProfileId::new().as_str()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const VALID_PROFILE: &str = r#"
proxies:
  - name: confidential-node
    type: socks5
    server: 192.0.2.1
    port: 1080
    username: private-user
    password: private-password
proxy-groups:
  - name: Primary
    type: select
    proxies: [confidential-node]
rules:
  - MATCH,Primary
experimental-safe-key:
  enabled: true
mixed-port: 7890
tun:
  enable: true
  stack: system
rule-providers:
  private-rules:
    type: file
    path: /private/device/rules.yaml
"#;

#[derive(Clone)]
struct FixedLocalReader {
    content: Arc<Vec<u8>>,
}

impl LocalSourceReader for FixedLocalReader {
    fn read<'a>(
        &'a self,
        _path: &'a SensitivePath,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        let bytes = self.content.as_ref().clone();
        async move {
            Ok(SourceContent {
                bytes,
                content_type: None,
                final_url: None,
                redirects: 0,
            })
        }
        .boxed()
    }
}

#[derive(Clone)]
struct FixedHttpsReader {
    content: Arc<Vec<u8>>,
    content_type: &'static str,
    redirects: u8,
}

impl HttpsSourceReader for FixedHttpsReader {
    fn read<'a>(
        &'a self,
        url: &'a SensitiveUrl,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        let bytes = self.content.as_ref().clone();
        let content_type = self.content_type.to_owned();
        let final_url = RedirectTarget::parse(url.expose()).unwrap();
        let redirects = self.redirects;
        async move {
            Ok(SourceContent {
                bytes,
                content_type: Some(content_type),
                final_url: Some(final_url),
                redirects,
            })
        }
        .boxed()
    }
}

struct PendingHttpsReader;

impl HttpsSourceReader for PendingHttpsReader {
    fn read<'a>(
        &'a self,
        _url: &'a SensitiveUrl,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        pending().boxed()
    }
}

struct InsecureRedirectReader;

impl HttpsSourceReader for InsecureRedirectReader {
    fn read<'a>(
        &'a self,
        _url: &'a SensitiveUrl,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        async {
            Ok(SourceContent {
                bytes: VALID_PROFILE.as_bytes().to_vec(),
                content_type: Some("application/yaml".to_owned()),
                final_url: Some(
                    RedirectTarget::parse("http://profiles.example/config.yaml?token=secret")
                        .unwrap(),
                ),
                redirects: 1,
            })
        }
        .boxed()
    }
}

fn local_source() -> ProfileSource {
    ProfileSource::local_file("/tmp/example-profile.yaml".into()).unwrap()
}

fn pipeline_with_bytes(bytes: Vec<u8>) -> ImportPreflight<FixedLocalReader, FixedHttpsReader> {
    ImportPreflight::new(
        FixedLocalReader {
            content: Arc::new(bytes.clone()),
        },
        FixedHttpsReader {
            content: Arc::new(bytes),
            content_type: "application/yaml",
            redirects: 0,
        },
        SourceReadPolicy::default(),
    )
}

#[tokio::test]
async fn normal_preflight_summarizes_and_classifies_without_silent_platform_enablement() {
    let report = pipeline_with_bytes(VALID_PROFILE.as_bytes().to_vec())
        .run(ImportRequest {
            label: Some("Work profile".to_owned()),
            source: local_source(),
        })
        .await
        .unwrap();

    assert_eq!(report.summary.label, "Work profile");
    assert_eq!(report.summary.proxy_count, 1);
    assert_eq!(report.summary.group_count, 1);
    assert_eq!(report.summary.rule_count, 1);
    assert_eq!(
        report.summary.sensitive_data_notice,
        SensitiveDataNotice::ConfigurationContainsSensitiveData
    );
    assert!(report.classifications.iter().any(|item| {
        item.key_path == "mixed-port"
            && item.owner == PolicyOwner::Application
            && item.disposition == PolicyDisposition::Overridden
    }));
    assert!(report.classifications.iter().any(|item| {
        item.key_path == "tun.enable"
            && item.owner == PolicyOwner::Platform
            && item.disposition == PolicyDisposition::Disabled
    }));
    assert!(report.classifications.iter().any(|item| {
        item.key_path.ends_with(".path") && item.disposition == PolicyDisposition::Rejected
    }));

    let normalized = String::from_utf8(report.normalized_bytes).unwrap();
    assert!(normalized.contains("experimental-safe-key"));
    assert!(!normalized.contains("mixed-port"));
    assert!(!normalized.contains("/private/device/rules.yaml"));
    assert!(normalized.contains("enable: false"));
    assert!(
        report
            .summary
            .warnings
            .iter()
            .any(|warning| { warning.code == ValidationIssueCode::UnknownKeysPreserved })
    );
}

#[tokio::test]
async fn malformed_yaml_returns_a_typed_redacted_error() {
    let error = pipeline_with_bytes(b"proxies: [unterminated".to_vec())
        .run(ImportRequest {
            label: None,
            source: local_source(),
        })
        .await
        .unwrap_err();

    assert_eq!(error, ImportError::MalformedYaml);
    assert_eq!(error.to_string(), "profile source contains malformed YAML");
}

#[tokio::test]
async fn oversized_content_is_rejected_even_when_a_reader_misbehaves() {
    let policy = SourceReadPolicy {
        max_bytes: 8,
        ..SourceReadPolicy::default()
    };
    let pipeline = ImportPreflight::new(
        FixedLocalReader {
            content: Arc::new(vec![b'x'; 9]),
        },
        FixedHttpsReader {
            content: Arc::new(Vec::new()),
            content_type: "application/yaml",
            redirects: 0,
        },
        policy,
    );

    let error = pipeline
        .run(ImportRequest {
            label: None,
            source: local_source(),
        })
        .await
        .unwrap_err();
    assert_eq!(error, ImportError::Source(SourceReadError::Oversize));
}

#[tokio::test]
async fn https_timeout_and_redirect_limits_are_enforced_by_the_pipeline() {
    let source = ProfileSource::https("https://profiles.example/config.yaml").unwrap();
    let timeout_policy = SourceReadPolicy {
        timeout: Duration::from_millis(5),
        ..SourceReadPolicy::default()
    };
    let timeout_pipeline = ImportPreflight::new(
        FixedLocalReader {
            content: Arc::new(Vec::new()),
        },
        PendingHttpsReader,
        timeout_policy,
    );
    assert_eq!(
        timeout_pipeline
            .run(ImportRequest {
                label: None,
                source: source.clone(),
            })
            .await
            .unwrap_err(),
        ImportError::Source(SourceReadError::Timeout)
    );

    let redirect_pipeline = ImportPreflight::new(
        FixedLocalReader {
            content: Arc::new(Vec::new()),
        },
        FixedHttpsReader {
            content: Arc::new(VALID_PROFILE.as_bytes().to_vec()),
            content_type: "application/yaml",
            redirects: 4,
        },
        SourceReadPolicy::default(),
    );
    assert_eq!(
        redirect_pipeline
            .run(ImportRequest {
                label: None,
                source,
            })
            .await
            .unwrap_err(),
        ImportError::Source(SourceReadError::TooManyRedirects)
    );
}

#[tokio::test]
async fn https_rejects_insecure_redirects_and_unsupported_content_types() {
    let source = ProfileSource::https("https://profiles.example/config.yaml").unwrap();
    let local_reader = FixedLocalReader {
        content: Arc::new(Vec::new()),
    };
    let insecure = ImportPreflight::new(
        local_reader.clone(),
        InsecureRedirectReader,
        SourceReadPolicy::default(),
    );
    assert_eq!(
        insecure
            .run(ImportRequest {
                label: None,
                source: source.clone(),
            })
            .await
            .unwrap_err(),
        ImportError::Source(SourceReadError::InsecureRedirect)
    );

    let wrong_content_type = ImportPreflight::new(
        local_reader,
        FixedHttpsReader {
            content: Arc::new(VALID_PROFILE.as_bytes().to_vec()),
            content_type: "text/html",
            redirects: 0,
        },
        SourceReadPolicy::default(),
    );
    assert_eq!(
        wrong_content_type
            .run(ImportRequest {
                label: None,
                source,
            })
            .await
            .unwrap_err(),
        ImportError::Source(SourceReadError::UnsupportedContentType)
    );
}

#[tokio::test]
async fn standard_local_reader_reads_a_bounded_absolute_file() {
    let temp = TestDir::new();
    let source_path = temp.path().join("profile.yaml");
    fs::write(&source_path, VALID_PROFILE).unwrap();
    let pipeline = ImportPreflight::new(
        StdLocalSourceReader,
        RejectingHttpsSourceReader,
        SourceReadPolicy::default(),
    );

    let report = pipeline
        .run(ImportRequest {
            label: None,
            source: ProfileSource::local_file(source_path).unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(report.summary.proxy_count, 1);
}

#[tokio::test]
async fn tokenized_https_url_is_redacted_from_debug_summary_and_metadata() {
    const TOKEN: &str = "super-secret-subscription-token";
    let source = ProfileSource::https(&format!(
        "https://profiles.example/config.yaml?token={TOKEN}"
    ))
    .unwrap();
    assert!(!format!("{source:?}").contains(TOKEN));
    assert!(!source.safe_summary().display.contains(TOKEN));

    let report = pipeline_with_bytes(VALID_PROFILE.as_bytes().to_vec())
        .run(ImportRequest {
            label: None,
            source,
        })
        .await
        .unwrap();
    assert_eq!(
        report.summary.sensitive_data_notice,
        SensitiveDataNotice::SourceAndConfigurationContainSensitiveData
    );
    assert!(!format!("{report:?}").contains(TOKEN));

    let record = report.into_record(
        ProfileId::parse("8f496cb3-757c-4b16-a6a1-395f324ff28b").unwrap(),
        Timestamp::from_unix_milliseconds(1_700_000_000_000),
    );
    let metadata = serde_json::to_string(&record.metadata).unwrap();
    assert!(!metadata.contains(TOKEN));
    assert!(!metadata.contains("private-password"));
}

#[test]
fn source_constructors_reject_unsafe_paths_schemes_and_url_credentials() {
    assert!(ProfileSource::local_file("relative/profile.yaml".into()).is_err());
    assert!(ProfileSource::local_file("/tmp/../secret.yaml".into()).is_err());
    assert!(ProfileSource::https("http://profiles.example/config.yaml").is_err());
    assert!(ProfileSource::https("https://user:pass@profiles.example/config.yaml").is_err());
    assert!(ProfileId::parse("../../escape").is_err());
}

#[tokio::test]
async fn fingerprint_is_stable_for_the_same_normalized_input() {
    let pipeline = pipeline_with_bytes(VALID_PROFILE.as_bytes().to_vec());
    let first = pipeline
        .run(ImportRequest {
            label: None,
            source: local_source(),
        })
        .await
        .unwrap();
    let second = pipeline
        .run(ImportRequest {
            label: None,
            source: local_source(),
        })
        .await
        .unwrap();

    assert_eq!(first.artifact.fingerprint, second.artifact.fingerprint);
    assert_eq!(first.revision.id, second.revision.id);
}

#[derive(Clone, Copy)]
struct FailingWriter;

impl AtomicWriter for FailingWriter {
    fn write(&self, _destination: &Path, _contents: &[u8]) -> io::Result<()> {
        Err(io::Error::other("injected atomic write failure"))
    }
}

async fn record_for_repository(id: ProfileId) -> mish_profile::ProfileRecord {
    pipeline_with_bytes(VALID_PROFILE.as_bytes().to_vec())
        .run(ImportRequest {
            label: Some("Repository fixture".to_owned()),
            source: ProfileSource::https(
                "https://profiles.example/config.yaml?token=repository-secret",
            )
            .unwrap(),
        })
        .await
        .unwrap()
        .into_record(id, Timestamp::from_unix_milliseconds(1_700_000_000_000))
}

#[tokio::test]
async fn repository_failure_does_not_publish_a_partial_profile() {
    let temp = TestDir::new();
    let root = temp.path().join("profile-store");
    let repository = FileProfileRepository::with_writer(root.clone(), FailingWriter);
    let record = record_for_repository(ProfileId::new()).await;

    assert!(matches!(
        repository.save(&record),
        Err(RepositoryError::AtomicWriteFailed)
    ));
    let published = fs::read_dir(root.join("profiles"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(published.is_empty());
}

#[derive(Clone, Copy)]
struct MetadataFailingWriter;

impl AtomicWriter for MetadataFailingWriter {
    fn write(&self, destination: &Path, contents: &[u8]) -> io::Result<()> {
        if destination
            .file_name()
            .is_some_and(|name| name == "metadata.json")
        {
            return Err(io::Error::other("injected metadata failure"));
        }
        StdAtomicWriter.write(destination, contents)
    }
}

#[tokio::test]
async fn failed_update_keeps_the_previous_metadata_authoritative() {
    let temp = TestDir::new();
    let root = temp.path().join("profile-store");
    let id = ProfileId::new();
    let initial = record_for_repository(id.clone()).await;
    FileProfileRepository::new(root.clone())
        .save(&initial)
        .unwrap();

    let updated_yaml = VALID_PROFILE.replace("MATCH,Primary", "DOMAIN,example.com,Primary");
    let updated = pipeline_with_bytes(updated_yaml.into_bytes())
        .run(ImportRequest {
            label: Some("Updated fixture".to_owned()),
            source: initial.source.clone(),
        })
        .await
        .unwrap()
        .into_record(
            id.clone(),
            Timestamp::from_unix_milliseconds(1_700_000_001_000),
        );
    let failing_repository =
        FileProfileRepository::with_writer(root.clone(), MetadataFailingWriter);
    assert!(matches!(
        failing_repository.update(&updated),
        Err(RepositoryError::AtomicWriteFailed)
    ));

    let loaded = FileProfileRepository::new(root).load(&id).unwrap();
    assert_eq!(loaded.metadata, initial.metadata);
    assert_eq!(loaded.source_bytes, initial.source_bytes);
}

#[tokio::test]
async fn repository_separates_sensitive_source_artifacts_and_safe_metadata() {
    let temp = TestDir::new();
    let root = temp.path().join("profile-store");
    let repository = FileProfileRepository::new(root.clone());
    let id = ProfileId::parse("05b3e1aa-94a1-49de-b5f0-284675b1fe80").unwrap();
    let record = record_for_repository(id.clone()).await;
    repository.save(&record).unwrap();

    let profile_root = root.join("profiles").join(id.as_str());
    let metadata = fs::read_to_string(profile_root.join("metadata.json")).unwrap();
    let source_descriptor = fs::read_to_string(profile_root.join("source/source.json")).unwrap();
    assert!(!metadata.contains("repository-secret"));
    assert!(!metadata.contains("private-password"));
    assert!(source_descriptor.contains("repository-secret"));
    assert!(
        profile_root
            .join(format!(
                "source/revisions/{}.yaml",
                record.metadata.revision.id.as_str()
            ))
            .is_file()
    );
    assert!(
        profile_root
            .join(format!(
                "artifacts/{}.yaml",
                record.metadata.artifact.fingerprint.as_str()
            ))
            .is_file()
    );

    let listed = repository.list_metadata().unwrap();
    assert_eq!(listed, vec![record.metadata.clone()]);

    let loaded = repository.load(&id).unwrap();
    assert_eq!(loaded.metadata, record.metadata);
    assert_eq!(loaded.source_bytes, record.source_bytes);
    assert_eq!(loaded.normalized_bytes, record.normalized_bytes);
}

#[tokio::test]
async fn corrupt_persistence_returns_a_typed_error_without_echoing_contents() {
    let temp = TestDir::new();
    let root = temp.path().join("profile-store");
    let repository = FileProfileRepository::new(root.clone());
    let id = ProfileId::new();
    let record = record_for_repository(id.clone()).await;
    repository.save(&record).unwrap();
    fs::write(
        root.join("profiles")
            .join(id.as_str())
            .join("metadata.json"),
        b"{not-json: repository-secret}",
    )
    .unwrap();

    let error = repository.load(&id).unwrap_err();
    assert!(matches!(
        error,
        RepositoryError::CorruptData {
            component: RepositoryComponent::Metadata
        }
    ));
    assert!(!error.to_string().contains("repository-secret"));
}

#[tokio::test]
async fn corrupt_hash_cannot_escape_the_profile_directory() {
    let temp = TestDir::new();
    let root = temp.path().join("profile-store");
    let repository = FileProfileRepository::new(root.clone());
    let id = ProfileId::new();
    let record = record_for_repository(id.clone()).await;
    repository.save(&record).unwrap();
    let metadata_path = root
        .join("profiles")
        .join(id.as_str())
        .join("metadata.json");
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
    metadata["artifact"]["fingerprint"] = serde_json::json!("../../outside");
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

    assert!(matches!(
        repository.load(&id),
        Err(RepositoryError::CorruptData {
            component: RepositoryComponent::Metadata
        })
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn repository_rejects_symlinked_profile_paths() {
    use std::os::unix::fs::symlink;

    let temp = TestDir::new();
    let root = temp.path().join("profile-store");
    fs::create_dir_all(root.join("profiles")).unwrap();
    let id = ProfileId::new();
    symlink(temp.path(), root.join("profiles").join(id.as_str())).unwrap();
    let repository = FileProfileRepository::new(root);

    assert!(matches!(
        repository.load(&id),
        Err(RepositoryError::UnsafeStoragePath)
    ));
}
