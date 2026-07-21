use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use mish_runtime::{
    TUN_APP_SIGNING_IDENTIFIER, TUN_HELPER_EXPECTED_VERSION, TUN_HELPER_MAX_MESSAGE_BYTES,
    TUN_HELPER_PROTOCOL_VERSION, TUN_HELPER_SIGNING_IDENTIFIER, TunHelperAvailability,
    TunHelperController, TunHelperError, TunHelperFailureKind, TunHelperHealth,
    TunHelperLifecycleOperation, TunHelperLifecyclePhase, TunHelperObservation,
    TunHelperPeerIdentity, TunHelperPlatform, TunHelperSnapshot, TunHelperWireCommand,
    TunNetworkObservation, decode_tun_helper_request, tun_observation_now,
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
    lifecycle_failure: Mutex<Option<TunHelperFailureKind>>,
    observation: Mutex<TunHelperObservation>,
    tun_enabled: Mutex<bool>,
}

impl FakeHelperPlatform {
    fn not_installed() -> Self {
        Self {
            lifecycle_failure: Mutex::new(None),
            observation: Mutex::new(TunHelperObservation::not_installed()),
            tun_enabled: Mutex::new(false),
        }
    }

    fn version_mismatch() -> Self {
        Self {
            lifecycle_failure: Mutex::new(None),
            observation: Mutex::new(TunHelperObservation::healthy("0")),
            tun_enabled: Mutex::new(false),
        }
    }

    fn fail_next_lifecycle(&self, failure: TunHelperFailureKind) {
        *self.lifecycle_failure.lock().unwrap() = Some(failure);
    }
}

impl TunHelperPlatform for FakeHelperPlatform {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
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
}

#[tokio::test]
async fn version_drift_requires_repair_and_repair_reobserves_health() {
    let helper = TunHelperController::new(Arc::new(FakeHelperPlatform::version_mismatch()));

    let drifted = helper.refresh().await;
    assert_eq!(drifted.availability, TunHelperAvailability::RepairRequired);
    assert_eq!(drifted.health, TunHelperHealth::VersionMismatch);

    let repaired = helper.repair().await.unwrap();
    assert!(repaired.is_healthy());
}

#[tokio::test]
async fn remove_disables_tun_before_confirming_absence() {
    let platform = Arc::new(FakeHelperPlatform::not_installed());
    let helper = TunHelperController::new(platform.clone());
    helper.install().await.unwrap();
    helper.set_tun_enabled(true).await.unwrap();

    let removed = helper.remove().await.unwrap();

    assert_eq!(removed.health, TunHelperHealth::NotInstalled);
    assert_eq!(removed.installed_version, None);
    assert!(!*platform.tun_enabled.lock().unwrap());
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
