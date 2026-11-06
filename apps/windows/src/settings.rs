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
    /// The conversation list's width, which the desktop keeps apart.
    pub list_width: f32,
    /// Channel headings folded away, by name.
    pub collapsed_categories: Vec<String>,
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
            list_width: 320.,
            collapsed_categories: Vec::new(),
        }
    }
}

fn path() -> std::path::PathBuf {
    crate::host::data_dir().join("settings.json")
}

impl Settings {
    pub fn load() -> Settings {
        std::fs::read(path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    pub fn save(&self) {
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            std::fs::create_dir_all(crate::host::data_dir()).ok();
            std::fs::write(path(), json).ok();
        }
    }
}
