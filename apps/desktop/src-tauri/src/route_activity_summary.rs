use std::{
    collections::{HashMap, HashSet, VecDeque, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
    time::Duration,
};

use mish_runtime::{ProxyNode, TrafficDataPhase, TrafficDataSnapshot};

const SUMMARY_WINDOW: Duration = Duration::from_secs(60);
const MAX_OBSERVATION_EVENTS: usize = 8_192;
const MAX_SEEN_CONNECTION_IDS: usize = 131_072;
const MAX_INPUT_LABEL_CHARS: usize = 160;
const MAX_DISPLAY_LABEL_CHARS: usize = 48;

#[cfg(test)]
const MEMORY_BUDGET_BYTES: usize = 10 * 1024 * 1024;
#[cfg(test)]
const EVENT_BYTE_BUDGET: usize = 512;
#[cfg(test)]
const FINGERPRINT_INDEX_BYTE_BUDGET: usize = 32;
#[cfg(test)]
const RING_AND_INDEX_OVERHEAD_BYTES: usize = 1_114_112;

/// The single display-safe fact a native menu may consume from Traffic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RouteActivitySummary {
    pub(crate) label: String,
}

/// Explicit retained-count and capacity evidence for the private observation log.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ObservationLogTelemetry {
    pub(crate) retained_events: usize,
    pub(crate) event_capacity: usize,
    pub(crate) evicted_events: u64,
    pub(crate) distinct_connection_ids: usize,
    pub(crate) dedupe_capacity: usize,
    pub(crate) dedupe_overflow_events: u64,
    pub(crate) current_active_connections: usize,
}

/// Conservative static accounting for the complete private log and its indexes.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ObservationLogMemoryBudget {
    pub(crate) event_bytes: usize,
    pub(crate) dedupe_index_bytes: usize,
    pub(crate) container_and_safety_bytes: usize,
    pub(crate) total_bytes: usize,
}

/// Session-scoped private connection observation log with display-safe derived queries.
///
/// `observe` accepts only an already-authoritative typed Traffic snapshot. It neither
/// polls Controller data nor owns another Traffic authority. Raw connection IDs are
/// reduced to private in-memory fingerprints for session deduplication and never
/// cross this module's display-safe query boundary.
#[derive(Clone, Default)]
pub(crate) struct RouteActivitySummaryHandle {
    log: Arc<Mutex<ConnectionObservationLog>>,
}

impl RouteActivitySummaryHandle {
    pub(crate) fn observe(
        &self,
        traffic: &TrafficDataSnapshot,
        nodes: &[ProxyNode],
        observed_at: Duration,
    ) {
        if let Ok(mut log) = self.log.lock() {
            log.observe(traffic, nodes, observed_at);
        }
    }

    /// Queries the strict trailing 60-second summary with caller-injected monotonic time.
    pub(crate) fn summary_at(&self, observed_at: Duration) -> Option<RouteActivitySummary> {
        self.log.lock().ok()?.summary_at(observed_at)
    }

    #[cfg(test)]
    pub(crate) fn update(
        &self,
        traffic: &TrafficDataSnapshot,
        nodes: &[ProxyNode],
        observed_at: Duration,
    ) -> Option<RouteActivitySummary> {
        self.observe(traffic, nodes, observed_at);
        self.summary_at(observed_at)
    }

    #[cfg(test)]
    pub(crate) fn telemetry(&self) -> Option<ObservationLogTelemetry> {
        Some(self.log.lock().ok()?.telemetry())
    }

    #[cfg(test)]
    pub(crate) const fn memory_budget() -> ObservationLogMemoryBudget {
        ObservationLogMemoryBudget {
            event_bytes: MAX_OBSERVATION_EVENTS * EVENT_BYTE_BUDGET,
            dedupe_index_bytes: MAX_SEEN_CONNECTION_IDS * FINGERPRINT_INDEX_BYTE_BUDGET,
            container_and_safety_bytes: RING_AND_INDEX_OVERHEAD_BYTES,
            total_bytes: MAX_OBSERVATION_EVENTS * EVENT_BYTE_BUDGET
                + MAX_SEEN_CONNECTION_IDS * FINGERPRINT_INDEX_BYTE_BUDGET
                + RING_AND_INDEX_OVERHEAD_BYTES,
        }
    }
}

