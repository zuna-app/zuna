//! Every screen the window draws, from the state the stand-in fills: chats of each kind with
//! every kind of message, their panels, the overlays, settings and the server's settings.

use gpui::TestAppContext;
use serde_json::json;

use super::App;
use super::fixtures::*;
use crate::state::{Overlay, Panel, Phase, SharedKind, ToastKind};

fn open(cx: &mut TestAppContext, name: &str) -> App {
    let app = App::open(cx, &World::new(name));
    assert_eq!(cx.read(|cx| app.state.read(cx).phase.clone()), Phase::Ready);
    app
}

#[gpui::test]
fn boots_with_its_servers(cx: &mut TestAppContext) {
    let app = open(cx, "boots");
    cx.read(|cx| {
        let state = app.state.read(cx);
        assert_eq!(state.order.len(), 2, "both servers are listed");
        let server = state.servers.get(SERVER).expect("the first server loaded");
        assert_eq!(server.conversations.len(), 5);
        assert_eq!(server.channels.len(), 3);
        assert!(server.is_admin());
        assert!(server.unread() > 0);
    });
}

#[gpui::test]
fn draws_each_chat_with_every_kind_of_message(cx: &mut TestAppContext) {
    let app = open(cx, "chats");
    app.update(cx, |state, cx| state.select_server(SERVER, cx));
    for key in [format!("user:{BOB}"), format!("group:{GROUP}"), format!("user:{BOT}"), format!("user:{ME}"), format!("user:{CAROL}"), format!("group:{GENERAL}")] {
        app.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx));
        cx.read(|cx| assert_eq!(app.state.read(cx).servers[SERVER].active_key.as_deref(), Some(key.as_str())));
    }
    // A voice channel opens its stage rather than a chat.
    app.update(cx, |state, cx| state.select_conversation(Some(format!("group:{LOUNGE}")), cx));
    app.update(cx, |state, cx| state.select_conversation(None, cx));
}

#[gpui::test]
fn draws_a_chats_panels(cx: &mut TestAppContext) {
    let app = open(cx, "panels");
    app.update(cx, |state, cx| {
        state.select_server(SERVER, cx);
        state.select_conversation(Some(format!("user:{BOB}")), cx);
    });
    for panel in [Panel::Info, Panel::Search, Panel::Pins, Panel::Media(SharedKind::Photo), Panel::Media(SharedKind::Video), Panel::Media(SharedKind::File), Panel::Media(SharedKind::Audio), Panel::Media(SharedKind::Link), Panel::Media(SharedKind::Voice), Panel::Media(SharedKind::Groups)] {
        app.update(cx, |state, cx| state.toggle_panel(panel, cx));
        app.update(cx, |state, cx| state.toggle_panel(panel, cx));
    }
    // The group's details, with its members and their roles.
    app.update(cx, |state, cx| {
        state.select_conversation(Some(format!("group:{GROUP}")), cx);
        state.toggle_panel(Panel::Info, cx);
    });
}

#[gpui::test]
fn draws_every_overlay(cx: &mut TestAppContext) {
    let app = open(cx, "overlays");
    app.update(cx, |state, cx| {
        state.select_server(SERVER, cx);
        state.select_conversation(Some(format!("group:{GROUP}")), cx);
    });
    let overlays = vec![
        Overlay::AddServer { link: None, sign_in_url: None },
        Overlay::AddServer { link: Some("https://server-3.example/invite/abc#k=x".into()), sign_in_url: None },
        Overlay::Settings { section: None },
        Overlay::NewGroup,
        Overlay::Invite,
        Overlay::Verify { user_id: BOB.into() },
        Overlay::LeaveServer,
        Overlay::Forward { server_id: SERVER.into(), group_id: DM.into(), ids: vec!["m01".into()] },
        Overlay::AddMembers { group_id: GROUP.into() },
        Overlay::ShareLocation { conversation_key: format!("user:{BOB}") },
        Overlay::ServerSettings { section: None },
        Overlay::Channel { channel_id: None, category: Some("Talk".into()) },
        Overlay::Channel { channel_id: Some(LOUNGE.into()), category: None },
        Overlay::InstallUpdate,
        Overlay::WatchConsent { then_link: true },
        Overlay::WatchLink,
        Overlay::ScreenPicker,
    ];
    for overlay in overlays {
        app.update(cx, |state, cx| state.set_overlay(Some(overlay.clone()), cx));
        app.update(cx, |state, cx| state.set_overlay(None, cx));
    }
}

