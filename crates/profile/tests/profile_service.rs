use std::{
    collections::VecDeque,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use futures_util::{FutureExt, future::BoxFuture};
use mish_profile::{
    AttemptOutcome, FileProfileRepository, HttpsSourceReader, LocalSourceReader, ProfilePatch,
    ProfilePatchError, ProfilePatchOperation, ProfileRefreshPolicy, ProfileService,
    ProfileServiceError, ProfileSourceType, ProfileStructuredEvent, RedirectTarget, SensitivePath,
    SensitiveUrl, SourceContent, SourceReadError, SourceReadPolicy, StdLocalSourceReader,
    Timestamp,
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

#[tokio::test]
async fn profile_directory_reconciliation_tracks_direct_yaml_files_and_preserves_lkg() {
    let temp = TestDir::new();
    let directory = temp.path().join("profiles");
    fs::create_dir(&directory).unwrap();
    let profile_path = directory.join("studio.yaml");
    fs::write(&profile_path, VALID_PROFILE).unwrap();
    let service = ProfileService::new(
        temp.path().to_path_buf(),
        StdLocalSourceReader,
        SequencedReader::new([]),
        SourceReadPolicy::default(),
    );

    assert!(service.reconcile_profile_directory().await.unwrap());
    let imported = service.snapshot().unwrap();
    assert_eq!(imported.profiles.len(), 1);
    assert_eq!(imported.profiles[0].file_name, "studio.yaml");
    assert_eq!(
        imported.selection.profile_id.as_deref(),
        Some(imported.profiles[0].id.as_str())
    );
    assert_eq!(imported.selection.revision, 1);

    fs::write(&profile_path, "proxies: [malformed").unwrap();
    assert!(service.reconcile_profile_directory().await.unwrap());
    let invalid = service.snapshot().unwrap();
    assert!(invalid.profiles[0].status.error);
    assert!(invalid.profiles[0].last_known_valid);

    fs::remove_file(&profile_path).unwrap();
    assert!(service.reconcile_profile_directory().await.unwrap());
    let removed = service.snapshot().unwrap();
    assert!(removed.profiles.is_empty());
    assert_eq!(removed.selection.profile_id, None);
    assert_eq!(removed.selection.revision, 2);
}

#[derive(Clone)]
struct GatedRefreshReader {
    calls: Arc<std::sync::atomic::AtomicUsize>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl GatedRefreshReader {
    fn new() -> Self {
        Self {
            calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn read(&self) -> BoxFuture<'static, Result<SourceContent, SourceReadError>> {
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let entered = self.entered.clone();
        let release = self.release.clone();
        async move {
            if call > 0 {
                entered.notify_one();
                release.notified().await;
            }
            Ok(SourceContent {
                bytes: VALID_PROFILE.as_bytes().to_vec(),
                content_type: Some("application/yaml".to_owned()),
                final_url: None,
                redirects: 0,
            })
        }
        .boxed()
    }
}

impl LocalSourceReader for GatedRefreshReader {
    fn read<'a>(
        &'a self,
        _path: &'a SensitivePath,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        self.read()
    }
}

impl HttpsSourceReader for GatedRefreshReader {
    fn read<'a>(
        &'a self,
        _url: &'a SensitiveUrl,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        self.read()
    }
}

fn service(
    root: PathBuf,
    reader: SequencedReader,
) -> ProfileService<SequencedReader, SequencedReader> {
    ProfileService::new(root, reader.clone(), reader, SourceReadPolicy::default())
}

#[tokio::test]
async fn route_catalog_is_available_without_activating_the_profile() {
    let temp = TestDir::new();
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]),
    );
    let preview = service
        .preflight_local(
            "/fictional/profile.yaml".into(),
            Some("Offline profile".into()),
        )
        .await
        .unwrap();
    let profile_id = service
        .save_preview(&preview.preview_id)
        .await
        .unwrap()
        .profiles[0]
        .id
        .clone();

    let catalog = service.route_catalog(&profile_id).unwrap();
    assert_eq!(catalog.profile_id, profile_id);
    assert_eq!(catalog.groups[0].label, "Fictional group");
    assert_eq!(
        catalog.groups[0].selected_child_id,
        Some(catalog.nodes[2].id.clone())
    );
    assert_eq!(catalog.nodes[2].label, "fictional-node");
}

