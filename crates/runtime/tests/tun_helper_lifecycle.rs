use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use mish_runtime::{
    TUN_APP_SIGNING_IDENTIFIER, TUN_HELPER_EXPECTED_VERSION, TUN_HELPER_MAX_MESSAGE_BYTES,
    TUN_HELPER_PROTOCOL_VERSION, TUN_HELPER_SIGNING_IDENTIFIER, TunHelperAvailability,
    TunHelperController, TunHelperError, TunHelperFailureKind, TunHelperHealth,
    TunHelperLifecycleOperation, TunHelperLifecyclePhase, TunHelperObservation,
    TunHelperPeerIdentity, TunHelperPlatform, TunHelperRemovalCapability, TunHelperSnapshot,
    TunHelperWireCommand, TunNetworkObservation, decode_tun_helper_request, tun_observation_now,
    validate_tun_helper_peer,
};

#[test]
fn unsupported_and_unsigned_builds_never_report_helper_availability() {
    for (availability, health, failure) in [
        (
            TunHelperAvailability::UnsupportedSystem,
            TunHelperHealth::NotInstalled,
            TunHelperFailureKind::UnsupportedSystem,
        ),
        (
            TunHelperAvailability::UnsignedApp,
            TunHelperHealth::InvalidSignature,
            TunHelperFailureKind::UnsignedApp,
        ),
    ] {
        let snapshot = TunHelperSnapshot::unavailable(availability, health, failure);
        assert!(!snapshot.is_healthy());
        assert_eq!(snapshot.last_failure, Some(failure));
    }
}

struct FakeHelperPlatform {
    initially_healthy: bool,
    lifecycle_calls: Mutex<Vec<TunHelperLifecycleOperation>>,
    lifecycle_failure: Mutex<Option<TunHelperFailureKind>>,
    observation: Mutex<TunHelperObservation>,
    tun_enabled: Mutex<bool>,
    tun_failure: Mutex<Option<TunHelperFailureKind>>,
    tun_observation_failure: Mutex<Option<TunHelperFailureKind>>,
}

impl FakeHelperPlatform {
    fn not_installed() -> Self {
        Self {
            initially_healthy: false,
            lifecycle_calls: Mutex::new(Vec::new()),
            lifecycle_failure: Mutex::new(None),
            observation: Mutex::new(TunHelperObservation::not_installed()),
            tun_enabled: Mutex::new(false),
            tun_failure: Mutex::new(None),
            tun_observation_failure: Mutex::new(None),
        }
    }

    fn version_mismatch() -> Self {
        Self {
            initially_healthy: false,
            lifecycle_calls: Mutex::new(Vec::new()),
            lifecycle_failure: Mutex::new(None),
            observation: Mutex::new(TunHelperObservation::healthy("0")),
            tun_enabled: Mutex::new(false),
            tun_failure: Mutex::new(None),
            tun_observation_failure: Mutex::new(None),
        }
    }

    fn recovery_required() -> Self {
        Self {
            initially_healthy: false,
            lifecycle_calls: Mutex::new(Vec::new()),
            lifecycle_failure: Mutex::new(None),
            observation: Mutex::new(TunHelperObservation {
                availability: TunHelperAvailability::RecoveryRequired,
                health: TunHelperHealth::Unknown,
                installation_id: None,
                installed_version: None,
                last_failure: Some(TunHelperFailureKind::IdentityRejected),
            }),
            tun_enabled: Mutex::new(false),
            tun_failure: Mutex::new(None),
            tun_observation_failure: Mutex::new(None),
        }
    }

    fn legacy_tun_policy_generation() -> Self {
        Self {
            initially_healthy: false,
            lifecycle_calls: Mutex::new(Vec::new()),
            lifecycle_failure: Mutex::new(None),
            // Helper v3 was the generation that could persist a fail-closed
            // MISH_TUN_SERVICE_ALLOW_TUN=0 policy. A policy-semantic migration must
            // force repair before Capture can try to start a TUN Core.
            observation: Mutex::new(TunHelperObservation::healthy("3")),
            tun_enabled: Mutex::new(false),
            tun_failure: Mutex::new(None),
            tun_observation_failure: Mutex::new(None),
        }
    }

    fn immediate_tun_observation_generation() -> Self {
        Self {
            initially_healthy: false,
            lifecycle_calls: Mutex::new(Vec::new()),
            lifecycle_failure: Mutex::new(None),
            // Helper v4 rejected Enable before a newly started Core had a bounded
            // opportunity to publish its owned utun and route observations.
            observation: Mutex::new(TunHelperObservation::healthy("4")),
            tun_enabled: Mutex::new(false),
            tun_failure: Mutex::new(None),
            tun_observation_failure: Mutex::new(None),
        }
    }

