use mish_platform_macos::{
    PRODUCTION_TUN_SERVICE_LABEL, ProductionTunEvidence, ProductionTunGate,
    ProductionTunRegistration, ProductionTunTransport,
};
use mish_runtime::{
    TUN_APP_SIGNING_IDENTIFIER, TUN_HELPER_EXPECTED_VERSION, TUN_HELPER_PROTOCOL_VERSION,
    TUN_HELPER_SIGNING_IDENTIFIER, TunHelperAvailability, TunHelperFailureKind, TunHelperHealth,
    TunHelperPeerIdentity, TunNetworkObservation,
};

const NOW: u64 = 42_000;
const TEAM: &str = "ABCDE12345";

fn identity(identifier: &str) -> TunHelperPeerIdentity {
    TunHelperPeerIdentity {
        signed: true,
        signing_identifier: identifier.to_owned(),
        team_identifier: Some(TEAM.to_owned()),
    }
}

fn healthy_evidence() -> ProductionTunEvidence {
    ProductionTunEvidence {
        app_identity: identity(TUN_APP_SIGNING_IDENTIFIER),
        helper_identity: identity(TUN_HELPER_SIGNING_IDENTIFIER),
        health: TunHelperHealth::Healthy,
        installed_version: Some(TUN_HELPER_EXPECTED_VERSION.to_owned()),
        observation: Some(TunNetworkObservation::disabled(NOW)),
        protocol_version: Some(TUN_HELPER_PROTOCOL_VERSION),
        registration: ProductionTunRegistration::Enabled,
        transport: ProductionTunTransport::Xpc {
            service_identifier: PRODUCTION_TUN_SERVICE_LABEL.to_owned(),
        },
    }
}

#[test]
fn exact_signed_registered_healthy_disabled_helper_is_available() {
    let observation = ProductionTunGate::new(TEAM).evaluate(healthy_evidence(), NOW);

    assert_eq!(observation.availability, TunHelperAvailability::Available);
    assert_eq!(observation.health, TunHelperHealth::Healthy);
    assert_eq!(observation.last_failure, None);
    assert_eq!(
        observation.installed_version.as_deref(),
        Some(TUN_HELPER_EXPECTED_VERSION)
    );
}

#[test]
fn unsigned_adhoc_and_mismatched_identities_never_pass() {
    let mut cases = Vec::new();

    let mut unsigned_app = healthy_evidence();
    unsigned_app.app_identity.signed = false;
    cases.push(unsigned_app);

    let mut unsigned_helper = healthy_evidence();
    unsigned_helper.helper_identity.signed = false;
    cases.push(unsigned_helper);

    let mut wrong_app = healthy_evidence();
    wrong_app.app_identity.signing_identifier = "com.example.foreign".to_owned();
    cases.push(wrong_app);

    let mut wrong_helper = healthy_evidence();
    wrong_helper.helper_identity.signing_identifier = "com.example.foreign.helper".to_owned();
    cases.push(wrong_helper);

    let mut wrong_team = healthy_evidence();
    wrong_team.helper_identity.team_identifier = Some("OTHER12345".to_owned());
    cases.push(wrong_team);

    for evidence in cases {
        let observation = ProductionTunGate::new(TEAM).evaluate(evidence, NOW);
        assert_ne!(observation.availability, TunHelperAvailability::Available);
        assert_eq!(observation.health, TunHelperHealth::InvalidSignature);
        assert!(matches!(
            observation.last_failure,
            Some(TunHelperFailureKind::UnsignedApp | TunHelperFailureKind::IdentityRejected)
        ));
    }
}

#[test]
fn registration_states_are_permission_or_recovery_required() {
    for (registration, availability, failure) in [
        (
            ProductionTunRegistration::RequiresApproval,
            TunHelperAvailability::PermissionRequired,
            TunHelperFailureKind::RegistrationRequiresApproval,
        ),
        (
            ProductionTunRegistration::NotRegistered,
            TunHelperAvailability::PermissionRequired,
            TunHelperFailureKind::RegistrationFailed,
        ),
        (
            ProductionTunRegistration::NotFound,
            TunHelperAvailability::RepairRequired,
            TunHelperFailureKind::RegistrationFailed,
        ),
    ] {
        let mut evidence = healthy_evidence();
        evidence.registration = registration;
        let observation = ProductionTunGate::new(TEAM).evaluate(evidence, NOW);
        assert_eq!(observation.availability, availability);
        assert_eq!(observation.last_failure, Some(failure));
    }
}

