//! A chat's details beside it, used as a person uses them: someone's chat, with their report
//! and its disappearing messages; a group, renamed, its people and what can be done to each,
//! its history, leaving and deleting it; and a channel, edited and muted.

use gpui::TestAppContext;
use serde_json::{Value, json};

use super::*;
use crate::state::Panel;
use crate::testing::fixtures::*;
use crate::testing::{App as Running, World};

/// The app on a chat with its details open, with nothing ringing to cover the window's top.
fn open(cx: &mut TestAppContext, name: &str, key: &str, change: impl FnOnce(&mut World)) -> Running {
    let mut world = World::new(name);
    world.server["getCalls"] = json!([]);
    change(&mut world);
    let app = Running::open(cx, &world);
    for method in ["updateGroupMeta", "removeMember", "setBlocked", "reportUser", "setDisappearing", "leaveGroup", "deleteGroup", "setHistoryVisible", "mute", "unmute", "setGroupRole"] {
        app.answer(method, |_| Ok(Value::Null));
    }
    app.update(cx, |state, cx| {
        state.settings.reduce_motion = true;
        state.select_server(SERVER, cx);
        state.select_conversation(Some(key.to_string()), cx);
    });
    app.update(cx, |state, cx| state.toggle_panel(Panel::Info, cx));
    app
}

/// Picks an entry of the menu just opened, by its place among the entries, as a click on it does.
fn pick(app: &Running, cx: &mut TestAppContext, entry: usize) {
    let label = cx.read(|cx| crate::ui::menu::open_labels(cx)).get(entry).cloned().expect("a menu is open with that many entries");
    assert!(app.window.update(cx, |_, window, cx| crate::ui::menu::choose(&label, window, cx)).unwrap());
    app.run(cx);
}

/// Scrolls the details down, over where `near` is, so what's at their end is in the window.
fn scroll_to_end(app: &Running, cx: &mut TestAppContext, near: &'static str) {
    let mut window = gpui::VisualTestContext::from_window(app.window.into(), cx);
    let at = window.debug_bounds(near).expect("drawn").center();
    let position = gpui::point(at.x, gpui::px(600.));
    window.simulate_event(gpui::ScrollEvent { position, delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(-2000.))), modifiers: gpui::Modifiers::none(), touch_phase: gpui::TouchPhase::Moved, source: gpui::ScrollSource::Pointer });
    app.run(cx);
}

fn panel(app: &Running, cx: &mut TestAppContext) -> Entity<SidePanel> {
    let chat = app.window.update(cx, |root, _, _| root.open_chat()).unwrap().expect("a chat is open");
    cx.read(|cx| chat.read(cx).side_panel()).expect("the details are open")
}

#[gpui::test]
fn someones_chat_reports_them_and_times_its_messages(cx: &mut TestAppContext) {
    let app = open(cx, "panel-dm", &format!("user:{BOB}"), |_| {});
    // Notifications: muted for a while from the switch.
    app.click(cx, "notifications");
    pick(&app, cx, 0);
    assert_eq!(app.calls_of("mute")[0][0], json!(format!("user:{BOB}")));
    // Disappearing messages, from a menu of how long.
    app.click(cx, "disappearing");
    pick(&app, cx, 2);
    assert_eq!(app.calls_of("setDisappearing"), vec![vec![json!(DM), json!(86400.0)]]);
    // A report, for a reason the menu gives, said to have gone.
    app.click(cx, "report");
    pick(&app, cx, 0);
    assert_eq!(app.calls_of("reportUser")[0][0], json!(BOB));
    assert!(app.toasts(cx).contains(&"Reported to the server's admins".to_string()));
}

