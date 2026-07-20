use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use futures_util::future::{BoxFuture, ready};
use mish_runtime::{
    CapabilityAvailability, CaptureAuditReason, CaptureJournal, CaptureJournalStore,
    CapturePlatform, CaptureReconciler, CaptureRecoveryAction, CaptureRequest, CaptureSelection,
    CaptureTransitionError, LocalProxyTestPhase, LoopbackProxyEndpoint, ManualProxyState,
    NetworkServiceProxyState, SystemProxyObservedState, SystemProxyPhase, TunHelperAvailability,
    TunHelperController, TunHelperError, TunHelperFailureKind, TunHelperHealth,
    TunHelperLifecycleOperation, TunHelperLifecyclePhase, TunHelperObservation, TunHelperPlatform,
    TunHelperSnapshot, TunPhase,
};

struct FakeTunHelper {
    fail_enable: Mutex<bool>,
    enabled: Mutex<bool>,
}

impl FakeTunHelper {
    fn new() -> Self {
        Self {
            fail_enable: Mutex::new(false),
            enabled: Mutex::new(false),
        }
    }

    fn fail_next_enable(&self) {
        *self.fail_enable.lock().unwrap() = true;
    }
}

impl TunHelperPlatform for FakeTunHelper {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
        TunHelperSnapshot {
            availability: TunHelperAvailability::Available,
            expected_version: "1".to_owned(),
            health: TunHelperHealth::Healthy,
            installed_version: Some("1".to_owned()),
            last_failure: None,
            phase: TunHelperLifecyclePhase::Idle,
        }
    }

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>> {
        Box::pin(async { Ok(TunHelperObservation::healthy("1")) })
    }

    fn run_lifecycle(
        &self,
        _operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async { Ok(()) })
    }

    fn observe_tun(&self) -> BoxFuture<'_, Result<bool, TunHelperError>> {
        let enabled = *self.enabled.lock().unwrap();
        Box::pin(async move { Ok(enabled) })
    }

    fn set_tun_enabled(&self, enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>> {
        if enabled && std::mem::take(&mut *self.fail_enable.lock().unwrap()) {
            return Box::pin(async {
                Err(TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "Synthetic TUN enable failure",
                ))
            });
        }
        *self.enabled.lock().unwrap() = enabled;
        Box::pin(async { Ok(()) })
    }
}

#[derive(Default)]
struct MemoryJournalStore {
    fail_reads: Mutex<bool>,
    journal: Mutex<Option<CaptureJournal>>,
}

impl MemoryJournalStore {
    fn fail_reads(&self) {
        *self.fail_reads.lock().unwrap() = true;
    }
}

impl CaptureJournalStore for MemoryJournalStore {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        if *self.fail_reads.lock().unwrap() {
            return Err(CaptureTransitionError::new(
                mish_runtime::CaptureFailureKind::PersistenceFailed,
                "Synthetic recovery journal failure",
            ));
        }
        Ok(self.journal.lock().unwrap().clone())
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        *self.journal.lock().unwrap() = Some(journal.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        *self.journal.lock().unwrap() = None;
        Ok(())
    }
}

struct UnreadableJournalStore;

impl CaptureJournalStore for UnreadableJournalStore {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        Err(CaptureTransitionError::new(
            mish_runtime::CaptureFailureKind::PersistenceFailed,
            "Synthetic recovery journal failure",
        ))
    }

    fn save(&self, _journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        unreachable!("an unreadable startup journal must fail before mutation")
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        unreachable!("an unreadable startup journal must not be cleared")
    }
}

struct InvalidJournalStore {
    fail_clears_remaining: Mutex<usize>,
    invalid: Mutex<bool>,
}

impl InvalidJournalStore {
    fn new() -> Self {
        Self {
            fail_clears_remaining: Mutex::new(0),
            invalid: Mutex::new(true),
        }
    }

    fn fail_next_clear(&self) {
        *self.fail_clears_remaining.lock().unwrap() = 1;
    }
}