#[tokio::test]
async fn selected_profile_is_revisioned_persisted_and_reconciled_after_deletion() {
    let temp = TestDir::new();
    let root = temp.path().to_path_buf();
    let profile_service = service(
        root.clone(),
        SequencedReader::new([
            VALID_PROFILE.as_bytes().to_vec(),
            VALID_PROFILE.as_bytes().to_vec(),
        ]),
    );
    let first = profile_service
        .preflight_local("/fictional/first.yaml".into(), Some("First profile".into()))
        .await
        .unwrap();
    let first_snapshot = profile_service
        .save_preview(&first.preview_id)
        .await
        .unwrap();
    let first_id = first_snapshot.profiles[0].id.clone();
    assert_eq!(
        first_snapshot.selection,
        mish_profile::ProfileSelectionSnapshot {
            profile_id: Some(first_id.clone()),
            revision: 1,
        }
    );

    let second = profile_service
        .preflight_local(
            "/fictional/second.yaml".into(),
            Some("Second profile".into()),
        )
        .await
        .unwrap();
    let saved = profile_service
        .save_preview(&second.preview_id)
        .await
        .unwrap();
    let second_id = saved
        .profiles
        .iter()
        .find(|profile| profile.id != first_id)
        .unwrap()
        .id
        .clone();
    let selected = profile_service.select_profile(&second_id).await.unwrap();
    assert_eq!(
        selected.selection.profile_id.as_deref(),
        Some(second_id.as_str())
    );
    assert_eq!(selected.selection.revision, 2);
    assert!(
        selected
            .profiles
            .iter()
            .all(|profile| !profile.status.active)
    );

    let reloaded = service(root, SequencedReader::new(std::iter::empty::<Vec<u8>>()));
    assert_eq!(reloaded.snapshot().unwrap().selection, selected.selection);

    let reconciled = reloaded.delete(&second_id).unwrap();
    assert_eq!(
        reconciled.selection,
        mish_profile::ProfileSelectionSnapshot {
            profile_id: Some(first_id),
            revision: 3,
        }
    );
    assert!(
        reconciled
            .profiles
            .iter()
            .all(|profile| !profile.status.active)
    );
}

#[tokio::test]
async fn missing_selection_migrates_the_prior_successful_profile_before_repository_fallback() {
    let temp = TestDir::new();
    let root = temp.path().to_path_buf();
    let initial = service(
        root.clone(),
        SequencedReader::new([
            VALID_PROFILE.as_bytes().to_vec(),
            VALID_PROFILE.as_bytes().to_vec(),
        ]),
    );
    for (path, label) in [
        ("/fictional/first.yaml", "First profile"),
        ("/fictional/second.yaml", "Second profile"),
    ] {
        let preview = initial
            .preflight_local(path.into(), Some(label.into()))
            .await
            .unwrap();
        initial.save_preview(&preview.preview_id).await.unwrap();
    }
    let stored = initial.snapshot().unwrap();
    let prior_successful_id = stored
        .profiles
        .iter()
        .find(|profile| Some(profile.id.as_str()) != stored.selection.profile_id.as_deref())
        .unwrap()
        .id
        .clone();
    fs::remove_file(root.join("selected-profile.json")).unwrap();

    let upgraded = service(
        root.clone(),
        SequencedReader::new(std::iter::empty::<Vec<u8>>()),
    );
    let migrated = upgraded
        .initialize_selection(Some(&prior_successful_id))
        .await
        .unwrap();
    assert_eq!(
        migrated.selection,
        mish_profile::ProfileSelectionSnapshot {
            profile_id: Some(prior_successful_id.clone()),
            revision: 1,
        }
    );

    let restarted = service(root, SequencedReader::new(std::iter::empty::<Vec<u8>>()));
    assert_eq!(
        restarted.snapshot().unwrap().selection.profile_id,
        Some(prior_successful_id)
    );
}

