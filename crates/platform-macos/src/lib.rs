//! Narrow macOS System Proxy adapter.

mod production_tun;
mod tun_service;

pub use production_tun::*;

pub use tun_service::{
    DEV_TUN_SERVICE_CORE_PATH, DEV_TUN_SERVICE_HELPER_PATH, DEV_TUN_SERVICE_LABEL,
    DEV_TUN_SERVICE_PLIST_PATH, DEV_TUN_SERVICE_SOCKET_PREFIX, DevelopmentTunStartup,
    MacOsTunServiceClient, TunServiceConfig, development_socket_path, run_tun_service,
};

use std::{
    collections::HashSet,
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::Stdio,
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
use mish_settings::{
    DnsObservation, NetworkDnsFailureKind, NetworkDnsObservation, NetworkDnsObservationError,
    NetworkDnsPlatform, NetworkDnsSource, NetworkInterfaceKind, NetworkInterfaceObservation,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    net::TcpStream,
    process::Command,
    time::{sleep, timeout},
};

const JOURNAL_MAX_BYTES: u64 = 65_536;
const JOURNAL_OWNER: &str = "com.asuka109.mish";
const JOURNAL_VERSION: u32 = 2;
const COMMAND_MAX_BYTES: usize = 65_536;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const LISTENER_READINESS_TIMEOUT: Duration = Duration::from_secs(2);
const LISTENER_CONNECT_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenBrowserError {
    InvalidUrl,
    Rejected,
    Unsupported,
}

#[cfg(target_os = "macos")]
pub fn open_browser_url(url: &str) -> Result<(), OpenBrowserError> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let value = NSString::from_str(url);
    let url = NSURL::URLWithString(&value).ok_or(OpenBrowserError::InvalidUrl)?;
    NSWorkspace::sharedWorkspace()
        .openURL(&url)
        .then_some(())
        .ok_or(OpenBrowserError::Rejected)
}

#[cfg(not(target_os = "macos"))]
pub fn open_browser_url(_url: &str) -> Result<(), OpenBrowserError> {
    Err(OpenBrowserError::Unsupported)
}

#[cfg(target_os = "macos")]
pub fn show_browser_open_error() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertStyle};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str("Mish couldn't open the browser client"));
    alert.setInformativeText(&NSString::from_str(
        "Try Open Browser Client again. Mish did not expose an RPC credential in the failed URL.",
    ));
    alert.runModal();
}

#[cfg(not(target_os = "macos"))]
pub fn show_browser_open_error() {}

#[cfg(target_os = "macos")]
pub fn show_browser_pairing_pin(pin: &str) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertStyle};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Informational);
    alert.setMessageText(&NSString::from_str("Connect this browser to Mish"));
    alert.setInformativeText(&NSString::from_str(&format!(
        "Enter PIN {pin} in the browser. This PIN expires in two minutes and can be used only once."
    )));
    alert.runModal();
}

#[cfg(not(target_os = "macos"))]
pub fn show_browser_pairing_pin(_pin: &str) {}

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
                installation_id: None,
                installed_version: None,
                last_failure: Some(self.failure()),
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

    fn observe_tun(
        &self,
    ) -> BoxFuture<'_, Result<mish_runtime::TunNetworkObservation, TunHelperError>> {
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
                CFString::from("State:/Network/Global/DNS"),
                CFString::from("Setup:/Network/Global/IPv4"),
                CFString::from("Setup:/Network/Global/IPv6"),
                CFString::from("Setup:/Network/Global/DNS"),
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCaptureJournal {
    journal: CaptureJournal,
    owner: String,
    version: u32,
}

static NEXT_JOURNAL_TEMP_ID: AtomicU64 = AtomicU64::new(1);

