//! The list of chats, used as a person uses it: what each row says of its last message, a search
//! through chats and messages, its tabs, the chats hidden from it, the server's menu, and a row's
//! own menu.

use gpui::{Modifiers, MouseButton, MouseDownEvent, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

use super::*;
use crate::testing::fixtures::*;
use crate::testing::{App as Running, World};

fn list(app: &Running, cx: &mut TestAppContext) -> Entity<ConversationList> {
    app.window.update(cx, |root, _, _| root.conversations.clone()).unwrap()
}

fn open(cx: &mut TestAppContext, world: &World) -> Running {
    let app = Running::open(cx, world);
    for method in ["updatePreferences", "setMarkedUnread", "markChatRead", "mute", "unmute"] {
        app.answer(method, |_| Ok(Value::Null));
    }
    app.update(cx, |state, cx| {
        state.settings.reduce_motion = true;
        state.select_server(SERVER, cx);
    });
    app
}

fn message(extra: Value) -> MessageView {
    let mut value = json!({ "id": "x", "groupId": GROUP, "senderId": BOB, "createdAt": NOW, "status": "sent", "text": "" });
    if let (Some(into), Value::Object(extra)) = (value.as_object_mut(), extra) {
        into.extend(extra);
    }
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_rows_preview_says_what_its_last_message_was() {
    let mut users = std::collections::HashMap::new();
    users.insert(BOB.to_string(), UserView { id: BOB.into(), display_name: "Bob Builder".into(), ..Default::default() });
    let preview = |extra: Value, kind: &str| preview_for(Some(&message(extra)), &users, ME, kind);
    let file = |extra: Value| {
        let mut attachment = json!({ "fileId": "f", "name": "notes.pdf", "mime": "application/pdf", "size": 1 });
        attachment.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        json!({ "attachments": [attachment] })
    };
    assert_eq!(preview_for(None, &users, ME, "dm"), "");
    assert_eq!(preview(json!({ "system": { "type": "timer_changed", "seconds": 3600 } }), "group"), format!("Messages disappear after {}", crate::format::timer_text(3600.)));
    assert_eq!(preview(json!({ "system": { "type": "timer_changed", "seconds": 0 } }), "group"), "Disappearing messages turned off");
    assert_eq!(preview(json!({ "system": { "type": "member_added" } }), "group"), "Membership changed");
    assert_eq!(preview(json!({ "status": "undecryptable" }), "dm"), "Waiting for keys");
    assert_eq!(preview(json!({ "status": "unverified" }), "dm"), "A message that couldn't be displayed");
    assert_eq!(preview(json!({ "text": "**hi** there" }), "group"), "Bob: hi there", "a group's names whose it was, by first name");
    assert_eq!(preview(json!({ "text": "hi", "senderId": ME }), "dm"), "You: hi");
    assert_eq!(preview(json!({ "location": { "lat": 1, "lon": 2 } }), "dm"), "Location");
    for (extra, said) in [(json!({ "voice": true }), "Voice message"), (json!({ "round": true }), "Video message"), (json!({ "sticker": true }), "Sticker"), (json!({ "mime": "image/png" }), "Photo"), (json!({ "mime": "video/mp4" }), "Video"), (json!({}), "notes.pdf")] {
        assert_eq!(preview(file(extra), "dm"), said);
    }
    assert_eq!(preview(json!({}), "dm"), "");
}

#[gpui::test]
fn chats_and_messages_are_searched_from_the_list(cx: &mut TestAppContext) {
    let app = open(cx, &World::new("conversation-search"));
    let view = list(&app, cx);
    let search = cx.read(|cx| view.read(cx).search.clone());
    // One letter searches nothing yet.
    search.update(cx, |input, cx| input.set_text("S", cx));
    app.run(cx);
    assert!(app.calls_of("search").is_empty());
    search.update(cx, |input, cx| input.set_text("See", cx));
    app.run(cx);
    assert_eq!(app.calls_of("search")[0][0], json!("See"));
    assert!(app.drawn(cx, "hit-m01"), "the message found, under the chats");
    app.click(cx, "hit-m01");
    assert_eq!(app.read(cx, |state| state.servers[SERVER].active_key.clone()), Some(format!("user:{BOB}")));
    // Nothing found says so.
    app.answer("search", |_| Ok(json!([])));
    search.update(cx, |input, cx| input.set_text("nothing at all like it", cx));
    app.run(cx);
    assert!(cx.read(|cx| view.read(cx).hits.is_empty()));
    // Escape empties it, and another server's list starts with none.
    search.update(cx, |_, cx| cx.emit(InputEvent::Escape));
    app.run(cx);
    assert_eq!(cx.read(|cx| search.read(cx).text().to_string()), "");
    search.update(cx, |input, cx| input.set_text("See", cx));
    app.update(cx, |state, cx| state.select_server(OTHER, cx));
    assert_eq!(cx.read(|cx| search.read(cx).text().to_string()), "", "a search belongs to its server");
}

#[gpui::test]
fn the_tabs_and_the_hidden_chats(cx: &mut TestAppContext) {
    let mut world = World::new("conversation-tabs");
    world.server["getPreferences"]["hidden"] = json!([format!("user:{BOT}")]);
    world.server["getConversations"][2]["hidden"] = json!(true);
    let app = open(cx, &world);
    let view = list(&app, cx);
    for (tab, filter) in [("Groups", Filter::Groups), ("Unread", Filter::Unread), ("People", Filter::People), ("Bots", Filter::Bots), ("Channels", Filter::Channels), ("All", Filter::All)] {
        app.click(cx, tab);
        assert!(cx.read(|cx| view.read(cx).filter == filter), "{tab}");
    }
    // The chats hidden from the list, behind their own line.
    assert!(app.drawn(cx, "hidden-toggle") && !app.drawn(cx, &format!("conv-user:{BOT}")));
    app.click(cx, "hidden-toggle");
    assert!(app.drawn(cx, &format!("conv-user:{BOT}")));
    app.click(cx, "hidden-toggle");
    // A tab with nothing in it says so, and offers what would fill it.
    let mut empty = World::new("conversation-empty");
    empty.server["getConversations"] = json!([]);
    let app = open(cx, &empty);
    app.click(cx, "Groups");
    app.click(cx, "empty-action");
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::NewGroup));
    app.update(cx, |state, cx| state.set_overlay(None, cx));
    app.click(cx, "All");
    app.click(cx, "empty-action");
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::Invite));
}

