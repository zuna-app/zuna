//! A Telegram call's sound and picture: one peer connection, made with the WebRTC the app links
//! for LiveKit and beside its rooms, never in one (docs/TELEGRAM_CALLS_PLAN.md, The media). It's
//! a pair of hands: the core says what to do with it (`telegram_call_media`), in order, and is
//! told what comes of it. It relays only, through Telegram's TURN servers at Telegram's own
//! addresses, so the other person never learns this device's, and it reads nothing the other
//! side sends but media and the data channel's text, which goes to the core.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use futures::StreamExt;
use futures::channel::mpsc::UnboundedSender;
use livekit::rtc_engine::lk_runtime::LkRuntime;
use livekit::webrtc::MediaType;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::data_channel::{DataChannel, DataChannelInit, DataChannelState};
use livekit::webrtc::ice_candidate::IceCandidate;
use livekit::webrtc::media_stream_track::MediaStreamTrack;
use livekit::webrtc::peer_connection::{OfferOptions, PeerConnection, PeerConnectionState};
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt as _;
use livekit::webrtc::peer_connection_factory::{ContinualGatheringPolicy, IceServer, IceTransportsType, RtcConfiguration};
use livekit::webrtc::prelude::{I420Buffer, VideoBuffer, VideoFrame, VideoResolution, VideoRotation};
use livekit::webrtc::rtp_transceiver::{RtpTransceiver, RtpTransceiverDirection, RtpTransceiverInit};
use livekit::webrtc::session_description::{SdpType, SessionDescription};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::host::Core;
use crate::voice::audio::{Mixer, RATE};
use crate::voice::room::{Feed, Frame, show, upright};

/// What the peer connection says, for the voice store.
#[derive(Debug)]
pub enum MediaEvent {
    /// What's being sent and shown changed.
    Media,
}

/// Something the other side sends, playing or being shown.
struct Remote {
    mixer_id: Option<u64>,
    feed: Option<Feed>,
    task: tokio::task::AbortHandle,
}

impl Drop for Remote {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// This device's camera, going out on its own transceiver, and how it looks here.
struct Camera {
    _capture: crate::media::record::Camera,
    feed: Feed,
}

struct Shared {
    core: Core,
    id: i64,
    mixer: Mixer,
    /// How loud the other person is here.
    volume: Mutex<f32>,
    remotes: Mutex<HashMap<String, Remote>>,
    /// What each section the other side sends is, by MID, as its answer said.
    tracks: Mutex<HashMap<String, String>>,
    data: Mutex<Option<DataChannel>>,
    closed: AtomicBool,
    events: UnboundedSender<MediaEvent>,
    /// When the other person was last heard above a whisper, in ms since `started`.
    loud: AtomicU64,
    started: Instant,
}

impl Shared {
    fn tell(&self, method: &str, args: Vec<Value>) -> impl Future<Output = Result<Value, crate::host::CoreError>> + use<> {
        let mut all = vec![json!(self.id)];
        all.extend(args);
        self.core.call(Some(crate::telegram::SERVER_ID), method, all)
    }

    fn tell_and_forget(&self, method: &str, args: Vec<Value>) {
        let call = self.tell(method, args);
        crate::host::tokio().spawn(async move {
            call.await.ok();
        });
    }

