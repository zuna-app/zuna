//! Sharing a screen or a window from a voice channel or a call. It's captured and encoded on the
//! graphics card in this process (`zuna-screenshare`, in screenshare/), or on macOS through
//! ScreenCaptureKit and VideoToolbox, and goes out from this device's own connection, under its
//! own key. The computer's sound comes from the same crate on every system and goes out beside it.

mod share;

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedReceiver, unbounded};
use gpui::{Context, Task};
use serde_json::{Value, json};
use zuna_screenshare::sound::{self, Sound, Wanted};

use super::room::{SCREEN_SOUND_SOURCE, SCREEN_SOURCE, VoiceRoom, send_frame};
use super::rules::{Held, ScreenChoices, screen_terms};
use super::settings::{bitrate_name, height_name, rate_name};
use super::sounds::VoiceSound;
use super::{ShareInfo, ToastKind, Voice};

/// How long a share gets to start capturing, which on Linux waits for the portal's dialog.
const START_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the media server gets to say a share may go out, after the chat server has told it.
const SHARE_PERMISSION_WAIT: Duration = Duration::from_secs(5);
/// How long the computer's sound may take to start, or to answer a question: a sound system
/// that doesn't answer would hold the share's start, or the picker, for good.
const SOUND_START_LIMIT: Duration = Duration::from_secs(10);
const SOUND_ANSWER_LIMIT: Duration = Duration::from_secs(5);

/// Where the encoded picture goes: to LiveKit, which sends it as it is, and whose estimate of
/// the network and requests for keyframes go back to the encoder.
#[cfg(not(target_os = "macos"))]
struct LiveKitOutput(livekit::webrtc::video_source::native::NativeVideoSource);

#[cfg(not(target_os = "macos"))]
impl zuna_screenshare::Output for LiveKitOutput {
    fn send(&mut self, frame: &zuna_screenshare::EncodedFrame) -> bool {
        use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
        use livekit::webrtc::video_source::VideoResolution;
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

/// Starts capturing the computer's sound, sending it to `source` in 10 ms of stereo at a time.
/// What comes out says what went wrong, if it stops by itself.
fn start_sound(app: Option<&str>, source: livekit::webrtc::audio_source::native::NativeAudioSource) -> Result<(Sound, UnboundedReceiver<String>), String> {
    // Two channels interleaved, gathered into 10 ms at 48 kHz.
    const FRAME_SAMPLES: usize = 480 * 2;
    let mut frame: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES);
    let (stopped, ended) = unbounded();
    let sound = Sound::start(
        Wanted::from_id(app),
        SOUND_START_LIMIT,
        move |samples| {
            for value in samples {
                frame.push((value.clamp(-1., 1.) * 32767.) as i16);
                if frame.len() == FRAME_SAMPLES {
                    send_frame(&source, std::mem::replace(&mut frame, Vec::with_capacity(FRAME_SAMPLES)), 2);
                }
            }
        },
        move |problem| {
            stopped.unbounded_send(problem.chars().take(200).collect()).ok();
        },
    )?;
    Ok((sound, ended))
}

/// An app playing sound, by what the share's sound calls it.
#[derive(Clone, Debug, PartialEq)]
pub struct SoundApp {
    pub id: String,
    pub name: String,
}

/// The app a window belongs to, whether it's playing, and the others its sound covers.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowSoundApp {
    pub app: SoundApp,
    pub playing: bool,
    pub covers: Vec<String>,
}

/// Asks the sound system on a thread of its own, and gives up after a moment.
fn ask<T: Send + 'static>(question: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (answer, answered) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = answer.send(question());
    });
    answered.recv_timeout(SOUND_ANSWER_LIMIT).ok()
}

/// The apps playing sound now, apart from Zuna.
pub fn sound_apps() -> Vec<SoundApp> {
    match ask(sound::apps) {
        Some(Ok(apps)) => apps.into_iter().map(|app| SoundApp { id: app.id, name: app.name }).collect(),
        Some(Err(problem)) => {
            log::warn!("listing the apps playing sound: {problem}");
            Vec::new()
        }
        None => Vec::new(),
    }
}

/// Which app a window belongs to, by its HWND.
pub fn window_sound_app(window: u64) -> Option<WindowSoundApp> {
    let found = ask(move || sound::window_app(window))?.ok()??;
    Some(WindowSoundApp { app: SoundApp { id: found.id, name: found.name }, playing: found.playing, covers: found.covers })
}

/// What the person chose in the picker.
#[derive(Clone, Debug)]
pub struct ScreenChoice {
    pub source: crate::platform::screens::Source,
    /// The computer's sound goes too.
    pub audio: bool,
    /// Whose: one app's by its id, or everything but Zuna.
    pub sound_app: Option<String>,
}

/// What's running for a share: the capture, and the computer's sound beside it.
#[derive(Default)]
pub struct ShareHandles {
    /// The capture and encoder, on a thread of their own.
    #[cfg(not(target_os = "macos"))]
    native: Option<zuna_screenshare::Share>,
    /// On macOS, ScreenCaptureKit's capture.
    #[cfg(target_os = "macos")]
    capture: Option<crate::platform::screen_capture::Capture>,
    sound: Option<Sound>,
    watch: Option<Task<()>>,
    sound_watch: Option<Task<()>>,
    /// What the capture said last about how it's going.
    pub stats: Option<Value>,
}
