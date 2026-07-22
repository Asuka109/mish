use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_norway::{Mapping, Value};
use sha2::{Digest, Sha256};

use crate::{ProfilePatchError, ProfileRecord, apply_profile_patches};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileRouteGroupKind {
    Selector,
    UrlTest,
    Fallback,
    LoadBalance,
    Relay,
    Direct,
    Reject,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRouteGroup {
    pub child_ids: Vec<String>,
    pub id: String,
    pub label: String,
    pub selected_child_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: ProfileRouteGroupKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRouteNode {
    pub id: String,
    pub label: String,
    pub latency_milliseconds: Option<u16>,
    pub protocol: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileRouteMode {
    Rule,
    Global,
    Direct,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRouteCatalog {
    pub fingerprint: String,
    pub groups: Vec<ProfileRouteGroup>,
    pub nodes: Vec<ProfileRouteNode>,
    pub profile_id: String,
    pub routing_mode: ProfileRouteMode,
}

pub fn profile_route_catalog(
    record: &ProfileRecord,
) -> Result<ProfileRouteCatalog, ProfilePatchError> {
    profile_route_catalog_with_selections(record, &HashMap::new())
}

pub fn profile_route_catalog_with_selections(
    record: &ProfileRecord,
    selections: &HashMap<String, String>,
) -> Result<ProfileRouteCatalog, ProfilePatchError> {
    let applied = apply_profile_patches(
        &record.normalized_bytes,
        &record.metadata.revision.id,
        &record.metadata.artifact.fingerprint,
        &record.patches,
    )?;
    profile_route_catalog_from_bytes(
        record.metadata.id.as_str(),
        applied.effective_fingerprint.as_str(),
        &applied.bytes,
        selections,
    )
}

pub fn profile_store_selected(record: &ProfileRecord) -> Result<bool, ProfilePatchError> {
    let applied = apply_profile_patches(
        &record.normalized_bytes,
        &record.metadata.revision.id,
        &record.metadata.artifact.fingerprint,
        &record.patches,
    )?;
    let document: Value = serde_norway::from_slice(&applied.bytes)
        .map_err(|_| ProfilePatchError::GenerationFailed)?;
    let root = document
        .as_mapping()
        .ok_or(ProfilePatchError::GenerationFailed)?;
    Ok(mapping_value(root, "profile")
        .and_then(Value::as_mapping)
        .and_then(|profile| mapping_value(profile, "store-selected"))
        .and_then(Value::as_bool)
        .unwrap_or(true))
}

pub fn configured_policy_group_order(bytes: &[u8]) -> Result<Vec<String>, ProfilePatchError> {
    let document: Value =
        serde_norway::from_slice(bytes).map_err(|_| ProfilePatchError::GenerationFailed)?;
    let root = document
        .as_mapping()
        .ok_or(ProfilePatchError::GenerationFailed)?;
    Ok(sequence(root, "proxy-groups")
        .unwrap_or_default()
        .iter()
        .filter_map(|group| mapping_string(group, "name"))
        .map(str::to_owned)
        .collect())
}

fn profile_route_catalog_from_bytes(
    profile_id: &str,
    fingerprint: &str,
    bytes: &[u8],
    selections: &HashMap<String, String>,
) -> Result<ProfileRouteCatalog, ProfilePatchError> {
    let document: Value =
        serde_norway::from_slice(bytes).map_err(|_| ProfilePatchError::GenerationFailed)?;
    let root = document
        .as_mapping()
        .ok_or(ProfilePatchError::GenerationFailed)?;
    let proxy_values = sequence(root, "proxies").unwrap_or_default();
    let group_values = sequence(root, "proxy-groups").unwrap_or_default();

    let mut ids_by_label = HashMap::new();
    for label in ["DIRECT", "REJECT"] {
        insert_entity_id(&mut ids_by_label, "proxy", fingerprint, label)?;
    }
    for proxy in proxy_values {
        let Some(label) = mapping_string(proxy, "name") else {
            continue;
        };
        insert_entity_id(&mut ids_by_label, "proxy", fingerprint, label)?;
    }
    for group in group_values {
        let Some(label) = mapping_string(group, "name") else {
            continue;
        };
        insert_entity_id(&mut ids_by_label, "group", fingerprint, label)?;
    }

    let mut nodes = vec![
        route_node(&ids_by_label, "DIRECT", "Direct")?,
        route_node(&ids_by_label, "REJECT", "Reject")?,
    ];
    for proxy in proxy_values {
        let Some(label) = mapping_string(proxy, "name") else {
            continue;
        };
        let protocol = mapping_string(proxy, "type").unwrap_or("Proxy");
        nodes.push(route_node(&ids_by_label, label, protocol)?);
    }

    let group_labels: HashSet<&str> = group_values
        .iter()
        .filter_map(|group| mapping_string(group, "name"))
        .collect();
    let mut unresolved_labels = Vec::new();
    let mut groups = Vec::with_capacity(group_values.len());
    for group in group_values {
        let Some(label) = mapping_string(group, "name") else {
            continue;
        };
        let source_type = mapping_string(group, "type").unwrap_or("unsupported");
        let (kind, unsupported_type) = map_group_kind(source_type);
        let child_labels = group
            .as_mapping()
            .and_then(|mapping| sequence(mapping, "proxies"))
            .unwrap_or_default();
        let mut child_ids = Vec::with_capacity(child_labels.len());
        for child in child_labels.iter().filter_map(Value::as_str) {
            let child_kind = if group_labels.contains(child) {
                "group"
            } else {
                "proxy"
            };
            if !ids_by_label.contains_key(child) {
                insert_entity_id(&mut ids_by_label, child_kind, fingerprint, child)?;
                unresolved_labels.push(child.to_owned());
            }
            child_ids.push(
                ids_by_label
                    .get(child)
                    .expect("every configured route child received an identifier")
                    .clone(),
            );
        }
        let selected_child_id = selections
            .get(label)
            .and_then(|selected| {
                child_labels
                    .iter()
                    .filter_map(Value::as_str)
                    .position(|child| child == selected)
            })
            .and_then(|index| child_ids.get(index).cloned())
            .or_else(|| child_ids.first().cloned());
        groups.push(ProfileRouteGroup {
            selected_child_id,
            child_ids,
            id: ids_by_label
                .get(label)
                .expect("every configured group received an identifier")
                .clone(),
            kind,
            label: label.to_owned(),
            unsupported_type,
        });
    }
    for label in unresolved_labels {
        nodes.push(route_node(&ids_by_label, &label, "Configured")?);
    }

    Ok(ProfileRouteCatalog {
        fingerprint: fingerprint.to_owned(),
        groups,
        nodes,
        profile_id: profile_id.to_owned(),
        routing_mode: match mapping_value(root, "mode").and_then(Value::as_str) {
            Some(mode) if mode.eq_ignore_ascii_case("global") => ProfileRouteMode::Global,
            Some(mode) if mode.eq_ignore_ascii_case("direct") => ProfileRouteMode::Direct,
            _ => ProfileRouteMode::Rule,
        },
    })
}

fn insert_entity_id(
    ids_by_label: &mut HashMap<String, String>,
    kind: &str,
    fingerprint: &str,
    label: &str,
) -> Result<(), ProfilePatchError> {
    if ids_by_label.contains_key(label) {
        return Err(ProfilePatchError::GenerationFailed);
    }
    ids_by_label.insert(
        label.to_owned(),
        scoped_identifier(kind, fingerprint, label),
    );
    Ok(())
}

fn route_node(
    ids_by_label: &HashMap<String, String>,
    label: &str,
    protocol: &str,
) -> Result<ProfileRouteNode, ProfilePatchError> {
    Ok(ProfileRouteNode {
        id: ids_by_label
            .get(label)
            .ok_or(ProfilePatchError::GenerationFailed)?
            .clone(),
        label: label.to_owned(),
        latency_milliseconds: None,
        protocol: protocol.to_owned(),
    })
}

fn map_group_kind(source_type: &str) -> (ProfileRouteGroupKind, Option<String>) {
    let kind = match source_type.to_ascii_lowercase().as_str() {
        "select" | "selector" => ProfileRouteGroupKind::Selector,
        "url-test" | "urltest" => ProfileRouteGroupKind::UrlTest,
        "fallback" => ProfileRouteGroupKind::Fallback,
        "load-balance" | "loadbalance" => ProfileRouteGroupKind::LoadBalance,
        "relay" => ProfileRouteGroupKind::Relay,
        "direct" => ProfileRouteGroupKind::Direct,
        "reject" => ProfileRouteGroupKind::Reject,
        _ => ProfileRouteGroupKind::Unsupported,
    };
    let unsupported = (kind == ProfileRouteGroupKind::Unsupported).then(|| source_type.to_owned());
    (kind, unsupported)
}

fn scoped_identifier(kind: &str, fingerprint: &str, identity: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(kind.as_bytes());
    digest.update(b"\0");
    digest.update(fingerprint.as_bytes());
    digest.update(b"\0");
    digest.update(identity.as_bytes());
    format!("{kind}:{:x}", digest.finalize())
}

fn sequence<'a>(root: &'a Mapping, key: &str) -> Option<&'a [Value]> {
    mapping_value(root, key)
        .and_then(Value::as_sequence)
        .map(Vec::as_slice)
}

fn mapping_value<'a>(root: &'a Mapping, key: &str) -> Option<&'a Value> {
    root.get(Value::String(key.to_owned()))
}