#[test]
fn unhealthy_stale_unconfirmed_and_incompatible_helpers_require_recovery() {
    let mut cases = Vec::new();

    let mut version = healthy_evidence();
    version.installed_version = Some("2".to_owned());
    cases.push((version, TunHelperFailureKind::VersionMismatch));

    let mut missing_version = healthy_evidence();
    missing_version.installed_version = None;
    cases.push((missing_version, TunHelperFailureKind::VersionMismatch));

    let mut protocol = healthy_evidence();
    protocol.protocol_version = Some(TUN_HELPER_PROTOCOL_VERSION + 1);
    cases.push((protocol, TunHelperFailureKind::ProtocolMismatch));

    let mut missing_protocol = healthy_evidence();
    missing_protocol.protocol_version = None;
    cases.push((missing_protocol, TunHelperFailureKind::ProtocolMismatch));

    let mut unreachable = healthy_evidence();
    unreachable.health = TunHelperHealth::Unreachable;
    cases.push((unreachable, TunHelperFailureKind::ConnectionFailed));

    let mut stale = healthy_evidence();
    stale.observation = Some(TunNetworkObservation::disabled(0));
    cases.push((stale, TunHelperFailureKind::ObservationStale));

    let mut unconfirmed = healthy_evidence();
    unconfirmed.observation = Some(TunNetworkObservation::unknown(NOW));
    cases.push((unconfirmed, TunHelperFailureKind::ObservationPartial));

    let mut enabled = healthy_evidence();
    enabled.observation = Some(TunNetworkObservation::enabled(NOW));
    cases.push((enabled, TunHelperFailureKind::ObservationPartial));

    let mut missing_observation = healthy_evidence();
    missing_observation.observation = None;
    cases.push((
        missing_observation,
        TunHelperFailureKind::ObservationPartial,
    ));

    let mut foreign = healthy_evidence();
    let mut foreign_observation = TunNetworkObservation::disabled(NOW);
    foreign_observation.interface = mish_runtime::TunObservationComponentState::Foreign;
    foreign.observation = Some(foreign_observation);
    cases.push((foreign, TunHelperFailureKind::ObservationForeign));

    for (evidence, failure) in cases {
        let observation = ProductionTunGate::new(TEAM).evaluate(evidence, NOW);
        assert_eq!(
            observation.availability,
            TunHelperAvailability::RepairRequired
        );
        assert_eq!(observation.last_failure, Some(failure));
    }
}

#[test]
fn development_socket_and_trust_contract_cannot_satisfy_production() {
    let mut evidence = healthy_evidence();
    evidence.transport = ProductionTunTransport::DevelopmentUnixSocket {
        label: "com.asuka109.mish.tun-helper.dev".to_owned(),
        socket_path: "/var/run/com.asuka109.mish.tun-helper.501.sock".into(),
    };
    evidence.helper_identity = TunHelperPeerIdentity {
        signed: false,
        signing_identifier: "com.asuka109.mish.tun-helper.dev".to_owned(),
        team_identifier: None,
    };

    let observation = ProductionTunGate::new(TEAM).evaluate(evidence, NOW);

    assert_eq!(observation.availability, TunHelperAvailability::Unavailable);
    assert_eq!(
        observation.last_failure,
        Some(TunHelperFailureKind::IdentityRejected)
    );
}

#[test]
fn missing_team_or_wrong_xpc_service_cannot_satisfy_production() {
    let no_team = ProductionTunGate::new("").evaluate(healthy_evidence(), NOW);
    assert_eq!(no_team.availability, TunHelperAvailability::Unavailable);
    assert_eq!(
        no_team.last_failure,
        Some(TunHelperFailureKind::IdentityRejected)
    );

    let mut wrong_service = healthy_evidence();
    wrong_service.transport = ProductionTunTransport::Xpc {
        service_identifier: "com.asuka109.mish.tun-helper.dev".to_owned(),
    };
    let wrong_service = ProductionTunGate::new(TEAM).evaluate(wrong_service, NOW);
    assert_eq!(
        wrong_service.availability,
        TunHelperAvailability::Unavailable
    );
    assert_eq!(
        wrong_service.last_failure,
        Some(TunHelperFailureKind::IdentityRejected)
    );
}
