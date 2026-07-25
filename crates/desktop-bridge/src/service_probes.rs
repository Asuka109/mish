use std::{
    collections::HashMap,
    fs, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::Utc;
use futures_util::{
    FutureExt, StreamExt,
    future::{BoxFuture, Shared},
    stream::FuturesUnordered,
};
use mish_runtime::{
    ProbeStatus, ServiceMonitor, ServiceProbeFailureStage, ServiceProbePolicy, ServiceProbeResult,
    StatusSnapshot, default_service_monitors,
};
use reqwest::{
    Client, StatusCode, Url,
    dns::{Addrs, Name, Resolve, Resolving},
    header::RETRY_AFTER,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify, broadcast};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DEFAULT_INTERVAL_SECONDS: u16 = 5;
const DISABLED_INTERVAL_SECONDS: u16 = 0;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_MONITORS: usize = 12;
const LEGACY_MAX_MONITORS: usize = 24;
const ALLOWED_INTERVALS: [u16; 5] = [0, 5, 10, 30, 60];
const PERSISTED_INTERVALS: [u16; 6] = [0, 5, 10, 30, 60, 300];
const BODY_DRAIN_LIMIT_BYTES: usize = 64 * 1024;
const FALLBACK_SERVICE_ICON_URL: &str = "/assets/remix-icon/cloud.svg";
const BUNDLED_SERVICE_ICON_URLS: [&str; 8] = [
    "/assets/remix-icon/apple.svg",
    "/assets/remix-icon/aws.svg",
    "/assets/remix-icon/baidu.svg",
    "/assets/remix-icon/cloud.svg",
    "/assets/remix-icon/github.svg",
    "/assets/remix-icon/google.svg",
    "/assets/remix-icon/microsoft.svg",
    "/assets/remix-icon/wechat.svg",
];

#[derive(Clone, Debug)]
pub struct ServiceProbeConfig {
    pub state_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceMonitorDraft {
    pub icon: String,
    pub id: Option<String>,
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedState {
    interval_seconds: u16,
    services: Vec<ServiceMonitor>,
    version: u8,
}

#[derive(Clone)]
struct ProbeState {
    interval_seconds: u16,
    probe_order: Vec<usize>,
    revision: u64,
    results: Vec<ServiceProbeResult>,
    services: Vec<ServiceMonitor>,
}

#[derive(Clone, Debug)]
struct ProbeOutcome {
    failure_stage: Option<ServiceProbeFailureStage>,
    latency_milliseconds: Option<u64>,
    retry_after: Option<Duration>,
    status: ProbeStatus,
}

type SharedProbe = Shared<BoxFuture<'static, ProbeExecution>>;

#[derive(Clone, Debug)]
enum ProbeExecution {
    Cancelled,
    Finished(ProbeOutcome),
}

#[derive(Default)]
struct HostState {
    consecutive_failures: usize,
    in_flight: Option<SharedProbe>,
    next_allowed_at: Option<tokio::time::Instant>,
}

struct Inner {
    cancel: CancellationToken,
    core_started: Notify,
    host_states: AsyncMutex<HashMap<String, HostState>>,
    revision_cancel: Mutex<CancellationToken>,
    state: Mutex<ProbeState>,
    state_path: Option<PathBuf>,
    updates: broadcast::Sender<()>,
    wake: Notify,
    transport: Arc<dyn ProbeTransport>,
}

#[derive(Clone)]
struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|address| is_public_ip(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "service probe DNS resolution returned no public addresses",
                )
                .into());
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

trait ProbeTransport: Send + Sync {
    fn execute(
        &self,
        cancel: CancellationToken,
        monitor: ServiceMonitor,
    ) -> BoxFuture<'static, ProbeExecution>;
}

struct HttpProbeTransport {
    client: Client,
}

impl ProbeTransport for HttpProbeTransport {
    fn execute(
        &self,
        cancel: CancellationToken,
        monitor: ServiceMonitor,
    ) -> BoxFuture<'static, ProbeExecution> {
        let client = self.client.clone();
        async move { probe(&client, cancel, monitor).await }.boxed()
    }
}

#[derive(Clone)]
pub struct ServiceProbeService {
    inner: Arc<Inner>,
}

impl ServiceProbeService {
    pub fn new(config: ServiceProbeConfig) -> Self {
        let persisted = config
            .state_path
            .as_deref()
            .and_then(|path| load_state(path).ok())
            .filter(valid_persisted_state);
        let interval_seconds = persisted
            .as_ref()
            .map_or(DEFAULT_INTERVAL_SECONDS, |state| {
                normalize_persisted_interval(state.interval_seconds)
            });
        let mut services: Vec<ServiceMonitor> = persisted
            .map(|state| state.services)
            .unwrap_or_else(default_service_monitors)
            .into_iter()
            .map(normalize_persisted_icon)
            .collect();
        services.truncate(MAX_MONITORS);
        let services = migrate_legacy_defaults(services);
        let client = Client::builder()
            .connect_timeout(PROBE_TIMEOUT)
            .timeout(PROBE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(PublicDnsResolver))
            .build()
            .expect("service probe client configuration must be valid");
        Self::from_parts(
            config,
            interval_seconds,
            services,
            Arc::new(HttpProbeTransport { client }),
        )
    }

    fn from_parts(
        config: ServiceProbeConfig,
        interval_seconds: u16,
        services: Vec<ServiceMonitor>,
        transport: Arc<dyn ProbeTransport>,
    ) -> Self {
        let (updates, _) = broadcast::channel(32);
        let cancel = CancellationToken::new();
        Self {
            inner: Arc::new(Inner {
                cancel: cancel.clone(),
                core_started: Notify::new(),
                host_states: AsyncMutex::new(HashMap::new()),
                revision_cancel: Mutex::new(cancel.child_token()),
                state: Mutex::new(ProbeState {
                    interval_seconds,
                    probe_order: randomized_probe_order(services.len()),
                    revision: 0,
                    results: pending_results(&services),
                    services,
                }),
                state_path: config.state_path,
                updates,
                wake: Notify::new(),
                transport,
            }),
        }
    }

    pub fn start(&self) {
        let service = self.clone();
        tokio::spawn(async move { service.run().await });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.inner.updates.subscribe()
    }

    pub fn overlay(&self, snapshot: &mut StatusSnapshot) {
        let state = self
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        snapshot.service_probe_policy = ServiceProbePolicy {
            interval_seconds: state.interval_seconds,
        };
        snapshot.services.clone_from(&state.services);
        snapshot.probe_results.clone_from(&state.results);
    }

    pub async fn upsert(&self, draft: ServiceMonitorDraft) -> Result<(), ServiceProbeError> {
        validate_icon_url(&draft.icon)?;
        validate_label(&draft.label)?;
        validate_probe_url(&draft.url).await?;
        let mut state = self
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        let mut next = state.clone();
        if let Some(id) = &draft.id {
            let Some(existing) = next.services.iter_mut().find(|monitor| monitor.id == *id) else {
                return Err(ServiceProbeError::NotFound);
            };
            existing.icon = draft.icon;
            existing.label = draft.label;
            existing.url = draft.url;
        } else {
            if next.services.len() >= MAX_MONITORS {
                return Err(ServiceProbeError::Invalid("Service monitor limit reached"));
            }
            next.services.push(ServiceMonitor {
                icon: draft.icon,
                id: format!("service-{}", Uuid::new_v4()),
                label: draft.label,
                url: draft.url,
            });
        }
        next.probe_order = randomized_probe_order(next.services.len());
        next.revision = next.revision.wrapping_add(1);
        next.results = retained_results(&state.services, &state.results, &next.services);
        persist_locked(self.inner.state_path.as_deref(), &next)?;
        *state = next;
        drop(state);
        self.changed();
        Ok(())
    }

    pub fn remove(&self, monitor_id: &str) -> Result<(), ServiceProbeError> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        let mut next = state.clone();
        let previous_len = next.services.len();
        next.services.retain(|monitor| monitor.id != monitor_id);
        if next.services.len() == previous_len {
            return Err(ServiceProbeError::NotFound);
        }
        next.results
            .retain(|result| result.monitor_id != monitor_id);
        next.probe_order = randomized_probe_order(next.services.len());
        next.revision = next.revision.wrapping_add(1);
        persist_locked(self.inner.state_path.as_deref(), &next)?;
        *state = next;
        drop(state);
        self.changed();
        Ok(())
    }

    pub fn restore_defaults(&self) -> Result<(), ServiceProbeError> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        let mut next = state.clone();
        next.services = default_service_monitors();
        next.interval_seconds = DEFAULT_INTERVAL_SECONDS;
        next.probe_order = randomized_probe_order(next.services.len());
        next.revision = next.revision.wrapping_add(1);
        next.results = retained_results(&state.services, &state.results, &next.services);
        persist_locked(self.inner.state_path.as_deref(), &next)?;
        *state = next;
        drop(state);
        self.changed();
        Ok(())
    }

    pub fn set_interval(&self, interval_seconds: u16) -> Result<(), ServiceProbeError> {
        if !ALLOWED_INTERVALS.contains(&interval_seconds) {
            return Err(ServiceProbeError::Invalid(
                "Unsupported service probe interval",
            ));
        }
        let mut state = self
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        let mut next = state.clone();
        next.interval_seconds = interval_seconds;
        next.probe_order = randomized_probe_order(next.services.len());
        next.revision = next.revision.wrapping_add(1);
        persist_locked(self.inner.state_path.as_deref(), &next)?;
        *state = next;
        drop(state);
        self.changed();
        Ok(())
    }

    pub async fn test(&self, monitor_id: &str) -> Result<(), ServiceProbeError> {
        let (revision, revision_cancel, monitor) = {
            let state = self
                .inner
                .state
                .lock()
                .expect("service probe state poisoned");
            let monitor = state
                .services
                .iter()
                .find(|monitor| monitor.id == monitor_id)
                .cloned()
                .ok_or(ServiceProbeError::NotFound)?;
            (state.revision, self.revision_cancel_token(), monitor)
        };

        let Some(result) = self
            .probe_monitor(revision_cancel, monitor.clone())
            .await
            .map(|outcome| result_from_outcome(&monitor, outcome))
        else {
            return Ok(());
        };
        let mut state = self
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        if state.revision != revision {
            return Ok(());
        }
        let Some(existing) = state
            .results
            .iter_mut()
            .find(|candidate| candidate.monitor_id == monitor_id)
        else {
            return Ok(());
        };
        *existing = result;
        drop(state);
        let _ = self.inner.updates.send(());
        Ok(())
    }

    pub fn shutdown(&self) {
        self.inner.cancel.cancel();
    }

    pub fn test_after_core_start(&self) {
        let state = self
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        if state.interval_seconds == DISABLED_INTERVAL_SECONDS {
            self.inner.core_started.notify_one();
        }
    }

    fn changed(&self) {
        let mut cancellation = self
            .inner
            .revision_cancel
            .lock()
            .expect("service probe revision cancellation poisoned");
        cancellation.cancel();
        *cancellation = self.inner.cancel.child_token();
        drop(cancellation);
        let _ = self.inner.updates.send(());
        self.inner.wake.notify_one();
    }

    fn revision_cancel_token(&self) -> CancellationToken {
        self.inner
            .revision_cancel
            .lock()
            .expect("service probe revision cancellation poisoned")
            .clone()
    }

    async fn run(&self) {
        loop {
            let interval_seconds = self.interval_seconds();
            if interval_seconds == DISABLED_INTERVAL_SECONDS {
                tokio::select! {
                    () = self.inner.cancel.cancelled() => break,
                    () = self.inner.wake.notified() => {},
                    () = self.inner.core_started.notified() => {
                        self.run_cycle(DEFAULT_INTERVAL_SECONDS).await
                    },
                }
                continue;
            }

            tokio::select! {
                () = self.inner.cancel.cancelled() => break,
                () = self.run_cycle(interval_seconds) => {},
            }
        }
    }

    fn interval_seconds(&self) -> u16 {
        self.inner
            .state
            .lock()
            .expect("service probe state poisoned")
            .interval_seconds
    }

    async fn run_cycle(&self, interval_seconds: u16) {
        let (revision, revision_cancel, services) = {
            let state = self
                .inner
                .state
                .lock()
                .expect("service probe state poisoned");
            let services = state
                .probe_order
                .iter()
                .filter_map(|index| state.services.get(*index).cloned())
                .collect::<Vec<_>>();
            (state.revision, self.revision_cancel_token(), services)
        };
        let cycle_started_at = tokio::time::Instant::now();
        let cycle_duration = Duration::from_secs(u64::from(interval_seconds));
        let service_count = services.len();
        let mut probes: FuturesUnordered<_> = services
            .into_iter()
            .enumerate()
            .map(|(index, monitor)| {
                let revision_cancel = revision_cancel.clone();
                async move {
                    let scheduled_at = cycle_started_at
                        + evenly_spaced_offset(cycle_duration, index, service_count);
                    tokio::select! {
                        () = revision_cancel.cancelled() => return None,
                        () = tokio::time::sleep_until(scheduled_at) => {},
                    }
                    let outcome = self.probe_monitor(revision_cancel, monitor.clone()).await?;
                    Some(result_from_outcome(&monitor, outcome))
                }
            })
            .collect();
        while let Some(Some(result)) = probes.next().await {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service probe state poisoned");
            if state.revision != revision {
                continue;
            }
            let Some(existing) = state
                .results
                .iter_mut()
                .find(|candidate| candidate.monitor_id == result.monitor_id)
            else {
                continue;
            };
            *existing = result;
            drop(state);
            let _ = self.inner.updates.send(());
        }
        tokio::select! {
            () = self.inner.cancel.cancelled() => {},
            () = self.inner.wake.notified() => {},
            () = tokio::time::sleep_until(cycle_started_at + cycle_duration) => {},
        }
    }

    async fn probe_monitor(
        &self,
        revision_cancel: CancellationToken,
        monitor: ServiceMonitor,
    ) -> Option<ProbeOutcome> {
        let host = normalized_host(&monitor.url)?;
        let (probe, owner) = {
            let mut states = self.inner.host_states.lock().await;
            if !states.contains_key(&host) && states.len() >= MAX_MONITORS {
                states.retain(|_, state| state.in_flight.is_some());
            }
            let host_state = states.entry(host.clone()).or_default();
            if host_state
                .next_allowed_at
                .is_some_and(|deadline| deadline > tokio::time::Instant::now())
            {
                return None;
            }
            if let Some(in_flight) = &host_state.in_flight {
                (in_flight.clone(), false)
            } else {
                let transport = self.inner.transport.clone();
                let monitor = monitor.clone();
                let cancel = revision_cancel.clone();
                let probe = transport.execute(cancel, monitor).shared();
                host_state.in_flight = Some(probe.clone());
                (probe, true)
            }
        };

        let execution = probe.await;
        if owner {
            let mut states = self.inner.host_states.lock().await;
            let host_state = states.entry(host).or_default();
            host_state.in_flight = None;
            if let ProbeExecution::Finished(outcome) = &execution {
                update_host_backoff(host_state, outcome);
            }
        }
        match execution {
            ProbeExecution::Cancelled => None,
            ProbeExecution::Finished(outcome) => Some(outcome),
        }
    }
}

