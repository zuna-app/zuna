//! Captures a screen, encodes it on the GPU and publishes it through LiveKit, end to
//! end encrypted. The app runs this with --control and gives it what it needs on its
//! standard input, one line of JSON at a time. See docs/SCREEN_SHARE.md.

mod capture;
mod cpu;
mod encoder;
mod h264;
#[cfg(windows)]
mod notification_state;
mod pipeline;
#[cfg(target_os = "linux")]
mod shortcut;
#[cfg(any(target_os = "linux", windows))]
mod sound;

use std::{
    fs::File,
    io::{BufRead, BufWriter},
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use capture::{Capture, Options, Source};
use encoder::{Quality, Result, Stream};
use pipeline::{Pipeline, Sink};

#[derive(Debug)]
struct Args {
    capture: Options,
    url: String,
    api_key: String,
    api_secret: String,
    room: String,
    identity: String,
    e2ee_key: Option<String>,
    bitrate_kbps: u64,
    quality: Quality,
    keyframe_seconds: u32,
    seconds: Option<u64>,
    fix_idr: bool,
    output: Option<String>,
    output_raw: Option<String>,
    list_monitors: bool,
    check_dmabuf: bool,
    portal_sources: bool,
    global_shortcuts: bool,
    push_to_talk: Option<String>,
    control: bool,
    sound: bool,
    sound_from: Option<String>,
    sound_apps: bool,
    window_app: Option<u64>,
    exclude_pid: Option<u32>,
}

/// What the app gives this program when it runs it, rather than on the command line,
/// where anything else on the computer could read it.
struct Access {
    url: String,
    token: String,
    key: Vec<u8>,
    key_index: i32,
}

fn parse_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok()).collect()
}

fn read_key(message: &serde_json::Value) -> Option<(Vec<u8>, i32)> {
    Some((parse_hex(message["key"].as_str()?)?, i32::try_from(message["key_index"].as_i64()?).ok()?))
}

/// The first line from the app, which says where to publish and under what key.
fn read_access() -> std::result::Result<Access, String> {
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).map_err(|error| format!("Reading what to do: {error}"))?;
    let message: serde_json::Value = serde_json::from_str(&line).map_err(|error| format!("Reading what to do: {error}"))?;
    let (key, key_index) = read_key(&message).ok_or("It came without a key")?;
    Ok(Access {
        url: message["url"].as_str().ok_or("It came without an address")?.to_owned(),
        token: message["token"].as_str().ok_or("It came without a token")?.to_owned(),
        key,
        key_index,
    })
}