impl CaptureJournalStore for InvalidJournalStore {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        if *self.invalid.lock().unwrap() {
            return Err(CaptureTransitionError::new(
                mish_runtime::CaptureFailureKind::InvalidRecovery,
                "Synthetic invalid recovery journal",
            ));
        }
        Ok(None)
    }

    fn save(&self, _journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        panic!("invalid recovery must be relinquished before a new journal is saved")
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        let mut failures = self.fail_clears_remaining.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Err(CaptureTransitionError::new(
                mish_runtime::CaptureFailureKind::PersistenceFailed,
                "Synthetic recovery journal clear failure",
            ));
        }
        *self.invalid.lock().unwrap() = false;
        Ok(())
    }
}

struct FakePlatform {
    active_service_id: Mutex<String>,
    apply_count: Mutex<usize>,
    fail_applies_remaining: Mutex<usize>,
    listener_ready: Mutex<bool>,
    listener_test_count: Mutex<usize>,
    fail_observations_remaining: Mutex<usize>,
    observe_count: Mutex<usize>,
    services: Mutex<HashMap<String, NetworkServiceProxyState>>,
}

impl FakePlatform {
    fn new(service: NetworkServiceProxyState) -> Self {
        Self {
            active_service_id: Mutex::new(service.service_id.clone()),
            apply_count: Mutex::new(0),
            fail_applies_remaining: Mutex::new(0),
            listener_ready: Mutex::new(true),
            listener_test_count: Mutex::new(0),
            fail_observations_remaining: Mutex::new(0),
            observe_count: Mutex::new(0),
            services: Mutex::new(HashMap::from([(service.service_id.clone(), service)])),
        }
    }

    fn fail_next_apply_partially(&self) {
        *self.fail_applies_remaining.lock().unwrap() = 1;
    }

    fn fail_next_applies_partially(&self, count: usize) {
        *self.fail_applies_remaining.lock().unwrap() = count;
    }

    fn fail_next_observations(&self, count: usize) {
        *self.fail_observations_remaining.lock().unwrap() = count;
    }

    fn set_listener_ready(&self, ready: bool) {
        *self.listener_ready.lock().unwrap() = ready;
    }

    fn apply_count(&self) -> usize {
        *self.apply_count.lock().unwrap()
    }

    fn observe_count(&self) -> usize {
        *self.observe_count.lock().unwrap()
    }

    fn listener_test_count(&self) -> usize {
        *self.listener_test_count.lock().unwrap()
    }

    fn service(&self, service_id: &str) -> NetworkServiceProxyState {
        self.services.lock().unwrap()[service_id].clone()
    }

    fn replace_service(&self, service: NetworkServiceProxyState) {
        self.services
            .lock()
            .unwrap()
            .insert(service.service_id.clone(), service);
    }

    fn switch_active_service(&self, service: NetworkServiceProxyState) {
        let service_id = service.service_id.clone();
        self.replace_service(service);
        *self.active_service_id.lock().unwrap() = service_id;
    }
}

impl CapturePlatform for FakePlatform {
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        *self.observe_count.lock().unwrap() += 1;
        let mut failures = self.fail_observations_remaining.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Box::pin(ready(Err(CaptureTransitionError::new(
                mish_runtime::CaptureFailureKind::ObservationFailed,
                "Synthetic observation failure",
            ))));
        }
        drop(failures);
        let service_id = self.active_service_id.lock().unwrap().clone();
        Box::pin(ready(
            Ok(self.services.lock().unwrap()[&service_id].clone()),
        ))
    }

    fn observe_service(
        &self,
        service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        *self.observe_count.lock().unwrap() += 1;
        Box::pin(ready(Ok(self.services.lock().unwrap()[service_id].clone())))
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        *self.apply_count.lock().unwrap() += 1;
        let mut failures = self.fail_applies_remaining.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            drop(failures);
            self.services
                .lock()
                .unwrap()
                .get_mut(&target.service_id)
                .unwrap()
                .http = target.http;
            return Box::pin(ready(Err(CaptureTransitionError::new(
                mish_runtime::CaptureFailureKind::ApplyFailed,
                "Synthetic partial failure",
            ))));
        }
        self.services
            .lock()
            .unwrap()
            .insert(target.service_id.clone(), target);
        Box::pin(ready(Ok(())))
    }

    fn confirm_proxy_listener(
        &self,
        _endpoint: &LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        *self.listener_test_count.lock().unwrap() += 1;
        if *self.listener_ready.lock().unwrap() {
            return Box::pin(ready(Ok(())));
        }
        Box::pin(ready(Err(CaptureTransitionError::new(
            mish_runtime::CaptureFailureKind::ListenerUnavailable,
            "Synthetic listener failure",
        ))))
    }
}

