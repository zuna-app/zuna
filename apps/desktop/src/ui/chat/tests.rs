//! The chat, used as a person uses it: typed into, with ":" and "@" and "/" suggesting, links
//! previewed, sent, answered, edited in the box and in place, with files, and messages picked.

use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

use super::*;
use crate::testing::fixtures::*;
use crate::testing::{App, World, refused};

fn chat_of(app: &App, cx: &mut TestAppContext) -> Entity<ChatView> {
    app.window.update(cx, |root, _, _| root.chat.as_ref().map(|(_, chat)| chat.clone())).unwrap().expect("a chat is open")
}

fn open_chat(cx: &mut TestAppContext, world: &World, key: &str) -> (App, Entity<ChatView>) {
    let app = App::open(cx, world);
    app.answer("sendMessage", |_| Ok(Value::Null));
    app.answer("editMessage", |_| Ok(Value::Null));
    app.answer("linkPreview", |args| Ok(json!({ "url": args[0], "title": "A page", "siteName": "example.com" })));
    app.update(cx, |state, cx| {
        state.select_server(SERVER, cx);
        state.select_conversation(Some(key.to_string()), cx);
    });
    let chat = chat_of(&app, cx);
    (app, chat)
}

fn typed(chat: &Entity<ChatView>, cx: &mut TestAppContext) -> String {
    cx.read(|cx| chat.read(cx).composer.read(cx).text().to_string())
}

fn labels(chat: &Entity<ChatView>, cx: &mut TestAppContext) -> Vec<String> {
    cx.read(|cx| chat.read(cx).suggestions.iter().map(|suggestion| suggestion.label.clone()).collect())
}

/// Types into whatever has focus, as the keyboard would, and lets the window draw.
fn type_in(app: &App, cx: &mut TestAppContext, text: &str) {
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_input(text);
    app.run(cx);
}

fn keys(app: &App, cx: &mut TestAppContext, keystrokes: &str) {
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_keystrokes(keystrokes);
    app.run(cx);
}

/// Hands the chat an event from its message box, as the box does.
fn composer_event(app: &App, chat: &Entity<ChatView>, cx: &mut TestAppContext, event: InputEvent) {
    app.window.update(cx, |_, window, cx| chat.update(cx, |chat, cx| chat.on_composer(&event, window, cx))).unwrap();
    app.run(cx);
}

#[gpui::test]
fn typing_suggesting_and_sending(cx: &mut TestAppContext) {
    let (app, chat) = open_chat(cx, &World::new("typing"), &format!("user:{BOB}"));
    app.forget_calls();

    // Someone mentioned: "@" and a few letters suggest them, and Tab takes the first.
    type_in(&app, cx, "Hello @bo");
    assert_eq!(app.calls_of("sendTyping"), vec![vec![json!(DM)]], "the other side sees typing");
    assert!(app.read(cx, |state| state.drafts.contains_key(&format!("user:{BOB}"))), "what's typed is kept as a draft");
    assert_eq!(labels(&chat, cx), vec!["Bob"]);
    keys(&app, cx, "tab");
    assert_eq!(typed(&chat, cx), "Hello @bob ");

    // An emote: ":" suggests, arrows move, Enter takes it.
    type_in(&app, cx, ":ka");
    assert_eq!(labels(&chat, cx), vec!["Kappa"]);
    keys(&app, cx, "down up");
    keys(&app, cx, "enter");
    assert_eq!(typed(&chat, cx), "Hello @bob Kappa ");
    // Moving out of a ":" closes its suggestions.
    type_in(&app, cx, ":");
    assert!(!labels(&chat, cx).is_empty());
    keys(&app, cx, "backspace");
    assert!(labels(&chat, cx).is_empty());

    // A link is previewed once typing pauses.
    type_in(&app, cx, "see https://example.com/page");
    cx.executor().advance_clock(std::time::Duration::from_secs(2));
    app.run(cx);
    assert_eq!(app.calls_of("linkPreview"), vec![vec![json!("https://example.com/page")]]);
    assert!(cx.read(|cx| chat.read(cx).link_draft.as_ref().is_some_and(|draft| draft.preview.is_some())));

    keys(&app, cx, "enter");
    let sent = app.calls_of("sendMessage");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0][0], json!(format!("user:{BOB}")));
    assert_eq!(sent[0][1]["text"], "Hello @bob Kappa see https://example.com/page");
    assert_eq!(sent[0][1]["mentions"], json!([BOB]));
    assert_eq!(sent[0][1]["emotes"]["Kappa"]["id"], "01KAPPA");
    assert_eq!(sent[0][1]["preview"]["title"], "A page");
    assert_eq!(typed(&chat, cx), "");
    assert!(app.read(cx, |state| !state.drafts.contains_key(&format!("user:{BOB}"))));

    // Nothing typed sends nothing.
    keys(&app, cx, "enter");
    assert_eq!(app.calls_of("sendMessage").len(), 1);

    // Too long to be a message.
    app.window
        .update(cx, |_, _, cx| chat.update(cx, |chat, cx| chat.composer.update(cx, |input, cx| input.set_text("x".repeat(MAX_TEXT_LENGTH + 1), cx))))
        .unwrap();
    keys(&app, cx, "enter");
    assert!(app.toasts(cx).iter().any(|toast| toast.contains("too long")));
}

