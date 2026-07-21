use std::{
    fs,
    net::IpAddr,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use futures_util::future::BoxFuture;
use mish_bridge::{
    PrivilegedCoreHost, PrivilegedCoreHostError, PrivilegedCoreLaunchRequest, PrivilegedCoreProcess,
};
use mish_runtime::{
    LoopbackProxyEndpoint, TUN_HELPER_EXPECTED_VERSION, TUN_HELPER_MAX_MESSAGE_BYTES,
    TUN_HELPER_PROTOCOL_VERSION, TunHelperAvailability, TunHelperError, TunHelperFailureKind,
    TunHelperHealth, TunHelperLifecycleOperation, TunHelperObservation, TunHelperPlatform,
    TunHelperSnapshot, TunNetworkObservation, TunObservationComponentState, tun_observation_now,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    process::{Child, Command},
    sync::Mutex,
    time::timeout,
};

use crate::{MacOsCommand, MacOsCommandRunner, MacOsSystemCommandRunner};

pub const DEV_TUN_SERVICE_LABEL: &str = "com.asuka109.mish.tun-helper.dev";
pub const DEV_TUN_SERVICE_CORE_PATH: &str =
    "/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev";
pub const DEV_TUN_SERVICE_HELPER_PATH: &str =
    "/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev";
pub const DEV_TUN_SERVICE_PLIST_PATH: &str =
    "/Library/LaunchDaemons/com.asuka109.mish.tun-helper.dev.plist";
pub const DEV_TUN_SERVICE_SOCKET_PREFIX: &str = "/var/run/com.asuka109.mish.tun-helper";
const CONFIG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const TUN_INTERFACE_LIMIT: usize = 128;
const TUN_ROUTE_LIMIT: usize = 512;
const TUN_DNS_RESOLVER_LIMIT: usize = 64;
const TUN_DNS_NAMESERVER_LIMIT: usize = 8;
const TUN_OWNED_INTERFACE_LIMIT: usize = 4;
#[cfg(target_os = "macos")]
const PROCESS_FD_LIMIT: usize = 4_096;

pub fn development_socket_path(uid: u32) -> PathBuf {
    PathBuf::from(format!("{DEV_TUN_SERVICE_SOCKET_PREFIX}.{uid}.sock"))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceRequest {
    command: ServiceCommand,
    protocol_version: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum ServiceCommand {
    Health,
    Observe {
        launch_token: String,
    },
    OwnsListener {
        host: String,
        launch_token: String,
        port: u16,
    },
    Start {
        binary: PathBuf,
        config_directory: PathBuf,
        config_file: PathBuf,
        expected_version: String,
        launch_token: String,
    },
    Stop {
        launch_token: String,
    },
    StopAll,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceResponse {
    error: Option<ServiceErrorCode>,
    ok: bool,
    status: ServiceStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ServiceErrorCode {
    InvalidRequest,
    Rejected,
    OperationFailed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceStatus {
    core: Option<ServiceCoreStatus>,
    helper_version: String,
    installation_id: String,
    observation: TunNetworkObservation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceCoreStatus {
    launch_token: String,
    pid: u32,
}

impl From<ServiceCoreStatus> for PrivilegedCoreProcess {
    fn from(status: ServiceCoreStatus) -> Self {
        Self::new(status.pid, status.launch_token)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TunSystemInterface {
    addresses: Vec<String>,
    name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TunSystemRoute {
    destination: String,
    interface: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TunSystemDnsResolver {
    interface: Option<String>,
    nameservers: Vec<IpAddr>,
    port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TunSystemSnapshot {
    dns_resolvers: Vec<TunSystemDnsResolver>,
    interfaces: Vec<TunSystemInterface>,
    routes: Vec<TunSystemRoute>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OwnedTunSocket {
    interface: String,
    socket: u64,
}

trait TunSystemObserver: Send + Sync {
    fn observe(&self) -> BoxFuture<'_, Result<TunSystemSnapshot, ()>>;

    fn owned_utun_sockets(&self, pid: u32) -> Result<Vec<OwnedTunSocket>, ()>;
}

struct MacOsTunSystemObserver {
    runner: Arc<dyn MacOsCommandRunner>,
}

impl MacOsTunSystemObserver {
    fn new() -> Self {
        Self {
            runner: Arc::new(MacOsSystemCommandRunner),
        }
    }
}

impl TunSystemObserver for MacOsTunSystemObserver {
    fn observe(&self) -> BoxFuture<'_, Result<TunSystemSnapshot, ()>> {
        Box::pin(async move {
            let (interfaces, routes, dns) = tokio::try_join!(
                self.runner.run(MacOsCommand::InterfaceConfiguration),
                self.runner.run(MacOsCommand::RoutingTable),
                self.runner.run(MacOsCommand::DnsConfiguration),
            )
            .map_err(|_| ())?;
            let dns_resolvers = parse_tun_dns_resolvers(&dns.stdout)?;
            Ok(TunSystemSnapshot {
                dns_resolvers,
                interfaces: parse_tun_interfaces(&interfaces.stdout)?,
                routes: parse_tun_routes(&routes.stdout)?,
            })
        })
    }

    fn owned_utun_sockets(&self, pid: u32) -> Result<Vec<OwnedTunSocket>, ()> {
        process_owned_utun_sockets(pid)
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct ProcessFdInfo {
    fd: i32,
    fd_type: u32,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcessFileInfo {
    open_flags: u32,
    status: u32,
    offset: i64,
    file_type: i32,
    guard_flags: u32,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct SocketBufferInfo {
    byte_count: u32,
    high_watermark: u32,
    memory_byte_count: u32,
    max_memory_byte_count: u32,
    low_watermark: u32,
    flags: i16,
    timeout: i16,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct SocketInfoHeader {
    stat: libc::vinfo_stat,
    socket: u64,
    protocol_control_block: u64,
    socket_type: i32,
    protocol: i32,
    family: i32,
    options: i16,
    linger: i16,
    state: i16,
    queue_length: i16,
    incomplete_queue_length: i16,
    queue_limit: i16,
    timeout: i16,
    error: u16,
    out_of_band_mark: u32,
    receive: SocketBufferInfo,
    send: SocketBufferInfo,
    kind: i32,
    reserved: u32,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct KernelControlInfo {
    id: u32,
    registered_unit: u32,
    flags: u32,
    receive_buffer_size: u32,
    send_buffer_size: u32,
    unit: u32,
    name: [libc::c_char; libc::MAX_KCTL_NAME],
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct SocketFdInfoBuffer {
    file: ProcessFileInfo,
    socket: SocketInfoHeader,
    kernel_control: KernelControlInfo,
    protocol_storage: [u64; 128],
}

#[cfg(target_os = "macos")]
fn process_owned_utun_sockets(pid: u32) -> Result<Vec<OwnedTunSocket>, ()> {
    const SOCKET_FD_TYPE: u32 = 2;
    const KERNEL_CONTROL_SOCKET_KIND: i32 = 6;
    const SYSTEM_SOCKET_FAMILY: i32 = 32;
    const KERNEL_CONTROL_PROTOCOL: i32 = 2;
    const PID_LIST_FDS: i32 = 1;
    const PID_FD_SOCKET_INFO: i32 = 3;
    const UTUN_CONTROL_NAME: &[u8] = b"com.apple.net.utun_control";

    let mut fds = vec![ProcessFdInfo { fd: -1, fd_type: 0 }; PROCESS_FD_LIMIT];
    // SAFETY: the buffer is writable for the supplied size and the PID belongs to the
    // unreaped child held by the service while this bounded inspection runs.
    let bytes = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            PID_LIST_FDS,
            0,
            fds.as_mut_ptr().cast(),
            std::mem::size_of_val(fds.as_slice()) as i32,
        )
    };
    if bytes < 0
        || !(bytes as usize).is_multiple_of(std::mem::size_of::<ProcessFdInfo>())
        || bytes as usize == std::mem::size_of_val(fds.as_slice())
    {
        return Err(());
    }
    fds.truncate(bytes as usize / std::mem::size_of::<ProcessFdInfo>());

    let mut sockets = Vec::new();
    for fd in fds.into_iter().filter(|fd| fd.fd_type == SOCKET_FD_TYPE) {
        // SAFETY: all-zero is a valid byte representation for these C observation
        // structures, which contain only integer fields and fixed-size arrays.
        let mut info = unsafe { std::mem::zeroed::<SocketFdInfoBuffer>() };
        // SAFETY: info is writable for the supplied size. A descriptor that closes
        // concurrently is ignored because only a successfully returned live utun
        // socket can establish ownership.
        let returned = unsafe {
            libc::proc_pidfdinfo(
                pid as i32,
                fd.fd,
                PID_FD_SOCKET_INFO,
                (&mut info as *mut SocketFdInfoBuffer).cast(),
                std::mem::size_of::<SocketFdInfoBuffer>() as i32,
            )
        };
        let required = std::mem::offset_of!(SocketFdInfoBuffer, protocol_storage);
        if returned < required as i32
            || info.socket.kind != KERNEL_CONTROL_SOCKET_KIND
            || info.socket.family != SYSTEM_SOCKET_FAMILY
            || info.socket.protocol != KERNEL_CONTROL_PROTOCOL
            || info.socket.socket == 0
        {
            continue;
        }
        let name = info
            .kernel_control
            .name
            .iter()
            .map(|byte| *byte as u8)
            .take_while(|byte| *byte != 0)
            .collect::<Vec<_>>();
        if name != UTUN_CONTROL_NAME || info.kernel_control.unit == 0 {
            continue;
        }
        if !sockets
            .iter()
            .any(|socket: &OwnedTunSocket| socket.socket == info.socket.socket)
        {
            if sockets.len() >= TUN_OWNED_INTERFACE_LIMIT {
                return Err(());
            }
            sockets.push(OwnedTunSocket {
                interface: format!("utun{}", info.kernel_control.unit - 1),
                socket: info.socket.socket,
            });
        }
    }
    sockets.sort_by(|left, right| {
        left.interface
            .cmp(&right.interface)
            .then(left.socket.cmp(&right.socket))
    });
    Ok(sockets)
}

#[cfg(not(target_os = "macos"))]
fn process_owned_utun_sockets(_pid: u32) -> Result<Vec<OwnedTunSocket>, ()> {
    Err(())
}

fn parse_tun_interfaces(output: &str) -> Result<Vec<TunSystemInterface>, ()> {
    let mut interfaces = Vec::<TunSystemInterface>::new();
    for line in output.lines() {
        if !line.starts_with([' ', '\t']) {
            let Some((candidate, rest)) = line.split_once(':') else {
                continue;
            };
            if !rest.trim_start().starts_with("flags=") || !valid_interface_name(candidate) {
                return Err(());
            }
            if interfaces.len() >= TUN_INTERFACE_LIMIT {
                return Err(());
            }
            interfaces.push(TunSystemInterface {
                addresses: Vec::new(),
                name: candidate.to_owned(),
            });
            continue;
        }
        let Some(interface) = interfaces.last_mut() else {
            continue;
        };
        let mut fields = line.split_ascii_whitespace();
        let Some(family) = fields.next() else {
            continue;
        };
        if !matches!(family, "inet" | "inet6") {
            continue;
        }
        let Some(address) = fields.next() else {
            return Err(());
        };
        let address = address
            .split('%')
            .next()
            .ok_or(())?
            .parse::<IpAddr>()
            .map_err(|_| ())?
            .to_string();
        if interface.addresses.len() >= 8 {
            return Err(());
        }
        if !interface.addresses.contains(&address) {
            interface.addresses.push(address);
        }
    }
    if interfaces.is_empty() {
        return Err(());
    }
    Ok(interfaces)
}

fn parse_tun_routes(output: &str) -> Result<Vec<TunSystemRoute>, ()> {
    if !output.lines().any(|line| line.trim() == "Routing tables") {
        return Err(());
    }
    let mut routes = Vec::new();
    for line in output.lines() {
        let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
        if fields.len() < 4
            || matches!(
                fields[0],
                "Destination" | "Routing" | "Internet:" | "Internet6:"
            )
        {
            continue;
        }
        let interface = fields[3];
        if !valid_interface_name(interface) || fields[0].len() > 64 {
            continue;
        }
        if routes.len() >= TUN_ROUTE_LIMIT {
            return Err(());
        }
        routes.push(TunSystemRoute {
            destination: fields[0].to_owned(),
            interface: interface.to_owned(),
        });
    }
    Ok(routes)
}

fn parse_tun_dns_resolvers(output: &str) -> Result<Vec<TunSystemDnsResolver>, ()> {
    if matches!(
        output.trim(),
        "DNS configuration not available" | "No DNS configuration available"
    ) {
        return Ok(Vec::new());
    }
    if !output
        .lines()
        .any(|line| line.trim() == "DNS configuration")
    {
        return Err(());
    }
    let mut resolvers = Vec::new();
    let mut current: Option<TunSystemDnsResolver> = None;
    let finish_resolver = |resolvers: &mut Vec<TunSystemDnsResolver>,
                           current: &mut Option<TunSystemDnsResolver>|
     -> Result<(), ()> {
        let Some(resolver) = current.take() else {
            return Ok(());
        };
        if resolver.nameservers.is_empty() || resolvers.contains(&resolver) {
            return Ok(());
        }
        if resolvers.len() >= TUN_DNS_RESOLVER_LIMIT {
            return Err(());
        }
        resolvers.push(resolver);
        Ok(())
    };
    for line in output.lines().map(str::trim) {
        if line.starts_with("resolver #") {
            finish_resolver(&mut resolvers, &mut current)?;
            current = Some(TunSystemDnsResolver {
                interface: None,
                nameservers: Vec::new(),
                port: 53,
            });
            continue;
        }
        if line.starts_with("nameserver[") {
            let resolver = current.as_mut().ok_or(())?;
            let value = line
                .split_once(':')
                .map(|(_, value)| value.trim())
                .ok_or(())?;
            let value = value.split('%').next().ok_or(())?;
            let nameserver = value.parse::<IpAddr>().map_err(|_| ())?;
            if !resolver.nameservers.contains(&nameserver) {
                if resolver.nameservers.len() >= TUN_DNS_NAMESERVER_LIMIT {
                    return Err(());
                }
                resolver.nameservers.push(nameserver);
            }
            continue;
        }
        if line.starts_with("if_index") {
            let resolver = current.as_mut().ok_or(())?;
            let candidate = line
                .split_once('(')
                .and_then(|(_, value)| value.strip_suffix(')'))
                .map(str::trim)
                .ok_or(())?;
            if !valid_interface_name(candidate) {
                return Err(());
            }
            resolver.interface = Some(candidate.to_owned());
            continue;
        }
        if line.starts_with("port") {
            let resolver = current.as_mut().ok_or(())?;
            resolver.port = line
                .split_once(':')
                .map(|(_, value)| value.trim())
                .ok_or(())?
                .parse::<u16>()
                .ok()
                .filter(|port| *port != 0)
                .ok_or(())?;
        }
    }
    finish_resolver(&mut resolvers, &mut current)?;
    Ok(resolvers)
}

fn valid_interface_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn dns_observation_state(
    system: &TunSystemSnapshot,
    owned_interface: &str,
) -> TunObservationComponentState {
    let mut captured = 0;
    let mut bypassed = 0;
    let mut unknown = 0;
    for resolver in system
        .dns_resolvers
        .iter()
        .filter(|resolver| resolver.port == 53)
    {
        for nameserver in &resolver.nameservers {
            match resolver.interface.as_deref() {
                Some(interface) if interface == owned_interface => captured += 1,
                _ => match selected_route_interface(&system.routes, *nameserver) {
                    Some(interface) if interface == owned_interface => captured += 1,
                    Some(_) => bypassed += 1,
                    None => unknown += 1,
                },
            }
        }
    }
    match (captured, bypassed, unknown) {
        (0, 0, 0) | (0, _, 0) => TunObservationComponentState::Absent,
        (_, 0, 0) => TunObservationComponentState::Confirmed,
        _ => TunObservationComponentState::Partial,
    }
}

fn selected_route_interface(routes: &[TunSystemRoute], address: IpAddr) -> Option<&str> {
    let mut selected: Option<(u8, &str)> = None;
    let mut ambiguous = false;
    for route in routes {
        let Some((network, prefix_length)) = parse_route_prefix(&route.destination, address) else {
            continue;
        };
        if !route_contains(network, prefix_length, address) {
            continue;
        }
        match selected {
            Some((selected_prefix, _)) if selected_prefix > prefix_length => {}
            Some((selected_prefix, selected_interface)) if selected_prefix == prefix_length => {
                ambiguous |= selected_interface != route.interface;
            }
            _ => {
                selected = Some((prefix_length, &route.interface));
                ambiguous = false;
            }
        }
    }
    (!ambiguous).then_some(selected?.1)
}

fn parse_route_prefix(value: &str, address: IpAddr) -> Option<(IpAddr, u8)> {
    let (network, explicit_prefix) = match value.split_once('/') {
        Some((network, prefix)) => (network, Some(prefix.parse::<u8>().ok()?)),
        None => (value, None),
    };
    match address {
        IpAddr::V4(_) => {
            if network == "default" {
                return Some(("0.0.0.0".parse().ok()?, 0));
            }
            let octets = network
                .split('.')
                .map(str::parse::<u8>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            if octets.is_empty() || octets.len() > 4 {
                return None;
            }
            let inferred_prefix = (octets.len() * 8) as u8;
            let mut full = [0; 4];
            full[..octets.len()].copy_from_slice(&octets);
            let prefix_length = explicit_prefix.unwrap_or(inferred_prefix);
            (prefix_length <= 32).then_some((IpAddr::from(full), prefix_length))
        }
        IpAddr::V6(_) => {
            if network == "default" {
                return Some(("::".parse().ok()?, 0));
            }
            let network = network.split('%').next()?.parse::<IpAddr>().ok()?;
            let prefix_length = explicit_prefix.unwrap_or(128);
            (network.is_ipv6() && prefix_length <= 128).then_some((network, prefix_length))
        }
    }
}

fn route_contains(network: IpAddr, prefix_length: u8, address: IpAddr) -> bool {
    match (network, address) {
        (IpAddr::V4(network), IpAddr::V4(address)) => {
            if prefix_length == 0 {
                return true;
            }
            let shift = 32 - u32::from(prefix_length);
            (u32::from(network) >> shift) == (u32::from(address) >> shift)
        }
        (IpAddr::V6(network), IpAddr::V6(address)) => {
            if prefix_length == 0 {
                return true;
            }
            let shift = 128 - u32::from(prefix_length);
            (u128::from(network) >> shift) == (u128::from(address) >> shift)
        }
        _ => false,
    }
}

#[derive(Clone, Debug)]
pub struct MacOsTunServiceClient {
    lifecycle: Option<DevelopmentTunLifecycle>,
    socket_path: PathBuf,
}

#[derive(Clone, Debug)]
struct DevelopmentTunLifecycle {
    repository_root: PathBuf,
    script_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevelopmentInstallerResult {
    kind: Option<TunHelperFailureKind>,
    ok: bool,
}

impl MacOsTunServiceClient {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            lifecycle: None,
            socket_path,
        }
    }

    pub fn development() -> Self {
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        Self::new(development_socket_path(uid))
    }

    pub fn development_with_lifecycle(repository_root: PathBuf) -> Self {
        let mut client = Self::development();
        client.lifecycle = Some(DevelopmentTunLifecycle {
            script_path: repository_root.join("scripts/manage-macos-tun-service.ts"),
            repository_root,
        });
        client
    }

    async fn request(&self, command: ServiceCommand) -> Result<ServiceStatus, ServiceClientError> {
        let request = ServiceRequest {
            command,
            protocol_version: TUN_HELPER_PROTOCOL_VERSION,
        };
        let bytes = serde_json::to_vec(&request).map_err(|_| ServiceClientError::Protocol)?;
        if bytes.len() > TUN_HELPER_MAX_MESSAGE_BYTES {
            return Err(ServiceClientError::Protocol);
        }
        let operation = async {
            let mut stream = UnixStream::connect(&self.socket_path)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            stream
                .write_u32(bytes.len() as u32)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            stream
                .write_all(&bytes)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            let length = stream
                .read_u32()
                .await
                .map_err(|_| ServiceClientError::Unavailable)? as usize;
            if length > TUN_HELPER_MAX_MESSAGE_BYTES {
                return Err(ServiceClientError::Protocol);
            }
            let mut response = vec![0; length];
            stream
                .read_exact(&mut response)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            let response: ServiceResponse =
                serde_json::from_slice(&response).map_err(|_| ServiceClientError::Protocol)?;
            if !response.ok {
                return Err(match response.error {
                    Some(ServiceErrorCode::Rejected | ServiceErrorCode::InvalidRequest) => {
                        ServiceClientError::Rejected
                    }
                    Some(ServiceErrorCode::OperationFailed) | None => {
                        ServiceClientError::OperationFailed
                    }
                });
            }
            Ok(response.status)
        };
        timeout(REQUEST_TIMEOUT, operation)
            .await
            .map_err(|_| ServiceClientError::Unavailable)?
    }

    async fn health(&self) -> Result<ServiceStatus, ServiceClientError> {
        self.request(ServiceCommand::Health).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceClientError {
    Unavailable,
    Protocol,
    Rejected,
    OperationFailed,
}

fn map_host_error(error: ServiceClientError) -> PrivilegedCoreHostError {
    match error {
        ServiceClientError::Unavailable | ServiceClientError::Protocol => {
            PrivilegedCoreHostError::Unavailable
        }
        ServiceClientError::Rejected => PrivilegedCoreHostError::Rejected,
        ServiceClientError::OperationFailed => PrivilegedCoreHostError::OperationFailed,
    }
}

impl PrivilegedCoreHost for MacOsTunServiceClient {
    fn start(
        &self,
        request: PrivilegedCoreLaunchRequest,
    ) -> BoxFuture<'_, Result<PrivilegedCoreProcess, PrivilegedCoreHostError>> {
        Box::pin(async move {
            let status = self
                .request(ServiceCommand::Start {
                    binary: request.binary().to_path_buf(),
                    config_directory: request.config_directory().to_path_buf(),
                    config_file: request.config_file().to_path_buf(),
                    expected_version: request.expected_version().to_owned(),
                    launch_token: request.launch_token().to_owned(),
                })
                .await
                .map_err(map_host_error)?;
            status
                .core
                .map(Into::into)
                .ok_or(PrivilegedCoreHostError::OperationFailed)
        })
    }

    fn observe(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<Option<PrivilegedCoreProcess>, PrivilegedCoreHostError>> {
        Box::pin(async move {
            let status = self
                .request(ServiceCommand::Observe {
                    launch_token: process.launch_token().to_owned(),
                })
                .await
                .map_err(map_host_error)?;
            Ok(status.core.map(Into::into))
        })
    }

    fn stop(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<(), PrivilegedCoreHostError>> {
        Box::pin(async move {
            self.request(ServiceCommand::Stop {
                launch_token: process.launch_token().to_owned(),
            })
            .await
            .map(|_| ())
            .map_err(map_host_error)
        })
    }

    fn owns_listener(
        &self,
        process: PrivilegedCoreProcess,
        endpoint: LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<bool, PrivilegedCoreHostError>> {
        Box::pin(async move {
            let status = self
                .request(ServiceCommand::OwnsListener {
                    host: endpoint.host().to_string(),
                    launch_token: process.launch_token().to_owned(),
                    port: endpoint.port(),
                })
                .await
                .map_err(map_host_error)?;
            Ok(status.core.is_some())
        })
    }
}

impl TunHelperPlatform for MacOsTunServiceClient {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
        TunHelperSnapshot::unavailable(
            TunHelperAvailability::PermissionRequired,
            TunHelperHealth::NotInstalled,
            TunHelperFailureKind::PermissionDenied,
        )
    }

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>> {
        Box::pin(async move {
            match self.health().await {
                Ok(status) => Ok(TunHelperObservation::healthy_installation(
                    status.helper_version,
                    status.installation_id,
                )),
                Err(ServiceClientError::Unavailable) => Ok(TunHelperObservation::not_installed()),
                Err(_) => Err(TunHelperError::new(
                    TunHelperFailureKind::ProtocolMismatch,
                    "The development TUN service returned an invalid response",
                )),
            }
        })
    }

    fn run_lifecycle(
        &self,
        operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async move {
            let lifecycle = self.lifecycle.as_ref().ok_or_else(|| {
                TunHelperError::new(
                    TunHelperFailureKind::RegistrationRequiresApproval,
                    "The development helper installer requires explicit application wiring",
                )
            })?;
            let repository_root = lifecycle.repository_root.canonicalize().map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development helper repository root is unavailable",
                )
            })?;
            let script_metadata = fs::symlink_metadata(&lifecycle.script_path).map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development helper installer is unavailable",
                )
            })?;
            // SAFETY: getuid has no preconditions and only returns the real user ID.
            let current_uid = unsafe { libc::getuid() };
            if script_metadata.file_type().is_symlink()
                || !script_metadata.is_file()
                || script_metadata.uid() != current_uid
                || script_metadata.permissions().mode() & 0o022 != 0
            {
                return Err(TunHelperError::new(
                    TunHelperFailureKind::IdentityRejected,
                    "The development helper installer metadata was rejected",
                ));
            }
            let script_path = lifecycle.script_path.canonicalize().map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development helper installer is unavailable",
                )
            })?;
            if !script_path.starts_with(&repository_root)
                || script_path.file_name().and_then(|name| name.to_str())
                    != Some("manage-macos-tun-service.ts")
            {
                return Err(TunHelperError::new(
                    TunHelperFailureKind::IdentityRejected,
                    "The development helper installer identity was rejected",
                ));
            }
            let action = match operation {
                TunHelperLifecycleOperation::Install => "install",
                TunHelperLifecycleOperation::Repair => "repair",
                TunHelperLifecycleOperation::Remove => "uninstall",
            };
            let node = development_node_executable(current_uid).ok_or_else(|| {
                TunHelperError::new(
                    TunHelperFailureKind::InstallerUnavailable,
                    "The development helper installer could not locate a trusted Node executable",
                )
            })?;
            let output = Command::new(node)
                .arg(script_path)
                .arg(action)
                .current_dir(repository_root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .await
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::InstallerUnavailable,
                        "The development helper installer could not start",
                    )
                })?;
            let result = serde_json::from_slice::<DevelopmentInstallerResult>(&output.stdout)
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::InstallerUnavailable,
                        "The development helper installer did not return a valid result",
                    )
                })?;
            if !output.status.success() || !result.ok {
                return Err(TunHelperError::new(
                    result
                        .kind
                        .unwrap_or(TunHelperFailureKind::InstallerUnavailable),
                    "The development helper installer reported a bounded lifecycle failure",
                ));
            }
            Ok(())
        })
    }

    fn observe_tun(&self) -> BoxFuture<'_, Result<TunNetworkObservation, TunHelperError>> {
        Box::pin(async move {
            self.health()
                .await
                .map(|status| status.observation)
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::ConnectionFailed,
                        "The development TUN service could not be reached",
                    )
                })
        })
    }

    fn set_tun_enabled(&self, enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async move {
            let status = if enabled {
                self.health().await
            } else {
                self.request(ServiceCommand::StopAll).await
            }
            .map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development TUN service operation failed",
                )
            })?;
            if enabled
                && !status
                    .observation
                    .confirms_enabled_at(tun_observation_now())
            {
                return Err(TunHelperError::new(
                    status.observation.failure_kind_at(tun_observation_now()),
                    "The privileged Mihomo Core did not enable TUN",
                ));
            }
            Ok(())
        })
    }
}

