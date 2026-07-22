use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use mish_bridge::{
    BrowserClientHandle, DesktopRuntimeHost, ProfileActivationAvailability,
    ProfileActivationCoordinator, ProfileActivationPhase, ProfileActivationSnapshot,
};
use mish_platform_macos::{open_browser_url, show_browser_open_error, show_proxy_launch_error};
use mish_runtime::{
    CaptureRequest, StatusAdapterKind, StatusSnapshot, TrafficDataPhase, TrafficSnapshot,
};
use mish_settings::{SettingsAdapterKind, SettingsService};
use tauri::{
    Emitter, Manager,
    menu::{CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder},
};
use uuid::Uuid;

use crate::route_activity_summary::RouteActivitySummaryHandle;

const TRAY_ID: &str = "mish-status-bar";
const OPEN_MISH_ID: &str = "status-bar.open-mish";
const OPEN_BROWSER_ID: &str = "status-bar.open-browser";
const OPEN_ROUTES_ID: &str = "status-bar.open-routes";
const OPEN_PROFILES_ID: &str = "status-bar.open-profiles";
const OPEN_TRAFFIC_ID: &str = "status-bar.open-traffic";
const OPEN_EVENTS_ID: &str = "status-bar.open-events";
const OPEN_SETTINGS_ID: &str = "status-bar.open-settings";
const TOGGLE_PROXY_ID: &str = "status-bar.toggle-proxy";
const TOGGLE_LAUNCH_ON_START_ID: &str = "status-bar.toggle-launch-on-start";
const QUIT_ID: &str = "status-bar.quit";
const STATUS_BAR_ICON_ACTIVE_RGBA: &[u8] = include_bytes!(
    "../../../../packages/brand-assets/generated/status-bar/mish-status-bar-active.rgba"
);
const STATUS_BAR_ICON_INACTIVE_RGBA: &[u8] = include_bytes!(
    "../../../../packages/brand-assets/generated/status-bar/mish-status-bar-inactive.rgba"
);

#[derive(Clone)]
pub(crate) struct StatusBarState {
    activation: Arc<ProfileActivationCoordinator>,
    browser_client: BrowserClientHandle,
    runtime: DesktopRuntimeHost,
    settings: Arc<SettingsService>,
    traffic_observations: NativeTrafficObservations,
}

impl StatusBarState {
    pub(crate) fn new(
        runtime: DesktopRuntimeHost,
        activation: Arc<ProfileActivationCoordinator>,
        browser_client: BrowserClientHandle,
        settings: Arc<SettingsService>,
    ) -> Self {
        Self {
            activation,
            browser_client,
            runtime,
            settings,
            traffic_observations: NativeTrafficObservations::default(),
        }
    }

    async fn model(&self) -> StatusBarModel {
        let (status, traffic) = self.runtime.native_traffic_handoff().await;
        self.traffic_observations.observe(&status, &traffic);
        let activation = self.activation.activation_snapshot().await;
        let launch_on_start = self
            .settings
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .startup
            .launch_proxy_when_mish_launches;
        StatusBarModel::new(&status, &activation, launch_on_start)
    }

    async fn model_with_capture(
        &self,
        capture: mish_runtime::CaptureRuntimeStatus,
    ) -> StatusBarModel {
        let (mut status, traffic) = self.runtime.native_traffic_handoff().await;
        status.runtime.capture_selection = capture.capture_selection;
        status.runtime.system_proxy = capture.system_proxy;
        status.runtime.system_proxy_enabled = capture.system_proxy_enabled;
        status.runtime.tun = capture.tun;
        status.runtime.tun_enabled = capture.tun_enabled;
        self.traffic_observations.observe(&status, &traffic);
        let activation = self.activation.activation_snapshot().await;
        let launch_on_start = self
            .settings
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .startup
            .launch_proxy_when_mish_launches;
        StatusBarModel::new(&status, &activation, launch_on_start)
    }
}