impl FileCaptureJournalStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn validated_metadata(
        &self,
        enforce_size_bound: bool,
    ) -> Result<Option<fs::Metadata>, CaptureTransitionError> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(persistence_error()),
        };
        let parent = self.path.parent().ok_or_else(persistence_error)?;
        let parent_metadata = fs::symlink_metadata(parent).map_err(|_| persistence_error())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || (enforce_size_bound && metadata.len() > JOURNAL_MAX_BYTES)
            || metadata.permissions().mode() & 0o777 != 0o600
            || parent_metadata.file_type().is_symlink()
            || !parent_metadata.is_dir()
            || metadata.uid() != parent_metadata.uid()
        {
            return Err(invalid_recovery_error());
        }
        Ok(Some(metadata))
    }
}

impl CaptureJournalStore for FileCaptureJournalStore {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        if self.validated_metadata(true)?.is_none() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path).map_err(|_| persistence_error())?;
        let stored: StoredCaptureJournal =
            serde_json::from_slice(&bytes).map_err(|_| invalid_recovery_error())?;
        if stored.version != JOURNAL_VERSION
            || stored.owner != JOURNAL_OWNER
            || !stored.journal.is_valid_recovery_state()
        {
            return Err(invalid_recovery_error());
        }
        Ok(Some(stored.journal))
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        if !journal.is_valid_recovery_state() {
            return Err(invalid_recovery_error());
        }
        match fs::symlink_metadata(&self.path) {
            Ok(_) => {
                self.load()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(persistence_error()),
        }
        let bytes = serde_json::to_vec(&StoredCaptureJournal {
            journal: journal.clone(),
            owner: JOURNAL_OWNER.to_owned(),
            version: JOURNAL_VERSION,
        })
        .map_err(|_| persistence_error())?;
        if bytes.len() as u64 > JOURNAL_MAX_BYTES {
            return Err(persistence_error());
        }
        let parent = self.path.parent().ok_or_else(persistence_error)?;
        fs::create_dir_all(parent).map_err(|_| persistence_error())?;
        let parent_metadata = fs::symlink_metadata(parent).map_err(|_| persistence_error())?;
        if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
            return Err(persistence_error());
        }
        let temporary = self.path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            NEXT_JOURNAL_TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| persistence_error())?;
        if fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(persistence_error());
        }
        let result = file
            .write_all(&bytes)
            .and_then(|()| file.sync_all())
            .and_then(|()| fs::rename(&temporary, &self.path))
            .and_then(|()| fs::File::open(parent))
            .and_then(|directory| directory.sync_all())
            .map_err(|_| persistence_error());
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        if self.validated_metadata(false)?.is_none() {
            return Ok(());
        }
        let parent = self.path.parent().ok_or_else(persistence_error)?;
        fs::remove_file(&self.path).map_err(|_| persistence_error())?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| persistence_error())?;
        Ok(())
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
    DnsConfiguration,
    InterfaceConfiguration,
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
    NetworkInformation,
    RoutingTable,
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
            Self::DnsConfiguration => MacOsCommandSpec {
                arguments: vec!["--dns".into()],
                program: "/usr/sbin/scutil",
            },
            Self::InterfaceConfiguration => MacOsCommandSpec {
                arguments: Vec::new(),
                program: "/sbin/ifconfig",
            },
            Self::NetworkInformation => MacOsCommandSpec {
                arguments: vec!["--nwi".into()],
                program: "/usr/sbin/scutil",
            },
            Self::RoutingTable => MacOsCommandSpec {
                arguments: vec!["-rn".into()],
                program: "/usr/sbin/netstat",
            },
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
    OutputTooLarge,
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
            process
                .args(&spec.arguments)
                .kill_on_drop(true)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = process.spawn().map_err(|error| MacOsCommandError {
                kind: if error.kind() == std::io::ErrorKind::NotFound {
                    MacOsCommandErrorKind::Unavailable
                } else {
                    MacOsCommandErrorKind::Failed
                },
            })?;
            let stdout = child.stdout.take().ok_or(MacOsCommandError {
                kind: MacOsCommandErrorKind::Failed,
            })?;
            let stderr = child.stderr.take().ok_or(MacOsCommandError {
                kind: MacOsCommandErrorKind::Failed,
            })?;
            let collected = timeout(COMMAND_TIMEOUT, async {
                tokio::try_join!(
                    read_bounded(stdout, COMMAND_MAX_BYTES),
                    read_bounded(stderr, COMMAND_MAX_BYTES),
                    async {
                        child.wait().await.map_err(|_| MacOsCommandError {
                            kind: MacOsCommandErrorKind::Failed,
                        })
                    },
                )
            })
            .await;
            let (stdout, stderr, status) = match collected {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    let _ = child.kill().await;
                    return Err(error);
                }
                Err(_) => {
                    let _ = child.kill().await;
                    return Err(MacOsCommandError {
                        kind: MacOsCommandErrorKind::TimedOut,
                    });
                }
            };
            if !status.success() {
                let stderr = String::from_utf8_lossy(&stderr).to_ascii_lowercase();
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
            let stdout = String::from_utf8(stdout).map_err(|_| MacOsCommandError {
                kind: MacOsCommandErrorKind::Failed,
            })?;
            Ok(MacOsCommandOutput { stdout })
        })
    }
}

