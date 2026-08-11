use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::future::BoxFuture;
use mish_bridge::{
    DesktopMihomoProcess, DesktopMihomoProcessConfig, ManagedCoreLaunchSpec, ManagedCoreOperation,
    ManagedCoreOperationEvent, ManagedCoreOperationObserver, ManagedCoreOperationResult,
    ManagedCoreOwnership, ManagedProcessObservation, ManagedProcessPlatform,
    ManagedProcessPlatformError, ManagedProcessSignalOutcome, ManagedProcessWaitOutcome,
    ManagedRuntimeLease,
};
use mish_runtime::{
    CoreError, CoreLifecycleMutation, CoreLifecycleOperation, CorePhase, CoreRuntime, CoreStatus,
    LocalProxyOwnership, LoopbackProxyEndpoint, MishRuntime,
};

async fn mutate_core(
    process: &DesktopMihomoProcess,
    mutation: CoreLifecycleMutation,
) -> Result<CoreStatus, CoreError> {
    MishRuntime::new(Arc::new(process.clone()))
        .execute_core_lifecycle(
            &CoreLifecycleOperation::new("ownership-test", 1, "owned-process", 1, 1).unwrap(),
            mutation,
        )
        .await
}

fn invocation(operation: ManagedCoreOperation) -> ManagedCoreOperationEvent {
    ManagedCoreOperationEvent::Invocation { operation }
}

fn result(
    operation: ManagedCoreOperation,
    result: ManagedCoreOperationResult,
) -> ManagedCoreOperationEvent {
    ManagedCoreOperationEvent::Result { operation, result }
}

#[derive(Clone)]
struct FakeProcess {
    observation: ManagedProcessObservation,
    running: bool,
}

#[derive(Clone)]
struct OperationTranscript {
    events: Arc<Mutex<Vec<ManagedCoreOperationEvent>>>,
}

impl OperationTranscript {
    const LIMIT: usize = 32;

    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn observer(&self) -> ManagedCoreOperationObserver {
        let events = self.events.clone();
        Arc::new(move |event| {
            let mut events = events.lock().unwrap();
            if events.len() < Self::LIMIT {
                events.push(event);
            }
        })
    }

    fn events(&self) -> Vec<ManagedCoreOperationEvent> {
        self.events.lock().unwrap().clone()
    }
}

#[derive(Default)]
struct FakeProcessPlatform {
    prepared: Mutex<Option<ManagedCoreLaunchSpec>>,
    processes: Mutex<HashMap<u32, FakeProcess>>,
    inspect_counts: Mutex<HashMap<u32, usize>>,
    next_pid: Mutex<u32>,
    terminations: Mutex<Vec<u32>>,
    inspect_delay: Mutex<Option<Duration>>,
    listener_probe_delay: Mutex<Option<Duration>>,
    replace_before_inspection: Mutex<Option<(u32, usize, ManagedProcessObservation)>>,
    replace_before_listener_confirmation: Mutex<Option<ManagedProcessObservation>>,
    replace_before_signal: Mutex<Option<ManagedProcessObservation>>,
    observation_fails: AtomicBool,
    listener_inspection_fails: AtomicBool,
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

    fn fail_listener_inspection(&self) {
        self.listener_inspection_fails
            .store(true, Ordering::Relaxed);
    }

    fn delay_identity_observation(&self, delay: Duration) {
        *self.inspect_delay.lock().unwrap() = Some(delay);
    }

    fn delay_listener_probe(&self, delay: Duration) {
        *self.listener_probe_delay.lock().unwrap() = Some(delay);
    }

    fn fail_identity_observation(&self) {
        self.observation_fails.store(true, Ordering::Relaxed);
    }

    fn replace_before_next_signal(&self, observation: ManagedProcessObservation) {
        *self.replace_before_signal.lock().unwrap() = Some(observation);
    }

    fn replace_before_inspection(
        &self,
        pid: u32,
        inspection: usize,
        observation: ManagedProcessObservation,
    ) {
        *self.replace_before_inspection.lock().unwrap() = Some((pid, inspection, observation));
    }

