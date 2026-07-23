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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApplicationDiagnosticEvent {
    detail: Option<ApplicationDiagnosticDetail>,
    level: EventLevel,
    message: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ApplicationDiagnosticDetail {
    Owned(String),
    Static(&'static str),
}

impl ApplicationDiagnosticEvent {
    pub const fn new(
        level: EventLevel,
        message: &'static str,
        detail: Option<&'static str>,
    ) -> Self {
        Self {
            detail: match detail {
                Some(detail) => Some(ApplicationDiagnosticDetail::Static(detail)),
                None => None,
            },
            level,
            message,
        }
    }

    pub fn with_owned_detail(
        level: EventLevel,
        message: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            detail: Some(ApplicationDiagnosticDetail::Owned(detail.into())),
            level,
            message,
        }
    }

    pub const fn capture_failure(failure: CaptureFailureKind) -> Self {
        match failure {
            CaptureFailureKind::InvalidRecovery => Self::new(
                EventLevel::Error,
                "System Proxy recovery record is invalid",
                Some(
                    "Leave the external proxy unchanged to clear Mish ownership, then retry capture",
                ),
            ),
            CaptureFailureKind::PersistenceFailed => Self::new(
                EventLevel::Error,
                "System Proxy recovery storage is unavailable",
                Some("Check Mish application-data permissions before retrying capture"),
            ),
            CaptureFailureKind::CoreUnhealthy => Self::new(
                EventLevel::Warning,
                "Traffic capture was blocked because Mihomo is not healthy",
                Some(
                    "Activate a valid profile and wait for healthy Status before enabling capture",
                ),
            ),
            CaptureFailureKind::ListenerUnavailable => Self::new(
                EventLevel::Error,
                "Traffic capture was blocked because the managed listener is unavailable",
                Some("Restart the active profile and retry only after Status is healthy"),
            ),
            CaptureFailureKind::ApplyFailed => Self::new(
                EventLevel::Error,
                "System Proxy mutation failed",
                Some(
                    "macOS did not complete the requested System Proxy mutation; the prior state was retained or restored",
                ),
            ),
            CaptureFailureKind::ConfirmationFailed => Self::new(
                EventLevel::Error,
                "System Proxy propagation was not confirmed",
                Some("Mish waited for an exact macOS observation before restoring the prior state"),
            ),
            CaptureFailureKind::ExternalDrift => Self::new(
                EventLevel::Warning,
                "System Proxy changed outside Mish",
                Some("Choose Repair or Leave as is from the Status recovery controls"),
            ),
            CaptureFailureKind::ObservationFailed => Self::new(
                EventLevel::Error,
                "System Proxy state could not be observed",
                Some("Mish did not apply or confirm capture without a complete macOS observation"),
            ),
            CaptureFailureKind::RollbackFailed => Self::new(
                EventLevel::Error,
                "System Proxy recovery was not confirmed",
                Some(
                    "The prior System Proxy state could not be confirmed; review the Status recovery controls",
                ),
            ),
            CaptureFailureKind::TakeoverRejected
            | CaptureFailureKind::UnsafeExistingConfiguration => Self::new(
                EventLevel::Warning,
                "Existing System Proxy settings were left unchanged",
                Some("Review the System Proxy takeover policy before retrying capture"),
            ),
            CaptureFailureKind::PermissionDenied => Self::new(
                EventLevel::Error,
                "macOS denied the System Proxy mutation",
                Some("No successful capture state was published"),
            ),
            CaptureFailureKind::CapabilityUnavailable
            | CaptureFailureKind::UnsupportedSelection => Self::new(
                EventLevel::Error,
                "Requested traffic capture is unavailable",
                Some("Review the available capture modes before retrying"),
            ),
            CaptureFailureKind::RuntimeTransition => Self::new(
                EventLevel::Warning,
                "Traffic capture transition did not complete",
                Some("Wait for the current Core or capture transition to finish before retrying"),
            ),
        }
    }

    pub const fn settings_failure() -> Self {
        Self::new(
            EventLevel::Error,
            "Application settings update failed",
            Some("Review the current Settings snapshot, then retry the requested change"),
        )
    }

    pub const fn traffic_failure() -> Self {
        Self::new(
            EventLevel::Error,
            "Traffic operation failed",
            Some("Refresh Traffic to confirm the remaining connections before retrying"),
        )
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_ref().map(|detail| match detail {
            ApplicationDiagnosticDetail::Owned(detail) => detail.as_str(),
            ApplicationDiagnosticDetail::Static(detail) => *detail,
        })
    }

    pub const fn level(&self) -> EventLevel {
        self.level
    }

    pub const fn message(&self) -> &'static str {
        self.message
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
        }) {
            return false;
        }
        self.sequence = self.sequence.saturating_add(1);
        self.events.push_back(EventRecord {
            detail: event.detail().map(str::to_owned),
            id: format!("{}:{}", self.session_id, self.sequence),
            level: event.level(),
            message: event.message().to_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_confirmation_failure_is_safe_and_stage_specific() {
        let event =
            ApplicationDiagnosticEvent::capture_failure(CaptureFailureKind::ConfirmationFailed);

        assert_eq!(event.level(), EventLevel::Error);
        assert_eq!(
            event.message(),
            "System Proxy propagation was not confirmed"
        );
        assert_eq!(
            event.detail(),
            Some("Mish waited for an exact macOS observation before restoring the prior state")
        );
    }

    #[test]
    fn capture_takeover_rejection_does_not_disclose_platform_state() {
        let event =
            ApplicationDiagnosticEvent::capture_failure(CaptureFailureKind::TakeoverRejected);

        assert_eq!(event.level(), EventLevel::Warning);
        assert_eq!(
            event.message(),
            "Existing System Proxy settings were left unchanged"
        );
        assert!(!format!("{event:?}").contains("service"));
        assert!(!format!("{event:?}").contains("PAC"));
    }
}
