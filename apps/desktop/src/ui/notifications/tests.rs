//! The app's own notifications on Windows: what the core says to notify about becomes cards,
//! three at a time with the rest waiting, which fade, stop fading under the mouse, open their
//! chat, take a reply, and go once read elsewhere.

use std::time::{Duration, Instant};

use gpui::{Entity, TestAppContext};
use serde_json::json;

use super::*;
use crate::testing::fixtures::*;
use crate::testing::{App, World};

fn center(cx: &mut TestAppContext) -> Entity<NotificationCenter> {
    cx.update(|cx| super::center(cx).expect("the tests install the center"))
}

/// Cards showing, cards waiting, and whether "Hide all" shows.
fn counts(center: &Entity<NotificationCenter>, cx: &mut TestAppContext) -> (usize, usize, bool) {
    cx.read(|cx| {
        let center = center.read(cx);
        (center.live().count(), center.waiting.len(), center.hide_all.is_some())
    })
}

fn ids(center: &Entity<NotificationCenter>, cx: &mut TestAppContext) -> Vec<u64> {
    cx.read(|cx| center.read(cx).live().map(|card| card.id).collect())
}

fn notify(app: &App, cx: &mut TestAppContext, key: &str, message_id: &str, body: &str) {
    app.event(cx, json!({ "type": "notify", "serverId": SERVER, "conversationKey": key, "title": "Bob", "body": body, "messageId": message_id }));
}

fn payload(key: &str, id: &str) -> Payload {
    Payload {
        title: "Someone".into(),
        body: "Someone: says something".into(),
        server_id: SERVER.into(),
        key: key.into(),
        message_id: id.into(),
        kind: "group".into(),
        picture: Some(Picture { image: None, initials: "S".into(), seed: "seed".into() }),
        can_reply: true,
        wait_for_input: false,
    }
}

#[gpui::test]
fn notifications_queue_open_and_go(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("notifications"));
    app.update(cx, |state, cx| state.select_server(SERVER, cx));
    let center = center(cx);

    // Five come in: three show and two wait, under "Hide all".
    let keys = [format!("user:{BOB}"), format!("group:{GROUP}"), format!("user:{BOT}"), format!("group:{GENERAL}"), format!("user:{ME}")];
    for (n, key) in keys.iter().enumerate() {
        notify(&app, cx, key, &format!("n{n}"), "Bob: hello there");
    }
    assert_eq!(counts(&center, cx), (3, 2, true));
    assert!(cx.read(|cx| center.read(cx).window.is_some()), "the cards have a window of their own");

    // Read elsewhere: that chat's card goes, and the next takes its place.
    center.update(cx, |center, cx| center.clear(Some(SERVER), Some(&[keys[0].clone()]), None, cx));
    assert_eq!(counts(&center, cx), (3, 1, true));
    center.update(cx, |center, cx| center.clear(None, None, Some("n1"), cx));
    assert_eq!(counts(&center, cx), (3, 0, true));

    // The mouse over them stops their fading, and leaving starts it again. (The test window's
    // mouse may be over a card as it draws, so each is checked before it draws again.)
    let (fading, steady) = center.update(cx, |center, cx| {
        center.hovered = false;
        center.set_hovered(true, cx);
        center.set_hovered(true, cx);
        center.set_hovered(false, cx);
        let fading = center.live().all(|card| card.fade.is_some_and(|fade| fade.to == 0.));
        center.set_hovered(true, cx);
        (fading, center.live().all(|card| card.fade.is_none_or(|fade| fade.to == 1.)))
    });
    assert!(fading && steady);

    // Opening one opens its chat, and reads it.
    let first = ids(&center, cx)[0];
    let key = cx.read(|cx| center.read(cx).shown.iter().find(|card| card.id == first).unwrap().payload.key.clone());
    center.update(cx, |center, cx| center.open(first, cx));
    app.run(cx);
    assert_eq!(app.read(cx, |state| state.servers[SERVER].active_key.clone()), Some(key));
    assert!(!ids(&center, cx).contains(&first));

    // Dismissed, and the rest hidden at once.
    let second = ids(&center, cx)[0];
    center.update(cx, |center, cx| center.dismiss(second, cx));
    assert!(!ids(&center, cx).contains(&second));
    center.update(cx, |center, cx| center.hide_everything(cx));
    assert_eq!(counts(&center, cx).0, 0);
    // Once they've faded, they're gone, and the window with them.
    let later = Instant::now() + Duration::from_secs(10);
    let going = center.update(cx, |center, cx| center.tick(later, cx));
    assert!(!going);
    assert!(cx.read(|cx| center.read(cx).shown.is_empty()));
    app.run(cx);
}