/// The sole native handoff from authoritative Traffic into private rolling
/// observations. Querying the handle is local and never fetches Traffic again.
#[derive(Clone)]
struct NativeTrafficObservations {
    handle: RouteActivitySummaryHandle,
    origin: Instant,
    latest: Arc<std::sync::Mutex<LiveTraffic>>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct LiveTraffic {
    phase: Option<TrafficDataPhase>,
    rates: TrafficSnapshot,
}

impl Default for NativeTrafficObservations {
    fn default() -> Self {
        Self {
            handle: RouteActivitySummaryHandle::default(),
            origin: Instant::now(),
            latest: Arc::new(std::sync::Mutex::new(LiveTraffic::default())),
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
        if let Ok(mut latest) = self.latest.lock() {
            *latest = LiveTraffic {
                phase: Some(traffic.phase),
                rates: status.traffic.clone(),
            };
        }
    }

    fn live_status_at(&self, observed_at: Duration) -> LiveStatusModel {
        let latest = self
            .latest
            .lock()
            .map(|latest| latest.clone())
            .unwrap_or_default();
        let available = latest.phase == Some(TrafficDataPhase::Ready);
        LiveStatusModel {
            most_active_node: match (available, self.handle.summary_at(observed_at)) {
                (true, Some(summary)) => format!("Most active node — {}", summary.label),
                (true, None) => "Most active node — Idle".into(),
                (false, _) => "Most active node — Unavailable".into(),
            },
            download: rate_title(
                "Download",
                latest.rates.download_bytes_per_second,
                available,
            ),
            upload: rate_title("Upload", latest.rates.upload_bytes_per_second, available),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StatusMenuModel {
    launch_on_start: bool,
    proxy_enabled: bool,
    proxy_title: &'static str,
}

struct StatusMenuItems {
    menu: Menu<tauri::Wry>,
    proxy: MenuItem<tauri::Wry>,
    most_active_node: MenuItem<tauri::Wry>,
    download: MenuItem<tauri::Wry>,
    launch_on_start: CheckMenuItem<tauri::Wry>,
    upload: MenuItem<tauri::Wry>,
}

struct StatusBarItems {
    menu: StatusMenuItems,
    tray: TrayIcon<tauri::Wry>,
}

impl StatusMenuItems {
    fn apply(&self, model: &StatusMenuModel) -> tauri::Result<()> {
        self.proxy.set_text(model.proxy_title)?;
        self.proxy.set_enabled(model.proxy_enabled)?;
        self.launch_on_start.set_checked(model.launch_on_start)
    }

    fn apply_live_status(&self, model: &LiveStatusModel) -> tauri::Result<()> {
        self.most_active_node.set_text(&model.most_active_node)?;
        self.download.set_text(&model.download)?;
        self.upload.set_text(&model.upload)
    }
}

impl StatusMenuModel {
    fn new(
        status: &StatusSnapshot,
        activation: &ProfileActivationSnapshot,
        launch_on_start: bool,
    ) -> Self {
        Self {
            launch_on_start,
            proxy_title: proxy_title(status, activation),
            proxy_enabled: proxy_enabled(status, activation),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StatusBarModel {
    menu: StatusMenuModel,
    icon_active: bool,
}

impl StatusBarModel {
    fn new(
        status: &StatusSnapshot,
        activation: &ProfileActivationSnapshot,
        launch_on_start: bool,
    ) -> Self {
        Self {
            menu: StatusMenuModel::new(status, activation, launch_on_start),
            icon_active: status.runtime.system_proxy_enabled || status.runtime.tun_enabled,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct StatusBarUpdate {
    menu_changed: bool,
    icon_changed: bool,
}

pub(crate) fn initialize(
    app: &tauri::App,
    state: StatusBarState,
) -> Result<(), Box<dyn std::error::Error>> {
    let model = tauri::async_runtime::block_on(state.model());
    let menu = build_menu(app, &model.menu)?;
    let handler_state = state.clone();
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu.menu)
        .show_menu_on_left_click(true)
        .tooltip("Mish")
        .icon(status_bar_icon(model.icon_active))
        .icon_as_template(true)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref(), handler_state.clone());
        });
    let tray = tray.build(app)?;
    let items = StatusBarItems { menu, tray };

    tauri::async_runtime::spawn(async move {
        watch_status_menu(state, model, items).await;
    });
    Ok(())
}

fn handle_menu_event(app: &tauri::AppHandle, id: &str, state: StatusBarState) {
    if is_quit_menu_command(id) {
        crate::request_graceful_exit(app);
        return;
    }
    match id {
        OPEN_MISH_ID => show_main_window(app, Some("/status")),
        OPEN_BROWSER_ID => open_browser_client(&state),
        OPEN_ROUTES_ID => show_main_window(app, Some("/routes")),
        OPEN_PROFILES_ID => show_main_window(app, Some("/profiles")),
        OPEN_TRAFFIC_ID => show_main_window(app, Some("/traffic")),
        OPEN_EVENTS_ID => show_main_window(app, Some("/events")),
        OPEN_SETTINGS_ID => show_main_window(app, Some("/settings")),
        TOGGLE_LAUNCH_ON_START_ID => {
            let settings = state.settings.clone();
            tauri::async_runtime::spawn(async move {
                let enabled = !settings
                    .snapshot(SettingsAdapterKind::Rpc)
                    .preferences
                    .startup
                    .launch_proxy_when_mish_launches;
                let _ = settings.set_launch_proxy_when_mish_launches(enabled);
            });
        }
        TOGGLE_PROXY_ID => {
            let id = id.to_owned();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                run_native_command(&app, &state, &id).await;
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

async fn run_native_command(app: &tauri::AppHandle, state: &StatusBarState, id: &str) {
    if id != TOGGLE_PROXY_ID {
        return;
    }
    let snapshot = state
        .runtime
        .status_snapshot_typed(StatusAdapterKind::Native)
        .await;
    let selection = snapshot.runtime.capture_selection.clone();
    let result = if snapshot.runtime.system_proxy_enabled || snapshot.runtime.tun_enabled {
        state
            .activation
            .set_capture(
                CaptureRequest {
                    active: false,
                    selection,
                },
                StatusAdapterKind::Native,
            )
            .await
    } else {
        let remembered_selection = state
            .settings
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .capture_selection
            .into();
        state
            .activation
            .launch_proxy(
                &Uuid::new_v4().to_string(),
                None,
                remembered_selection,
                StatusAdapterKind::Native,
            )
            .await
    };
    if result.is_err() {
        let _ = app.run_on_main_thread(show_proxy_launch_error);
    }
}

pub(crate) fn show_main_window(app: &tauri::AppHandle, destination: Option<&str>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Some(destination) = destination.filter(|destination| is_status_destination(destination))
    {
        let _ = app.emit_to("main", "mish:navigate", destination);
    }
}

fn is_status_destination(destination: &str) -> bool {
    matches!(
        destination,
        "/status" | "/routes" | "/profiles" | "/traffic" | "/events" | "/settings"
    )
}

#[cfg(test)]
const MENU_SECTIONS: &[&[&str]] = &[
    &["Launch proxy / Stop proxy"],
    &[
        "Open Mish",
        "Routes",
        "Profiles",
        "Traffic",
        "Events",
        "Settings",
    ],
    &["Most active node", "Download", "Upload"],
    &[
        "Open Browser Client",
        "Launch proxy when Mish launches",
        "Quit Mish",
    ],
];

async fn watch_status_menu(
    state: StatusBarState,
    mut current_model: StatusBarModel,
    items: StatusBarItems,
) {
    let mut runtime_changes = state.runtime.subscribe_changes();
    let mut status_updates = runtime_changes.borrow_and_update().subscribe_status();
    let mut capture_updates = runtime_changes.borrow().subscribe_capture();
    let mut activation_updates = state.activation.subscribe();
    let mut settings_updates = state.settings.subscribe();
    let mut refresh = tokio::time::interval(Duration::from_secs(1));
    let mut current_live = state.traffic_observations.live_status_at(Duration::ZERO);
    let _ = items.menu.apply_live_status(&current_live);

    loop {
        tokio::select! {
            _ = refresh.tick() => {
                let next_live = state.traffic_observations.live_status_at(state.traffic_observations.origin.elapsed());
                if next_live != current_live {
                    let _ = items.menu.apply_live_status(&next_live);
                    current_live = next_live;
                }
                continue;
            }
            changed = runtime_changes.changed() => {
                if changed.is_err() {
                    break;
                }
                status_updates = runtime_changes.borrow_and_update().subscribe_status();
                capture_updates = runtime_changes.borrow().subscribe_capture();
            }
            update = status_updates.recv() => {
                if update.is_err() && status_updates.is_closed() {
                    status_updates = runtime_changes.borrow().subscribe_status();
                }
            }
            update = async { capture_updates.as_mut().expect("capture updates are enabled").recv().await }, if capture_updates.is_some() => {
                let capture = match update {
                    Ok(capture) => capture,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        capture_updates = runtime_changes.borrow().subscribe_capture();
                        continue;
                    }
                };
                let next_model = state.model_with_capture(capture).await;
                let update = status_bar_update(&current_model, &next_model);
                if update.menu_changed {
                    current_model.menu = next_model.menu.clone();
                    let _ = items.menu.apply(&current_model.menu);
                }
                if update.icon_changed {
                    current_model.icon_active = next_model.icon_active;
                    let _ = items
                        .tray
                        .set_icon_with_as_template(Some(status_bar_icon(current_model.icon_active)), true);
                }
                continue;
            }
            update = activation_updates.recv() => {
                if update.is_err() && activation_updates.is_closed() {
                    break;
                }
            }
            update = settings_updates.recv() => {
                if update.is_err() && settings_updates.is_closed() {
                    break;
                }
            }
        }
        let next_model = state.model().await;
        let update = status_bar_update(&current_model, &next_model);
        if update.menu_changed {
            current_model.menu = next_model.menu.clone();
            let _ = items.menu.apply(&current_model.menu);
        }
        if update.icon_changed {
            current_model.icon_active = next_model.icon_active;
            let _ = items
                .tray
                .set_icon_with_as_template(Some(status_bar_icon(current_model.icon_active)), true);
        }
        let next_live = state
            .traffic_observations
            .live_status_at(state.traffic_observations.origin.elapsed());
        if next_live != current_live {
            let _ = items.menu.apply_live_status(&next_live);
            current_live = next_live;
        }
    }
}

fn status_bar_update(current: &StatusBarModel, next: &StatusBarModel) -> StatusBarUpdate {
    StatusBarUpdate {
        menu_changed: current.menu != next.menu,
        icon_changed: current.icon_active != next.icon_active,
    }
}

fn build_menu<M: Manager<tauri::Wry>>(
    manager: &M,
    model: &StatusMenuModel,
) -> tauri::Result<StatusMenuItems> {
    let open = MenuItemBuilder::with_id(OPEN_MISH_ID, "Open Mish").build(manager)?;
    let proxy = MenuItemBuilder::with_id(TOGGLE_PROXY_ID, model.proxy_title)
        .enabled(model.proxy_enabled)
        .build(manager)?;
    let most_active_node = MenuItemBuilder::new("Most active node — Unavailable")
        .enabled(false)
        .build(manager)?;
    let download = MenuItemBuilder::new("Download — Unavailable")
        .enabled(false)
        .build(manager)?;
    let upload = MenuItemBuilder::new("Upload — Unavailable")
        .enabled(false)
        .build(manager)?;
    let routes = MenuItemBuilder::with_id(OPEN_ROUTES_ID, "Routes").build(manager)?;
    let profiles = MenuItemBuilder::with_id(OPEN_PROFILES_ID, "Profiles").build(manager)?;
    let traffic = MenuItemBuilder::with_id(OPEN_TRAFFIC_ID, "Traffic").build(manager)?;
    let events = MenuItemBuilder::with_id(OPEN_EVENTS_ID, "Events").build(manager)?;
    let settings = MenuItemBuilder::with_id(OPEN_SETTINGS_ID, "Settings").build(manager)?;
    let browser =
        MenuItemBuilder::with_id(OPEN_BROWSER_ID, "Open Browser Client").build(manager)?;
    let launch_on_start =
        CheckMenuItemBuilder::with_id(TOGGLE_LAUNCH_ON_START_ID, "Launch proxy when Mish launches")
            .checked(model.launch_on_start)
            .build(manager)?;
    let quit = MenuItemBuilder::with_id(QUIT_ID, "Quit Mish").build(manager)?;

    let menu = MenuBuilder::new(manager)
        .item(&proxy)
        .separator()
        .items(&[&open, &routes, &profiles, &traffic, &events, &settings])
        .separator()
        .items(&[&most_active_node, &download, &upload])
        .separator()
        .items(&[&browser, &launch_on_start, &quit])
        .build()?;
    Ok(StatusMenuItems {
        menu,
        proxy,
        most_active_node,
        download,
        launch_on_start,
        upload,
    })
}

fn proxy_title(status: &StatusSnapshot, activation: &ProfileActivationSnapshot) -> &'static str {
    if status.runtime.system_proxy_enabled || status.runtime.tun_enabled {
        "Stop proxy"
    } else if activation.phase == ProfileActivationPhase::Pending
        || status.runtime.system_proxy.phase == mish_runtime::SystemProxyPhase::Pending
        || status.runtime.tun.phase == mish_runtime::TunPhase::Pending
    {
        "Launch proxy — Pending"
    } else if activation.phase == ProfileActivationPhase::Failure
        || matches!(
            status.runtime.system_proxy.phase,
            mish_runtime::SystemProxyPhase::Failed | mish_runtime::SystemProxyPhase::Drift
        )
        || matches!(
            status.runtime.tun.phase,
            mish_runtime::TunPhase::Failed | mish_runtime::TunPhase::Drift
        )
    {
        "Launch proxy — Failed"
    } else {
        "Launch proxy"
    }
}

fn proxy_enabled(status: &StatusSnapshot, activation: &ProfileActivationSnapshot) -> bool {
    activation.availability == ProfileActivationAvailability::Available
        && activation.phase != ProfileActivationPhase::Pending
        && status.runtime.system_proxy.phase != mish_runtime::SystemProxyPhase::Pending
        && status.runtime.tun.phase != mish_runtime::TunPhase::Pending
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LiveStatusModel {
    most_active_node: String,
    download: String,
    upload: String,
}

fn rate_title(label: &str, bytes_per_second: u64, available: bool) -> String {
    if available {
        format!("{label} — {}/s", format_bytes(bytes_per_second))
    } else {
        format!("{label} — Unavailable")
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut amount = bytes as f64;
    let mut unit = 0;
    while amount >= 1024.0 && unit < UNITS.len() - 1 {
        amount /= 1024.0;
        unit += 1;
    }
    let precision = if amount < 10.0 { 2 } else { 1 };
    format!("{amount:.precision$} {}", UNITS[unit])
}

fn status_bar_icon(active: bool) -> tauri::image::Image<'static> {
    let rgba = if active {
        STATUS_BAR_ICON_ACTIVE_RGBA
    } else {
        STATUS_BAR_ICON_INACTIVE_RGBA
    };
    tauri::image::Image::new(rgba, 36, 36)
}

#[cfg(test)]
mod tests {
    use super::{
        MENU_SECTIONS, NativeTrafficObservations, StatusBarModel, StatusMenuModel, format_bytes,
        is_quit_menu_command, is_status_destination, rate_title, status_bar_icon,
        status_bar_update,
    };
    use futures_util::future::BoxFuture;
    use mish_bridge::{
        DesktopRuntimeHost, ProfileActivationAvailability, ProfileActivationPhase,
        ProfileActivationSnapshot,
    };
    use mish_runtime::{
        CoreError, CorePhase, CoreRuntime, CoreStatus, MishRuntime, ProxyNode, StatusAdapterKind,
        StatusDataSource, StatusSnapshot, SystemProxyPhase, TrafficConnection, TrafficDataPhase,
        TrafficDataSnapshot, TrafficDataSource, TrafficMatchedRule,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::Duration;

    struct TestCore;

    impl CoreRuntime for TestCore {
        fn configured(&self) -> bool {
            true
        }

        fn status(&self) -> BoxFuture<'_, CoreStatus> {
            Box::pin(async { running_core_status() })
        }

        fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
            Box::pin(async { Ok(running_core_status()) })
        }

        fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
            Box::pin(async { Ok(running_core_status()) })
        }
    }

    fn running_core_status() -> CoreStatus {
        CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: Some(1),
            version: None,
        }
    }

    struct TestStatusSource;

    impl StatusDataSource for TestStatusSource {
        fn snapshot(&self, core: &CoreStatus, adapter_kind: StatusAdapterKind) -> StatusSnapshot {
            let mut status = StatusSnapshot::lifecycle_only(core, adapter_kind);
            status.traffic.download_bytes_per_second = 1_024;
            status.traffic.upload_bytes_per_second = 12_288;
            status.nodes.push(ProxyNode {
                id: "private-node".into(),
                label: "Tokyo".into(),
                latency_milliseconds: None,
                protocol: "ss".into(),
            });
            status
        }
    }

    struct TestTrafficSource(Arc<AtomicUsize>);

    impl TrafficDataSource for TestTrafficSource {
        fn traffic_snapshot(&self, adapter_kind: StatusAdapterKind) -> TrafficDataSnapshot {
            self.0.fetch_add(1, Ordering::Relaxed);
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
                adapter_kind,
                phase: TrafficDataPhase::Ready,
                profile_id: "private-profile".into(),
                reconnect_count: 0,
                rules: Vec::new(),
                sequence: 1,
                session_id: Some("traffic-session".into()),
            }
        }
    }

    #[test]
    fn status_bar_quit_routes_to_the_shared_quit_command() {
        assert!(is_quit_menu_command("status-bar.quit"));
        assert!(!is_quit_menu_command("status-bar.restart-core"));
    }

    #[tokio::test]
    async fn live_native_traffic_handoff_records_once_and_queries_without_refetching() {
        let traffic_fetches = Arc::new(AtomicUsize::new(0));
        let host = DesktopRuntimeHost::new(MishRuntime::with_data_sources(
            Arc::new(TestCore),
            Arc::new(TestStatusSource),
            Arc::new(TestTrafficSource(traffic_fetches.clone())),
        ));
        let observations = NativeTrafficObservations::default();
        let (status, traffic) = host.native_traffic_handoff().await;
        assert_eq!(traffic_fetches.load(Ordering::Relaxed), 1);
        observations.observe_at(&status, &traffic, Duration::ZERO);
        assert_eq!(
            observations.live_status_at(Duration::ZERO),
            super::LiveStatusModel {
                most_active_node: "Most active node — Tokyo".into(),
                download: "Download — 1.00 KB/s".into(),
                upload: "Upload — 12.0 KB/s".into(),
            }
        );
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
        assert_eq!(
            observations
                .live_status_at(Duration::from_secs(60))
                .most_active_node,
            "Most active node — Idle"
        );
        assert_eq!(traffic_fetches.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn status_bar_updates_only_the_changed_handles() {
        let current = StatusBarModel {
            menu: StatusMenuModel {
                launch_on_start: false,
                proxy_title: "Launch proxy",
                proxy_enabled: true,
            },
            icon_active: false,
        };

        assert_eq!(status_bar_update(&current, &current), Default::default());

        let icon_changed = StatusBarModel {
            icon_active: true,
            ..current.clone()
        };
        assert_eq!(
            status_bar_update(&current, &icon_changed),
            super::StatusBarUpdate {
                menu_changed: false,
                icon_changed: true,
            }
        );

        let menu_changed = StatusBarModel {
            menu: StatusMenuModel {
                proxy_title: "Stop proxy",
                ..current.menu.clone()
            },
            ..current
        };
        assert_eq!(
            status_bar_update(&icon_changed, &menu_changed),
            super::StatusBarUpdate {
                menu_changed: true,
                icon_changed: true,
            }
        );
    }

    #[test]
    fn aggregate_proxy_label_and_enabled_state_follow_authoritative_state() {
        let core = running_core_status();
        let mut status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Native);
        let mut activation = ProfileActivationSnapshot::unavailable();
        activation.availability = ProfileActivationAvailability::Available;
        assert_eq!(
            StatusMenuModel::new(&status, &activation, false).proxy_title,
            "Launch proxy"
        );
        assert!(StatusMenuModel::new(&status, &activation, false).proxy_enabled);

        activation.phase = ProfileActivationPhase::Pending;
        let pending = StatusMenuModel::new(&status, &activation, false);
        assert_eq!(pending.proxy_title, "Launch proxy — Pending");
        assert!(!pending.proxy_enabled);

        activation.phase = ProfileActivationPhase::Failure;
        let failed = StatusMenuModel::new(&status, &activation, false);
        assert_eq!(failed.proxy_title, "Launch proxy — Failed");
        assert!(failed.proxy_enabled);

        activation.phase = ProfileActivationPhase::Idle;
        status.runtime.system_proxy_enabled = true;
        status.runtime.system_proxy.phase = SystemProxyPhase::Applied;
        let active = StatusMenuModel::new(&status, &activation, true);
        assert_eq!(active.proxy_title, "Stop proxy");
        assert!(active.proxy_enabled);
        assert!(active.launch_on_start);
    }

    #[test]
    fn status_menu_has_the_compact_fixed_sections_and_destinations() {
        assert_eq!(
            MENU_SECTIONS,
            [
                ["Launch proxy / Stop proxy"].as_slice(),
                [
                    "Open Mish",
                    "Routes",
                    "Profiles",
                    "Traffic",
                    "Events",
                    "Settings"
                ]
                .as_slice(),
                ["Most active node", "Download", "Upload"].as_slice(),
                [
                    "Open Browser Client",
                    "Launch proxy when Mish launches",
                    "Quit Mish"
                ]
                .as_slice(),
            ]
        );
        for destination in [
            "/status",
            "/routes",
            "/profiles",
            "/traffic",
            "/events",
            "/settings",
        ] {
            assert!(is_status_destination(destination));
        }
        assert!(!is_status_destination("/diagnostics"));
    }

    #[test]
    fn live_rate_labels_use_the_existing_binary_byte_rate_convention() {
        assert_eq!(format_bytes(0), "0.00 B");
        assert_eq!(format_bytes(1_024), "1.00 KB");
        assert_eq!(format_bytes(12_288), "12.0 KB");
        assert_eq!(rate_title("Download", 1_024, true), "Download — 1.00 KB/s");
        assert_eq!(rate_title("Upload", 0, false), "Upload — Unavailable");
    }

    #[test]
    fn status_bar_icon_templates_are_retina_monochrome_masks() {
        let inactive = status_bar_icon(false);
        let active = status_bar_icon(true);
        assert_eq!((inactive.width(), inactive.height()), (36, 36));
        assert_eq!((active.width(), active.height()), (36, 36));
        assert_eq!(inactive.rgba().len(), 36 * 36 * 4);
        assert_eq!(active.rgba().len(), 36 * 36 * 4);
        for icon in [&inactive, &active] {
            assert!(
                icon.rgba()
                    .chunks_exact(4)
                    .all(|pixel| pixel[..3] == [0, 0, 0])
            );
            assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
        }
        assert_eq!(
            inactive
                .rgba()
                .chunks_exact(4)
                .map(|pixel| pixel[3] > 0)
                .collect::<Vec<_>>(),
            active
                .rgba()
                .chunks_exact(4)
                .map(|pixel| pixel[3] > 0)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            active.rgba().chunks_exact(4).map(|pixel| pixel[3]).max(),
            Some(255)
        );
        assert_eq!(
            inactive.rgba().chunks_exact(4).map(|pixel| pixel[3]).max(),
            Some(115)
        );
    }

    #[test]
    fn status_bar_icon_activity_uses_only_authoritative_capture_state() {
        let core = running_core_status();
        let mut status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Native);
        let mut activation = ProfileActivationSnapshot::unavailable();
        activation.phase = ProfileActivationPhase::Pending;
        assert!(!StatusBarModel::new(&status, &activation, false).icon_active);

        status.runtime.system_proxy_enabled = true;
        assert!(StatusBarModel::new(&status, &activation, false).icon_active);

        status.runtime.system_proxy_enabled = false;
        status.runtime.tun_enabled = true;
        assert!(StatusBarModel::new(&status, &activation, false).icon_active);

        status.runtime.tun_enabled = false;
        assert!(!StatusBarModel::new(&status, &activation, false).icon_active);
    }
}
