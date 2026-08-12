const COMMANDS: &[&str] = &[
    "get_snapshot",
    "get_core_provenance",
    "get_traffic_snapshot",
    "close_traffic_connection",
    "register_listener",
    "registerListener",
    "remove_listener",
    "removeListener",
    "request_notification_permission",
    "request_vpn_consent",
    "start",
    "stop",
    "cancel_lifecycle_operation",
    "validate_config",
    "load_config",
    "cancel_config_load",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build()
        .expect("failed to build the Mish VPN mobile plugin");
}