    fn replace_before_listener_confirmation(&self, observation: ManagedProcessObservation) {
        *self.replace_before_listener_confirmation.lock().unwrap() = Some(observation);
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
    ) -> BoxFuture<'_, Result<Option<ManagedProcessObservation>, ManagedProcessPlatformError>> {
        let delay = *self.inspect_delay.lock().unwrap();
        Box::pin(async move {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            if self.observation_fails.load(Ordering::Relaxed) {
                return Err(ManagedProcessPlatformError::ObservationFailed);
            }
            let inspection = {
                let mut counts = self.inspect_counts.lock().unwrap();
                let count = counts.entry(pid).or_default();
                *count = count.saturating_add(1);
                *count
            };
            let replacement = {
                let mut pending = self.replace_before_inspection.lock().unwrap();
                if pending
                    .as_ref()
                    .is_some_and(|(target_pid, target_inspection, _)| {
                        *target_pid == pid && *target_inspection == inspection
                    })
                {
                    pending.take().map(|(_, _, replacement)| replacement)
                } else {
                    None
                }
            };
            if let Some(replacement) = replacement {
                self.replace_observation(pid, replacement);
            }
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
        })
    }

    fn find_launch(
        &self,
        spec: ManagedCoreLaunchSpec,
    ) -> BoxFuture<'_, Result<Vec<ManagedProcessObservation>, ManagedProcessPlatformError>> {
        Box::pin(async move {
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
        })
    }

    fn terminate(
        &self,
        expected: ManagedProcessObservation,
    ) -> BoxFuture<'_, Result<ManagedProcessSignalOutcome, ManagedProcessPlatformError>> {
        Box::pin(async move {
            if let Some(replacement) = self.replace_before_signal.lock().unwrap().take() {
                self.replace_observation(expected.pid(), replacement);
            }
            let mut processes = self.processes.lock().unwrap();
            let Some(process) = processes.get_mut(&expected.pid()) else {
                return Ok(ManagedProcessSignalOutcome::AlreadyExited);
            };
            if !process.running {
                return Ok(ManagedProcessSignalOutcome::AlreadyExited);
            }
            if process.observation != expected {
                return Err(ManagedProcessPlatformError::IdentityMismatch);
            }
            self.terminations.lock().unwrap().push(expected.pid());
            process.running = false;
            Ok(ManagedProcessSignalOutcome::Signalled)
        })
    }

    fn kill(
        &self,
        expected: ManagedProcessObservation,
    ) -> BoxFuture<'_, Result<ManagedProcessSignalOutcome, ManagedProcessPlatformError>> {
        self.terminate(expected)
    }

    fn wait_for_exit(
        &self,
        expected: ManagedProcessObservation,
        deadline: Duration,
    ) -> BoxFuture<'_, Result<ManagedProcessWaitOutcome, ManagedProcessPlatformError>> {
        Box::pin(async move {
            let expires = tokio::time::Instant::now() + deadline;
            loop {
                let process = self.processes.lock().unwrap().get(&expected.pid()).cloned();
                match process {
                    None => return Ok(ManagedProcessWaitOutcome::Exited),
                    Some(process) if !process.running => {
                        return Ok(ManagedProcessWaitOutcome::Exited);
                    }
                    Some(process) if process.observation != expected => {
                        return Ok(ManagedProcessWaitOutcome::Replaced);
                    }
                    Some(_) if tokio::time::Instant::now() >= expires => {
                        return Ok(ManagedProcessWaitOutcome::TimedOut);
                    }
                    Some(_) => tokio::time::sleep(Duration::from_millis(5)).await,
                }
            }
        })
    }

    fn owns_listener(
        &self,
        process: ManagedProcessObservation,
        _endpoint: LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<bool, ManagedProcessPlatformError>> {
        let delay = *self.listener_probe_delay.lock().unwrap();
        Box::pin(async move {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            if let Some(replacement) = self
                .replace_before_listener_confirmation
                .lock()
                .unwrap()
                .take()
            {
                self.replace_observation(process.pid(), replacement);
            }
            if self.listener_inspection_fails.load(Ordering::Relaxed) {
                return Err(ManagedProcessPlatformError::ListenerInspectionFailed);
            }
            Ok(self.running(process.pid()) && self.listener_owned.load(Ordering::Relaxed))
        })
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
            fixture.config_directory.clone(),
            fixture.config_file.clone(),
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
        "managed Core process was replaced before the guarded operation"
    );
    assert_eq!(fixture.platform.termination_count(), 0);
    assert!(fixture.platform.running(pid));
    assert!(second.has_record().unwrap());
}