#[gpui::test]
fn answering_and_editing_from_the_box(cx: &mut TestAppContext) {
    let (app, chat) = open_chat(cx, &World::new("answering"), &format!("user:{BOB}"));
    app.settle(cx, |state| state.lists.get(DM).is_some_and(|list| list.loaded));
    let first: crate::models::MessageView = app.read(cx, |state| state.lists[DM].items[0].clone());

    // An answer names what it answers, and the answer goes once sent.
    app.update(cx, |state, cx| state.set_reply(DM, Some(first.clone()), cx));
    type_in(&app, cx, "Sure");
    keys(&app, cx, "enter");
    assert_eq!(app.calls_of("sendMessage")[0][1]["replyTo"], "m01");
    assert!(app.read(cx, |state| !state.reply_to.contains_key(DM)));

    // Escape lets go of an answer, then of the open panel.
    app.update(cx, |state, cx| state.set_reply(DM, Some(first.clone()), cx));
    keys(&app, cx, "escape");
    assert!(app.read(cx, |state| !state.reply_to.contains_key(DM)));
    app.update(cx, |state, cx| state.toggle_panel(crate::state::Panel::Info, cx));
    composer_event(&app, &chat, cx, InputEvent::Escape);
    assert!(app.read(cx, |state| state.panel.is_none()));

    // Up in an empty box edits this person's last message, which the box then holds.
    keys(&app, cx, "up");
    assert_eq!(app.read(cx, |state| state.editing.get(DM).map(|message| message.id.clone())), Some("m13".to_string()));
    assert_eq!(typed(&chat, cx), "Pinned and :Kappa:");
    // Sent unchanged, it's left as it was.
    keys(&app, cx, "enter");
    assert!(app.calls_of("editMessage").is_empty());
    keys(&app, cx, "up");
    type_in(&app, cx, " edited");
    keys(&app, cx, "enter");
    let edited = app.calls_of("editMessage");
    assert_eq!(edited.len(), 1);
    assert_eq!((edited[0][1].clone(), edited[0][2].clone()), (json!("m13"), json!("Pinned and :Kappa: edited")));
    // Escape stops editing and empties the box.
    keys(&app, cx, "up");
    keys(&app, cx, "escape");
    assert!(app.read(cx, |state| !state.editing.contains_key(DM)));
    assert_eq!(typed(&chat, cx), "");
    // With something typed, Up is only a caret moving.
    type_in(&app, cx, "draft");
    keys(&app, cx, "up");
    assert!(app.read(cx, |state| !state.editing.contains_key(DM)));
}

#[gpui::test]
fn a_bots_commands_and_files_to_send(cx: &mut TestAppContext) {
    let (app, chat) = open_chat(cx, &World::new("commands"), &format!("user:{BOT}"));
    app.answer("sendWithAttachments", |_| Err(refused("The file is too big.")));
    type_in(&app, cx, "/");
    assert_eq!(labels(&chat, cx), vec!["/start", "/help"]);
    type_in(&app, cx, "h");
    assert_eq!(labels(&chat, cx), vec!["/help"]);
    keys(&app, cx, "enter");
    assert_eq!(typed(&chat, cx), "/help ");
    // Suggestions shown but none picked: Enter makes a new line where Enter doesn't send.
    app.update(cx, |state, _| state.settings.enter_to_send = false);
    keys(&app, cx, crate::testing::CLEAR_KEYS);
    type_in(&app, cx, ":");
    composer_event(&app, &chat, cx, InputEvent::Submit);
    assert_eq!(typed(&chat, cx), ":\n");
    app.update(cx, |state, _| state.settings.enter_to_send = true);
    keys(&app, cx, crate::testing::CLEAR_KEYS);

    // Files dropped on the box go with the next message, read for their chips first.
    let dir = std::env::temp_dir().join(format!("zuna-chat-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut paths = Vec::new();
    for (name, bytes) in [("notes.txt", b"some notes".to_vec()), ("tone.wav", vec![0; 64]), ("picture.png", png_bytes())] {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        paths.push(path);
    }
    paths.push(dir.join("missing.bin"));
    composer_event(&app, &chat, cx, InputEvent::Files(paths));
    assert_eq!(cx.read(|cx| chat.read(cx).files.len()), 3, "three files that are there");
    keys(&app, cx, "enter");
    let sent = app.calls_of("sendWithAttachments");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0][1].as_array().unwrap().len(), 3);
    assert!(app.toasts(cx).contains(&"The file is too big.".to_string()), "what went wrong is said");
    assert!(cx.read(|cx| chat.read(cx).files.is_empty()));
}

