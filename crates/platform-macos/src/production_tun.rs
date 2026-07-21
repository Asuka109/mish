use std::{path::PathBuf, sync::Arc};

use futures_util::future::BoxFuture;
use mish_runtime::{
    TUN_APP_SIGNING_IDENTIFIER, TUN_HELPER_EXPECTED_VERSION, TUN_HELPER_PROTOCOL_VERSION,
    TUN_HELPER_SIGNING_IDENTIFIER, TunHelperAvailability, TunHelperError, TunHelperFailureKind,
    TunHelperHealth, TunHelperLifecycleOperation, TunHelperObservation, TunHelperPeerIdentity,
    TunHelperPlatform, TunHelperSnapshot, TunNetworkObservation, tun_observation_now,
};

pub const PRODUCTION_TUN_SERVICE_LABEL: &str = TUN_HELPER_SIGNING_IDENTIFIER;
pub const PRODUCTION_TUN_SERVICE_PLIST_NAME: &str = "com.asuka109.mish.tun-helper.plist";
pub const PRODUCTION_TUN_HELPER_BUNDLE_PATH: &str = "Contents/Resources/mish-tun-helper";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProductionTunRegistration {
    Enabled,
    NotFound,
    NotRegistered,
    RequiresApproval,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProductionTunTransport {
    Xpc { service_identifier: String },
    DevelopmentUnixSocket { label: String, socket_path: PathBuf },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductionTunEvidence {
    pub app_identity: TunHelperPeerIdentity,
    pub helper_identity: TunHelperPeerIdentity,
    pub health: TunHelperHealth,
    pub installed_version: Option<String>,
    pub observation: Option<TunNetworkObservation>,
    pub protocol_version: Option<u16>,
    pub registration: ProductionTunRegistration,
    pub transport: ProductionTunTransport,
}

pub struct ProductionTunGate {
    expected_team_identifier: String,
}

pub trait ProductionTunEvidenceProvider: Send + Sync {
    fn observe(&self) -> BoxFuture<'_, Result<ProductionTunEvidence, TunHelperError>>;
}

pub struct MacOsProductionTunHelperPlatform {
    gate: ProductionTunGate,
    provider: Arc<dyn ProductionTunEvidenceProvider>,
}

impl MacOsProductionTunHelperPlatform {
    pub fn new(
        expected_team_identifier: impl Into<String>,
        provider: Arc<dyn ProductionTunEvidenceProvider>,
    ) -> Self {
        Self {
            gate: ProductionTunGate::new(expected_team_identifier),
            provider,
        }
    }

    pub fn system(expected_team_identifier: impl Into<String>) -> Self {
        let expected_team_identifier = expected_team_identifier.into();
        Self::new(
            expected_team_identifier.clone(),
            Arc::new(SystemProductionTunEvidenceProvider {
                expected_team_identifier,
            }),
        )
    }

    async fn observed_evidence(&self) -> Result<ProductionTunEvidence, TunHelperError> {
        self.provider.observe().await
    }
}

impl TunHelperPlatform for MacOsProductionTunHelperPlatform {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
        TunHelperSnapshot::unavailable(
            TunHelperAvailability::Unavailable,
            TunHelperHealth::Unknown,
            TunHelperFailureKind::ConnectionFailed,
        )
    }

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>> {
        Box::pin(async move {
            let evidence = self.observed_evidence().await?;
            Ok(self.gate.evaluate(evidence, tun_observation_now()))
        })
    }

    fn run_lifecycle(
        &self,
        _operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async {
            Err(TunHelperError::new(
                TunHelperFailureKind::RegistrationFailed,
                "Production helper registration requires the signed installed-app flow",
            ))
        })
    }

    fn observe_tun(&self) -> BoxFuture<'_, Result<TunNetworkObservation, TunHelperError>> {
        Box::pin(async move {
            let evidence = self.observed_evidence().await?;
            let observation = evidence.observation.clone();
            let result = self.gate.evaluate(evidence, tun_observation_now());
            if result.availability != TunHelperAvailability::Available {
                return Err(TunHelperError::new(
                    result
                        .last_failure
                        .unwrap_or(TunHelperFailureKind::ConnectionFailed),
                    "The production TUN helper did not satisfy the availability gate",
                ));
            }
            observation.ok_or_else(|| {
                TunHelperError::new(
                    TunHelperFailureKind::ObservationPartial,
                    "The production TUN helper did not return a TUN observation",
                )
            })
        })
    }

    fn set_tun_enabled(&self, _enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async {
            Err(TunHelperError::new(
                TunHelperFailureKind::OperationFailed,
                "Production TUN changes require the signed XPC command transport",
            ))
        })
    }
}

struct SystemProductionTunEvidenceProvider {
    expected_team_identifier: String,
}

impl ProductionTunEvidenceProvider for SystemProductionTunEvidenceProvider {
    fn observe(&self) -> BoxFuture<'_, Result<ProductionTunEvidence, TunHelperError>> {
        let expected_team_identifier = self.expected_team_identifier.clone();
        Box::pin(async move { Ok(system_production_evidence(&expected_team_identifier)) })
    }
}

