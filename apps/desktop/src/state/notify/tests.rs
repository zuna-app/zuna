//! Notifications on every system, as the state decides them: what each preview setting shows,
//! a chat's photo waited for, notifications taken back once their chat is read, calls ringing and
//! missed, replies written in a notification, and telling the core whether the person is here.
//! What would be shown is noted here (`SHOWN`), whichever system's notifications show it.

use std::cell::RefCell;
use std::time::Duration;

use gpui::TestAppContext;
use serde_json::{Value, json};

use crate::state::Picture;
use crate::testing::fixtures::*;
use crate::testing::{App, World, refused};
use crate::ui::notifications::Payload;

thread_local! {
    pub(super) static SHOWN: RefCell<Vec<Payload>> = const { RefCell::new(Vec::new()) };
}

/// What was shown since this was last asked.
fn shown() -> Vec<Payload> {
    SHOWN.with(|shown| std::mem::take(&mut *shown.borrow_mut()))
}

fn said(payloads: &[Payload]) -> Vec<(String, String)> {
    payloads.iter().map(|payload| (payload.title.clone(), payload.body.clone())).collect()
}

/// The app with its window behind, so that nothing it notifies about is held back as seen.
fn open(cx: &mut TestAppContext, world: &World) -> App {
    let app = App::open(cx, world);
    app.update(cx, |state, cx| {
        state.window_focused = false;
        state.select_server(SERVER, cx);
    });
    shown();
    app
}

fn notify(app: &App, cx: &mut TestAppContext, key: &str, message_id: &str) {
    app.event(cx, json!({ "type": "notify", "serverId": SERVER, "conversationKey": key, "title": "Bob", "body": "Bob: hi there", "messageId": message_id }));
}

const AVATAR: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// The fixtures' world, with a photo for Bob's chat, which the list decrypts as it draws, and the
/// lab removed from.
fn world(name: &str) -> World {
    let mut world = World::new(name);
    world.server["getConversations"][0]["avatar"] = json!({ "fileId": AVATAR, "key": "a2V5", "prefix": "cHJl", "chunks": 1, "mime": "image/png" });
    world.server["getConversations"][1]["removed"] = json!(true);
    world.server.insert("downloadFile".into(), json!({ "$bytes": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }));
    world
}

#[gpui::test]
fn a_notification_says_as_much_as_the_preview_setting_lets_it(cx: &mut TestAppContext) {
    let app = open(cx, &world("notify-previews"));
    let group = format!("group:{GROUP}");
    // In full: who and what, a picture, and a way to answer, except where the person was removed.
    app.event(cx, json!({ "type": "notify", "serverId": SERVER, "conversationKey": group, "title": "The lab", "body": "Bob: meeting", "messageId": "m-1" }));
    let full = shown();
    assert_eq!(said(&full), vec![("The lab".into(), "Bob: meeting".into())]);
    let picture = full[0].picture.as_ref().expect("a picture");
    assert_eq!((picture.initials.as_str(), picture.seed.as_str()), ("TL", GROUP));
    assert_eq!((full[0].kind.as_str(), full[0].message_id.as_str(), full[0].can_reply), ("group", "m-1", false));
    assert_eq!(app.read(cx, |state| state.notified[SERVER].contains_key(&group)), true);
    // By name: who, but not what.
    app.update(cx, |state, _| state.settings.notification_preview = "name".into());
    app.event(cx, json!({ "type": "notify", "serverId": SERVER, "conversationKey": "user:u-nobody", "title": "Nobody", "body": "secret", "messageId": "m-2" }));
    let named = shown();
    assert_eq!(said(&named), vec![("Nobody".into(), "New message".into())]);
    assert_eq!((named[0].kind.as_str(), named[0].can_reply), ("dm", false), "a chat the app doesn't know is a direct one");
    assert_eq!(named[0].picture.as_ref().unwrap().seed, "user:u-nobody");
    // None: nothing but that there's something.
    app.update(cx, |state, _| state.settings.notification_preview = "none".into());
    notify(&app, cx, &format!("user:{BOB}"), "m-3");
    let none = shown();
    assert_eq!(said(&none), vec![("Zuna".into(), "New message".into())]);
    assert!(none[0].picture.is_none());
    // Off: nothing at all, nor noted.
    app.update(cx, |state, _| {
        state.settings.notifications = false;
        state.notified.clear();
    });
    notify(&app, cx, &format!("user:{BOB}"), "m-4");
    assert!(shown().is_empty() && app.read(cx, |state| state.notified.is_empty()));

    // A chat open in front of the person isn't notified about, only one behind.
    app.update(cx, |state, cx| {
        state.settings.notifications = true;
        state.settings.notification_preview = "full".into();
        state.select_conversation(Some(format!("user:{CAROL}")), cx);
        state.window_focused = true;
    });
    let in_front = app.read(cx, |state| state.window_in_front());
    notify(&app, cx, &format!("user:{CAROL}"), "m-5");
    assert_eq!(shown().len(), if in_front { 0 } else { 1 });
}