fn png_bytes() -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(4, 3, image::Rgb([10, 20, 30])).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[gpui::test]
fn a_channel_edits_in_place_and_waits_in_slow_mode(cx: &mut TestAppContext) {
    let mut world = World::new("channel");
    let general = &mut world.server["getChannels"][0]["conversation"];
    general["slowMode"] = json!(30);
    general["members"][0]["role"] = json!("member");
    let (app, chat) = open_chat(cx, &world, &format!("group:{GENERAL}"));
    app.answer("loadMessages", |args| Ok(json!({ "messages": [message("c1", args[0].as_str().unwrap(), 1.0, ME, "Mine", json!({}))], "hasMore": false })));
    app.update(cx, |state, cx| state.return_to_latest(GENERAL, cx));

    // One message goes; the next waits for slow mode, and what's typed stays.
    type_in(&app, cx, "First");
    keys(&app, cx, "enter");
    type_in(&app, cx, "Second");
    keys(&app, cx, "enter");
    assert_eq!(app.calls_of("sendMessage").len(), 1);
    assert_eq!(typed(&chat, cx), "Second");
    keys(&app, cx, crate::testing::CLEAR_KEYS);

    // Editing a channel's message happens where it is.
    let mine: crate::models::MessageView = app.read(cx, |state| state.lists[GENERAL].items[0].clone());
    app.update(cx, |state, cx| state.set_editing(GENERAL, Some(mine.clone()), cx));
    assert_eq!(cx.read(|cx| chat.read(cx).inline_editing.clone()), Some("c1".to_string()));
    let editor = cx.read(|cx| chat.read(cx).inline_editor.clone());
    editor.update(cx, |input, cx| input.set_text("Mine, changed", cx));
    chat.update(cx, |chat, cx| chat.on_inline_editor(&InputEvent::Submit, cx));
    app.run(cx);
    assert_eq!(app.calls_of("editMessage")[0][2], json!("Mine, changed"));
    app.update(cx, |state, cx| state.set_editing(GENERAL, Some(mine), cx));
    chat.update(cx, |chat, cx| chat.on_inline_editor(&InputEvent::Escape, cx));
    app.run(cx);
    assert!(app.read(cx, |state| !state.editing.contains_key(GENERAL)));
    assert_eq!(cx.read(|cx| chat.read(cx).inline_editing.clone()), None);
}

#[gpui::test]
fn picking_messages_by_dragging_across_them(cx: &mut TestAppContext) {
    let (app, chat) = open_chat(cx, &World::new("picking-messages"), &format!("user:{BOB}"));
    app.settle(cx, |state| state.lists.get(DM).is_some_and(|list| list.loaded));
    // The rows the list has drawn, top to bottom, that are messages that can be picked.
    let rows: Vec<(String, gpui::Point<gpui::Pixels>)> = cx.read(|cx| {
        let chat = chat.read(cx);
        let mut drawn: Vec<(usize, gpui::Bounds<gpui::Pixels>)> = chat.row_bounds.borrow().iter().map(|(index, bounds)| (*index, *bounds)).collect();
        drawn.sort_by_key(|(index, _)| *index);
        drawn.into_iter().filter(|(index, _)| *index < chat.rows.len()).map(|(index, bounds)| (chat.rows[index].0.clone(), bounds.center())).collect()
    });
    let pickable: Vec<&(String, gpui::Point<gpui::Pixels>)> = rows.iter().filter(|(id, _)| ["m02", "m03", "m04", "m05"].contains(&id.as_str())).collect();
    assert!(pickable.len() >= 2, "the list drew its messages: {rows:?}");
    let (from, to) = (pickable[0].1, pickable[pickable.len() - 1].1);
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_mouse_down(from, gpui::MouseButton::Left, gpui::Modifiers::none());
    window.simulate_mouse_move(to, Some(gpui::MouseButton::Left), gpui::Modifiers::none());
    window.simulate_mouse_up(to, gpui::MouseButton::Left, gpui::Modifiers::none());
    app.run(cx);
    let picked = app.read(cx, |state| state.selection.clone().map(|(_, ids)| ids).unwrap_or_default());
    assert!(picked.len() >= 2, "dragging across messages picks them: {picked:?}");

    // Dragging from one that's picked lets go of what it crosses.
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_mouse_down(to, gpui::MouseButton::Left, gpui::Modifiers::none());
    window.simulate_mouse_move(from, Some(gpui::MouseButton::Left), gpui::Modifiers::none());
    window.simulate_mouse_up(from, gpui::MouseButton::Left, gpui::Modifiers::none());
    app.run(cx);
    assert!(app.read(cx, |state| state.selection.is_none()), "nothing's left picked");

    // Picked by hand, the bar shows instead of the box, and a click there lets them go.
    app.update(cx, |state, cx| state.toggle_selected(DM, Some("m13"), cx));
    app.update(cx, |state, cx| state.toggle_selected(DM, None, cx));
    assert!(app.read(cx, |state| state.selection.is_none()));
}