fn randomized_probe_order(service_count: usize) -> Vec<usize> {
    probe_order_from_samples(service_count, Uuid::new_v4().as_bytes())
}

fn probe_order_from_samples(service_count: usize, samples: &[u8]) -> Vec<usize> {
    let mut order: Vec<_> = (0..service_count).collect();
    for (sample, upper) in samples.iter().zip((1..service_count).rev()) {
        order.swap(upper, usize::from(*sample) % (upper + 1));
    }
    order
}

fn evenly_spaced_offset(cycle_duration: Duration, index: usize, count: usize) -> Duration {
    if count == 0 {
        return Duration::ZERO;
    }
    let nanos = cycle_duration.as_nanos() * index as u128 / count as u128;
    Duration::from_nanos(nanos.try_into().unwrap_or(u64::MAX))
}

fn normalized_host(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default()?;
    Some(format!("{host}:{port}"))
}

fn update_host_backoff(host: &mut HostState, outcome: &ProbeOutcome) {
    if outcome.status == ProbeStatus::Healthy {
        host.consecutive_failures = 0;
        host.next_allowed_at = None;
        return;
    }
    host.consecutive_failures = host.consecutive_failures.saturating_add(1);
    let delay = outcome
        .retry_after
        .unwrap_or_else(|| failure_delay(host.consecutive_failures));
    host.next_allowed_at = Some(tokio::time::Instant::now() + delay);
}

