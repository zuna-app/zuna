//! This device's appearance and notification settings (packages/ui/src/state/settings.ts),
//! kept in a file beside the app's data.

use serde::{Deserialize, Serialize};

use crate::theme::{Accent, TextSize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub accent: Accent,
    pub message_size: TextSize,
    pub notifications: bool,
    pub notification_sound: bool,
    pub notification_preview: String,
    pub close_to_tray: bool,
    pub reduce_motion: bool,
    pub enter_to_send: bool,
    pub link_previews: bool,
    pub remove_metadata: bool,
    /// This device may contact YouTube to play a video a voice channel or a call watches together, which its person agreed to once.
    pub play_youtube: bool,
    /// The conversation list's width, which the web keeps apart.
    pub list_width: f32,
    /// Channel headings folded away, by name.
    pub collapsed_categories: Vec<String>,
    /// A channel's member list stays open or closed across channels, as in Discord.
    pub hide_member_list: bool,
    /// How fast voice messages play, one of `media::VOICE_SPEEDS`, the same for all of them as in Telegram.
    pub voice_speed: f64,
    /// Which releases this app updates itself from, `stable` or `nightly`, once the person has
    /// picked. Until then it's the channel the build was made for.
    pub update_channel: Option<String>,
    /// A plugin's theme, as `<plugin uid>/<theme id>`, which applies while that plugin is on.
    pub theme: Option<String>,
    /// The SOCKS5 proxy everything this device sends goes through, for every server on it
    /// (host/net.rs). Its password is sealed apart, as the device key is (`PROXY_PASSWORD`).
    pub proxy: ProxySetting,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxySetting {
    /// Everything goes through it, or it's kept here unused.
    pub on: bool,
    pub host: String,
    pub port: u16,
    /// Empty when the proxy takes nobody's name.
    pub username: String,
}

/// What the proxy's password is kept as, in the app's data folder.
const PROXY_PASSWORD: &str = "proxy-password";

impl ProxySetting {
    /// The proxy to go through, with its password, while it's on.
    pub fn in_use(&self) -> Option<crate::host::net::Proxy> {
        if !self.on || self.host.trim().is_empty() || self.port == 0 {
            return None;
        }
        let password = if self.username.is_empty() { None } else { Self::kept_password() };
        Some(crate::host::net::Proxy { host: self.host.trim().to_string(), port: self.port, username: self.username.clone(), password: password.unwrap_or_default() })
    }

    /// The proxy's password, as it's kept.
    pub fn kept_password() -> Option<String> {
        crate::host::device_key::unseal(&crate::host::data_dir(), PROXY_PASSWORD, crate::host::device_key::PROXY_PASSWORD).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Keeps the proxy's password, or forgets it when there's none.
    pub fn keep_password(password: &str) -> std::io::Result<()> {
        let dir = crate::host::data_dir();
        if password.is_empty() {
            crate::host::device_key::forget(&dir, PROXY_PASSWORD, crate::host::device_key::PROXY_PASSWORD);
            return Ok(());
        }
        crate::host::device_key::seal(&dir, PROXY_PASSWORD, crate::host::device_key::PROXY_PASSWORD, password.as_bytes())
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            accent: Accent::Neutral,
            message_size: TextSize::Medium,
            notifications: true,
            notification_sound: true,
            notification_preview: "full".into(),
            close_to_tray: true,
            reduce_motion: false,
            enter_to_send: true,
            link_previews: true,
            remove_metadata: true,
            play_youtube: false,
            list_width: 320.,
            collapsed_categories: Vec::new(),
            hide_member_list: false,
            voice_speed: 1.,
            update_channel: None,
            theme: None,
            proxy: ProxySetting::default(),
        }
    }
}

fn path() -> std::path::PathBuf {
    crate::host::data_dir().join("settings.json")
}

impl Settings {
    pub fn load() -> Settings {
        let Ok(bytes) = std::fs::read(path()) else { return Settings::default() };
        serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!("settings.json couldn't be read, so every setting is back to its default: {error}");
            Settings::default()
        })
    }

    pub fn save(&self) {
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            std::fs::create_dir_all(crate::host::data_dir()).ok();
            if let Err(error) = crate::host::write_whole(&path(), &json) {
                log::warn!("couldn't save the settings: {error}");
            }
        }
    }
}
