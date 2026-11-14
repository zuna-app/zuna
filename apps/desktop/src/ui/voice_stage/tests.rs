//! The voice stage and the voice panel, drawn for a device that's in a voice channel or a call:
//! who's there, who's speaking or playing a sound, muted, deafened or muted by an admin, the
//! connection's quality, the soundboard and stream stats open, something on to watch, and the
//! stage of a call above its chat. The room itself, which LiveKit holds, isn't there: the stage
//! draws from what the core and this device say.

use gpui::TestAppContext;
use serde_json::json;

use crate::models::{VoiceMember, WatchVideoView, WatchView};
use crate::testing::fixtures::*;
use crate::testing::{App, World};
use crate::voice::room::Quality;
use crate::voice::{Voice, VoiceStatus};

fn voice(cx: &mut TestAppContext) -> gpui::Entity<Voice> {
    cx.update(|cx| crate::voice::get(cx).expect("the tests start voice"))
}

/// This device in a channel or call, as the core and voice would have it once joined.
fn join(app: &App, cx: &mut TestAppContext, channel: &str, call: bool) {
    voice(cx).update(cx, |voice, cx| {
        voice.status = VoiceStatus::Connected;
        voice.server_id = Some(SERVER.into());
        voice.channel_id = Some(channel.into());
        voice.call = call;
        cx.notify();
    });
    app.update(cx, |state, cx| {
        let server = state.servers.get_mut(SERVER).unwrap();
        server.voice.insert("d-1".into(), VoiceMember { channel_id: channel.into(), user_id: ME.into(), device_id: "d-1".into(), since: NOW, ..Default::default() });
        server.voice.insert("d-carol".into(), VoiceMember { channel_id: channel.into(), user_id: CAROL.into(), device_id: "d-carol".into(), deafened: true, server_muted: true, camera: true, since: NOW, ..Default::default() });
        cx.notify();
    });
}

/// Changes what voice says, and lets the window draw it.
fn set(app: &App, cx: &mut TestAppContext, change: impl FnOnce(&mut Voice)) {
    voice(cx).update(cx, |voice, cx| {
        change(voice);
        cx.notify();
    });
    app.run(cx);
}

#[gpui::test]
fn a_voice_channels_stage(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("stage"));
    crate::ui::motion::set_reduced(true);
    app.update(cx, |state, cx| state.select_server(SERVER, cx));
    join(&app, cx, LOUNGE, false);
    app.update(cx, |state, cx| state.select_conversation(Some(format!("group:{LOUNGE}")), cx));
    assert!(app.window.update(cx, |root, _, _| root.stage.is_some()).unwrap(), "the channel this device is in shows its stage");

    set(&app, cx, |voice| {
        voice.speaking.insert(BOB.into());
        voice.sounding.insert(CAROL.into(), "💥".into());
        voice.volumes.insert(BOB.into(), 0.4);
        voice.local_mutes.insert(CAROL.into());
        voice.quality = Quality::Poor;
        voice.rtt = Some(180);
    });
    for quality in [Quality::Excellent, Quality::Good, Quality::Lost, Quality::Unknown] {
        set(&app, cx, |voice| voice.quality = quality);
    }
    set(&app, cx, |voice| {
        voice.muted = true;
        voice.deafened = true;
    });
    set(&app, cx, |voice| {
        voice.muted = false;
        voice.deafened = false;
        voice.server_muted = true;
    });
    set(&app, cx, |voice| {
        voice.server_muted = false;
        voice.no_mic = true;
    });
    set(&app, cx, |voice| voice.soundboard_open = true);
    set(&app, cx, |voice| {
        voice.soundboard_open = false;
        voice.stats_open = true;
    });
    set(&app, cx, |voice| voice.stats_open = false);

    // A video on to watch together, which nobody here has pressed Watch for.
    let video = |playing: bool| WatchView {
        session: "w1".into(),
        video: WatchVideoView { id: "dQw4w9WgXcQ".into(), started_by: BOB.into(), title: "A video".into(), author: "Someone".into(), image: None },
        playing,
        position: 42_000.,
        at: NOW,
        rate: 1.,
        changed_by: BOB.into(),
    };
    set(&app, cx, |voice| voice.watch = Some(video(true)));
    set(&app, cx, |voice| voice.watch = Some(video(false)));
    set(&app, cx, |voice| voice.watch = None);

    // Joining and coming back draw their own states.
    for status in [VoiceStatus::Connecting, VoiceStatus::Reconnecting, VoiceStatus::Connected] {
        set(&app, cx, |voice| voice.status = status);
    }
    // Someone joining and leaving, as the core says it.
    app.event(cx, json!({ "type": "voice", "serverId": SERVER, "deviceId": "d-bob2", "member": { "channelId": LOUNGE, "userId": BOB, "deviceId": "d-bob2", "since": NOW } }));
    app.event(cx, json!({ "type": "voice", "serverId": SERVER, "deviceId": "d-bob2", "member": null }));

    // Away from the channel, the panel still says where this device is.
    app.update(cx, |state, cx| state.select_conversation(Some(format!("user:{BOB}")), cx));
    assert!(app.window.update(cx, |root, _, _| root.stage.is_none()).unwrap());
    set(&app, cx, |voice| voice.status = VoiceStatus::Idle);
}

