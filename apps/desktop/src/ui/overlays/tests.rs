//! The dialogs over the app that make and change things, used as a person uses them: a text
//! channel and a voice one made with each of their settings, one edited and deleted after the
//! system's own question; a group made with a bot among its people, asked about first; people
//! added to one; and messages forwarded to another chat.

use gpui::TestAppContext;
use serde_json::{Value, json};

use super::*;
use crate::testing::fixtures::*;
use crate::testing::{App as Running, World, refused};

fn open(cx: &mut TestAppContext, name: &str, overlay: Overlay) -> Running {
    let mut world = World::new(name);
    world.server["getCalls"] = json!([]);
    let app = Running::open(cx, &world);
    app.update(cx, |state, cx| {
        state.settings.reduce_motion = true;
        state.select_server(SERVER, cx);
        state.set_overlay(Some(overlay), cx);
    });
    app
}

fn dialog(app: &Running, cx: &mut TestAppContext) -> Entity<Dialog> {
    app.window.update(cx, |root, _, _| root.overlay.as_ref().and_then(|(_, view)| view.clone().downcast::<Dialog>().ok())).unwrap().expect("a dialog is up")
}

fn dialog_history(app: &Running, cx: &gpui::App) -> bool {
    app.window.read(cx).ok().and_then(|root| root.overlay.as_ref().and_then(|(_, view)| view.clone().downcast::<Dialog>().ok())).is_some_and(|dialog| dialog.read(cx).history)
}

fn name(app: &Running, cx: &mut TestAppContext, text: &str) {
    let view = dialog(app, cx);
    let input = cx.read(|cx| view.read(cx).name.clone());
    input.update(cx, |input, cx| input.set_text(text, cx));
    app.run(cx);
}

/// Picks an entry of the menu a select opened, by its place, as a click on it does.
fn pick(app: &Running, cx: &mut TestAppContext, select: &str, entry: usize) {
    app.click(cx, select);
    let label = cx.read(|cx| crate::ui::menu::open_labels(cx)).get(entry).cloned().expect("the select's menu is open");
    assert!(app.window.update(cx, |_, window, cx| crate::ui::menu::choose(&label, window, cx)).unwrap());
    app.run(cx);
}

#[test]
fn a_text_channels_name_is_written_as_one() {
    assert_eq!(text_channel_name("My New Channel!"), "my-new-channel!");
    assert_eq!(text_channel_name("trailing "), "trailing-", "a space as it's typed is a dash already");
    assert_eq!(text_channel_name("a  - b"), "a-b", "never two dashes in a row");
}