#[gpui::test]
fn draws_toasts_and_what_the_core_says(cx: &mut TestAppContext) {
    let app = open(cx, "toasts");
    app.update(cx, |state, cx| {
        state.select_server(SERVER, cx);
        state.toast("Something to know", ToastKind::Info, cx);
        state.toast("Something went wrong", ToastKind::Error, cx);
        state.toast("Someone's keys changed", ToastKind::Security, cx);
    });
    for event in [
        json!({ "type": "connection", "serverId": SERVER, "state": "connecting" }),
        json!({ "type": "connection", "serverId": SERVER, "state": "online" }),
        json!({ "type": "conversations", "serverId": SERVER }),
        json!({ "type": "channels", "serverId": SERVER }),
        json!({ "type": "users", "serverId": SERVER }),
        json!({ "type": "message", "serverId": SERVER, "message": message("m99", DM, 30.0, BOB, "A new one", json!({})) }),
        json!({ "type": "message_removed", "serverId": SERVER, "groupId": DM, "id": "m99" }),
        json!({ "type": "read", "serverId": SERVER, "groupId": DM, "userId": BOB, "seq": 16 }),
        json!({ "type": "presence", "serverId": SERVER, "userId": BOB, "online": false }),
        json!({ "type": "typing", "serverId": SERVER, "groupId": DM, "userId": BOB }),
        json!({ "type": "settings", "serverId": SERVER }),
        json!({ "type": "emotes", "serverId": SERVER }),
        json!({ "type": "sounds", "serverId": SERVER }),
        json!({ "type": "calls", "serverId": SERVER }),
        json!({ "type": "preferences", "serverId": SERVER }),
        json!({ "type": "voice", "serverId": SERVER }),
        json!({ "type": "security", "serverId": SERVER, "userId": CAROL, "message": "Carol's keys changed." }),
        json!({ "type": "new_devices", "serverId": SERVER }),
        json!({ "type": "signed_out", "serverId": OTHER, "reason": "banned" }),
    ] {
        app.event(cx, event);
    }
}

#[gpui::test]
fn draws_every_section_of_settings_and_of_a_servers(cx: &mut TestAppContext) {
    let app = open(cx, "settings");
    app.update(cx, |state, cx| state.select_server(SERVER, cx));
    for section in ["profile", "privacy", "notifications", "voice", "screen", "appearance", "security", "about"] {
        app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Settings { section: Some(section.into()) }), cx));
    }
    app.update(cx, |state, cx| state.set_overlay(None, cx));
    for section in ["overview", "invites", "members", "reports", "bans", "emotes", "soundboard", "storage", "screen", "bots", "leave", "delete"] {
        app.update(cx, |state, cx| state.set_overlay(Some(Overlay::ServerSettings { section: Some(section.into()) }), cx));
    }
    app.update(cx, |state, cx| state.set_overlay(None, cx));
}

#[gpui::test]
fn draws_onboarding_without_a_server(cx: &mut TestAppContext) {
    let mut world = World::new("onboarding");
    world.client.insert("listServers".into(), json!([]));
    let app = App::open(cx, &world);
    cx.read(|cx| assert!(app.state.read(cx).servers.is_empty()));
    app.update(cx, |state, cx| state.set_overlay(Some(Overlay::AddServer { link: Some("https://server-9.example/invite/xyz#k=abc".into()), sign_in_url: None }), cx));
}

#[gpui::test]
fn draws_a_core_that_wont_start(cx: &mut TestAppContext) {
    let mut world = World::new("failed");
    world.client.remove("listServers");
    let app = App::open(cx, &world);
    cx.read(|cx| assert!(matches!(app.state.read(cx).phase, Phase::Failed(_))));
}
