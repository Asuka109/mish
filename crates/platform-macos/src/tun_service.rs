use std::{
    collections::{HashMap, VecDeque},
    ffi::OsStr,
    fs,
    io::{Read, Write},
    net::IpAddr,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
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
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    process::{Child, Command},
    sync::Mutex,
    time::timeout,
};

use crate::{
    MacOsCommand, MacOsCommandRunner, MacOsSystemCommandRunner,
    installation_key::{
        AuthenticationTranscript, DEV_TUN_INSTALLATION_KEY_ALGORITHM,
        DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION, InstallationClientKeyStore,
        InstallationEnrollmentRecord, load_installation_enrollment, verify_installation_signature,
    },
};

mod network_ownership;

use network_ownership::{
    MacOsTunNetworkController, NetworkApplyFailure, NetworkOwnershipObservation,
    NetworkOwnershipSnapshot, NetworkRecoveryJournal, TunNetworkController,
    apply_network_transaction, encode_watchdog_dns, restore_network_transaction,
    restore_network_transaction_if_recorded,
};
pub use network_ownership::{ManagedDnsState, parse_watchdog_dns};

pub const DEV_TUN_SERVICE_LABEL: &str = "com.asuka109.mish.tun-helper.dev";
pub const DEV_TUN_SERVICE_CORE_PATH: &str =
    "/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev";
pub const DEV_TUN_SERVICE_HELPER_PATH: &str =
    "/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev";
pub const DEV_TUN_SERVICE_PLIST_PATH: &str =
    "/Library/LaunchDaemons/com.asuka109.mish.tun-helper.dev.plist";
pub const DEV_TUN_SERVICE_SOCKET_PREFIX: &str = "/var/run/com.asuka109.mish.tun-helper";
const CONFIG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const DEV_CORE_HOST_REQUEST_MAX_AGE_MILLISECONDS: u64 = 10_000;
const DEV_CORE_HOST_REQUEST_FUTURE_SKEW_MILLISECONDS: u64 = 1_000;
const DEV_CORE_HOST_REPLAY_WINDOW: usize = 256;
const DEV_CORE_HOST_MAX_OUTSTANDING_CHALLENGES: usize = 64;
const DEV_CORE_HOST_CHALLENGE_LIFETIME_MILLISECONDS: u64 = 5_000;
const DEV_CORE_HOST_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const PINNED_CORE_MANIFEST: &str = include_str!("../../../resources/mihomo/macos-arm64.json");

pub fn development_pinned_core_version() -> Result<String, &'static str> {
    let manifest: PinnedCoreManifest =
        serde_json::from_str(PINNED_CORE_MANIFEST).map_err(|_| "invalid pinned Core manifest")?;
    if manifest.schema_version != 1 || !valid_version(&manifest.version) {
        return Err("invalid pinned Core manifest");
    }
    Ok(manifest.version)
}

pub fn verify_development_pinned_core(binary: &Path) -> Result<(), &'static str> {
    let manifest: PinnedCoreManifest =
        serde_json::from_str(PINNED_CORE_MANIFEST).map_err(|_| "invalid pinned Core manifest")?;
    if manifest.schema_version != 1
        || !valid_installation_id(&manifest.archive_sha256)
        || !valid_installation_id(&manifest.binary_sha256)
        || manifest.repository != "MetaCubeX/mihomo"
        || manifest.asset != format!("mihomo-darwin-arm64-{}.gz", manifest.version)
        || !valid_version(&manifest.version)
    {
        return Err("invalid pinned Core manifest");
    }
    verify_development_core_file(binary)?;
    verify_core_digest(binary, &manifest.binary_sha256)
        .map_err(|_| "the pinned development Core digest did not match")
}

pub fn verify_development_core_file(binary: &Path) -> Result<(), &'static str> {
    if !binary.is_absolute() {
        return Err("the development Core path must be absolute");
    }
    let metadata = fs::symlink_metadata(binary).map_err(|_| "the development Core is absent")?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.permissions().mode() & 0o777 != 0o755
    {
        return Err("the development Core must be a regular executable with mode 0755");
    }
    Ok(())
}
const BOUNDED_STEP_TIMEOUT: Duration = Duration::from_secs(5);
const FORCED_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const CLIENT_RESPONSE_SLACK: Duration = Duration::from_secs(1);
const STARTUP_SETTLE_TIME: Duration = Duration::from_millis(150);
const TUN_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(5);
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
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum ServiceCommand {
    Health,
    Status,
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
    Enable,
    Stop {
        launch_token: String,
    },
    Disable,
    StopAll,
}