const USAGE: &str = "zuna-screenshare [options]

  --url URL              LiveKit server (ws://127.0.0.1:7880)
  --api-key KEY          LiveKit API key (devkey)
  --api-secret SECRET    LiveKit API secret (secret)
  --room NAME            Room to join (zuna-demo)
  --identity NAME        Who to publish as (sharer)
  --e2ee-key KEY         Encrypt with this shared key, as MLS would provide it
  --bitrate-kbps N       The most to send (20000)
  --fps N                Frame rate (60)
  --encoder NAME         auto, h264_nvenc, h264_amf or h264_vaapi (auto)
  --quality NAME         How much work each frame gets: speed, balanced or best (balanced)
  --max-height N         Make the picture smaller on the GPU if it's taller than this
  --no-cursor            Leave the pointer out of the picture
  --monitor N            Which monitor (0). Linux asks through the portal instead.
  --source KIND          Linux: what the portal offers, screen, window or any (any)
  --monitor-at X,Y       The monitor at this point on the desktop
  --crop WxH             Encode this much from the top left of the monitor
  --cpu-input            Give the encoder frames from CPU memory
  --render-node PATH     VA-API's device (/dev/dri/renderD128)
  --keyframe-seconds N   Seconds between regular keyframes (10)
  --seconds N            Stop after this long
  --no-idr-fix           Leave out the fix for keyframes under encryption
  --output FILE          Write H.264 to a file instead of publishing
  --output-raw FILE      Also write the encoder's output, unchanged
  --list-monitors        List monitors and exit
  --check-dmabuf         Linux: check that DMA-BUFs reach NVENC, without capturing
  --portal-sources       Linux: say whether the portal shares screens and windows, as JSON, and exit
  --global-shortcuts     Linux: say which version of the global shortcuts portal there is, 0 for none, and exit
  --push-to-talk KEY     Linux: bind KEY through the global shortcuts portal and say when it goes down and up,
                         as JSON lines, until standard input closes. An empty KEY lets the person choose
  --control              Take the address, token and keys from standard input, as JSON lines
  --sound                Write the computer's sound to standard output instead of sharing
  --sound-from ID        Only one app's sound, by its id from --sound-apps or --window-app
  --sound-apps           List the apps playing sound, as JSON, and exit
  --window-app ID        Say which app a window belongs to, by its X11 id or HWND, as JSON, and exit
  --exclude-pid N        Leave out the sound of this process and those it started
  --notification-state   Windows: say whether it wants quiet right now, and exit";

fn parse_args() -> std::result::Result<Args, String> {
    let mut args = Args {
        capture: Options { encoder: "auto".into(), fps: 60, cursor: true, render_node: "/dev/dri/renderD128".into(), ..Options::default() },
        url: "ws://127.0.0.1:7880".into(),
        api_key: "devkey".into(),
        api_secret: "secret".into(),
        room: "zuna-demo".into(),
        identity: "sharer".into(),
        e2ee_key: None,
        bitrate_kbps: 20_000,
        quality: Quality::default(),
        keyframe_seconds: 10,
        seconds: None,
        fix_idr: true,
        output: None,
        output_raw: None,
        list_monitors: false,
        check_dmabuf: false,
        portal_sources: false,
        global_shortcuts: false,
        push_to_talk: None,
        control: false,
        sound: false,
        sound_from: None,
        sound_apps: false,
        window_app: None,
        exclude_pid: None,
    };
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        let mut value = || raw.next().ok_or_else(|| format!("{flag} needs a value"));
        let number_error = |error: std::num::ParseIntError| format!("{flag}: {error}");
        match flag.as_str() {
            "--url" => args.url = value()?,
            "--api-key" => args.api_key = value()?,
            "--api-secret" => args.api_secret = value()?,
            "--room" => args.room = value()?,
            "--identity" => args.identity = value()?,
            "--e2ee-key" => args.e2ee_key = Some(value()?),
            "--bitrate-kbps" => args.bitrate_kbps = value()?.parse().map_err(number_error)?,
            "--fps" => args.capture.fps = value()?.parse().map_err(number_error)?,
            "--encoder" => args.capture.encoder = value()?,
            "--quality" => {
                args.quality = match value()?.as_str() {
                    "speed" => Quality::Speed,
                    "balanced" => Quality::Balanced,
                    "best" => Quality::Best,
                    other => return Err(format!("--quality takes speed, balanced or best, not {other}")),
                }
            }
            "--max-height" => args.capture.max_height = Some(value()?.parse().map_err(number_error)?),
            "--no-cursor" => args.capture.cursor = false,
            "--monitor" => args.capture.monitor = value()?.parse().map_err(number_error)?,
            "--source" => {
                args.capture.source = match value()?.as_str() {
                    "any" => Source::Any,
                    "screen" => Source::Screen,
                    "window" => Source::Window,
                    other => return Err(format!("--source takes screen, window or any, not {other}")),
                }
            }
            "--monitor-at" => {
                let text = value()?;
                let (x, y) = text.split_once(',').ok_or("--monitor-at takes X,Y")?;
                args.capture.monitor_at = Some((x.parse().map_err(number_error)?, y.parse().map_err(number_error)?));
            }
            "--crop" => {
                let text = value()?;
                let (width, height) = text.split_once('x').ok_or("--crop takes WxH")?;
                args.capture.crop = Some((width.parse().map_err(number_error)?, height.parse().map_err(number_error)?));
            }
            "--cpu-input" => args.capture.cpu_input = true,
            "--render-node" => args.capture.render_node = value()?,
            "--keyframe-seconds" => args.keyframe_seconds = value()?.parse().map_err(number_error)?,
            "--seconds" => args.seconds = Some(value()?.parse().map_err(number_error)?),
            "--no-idr-fix" => args.fix_idr = false,
            "--output" => args.output = Some(value()?),
            "--output-raw" => args.output_raw = Some(value()?),
            "--list-monitors" => args.list_monitors = true,
            "--check-dmabuf" => args.check_dmabuf = true,
            "--portal-sources" => args.portal_sources = true,
            "--global-shortcuts" => args.global_shortcuts = true,
            "--push-to-talk" => args.push_to_talk = Some(value()?),
            "--control" => args.control = true,
            "--sound" => args.sound = true,
            "--sound-from" => {
                args.sound = true;
                args.sound_from = Some(value()?);
            }
            "--sound-apps" => args.sound_apps = true,
            "--window-app" => args.window_app = Some(value()?.parse().map_err(number_error)?),
            "--exclude-pid" => args.exclude_pid = Some(value()?.parse().map_err(number_error)?),
            "--help" | "-h" => return Err(USAGE.into()),
            other => return Err(format!("Unknown option {other}\n\n{USAGE}")),
        }
    }
    Ok(args)
}

