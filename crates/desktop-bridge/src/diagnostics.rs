use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::future::BoxFuture;
use mish_runtime::{
    CaptureFailureKind, CorePhase, DIAGNOSTIC_HISTORY_LIMIT, DiagnosticCheck, DiagnosticCheckKind,
    DiagnosticCheckStatus, DiagnosticFailure, DiagnosticHistory, DiagnosticObservedFact,
    DiagnosticProbePolicy, DiagnosticRouteTarget, DiagnosticRun, DiagnosticRunStatus, MishRuntime,
    ProxyDiagnosticFailure, StatusAdapterKind, SystemProxyPhase,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

const POLICY_ID: &str = "mish-guided-diagnostics-v1";
const ENDPOINT_LABEL: &str = "Pinned HTTPS 204 endpoint";
const EXPECTED_STATUS: u16 = 204;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

pub trait DiagnosticNetworkProbe: Send + Sync {
    fn resolve_dns(&self) -> BoxFuture<'_, Result<usize, DiagnosticFailure>>;
    fn direct_reachability(&self) -> BoxFuture<'_, Result<(u16, u64), DiagnosticFailure>>;
}

struct DesktopDiagnosticNetworkProbe;

impl DiagnosticNetworkProbe for DesktopDiagnosticNetworkProbe {
    fn resolve_dns(&self) -> BoxFuture<'_, Result<usize, DiagnosticFailure>> {
        Box::pin(async move {
            let endpoint = url::Url::parse(mish_mihomo_controller::ROUTE_DELAY_TEST_URL)
                .map_err(|_| DiagnosticFailure::Unavailable)?;
            let host = endpoint
                .host_str()
                .ok_or(DiagnosticFailure::Unavailable)?
                .to_owned();
            let result = tokio::time::timeout(PROBE_TIMEOUT, tokio::net::lookup_host((host, 443)))
                .await
                .map_err(|_| DiagnosticFailure::Timeout)?
                .map_err(|_| DiagnosticFailure::DnsFailed)?;
            let count = result.count();
            if count == 0 {
                return Err(DiagnosticFailure::DnsFailed);
            }
            Ok(count)
        })
    }

    fn direct_reachability(&self) -> BoxFuture<'_, Result<(u16, u64), DiagnosticFailure>> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(PROBE_TIMEOUT)
                .timeout(PROBE_TIMEOUT)
                .build()
                .map_err(|_| DiagnosticFailure::Unavailable)?;
            let started = Instant::now();
            let response = client
                .get(mish_mihomo_controller::ROUTE_DELAY_TEST_URL)
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        DiagnosticFailure::Timeout
                    } else {
                        DiagnosticFailure::EndpointUnreachable
                    }
                })?;
            Ok((
                response.status().as_u16(),
                started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            ))
        })
    }
}

struct DiagnosticState {
    active_cancellation: Option<CancellationToken>,
    runs: VecDeque<DiagnosticRun>,
    sequence: u64,
}

#[derive(Clone)]
pub struct DiagnosticCoordinator {
    network: Arc<dyn DiagnosticNetworkProbe>,
    state: Arc<Mutex<DiagnosticState>>,
}

struct DiagnosticRunFinalizer {
    coordinator: DiagnosticCoordinator,
    run_id: String,
}

impl Drop for DiagnosticRunFinalizer {
    fn drop(&mut self) {
        // A spawned diagnostic task can be dropped during shutdown or an unexpected
        // cancellation. Do not leave the history advertising a run that no longer exists.
        self.coordinator.invalidate_run(&self.run_id);
    }
}

impl Default for DiagnosticCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl DiagnosticCoordinator {
    pub fn new() -> Self {
        Self::with_network(Arc::new(DesktopDiagnosticNetworkProbe))
    }

    pub fn with_network(network: Arc<dyn DiagnosticNetworkProbe>) -> Self {
        Self {
            network,
            state: Arc::new(Mutex::new(DiagnosticState {
                active_cancellation: None,
                runs: VecDeque::new(),
                sequence: 0,
            })),
        }
    }