struct UnavailablePlatform;

impl CapturePlatform for UnavailablePlatform {
    fn availability(&self) -> CapabilityAvailability {
        CapabilityAvailability::Unavailable
    }

    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        unreachable!("unavailable platforms must not be observed")
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        unreachable!("unavailable platforms must not be observed")
    }

    fn apply_service(
        &self,
        _target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        unreachable!("unavailable platforms must not be changed")
    }
}

#[tokio::test]
async fn partial_apply_failure_rolls_back_and_keeps_success_unpublished() {
    let prior = disabled_service();
    let platform = Arc::new(FakePlatform::new(prior.clone()));
    platform.fail_next_apply_partially();
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        Arc::new(MemoryJournalStore::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(error.kind, mish_runtime::CaptureFailureKind::ApplyFailed);
    assert_eq!(platform.service("service-a"), prior);
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Failed
    );
    assert!(!reconciler.status().system_proxy_enabled);
}

#[tokio::test]
async fn unavailable_platform_rejects_capture_without_attempting_observation() {
    let reconciler = CaptureReconciler::new(
        Arc::new(UnavailablePlatform),
        Arc::new(MemoryJournalStore::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::CapabilityUnavailable
    );
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Failed
    );
}

#[tokio::test]
async fn rejected_tun_request_preserves_confirmed_system_proxy_ownership() {
    let original = disabled_service();
    let platform = Arc::new(FakePlatform::new(original.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap();
    let reconciler = CaptureReconciler::new(platform.clone(), journal.clone(), endpoint.clone());
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: true,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::CapabilityUnavailable
    );
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Applied
    );
    assert!(!reconciler.status().capture_selection.tun);
    assert!(platform.service("service-a").is_mish_endpoint(&endpoint));
    assert_eq!(journal.load().unwrap().unwrap().prior, original);
}

#[tokio::test]
async fn startup_audit_confirms_default_off_without_selecting_system_proxy() {
    let reconciler = CaptureReconciler::new(
        Arc::new(FakePlatform::new(disabled_service())),
        Arc::new(MemoryJournalStore::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let status = reconciler
        .audit(CaptureAuditReason::Restart, false)
        .await
        .unwrap();

    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Off);
    assert_eq!(
        status.system_proxy.observed,
        SystemProxyObservedState::Disabled
    );
    assert!(!status.capture_selection.system_proxy);
    assert!(!status.system_proxy.desired);
}

#[tokio::test]
async fn startup_journal_failure_is_explicit_recovery_without_platform_mutation() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        Arc::new(UnreadableJournalStore),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .audit(CaptureAuditReason::Restart, false)
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::PersistenceFailed
    );
    let status = reconciler.status();
    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Drift);
    assert_eq!(
        status.system_proxy.observed,
        SystemProxyObservedState::Unknown
    );
    assert_eq!(
        status.system_proxy.recovery_actions,
        [
            CaptureRecoveryAction::Repair,
            CaptureRecoveryAction::LeaveAsIs
        ]
    );
    assert!(!status.system_proxy_enabled);
    assert_eq!(platform.apply_count(), 0);
}

#[tokio::test]
async fn journal_failure_replaces_applied_with_unknown_drift_without_mutation() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap();
    let reconciler = CaptureReconciler::new(platform.clone(), journal.clone(), endpoint.clone());
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();
    let applied_count = platform.apply_count();
    journal.fail_reads();

    let error = reconciler
        .audit(CaptureAuditReason::NetworkChanged, true)
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::PersistenceFailed
    );
    let status = reconciler.status();
    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Drift);
    assert_eq!(
        status.system_proxy.observed,
        SystemProxyObservedState::Unknown
    );
    assert!(status.system_proxy.desired);
    assert!(status.capture_selection.system_proxy);
    assert!(!status.system_proxy_enabled);
    assert_eq!(platform.apply_count(), applied_count);
    assert!(platform.service("service-a").is_mish_endpoint(&endpoint));
}