/// Right-clicks a row of the list, scrolled into view first, and gives what its menu offers.
fn right_click_row(app: &App, chat: &Entity<ChatView>, cx: &mut TestAppContext, index: usize) -> Vec<String> {
    // Jumped to, as a reply's quote or a search result does, which brings it into view.
    let id = cx.read(|cx| chat.read(cx).rows[index].0.clone());
    app.update(cx, |state, cx| state.jump_to_message(DM, &id, cx));
    let Some(point) = cx.read(|cx| chat.read(cx).row_bounds.borrow().get(&index).map(|bounds| bounds.center())) else { return Vec::new() };
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    // The pointer comes to it first, so the window knows what's under it.
    window.simulate_mouse_move(point, None, gpui::Modifiers::none());
    window.simulate_mouse_down(point, gpui::MouseButton::Right, gpui::Modifiers::none());
    window.simulate_mouse_up(point, gpui::MouseButton::Right, gpui::Modifiers::none());
    app.run(cx);
    cx.update(|cx| crate::ui::menu::open_labels(cx))
}

fn choose(app: &App, cx: &mut TestAppContext, label: &str) -> bool {
    let chosen = app.window.update(cx, |_, window, cx| crate::ui::menu::choose(label, window, cx)).unwrap();
    app.run(cx);
    chosen
}

#[gpui::test]
fn every_messages_menu(cx: &mut TestAppContext) {
    let (app, chat) = open_chat(cx, &World::new("menus"), &format!("user:{BOB}"));
    app.settle(cx, |state| state.lists.get(DM).is_some_and(|list| list.loaded));
    for method in ["deleteMessage", "discardMessage", "retryMessage", "setPinned", "toggleReaction"] {
        app.answer(method, |_| Ok(Value::Null));
    }
    // Dialogs and menus fade over real time, which the test's clock doesn't move, and a dialog
    // fading out still takes the clicks meant for the list.
    crate::ui::motion::set_reduced(true);
    let rows = cx.read(|cx| chat.read(cx).rows.len());
    let mut chat = chat;
    let mut offered = std::collections::BTreeSet::new();
    for index in 0..rows {
        let labels = right_click_row(&app, &chat, cx, index);
        for label in labels {
            offered.insert(label.clone());
            // Forwarding opens a dialog, after which the test window's right clicks reach no message
            // (a dialog opened and closed any other way does the same), so it's chosen once, last.
            if label == "Forward" {
                continue;
            }
            // Open again for each choice, as each closes it.
            right_click_row(&app, &chat, cx, index);
            assert!(choose(&app, cx, &label), "{label} is offered");
            // A submenu, as who read it, opens its own entries, and the first is picked.
            if let Some(first) = cx.update(|cx| crate::ui::menu::open_labels(cx)).first().cloned() {
                choose(&app, cx, &first);
            }
            app.update(cx, |state, cx| {
                state.set_overlay(None, cx);
                state.toggle_selected(DM, None, cx);
                state.set_reply(DM, None, cx);
                state.set_editing(DM, None, cx);
                state.select_conversation(Some(format!("user:{BOB}")), cx);
            });
            chat = chat_of(&app, cx);
        }
        // A quick reaction from the top of the menu.
        if !right_click_row(&app, &chat, cx, index).is_empty() {
            app.window.update(cx, |_, window, cx| crate::ui::menu::react(0, window, cx)).unwrap();
            app.run(cx);
        }
    }
    right_click_row(&app, &chat, cx, 0);
    assert!(choose(&app, cx, "Forward"));
    assert!(app.read(cx, |state| matches!(state.overlay, Some(crate::state::Overlay::Forward { .. }))));
    for label in ["Reply", "Forward", "Select", "Copy text", "Edit", "Pin", "Unpin", "Try again", "Discard", "Delete for everyone"] {
        assert!(offered.contains(label), "some message offers {label}: {offered:?}");
    }
    assert!(!app.calls_of("toggleReaction").is_empty());
    assert!(!app.calls_of("setPinned").is_empty());
    assert!(!app.calls_of("deleteMessage").is_empty());
    assert!(!app.calls_of("retryMessage").is_empty());
}