fn mapping_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .as_mapping()
        .and_then(|mapping| mapping_value(mapping, key))
        .and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_catalog_preserves_group_and_member_order() {
        let catalog = profile_route_catalog_from_bytes(
            "profile-a",
            "fingerprint-a",
            br#"
mode: global
proxies:
  - name: node-z
    type: ss
  - name: node-a
    type: trojan
proxy-groups:
  - name: Z first
    type: select
    proxies: [node-z, node-a]
  - name: A second
    type: url-test
    proxies: [node-a, node-z]
"#,
            &HashMap::new(),
        )
        .unwrap();

        assert_eq!(catalog.routing_mode, ProfileRouteMode::Global);
        assert_eq!(
            catalog
                .groups
                .iter()
                .map(|group| group.label.as_str())
                .collect::<Vec<_>>(),
            ["Z first", "A second"]
        );
        assert_eq!(
            catalog.groups[0].selected_child_id,
            Some(scoped_identifier("proxy", "fingerprint-a", "node-z"))
        );
        let labels_by_id: HashMap<_, _> = catalog
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node.label.as_str()))
            .collect();
        assert_eq!(
            catalog.groups[0]
                .child_ids
                .iter()
                .map(|id| labels_by_id[id.as_str()])
                .collect::<Vec<_>>(),
            ["node-z", "node-a"]
        );
    }

    #[test]
    fn configured_catalog_keeps_unresolved_explicit_members_visible() {
        let catalog = profile_route_catalog_from_bytes(
            "profile-a",
            "fingerprint-a",
            br#"
proxy-groups:
  - name: Select
    type: select
    proxies: [provider-node]
"#,
            &HashMap::new(),
        )
        .unwrap();

        assert!(
            catalog
                .nodes
                .iter()
                .any(|node| { node.label == "provider-node" && node.protocol == "Configured" })
        );
    }

    #[test]
    fn configured_catalog_prefers_valid_saved_selection() {
        let selections = HashMap::from([("Select".to_owned(), "node-b".to_owned())]);
        let catalog = profile_route_catalog_from_bytes(
            "profile-a",
            "fingerprint-a",
            br#"
proxies:
  - name: node-a
    type: ss
  - name: node-b
    type: trojan
proxy-groups:
  - name: Select
    type: select
    proxies: [node-a, node-b]
"#,
            &selections,
        )
        .unwrap();

        assert_eq!(
            catalog.groups[0].selected_child_id,
            Some(scoped_identifier("proxy", "fingerprint-a", "node-b"))
        );
    }

    #[test]
    fn configured_catalog_ignores_stale_saved_selection() {
        let selections = HashMap::from([("Select".to_owned(), "removed-node".to_owned())]);
        let catalog = profile_route_catalog_from_bytes(
            "profile-a",
            "fingerprint-a",
            br#"
proxies:
  - name: node-a
    type: ss
proxy-groups:
  - name: Select
    type: select
    proxies: [node-a]
"#,
            &selections,
        )
        .unwrap();

        assert_eq!(
            catalog.groups[0].selected_child_id,
            Some(scoped_identifier("proxy", "fingerprint-a", "node-a"))
        );
    }
}
