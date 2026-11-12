//! The state's own logic, driven as the window drives it: message lists loaded a page at a
//! time, jumped around in and read, what's picked, answered and edited, pictures and media
//! files from the core, and the core's events.

use gpui::TestAppContext;
use serde_json::{Value, json};

use super::fixtures::*;
use super::{App, World, refused};
use crate::models::{AvatarRef, MessageView};
use crate::state::{ClipState, MediaFile, Picture};

/// A page of plain messages from `from` to `to`, oldest first, as `loadMessages` gives it.
fn page(group: &str, from: f64, to: f64, has_more: bool) -> Value {
    let messages: Vec<Value> = (from as i64..=to as i64).map(|seq| message(&format!("m-{seq}"), group, seq as f64, BOB, &format!("Number {seq}"), json!({}))).collect();
    json!({ "messages": messages, "hasMore": has_more })
}

fn seqs(app: &App, cx: &mut TestAppContext, list: &str) -> Vec<i64> {
    app.read(cx, |state| state.lists.get(list).map(|list| list.items.iter().filter_map(|item| item.seq).map(|seq| seq as i64).collect()).unwrap_or_default())
}

fn view(id: &str, group: &str) -> MessageView {
    serde_json::from_value(message(id, group, 1.0, BOB, "Something", json!({}))).unwrap()
}

fn open_on_server(cx: &mut TestAppContext, world: &World) -> App {
    let app = App::open(cx, world);
    app.update(cx, |state, cx| state.select_server(SERVER, cx));
    app
}

#[gpui::test]
fn a_chat_loads_back_to_its_first_unread_message(cx: &mut TestAppContext) {
    let mut world = World::new("unread");
    world.server["getConversations"][0]["unread"] = json!(25);
    let app = open_on_server(cx, &world);
    app.answer("loadMessages", |args| {
        let newest = args.get(1).and_then(Value::as_f64).map_or(40.0, |before| before - 1.0);
        let oldest = (newest - 9.0).max(1.0);
        Ok(page(DM, oldest, newest, oldest > 1.0))
    });
    app.update(cx, |state, cx| state.load_list(DM, Some(DM.into()), cx));
    app.settle(cx, |state| state.lists.get(DM).is_some_and(|list| list.loaded));
    // Pages of ten, back until 25 unread are loaded.
    assert_eq!(seqs(&app, cx, DM), (11..=40).collect::<Vec<_>>());
    assert_eq!(app.calls_of("loadMessages"), vec![vec![json!(DM)], vec![json!(DM), json!(31.0)], vec![json!(DM), json!(21.0)]]);
    // Loaded once: asking again asks nothing.
    app.update(cx, |state, cx| state.load_list(DM, Some(DM.into()), cx));
    assert_eq!(app.calls_of("loadMessages").len(), 3);

    // Older pages, until there are none.
    app.update(cx, |state, cx| state.load_older(DM, cx));
    assert_eq!(seqs(&app, cx, DM), (1..=40).collect::<Vec<_>>());
    app.update(cx, |state, cx| state.load_older(DM, cx));
    assert_eq!(app.calls_of("loadMessages").len(), 4, "nothing older to ask for");

    // A chat with no group yet has nothing to load.
    app.update(cx, |state, cx| state.load_list("pending:user:u-new", None, cx));
    assert!(app.read(cx, |state| state.lists["pending:user:u-new"].loaded && !state.lists["pending:user:u-new"].has_more));
}