    fn healthy() -> Self {
        Self {
            initially_healthy: true,
            lifecycle_calls: Mutex::new(Vec::new()),
            lifecycle_failure: Mutex::new(None),
            observation: Mutex::new(TunHelperObservation::healthy(TUN_HELPER_EXPECTED_VERSION)),
            tun_enabled: Mutex::new(false),
            tun_failure: Mutex::new(None),
            tun_observation_failure: Mutex::new(None),
        }
    }

    fn fail_next_lifecycle(&self, failure: TunHelperFailureKind) {
        *self.lifecycle_failure.lock().unwrap() = Some(failure);
    }

    fn fail_next_tun_mutation(&self, failure: TunHelperFailureKind) {
        *self.tun_failure.lock().unwrap() = Some(failure);
    }

    fn fail_next_tun_observation(&self, failure: TunHelperFailureKind) {
        *self.tun_observation_failure.lock().unwrap() = Some(failure);
    }

    fn lifecycle_calls(&self) -> Vec<TunHelperLifecycleOperation> {
        self.lifecycle_calls.lock().unwrap().clone()
    }
}

impl TunHelperPlatform for FakeHelperPlatform {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
        if self.initially_healthy {
            return TunHelperSnapshot {
                availability: TunHelperAvailability::Available,
                expected_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                health: TunHelperHealth::Healthy,
                installation_id: None,
                installed_version: Some(TUN_HELPER_EXPECTED_VERSION.to_owned()),
                last_failure: None,
                phase: TunHelperLifecyclePhase::Idle,
                removal: TunHelperRemovalCapability::Available,
            };
        }
        TunHelperSnapshot::unavailable(
            TunHelperAvailability::PermissionRequired,
            TunHelperHealth::NotInstalled,
            TunHelperFailureKind::PermissionDenied,
        )
    }

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>> {
        let observation = self.observation.lock().unwrap().clone();
        Box::pin(async move { Ok(observation) })
    }

    fn run_lifecycle(
        &self,
        operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>> {
        self.lifecycle_calls.lock().unwrap().push(operation);
        let failure = self.lifecycle_failure.lock().unwrap().take();
        if let Some(failure) = failure {
            return Box::pin(async move {
                Err(TunHelperError::new(failure, "Synthetic lifecycle failure"))
            });
        }
        *self.observation.lock().unwrap() = match operation {
            TunHelperLifecycleOperation::Install | TunHelperLifecycleOperation::Repair => {
                TunHelperObservation::healthy(TUN_HELPER_EXPECTED_VERSION)
            }
            TunHelperLifecycleOperation::Remove => TunHelperObservation::not_installed(),
        };
        Box::pin(async { Ok(()) })
    }

    fn observe_tun(&self) -> BoxFuture<'_, Result<TunNetworkObservation, TunHelperError>> {
        if let Some(failure) = self.tun_observation_failure.lock().unwrap().take() {
            return Box::pin(async move {
                Err(TunHelperError::new(
                    failure,
                    "Synthetic TUN observation failure",
                ))
            });
        }
        let enabled = *self.tun_enabled.lock().unwrap();
        Box::pin(async move {
            Ok(if enabled {
                TunNetworkObservation::enabled(tun_observation_now())
            } else {
                TunNetworkObservation::disabled(tun_observation_now())
            })
        })
    }

    fn set_tun_enabled(&self, enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>> {
        if let Some(failure) = self.tun_failure.lock().unwrap().take() {
            return Box::pin(async move {
                Err(TunHelperError::new(
                    failure,
                    "Synthetic TUN mutation failure",
                ))
            });
        }
        *self.tun_enabled.lock().unwrap() = enabled;
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn install_requires_confirmation_and_reports_a_healthy_exact_version() {
    let helper = TunHelperController::new(Arc::new(FakeHelperPlatform::not_installed()));

    let snapshot = helper.install().await.unwrap();

    assert!(snapshot.is_healthy());
    assert_eq!(
        snapshot.installed_version.as_deref(),
        Some(TUN_HELPER_EXPECTED_VERSION)
    );
    assert_eq!(snapshot.phase, TunHelperLifecyclePhase::Idle);
    assert_eq!(snapshot.removal, TunHelperRemovalCapability::Available);
}

#[tokio::test]
async fn install_requires_a_fresh_disabled_network_observation_before_succeeding() {
    let platform = Arc::new(FakeHelperPlatform::not_installed());
    *platform.tun_enabled.lock().unwrap() = true;
    let helper = TunHelperController::new(platform);

    let error = helper.install().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::ObservationPartial);
    assert_eq!(helper.snapshot().phase, TunHelperLifecyclePhase::Failed);
    assert_eq!(
        helper.snapshot().last_failure,
        Some(TunHelperFailureKind::ObservationPartial)
    );
}

#[tokio::test]
async fn healthy_reinstall_hands_off_active_tun_before_confirming_completion() {
    let platform = Arc::new(FakeHelperPlatform::healthy());
    *platform.tun_enabled.lock().unwrap() = true;
    let helper = TunHelperController::new(platform.clone());

    let snapshot = helper.install().await.unwrap();

    assert!(snapshot.is_healthy());
    assert!(!*platform.tun_enabled.lock().unwrap());
}

#[tokio::test]
async fn failed_tun_mutation_does_not_invalidate_confirmed_helper_identity() {
    let platform = Arc::new(FakeHelperPlatform::healthy());
    platform.fail_next_tun_mutation(TunHelperFailureKind::ObservationPartial);
    let helper = TunHelperController::new(platform);

    let error = helper.set_tun_enabled(true).await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::ObservationPartial);
    let snapshot = helper.snapshot();
    assert!(snapshot.is_healthy());
    assert_eq!(snapshot.phase, TunHelperLifecyclePhase::Idle);
    assert_eq!(snapshot.last_failure, None);
}

