use std::{
    env, fs,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener as StdTcpListener, UdpSocket as StdUdpSocket},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::future::{BoxFuture, ready};
use mish_bridge::{ControllerObservationConfig, ControllerStatusSource, ProfileMappingContext};
use mish_mihomo_controller::{
    ControllerClient, ControllerError, ControllerLimits, HttpTransport, HttpTransportConfig,
};
use mish_runtime::{
    CoreError, CoreLifecycleCommand, CoreLifecycleMutation, CoreLifecycleOperation, CorePhase,
    CoreRuntime, CoreStatus, GroupSelectionCleanupMode, GroupSelectionCleanupPhase, MishRuntime,
    PolicyGroupConnectionCleanupPreference, StatusAdapterKind, StatusCommand, StatusDataSource,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    task::JoinHandle,
    time::{sleep, timeout},
};
use url::Url;

const SECRET: &str = "real-cleanup-controller-secret";
const SELECT_GROUP: &str = "SELECT-CLEANUP";
const OTHER_GROUP: &str = "OTHER-CLEANUP";
const OLD_CHILD: &str = "old-direct";
const NEW_CHILD: &str = "new-direct";

fn core_operation() -> CoreLifecycleOperation {
    CoreLifecycleOperation::new("real-cleanup-test", 1, "shutdown", 1, 1).unwrap()
}

struct ExternalCoreLifecycle {
    stopped: AtomicBool,
}

impl ExternalCoreLifecycle {
    fn status(&self) -> CoreStatus {
        CoreStatus {
            error: None,
            phase: if self.stopped.load(Ordering::Acquire) {
                CorePhase::Stopped
            } else {
                CorePhase::Running
            },
            pid: None,
            version: Some("v1.19.29".into()),
        }
    }
}

impl CoreRuntime for ExternalCoreLifecycle {
    fn configured(&self) -> bool {
        true
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        Box::pin(ready(self.status()))
    }

    fn execute_lifecycle(
        &self,
        command: CoreLifecycleCommand,
    ) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        self.stopped.store(
            command.mutation() == CoreLifecycleMutation::Stop,
            Ordering::Release,
        );
        Box::pin(ready(Ok(self.status())))
    }
}