#[gpui::test]
fn a_list_that_wont_load_says_why(cx: &mut TestAppContext) {
    let app = open_on_server(cx, &World::new("unloadable"));
    app.answer("loadMessages", |_| Err(refused("The server is away.")));
    app.update(cx, |state, cx| state.load_list(GROUP, Some(GROUP.into()), cx));
    assert!(app.toasts(cx).contains(&"The server is away.".to_string()));
    assert!(app.read(cx, |state| !state.lists[GROUP].loading && !state.lists[GROUP].loaded));

    // An older page that won't come leaves the list as it was, ready to ask again.
    app.answer("loadMessages", |args| if args.len() == 1 { Ok(page(GROUP, 11.0, 20.0, true)) } else { Err(refused("Not now.")) });
    app.update(cx, |state, cx| state.load_list(GROUP, Some(GROUP.into()), cx));
    app.update(cx, |state, cx| state.load_older(GROUP, cx));
    assert_eq!(seqs(&app, cx, GROUP), (11..=20).collect::<Vec<_>>());
    assert!(app.read(cx, |state| !state.lists[GROUP].loading && state.lists[GROUP].has_more));
}

#[gpui::test]
fn jumping_to_a_message_and_reading_on(cx: &mut TestAppContext) {
    let app = open_on_server(cx, &World::new("jumping"));
    app.answer("loadMessages", |args| match args[0].as_str() {
        Some(DM) => Ok(page(DM, 31.0, 40.0, true)),
        // The newest, read once the window around an old message reaches them: some it has, some new.
        _ => Ok(page(GROUP, 25.0, 35.0, true)),
    });
    app.answer("messageById", |args| Ok(if args[1] == "m-gone" { Value::Null } else { json!({ "seq": 5 }) }));
    app.answer("loadAround", |_| Ok(page(GROUP, 1.0, 10.0, false)["messages"].clone()));
    app.answer("loadNewer", |args| {
        let after = args[1].as_f64().unwrap();
        Ok(page(GROUP, after + 1.0, after + 10.0, after + 10.0 < 25.0))
    });
    app.update(cx, |state, cx| state.load_list(DM, Some(DM.into()), cx));

    // One already loaded is scrolled to.
    app.update(cx, |state, cx| state.jump_to_message(DM, "m-35", cx));
    assert_eq!(app.read(cx, |state| state.jump_target.clone().map(|(list, id, _)| (list, id))), Some((DM.to_string(), "m-35".to_string())));
    assert!(app.calls_of("messageById").is_empty());

    // One that isn't opens a window around it.
    app.update(cx, |state, cx| state.jump_to_message(GROUP, "m-5", cx));
    assert_eq!(seqs(&app, cx, GROUP), (1..=10).collect::<Vec<_>>());
    assert!(app.read(cx, |state| state.lists[GROUP].detached && state.lists[GROUP].has_newer));
    assert_eq!(app.read(cx, |state| state.jump_target.clone().map(|(_, id, _)| id)), Some("m-5".to_string()));

    // A message that came meanwhile waits until the window reaches the newest.
    app.event(cx, json!({ "type": "message", "serverId": SERVER, "message": message("m-99", GROUP, 99.0, BOB, "Later", json!({})), "isNew": true }));
    assert!(!seqs(&app, cx, GROUP).contains(&99));

    // Reading on, a page at a time, and then what came since.
    app.update(cx, |state, cx| state.load_newer(GROUP, cx));
    assert_eq!(seqs(&app, cx, GROUP), (1..=20).collect::<Vec<_>>());
    app.update(cx, |state, cx| state.load_newer(GROUP, cx));
    assert_eq!(seqs(&app, cx, GROUP), (1..=35).collect::<Vec<_>>(), "caught up, with what the newest page adds");
    assert!(app.read(cx, |state| !state.lists[GROUP].has_newer));
    app.update(cx, |state, cx| state.load_newer(GROUP, cx));
    assert_eq!(app.calls_of("loadNewer").len(), 2, "nothing newer to ask for");

    // One that can't be found says so.
    app.update(cx, |state, cx| state.jump_to_message(GROUP, "m-gone", cx));
    assert!(app.toasts(cx).contains(&"That message isn't available.".to_string()));

    // Back to the newest.
    app.update(cx, |state, cx| state.return_to_latest(GROUP, cx));
    assert_eq!(seqs(&app, cx, GROUP), (25..=35).collect::<Vec<_>>());
    assert!(app.read(cx, |state| !state.lists[GROUP].detached));
}