#[derive(Default)]
struct ConnectionObservationLog {
    events: VecDeque<RouteObservationEvent>,
    session: Option<ObservationSession>,
    seen_connection_ids: HashSet<u128>,
    /// Written in production observe/push paths; read by test-only telemetry.
    #[cfg_attr(not(test), allow(dead_code))]
    evicted_events: u64,
    /// Written in production observe paths; read by test-only telemetry.
    #[cfg_attr(not(test), allow(dead_code))]
    dedupe_overflow_events: u64,
    /// Written in production observe paths; read by test-only telemetry.
    #[cfg_attr(not(test), allow(dead_code))]
    current_active_connections: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservationSession {
    profile_id: String,
    session_id: String,
}

struct RouteObservationEvent {
    observed_at: Duration,
    exit_label: Option<String>,
}

impl ConnectionObservationLog {
    fn observe(
        &mut self,
        traffic: &TrafficDataSnapshot,
        nodes: &[ProxyNode],
        observed_at: Duration,
    ) {
        if traffic.phase != TrafficDataPhase::Ready {
            self.reset();
            return;
        }
        let Some(session_id) = traffic.session_id.as_deref() else {
            self.reset();
            return;
        };
        let session = ObservationSession {
            profile_id: traffic.profile_id.clone(),
            session_id: session_id.into(),
        };
        if self.session.as_ref() != Some(&session) {
            self.reset();
            self.session = Some(session);
        }

        // A ready empty snapshot is authoritative current-active state, but it does
        // not invalidate recent observations inside a consumer's rolling window.
        self.current_active_connections = traffic.active_connections.len();
        for connection in &traffic.active_connections {
            let fingerprint = connection_id_fingerprint(&connection.id);
            if self.seen_connection_ids.contains(&fingerprint) {
                continue;
            }
            if self.seen_connection_ids.len() == MAX_SEEN_CONNECTION_IDS {
                self.dedupe_overflow_events += 1;
                continue;
            }
            self.seen_connection_ids.insert(fingerprint);
            self.push(RouteObservationEvent {
                observed_at,
                exit_label: resolve_exit_label(&connection.route_chain, nodes),
            });
        }
    }

    fn push(&mut self, event: RouteObservationEvent) {
        if self.events.len() == MAX_OBSERVATION_EVENTS {
            self.events.pop_front();
            self.evicted_events += 1;
        }
        self.events.push_back(event);
    }

    fn summary_at(&self, observed_at: Duration) -> Option<RouteActivitySummary> {
        self.leading_label(observed_at)
            .map(|label| RouteActivitySummary { label })
    }

    fn leading_label(&self, observed_at: Duration) -> Option<String> {
        let mut counts = HashMap::<&str, usize>::new();
        for event in &self.events {
            if observed_at.saturating_sub(event.observed_at) < SUMMARY_WINDOW
                && let Some(label) = event.exit_label.as_deref()
            {
                *counts.entry(label).or_default() += 1;
            }
        }
        counts
            .into_iter()
            .max_by(|(left_label, left_count), (right_label, right_count)| {
                left_count
                    .cmp(right_count)
                    .then_with(|| right_label.cmp(left_label))
            })
            .map(|(label, _)| label.into())
    }

    #[cfg(test)]
    fn telemetry(&self) -> ObservationLogTelemetry {
        ObservationLogTelemetry {
            retained_events: self.events.len(),
            event_capacity: MAX_OBSERVATION_EVENTS,
            evicted_events: self.evicted_events,
            distinct_connection_ids: self.seen_connection_ids.len(),
            dedupe_capacity: MAX_SEEN_CONNECTION_IDS,
            dedupe_overflow_events: self.dedupe_overflow_events,
            current_active_connections: self.current_active_connections,
        }
    }

    fn reset(&mut self) {
        self.events.clear();
        self.session = None;
        self.seen_connection_ids.clear();
        self.evicted_events = 0;
        self.dedupe_overflow_events = 0;
        self.current_active_connections = 0;
    }
}

fn connection_id_fingerprint(id: &str) -> u128 {
    fn fingerprint_part(domain: u8, id: &str) -> u64 {
        let mut hasher = DefaultHasher::new();
        domain.hash(&mut hasher);
        id.hash(&mut hasher);
        hasher.finish()
    }
    u128::from(fingerprint_part(0, id)) << 64 | u128::from(fingerprint_part(1, id))
}

fn resolve_exit_label(route_chain: &[String], nodes: &[ProxyNode]) -> Option<String> {
    route_chain
        .iter()
        .rev()
        .find(|route_label| nodes.iter().any(|node| node.label == **route_label))
        .and_then(|label| display_safe_node_label(label))
}

fn display_safe_node_label(label: &str) -> Option<String> {
    let label = label.trim();
    let lowercase = label.to_ascii_lowercase();
    if label.is_empty()
        || label.chars().count() > MAX_INPUT_LABEL_CHARS
        || label.chars().any(char::is_control)
        || label.contains(['/', '\\', ':', '@'])
        || label.parse::<std::net::IpAddr>().is_ok()
        || lowercase.contains("://")
        || lowercase.starts_with("sk-")
        || [
            "token=",
            "secret=",
            "password=",
            "api_key=",
            "access_key=",
            "authorization=",
            "cookie=",
            "bearer ",
        ]
        .iter()
        .any(|needle| lowercase.contains(needle))
    {
        return None;
    }
    let mut displayed = label
        .chars()
        .take(MAX_DISPLAY_LABEL_CHARS)
        .collect::<String>();
    if label.chars().count() > MAX_DISPLAY_LABEL_CHARS {
        displayed.push('…');
    }
    Some(displayed)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_OBSERVATION_EVENTS, MAX_SEEN_CONNECTION_IDS, MEMORY_BUDGET_BYTES,
        RouteActivitySummaryHandle, display_safe_node_label,
    };
    use std::time::Duration;