#[tokio::test]
async fn conditional_profile_selection_does_not_replace_a_newer_confirmation() {
    let temp = TestDir::new();
    let profile_service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([
            VALID_PROFILE.as_bytes().to_vec(),
            VALID_PROFILE.as_bytes().to_vec(),
            VALID_PROFILE.as_bytes().to_vec(),
        ]),
    );
    for (path, label) in [
        ("/fictional/first.yaml", "First profile"),
        ("/fictional/second.yaml", "Second profile"),
        ("/fictional/third.yaml", "Third profile"),
    ] {
        let preview = profile_service
            .preflight_local(path.into(), Some(label.into()))
            .await
            .unwrap();
        profile_service
            .save_preview(&preview.preview_id)
            .await
            .unwrap();
    }
    let initial = profile_service.snapshot().unwrap();
    let original_id = initial.selection.profile_id.clone().unwrap();
    let targets = initial
        .profiles
        .iter()
        .map(|profile| profile.id.clone())
        .filter(|profile_id| profile_id != &original_id)
        .collect::<Vec<_>>();
    let selected = profile_service.select_profile(&targets[0]).await.unwrap();
    let concurrently_confirmed = profile_service.select_profile(&targets[1]).await.unwrap();

    let rollback = profile_service
        .select_profile_if_current(&original_id, Some(&selected.selection))
        .await
        .unwrap();
    assert_eq!(rollback.selection, concurrently_confirmed.selection);
    assert_eq!(rollback.selection.revision, selected.selection.revision + 1);
}

#[tokio::test]
async fn simultaneous_profile_selection_commands_receive_one_revision_order() {
    let temp = TestDir::new();
    let service = Arc::new(service(
        temp.path().to_path_buf(),
        SequencedReader::new([
            VALID_PROFILE.as_bytes().to_vec(),
            VALID_PROFILE.as_bytes().to_vec(),
            VALID_PROFILE.as_bytes().to_vec(),
        ]),
    ));
    for (path, label) in [
        ("/fictional/first.yaml", "First profile"),
        ("/fictional/second.yaml", "Second profile"),
        ("/fictional/third.yaml", "Third profile"),
    ] {
        let preview = service
            .preflight_local(path.into(), Some(label.into()))
            .await
            .unwrap();
        service.save_preview(&preview.preview_id).await.unwrap();
    }
    let snapshot = service.snapshot().unwrap();
    let selected_id = snapshot.selection.profile_id.unwrap();
    let targets = snapshot
        .profiles
        .into_iter()
        .map(|profile| profile.id)
        .filter(|profile_id| profile_id != &selected_id)
        .collect::<Vec<_>>();
    let first_id = targets[0].clone();
    let second_id = targets[1].clone();
    let first_service = service.clone();
    let first_target = first_id.clone();
    let first = tokio::spawn(async move { first_service.select_profile(&first_target).await });
    let second_service = service.clone();
    let second_target = second_id.clone();
    let second = tokio::spawn(async move { second_service.select_profile(&second_target).await });
    let (first, second) = tokio::join!(first, second);
    let first = first.unwrap().unwrap().selection;
    let second = second.unwrap().unwrap().selection;

    assert_eq!([first.revision, second.revision], [2, 3]);
    assert_eq!(first.profile_id.as_deref(), Some(first_id.as_str()));
    assert_eq!(second.profile_id.as_deref(), Some(second_id.as_str()));
    assert_eq!(service.snapshot().unwrap().selection, second);
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
    let saved_provenance = saved_profile.runtime_provenance.clone();

    assert!(service.refresh(&profile_id).await.is_err());
    let snapshot = service.snapshot().unwrap();
    let failed = snapshot.profiles.first().unwrap();
    assert!(failed.last_known_valid);
    assert_eq!(failed.last_success_at, last_success);
    assert_eq!(failed.runtime_provenance, saved_provenance);
    assert!(failed.status.error);
    assert!(failed.status.stale);
    assert!(failed.status.valid);
    assert_eq!(
        failed.last_attempt.as_ref().unwrap().outcome,
        AttemptOutcome::Failed
    );

    let repository = FileProfileRepository::new(temp.path().join("profile-store"));
    let stored = repository
        .load(&mish_profile::ProfileId::parse(profile_id).unwrap())
        .unwrap();
    assert_eq!(stored.source_bytes, VALID_PROFILE.as_bytes());
}