fn development_node_executable(current_uid: u32) -> Option<PathBuf> {
    let mut candidates = std::env::var_os("npm_node_execpath")
        .map(PathBuf::from)
        .into_iter()
        .chain(
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
                .map(|directory| directory.join("node")),
        )
        .chain([
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
        ]);
    candidates.find_map(|candidate| {
        if !candidate.is_absolute() {
            return None;
        }
        let metadata = fs::symlink_metadata(&candidate).ok()?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || (metadata.uid() != 0 && metadata.uid() != current_uid)
            || metadata.permissions().mode() & 0o022 != 0
        {
            return None;
        }
        candidate.canonicalize().ok()
    })
}

pub struct TunServiceConfig {
    pub allowed_binary: PathBuf,
    pub allowed_uid: u32,
    pub installation_id: String,
    pub require_root: bool,
    pub runtime_root: PathBuf,
    pub socket_path: PathBuf,
    observer: Arc<dyn TunSystemObserver>,
}

impl TunServiceConfig {
    pub fn from_environment() -> Result<Self, &'static str> {
        let allowed_uid = std::env::var("MISH_TUN_SERVICE_ALLOWED_UID")
            .map_err(|_| "missing allowed UID")?
            .parse()
            .map_err(|_| "invalid allowed UID")?;
        let installation_id = std::env::var("MISH_TUN_SERVICE_INSTALLATION_ID")
            .map_err(|_| "missing installation ID")?;
        if !valid_installation_id(&installation_id) {
            return Err("invalid installation ID");
        }
        Ok(Self {
            allowed_binary: required_path("MISH_TUN_SERVICE_CORE_BINARY")?,
            allowed_uid,
            installation_id,
            require_root: true,
            runtime_root: required_path("MISH_TUN_SERVICE_RUNTIME_ROOT")?,
            socket_path: required_path("MISH_TUN_SERVICE_SOCKET")?,
            observer: Arc::new(MacOsTunSystemObserver::new()),
        })
    }
}