#[gpui::test]
fn an_empty_chat_says_whose_it_is_and_offers_to_verify(cx: &mut TestAppContext) {
    let mut world = World::new("empty-chats");
    world.server.insert("loadMessages".into(), json!({ "messages": [], "hasMore": false }));
    world.server["getCalls"] = json!([]);
    // Carol's keys changed, and she's no longer blocked, so her chat offers to compare them.
    world.server["getConversations"][4]["blocked"] = json!(false);
    world.server["getPreferences"]["blocked"] = json!([]);
    let (app, _) = open_chat(cx, &world, &format!("user:{CAROL}"));
    app.update(cx, |state, _| state.settings.reduce_motion = true);
    app.click(cx, "verify-empty");
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(crate::state::Overlay::Verify { user_id: CAROL.into() }));
    // A group's, your own notes', and a chat with someone verified ask for nothing.
    for key in [format!("group:{GROUP}"), format!("user:{ME}"), format!("user:{BOB}")] {
        app.update(cx, |state, cx| {
            state.set_overlay(None, cx);
            state.select_conversation(Some(key.clone()), cx);
        });
        assert!(!app.drawn(cx, "verify-empty"), "{key}");
    }
}

#[gpui::test]
fn the_at_button_goes_to_each_unread_mention_in_turn(cx: &mut TestAppContext) {
    let mut world = World::new("mentions");
    world.server["getCalls"] = json!([]);
    world.server.insert("loadMessages".into(), json!({ "messages": crate::testing::fixtures::messages(GROUP), "hasMore": false }));
    let (app, _) = open_chat(cx, &world, &format!("group:{GROUP}"));
    app.answer("unreadMentions", |_| Ok(json!([{ "id": "m02", "seq": 2 }, { "id": "m03", "seq": 3 }])));
    app.answer("markMentionSeen", |_| Ok(Value::Null));
    app.update(cx, |state, cx| {
        state.settings.reduce_motion = true;
        state.select_conversation(None, cx);
    });
    app.update(cx, |state, cx| state.select_conversation(Some(format!("group:{GROUP}")), cx));
    assert!(app.drawn(cx, "to-mention"));
    app.click(cx, "to-mention");
    assert_eq!(app.calls_of("markMentionSeen"), vec![vec![json!(GROUP), json!("m02")]], "the oldest first, seen as it's gone to");
    let chat = chat_of(&app, cx);
    assert_eq!(cx.read(|cx| chat.read(cx).mentions.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>()), vec!["m03".to_string()], "the next waits");
}

#[gpui::test]
fn emotes_among_words_and_alone_large(cx: &mut TestAppContext) {
    let kappa = json!({ "Kappa": { "id": "01KAPPA", "owner": "someone" } });
    let messages = json!([
        message("e1", DM, 1.0, BOB, "look Kappa here, and a long line of words after it that wraps somewhere along the way", json!({ "emotes": kappa })),
        message("e2", DM, 2.0, BOB, "Kappa Kappa", json!({ "emotes": kappa })),
        message("e3", DM, 3.0, ME, "> Kappa quoted\nKappa", json!({ "emotes": kappa })),
    ]);
    let mut world = World::new("emote-messages");
    world.server["getCalls"] = json!([]);
    world.server.insert("loadMessages".into(), json!({ "messages": messages, "hasMore": false }));
    let (app, _) = open_chat(cx, &world, &format!("user:{BOB}"));
    app.settle(cx, |state| state.lists.get(DM).is_some_and(|list| list.loaded));
    assert_eq!(crate::markup::jumbo_size("Kappa Kappa", &serde_json::from_value(kappa.clone()).unwrap()), 2);
    // And in a channel, as its lines draw them.
    let mut channel = World::new("emote-channel");
    channel.server["getCalls"] = json!([]);
    channel.server.insert("loadMessages".into(), json!({ "messages": [message("c1", GENERAL, 1.0, BOB, "Kappa", json!({ "emotes": kappa })), message("c2", GENERAL, 2.0, BOB, "words Kappa words", json!({ "emotes": kappa }))], "hasMore": false }));
    let (app, _) = open_chat(cx, &channel, &format!("group:{GENERAL}"));
    app.settle(cx, |state| state.lists.get(GENERAL).is_some_and(|list| list.loaded));
}