#[tokio::test]
async fn invalid_restart_journal_is_visible_and_can_be_relinquished_without_proxy_mutation() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(InvalidJournalStore::new());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .audit(CaptureAuditReason::Restart, false)
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::InvalidRecovery
    );
    let drift = reconciler.status();
    assert_eq!(drift.system_proxy.phase, SystemProxyPhase::Drift);
    assert_eq!(
        drift.system_proxy.recovery_actions,
        [CaptureRecoveryAction::LeaveAsIs]
    );
    assert_eq!(platform.apply_count(), 0);

    platform.fail_next_observations(1);
    let observation_error = reconciler
        .recover(CaptureRecoveryAction::LeaveAsIs, false)
        .await
        .unwrap_err();
    assert_eq!(
        observation_error.kind,
        mish_runtime::CaptureFailureKind::ObservationFailed
    );
    let after_observation_failure = reconciler.status();
    assert_eq!(
        after_observation_failure.system_proxy.failure,
        Some(mish_runtime::CaptureFailureKind::InvalidRecovery)
    );
    assert_eq!(
        after_observation_failure.system_proxy.recovery_actions,
        [CaptureRecoveryAction::LeaveAsIs]
    );
    let repair_error = reconciler
        .recover(CaptureRecoveryAction::Repair, true)
        .await
        .unwrap_err();
    assert_eq!(
        repair_error.kind,
        mish_runtime::CaptureFailureKind::InvalidRecovery
    );
    assert_eq!(platform.apply_count(), 0);

    journal.fail_next_clear();
    let persistence_error = reconciler
        .recover(CaptureRecoveryAction::LeaveAsIs, false)
        .await
        .unwrap_err();
    assert_eq!(
        persistence_error.kind,
        mish_runtime::CaptureFailureKind::PersistenceFailed
    );
    let after_persistence_failure = reconciler.status();
    assert_eq!(
        after_persistence_failure.system_proxy.failure,
        Some(mish_runtime::CaptureFailureKind::InvalidRecovery)
    );
    assert_eq!(
        after_persistence_failure.system_proxy.recovery_actions,
        [CaptureRecoveryAction::LeaveAsIs]
    );
    assert_eq!(platform.apply_count(), 0);

    let recovered = reconciler
        .recover(CaptureRecoveryAction::LeaveAsIs, false)
        .await
        .unwrap();

    assert_eq!(recovered.system_proxy.phase, SystemProxyPhase::Off);
    assert_eq!(
        recovered.system_proxy.observed,
        SystemProxyObservedState::Disabled
    );
    assert_eq!(platform.apply_count(), 0);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn audit_does_not_adopt_a_matching_loopback_endpoint_without_a_prior_journal() {
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap();
    let proxy = ManualProxyState {
        authenticated: false,
        enabled: true,
        host: Some("127.0.0.1".into()),
        port: Some(7890),
    };
    let platform = Arc::new(FakePlatform::new(NetworkServiceProxyState {
        http: proxy.clone(),
        https: proxy.clone(),
        socks: proxy,
        ..disabled_service()
    }));
    let reconciler =
        CaptureReconciler::new(platform, Arc::new(MemoryJournalStore::default()), endpoint);
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            false,
        )
        .await
        .unwrap_err();

    let status = reconciler
        .audit(CaptureAuditReason::Periodic, true)
        .await
        .unwrap();

    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Drift);
    assert!(!status.system_proxy_enabled);
    assert_eq!(
        status.system_proxy.recovery_actions,
        [
            CaptureRecoveryAction::Repair,
            CaptureRecoveryAction::LeaveAsIs
        ]
    );
}

#[tokio::test]
async fn rollback_failure_is_persisted_as_explicit_recoverable_drift() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    platform.fail_next_applies_partially(2);
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform,
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(error.kind, mish_runtime::CaptureFailureKind::RollbackFailed);
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Drift
    );
    assert_eq!(
        reconciler.status().system_proxy.recovery_actions,
        [
            CaptureRecoveryAction::Repair,
            CaptureRecoveryAction::LeaveAsIs
        ]
    );
    assert!(journal.load().unwrap().is_some());
}

