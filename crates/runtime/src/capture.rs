use std::{
    fmt,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::CapabilityAvailability;
use crate::CaptureSelection;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureFailureKind {
    ApplyFailed,
    CapabilityUnavailable,
    ConfirmationFailed,
    CoreUnhealthy,
    ExternalDrift,
    InvalidRecovery,
    ListenerUnavailable,
    ObservationFailed,
    PermissionDenied,
    PersistenceFailed,
    RollbackFailed,
    RuntimeTransition,
    UnsafeExistingConfiguration,
    UnsupportedSelection,
}

#[derive(Clone, Debug)]
pub struct CaptureTransitionError {
    pub kind: CaptureFailureKind,
    message: &'static str,
}

impl CaptureTransitionError {
    pub const fn new(kind: CaptureFailureKind, message: &'static str) -> Self {
        Self { kind, message }
    }
}

impl fmt::Display for CaptureTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for CaptureTransitionError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualProxyState {
    pub authenticated: bool,
    pub enabled: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
}

impl ManualProxyState {
    pub const fn disabled() -> Self {
        Self {
            authenticated: false,
            enabled: false,
            host: None,
            port: None,
        }
    }

    fn for_endpoint(endpoint: &LoopbackProxyEndpoint) -> Self {
        Self {
            authenticated: false,
            enabled: true,
            host: Some(endpoint.host.to_string()),
            port: Some(endpoint.port),
        }
    }

    fn effectively_equals(&self, other: &Self) -> bool {
        if !self.enabled && !other.enabled {
            return true;
        }
        self == other
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkServiceProxyState {
    pub auto_discovery_enabled: bool,
    pub http: ManualProxyState,
    pub https: ManualProxyState,
    pub pac_enabled: bool,
    pub service_id: String,
    pub socks: ManualProxyState,
}

impl NetworkServiceProxyState {
    fn has_unsafe_configuration(&self) -> bool {
        self.pac_enabled
            || self.auto_discovery_enabled
            || [&self.http, &self.https, &self.socks]
                .into_iter()
                .any(|proxy| proxy.enabled && proxy.authenticated)
    }
    pub fn is_mish_endpoint(&self, endpoint: &LoopbackProxyEndpoint) -> bool {
        let expected = Self::manual_proxy_target(endpoint);
        self.http == expected && self.https == expected && self.socks == expected
    }

    fn with_endpoint(&self, endpoint: &LoopbackProxyEndpoint) -> Self {
        Self {
            auto_discovery_enabled: self.auto_discovery_enabled,
            http: Self::manual_proxy_target(endpoint),
            https: Self::manual_proxy_target(endpoint),
            pac_enabled: self.pac_enabled,
            service_id: self.service_id.clone(),
            socks: Self::manual_proxy_target(endpoint),
        }
    }

    fn effectively_equals(&self, other: &Self) -> bool {
        self.service_id == other.service_id
            && self.auto_discovery_enabled == other.auto_discovery_enabled
            && self.pac_enabled == other.pac_enabled
            && self.http.effectively_equals(&other.http)
            && self.https.effectively_equals(&other.https)
            && self.socks.effectively_equals(&other.socks)
    }

    fn manual_proxy_target(endpoint: &LoopbackProxyEndpoint) -> ManualProxyState {
        ManualProxyState::for_endpoint(endpoint)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoopbackProxyEndpoint {
    host: IpAddr,
    port: u16,
}

impl LoopbackProxyEndpoint {
    pub fn new(host: &str, port: u16) -> Result<Self, CaptureTransitionError> {
        let host = host.parse::<IpAddr>().map_err(|_| {
            CaptureTransitionError::new(
                CaptureFailureKind::UnsupportedSelection,
                "The managed proxy endpoint must be a loopback IP address",
            )
        })?;
        if !host.is_loopback() || port == 0 {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::UnsupportedSelection,
                "The managed proxy endpoint must be a loopback IP address and non-zero port",
            ));
        }
        Ok(Self { host, port })
    }

    pub const fn managed() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 7890,
        }
    }

    pub const fn host(&self) -> IpAddr {
        self.host
    }

    pub const fn port(&self) -> u16 {
        self.port
    }

    pub const fn socket_address(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureJournal {
    pub prior: NetworkServiceProxyState,
}

pub trait CaptureJournalStore: Send + Sync {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError>;
    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError>;
    fn clear(&self) -> Result<(), CaptureTransitionError>;
}

pub trait CapturePlatform: Send + Sync {
    fn availability(&self) -> CapabilityAvailability {
        CapabilityAvailability::Supported
    }
    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>>;
    fn observe_service(
        &self,
        service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>>;
    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>>;
    fn confirm_proxy_listener(
        &self,
        _endpoint: &LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        Box::pin(std::future::ready(Ok(())))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CaptureRequest {
    pub active: bool,
    pub selection: CaptureSelection,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemProxyPhase {
    Off,
    Pending,
    Applied,
    Failed,
    Drift,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemProxyObservedState {
    Disabled,
    Mish,
    Other,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureAuditReason {
    CoreHealthChanged,
    NetworkChanged,
    Periodic,
    Restart,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureRecoveryAction {
    Repair,
    LeaveAsIs,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyRuntimeStatus {
    pub desired: bool,
    pub failure: Option<CaptureFailureKind>,
    pub observed: SystemProxyObservedState,
    pub phase: SystemProxyPhase,
    pub recovery_actions: Vec<CaptureRecoveryAction>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRuntimeStatus {
    pub capture_selection: CaptureSelection,
    pub system_proxy: SystemProxyRuntimeStatus,
    pub system_proxy_enabled: bool,
    pub tun_enabled: bool,
}

impl CaptureRuntimeStatus {
    pub(crate) fn off() -> Self {
        Self {
            capture_selection: CaptureSelection {
                system_proxy: false,
                tun: false,
            },
            system_proxy: SystemProxyRuntimeStatus {
                desired: false,
                failure: None,
                observed: SystemProxyObservedState::Unknown,
                phase: SystemProxyPhase::Off,
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled: false,
            tun_enabled: false,
        }
    }
}

pub struct CaptureReconciler {
    endpoint: LoopbackProxyEndpoint,
    journal: Arc<dyn CaptureJournalStore>,
    operation: AsyncMutex<()>,
    platform: Arc<dyn CapturePlatform>,
    status: Mutex<CaptureRuntimeStatus>,
    runtime_transition: AtomicBool,
}

pub struct CaptureRuntimeTransition {
    reconciler: Arc<CaptureReconciler>,
}

impl Drop for CaptureRuntimeTransition {
    fn drop(&mut self) {
        self.reconciler
            .runtime_transition
            .store(false, Ordering::Release);
    }
}

impl CaptureReconciler {
    pub fn new(
        platform: Arc<dyn CapturePlatform>,
        journal: Arc<dyn CaptureJournalStore>,
        endpoint: LoopbackProxyEndpoint,
    ) -> Self {
        Self {
            endpoint,
            journal,
            operation: AsyncMutex::new(()),
            platform,
            status: Mutex::new(CaptureRuntimeStatus::off()),
            runtime_transition: AtomicBool::new(false),
        }
    }

    pub fn begin_runtime_transition(
        self: &Arc<Self>,
    ) -> Result<CaptureRuntimeTransition, CaptureTransitionError> {
        self.runtime_transition
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| runtime_transition_error())?;
        Ok(CaptureRuntimeTransition {
            reconciler: self.clone(),
        })
    }

    pub fn status(&self) -> CaptureRuntimeStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn availability(&self) -> CapabilityAvailability {
        self.platform.availability()
    }

    pub async fn reconcile(
        &self,
        request: CaptureRequest,
        core_healthy: bool,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        if self.runtime_transition.load(Ordering::Acquire) {
            return Err(runtime_transition_error());
        }
        let _operation = self.operation.lock().await;
        if self.runtime_transition.load(Ordering::Acquire) {
            return Err(runtime_transition_error());
        }
        self.reconcile_locked(request, core_healthy).await
    }

    pub async fn reconcile_runtime_transition(
        &self,
        transition: &CaptureRuntimeTransition,
        request: CaptureRequest,
        core_healthy: bool,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        if !std::ptr::eq(self, Arc::as_ptr(&transition.reconciler))
            || !self.runtime_transition.load(Ordering::Acquire)
        {
            return Err(runtime_transition_error());
        }
        let _operation = self.operation.lock().await;
        self.reconcile_locked(request, core_healthy).await
    }

    async fn reconcile_locked(
        &self,
        request: CaptureRequest,
        core_healthy: bool,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        let desired = request.active && request.selection.system_proxy;
        if self.availability() != CapabilityAvailability::Supported {
            let error = CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "System Proxy is unavailable on this platform",
            );
            self.record_failure(request.selection, desired, error.kind, None);
            return Err(error);
        }
        if request.selection.tun {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::UnsupportedSelection,
                "TUN capture is unavailable",
            ));
        }
        self.set_pending(request.selection.clone(), desired);
        if !request.active || !request.selection.system_proxy {
            return self.restore(request.selection).await;
        }
        let existing_journal = match self.journal.load() {
            Ok(journal) => journal,
            Err(error) => {
                self.record_unknown_drift(self.status(), error.kind);
                return Err(error);
            }
        };
        if !core_healthy {
            if existing_journal.is_some() {
                self.restore(request.selection.clone()).await?;
            }
            let error = CaptureTransitionError::new(
                CaptureFailureKind::CoreUnhealthy,
                "System Proxy requires a healthy Mihomo core",
            );
            self.record_failure(request.selection, true, error.kind, None);
            return Err(error);
        }
        if let Err(error) = self.platform.confirm_proxy_listener(&self.endpoint).await {
            if existing_journal.is_some() {
                self.restore(request.selection.clone()).await?;
            }
            self.record_failure(request.selection, true, error.kind, None);
            return Err(error);
        }

        let mut prior = match self.platform.observe_active().await {
            Ok(prior) => prior,
            Err(error) => {
                if existing_journal.is_some() {
                    self.record_unknown_drift(self.status(), error.kind);
                } else {
                    self.record_failure(request.selection, true, error.kind, None);
                }
                return Err(error);
            }
        };
        if let Some(journal) = existing_journal {
            if journal.prior.service_id == prior.service_id {
                if prior.is_mish_endpoint(&self.endpoint) {
                    let status = CaptureRuntimeStatus {
                        capture_selection: request.selection,
                        system_proxy: SystemProxyRuntimeStatus {
                            desired: true,
                            failure: None,
                            observed: SystemProxyObservedState::Mish,
                            phase: SystemProxyPhase::Applied,
                            recovery_actions: Vec::new(),
                        },
                        system_proxy_enabled: true,
                        tun_enabled: false,
                    };
                    *self.status.lock().unwrap() = status.clone();
                    return Ok(status);
                }
                let mut status = self.status();
                status.capture_selection = request.selection;
                self.mark_drift(status, &prior, Some(CaptureFailureKind::ExternalDrift))?;
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::ExternalDrift,
                    "System Proxy changed outside Mish and was left unchanged",
                ));
            }
            self.restore(request.selection.clone()).await?;
            self.set_pending(request.selection.clone(), true);
            prior = match self.platform.observe_active().await {
                Ok(prior) => prior,
                Err(error) => {
                    self.record_failure(request.selection, true, error.kind, None);
                    return Err(error);
                }
            };
        }
        if prior.is_mish_endpoint(&self.endpoint) {
            let mut status = self.status();
            status.capture_selection = request.selection;
            self.mark_drift(status, &prior, Some(CaptureFailureKind::ExternalDrift))?;
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::ExternalDrift,
                "A matching System Proxy endpoint exists without Mish ownership",
            ));
        }
        if prior.has_unsafe_configuration() {
            let error = CaptureTransitionError::new(
                CaptureFailureKind::UnsafeExistingConfiguration,
                "Automatic proxy configuration is active and was left unchanged",
            );
            self.record_failure(request.selection, true, error.kind, Some(&prior));
            return Err(error);
        }
        if let Err(error) = self.journal.save(&CaptureJournal {
            prior: prior.clone(),
        }) {
            self.record_failure(request.selection, true, error.kind, Some(&prior));
            return Err(error);
        }
        let target = prior.with_endpoint(&self.endpoint);
        if let Err(error) = self.platform.apply_service(target.clone()).await {
            return self
                .rollback_after_failure(&request.selection, &prior, error)
                .await;
        }
        let observed = match self.platform.observe_active().await {
            Ok(observed) => observed,
            Err(error) => {
                return self
                    .rollback_after_failure(&request.selection, &prior, error)
                    .await;
            }
        };
        if !observed.effectively_equals(&target) {
            return self
                .rollback_after_failure(
                    &request.selection,
                    &prior,
                    CaptureTransitionError::new(
                        CaptureFailureKind::ConfirmationFailed,
                        "System Proxy could not be confirmed after applying it",
                    ),
                )
                .await;
        }

        let status = CaptureRuntimeStatus {
            capture_selection: request.selection,
            system_proxy: SystemProxyRuntimeStatus {
                desired: true,
                failure: None,
                observed: SystemProxyObservedState::Mish,
                phase: SystemProxyPhase::Applied,
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled: true,
            tun_enabled: false,
        };
        *self.status.lock().unwrap() = status.clone();
        Ok(status)
    }

    fn record_failure(
        &self,
        selection: CaptureSelection,
        desired: bool,
        failure: CaptureFailureKind,
        observed: Option<&NetworkServiceProxyState>,
    ) {
        let status = CaptureRuntimeStatus {
            capture_selection: selection,
            system_proxy: SystemProxyRuntimeStatus {
                desired,
                failure: Some(failure),
                observed: observed
                    .map(|state| observed_state(state, &self.endpoint))
                    .unwrap_or(SystemProxyObservedState::Unknown),
                phase: SystemProxyPhase::Failed,
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled: false,
            tun_enabled: false,
        };
        *self.status.lock().unwrap() = status;
    }

    fn set_pending(&self, selection: CaptureSelection, desired: bool) {
        let previous = self.status();
        let status = CaptureRuntimeStatus {
            capture_selection: selection,
            system_proxy: SystemProxyRuntimeStatus {
                desired,
                failure: None,
                observed: previous.system_proxy.observed,
                phase: SystemProxyPhase::Pending,
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled: previous.system_proxy_enabled,
            tun_enabled: false,
        };
        *self.status.lock().unwrap() = status;
    }

    pub async fn audit(
        &self,
        _reason: CaptureAuditReason,
        core_healthy: bool,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        if self.runtime_transition.load(Ordering::Acquire) {
            return Ok(self.status());
        }
        let _operation = self.operation.lock().await;
        if self.runtime_transition.load(Ordering::Acquire) {
            return Ok(self.status());
        }
        let current = self.status();
        let journal = match self.journal.load() {
            Ok(journal) => journal,
            Err(error) => {
                if current.system_proxy.desired {
                    self.record_unknown_drift(current, error.kind);
                }
                return Err(error);
            }
        };
        if self.availability() != CapabilityAvailability::Supported {
            if journal.is_some() {
                let error = CaptureTransitionError::new(
                    CaptureFailureKind::CapabilityUnavailable,
                    "System Proxy ownership cannot be audited on this platform",
                );
                self.record_unknown_drift(current, error.kind);
                return Err(error);
            }
            return Ok(current);
        }
        if journal.is_some()
            && current.system_proxy.desired
            && core_healthy
            && let Err(error) = self.platform.confirm_proxy_listener(&self.endpoint).await
        {
            self.restore(current.capture_selection.clone()).await?;
            self.record_failure(current.capture_selection, true, error.kind, None);
            return Err(error);
        }
        if journal.is_some() && (!core_healthy || !current.system_proxy.desired) {
            return self.restore(current.capture_selection).await;
        }
        let observed = match self.platform.observe_active().await {
            Ok(observed) => observed,
            Err(error) => {
                if current.system_proxy.desired || journal.is_some() {
                    self.record_unknown_drift(current, error.kind);
                }
                return Err(error);
            }
        };
        if current.system_proxy.desired
            && journal.is_some()
            && observed.is_mish_endpoint(&self.endpoint)
        {
            let mut confirmed = current;
            confirmed.system_proxy.failure = None;
            confirmed.system_proxy.observed = SystemProxyObservedState::Mish;
            confirmed.system_proxy.phase = SystemProxyPhase::Applied;
            confirmed.system_proxy.recovery_actions.clear();
            confirmed.system_proxy_enabled = true;
            *self.status.lock().unwrap() = confirmed.clone();
            return Ok(confirmed);
        }
        if current.system_proxy.desired {
            if let Some(journal) = journal
                && journal.prior.service_id != observed.service_id
            {
                if self
                    .platform
                    .apply_service(journal.prior.clone())
                    .await
                    .is_err()
                {
                    return self.mark_drift(
                        current,
                        &observed,
                        Some(CaptureFailureKind::RollbackFailed),
                    );
                }
                let restored = self
                    .platform
                    .observe_service(&journal.prior.service_id)
                    .await;
                if !restored.is_ok_and(|state| state.effectively_equals(&journal.prior)) {
                    return self.mark_drift(
                        current,
                        &observed,
                        Some(CaptureFailureKind::RollbackFailed),
                    );
                }
                if let Err(error) = self.journal.clear() {
                    self.mark_drift(current, &observed, Some(error.kind))?;
                    return Err(error);
                }
                if observed.has_unsafe_configuration() {
                    let error = CaptureTransitionError::new(
                        CaptureFailureKind::UnsafeExistingConfiguration,
                        "Automatic proxy configuration is active and was left unchanged",
                    );
                    self.record_failure(
                        current.capture_selection,
                        true,
                        error.kind,
                        Some(&observed),
                    );
                    return Err(error);
                }
                if let Err(error) = self.journal.save(&CaptureJournal {
                    prior: observed.clone(),
                }) {
                    self.record_failure(
                        current.capture_selection,
                        true,
                        error.kind,
                        Some(&observed),
                    );
                    return Err(error);
                }
                let target = observed.with_endpoint(&self.endpoint);
                if let Err(error) = self.platform.apply_service(target.clone()).await {
                    return self
                        .rollback_after_failure(&current.capture_selection, &observed, error)
                        .await;
                }
                let confirmed = match self.platform.observe_active().await {
                    Ok(confirmed) => confirmed,
                    Err(error) => {
                        return self
                            .rollback_after_failure(&current.capture_selection, &observed, error)
                            .await;
                    }
                };
                if !confirmed.effectively_equals(&target) {
                    return self
                        .rollback_after_failure(
                            &current.capture_selection,
                            &observed,
                            CaptureTransitionError::new(
                                CaptureFailureKind::ConfirmationFailed,
                                "System Proxy could not be confirmed on the new network service",
                            ),
                        )
                        .await;
                }
                let status = CaptureRuntimeStatus {
                    capture_selection: current.capture_selection,
                    system_proxy: SystemProxyRuntimeStatus {
                        desired: true,
                        failure: None,
                        observed: SystemProxyObservedState::Mish,
                        phase: SystemProxyPhase::Applied,
                        recovery_actions: Vec::new(),
                    },
                    system_proxy_enabled: true,
                    tun_enabled: false,
                };
                *self.status.lock().unwrap() = status.clone();
                return Ok(status);
            }
            return self.mark_drift(current, &observed, None);
        }
        let mut confirmed = current;
        confirmed.system_proxy.failure = None;
        confirmed.system_proxy.observed = observed_state(&observed, &self.endpoint);
        confirmed.system_proxy.phase = SystemProxyPhase::Off;
        confirmed.system_proxy.recovery_actions.clear();
        confirmed.system_proxy_enabled = false;
        *self.status.lock().unwrap() = confirmed.clone();
        Ok(confirmed)
    }

    pub async fn recover(
        &self,
        action: CaptureRecoveryAction,
        core_healthy: bool,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        if self.runtime_transition.load(Ordering::Acquire) {
            return Err(runtime_transition_error());
        }
        let _operation = self.operation.lock().await;
        if self.runtime_transition.load(Ordering::Acquire) {
            return Err(runtime_transition_error());
        }
        let current = self.status();
        if current.system_proxy.phase != SystemProxyPhase::Drift {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::InvalidRecovery,
                "System Proxy recovery is available only while drift is observed",
            ));
        }
        if action == CaptureRecoveryAction::Repair && !core_healthy {
            let error = CaptureTransitionError::new(
                CaptureFailureKind::CoreUnhealthy,
                "System Proxy repair requires a healthy Mihomo core",
            );
            self.record_drift_failure(current, error.kind);
            return Err(error);
        }
        if action == CaptureRecoveryAction::Repair
            && let Err(error) = self.platform.confirm_proxy_listener(&self.endpoint).await
        {
            self.record_drift_failure(current, error.kind);
            return Err(error);
        }
        self.set_pending(
            current.capture_selection.clone(),
            action == CaptureRecoveryAction::Repair,
        );
        let observed = match self.platform.observe_active().await {
            Ok(observed) => observed,
            Err(error) => {
                self.record_unknown_drift(current, error.kind);
                return Err(error);
            }
        };
        if action == CaptureRecoveryAction::Repair {
            if observed.has_unsafe_configuration() {
                let error = CaptureTransitionError::new(
                    CaptureFailureKind::UnsafeExistingConfiguration,
                    "Automatic proxy configuration is active and was left unchanged",
                );
                self.mark_drift(current, &observed, Some(error.kind))?;
                return Err(error);
            }
            if let Err(error) = self.journal.save(&CaptureJournal {
                prior: observed.clone(),
            }) {
                self.mark_drift(current, &observed, Some(error.kind))?;
                return Err(error);
            }
            let target = observed.with_endpoint(&self.endpoint);
            if let Err(error) = self.platform.apply_service(target.clone()).await {
                return self
                    .rollback_after_failure(&current.capture_selection, &observed, error)
                    .await;
            }
            let confirmed = match self.platform.observe_active().await {
                Ok(confirmed) => confirmed,
                Err(error) => {
                    return self
                        .rollback_after_failure(&current.capture_selection, &observed, error)
                        .await;
                }
            };
            if !confirmed.effectively_equals(&target) {
                return self
                    .rollback_after_failure(
                        &current.capture_selection,
                        &observed,
                        CaptureTransitionError::new(
                            CaptureFailureKind::ConfirmationFailed,
                            "System Proxy repair could not be confirmed",
                        ),
                    )
                    .await;
            }
            let status = CaptureRuntimeStatus {
                capture_selection: current.capture_selection,
                system_proxy: SystemProxyRuntimeStatus {
                    desired: true,
                    failure: None,
                    observed: SystemProxyObservedState::Mish,
                    phase: SystemProxyPhase::Applied,
                    recovery_actions: Vec::new(),
                },
                system_proxy_enabled: true,
                tun_enabled: false,
            };
            *self.status.lock().unwrap() = status.clone();
            return Ok(status);
        }

        if let Err(error) = self.journal.clear() {
            self.mark_drift(current, &observed, Some(error.kind))?;
            return Err(error);
        }
        let status = CaptureRuntimeStatus {
            capture_selection: current.capture_selection,
            system_proxy: SystemProxyRuntimeStatus {
                desired: false,
                failure: None,
                observed: observed_state(&observed, &self.endpoint),
                phase: SystemProxyPhase::Off,
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled: false,
            tun_enabled: false,
        };
        *self.status.lock().unwrap() = status.clone();
        Ok(status)
    }

    fn mark_drift(
        &self,
        mut status: CaptureRuntimeStatus,
        observed: &NetworkServiceProxyState,
        failure: Option<CaptureFailureKind>,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        status.system_proxy.failure = failure;
        status.system_proxy.observed = observed_state(observed, &self.endpoint);
        status.system_proxy.phase = SystemProxyPhase::Drift;
        status.system_proxy.recovery_actions = vec![
            CaptureRecoveryAction::Repair,
            CaptureRecoveryAction::LeaveAsIs,
        ];
        status.system_proxy_enabled = false;
        *self.status.lock().unwrap() = status.clone();
        Ok(status)
    }

    fn record_unknown_drift(&self, mut status: CaptureRuntimeStatus, failure: CaptureFailureKind) {
        status.system_proxy.failure = Some(failure);
        status.system_proxy.observed = SystemProxyObservedState::Unknown;
        status.system_proxy.phase = SystemProxyPhase::Drift;
        status.system_proxy.recovery_actions = vec![
            CaptureRecoveryAction::Repair,
            CaptureRecoveryAction::LeaveAsIs,
        ];
        status.system_proxy_enabled = false;
        *self.status.lock().unwrap() = status;
    }

    fn record_drift_failure(&self, mut status: CaptureRuntimeStatus, failure: CaptureFailureKind) {
        status.system_proxy.failure = Some(failure);
        status.system_proxy.phase = SystemProxyPhase::Drift;
        status.system_proxy.recovery_actions = vec![
            CaptureRecoveryAction::Repair,
            CaptureRecoveryAction::LeaveAsIs,
        ];
        status.system_proxy_enabled = false;
        *self.status.lock().unwrap() = status;
    }

    async fn rollback_after_failure(
        &self,
        selection: &CaptureSelection,
        prior: &NetworkServiceProxyState,
        original: CaptureTransitionError,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        if self.platform.apply_service(prior.clone()).await.is_err() {
            return self
                .record_rollback_drift(
                    selection,
                    prior,
                    "System Proxy failed and its prior state could not be restored",
                )
                .await;
        }
        let restored = self.platform.observe_service(&prior.service_id).await;
        if !restored.is_ok_and(|observed| observed.effectively_equals(prior)) {
            return self
                .record_rollback_drift(
                    selection,
                    prior,
                    "System Proxy failed and its prior state could not be confirmed",
                )
                .await;
        }
        if let Err(error) = self.journal.clear() {
            let mut status = self.status();
            status.capture_selection = selection.clone();
            self.mark_drift(status, prior, Some(error.kind))?;
            return Err(error);
        }
        let status = CaptureRuntimeStatus {
            capture_selection: selection.clone(),
            system_proxy: SystemProxyRuntimeStatus {
                desired: true,
                failure: Some(original.kind),
                observed: observed_state(prior, &self.endpoint),
                phase: SystemProxyPhase::Failed,
                recovery_actions: Vec::new(),
            },
            system_proxy_enabled: false,
            tun_enabled: false,
        };
        *self.status.lock().unwrap() = status;
        Err(original)
    }

    async fn record_rollback_drift(
        &self,
        selection: &CaptureSelection,
        prior: &NetworkServiceProxyState,
        message: &'static str,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        let observed = self
            .platform
            .observe_service(&prior.service_id)
            .await
            .unwrap_or_else(|_| prior.clone());
        let status = CaptureRuntimeStatus {
            capture_selection: selection.clone(),
            system_proxy: SystemProxyRuntimeStatus {
                desired: true,
                failure: Some(CaptureFailureKind::RollbackFailed),
                observed: observed_state(&observed, &self.endpoint),
                phase: SystemProxyPhase::Drift,
                recovery_actions: vec![
                    CaptureRecoveryAction::Repair,
                    CaptureRecoveryAction::LeaveAsIs,
                ],
            },
            system_proxy_enabled: false,
            tun_enabled: false,
        };
        *self.status.lock().unwrap() = status;
        Err(CaptureTransitionError::new(
            CaptureFailureKind::RollbackFailed,
            message,
        ))
    }

    async fn restore(
        &self,
        selection: CaptureSelection,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        let journal = match self.journal.load() {
            Ok(journal) => journal,
            Err(error) => {
                let mut status = self.status();
                status.capture_selection = selection;
                status.system_proxy.desired = false;
                self.record_unknown_drift(status, error.kind);
                return Err(error);
            }
        };
        let Some(journal) = journal else {
            let mut status = CaptureRuntimeStatus::off();
            status.capture_selection = selection;
            let observed = match self.platform.observe_active().await {
                Ok(observed) => observed,
                Err(error) => {
                    self.record_failure(status.capture_selection, false, error.kind, None);
                    return Err(error);
                }
            };
            status.system_proxy.observed = observed_state(&observed, &self.endpoint);
            *self.status.lock().unwrap() = status.clone();
            return Ok(status);
        };
        let owned = match self
            .platform
            .observe_service(&journal.prior.service_id)
            .await
        {
            Ok(owned) => owned,
            Err(error) => {
                let mut status = self.status();
                status.capture_selection = selection;
                status.system_proxy.desired = false;
                self.record_unknown_drift(status, error.kind);
                return Err(error);
            }
        };
        if !owned.is_mish_endpoint(&self.endpoint) {
            let observed = self.platform.observe_active().await.unwrap_or(owned);
            let mut status = self.status();
            status.capture_selection = selection;
            status.system_proxy.desired = false;
            self.mark_drift(status, &observed, Some(CaptureFailureKind::ExternalDrift))?;
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::ExternalDrift,
                "System Proxy changed outside Mish and was left unchanged",
            ));
        }
        if self
            .platform
            .apply_service(journal.prior.clone())
            .await
            .is_err()
        {
            let mut status = self.status();
            status.capture_selection = selection;
            status.system_proxy.desired = false;
            self.mark_drift(status, &owned, Some(CaptureFailureKind::RollbackFailed))?;
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RollbackFailed,
                "The prior System Proxy state could not be restored",
            ));
        }
        let restored = match self
            .platform
            .observe_service(&journal.prior.service_id)
            .await
        {
            Ok(restored) => restored,
            Err(error) => {
                let mut status = self.status();
                status.capture_selection = selection;
                status.system_proxy.desired = false;
                self.record_unknown_drift(status, error.kind);
                return Err(error);
            }
        };
        if !restored.effectively_equals(&journal.prior) {
            let mut status = self.status();
            status.capture_selection = selection;
            status.system_proxy.desired = false;
            self.mark_drift(status, &restored, Some(CaptureFailureKind::RollbackFailed))?;
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RollbackFailed,
                "The prior System Proxy state could not be confirmed",
            ));
        }
        if let Err(error) = self.journal.clear() {
            let mut status = self.status();
            status.capture_selection = selection;
            status.system_proxy.desired = false;
            self.mark_drift(status, &restored, Some(error.kind))?;
            return Err(error);
        }
        let mut status = CaptureRuntimeStatus::off();
        status.capture_selection = selection;
        status.system_proxy.observed = observed_state(&restored, &self.endpoint);
        *self.status.lock().unwrap() = status.clone();
        Ok(status)
    }
}

fn observed_state(
    state: &NetworkServiceProxyState,
    endpoint: &LoopbackProxyEndpoint,
) -> SystemProxyObservedState {
    if state.is_mish_endpoint(endpoint) {
        return SystemProxyObservedState::Mish;
    }
    if !state.http.enabled && !state.https.enabled && !state.socks.enabled {
        return SystemProxyObservedState::Disabled;
    }
    SystemProxyObservedState::Other
}

fn runtime_transition_error() -> CaptureTransitionError {
    CaptureTransitionError::new(
        CaptureFailureKind::RuntimeTransition,
        "System Proxy is unavailable while the managed core is switching",
    )
}