    pub fn history(&self, adapter_kind: StatusAdapterKind) -> DiagnosticHistory {
        let state = self.state.lock().expect("diagnostic state poisoned");
        DiagnosticHistory {
            active_run_id: state
                .runs
                .back()
                .filter(|run| run.status == DiagnosticRunStatus::Running)
                .map(|run| run.id.clone()),
            adapter_kind,
            runs: state.runs.iter().rev().cloned().collect(),
        }
    }

    pub fn start(
        &self,
        runtime: MishRuntime,
        runtime_changes: watch::Receiver<MishRuntime>,
        adapter_kind: StatusAdapterKind,
    ) -> DiagnosticHistory {
        let cancellation = CancellationToken::new();
        let run_id = {
            let mut state = self.state.lock().expect("diagnostic state poisoned");
            if state.active_cancellation.is_some() {
                return self.history_locked(&state, adapter_kind);
            }
            state.sequence = state.sequence.saturating_add(1);
            let run_id = format!("diagnostic-run-{}", state.sequence);
            state.runs.push_back(DiagnosticRun {
                adapter_kind,
                checks: Vec::new(),
                finished_at: None,
                id: run_id.clone(),
                policy: policy(),
                profile_id: None,
                started_at: now_milliseconds(),
                status: DiagnosticRunStatus::Running,
            });
            while state.runs.len() > DIAGNOSTIC_HISTORY_LIMIT {
                state.runs.pop_front();
            }
            state.active_cancellation = Some(cancellation.clone());
            run_id
        };
        let coordinator = self.clone();
        tokio::spawn(async move {
            coordinator
                .execute(run_id, runtime, runtime_changes, cancellation)
                .await;
        });
        self.history(adapter_kind)
    }

    pub fn cancel(&self, run_id: &str, adapter_kind: StatusAdapterKind) -> DiagnosticHistory {
        let mut state = self.state.lock().expect("diagnostic state poisoned");
        if let Some(run) = state.runs.iter_mut().find(|run| run.id == run_id)
            && run.status == DiagnosticRunStatus::Running
        {
            run.status = DiagnosticRunStatus::Cancelled;
            run.finished_at = Some(now_milliseconds());
            if let Some(cancellation) = state.active_cancellation.take() {
                cancellation.cancel();
            }
        }
        self.history_locked(&state, adapter_kind)
    }

    pub fn invalidate_active(&self) {
        let mut state = self.state.lock().expect("diagnostic state poisoned");
        if let Some(run) = state
            .runs
            .iter_mut()
            .rev()
            .find(|run| run.status == DiagnosticRunStatus::Running)
        {
            run.status = DiagnosticRunStatus::Invalidated;
            run.finished_at = Some(now_milliseconds());
        }
        if let Some(cancellation) = state.active_cancellation.take() {
            cancellation.cancel();
        }
    }

    async fn execute(
        &self,
        run_id: String,
        runtime: MishRuntime,
        mut runtime_changes: watch::Receiver<MishRuntime>,
        cancellation: CancellationToken,
    ) {
        let _finalizer = DiagnosticRunFinalizer {
            coordinator: self.clone(),
            run_id: run_id.clone(),
        };
        self.push_check(&run_id, bridge_check());
        if self.stopped(&run_id, &runtime, &mut runtime_changes, &cancellation) {
            return;
        }

        let core = match tokio::time::timeout(PROBE_TIMEOUT, runtime.core_status()).await {
            Ok(status) => status,
            Err(_) => {
                self.push_check(&run_id, timed_out_core_check(&run_id));
                self.finish(&run_id);
                return;
            }
        };
        self.push_check(&run_id, core_check(&run_id, &core));
        let status = runtime.status_snapshot_typed(StatusAdapterKind::Rpc).await;
        self.set_profile(&run_id, status.active_profile_id.clone());
        self.push_check(&run_id, profile_check(&run_id, &status));
        self.push_check(&run_id, capture_check(&run_id, &status));
        if self.stopped(&run_id, &runtime, &mut runtime_changes, &cancellation) {
            return;
        }

        let dns_started = now_milliseconds();
        let dns = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = self.network.resolve_dns() => result,
        };
        self.push_check(&run_id, dns_check(&run_id, dns_started, dns));
        if self.stopped(&run_id, &runtime, &mut runtime_changes, &cancellation) {
            return;
        }

