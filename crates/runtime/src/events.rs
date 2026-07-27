use std::{
    collections::VecDeque,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use mish_presentation_contract::{
    ApplicationActionId, ApplicationEvent, ApplicationEventContent,
    CaptureFailureApplicationEventData, ControllerSessionStaleApplicationEventData,
    ControllerSessionStartedApplicationEventData, ControllerStreamUnavailableApplicationEventData,
    ProfileActivationFailedApplicationEventData, ProxyLaunchTimingApplicationEventData,
    SettingsOperationFailedApplicationEventData, TrafficOperationFailedApplicationEventData,
};
use serde::Serialize;

use crate::{
    ApplicationSnapshotOrder, CaptureFailureKind, CaptureTransitionError, StatusAdapterKind,
    SystemProxyObservationStage,
};

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
    level: EventLevel,
    presentation: ApplicationEvent,
}

impl ApplicationDiagnosticEvent {
    pub fn new(
        level: EventLevel,
        content: ApplicationEventContent,
        action_ids: Vec<ApplicationActionId>,
    ) -> Self {
        Self {
            level,
            presentation: ApplicationEvent::new(content, action_ids),
        }
    }

    pub fn capture_failure(failure: CaptureFailureKind) -> Self {
        Self::capture_failure_with_stage(failure, None)
    }

    pub fn capture_transition_failure(error: &CaptureTransitionError) -> Self {
        Self::capture_failure_with_stage(error.kind, error.observation_stage)
    }

    fn capture_failure_with_stage(
        failure: CaptureFailureKind,
        observation_stage: Option<SystemProxyObservationStage>,
    ) -> Self {
        let level = if matches!(
            failure,
            CaptureFailureKind::CoreUnhealthy
                | CaptureFailureKind::ExternalDrift
                | CaptureFailureKind::RuntimeTransition
                | CaptureFailureKind::TakeoverRejected
                | CaptureFailureKind::UnsafeExistingConfiguration
        ) {
            EventLevel::Warning
        } else {
            EventLevel::Error
        };
        Self::new(
            level,
            ApplicationEventContent::CaptureFailure(CaptureFailureApplicationEventData {
                failure: capture_failure_id(failure).into(),
                observation_stage: observation_stage
                    .map(observation_stage_id)
                    .map(str::to_owned),
            }),
            Vec::new(),
        )
    }

    pub fn settings_failure(failure: impl Into<String>) -> Self {
        Self::new(
            EventLevel::Error,
            ApplicationEventContent::SettingsOperationFailed(
                SettingsOperationFailedApplicationEventData {
                    failure: failure.into(),
                },
            ),
            Vec::new(),
        )
    }

    pub fn controller_session_started() -> Self {
        Self::new(
            EventLevel::Info,
            ApplicationEventContent::ControllerSessionStarted(
                ControllerSessionStartedApplicationEventData {},
            ),
            Vec::new(),
        )
    }

    pub fn controller_session_stale() -> Self {
        Self::new(
            EventLevel::Warning,
            ApplicationEventContent::ControllerSessionStale(
                ControllerSessionStaleApplicationEventData {},
            ),
            Vec::new(),
        )
    }

    pub fn controller_stream_unavailable(failure: impl Into<String>) -> Self {
        Self::new(
            EventLevel::Warning,
            ApplicationEventContent::ControllerStreamUnavailable(
                ControllerStreamUnavailableApplicationEventData {
                    failure: failure.into(),
                },
            ),
            Vec::new(),
        )
    }

    pub fn profile_activation_failure(failure: impl Into<String>) -> Self {
        Self::new(
            EventLevel::Error,
            ApplicationEventContent::ProfileActivationFailed(
                ProfileActivationFailedApplicationEventData {
                    failure: failure.into(),
                },
            ),
            Vec::new(),
        )
    }

    pub fn proxy_launch_timing(data: ProxyLaunchTimingApplicationEventData) -> Self {
        Self::new(
            EventLevel::Debug,
            ApplicationEventContent::ProxyLaunchTiming(data),
            Vec::new(),
        )
    }

