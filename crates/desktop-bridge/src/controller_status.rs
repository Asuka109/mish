use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use mish_mihomo_controller::{
    Connection, ConnectionSnapshot, MemorySnapshot, ProxyCatalog,
    RoutingMode as ControllerRoutingMode, Rule, RuleList, RuntimeConfig,
    TrafficSnapshot as ControllerTrafficSnapshot,
};
use mish_runtime::{
    CoreStatus, EffectiveRule, GroupDelayPolicy, GroupDelayTest, GroupUsage, PolicyGroup,
    PolicyGroupKind, ProfileSummary, ProxyNode, RoutingMode, RuntimeMetrics,
    STATUS_TRAFFIC_SERIES_LIMIT, StatusAdapterKind, StatusSnapshot, TrafficConnection,
    TrafficDataPhase, TrafficDataSnapshot, TrafficMatchedRule, TrafficSnapshot,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

const DEFAULT_SEEN_CONNECTION_LIMIT: usize = 65_536;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileMappingContext {
    policy_group_order: Vec<String>,
    profile_id: String,
    profile_fingerprint: String,
    profile_label: String,
}

impl ProfileMappingContext {
    pub fn new(
        profile_id: impl Into<String>,
        profile_fingerprint: impl Into<String>,
        profile_label: impl Into<String>,
    ) -> Result<Self, StatusMappingError> {
        let context = Self {
            policy_group_order: Vec::new(),
            profile_id: profile_id.into(),
            profile_fingerprint: profile_fingerprint.into(),
            profile_label: profile_label.into(),
        };
        if context.profile_id.is_empty() {
            return Err(StatusMappingError::InvalidContext {
                field: "profile_id",
            });
        }
        if context.profile_fingerprint.is_empty() {
            return Err(StatusMappingError::InvalidContext {
                field: "profile_fingerprint",
            });
        }
        Ok(context)
    }

    pub fn with_policy_group_order(mut self, policy_group_order: Vec<String>) -> Self {
        self.policy_group_order = policy_group_order;
        self
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn profile_fingerprint(&self) -> &str {
        &self.profile_fingerprint
    }

    pub fn profile_label(&self) -> &str {
        &self.profile_label
    }

    pub fn policy_group_order(&self) -> &[String] {
        &self.policy_group_order
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StatusRetentionPolicy {
    pub max_traffic_samples: usize,
    pub max_seen_connection_ids: usize,
}

impl Default for StatusRetentionPolicy {
    fn default() -> Self {
        Self {
            max_traffic_samples: STATUS_TRAFFIC_SERIES_LIMIT,
            max_seen_connection_ids: DEFAULT_SEEN_CONNECTION_LIMIT,
        }
    }
}

impl StatusRetentionPolicy {
    fn validate(self) -> Result<Self, StatusMappingError> {
        if self.max_traffic_samples == 0 || self.max_traffic_samples > STATUS_TRAFFIC_SERIES_LIMIT {
            return Err(StatusMappingError::InvalidRetention {
                field: "max_traffic_samples",
                maximum: STATUS_TRAFFIC_SERIES_LIMIT,
            });
        }
        if self.max_seen_connection_ids == 0 {
            return Err(StatusMappingError::InvalidRetention {
                field: "max_seen_connection_ids",
                maximum: usize::MAX,
            });
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ControllerObservationBatch {
    pub runtime_config: Option<RuntimeConfig>,
    pub proxies: Option<ProxyCatalog>,
    pub traffic: Option<ControllerTrafficSnapshot>,
    pub memory: Option<MemorySnapshot>,
    pub connections: Option<ConnectionSnapshot>,
    pub rules: Option<RuleList>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum StatusMappingError {
    #[error("mapping context field {field} must not be empty")]
    InvalidContext { field: &'static str },
    #[error("retention field {field} must be between 1 and {maximum}")]
    InvalidRetention { field: &'static str, maximum: usize },
    #[error("Mihomo traffic field {field} must be non-negative, received {value}")]
    NegativeTrafficValue { field: &'static str, value: i64 },
    #[error(
        "Mihomo connection {connection:?} field {field} must be non-negative, received {value}"
    )]
    NegativeConnectionValue {
        connection: String,
        field: &'static str,
        value: i64,
    },
    #[error("a {observation} observation is required before producing Status")]
    MissingRequiredObservation { observation: &'static str },
    #[error("policy group {group:?} has no selected child")]
    MissingSelection { group: String },
    #[error("policy group {group:?} contains duplicate child {child:?}")]
    DuplicateChild { group: String, child: String },
    #[error("policy group {group:?} references unknown child {child:?}")]
    UnknownChild { group: String, child: String },
    #[error("policy group {group:?} selects {selected:?}, which is not one of its children")]
    SelectionOutsideGroup { group: String, selected: String },
    #[error("derived Status identifier collision between {first:?} and {second:?}")]
    IdentifierCollision { first: String, second: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectionTargetError {
    GroupNotFound,
    UnsupportedGroup,
    ChildNotFound,
    ChildOutsideGroup,
}

#[derive(Clone, Debug, Default)]
struct MappedCatalog {
    groups: Vec<PolicyGroup>,
    nodes: Vec<ProxyNode>,
    group_ids_by_label: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct ControllerStatusMapper {
    context: ProfileMappingContext,
    retention: StatusRetentionPolicy,
    routing_mode: Option<RoutingMode>,
    catalog: Option<MappedCatalog>,
    traffic: TrafficSnapshot,
    memory_bytes: u64,
    active_connections: Vec<TrafficConnection>,
    effective_rules: Vec<EffectiveRule>,
    group_counts_by_id: HashMap<String, u64>,
    seen_connection_ids: HashSet<String>,
    seen_connection_order: VecDeque<String>,
}

impl ControllerStatusMapper {
    pub fn new(context: ProfileMappingContext) -> Self {
        Self::with_retention(context, StatusRetentionPolicy::default())
            .expect("default Status retention policy must be valid")
    }

    pub fn with_retention(
        context: ProfileMappingContext,
        retention: StatusRetentionPolicy,
    ) -> Result<Self, StatusMappingError> {
        Ok(Self {
            context,
            retention: retention.validate()?,
            routing_mode: None,
            catalog: None,
            traffic: TrafficSnapshot::default(),
            memory_bytes: 0,
            active_connections: Vec::new(),
            effective_rules: Vec::new(),
            group_counts_by_id: HashMap::new(),
            seen_connection_ids: HashSet::new(),
            seen_connection_order: VecDeque::new(),
        })
    }

    pub fn apply(
        &mut self,
        observations: ControllerObservationBatch,
    ) -> Result<(), StatusMappingError> {
        let mut next = self.clone();
        next.apply_inner(observations)?;
        *self = next;
        Ok(())
    }

    pub fn snapshot(
        &self,
        core: &CoreStatus,
        adapter_kind: StatusAdapterKind,
        uptime_seconds: u64,
    ) -> Result<StatusSnapshot, StatusMappingError> {
        let routing_mode =
            self.routing_mode
                .ok_or(StatusMappingError::MissingRequiredObservation {
                    observation: "runtime configuration",
                })?;
        let catalog =
            self.catalog
                .as_ref()
                .ok_or(StatusMappingError::MissingRequiredObservation {
                    observation: "proxy catalog",
                })?;
        let group_usage = catalog
            .groups
            .iter()
            .map(|group| GroupUsage {
                group_id: group.id.clone(),
                observed_connection_count: self
                    .group_counts_by_id
                    .get(&group.id)
                    .copied()
                    .unwrap_or_default(),
            })
            .collect();

        let mut snapshot = StatusSnapshot::lifecycle_only(core, adapter_kind);
        snapshot.active_profile_id = self.context.profile_id.clone();
        snapshot.groups = catalog.groups.clone();
        snapshot.group_usage = group_usage;
        snapshot.group_delay_policy = GroupDelayPolicy {
            id: mish_mihomo_controller::ROUTE_DELAY_POLICY_ID.into(),
            timeout_milliseconds: mish_mihomo_controller::ROUTE_DELAY_TIMEOUT_MILLISECONDS,
        };
        snapshot.group_delay_test = GroupDelayTest::idle();
        snapshot.metrics = RuntimeMetrics {
            active_connections: self.active_connections.len(),
            effective_rules: self
                .effective_rules
                .iter()
                .filter(|rule| rule.enabled)
                .count(),
            memory_bytes: self.memory_bytes,
            uptime_seconds,
        };
        snapshot.nodes = catalog.nodes.clone();
        snapshot.profiles = vec![ProfileSummary {
            id: self.context.profile_id.clone(),
            label: self.context.profile_label.clone(),
        }];
        snapshot.routing_mode = routing_mode;
        snapshot.traffic = self.traffic.clone();
        Ok(snapshot)
    }

    pub fn traffic_snapshot(
        &self,
        adapter_kind: StatusAdapterKind,
        phase: TrafficDataPhase,
        sequence: u64,
        session_id: Option<String>,
        reconnect_count: u64,
    ) -> TrafficDataSnapshot {
        TrafficDataSnapshot {
            active_connections: self.active_connections.clone(),
            adapter_kind,
            phase,
            profile_id: self.context.profile_id.clone(),
            reconnect_count,
            rules: self.effective_rules.clone(),
            sequence,
            session_id,
        }
    }

    pub fn selection_target(
        &self,
        catalog: &ProxyCatalog,
        group_id: &str,
        child_id: &str,
    ) -> Result<(String, String), SelectionTargetError> {
        let group = catalog
            .proxies
            .iter()
            .find(|(label, proxy)| {
                proxy.all.is_some()
                    && scoped_identifier("group", &self.context.profile_fingerprint, label)
                        == group_id
            })
            .ok_or(SelectionTargetError::GroupNotFound)?;
        if !group.1.kind.eq_ignore_ascii_case("selector") {
            return Err(SelectionTargetError::UnsupportedGroup);
        }
        let child = catalog
            .proxies
            .iter()
            .find(|(label, proxy)| {
                let kind = if proxy.all.is_some() {
                    "group"
                } else {
                    "proxy"
                };
                scoped_identifier(kind, &self.context.profile_fingerprint, label) == child_id
            })
            .ok_or(SelectionTargetError::ChildNotFound)?;
        if !group
            .1
            .all
            .as_ref()
            .is_some_and(|children| children.iter().any(|label| label == child.0))
        {
            return Err(SelectionTargetError::ChildOutsideGroup);
        }
        Ok((group.0.clone(), child.0.clone()))
    }

    pub fn group_delay_targets(
        &self,
        catalog: &ProxyCatalog,
        group_id: &str,
    ) -> Result<(String, Vec<(String, String)>), SelectionTargetError> {
        let (group_label, group) = catalog
            .proxies
            .iter()
            .find(|(label, proxy)| {
                proxy.all.is_some()
                    && scoped_identifier("group", &self.context.profile_fingerprint, label)
                        == group_id
            })
            .ok_or(SelectionTargetError::GroupNotFound)?;
        let children = group
            .all
            .as_ref()
            .expect("the matched delay target is a policy group");
        let mut targets = Vec::with_capacity(children.len());
        for child_label in children {
            let child = catalog
                .proxies
                .get(child_label)
                .ok_or(SelectionTargetError::ChildNotFound)?;
            let kind = if child.all.is_some() {
                "group"
            } else {
                "proxy"
            };
            let child_id = scoped_identifier(kind, &self.context.profile_fingerprint, child_label);
            targets.push((child_id, child_label.clone()));
        }
        Ok((group_label.clone(), targets))
    }

    fn apply_inner(
        &mut self,
        observations: ControllerObservationBatch,
    ) -> Result<(), StatusMappingError> {
        if let Some(config) = observations.runtime_config {
            self.routing_mode = Some(map_routing_mode(config.mode));
        }
        if let Some(catalog) = observations.proxies {
            self.catalog = Some(map_catalog(&self.context, catalog)?);
        }
        if let Some(traffic) = observations.traffic {
            let download_bytes_per_second = map_traffic_value("traffic.down", traffic.down)?;
            let downloaded_bytes = map_traffic_value("traffic.downTotal", traffic.down_total)?;
            let upload_bytes_per_second = map_traffic_value("traffic.up", traffic.up)?;
            let uploaded_bytes = map_traffic_value("traffic.upTotal", traffic.up_total)?;
            self.traffic.download_bytes_per_second = download_bytes_per_second;
            self.traffic.downloaded_bytes = downloaded_bytes;
            self.traffic.upload_bytes_per_second = upload_bytes_per_second;
            self.traffic.uploaded_bytes = uploaded_bytes;
            push_bounded(
                &mut self.traffic.download_series,
                download_bytes_per_second,
                self.retention.max_traffic_samples,
            );
            push_bounded(
                &mut self.traffic.upload_series,
                upload_bytes_per_second,
                self.retention.max_traffic_samples,
            );
        }
        if let Some(memory) = observations.memory {
            self.memory_bytes = memory.inuse;
        }
        if let Some(rules) = observations.rules {
            self.effective_rules = rules.rules.into_iter().map(map_rule).collect();
        }
        if let Some(connections) = observations.connections {
            self.observe_group_usage(&connections);
            self.active_connections = connections
                .connections
                .into_iter()
                .map(map_connection)
                .collect::<Result<_, _>>()?;
        }
        Ok(())
    }

    fn observe_group_usage(&mut self, snapshot: &ConnectionSnapshot) {
        let Some(catalog) = &self.catalog else {
            return;
        };
        let group_ids_by_label = catalog.group_ids_by_label.clone();
        for connection in &snapshot.connections {
            if self.seen_connection_ids.contains(&connection.id) {
                continue;
            }
            let traversed: HashSet<&str> = connection
                .chains
                .iter()
                .map(String::as_str)
                .filter_map(|label| group_ids_by_label.get(label).map(String::as_str))
                .collect();
            for group_id in traversed {
                let count = self
                    .group_counts_by_id
                    .entry(group_id.to_owned())
                    .or_default();
                *count = count.saturating_add(1);
            }
            self.remember_connection(connection.id.clone());
        }
    }

    fn remember_connection(&mut self, id: String) {
        self.seen_connection_ids.insert(id.clone());
        self.seen_connection_order.push_back(id);
        while self.seen_connection_order.len() > self.retention.max_seen_connection_ids {
            if let Some(expired) = self.seen_connection_order.pop_front() {
                self.seen_connection_ids.remove(&expired);
            }
        }
    }
}

fn map_routing_mode(mode: ControllerRoutingMode) -> RoutingMode {
    match mode {
        ControllerRoutingMode::Rule => RoutingMode::Rule,
        ControllerRoutingMode::Global => RoutingMode::Global,
        ControllerRoutingMode::Direct => RoutingMode::Direct,
    }
}

fn map_catalog(
    context: &ProfileMappingContext,
    catalog: ProxyCatalog,
) -> Result<MappedCatalog, StatusMappingError> {
    let mut ids_by_label = BTreeMap::new();
    let mut labels_by_id = HashMap::new();
    for (label, proxy) in &catalog.proxies {
        let kind = if proxy.all.is_some() {
            "group"
        } else {
            "proxy"
        };
        // Controller IDs are optional and are not guaranteed to be unique across
        // synthetic policy entries. The map key is validated against the proxy
        // name and is also the identity used by group membership and commands.
        let id = scoped_identifier(kind, &context.profile_fingerprint, label);
        if let Some(first) = labels_by_id.insert(id.clone(), label.clone()) {
            return Err(StatusMappingError::IdentifierCollision {
                first,
                second: label.clone(),
            });
        }
        ids_by_label.insert(label.clone(), id);
    }

    let mut mapped = MappedCatalog::default();
    for (label, proxy) in &catalog.proxies {
        let id = ids_by_label
            .get(label)
            .expect("every validated proxy received a Status identifier")
            .clone();
        let Some(children) = &proxy.all else {
            mapped.nodes.push(ProxyNode {
                id,
                label: label.clone(),
                latency_milliseconds: proxy.history.last().map(|sample| sample.delay),
                protocol: proxy.kind.clone(),
            });
            continue;
        };

        let kind = map_group_kind(&proxy.kind);
        let selected = proxy
            .now
            .as_deref()
            .filter(|selection| !selection.is_empty());
        if kind == PolicyGroupKind::Selector && selected.is_none() {
            return Err(StatusMappingError::MissingSelection {
                group: label.clone(),
            });
        }
        let mut seen_children = HashSet::with_capacity(children.len());
        let mut child_ids = Vec::with_capacity(children.len());
        for child in children {
            if !seen_children.insert(child.as_str()) {
                return Err(StatusMappingError::DuplicateChild {
                    group: label.clone(),
                    child: child.clone(),
                });
            }
            let child_id =
                ids_by_label
                    .get(child)
                    .ok_or_else(|| StatusMappingError::UnknownChild {
                        group: label.clone(),
                        child: child.clone(),
                    })?;
            child_ids.push(child_id.clone());
        }
        if selected.is_some_and(|selection| !seen_children.contains(selection)) {
            return Err(StatusMappingError::SelectionOutsideGroup {
                group: label.clone(),
                selected: selected.unwrap_or_default().to_owned(),
            });
        }
        let selected_child_id = selected.map(|selection| {
            ids_by_label
                .get(selection)
                .expect("selected child membership was checked")
                .clone()
        });
        mapped.group_ids_by_label.insert(label.clone(), id.clone());
        mapped.groups.push(PolicyGroup {
            child_ids,
            id,
            label: label.clone(),
            selected_child_id,
            unsupported_type: (kind == PolicyGroupKind::Unsupported).then(|| proxy.kind.clone()),
            kind,
        });
    }
    let configured_index: HashMap<_, _> = context
        .policy_group_order()
        .iter()
        .enumerate()
        .map(|(index, label)| (label.as_str(), index))
        .collect();
    mapped.groups.sort_by_key(|group| {
        configured_index
            .get(group.label.as_str())
            .copied()
            .unwrap_or(usize::MAX)
    });
    Ok(mapped)
}

fn map_group_kind(kind: &str) -> PolicyGroupKind {
    match kind.to_ascii_lowercase().as_str() {
        "selector" => PolicyGroupKind::Selector,
        "urltest" | "url-test" => PolicyGroupKind::UrlTest,
        "fallback" => PolicyGroupKind::Fallback,
        "loadbalance" | "load-balance" => PolicyGroupKind::LoadBalance,
        "relay" => PolicyGroupKind::Relay,
        "direct" => PolicyGroupKind::Direct,
        "reject" => PolicyGroupKind::Reject,
        _ => PolicyGroupKind::Unsupported,
    }
}

fn scoped_identifier(kind: &str, profile_fingerprint: &str, identity: &str) -> String {
    let mut digest = Sha256::new();
    for component in [kind, profile_fingerprint, identity] {
        digest.update(component.len().to_be_bytes());
        digest.update(component.as_bytes());
    }
    let hash = digest.finalize();
    let mut encoded = String::with_capacity(hash.len() * 2);
    for byte in hash {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    format!("{kind}:{encoded}")
}

fn map_traffic_value(field: &'static str, value: i64) -> Result<u64, StatusMappingError> {
    u64::try_from(value).map_err(|_| StatusMappingError::NegativeTrafficValue { field, value })
}

fn map_connection(connection: Connection) -> Result<TrafficConnection, StatusMappingError> {
    let upload_bytes = map_connection_value(&connection.id, "upload", connection.upload)?;
    let download_bytes = map_connection_value(&connection.id, "download", connection.download)?;
    Ok(TrafficConnection {
        destination_host: non_empty(connection.metadata.host),
        destination_ip: non_empty(connection.metadata.destination_ip),
        destination_port: connection.metadata.destination_port,
        download_bytes,
        id: connection.id,
        matched_rule: TrafficMatchedRule {
            payload: connection.rule_payload,
            kind: connection.rule,
        },
        network: connection.metadata.network,
        process_name: non_empty(connection.metadata.process),
        process_path: non_empty(connection.metadata.process_path),
        protocol: connection.metadata.kind,
        provider_chain: connection.provider_chains,
        remote_destination: non_empty(connection.metadata.remote_destination),
        route_chain: connection.chains,
        sniff_host: non_empty(connection.metadata.sniff_host),
        source_ip: non_empty(connection.metadata.source_ip),
        source_port: connection.metadata.source_port,
        started_at: connection.start,
        upload_bytes,
    })
}

fn map_connection_value(
    connection: &str,
    field: &'static str,
    value: i64,
) -> Result<String, StatusMappingError> {
    if value < 0 {
        return Err(StatusMappingError::NegativeConnectionValue {
            connection: connection.into(),
            field,
            value,
        });
    }
    Ok(value.to_string())
}

fn map_rule(rule: Rule) -> EffectiveRule {
    let enabled = !rule.extra.as_ref().is_some_and(|extra| extra.disabled);
    EffectiveRule {
        enabled,
        hit_count: rule.extra.as_ref().map(|extra| extra.hit_count.to_string()),
        last_hit_at: rule.extra.and_then(|extra| non_empty(extra.hit_at)),
        payload: rule.payload,
        priority: rule.index,
        size: rule.size.to_string(),
        target: rule.proxy,
        kind: rule.kind,
    }
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

fn push_bounded(series: &mut Vec<u64>, value: u64, limit: usize) {
    if series.len() == limit {
        series.remove(0);
    }
    series.push(value);
}
