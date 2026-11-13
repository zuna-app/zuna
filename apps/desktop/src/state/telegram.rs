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

    /// Deletes a Telegram message for everyone where Telegram allows it, and otherwise for this
    /// account alone, saying so.
    pub fn delete_telegram_message(&mut self, group: String, id: String, cx: &mut Context<Self>) {
        let core = self.core.clone();
        // Saved messages are the account's alone, so there are no others to keep a message for.
        let saved = self.servers.get(SERVER_ID).is_some_and(|server| server.self_id() == group);
        cx.spawn(async move |this, cx| {
            let choices = core.call(Some(SERVER_ID), "deleteChoices", vec![json!(group), json!(id)]).await.unwrap_or_default();
            let everyone = choices.get("forEveryone").and_then(Value::as_bool) == Some(true);
            let alone = choices.get("forSelf").and_then(Value::as_bool) == Some(true);
            let result = if everyone || alone { Some(core.call(Some(SERVER_ID), "deleteMessages", vec![json!(group), json!([id]), json!(everyone)]).await) } else { None };
            this.update(cx, |state, cx| match result {
                None => state.toast("Telegram doesn't let this message be deleted.", ToastKind::Info, cx),
                Some(Err(error)) => state.toast(error.message, ToastKind::Error, cx),
                Some(Ok(_)) if !everyone && !saved => state.toast("Deleted for you alone: Telegram keeps it for the others.", ToastKind::Info, cx),
                Some(Ok(_)) => {}
            })
            .ok();
        })
        .detach();
    }

    /// Presses a bot's button in a Telegram chat, and shows what the bot answers, if anything.
    pub fn press_telegram_button(&mut self, group: String, message: String, row: usize, column: usize, cx: &mut Context<Self>) {
        let call = self.core.call(Some(SERVER_ID), "pressButton", vec![json!(group), json!(message), json!(row), json!(column)]);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |state, cx| match result {
                Ok(Value::String(answer)) if !answer.is_empty() => state.toast(answer, ToastKind::Info, cx),
                Ok(_) => {}
                Err(error) => state.toast(error.message, ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    /// Joins a Telegram group by a link to it, and opens it.
    pub fn join_telegram_group(&mut self, link: String, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        let call = self.core.call(Some(SERVER_ID), "joinByLink", vec![json!(link)]);
        cx.spawn(async move |this, cx| {
            let chat = call.await.map_err(|error| error.message)?;
            let chat = chat.as_str().unwrap_or_default().to_string();
            this.update(cx, |state, cx| {
                state.select_server(SERVER_ID, cx);
                state.select_conversation(Some(format!("group:{chat}")), cx);
                state.set_overlay(None, cx);
            })
            .ok();
            Ok(())
        })
    }

    /// Keeps what's written in a Telegram chat as its draft there, which the account's other devices show.
    /// Telegram is told once typing pauses, of what's written then.
    pub fn save_telegram_draft(&mut self, key: String, cx: &mut Context<Self>) {
        self.debounced(format!("telegram-draft:{key}"), 1500, cx, move |state, cx| {
            let text = state.drafts.get(&key).cloned().unwrap_or_default();
            let call = state.core.call(Some(SERVER_ID), "saveDraft", vec![json!(key), json!(text)]);
            cx.spawn(async move |_, _| {
                call.await.ok();
            })
            .detach();
        });
    }

    /// Takes Telegram's draft for a chat that has none here, as written on another device.
    pub fn load_telegram_draft(&mut self, key: String, cx: &mut Context<Self>) -> Task<Option<String>> {
        let call = (!self.drafts.contains_key(&key)).then(|| self.core.call(Some(SERVER_ID), "getDraft", vec![json!(key)]));
        cx.spawn(async move |_, _| {
            let text = call?.await.ok()?.as_str()?.to_string();
            (!text.is_empty()).then_some(text)
        })
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