#[tokio::test]
async fn recovery_rechecks_identity_at_the_signal_boundary() {
    let fixture = OwnershipFixture::new();
    let (first, launch, pid) = fixture.committed_process().await;
    drop(first);
    fixture
        .platform
        .replace_before_next_signal(ManagedProcessObservation::from_launch(
            pid,
            42,
            launch.spec(),
        ));
    let second = fixture.reopen();

    assert_eq!(
        second.recover_startup().await.unwrap_err(),
        mish_bridge::ManagedCoreOwnershipError::ReplacementDetected
    );
    assert_eq!(fixture.platform.termination_count(), 0);
    assert!(fixture.platform.running(pid));
    assert!(second.has_record().unwrap());
}

#[tokio::test]
async fn commit_types_a_bounded_identity_observation_timeout() {
    let fixture = OwnershipFixture::new();
    let first = fixture.first();
    let launch = first
        .begin_launch(
            fixture.binary.clone(),
            fixture.config_directory.clone(),
            fixture.config_file.clone(),
        )
        .unwrap();
    fixture
        .platform
        .delay_identity_observation(Duration::from_secs(1));

    assert_eq!(
        first.commit_launch(&launch, 4242).await.unwrap_err(),
        mish_bridge::ManagedCoreOwnershipError::ObservationTimeout
    );
    assert!(first.has_record().unwrap());
}

#[tokio::test]
async fn commit_transcript_rejects_replacement_at_the_record_barrier() {
    let fixture = OwnershipFixture::new();
    let transcript = OperationTranscript::new();
    let first = fixture.first_with_transcript(&transcript);
    let launch = fixture.begin_launch(&first).unwrap();
    let pid = fixture.platform.spawn(launch.spec());
    fixture.platform.replace_before_inspection(
        pid,
        2,
        ManagedProcessObservation::from_launch(pid, 42, launch.spec()),
    );

    assert_eq!(
        first.commit_launch(&launch, pid).await.unwrap_err(),
        mish_bridge::ManagedCoreOwnershipError::ReplacementDetected
    );
    assert_eq!(
        transcript.events(),
        vec![
            invocation(ManagedCoreOperation::CommitIdentity),
            result(
                ManagedCoreOperation::CommitIdentity,
                ManagedCoreOperationResult::Verified,
            ),
            invocation(ManagedCoreOperation::CommitIdentity),
            result(
                ManagedCoreOperation::CommitIdentity,
                ManagedCoreOperationResult::Replaced,
            ),
        ]
    );
    assert!(first.has_record().unwrap());
    assert_eq!(fixture.platform.termination_count(), 0);
}

#[tokio::test]
async fn pid_reuse_recovery_transcript_never_invokes_signal() {
    let fixture = OwnershipFixture::new();
    let (first, launch, pid) = fixture.committed_process().await;
    drop(first);
    fixture.platform.replace_observation(
        pid,
        ManagedProcessObservation::from_launch(pid, 42, launch.spec()),
    );
    let transcript = OperationTranscript::new();
    let second = fixture.reopen_with_transcript(&transcript);

    assert_eq!(
        second.recover_startup().await.unwrap_err(),
        mish_bridge::ManagedCoreOwnershipError::ReplacementDetected
    );
    assert_eq!(
        transcript.events(),
        vec![
            invocation(ManagedCoreOperation::RecoveryIdentity),
            result(
                ManagedCoreOperation::RecoveryIdentity,
                ManagedCoreOperationResult::Replaced,
            ),
        ]
    );
    assert_eq!(fixture.platform.termination_count(), 0);
}

#[tokio::test]
async fn replacement_signal_transcript_stops_before_mutating_the_replacement() {
    let fixture = OwnershipFixture::new();
    let (first, launch, pid) = fixture.committed_process().await;
    drop(first);
    fixture
        .platform
        .replace_before_next_signal(ManagedProcessObservation::from_launch(
            pid,
            42,
            launch.spec(),
        ));
    let transcript = OperationTranscript::new();
    let second = fixture.reopen_with_transcript(&transcript);

    assert_eq!(
        second.recover_startup().await.unwrap_err(),
        mish_bridge::ManagedCoreOwnershipError::ReplacementDetected
    );
    assert_eq!(
        transcript.events(),
        vec![
            invocation(ManagedCoreOperation::RecoveryIdentity),
            result(
                ManagedCoreOperation::RecoveryIdentity,
                ManagedCoreOperationResult::Verified,
            ),
            invocation(ManagedCoreOperation::Signal),
            result(
                ManagedCoreOperation::Signal,
                ManagedCoreOperationResult::Replaced,
            ),
        ]
    );
    assert_eq!(fixture.platform.termination_count(), 0);
}

