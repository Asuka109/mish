#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::{
    generated::platform_facts::{PlatformAvailability, PlatformEventKind},
    lifecycle::{LifecycleFailure, LifecycleState},
};

pub const MOBILE_EVENTS_LIMIT: usize = 1_024;
pub const MOBILE_DIAGNOSTIC_HISTORY_LIMIT: usize = 8;
pub const MOBILE_DIAGNOSTIC_CHECK_LIMIT: usize = 4;
pub const FIXED_DIAGNOSTIC_POLICY_ID: &str = "android-connectivity-v1";
pub const FIXED_DIAGNOSTIC_TARGET: &str = "https://www.gstatic.com/generate_204";
pub const FIXED_DIAGNOSTIC_TIMEOUT_MILLIS: u64 = 5_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobileEventLevel {
    Debug,
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobileEventSource {
    Application,
    Core,
    Platform,
    Rpc,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileEventEvidence {
    pub detail: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileEventRecord {
    pub application: Option<serde_json::Value>,
    pub evidence: Option<MobileEventEvidence>,
    pub id: String,
    pub level: MobileEventLevel,
    pub observed_at: u64,
    pub sequence: u64,
    pub source: MobileEventSource,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileEventSourceStatus {
    pub detail: Option<String>,
    pub phase: String,
    pub source: MobileEventSource,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileApplicationOrder {
    pub authority_id: String,
    pub epoch: u64,
    pub order: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileEventsSnapshot {
    pub adapter_kind: String,
    pub application_order: MobileApplicationOrder,
    pub events: Vec<MobileEventRecord>,
    pub phase: String,
    pub profile_id: String,
    pub reconnect_count: u64,
    pub sequence: u64,
    pub session_id: Option<String>,
    pub source_statuses: Vec<MobileEventSourceStatus>,
}

impl MobileEventsSnapshot {
    #[cfg(not(target_os = "android"))]
    pub(crate) fn unsupported() -> Self {
        Self {
            adapter_kind: "fixture".into(),
            application_order: MobileApplicationOrder {
                authority_id: "non-android-events".into(),
                epoch: 0,
                order: 0,
            },
            events: Vec::new(),
            phase: "unavailable".into(),
            profile_id: "local".into(),
            reconnect_count: 0,
            sequence: 0,
            session_id: None,
            source_statuses: [
                MobileEventSource::Application,
                MobileEventSource::Core,
                MobileEventSource::Platform,
                MobileEventSource::Rpc,
            ]
            .into_iter()
            .map(|source| source_status(source, false))
            .collect(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MobileEventsAuthority {
    authority_id: String,
    epoch: u64,
    events: VecDeque<MobileEventRecord>,
    last_fact_sequence: u64,
    reconnect_count: u64,
    sequence: u64,
    session_generation: u64,
    session_id: String,
}

impl MobileEventsAuthority {
    pub(crate) fn from_baseline(state: &LifecycleState) -> Self {
        let mut authority = Self {
            authority_id: state.authority_id.clone(),
            epoch: state.scope_epoch,
            events: VecDeque::new(),
            last_fact_sequence: state.facts.fact_sequence,
            reconnect_count: 0,
            sequence: 0,
            session_generation: 1,
            session_id: event_session_id(&state.authority_id, state.scope_epoch, 1),
        };
        authority.push(
            state.facts.observed_at_millis,
            MobileEventLevel::Info,
            MobileEventSource::Platform,
            "Android lifecycle baseline reconciled.",
            Some("The complete current native lifecycle facts are authoritative."),
        );
        authority
    }

    pub(crate) fn observe(&mut self, state: &LifecycleState) -> bool {
        if state.authority_id != self.authority_id || state.scope_epoch != self.epoch {
            return false;
        }
        let fact_sequence = state.facts.fact_sequence;
        if fact_sequence <= self.last_fact_sequence {
            return false;
        }
        if fact_sequence > self.last_fact_sequence.saturating_add(1) {
            self.reconnect_count = self.reconnect_count.saturating_add(1);
            self.session_generation = self.session_generation.saturating_add(1);
            self.session_id =
                event_session_id(&self.authority_id, self.epoch, self.session_generation);
            self.sequence = 0;
            self.events.clear();
            self.push(
                state.facts.observed_at_millis,
                MobileEventLevel::Warning,
                MobileEventSource::Platform,
                "Android lifecycle event history was reconciled after a sequence gap.",
                Some("A complete native baseline replaced the incomplete retained session."),
            );
        }
        self.last_fact_sequence = fact_sequence;
        let (level, source, message, detail) = map_lifecycle_event(state);
        self.push(
            state.facts.observed_at_millis,
            level,
            source,
            message,
            detail,
        );
        true
    }

    pub(crate) fn snapshot(&self, state: &LifecycleState) -> MobileEventsSnapshot {
        let core_ready = state.facts.core_availability == PlatformAvailability::Available;
        MobileEventsSnapshot {
            adapter_kind: "native".into(),
            application_order: MobileApplicationOrder {
                authority_id: self.authority_id.clone(),
                epoch: self.epoch,
                order: self.sequence,
            },
            events: self.events.iter().cloned().collect(),
            phase: "ready".into(),
            profile_id: "android-mobile-runtime".into(),
            reconnect_count: self.reconnect_count,
            sequence: self.sequence,
            session_id: Some(self.session_id.clone()),
            source_statuses: vec![
                source_status(MobileEventSource::Application, false),
                source_status(MobileEventSource::Core, core_ready),
                source_status(MobileEventSource::Platform, true),
                source_status(MobileEventSource::Rpc, false),
            ],
        }
    }

    fn push(
        &mut self,
        observed_at: u64,
        level: MobileEventLevel,
        source: MobileEventSource,
        message: &str,
        detail: Option<&str>,
    ) {
        self.sequence = self.sequence.saturating_add(1);
        self.events.push_back(MobileEventRecord {
            application: None,
            evidence: Some(MobileEventEvidence {
                detail: detail.map(str::to_owned),
                message: message.into(),
            }),
            id: format!("{}:{}", self.session_id, self.sequence),
            level,
            observed_at,
            sequence: self.sequence,
            source,
        });
        while self.events.len() > MOBILE_EVENTS_LIMIT {
            self.events.pop_front();
        }
    }
}

fn event_session_id(authority_id: &str, epoch: u64, generation: u64) -> String {
    let prefix: String = authority_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect();
    format!("android-events-{prefix}-{epoch}-{generation}")
}

fn source_status(source: MobileEventSource, ready: bool) -> MobileEventSourceStatus {
    MobileEventSourceStatus {
        detail: Some(if ready {
            "Bounded redacted Android runtime observations".into()
        } else {
            "This source is unavailable in the Android mobile runtime".into()
        }),
        phase: if ready { "ready" } else { "unavailable" }.into(),
        source,
    }
}

fn map_lifecycle_event(
    state: &LifecycleState,
) -> (
    MobileEventLevel,
    MobileEventSource,
    &'static str,
    Option<&'static str>,
) {
    use PlatformEventKind as Event;
    match state.facts.event {
        Event::ActivationCompleted => (
            MobileEventLevel::Info,
            MobileEventSource::Core,
            "Android VPN and Mobile Core activation completed.",
            Some("Shared Rust accepted the complete same-session lifecycle observation."),
        ),
        Event::ActivationFailed => (
            MobileEventLevel::Error,
            MobileEventSource::Core,
            "Android VPN or Mobile Core activation failed safely.",
            Some(lifecycle_failure_detail(state.failure)),
        ),
        Event::ActivationProgress => (
            MobileEventLevel::Debug,
            MobileEventSource::Platform,
            "Android VPN activation observation advanced.",
            None,
        ),
        Event::ConsentResult => (
            MobileEventLevel::Info,
            MobileEventSource::Platform,
            "Android VPN consent observation changed.",
            None,
        ),
        Event::CoreExited => (
            MobileEventLevel::Error,
            MobileEventSource::Core,
            "Mobile Core exited and the runtime retired its running state.",
            Some("Raw native and JNI failure text was not retained."),
        ),
        Event::NetworkChanged => (
            MobileEventLevel::Warning,
            MobileEventSource::Platform,
            "Android underlying-network observation changed.",
            Some("Only closed availability facts were retained."),
        ),
        Event::NotificationResult => (
            MobileEventLevel::Info,
            MobileEventSource::Platform,
            "Android notification permission observation changed.",
            None,
        ),
        Event::Observation => (
            MobileEventLevel::Debug,
            MobileEventSource::Platform,
            "Android lifecycle baseline was refreshed.",
            None,
        ),
        Event::Revoked => (
            MobileEventLevel::Warning,
            MobileEventSource::Platform,
            "Android VPN permission was revoked.",
            Some("Shared Rust requires explicit reconciliation before another activation."),
        ),
        Event::ServiceDestroyed => (
            MobileEventLevel::Error,
            MobileEventSource::Platform,
            "Android VPN service destruction was observed.",
            Some("The product lifecycle moved to a safe typed terminal state."),
        ),
        Event::StopCompleted => (
            MobileEventLevel::Info,
            MobileEventSource::Platform,
            "Android VPN and Mobile Core cleanup completed.",
            Some("No Mish-owned Android runtime resource remains in the accepted facts."),
        ),
    }
}

fn lifecycle_failure_detail(failure: Option<LifecycleFailure>) -> &'static str {
    match failure {
        Some(LifecycleFailure::Cancelled) => "The operation was cancelled.",
        Some(LifecycleFailure::ConfigurationNotLoaded) => {
            "The admitted configuration was unavailable."
        }
        Some(LifecycleFailure::CoreFailure | LifecycleFailure::CoreUnavailable) => {
            "Mobile Core was unavailable or failed."
        }
        Some(LifecycleFailure::NetworkUnavailable) => "The underlying network was unavailable.",
        Some(LifecycleFailure::PermissionDenied) => "Android VPN permission was unavailable.",
        Some(LifecycleFailure::PublicRequestFailed) => "The fixed public request was not observed.",
        Some(LifecycleFailure::Timeout) => "The bounded lifecycle operation timed out.",
        Some(LifecycleFailure::TunFailure) => "The Android TUN effect failed safely.",
        _ => "The Android platform effect failed without retaining raw native text.",
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileDiagnosticPhase {
    Pending,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Replaced,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileDiagnosticFailure {
    Cancelled,
    FixedTargetUnavailable,
    NetworkUnavailable,
    PlatformFailure,
    RuntimeReplaced,
    Timeout,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileDiagnosticCheckKind {
    ActiveNetwork,
    HttpsHandshake,
    Http204,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileDiagnosticCheckOutcome {
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileDiagnosticCheck {
    pub kind: MobileDiagnosticCheckKind,
    pub outcome: MobileDiagnosticCheckOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileDiagnosticRun {
    pub checks: Vec<MobileDiagnosticCheck>,
    pub failure: Option<MobileDiagnosticFailure>,
    pub operation_id: String,
    pub phase: MobileDiagnosticPhase,
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileDiagnosticPolicy {
    pub policy_id: String,
    pub target: String,
    pub timeout_millis: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileDiagnosticSnapshot {
    pub active_run: Option<MobileDiagnosticRun>,
    pub adapter_kind: String,
    pub application_order: MobileApplicationOrder,
    pub authority_id: String,
    pub history: Vec<MobileDiagnosticRun>,
    pub policy: MobileDiagnosticPolicy,
    pub sequence: u64,
    pub session_id: String,
}

impl MobileDiagnosticSnapshot {
    #[cfg(not(target_os = "android"))]
    pub(crate) fn unsupported() -> Self {
        Self {
            active_run: None,
            adapter_kind: "fixture".into(),
            application_order: MobileApplicationOrder {
                authority_id: "non-android-diagnostic".into(),
                epoch: 0,
                order: 0,
            },
            authority_id: "non-android-diagnostic".into(),
            history: Vec::new(),
            policy: MobileDiagnosticPolicy {
                policy_id: FIXED_DIAGNOSTIC_POLICY_ID.into(),
                target: FIXED_DIAGNOSTIC_TARGET.into(),
                timeout_millis: FIXED_DIAGNOSTIC_TIMEOUT_MILLIS,
            },
            sequence: 0,
            session_id: "non-android-diagnostic".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileDiagnosticCommandRequest {
    pub operation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileDiagnosticCommandResult {
    pub accepted: bool,
    pub operation_id: String,
    pub run_id: Option<String>,
    pub snapshot: MobileDiagnosticSnapshot,
}

#[derive(Clone, Debug)]
pub(crate) struct MobileDiagnosticAuthority {
    authority_id: String,
    epoch: u64,
    history: VecDeque<MobileDiagnosticRun>,
    active: Option<MobileDiagnosticRun>,
    sequence: u64,
    session_id: String,
}

impl MobileDiagnosticAuthority {
    pub(crate) fn new(state: &LifecycleState) -> Self {
        Self {
            authority_id: state.authority_id.clone(),
            epoch: state.scope_epoch,
            history: VecDeque::new(),
            active: None,
            sequence: 1,
            session_id: format!(
                "android-diagnostic-{}-{}",
                state.scope_epoch, state.session_id
            ),
        }
    }

    pub(crate) fn start(&mut self, operation_id: String, run_id: String) -> bool {
        if self.active.is_some() {
            return false;
        }
        self.sequence = self.sequence.saturating_add(1);
        self.active = Some(MobileDiagnosticRun {
            checks: Vec::new(),
            failure: None,
            operation_id,
            phase: MobileDiagnosticPhase::Pending,
            run_id,
        });
        true
    }

    pub(crate) fn active_run_id(&self) -> Option<&str> {
        self.active.as_ref().map(|run| run.run_id.as_str())
    }

    pub(crate) fn matches_active(&self, operation_id: &str, run_id: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|run| run.operation_id == operation_id && run.run_id == run_id)
    }

    pub(crate) fn finish(
        &mut self,
        run_id: &str,
        phase: MobileDiagnosticPhase,
        failure: Option<MobileDiagnosticFailure>,
        checks: Vec<MobileDiagnosticCheck>,
    ) -> bool {
        if self.active.as_ref().is_none_or(|run| run.run_id != run_id) {
            return false;
        }
        let mut run = self.active.take().expect("checked active diagnostic run");
        if checks.len() > MOBILE_DIAGNOSTIC_CHECK_LIMIT || !valid_terminal(phase, failure) {
            self.active = Some(run);
            return false;
        }
        run.phase = phase;
        run.failure = failure;
        run.checks = checks;
        self.sequence = self.sequence.saturating_add(1);
        self.history.push_back(run);
        while self.history.len() > MOBILE_DIAGNOSTIC_HISTORY_LIMIT {
            self.history.pop_front();
        }
        true
    }

    pub(crate) fn retire(&mut self) -> bool {
        let Some(run_id) = self.active_run_id().map(str::to_owned) else {
            return false;
        };
        self.finish(
            &run_id,
            MobileDiagnosticPhase::Replaced,
            Some(MobileDiagnosticFailure::RuntimeReplaced),
            Vec::new(),
        )
    }

    pub(crate) fn snapshot(&self) -> MobileDiagnosticSnapshot {
        MobileDiagnosticSnapshot {
            active_run: self.active.clone(),
            adapter_kind: "native".into(),
            application_order: MobileApplicationOrder {
                authority_id: self.authority_id.clone(),
                epoch: self.epoch,
                order: self.sequence,
            },
            authority_id: self.authority_id.clone(),
            history: self.history.iter().cloned().collect(),
            policy: MobileDiagnosticPolicy {
                policy_id: FIXED_DIAGNOSTIC_POLICY_ID.into(),
                target: FIXED_DIAGNOSTIC_TARGET.into(),
                timeout_millis: FIXED_DIAGNOSTIC_TIMEOUT_MILLIS,
            },
            sequence: self.sequence,
            session_id: self.session_id.clone(),
        }
    }
}

fn valid_terminal(phase: MobileDiagnosticPhase, failure: Option<MobileDiagnosticFailure>) -> bool {
    match phase {
        MobileDiagnosticPhase::Pending => false,
        MobileDiagnosticPhase::Completed => failure.is_none(),
        MobileDiagnosticPhase::Cancelled => failure == Some(MobileDiagnosticFailure::Cancelled),
        MobileDiagnosticPhase::TimedOut => failure == Some(MobileDiagnosticFailure::Timeout),
        MobileDiagnosticPhase::Replaced => {
            failure == Some(MobileDiagnosticFailure::RuntimeReplaced)
        }
        MobileDiagnosticPhase::Failed => matches!(
            failure,
            Some(
                MobileDiagnosticFailure::FixedTargetUnavailable
                    | MobileDiagnosticFailure::NetworkUnavailable
                    | MobileDiagnosticFailure::PlatformFailure
            )
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::platform_facts::ANDROID_PLATFORM_FACTS_GOLDEN_JSON;

    fn state(sequence: u64) -> LifecycleState {
        let mut facts: crate::generated::platform_facts::PlatformFacts =
            serde_json::from_str(ANDROID_PLATFORM_FACTS_GOLDEN_JSON).unwrap();
        facts.fact_sequence = sequence;
        LifecycleState::initial("authority-1".into(), "session-1".into(), facts)
    }

    #[test]
    fn events_rotate_explicitly_on_gap_and_are_bounded() {
        let initial = state(7);
        let mut events = MobileEventsAuthority::from_baseline(&initial);
        let later = state(9);
        assert!(events.observe(&later));
        let snapshot = events.snapshot(&later);
        assert_eq!(snapshot.reconnect_count, 1);
        assert_eq!(snapshot.events.len(), 2);
        assert!(
            snapshot.events[0]
                .evidence
                .as_ref()
                .unwrap()
                .message
                .contains("sequence gap")
        );
        assert!(snapshot.events.len() <= MOBILE_EVENTS_LIMIT);

        for sequence in 10..=1_050 {
            events.observe(&state(sequence));
        }
        let bounded = events.snapshot(&state(1_050));
        assert_eq!(bounded.events.len(), MOBILE_EVENTS_LIMIT);
        assert_eq!(
            bounded.events.last().map(|event| event.sequence),
            Some(bounded.sequence)
        );
    }

    #[test]
    fn diagnostic_rejects_late_completion_and_bounds_history() {
        let mut authority = MobileDiagnosticAuthority::new(&state(7));
        assert!(authority.start("op-1".into(), "run-1".into()));
        assert!(!authority.finish(
            "old-run",
            MobileDiagnosticPhase::Completed,
            None,
            Vec::new(),
        ));
        assert!(authority.finish(
            "run-1",
            MobileDiagnosticPhase::Cancelled,
            Some(MobileDiagnosticFailure::Cancelled),
            Vec::new(),
        ));
        for index in 2..=12 {
            assert!(authority.start(format!("op-{index}"), format!("run-{index}")));
            assert!(authority.finish(
                &format!("run-{index}"),
                MobileDiagnosticPhase::Completed,
                None,
                Vec::new(),
            ));
        }
        assert_eq!(
            authority.snapshot().history.len(),
            MOBILE_DIAGNOSTIC_HISTORY_LIMIT
        );
    }

    #[test]
    fn diagnostic_replacement_retires_once_and_late_completion_has_zero_mutation() {
        let mut authority = MobileDiagnosticAuthority::new(&state(7));
        assert!(authority.start("op-1".into(), "run-1".into()));
        assert!(authority.retire());
        let retired = authority.snapshot();
        assert_eq!(retired.history[0].phase, MobileDiagnosticPhase::Replaced);
        assert_eq!(
            retired.history[0].failure,
            Some(MobileDiagnosticFailure::RuntimeReplaced)
        );
        assert!(!authority.finish("run-1", MobileDiagnosticPhase::Completed, None, Vec::new(),));
        assert_eq!(authority.snapshot(), retired);
    }

    #[test]
    fn diagnostic_rejects_untyped_or_platform_owned_terminal_semantics() {
        let mut authority = MobileDiagnosticAuthority::new(&state(7));
        assert!(authority.start("op-1".into(), "run-1".into()));
        assert!(!authority.finish(
            "run-1",
            MobileDiagnosticPhase::Replaced,
            Some(MobileDiagnosticFailure::PlatformFailure),
            Vec::new(),
        ));
        assert!(!authority.finish("run-1", MobileDiagnosticPhase::Failed, None, Vec::new(),));
        assert!(authority.snapshot().active_run.is_some());
    }

    #[test]
    fn diagnostic_accepts_only_the_fixed_timeout_terminal_pair() {
        let mut authority = MobileDiagnosticAuthority::new(&state(7));
        assert!(authority.start("op-1".into(), "run-1".into()));
        assert!(authority.finish(
            "run-1",
            MobileDiagnosticPhase::TimedOut,
            Some(MobileDiagnosticFailure::Timeout),
            Vec::new(),
        ));
        let run = authority.snapshot().history.pop().unwrap();
        assert_eq!(run.phase, MobileDiagnosticPhase::TimedOut);
        assert_eq!(run.failure, Some(MobileDiagnosticFailure::Timeout));
    }
}
