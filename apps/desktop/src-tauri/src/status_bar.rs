use std::sync::Arc;

use mish_bridge::{
    BrowserClientHandle, DesktopRuntimeHost, ProfileActivationAvailability,
    ProfileActivationCoordinator, ProfileActivationPhase, ProfileActivationSnapshot,
};
use mish_platform_macos::{open_browser_url, show_browser_open_error};
use mish_runtime::{
    CapabilityAvailability, CaptureRecoveryAction, CaptureRequest, CaptureSelection, RoutingMode,
    RuntimePhase, StatusAdapterKind, StatusCommand, StatusSnapshot, SystemProxyPhase, TunPhase,
};
use tauri::{
    Emitter, Manager,
    menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
};
use uuid::Uuid;

const TRAY_ID: &str = "mish-status-bar";
const OPEN_MISH_ID: &str = "status-bar.open-mish";
const OPEN_BROWSER_ID: &str = "status-bar.open-browser";
const OPEN_ROUTES_ID: &str = "status-bar.open-routes";
const TOGGLE_SYSTEM_PROXY_ID: &str = "status-bar.toggle-system-proxy";
const TOGGLE_TUN_ID: &str = "status-bar.toggle-tun";
const REPAIR_SYSTEM_PROXY_ID: &str = "status-bar.repair-system-proxy";
const LEAVE_SYSTEM_PROXY_ID: &str = "status-bar.leave-system-proxy";
const ROUTING_RULE_ID: &str = "status-bar.routing-rule";
const ROUTING_GLOBAL_ID: &str = "status-bar.routing-global";
const ROUTING_DIRECT_ID: &str = "status-bar.routing-direct";
const RESTART_CORE_ID: &str = "status-bar.restart-core";
const QUIT_ID: &str = "status-bar.quit";

#[derive(Clone)]
pub(crate) struct StatusBarState {
    activation: Arc<ProfileActivationCoordinator>,
    browser_client: BrowserClientHandle,
    runtime: DesktopRuntimeHost,
}

impl StatusBarState {
    pub(crate) fn new(
        runtime: DesktopRuntimeHost,
        activation: Arc<ProfileActivationCoordinator>,
        browser_client: BrowserClientHandle,
    ) -> Self {
        Self {
            activation,
            browser_client,
            runtime,
        }
    }

    async fn model(&self) -> StatusMenuModel {
        let status = self
            .runtime
            .status_snapshot_typed(StatusAdapterKind::Native)
            .await;
        let activation = self.activation.activation_snapshot().await;
        StatusMenuModel::new(
            &status,
            &activation,
            self.runtime.supports_status_command(StatusCommand::Routing),
        )
    }
}

#[derive(Debug, Eq, PartialEq)]
struct StatusMenuModel {
    core_title: &'static str,
    current_profile: String,
    leave_system_proxy_enabled: bool,
    restart_core_enabled: bool,
    restart_core_title: &'static str,
    routing_mode: RoutingMode,
    routing_supported: bool,
    system_proxy_checked: bool,
    system_proxy_enabled: bool,
    system_proxy_title: &'static str,
    tun_checked: bool,
    tun_enabled: bool,
    tun_title: &'static str,
    repair_system_proxy_enabled: bool,
}

impl StatusMenuModel {
    fn new(
        status: &StatusSnapshot,
        activation: &ProfileActivationSnapshot,
        routing_supported: bool,
    ) -> Self {
        let active_label = activation
            .active_profile_id
            .as_deref()
            .and_then(|active_id| {
                status
                    .profiles
                    .iter()
                    .find(|profile| profile.id == active_id)
                    .map(|profile| profile.label.as_str())
            });
        let current_profile = match active_label.and_then(safe_profile_label) {
            Some(label) => format!("Current Profile — {label}"),
            None if activation.active_profile_id.is_some() => "Current Profile — Active".into(),
            None => "Current Profile — Safely stopped".into(),
        };
        let pending = status.runtime.system_proxy.phase == SystemProxyPhase::Pending;
        let drift = status.runtime.system_proxy.phase == SystemProxyPhase::Drift;
        let supported = status.capabilities.system_proxy == CapabilityAvailability::Supported;
        let tun_supported = status.capabilities.tun == CapabilityAvailability::Supported;
        let recovery_actions = &status.runtime.system_proxy.recovery_actions;
        let restart_target = activation
            .active_profile_id
            .as_ref()
            .or(activation.target_profile_id.as_ref());

        Self {
            core_title: core_title(status.runtime.phase),
            current_profile,
            leave_system_proxy_enabled: drift
                && recovery_actions.contains(&CaptureRecoveryAction::LeaveAsIs),
            restart_core_enabled: restart_target.is_some()
                && activation.availability == ProfileActivationAvailability::Available
                && activation.phase != ProfileActivationPhase::Pending,
            restart_core_title: if activation.active_profile_id.is_some() {
                "Restart Core"
            } else {
                "Recover Core"
            },
            routing_mode: status.routing_mode,
            routing_supported,
            system_proxy_checked: status.runtime.system_proxy_enabled,
            system_proxy_enabled: supported && !pending && !drift,
            system_proxy_title: system_proxy_title(status.runtime.system_proxy.phase),
            tun_checked: status.runtime.tun_enabled,
            tun_enabled: tun_supported && status.runtime.tun.phase != TunPhase::Pending,
            tun_title: tun_title(status.runtime.tun.phase),
            repair_system_proxy_enabled: drift
                && recovery_actions.contains(&CaptureRecoveryAction::Repair),
        }
    }
}