#[gpui::test]
fn the_servers_menu_and_a_rows_own(cx: &mut TestAppContext) {
    // No call ringing, whose card would cover the list's top.
    let mut world = World::new("conversation-menus");
    world.server["getCalls"] = json!([]);
    let app = open(cx, &world);
    // The server's menu, from its name.
    for (entry, overlay) in [(0, Overlay::Invite), (1, Overlay::NewGroup), (2, Overlay::ServerSettings { section: None }), (4, Overlay::LeaveServer)] {
        app.click(cx, "server-title");
        app.click(cx, &format!("menu-item-{entry}"));
        assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(overlay));
        app.update(cx, |state, cx| state.set_overlay(None, cx));
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    // A row's menu, from a right click.
    let bob = format!("user:{BOB}");
    let bounds = VisualTestContext::from_window(app.window.into(), cx).debug_bounds(Box::leak(format!("conv-{bob}").into_boxed_str())).unwrap();
    VisualTestContext::from_window(app.window.into(), cx).simulate_event(MouseDownEvent { position: bounds.center(), modifiers: Modifiers::none(), button: MouseButton::Right, click_count: 1, first_mouse: false });
    app.run(cx);
    assert!(app.drawn(cx, "menu-item-0"));
    app.click(cx, "menu-item-0");
    assert_eq!(app.calls_of("updatePreferences").last().unwrap(), &vec![json!({ "pinned": [] })], "Bob's chat was pinned, so it's unpinned");

    // Each entry, as each kind of chat has them.
    let state = app.state.clone();
    let entries = |cx: &mut TestAppContext, key: &str, telegram: bool, own: bool| {
        cx.read(|cx| {
            let state_ref = state.read(cx);
            let server = &state_ref.servers[SERVER];
            rows::row_entries(server.find_conversation(key).unwrap(), &server.prefs, telegram, own, state.clone())
        })
    };
    let run = |cx: &mut TestAppContext, entry: &crate::ui::menu::MenuEntry| {
        let action = entry.action.clone().expect("it does something");
        app.window.update(cx, |_, window, cx| action(window, cx)).unwrap();
        app.run(cx);
    };
    let labels = |entries: &[crate::ui::menu::MenuEntry]| entries.iter().map(|entry| entry.label.clone()).collect::<Vec<_>>();
    let group = format!("group:{GROUP}");
    let dm = entries(cx, &bob, false, false);
    assert_eq!(labels(&dm), ["Unpin", "Mark as read", "Mute", "Hide from list"]);
    run(cx, &dm[1]);
    assert_eq!(app.calls_of("markChatRead"), vec![vec![json!(bob)]]);
    for entry in dm[2].submenu.as_ref().unwrap() {
        run(cx, entry);
    }
    assert_eq!(app.calls_of("mute").len(), 5);
    assert_eq!(app.calls_of("mute")[4], vec![json!(bob)], "until unmuted");
    run(cx, &dm[3]);
    assert_eq!(app.calls_of("updatePreferences").last().unwrap(), &vec![json!({ "hidden": [bob] })]);
    let muted = entries(cx, &group, false, false);
    assert_eq!(labels(&muted), ["Pin to top", "Mark as unread", "Unmute", "Hide from list"]);
    run(cx, &muted[2]);
    assert_eq!(app.calls_of("unmute"), vec![vec![json!(group)]]);
    let read = entries(cx, &format!("user:{BOT}"), false, false);
    assert_eq!(read[1].label, "Mark as unread");
    run(cx, &read[1]);
    assert_eq!(app.calls_of("setMarkedUnread"), vec![vec![json!(format!("user:{BOT}")), json!(true)]]);
    // On Telegram, hiding a chat archives it, and its saved messages can't be.
    assert_eq!(labels(&entries(cx, &format!("user:{BOT}"), true, false)).last().unwrap(), "Archive");
    assert_eq!(labels(&entries(cx, &format!("user:{ME}"), true, true)), ["Pin to top", "Mark as unread", "Mute"]);
}

