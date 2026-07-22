use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use mish_runtime::{ProxyNode, TrafficDataPhase, TrafficDataSnapshot};

const SUMMARY_WINDOW: Duration = Duration::from_secs(60);
const OBSERVATION_LOG_WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_OBSERVATION_EVENTS: usize = 2_048;
const MAX_SEEN_CONNECTION_IDS: usize = 512;
const MAX_INPUT_LABEL_CHARS: usize = 160;
const MAX_DISPLAY_LABEL_CHARS: usize = 48;

/// The single display-safe fact that a native menu may consume from Traffic.
///
/// It deliberately contains no connection, controller, endpoint, or profile
/// identifiers. `label` is a bounded, sanitized user-authored node label.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RouteActivitySummary {
    pub(crate) label: String,
}

/// In-memory projection of a private, bounded first-observation event log for
/// the current Traffic session.
///
/// The status-bar owner calls [`Self::observe`] when its authoritative typed
/// Traffic snapshot changes, then calls [`Self::summary_at`] once per second
/// from its menu refresh timer. The projection does not fetch or reinterpret
/// Traffic data itself.
#[derive(Clone, Default)]
pub(crate) struct RouteActivitySummaryHandle {
    projection: Arc<Mutex<RouteActivityProjection>>,
}

impl RouteActivitySummaryHandle {
    /// Records first observations from the latest authoritative Traffic
    /// snapshot. This is intentionally separate from the one-second display
    /// cadence so the native menu does not poll or duplicate Traffic authority.
    pub(crate) fn observe(
        &self,
        traffic: &TrafficDataSnapshot,
        nodes: &[ProxyNode],
        observed_at: Duration,
    ) {
        if let Ok(mut projection) = self.projection.lock() {
            projection.observe(traffic, nodes, observed_at);
        }
    }

    /// Re-evaluates the strict rolling window at the native menu's current
    /// monotonic time. The status bar calls this once per second.
    pub(crate) fn summary_at(&self, observed_at: Duration) -> Option<RouteActivitySummary> {
        let mut projection = self.projection.lock().ok()?;
        projection.summary_at(observed_at)
    }

    /// Convenience for a snapshot refresh that also needs an immediate result.
    pub(crate) fn update(
        &self,
        traffic: &TrafficDataSnapshot,
        nodes: &[ProxyNode],
        observed_at: Duration,
    ) -> Option<RouteActivitySummary> {
        self.observe(traffic, nodes, observed_at);
        self.summary_at(observed_at)
    }
}

#[derive(Default)]
struct RouteActivityProjection {
    has_current_connections: bool,
    observation_log: VecDeque<RouteObservationEvent>,
    session: Option<ObservationSession>,
    seen_connection_ids: HashMap<String, ()>,
    seen_connection_order: VecDeque<String>,
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

impl RouteActivityProjection {
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
        let Some(session_id) = traffic.session_id.clone() else {
            self.reset();
            return;
        };
        let session = ObservationSession {
            profile_id: traffic.profile_id.clone(),
            session_id,
        };
        if self.session.as_ref() != Some(&session) {
            self.reset();
            self.session = Some(session);
        }
        self.has_current_connections = !traffic.active_connections.is_empty();
        if traffic.active_connections.is_empty() {
            return;
        }
        self.prune_log(observed_at);

        for connection in &traffic.active_connections {
            if self.seen_connection_ids.contains_key(&connection.id) {
                continue;
            }
            let exit_label = resolve_exit_label(&connection.route_chain, nodes);
            self.remember(
                connection.id.clone(),
                RouteObservationEvent {
                    observed_at,
                    exit_label,
                },
            );
        }
    }

    fn summary_at(&mut self, observed_at: Duration) -> Option<RouteActivitySummary> {
        self.prune_log(observed_at);
        self.has_current_connections
            .then(|| self.leading_label(observed_at))
            .flatten()
            .map(|label| RouteActivitySummary { label })
    }

    fn remember(&mut self, id: String, event: RouteObservationEvent) {
        self.seen_connection_ids.insert(id.clone(), ());
        self.seen_connection_order.push_back(id);
        while self.seen_connection_order.len() > MAX_SEEN_CONNECTION_IDS {
            if let Some(expired) = self.seen_connection_order.pop_front() {
                self.seen_connection_ids.remove(&expired);
            }
        }
        self.observation_log.push_back(event);
        while self.observation_log.len() > MAX_OBSERVATION_EVENTS {
            self.observation_log.pop_front();
        }
    }

    fn prune_log(&mut self, observed_at: Duration) {
        while self.observation_log.front().is_some_and(|event| {
            observed_at.saturating_sub(event.observed_at) >= OBSERVATION_LOG_WINDOW
        }) {
            self.observation_log.pop_front();
        }
    }