#[tokio::test]
async fn timeout_transcript_is_bounded_and_does_not_signal() {
    let fixture = OwnershipFixture::new();
    let transcript = OperationTranscript::new();
    let first = fixture.first_with_transcript(&transcript);
    let launch = fixture.begin_launch(&first).unwrap();
    fixture
        .platform
        .delay_identity_observation(Duration::from_secs(1));

    assert_eq!(
        first.commit_launch(&launch, 4242).await.unwrap_err(),
        mish_bridge::ManagedCoreOwnershipError::ObservationTimeout
    );
    assert_eq!(
        transcript.events(),
        vec![
            invocation(ManagedCoreOperation::CommitIdentity),
            result(
                ManagedCoreOperation::CommitIdentity,
                ManagedCoreOperationResult::TimedOut,
            ),
        ]
    );
    assert!(transcript.events().len() <= OperationTranscript::LIMIT);
    assert_eq!(fixture.platform.termination_count(), 0);
}

#[tokio::test]
async fn normal_termination_transcript_signals_waits_and_clears_recovery() {
    let fixture = OwnershipFixture::new();
    let (first, _launch, pid) = fixture.committed_process().await;
    drop(first);
    let transcript = OperationTranscript::new();
    let second = fixture.reopen_with_transcript(&transcript);

    assert_eq!(
        second.recover_startup().await.unwrap(),
        mish_bridge::ManagedCoreRecoveryOutcome::Recovered { pid }
    );
    assert_eq!(
        transcript.events(),
        vec![
            invocation(ManagedCoreOperation::RecoveryIdentity),
            result(
                ManagedCoreOperation::RecoveryIdentity,
                ManagedCoreOperationResult::Verified,
            ),
            invocation(ManagedCoreOperation::Signal),
            result(
                ManagedCoreOperation::Signal,
                ManagedCoreOperationResult::Signalled,
            ),
            invocation(ManagedCoreOperation::WaitForExit),
            result(
                ManagedCoreOperation::WaitForExit,
                ManagedCoreOperationResult::Exited,
            ),
        ]
    );
    assert!(!second.has_record().unwrap());
}

#[tokio::test]
async fn identity_debug_output_redacts_paths_and_launch_tokens() {
    let fixture = OwnershipFixture::new();
    let first = fixture.first();
    let launch = fixture.begin_launch(&first).unwrap();
    let launch_debug = format!("{launch:?}");

    assert!(!launch_debug.contains(launch.launch_token()));
    assert!(!launch_debug.contains(fixture.binary.to_str().unwrap()));
    assert!(launch_debug.contains("[redacted]"));

    let pid = fixture.platform.spawn(launch.spec());
    let process = first.commit_launch(&launch, pid).await.unwrap();
    let process_debug = format!("{process:?}");
    assert!(!process_debug.contains(process.observation().launch_token()));
    assert!(!process_debug.contains(fixture.config_file.to_str().unwrap()));
}

#[tokio::test]
async fn recovery_types_observation_failure_without_signalling() {
    let fixture = OwnershipFixture::new();
    let (first, _launch, pid) = fixture.committed_process().await;
    drop(first);
    fixture.platform.fail_identity_observation();
    let second = fixture.reopen();

    assert_eq!(
        second.recover_startup().await.unwrap_err(),
        mish_bridge::ManagedCoreOwnershipError::ObservationFailed
    );
    assert_eq!(fixture.platform.termination_count(), 0);
    assert!(fixture.platform.running(pid));
    assert!(second.has_record().unwrap());
}

#[tokio::test]
async fn wait_types_replacement_without_signalling() {
    let fixture = OwnershipFixture::new();
    let first = fixture.first();
    let launch = fixture
        .begin_launch(&first)
        .expect("launch admission should succeed");
    let pid = fixture.platform.spawn(launch.spec());
    let process = first.commit_launch(&launch, pid).await.unwrap();
    fixture.platform.replace_observation(
        pid,
        ManagedProcessObservation::from_launch(pid, 42, launch.spec()),
    );

    assert_eq!(
        first
            .wait_for_exit(process.observation(), Duration::from_millis(20))
            .await
            .unwrap(),
        ManagedProcessWaitOutcome::Replaced
    );
    assert_eq!(fixture.platform.termination_count(), 0);
}

