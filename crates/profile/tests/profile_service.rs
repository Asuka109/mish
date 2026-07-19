use std::{
    collections::VecDeque,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use futures_util::{FutureExt, future::BoxFuture};
use mish_profile::{
    AttemptOutcome, FileProfileRepository, HttpsSourceReader, LocalSourceReader, ProfileService,
    ProfileServiceError, RedirectTarget, SensitivePath, SensitiveUrl, SourceContent,
    SourceReadError, SourceReadPolicy,
};

const VALID_PROFILE: &str = r#"
proxies:
  - name: fictional-node
    type: socks5
    server: 192.0.2.10
    port: 1080
    password: not-a-real-password
proxy-groups:
  - name: Fictional group
    type: select
    proxies: [fictional-node]
rules:
  - MATCH,Fictional group
"#;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = env::temp_dir().join(format!("mish-profile-service-{}", uuid::Uuid::new_v4()));
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

#[derive(Clone)]
struct SequencedReader {
    contents: Arc<Mutex<VecDeque<Vec<u8>>>>,
}

impl SequencedReader {
    fn new(contents: impl IntoIterator<Item = Vec<u8>>) -> Self {
        Self {
            contents: Arc::new(Mutex::new(contents.into_iter().collect())),
        }
    }

    fn next(&self) -> Result<Vec<u8>, SourceReadError> {
        self.contents
            .lock()
            .unwrap()
            .pop_front()
            .ok_or(SourceReadError::Unavailable)
    }
}

impl LocalSourceReader for SequencedReader {
    fn read<'a>(
        &'a self,
        _path: &'a SensitivePath,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        let content = self.next();
        async move {
            Ok(SourceContent {
                bytes: content?,
                content_type: None,
                final_url: None,
                redirects: 0,
            })
        }
        .boxed()
    }
}

impl HttpsSourceReader for SequencedReader {
    fn read<'a>(
        &'a self,
        url: &'a SensitiveUrl,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        let content = self.next();
        let final_url = RedirectTarget::parse(url.expose()).unwrap();
        async move {
            Ok(SourceContent {
                bytes: content?,
                content_type: Some("application/yaml".to_owned()),
                final_url: Some(final_url),
                redirects: 0,
            })
        }
        .boxed()
    }
}

fn service(
    root: PathBuf,
    reader: SequencedReader,
) -> ProfileService<SequencedReader, SequencedReader> {
    ProfileService::new(root, reader.clone(), reader, SourceReadPolicy::default())
}

#[tokio::test]
async fn failed_refresh_keeps_the_last_known_valid_revision() {
    let temp = TestDir::new();
    let reader = SequencedReader::new([
        VALID_PROFILE.as_bytes().to_vec(),
        b"proxies: [malformed".to_vec(),
    ]);
    let service = service(temp.path().to_path_buf(), reader);
    let preview = service
        .preflight_local(
            "/fictional/profile.yaml".into(),
            Some("Work profile".into()),
        )
        .await
        .unwrap();
    let saved = service.save_preview(&preview.preview_id).await.unwrap();
    let saved_profile = saved.profiles.first().unwrap();
    let profile_id = saved_profile.id.clone();
    let last_success = saved_profile.last_success_at;

    assert!(service.refresh(&profile_id).await.is_err());
    let snapshot = service.snapshot().unwrap();
    let failed = snapshot.profiles.first().unwrap();
    assert!(failed.last_known_valid);
    assert_eq!(failed.last_success_at, last_success);
    assert!(failed.status.error);
    assert!(failed.status.stale);
    assert!(failed.status.valid);
    assert_eq!(
        failed.last_attempt.as_ref().unwrap().outcome,
        AttemptOutcome::Failed
    );

    let repository = FileProfileRepository::new(temp.path().to_path_buf());
    let stored = repository
        .load(&mish_profile::ProfileId::parse(profile_id).unwrap())
        .unwrap();
    assert_eq!(stored.source_bytes, VALID_PROFILE.as_bytes());
}

