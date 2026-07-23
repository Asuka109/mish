use std::{
    fs, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::Utc;
use futures_util::{StreamExt, stream::FuturesUnordered};
use mish_runtime::{
    ProbeStatus, ServiceMonitor, ServiceProbePolicy, ServiceProbeResult, StatusSnapshot,
    default_service_monitors,
};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, Semaphore, broadcast};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DEFAULT_INTERVAL_SECONDS: u16 = 5;
const DISABLED_INTERVAL_SECONDS: u16 = 0;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_MONITORS: usize = 24;
const ALLOWED_INTERVALS: [u16; 5] = [0, 5, 10, 30, 60];
const LEGACY_MICROSOFT_CONNECTIVITY_TEST_URL: &str =
    "https://www.msftconnecttest.com/connecttest.txt";
const MICROSOFT_CONNECTIVITY_TEST_URL: &str = "http://www.msftconnecttest.com/connecttest.txt";
const FALLBACK_ICON_ID: &str = "globe";
const SERVICE_ICON_IDS: [&str; 7] = [
    "cloud", "code", "compass", "device", "globe", "search", "squares",
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
    revision: u64,
    results: Vec<ServiceProbeResult>,
    services: Vec<ServiceMonitor>,
}

struct Inner {
    cancel: CancellationToken,
    core_started: Notify,
    state: Mutex<ProbeState>,
    state_path: Option<PathBuf>,
    updates: broadcast::Sender<()>,
    wake: Notify,
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
        let services: Vec<ServiceMonitor> = persisted
            .map(|state| state.services)
            .unwrap_or_else(default_service_monitors)
            .into_iter()
            .map(upgrade_icon_id)
            .map(upgrade_legacy_default_microsoft_url)
            .collect();
        let (updates, _) = broadcast::channel(32);
        Self {
            inner: Arc::new(Inner {
                cancel: CancellationToken::new(),
                core_started: Notify::new(),
                state: Mutex::new(ProbeState {
                    interval_seconds,
                    revision: 0,
                    results: pending_results(&services),
                    services,
                }),
                state_path: config.state_path,
                updates,
                wake: Notify::new(),
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
        validate_icon_id(&draft.icon)?;
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
        next.revision = next.revision.wrapping_add(1);
        persist_locked(self.inner.state_path.as_deref(), &next)?;
        *state = next;
        drop(state);
        self.changed();
        Ok(())
    }

    pub async fn test(&self, monitor_id: &str) -> Result<(), ServiceProbeError> {
        let (revision, monitor) = {
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
            (state.revision, monitor)
        };

        let result = probe(monitor).await;
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
        let _ = self.inner.updates.send(());
        self.inner.wake.notify_one();
    }

    async fn run(&self) {
        loop {
            let interval_seconds = self.interval_seconds();
            if interval_seconds == DISABLED_INTERVAL_SECONDS {
                tokio::select! {
                    () = self.inner.cancel.cancelled() => break,
                    () = self.inner.wake.notified() => {},
                    () = self.inner.core_started.notified() => self.run_cycle().await,
                }
                continue;
            }

            tokio::select! {
                () = self.inner.cancel.cancelled() => break,
                () = self.run_cycle() => {},
            }
            let interval_seconds = self.interval_seconds();
            if interval_seconds == DISABLED_INTERVAL_SECONDS {
                continue;
            }
            let interval = Duration::from_secs(u64::from(interval_seconds));
            tokio::select! {
                () = self.inner.cancel.cancelled() => break,
                () = self.inner.wake.notified() => {},
                () = tokio::time::sleep(interval) => {},
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

    async fn run_cycle(&self) {
        let (revision, services) = {
            let state = self
                .inner
                .state
                .lock()
                .expect("service probe state poisoned");
            let services = state.services.clone();
            (state.revision, services)
        };
        let semaphore = Arc::new(Semaphore::new(4));
        let mut probes: FuturesUnordered<_> = services
            .into_iter()
            .map(|monitor| {
                let semaphore = semaphore.clone();
                async move {
                    let _permit = semaphore.acquire_owned().await.ok();
                    probe(monitor).await
                }
            })
            .collect();
        while let Some(result) = probes.next().await {
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
    }
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
        && state.services.len() <= MAX_MONITORS
        && state.services.iter().all(|monitor| {
            valid_identifier(&monitor.id)
                && monitor.icon.len() <= 2_048
                && validate_label(&monitor.label).is_ok()
                && syntactically_safe_url(&monitor.url)
        })
}

fn valid_persisted_interval(interval_seconds: u16) -> bool {
    ALLOWED_INTERVALS.contains(&interval_seconds) || matches!(interval_seconds, 300 | 900)
}

fn normalize_persisted_interval(interval_seconds: u16) -> u16 {
    match interval_seconds {
        300 | 900 => DEFAULT_INTERVAL_SECONDS,
        interval_seconds => interval_seconds,
    }
}

fn upgrade_icon_id(mut monitor: ServiceMonitor) -> ServiceMonitor {
    monitor.icon = legacy_icon_id(&monitor.icon)
        .unwrap_or(FALLBACK_ICON_ID)
        .into();
    monitor
}

fn upgrade_legacy_default_microsoft_url(mut monitor: ServiceMonitor) -> ServiceMonitor {
    if monitor.id == "microsoft"
        && monitor.label == "Microsoft"
        && monitor.icon == "squares"
        && monitor.url == LEGACY_MICROSOFT_CONNECTIVITY_TEST_URL
    {
        monitor.url = MICROSOFT_CONNECTIVITY_TEST_URL.into();
    }
    monitor
}

fn legacy_icon_id(value: &str) -> Option<&'static str> {
    match value {
        "search"
        | "google"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/google-color.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/google-fill.svg" => {
            Some("search")
        }
        "code"
        | "github"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/github.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/github-fill.svg" => {
            Some("code")
        }
        "cloud"
        | "cloudflare"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/cloudflare-color.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Business/cloud-fill.svg" => {
            Some("cloud")
        }
        "compass"
        | "baidu"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/baidu-color.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/baidu-fill.svg" => {
            Some("compass")
        }
        "apple"
        | "device"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/apple.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/apple-fill.svg" => {
            Some("device")
        }
        "globe" | "https://registry.npmmirror.com/bootstrap-icons/1.13.1/files/icons/globe.svg" => {
            Some("globe")
        }
        "microsoft"
        | "squares"
        | "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/microsoft-color.svg"
        | "https://registry.npmmirror.com/remixicon/4.9.1/files/icons/Logos/microsoft-fill.svg" => {
            Some("squares")
        }
        _ => None,
    }
}

