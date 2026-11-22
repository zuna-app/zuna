//! Connections: every server on this device, and the accounts elsewhere that Zuna uses on it,
//! which is Telegram, linked here and unlinked here (docs/TELEGRAM_PLAN.md). Nothing about those
//! reaches a Zuna server.

use super::*;
use crate::telegram::SERVER_ID;

impl SettingsView {
    pub(super) fn connections(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let mut parts = vec![Self::heading(t("settings.connections.title"), &theme), Self::lead(t("settings.connections.intro").into(), &theme)];
        parts.extend(self.server_list(cx));
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading(t("settings.connections.otherAccounts")));
        parts.push(div().mt(px(-8.)).text_size(px(12.5)).text_color(theme.text2).child(t("settings.connections.otherAccountsHint")).into_any_element());
        parts.push(self.telegram_row(cx));
        if self.state.read(cx).servers.contains_key(SERVER_ID) && !self.confirming_unlink {
            // Its own settings, under it.
            parts.push(div().pl(px(ACCOUNT_INDENT)).child(self.telegram_icon_row(cx)).into_any_element());
            parts.push(div().pl(px(ACCOUNT_INDENT)).child(self.telegram_calls_row(cx)).into_any_element());
        }
        parts
    }

    /// Every server on this device, in the rail's order, with its icon, name, address and
    /// version, or how its connection stands, and Leave, which asks first.
    fn server_list(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let servers: Vec<_> = state.order.iter().filter_map(|id| state.servers.get(id)).filter(|server| !server.entry.is_telegram()).cloned().collect();
        let mut parts = vec![Self::subheading(t("settings.connections.servers"))];
        for server in &servers {
            let entry = &server.entry;
            let image = if entry.has_icon {
                let url = format!("{}/api/icon", entry.url);
                self.state.update(cx, |state, cx| state.remote_picture(&url, cx))
            } else {
                None
            };
            let picture = avatar(AvatarProps { name: entry.name.clone(), seed: entry.url.clone(), image, size: ACCOUNT_PICTURE, online: false, rounded: true, dot_border: theme.bg_chat }, cx).into_any_element();
            let status = if entry.signed_out.is_some() {
                div().child(t("settings.connections.signedOut")).into_any_element()
            } else if let Some(status) = connection_status(server, &theme) {
                status.into_any_element()
            } else {
                div().child(server.info.as_ref().map(|info| tr!("settings.connections.serverVersion", version = info.version)).unwrap_or_default()).into_any_element()
            };
            let address = entry.url.strip_prefix("https://").unwrap_or(&entry.url).to_string();
            let (state, server_id) = (self.state.clone(), entry.id.clone());
            let leave = button(SharedString::from(format!("leave-server-{}", entry.id)), ButtonKind::Danger, ButtonSize::Small, false, cx)
                .child(t("settings.connections.leave"))
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::LeaveServer { server_id: server_id.clone(), from_section: Some("connections".into()) }), cx)));
            let right = div().flex().items_center().gap(px(14.)).child(div().text_size(px(12.5)).text_color(theme.text3).child(status)).child(leave);
            parts.push(account_row(format!("connection-server-{}", entry.id), picture, entry.name.clone(), address, true, right.into_any_element(), &theme));
        }
        parts
    }

    /// The Telegram account: linked, as whom and how its connection stands, with Unlink, or
    /// Connect where this build can link one.
    fn telegram_row(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let telegram = state.servers.get(SERVER_ID).cloned();
        let picture = crate::ui::rail::telegram_icon_view(state.telegram_icon.clone(), ACCOUNT_PICTURE, cx);
        let available = crate::telegram::available();
        // What's said of the account linked, whole, with what it means for its chats.
        let linked = telegram.as_ref().map(|server| match server.users.get(server.self_id()) {
            Some(me) if !me.username.is_empty() => tr!("settings.connections.linkedAsWithUsername", name = me.display_name, username = me.username),
            Some(me) => tr!("settings.connections.linkedAs", name = me.display_name),
            None => t("settings.connections.linked").to_string(),
        });
        let control = match (&telegram, available) {
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
            (Some(server), _) => {
                let status = connection_status(server, &theme).unwrap_or_else(|| div().flex().items_center().gap(px(6.)).text_color(theme.text2).child(div().size(px(6.)).rounded_full().bg(theme.green)).child(t("settings.connections.connected")));
                div()
                    .flex()
                    .items_center()
                    .gap(px(14.))
                    .child(status.text_size(px(12.5)))
                    .child(button("tg-unlink", ButtonKind::Danger, ButtonSize::Small, false, cx).child(t("settings.connections.unlink")).on_click(cx.listener(|view, _, _, cx| {
                        view.confirming_unlink = true;
                        cx.notify();
                    })))
                    .into_any_element()
            }
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
        account_row("connection-telegram".into(), picture, "Telegram".into(), hint, false, control, &theme)
    }

    /// The account's icon in the rail, as its right click there offers too: the icon on the left,
    /// and a picture of one's own, or the default drawing back (`choose_telegram_icon` in
    /// `state/telegram.rs`).
    fn telegram_icon_row(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let image = self.state.read(cx).telegram_icon.clone();
        let custom = image.is_some();
        let control = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .when(custom, |el| {
                el.child(button("tg-icon-reset", ButtonKind::Default, ButtonSize::Small, false, cx).child(t("servers.rail.resetIcon")).on_click(cx.listener(|view, _, _, cx| {
                    view.state.update(cx, |state, cx| state.reset_telegram_icon(cx));
                })))
            })
            .child(button("tg-icon-change", ButtonKind::Default, ButtonSize::Small, false, cx).child(t("servers.rail.changeIcon")).on_click(cx.listener(|view, _, _, cx| {
                view.state.update(cx, |state, cx| state.choose_telegram_icon(cx));
            })));
        div()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(crate::ui::rail::telegram_icon_view(image, ACCOUNT_PICTURE, cx))
            .child(div().flex_1().min_w_0().child(Self::row(t("settings.connections.telegramIcon"), Some(t("settings.connections.telegramIconHint")), control, &theme)))
            .into_any_element()
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

/// How big a server's or an account's picture is in the list, and how far its own settings are
/// set in under it, to line up with its name.
const ACCOUNT_PICTURE: f32 = 32.;
const ACCOUNT_INDENT: f32 = ACCOUNT_PICTURE + 12.;

/// A server or an account in the list: its picture, its name with a line under it, and what's
/// on the right. An address stays on one line, and what's said of an account wraps.
fn account_row(id: String, picture: AnyElement, name: String, hint: String, one_line: bool, right: AnyElement, theme: &Theme) -> AnyElement {
    named_div(SharedString::from(id))
        .flex()
        .items_center()
        .gap(px(12.))
        .py(px(8.))
        .text_size(px(14.))
        .child(picture)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().font_weight(FontWeight::MEDIUM).truncate().child(name))
                .when(!hint.is_empty(), |el| el.child(div().mt(px(1.)).text_size(px(12.5)).text_color(theme.text2).when(one_line, |el| el.truncate()).child(hint))),
        )
        .child(div().flex_none().child(right))
        .into_any_element()
}
