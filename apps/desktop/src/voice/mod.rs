//! The voice channel or call this device is in, wherever in the app the person is looking
//! (packages/ui/src/voice/store.ts). There's one at a time, across all servers, as in
//! Discord. A call is a direct message's or a group's, in a room of its own under the
//! conversation's group, and everything a voice channel has works the same in it.

pub mod audio;
pub mod mic;
#[cfg(target_os = "linux")]
pub mod pipewire;
pub mod room;
pub mod rules;
pub mod screen;
pub mod settings;
pub mod sounds;
pub mod stats;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use gpui::{App, AppContext, Context, Entity, Global, Task, Window};
use serde_json::{Value, json};

use crate::host::read_bytes;
use crate::models::{CallView, ChannelView, ConversationView, VoiceMember};
use crate::state::{AppState, ServerState, ToastKind};
use audio::{Mixer, Processing, SharedProcessing};
use mic::Microphone;
use room::{Event, Quality, VideoSource, VideoTile, VoiceRoom};
use settings::VoiceSettings;
use sounds::{Ringing, VoiceSound};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum VoiceStatus {
    #[default]
    Idle,
    Connecting,
    Connected,
    Reconnecting,
}

/// What this device is sharing.
#[derive(Clone, Debug)]
pub struct ShareInfo {
    /// What it's called, to say what's being shared.
    pub name: String,
    pub native: bool,
    pub fps: u32,
    pub kbps: u32,
    pub height: u32,
    /// Which of those the server's limits brought down, in words.
    pub held: Vec<String>,
    /// What the native program said once it started.
    pub info: Option<Value>,
}

/// How to come into a room.
#[derive(Clone, Copy, Debug, Default)]
pub struct JoinHow {
    /// It starts a call, ringing everyone else in the conversation.
    pub ring: bool,
    /// The camera goes on once in.
    pub camera: bool,
}

const RECONNECT_ATTEMPTS: u32 = 3;
const RECONNECT_WAIT: Duration = Duration::from_millis(2000);
/// How long a direct message's call waits, once the other person seems to have gone, in case it's another of their devices taking over.
const PEER_GONE: Duration = Duration::from_millis(2000);
/// How long someone shows as playing a sound past its end, so a short one is seen.
const SOUNDING_HOLD_MS: u64 = 600;

pub struct Voice {
    state: Entity<AppState>,
    pub status: VoiceStatus,
    pub server_id: Option<String>,
    /// The voice channel, or the group of the conversation whose call it is.
    pub channel_id: Option<String>,
    /// It's a conversation's call rather than a voice channel.
    pub call: bool,
    /// Muted by the person.
    pub muted: bool,
    pub deafened: bool,
    /// Muted by an admin, which only an admin can undo.
    pub server_muted: bool,
    /// No microphone could be used, so this device can only listen.
    pub no_mic: bool,
    /// Sound is going out from this device right now.
    pub open: bool,
    /// The push to talk key is down.
    pub key_held: bool,
    /// The push to talk key as the system bound it, where it binds the key itself and may have
    /// been given another (`keyBound` in voice/store.ts).
    pub key_bound: Option<String>,
    pub speaking: HashSet<String>,
    pub videos: Vec<VideoTile>,
    pub quality: Quality,
    pub rtt: Option<u32>,
    pub camera: bool,
    pub screen: Option<ShareInfo>,
    /// The video filling the stage, by its key.
    pub focus: Option<String>,
    pub settings: VoiceSettings,
    /// How loud each person is for this device, by user.
    pub volumes: HashMap<String, f32>,
    /// How loud each person's shared screen is for this device, by user.
    pub stream_volumes: HashMap<String, f32>,
    /// People muted for this device only.
    pub local_mutes: HashSet<String>,
    /// Who's playing a sound from the soundboard right now, by user, with what to show for it.
    pub sounding: HashMap<String, String>,
    /// The soundboard's panel is open over the controls.
    pub soundboard_open: bool,
    /// Stream stats are open over the stage.
    pub stats_open: bool,

    room: Option<Arc<VoiceRoom>>,
    mic: Option<Microphone>,
    mic_source: Option<livekit::webrtc::audio_source::native::NativeAudioSource>,
    pub(crate) mixer: Mixer,
    processing: SharedProcessing,
    /// Each join counts, so one that takes a while can tell it's been replaced.
    attempt: u64,
    reconnects: u32,
    /// What was open before coming into a voice channel.
    open_before: Option<String>,
    /// This device still has to say it's starting the call it's in, which rings everyone else.
    ring_on_announce: bool,
    /// The call this device is in has rung someone, so that nobody being rung any more means something.
    call_rang: bool,
    hang_up: Option<Task<()>>,
    ringing: Option<Ringing>,
    ring_task: Option<Task<()>>,
    sound_cache: HashMap<String, Arc<Vec<f32>>>,
    sounding_tasks: HashMap<String, Task<()>>,
    events_task: Option<Task<()>>,
    tick_task: Option<Task<()>>,
    /// The settings and volumes waiting to be saved, a moment after the last change.
    save_task: Option<Task<()>>,
    pub(crate) share: screen::ShareHandles,
    /// The push to talk key being watched for, and what hears it.
    ptt_watching: Option<String>,
    ptt_task: Option<Task<()>>,
    /// Trying the microphone outside a call: it, and where it plays back.
    mic_test: Option<(Microphone, u64)>,
}

struct GlobalVoice(Entity<Voice>);
impl Global for GlobalVoice {}

/// Starts voice for the app, once.
pub fn init(state: &Entity<AppState>, cx: &mut App) -> Entity<Voice> {
    let settings = VoiceSettings::load();
    let processing: SharedProcessing = Arc::default();
    let voice = cx.new(|_| Voice {
        state: state.clone(),
        status: VoiceStatus::Idle,
        server_id: None,
        channel_id: None,
        call: false,
        muted: settings.start_muted,
        deafened: false,
        server_muted: false,
        no_mic: false,
        open: false,
        key_held: false,
        key_bound: None,
        speaking: HashSet::new(),
        videos: Vec::new(),
        quality: Quality::Unknown,
        rtt: None,
        camera: false,
        screen: None,
        focus: None,
        volumes: settings::load_volumes(false),
        stream_volumes: settings::load_volumes(true),
        settings,
        local_mutes: HashSet::new(),
        sounding: HashMap::new(),
        soundboard_open: false,
        stats_open: false,
        room: None,
        mic: None,
        mic_source: None,
        mixer: Mixer::new(processing.clone()),
        processing,
        attempt: 0,
        reconnects: 0,
        open_before: None,
        ring_on_announce: false,
        call_rang: false,
        hang_up: None,
        ringing: None,
        ring_task: None,
        sound_cache: HashMap::new(),
        sounding_tasks: HashMap::new(),
        events_task: None,
        tick_task: None,
        save_task: None,
        share: screen::ShareHandles::default(),
        ptt_watching: None,
        ptt_task: None,
        mic_test: None,
    });
    cx.set_global(GlobalVoice(voice.clone()));
    // Listed now, off this thread, so a call's device menus have them the first time they open.
    crate::devices::sound(true);
    crate::devices::sound(false);
    voice
}

