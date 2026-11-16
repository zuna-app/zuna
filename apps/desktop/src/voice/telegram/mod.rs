//! A call on the linked Telegram account, as the device's one voice room (docs/TELEGRAM_CALLS_PLAN.md).
//! The core holds the call and its signalling, and says what the peer connection is to do
//! (`media.rs`); this is the rest of it here: starting, answering and hanging up, the microphone,
//! the camera and the speakers, which are the ones a room uses, and what the call's screen shows.
//! Starting or answering one leaves a voice channel or a call of Zuna's, and the other way.

pub mod media;
#[cfg(test)]
mod tests;

use super::*;
use crate::models::TelegramCallView;
use media::{MediaEvent, TelegramMedia};

/// The server ID the Telegram account goes by.
pub const TELEGRAM: &str = crate::telegram::SERVER_ID;

/// Who's in a Telegram call, as the stage draws a room's members: keys for them in the account's `voice`.
const SELF_KEY: &str = "telegram-self";
const PEER_KEY: &str = "telegram-peer";

/// A call that's over which Telegram asked to have rated, and what's been said of it so far.
#[derive(Clone, Debug, PartialEq)]
pub struct Rating {
    pub id: i64,
    pub name: String,
    /// One to five, once chosen: under five, which problems it had are asked too.
    pub stars: Option<u8>,
    pub problems: Vec<&'static str>,
}

/// The problems a call may have had, as Telegram names them (`PROBLEMS` in calls/call.ts), with their words.
pub const PROBLEMS: &[(&str, &str)] = &[
    ("echo", crate::i18n::mark("telegram.call.problem.echo")),
    ("noise", crate::i18n::mark("telegram.call.problem.noise")),
    ("interruptions", crate::i18n::mark("telegram.call.problem.interruptions")),
    ("distortedSpeech", crate::i18n::mark("telegram.call.problem.distortedSpeech")),
    ("silentLocal", crate::i18n::mark("telegram.call.problem.silentLocal")),
    ("silentRemote", crate::i18n::mark("telegram.call.problem.silentRemote")),
    ("dropped", crate::i18n::mark("telegram.call.problem.dropped")),
    ("distortedVideo", crate::i18n::mark("telegram.call.problem.distortedVideo")),
    ("pixelatedVideo", crate::i18n::mark("telegram.call.problem.pixelatedVideo")),
];

impl Voice {
    /// Whether the room this device is in is a Telegram call.
    pub fn in_telegram(&self) -> bool {
        self.server_id.as_deref() == Some(TELEGRAM) && self.status != VoiceStatus::Idle
    }

    /// The Telegram call this device is in, as the core last said it.
    pub fn telegram_call(&self) -> Option<&TelegramCallView> {
        self.telegram.as_ref().filter(|_| self.in_telegram())
    }

