//! Shares a screen or a window through `zuna-screenshare` and LiveKit, as the app does, under a
//! key everyone shares, while a second participant, a process of its own, watches and counts the
//! frames it decrypts and decodes. Run by apps/desktop/test/key-log-check.mjs, which reads its log
//! for the key too, and by apps/desktop/test/codec-check.mjs, which compares H.264 with AV1:
//!
//!   cargo run --example share-check --features share-check -- <url> <sharer's token> <watcher's token> <key> [seconds] [HWND]
//!
//! It shares the first monitor, or on Windows the window given. Nothing it captures is kept.
//! `ZUNA_SHARE_CODEC` is `h264` or `av1`, `ZUNA_SHARE_FPS`, `ZUNA_SHARE_KBPS` and
//! `ZUNA_SHARE_HEIGHT` say what to send (30, 4000 and 720 otherwise), and `ZUNA_SHARE_ENCODER` with
//! which, as Settings does. With `ZUNA_WATCHER_KEY`, the watcher has a key of its own, and the check
//! passes only if it opens nothing, or with `none` no encryption at all, as the media server has,
//! which has to open nothing of AV1. `ZUNA_WATCHER_LATE` has the watcher come that many seconds
//! after the share started, when only a keyframe the media server recognises lets it start.

#[cfg(target_os = "macos")]
fn main() {
    eprintln!("The app captures screens itself on Windows and Linux only.");
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
    use std::sync::atomic::{AtomicU64, Ordering};
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
    use zuna_screenshare::{Codec, EncodedFrame, Event, Options, Output, Share, Source};

    /// As the app hands frames to LiveKit (`LiveKitOutput` in src/voice/screen/mod.rs).
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

    /// A room under the shared key, as the app's own keys are made: HKDF, keeping a key that fails.
    /// Without a key, it comes in without encryption, seeing what the media server sees.
    async fn join(url: &str, token: &str, key: Option<&str>, subscribe: bool) -> (Room, tokio::sync::mpsc::UnboundedReceiver<RoomEvent>) {
        let options = KeyProviderOptions { key_derivation_algorithm: KeyDerivationAlgorithm::HKDF, ratchet_window_size: 0, failure_tolerance: -1, ..Default::default() };
        let mut room_options = RoomOptions::default();
        room_options.auto_subscribe = subscribe;
        room_options.encryption = key.map(|key| E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider: KeyProvider::with_shared_key(options, key.as_bytes().to_vec()) });
        let (room, events) = Room::connect(url, token, room_options).await.expect("joining the room");
        if key.is_some() {
            room.e2ee_manager().set_enabled(true);
        }
        (room, events)
    }

    fn number(name: &str, otherwise: u32) -> u32 {
        std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(otherwise)
    }

    /// What the watcher's WebRTC says it received and decoded, and in what.
    async fn watcher_stats(track: &RemoteVideoTrack) -> serde_json::Value {
        let Ok(stats) = track.get_stats().await else { return serde_json::Value::Null };
        let codecs: Vec<String> = stats.iter().filter_map(|stat| if let RtcStats::Codec(codec) = stat { Some(codec.codec.mime_type.clone()) } else { None }).collect();
        let Some(inbound) = stats.iter().find_map(|stat| if let RtcStats::InboundRtp(inbound) = stat { Some(inbound) } else { None }) else { return serde_json::Value::Null };
        let (received, decoded) = (&inbound.received, &inbound.inbound);
        let frames = decoded.frames_decoded.max(1) as f64;
        serde_json::json!({
            "codecs": codecs,
            "decoder": decoded.decoder_implementation,
            "powerEfficientDecoder": decoded.power_efficient_decoder,
            "framesReceived": decoded.frames_received,
            "framesDecoded": decoded.frames_decoded,
            "keyFramesDecoded": decoded.key_frames_decoded,
            "framesDropped": decoded.frames_dropped,
            "decodeMs": decoded.total_decode_time * 1000.0 / frames,
            "processingMs": decoded.total_processing_delay * 1000.0 / frames,
            "jitterBufferMs": decoded.jitter_buffer_delay * 1000.0 / decoded.jitter_buffer_emitted_count.max(1) as f64,
            "freezes": decoded.freeze_count,
            "freezeSeconds": decoded.total_freeze_duration,
            "bytesReceived": decoded.bytes_received,
            "packetsReceived": received.packets_received,
            "packetsLost": received.packets_lost,
            "plis": decoded.pli_count,
            "firs": decoded.fir_count,
            "nacks": decoded.nack_count,
            "width": decoded.frame_width,
            "height": decoded.frame_height,
        })
    }

    /// The watcher, in a process of its own so that its decoding isn't counted as the sharer's:
    /// comes in, watches for so long, and says what it saw on its last line.
    fn watch(url: &str, token: &str, key: &str, seconds: u64) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let decoded = Arc::new(AtomicU64::new(0));
        let size = Arc::new(parking_lot::Mutex::new((0u32, 0u32)));
        let watched = Arc::new(parking_lot::Mutex::new(None::<RemoteVideoTrack>));
        let cpu_at_start = zuna_screenshare::process_cpu_time();
        let started = Instant::now();
        let (room, mut events) = runtime.block_on(join(url, token, (key != "none").then_some(key), true));
        {
            let (decoded, size, watched) = (decoded.clone(), size.clone(), watched.clone());
            runtime.spawn(async move {
                while let Some(event) = events.recv().await {
                    if let RoomEvent::TrackSubscribed { track: RemoteTrack::Video(video), .. } = event {
                        *watched.lock() = Some(video.clone());
                        let (decoded, size) = (decoded.clone(), size.clone());
                        tokio::spawn(async move {
                            let mut stream = NativeVideoStream::new(video.rtc_track());
                            while let Some(frame) = stream.next().await {
                                *size.lock() = (frame.buffer.width(), frame.buffer.height());
                                decoded.fetch_add(1, Ordering::Relaxed);
                            }
                        });
                    }
                }
            });
        }
        std::thread::sleep(Duration::from_secs(seconds));
        let track = watched.lock().clone();
        let stats = match track {
            Some(track) => runtime.block_on(watcher_stats(&track)),
            None => serde_json::Value::Null,
        };
        let cpu = (zuna_screenshare::process_cpu_time() - cpu_at_start).as_secs_f64() / started.elapsed().as_secs_f64();
        let (width, height) = *size.lock();
        println!(
            "{}",
            serde_json::json!({ "watched": { "decoded": decoded.load(Ordering::Relaxed), "width": width, "height": height, "cpuCores": cpu, "stats": stats } })
        );
        runtime.block_on(room.close()).ok();
    }

    /// Starts the watcher, and reads what it says when it's done.
    fn start_watcher(url: &str, token: &str, key: &str, seconds: u64) -> std::thread::JoinHandle<Option<serde_json::Value>> {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["watch", url, token, key, &seconds.to_string()])
            .stdout(Stdio::piped())
            .spawn()
            .expect("starting the watcher");
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            let mut said = None;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(watched) = value.get("watched") {
                        said = Some(watched.clone());
                    }
                }
            }
            child.wait().ok();
            said
        })
    }

    pub fn main() {
        // As the app's own logger, so that this reads what the app would write.
        let mut logger = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
        if std::env::var_os("ZUNA_WEBRTC_LOG").is_none() {
            logger.filter_module("libwebrtc", log::LevelFilter::Off);
        }
        logger.init();

        let args: Vec<String> = std::env::args().skip(1).collect();
        if let [mode, url, token, key, seconds] = args.as_slice() {
            if mode == "watch" {
                return watch(url, token, key, seconds.parse().unwrap_or(6));
            }
        }
        let [url, sharer, watcher, key, rest @ ..] = args.as_slice() else {
            eprintln!("share-check <url> <sharer's token> <watcher's token> <key> [seconds] [HWND]");
            std::process::exit(2);
        };
        let seconds: u64 = rest.first().and_then(|seconds| seconds.parse().ok()).unwrap_or(6);
        let window: Option<u64> = rest.get(1).and_then(|window| window.parse().ok());
        let codec = if std::env::var("ZUNA_SHARE_CODEC").is_ok_and(|codec| codec == "av1") { Codec::Av1 } else { Codec::H264 };
        let (fps, kbps, height) = (number("ZUNA_SHARE_FPS", 30), number("ZUNA_SHARE_KBPS", 4_000), number("ZUNA_SHARE_HEIGHT", 720));
        let watcher_key = std::env::var("ZUNA_WATCHER_KEY").unwrap_or_else(|_| key.clone());
        let locked_out = watcher_key != *key;
        let late = Duration::from_secs(number("ZUNA_WATCHER_LATE", 0) as u64);
        let runtime = tokio::runtime::Runtime::new().unwrap();

        let mut watching = late.is_zero().then(|| start_watcher(url, watcher, &watcher_key, seconds));
        let (sharing, _sharer_events) = runtime.block_on(join(url, sharer, Some(key), false));
        let (events, said) = std::sync::mpsc::channel::<Event>();
        let options = Options {
            codec,
            encoder: std::env::var("ZUNA_SHARE_ENCODER").unwrap_or_else(|_| "auto".into()),
            fps,
            bitrate_kbps: kbps as u64,
            max_height: (height > 0).then_some(height),
            window,
            source: if window.is_some() { Source::Window } else { Source::Screen },
            ..Options::default()
        };
        let share = Share::start(options, move |event| {
            events.send(event).ok();
        })
        .expect("starting the share");
        let ready = loop {
            match said.recv_timeout(Duration::from_secs(30)).expect("the share started") {
                Event::Ready(ready) => break ready,
                Event::Ended(problem) => panic!("the share stopped: {problem:?}"),
                Event::Stats(_) => {}
            }
        };
        println!("{}", serde_json::json!({ "ready": ready.description, "codec": ready.codec.name(), "width": ready.width, "height": ready.height }));
        let source = NativeVideoSource::new_encoded(VideoResolution { width: ready.width, height: ready.height });
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
        let publishing = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: match ready.codec {
                Codec::H264 => VideoCodec::H264,
                Codec::Av1 => VideoCodec::AV1,
            },
            simulcast: false,
            video_encoding: Some(VideoEncoding { max_bitrate: kbps as u64 * 1000, max_framerate: fps as f64 }),
            video_encoder: VideoEncoderBackend::PreEncoded,
            ..Default::default()
        };
        runtime.block_on(sharing.local_participant().publish_track(LocalTrack::Video(track), publishing)).expect("publishing");
        share.publish(Box::new(LiveKitOutput(source)));

        // Shares until the watcher has watched for as long as it was to, and a moment more.
        let started = Instant::now();
        let mut ended = None;
        let watched = loop {
            if watching.is_none() && started.elapsed() >= late {
                println!("{}", serde_json::json!({ "watcherComes": started.elapsed().as_secs_f64() }));
                watching = Some(start_watcher(url, watcher, &watcher_key, seconds));
            }
            if watching.as_ref().is_some_and(|watcher| watcher.is_finished()) {
                break watching.take().and_then(|watcher| watcher.join().ok()).flatten();
            }
            if started.elapsed() > late + Duration::from_secs(seconds + 30) {
                break None;
            }
            match said.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Stats(stats)) => println!("{}", serde_json::json!({ "stats": stats })),
                Ok(Event::Ended(problem)) => {
                    ended = Some(problem);
                    break watching.take().and_then(|watcher| watcher.join().ok()).flatten();
                }
                Ok(Event::Ready(_)) | Err(_) => {}
            }
        };
        share.stop();
        // Its thread says it's stopped once the capture has let go, after any report still on its way.
        let stopping = Instant::now() + Duration::from_secs(5);
        let stopped = ended.is_some()
            || loop {
                match said.recv_timeout(stopping.saturating_duration_since(Instant::now())) {
                    Ok(Event::Ended(problem)) => break problem.is_none(),
                    Ok(_) => continue,
                    Err(_) => break false,
                }
            };
        let watched = watched.unwrap_or(serde_json::Value::Null);
        let decoded = watched.get("decoded").and_then(serde_json::Value::as_u64).unwrap_or(0);
        let (width, height) = (watched.get("width").cloned().unwrap_or_default(), watched.get("height").cloned().unwrap_or_default());
        println!(
            "{}",
            serde_json::json!({ "decoded": decoded, "width": width, "height": height, "stopped": stopped, "endedEarly": ended.flatten(), "lockedOut": locked_out, "watcherCpuCores": watched.get("cpuCores"), "watcher": watched.get("stats") })
        );
        runtime.block_on(sharing.close()).ok();
        // A watcher with the key has to open it, and one with another key nothing. One without
        // encryption opens nothing of AV1, all of whose frames are encrypted; H.264's NAL headers
        // aren't, so a decoder makes frames of what it can't open, which can't be told from a
        // picture by looking, and that's only reported.
        let opened = match (locked_out, watcher_key == "none", ready.codec) {
            (false, _, _) => decoded > 0,
            (true, true, Codec::H264) => true,
            (true, _, _) => decoded == 0,
        };
        std::process::exit(if opened && stopped { 0 } else { 1 });
    }
}