#[tokio::test]
async fn pinned_core_closes_only_old_direct_child_tcp_and_udp_trackers() {
    let Some(binary) = env::var_os("MIHOMO_BIN").map(PathBuf::from) else {
        eprintln!("skipped: set MIHOMO_BIN to opt in to the pinned real-core cleanup test");
        return;
    };
    assert!(binary.is_file(), "MIHOMO_BIN did not point to a file");

    let selected_tcp = TcpEchoServer::start().await;
    let unrelated_tcp = TcpEchoServer::start().await;
    let selected_udp = UdpEchoServer::start().await;
    let controller_address = reserve_tcp_address();
    let mixed_address = reserve_tcp_address();
    let scratch = TempDir::new().unwrap();
    let config_path = scratch.path().join("config.yaml");
    fs::write(
        &config_path,
        real_core_config(
            mixed_address.port(),
            selected_tcp.address.port(),
            unrelated_tcp.address.port(),
            selected_udp.address.port(),
        ),
    )
    .unwrap();
    let child = Command::new(binary)
        .args(["-d"])
        .arg(scratch.path())
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
    let client = controller_client(controller_address);
    wait_until_ready(&client, &mut core).await;
    assert_eq!(client.verify_version().await.unwrap().version, "v1.19.29");

    verify_real_group_put_semantics(&client).await;

    let cleanup_preference = PolicyGroupConnectionCleanupPreference::default();
    cleanup_preference.set_enabled(true);
    let profile =
        ProfileMappingContext::new("real-cleanup", "sha256:real-cleanup", "Real cleanup").unwrap();
    let mut observation = ControllerObservationConfig::new(
        Url::parse(&format!("http://{controller_address}/")).unwrap(),
        profile,
    );
    observation.secret = Some(SECRET.into());
    observation.connect_timeout = Duration::from_secs(1);
    observation.request_timeout = Duration::from_secs(2);
    observation.refresh_interval = Duration::from_secs(5);
    observation.reconnect_delay = Duration::from_millis(20);
    observation.confirmation_timeout = Duration::from_secs(2);
    observation.connection_cleanup_preference = cleanup_preference.clone();
    observation.cleanup_interval = Duration::from_millis(50);
    observation.cleanup_timeout = Duration::from_secs(1);
    observation.cleanup_quiet_scans = 4;
    let lifecycle = Arc::new(ExternalCoreLifecycle {
        stopped: AtomicBool::new(false),
    });
    let source = ControllerStatusSource::new(observation, lifecycle.clone()).unwrap();
    let runtime = Arc::new(MishRuntime::with_data_sources_and_events(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
    ));
    source.start().await;
    wait_for(Duration::from_secs(3), || {
        source.supports_command(StatusCommand::Group)
    })
    .await;

    let mut old_tcp = open_http_tunnel(mixed_address, selected_tcp.address).await;
    assert_tunnel_alive(&mut old_tcp, b'o').await;
    let mut unrelated = open_http_tunnel(mixed_address, unrelated_tcp.address).await;
    assert_tunnel_alive(&mut unrelated, b'u').await;
    let (_udp_control, udp_socket, udp_relay) =
        open_socks_udp_association(mixed_address, selected_udp.address).await;
    assert_udp_alive(&udp_socket, udp_relay, selected_udp.address, b"old-udp").await;

    let before = wait_for_connections(&client, 3).await;
    let old_tcp_id = connection_id(&before, "tcp", selected_tcp.address.port(), SELECT_GROUP);
    let old_udp_id = connection_id(&before, "udp", selected_udp.address.port(), SELECT_GROUP);
    let unrelated_id = connection_id(&before, "tcp", unrelated_tcp.address.port(), OTHER_GROUP);
    let snapshot = runtime.status_snapshot_typed(StatusAdapterKind::Rpc).await;
    let group_id = snapshot
        .groups
        .iter()
        .find(|group| group.label == SELECT_GROUP)
        .unwrap()
        .id
        .clone();
    let old_child_id = snapshot
        .nodes
        .iter()
        .find(|node| node.label == OLD_CHILD)
        .unwrap()
        .id
        .clone();
    let new_child_id = snapshot
        .nodes
        .iter()
        .find(|node| node.label == NEW_CHILD)
        .unwrap()
        .id
        .clone();

    let switching_runtime = runtime.clone();
    let switching_group = group_id.clone();
    let switch = tokio::spawn(async move {
        switching_runtime
            .select_group_child_typed(switching_group, new_child_id, StatusAdapterKind::Rpc)
            .await
    });
    wait_for_async(Duration::from_secs(2), || async {
        client.proxies().await.ok().is_some_and(|catalog| {
            catalog.proxies[SELECT_GROUP]
                .group()
                .and_then(|group| group.selected)
                == Some(NEW_CHILD)
        })
    })
    .await;
    let mut new_tcp = open_http_tunnel(mixed_address, selected_tcp.address).await;
    assert_tunnel_alive(&mut new_tcp, b'n').await;
    let selected = switch.await.unwrap().unwrap();
    let cleanup = selected.group_selection_operation;
    assert!(cleanup.selection_confirmed);
    assert_eq!(
        cleanup.cleanup_mode,
        GroupSelectionCleanupMode::OldDirectChild
    );
    assert_eq!(cleanup.cleanup_phase, GroupSelectionCleanupPhase::Completed);
    assert_eq!(cleanup.target_count, 2);
    assert_eq!(cleanup.closed_count, 2);
    assert_eq!(cleanup.failed_count, 0);

    let after = client.connections().await.unwrap();
    assert!(
        !after
            .connections
            .iter()
            .any(|connection| { connection.id == old_tcp_id || connection.id == old_udp_id })
    );
    assert!(
        after
            .connections
            .iter()
            .any(|connection| connection.id == unrelated_id)
    );
    let new_tcp_id = connection_id(&after, "tcp", selected_tcp.address.port(), SELECT_GROUP);
    assert_tunnel_closed(&mut old_tcp).await;
    assert_tunnel_alive(&mut unrelated, b'v').await;
    assert_tunnel_alive(&mut new_tcp, b'w').await;

    cleanup_preference.set_enabled(false);
    let selected = runtime
        .select_group_child_typed(group_id, old_child_id, StatusAdapterKind::Rpc)
        .await
        .unwrap();
    assert_eq!(
        selected.group_selection_operation.cleanup_mode,
        GroupSelectionCleanupMode::Off
    );
    assert_eq!(
        selected.group_selection_operation.cleanup_phase,
        GroupSelectionCleanupPhase::Skipped
    );
    assert!(
        client
            .connections()
            .await
            .unwrap()
            .connections
            .iter()
            .any(|connection| connection.id == new_tcp_id)
    );
    assert_tunnel_alive(&mut new_tcp, b'x').await;

    client.close_connection(&new_tcp_id).await.unwrap();
    wait_for_async(Duration::from_secs(2), || async {
        client.connections().await.is_ok_and(|snapshot| {
            !snapshot
                .connections
                .iter()
                .any(|connection| connection.id == new_tcp_id)
                && snapshot
                    .connections
                    .iter()
                    .any(|connection| connection.id == unrelated_id)
        })
    })
    .await;
    assert_tunnel_closed(&mut new_tcp).await;
    assert_tunnel_alive(&mut unrelated, b'y').await;

    runtime.shutdown(&core_operation()).await.unwrap();
}