#[tokio::test]
async fn successful_refresh_rebinds_provenance_to_the_new_revision_and_fingerprint() {
    let temp = TestDir::new();
    let updated = VALID_PROFILE.replace("MATCH,Fictional group", "MATCH,DIRECT");
    let reader = SequencedReader::new([
        VALID_PROFILE.as_bytes().to_vec(),
        updated.as_bytes().to_vec(),
    ]);
    let service = service(temp.path().to_path_buf(), reader);
    let preview = service
        .preflight_local("/fictional/profile.yaml".into(), Some("配置 🛰️".into()))
        .await
        .unwrap();
    let saved = service.save_preview(&preview.preview_id).await.unwrap();
    let profile_id = saved.profiles[0].id.clone();
    let prior = saved.profiles[0].runtime_provenance.clone();

    let refreshed = service.refresh(&profile_id).await.unwrap();
    let current = &refreshed.profiles[0].runtime_provenance;
    assert_ne!(current.source_revision, prior.source_revision);
    assert_ne!(current.artifact_fingerprint, prior.artifact_fingerprint);
    assert!(current.is_bound_to(&current.source_revision, &current.artifact_fingerprint));
}

#[tokio::test]
async fn remote_refresh_schedules_are_opt_in_fixed_and_persisted() {
    let temp = TestDir::new();
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]),
    );
    let preview = service
        .preflight_https(
            "https://profiles.example/config.yaml?token=private-token",
            Some("Remote profile".into()),
        )
        .await
        .unwrap();
    let saved = service.save_preview(&preview.preview_id).await.unwrap();
    let profile_id = saved.profiles[0].id.clone();
    assert_eq!(saved.profiles[0].refresh.policy, ProfileRefreshPolicy::Off);
    assert_eq!(saved.profiles[0].refresh.next_run_at, None);

    let scheduled = service
        .set_refresh_policy(&profile_id, ProfileRefreshPolicy::SixHours)
        .unwrap();
    let next_run_at = scheduled.profiles[0].refresh.next_run_at.unwrap();
    assert_eq!(
        scheduled.profiles[0].refresh.policy,
        ProfileRefreshPolicy::SixHours
    );
    assert!(next_run_at > Timestamp::now().as_unix_milliseconds());

    let reloaded = service.snapshot().unwrap();
    assert_eq!(reloaded.profiles[0].refresh.next_run_at, Some(next_run_at));
    assert!(
        service
            .due_scheduled_profile_ids(Timestamp::from_unix_milliseconds(next_run_at))
            .unwrap()
            .contains(&profile_id)
    );
}

#[tokio::test]
async fn local_profiles_reject_automatic_refresh_policies() {
    let temp = TestDir::new();
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]),
    );
    let preview = service
        .preflight_local(
            "/fictional/profile.yaml".into(),
            Some("Local profile".into()),
        )
        .await
        .unwrap();
    let profile_id = service
        .save_preview(&preview.preview_id)
        .await
        .unwrap()
        .profiles[0]
        .id
        .clone();

    assert!(matches!(
        service.set_refresh_policy(&profile_id, ProfileRefreshPolicy::Daily),
        Err(ProfileServiceError::SchedulingUnavailable)
    ));
    assert_eq!(
        service.snapshot().unwrap().profiles[0].refresh.policy,
        ProfileRefreshPolicy::Off
    );
}

#[tokio::test]
async fn failed_scheduled_refresh_preserves_lkg_and_backs_off() {
    let temp = TestDir::new();
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([
            VALID_PROFILE.as_bytes().to_vec(),
            b"proxies: [malformed".to_vec(),
        ]),
    );
    let preview = service
        .preflight_https(
            "https://profiles.example/config.yaml?token=private-token",
            Some("Remote profile".into()),
        )
        .await
        .unwrap();
    let saved = service.save_preview(&preview.preview_id).await.unwrap();
    let profile_id = saved.profiles[0].id.clone();
    let provenance = saved.profiles[0].runtime_provenance.clone();
    service
        .set_refresh_policy(&profile_id, ProfileRefreshPolicy::SixHours)
        .unwrap();

    assert!(service.refresh_scheduled(&profile_id).await.is_err());
    let failed = service.snapshot().unwrap().profiles.remove(0);
    assert!(failed.last_known_valid);
    assert_eq!(failed.runtime_provenance, provenance);
    assert_eq!(failed.refresh.consecutive_failures, 1);
    let failed_at = failed.refresh.last_failure_at.unwrap();
    assert!(failed.refresh.next_run_at.unwrap() >= failed_at + 12 * 60 * 60 * 1_000);

    let repository = FileProfileRepository::new(temp.path().join("profile-store"));
    let stored = repository
        .load(&mish_profile::ProfileId::parse(profile_id).unwrap())
        .unwrap();
    assert_eq!(stored.source_bytes, VALID_PROFILE.as_bytes());
    assert_eq!(stored.metadata.runtime_provenance, provenance);
}