        let direct_started = now_milliseconds();
        let direct = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = self.network.direct_reachability() => result,
        };
        self.push_check(
            &run_id,
            reachability_check(&run_id, direct_started, direct, false),
        );
        if self.stopped(&run_id, &runtime, &mut runtime_changes, &cancellation) {
            return;
        }

        let proxy_started = now_milliseconds();
        let proxy = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = runtime.run_proxy_diagnostic() => result,
        };
        self.push_check(&run_id, proxy_check(&run_id, proxy_started, proxy));
        if self.stopped(&run_id, &runtime, &mut runtime_changes, &cancellation) {
            return;
        }
        self.finish(&run_id);
    }

    fn stopped(
        &self,
        run_id: &str,
        runtime: &MishRuntime,
        changes: &mut watch::Receiver<MishRuntime>,
        cancellation: &CancellationToken,
    ) -> bool {
        if cancellation.is_cancelled() {
            return true;
        }
        if changes.has_changed().unwrap_or(true) {
            let current = changes.borrow_and_update().clone();
            if !runtime.is_same_instance(&current) {
                self.invalidate_run(run_id);
                return true;
            }
        }
        false
    }

    fn push_check(&self, run_id: &str, check: DiagnosticCheck) {
        let mut state = self.state.lock().expect("diagnostic state poisoned");
        let Some(run) = state.runs.iter_mut().find(|run| run.id == run_id) else {
            return;
        };
        if run.status == DiagnosticRunStatus::Running {
            run.checks.push(check);
        }
    }

    fn set_profile(&self, run_id: &str, profile_id: String) {
        let mut state = self.state.lock().expect("diagnostic state poisoned");
        if let Some(run) = state.runs.iter_mut().find(|run| run.id == run_id) {
            run.profile_id = (profile_id != "local").then_some(profile_id);
        }
    }

    fn finish(&self, run_id: &str) {
        let mut state = self.state.lock().expect("diagnostic state poisoned");
        if let Some(run) = state.runs.iter_mut().find(|run| run.id == run_id)
            && run.status == DiagnosticRunStatus::Running
        {
            run.status = DiagnosticRunStatus::Completed;
            run.finished_at = Some(now_milliseconds());
            state.active_cancellation = None;
        }
    }

    fn invalidate_run(&self, run_id: &str) {
        let mut state = self.state.lock().expect("diagnostic state poisoned");
        if let Some(run) = state.runs.iter_mut().find(|run| run.id == run_id)
            && run.status == DiagnosticRunStatus::Running
        {
            run.status = DiagnosticRunStatus::Invalidated;
            run.finished_at = Some(now_milliseconds());
            state.active_cancellation = None;
        }
    }

    fn history_locked(
        &self,
        state: &DiagnosticState,
        adapter_kind: StatusAdapterKind,
    ) -> DiagnosticHistory {
        DiagnosticHistory {
            active_run_id: state
                .runs
                .back()
                .filter(|run| run.status == DiagnosticRunStatus::Running)
                .map(|run| run.id.clone()),
            adapter_kind,
            runs: state.runs.iter().rev().cloned().collect(),
        }
    }
}

fn policy() -> DiagnosticProbePolicy {
    DiagnosticProbePolicy {
        endpoint_label: ENDPOINT_LABEL,
        expected_http_status: EXPECTED_STATUS,
        id: POLICY_ID,
        timeout_milliseconds: PROBE_TIMEOUT.as_millis() as u64,
    }
}