#[tokio::test]
async fn failed_tun_observation_does_not_invalidate_confirmed_helper_identity() {
    let platform = Arc::new(FakeHelperPlatform::healthy());
    platform.fail_next_tun_observation(TunHelperFailureKind::ConnectionFailed);
    let helper = TunHelperController::new(platform);

    let error = helper.observe_tun().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::ConnectionFailed);
    let snapshot = helper.snapshot();
    assert!(snapshot.is_healthy());
    assert_eq!(snapshot.phase, TunHelperLifecyclePhase::Idle);
    assert_eq!(snapshot.last_failure, None);
}

#[tokio::test]
async fn repair_requires_a_fresh_disabled_network_observation_before_succeeding() {
    let platform = Arc::new(FakeHelperPlatform::version_mismatch());
    *platform.tun_enabled.lock().unwrap() = true;
    let helper = TunHelperController::new(platform);
    helper.refresh().await;

    let error = helper.repair().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::ObservationPartial);
    assert_eq!(helper.snapshot().phase, TunHelperLifecyclePhase::Failed);
    assert_eq!(
        helper.snapshot().last_failure,
        Some(TunHelperFailureKind::ObservationPartial)
    );
}

#[tokio::test]
async fn permission_refusal_remains_a_typed_failed_state() {
    let platform = Arc::new(FakeHelperPlatform::not_installed());
    platform.fail_next_lifecycle(TunHelperFailureKind::PermissionDenied);
    let helper = TunHelperController::new(platform);

    let error = helper.install().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::PermissionDenied);
    assert_eq!(helper.snapshot().phase, TunHelperLifecyclePhase::Failed);
    assert_eq!(
        helper.snapshot().last_failure,
        Some(TunHelperFailureKind::PermissionDenied)
    );
    assert_eq!(
        helper.snapshot().availability,
        TunHelperAvailability::PermissionRequired
    );
}

#[tokio::test]
async fn failed_repair_preserves_authoritative_repair_required_for_retry() {
    let platform = Arc::new(FakeHelperPlatform::version_mismatch());
    let helper = TunHelperController::new(platform.clone());
    helper.refresh().await;
    platform.fail_next_lifecycle(TunHelperFailureKind::PreparationFailed);

    let error = helper.repair().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::PreparationFailed);
    let failed = helper.snapshot();
    assert_eq!(failed.availability, TunHelperAvailability::RepairRequired);
    assert_eq!(failed.phase, TunHelperLifecyclePhase::Failed);
    assert_eq!(
        failed.last_failure,
        Some(TunHelperFailureKind::PreparationFailed)
    );

    let repaired = helper.repair().await.unwrap();
    assert!(repaired.is_healthy());
}