#[tokio::test]
async fn preview_and_snapshot_use_a_bounded_redacted_summary_while_credentials_stay_private() {
    const TOKEN: &str = "private-subscription-token";
    const HEADER: &str = "private-authorization-header";
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
    assert!(snapshot_json.len() <= 16 * 1024);
    assert!(!snapshot_json.contains(TOKEN));
    assert!(!snapshot_json.contains(HEADER));
    assert!(!snapshot_json.contains("not-a-real-password"));
    assert!(!snapshot_json.contains("192.0.2.10"));
    assert!(snapshot_json.contains("https://profiles.example/…"));

    let event = snapshot
        .structured_event(
            &snapshot.profiles[0].id,
            mish_profile::ProfileStructuredEventKind::SubscriptionUpdated,
        )
        .unwrap();
    let event_json = serde_json::to_string(&event).unwrap();
    assert!(event_json.len() <= 1_024);
    assert!(event_json.contains("https://profiles.example/…"));
    assert!(!event_json.contains(TOKEN));
    assert!(!event_json.contains(HEADER));
    assert!(
        serde_json::from_value::<ProfileStructuredEvent>(serde_json::json!({
            "kind": "subscription-updated",
            "profileId": snapshot.profiles[0].id.clone(),
            "source": {
                "display": format!("https://profiles.example/config.yaml?token={TOKEN}"),
                "sourceType": "https"
            }
        }))
        .is_err()
    );

    let profile_id = profile_id_from_snapshot(&snapshot);
    let stored = FileProfileRepository::new(temp.path().join("profile-store"))
        .load(&profile_id)
        .unwrap();
    let private_transcript = format!(
        "GET https://profiles.example/config.yaml?token={TOKEN}\nAuthorization: Bearer {HEADER}\nbody-bytes={}",
        stored.source_bytes.len()
    );
    assert!(private_transcript.len() <= 512);
    assert!(private_transcript.contains(TOKEN));
    assert!(private_transcript.contains(HEADER));
    assert_eq!(stored.source.source_type(), ProfileSourceType::Https);
    assert!(stored.source_bytes.starts_with(b"\nproxies:"));
    let log_safe = format!("{stored:?}");
    assert!(!log_safe.contains(TOKEN));
    assert!(!log_safe.contains(HEADER));
    assert!(!log_safe.contains("not-a-real-password"));
    assert!(!log_safe.contains("192.0.2.10"));

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

fn profile_id_from_snapshot(snapshot: &mish_profile::ProfileSnapshot) -> mish_profile::ProfileId {
    mish_profile::ProfileId::parse(snapshot.profiles[0].id.clone()).unwrap()
}

#[tokio::test]
async fn detaching_a_subscription_keeps_the_current_revision_as_a_local_profile() {
    let temp = TestDir::new();
    let profile_service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]),
    );
    let preview = profile_service
        .preflight_https(
            "https://profiles.example/studio-route-set.yaml",
            Some("studio-route-set.yaml".into()),
        )
        .await
        .unwrap();
    let saved = profile_service
        .save_preview(&preview.preview_id)
        .await
        .unwrap();
    let materialized = temp.path().join("profiles/studio-route-set.yaml");
    assert_eq!(fs::read(&materialized).unwrap(), VALID_PROFILE.as_bytes());
    let profile_id = saved.profiles[0].id.clone();
    profile_service
        .set_refresh_policy(&profile_id, ProfileRefreshPolicy::TwelveHours)
        .unwrap();
    fs::remove_dir_all(temp.path().join("profile-store/profiles").join(&profile_id)).unwrap();

    let detached = profile_service.detach_subscription(&profile_id).unwrap();

    assert_eq!(
        detached.profiles[0].source.source_type,
        ProfileSourceType::LocalFile
    );
    assert_eq!(
        detached.profiles[0].refresh.policy,
        ProfileRefreshPolicy::Off
    );
    assert_eq!(detached.profiles[0].source.display, "studio-route-set.yaml");
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
    let repository = FileProfileRepository::new(temp.path().join("profile-store"));
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
    let repository = FileProfileRepository::new(temp.path().join("profile-store"));
    let generation = repository
        .read_current_generation()
        .unwrap()
        .expect("saved generation");
    fs::write(
        temp.path()
            .join("profile-store/profiles")
            .join(&profile_id)
            .join("metadata.json"),
        b"legacy mirror is not authoritative",
    )
    .unwrap();
    assert_eq!(service.snapshot().unwrap().profiles[0].id, profile_id);
    assert_eq!(
        service.activation_record(&profile_id).unwrap().metadata,
        record.metadata
    );
    let artifact = temp
        .path()
        .join("profile-store")
        .join("generations")
        .join(generation.id.as_str())
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