#[gpui::test]
fn a_notification_waits_a_moment_for_its_chats_photo(cx: &mut TestAppContext) {
    let app = open(cx, &world("notify-photos"));
    let bob = format!("user:{BOB}");
    let key = format!("file:{}", crate::models::file_cache_id(AVATAR, "a2V5", "cHJl"));
    // One whose photo isn't decrypted yet asks for it, and shows with it once it is.
    app.update(cx, |state, _| {
        state.pictures.remove(&key);
    });
    app.forget_calls();
    notify(&app, cx, &bob, "m-1");
    let with_photo = shown();
    assert_eq!(with_photo.len(), 1);
    assert!(with_photo[0].picture.as_ref().unwrap().image.is_some(), "with the chat's photo");
    assert_eq!(app.calls_of("downloadFile")[0][0]["fileId"], AVATAR);
    assert!(app.read(cx, |state| state.waiting_notifications.is_empty()));

    // One whose photo is still on its way waits, and those behind it with it, for 400 ms at most.
    app.update(cx, |state, _| {
        state.pictures.insert(key.clone(), Picture::Loading);
    });
    app.events.unbounded_send(json!({ "type": "notify", "serverId": SERVER, "conversationKey": bob, "title": "Bob", "body": "first", "messageId": "m-2" })).unwrap();
    app.events.unbounded_send(json!({ "type": "notify", "serverId": SERVER, "conversationKey": format!("group:{GROUP}"), "title": "The lab", "body": "second", "messageId": "m-3" })).unwrap();
    cx.run_until_parked();
    assert!(shown().is_empty(), "both wait");
    assert_eq!(app.read(cx, |state| state.waiting_notifications.len()), 2);
    cx.executor().advance_clock(Duration::from_millis(450));
    cx.run_until_parked();
    let late = shown();
    assert_eq!(late.iter().map(|payload| payload.body.as_str()).collect::<Vec<_>>(), vec!["first", "second"], "in order");
    assert!(late[0].picture.as_ref().unwrap().image.is_none(), "with initials in place of the photo");

    // A photo that couldn't be had isn't waited for.
    app.update(cx, |state, _| {
        state.pictures.insert(key.clone(), Picture::Failed(std::time::Instant::now()));
    });
    notify(&app, cx, &bob, "m-4");
    assert_eq!(shown().len(), 1);
}

#[gpui::test]
fn reading_a_chat_takes_its_notifications_back(cx: &mut TestAppContext) {
    let app = open(cx, &world("notify-read"));
    let bob = format!("user:{BOB}");
    app.update(cx, |state, _| {
        state.pictures.insert(format!("file:{}", crate::models::file_cache_id(AVATAR, "a2V5", "cHJl")), Picture::Loading);
    });
    app.events.unbounded_send(json!({ "type": "notify", "serverId": SERVER, "conversationKey": bob, "title": "Bob", "body": "hi", "messageId": "m-1" })).unwrap();
    cx.run_until_parked();
    assert_eq!(app.read(cx, |state| state.waiting_notifications.len()), 1, "it waits for its photo");
    std::thread::sleep(Duration::from_millis(3));
    // Read on another device: the core's list says nothing's unread.
    let mut conversations = world("notify-read").server["getConversations"].clone();
    conversations[0]["unread"] = json!(0);
    app.answer("getConversations", move |_| Ok(conversations.clone()));
    app.event(cx, json!({ "type": "conversations", "serverId": SERVER }));
    assert!(app.read(cx, |state| state.waiting_notifications.is_empty() && !state.notified[SERVER].contains_key(&bob)));
    assert!(shown().is_empty(), "and what waited never shows");

    // Signed out: everything of the server's goes.
    notify(&app, cx, &format!("group:{GROUP}"), "m-2");
    shown();
    app.event(cx, json!({ "type": "signed_out", "serverId": SERVER, "reason": "removed" }));
    assert!(app.read(cx, |state| !state.notified.contains_key(SERVER)));
}