pub fn get(cx: &App) -> Option<Entity<Voice>> {
    cx.try_global::<GlobalVoice>().map(|global| global.0.clone())
}

/// The server and channel this device is in, if any.
pub fn connected_channel(cx: &App) -> Option<(String, String)> {
    let voice = get(cx)?;
    let voice = voice.read(cx);
    if voice.status == VoiceStatus::Idle {
        return None;
    }
    Some((voice.server_id.clone()?, voice.channel_id.clone()?))
}

/// Whether someone in a channel is speaking, as far as this device hears them.
pub fn is_speaking(server_id: &str, member: &VoiceMember, cx: &App) -> bool {
    let Some(voice) = get(cx) else { return false };
    let voice = voice.read(cx);
    if voice.server_id.as_deref() != Some(server_id) || voice.channel_id.as_deref() != Some(member.channel_id.as_str()) {
        return false;
    }
    let self_id = voice.state.read(cx).servers.get(server_id).map(|server| server.self_id().to_string()).unwrap_or_default();
    if member.user_id == self_id {
        voice.self_speaking() && voice.status == VoiceStatus::Connected
    } else {
        voice.speaking.contains(&member.user_id)
    }
}

/// Opens a channel from the list: a text channel to read, a voice channel to come into, as in Discord.
/// Leaving goes back to what was open before.
pub fn open_channel(state: &Entity<AppState>, channel: &ChannelView, _window: &mut Window, cx: &mut App) {
    let key = channel.key.clone();
    if channel.kind != "voice" {
        state.update(cx, |state, cx| state.select_conversation(Some(key), cx));
        return;
    }
    let Some(server) = state.read(cx).active().cloned() else { return };
    let active_is_voice = server.channels.iter().any(|item| Some(&item.key) == server.active_key.as_ref() && item.kind == "voice");
    let return_to = if active_is_voice { None } else { Some(server.active_key.clone()) };
    let ready = server.info.as_ref().is_some_and(|info| info.voice.is_some_and(|voice| voice > 0.));
    state.update(cx, |state, cx| {
        state.select_conversation(Some(key), cx);
        if !ready {
            state.toast("This server has no media server yet, so its voice channels can't be joined.", ToastKind::Info, cx);
        }
    });
    if ready {
        if let Some(voice) = get(cx) {
            let (server_id, channel_id) = (server.entry.id.clone(), channel.id.clone());
            voice.update(cx, |voice, cx| voice.join(server_id, channel_id, return_to, JoinHow::default(), cx));
        }
    }
}

/// The conversation whose group a call is in.
pub fn conversation_of_group<'a>(server: &'a ServerState, group_id: &str) -> Option<&'a ConversationView> {
    server.conversations.iter().find(|conversation| conversation.group_id.as_deref() == Some(group_id) && conversation.kind != "channel")
}

/// A call ringing this person that this device could answer.
#[derive(Clone)]
pub struct Incoming {
    pub server_id: String,
    pub call: CallView,
    pub conversation: ConversationView,
    /// The conversation is muted, so it shows without a sound.
    pub quiet: bool,
}

/// The calls ringing this person that this device could answer, oldest first.
pub fn incoming_calls(state: &AppState, in_server: Option<&str>, in_room: Option<&str>) -> Vec<Incoming> {
    let mut found = Vec::new();
    for (server_id, server) in &state.servers {
        let self_id = server.self_id();
        if self_id.is_empty() || server.entry.signed_out.is_some() {
            continue;
        }
        for call in server.calls.values() {
            if !call.ringing.iter().any(|id| id == self_id) || (in_server == Some(server_id.as_str()) && in_room == Some(call.group_id.as_str())) {
                continue;
            }
            let Some(conversation) = conversation_of_group(server, &call.group_id) else { continue };
            if conversation.removed || conversation.blocked || server.prefs.blocked().contains(&call.started_by) {
                continue;
            }
            found.push(Incoming { server_id: server_id.clone(), call: call.clone(), conversation: conversation.clone(), quiet: conversation.muted });
        }
    }
    found.sort_by(|a, b| a.call.started_at.total_cmp(&b.call.started_at));
    found
}

/// Whether a call can be started here: a direct message with someone else, or a group still had.
pub fn can_call(conversation: &ConversationView, self_id: &str, peer_banned: bool) -> bool {
    match conversation.kind.as_str() {
        "dm" => conversation.peer_id.as_deref().is_some_and(|peer| peer != self_id) && !conversation.blocked && !peer_banned && !conversation.removed,
        "group" => !conversation.removed,
        _ => false,
    }
}

impl Voice {
    /// Whether this person is being heard from this device, for how they're drawn.
    pub fn self_speaking(&self) -> bool {
        self.open && !self.muted && !self.deafened && !self.server_muted && !self.no_mic
    }

    pub fn mic_off(&self) -> bool {
        self.muted || self.deafened || self.server_muted || self.no_mic
    }

    /// How loud the microphone is right now, for the meter in Voice settings: in a call, or while it's tried.
    pub fn reading(&self) -> Option<mic::Reading> {
        self.mic.as_ref().or(self.mic_test.as_ref().map(|(mic, _)| mic)).map(|mic| *mic.reading.lock())
    }

    pub fn testing_mic(&self) -> bool {
        self.mic_test.is_some()
    }

    /// Tries the microphone without being in a channel, with the same processing a call gets,
    /// playing back what others would hear. Or stops trying it.
    pub fn toggle_mic_test(&mut self, cx: &mut Context<Self>) {
        if self.mic_test.is_some() || self.status != VoiceStatus::Idle {
            self.stop_mic_test(cx);
            return;
        }
        let settings = &self.settings;
        let processing = livekit::webrtc::native::apm::AudioProcessingModule::new(settings.echo_cancellation, settings.auto_gain, true, settings.noise_suppression == "standard");
        *self.processing.lock() = Some(Processing(processing));
        self.mixer.open(&self.settings.output_device);
        let back = self.mixer.live(1.);
        let mixer = self.mixer.clone();
        match Microphone::open(&self.settings, false, self.processing.clone(), move |frame| mixer.push(back, &frame, 1)) {
            Ok(mic) => self.mic_test = Some((mic, back)),
            Err(problem) => {
                self.mixer.remove(back);
                *self.processing.lock() = None;
                self.toast(problem, ToastKind::Error, cx);
            }
        }
        cx.notify();
    }

