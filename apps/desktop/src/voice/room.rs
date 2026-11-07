//! One connection to a voice channel's room on the media server, which only ever sees
//! encrypted media (packages/ui/src/voice/room.ts). Keys come from the channel's MLS group
//! through the core. LiveKit's Rust SDK encrypts frames as livekit-client does, so the
//! desktop, the web and the iPhone open what this sends and the other way round.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use livekit::e2ee::key_provider::{KeyDerivationAlgorithm, KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::id::{ParticipantIdentity, TrackSid};
use livekit::options::{AudioEncoding, TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::{AudioFrame, I420Buffer, VideoBuffer, VideoFrame, VideoResolution, VideoRotation};
use livekit::webrtc::video_source::RtcVideoSource;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use parking_lot::Mutex;
use sha2::Sha256;

use super::audio::{FRAME, Mixer, RATE};

/// How long after hearing of a new key this device starts sending under it, so that
/// everyone else has heard too. It keeps listening under both meanwhile.
const NEW_KEY_SEND_DELAY: Duration = Duration::from_millis(1500);
/// How many keys each sender's frames can be under at once, as LiveKit keeps them (VOICE_KEY_RING).
const KEY_RING: i32 = 16;
/// The microphone and a share, in how LiveKit's protocol numbers what can be published.
pub const MICROPHONE_SOURCE: i32 = 2;
pub const SCREEN_SOURCE: i32 = 3;
pub const SCREEN_SOUND_SOURCE: i32 = 4;
const DEFAULT_AUDIO_KBPS: u64 = 64;

/// Who a device is in a room, from its identity: `user.device`, or `user.device.screen` for its native share.
pub fn parse_identity(identity: &str) -> Option<(String, String, bool)> {
    let parts: Vec<&str> = identity.split('.').collect();
    let hex = |text: &str| text.len() == 32 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    match parts.as_slice() {
        [user, device] if hex(user) && hex(device) => Some((user.to_string(), device.to_string(), false)),
        [user, device, "screen"] if hex(user) && hex(device) => Some((user.to_string(), device.to_string(), true)),
        _ => None,
    }
}

fn user_of(identity: &str) -> Option<String> {
    parse_identity(identity).map(|(user, _, _)| user)
}

/// The key one sender's media is under, from the room's key for an epoch (`voiceSenderKey`).
pub fn sender_key(room_key: &[u8], identity: &str) -> Vec<u8> {
    let hkdf = hkdf::Hkdf::<Sha256>::new(Some(&[]), room_key);
    let mut out = vec![0u8; 32];
    hkdf.expand(format!("zuna/voice/sender/v1|{identity}").as_bytes(), &mut out).expect("32 bytes is a valid length");
    out
}

/// Which of a sender's key slots an epoch's key goes in. A few epochs go by before one is reused.
pub fn key_index(epoch: u64) -> i32 {
    (epoch % KEY_RING as u64) as i32
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Connected,
    Reconnecting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Quality {
    Excellent,
    Good,
    Poor,
    Lost,
    #[default]
    Unknown,
}

/// What the room says, for the voice store.
#[derive(Debug)]
pub enum Event {
    Status(Status),
    /// It went away without being asked to, and why, in LiveKit's words.
    Closed(Option<livekit::DisconnectReason>),
    /// Who's sending what changed.
    Media,
    Speaking(HashSet<String>),
    Quality(Quality),
    /// Someone came in or left, not counting native shares.
    Participants(Option<String>, Option<String>),
    /// What this device may publish changed: an admin's mute, or a share being allowed.
    Permissions,
}

/// A picture to show, BGRA, top row first.
#[derive(Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgra: Arc<Vec<u8>>,
    /// Counts up with each new frame, so a view knows when to draw again.
    pub serial: u64,
    /// On macOS, what VideoToolbox decoded, as it is on the GPU, in place of `bgra`, which is
    /// then empty: GPUI draws it from there, so it never passes through the CPU.
    #[cfg(target_os = "macos")]
    pub surface: Option<crate::platform::screen_capture::Picture>,
}

pub type Feed = Arc<Mutex<Option<Frame>>>;

/// Rings each time any video has a new picture, so that a view showing one draws it then.
static PICTURES: std::sync::LazyLock<tokio::sync::watch::Sender<u64>> = std::sync::LazyLock::new(|| tokio::sync::watch::Sender::new(0));

/// Puts a video's new picture in its feed, and rings for it.
fn show(feed: &Feed, frame: Frame) {
    *feed.lock() = Some(frame);
    PICTURES.send_modify(|count| *count = count.wrapping_add(1));
}

/// Changes as any video has a new picture. Pictures that come while one is being drawn
/// ring once between them.
pub fn pictures() -> tokio::sync::watch::Receiver<u64> {
    PICTURES.subscribe()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoSource {
    Camera,
    Screen,
}

/// One video someone is sending.
#[derive(Clone)]
pub struct VideoTile {
    pub key: String,
    pub user_id: String,
    pub identity: String,
    pub source: VideoSource,
    pub local: bool,
    /// A share someone else is sending with its sound, which can be made quieter here.
    pub sound: bool,
    pub feed: Feed,
}

impl PartialEq for VideoTile {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key && self.sound == other.sound
    }
}

struct RemoteAudio {
    user_id: String,
    screen: bool,
    mixer_id: u64,
    stop: Arc<AtomicBool>,
}

struct RemoteVideo {
    feed: Feed,
    stop: Arc<AtomicBool>,
}

/// How loud each person is: their voice, and their share's sound.
pub type Volumes = Arc<dyn Fn(&str, bool) -> f32 + Send + Sync>;

struct Shared {
    mixer: Mixer,
    audio: Mutex<HashMap<TrackSid, RemoteAudio>>,
    videos: Mutex<HashMap<TrackSid, RemoteVideo>>,
    volumes: Mutex<Volumes>,
    closed: AtomicBool,
    identity: String,
    /// The keys in use, newest first: (index, key, epoch).
    keys: Mutex<Vec<(i32, Vec<u8>, u64)>>,
    provider: KeyProvider,
    /// The key index this device sends under.
    sending: Mutex<i32>,
    /// Bumped with each new key, so a delayed switch that's been overtaken does nothing.
    key_serial: AtomicU64,
    /// Told each room key this device starts sending under, for a native share to follow.
    on_send_key: Mutex<Option<SendKeyHook>>,
}

pub type SendKeyHook = Arc<dyn Fn(&[u8], i32) + Send + Sync>;

pub struct VoiceRoom {
    room: Arc<Room>,
    shared: Arc<Shared>,
    mic: Mutex<Option<(NativeAudioSource, LocalTrackPublication)>>,
    camera: Mutex<Option<(LocalTrackPublication, crate::media::record::Camera, Feed)>>,
    share_sound: Mutex<Option<(NativeAudioSource, LocalTrackPublication)>>,
    /// On macOS a share's picture goes from this connection, as a browser's does.
    #[cfg(target_os = "macos")]
    share_video: Mutex<Option<(NativeVideoSource, LocalTrackPublication)>>,
    pub server_muted: AtomicBool,
    pub url: String,
}

fn key_options() -> KeyProviderOptions {
    // As in the apps: a key that doesn't open a frame is no reason to give up on it, and
    // HKDF, as a key from the MLS exporter is already random.
    KeyProviderOptions { key_derivation_algorithm: KeyDerivationAlgorithm::HKDF, ratchet_window_size: 0, failure_tolerance: -1, key_ring_size: KEY_RING, ..Default::default() }
}

impl VoiceRoom {
    /// Comes into a room, listening under the room's first key. Throws with something to tell the person.
    pub async fn join(url: String, token: String, identity: String, epoch: u64, room_key: Vec<u8>, mixer: Mixer, volumes: Volumes) -> Result<(VoiceRoom, UnboundedReceiver<Event>), String> {
        let provider = KeyProvider::new(key_options());
        let index = key_index(epoch);
        provider.set_key(&ParticipantIdentity(identity.clone()), index, sender_key(&room_key, &identity));
        let mut options = RoomOptions::default();
        options.auto_subscribe = true;
        options.adaptive_stream = true;
        options.dynacast = true;
        options.encryption = Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider: provider.clone() });
        let (room, events) = Room::connect(&url, &token, options).await.map_err(|error| {
            log::warn!("joining a voice room: {error}");
            "Couldn't connect to voice.".to_string()
        })?;
        room.e2ee_manager().set_enabled(true);
        let shared = Arc::new(Shared {
            mixer,
            audio: Mutex::new(HashMap::new()),
            videos: Mutex::new(HashMap::new()),
            volumes: Mutex::new(volumes),
            closed: AtomicBool::new(false),
            identity: identity.clone(),
            keys: Mutex::new(vec![(index, room_key, epoch)]),
            provider,
            sending: Mutex::new(index),
            key_serial: AtomicU64::new(0),
            on_send_key: Mutex::new(None),
        });
        let room = Arc::new(room);
        // Those already here, and everything they send.
        for participant in room.remote_participants().values() {
            shared.install_for(&participant.identity().0);
            for publication in participant.track_publications().values() {
                if let Some(track) = publication.track() {
                    shared.subscribed(&room, track, publication.clone(), participant.clone());
                }
            }
        }
        let (sender, receiver) = unbounded();
        tokio_spawn(watch(room.clone(), shared.clone(), events, sender));
        Ok((VoiceRoom { room, shared, mic: Mutex::new(None), camera: Mutex::new(None), share_sound: Mutex::new(None), #[cfg(target_os = "macos")] share_video: Mutex::new(None), server_muted: AtomicBool::new(false), url }, receiver))
    }

    /// LiveKit's room, for reading its statistics.
    pub fn room_handle(&self) -> &Room {
        &self.room
    }

    pub fn identity(&self) -> &str {
        &self.shared.identity
    }

    /// Whether this device may publish a source, as the media server says.
    pub fn may_publish(&self, source: i32) -> bool {
        let allowed = self.room.local_participant().permission().map(|permission| permission.can_publish_sources).unwrap_or_default();
        allowed.is_empty() || allowed.contains(&source)
    }

    // --- Keys ---

    /// A new epoch's key: everyone else is listened to under it at once, and this device sends under it a moment later.
    pub fn update_keys(&self, epoch: u64, room_key: Vec<u8>, first: bool) {
        let _runtime = crate::host::tokio().enter();
        let shared = self.shared.clone();
        {
            let mut keys = shared.keys.lock();
            if keys.first().is_some_and(|(_, _, current)| *current == epoch) {
                return;
            }
            let index = key_index(epoch);
            keys.insert(0, (index, room_key.clone(), epoch));
            keys.truncate(2);
        }
        let index = key_index(epoch);
        for participant in self.room.remote_participants().values() {
            let identity = participant.identity();
            shared.provider.set_key(&identity, index, sender_key(&room_key, &identity.0));
        }
        let serial = shared.key_serial.fetch_add(1, Ordering::Relaxed) + 1;
        let room = self.room.clone();
        let switch = move || {
            if shared.key_serial.load(Ordering::Relaxed) != serial || shared.closed.load(Ordering::Relaxed) {
                return;
            }
            shared.provider.set_key(&ParticipantIdentity(shared.identity.clone()), index, sender_key(&room_key, &shared.identity));
            *shared.sending.lock() = index;
            shared.apply_sending_index(&room);
            let hook = shared.on_send_key.lock().clone();
            if let Some(hook) = hook {
                hook(&room_key, index);
            }
        };
        if first {
            switch();
        } else {
            tokio_spawn(async move {
                tokio::time::sleep(NEW_KEY_SEND_DELAY).await;
                switch();
            });
        }
    }

    /// Hears each new room key this device sends under, or stops hearing with None.
    pub fn set_send_key_hook(&self, hook: Option<SendKeyHook>) {
        *self.shared.on_send_key.lock() = hook;
    }

    /// The room's key now, for a native screen share: (index, key).
    pub fn current_key(&self) -> Option<(i32, Vec<u8>)> {
        self.shared.keys.lock().first().map(|(index, key, _)| (*index, key.clone()))
    }

    // --- Microphone ---

    /// The source the microphone's frames go to, before it's published.
    pub fn microphone_source() -> NativeAudioSource {
        NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, RATE, 1, 0)
    }

    /// Publishes the microphone, unless an admin's mute means the media server wouldn't take it.
    pub async fn publish_mic(&self, source: NativeAudioSource, kbps: u64, muted: bool) -> Result<(), String> {
        if self.server_muted.load(Ordering::Relaxed) || self.mic.lock().is_some() {
            return Ok(());
        }
        let track = LocalAudioTrack::create_audio_track("microphone", RtcAudioSource::Native(source.clone()));
        let options = TrackPublishOptions {
            source: TrackSource::Microphone,
            dtx: true,
            red: true,
            audio_encoding: Some(AudioEncoding { max_bitrate: (if kbps > 0 { kbps } else { DEFAULT_AUDIO_KBPS }) * 1000 }),
            ..Default::default()
        };
        let publication = self.room.local_participant().publish_track(LocalTrack::Audio(track), options).await.map_err(|error| error.to_string())?;
        if muted {
            publication.mute();
        }
        self.shared.apply_sending_index(&self.room);
        *self.mic.lock() = Some((source, publication));
        Ok(())
    }

    pub async fn unpublish_mic(&self) {
        let taken = self.mic.lock().take();
        if let Some((_, publication)) = taken {
            self.room.local_participant().unpublish_track(&publication.sid()).await.ok();
        }
    }

    /// The source the microphone sends to, once published.
    pub fn mic_source(&self) -> Option<NativeAudioSource> {
        self.mic.lock().as_ref().map(|(source, _)| source.clone())
    }

    pub fn set_muted(&self, muted: bool) {
        // LiveKit tells the media server from a task of its own, which needs the runtime.
        let _runtime = crate::host::tokio().enter();
        if let Some((_, publication)) = self.mic.lock().as_ref() {
            if muted { publication.mute() } else { publication.unmute() }
        }
    }

    // --- Listening ---

    /// Says how loud everyone is, which also covers being deafened.
    pub fn set_volumes(&self, volumes: Volumes) {
        *self.shared.volumes.lock() = volumes;
        self.shared.apply_volumes();
    }

    // --- Video ---

    /// Everything being sent that can be watched, and from here.
    pub fn videos(&self) -> Vec<VideoTile> {
        let mut tiles = Vec::new();
        let local = self.room.local_participant();
        if let Some((publication, _, feed)) = self.camera.lock().as_ref() {
            if !publication.is_muted() {
                if let Some(user) = user_of(&self.shared.identity) {
                    tiles.push(VideoTile { key: format!("{}/{}", self.shared.identity, publication.sid()), user_id: user, identity: self.shared.identity.clone(), source: VideoSource::Camera, local: true, sound: false, feed: feed.clone() });
                }
            }
        }
        let _ = local;
        // A native share's sound goes out from the person's own connection, beside the picture from another.
        let mut sound = HashSet::new();
        for participant in self.room.remote_participants().values() {
            if let Some(user) = user_of(&participant.identity().0) {
                if participant.track_publications().values().any(|publication| publication.source() == TrackSource::ScreenshareAudio) {
                    sound.insert(user);
                }
            }
        }
        let videos = self.shared.videos.lock();
        for participant in self.room.remote_participants().values() {
            let identity = participant.identity().0;
            let Some((user, _, _)) = parse_identity(&identity) else { continue };
            // This device's own native share isn't sent back to it.
            if identity == format!("{}.screen", self.shared.identity) {
                continue;
            }
            for (sid, publication) in participant.track_publications() {
                if publication.kind() != TrackKind::Video || publication.is_muted() {
                    continue;
                }
                let Some(video) = videos.get(&sid) else { continue };
                let source = if publication.source() == TrackSource::Screenshare { VideoSource::Screen } else { VideoSource::Camera };
                tiles.push(VideoTile { key: format!("{identity}/{sid}"), user_id: user.clone(), identity: identity.clone(), source, local: false, sound: source == VideoSource::Screen && sound.contains(&user), feed: video.feed.clone() });
            }
        }
        tiles
    }

    pub fn camera_on(&self) -> bool {
        self.camera.lock().is_some()
    }

    /// Turns the camera on or off, or says why it can't come on.
    pub async fn set_camera(&self, on: bool, device: &str) -> Result<(), String> {
        if !on {
            let taken = self.camera.lock().take();
            if let Some((publication, camera, _)) = taken {
                drop(camera);
                self.room.local_participant().unpublish_track(&publication.sid()).await.ok();
            }
            return Ok(());
        }
        if self.camera.lock().is_some() {
            return Ok(());
        }
        let feed: Feed = Arc::new(Mutex::new(None));
        let (width, height) = (1280u32, 720u32);
        let source = NativeVideoSource::new(VideoResolution { width, height }, false);
        let sending = source.clone();
        let preview = feed.clone();
        let serial = AtomicU64::new(0);
        let camera = crate::media::record::Camera::start_feed(device, 720, move |width, height, bgra| {
            let mut buffer = I420Buffer::new(width, height);
            let (stride_y, stride_u, stride_v) = buffer.strides();
            let (y, u, v) = buffer.data_mut();
            livekit::webrtc::native::yuv_helper::argb_to_i420(&bgra, width * 4, y, stride_y, u, stride_u, v, stride_v, width as i32, height as i32);
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_micros() as i64).unwrap_or(0);
            sending.capture_frame(&VideoFrame { rotation: VideoRotation::VideoRotation0, timestamp_us: at, frame_metadata: None, buffer });
            show(&preview, Frame { width, height, bgra: Arc::new(bgra), serial: serial.fetch_add(1, Ordering::Relaxed) + 1, #[cfg(target_os = "macos")] surface: None });
        })?;
        let track = LocalVideoTrack::create_video_track("camera", RtcVideoSource::Native(source));
        let options = TrackPublishOptions {
            source: TrackSource::Camera,
            video_codec: VideoCodec::VP8,
            simulcast: true,
            video_encoding: Some(VideoEncoding { max_bitrate: 1_700_000, max_framerate: 30. }),
            ..Default::default()
        };
        let publication = self.room.local_participant().publish_track(LocalTrack::Video(track), options).await.map_err(|_| "There's no camera Zuna can use.".to_string())?;
        self.shared.apply_sending_index(&self.room);
        *self.camera.lock() = Some((publication, camera, feed));
        Ok(())
    }

    // --- A share's sound ---

    /// Sends the computer's sound beside a native share, which only captures pictures: stereo at 48 kHz.
    pub async fn start_share_sound(&self, kbps: u64) -> Result<NativeAudioSource, String> {
        let source = NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, RATE, 2, 0);
        let track = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(source.clone()));
        let options = TrackPublishOptions { source: TrackSource::ScreenshareAudio, dtx: false, red: false, audio_encoding: Some(AudioEncoding { max_bitrate: kbps * 1000 }), ..Default::default() };
        let publication = self.room.local_participant().publish_track(LocalTrack::Audio(track), options).await.map_err(|error| error.to_string())?;
        self.shared.apply_sending_index(&self.room);
        *self.share_sound.lock() = Some((source.clone(), publication));
        Ok(source)
    }

    pub async fn stop_share_sound(&self) {
        let taken = self.share_sound.lock().take();
        if let Some((_, publication)) = taken {
            self.room.local_participant().unpublish_track(&publication.sid()).await.ok();
        }
    }

    // --- A share's picture, on macOS ---

    /// Sends a screen share's picture from this connection, as the Electron app sends
    /// Chromium's on macOS: H.264 from VideoToolbox, in one layer, at the server's terms.
    #[cfg(target_os = "macos")]
    pub async fn start_share_video(&self, width: u32, height: u32, fps: u32, kbps: u32) -> Result<NativeVideoSource, String> {
        let source = NativeVideoSource::new(VideoResolution { width, height }, true);
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
        let options = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: VideoCodec::H264,
            simulcast: false,
            video_encoding: Some(VideoEncoding { max_bitrate: kbps as u64 * 1000, max_framerate: fps as f64 }),
            video_encoder: livekit::options::VideoEncoderBackend::VideoToolbox,
            ..Default::default()
        };
        let publication = self.room.local_participant().publish_track(LocalTrack::Video(track), options).await.map_err(|error| error.to_string())?;
        self.shared.apply_sending_index(&self.room);
        *self.share_video.lock() = Some((source.clone(), publication));
        Ok(source)
    }

    #[cfg(target_os = "macos")]
    pub async fn stop_share_video(&self) {
        let taken = self.share_video.lock().take();
        if let Some((_, publication)) = taken {
            self.room.local_participant().unpublish_track(&publication.sid()).await.ok();
        }
    }

    // --- Stats ---

    /// How many people are here, counting this device and not native shares.
    pub fn people(&self) -> usize {
        self.room.remote_participants().keys().filter(|identity| !parse_identity(&identity.0).is_some_and(|(_, _, screen)| screen)).count() + 1
    }

    pub fn key_state(&self) -> Option<(i32, u64)> {
        self.shared.keys.lock().first().map(|(index, _, epoch)| (*index, *epoch))
    }

    pub fn encrypted(&self) -> bool {
        self.room.e2ee_manager().enabled()
    }

    pub fn close(&self) {
        if self.shared.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        self.camera.lock().take();
        for (_, audio) in self.shared.audio.lock().drain() {
            audio.stop.store(true, Ordering::Relaxed);
            self.shared.mixer.remove(audio.mixer_id);
        }
        for (_, video) in self.shared.videos.lock().drain() {
            video.stop.store(true, Ordering::Relaxed);
        }
        let room = self.room.clone();
        tokio_spawn(async move {
            room.close().await.ok();
        });
    }
}