#[gpui::test]
fn calls_ring_and_are_missed_on_every_system(cx: &mut TestAppContext) {
    let app = open(cx, &world("notify-calls"));
    let call = |group: &str, by: &str, ringing: &[&str], declined: &[&str]| json!({ "groupId": group, "startedBy": by, "startedAt": NOW, "ringing": ringing, "declined": declined });
    let event = |group: &str, call: Value| json!({ "type": "call", "serverId": SERVER, "groupId": group, "call": call });
    // The fixtures' call in Bob's chat rings this person: it stops, unanswered, and is missed.
    app.event(cx, event(DM, Value::Null));
    assert_eq!(said(&shown()), vec![("Bob".into(), "Missed call".into())]);
    app.event(cx, event(DM, call(DM, BOB, &[ME], &[])));
    let ringing = shown();
    assert_eq!(said(&ringing), vec![("Bob".into(), "Calling you".into())]);
    assert_eq!((ringing[0].message_id.as_str(), ringing[0].can_reply), ("call:g-dm-bob", false));
    // Declined isn't missed.
    app.event(cx, event(DM, call(DM, BOB, &[], &[ME])));
    assert!(shown().is_empty());
    // In a group, who started it is named; with previews off, nobody is.
    app.event(cx, event(BOT_DM, call(BOT_DM, BOB, &[ME], &[])));
    app.update(cx, |state, _| state.settings.notification_preview = "none".into());
    app.event(cx, event(BOT_DM, Value::Null));
    assert_eq!(said(&shown()), vec![("Helper".into(), "Calling you".into()), ("Zuna".into(), "Missed call".into())]);
    // Nothing for a muted chat, someone blocked, a call ringing someone else, or with notifications off.
    app.event(cx, event(GROUP, call(GROUP, BOB, &[ME], &[])));
    app.event(cx, event("g-dm-carol", call("g-dm-carol", CAROL, &[ME], &[])));
    app.event(cx, event(DM, call(DM, BOB, &[CAROL], &[])));
    app.update(cx, |state, _| state.settings.notifications = false);
    app.event(cx, event(BOT_DM, call(BOT_DM, BOB, &[ME], &[])));
    assert!(shown().is_empty());
    // Answered on another device isn't missed.
    app.update(cx, |state, _| {
        state.settings.notifications = true;
        let member = crate::models::VoiceMember { channel_id: BOT_DM.into(), user_id: ME.into(), device_id: "d-2".into(), ..Default::default() };
        state.servers.get_mut(SERVER).unwrap().voice.insert("d-2".into(), member);
    });
    app.event(cx, event(BOT_DM, Value::Null));
    assert!(shown().is_empty());
    // With the window in front, a missed call is a toast, where the system says it's in front.
    app.update(cx, |state, _| {
        state.window_focused = true;
        state.toasts.clear();
        state.servers.get_mut(SERVER).unwrap().voice.clear();
    });
    let in_front = app.read(cx, |state| state.window_in_front());
    app.event(cx, event(DM, call(DM, BOB, &[ME], &[])));
    app.event(cx, event(DM, Value::Null));
    if in_front {
        assert!(shown().is_empty());
        assert_eq!(app.toasts(cx), vec!["Missed call from Bob.".to_string()]);
    } else {
        assert_eq!(shown().len(), 2);
    }
}