    fn stop_mic_test(&mut self, cx: &mut Context<Self>) {
        if let Some((_, back)) = self.mic_test.take() {
            self.mixer.remove(back);
            if self.status == VoiceStatus::Idle {
                *self.processing.lock() = None;
            }
            cx.notify();
        }
    }

    /// Watches for the push to talk key while in a channel with it set, anywhere on the computer.
    fn update_ptt(&mut self, cx: &mut Context<Self>) {
        let wanted = (self.settings.input_mode == "ptt" && self.status != VoiceStatus::Idle && !self.settings.ptt_key.is_empty()).then(|| self.settings.ptt_key.clone());
        if wanted == self.ptt_watching {
            return;
        }
        self.ptt_watching = wanted.clone();
        self.ptt_task = None;
        self.key_bound = None;
        enum Heard {
            Held(bool),
            /// What the system bound, where it binds the key itself.
            Bound(String),
        }
        let (sender, mut receiver) = futures::channel::mpsc::unbounded::<Heard>();
        let bound = sender.clone();
        crate::platform::ptt::watch(
            wanted.clone(),
            move |down| {
                sender.unbounded_send(Heard::Held(down)).ok();
            },
            move |trigger| {
                bound.unbounded_send(Heard::Bound(trigger)).ok();
            },
        );
        if wanted.is_some() {
            self.ptt_task = Some(cx.spawn(async move |this, cx| {
                while let Some(heard) = receiver.next().await {
                    let updated = this.update(cx, |voice, cx| match heard {
                        Heard::Held(down) => voice.set_key_held(down, cx),
                        Heard::Bound(trigger) => {
                            voice.key_bound = Some(trigger).filter(|trigger| !trigger.is_empty());
                            cx.notify();
                        }
                    });
                    if updated.is_err() {
                        break;
                    }
                }
            }));
        }
    }

    pub fn room(&self) -> Option<Arc<VoiceRoom>> {
        self.room.clone()
    }

    fn core(&self, cx: &App) -> crate::host::Core {
        self.state.read(cx).core.clone()
    }

    fn toast(&self, message: impl Into<String>, kind: ToastKind, cx: &mut App) {
        let message = message.into();
        self.state.update(cx, |state, cx| state.toast(message, kind, cx));
    }

    fn sound(&mut self, sound: VoiceSound) {
        if self.settings.sounds {
            self.mixer.open(&self.settings.output_device);
            self.mixer.once(sounds::render(sound, self.settings.output_volume.min(1.)), 1.);
        }
    }

    fn reset(&mut self) {
        self.status = VoiceStatus::Idle;
        self.server_id = None;
        self.channel_id = None;
        self.call = false;
        self.server_muted = false;
        self.no_mic = false;
        self.open = false;
        self.key_held = false;
        self.speaking.clear();
        self.videos.clear();
        self.quality = Quality::Unknown;
        self.rtt = None;
        self.camera = false;
        self.screen = None;
        self.focus = None;
        self.sounding.clear();
        self.soundboard_open = false;
        self.stats_open = false;
    }

    /// Tells everyone on the server what this device is doing, or the conversation's members in a call.
    fn announce(&mut self, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else { return };
        let ring = std::mem::take(&mut self.ring_on_announce);
        let update = json!({ "muted": self.muted || self.no_mic || self.server_muted, "deafened": self.deafened, "camera": self.camera, "screen": self.screen.is_some() });
        let call = self.core(cx).call(Some(&server_id), "setVoiceState", vec![json!(channel_id), update, json!(ring)]);
        cx.background_executor().spawn(async move { call.await.ok() }).detach();
    }

    /// How loud each person comes out here.
    fn volumes_fn(&self) -> room::Volumes {
        let (deafened, output, screen) = (self.deafened, self.settings.output_volume, self.settings.screen_volume);
        let (volumes, streams, mutes) = (self.volumes.clone(), self.stream_volumes.clone(), self.local_mutes.clone());
        Arc::new(move |user: &str, share: bool| {
            if deafened {
                return 0.;
            }
            // A share's sound has a level of its own: it isn't how loud the person talks.
            if share {
                return output * screen * streams.get(user).copied().unwrap_or(1.);
            }
            if mutes.contains(user) { 0. } else { output * volumes.get(user).copied().unwrap_or(1.) }
        })
    }

    fn apply_volumes(&self) {
        if let Some(room) = &self.room {
            room.set_volumes(self.volumes_fn());
        }
    }

    fn apply_mute(&mut self, cx: &mut Context<Self>) {
        let off = self.mic_off();
        if let Some(mic) = &self.mic {
            mic.set_muted(off);
        }
        if let Some(room) = &self.room {
            room.set_muted(off);
        }
        self.announce(cx);
    }

    fn sync_videos(&mut self, cx: &mut Context<Self>) {
        let Some(room) = self.room.clone() else { return };
        let videos = room.videos();
        let still_there = self.focus.as_ref().is_some_and(|focus| videos.iter().any(|video| &video.key == focus));
        // A screen someone starts sharing is what everyone's there to see, unless they're already looking at something.
        let arrived = if self.settings.screen_focus { videos.iter().find(|video| video.source == VideoSource::Screen && !video.local && !self.videos.iter().any(|other| other.key == video.key)).map(|video| video.key.clone()) } else { None };
        self.focus = if still_there { self.focus.clone() } else { arrived };
        self.camera = room.camera_on();
        self.videos = videos;
        cx.notify();
    }

    /// There's nothing to show for a voice channel once out of it, so whatever was open before comes back. A call's chat stays.
    fn close_stage(&mut self, server_id: Option<String>, channel_id: Option<String>, cx: &mut Context<Self>) {
        let return_to = self.open_before.take();
        let (Some(server_id), Some(channel_id)) = (server_id, channel_id) else { return };
        self.state.update(cx, |state, cx| {
            let Some(server) = state.servers.get_mut(&server_id) else { return };
            let Some(channel) = server.channels.iter().find(|channel| channel.id == channel_id) else { return };
            if server.active_key.as_ref() != Some(&channel.key) {
                return;
            }
            server.active_key = return_to;
            state.panel = None;
            cx.notify();
        });
    }

    fn close_room(&mut self) {
        self.stop_share_handles();
        if let Some(room) = self.room.take() {
            room.close();
        }
        self.mic = None;
        self.mic_source = None;
        *self.processing.lock() = None;
        self.ring_on_announce = false;
        self.call_rang = false;
        self.hang_up = None;
        self.events_task = None;
        self.tick_task = None;
    }

    // --- Coming in and going ---

