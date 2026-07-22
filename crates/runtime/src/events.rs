use std::{
    collections::VecDeque,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{CaptureFailureKind, StatusAdapterKind};

pub const EVENTS_BUFFER_LIMIT: usize = 1_024;

static NEXT_APPLICATION_EVENT_SESSION: AtomicU64 = AtomicU64::new(1);

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
pub enum ApplicationNotificationKind {
    CaptureFailure,
    ProfileActivationFailure,
    SettingsFailure,
    TrafficFailure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ApplicationDiagnosticEvent {
    detail: Option<&'static str>,
    level: EventLevel,
    message: &'static str,
    notification_kind: Option<ApplicationNotificationKind>,
}

impl ApplicationDiagnosticEvent {
    pub const fn new(
        level: EventLevel,
        message: &'static str,
        detail: Option<&'static str>,
    ) -> Self {
        Self {
            detail,
            level,
            message,
            notification_kind: None,
        }
    }

    pub const fn notification(
        level: EventLevel,
        message: &'static str,
        detail: Option<&'static str>,
        notification_kind: ApplicationNotificationKind,
    ) -> Self {
        Self {
            detail,
            level,
            message,
            notification_kind: Some(notification_kind),
        }
    }

    pub const fn capture_failure(failure: CaptureFailureKind) -> Self {
        match failure {
            CaptureFailureKind::InvalidRecovery => Self::notification(
                EventLevel::Error,
                "System Proxy recovery record is invalid",
                Some(
                    "Leave the external proxy unchanged to clear Mish ownership, then retry capture",
                ),
                ApplicationNotificationKind::CaptureFailure,
            ),
            CaptureFailureKind::PersistenceFailed => Self::notification(
                EventLevel::Error,
                "System Proxy recovery storage is unavailable",
                Some("Check Mish application-data permissions before retrying capture"),
                ApplicationNotificationKind::CaptureFailure,
            ),
            CaptureFailureKind::CoreUnhealthy => Self::notification(
                EventLevel::Warning,
                "Traffic capture was blocked because Mihomo is not healthy",
                Some(
                    "Activate a valid profile and wait for healthy Status before enabling capture",
                ),
                ApplicationNotificationKind::CaptureFailure,
            ),
            CaptureFailureKind::ListenerUnavailable => Self::notification(
                EventLevel::Error,
                "Traffic capture was blocked because the managed listener is unavailable",
                Some("Restart the active profile and retry only after Status is healthy"),
                ApplicationNotificationKind::CaptureFailure,
            ),
            CaptureFailureKind::ExternalDrift => Self::notification(
                EventLevel::Warning,
                "System Proxy changed outside Mish",
                Some("Choose Repair or Leave as is from the Status recovery controls"),
                ApplicationNotificationKind::CaptureFailure,
            ),
            _ => Self::notification(
                EventLevel::Error,
                "System Proxy reconciliation failed",
                Some("Review the typed capture state on Status before retrying"),
                ApplicationNotificationKind::CaptureFailure,
            ),
        }
    }

    pub const fn settings_failure() -> Self {
        Self::notification(
            EventLevel::Error,
            "Application settings update failed",
            Some("Review the current Settings snapshot, then retry the requested change"),
            ApplicationNotificationKind::SettingsFailure,
        )
    }

    pub const fn traffic_failure() -> Self {
        Self::notification(
            EventLevel::Error,
            "Traffic operation failed",
            Some("Refresh Traffic to confirm the remaining connections before retrying"),
            ApplicationNotificationKind::TrafficFailure,
        )
    }

    pub const fn detail(self) -> Option<&'static str> {
        self.detail
    }

    pub const fn level(self) -> EventLevel {
        self.level
    }

    pub const fn message(self) -> &'static str {
        self.message
    }

    pub const fn notification_kind(self) -> Option<ApplicationNotificationKind> {
        self.notification_kind
    }
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
    pub notification_kind: Option<ApplicationNotificationKind>,
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

pub(crate) struct ApplicationEventBuffer {
    events: VecDeque<EventRecord>,
    sequence: u64,
    session_id: String,
}

impl ApplicationEventBuffer {
    pub(crate) fn new() -> Self {
        Self {
            events: VecDeque::new(),
            sequence: 0,
            session_id: format!(
                "application-events-{}",
                NEXT_APPLICATION_EVENT_SESSION.fetch_add(1, Ordering::Relaxed)
            ),
        }
    }

    pub(crate) fn push(&mut self, event: ApplicationDiagnosticEvent) -> bool {
        if self.events.back().is_some_and(|previous| {
            previous.source == EventSource::Application
                && previous.level == event.level()
                && previous.message == event.message()
                && previous.detail.as_deref() == event.detail()
                && previous.notification_kind == event.notification_kind()
        }) {
            return false;
        }
        self.sequence = self.sequence.saturating_add(1);
        self.events.push_back(EventRecord {
            detail: event.detail().map(str::to_owned),
            id: format!("{}:{}", self.session_id, self.sequence),
            level: event.level(),
            message: event.message().to_owned(),
            notification_kind: event.notification_kind(),
            observed_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            sequence: self.sequence,
            source: EventSource::Application,
        });
        while self.events.len() > EVENTS_BUFFER_LIMIT {
            self.events.pop_front();
        }
        true
    }

    pub(crate) fn snapshot(&self, adapter_kind: StatusAdapterKind) -> EventsSnapshot {
        if self.events.is_empty() {
            return EventsSnapshot::unavailable(adapter_kind);
        }
        EventsSnapshot {
            adapter_kind,
            events: self.events.iter().cloned().collect(),
            phase: EventsDataPhase::Ready,
            profile_id: "local".into(),
            reconnect_count: 0,
            sequence: self.sequence,
            session_id: Some(self.session_id.clone()),
            source_statuses: [
                EventSource::Application,
                EventSource::Core,
                EventSource::Platform,
                EventSource::Rpc,
            ]
            .into_iter()
            .map(|source| EventSourceStatus {
                detail: Some(if source == EventSource::Application {
                    "Local redacted lifecycle diagnostics".into()
                } else {
                    "This event source is unavailable in the current runtime".into()
                }),
                phase: if source == EventSource::Application {
                    EventSourcePhase::Ready
                } else {
                    EventSourcePhase::Unavailable
                },
                source,
            })
            .collect(),
        }
    }
}