#[gpui::test]
fn a_reply_written_in_a_notification(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("notification-reply"));
    app.answer("sendMessage", |_| Ok(serde_json::Value::Null));
    let center = center(cx);
    center.update(cx, |center, cx| {
        center.show(payload(&format!("group:{GROUP}"), "m-7"), false, cx);
        center.show(payload(&format!("user:{BOB}"), "m-8"), true, cx);
    });
    app.run(cx);
    let id = ids(&center, cx)[0];
    let input = center.update(cx, |center, cx| center.start_reply(id, cx)).expect("a card takes a reply");
    assert!(cx.read(|cx| center.read(cx).typing));
    app.run(cx);
    // The card grows with the reply's lines.
    input.update(cx, |input, cx| input.set_text("Thanks,\nsee you\nthere", cx));
    let height = cx.read(|cx| {
        let center = center.read(cx);
        NotificationCenter::card_height(center.shown.iter().find(|card| card.id == id).unwrap(), cx)
    });
    assert!(height > CARD_HEIGHT, "a reply of three lines makes the card taller, not {height}");
    // Reading the chat elsewhere doesn't take away a reply being written.
    center.update(cx, |center, cx| center.clear(Some(SERVER), Some(&[format!("group:{GROUP}")]), None, cx));
    assert!(ids(&center, cx).contains(&id));
    // Nor does the mouse leaving start it fading.
    center.update(cx, |center, cx| center.set_hovered(false, cx));
    // An empty reply sends nothing.
    input.update(cx, |input, cx| input.set_text("   ", cx));
    center.update(cx, |center, cx| center.send_reply(id, cx));
    assert!(app.calls_of("sendMessage").is_empty());
    input.update(cx, |input, cx| input.set_text("Thanks!", cx));
    center.update(cx, |center, cx| center.send_reply(id, cx));
    app.run(cx);
    let sent = app.calls_of("sendMessage");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0][0], json!(format!("group:{GROUP}")));
    assert_eq!(sent[0][1]["text"], "Thanks!");
    assert_eq!(sent[0][1]["replyTo"], "m-7", "in a group, a reply answers the message");
    assert!(!ids(&center, cx).contains(&id));

    // Escape in a reply closes its card.
    let other = ids(&center, cx)[0];
    let input = center.update(cx, |center, cx| center.start_reply(other, cx)).unwrap();
    input.update(cx, |_, cx| cx.emit(InputEvent::Changed));
    input.update(cx, |_, cx| cx.emit(InputEvent::Escape));
    app.run(cx);
    assert!(!ids(&center, cx).contains(&other));
    assert!(!cx.read(|cx| center.read(cx).typing));
}

#[gpui::test]
fn cards_wait_for_someone_then_fade(cx: &mut TestAppContext) {
    let _app = App::open(cx, &World::new("notification-fades"));
    let center = center(cx);
    center.update(cx, |center, cx| {
        let mut waits = payload("user:u-x", "w");
        waits.wait_for_input = true;
        center.show(waits, false, cx);
        center.show(payload("user:u-y", "y"), false, cx);
    });
    // A while later, with someone at the computer: they start their time, and fade once it's up.
    let start = Instant::now();
    let (timed, gone, going, left) = center.update(cx, |center, cx| {
        center.hovered = false;
        center.check_input(start + Duration::from_secs(600));
        let timed = center.shown.iter().any(|card| card.payload.message_id == "y" && card.hide_at.is_some());
        // Its time up, it fades, which by then has long finished.
        center.tick(start + Duration::from_secs(700), cx);
        let gone = !center.shown.iter().any(|card| card.payload.message_id == "y");
        let going = center.tick(start + Duration::from_secs(800), cx);
        (timed, gone, going, !center.shown.is_empty())
    });
    assert!(timed && gone);
    // The one still waiting for input stays, or everything's gone.
    assert_eq!(going, left);

    // No more than a hundred wait.
    center.update(cx, |center, cx| {
        for n in 0..(MAX_WAITING + 10) {
            center.show(payload("user:u-z", &format!("z{n}")), true, cx);
        }
    });
    assert!(cx.read(|cx| center.read(cx).waiting.len()) <= MAX_WAITING);
    center.update(cx, |center, cx| center.hide_everything(cx));
}

#[test]
fn fades_ease_and_end() {
    assert!(slow_easing(0.).abs() < 0.01);
    assert!((slow_easing(1.) - 1.).abs() < 0.01);
    let mut last = 0.;
    for step in 1..=20 {
        let value = slow_easing(step as f32 / 20.);
        assert!(value >= last - 0.001, "the slow fade only goes one way");
        last = value;
    }
    let now = Instant::now();
    assert_eq!(fade_value(&None, false, now), (1., true));
    let fast = Some(Fade { from: 1., to: 0., start: now, duration: FAST, slow: false });
    assert_eq!(fade_value(&fast, false, now + FAST), (0., true));
    let slow = Some(Fade { from: 1., to: 0., start: now, duration: SLOW, slow: true });
    let (halfway, done) = fade_value(&slow, false, now + SLOW / 2);
    assert!(halfway > 0.5 && !done, "a slow fade stays nearly solid for most of it");
    // With motion reduced it stays solid, and then goes.
    assert_eq!(fade_value(&slow, true, now + SLOW / 2), (1., false));
    assert_eq!(fade_value(&slow, true, now + SLOW), (0., true));
}