impl ProductionTunGate {
    pub fn new(expected_team_identifier: impl Into<String>) -> Self {
        Self {
            expected_team_identifier: expected_team_identifier.into(),
        }
    }

    pub fn evaluate(&self, evidence: ProductionTunEvidence, now: u64) -> TunHelperObservation {
        if self.expected_team_identifier.is_empty()
            || !matches!(
                &evidence.transport,
                ProductionTunTransport::Xpc { service_identifier }
                    if service_identifier == PRODUCTION_TUN_SERVICE_LABEL
            )
        {
            return unavailable(
                TunHelperAvailability::Unavailable,
                TunHelperHealth::InvalidSignature,
                evidence.installed_version,
                TunHelperFailureKind::IdentityRejected,
            );
        }

        if !identity_matches(
            &evidence.app_identity,
            TUN_APP_SIGNING_IDENTIFIER,
            &self.expected_team_identifier,
        ) {
            return unavailable(
                TunHelperAvailability::UnsignedApp,
                TunHelperHealth::InvalidSignature,
                evidence.installed_version,
                TunHelperFailureKind::UnsignedApp,
            );
        }

        if !identity_matches(
            &evidence.helper_identity,
            TUN_HELPER_SIGNING_IDENTIFIER,
            &self.expected_team_identifier,
        ) {
            return unavailable(
                TunHelperAvailability::RepairRequired,
                TunHelperHealth::InvalidSignature,
                evidence.installed_version,
                TunHelperFailureKind::IdentityRejected,
            );
        }

        match evidence.registration {
            ProductionTunRegistration::RequiresApproval => {
                return unavailable(
                    TunHelperAvailability::PermissionRequired,
                    TunHelperHealth::NotInstalled,
                    evidence.installed_version,
                    TunHelperFailureKind::RegistrationRequiresApproval,
                );
            }
            ProductionTunRegistration::NotRegistered => {
                return unavailable(
                    TunHelperAvailability::PermissionRequired,
                    TunHelperHealth::NotInstalled,
                    evidence.installed_version,
                    TunHelperFailureKind::RegistrationFailed,
                );
            }
            ProductionTunRegistration::NotFound => {
                return unavailable(
                    TunHelperAvailability::RepairRequired,
                    TunHelperHealth::NotInstalled,
                    evidence.installed_version,
                    TunHelperFailureKind::RegistrationFailed,
                );
            }
            ProductionTunRegistration::Enabled => {}
        }

        if evidence.installed_version.as_deref() != Some(TUN_HELPER_EXPECTED_VERSION) {
            return unavailable(
                TunHelperAvailability::RepairRequired,
                TunHelperHealth::VersionMismatch,
                evidence.installed_version,
                TunHelperFailureKind::VersionMismatch,
            );
        }
        if evidence.health != TunHelperHealth::Healthy {
            return unavailable(
                TunHelperAvailability::RepairRequired,
                evidence.health,
                evidence.installed_version,
                health_failure(evidence.health),
            );
        }
        if evidence.protocol_version != Some(TUN_HELPER_PROTOCOL_VERSION) {
            return unavailable(
                TunHelperAvailability::RepairRequired,
                TunHelperHealth::VersionMismatch,
                evidence.installed_version,
                TunHelperFailureKind::ProtocolMismatch,
            );
        }

        let Some(observation) = evidence.observation else {
            return unavailable(
                TunHelperAvailability::RepairRequired,
                TunHelperHealth::Unreachable,
                evidence.installed_version,
                TunHelperFailureKind::ObservationPartial,
            );
        };
        if !observation.confirms_disabled_at(now) {
            return unavailable(
                TunHelperAvailability::RepairRequired,
                TunHelperHealth::Unknown,
                evidence.installed_version,
                observation.failure_kind_at(now),
            );
        }

        TunHelperObservation {
            availability: TunHelperAvailability::Available,
            health: TunHelperHealth::Healthy,
            installation_id: Some(PRODUCTION_TUN_SERVICE_LABEL.to_owned()),
            installed_version: evidence.installed_version,
            last_failure: None,
        }
    }
}

fn identity_matches(
    identity: &TunHelperPeerIdentity,
    expected_identifier: &str,
    expected_team_identifier: &str,
) -> bool {
    identity.signed
        && identity.signing_identifier == expected_identifier
        && identity.team_identifier.as_deref() == Some(expected_team_identifier)
}

fn health_failure(health: TunHelperHealth) -> TunHelperFailureKind {
    match health {
        TunHelperHealth::InvalidSignature => TunHelperFailureKind::InvalidSignature,
        TunHelperHealth::VersionMismatch => TunHelperFailureKind::VersionMismatch,
        TunHelperHealth::Healthy
        | TunHelperHealth::NotInstalled
        | TunHelperHealth::Unknown
        | TunHelperHealth::Unreachable => TunHelperFailureKind::ConnectionFailed,
    }
}