impl ServiceCommand {
    fn operation(&self) -> &'static str {
        match self {
            Self::Health => "health",
            Self::Status => "status",
            Self::Observe { .. } => "observe",
            Self::OwnsListener { .. } => "owns-listener",
            Self::Start { .. } => "start",
            Self::Enable => "enable",
            Self::Stop { .. } => "stop",
            Self::Disable => "disable",
            Self::StopAll => "stop-all",
        }
    }

    fn digest(&self) -> Result<[u8; 32], ()> {
        let bytes = serde_json::to_vec(self).map_err(|_| ())?;
        Ok(Sha256::digest(bytes).into())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum ServiceClientMessage {
    Challenge {
        client_nonce: String,
        command: ServiceCommand,
        protocol_version: u16,
        request_id: String,
    },
    Discovery {
        command: ServiceCommand,
        protocol_version: u16,
        request_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceProof {
    challenge_id: String,
    signature: String,
    transcript_version: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum ServiceServerMessage {
    Challenge { challenge: ServiceChallenge },
    Discovery { discovery: ServiceDiscovery },
    Response { response: ServiceResponse },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceDiscovery {
    algorithm: String,
    generation: u64,
    helper_version: String,
    installation_id: String,
    key_id: String,
    protocol_version: u16,
    request_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceChallenge {
    algorithm: String,
    challenge_id: String,
    client_nonce: String,
    command_digest: String,
    expires_at: u64,
    generation: u64,
    helper_nonce: String,
    installation_id: String,
    issued_at: u64,
    key_id: String,
    operation: String,
    peer_pid: u32,
    peer_uid: u32,
    protocol_version: u16,
    request_id: String,
    transcript_version: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceResponse {
    diagnostic: Option<ServiceDiagnosticCode>,
    ok: bool,
    request_id: String,
    status: ServiceStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ServiceDiagnosticCode {
    AlreadyOwned,
    AuthenticationRejected,
    ChallengeExpired,
    CoreDigestMismatch,
    CoreVersionMismatch,
    InvalidRequest,
    OwnerMismatch,
    PathRejected,
    ReplayRejected,
    SpawnFailed,
    StaleRequest,
    StopFailed,
    TunForbidden,
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
    flags: String,
    gateway: String,
    interface: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TunSystemDnsResolver {
    domains: Vec<String>,
    interface: Option<String>,
    nameservers: Vec<IpAddr>,
    port: Option<u16>,
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
        if !valid_interface_name(interface)
            || fields[0].len() > 64
            || fields[1].len() > 128
            || fields[2].len() > 64
            || fields[..3]
                .iter()
                .any(|field| field.chars().any(char::is_control))
        {
            continue;
        }
        if routes.len() >= TUN_ROUTE_LIMIT {
            return Err(());
        }
        routes.push(TunSystemRoute {
            destination: fields[0].to_owned(),
            flags: fields[2].to_owned(),
            gateway: fields[1].to_owned(),
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
        let implicit_mdns = resolver.nameservers.is_empty()
            && resolver
                .domains
                .iter()
                .any(|domain| domain.eq_ignore_ascii_case("local"));
        if (!implicit_mdns && resolver.nameservers.is_empty()) || resolvers.contains(&resolver) {
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
                domains: Vec::new(),
                interface: None,
                nameservers: Vec::new(),
                port: None,
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
        if line.starts_with("domain") || line.starts_with("search domain[") {
            let resolver = current.as_mut().ok_or(())?;
            let value = line
                .split_once(':')
                .map(|(_, value)| value.trim().trim_end_matches('.'))
                .filter(|value| {
                    !value.is_empty() && value.len() <= 253 && !value.chars().any(char::is_control)
                })
                .ok_or(())?;
            if !resolver.domains.iter().any(|domain| domain == value) {
                if resolver.domains.len() >= 16 {
                    return Err(());
                }
                resolver.domains.push(value.to_owned());
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
            resolver.port = Some(
                line.split_once(':')
                    .map(|(_, value)| value.trim())
                    .ok_or(())?
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port != 0)
                    .ok_or(())?,
            );
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
        .filter(|resolver| resolver.port.unwrap_or(53) == 53)
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
    client_keys: Option<InstallationClientKeyStore>,
    lifecycle: Option<DevelopmentTunLifecycle>,
    socket_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DevelopmentTunStartup {
    Ready,
    ReadOnly(TunHelperFailureKind),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DevelopmentCoreHostStatus {
    pub core: Option<PrivilegedCoreProcess>,
    pub helper_version: String,
    pub installation_id: String,
    pub observation: TunNetworkObservation,
}

#[derive(Clone, Debug)]
struct DevelopmentTunLifecycle {
    repository_root: PathBuf,
    script_path: PathBuf,
    tart_tun_acceptance: bool,
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
            client_keys: None,
            lifecycle: None,
            socket_path,
        }
    }

    pub fn new_with_installation_keys(
        socket_path: PathBuf,
        client_keys: InstallationClientKeyStore,
    ) -> Self {
        Self {
            client_keys: Some(client_keys),
            lifecycle: None,
            socket_path,
        }
    }

    pub fn development() -> Self {
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        let runtime_root = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .map(|home| home.join("Library/Application Support/com.asuka109.mish/runtime"));
        match runtime_root {
            Some(runtime_root) => Self::new_with_installation_keys(
                development_socket_path(uid),
                InstallationClientKeyStore::for_runtime_root(&runtime_root, uid),
            ),
            None => Self::new(development_socket_path(uid)),
        }
    }

    pub fn development_with_lifecycle(repository_root: PathBuf) -> Self {
        Self::development_with_lifecycle_boundary(repository_root, false)
    }

    pub fn development_with_tart_tun_acceptance(repository_root: PathBuf) -> Self {
        Self::development_with_lifecycle_boundary(repository_root, true)
    }

    fn development_with_lifecycle_boundary(
        repository_root: PathBuf,
        tart_tun_acceptance: bool,
    ) -> Self {
        let mut client = Self::development();
        client.lifecycle = Some(DevelopmentTunLifecycle {
            script_path: repository_root.join("scripts/manage-macos-tun-service.ts"),
            repository_root,
            tart_tun_acceptance,
        });
        client
    }

    async fn request(&self, command: ServiceCommand) -> Result<ServiceStatus, ServiceClientError> {
        let request_timeout = service_request_timeout(&command);
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut client_nonce = [0_u8; 32];
        OsRng.fill_bytes(&mut client_nonce);
        let request = ServiceClientMessage::Challenge {
            client_nonce: BASE64.encode(client_nonce),
            command: command.clone(),
            protocol_version: TUN_HELPER_PROTOCOL_VERSION,
            request_id: request_id.clone(),
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
            let challenge = read_service_message(&mut stream).await?;
            let challenge = match challenge {
                ServiceServerMessage::Challenge { challenge } => challenge,
                ServiceServerMessage::Response { response } => {
                    return Err(map_service_response_error(response));
                }
                ServiceServerMessage::Discovery { .. } => {
                    return Err(ServiceClientError::Protocol);
                }
            };
            let command_digest = command.digest().map_err(|_| ServiceClientError::Protocol)?;
            if challenge.request_id != request_id
                || challenge.protocol_version != TUN_HELPER_PROTOCOL_VERSION
                || challenge.transcript_version != DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION
                || challenge.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
                || challenge.operation != command.operation()
                || challenge.command_digest != BASE64.encode(command_digest)
                || challenge.peer_uid != unsafe { libc::getuid() }
                || challenge.peer_pid != std::process::id()
                || challenge.issued_at
                    > tun_observation_now()
                        .saturating_add(DEV_CORE_HOST_REQUEST_FUTURE_SKEW_MILLISECONDS)
                || challenge.expires_at <= challenge.issued_at
                || challenge.expires_at.saturating_sub(challenge.issued_at)
                    > DEV_CORE_HOST_CHALLENGE_LIFETIME_MILLISECONDS
                || tun_observation_now() > challenge.expires_at
            {
                return Err(ServiceClientError::Protocol);
            }
            let helper_nonce =
                decode_nonce(&challenge.helper_nonce).map_err(|_| ServiceClientError::Protocol)?;
            let challenged_client_nonce =
                decode_nonce(&challenge.client_nonce).map_err(|_| ServiceClientError::Protocol)?;
            if challenged_client_nonce != client_nonce {
                return Err(ServiceClientError::Protocol);
            }
            let transcript = AuthenticationTranscript {
                client_nonce,
                command_digest,
                expires_at: challenge.expires_at,
                helper_installation_id: challenge.installation_id.clone(),
                helper_nonce,
                issued_at: challenge.issued_at,
                key_generation: challenge.generation,
                key_id: challenge.key_id.clone(),
                operation: challenge.operation.clone(),
                peer_pid: challenge.peer_pid,
                peer_uid: challenge.peer_uid,
                protocol_version: challenge.protocol_version,
                request_id: request_id.clone(),
            }
            .canonical_bytes()
            .map_err(|_| ServiceClientError::Protocol)?;
            let key_store = self
                .client_keys
                .as_ref()
                .ok_or(ServiceClientError::Rejected)?;
            let (signature, key_source) = key_store
                .sign(&challenge.key_id, &transcript)
                .map_err(|_| ServiceClientError::Rejected)?;
            let proof = ServiceProof {
                challenge_id: challenge.challenge_id,
                signature: BASE64.encode(signature),
                transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
            };
            write_service_frame(&mut stream, &proof).await?;
            let response = match read_service_message(&mut stream).await? {
                ServiceServerMessage::Response { response } => response,
                _ => return Err(ServiceClientError::Protocol),
            };
            if response.request_id != request_id {
                return Err(ServiceClientError::Protocol);
            }
            if !response.ok {
                return Err(map_service_response_error(response));
            }
            let _ = key_store.finalize_pending(key_source);
            Ok(response.status)
        };
        timeout(request_timeout, operation)
            .await
            .map_err(|_| ServiceClientError::Unavailable)?
    }

    async fn health(&self) -> Result<ServiceDiscovery, ServiceClientError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let message = ServiceClientMessage::Discovery {
            command: ServiceCommand::Health,
            protocol_version: TUN_HELPER_PROTOCOL_VERSION,
            request_id: request_id.clone(),
        };
        let operation = async {
            let mut stream = UnixStream::connect(&self.socket_path)
                .await
                .map_err(|_| ServiceClientError::Unavailable)?;
            write_service_frame(&mut stream, &message).await?;
            let discovery = match read_service_message(&mut stream).await? {
                ServiceServerMessage::Discovery { discovery } => discovery,
                ServiceServerMessage::Response { response } => {
                    return Err(map_service_response_error(response));
                }
                ServiceServerMessage::Challenge { .. } => {
                    return Err(ServiceClientError::Protocol);
                }
            };
            if discovery.request_id != request_id
                || discovery.protocol_version != TUN_HELPER_PROTOCOL_VERSION
                || discovery.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
                || !valid_installation_id(&discovery.installation_id)
                || !valid_installation_id(&discovery.key_id)
                || discovery.generation == 0
            {
                return Err(ServiceClientError::Protocol);
            }
            Ok(discovery)
        };
        timeout(BOUNDED_STEP_TIMEOUT + CLIENT_RESPONSE_SLACK, operation)
            .await
            .map_err(|_| ServiceClientError::Unavailable)?
    }

    pub async fn core_host_status(&self) -> Result<DevelopmentCoreHostStatus, &'static str> {
        self.request(ServiceCommand::Status)
            .await
            .map(|status| DevelopmentCoreHostStatus {
                core: status.core.map(Into::into),
                helper_version: status.helper_version,
                installation_id: status.installation_id,
                observation: status.observation,
            })
            .map_err(|error| match error {
                ServiceClientError::Unavailable => "core-host-unavailable",
                ServiceClientError::Protocol => "core-host-protocol-mismatch",
                ServiceClientError::Rejected => "core-host-request-rejected",
                ServiceClientError::OperationFailed => "core-host-operation-failed",
            })
    }

    pub async fn disable_core_host(&self) -> Result<(), &'static str> {
        self.request(ServiceCommand::Disable)
            .await
            .map(|_| ())
            .map_err(|error| match error {
                ServiceClientError::Unavailable => "core-host-unavailable",
                ServiceClientError::Protocol => "core-host-protocol-mismatch",
                ServiceClientError::Rejected => "core-host-request-rejected",
                ServiceClientError::OperationFailed => "core-host-operation-failed",
            })
    }

    pub async fn prepare_development_startup(&self) -> DevelopmentTunStartup {
        let status = match self.request(ServiceCommand::Status).await {
            Ok(status) => status,
            Err(_) => {
                return DevelopmentTunStartup::ReadOnly(TunHelperFailureKind::ConnectionFailed);
            }
        };
        let now = tun_observation_now();
        if !status.observation.is_fresh_at(now) {
            return DevelopmentTunStartup::ReadOnly(TunHelperFailureKind::ObservationStale);
        }
        if [
            status.observation.core,
            status.observation.interface,
            status.observation.routes,
            status.observation.dns,
        ]
        .contains(&TunObservationComponentState::Foreign)
        {
            return DevelopmentTunStartup::ReadOnly(TunHelperFailureKind::ObservationForeign);
        }
        if status.core.is_none() && status.observation.confirms_disabled_at(now) {
            return DevelopmentTunStartup::Ready;
        }
        match self.request(ServiceCommand::Disable).await {
            Ok(cleaned)
                if cleaned
                    .observation
                    .confirms_disabled_at(tun_observation_now()) =>
            {
                DevelopmentTunStartup::Ready
            }
            Ok(cleaned) => DevelopmentTunStartup::ReadOnly(
                cleaned.observation.failure_kind_at(tun_observation_now()),
            ),
            Err(_) => DevelopmentTunStartup::ReadOnly(TunHelperFailureKind::OperationFailed),
        }
    }
}

fn service_request_timeout(command: &ServiceCommand) -> Duration {
    let server_budget = match command {
        ServiceCommand::Health
        | ServiceCommand::Status
        | ServiceCommand::Enable
        | ServiceCommand::Observe { .. }
        | ServiceCommand::OwnsListener { .. } => BOUNDED_STEP_TIMEOUT,
        ServiceCommand::Start { .. } => BOUNDED_STEP_TIMEOUT * 3 + STARTUP_SETTLE_TIME,
        ServiceCommand::Stop { .. } | ServiceCommand::Disable | ServiceCommand::StopAll => {
            BOUNDED_STEP_TIMEOUT * 2 + FORCED_STOP_TIMEOUT
        }
    };
    server_budget + CLIENT_RESPONSE_SLACK
}

async fn write_service_frame<T: Serialize>(
    stream: &mut UnixStream,
    value: &T,
) -> Result<(), ServiceClientError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ServiceClientError::Protocol)?;
    if bytes.len() > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(ServiceClientError::Protocol);
    }
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|_| ServiceClientError::Unavailable)?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| ServiceClientError::Unavailable)
}

async fn read_service_message(
    stream: &mut UnixStream,
) -> Result<ServiceServerMessage, ServiceClientError> {
    let length = stream
        .read_u32()
        .await
        .map_err(|_| ServiceClientError::Unavailable)? as usize;
    if length == 0 || length > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(ServiceClientError::Protocol);
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| ServiceClientError::Unavailable)?;
    serde_json::from_slice(&bytes).map_err(|_| ServiceClientError::Protocol)
}

fn map_service_response_error(response: ServiceResponse) -> ServiceClientError {
    match response.diagnostic {
        Some(
            ServiceDiagnosticCode::AlreadyOwned
            | ServiceDiagnosticCode::AuthenticationRejected
            | ServiceDiagnosticCode::ChallengeExpired
            | ServiceDiagnosticCode::CoreDigestMismatch
            | ServiceDiagnosticCode::CoreVersionMismatch
            | ServiceDiagnosticCode::InvalidRequest
            | ServiceDiagnosticCode::OwnerMismatch
            | ServiceDiagnosticCode::PathRejected
            | ServiceDiagnosticCode::ReplayRejected
            | ServiceDiagnosticCode::StaleRequest
            | ServiceDiagnosticCode::TunForbidden,
        ) => ServiceClientError::Rejected,
        Some(ServiceDiagnosticCode::SpawnFailed | ServiceDiagnosticCode::StopFailed) | None => {
            ServiceClientError::OperationFailed
        }
    }
}

fn decode_nonce(value: &str) -> Result<[u8; 32], ()> {
    let bytes = BASE64.decode(value).map_err(|_| ())?;
    bytes.try_into().map_err(|_| ())
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
            let mut command = Command::new(node);
            command.arg(script_path).arg(action);
            if lifecycle.tart_tun_acceptance {
                command.arg("--tart-tun-acceptance");
            }
            let output = command
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
            self.request(ServiceCommand::Status)
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
            let mut status = if enabled {
                self.request(ServiceCommand::Enable).await
            } else {
                self.request(ServiceCommand::Disable).await
            }
            .map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The development TUN service operation failed",
                )
            })?;
            let deadline = tokio::time::Instant::now() + TUN_CONFIRMATION_TIMEOUT;
            loop {
                let confirmed = if enabled {
                    status
                        .observation
                        .confirms_enabled_at(tun_observation_now())
                } else {
                    status
                        .observation
                        .confirms_disabled_at(tun_observation_now())
                };
                if confirmed {
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(TunHelperError::new(
                        status.observation.failure_kind_at(tun_observation_now()),
                        if enabled {
                            "The privileged Mihomo Core did not enable TUN"
                        } else {
                            "The privileged Mihomo Core did not clean up TUN"
                        },
                    ));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                status = self.request(ServiceCommand::Status).await.map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::OperationFailed,
                        "The development TUN service operation failed",
                    )
                })?;
            }
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
    pub allow_tun: bool,
    pub enrollment_record: PathBuf,
    pub installation_id: String,
    pub pinned_binary_sha256: String,
    pub pinned_version: String,
    pub require_root: bool,
    pub runtime_root: PathBuf,
    pub socket_path: PathBuf,
    pub spawn_watchdog: bool,
    network_controller: Arc<dyn TunNetworkController>,
    observer: Arc<dyn TunSystemObserver>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinnedCoreManifest {
    archive_sha256: String,
    asset: String,
    binary_sha256: String,
    repository: String,
    schema_version: u16,
    version: String,
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
        let manifest: PinnedCoreManifest = serde_json::from_str(PINNED_CORE_MANIFEST)
            .map_err(|_| "invalid pinned Core manifest")?;
        if manifest.schema_version != 1
            || !valid_installation_id(&manifest.archive_sha256)
            || !valid_installation_id(&manifest.binary_sha256)
            || manifest.repository != "MetaCubeX/mihomo"
            || manifest.asset != format!("mihomo-darwin-arm64-{}.gz", manifest.version)
            || !valid_version(&manifest.version)
        {
            return Err("invalid pinned Core manifest");
        }
        Ok(Self {
            allowed_binary: required_path("MISH_TUN_SERVICE_CORE_BINARY")?,
            allowed_uid,
            allow_tun: development_tun_allowed(
                std::env::var_os("MISH_TUN_SERVICE_ALLOW_TUN").as_deref(),
            )?,
            enrollment_record: required_path("MISH_TUN_SERVICE_ENROLLMENT_RECORD")?,
            installation_id,
            pinned_binary_sha256: manifest.binary_sha256,
            pinned_version: manifest.version,
            require_root: true,
            runtime_root: required_path("MISH_TUN_SERVICE_RUNTIME_ROOT")?,
            socket_path: required_path("MISH_TUN_SERVICE_SOCKET")?,
            spawn_watchdog: true,
            network_controller: Arc::new(MacOsTunNetworkController::new()),
            observer: Arc::new(MacOsTunSystemObserver::new()),
        })
    }
}

fn development_tun_allowed(value: Option<&OsStr>) -> Result<bool, &'static str> {
    match value {
        None => Ok(false),
        Some(value) if value == OsStr::new("0") => Ok(false),
        Some(value) if value == OsStr::new("1") => Ok(true),
        Some(_) => Err("invalid development TUN boundary"),
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
    owner_pid: u32,
    pid: u32,
    sealed_config: PathBuf,
    watchdog: Option<ServiceWatchdog>,
}

struct ServiceWatchdog {
    launchd_label: String,
}

#[derive(Clone)]
struct OwnedTunInterface {
    addresses: Vec<String>,
    name: String,
}

struct ServiceTunOwnership {
    baseline_interfaces: Vec<String>,
    dns_applied: bool,
    interface: Option<OwnedTunInterface>,
    network: Option<NetworkOwnershipSnapshot>,
    routes: Option<Vec<TunSystemRoute>>,
}

#[derive(Default)]
struct ServiceState {
    pending_network_recovery: Option<Result<ManagedDnsState, ()>>,
    process: Option<ServiceProcess>,
    tun: Option<ServiceTunOwnership>,
}

#[derive(Default)]
struct ServiceRequestGate {
    outstanding: HashMap<String, OutstandingChallenge>,
    recent: VecDeque<String>,
}

struct OutstandingChallenge {
    challenge: ServiceChallenge,
    client_nonce: [u8; 32],
    command: ServiceCommand,
    command_digest: [u8; 32],
    helper_nonce: [u8; 32],
}

#[derive(Clone)]
struct ServiceContext {
    allowed_binary: PathBuf,
    allowed_uid: u32,
    allow_tun: bool,
    enrollment: Arc<InstallationEnrollmentRecord>,
    installation_id: Arc<str>,
    network_recovery: NetworkRecoveryJournal,
    observer: Arc<dyn TunSystemObserver>,
    network_controller: Arc<dyn TunNetworkController>,
    pinned_binary_sha256: String,
    pinned_version: String,
    request_gate: Arc<Mutex<ServiceRequestGate>>,
    manage_network: bool,
    runtime_root: PathBuf,
    sealed_root: PathBuf,
    spawn_watchdog: bool,
    state: Arc<Mutex<ServiceState>>,
}

