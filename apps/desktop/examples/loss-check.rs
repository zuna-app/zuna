//! Sends a picture made here, noise that takes whatever bitrate it's given, through the share's own
//! encoder and pipeline and LiveKit, as the app does, while a second participant, a process of its
//! own, watches, and says each second what arrived, what was lost and how often the picture
//! stopped. Run by apps/desktop/test/loss-check.mjs, which puts a network that loses packets
//! between the two and LiveKit:
//!
//!   cargo run --release --example loss-check --features share-check,zuna-screenshare/bench -- <url> <sharer's token> <watcher's token> <key> [seconds]
//!
//! `ZUNA_SHARE_CODEC`, `ZUNA_SHARE_FPS`, `ZUNA_SHARE_KBPS`, `ZUNA_SHARE_WIDTH` and
//! `ZUNA_SHARE_HEIGHT` say what to send (H.264, 60, 20000 and 1920x1080 otherwise),
//! `ZUNA_SHARE_ENCODER` with which family of encoder (`nvenc` otherwise), and `ZUNA_NOISE_PERCENT`
//! how much of the picture is new in each frame (100 otherwise): all of it is more than H.264
//! holds under 38 Mbit/s at 1080p, whatever it's asked for.

#[cfg(target_os = "macos")]
fn main() {
    eprintln!("The app encodes shares itself on Windows and Linux only.");
    std::process::exit(2);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    check::main();
}

#[cfg(not(target_os = "macos"))]
mod check {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use futures::StreamExt;
    use livekit::e2ee::key_provider::{KeyDerivationAlgorithm, KeyProvider, KeyProviderOptions};
    use livekit::e2ee::{E2eeOptions, EncryptionType};
    use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
    use livekit::prelude::*;
    use livekit::webrtc::stats::RtcStats;
    use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
    use livekit::webrtc::video_source::native::NativeVideoSource;
    use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
    use livekit::webrtc::video_stream::native::NativeVideoStream;
    use zuna_screenshare::bench::{starting_bitrate, Config, Encoder, Input, Pipeline, Pixel, Stream, INPUT_CPU};
    use zuna_screenshare::{Codec, EncodedFrame, Output, Quality};

    struct LiveKitOutput(NativeVideoSource);

    impl Output for LiveKitOutput {
        fn send(&mut self, frame: &EncodedFrame) -> bool {
            self.0.capture_encoded_frame(&EncodedVideoFrame {
                codec: match frame.codec {
                    Codec::H264 => EncodedVideoCodec::H264,
                    Codec::Av1 => EncodedVideoCodec::AV1,
                },
                payload: frame.data,
                timestamp_us: frame.timestamp_us,
                frame_type: if frame.key { EncodedFrameType::Key } else { EncodedFrameType::Delta },
                resolution: VideoResolution { width: frame.width, height: frame.height },
                frame_metadata: None,
            })
        }

        fn take_keyframe_request(&mut self) -> bool {
            self.0.take_keyframe_request()
        }

        fn take_target_bitrate(&mut self) -> Option<u64> {
            self.0.take_rate_control_request().map(|request| request.target_bitrate_bps)
        }
    }