fn failure_delay(consecutive_failures: usize) -> Duration {
    const DELAYS: [Duration; 7] = [
        Duration::from_secs(5 * 60),
        Duration::from_secs(15 * 60),
        Duration::from_secs(30 * 60),
        Duration::from_secs(60 * 60),
        Duration::from_secs(2 * 60 * 60),
        Duration::from_secs(4 * 60 * 60),
        Duration::from_secs(6 * 60 * 60),
    ];
    DELAYS[consecutive_failures.saturating_sub(1).min(DELAYS.len() - 1)]
}

#[derive(Debug)]
pub enum ServiceProbeError {
    Invalid(&'static str),
    Io,
    NotFound,
}

impl ServiceProbeError {
    pub const fn message(&self) -> &'static str {
        match self {
            Self::Invalid(message) => message,
            Self::Io => "Service monitor state could not be saved",
            Self::NotFound => "Service monitor not found",
        }
    }
}

fn load_state(path: &Path) -> Result<PersistedState, io::Error> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn valid_persisted_state(state: &PersistedState) -> bool {
    state.version == 1
        && valid_persisted_interval(state.interval_seconds)
        && state.services.len() <= LEGACY_MAX_MONITORS
        && state.services.iter().all(|monitor| {
            valid_identifier(&monitor.id)
                && monitor.icon.len() <= 2_048
                && validate_label(&monitor.label).is_ok()
                && syntactically_safe_url(&monitor.url)
        })
}

fn valid_persisted_interval(interval_seconds: u16) -> bool {
    PERSISTED_INTERVALS.contains(&interval_seconds)
}

fn normalize_persisted_interval(interval_seconds: u16) -> u16 {
    if interval_seconds == 300 {
        DEFAULT_INTERVAL_SECONDS
    } else {
        interval_seconds
    }
}

fn normalize_persisted_icon(mut monitor: ServiceMonitor) -> ServiceMonitor {
    if let Some(icon) = current_default_icon_url(&monitor.icon)
        && default_monitor_uses_icon(&monitor, icon)
    {
        monitor.icon = icon.into();
    } else if !valid_icon_url(&monitor.icon) {
        monitor.icon = FALLBACK_SERVICE_ICON_URL.into();
    }
    monitor
}

fn migrate_legacy_defaults(mut services: Vec<ServiceMonitor>) -> Vec<ServiceMonitor> {
    let is_exact = |monitor: &ServiceMonitor, id: &str, label: &str, icon: &str, url: &str| {
        monitor.id == id && monitor.label == label && monitor.icon == icon && monitor.url == url
    };
    let legacy_default_seen = services.iter().any(|monitor| {
        is_exact(
            monitor,
            "github",
            "GitHub",
            "/assets/remix-icon/github.svg",
            "https://github.com",
        ) || is_exact(
            monitor,
            "baidu",
            "Baidu",
            "/assets/remix-icon/baidu.svg",
            "https://www.baidu.com",
        ) || is_exact(
            monitor,
            "apple",
            "Apple",
            "/assets/remix-icon/apple.svg",
            "https://www.apple.com/library/test/success.html",
        ) || is_exact(
            monitor,
            "microsoft",
            "Microsoft",
            "/assets/remix-icon/microsoft.svg",
            "http://www.msftconnecttest.com/connecttest.txt",
        ) || is_exact(
            monitor,
            "microsoft",
            "Microsoft",
            "/assets/remix-icon/microsoft.svg",
            "https://www.msftconnecttest.com/connecttest.txt",
        )
    });
    services.retain(|monitor| {
        !is_exact(
            monitor,
            "apple",
            "Apple",
            "/assets/remix-icon/apple.svg",
            "https://www.apple.com/library/test/success.html",
        ) && !is_exact(
            monitor,
            "microsoft",
            "Microsoft",
            "/assets/remix-icon/microsoft.svg",
            "http://www.msftconnecttest.com/connecttest.txt",
        ) && !is_exact(
            monitor,
            "microsoft",
            "Microsoft",
            "/assets/remix-icon/microsoft.svg",
            "https://www.msftconnecttest.com/connecttest.txt",
        )
    });
    for monitor in &mut services {
        if is_exact(
            monitor,
            "github",
            "GitHub",
            "/assets/remix-icon/github.svg",
            "https://github.com",
        ) {
            monitor.url = "https://github.com/favicon.ico".into();
        }
        if is_exact(
            monitor,
            "baidu",
            "Baidu",
            "/assets/remix-icon/baidu.svg",
            "https://www.baidu.com",
        ) {
            monitor.url = "https://www.baidu.com/favicon.ico".into();
        }
    }
    if legacy_default_seen {
        let defaults = default_service_monitors();
        for default in &defaults[4..] {
            if services.len() >= MAX_MONITORS {
                break;
            }
            if !services
                .iter()
                .any(|monitor| monitor.id == default.id && monitor.url == default.url)
            {
                services.push(default.clone());
            }
        }
    }
    services
}

fn default_monitor_uses_icon(monitor: &ServiceMonitor, icon: &str) -> bool {
    matches!(
        (monitor.id.as_str(), monitor.label.as_str(), icon,),
        ("apple", "Apple", "/assets/remix-icon/apple.svg")
            | ("baidu", "Baidu", "/assets/remix-icon/baidu.svg")
            | ("cloudflare", "Cloudflare", "/assets/remix-icon/cloud.svg")
            | ("github", "GitHub", "/assets/remix-icon/github.svg")
            | ("google", "Google", "/assets/remix-icon/google.svg")
            | ("microsoft", "Microsoft", "/assets/remix-icon/microsoft.svg")
    )
}

fn current_default_icon_url(value: &str) -> Option<&'static str> {
    match value {
        "apple"
        | "device"
        | "/assets/remix-icon/apple.svg"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/apple.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/apple-fill.svg" => {
            Some("/assets/remix-icon/apple.svg")
        }
        "baidu"
        | "compass"
        | "/assets/remix-icon/baidu.svg"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/baidu-color.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/baidu-fill.svg" => {
            Some("/assets/remix-icon/baidu.svg")
        }
        "cloudflare"
        | "cloud"
        | "/assets/remix-icon/cloud.svg"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/cloudflare-color.svg" => {
            Some("/assets/remix-icon/cloud.svg")
        }
        "github"
        | "code"
        | "/assets/remix-icon/github.svg"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/github.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/github-fill.svg" => {
            Some("/assets/remix-icon/github.svg")
        }
        "google"
        | "search"
        | "/assets/remix-icon/google.svg"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/google-color.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/google-fill.svg" => {
            Some("/assets/remix-icon/google.svg")
        }
        "microsoft"
        | "squares"
        | "/assets/remix-icon/microsoft.svg"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/microsoft-color.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/microsoft-fill.svg" => {
            Some("/assets/remix-icon/microsoft.svg")
        }
        "globe"
        | "https://registry.npmmirror.com/bootstrap-icons/1.13.1/files/icons/globe.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Map/globe-fill.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Business/cloud-fill.svg" => {
            Some(FALLBACK_SERVICE_ICON_URL)
        }
        _ => None,
    }
}

