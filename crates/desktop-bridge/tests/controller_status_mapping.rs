use mish_bridge::{
    ControllerObservationBatch, ControllerStatusMapper, ProfileMappingContext, StatusMappingError,
    StatusRetentionPolicy,
};
use mish_mihomo_controller::{
    ConnectionSnapshot, MemorySnapshot, ProxyCatalog, RuleList, RuntimeConfig, TrafficSnapshot,
};
use mish_runtime::{CorePhase, CoreStatus, StatusAdapterKind};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const INNER_GROUP: &str = "内层策略 🌐";
const OUTER_GROUP: &str = "出口选择 / Выбор / اختيار";
const DIRECT: &str = "DIRECT";

fn parse<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn context(fingerprint: &str) -> ProfileMappingContext {
    ProfileMappingContext::new("profile-work", fingerprint, "工作配置 / Work").unwrap()
}

fn core() -> CoreStatus {
    CoreStatus {
        error: None,
        phase: CorePhase::Running,
        pid: Some(42),
        version: Some("v1.19.29".into()),
    }
}

fn runtime_config() -> RuntimeConfig {
    parse(json!({
        "mode": "global",
        "tun": {"enable": true},
        "allow-lan": false,
        "ipv6": true,
        "port": 0,
        "socks-port": 0,
        "redir-port": 0,
        "tproxy-port": 0,
        "mixed-port": 7890,
        "log-level": "info",
        "tcp-concurrent": true,
        "find-process-mode": "strict",
        "sniffing": true,
        "interface-name": ""
    }))
}

fn long_node_label() -> String {
    "🇯🇵 东京 / 東京 — Прокси — مرحبا — Café 🛰️".repeat(32)
}

fn proxy_catalog() -> ProxyCatalog {
    let node = long_node_label();
    parse(json!({
        "proxies": {
            node.clone(): {
                "id": "controller-node-a",
                "name": node.clone(),
                "type": "VLESS-REALITY",
                "alive": true,
                "udp": true,
                "uot": false,
                "xudp": true,
                "tfo": false,
                "mptcp": false,
                "smux": false,
                "history": [
                    {"time": "2026-07-19T01:00:00Z", "delay": 61},
                    {"time": "2026-07-19T01:00:05Z", "delay": 87}
                ]
            },
            DIRECT: {
                "name": DIRECT,
                "type": "Direct",
                "alive": true,
                "udp": true,
                "uot": false,
                "xudp": false,
                "tfo": false,
                "mptcp": false,
                "smux": false
            },
            INNER_GROUP: {
                "name": INNER_GROUP,
                "type": "Selector",
                "alive": true,
                "udp": true,
                "uot": false,
                "xudp": false,
                "tfo": false,
                "mptcp": false,
                "smux": false,
                "all": [node.clone(), DIRECT],
                "now": node
            },
            OUTER_GROUP: {
                "name": OUTER_GROUP,
                "type": "Fallback",
                "alive": true,
                "udp": true,
                "uot": false,
                "xudp": false,
                "tfo": false,
                "mptcp": false,
                "smux": false,
                "all": [INNER_GROUP, DIRECT],
                "now": INNER_GROUP
            }
        }
    }))
}

fn connection(id: &str, chains: &[&str]) -> Value {
    json!({
        "id": id,
        "metadata": {
            "network": "tcp",
            "type": "HTTPS",
            "sourceIP": "192.0.2.10",
            "destinationIP": "198.51.100.20",
            "sourcePort": "51000",
            "destinationPort": "443"
        },
        "upload": 12,
        "download": 34,
        "start": "2026-07-19T01:00:00Z",
        "chains": chains,
        "rule": "MATCH",
        "rulePayload": ""
    })
}

fn connections(items: Vec<Value>) -> ConnectionSnapshot {
    parse(json!({
        "downloadTotal": 340,
        "uploadTotal": 120,
        "connections": items,
        "memory": 4096
    }))
}

fn rules() -> RuleList {
    parse(json!({
        "rules": [
            {"index": 0, "type": "MATCH", "payload": "", "proxy": OUTER_GROUP, "size": -1},
            {
                "index": 1,
                "type": "DOMAIN",
                "payload": "fixture.invalid",
                "proxy": DIRECT,
                "size": -1,
                "extra": {
                    "disabled": true,
                    "hitCount": 0,
                    "hitAt": "0001-01-01T00:00:00Z",
                    "missCount": 0,
                    "missAt": "0001-01-01T00:00:00Z"
                }
            }
        ]
    }))
}