#[gpui::test]
fn reading_picking_answering_and_editing(cx: &mut TestAppContext) {
    let app = open_on_server(cx, &World::new("picking"));
    app.forget_calls();
    app.update(cx, |state, cx| {
        state.mark_read(DM, 30.0, cx);
        state.mark_read(DM, 30.0, cx);
        state.mark_read(DM, 29.0, cx);
        state.mark_read(DM, 31.0, cx);
    });
    assert_eq!(app.calls_of("markRead"), vec![vec![json!(DM), json!(30.0)], vec![json!(DM), json!(31.0)]], "each position once, and only forward");

    let selection = |app: &App, cx: &mut TestAppContext| app.read(cx, |state| state.selection.clone());
    app.update(cx, |state, cx| {
        state.toggle_selected(DM, Some("a"), cx);
        state.toggle_selected(DM, Some("b"), cx);
        state.toggle_selected(DM, Some("a"), cx);
    });
    assert_eq!(selection(&app, cx), Some((DM.to_string(), vec!["b".to_string()])));
    app.update(cx, |state, cx| state.toggle_selected(GROUP, Some("c"), cx));
    assert_eq!(selection(&app, cx), Some((GROUP.to_string(), vec!["c".to_string()])), "picking in another chat starts over");
    app.update(cx, |state, cx| state.toggle_selected(GROUP, Some("c"), cx));
    assert_eq!(selection(&app, cx), None);
    app.update(cx, |state, cx| {
        state.toggle_selected(DM, Some("a"), cx);
        state.toggle_selected(DM, None, cx);
    });
    assert_eq!(selection(&app, cx), None);

    // Answering and editing take each other's place.
    app.update(cx, |state, cx| state.set_reply(DM, Some(view("m-1", DM)), cx));
    app.update(cx, |state, cx| state.set_editing(DM, Some(view("m-2", DM)), cx));
    assert!(app.read(cx, |state| !state.reply_to.contains_key(DM) && state.editing[DM].id == "m-2"));
    app.update(cx, |state, cx| state.set_reply(DM, Some(view("m-3", DM)), cx));
    assert!(app.read(cx, |state| !state.editing.contains_key(DM) && state.reply_to[DM].id == "m-3"));
    app.update(cx, |state, cx| {
        state.set_reply(DM, None, cx);
        state.set_editing(DM, None, cx);
    });
    assert!(app.read(cx, |state| state.reply_to.is_empty() && state.editing.is_empty()));
}

