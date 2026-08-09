#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::{
    future::Future,
    sync::{Arc, Mutex},
};

use mish_state_machine::{AdmissionError, RunnerHandle};
use tokio::sync::Notify;

use crate::{
    generated::platform_facts::PlatformFacts,
    lifecycle::{LifecycleInput, LifecycleMachine},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ObservationAdmission {
    Accepted,
    Backpressured,
    Coalesced,
    RebindRequired,
    SchemaRejected,
    Stale,
}

#[derive(Clone, Copy, Debug)]
enum IngressTerminal {
    RebindRequired,
    SchemaRejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunnerObservationAdmission {
    Accepted,
    Rejected,
    Retired,
    Saturated,
}

#[derive(Debug)]
struct IngressState {
    bound_session_id: Option<String>,
    delivered_sequence: u64,
    pending: Option<PlatformFacts>,
    terminal: Option<IngressTerminal>,
}

#[derive(Clone, Debug)]
pub(crate) struct PlatformObservationIngress {
    notify: Arc<Notify>,
    state: Arc<Mutex<IngressState>>,
}

impl PlatformObservationIngress {
    #[cfg(test)]
    pub(crate) fn new(bound_session_id: String, delivered_sequence: u64) -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            state: Arc::new(Mutex::new(IngressState {
                bound_session_id: Some(bound_session_id),
                delivered_sequence,
                pending: None,
                terminal: None,
            })),
        }
    }

    pub(crate) fn unbound() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            state: Arc::new(Mutex::new(IngressState {
                bound_session_id: None,
                delivered_sequence: 0,
                pending: None,
                terminal: None,
            })),
        }
    }

    pub(crate) fn bind_baseline(&self, facts: &PlatformFacts) -> ObservationAdmission {
        if facts.validate().is_err() {
            return self.reject_schema();
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(terminal) = state.terminal {
            return terminal.admission();
        }
        state.bound_session_id = Some(facts.platform_session_id.clone());
        state.delivered_sequence = facts.fact_sequence;
        if state.pending.as_ref().is_some_and(|pending| {
            pending.platform_session_id != facts.platform_session_id
                || pending.fact_sequence <= facts.fact_sequence
        }) {
            state.pending = None;
        }
        ObservationAdmission::Accepted
    }

    pub(crate) fn offer_json(&self, json: &str) -> ObservationAdmission {
        let facts = match serde_json::from_str::<PlatformFacts>(json) {
            Ok(facts) if facts.validate().is_ok() => facts,
            Ok(_) | Err(_) => return self.reject_schema(),
        };
        self.offer(facts)
    }

    pub(crate) fn offer(&self, facts: PlatformFacts) -> ObservationAdmission {
        if facts.validate().is_err() {
            return self.reject_schema();
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(terminal) = state.terminal {
            return terminal.admission();
        }
        if state
            .bound_session_id
            .as_ref()
            .is_some_and(|session_id| facts.platform_session_id != *session_id)
        {
            state.terminal = Some(IngressTerminal::RebindRequired);
            state.pending = None;
            drop(state);
            self.notify.notify_waiters();
            return ObservationAdmission::RebindRequired;
        }
        if facts.fact_sequence <= state.delivered_sequence
            || state
                .pending
                .as_ref()
                .is_some_and(|pending| facts.fact_sequence <= pending.fact_sequence)
        {
            return ObservationAdmission::Stale;
        }
        let outcome = if state.pending.replace(facts).is_some() {
            ObservationAdmission::Coalesced
        } else {
            ObservationAdmission::Accepted
        };
        drop(state);
        self.notify.notify_one();
        outcome
    }

    pub(crate) fn requires_rebind(&self) -> bool {
        self.terminal_admission().is_some()
    }

    pub(crate) fn terminal_admission(&self) -> Option<ObservationAdmission> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .terminal
            .map(IngressTerminal::admission)
    }

    pub(crate) fn require_rebind(&self) {
        self.retire();
    }

    pub(crate) async fn deliver_next(
        &self,
        runner: &RunnerHandle<LifecycleMachine>,
    ) -> ObservationAdmission {
        self.deliver_with(|facts| async move {
            match runner
                .try_admit(LifecycleInput::PlatformObserved(facts))
                .await
            {
                Ok(_) => RunnerObservationAdmission::Accepted,
                Err(AdmissionError::InboxSaturated) => RunnerObservationAdmission::Saturated,
                Err(AdmissionError::Retired) => RunnerObservationAdmission::Retired,
                Err(AdmissionError::Rejected(_)) => RunnerObservationAdmission::Rejected,
            }
        })
        .await
    }

    async fn deliver_with<F, Fut>(&self, admit: F) -> ObservationAdmission
    where
        F: FnOnce(PlatformFacts) -> Fut,
        Fut: Future<Output = RunnerObservationAdmission>,
    {
        let facts = match self.next().await {
            Ok(facts) => facts,
            Err(IngressTerminal::RebindRequired) => {
                return ObservationAdmission::RebindRequired;
            }
            Err(IngressTerminal::SchemaRejected) => return ObservationAdmission::SchemaRejected,
        };
        match admit(facts.clone()).await {
            RunnerObservationAdmission::Accepted => {
                self.mark_delivered(facts.fact_sequence);
                ObservationAdmission::Accepted
            }
            RunnerObservationAdmission::Saturated => {
                self.requeue_after_backpressure(facts);
                ObservationAdmission::Backpressured
            }
            RunnerObservationAdmission::Retired | RunnerObservationAdmission::Rejected => {
                self.retire();
                ObservationAdmission::RebindRequired
            }
        }
    }

    fn reject_schema(&self) -> ObservationAdmission {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.terminal = Some(IngressTerminal::SchemaRejected);
        state.pending = None;
        drop(state);
        self.notify.notify_waiters();
        ObservationAdmission::SchemaRejected
    }

    fn retire(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.terminal = Some(IngressTerminal::RebindRequired);
        state.pending = None;
        drop(state);
        self.notify.notify_waiters();
    }

    async fn next(&self) -> Result<PlatformFacts, IngressTerminal> {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(terminal) = state.terminal {
                    return Err(terminal);
                }
                if let Some(facts) = state.pending.take() {
                    return Ok(facts);
                }
            }
            notified.await;
        }
    }

    fn mark_delivered(&self, sequence: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.delivered_sequence = state.delivered_sequence.max(sequence);
    }

    fn requeue_after_backpressure(&self, facts: PlatformFacts) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.terminal.is_some() {
            return;
        }
        if state
            .pending
            .as_ref()
            .is_none_or(|pending| pending.fact_sequence < facts.fact_sequence)
        {
            state.pending = Some(facts);
        }
        drop(state);
        self.notify.notify_one();
    }
}