#[test]
fn maps_nested_groups_opaque_metadata_metrics_and_group_scoped_selection() {
    let mut mapper = ControllerStatusMapper::new(context("sha256:profile-a"));
    mapper
        .apply(ControllerObservationBatch {
            runtime_config: Some(runtime_config()),
            proxies: Some(proxy_catalog()),
            traffic: Some(TrafficSnapshot {
                up: 11,
                down: 22,
                up_total: 33,
                down_total: 44,
            }),
            memory: Some(MemorySnapshot {
                inuse: 99,
                oslimit: 1_000,
            }),
            connections: Some(connections(vec![
                connection(
                    "connection-a",
                    &[OUTER_GROUP, INNER_GROUP, &long_node_label()],
                ),
                connection("connection-b", &[OUTER_GROUP, OUTER_GROUP, DIRECT]),
            ])),
            rules: Some(rules()),
        })
        .unwrap();

    let snapshot = mapper
        .snapshot(&core(), StatusAdapterKind::Rpc, 123)
        .unwrap();
    assert_eq!(snapshot.active_profile_id, "profile-work");
    assert_eq!(snapshot.profiles[0].label, "工作配置 / Work");
    assert_eq!(snapshot.routing_mode, mish_runtime::RoutingMode::Global);
    assert_eq!(snapshot.runtime.phase, mish_runtime::RuntimePhase::Healthy);
    assert!(!snapshot.runtime.capture_selection.system_proxy);
    assert!(!snapshot.runtime.capture_selection.tun);
    assert_eq!(
        snapshot.capabilities.system_proxy,
        mish_runtime::CapabilityAvailability::Unavailable
    );
    assert_eq!(
        snapshot.capabilities.tun,
        mish_runtime::CapabilityAvailability::Unavailable
    );

    let node_label = long_node_label();
    let node = snapshot
        .nodes
        .iter()
        .find(|node| node.label == node_label)
        .unwrap();
    assert_eq!(node.label, node_label);
    assert_eq!(node.protocol, "VLESS-REALITY");
    assert_eq!(node.latency_milliseconds, Some(87));

    let inner = snapshot
        .groups
        .iter()
        .find(|group| group.label == INNER_GROUP)
        .unwrap();
    let outer = snapshot
        .groups
        .iter()
        .find(|group| group.label == OUTER_GROUP)
        .unwrap();
    assert_eq!(inner.selected_child_id, node.id);
    assert_eq!(outer.selected_child_id, inner.id);
    assert!(outer.child_ids.contains(&inner.id));
    assert_ne!(outer.id, inner.id);

    assert_eq!(snapshot.traffic.download_bytes_per_second, 22);
    assert_eq!(snapshot.traffic.downloaded_bytes, 44);
    assert_eq!(snapshot.traffic.upload_bytes_per_second, 11);
    assert_eq!(snapshot.traffic.uploaded_bytes, 33);
    assert_eq!(snapshot.metrics.memory_bytes, 99);
    assert_eq!(snapshot.metrics.active_connections, 2);
    assert_eq!(snapshot.metrics.effective_rules, 1);
    assert_eq!(snapshot.metrics.uptime_seconds, 123);
    let outer_usage = snapshot
        .group_usage
        .iter()
        .find(|usage| usage.group_id == outer.id)
        .unwrap();
    let inner_usage = snapshot
        .group_usage
        .iter()
        .find(|usage| usage.group_id == inner.id)
        .unwrap();
    assert_eq!(outer_usage.observed_connection_count, 2);
    assert_eq!(inner_usage.observed_connection_count, 1);

    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["adapterKind"], "rpc");
    assert_eq!(value["groups"][0]["type"], "selector");
    assert_eq!(value["services"], json!([]));
    assert_eq!(value["probeResults"], json!([]));
}

#[test]
fn derives_stable_profile_scoped_ids() {
    let mut first = ControllerStatusMapper::new(context("sha256:profile-a"));
    let mut same_profile = ControllerStatusMapper::new(context("sha256:profile-a"));
    let mut other_profile = ControllerStatusMapper::new(context("sha256:profile-b"));
    for mapper in [&mut first, &mut same_profile, &mut other_profile] {
        mapper
            .apply(ControllerObservationBatch {
                runtime_config: Some(runtime_config()),
                proxies: Some(proxy_catalog()),
                ..ControllerObservationBatch::default()
            })
            .unwrap();
    }
    let first = first.snapshot(&core(), StatusAdapterKind::Rpc, 0).unwrap();
    let same_profile = same_profile
        .snapshot(&core(), StatusAdapterKind::Rpc, 0)
        .unwrap();
    let other_profile = other_profile
        .snapshot(&core(), StatusAdapterKind::Rpc, 0)
        .unwrap();

    assert_eq!(first.groups[0].id, same_profile.groups[0].id);
    assert_eq!(first.nodes[0].id, same_profile.nodes[0].id);
    assert_ne!(first.groups[0].id, other_profile.groups[0].id);
    assert_ne!(first.nodes[0].id, other_profile.nodes[0].id);
    assert!(
        first
            .groups
            .iter()
            .all(|group| group.id.starts_with("group:"))
    );
    assert!(first.nodes.iter().all(|node| node.id.starts_with("proxy:")));
}

