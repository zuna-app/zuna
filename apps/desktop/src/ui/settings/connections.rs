//! Connections: accounts elsewhere that Zuna uses on this device, which is Telegram, linked here
//! and unlinked here (docs/TELEGRAM_PLAN.md). Nothing about them reaches a Zuna server.

use super::*;
use crate::telegram::SERVER_ID;

impl SettingsView {
    pub(super) fn connections(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let linked = state.servers.get(SERVER_ID).map(|server| {
            let me = server.users.get(server.self_id());
            match me {
                Some(me) if !me.username.is_empty() => format!("Linked as {} (@{}).", me.display_name, me.username),
                Some(me) => format!("Linked as {}.", me.display_name),
                None => "Linked.".to_string(),
            }
        });
        let available = crate::telegram::available();
        let mut parts = vec![
            Self::heading("Connections", &theme),
            Self::lead("Other accounts Zuna can use on this device. Your servers never learn about them.".into(), &theme),
        ];
        let control = match (&linked, available) {
            (Some(_), _) if self.confirming_unlink => div()
                .flex()
                .gap(px(8.))
                .child(button("tg-unlink-cancel", ButtonKind::Ghost, ButtonSize::Small, false, cx).child("Cancel").on_click(cx.listener(|view, _, _, cx| {
                    view.confirming_unlink = false;
                    cx.notify();
                })))
                .child(button("tg-unlink-confirm", ButtonKind::Danger, ButtonSize::Small, false, cx).child("Unlink").on_click(cx.listener(|view, _, _, cx| {
                    view.confirming_unlink = false;
                    view.state.update(cx, |state, cx| state.unlink_telegram(cx));
                    cx.notify();
                })))
                .into_any_element(),
            (Some(_), _) => button("tg-unlink", ButtonKind::Danger, ButtonSize::Small, false, cx)
                .child("Unlink")
                .on_click(cx.listener(|view, _, _, cx| {
                    view.confirming_unlink = true;
                    cx.notify();
                }))
                .into_any_element(),
            (None, true) => button("tg-connect", ButtonKind::Primary, ButtonSize::Small, false, cx)
                .child("Connect")
                .on_click(cx.listener(|view, _, _, cx| view.state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Telegram), cx))))
                .into_any_element(),
            (None, false) => div().into_any_element(),
        };
        let hint = match (&linked, available) {
            (Some(_), _) if self.confirming_unlink => "Zuna will sign out of Telegram and erase its chats from this device. Everything stays in Telegram's own apps.".to_string(),
            (Some(text), _) => format!("{text} These chats aren't end-to-end encrypted: Telegram keeps them on its servers."),
            (None, true) => "Read and send your Telegram messages here. Zuna signs in as another device using Telegram's API. Zuna isn't made by Telegram.".to_string(),
            (None, false) => "This build of Zuna can't use Telegram: it was built without an api_id from Telegram.".to_string(),
        };
        parts.push(Self::row("Telegram", Some(&hint), control, &theme));
        parts
    }
}
