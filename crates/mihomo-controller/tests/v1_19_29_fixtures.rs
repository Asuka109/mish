use mish_mihomo_controller::{
    ConnectionSnapshot, MemorySnapshot, ProxyCatalog, RoutingMode, RuleList, RuntimeConfig,
    TrafficSnapshot, VersionInfo,
};

#[test]
fn decodes_sanitized_real_core_payloads() {
    let version: VersionInfo = fixture("version.json");
    assert_eq!(version.version, "v1.19.29");

    let config: RuntimeConfig = fixture("configs.json");
    assert_eq!(config.mode, RoutingMode::Rule);
    assert!(!config.tun.enable);

    let proxies: ProxyCatalog = fixture("proxies.json");
    let group = proxies.proxies["选择🧪组"].group().unwrap();
    assert_eq!(group.selected, Some("合成🌌节点"));
    assert_eq!(group.children, &["合成🌌节点", "DIRECT", "REJECT"]);

    let rules: RuleList = fixture("rules.json");
    assert_eq!(rules.rules[0].kind, "DomainSuffix");
    assert_eq!(rules.rules[0].proxy, "选择🧪组");

    let traffic: TrafficSnapshot = fixture("traffic.json");
    assert_eq!(traffic.up_total, 0);

    let memory: MemorySnapshot = fixture("memory.json");
    assert_eq!(memory.inuse, 0);

    let connections: ConnectionSnapshot = fixture("connections.json");
    assert!(connections.connections.is_empty());
}

#[test]
fn accepts_the_pinned_cores_signed_counter_wire_type() {
    let traffic: TrafficSnapshot =
        serde_json::from_str(r#"{"up":-1,"down":-2,"upTotal":-3,"downTotal":-4}"#).unwrap();
    assert_eq!(traffic.up, -1);

    let connections: ConnectionSnapshot = serde_json::from_str(
        r#"{"downloadTotal":-1,"uploadTotal":-2,"connections":null,"memory":0}"#,
    )
    .unwrap();
    assert_eq!(connections.download_total, -1);
}

fn fixture<T>(name: &str) -> T
where
    T: serde::de::DeserializeOwned,
{
    let payload = match name {
        "version.json" => include_str!("fixtures/v1.19.29/version.json"),
        "configs.json" => include_str!("fixtures/v1.19.29/configs.json"),
        "proxies.json" => include_str!("fixtures/v1.19.29/proxies.json"),
        "rules.json" => include_str!("fixtures/v1.19.29/rules.json"),
        "traffic.json" => include_str!("fixtures/v1.19.29/traffic.json"),
        "memory.json" => include_str!("fixtures/v1.19.29/memory.json"),
        "connections.json" => include_str!("fixtures/v1.19.29/connections.json"),
        _ => panic!("unknown fixture: {name}"),
    };
    serde_json::from_str(payload).unwrap()
}
