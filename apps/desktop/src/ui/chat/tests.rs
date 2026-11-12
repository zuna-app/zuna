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
    keys(&app, cx, "ctrl-a backspace");
    type_in(&app, cx, ":");
    composer_event(&app, &chat, cx, InputEvent::Submit);
    assert_eq!(typed(&chat, cx), ":\n");
    app.update(cx, |state, _| state.settings.enter_to_send = true);
    keys(&app, cx, "ctrl-a backspace");

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
    keys(&app, cx, "ctrl-a backspace");

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
