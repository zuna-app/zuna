//! The stage's header, and its bar of controls.

use super::*;

impl VoiceStage {
    pub(super) fn controls(&mut self, share_refusal: Option<&'static str>, sounds: bool, chat_unread: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let voice = self.voice.read(cx);
        let mic_off = voice.mic_off();
        let (deafened, camera, sharing, open, server_muted, no_mic) = (voice.deafened, voice.camera, voice.screen.is_some(), voice.open, voice.server_muted, voice.no_mic);
        let control = |id: &'static str, icon_name: &'static str, color: gpui::Hsla, bg: gpui::Hsla, label: String, disabled: bool| {
            let key = format!("control-{id}");
            crate::ui::motion::track_hover(named_div(id), key.clone())
                .relative()
                .size(px(44.))
                .flex_none()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(bg)
                .when(!disabled, |el| el.cursor_pointer())
                // `.voice-control:hover`: bg-4 over 100 ms, which a lit one keeps its color through.
                .when(!disabled && bg == theme.bg3, |el| el.child(crate::ui::motion::hover_layer(&key, theme.bg4, px(22.), 100)))
                .when(disabled, |el| el.opacity(0.55))
                .tip(label, Side::Top)
                .child(icon(icon_name, 20., color))
        };
        let group = |id: &'static str, more: &'static str, off: bool, main: gpui::Stateful<gpui::Div>, input: bool, voice: Entity<Voice>, state: Entity<AppState>| {
            div()
                .id(id)
                .flex()
                .items_center()
                .h(px(44.))
                .overflow_hidden()
                .rounded(px(22.))
                .bg(if off { theme.red_soft } else { theme.bg3 })
                .child(main)
                .child(
                    crate::ui::motion::track_hover(div().id(more), format!("control-{more}"))
                        .group(more)
                        .relative()
                        .flex()
                        .items_center()
                        .justify_center()
                        .pl(px(5.))
                        .pr(px(15.))
                        .h_full()
                        // GPUI clips to a rectangle, not the pill's rounding, so each half rounds its own end.
                        .rounded_r(px(22.))
                        .cursor_pointer()
                        .child(crate::ui::motion::hover_layer_corners(&format!("control-{more}"), theme.hover_strong, gpui::Corners { top_left: px(0.), bottom_left: px(0.), top_right: px(22.), bottom_right: px(22.) }, 100))
                        .on_click(move |event, _, cx| device_menu(&voice, &state, input, event.position(), cx))
                        .child(icon("chevron-up", 14., theme.text2).group_hover(more, move |style| style.text_color(theme.text1))),
                )
        };
        let pill = |id: &'static str, icon_name: &'static str, color: gpui::Hsla, label: String, disabled: bool| {
            let key = format!("control-{id}");
            crate::ui::motion::track_hover(div().id(id), key.clone())
                .relative()
                .flex()
                .items_center()
                .h_full()
                .pl(px(15.))
                .pr(px(5.))
                .rounded_l(px(22.))
                .when(!disabled, |el| el.cursor_pointer().child(crate::ui::motion::hover_layer_corners(&key, theme.hover_strong, gpui::Corners { top_left: px(22.), bottom_left: px(22.), top_right: px(0.), bottom_right: px(0.) }, 100)))
                .when(disabled, |el| el.opacity(0.55))
                .tip(label, Side::Top)
                .child(icon(icon_name, 20., color))
        };
        let mic_label = if server_muted { t("voice.controls.adminMuted") } else if no_mic { t("voice.controls.noMic") } else if mic_off { t("voice.controls.unmute") } else { t("voice.controls.mute") };
        let mic_color = if mic_off { theme.red } else if open { theme.green } else { theme.text1 };
        let (mute, deafen, cam, share, leave) = (self.voice.clone(), self.voice.clone(), self.voice.clone(), self.voice.clone(), self.voice.clone());
        let picker = self.state.clone();
        let mic_group = group("mic-group", "mic-more", mic_off, pill("mic-control", if mic_off { "mic-off" } else { "mic" }, mic_color, mic_label.into(), server_muted || no_mic).on_click(move |_, _, cx| mute.update(cx, |voice, cx| voice.toggle_mute(cx))), true, self.voice.clone(), self.state.clone());
        let deafen_group = group("deafen-group", "deafen-more", deafened, pill("deafen-control", if deafened { "headphone-off" } else { "headphones" }, if deafened { theme.red } else { theme.text1 }, if deafened { t("voice.controls.undeafen").into() } else { t("voice.controls.deafen").into() }, false).on_click(move |_, _, cx| deafen.update(cx, |voice, cx| voice.toggle_deafen(cx))), false, self.voice.clone(), self.state.clone());
        let mut bar = div()
            .flex_none()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .pt(px(6.))
            .px(px(12.))
            .pb(px(if self.room.call { 10. } else { 14. }))
            .child(mic_group)
            .child(deafen_group);
        // A Telegram call has the camera and a shared screen, from where one can be sent into it,
        // and nothing Telegram's calls haven't: no soundboard, nothing watched together.
        let telegram = self.room.server_id == crate::voice::telegram::TELEGRAM;
        let can_share = voice.can_share();
        bar = bar.child(control("camera-control", if camera { "camera" } else { "camera-off" }, if camera { theme.on_accent } else { theme.text1 }, if camera { theme.accent } else { theme.bg3 }, if camera { t("voice.controls.cameraOff").into() } else { t("voice.controls.cameraOn").into() }, false).on_click(move |_, _, cx| cam.update(cx, |voice, cx| voice.toggle_camera(cx))));
        if can_share {
            bar = bar.child(
                control("share-control", if sharing { "monitor-off" } else { "monitor-up" }, if sharing { theme.on_accent } else { theme.text1 }, if sharing { theme.accent } else { theme.bg3 }, if sharing { t("voice.controls.stopSharing").into() } else { share_refusal.unwrap_or(t("voice.controls.shareScreen")).into() }, !sharing && share_refusal.is_some()).on_click(move |_, _, cx| {
                    if sharing {
                        share.update(cx, |voice, cx| voice.stop_screen(cx));
                    } else if share_refusal.is_none() {
                        picker.update(cx, |state, cx| state.set_overlay(Some(Overlay::ScreenPicker), cx));
                    }
                }),
            );
        }
        if !telegram {
            bar = bar.child(crate::ui::soundboard::soundboard_button(&self.state, &self.voice, sounds, cx));
            // A video to watch together, from a link, once this device may contact YouTube.
            let (watch_on, allowed) = { let voice = self.voice.read(cx); (voice.watch.is_some(), voice.watch_allowed(cx)) };
            let watch_label = if !allowed { t("voice.watch.off") } else if watch_on { t("voice.watch.another") } else { t("voice.watch.title") };
            let watch_state = self.state.clone();
            bar = bar.child(
                control("watch-control", "clapperboard", if watch_on { theme.on_accent } else { theme.text1 }, if watch_on { theme.accent } else { theme.bg3 }, watch_label.into(), !allowed).on_click(move |_, _, cx| {
                    if !allowed {
                        return;
                    }
                    let overlay = if watch_state.read(cx).settings.play_youtube { Overlay::WatchLink } else { Overlay::WatchConsent { then_link: true } };
                    watch_state.update(cx, |state, cx| state.set_overlay(Some(overlay), cx));
                }),
            );
        }
        if !self.room.call {
            let chat_open = self.chat_open;
            bar = bar.child(
                control("chat-control", "message-square", if chat_open { theme.on_accent } else { theme.text1 }, if chat_open { theme.accent } else { theme.bg3 }, if chat_open { t("voice.controls.hideChat").into() } else { t("voice.controls.showChat").into() }, false)
                    .when(chat_unread && !chat_open, |el| el.child(div().absolute().top(px(10.)).right(px(10.)).size(px(8.)).rounded_full().bg(theme.text1).border_2().border_color(theme.bg3)))
                    .on_click(cx.listener(|stage, _, _, cx| {
                        stage.chat_open = !stage.chat_open;
                        cx.notify();
                    })),
            );
        }
        bar.child(
            crate::ui::motion::track_hover(named_div("leave-control"), "leave-control".into())
                .relative()
                .w(px(56.))
                .h(px(44.))
                .flex_none()
                .rounded(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.red)
                .cursor_pointer()
                .child(crate::ui::motion::hover_layer("leave-control", theme::color(theme::hex(0xd9444a)), px(22.), 100))
                .tip(t("voice.controls.disconnect"), Side::Top)
                .on_click(move |_, _, cx| leave.update(cx, |voice, cx| voice.leave(cx)))
                .child(icon("phone-off", 20., gpui::white())),
        )
        .into_any_element()
    }