fn bridge_check() -> DiagnosticCheck {
    let at = now_milliseconds();
    DiagnosticCheck {
        failure: None,
        finished_at: at,
        id: "desktop-bridge".into(),
        interpretation: "This authenticated run reached Mish's local desktop bridge only.",
        kind: DiagnosticCheckKind::DesktopBridge,
        observed_fact: DiagnosticObservedFact::Bridge {
            authenticated: true,
        },
        route_target: DiagnosticRouteTarget::LocalBridge,
        scope: "Authenticated local desktop RPC",
        started_at: at,
        status: DiagnosticCheckStatus::Passed,
    }
}

fn core_check(run_id: &str, core: &mish_runtime::CoreStatus) -> DiagnosticCheck {
    let at = now_milliseconds();
    let running = matches!(core.phase, CorePhase::Running);
    let version_matches = core
        .version
        .as_deref()
        .is_some_and(|version| version.contains(mish_mihomo_controller::PINNED_MIHOMO_VERSION));
    let (status, failure, interpretation) = if !running {
        (
            DiagnosticCheckStatus::Failed,
            Some(DiagnosticFailure::CoreUnhealthy),
            "The managed core was not running; later route-scoped checks may be unavailable.",
        )
    } else if !version_matches {
        (
            DiagnosticCheckStatus::Failed,
            Some(DiagnosticFailure::VersionDrift),
            "The observed core version did not match Mish's pinned Controller contract.",
        )
    } else {
        (
            DiagnosticCheckStatus::Passed,
            None,
            "The managed core was running with the pinned version; this does not prove route reachability.",
        )
    };
    DiagnosticCheck {
        failure,
        finished_at: at,
        id: format!("{run_id}:core"),
        interpretation,
        kind: DiagnosticCheckKind::Core,
        observed_fact: DiagnosticObservedFact::Core {
            phase: core.phase,
            version: version_matches.then(|| mish_mihomo_controller::PINNED_MIHOMO_VERSION.into()),
        },
        route_target: DiagnosticRouteTarget::ManagedCore,
        scope: "Managed pinned Mihomo process",
        started_at: at,
        status,
    }
}

fn timed_out_core_check(run_id: &str) -> DiagnosticCheck {
    let at = now_milliseconds();
    DiagnosticCheck {
        failure: Some(DiagnosticFailure::CoreUnhealthy),
        finished_at: at,
        id: format!("{run_id}:core"),
        interpretation: "The managed core state did not respond before the bounded diagnostic deadline.",
        kind: DiagnosticCheckKind::Core,
        observed_fact: DiagnosticObservedFact::Failure {
            reason: "The bounded core state check timed out",
        },
        route_target: DiagnosticRouteTarget::ManagedCore,
        scope: "Managed pinned Mihomo process",
        started_at: at,
        status: DiagnosticCheckStatus::Failed,
    }
}

fn profile_check(run_id: &str, snapshot: &mish_runtime::StatusSnapshot) -> DiagnosticCheck {
    let at = now_milliseconds();
    let present = snapshot.active_profile_id != "local";
    let valid = present
        && snapshot
            .profiles
            .iter()
            .any(|profile| profile.id == snapshot.active_profile_id);
    DiagnosticCheck {
        failure: (!valid).then_some(if present {
            DiagnosticFailure::ProfileInvalid
        } else {
            DiagnosticFailure::NoActiveProfile
        }),
        finished_at: at,
        id: format!("{run_id}:profile"),
        interpretation: if valid {
            "The run is bound to one validated active Profile context."
        } else {
            "No validated active Profile context was available for route-scoped checks."
        },
        kind: DiagnosticCheckKind::Profile,
        observed_fact: DiagnosticObservedFact::Profile { present, valid },
        route_target: DiagnosticRouteTarget::ActiveProfile,
        scope: "Active repository-owned Profile",
        started_at: at,
        status: if valid {
            DiagnosticCheckStatus::Passed
        } else {
            DiagnosticCheckStatus::Failed
        },
    }
}

