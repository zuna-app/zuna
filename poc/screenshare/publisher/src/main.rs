//! Captures a screen, encodes it on the GPU and publishes it through LiveKit, end to
//! end encrypted. See ../README.md.

mod capture;
mod cpu;
mod encoder;
mod h264;
mod pipeline;

use std::{
    fs::File,
    io::BufWriter,
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use capture::{Capture, Options};
use encoder::Result;
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
    keyframe_seconds: u32,
    seconds: Option<u64>,
    fix_idr: bool,
    output: Option<String>,
    output_raw: Option<String>,
    list_monitors: bool,
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
  --monitor N            Which monitor (0). Linux asks through the portal instead.
  --monitor-at X,Y       The monitor at this point on the desktop
  --crop WxH             Encode this much from the top left of the monitor
  --cpu-input            Give the encoder frames from CPU memory
  --render-node PATH     VA-API's device (/dev/dri/renderD128)
  --keyframe-seconds N   Seconds between regular keyframes (10)
  --seconds N            Stop after this long
  --no-idr-fix           Leave out the fix for keyframes under encryption
  --output FILE          Write H.264 to a file instead of publishing
  --output-raw FILE      Also write the encoder's output, unchanged
  --list-monitors        List monitors and exit";

fn parse_args() -> std::result::Result<Args, String> {
    let mut args = Args {
        capture: Options { encoder: "auto".into(), fps: 60, render_node: "/dev/dri/renderD128".into(), ..Options::default() },
        url: "ws://127.0.0.1:7880".into(),
        api_key: "devkey".into(),
        api_secret: "secret".into(),
        room: "zuna-demo".into(),
        identity: "sharer".into(),
        e2ee_key: None,
        bitrate_kbps: 20_000,
        keyframe_seconds: 10,
        seconds: None,
        fix_idr: true,
        output: None,
        output_raw: None,
        list_monitors: false,
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
            "--monitor" => args.capture.monitor = value()?.parse().map_err(number_error)?,
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
            E2eeOptions, EncryptionType,
        },
        options::{TrackPublishOptions, VideoCodec, VideoEncoding},
        track::{LocalTrack, LocalVideoTrack, TrackSource},
        webrtc::{
            rtp_sender::VideoEncoderBackend,
            video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
        },
        Room, RoomEvent, RoomOptions,
    };
    use livekit_api::access_token::{AccessToken, VideoGrants};

    use super::{Args, Result};

    pub async fn start(args: &Args, width: u32, height: u32) -> Result<(Room, NativeVideoSource)> {
        let token = AccessToken::with_api_key(&args.api_key, &args.api_secret)
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

        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        // HKDF, because a key from the MLS exporter is already random and has no need
        // of the password stretching that's the default here.
        options.encryption = args.e2ee_key.as_ref().map(|key| E2eeOptions {
            encryption_type: EncryptionType::Gcm,
            key_provider: KeyProvider::with_shared_key(
                KeyProviderOptions { key_derivation_algorithm: KeyDerivationAlgorithm::HKDF, ..Default::default() },
                key.clone().into_bytes(),
            ),
        });

        let (room, mut events) = Room::connect(&args.url, &token, options).await.map_err(|error| format!("Joining the room: {error}"))?;
        if args.e2ee_key.is_some() {
            room.e2ee_manager().set_enabled(true);
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
        Ok((room, source))
    }
}

fn run(args: Args) -> Result<()> {
    if args.list_monitors {
        capture::list_monitors();
        return Ok(());
    }

    let runtime = tokio::runtime::Runtime::new().map_err(|error| format!("Starting the runtime: {error}"))?;
    let _entered = runtime.enter();

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        runtime.spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            stop.store(true, Ordering::Relaxed);
        });
    }
    if let Some(seconds) = args.seconds {
        let stop = stop.clone();
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            stop.store(true, Ordering::Relaxed);
        });
    }

    let mut capture = Capture::open(&args.capture, &runtime)?;
    let (width, height) = capture.size();
    let bitrate_cap = args.bitrate_kbps * 1000;
    let publishing = args.output.is_none();
    let bitrate = pipeline::starting_bitrate(bitrate_cap, publishing);
    let gop = args.capture.fps * args.keyframe_seconds;
    let encoder = capture.open_encoder(args.capture.fps, gop, bitrate)?;

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
            let (joined, source) = runtime.block_on(publish::start(&args, width, height))?;
            room = Some(joined);
            Sink::LiveKit(source)
        }
        #[cfg(not(feature = "livekit"))]
        None => return Err("Built without LiveKit, so this needs --output".into()),
    };

    println!(
        "{{\"type\":\"ready\",\"description\":{:?},\"width\":{width},\"height\":{height},\"fps\":{},\"e2ee\":{},\"idrFix\":{}}}",
        capture.description,
        args.capture.fps,
        args.e2ee_key.is_some(),
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
    // Stays above INFO even when asked for more of this program's logs, since the
    // native frame cryptor has been reported to log key material at that level.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).filter_module("libwebrtc", log::LevelFilter::Warn).init();

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