#[tokio::test]
async fn profile_readers_fail_closed_without_current_generation_and_never_publish_one() {
    let temp = TestDir::new();
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]),
    );
    let preview = service
        .preflight_local(
            "/fictional/missing-generation.yaml".into(),
            Some("Missing generation".into()),
        )
        .await
        .unwrap();
    let saved = service.save_preview(&preview.preview_id).await.unwrap();
    let profile_id = saved.profiles[0].id.clone();
    let pointer = temp
        .path()
        .join("profile-store")
        .join(mish_profile::PROFILE_CURRENT_GENERATION_FILE);
    fs::remove_file(&pointer).unwrap();

    let expected = |error| {
        matches!(
            error,
            ProfileServiceError::Repository(mish_profile::RepositoryError::CorruptData {
                component: mish_profile::RepositoryComponent::GenerationPointer
            })
        )
    };
    assert!(expected(service.snapshot().unwrap_err()));
    assert!(expected(
        service.select_profile(&profile_id).await.unwrap_err()
    ));
    assert!(expected(
        service.detach_subscription(&profile_id).unwrap_err()
    ));
    assert!(expected(
        service.activation_record(&profile_id).unwrap_err()
    ));
    assert!(expected(
        service.reconcile_profile_directory().await.unwrap_err()
    ));
    assert!(!pointer.exists(), "readers must not publish a generation");
}

#[tokio::test]
async fn patches_round_trip_and_missing_refresh_targets_preserve_lkg() {
    let temp = TestDir::new();
    let refreshed = VALID_PROFILE.replace("  - MATCH,Fictional group\n", "  - MATCH,DIRECT\n");
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([
            VALID_PROFILE.as_bytes().to_vec(),
            refreshed.as_bytes().to_vec(),
        ]),
    );
    let preview = service
        .preflight_local("/fictional/profile.yaml".into(), Some("研发配置 🛰️".into()))
        .await
        .unwrap();
    let saved = service.save_preview(&preview.preview_id).await.unwrap();
    let profile = &saved.profiles[0];
    let editor = service
        .patch_editor(
            &profile.id,
            profile.runtime_provenance.source_revision.as_str(),
            profile.runtime_provenance.artifact_fingerprint.as_str(),
        )
        .unwrap();
    let original_rule_id = editor.catalog.rules[0].id.clone();
    let patch_id = uuid::Uuid::new_v4().to_string();
    let saved_editor = service
        .replace_patches(
            &profile.id,
            &editor.authority.source_revision,
            &editor.authority.artifact_fingerprint,
            vec![ProfilePatch {
                enabled: true,
                id: patch_id.clone(),
                operation: ProfilePatchOperation::RuleDisable {
                    rule_id: original_rule_id,
                },
            }],
        )
        .unwrap();
    assert_eq!(saved_editor.patches[0].id, patch_id);

    let repository = FileProfileRepository::new(temp.path().join("profile-store"));
    let parsed_id = mish_profile::ProfileId::parse(profile.id.clone()).unwrap();
    let before_refresh = repository.load(&parsed_id).unwrap();
    assert_eq!(before_refresh.patches.patches[0].id, patch_id);
    let lkg = before_refresh.metadata.last_success.clone().unwrap();

    assert!(matches!(
        service.refresh(&profile.id).await,
        Err(ProfileServiceError::Patch(
            ProfilePatchError::ValidationFailed
        ))
    ));
    let after_refresh = repository.load(&parsed_id).unwrap();
    assert_eq!(after_refresh.patches.patches[0].id, patch_id);
    assert_eq!(after_refresh.metadata.last_success, Some(lkg));
    assert!(after_refresh.metadata.status.error);
    assert!(after_refresh.metadata.status.stale);
    assert!(!after_refresh.metadata.status.valid);
    assert!(matches!(
        service.activation_record(&profile.id),
        Err(ProfileServiceError::Patch(
            ProfilePatchError::StaleAuthority
        ))
    ));
}