    pub(super) fn header(&self, title: &str, topic: &str, call_started: Option<f64>, ring_again: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let encrypted = |text: &'static str| {
            div()
                .id("voice-e2ee")
                .flex()
                .items_center()
                .gap(px(4.))
                .px(px(8.))
                .py(px(3.))
                .rounded(px(99.))
                .bg(theme.bg2)
                .text_size(px(12.))
                .text_color(theme.text2)
                .tip(text, Side::Bottom)
                .child(icon("lock", 12., theme.text2))
                .child(t("voice.stage.encrypted"))
        };
        let stats_open = self.voice.read(cx).stats_open;
        let stats_voice = self.voice.clone();
        let stats = icon_button("voice-stats", "activity", 15., true, stats_open, cx).tip(t("voice.statsPanel.title"), Side::Bottom).on_click(move |_, _, cx| {
            stats_voice.update(cx, |voice, cx| {
                voice.stats_open = !voice.stats_open;
                cx.notify();
            })
        });
        if self.room.call {
            let voice = self.voice.clone();
            let expanded = self.expanded;
            // A Telegram call is Telegram's, never said to be Zuna's end-to-end encryption: its key
            // is checked by the four emoji, as in Telegram's own apps, and by nothing of Zuna's.
            let telegram = self.room.server_id == crate::voice::telegram::TELEGRAM;
            let emoji = self.voice.read(cx).telegram_call().map(|call| (call.emoji.join(" "), call.user_id.clone())).filter(|(emoji, _)| !emoji.is_empty());
            let label = if telegram {
                let name = emoji.as_ref().and_then(|(_, user)| self.state.read(cx).servers.get(&self.room.server_id).and_then(|server| server.users.get(user)).map(|user| user.display_name.clone())).unwrap_or_else(|| t("common.someone").into());
                let hint = tr!("telegram.call.emojiHint", name = name);
                named_div("telegram-call-label")
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(99.))
                    .bg(theme.bg2)
                    .text_size(px(12.))
                    .text_color(theme.text2)
                    .when(emoji.is_some(), |el| el.tip(hint, Side::Bottom))
                    .child(t("telegram.call.label"))
                    .when_some(emoji.map(|(emoji, _)| emoji), |el, emoji| el.child(div().text_size(px(14.)).child(emoji)))
                    .into_any_element()
            } else {
                encrypted(t("voice.stage.encryptedCall")).into_any_element()
            };
            return div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(10.))
                .h(px(40.))
                .child(label)
                .when_some(call_started, |el, started| {
                    let seconds = ((crate::format::now_ms() - started) / 1000.).max(0.) as u64;
                    let (hours, minutes, seconds) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60);
                    el.child(div().text_size(px(12.)).text_color(theme.text3).child(if hours > 0 { format!("{hours}:{minutes:02}:{seconds:02}") } else { format!("{minutes}:{seconds:02}") }))
                })
                .child(div().flex_1())
                .when(ring_again, |el| el.child(icon_button("ring-again", "bell-ring", 15., true, false, cx).tip(t("voice.stage.ringAgain"), Side::Bottom).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.ring_again(cx)))))
                .child(stats)
                .child(icon_button("call-expand", if expanded { "chevrons-down-up" } else { "chevrons-up-down" }, 15., true, false, cx).tip(if expanded { t("voice.stage.showChat") } else { t("voice.stage.hideChat") }, Side::Bottom).on_click(cx.listener(|stage, _, _, cx| {
                    stage.expanded = !stage.expanded;
                    cx.notify();
                })))
                .into_any_element();
        }
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(14.))
            .h(px(52.))
            .border_b_1()
            .border_color(theme.line)
            .child(icon("volume-2", 18., theme.text3))
            .child(div().flex_none().max_w(gpui::relative(0.45)).one_line().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child(title.to_string()))
            .when(!topic.is_empty(), |el| el.child(div().min_w_0().one_line().border_l_1().border_color(theme.line_strong).pl(px(10.)).text_size(px(13.)).text_color(theme.text3).child(topic.to_string())))
            .child(div().flex_1())
            .child(encrypted(t("voice.stage.encryptedChannel")))
            .child(stats)
            .into_any_element()
    }
}
