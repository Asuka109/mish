use serde::Serialize;

use crate::StatusAdapterKind;

pub const EVENTS_BUFFER_LIMIT: usize = 1_024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventsDataPhase {
    Connecting,
    Ready,
    Stale,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventLevel {
    Debug,
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventSource {
    Application,
    Core,
    Platform,
    Rpc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventSourcePhase {
    FixtureOnly,
    Ready,
    Stale,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub detail: Option<String>,
    pub id: String,
    pub level: EventLevel,
    pub message: String,
    pub observed_at: u64,
    pub sequence: u64,
    pub source: EventSource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSourceStatus {
    pub detail: Option<String>,
    pub phase: EventSourcePhase,
    pub source: EventSource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsSnapshot {
    pub adapter_kind: StatusAdapterKind,
    pub events: Vec<EventRecord>,
    pub phase: EventsDataPhase,
    pub profile_id: String,
    pub reconnect_count: u64,
    pub sequence: u64,
    pub session_id: Option<String>,
    pub source_statuses: Vec<EventSourceStatus>,
}

impl EventsSnapshot {
    pub fn unavailable(adapter_kind: StatusAdapterKind) -> Self {
        Self {
            adapter_kind,
            events: Vec::new(),
            phase: EventsDataPhase::Unavailable,
            profile_id: "local".into(),
            reconnect_count: 0,
            sequence: 0,
            session_id: None,
            source_statuses: [
                EventSource::Application,
                EventSource::Core,
                EventSource::Platform,
                EventSource::Rpc,
            ]
            .into_iter()
            .map(|source| EventSourceStatus {
                detail: Some("This event source is unavailable in the current runtime".into()),
                phase: EventSourcePhase::Unavailable,
                source,
            })
            .collect(),
        }
    }
}