    async fn join(url: &str, token: &str, key: &str, subscribe: bool) -> (Room, tokio::sync::mpsc::UnboundedReceiver<RoomEvent>) {
        let options = KeyProviderOptions { key_derivation_algorithm: KeyDerivationAlgorithm::HKDF, ratchet_window_size: 0, failure_tolerance: -1, ..Default::default() };
        let mut room_options = RoomOptions::default();
        room_options.auto_subscribe = subscribe;
        room_options.encryption = Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider: KeyProvider::with_shared_key(options, key.as_bytes().to_vec()) });
        let (room, events) = Room::connect(url, token, room_options).await.expect("joining the room");
        room.e2ee_manager().set_enabled(true);
        (room, events)
    }

    fn number(name: &str, otherwise: u32) -> u32 {
        std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(otherwise)
    }

    /// What the watcher's WebRTC has received and decoded so far.
    async fn watcher_stats(track: &RemoteVideoTrack) -> Option<serde_json::Value> {
        let stats = track.get_stats().await.ok()?;
        let inbound = stats.iter().find_map(|stat| if let RtcStats::InboundRtp(inbound) = stat { Some(inbound) } else { None })?;
        let (received, decoded) = (&inbound.received, &inbound.inbound);
        let frames = decoded.frames_decoded.max(1) as f64;
        Some(serde_json::json!({
            "decoder": decoded.decoder_implementation,
            "framesReceived": decoded.frames_received,
            "framesDecoded": decoded.frames_decoded,
            "keyFramesDecoded": decoded.key_frames_decoded,
            "framesDropped": decoded.frames_dropped,
            "decodeMs": decoded.total_decode_time * 1000.0 / frames,
            "jitterBufferMs": decoded.jitter_buffer_delay * 1000.0 / decoded.jitter_buffer_emitted_count.max(1) as f64,
            "freezes": decoded.freeze_count,
            "freezeSeconds": decoded.total_freeze_duration,
            "bytesReceived": decoded.bytes_received,
            "packetsReceived": received.packets_received,
            "packetsLost": received.packets_lost,
            "plis": decoded.pli_count,
            "nacks": decoded.nack_count,
        }))
    }

    fn watch(url: &str, token: &str, key: &str, seconds: u64) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let watched = Arc::new(parking_lot::Mutex::new(None::<RemoteVideoTrack>));
        let (room, mut events) = runtime.block_on(join(url, token, key, true));
        {
            let watched = watched.clone();
            runtime.spawn(async move {
                while let Some(event) = events.recv().await {
                    if let RoomEvent::TrackSubscribed { track: RemoteTrack::Video(video), .. } = event {
                        *watched.lock() = Some(video.clone());
                        tokio::spawn(async move {
                            let mut stream = NativeVideoStream::new(video.rtc_track());
                            while stream.next().await.is_some() {}
                        });
                    }
                }
            });
        }
        let started = Instant::now();
        let mut last = None::<serde_json::Value>;
        let field = |value: &serde_json::Value, name: &str| value.get(name).and_then(serde_json::Value::as_f64).unwrap_or(0.);
        while started.elapsed() < Duration::from_secs(seconds) {
            std::thread::sleep(Duration::from_secs(1));
            let track = watched.lock().clone();
            let Some(now) = track.and_then(|track| runtime.block_on(watcher_stats(&track))) else { continue };
            if let Some(before) = &last {
                let delta = |name: &str| field(&now, name) - field(before, name);
                println!(
                    "{}",
                    serde_json::json!({ "second": {
                        "t": started.elapsed().as_secs(),
                        "mbit": (delta("bytesReceived") * 8. / 1e6 * 100.).round() / 100.,
                        "packets": delta("packetsReceived"),
                        "lost": delta("packetsLost"),
                        "nacks": delta("nacks"),
                        "plis": delta("plis"),
                        "decoded": delta("framesDecoded"),
                        "dropped": delta("framesDropped"),
                        "keys": delta("keyFramesDecoded"),
                        "freezes": delta("freezes"),
                    } })
                );
            }
            last = Some(now);
        }
        println!("{}", serde_json::json!({ "watched": last }));
        runtime.block_on(room.close()).ok();
    }

    /// Noise in blocks of 4 pixels, a few frames of it that never repeat in order: nothing of one
    /// is in the next, so the encoder spends all it's given.
    struct Noise {
        frames: Vec<Vec<u8>>,
    }

    impl Noise {
        fn new(width: usize, height: usize) -> Self {
            let mut state = 0x9E37_79B9_7F4A_7C15u64;
            let mut next = move || {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state
            };
            let frames = (0..6)
                .map(|_| {
                    let mut pixels = vec![0u8; width * height * 4];
                    for y in (0..height).step_by(4) {
                        for x in (0..width).step_by(4) {
                            let value = next().to_le_bytes();
                            for dy in 0..4.min(height - y) {
                                for dx in 0..4.min(width - x) {
                                    let at = ((y + dy) * width + x + dx) * 4;
                                    pixels[at..at + 4].copy_from_slice(&[value[0], value[1], value[2], 255]);
                                }
                            }
                        }
                    }
                    pixels
                })
                .collect();
            Self { frames }
        }

        fn frame(&self, index: usize) -> &[u8] {
            // 0 1 2 3 4 5 0 2 4 1 3 5 ..., so that no pair comes up often enough to be worth keeping.
            let round = index / self.frames.len();
            &self.frames[(index % self.frames.len() * (1 + round % 5)) % self.frames.len()]
        }
    }

    pub fn main() {
        let mut logger = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
        if std::env::var_os("ZUNA_WEBRTC_LOG").is_none() {
            logger.filter_module("libwebrtc", log::LevelFilter::Off);
        }
        logger.init();

        let args: Vec<String> = std::env::args().skip(1).collect();
        if let [mode, url, token, key, seconds] = args.as_slice() {
            if mode == "watch" {
                return watch(url, token, key, seconds.parse().unwrap_or(20));
            }
        }
        let [url, sharer, watcher, key, rest @ ..] = args.as_slice() else {
            eprintln!("loss-check <url> <sharer's token> <watcher's token> <key> [seconds]");
            std::process::exit(2);
        };
        let seconds: u64 = rest.first().and_then(|seconds| seconds.parse().ok()).unwrap_or(20);
        let codec = if std::env::var("ZUNA_SHARE_CODEC").is_ok_and(|codec| codec == "av1") { Codec::Av1 } else { Codec::H264 };
        let (fps, kbps) = (number("ZUNA_SHARE_FPS", 60), number("ZUNA_SHARE_KBPS", 20_000) as u64);
        let (width, height) = (number("ZUNA_SHARE_WIDTH", 1920) as usize, number("ZUNA_SHARE_HEIGHT", 1080) as usize);
        let runtime = tokio::runtime::Runtime::new().unwrap();

        let mut child = Command::new(std::env::current_exe().unwrap()).args(["watch", url, watcher, key, &seconds.to_string()]).stdout(Stdio::piped()).spawn().expect("starting the watcher");
        let stdout = child.stdout.take().unwrap();
        let watching = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                println!("{line}");
            }
            child.wait().ok();
        });

        let (sharing, _events) = runtime.block_on(join(url, sharer, key, false));
        let source = NativeVideoSource::new_encoded(VideoResolution { width: width as u32, height: height as u32 });
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
        let publishing = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: match codec {
                Codec::H264 => VideoCodec::H264,
                Codec::Av1 => VideoCodec::AV1,
            },
            simulcast: false,
            video_encoding: Some(VideoEncoding { max_bitrate: kbps * 1000, max_framerate: fps as f64 }),
            video_encoder: VideoEncoderBackend::PreEncoded,
            ..Default::default()
        };
        runtime.block_on(sharing.local_participant().publish_track(LocalTrack::Video(track.clone()), publishing)).expect("publishing");

        let name = codec.encoder(&std::env::var("ZUNA_SHARE_ENCODER").unwrap_or_else(|_| "nvenc".into()));
        let bitrate = starting_bitrate(kbps * 1000);
        let stream = Stream { width: width as u32, height: height as u32, fps, gop: fps * 60, bitrate, quality: Quality::Balanced };
        let render_node = std::env::var("ZUNA_RENDER_NODE").unwrap_or_else(|_| "/dev/dri/renderD128".into());
        let encoder = Encoder::open(&Config { codec: &name, input: INPUT_CPU, pixel: Pixel::Bgra, source_width: width as u32, source_height: height as u32, stream, d3d11_device: std::ptr::null_mut(), render_node: Some(&render_node) }).expect("opening the encoder");
        let mut pipeline = Pipeline::new(encoder, codec, Box::new(LiveKitOutput(source)), Box::new(|report| println!("{}", serde_json::json!({ "stats": report }))), width as u32, height as u32, fps, bitrate, kbps * 1000, None);

        let noise = Noise::new(width, height);
        // How much of the picture is new in each frame: a band of that many rows, which moves down it.
        let band = (height * number("ZUNA_NOISE_PERCENT", 100).clamp(1, 100) as usize / 100).max(4);
        let mut canvas = vec![96u8; width * height * 4];
        let start = Instant::now();
        let mut index = 0usize;
        while !watching.is_finished() && start.elapsed() < Duration::from_secs(seconds + 30) {
            let due = start + Duration::from_secs_f64(index as f64 / fps as f64);
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            let from = noise.frame(index);
            let top = (index * band) % height;
            let rows = band.min(height - top);
            canvas[top * width * 4..(top + rows) * width * 4].copy_from_slice(&from[top * width * 4..(top + rows) * width * 4]);
            if let Err(error) = pipeline.on_frame(Input::Cpu { data: &canvas, stride: width * 4 }) {
                eprintln!("encoding: {error}");
                break;
            }
            index += 1;
        }
        drop(pipeline);
        // What the sender's WebRTC says it sent, and what the media server said arrived.
        if let Ok(stats) = runtime.block_on(track.get_stats()) {
            for stat in stats {
                match stat {
                    RtcStats::OutboundRtp(outbound) => println!(
                        "{}",
                        serde_json::json!({ "sent": { "packets": outbound.sent.packets_sent, "bytes": outbound.sent.bytes_sent, "retransmittedPackets": outbound.outbound.retransmitted_packets_sent, "nacks": outbound.outbound.nack_count, "plis": outbound.outbound.pli_count, "targetBitrate": outbound.outbound.target_bitrate, "limitation": format!("{:?}", outbound.outbound.quality_limitation_reason) } })
                    ),
                    RtcStats::RemoteInboundRtp(remote) => println!("{}", serde_json::json!({ "serverSaw": { "packetsLost": remote.received.packets_lost, "jitter": remote.received.jitter, "roundTripTime": remote.remote_inbound.round_trip_time } })),
                    _ => {}
                }
            }
        }
        watching.join().ok();
        runtime.block_on(sharing.close()).ok();
    }
}