    use mish_runtime::{
        ProxyNode, StatusAdapterKind, TrafficConnection, TrafficDataPhase, TrafficDataSnapshot,
        TrafficMatchedRule,
    };

    fn node(label: &str) -> ProxyNode {
        ProxyNode {
            id: format!("private-{label}"),
            label: label.into(),
            latency_milliseconds: None,
            protocol: "ss".into(),
        }
    }
    fn connection(id: &str, route_chain: &[&str]) -> TrafficConnection {
        TrafficConnection {
            destination_host: Some("private.example".into()),
            destination_ip: Some("192.0.2.1".into()),
            destination_port: 443,
            download_bytes: "0".into(),
            id: id.into(),
            matched_rule: TrafficMatchedRule {
                payload: "MATCH".into(),
                kind: "MATCH".into(),
            },
            network: "tcp".into(),
            process_name: Some("private-app".into()),
            process_path: Some("/private/app".into()),
            protocol: "tcp".into(),
            provider_chain: Vec::new(),
            remote_destination: None,
            route_chain: route_chain.iter().map(|label| (*label).into()).collect(),
            sniff_host: None,
            source_ip: Some("192.0.2.2".into()),
            source_port: 50_000,
            started_at: "2026-01-01T00:00:00Z".into(),
            upload_bytes: "0".into(),
        }
    }
    fn snapshot(session: &str, connections: Vec<TrafficConnection>) -> TrafficDataSnapshot {
        TrafficDataSnapshot {
            active_connections: connections,
            adapter_kind: StatusAdapterKind::Native,
            phase: TrafficDataPhase::Ready,
            profile_id: "private-profile-id".into(),
            reconnect_count: 0,
            rules: Vec::new(),
            sequence: 1,
            session_id: Some(session.into()),
        }
    }
    fn at(seconds: u64) -> Duration {
        Duration::from_secs(seconds)
    }
    fn label(result: Option<super::RouteActivitySummary>) -> Option<String> {
        result.map(|summary| summary.label)
    }