#[tokio::test]
async fn automatic_proxy_configuration_is_left_unchanged_and_reported_as_failed() {
    let prior = NetworkServiceProxyState {
        pac_enabled: true,
        ..disabled_service()
    };
    let platform = Arc::new(FakePlatform::new(prior.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::UnsafeExistingConfiguration
    );
    assert_eq!(platform.service("service-a"), prior);
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Failed
    );
    assert_eq!(
        reconciler.status().system_proxy.failure,
        Some(mish_runtime::CaptureFailureKind::UnsafeExistingConfiguration)
    );
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn audit_reports_external_modification_as_observed_drift() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();
    platform.replace_service(NetworkServiceProxyState {
        auto_discovery_enabled: false,
        http: ManualProxyState {
            authenticated: false,
            enabled: true,
            host: Some("private.proxy.example".into()),
            port: Some(8443),
        },
        https: ManualProxyState::disabled(),
        pac_enabled: false,
        service_id: "service-a".into(),
        socks: ManualProxyState::disabled(),
    });

    let status = reconciler
        .audit(CaptureAuditReason::NetworkChanged, true)
        .await
        .unwrap();

    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Drift);
    assert_eq!(
        status.system_proxy.observed,
        SystemProxyObservedState::Other
    );
    assert_eq!(
        status.system_proxy.recovery_actions,
        [
            CaptureRecoveryAction::Repair,
            CaptureRecoveryAction::LeaveAsIs
        ]
    );
    assert!(!status.system_proxy_enabled);
    assert!(journal.load().unwrap().is_some());
    assert!(
        !serde_json::to_string(&status)
            .unwrap()
            .contains("private.proxy.example")
    );
}