#[cfg(feature = "livekit")]
mod publish {
    use livekit::{
        e2ee::{
            key_provider::{KeyDerivationAlgorithm, KeyProvider, KeyProviderOptions},
            manager::E2eeManager,
            E2eeOptions, EncryptionType,
        },
        id::ParticipantIdentity,
        options::{TrackPublishOptions, VideoCodec, VideoEncoding},
        track::{LocalTrack, LocalVideoTrack, TrackSource},
        webrtc::{
            rtp_sender::VideoEncoderBackend,
            video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
        },
        Room, RoomEvent, RoomOptions,
    };
    use livekit_api::access_token::{AccessToken, VideoGrants};

    use super::{Access, Args, Result};

    /// HKDF, because a key from the MLS exporter is already random and has no need
    /// of the password stretching that's the default here.
    fn key_options() -> KeyProviderOptions {
        // As in the apps: a key that doesn't open a frame is no reason to give up on it.
        KeyProviderOptions { key_derivation_algorithm: KeyDerivationAlgorithm::HKDF, ratchet_window_size: 0, ..Default::default() }
    }

    /// Changing what this program's frames go under, when the group's epoch moves on.
    #[derive(Clone)]
    pub struct Keys {
        identity: ParticipantIdentity,
        provider: KeyProvider,
        manager: E2eeManager,
    }

    impl Keys {
        pub fn set(&self, key: Vec<u8>, index: i32) {
            self.provider.set_key(&self.identity, index, key);
            for cryptor in self.manager.frame_cryptors().values() {
                cryptor.set_key_index(index);
            }
        }
    }

    pub async fn start(args: &Args, access: Option<&Access>, width: u32, height: u32) -> Result<(Room, NativeVideoSource, Option<Keys>)> {
        let mut token = String::new();
        if access.is_none() {
            token = AccessToken::with_api_key(&args.api_key, &args.api_secret)
                .with_identity(&args.identity)
                .with_grants(VideoGrants {
                    room_join: true,
                    room: args.room.clone(),
                    can_publish: Some(true),
                    can_subscribe: Some(false),
                    ..Default::default()
                })
                .to_jwt()
                .map_err(|error| format!("Making a token: {error}"))?;
        }

        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        // From the app, each sender has a key of its own. By hand, everyone shares one.
        let provider = access.map(|_| KeyProvider::new(key_options()));
        options.encryption = match (&provider, &args.e2ee_key) {
            (Some(provider), _) => Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider: provider.clone() }),
            (None, Some(key)) => Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider: KeyProvider::with_shared_key(key_options(), key.clone().into_bytes()) }),
            (None, None) => None,
        };

        let (url, token) = match access {
            Some(access) => (access.url.as_str(), access.token.as_str()),
            None => (args.url.as_str(), token.as_str()),
        };
        let (room, mut events) = Room::connect(url, token, options).await.map_err(|error| format!("Joining the room: {error}"))?;
        if args.e2ee_key.is_some() || access.is_some() {
            room.e2ee_manager().set_enabled(true);
        }
        let keys = provider.map(|provider| Keys { identity: room.local_participant().identity(), provider, manager: room.e2ee_manager().clone() });
        if let (Some(keys), Some(access)) = (&keys, access) {
            keys.provider.set_key(&keys.identity, access.key_index, access.key.clone());
        }
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if let RoomEvent::Disconnected { reason } = event {
                    log::warn!("Disconnected from the room: {reason:?}");
                }
            }
        });

        let source = NativeVideoSource::new_encoded(VideoResolution { width, height });
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
        let publish_options = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: VideoCodec::H264,
            video_encoder: VideoEncoderBackend::PreEncoded,
            simulcast: false,
            video_encoding: Some(VideoEncoding { max_bitrate: args.bitrate_kbps * 1000, max_framerate: args.capture.fps as f64 }),
            ..Default::default()
        };
        room.local_participant()
            .publish_track(LocalTrack::Video(track), publish_options)
            .await
            .map_err(|error| format!("Publishing the track: {error}"))?;
        // The frame cryptor comes with publishing, and starts at the first key otherwise.
        if let (Some(keys), Some(access)) = (&keys, access) {
            keys.set(access.key.clone(), access.key_index);
        }
        Ok((room, source, keys))
    }
}

/// Takes what the app says from here on: a new key, or to stop. Its going away counts as that too.
#[cfg(feature = "livekit")]
fn follow_control(keys: Option<publish::Keys>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match message["type"].as_str() {
                Some("key") => {
                    if let (Some(keys), Some((key, index))) = (&keys, read_key(&message)) {
                        keys.set(key, index);
                    }
                }
                Some("stop") => break,
                _ => {}
            }
        }
        stop.store(true, Ordering::Relaxed);
    });
}