pub(crate) fn initialize(
    app: &tauri::App,
    state: StatusBarState,
) -> Result<(), Box<dyn std::error::Error>> {
    let model = tauri::async_runtime::block_on(state.model());
    let menu = build_menu(app, &model)?;
    let handler_state = state.clone();
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Mish")
        .icon(status_bar_icon())
        .icon_as_template(true)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref(), handler_state.clone());
        });
    tray.build(app)?;

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        watch_status_menu(app_handle, state).await;
    });
    Ok(())
}

fn handle_menu_event(app: &tauri::AppHandle, id: &str, state: StatusBarState) {
    match id {
        OPEN_MISH_ID => show_main_window(app, None),
        OPEN_BROWSER_ID => open_browser_client(&state),
        OPEN_ROUTES_ID => show_main_window(app, Some("/routes")),
        QUIT_ID => app.exit(0),
        TOGGLE_SYSTEM_PROXY_ID
        | TOGGLE_TUN_ID
        | REPAIR_SYSTEM_PROXY_ID
        | LEAVE_SYSTEM_PROXY_ID
        | ROUTING_RULE_ID
        | ROUTING_GLOBAL_ID
        | ROUTING_DIRECT_ID
        | RESTART_CORE_ID => {
            let app = app.clone();
            let id = id.to_owned();
            tauri::async_runtime::spawn(async move {
                run_native_command(&state, &id).await;
                refresh_menu(&app, &state).await;
            });
        }
        _ => {}
    }
}

fn open_browser_client(state: &StatusBarState) {
    let Ok(nonce) = super::generate_auth_token() else {
        show_browser_open_error();
        return;
    };
    let Ok(url) = state.browser_client.issue_launch_url(nonce) else {
        show_browser_open_error();
        return;
    };
    if open_browser_url(&url).is_err() {
        show_browser_open_error();
    }
}

async fn run_native_command(state: &StatusBarState, id: &str) {
    match id {
        TOGGLE_SYSTEM_PROXY_ID => {
            let snapshot = state
                .runtime
                .status_snapshot_typed(StatusAdapterKind::Native)
                .await;
            let enable = !snapshot.runtime.system_proxy.desired;
            let _ = state
                .activation
                .set_capture(
                    CaptureRequest {
                        active: enable,
                        selection: CaptureSelection {
                            system_proxy: enable,
                            tun: false,
                        },
                    },
                    StatusAdapterKind::Native,
                )
                .await;
        }
        TOGGLE_TUN_ID => {
            let snapshot = state
                .runtime
                .status_snapshot_typed(StatusAdapterKind::Native)
                .await;
            let enable = !snapshot.runtime.tun.desired;
            let mut selection = snapshot.runtime.capture_selection;
            selection.tun = enable;
            let active = enable || snapshot.runtime.system_proxy_enabled;
            let _ = state
                .activation
                .set_capture(
                    CaptureRequest { active, selection },
                    StatusAdapterKind::Native,
                )
                .await;
        }
        REPAIR_SYSTEM_PROXY_ID => {
            let _ = state
                .runtime
                .recover_system_proxy(CaptureRecoveryAction::Repair, StatusAdapterKind::Native)
                .await;
        }
        LEAVE_SYSTEM_PROXY_ID => {
            let _ = state
                .runtime
                .recover_system_proxy(CaptureRecoveryAction::LeaveAsIs, StatusAdapterKind::Native)
                .await;
        }
        ROUTING_RULE_ID => set_routing_mode(state, RoutingMode::Rule).await,
        ROUTING_GLOBAL_ID => set_routing_mode(state, RoutingMode::Global).await,
        ROUTING_DIRECT_ID => set_routing_mode(state, RoutingMode::Direct).await,
        RESTART_CORE_ID => {
            let activation = state.activation.activation_snapshot().await;
            let target = activation
                .active_profile_id
                .as_deref()
                .or(activation.target_profile_id.as_deref());
            if let Some(profile_id) = target {
                let _ = state
                    .activation
                    .activate(&Uuid::new_v4().to_string(), profile_id)
                    .await;
            }
        }
        _ => {}
    }
}