#[tokio::test]
async fn wait_types_timeout_without_signalling() {
    let fixture = OwnershipFixture::new();
    let (first, _launch, process, _pid) = fixture.committed_process_with_handle().await;

    assert_eq!(
        first
            .wait_for_exit(process.observation(), Duration::from_millis(20))
            .await
            .unwrap(),
        ManagedProcessWaitOutcome::TimedOut
    );
    assert_eq!(fixture.platform.termination_count(), 0);
}

#[tokio::test]
async fn listener_probe_timeout_is_unknown_and_never_owned() {
    let fixture = OwnershipFixture::new();
    let (first, _launch, process, _pid) = fixture.committed_process_with_handle().await;
    fixture.platform.set_listener_owned(true);
    fixture
        .platform
        .delay_listener_probe(Duration::from_secs(2));

    assert_eq!(
        first
            .process_listener_ownership(&process, &LoopbackProxyEndpoint::managed())
            .await,
        LocalProxyOwnership::Unknown
    );
}

#[tokio::test]
async fn listener_probe_revalidates_identity_after_observation() {
    let fixture = OwnershipFixture::new();
    let (first, launch, process, pid) = fixture.committed_process_with_handle().await;
    fixture.platform.set_listener_owned(true);
    fixture
        .platform
        .replace_before_listener_confirmation(ManagedProcessObservation::from_launch(
            pid,
            42,
            launch.spec(),
        ));

    assert_eq!(
        first
            .process_listener_ownership(&process, &LoopbackProxyEndpoint::managed())
            .await,
        LocalProxyOwnership::Unowned
    );
}

#[tokio::test]
async fn listener_probe_transcript_records_identity_bound_ownership() {
    let fixture = OwnershipFixture::new();
    let transcript = OperationTranscript::new();
    let first = fixture.first_with_transcript(&transcript);
    let launch = fixture.begin_launch(&first).unwrap();
    let pid = fixture.platform.spawn(launch.spec());
    let process = first.commit_launch(&launch, pid).await.unwrap();
    let committed_events = transcript.events().len();
    fixture.platform.set_listener_owned(true);

    assert_eq!(
        first
            .process_listener_ownership(&process, &LoopbackProxyEndpoint::managed())
            .await,
        LocalProxyOwnership::Owned
    );
    assert_eq!(
        &transcript.events()[committed_events..],
        &[
            invocation(ManagedCoreOperation::ListenerProbe),
            result(
                ManagedCoreOperation::ListenerProbe,
                ManagedCoreOperationResult::Owned,
            ),
        ]
    );
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
            fixture.config_directory.clone(),
            fixture.config_file.clone(),
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
            config_directory: Some(fixture.config_directory.clone()),
            config_file: Some(fixture.config_file.clone()),
        },
        "v1.19.29",
        ownership.clone(),
    );

    let running = mutate_core(&process, CoreLifecycleMutation::Start)
        .await
        .unwrap();
    assert!(matches!(running.phase, CorePhase::Running));
    assert!(ownership.has_record().unwrap());

    let stopped = mutate_core(&process, CoreLifecycleMutation::Stop)
        .await
        .unwrap();

    assert!(matches!(stopped.phase, CorePhase::Stopped));
    assert!(!ownership.has_record().unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn managed_process_preserves_ownership_when_child_inspection_fails() {
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
            config_directory: Some(fixture.config_directory.clone()),
            config_file: Some(fixture.config_file.clone()),
        },
        "v1.19.29",
        ownership.clone(),
    );

    let running = mutate_core(&process, CoreLifecycleMutation::Start)
        .await
        .unwrap();
    let pid = running.pid.unwrap();
    let pid = i32::try_from(pid).unwrap();
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    let mut exit_status = 0;
    assert_eq!(unsafe { libc::waitpid(pid, &mut exit_status, 0) }, pid);

    let status = process.status().await;

    assert!(matches!(status.phase, CorePhase::Failed));
    assert!(ownership.has_record().unwrap());
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
            config_directory: Some(fixture.config_directory.clone()),
            config_file: Some(fixture.config_file.clone()),
        },
        "v1.19.29",
        ownership,
    );

    mutate_core(&process, CoreLifecycleMutation::Start)
        .await
        .unwrap();

    assert_eq!(
        process
            .local_proxy_ownership(&LoopbackProxyEndpoint::managed())
            .await,
        LocalProxyOwnership::Unowned
    );
    mutate_core(&process, CoreLifecycleMutation::Stop)
        .await
        .unwrap();
}

