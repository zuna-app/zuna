//! The Telegram account linked on this device (docs/TELEGRAM_PLAN.md): linking it, which its
//! dialog follows step by step, and unlinking it. Once linked it's a rail icon like a server's,
//! under the server ID `telegram`, whose session answers the same calls.

use super::*;
use crate::telegram::SERVER_ID;

impl AppState {
    /// Whether this build can link an account, and none is linked yet.
    pub fn can_link_telegram(&self) -> bool {
        crate::telegram::available() && !self.servers.contains_key(SERVER_ID)
    }

    /// Starts linking, from the dialog's first screen: the engine starts, and the steps come as events.
    pub fn link_telegram(&mut self, cx: &mut Context<Self>) {
        self.telegram_link = Some(TelegramLink { step: "starting".into(), ..Default::default() });
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            if let Err(error) = core.call(None, "linkTelegram", vec![]).await {
                this.update(cx, |state, cx| {
                    state.telegram_link = Some(TelegramLink { step: "failed".into(), reason: error.message, ..Default::default() });
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        cx.notify();
    }

    /// Starts linking over from nothing: TDLib takes no phone number once it has shown a QR code,
    /// so moving from the code to a number begins again, with nothing linked to lose.
    pub fn restart_telegram_link(&mut self, cx: &mut Context<Self>) {
        self.telegram_link = Some(TelegramLink { step: "starting".into(), ..Default::default() });
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            core.call(None, "unlinkTelegram", vec![]).await.ok();
            let linked = core.call(None, "linkTelegram", vec![]).await;
            this.update(cx, |state, cx| {
                if let Err(error) = linked {
                    state.telegram_link = Some(TelegramLink { step: "failed".into(), reason: error.message, ..Default::default() });
                } else if state.telegram_link.as_ref().is_none_or(|link| link.step == "unlinked") {
                    state.telegram_link = Some(TelegramLink { step: "starting".into(), ..Default::default() });
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Unlinks the account: it's signed out at Telegram if it can be, and everything of it here is
    /// erased either way. Also what cancelling a link half done does.
    pub fn unlink_telegram(&mut self, cx: &mut Context<Self>) {
        let core = self.core.clone();
        let linked = self.servers.contains_key(SERVER_ID);
        cx.spawn(async move |this, cx| {
            let result = core.call(None, "unlinkTelegram", vec![]).await;
            this.update(cx, |state, cx| {
                if state.servers.contains_key(SERVER_ID) {
                    state.remove_server(SERVER_ID, cx);
                }
                state.telegram_link = None;
                match result {
                    Ok(value) if linked && value.get("signedOut").and_then(Value::as_bool) != Some(true) => state.toast(
                        "Telegram was unlinked here, but Telegram couldn't be told. End Zuna's session in Telegram's app, under Devices.",
                        ToastKind::Info,
                        cx,
                    ),
                    Ok(_) => {}
                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A step of linking, or the account's going.
    pub(super) fn telegram_moved(&mut self, link: TelegramLink, cx: &mut Context<Self>) {
        match link.step.as_str() {
            "ready" => {
                self.telegram_link = None;
                if !self.servers.contains_key(SERVER_ID) {
                    self.add_server(SERVER_ID.into(), cx);
                }
            }
            "unlinked" => {
                // Ended from another device, or unlinked here: what it held is gone. A link begun
                // over, from the QR code to a phone number, has nothing in the rail to take away.
                if self.servers.contains_key(SERVER_ID) {
                    if self.telegram_link.is_none() && !matches!(self.overlay, Some(Overlay::Telegram)) {
                        self.toast("Your Telegram session was ended, so Telegram was unlinked here.", ToastKind::Info, cx);
                    }
                    self.remove_server(SERVER_ID, cx);
                }
                self.telegram_link = None;
            }
            // While it's being linked, the dialog follows. Once it is, a step here means it
            // stopped working, which its rail shows.
            _ if self.servers.contains_key(SERVER_ID) => {
                if link.step == "failed" {
                    self.toast(link.reason.clone(), ToastKind::Error, cx);
                }
            }
            _ => self.telegram_link = Some(link),
        }
        cx.notify();
    }
}
