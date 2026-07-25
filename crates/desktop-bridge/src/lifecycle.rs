use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use mish_runtime::{
    CaptureAuditReason, CaptureFailureKind, CorePhase, PlatformLifecycleEvent,
    PlatformLifecycleEventKind, PlatformLifecycleEventSource, RecentTrafficContinuity,
    RuntimeObservationPauseReason,
};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::DesktopRuntimeHost;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleEventDisposition {
    Applied,
    StaleIgnored,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LifecycleCoordinationError {
    pub capture_failure: CaptureFailureKind,
}

#[derive(Clone)]
pub struct DesktopLifecycleCoordinator {
    host: DesktopRuntimeHost,
    last_platform_sequence: Arc<AtomicU64>,
    sleeping: Arc<AtomicBool>,
    settings: Option<Arc<mish_settings::SettingsService>>,
    transition: Arc<AsyncMutex<()>>,
}

impl DesktopLifecycleCoordinator {
    pub fn new(host: DesktopRuntimeHost) -> Self {
        Self::with_settings(host, None)
    }

    pub fn with_settings(
        host: DesktopRuntimeHost,
        settings: Option<Arc<mish_settings::SettingsService>>,
    ) -> Self {
        Self {
            host,
            last_platform_sequence: Arc::new(AtomicU64::new(0)),
            sleeping: Arc::new(AtomicBool::new(false)),
            settings,
            transition: Arc::new(AsyncMutex::new(())),
        }
    }

    pub async fn handle_platform_event(
        &self,
        event: PlatformLifecycleEvent,
    ) -> Result<LifecycleEventDisposition, LifecycleCoordinationError> {
        let _transition = self.transition.lock().await;
        if event.sequence <= self.last_platform_sequence.load(Ordering::Acquire) {
            return Ok(LifecycleEventDisposition::StaleIgnored);
        }
        self.last_platform_sequence
            .store(event.sequence, Ordering::Release);

        match event.kind {
            PlatformLifecycleEventKind::Sleep => {
                self.sleeping.store(true, Ordering::Release);
                let runtime = self.host.current();
                let recent_revision = runtime.recent_traffic().snapshot().revision;
                self.host.suspend_recent_traffic();
                if runtime.recent_traffic().snapshot().revision != recent_revision {
                    runtime.publish_current_status().await;
                }
                self.invalidate_network_dns();
                self.host.invalidate_diagnostics();
                runtime
                    .pause_observations(RuntimeObservationPauseReason::Sleep)
                    .await;
                Ok(LifecycleEventDisposition::Applied)
            }
            PlatformLifecycleEventKind::Wake => {
                self.sleeping.store(false, Ordering::Release);
                self.invalidate_network_dns();
                self.rebuild_current_authority(RuntimeObservationPauseReason::NetworkChanged)
                    .await?;
                self.refresh_network_dns().await;
                Ok(LifecycleEventDisposition::Applied)
            }
            PlatformLifecycleEventKind::NetworkChanged => {
                self.invalidate_network_dns();
                self.rebuild_current_authority(RuntimeObservationPauseReason::NetworkChanged)
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
        self.host.invalidate_diagnostics();
        self.invalidate_network_dns();
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
        if self.sleeping.load(Ordering::Acquire) {
            return Ok(());
        }
        runtime.resume_observations().await;
        if let Err(error) = runtime.restore_capture_intent().await {
            let recent_revision = runtime.recent_traffic().snapshot().revision;
            self.host.discontinue_recent_traffic();
            if runtime.recent_traffic().snapshot().revision != recent_revision {
                runtime.publish_current_status().await;
            }
            return Err(capture_error(error));
        }
        let recent_revision = runtime.recent_traffic().snapshot().revision;
        self.host
            .resume_recent_traffic(RecentTrafficContinuity::Continue);
        if runtime.recent_traffic().snapshot().revision != recent_revision {
            runtime.publish_current_status().await;
        }
        self.refresh_network_dns().await;
        Ok(())
    }

    pub async fn periodic_audit(&self) -> Result<(), LifecycleCoordinationError> {
        if self.sleeping.load(Ordering::Acquire) {
            return Ok(());
        }
        let _transition = self.transition.lock().await;
        self.host
            .audit_capture(CaptureAuditReason::Periodic)
            .await
            .map(|_| ())
            .map_err(capture_error)
    }

    pub async fn reconcile_after_event_gap(&self) -> Result<(), LifecycleCoordinationError> {
        let _transition = self.transition.lock().await;
        self.rebuild_current_authority_locked(RuntimeObservationPauseReason::NetworkChanged)
            .await
    }

    async fn rebuild_current_authority(
        &self,
        reason: RuntimeObservationPauseReason,
    ) -> Result<(), LifecycleCoordinationError> {
        self.rebuild_current_authority_locked(reason).await
    }

    async fn rebuild_current_authority_locked(
        &self,
        reason: RuntimeObservationPauseReason,
    ) -> Result<(), LifecycleCoordinationError> {
        let runtime = self.host.current();
        self.host.invalidate_diagnostics();
        let recent_revision = runtime.recent_traffic().snapshot().revision;
        self.host.suspend_recent_traffic();
        if runtime.recent_traffic().snapshot().revision != recent_revision {
            runtime.publish_current_status().await;
        }
        runtime.pause_observations(reason).await;
        if self.sleeping.load(Ordering::Acquire) {
            return Ok(());
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
                    runtime.publish_current_status().await;
                }
                Ok(())
            }
            Err(error) => {
                let recent_revision = runtime.recent_traffic().snapshot().revision;
                self.host.discontinue_recent_traffic();
                if runtime.recent_traffic().snapshot().revision != recent_revision {
                    runtime.publish_current_status().await;
                }
                Err(capture_error(error))
            }
        }
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

pub(crate) fn spawn_lifecycle_coordination(
    host: DesktopRuntimeHost,
    source: Option<Arc<dyn PlatformLifecycleEventSource>>,
    settings: Option<Arc<mish_settings::SettingsService>>,
    service_probes: Option<crate::service_probes::ServiceProbeService>,
    mut shutdown: oneshot::Receiver<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let coordinator = DesktopLifecycleCoordinator::with_settings(host.clone(), settings);
        let mut platform_events = source.map(|source| source.subscribe());
        let mut runtime_changes = host.subscribe_changes();
        let initial_runtime = runtime_changes.borrow_and_update().clone();
        let mut status_updates = initial_runtime.subscribe_status();
        let mut was_running = matches!(
            initial_runtime.core_status().await.phase,
            CorePhase::Running
        );
        if was_running {
            if let Some(service_probes) = &service_probes {
                service_probes.test_after_core_start();
            }
        }
        let _ = host.audit_capture(CaptureAuditReason::Restart).await;
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
                    if running {
                        if let Some(service_probes) = &service_probes {
                            service_probes.test_after_core_start();
                        }
                    }
                    let _ = coordinator.handle_core_availability(running).await;
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
                        if running {
                            if let Some(service_probes) = &service_probes {
                                service_probes.test_after_core_start();
                            }
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
