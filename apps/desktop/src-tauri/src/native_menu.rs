use tauri::{
    Emitter,
    menu::{MenuItemBuilder, MenuItemKind, PredefinedMenuItem},
};

use crate::status_bar::show_main_window;

const FIND_MENU_ID: &str = "application.find";
const QUIT_MENU_ID: &str = "application.quit";
const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";
const SETTINGS_MENU_ID: &str = "application.settings";

pub(crate) fn install<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let items = menu.items()?;
    let app_name = app.package_info().name.as_str();
    let app_menu = find_submenu(&items, app_name);
    let edit_menu = find_submenu(&items, "Edit");

    if let Some(app_menu) = app_menu {
        replace_native_quit(app, &app_menu, app_name)?;
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
    if is_graceful_exit_menu_command(event.id().as_ref()) {
        crate::request_graceful_exit(app);
        return;
    }
    match event.id().as_ref() {
        SETTINGS_MENU_ID => show_main_window(app, Some("/settings")),
        FIND_MENU_ID => {
            show_main_window(app, None);
            let _ = app.emit_to("main", "mish:focus-search", ());
        }
        _ => {}
    }
}

fn is_graceful_exit_menu_command(id: &str) -> bool {
    id == QUIT_MENU_ID || crate::status_bar::is_quit_menu_command(id)
}

fn replace_native_quit<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
    app_menu: &tauri::menu::Submenu<R>,
    app_name: &str,
) -> tauri::Result<()> {
    let items = app_menu.items()?;
    let quit_position = items.iter().rposition(|item| {
        item.as_predefined_menuitem()
            .and_then(|item| item.text().ok())
            .is_some_and(|text| is_native_quit_label(&text))
    });
    let Some(quit_position) = quit_position else {
        return Err(std::io::Error::other("native Quit menu item is unavailable").into());
    };
    app_menu.remove_at(quit_position)?;
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, format!("Quit {app_name}"))
        .accelerator(QUIT_ACCELERATOR)
        .build(manager)?;
    app_menu.insert(&quit, quit_position)
}

fn is_native_quit_label(label: &str) -> bool {
    label
        .strip_prefix("Quit ")
        .is_some_and(|name| !name.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_quit_is_a_mish_owned_command_with_command_q() {
        assert_eq!(QUIT_MENU_ID, "application.quit");
        assert_eq!(QUIT_ACCELERATOR, "CmdOrCtrl+Q");
        assert!(is_graceful_exit_menu_command("application.quit"));
        assert!(is_graceful_exit_menu_command("status-bar.quit"));
        assert!(!is_graceful_exit_menu_command("terminate:"));
        assert!(is_native_quit_label("Quit Mish"));
        assert!(is_native_quit_label("Quit mish-desktop"));
        assert!(!is_native_quit_label("Hide Mish"));
        assert!(!is_native_quit_label("Quit "));
    }
}
