use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_norway::{Mapping, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Fingerprint, RevisionId};

pub const PROFILE_PATCH_SCHEMA_VERSION: u32 = 1;
pub const MAX_PROFILE_PATCHES: usize = 128;
const MAX_LABEL_LENGTH: usize = 256;
const MAX_RULE_VALUE_LENGTH: usize = 1_024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePatchSet {
    pub effective_fingerprint: Fingerprint,
    pub patches: Vec<ProfilePatch>,
    pub schema_version: u32,
    pub source_fingerprint: Fingerprint,
    pub source_revision: RevisionId,
}

impl ProfilePatchSet {
    pub fn empty(source_revision: &RevisionId, source_fingerprint: &Fingerprint) -> Self {
        Self {
            effective_fingerprint: source_fingerprint.clone(),
            patches: Vec::new(),
            schema_version: PROFILE_PATCH_SCHEMA_VERSION,
            source_fingerprint: source_fingerprint.clone(),
            source_revision: source_revision.clone(),
        }
    }

    pub fn is_bound_to(&self, revision: &RevisionId, fingerprint: &Fingerprint) -> bool {
        self.source_revision == *revision && self.source_fingerprint == *fingerprint
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePatch {
    pub enabled: bool,
    pub id: String,
    pub operation: ProfilePatchOperation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ProfilePatchOperation {
    RuleInsert {
        position: RuleInsertPosition,
        rule: StructuredRule,
    },
    RuleDisable {
        rule_id: String,
    },
    RuleDelete {
        rule_id: String,
    },
    GroupAdd {
        label: String,
        member_ids: Vec<String>,
    },
    GroupMembers {
        group_id: String,
        member_ids: Vec<String>,
    },
    GroupReorder {
        group_ids: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleInsertPosition {
    Prefix,
    Suffix,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StructuredRule {
    Match {
        target_id: String,
    },
    RuleSet {
        no_resolve: bool,
        provider_id: String,
        target_id: String,
    },
    Standard {
        no_resolve: bool,
        rule_type: CommonRuleType,
        target_id: String,
        value: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommonRuleType {
    Domain,
    DomainSuffix,
    DomainKeyword,
    IpCidr,
    IpCidr6,
    GeoIp,
    GeoSite,
    ProcessName,
}

impl CommonRuleType {
    const fn mihomo_name(self) -> &'static str {
        match self {
            Self::Domain => "DOMAIN",
            Self::DomainSuffix => "DOMAIN-SUFFIX",
            Self::DomainKeyword => "DOMAIN-KEYWORD",
            Self::IpCidr => "IP-CIDR",
            Self::IpCidr6 => "IP-CIDR6",
            Self::GeoIp => "GEOIP",
            Self::GeoSite => "GEOSITE",
            Self::ProcessName => "PROCESS-NAME",
        }
    }

    const fn supports_no_resolve(self) -> bool {
        matches!(self, Self::IpCidr | Self::IpCidr6 | Self::GeoIp)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PatchEntityKind {
    BuiltIn,
    PolicyGroup,
    Proxy,
    RuleProvider,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PatchValidationResult {
    Valid,
    Stale,
    Invalid,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PatchValidationCode {
    Valid,
    Disabled,
    RevisionMismatch,
    TargetMissing,
    DuplicateTarget,
    DuplicateLabel,
    UnsafeReference,
    InvalidValue,
    InvalidOrder,
    SemanticConflict,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PatchActivationImpact {
    InsertRule,
    ExcludeRule,
    AddGroup,
    ReplaceGroupMembers,
    ReorderGroups,
    NoChange,
    BlocksActivation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedProfilePatches {
    pub bytes: Vec<u8>,
    pub effective_fingerprint: Fingerprint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProfilePatchError {
    #[error("profile patch schema is unsupported")]
    UnsupportedSchema,
    #[error("profile patch authority is stale")]
    StaleAuthority,
    #[error("profile patch definition is invalid")]
    InvalidPatch,
    #[error("profile patches conflict with the current revision")]
    ValidationFailed,
    #[error("profile patch generation failed")]
    GenerationFailed,
}

#[derive(Clone)]
struct CatalogEntity {
    id: String,
    _kind: PatchEntityKind,
    label: String,
}

struct CatalogGroup {
    id: String,
    label: String,
    member_ids: Vec<String>,
    position: usize,
    supported: bool,
}

struct CatalogRule {
    id: String,
    line: String,
    position: usize,
    rule_type: String,
    target: String,
}

struct PatchCatalog {
    entity_labels: HashMap<String, String>,
    group_labels: HashMap<String, String>,
    groups: Vec<CatalogGroup>,
    provider_labels: HashMap<String, String>,
    rules: Vec<CatalogRule>,
}

#[allow(dead_code)]
struct EvaluatedPatch {
    activation_impact: PatchActivationImpact,
    code: PatchValidationCode,
    result: PatchValidationResult,
    target: String,
}

pub fn bind_and_apply_profile_patches(
    normalized_source: &[u8],
    revision: &RevisionId,
    source_fingerprint: &Fingerprint,
    patches: Vec<ProfilePatch>,
) -> Result<(ProfilePatchSet, AppliedProfilePatches), ProfilePatchError> {
    let mut patch_set = ProfilePatchSet {
        effective_fingerprint: source_fingerprint.clone(),
        patches,
        schema_version: PROFILE_PATCH_SCHEMA_VERSION,
        source_fingerprint: source_fingerprint.clone(),
        source_revision: revision.clone(),
    };
    validate_patch_set_shape(&patch_set)?;
    let applied =
        apply_profile_patches(normalized_source, revision, source_fingerprint, &patch_set)?;
    patch_set.effective_fingerprint = applied.effective_fingerprint.clone();
    Ok((patch_set, applied))
}

pub fn apply_profile_patches(
    normalized_source: &[u8],
    revision: &RevisionId,
    source_fingerprint: &Fingerprint,
    patch_set: &ProfilePatchSet,
) -> Result<AppliedProfilePatches, ProfilePatchError> {
    validate_patch_set_shape(patch_set)?;
    if !patch_set.is_bound_to(revision, source_fingerprint) {
        return Err(ProfilePatchError::StaleAuthority);
    }
    if patch_set.patches.is_empty() {
        return Ok(AppliedProfilePatches {
            bytes: normalized_source.to_vec(),
            effective_fingerprint: source_fingerprint.clone(),
        });
    }
    let mut document: Value = serde_norway::from_slice(normalized_source)
        .map_err(|_| ProfilePatchError::GenerationFailed)?;
    let root = document
        .as_mapping_mut()
        .ok_or(ProfilePatchError::GenerationFailed)?;
    let catalog = build_catalog(root)?;
    if evaluate_patches(&patch_set.patches, &catalog, true)
        .iter()
        .any(|evaluation| evaluation.result != PatchValidationResult::Valid)
    {
        return Err(ProfilePatchError::ValidationFailed);
    }

    apply_rule_patches(root, &catalog, &patch_set.patches)?;
    apply_group_patches(root, &catalog, &patch_set.patches)?;
    let bytes = serde_norway::to_string(&document)
        .map(String::into_bytes)
        .map_err(|_| ProfilePatchError::GenerationFailed)?;
    let effective_fingerprint = Fingerprint::from_normalized_artifact(&bytes);
    if patch_set.effective_fingerprint.as_str().is_empty()
        || patch_set.effective_fingerprint == *source_fingerprint
    {
        return Ok(AppliedProfilePatches {
            bytes,
            effective_fingerprint,
        });
    }
    if patch_set.effective_fingerprint != effective_fingerprint {
        return Err(ProfilePatchError::ValidationFailed);
    }
    Ok(AppliedProfilePatches {
        bytes,
        effective_fingerprint,
    })
}

pub(crate) fn validate_patch_set_shape(
    patch_set: &ProfilePatchSet,
) -> Result<(), ProfilePatchError> {
    if patch_set.schema_version != PROFILE_PATCH_SCHEMA_VERSION {
        return Err(ProfilePatchError::UnsupportedSchema);
    }
    if patch_set.patches.len() > MAX_PROFILE_PATCHES {
        return Err(ProfilePatchError::InvalidPatch);
    }
    let mut ids = HashSet::new();
    for patch in &patch_set.patches {
        if Uuid::parse_str(&patch.id).is_err() || !ids.insert(&patch.id) {
            return Err(ProfilePatchError::InvalidPatch);
        }
        match &patch.operation {
            ProfilePatchOperation::RuleInsert { rule, .. } => validate_structured_rule(rule)?,
            ProfilePatchOperation::RuleDisable { rule_id }
            | ProfilePatchOperation::RuleDelete { rule_id } => validate_entity_id(rule_id)?,
            ProfilePatchOperation::GroupAdd { label, member_ids } => {
                validate_label(label)?;
                validate_ids(member_ids)?;
                if member_ids.is_empty() {
                    return Err(ProfilePatchError::InvalidPatch);
                }
            }
            ProfilePatchOperation::GroupMembers {
                group_id,
                member_ids,
            } => {
                validate_entity_id(group_id)?;
                validate_ids(member_ids)?;
                if member_ids.is_empty() {
                    return Err(ProfilePatchError::InvalidPatch);
                }
            }
            ProfilePatchOperation::GroupReorder { group_ids } => validate_ids(group_ids)?,
        }
    }
    Ok(())
}

fn validate_structured_rule(rule: &StructuredRule) -> Result<(), ProfilePatchError> {
    match rule {
        StructuredRule::Match { target_id } => validate_entity_id(target_id),
        StructuredRule::RuleSet {
            provider_id,
            target_id,
            ..
        } => {
            validate_entity_id(provider_id)?;
            validate_entity_id(target_id)
        }
        StructuredRule::Standard {
            no_resolve,
            rule_type,
            target_id,
            value,
        } => {
            validate_entity_id(target_id)?;
            if *no_resolve && !rule_type.supports_no_resolve() {
                return Err(ProfilePatchError::InvalidPatch);
            }
            validate_rule_value(value)
        }
    }
}

fn validate_label(label: &str) -> Result<(), ProfilePatchError> {
    if label.is_empty()
        || label.chars().count() > MAX_LABEL_LENGTH
        || label.chars().any(char::is_control)
    {
        return Err(ProfilePatchError::InvalidPatch);
    }
    Ok(())
}

fn validate_rule_value(value: &str) -> Result<(), ProfilePatchError> {
    if value.is_empty()
        || value.chars().count() > MAX_RULE_VALUE_LENGTH
        || value.contains(',')
        || value.chars().any(char::is_control)
    {
        return Err(ProfilePatchError::InvalidPatch);
    }
    Ok(())
}

fn validate_ids(ids: &[String]) -> Result<(), ProfilePatchError> {
    if ids.len() > 1_024 {
        return Err(ProfilePatchError::InvalidPatch);
    }
    let mut unique = HashSet::new();
    for id in ids {
        validate_entity_id(id)?;
        if !unique.insert(id) {
            return Err(ProfilePatchError::InvalidPatch);
        }
    }
    Ok(())
}

fn validate_entity_id(id: &str) -> Result<(), ProfilePatchError> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(());
    }
    Err(ProfilePatchError::InvalidPatch)
}

fn build_catalog(root: &Mapping) -> Result<PatchCatalog, ProfilePatchError> {
    let mut entities = Vec::new();
    for label in ["DIRECT", "REJECT"] {
        entities.push(CatalogEntity {
            id: entity_id("built-in", label),
            _kind: PatchEntityKind::BuiltIn,
            label: label.to_owned(),
        });
    }
    if let Some(proxies) = sequence(root, "proxies") {
        for proxy in proxies {
            let Some(label) = mapping_string(proxy, "name") else {
                continue;
            };
            entities.push(CatalogEntity {
                id: entity_id("proxy", label),
                _kind: PatchEntityKind::Proxy,
                label: label.to_owned(),
            });
        }
    }
    let group_values = sequence(root, "proxy-groups").unwrap_or(&[]);
    for group in group_values {
        let Some(label) = mapping_string(group, "name") else {
            continue;
        };
        entities.push(CatalogEntity {
            id: entity_id("group", label),
            _kind: PatchEntityKind::PolicyGroup,
            label: label.to_owned(),
        });
    }
    let entity_labels: HashMap<_, _> = entities
        .iter()
        .map(|entity| (entity.id.clone(), entity.label.clone()))
        .collect();
    if entity_labels.len() != entities.len() {
        return Err(ProfilePatchError::GenerationFailed);
    }
    let label_ids: HashMap<_, _> = entities
        .iter()
        .map(|entity| (entity.label.clone(), entity.id.clone()))
        .collect();

    let groups = group_values
        .iter()
        .enumerate()
        .filter_map(|(position, group)| {
            let label = mapping_string(group, "name")?.to_owned();
            let group_type = mapping_string(group, "type").unwrap_or_default();
            let members = group
                .as_mapping()
                .and_then(|mapping| mapping.get(Value::String("proxies".to_owned())))
                .and_then(Value::as_sequence)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .filter_map(|member| label_ids.get(member).cloned())
                        .collect()
                })
                .unwrap_or_default();
            Some(CatalogGroup {
                id: entity_id("group", &label),
                label,
                member_ids: members,
                position,
                supported: matches!(
                    group_type,
                    "select" | "url-test" | "fallback" | "load-balance"
                ) && group.as_mapping().is_some_and(|mapping| {
                    mapping
                        .get(Value::String("proxies".to_owned()))
                        .is_some_and(Value::is_sequence)
                }),
            })
        })
        .collect::<Vec<_>>();
    let group_labels = groups
        .iter()
        .map(|group| (group.id.clone(), group.label.clone()))
        .collect();

    let mut provider_entities = Vec::new();
    if let Some(providers) = mapping(root, "rule-providers") {
        for key in providers.keys().filter_map(Value::as_str) {
            provider_entities.push(CatalogEntity {
                id: entity_id("rule-provider", key),
                _kind: PatchEntityKind::RuleProvider,
                label: key.to_owned(),
            });
        }
    }
    let provider_labels = provider_entities
        .iter()
        .map(|provider| (provider.id.clone(), provider.label.clone()))
        .collect();

    let rules = sequence(root, "rules")
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .filter_map(|(position, value)| {
            let line = value.as_str()?.to_owned();
            let parts: Vec<&str> = line.split(',').collect();
            let source_rule_type = parts.first().copied().unwrap_or_default();
            let supported_rule_type = matches!(
                source_rule_type,
                "DOMAIN"
                    | "DOMAIN-SUFFIX"
                    | "DOMAIN-KEYWORD"
                    | "IP-CIDR"
                    | "IP-CIDR6"
                    | "GEOIP"
                    | "GEOSITE"
                    | "PROCESS-NAME"
                    | "RULE-SET"
                    | "MATCH"
            );
            let rule_type = if supported_rule_type {
                source_rule_type
            } else {
                "OTHER"
            }
            .to_owned();
            let candidate_target = if source_rule_type == "MATCH" {
                parts.get(1).copied()
            } else if supported_rule_type {
                parts.get(2).copied()
            } else {
                None
            };
            let target = candidate_target
                .filter(|label| label_ids.contains_key(*label))
                .unwrap_or("unavailable")
                .to_owned();
            Some(CatalogRule {
                id: rule_id(&line, position),
                line,
                position,
                rule_type,
                target,
            })
        })
        .collect();
    entities.extend(provider_entities);
    Ok(PatchCatalog {
        entity_labels,
        group_labels,
        groups,
        provider_labels,
        rules,
    })
}

fn evaluate_patches(
    patches: &[ProfilePatch],
    catalog: &PatchCatalog,
    bound: bool,
) -> Vec<EvaluatedPatch> {
    if !bound {
        return patches
            .iter()
            .map(|patch| EvaluatedPatch {
                activation_impact: PatchActivationImpact::BlocksActivation,
                code: PatchValidationCode::RevisionMismatch,
                result: PatchValidationResult::Stale,
                target: patch_target(patch, catalog),
            })
            .collect();
    }
    let mut rule_targets = HashSet::new();
    let mut group_targets = HashSet::new();
    let mut added_labels = HashSet::new();
    let source_labels: HashSet<_> = catalog
        .groups
        .iter()
        .map(|group| group.label.as_str())
        .collect();
    let expected_group_order: HashSet<_> = catalog
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();
    let group_members_conflict = resulting_group_graph_has_cycle(patches, catalog);
    let mut reorder_seen = false;
    patches
        .iter()
        .map(|patch| {
            let target = patch_target(patch, catalog);
            let (result, code, impact) = match &patch.operation {
                ProfilePatchOperation::RuleInsert { rule, .. } => {
                    match validate_rule_references(rule, catalog) {
                        Ok(()) => (
                            PatchValidationResult::Valid,
                            PatchValidationCode::Valid,
                            PatchActivationImpact::InsertRule,
                        ),
                        Err(code) => (
                            PatchValidationResult::Stale,
                            code,
                            PatchActivationImpact::BlocksActivation,
                        ),
                    }
                }
                ProfilePatchOperation::RuleDisable { rule_id }
                | ProfilePatchOperation::RuleDelete { rule_id } => {
                    if !catalog.rules.iter().any(|rule| rule.id == *rule_id) {
                        (
                            PatchValidationResult::Stale,
                            PatchValidationCode::TargetMissing,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else if !rule_targets.insert(rule_id.as_str()) {
                        (
                            PatchValidationResult::Invalid,
                            PatchValidationCode::DuplicateTarget,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else {
                        (
                            PatchValidationResult::Valid,
                            PatchValidationCode::Valid,
                            PatchActivationImpact::ExcludeRule,
                        )
                    }
                }
                ProfilePatchOperation::GroupAdd { label, member_ids } => {
                    if source_labels.contains(label.as_str())
                        || !added_labels.insert(label.as_str())
                    {
                        (
                            PatchValidationResult::Invalid,
                            PatchValidationCode::DuplicateLabel,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else if !all_entities_exist(member_ids, catalog) {
                        (
                            PatchValidationResult::Stale,
                            PatchValidationCode::UnsafeReference,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else {
                        (
                            PatchValidationResult::Valid,
                            PatchValidationCode::Valid,
                            PatchActivationImpact::AddGroup,
                        )
                    }
                }
                ProfilePatchOperation::GroupMembers {
                    group_id,
                    member_ids,
                } => {
                    let Some(group) = catalog.groups.iter().find(|group| group.id == *group_id)
                    else {
                        return EvaluatedPatch {
                            activation_impact: PatchActivationImpact::BlocksActivation,
                            code: PatchValidationCode::TargetMissing,
                            result: PatchValidationResult::Stale,
                            target,
                        };
                    };
                    if !group.supported || (patch.enabled && group_members_conflict) {
                        (
                            PatchValidationResult::Invalid,
                            PatchValidationCode::SemanticConflict,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else if !group_targets.insert(group_id.as_str()) {
                        (
                            PatchValidationResult::Invalid,
                            PatchValidationCode::DuplicateTarget,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else if !all_entities_exist(member_ids, catalog) {
                        (
                            PatchValidationResult::Stale,
                            PatchValidationCode::UnsafeReference,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else {
                        (
                            PatchValidationResult::Valid,
                            PatchValidationCode::Valid,
                            PatchActivationImpact::ReplaceGroupMembers,
                        )
                    }
                }
                ProfilePatchOperation::GroupReorder { group_ids } => {
                    let actual: HashSet<_> = group_ids.iter().map(String::as_str).collect();
                    if reorder_seen
                        || actual != expected_group_order
                        || group_ids.len() != expected_group_order.len()
                    {
                        (
                            PatchValidationResult::Invalid,
                            PatchValidationCode::InvalidOrder,
                            PatchActivationImpact::BlocksActivation,
                        )
                    } else {
                        reorder_seen = true;
                        (
                            PatchValidationResult::Valid,
                            PatchValidationCode::Valid,
                            PatchActivationImpact::ReorderGroups,
                        )
                    }
                }
            };
            EvaluatedPatch {
                activation_impact: impact,
                code,
                result,
                target,
            }
        })
        .collect()
}

fn resulting_group_graph_has_cycle(patches: &[ProfilePatch], catalog: &PatchCatalog) -> bool {
    let group_ids: HashSet<_> = catalog
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();
    let mut members: HashMap<&str, Vec<&str>> = catalog
        .groups
        .iter()
        .map(|group| {
            (
                group.id.as_str(),
                group
                    .member_ids
                    .iter()
                    .map(String::as_str)
                    .filter(|member| group_ids.contains(member))
                    .collect(),
            )
        })
        .collect();
    for patch in patches.iter().filter(|patch| patch.enabled) {
        if let ProfilePatchOperation::GroupMembers {
            group_id,
            member_ids,
        } = &patch.operation
        {
            members.insert(
                group_id.as_str(),
                member_ids
                    .iter()
                    .map(String::as_str)
                    .filter(|member| group_ids.contains(member))
                    .collect(),
            );
        }
    }

    fn visit<'a>(
        id: &'a str,
        members: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> bool {
        if visiting.contains(id) {
            return true;
        }
        if !visited.insert(id) {
            return false;
        }
        visiting.insert(id);
        let cycle = members.get(id).is_some_and(|children| {
            children
                .iter()
                .any(|child| visit(child, members, visiting, visited))
        });
        visiting.remove(id);
        cycle
    }

    let mut visited = HashSet::new();
    members.keys().copied().any(|id| {
        let mut visiting = HashSet::new();
        visit(id, &members, &mut visiting, &mut visited)
    })
}

fn validate_rule_references(
    rule: &StructuredRule,
    catalog: &PatchCatalog,
) -> Result<(), PatchValidationCode> {
    let target_id = match rule {
        StructuredRule::Match { target_id }
        | StructuredRule::RuleSet { target_id, .. }
        | StructuredRule::Standard { target_id, .. } => target_id,
    };
    if !catalog.entity_labels.contains_key(target_id) {
        return Err(PatchValidationCode::UnsafeReference);
    }
    if let StructuredRule::RuleSet { provider_id, .. } = rule
        && !catalog.provider_labels.contains_key(provider_id)
    {
        return Err(PatchValidationCode::UnsafeReference);
    }
    Ok(())
}

fn all_entities_exist(ids: &[String], catalog: &PatchCatalog) -> bool {
    ids.iter().all(|id| catalog.entity_labels.contains_key(id))
}

fn patch_target(patch: &ProfilePatch, catalog: &PatchCatalog) -> String {
    match &patch.operation {
        ProfilePatchOperation::RuleInsert { position, .. } => match position {
            RuleInsertPosition::Prefix => "Rules · prefix".to_owned(),
            RuleInsertPosition::Suffix => "Rules · suffix".to_owned(),
        },
        ProfilePatchOperation::RuleDisable { rule_id }
        | ProfilePatchOperation::RuleDelete { rule_id } => catalog
            .rules
            .iter()
            .find(|rule| rule.id == *rule_id)
            .map(|rule| {
                format!(
                    "Rule {} · {} → {}",
                    rule.position + 1,
                    rule.rule_type,
                    rule.target
                )
            })
            .unwrap_or_else(|| "Rule · unavailable".to_owned()),
        ProfilePatchOperation::GroupAdd { label, .. } => label.clone(),
        ProfilePatchOperation::GroupMembers { group_id, .. } => catalog
            .group_labels
            .get(group_id)
            .cloned()
            .unwrap_or_else(|| "Policy group · unavailable".to_owned()),
        ProfilePatchOperation::GroupReorder { .. } => "Policy groups".to_owned(),
    }
}

fn apply_rule_patches(
    root: &mut Mapping,
    catalog: &PatchCatalog,
    patches: &[ProfilePatch],
) -> Result<(), ProfilePatchError> {
    let mut excluded = HashSet::new();
    let mut prefix = Vec::new();
    let mut suffix = Vec::new();
    for patch in patches.iter().filter(|patch| patch.enabled) {
        match &patch.operation {
            ProfilePatchOperation::RuleDisable { rule_id }
            | ProfilePatchOperation::RuleDelete { rule_id } => {
                excluded.insert(rule_id.as_str());
            }
            ProfilePatchOperation::RuleInsert { position, rule } => {
                let line = serialize_rule(rule, catalog)?;
                match position {
                    RuleInsertPosition::Prefix => prefix.push(Value::String(line)),
                    RuleInsertPosition::Suffix => suffix.push(Value::String(line)),
                }
            }
            _ => {}
        }
    }
    if excluded.is_empty() && prefix.is_empty() && suffix.is_empty() {
        return Ok(());
    }
    let mut values = prefix;
    values.extend(
        catalog
            .rules
            .iter()
            .filter(|rule| !excluded.contains(rule.id.as_str()))
            .map(|rule| Value::String(rule.line.clone())),
    );
    values.extend(suffix);
    root.insert(Value::String("rules".to_owned()), Value::Sequence(values));
    Ok(())
}

fn serialize_rule(
    rule: &StructuredRule,
    catalog: &PatchCatalog,
) -> Result<String, ProfilePatchError> {
    let target = |id: &str| {
        catalog
            .entity_labels
            .get(id)
            .cloned()
            .ok_or(ProfilePatchError::ValidationFailed)
    };
    match rule {
        StructuredRule::Match { target_id } => Ok(format!("MATCH,{}", target(target_id)?)),
        StructuredRule::RuleSet {
            no_resolve,
            provider_id,
            target_id,
        } => {
            let provider = catalog
                .provider_labels
                .get(provider_id)
                .ok_or(ProfilePatchError::ValidationFailed)?;
            Ok(format!(
                "RULE-SET,{provider},{}{}",
                target(target_id)?,
                if *no_resolve { ",no-resolve" } else { "" }
            ))
        }
        StructuredRule::Standard {
            no_resolve,
            rule_type,
            target_id,
            value,
        } => Ok(format!(
            "{},{value},{}{}",
            rule_type.mihomo_name(),
            target(target_id)?,
            if *no_resolve { ",no-resolve" } else { "" }
        )),
    }
}

fn apply_group_patches(
    root: &mut Mapping,
    catalog: &PatchCatalog,
    patches: &[ProfilePatch],
) -> Result<(), ProfilePatchError> {
    let key = Value::String("proxy-groups".to_owned());
    let mut groups = root
        .get(&key)
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let source_by_id: HashMap<_, _> = catalog
        .groups
        .iter()
        .map(|group| (group.id.clone(), group.position))
        .collect();
    let mut added = Vec::new();
    let mut reorder: Option<&Vec<String>> = None;
    for patch in patches.iter().filter(|patch| patch.enabled) {
        match &patch.operation {
            ProfilePatchOperation::GroupAdd { label, member_ids } => {
                let members = member_labels(member_ids, catalog)?;
                let mut mapping = Mapping::new();
                mapping.insert(
                    Value::String("name".to_owned()),
                    Value::String(label.clone()),
                );
                mapping.insert(
                    Value::String("type".to_owned()),
                    Value::String("select".to_owned()),
                );
                mapping.insert(
                    Value::String("proxies".to_owned()),
                    Value::Sequence(members),
                );
                added.push(Value::Mapping(mapping));
            }
            ProfilePatchOperation::GroupMembers {
                group_id,
                member_ids,
            } => {
                let position = source_by_id
                    .get(group_id)
                    .ok_or(ProfilePatchError::ValidationFailed)?;
                let mapping = groups
                    .get_mut(*position)
                    .and_then(Value::as_mapping_mut)
                    .ok_or(ProfilePatchError::GenerationFailed)?;
                mapping.insert(
                    Value::String("proxies".to_owned()),
                    Value::Sequence(member_labels(member_ids, catalog)?),
                );
            }
            ProfilePatchOperation::GroupReorder { group_ids } => reorder = Some(group_ids),
            _ => {}
        }
    }
    if let Some(group_ids) = reorder {
        groups = group_ids
            .iter()
            .map(|id| {
                source_by_id
                    .get(id)
                    .and_then(|position| groups.get(*position))
                    .cloned()
                    .ok_or(ProfilePatchError::ValidationFailed)
            })
            .collect::<Result<Vec<_>, _>>()?;
    }
    groups.extend(added);
    root.insert(key, Value::Sequence(groups));
    Ok(())
}

fn member_labels(ids: &[String], catalog: &PatchCatalog) -> Result<Vec<Value>, ProfilePatchError> {
    ids.iter()
        .map(|id| {
            catalog
                .entity_labels
                .get(id)
                .cloned()
                .map(Value::String)
                .ok_or(ProfilePatchError::ValidationFailed)
        })
        .collect()
}

fn entity_id(kind: &str, label: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{kind}\0{label}").as_bytes())
    )
}

fn rule_id(line: &str, position: usize) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("rule\0{position}\0{line}").as_bytes())
    )
}

fn sequence<'a>(root: &'a Mapping, key: &str) -> Option<&'a [Value]> {
    root.get(Value::String(key.to_owned()))
        .and_then(Value::as_sequence)
        .map(Vec::as_slice)
}

fn mapping<'a>(root: &'a Mapping, key: &str) -> Option<&'a Mapping> {
    root.get(Value::String(key.to_owned()))
        .and_then(Value::as_mapping)
}

fn mapping_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .as_mapping()?
        .get(Value::String(key.to_owned()))?
        .as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &[u8] = br#"proxies:
  - name: node-a
    type: direct
proxy-groups:
  - name: Primary
    type: select
    proxies: [node-a, DIRECT]
  - name: Nested
    type: select
    proxies: [Primary]
rule-providers:
  private-rules:
    type: http
    behavior: domain
    url: https://example.invalid/rules
rules:
  - DOMAIN,old.example,Primary
  - MATCH,DIRECT
"#;

    fn authority() -> (RevisionId, Fingerprint) {
        (
            RevisionId::from_source(SOURCE),
            Fingerprint::from_normalized_artifact(SOURCE),
        )
    }

    fn patch(operation: ProfilePatchOperation) -> ProfilePatch {
        ProfilePatch {
            enabled: true,
            id: Uuid::new_v4().to_string(),
            operation,
        }
    }

    #[test]
    fn ordered_rule_patches_and_unicode_groups_round_trip() {
        let (revision, fingerprint) = authority();
        let direct = entity_id("built-in", "DIRECT");
        let source_rule = rule_id("DOMAIN,old.example,Primary", 0);
        let primary = entity_id("group", "Primary");
        let nested = entity_id("group", "Nested");
        let patches = vec![
            patch(ProfilePatchOperation::RuleInsert {
                position: RuleInsertPosition::Prefix,
                rule: StructuredRule::Standard {
                    no_resolve: false,
                    rule_type: CommonRuleType::DomainSuffix,
                    target_id: direct.clone(),
                    value: "first.example".to_owned(),
                },
            }),
            patch(ProfilePatchOperation::RuleDelete {
                rule_id: source_rule,
            }),
            patch(ProfilePatchOperation::RuleInsert {
                position: RuleInsertPosition::Suffix,
                rule: StructuredRule::Match {
                    target_id: direct.clone(),
                },
            }),
            patch(ProfilePatchOperation::GroupMembers {
                group_id: nested.clone(),
                member_ids: vec![direct.clone()],
            }),
            patch(ProfilePatchOperation::GroupReorder {
                group_ids: vec![nested, primary],
            }),
            patch(ProfilePatchOperation::GroupAdd {
                label: "研发组 🛰️".to_owned(),
                member_ids: vec![direct],
            }),
        ];
        let (patch_set, applied) =
            bind_and_apply_profile_patches(SOURCE, &revision, &fingerprint, patches).unwrap();
        let document: Value = serde_norway::from_slice(&applied.bytes).unwrap();
        let root = document.as_mapping().unwrap();
        let rules = sequence(root, "rules").unwrap();
        assert_eq!(
            rules[0].as_str(),
            Some("DOMAIN-SUFFIX,first.example,DIRECT")
        );
        assert_eq!(rules[1].as_str(), Some("MATCH,DIRECT"));
        assert_eq!(rules[2].as_str(), Some("MATCH,DIRECT"));
        let groups = sequence(root, "proxy-groups").unwrap();
        assert_eq!(mapping_string(&groups[0], "name"), Some("Nested"));
        assert_eq!(mapping_string(&groups[1], "name"), Some("Primary"));
        assert_eq!(
            sequence(groups[0].as_mapping().unwrap(), "proxies").unwrap()[0].as_str(),
            Some("DIRECT")
        );
        assert_eq!(
            mapping_string(groups.last().unwrap(), "name"),
            Some("研发组 🛰️")
        );

        let encoded = serde_json::to_vec(&patch_set).unwrap();
        let decoded: ProfilePatchSet = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, patch_set);
        assert_eq!(
            apply_profile_patches(SOURCE, &revision, &fingerprint, &decoded)
                .unwrap()
                .bytes,
            applied.bytes
        );
    }

    #[test]
    fn conflicting_rule_targets_and_group_cycles_block_activation() {
        let (revision, fingerprint) = authority();
        let rule_id = rule_id("DOMAIN,old.example,Primary", 0);
        let primary = entity_id("group", "Primary");
        let nested = entity_id("group", "Nested");
        let patch_set = ProfilePatchSet {
            effective_fingerprint: fingerprint.clone(),
            patches: vec![
                patch(ProfilePatchOperation::RuleDisable {
                    rule_id: rule_id.clone(),
                }),
                patch(ProfilePatchOperation::RuleDelete { rule_id }),
                patch(ProfilePatchOperation::GroupMembers {
                    group_id: primary,
                    member_ids: vec![nested],
                }),
            ],
            schema_version: PROFILE_PATCH_SCHEMA_VERSION,
            source_fingerprint: fingerprint.clone(),
            source_revision: revision.clone(),
        };
        assert_eq!(
            apply_profile_patches(SOURCE, &revision, &fingerprint, &patch_set),
            Err(ProfilePatchError::ValidationFailed)
        );
    }

    #[test]
    fn revision_binding_marks_every_patch_stale_without_rewriting_it() {
        let (revision, fingerprint) = authority();
        let original = patch(ProfilePatchOperation::RuleInsert {
            position: RuleInsertPosition::Prefix,
            rule: StructuredRule::Match {
                target_id: entity_id("built-in", "DIRECT"),
            },
        });
        let (patch_set, _) =
            bind_and_apply_profile_patches(SOURCE, &revision, &fingerprint, vec![original.clone()])
                .unwrap();
        let next_source = [SOURCE, b"# refreshed\n"].concat();
        let next_revision = RevisionId::from_source(&next_source);
        let next_fingerprint = Fingerprint::from_normalized_artifact(&next_source);
        assert_eq!(
            apply_profile_patches(&next_source, &next_revision, &next_fingerprint, &patch_set),
            Err(ProfilePatchError::StaleAuthority)
        );
        assert_eq!(patch_set.patches, vec![original]);
    }
}
