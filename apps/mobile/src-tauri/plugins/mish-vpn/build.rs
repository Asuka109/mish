const COMMANDS: &[&str] = &[
    "get_snapshot",
    "register_listener",
    "registerListener",
    "remove_listener",
    "removeListener",
    "request_notification_permission",
    "request_vpn_consent",
    "start_fixture_lifecycle",
    "stop",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build()
        .expect("failed to build the Mish VPN mobile plugin");
}