async fn set_routing_mode(state: &StatusBarState, mode: RoutingMode) {
    let _ = state
        .runtime
        .set_routing_mode(mode, StatusAdapterKind::Native)
        .await;
}

pub(crate) fn show_main_window(app: &tauri::AppHandle, destination: Option<&str>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Some(destination) = destination {
        let _ = app.emit_to("main", "mish:navigate", destination);
    }
}

async fn watch_status_menu(app: tauri::AppHandle, state: StatusBarState) {
    let mut runtime_changes = state.runtime.subscribe_changes();
    let mut status_updates = runtime_changes.borrow_and_update().subscribe_status();
    let mut activation_updates = state.activation.subscribe();

    loop {
        tokio::select! {
            changed = runtime_changes.changed() => {
                if changed.is_err() {
                    break;
                }
                status_updates = runtime_changes.borrow_and_update().subscribe_status();
            }
            update = status_updates.recv() => {
                if update.is_err() && status_updates.is_closed() {
                    status_updates = runtime_changes.borrow().subscribe_status();
                }
            }
            update = activation_updates.recv() => {
                if update.is_err() && activation_updates.is_closed() {
                    break;
                }
            }
        }
        refresh_menu(&app, &state).await;
    }
}

async fn refresh_menu(app: &tauri::AppHandle, state: &StatusBarState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let model = state.model().await;
    if let Ok(menu) = build_menu(app, &model) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_menu<M: Manager<tauri::Wry>>(
    manager: &M,
    model: &StatusMenuModel,
) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItemBuilder::with_id(OPEN_MISH_ID, "Open Mish").build(manager)?;
    let routes = MenuItemBuilder::with_id(OPEN_ROUTES_ID, "Open Routes").build(manager)?;
    let browser =
        MenuItemBuilder::with_id(OPEN_BROWSER_ID, "Open Browser Client").build(manager)?;
    let profile = MenuItemBuilder::new(&model.current_profile)
        .enabled(false)
        .build(manager)?;
    let core = MenuItemBuilder::new(model.core_title)
        .enabled(false)
        .build(manager)?;
    let system_proxy =
        CheckMenuItemBuilder::with_id(TOGGLE_SYSTEM_PROXY_ID, model.system_proxy_title)
            .checked(model.system_proxy_checked)
            .enabled(model.system_proxy_enabled)
            .build(manager)?;
    let repair = MenuItemBuilder::with_id(REPAIR_SYSTEM_PROXY_ID, "Repair System Proxy")
        .enabled(model.repair_system_proxy_enabled)
        .build(manager)?;
    let leave = MenuItemBuilder::with_id(
        LEAVE_SYSTEM_PROXY_ID,
        "Leave Current System Proxy State As Is",
    )
    .enabled(model.leave_system_proxy_enabled)
    .build(manager)?;
    let tun = CheckMenuItemBuilder::with_id(TOGGLE_TUN_ID, model.tun_title)
        .checked(model.tun_checked)
        .enabled(model.tun_enabled)
        .build(manager)?;
    let rule = CheckMenuItemBuilder::with_id(ROUTING_RULE_ID, "Rule")
        .checked(model.routing_mode == RoutingMode::Rule)
        .enabled(model.routing_supported)
        .build(manager)?;
    let global = CheckMenuItemBuilder::with_id(ROUTING_GLOBAL_ID, "Global")
        .checked(model.routing_mode == RoutingMode::Global)
        .enabled(model.routing_supported)
        .build(manager)?;
    let direct = CheckMenuItemBuilder::with_id(ROUTING_DIRECT_ID, "Direct")
        .checked(model.routing_mode == RoutingMode::Direct)
        .enabled(model.routing_supported)
        .build(manager)?;
    let routing = SubmenuBuilder::new(manager, "Routing Mode")
        .enabled(model.routing_supported)
        .items(&[&rule, &global, &direct])
        .build()?;
    let restart = MenuItemBuilder::with_id(RESTART_CORE_ID, model.restart_core_title)
        .enabled(model.restart_core_enabled)
        .build(manager)?;
    let quit = MenuItemBuilder::with_id(QUIT_ID, "Quit Mish").build(manager)?;

    MenuBuilder::new(manager)
        .items(&[&open, &routes, &browser])
        .separator()
        .items(&[&profile, &core])
        .separator()
        .items(&[&system_proxy, &repair, &leave, &tun])
        .item(&routing)
        .separator()
        .item(&restart)
        .separator()
        .item(&quit)
        .build()
}

