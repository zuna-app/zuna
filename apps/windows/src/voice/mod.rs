//! Voice channels and calls (packages/ui/src/voice): which channel this device is in,
//! who's speaking, and coming into a channel.

use gpui::{App, Entity, Window};

use crate::models::{ChannelView, VoiceMember};
use crate::state::{AppState, ToastKind};

/// The server and channel this device is in, if any.
pub fn connected_channel(_cx: &App) -> Option<(String, String)> {
    None
}

/// Whether someone in a channel is speaking, as far as this device hears them.
pub fn is_speaking(_server_id: &str, _member: &VoiceMember, _cx: &App) -> bool {
    false
}

/// Opens a channel from the list: a text channel to read, a voice channel to come into, as in Discord.
pub fn open_channel(state: &Entity<AppState>, channel: &ChannelView, _window: &mut Window, cx: &mut App) {
    let key = channel.key.clone();
    let voice = channel.kind == "voice";
    state.update(cx, |state, cx| {
        state.select_conversation(Some(key), cx);
        if voice {
            let ready = state.active().and_then(|server| server.info.as_ref()).is_some_and(|info| info.voice.is_some_and(|voice| voice > 0.));
            if !ready {
                state.toast("This server has no media server yet, so its voice channels can't be joined.", ToastKind::Info, cx);
            }
        }
    });
}