impl IngressTerminal {
    fn admission(self) -> ObservationAdmission {
        match self {
            Self::RebindRequired => ObservationAdmission::RebindRequired,
            Self::SchemaRejected => ObservationAdmission::SchemaRejected,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{future::Future, pin::Pin, sync::Arc};

    use mish_state_machine::{
        Disposition, EffectExecutor, RunnerConfig, TransitionObserver, spawn_runner,
    };
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::{
        generated::platform_facts::{
            ANDROID_PLATFORM_FACTS_GOLDEN_JSON, PlatformEventKind, PlatformFailureKind,
            VpnPermission,
        },
        lifecycle::{LifecycleEffect, LifecyclePhase, LifecycleState},
    };

    fn facts(sequence: u64) -> PlatformFacts {
        let mut value: serde_json::Value =
            serde_json::from_str(ANDROID_PLATFORM_FACTS_GOLDEN_JSON).expect("golden facts");
        value["factSequence"] = sequence.into();
        value["observedAtMillis"] = sequence.into();
        serde_json::from_value(value).expect("facts fixture")
    }

    #[test]
    fn burst_coalesces_to_terminal_last_without_an_unbounded_queue() {
        let ingress = PlatformObservationIngress::new("platform-session-1".into(), 7);
        for sequence in 8..=128 {
            let outcome = ingress.offer(facts(sequence));
            assert!(matches!(
                outcome,
                ObservationAdmission::Accepted | ObservationAdmission::Coalesced
            ));
        }
        let state = ingress
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(
            state.pending.as_ref().map(|facts| facts.fact_sequence),
            Some(128)
        );
    }

    #[test]
    fn duplicate_stale_replacement_and_malformed_inputs_are_typed() {
        let ingress = PlatformObservationIngress::new("platform-session-1".into(), 7);
        assert_eq!(ingress.offer(facts(7)), ObservationAdmission::Stale);
        assert_eq!(ingress.offer(facts(8)), ObservationAdmission::Accepted);
        assert_eq!(ingress.offer(facts(8)), ObservationAdmission::Stale);
        let mut replacement = facts(9);
        replacement.platform_session_id = "platform-session-2".into();
        assert_eq!(
            ingress.offer(replacement),
            ObservationAdmission::RebindRequired
        );

        let malformed = PlatformObservationIngress::new("platform-session-1".into(), 7);
        assert_eq!(
            malformed.offer_json(r#"{"factsVersion":1,"event":"future-kind"}"#),
            ObservationAdmission::SchemaRejected
        );
        assert_eq!(
            malformed.offer(facts(8)),
            ObservationAdmission::SchemaRejected
        );
        assert_eq!(
            malformed.bind_baseline(&facts(8)),
            ObservationAdmission::SchemaRejected
        );
        let missing_nullable = PlatformObservationIngress::new("platform-session-1".into(), 7);
        let mut missing: serde_json::Value =
            serde_json::from_str(ANDROID_PLATFORM_FACTS_GOLDEN_JSON).expect("golden facts");
        missing
            .as_object_mut()
            .expect("facts object")
            .remove("activationFailure");
        assert_eq!(
            missing_nullable.offer_json(&missing.to_string()),
            ObservationAdmission::SchemaRejected
        );
    }

    #[tokio::test]
    async fn runner_saturation_retains_latest_and_retirement_requires_rebind() {
        let ingress = PlatformObservationIngress::new("platform-session-1".into(), 7);
        assert_eq!(ingress.offer(facts(10)), ObservationAdmission::Accepted);
        assert_eq!(
            ingress
                .deliver_with(|_| async { RunnerObservationAdmission::Saturated })
                .await,
            ObservationAdmission::Backpressured
        );
        assert_eq!(
            ingress
                .deliver_with(|facts| async move {
                    assert_eq!(facts.fact_sequence, 10);
                    RunnerObservationAdmission::Accepted
                })
                .await,
            ObservationAdmission::Accepted
        );
        assert_eq!(ingress.offer(facts(11)), ObservationAdmission::Accepted);
        assert_eq!(
            ingress
                .deliver_with(|_| async { RunnerObservationAdmission::Retired })
                .await,
            ObservationAdmission::RebindRequired
        );
        assert!(ingress.requires_rebind());
    }

    struct UnusedExecutor;

    impl EffectExecutor<LifecycleMachine> for UnusedExecutor {
        fn execute(
            &self,
            _: LifecycleEffect,
            _: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = LifecycleInput> + Send + 'static>> {
            Box::pin(async { panic!("passive observation unexpectedly emitted an effect") })
        }
    }

    struct NoopObserver;

    impl TransitionObserver<LifecycleMachine> for NoopObserver {
        fn transitioned(
            &self,
            _: &LifecycleState,
            _: &LifecycleInput,
            _: &LifecycleState,
            _: Disposition,
        ) {
        }
    }

    #[tokio::test]
    async fn passive_terminal_kinds_are_terminal_last_after_a_burst() {
        let cases = [
            (
                PlatformEventKind::Revoked,
                LifecyclePhase::PermissionRequired,
            ),
            (PlatformEventKind::CoreExited, LifecyclePhase::Failed),
            (
                PlatformEventKind::NetworkChanged,
                LifecyclePhase::Unavailable,
            ),
            (PlatformEventKind::ServiceDestroyed, LifecyclePhase::Failed),
            (PlatformEventKind::StopCompleted, LifecyclePhase::Stopped),
        ];
        for (event, expected_phase) in cases {
            let initial =
                LifecycleState::initial("authority-1".into(), "session-1".into(), facts(7));
            let runner = spawn_runner(
                Arc::new(LifecycleMachine),
                initial,
                Arc::new(UnusedExecutor),
                Arc::new(NoopObserver),
                RunnerConfig::default(),
            );
            let ingress = PlatformObservationIngress::new("platform-session-1".into(), 7);
            for sequence in 8..=64 {
                assert!(matches!(
                    ingress.offer(facts(sequence)),
                    ObservationAdmission::Accepted | ObservationAdmission::Coalesced
                ));
            }
            let mut terminal = facts(65);
            terminal.event = event;
            if event == PlatformEventKind::Revoked {
                terminal.vpn_permission = VpnPermission::Required;
                terminal.activation_failure = Some(PlatformFailureKind::PermissionRevoked);
            }
            if event == PlatformEventKind::CoreExited {
                terminal.activation_failure = Some(PlatformFailureKind::CoreExited);
            }
            assert_eq!(ingress.offer(terminal), ObservationAdmission::Coalesced);
            assert_eq!(
                ingress.deliver_next(&runner).await,
                ObservationAdmission::Accepted
            );
            assert_eq!(runner.snapshot().phase, expected_phase);
            runner.shutdown().await;
        }
    }
}