fn validate_icon_url(value: &str) -> Result<(), ServiceProbeError> {
    if valid_icon_url(value) {
        return Ok(());
    }
    Err(ServiceProbeError::Invalid("Invalid service icon URL"))
}

fn valid_icon_url(value: &str) -> bool {
    if value.len() > 2_048 {
        return false;
    }
    if BUNDLED_SERVICE_ICON_URLS.contains(&value) {
        return true;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn persist_locked(path: Option<&Path>, state: &ProbeState) -> Result<(), ServiceProbeError> {
    let Some(path) = path else { return Ok(()) };
    let parent = path.parent().ok_or(ServiceProbeError::Io)?;
    fs::create_dir_all(parent).map_err(|_| ServiceProbeError::Io)?;
    let bytes = serde_json::to_vec_pretty(&PersistedState {
        interval_seconds: state.interval_seconds,
        services: state.services.clone(),
        version: 1,
    })
    .map_err(|_| ServiceProbeError::Io)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|_| ServiceProbeError::Io)?;
    fs::rename(temporary, path).map_err(|_| ServiceProbeError::Io)
}

fn pending_results(services: &[ServiceMonitor]) -> Vec<ServiceProbeResult> {
    services.iter().map(pending_result).collect()
}

// Probe observations remain valid when a monitor keeps its stable identity and target URL.
// Labels and icons are presentation metadata, so editing either does not require a re-probe.
fn retained_results(
    previous_services: &[ServiceMonitor],
    previous_results: &[ServiceProbeResult],
    next_services: &[ServiceMonitor],
) -> Vec<ServiceProbeResult> {
    next_services
        .iter()
        .map(|monitor| {
            let unchanged_target = previous_services
                .iter()
                .any(|previous| previous.id == monitor.id && previous.url == monitor.url);
            if unchanged_target {
                previous_results
                    .iter()
                    .find(|result| result.monitor_id == monitor.id)
                    .cloned()
                    .unwrap_or_else(|| pending_result(monitor))
            } else {
                pending_result(monitor)
            }
        })
        .collect()
}

fn pending_result(monitor: &ServiceMonitor) -> ServiceProbeResult {
    ServiceProbeResult {
        failure_stage: None,
        latency_milliseconds: None,
        monitor_id: monitor.id.clone(),
        observed_at: Utc::now().to_rfc3339(),
        route_target: "direct".into(),
        status: ProbeStatus::Pending,
    }
}

async fn probe(
    client: &Client,
    cancel: CancellationToken,
    monitor: ServiceMonitor,
) -> ProbeExecution {
    let started = Instant::now();
    let target = tokio::select! {
        () = cancel.cancelled() => return ProbeExecution::Cancelled,
        target = resolve_probe_target(&monitor.url) => target,
    };
    let url = match target {
        Ok((url, _addresses)) => url,
        Err(error) => {
            return ProbeExecution::Finished(ProbeOutcome {
                failure_stage: Some(error.stage),
                latency_milliseconds: None,
                retry_after: None,
                status: ProbeStatus::Error,
            });
        }
    };
    execute_http_probe(client, cancel, url, started).await
}

async fn execute_http_probe(
    client: &Client,
    cancel: CancellationToken,
    url: Url,
    started: Instant,
) -> ProbeExecution {
    let response = tokio::select! {
        () = cancel.cancelled() => return ProbeExecution::Cancelled,
        response = client.get(url).send() => response,
    };
    match response {
        Ok(response) if response.status().is_success() => {
            let latency_milliseconds =
                u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            drain_small_body(cancel, response);
            ProbeExecution::Finished(ProbeOutcome {
                failure_stage: None,
                latency_milliseconds: Some(latency_milliseconds),
                retry_after: None,
                status: ProbeStatus::Healthy,
            })
        }
        Ok(response) => ProbeExecution::Finished(ProbeOutcome {
            failure_stage: Some(ServiceProbeFailureStage::HttpStatus),
            latency_milliseconds: None,
            retry_after: retry_after(&response),
            status: ProbeStatus::Error,
        }),
        Err(_) => ProbeExecution::Finished(ProbeOutcome {
            failure_stage: Some(ServiceProbeFailureStage::Transport),
            latency_milliseconds: None,
            retry_after: None,
            status: ProbeStatus::Error,
        }),
    }
}

fn result_from_outcome(monitor: &ServiceMonitor, outcome: ProbeOutcome) -> ServiceProbeResult {
    ServiceProbeResult {
        failure_stage: outcome.failure_stage,
        latency_milliseconds: outcome.latency_milliseconds,
        monitor_id: monitor.id.clone(),
        observed_at: Utc::now().to_rfc3339(),
        route_target: "direct".into(),
        status: outcome.status,
    }
}

fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    if !matches!(
        response.status(),
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
    ) {
        return None;
    }
    let value = response.headers().get(RETRY_AFTER)?.to_str().ok()?;
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let deadline = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&Utc);
    deadline.signed_duration_since(Utc::now()).to_std().ok()
}

fn drain_small_body(cancel: CancellationToken, response: reqwest::Response) {
    if response
        .content_length()
        .is_none_or(|length| length > BODY_DRAIN_LIMIT_BYTES as u64)
    {
        return;
    }
    tokio::spawn(async move {
        let mut body = response.bytes_stream();
        let mut drained = 0usize;
        loop {
            let next = tokio::select! {
                () = cancel.cancelled() => return,
                next = body.next() => next,
            };
            let Some(Ok(chunk)) = next else {
                return;
            };
            drained = drained.saturating_add(chunk.len());
            if drained > BODY_DRAIN_LIMIT_BYTES {
                return;
            }
        }
    });
}

async fn validate_probe_url(value: &str) -> Result<(), ServiceProbeError> {
    resolve_public_target(value).await.map(|_| ())
}

async fn resolve_public_target(value: &str) -> Result<(Url, Vec<SocketAddr>), ServiceProbeError> {
    resolve_probe_target(value)
        .await
        .map_err(|error| error.validation)
}

struct ProbeTargetError {
    stage: ServiceProbeFailureStage,
    validation: ServiceProbeError,
}

impl ProbeTargetError {
    const fn new(stage: ServiceProbeFailureStage, message: &'static str) -> Self {
        Self {
            stage,
            validation: ServiceProbeError::Invalid(message),
        }
    }
}

async fn resolve_probe_target(value: &str) -> Result<(Url, Vec<SocketAddr>), ProbeTargetError> {
    let url = Url::parse(value).map_err(|_| {
        ProbeTargetError::new(
            ServiceProbeFailureStage::TargetValidation,
            "Invalid probe URL",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(ProbeTargetError::new(
            ServiceProbeFailureStage::TargetValidation,
            "Invalid probe URL",
        ));
    }
    let host = url.host_str().ok_or_else(|| {
        ProbeTargetError::new(
            ServiceProbeFailureStage::TargetValidation,
            "Probe URL requires a host",
        )
    })?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(ProbeTargetError::new(
            ServiceProbeFailureStage::AddressPolicy,
            "Local probe targets are not allowed",
        ));
    }
    let port = url.port_or_known_default().ok_or_else(|| {
        ProbeTargetError::new(
            ServiceProbeFailureStage::TargetValidation,
            "Probe URL requires a port",
        )
    })?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| {
            ProbeTargetError::new(
                ServiceProbeFailureStage::DnsResolution,
                "Probe host could not be resolved",
            )
        })?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(ProbeTargetError::new(
            ServiceProbeFailureStage::AddressPolicy,
            "Private probe targets are not allowed",
        ));
    }
    Ok((url, addresses))
}