#[gpui::test]
fn a_reply_written_in_a_notification_reads_the_chat_and_answers(cx: &mut TestAppContext) {
    let app = open(cx, &world("notify-reply"));
    app.answer("sendMessage", |_| Ok(Value::Null));
    app.answer("markRead", |_| Ok(Value::Null));
    let group = format!("group:{GROUP}");
    app.forget_calls();
    app.update(cx, |state, cx| {
        state.send_notification_reply(SERVER, &group, "m-7", "  ", cx);
        state.send_notification_reply("server-9", &group, "m-7", "Hi", cx);
        state.send_notification_reply(SERVER, "group:nowhere", "m-7", "Hi", cx);
    });
    assert!(app.calls_of("sendMessage").is_empty() && app.calls_of("markRead").is_empty(), "nothing to send, or nowhere to send it");
    app.update(cx, |state, cx| state.send_notification_reply(SERVER, &group, "m-7", " Thanks, @bob! ", cx));
    assert_eq!(app.calls_of("markRead"), vec![vec![json!(GROUP), json!(20.0)]], "the chat is read to its newest");
    let sent = app.calls_of("sendMessage");
    assert_eq!(sent[0][0], json!(group));
    assert_eq!(sent[0][1]["text"], "Thanks, @bob!");
    assert_eq!(sent[0][1]["replyTo"], "m-7", "in a group, a reply answers the message");
    assert_eq!(sent[0][1]["mentions"], json!([BOB]));
    app.update(cx, |state, cx| state.send_notification_reply(SERVER, &format!("user:{BOB}"), "m-8", "Sure", cx));
    assert!(app.calls_of("sendMessage")[1][1].get("replyTo").is_none(), "in a direct chat it doesn't need to");
    app.answer("sendMessage", |_| Err(refused("Not now.")));
    app.update(cx, |state, cx| state.send_notification_reply(SERVER, &format!("user:{BOB}"), "m-9", "Again", cx));
    assert!(app.toasts(cx).contains(&"Not now.".to_string()));
}

#[gpui::test]
fn a_reply_passes_plugins_filters_first(cx: &mut TestAppContext) {
    let harness = crate::plugins::tests_running::Harness::open(cx, "replyfilter", &["messages.intercept"], |_| {});
    let app = &harness.app;
    app.answer("sendMessage", |_| Ok(Value::Null));
    harness.ask(cx, "filter.register", json!({ "id": "check", "kind": "outgoing", "required": true })).unwrap();
    let answer = |cx: &mut TestAppContext, value: Option<Value>| {
        let call = harness.sent(cx).into_iter().filter(|message| message["fn"] == "filter").last().expect("the filter is asked");
        match value {
            Some(value) => harness.say(cx, json!({ "t": "done", "n": call["n"], "ok": true, "value": value })),
            None => {
                cx.executor().advance_clock(Duration::from_millis(1600));
                cx.run_until_parked();
            }
        }
    };
    let reply = |cx: &mut TestAppContext, text: &str| app.update(cx, |state, cx| state.send_notification_reply(SERVER, &format!("user:{BOB}"), "m-1", text, cx));
    reply(cx, "teh reply");
    answer(cx, Some(json!({ "text": "the reply" })));
    assert_eq!(app.calls_of("sendMessage").last().unwrap()[1]["text"], "the reply", "as the plugin changed it");
    reply(cx, "secret");
    answer(cx, Some(json!({ "stop": true })));
    reply(cx, "slow");
    answer(cx, None);
    app.run(cx);
    assert_eq!(app.calls_of("sendMessage").len(), 1);
    let toasts = app.toasts(cx);
    assert!(toasts.contains(&"Plugin replyfilter kept your reply from going.".to_string()), "{toasts:?}");
    assert!(toasts.contains(&"Plugin replyfilter didn't answer, so your reply wasn't sent.".to_string()), "{toasts:?}");
}

#[gpui::test]
fn the_core_is_told_whether_the_person_is_here_and_where(cx: &mut TestAppContext) {
    let app = open(cx, &world("notify-activity"));
    app.forget_calls();
    app.update(cx, |state, cx| {
        state.reported_active = None;
        state.report_activity(cx);
        state.report_activity(cx);
    });
    let told = app.calls_of("setActive");
    assert_eq!(told, vec![vec![json!(false), json!(SERVER)]], "once, as nothing changed between");
    app.update(cx, |state, cx| {
        state.select_server(OTHER, cx);
        state.report_activity(cx);
    });
    assert_eq!(app.calls_of("setActive").last().unwrap(), &vec![json!(false), json!(OTHER)]);
    // While nobody is in front of the window, it looks again every few seconds.
    let before = app.calls_of("setActive").len();
    app.update(cx, |state, _| state.reported_active = None);
    cx.executor().advance_clock(Duration::from_secs(6));
    cx.run_until_parked();
    assert!(app.calls_of("setActive").len() > before);
    assert!(!app.read(cx, |state| state.person_here()), "behind other windows, nobody is here");
}