#[gpui::test]
fn every_line_a_group_tells_of_itself_and_a_bots_buttons(cx: &mut TestAppContext) {
    let system = |id: &str, seq: f64, kind: &str, extra: Value| {
        let mut line = json!({ "type": kind, "actorId": BOB });
        if let (Some(into), Value::Object(extra)) = (line.as_object_mut(), extra) {
            into.extend(extra);
        }
        message(id, GROUP, seq, BOB, "", json!({ "system": line }))
    };
    let sticker = json!({ "fileId": "s".repeat(32), "key": "a2V5", "prefix": "cHJlZml4", "chunks": 1, "name": "sticker.webp", "mime": "image/webp", "size": 2000, "sticker": true, "width": 512, "height": 256 });
    let messages = json!([
        system("s01", 1.0, "group_created", json!({})),
        system("s02", 2.0, "member_added", json!({ "targetIds": [CAROL, BOT] })),
        system("s03", 3.0, "member_removed", json!({ "targetIds": [CAROL] })),
        system("s04", 4.0, "member_left", json!({})),
        system("s05", 5.0, "member_rejoined", json!({})),
        system("s06", 6.0, "unexpected_join", json!({})),
        system("s07", 7.0, "identity_changed", json!({})),
        system("s08", 8.0, "identity_rotated", json!({})),
        system("s09", 9.0, "device_added", json!({ "actorId": null })),
        system("s10", 10.0, "timer_changed", json!({ "seconds": 3600 })),
        system("s11", 11.0, "timer_changed", json!({ "seconds": 0 })),
        message("b01", GROUP, 12.0, BOT, "Pick one", json!({ "buttons": [[{ "text": "Yes", "data": "y" }, { "text": "The docs", "url": "https://example.com/docs" }], [{ "text": "No", "data": "n" }]] })),
        message("b02", GROUP, 13.0, BOT, "", json!({ "attachments": [sticker] })),
    ]);
    let mut world = World::new("system-lines");
    world.server["getCalls"] = json!([]);
    world.server.insert("loadMessages".into(), json!({ "messages": messages, "hasMore": false }));
    let (app, _) = open_chat(cx, &world, &format!("group:{GROUP}"));
    app.answer("pressButton", |_| Ok(Value::Null));
    app.settle(cx, |state| state.lists.get(GROUP).is_some_and(|list| list.loaded));
    app.run(cx);
    for line in [
        "Bob created this group".to_string(),
        "Bob added Carol, the bot Helper".into(),
        "Bob removed Carol".into(),
        "Bob left the group".into(),
        "Bob rejoined this chat".into(),
        "Bob joined without being added by a member. Check that this is expected.".into(),
        "Bob's security key changed. Verify it before trusting new messages.".into(),
        "Bob's security key changed since you verified it. You can compare keys again if you'd like.".into(),
        "Someone added a device".into(),
        format!("Bob set messages to disappear after {}", crate::format::timer_text(3600.)),
        "Bob turned off disappearing messages".into(),
    ] {
        assert!(app.drawn(cx, &format!("system: {line}")), "{line}");
    }
    // A button with data sends it back, where it was pressed; one with a link opens it.
    app.click(cx, "msg-button-b01-1-0");
    assert_eq!(app.calls_of("pressButton"), vec![vec![json!(GROUP), json!("b01"), json!(1), json!(0)]]);
    app.click(cx, "msg-button-b01-0-1");
    assert_eq!(app.calls_of("pressButton").len(), 1, "a link isn't pressed");
    assert!(app.drawn(cx, &format!("sticker-b02-{}", "s".repeat(32))) || cx.read(|cx| app.state.read(cx).pictures.contains_key(&format!("file:{}", "s".repeat(32)))), "a sticker loads its picture by itself");
}