fn unavailable(
    availability: TunHelperAvailability,
    health: TunHelperHealth,
    installed_version: Option<String>,
    failure: TunHelperFailureKind,
) -> TunHelperObservation {
    TunHelperObservation {
        availability,
        health,
        installation_id: None,
        installed_version,
        last_failure: Some(failure),
    }
}

#[cfg(target_os = "macos")]
fn system_production_evidence(expected_team_identifier: &str) -> ProductionTunEvidence {
    use core_foundation::url::CFURL;
    use objc2_foundation::NSString;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    use security_framework::os::macos::code_signing::{Flags, SecCode, SecStaticCode};

    let app_path = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent()?.parent()?.parent().map(PathBuf::from));
    let helper_path = app_path
        .as_ref()
        .map(|path| path.join(PRODUCTION_TUN_HELPER_BUNDLE_PATH));
    let app_signed = developer_id_requirement(TUN_APP_SIGNING_IDENTIFIER, expected_team_identifier)
        .and_then(|requirement| {
            SecCode::for_self(Flags::NONE)
                .ok()?
                .check_validity(Flags::STRICT_VALIDATE, &requirement)
                .ok()
        })
        .is_some();
    let helper_signed = helper_path
        .and_then(|path| CFURL::from_path(path, false))
        .and_then(|url| SecStaticCode::from_path(&url, Flags::NONE).ok())
        .and_then(|code| {
            let requirement =
                developer_id_requirement(TUN_HELPER_SIGNING_IDENTIFIER, expected_team_identifier)?;
            code.check_validity(
                Flags::STRICT_VALIDATE | Flags::CHECK_ALL_ARCHITECTURES | Flags::NO_NETWORK_ACCESS,
                &requirement,
            )
            .ok()
        })
        .is_some();
    let plist_name = NSString::from_str(PRODUCTION_TUN_SERVICE_PLIST_NAME);
    // SAFETY: Apple's macOS 13+ API returns a retained service for the fixed plist name,
    // and querying status does not register, unregister, or mutate the service.
    let registration = unsafe {
        let service = SMAppService::daemonServiceWithPlistName(&plist_name);
        match service.status() {
            SMAppServiceStatus::Enabled => ProductionTunRegistration::Enabled,
            SMAppServiceStatus::RequiresApproval => ProductionTunRegistration::RequiresApproval,
            SMAppServiceStatus::NotRegistered => ProductionTunRegistration::NotRegistered,
            SMAppServiceStatus::NotFound => ProductionTunRegistration::NotFound,
            _ => ProductionTunRegistration::NotFound,
        }
    };

    ProductionTunEvidence {
        app_identity: observed_identity(
            app_signed,
            TUN_APP_SIGNING_IDENTIFIER,
            expected_team_identifier,
        ),
        helper_identity: observed_identity(
            helper_signed,
            TUN_HELPER_SIGNING_IDENTIFIER,
            expected_team_identifier,
        ),
        health: TunHelperHealth::Unreachable,
        installed_version: None,
        observation: None,
        protocol_version: None,
        registration,
        transport: ProductionTunTransport::Xpc {
            service_identifier: PRODUCTION_TUN_SERVICE_LABEL.to_owned(),
        },
    }
}

#[cfg(target_os = "macos")]
fn developer_id_requirement(
    signing_identifier: &str,
    team_identifier: &str,
) -> Option<security_framework::os::macos::code_signing::SecRequirement> {
    use security_framework::os::macos::code_signing::SecRequirement;

    if team_identifier.len() != 10
        || !team_identifier
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return None;
    }
    let requirement = format!(
        "anchor apple generic and identifier \"{signing_identifier}\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{team_identifier}\""
    );
    requirement.parse::<SecRequirement>().ok()
}

#[cfg(not(target_os = "macos"))]
fn system_production_evidence(expected_team_identifier: &str) -> ProductionTunEvidence {
    ProductionTunEvidence {
        app_identity: observed_identity(
            false,
            TUN_APP_SIGNING_IDENTIFIER,
            expected_team_identifier,
        ),
        helper_identity: observed_identity(
            false,
            TUN_HELPER_SIGNING_IDENTIFIER,
            expected_team_identifier,
        ),
        health: TunHelperHealth::Unreachable,
        installed_version: None,
        observation: None,
        protocol_version: None,
        registration: ProductionTunRegistration::NotFound,
        transport: ProductionTunTransport::Xpc {
            service_identifier: PRODUCTION_TUN_SERVICE_LABEL.to_owned(),
        },
    }
}

fn observed_identity(
    signed: bool,
    signing_identifier: &str,
    expected_team_identifier: &str,
) -> TunHelperPeerIdentity {
    TunHelperPeerIdentity {
        signed,
        signing_identifier: signing_identifier.to_owned(),
        team_identifier: signed.then(|| expected_team_identifier.to_owned()),
    }
}