fn run(args: Args) -> Result<()> {
    if let Some(window) = args.window_app {
        return sound::window_app(window, args.exclude_pid);
    }
    if args.sound_apps {
        return sound::list(args.exclude_pid);
    }
    if args.sound {
        return sound::capture(sound::Wanted::from_arg(args.sound_from), args.exclude_pid);
    }
    if args.list_monitors {
        capture::list_monitors();
        return Ok(());
    }
    if args.check_dmabuf {
        #[cfg(target_os = "linux")]
        return encoder::check_dmabuf(&args.capture.render_node).map(|report| print!("{report}"));
        #[cfg(not(target_os = "linux"))]
        return Err("--check-dmabuf is for Linux".into());
    }

    let runtime = tokio::runtime::Runtime::new().map_err(|error| format!("Starting the runtime: {error}"))?;
    let _entered = runtime.enter();
    if args.portal_sources {
        #[cfg(target_os = "linux")]
        return capture::portal_sources(&runtime);
        #[cfg(not(target_os = "linux"))]
        return Err("--portal-sources is for Linux".into());
    }
    if args.global_shortcuts {
        #[cfg(target_os = "linux")]
        return shortcut::check(&runtime);
        #[cfg(not(target_os = "linux"))]
        return Err("--global-shortcuts is for Linux".into());
    }
    if let Some(_trigger) = &args.push_to_talk {
        #[cfg(target_os = "linux")]
        return shortcut::watch(&runtime, _trigger);
        #[cfg(not(target_os = "linux"))]
        return Err("--push-to-talk is for Linux".into());
    }
    #[cfg(windows)]
    if args.capture.source == Source::Window {
        return Err("Sharing a window natively is only built for Linux".into());
    }

    let access = if args.control { Some(read_access()?) } else { None };

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        runtime.spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            stop.store(true, Ordering::Relaxed);
        });
    }

    let mut capture = Capture::open(&args.capture, &runtime)?;
    // Counted from here, as on Linux the portal's dialog waits for as long as the person takes.
    if let Some(seconds) = args.seconds {
        let stop = stop.clone();
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            stop.store(true, Ordering::Relaxed);
        });
    }
    let (width, height) = capture::fitted(capture.size(), args.capture.max_height);
    let bitrate_cap = args.bitrate_kbps * 1000;
    let publishing = args.output.is_none();
    let bitrate = pipeline::starting_bitrate(bitrate_cap, publishing);
    let gop = args.capture.fps * args.keyframe_seconds;
    let encoder = capture.open_encoder(Stream { width, height, fps: args.capture.fps, gop, bitrate, quality: args.quality })?;

    #[cfg(feature = "livekit")]
    let mut room = None;
    let sink = match &args.output {
        Some(path) => Sink::File {
            prepared: BufWriter::new(File::create(path).map_err(|error| format!("{path}: {error}"))?),
            raw: match &args.output_raw {
                Some(path) => Some(BufWriter::new(File::create(path).map_err(|error| format!("{path}: {error}"))?)),
                None => None,
            },
        },
        #[cfg(feature = "livekit")]
        None => {
            let (joined, source, keys) = runtime.block_on(publish::start(&args, access.as_ref(), width, height))?;
            room = Some(joined);
            if args.control {
                follow_control(keys, stop.clone());
            }
            Sink::LiveKit(source)
        }
        #[cfg(not(feature = "livekit"))]
        None => return Err("Built without LiveKit, so this needs --output".into()),
    };

    // Linux's portal says whether a screen or a window was chosen.
    #[cfg(target_os = "linux")]
    let source = capture.source;
    #[cfg(windows)]
    let source = "screen";
    println!(
        "{{\"type\":\"ready\",\"description\":{:?},\"source\":{source:?},\"width\":{width},\"height\":{height},\"fps\":{},\"e2ee\":{},\"idrFix\":{}}}",
        capture.description,
        args.capture.fps,
        args.e2ee_key.is_some() || access.is_some(),
        args.fix_idr,
    );

    let mut pipeline = Pipeline::new(encoder, sink, width, height, args.capture.fps, bitrate, bitrate_cap, args.fix_idr);
    log::info!("encoding with {}", pipeline.encoder_name());
    let result = capture.run(&mut pipeline, &stop);
    pipeline.finish();

    #[cfg(feature = "livekit")]
    if let Some(room) = room {
        let _ = runtime.block_on(room.close());
    }
    result
}

fn main() -> ExitCode {
    // Nothing to do with sharing, but this is the program on the computer that can ask.
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--notification-state") {
        notification_state::print();
        return ExitCode::SUCCESS;
    }

    // libwebrtc's logs stay off whatever RUST_LOG says, since the native frame cryptor
    // has been reported to log key material. ZUNA_WEBRTC_LOG lets them through, which
    // is how scripts/key-log-check.mjs looks for that.
    let mut logger = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"));
    if std::env::var_os("ZUNA_WEBRTC_LOG").is_none() {
        logger.filter_module("libwebrtc", log::LevelFilter::Off);
    }
    logger.init();

    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