    fn leading_label(&self, observed_at: Duration) -> Option<String> {
        let mut counts = HashMap::<&str, usize>::new();
        for event in &self.observation_log {
            if observed_at.saturating_sub(event.observed_at) < SUMMARY_WINDOW {
                if let Some(label) = event.exit_label.as_deref() {
                    *counts.entry(label).or_default() += 1;
                }
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

    fn reset(&mut self) {
        self.has_current_connections = false;
        self.session = None;
        self.observation_log.clear();
        self.seen_connection_ids.clear();
        self.seen_connection_order.clear();
    }
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
        MAX_OBSERVATION_EVENTS, MAX_SEEN_CONNECTION_IDS, OBSERVATION_LOG_WINDOW,
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
            source_port: 50000,
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
        let result = handle.update(
            &snapshot(
                "one",
                vec![
                    connection("one", &["Auto", "Tokyo"]),
                    connection("two", &["Auto", "Tokyo"]),
                    connection("three", &["Auto", "Singapore"]),
                ],
            ),
            &nodes,
            at(1),
        );
        assert_eq!(label(result), Some("Tokyo".into()));
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
        assert_eq!(
            label(handle.update(&first, &nodes, at(30))),
            Some("Tokyo".into())
        );
        assert_eq!(label(handle.update(&first, &nodes, at(61))), None);
        assert_eq!(
            label(handle.update(
                &snapshot(
                    "one",
                    vec![
                        connection("one", &["Tokyo"]),
                        connection("two", &["Singapore"]),
                    ]
                ),
                &nodes,
                at(62)
            )),
            Some("Singapore".into())
        );
    }

    #[test]
    fn the_sixty_second_boundary_is_strict() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo")];
        let traffic = snapshot("one", vec![connection("one", &["Tokyo"])]);
        handle.observe(&traffic, &nodes, at(0));
        assert_eq!(label(handle.summary_at(at(59))), Some("Tokyo".into()));
        assert_eq!(label(handle.summary_at(at(60))), None);
    }

    #[test]
    fn ties_use_lexicographically_ascending_safe_labels() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Zurich"), node("Amsterdam")];
        assert_eq!(
            label(handle.update(
                &snapshot(
                    "one",
                    vec![
                        connection("one", &["Zurich"]),
                        connection("two", &["Amsterdam"]),
                    ]
                ),
                &nodes,
                at(1)
            )),
            Some("Amsterdam".into())
        );
    }

    #[test]
    fn a_profile_or_session_replacement_resets_observations() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo"), node("Singapore")];
        handle.update(
            &snapshot("one", vec![connection("one", &["Tokyo"])]),
            &nodes,
            at(1),
        );
        assert_eq!(
            label(handle.update(
                &snapshot("two", vec![connection("one", &["Singapore"])]),
                &nodes,
                at(2)
            )),
            Some("Singapore".into())
        );

        let mut changed_profile = snapshot("two", vec![connection("one", &["Tokyo"])]);
        changed_profile.profile_id = "other-private-profile".into();
        assert_eq!(
            label(handle.update(&changed_profile, &nodes, at(3))),
            Some("Tokyo".into())
        );
    }

    #[test]
    fn stale_unavailable_and_empty_snapshots_have_no_summary() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo")];
        let ready = snapshot("one", vec![connection("one", &["Tokyo"])]);
        handle.update(&ready, &nodes, at(1));
        assert_eq!(
            label(handle.update(&snapshot("one", Vec::new()), &nodes, at(2))),
            None
        );
        let mut stale = ready.clone();
        stale.phase = TrafficDataPhase::Stale;
        assert_eq!(label(handle.update(&stale, &nodes, at(3))), None);
        assert_eq!(
            label(handle.update(
                &TrafficDataSnapshot::unavailable(StatusAdapterKind::Native),
                &nodes,
                at(4)
            )),
            None
        );
        assert_eq!(
            label(handle.update(&snapshot("two", Vec::new()), &nodes, at(5))),
            None
        );
        let mut missing_session = snapshot("three", vec![connection("two", &["Tokyo"])]);
        missing_session.session_id = None;
        assert_eq!(label(handle.update(&missing_session, &nodes, at(6))), None);
    }

    #[test]
    fn observation_log_retention_is_bounded_by_age_and_capacity() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo")];
        let connections = (0..=MAX_OBSERVATION_EVENTS)
            .map(|index| connection(&format!("connection-{index}"), &["Tokyo"]))
            .collect();
        handle.update(&snapshot("one", connections), &nodes, at(1));
        {
            let projection = handle.projection.lock().unwrap();
            assert_eq!(projection.observation_log.len(), MAX_OBSERVATION_EVENTS);
            assert_eq!(
                projection.seen_connection_ids.len(),
                MAX_SEEN_CONNECTION_IDS
            );
        }
        assert_eq!(
            label(handle.summary_at(OBSERVATION_LOG_WINDOW + Duration::from_secs(1))),
            None
        );
        assert!(handle.projection.lock().unwrap().observation_log.is_empty());
    }

    #[test]
    fn only_the_last_catalogued_node_in_the_route_chain_is_an_exit() {
        let handle = RouteActivitySummaryHandle::default();
        let nodes = [node("Tokyo"), node("Relay exit")];
        assert_eq!(
            label(handle.update(
                &snapshot(
                    "one",
                    vec![connection("one", &["Policy group", "Tokyo", "Relay exit"],)]
                ),
                &nodes,
                at(1)
            )),
            Some("Relay exit".into())
        );
        assert_eq!(
            label(handle.update(
                &snapshot(
                    "two",
                    vec![connection("two", &["Policy group", "Unknown label"],)]
                ),
                &nodes,
                at(2)
            )),
            None
        );
    }

    #[test]
    fn labels_are_trimmed_unicode_safe_truncated_and_redacted() {
        assert_eq!(
            display_safe_node_label("  东京 🚄  "),
            Some("东京 🚄".into())
        );
        let long = "界".repeat(49);
        assert_eq!(
            display_safe_node_label(&long),
            Some(format!("{}…", "界".repeat(48)))
        );
        assert_eq!(display_safe_node_label(&"x".repeat(161)), None);
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
