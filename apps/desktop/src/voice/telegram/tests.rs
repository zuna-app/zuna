//! A Telegram call as the app draws and drives it: ringing as a call of Zuna's does, with
//! "(Telegram)", answered, its screen with the four emoji and none of what Telegram's calls
//! haven't, the peer connection made from what the core says, ended with its words, and the card
//! that asks how it was. The core is the tests' stand-in, and the peer connection is libwebrtc's.

use gpui::TestAppContext;
use serde_json::{Value, json};

use super::TELEGRAM;
use crate::testing::{App, World};
use crate::voice::{Voice, VoiceStatus};

const GRACE: &str = "2000";
const CALL: i64 = 71;

fn voice(cx: &mut TestAppContext) -> gpui::Entity<Voice> {
    cx.update(|cx| crate::voice::get(cx).expect("the tests start voice"))
}

/// The fixtures' world with a Telegram account linked, and a chat in it with Grace.
fn world() -> World {
    let mut world = World::new("telegram-call");
    // Nothing of the server's ringing over the chat's header.
    world.server.insert("getCalls".into(), json!([]));
    world.client["listServers"].as_array_mut().unwrap().push(json!({ "id": TELEGRAM, "kind": "telegram", "name": "Telegram", "username": "ada", "userId": "1000" }));
    world.telegram.insert("getSelf".into(), json!({ "userId": "1000", "username": "ada", "role": "member", "deviceId": "" }));
    world.telegram.insert("getConnectionState".into(), json!("online"));
    world.telegram.insert("getUsers".into(), json!([
        { "id": "1000", "username": "ada", "displayName": "Ada Lovelace", "role": "member", "isSelf": true },
        { "id": GRACE, "username": "grace", "displayName": "Grace Hopper", "role": "member" },
    ]));
    world.telegram.insert("loadMessages".into(), json!({ "messages": [], "hasMore": false }));
    world.telegram.insert("getConversations".into(), json!([{ "key": format!("user:{GRACE}"), "kind": "dm", "groupId": GRACE, "peerId": GRACE, "title": "Grace Hopper", "ready": true, "lastActivityAt": 0, "members": [] }]));
    world
}

fn call(state: &str, extra: Value) -> Value {
    let mut call = json!({ "id": CALL, "groupId": GRACE, "userId": GRACE, "outgoing": false, "video": false, "state": state, "received": true, "connectedAt": null, "emoji": [], "remote": { "muted": false, "camera": false, "screen": false, "lowBattery": false }, "ended": null, "endedText": "", "rate": false });
    if let (Some(call), Value::Object(extra)) = (call.as_object_mut(), extra) {
        call.extend(extra);
    }
    call
}

fn said(app: &App, cx: &mut TestAppContext, call: Value) {
    app.event(cx, json!({ "type": "telegram_call", "serverId": TELEGRAM, "call": call }));
}