async fn read_bounded(
    reader: impl AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>, MacOsCommandError> {
    let mut bytes = Vec::with_capacity(maximum.min(8_192));
    reader
        .take(maximum.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| MacOsCommandError {
            kind: MacOsCommandErrorKind::Failed,
        })?;
    if bytes.len() > maximum {
        return Err(MacOsCommandError {
            kind: MacOsCommandErrorKind::OutputTooLarge,
        });
    }
    Ok(bytes)
}

pub struct MacOsSystemProxyPlatform {
    availability: CapabilityAvailability,
    runner: Arc<dyn MacOsCommandRunner>,
}

pub struct MacOsNetworkDnsPlatform {
    available: bool,
    runner: Arc<dyn MacOsCommandRunner>,
}

impl MacOsNetworkDnsPlatform {
    pub fn new() -> Self {
        Self {
            available: cfg!(target_os = "macos")
                && std::path::Path::new("/usr/sbin/networksetup").is_file()
                && std::path::Path::new("/usr/sbin/scutil").is_file(),
            runner: Arc::new(MacOsSystemCommandRunner),
        }
    }

    pub fn with_runner(runner: Arc<dyn MacOsCommandRunner>) -> Self {
        Self {
            available: true,
            runner,
        }
    }
}

impl Default for MacOsNetworkDnsPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkDnsPlatform for MacOsNetworkDnsPlatform {
    fn observe(&self) -> BoxFuture<'_, Result<NetworkDnsObservation, NetworkDnsObservationError>> {
        Box::pin(async move {
            if !self.available {
                return Err(network_dns_error(NetworkDnsFailureKind::CommandUnavailable));
            }
            let (network, dns, services) = tokio::join!(
                self.runner.run(MacOsCommand::NetworkInformation),
                self.runner.run(MacOsCommand::DnsConfiguration),
                self.runner.run(MacOsCommand::ListNetworkServiceOrder),
            );
            let network = network.map_err(map_network_dns_command_error)?;
            let dns = dns.map_err(map_network_dns_command_error)?;
            let services = services.map_err(map_network_dns_command_error)?;
            let mut interfaces = parse_network_information(&network.stdout)?;
            for interface in &mut interfaces {
                if let Some(metadata) =
                    parse_network_service_metadata(&services.stdout, &interface.interface)
                {
                    interface.interface_kind = classify_interface(&metadata.hardware_port);
                    interface.service = Some(metadata.service);
                }
            }
            Ok(NetworkDnsObservation {
                dns: parse_dns_configuration(&dns.stdout)?,
                interfaces,
                source: NetworkDnsSource::MacosSystemConfiguration,
            })
        })
    }
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
            pac_url: parse_required_key(&pac_output, "URL")?,
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
        if !proxy.is_reversible() {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::UnsafeExistingConfiguration,
                "The proxy settings cannot be restored safely",
            ));
        }
        self.runner
            .run(MacOsCommand::SetProxy {
                host: proxy.host.clone(),
                kind,
                port: proxy.port,
                service: service.to_owned(),
            })
            .await
            .map_err(apply_error)?;
        self.runner
            .run(MacOsCommand::SetProxyState {
                enabled: proxy.enabled,
                kind,
                service: service.to_owned(),
            })
            .await
            .map_err(apply_error)?;
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