#[tokio::test]
async fn preview_and_snapshot_serialization_redact_source_and_configuration_secrets() {
    const TOKEN: &str = "private-subscription-token";
    let temp = TestDir::new();
    let reader = SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]);
    let profile_service = service(temp.path().to_path_buf(), reader);
    let preview = profile_service
        .preflight_https(
            &format!("https://profiles.example/config.yaml?token={TOKEN}"),
            Some("Remote profile".into()),
        )
        .await
        .unwrap();
    let preview_json = serde_json::to_string(&preview).unwrap();
    assert!(!preview_json.contains(TOKEN));
    assert!(!preview_json.contains("not-a-real-password"));
    assert!(!preview_json.contains("192.0.2.10"));

    let snapshot = profile_service
        .save_preview(&preview.preview_id)
        .await
        .unwrap();
    let snapshot_json = serde_json::to_string(&snapshot).unwrap();
    assert!(!snapshot_json.contains(TOKEN));
    assert!(!snapshot_json.contains("not-a-real-password"));
    assert!(!snapshot_json.contains("192.0.2.10"));
    assert!(snapshot_json.contains("https://profiles.example/…"));

    let local_temp = TestDir::new();
    let local_source = local_temp.path().join("private/local-profile.yaml");
    let local_source_text = local_source.to_string_lossy().into_owned();
    let local_service = service(
        local_temp.path().to_path_buf(),
        SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]),
    );
    let local_preview = local_service
        .preflight_local(local_source, Some("Local profile".into()))
        .await
        .unwrap();
    let local_preview_json = serde_json::to_string(&local_preview).unwrap();
    assert!(!local_preview_json.contains(&local_source_text));

    let local_snapshot = local_service
        .save_preview(&local_preview.preview_id)
        .await
        .unwrap();
    let local_snapshot_json = serde_json::to_string(&local_snapshot).unwrap();
    assert!(!local_snapshot_json.contains(&local_source_text));
    assert!(local_snapshot_json.contains("local-profile.yaml"));
}

#[tokio::test]
async fn inactive_profiles_can_be_deleted_but_active_profiles_cannot() {
    let temp = TestDir::new();
    let reader = SequencedReader::new([
        VALID_PROFILE.as_bytes().to_vec(),
        VALID_PROFILE.as_bytes().to_vec(),
    ]);
    let service = service(temp.path().to_path_buf(), reader);

    let first = service
        .preflight_local("/fictional/first.yaml".into(), Some("First".into()))
        .await
        .unwrap();
    let first_id = service
        .save_preview(&first.preview_id)
        .await
        .unwrap()
        .profiles[0]
        .id
        .clone();
    assert!(service.delete(&first_id).unwrap().profiles.is_empty());

    let second = service
        .preflight_local("/fictional/second.yaml".into(), Some("Second".into()))
        .await
        .unwrap();
    let second_id = service
        .save_preview(&second.preview_id)
        .await
        .unwrap()
        .profiles[0]
        .id
        .clone();
    let repository = FileProfileRepository::new(temp.path().to_path_buf());
    let parsed_id = mish_profile::ProfileId::parse(second_id.clone()).unwrap();
    let mut active = repository.load(&parsed_id).unwrap();
    active.metadata.status.active = true;
    repository.update(&active).unwrap();

    assert!(matches!(
        service.delete(&second_id),
        Err(ProfileServiceError::ActiveProfileDeletionDisabled)
    ));
    assert_eq!(service.snapshot().unwrap().profiles.len(), 1);
}

#[tokio::test]
async fn activation_records_are_reloaded_and_revalidated_from_private_storage() {
    let temp = TestDir::new();
    let reader = SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]);
    let service = service(temp.path().to_path_buf(), reader);
    let preview = service
        .preflight_local(
            "/fictional/activation.yaml".into(),
            Some("Activation".into()),
        )
        .await
        .unwrap();
    let saved = service.save_preview(&preview.preview_id).await.unwrap();
    let profile_id = saved.profiles[0].id.clone();

    let record = service.activation_record(&profile_id).unwrap();
    let artifact = temp
        .path()
        .join("profiles")
        .join(&profile_id)
        .join("artifacts")
        .join(format!(
            "{}.yaml",
            record.metadata.artifact.fingerprint.as_str()
        ));
    fs::write(artifact, b"tampered: true\n").unwrap();

    assert!(matches!(
        service.activation_record(&profile_id),
        Err(ProfileServiceError::Repository(
            mish_profile::RepositoryError::IntegrityMismatch
        ))
    ));
}