#[tokio::test]
async fn network_service_change_restores_the_old_service_before_applying_the_new_one() {
    let original = disabled_service();
    let platform = Arc::new(FakePlatform::new(original.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap();
    let reconciler = CaptureReconciler::new(platform.clone(), journal.clone(), endpoint.clone());
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();
    let new_prior = NetworkServiceProxyState {
        service_id: "service-b".into(),
        ..disabled_service()
    };
    platform.switch_active_service(new_prior.clone());

    let status = reconciler
        .audit(CaptureAuditReason::NetworkChanged, true)
        .await
        .unwrap();

    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Applied);
    assert_eq!(platform.service("service-a"), original);
    assert!(platform.service("service-b").is_mish_endpoint(&endpoint));
    assert_eq!(journal.load().unwrap().unwrap().prior, new_prior);
}

#[tokio::test]
async fn stopping_restores_prior_state_without_clearing_selection_intent() {
    let prior = disabled_service();
    let platform = Arc::new(FakePlatform::new(prior.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );
    let selection = CaptureSelection {
        system_proxy: true,
        tun: false,
    };
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: selection.clone(),
            },
            true,
        )
        .await
        .unwrap();

    let stopped = reconciler
        .reconcile(
            CaptureRequest {
                active: false,
                selection: selection.clone(),
            },
            true,
        )
        .await
        .unwrap();

    assert_eq!(platform.service("service-a"), prior);
    assert_eq!(stopped.capture_selection, selection);
    assert!(!stopped.system_proxy.desired);
    assert_eq!(stopped.system_proxy.phase, SystemProxyPhase::Off);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn core_crash_conservatively_restores_mish_owned_proxy() {
    let prior = disabled_service();
    let platform = Arc::new(FakePlatform::new(prior.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();

    let audited = reconciler
        .audit(CaptureAuditReason::CoreHealthChanged, false)
        .await
        .unwrap();

    assert_eq!(platform.service("service-a"), prior);
    assert!(audited.capture_selection.system_proxy);
    assert!(!audited.system_proxy.desired);
    assert_eq!(audited.system_proxy.phase, SystemProxyPhase::Off);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn restart_audit_restores_a_confirmed_orphaned_mish_proxy() {
    let prior = disabled_service();
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap();
    let mut owned = prior.clone();
    let proxy = ManualProxyState {
        authenticated: false,
        enabled: true,
        host: Some("127.0.0.1".into()),
        port: Some(7890),
    };
    owned.http = proxy.clone();
    owned.https = proxy.clone();
    owned.socks = proxy;
    let platform = Arc::new(FakePlatform::new(owned));
    let journal = Arc::new(MemoryJournalStore::default());
    journal
        .save(&CaptureJournal {
            prior: prior.clone(),
        })
        .unwrap();
    let reconciler = CaptureReconciler::new(platform.clone(), journal.clone(), endpoint);

    let audited = reconciler
        .audit(CaptureAuditReason::Restart, true)
        .await
        .unwrap();

    assert_eq!(platform.service("service-a"), prior);
    assert_eq!(audited.system_proxy.phase, SystemProxyPhase::Off);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn disabling_without_a_journal_does_not_publish_off_when_observation_fails() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    platform.fail_next_observations(1);
    let reconciler = CaptureReconciler::new(
        platform,
        Arc::new(MemoryJournalStore::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: false,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::ObservationFailed
    );
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Failed
    );
    assert!(!reconciler.status().system_proxy.desired);
}

#[tokio::test]
async fn leave_as_is_clears_ownership_without_overwriting_external_proxy_state() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();
    let external = NetworkServiceProxyState {
        http: ManualProxyState {
            authenticated: false,
            enabled: true,
            host: Some("external.proxy.example".into()),
            port: Some(3128),
        },
        ..disabled_service()
    };
    platform.replace_service(external.clone());
    reconciler
        .audit(CaptureAuditReason::NetworkChanged, true)
        .await
        .unwrap();

    let recovered = reconciler
        .recover(CaptureRecoveryAction::LeaveAsIs, true)
        .await
        .unwrap();

    assert_eq!(platform.service("service-a"), external);
    assert!(recovered.capture_selection.system_proxy);
    assert!(!recovered.system_proxy.desired);
    assert_eq!(recovered.system_proxy.phase, SystemProxyPhase::Off);
    assert_eq!(
        recovered.system_proxy.observed,
        SystemProxyObservedState::Other
    );
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn repair_adopts_the_observed_external_state_as_the_new_reversible_prior() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap();
    let reconciler = CaptureReconciler::new(platform.clone(), journal.clone(), endpoint.clone());
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();
    let external = NetworkServiceProxyState {
        socks: ManualProxyState {
            authenticated: false,
            enabled: true,
            host: Some("external.proxy.example".into()),
            port: Some(1080),
        },
        ..disabled_service()
    };
    platform.replace_service(external.clone());
    reconciler
        .audit(CaptureAuditReason::NetworkChanged, true)
        .await
        .unwrap();

    let repaired = reconciler
        .recover(CaptureRecoveryAction::Repair, true)
        .await
        .unwrap();

    assert_eq!(repaired.system_proxy.phase, SystemProxyPhase::Applied);
    assert!(platform.service("service-a").is_mish_endpoint(&endpoint));
    assert_eq!(journal.load().unwrap().unwrap().prior, external);
}

#[tokio::test]
async fn initial_observation_failure_is_published_as_failed_instead_of_pending() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    platform.fail_next_observations(1);
    let reconciler = CaptureReconciler::new(
        platform,
        Arc::new(MemoryJournalStore::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::ObservationFailed
    );
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Failed
    );
    assert_eq!(
        reconciler.status().system_proxy.failure,
        Some(mish_runtime::CaptureFailureKind::ObservationFailed)
    );
}

#[tokio::test]
async fn audit_observation_failure_replaces_applied_with_explicit_unknown_drift() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        Arc::new(MemoryJournalStore::default()),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );
    reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();
    platform.fail_next_observations(1);

    let error = reconciler
        .audit(CaptureAuditReason::Periodic, true)
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::ObservationFailed
    );
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Drift
    );
    assert_eq!(
        reconciler.status().system_proxy.observed,
        SystemProxyObservedState::Unknown
    );
    assert!(!reconciler.status().system_proxy_enabled);
}

fn disabled_service() -> NetworkServiceProxyState {
    NetworkServiceProxyState {
        auto_discovery_enabled: false,
        http: ManualProxyState::disabled(),
        https: ManualProxyState::disabled(),
        pac_enabled: false,
        service_id: "service-a".into(),
        socks: ManualProxyState::disabled(),
    }
}

