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
