use std::{
    env, fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

use futures_util::StreamExt;
use mish_mihomo_controller::{
    ControllerClient, ControllerLimits, HttpTransport, HttpTransportConfig, RoutingMode,
};
use tokio::time::sleep;
use url::Url;

const SECRET: &str = "synthetic-controller-token";
const GROUP_NAME: &str = "选择🧪组";
const PROXY_NAME: &str = "合成🌌节点";

#[tokio::test]
async fn reads_all_supported_endpoints_from_the_pinned_core() {
    let Some(binary) = env::var_os("MIHOMO_BIN").map(PathBuf::from) else {
        eprintln!("skipped: set MIHOMO_BIN to opt in to the pinned real-core test");
        return;
    };
    assert!(binary.is_file(), "MIHOMO_BIN did not point to a file");

    let controller_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let controller_address = controller_listener.local_addr().unwrap();
    drop(controller_listener);

    let scratch = scratch_directory(controller_address.port());
    fs::create_dir_all(&scratch).unwrap();
    let config_path = scratch.join("config.yaml");
    fs::write(&config_path, synthetic_config()).unwrap();

    let child = Command::new(binary)
        .args(["-d"])
        .arg(&scratch)
        .args(["-f"])
        .arg(&config_path)
        .args([
            "-ext-ctl",
            &controller_address.to_string(),
            "-secret",
            SECRET,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut core = CoreProcess(child);

    let mut transport_config =
        HttpTransportConfig::new(Url::parse(&format!("http://{controller_address}/")).unwrap());
    transport_config.secret = Some(SECRET.into());
    transport_config.connect_timeout = Duration::from_secs(2);
    transport_config.request_timeout = Duration::from_secs(2);
    let transport = Arc::new(HttpTransport::new(transport_config).unwrap());
    let client = ControllerClient::new(transport, ControllerLimits::default()).unwrap();

    wait_until_ready(&client, &mut core).await;
    assert_eq!(client.verify_version().await.unwrap().version, "v1.19.29");

    let config = client.runtime_config().await.unwrap();
    assert_eq!(config.mode, RoutingMode::Rule);
    assert!(!config.allow_lan);
    assert!(!config.tun.enable);
    assert_eq!(config.mixed_port, 0);

    let catalog = client.proxies().await.unwrap();
    let group = catalog.proxies[GROUP_NAME].group().unwrap();
    assert_eq!(group.selected, Some(PROXY_NAME));
    assert_eq!(group.children, &[PROXY_NAME, "DIRECT", "REJECT"]);
    assert_eq!(catalog.proxies[PROXY_NAME].name, PROXY_NAME);

    let rules = client.rules().await.unwrap();
    assert_eq!(rules.rules.len(), 2);
    assert_eq!(rules.rules[0].kind, "DomainSuffix");
    assert_eq!(rules.rules[0].payload, "fixture.invalid");
    assert_eq!(rules.rules[0].proxy, GROUP_NAME);

    let traffic = client.traffic_snapshot().await.unwrap();
    assert_eq!((traffic.up, traffic.down), (0, 0));
    assert_eq!((traffic.up_total, traffic.down_total), (0, 0));

    let mut memory_stream = client.memory_stream().await.unwrap();
    let first_memory = memory_stream.next().await.unwrap().unwrap();
    assert_eq!(first_memory.inuse, 0);
    assert_eq!(first_memory.oslimit, 0);
    memory_stream.cancel();

    let connections = client.connections().await.unwrap();
    assert!(connections.connections.is_empty());

    let mut connection_stream = client.connection_stream().await.unwrap();
    let streamed_connections = connection_stream.next().await.unwrap().unwrap();
    assert!(streamed_connections.connections.is_empty());
    connection_stream.cancel();
}

async fn wait_until_ready(client: &ControllerClient, core: &mut CoreProcess) {
    for _ in 0..100 {
        if let Some(status) = core.0.try_wait().unwrap() {
            panic!("pinned Mihomo exited before its Controller was ready: {status}");
        }
        if client.version().await.is_ok() {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("pinned Mihomo Controller did not become ready");
}

fn scratch_directory(port: u16) -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.parent().unwrap().parent().unwrap();
    workspace
        .join(".scratch/mihomo/real-core-test")
        .join(format!("{}-{port}", std::process::id()))
}

fn synthetic_config() -> &'static str {
    r#"port: 0
socks-port: 0
redir-port: 0
tproxy-port: 0
mixed-port: 0
allow-lan: false
bind-address: 127.0.0.1
mode: rule
log-level: silent
ipv6: false
tcp-concurrent: false
find-process-mode: off
unified-delay: false

profile:
  store-selected: false
  store-fake-ip: false

dns:
  enable: false

tun:
  enable: false

proxies:
  - name: "合成🌌节点"
    type: direct
    udp: true

proxy-groups:
  - name: "选择🧪组"
    type: select
    proxies:
      - "合成🌌节点"
      - DIRECT
      - REJECT

rules:
  - DOMAIN-SUFFIX,fixture.invalid,选择🧪组
  - MATCH,DIRECT
"#
}

struct CoreProcess(Child);

impl Drop for CoreProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
