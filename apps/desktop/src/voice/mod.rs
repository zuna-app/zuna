//! The voice channel or call this device is in, wherever in the app the person is looking
//! (packages/ui/src/voice/store.ts). There's one at a time, across all servers, as in
//! Discord. A call is a direct message's or a group's, in a room of its own under the
//! conversation's group, and everything a voice channel has works the same in it.

pub mod audio;
pub mod awake;
pub mod mic;
#[cfg(target_os = "linux")]
pub mod pipewire;
pub mod room;
pub mod rules;
pub mod screen;
pub mod settings;
pub mod sounds;
pub mod stats;
pub mod watch;
#[cfg(target_os = "linux")]
pub mod watch_window;

mod joining;
mod controls;
mod events;

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
    pub fps: u32,
    pub kbps: u32,
    pub height: u32,
    /// Which of those the server's limits brought down, in words.
    pub held: Vec<String>,
    /// What the capture said once it started.
    pub info: Option<Value>,
}

/// How to come into a room.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JoinHow {
    /// It starts a call, ringing everyone else in the conversation.
    pub ring: bool,
    /// The camera goes on once in.
    pub camera: bool,
    /// A voice channel's own row was clicked, so it opens too, once this device is coming in.
    pub open: Option<String>,
}

/// A room this person asked to come into here, while another of their devices is in one on its server.
#[derive(Clone, Debug, PartialEq)]
pub struct VoiceMove {
    pub server_id: String,
    pub channel_id: String,
    pub return_to: Option<Option<String>>,
    pub how: JoinHow,
    /// The room the other device is in.
    pub from: String,
}