    #[test]
    fn first_observations_select_the_busiest_real_exit_node() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo"), node("Singapore")];
        assert_eq!(
            label(handle.update(
                &snapshot(
                    "one",
                    vec![
                        connection("one", &["Auto", "Tokyo"]),
                        connection("two", &["Auto", "Tokyo"]),
                        connection("three", &["Auto", "Singapore"])
                    ]
                ),
                &nodes,
                at(1)
            )),
            Some("Tokyo".into())
        );
    }
    #[test]
    fn duplicate_snapshots_and_long_lived_connections_are_not_new_activity() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo"), node("Singapore")];
        let first = snapshot("one", vec![connection("one", &["Tokyo"])]);
        assert_eq!(
            label(handle.update(&first, &nodes, at(1))),
            Some("Tokyo".into())
        );
        assert_eq!(label(handle.update(&first, &nodes, at(61))), None);
        assert_eq!(
            label(handle.update(
                &snapshot(
                    "one",
                    vec![
                        connection("one", &["Tokyo"]),
                        connection("two", &["Singapore"])
                    ]
                ),
                &nodes,
                at(62)
            )),
            Some("Singapore".into())
        );
    }
    #[test]
    fn empty_ready_snapshot_updates_active_tracking_without_erasing_recent_events() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo")];
        handle.observe(
            &snapshot("one", vec![connection("one", &["Tokyo"])]),
            &nodes,
            at(1),
        );
        assert_eq!(
            label(handle.update(&snapshot("one", Vec::new()), &nodes, at(2))),
            Some("Tokyo".into())
        );
        assert_eq!(handle.telemetry().unwrap().current_active_connections, 0);
    }
    #[test]
    fn duplicate_snapshot_above_the_old_seen_id_limit_is_not_recounted() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo")];
        let traffic = snapshot(
            "one",
            (0..=MAX_SEEN_CONNECTION_IDS.min(1_024))
                .map(|index| connection(&format!("connection-{index}"), &["Tokyo"]))
                .collect(),
        );
        handle.observe(&traffic, &nodes, at(0));
        handle.observe(&traffic, &nodes, at(61));
        assert_eq!(label(handle.summary_at(at(61))), None);
    }
    #[test]
    fn ring_overflow_is_oldest_first_and_does_not_break_deduplication() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo")];
        let traffic = snapshot(
            "one",
            (0..=MAX_OBSERVATION_EVENTS)
                .map(|index| connection(&format!("burst-{index}"), &["Tokyo"]))
                .collect(),
        );
        handle.observe(&traffic, &nodes, at(0));
        handle.observe(&traffic, &nodes, at(61));
        let telemetry = handle.telemetry().unwrap();
        assert_eq!(telemetry.retained_events, MAX_OBSERVATION_EVENTS);
        assert_eq!(telemetry.evicted_events, 1);
        assert_eq!(telemetry.dedupe_overflow_events, 0);
        assert_eq!(label(handle.summary_at(at(61))), None);
    }
    #[test]
    fn low_rate_and_high_rate_short_flows_are_bounded() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo")];
        for second in 0..3 {
            handle.observe(
                &snapshot(
                    "one",
                    vec![connection(&format!("slow-{second}"), &["Tokyo"])],
                ),
                &nodes,
                at(second),
            );
        }
        assert_eq!(label(handle.summary_at(at(59))), Some("Tokyo".into()));
        let burst = snapshot(
            "one",
            (0..MAX_OBSERVATION_EVENTS)
                .map(|index| connection(&format!("fast-{index}"), &["Tokyo"]))
                .collect(),
        );
        handle.observe(&burst, &nodes, at(60));
        assert_eq!(
            handle.telemetry().unwrap().retained_events,
            MAX_OBSERVATION_EVENTS
        );
    }
    #[test]
    fn resets_on_stale_unavailable_missing_session_profile_and_traffic_session_replacement() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo"), node("Singapore")];
        let ready = snapshot("one", vec![connection("one", &["Tokyo"])]);
        handle.observe(&ready, &nodes, at(1));
        let mut stale = ready.clone();
        stale.phase = TrafficDataPhase::Stale;
        handle.observe(&stale, &nodes, at(2));
        assert_eq!(label(handle.summary_at(at(2))), None);
        handle.observe(&ready, &nodes, at(3));
        handle.observe(
            &TrafficDataSnapshot::unavailable(StatusAdapterKind::Native),
            &nodes,
            at(4),
        );
        assert_eq!(label(handle.summary_at(at(4))), None);
        let mut missing = ready.clone();
        missing.session_id = None;
        handle.observe(&missing, &nodes, at(5));
        assert_eq!(label(handle.summary_at(at(5))), None);
        handle.observe(&ready, &nodes, at(6));
        let mut profile = snapshot("one", vec![connection("one", &["Singapore"])]);
        profile.profile_id = "replacement".into();
        assert_eq!(
            label(handle.update(&profile, &nodes, at(7))),
            Some("Singapore".into())
        );
        assert_eq!(
            label(handle.update(
                &snapshot("two", vec![connection("one", &["Tokyo"])]),
                &nodes,
                at(8)
            )),
            Some("Tokyo".into())
        );
    }
    #[test]
    fn sixty_second_window_is_strict_and_ties_are_deterministic() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Zurich"), node("Amsterdam")];
        handle.observe(
            &snapshot(
                "one",
                vec![
                    connection("one", &["Zurich"]),
                    connection("two", &["Amsterdam"]),
                ],
            ),
            &nodes,
            at(0),
        );
        assert_eq!(label(handle.summary_at(at(59))), Some("Amsterdam".into()));
        assert_eq!(label(handle.summary_at(at(60))), None);
    }
    #[test]
    fn memory_accounting_stays_under_ten_mebibytes() {
        let budget = RouteActivitySummaryHandle::memory_budget();
        assert!(budget.total_bytes <= MEMORY_BUDGET_BYTES);
        assert_eq!(
            budget.total_bytes,
            budget.event_bytes + budget.dedupe_index_bytes + budget.container_and_safety_bytes
        );
    }
    #[test]
    fn labels_are_unicode_safe_and_sensitive_values_never_become_display_data() {
        assert_eq!(
            display_safe_node_label("  东京 🚄  "),
            Some("东京 🚄".into())
        );
        let long = "界".repeat(49);
        assert_eq!(
            display_safe_node_label(&long),
            Some(format!("{}…", "界".repeat(48)))
        );
        for sensitive in [
            "https://private.example/token=secret",
            "127.0.0.1",
            "private.example:7890",
            "../private.yaml",
            "sk-private-credential",
            "token=secret-value",
            "line\\nbreak",
        ] {
            assert_eq!(display_safe_node_label(sensitive), None, "{sensitive}");
        }
        let handle = RouteActivitySummaryHandle::default();
        let unsafe_node = [node("private.example:7890")];
        assert_eq!(
            label(handle.update(
                &snapshot("unsafe", vec![connection("one", &["private.example:7890"])]),
                &unsafe_node,
                at(1)
            )),
            None
        );
    }
}