fn required_path(name: &str) -> Result<PathBuf, &'static str> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("missing or invalid service path")
}

struct ServiceProcess {
    child: Child,
    launch_token: String,
    pid: u32,
}

#[derive(Clone)]
struct OwnedTunInterface {
    addresses: Vec<String>,
    name: String,
}

struct ServiceTunOwnership {
    baseline_interfaces: Vec<String>,
    interface: Option<OwnedTunInterface>,
}

#[derive(Default)]
struct ServiceState {
    process: Option<ServiceProcess>,
    tun: Option<ServiceTunOwnership>,
}

pub async fn run_tun_service(config: TunServiceConfig) -> Result<(), &'static str> {
    if config.require_root {
        // SAFETY: geteuid has no preconditions and only returns the effective user ID.
        if unsafe { libc::geteuid() } != 0 {
            return Err("the TUN service must run as root");
        }
    }
    let allowed_binary = validate_regular_file(
        &config.allowed_binary,
        config.allowed_uid,
        config.require_root,
    )?;
    let runtime_root = validate_runtime_root(&config.runtime_root, config.allowed_uid)?;
    if let Ok(metadata) = fs::symlink_metadata(&config.socket_path) {
        if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
            return Err("the service socket path is unsafe");
        }
        fs::remove_file(&config.socket_path)
            .map_err(|_| "the stale socket could not be removed")?;
    }
    let listener = UnixListener::bind(&config.socket_path).map_err(|_| "socket bind failed")?;
    fs::set_permissions(&config.socket_path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "socket permissions failed")?;
    // SAFETY: the socket path is a live path owned by this process and the CString is terminated.
    let socket = std::ffi::CString::new(config.socket_path.as_os_str().as_encoded_bytes())
        .map_err(|_| "socket path was invalid")?;
    if unsafe { libc::chown(socket.as_ptr(), config.allowed_uid, u32::MAX) } != 0 {
        return Err("socket ownership failed");
    }
    let state = Arc::new(Mutex::new(ServiceState::default()));
    let observer = config.observer;
    let installation_id: Arc<str> = config.installation_id.into();
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| "termination handler failed")?;
    loop {
        #[cfg(unix)]
        let accepted = tokio::select! {
            accepted = listener.accept() => Some(accepted),
            _ = terminate.recv() => None,
        };
        #[cfg(not(unix))]
        let accepted = Some(listener.accept().await);
        let Some(accepted) = accepted else {
            break;
        };
        let (stream, _) = accepted.map_err(|_| "socket accept failed")?;
        if peer_uid(&stream)? != config.allowed_uid {
            continue;
        }
        let state = state.clone();
        let allowed_binary = allowed_binary.clone();
        let runtime_root = runtime_root.clone();
        let installation_id = installation_id.clone();
        let observer = observer.clone();
        let allowed_uid = config.allowed_uid;
        tokio::spawn(async move {
            let _ = handle_connection(
                stream,
                state,
                allowed_uid,
                &allowed_binary,
                &runtime_root,
                &installation_id,
                observer,
            )
            .await;
        });
    }
    let mut state = state.lock().await;
    stop_process(&mut state)
        .await
        .map_err(|_| "managed Core cleanup failed")?;
    drop(state);
    fs::remove_file(&config.socket_path).map_err(|_| "socket cleanup failed")?;
    Ok(())
}