/// Another of this person's devices in a voice channel or a call on a server, where only their
/// latest stays in: the room it's in.
pub fn elsewhere(server: &ServerState) -> Option<&str> {
    let me = server.me.as_ref()?;
    server.voice.values().find(|member| member.user_id == me.user_id && member.device_id != me.device_id).map(|member| member.channel_id.as_str())
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
    /// What the room watches together, as the core holds it, or nothing when nothing's on.
    pub watch: Option<crate::models::WatchView>,
    /// The session this device's person pressed Watch for, which plays here until it ends or they stop it.
    pub watching: Option<String>,
    /// The window it plays in on Linux, which outlives the stage.
    #[cfg(target_os = "linux")]
    pub watch_here: watch_window::WatchHere,
    seek_sent: Option<std::time::Instant>,
    seek_later: Option<Task<()>>,

    room: Option<Arc<VoiceRoom>>,
    mic: Option<Microphone>,
    mic_source: Option<livekit::webrtc::audio_source::native::NativeAudioSource>,
    pub(crate) mixer: Mixer,
    /// Keeps the sound output open from coming into a voice channel or a call until it's left.
    output_hold: Option<audio::Hold>,
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
    /// The microphone being opened again, on a thread of its own.
    mic_task: Option<Task<()>>,
    /// The test's microphone being opened, and where it will play back.
    mic_test_task: Option<(Task<()>, u64)>,
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
        watch: None,
        watching: None,
        #[cfg(target_os = "linux")]
        watch_here: Default::default(),
        seek_sent: None,
        seek_later: None,
        room: None,
        mic: None,
        mic_source: None,
        mixer: Mixer::new(processing.clone()),
        output_hold: None,
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
        mic_task: None,
        mic_test_task: None,
    });
    cx.set_global(GlobalVoice(voice.clone()));
    awake::start(&voice, cx);
    // The window a video watched together plays in on Linux follows whatever changes here.
    #[cfg(target_os = "linux")]
    cx.observe(&voice, |voice, cx| voice.update(cx, |voice, cx| voice.keep_watch_window(cx))).detach();
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
    if !ready {
        state.update(cx, |state, cx| {
            state.select_conversation(Some(key), cx);
            state.toast("This server has no media server yet, so its voice channels can't be joined.", ToastKind::Info, cx);
        });
        return;
    }
    // It opens as this device comes in, which may wait to be asked about.
    if let Some(voice) = get(cx) {
        let (server_id, channel_id) = (server.entry.id.clone(), channel.id.clone());
        voice.update(cx, |voice, cx| voice.join(server_id, channel_id, return_to, JoinHow { open: Some(key), ..Default::default() }, cx));
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
        // A bot stays out of calls.
        "dm" => conversation.peer_id.as_deref().is_some_and(|peer| peer != self_id) && !conversation.bot && !conversation.blocked && !peer_banned && !conversation.removed,
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
        if self.mic_test.is_some() || self.mic_test_task.is_some() || self.status != VoiceStatus::Idle {
            self.stop_mic_test(cx);
            return;
        }
        self.mixer.open(&self.settings.output_device);
        let back = self.mixer.live(1.);
        let mixer = self.mixer.clone();
        let opening = open_microphone(&self.settings, false, self.processing.clone(), move |frame| mixer.push(back, &frame, 1), cx);
        let task = cx.spawn(async move |this, cx| {
            let opened = opening.await;
            this.update(cx, |voice, cx| {
                voice.mic_test_task = None;
                match opened {
                    Ok(mic) => voice.mic_test = Some((mic, back)),
                    Err(problem) => {
                        voice.mixer.remove(back);
                        *voice.processing.lock() = None;
                        voice.toast(problem, ToastKind::Error, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        });
        self.mic_test_task = Some((task, back));
        cx.notify();
    }

    fn stop_mic_test(&mut self, cx: &mut Context<Self>) {
        // A test still opening is dropped, and its microphone with it, once it's open. Where
        // it would have played goes too, or the output would stay open for it.
        if let Some((_, back)) = self.mic_test_task.take() {
            self.mixer.remove(back);
        }
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
        // The output closes once whatever is still playing, such as the sound of leaving, has played.
        self.output_hold = None;
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
        self.watch = None;
        self.watching = None;
        self.seek_later = None;
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
        // The video watched together stays on the stage while it's on, as the web's store keeps it.
        let still_there = self.focus.as_ref().is_some_and(|focus| (focus == watch::WATCH_FOCUS && self.watch.is_some()) || videos.iter().any(|video| &video.key == focus));
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
        self.mic_task = None;
        *self.processing.lock() = None;
        self.ring_on_announce = false;
        self.call_rang = false;
        self.hang_up = None;
        self.events_task = None;
        self.tick_task = None;
    }

    // --- Coming in and going ---

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
        "watch" => {
            let watch = event.get("watch").filter(|watch| !watch.is_null()).cloned().and_then(|watch| serde_json::from_value::<crate::models::WatchView>(watch).ok());
            voice.update(cx, |voice, cx| voice.on_watch(&server_id, &text("channelId"), watch, cx));
        }
        "signed_out" => voice.update(cx, |voice, cx| voice.on_server_gone(&server_id, cx)),
        _ => {}
    }
}

/// Opens the microphone, with the processing a call gets, on a thread of its own: finding the
/// device and starting it waits on the system, which on Windows lists every input by name,
/// and on macOS may not answer at all.
fn open_microphone(settings: &VoiceSettings, muted: bool, processing: SharedProcessing, sink: impl FnMut(Vec<i16>) + Send + 'static, cx: &mut Context<Voice>) -> Task<Result<Microphone, String>> {
    let settings = settings.clone();
    cx.background_executor().spawn(async move {
        let module = livekit::webrtc::native::apm::AudioProcessingModule::new(settings.echo_cancellation, settings.auto_gain, true, settings.noise_suppression == "standard");
        *processing.lock() = Some(Processing(module));
        Microphone::open(&settings, muted, processing.clone(), sink).inspect_err(|_| *processing.lock() = None)
    })
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
        assert_eq!(room::parse_identity(&format!("{user}.{user}")), Some((user.into(), user.into())));
        // A participant of a share's own, as the separate program once was, isn't let in.
        assert_eq!(room::parse_identity(&format!("{user}.{user}.screen")), None);
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
