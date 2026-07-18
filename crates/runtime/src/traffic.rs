use serde::Serialize;

use crate::StatusAdapterKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrafficDataPhase {
    Ready,
    Stale,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficMatchedRule {
    pub payload: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficConnection {
    pub destination_host: Option<String>,
    pub destination_ip: Option<String>,
    pub destination_port: u16,
    pub download_bytes: String,
    pub id: String,
    pub matched_rule: TrafficMatchedRule,
    pub network: String,
    pub process_name: Option<String>,
    pub process_path: Option<String>,
    pub protocol: String,
    pub provider_chain: Vec<String>,
    pub remote_destination: Option<String>,
    pub route_chain: Vec<String>,
    pub sniff_host: Option<String>,
    pub source_ip: Option<String>,
    pub source_port: u16,
    pub started_at: String,
    pub upload_bytes: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveRule {
    pub enabled: bool,
    pub hit_count: Option<String>,
    pub last_hit_at: Option<String>,
    pub payload: String,
    pub priority: usize,
    pub size: String,
    pub target: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficDataSnapshot {
    pub active_connections: Vec<TrafficConnection>,
    pub adapter_kind: StatusAdapterKind,
    pub phase: TrafficDataPhase,
    pub profile_id: String,
    pub reconnect_count: u64,
    pub rules: Vec<EffectiveRule>,
    pub sequence: u64,
    pub session_id: Option<String>,
}

impl TrafficDataSnapshot {
    pub fn unavailable(adapter_kind: StatusAdapterKind) -> Self {
        Self {
            active_connections: Vec::new(),
            adapter_kind,
            phase: TrafficDataPhase::Unavailable,
            profile_id: "local".into(),
            reconnect_count: 0,
            rules: Vec::new(),
            sequence: 0,
            session_id: None,
        }
    }
}