#[gpui::test]
fn a_calls_stage_above_its_chat(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("call-stage"));
    crate::ui::motion::set_reduced(true);
    app.update(cx, |state, cx| state.select_server(SERVER, cx));
    join(&app, cx, DM, true);
    app.update(cx, |state, cx| state.select_conversation(Some(format!("user:{BOB}")), cx));
    set(&app, cx, |voice| {
        voice.speaking.insert(ME.into());
    });
    set(&app, cx, |voice| voice.muted = true);
    // Ringing Bob, who hasn't answered.
    app.event(cx, json!({ "type": "call", "serverId": SERVER, "groupId": DM, "call": { "groupId": DM, "startedBy": ME, "startedAt": NOW, "ringing": [BOB], "declined": [] } }));
    app.event(cx, json!({ "type": "call", "serverId": SERVER, "groupId": DM, "call": null }));
    set(&app, cx, |voice| voice.status = VoiceStatus::Idle);
}

/// A video's picture, as LiveKit's decoder hands it over.
fn feed(width: u32, height: u32) -> crate::voice::room::Feed {
    let buffer = image::RgbaImage::from_pixel(width, height, image::Rgba([40, 120, 200, 255]));
    let image = std::sync::Arc::new(gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
    let frame = crate::voice::room::Frame { width, height, image: Some(image), serial: 1, #[cfg(target_os = "macos")] surface: None };
    std::sync::Arc::new(parking_lot::Mutex::new(Some(frame)))
}

fn tile(key: &str, user: &str, source: crate::voice::room::VideoSource, sound: bool, local: bool, (width, height): (u32, u32)) -> crate::voice::room::VideoTile {
    crate::voice::room::VideoTile { key: key.into(), user_id: user.into(), identity: user.into(), source, local, sound, feed: feed(width, height) }
}

/// Where something is drawn.
fn bounds(app: &App, cx: &mut TestAppContext, id: &str) -> gpui::Bounds<gpui::Pixels> {
    let selector: &'static str = Box::leak(id.to_string().into_boxed_str());
    let mut window = gpui::VisualTestContext::from_window(app.window.into(), cx);
    window.debug_bounds(selector).unwrap_or_else(|| panic!("{id} is drawn"))
}

fn right_click(app: &App, cx: &mut TestAppContext, id: &str) -> Vec<String> {
    let at = bounds(app, cx, id).center();
    let mut window = gpui::VisualTestContext::from_window(app.window.into(), cx);
    window.simulate_event(gpui::MouseDownEvent { position: at, modifiers: gpui::Modifiers::none(), button: gpui::MouseButton::Right, click_count: 1, first_mouse: false });
    app.run(cx);
    cx.read(|cx| crate::ui::menu::open_labels(cx))
}

fn choose(app: &App, cx: &mut TestAppContext, label: &str) {
    assert!(app.window.update(cx, |_, window, cx| crate::ui::menu::choose(label, window, cx)).unwrap(), "{label} is in the menu");
    app.run(cx);
}

#[gpui::test]
fn the_stages_videos_their_menus_focus_and_full_screen(cx: &mut TestAppContext) {
    let mut world = World::new("stage-videos");
    world.server["getCalls"] = json!([]);
    let app = App::open(cx, &world);
    crate::ui::motion::set_reduced(true);
    for method in ["voiceMute", "voiceDisconnect", "voiceScreenStopOf"] {
        app.answer(method, |_| Ok(serde_json::Value::Null));
    }
    app.update(cx, |state, cx| {
        state.settings.reduce_motion = true;
        state.select_server(SERVER, cx);
    });
    join(&app, cx, LOUNGE, false);
    app.update(cx, |state, cx| state.select_conversation(Some(format!("group:{LOUNGE}")), cx));
    use crate::voice::room::VideoSource::{Camera, Screen};
    set(&app, cx, |voice| {
        voice.videos = vec![
            tile("carol-camera", CAROL, Camera, false, false, (640, 360)),
            tile("bob-screen", BOB, Screen, true, false, (1280, 720)),
            tile("my-screen", ME, Screen, false, true, (400, 600)),
        ];
    });
    // Someone's menu, from a right click on them: what this device can do, and as the server's
    // owner, what everyone's can.
    let labels = right_click(&app, cx, "person-d-carol");
    assert_eq!(labels, ["Mute for me", "Verify with emoji", "Let them talk", "Disconnect"]);
    choose(&app, cx, "Mute for me");
    assert!(voice(cx).read_with(cx, |voice, _| voice.local_mutes.contains(CAROL)));
    right_click(&app, cx, "person-d-carol");
    choose(&app, cx, "Let them talk");
    assert_eq!(app.calls_of("voiceMute"), vec![vec![json!(LOUNGE), json!(CAROL), json!(false)]]);
    right_click(&app, cx, "person-d-carol");
    choose(&app, cx, "Disconnect");
    assert_eq!(app.calls_of("voiceDisconnect"), vec![vec![json!(LOUNGE), json!(CAROL)]]);
    right_click(&app, cx, "person-d-bob");
    assert!(cx.read(|cx| crate::ui::menu::open_labels(cx)).contains(&"Stop their screen share".to_string()));
    choose(&app, cx, "Stop their screen share");
    assert_eq!(app.calls_of("voiceScreenStopOf"), vec![vec![json!(LOUNGE), json!(BOB)]]);
    // On this device's own tile, what its buttons do.
    let own = right_click(&app, cx, "person-d-1");
    assert!(own.contains(&"Voice settings".to_string()) && own.contains(&"Deafen".to_string()));
    choose(&app, cx, "Voice settings");
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(crate::state::Overlay::Settings { section: Some("voice".into()) }));
    app.update(cx, |state, cx| state.set_overlay(None, cx));

    // A camera fills the stage, cropped to it, and a click puts it back among the others.
    app.click(cx, "person-d-carol");
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.focus.clone()).as_deref(), Some("carol-camera"));
    app.click(cx, "focused-camera");
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.focus.clone()), None);
    // A shared screen is pinned, its sound muted here, and made full screen and back.
    app.click(cx, "screen-pin-bob-screen");
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.focus.clone()).as_deref(), Some("bob-screen"));
    app.click(cx, "screen-mute-bob-screen");
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.stream_volumes.get(BOB).copied()), Some(0.));
    app.click(cx, "screen-mute-bob-screen");
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.stream_volumes.get(BOB).copied()), Some(1.));
    app.click(cx, "screen-full-bob-screen");
    let stage = app.window.update(cx, |root, _, _| root.stage.clone()).unwrap().expect("the stage is open").1;
    assert_eq!(cx.read(|cx| stage.read(cx).full_screen.as_ref().map(|(key, _)| key.clone())).as_deref(), Some("bob-screen"));
    app.click(cx, "screen-full-bob-screen-full");
    assert!(cx.read(|cx| stage.read(cx).full_screen.is_none()), "and back");
    app.click(cx, "screen-pin-bob-screen");
    assert_eq!(voice(cx).read_with(cx, |voice, _| voice.focus.clone()), None);
    // Someone's screen, from a right click on it.
    let labels = right_click(&app, cx, "screen-tile-bob-screen");
    assert!(labels.contains(&"Mute for me".to_string()));
    // A share is drawn in the shape of its picture: a phone's held upright is tall, where a 16:9
    // tile left it a strip down the middle, and fills the stage as tall as it has room for.
    let shape = |bounds: gpui::Bounds<gpui::Pixels>| f32::from(bounds.size.width) / f32::from(bounds.size.height);
    assert!((shape(bounds(&app, cx, "screen-tile-bob-screen")) - 16. / 9.).abs() < 0.02);
    let among = bounds(&app, cx, "screen-tile-my-screen");
    assert!(shape(among) < 1., "a tall share's tile is tall among the others: {among:?}");
    set(&app, cx, |voice| voice.focus = Some("my-screen".into()));
    let filling = bounds(&app, cx, "screen-tile-my-screen");
    assert!((shape(filling) - 400. / 600.).abs() < 0.02 && filling.size.height > among.size.height, "and filling the stage: {filling:?}");
    set(&app, cx, |voice| voice.focus = None);
    set(&app, cx, |voice| voice.videos.clear());
}