async fn verify_real_group_put_semantics(client: &ControllerClient) {
    for (group, child) in [("INNER-CLEANUP", NEW_CHILD), ("OUTER-CLEANUP", NEW_CHILD)] {
        client.select_group_child(group, child).await.unwrap();
        assert_eq!(
            client.proxies().await.unwrap().proxies[group]
                .group()
                .unwrap()
                .selected,
            Some(child)
        );
    }
    for group in ["URL-CLEANUP", "FALLBACK-CLEANUP"] {
        let result = client.select_group_child(group, NEW_CHILD).await;
        let observed = client.proxies().await.unwrap().proxies[group]
            .group()
            .unwrap()
            .selected
            .map(str::to_owned);
        match result {
            Ok(()) if observed.as_deref() == Some(NEW_CHILD) => {
                eprintln!("{group}: manual PUT selection is supported");
            }
            Ok(()) => {
                assert_eq!(observed.as_deref(), Some(OLD_CHILD));
                eprintln!("{group}: Core returned success but did not confirm manual selection");
            }
            Err(ControllerError::HttpStatus { status, .. }) => {
                assert!([400, 404, 405].contains(&status))
            }
            Err(error) => panic!("unexpected {group} PUT result: {error}"),
        }
    }
    let load_result = client.select_group_child("LOAD-CLEANUP", NEW_CHILD).await;
    let load_selected = client.proxies().await.unwrap().proxies["LOAD-CLEANUP"]
        .group()
        .unwrap()
        .selected
        .map(str::to_owned);
    assert_ne!(load_selected.as_deref(), Some(NEW_CHILD));
    if let Err(error) = load_result {
        assert!(matches!(error, ControllerError::HttpStatus { .. }));
    } else {
        eprintln!("LOAD-CLEANUP: Core returned success but rejected the requested selection");
    }
}

fn controller_client(address: SocketAddr) -> ControllerClient {
    let mut config = HttpTransportConfig::new(Url::parse(&format!("http://{address}/")).unwrap());
    config.secret = Some(SECRET.into());
    config.connect_timeout = Duration::from_secs(1);
    config.request_timeout = Duration::from_secs(2);
    let transport = Arc::new(HttpTransport::new(config).unwrap());
    ControllerClient::new(transport, ControllerLimits::default()).unwrap()
}

async fn wait_until_ready(client: &ControllerClient, core: &mut CoreProcess) {
    for _ in 0..200 {
        if let Some(status) = core.0.try_wait().unwrap() {
            panic!("pinned Mihomo exited before its Controller was ready: {status}");
        }
        if client.version().await.is_ok() {
            return;
        }
        sleep(Duration::from_millis(25)).await;
    }
    panic!("pinned Mihomo Controller did not become ready");
}