#[derive(Debug, Eq, PartialEq)]
struct NetworkServiceMetadata {
    hardware_port: String,
    service: String,
}

fn parse_network_information(
    output: &str,
) -> Result<Vec<NetworkInterfaceObservation>, NetworkDnsObservationError> {
    #[derive(Clone, Copy)]
    enum Family {
        Ipv4,
        Ipv6,
        None,
    }

    if !output
        .lines()
        .any(|line| line.trim() == "Network information")
    {
        return Err(network_dns_error(NetworkDnsFailureKind::InvalidOutput));
    }
    let mut family = Family::None;
    let mut ipv4 = HashSet::new();
    let mut ipv6 = HashSet::new();
    let mut active = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed == "IPv4 network interface information" {
            family = Family::Ipv4;
            continue;
        }
        if trimmed == "IPv6 network interface information" {
            family = Family::Ipv6;
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Network interfaces:") {
            for candidate in value
                .split(|character: char| character.is_ascii_whitespace() || character == ',')
                .filter(|candidate| valid_interface_name(candidate))
            {
                if active.iter().any(|existing| existing == candidate) {
                    continue;
                }
                if active.len() >= 16 {
                    return Err(network_dns_error(NetworkDnsFailureKind::InvalidOutput));
                }
                active.push(candidate.to_owned());
            }
            continue;
        }
        let Some((candidate, rest)) = trimmed.split_once(':') else {
            continue;
        };
        let candidate = candidate.trim();
        if !rest.trim_start().starts_with("flags") || !valid_interface_name(candidate) {
            continue;
        }
        match family {
            Family::Ipv4 => {
                ipv4.insert(candidate.to_owned());
            }
            Family::Ipv6 => {
                ipv6.insert(candidate.to_owned());
            }
            Family::None => {}
        }
    }
    Ok(active
        .into_iter()
        .map(|interface| NetworkInterfaceObservation {
            ipv4_available: ipv4.contains(&interface),
            ipv6_available: ipv6.contains(&interface),
            interface,
            interface_kind: NetworkInterfaceKind::Unknown,
            service: None,
        })
        .collect())
}

fn valid_interface_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn parse_network_service_metadata(output: &str, device: &str) -> Option<NetworkServiceMetadata> {
    let mut service = None;
    for line in output.lines().map(str::trim) {
        if line.starts_with('(') && !line.starts_with("(Hardware Port:") {
            service = line
                .split_once(") ")
                .and_then(|(_, name)| (!name.starts_with('*')).then_some(name))
                .and_then(bounded_display_value)
                .map(str::to_owned);
            continue;
        }
        let Some(body) = line
            .strip_prefix("(Hardware Port:")
            .and_then(|value| value.strip_suffix(')'))
        else {
            continue;
        };
        let Some((hardware_port, candidate_device)) = body.split_once(", Device:") else {
            continue;
        };
        if candidate_device.trim() != device {
            continue;
        }
        let service = service.take()?;
        let hardware_port = bounded_display_value(hardware_port.trim())?.to_owned();
        return Some(NetworkServiceMetadata {
            hardware_port,
            service,
        });
    }
    None
}

