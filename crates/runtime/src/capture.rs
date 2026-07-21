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

use crate::{
    CapabilityAvailability, CaptureSelection, TunHelperAvailability, TunHelperController,
    TunHelperFailureKind, TunHelperHealth,
};

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualProxyState {
    pub authenticated: bool,
    pub enabled: bool,
    pub host: String,
    pub port: u16,
}

impl ManualProxyState {
    pub const fn disabled() -> Self {
        Self {
            authenticated: false,
            enabled: false,
            host: String::new(),
            port: 0,
        }
    }

    fn for_endpoint(endpoint: &LoopbackProxyEndpoint) -> Self {
        Self {
            authenticated: false,
            enabled: true,
            host: endpoint.host.to_string(),
            port: endpoint.port,
        }
    }

    pub fn is_reversible(&self) -> bool {
        !self.authenticated
            && !self.host.chars().any(char::is_control)
            && (!self.enabled || (!self.host.trim().is_empty() && self.port > 0))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkServiceProxyState {
    pub auto_discovery_enabled: bool,
    pub http: ManualProxyState,
    pub https: ManualProxyState,
    pub pac_enabled: bool,
    pub pac_url: String,
    pub service_id: String,
    pub socks: ManualProxyState,
}

impl NetworkServiceProxyState {
    fn has_unsafe_configuration(&self) -> bool {
        self.pac_enabled
            || self.auto_discovery_enabled
            || [&self.http, &self.https, &self.socks]
                .into_iter()
                .any(|proxy| !proxy.is_reversible())
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
            pac_url: self.pac_url.clone(),
            service_id: self.service_id.clone(),
            socks: Self::manual_proxy_target(endpoint),
        }
    }

    fn is_reversible(&self) -> bool {
        !self.service_id.trim().is_empty()
            && !self.service_id.chars().any(char::is_control)
            && !self.pac_url.chars().any(char::is_control)
            && !self.has_unsafe_configuration()
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalProxyTestPhase {
    CoreUnhealthy,
    ListenerUnavailable,
    Ready,
    RuntimeTransition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProxyTestResult {
    pub host: String,
    pub phase: LocalProxyTestPhase,
    pub port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureJournal {
    pub prior: NetworkServiceProxyState,
}

impl CaptureJournal {
    pub fn is_valid_recovery_state(&self) -> bool {
        self.prior.is_reversible()
    }
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
    pub tun: TunRuntimeStatus,
    pub tun_enabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunPhase {
    Off,
    Pending,
    Applied,
    Failed,
    Drift,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunObservedState {
    Disabled,
    Enabled,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunFailureKind {
    CapabilityUnavailable,
    ConfirmationFailed,
    CoreUnhealthy,
    HelperConnectionFailed,
    HelperIdentityRejected,
    HelperInvalidSignature,
    HelperOperationFailed,
    HelperPermissionDenied,
    HelperProtocolMismatch,
    HelperVersionMismatch,
    RollbackFailed,
    RuntimeTransition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunRuntimeStatus {
    pub desired: bool,
    pub failure: Option<TunFailureKind>,
    pub observed: TunObservedState,
    pub phase: TunPhase,
}

impl TunRuntimeStatus {
    pub const fn off() -> Self {
        Self {
            desired: false,
            failure: None,
            observed: TunObservedState::Unknown,
            phase: TunPhase::Off,
        }
    }
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
            tun: TunRuntimeStatus::off(),
            tun_enabled: false,
        }
    }
}

pub struct SystemProxyReconciler {
    endpoint: LoopbackProxyEndpoint,
    journal: Arc<dyn CaptureJournalStore>,
    operation: AsyncMutex<()>,
    platform: Arc<dyn CapturePlatform>,
    status: Mutex<CaptureRuntimeStatus>,
    runtime_transition: AtomicBool,
}

pub struct SystemProxyRuntimeTransition {
    reconciler: Arc<SystemProxyReconciler>,
}

impl Drop for SystemProxyRuntimeTransition {
    fn drop(&mut self) {
        self.reconciler
            .runtime_transition
            .store(false, Ordering::Release);
    }
}

impl SystemProxyReconciler {
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
    ) -> Result<SystemProxyRuntimeTransition, CaptureTransitionError> {
        self.runtime_transition
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| runtime_transition_error())?;
        Ok(SystemProxyRuntimeTransition {
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
        transition: &SystemProxyRuntimeTransition,
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
        let existing_journal = match self.load_validated_journal() {
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
                if prior == journal.prior.with_endpoint(&self.endpoint) {
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
                        tun: TunRuntimeStatus::off(),
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
        if !prior.is_reversible() {
            let error = CaptureTransitionError::new(
                CaptureFailureKind::UnsafeExistingConfiguration,
                "The existing proxy configuration cannot be restored safely and was left unchanged",
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
        if observed != target {
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
            tun: TunRuntimeStatus::off(),
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
            tun: TunRuntimeStatus::off(),
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
            tun: TunRuntimeStatus::off(),
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
        let journal = match self.load_validated_journal() {
            Ok(journal) => journal,
            Err(error) => {
                self.record_unknown_drift(current, error.kind);
                if error.kind == CaptureFailureKind::InvalidRecovery {
                    self.restrict_recovery_to_relinquish();
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
        if journal.is_none()
            && current.system_proxy.phase == SystemProxyPhase::Failed
            && !observed.is_mish_endpoint(&self.endpoint)
        {
            let mut failed = current;
            failed.system_proxy.observed = observed_state(&observed, &self.endpoint);
            failed.system_proxy.recovery_actions.clear();
            failed.system_proxy_enabled = false;
            *self.status.lock().unwrap() = failed.clone();
            return Ok(failed);
        }
        if current.system_proxy.desired
            && journal
                .as_ref()
                .is_some_and(|journal| observed == journal.prior.with_endpoint(&self.endpoint))
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
                if self.restore_exact_prior(&journal.prior).await.is_err() {
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
                if !observed.is_reversible() {
                    let error = CaptureTransitionError::new(
                        CaptureFailureKind::UnsafeExistingConfiguration,
                        "The existing proxy configuration cannot be restored safely and was left unchanged",
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
                if confirmed != target {
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
                    tun: TunRuntimeStatus::off(),
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
        let invalid_recovery =
            current.system_proxy.failure == Some(CaptureFailureKind::InvalidRecovery);
        if action == CaptureRecoveryAction::Repair && invalid_recovery {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::InvalidRecovery,
                "An invalid System Proxy recovery record can only be relinquished",
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
                self.record_unknown_drift(
                    current,
                    if invalid_recovery {
                        CaptureFailureKind::InvalidRecovery
                    } else {
                        error.kind
                    },
                );
                if invalid_recovery {
                    self.restrict_recovery_to_relinquish();
                }
                return Err(error);
            }
        };
        if action == CaptureRecoveryAction::Repair {
            if !observed.is_reversible() {
                let error = CaptureTransitionError::new(
                    CaptureFailureKind::UnsafeExistingConfiguration,
                    "The existing proxy configuration cannot be restored safely and was left unchanged",
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
            if confirmed != target {
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
                tun: TunRuntimeStatus::off(),
                tun_enabled: false,
            };
            *self.status.lock().unwrap() = status.clone();
            return Ok(status);
        }

        if let Err(error) = self.journal.clear() {
            self.mark_drift(
                current,
                &observed,
                Some(if invalid_recovery {
                    CaptureFailureKind::InvalidRecovery
                } else {
                    error.kind
                }),
            )?;
            if invalid_recovery {
                self.restrict_recovery_to_relinquish();
            }
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
            tun: TunRuntimeStatus::off(),
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

    fn restrict_recovery_to_relinquish(&self) {
        let mut status = self.status.lock().unwrap();
        status.system_proxy.recovery_actions = vec![CaptureRecoveryAction::LeaveAsIs];
    }

    async fn rollback_after_failure(
        &self,
        selection: &CaptureSelection,
        prior: &NetworkServiceProxyState,
        original: CaptureTransitionError,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        if self.restore_exact_prior(prior).await.is_err() {
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
            tun: TunRuntimeStatus::off(),
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
            tun: TunRuntimeStatus::off(),
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
        let journal = match self.load_validated_journal() {
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
        if owned != journal.prior.with_endpoint(&self.endpoint) {
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
        let restored = match self.restore_exact_prior(&journal.prior).await {
            Ok(restored) => restored,
            Err(_) => {
                let mut status = self.status();
                status.capture_selection = selection;
                status.system_proxy.desired = false;
                self.mark_drift(status, &owned, Some(CaptureFailureKind::RollbackFailed))?;
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "The prior System Proxy state could not be restored and confirmed",
                ));
            }
        };
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

    fn load_validated_journal(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        let journal = self.journal.load()?;
        if journal
            .as_ref()
            .is_some_and(|journal| !journal.is_valid_recovery_state())
        {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::InvalidRecovery,
                "The System Proxy recovery journal is invalid",
            ));
        }
        Ok(journal)
    }

    async fn restore_exact_prior(
        &self,
        prior: &NetworkServiceProxyState,
    ) -> Result<NetworkServiceProxyState, CaptureTransitionError> {
        self.platform
            .apply_service(prior.clone())
            .await
            .map_err(|_| {
                CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "The prior System Proxy state could not be restored",
                )
            })?;
        let observed = self
            .platform
            .observe_service(&prior.service_id)
            .await
            .map_err(|_| {
                CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "The prior System Proxy state could not be confirmed",
                )
            })?;
        if observed != *prior {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RollbackFailed,
                "The prior System Proxy state could not be confirmed",
            ));
        }
        Ok(observed)
    }
}

struct TunReconciler {
    helper: Arc<TunHelperController>,
    status: Mutex<TunRuntimeStatus>,
}

impl TunReconciler {
    fn new(helper: Arc<TunHelperController>) -> Self {
        Self {
            helper,
            status: Mutex::new(TunRuntimeStatus::off()),
        }
    }

    fn availability(&self) -> CapabilityAvailability {
        match self.helper.snapshot().availability {
            TunHelperAvailability::Available if self.helper.snapshot().is_healthy() => {
                CapabilityAvailability::Supported
            }
            TunHelperAvailability::PermissionRequired => CapabilityAvailability::PermissionRequired,
            TunHelperAvailability::RepairRequired => CapabilityAvailability::RepairRequired,
            TunHelperAvailability::Available
            | TunHelperAvailability::Unpackaged
            | TunHelperAvailability::UnsignedApp
            | TunHelperAvailability::UnsupportedSystem
            | TunHelperAvailability::Unavailable => CapabilityAvailability::Unavailable,
        }
    }

    fn status(&self) -> TunRuntimeStatus {
        self.status
            .lock()
            .expect("TUN status lock poisoned")
            .clone()
    }

    async fn reconcile(
        &self,
        desired: bool,
        core_healthy: bool,
    ) -> Result<TunRuntimeStatus, CaptureTransitionError> {
        let previous = self.status();
        if !desired && previous.phase == TunPhase::Off && !previous.desired {
            return Ok(previous);
        }
        if desired && self.availability() != CapabilityAvailability::Supported {
            let failure = helper_snapshot_failure(&self.helper.snapshot());
            self.record_failure(true, failure, previous.observed);
            return Err(capture_error_from_tun_failure(failure));
        }
        if desired && !core_healthy {
            self.record_failure(true, TunFailureKind::CoreUnhealthy, previous.observed);
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::CoreUnhealthy,
                "TUN capture requires a healthy Mihomo core",
            ));
        }
        self.set_pending(desired);
        match self.helper.set_tun_enabled(desired).await {
            Ok(observed) if observed == desired => {
                let status = TunRuntimeStatus {
                    desired,
                    failure: None,
                    observed: if observed {
                        TunObservedState::Enabled
                    } else {
                        TunObservedState::Disabled
                    },
                    phase: if observed {
                        TunPhase::Applied
                    } else {
                        TunPhase::Off
                    },
                };
                *self.status.lock().expect("TUN status lock poisoned") = status.clone();
                Ok(status)
            }
            Ok(_) => {
                self.record_failure(
                    desired,
                    TunFailureKind::ConfirmationFailed,
                    TunObservedState::Unknown,
                );
                Err(CaptureTransitionError::new(
                    CaptureFailureKind::ConfirmationFailed,
                    "TUN state could not be confirmed",
                ))
            }
            Err(error) => {
                let failure = map_helper_failure(error.kind);
                let observed = self.helper.observe_tun().await.ok().map_or(
                    TunObservedState::Unknown,
                    |enabled| {
                        if enabled {
                            TunObservedState::Enabled
                        } else {
                            TunObservedState::Disabled
                        }
                    },
                );
                self.record_failure(desired, failure, observed);
                Err(capture_error_from_tun_failure(failure))
            }
        }
    }

    async fn audit(&self, core_healthy: bool) -> Result<TunRuntimeStatus, CaptureTransitionError> {
        let current = self.status();
        if current.desired && !core_healthy {
            return self.reconcile(false, false).await.map(|mut status| {
                status.desired = true;
                status.failure = Some(TunFailureKind::CoreUnhealthy);
                status.phase = TunPhase::Failed;
                *self.status.lock().expect("TUN status lock poisoned") = status.clone();
                status
            });
        }
        if self.availability() != CapabilityAvailability::Supported {
            if current.desired || current.observed == TunObservedState::Enabled {
                let failure = helper_snapshot_failure(&self.helper.snapshot());
                self.record_drift(failure);
                return Err(capture_error_from_tun_failure(failure));
            }
            return Ok(current);
        }
        let observed = self.helper.observe_tun().await.map_err(|error| {
            let failure = map_helper_failure(error.kind);
            self.record_drift(failure);
            capture_error_from_tun_failure(failure)
        })?;
        if observed == current.desired {
            let status = TunRuntimeStatus {
                desired: current.desired,
                failure: None,
                observed: if observed {
                    TunObservedState::Enabled
                } else {
                    TunObservedState::Disabled
                },
                phase: if observed {
                    TunPhase::Applied
                } else {
                    TunPhase::Off
                },
            };
            *self.status.lock().expect("TUN status lock poisoned") = status.clone();
            return Ok(status);
        }
        self.record_drift(TunFailureKind::ConfirmationFailed);
        Err(CaptureTransitionError::new(
            CaptureFailureKind::ExternalDrift,
            "TUN state changed outside Mish",
        ))
    }

    fn set_pending(&self, desired: bool) {
        let previous = self.status();
        *self.status.lock().expect("TUN status lock poisoned") = TunRuntimeStatus {
            desired,
            failure: None,
            observed: previous.observed,
            phase: TunPhase::Pending,
        };
    }

    fn record_failure(&self, desired: bool, failure: TunFailureKind, observed: TunObservedState) {
        *self.status.lock().expect("TUN status lock poisoned") = TunRuntimeStatus {
            desired,
            failure: Some(failure),
            observed,
            phase: TunPhase::Failed,
        };
    }

    fn record_drift(&self, failure: TunFailureKind) {
        let mut status = self.status();
        status.failure = Some(failure);
        status.phase = TunPhase::Drift;
        status.observed = TunObservedState::Unknown;
        *self.status.lock().expect("TUN status lock poisoned") = status;
    }
}

pub struct CaptureReconciler {
    operation: AsyncMutex<()>,
    runtime_transition: AtomicBool,
    status: Mutex<CaptureRuntimeStatus>,
    system_proxy: Arc<SystemProxyReconciler>,
    tun: Option<Arc<TunReconciler>>,
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
        Self::new_with_tun(platform, journal, endpoint, None)
    }

    pub fn new_with_tun(
        platform: Arc<dyn CapturePlatform>,
        journal: Arc<dyn CaptureJournalStore>,
        endpoint: LoopbackProxyEndpoint,
        helper: Option<Arc<TunHelperController>>,
    ) -> Self {
        let system_proxy = Arc::new(SystemProxyReconciler::new(platform, journal, endpoint));
        let tun = helper.map(|helper| Arc::new(TunReconciler::new(helper)));
        let mut status = system_proxy.status();
        if let Some(tun) = &tun {
            status.tun = tun.status();
        }
        Self {
            operation: AsyncMutex::new(()),
            runtime_transition: AtomicBool::new(false),
            status: Mutex::new(status),
            system_proxy,
            tun,
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
        self.status
            .lock()
            .expect("capture status lock poisoned")
            .clone()
    }

    pub fn availability(&self) -> CapabilityAvailability {
        self.system_proxy.availability()
    }

    pub fn tun_availability(&self) -> CapabilityAvailability {
        self.tun
            .as_ref()
            .map_or(CapabilityAvailability::Unavailable, |tun| {
                tun.availability()
            })
    }

    pub fn local_proxy_endpoint(&self) -> &LoopbackProxyEndpoint {
        &self.system_proxy.endpoint
    }

    pub async fn test_local_proxy(
        &self,
        core_healthy: bool,
        core_owns_listener: bool,
    ) -> LocalProxyTestResult {
        let endpoint = &self.system_proxy.endpoint;
        let result = |phase| LocalProxyTestResult {
            host: endpoint.host().to_string(),
            phase,
            port: endpoint.port(),
        };
        if !core_healthy {
            return result(LocalProxyTestPhase::CoreUnhealthy);
        }
        if !core_owns_listener {
            return result(LocalProxyTestPhase::ListenerUnavailable);
        }
        if self.runtime_transition.load(Ordering::Acquire) {
            return result(LocalProxyTestPhase::RuntimeTransition);
        }
        let _operation = self.operation.lock().await;
        if self.runtime_transition.load(Ordering::Acquire) {
            return result(LocalProxyTestPhase::RuntimeTransition);
        }
        match self
            .system_proxy
            .platform
            .confirm_proxy_listener(endpoint)
            .await
        {
            Ok(()) => result(LocalProxyTestPhase::Ready),
            Err(_) => result(LocalProxyTestPhase::ListenerUnavailable),
        }
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
        let previous = self.status();
        let system_proxy_desired = request.active && request.selection.system_proxy;
        let tun_desired = request.active && request.selection.tun;
        if tun_desired && self.tun_availability() != CapabilityAvailability::Supported {
            let failure = self
                .tun
                .as_ref()
                .map(|tun| helper_snapshot_failure(&tun.helper.snapshot()))
                .unwrap_or(TunFailureKind::CapabilityUnavailable);
            let mut status = previous;
            status.tun.desired = true;
            status.tun.failure = Some(failure);
            status.tun.phase = TunPhase::Failed;
            *self.status.lock().expect("capture status lock poisoned") = status;
            return Err(capture_error_from_tun_failure(failure));
        }
        self.set_pending(request.selection.clone(), system_proxy_desired, tun_desired);

        let tun_was_disabled = previous.tun_enabled && !tun_desired;
        if tun_was_disabled && let Err(error) = self.set_tun(false, core_healthy).await {
            let status = self.combined_status(request.selection);
            *self.status.lock().expect("capture status lock poisoned") = status;
            return Err(error);
        }

        if let Err(error) = self
            .set_system_proxy(system_proxy_desired, &request.selection, core_healthy)
            .await
        {
            if tun_was_disabled && self.set_tun(true, core_healthy).await.is_err() {
                let mut status = self.combined_status(request.selection);
                status.tun.failure = Some(TunFailureKind::RollbackFailed);
                status.tun.phase = TunPhase::Drift;
                *self.status.lock().expect("capture status lock poisoned") = status;
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "Traffic capture failed and the prior TUN state could not be confirmed",
                ));
            }
            let status = self.combined_status(request.selection);
            *self.status.lock().expect("capture status lock poisoned") = status;
            return Err(error);
        }

        if tun_desired && let Err(original) = self.set_tun(true, core_healthy).await {
            let rollback_system = self
                .set_system_proxy(
                    previous.system_proxy_enabled,
                    &previous.capture_selection,
                    core_healthy,
                )
                .await;
            let rollback_tun = self.set_tun(previous.tun_enabled, core_healthy).await;
            let mut status = self.combined_status(previous.capture_selection.clone());
            if rollback_system.is_err() || rollback_tun.is_err() {
                status.system_proxy.failure = Some(CaptureFailureKind::RollbackFailed);
                status.system_proxy.phase = SystemProxyPhase::Drift;
                status.tun.failure = Some(TunFailureKind::RollbackFailed);
                status.tun.phase = TunPhase::Drift;
                *self.status.lock().expect("capture status lock poisoned") = status;
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "Traffic capture failed and the prior state could not be confirmed",
                ));
            }
            *self.status.lock().expect("capture status lock poisoned") = status;
            return Err(original);
        }

        let status = self.combined_status(request.selection);
        *self.status.lock().expect("capture status lock poisoned") = status.clone();
        Ok(status)
    }

    pub async fn audit(
        &self,
        reason: CaptureAuditReason,
        core_healthy: bool,
    ) -> Result<CaptureRuntimeStatus, CaptureTransitionError> {
        if self.runtime_transition.load(Ordering::Acquire) {
            return Ok(self.status());
        }
        let _operation = self.operation.lock().await;
        let selection = self.status().capture_selection;
        let system_result = self.system_proxy.audit(reason, core_healthy).await;
        let tun_result = match &self.tun {
            Some(tun) => tun.audit(core_healthy).await,
            None => Ok(TunRuntimeStatus::off()),
        };
        let status = self.combined_status(selection);
        *self.status.lock().expect("capture status lock poisoned") = status.clone();
        system_result?;
        tun_result?;
        Ok(status)
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
        let selection = self.status().capture_selection;
        self.system_proxy.recover(action, core_healthy).await?;
        let status = self.combined_status(selection);
        *self.status.lock().expect("capture status lock poisoned") = status.clone();
        Ok(status)
    }

    fn set_pending(&self, selection: CaptureSelection, system_proxy: bool, tun: bool) {
        let previous = self.status();
        let mut status = previous;
        status.capture_selection = selection;
        status.system_proxy.desired = system_proxy;
        status.system_proxy.failure = None;
        status.system_proxy.phase = SystemProxyPhase::Pending;
        status.tun.desired = tun;
        status.tun.failure = None;
        status.tun.phase = TunPhase::Pending;
        *self.status.lock().expect("capture status lock poisoned") = status;
    }

    async fn set_system_proxy(
        &self,
        enabled: bool,
        selection: &CaptureSelection,
        core_healthy: bool,
    ) -> Result<(), CaptureTransitionError> {
        self.system_proxy
            .reconcile(
                CaptureRequest {
                    active: enabled,
                    selection: CaptureSelection {
                        system_proxy: selection.system_proxy,
                        tun: false,
                    },
                },
                core_healthy,
            )
            .await
            .map(|_| ())
    }

    async fn set_tun(
        &self,
        enabled: bool,
        core_healthy: bool,
    ) -> Result<(), CaptureTransitionError> {
        match &self.tun {
            Some(tun) => tun.reconcile(enabled, core_healthy).await.map(|_| ()),
            None if enabled => Err(CaptureTransitionError::new(
                CaptureFailureKind::CapabilityUnavailable,
                "TUN capture is unavailable in this runtime",
            )),
            None => Ok(()),
        }
    }

    fn combined_status(&self, selection: CaptureSelection) -> CaptureRuntimeStatus {
        let system_proxy = self.system_proxy.status();
        let tun = self
            .tun
            .as_ref()
            .map_or_else(TunRuntimeStatus::off, |tun| tun.status());
        CaptureRuntimeStatus {
            capture_selection: selection,
            system_proxy: system_proxy.system_proxy,
            system_proxy_enabled: system_proxy.system_proxy_enabled,
            tun_enabled: tun.phase == TunPhase::Applied
                && tun.observed == TunObservedState::Enabled,
            tun,
        }
    }
}

fn helper_snapshot_failure(snapshot: &crate::TunHelperSnapshot) -> TunFailureKind {
    if snapshot.health == TunHelperHealth::VersionMismatch {
        return TunFailureKind::HelperVersionMismatch;
    }
    if snapshot.health == TunHelperHealth::InvalidSignature {
        return TunFailureKind::HelperInvalidSignature;
    }
    match snapshot.last_failure {
        Some(failure) => map_helper_failure(failure),
        None => TunFailureKind::CapabilityUnavailable,
    }
}

fn map_helper_failure(failure: TunHelperFailureKind) -> TunFailureKind {
    match failure {
        TunHelperFailureKind::ConfirmationFailed => TunFailureKind::ConfirmationFailed,
        TunHelperFailureKind::IdentityRejected => TunFailureKind::HelperIdentityRejected,
        TunHelperFailureKind::InvalidSignature | TunHelperFailureKind::UnsignedApp => {
            TunFailureKind::HelperInvalidSignature
        }
        TunHelperFailureKind::AuthorizationCancelled
        | TunHelperFailureKind::PermissionDenied
        | TunHelperFailureKind::RegistrationRequiresApproval => {
            TunFailureKind::HelperPermissionDenied
        }
        TunHelperFailureKind::ProtocolMismatch | TunHelperFailureKind::MessageTooLarge => {
            TunFailureKind::HelperProtocolMismatch
        }
        TunHelperFailureKind::VersionMismatch => TunFailureKind::HelperVersionMismatch,
        TunHelperFailureKind::InstallationFailed
        | TunHelperFailureKind::InstallerUnavailable
        | TunHelperFailureKind::OperationFailed
        | TunHelperFailureKind::PreparationFailed => TunFailureKind::HelperOperationFailed,
        TunHelperFailureKind::ConnectionFailed
        | TunHelperFailureKind::RegistrationFailed
        | TunHelperFailureKind::Unpackaged
        | TunHelperFailureKind::UnsupportedSystem => TunFailureKind::HelperConnectionFailed,
    }
}

fn capture_error_from_tun_failure(failure: TunFailureKind) -> CaptureTransitionError {
    let kind = match failure {
        TunFailureKind::HelperPermissionDenied => CaptureFailureKind::PermissionDenied,
        TunFailureKind::ConfirmationFailed => CaptureFailureKind::ConfirmationFailed,
        TunFailureKind::CoreUnhealthy => CaptureFailureKind::CoreUnhealthy,
        TunFailureKind::RollbackFailed => CaptureFailureKind::RollbackFailed,
        TunFailureKind::RuntimeTransition => CaptureFailureKind::RuntimeTransition,
        TunFailureKind::HelperOperationFailed => CaptureFailureKind::ApplyFailed,
        TunFailureKind::CapabilityUnavailable
        | TunFailureKind::HelperConnectionFailed
        | TunFailureKind::HelperIdentityRejected
        | TunFailureKind::HelperInvalidSignature
        | TunFailureKind::HelperProtocolMismatch
        | TunFailureKind::HelperVersionMismatch => CaptureFailureKind::CapabilityUnavailable,
    };
    CaptureTransitionError::new(kind, "TUN reconciliation failed")
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