async fn handle_connection(
    mut stream: UnixStream,
    state: Arc<Mutex<ServiceState>>,
    allowed_uid: u32,
    allowed_binary: &Path,
    runtime_root: &Path,
    installation_id: &str,
    observer: Arc<dyn TunSystemObserver>,
) -> Result<(), ()> {
    let length = stream.read_u32().await.map_err(|_| ())? as usize;
    if length > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await.map_err(|_| ())?;
    let response = match serde_json::from_slice::<ServiceRequest>(&bytes) {
        Ok(request) if request.protocol_version == TUN_HELPER_PROTOCOL_VERSION => {
            execute_request(
                request.command,
                state,
                allowed_uid,
                allowed_binary,
                runtime_root,
                installation_id,
                observer,
            )
            .await
        }
        _ => ServiceResponse::error(
            ServiceErrorCode::InvalidRequest,
            None,
            TunNetworkObservation::unknown(tun_observation_now()),
            installation_id,
        ),
    };
    let bytes = serde_json::to_vec(&response).map_err(|_| ())?;
    if bytes.len() > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(());
    }
    stream.write_u32(bytes.len() as u32).await.map_err(|_| ())?;
    stream.write_all(&bytes).await.map_err(|_| ())
}

async fn execute_request(
    command: ServiceCommand,
    state: Arc<Mutex<ServiceState>>,
    allowed_uid: u32,
    allowed_binary: &Path,
    runtime_root: &Path,
    installation_id: &str,
    observer: Arc<dyn TunSystemObserver>,
) -> ServiceResponse {
    match command {
        ServiceCommand::Health => status_response(&state, installation_id, &observer).await,
        ServiceCommand::Observe { launch_token } => {
            let status = status_response(&state, installation_id, &observer).await;
            if status
                .status
                .core
                .as_ref()
                .is_some_and(|core| core.launch_token == launch_token)
            {
                status
            } else {
                ServiceResponse::ok(None, status.status.observation, installation_id)
            }
        }
        ServiceCommand::OwnsListener {
            host,
            launch_token,
            port,
        } => {
            let status = status_response(&state, installation_id, &observer).await;
            let owns = status.status.core.as_ref().is_some_and(|core| {
                core.launch_token == launch_token
                    && owns_listener(core.pid, &host, port).unwrap_or(false)
            });
            if owns {
                status
            } else {
                ServiceResponse::ok(None, status.status.observation, installation_id)
            }
        }
        ServiceCommand::Start {
            binary,
            config_directory,
            config_file,
            expected_version,
            launch_token,
        } => {
            if !valid_token(&launch_token)
                || !valid_version(&expected_version)
                || validate_launch_paths(
                    &binary,
                    &config_directory,
                    &config_file,
                    allowed_binary,
                    runtime_root,
                    allowed_uid,
                )
                .is_err()
            {
                return ServiceResponse::error(
                    ServiceErrorCode::Rejected,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let tun_requested = match read_tun_enabled(&config_file) {
                Ok(enabled) => enabled,
                Err(_) => {
                    return ServiceResponse::error(
                        ServiceErrorCode::Rejected,
                        None,
                        unknown_tun_observation(),
                        installation_id,
                    );
                }
            };
            if verify_core_version(&binary, &expected_version)
                .await
                .is_err()
            {
                return ServiceResponse::error(
                    ServiceErrorCode::Rejected,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let baseline = observer.observe().await;
            if tun_requested && baseline.is_err() {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let mut service_state = state.lock().await;
            reap_if_exited(&mut service_state);
            let correlation = current_tun_correlation(&service_state, observer.as_ref());
            if let Ok(system) = &baseline {
                let observation =
                    service_state.tun_observation(system, correlation_result(&correlation));
                if observation.confirms_disabled_at(tun_observation_now()) {
                    service_state.tun = None;
                } else if service_state.process.is_none() && service_state.tun.is_none() {
                    return ServiceResponse::error(
                        ServiceErrorCode::OperationFailed,
                        None,
                        observation,
                        installation_id,
                    );
                }
            }
            if service_state.process.is_some() || service_state.tun.is_some() {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    service_state.status(),
                    baseline.as_ref().map_or_else(
                        |_| unknown_tun_observation(),
                        |system| {
                            service_state.tun_observation(system, correlation_result(&correlation))
                        },
                    ),
                    installation_id,
                );
            }
            let child = Command::new(&binary)
                .arg("-d")
                .arg(&config_directory)
                .arg("-f")
                .arg(&config_file)
                .env("MISH_MANAGED_CORE_TOKEN", &launch_token)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            let mut child = match child {
                Ok(child) => child,
                Err(_) => {
                    return ServiceResponse::error(
                        ServiceErrorCode::OperationFailed,
                        None,
                        unknown_tun_observation(),
                        installation_id,
                    );
                }
            };
            let Some(pid) = child.id() else {
                let _ = child.start_kill();
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            };
            tokio::time::sleep(Duration::from_millis(150)).await;
            if !matches!(child.try_wait(), Ok(None)) {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            service_state.process = Some(ServiceProcess {
                child,
                launch_token,
                pid,
            });
            if tun_requested {
                let baseline_interfaces = baseline
                    .as_ref()
                    .expect("TUN launch requires a baseline observation")
                    .interfaces
                    .iter()
                    .filter(|interface| is_utun(&interface.name))
                    .map(|interface| interface.name.clone())
                    .collect();
                service_state.tun = Some(ServiceTunOwnership {
                    baseline_interfaces,
                    interface: None,
                });
            }
            drop(service_state);
            status_response(&state, installation_id, &observer).await
        }
        ServiceCommand::Stop { launch_token } => {
            let mut service_state = state.lock().await;
            reap_if_exited(&mut service_state);
            if service_state
                .process
                .as_ref()
                .is_some_and(|process| process.launch_token != launch_token)
            {
                return ServiceResponse::error(
                    ServiceErrorCode::Rejected,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            if stop_process(&mut service_state).await.is_err() {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            drop(service_state);
            status_response(&state, installation_id, &observer).await
        }
        ServiceCommand::StopAll => {
            let mut service_state = state.lock().await;
            if stop_process(&mut service_state).await.is_err() {
                return ServiceResponse::error(
                    ServiceErrorCode::OperationFailed,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            drop(service_state);
            status_response(&state, installation_id, &observer).await
        }
    }
}

impl ServiceState {
    fn status(&self) -> Option<ServiceCoreStatus> {
        self.process.as_ref().map(|process| ServiceCoreStatus {
            launch_token: process.launch_token.clone(),
            pid: process.pid,
        })
    }

    fn tun_observation(
        &mut self,
        system: &TunSystemSnapshot,
        correlated_sockets: Option<Result<&[OwnedTunSocket], ()>>,
    ) -> TunNetworkObservation {
        let core = if self.process.is_some() && self.tun.is_some() {
            TunObservationComponentState::Confirmed
        } else {
            TunObservationComponentState::Absent
        };
        let Some(ownership) = self.tun.as_mut() else {
            let untracked = system
                .interfaces
                .iter()
                .filter(|interface| {
                    is_utun(&interface.name)
                        && interface.addresses.iter().any(|address| {
                            address
                                .parse::<IpAddr>()
                                .is_ok_and(|address| address.is_ipv4())
                        })
                })
                .collect::<Vec<_>>();
            if !untracked.is_empty() {
                let routes = if untracked
                    .iter()
                    .any(|interface| required_route_count(system, &interface.name, false) > 0)
                {
                    TunObservationComponentState::Foreign
                } else {
                    TunObservationComponentState::Absent
                };
                let dns = if untracked.iter().any(|interface| {
                    dns_observation_state(system, &interface.name)
                        != TunObservationComponentState::Absent
                }) {
                    TunObservationComponentState::Foreign
                } else {
                    TunObservationComponentState::Absent
                };
                return TunNetworkObservation::new(
                    core,
                    TunObservationComponentState::Foreign,
                    routes,
                    dns,
                    tun_observation_now(),
                );
            }
            return TunNetworkObservation::new(
                core,
                TunObservationComponentState::Absent,
                TunObservationComponentState::Absent,
                TunObservationComponentState::Absent,
                tun_observation_now(),
            );
        };
        let candidates = system
            .interfaces
            .iter()
            .filter(|interface| {
                is_utun(&interface.name) && !ownership.baseline_interfaces.contains(&interface.name)
            })
            .collect::<Vec<_>>();
        if self.process.is_some() {
            let correlated = match correlated_sockets {
                Some(Ok(sockets))
                    if sockets.len() <= TUN_OWNED_INTERFACE_LIMIT
                        && sockets.iter().all(|socket| is_utun(&socket.interface))
                        && !sockets.iter().enumerate().any(|(index, socket)| {
                            sockets[index + 1..]
                                .iter()
                                .any(|candidate| candidate.interface == socket.interface)
                        }) =>
                {
                    sockets
                }
                Some(Ok(_)) | Some(Err(())) | None => {
                    return TunNetworkObservation::new(
                        core,
                        TunObservationComponentState::Unknown,
                        TunObservationComponentState::Unknown,
                        TunObservationComponentState::Unknown,
                        tun_observation_now(),
                    );
                }
            };
            if correlated.len() > 1 {
                return TunNetworkObservation::new(
                    core,
                    TunObservationComponentState::Partial,
                    TunObservationComponentState::Partial,
                    TunObservationComponentState::Partial,
                    tun_observation_now(),
                );
            }
            if let Some(owned) = ownership.interface.as_ref() {
                if correlated
                    .first()
                    .is_none_or(|socket| socket.interface != owned.name)
                {
                    let ipv6_required = owned
                        .addresses
                        .iter()
                        .any(|address| address.contains(':') && !address.starts_with("fe80:"));
                    let current = system
                        .interfaces
                        .iter()
                        .find(|interface| interface.name == owned.name);
                    let interface = if current.is_some() {
                        TunObservationComponentState::Foreign
                    } else {
                        TunObservationComponentState::Absent
                    };
                    let routes = if required_route_count(system, &owned.name, ipv6_required) > 0 {
                        TunObservationComponentState::Foreign
                    } else {
                        TunObservationComponentState::Absent
                    };
                    let dns = if dns_observation_state(system, &owned.name)
                        != TunObservationComponentState::Absent
                    {
                        TunObservationComponentState::Foreign
                    } else {
                        TunObservationComponentState::Absent
                    };
                    return TunNetworkObservation::new(
                        core,
                        interface,
                        routes,
                        dns,
                        tun_observation_now(),
                    );
                }
            } else {
                let Some(correlated) = correlated.first() else {
                    let state = if candidates.is_empty() {
                        TunObservationComponentState::Absent
                    } else {
                        TunObservationComponentState::Foreign
                    };
                    return TunNetworkObservation::new(
                        core,
                        state,
                        state,
                        state,
                        tun_observation_now(),
                    );
                };
                if ownership
                    .baseline_interfaces
                    .contains(&correlated.interface)
                {
                    return TunNetworkObservation::new(
                        core,
                        TunObservationComponentState::Foreign,
                        TunObservationComponentState::Foreign,
                        TunObservationComponentState::Foreign,
                        tun_observation_now(),
                    );
                }
                let Some(current) = candidates
                    .iter()
                    .find(|interface| interface.name == correlated.interface)
                else {
                    return TunNetworkObservation::new(
                        core,
                        TunObservationComponentState::Partial,
                        TunObservationComponentState::Partial,
                        TunObservationComponentState::Partial,
                        tun_observation_now(),
                    );
                };
                if current.addresses.is_empty() {
                    return TunNetworkObservation::new(
                        core,
                        TunObservationComponentState::Partial,
                        TunObservationComponentState::Partial,
                        TunObservationComponentState::Partial,
                        tun_observation_now(),
                    );
                }
                ownership.interface = Some(OwnedTunInterface {
                    addresses: current.addresses.clone(),
                    name: current.name.clone(),
                });
            }
        }
        let Some(owned) = ownership.interface.as_ref() else {
            let state = if candidates.is_empty() {
                TunObservationComponentState::Absent
            } else {
                TunObservationComponentState::Foreign
            };
            return TunNetworkObservation::new(core, state, state, state, tun_observation_now());
        };
        let current = system
            .interfaces
            .iter()
            .find(|interface| interface.name == owned.name);
        let interface = match current {
            Some(current) if current.addresses == owned.addresses => {
                TunObservationComponentState::Confirmed
            }
            Some(_) => TunObservationComponentState::Foreign,
            None => TunObservationComponentState::Absent,
        };
        let ipv6_required = owned
            .addresses
            .iter()
            .any(|address| address.contains(':') && !address.starts_with("fe80:"));
        let expected_routes = 8 + usize::from(ipv6_required) * 8;
        let route_count = required_route_count(system, &owned.name, ipv6_required);
        let routes = match route_count {
            0 => TunObservationComponentState::Absent,
            count if count == expected_routes => TunObservationComponentState::Confirmed,
            _ => TunObservationComponentState::Partial,
        };
        let dns = dns_observation_state(system, &owned.name);
        TunNetworkObservation::new(core, interface, routes, dns, tun_observation_now())
    }
}

const REQUIRED_IPV4_ROUTES: &[&[&str]] = &[
    &["1", "1/8", "1.0.0.0/8"],
    &["2/7", "2.0.0.0/7"],
    &["4/6", "4.0.0.0/6"],
    &["8/5", "8.0.0.0/5"],
    &["16/4", "16.0.0.0/4"],
    &["32/3", "32.0.0.0/3"],
    &["64/2", "64.0.0.0/2"],
    &["128/1", "128.0.0.0/1"],
];
const REQUIRED_IPV6_ROUTES: &[&[&str]] = &[
    &["100::/8"],
    &["200::/7"],
    &["400::/6"],
    &["800::/5"],
    &["1000::/4"],
    &["2000::/3"],
    &["4000::/2"],
    &["8000::/1"],
];

fn required_route_count(system: &TunSystemSnapshot, interface: &str, ipv6: bool) -> usize {
    REQUIRED_IPV4_ROUTES
        .iter()
        .chain(ipv6.then_some(REQUIRED_IPV6_ROUTES).into_iter().flatten())
        .filter(|destinations| {
            system.routes.iter().any(|route| {
                route.interface == interface && destinations.contains(&route.destination.as_str())
            })
        })
        .count()
}

fn is_utun(value: &str) -> bool {
    value.strip_prefix("utun").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    })
}

impl ServiceResponse {
    fn ok(
        core: Option<ServiceCoreStatus>,
        observation: TunNetworkObservation,
        installation_id: &str,
    ) -> Self {
        Self {
            error: None,
            ok: true,
            status: ServiceStatus {
                core,
                helper_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                installation_id: installation_id.to_owned(),
                observation,
            },
        }
    }

    fn error(
        error: ServiceErrorCode,
        core: Option<ServiceCoreStatus>,
        observation: TunNetworkObservation,
        installation_id: &str,
    ) -> Self {
        Self {
            error: Some(error),
            ok: false,
            status: ServiceStatus {
                core,
                helper_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                installation_id: installation_id.to_owned(),
                observation,
            },
        }
    }
}

async fn status_response(
    state: &Mutex<ServiceState>,
    installation_id: &str,
    observer: &Arc<dyn TunSystemObserver>,
) -> ServiceResponse {
    let mut state = state.lock().await;
    reap_if_exited(&mut state);
    let correlation_before = current_tun_correlation(&state, observer.as_ref());
    let system = observer.observe().await;
    let correlation_after = current_tun_correlation(&state, observer.as_ref());
    let correlation = stable_tun_correlation(correlation_before, correlation_after);
    let observation = match system {
        Ok(system) => state.tun_observation(&system, correlation_result(&correlation)),
        Err(()) => {
            let mut observation = unknown_tun_observation();
            observation.core = if state.process.is_some() && state.tun.is_some() {
                TunObservationComponentState::Confirmed
            } else {
                TunObservationComponentState::Absent
            };
            observation
        }
    };
    if observation.confirms_disabled_at(tun_observation_now()) && state.process.is_none() {
        state.tun = None;
    }
    ServiceResponse::ok(state.status(), observation, installation_id)
}

fn current_tun_correlation(
    state: &ServiceState,
    observer: &dyn TunSystemObserver,
) -> Option<Result<Vec<OwnedTunSocket>, ()>> {
    state
        .process
        .as_ref()
        .filter(|_| state.tun.is_some())
        .map(|process| observer.owned_utun_sockets(process.pid))
}

fn correlation_result(
    correlation: &Option<Result<Vec<OwnedTunSocket>, ()>>,
) -> Option<Result<&[OwnedTunSocket], ()>> {
    correlation
        .as_ref()
        .map(|result| result.as_deref().map_err(|_| ()))
}

fn stable_tun_correlation(
    before: Option<Result<Vec<OwnedTunSocket>, ()>>,
    after: Option<Result<Vec<OwnedTunSocket>, ()>>,
) -> Option<Result<Vec<OwnedTunSocket>, ()>> {
    match (before, after) {
        (None, None) => None,
        (Some(Ok(before)), Some(Ok(after))) if before == after => Some(Ok(before)),
        _ => Some(Err(())),
    }
}

fn unknown_tun_observation() -> TunNetworkObservation {
    TunNetworkObservation::unknown(tun_observation_now())
}

fn reap_if_exited(state: &mut ServiceState) {
    if state
        .process
        .as_mut()
        .is_some_and(|process| !matches!(process.child.try_wait(), Ok(None)))
    {
        state.process = None;
    }
}

async fn stop_process(state: &mut ServiceState) -> Result<(), ()> {
    let Some(mut process) = state.process.take() else {
        return Ok(());
    };
    // SAFETY: kill receives a positive PID returned for the child owned by this service.
    let _ = unsafe { libc::kill(process.pid as i32, libc::SIGTERM) };
    if !matches!(timeout(STOP_TIMEOUT, process.child.wait()).await, Ok(Ok(_))) {
        process.child.start_kill().map_err(|_| ())?;
        process.child.wait().await.map_err(|_| ())?;
    }
    Ok(())
}

fn validate_regular_file(
    path: &Path,
    allowed_uid: u32,
    root_only: bool,
) -> Result<PathBuf, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "allowed binary is unavailable")?;
    let owner = metadata.uid();
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || (root_only && owner != 0)
        || (!root_only && owner != 0 && owner != allowed_uid)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err("allowed binary metadata is unsafe");
    }
    path.canonicalize().map_err(|_| "allowed binary is invalid")
}

fn validate_runtime_root(path: &Path, allowed_uid: u32) -> Result<PathBuf, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "runtime root is unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != allowed_uid
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("runtime root metadata is unsafe");
    }
    path.canonicalize().map_err(|_| "runtime root is invalid")
}

fn validate_launch_paths(
    binary: &Path,
    config_directory: &Path,
    config_file: &Path,
    allowed_binary: &Path,
    runtime_root: &Path,
    allowed_uid: u32,
) -> Result<(), ()> {
    if validate_regular_file(binary, allowed_uid, false).map_err(|_| ())? != allowed_binary {
        return Err(());
    }
    let directory = validate_owned_private_path(config_directory, allowed_uid, true)?;
    let file = validate_owned_private_path(config_file, allowed_uid, false)?;
    let candidates = runtime_root.join("candidates");
    let candidate = directory.parent().ok_or(())?;
    if directory.file_name().and_then(|name| name.to_str()) != Some("home")
        || candidate.parent() != Some(candidates.as_path())
        || file != candidate.join("config.yaml")
        || candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| uuid::Uuid::parse_str(name).is_err())
    {
        return Err(());
    }
    Ok(())
}

fn validate_owned_private_path(path: &Path, uid: u32, directory: bool) -> Result<PathBuf, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.permissions().mode() & 0o077 != 0
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.len() > CONFIG_MAX_BYTES))
    {
        return Err(());
    }
    path.canonicalize().map_err(|_| ())
}