fn capture_check(run_id: &str, snapshot: &mish_runtime::StatusSnapshot) -> DiagnosticCheck {
    let at = now_milliseconds();
    let capture = &snapshot.runtime.system_proxy;
    let drift = capture.phase == SystemProxyPhase::Drift;
    let permission = capture.failure == Some(CaptureFailureKind::PermissionDenied);
    let failure = if drift {
        Some(DiagnosticFailure::CaptureDrift)
    } else if permission {
        Some(DiagnosticFailure::PermissionDenied)
    } else {
        None
    };
    DiagnosticCheck {
        failure,
        finished_at: at,
        id: format!("{run_id}:capture"),
        interpretation: if drift {
            "The desired and observed System Proxy states differ; diagnostics did not repair them."
        } else if permission {
            "System Proxy permission was denied; diagnostics did not request or change permission."
        } else {
            "This reports the current desired and observed capture state without changing it."
        },
        kind: DiagnosticCheckKind::Capture,
        observed_fact: DiagnosticObservedFact::Capture {
            desired: capture.desired,
            drift,
            observed: capture.observed,
        },
        route_target: DiagnosticRouteTarget::CaptureState,
        scope: "System Proxy desired and observed state",
        started_at: at,
        status: if failure.is_some() {
            DiagnosticCheckStatus::Failed
        } else {
            DiagnosticCheckStatus::Passed
        },
    }
}

fn dns_check(
    run_id: &str,
    started_at: u64,
    result: Result<usize, DiagnosticFailure>,
) -> DiagnosticCheck {
    match result {
        Ok(address_count) => DiagnosticCheck {
            failure: None,
            finished_at: now_milliseconds(),
            id: format!("{run_id}:dns"),
            interpretation: "The fixed policy hostname resolved locally; no address value was retained.",
            kind: DiagnosticCheckKind::Dns,
            observed_fact: DiagnosticObservedFact::Dns { address_count },
            route_target: DiagnosticRouteTarget::FixedEndpoint { route: "direct" },
            scope: "System DNS for the fixed policy endpoint",
            started_at,
            status: DiagnosticCheckStatus::Passed,
        },
        Err(failure) => failed_check(
            run_id,
            DiagnosticCheckKind::Dns,
            DiagnosticRouteTarget::FixedEndpoint { route: "direct" },
            "System DNS for the fixed policy endpoint",
            started_at,
            failure,
            "The fixed policy hostname did not resolve within the bounded check.",
        ),
    }
}

fn reachability_check(
    run_id: &str,
    started_at: u64,
    result: Result<(u16, u64), DiagnosticFailure>,
    _proxy: bool,
) -> DiagnosticCheck {
    match result {
        Ok((http_status, latency_milliseconds)) if http_status == EXPECTED_STATUS => {
            DiagnosticCheck {
                failure: None,
                finished_at: now_milliseconds(),
                id: format!("{run_id}:direct"),
                interpretation: "The fixed endpoint responded directly; this is not proof that the whole internet is reachable.",
                kind: DiagnosticCheckKind::DirectReachability,
                observed_fact: DiagnosticObservedFact::Reachability {
                    http_status,
                    latency_milliseconds,
                },
                route_target: DiagnosticRouteTarget::FixedEndpoint { route: "direct" },
                scope: "Direct HTTPS to one fixed policy endpoint",
                started_at,
                status: DiagnosticCheckStatus::Passed,
            }
        }
        Ok((http_status, latency_milliseconds)) => DiagnosticCheck {
            failure: Some(DiagnosticFailure::EndpointUnreachable),
            finished_at: now_milliseconds(),
            id: format!("{run_id}:direct"),
            interpretation: "The fixed endpoint responded with an unexpected status; no broader connectivity claim is made.",
            kind: DiagnosticCheckKind::DirectReachability,
            observed_fact: DiagnosticObservedFact::Reachability {
                http_status,
                latency_milliseconds,
            },
            route_target: DiagnosticRouteTarget::FixedEndpoint { route: "direct" },
            scope: "Direct HTTPS to one fixed policy endpoint",
            started_at,
            status: DiagnosticCheckStatus::Failed,
        },
        Err(failure) => failed_check(
            run_id,
            DiagnosticCheckKind::DirectReachability,
            DiagnosticRouteTarget::FixedEndpoint { route: "direct" },
            "Direct HTTPS to one fixed policy endpoint",
            started_at,
            failure,
            "The one fixed endpoint was not reachable directly; no broader connectivity claim is made.",
        ),
    }
}

