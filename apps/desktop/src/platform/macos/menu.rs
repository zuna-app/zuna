//! The menu bar, as the Electron app's was on macOS (its `appMenu`, `editMenu` and
//! `windowMenu`): the app's menu, Edit, as the text field's own actions, and Window. Their
//! keys are bound here too, which is what the menus show beside each item.

use gpui::{App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, actions};

use crate::ui::text_input::{Copy, Cut, Paste, SelectAll};

actions!(zuna_menu, [About, OpenSettings, Hide, HideOthers, ShowAll, Minimize, Zoom, CloseWindow]);

pub fn set_menus(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
    ]);
    cx.on_action(|_: &About, cx| open_settings(Some("about"), cx));
    cx.on_action(|_: &OpenSettings, cx| open_settings(None, cx));
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    // Once the action is through: it's handled inside the window, which can't be reached
    // again until then.
    cx.on_action(|_: &Minimize, cx| {
        cx.defer(|cx| {
            if let Some(window) = cx.active_window() {
                window.update(cx, |_, window, _| window.minimize_window()).ok();
            }
        })
    });
    cx.on_action(|_: &Zoom, cx| {
        cx.defer(|cx| {
            if let Some(window) = cx.active_window() {
                window.update(cx, |_, window, _| window.zoom_window()).ok();
            }
        })
    });
    // As the red button does: out of sight, with the app still running.
    cx.on_action(|_: &CloseWindow, cx| crate::platform::later(cx, super::hide_main));

    cx.set_menus([
        Menu {
            name: "Zuna".into(),
            items: vec![
                MenuItem::action("About Zuna", About),
                MenuItem::separator(),
                MenuItem::action("Settings…", OpenSettings),
                MenuItem::separator(),
                MenuItem::os_submenu("Services", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action("Hide Zuna", Hide),
                MenuItem::action("Hide Others", HideOthers),
                MenuItem::action("Show All", ShowAll),
                MenuItem::separator(),
                MenuItem::action("Quit Zuna", crate::Quit),
            ],
            disabled: false,
        },
        Menu {
            name: "Edit".into(),
            items: vec![
                MenuItem::os_action("Cut", Cut, OsAction::Cut),
                MenuItem::os_action("Copy", Copy, OsAction::Copy),
                MenuItem::os_action("Paste", Paste, OsAction::Paste),
                MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
            ],
            disabled: false,
        },
        Menu {
            name: "Window".into(),
            items: vec![MenuItem::action("Minimize", Minimize), MenuItem::action("Zoom", Zoom), MenuItem::separator(), MenuItem::action("Close", CloseWindow)],
            disabled: false,
        },
    ]);
}

/// Settings, at a section or where it was left, once the app has started.
fn open_settings(section: Option<&str>, cx: &mut App) {
    super::show_main();
    let Some(store) = cx.try_global::<crate::state::Store>() else { return };
    let state = store.0.clone();
    let section = section.map(str::to_string);
    state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Settings { section }), cx));
}