#[test]
fn rejects_missing_and_cross_group_selections_without_replacing_valid_state() {
    let mut mapper = ControllerStatusMapper::new(context("sha256:profile-a"));
    mapper
        .apply(ControllerObservationBatch {
            runtime_config: Some(runtime_config()),
            proxies: Some(proxy_catalog()),
            ..ControllerObservationBatch::default()
        })
        .unwrap();
    let before = mapper.snapshot(&core(), StatusAdapterKind::Rpc, 0).unwrap();

    let mut missing = proxy_catalog();
    missing.proxies.get_mut(INNER_GROUP).unwrap().now = None;
    assert_eq!(
        mapper
            .apply(ControllerObservationBatch {
                proxies: Some(missing),
                ..ControllerObservationBatch::default()
            })
            .unwrap_err(),
        StatusMappingError::MissingSelection {
            group: INNER_GROUP.into()
        }
    );
    assert_eq!(
        mapper.snapshot(&core(), StatusAdapterKind::Rpc, 0).unwrap(),
        before
    );

    let mut cross_group = proxy_catalog();
    cross_group.proxies.get_mut(INNER_GROUP).unwrap().now = Some(OUTER_GROUP.into());
    assert_eq!(
        mapper
            .apply(ControllerObservationBatch {
                proxies: Some(cross_group),
                ..ControllerObservationBatch::default()
            })
            .unwrap_err(),
        StatusMappingError::SelectionOutsideGroup {
            group: INNER_GROUP.into(),
            selected: OUTER_GROUP.into()
        }
    );
}

#[test]
fn retains_stale_values_handles_empty_streams_and_bounds_series_and_deduplication() {
    let retention = StatusRetentionPolicy {
        max_traffic_samples: 2,
        max_seen_connection_ids: 2,
    };
    let mut mapper =
        ControllerStatusMapper::with_retention(context("sha256:profile-a"), retention).unwrap();
    mapper
        .apply(ControllerObservationBatch {
            runtime_config: Some(runtime_config()),
            proxies: Some(proxy_catalog()),
            ..ControllerObservationBatch::default()
        })
        .unwrap();
    let empty = mapper.snapshot(&core(), StatusAdapterKind::Rpc, 0).unwrap();
    assert_eq!(empty.traffic.download_series, Vec::<u64>::new());
    assert_eq!(empty.metrics.memory_bytes, 0);
    assert_eq!(empty.metrics.active_connections, 0);

    for value in 1..=3 {
        mapper
            .apply(ControllerObservationBatch {
                traffic: Some(TrafficSnapshot {
                    up: value,
                    down: value * 10,
                    up_total: value * 100,
                    down_total: value * 1_000,
                }),
                ..ControllerObservationBatch::default()
            })
            .unwrap();
    }
    let fresh = mapper.snapshot(&core(), StatusAdapterKind::Rpc, 0).unwrap();
    assert_eq!(fresh.traffic.upload_series, [2, 3]);
    assert_eq!(fresh.traffic.download_series, [20, 30]);

    mapper.apply(ControllerObservationBatch::default()).unwrap();
    let stale = mapper.snapshot(&core(), StatusAdapterKind::Rpc, 0).unwrap();
    assert_eq!(stale.traffic, fresh.traffic);

    for id in ["one", "two", "three", "one"] {
        mapper
            .apply(ControllerObservationBatch {
                connections: Some(connections(vec![connection(id, &[OUTER_GROUP])])),
                ..ControllerObservationBatch::default()
            })
            .unwrap();
    }
    let after_eviction = mapper.snapshot(&core(), StatusAdapterKind::Rpc, 0).unwrap();
    let outer_id = after_eviction
        .groups
        .iter()
        .find(|group| group.label == OUTER_GROUP)
        .unwrap()
        .id
        .clone();
    assert_eq!(
        after_eviction
            .group_usage
            .iter()
            .find(|usage| usage.group_id == outer_id)
            .unwrap()
            .observed_connection_count,
        4
    );

    mapper
        .apply(ControllerObservationBatch {
            connections: Some(connections(Vec::new())),
            ..ControllerObservationBatch::default()
        })
        .unwrap();
    assert_eq!(
        mapper
            .snapshot(&core(), StatusAdapterKind::Rpc, 0)
            .unwrap()
            .metrics
            .active_connections,
        0
    );
}

#[test]
fn requires_identity_observations_and_rejects_invalid_retention() {
    let mapper = ControllerStatusMapper::new(context("sha256:profile-a"));
    assert_eq!(
        mapper
            .snapshot(&core(), StatusAdapterKind::Rpc, 0)
            .unwrap_err(),
        StatusMappingError::MissingRequiredObservation {
            observation: "runtime configuration"
        }
    );
    assert!(matches!(
        ControllerStatusMapper::with_retention(
            context("sha256:profile-a"),
            StatusRetentionPolicy {
                max_traffic_samples: 513,
                max_seen_connection_ids: 1
            }
        ),
        Err(StatusMappingError::InvalidRetention {
            field: "max_traffic_samples",
            maximum: 512
        })
    ));
}
