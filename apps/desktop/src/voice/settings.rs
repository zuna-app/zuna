//! How this device does voice (packages/ui/src/voice/settings.ts). These stay on this
//! device, since which microphone and how loud are about the room it's in.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::ScreenRules;

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
    pub screen_fps: Option<u32>,
    pub screen_bitrate: Option<u32>,
    pub screen_height: Option<u32>,
    pub screen_cursor: bool,
    pub screen_sound_by_default: bool,
    pub screen_sound_kbps: u32,
    /// "h264", or "av1", which is experimental: only the native app opens it under encryption.
    pub screen_codec: String,
    pub screen_encoder: String,
    pub screen_effort: String,
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
            screen_fps: None,
            screen_bitrate: None,
            screen_height: None,
            screen_cursor: true,
            screen_sound_by_default: true,
            screen_sound_kbps: 128,
            screen_codec: "h264".into(),
            screen_encoder: "auto".into(),
            screen_effort: "balanced".into(),
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

pub const SCREEN_HEIGHTS: [u32; 6] = [2160, 1440, 1080, 720, 480, 360];
pub const SCREEN_RATES: [u32; 13] = [5, 10, 15, 24, 30, 45, 60, 75, 90, 120, 144, 165, 240];
pub const SCREEN_BITRATES: [u32; 17] = [1_000, 2_000, 3_000, 4_500, 6_000, 8_000, 10_000, 12_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000, 60_000, 80_000, 100_000];
pub const SCREEN_SOUND_BITRATES: [u32; 7] = [64, 96, 128, 160, 192, 256, 320];

pub fn height_name(height: u32) -> String {
    match height {
        0 => "The screen's own".into(),
        2160 => "4K (2160p)".into(),
        _ => format!("{height}p"),
    }
}

pub fn rate_name(fps: u32) -> String {
    format!("{fps} fps")
}

pub fn bitrate_name(kbps: u32) -> String {
    if kbps >= 1000 {
        let mbit = kbps as f64 / 1000.;
        if mbit.fract() == 0. { format!("{} Mbit/s", mbit as u32) } else { format!("{mbit} Mbit/s") }
    } else {
        format!("{kbps} kbit/s")
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
    if rules.max_sound_kbps > 0 {
        limits.push(format!("{} of sound", bitrate_name(rules.max_sound_kbps)));
    }
    (!limits.is_empty()).then(|| format!("This server holds shares to {}.", limits.join(", ")))
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
