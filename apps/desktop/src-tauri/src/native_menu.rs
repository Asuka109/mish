use tauri::{
    Emitter,
    menu::{MenuItemBuilder, MenuItemKind, PredefinedMenuItem},
};

use crate::status_bar::show_main_window;

const FIND_MENU_ID: &str = "application.find";
const SETTINGS_MENU_ID: &str = "application.settings";

pub(crate) fn install(app: &tauri::App) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let items = menu.items()?;
    let app_name = app.package_info().name.as_str();
    let app_menu = find_submenu(&items, app_name);
    let edit_menu = find_submenu(&items, "Edit");

    if let Some(app_menu) = app_menu {
        let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "Settings…")
            .accelerator("CmdOrCtrl+,")
            .build(app)?;
        let separator = PredefinedMenuItem::separator(app)?;
        app_menu.insert_items(&[&settings, &separator], 2)?;
    }

    if let Some(edit_menu) = edit_menu {
        let separator = PredefinedMenuItem::separator(app)?;
        let find = MenuItemBuilder::with_id(FIND_MENU_ID, "Find…")
            .accelerator("CmdOrCtrl+F")
            .build(app)?;
        edit_menu.append_items(&[&separator, &find])?;
    }

    Ok(())
}

pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        SETTINGS_MENU_ID => show_main_window(app, Some("/settings")),
        FIND_MENU_ID => {
            show_main_window(app, None);
            let _ = app.emit_to("main", "mish:focus-search", ());
        }
        _ => {}
    }
}

fn find_submenu<R: tauri::Runtime>(
    items: &[MenuItemKind<R>],
    title: &str,
) -> Option<tauri::menu::Submenu<R>> {
    items.iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok().as_deref() == Some(title)).then(|| submenu.clone())
    })
}
