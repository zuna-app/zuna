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
        parts
    }
}
