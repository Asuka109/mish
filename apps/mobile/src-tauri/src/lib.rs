use serde::Serialize;

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

#[tauri::command]
fn mobile_fixture_bootstrap() -> MobileFixtureBootstrap {
    MobileFixtureBootstrap {
        adapter_kind: "native",
        contract_version: CONTRACT_VERSION,
        core: FixtureCapability {
            availability: "unavailable",
            kind: "fixture",
        },
        message: "Native fixture connected. Bounded Core loading is separate from unavailable VPN/TUN.",
        platform: if cfg!(target_os = "android") {
            "android"
        } else if cfg!(target_os = "ios") {
            "ios"
        } else {
            "android"
        },
        target_abis: ["arm64-v8a", "x86_64"],
        vpn: FixtureCapability {
            availability: "unavailable",
            kind: "fixture",
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_mish_vpn::init())
        .invoke_handler(tauri::generate_handler![mobile_fixture_bootstrap])
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