    /// Comes into a voice channel or a call. `return_to` is what to open again on leaving a voice channel, if it's said.
    pub fn join(&mut self, server_id: String, channel_id: String, return_to: Option<Option<String>>, how: JoinHow, cx: &mut Context<Self>) {
        // Moving between voice channels keeps what was open before the first of them.
        let before = match return_to {
            Some(value) => value,
            None => self.open_before.clone(),
        };
        self.open_before = before.clone();
        if self.server_id.as_deref() == Some(&server_id) && self.channel_id.as_deref() == Some(&channel_id) && self.status != VoiceStatus::Idle {
            return;
        }
        if self.status != VoiceStatus::Idle {
            self.leave(cx);
        }
        self.open_before = before;
        self.attempt += 1;
        let mine = self.attempt;
        self.reconnects = 0;
        let call = !self.state.read(cx).servers.get(&server_id).is_some_and(|server| server.channels.iter().any(|channel| channel.id == channel_id));
        self.stop_mic_test(cx);
        self.reset();
        self.status = VoiceStatus::Connecting;
        self.server_id = Some(server_id.clone());
        self.channel_id = Some(channel_id.clone());
        self.call = call;
        self.ring_on_announce = how.ring && call;
        cx.notify();
        self.connect(server_id, channel_id, mine, how, cx);
        self.update_ringing(cx);
        self.update_ptt(cx);
    }

    fn open_microphone(&mut self) -> Option<String> {
        let settings = &self.settings;
        let processing = livekit::webrtc::native::apm::AudioProcessingModule::new(settings.echo_cancellation, settings.auto_gain, true, settings.noise_suppression == "standard");
        *self.processing.lock() = Some(Processing(processing));
        let source = VoiceRoom::microphone_source();
        let sending = source.clone();
        match Microphone::open(settings, self.mic_off(), self.processing.clone(), move |frame| room::send_frame(&sending, frame, 1)) {
            Ok(mic) => {
                self.mic = Some(mic);
                self.mic_source = Some(source);
                None
            }
            Err(problem) => {
                *self.processing.lock() = None;
                Some(problem)
            }
        }
    }

    fn connect(&mut self, server_id: String, channel_id: String, mine: u64, how: JoinHow, cx: &mut Context<Self>) {
        let core = self.core(cx);
        let bitrate = self.state.read(cx).servers.get(&server_id).and_then(|server| server.channels.iter().find(|channel| channel.id == channel_id)).map(|channel| channel.bitrate as u64).unwrap_or(0);
        self.mixer.open(&self.settings.output_device);
        // Nothing about voice needs a microphone: someone without one can still listen.
        let mic_problem = self.open_microphone();
        let volumes = self.volumes_fn();
        let mixer = self.mixer.clone();
        cx.spawn(async move |this, cx| {
            let result: Result<(VoiceRoom, futures::channel::mpsc::UnboundedReceiver<Event>, bool), String> = async {
                let access = core.call(Some(&server_id), "voiceAccess", vec![json!(channel_id)]).await.map_err(|error| error.message)?;
                let text = |name: &str| access.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
                let (url, token, identity) = (text("url"), text("token"), text("identity"));
                let server_muted = access.get("serverMuted").and_then(Value::as_bool).unwrap_or(false);
                let key = core.call(Some(&server_id), "voiceKey", vec![json!(channel_id)]).await.map_err(|error| error.message)?;
                let epoch = key.get("epoch").and_then(Value::as_u64).unwrap_or(0);
                let room_key = key.get("key").and_then(read_bytes).ok_or_else(|| "Couldn't connect to voice.".to_string())?;
                let (room, events) = crate::host::tokio().spawn(VoiceRoom::join(url, token, identity, epoch, room_key, mixer, volumes)).await.map_err(|_| "Couldn't connect to voice.".to_string())??;
                Ok((room, events, server_muted))
            }
            .await;
            this.update(cx, |voice, cx| voice.joined(result, mine, server_id, channel_id, how, mic_problem, bitrate, cx)).ok();
        })
        .detach();
    }

    #[allow(clippy::too_many_arguments)]
    fn joined(&mut self, result: Result<(VoiceRoom, futures::channel::mpsc::UnboundedReceiver<Event>, bool), String>, mine: u64, server_id: String, channel_id: String, how: JoinHow, mic_problem: Option<String>, bitrate: u64, cx: &mut Context<Self>) {
        match result {
            Ok((room, mut events, server_muted)) => {
                if mine != self.attempt {
                    room.close();
                    return;
                }
                room.server_muted.store(server_muted, std::sync::atomic::Ordering::Relaxed);
                let room = Arc::new(room);
                self.room = Some(room.clone());
                self.events_task = Some(cx.spawn(async move |this, cx| {
                    while let Some(event) = events.next().await {
                        if this.update(cx, |voice, cx| voice.on_room_event(mine, event, cx)).is_err() {
                            break;
                        }
                    }
                }));
                if let Some(problem) = mic_problem {
                    self.toast(format!("{problem} You can still listen."), ToastKind::Info, cx);
                }
                self.no_mic = self.mic.is_none();
                self.server_muted = server_muted;
                if let Some(source) = self.mic_source.clone() {
                    let muted = self.mic_off();
                    let publishing = room.clone();
                    crate::host::tokio().spawn(async move {
                        if let Err(error) = publishing.publish_mic(source, bitrate, muted).await {
                            log::warn!("voice microphone: {error}");
                        }
                    });
                }
                self.status = VoiceStatus::Connected;
                self.apply_mute(cx);
                self.sync_videos(cx);
                if self.reconnects == 0 {
                    self.sound(VoiceSound::SelfJoin);
                }
                self.start_ticker(cx);
                if how.camera && !self.camera {
                    self.toggle_camera(cx);
                }
                self.update_ringing(cx);
                cx.notify();
            }
            Err(message) => {
                if mine != self.attempt {
                    return;
                }
                log::warn!("joining a voice channel: {message}");
                self.toast(if message.is_empty() { "Couldn't connect to voice.".to_string() } else { message }, ToastKind::Error, cx);
                // A server that hasn't set this up, or a channel that's full, won't change in a moment.
                self.close_room();
                self.reset();
                self.close_stage(Some(server_id.clone()), Some(channel_id), cx);
                self.update_ptt(cx);
                let call = self.core(cx).call(Some(&server_id), "setVoiceState", vec![Value::Null, Value::Null]);
                cx.background_executor().spawn(async move { call.await.ok() }).detach();
                self.update_ringing(cx);
                cx.notify();
            }
        }
    }