#[tokio::test]
async fn enabling_system_proxy_publishes_success_only_after_observation_confirms_it() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let status = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap();

    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Applied);
    assert!(status.system_proxy.desired);
    assert!(status.system_proxy_enabled);
    assert!(
        platform
            .service("service-a")
            .is_mish_endpoint(&LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap())
    );
    assert_eq!(journal.load().unwrap().unwrap().prior, disabled_service());
}

#[tokio::test]
async fn listener_readiness_failure_never_modifies_system_proxy_or_reports_success() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    platform.set_listener_ready(false);
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::ListenerUnavailable
    );
    assert_eq!(platform.apply_count(), 0);
    assert_eq!(platform.service("service-a"), disabled_service());
    assert!(journal.load().unwrap().is_none());
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Failed
    );
    assert!(!reconciler.status().system_proxy_enabled);
}

#[tokio::test]
async fn pre_apply_core_failure_does_not_become_drift_during_audit() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            false,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, mish_runtime::CaptureFailureKind::CoreUnhealthy);

    let audited = reconciler
        .audit(CaptureAuditReason::Periodic, false)
        .await
        .unwrap();

    assert_eq!(audited.system_proxy.phase, SystemProxyPhase::Failed);
    assert_eq!(
        audited.system_proxy.failure,
        Some(mish_runtime::CaptureFailureKind::CoreUnhealthy)
    );
    assert!(audited.system_proxy.recovery_actions.is_empty());
    assert!(!audited.system_proxy_enabled);
    assert_eq!(platform.apply_count(), 0);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn local_proxy_test_confirms_only_the_listener_and_leaves_system_proxy_untouched() {
    let prior = disabled_service();
    let platform = Arc::new(FakePlatform::new(prior.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    );

    let result = reconciler.test_local_proxy(true, true).await;

    assert_eq!(result.phase, LocalProxyTestPhase::Ready);
    assert_eq!(result.host, "127.0.0.1");
    assert_eq!(result.port, 7890);
    assert_eq!(platform.listener_test_count(), 1);
    assert_eq!(platform.observe_count(), 0);
    assert_eq!(platform.apply_count(), 0);
    assert_eq!(platform.service("service-a"), prior);
    assert!(journal.load().unwrap().is_none());
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Off
    );
}

#[tokio::test]
async fn local_proxy_test_skips_all_platform_access_while_core_is_unhealthy() {
    let prior = disabled_service();
    let platform = Arc::new(FakePlatform::new(prior.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::managed(),
    );

    let result = reconciler.test_local_proxy(false, false).await;

    assert_eq!(result.phase, LocalProxyTestPhase::CoreUnhealthy);
    assert_eq!(platform.listener_test_count(), 0);
    assert_eq!(platform.observe_count(), 0);
    assert_eq!(platform.apply_count(), 0);
    assert_eq!(platform.service("service-a"), prior);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn runtime_transition_ownership_blocks_commands_and_stale_health_audits() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = Arc::new(CaptureReconciler::new(
        platform,
        journal,
        LoopbackProxyEndpoint::managed(),
    ));
    let request = CaptureRequest {
        active: true,
        selection: CaptureSelection {
            system_proxy: true,
            tun: false,
        },
    };
    reconciler.reconcile(request.clone(), true).await.unwrap();
    let transition = reconciler.clone().begin_runtime_transition().unwrap();

    let command_error = reconciler
        .reconcile(
            CaptureRequest {
                active: false,
                selection: request.selection.clone(),
            },
            false,
        )
        .await
        .unwrap_err();
    assert_eq!(
        command_error.kind,
        mish_runtime::CaptureFailureKind::RuntimeTransition
    );
    let audited = reconciler
        .audit(CaptureAuditReason::CoreHealthChanged, false)
        .await
        .unwrap();
    assert_eq!(audited.system_proxy.phase, SystemProxyPhase::Applied);

    reconciler
        .reconcile_runtime_transition(
            &transition,
            CaptureRequest {
                active: false,
                selection: request.selection,
            },
            false,
        )
        .await
        .unwrap();
    drop(transition);
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Off
    );
}

