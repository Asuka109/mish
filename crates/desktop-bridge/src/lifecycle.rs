use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use mish_runtime::{
    CaptureAuditReason, CaptureFailureKind, CorePhase, PlatformLifecycleEvent,
    PlatformLifecycleEventKind, PlatformLifecycleEventSource, PlatformSleepObservation,
    PlatformSleepState, RecentTrafficContinuity, RuntimeObservationPauseReason,
};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::DesktopRuntimeHost;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleEventDisposition {
    Applied,
    AwaitingRecovery,
    RecoveredAfterGap,
    StaleIgnored,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleAuthorityState {
    Awake,
    Sleeping,
    UnknownAfterGap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleRecoveryState {
    Current,
    ObservationTimedOut,
    ObservationUnavailable,
    ObservingAfterGap,
    StaleObservation,
    StreamClosed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LifecycleAuthoritySnapshot {
    pub generation: u64,
    pub recovery: LifecycleRecoveryState,
    pub sequence: u64,
    pub state: LifecycleAuthorityState,
}

impl LifecycleAuthoritySnapshot {
    fn initial() -> Self {
        Self {
            generation: 1,
            recovery: LifecycleRecoveryState::Current,
            sequence: 0,
            state: LifecycleAuthorityState::Awake,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LifecycleCoordinationError {
    pub capture_failure: CaptureFailureKind,
}

#[derive(Clone)]
pub struct DesktopLifecycleCoordinator {
    authority: Arc<Mutex<LifecycleAuthoritySnapshot>>,
    host: DesktopRuntimeHost,
    observation_timeout: Duration,
    platform_source: Option<Arc<dyn PlatformLifecycleEventSource>>,
    settings: Option<Arc<mish_settings::SettingsService>>,
    transition: Arc<AsyncMutex<()>>,
}

const DEFAULT_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(1);

impl DesktopLifecycleCoordinator {
    pub fn new(host: DesktopRuntimeHost) -> Self {
        Self::with_settings(host, None)
    }

    pub fn with_settings(
        host: DesktopRuntimeHost,
        settings: Option<Arc<mish_settings::SettingsService>>,
    ) -> Self {
        Self::with_platform_source_and_timeout(host, settings, None, DEFAULT_OBSERVATION_TIMEOUT)
    }

    pub fn with_platform_source(
        host: DesktopRuntimeHost,
        settings: Option<Arc<mish_settings::SettingsService>>,
        platform_source: Arc<dyn PlatformLifecycleEventSource>,
    ) -> Self {
        Self::with_platform_source_and_timeout(
            host,
            settings,
            Some(platform_source),
            DEFAULT_OBSERVATION_TIMEOUT,
        )
    }

    pub fn with_platform_source_and_timeout(
        host: DesktopRuntimeHost,
        settings: Option<Arc<mish_settings::SettingsService>>,
        platform_source: Option<Arc<dyn PlatformLifecycleEventSource>>,
        observation_timeout: Duration,
    ) -> Self {
        Self {
            authority: Arc::new(Mutex::new(LifecycleAuthoritySnapshot::initial())),
            host,
            observation_timeout,
            platform_source,
            settings,
            transition: Arc::new(AsyncMutex::new(())),
        }
    }

    pub fn authority_snapshot(&self) -> LifecycleAuthoritySnapshot {
        *self
            .authority
            .lock()
            .expect("lifecycle authority lock poisoned")
    }

    pub async fn initialize_platform_authority(&self) {
        let _transition = self.transition.lock().await;
        let Some(source) = self.platform_source.clone() else {
            return;
        };
        let observation =
            tokio::time::timeout(self.observation_timeout, source.observe_sleep_state()).await;
        let Ok(Ok(observation)) = observation else {
            self.mark_unknown(match observation {
                Err(_) => LifecycleRecoveryState::ObservationTimedOut,
                Ok(Err(_)) => LifecycleRecoveryState::ObservationUnavailable,
                Ok(Ok(_)) => unreachable!(),
            });
            self.discontinue_consumers_after_gap().await;
            return;
        };
        let previous = self.authority_snapshot().state;
        {
            let mut authority = self
                .authority
                .lock()
                .expect("lifecycle authority lock poisoned");
            authority.sequence = observation.sequence;
            authority.recovery = LifecycleRecoveryState::Current;
            authority.state = match observation.state {
                PlatformSleepState::Awake => LifecycleAuthorityState::Awake,
                PlatformSleepState::Sleeping => LifecycleAuthorityState::Sleeping,
            };
        }
        if previous == LifecycleAuthorityState::Awake
            && observation.state == PlatformSleepState::Sleeping
        {
            self.suspend_consumers(RuntimeObservationPauseReason::Sleep)
                .await;
        }
    }

    pub async fn handle_platform_event(
        &self,
        event: PlatformLifecycleEvent,
    ) -> Result<LifecycleEventDisposition, LifecycleCoordinationError> {
        let _transition = self.transition.lock().await;
        let authority = self.authority_snapshot();
        if event.sequence <= authority.sequence {
            return Ok(LifecycleEventDisposition::StaleIgnored);
        }

        if self.platform_source.is_some() && event.sequence > authority.sequence.saturating_add(1) {
            self.recover_after_event_gap_locked().await?;
            let recovered = self.authority_snapshot();
            if event.sequence <= recovered.sequence {
                return Ok(LifecycleEventDisposition::RecoveredAfterGap);
            }
            if recovered.state == LifecycleAuthorityState::UnknownAfterGap
                && event.kind == PlatformLifecycleEventKind::NetworkChanged
            {
                self.authority
                    .lock()
                    .expect("lifecycle authority lock poisoned")
                    .sequence = event.sequence;
                return Ok(LifecycleEventDisposition::AwaitingRecovery);
            }
        }

        let previous = self.authority_snapshot().state;
        if previous == LifecycleAuthorityState::UnknownAfterGap
            && event.kind == PlatformLifecycleEventKind::NetworkChanged
        {
            self.authority
                .lock()
                .expect("lifecycle authority lock poisoned")
                .sequence = event.sequence;
            return Ok(LifecycleEventDisposition::AwaitingRecovery);
        }
        {
            let mut authority = self
                .authority
                .lock()
                .expect("lifecycle authority lock poisoned");
            authority.sequence = event.sequence;
            authority.recovery = LifecycleRecoveryState::Current;
            match event.kind {
                PlatformLifecycleEventKind::Sleep => {
                    authority.state = LifecycleAuthorityState::Sleeping;
                }
                PlatformLifecycleEventKind::Wake => {
                    authority.state = LifecycleAuthorityState::Awake;
                }
                PlatformLifecycleEventKind::NetworkChanged => {}
            }
        }

        match event.kind {
            PlatformLifecycleEventKind::Sleep => {
                if previous == LifecycleAuthorityState::Awake {
                    self.suspend_consumers(RuntimeObservationPauseReason::Sleep)
                        .await;
                }
                Ok(LifecycleEventDisposition::Applied)
            }
            PlatformLifecycleEventKind::Wake => {
                if previous != LifecycleAuthorityState::Awake {
                    self.invalidate_network_dns();
                    self.rebuild_current_authority_locked(
                        RuntimeObservationPauseReason::NetworkChanged,
                        false,
                    )
                    .await?;
                    self.refresh_network_dns().await;
                }
                Ok(LifecycleEventDisposition::Applied)
            }
            PlatformLifecycleEventKind::NetworkChanged => {
                if self.authority_snapshot().state != LifecycleAuthorityState::Awake {
                    return Ok(LifecycleEventDisposition::Applied);
                }
                self.invalidate_network_dns();
                self.rebuild_current_authority_locked(
                    RuntimeObservationPauseReason::NetworkChanged,
                    true,
                )
                .await?;
                self.refresh_network_dns().await;
                Ok(LifecycleEventDisposition::Applied)
            }
        }
    }

    pub async fn handle_core_availability(
        &self,
        running: bool,
    ) -> Result<(), LifecycleCoordinationError> {
        let _transition = self.transition.lock().await;
        let runtime = self.host.current();
        let state = self.authority_snapshot().state;
        self.invalidate_network_dns();
        if state != LifecycleAuthorityState::Awake {
            if running {
                self.host.suspend_recent_traffic();
                runtime.pause_observations(pause_reason_for(state)).await;
            }
            return Ok(());
        }
        if !running {
            self.host.suspend_recent_traffic();
            runtime
                .pause_observations(RuntimeObservationPauseReason::CoreUnavailable)
                .await;
            return runtime
                .audit_capture(CaptureAuditReason::CoreHealthChanged)
                .await
                .map(|_| ())
                .map_err(capture_error);
        }
        runtime.resume_observations().await;
        if let Err(error) = runtime.restore_capture_intent().await {
            let recent_revision = runtime.recent_traffic().snapshot().revision;
            self.host.discontinue_recent_traffic();
            if runtime.recent_traffic().snapshot().revision != recent_revision {
                runtime.publish_coordinator_observation().await;
            }
            return Err(capture_error(error));
        }
        let recent_revision = runtime.recent_traffic().snapshot().revision;
        self.host
            .resume_recent_traffic(RecentTrafficContinuity::Continue);
        if runtime.recent_traffic().snapshot().revision != recent_revision {
            runtime.publish_coordinator_observation().await;
        }
        self.refresh_network_dns().await;
        Ok(())
    }

    pub async fn handle_runtime_replacement(
        &self,
        running: bool,
    ) -> Result<(), LifecycleCoordinationError> {
        let _transition = self.transition.lock().await;
        let runtime = self.host.current();
        let state = self.authority_snapshot().state;
        self.invalidate_network_dns();
        if state != LifecycleAuthorityState::Awake {
            self.host.suspend_recent_traffic();
            runtime.pause_observations(pause_reason_for(state)).await;
            return Ok(());
        }
        if !running {
            self.host.suspend_recent_traffic();
            runtime
                .pause_observations(RuntimeObservationPauseReason::CoreUnavailable)
                .await;
            return runtime
                .audit_capture(CaptureAuditReason::CoreHealthChanged)
                .await
                .map(|_| ())
                .map_err(capture_error);
        }
        // Managed activation already commits the requested Capture state before replacing the
        // runtime. A replacement is not a Core restart: replaying the retained mode selection
        // here would turn an intentionally inactive selection back into active capture.
        runtime.resume_observations().await;
        let recent_revision = runtime.recent_traffic().snapshot().revision;
        self.host
            .resume_recent_traffic(RecentTrafficContinuity::Continue);
        if runtime.recent_traffic().snapshot().revision != recent_revision {
            runtime.publish_coordinator_observation().await;
        }
        self.refresh_network_dns().await;
        Ok(())
    }

    pub async fn periodic_audit(&self) -> Result<(), LifecycleCoordinationError> {
        let _transition = self.transition.lock().await;
        if self.authority_snapshot().state != LifecycleAuthorityState::Awake {
            return Ok(());
        }
        self.host
            .audit_capture(CaptureAuditReason::Periodic)
            .await
            .map(|_| ())
            .map_err(capture_error)
    }

    pub async fn reconcile_after_event_gap(&self) -> Result<(), LifecycleCoordinationError> {
        let _transition = self.transition.lock().await;
        self.recover_after_event_gap_locked().await
    }

    pub async fn handle_event_stream_closed(&self) {
        let _transition = self.transition.lock().await;
        self.mark_unknown(LifecycleRecoveryState::StreamClosed);
        self.discontinue_consumers_after_gap().await;
    }

    async fn rebuild_current_authority_locked(
        &self,
        reason: RuntimeObservationPauseReason,
        pause_before_rebuild: bool,
    ) -> Result<(), LifecycleCoordinationError> {
        if self.authority_snapshot().state != LifecycleAuthorityState::Awake {
            return Ok(());
        }
        let runtime = self.host.current();
        if runtime.capture_operation_pending() {
            return Ok(());
        }
        if pause_before_rebuild {
            let recent_revision = runtime.recent_traffic().snapshot().revision;
            self.host.suspend_recent_traffic();
            if runtime.recent_traffic().snapshot().revision != recent_revision {
                runtime.publish_coordinator_observation().await;
            }
            runtime.pause_observations(reason).await;
        }
        let core = runtime.core_status().await;
        if !matches!(core.phase, CorePhase::Running) || !runtime.core_configured() {
            return runtime
                .audit_capture(CaptureAuditReason::CoreHealthChanged)
                .await
                .map(|_| ())
                .map_err(capture_error);
        }
        runtime.resume_observations().await;
        match runtime.restore_capture_intent().await {
            Ok(_) => {
                let recent_revision = runtime.recent_traffic().snapshot().revision;
                self.host
                    .resume_recent_traffic(RecentTrafficContinuity::Continue);
                if runtime.recent_traffic().snapshot().revision != recent_revision {
                    runtime.publish_coordinator_observation().await;
                }
                Ok(())
            }
            Err(error) => {
                let recent_revision = runtime.recent_traffic().snapshot().revision;
                self.host.discontinue_recent_traffic();
                if runtime.recent_traffic().snapshot().revision != recent_revision {
                    runtime.publish_coordinator_observation().await;
                }
                Err(capture_error(error))
            }
        }
    }

    async fn recover_after_event_gap_locked(&self) -> Result<(), LifecycleCoordinationError> {
        self.mark_unknown(LifecycleRecoveryState::ObservingAfterGap);
        self.discontinue_consumers_after_gap().await;

        let Some(source) = self.platform_source.clone() else {
            self.set_recovery(LifecycleRecoveryState::ObservationUnavailable);
            return Ok(());
        };
        let observation =
            tokio::time::timeout(self.observation_timeout, source.observe_sleep_state()).await;
        match observation {
            Err(_) => {
                self.set_recovery(LifecycleRecoveryState::ObservationTimedOut);
            }
            Ok(Err(_)) => {
                self.set_recovery(LifecycleRecoveryState::ObservationUnavailable);
            }
            Ok(Ok(observation)) => {
                self.accept_platform_observation(observation).await?;
            }
        }
        Ok(())
    }

    async fn accept_platform_observation(
        &self,
        observation: PlatformSleepObservation,
    ) -> Result<(), LifecycleCoordinationError> {
        if observation.sequence <= self.authority_snapshot().sequence {
            self.set_recovery(LifecycleRecoveryState::StaleObservation);
            return Ok(());
        }
        {
            let mut authority = self
                .authority
                .lock()
                .expect("lifecycle authority lock poisoned");
            authority.sequence = observation.sequence;
            authority.recovery = LifecycleRecoveryState::Current;
            authority.state = match observation.state {
                PlatformSleepState::Awake => LifecycleAuthorityState::Awake,
                PlatformSleepState::Sleeping => LifecycleAuthorityState::Sleeping,
            };
        }
        if observation.state == PlatformSleepState::Awake {
            self.rebuild_current_authority_locked(
                RuntimeObservationPauseReason::LifecycleGap,
                false,
            )
            .await?;
            self.refresh_network_dns().await;
        }
        Ok(())
    }

    fn mark_unknown(&self, recovery: LifecycleRecoveryState) {
        let mut authority = self
            .authority
            .lock()
            .expect("lifecycle authority lock poisoned");
        authority.generation = authority.generation.saturating_add(1);
        authority.recovery = recovery;
        authority.state = LifecycleAuthorityState::UnknownAfterGap;
    }

    fn set_recovery(&self, recovery: LifecycleRecoveryState) {
        self.authority
            .lock()
            .expect("lifecycle authority lock poisoned")
            .recovery = recovery;
    }

    async fn suspend_consumers(&self, reason: RuntimeObservationPauseReason) {
        self.invalidate_network_dns();
        let runtime = self.host.current();
        let recent_revision = runtime.recent_traffic().snapshot().revision;
        self.host.suspend_recent_traffic();
        if runtime.recent_traffic().snapshot().revision != recent_revision {
            runtime.publish_coordinator_observation().await;
        }
        runtime.pause_observations(reason).await;
    }

    async fn discontinue_consumers_after_gap(&self) {
        self.invalidate_network_dns();
        let runtime = self.host.current();
        let recent_revision = runtime.recent_traffic().snapshot().revision;
        self.host.discontinue_recent_traffic();
        if runtime.recent_traffic().snapshot().revision != recent_revision {
            runtime.publish_coordinator_observation().await;
        }
        runtime
            .pause_observations(RuntimeObservationPauseReason::LifecycleGap)
            .await;
    }

    fn invalidate_network_dns(&self) {
        if let Some(settings) = &self.settings {
            settings.invalidate_network_dns();
        }
    }

    async fn refresh_network_dns(&self) {
        if let Some(settings) = &self.settings {
            settings.refresh_network_dns().await;
        }
    }
}

fn pause_reason_for(state: LifecycleAuthorityState) -> RuntimeObservationPauseReason {
    match state {
        LifecycleAuthorityState::Awake => RuntimeObservationPauseReason::NetworkChanged,
        LifecycleAuthorityState::Sleeping => RuntimeObservationPauseReason::Sleep,
        LifecycleAuthorityState::UnknownAfterGap => RuntimeObservationPauseReason::LifecycleGap,
    }
}

pub(crate) fn spawn_lifecycle_coordination(
    host: DesktopRuntimeHost,
    source: Option<Arc<dyn PlatformLifecycleEventSource>>,
    settings: Option<Arc<mish_settings::SettingsService>>,
    service_probes: Option<crate::service_probes::ServiceProbeService>,
    mut shutdown: oneshot::Receiver<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let coordinator = DesktopLifecycleCoordinator::with_platform_source_and_timeout(
            host.clone(),
            settings,
            source.clone(),
            DEFAULT_OBSERVATION_TIMEOUT,
        );
        let mut platform_events = source.as_ref().map(|source| source.subscribe());
        coordinator.initialize_platform_authority().await;
        let mut runtime_changes = host.subscribe_changes();
        let initial_runtime = runtime_changes.borrow_and_update().clone();
        let mut status_updates = initial_runtime.subscribe_status();
        let mut was_running = matches!(
            initial_runtime.core_status().await.phase,
            CorePhase::Running
        );
        if was_running && let Some(service_probes) = &service_probes {
            service_probes.test_after_core_start();
        }
        if coordinator.authority_snapshot().state == LifecycleAuthorityState::Awake {
            let _ = host.audit_capture(CaptureAuditReason::Restart).await;
        }
        let mut periodic = tokio::time::interval(std::time::Duration::from_secs(5));
        periodic.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        periodic.tick().await;

        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown => break,
                changed = runtime_changes.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let runtime = runtime_changes.borrow_and_update().clone();
                    status_updates = runtime.subscribe_status();
                    let running = matches!(runtime.core_status().await.phase, CorePhase::Running);
                    was_running = running;
                    if running
                        && let Some(service_probes) = &service_probes
                    {
                        service_probes.test_after_core_start();
                    }
                    let _ = coordinator.handle_runtime_replacement(running).await;
                }
                event = receive_platform_event(&mut platform_events), if platform_events.is_some() => {
                    match event {
                        Some(Ok(event)) => {
                            let _ = coordinator.handle_platform_event(event).await;
                        }
                        Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                            let _ = coordinator.reconcile_after_event_gap().await;
                        }
                        Some(Err(tokio::sync::broadcast::error::RecvError::Closed)) | None => {
                            coordinator.handle_event_stream_closed().await;
                            platform_events = None;
                        }
                    }
                }
                update = status_updates.recv() => {
                    let Ok(status) = update else {
                        continue;
                    };
                    let running = matches!(status.phase, CorePhase::Running);
                    if running != was_running {
                        was_running = running;
                        if running
                            && let Some(service_probes) = &service_probes
                        {
                            service_probes.test_after_core_start();
                        }
                        let _ = coordinator.handle_core_availability(running).await;
                    }
                }
                _ = periodic.tick() => {
                    let _ = coordinator.periodic_audit().await;
                }
            }
        }
    })
}

async fn receive_platform_event(
    receiver: &mut Option<tokio::sync::broadcast::Receiver<PlatformLifecycleEvent>>,
) -> Option<Result<PlatformLifecycleEvent, tokio::sync::broadcast::error::RecvError>> {
    match receiver {
        Some(receiver) => Some(receiver.recv().await),
        None => None,
    }
}

fn capture_error(error: mish_runtime::CaptureTransitionError) -> LifecycleCoordinationError {
    LifecycleCoordinationError {
        capture_failure: error.kind,
    }
}
