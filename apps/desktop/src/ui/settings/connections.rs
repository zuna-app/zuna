//! Connections: accounts elsewhere that Zuna uses on this device, which is Telegram, linked here
//! and unlinked here (docs/TELEGRAM_PLAN.md). Nothing about them reaches a Zuna server.

use super::*;
use crate::telegram::SERVER_ID;

impl SettingsView {
    pub(super) fn connections(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let state = self.state.read(cx);
        // What's said of the account linked, whole, with what it means for its chats.
        let linked = state.servers.get(SERVER_ID).map(|server| {
            let me = server.users.get(server.self_id());
            match me {
                Some(me) if !me.username.is_empty() => tr!("settings.connections.linkedAsWithUsername", name = me.display_name, username = me.username),
                Some(me) => tr!("settings.connections.linkedAs", name = me.display_name),
                None => t("settings.connections.linked").to_string(),
            }
        });
        let available = crate::telegram::available();
        let mut parts = vec![
            Self::heading(t("settings.connections.title"), &theme),
            Self::lead(t("settings.connections.lead").into(), &theme),
        ];
        let control = match (&linked, available) {
            (Some(_), _) if self.confirming_unlink => div()
                .flex()
                .gap(px(8.))
                .child(button("tg-unlink-cancel", ButtonKind::Ghost, ButtonSize::Small, false, cx).child(t("common.cancel")).on_click(cx.listener(|view, _, _, cx| {
                    view.confirming_unlink = false;
                    cx.notify();
                })))
                .child(button("tg-unlink-confirm", ButtonKind::Danger, ButtonSize::Small, false, cx).child(t("settings.connections.unlink")).on_click(cx.listener(|view, _, _, cx| {
                    view.confirming_unlink = false;
                    view.state.update(cx, |state, cx| state.unlink_telegram(cx));
                    cx.notify();
                })))
                .into_any_element(),
            (Some(_), _) => button("tg-unlink", ButtonKind::Danger, ButtonSize::Small, false, cx)
                .child(t("settings.connections.unlink"))
                .on_click(cx.listener(|view, _, _, cx| {
                    view.confirming_unlink = true;
                    cx.notify();
                }))
                .into_any_element(),
            (None, true) => button("tg-connect", ButtonKind::Primary, ButtonSize::Small, false, cx)
                .child(t("settings.connections.connect"))
                .on_click(cx.listener(|view, _, _, cx| view.state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Telegram), cx))))
                .into_any_element(),
            (None, false) => div().into_any_element(),
        };
        let hint = match (&linked, available) {
            (Some(_), _) if self.confirming_unlink => t("settings.connections.unlinkHint").to_string(),
            (Some(text), _) => text.clone(),
            (None, true) => t("settings.connections.connectHint").to_string(),
            (None, false) => t("settings.connections.unavailable").to_string(),
        };
        parts.push(Self::row("Telegram", Some(&hint), control, &theme));
        if linked.is_some() && !self.confirming_unlink {
            parts.push(self.telegram_calls_row(cx));
        }
        parts
    }

    /// "Take Telegram calls on this device": Telegram's own "Accept calls" for this session, so
    /// it's the same switch wherever it's turned. Off, no Telegram call rings here, and calls can
    /// still be made from here.
    fn telegram_calls_row(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        if self.telegram_calls.is_none() && !self.asking_telegram_calls {
            self.asking_telegram_calls = true;
            let call = self.state.read(cx).core.call(Some(SERVER_ID), "takesCalls", vec![]);
            cx.spawn(async move |view, cx| {
                let result = call.await;
                view.update(cx, |view, cx| {
                    view.asking_telegram_calls = false;
                    view.telegram_calls = Some(result.ok().and_then(|value| value.as_bool()).unwrap_or(true));
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        let on = self.telegram_calls.unwrap_or(true);
        let control = switch("telegram-calls", on, cx).when(self.telegram_calls.is_none(), |el| el.opacity(0.55)).on_click(cx.listener(move |view, _, _, cx| {
            if view.telegram_calls.is_none() {
                return;
            }
            view.telegram_calls = Some(!on);
            cx.notify();
            let call = view.state.read(cx).core.call(Some(SERVER_ID), "setTakesCalls", vec![json!(!on)]);
            cx.spawn(async move |view, cx| {
                if let Err(error) = call.await {
                    view.update(cx, |view, cx| {
                        view.telegram_calls = Some(on);
                        view.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
                        cx.notify();
                    })
                    .ok();
                }
            })
            .detach();
        }));
        Self::row(t("settings.connections.telegramCalls"), Some(t("settings.connections.telegramCallsHint")), control, &theme)
    }
}