#[tokio::test]
async fn managed_process_preserves_unknown_listener_inspection() {
    let fixture = OwnershipFixture::new();
    fixture.platform.set_listener_owned(true);
    fixture.platform.fail_listener_inspection();
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
            config_directory: Some(fixture.config_directory.clone()),
            config_file: Some(fixture.config_file.clone()),
        },
        "v1.19.29",
        ownership,
    );

    mutate_core(&process, CoreLifecycleMutation::Start)
        .await
        .unwrap();

    assert_eq!(
        process
            .local_proxy_ownership(&LoopbackProxyEndpoint::managed())
            .await,
        LocalProxyOwnership::Unknown
    );
    mutate_core(&process, CoreLifecycleMutation::Stop)
        .await
        .unwrap();
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
    config_directory: std::path::PathBuf,
    config_file: std::path::PathBuf,
    platform: Arc<FakeProcessPlatform>,
    runtime_root: std::path::PathBuf,
}

impl OwnershipFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let runtime_root = root.path().join("runtime");
        let config_directory = runtime_root.join("mihomo/home");
        let config_file =
            runtime_root.join("mihomo/configs/11111111-1111-4111-8111-111111111111.yaml");
        std::fs::create_dir_all(&config_directory).unwrap();
        std::fs::create_dir_all(config_file.parent().unwrap()).unwrap();
        std::fs::write(&config_file, "proxies: []\n").unwrap();
        let binary = root.path().join("managed-mihomo");
        std::fs::write(&binary, "fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&config_directory, std::fs::Permissions::from_mode(0o700))
                .unwrap();
            std::fs::set_permissions(&config_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        Self {
            _root: root,
            binary,
            config_directory,
            config_file,
            platform: Arc::new(FakeProcessPlatform::default()),
            runtime_root,
        }
    }

    fn first(&self) -> ManagedCoreOwnership {
        let lease = ManagedRuntimeLease::acquire(&self.runtime_root).unwrap();
        ManagedCoreOwnership::new(self.runtime_root.clone(), self.platform.clone(), lease).unwrap()
    }

    fn first_with_transcript(&self, transcript: &OperationTranscript) -> ManagedCoreOwnership {
        self.first().with_operation_observer(transcript.observer())
    }

    fn reopen(&self) -> ManagedCoreOwnership {
        self.first()
    }

    fn reopen_with_transcript(&self, transcript: &OperationTranscript) -> ManagedCoreOwnership {
        self.first_with_transcript(transcript)
    }

    fn begin_launch(
        &self,
        ownership: &ManagedCoreOwnership,
    ) -> Result<mish_bridge::ManagedCoreLaunch, mish_bridge::ManagedCoreOwnershipError> {
        ownership.begin_launch(
            self.binary.clone(),
            self.config_directory.clone(),
            self.config_file.clone(),
        )
    }

    async fn committed_process(
        &self,
    ) -> (ManagedCoreOwnership, mish_bridge::ManagedCoreLaunch, u32) {
        let (first, launch, _process, pid) = self.committed_process_with_handle().await;
        (first, launch, pid)
    }

    async fn committed_process_with_handle(
        &self,
    ) -> (
        ManagedCoreOwnership,
        mish_bridge::ManagedCoreLaunch,
        mish_bridge::ManagedCoreProcess,
        u32,
    ) {
        let first = self.first();
        let launch = first
            .begin_launch(
                self.binary.clone(),
                self.config_directory.clone(),
                self.config_file.clone(),
            )
            .unwrap();
        let pid = self.platform.spawn(launch.spec());
        let process = first.commit_launch(&launch, pid).await.unwrap();
        (first, launch, process, pid)
    }
}

fn test_fixture(name: &str) -> std::path::PathBuf {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    if path.extension().and_then(|extension| extension.to_str()) != Some("sh") {
        return path;
    }
    let directory =
        std::env::temp_dir().join(format!("mish-test-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let copied = directory.join(name);
    std::fs::copy(path, &copied).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&copied, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    copied
}