fn read_tun_enabled(path: &Path) -> Result<bool, ()> {
    let bytes = fs::read(path).map_err(|_| ())?;
    if bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err(());
    }
    let value: serde_norway::Value = serde_norway::from_slice(&bytes).map_err(|_| ())?;
    Ok(value
        .get("tun")
        .and_then(|tun| tun.get("enable"))
        .and_then(serde_norway::Value::as_bool)
        .unwrap_or(false))
}

async fn verify_core_version(binary: &Path, expected: &str) -> Result<(), ()> {
    let output = timeout(REQUEST_TIMEOUT, Command::new(binary).arg("-v").output())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let reported = String::from_utf8(output.stdout).map_err(|_| ())?;
    if output.status.success()
        && reported.split_whitespace().any(|part| {
            part.trim_matches(|value: char| !value.is_ascii_alphanumeric() && value != '.')
                == expected
        })
    {
        Ok(())
    } else {
        Err(())
    }
}

fn valid_token(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_installation_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn owns_listener(pid: u32, host: &str, port: u16) -> Result<bool, ()> {
    if host != "127.0.0.1" {
        return Ok(false);
    }
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args([
            "-nP".to_owned(),
            "-a".to_owned(),
            "-p".to_owned(),
            pid.to_string(),
            format!("-iTCP@{host}:{port}"),
            "-sTCP:LISTEN".to_owned(),
            "-Fpn".to_owned(),
        ])
        .output()
        .map_err(|_| ())?;
    if !output.status.success() {
        return Ok(false);
    }
    let text = String::from_utf8(output.stdout).map_err(|_| ())?;
    Ok(text.lines().any(|line| line == format!("p{pid}"))
        && text.lines().any(|line| line == format!("n{host}:{port}")))
}

#[cfg(target_os = "macos")]
fn peer_uid(stream: &UnixStream) -> Result<u32, &'static str> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: the pointers are valid for writes and the socket descriptor is live.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err("peer identity inspection failed");
    }
    Ok(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> Result<u32, &'static str> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the output buffer and its length are valid for the SO_PEERCRED query.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut _ as *mut libc::c_void,
            &mut length,
        )
    } != 0
    {
        return Err("peer identity inspection failed");
    }
    Ok(credentials.uid)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_uid(_stream: &UnixStream) -> Result<u32, &'static str> {
    Err("peer identity inspection is unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, os::unix::fs::PermissionsExt, sync::Mutex as StdMutex};

    struct SequenceObserver {
        owned_interfaces: Result<Vec<String>, ()>,
        snapshots: StdMutex<VecDeque<TunSystemSnapshot>>,
    }

    impl SequenceObserver {
        fn new(
            snapshots: Vec<TunSystemSnapshot>,
            owned_interfaces: Result<Vec<String>, ()>,
        ) -> Self {
            Self {
                owned_interfaces,
                snapshots: StdMutex::new(snapshots.into()),
            }
        }
    }

    impl TunSystemObserver for SequenceObserver {
        fn observe(&self) -> BoxFuture<'_, Result<TunSystemSnapshot, ()>> {
            let mut snapshots = self.snapshots.lock().unwrap();
            let snapshot = if snapshots.len() > 1 {
                snapshots.pop_front()
            } else {
                snapshots.front().cloned()
            };
            Box::pin(async move { snapshot.ok_or(()) })
        }

        fn owned_utun_sockets(&self, _pid: u32) -> Result<Vec<OwnedTunSocket>, ()> {
            self.owned_interfaces.clone().map(|interfaces| {
                interfaces
                    .into_iter()
                    .enumerate()
                    .map(|(index, interface)| OwnedTunSocket {
                        interface,
                        socket: index as u64 + 1,
                    })
                    .collect()
            })
        }
    }

    fn baseline_snapshot() -> TunSystemSnapshot {
        TunSystemSnapshot {
            dns_resolvers: vec![TunSystemDnsResolver {
                interface: Some("en0".into()),
                nameservers: vec!["8.8.8.8".parse().unwrap()],
                port: 53,
            }],
            interfaces: vec![
                TunSystemInterface {
                    addresses: vec!["127.0.0.1".into()],
                    name: "lo0".into(),
                },
                TunSystemInterface {
                    addresses: vec!["fe80::1".into()],
                    name: "utun0".into(),
                },
            ],
            routes: vec![TunSystemRoute {
                destination: "default".into(),
                interface: "en0".into(),
            }],
        }
    }

    fn healthy_snapshot() -> TunSystemSnapshot {
        let mut snapshot = baseline_snapshot();
        snapshot.interfaces.push(TunSystemInterface {
            addresses: vec!["198.18.0.1".into()],
            name: "utun1".into(),
        });
        snapshot.routes.extend(
            REQUIRED_IPV4_ROUTES
                .iter()
                .map(|destinations| TunSystemRoute {
                    destination: destinations[0].into(),
                    interface: "utun1".into(),
                }),
        );
        snapshot
    }

    fn multiple_new_utuns_snapshot() -> TunSystemSnapshot {
        let mut snapshot = healthy_snapshot();
        snapshot.interfaces.push(TunSystemInterface {
            addresses: vec!["198.19.0.1".into()],
            name: "utun2".into(),
        });
        snapshot
    }

    fn tracked_state() -> ServiceState {
        ServiceState {
            process: None,
            tun: Some(ServiceTunOwnership {
                baseline_interfaces: vec!["utun0".into()],
                interface: Some(OwnedTunInterface {
                    addresses: vec!["198.18.0.1".into()],
                    name: "utun1".into(),
                }),
            }),
        }
    }

    #[test]
    fn parses_bounded_macos_tun_observation_fixtures() {
        let interfaces = parse_tun_interfaces(
            "lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\nutun7: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 9000\n\tinet 198.18.0.1 --> 198.18.0.1 netmask 0xffffffff\n",
        )
        .unwrap();
        assert_eq!(interfaces[1].name, "utun7");
        assert_eq!(interfaces[1].addresses, ["198.18.0.1"]);

        let routes = parse_tun_routes(
            "Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n1                  198.18.0.1         UGSc                utun7\n2/7                198.18.0.1         UGSc                utun7\ndefault            192.168.1.1        UGScg                 en0\n",
        )
        .unwrap();
        assert_eq!(routes.len(), 3);
        assert_eq!(routes[0].interface, "utun7");

        let dns = parse_tun_dns_resolvers(
            "DNS configuration\n\nresolver #1\n  nameserver[0] : 198.18.0.2\n  if_index : 19 (utun7)\n\nresolver #2\n  nameserver[0] : 192.168.1.1\n  if_index : 4 (en0)\n",
        )
        .unwrap();
        assert_eq!(dns[0].interface.as_deref(), Some("utun7"));
        assert_eq!(dns[1].interface.as_deref(), Some("en0"));

        let resolvers = parse_tun_dns_resolvers(
            "DNS configuration\n\nresolver #1\n  nameserver[0] : 8.8.8.8\n  if_index : 4 (en0)\n\nresolver #2\n  nameserver[0] : 224.0.0.251\n  port : 5353\n  if_index : 4 (en0)\n",
        )
        .unwrap();
        assert_eq!(resolvers.len(), 2);
        assert_eq!(
            resolvers[0].nameservers,
            ["8.8.8.8".parse::<IpAddr>().unwrap()]
        );
        assert_eq!(resolvers[0].port, 53);
        assert_eq!(resolvers[1].port, 5353);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn process_descriptor_observer_does_not_invent_utun_ownership() {
        assert!(
            process_owned_utun_sockets(std::process::id())
                .unwrap()
                .is_empty()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn process_descriptor_layout_matches_the_public_libproc_abi() {
        assert_eq!(std::mem::size_of::<ProcessFileInfo>(), 24);
        assert_eq!(
            std::mem::offset_of!(SocketFdInfoBuffer, kernel_control),
            264
        );
        assert_eq!(
            std::mem::offset_of!(SocketFdInfoBuffer, protocol_storage),
            384
        );
    }

    #[test]
    fn changing_socket_identity_cannot_correlate_an_observation() {
        let before = OwnedTunSocket {
            interface: "utun1".into(),
            socket: 1,
        };
        let after = OwnedTunSocket {
            interface: "utun1".into(),
            socket: 2,
        };

        assert_eq!(
            stable_tun_correlation(Some(Ok(vec![before])), Some(Ok(vec![after]))),
            Some(Err(()))
        );
    }

    #[test]
    fn confirms_dns_hijack_when_system_nameserver_routes_through_owned_tun() {
        let system = TunSystemSnapshot {
            dns_resolvers: vec![TunSystemDnsResolver {
                interface: Some("en0".into()),
                nameservers: vec!["8.8.8.8".parse().unwrap()],
                port: 53,
            }],
            interfaces: Vec::new(),
            routes: vec![
                TunSystemRoute {
                    destination: "8/5".into(),
                    interface: "utun7".into(),
                },
                TunSystemRoute {
                    destination: "default".into(),
                    interface: "en0".into(),
                },
            ],
        };

        assert_eq!(
            dns_observation_state(&system, "utun7"),
            TunObservationComponentState::Confirmed
        );
    }

    #[test]
    fn rejects_dns_hijack_when_a_more_specific_route_bypasses_owned_tun() {
        let system = TunSystemSnapshot {
            dns_resolvers: vec![TunSystemDnsResolver {
                interface: Some("en0".into()),
                nameservers: vec!["192.168.1.1".parse().unwrap()],
                port: 53,
            }],
            interfaces: Vec::new(),
            routes: vec![
                TunSystemRoute {
                    destination: "128/1".into(),
                    interface: "utun7".into(),
                },
                TunSystemRoute {
                    destination: "192.168.1".into(),
                    interface: "en0".into(),
                },
            ],
        };

        assert_eq!(
            dns_observation_state(&system, "utun7"),
            TunObservationComponentState::Absent
        );
    }

    #[test]
    fn reports_partial_dns_hijack_when_only_some_nameservers_use_owned_tun() {
        let system = TunSystemSnapshot {
            dns_resolvers: vec![TunSystemDnsResolver {
                interface: Some("en0".into()),
                nameservers: vec!["8.8.8.8".parse().unwrap(), "192.168.1.1".parse().unwrap()],
                port: 53,
            }],
            interfaces: Vec::new(),
            routes: vec![
                TunSystemRoute {
                    destination: "8/5".into(),
                    interface: "utun7".into(),
                },
                TunSystemRoute {
                    destination: "192.168.1".into(),
                    interface: "en0".into(),
                },
            ],
        };

        assert_eq!(
            dns_observation_state(&system, "utun7"),
            TunObservationComponentState::Partial
        );
    }

    #[test]
    fn classifies_partial_and_foreign_tun_effects() {
        let mut partial_state = tracked_state();
        let mut partial = healthy_snapshot();
        partial.routes.pop();
        let partial_observation = partial_state.tun_observation(&partial, None);
        assert_eq!(
            partial_observation.routes,
            TunObservationComponentState::Partial
        );
        assert!(!partial_observation.confirms_enabled_at(tun_observation_now()));

        let mut foreign_state = ServiceState {
            process: None,
            tun: Some(ServiceTunOwnership {
                baseline_interfaces: vec!["utun0".into()],
                interface: None,
            }),
        };
        let mut foreign = healthy_snapshot();
        foreign.interfaces.push(TunSystemInterface {
            addresses: vec!["198.19.0.1".into()],
            name: "utun2".into(),
        });
        let foreign_observation = foreign_state.tun_observation(&foreign, None);
        assert_eq!(
            foreign_observation.interface,
            TunObservationComponentState::Foreign
        );

        let mut untracked_state = ServiceState::default();
        let untracked_observation = untracked_state.tun_observation(&healthy_snapshot(), None);
        assert_eq!(
            untracked_observation.interface,
            TunObservationComponentState::Foreign
        );
    }

    #[test]
    fn sole_foreign_utun_racing_launch_is_never_claimed() {
        let mut state = ServiceState {
            process: None,
            tun: Some(ServiceTunOwnership {
                baseline_interfaces: vec!["utun0".into()],
                interface: None,
            }),
        };

        let observation = state.tun_observation(&healthy_snapshot(), None);

        assert_eq!(observation.interface, TunObservationComponentState::Foreign);
        assert!(!observation.confirms_enabled_at(tun_observation_now()));
    }

    #[test]
    fn process_exit_with_residual_effects_is_neither_enabled_nor_cleaned_up() {
        let mut exited_state = tracked_state();
        let residual_observation = exited_state.tun_observation(&healthy_snapshot(), None);
        assert_eq!(
            residual_observation.core,
            TunObservationComponentState::Absent
        );
        assert_eq!(
            residual_observation.interface,
            TunObservationComponentState::Confirmed
        );
        assert!(!residual_observation.confirms_disabled_at(tun_observation_now()));
        assert!(!residual_observation.confirms_enabled_at(tun_observation_now()));
    }

    #[test]
    fn owned_interface_disappearance_and_replacement_never_retarget_ownership() {
        let mut state = tracked_state();
        let mut replacement = healthy_snapshot();
        replacement
            .interfaces
            .iter_mut()
            .find(|interface| interface.name == "utun1")
            .unwrap()
            .addresses = vec!["198.19.0.1".into()];

        let replacement_observation = state.tun_observation(&replacement, None);
        assert_eq!(
            replacement_observation.interface,
            TunObservationComponentState::Foreign
        );
        assert!(!replacement_observation.confirms_enabled_at(tun_observation_now()));

        let disappearance_observation = state.tun_observation(&baseline_snapshot(), None);
        assert_eq!(
            disappearance_observation.interface,
            TunObservationComponentState::Absent
        );
        assert!(disappearance_observation.confirms_disabled_at(tun_observation_now()));
    }

    fn write_fixture_binary(root: &Path) -> PathBuf {
        let binary = root.join("mihomo-fixture");
        fs::write(
            &binary,
            "#!/bin/sh\nif [ \"$1\" = \"-v\" ]; then echo 'Mihomo Meta v1.19.29'; exit 0; fi\nexec sleep 30\n",
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        binary
    }

    async fn fixture(
        snapshots: Vec<TunSystemSnapshot>,
        owned_interfaces: Result<Vec<String>, ()>,
    ) -> (
        tempfile::TempDir,
        MacOsTunServiceClient,
        PathBuf,
        PathBuf,
        PathBuf,
        tokio::task::JoinHandle<Result<(), &'static str>>,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let binary = write_fixture_binary(temporary.path());
        let runtime_root = temporary.path().join("runtime");
        let candidate = runtime_root
            .join("candidates")
            .join("11111111-1111-4111-8111-111111111111");
        let home = candidate.join("home");
        fs::create_dir_all(&home).unwrap();
        fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(
            runtime_root.join("candidates"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let config_file = candidate.join("config.yaml");
        fs::write(&config_file, "tun:\n  enable: true\n").unwrap();
        fs::set_permissions(&config_file, fs::Permissions::from_mode(0o600)).unwrap();
        let socket_path = temporary.path().join("helper.sock");
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        let installation_id = "a".repeat(64);
        let server = tokio::spawn(run_tun_service(TunServiceConfig {
            allowed_binary: binary.clone(),
            allowed_uid: uid,
            installation_id,
            require_root: false,
            runtime_root,
            socket_path: socket_path.clone(),
            observer: Arc::new(SequenceObserver::new(snapshots, owned_interfaces)),
        }));
        for _ in 0..100 {
            if socket_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        (
            temporary,
            MacOsTunServiceClient::new(socket_path),
            binary,
            home,
            config_file,
            server,
        )
    }

    #[tokio::test]
    async fn development_service_hosts_and_observes_a_tun_core() {
        let baseline = baseline_snapshot();
        let healthy = healthy_snapshot();
        let cleanup = baseline.clone();
        let (_temporary, client, binary, home, config_file, server) = fixture(
            vec![
                baseline,
                healthy.clone(),
                healthy.clone(),
                healthy.clone(),
                healthy,
                cleanup,
            ],
            Ok(vec!["utun1".into()]),
        )
        .await;
        let request = PrivilegedCoreLaunchRequest::new(binary, home, config_file, "v1.19.29");
        let process = client.start(request).await.unwrap();
        let health = client.health().await.unwrap();
        assert_eq!(health.helper_version, TUN_HELPER_EXPECTED_VERSION);
        assert_eq!(health.installation_id, "a".repeat(64));
        assert_eq!(
            client.observe(process.clone()).await.unwrap(),
            Some(process.clone())
        );
        assert!(
            client
                .observe_tun()
                .await
                .unwrap()
                .confirms_enabled_at(tun_observation_now())
        );
        client.stop(process).await.unwrap();
        assert!(
            client
                .observe_tun()
                .await
                .unwrap()
                .confirms_disabled_at(tun_observation_now())
        );
        server.abort();
    }

    #[tokio::test]
    async fn sole_foreign_utun_during_launch_never_confirms_applied() {
        let baseline = baseline_snapshot();
        let foreign = healthy_snapshot();
        let (_temporary, client, binary, home, config_file, server) =
            fixture(vec![baseline, foreign.clone(), foreign], Ok(Vec::new())).await;
        let request = PrivilegedCoreLaunchRequest::new(binary, home, config_file, "v1.19.29");
        let process = client.start(request).await.unwrap();

        let observation = client.observe_tun().await.unwrap();

        assert_eq!(observation.core, TunObservationComponentState::Confirmed);
        assert_eq!(observation.interface, TunObservationComponentState::Foreign);
        assert!(!observation.confirms_enabled_at(tun_observation_now()));
        client.stop(process).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn multiple_new_utuns_claim_only_the_exact_core_owned_interface() {
        let baseline = baseline_snapshot();
        let multiple = multiple_new_utuns_snapshot();
        let (_temporary, client, binary, home, config_file, server) = fixture(
            vec![baseline, multiple.clone(), multiple],
            Ok(vec!["utun1".into()]),
        )
        .await;
        let request = PrivilegedCoreLaunchRequest::new(binary, home, config_file, "v1.19.29");
        let process = client.start(request).await.unwrap();

        let observation = client.observe_tun().await.unwrap();

        assert!(observation.confirms_enabled_at(tun_observation_now()));
        client.stop(process).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn unavailable_or_ambiguous_process_correlation_fails_closed() {
        for owned_interfaces in [Err(()), Ok(vec!["utun1".into(), "utun2".into()])] {
            let baseline = baseline_snapshot();
            let multiple = multiple_new_utuns_snapshot();
            let (_temporary, client, binary, home, config_file, server) =
                fixture(vec![baseline, multiple.clone(), multiple], owned_interfaces).await;
            let request = PrivilegedCoreLaunchRequest::new(binary, home, config_file, "v1.19.29");
            let process = client.start(request).await.unwrap();

            let observation = client.observe_tun().await.unwrap();

            assert!(matches!(
                observation.interface,
                TunObservationComponentState::Partial | TunObservationComponentState::Unknown
            ));
            assert!(!observation.confirms_enabled_at(tun_observation_now()));
            client.stop(process).await.unwrap();
            server.abort();
        }
    }

    #[tokio::test]
    async fn cleanup_failure_keeps_residual_network_effects_observable() {
        let baseline = baseline_snapshot();
        let healthy = healthy_snapshot();
        let (_temporary, client, binary, home, config_file, server) = fixture(
            vec![baseline, healthy.clone(), healthy.clone(), healthy],
            Ok(vec!["utun1".into()]),
        )
        .await;
        let request = PrivilegedCoreLaunchRequest::new(binary, home, config_file, "v1.19.29");
        let process = client.start(request).await.unwrap();

        client.stop(process).await.unwrap();
        let observation = client.observe_tun().await.unwrap();

        assert_eq!(observation.core, TunObservationComponentState::Absent);
        assert_eq!(
            observation.interface,
            TunObservationComponentState::Confirmed
        );
        assert!(!observation.confirms_disabled_at(tun_observation_now()));
        server.abort();
    }

    #[tokio::test]
    async fn configuration_intent_without_network_effects_never_confirms_tun() {
        let baseline = baseline_snapshot();
        let (_temporary, client, binary, home, config_file, server) = fixture(
            vec![
                baseline.clone(),
                baseline.clone(),
                baseline.clone(),
                baseline,
            ],
            Ok(Vec::new()),
        )
        .await;
        let request = PrivilegedCoreLaunchRequest::new(binary, home, config_file, "v1.19.29");
        let process = client.start(request).await.unwrap();
        let observation = client.observe_tun().await.unwrap();

        assert_eq!(observation.core, TunObservationComponentState::Confirmed);
        assert_eq!(observation.interface, TunObservationComponentState::Absent);
        assert!(!observation.confirms_enabled_at(tun_observation_now()));

        client.stop(process).await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn development_service_rejects_configuration_outside_the_runtime_root() {
        let (temporary, client, binary, home, _config_file, server) =
            fixture(vec![baseline_snapshot()], Ok(Vec::new())).await;
        let outside = temporary.path().join("outside.yaml");
        fs::write(&outside, "tun:\n  enable: true\n").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
        let request = PrivilegedCoreLaunchRequest::new(binary, home, outside, "v1.19.29");
        assert_eq!(
            client.start(request).await,
            Err(PrivilegedCoreHostError::Rejected)
        );
        server.abort();
    }

    #[tokio::test]
    async fn development_lifecycle_invokes_only_the_bounded_installer_actions() {
        let repository = tempfile::tempdir().unwrap();
        let scripts = repository.path().join("scripts");
        fs::create_dir(&scripts).unwrap();
        let installer = scripts.join("manage-macos-tun-service.ts");
        fs::write(
            &installer,
            "import { writeFileSync } from 'node:fs';\nwriteFileSync('observed-action.txt', process.argv[2]);\nprocess.stdout.write(JSON.stringify({ ok: true }));\n",
        )
        .unwrap();
        fs::set_permissions(&installer, fs::Permissions::from_mode(0o644)).unwrap();
        let client = MacOsTunServiceClient {
            lifecycle: Some(DevelopmentTunLifecycle {
                repository_root: repository.path().to_path_buf(),
                script_path: installer,
            }),
            socket_path: repository.path().join("unused.sock"),
        };

        for (operation, expected) in [
            (TunHelperLifecycleOperation::Install, "install"),
            (TunHelperLifecycleOperation::Repair, "repair"),
            (TunHelperLifecycleOperation::Remove, "uninstall"),
        ] {
            client.run_lifecycle(operation).await.unwrap();
            assert_eq!(
                fs::read_to_string(repository.path().join("observed-action.txt")).unwrap(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn development_lifecycle_preserves_the_installer_failure_kind() {
        let repository = tempfile::tempdir().unwrap();
        let scripts = repository.path().join("scripts");
        fs::create_dir(&scripts).unwrap();
        let installer = scripts.join("manage-macos-tun-service.ts");
        fs::write(
            &installer,
            "process.stdout.write(JSON.stringify({ ok: false, kind: 'preparation-failed' }));\nprocess.exitCode = 1;\n",
        )
        .unwrap();
        fs::set_permissions(&installer, fs::Permissions::from_mode(0o644)).unwrap();
        let client = MacOsTunServiceClient {
            lifecycle: Some(DevelopmentTunLifecycle {
                repository_root: repository.path().to_path_buf(),
                script_path: installer,
            }),
            socket_path: repository.path().join("unused.sock"),
        };

        let error = client
            .run_lifecycle(TunHelperLifecycleOperation::Install)
            .await
            .unwrap_err();

        assert_eq!(error.kind, TunHelperFailureKind::PreparationFailed);
    }
}