#[gpui::test]
fn messages_arrive_change_move_and_go(cx: &mut TestAppContext) {
    let app = open_on_server(cx, &World::new("arriving"));
    app.answer("loadMessages", |_| Ok(page(DM, 1.0, 3.0, false)));
    app.update(cx, |state, cx| state.load_list(DM, Some(DM.into()), cx));
    app.event(cx, json!({ "type": "typing", "serverId": SERVER, "groupId": DM, "userId": BOB }));
    assert!(app.read(cx, |state| state.servers[SERVER].typing[DM].contains_key(BOB)));
    app.event(cx, json!({ "type": "message", "serverId": SERVER, "message": message("m-4", DM, 4.0, BOB, "New", json!({})), "isNew": true }));
    assert!(app.read(cx, |state| !state.servers[SERVER].typing[DM].contains_key(BOB)), "a message stops its sender typing");
    app.event(cx, json!({ "type": "message", "serverId": SERVER, "message": message("m-2", DM, 2.0, BOB, "Changed", json!({ "editedAt": NOW })) }));
    assert_eq!(seqs(&app, cx, DM), vec![1, 2, 3, 4]);
    assert_eq!(app.read(cx, |state| state.lists[DM].items[1].text.clone()), "Changed");
    app.event(cx, json!({ "type": "message", "serverId": SERVER, "message": message("m-3", DM, 3.0, BOB, "", json!({ "deletedAt": NOW })) }));
    app.event(cx, json!({ "type": "message_removed", "serverId": SERVER, "groupId": DM, "id": "m-1" }));
    assert_eq!(seqs(&app, cx, DM), vec![2, 3, 4]);

    // A message sent before its chat had a group moves into it.
    app.event(cx, json!({ "type": "message_moved", "serverId": SERVER, "fromGroupId": format!("pending:user:{CAROL}"), "message": message("m-5", "g-dm-carol", 5.0, ME, "First", json!({})) }));
    assert_eq!(seqs(&app, cx, "g-dm-carol"), vec![5]);

    // Typing stops by itself after a while.
    app.event(cx, json!({ "type": "typing", "serverId": SERVER, "groupId": DM, "userId": CAROL }));
    cx.executor().advance_clock(std::time::Duration::from_secs(6));
    std::thread::sleep(std::time::Duration::from_millis(5));
    app.run(cx);

    // Someone reading, presence and the rest.
    app.event(cx, json!({ "type": "read", "serverId": SERVER, "groupId": DM, "userId": BOB, "seq": 40 }));
    assert_eq!(app.read(cx, |state| state.servers[SERVER].conversations[0].read_by[BOB]), 40.0);
    app.event(cx, json!({ "type": "read", "serverId": SERVER, "groupId": DM, "userId": ME, "seq": 50 }));
    app.event(cx, json!({ "type": "read", "serverId": SERVER, "groupId": DM }));
    app.event(cx, json!({ "type": "presence", "serverId": SERVER, "userId": BOB, "online": false, "lastSeenAt": NOW }));
    assert!(app.read(cx, |state| !state.servers[SERVER].users[BOB].online));
    app.event(cx, json!({ "type": "settings", "serverId": SERVER, "info": { "name": "Renamed", "has_icon": true } }));
    assert_eq!(app.read(cx, |state| state.servers[SERVER].entry.name.clone()), "Renamed");
    app.event(cx, json!({ "type": "voice", "serverId": SERVER, "deviceId": "d-carol", "member": { "channelId": LOUNGE, "userId": CAROL, "deviceId": "d-carol" } }));
    assert!(app.read(cx, |state| state.servers[SERVER].voice.contains_key("d-carol")));
    app.event(cx, json!({ "type": "voice", "serverId": SERVER, "deviceId": "d-carol", "member": null }));
    assert!(app.read(cx, |state| !state.servers[SERVER].voice.contains_key("d-carol")));
    app.event(cx, json!({ "type": "new_devices", "serverId": SERVER, "devices": [{ "id": "d-9", "name": "A new phone", "createdAt": NOW }] }));
    assert_eq!(app.read(cx, |state| state.servers[SERVER].new_devices.len()), 1);
    app.event(cx, json!({ "type": "signed_out", "serverId": SERVER, "reason": "account_deleted" }));
    app.event(cx, json!({ "type": "signed_out", "serverId": SERVER, "reason": "session" }));
    assert!(app.toasts(cx).contains(&"You've been signed out of a server.".to_string()));
    app.event(cx, json!({ "type": "signed_in", "serverId": SERVER }));
    assert_eq!(app.read(cx, |state| state.servers[SERVER].entry.signed_out.clone()), None);
    app.event(cx, json!({ "type": "something_new", "serverId": SERVER }));
}

/// A picture the core can decrypt, as `downloadFile` gives it.
fn png() -> Value {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(8, 8, image::Rgb([30, 120, 200])).write_to(&mut out, image::ImageFormat::Png).unwrap();
    crate::host::bytes(&out.into_inner())
}

