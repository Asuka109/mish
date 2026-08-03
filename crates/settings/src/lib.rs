//! Transport-neutral application settings and bounded private persistence.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::future::BoxFuture;
use mish_mihomo_controller::PINNED_MIHOMO_VERSION;
use mish_runtime::{
    CaptureSelection, SystemProxyTakeoverPolicy, TunHelperAvailability, TunHelperController,
    TunHelperFailureKind, TunHelperSnapshot,
};
use mish_state_authority::{StateMutationAuthority, StateMutationPermit};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use thiserror::Error;
use tokio::sync::broadcast;

const CURRENT_SCHEMA_VERSION: u8 = 12;
const ONBOARDING_WELCOME_VERSION: u8 = 2;
const SETTINGS_MAX_BYTES: u64 = 32_768;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppearancePreference {
    Dark,
    Light,
    #[default]
    System,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguagePreference {
    #[default]
    En,
    #[serde(rename = "zh-CN")]
    Zh,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoginLaunchBehavior {
    Background,
    #[default]
    ShowWindow,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowCloseBehavior {
    #[default]
    HideToStatusBar,
    Quit,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowSurfacePreference {
    #[default]
    Material,
    Opaque,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessDiscoveryMode {
    #[default]
    Always,
    Strict,
    Off,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationLaunchBehavior {
    Core,
    #[default]
    Off,
    Proxy,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupPreferences {
    pub launch_behavior: ApplicationLaunchBehavior,
    pub launch_at_login: bool,
    pub login_launch_behavior: LoginLaunchBehavior,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedPortPreferences {
    pub controller: u16,
    pub proxy: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedPortKind {
    Controller,
    Proxy,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureSelectionPreferences {
    pub system_proxy: bool,
    pub tun: bool,
}

impl From<CaptureSelectionPreferences> for CaptureSelection {
    fn from(selection: CaptureSelectionPreferences) -> Self {
        Self {
            system_proxy: selection.system_proxy,
            tun: selection.tun,
        }
    }
}

impl Default for ManagedPortPreferences {
    fn default() -> Self {
        Self {
            controller: 9090,
            proxy: 7890,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardingWelcomeInvitation {
    pub completed_at: Option<u64>,
    pub created_at: u64,
    pub first_opened_at: Option<u64>,
    pub last_dismissed_at: Option<u64>,
    pub prompted_at: Option<u64>,
    pub version: u8,
}

impl OnboardingWelcomeInvitation {
    fn fresh(created_at: u64) -> Self {
        Self {
            completed_at: None,
            created_at,
            first_opened_at: None,
            last_dismissed_at: None,
            prompted_at: None,
            version: ONBOARDING_WELCOME_VERSION,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardingPreferences {
    pub welcome_invitation: Option<OnboardingWelcomeInvitation>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OnboardingWelcomeAction {
    Complete,
    Dismiss,
    Open,
    Prompt,
    Remove,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPreferences {
    pub appearance: AppearancePreference,
    #[serde(default)]
    pub capture_selection: CaptureSelectionPreferences,
    #[serde(default)]
    pub close_old_connections_after_group_switch: bool,
    pub language: LanguagePreference,
    #[serde(default)]
    pub managed_ports: ManagedPortPreferences,
    pub onboarding: OnboardingPreferences,
    #[serde(default)]
    pub process_discovery_mode: ProcessDiscoveryMode,
    pub startup: StartupPreferences,
    #[serde(default)]
    pub system_proxy_takeover_policy: SystemProxyTakeoverPolicy,
    pub window_close_behavior: WindowCloseBehavior,
    pub window_surface: WindowSurfacePreference,
}

impl SettingsPreferences {
    fn fresh_install(created_at: u64) -> Self {
        Self {
            onboarding: OnboardingPreferences {
                welcome_invitation: Some(OnboardingWelcomeInvitation::fresh(created_at)),
            },
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsAdapterKind {
    Fixture,
    Native,
    Rpc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsAvailability {
    ComingLater,
    Supported,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCapabilities {
    pub background_launch: SettingsAvailability,
    pub backup_restore: SettingsAvailability,
    pub expert_configuration: SettingsAvailability,
    pub launch_at_login: SettingsAvailability,
    pub network_dns: SettingsAvailability,
    pub native_sidebar_material: SettingsAvailability,
    pub policy_group_connection_cleanup: SettingsAvailability,
    pub status_bar: SettingsAvailability,
    pub tun: SettingsAvailability,
    pub updates: SettingsAvailability,
    pub window_lifecycle: SettingsAvailability,
}

impl SettingsCapabilities {
    pub fn android() -> Self {
        Self {
            background_launch: SettingsAvailability::Unavailable,
            backup_restore: SettingsAvailability::ComingLater,
            expert_configuration: SettingsAvailability::ComingLater,
            launch_at_login: SettingsAvailability::Unavailable,
            network_dns: SettingsAvailability::Unavailable,
            native_sidebar_material: SettingsAvailability::Unavailable,
            policy_group_connection_cleanup: SettingsAvailability::Unavailable,
            status_bar: SettingsAvailability::Unavailable,
            tun: SettingsAvailability::Unavailable,
            updates: SettingsAvailability::ComingLater,
            window_lifecycle: SettingsAvailability::Unavailable,
        }
    }

    pub fn macos(native_sidebar_material: bool) -> Self {
        Self {
            background_launch: SettingsAvailability::Supported,
            backup_restore: SettingsAvailability::ComingLater,
            expert_configuration: SettingsAvailability::ComingLater,
            launch_at_login: SettingsAvailability::Supported,
            network_dns: SettingsAvailability::Supported,
            native_sidebar_material: if native_sidebar_material {
                SettingsAvailability::Supported
            } else {
                SettingsAvailability::Unavailable
            },
            status_bar: SettingsAvailability::Supported,
            policy_group_connection_cleanup: SettingsAvailability::Supported,
            tun: SettingsAvailability::Unavailable,
            updates: SettingsAvailability::ComingLater,
            window_lifecycle: SettingsAvailability::Supported,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfirmationState {
    Confirmed,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyAccessSnapshot {
    pub authenticated: ConfirmationState,
    pub lan_control: SettingsAvailability,
    pub loopback_only: ConfirmationState,
    pub origin_validated: ConfirmationState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupRegistrationPhase {
    Applied,
    Drift,
    Failed,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupRegistrationSnapshot {
    pub desired: bool,
    pub observed: Option<bool>,
    pub phase: StartupRegistrationPhase,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub adapter_kind: SettingsAdapterKind,
    pub build: SettingsBuildInfo,
    pub capabilities: SettingsCapabilities,
    pub network_dns: NetworkDnsSnapshot,
    pub preferences: SettingsPreferences,
    pub privacy: PrivacyAccessSnapshot,
    pub revision: u64,
    pub startup_registration: StartupRegistrationSnapshot,
    pub storage_recovered: bool,
    pub tun_helper: TunHelperSnapshot,
}

/// Versions shown by Settings come from the packaged application build and the pinned Core.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBuildInfo {
    pub app_version: String,
    pub mihomo_version: String,
}

impl SettingsBuildInfo {
    pub fn packaged(app_version: impl Into<String>) -> Self {
        Self {
            app_version: app_version.into(),
            mihomo_version: PINNED_MIHOMO_VERSION.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkDnsPhase {
    Failed,
    Ready,
    Stale,
    Unavailable,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkDnsFailureKind {
    CommandFailed,
    CommandUnavailable,
    InvalidOutput,
    OutputTooLarge,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkInterfaceKind {
    Ethernet,
    Other,
    ThunderboltBridge,
    Unknown,
    Wifi,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceObservation {
    pub interface: String,
    pub interface_kind: NetworkInterfaceKind,
    pub ipv4_available: bool,
    pub ipv6_available: bool,
    pub service: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsObservation {
    pub resolver_count: u16,
    pub scoped_resolver_count: u16,
    pub search_domains: Vec<String>,
    pub servers: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkDnsSource {
    MacosSystemConfiguration,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDnsSnapshot {
    pub dns: Option<DnsObservation>,
    pub failure: Option<NetworkDnsFailureKind>,
    pub observed_at: Option<u64>,
    pub phase: NetworkDnsPhase,
    pub interfaces: Vec<NetworkInterfaceObservation>,
    pub source: Option<NetworkDnsSource>,
}

impl NetworkDnsSnapshot {
    fn unavailable() -> Self {
        Self {
            dns: None,
            failure: None,
            interfaces: Vec::new(),
            observed_at: None,
            phase: NetworkDnsPhase::Unavailable,
            source: None,
        }
    }

    fn unknown() -> Self {
        Self {
            dns: None,
            failure: None,
            interfaces: Vec::new(),
            observed_at: None,
            phase: NetworkDnsPhase::Unknown,
            source: Some(NetworkDnsSource::MacosSystemConfiguration),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkDnsObservation {
    pub dns: DnsObservation,
    pub interfaces: Vec<NetworkInterfaceObservation>,
    pub source: NetworkDnsSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NetworkDnsObservationError {
    pub kind: NetworkDnsFailureKind,
}

pub trait NetworkDnsPlatform: Send + Sync {
    fn observe(&self) -> BoxFuture<'_, Result<NetworkDnsObservation, NetworkDnsObservationError>>;
}

pub trait StartupPlatform: Send + Sync {
    fn is_enabled(&self) -> Result<bool, StartupPlatformError>;
    fn set_enabled(&self, enabled: bool) -> Result<(), StartupPlatformError>;
}

pub trait WindowSurfacePlatform: Send + Sync {
    fn set_surface(
        &self,
        surface: WindowSurfacePreference,
    ) -> Result<(), WindowSurfacePlatformError>;
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("the startup integration could not confirm the requested state")]
pub struct StartupPlatformError;

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("the native window surface could not be applied")]
pub struct WindowSurfacePlatformError;

pub trait SettingsRepository: Send + Sync {
    fn load(&self) -> Result<LoadedSettings, SettingsRepositoryError>;
    fn save(&self, preferences: &SettingsPreferences) -> Result<(), SettingsRepositoryError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LoadedSettings {
    pub needs_persistence: bool,
    pub preferences: SettingsPreferences,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum SettingsRepositoryError {
    #[error("stored application settings are corrupt")]
    Corrupt,
    #[error("application settings storage is unavailable")]
    Unavailable,
}

#[derive(Debug, Error)]
pub enum SettingsServiceError {
    #[error("the requested capability is unavailable")]
    CapabilityUnavailable,
    #[error("application settings could not be persisted")]
    Persistence,
    #[error("startup registration could not be confirmed")]
    Startup,
    #[error("the TUN helper lifecycle operation could not be confirmed")]
    TunHelper(TunHelperFailureKind),
    #[error("the native window surface could not be applied")]
    WindowSurface,
    #[error("another Profile or Settings mutation is in progress")]
    Busy,
}

pub struct SettingsService {
    authority: StateMutationAuthority,
    build: SettingsBuildInfo,
    capabilities: SettingsCapabilities,
    changes: broadcast::Sender<SettingsSnapshot>,
    network_dns: NetworkDnsCoordinator,
    operation: Mutex<()>,
    repository: Arc<dyn SettingsRepository>,
    startup_platform: Option<Arc<dyn StartupPlatform>>,
    state: Mutex<SettingsState>,
    tun_helper: Option<Arc<TunHelperController>>,
    window_surface_platform: Option<Arc<dyn WindowSurfacePlatform>>,
}

#[derive(Clone, Copy)]
struct SettingsState {
    preferences: SettingsPreferences,
    revision: u64,
    storage_recovered: bool,
}

struct NetworkDnsCoordinator {
    authority: AtomicU64,
    completed: AtomicU64,
    operation: tokio::sync::Mutex<()>,
    platform: Option<Arc<dyn NetworkDnsPlatform>>,
    state: Mutex<NetworkDnsSnapshot>,
}

impl NetworkDnsCoordinator {
    fn new(platform: Option<Arc<dyn NetworkDnsPlatform>>) -> Self {
        let state = if platform.is_some() {
            NetworkDnsSnapshot::unknown()
        } else {
            NetworkDnsSnapshot::unavailable()
        };
        Self {
            authority: AtomicU64::new(1),
            completed: AtomicU64::new(0),
            operation: tokio::sync::Mutex::new(()),
            platform,
            state: Mutex::new(state),
        }
    }

    fn invalidate(&self) {
        if self.platform.is_none() {
            return;
        }
        self.authority.fetch_add(1, Ordering::AcqRel);
        let mut snapshot = self.state.lock().expect("network DNS state lock poisoned");
        snapshot.failure = None;
        snapshot.phase = if snapshot.observed_at.is_some() {
            NetworkDnsPhase::Stale
        } else {
            NetworkDnsPhase::Unknown
        };
    }

    fn snapshot(&self) -> NetworkDnsSnapshot {
        self.state
            .lock()
            .expect("network DNS state lock poisoned")
            .clone()
    }

    async fn refresh(&self) -> NetworkDnsSnapshot {
        let Some(platform) = &self.platform else {
            return self.snapshot();
        };
        let completed_before = self.completed.load(Ordering::Acquire);
        let _operation = self.operation.lock().await;
        if self.completed.load(Ordering::Acquire) != completed_before {
            return self.snapshot();
        }
        let authority = self.authority.load(Ordering::Acquire);
        let result = platform.observe().await;
        if self.authority.load(Ordering::Acquire) != authority {
            return self.snapshot();
        }
        let mut snapshot = self.state.lock().expect("network DNS state lock poisoned");
        match result {
            Ok(observation) => {
                snapshot.dns = Some(observation.dns);
                snapshot.failure = None;
                snapshot.observed_at = Some(observation_time());
                snapshot.phase = NetworkDnsPhase::Ready;
                snapshot.interfaces = observation.interfaces;
                snapshot.source = Some(observation.source);
            }
            Err(error) => {
                snapshot.failure = Some(error.kind);
                snapshot.phase = NetworkDnsPhase::Failed;
            }
        }
        self.completed.fetch_add(1, Ordering::AcqRel);
        snapshot.clone()
    }
}

fn observation_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

impl SettingsService {
    pub fn load(
        repository: Arc<dyn SettingsRepository>,
        startup_platform: Option<Arc<dyn StartupPlatform>>,
        window_surface_platform: Option<Arc<dyn WindowSurfacePlatform>>,
        capabilities: SettingsCapabilities,
    ) -> Result<Self, SettingsServiceError> {
        Self::load_with_tun_helper(
            repository,
            startup_platform,
            window_surface_platform,
            capabilities,
            None,
        )
    }

    pub fn load_with_tun_helper(
        repository: Arc<dyn SettingsRepository>,
        startup_platform: Option<Arc<dyn StartupPlatform>>,
        window_surface_platform: Option<Arc<dyn WindowSurfacePlatform>>,
        capabilities: SettingsCapabilities,
        tun_helper: Option<Arc<TunHelperController>>,
    ) -> Result<Self, SettingsServiceError> {
        Self::load_with_platforms_and_authority(
            repository,
            startup_platform,
            window_surface_platform,
            capabilities,
            tun_helper,
            None,
            StateMutationAuthority::new(),
        )
    }

    pub fn load_with_platforms(
        repository: Arc<dyn SettingsRepository>,
        startup_platform: Option<Arc<dyn StartupPlatform>>,
        window_surface_platform: Option<Arc<dyn WindowSurfacePlatform>>,
        capabilities: SettingsCapabilities,
        tun_helper: Option<Arc<TunHelperController>>,
        network_dns_platform: Option<Arc<dyn NetworkDnsPlatform>>,
    ) -> Result<Self, SettingsServiceError> {
        Self::load_with_platforms_and_authority(
            repository,
            startup_platform,
            window_surface_platform,
            capabilities,
            tun_helper,
            network_dns_platform,
            StateMutationAuthority::new(),
        )
    }

    pub fn load_with_platforms_and_authority(
        repository: Arc<dyn SettingsRepository>,
        startup_platform: Option<Arc<dyn StartupPlatform>>,
        window_surface_platform: Option<Arc<dyn WindowSurfacePlatform>>,
        capabilities: SettingsCapabilities,
        tun_helper: Option<Arc<TunHelperController>>,
        network_dns_platform: Option<Arc<dyn NetworkDnsPlatform>>,
        authority: StateMutationAuthority,
    ) -> Result<Self, SettingsServiceError> {
        Self::load_with_platforms_and_authority_and_build(
            repository,
            startup_platform,
            window_surface_platform,
            capabilities,
            tun_helper,
            network_dns_platform,
            authority,
            SettingsBuildInfo::packaged(env!("CARGO_PKG_VERSION")),
        )
    }

    pub fn load_with_platforms_and_authority_and_build(
        repository: Arc<dyn SettingsRepository>,
        startup_platform: Option<Arc<dyn StartupPlatform>>,
        window_surface_platform: Option<Arc<dyn WindowSurfacePlatform>>,
        mut capabilities: SettingsCapabilities,
        tun_helper: Option<Arc<TunHelperController>>,
        network_dns_platform: Option<Arc<dyn NetworkDnsPlatform>>,
        authority: StateMutationAuthority,
        build: SettingsBuildInfo,
    ) -> Result<Self, SettingsServiceError> {
        if network_dns_platform.is_none() {
            capabilities.network_dns = SettingsAvailability::Unavailable;
        }
        let (loaded, storage_recovered) = match repository.load() {
            Ok(loaded) => (loaded, false),
            Err(SettingsRepositoryError::Corrupt) => {
                let preferences = SettingsPreferences::default();
                repository
                    .save(&preferences)
                    .map_err(|_| SettingsServiceError::Persistence)?;
                (
                    LoadedSettings {
                        needs_persistence: false,
                        preferences,
                    },
                    true,
                )
            }
            Err(SettingsRepositoryError::Unavailable) => {
                return Err(SettingsServiceError::Persistence);
            }
        };
        if loaded.needs_persistence {
            repository
                .save(&loaded.preferences)
                .map_err(|_| SettingsServiceError::Persistence)?;
        }
        if capabilities.native_sidebar_material == SettingsAvailability::Supported {
            window_surface_platform
                .as_ref()
                .ok_or(SettingsServiceError::CapabilityUnavailable)?
                .set_surface(loaded.preferences.window_surface)
                .map_err(|_| SettingsServiceError::WindowSurface)?;
        }
        Ok(Self {
            authority,
            build,
            capabilities,
            changes: broadcast::channel(16).0,
            network_dns: NetworkDnsCoordinator::new(network_dns_platform),
            operation: Mutex::new(()),
            repository,
            startup_platform,
            state: Mutex::new(SettingsState {
                preferences: loaded.preferences,
                revision: 1,
                storage_recovered,
            }),
            tun_helper,
            window_surface_platform,
        })
    }

    pub fn snapshot(&self, adapter_kind: SettingsAdapterKind) -> SettingsSnapshot {
        let state = *self.state.lock().expect("settings state lock poisoned");
        let observed = self
            .startup_platform
            .as_ref()
            .and_then(|platform| platform.is_enabled().ok());
        let startup_registration = startup_registration(
            state.preferences.startup.launch_at_login,
            observed,
            self.capabilities.launch_at_login,
        );
        let tun_helper = self
            .tun_helper
            .as_ref()
            .map_or_else(TunHelperSnapshot::browser_unavailable, |helper| {
                helper.snapshot()
            });
        let mut capabilities = self.capabilities;
        capabilities.tun = match tun_helper.availability {
            TunHelperAvailability::Available if tun_helper.is_healthy() => {
                SettingsAvailability::Supported
            }
            TunHelperAvailability::PermissionRequired | TunHelperAvailability::RepairRequired => {
                SettingsAvailability::Supported
            }
            TunHelperAvailability::Available
            | TunHelperAvailability::Unpackaged
            | TunHelperAvailability::UnsignedApp
            | TunHelperAvailability::UnsupportedSystem
            | TunHelperAvailability::Unavailable => SettingsAvailability::Unavailable,
        };
        let privacy = match adapter_kind {
            SettingsAdapterKind::Rpc => PrivacyAccessSnapshot {
                authenticated: ConfirmationState::Confirmed,
                lan_control: SettingsAvailability::Unavailable,
                loopback_only: ConfirmationState::Confirmed,
                origin_validated: ConfirmationState::Confirmed,
            },
            SettingsAdapterKind::Fixture | SettingsAdapterKind::Native => PrivacyAccessSnapshot {
                authenticated: ConfirmationState::Unavailable,
                lan_control: SettingsAvailability::Unavailable,
                loopback_only: ConfirmationState::Unavailable,
                origin_validated: ConfirmationState::Unavailable,
            },
        };

        SettingsSnapshot {
            adapter_kind,
            build: self.build.clone(),
            capabilities,
            network_dns: self.network_dns.snapshot(),
            preferences: state.preferences,
            privacy,
            revision: state.revision,
            startup_registration,
            storage_recovered: state.storage_recovered,
            tun_helper,
        }
    }

    /// Bounded authoritative snapshots for native surfaces and authenticated RPC subscribers.
    pub fn subscribe(&self) -> broadcast::Receiver<SettingsSnapshot> {
        self.changes.subscribe()
    }

    /// Creates the receiver before reading the current value, so a mutation cannot be lost
    /// between subscription attachment and the initial authoritative snapshot.
    pub fn subscribe_with_snapshot(
        &self,
        adapter_kind: SettingsAdapterKind,
    ) -> (broadcast::Receiver<SettingsSnapshot>, SettingsSnapshot) {
        let receiver = self.changes.subscribe();
        let snapshot = self.snapshot(adapter_kind);
        (receiver, snapshot)
    }

    pub fn mutation_authority(&self) -> StateMutationAuthority {
        self.authority.clone()
    }

    pub fn invalidate_network_dns(&self) {
        self.network_dns.invalidate();
    }

    pub async fn refresh_network_dns(&self) -> SettingsSnapshot {
        self.network_dns.refresh().await;
        self.snapshot(SettingsAdapterKind::Rpc)
    }

    pub async fn refresh_tun_helper(&self) -> Result<SettingsSnapshot, SettingsServiceError> {
        self.tun_helper()?.refresh().await;
        Ok(self.snapshot(SettingsAdapterKind::Rpc))
    }

    pub async fn confirm_tun_helper_removal_safe(
        &self,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        self.tun_helper()?
            .confirm_removal_safe()
            .await
            .map_err(|error| SettingsServiceError::TunHelper(error.kind))?;
        Ok(self.snapshot(SettingsAdapterKind::Rpc))
    }

    pub async fn install_tun_helper(&self) -> Result<SettingsSnapshot, SettingsServiceError> {
        self.tun_helper()?
            .install()
            .await
            .map_err(|error| SettingsServiceError::TunHelper(error.kind))?;
        Ok(self.snapshot(SettingsAdapterKind::Rpc))
    }

    pub async fn repair_tun_helper(&self) -> Result<SettingsSnapshot, SettingsServiceError> {
        self.tun_helper()?
            .repair()
            .await
            .map_err(|error| SettingsServiceError::TunHelper(error.kind))?;
        Ok(self.snapshot(SettingsAdapterKind::Rpc))
    }

    pub async fn remove_tun_helper(&self) -> Result<SettingsSnapshot, SettingsServiceError> {
        self.tun_helper()?
            .remove()
            .await
            .map_err(|error| SettingsServiceError::TunHelper(error.kind))?;
        Ok(self.snapshot(SettingsAdapterKind::Rpc))
    }

    pub fn set_appearance(
        &self,
        appearance: AppearancePreference,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| preferences.appearance = appearance)
    }

    pub fn set_language(
        &self,
        language: LanguagePreference,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| preferences.language = language)
    }

    pub fn set_system_proxy_takeover_policy(
        &self,
        policy: SystemProxyTakeoverPolicy,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| preferences.system_proxy_takeover_policy = policy)
    }

    pub fn set_onboarding_welcome_state(
        &self,
        action: OnboardingWelcomeAction,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| {
            if action == OnboardingWelcomeAction::Remove {
                preferences.onboarding.welcome_invitation = None;
                return;
            }
            let Some(invitation) = preferences.onboarding.welcome_invitation.as_mut() else {
                return;
            };
            if invitation.completed_at.is_some() {
                return;
            }
            let now = observation_time()
                .max(invitation.created_at)
                .max(invitation.first_opened_at.unwrap_or_default())
                .max(invitation.last_dismissed_at.unwrap_or_default())
                .max(invitation.prompted_at.unwrap_or_default());
            match action {
                OnboardingWelcomeAction::Open => {
                    invitation.prompted_at.get_or_insert(now);
                    invitation.first_opened_at.get_or_insert(now);
                }
                OnboardingWelcomeAction::Dismiss => {
                    invitation.prompted_at.get_or_insert(now);
                    invitation.first_opened_at.get_or_insert(now);
                    invitation.last_dismissed_at = Some(now);
                }
                OnboardingWelcomeAction::Complete => {
                    invitation.prompted_at.get_or_insert(now);
                    invitation.first_opened_at.get_or_insert(now);
                    invitation.completed_at = Some(now);
                }
                OnboardingWelcomeAction::Prompt => {
                    invitation.prompted_at.get_or_insert(now);
                }
                OnboardingWelcomeAction::Remove => unreachable!("removal returns before borrowing"),
            }
        })
    }

    pub fn set_startup(
        &self,
        startup: StartupPreferences,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        if self.capabilities.launch_at_login != SettingsAvailability::Supported {
            return Err(SettingsServiceError::CapabilityUnavailable);
        }
        let platform = self
            .startup_platform
            .as_ref()
            .ok_or(SettingsServiceError::CapabilityUnavailable)?;
        let observed = platform
            .is_enabled()
            .map_err(|_| SettingsServiceError::Startup)?;
        let registration_changed = observed != startup.launch_at_login;
        if registration_changed {
            platform
                .set_enabled(startup.launch_at_login)
                .map_err(|_| SettingsServiceError::Startup)?;
            if platform.is_enabled().ok() != Some(startup.launch_at_login) {
                return Err(SettingsServiceError::Startup);
            }
        }
        match self.update(|preferences| preferences.startup = startup) {
            Ok(snapshot) => Ok(snapshot),
            Err(error) if registration_changed => {
                platform
                    .set_enabled(observed)
                    .map_err(|_| SettingsServiceError::Startup)?;
                if platform.is_enabled().ok() != Some(observed) {
                    return Err(SettingsServiceError::Startup);
                }
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    /// Changes only the next-launch behavior. It does not invoke Core,
    /// activate a Profile, register login startup, or touch System Proxy or TUN.
    pub fn set_application_launch_behavior(
        &self,
        launch_behavior: ApplicationLaunchBehavior,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| {
            preferences.startup.launch_behavior = launch_behavior;
        })
    }

    /// Remembers an explicitly selected capture combination for the next application launch.
    /// This persistence is intentionally independent from the launch preference and never
    /// starts Core or mutates System Proxy/TUN by itself.
    pub fn set_capture_selection(
        &self,
        capture_selection: CaptureSelection,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| {
            preferences.capture_selection = CaptureSelectionPreferences {
                system_proxy: capture_selection.system_proxy,
                tun: capture_selection.tun,
            };
        })
    }

    pub fn set_managed_ports(
        &self,
        managed_ports: ManagedPortPreferences,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        if managed_ports.proxy == 0
            || managed_ports.controller == 0
            || managed_ports.proxy == managed_ports.controller
        {
            return Err(SettingsServiceError::Persistence);
        }
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| preferences.managed_ports = managed_ports)
    }

    pub fn set_process_discovery_mode(
        &self,
        mode: ProcessDiscoveryMode,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| preferences.process_discovery_mode = mode)
    }

    pub fn set_close_old_connections_after_group_switch(
        &self,
        enabled: bool,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        if self.capabilities.policy_group_connection_cleanup != SettingsAvailability::Supported {
            return Err(SettingsServiceError::CapabilityUnavailable);
        }
        self.update(|preferences| {
            preferences.close_old_connections_after_group_switch = enabled;
        })
    }

    pub fn find_and_set_managed_ports(&self) -> Result<SettingsSnapshot, SettingsServiceError> {
        for _ in 0..8 {
            let proxy = available_loopback_port().ok_or(SettingsServiceError::Persistence)?;
            let Some(controller) = available_loopback_port().filter(|port| *port != proxy) else {
                continue;
            };
            return self.set_managed_ports(ManagedPortPreferences { controller, proxy });
        }
        Err(SettingsServiceError::Persistence)
    }

    pub fn find_and_set_managed_port(
        &self,
        kind: ManagedPortKind,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let current = self
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .managed_ports;
        for _ in 0..8 {
            let port = available_loopback_port().ok_or(SettingsServiceError::Persistence)?;
            let managed_ports = match kind {
                ManagedPortKind::Controller if port != current.proxy => ManagedPortPreferences {
                    controller: port,
                    ..current
                },
                ManagedPortKind::Proxy if port != current.controller => ManagedPortPreferences {
                    proxy: port,
                    ..current
                },
                _ => continue,
            };
            return self.set_managed_ports(managed_ports);
        }
        Err(SettingsServiceError::Persistence)
    }

    pub fn set_window_close_behavior(
        &self,
        behavior: WindowCloseBehavior,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        if self.capabilities.window_lifecycle != SettingsAvailability::Supported {
            return Err(SettingsServiceError::CapabilityUnavailable);
        }
        self.update(|preferences| preferences.window_close_behavior = behavior)
    }

    pub fn set_window_surface(
        &self,
        surface: WindowSurfacePreference,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _permit = self.acquire_mutation()?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        let previous = self
            .state
            .lock()
            .expect("settings state lock poisoned")
            .preferences
            .window_surface;
        if previous == surface {
            return Ok(self.snapshot(SettingsAdapterKind::Rpc));
        }

        let platform =
            if self.capabilities.native_sidebar_material == SettingsAvailability::Supported {
                Some(
                    self.window_surface_platform
                        .as_ref()
                        .ok_or(SettingsServiceError::CapabilityUnavailable)?,
                )
            } else {
                None
            };
        if let Some(platform) = platform {
            platform
                .set_surface(surface)
                .map_err(|_| SettingsServiceError::WindowSurface)?;
        }

        match self.update(|preferences| preferences.window_surface = surface) {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                if let Some(platform) = platform {
                    platform
                        .set_surface(previous)
                        .map_err(|_| SettingsServiceError::WindowSurface)?;
                }
                Err(error)
            }
        }
    }

    /// Accept preferences already committed by the local restore transaction.
    ///
    /// This deliberately bypasses every platform adapter: restoring preferences
    /// must not register login startup, apply a native window surface, or change
    /// any other operating-system state.
    pub fn accept_restored_preferences(
        &self,
        preferences: SettingsPreferences,
    ) -> Result<(), SettingsServiceError> {
        let permit = self.acquire_mutation()?;
        self.accept_restored_preferences_authorized(&permit, preferences)
    }

    pub fn accept_restored_preferences_authorized(
        &self,
        permit: &StateMutationPermit,
        preferences: SettingsPreferences,
    ) -> Result<(), SettingsServiceError> {
        self.authority
            .validate(permit)
            .map_err(|_| SettingsServiceError::Busy)?;
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        let mut state = self.state.lock().expect("settings state lock poisoned");
        self.repository
            .save(&preferences)
            .map_err(|_| SettingsServiceError::Persistence)?;
        state.preferences = preferences;
        state.storage_recovered = false;
        state.revision = state.revision.saturating_add(1);
        drop(state);
        let _ = self.changes.send(self.snapshot(SettingsAdapterKind::Rpc));
        Ok(())
    }

    fn acquire_mutation(&self) -> Result<StateMutationPermit, SettingsServiceError> {
        self.authority
            .try_acquire()
            .map_err(|_| SettingsServiceError::Busy)
    }

    fn update(
        &self,
        mutate: impl FnOnce(&mut SettingsPreferences),
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let mut state = self.state.lock().expect("settings state lock poisoned");
        let mut next = state.preferences;
        mutate(&mut next);
        self.repository
            .save(&next)
            .map_err(|_| SettingsServiceError::Persistence)?;
        state.preferences = next;
        state.storage_recovered = false;
        state.revision = state.revision.saturating_add(1);
        drop(state);
        let snapshot = self.snapshot(SettingsAdapterKind::Rpc);
        let _ = self.changes.send(snapshot.clone());
        Ok(snapshot)
    }

    fn tun_helper(&self) -> Result<&TunHelperController, SettingsServiceError> {
        self.tun_helper
            .as_deref()
            .ok_or(SettingsServiceError::CapabilityUnavailable)
    }
}

fn available_loopback_port() -> Option<u16> {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|address| address.port())
}

fn startup_registration(
    desired: bool,
    observed: Option<bool>,
    availability: SettingsAvailability,
) -> StartupRegistrationSnapshot {
    let phase = if availability != SettingsAvailability::Supported {
        StartupRegistrationPhase::Unavailable
    } else {
        match observed {
            Some(observed) if observed == desired => StartupRegistrationPhase::Applied,
            Some(_) => StartupRegistrationPhase::Drift,
            None => StartupRegistrationPhase::Failed,
        }
    };
    StartupRegistrationSnapshot {
        desired,
        observed,
        phase,
    }
}

#[derive(Clone)]
pub struct FileSettingsRepository {
    path: PathBuf,
}

impl FileSettingsRepository {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV7 {
    preferences: SettingsPreferences,
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV6 {
    preferences: SettingsPreferencesV6,
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPreferencesV6 {
    appearance: AppearancePreference,
    language: LanguagePreference,
    onboarding: OnboardingPreferences,
    startup: StartupPreferencesV6,
    window_close_behavior: WindowCloseBehavior,
    window_surface: WindowSurfacePreference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupPreferencesV6 {
    launch_at_login: bool,
    login_launch_behavior: LoginLaunchBehavior,
}

impl From<StartupPreferencesV6> for StartupPreferences {
    fn from(startup: StartupPreferencesV6) -> Self {
        Self {
            launch_behavior: ApplicationLaunchBehavior::Off,
            launch_at_login: startup.launch_at_login,
            login_launch_behavior: startup.login_launch_behavior,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV5 {
    preferences: SettingsPreferencesV6,
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV4 {
    preferences: SettingsPreferencesV4,
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPreferencesV4 {
    appearance: AppearancePreference,
    language: LanguagePreference,
    onboarding: OnboardingPreferencesV4,
    startup: StartupPreferencesV6,
    window_close_behavior: WindowCloseBehavior,
    window_surface: WindowSurfacePreference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OnboardingPreferencesV4 {
    welcome_invitation: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV3 {
    preferences: SettingsPreferencesV3,
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPreferencesV3 {
    appearance: AppearancePreference,
    language: LanguagePreference,
    startup: StartupPreferencesV6,
    window_close_behavior: WindowCloseBehavior,
    window_surface: WindowSurfacePreference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV2 {
    preferences: SettingsPreferencesV2,
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPreferencesV2 {
    appearance: AppearancePreference,
    language: LanguagePreference,
    startup: StartupPreferencesV6,
    window_close_behavior: WindowCloseBehavior,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV1 {
    preferences: SettingsPreferencesV1,
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsPreferencesV1 {
    appearance: AppearancePreference,
    language: LanguagePreference,
    startup: StartupPreferencesV6,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsV0 {
    locale: LanguagePreference,
    schema_version: u8,
    theme: AppearancePreference,
}

impl SettingsRepository for FileSettingsRepository {
    fn load(&self) -> Result<LoadedSettings, SettingsRepositoryError> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences::fresh_install(observation_time()),
                });
            }
            Err(_) => return Err(SettingsRepositoryError::Unavailable),
        };
        if metadata.len() > SETTINGS_MAX_BYTES {
            return Err(SettingsRepositoryError::Corrupt);
        }
        let bytes = fs::read(&self.path).map_err(|_| SettingsRepositoryError::Unavailable)?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| SettingsRepositoryError::Corrupt)?;
        match value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
        {
            Some(version) if version == u64::from(CURRENT_SCHEMA_VERSION) => {
                let stored: StoredSettingsV7 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if !valid_onboarding_preferences(stored.preferences.onboarding) {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: false,
                    preferences: stored.preferences,
                })
            }
            Some(11) | Some(9) | Some(8) | Some(7) => {
                let stored: StoredSettingsV7 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if !(stored.schema_version == 11
                    || stored.schema_version == 9
                    || stored.schema_version == 8
                    || stored.schema_version == 7)
                    || !valid_onboarding_preferences(stored.preferences.onboarding)
                {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: stored.preferences,
                })
            }
            Some(6) => {
                let stored: StoredSettingsV6 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 6
                    || !valid_onboarding_preferences(stored.preferences.onboarding)
                {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences {
                        appearance: stored.preferences.appearance,
                        language: stored.preferences.language,
                        capture_selection: CaptureSelectionPreferences::default(),
                        close_old_connections_after_group_switch: false,
                        managed_ports: ManagedPortPreferences::default(),
                        onboarding: stored.preferences.onboarding,
                        process_discovery_mode: ProcessDiscoveryMode::default(),
                        startup: StartupPreferences {
                            launch_behavior: ApplicationLaunchBehavior::Off,
                            launch_at_login: stored.preferences.startup.launch_at_login,
                            login_launch_behavior: stored.preferences.startup.login_launch_behavior,
                        },
                        system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
                        window_close_behavior: stored.preferences.window_close_behavior,
                        window_surface: stored.preferences.window_surface,
                    },
                })
            }
            Some(5) => {
                let stored: StoredSettingsV5 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 5 {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences {
                        appearance: stored.preferences.appearance,
                        language: stored.preferences.language,
                        capture_selection: CaptureSelectionPreferences::default(),
                        close_old_connections_after_group_switch: false,
                        managed_ports: ManagedPortPreferences::default(),
                        onboarding: OnboardingPreferences {
                            welcome_invitation: Some(OnboardingWelcomeInvitation::fresh(
                                observation_time(),
                            )),
                        },
                        process_discovery_mode: ProcessDiscoveryMode::default(),
                        startup: stored.preferences.startup.into(),
                        system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
                        window_close_behavior: stored.preferences.window_close_behavior,
                        window_surface: stored.preferences.window_surface,
                    },
                })
            }
            Some(4) => {
                let stored: StoredSettingsV4 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 4 {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                let _previous_invitation = stored.preferences.onboarding.welcome_invitation;
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences {
                        appearance: stored.preferences.appearance,
                        language: stored.preferences.language,
                        capture_selection: CaptureSelectionPreferences::default(),
                        close_old_connections_after_group_switch: false,
                        managed_ports: ManagedPortPreferences::default(),
                        onboarding: OnboardingPreferences {
                            welcome_invitation: Some(OnboardingWelcomeInvitation::fresh(
                                observation_time(),
                            )),
                        },
                        process_discovery_mode: ProcessDiscoveryMode::default(),
                        startup: stored.preferences.startup.into(),
                        system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
                        window_close_behavior: stored.preferences.window_close_behavior,
                        window_surface: stored.preferences.window_surface,
                    },
                })
            }
            Some(3) => {
                let stored: StoredSettingsV3 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 3 {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences {
                        appearance: stored.preferences.appearance,
                        language: stored.preferences.language,
                        capture_selection: CaptureSelectionPreferences::default(),
                        close_old_connections_after_group_switch: false,
                        managed_ports: ManagedPortPreferences::default(),
                        onboarding: OnboardingPreferences {
                            welcome_invitation: Some(OnboardingWelcomeInvitation::fresh(
                                observation_time(),
                            )),
                        },
                        process_discovery_mode: ProcessDiscoveryMode::default(),
                        startup: stored.preferences.startup.into(),
                        system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
                        window_close_behavior: stored.preferences.window_close_behavior,
                        window_surface: stored.preferences.window_surface,
                    },
                })
            }
            Some(2) => {
                let stored: StoredSettingsV2 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 2 {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences {
                        appearance: stored.preferences.appearance,
                        language: stored.preferences.language,
                        capture_selection: CaptureSelectionPreferences::default(),
                        close_old_connections_after_group_switch: false,
                        managed_ports: ManagedPortPreferences::default(),
                        onboarding: OnboardingPreferences {
                            welcome_invitation: Some(OnboardingWelcomeInvitation::fresh(
                                observation_time(),
                            )),
                        },
                        process_discovery_mode: ProcessDiscoveryMode::default(),
                        startup: stored.preferences.startup.into(),
                        system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
                        window_close_behavior: stored.preferences.window_close_behavior,
                        window_surface: WindowSurfacePreference::Material,
                    },
                })
            }
            Some(1) => {
                let stored: StoredSettingsV1 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 1 {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences {
                        appearance: stored.preferences.appearance,
                        language: stored.preferences.language,
                        capture_selection: CaptureSelectionPreferences::default(),
                        close_old_connections_after_group_switch: false,
                        managed_ports: ManagedPortPreferences::default(),
                        onboarding: OnboardingPreferences {
                            welcome_invitation: Some(OnboardingWelcomeInvitation::fresh(
                                observation_time(),
                            )),
                        },
                        process_discovery_mode: ProcessDiscoveryMode::default(),
                        startup: stored.preferences.startup.into(),
                        system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
                        window_close_behavior: WindowCloseBehavior::default(),
                        window_surface: WindowSurfacePreference::Material,
                    },
                })
            }
            Some(0) => {
                let stored: StoredSettingsV0 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 0 {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    needs_persistence: true,
                    preferences: SettingsPreferences {
                        appearance: stored.theme,
                        language: stored.locale,
                        capture_selection: CaptureSelectionPreferences::default(),
                        close_old_connections_after_group_switch: false,
                        managed_ports: ManagedPortPreferences::default(),
                        onboarding: OnboardingPreferences {
                            welcome_invitation: Some(OnboardingWelcomeInvitation::fresh(
                                observation_time(),
                            )),
                        },
                        process_discovery_mode: ProcessDiscoveryMode::default(),
                        startup: StartupPreferences::default(),
                        system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
                        window_close_behavior: WindowCloseBehavior::default(),
                        window_surface: WindowSurfacePreference::Material,
                    },
                })
            }
            _ => Err(SettingsRepositoryError::Corrupt),
        }
    }

    fn save(&self, preferences: &SettingsPreferences) -> Result<(), SettingsRepositoryError> {
        let bytes = serde_json::to_vec(&StoredSettingsV7 {
            preferences: *preferences,
            schema_version: CURRENT_SCHEMA_VERSION,
        })
        .map_err(|_| SettingsRepositoryError::Unavailable)?;
        if bytes.len() as u64 > SETTINGS_MAX_BYTES {
            return Err(SettingsRepositoryError::Unavailable);
        }
        let parent = self
            .path
            .parent()
            .ok_or(SettingsRepositoryError::Unavailable)?;
        fs::create_dir_all(parent).map_err(|_| SettingsRepositoryError::Unavailable)?;
        let temporary = temporary_path(&self.path);
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|_| SettingsRepositoryError::Unavailable)?;
        #[cfg(unix)]
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|_| SettingsRepositoryError::Unavailable)?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| SettingsRepositoryError::Unavailable)?;
        fs::rename(&temporary, &self.path).map_err(|_| SettingsRepositoryError::Unavailable)?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| SettingsRepositoryError::Unavailable)?;
        Ok(())
    }
}

fn valid_onboarding_preferences(onboarding: OnboardingPreferences) -> bool {
    let Some(invitation) = onboarding.welcome_invitation else {
        return true;
    };
    if invitation.version != ONBOARDING_WELCOME_VERSION {
        return false;
    }
    let timestamps = [
        invitation.completed_at,
        invitation.first_opened_at,
        invitation.last_dismissed_at,
        invitation.prompted_at,
    ];
    if timestamps
        .into_iter()
        .flatten()
        .any(|timestamp| timestamp < invitation.created_at)
    {
        return false;
    }
    if invitation.prompted_at.is_none()
        && (invitation.completed_at.is_some()
            || invitation.first_opened_at.is_some()
            || invitation.last_dismissed_at.is_some())
    {
        return false;
    }
    if let Some(prompted_at) = invitation.prompted_at
        && [
            invitation.completed_at,
            invitation.first_opened_at,
            invitation.last_dismissed_at,
        ]
        .into_iter()
        .flatten()
        .any(|timestamp| timestamp < prompted_at)
    {
        return false;
    }
    let Some(first_opened_at) = invitation.first_opened_at else {
        return invitation.completed_at.is_none() && invitation.last_dismissed_at.is_none();
    };
    invitation
        .last_dismissed_at
        .is_none_or(|timestamp| timestamp >= first_opened_at)
        && invitation
            .completed_at
            .is_none_or(|timestamp| timestamp >= first_opened_at)
}

fn temporary_path(destination: &Path) -> PathBuf {
    let mut path = destination.to_path_buf();
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.json");
    path.set_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tempfile::tempdir;
    use tokio::sync::Notify;

    struct FailingSaveRepository;

    impl SettingsRepository for FailingSaveRepository {
        fn load(&self) -> Result<LoadedSettings, SettingsRepositoryError> {
            Ok(LoadedSettings {
                needs_persistence: false,
                preferences: SettingsPreferences::default(),
            })
        }

        fn save(&self, _preferences: &SettingsPreferences) -> Result<(), SettingsRepositoryError> {
            Err(SettingsRepositoryError::Unavailable)
        }
    }

    struct FakeStartupPlatform {
        enabled: AtomicBool,
        fail: bool,
        fail_disable: bool,
    }

    struct BlockingNetworkDnsPlatform {
        calls: AtomicUsize,
        first_started: Notify,
        release_first: Notify,
    }

    impl NetworkDnsPlatform for BlockingNetworkDnsPlatform {
        fn observe(
            &self,
        ) -> BoxFuture<'_, Result<NetworkDnsObservation, NetworkDnsObservationError>> {
            Box::pin(async move {
                let call = self.calls.fetch_add(1, Ordering::AcqRel);
                if call == 0 {
                    self.first_started.notify_one();
                    self.release_first.notified().await;
                }
                Ok(NetworkDnsObservation {
                    dns: DnsObservation {
                        resolver_count: 1,
                        scoped_resolver_count: 0,
                        search_domains: Vec::new(),
                        servers: vec!["192.0.2.53".into()],
                    },
                    interfaces: vec![NetworkInterfaceObservation {
                        interface: "en0".into(),
                        interface_kind: NetworkInterfaceKind::Ethernet,
                        ipv4_available: true,
                        ipv6_available: false,
                        service: Some(if call == 0 { "Old" } else { "Current" }.into()),
                    }],
                    source: NetworkDnsSource::MacosSystemConfiguration,
                })
            })
        }
    }

    impl StartupPlatform for FakeStartupPlatform {
        fn is_enabled(&self) -> Result<bool, StartupPlatformError> {
            if self.fail {
                Err(StartupPlatformError)
            } else {
                Ok(self.enabled.load(Ordering::SeqCst))
            }
        }

        fn set_enabled(&self, enabled: bool) -> Result<(), StartupPlatformError> {
            if self.fail || (self.fail_disable && !enabled) {
                Err(StartupPlatformError)
            } else {
                self.enabled.store(enabled, Ordering::SeqCst);
                Ok(())
            }
        }
    }

    #[derive(Default)]
    struct FakeWindowSurfacePlatform(Mutex<WindowSurfacePreference>);

    impl WindowSurfacePlatform for FakeWindowSurfacePlatform {
        fn set_surface(
            &self,
            surface: WindowSurfacePreference,
        ) -> Result<(), WindowSurfacePlatformError> {
            *self.0.lock().expect("window surface lock") = surface;
            Ok(())
        }
    }

    fn window_surface_platform() -> Arc<dyn WindowSurfacePlatform> {
        Arc::new(FakeWindowSurfacePlatform::default())
    }

    fn repository() -> (tempfile::TempDir, Arc<FileSettingsRepository>) {
        let root = tempdir().expect("temporary settings directory");
        let repository = Arc::new(FileSettingsRepository::new(
            root.path().join("settings.json"),
        ));
        (root, repository)
    }

    #[test]
    fn missing_storage_creates_one_fresh_onboarding_invitation() {
        let (_root, repository) = repository();
        let loaded = repository.load().expect("default settings");
        assert!(loaded.needs_persistence);
        let invitation = loaded
            .preferences
            .onboarding
            .welcome_invitation
            .expect("fresh welcome invitation");
        assert_eq!(invitation.version, ONBOARDING_WELCOME_VERSION);
        assert_eq!(invitation.completed_at, None);
        assert_eq!(invitation.first_opened_at, None);
        assert_eq!(invitation.last_dismissed_at, None);
        assert_eq!(invitation.prompted_at, None);
        assert_eq!(
            loaded.preferences.startup.launch_behavior,
            ApplicationLaunchBehavior::Off
        );
    }

    #[test]
    fn android_capabilities_do_not_advertise_desktop_system_controls() {
        let capabilities = SettingsCapabilities::android();

        assert_eq!(
            capabilities.background_launch,
            SettingsAvailability::Unavailable
        );
        assert_eq!(
            capabilities.launch_at_login,
            SettingsAvailability::Unavailable
        );
        assert_eq!(capabilities.network_dns, SettingsAvailability::Unavailable);
        assert_eq!(
            capabilities.native_sidebar_material,
            SettingsAvailability::Unavailable
        );
        assert_eq!(
            capabilities.policy_group_connection_cleanup,
            SettingsAvailability::Unavailable
        );
        assert_eq!(capabilities.status_bar, SettingsAvailability::Unavailable);
        assert_eq!(capabilities.tun, SettingsAvailability::Unavailable);
        assert_eq!(
            capabilities.window_lifecycle,
            SettingsAvailability::Unavailable
        );
        assert_eq!(capabilities.updates, SettingsAvailability::ComingLater);
    }

    #[test]
    fn android_portable_preferences_survive_service_recreation() {
        let (_root, repository) = repository();
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::android(),
        )
        .expect("Android settings service");

        service
            .set_appearance(AppearancePreference::Dark)
            .expect("persist Android appearance");
        service
            .set_language(LanguagePreference::Zh)
            .expect("persist Android language");
        drop(service);

        let recreated =
            SettingsService::load(repository, None, None, SettingsCapabilities::android())
                .expect("recreated Android settings service");
        let snapshot = recreated.snapshot(SettingsAdapterKind::Native);
        assert_eq!(snapshot.adapter_kind, SettingsAdapterKind::Native);
        assert_eq!(snapshot.preferences.appearance, AppearancePreference::Dark);
        assert_eq!(snapshot.preferences.language, LanguagePreference::Zh);
    }

    #[test]
    fn native_settings_snapshot_does_not_claim_desktop_rpc_confirmations() {
        let (_root, repository) = repository();
        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::android())
                .expect("Android settings service");

        let snapshot = service.snapshot(SettingsAdapterKind::Native);
        assert_eq!(
            snapshot.privacy.authenticated,
            ConfirmationState::Unavailable
        );
        assert_eq!(
            snapshot.privacy.loopback_only,
            ConfirmationState::Unavailable
        );
        assert_eq!(
            snapshot.privacy.origin_validated,
            ConfirmationState::Unavailable
        );
    }

    #[test]
    fn settings_snapshot_uses_packaged_app_and_pinned_core_versions() {
        let (_root, repository) = repository();
        let service = SettingsService::load_with_platforms_and_authority_and_build(
            repository,
            None,
            None,
            SettingsCapabilities::macos(false),
            None,
            None,
            StateMutationAuthority::new(),
            SettingsBuildInfo::packaged("9.9.9"),
        )
        .expect("settings service");

        assert_eq!(
            service.snapshot(SettingsAdapterKind::Rpc).build,
            SettingsBuildInfo {
                app_version: "9.9.9".into(),
                mihomo_version: PINNED_MIHOMO_VERSION.into(),
            }
        );
    }

    #[test]
    fn version_six_migrates_the_proxy_launch_preference_to_safe_off() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":6,"preferences":{"appearance":"system","language":"en","onboarding":{"welcomeInvitation":null},"startup":{"launchAtLogin":true,"loginLaunchBehavior":"background"},"windowCloseBehavior":"hide-to-status-bar","windowSurface":"material"}}"#,
        )
        .expect("version six settings");

        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("migrated settings service");

        let startup = service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .startup;
        assert!(startup.launch_at_login);
        assert_eq!(
            startup.login_launch_behavior,
            LoginLaunchBehavior::Background
        );
        assert_eq!(startup.launch_behavior, ApplicationLaunchBehavior::Off);
        assert!(
            !repository
                .load()
                .expect("rewritten settings")
                .needs_persistence
        );
    }

    #[test]
    fn unsupported_old_settings_recover_to_safe_defaults() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":7,"preferences":{"appearance":"system","language":"en","onboarding":{"welcomeInvitation":null},"startup":{"launchProxyWhenMishLaunches":false,"launchAtLogin":false,"loginLaunchBehavior":"show-window"},"windowCloseBehavior":"hide-to-status-bar","windowSurface":"material"}}"#,
        )
        .expect("version seven settings");

        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("migrated settings service");
        assert_eq!(
            service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .managed_ports,
            ManagedPortPreferences::default()
        );
        assert!(
            !repository
                .load()
                .expect("rewritten settings")
                .needs_persistence
        );
    }

    #[test]
    fn application_launch_behavior_persists_without_touching_login_registration() {
        let (_root, repository) = repository();
        let platform = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
            fail_disable: false,
        });
        let service = SettingsService::load(
            repository.clone(),
            Some(platform.clone()),
            Some(window_surface_platform()),
            SettingsCapabilities::macos(true),
        )
        .expect("settings service");

        let snapshot = service
            .set_application_launch_behavior(ApplicationLaunchBehavior::Proxy)
            .expect("persisted application launch behavior");
        assert_eq!(
            snapshot.preferences.startup.launch_behavior,
            ApplicationLaunchBehavior::Proxy
        );
        assert!(!platform.enabled.load(Ordering::SeqCst));
        assert_eq!(snapshot.startup_registration.observed, Some(false));

        let restarted = SettingsService::load(
            repository,
            Some(platform),
            Some(window_surface_platform()),
            SettingsCapabilities::macos(true),
        )
        .expect("restarted settings service");
        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .startup
                .launch_behavior,
            ApplicationLaunchBehavior::Proxy
        );
    }

    #[test]
    fn capture_selection_persists_without_launching_proxy() {
        let (_root, repository) = repository();
        let platform = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
            fail_disable: false,
        });
        let service = SettingsService::load(
            repository.clone(),
            Some(platform.clone()),
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("settings service");

        service
            .set_capture_selection(CaptureSelection {
                system_proxy: false,
                tun: true,
            })
            .expect("persisted selection");

        assert!(!platform.enabled.load(Ordering::SeqCst));
        assert_eq!(
            service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .startup
                .launch_behavior,
            ApplicationLaunchBehavior::Off
        );
        let reloaded = SettingsService::load(
            repository,
            Some(platform),
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("reloaded settings service");
        assert_eq!(
            reloaded
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .capture_selection,
            CaptureSelectionPreferences {
                system_proxy: false,
                tun: true,
            }
        );
    }

    #[test]
    fn application_launch_behavior_notifies_authoritative_subscribers() {
        let (_root, repository) = repository();
        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("settings service");
        let mut changes = service.subscribe();

        service
            .set_application_launch_behavior(ApplicationLaunchBehavior::Core)
            .expect("application launch behavior update");
        let snapshot = changes.try_recv().expect("settings change notification");
        assert_eq!(
            snapshot.preferences.startup.launch_behavior,
            ApplicationLaunchBehavior::Core
        );
    }

    #[test]
    fn managed_ports_persist_and_reject_an_ambiguous_endpoint() {
        let (_root, repository) = repository();
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("settings service");

        let ports = ManagedPortPreferences {
            controller: 19090,
            proxy: 17890,
        };
        let snapshot = service.set_managed_ports(ports).expect("persisted ports");
        assert_eq!(snapshot.preferences.managed_ports, ports);
        assert!(matches!(
            service.set_managed_ports(ManagedPortPreferences {
                controller: 17890,
                proxy: 17890,
            }),
            Err(SettingsServiceError::Persistence)
        ));

        let restarted =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("restarted settings service");
        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .managed_ports,
            ports
        );
    }

    #[test]
    fn available_managed_ports_are_distinct_and_persisted() {
        let (_root, repository) = repository();
        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("settings service");

        let ports = service
            .find_and_set_managed_ports()
            .expect("available managed ports")
            .preferences
            .managed_ports;
        assert_ne!(ports.proxy, ports.controller);
        assert_ne!(ports.proxy, 0);
        assert_ne!(ports.controller, 0);
    }

    #[test]
    fn one_available_managed_port_preserves_the_other_port() {
        let (_root, repository) = repository();
        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("settings service");
        let before = service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .managed_ports;

        let after = service
            .find_and_set_managed_port(ManagedPortKind::Proxy)
            .expect("available proxy port")
            .preferences
            .managed_ports;

        assert_eq!(after.controller, before.controller);
        assert_ne!(after.proxy, after.controller);
        assert_ne!(after.proxy, 0);
    }

    #[test]
    fn fresh_onboarding_invitation_is_persisted_once_and_reused_after_restart() {
        let (_root, repository) = repository();
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("fresh settings service");
        let invitation = service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .onboarding
            .welcome_invitation
            .expect("persisted welcome invitation");
        drop(service);

        let restarted = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("restarted settings service");

        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .onboarding
                .welcome_invitation,
            Some(invitation)
        );
        assert!(!repository.load().unwrap().needs_persistence);
    }

    #[test]
    fn welcome_dismissal_and_completion_are_distinct_durable_states() {
        let (_root, repository) = repository();
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("fresh settings service");

        let prompted = service
            .set_onboarding_welcome_state(OnboardingWelcomeAction::Prompt)
            .expect("prompt welcome")
            .preferences
            .onboarding
            .welcome_invitation
            .expect("prompted welcome invitation");
        assert!(prompted.prompted_at.is_some());
        assert_eq!(prompted.first_opened_at, None);
        service
            .set_onboarding_welcome_state(OnboardingWelcomeAction::Open)
            .expect("open welcome");
        let dismissed = service
            .set_onboarding_welcome_state(OnboardingWelcomeAction::Dismiss)
            .expect("dismiss welcome")
            .preferences
            .onboarding
            .welcome_invitation
            .expect("retained welcome invitation");
        assert!(dismissed.first_opened_at.is_some());
        assert!(dismissed.last_dismissed_at.is_some());
        assert_eq!(dismissed.completed_at, None);
        drop(service);

        let restarted = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("restarted settings service");
        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .onboarding
                .welcome_invitation,
            Some(dismissed)
        );
        let completed = restarted
            .set_onboarding_welcome_state(OnboardingWelcomeAction::Complete)
            .expect("complete welcome")
            .preferences
            .onboarding
            .welcome_invitation
            .expect("completed welcome record");
        assert!(completed.completed_at.is_some());
        drop(restarted);

        let upgraded =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("upgraded settings service");
        assert_eq!(
            upgraded
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .onboarding
                .welcome_invitation,
            Some(completed)
        );
    }

    #[test]
    fn explicit_welcome_removal_is_durable_after_completion_and_restart() {
        let (_root, repository) = repository();
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("fresh settings service");

        let completed = service
            .set_onboarding_welcome_state(OnboardingWelcomeAction::Complete)
            .expect("complete welcome")
            .preferences
            .onboarding
            .welcome_invitation
            .expect("completed welcome invitation");
        assert!(completed.completed_at.is_some());

        let removed = service
            .set_onboarding_welcome_state(OnboardingWelcomeAction::Remove)
            .expect("remove welcome invitation");
        assert_eq!(removed.preferences.onboarding.welcome_invitation, None);
        drop(service);

        let restarted =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("restarted settings service");
        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .onboarding
                .welcome_invitation,
            None
        );
    }

    #[test]
    fn welcome_prompt_is_durable_without_opening_the_dialog() {
        let (_root, repository) = repository();
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("fresh settings service");
        let prompted = service
            .set_onboarding_welcome_state(OnboardingWelcomeAction::Prompt)
            .expect("prompt welcome")
            .preferences
            .onboarding
            .welcome_invitation
            .expect("prompted welcome invitation");
        assert!(prompted.prompted_at.is_some());
        assert_eq!(prompted.first_opened_at, None);
        assert_eq!(prompted.completed_at, None);
        drop(service);

        let restarted =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("restarted settings service");
        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .onboarding
                .welcome_invitation,
            Some(prompted)
        );
    }

    #[tokio::test]
    async fn invalidated_network_observation_cannot_publish_after_a_new_authority() {
        let (_root, repository) = repository();
        let platform = Arc::new(BlockingNetworkDnsPlatform {
            calls: AtomicUsize::new(0),
            first_started: Notify::new(),
            release_first: Notify::new(),
        });
        let service = Arc::new(
            SettingsService::load_with_platforms(
                repository,
                None,
                None,
                SettingsCapabilities::macos(false),
                None,
                Some(platform.clone()),
            )
            .unwrap(),
        );
        let first_service = service.clone();
        let first = tokio::spawn(async move { first_service.refresh_network_dns().await });
        platform.first_started.notified().await;
        service.invalidate_network_dns();
        let second_service = service.clone();
        let second = tokio::spawn(async move { second_service.refresh_network_dns().await });
        platform.release_first.notify_one();
        first.await.unwrap();
        second.await.unwrap();

        let snapshot = service.snapshot(SettingsAdapterKind::Rpc).network_dns;
        assert_eq!(snapshot.phase, NetworkDnsPhase::Ready);
        assert_eq!(
            snapshot
                .interfaces
                .first()
                .and_then(|interface| interface.service.clone()),
            Some("Current".into())
        );
        assert_eq!(platform.calls.load(Ordering::Acquire), 2);
    }

    #[test]
    fn preferences_round_trip_through_private_atomic_storage() {
        let (_root, repository) = repository();
        let preferences = SettingsPreferences {
            appearance: AppearancePreference::Dark,
            capture_selection: CaptureSelectionPreferences::default(),
            close_old_connections_after_group_switch: true,
            language: LanguagePreference::Zh,
            managed_ports: ManagedPortPreferences::default(),
            onboarding: OnboardingPreferences::default(),
            process_discovery_mode: ProcessDiscoveryMode::Strict,
            startup: StartupPreferences {
                launch_behavior: ApplicationLaunchBehavior::Off,
                launch_at_login: true,
                login_launch_behavior: LoginLaunchBehavior::Background,
            },
            system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
            window_close_behavior: WindowCloseBehavior::Quit,
            window_surface: WindowSurfacePreference::Opaque,
        };
        repository.save(&preferences).expect("save settings");
        assert_eq!(
            repository.load().expect("load settings").preferences,
            preferences
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&repository.path)
                .expect("settings metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn takeover_policy_defaults_conservatively_migrates_and_persists() {
        let (_root, repository) = repository();
        repository
            .save(&SettingsPreferences::default())
            .expect("save default settings");
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("settings service");
        assert_eq!(
            service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .system_proxy_takeover_policy,
            SystemProxyTakeoverPolicy::ProtectExisting
        );
        service
            .set_system_proxy_takeover_policy(
                SystemProxyTakeoverPolicy::ReplaceReversiblePacOrAutoDiscovery,
            )
            .expect("persist takeover policy");
        let restarted =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("restarted settings service");
        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .system_proxy_takeover_policy,
            SystemProxyTakeoverPolicy::ReplaceReversiblePacOrAutoDiscovery
        );
    }

    #[test]
    fn old_child_connection_cleanup_defaults_off_migrates_and_persists() {
        let (_root, repository) = repository();
        repository
            .save(&SettingsPreferences::default())
            .expect("save default settings");
        let mut stored: serde_json::Value =
            serde_json::from_slice(&fs::read(&repository.path).expect("read settings"))
                .expect("parse settings");
        stored["schemaVersion"] = serde_json::json!(11);
        stored["preferences"]
            .as_object_mut()
            .expect("preferences object")
            .remove("closeOldConnectionsAfterGroupSwitch");
        fs::write(
            &repository.path,
            serde_json::to_vec(&stored).expect("serialize legacy settings"),
        )
        .expect("write legacy settings");

        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("settings service");
        assert!(
            !service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .close_old_connections_after_group_switch
        );
        service
            .set_close_old_connections_after_group_switch(true)
            .expect("persist cleanup preference");
        let restarted =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("restarted settings service");
        assert!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .close_old_connections_after_group_switch
        );
    }

    #[test]
    fn process_discovery_defaults_to_always_and_persists_an_explicit_mode() {
        let (_root, repository) = repository();
        repository
            .save(&SettingsPreferences::default())
            .expect("save default settings");
        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("settings service");
        assert_eq!(
            service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .process_discovery_mode,
            ProcessDiscoveryMode::Always
        );

        service
            .set_process_discovery_mode(ProcessDiscoveryMode::Strict)
            .expect("persist process discovery mode");
        let restarted =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("restarted settings service");
        assert_eq!(
            restarted
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .process_discovery_mode,
            ProcessDiscoveryMode::Strict
        );
    }

    #[test]
    fn legacy_preferences_migrate_and_are_rewritten() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":0,"theme":"dark","locale":"zh-CN"}"#,
        )
        .expect("legacy settings");
        let platform = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
            fail_disable: false,
        });
        let service = SettingsService::load(
            repository.clone(),
            Some(platform),
            Some(window_surface_platform()),
            SettingsCapabilities::macos(true),
        )
        .expect("migrated settings service");
        assert_eq!(
            service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .appearance,
            AppearancePreference::Dark
        );
        assert!(
            !repository
                .load()
                .expect("rewritten settings")
                .needs_persistence
        );
    }

    #[test]
    fn version_one_preferences_migrate_to_the_safe_hide_default() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":1,"preferences":{"appearance":"light","language":"en","startup":{"launchAtLogin":false,"loginLaunchBehavior":"show-window"}}}"#,
        )
        .expect("version one settings");
        let service = SettingsService::load(
            repository.clone(),
            None,
            Some(window_surface_platform()),
            SettingsCapabilities {
                launch_at_login: SettingsAvailability::Unavailable,
                ..SettingsCapabilities::macos(true)
            },
        )
        .expect("migrated settings service");

        assert_eq!(
            service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .window_close_behavior,
            WindowCloseBehavior::HideToStatusBar
        );
        assert!(
            !repository
                .load()
                .expect("rewritten settings")
                .needs_persistence
        );
    }

    #[test]
    fn existing_version_three_installations_receive_one_unprompted_invitation() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":3,"preferences":{"appearance":"dark","language":"zh-CN","startup":{"launchAtLogin":false,"loginLaunchBehavior":"show-window"},"windowCloseBehavior":"quit","windowSurface":"opaque"}}"#,
        )
        .expect("version three settings");

        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("migrated settings service");

        let invitation = service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .onboarding
            .welcome_invitation
            .expect("migrated welcome invitation");
        assert_eq!(invitation.version, ONBOARDING_WELCOME_VERSION);
        assert_eq!(invitation.prompted_at, None);
        assert_eq!(invitation.completed_at, None);
        assert!(!repository.load().unwrap().needs_persistence);
    }

    #[test]
    fn version_four_installations_without_an_invitation_receive_one_prompt() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":4,"preferences":{"appearance":"dark","language":"zh-CN","onboarding":{"welcomeInvitation":null},"startup":{"launchAtLogin":false,"loginLaunchBehavior":"show-window"},"windowCloseBehavior":"quit","windowSurface":"opaque"}}"#,
        )
        .expect("version four settings");

        let service = SettingsService::load(
            repository.clone(),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("migrated settings service");

        let invitation = service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .onboarding
            .welcome_invitation
            .expect("migrated welcome invitation");
        assert_eq!(invitation.prompted_at, None);
        assert_eq!(invitation.completed_at, None);
        assert!(!repository.load().unwrap().needs_persistence);
    }

    #[test]
    fn version_four_completion_receives_the_new_welcome_tour() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":4,"preferences":{"appearance":"dark","language":"zh-CN","onboarding":{"welcomeInvitation":{"completedAt":12,"createdAt":10,"firstOpenedAt":11,"lastDismissedAt":null,"version":1}},"startup":{"launchAtLogin":false,"loginLaunchBehavior":"show-window"},"windowCloseBehavior":"quit","windowSurface":"opaque"}}"#,
        )
        .expect("version four completed settings");

        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("migrated settings service");
        let invitation = service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .onboarding
            .welcome_invitation
            .expect("new welcome invitation");

        assert_eq!(invitation.version, ONBOARDING_WELCOME_VERSION);
        assert_eq!(invitation.prompted_at, None);
        assert_eq!(invitation.first_opened_at, None);
        assert_eq!(invitation.completed_at, None);
    }

    #[test]
    fn version_five_completion_receives_the_new_welcome_tour() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":5,"preferences":{"appearance":"dark","language":"zh-CN","onboarding":{"welcomeInvitation":{"completedAt":12,"createdAt":10,"firstOpenedAt":11,"lastDismissedAt":null,"promptedAt":10,"version":1}},"startup":{"launchAtLogin":false,"loginLaunchBehavior":"show-window"},"windowCloseBehavior":"quit","windowSurface":"opaque"}}"#,
        )
        .expect("version five completed settings");

        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("migrated settings service");
        let invitation = service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .onboarding
            .welcome_invitation
            .expect("new welcome invitation");

        assert_eq!(invitation.version, ONBOARDING_WELCOME_VERSION);
        assert_eq!(invitation.prompted_at, None);
        assert_eq!(invitation.completed_at, None);
    }

    #[test]
    fn version_two_preferences_migrate_to_material_without_losing_existing_values() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":2,"preferences":{"appearance":"dark","language":"zh-CN","startup":{"launchAtLogin":false,"loginLaunchBehavior":"show-window"},"windowCloseBehavior":"quit"}}"#,
        )
        .expect("version two settings");
        let service = SettingsService::load(
            repository.clone(),
            None,
            Some(window_surface_platform()),
            SettingsCapabilities {
                launch_at_login: SettingsAvailability::Unavailable,
                ..SettingsCapabilities::macos(true)
            },
        )
        .expect("migrated settings service");
        let preferences = service.snapshot(SettingsAdapterKind::Rpc).preferences;

        assert_eq!(preferences.appearance, AppearancePreference::Dark);
        assert_eq!(preferences.language, LanguagePreference::Zh);
        assert_eq!(preferences.window_close_behavior, WindowCloseBehavior::Quit);
        assert_eq!(
            preferences.window_surface,
            WindowSurfacePreference::Material
        );
        assert!(
            !repository
                .load()
                .expect("rewritten settings")
                .needs_persistence
        );
    }

    #[test]
    fn window_surface_preference_applies_through_the_platform_seam() {
        let (_root, repository) = repository();
        let platform = Arc::new(FakeWindowSurfacePlatform::default());
        let service = SettingsService::load(
            repository,
            None,
            Some(platform.clone()),
            SettingsCapabilities {
                launch_at_login: SettingsAvailability::Unavailable,
                ..SettingsCapabilities::macos(true)
            },
        )
        .expect("settings service");

        let snapshot = service
            .set_window_surface(WindowSurfacePreference::Opaque)
            .expect("window surface update");

        assert_eq!(
            snapshot.preferences.window_surface,
            WindowSurfacePreference::Opaque
        );
        assert_eq!(
            *platform.0.lock().expect("window surface lock"),
            WindowSurfacePreference::Opaque
        );
    }

    #[test]
    fn language_publication_follows_successful_persistence_and_revisions_are_monotonic() {
        let (_root, repository) = repository();
        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("settings service");
        let mut updates = service.subscribe();
        let initial = service.snapshot(SettingsAdapterKind::Rpc);
        let updated = service
            .set_language(LanguagePreference::Zh)
            .expect("persisted language");

        assert_eq!(updated.preferences.language, LanguagePreference::Zh);
        assert!(updated.revision > initial.revision);
        assert_eq!(
            updates.try_recv().expect("published update").revision,
            updated.revision
        );

        let failed = SettingsService::load(
            Arc::new(FailingSaveRepository),
            None,
            None,
            SettingsCapabilities::macos(false),
        )
        .expect("in-memory load");
        let mut failed_updates = failed.subscribe();
        assert!(matches!(
            failed.set_language(LanguagePreference::Zh),
            Err(SettingsServiceError::Persistence)
        ));
        assert!(matches!(
            failed_updates.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert_eq!(
            failed
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .language,
            LanguagePreference::En
        );
    }

    #[test]
    fn subscription_initial_read_cannot_miss_a_later_language_update() {
        let (_root, repository) = repository();
        let service =
            SettingsService::load(repository, None, None, SettingsCapabilities::macos(false))
                .expect("settings service");
        let (mut updates, initial) = service.subscribe_with_snapshot(SettingsAdapterKind::Rpc);
        let updated = service
            .set_language(LanguagePreference::Zh)
            .expect("persisted language");
        let delivered = updates
            .try_recv()
            .expect("queued update after initial read");

        assert!(delivered.revision > initial.revision);
        assert_eq!(delivered.revision, updated.revision);
        assert_eq!(delivered.preferences.language, LanguagePreference::Zh);
    }

    #[test]
    fn restored_preferences_do_not_call_platform_adapters() {
        let (_root, repository) = repository();
        let startup = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
            fail_disable: false,
        });
        let surface = Arc::new(FakeWindowSurfacePlatform::default());
        let service = SettingsService::load(
            repository,
            Some(startup.clone()),
            Some(surface.clone()),
            SettingsCapabilities::macos(true),
        )
        .expect("settings service");
        let restored = SettingsPreferences {
            appearance: AppearancePreference::Dark,
            capture_selection: CaptureSelectionPreferences::default(),
            close_old_connections_after_group_switch: true,
            language: LanguagePreference::Zh,
            managed_ports: ManagedPortPreferences::default(),
            onboarding: OnboardingPreferences::default(),
            process_discovery_mode: ProcessDiscoveryMode::Strict,
            startup: StartupPreferences {
                launch_behavior: ApplicationLaunchBehavior::Off,
                launch_at_login: true,
                login_launch_behavior: LoginLaunchBehavior::Background,
            },
            system_proxy_takeover_policy: SystemProxyTakeoverPolicy::default(),
            window_close_behavior: WindowCloseBehavior::Quit,
            window_surface: WindowSurfacePreference::Opaque,
        };

        service.accept_restored_preferences(restored).unwrap();

        assert_eq!(
            service.snapshot(SettingsAdapterKind::Rpc).preferences,
            restored
        );
        assert!(!startup.enabled.load(Ordering::SeqCst));
        assert_eq!(
            *surface.0.lock().expect("window surface lock"),
            WindowSurfacePreference::Material
        );
    }

    #[test]
    fn window_surface_rolls_back_when_persistence_fails() {
        let platform = Arc::new(FakeWindowSurfacePlatform::default());
        let service = SettingsService::load(
            Arc::new(FailingSaveRepository),
            None,
            Some(platform.clone()),
            SettingsCapabilities {
                launch_at_login: SettingsAvailability::Unavailable,
                ..SettingsCapabilities::macos(true)
            },
        )
        .expect("settings service");

        assert!(matches!(
            service.set_window_surface(WindowSurfacePreference::Opaque),
            Err(SettingsServiceError::Persistence)
        ));
        assert_eq!(
            *platform.0.lock().expect("window surface lock"),
            WindowSurfacePreference::Material
        );
        assert_eq!(
            service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .window_surface,
            WindowSurfacePreference::Material
        );
    }

    #[test]
    fn close_behavior_is_independent_from_login_launch_behavior() {
        let (_root, repository) = repository();
        let service = SettingsService::load(
            repository,
            None,
            Some(window_surface_platform()),
            SettingsCapabilities {
                launch_at_login: SettingsAvailability::Unavailable,
                ..SettingsCapabilities::macos(true)
            },
        )
        .expect("settings service");

        let snapshot = service
            .set_window_close_behavior(WindowCloseBehavior::Quit)
            .expect("confirmed window lifecycle update");

        assert_eq!(
            snapshot.preferences.window_close_behavior,
            WindowCloseBehavior::Quit
        );
        assert_eq!(snapshot.preferences.startup, StartupPreferences::default());
    }

    #[test]
    fn corrupt_or_unbounded_storage_recovers_to_defaults() {
        for bytes in [vec![b'{'], vec![b'x'; SETTINGS_MAX_BYTES as usize + 1]] {
            let (_root, repository) = repository();
            fs::write(&repository.path, bytes).expect("corrupt settings");
            let service = SettingsService::load(
                repository.clone(),
                None,
                None,
                SettingsCapabilities {
                    launch_at_login: SettingsAvailability::Unavailable,
                    ..SettingsCapabilities::macos(false)
                },
            )
            .expect("recovered settings");
            let snapshot = service.snapshot(SettingsAdapterKind::Rpc);
            assert_eq!(snapshot.preferences, SettingsPreferences::default());
            assert!(snapshot.storage_recovered);
            assert_eq!(
                repository.load().expect("recovered file").preferences,
                snapshot.preferences
            );
        }
    }

    #[test]
    fn startup_preferences_are_exclusive_and_confirm_platform_state() {
        let (_root, repository) = repository();
        let platform = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
            fail_disable: false,
        });
        let service = SettingsService::load(
            repository,
            Some(platform.clone()),
            Some(window_surface_platform()),
            SettingsCapabilities::macos(true),
        )
        .expect("settings service");
        let snapshot = service
            .set_startup(StartupPreferences {
                launch_behavior: ApplicationLaunchBehavior::Off,
                launch_at_login: true,
                login_launch_behavior: LoginLaunchBehavior::Background,
            })
            .expect("confirmed startup update");
        assert!(platform.enabled.load(Ordering::SeqCst));
        assert_eq!(
            snapshot.startup_registration.phase,
            StartupRegistrationPhase::Applied
        );
        assert_eq!(
            snapshot.preferences.startup.login_launch_behavior,
            LoginLaunchBehavior::Background
        );
    }

    #[test]
    fn failed_or_unsupported_startup_changes_do_not_persist_success() {
        for (platform, capabilities) in [
            (
                Some(Arc::new(FakeStartupPlatform {
                    enabled: AtomicBool::new(false),
                    fail: true,
                    fail_disable: false,
                }) as Arc<dyn StartupPlatform>),
                SettingsCapabilities::macos(true),
            ),
            (
                None,
                SettingsCapabilities {
                    launch_at_login: SettingsAvailability::Unavailable,
                    ..SettingsCapabilities::macos(false)
                },
            ),
        ] {
            let (_root, repository) = repository();
            let window_surface = (capabilities.native_sidebar_material
                == SettingsAvailability::Supported)
                .then(window_surface_platform);
            let service = SettingsService::load(repository, platform, window_surface, capabilities)
                .expect("settings service");
            assert!(
                service
                    .set_startup(StartupPreferences {
                        launch_behavior: ApplicationLaunchBehavior::Off,
                        launch_at_login: true,
                        login_launch_behavior: LoginLaunchBehavior::Background,
                    })
                    .is_err()
            );
            assert_eq!(
                service
                    .snapshot(SettingsAdapterKind::Rpc)
                    .preferences
                    .startup,
                StartupPreferences::default()
            );
        }
    }

    #[test]
    fn startup_registration_rolls_back_when_persistence_fails() {
        let platform = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
            fail_disable: false,
        });
        let service = SettingsService::load(
            Arc::new(FailingSaveRepository),
            Some(platform.clone()),
            Some(window_surface_platform()),
            SettingsCapabilities::macos(true),
        )
        .expect("settings service");

        assert!(matches!(
            service.set_startup(StartupPreferences {
                launch_behavior: ApplicationLaunchBehavior::Off,
                launch_at_login: true,
                login_launch_behavior: LoginLaunchBehavior::Background,
            }),
            Err(SettingsServiceError::Persistence)
        ));

        assert!(!platform.enabled.load(Ordering::SeqCst));
        let snapshot = service.snapshot(SettingsAdapterKind::Rpc);
        assert_eq!(snapshot.preferences.startup, StartupPreferences::default());
        assert_eq!(
            snapshot.startup_registration.phase,
            StartupRegistrationPhase::Applied
        );
    }

    #[test]
    fn startup_registration_reports_drift_when_persistence_and_rollback_fail() {
        let platform = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
            fail_disable: true,
        });
        let service = SettingsService::load(
            Arc::new(FailingSaveRepository),
            Some(platform),
            Some(window_surface_platform()),
            SettingsCapabilities::macos(true),
        )
        .expect("settings service");

        assert!(matches!(
            service.set_startup(StartupPreferences {
                launch_behavior: ApplicationLaunchBehavior::Off,
                launch_at_login: true,
                login_launch_behavior: LoginLaunchBehavior::Background,
            }),
            Err(SettingsServiceError::Startup)
        ));

        let snapshot = service.snapshot(SettingsAdapterKind::Rpc);
        assert_eq!(snapshot.preferences.startup, StartupPreferences::default());
        assert_eq!(snapshot.startup_registration.observed, Some(true));
        assert_eq!(
            snapshot.startup_registration.phase,
            StartupRegistrationPhase::Drift
        );
    }
}
