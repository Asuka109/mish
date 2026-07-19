//! Transport-neutral application settings and bounded private persistence.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use thiserror::Error;

const CURRENT_SCHEMA_VERSION: u8 = 1;
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupPreferences {
    pub launch_at_login: bool,
    pub login_launch_behavior: LoginLaunchBehavior,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPreferences {
    pub appearance: AppearancePreference,
    pub language: LanguagePreference,
    pub startup: StartupPreferences,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsAdapterKind {
    Fixture,
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
    pub tun: SettingsAvailability,
    pub updates: SettingsAvailability,
}

impl SettingsCapabilities {
    pub fn macos(native_sidebar_material: bool) -> Self {
        Self {
            background_launch: SettingsAvailability::Supported,
            backup_restore: SettingsAvailability::ComingLater,
            expert_configuration: SettingsAvailability::ComingLater,
            launch_at_login: SettingsAvailability::Supported,
            network_dns: SettingsAvailability::ComingLater,
            native_sidebar_material: if native_sidebar_material {
                SettingsAvailability::Supported
            } else {
                SettingsAvailability::Unavailable
            },
            tun: SettingsAvailability::Unavailable,
            updates: SettingsAvailability::ComingLater,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub adapter_kind: SettingsAdapterKind,
    pub capabilities: SettingsCapabilities,
    pub preferences: SettingsPreferences,
    pub privacy: PrivacyAccessSnapshot,
    pub startup_registration: StartupRegistrationSnapshot,
    pub storage_recovered: bool,
}

pub trait StartupPlatform: Send + Sync {
    fn is_enabled(&self) -> Result<bool, StartupPlatformError>;
    fn set_enabled(&self, enabled: bool) -> Result<(), StartupPlatformError>;
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("the startup integration could not confirm the requested state")]
pub struct StartupPlatformError;

pub trait SettingsRepository: Send + Sync {
    fn load(&self) -> Result<LoadedSettings, SettingsRepositoryError>;
    fn save(&self, preferences: &SettingsPreferences) -> Result<(), SettingsRepositoryError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LoadedSettings {
    pub migrated: bool,
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
}

pub struct SettingsService {
    capabilities: SettingsCapabilities,
    operation: Mutex<()>,
    platform: Option<Arc<dyn StartupPlatform>>,
    repository: Arc<dyn SettingsRepository>,
    state: Mutex<SettingsState>,
}

#[derive(Clone, Copy)]
struct SettingsState {
    preferences: SettingsPreferences,
    storage_recovered: bool,
}

impl SettingsService {
    pub fn load(
        repository: Arc<dyn SettingsRepository>,
        platform: Option<Arc<dyn StartupPlatform>>,
        capabilities: SettingsCapabilities,
    ) -> Result<Self, SettingsServiceError> {
        let (loaded, storage_recovered) = match repository.load() {
            Ok(loaded) => (loaded, false),
            Err(SettingsRepositoryError::Corrupt) => {
                let preferences = SettingsPreferences::default();
                repository
                    .save(&preferences)
                    .map_err(|_| SettingsServiceError::Persistence)?;
                (
                    LoadedSettings {
                        migrated: false,
                        preferences,
                    },
                    true,
                )
            }
            Err(SettingsRepositoryError::Unavailable) => {
                return Err(SettingsServiceError::Persistence);
            }
        };
        if loaded.migrated {
            repository
                .save(&loaded.preferences)
                .map_err(|_| SettingsServiceError::Persistence)?;
        }
        Ok(Self {
            capabilities,
            operation: Mutex::new(()),
            platform,
            repository,
            state: Mutex::new(SettingsState {
                preferences: loaded.preferences,
                storage_recovered,
            }),
        })
    }

    pub fn snapshot(&self, adapter_kind: SettingsAdapterKind) -> SettingsSnapshot {
        let state = *self.state.lock().expect("settings state lock poisoned");
        let observed = self
            .platform
            .as_ref()
            .and_then(|platform| platform.is_enabled().ok());
        let startup_registration = startup_registration(
            state.preferences.startup.launch_at_login,
            observed,
            self.capabilities.launch_at_login,
        );
        SettingsSnapshot {
            adapter_kind,
            capabilities: self.capabilities,
            preferences: state.preferences,
            privacy: PrivacyAccessSnapshot {
                authenticated: ConfirmationState::Confirmed,
                lan_control: SettingsAvailability::Unavailable,
                loopback_only: ConfirmationState::Confirmed,
                origin_validated: ConfirmationState::Confirmed,
            },
            startup_registration,
            storage_recovered: state.storage_recovered,
        }
    }

    pub fn set_appearance(
        &self,
        appearance: AppearancePreference,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
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
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        self.update(|preferences| preferences.language = language)
    }

    pub fn set_startup(
        &self,
        startup: StartupPreferences,
    ) -> Result<SettingsSnapshot, SettingsServiceError> {
        let _operation = self
            .operation
            .lock()
            .expect("settings operation lock poisoned");
        if self.capabilities.launch_at_login != SettingsAvailability::Supported {
            return Err(SettingsServiceError::CapabilityUnavailable);
        }
        let platform = self
            .platform
            .as_ref()
            .ok_or(SettingsServiceError::CapabilityUnavailable)?;
        let observed = platform
            .is_enabled()
            .map_err(|_| SettingsServiceError::Startup)?;
        if observed != startup.launch_at_login {
            platform
                .set_enabled(startup.launch_at_login)
                .map_err(|_| SettingsServiceError::Startup)?;
            if platform.is_enabled().ok() != Some(startup.launch_at_login) {
                return Err(SettingsServiceError::Startup);
            }
        }
        self.update(|preferences| preferences.startup = startup)
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
        drop(state);
        Ok(self.snapshot(SettingsAdapterKind::Rpc))
    }
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
struct StoredSettingsV1 {
    preferences: SettingsPreferences,
    schema_version: u8,
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
                    migrated: false,
                    preferences: SettingsPreferences::default(),
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
                let stored: StoredSettingsV1 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                Ok(LoadedSettings {
                    migrated: false,
                    preferences: stored.preferences,
                })
            }
            Some(0) => {
                let stored: StoredSettingsV0 =
                    serde_json::from_value(value).map_err(|_| SettingsRepositoryError::Corrupt)?;
                if stored.schema_version != 0 {
                    return Err(SettingsRepositoryError::Corrupt);
                }
                Ok(LoadedSettings {
                    migrated: true,
                    preferences: SettingsPreferences {
                        appearance: stored.theme,
                        language: stored.locale,
                        startup: StartupPreferences::default(),
                    },
                })
            }
            _ => Err(SettingsRepositoryError::Corrupt),
        }
    }

    fn save(&self, preferences: &SettingsPreferences) -> Result<(), SettingsRepositoryError> {
        let bytes = serde_json::to_vec(&StoredSettingsV1 {
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::tempdir;

    struct FakeStartupPlatform {
        enabled: AtomicBool,
        fail: bool,
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
            if self.fail {
                Err(StartupPlatformError)
            } else {
                self.enabled.store(enabled, Ordering::SeqCst);
                Ok(())
            }
        }
    }

    fn repository() -> (tempfile::TempDir, Arc<FileSettingsRepository>) {
        let root = tempdir().expect("temporary settings directory");
        let repository = Arc::new(FileSettingsRepository::new(
            root.path().join("settings.json"),
        ));
        (root, repository)
    }

    #[test]
    fn missing_storage_uses_safe_defaults() {
        let (_root, repository) = repository();
        let loaded = repository.load().expect("default settings");
        assert_eq!(loaded.preferences, SettingsPreferences::default());
        assert!(!loaded.migrated);
    }

    #[test]
    fn preferences_round_trip_through_private_atomic_storage() {
        let (_root, repository) = repository();
        let preferences = SettingsPreferences {
            appearance: AppearancePreference::Dark,
            language: LanguagePreference::Zh,
            startup: StartupPreferences {
                launch_at_login: true,
                login_launch_behavior: LoginLaunchBehavior::Background,
            },
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
    fn legacy_preferences_migrate_and_are_rewritten() {
        let (_root, repository) = repository();
        fs::write(
            &repository.path,
            br#"{"schemaVersion":0,"theme":"dark","locale":"zh"}"#,
        )
        .expect("legacy settings");
        let platform = Arc::new(FakeStartupPlatform {
            enabled: AtomicBool::new(false),
            fail: false,
        });
        let service = SettingsService::load(
            repository.clone(),
            Some(platform),
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
        assert!(!repository.load().expect("rewritten settings").migrated);
    }

    #[test]
    fn corrupt_or_unbounded_storage_recovers_to_defaults() {
        for bytes in [vec![b'{'], vec![b'x'; SETTINGS_MAX_BYTES as usize + 1]] {
            let (_root, repository) = repository();
            fs::write(&repository.path, bytes).expect("corrupt settings");
            let service = SettingsService::load(
                repository.clone(),
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
        });
        let service = SettingsService::load(
            repository,
            Some(platform.clone()),
            SettingsCapabilities::macos(true),
        )
        .expect("settings service");
        let snapshot = service
            .set_startup(StartupPreferences {
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
            let service = SettingsService::load(repository, platform, capabilities)
                .expect("settings service");
            assert!(
                service
                    .set_startup(StartupPreferences {
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
}