/// What each card says, newest last, waiting ones included.
fn said(center: &Entity<NotificationCenter>, cx: &mut TestAppContext) -> Vec<(String, String)> {
    cx.read(|cx| {
        let center = center.read(cx);
        center.shown.iter().filter(|card| !card.gone).map(|card| &card.payload).chain(center.waiting.iter()).map(|payload| (payload.title.clone(), payload.body.clone())).collect()
    })
}

#[gpui::test]
fn what_a_notification_says(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("notification-preview"));
    let center = center(cx);
    for preview in ["full", "name", "none"] {
        app.update(cx, |state, _| state.settings.notification_preview = preview.into());
        notify(&app, cx, &format!("user:{BOB}"), preview, "Bob: hello there");
    }
    assert_eq!(
        said(&center, cx),
        vec![("Bob".into(), "Bob: hello there".into()), ("Bob".into(), "New message".into()), ("Zuna".into(), "New message".into())]
    );
    // Only the full preview can be written back to.
    assert_eq!(cx.read(|cx| center.read(cx).shown.iter().map(|card| card.payload.can_reply).collect::<Vec<_>>()), vec![true, false, false]);

    // Turned off, none come.
    app.update(cx, |state, _| state.settings.notifications = false);
    notify(&app, cx, &format!("user:{BOB}"), "off", "Bob: anyone?");
    assert_eq!(said(&center, cx).len(), 3);
    app.update(cx, |state, _| state.settings.notifications = true);

    // Signed out of a server, its notifications go.
    app.event(cx, json!({ "type": "signed_out", "serverId": SERVER, "reason": "banned" }));
    assert_eq!(counts(&center, cx).0, 0);

    // One for a chat with nothing unread any more goes once the list says so.
    app.update(cx, |state, _| state.settings.notification_preview = "full".into());
    notify(&app, cx, &format!("user:{BOT}"), "bot", "Helper: done");
    assert_eq!(counts(&center, cx).0, 1);
    app.event(cx, json!({ "type": "conversations", "serverId": SERVER }));
    app.run(cx);
    assert_eq!(counts(&center, cx).0, 0, "the bot's chat has nothing unread");
    // Deleted for everyone, a message's notification goes.
    notify(&app, cx, &format!("user:{BOB}"), "m-del", "Bob: oops");
    app.event(cx, json!({ "type": "message", "serverId": SERVER, "message": message("m-del", DM, 50.0, BOB, "", json!({ "deletedAt": NOW })) }));
    assert_eq!(counts(&center, cx).0, 0);
}

#[gpui::test]
fn calls_ring_and_are_missed(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("notification-calls"));
    let center = center(cx);
    let call = |group: &str, by: &str, ringing: &[&str], declined: &[&str]| json!({ "groupId": group, "startedBy": by, "startedAt": NOW, "ringing": ringing, "declined": declined });
    let event = |group: &str, call: serde_json::Value| json!({ "type": "call", "serverId": SERVER, "groupId": group, "call": call });
    // The fixtures' call in Bob's chat is ringing this person: it stops, unanswered, and is missed.
    app.event(cx, json!({ "type": "calls", "serverId": SERVER }));
    assert!(app.read(cx, |state| state.servers[SERVER].calls[DM].ringing.contains(&ME.to_string())));
    app.event(cx, event(DM, serde_json::Value::Null));
    assert_eq!(said(&center, cx), vec![("Bob".into(), "Missed call".into())]);
    // Bob calls again.
    app.event(cx, event(DM, call(DM, BOB, &[ME], &[])));
    assert_eq!(said(&center, cx).last().cloned(), Some(("Bob".into(), "Calling you".into())));
    // Declined isn't missed: the call's cards go, and nothing takes their place.
    app.event(cx, event(DM, call(DM, BOB, &[], &[ME])));
    assert_eq!(said(&center, cx), vec![]);

    // A call in a group names who started it, and with previews off, nobody.
    app.event(cx, event(BOT_DM, call(BOT_DM, BOB, &[ME], &[])));
    app.update(cx, |state, _| state.settings.notification_preview = "none".into());
    app.event(cx, event(BOT_DM, serde_json::Value::Null));
    assert_eq!(said(&center, cx).last().cloned(), Some(("Zuna".into(), "Missed call".into())));
    // Nothing for a muted group, or from someone blocked.
    let before = said(&center, cx).len();
    app.event(cx, event(GROUP, call(GROUP, BOB, &[ME], &[])));
    app.event(cx, event("g-dm-carol", call("g-dm-carol", CAROL, &[ME], &[])));
    // Nor for one that rings someone else.
    app.event(cx, event(DM, call(DM, BOB, &[CAROL], &[])));
    assert_eq!(said(&center, cx).len(), before);
}