#[tokio::test]
async fn patch_authority_and_editor_serialization_do_not_expose_secrets() {
    const TOKEN: &str = "private-subscription-token";
    let temp = TestDir::new();
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([VALID_PROFILE.as_bytes().to_vec()]),
    );
    let preview = service
        .preflight_https(
            &format!("https://profiles.example/config.yaml?token={TOKEN}"),
            Some("Remote profile".into()),
        )
        .await
        .unwrap();
    let snapshot = service.save_preview(&preview.preview_id).await.unwrap();
    let profile = &snapshot.profiles[0];

    assert!(matches!(
        service.patch_editor(
            &profile.id,
            profile.runtime_provenance.source_revision.as_str(),
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ),
        Err(ProfileServiceError::Patch(
            ProfilePatchError::StaleAuthority
        ))
    ));
    let editor = service
        .patch_editor(
            &profile.id,
            profile.runtime_provenance.source_revision.as_str(),
            profile.runtime_provenance.artifact_fingerprint.as_str(),
        )
        .unwrap();
    let json = serde_json::to_string(&editor).unwrap();
    for secret in [
        TOKEN,
        "not-a-real-password",
        "192.0.2.10",
        "/fictional/profile.yaml",
    ] {
        assert!(!json.contains(secret));
    }
}

#[tokio::test]
async fn every_profile_write_entry_rejects_a_concurrent_shared_authority_holder() {
    let temp = TestDir::new();
    let service = service(
        temp.path().to_path_buf(),
        SequencedReader::new([
            VALID_PROFILE.as_bytes().to_vec(),
            VALID_PROFILE.as_bytes().to_vec(),
        ]),
    );
    let first = service
        .preflight_https(
            "https://profiles.example/first.yaml",
            Some("First".to_owned()),
        )
        .await
        .unwrap();
    let snapshot = service.save_preview(&first.preview_id).await.unwrap();
    let profile = &snapshot.profiles[0];
    let pending = service
        .preflight_https(
            "https://profiles.example/second.yaml",
            Some("Second".to_owned()),
        )
        .await
        .unwrap();
    let editor = service
        .patch_editor(
            &profile.id,
            profile.runtime_provenance.source_revision.as_str(),
            profile.runtime_provenance.artifact_fingerprint.as_str(),
        )
        .unwrap();
    let permit = service.mutation_authority().try_acquire().unwrap();

    assert!(matches!(
        service.save_preview(&pending.preview_id).await,
        Err(ProfileServiceError::Busy)
    ));
    assert!(matches!(
        service.refresh(&profile.id).await,
        Err(ProfileServiceError::Busy)
    ));
    assert!(matches!(
        service.set_refresh_policy(&profile.id, ProfileRefreshPolicy::Daily),
        Err(ProfileServiceError::Busy)
    ));
    assert!(matches!(
        service.replace_patches(
            &profile.id,
            &editor.authority.source_revision,
            &editor.authority.artifact_fingerprint,
            Vec::new(),
        ),
        Err(ProfileServiceError::Busy)
    ));
    assert!(matches!(
        service.delete(&profile.id),
        Err(ProfileServiceError::Busy)
    ));
    drop(permit);

    assert_eq!(service.snapshot().unwrap().profiles.len(), 1);
    assert_eq!(
        service
            .save_preview(&pending.preview_id)
            .await
            .unwrap()
            .profiles
            .len(),
        2
    );
}

#[tokio::test]
async fn refresh_holds_mutation_authority_across_the_network_read() {
    let temp = TestDir::new();
    let reader = GatedRefreshReader::new();
    let service = Arc::new(ProfileService::new(
        temp.path().to_path_buf(),
        reader.clone(),
        reader.clone(),
        SourceReadPolicy::default(),
    ));
    let preview = service
        .preflight_https(
            "https://profiles.example/gated.yaml",
            Some("Gated".to_owned()),
        )
        .await
        .unwrap();
    let snapshot = service.save_preview(&preview.preview_id).await.unwrap();
    let profile_id = snapshot.profiles[0].id.clone();
    let refreshing = {
        let service = service.clone();
        tokio::spawn(async move { service.refresh(&profile_id).await })
    };
    reader.entered.notified().await;

    assert!(matches!(
        service.mutation_authority().try_acquire(),
        Err(mish_state_authority::StateMutationError::Busy)
    ));
    reader.release.notify_one();
    refreshing.await.unwrap().unwrap();
    assert!(service.mutation_authority().try_acquire().is_ok());
}
