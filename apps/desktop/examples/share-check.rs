//! Shares a screen or a window through `zuna-screenshare` and LiveKit, as the app does, under a
//! key everyone shares, while a second participant watches and counts the frames it decrypts and
//! decodes. Run by apps/desktop/test/key-log-check.mjs, which reads its log for the key too:
//!
//!   cargo run --example share-check --features share-check -- <url> <sharer's token> <watcher's token> <key> [seconds] [HWND]
//!
//! It shares the first monitor, or on Windows the window given. Nothing it captures is kept.

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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    use futures::StreamExt;
    use livekit::e2ee::key_provider::{KeyDerivationAlgorithm, KeyProvider, KeyProviderOptions};
    use livekit::e2ee::{E2eeOptions, EncryptionType};
    use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
    use livekit::prelude::*;
    use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
    use livekit::webrtc::video_source::native::NativeVideoSource;
    use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
    use livekit::webrtc::video_stream::native::NativeVideoStream;
    use zuna_screenshare::{EncodedFrame, Event, Options, Output, Share, Source};

    /// As the app hands frames to LiveKit (`LiveKitOutput` in src/voice/screen/mod.rs).
    struct LiveKitOutput(NativeVideoSource);

    impl Output for LiveKitOutput {
        fn send(&mut self, frame: &EncodedFrame) -> bool {
            self.0.capture_encoded_frame(&EncodedVideoFrame {
                codec: EncodedVideoCodec::H264,
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
    async fn join(url: &str, token: &str, key: &str, subscribe: bool) -> (Room, tokio::sync::mpsc::UnboundedReceiver<RoomEvent>) {
        let options = KeyProviderOptions { key_derivation_algorithm: KeyDerivationAlgorithm::HKDF, ratchet_window_size: 0, ..Default::default() };
        let mut room_options = RoomOptions::default();
        room_options.auto_subscribe = subscribe;
        room_options.encryption = Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider: KeyProvider::with_shared_key(options, key.as_bytes().to_vec()) });
        let (room, events) = Room::connect(url, token, room_options).await.expect("joining the room");
        room.e2ee_manager().set_enabled(true);
        (room, events)
    }

    pub fn main() {
        // As the app's own logger, so that this reads what the app would write.
        let mut logger = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
        if std::env::var_os("ZUNA_WEBRTC_LOG").is_none() {
            logger.filter_module("libwebrtc", log::LevelFilter::Off);
        }
        logger.init();

        let args: Vec<String> = std::env::args().skip(1).collect();
        let [url, sharer, watcher, key, rest @ ..] = args.as_slice() else {
            eprintln!("share-check <url> <sharer's token> <watcher's token> <key> [seconds] [HWND]");
            std::process::exit(2);
        };
        let seconds: u64 = rest.first().and_then(|seconds| seconds.parse().ok()).unwrap_or(6);
        let window: Option<u64> = rest.get(1).and_then(|window| window.parse().ok());
        let runtime = tokio::runtime::Runtime::new().unwrap();

        // The watcher counts what it can open, at the size it comes.
        let decoded = Arc::new(AtomicU64::new(0));
        let size = Arc::new(parking_lot::Mutex::new((0u32, 0u32)));
        let (watching, mut watcher_events) = runtime.block_on(join(url, watcher, key, true));
        {
            let (decoded, size) = (decoded.clone(), size.clone());
            runtime.spawn(async move {
                while let Some(event) = watcher_events.recv().await {
                    if let RoomEvent::TrackSubscribed { track: RemoteTrack::Video(video), .. } = event {
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

        let (sharing, _sharer_events) = runtime.block_on(join(url, sharer, key, false));
        let (events, said) = std::sync::mpsc::channel::<Event>();
        let options = Options { fps: 30, bitrate_kbps: 4_000, max_height: Some(720), window, source: if window.is_some() { Source::Window } else { Source::Screen }, ..Options::default() };
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
        println!("{}", serde_json::json!({ "ready": ready.description, "width": ready.width, "height": ready.height }));
        let source = NativeVideoSource::new_encoded(VideoResolution { width: ready.width, height: ready.height });
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
        let publishing = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: VideoCodec::H264,
            simulcast: false,
            video_encoding: Some(VideoEncoding { max_bitrate: 4_000_000, max_framerate: 30. }),
            video_encoder: VideoEncoderBackend::PreEncoded,
            ..Default::default()
        };
        runtime.block_on(sharing.local_participant().publish_track(LocalTrack::Video(track), publishing)).expect("publishing");
        share.publish(Box::new(LiveKitOutput(source)));

        let until = Instant::now() + Duration::from_secs(seconds);
        let mut ended = None;
        while Instant::now() < until {
            match said.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(Event::Stats(stats)) => println!("{}", serde_json::json!({ "stats": stats })),
                Ok(Event::Ended(problem)) => {
                    ended = Some(problem);
                    break;
                }
                Ok(Event::Ready(_)) | Err(_) => {}
            }
        }
        share.stop();
        // Its thread says it's stopped once the capture has let go.
        let stopped = ended.is_some() || matches!(said.recv_timeout(Duration::from_secs(5)), Ok(Event::Ended(None)));
        let (width, height) = *size.lock();
        let decoded = decoded.load(Ordering::Relaxed);
        println!("{}", serde_json::json!({ "decoded": decoded, "width": width, "height": height, "stopped": stopped, "endedEarly": ended.flatten() }));
        runtime.block_on(async {
            sharing.close().await.ok();
            watching.close().await.ok();
        });
        std::process::exit(if decoded > 0 && stopped { 0 } else { 1 });
    }
}