impl Drop for VoiceRoom {
    fn drop(&mut self) {
        self.close();
    }
}

fn tokio_spawn<F: std::future::Future<Output = ()> + Send + 'static>(future: F) {
    crate::host::tokio().spawn(future);
}

impl Shared {
    /// The keys a participant may be sending under: the older first, so the newer ends up current.
    fn install_for(&self, identity: &str) {
        if identity == self.identity {
            return;
        }
        for (index, key, _) in self.keys.lock().iter().rev() {
            self.provider.set_key(&ParticipantIdentity(identity.to_string()), *index, sender_key(key, identity));
        }
    }

    /// Points what this device sends at its current key.
    fn apply_sending_index(&self, room: &Room) {
        let index = *self.sending.lock();
        for ((identity, _), cryptor) in room.e2ee_manager().frame_cryptors() {
            if identity.0 == self.identity {
                cryptor.set_key_index(index);
            }
        }
    }

    fn apply_volumes(&self) {
        let volumes = self.volumes.lock().clone();
        for audio in self.audio.lock().values() {
            self.mixer.set_volume(audio.mixer_id, volumes(&audio.user_id, audio.screen));
        }
    }

    fn subscribed(&self, room: &Room, track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
        let identity = participant.identity().0;
        // A share from this device's native process, which there's no need to send back to it.
        if identity == format!("{}.screen", self.identity) {
            publication.set_subscribed(false);
            return;
        }
        let _ = room;
        let Some(user) = user_of(&identity) else { return };
        let sid = publication.sid();
        match track {
            RemoteTrack::Audio(audio) => {
                if self.audio.lock().contains_key(&sid) {
                    return;
                }
                let screen = publication.source() == TrackSource::ScreenshareAudio;
                let volume = (self.volumes.lock())(&user, screen);
                let channels = if screen { 2 } else { 1 };
                let mixer_id = self.mixer.live(volume);
                let stop = Arc::new(AtomicBool::new(false));
                let mut stream = NativeAudioStream::new(audio.rtc_track(), RATE as i32, channels);
                let (mixer, stopping) = (self.mixer.clone(), stop.clone());
                let heard = identity.clone();
                tokio_spawn(async move {
                    // How loud what decodes is, a second at a time, for checking voice from the log.
                    let (mut peak, mut frames) = (0i16, 0u32);
                    while let Some(frame) = stream.next().await {
                        if stopping.load(Ordering::Relaxed) {
                            break;
                        }
                        peak = peak.max(frame.data.iter().map(|sample| sample.saturating_abs()).max().unwrap_or(0));
                        frames += 1;
                        if frames == 100 {
                            log::debug!("voice: {heard} peaks at {:.3}", peak as f32 / 32768.);
                            (peak, frames) = (0, 0);
                        }
                        mixer.push(mixer_id, &frame.data, frame.num_channels);
                    }
                });
                self.audio.lock().insert(sid, RemoteAudio { user_id: user, screen, mixer_id, stop });
            }
            RemoteTrack::Video(video) => {
                if self.videos.lock().contains_key(&sid) {
                    return;
                }
                let feed: Feed = Arc::new(Mutex::new(None));
                let stop = Arc::new(AtomicBool::new(false));
                let mut stream = NativeVideoStream::new(video.rtc_track());
                let (writing, stopping) = (feed.clone(), stop.clone());
                tokio_spawn(async move {
                    let mut serial = 0u64;
                    while let Some(frame) = stream.next().await {
                        if stopping.load(Ordering::Relaxed) {
                            break;
                        }
                        #[cfg(target_os = "macos")]
                        if let Some((width, height, picture)) = crate::platform::screen_capture::decoded(frame.buffer.as_ref()) {
                            if serial == 0 {
                                log::debug!("video: decoded on the GPU at {width}×{height}, drawn from there");
                            }
                            serial += 1;
                            show(&writing, Frame { width, height, bgra: Arc::new(Vec::new()), serial, surface: Some(picture) });
                            continue;
                        }
                        let i420 = frame.buffer.to_i420();
                        let (width, height) = (i420.width(), i420.height());
                        let (stride_y, stride_u, stride_v) = i420.strides();
                        let (y, u, v) = i420.data();
                        let mut bgra = vec![0u8; (width * height * 4) as usize];
                        // libyuv's ARGB is BGRA in memory, which is what GPUI draws.
                        livekit::webrtc::native::yuv_helper::i420_to_argb(y, stride_y, u, stride_u, v, stride_v, &mut bgra, width * 4, width as i32, height as i32);
                        serial += 1;
                        show(&writing, Frame { width, height, bgra: Arc::new(bgra), serial, #[cfg(target_os = "macos")] surface: None });
                    }
                });
                self.videos.lock().insert(sid, RemoteVideo { feed, stop });
            }
        }
    }

    fn unsubscribed(&self, sid: &TrackSid) {
        if let Some(audio) = self.audio.lock().remove(sid) {
            audio.stop.store(true, Ordering::Relaxed);
            self.mixer.remove(audio.mixer_id);
        }
        if let Some(video) = self.videos.lock().remove(sid) {
            video.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Follows what the room says, until it's closed.
async fn watch(room: Arc<Room>, shared: Arc<Shared>, mut events: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>, out: UnboundedSender<Event>) {
    let send = |event: Event| {
        out.unbounded_send(event).ok();
    };
    while let Some(event) = events.recv().await {
        if shared.closed.load(Ordering::Relaxed) {
            break;
        }
        match event {
            RoomEvent::Connected { .. } | RoomEvent::Reconnected => send(Event::Status(Status::Connected)),
            RoomEvent::Reconnecting => send(Event::Status(Status::Reconnecting)),
            RoomEvent::Disconnected { reason } => {
                send(Event::Closed(Some(reason)));
                break;
            }
            RoomEvent::ParticipantConnected(participant) => {
                let identity = participant.identity().0;
                shared.install_for(&identity);
                if let Some((user, _, false)) = parse_identity(&identity) {
                    send(Event::Participants(Some(user), None));
                }
            }
            RoomEvent::ParticipantDisconnected(participant) => {
                let identity = participant.identity().0;
                for sid in participant.track_publications().keys() {
                    shared.unsubscribed(sid);
                }
                if let Some((user, _, false)) = parse_identity(&identity) {
                    send(Event::Participants(None, Some(user)));
                }
                send(Event::Media);
            }
            RoomEvent::TrackSubscribed { track, publication, participant } => {
                shared.subscribed(&room, track, publication, participant);
                send(Event::Media);
            }
            RoomEvent::TrackUnsubscribed { publication, .. } => {
                shared.unsubscribed(&publication.sid());
                send(Event::Media);
            }
            RoomEvent::TrackMuted { .. } | RoomEvent::TrackUnmuted { .. } | RoomEvent::TrackPublished { .. } | RoomEvent::TrackUnpublished { .. } | RoomEvent::LocalTrackPublished { .. } | RoomEvent::LocalTrackUnpublished { .. } => send(Event::Media),
            RoomEvent::ActiveSpeakersChanged { speakers } => {
                let users = speakers
                    .iter()
                    .filter_map(|speaker| {
                        let identity = speaker.identity().0;
                        match parse_identity(&identity) {
                            Some((user, _, false)) if identity != shared.identity => Some(user),
                            _ => None,
                        }
                    })
                    .collect();
                send(Event::Speaking(users));
            }
            RoomEvent::ConnectionQualityChanged { quality, participant } => {
                if participant.identity().0 == shared.identity {
                    send(Event::Quality(match quality {
                        ConnectionQuality::Excellent => Quality::Excellent,
                        ConnectionQuality::Good => Quality::Good,
                        ConnectionQuality::Poor => Quality::Poor,
                        ConnectionQuality::Lost => Quality::Lost,
                    }));
                }
            }
            RoomEvent::ParticipantPermissionChanged { participant, .. } => {
                if participant.identity().0 == shared.identity {
                    send(Event::Permissions);
                }
            }
            _ => {}
        }
    }
}

/// Sends 10 ms of the microphone to the room.
pub fn send_frame(source: &NativeAudioSource, samples: Vec<i16>, channels: u32) {
    let per_channel = samples.len() as u32 / channels.max(1);
    let frame = AudioFrame { data: samples.into(), sample_rate: RATE, num_channels: channels, samples_per_channel: per_channel };
    let source = source.clone();
    let _ = crate::host::tokio().block_on(async move { source.capture_frame(&frame).await });
}

#[allow(dead_code)]
const _FRAME_IS_10_MS: () = assert!(FRAME == RATE as usize / 100);