    /// Something the other side sends has come: its sound into the mixer, its picture into a feed.
    fn arrived(self: &Arc<Self>, mid: String, track: MediaStreamTrack) {
        if self.closed.load(Ordering::Relaxed) || self.remotes.lock().contains_key(&mid) {
            return;
        }
        let remote = match track {
            MediaStreamTrack::Audio(audio) => {
                let mixer_id = self.mixer.live(*self.volume.lock());
                let mut stream = NativeAudioStream::new(audio, RATE as i32, 1);
                let shared = self.clone();
                let task = crate::host::tokio().spawn(async move {
                    while let Some(frame) = stream.next().await {
                        // Speaking, for how they're drawn: a little over the noise of a quiet room.
                        if frame.data.iter().any(|sample| sample.unsigned_abs() > 1200) {
                            shared.loud.store(shared.started.elapsed().as_millis() as u64, Ordering::Relaxed);
                        }
                        shared.mixer.push(mixer_id, &frame.data, frame.num_channels);
                    }
                });
                Remote { mixer_id: Some(mixer_id), feed: None, task: task.abort_handle() }
            }
            MediaStreamTrack::Video(video) => {
                let feed: Feed = Arc::new(Mutex::new(None));
                let writing = feed.clone();
                let mut stream = NativeVideoStream::new(video);
                let task = crate::host::tokio().spawn(async move {
                    let mut serial = 0u64;
                    while let Some(frame) = stream.next().await {
                        let copied;
                        let i420 = match frame.buffer.as_i420() {
                            Some(i420) => i420,
                            None => {
                                copied = frame.buffer.to_i420();
                                &copied
                            }
                        };
                        let (width, height) = (i420.width(), i420.height());
                        let (stride_y, stride_u, stride_v) = i420.strides();
                        let (y, u, v) = i420.data();
                        let mut bgra = vec![0u8; (width * height * 4) as usize];
                        livekit::webrtc::native::yuv_helper::i420_to_argb(y, stride_y, u, stride_u, v, stride_v, &mut bgra, width * 4, width as i32, height as i32);
                        // A phone turned on its side sends its picture turned, and says by how much.
                        let (width, height, bgra) = upright(width, height, bgra, frame.rotation);
                        serial += 1;
                        show(&writing, Frame::of(width, height, bgra, serial));
                    }
                });
                Remote { mixer_id: None, feed: Some(feed), task: task.abort_handle() }
            }
        };
        let mut remotes = self.remotes.lock();
        if self.closed.load(Ordering::Relaxed) {
            if let Some(mixer_id) = remote.mixer_id {
                self.mixer.remove(mixer_id);
            }
            return;
        }
        remotes.insert(mid, remote);
        drop(remotes);
        self.events.unbounded_send(MediaEvent::Media).ok();
    }
}

/// One Telegram call's peer connection.
pub struct TelegramMedia {
    pc: PeerConnection,
    /// The relays on this device it reaches Telegram's through, with a proxy set.
    proxied: Option<Arc<crate::voice::proxy::Relays>>,
    _runtime: Arc<LkRuntime>,
    shared: Arc<Shared>,
    /// What the core says to do, done one after the other.
    commands: tokio::sync::mpsc::UnboundedSender<Value>,
    camera: Mutex<Option<Camera>>,
    /// The camera's transceiver, made the first time it's turned on, and its source.
    camera_out: Mutex<Option<(RtpTransceiver, NativeVideoSource)>>,
}

/// Turns a relay Telegram named into one WebRTC may use: only TURN, only over UDP, only at one of
/// Telegram's addresses, whatever port it gave.
pub fn relays(servers: &Value) -> Vec<IceServer> {
    let mut out = Vec::new();
    for server in servers.as_array().into_iter().flatten().take(16) {
        let text = |name: &str| server.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        let urls: Vec<String> = server
            .get("urls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|url| relay_address(url).is_some_and(allowed_relay))
            .map(str::to_string)
            .collect();
        let (username, password) = (text("username"), text("password"));
        if !urls.is_empty() && !username.is_empty() && !password.is_empty() {
            out.push(IceServer { urls, username, password });
        }
    }
    out
}

/// The relays as WebRTC is to reach them through the device's proxy: each one a port on this
/// device that carries what's sent to it through the proxy to that relay, in a UDP association
/// (voice/proxy.rs). WebRTC is told the port on loopback alone.
pub fn through(proxy: &Arc<crate::voice::proxy::Relays>, servers: Vec<IceServer>) -> Vec<IceServer> {
    servers
        .into_iter()
        .filter_map(|server| {
            let urls: Vec<String> = server
                .urls
                .iter()
                .filter_map(|url| {
                    let ip = relay_address(url)?;
                    let port: u16 = url.strip_suffix("?transport=udp")?.rsplit_once(':')?.1.parse().ok()?;
                    let local = proxy.relay_for("udp", &ip.to_string(), port)?;
                    Some(format!("turn:{local}?transport=udp"))
                })
                .collect();
            (!urls.is_empty()).then_some(IceServer { urls, ..server })
        })
        .collect()
}

/// The address of a `turn:` URL written out as the core writes it: `turn:1.2.3.4:3478?transport=udp`, or `turn:[2001:db8::1]:3478?transport=udp`.
fn relay_address(url: &str) -> Option<IpAddr> {
    let rest = url.strip_prefix("turn:")?.strip_suffix("?transport=udp")?;
    let host = if let Some(bracketed) = rest.strip_prefix('[') { bracketed.split(']').next()? } else { rest.rsplit_once(':')?.0 };
    let port: u16 = rest.rsplit_once(':')?.1.parse().ok()?;
    (port > 0).then_some(())?;
    host.parse().ok()
}

/// Telegram's addresses, and with the test control a relay of the check's own on this machine.
fn allowed_relay(ip: IpAddr) -> bool {
    crate::telegram::is_telegrams(ip) || (cfg!(feature = "test-control") && ip.is_loopback())
}

/// A call's peer connection, as the core expects it: relaying only, through these servers; the
/// microphone's source going out on a transceiver that only sends, the other side's sound and
/// picture coming on their own; and the data channel, `data`, on stream 0, which the caller
/// opens and the one called has ready, so that the section for it is in its offers too.
pub(crate) fn connection(runtime: &LkRuntime, servers: Vec<IceServer>, caller: bool, source: NativeAudioSource) -> Result<(PeerConnection, DataChannel), String> {
    let mut config = RtcConfiguration::default();
    config.ice_servers = servers;
    config.ice_transport_type = IceTransportsType::Relay;
    config.continual_gathering_policy = ContinualGatheringPolicy::GatherContinually;
    let factory = runtime.pc_factory();
    let pc = factory.create_peer_connection(config).map_err(|error| error.to_string())?;
    let track = factory.create_audio_track("microphone", source);
    pc.add_transceiver(MediaStreamTrack::Audio(track), RtpTransceiverInit { direction: RtpTransceiverDirection::SendOnly, stream_ids: vec!["zuna".into()], send_encodings: Vec::new() }).map_err(|error| error.to_string())?;
    let init = DataChannelInit { ordered: true, negotiated: !caller, id: 0, ..Default::default() };
    let channel = pc.create_data_channel("data", init).map_err(|error| error.to_string())?;
    Ok((pc, channel))
}

/// How an offer is made. Left false, as the crate's default has it, libwebrtc's old options take
/// the receiving direction off every transceiver, so a section that only takes would offer to be
/// quiet, and one that sends would never take.
pub(crate) fn offering() -> OfferOptions {
    OfferOptions { ice_restart: false, offer_to_receive_audio: true, offer_to_receive_video: true }
}

/// Adds transceivers that only take the other side's streams, until there are as many of each kind as asked.
pub(crate) fn receive(pc: &PeerConnection, audio: usize, video: usize) -> Result<(), String> {
    for (kind, media_type, wanted) in [("audio", MediaType::Audio, audio), ("video", MediaType::Video, video)] {
        let have = pc.transceivers().iter().filter(|transceiver| transceiver.direction() == RtpTransceiverDirection::RecvOnly && kind_of(transceiver) == kind).count();
        for _ in have..wanted.min(4) {
            pc.add_transceiver_for_media(media_type, RtpTransceiverInit { direction: RtpTransceiverDirection::RecvOnly, stream_ids: Vec::new(), send_encodings: Vec::new() }).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn kind_of(transceiver: &RtpTransceiver) -> &'static str {
    match transceiver.receiver().track() {
        Some(MediaStreamTrack::Audio(_)) => "audio",
        Some(MediaStreamTrack::Video(_)) => "video",
        None => "",
    }
}

impl TelegramMedia {
    /// Makes the call's peer connection, through these relays alone, with the microphone's source
    /// going out on it. Says why it can't, or what it says comes on `events`.
    #[allow(clippy::too_many_arguments)]
    pub fn open(core: Core, id: i64, servers: Vec<IceServer>, proxied: Option<Arc<crate::voice::proxy::Relays>>, caller: bool, mic: Option<NativeAudioSource>, mixer: Mixer, volume: f32, events: UnboundedSender<MediaEvent>) -> Result<Arc<TelegramMedia>, String> {
        let _runtime_guard = crate::host::tokio().enter();
        let runtime = LkRuntime::instance();
        let source = mic.unwrap_or_else(crate::voice::room::VoiceRoom::microphone_source);
        let (pc, channel) = connection(&runtime, servers, caller, source.clone())?;
        let shared = Arc::new(Shared {
            core,
            id,
            mixer,
            volume: Mutex::new(volume),
            remotes: Mutex::new(HashMap::new()),
            tracks: Mutex::new(HashMap::new()),
            data: Mutex::new(None),
            closed: AtomicBool::new(false),
            events,
            loud: AtomicU64::new(0),
            started: Instant::now(),
        });
        Self::watch_channel(&shared, &channel);
        *shared.data.lock() = Some(channel);

        let candidates = shared.clone();
        pc.on_ice_candidate(Some(Box::new(move |candidate: IceCandidate| {
            // The core sends only a relay's, but the line goes to it whole.
            candidates.tell_and_forget("callCandidate", vec![json!(candidate.candidate())]);
        })));
        let states = shared.clone();
        pc.on_connection_state_change(Some(Box::new(move |state: PeerConnectionState| {
            let word = match state {
                PeerConnectionState::Connected => "connected",
                PeerConnectionState::Disconnected => "disconnected",
                PeerConnectionState::Failed => "failed",
                _ => return,
            };
            if !states.closed.load(Ordering::Relaxed) {
                states.tell_and_forget("callConnection", vec![json!(word)]);
            }
        })));
        let arriving = shared.clone();
        pc.on_track(Some(Box::new(move |event| {
            let Some(mid) = event.transceiver.mid() else { return };
            // Only what the answer said the other side sends there.
            if !arriving.tracks.lock().contains_key(&mid) {
                return;
            }
            arriving.arrived(mid, event.track);
        })));
        let channels = shared.clone();
        pc.on_data_channel(Some(Box::new(move |channel: DataChannel| {
            if channel.label() != "data" {
                return;
            }
            Self::watch_channel(&channels, &channel);
            *channels.data.lock() = Some(channel);
        })));

        let (commands, mut queue) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let media = Arc::new(TelegramMedia { pc, proxied, _runtime: runtime, shared, commands, camera: Mutex::new(None), camera_out: Mutex::new(None) });
        let doing = Arc::downgrade(&media);
        crate::host::tokio().spawn(async move {
            while let Some(command) = queue.recv().await {
                let Some(media) = doing.upgrade() else { break };
                if media.shared.closed.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(problem) = media.run(&command).await {
                    log::warn!("telegram call: {} failed: {problem}", command.get("do").and_then(Value::as_str).unwrap_or("?"));
                }
            }
        });
        Ok(media)
    }

    fn watch_channel(shared: &Arc<Shared>, channel: &DataChannel) {
        let opened = shared.clone();
        channel.on_state_change(Some(Box::new(move |state| {
            if state == DataChannelState::Open && !opened.closed.load(Ordering::Relaxed) {
                opened.tell_and_forget("callConnection", vec![json!("data")]);
            }
        })));
        let heard = shared.clone();
        channel.on_message(Some(Box::new(move |buffer| {
            if buffer.data.len() <= 16_384 {
                heard.tell_and_forget("callHeard", vec![json!(String::from_utf8_lossy(buffer.data))]);
            }
        })));
    }

    /// One thing the core said to do, which is done before the next.
    pub fn command(&self, media: Value) {
        self.commands.send(media).ok();
    }

    async fn run(&self, command: &Value) -> Result<(), String> {
        match command.get("do").and_then(Value::as_str).unwrap_or_default() {
            "offer" => {
                let wanted = |kind: &str| command.pointer(&format!("/receive/{kind}")).and_then(Value::as_u64).unwrap_or(1) as usize;
                receive(&self.pc, wanted("audio"), wanted("video"))?;
                let offer = self.pc.create_offer(offering()).await.map_err(|error| error.to_string())?;
                let prepared = self.shared.tell("callOffer", vec![json!(offer.to_string())]).await.map_err(|error| error.message)?;
                let prepared = prepared.as_str().ok_or("the core gave no offer")?;
                let description = SessionDescription::parse(prepared, SdpType::Offer).map_err(|error| error.to_string())?;
                self.pc.set_local_description(description).await.map_err(|error| error.to_string())?;
            }
            "answer" => {
                let sdp = command.get("sdp").and_then(Value::as_str).unwrap_or_default();
                if let Some(tracks) = command.get("tracks").and_then(Value::as_object) {
                    let mut known = self.shared.tracks.lock();
                    for (mid, kind) in tracks {
                        known.insert(mid.clone(), kind.as_str().unwrap_or_default().to_string());
                    }
                }
                let description = SessionDescription::parse(sdp, SdpType::Answer).map_err(|error| error.to_string())?;
                self.pc.set_remote_description(description).await.map_err(|error| error.to_string())?;
                // What the other side sends where nothing was before: a track that came before the
                // answer said what it was is taken up now.
                for transceiver in self.pc.transceivers() {
                    let Some(mid) = transceiver.mid() else { continue };
                    if !self.shared.tracks.lock().contains_key(&mid) || transceiver.direction() != RtpTransceiverDirection::RecvOnly {
                        continue;
                    }
                    if let Some(track) = transceiver.receiver().track() {
                        self.shared.arrived(mid, track);
                    }
                }
            }
            "candidate" => {
                let text = |name: &str| command.get(name).and_then(Value::as_str).unwrap_or_default();
                let index = command.get("index").and_then(Value::as_i64).unwrap_or(0) as i32;
                let candidate = IceCandidate::parse(text("mid"), index, text("candidate")).map_err(|error| error.to_string())?;
                self.pc.add_ice_candidate(candidate).await.map_err(|error| error.to_string())?;
            }
            "send" => {
                let text = command.get("text").and_then(Value::as_str).unwrap_or_default();
                let channel = self.shared.data.lock().clone();
                if let Some(channel) = channel {
                    channel.send(text.as_bytes(), false).map_err(|error| format!("{error:?}"))?;
                }
            }
            "close" => self.close(),
            _ => {}
        }
        Ok(())
    }

    /// How loud the other person comes out here, which covers being deafened.
    pub fn set_volume(&self, volume: f32) {
        *self.shared.volume.lock() = volume;
        for remote in self.shared.remotes.lock().values() {
            if let Some(mixer_id) = remote.mixer_id {
                self.shared.mixer.set_volume(mixer_id, volume);
            }
        }
    }

    /// Whether the other person is speaking right now.
    pub fn speaking(&self) -> bool {
        let loud = self.shared.loud.load(Ordering::Relaxed);
        loud > 0 && (self.shared.started.elapsed().as_millis() as u64).saturating_sub(loud) < 400
    }

    /// The other side's picture, and this device's camera, as the stage shows them: (`local`, feed).
    pub fn videos(&self) -> Vec<(bool, Feed)> {
        let mut out = Vec::new();
        if let Some(camera) = self.camera.lock().as_ref() {
            out.push((true, camera.feed.clone()));
        }
        for remote in self.shared.remotes.lock().values() {
            if let Some(feed) = &remote.feed {
                out.push((false, feed.clone()));
            }
        }
        out
    }

    /// Turns the camera on or off. On the first time, it's a stream the other side hasn't been
    /// offered yet, which the core offers once it hears of it. Off, it stops sending pictures and
    /// the other side is told, as Telegram's apps do, rather than the stream going.
    pub fn set_camera(&self, on: bool, device: &str) -> Result<(), String> {
        let _runtime_guard = crate::host::tokio().enter();
        if !on {
            self.camera.lock().take();
            return Ok(());
        }
        if self.camera.lock().is_some() {
            return Ok(());
        }
        let mut out = self.camera_out.lock();
        if out.is_none() {
            let source = NativeVideoSource::new(VideoResolution { width: 1280, height: 720 }, false);
            let track = self._runtime.pc_factory().create_video_track("camera", source.clone());
            let transceiver = self
                .pc
                .add_transceiver(MediaStreamTrack::Video(track), RtpTransceiverInit { direction: RtpTransceiverDirection::SendOnly, stream_ids: vec!["zuna".into()], send_encodings: Vec::new() })
                .map_err(|_| crate::i18n::t("voice.camera.none").to_string())?;
            *out = Some((transceiver, source));
        }
        let source = out.as_ref().map(|(_, source)| source.clone()).expect("made above");
        drop(out);
        let feed: Feed = Arc::new(Mutex::new(None));
        let preview = feed.clone();
        let serial = AtomicU64::new(0);
        let capture = crate::media::record::Camera::start_feed(device, 720, move |width, height, mut bgra| {
            let mut buffer = I420Buffer::new(width, height);
            let (stride_y, stride_u, stride_v) = buffer.strides();
            let (y, u, v) = buffer.data_mut();
            livekit::webrtc::native::yuv_helper::argb_to_i420(&bgra, width * 4, y, stride_y, u, stride_u, v, stride_v, width as i32, height as i32);
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_micros() as i64).unwrap_or(0);
            source.capture_frame(&VideoFrame { rotation: VideoRotation::VideoRotation0, timestamp_us: at, frame_metadata: None, buffer });
            crate::media::mirror(&mut bgra, width as usize);
            show(&preview, Frame::of(width, height, bgra, serial.fetch_add(1, Ordering::Relaxed) + 1));
        })?;
        *self.camera.lock() = Some(Camera { _capture: capture, feed });
        Ok(())
    }

    /// Closes everything of the call's: the connection, what it was playing and showing.
    pub fn close(&self) {
        if self.shared.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        self.camera.lock().take();
        for (_, remote) in self.shared.remotes.lock().drain() {
            if let Some(mixer_id) = remote.mixer_id {
                self.shared.mixer.remove(mixer_id);
            }
        }
        if let Some(channel) = self.shared.data.lock().take() {
            channel.close();
        }
        self.pc.close();
        if let Some(relays) = &self.proxied {
            crate::voice::proxy::finish(relays);
        }
    }
}

impl Drop for TelegramMedia {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests;
