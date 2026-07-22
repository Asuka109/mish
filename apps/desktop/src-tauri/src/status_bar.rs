use std::{
    sync::Arc,
    time::{Duration, Instant},
};

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
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, Submenu,
        SubmenuBuilder,
    },
    tray::TrayIconBuilder,
};
use uuid::Uuid;

use crate::route_activity_summary::RouteActivitySummaryHandle;

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
const STATUS_BAR_ICON_RGBA: &[u8] =
    include_bytes!("../../../../packages/brand-assets/generated/status-bar/mish-status-bar.rgba");

#[derive(Clone)]
pub(crate) struct StatusBarState {
    activation: Arc<ProfileActivationCoordinator>,
    browser_client: BrowserClientHandle,
    runtime: DesktopRuntimeHost,
    traffic_observations: NativeTrafficObservations,
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
            traffic_observations: NativeTrafficObservations::default(),
        }
    }

    async fn model(&self) -> StatusMenuModel {
        let (status, traffic) = self.runtime.native_traffic_handoff().await;
        self.traffic_observations.observe(&status, &traffic);
        let activation = self.activation.activation_snapshot().await;
        StatusMenuModel::new(
            &status,
            &activation,
            self.runtime.supports_status_command(StatusCommand::Routing),
        )
    }
}

/// The sole native handoff from authoritative Traffic into private rolling
/// observations. Querying the handle is local and never fetches Traffic again.
#[derive(Clone)]
struct NativeTrafficObservations {
    handle: RouteActivitySummaryHandle,
    origin: Instant,
}

impl Default for NativeTrafficObservations {
    fn default() -> Self {
        Self {
            handle: RouteActivitySummaryHandle::default(),
            origin: Instant::now(),
        }
    }
}

impl NativeTrafficObservations {
    fn observe(&self, status: &StatusSnapshot, traffic: &mish_runtime::TrafficDataSnapshot) {
        self.observe_at(status, traffic, self.origin.elapsed());
    }

    fn observe_at(
        &self,
        status: &StatusSnapshot,
        traffic: &mish_runtime::TrafficDataSnapshot,
        observed_at: Duration,
    ) {
        self.handle.observe(traffic, &status.nodes, observed_at);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
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

struct StatusMenuItems {
    core: MenuItem<tauri::Wry>,
    direct: CheckMenuItem<tauri::Wry>,
    global: CheckMenuItem<tauri::Wry>,
    leave: MenuItem<tauri::Wry>,
    menu: Menu<tauri::Wry>,
    profile: MenuItem<tauri::Wry>,
    repair: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    routing: Submenu<tauri::Wry>,
    rule: CheckMenuItem<tauri::Wry>,
    system_proxy: CheckMenuItem<tauri::Wry>,
    tun: CheckMenuItem<tauri::Wry>,
}

impl StatusMenuItems {
    fn apply(&self, model: &StatusMenuModel) -> tauri::Result<()> {
        self.profile.set_text(&model.current_profile)?;
        self.core.set_text(model.core_title)?;
        self.system_proxy.set_text(model.system_proxy_title)?;
        self.system_proxy.set_checked(model.system_proxy_checked)?;
        self.system_proxy.set_enabled(model.system_proxy_enabled)?;
        self.repair.set_enabled(model.repair_system_proxy_enabled)?;
        self.leave.set_enabled(model.leave_system_proxy_enabled)?;
        self.tun.set_text(model.tun_title)?;
        self.tun.set_checked(model.tun_checked)?;
        self.tun.set_enabled(model.tun_enabled)?;
        self.routing.set_enabled(model.routing_supported)?;
        self.rule
            .set_checked(model.routing_mode == RoutingMode::Rule)?;
        self.global
            .set_checked(model.routing_mode == RoutingMode::Global)?;
        self.direct
            .set_checked(model.routing_mode == RoutingMode::Direct)?;
        self.restart.set_text(model.restart_core_title)?;
        self.restart.set_enabled(model.restart_core_enabled)
    }
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
        .menu(&menu.menu)
        .show_menu_on_left_click(true)
        .tooltip("Mish")
        .icon(status_bar_icon())
        .icon_as_template(true)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref(), handler_state.clone());
        });
    tray.build(app)?;

    tauri::async_runtime::spawn(async move {
        watch_status_menu(state, model, menu).await;
    });
    Ok(())
}

fn handle_menu_event(app: &tauri::AppHandle, id: &str, state: StatusBarState) {
    if is_quit_menu_command(id) {
        crate::request_graceful_exit(app);
        return;
    }
    match id {
        OPEN_MISH_ID => show_main_window(app, None),
        OPEN_BROWSER_ID => open_browser_client(&state),
        OPEN_ROUTES_ID => show_main_window(app, Some("/routes")),
        TOGGLE_SYSTEM_PROXY_ID
        | TOGGLE_TUN_ID
        | REPAIR_SYSTEM_PROXY_ID
        | LEAVE_SYSTEM_PROXY_ID
        | ROUTING_RULE_ID
        | ROUTING_GLOBAL_ID
        | ROUTING_DIRECT_ID
        | RESTART_CORE_ID => {
            let id = id.to_owned();
            tauri::async_runtime::spawn(async move {
                run_native_command(&state, &id).await;
            });
        }
        _ => {}
    }
}