#[tokio::test]
async fn recovery_required_identity_refuses_blind_repair() {
    let platform = Arc::new(FakeHelperPlatform::recovery_required());
    let helper = TunHelperController::new(platform.clone());
    let snapshot = helper.refresh().await;

    assert_eq!(
        snapshot.availability,
        TunHelperAvailability::RecoveryRequired
    );
    assert_eq!(
        helper.repair().await.unwrap_err().kind,
        TunHelperFailureKind::IdentityRejected
    );
    assert_eq!(
        helper.snapshot().availability,
        TunHelperAvailability::RecoveryRequired
    );
    assert!(platform.lifecycle_calls().is_empty());
}

#[tokio::test]
async fn version_drift_requires_repair_and_repair_reobserves_health() {
    let helper = TunHelperController::new(Arc::new(FakeHelperPlatform::version_mismatch()));

    let drifted = helper.refresh().await;
    assert_eq!(drifted.availability, TunHelperAvailability::RepairRequired);
    assert_eq!(drifted.health, TunHelperHealth::VersionMismatch);
    assert_eq!(drifted.removal, TunHelperRemovalCapability::Available);

    let repaired = helper.repair().await.unwrap();
    assert!(repaired.is_healthy());
}

#[tokio::test]
async fn legacy_tun_policy_generation_requires_repair_before_tun_is_admitted() {
    let helper =
        TunHelperController::new(Arc::new(FakeHelperPlatform::legacy_tun_policy_generation()));

    let snapshot = helper.refresh().await;

    assert_eq!(snapshot.availability, TunHelperAvailability::RepairRequired);
    assert_eq!(snapshot.health, TunHelperHealth::VersionMismatch);
    assert_eq!(
        snapshot.last_failure,
        Some(TunHelperFailureKind::VersionMismatch)
    );
    assert!(!snapshot.is_healthy());
}

#[tokio::test]
async fn immediate_tun_observation_generation_requires_repair_before_tun_is_admitted() {
    let helper = TunHelperController::new(Arc::new(
        FakeHelperPlatform::immediate_tun_observation_generation(),
    ));

    let snapshot = helper.refresh().await;

    assert_eq!(snapshot.availability, TunHelperAvailability::RepairRequired);
    assert_eq!(snapshot.health, TunHelperHealth::VersionMismatch);
    assert_eq!(
        snapshot.last_failure,
        Some(TunHelperFailureKind::VersionMismatch)
    );
    assert!(!snapshot.is_healthy());
}

#[tokio::test]
async fn development_runtime_restriction_preserves_the_typed_observation_failure() {
    let platform = Arc::new(FakeHelperPlatform::not_installed());
    let helper = TunHelperController::new(platform);
    helper.install().await.unwrap();

    helper.mark_runtime_unavailable(TunHelperFailureKind::ObservationForeign);
    let refreshed = helper.refresh().await;

    assert_eq!(refreshed.availability, TunHelperAvailability::Unavailable);
    assert_eq!(refreshed.phase, TunHelperLifecyclePhase::Failed);
    assert_eq!(
        refreshed.last_failure,
        Some(TunHelperFailureKind::ObservationForeign)
    );
    assert!(!refreshed.is_healthy());
    assert_eq!(
        helper.repair().await.unwrap_err().kind,
        TunHelperFailureKind::ObservationForeign
    );
    assert_eq!(
        helper.snapshot().last_failure,
        Some(TunHelperFailureKind::ObservationForeign)
    );

    let removed = helper.remove().await.unwrap();
    assert_eq!(removed.health, TunHelperHealth::NotInstalled);
    assert_eq!(
        removed.availability,
        TunHelperAvailability::PermissionRequired
    );
}

#[tokio::test]
async fn failed_removal_does_not_clear_the_development_runtime_restriction() {
    let platform = Arc::new(FakeHelperPlatform::not_installed());
    let helper = TunHelperController::new(platform.clone());
    helper.install().await.unwrap();
    helper.mark_runtime_unavailable(TunHelperFailureKind::ObservationForeign);
    platform.fail_next_lifecycle(TunHelperFailureKind::PermissionDenied);

    let error = helper.remove().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::PermissionDenied);
    let refreshed = helper.refresh().await;
    assert_eq!(refreshed.availability, TunHelperAvailability::Unavailable);
    assert_eq!(
        refreshed.last_failure,
        Some(TunHelperFailureKind::ObservationForeign)
    );
}