async fn wait_for(duration: Duration, predicate: impl Fn() -> bool) {
    timeout(duration, async {
        while !predicate() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_async<F, Fut>(duration: Duration, mut predicate: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    timeout(duration, async {
        while !predicate().await {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_connections(
    client: &ControllerClient,
    minimum: usize,
) -> mish_mihomo_controller::ConnectionSnapshot {
    timeout(Duration::from_secs(3), async {
        loop {
            let snapshot = client.connections().await.unwrap();
            if snapshot.connections.len() >= minimum {
                return snapshot;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

fn connection_id(
    snapshot: &mish_mihomo_controller::ConnectionSnapshot,
    network: &str,
    destination_port: u16,
    group: &str,
) -> String {
    let connection = snapshot
        .connections
        .iter()
        .find(|connection| {
            connection.metadata.network.eq_ignore_ascii_case(network)
                && connection.metadata.destination_port == destination_port
        })
        .unwrap_or_else(|| {
            panic!(
                "missing {network} connection to {destination_port}: {:?}",
                snapshot.connections
            )
        });
    assert_eq!(
        connection.chains.last().map(String::as_str),
        Some(group),
        "Core chain direction changed"
    );
    connection.id.clone()
}

async fn open_http_tunnel(proxy: SocketAddr, destination: SocketAddr) -> TcpStream {
    let mut stream = TcpStream::connect(proxy).await.unwrap();
    stream
        .write_all(
            format!(
                "CONNECT {destination} HTTP/1.1\r\nHost: {destination}\r\nProxy-Connection: keep-alive\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    let mut byte = [0_u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        assert!(
            response.len() < 4_096,
            "HTTP CONNECT response was unbounded"
        );
        stream.read_exact(&mut byte).await.unwrap();
        response.push(byte[0]);
    }
    assert!(
        response.starts_with(b"HTTP/1.1 200") || response.starts_with(b"HTTP/1.0 200"),
        "HTTP CONNECT failed: {}",
        String::from_utf8_lossy(&response)
    );
    stream
}

async fn assert_tunnel_alive(stream: &mut TcpStream, byte: u8) {
    stream.write_all(&[byte]).await.unwrap();
    let mut echoed = [0_u8; 1];
    timeout(Duration::from_secs(1), stream.read_exact(&mut echoed))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(echoed[0], byte);
}

async fn assert_tunnel_closed(stream: &mut TcpStream) {
    let mut byte = [0_u8; 1];
    let result = timeout(Duration::from_secs(2), stream.read(&mut byte))
        .await
        .expect("closed tunnel stayed open");
    assert!(matches!(result, Err(_) | Ok(0)));
}

async fn open_socks_udp_association(
    proxy: SocketAddr,
    destination: SocketAddr,
) -> (TcpStream, UdpSocket, SocketAddr) {
    let mut control = TcpStream::connect(proxy).await.unwrap();
    control.write_all(&[5, 1, 0]).await.unwrap();
    let mut greeting = [0_u8; 2];
    control.read_exact(&mut greeting).await.unwrap();
    assert_eq!(greeting, [5, 0]);
    control
        .write_all(&[5, 3, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .unwrap();
    let mut header = [0_u8; 4];
    control.read_exact(&mut header).await.unwrap();
    assert_eq!(&header[..2], &[5, 0]);
    let relay_ip = match header[3] {
        1 => {
            let mut address = [0_u8; 4];
            control.read_exact(&mut address).await.unwrap();
            IpAddr::V4(Ipv4Addr::from(address))
        }
        other => panic!("unsupported SOCKS UDP relay address type {other}"),
    };
    let mut port = [0_u8; 2];
    control.read_exact(&mut port).await.unwrap();
    let relay = SocketAddr::new(
        if relay_ip.is_unspecified() {
            proxy.ip()
        } else {
            relay_ip
        },
        u16::from_be_bytes(port),
    );
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    assert_eq!(destination.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    (control, socket, relay)
}

async fn assert_udp_alive(
    socket: &UdpSocket,
    relay: SocketAddr,
    destination: SocketAddr,
    payload: &[u8],
) {
    let mut packet = vec![0, 0, 0, 1, 127, 0, 0, 1];
    packet.extend_from_slice(&destination.port().to_be_bytes());
    packet.extend_from_slice(payload);
    socket.send_to(&packet, relay).await.unwrap();
    let mut response = [0_u8; 512];
    let (size, _) = timeout(Duration::from_secs(2), socket.recv_from(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(size >= 10 + payload.len());
    assert_eq!(&response[size - payload.len()..size], payload);
}

fn reserve_tcp_address() -> SocketAddr {
    let listener = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    address
}

fn reserve_udp_port() -> u16 {
    let socket = StdUdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = socket.local_addr().unwrap().port();
    drop(socket);
    port
}

struct TcpEchoServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl TcpEchoServer {
    async fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 512];
                    loop {
                        let Ok(size) = stream.read(&mut buffer).await else {
                            return;
                        };
                        if size == 0 || stream.write_all(&buffer[..size]).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Self { address, task }
    }
}

impl Drop for TcpEchoServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct UdpEchoServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl UdpEchoServer {
    async fn start() -> Self {
        let port = reserve_udp_port();
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        let address = socket.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut buffer = [0_u8; 512];
            loop {
                let Ok((size, peer)) = socket.recv_from(&mut buffer).await else {
                    return;
                };
                if socket.send_to(&buffer[..size], peer).await.is_err() {
                    return;
                }
            }
        });
        Self { address, task }
    }
}

impl Drop for UdpEchoServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct CoreProcess(Child);

impl Drop for CoreProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn real_core_config(
    mixed_port: u16,
    selected_tcp_port: u16,
    unrelated_tcp_port: u16,
    selected_udp_port: u16,
) -> String {
    format!(
        r#"port: 0
socks-port: 0
redir-port: 0
tproxy-port: 0
mixed-port: {mixed_port}
allow-lan: false
bind-address: 127.0.0.1
mode: rule
log-level: silent
ipv6: false
find-process-mode: off

profile:
  store-selected: false
  store-fake-ip: false

dns:
  enable: false

tun:
  enable: false

proxies:
  - name: "{OLD_CHILD}"
    type: direct
    udp: true
  - name: "{NEW_CHILD}"
    type: direct
    udp: true

proxy-groups:
  - name: "{SELECT_GROUP}"
    type: select
    proxies: ["{OLD_CHILD}", "{NEW_CHILD}"]
  - name: "{OTHER_GROUP}"
    type: select
    proxies: ["{OLD_CHILD}", "{NEW_CHILD}"]
  - name: "INNER-CLEANUP"
    type: select
    proxies: ["{OLD_CHILD}", "{NEW_CHILD}"]
  - name: "OUTER-CLEANUP"
    type: select
    proxies: ["INNER-CLEANUP", "{NEW_CHILD}"]
  - name: "URL-CLEANUP"
    type: url-test
    proxies: ["{OLD_CHILD}", "{NEW_CHILD}"]
    url: "http://127.0.0.1:1/"
    interval: 3600
    lazy: true
  - name: "FALLBACK-CLEANUP"
    type: fallback
    proxies: ["{OLD_CHILD}", "{NEW_CHILD}"]
    url: "http://127.0.0.1:1/"
    interval: 3600
    lazy: true
  - name: "LOAD-CLEANUP"
    type: load-balance
    proxies: ["{OLD_CHILD}", "{NEW_CHILD}"]
    url: "http://127.0.0.1:1/"
    interval: 3600
    strategy: round-robin

rules:
  - DST-PORT,{selected_tcp_port},{SELECT_GROUP}
  - DST-PORT,{selected_udp_port},{SELECT_GROUP}
  - DST-PORT,{unrelated_tcp_port},{OTHER_GROUP}
  - MATCH,DIRECT
"#
    )
}