#[gpui::test]
fn channels_are_made_edited_and_deleted(cx: &mut TestAppContext) {
    let app = open(cx, "channel-dialogs", Overlay::Channel { channel_id: None, category: None });
    app.answer("createChannel", |args| if args[0]["name"] == "taken" { Err(refused("That name is taken.")) } else { Ok(json!("c-new")) });
    // A text channel, its name written as one, held back in slow mode.
    name(&app, cx, "Our Plans");
    let view = dialog(&app, cx);
    let category = cx.read(|cx| view.read(cx).channel_form.as_ref().unwrap().category.clone());
    category.update(cx, |input, cx| input.set_text("Talk", cx));
    app.click(cx, "slow-mode");
    pick(&app, cx, "slow-time", 4);
    app.click(cx, "save-channel");
    let made = app.calls_of("createChannel");
    assert_eq!((made[0][0]["name"].clone(), made[0][0]["type"].clone(), made[0][0]["category"].clone()), (json!("our-plans"), json!("text"), json!("Talk")));
    assert_eq!(made[0][0]["slowMode"], json!(60.0));
    assert_eq!(app.read(cx, |state| (state.overlay.clone(), state.servers[SERVER].active_key.clone())), (None, Some("group:c-new".into())), "a text channel opens once it's made");

    // A voice one, with its quality, screens and the switches only it has.
    app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: None, category: None }), cx));
    app.click(cx, "voice");
    name(&app, cx, "  Lounge Two ");
    pick(&app, cx, "audio-quality", 1);
    pick(&app, cx, "screen-limit", 1);
    app.click(cx, "soundboard");
    app.click(cx, "watch-together");
    app.click(cx, "save-channel");
    let voice = &app.calls_of("createChannel")[1][0];
    assert_eq!((voice["type"].clone(), voice["name"].clone()), (json!("voice"), json!("Lounge Two")));
    assert!(voice.get("bitrate").is_some() && voice.get("sounds").is_some() && voice.get("watch").is_some());
    assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
    // A refusal says why, and keeps the dialog.
    app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: None, category: None }), cx));
    name(&app, cx, "taken");
    app.click(cx, "save-channel");
    assert!(app.toasts(cx).contains(&"That name is taken.".to_string()));
    assert!(app.read(cx, |state| state.overlay.is_some()));

    // An existing one is edited, and deleted only once the system's question says so.
    app.answer("updateChannel", |_| Ok(Value::Null));
    app.answer("deleteChannel", |_| Ok(Value::Null));
    app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(LOUNGE.into()), category: None }), cx));
    app.click(cx, "save-channel");
    assert_eq!(app.calls_of("updateChannel")[0][0], json!(LOUNGE));
    app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(GENERAL.into()), category: None }), cx));
    app.click(cx, "delete-channel");
    cx.simulate_prompt_answer("Cancel");
    app.run(cx);
    assert!(app.calls_of("deleteChannel").is_empty());
    app.click(cx, "delete-channel");
    cx.simulate_prompt_answer("Delete");
    app.run(cx);
    assert_eq!(app.calls_of("deleteChannel"), vec![vec![json!(GENERAL)]]);
    assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
}

#[gpui::test]
fn a_group_with_a_bot_in_it_asks_first(cx: &mut TestAppContext) {
    let app = open(cx, "group-dialogs", Overlay::NewGroup);
    app.answer("createGroup", |_| Ok(json!("g-new")));
    app.answer("addMembers", |_| Ok(Value::Null));
    name(&app, cx, "Planning");
    // Its switch stays inside the dialog, beside its words, rather than pushed past its edge.
    let bounds = |cx: &mut TestAppContext, id: &'static str| gpui::VisualTestContext::from_window(app.window.into(), cx).debug_bounds(id).unwrap();
    let (switch, row) = (bounds(cx, "history"), bounds(cx, Box::leak(format!("person-{BOB}").into_boxed_str())));
    assert!(switch.right() <= row.right() + gpui::px(8.), "{switch:?} beside {row:?}");
    for id in [BOB, BOT, CAROL, CAROL] {
        app.click(cx, &format!("person-{id}"));
    }
    app.click(cx, "history");
    assert!(cx.read(|cx| dialog_history(&app, cx)), "history on");
    app.click(cx, "create");
    let view = dialog(&app, cx);
    assert!(cx.read(|cx| view.read(cx).asking), "the bot is asked about first");
    app.click(cx, "confirm-cancel");
    assert!(app.calls_of("createGroup").is_empty());
    app.click(cx, "create");
    app.click(cx, "confirm-action");
    let made = &app.calls_of("createGroup")[0];
    assert_eq!(made[0], json!("Planning"));
    let mut members: Vec<String> = serde_json::from_value(made[1].clone()).unwrap();
    members.sort();
    assert_eq!(members, vec![BOB.to_string(), BOT.to_string()], "Carol picked and unpicked");
    assert_eq!(app.read(cx, |state| state.servers[SERVER].active_key.clone()), Some("group:g-new".into()));

    // People added to a group, the bot again asked about.
    app.update(cx, |state, cx| state.set_overlay(Some(Overlay::AddMembers { group_id: DM.into() }), cx));
    app.click(cx, &format!("person-{BOT}"));
    app.click(cx, "add");
    app.click(cx, "confirm-action");
    assert_eq!(app.calls_of("addMembers"), vec![vec![json!(DM), json!([BOT])]]);
}