    pub fn traffic_failure(failure: impl Into<String>) -> Self {
        Self::new(
            EventLevel::Error,
            ApplicationEventContent::TrafficOperationFailed(
                TrafficOperationFailedApplicationEventData {
                    failure: failure.into(),
                },
            ),
            Vec::new(),
        )
    }

    pub const fn level(&self) -> EventLevel {
        self.level
    }

    pub fn presentation(&self) -> &ApplicationEvent {
        &self.presentation
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
    pub application: Option<ApplicationEvent>,
    pub evidence: Option<EventEvidence>,
    pub id: String,
    pub level: EventLevel,
    pub observed_at: u64,
    pub sequence: u64,
    pub source: EventSource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEvidence {
    pub detail: Option<String>,
    pub message: String,
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
    pub application_order: ApplicationSnapshotOrder,
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
            application_order: ApplicationSnapshotOrder::detached(),
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

fn capture_failure_id(failure: CaptureFailureKind) -> &'static str {
    match failure {
        CaptureFailureKind::ApplyFailed => "apply-failed",
        CaptureFailureKind::CapabilityUnavailable => "capability-unavailable",
        CaptureFailureKind::ConfirmationFailed => "confirmation-failed",
        CaptureFailureKind::CoreUnhealthy => "core-unhealthy",
        CaptureFailureKind::ExternalDrift => "external-drift",
        CaptureFailureKind::InvalidRecovery => "invalid-recovery",
        CaptureFailureKind::ListenerUnavailable => "listener-unavailable",
        CaptureFailureKind::ObservationFailed => "observation-failed",
        CaptureFailureKind::PermissionDenied => "permission-denied",
        CaptureFailureKind::PersistenceFailed => "persistence-failed",
        CaptureFailureKind::RollbackFailed => "rollback-failed",
        CaptureFailureKind::RuntimeTransition => "runtime-transition",
        CaptureFailureKind::TakeoverRejected => "takeover-rejected",
        CaptureFailureKind::UnsafeExistingConfiguration => "unsafe-existing-configuration",
        CaptureFailureKind::UnsupportedSelection => "unsupported-selection",
    }
}

fn observation_stage_id(stage: SystemProxyObservationStage) -> &'static str {
    match stage {
        SystemProxyObservationStage::DefaultRoute => "default-route",
        SystemProxyObservationStage::NetworkServiceOrder => "network-service-order",
        SystemProxyObservationStage::NetworkServiceResolution => "network-service-resolution",
        SystemProxyObservationStage::ProxyConfiguration => "proxy-configuration",
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
                && previous.application.as_ref() == Some(event.presentation())
        }) {
            return false;
        }
        self.sequence = self.sequence.saturating_add(1);
        let level = event.level;
        self.events.push_back(EventRecord {
            application: Some(event.presentation),
            evidence: None,
            id: format!("{}:{}", self.session_id, self.sequence),
            level,
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
            application_order: ApplicationSnapshotOrder::detached(),
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
        assert_eq!(event.presentation().kind(), "capture.failure");
        assert!(format!("{event:?}").contains("confirmation-failed"));
    }

    #[test]
    fn capture_takeover_rejection_does_not_disclose_platform_state() {
        let event =
            ApplicationDiagnosticEvent::capture_failure(CaptureFailureKind::TakeoverRejected);

        assert_eq!(event.level(), EventLevel::Warning);
        assert_eq!(event.presentation().kind(), "capture.failure");
        assert!(!format!("{event:?}").contains("service"));
        assert!(!format!("{event:?}").contains("PAC"));
    }

    #[test]
    fn observation_failure_reports_only_the_bounded_platform_stage() {
        let error = CaptureTransitionError::new(
            CaptureFailureKind::ObservationFailed,
            "private fixture detail",
        )
        .at_observation_stage(SystemProxyObservationStage::NetworkServiceResolution);
        let event = ApplicationDiagnosticEvent::capture_transition_failure(&error);

        assert!(format!("{event:?}").contains("network-service-resolution"));
        assert!(!format!("{event:?}").contains("private fixture detail"));
    }
}