#[gpui::test]
fn a_group_is_renamed_and_its_people_managed(cx: &mut TestAppContext) {
    let group = format!("group:{GROUP}");
    let app = open(cx, "panel-group", &group, |world| {
        world.server["getConversations"][1]["muted"] = json!(false);
    });
    // Renamed from its card, or not.
    app.click(cx, "edit-group");
    let view = panel(&app, cx);
    let (name, description) = cx.read(|cx| (view.read(cx).edit_name.clone(), view.read(cx).edit_description.clone()));
    assert_eq!(cx.read(|cx| name.read(cx).text().to_string()), "The lab");
    app.click(cx, "cancel-edit");
    assert!(app.calls_of("updateGroupMeta").is_empty());
    app.click(cx, "edit-group");
    name.update(cx, |input, cx| input.set_text("  ", cx));
    description.update(cx, |input, cx| input.set_text("Where we build", cx));
    app.run(cx);
    app.click(cx, "save-edit");
    assert_eq!(app.calls_of("updateGroupMeta"), vec![vec![json!(GROUP), json!({ "name": "The lab", "description": "Where we build" })]], "an emptied name keeps the one it had");
    // Someone in it, from their row: what an admin can do to them.
    app.click(cx, &format!("member-{CAROL}"));
    let entries: Vec<String> = cx.read(|cx| crate::ui::menu::open_labels(cx));
    assert!(entries.iter().any(|entry| entry == "Remove from group"), "{entries:?}");
    let remove = entries.iter().position(|entry| entry == "Remove from group").unwrap();
    pick(&app, cx, remove);
    assert_eq!(app.calls_of("removeMember"), vec![vec![json!(GROUP), json!(CAROL)]]);
    app.click(cx, &format!("member-{BOB}"));
    let entries: Vec<String> = cx.read(|cx| crate::ui::menu::open_labels(cx));
    let block = entries.iter().position(|entry| entry == "Block").unwrap();
    pick(&app, cx, block);
    assert_eq!(app.calls_of("setBlocked"), vec![vec![json!(BOB), json!(true)]]);
    app.click(cx, &format!("member-{BOB}"));
    pick(&app, cx, 0);
    assert_eq!(app.read(cx, |state| state.servers[SERVER].active_key.clone()), Some(format!("user:{BOB}")), "Message opens their chat");
    // Leaving and deleting it.
    app.update(cx, |state, cx| state.select_conversation(Some(group.clone()), cx));
    app.update(cx, |state, cx| state.toggle_panel(Panel::Info, cx));
    scroll_to_end(&app, cx, "leave-group");
    app.click(cx, "delete-group");
    assert_eq!(app.calls_of("deleteGroup"), vec![vec![json!(GROUP)]]);
    app.update(cx, |state, cx| state.select_conversation(Some(group.clone()), cx));
    app.update(cx, |state, cx| state.toggle_panel(Panel::Info, cx));
    scroll_to_end(&app, cx, "leave-group");
    app.click(cx, "leave-group");
    assert_eq!(app.calls_of("leaveGroup"), vec![vec![json!(GROUP)]]);
    assert_eq!(app.read(cx, |state| state.servers[SERVER].active_key.clone()), None);
}

#[gpui::test]
fn a_channels_details_edit_and_mute_it(cx: &mut TestAppContext) {
    let app = open(cx, "panel-channel", &format!("group:{GENERAL}"), |_| {});
    app.click(cx, "channel-mute");
    pick(&app, cx, 4);
    assert_eq!(app.calls_of("mute"), vec![vec![json!(format!("group:{GENERAL}"))]], "until unmuted");
    app.click(cx, "edit-channel");
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(crate::state::Overlay::Channel { channel_id: Some(GENERAL.into()), category: None }));
    // A muted one is unmuted at once.
    let app = open(cx, "panel-channel-muted", &format!("group:{GENERAL}"), |world| {
        world.server["getChannels"][0]["conversation"]["muted"] = json!(true);
    });
    app.click(cx, "channel-mute");
    assert_eq!(app.calls_of("unmute"), vec![vec![json!(format!("group:{GENERAL}"))]]);
}
