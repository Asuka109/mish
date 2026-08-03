use std::sync::Arc;

use mish_native_i18n::{NativeMessage, translate};
use mish_presentation_contract::{Locale, NativeActionId};
use mish_settings::{LanguagePreference, SettingsAdapterKind, SettingsService};
use tauri::menu::{MenuItemBuilder, MenuItemKind, PredefinedMenuItem};

use crate::status_bar::show_main_window;

const FIND_MENU_ID: &str = NativeActionId::ApplicationFind.as_str();
const QUIT_MENU_ID: &str = NativeActionId::ApplicationQuit.as_str();
pub(crate) const APPLICATION_MENU_ACCELERATORS: &[(&str, &str)] = &[
    ("application.find", "CmdOrCtrl+F"),
    ("application.quit", "CmdOrCtrl+Q"),
    ("application.settings", "CmdOrCtrl+,"),
];
const QUIT_ACCELERATOR: &str = APPLICATION_MENU_ACCELERATORS[1].1;
const SETTINGS_MENU_ID: &str = NativeActionId::ApplicationSettings.as_str();

struct ApplicationMenuItems<R: tauri::Runtime> {
    find: tauri::menu::MenuItem<R>,
    settings: tauri::menu::MenuItem<R>,
    quit: tauri::menu::MenuItem<R>,
}

impl<R: tauri::Runtime> Clone for ApplicationMenuItems<R> {
    fn clone(&self) -> Self {
        Self {
            find: self.find.clone(),
            settings: self.settings.clone(),
            quit: self.quit.clone(),
        }
    }
}

pub(crate) fn install<R: tauri::Runtime>(
    app: &tauri::App<R>,
    settings_service: Arc<SettingsService>,
) -> tauri::Result<()> {
    // Attach before the initial read: updates published while the menu is constructed remain queued.
    let (mut updates, initial) = settings_service.subscribe_with_snapshot(SettingsAdapterKind::Rpc);
    let mut current_revision = initial.revision;
    let items = install_for_locale(app, locale(initial.preferences.language))?;
    let app_handle = app.handle().clone();
    let settings = settings_service.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let snapshot = match updates.recv().await {
                Ok(snapshot) => snapshot,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    settings.snapshot(SettingsAdapterKind::Rpc)
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if snapshot.revision <= current_revision {
                continue;
            }
            current_revision = snapshot.revision;
            let locale = locale(snapshot.preferences.language);
            let items = items.clone();
            let _ = app_handle.run_on_main_thread(move || apply_locale(&items, locale));
        }
    });
    Ok(())
}

pub(crate) fn install_demo<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let _ = install_for_locale(app, Locale::En)?;
    Ok(())
}

fn install_for_locale<R: tauri::Runtime>(
    app: &tauri::App<R>,
    locale: Locale,
) -> tauri::Result<ApplicationMenuItems<R>> {
    let Some(menu) = app.menu() else {
        return Err(std::io::Error::other("native application menu is unavailable").into());
    };
    let items = menu.items()?;
    let app_name = app.package_info().name.as_str();
    let app_menu = find_submenu(&items, app_name)
        .ok_or_else(|| std::io::Error::other("native application menu is unavailable"))?;
    let edit_menu = find_submenu(&items, "Edit")
        .ok_or_else(|| std::io::Error::other("native Edit menu is unavailable"))?;
    let quit = replace_native_quit(app, &app_menu, locale)?;
    let settings = MenuItemBuilder::with_id(
        SETTINGS_MENU_ID,
        tr(locale, NativeMessage::ApplicationSettings),
    )
    .accelerator(APPLICATION_MENU_ACCELERATORS[2].1)
    .build(app)?;
    let app_separator = PredefinedMenuItem::separator(app)?;
    app_menu.insert_items(&[&settings, &app_separator], 2)?;
    let edit_separator = PredefinedMenuItem::separator(app)?;
    let find = MenuItemBuilder::with_id(FIND_MENU_ID, tr(locale, NativeMessage::ApplicationFind))
        .accelerator(APPLICATION_MENU_ACCELERATORS[0].1)
        .build(app)?;
    edit_menu.append_items(&[&edit_separator, &find])?;
    Ok(ApplicationMenuItems {
        find,
        settings,
        quit,
    })
}

pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if is_graceful_exit_menu_command(event.id().as_ref()) {
        crate::request_graceful_exit(app);
        return;
    }
    match event.id().as_ref() {
        SETTINGS_MENU_ID => show_main_window(app, Some("/settings")),
        FIND_MENU_ID => {
            crate::show_main_window_with_intent(app, None, true);
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
    locale: Locale,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
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
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, tr(locale, NativeMessage::ApplicationQuit))
        .accelerator(QUIT_ACCELERATOR)
        .build(manager)?;
    app_menu.insert(&quit, quit_position)?;
    Ok(quit)
}

fn locale(language: LanguagePreference) -> Locale {
    match language {
        LanguagePreference::En => Locale::En,
        LanguagePreference::Zh => Locale::ZhCn,
    }
}
fn tr(locale: Locale, message: NativeMessage<'_>) -> String {
    translate(locale, message)
}
fn apply_locale<R: tauri::Runtime>(items: &ApplicationMenuItems<R>, locale: Locale) {
    let _ = items
        .settings
        .set_text(tr(locale, NativeMessage::ApplicationSettings));
    let _ = items
        .find
        .set_text(tr(locale, NativeMessage::ApplicationFind));
    let _ = items
        .quit
        .set_text(tr(locale, NativeMessage::ApplicationQuit));
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

    #[test]
    fn application_menu_accelerators_have_stable_unique_commands() {
        let mut ids = std::collections::HashSet::new();
        let mut accelerators = std::collections::HashSet::new();
        for (id, accelerator) in APPLICATION_MENU_ACCELERATORS {
            assert!(ids.insert(*id), "duplicate application menu ID: {id}");
            assert!(
                accelerators.insert(*accelerator),
                "duplicate application accelerator: {accelerator}"
            );
        }
    }

    #[test]
    fn application_menu_copy_is_complete_in_both_native_locales() {
        assert_eq!(
            tr(Locale::En, NativeMessage::ApplicationSettings),
            "Settings…"
        );
        assert_eq!(
            tr(Locale::ZhCn, NativeMessage::ApplicationSettings),
            "设置…"
        );
        assert_eq!(tr(Locale::En, NativeMessage::ApplicationFind), "Find…");
        assert_eq!(tr(Locale::ZhCn, NativeMessage::ApplicationFind), "查找…");
        assert_eq!(tr(Locale::En, NativeMessage::ApplicationQuit), "Quit Mish");
        assert_eq!(
            tr(Locale::ZhCn, NativeMessage::ApplicationQuit),
            "退出 Mish"
        );
    }
}
