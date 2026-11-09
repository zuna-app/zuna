//! How this device does voice (packages/ui/src/voice/settings.ts). These stay on this
//! device, since which microphone and how loud are about the room it's in.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::ScreenRules;
use crate::voice::rules::SCREEN_DEFAULT_FPS;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceSettings {
    pub input_device: String,
    pub output_device: String,
    pub camera_device: String,
    /// How loud the microphone is, from 0 to 2.
    pub input_volume: f32,
    /// How loud everyone is, from 0 to 2.
    pub output_volume: f32,
    /// "voice" sends whenever someone speaks, "ptt" while a key is held.
    pub input_mode: String,
    /// Works out for itself what's speech, or goes by the level below.
    pub auto_sensitivity: bool,
    /// Sounds louder than this go through, in dB.
    pub sensitivity: f32,
    /// What's held for push to talk, as `KeyboardEvent.code` names it.
    pub ptt_key: String,
    /// How long sound keeps going after it's let go, in ms.
    pub ptt_release: f32,
    /// "zuna" for RNNoise, "standard" for WebRTC's own, or "off".
    pub noise_suppression: String,
    pub echo_cancellation: bool,
    pub auto_gain: bool,
    /// Sounds for people coming and going, and for muting.
    pub sounds: bool,
    pub start_muted: bool,
    /// The tallest a share's picture may be, or 0 for the screen's own size.
    pub screen_resolution: u32,
    pub screen_frame_rate: u32,
    /// The most a share may send, in kbit/s, or None to leave it to the app.
    pub screen_max_bitrate: Option<u32>,
    pub screen_cursor: bool,
    /// A share starts with the sound of what's shared.
    pub screen_sound_by_default: bool,
    /// "h264", or "av1", which is experimental: only the native app opens it under encryption.
    pub screen_codec: String,
    /// "auto", or one encoder by name, for when the one picked for this computer misbehaves.
    pub screen_encoder: String,
    /// How loud others' shares are, from 0 to 2.
    pub screen_volume: f32,
    /// A screen someone starts sharing fills the stage.
    pub screen_focus: bool,
    /// How loud sounds from the soundboard are, from 0 to 1. At 0 none of them plays.
    pub soundboard_volume: f32,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        VoiceSettings {
            input_device: "default".into(),
            output_device: "default".into(),
            camera_device: "default".into(),
            input_volume: 1.,
            output_volume: 1.,
            input_mode: "voice".into(),
            auto_sensitivity: true,
            sensitivity: -50.,
            ptt_key: String::new(),
            ptt_release: 20.,
            noise_suppression: "zuna".into(),
            echo_cancellation: true,
            auto_gain: true,
            sounds: true,
            start_muted: false,
            screen_resolution: 0,
            screen_frame_rate: SCREEN_DEFAULT_FPS,
            screen_max_bitrate: None,
            screen_cursor: true,
            screen_sound_by_default: true,
            screen_codec: "h264".into(),
            screen_encoder: "auto".into(),
            screen_volume: 1.,
            screen_focus: true,
            soundboard_volume: 0.6,
        }
    }
}

fn path(name: &str) -> std::path::PathBuf {
    crate::host::data_dir().join(name)
}

fn load<T: for<'de> Deserialize<'de> + Default>(name: &str) -> T {
    let Ok(bytes) = std::fs::read(path(name)) else { return T::default() };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        log::warn!("{name} couldn't be read, so it's back to its defaults: {error}");
        T::default()
    })
}

fn save<T: Serialize>(name: &str, value: &T) {
    if let Ok(json) = serde_json::to_vec_pretty(value) {
        std::fs::create_dir_all(crate::host::data_dir()).ok();
        if let Err(error) = crate::host::write_whole(&path(name), &json) {
            log::warn!("couldn't save {name}: {error}");
        }
    }
}

impl VoiceSettings {
    pub fn load() -> VoiceSettings {
        load("voice-settings.json")
    }

    pub fn save(&self) {
        save("voice-settings.json", self);
    }

    /// What opening the microphone depends on, to tell whether it has to be opened again.
    pub fn capture_key(&self) -> String {
        format!("{}|{}|{}|{}", self.input_device, self.echo_cancellation, self.auto_gain, self.noise_suppression == "standard")
    }
}

/// How loud each person is for this device, from 0 to 2, by user: their voice, or their shared screen's sound.
pub fn load_volumes(stream: bool) -> HashMap<String, f32> {
    load(if stream { "voice-stream-volumes.json" } else { "voice-volumes.json" })
}

pub fn save_volumes(volumes: &HashMap<String, f32>, stream: bool) {
    save(if stream { "voice-stream-volumes.json" } else { "voice-volumes.json" }, volumes);
}

pub const SCREEN_HEIGHTS: [u32; 5] = [2160, 1440, 1080, 720, 480];
pub const SCREEN_RATES: [u32; 8] = [15, 30, 60, 90, 120, 144, 165, 240];
pub const SCREEN_BITRATES: [u32; 8] = [2_000, 4_000, 6_000, 8_000, 12_000, 20_000, 30_000, 50_000];
/// What a server may hold shares to, which goes higher than anyone needs to choose.
pub const SCREEN_LIMIT_BITRATES: [u32; 9] = [2_000, 4_000, 6_000, 8_000, 12_000, 20_000, 30_000, 50_000, 100_000];

pub fn height_name(height: u32) -> String {
    match height {
        0 => "Native".into(),
        2160 => "4K".into(),
        _ => format!("{height}p"),
    }
}

pub fn rate_name(fps: u32) -> String {
    format!("{fps} fps")
}

pub fn bitrate_name(kbps: u32) -> String {
    if kbps >= 1000 {
        let mbit = kbps as f64 / 1000.;
        if mbit.fract() == 0. { format!("{} Mbps", mbit as u32) } else { format!("{mbit} Mbps") }
    } else {
        format!("{kbps} kbps")
    }
}

/// What a server holds someone's shares to, in words, or None if it doesn't.
pub fn screen_limits_text(rules: Option<&ScreenRules>, role: &str) -> Option<String> {
    let rules = rules?;
    if rules.admins_exempt && (role == "owner" || role == "admin") {
        return None;
    }
    let mut limits = Vec::new();
    if rules.max_height > 0 {
        limits.push(height_name(rules.max_height));
    }
    if rules.max_fps > 0 {
        limits.push(rate_name(rules.max_fps));
    }
    if rules.max_kbps > 0 {
        limits.push(bitrate_name(rules.max_kbps));
    }
    (!limits.is_empty()).then(|| format!("This server limits screen shares to {}.", limits.join(", ")))
}

/// What a key is called, from its `KeyboardEvent.code`.
pub fn key_name(code: &str) -> String {
    if code.is_empty() {
        return "Not set".into();
    }
    if let Some(rest) = code.strip_prefix("Key") {
        return rest.into();
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        return rest.into();
    }
    if let Some(rest) = code.strip_prefix("Numpad") {
        return format!("Numpad {rest}");
    }
    if let Some(rest) = code.strip_prefix("Mouse") {
        return format!("Mouse {rest}");
    }
    match code {
        "ControlLeft" => "Left Ctrl",
        "ControlRight" => "Right Ctrl",
        "ShiftLeft" => "Left Shift",
        "ShiftRight" => "Right Shift",
        "AltLeft" => "Left Alt",
        "AltRight" => "Right Alt",
        "MetaLeft" => "Left Meta",
        "MetaRight" => "Right Meta",
        "Backquote" => "`",
        "CapsLock" => "Caps Lock",
        "Space" => "Space",
        other => other,
    }
    .into()
}