impl ServiceRequestGate {
    fn begin(
        &mut self,
        command: ServiceCommand,
        client_nonce: [u8; 32],
        peer: PeerIdentity,
        request_id: &str,
        enrollment: &InstallationEnrollmentRecord,
        now: u64,
    ) -> Result<ServiceChallenge, ServiceDiagnosticCode> {
        if !valid_token(request_id) {
            return Err(ServiceDiagnosticCode::InvalidRequest);
        }
        if self.recent.iter().any(|seen| seen == request_id)
            || self
                .outstanding
                .values()
                .any(|outstanding| outstanding.challenge.request_id == request_id)
        {
            return Err(ServiceDiagnosticCode::ReplayRejected);
        }
        if self.outstanding.len() >= DEV_CORE_HOST_MAX_OUTSTANDING_CHALLENGES {
            return Err(ServiceDiagnosticCode::AuthenticationRejected);
        }
        let command_digest = command
            .digest()
            .map_err(|_| ServiceDiagnosticCode::InvalidRequest)?;
        let mut helper_nonce = [0_u8; 32];
        OsRng.fill_bytes(&mut helper_nonce);
        let challenge_id = uuid::Uuid::new_v4().to_string();
        let challenge = ServiceChallenge {
            algorithm: enrollment.algorithm.clone(),
            challenge_id: challenge_id.clone(),
            client_nonce: BASE64.encode(client_nonce),
            command_digest: BASE64.encode(command_digest),
            expires_at: now.saturating_add(DEV_CORE_HOST_CHALLENGE_LIFETIME_MILLISECONDS),
            generation: enrollment.generation,
            helper_nonce: BASE64.encode(helper_nonce),
            installation_id: enrollment.helper_installation_id.clone(),
            issued_at: now,
            key_id: enrollment.key_id.clone(),
            operation: command.operation().to_owned(),
            peer_pid: peer.pid,
            peer_uid: peer.uid,
            protocol_version: TUN_HELPER_PROTOCOL_VERSION,
            request_id: request_id.to_owned(),
            transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
        };
        self.outstanding.insert(
            challenge_id,
            OutstandingChallenge {
                challenge: challenge.clone(),
                client_nonce,
                command,
                command_digest,
                helper_nonce,
            },
        );
        self.recent.push_back(request_id.to_owned());
        while self.recent.len() > DEV_CORE_HOST_REPLAY_WINDOW {
            self.recent.pop_front();
        }
        Ok(challenge)
    }

    fn take(&mut self, challenge_id: &str) -> Option<OutstandingChallenge> {
        self.outstanding.remove(challenge_id)
    }

    fn cancel(&mut self, challenge_id: &str) {
        self.outstanding.remove(challenge_id);
    }
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
    verify_core_digest(&allowed_binary, &config.pinned_binary_sha256)
        .map_err(|_| "the pinned Core digest did not match")?;
    let runtime_root = validate_runtime_root(&config.runtime_root, config.allowed_uid)?;
    let enrollment = load_installation_enrollment(
        &config.enrollment_record,
        config.allowed_uid,
        config.require_root,
        &config.installation_id,
    )?;
    let recovery_owner_uid = if config.require_root {
        0
    } else {
        config.allowed_uid
    };
    let network_recovery =
        NetworkRecoveryJournal::for_enrollment(&config.enrollment_record, recovery_owner_uid)
            .map_err(|_| "the network recovery path was invalid")?;
    let pending_network_recovery = match network_recovery.load() {
        Ok(Some(recovery)) => {
            if restore_network_transaction(
                config.network_controller.as_ref(),
                &network_recovery,
                &recovery,
            )
            .await
            .is_ok()
            {
                None
            } else {
                Some(Ok(recovery))
            }
        }
        Ok(None) => None,
        Err(()) => Some(Err(())),
    };
    let sealed_root = PathBuf::from(format!("{}.state", config.socket_path.display()));
    reset_sealed_root(&sealed_root, config.allowed_uid, config.require_root)?;
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
    let context = ServiceContext {
        allowed_binary,
        allowed_uid: config.allowed_uid,
        allow_tun: config.allow_tun,
        enrollment: Arc::new(enrollment),
        installation_id: config.installation_id.into(),
        network_controller: config.network_controller,
        network_recovery,
        observer: config.observer,
        pinned_binary_sha256: config.pinned_binary_sha256,
        pinned_version: config.pinned_version,
        request_gate: Arc::new(Mutex::new(ServiceRequestGate::default())),
        manage_network: config.allow_tun && config.require_root,
        runtime_root,
        sealed_root,
        spawn_watchdog: config.spawn_watchdog,
        state: Arc::new(Mutex::new(ServiceState {
            pending_network_recovery,
            process: None,
            tun: None,
        })),
    };
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|_| "termination handler failed")?;
    let mut owner_monitor = tokio::time::interval(Duration::from_secs(1));
    loop {
        #[cfg(unix)]
        let accepted = tokio::select! {
            accepted = listener.accept() => Some(accepted),
            _ = terminate.recv() => None,
            _ = owner_monitor.tick() => {
                let mut state = context.state.lock().await;
                if state
                    .process
                    .as_ref()
                    .is_some_and(|process| !process_alive(process.owner_pid))
                {
                    stop_process(
                        &mut state,
                        context.network_controller.as_ref(),
                        &context.network_recovery,
                    )
                        .await
                        .map_err(|_| "orphaned managed Core cleanup failed")?;
                }
                continue;
            }
        };
        #[cfg(not(unix))]
        let accepted = Some(listener.accept().await);
        let Some(accepted) = accepted else {
            break;
        };
        let (stream, _) = accepted.map_err(|_| "socket accept failed")?;
        let peer = peer_identity(&stream)?;
        if peer.uid != config.allowed_uid {
            continue;
        }
        let context = context.clone();
        tokio::spawn(async move {
            let _ = handle_connection(stream, peer, context).await;
        });
    }
    let mut state = context.state.lock().await;
    restore_pending_network_recovery(
        &mut state,
        context.network_controller.as_ref(),
        &context.network_recovery,
    )
    .await
    .map_err(|_| "pending network recovery failed")?;
    stop_process(
        &mut state,
        context.network_controller.as_ref(),
        &context.network_recovery,
    )
    .await
    .map_err(|_| "managed Core cleanup failed")?;
    drop(state);
    fs::remove_file(&config.socket_path).map_err(|_| "socket cleanup failed")?;
    fs::remove_dir(&context.sealed_root).map_err(|_| "sealed config cleanup failed")?;
    Ok(())
}

async fn handle_connection(
    mut stream: UnixStream,
    peer: PeerIdentity,
    context: ServiceContext,
) -> Result<(), ()> {
    let first = timeout(
        DEV_CORE_HOST_HANDSHAKE_TIMEOUT,
        read_service_frame::<ServiceClientMessage>(&mut stream),
    )
    .await
    .map_err(|_| ())??;
    match first {
        ServiceClientMessage::Discovery {
            command: ServiceCommand::Health,
            protocol_version,
            request_id,
        } if protocol_version == TUN_HELPER_PROTOCOL_VERSION && valid_token(&request_id) => {
            let discovery = ServiceDiscovery {
                algorithm: context.enrollment.algorithm.clone(),
                generation: context.enrollment.generation,
                helper_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                installation_id: context.installation_id.to_string(),
                key_id: context.enrollment.key_id.clone(),
                protocol_version: TUN_HELPER_PROTOCOL_VERSION,
                request_id,
            };
            return write_server_message(
                &mut stream,
                &ServiceServerMessage::Discovery { discovery },
            )
            .await;
        }
        ServiceClientMessage::Challenge {
            client_nonce,
            command,
            protocol_version,
            request_id,
        } if protocol_version == TUN_HELPER_PROTOCOL_VERSION
            && !matches!(command, ServiceCommand::Health) =>
        {
            let client_nonce = match decode_nonce(&client_nonce) {
                Ok(nonce) => nonce,
                Err(()) => {
                    return write_rejection(
                        &mut stream,
                        ServiceDiagnosticCode::InvalidRequest,
                        request_id,
                        &context.installation_id,
                    )
                    .await;
                }
            };
            let challenge = match context.request_gate.lock().await.begin(
                command,
                client_nonce,
                peer,
                &request_id,
                &context.enrollment,
                tun_observation_now(),
            ) {
                Ok(challenge) => challenge,
                Err(diagnostic) => {
                    return write_rejection(
                        &mut stream,
                        diagnostic,
                        request_id,
                        &context.installation_id,
                    )
                    .await;
                }
            };
            let challenge_id = challenge.challenge_id.clone();
            write_server_message(&mut stream, &ServiceServerMessage::Challenge { challenge })
                .await?;
            let proof = match timeout(
                DEV_CORE_HOST_HANDSHAKE_TIMEOUT,
                read_service_frame::<ServiceProof>(&mut stream),
            )
            .await
            {
                Ok(Ok(proof)) => proof,
                _ => {
                    context.request_gate.lock().await.cancel(&challenge_id);
                    return Err(());
                }
            };
            if proof.challenge_id != challenge_id {
                context.request_gate.lock().await.cancel(&challenge_id);
                return write_rejection(
                    &mut stream,
                    ServiceDiagnosticCode::ReplayRejected,
                    request_id,
                    &context.installation_id,
                )
                .await;
            }
            let Some(outstanding) = context.request_gate.lock().await.take(&challenge_id) else {
                return write_rejection(
                    &mut stream,
                    ServiceDiagnosticCode::ReplayRejected,
                    request_id,
                    &context.installation_id,
                )
                .await;
            };
            let now = tun_observation_now();
            let diagnostic =
                verify_challenge_proof(&outstanding, &proof, &context.enrollment, peer, now).err();
            let response = match diagnostic {
                Some(diagnostic) => ServiceResponse::error(
                    diagnostic,
                    None,
                    TunNetworkObservation::unknown(now),
                    &context.installation_id,
                )
                .with_request_id(request_id),
                None => execute_request(outstanding.command, peer.pid, &request_id, &context)
                    .await
                    .with_request_id(request_id),
            };
            return write_server_message(&mut stream, &ServiceServerMessage::Response { response })
                .await;
        }
        ServiceClientMessage::Discovery { request_id, .. }
        | ServiceClientMessage::Challenge { request_id, .. } => {
            return write_rejection(
                &mut stream,
                ServiceDiagnosticCode::InvalidRequest,
                request_id,
                &context.installation_id,
            )
            .await;
        }
    }
}

async fn read_service_frame<T: for<'de> Deserialize<'de>>(
    stream: &mut UnixStream,
) -> Result<T, ()> {
    let length = stream.read_u32().await.map_err(|_| ())? as usize;
    if length == 0 || length > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await.map_err(|_| ())?;
    serde_json::from_slice(&bytes).map_err(|_| ())
}

async fn write_server_message(
    stream: &mut UnixStream,
    message: &ServiceServerMessage,
) -> Result<(), ()> {
    let bytes = serde_json::to_vec(message).map_err(|_| ())?;
    if bytes.len() > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(());
    }
    stream.write_u32(bytes.len() as u32).await.map_err(|_| ())?;
    stream.write_all(&bytes).await.map_err(|_| ())
}

async fn write_rejection(
    stream: &mut UnixStream,
    diagnostic: ServiceDiagnosticCode,
    request_id: String,
    installation_id: &str,
) -> Result<(), ()> {
    let response = ServiceResponse::error(
        diagnostic,
        None,
        TunNetworkObservation::unknown(tun_observation_now()),
        installation_id,
    )
    .with_request_id(request_id);
    write_server_message(stream, &ServiceServerMessage::Response { response }).await
}

fn verify_challenge_proof(
    outstanding: &OutstandingChallenge,
    proof: &ServiceProof,
    enrollment: &InstallationEnrollmentRecord,
    peer: PeerIdentity,
    now: u64,
) -> Result<(), ServiceDiagnosticCode> {
    let challenge = &outstanding.challenge;
    if proof.transcript_version != DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION
        || challenge.transcript_version != DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION
        || challenge.protocol_version != TUN_HELPER_PROTOCOL_VERSION
        || challenge.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
        || challenge.installation_id != enrollment.helper_installation_id
        || challenge.key_id != enrollment.key_id
        || challenge.generation != enrollment.generation
        || challenge.peer_uid != peer.uid
        || challenge.peer_pid != peer.pid
        || challenge.client_nonce != BASE64.encode(outstanding.client_nonce)
        || challenge.helper_nonce != BASE64.encode(outstanding.helper_nonce)
        || challenge.command_digest != BASE64.encode(outstanding.command_digest)
        || challenge.operation != outstanding.command.operation()
    {
        return Err(ServiceDiagnosticCode::AuthenticationRejected);
    }
    if challenge.issued_at > now.saturating_add(DEV_CORE_HOST_REQUEST_FUTURE_SKEW_MILLISECONDS)
        || now.saturating_sub(challenge.issued_at) > DEV_CORE_HOST_REQUEST_MAX_AGE_MILLISECONDS
        || challenge.expires_at <= challenge.issued_at
        || challenge.expires_at.saturating_sub(challenge.issued_at)
            > DEV_CORE_HOST_CHALLENGE_LIFETIME_MILLISECONDS
        || now > challenge.expires_at
    {
        return Err(ServiceDiagnosticCode::ChallengeExpired);
    }
    let transcript = AuthenticationTranscript {
        client_nonce: outstanding.client_nonce,
        command_digest: outstanding.command_digest,
        expires_at: challenge.expires_at,
        helper_installation_id: challenge.installation_id.clone(),
        helper_nonce: outstanding.helper_nonce,
        issued_at: challenge.issued_at,
        key_generation: challenge.generation,
        key_id: challenge.key_id.clone(),
        operation: challenge.operation.clone(),
        peer_pid: challenge.peer_pid,
        peer_uid: challenge.peer_uid,
        protocol_version: challenge.protocol_version,
        request_id: challenge.request_id.clone(),
    }
    .canonical_bytes()
    .map_err(|_| ServiceDiagnosticCode::AuthenticationRejected)?;
    let signature = BASE64
        .decode(&proof.signature)
        .map_err(|_| ServiceDiagnosticCode::AuthenticationRejected)?;
    verify_installation_signature(enrollment, &transcript, &signature)
        .map_err(|_| ServiceDiagnosticCode::AuthenticationRejected)
}

