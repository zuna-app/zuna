//! Sharing a screen from a voice channel or a call (startScreen and stopScreen in
//! packages/ui/src/voice/store.ts).

use gpui::Context;

use super::{ToastKind, Voice};

/// What's running for a share: the native program and the computer's sound beside it.
#[derive(Default)]
pub struct ShareHandles {}

impl Voice {
    pub(super) fn stop_share_handles(&mut self) {
        self.share = ShareHandles::default();
    }

    /// Stops what this device is sharing, if anything.
    pub fn stop_screen(&mut self, cx: &mut Context<Self>) {
        if self.screen.take().is_none() {
            return;
        }
        self.stop_share_handles();
        cx.notify();
    }

    /// This device's screen share has been stopped: by an admin, or by a change to the rules.
    pub fn on_screen_ended(&mut self, server_id: &str, channel_id: &str, reason: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) || self.screen.is_none() {
            return;
        }
        self.stop_screen(cx);
        self.toast(if reason == "stopped" { "An admin stopped your screen share." } else { "This server's rules changed, so your screen share stopped." }, ToastKind::Info, cx);
    }
}
