use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize};

use crate::{ControllerError, ControllerLimits, Endpoint};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub meta: bool,
    pub version: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutingMode {
    Rule,
    Global,
    Direct,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct RuntimeConfig {
    pub mode: RoutingMode,
    pub tun: TunRuntimeConfig,
    pub allow_lan: bool,
    pub ipv6: bool,
    pub port: u16,
    pub socks_port: u16,
    pub redir_port: u16,
    pub tproxy_port: u16,
    pub mixed_port: u16,
    pub log_level: String,
    pub tcp_concurrent: bool,
    pub find_process_mode: String,
    pub sniffing: bool,
    pub interface_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct TunRuntimeConfig {
    pub enable: bool,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub stack: String,
    #[serde(default)]
    pub auto_route: bool,
    #[serde(default)]
    pub auto_detect_interface: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProxyCatalog {
    pub proxies: BTreeMap<String, ProxyMetadata>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyMetadata {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub alive: bool,
    pub udp: bool,
    pub uot: bool,
    pub xudp: bool,
    pub tfo: bool,
    pub mptcp: bool,
    pub smux: bool,
    #[serde(default)]
    pub interface: String,
    #[serde(rename = "routing-mark", default)]
    pub routing_mark: i64,
    #[serde(rename = "provider-name", default)]
    pub provider_name: String,
    #[serde(rename = "dialer-proxy", default)]
    pub dialer_proxy: String,
    #[serde(default)]
    pub history: Vec<DelaySample>,
    #[serde(default)]
    pub all: Option<Vec<String>>,
    #[serde(default)]
    pub now: Option<String>,
    #[serde(default)]
    pub hidden: Option<bool>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub fixed: Option<String>,
}

impl ProxyMetadata {
    pub fn group(&self) -> Option<ProxyGroupMetadata<'_>> {
        self.all.as_deref().map(|children| ProxyGroupMetadata {
            children,
            selected: self.now.as_deref(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProxyGroupMetadata<'a> {
    pub children: &'a [String],
    pub selected: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DelaySample {
    pub time: String,
    pub delay: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSnapshot {
    pub up: i64,
    pub down: i64,
    pub up_total: i64,
    pub down_total: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemorySnapshot {
    pub inuse: u64,
    pub oslimit: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub download_total: i64,
    pub upload_total: i64,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub connections: Vec<Connection>,
    pub memory: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub metadata: ConnectionMetadata,
    pub upload: i64,
    pub download: i64,
    pub start: String,
    pub chains: Vec<String>,
    #[serde(default)]
    pub provider_chains: Vec<String>,
    pub rule: String,
    pub rule_payload: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMetadata {
    pub network: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "sourceIP")]
    pub source_ip: String,
    #[serde(rename = "destinationIP")]
    pub destination_ip: String,
    #[serde(deserialize_with = "deserialize_port")]
    pub source_port: u16,
    #[serde(deserialize_with = "deserialize_port")]
    pub destination_port: u16,
    #[serde(default)]
    #[serde(rename = "inboundIP")]
    pub inbound_ip: String,
    #[serde(default, deserialize_with = "deserialize_port")]
    pub inbound_port: u16,
    #[serde(default)]
    pub inbound_name: String,
    #[serde(default)]
    pub inbound_user: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub dns_mode: String,
    #[serde(default)]
    pub uid: u32,
    #[serde(default)]
    pub process: String,
    #[serde(default)]
    pub process_path: String,
    #[serde(default)]
    pub special_proxy: String,
    #[serde(default)]
    pub special_rules: String,
    #[serde(default)]
    pub remote_destination: String,
    #[serde(default)]
    pub sniff_host: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PortWire {
    String(String),
    Number(u16),
}

fn deserialize_port<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    match PortWire::deserialize(deserializer)? {
        PortWire::String(value) => value.parse().map_err(serde::de::Error::custom),
        PortWire::Number(value) => Ok(value),
    }
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuleList {
    pub rules: Vec<Rule>,
}

impl RuleList {
    pub fn effective_count(&self) -> usize {
        self.rules
            .iter()
            .filter(|rule| !rule.extra.as_ref().is_some_and(|extra| extra.disabled))
            .count()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Rule {
    pub index: usize,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: String,
    pub proxy: String,
    pub size: i64,
    #[serde(default)]
    pub extra: Option<RuleExtra>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleExtra {
    pub disabled: bool,
    pub hit_count: u64,
    pub hit_at: String,
    pub miss_count: u64,
    pub miss_at: String,
}

pub(crate) trait Validate {
    fn validate(
        &self,
        endpoint: Endpoint,
        limits: &ControllerLimits,
    ) -> Result<(), ControllerError>;
}

fn validation(
    endpoint: Endpoint,
    field: &'static str,
    detail: impl Into<String>,
) -> ControllerError {
    ControllerError::Validation {
        endpoint,
        field,
        detail: detail.into(),
    }
}

fn check_string(
    value: &str,
    endpoint: Endpoint,
    field: &'static str,
    limits: &ControllerLimits,
    allow_empty: bool,
) -> Result<(), ControllerError> {
    if !allow_empty && value.is_empty() {
        return Err(validation(endpoint, field, "must not be empty"));
    }
    if value.len() > limits.max_string_bytes {
        return Err(validation(
            endpoint,
            field,
            format!("exceeded {} bytes", limits.max_string_bytes),
        ));
    }
    Ok(())
}

impl Validate for VersionInfo {
    fn validate(
        &self,
        endpoint: Endpoint,
        limits: &ControllerLimits,
    ) -> Result<(), ControllerError> {
        check_string(&self.version, endpoint, "version", limits, false)
    }
}

impl Validate for RuntimeConfig {
    fn validate(
        &self,
        endpoint: Endpoint,
        limits: &ControllerLimits,
    ) -> Result<(), ControllerError> {
        check_string(&self.log_level, endpoint, "log-level", limits, false)?;
        check_string(
            &self.find_process_mode,
            endpoint,
            "find-process-mode",
            limits,
            false,
        )?;
        check_string(
            &self.interface_name,
            endpoint,
            "interface-name",
            limits,
            true,
        )?;
        check_string(&self.tun.device, endpoint, "tun.device", limits, true)?;
        check_string(&self.tun.stack, endpoint, "tun.stack", limits, true)
    }
}

impl Validate for ProxyCatalog {
    fn validate(
        &self,
        endpoint: Endpoint,
        limits: &ControllerLimits,
    ) -> Result<(), ControllerError> {
        if self.proxies.len() > limits.max_proxies {
            return Err(validation(
                endpoint,
                "proxies",
                format!("exceeded {} entries", limits.max_proxies),
            ));
        }
        for (key, proxy) in &self.proxies {
            check_string(key, endpoint, "proxies key", limits, false)?;
            check_string(&proxy.name, endpoint, "proxies.name", limits, false)?;
            if key != &proxy.name {
                return Err(validation(
                    endpoint,
                    "proxies.name",
                    "did not exactly match its controller map key",
                ));
            }
            check_string(&proxy.kind, endpoint, "proxies.type", limits, false)?;
            if let Some(id) = &proxy.id {
                check_string(id, endpoint, "proxies.id", limits, false)?;
            }
            for value in [&proxy.interface, &proxy.provider_name, &proxy.dialer_proxy] {
                check_string(value, endpoint, "proxies metadata", limits, true)?;
            }
            for value in [&proxy.icon, &proxy.fixed].into_iter().flatten() {
                check_string(value, endpoint, "proxies optional metadata", limits, true)?;
            }
            if proxy.history.len() > limits.max_history_entries {
                return Err(validation(
                    endpoint,
                    "proxies.history",
                    format!("exceeded {} entries", limits.max_history_entries),
                ));
            }
            for sample in &proxy.history {
                check_string(
                    &sample.time,
                    endpoint,
                    "proxies.history.time",
                    limits,
                    false,
                )?;
            }
            if let Some(children) = &proxy.all {
                if children.len() > limits.max_group_children {
                    return Err(validation(
                        endpoint,
                        "proxies.all",
                        format!("exceeded {} entries", limits.max_group_children),
                    ));
                }
                for child in children {
                    check_string(child, endpoint, "proxies.all[]", limits, false)?;
                }
            }
            if let Some(selected) = &proxy.now {
                check_string(selected, endpoint, "proxies.now", limits, true)?;
            }
        }
        Ok(())
    }
}

impl Validate for TrafficSnapshot {
    fn validate(
        &self,
        _endpoint: Endpoint,
        _limits: &ControllerLimits,
    ) -> Result<(), ControllerError> {
        Ok(())
    }
}

impl Validate for MemorySnapshot {
    fn validate(
        &self,
        _endpoint: Endpoint,
        _limits: &ControllerLimits,
    ) -> Result<(), ControllerError> {
        Ok(())
    }
}

impl Validate for ConnectionSnapshot {
    fn validate(
        &self,
        endpoint: Endpoint,
        limits: &ControllerLimits,
    ) -> Result<(), ControllerError> {
        if self.connections.len() > limits.max_connections {
            return Err(validation(
                endpoint,
                "connections",
                format!("exceeded {} entries", limits.max_connections),
            ));
        }
        let mut ids = HashSet::with_capacity(self.connections.len());
        for connection in &self.connections {
            check_string(&connection.id, endpoint, "connections.id", limits, false)?;
            if !ids.insert(connection.id.as_str()) {
                return Err(validation(
                    endpoint,
                    "connections.id",
                    "contained a duplicate active connection ID",
                ));
            }
            check_string(
                &connection.start,
                endpoint,
                "connections.start",
                limits,
                false,
            )?;
            check_string(
                &connection.metadata.network,
                endpoint,
                "connections.metadata.network",
                limits,
                false,
            )?;
            check_string(
                &connection.metadata.kind,
                endpoint,
                "connections.metadata.type",
                limits,
                false,
            )?;
            for value in [
                &connection.metadata.source_ip,
                &connection.metadata.destination_ip,
                &connection.metadata.inbound_ip,
                &connection.metadata.inbound_name,
                &connection.metadata.inbound_user,
                &connection.metadata.host,
                &connection.metadata.dns_mode,
                &connection.metadata.process,
                &connection.metadata.process_path,
                &connection.metadata.special_proxy,
                &connection.metadata.special_rules,
                &connection.metadata.remote_destination,
                &connection.metadata.sniff_host,
                &connection.rule,
                &connection.rule_payload,
            ] {
                check_string(value, endpoint, "connections text metadata", limits, true)?;
            }
            if connection.chains.len() > limits.max_chain_entries
                || connection.provider_chains.len() > limits.max_chain_entries
            {
                return Err(validation(
                    endpoint,
                    "connections.chains",
                    format!("exceeded {} entries", limits.max_chain_entries),
                ));
            }
            for chain in connection
                .chains
                .iter()
                .chain(connection.provider_chains.iter())
            {
                check_string(chain, endpoint, "connections.chains[]", limits, true)?;
            }
        }
        Ok(())
    }
}

impl Validate for RuleList {
    fn validate(
        &self,
        endpoint: Endpoint,
        limits: &ControllerLimits,
    ) -> Result<(), ControllerError> {
        if self.rules.len() > limits.max_rules {
            return Err(validation(
                endpoint,
                "rules",
                format!("exceeded {} entries", limits.max_rules),
            ));
        }
        for rule in &self.rules {
            check_string(&rule.kind, endpoint, "rules.type", limits, false)?;
            check_string(&rule.payload, endpoint, "rules.payload", limits, true)?;
            check_string(&rule.proxy, endpoint, "rules.proxy", limits, false)?;
            if let Some(extra) = &rule.extra {
                check_string(&extra.hit_at, endpoint, "rules.extra.hitAt", limits, false)?;
                check_string(
                    &extra.miss_at,
                    endpoint,
                    "rules.extra.missAt",
                    limits,
                    false,
                )?;
            }
        }
        Ok(())
    }
}