#[gpui::test]
fn the_channels_fold_open_and_move(cx: &mut TestAppContext) {
    let mut world = World::new("channel-list");
    world.server["getCalls"] = json!([]);
    world.server["getChannels"][0]["conversation"]["unreadMentions"] = json!(120);
    world.server["getChannels"].as_array_mut().unwrap().push(json!({ "id": "c-misc", "type": "text", "key": "group:c-misc", "name": "misc", "position": 3,
        "conversation": { "key": "group:c-misc", "kind": "channel", "groupId": "c-misc", "title": "misc", "ready": true, "lastActivityAt": NOW, "ownRead": 0, "muted": true } }));
    let app = open(cx, &world);
    for method in ["reorderChannels", "deleteChannel"] {
        app.answer(method, |_| Ok(Value::Null));
    }
    let view = list(&app, cx);
    // Folded, a heading keeps showing what mentions this person, and a channel with no heading of its own goes under its type's.
    assert!(app.drawn(cx, "section-title-Text channels") && app.drawn(cx, "channel-c-misc"));
    app.click(cx, "section-title-Talk");
    assert_eq!(app.read(cx, |state| state.settings.collapsed_categories.clone()), ["Talk"]);
    assert!(app.drawn(cx, &format!("channel-{GENERAL}")) && !app.drawn(cx, "channel-c-news"));
    app.click(cx, "section-title-Talk");
    assert!(app.read(cx, |state| state.settings.collapsed_categories.is_empty()) && app.drawn(cx, "channel-c-news"));
    // One that can't be read doesn't open; one that can does, with its settings beside it for an admin.
    app.click(cx, "channel-c-news");
    assert_eq!(app.read(cx, |state| state.servers[SERVER].active_key.clone()), None);
    app.click(cx, &format!("channel-{GENERAL}"));
    assert_eq!(app.read(cx, |state| state.servers[SERVER].active_key.clone()), Some(format!("group:{GENERAL}")));
    app.click(cx, &format!("edit-{GENERAL}"));
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::Channel { channel_id: Some(GENERAL.into()), category: None }));
    app.update(cx, |state, cx| state.set_overlay(None, cx));
    std::thread::sleep(std::time::Duration::from_millis(200));

    // A right click's menu: muting, editing and deleting it, which asks first.
    let bounds = VisualTestContext::from_window(app.window.into(), cx).debug_bounds("channel-c-misc").unwrap();
    VisualTestContext::from_window(app.window.into(), cx).simulate_event(MouseDownEvent { position: bounds.center(), modifiers: Modifiers::none(), button: MouseButton::Right, click_count: 1, first_mouse: false });
    app.run(cx);
    assert_eq!(cx.read(|cx| crate::ui::menu::open_labels(cx)), ["Unmute", "Edit channel", "Delete channel"]);
    let menu = cx.read(|cx| {
        let state = app.state.read(cx);
        let server = &state.servers[SERVER];
        view.read(cx).channel_menu(server, server.channels.iter().find(|channel| channel.id == GENERAL).unwrap())
    });
    assert_eq!(menu[0].label, "Mute");
    let run = |cx: &mut TestAppContext, entry: &crate::ui::menu::MenuEntry| {
        let action = entry.action.clone().expect("it does something");
        app.window.update(cx, |_, window, cx| action(window, cx)).unwrap();
        app.run(cx);
    };
    let misc = cx.read(|cx| {
        let state = app.state.read(cx);
        let server = &state.servers[SERVER];
        view.read(cx).channel_menu(server, server.channels.iter().find(|channel| channel.id == "c-misc").unwrap())
    });
    run(cx, &misc[0]);
    assert_eq!(app.calls_of("unmute"), vec![vec![json!("group:c-misc")]]);
    run(cx, &misc[2]);
    cx.simulate_prompt_answer("Cancel");
    app.run(cx);
    assert!(app.calls_of("deleteChannel").is_empty());
    run(cx, &misc[2]);
    cx.simulate_prompt_answer("Delete");
    app.run(cx);
    assert_eq!(app.calls_of("deleteChannel"), vec![vec![json!("c-misc")]]);

    // Dragged within its heading, past the middle of where it goes; elsewhere it stays.
    let order: Vec<String> = [GENERAL, "c-news", LOUNGE, "c-misc"].iter().map(|id| id.to_string()).collect();
    let news = channels::ChannelDrag { id: "c-news".into(), name: "news".into(), section: "Talk".into() };
    view.update(cx, |list, cx| {
        list.drag_channel_over(&news, "c-misc", "Text channels", &order, -5., cx);
        list.drag_channel_over(&news, "c-news", "Talk", &order, -5., cx);
        list.drag_channel_over(&news, GENERAL, "Talk", &order, 5., cx);
    });
    assert_eq!(cx.read(|cx| view.read(cx).drag_order.clone()), None, "nothing moved yet");
    view.update(cx, |list, cx| list.drag_channel_over(&news, GENERAL, "Talk", &order, -5., cx));
    app.run(cx);
    view.update(cx, |list, cx| list.drop_channel(cx));
    app.run(cx);
    assert_eq!(app.calls_of("reorderChannels"), vec![vec![json!(["c-news", GENERAL, LOUNGE, "c-misc"])]]);
    assert_eq!(cx.read(|cx| view.read(cx).drag_order.clone()), None);
    // A refused order says why.
    app.answer("reorderChannels", |_| Err(crate::testing::refused("Not allowed")));
    view.update(cx, |list, cx| list.drag_channel_over(&news, GENERAL, "Talk", &order, -5., cx));
    view.update(cx, |list, cx| list.drop_channel(cx));
    app.run(cx);
    assert!(app.toasts(cx).contains(&"Not allowed".to_string()));
    // Let go with nothing moved, nothing's sent.
    view.update(cx, |list, cx| list.drop_channel(cx));
    app.run(cx);
    assert_eq!(app.calls_of("reorderChannels").len(), 2);
}