fn classify_interface(hardware_port: &str) -> NetworkInterfaceKind {
    let normalized = hardware_port.to_ascii_lowercase();
    if normalized == "wi-fi" || normalized == "airport" {
        return NetworkInterfaceKind::Wifi;
    }
    if normalized.contains("thunderbolt") && normalized.contains("bridge") {
        return NetworkInterfaceKind::ThunderboltBridge;
    }
    if normalized.contains("ethernet") {
        return NetworkInterfaceKind::Ethernet;
    }
    NetworkInterfaceKind::Other
}

fn parse_dns_configuration(output: &str) -> Result<DnsObservation, NetworkDnsObservationError> {
    if matches!(
        output.trim(),
        "DNS configuration not available" | "No DNS configuration available"
    ) {
        return Ok(DnsObservation {
            resolver_count: 0,
            scoped_resolver_count: 0,
            search_domains: Vec::new(),
            servers: Vec::new(),
        });
    }
    if !output
        .lines()
        .any(|line| line.trim() == "DNS configuration")
    {
        return Err(network_dns_error(NetworkDnsFailureKind::InvalidOutput));
    }
    let mut resolver_count = 0_u16;
    let mut scoped = false;
    let mut scoped_resolver_count = 0_u16;
    let mut search_domains = Vec::new();
    let mut servers = Vec::new();
    for line in output.lines().map(str::trim) {
        if line == "DNS configuration (for scoped queries)" {
            scoped = true;
            continue;
        }
        if line.strip_prefix("resolver #").is_some() {
            let count = if scoped {
                &mut scoped_resolver_count
            } else {
                &mut resolver_count
            };
            *count = count
                .checked_add(1)
                .ok_or_else(|| network_dns_error(NetworkDnsFailureKind::InvalidOutput))?;
            if *count > 64 {
                return Err(network_dns_error(NetworkDnsFailureKind::InvalidOutput));
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let Some(value) = bounded_display_value(value.trim()) else {
            continue;
        };
        if key.trim().starts_with("nameserver[") {
            push_unique_bounded(&mut servers, value, 32)?;
        } else if key.trim().starts_with("search domain[") {
            push_unique_bounded(&mut search_domains, value, 32)?;
        }
    }
    Ok(DnsObservation {
        resolver_count,
        scoped_resolver_count,
        search_domains,
        servers,
    })
}

fn bounded_display_value(value: &str) -> Option<&str> {
    (!value.is_empty() && value.len() <= 253 && !value.chars().any(char::is_control))
        .then_some(value)
}

fn push_unique_bounded(
    values: &mut Vec<String>,
    value: &str,
    maximum: usize,
) -> Result<(), NetworkDnsObservationError> {
    if values.iter().any(|candidate| candidate == value) {
        return Ok(());
    }
    if values.len() >= maximum {
        return Err(network_dns_error(NetworkDnsFailureKind::InvalidOutput));
    }
    values.push(value.to_owned());
    Ok(())
}

const fn network_dns_error(kind: NetworkDnsFailureKind) -> NetworkDnsObservationError {
    NetworkDnsObservationError { kind }
}

fn map_network_dns_command_error(error: MacOsCommandError) -> NetworkDnsObservationError {
    network_dns_error(match error.kind {
        MacOsCommandErrorKind::Failed | MacOsCommandErrorKind::PermissionDenied => {
            NetworkDnsFailureKind::CommandFailed
        }
        MacOsCommandErrorKind::OutputTooLarge => NetworkDnsFailureKind::OutputTooLarge,
        MacOsCommandErrorKind::TimedOut => NetworkDnsFailureKind::TimedOut,
        MacOsCommandErrorKind::Unavailable => NetworkDnsFailureKind::CommandUnavailable,
    })
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
    let host = parse_required_key(output, "Server")?;
    let port = parse_required_key(output, "Port")?
        .parse::<u16>()
        .map_err(|_| observation_error())?;
    if enabled && (host.is_empty() || port == 0) {
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
    let value = parse_required_key(output, key)?;
    match value.to_ascii_lowercase().as_str() {
        "1" | "on" | "yes" => Ok(true),
        "0" | "off" | "no" => Ok(false),
        _ => Err(observation_error()),
    }
}

fn parse_required_key(output: &str, key: &str) -> Result<String, CaptureTransitionError> {
    parse_key(output, key).ok_or_else(observation_error)
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
        MacOsCommandErrorKind::Failed
        | MacOsCommandErrorKind::OutputTooLarge
        | MacOsCommandErrorKind::TimedOut => CaptureFailureKind::ApplyFailed,
    };
    CaptureTransitionError::new(kind, "The macOS System Proxy change failed")
}

fn persistence_error() -> CaptureTransitionError {
    CaptureTransitionError::new(
        CaptureFailureKind::PersistenceFailed,
        "The System Proxy recovery journal is unavailable",
    )
}

fn invalid_recovery_error() -> CaptureTransitionError {
    CaptureTransitionError::new(
        CaptureFailureKind::InvalidRecovery,
        "The System Proxy recovery journal is invalid",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_proxy_fixtures_preserve_exact_disabled_and_enabled_fields() {
        let blank =
            parse_proxy_state("Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n")
                .unwrap();
        assert_eq!(blank, ManualProxyState::disabled());

        let populated = parse_proxy_state(
            "Enabled: No\nServer: cached.proxy.example\nPort: 8080\nAuthenticated Proxy Enabled: 0\n",
        )
        .unwrap();
        assert_eq!(
            populated,
            ManualProxyState {
                authenticated: false,
                enabled: false,
                host: "cached.proxy.example".into(),
                port: 8080,
            }
        );

        let enabled = parse_proxy_state(
            "Enabled: Yes\nServer: active.proxy.example\nPort: 3128\nAuthenticated Proxy Enabled: 0\n",
        )
        .unwrap();
        assert_eq!(
            enabled,
            ManualProxyState {
                authenticated: false,
                enabled: true,
                host: "active.proxy.example".into(),
                port: 3128,
            }
        );
    }

    #[test]
    fn manual_proxy_fixtures_reject_absent_or_incomplete_fields() {
        for output in [
            "Server: \nPort: 0\nAuthenticated Proxy Enabled: 0\n",
            "Enabled: No\nPort: 0\nAuthenticated Proxy Enabled: 0\n",
            "Enabled: No\nServer: \nAuthenticated Proxy Enabled: 0\n",
            "Enabled: No\nServer: \nPort: 0\n",
            "Enabled: Yes\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n",
        ] {
            assert_eq!(
                parse_proxy_state(output).unwrap_err().kind,
                CaptureFailureKind::ObservationFailed
            );
        }
    }

    const NETWORK_FIXTURE: &str = r#"Network information

IPv4 network interface information
     en0 : flags      : 0x5 (IPv4,DNS)
           address    : 192.0.2.10
     en1 : flags      : 0x5 (IPv4,DNS)
           address    : 198.51.100.10

IPv6 network interface information
     en0 : flags      : 0x7 (IPv6,DNS)
           address    : 2001:db8::10

Network interfaces: en0 en1
"#;
    const DNS_FIXTURE: &str = r#"DNS configuration

resolver #1
  search domain[0] : office.example
  nameserver[0] : 192.0.2.53
  nameserver[1] : 2001:db8::53

resolver #2
  domain : local

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.0.2.53
"#;
    const SERVICES_FIXTURE: &str = r#"An asterisk (*) denotes that a network service is disabled.
(1) Office LAN
(Hardware Port: Ethernet, Device: en0)

(2) Wi-Fi
(Hardware Port: Wi-Fi, Device: en1)
"#;

    struct FixtureRunner {
        failure: Option<MacOsCommandErrorKind>,
    }

    impl MacOsCommandRunner for FixtureRunner {
        fn run(
            &self,
            command: MacOsCommand,
        ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
            let failure = self.failure;
            Box::pin(async move {
                if let Some(kind) = failure {
                    return Err(MacOsCommandError { kind });
                }
                let stdout = match command {
                    MacOsCommand::NetworkInformation => NETWORK_FIXTURE,
                    MacOsCommand::DnsConfiguration => DNS_FIXTURE,
                    MacOsCommand::ListNetworkServiceOrder => SERVICES_FIXTURE,
                    _ => panic!("unexpected fixture command"),
                };
                Ok(MacOsCommandOutput {
                    stdout: stdout.to_owned(),
                })
            })
        }
    }

    #[test]
    fn observation_commands_use_fixed_absolute_executables_and_arguments() {
        assert_eq!(
            MacOsCommand::NetworkInformation.spec(),
            MacOsCommandSpec {
                arguments: vec!["--nwi".into()],
                program: "/usr/sbin/scutil",
            }
        );
        assert_eq!(
            MacOsCommand::DnsConfiguration.spec(),
            MacOsCommandSpec {
                arguments: vec!["--dns".into()],
                program: "/usr/sbin/scutil",
            }
        );
        assert_eq!(
            MacOsCommand::ListNetworkServiceOrder.spec(),
            MacOsCommandSpec {
                arguments: vec!["-listnetworkserviceorder".into()],
                program: "/usr/sbin/networksetup",
            }
        );
    }

    #[tokio::test]
    async fn fixture_adapter_reports_authoritative_active_interfaces_and_dns_summary() {
        let adapter =
            MacOsNetworkDnsPlatform::with_runner(Arc::new(FixtureRunner { failure: None }));
        let observation = adapter.observe().await.expect("fixture observation");
        let interface = observation.interfaces.first().expect("active interface");
        assert_eq!(interface.interface, "en0");
        assert_eq!(interface.service.as_deref(), Some("Office LAN"));
        assert_eq!(interface.interface_kind, NetworkInterfaceKind::Ethernet);
        assert!(interface.ipv4_available);
        assert!(interface.ipv6_available);
        let wifi = observation
            .interfaces
            .get(1)
            .expect("second active interface");
        assert_eq!(wifi.interface, "en1");
        assert_eq!(wifi.interface_kind, NetworkInterfaceKind::Wifi);
        assert!(wifi.ipv4_available);
        assert!(!wifi.ipv6_available);
        assert_eq!(observation.dns.resolver_count, 2);
        assert_eq!(observation.dns.scoped_resolver_count, 1);
        assert_eq!(observation.dns.servers, vec!["192.0.2.53", "2001:db8::53"]);
        assert_eq!(observation.dns.search_domains, vec!["office.example"]);
    }

    #[test]
    fn parser_rejects_missing_authority_and_bounds_resolvers() {
        assert_eq!(
            parse_network_information("Network information\n").unwrap(),
            Vec::new()
        );
        let excessive = format!(
            "DNS configuration\n{}",
            (1..=65)
                .map(|index| format!("resolver #{index}\n"))
                .collect::<String>()
        );
        assert_eq!(
            parse_dns_configuration(&excessive).unwrap_err().kind,
            NetworkDnsFailureKind::InvalidOutput
        );
    }

    #[tokio::test]
    async fn adapter_maps_timeout_and_oversized_output_without_exposing_output() {
        for (command, expected) in [
            (
                MacOsCommandErrorKind::TimedOut,
                NetworkDnsFailureKind::TimedOut,
            ),
            (
                MacOsCommandErrorKind::OutputTooLarge,
                NetworkDnsFailureKind::OutputTooLarge,
            ),
        ] {
            let adapter = MacOsNetworkDnsPlatform::with_runner(Arc::new(FixtureRunner {
                failure: Some(command),
            }));
            assert_eq!(adapter.observe().await.unwrap_err().kind, expected);
        }
    }

    #[tokio::test]
    async fn bounded_reader_stops_after_the_hard_output_limit() {
        let error = read_bounded(std::io::Cursor::new(vec![b'x'; 17]), 16)
            .await
            .unwrap_err();
        assert_eq!(error.kind, MacOsCommandErrorKind::OutputTooLarge);
    }
}
