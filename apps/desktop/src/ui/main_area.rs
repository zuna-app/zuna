//! The window's main area beside the rail: the sidebar and the chat, a signed-out server's
//! notice, and the toasts and dialogs over them.

use super::*;

impl Root {
    /// A plugin's page over the main area: its title, whose it is, and the app's close button,
    /// around what the plugin draws.
    fn plugin_page(&mut self, handle: u32, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let (title, uid) = plugins::title(handle, cx).unwrap_or_default();
        let body = plugins::body(handle, cx);
        let state = self.state.clone();
        let scroll = scrollbar::scroll_handle("plugin-page");
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(56.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .px(px(20.))
                    .border_b_1()
                    .border_color(theme.line)
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).one_line().child(title)).child(plugins::plugin_name(&uid, cx)))
                    .child(icon_button("close-plugin-page", "x", 17., false, false, cx).on_click(move |_, _, cx| {
                        state.update(cx, |state, cx| {
                            state.plugin_page = None;
                            cx.notify();
                        })
                    })),
            )
            .child(div().id("plugin-page").flex_1().min_h_0().overflow_y_scroll().track_scroll(&scroll).p(px(24.)).child(body))
            .into_any_element()
    }

    pub(super) fn main_area(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        // Only what's needed past the borrow, not the whole server, as this draws every frame.
        let Some(server) = state.active() else { return div().into_any_element() };
        let entry = server.entry.clone();
        let conversation = server.active_conversation().map(|conversation| conversation.key.clone());
        let channel = server.active_channel().map(|channel| (channel.id.clone(), channel.kind == "voice"));
        if let Some(reason) = entry.signed_out.clone() {
            return self.signed_out(&entry, &reason, cx).into_any_element();
        }
        // A voice channel this device is in shows its stage, as in Discord.
        // A plugin's page, opened from its item in the rail, in place of the chat.
        if let Some(handle) = state.plugin_page {
            return self.plugin_page(handle, cx);
        }
        let in_this_voice = channel.as_ref().is_some_and(|(id, voice)| *voice && crate::voice::connected_channel(cx).is_some_and(|(server_id, channel_id)| server_id == entry.id && &channel_id == id));
        if let (true, Some((channel_id, _))) = (in_this_voice, &channel) {
            let key = format!("{}:{}", entry.id, channel_id);
            if self.stage.as_ref().map(|(current, _)| current != &key).unwrap_or(true) {
                let state = self.state.clone();
                let room = voice_stage::StageRoom { server_id: entry.id.clone(), id: channel_id.clone(), call: false };
                self.stage = Some((key, cx.new(|cx| voice_stage::VoiceStage::new(state, room, cx))));
            }
            return self.stage.as_ref().unwrap().1.clone().into_any_element();
        }
        self.stage = None;
        match conversation {
            Some(conversation) => {
                let key = format!("{}:{}", entry.id, conversation);
                if self.chat.as_ref().map(|(current, _)| current != &key).unwrap_or(true) {
                    let state = self.state.clone();
                    let view = cx.new(|cx| chat::ChatView::new(state, entry.id.clone(), conversation.clone(), window, cx));
                    self.chat = Some((key, view));
                }
                // Not cached: GPUI draws every cached view inside a cached view that has to be
                // drawn again, and this one is on every keystroke, so its message list is cached
                // instead.
                self.chat.as_ref().unwrap().1.clone().into_any_element()
            }
            None => {
                self.chat = None;
                if channel.is_some() {
                    return div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(div().flex().flex_col().items_center().gap(px(6.)).text_color(theme.text2).child(spinner(22., theme.text2)).child("Getting the keys to this channel…"))
                        .into_any_element();
                }
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(6.))
                            .p(px(30.))
                            .text_color(theme.text2)
                            .child(div().mb(px(8.)).child(icon("message-circle", 28., theme.text3)))
                            .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(entry.name.clone()))
                            .child("Pick someone from the list to start talking.")
                            .child({
                                // A linked Telegram account's chats aren't, and the line says who keeps them.
                                let (mark, line) = if entry.is_telegram() {
                                    ("cloud", "Not end-to-end encrypted. Telegram keeps these messages.")
                                } else {
                                    ("lock", "Everything here is end-to-end encrypted")
                                };
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .mt(px(4.))
                                    .text_size(px(12.5))
                                    .text_color(theme.text3)
                                    .child(icon(mark, 12., theme.text3))
                                    .child(line)
                            }),
                    )
                    .into_any_element()
            }
        }
    }

    pub(super) fn signed_out(&self, entry: &crate::models::ServerEntry, reason: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let name = entry.name.clone();
        let title = match reason {
            "banned" => format!("You were removed from {name}"),
            "account_deleted" => format!("Your account on {name} was deleted"),
            _ => format!("You're signed out of {name}"),
        };
        let why = match reason {
            "device_revoked" => "This device was removed from your account.",
            "banned" => "Its admins ended your access.",
            "account_deleted" => "It was deleted from another of your devices.",
            _ => "The server ended this device's session.",
        };
        // An account that's gone can't be signed in to again.
        let can_sign_in = reason != "banned" && reason != "account_deleted";
        let state = self.state.clone();
        let address = entry.address.clone();
        let remove_state = self.state.clone();
        let id = entry.id.clone();
        div().flex_1().flex().items_center().justify_center().child(
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .max_w(px(460.))
                .text_color(theme.text2)
                .text_center()
                .child(div().mb(px(8.)).child(icon("log-out", 28., theme.text3)))
                .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(title))
                .child(if reason == "account_deleted" {
                    format!("{why} What's on this device stays here for 30 days, or until you remove it.")
                } else {
                    format!("{why} What's on this device stays here for 30 days, or until you sign in again or remove it.")
                })
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .mt(px(8.))
                        .when(can_sign_in, |el| {
                            el.child(button("sign-in-again", ButtonKind::Primary, ButtonSize::Normal, false, cx).child("Sign in again").on_click(move |_, _, cx| {
                                state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::AddServer { link: None, sign_in_url: Some(address.clone()) }), cx))
                            }))
                        })
                        .child(button("remove-server", ButtonKind::Default, ButtonSize::Normal, false, cx).child("Remove from this device").on_click(move |_, _, cx| {
                            let id = id.clone();
                            remove_state.update(cx, |state, cx| {
                                state.call(None, "leaveServer", vec![serde_json::json!(id.clone())], cx, move |state, _, cx| state.remove_server(&id, cx))
                            })
                        })),
                ),
        )
    }

    pub(super) fn toasts(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let current = self.state.read(cx).toasts.clone();
        // A dismissed toast stays where it was while it sinks away, and new ones go below.
        let now = std::time::Instant::now();
        let out = if motion::reduced_or_system() { std::time::Duration::ZERO } else { TOAST_OUT };
        for (toast, gone) in &mut self.toast_list {
            if gone.is_none() && !current.iter().any(|shown| shown.id == toast.id) {
                *gone = Some(now);
            }
        }
        self.toast_list.retain(|(_, gone)| gone.is_none_or(|gone| now - gone < out));
        for toast in current {
            if !self.toast_list.iter().any(|(shown, _)| shown.id == toast.id) {
                self.toast_list.push((toast, None));
            }
        }
        if self.toast_list.iter().any(|(_, gone)| gone.is_some()) {
            window.request_animation_frame();
        }
        let toasts = self.toast_list.clone();
        div()
            .absolute()
            .bottom(px(20.))
            .left_0()
            .right_0()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .children(toasts.into_iter().map(|(toast, gone)| {
                let (bg, border) = match toast.kind {
                    ToastKind::Error => (theme::color(theme::hex(0x2f1f20)), theme::color(theme::rgba(242, 85, 90, 0.35))),
                    ToastKind::Security => (theme::color(theme::hex(0x2e2615)), theme::color(theme::rgba(229, 165, 10, 0.35))),
                    ToastKind::Info => (theme.bg4, theme.line_strong),
                };
                let state = self.state.clone();
                let id = toast.id;
                let toast_el = div()
                    .id(gpui::ElementId::Name(format!("toast-{id}").into()))
                    .max_w(px(480.))
                    .bg(bg)
                    .border_1()
                    .border_color(border)
                    .px(px(12.))
                    .py(px(8.))
                    .rounded(RADIUS_M)
                    .shadow(shadow_m())
                    .text_size(px(13.))
                    .text_color(theme.text1)
                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.dismiss_toast(id, cx)))
                    .child(toast.message);
                match gone {
                    Some(gone) => {
                        let left = 1. - gone.elapsed().as_secs_f32() / TOAST_OUT.as_secs_f32();
                        toast_el.occlude().leave(Enter::Rise(10.), left).into_any_element()
                    }
                    None => toast_el.enter(gpui::ElementId::Name(format!("toast-in-{id}").into()), Enter::Rise(14.), 220).into_any_element(),
                }
            }))
    }

    pub(super) fn overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let wanted = self.state.read(cx).overlay.clone();
        let Some(wanted) = wanted else {
            self.close_overlay();
            self.close_settings();
            return None;
        };
        if matches!(wanted, crate::state::Overlay::Settings { .. } | crate::state::Overlay::ServerSettings { .. }) {
            if self.settings.as_ref().map(|(shown, _)| shown != &wanted).unwrap_or(true) {
                let state = self.state.clone();
                let view: gpui::AnyView = match wanted.clone() {
                    crate::state::Overlay::Settings { section } => cx.new(|cx| settings::SettingsView::new(state, section, window, cx)).into(),
                    crate::state::Overlay::ServerSettings { section } => cx.new(|cx| server_settings::ServerSettings::new(state, section, window, cx)).into(),
                    _ => unreachable!(),
                };
                self.settings = Some((wanted.clone(), view));
                self.settings_closing = None;
            }
            return None;
        }
        self.close_settings();
        if self.overlay.as_ref().map(|(current, _)| current != &wanted).unwrap_or(true) {
            self.close_overlay();
            let view = overlays::open(&wanted, self.state.clone(), window, cx);
            self.overlay = view.map(|view| (wanted.clone(), view));
        }
        self.overlay.as_ref().map(|(_, view)| view.clone().into_any_element())
    }
}