pub(crate) fn is_quit_menu_command(id: &str) -> bool {
    id == QUIT_ID
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

async fn watch_status_menu(
    state: StatusBarState,
    mut current_model: StatusMenuModel,
    menu: StatusMenuItems,
) {
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
        let next_model = state.model().await;
        if accept_changed_menu_model(&mut current_model, next_model) {
            let _ = menu.apply(&current_model);
        }
    }
}

fn accept_changed_menu_model(current: &mut StatusMenuModel, next: StatusMenuModel) -> bool {
    if *current == next {
        return false;
    }
    *current = next;
    true
}

fn build_menu<M: Manager<tauri::Wry>>(
    manager: &M,
    model: &StatusMenuModel,
) -> tauri::Result<StatusMenuItems> {
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

    let menu = MenuBuilder::new(manager)
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
        .build()?;
    Ok(StatusMenuItems {
        core,
        direct,
        global,
        leave,
        menu,
        profile,
        repair,
        restart,
        routing,
        rule,
        system_proxy,
        tun,
    })
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
    tauri::image::Image::new(STATUS_BAR_ICON_RGBA, 36, 36)
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
    use super::{
        NativeTrafficObservations, StatusMenuModel, accept_changed_menu_model, core_title,
        is_quit_menu_command, safe_profile_label, status_bar_icon, system_proxy_title, tun_title,
    };
    use mish_runtime::{
        CorePhase, CoreStatus, ProxyNode, RuntimePhase, StatusAdapterKind, StatusSnapshot,
        SystemProxyPhase, TrafficConnection, TrafficDataPhase, TrafficDataSnapshot,
        TrafficMatchedRule, TunPhase,
    };
    use std::time::Duration;

    fn authoritative_status() -> StatusSnapshot {
        let mut status = StatusSnapshot::lifecycle_only(
            &CoreStatus {
                error: None,
                phase: CorePhase::Running,
                pid: Some(1),
                version: None,
            },
            StatusAdapterKind::Native,
        );
        status.nodes.push(ProxyNode {
            id: "private-node".into(),
            label: "Tokyo".into(),
            latency_milliseconds: None,
            protocol: "ss".into(),
        });
        status
    }

    fn authoritative_traffic() -> TrafficDataSnapshot {
        TrafficDataSnapshot {
            active_connections: vec![TrafficConnection {
                destination_host: Some("private.example".into()),
                destination_ip: None,
                destination_port: 443,
                download_bytes: "0".into(),
                id: "private-connection".into(),
                matched_rule: TrafficMatchedRule {
                    payload: "MATCH".into(),
                    kind: "MATCH".into(),
                },
                network: "tcp".into(),
                process_name: None,
                process_path: None,
                protocol: "tcp".into(),
                provider_chain: Vec::new(),
                remote_destination: None,
                route_chain: vec!["Tokyo".into()],
                sniff_host: None,
                source_ip: None,
                source_port: 0,
                started_at: "2026-01-01T00:00:00Z".into(),
                upload_bytes: "0".into(),
            }],
            adapter_kind: StatusAdapterKind::Native,
            phase: TrafficDataPhase::Ready,
            profile_id: "private-profile".into(),
            reconnect_count: 0,
            rules: Vec::new(),
            sequence: 1,
            session_id: Some("traffic-session".into()),
        }
    }

    #[test]
    fn status_bar_quit_routes_to_the_shared_quit_command() {
        assert!(is_quit_menu_command("status-bar.quit"));
        assert!(!is_quit_menu_command("status-bar.restart-core"));
    }

    #[test]
    fn production_native_traffic_handoff_records_once_and_queries_without_refetching() {
        let observations = NativeTrafficObservations::default();
        let status = authoritative_status();
        let traffic = authoritative_traffic();
        observations.observe_at(&status, &traffic, Duration::ZERO);
        assert_eq!(
            observations
                .handle
                .summary_at(Duration::ZERO)
                .map(|summary| summary.label),
            Some("Tokyo".into())
        );
        // The query uses only the retained private handle; no runtime or Controller input is accepted.
        assert_eq!(
            observations.handle.summary_at(Duration::from_secs(60)),
            None
        );
    }

    #[test]
    fn status_menu_is_not_rebuilt_for_unchanged_runtime_updates() {
        let mut current = StatusMenuModel {
            core_title: "Core — Running",
            current_profile: "Current Profile — Fixture".into(),
            leave_system_proxy_enabled: false,
            restart_core_enabled: true,
            restart_core_title: "Restart Core",
            routing_mode: mish_runtime::RoutingMode::Rule,
            routing_supported: true,
            system_proxy_checked: true,
            system_proxy_enabled: true,
            system_proxy_title: "System Proxy — On",
            tun_checked: false,
            tun_enabled: false,
            tun_title: "TUN — Off",
            repair_system_proxy_enabled: false,
        };

        let unchanged = current.clone();
        assert!(!accept_changed_menu_model(&mut current, unchanged));
        let mut changed = current.clone();
        changed.core_title = "Core — Stopped";
        assert!(accept_changed_menu_model(&mut current, changed));
        assert_eq!(current.core_title, "Core — Stopped");
    }

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
    fn status_bar_icon_is_a_retina_monochrome_template() {
        let icon = status_bar_icon();
        assert_eq!((icon.width(), icon.height()), (36, 36));
        assert_eq!(icon.rgba().len(), 36 * 36 * 4);
        assert!(
            icon.rgba()
                .chunks_exact(4)
                .all(|pixel| pixel[..3] == [0, 0, 0])
        );
        assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
    }
}