#[test]
fn a_file_to_send_is_typed_by_its_name() {
    let dir = std::env::temp_dir().join(format!("zuna-file-types-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (name, mime) in [
        ("a.JPG", "image/jpeg"), ("a.jpeg", "image/jpeg"), ("a.png", "image/png"), ("a.gif", "image/gif"), ("a.webp", "image/webp"), ("a.mp4", "video/mp4"), ("a.mov", "video/quicktime"),
        ("a.webm", "video/webm"), ("a.bmp", "image/bmp"), ("a.avif", "image/avif"), ("a.heic", "image/heic"), ("a.svg", "image/svg+xml"), ("a.mkv", "video/x-matroska"),
        ("a.avi", "video/x-msvideo"), ("a.mp3", "audio/mpeg"), ("a.m4a", "audio/mp4"), ("a.aac", "audio/aac"), ("a.ogg", "audio/ogg"), ("a.oga", "audio/ogg"), ("a.opus", "audio/opus"),
        ("a.wav", "audio/wav"), ("a.flac", "audio/flac"), ("a.pdf", "application/pdf"), ("a.txt", "text/plain"), ("a.log", "text/plain"), ("a.md", "text/markdown"), ("a.csv", "text/csv"),
        ("a.json", "application/json"), ("a.zip", "application/zip"), ("a.7z", "application/x-7z-compressed"), ("a.gz", "application/gzip"), ("a.tar", "application/x-tar"),
        ("a.doc", "application/msword"), ("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), ("a.xls", "application/vnd.ms-excel"),
        ("a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), ("a.ppt", "application/vnd.ms-powerpoint"),
        ("a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), ("a.unknown", "application/octet-stream"), ("noextension", "application/octet-stream"),
    ] {
        let path = dir.join(name);
        std::fs::write(&path, b"not really one").unwrap();
        let file = sending::file_for_sending(&path);
        assert_eq!((file["name"].as_str().unwrap(), file["mime"].as_str().unwrap()), (name, mime));
        assert!(file.get("width").is_none(), "{name} can't be read as what it says it is, so it has no size");
    }
    // A real picture has its size and a small preview.
    let path = dir.join("real.png");
    std::fs::write(&path, png_bytes()).unwrap();
    let file = sending::file_for_sending(&path);
    assert!(file["width"].as_u64().is_some() && file["thumb"].as_str().is_some_and(|thumb| thumb.starts_with("data:image/")), "{file}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[gpui::test]
fn a_channels_messages_answered_reacted_to_and_picked(cx: &mut TestAppContext) {
    let messages = json!([
        message("c1", GENERAL, 1.0, CAROL, "Hidden words", json!({})),
        message("c2", GENERAL, 2.0, BOB, "About that", json!({ "reply": { "id": "c0", "senderId": BOB, "text": "", "hasAttachment": false, "deleted": true },
            "reactions": [{ "key": "👍", "userIds": [ME] }, { "key": "Kappa", "emote": { "id": "01KAPPA", "animated": false }, "userIds": [BOB] }] })),
        message("c3", GENERAL, 3.0, BOB, "And this", json!({ "reply": { "id": "c1", "senderId": CAROL, "text": "Hidden words", "hasAttachment": false, "deleted": false } })),
        message("c4", GENERAL, 4.0, BOB, "Passed on", json!({ "forwarded": {} })),
    ]);
    let mut world = World::new("channel-messages");
    world.server["getCalls"] = json!([]);
    world.server.insert("loadMessages".into(), json!({ "messages": messages, "hasMore": false }));
    let (app, _) = open_chat(cx, &world, &format!("group:{GENERAL}"));
    app.answer("toggleReaction", |_| Ok(Value::Null));
    app.update(cx, |state, _| state.settings.reduce_motion = true);
    app.settle(cx, |state| state.lists.get(GENERAL).is_some_and(|list| list.loaded));
    app.run(cx);
    // Someone blocked is hidden until asked for.
    app.click(cx, "show-c1");
    assert!(!app.drawn(cx, "show-c1"));
    // A reaction is taken back or joined from its chip, an emote's with the emote.
    app.click(cx, "creaction-c2-👍");
    app.click(cx, "creaction-c2-Kappa");
    let calls = app.calls_of("toggleReaction");
    assert_eq!(calls[0], vec![json!(GENERAL), json!("c2"), json!("👍")]);
    assert_eq!((calls[1][2].clone(), calls[1].len()), (json!("Kappa"), 4));
    // What's over a message under the pointer: forwarding it, more, and a reaction to pick.
    let hover = |cx: &mut TestAppContext, id: &'static str| {
        let mut window = VisualTestContext::from_window(app.window.into(), cx);
        let at = window.debug_bounds(id).expect("drawn").center();
        window.simulate_mouse_move(at, None, gpui::Modifiers::none());
        app.run(cx);
    };
    hover(cx, "cmsg-row-c2");
    app.click(cx, "forward-c2");
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(crate::state::Overlay::Forward { server_id: SERVER.into(), group_id: GENERAL.into(), ids: vec!["c2".into()] }));
    app.update(cx, |state, cx| state.set_overlay(None, cx));
    std::thread::sleep(std::time::Duration::from_millis(200));
    hover(cx, "cmsg-row-c2");
    app.click(cx, "more-c2");
    let entries = cx.read(|cx| crate::ui::menu::open_labels(cx));
    assert!(entries.iter().any(|entry| entry == "Reply"), "{entries:?}");
    assert!(choose(&app, cx, "Reply"));
    assert_eq!(app.read(cx, |state| state.reply_to.get(GENERAL).map(|message| message.id.clone())), Some("c2".into()));
    hover(cx, "cmsg-row-c2");
    app.click(cx, "react-c2");
    assert!(cx.read(|cx| crate::ui::picker::is_open(cx)), "the picker of reactions");
    app.window.update(cx, |_, window, cx| crate::ui::picker::choose(crate::ui::picker::Pick::Emoji("🎉".into()), window, cx)).unwrap();
    app.run(cx);
    assert_eq!(app.calls_of("toggleReaction")[2], vec![json!(GENERAL), json!("c2"), json!("🎉")]);
    assert!(!cx.read(|cx| crate::ui::picker::is_open(cx)));
    std::thread::sleep(std::time::Duration::from_millis(200));
    // A right click's menu, with reactions over it.
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    let at = window.debug_bounds("cmsg-row-c3").unwrap().center();
    window.simulate_event(gpui::MouseDownEvent { position: at, modifiers: gpui::Modifiers::none(), button: gpui::MouseButton::Right, click_count: 1, first_mouse: false });
    app.run(cx);
    assert!(cx.read(|cx| crate::ui::menu::is_open(cx)));
    app.update(cx, |_, cx| crate::ui::menu::close_menu(cx));
    std::thread::sleep(std::time::Duration::from_millis(200));
    // Picking messages, a click at a time.
    app.update(cx, |state, cx| state.toggle_selected(GENERAL, Some("c2"), cx));
    app.click(cx, "cmsg-row-c3");
    assert_eq!(app.read(cx, |state| state.selection.clone()), Some((GENERAL.to_string(), vec!["c2".to_string(), "c3".to_string()])));
    app.click(cx, "cmsg-row-c2");
    assert_eq!(app.read(cx, |state| state.selection.clone()), Some((GENERAL.to_string(), vec!["c3".to_string()])));
}

#[gpui::test]
fn a_messages_text_is_selected_stretched_and_copied(cx: &mut TestAppContext) {
    let messages = json!([
        message("t1", DM, 1.0, BOB, "The first line of words to pick from\n\nand a second block after it", json!({})),
        message("t2", DM, 2.0, BOB, "Another one", json!({})),
    ]);
    let mut world = World::new("text-selection");
    world.server["getCalls"] = json!([]);
    world.server.insert("loadMessages".into(), json!({ "messages": messages, "hasMore": false }));
    let (app, _) = open_chat(cx, &world, &format!("user:{BOB}"));
    app.settle(cx, |state| state.lists.get(DM).is_some_and(|list| list.loaded));
    app.run(cx);
    let pieces = crate::ui::selection::drawn_pieces("t1");
    let text = pieces.first().expect("its text is drawn").0;
    assert!(text.size.height > gpui::px(40.), "on several lines: {pieces:?}");
    let top = |x: f32| gpui::point(text.left() + gpui::px(x), text.top() + gpui::px(8.));
    let bottom = |x: f32| gpui::point(text.left() + gpui::px(x), text.bottom() - gpui::px(8.));
    // Dragged from its start down to its last line: what's between, lines and all.
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_mouse_move(top(1.), None, gpui::Modifiers::none());
    window.simulate_mouse_down(top(1.), gpui::MouseButton::Left, gpui::Modifiers::none());
    window.simulate_mouse_move(bottom(30.), Some(gpui::MouseButton::Left), gpui::Modifiers::none());
    window.simulate_mouse_up(bottom(30.), gpui::MouseButton::Left, gpui::Modifiers::none());
    app.run(cx);
    let selected = crate::ui::selection::text_in("t1").expect("something's selected");
    assert!(selected.starts_with("The first line") && selected.contains('\n') && !selected.ends_with("after it"), "{selected:?}");
    assert_eq!(crate::ui::selection::text(), Some(selected.clone()));
    // Copied with the keys a browser copies with.
    keys(&app, cx, if cfg!(target_os = "macos") { "cmd-c" } else { "ctrl-c" });
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()), Some(selected));
    // Shift stretches it, within that message.
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_mouse_down(top(40.), gpui::MouseButton::Left, gpui::Modifiers::shift());
    window.simulate_mouse_up(top(40.), gpui::MouseButton::Left, gpui::Modifiers::shift());
    app.run(cx);
    let shorter = crate::ui::selection::text_in("t1").expect("still selected");
    assert!(!shorter.contains('\n') && shorter.len() < 20, "{shorter:?}");
    assert_eq!(crate::ui::selection::text_in("t2"), None);
    // Typing lets go of it, and so does a click with nothing to select.
    type_in(&app, cx, "x");
    assert_eq!(crate::ui::selection::text(), None);
    let mut window = VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_mouse_down(top(1.), gpui::MouseButton::Left, gpui::Modifiers::none());
    window.simulate_mouse_up(top(1.), gpui::MouseButton::Left, gpui::Modifiers::none());
    app.run(cx);
    assert_eq!(crate::ui::selection::text(), None, "a click without a drag selects nothing");
}