async fn execute_request(
    command: ServiceCommand,
    peer_pid: u32,
    request_id: &str,
    context: &ServiceContext,
) -> ServiceResponse {
    let allowed_binary = &context.allowed_binary;
    let allowed_uid = context.allowed_uid;
    let allow_tun = context.allow_tun;
    let installation_id = context.installation_id.as_ref();
    let manage_network = context.manage_network;
    let network_controller = &context.network_controller;
    let network_recovery = &context.network_recovery;
    let observer = &context.observer;
    let pinned_binary_sha256 = context.pinned_binary_sha256.as_str();
    let pinned_version = context.pinned_version.as_str();
    let runtime_root = &context.runtime_root;
    let sealed_root = &context.sealed_root;
    let spawn_watchdog = context.spawn_watchdog;
    let state = &context.state;
    match command {
        ServiceCommand::Health | ServiceCommand::Status => {
            status_response(
                state,
                installation_id,
                observer,
                network_controller,
                network_recovery,
            )
            .await
        }
        ServiceCommand::Observe { launch_token } => {
            let status = status_response(
                state,
                installation_id,
                observer,
                network_controller,
                network_recovery,
            )
            .await;
            if status
                .status
                .core
                .as_ref()
                .is_some_and(|core| core.launch_token == launch_token)
                && state
                    .lock()
                    .await
                    .process
                    .as_ref()
                    .is_some_and(|process| process.owner_pid == peer_pid)
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
            let status = status_response(
                state,
                installation_id,
                observer,
                network_controller,
                network_recovery,
            )
            .await;
            let owns = status.status.core.as_ref().is_some_and(|core| {
                core.launch_token == launch_token
                    && owns_listener(core.pid, &host, port).unwrap_or(false)
            }) && state
                .lock()
                .await
                .process
                .as_ref()
                .is_some_and(|process| process.owner_pid == peer_pid);
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
            if state.lock().await.pending_network_recovery.is_some() {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::SpawnFailed,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            if !valid_token(&launch_token)
                || !valid_version(&expected_version)
                || validate_launch_paths(
                    &binary,
                    &config_directory,
                    &config_file,
                    allowed_binary,
                    runtime_root,
                    allowed_uid,
                    allow_tun,
                )
                .is_err()
            {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::PathRejected,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let (config_bytes, tun_requested) =
                match read_validated_candidate_config(&config_file, allowed_uid) {
                    Ok(candidate) => candidate,
                    Err(_) => {
                        return ServiceResponse::error(
                            ServiceDiagnosticCode::PathRejected,
                            None,
                            unknown_tun_observation(),
                            installation_id,
                        );
                    }
                };
            if tun_requested && !allow_tun {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::TunForbidden,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            if expected_version != pinned_version {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::CoreVersionMismatch,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            if verify_core_digest(&binary, pinned_binary_sha256).is_err() {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::CoreDigestMismatch,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            if verify_core_version(&binary, pinned_version).await.is_err() {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::CoreVersionMismatch,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let baseline = observer.observe().await;
            if tun_requested && baseline.is_err() {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::SpawnFailed,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let managed_network = if tun_requested && manage_network {
                match network_controller
                    .snapshot(baseline.as_ref().expect("checked baseline"))
                    .await
                {
                    Ok(state) => Some(state),
                    Err(()) => {
                        return ServiceResponse::error(
                            ServiceDiagnosticCode::SpawnFailed,
                            None,
                            unknown_tun_observation(),
                            installation_id,
                        );
                    }
                }
            } else {
                None
            };
            let mut service_state = state.lock().await;
            reap_if_exited(
                &mut service_state,
                network_controller.as_ref(),
                network_recovery,
            )
            .await;
            let correlation = current_tun_correlation(&service_state, observer.as_ref());
            if let Ok(system) = &baseline {
                let observation =
                    service_state.tun_observation(system, correlation_result(&correlation));
                if observation.confirms_disabled_at(tun_observation_now()) {
                    service_state.tun = None;
                } else if service_state.process.is_none() && service_state.tun.is_none() {
                    return ServiceResponse::error(
                        ServiceDiagnosticCode::SpawnFailed,
                        None,
                        observation,
                        installation_id,
                    );
                }
            }
            if service_state.process.is_some() || service_state.tun.is_some() {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::AlreadyOwned,
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
            let sealed_config = match seal_candidate_config(sealed_root, request_id, &config_bytes)
            {
                Ok(path) => path,
                Err(()) => {
                    return ServiceResponse::error(
                        ServiceDiagnosticCode::SpawnFailed,
                        None,
                        unknown_tun_observation(),
                        installation_id,
                    );
                }
            };
            let child = Command::new(&binary)
                .arg("-d")
                .arg(&config_directory)
                .arg("-f")
                .arg(&sealed_config)
                .env("MISH_MANAGED_CORE_TOKEN", &launch_token)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            let mut child = match child {
                Ok(child) => child,
                Err(_) => {
                    let _ = fs::remove_file(&sealed_config);
                    return ServiceResponse::error(
                        ServiceDiagnosticCode::SpawnFailed,
                        None,
                        unknown_tun_observation(),
                        installation_id,
                    );
                }
            };
            let Some(pid) = child.id() else {
                let _ = child.start_kill();
                let _ = fs::remove_file(&sealed_config);
                return ServiceResponse::error(
                    ServiceDiagnosticCode::SpawnFailed,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            };
            tokio::time::sleep(STARTUP_SETTLE_TIME).await;
            if !matches!(child.try_wait(), Ok(None)) {
                let _ = fs::remove_file(&sealed_config);
                return ServiceResponse::error(
                    ServiceDiagnosticCode::SpawnFailed,
                    None,
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let watchdog = if spawn_watchdog {
                match spawn_core_watchdog(pid, managed_network.as_ref().map(|network| &network.dns))
                {
                    Ok(watchdog) => Some(watchdog),
                    Err(()) => {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        let _ = fs::remove_file(&sealed_config);
                        return ServiceResponse::error(
                            ServiceDiagnosticCode::SpawnFailed,
                            None,
                            unknown_tun_observation(),
                            installation_id,
                        );
                    }
                }
            } else {
                None
            };
            service_state.process = Some(ServiceProcess {
                child,
                launch_token,
                owner_pid: peer_pid,
                pid,
                sealed_config,
                watchdog,
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
                    dns_applied: false,
                    interface: None,
                    network: managed_network,
                    routes: None,
                });
            }
            drop(service_state);
            status_response(
                state,
                installation_id,
                observer,
                network_controller,
                network_recovery,
            )
            .await
        }
        ServiceCommand::Enable => {
            let mut service_state = state.lock().await;
            reap_if_exited(
                &mut service_state,
                network_controller.as_ref(),
                network_recovery,
            )
            .await;
            if service_state
                .process
                .as_ref()
                .is_none_or(|process| process.owner_pid != peer_pid)
                || service_state.tun.is_none()
            {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::OwnerMismatch,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            let pending_network = service_state
                .tun
                .as_ref()
                .filter(|tun| !tun.dns_applied)
                .and_then(|tun| tun.network.clone());
            if let Some(network) = pending_network.as_ref() {
                let correlation_before = current_tun_correlation(&service_state, observer.as_ref());
                let system = match observer.observe().await {
                    Ok(system) => system,
                    Err(()) => {
                        return ServiceResponse::error(
                            ServiceDiagnosticCode::SpawnFailed,
                            service_state.status(),
                            unknown_tun_observation(),
                            installation_id,
                        );
                    }
                };
                let correlation_after = current_tun_correlation(&service_state, observer.as_ref());
                let correlation = stable_tun_correlation(correlation_before, correlation_after);
                let precondition =
                    service_state.tun_observation(&system, correlation_result(&correlation));
                if !confirms_network_apply_precondition(&precondition) {
                    return ServiceResponse::error(
                        ServiceDiagnosticCode::SpawnFailed,
                        service_state.status(),
                        precondition,
                        installation_id,
                    );
                }
                match apply_network_transaction(
                    network_controller.as_ref(),
                    network_recovery,
                    network,
                    &system,
                )
                .await
                {
                    Ok(()) => {
                        service_state
                            .tun
                            .as_mut()
                            .expect("checked TUN ownership")
                            .dns_applied = true;
                    }
                    Err(failure) => {
                        service_state
                            .tun
                            .as_mut()
                            .expect("checked TUN ownership")
                            .dns_applied = failure == NetworkApplyFailure::RecoveryRequired;
                        return ServiceResponse::error(
                            ServiceDiagnosticCode::SpawnFailed,
                            service_state.status(),
                            unknown_tun_observation(),
                            installation_id,
                        );
                    }
                }
            }
            drop(service_state);
            status_response(
                state,
                installation_id,
                observer,
                network_controller,
                network_recovery,
            )
            .await
        }
        ServiceCommand::Stop { launch_token } => {
            let mut service_state = state.lock().await;
            reap_if_exited(
                &mut service_state,
                network_controller.as_ref(),
                network_recovery,
            )
            .await;
            if service_state.process.as_ref().is_some_and(|process| {
                process.launch_token != launch_token || process.owner_pid != peer_pid
            }) {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::OwnerMismatch,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            if stop_process(
                &mut service_state,
                network_controller.as_ref(),
                network_recovery,
            )
            .await
            .is_err()
            {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::StopFailed,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            drop(service_state);
            status_response(
                state,
                installation_id,
                observer,
                network_controller,
                network_recovery,
            )
            .await
        }
        ServiceCommand::Disable | ServiceCommand::StopAll => {
            let mut service_state = state.lock().await;
            if service_state.process.as_ref().is_some_and(|process| {
                process.owner_pid != peer_pid && process_alive(process.owner_pid)
            }) {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::OwnerMismatch,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            if restore_pending_network_recovery(
                &mut service_state,
                network_controller.as_ref(),
                network_recovery,
            )
            .await
            .is_err()
                || stop_process(
                    &mut service_state,
                    network_controller.as_ref(),
                    network_recovery,
                )
                .await
                .is_err()
            {
                return ServiceResponse::error(
                    ServiceDiagnosticCode::StopFailed,
                    service_state.status(),
                    unknown_tun_observation(),
                    installation_id,
                );
            }
            drop(service_state);
            status_response(
                state,
                installation_id,
                observer,
                network_controller,
                network_recovery,
            )
            .await
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
        let Some(owned) = ownership.interface.clone() else {
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
        let routes = match managed_route_fingerprint(system, &owned.name, ipv6_required) {
            Ok(None) => TunObservationComponentState::Absent,
            Ok(Some(current)) => match ownership.routes.as_ref() {
                None => {
                    ownership.routes = Some(current);
                    TunObservationComponentState::Confirmed
                }
                Some(expected) if expected == &current => TunObservationComponentState::Confirmed,
                Some(_) => TunObservationComponentState::Foreign,
            },
            Err(()) => TunObservationComponentState::Partial,
        };
        let dns = if ownership.dns_applied && current.is_none() {
            TunObservationComponentState::Partial
        } else {
            dns_observation_state(system, &owned.name)
        };
        TunNetworkObservation::new(core, interface, routes, dns, tun_observation_now())
    }

    fn tun_observation_with_network(
        &mut self,
        system: &TunSystemSnapshot,
        correlated_sockets: Option<Result<&[OwnedTunSocket], ()>>,
        network: Option<Result<NetworkOwnershipObservation, ()>>,
    ) -> TunNetworkObservation {
        let (manages_network, dns_applied) = self
            .tun
            .as_ref()
            .map(|ownership| (ownership.network.is_some(), ownership.dns_applied))
            .unwrap_or((false, false));
        let mut observation = self.tun_observation(system, correlated_sockets);
        if !manages_network {
            return observation;
        }
        let network = match network {
            Some(Ok(network)) => network,
            Some(Err(())) | None => NetworkOwnershipObservation {
                dns: TunObservationComponentState::Unknown,
                routes: TunObservationComponentState::Unknown,
            },
        };
        observation.dns = managed_network_dns_observation(
            observation.core,
            observation.dns,
            network.dns,
            dns_applied,
        );
        if observation.routes == TunObservationComponentState::Confirmed
            && network.routes != TunObservationComponentState::Confirmed
        {
            observation.routes = network.routes;
        }
        observation
    }
}

fn managed_network_dns_observation(
    core: TunObservationComponentState,
    packet_path: TunObservationComponentState,
    transaction: TunObservationComponentState,
    dns_applied: bool,
) -> TunObservationComponentState {
    if !dns_applied && core == TunObservationComponentState::Confirmed {
        return match transaction {
            TunObservationComponentState::Foreign => TunObservationComponentState::Foreign,
            TunObservationComponentState::Unknown => TunObservationComponentState::Unknown,
            _ => TunObservationComponentState::Partial,
        };
    }
    if packet_path == TunObservationComponentState::Confirmed
        && transaction != TunObservationComponentState::Confirmed
    {
        return transaction;
    }
    if dns_applied && packet_path == TunObservationComponentState::Absent {
        return if transaction == TunObservationComponentState::Confirmed {
            TunObservationComponentState::Partial
        } else {
            transaction
        };
    }
    packet_path
}

fn confirms_network_apply_precondition(observation: &TunNetworkObservation) -> bool {
    observation.is_fresh_at(tun_observation_now())
        && observation.core == TunObservationComponentState::Confirmed
        && observation.interface == TunObservationComponentState::Confirmed
        && observation.routes == TunObservationComponentState::Confirmed
}

const REQUIRED_IPV4_ROUTES: &[&[&str]] = &[
    &["1", "1/8", "1.0.0.0/8"],
    &["2/7", "2.0.0.0/7"],
    &["4/6", "4.0.0.0/6"],
    &["8/5", "8.0.0.0/5"],
    &["16/4", "16.0.0.0/4"],
    &["32/3", "32.0.0.0/3"],
    &["64/2", "64.0.0.0/2"],
    &["128/1", "128.0/1", "128.0.0.0/1"],
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
    let count = |required: &[&[&str]]| {
        required
            .iter()
            .filter(|destinations| {
                system.routes.iter().any(|route| {
                    route.interface == interface
                        && destinations.contains(&route.destination.as_str())
                })
            })
            .count()
    };
    count(REQUIRED_IPV4_ROUTES) + usize::from(ipv6) * count(REQUIRED_IPV6_ROUTES)
}

fn managed_route_fingerprint(
    system: &TunSystemSnapshot,
    interface: &str,
    ipv6: bool,
) -> Result<Option<Vec<TunSystemRoute>>, ()> {
    let required = REQUIRED_IPV4_ROUTES
        .iter()
        .chain(ipv6.then_some(REQUIRED_IPV6_ROUTES).into_iter().flatten());
    let mut routes = Vec::new();
    let mut missing = false;
    for destinations in required {
        let matches = system
            .routes
            .iter()
            .filter(|route| {
                route.interface == interface && destinations.contains(&route.destination.as_str())
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => missing = true,
            [route] => routes.push((*route).clone()),
            _ => return Err(()),
        }
    }
    if routes.is_empty() {
        return Ok(None);
    }
    if missing {
        return Err(());
    }
    routes.sort_by(|left, right| {
        (
            &left.destination,
            &left.gateway,
            &left.flags,
            &left.interface,
        )
            .cmp(&(
                &right.destination,
                &right.gateway,
                &right.flags,
                &right.interface,
            ))
    });
    Ok(Some(routes))
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
            diagnostic: None,
            ok: true,
            request_id: String::new(),
            status: ServiceStatus {
                core,
                helper_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                installation_id: installation_id.to_owned(),
                observation,
            },
        }
    }

    fn error(
        diagnostic: ServiceDiagnosticCode,
        core: Option<ServiceCoreStatus>,
        observation: TunNetworkObservation,
        installation_id: &str,
    ) -> Self {
        Self {
            diagnostic: Some(diagnostic),
            ok: false,
            request_id: String::new(),
            status: ServiceStatus {
                core,
                helper_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
                installation_id: installation_id.to_owned(),
                observation,
            },
        }
    }

    fn with_request_id(mut self, request_id: String) -> Self {
        self.request_id = request_id;
        self
    }
}

async fn status_response(
    state: &Mutex<ServiceState>,
    installation_id: &str,
    observer: &Arc<dyn TunSystemObserver>,
    network_controller: &Arc<dyn TunNetworkController>,
    network_recovery: &NetworkRecoveryJournal,
) -> ServiceResponse {
    let mut state = state.lock().await;
    reap_if_exited(&mut state, network_controller.as_ref(), network_recovery).await;
    let pending_recovery_dns = match state.pending_network_recovery.as_ref() {
        Some(Ok(recovery)) => Some(
            network_controller
                .observe_recovery(recovery)
                .await
                .unwrap_or(TunObservationComponentState::Unknown),
        ),
        Some(Err(())) => Some(TunObservationComponentState::Unknown),
        None => None,
    };
    let correlation_before = current_tun_correlation(&state, observer.as_ref());
    let system = observer.observe().await;
    let correlation_after = current_tun_correlation(&state, observer.as_ref());
    let correlation = stable_tun_correlation(correlation_before, correlation_after);
    let network_observation = match (
        system.as_ref(),
        state
            .tun
            .as_ref()
            .and_then(|ownership| ownership.network.as_ref()),
    ) {
        (Ok(system), Some(network)) => Some(
            network_controller
                .observe(
                    network,
                    system,
                    state
                        .tun
                        .as_ref()
                        .is_some_and(|ownership| ownership.dns_applied),
                )
                .await,
        ),
        (_, Some(_)) => Some(Err(())),
        (_, None) => None,
    };
    let mut observation = match system {
        Ok(system) => state.tun_observation_with_network(
            &system,
            correlation_result(&correlation),
            network_observation,
        ),
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
    if let Some(recovery_dns) = pending_recovery_dns {
        observation.dns = if recovery_dns == TunObservationComponentState::Confirmed {
            TunObservationComponentState::Partial
        } else {
            recovery_dns
        };
    }
    if observation.confirms_disabled_at(tun_observation_now())
        && state.process.is_none()
        && state.pending_network_recovery.is_none()
        && state
            .tun
            .as_ref()
            .is_none_or(|ownership| !ownership.dns_applied)
    {
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

async fn reap_if_exited(
    state: &mut ServiceState,
    network_controller: &dyn TunNetworkController,
    network_recovery: &NetworkRecoveryJournal,
) {
    if state
        .process
        .as_mut()
        .is_some_and(|process| !matches!(process.child.try_wait(), Ok(None)))
    {
        let process = state.process.take().expect("exited process must exist");
        if let Some(ownership) = state.tun.as_mut()
            && ownership.dns_applied
            && let Some(network) = ownership.network.as_ref()
            && restore_network_transaction(network_controller, network_recovery, &network.dns)
                .await
                .is_ok()
        {
            ownership.dns_applied = false;
        }
        if let Some(watchdog) = process.watchdog.as_ref() {
            remove_core_watchdog(watchdog);
        }
        let _ = fs::remove_file(process.sealed_config);
    }
}

fn spawn_core_watchdog(
    core_pid: u32,
    managed_dns: Option<&ManagedDnsState>,
) -> Result<ServiceWatchdog, ()> {
    let executable = std::env::current_exe().map_err(|_| ())?;
    let launchd_label = format!("com.asuka109.mish.tun-watchdog.{core_pid}");
    let mut command = StdCommand::new("/bin/launchctl");
    command
        .arg("submit")
        .arg("-l")
        .arg(&launchd_label)
        .arg("--")
        .arg(executable)
        .arg("--watch-parent")
        .arg(std::process::id().to_string())
        .arg(core_pid.to_string());
    if let Some(managed_dns) = managed_dns {
        command
            .arg("--restore-managed-network")
            .arg(encode_watchdog_dns(managed_dns).map_err(|_| ())?);
    }
    let output = command.output().map_err(|_| ())?;
    if !output.status.success() || output.stdout.len() > 4_096 || output.stderr.len() > 4_096 {
        return Err(());
    }
    Ok(ServiceWatchdog { launchd_label })
}

fn remove_core_watchdog(watchdog: &ServiceWatchdog) {
    let _ = StdCommand::new("/bin/launchctl")
        .args(["remove", &watchdog.launchd_label])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub async fn run_core_watchdog(
    expected_parent: u32,
    core_pid: u32,
    managed_dns: Option<ManagedDnsState>,
) -> Result<(), &'static str> {
    if expected_parent <= 1
        || core_pid == 0
        || expected_parent == core_pid
        || core_pid == std::process::id()
    {
        return Err("invalid Core watchdog identity");
    }
    let network_controller = MacOsTunNetworkController::new();
    let network_recovery = NetworkRecoveryJournal::development_root();
    loop {
        if !process_alive(core_pid) {
            if let Some(managed_dns) = &managed_dns {
                restore_managed_dns_with_retry(&network_controller, &network_recovery, managed_dns)
                    .await?;
            }
            return Ok(());
        }
        if !process_alive(expected_parent) {
            let restoration = if let Some(managed_dns) = &managed_dns {
                restore_managed_dns_with_retry(&network_controller, &network_recovery, managed_dns)
                    .await
            } else {
                Ok(())
            };
            // SAFETY: signal is sent only to the positive Core PID supplied by the helper.
            let _ = unsafe { libc::kill(core_pid as i32, libc::SIGTERM) };
            let deadline = tokio::time::Instant::now() + FORCED_STOP_TIMEOUT;
            while process_alive(core_pid) && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if process_alive(core_pid) {
                // SAFETY: the bounded graceful period expired for the same Core PID.
                let _ = unsafe { libc::kill(core_pid as i32, libc::SIGKILL) };
            }
            return restoration;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub async fn recover_managed_network_record(
    enrollment_record: &Path,
    owner_uid: u32,
) -> Result<(), &'static str> {
    let network_recovery = NetworkRecoveryJournal::for_enrollment(enrollment_record, owner_uid)
        .map_err(|_| "the network recovery path was invalid")?;
    let Some(recovery) = network_recovery
        .load()
        .map_err(|_| "the network recovery record was invalid")?
    else {
        return Ok(());
    };
    restore_network_transaction(
        &MacOsTunNetworkController::new(),
        &network_recovery,
        &recovery,
    )
    .await
    .map_err(|_| "the managed network could not be restored")
}

async fn stop_process(
    state: &mut ServiceState,
    network_controller: &dyn TunNetworkController,
    network_recovery: &NetworkRecoveryJournal,
) -> Result<(), ()> {
    stop_process_with_timeouts(
        state,
        network_controller,
        network_recovery,
        BOUNDED_STEP_TIMEOUT,
        FORCED_STOP_TIMEOUT,
    )
    .await
}

async fn restore_pending_network_recovery(
    state: &mut ServiceState,
    network_controller: &dyn TunNetworkController,
    network_recovery: &NetworkRecoveryJournal,
) -> Result<(), ()> {
    let Some(recovery) = state.pending_network_recovery.as_ref() else {
        return Ok(());
    };
    let recovery = recovery.as_ref().map_err(|_| ())?.clone();
    restore_network_transaction(network_controller, network_recovery, &recovery).await?;
    state.pending_network_recovery = None;
    Ok(())
}

async fn stop_process_with_timeouts(
    state: &mut ServiceState,
    network_controller: &dyn TunNetworkController,
    network_recovery: &NetworkRecoveryJournal,
    graceful_timeout: Duration,
    forced_timeout: Duration,
) -> Result<(), ()> {
    let mut cleanup_failed = false;
    if let Some(ownership) = state.tun.as_mut()
        && ownership.dns_applied
        && let Some(network) = ownership.network.as_ref()
    {
        if restore_network_transaction(network_controller, network_recovery, &network.dns)
            .await
            .is_ok()
        {
            ownership.dns_applied = false;
        } else {
            cleanup_failed = true;
        }
    }
    let Some(mut process) = state.process.take() else {
        return if cleanup_failed { Err(()) } else { Ok(()) };
    };
    // SAFETY: kill receives a positive PID returned for the child owned by this service.
    let _ = unsafe { libc::kill(process.pid as i32, libc::SIGTERM) };
    if !matches!(
        timeout(graceful_timeout, process.child.wait()).await,
        Ok(Ok(_))
    ) {
        if process.child.start_kill().is_err() {
            state.process = Some(process);
            return Err(());
        }
        if !matches!(
            timeout(forced_timeout, process.child.wait()).await,
            Ok(Ok(_))
        ) {
            state.process = Some(process);
            return Err(());
        }
    }
    if let Some(watchdog) = process.watchdog.take() {
        remove_core_watchdog(&watchdog);
    }
    match fs::remove_file(&process.sealed_config) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(()),
    }
    if cleanup_failed { Err(()) } else { Ok(()) }
}

async fn restore_managed_dns_with_retry(
    network_controller: &dyn TunNetworkController,
    network_recovery: &NetworkRecoveryJournal,
    state: &ManagedDnsState,
) -> Result<(), &'static str> {
    for _ in 0..5 {
        if restore_network_transaction_if_recorded(network_controller, network_recovery, state)
            .await
            .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("managed network DNS restoration failed")
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
    allow_managed_runtime_layout: bool,
) -> Result<(), ()> {
    if validate_regular_file(binary, allowed_uid, false).map_err(|_| ())? != allowed_binary {
        return Err(());
    }
    let directory = validate_owned_private_path(config_directory, allowed_uid, true)?;
    let file = validate_owned_private_path(config_file, allowed_uid, false)?;
    if allow_managed_runtime_layout
        && validate_managed_runtime_launch_paths(&directory, &file, runtime_root, allowed_uid)
            .is_ok()
    {
        return Ok(());
    }
    let candidates =
        validate_owned_private_path(&runtime_root.join("candidates"), allowed_uid, true)?;
    let candidate = directory.parent().ok_or(())?;
    let candidate = validate_owned_private_path(candidate, allowed_uid, true)?;
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

fn validate_managed_runtime_launch_paths(
    directory: &Path,
    file: &Path,
    runtime_root: &Path,
    allowed_uid: u32,
) -> Result<(), ()> {
    let mihomo = validate_owned_private_path(&runtime_root.join("mihomo"), allowed_uid, true)?;
    let home = validate_owned_private_path(&mihomo.join("home"), allowed_uid, true)?;
    let configs = validate_owned_private_path(&mihomo.join("configs"), allowed_uid, true)?;
    let config_id = file
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|_| file.extension().and_then(|extension| extension.to_str()) == Some("yaml"))
        .ok_or(())?;
    if directory != home
        || file.parent() != Some(configs.as_path())
        || uuid::Uuid::parse_str(config_id).is_err()
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
        || (!directory
            && (!metadata.is_file() || metadata.nlink() != 1 || metadata.len() > CONFIG_MAX_BYTES))
    {
        return Err(());
    }
    path.canonicalize().map_err(|_| ())
}

fn read_validated_candidate_config(path: &Path, uid: u32) -> Result<(Vec<u8>, bool), ()> {
    let mut options = fs::OpenOptions::new();
    options.read(true).custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).map_err(|_| ())?;
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() > CONFIG_MAX_BYTES
    {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(CONFIG_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err(());
    }
    let value: serde_norway::Value = serde_norway::from_slice(&bytes).map_err(|_| ())?;
    let tun_enabled = value
        .get("tun")
        .and_then(|tun| tun.get("enable"))
        .and_then(serde_norway::Value::as_bool)
        .unwrap_or(false);
    Ok((bytes, tun_enabled))
}

fn reset_sealed_root(path: &Path, allowed_uid: u32, root_only: bool) -> Result<(), &'static str> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        let expected_owner = if root_only { 0 } else { allowed_uid };
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != expected_owner
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("sealed config root metadata is unsafe");
        }
        fs::remove_dir_all(path).map_err(|_| "stale sealed config cleanup failed")?;
    }
    fs::create_dir(path).map_err(|_| "sealed config root creation failed")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "sealed config root permissions failed")
}

fn seal_candidate_config(root: &Path, request_id: &str, bytes: &[u8]) -> Result<PathBuf, ()> {
    if !valid_token(request_id) || bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err(());
    }
    let path = root.join(format!("{request_id}.yaml"));
    let mut options = fs::OpenOptions::new();
    options
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(&path).map_err(|_| ())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| ())?;
    Ok(path)
}

fn verify_core_digest(binary: &Path, expected: &str) -> Result<(), ()> {
    if !valid_installation_id(expected) {
        return Err(());
    }
    let bytes = fs::read(binary).map_err(|_| ())?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    (actual == expected).then_some(()).ok_or(())
}

async fn verify_core_version(binary: &Path, expected: &str) -> Result<(), ()> {
    let mut command = Command::new(binary);
    command.arg("-v").kill_on_drop(true);
    let output = timeout(BOUNDED_STEP_TIMEOUT, command.output())
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

#[derive(Clone, Copy)]
struct PeerIdentity {
    pid: u32,
    uid: u32,
}

fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: signal 0 does not mutate the target and only probes process existence.
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(target_os = "macos")]
fn peer_identity(stream: &UnixStream) -> Result<PeerIdentity, &'static str> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: the pointers are valid for writes and the socket descriptor is live.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err("peer identity inspection failed");
    }
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: the output buffer and length are valid for the LOCAL_PEERPID query.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    } != 0
        || pid <= 0
    {
        return Err("peer process inspection failed");
    }
    Ok(PeerIdentity {
        pid: pid as u32,
        uid,
    })
}

#[cfg(target_os = "linux")]
fn peer_identity(stream: &UnixStream) -> Result<PeerIdentity, &'static str> {
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
    if credentials.pid <= 0 {
        return Err("peer process inspection failed");
    }
    Ok(PeerIdentity {
        pid: credentials.pid as u32,
        uid: credentials.uid,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_identity(_stream: &UnixStream) -> Result<PeerIdentity, &'static str> {
    Err("peer identity inspection is unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::{
        ecdsa::SigningKey,
        pkcs8::{EncodePrivateKey, EncodePublicKey},
    };
    use rand_core::OsRng;
    use std::{
        collections::VecDeque, os::unix::fs::PermissionsExt, sync::Mutex as StdMutex, time::Instant,
    };

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

    struct FailingNetworkController;

    impl TunNetworkController for FailingNetworkController {
        fn snapshot<'a>(
            &'a self,
            _system: &'a TunSystemSnapshot,
        ) -> BoxFuture<'a, Result<NetworkOwnershipSnapshot, ()>> {
            Box::pin(async { Err(()) })
        }

        fn apply<'a>(
            &'a self,
            _snapshot: &'a NetworkOwnershipSnapshot,
            _system: &'a TunSystemSnapshot,
        ) -> BoxFuture<'a, Result<(), network_ownership::NetworkControllerApplyFailure>> {
            Box::pin(async { Err(network_ownership::NetworkControllerApplyFailure::Unchanged) })
        }

        fn restore<'a>(&'a self, _state: &'a ManagedDnsState) -> BoxFuture<'a, Result<(), ()>> {
            Box::pin(async { Err(()) })
        }

        fn observe<'a>(
            &'a self,
            _snapshot: &'a NetworkOwnershipSnapshot,
            _system: &'a TunSystemSnapshot,
            _dns_applied: bool,
        ) -> BoxFuture<'a, Result<NetworkOwnershipObservation, ()>> {
            Box::pin(async { Err(()) })
        }

        fn observe_recovery<'a>(
            &'a self,
            _state: &'a ManagedDnsState,
        ) -> BoxFuture<'a, Result<TunObservationComponentState, ()>> {
            Box::pin(async { Err(()) })
        }
    }

    #[test]
    fn development_tun_service_requires_an_exact_explicit_boundary() {
        assert_eq!(development_tun_allowed(None), Ok(false));
        assert_eq!(development_tun_allowed(Some(OsStr::new("0"))), Ok(false));
        assert_eq!(development_tun_allowed(Some(OsStr::new("1"))), Ok(true));
        for value in ["", "true", "yes", " 1", "1 "] {
            assert_eq!(
                development_tun_allowed(Some(OsStr::new(value))),
                Err("invalid development TUN boundary")
            );
        }
    }

    #[test]
    fn managed_runtime_launch_layout_requires_the_explicit_tart_boundary() {
        let temporary = tempfile::tempdir().unwrap();
        let binary = write_fixture_binary(temporary.path());
        let runtime_root = temporary.path().join("runtime");
        let mihomo = runtime_root.join("mihomo");
        let home = mihomo.join("home");
        let configs = mihomo.join("configs");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&configs).unwrap();
        for directory in [&runtime_root, &mihomo, &home, &configs] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let config = configs.join("11111111-1111-4111-8111-111111111111.yaml");
        fs::write(&config, "tun:\n  enable: true\n").unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        let binary = binary.canonicalize().unwrap();
        let runtime_root = runtime_root.canonicalize().unwrap();

        assert!(
            validate_launch_paths(&binary, &home, &config, &binary, &runtime_root, uid, true,)
                .is_ok()
        );
        assert!(
            validate_launch_paths(&binary, &home, &config, &binary, &runtime_root, uid, false,)
                .is_err()
        );
    }

    fn baseline_snapshot() -> TunSystemSnapshot {
        TunSystemSnapshot {
            dns_resolvers: vec![TunSystemDnsResolver {
                domains: Vec::new(),
                interface: Some("en0".into()),
                nameservers: vec!["8.8.8.8".parse().unwrap()],
                port: Some(53),
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
                flags: "UGScg".into(),
                gateway: "192.168.1.1".into(),
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
                    flags: "US".into(),
                    gateway: "utun1".into(),
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
            pending_network_recovery: None,
            process: None,
            tun: Some(ServiceTunOwnership {
                baseline_interfaces: vec!["utun0".into()],
                dns_applied: false,
                interface: Some(OwnedTunInterface {
                    addresses: vec!["198.18.0.1".into()],
                    name: "utun1".into(),
                }),
                network: None,
                routes: None,
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
        assert_eq!(routes[0].gateway, "198.18.0.1");
        assert_eq!(routes[0].flags, "UGSc");

        let dns = parse_tun_dns_resolvers(
            "DNS configuration\n\nresolver #1\n  nameserver[0] : 198.18.0.2\n  if_index : 19 (utun7)\n\nresolver #2\n  nameserver[0] : 192.168.1.1\n  if_index : 4 (en0)\n",
        )
        .unwrap();
        assert_eq!(dns[0].interface.as_deref(), Some("utun7"));
        assert_eq!(dns[1].interface.as_deref(), Some("en0"));

        let resolvers = parse_tun_dns_resolvers(
            "DNS configuration\n\nresolver #1\n  nameserver[0] : 8.8.8.8\n  if_index : 4 (en0)\n\nresolver #2\n  domain : local.\n  nameserver[0] : 224.0.0.251\n  port : 5353\n  if_index : 4 (en0)\n\nresolver #3\n  domain : local\n",
        )
        .unwrap();
        assert_eq!(resolvers.len(), 3);
        assert_eq!(
            resolvers[0].nameservers,
            ["8.8.8.8".parse::<IpAddr>().unwrap()]
        );
        assert_eq!(resolvers[0].port, None);
        assert_eq!(resolvers[1].port, Some(5353));
        assert_eq!(resolvers[1].domains, ["local"]);
        assert!(resolvers[2].nameservers.is_empty());
        assert_eq!(resolvers[2].port, None);
    }

    #[test]
    fn parses_the_complete_macos_dual_stack_managed_route_set() {
        let routes = parse_tun_routes(
            "Routing tables\n\nInternet:\nDestination Gateway Flags Netif Expire\n1 198.18.0.1 UGSc utun4\n2/7 198.18.0.1 UGSc utun4\n4/6 198.18.0.1 UGSc utun4\n8/5 198.18.0.1 UGSc utun4\n16/4 198.18.0.1 UGSc utun4\n32/3 198.18.0.1 UGSc utun4\n64/2 198.18.0.1 UGSc utun4\n128.0/1 198.18.0.1 UGSc utun4\n\nInternet6:\nDestination Gateway Flags Netif Expire\n100::/8 fdfe:dcba:9876::1 UGSc utun4\n200::/7 fdfe:dcba:9876::1 UGSc utun4\n400::/6 fdfe:dcba:9876::1 UGSc utun4\n800::/5 fdfe:dcba:9876::1 UGSc utun4\n1000::/4 fdfe:dcba:9876::1 UGSc utun4\n2000::/3 fdfe:dcba:9876::1 UGSc utun4\n4000::/2 fdfe:dcba:9876::1 UGSc utun4\n8000::/1 fdfe:dcba:9876::1 UGSc utun4\n",
        )
        .unwrap();

        let snapshot = TunSystemSnapshot {
            dns_resolvers: Vec::new(),
            interfaces: Vec::new(),
            routes,
        };
        assert_eq!(required_route_count(&snapshot, "utun4", false), 8);
        assert_eq!(
            required_route_count(&snapshot, "utun4", true),
            16,
            "{:?}",
            snapshot.routes
        );
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
                domains: Vec::new(),
                interface: Some("en0".into()),
                nameservers: vec!["8.8.8.8".parse().unwrap()],
                port: Some(53),
            }],
            interfaces: Vec::new(),
            routes: vec![
                TunSystemRoute {
                    destination: "8/5".into(),
                    flags: "US".into(),
                    gateway: "utun7".into(),
                    interface: "utun7".into(),
                },
                TunSystemRoute {
                    destination: "default".into(),
                    flags: "UGScg".into(),
                    gateway: "192.168.1.1".into(),
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
                domains: Vec::new(),
                interface: Some("en0".into()),
                nameservers: vec!["192.168.1.1".parse().unwrap()],
                port: Some(53),
            }],
            interfaces: Vec::new(),
            routes: vec![
                TunSystemRoute {
                    destination: "128/1".into(),
                    flags: "US".into(),
                    gateway: "utun7".into(),
                    interface: "utun7".into(),
                },
                TunSystemRoute {
                    destination: "192.168.1".into(),
                    flags: "UCS".into(),
                    gateway: "link#4".into(),
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
                domains: Vec::new(),
                interface: Some("en0".into()),
                nameservers: vec!["8.8.8.8".parse().unwrap(), "192.168.1.1".parse().unwrap()],
                port: Some(53),
            }],
            interfaces: Vec::new(),
            routes: vec![
                TunSystemRoute {
                    destination: "8/5".into(),
                    flags: "US".into(),
                    gateway: "utun7".into(),
                    interface: "utun7".into(),
                },
                TunSystemRoute {
                    destination: "192.168.1".into(),
                    flags: "UCS".into(),
                    gateway: "link#4".into(),
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

        let mut changed_route_state = tracked_state();
        assert_eq!(
            changed_route_state
                .tun_observation(&healthy_snapshot(), None)
                .routes,
            TunObservationComponentState::Confirmed
        );
        let mut changed_route = healthy_snapshot();
        changed_route.routes[1].gateway = "198.18.0.254".into();
        assert_eq!(
            changed_route_state
                .tun_observation(&changed_route, None)
                .routes,
            TunObservationComponentState::Foreign
        );

        let mut foreign_state = ServiceState {
            pending_network_recovery: None,
            process: None,
            tun: Some(ServiceTunOwnership {
                baseline_interfaces: vec!["utun0".into()],
                dns_applied: false,
                interface: None,
                network: None,
                routes: None,
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
    fn managed_dns_never_confirms_before_the_exact_transaction_is_applied() {
        assert_eq!(
            managed_network_dns_observation(
                TunObservationComponentState::Confirmed,
                TunObservationComponentState::Confirmed,
                TunObservationComponentState::Confirmed,
                false,
            ),
            TunObservationComponentState::Partial
        );
        assert_eq!(
            managed_network_dns_observation(
                TunObservationComponentState::Confirmed,
                TunObservationComponentState::Confirmed,
                TunObservationComponentState::Foreign,
                false,
            ),
            TunObservationComponentState::Foreign
        );
        assert_eq!(
            managed_network_dns_observation(
                TunObservationComponentState::Confirmed,
                TunObservationComponentState::Confirmed,
                TunObservationComponentState::Confirmed,
                true,
            ),
            TunObservationComponentState::Confirmed
        );

        let ready = TunNetworkObservation::new(
            TunObservationComponentState::Confirmed,
            TunObservationComponentState::Confirmed,
            TunObservationComponentState::Confirmed,
            TunObservationComponentState::Partial,
            tun_observation_now(),
        );
        assert!(confirms_network_apply_precondition(&ready));
        let mut incomplete = ready;
        incomplete.routes = TunObservationComponentState::Partial;
        assert!(!confirms_network_apply_precondition(&incomplete));
    }

    #[tokio::test]
    async fn invalid_restart_recovery_state_never_reports_disabled() {
        let state = Mutex::new(ServiceState {
            pending_network_recovery: Some(Err(())),
            process: None,
            tun: None,
        });
        let observer: Arc<dyn TunSystemObserver> = Arc::new(SequenceObserver::new(
            vec![baseline_snapshot()],
            Ok(Vec::new()),
        ));
        let controller: Arc<dyn TunNetworkController> = Arc::new(MacOsTunNetworkController::new());
        let temporary = tempfile::tempdir().unwrap();
        let recovery = test_network_recovery(temporary.path());

        let response = status_response(&state, "fixture", &observer, &controller, &recovery).await;

        assert_eq!(
            response.status.observation.dns,
            TunObservationComponentState::Unknown
        );
        assert!(
            !response
                .status
                .observation
                .confirms_disabled_at(tun_observation_now())
        );
        let mut state = state.lock().await;
        assert!(
            restore_pending_network_recovery(&mut state, controller.as_ref(), &recovery)
                .await
                .is_err()
        );
    }

    #[test]
    fn sole_foreign_utun_racing_launch_is_never_claimed() {
        let mut state = ServiceState {
            pending_network_recovery: None,
            process: None,
            tun: Some(ServiceTunOwnership {
                baseline_interfaces: vec!["utun0".into()],
                dns_applied: false,
                interface: None,
                network: None,
                routes: None,
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

    fn write_fixture_installation_keys(
        root: &Path,
        runtime_root: &Path,
        uid: u32,
        installation_id: &str,
    ) -> (
        PathBuf,
        InstallationClientKeyStore,
        InstallationEnrollmentRecord,
    ) {
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        let signing = SigningKey::random(&mut OsRng);
        let private_key = signing.to_pkcs8_der().unwrap();
        let public_key = signing.verifying_key().to_public_key_der().unwrap();
        let public_key_spki = BASE64.encode(public_key.as_bytes());
        let key_id = format!("{:x}", Sha256::digest(public_key.as_bytes()));
        let active_path = runtime_root.join("tun-client-key.json");
        fs::write(
            &active_path,
            serde_json::to_vec(&serde_json::json!({
                "algorithm": DEV_TUN_INSTALLATION_KEY_ALGORITHM,
                "keyId": key_id,
                "privateKeyPkcs8": BASE64.encode(private_key.as_bytes()),
                "publicKeySpki": public_key_spki,
                "schemaVersion": 1,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::set_permissions(&active_path, fs::Permissions::from_mode(0o600)).unwrap();
        let enrollment = InstallationEnrollmentRecord {
            algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
            generation: 1,
            helper_installation_id: installation_id.to_owned(),
            installing_uid: uid,
            key_id,
            public_key_spki,
            schema_version: 1,
        };
        let enrollment_path = root.join("enrollment.json");
        fs::write(&enrollment_path, serde_json::to_vec(&enrollment).unwrap()).unwrap();
        fs::set_permissions(&enrollment_path, fs::Permissions::from_mode(0o600)).unwrap();
        (
            enrollment_path,
            InstallationClientKeyStore::new(
                active_path,
                runtime_root.join("tun-client-key.pending.json"),
                uid,
            ),
            enrollment,
        )
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
        let mihomo = runtime_root.join("mihomo");
        let home = mihomo.join("home");
        let configs = mihomo.join("configs");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&configs).unwrap();
        for directory in [&runtime_root, &mihomo, &home, &configs] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let config_file = configs.join("11111111-1111-4111-8111-111111111111.yaml");
        fs::write(&config_file, "tun:\n  enable: true\n").unwrap();
        fs::set_permissions(&config_file, fs::Permissions::from_mode(0o600)).unwrap();
        let socket_path = temporary.path().join("helper.sock");
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        let installation_id = "a".repeat(64);
        let (enrollment_record, client_keys, _) =
            write_fixture_installation_keys(temporary.path(), &runtime_root, uid, &installation_id);
        let pinned_binary_sha256 = format!("{:x}", Sha256::digest(fs::read(&binary).unwrap()));
        let server = tokio::spawn(run_tun_service(TunServiceConfig {
            allowed_binary: binary.clone(),
            allowed_uid: uid,
            allow_tun: true,
            enrollment_record,
            installation_id,
            pinned_binary_sha256,
            pinned_version: "v1.19.29".into(),
            require_root: false,
            runtime_root,
            socket_path: socket_path.clone(),
            spawn_watchdog: false,
            network_controller: Arc::new(MacOsTunNetworkController::new()),
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
            MacOsTunServiceClient::new_with_installation_keys(socket_path, client_keys),
            binary,
            home,
            config_file,
            server,
        )
    }

    async fn stage_one_fixture(
        config: &str,
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
        let candidates = runtime_root.join("candidates");
        let candidate = candidates.join("11111111-1111-4111-8111-111111111111");
        let home = candidate.join("home");
        fs::create_dir_all(&home).unwrap();
        for directory in [&runtime_root, &candidates, &candidate, &home] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let config_file = candidate.join("config.yaml");
        fs::write(&config_file, config).unwrap();
        fs::set_permissions(&config_file, fs::Permissions::from_mode(0o600)).unwrap();
        let socket_path = temporary.path().join("helper.sock");
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let uid = unsafe { libc::getuid() };
        let installation_id = "b".repeat(64);
        let (enrollment_record, client_keys, _) =
            write_fixture_installation_keys(temporary.path(), &runtime_root, uid, &installation_id);
        let pinned_binary_sha256 = format!("{:x}", Sha256::digest(fs::read(&binary).unwrap()));
        let server = tokio::spawn(run_tun_service(TunServiceConfig {
            allowed_binary: binary.clone(),
            allowed_uid: uid,
            allow_tun: false,
            enrollment_record,
            installation_id,
            pinned_binary_sha256,
            pinned_version: "v1.19.29".into(),
            require_root: false,
            runtime_root,
            socket_path: socket_path.clone(),
            spawn_watchdog: false,
            network_controller: Arc::new(MacOsTunNetworkController::new()),
            observer: Arc::new(SequenceObserver::new(
                vec![baseline_snapshot()],
                Ok(Vec::new()),
            )),
        }));
        for _ in 0..100 {
            if socket_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        (
            temporary,
            MacOsTunServiceClient::new_with_installation_keys(socket_path, client_keys),
            binary,
            home,
            config_file,
            server,
        )
    }

    #[tokio::test]
    async fn stage_one_service_rejects_tun_candidates() {
        let (_temporary, client, binary, home, config_file, server) =
            stage_one_fixture("tun:\n  enable: true\n").await;

        let result = client
            .start(PrivilegedCoreLaunchRequest::new(
                binary,
                home,
                config_file,
                "v1.19.29",
            ))
            .await;

        assert_eq!(result, Err(PrivilegedCoreHostError::Rejected));
        assert!(
            client
                .request(ServiceCommand::Status)
                .await
                .unwrap()
                .core
                .is_none()
        );
        server.abort();
    }

    #[tokio::test]
    async fn untrusted_same_user_client_cannot_mutate_core_or_network_state() {
        let (temporary, trusted, binary, home, config_file, server) =
            stage_one_fixture("tun:\n  enable: false\n").await;
        let wrong_runtime = temporary.path().join("wrong-runtime");
        fs::create_dir(&wrong_runtime).unwrap();
        fs::set_permissions(&wrong_runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        let (_, wrong_keys, _) =
            write_fixture_installation_keys(&wrong_runtime, &wrong_runtime, uid, &"b".repeat(64));
        let untrusted = MacOsTunServiceClient::new_with_installation_keys(
            trusted.socket_path.clone(),
            wrong_keys,
        );

        assert_eq!(
            untrusted
                .start(PrivilegedCoreLaunchRequest::new(
                    binary,
                    home,
                    config_file,
                    "v1.19.29",
                ))
                .await,
            Err(PrivilegedCoreHostError::Rejected)
        );
        let status = trusted.request(ServiceCommand::Status).await.unwrap();
        assert!(status.core.is_none());
        assert!(
            status
                .observation
                .confirms_disabled_at(tun_observation_now())
        );
        server.abort();
    }

    #[tokio::test]
    async fn stage_one_service_hosts_and_cleans_up_a_non_tun_core() {
        let (_temporary, client, binary, home, config_file, server) =
            stage_one_fixture("tun:\n  enable: false\n").await;
        let process = client
            .start(PrivilegedCoreLaunchRequest::new(
                binary,
                home,
                config_file,
                "v1.19.29",
            ))
            .await
            .unwrap();

        assert_eq!(
            client.observe(process.clone()).await.unwrap(),
            Some(process.clone())
        );
        client.stop(process).await.unwrap();
        assert!(
            client
                .request(ServiceCommand::Status)
                .await
                .unwrap()
                .core
                .is_none()
        );
        server.abort();
    }

    #[tokio::test]
    async fn stage_one_service_rejects_a_mutable_candidate_parent() {
        let (_temporary, client, binary, home, config_file, server) =
            stage_one_fixture("tun:\n  enable: false\n").await;
        fs::set_permissions(
            home.parent().expect("candidate parent"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let result = client
            .start(PrivilegedCoreLaunchRequest::new(
                binary,
                home,
                config_file,
                "v1.19.29",
            ))
            .await;

        assert_eq!(result, Err(PrivilegedCoreHostError::Rejected));
        assert!(
            client
                .request(ServiceCommand::Status)
                .await
                .unwrap()
                .core
                .is_none()
        );
        server.abort();
    }

    #[tokio::test]
    async fn stage_one_service_rejects_a_mutable_candidates_root() {
        let (_temporary, client, binary, home, config_file, server) =
            stage_one_fixture("tun:\n  enable: false\n").await;
        let candidates = home
            .parent()
            .and_then(Path::parent)
            .expect("candidates root");
        fs::set_permissions(candidates, fs::Permissions::from_mode(0o755)).unwrap();

        let result = client
            .start(PrivilegedCoreLaunchRequest::new(
                binary,
                home,
                config_file,
                "v1.19.29",
            ))
            .await;

        assert_eq!(result, Err(PrivilegedCoreHostError::Rejected));
        assert!(
            client
                .request(ServiceCommand::Status)
                .await
                .unwrap()
                .core
                .is_none()
        );
        server.abort();
    }

    #[test]
    fn request_gate_rejects_replayed_expired_and_future_challenges() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir(&runtime_root).unwrap();
        fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        let (_, _, enrollment) =
            write_fixture_installation_keys(temporary.path(), &runtime_root, uid, &"a".repeat(64));
        let now = tun_observation_now();
        let mut gate = ServiceRequestGate::default();
        let accepted = uuid::Uuid::new_v4().to_string();
        let peer = PeerIdentity {
            pid: std::process::id(),
            uid,
        };
        let client_nonce = [7_u8; 32];

        let challenge = gate
            .begin(
                ServiceCommand::Status,
                client_nonce,
                peer,
                &accepted,
                &enrollment,
                now,
            )
            .unwrap();
        assert!(matches!(
            gate.begin(
                ServiceCommand::Status,
                client_nonce,
                peer,
                &accepted,
                &enrollment,
                now,
            ),
            Err(ServiceDiagnosticCode::ReplayRejected)
        ));
        let outstanding = gate.take(&challenge.challenge_id).unwrap();
        let proof = ServiceProof {
            challenge_id: challenge.challenge_id,
            signature: String::new(),
            transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
        };
        assert_eq!(
            verify_challenge_proof(
                &outstanding,
                &proof,
                &enrollment,
                peer,
                now + DEV_CORE_HOST_CHALLENGE_LIFETIME_MILLISECONDS + 1,
            ),
            Err(ServiceDiagnosticCode::ChallengeExpired)
        );

        let future_id = uuid::Uuid::new_v4().to_string();
        let future = gate
            .begin(
                ServiceCommand::Status,
                client_nonce,
                peer,
                &future_id,
                &enrollment,
                now,
            )
            .unwrap();
        let mut outstanding = gate.take(&future.challenge_id).unwrap();
        outstanding.challenge.issued_at = now + DEV_CORE_HOST_REQUEST_FUTURE_SKEW_MILLISECONDS + 1;
        outstanding.challenge.expires_at =
            outstanding.challenge.issued_at + DEV_CORE_HOST_CHALLENGE_LIFETIME_MILLISECONDS;
        let proof = ServiceProof {
            challenge_id: future.challenge_id,
            signature: String::new(),
            transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
        };
        assert_eq!(
            verify_challenge_proof(&outstanding, &proof, &enrollment, peer, now,),
            Err(ServiceDiagnosticCode::ChallengeExpired)
        );
    }

    #[test]
    fn request_gate_bounds_concurrent_outstanding_challenges() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir(&runtime_root).unwrap();
        fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        let (_, _, enrollment) =
            write_fixture_installation_keys(temporary.path(), &runtime_root, uid, &"a".repeat(64));
        let peer = PeerIdentity {
            pid: std::process::id(),
            uid,
        };
        let mut gate = ServiceRequestGate::default();
        for value in 0..DEV_CORE_HOST_MAX_OUTSTANDING_CHALLENGES {
            gate.begin(
                ServiceCommand::Status,
                [value as u8; 32],
                peer,
                &uuid::Uuid::new_v4().to_string(),
                &enrollment,
                tun_observation_now(),
            )
            .unwrap();
        }
        assert!(matches!(
            gate.begin(
                ServiceCommand::Status,
                [0xff; 32],
                peer,
                &uuid::Uuid::new_v4().to_string(),
                &enrollment,
                tun_observation_now(),
            ),
            Err(ServiceDiagnosticCode::AuthenticationRejected)
        ));
    }

    #[test]
    fn candidate_config_is_private_bounded_single_link_and_sealed_before_spawn() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("config.yaml");
        let sealed_root = temporary.path().join("sealed");
        fs::create_dir(&sealed_root).unwrap();
        fs::set_permissions(&sealed_root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&config, "tun:\n  enable: false\n").unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        // SAFETY: getuid has no preconditions and returns the real fixture owner.
        let uid = unsafe { libc::getuid() };

        let (bytes, tun_enabled) = read_validated_candidate_config(&config, uid).unwrap();
        assert!(!tun_enabled);
        let request_id = uuid::Uuid::new_v4().to_string();
        let sealed = seal_candidate_config(&sealed_root, &request_id, &bytes).unwrap();
        fs::write(&config, "tun:\n  enable: true\n").unwrap();

        assert_eq!(
            fs::read_to_string(&sealed).unwrap(),
            "tun:\n  enable: false\n"
        );
        assert_eq!(
            fs::metadata(&sealed).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_validated_candidate_config(&config, uid).is_err());
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        let linked = temporary.path().join("linked.yaml");
        fs::hard_link(&config, &linked).unwrap();
        assert!(read_validated_candidate_config(&config, uid).is_err());
        fs::remove_file(linked).unwrap();
        let oversized = fs::OpenOptions::new().write(true).open(&config).unwrap();
        oversized.set_len(CONFIG_MAX_BYTES + 1).unwrap();
        assert!(read_validated_candidate_config(&config, uid).is_err());
    }

    #[tokio::test]
    async fn stage_one_service_rechecks_the_pinned_digest_before_spawn() {
        let (_temporary, client, binary, home, config_file, server) =
            stage_one_fixture("tun:\n  enable: false\n").await;
        fs::write(
            &binary,
            "#!/bin/sh\nif [ \"$1\" = \"-v\" ]; then echo 'Mihomo Meta v1.19.29'; exit 0; fi\nexec sleep 31\n",
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();

        let result = client
            .start(PrivilegedCoreLaunchRequest::new(
                binary,
                home,
                config_file,
                "v1.19.29",
            ))
            .await;

        assert_eq!(result, Err(PrivilegedCoreHostError::Rejected));
        assert!(
            client
                .request(ServiceCommand::Status)
                .await
                .unwrap()
                .core
                .is_none()
        );
        server.abort();
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
    async fn foreign_vpn_baseline_enters_read_only_startup_without_cleanup() {
        let foreign = healthy_snapshot();
        let (_temporary, client, _binary, _home, _config_file, server) =
            fixture(vec![foreign], Ok(Vec::new())).await;

        assert_eq!(
            client.prepare_development_startup().await,
            DevelopmentTunStartup::ReadOnly(TunHelperFailureKind::ObservationForeign)
        );
        assert!(
            client
                .request(ServiceCommand::Status)
                .await
                .unwrap()
                .core
                .is_none()
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
    async fn mish_owned_residual_cleanup_failure_enters_typed_read_only_startup() {
        let baseline = baseline_snapshot();
        let healthy = healthy_snapshot();
        let (_temporary, client, binary, home, config_file, server) = fixture(
            vec![
                baseline,
                healthy.clone(),
                healthy.clone(),
                healthy.clone(),
                healthy,
            ],
            Ok(vec!["utun1".into()]),
        )
        .await;
        let process = client
            .start(PrivilegedCoreLaunchRequest::new(
                binary,
                home,
                config_file,
                "v1.19.29",
            ))
            .await
            .unwrap();
        client.stop(process).await.unwrap();

        assert_eq!(
            client.prepare_development_startup().await,
            DevelopmentTunStartup::ReadOnly(TunHelperFailureKind::ObservationPartial)
        );

        server.abort();
    }

    fn child_service_state(root: &Path, body: &str) -> ServiceState {
        let binary = root.join("stop-fixture.sh");
        fs::write(&binary, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let child = Command::new(binary).spawn().unwrap();
        let pid = child.id().unwrap();
        let sealed_config = root.join("sealed-config.yaml");
        fs::write(&sealed_config, "tun:\n  enable: false\n").unwrap();
        ServiceState {
            pending_network_recovery: None,
            process: Some(ServiceProcess {
                child,
                launch_token: uuid::Uuid::new_v4().to_string(),
                owner_pid: std::process::id(),
                pid,
                sealed_config,
                watchdog: None,
            }),
            tun: None,
        }
    }

    fn test_network_recovery(root: &Path) -> NetworkRecoveryJournal {
        // SAFETY: getuid has no preconditions and only returns the real user ID.
        let owner_uid = unsafe { libc::getuid() };
        NetworkRecoveryJournal::for_enrollment(&root.join("enrollment.json"), owner_uid).unwrap()
    }

    #[tokio::test]
    async fn slow_graceful_stop_finishes_inside_its_server_budget() {
        let temporary = tempfile::tempdir().unwrap();
        let ready = temporary.path().join("ready");
        let marker = temporary.path().join("terminated");
        let mut state = child_service_state(
            temporary.path(),
            &format!(
                "trap 'touch {} ; exit 0' TERM\ntouch {}\nwhile :; do /bin/sleep 0.2; done",
                marker.display(),
                ready.display(),
            ),
        );
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        stop_process_with_timeouts(
            &mut state,
            &MacOsTunNetworkController::new(),
            &test_network_recovery(temporary.path()),
            Duration::from_secs(2),
            Duration::from_millis(200),
        )
        .await
        .unwrap();

        assert!(marker.exists());
        assert!(state.process.is_none());
    }

    #[tokio::test]
    async fn forced_stop_finishes_inside_its_bounded_follow_up_budget() {
        let temporary = tempfile::tempdir().unwrap();
        let ready = temporary.path().join("ready");
        let mut state = child_service_state(
            temporary.path(),
            &format!(
                "trap '' TERM\ntouch {}\nwhile :; do /bin/sleep 0.2; done",
                ready.display()
            ),
        );
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let started = Instant::now();

        stop_process_with_timeouts(
            &mut state,
            &MacOsTunNetworkController::new(),
            &test_network_recovery(temporary.path()),
            Duration::from_millis(100),
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert!(started.elapsed() >= Duration::from_millis(100));
        assert!(state.process.is_none());
    }

    #[tokio::test]
    async fn failed_dns_restoration_still_stops_the_owned_core() {
        let temporary = tempfile::tempdir().unwrap();
        let ready = temporary.path().join("ready");
        let mut state = child_service_state(
            temporary.path(),
            &format!(
                "trap 'exit 0' TERM\ntouch {}\nwhile :; do /bin/sleep 0.2; done",
                ready.display()
            ),
        );
        state.tun = Some(ServiceTunOwnership {
            baseline_interfaces: Vec::new(),
            dns_applied: true,
            interface: None,
            network: Some(network_ownership::test_network_snapshot()),
            routes: None,
        });
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert!(
            stop_process_with_timeouts(
                &mut state,
                &FailingNetworkController,
                &test_network_recovery(temporary.path()),
                Duration::from_secs(2),
                Duration::from_millis(200),
            )
            .await
            .is_err()
        );

        assert!(state.process.is_none());
        assert!(state.tun.as_ref().is_some_and(|tun| tun.dns_applied));
    }

    #[tokio::test]
    async fn slow_stop_response_is_not_cut_off_by_the_observation_timeout() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir(&runtime_root).unwrap();
        fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        let (_, client_keys, enrollment) =
            write_fixture_installation_keys(temporary.path(), &runtime_root, uid, &"a".repeat(64));
        let socket_path = temporary.path().join("slow-helper.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_service_frame::<ServiceClientMessage>(&mut stream)
                .await
                .unwrap();
            let ServiceClientMessage::Challenge {
                client_nonce,
                command,
                protocol_version,
                request_id,
            } = request
            else {
                panic!("expected an authenticated stop request");
            };
            assert!(matches!(command, ServiceCommand::StopAll));
            let command_digest = command.digest().unwrap();
            let now = tun_observation_now();
            let challenge = ServiceChallenge {
                algorithm: enrollment.algorithm,
                challenge_id: uuid::Uuid::new_v4().to_string(),
                client_nonce,
                command_digest: BASE64.encode(command_digest),
                expires_at: now + DEV_CORE_HOST_CHALLENGE_LIFETIME_MILLISECONDS,
                generation: enrollment.generation,
                helper_nonce: BASE64.encode([9_u8; 32]),
                installation_id: enrollment.helper_installation_id,
                issued_at: now,
                key_id: enrollment.key_id,
                operation: command.operation().into(),
                peer_pid: std::process::id(),
                peer_uid: uid,
                protocol_version,
                request_id: request_id.clone(),
                transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
            };
            write_server_message(&mut stream, &ServiceServerMessage::Challenge { challenge })
                .await
                .unwrap();
            let _proof = read_service_frame::<ServiceProof>(&mut stream)
                .await
                .unwrap();
            tokio::time::sleep(BOUNDED_STEP_TIMEOUT + Duration::from_millis(100)).await;
            let response = ServiceResponse::ok(
                None,
                TunNetworkObservation::disabled(tun_observation_now()),
                &"a".repeat(64),
            )
            .with_request_id(request_id);
            write_server_message(&mut stream, &ServiceServerMessage::Response { response })
                .await
                .unwrap();
        });

        MacOsTunServiceClient::new_with_installation_keys(socket_path, client_keys)
            .request(ServiceCommand::StopAll)
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[test]
    fn client_deadlines_cover_start_version_baseline_stop_and_observation_budgets() {
        let health = service_request_timeout(&ServiceCommand::Health);
        let observe = service_request_timeout(&ServiceCommand::Observe {
            launch_token: uuid::Uuid::new_v4().to_string(),
        });
        let start = service_request_timeout(&ServiceCommand::Start {
            binary: PathBuf::from("/fixture/mihomo"),
            config_directory: PathBuf::from("/fixture/home"),
            config_file: PathBuf::from("/fixture/config.yaml"),
            expected_version: "v1.19.29".into(),
            launch_token: uuid::Uuid::new_v4().to_string(),
        });
        let stop = service_request_timeout(&ServiceCommand::StopAll);

        assert_eq!(health, BOUNDED_STEP_TIMEOUT + CLIENT_RESPONSE_SLACK);
        assert_eq!(observe, health);
        assert_eq!(
            start,
            BOUNDED_STEP_TIMEOUT * 3 + STARTUP_SETTLE_TIME + CLIENT_RESPONSE_SLACK
        );
        assert_eq!(
            stop,
            BOUNDED_STEP_TIMEOUT * 2 + FORCED_STOP_TIMEOUT + CLIENT_RESPONSE_SLACK
        );
        assert!(start > BOUNDED_STEP_TIMEOUT);
        assert!(stop > BOUNDED_STEP_TIMEOUT);
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
            client_keys: None,
            lifecycle: Some(DevelopmentTunLifecycle {
                repository_root: repository.path().to_path_buf(),
                script_path: installer,
                tart_tun_acceptance: false,
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
    async fn tart_lifecycle_preserves_the_explicit_installer_boundary() {
        let repository = tempfile::tempdir().unwrap();
        let scripts = repository.path().join("scripts");
        fs::create_dir(&scripts).unwrap();
        let installer = scripts.join("manage-macos-tun-service.ts");
        fs::write(
            &installer,
            "import { writeFileSync } from 'node:fs';\nwriteFileSync('observed-action.txt', process.argv.slice(2).join(','));\nprocess.stdout.write(JSON.stringify({ ok: true }));\n",
        )
        .unwrap();
        fs::set_permissions(&installer, fs::Permissions::from_mode(0o644)).unwrap();
        let client = MacOsTunServiceClient {
            client_keys: None,
            lifecycle: Some(DevelopmentTunLifecycle {
                repository_root: repository.path().to_path_buf(),
                script_path: installer,
                tart_tun_acceptance: true,
            }),
            socket_path: repository.path().join("unused.sock"),
        };

        client
            .run_lifecycle(TunHelperLifecycleOperation::Repair)
            .await
            .unwrap();

        assert_eq!(
            fs::read_to_string(repository.path().join("observed-action.txt")).unwrap(),
            "repair,--tart-tun-acceptance"
        );
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
            client_keys: None,
            lifecycle: Some(DevelopmentTunLifecycle {
                repository_root: repository.path().to_path_buf(),
                script_path: installer,
                tart_tun_acceptance: false,
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