fn proxy_check(
    run_id: &str,
    started_at: u64,
    result: Result<mish_runtime::ProxyDiagnosticObservation, ProxyDiagnosticFailure>,
) -> DiagnosticCheck {
    match result {
        Ok(observation) => DiagnosticCheck {
            failure: None,
            finished_at: now_milliseconds(),
            id: format!("{run_id}:proxy"),
            interpretation: "One selected child in one explicit policy group reached the fixed endpoint; other routes were not tested.",
            kind: DiagnosticCheckKind::ProxyReachability,
            observed_fact: DiagnosticObservedFact::Reachability {
                http_status: EXPECTED_STATUS,
                latency_milliseconds: observation.latency_milliseconds,
            },
            route_target: DiagnosticRouteTarget::PolicyGroup {
                child_id: observation.child_id,
                group_id: observation.group_id,
            },
            scope: "One selected child of one active policy group",
            started_at,
            status: DiagnosticCheckStatus::Passed,
        },
        Err(failure) => {
            let (status, typed_failure, interpretation) = match failure {
                ProxyDiagnosticFailure::NoScopedTarget => (
                    DiagnosticCheckStatus::Unavailable,
                    DiagnosticFailure::Unavailable,
                    "No stable selected policy-group target was available; no proxy result was fabricated.",
                ),
                ProxyDiagnosticFailure::VersionDrift => (
                    DiagnosticCheckStatus::Failed,
                    DiagnosticFailure::VersionDrift,
                    "The pinned Controller contract changed before the scoped proxy check completed.",
                ),
                ProxyDiagnosticFailure::Timeout => (
                    DiagnosticCheckStatus::Failed,
                    DiagnosticFailure::Timeout,
                    "The scoped proxy route did not complete the fixed probe before the deadline.",
                ),
                ProxyDiagnosticFailure::Disconnected => (
                    DiagnosticCheckStatus::Unavailable,
                    DiagnosticFailure::ControllerDisconnected,
                    "The Controller was unavailable, so no scoped proxy result was fabricated.",
                ),
                ProxyDiagnosticFailure::Cancelled => (
                    DiagnosticCheckStatus::Cancelled,
                    DiagnosticFailure::Cancelled,
                    "The scoped proxy check was cancelled.",
                ),
                ProxyDiagnosticFailure::Unavailable
                | ProxyDiagnosticFailure::InconsistentObservation => (
                    DiagnosticCheckStatus::Unavailable,
                    DiagnosticFailure::Unavailable,
                    "The scoped proxy observation could not be reconciled safely.",
                ),
            };
            DiagnosticCheck {
                failure: Some(typed_failure),
                finished_at: now_milliseconds(),
                id: format!("{run_id}:proxy"),
                interpretation,
                kind: DiagnosticCheckKind::ProxyReachability,
                observed_fact: DiagnosticObservedFact::Unavailable {
                    reason: "No reconciled scoped proxy observation",
                },
                route_target: DiagnosticRouteTarget::PolicyGroupUnavailable,
                scope: "One selected child of one active policy group",
                started_at,
                status,
            }
        }
    }
}