    /// Calls the person a Telegram chat is with.
    pub(super) fn start_telegram(&mut self, conversation_key: String, camera: bool, cx: &mut Context<Self>) {
        let Some(group_id) = self.state.read(cx).servers.get(TELEGRAM).and_then(|server| server.find_conversation(&conversation_key)).and_then(|conversation| conversation.group_id.clone()) else { return };
        if self.telegram.as_ref().is_some_and(|call| call.state != "over") {
            self.toast(t("telegram.call.alreadyInOne"), ToastKind::Info, cx);
            return;
        }
        self.enter_telegram(group_id.clone(), camera, true, cx);
        let mine = self.attempt;
        let call = self.core(cx).call(Some(TELEGRAM), "startCall", vec![json!(group_id), json!({ "video": camera })]);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |voice, cx| {
                if let Err(error) = result {
                    if voice.attempt == mine {
                        voice.leave_telegram(false, cx);
                    }
                    voice.toast(if error.message.is_empty() { t("voice.call.couldntStart").to_string() } else { error.message }, ToastKind::Error, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Answers the Telegram call ringing in a chat.
    pub(super) fn answer_telegram(&mut self, group_id: String, camera: bool, cx: &mut Context<Self>) {
        let Some(call) = self.telegram.clone().filter(|call| call.group_id == group_id && call.state == "ringing") else { return };
        self.enter_telegram(group_id, camera, false, cx);
        let answer = self.core(cx).call(Some(TELEGRAM), "answerCall", vec![json!(call.id)]);
        let mine = self.attempt;
        cx.spawn(async move |this, cx| {
            let result = answer.await;
            this.update(cx, |voice, cx| {
                if let Err(error) = result {
                    if voice.attempt == mine {
                        voice.leave_telegram(false, cx);
                    }
                    voice.toast(error.message, ToastKind::Error, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Comes into a Telegram call here: out of whatever room this device was in, with the
    /// microphone opened, waiting for the core to say the peer connection may be made.
    fn enter_telegram(&mut self, group_id: String, camera: bool, calling: bool, cx: &mut Context<Self>) {
        if self.status != VoiceStatus::Idle {
            self.leave(cx);
        }
        self.attempt += 1;
        let mine = self.attempt;
        self.reconnects = 0;
        self.stop_mic_test(cx);
        self.reset();
        // Calling, this device is in the call already, ringing the other person, as in a call of Zuna's.
        self.status = if calling { VoiceStatus::Connected } else { VoiceStatus::Connecting };
        self.server_id = Some(TELEGRAM.to_string());
        self.channel_id = Some(group_id);
        self.call = true;
        self.telegram_camera = camera;
        self.output_hold = Some(self.mixer.hold(&self.settings.output_device));
        // The source the call sends, made now, so the microphone's frames go to it whenever it opens.
        self.mic_source = Some(VoiceRoom::microphone_source());
        let opening = self.open_room_microphone(&self.settings.clone(), cx);
        self.mic_task = Some(cx.spawn(async move |this, cx| {
            let opened = opening.await;
            this.update(cx, |voice, cx| {
                voice.mic_task = None;
                if voice.attempt != mine {
                    return;
                }
                match opened {
                    Ok((mic, source)) => {
                        voice.mic = Some(mic);
                        voice.mic_source = Some(source);
                    }
                    Err(problem) => {
                        *voice.processing.lock() = None;
                        voice.no_mic = true;
                        voice.toast(tr!("voice.mic.problemCanListen", problem = problem), ToastKind::Info, cx);
                    }
                }
                voice.apply_mute(cx);
                cx.notify();
            })
            .ok();
        }));
        self.start_ticker(cx);
        self.show_members(cx);
        self.update_ringing(cx);
        self.update_ptt(cx);
        cx.notify();
    }

    /// Leaves the Telegram call here, and hangs up there unless it's over already.
    pub(super) fn leave_telegram(&mut self, hang_up: bool, cx: &mut Context<Self>) {
        if hang_up {
            if let Some(call) = self.telegram.as_ref().filter(|call| call.state != "over") {
                let call = self.core(cx).call(Some(TELEGRAM), "endCall", vec![json!(call.id)]);
                cx.background_executor().spawn(async move { call.await.ok() }).detach();
            }
        }
        let group = self.channel_id.clone();
        self.attempt += 1;
        self.close_room();
        self.reset();
        self.close_stage(Some(TELEGRAM.to_string()), group, cx);
        self.show_members(cx);
        self.sound(VoiceSound::SelfLeave);
        self.update_ringing(cx);
        self.update_ptt(cx);
        cx.notify();
    }

    /// The core's word on the call: ringing, connecting, on, or over and why.
    pub(super) fn on_telegram_call(&mut self, call: Option<TelegramCallView>, cx: &mut Context<Self>) {
        let before = self.telegram.clone();
        self.telegram = call.clone();
        let here = self.in_telegram() && call.as_ref().is_some_and(|call| Some(&call.group_id) == self.channel_id.as_ref());
        match &call {
            Some(call) if call.state == "over" => {
                if call.rate {
                    let name = self.peer_name(&call.user_id, cx);
                    self.telegram_rating = Some(Rating { id: call.id, name, stars: None, problems: Vec::new() });
                }
                // Hung up from here, it's left already, and says nothing more.
                if here {
                    if !call.ended_text.is_empty() {
                        self.toast(call.ended_text.clone(), ToastKind::Info, cx);
                    }
                    self.leave_telegram(false, cx);
                }
            }
            Some(call) if here => {
                self.status = match call.state.as_str() {
                    "calling" => VoiceStatus::Connected,
                    "connecting" if call.connected_at.is_some() => VoiceStatus::Reconnecting,
                    "connecting" | "ringing" => VoiceStatus::Connecting,
                    _ => VoiceStatus::Connected,
                };
                if call.state == "on" && before.as_ref().is_none_or(|before| before.state != "on") && before.as_ref().is_none_or(|before| before.connected_at.is_none()) {
                    self.sound(VoiceSound::SelfJoin);
                }
                self.show_members(cx);
            }
            _ => {}
        }
        self.update_ringing(cx);
        cx.notify();
    }

    /// What the core says the peer connection is to do.
    pub(super) fn on_telegram_media(&mut self, id: i64, media: Value, cx: &mut Context<Self>) {
        if !self.in_telegram() || self.telegram.as_ref().is_none_or(|call| call.id != id) {
            return;
        }
        if media.get("do").and_then(Value::as_str) == Some("open") {
            self.open_telegram_media(id, &media, cx);
            return;
        }
        if let Some(open) = &self.telegram_media {
            open.command(media);
        } else if let Some(waiting) = self.telegram_waiting.as_mut() {
            // Still being made, through the proxy: done once it's there, in order.
            waiting.push(media);
        }
    }

    fn open_telegram_media(&mut self, id: i64, media: &Value, cx: &mut Context<Self>) {
        if self.telegram_media.is_some() || self.telegram_waiting.is_some() {
            return;
        }
        let given = media.get("servers").unwrap_or(&Value::Null);
        let servers = media::relays(given);
        log::info!("telegram call: {} of {} TURN servers are at Telegram's addresses{}", servers.len(), given.as_array().map_or(0, Vec::len), media::refused(given));
        if servers.is_empty() {
            // None of the relays is at one of Telegram's addresses: the call can't be had.
            self.tell_connection(id, "norelay", cx);
            return;
        }
        let caller = media.get("caller").and_then(Value::as_bool).unwrap_or(false);
        // With a proxy set, everything goes through it, a call's media too, or the call doesn't
        // connect: Telegram's relays are reached by ports on this device that carry it there.
        let Some(proxy) = crate::host::net::proxy() else {
            self.make_telegram_media(id, servers, None, caller, cx);
            return;
        };
        self.telegram_waiting = Some(Vec::new());
        let mine = self.attempt;
        cx.spawn(async move |this, cx| {
            let prepared = crate::host::tokio().spawn(async move { crate::voice::proxy::prepare((*proxy).clone()).await }).await.unwrap_or_else(|_| Err(String::new()));
            this.update(cx, |voice, cx| {
                let waiting = voice.telegram_waiting.take().unwrap_or_default();
                if voice.attempt != mine {
                    if let Ok(relays) = &prepared {
                        crate::voice::proxy::finish(relays);
                    }
                    return;
                }
                let through = prepared.as_ref().map(|relays| media::through(relays, servers)).unwrap_or_default();
                match prepared {
                    Ok(relays) if !through.is_empty() => {
                        voice.make_telegram_media(id, through, Some(relays), caller, cx);
                        if let Some(media) = &voice.telegram_media {
                            for command in waiting {
                                media.command(command);
                            }
                        }
                    }
                    // A proxy that carries no UDP gets no Telegram call, and says so.
                    Ok(relays) => {
                        crate::voice::proxy::finish(&relays);
                        voice.tell_connection(id, "noudp", cx);
                    }
                    Err(problem) => {
                        log::warn!("telegram call: the proxy couldn't be had: {problem}");
                        voice.tell_connection(id, "failed", cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn tell_connection(&self, id: i64, state: &str, cx: &mut Context<Self>) {
        let call = self.core(cx).call(Some(TELEGRAM), "callConnection", vec![json!(id), json!(state)]);
        cx.background_executor().spawn(async move { call.await.ok() }).detach();
    }

    fn make_telegram_media(&mut self, id: i64, servers: Vec<livekit::webrtc::peer_connection_factory::IceServer>, proxied: Option<Arc<crate::voice::proxy::Relays>>, caller: bool, cx: &mut Context<Self>) {
        let core = self.core(cx);
        let peer = self.telegram.as_ref().map(|call| call.user_id.clone()).unwrap_or_default();
        let volume = (self.volumes_fn())(&peer, false);
        let (events, mut heard) = futures::channel::mpsc::unbounded();
        match TelegramMedia::open(core, id, servers, proxied, caller, self.mic_source.clone(), self.mixer.clone(), volume, events) {
            Ok(opened) => {
                self.telegram_media = Some(opened);
                let mine = self.attempt;
                self.events_task = Some(cx.spawn(async move |this, cx| {
                    while let Some(event) = heard.next().await {
                        let going = this.update(cx, |voice, cx| {
                            if voice.attempt != mine {
                                return false;
                            }
                            match event {
                                MediaEvent::Media => voice.sync_videos(cx),
                            }
                            true
                        });
                        if !going.unwrap_or(false) {
                            break;
                        }
                    }
                }));
                if std::mem::take(&mut self.telegram_camera) {
                    self.toggle_camera(cx);
                }
                self.apply_mute(cx);
            }
            Err(problem) => {
                log::warn!("telegram call: the peer connection couldn't be made: {problem}");
                self.tell_connection(id, "failed", cx);
            }
        }
    }

    /// Tells the other side what this device's microphone and camera are doing.
    pub(super) fn say_telegram(&self, cx: &mut Context<Self>) {
        let Some(call) = self.telegram_call() else { return };
        let state = json!({ "muted": self.mic_off(), "camera": self.camera });
        let call = self.core(cx).call(Some(TELEGRAM), "callSaid", vec![json!(call.id), state]);
        cx.background_executor().spawn(async move { call.await.ok() }).detach();
    }

    /// Turns the camera on or off in the Telegram call.
    pub(super) fn toggle_telegram_camera(&mut self, cx: &mut Context<Self>) {
        let Some(media) = self.telegram_media.clone() else { return };
        let on = !self.camera;
        let device = self.settings.camera_device.clone();
        cx.spawn(async move |this, cx| {
            let result = crate::host::tokio().spawn_blocking(move || media.set_camera(on, &device)).await.unwrap_or_else(|_| Err(t("voice.camera.none").into()));
            this.update(cx, |voice, cx| {
                match result {
                    Ok(()) => voice.camera = on,
                    Err(error) => voice.toast(error, ToastKind::Error, cx),
                }
                voice.say_telegram(cx);
                voice.sync_videos(cx);
                voice.show_members(cx);
            })
            .ok();
        })
        .detach();
    }

    /// The pictures of a Telegram call, as tiles: the other person's, and this device's camera.
    pub(super) fn telegram_videos(&self, cx: &App) -> Vec<VideoTile> {
        let Some(media) = &self.telegram_media else { return Vec::new() };
        let server = self.state.read(cx).servers.get(TELEGRAM);
        let self_id = server.map(|server| server.self_id().to_string()).unwrap_or_default();
        let peer = self.telegram.as_ref().map(|call| call.user_id.clone()).unwrap_or_default();
        let remote_on = self.telegram.as_ref().is_some_and(|call| call.remote.camera || call.remote.screen);
        let mut tiles = Vec::new();
        for (index, (local, feed)) in media.videos().into_iter().enumerate() {
            // The other side's picture shows while it says it's sending one.
            if !local && !remote_on {
                continue;
            }
            let user = if local { self_id.clone() } else { peer.clone() };
            let screen = !local && self.telegram.as_ref().is_some_and(|call| call.remote.screen && !call.remote.camera);
            tiles.push(VideoTile {
                key: if local { "telegram/camera".to_string() } else { format!("telegram/{user}/{index}") },
                user_id: user.clone(),
                identity: user,
                source: if screen { VideoSource::Screen } else { VideoSource::Camera },
                local,
                sound: false,
                feed,
            });
        }
        tiles
    }

    /// Whether the other person is heard speaking, for how they're drawn.
    pub(super) fn telegram_speaking(&self) -> Option<HashSet<String>> {
        let media = self.telegram_media.as_ref()?;
        let peer = self.telegram.as_ref()?.user_id.clone();
        Some(if media.speaking() { HashSet::from([peer]) } else { HashSet::new() })
    }

    /// Who's in the call, as a room's members are kept, so the stage draws them: this person,
    /// and the other once they've answered.
    pub(super) fn show_members(&mut self, cx: &mut Context<Self>) {
        let call = self.telegram_call().cloned();
        let (muted, deafened, camera) = (self.mic_off(), self.deafened, self.camera);
        self.state.update(cx, |state, cx| {
            let Some(server) = state.servers.get_mut(TELEGRAM) else { return };
            server.voice.remove(SELF_KEY);
            server.voice.remove(PEER_KEY);
            let Some(call) = call else {
                cx.notify();
                return;
            };
            let me = server.me.as_ref().map(|me| (me.user_id.clone(), me.device_id.clone())).unwrap_or_default();
            // Under this device's own ID, which is how a room's members tell this one apart.
            server.voice.insert(SELF_KEY.into(), VoiceMember { channel_id: call.group_id.clone(), user_id: me.0, device_id: me.1, muted, deafened, server_muted: false, camera, screen: false, since: 0. });
            if call.state != "calling" && call.state != "ringing" {
                server.voice.insert(
                    PEER_KEY.into(),
                    VoiceMember { channel_id: call.group_id.clone(), user_id: call.user_id.clone(), device_id: PEER_KEY.into(), muted: call.remote.muted, deafened: false, server_muted: false, camera: call.remote.camera, screen: call.remote.screen, since: 1. },
                );
            }
            cx.notify();
        });
    }

    /// Chooses how many stars the call gets: five is said at once, fewer asks what was wrong first.
    pub fn rate_stars(&mut self, stars: u8, cx: &mut Context<Self>) {
        let Some(rating) = self.telegram_rating.as_mut() else { return };
        rating.stars = Some(stars.clamp(1, 5));
        if stars >= 5 {
            self.send_rating(cx);
        }
        cx.notify();
    }

    pub fn toggle_problem(&mut self, problem: &'static str, cx: &mut Context<Self>) {
        let Some(rating) = self.telegram_rating.as_mut() else { return };
        if let Some(at) = rating.problems.iter().position(|each| *each == problem) {
            rating.problems.remove(at);
        } else {
            rating.problems.push(problem);
        }
        cx.notify();
    }

    /// Says how the call was, as chosen.
    pub fn send_rating(&mut self, cx: &mut Context<Self>) {
        let Some(rating) = self.telegram_rating.take() else { return };
        let Some(stars) = rating.stars else { return };
        let call = self.core(cx).call(Some(TELEGRAM), "rateCall", vec![json!(rating.id), json!(stars), json!(rating.problems)]);
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Err(error) = call.await {
                state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
            }
        })
        .detach();
        cx.notify();
    }

    /// Closes the card without saying anything.
    pub fn dismiss_rating(&mut self, cx: &mut Context<Self>) {
        self.telegram_rating = None;
        cx.notify();
    }

    fn peer_name(&self, user_id: &str, cx: &App) -> String {
        self.state.read(cx).servers.get(TELEGRAM).and_then(|server| server.users.get(user_id)).map(|user| user.display_name.clone()).unwrap_or_else(|| t("common.someone").into())
    }
}