/// A tenth of a second of a tone, as a WAV file.
fn wav() -> Vec<u8> {
    let rate = 8000u32;
    let samples: Vec<i16> = (0..rate / 10).map(|n| ((n as f32 * 0.3).sin() * 8000.) as i16).collect();
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

#[gpui::test]
fn pictures_and_media_files_from_the_core(cx: &mut TestAppContext) {
    let app = open_on_server(cx, &World::new("media"));
    app.answer("downloadFile", |args| match args[0]["fileId"].as_str() {
        Some("good") => Ok(png()),
        Some("sound") => Ok(crate::host::bytes(&wav())),
        Some("empty") => Ok(json!({})),
        _ => Err(refused("That file is gone.")),
    });
    let avatar = |id: &str| AvatarRef { file_id: id.into(), key: "a2V5".into(), prefix: "cHJlZml4".into(), chunks: 1., mime: "image/png".into() };

    // Decrypted once, and given from memory after.
    let first = app.state.update(cx, |state, cx| state.decrypted_picture(SERVER, &avatar("good"), cx));
    assert!(first.is_none(), "it's on its way");
    app.run(cx);
    let second = app.state.update(cx, |state, cx| state.decrypted_picture(SERVER, &avatar("good"), cx));
    assert!(second.is_some());
    assert_eq!(app.calls_of("downloadFile").len(), 1);
    for id in ["gone", "empty"] {
        app.state.update(cx, |state, cx| state.decrypted_picture(SERVER, &avatar(id), cx));
        app.run(cx);
        assert!(app.read(cx, |state| matches!(state.pictures.get(&format!("file:{id}")), Some(Picture::Failed(_)))));
        // A failed one isn't asked for again at once.
        assert!(app.state.update(cx, |state, cx| state.decrypted_picture(SERVER, &avatar(id), cx)).is_none());
    }
    assert_eq!(app.calls_of("downloadFile").len(), 3);

    // Pictures a server serves openly: the tests reach no network, so they fail, and aren't asked for again at once.
    for n in 0..3 {
        app.state.update(cx, |state, cx| state.remote_picture(&format!("https://server-1.example/emote/{n}"), cx));
    }
    app.run(cx);
    assert!(app.state.update(cx, |state, cx| state.remote_picture("https://server-1.example/emote/0", cx)).is_none());

    // A sound: its file, decrypted to disk with the extension it needs, then decoded.
    let attachment = |id: &str, mime: &str, name: &str| crate::models::Attachment { file_id: id.into(), key: "a2V5".into(), prefix: "cHJlZml4".into(), chunks: 1., name: name.into(), mime: mime.into(), size: 1600., ..Default::default() };
    let sound = attachment("sound", "audio/wav", "tone.wav");
    assert!(matches!(app.state.update(cx, |state, cx| state.clip(SERVER, &sound, cx)), ClipState::Loading));
    app.settle(cx, |state| !matches!(state.clips.get("sound"), Some(ClipState::Loading) | None));
    let Some(MediaFile::Ready(path)) = app.read(cx, |state| state.media_files.get("sound").cloned()) else { panic!("the sound's file wasn't saved") };
    assert_eq!(path.extension().unwrap(), "wav");
    assert!(matches!(app.read(cx, |state| state.clips.get("sound").cloned()), Some(ClipState::Ready(_))), "the sound decodes");
    assert!(matches!(app.state.update(cx, |state, cx| state.clip(SERVER, &sound, cx)), ClipState::Ready(_)));
    // Asked again, it's there.
    assert!(matches!(app.state.update(cx, |state, cx| state.media_file(SERVER, &sound, cx)), MediaFile::Ready(_)));

    // One that won't come.
    let gone = attachment("missing", "video/mp4", "clip.mp4");
    app.state.update(cx, |state, cx| state.clip(SERVER, &gone, cx));
    app.run(cx);
    assert!(matches!(app.read(cx, |state| state.media_files.get("missing").cloned()), Some(MediaFile::Failed)));
    assert!(matches!(app.state.update(cx, |state, cx| state.clip(SERVER, &gone, cx)), ClipState::Failed));
    app.state.update(cx, |state, cx| state.tick_media(cx));
    app.run(cx);
}