fn failed_check(
    run_id: &str,
    kind: DiagnosticCheckKind,
    route_target: DiagnosticRouteTarget,
    scope: &'static str,
    started_at: u64,
    failure: DiagnosticFailure,
    interpretation: &'static str,
) -> DiagnosticCheck {
    let suffix = match kind {
        DiagnosticCheckKind::Dns => "dns",
        DiagnosticCheckKind::DirectReachability => "direct",
        _ => "check",
    };
    DiagnosticCheck {
        failure: Some(failure),
        finished_at: now_milliseconds(),
        id: format!("{run_id}:{suffix}"),
        interpretation,
        kind,
        observed_fact: DiagnosticObservedFact::Failure {
            reason: "The bounded check did not produce the expected observation",
        },
        route_target,
        scope,
        started_at,
        status: DiagnosticCheckStatus::Failed,
    }
}

fn now_milliseconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mish_runtime::{CoreError, CoreRuntime, CoreStatus};

    struct FixedCore;

    impl CoreRuntime for FixedCore {
        fn configured(&self) -> bool {
            true
        }

        fn status(&self) -> BoxFuture<'_, CoreStatus> {
            Box::pin(std::future::ready(CoreStatus {
                error: None,
                phase: CorePhase::Running,
                pid: Some(1),
                version: Some("Mihomo Meta v1.19.29".into()),
            }))
        }

        fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
            Box::pin(async { unreachable!() })
        }

        fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
            Box::pin(async { unreachable!() })
        }
    }

    struct FixedNetwork;

    impl DiagnosticNetworkProbe for FixedNetwork {
        fn resolve_dns(&self) -> BoxFuture<'_, Result<usize, DiagnosticFailure>> {
            Box::pin(std::future::ready(Ok(2)))
        }

        fn direct_reachability(&self) -> BoxFuture<'_, Result<(u16, u64), DiagnosticFailure>> {
            Box::pin(std::future::ready(Ok((204, 7))))
        }
    }

    struct UnavailableNetwork;

    impl DiagnosticNetworkProbe for UnavailableNetwork {
        fn resolve_dns(&self) -> BoxFuture<'_, Result<usize, DiagnosticFailure>> {
            Box::pin(std::future::ready(Err(DiagnosticFailure::Unavailable)))
        }

        fn direct_reachability(&self) -> BoxFuture<'_, Result<(u16, u64), DiagnosticFailure>> {
            Box::pin(std::future::ready(Err(
                DiagnosticFailure::EndpointUnreachable,
            )))
        }
    }

    async fn wait_for_terminal_history(coordinator: &DiagnosticCoordinator) -> DiagnosticHistory {
        for _ in 0..20 {
            let history = coordinator.history(StatusAdapterKind::Rpc);
            if history.active_run_id.is_none() {
                return history;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("diagnostic run did not reach a terminal state");
    }

    #[tokio::test]
    async fn bounds_history_and_marks_unsupported_proxy_partial() {
        let coordinator = DiagnosticCoordinator::with_network(Arc::new(FixedNetwork));
        let runtime = MishRuntime::new(Arc::new(FixedCore));
        let (changes, receiver) = watch::channel(runtime.clone());
        for _ in 0..10 {
            coordinator.start(runtime.clone(), receiver.clone(), StatusAdapterKind::Rpc);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(changes);
        let history = coordinator.history(StatusAdapterKind::Rpc);
        assert_eq!(history.runs.len(), DIAGNOSTIC_HISTORY_LIMIT);
        assert!(
            history.runs[0]
                .checks
                .iter()
                .any(|check| check.kind == DiagnosticCheckKind::ProxyReachability
                    && check.status == DiagnosticCheckStatus::Unavailable)
        );
    }

    #[tokio::test]
    async fn cancellation_and_runtime_replacement_are_terminal() {
        let coordinator = DiagnosticCoordinator::with_network(Arc::new(FixedNetwork));
        let runtime = MishRuntime::new(Arc::new(FixedCore));
        let (changes, receiver) = watch::channel(runtime.clone());
        let started = coordinator.start(runtime.clone(), receiver, StatusAdapterKind::Rpc);
        coordinator.cancel(
            started.active_run_id.as_deref().expect("active run"),
            StatusAdapterKind::Rpc,
        );
        assert_eq!(
            coordinator.history(StatusAdapterKind::Rpc).runs[0].status,
            DiagnosticRunStatus::Cancelled
        );

        let receiver = changes.subscribe();
        coordinator.start(runtime, receiver, StatusAdapterKind::Rpc);
        coordinator.invalidate_active();
        assert_eq!(
            coordinator.history(StatusAdapterKind::Rpc).runs[0].status,
            DiagnosticRunStatus::Invalidated
        );
    }

    #[tokio::test]
    async fn unavailable_and_failed_checks_complete_the_same_run() {
        let coordinator = DiagnosticCoordinator::with_network(Arc::new(UnavailableNetwork));
        let runtime = MishRuntime::new(Arc::new(FixedCore));
        let (_changes, receiver) = watch::channel(runtime.clone());

        let started = coordinator.start(runtime, receiver, StatusAdapterKind::Rpc);
        let history = wait_for_terminal_history(&coordinator).await;

        assert_eq!(history.runs.len(), 1);
        assert_eq!(history.runs[0].id, started.runs[0].id);
        assert_eq!(history.runs[0].status, DiagnosticRunStatus::Completed);
        assert!(history.runs[0].finished_at.is_some());
        assert!(
            history.runs[0]
                .checks
                .iter()
                .any(|check| check.status == DiagnosticCheckStatus::Unavailable)
        );
        assert!(
            history.runs[0]
                .checks
                .iter()
                .any(|check| check.status == DiagnosticCheckStatus::Failed)
        );
    }

    #[test]
    fn failures_remain_typed_and_observations_do_not_overclaim() {
        let dns = dns_check("run", 1, Err(DiagnosticFailure::DnsFailed));
        assert_eq!(dns.status, DiagnosticCheckStatus::Failed);
        assert_eq!(dns.failure, Some(DiagnosticFailure::DnsFailed));

        let direct = reachability_check("run", 1, Ok((204, 9)), false);
        assert_eq!(direct.status, DiagnosticCheckStatus::Passed);
        assert!(direct.interpretation.contains("not proof"));

        let proxy = proxy_check("run", 1, Err(ProxyDiagnosticFailure::Disconnected));
        assert_eq!(proxy.status, DiagnosticCheckStatus::Unavailable);
        assert_eq!(
            proxy.failure,
            Some(DiagnosticFailure::ControllerDisconnected)
        );

        let timed_out = timed_out_core_check("run");
        assert_eq!(timed_out.status, DiagnosticCheckStatus::Failed);
        assert_eq!(timed_out.failure, Some(DiagnosticFailure::CoreUnhealthy));
        assert!(matches!(
            timed_out.route_target,
            DiagnosticRouteTarget::ManagedCore
        ));
    }

    #[test]
    fn serialized_contract_excludes_endpoint_host_paths_and_credentials() {
        let run = DiagnosticRun {
            adapter_kind: StatusAdapterKind::Rpc,
            checks: vec![bridge_check()],
            finished_at: Some(2),
            id: "diagnostic-run-1".into(),
            policy: policy(),
            profile_id: Some("profile:synthetic".into()),
            started_at: 1,
            status: DiagnosticRunStatus::Completed,
        };
        let serialized = serde_json::to_string(&run).unwrap();
        assert!(!serialized.contains(mish_mihomo_controller::ROUTE_DELAY_TEST_URL));
        assert!(!serialized.contains("/Users/"));
        assert!(!serialized.contains("token="));
    }
}
