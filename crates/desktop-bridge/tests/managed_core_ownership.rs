use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::future::{BoxFuture, ready};
use mish_bridge::{
    DesktopMihomoProcess, DesktopMihomoProcessConfig, ManagedCoreLaunchSpec, ManagedCoreOwnership,
    ManagedProcessObservation, ManagedProcessPlatform, ManagedProcessPlatformError,
    ManagedRuntimeLease,
};
use mish_runtime::{CorePhase, CoreRuntime, LoopbackProxyEndpoint};

#[derive(Clone)]
struct FakeProcess {
    observation: ManagedProcessObservation,
    running: bool,
}

#[derive(Default)]
struct FakeProcessPlatform {
    prepared: Mutex<Option<ManagedCoreLaunchSpec>>,
    processes: Mutex<HashMap<u32, FakeProcess>>,
    next_pid: Mutex<u32>,
    terminations: Mutex<Vec<u32>>,
    listener_owned: AtomicBool,
}

impl FakeProcessPlatform {
    fn spawn(&self, spec: &ManagedCoreLaunchSpec) -> u32 {
        let mut next_pid = self.next_pid.lock().unwrap();
        *next_pid = (*next_pid).max(4100) + 1;
        let pid = *next_pid;
        self.processes.lock().unwrap().insert(
            pid,
            FakeProcess {
                observation: ManagedProcessObservation::from_launch(
                    pid,
                    900_000 + u64::from(pid),
                    spec,
                ),
                running: true,
            },
        );
        pid
    }

    fn running(&self, pid: u32) -> bool {
        self.processes
            .lock()
            .unwrap()
            .get(&pid)
            .is_some_and(|process| process.running)
    }

    fn replace_observation(&self, pid: u32, observation: ManagedProcessObservation) {
        self.processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .observation = observation;
    }

    fn termination_count(&self) -> usize {
        self.terminations.lock().unwrap().len()
    }

    fn set_listener_owned(&self, owned: bool) {
        self.listener_owned.store(owned, Ordering::Relaxed);
    }
}

impl ManagedProcessPlatform for FakeProcessPlatform {
    fn prepare_launch(
        &self,
        spec: &ManagedCoreLaunchSpec,
    ) -> Result<(), ManagedProcessPlatformError> {
        *self.prepared.lock().unwrap() = Some(spec.clone());
        Ok(())
    }

    fn inspect(
        &self,
        pid: u32,
    ) -> Result<Option<ManagedProcessObservation>, ManagedProcessPlatformError> {
        let mut processes = self.processes.lock().unwrap();
        if !processes.contains_key(&pid)
            && let Some(spec) = self.prepared.lock().unwrap().clone()
        {
            processes.insert(
                pid,
                FakeProcess {
                    observation: ManagedProcessObservation::from_launch(
                        pid,
                        900_000 + u64::from(pid),
                        &spec,
                    ),
                    running: true,
                },
            );
        }
        Ok(processes
            .get(&pid)
            .filter(|process| process.running)
            .map(|process| process.observation.clone()))
    }

    fn find_launch(
        &self,
        spec: &ManagedCoreLaunchSpec,
    ) -> Result<Vec<ManagedProcessObservation>, ManagedProcessPlatformError> {
        Ok(self
            .processes
            .lock()
            .unwrap()
            .values()
            .filter(|process| {
                process.running && process.observation.launch_token() == spec.launch_token()
            })
            .map(|process| process.observation.clone())
            .collect())
    }

    fn terminate(&self, pid: u32) -> Result<(), ManagedProcessPlatformError> {
        self.terminations.lock().unwrap().push(pid);
        if let Some(process) = self.processes.lock().unwrap().get_mut(&pid) {
            process.running = false;
        }
        Ok(())
    }

    fn kill(&self, pid: u32) -> Result<(), ManagedProcessPlatformError> {
        self.terminate(pid)
    }

    fn wait_for_exit(
        &self,
        pid: u32,
        _deadline: Duration,
    ) -> BoxFuture<'_, Result<bool, ManagedProcessPlatformError>> {
        Box::pin(ready(Ok(!self.running(pid))))
    }

    fn owns_listener(
        &self,
        process: &ManagedProcessObservation,
        _endpoint: &LoopbackProxyEndpoint,
    ) -> Result<bool, ManagedProcessPlatformError> {
        Ok(self.running(process.pid()) && self.listener_owned.load(Ordering::Relaxed))
    }
}