fn system_proxy_title(phase: SystemProxyPhase) -> &'static str {
    match phase {
        SystemProxyPhase::Off => "System Proxy — Off",
        SystemProxyPhase::Pending => "System Proxy — Pending",
        SystemProxyPhase::Applied => "System Proxy — On",
        SystemProxyPhase::Failed => "System Proxy — Failed",
        SystemProxyPhase::Drift => "System Proxy — Needs Recovery",
    }
}

fn tun_title(phase: TunPhase) -> &'static str {
    match phase {
        TunPhase::Off => "TUN — Off",
        TunPhase::Pending => "TUN — Pending",
        TunPhase::Applied => "TUN — On",
        TunPhase::Failed => "TUN — Failed",
        TunPhase::Drift => "TUN — Needs Recovery",
    }
}

fn core_title(phase: RuntimePhase) -> &'static str {
    match phase {
        RuntimePhase::Inactive => "Core — Stopped",
        RuntimePhase::Connecting => "Core — Starting",
        RuntimePhase::Healthy => "Core — Running",
        RuntimePhase::Stopping => "Core — Stopping",
        RuntimePhase::Error => "Core — Failed",
    }
}

fn status_bar_icon() -> tauri::image::Image<'static> {
    const SIZE: usize = 18;
    let mut rgba = vec![0_u8; SIZE * SIZE * 4];
    let mut set_pixel = |x: usize, y: usize| {
        rgba[(y * SIZE + x) * 4 + 3] = u8::MAX;
    };
    for y in 3..16 {
        for x in [2, 3, 14, 15] {
            set_pixel(x, y);
        }
    }
    for (x, y) in [(4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9)] {
        set_pixel(x, y);
        set_pixel(x, y + 1);
        let mirrored_x = 18 - x;
        set_pixel(mirrored_x, y);
        set_pixel(mirrored_x, y + 1);
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

fn safe_profile_label(label: &str) -> Option<&str> {
    let label = label.trim();
    let lowercase = label.to_ascii_lowercase();
    if label.is_empty()
        || label.chars().count() > 64
        || label.chars().any(char::is_control)
        || label.contains(['/', '\\'])
        || lowercase.contains("://")
        || lowercase.contains("token=")
        || lowercase.contains("secret=")
        || lowercase.contains("password=")
        || lowercase.starts_with("sk-")
        || label.contains([':', '@'])
        || label.parse::<std::net::IpAddr>().is_ok()
    {
        return None;
    }
    Some(label)
}

#[cfg(test)]
mod tests {
    use super::{core_title, safe_profile_label, status_bar_icon, system_proxy_title, tun_title};
    use mish_runtime::{RuntimePhase, SystemProxyPhase, TunPhase};

    #[test]
    fn status_bar_redacts_sensitive_or_unbounded_profile_labels() {
        assert_eq!(
            safe_profile_label("Studio route set"),
            Some("Studio route set")
        );
        for sensitive in [
            "https://private.example/profile",
            "../private.yaml",
            "127.0.0.1",
            "private.example:7890",
            "token=secret-value",
            "sk-private-credential",
            "line\nbreak",
        ] {
            assert_eq!(safe_profile_label(sensitive), None);
        }
        assert_eq!(safe_profile_label(&"x".repeat(65)), None);
    }

    #[test]
    fn system_proxy_menu_never_collapses_pending_drift_or_failure_into_success() {
        assert_eq!(
            system_proxy_title(SystemProxyPhase::Pending),
            "System Proxy — Pending"
        );
        assert_eq!(
            system_proxy_title(SystemProxyPhase::Drift),
            "System Proxy — Needs Recovery"
        );
        assert_eq!(
            system_proxy_title(SystemProxyPhase::Failed),
            "System Proxy — Failed"
        );
    }

    #[test]
    fn core_menu_preserves_transitional_and_failed_phases() {
        assert_eq!(core_title(RuntimePhase::Connecting), "Core — Starting");
        assert_eq!(core_title(RuntimePhase::Stopping), "Core — Stopping");
        assert_eq!(core_title(RuntimePhase::Error), "Core — Failed");
    }

    #[test]
    fn tun_menu_never_collapses_pending_drift_or_failure_into_success() {
        assert_eq!(tun_title(TunPhase::Pending), "TUN — Pending");
        assert_eq!(tun_title(TunPhase::Drift), "TUN — Needs Recovery");
        assert_eq!(tun_title(TunPhase::Failed), "TUN — Failed");
    }

    #[test]
    fn status_bar_icon_is_a_bounded_monochrome_template() {
        let icon = status_bar_icon();
        assert_eq!((icon.width(), icon.height()), (18, 18));
        assert_eq!(icon.rgba().len(), 18 * 18 * 4);
        assert!(
            icon.rgba()
                .chunks_exact(4)
                .all(|pixel| { pixel[..3] == [0, 0, 0] && matches!(pixel[3], 0 | u8::MAX) })
        );
    }
}