#[gpui::test]
fn messages_are_forwarded_to_another_chat(cx: &mut TestAppContext) {
    let app = open(cx, "forward-dialog", Overlay::Forward { server_id: SERVER.into(), group_id: DM.into(), ids: vec!["m01".into(), "m05".into()] });
    app.answer("forwardMessages", |args| if args[4] == "group:g-lab" { Err(refused("You can't write there.")) } else { Ok(Value::Null) });
    app.click(cx, &format!("forward-{SERVER}-group:{GROUP}"));
    assert!(app.toasts(cx).contains(&"You can't write there.".to_string()));
    app.click(cx, &format!("forward-{SERVER}-user:{CAROL}"));
    assert_eq!(app.calls_of("forwardMessages").last().unwrap(), &vec![json!(SERVER), json!(DM), json!(["m01", "m05"]), json!(SERVER), json!(format!("user:{CAROL}"))]);
    assert_eq!(app.read(cx, |state| (state.overlay.clone(), state.servers[SERVER].active_key.clone())), (None, Some(format!("user:{CAROL}"))));
}

#[gpui::test]
fn leaving_a_server_watching_youtube_and_joining_on_this_device(cx: &mut TestAppContext) {
    // Leaving the server signs this device out of it and forgets it here.
    let app = open(cx, "dialog-leave", Overlay::LeaveServer);
    app.answer("leaveServer", |_| Ok(Value::Null));
    app.click(cx, "leave");
    assert_eq!(app.calls_of("leaveServer"), vec![vec![json!(SERVER)]]);
    assert!(app.read(cx, |state| !state.servers.contains_key(SERVER)));

    // A click beside a dialog puts it away, and so does Escape.
    let app = open(cx, "dialog-beside", Overlay::LeaveServer);
    let mut window = gpui::VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_click(gpui::point(gpui::px(4.), gpui::px(600.)), gpui::Modifiers::none());
    app.run(cx);
    assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
    std::thread::sleep(std::time::Duration::from_millis(200));
    app.update(cx, |state, cx| state.set_overlay(Some(Overlay::LeaveServer), cx));
    let view = dialog(&app, cx);
    app.window.update(cx, |_, window, cx| view.read(cx).focus.clone().focus(window, cx)).unwrap();
    gpui::VisualTestContext::from_window(app.window.into(), cx).simulate_keystrokes("escape");
    app.run(cx);
    assert_eq!(app.read(cx, |state| state.overlay.clone()), None);

    // YouTube, asked about first: then a link to put on, which waits for a voice channel.
    let app = open(cx, "dialog-youtube", Overlay::WatchConsent { then_link: true });
    app.click(cx, "watch-agree");
    assert!(app.read(cx, |state| state.settings.play_youtube));
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::WatchLink));
    name(&app, cx, "https://youtu.be/dQw4w9WgXcQ");
    let view = dialog(&app, cx);
    let input = cx.read(|cx| view.read(cx).name.clone());
    input.update(cx, |_, cx| cx.emit(InputEvent::Submit));
    app.run(cx);
    assert_eq!(cx.read(|cx| view.read(cx).link_error.clone()), Some("Join the voice channel to watch together.".into()));
    input.update(cx, |_, cx| cx.emit(InputEvent::Escape));
    app.run(cx);
    assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
    let app = open(cx, "dialog-youtube-watch", Overlay::WatchConsent { then_link: false });
    app.click(cx, "watch-agree");
    assert_eq!(app.read(cx, |state| state.overlay.clone()), None, "the video in the room plays");

    // Another device of theirs is in a room: wherever that is, said in words, and cancelled.
    for from in [LOUNGE, GENERAL, "c-news", DM, GROUP, "g-unknown"] {
        let moving = crate::voice::VoiceMove { server_id: SERVER.into(), channel_id: if from == DM { DM.into() } else { LOUNGE.into() }, return_to: None, how: Default::default(), from: from.into() };
        let app = open(cx, &format!("dialog-move-{from}"), Overlay::MoveVoice(moving));
        assert!(app.drawn(cx, "move-voice"), "{from}");
        app.click(cx, "cancel");
        assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
    }
}