#[tokio::test]
async fn restart_recovers_a_proven_orphan_before_the_next_listener_probe() {
    let root = tempfile::tempdir().unwrap();
    let runtime_root = root.path().join("runtime");
    let candidate_root = runtime_root.join("candidates/11111111-1111-4111-8111-111111111111");
    std::fs::create_dir_all(candidate_root.join("home")).unwrap();
    std::fs::write(candidate_root.join("config.yaml"), "proxies: []\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            candidate_root.join("home"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::set_permissions(
            candidate_root.join("config.yaml"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let binary = root.path().join("managed-mihomo");
    std::fs::write(&binary, "fixture").unwrap();
    let platform = Arc::new(FakeProcessPlatform::default());

    let first_lease = ManagedRuntimeLease::acquire(&runtime_root).unwrap();
    let first =
        ManagedCoreOwnership::new(runtime_root.clone(), platform.clone(), first_lease).unwrap();
    let launch = first
        .begin_launch(
            binary.clone(),
            candidate_root.join("home"),
            candidate_root.join("config.yaml"),
        )
        .unwrap();
    let pid = platform.spawn(launch.spec());
    first.commit_launch(&launch, pid).await.unwrap();
    assert!(platform.running(pid));
    assert!(!port_available(&platform));

    drop(first);
    let second_lease = ManagedRuntimeLease::acquire(&runtime_root).unwrap();
    let second = ManagedCoreOwnership::new(runtime_root, platform.clone(), second_lease).unwrap();
    let recovered = second.recover_startup().await.unwrap();

    assert_eq!(recovered.recovered_pid(), Some(pid));
    assert!(!platform.running(pid));
    assert!(port_available(&platform));
    assert!(!second.has_record().unwrap());
}

#[tokio::test]
async fn restart_recovers_a_core_spawned_before_the_pid_commit() {
    let fixture = OwnershipFixture::new();
    let first = fixture.first();
    let launch = first
        .begin_launch(
            fixture.binary.clone(),
            fixture.candidate_root.join("home"),
            fixture.candidate_root.join("config.yaml"),
        )
        .unwrap();
    let pid = fixture.platform.spawn(launch.spec());
    drop(first);
    let second = fixture.reopen();

    let recovered = second.recover_startup().await.unwrap();

    assert_eq!(recovered.recovered_pid(), Some(pid));
    assert!(!fixture.platform.running(pid));
    assert!(!second.has_record().unwrap());
}

#[tokio::test]
async fn recovery_rejects_pid_reuse_without_signalling_the_replacement_process() {
    let fixture = OwnershipFixture::new();
    let (first, launch, pid) = fixture.committed_process().await;
    drop(first);
    fixture.platform.replace_observation(
        pid,
        ManagedProcessObservation::from_launch(pid, 42, launch.spec()),
    );
    let second = fixture.reopen();

    let error = second.recover_startup().await.unwrap_err();

    assert_eq!(
        error.to_string(),
        "managed Core process identity could not be confirmed"
    );
    assert_eq!(fixture.platform.termination_count(), 0);
    assert!(fixture.platform.running(pid));
    assert!(second.has_record().unwrap());
}

#[tokio::test]
async fn recovery_rejects_a_non_mish_process_even_when_the_pid_matches() {
    let fixture = OwnershipFixture::new();
    let (first, launch, pid) = fixture.committed_process().await;
    drop(first);
    fixture.platform.replace_observation(
        pid,
        ManagedProcessObservation::new(
            pid,
            900_000 + u64::from(pid),
            launch.spec().binary().to_path_buf(),
            launch.spec().config_directory().to_path_buf(),
            launch.spec().config_file().to_path_buf(),
            "22222222-2222-4222-8222-222222222222".to_owned(),
        ),
    );
    let second = fixture.reopen();

    assert!(second.recover_startup().await.is_err());
    assert_eq!(fixture.platform.termination_count(), 0);
    assert!(fixture.platform.running(pid));
}

#[tokio::test]
async fn recovery_rejects_an_invalid_record_without_process_mutation() {
    let fixture = OwnershipFixture::new();
    let first = fixture.first();
    drop(first);
    let record = fixture.runtime_root.join("core-ownership.json");
    std::fs::write(&record, "{").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let second = fixture.reopen();

    assert!(second.recover_startup().await.is_err());
    assert_eq!(fixture.platform.termination_count(), 0);
    assert!(record.exists());
}

#[tokio::test]
async fn normal_exit_clears_only_the_matching_generation() {
    let fixture = OwnershipFixture::new();
    let first = fixture.first();
    let launch = first
        .begin_launch(
            fixture.binary.clone(),
            fixture.candidate_root.join("home"),
            fixture.candidate_root.join("config.yaml"),
        )
        .unwrap();
    let pid = fixture.platform.spawn(launch.spec());
    let process = first.commit_launch(&launch, pid).await.unwrap();

    first.clear_process(&process).unwrap();

    assert!(!first.has_record().unwrap());
}

#[tokio::test]
async fn managed_process_stop_terminates_waits_reaps_and_clears_ownership() {
    let fixture = OwnershipFixture::new();
    let lease = ManagedRuntimeLease::acquire(&fixture.runtime_root).unwrap();
    let ownership = Arc::new(
        ManagedCoreOwnership::new(
            fixture.runtime_root.clone(),
            fixture.platform.clone(),
            lease,
        )
        .unwrap(),
    );
    let process = DesktopMihomoProcess::new_pinned_owned(
        DesktopMihomoProcessConfig {
            binary: Some(test_fixture("fake-activation-mihomo.sh")),
            config_directory: Some(fixture.candidate_root.join("home")),
            config_file: Some(fixture.candidate_root.join("config.yaml")),
        },
        "v1.19.29",
        ownership.clone(),
    );

    let running = process.start().await.unwrap();
    assert!(matches!(running.phase, CorePhase::Running));
    assert!(ownership.has_record().unwrap());

    let stopped = process.stop().await.unwrap();

    assert!(matches!(stopped.phase, CorePhase::Stopped));
    assert!(!ownership.has_record().unwrap());
}

#[tokio::test]
async fn managed_process_does_not_claim_an_external_listener() {
    let fixture = OwnershipFixture::new();
    fixture.platform.set_listener_owned(false);
    let lease = ManagedRuntimeLease::acquire(&fixture.runtime_root).unwrap();
    let ownership = Arc::new(
        ManagedCoreOwnership::new(
            fixture.runtime_root.clone(),
            fixture.platform.clone(),
            lease,
        )
        .unwrap(),
    );
    let process = DesktopMihomoProcess::new_pinned_owned(
        DesktopMihomoProcessConfig {
            binary: Some(test_fixture("fake-activation-mihomo.sh")),
            config_directory: Some(fixture.candidate_root.join("home")),
            config_file: Some(fixture.candidate_root.join("config.yaml")),
        },
        "v1.19.29",
        ownership,
    );

    process.start().await.unwrap();

    assert!(
        !process
            .owns_local_proxy(&LoopbackProxyEndpoint::managed())
            .await
    );
    process.stop().await.unwrap();
}

#[test]
fn a_second_desktop_instance_cannot_share_the_runtime_root() {
    let fixture = OwnershipFixture::new();
    let _first = fixture.first();

    let error = ManagedRuntimeLease::acquire(&fixture.runtime_root).unwrap_err();

    assert_eq!(
        error.to_string(),
        "another Mish desktop instance owns the managed runtime"
    );
}

fn port_available(platform: &FakeProcessPlatform) -> bool {
    !platform
        .processes
        .lock()
        .unwrap()
        .values()
        .any(|process| process.running)
}

struct OwnershipFixture {
    _root: tempfile::TempDir,
    binary: std::path::PathBuf,
    candidate_root: std::path::PathBuf,
    platform: Arc<FakeProcessPlatform>,
    runtime_root: std::path::PathBuf,
}

impl OwnershipFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let runtime_root = root.path().join("runtime");
        let candidate_root = runtime_root.join("candidates/11111111-1111-4111-8111-111111111111");
        std::fs::create_dir_all(candidate_root.join("home")).unwrap();
        std::fs::write(candidate_root.join("config.yaml"), "proxies: []\n").unwrap();
        let binary = root.path().join("managed-mihomo");
        std::fs::write(&binary, "fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                candidate_root.join("home"),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
            std::fs::set_permissions(
                candidate_root.join("config.yaml"),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        Self {
            _root: root,
            binary,
            candidate_root,
            platform: Arc::new(FakeProcessPlatform::default()),
            runtime_root,
        }
    }

    fn first(&self) -> ManagedCoreOwnership {
        let lease = ManagedRuntimeLease::acquire(&self.runtime_root).unwrap();
        ManagedCoreOwnership::new(self.runtime_root.clone(), self.platform.clone(), lease).unwrap()
    }

    fn reopen(&self) -> ManagedCoreOwnership {
        self.first()
    }

    async fn committed_process(
        &self,
    ) -> (ManagedCoreOwnership, mish_bridge::ManagedCoreLaunch, u32) {
        let first = self.first();
        let launch = first
            .begin_launch(
                self.binary.clone(),
                self.candidate_root.join("home"),
                self.candidate_root.join("config.yaml"),
            )
            .unwrap();
        let pid = self.platform.spawn(launch.spec());
        first.commit_launch(&launch, pid).await.unwrap();
        (first, launch, pid)
    }
}

fn test_fixture(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}
