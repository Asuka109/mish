use std::sync::Arc;

use mish_settings::{
    AppearancePreference, LanguagePreference, SettingsAdapterKind, SettingsService,
    SettingsServiceError, SettingsSnapshot,
};
#[cfg(target_os = "android")]
use mish_settings::{FileSettingsRepository, OnboardingWelcomeAction, SettingsCapabilities};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::State;

const CONTRACT_VERSION: u8 = 1;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileFixtureBootstrap {
    adapter_kind: &'static str,
    contract_version: u8,
    core: FixtureCapability,
    message: &'static str,
    platform: &'static str,
    target_abis: [&'static str; 2],
    vpn: FixtureCapability,
}

#[derive(Clone, Serialize)]
struct FixtureCapability {
    availability: &'static str,
    kind: &'static str,
}

struct MobileSettings {
    service: Arc<SettingsService>,
}

impl MobileSettings {
    fn snapshot(&self) -> SettingsSnapshot {
        self.service.snapshot(SettingsAdapterKind::Native)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MobileSettingsAppearanceRequest {
    appearance: AppearancePreference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MobileSettingsLanguageRequest {
    language: LanguagePreference,
}

#[tauri::command]
fn mobile_fixture_bootstrap() -> MobileFixtureBootstrap {
    let android = cfg!(target_os = "android");
    MobileFixtureBootstrap {
        adapter_kind: "native",
        contract_version: CONTRACT_VERSION,
        core: FixtureCapability {
            availability: if android { "available" } else { "unavailable" },
            kind: if android { "native" } else { "fixture" },
        },
        message: if android {
            "Android VPN and embedded Mobile Core boundaries are available through typed commands."
        } else {
            "The Android VPN and embedded Mobile Core boundaries are unavailable on this platform."
        },
        platform: if cfg!(target_os = "android") {
            "android"
        } else if cfg!(target_os = "ios") {
            "ios"
        } else {
            "android"
        },
        target_abis: ["arm64-v8a", "x86_64"],
        vpn: FixtureCapability {
            availability: if android { "available" } else { "unavailable" },
            kind: if android { "native" } else { "fixture" },
        },
    }
}

#[tauri::command]
fn mobile_settings_get_snapshot(settings: State<'_, MobileSettings>) -> SettingsSnapshot {
    settings.snapshot()
}

#[tauri::command]
fn mobile_settings_set_appearance(
    settings: State<'_, MobileSettings>,
    request: MobileSettingsAppearanceRequest,
) -> Result<SettingsSnapshot, String> {
    settings
        .service
        .set_appearance(request.appearance)
        .map_err(mobile_settings_error)?;
    Ok(settings.snapshot())
}

#[tauri::command]
fn mobile_settings_set_language(
    settings: State<'_, MobileSettings>,
    request: MobileSettingsLanguageRequest,
) -> Result<SettingsSnapshot, String> {
    settings
        .service
        .set_language(request.language)
        .map_err(mobile_settings_error)?;
    Ok(settings.snapshot())
}

#[cfg(target_os = "android")]
fn initialize_mobile_settings<R: tauri::Runtime>(
    app: &tauri::App<R>,
) -> Result<MobileSettings, Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?;
    let service = SettingsService::load(
        Arc::new(FileSettingsRepository::new(root.join("settings.json"))),
        None,
        None,
        SettingsCapabilities::android(),
    )?;
    if service
        .snapshot(SettingsAdapterKind::Native)
        .preferences
        .onboarding
        .welcome_invitation
        .is_some()
    {
        service.set_onboarding_welcome_state(OnboardingWelcomeAction::Remove)?;
    }
    Ok(MobileSettings {
        service: Arc::new(service),
    })
}

fn mobile_settings_error(error: SettingsServiceError) -> String {
    match error {
        SettingsServiceError::Busy => "busy".into(),
        SettingsServiceError::CapabilityUnavailable => "capability-unavailable".into(),
        SettingsServiceError::Persistence => "persistence".into(),
        SettingsServiceError::Startup
        | SettingsServiceError::TunHelper(_)
        | SettingsServiceError::WindowSurface => "settings-operation-failed".into(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_mish_vpn::init())
        .setup(|_app| {
            #[cfg(target_os = "android")]
            _app.manage(initialize_mobile_settings(_app)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_fixture_bootstrap,
            mobile_settings_get_snapshot,
            mobile_settings_set_appearance,
            mobile_settings_set_language,
        ])
        .run(tauri::generate_context!())
        .expect("Mish mobile shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_is_explicitly_unavailable() {
        let fixture = mobile_fixture_bootstrap();
        assert_eq!(fixture.adapter_kind, "native");
        assert_eq!(fixture.contract_version, CONTRACT_VERSION);
        assert_eq!(fixture.core.availability, "unavailable");
        assert_eq!(fixture.vpn.availability, "unavailable");
    }
}