#[tokio::test]
async fn remove_requires_capture_to_handoff_tun_before_lifecycle() {
    let platform = Arc::new(FakeHelperPlatform::not_installed());
    let helper = TunHelperController::new(platform.clone());
    helper.install().await.unwrap();
    helper.set_tun_enabled(true).await.unwrap();

    let error = helper.remove().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::ObservationPartial);
    assert_eq!(
        platform
            .observation
            .lock()
            .unwrap()
            .installed_version
            .as_deref(),
        Some(TUN_HELPER_EXPECTED_VERSION)
    );
    assert!(*platform.tun_enabled.lock().unwrap());

    helper.set_tun_enabled(false).await.unwrap();
    let removed = helper.remove().await.unwrap();

    assert_eq!(removed.health, TunHelperHealth::NotInstalled);
    assert_eq!(removed.installed_version, None);
    assert_eq!(removed.removal, TunHelperRemovalCapability::NotInstalled);
    assert!(!*platform.tun_enabled.lock().unwrap());
}

#[tokio::test]
async fn remove_rejects_an_unconfirmed_installation_without_starting_lifecycle() {
    let platform = Arc::new(FakeHelperPlatform::not_installed());
    let helper = TunHelperController::new(platform.clone());

    let error = helper.remove().await.unwrap_err();

    assert_eq!(error.kind, TunHelperFailureKind::ConfirmationFailed);
    assert_eq!(
        platform.observation.lock().unwrap().health,
        TunHelperHealth::NotInstalled
    );
    assert_eq!(
        helper.snapshot().removal,
        TunHelperRemovalCapability::NotInstalled
    );
}

#[test]
fn closed_wire_protocol_rejects_identity_size_version_and_unknown_fields() {
    assert_eq!(TUN_APP_SIGNING_IDENTIFIER, "com.asuka109.mish");
    assert_eq!(
        TUN_HELPER_SIGNING_IDENTIFIER,
        "com.asuka109.mish.tun-helper"
    );
    let identity = TunHelperPeerIdentity {
        signed: true,
        signing_identifier: TUN_APP_SIGNING_IDENTIFIER.to_owned(),
        team_identifier: Some("TEAM".to_owned()),
    };
    let request =
        format!(r#"{{"command":"health","protocolVersion":{TUN_HELPER_PROTOCOL_VERSION}}}"#);
    assert_eq!(
        decode_tun_helper_request(request.as_bytes(), &identity, "TEAM")
            .unwrap()
            .command,
        TunHelperWireCommand::Health
    );

    let unsigned = TunHelperPeerIdentity {
        signed: false,
        ..identity.clone()
    };
    assert_eq!(
        decode_tun_helper_request(request.as_bytes(), &unsigned, "TEAM")
            .unwrap_err()
            .kind,
        TunHelperFailureKind::IdentityRejected
    );
    assert_eq!(
        decode_tun_helper_request(
            &vec![b'x'; TUN_HELPER_MAX_MESSAGE_BYTES + 1],
            &identity,
            "TEAM"
        )
        .unwrap_err()
        .kind,
        TunHelperFailureKind::MessageTooLarge
    );
    assert_eq!(
        decode_tun_helper_request(
            br#"{"command":"health","protocolVersion":0}"#,
            &identity,
            "TEAM",
        )
        .unwrap_err()
        .kind,
        TunHelperFailureKind::ProtocolMismatch
    );
    assert_eq!(
        decode_tun_helper_request(
            br#"{"command":"health","protocolVersion":1,"path":"/tmp"}"#,
            &identity,
            "TEAM",
        )
        .unwrap_err()
        .kind,
        TunHelperFailureKind::ProtocolMismatch
    );
    let helper_identity = TunHelperPeerIdentity {
        signed: true,
        signing_identifier: TUN_HELPER_SIGNING_IDENTIFIER.to_owned(),
        team_identifier: Some("TEAM".to_owned()),
    };
    validate_tun_helper_peer(&helper_identity, "TEAM").unwrap();
}

#[test]
fn tun_observation_schema_is_strict_and_versioned() {
    let current = tun_observation_now();
    let stale_schema: TunNetworkObservation = serde_json::from_value(serde_json::json!({
        "core": "confirmed",
        "dns": "confirmed",
        "interface": "confirmed",
        "observedAt": current,
        "routes": "confirmed",
        "schemaVersion": 0
    }))
    .unwrap();
    assert_eq!(
        stale_schema.failure_kind_at(current),
        TunHelperFailureKind::ObservationStale
    );

    assert!(
        serde_json::from_value::<TunNetworkObservation>(serde_json::json!({
            "core": "confirmed",
            "dns": "confirmed",
            "interface": "confirmed",
            "observedAt": current,
            "routes": "confirmed",
            "schemaVersion": 1,
            "tunEnabled": true
        }))
        .is_err()
    );
}
