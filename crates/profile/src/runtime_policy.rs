use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_norway::{Mapping, Value};

use crate::{Fingerprint, RevisionId};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyOwner {
    Source,
    ApplicationPolicy,
    PlatformIntegration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyDisposition {
    Preserved,
    ApplicationOverridden,
    PlatformOverridden,
    Disabled,
    Rejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyReason {
    PortableSourcePolicy,
    UnknownKeyPreserved,
    ManagedProxyIngress,
    LoopbackOnlyBinding,
    PrivateController,
    ManagedRuntimeBehavior,
    CaptureRequiresExplicitPermission,
    PassiveInspectionOnly,
    RuntimePersistenceDisabled,
    DnsIntegrationManaged,
    ExternalSurfaceDisabled,
    DeviceIntegrationUnsafe,
    ProviderPathUnsafe,
    RelativeProviderPath,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivationImpact {
    PreservedInEffectiveRuntime,
    ReplacedByApplicationValue,
    ReplacedByPlatformValue,
    ForcedOff,
    BlocksImport,
    ExcludedFromEffectiveRuntime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeLayer {
    Source,
    UserPatches,
    ApplicationPolicy,
    PlatformIntegration,
    EffectiveRuntime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProvenanceReviewAuthority {
    DesktopPolicy,
    IllustrativeBrowserFixture,
    MigratedLegacyBaseline,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyClassification {
    pub activation_impact: ActivationImpact,
    pub disposition: PolicyDisposition,
    pub field_identity: String,
    pub owner: PolicyOwner,
    pub reason: PolicyReason,
    pub source_present: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProvenanceReview {
    pub artifact_fingerprint: Fingerprint,
    pub authority: ProvenanceReviewAuthority,
    pub items: Vec<PolicyClassification>,
    pub layers: Vec<RuntimeLayer>,
    pub source_revision: RevisionId,
    pub unknown_key_count: usize,
}

impl Default for RuntimeProvenanceReview {
    fn default() -> Self {
        Self {
            artifact_fingerprint: Fingerprint::default(),
            authority: ProvenanceReviewAuthority::DesktopPolicy,
            items: Vec::new(),
            layers: runtime_layers(),
            source_revision: RevisionId::default(),
            unknown_key_count: 0,
        }
    }
}

impl RuntimeProvenanceReview {
    pub fn is_bound_to(&self, revision: &RevisionId, fingerprint: &Fingerprint) -> bool {
        self.source_revision == *revision && self.artifact_fingerprint == *fingerprint
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyViolationKind {
    InvalidManagedShape,
    UnsafeDeviceIntegration,
    UnsafeProviderPath,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyViolation {
    pub field_identity: &'static str,
    pub kind: PolicyViolationKind,
}

pub struct ManagedRuntimeValues {
    pub controller_address: String,
    pub controller_secret: String,
    pub mixed_port: u16,
    pub proxy_host: String,
    pub tun_enabled: bool,
}

impl std::fmt::Debug for ManagedRuntimeValues {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ManagedRuntimeValues")
            .field("controller_address", &"[redacted]")
            .field("controller_secret", &"[redacted]")
            .field("mixed_port", &"[managed]")
            .field("proxy_host", &"[redacted]")
            .field("tun_enabled", &self.tun_enabled)
            .finish()
    }
}

#[derive(Clone, Copy)]
enum RuleOperation {
    Remove,
    SetZero,
    SetMixedPort,
    SetFalse,
    SetProxyHost,
    SetController,
    SetSecret,
    SetWarning,
    SetRule,
    SetEmptySequence,
    SetManagedTun,
}

#[derive(Clone, Copy)]
struct ManagedFieldRule {
    field_identity: &'static str,
    owner: PolicyOwner,
    disposition: PolicyDisposition,
    reason: PolicyReason,
    activation_impact: ActivationImpact,
    operation: RuleOperation,
}

const APPLICATION_RULES: &[ManagedFieldRule] = &[
    app(
        "port",
        PolicyReason::ManagedProxyIngress,
        RuleOperation::SetZero,
    ),
    app(
        "socks-port",
        PolicyReason::ManagedProxyIngress,
        RuleOperation::SetZero,
    ),
    app(
        "redir-port",
        PolicyReason::ManagedProxyIngress,
        RuleOperation::SetZero,
    ),
    app(
        "tproxy-port",
        PolicyReason::ManagedProxyIngress,
        RuleOperation::SetZero,
    ),
    app(
        "mixed-port",
        PolicyReason::ManagedProxyIngress,
        RuleOperation::SetMixedPort,
    ),
    app(
        "allow-lan",
        PolicyReason::LoopbackOnlyBinding,
        RuleOperation::SetFalse,
    ),
    app(
        "bind-address",
        PolicyReason::LoopbackOnlyBinding,
        RuleOperation::SetProxyHost,
    ),
    app_remove("authentication", PolicyReason::LoopbackOnlyBinding),
    app_remove("skip-auth-prefixes", PolicyReason::LoopbackOnlyBinding),
    app_remove("lan-allowed-ips", PolicyReason::LoopbackOnlyBinding),
    app_remove("lan-disallowed-ips", PolicyReason::LoopbackOnlyBinding),
    app(
        "external-controller",
        PolicyReason::PrivateController,
        RuleOperation::SetController,
    ),
    app(
        "secret",
        PolicyReason::PrivateController,
        RuleOperation::SetSecret,
    ),
    app_remove(
        "external-controller-tls",
        PolicyReason::ExternalSurfaceDisabled,
    ),
    app_remove(
        "external-controller-unix",
        PolicyReason::ExternalSurfaceDisabled,
    ),
    app_remove(
        "external-controller-pipe",
        PolicyReason::ExternalSurfaceDisabled,
    ),
    app_remove(
        "external-controller-cors",
        PolicyReason::ExternalSurfaceDisabled,
    ),
    app_remove("external-ui", PolicyReason::ExternalSurfaceDisabled),
    app_remove("external-ui-name", PolicyReason::ExternalSurfaceDisabled),
    app_remove("external-ui-url", PolicyReason::ExternalSurfaceDisabled),
    app_remove("external-doh-server", PolicyReason::ExternalSurfaceDisabled),
    app(
        "mode",
        PolicyReason::ManagedRuntimeBehavior,
        RuleOperation::SetRule,
    ),
    app(
        "log-level",
        PolicyReason::ManagedRuntimeBehavior,
        RuleOperation::SetWarning,
    ),
    app_nested(
        "profile.store-selected",
        PolicyReason::RuntimePersistenceDisabled,
        RuleOperation::SetFalse,
    ),
    app_nested(
        "profile.store-fake-ip",
        PolicyReason::RuntimePersistenceDisabled,
        RuleOperation::SetFalse,
    ),
];

const PLATFORM_RULES: &[ManagedFieldRule] = &[
    platform(
        "listeners",
        PolicyDisposition::Rejected,
        PolicyReason::DeviceIntegrationUnsafe,
        ActivationImpact::BlocksImport,
        RuleOperation::SetEmptySequence,
    ),
    platform(
        "interface-name",
        PolicyDisposition::Rejected,
        PolicyReason::DeviceIntegrationUnsafe,
        ActivationImpact::BlocksImport,
        RuleOperation::Remove,
    ),
    platform(
        "routing-mark",
        PolicyDisposition::Rejected,
        PolicyReason::DeviceIntegrationUnsafe,
        ActivationImpact::BlocksImport,
        RuleOperation::Remove,
    ),
    platform(
        "tun",
        PolicyDisposition::PlatformOverridden,
        PolicyReason::CaptureRequiresExplicitPermission,
        ActivationImpact::ExcludedFromEffectiveRuntime,
        RuleOperation::SetManagedTun,
    ),
    platform(
        "sniffer.enable",
        PolicyDisposition::Disabled,
        PolicyReason::PassiveInspectionOnly,
        ActivationImpact::ForcedOff,
        RuleOperation::SetFalse,
    ),
    platform(
        "dns.listen",
        PolicyDisposition::PlatformOverridden,
        PolicyReason::DnsIntegrationManaged,
        ActivationImpact::ExcludedFromEffectiveRuntime,
        RuleOperation::Remove,
    ),
];

const PORTABLE_ROOT_KEYS: &[&str] = &[
    "proxies",
    "proxy-groups",
    "proxy-providers",
    "rules",
    "rule-providers",
    "sub-rules",
    "dns",
    "hosts",
    "sniffer",
    "tun",
    "profile",
    "geodata-mode",
    "geodata-loader",
    "geo-auto-update",
    "geo-update-interval",
    "geox-url",
    "find-process-mode",
    "unified-delay",
    "tcp-concurrent",
    "global-client-fingerprint",
    "global-ua",
    "ntp",
    "keep-alive-interval",
    "keep-alive-idle",
    "disable-keep-alive",
];

const fn app(
    field_identity: &'static str,
    reason: PolicyReason,
    operation: RuleOperation,
) -> ManagedFieldRule {
    ManagedFieldRule {
        field_identity,
        owner: PolicyOwner::ApplicationPolicy,
        disposition: PolicyDisposition::ApplicationOverridden,
        reason,
        activation_impact: ActivationImpact::ReplacedByApplicationValue,
        operation,
    }
}

const fn app_remove(field_identity: &'static str, reason: PolicyReason) -> ManagedFieldRule {
    ManagedFieldRule {
        activation_impact: ActivationImpact::ExcludedFromEffectiveRuntime,
        operation: RuleOperation::Remove,
        ..app(field_identity, reason, RuleOperation::Remove)
    }
}

const fn app_nested(
    field_identity: &'static str,
    reason: PolicyReason,
    operation: RuleOperation,
) -> ManagedFieldRule {
    app(field_identity, reason, operation)
}

const fn platform(
    field_identity: &'static str,
    disposition: PolicyDisposition,
    reason: PolicyReason,
    activation_impact: ActivationImpact,
    operation: RuleOperation,
) -> ManagedFieldRule {
    ManagedFieldRule {
        field_identity,
        owner: PolicyOwner::PlatformIntegration,
        disposition,
        reason,
        activation_impact,
        operation,
    }
}

pub fn normalize_source_policy(
    document: &mut Value,
) -> Result<(Vec<PolicyClassification>, usize), PolicyViolation> {
    let root = document
        .as_mapping_mut()
        .expect("the preflight caller validates the root mapping");
    reject_unsafe_source_fields(root)?;

    let source_keys: Vec<String> = root
        .keys()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut items = managed_review(root);
    apply_rules(root, APPLICATION_RULES, None);
    apply_rules(root, PLATFORM_RULES, None);

    for key in PORTABLE_ROOT_KEYS {
        if !source_keys.iter().any(|candidate| candidate == key) {
            continue;
        }
        items.push(preserved(key, PolicyReason::PortableSourcePolicy));
    }

    let managed_roots = managed_root_keys();
    let unknown_key_count = source_keys
        .iter()
        .filter(|key| {
            !PORTABLE_ROOT_KEYS.contains(&key.as_str()) && !managed_roots.contains(&key.as_str())
        })
        .count();
    if unknown_key_count > 0 {
        items.push(PolicyClassification {
            activation_impact: ActivationImpact::PreservedInEffectiveRuntime,
            disposition: PolicyDisposition::Preserved,
            field_identity: "source.extension-key".to_owned(),
            owner: PolicyOwner::Source,
            reason: PolicyReason::UnknownKeyPreserved,
            source_present: true,
        });
    }
    if has_relative_provider_path(root, "proxy-providers") {
        items.push(preserved(
            "proxy-providers.*.path",
            PolicyReason::RelativeProviderPath,
        ));
    }
    if has_relative_provider_path(root, "rule-providers") {
        items.push(preserved(
            "rule-providers.*.path",
            PolicyReason::RelativeProviderPath,
        ));
    }
    Ok((items, unknown_key_count))
}

pub fn apply_runtime_policy(
    document: &mut Value,
    values: &ManagedRuntimeValues,
) -> Result<Vec<PolicyClassification>, PolicyViolation> {
    let Some(root) = document.as_mapping_mut() else {
        return Err(PolicyViolation {
            field_identity: "profile.root",
            kind: PolicyViolationKind::InvalidManagedShape,
        });
    };
    for section in ["dns", "profile", "sniffer", "tun"] {
        if root
            .get(Value::String(section.to_owned()))
            .is_some_and(|value| !value.is_mapping())
        {
            return Err(PolicyViolation {
                field_identity: section,
                kind: PolicyViolationKind::InvalidManagedShape,
            });
        }
    }
    validate_provider_paths(root)?;
    let items = managed_review(root);
    apply_rules(root, APPLICATION_RULES, Some(values));
    apply_rules(root, PLATFORM_RULES, Some(values));
    Ok(items)
}

pub fn runtime_layers() -> Vec<RuntimeLayer> {
    vec![
        RuntimeLayer::Source,
        RuntimeLayer::UserPatches,
        RuntimeLayer::ApplicationPolicy,
        RuntimeLayer::PlatformIntegration,
        RuntimeLayer::EffectiveRuntime,
    ]
}

pub fn migrated_runtime_provenance(
    revision: &RevisionId,
    fingerprint: &Fingerprint,
) -> RuntimeProvenanceReview {
    let mut items = managed_review(&Mapping::new());
    items.push(preserved(
        "source.policy",
        PolicyReason::PortableSourcePolicy,
    ));
    RuntimeProvenanceReview {
        artifact_fingerprint: fingerprint.clone(),
        authority: ProvenanceReviewAuthority::MigratedLegacyBaseline,
        items,
        layers: runtime_layers(),
        source_revision: revision.clone(),
        unknown_key_count: 0,
    }
}

fn managed_review(root: &Mapping) -> Vec<PolicyClassification> {
    APPLICATION_RULES
        .iter()
        .chain(PLATFORM_RULES)
        .map(|rule| PolicyClassification {
            activation_impact: rule.activation_impact,
            disposition: rule.disposition,
            field_identity: rule.field_identity.to_owned(),
            owner: rule.owner,
            reason: rule.reason,
            source_present: path_exists(root, rule.field_identity),
        })
        .collect()
}

fn preserved(field_identity: &str, reason: PolicyReason) -> PolicyClassification {
    PolicyClassification {
        activation_impact: ActivationImpact::PreservedInEffectiveRuntime,
        disposition: PolicyDisposition::Preserved,
        field_identity: field_identity.to_owned(),
        owner: PolicyOwner::Source,
        reason,
        source_present: true,
    }
}

fn managed_root_keys() -> Vec<&'static str> {
    APPLICATION_RULES
        .iter()
        .chain(PLATFORM_RULES)
        .map(|rule| {
            rule.field_identity
                .split('.')
                .next()
                .unwrap_or(rule.field_identity)
        })
        .collect()
}

fn reject_unsafe_source_fields(root: &Mapping) -> Result<(), PolicyViolation> {
    for field_identity in ["listeners", "interface-name", "routing-mark"] {
        if root.contains_key(Value::String(field_identity.to_owned())) {
            return Err(PolicyViolation {
                field_identity,
                kind: PolicyViolationKind::UnsafeDeviceIntegration,
            });
        }
    }
    validate_provider_paths(root)
}

fn validate_provider_paths(root: &Mapping) -> Result<(), PolicyViolation> {
    for (section, field_identity) in [
        ("proxy-providers", "proxy-providers.*.path"),
        ("rule-providers", "rule-providers.*.path"),
    ] {
        let Some(providers) = root
            .get(Value::String(section.to_owned()))
            .and_then(Value::as_mapping)
        else {
            continue;
        };
        for provider in providers.values() {
            let Some(path) = provider
                .as_mapping()
                .and_then(|mapping| mapping.get(Value::String("path".to_owned())))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if unsafe_provider_path(path) {
                return Err(PolicyViolation {
                    field_identity,
                    kind: PolicyViolationKind::UnsafeProviderPath,
                });
            }
        }
    }
    Ok(())
}

fn unsafe_provider_path(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn has_relative_provider_path(root: &Mapping, section: &str) -> bool {
    root.get(Value::String(section.to_owned()))
        .and_then(Value::as_mapping)
        .is_some_and(|providers| {
            providers.values().any(|provider| {
                provider
                    .as_mapping()
                    .and_then(|mapping| mapping.get(Value::String("path".to_owned())))
                    .and_then(Value::as_str)
                    .is_some_and(|path| !unsafe_provider_path(path))
            })
        })
}

fn apply_rules(
    root: &mut Mapping,
    rules: &[ManagedFieldRule],
    values: Option<&ManagedRuntimeValues>,
) {
    for rule in rules {
        let parts: Vec<&str> = rule.field_identity.split('.').collect();
        if parts.len() == 1 {
            apply_root_rule(root, *rule, values);
        } else {
            apply_nested_rule(root, parts[0], parts[1], *rule, values);
        }
    }
}

fn apply_root_rule(
    root: &mut Mapping,
    rule: ManagedFieldRule,
    values: Option<&ManagedRuntimeValues>,
) {
    let key = Value::String(rule.field_identity.to_owned());
    match (rule.operation, values) {
        (RuleOperation::Remove, _) => {
            root.remove(&key);
        }
        (_, None) => {
            root.remove(&key);
        }
        (RuleOperation::SetZero, Some(_)) => {
            insert(root, rule.field_identity, Value::Number(0.into()))
        }
        (RuleOperation::SetMixedPort, Some(values)) => insert(
            root,
            rule.field_identity,
            Value::Number(values.mixed_port.into()),
        ),
        (RuleOperation::SetFalse, Some(_)) => insert(root, rule.field_identity, Value::Bool(false)),
        (RuleOperation::SetProxyHost, Some(values)) => insert(
            root,
            rule.field_identity,
            Value::String(values.proxy_host.clone()),
        ),
        (RuleOperation::SetController, Some(values)) => insert(
            root,
            rule.field_identity,
            Value::String(values.controller_address.clone()),
        ),
        (RuleOperation::SetSecret, Some(values)) => insert(
            root,
            rule.field_identity,
            Value::String(values.controller_secret.clone()),
        ),
        (RuleOperation::SetWarning, Some(_)) => insert(
            root,
            rule.field_identity,
            Value::String("warning".to_owned()),
        ),
        (RuleOperation::SetRule, Some(_)) => {
            insert(root, rule.field_identity, Value::String("rule".to_owned()))
        }
        (RuleOperation::SetEmptySequence, Some(_)) => {
            insert(root, rule.field_identity, Value::Sequence(Vec::new()))
        }
        (RuleOperation::SetManagedTun, Some(values)) => {
            insert(root, rule.field_identity, managed_tun(values.tun_enabled))
        }
    }
}

fn managed_tun(enabled: bool) -> Value {
    let mut tun = Mapping::new();
    tun.insert(Value::String("enable".to_owned()), Value::Bool(enabled));
    if enabled {
        tun.insert(
            Value::String("stack".to_owned()),
            Value::String("gvisor".to_owned()),
        );
        tun.insert(
            Value::String("dns-hijack".to_owned()),
            Value::Sequence(vec![Value::String("any:53".to_owned())]),
        );
        tun.insert(Value::String("auto-route".to_owned()), Value::Bool(true));
        tun.insert(
            Value::String("auto-detect-interface".to_owned()),
            Value::Bool(true),
        );
        tun.insert(Value::String("strict-route".to_owned()), Value::Bool(true));
    }
    Value::Mapping(tun)
}

fn apply_nested_rule(
    root: &mut Mapping,
    section: &str,
    field: &str,
    rule: ManagedFieldRule,
    values: Option<&ManagedRuntimeValues>,
) {
    let section_key = Value::String(section.to_owned());
    if values.is_none() && !root.contains_key(&section_key) {
        return;
    }
    if !root.contains_key(&section_key) {
        root.insert(section_key.clone(), Value::Mapping(Mapping::new()));
    }
    let Some(mapping) = root.get_mut(&section_key).and_then(Value::as_mapping_mut) else {
        return;
    };
    let field_key = Value::String(field.to_owned());
    match (rule.operation, values) {
        (RuleOperation::Remove, _) => {
            mapping.remove(&field_key);
        }
        (RuleOperation::SetFalse, None) => insert(mapping, field, Value::Bool(false)),
        (_, None) => {
            mapping.remove(&field_key);
        }
        (RuleOperation::SetFalse, Some(_)) => insert(mapping, field, Value::Bool(false)),
        _ => {}
    }
}

fn path_exists(root: &Mapping, field_identity: &str) -> bool {
    let mut parts = field_identity.split('.');
    let Some(root_key) = parts.next() else {
        return false;
    };
    let Some(value) = root.get(Value::String(root_key.to_owned())) else {
        return false;
    };
    let Some(nested_key) = parts.next() else {
        return true;
    };
    value
        .as_mapping()
        .is_some_and(|mapping| mapping.contains_key(Value::String(nested_key.to_owned())))
}

fn insert(mapping: &mut Mapping, key: &str, value: Value) {
    mapping.insert(Value::String(key.to_owned()), value);
}