    /// Watches the microphone's gate, for whether this person shows as speaking, and a device going away.
    fn start_ticker(&mut self, cx: &mut Context<Self>) {
        self.tick_task = Some(cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(60)).await;
            let going = this
                .update(cx, |voice, cx| {
                    if voice.status == VoiceStatus::Idle {
                        return false;
                    }
                    let open = voice.reading().is_some_and(|reading| reading.open);
                    if open != voice.open {
                        voice.open = open;
                        cx.notify();
                    }
                    if voice.mic.as_ref().is_some_and(|mic| mic.lost.load(std::sync::atomic::Ordering::Relaxed)) {
                        voice.toast("Your microphone went away, so Zuna switched to the default one.", ToastKind::Info, cx);
                        voice.reopen_mic(Some("default".into()), cx);
                    }
                    true
                })
                .unwrap_or(false);
            if !going {
                break;
            }
        }));
    }

    /// Opens the microphone again, for a different device or for what only applies when it's opened.
    fn reopen_mic(&mut self, device: Option<String>, cx: &mut Context<Self>) {
        if self.mic.is_none() {
            return;
        }
        let mut settings = self.settings.clone();
        if let Some(device) = device {
            settings.input_device = device;
        }
        let saved = std::mem::replace(&mut self.settings, settings);
        self.mic = None;
        let problem = self.open_microphone();
        self.settings = saved;
        // The room's source stays the same, so nothing has to be published again.
        if let (Some(room), Some(source)) = (self.room.clone(), self.mic_source.clone()) {
            if room.mic_source().is_none() {
                let muted = self.mic_off();
                crate::host::tokio().spawn(async move { room.publish_mic(source, 0, muted).await.ok() });
            }
        }
        if let Some(problem) = problem {
            log::warn!("voice microphone: {problem}");
        }
        cx.notify();
    }

    fn on_room_event(&mut self, mine: u64, event: Event, cx: &mut Context<Self>) {
        if mine != self.attempt {
            return;
        }
        match event {
            Event::Status(room::Status::Connected) => {
                self.reconnects = 0;
                self.status = VoiceStatus::Connected;
            }
            Event::Status(room::Status::Reconnecting) => self.status = VoiceStatus::Reconnecting,
            Event::Closed(reason) => self.on_closed(reason, cx),
            Event::Media => self.sync_videos(cx),
            Event::Speaking(users) => self.speaking = users,
            Event::Quality(quality) => self.quality = quality,
            Event::Participants(came, left) => {
                if came.is_some() || left.is_some() {
                    self.sound(if came.is_some() { VoiceSound::Join } else { VoiceSound::Leave });
                }
            }
            Event::Permissions => self.on_permissions(cx),
        }
        cx.notify();
    }

    /// An admin muted or unmuted this person, which takes the microphone away or lets it back.
    fn on_permissions(&mut self, cx: &mut Context<Self>) {
        let Some(room) = self.room.clone() else { return };
        let muted = !room.may_publish(room::MICROPHONE_SOURCE);
        room.server_muted.store(muted, std::sync::atomic::Ordering::Relaxed);
        if muted {
            crate::host::tokio().spawn(async move { room.unpublish_mic().await });
        } else if let Some(source) = self.mic_source.clone() {
            let off = self.mic_off();
            crate::host::tokio().spawn(async move { room.publish_mic(source, 0, off).await.ok() });
        }
        cx.notify();
    }

    /// What to do when the room goes away without anyone asking: try coming back, as far as that's worth it.
    fn on_closed(&mut self, reason: Option<livekit::DisconnectReason>, cx: &mut Context<Self>) {
        use livekit::DisconnectReason as Reason;
        let (server_id, channel_id) = (self.server_id.clone(), self.channel_id.clone());
        self.close_room();
        // Coming back shares nothing until someone asks again, and the server knows that from the new connection.
        self.screen = None;
        let (Some(server_id), Some(channel_id)) = (server_id, channel_id) else { return };
        if matches!(reason, Some(Reason::ParticipantRemoved | Reason::RoomDeleted | Reason::DuplicateIdentity | Reason::ClientInitiated)) {
            self.leave(cx);
            return;
        }
        if self.reconnects >= RECONNECT_ATTEMPTS {
            self.toast("Lost the connection to voice.", ToastKind::Error, cx);
            self.leave(cx);
            return;
        }
        self.reconnects += 1;
        self.status = VoiceStatus::Reconnecting;
        self.attempt += 1;
        let mine = self.attempt;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RECONNECT_WAIT).await;
            this.update(cx, |voice, cx| {
                if mine == voice.attempt {
                    voice.connect(server_id, channel_id, mine, JoinHow::default(), cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Calls the people in a conversation, starting a direct message if nobody's written in it yet.
    pub fn start_call(&mut self, server_id: String, conversation_key: String, camera: bool, cx: &mut Context<Self>) {
        let call = self.core(cx).call(Some(&server_id), "prepareCall", vec![json!(conversation_key)]);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |voice, cx| match result {
                Ok(group) => {
                    let group_id = group.as_str().unwrap_or_default().to_string();
                    // Someone else may have called meanwhile, which this joins rather than ringing anyone.
                    let going = voice.state.read(cx).servers.get(&server_id).is_some_and(|server| server.voice.values().any(|member| member.channel_id == group_id));
                    voice.join(server_id, group_id, None, JoinHow { ring: !going, camera }, cx);
                }
                Err(error) => voice.toast(if error.message.is_empty() { "Couldn't start the call.".to_string() } else { error.message }, ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    /// Stops a call ringing on all this person's devices.
    pub fn decline(&mut self, server_id: &str, group_id: &str, cx: &mut Context<Self>) {
        let call = self.core(cx).call(Some(server_id), "declineCall", vec![json!(group_id)]);
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Err(error) = call.await {
                state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
            }
        })
        .detach();
    }

    /// Rings everyone in the call's conversation who isn't in it.
    pub fn ring_again(&mut self, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else { return };
        if !self.call {
            return;
        }
        let call = self.core(cx).call(Some(&server_id), "ringCall", vec![json!(channel_id), json!([])]);
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Err(error) = call.await {
                state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
            }
        })
        .detach();
    }

    pub fn leave(&mut self, cx: &mut Context<Self>) {
        if self.status == VoiceStatus::Idle {
            return;
        }
        let (server_id, channel_id) = (self.server_id.clone(), self.channel_id.clone());
        self.attempt += 1;
        self.close_room();
        if let Some(server_id) = &server_id {
            let call = self.core(cx).call(Some(server_id), "setVoiceState", vec![Value::Null, Value::Null]);
            cx.background_executor().spawn(async move { call.await.ok() }).detach();
        }
        self.reset();
        self.close_stage(server_id, channel_id, cx);
        self.sound(VoiceSound::SelfLeave);
        self.update_ringing(cx);
        self.update_ptt(cx);
        cx.notify();
    }

    pub fn toggle_mute(&mut self, cx: &mut Context<Self>) {
        if self.no_mic || self.server_muted {
            return;
        }
        // Unmuting while deafened undoes both, as being deafened means hearing nothing and saying nothing.
        if self.deafened {
            self.deafened = false;
            self.muted = false;
            self.apply_volumes();
            self.apply_mute(cx);
            self.sound(VoiceSound::Undeafen);
            cx.notify();
            return;
        }
        let was = self.muted;
        self.muted = !was;
        self.apply_mute(cx);
        self.sound(if was { VoiceSound::Unmute } else { VoiceSound::Mute });
        cx.notify();
    }

    pub fn toggle_deafen(&mut self, cx: &mut Context<Self>) {
        let was = self.deafened;
        self.deafened = !was;
        self.apply_volumes();
        self.apply_mute(cx);
        self.sound(if was { VoiceSound::Undeafen } else { VoiceSound::Deafen });
        cx.notify();
    }

    pub fn toggle_camera(&mut self, cx: &mut Context<Self>) {
        let Some(room) = self.room.clone() else { return };
        let on = !self.camera;
        let device = self.settings.camera_device.clone();
        cx.spawn(async move |this, cx| {
            let result = crate::host::tokio().spawn(async move { room.set_camera(on, &device).await }).await.unwrap_or_else(|_| Err("There's no camera Zuna can use.".into()));
            this.update(cx, |voice, cx| {
                match result {
                    Ok(()) => {
                        voice.camera = on;
                        voice.announce(cx);
                    }
                    Err(error) => voice.toast(error, ToastKind::Error, cx),
                }
                voice.sync_videos(cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn set_volume(&mut self, user_id: &str, volume: f32, cx: &mut Context<Self>) {
        self.volumes.insert(user_id.to_string(), volume);
        self.save_soon(cx);
        self.apply_volumes();
        cx.notify();
    }

    pub fn set_stream_volume(&mut self, user_id: &str, volume: f32, cx: &mut Context<Self>) {
        self.stream_volumes.insert(user_id.to_string(), volume);
        self.save_soon(cx);
        self.apply_volumes();
        cx.notify();
    }

    /// Saves the settings and everyone's volumes once changes stop for a moment, off the
    /// window's thread, as a slider being dragged changes them many times a second.
    fn save_soon(&mut self, cx: &mut Context<Self>) {
        self.save_task = Some(cx.spawn(async move |voice, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let Ok((settings, volumes, stream_volumes)) = voice.read_with(cx, |voice, _| (voice.settings.clone(), voice.volumes.clone(), voice.stream_volumes.clone())) else { return };
            cx.background_executor()
                .spawn(async move {
                    settings.save();
                    settings::save_volumes(&volumes, false);
                    settings::save_volumes(&stream_volumes, true);
                })
                .await;
        }));
    }

    pub fn toggle_local_mute(&mut self, user_id: &str, cx: &mut Context<Self>) {
        if !self.local_mutes.remove(user_id) {
            self.local_mutes.insert(user_id.to_string());
        }
        self.apply_volumes();
        cx.notify();
    }

    pub fn set_focus(&mut self, focus: Option<String>, cx: &mut Context<Self>) {
        self.focus = focus;
        cx.notify();
    }

    pub fn update_settings(&mut self, change: impl FnOnce(&mut VoiceSettings), cx: &mut Context<Self>) {
        let before = self.settings.clone();
        change(&mut self.settings);
        self.save_soon(cx);
        if before.output_device != self.settings.output_device && (self.status != VoiceStatus::Idle || self.ringing.is_some()) {
            self.mixer.open(&self.settings.output_device);
        }
        if self.mic.is_some() {
            if before.capture_key() != self.settings.capture_key() {
                self.reopen_mic(None, cx);
            } else if let Some(mic) = &self.mic {
                mic.apply(&self.settings);
            }
        }
        if let Some((mic, _)) = &self.mic_test {
            mic.apply(&self.settings);
        }
        self.apply_volumes();
        self.update_ptt(cx);
        cx.notify();
    }

    pub fn set_key_held(&mut self, down: bool, cx: &mut Context<Self>) {
        if self.key_held == down || self.settings.input_mode != "ptt" || self.status == VoiceStatus::Idle {
            return;
        }
        self.key_held = down;
        if let Some(mic) = &self.mic {
            mic.set_key(down);
        }
        if self.settings.sounds && !self.muted && !self.deafened {
            self.mixer.once(sounds::render(if down { VoiceSound::PttDown } else { VoiceSound::PttUp }, 0.4), 1.);
        }
        cx.notify();
    }

    // --- Soundboard ---

    /// Plays a sound from the soundboard to everyone in the voice channel or call, here too.
    pub fn play_sound(&mut self, sound_id: String, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else { return };
        let self_id = self.state.read(cx).servers.get(&server_id).map(|server| server.self_id().to_string()).unwrap_or_default();
        let call = self.core(cx).call(Some(&server_id), "playSound", vec![json!(channel_id), json!(sound_id)]);
        cx.spawn(async move |this, cx| {
            // The server says first whether it may be played, and only then does it play here.
            let result = call.await;
            this.update(cx, |voice, cx| match result {
                Ok(_) => voice.play_here(server_id, sound_id, self_id, cx),
                Err(error) => voice.toast(error.message, ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    /// Plays a sound from the soundboard here, as someone played it, unless this device hears nothing
    /// of theirs: deafened, the person muted for this device, or the soundboard turned all the way down.
    fn play_here(&mut self, server_id: String, sound_id: String, user_id: String, cx: &mut Context<Self>) {
        if self.room.is_none() || self.server_id.as_deref() != Some(&server_id) || self.deafened || self.local_mutes.contains(&user_id) || self.settings.soundboard_volume <= 0. {
            return;
        }
        let key = format!("{server_id}/{sound_id}");
        if let Some(samples) = self.sound_cache.get(&key).cloned() {
            self.play_samples(&server_id, &sound_id, &user_id, samples, cx);
            return;
        }
        let call = self.core(cx).call(Some(&server_id), "soundFile", vec![json!(sound_id)]);
        cx.spawn(async move |this, cx| {
            let file = call.await;
            let samples = file.ok().and_then(|value| crate::host::value_bytes(&value)).and_then(|bytes| decode_wav(&bytes));
            this.update(cx, |voice, cx| {
                let Some(samples) = samples else { return };
                let samples = Arc::new(samples);
                voice.sound_cache.insert(key, samples.clone());
                if voice.room.is_some() && !voice.deafened {
                    voice.play_samples(&server_id, &sound_id, &user_id, samples, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn play_samples(&mut self, server_id: &str, sound_id: &str, user_id: &str, samples: Arc<Vec<f32>>, cx: &mut Context<Self>) {
        let seconds = samples.len() as f64 / 2. / audio::RATE as f64;
        self.mixer.once(samples.as_ref().clone(), self.settings.output_volume * self.settings.soundboard_volume);
        let emoji = self.state.read(cx).servers.get(server_id).and_then(|server| server.sounds.iter().find(|sound| sound.id == sound_id)).map(|sound| sound.emoji.clone()).filter(|emoji| !emoji.is_empty()).unwrap_or_else(|| "🔊".into());
        self.sounding.insert(user_id.to_string(), emoji);
        let user = user_id.to_string();
        let hold = Duration::from_millis((seconds * 1000.) as u64 + SOUNDING_HOLD_MS);
        self.sounding_tasks.insert(
            user.clone(),
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(hold).await;
                this.update(cx, |voice, cx| {
                    voice.sounding.remove(&user);
                    voice.sounding_tasks.remove(&user);
                    cx.notify();
                })
                .ok();
            }),
        );
        cx.notify();
    }

    /// Plays a sound from the soundboard here only, outside any call, as when an admin listens to one.
    pub fn preview_sound(&mut self, server_id: String, sound_id: String, cx: &mut Context<Self>) {
        let volume = { let level = self.settings.output_volume * self.settings.soundboard_volume; if level > 0. { level } else { 0.6 } };
        let key = format!("{server_id}/{sound_id}");
        if let Some(samples) = self.sound_cache.get(&key).cloned() {
            self.mixer.open(&self.settings.output_device);
            self.mixer.once(samples.as_ref().clone(), volume);
            return;
        }
        let call = self.core(cx).call(Some(&server_id), "soundFile", vec![json!(sound_id)]);
        cx.spawn(async move |this, cx| {
            let samples = call.await.ok().and_then(|value| crate::host::value_bytes(&value)).and_then(|bytes| decode_wav(&bytes));
            this.update(cx, |voice, cx| match samples {
                Some(samples) => {
                    let samples = Arc::new(samples);
                    voice.sound_cache.insert(key, samples.clone());
                    voice.mixer.open(&voice.settings.output_device);
                    voice.mixer.once(samples.as_ref().clone(), volume);
                }
                None => voice.toast("That sound couldn't be played.", ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    // --- Ringing ---

    /// Rings for a call coming in, or for the one calling while it rings the others and nobody else has come.
    pub fn update_ringing(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let incoming = incoming_calls(state, self.server_id.as_deref(), self.channel_id.as_deref());
        let server = self.server_id.as_ref().and_then(|id| state.servers.get(id));
        let self_id = server.map(|server| server.self_id().to_string()).unwrap_or_default();
        let ringing_others = self.call
            && self.status == VoiceStatus::Connected
            && self.channel_id.as_ref().is_some_and(|room| {
                server.is_some_and(|server| server.calls.get(room).is_some_and(|call| !call.ringing.is_empty()) && !server.voice.values().any(|member| &member.channel_id == room && member.user_id != self_id))
            });
        let ring = if incoming.iter().any(|item| !item.quiet) {
            Some(Ringing::Incoming)
        } else if ringing_others {
            Some(Ringing::Outgoing)
        } else {
            None
        };
        if ring == self.ringing {
            return;
        }
        self.ringing = ring;
        self.ring_task = None;
        let Some(kind) = ring else { return };
        self.mixer.open(&self.settings.output_device);
        let (every, samples) = sounds::ring(kind, self.settings.output_volume.min(1.));
        let mixer = self.mixer.clone();
        self.ring_task = Some(cx.background_executor().spawn(async move {
            loop {
                mixer.once(samples.clone(), 1.);
                smol_timer(Duration::from_millis(every)).await;
            }
        }));
    }

    // --- What the core says ---

    /// Who's in the voice channel this device is in changed, so its media key did too.
    pub fn on_key(&mut self, server_id: &str, channel_id: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) {
            return;
        }
        let Some(room) = self.room.clone() else { return };
        let call = self.core(cx).call(Some(server_id), "voiceKey", vec![json!(channel_id)]);
        cx.background_executor()
            .spawn(async move {
                match call.await {
                    Ok(key) => {
                        let epoch = key.get("epoch").and_then(Value::as_u64).unwrap_or(0);
                        if let Some(bytes) = key.get("key").and_then(read_bytes) {
                            room.update_keys(epoch, bytes, false);
                        }
                    }
                    Err(error) => log::warn!("voice keys: {}", error.message),
                }
            })
            .detach();
    }

    /// This device has been taken out of a voice channel or a call.
    pub fn on_ended(&mut self, server_id: &str, channel_id: &str, reason: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) {
            return;
        }
        self.attempt += 1;
        self.close_room();
        self.reset();
        self.close_stage(Some(server_id.to_string()), Some(channel_id.to_string()), cx);
        let was_call = !self.state.read(cx).servers.get(server_id).is_some_and(|server| server.channels.iter().any(|channel| channel.id == channel_id));
        let message = match (was_call, reason) {
            (false, "elsewhere") => "You joined this voice channel on another device.",
            (false, "disconnected") => "An admin took you out of the voice channel.",
            (false, "deleted") => "That voice channel was deleted.",
            (_, "banned") => "You were removed from this server.",
            (true, "elsewhere") => "You joined this call on another device.",
            (true, "removed") => "You're no longer in this conversation, so you left its call.",
            (true, "deleted") => "That conversation was deleted.",
            (true, _) => "You left the call.",
            (false, _) => "You left the voice channel.",
        };
        self.toast(message, ToastKind::Info, cx);
        self.sound(VoiceSound::SelfLeave);
        self.update_ringing(cx);
        self.update_ptt(cx);
        cx.notify();
    }

    /// A direct message's call that nobody answers ends by itself, as a phone call does.
    pub fn on_call(&mut self, server_id: &str, group_id: &str, call: Option<CallView>, cx: &mut Context<Self>) {
        self.update_ringing(cx);
        let Some(call) = call else { return };
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(group_id) || self.status == VoiceStatus::Idle {
            return;
        }
        if !call.ringing.is_empty() {
            self.call_rang = true;
            return;
        }
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(server_id) else { return };
        let self_id = server.self_id().to_string();
        let Some(conversation) = conversation_of_group(server, group_id) else { return };
        if !self.call_rang || conversation.kind != "dm" || call.started_by != self_id {
            return;
        }
        if server.voice.values().any(|member| member.channel_id == group_id && member.user_id != self_id) {
            return;
        }
        let name = conversation.peer_id.as_ref().and_then(|peer| server.users.get(peer)).map(|user| user.display_name.clone()).unwrap_or_else(|| conversation.title.clone());
        let declined = conversation.peer_id.as_ref().is_some_and(|peer| call.declined.contains(peer));
        self.leave(cx);
        self.toast(if declined { format!("{name} declined the call.") } else { format!("{name} didn't answer.") }, ToastKind::Info, cx);
    }

    /// Being muted by an admin, or no longer, comes with the rest of what's said about this device.
    pub fn on_member(&mut self, server_id: &str, member: &VoiceMember, cx: &mut Context<Self>) {
        self.update_ringing(cx);
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(member.channel_id.as_str()) {
            return;
        }
        let device = self.state.read(cx).servers.get(server_id).and_then(|server| server.me.as_ref()).map(|me| me.device_id.clone()).unwrap_or_default();
        if member.device_id != device || member.server_muted == self.server_muted {
            return;
        }
        self.server_muted = member.server_muted;
        self.apply_mute(cx);
        self.toast(if member.server_muted { "An admin muted you." } else { "An admin unmuted you." }, ToastKind::Info, cx);
        self.sound(if member.server_muted { VoiceSound::Mute } else { VoiceSound::Unmute });
        cx.notify();
    }

    /// And once the other person in a direct message's call hangs up, it's over.
    pub fn on_left(&mut self, server_id: &str, channel_id: &str, user_id: &str, cx: &mut Context<Self>) {
        self.update_ringing(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(server_id) else { return };
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) || self.status == VoiceStatus::Idle || user_id == server.self_id() {
            return;
        }
        if conversation_of_group(server, channel_id).is_none_or(|conversation| conversation.kind != "dm") {
            return;
        }
        let (server_id, channel_id) = (server_id.to_string(), channel_id.to_string());
        self.hang_up = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PEER_GONE).await;
            this.update(cx, |voice, cx| {
                if voice.server_id.as_deref() != Some(&server_id) || voice.channel_id.as_deref() != Some(&channel_id) {
                    return;
                }
                let state = voice.state.read(cx);
                let alone = state.servers.get(&server_id).is_none_or(|server| {
                    let self_id = server.self_id();
                    !server.voice.values().any(|member| member.channel_id == channel_id && member.user_id != self_id)
                });
                if alone {
                    voice.leave(cx);
                }
            })
            .ok();
        }));
    }

    /// Someone else in the voice channel or call this device is in played a sound from the soundboard.
    pub fn on_sound(&mut self, server_id: &str, channel_id: &str, user_id: &str, sound_id: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) {
            return;
        }
        self.play_here(server_id.to_string(), sound_id.to_string(), user_id.to_string(), cx);
    }

    /// This device is no longer on a server, so it can't be in any of its voice channels.
    pub fn on_server_gone(&mut self, server_id: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() == Some(server_id) {
            self.leave(cx);
        }
        self.update_ringing(cx);
    }
}

/// Handles one of the core's events that voice cares about. Called after the app's state has taken it in.
pub fn on_event(event: &Value, cx: &mut App) {
    let Some(voice) = get(cx) else { return };
    let text = |name: &str| event.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    let server_id = text("serverId");
    match event.get("type").and_then(Value::as_str).unwrap_or_default() {
        "voice" => {
            let member = event.get("member").filter(|member| !member.is_null()).cloned().map(serde_json::from_value::<VoiceMember>);
            voice.update(cx, |voice, cx| match member {
                Some(Ok(member)) => voice.on_member(&server_id, &member, cx),
                _ => voice.on_left(&server_id, &text("channelId"), &text("userId"), cx),
            });
        }
        "voice_key" => voice.update(cx, |voice, cx| voice.on_key(&server_id, &text("channelId"), cx)),
        "voice_ended" => voice.update(cx, |voice, cx| voice.on_ended(&server_id, &text("channelId"), &text("reason"), cx)),
        "screen_ended" => voice.update(cx, |voice, cx| voice.on_screen_ended(&server_id, &text("channelId"), &text("reason"), cx)),
        "call" => {
            let call = event.get("call").filter(|call| !call.is_null()).cloned().and_then(|call| serde_json::from_value::<CallView>(call).ok());
            voice.update(cx, |voice, cx| voice.on_call(&server_id, &text("groupId"), call, cx));
        }
        "calls" => voice.update(cx, |voice, cx| voice.update_ringing(cx)),
        "sound" => voice.update(cx, |voice, cx| voice.on_sound(&server_id, &text("channelId"), &text("userId"), &text("soundId"), cx)),
        "signed_out" => voice.update(cx, |voice, cx| voice.on_server_gone(&server_id, cx)),
        _ => {}
    }
}

async fn smol_timer(duration: Duration) {
    let (sender, receiver) = futures::channel::oneshot::channel::<()>();
    std::thread::spawn(move || {
        std::thread::sleep(duration);
        sender.send(()).ok();
    });
    receiver.await.ok();
}

/// A sound's WAV, as the core checked it, as interleaved stereo at 48 kHz.
pub fn decode_wav(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut at = 12;
    let (mut channels, mut rate, mut bits) = (1u16, 48_000u32, 16u16);
    let mut data: &[u8] = &[];
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
        let body = bytes.get(at + 8..(at + 8 + size).min(bytes.len()))?;
        if id == b"fmt " && body.len() >= 16 {
            channels = u16::from_le_bytes([body[2], body[3]]).max(1);
            rate = u32::from_le_bytes(body[4..8].try_into().ok()?);
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            data = body;
        }
        at += 8 + size + (size & 1);
    }
    if bits != 16 || rate == 0 || data.is_empty() {
        return None;
    }
    let frames: Vec<(f32, f32)> = data
        .chunks_exact(2 * channels as usize)
        .map(|frame| {
            let left = i16::from_le_bytes([frame[0], frame[1]]) as f32 / 32768.;
            let right = if channels > 1 { i16::from_le_bytes([frame[2], frame[3]]) as f32 / 32768. } else { left };
            (left, right)
        })
        .collect();
    let step = rate as f64 / audio::RATE as f64;
    let total = (frames.len() as f64 / step) as usize;
    let mut out = Vec::with_capacity(total * 2);
    for index in 0..total {
        let position = index as f64 * step;
        let at = position as usize;
        let fraction = (position - at as f64) as f32;
        let (a, b) = (frames[at.min(frames.len() - 1)], frames[(at + 1).min(frames.len() - 1)]);
        out.push(a.0 + (b.0 - a.0) * fraction);
        out.push(a.1 + (b.1 - a.1) * fraction);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_sender_keys_as_the_web_does() {
        // HKDF-SHA256 of 32 zero bytes, with no salt and the web's info, as voiceSenderKey computes it.
        let key = room::sender_key(&[0u8; 32], "00000000000000000000000000000001.00000000000000000000000000000002");
        assert_eq!(key.len(), 32);
        assert_ne!(key, room::sender_key(&[0u8; 32], "00000000000000000000000000000001.00000000000000000000000000000003"));
        assert_eq!(room::key_index(17), 1);
    }

    #[test]
    fn reads_identities_as_the_core_does() {
        let user = "0123456789abcdef0123456789abcdef";
        assert_eq!(room::parse_identity(&format!("{user}.{user}")), Some((user.into(), user.into(), false)));
        assert_eq!(room::parse_identity(&format!("{user}.{user}.screen")), Some((user.into(), user.into(), true)));
        assert_eq!(room::parse_identity(&format!("{user}.{user}.other")), None);
        assert_eq!(room::parse_identity("someone.else"), None);
    }

    #[test]
    fn reads_a_sound_s_wav() {
        let samples: Vec<i16> = (0..4800).map(|index| ((index as f32 / 10.).sin() * 8000.) as i16).collect();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&96_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        for sample in &samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        let decoded = decode_wav(&wav).unwrap();
        assert_eq!(decoded.len(), samples.len() * 2);
    }
}