fn syntactically_safe_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_label(label: &str) -> Result<(), ServiceProbeError> {
    if label.trim().is_empty() || label.len() > 120 {
        return Err(ServiceProbeError::Invalid("Invalid service monitor title"));
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(address) = address.to_ipv4_mapped() {
        return is_public_ipv4(address);
    }
    let segments = address.segments();
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || segments[0] & 0xfe00 == 0xfc00
        || segments[0] & 0xffc0 == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    struct HttpFixture {
        address: SocketAddr,
        connections: Arc<AtomicUsize>,
        methods: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    #[derive(Clone)]
    struct ControlledTransport {
        execution: ProbeExecution,
        release: Arc<Notify>,
        started: Arc<AtomicUsize>,
    }

    #[derive(Clone, Default)]
    struct RecordingTransport {
        starts: Arc<Mutex<Vec<(String, tokio::time::Instant)>>>,
    }

    impl ControlledTransport {
        fn healthy() -> Self {
            Self {
                execution: ProbeExecution::Finished(ProbeOutcome {
                    failure_stage: None,
                    latency_milliseconds: Some(12),
                    retry_after: None,
                    status: ProbeStatus::Healthy,
                }),
                release: Arc::new(Notify::new()),
                started: Arc::new(AtomicUsize::new(0)),
            }
        }

        async fn wait_until_started(&self, expected: usize) {
            tokio::time::timeout(Duration::from_secs(1), async {
                while self.started.load(Ordering::SeqCst) < expected {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }

    impl ProbeTransport for ControlledTransport {
        fn execute(
            &self,
            cancel: CancellationToken,
            _monitor: ServiceMonitor,
        ) -> BoxFuture<'static, ProbeExecution> {
            let execution = self.execution.clone();
            let release = self.release.clone();
            let started = self.started.clone();
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                tokio::select! {
                    () = cancel.cancelled() => ProbeExecution::Cancelled,
                    () = release.notified() => execution,
                }
            }
            .boxed()
        }
    }

    impl ProbeTransport for RecordingTransport {
        fn execute(
            &self,
            cancel: CancellationToken,
            monitor: ServiceMonitor,
        ) -> BoxFuture<'static, ProbeExecution> {
            let starts = self.starts.clone();
            async move {
                starts
                    .lock()
                    .unwrap()
                    .push((monitor.id, tokio::time::Instant::now()));
                tokio::select! {
                    () = cancel.cancelled() => ProbeExecution::Cancelled,
                    () = std::future::ready(()) => ProbeExecution::Finished(ProbeOutcome {
                        failure_stage: None,
                        latency_milliseconds: Some(12),
                        retry_after: None,
                        status: ProbeStatus::Healthy,
                    }),
                }
            }
            .boxed()
        }
    }

    fn test_monitor(id: &str, url: &str) -> ServiceMonitor {
        ServiceMonitor {
            icon: FALLBACK_SERVICE_ICON_URL.into(),
            id: id.into(),
            label: id.into(),
            url: url.into(),
        }
    }

    fn service_with_transport(
        services: Vec<ServiceMonitor>,
        transport: ControlledTransport,
    ) -> ServiceProbeService {
        ServiceProbeService::from_parts(
            ServiceProbeConfig { state_path: None },
            DEFAULT_INTERVAL_SECONDS,
            services,
            Arc::new(transport),
        )
    }

    impl Drop for HttpFixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl HttpFixture {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let connections = Arc::new(AtomicUsize::new(0));
            let methods = Arc::new(Mutex::new(Vec::new()));
            let task_connections = connections.clone();
            let task_methods = methods.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        return;
                    };
                    task_connections.fetch_add(1, Ordering::SeqCst);
                    let methods = task_methods.clone();
                    tokio::spawn(async move {
                        loop {
                            let mut request = Vec::new();
                            let mut byte = [0_u8; 1];
                            while !request.ends_with(b"\r\n\r\n") {
                                let Ok(read) = stream.read(&mut byte).await else {
                                    return;
                                };
                                if read == 0 {
                                    return;
                                }
                                request.push(byte[0]);
                                if request.len() > 8_192 {
                                    return;
                                }
                            }
                            let request = String::from_utf8_lossy(&request);
                            let mut parts = request
                                .lines()
                                .next()
                                .unwrap_or_default()
                                .split_ascii_whitespace();
                            let method = parts.next().unwrap_or_default().to_owned();
                            let path = parts.next().unwrap_or_default();
                            methods.lock().unwrap().push(method);
                            match path {
                                "/ok" => {
                                    if stream
                                        .write_all(
                                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
                                        )
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                }
                                "/redirect" => {
                                    let _ = stream
                                        .write_all(
                                            b"HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 0\r\n\r\n",
                                        )
                                        .await;
                                }
                                "/status" => {
                                    let _ = stream
                                        .write_all(
                                            b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 120\r\nContent-Length: 0\r\n\r\n",
                                        )
                                        .await;
                                }
                                "/slow-body" => {
                                    if stream
                                        .write_all(
                                            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\n",
                                        )
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                    tokio::time::sleep(Duration::from_millis(250)).await;
                                    let _ = stream.write_all(b"slow").await;
                                }
                                "/oversized" => {
                                    let _ = stream
                                        .write_all(
                                            b"HTTP/1.1 200 OK\r\nContent-Length: 131072\r\nConnection: keep-alive\r\n\r\npartial",
                                        )
                                        .await;
                                    return;
                                }
                                "/unknown" => {
                                    let _ = stream
                                        .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npartial")
                                        .await;
                                    return;
                                }
                                "/timeout" | "/cancel" => {
                                    tokio::time::sleep(Duration::from_secs(30)).await;
                                    return;
                                }
                                _ => return,
                            }
                        }
                    });
                }
            });
            Self {
                address,
                connections,
                methods,
                task,
            }
        }

        fn client(&self, timeout: Duration) -> Client {
            Client::builder()
                .timeout(timeout)
                .redirect(reqwest::redirect::Policy::none())
                .resolve("fixture.test", self.address)
                .build()
                .unwrap()
        }

        fn url(&self, path: &str) -> Url {
            Url::parse(&format!("http://fixture.test{path}")).unwrap()
        }

        async fn execute(&self, client: &Client, path: &str) -> ProbeExecution {
            execute_http_probe(
                client,
                CancellationToken::new(),
                self.url(path),
                Instant::now(),
            )
            .await
        }
    }

    #[test]
    fn rejects_non_public_targets() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn persisted_state_requires_safe_fixed_policy() {
        let state = PersistedState {
            interval_seconds: 60,
            services: default_service_monitors(),
            version: 1,
        };
        assert!(valid_persisted_state(&state));
    }

    #[test]
    fn service_probes_default_to_five_seconds() {
        let service = ServiceProbeService::new(ServiceProbeConfig { state_path: None });

        assert_eq!(service.interval_seconds(), 5);
    }

    #[test]
    fn initialized_probe_order_is_a_deterministic_permutation_for_fixed_samples() {
        let order = probe_order_from_samples(6, &[0, 1, 2, 3, 4]);
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(order, probe_order_from_samples(6, &[0, 1, 2, 3, 4]));
        assert_ne!(order, probe_order_from_samples(6, &[4, 3, 2, 1, 0]));
    }

    #[test]
    fn probe_offsets_evenly_partition_the_selected_interval() {
        assert_eq!(
            (0..6)
                .map(|index| evenly_spaced_offset(Duration::from_secs(5), index, 6))
                .collect::<Vec<_>>(),
            vec![
                Duration::ZERO,
                Duration::from_nanos(833_333_333),
                Duration::from_nanos(1_666_666_666),
                Duration::from_millis(2_500),
                Duration::from_nanos(3_333_333_333),
                Duration::from_nanos(4_166_666_666),
            ]
        );
    }

    #[test]
    fn host_failure_delay_steps_and_caps_at_six_hours() {
        let expected = [5, 15, 30, 60, 120, 240, 360, 360];
        for (failure_count, minutes) in (1..).zip(expected) {
            assert_eq!(
                failure_delay(failure_count),
                Duration::from_secs(minutes * 60)
            );
        }
    }

    #[tokio::test]
    async fn local_http_fixture_covers_get_redirect_status_and_retry_after() {
        let fixture = HttpFixture::start().await;
        let client = fixture.client(Duration::from_secs(1));

        let ProbeExecution::Finished(ok) = fixture.execute(&client, "/ok").await else {
            panic!("request should complete");
        };
        assert_eq!(ok.status, ProbeStatus::Healthy);

        let ProbeExecution::Finished(redirect) = fixture.execute(&client, "/redirect").await else {
            panic!("redirect should be classified");
        };
        assert_eq!(
            redirect.failure_stage,
            Some(ServiceProbeFailureStage::HttpStatus)
        );

        let ProbeExecution::Finished(status) = fixture.execute(&client, "/status").await else {
            panic!("status should be classified");
        };
        assert_eq!(
            status.failure_stage,
            Some(ServiceProbeFailureStage::HttpStatus)
        );
        assert_eq!(status.retry_after, Some(Duration::from_secs(120)));
        assert!(
            fixture
                .methods
                .lock()
                .unwrap()
                .iter()
                .all(|method| method == "GET")
        );
    }

    #[tokio::test]
    async fn header_latency_does_not_wait_for_slow_or_unbounded_bodies() {
        let fixture = HttpFixture::start().await;
        let client = fixture.client(Duration::from_secs(1));
        for path in ["/slow-body", "/oversized", "/unknown"] {
            let started = Instant::now();
            let ProbeExecution::Finished(outcome) = fixture.execute(&client, path).await else {
                panic!("headers should complete for {path}");
            };
            assert_eq!(outcome.status, ProbeStatus::Healthy);
            assert!(
                started.elapsed() < Duration::from_millis(150),
                "{path} waited for response body"
            );
        }
    }

    #[tokio::test]
    async fn timeout_and_cancellation_are_distinct_transport_outcomes() {
        let fixture = HttpFixture::start().await;
        let client = fixture.client(Duration::from_millis(50));
        let ProbeExecution::Finished(timeout) = fixture.execute(&client, "/timeout").await else {
            panic!("timeout should be classified");
        };
        assert_eq!(
            timeout.failure_stage,
            Some(ServiceProbeFailureStage::Transport)
        );

        let cancel = CancellationToken::new();
        let child = cancel.clone();
        let client = fixture.client(Duration::from_secs(1));
        let url = fixture.url("/cancel");
        let request =
            tokio::spawn(
                async move { execute_http_probe(&client, child, url, Instant::now()).await },
            );
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(matches!(request.await.unwrap(), ProbeExecution::Cancelled));
    }

    #[tokio::test]
    async fn eligible_small_bodies_allow_connection_reuse() {
        let fixture = HttpFixture::start().await;
        let client = fixture.client(Duration::from_secs(1));
        assert!(matches!(
            fixture.execute(&client, "/ok").await,
            ProbeExecution::Finished(ProbeOutcome {
                status: ProbeStatus::Healthy,
                ..
            })
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(matches!(
            fixture.execute(&client, "/ok").await,
            ProbeExecution::Finished(ProbeOutcome {
                status: ProbeStatus::Healthy,
                ..
            })
        ));
        assert_eq!(fixture.connections.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn normalized_host_coalesces_manual_and_automatic_requests() {
        let transport = ControlledTransport::healthy();
        let services = vec![
            test_monitor("automatic", "https://EXAMPLE.com/automatic"),
            test_monitor("manual", "https://example.com:443/manual"),
        ];
        let service = service_with_transport(services.clone(), transport.clone());
        let automatic = {
            let service = service.clone();
            let monitor = services[0].clone();
            tokio::spawn(async move {
                service
                    .probe_monitor(service.revision_cancel_token(), monitor)
                    .await
            })
        };
        transport.wait_until_started(1).await;
        let manual = {
            let service = service.clone();
            let monitor = services[1].clone();
            tokio::spawn(async move {
                service
                    .probe_monitor(service.revision_cancel_token(), monitor)
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert_eq!(transport.started.load(Ordering::SeqCst), 1);
        transport.release.notify_waiters();
        assert_eq!(
            automatic.await.unwrap().unwrap().status,
            ProbeStatus::Healthy
        );
        assert_eq!(manual.await.unwrap().unwrap().status, ProbeStatus::Healthy);
        assert_eq!(transport.started.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn coalesced_cycle_maps_one_host_outcome_to_each_monitor() {
        let transport = ControlledTransport::healthy();
        let services = vec![
            test_monitor("one", "https://example.com/one"),
            test_monitor("two", "https://example.com/two"),
        ];
        let service = service_with_transport(services, transport.clone());
        let cycle = {
            let service = service.clone();
            tokio::spawn(async move { service.run_cycle(0).await })
        };
        transport.wait_until_started(1).await;
        transport.release.notify_waiters();
        cycle.await.unwrap();

        let state = service.inner.state.lock().unwrap();
        assert_eq!(transport.started.load(Ordering::SeqCst), 1);
        assert!(
            state
                .results
                .iter()
                .all(|result| result.status == ProbeStatus::Healthy)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn automatic_cycle_uses_initialized_order_and_even_start_offsets() {
        let transport = RecordingTransport::default();
        let services = vec![
            test_monitor("one", "https://one.example/probe"),
            test_monitor("two", "https://two.example/probe"),
            test_monitor("three", "https://three.example/probe"),
        ];
        let service = ServiceProbeService::from_parts(
            ServiceProbeConfig { state_path: None },
            6,
            services,
            Arc::new(transport.clone()),
        );
        service.inner.state.lock().unwrap().probe_order = vec![2, 0, 1];

        let cycle = {
            let service = service.clone();
            tokio::spawn(async move { service.run_cycle(6).await })
        };
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(2)).await;
        cycle.await.unwrap();

        let starts = transport.starts.lock().unwrap();
        assert_eq!(
            starts
                .iter()
                .map(|(monitor_id, _)| monitor_id.as_str())
                .collect::<Vec<_>>(),
            vec!["three", "one", "two"]
        );
        assert_eq!(starts[1].1 - starts[0].1, Duration::from_secs(2));
        assert_eq!(starts[2].1 - starts[1].1, Duration::from_secs(2));
    }

    #[tokio::test(start_paused = true)]
    async fn host_backoff_suppresses_requests_until_fake_clock_deadline() {
        let transport = ControlledTransport {
            execution: ProbeExecution::Finished(ProbeOutcome {
                failure_stage: Some(ServiceProbeFailureStage::Transport),
                latency_milliseconds: None,
                retry_after: None,
                status: ProbeStatus::Error,
            }),
            ..ControlledTransport::healthy()
        };
        let monitor = test_monitor("probe", "https://example.com/probe");
        let service = service_with_transport(vec![monitor.clone()], transport.clone());

        let first = {
            let service = service.clone();
            let monitor = monitor.clone();
            tokio::spawn(async move {
                service
                    .probe_monitor(service.revision_cancel_token(), monitor)
                    .await
            })
        };
        transport.wait_until_started(1).await;
        transport.release.notify_waiters();
        assert_eq!(first.await.unwrap().unwrap().status, ProbeStatus::Error);

        assert!(
            service
                .probe_monitor(service.revision_cancel_token(), monitor.clone())
                .await
                .is_none()
        );
        assert_eq!(transport.started.load(Ordering::SeqCst), 1);

        tokio::time::advance(Duration::from_secs(5 * 60)).await;
        let third = {
            let service = service.clone();
            tokio::spawn(async move {
                service
                    .probe_monitor(service.revision_cancel_token(), monitor)
                    .await
            })
        };
        transport.wait_until_started(2).await;
        transport.release.notify_waiters();
        assert_eq!(third.await.unwrap().unwrap().status, ProbeStatus::Error);
        assert_eq!(transport.started.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn automatic_cycles_do_not_overlap_while_a_probe_is_in_flight() {
        let transport = ControlledTransport::healthy();
        let monitor = test_monitor("probe", "https://example.com/probe");
        let service = ServiceProbeService::from_parts(
            ServiceProbeConfig { state_path: None },
            5,
            vec![monitor],
            Arc::new(transport.clone()),
        );
        service.start();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(60)).await;
        transport.wait_until_started(1).await;
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(transport.started.load(Ordering::SeqCst), 1);
        service.shutdown();
    }

    #[tokio::test]
    async fn revision_change_and_shutdown_cancel_obsolete_transport() {
        let monitor = test_monitor("probe", "https://example.com/probe");
        for shutdown in [false, true] {
            let transport = ControlledTransport::healthy();
            let service = service_with_transport(vec![monitor.clone()], transport.clone());
            let request = {
                let service = service.clone();
                let monitor = monitor.clone();
                tokio::spawn(async move {
                    service
                        .probe_monitor(service.revision_cancel_token(), monitor)
                        .await
                })
            };
            transport.wait_until_started(1).await;
            if shutdown {
                service.shutdown();
            } else {
                service.set_interval(60).unwrap();
            }
            assert!(request.await.unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn obsolete_revision_never_publishes_a_stale_result() {
        let transport = ControlledTransport::healthy();
        let monitor = test_monitor("probe", "https://example.com/probe");
        let service = service_with_transport(vec![monitor], transport.clone());
        let request = {
            let service = service.clone();
            tokio::spawn(async move { service.test("probe").await })
        };
        transport.wait_until_started(1).await;
        service.set_interval(60).unwrap();
        request.await.unwrap().unwrap();

        let state = service.inner.state.lock().unwrap();
        assert_eq!(state.results[0].status, ProbeStatus::Pending);
        assert_eq!(state.results[0].latency_milliseconds, None);
    }

    #[test]
    fn success_resets_host_failure_state_and_retry_after_wins() {
        let mut host = HostState::default();
        update_host_backoff(
            &mut host,
            &ProbeOutcome {
                failure_stage: Some(ServiceProbeFailureStage::Transport),
                latency_milliseconds: None,
                retry_after: Some(Duration::from_secs(42)),
                status: ProbeStatus::Error,
            },
        );
        assert_eq!(host.consecutive_failures, 1);
        let remaining = host.next_allowed_at.unwrap() - tokio::time::Instant::now();
        assert!(remaining <= Duration::from_secs(42));
        assert!(remaining > Duration::from_secs(40));

        update_host_backoff(
            &mut host,
            &ProbeOutcome {
                failure_stage: None,
                latency_milliseconds: Some(10),
                retry_after: None,
                status: ProbeStatus::Healthy,
            },
        );
        assert_eq!(host.consecutive_failures, 0);
        assert!(host.next_allowed_at.is_none());
    }

    #[tokio::test]
    async fn direct_probe_failures_identify_target_validation_and_address_policy_stages() {
        let invalid = probe(
            &Client::new(),
            CancellationToken::new(),
            ServiceMonitor {
                icon: FALLBACK_SERVICE_ICON_URL.into(),
                id: "invalid".into(),
                label: "Invalid".into(),
                url: "not a URL".into(),
            },
        )
        .await;
        let ProbeExecution::Finished(invalid) = invalid else {
            panic!("invalid target must produce a classified result");
        };
        assert_eq!(invalid.status, ProbeStatus::Error);
        assert_eq!(
            invalid.failure_stage,
            Some(ServiceProbeFailureStage::TargetValidation)
        );

        let local = probe(
            &Client::new(),
            CancellationToken::new(),
            ServiceMonitor {
                icon: FALLBACK_SERVICE_ICON_URL.into(),
                id: "local".into(),
                label: "Local".into(),
                url: "http://localhost/".into(),
            },
        )
        .await;
        let ProbeExecution::Finished(local) = local else {
            panic!("local target must produce a classified result");
        };
        assert_eq!(local.status, ProbeStatus::Error);
        assert_eq!(
            local.failure_stage,
            Some(ServiceProbeFailureStage::AddressPolicy)
        );
    }

    fn confirmed_result(monitor: &ServiceMonitor) -> ServiceProbeResult {
        ServiceProbeResult {
            failure_stage: None,
            latency_milliseconds: Some(42),
            monitor_id: monitor.id.clone(),
            observed_at: "2026-07-21T12:00:00Z".into(),
            route_target: "test".into(),
            status: ProbeStatus::Healthy,
        }
    }

    #[test]
    fn disabled_mutations_retain_only_results_with_unchanged_probe_targets() {
        let services = default_service_monitors();
        let results: Vec<_> = services.iter().map(confirmed_result).collect();
        let mut edited_services = services.clone();
        edited_services[0].icon = "https://example.com/icon.svg".into();
        edited_services[0].label = "Renamed Google".into();
        edited_services[1].url = "https://example.com/changed-target".into();
        edited_services.push(ServiceMonitor {
            icon: "https://example.com/new-icon.svg".into(),
            id: "new-monitor".into(),
            label: "New monitor".into(),
            url: "https://example.com/new-target".into(),
        });

        let next_results = retained_results(&services, &results, &edited_services);

        assert_eq!(DISABLED_INTERVAL_SECONDS, 0);
        assert_eq!(
            next_results[0], results[0],
            "icon and label edits keep the result"
        );
        assert_eq!(
            next_results[1].status,
            ProbeStatus::Pending,
            "URL changes invalidate only that result"
        );
        assert_eq!(
            next_results.last().unwrap().status,
            ProbeStatus::Pending,
            "new monitors start pending"
        );
        assert_eq!(
            next_results[2], results[2],
            "unrelated results remain confirmed"
        );
    }

    #[test]
    fn removal_and_default_restore_preserve_only_still_safe_results() {
        let services = default_service_monitors();
        let results: Vec<_> = services.iter().map(confirmed_result).collect();
        let retained_after_removal = retained_results(&services, &results, &services[1..]);
        assert_eq!(retained_after_removal.len(), services.len() - 1);
        assert!(
            retained_after_removal
                .iter()
                .all(|result| result.status == ProbeStatus::Healthy)
        );
        assert!(
            retained_after_removal
                .iter()
                .all(|result| result.monitor_id != services[0].id)
        );

        let mut customized_services = services.clone();
        customized_services[0].url = "https://example.com/changed-target".into();
        let restored_results = retained_results(&customized_services, &results, &services);
        assert_eq!(restored_results[0].status, ProbeStatus::Pending);
        assert!(
            restored_results[1..]
                .iter()
                .all(|result| result.status == ProbeStatus::Healthy)
        );
    }

    #[test]
    fn restore_defaults_restores_targets_and_internal_cadence() {
        let service = ServiceProbeService::new(ServiceProbeConfig { state_path: None });
        service.set_interval(5).unwrap();
        service.restore_defaults().unwrap();

        let state = service.inner.state.lock().unwrap();
        assert_eq!(state.interval_seconds, DEFAULT_INTERVAL_SECONDS);
        assert_eq!(state.services, default_service_monitors());
    }

    #[test]
    fn selected_interval_is_restored_from_disk() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("service-monitors.json");
        let service = ServiceProbeService::new(ServiceProbeConfig {
            state_path: Some(state_path.clone()),
        });
        service.set_interval(10).unwrap();

        let restored = ServiceProbeService::new(ServiceProbeConfig {
            state_path: Some(state_path),
        });
        assert_eq!(
            restored
                .inner
                .state
                .lock()
                .expect("service probe state poisoned")
                .interval_seconds,
            10
        );
    }

    #[test]
    fn legacy_five_minute_default_migrates_to_five_seconds() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("service-monitors.json");
        let state = PersistedState {
            interval_seconds: 300,
            services: default_service_monitors(),
            version: 1,
        };
        fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();

        let restored = ServiceProbeService::new(ServiceProbeConfig {
            state_path: Some(state_path),
        });
        assert_eq!(restored.interval_seconds(), 5);
        assert!(restored.set_interval(300).is_err());
        assert!(restored.set_interval(900).is_err());
    }

    #[test]
    fn legacy_monitor_lists_are_truncated_to_the_new_twelve_service_limit() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("service-monitors.json");
        let services = (0..LEGACY_MAX_MONITORS)
            .map(|index| {
                test_monitor(
                    &format!("service-{index}"),
                    &format!("https://service-{index}.example/probe"),
                )
            })
            .collect();
        let state = PersistedState {
            interval_seconds: 60,
            services,
            version: 1,
        };
        fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();

        let restored = ServiceProbeService::new(ServiceProbeConfig {
            state_path: Some(state_path),
        });
        let state = restored.inner.state.lock().unwrap();
        assert_eq!(state.services.len(), MAX_MONITORS);
        assert_eq!(state.services[0].id, "service-0");
        assert_eq!(state.services[11].id, "service-11");
    }

    #[tokio::test]
    async fn core_start_only_requests_a_probe_when_periodic_testing_is_disabled() {
        let service = ServiceProbeService::new(ServiceProbeConfig { state_path: None });
        service.test_after_core_start();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                service.inner.core_started.notified()
            )
            .await
            .is_err()
        );

        service.set_interval(DISABLED_INTERVAL_SECONDS).unwrap();
        service.test_after_core_start();
        tokio::time::timeout(
            Duration::from_millis(10),
            service.inner.core_started.notified(),
        )
        .await
        .expect("disabled interval should retain the core-start probe request");
    }

    #[test]
    fn persisted_icons_migrate_defaults_preserve_https_and_fallback_unsafe_values() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("service-monitors.json");
        let state = PersistedState {
            interval_seconds: 60,
            services: vec![
                ServiceMonitor {
                    icon: "google".into(),
                    id: "google".into(),
                    label: "Google".into(),
                    url: "https://www.google.com/generate_204".into(),
                },
                ServiceMonitor {
                    icon: "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/cloudflare-color.svg".into(),
                    id: "cloudflare".into(),
                    label: "Cloudflare".into(),
                    url: "https://cp.cloudflare.com/generate_204".into(),
                },
                ServiceMonitor {
                    icon: "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/google-fill.svg".into(),
                    id: "custom-legacy-url".into(),
                    label: "Custom legacy URL".into(),
                    url: "https://example.com/generate_204".into(),
                },
                ServiceMonitor {
                    icon: "https://example.com/custom.svg".into(),
                    id: "custom-https".into(),
                    label: "Custom HTTPS".into(),
                    url: "https://example.com/generate_204".into(),
                },
                ServiceMonitor {
                    icon: "javascript:alert(1)".into(),
                    id: "unsafe-scheme".into(),
                    label: "Unsafe scheme".into(),
                    url: "https://example.com/generate_204".into(),
                },
                ServiceMonitor {
                    icon: "not a URL".into(),
                    id: "malformed".into(),
                    label: "Malformed".into(),
                    url: "https://example.com/generate_204".into(),
                },
            ],
            version: 1,
        };
        fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();

        let restored = ServiceProbeService::new(ServiceProbeConfig {
            state_path: Some(state_path),
        });
        let restored_icons: Vec<String> = restored
            .inner
            .state
            .lock()
            .expect("service probe state poisoned")
            .services
            .iter()
            .map(|service| service.icon.clone())
            .collect();

        assert_eq!(
            &restored_icons[..6],
            [
                "/assets/remix-icon/google.svg",
                "/assets/remix-icon/cloud.svg",
                "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/google-fill.svg",
                "https://example.com/custom.svg",
                "/assets/remix-icon/cloud.svg",
                "/assets/remix-icon/cloud.svg",
            ]
        );
        assert_eq!(restored_icons.len(), 6);
    }

    #[test]
    fn exact_legacy_defaults_migrate_without_rewriting_custom_monitors() {
        let mut legacy = vec![
            ServiceMonitor {
                id: "github".into(),
                label: "GitHub".into(),
                icon: "/assets/remix-icon/github.svg".into(),
                url: "https://github.com".into(),
            },
            ServiceMonitor {
                id: "apple".into(),
                label: "Apple".into(),
                icon: "/assets/remix-icon/apple.svg".into(),
                url: "https://www.apple.com/library/test/success.html".into(),
            },
            ServiceMonitor {
                id: "github".into(),
                label: "Work GitHub".into(),
                icon: "/assets/remix-icon/github.svg".into(),
                url: "https://github.com".into(),
            },
            ServiceMonitor {
                id: "apple".into(),
                label: "Work Apple".into(),
                icon: "/assets/remix-icon/apple.svg".into(),
                url: "https://example.com/custom-apple".into(),
            },
        ];
        legacy =
            migrate_legacy_defaults(legacy.into_iter().map(normalize_persisted_icon).collect());
        assert!(
            legacy.iter().any(|monitor| monitor.id == "apple"
                && monitor.url == "https://example.com/custom-apple")
        );
        assert!(
            legacy
                .iter()
                .any(|monitor| monitor.id == "github" && monitor.url.ends_with("/favicon.ico"))
        );
        assert!(
            legacy.iter().any(
                |monitor| monitor.label == "Work GitHub" && monitor.url == "https://github.com"
            )
        );
        assert!(legacy.iter().any(|monitor| monitor.id == "weixin"));
        assert!(legacy.iter().any(|monitor| monitor.id == "aws-us-east-1"));
    }

    #[test]
    fn service_icon_values_accept_bundled_paths_or_credential_free_https() {
        assert!(valid_icon_url("/assets/remix-icon/google.svg"));
        assert!(valid_icon_url("https://example.com/custom.svg"));
        assert!(!valid_icon_url("/assets/remix-icon/unrecorded.svg"));
        assert!(!valid_icon_url("http://example.com/icon.svg"));
        assert!(!valid_icon_url("https://user:secret@example.com/icon.svg"));
        assert!(!valid_icon_url("javascript:alert(1)"));
        assert!(!valid_icon_url("file:///tmp/icon.svg"));
    }

    #[test]
    fn persistence_failure_does_not_publish_uncommitted_state() {
        let directory = tempfile::tempdir().unwrap();
        let blocked_parent = directory.path().join("not-a-directory");
        fs::write(&blocked_parent, b"blocked").unwrap();
        let service = ServiceProbeService::new(ServiceProbeConfig {
            state_path: Some(blocked_parent.join("service-monitors.json")),
        });

        assert!(matches!(
            service.set_interval(10),
            Err(ServiceProbeError::Io)
        ));
        assert_eq!(
            service
                .inner
                .state
                .lock()
                .expect("service probe state poisoned")
                .interval_seconds,
            DEFAULT_INTERVAL_SECONDS
        );
    }
}