fn validate_icon_id(value: &str) -> Result<(), ServiceProbeError> {
    if SERVICE_ICON_IDS.contains(&value) {
        return Ok(());
    }
    Err(ServiceProbeError::Invalid("Unsupported service icon"))
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
        latency_milliseconds: None,
        monitor_id: monitor.id.clone(),
        observed_at: Utc::now().to_rfc3339(),
        route_target: "direct".into(),
        status: ProbeStatus::Pending,
    }
}

async fn probe(monitor: ServiceMonitor) -> ServiceProbeResult {
    let started = Instant::now();
    let healthy = match resolve_public_target(&monitor.url).await {
        Ok((url, addresses)) => match Client::builder()
            .connect_timeout(PROBE_TIMEOUT)
            .timeout(PROBE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(url.host_str().expect("validated URL host"), &addresses)
            .build()
        {
            Ok(client) => client
                .get(url)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success()),
            Err(_) => false,
        },
        Err(_) => false,
    };
    ServiceProbeResult {
        latency_milliseconds: healthy
            .then(|| u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
        monitor_id: monitor.id,
        observed_at: Utc::now().to_rfc3339(),
        route_target: "direct".into(),
        status: if healthy {
            ProbeStatus::Healthy
        } else {
            ProbeStatus::Error
        },
    }
}

async fn validate_probe_url(value: &str) -> Result<(), ServiceProbeError> {
    resolve_public_target(value).await.map(|_| ())
}

async fn resolve_public_target(value: &str) -> Result<(Url, Vec<SocketAddr>), ServiceProbeError> {
    let url = Url::parse(value).map_err(|_| ServiceProbeError::Invalid("Invalid probe URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(ServiceProbeError::Invalid("Invalid probe URL"));
    }
    let host = url
        .host_str()
        .ok_or(ServiceProbeError::Invalid("Probe URL requires a host"))?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(ServiceProbeError::Invalid(
            "Local probe targets are not allowed",
        ));
    }
    let port = url
        .port_or_known_default()
        .ok_or(ServiceProbeError::Invalid("Probe URL requires a port"))?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| ServiceProbeError::Invalid("Probe host could not be resolved"))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(ServiceProbeError::Invalid(
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

    fn confirmed_result(monitor: &ServiceMonitor) -> ServiceProbeResult {
        ServiceProbeResult {
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
    fn removed_long_intervals_are_migrated_to_one_minute() {
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
        assert_eq!(restored.interval_seconds(), DEFAULT_INTERVAL_SECONDS);
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
    fn legacy_and_untrusted_icon_values_are_normalized_without_urls() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("service-monitors.json");
        let state = PersistedState {
            interval_seconds: 60,
            services: vec![
                ServiceMonitor {
                    icon: "google".into(),
                    id: "legacy-google".into(),
                    label: "Legacy Google".into(),
                    url: "https://www.google.com/generate_204".into(),
                },
                ServiceMonitor {
                    icon: "https://registry.npmmirror.com/@lobehub/icons-static-svg/1.93.0/files/icons/cloudflare-color.svg".into(),
                    id: "legacy-cloudflare".into(),
                    label: "Legacy Cloudflare".into(),
                    url: "https://cp.cloudflare.com/generate_204".into(),
                },
                ServiceMonitor {
                    icon: "https://attacker.invalid/icon.svg".into(),
                    id: "legacy-untrusted".into(),
                    label: "Legacy untrusted".into(),
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

        assert_eq!(restored_icons, vec!["search", "cloud", "globe",]);
    }

    #[test]
    fn exact_legacy_default_microsoft_monitor_is_upgraded_to_http() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("service-monitors.json");
        let mut services = default_service_monitors();
        let microsoft = services
            .iter_mut()
            .find(|monitor| monitor.id == "microsoft")
            .expect("Microsoft default monitor");
        microsoft.url = LEGACY_MICROSOFT_CONNECTIVITY_TEST_URL.into();
        let state = PersistedState {
            interval_seconds: 60,
            services,
            version: 1,
        };
        fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();

        let restored = ServiceProbeService::new(ServiceProbeConfig {
            state_path: Some(state_path),
        });
        let state = restored
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        let microsoft = state
            .services
            .iter()
            .find(|monitor| monitor.id == "microsoft")
            .expect("Microsoft monitor");

        assert_eq!(microsoft.url, MICROSOFT_CONNECTIVITY_TEST_URL);
    }

    #[test]
    fn legacy_microsoft_url_upgrade_preserves_customized_and_non_default_monitors() {
        let default_microsoft = default_service_monitors()
            .into_iter()
            .find(|monitor| monitor.id == "microsoft")
            .expect("Microsoft default monitor");
        let mut cases = [
            ("custom URL", default_microsoft.clone()),
            ("custom label", default_microsoft.clone()),
            ("custom icon", default_microsoft.clone()),
            ("non-default monitor", default_microsoft),
        ];

        for (kind, monitor) in &mut cases {
            monitor.url = LEGACY_MICROSOFT_CONNECTIVITY_TEST_URL.into();
            match *kind {
                "custom URL" => monitor.url = "https://example.com/custom-target".into(),
                "custom label" => monitor.label = "Work Microsoft".into(),
                "custom icon" => monitor.icon = "https://example.com/microsoft.svg".into(),
                "non-default monitor" => monitor.id = "custom-microsoft".into(),
                _ => unreachable!(),
            }

            assert_eq!(
                upgrade_legacy_default_microsoft_url(monitor.clone()),
                *monitor,
                "{kind} must not be rewritten"
            );
        }
    }

    #[test]
    fn restoring_defaults_returns_the_http_microsoft_connectivity_test_endpoint() {
        let service = ServiceProbeService::new(ServiceProbeConfig { state_path: None });
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service probe state poisoned");
            state
                .services
                .iter_mut()
                .find(|monitor| monitor.id == "microsoft")
                .expect("Microsoft default monitor")
                .url = "https://example.com/custom-target".into();
        }
        service.restore_defaults().unwrap();

        let state = service
            .inner
            .state
            .lock()
            .expect("service probe state poisoned");
        let microsoft = state
            .services
            .iter()
            .find(|monitor| monitor.id == "microsoft")
            .expect("Microsoft default monitor");

        assert_eq!(microsoft.url, MICROSOFT_CONNECTIVITY_TEST_URL);
    }

    #[test]
    fn service_icon_ids_are_allowlisted() {
        assert!(validate_icon_id("globe").is_ok());
        assert!(validate_icon_id("https://example.com/icon.svg").is_err());
        assert!(validate_icon_id("unknown").is_err());
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
