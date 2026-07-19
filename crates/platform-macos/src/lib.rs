//! Narrow macOS System Proxy adapter.

use std::{
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use futures_util::future::BoxFuture;
use mish_runtime::{
    CapabilityAvailability, CaptureFailureKind, CaptureJournal, CaptureJournalStore,
    CapturePlatform, CaptureTransitionError, LoopbackProxyEndpoint, ManualProxyState,
    NetworkServiceProxyState, PlatformLifecycleEvent, PlatformLifecycleEventKind,
    PlatformLifecycleEventSource, TunHelperAvailability, TunHelperError, TunHelperFailureKind,
    TunHelperHealth, TunHelperLifecycleOperation, TunHelperObservation, TunHelperPlatform,
    TunHelperSnapshot,
};
use tokio::sync::broadcast;
use tokio::{
    net::TcpStream,
    process::Command,
    time::{sleep, timeout},
};

const JOURNAL_MAX_BYTES: u64 = 65_536;
const COMMAND_MAX_BYTES: usize = 65_536;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const LISTENER_READINESS_TIMEOUT: Duration = Duration::from_secs(2);
const LISTENER_CONNECT_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MacOsTunHelperBoundary {
    Unpackaged,
    UnsignedApp,
    UnsupportedSystem,
}

pub struct MacOsTunHelperPlatform {
    boundary: MacOsTunHelperBoundary,
}

impl MacOsTunHelperPlatform {
    pub const fn new(boundary: MacOsTunHelperBoundary) -> Self {
        Self { boundary }
    }

    fn error(&self) -> TunHelperError {
        match self.boundary {
            MacOsTunHelperBoundary::Unpackaged => TunHelperError::new(
                TunHelperFailureKind::Unpackaged,
                "The signed TUN helper is not packaged with this application",
            ),
            MacOsTunHelperBoundary::UnsignedApp => TunHelperError::new(
                TunHelperFailureKind::UnsignedApp,
                "The application does not satisfy the TUN helper signing requirement",
            ),
            MacOsTunHelperBoundary::UnsupportedSystem => TunHelperError::new(
                TunHelperFailureKind::UnsupportedSystem,
                "The operating system does not support the signed TUN helper",
            ),
        }
    }

    fn availability(&self) -> TunHelperAvailability {
        match self.boundary {
            MacOsTunHelperBoundary::Unpackaged => TunHelperAvailability::Unpackaged,
            MacOsTunHelperBoundary::UnsignedApp => TunHelperAvailability::UnsignedApp,
            MacOsTunHelperBoundary::UnsupportedSystem => TunHelperAvailability::UnsupportedSystem,
        }
    }

    fn failure(&self) -> TunHelperFailureKind {
        match self.boundary {
            MacOsTunHelperBoundary::Unpackaged => TunHelperFailureKind::Unpackaged,
            MacOsTunHelperBoundary::UnsignedApp => TunHelperFailureKind::UnsignedApp,
            MacOsTunHelperBoundary::UnsupportedSystem => TunHelperFailureKind::UnsupportedSystem,
        }
    }
}

impl TunHelperPlatform for MacOsTunHelperPlatform {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
        TunHelperSnapshot::unavailable(
            self.availability(),
            match self.boundary {
                MacOsTunHelperBoundary::Unpackaged => TunHelperHealth::NotInstalled,
                MacOsTunHelperBoundary::UnsignedApp => TunHelperHealth::InvalidSignature,
                MacOsTunHelperBoundary::UnsupportedSystem => TunHelperHealth::NotInstalled,
            },
            self.failure(),
        )
    }

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>> {
        let availability = self.availability();
        let health = match self.boundary {
            MacOsTunHelperBoundary::Unpackaged => TunHelperHealth::NotInstalled,
            MacOsTunHelperBoundary::UnsignedApp => TunHelperHealth::InvalidSignature,
            MacOsTunHelperBoundary::UnsupportedSystem => TunHelperHealth::NotInstalled,
        };
        Box::pin(async move {
            Ok(TunHelperObservation {
                availability,
                health,
                installed_version: None,
            })
        })
    }

    fn run_lifecycle(
        &self,
        _operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>> {
        let error = self.error();
        Box::pin(async move { Err(error) })
    }

    fn observe_tun(&self) -> BoxFuture<'_, Result<bool, TunHelperError>> {
        let error = self.error();
        Box::pin(async move { Err(error) })
    }

    fn set_tun_enabled(&self, _enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>> {
        let error = self.error();
        Box::pin(async move { Err(error) })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MacOsLifecycleSourceError {
    DynamicStoreUnavailable,
    NotificationRegistrationFailed,
    UnsupportedPlatform,
}

impl fmt::Display for MacOsLifecycleSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("The macOS lifecycle event source could not be started")
    }
}

impl std::error::Error for MacOsLifecycleSourceError {}

pub struct MacOsLifecycleEventSource {
    events: broadcast::Sender<PlatformLifecycleEvent>,
    network_shutdown: Arc<AtomicBool>,
    network_thread: Mutex<Option<JoinHandle<()>>>,
}

impl MacOsLifecycleEventSource {
    pub fn new() -> Result<Self, MacOsLifecycleSourceError> {
        #[cfg(not(target_os = "macos"))]
        {
            return Err(MacOsLifecycleSourceError::UnsupportedPlatform);
        }

        #[cfg(target_os = "macos")]
        {
            let (events, _) = broadcast::channel(32);
            let sequence = Arc::new(AtomicU64::new(0));
            install_workspace_notifications(events.clone(), sequence.clone())?;
            let network_shutdown = Arc::new(AtomicBool::new(false));
            let network_thread = start_network_change_monitor(
                events.clone(),
                sequence.clone(),
                network_shutdown.clone(),
            )?;
            Ok(Self {
                events,
                network_shutdown,
                network_thread: Mutex::new(Some(network_thread)),
            })
        }
    }
}

impl PlatformLifecycleEventSource for MacOsLifecycleEventSource {
    fn subscribe(&self) -> broadcast::Receiver<PlatformLifecycleEvent> {
        self.events.subscribe()
    }
}

impl Drop for MacOsLifecycleEventSource {
    fn drop(&mut self) {
        self.network_shutdown.store(true, Ordering::Release);
        if let Some(thread) = self
            .network_thread
            .lock()
            .expect("network lifecycle thread lock poisoned")
            .take()
        {
            let _ = thread.join();
        }
    }
}

fn publish_lifecycle_event(
    events: &broadcast::Sender<PlatformLifecycleEvent>,
    sequence: &AtomicU64,
    kind: PlatformLifecycleEventKind,
) {
    let sequence = sequence.fetch_add(1, Ordering::AcqRel).saturating_add(1);
    let _ = events.send(PlatformLifecycleEvent { kind, sequence });
}

#[cfg(target_os = "macos")]
fn install_workspace_notifications(
    events: broadcast::Sender<PlatformLifecycleEvent>,
    sequence: Arc<AtomicU64>,
) -> Result<(), MacOsLifecycleSourceError> {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::NSNotification;

    let workspace = NSWorkspace::sharedWorkspace();
    let center = workspace.notificationCenter();
    // SAFETY: AppKit exports these process-lifetime notification name constants.
    let notifications = unsafe {
        [
            (
                NSWorkspaceWillSleepNotification,
                PlatformLifecycleEventKind::Sleep,
            ),
            (
                NSWorkspaceDidWakeNotification,
                PlatformLifecycleEventKind::Wake,
            ),
        ]
    };
    for (name, kind) in notifications {
        let events = events.clone();
        let sequence = sequence.clone();
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            publish_lifecycle_event(&events, &sequence, kind);
        });
        unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_network_change_monitor(
    events: broadcast::Sender<PlatformLifecycleEvent>,
    sequence: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, MacOsLifecycleSourceError> {
    use std::sync::mpsc;

    use system_configuration::core_foundation::{
        array::CFArray,
        runloop::{CFRunLoop, kCFRunLoopDefaultMode},
        string::CFString,
    };
    use system_configuration::dynamic_store::{
        SCDynamicStore, SCDynamicStoreBuilder, SCDynamicStoreCallBackContext,
    };

    struct NetworkChangeContext {
        events: broadcast::Sender<PlatformLifecycleEvent>,
        sequence: Arc<AtomicU64>,
    }

    fn network_changed(
        _store: SCDynamicStore,
        _changed_keys: CFArray<CFString>,
        context: &mut NetworkChangeContext,
    ) {
        publish_lifecycle_event(
            &context.events,
            &context.sequence,
            PlatformLifecycleEventKind::NetworkChanged,
        );
    }

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name("mish-network-lifecycle".into())
        .spawn(move || {
            let context = SCDynamicStoreCallBackContext {
                callout: network_changed,
                info: NetworkChangeContext { events, sequence },
            };
            let Some(store) = SCDynamicStoreBuilder::new("io.mish.lifecycle")
                .callback_context(context)
                .build()
            else {
                let _ = ready_tx.send(false);
                return;
            };
            let keys = CFArray::from_CFTypes(&[
                CFString::from("State:/Network/Global/IPv4"),
                CFString::from("State:/Network/Global/IPv6"),
                CFString::from("Setup:/Network/Global/IPv4"),
                CFString::from("Setup:/Network/Global/IPv6"),
            ]);
            let patterns: CFArray<CFString> = CFArray::from_CFTypes(&[]);
            let Some(source) = store.create_run_loop_source() else {
                let _ = ready_tx.send(false);
                return;
            };
            if !store.set_notification_keys(&keys, &patterns) {
                let _ = ready_tx.send(false);
                return;
            }
            let run_loop = CFRunLoop::get_current();
            run_loop.add_source(&source, unsafe { kCFRunLoopDefaultMode });
            let _ = ready_tx.send(true);
            while !shutdown.load(Ordering::Acquire) {
                CFRunLoop::run_in_mode(
                    unsafe { kCFRunLoopDefaultMode },
                    Duration::from_millis(250),
                    false,
                );
            }
            run_loop.remove_source(&source, unsafe { kCFRunLoopDefaultMode });
        })
        .map_err(|_| MacOsLifecycleSourceError::DynamicStoreUnavailable)?;
    match ready_rx.recv() {
        Ok(true) => Ok(thread),
        Ok(false) | Err(_) => {
            let _ = thread.join();
            Err(MacOsLifecycleSourceError::NotificationRegistrationFailed)
        }
    }
}

pub struct FileCaptureJournalStore {
    path: PathBuf,
}

impl FileCaptureJournalStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl CaptureJournalStore for FileCaptureJournalStore {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(persistence_error()),
        };
        if metadata.len() > JOURNAL_MAX_BYTES {
            return Err(persistence_error());
        }
        let bytes = fs::read(&self.path).map_err(|_| persistence_error())?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| persistence_error())
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        let bytes = serde_json::to_vec(journal).map_err(|_| persistence_error())?;
        if bytes.len() as u64 > JOURNAL_MAX_BYTES {
            return Err(persistence_error());
        }
        let parent = self.path.parent().ok_or_else(persistence_error)?;
        fs::create_dir_all(parent).map_err(|_| persistence_error())?;
        let temporary = self.path.with_extension("tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| persistence_error())?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|_| persistence_error())?;
        file.write_all(&bytes).map_err(|_| persistence_error())?;
        file.sync_all().map_err(|_| persistence_error())?;
        fs::rename(&temporary, &self.path).map_err(|_| persistence_error())?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| persistence_error())?;
        Ok(())
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(persistence_error()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MacOsProxyKind {
    Http,
    Https,
    Socks,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MacOsCommand {
    DefaultRoute,
    GetAutoProxyUrl {
        service: String,
    },
    GetProxy {
        kind: MacOsProxyKind,
        service: String,
    },
    GetProxyAutoDiscovery {
        service: String,
    },
    ListNetworkServiceOrder,
    SetProxy {
        host: String,
        kind: MacOsProxyKind,
        port: u16,
        service: String,
    },
    SetProxyState {
        enabled: bool,
        kind: MacOsProxyKind,
        service: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacOsCommandSpec {
    pub arguments: Vec<String>,
    pub program: &'static str,
}

impl MacOsCommand {
    pub fn spec(&self) -> MacOsCommandSpec {
        match self {
            Self::DefaultRoute => MacOsCommandSpec {
                arguments: vec!["-n".into(), "get".into(), "default".into()],
                program: "/sbin/route",
            },
            Self::ListNetworkServiceOrder => networksetup_spec(["-listnetworkserviceorder"]),
            Self::GetProxy { kind, service } => networksetup_spec([proxy_get_flag(*kind), service]),
            Self::GetAutoProxyUrl { service } => networksetup_spec(["-getautoproxyurl", service]),
            Self::GetProxyAutoDiscovery { service } => {
                networksetup_spec(["-getproxyautodiscovery", service])
            }
            Self::SetProxy {
                host,
                kind,
                port,
                service,
            } => networksetup_spec([
                proxy_set_flag(*kind).to_owned(),
                service.clone(),
                host.clone(),
                port.to_string(),
                "off".to_owned(),
            ]),
            Self::SetProxyState {
                enabled,
                kind,
                service,
            } => networksetup_spec([
                proxy_state_flag(*kind).to_owned(),
                service.clone(),
                if *enabled { "on" } else { "off" }.to_owned(),
            ]),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacOsCommandOutput {
    pub stdout: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MacOsCommandErrorKind {
    Failed,
    PermissionDenied,
    TimedOut,
    Unavailable,
}

#[derive(Clone, Debug)]
pub struct MacOsCommandError {
    pub kind: MacOsCommandErrorKind,
}

impl fmt::Display for MacOsCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("The macOS network configuration command failed")
    }
}

impl std::error::Error for MacOsCommandError {}

pub trait MacOsCommandRunner: Send + Sync {
    fn run(
        &self,
        command: MacOsCommand,
    ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>>;
}

pub struct MacOsSystemCommandRunner;

impl MacOsCommandRunner for MacOsSystemCommandRunner {
    fn run(
        &self,
        command: MacOsCommand,
    ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
        Box::pin(async move {
            let spec = command.spec();
            let mut process = Command::new(spec.program);
            process.args(&spec.arguments).kill_on_drop(true);
            let output = timeout(COMMAND_TIMEOUT, process.output())
                .await
                .map_err(|_| MacOsCommandError {
                    kind: MacOsCommandErrorKind::TimedOut,
                })?
                .map_err(|error| MacOsCommandError {
                    kind: if error.kind() == std::io::ErrorKind::NotFound {
                        MacOsCommandErrorKind::Unavailable
                    } else {
                        MacOsCommandErrorKind::Failed
                    },
                })?;
            if output.stdout.len() > COMMAND_MAX_BYTES || output.stderr.len() > COMMAND_MAX_BYTES {
                return Err(MacOsCommandError {
                    kind: MacOsCommandErrorKind::Failed,
                });
            }
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
                let permission_denied = stderr.contains("permission")
                    || stderr.contains("must be root")
                    || stderr.contains("not authorized");
                return Err(MacOsCommandError {
                    kind: if permission_denied {
                        MacOsCommandErrorKind::PermissionDenied
                    } else {
                        MacOsCommandErrorKind::Failed
                    },
                });
            }
            let stdout = String::from_utf8(output.stdout).map_err(|_| MacOsCommandError {
                kind: MacOsCommandErrorKind::Failed,
            })?;
            Ok(MacOsCommandOutput { stdout })
        })
    }
}

pub struct MacOsSystemProxyPlatform {
    availability: CapabilityAvailability,
    runner: Arc<dyn MacOsCommandRunner>,
}

impl MacOsSystemProxyPlatform {
    pub fn new() -> Self {
        let available = cfg!(target_os = "macos")
            && std::path::Path::new("/usr/sbin/networksetup").is_file()
            && std::path::Path::new("/sbin/route").is_file();
        Self {
            availability: if available {
                CapabilityAvailability::Supported
            } else {
                CapabilityAvailability::Unavailable
            },
            runner: Arc::new(MacOsSystemCommandRunner),
        }
    }

    pub fn with_runner(runner: Arc<dyn MacOsCommandRunner>) -> Self {
        Self {
            availability: CapabilityAvailability::Supported,
            runner,
        }
    }

    async fn observe_named_service(
        &self,
        service: String,
    ) -> Result<NetworkServiceProxyState, CaptureTransitionError> {
        let http = self.proxy_state(&service, MacOsProxyKind::Http).await?;
        let https = self.proxy_state(&service, MacOsProxyKind::Https).await?;
        let socks = self.proxy_state(&service, MacOsProxyKind::Socks).await?;
        let pac_output = self
            .run(MacOsCommand::GetAutoProxyUrl {
                service: service.clone(),
            })
            .await?;
        let discovery_output = self
            .run(MacOsCommand::GetProxyAutoDiscovery {
                service: service.clone(),
            })
            .await?;
        Ok(NetworkServiceProxyState {
            auto_discovery_enabled: parse_enabled_value(&discovery_output, "Auto Proxy Discovery")?,
            http,
            https,
            pac_enabled: parse_enabled_value(&pac_output, "Enabled")?,
            service_id: service,
            socks,
        })
    }

    async fn proxy_state(
        &self,
        service: &str,
        kind: MacOsProxyKind,
    ) -> Result<ManualProxyState, CaptureTransitionError> {
        let output = self
            .run(MacOsCommand::GetProxy {
                kind,
                service: service.to_owned(),
            })
            .await?;
        parse_proxy_state(&output)
    }

    async fn run(&self, command: MacOsCommand) -> Result<String, CaptureTransitionError> {
        self.runner
            .run(command)
            .await
            .map(|output| output.stdout)
            .map_err(|_| observation_error())
    }

    async fn apply_proxy(
        &self,
        service: &str,
        kind: MacOsProxyKind,
        proxy: &ManualProxyState,
    ) -> Result<(), CaptureTransitionError> {
        let command = if proxy.enabled {
            if proxy.authenticated {
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::UnsafeExistingConfiguration,
                    "Authenticated proxy settings were left unchanged",
                ));
            }
            let host = proxy
                .host
                .clone()
                .filter(|host| !host.is_empty())
                .ok_or_else(|| {
                    CaptureTransitionError::new(
                        CaptureFailureKind::ApplyFailed,
                        "A proxy host is required when enabling System Proxy",
                    )
                })?;
            let port = proxy.port.filter(|port| *port > 0).ok_or_else(|| {
                CaptureTransitionError::new(
                    CaptureFailureKind::ApplyFailed,
                    "A proxy port is required when enabling System Proxy",
                )
            })?;
            MacOsCommand::SetProxy {
                host,
                kind,
                port,
                service: service.to_owned(),
            }
        } else {
            MacOsCommand::SetProxyState {
                enabled: false,
                kind,
                service: service.to_owned(),
            }
        };
        self.runner.run(command).await.map_err(apply_error)?;
        Ok(())
    }
}

impl CapturePlatform for MacOsSystemProxyPlatform {
    fn availability(&self) -> CapabilityAvailability {
        self.availability
    }

    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(async move {
            let route = self.run(MacOsCommand::DefaultRoute).await?;
            let device = parse_default_route_device(&route)?;
            let order = self.run(MacOsCommand::ListNetworkServiceOrder).await?;
            let service = parse_service_for_device(&order, &device)?;
            self.observe_named_service(service).await
        })
    }

    fn observe_service(
        &self,
        service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        let service = service_id.to_owned();
        Box::pin(async move { self.observe_named_service(service).await })
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        Box::pin(async move {
            self.apply_proxy(&target.service_id, MacOsProxyKind::Http, &target.http)
                .await?;
            self.apply_proxy(&target.service_id, MacOsProxyKind::Https, &target.https)
                .await?;
            self.apply_proxy(&target.service_id, MacOsProxyKind::Socks, &target.socks)
                .await?;
            Ok(())
        })
    }

    fn confirm_proxy_listener(
        &self,
        endpoint: &LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        let address = endpoint.socket_address();
        Box::pin(async move {
            let deadline = Instant::now() + LISTENER_READINESS_TIMEOUT;
            loop {
                if timeout(LISTENER_CONNECT_TIMEOUT, TcpStream::connect(address))
                    .await
                    .is_ok_and(|result| result.is_ok())
                {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(CaptureTransitionError::new(
                        CaptureFailureKind::ListenerUnavailable,
                        "The managed Mihomo proxy listener is unavailable",
                    ));
                }
                sleep(Duration::from_millis(25)).await;
            }
        })
    }
}

impl Default for MacOsSystemProxyPlatform {
    fn default() -> Self {
        Self::new()
    }
}

fn networksetup_spec(arguments: impl IntoIterator<Item = impl Into<String>>) -> MacOsCommandSpec {
    MacOsCommandSpec {
        arguments: arguments.into_iter().map(Into::into).collect(),
        program: "/usr/sbin/networksetup",
    }
}

const fn proxy_get_flag(kind: MacOsProxyKind) -> &'static str {
    match kind {
        MacOsProxyKind::Http => "-getwebproxy",
        MacOsProxyKind::Https => "-getsecurewebproxy",
        MacOsProxyKind::Socks => "-getsocksfirewallproxy",
    }
}

const fn proxy_set_flag(kind: MacOsProxyKind) -> &'static str {
    match kind {
        MacOsProxyKind::Http => "-setwebproxy",
        MacOsProxyKind::Https => "-setsecurewebproxy",
        MacOsProxyKind::Socks => "-setsocksfirewallproxy",
    }
}

const fn proxy_state_flag(kind: MacOsProxyKind) -> &'static str {
    match kind {
        MacOsProxyKind::Http => "-setwebproxystate",
        MacOsProxyKind::Https => "-setsecurewebproxystate",
        MacOsProxyKind::Socks => "-setsocksfirewallproxystate",
    }
}

fn parse_default_route_device(output: &str) -> Result<String, CaptureTransitionError> {
    parse_key(output, "interface")
        .filter(|value| !value.is_empty())
        .ok_or_else(observation_error)
}

fn parse_service_for_device(output: &str, device: &str) -> Result<String, CaptureTransitionError> {
    let mut candidate: Option<String> = None;
    for line in output.lines().map(str::trim) {
        if line.starts_with('(') && !line.starts_with("(Hardware Port:") {
            let Some((_, name)) = line.split_once(") ") else {
                candidate = None;
                continue;
            };
            candidate = (!name.starts_with('*')).then(|| name.to_owned());
            continue;
        }
        if !line.starts_with("(Hardware Port:") || !line.contains(&format!("Device: {device}")) {
            continue;
        }
        if let Some(service) = candidate.take() {
            return Ok(service);
        }
    }
    Err(observation_error())
}

fn parse_proxy_state(output: &str) -> Result<ManualProxyState, CaptureTransitionError> {
    let enabled = parse_enabled_value(output, "Enabled")?;
    let authenticated = parse_enabled_value(output, "Authenticated Proxy Enabled")?;
    if !enabled {
        return Ok(ManualProxyState::disabled());
    }
    let host = parse_key(output, "Server").filter(|value| !value.is_empty());
    let port = parse_key(output, "Port").and_then(|value| value.parse::<u16>().ok());
    if host.is_none() || port.is_none_or(|value| value == 0) {
        return Err(observation_error());
    }
    Ok(ManualProxyState {
        authenticated,
        enabled,
        host,
        port,
    })
}

fn parse_enabled_value(output: &str, key: &str) -> Result<bool, CaptureTransitionError> {
    let Some(value) = parse_key(output, key) else {
        return Err(observation_error());
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "on" | "yes" => Ok(true),
        "0" | "off" | "no" => Ok(false),
        _ => Err(observation_error()),
    }
}

fn parse_key(output: &str, key: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        (candidate.trim() == key).then(|| value.trim().to_owned())
    })
}

fn observation_error() -> CaptureTransitionError {
    CaptureTransitionError::new(
        CaptureFailureKind::ObservationFailed,
        "The active macOS System Proxy state could not be observed",
    )
}

fn apply_error(error: MacOsCommandError) -> CaptureTransitionError {
    let kind = match error.kind {
        MacOsCommandErrorKind::PermissionDenied => CaptureFailureKind::PermissionDenied,
        MacOsCommandErrorKind::Unavailable => CaptureFailureKind::CapabilityUnavailable,
        MacOsCommandErrorKind::Failed | MacOsCommandErrorKind::TimedOut => {
            CaptureFailureKind::ApplyFailed
        }
    };
    CaptureTransitionError::new(kind, "The macOS System Proxy change failed")
}

fn persistence_error() -> CaptureTransitionError {
    CaptureTransitionError::new(
        CaptureFailureKind::PersistenceFailed,
        "The System Proxy recovery journal is unavailable",
    )
}