#[tokio::test]
async fn repeated_enable_keeps_the_original_reversible_prior_state() {
    let original = disabled_service();
    let platform = Arc::new(FakePlatform::new(original.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform.clone(),
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );
    let request = CaptureRequest {
        active: true,
        selection: CaptureSelection {
            system_proxy: true,
            tun: false,
        },
    };

    reconciler.reconcile(request.clone(), true).await.unwrap();
    reconciler.reconcile(request.clone(), true).await.unwrap();
    assert_eq!(journal.load().unwrap().unwrap().prior, original);

    reconciler
        .reconcile(
            CaptureRequest {
                active: false,
                selection: request.selection,
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(platform.service("service-a"), disabled_service());
}

#[tokio::test]
async fn explicit_enable_after_a_service_switch_restores_the_old_service_first() {
    let original = disabled_service();
    let platform = Arc::new(FakePlatform::new(original.clone()));
    let journal = Arc::new(MemoryJournalStore::default());
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap();
    let reconciler = CaptureReconciler::new(platform.clone(), journal.clone(), endpoint.clone());
    let request = CaptureRequest {
        active: true,
        selection: CaptureSelection {
            system_proxy: true,
            tun: false,
        },
    };
    reconciler.reconcile(request.clone(), true).await.unwrap();
    let new_prior = NetworkServiceProxyState {
        service_id: "service-b".into(),
        ..disabled_service()
    };
    platform.switch_active_service(new_prior.clone());

    reconciler.reconcile(request, true).await.unwrap();

    assert_eq!(platform.service("service-a"), original);
    assert!(platform.service("service-b").is_mish_endpoint(&endpoint));
    assert_eq!(journal.load().unwrap().unwrap().prior, new_prior);
}

#[tokio::test]
async fn explicit_enable_does_not_claim_a_matching_endpoint_without_a_prior_journal() {
    let proxy = ManualProxyState {
        authenticated: false,
        enabled: true,
        host: Some("127.0.0.1".into()),
        port: Some(7890),
    };
    let platform = Arc::new(FakePlatform::new(NetworkServiceProxyState {
        http: proxy.clone(),
        https: proxy.clone(),
        socks: proxy,
        ..disabled_service()
    }));
    let journal = Arc::new(MemoryJournalStore::default());
    let reconciler = CaptureReconciler::new(
        platform,
        journal.clone(),
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
    );

    let error = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            },
            true,
        )
        .await
        .unwrap_err();

    assert_eq!(error.kind, mish_runtime::CaptureFailureKind::ExternalDrift);
    assert_eq!(
        reconciler.status().system_proxy.phase,
        SystemProxyPhase::Drift
    );
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn system_proxy_and_tun_conversion_rolls_back_then_confirms_each_observed_state() {
    let platform = Arc::new(FakePlatform::new(disabled_service()));
    let journal = Arc::new(MemoryJournalStore::default());
    let helper_platform = Arc::new(FakeTunHelper::new());
    let helper = Arc::new(TunHelperController::new(helper_platform.clone()));
    let reconciler = CaptureReconciler::new_with_tun(
        platform,
        journal,
        LoopbackProxyEndpoint::new("127.0.0.1", 7890).unwrap(),
        Some(helper),
    );
    let system_proxy = CaptureRequest {
        active: true,
        selection: CaptureSelection {
            system_proxy: true,
            tun: false,
        },
    };
    reconciler
        .reconcile(system_proxy.clone(), true)
        .await
        .unwrap();

    helper_platform.fail_next_enable();
    let failed = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: false,
                    tun: true,
                },
            },
            true,
        )
        .await
        .unwrap_err();
    assert_eq!(failed.kind, mish_runtime::CaptureFailureKind::ApplyFailed);
    assert!(reconciler.status().system_proxy_enabled);
    assert!(!reconciler.status().tun_enabled);

    let tun = reconciler
        .reconcile(
            CaptureRequest {
                active: true,
                selection: CaptureSelection {
                    system_proxy: false,
                    tun: true,
                },
            },
            true,
        )
        .await
        .unwrap();
    assert!(!tun.system_proxy_enabled);
    assert!(tun.tun_enabled);
    assert_eq!(tun.tun.phase, TunPhase::Applied);

    let restored = reconciler.reconcile(system_proxy, true).await.unwrap();
    assert!(restored.system_proxy_enabled);
    assert!(!restored.tun_enabled);
    assert_eq!(restored.tun.phase, TunPhase::Off);
}