#[gpui::test]
fn a_telegram_call_rings_is_answered_shown_and_ended(cx: &mut TestAppContext) {
    let app = App::open(cx, &world());
    crate::ui::motion::set_reduced(true);
    app.answer("answerCall", |_| Ok(Value::Null));
    app.answer("callSaid", |_| Ok(Value::Null));
    app.answer("callConnection", |_| Ok(Value::Null));
    app.answer("callCandidate", |_| Ok(Value::Null));
    // The core gives the offer back as it may be set: as it is, here.
    app.answer("callOffer", |args| Ok(args[1].clone()));
    app.answer("rateCall", |_| Ok(Value::Null));

    // It rings as a call of Zuna's does.
    app.event(cx, json!({ "type": "call", "serverId": TELEGRAM, "groupId": GRACE, "call": { "groupId": GRACE, "startedBy": GRACE, "startedAt": 1.0, "ringing": ["1000"], "declined": [] } }));
    said(&app, cx, call("ringing", json!({})));
    let incoming = app.read(cx, |state| crate::voice::incoming_calls(state, None, None).into_iter().filter(|item| item.server_id == TELEGRAM).count());
    assert_eq!(incoming, 1);

    // Answered: in the call, connecting, the core asked to accept it.
    voice(cx).update(cx, |voice, cx| voice.join(TELEGRAM.into(), GRACE.into(), None, Default::default(), cx));
    app.run(cx);
    assert_eq!(app.calls_of("answerCall"), vec![vec![json!(CALL)]]);
    assert!(voice(cx).read_with(cx, |voice, _| voice.in_telegram()));
    app.event(cx, json!({ "type": "call", "serverId": TELEGRAM, "groupId": GRACE, "call": { "groupId": GRACE, "startedBy": GRACE, "startedAt": 1.0, "ringing": [], "declined": [] } }));
    said(&app, cx, call("connecting", json!({ "emoji": ["🐶", "🚗", "🌵", "🎻"] })));
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.status), VoiceStatus::Connecting);

    // The peer connection, from what the core said: relays at Telegram's addresses, and an offer it was asked for.
    let media = |media: Value| json!({ "type": "telegram_call_media", "serverId": TELEGRAM, "callId": CALL, "media": media });
    app.event(cx, media(json!({ "do": "open", "caller": false, "servers": [{ "urls": ["turn:149.154.167.51:1400?transport=udp"], "username": "u", "password": "p" }] })));
    app.event(cx, media(json!({ "do": "offer", "receive": { "audio": 1, "video": 1 } })));
    app.settle(cx, |_| true);
    for _ in 0..50 {
        if !app.calls_of("callOffer").is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        app.run(cx);
    }
    let offered = app.calls_of("callOffer");
    assert_eq!(offered.len(), 1, "the peer connection made its offer and gave it to the core");
    let sdp = offered[0][1].as_str().unwrap();
    assert!(sdp.contains("a=recvonly") && sdp.contains("a=sendonly") && sdp.contains("m=application"));

    // On: the stage, with the emoji, and none of what Telegram's calls haven't.
    said(&app, cx, call("on", json!({ "emoji": ["🐶", "🚗", "🌵", "🎻"], "connectedAt": 1_700_000_000_000.0 })));
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.status), VoiceStatus::Connected);
    app.update(cx, |state, cx| {
        state.select_server(TELEGRAM, cx);
        state.select_conversation(Some(format!("user:{GRACE}")), cx);
    });
    assert!(app.drawn(cx, "telegram-call-label"), "the call says it's Telegram's");
    assert!(app.drawn(cx, "camera-control") && app.drawn(cx, "leave-control"));
    assert!(!app.drawn(cx, "watch-control") && !app.drawn(cx, "soundboard-control"), "nothing Telegram's calls haven't");
    // A screen can be shared into it from where it comes already encoded, without the computer's sound.
    #[cfg(not(target_os = "macos"))]
    {
        app.click(cx, "share-control");
        assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(crate::state::Overlay::ScreenPicker));
        assert!(!app.drawn(cx, "screen-sound"), "a Telegram call takes the picture alone");
        app.update(cx, |state, cx| state.set_overlay(None, cx));
    }
    #[cfg(target_os = "macos")]
    assert!(!app.drawn(cx, "share-control"), "not yet from macOS");
    assert!(app.read(cx, |state| state.servers[TELEGRAM].voice.values().any(|member| member.user_id == GRACE)), "the other person is drawn as in the call");

    // The other side's picture comes before it says its camera's on, as Telegram's apps say it:
    // shown once it does, and gone once it says it's off.
    let pictures = |cx: &mut TestAppContext| voice(cx).read_with(cx, |voice, _| voice.videos.iter().filter(|video| !video.local).count());
    voice(cx).read_with(cx, |voice, _| voice.telegram_media.clone()).expect("the call's peer connection").picture_arrived();
    app.settle(cx, |_| true);
    assert_eq!(pictures(cx), 0, "nothing's shown before the other side says its camera's on");
    let camera = |on: bool| json!({ "emoji": ["🐶", "🚗", "🌵", "🎻"], "connectedAt": 1_700_000_000_000.0, "remote": { "muted": false, "camera": on, "screen": false, "lowBattery": false } });
    said(&app, cx, call("on", camera(true)));
    assert_eq!(pictures(cx), 1, "the other side's picture shows once it says its camera's on");
    said(&app, cx, call("on", camera(false)));
    assert_eq!(pictures(cx), 0, "and goes once it says it's off");

    // Muting tells the core, which tells the other side.
    voice(cx).update(cx, |voice, cx| voice.toggle_mute(cx));
    app.run(cx);
    assert_eq!(app.calls_of("callSaid").last().unwrap()[1]["muted"], json!(true));

    // Over, from the other side: its words, and the card asking how it was.
    said(&app, cx, call("over", json!({ "ended": "hungUp", "endedText": "Call ended", "rate": true })));
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.status), VoiceStatus::Idle);
    assert!(app.toasts(cx).contains(&"Call ended".to_string()));
    assert!(!app.read(cx, |state| state.servers[TELEGRAM].voice.values().any(|member| member.user_id == GRACE)));
    app.click(cx, "rate-3");
    app.click(cx, "rate-problem-echo");
    app.click(cx, "rate-send");
    assert_eq!(app.calls_of("rateCall"), vec![vec![json!(CALL), json!(3), json!(["echo"])]]);
    assert!(!app.drawn(cx, "rate-send"), "the card goes once it's said");
}

#[gpui::test]
fn a_telegram_chat_has_call_buttons_that_call_on_telegram(cx: &mut TestAppContext) {
    let app = App::open(cx, &world());
    crate::ui::motion::set_reduced(true);
    app.answer("startCall", |_| Ok(json!(CALL)));
    app.update(cx, |state, cx| {
        state.select_server(TELEGRAM, cx);
        state.select_conversation(Some(format!("user:{GRACE}")), cx);
    });
    app.click(cx, "call-video");
    assert_eq!(app.calls_of("startCall"), vec![vec![json!(GRACE), json!({ "video": true })]]);
    assert!(voice(cx).read_with(cx, |voice, _| voice.in_telegram()), "calling, this device is in the call");
    // Declined by Grace: it ends, saying so.
    said(&app, cx, call("over", json!({ "outgoing": true, "ended": "declined", "endedText": "Grace Hopper declined the call" })));
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.status), VoiceStatus::Idle);
    assert!(app.toasts(cx).contains(&"Grace Hopper declined the call".to_string()));
}
