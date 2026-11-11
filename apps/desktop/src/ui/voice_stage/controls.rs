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
            crate::ui::motion::track_hover(div().id(id), key.clone())
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
        let mic_label = if server_muted { "An admin muted you" } else if no_mic { "No microphone" } else if mic_off { "Unmute" } else { "Mute" };
        let mic_color = if mic_off { theme.red } else if open { theme.green } else { theme.text1 };
        let (mute, deafen, cam, share, leave) = (self.voice.clone(), self.voice.clone(), self.voice.clone(), self.voice.clone(), self.voice.clone());
        let picker = self.state.clone();
        let mic_group = group("mic-group", "mic-more", mic_off, pill("mic-control", if mic_off { "mic-off" } else { "mic" }, mic_color, mic_label.into(), server_muted || no_mic).on_click(move |_, _, cx| mute.update(cx, |voice, cx| voice.toggle_mute(cx))), true, self.voice.clone(), self.state.clone());
        let deafen_group = group("deafen-group", "deafen-more", deafened, pill("deafen-control", if deafened { "headphone-off" } else { "headphones" }, if deafened { theme.red } else { theme.text1 }, if deafened { "Undeafen".into() } else { "Deafen".into() }, false).on_click(move |_, _, cx| deafen.update(cx, |voice, cx| voice.toggle_deafen(cx))), false, self.voice.clone(), self.state.clone());
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
        bar = bar
            .child(control("camera-control", if camera { "camera" } else { "camera-off" }, if camera { theme.on_accent } else { theme.text1 }, if camera { theme.accent } else { theme.bg3 }, if camera { "Turn off camera".into() } else { "Turn on camera".into() }, false).on_click(move |_, _, cx| cam.update(cx, |voice, cx| voice.toggle_camera(cx))))
            .child(
                control("share-control", if sharing { "monitor-off" } else { "monitor-up" }, if sharing { theme.on_accent } else { theme.text1 }, if sharing { theme.accent } else { theme.bg3 }, if sharing { "Stop sharing".into() } else { share_refusal.unwrap_or("Share your screen").into() }, !sharing && share_refusal.is_some()).on_click(move |_, _, cx| {
                    if sharing {
                        share.update(cx, |voice, cx| voice.stop_screen(cx));
                    } else if share_refusal.is_none() {
                        picker.update(cx, |state, cx| state.set_overlay(Some(Overlay::ScreenPicker), cx));
                    }
                }),
            )
            .child(crate::ui::soundboard::soundboard_button(&self.state, &self.voice, sounds, cx));
        // A video to watch together, from a link, once this device may contact YouTube.
        let (watch_on, allowed) = { let voice = self.voice.read(cx); (voice.watch.is_some(), voice.watch_allowed(cx)) };
        let watch_label = if !allowed { "Watching together is off in this channel" } else if watch_on { "Another video" } else { "Watch together" };
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
        if !self.room.call {
            let chat_open = self.chat_open;
            bar = bar.child(
                control("chat-control", "message-square", if chat_open { theme.on_accent } else { theme.text1 }, if chat_open { theme.accent } else { theme.bg3 }, if chat_open { "Hide chat".into() } else { "Show chat".into() }, false)
                    .when(chat_unread && !chat_open, |el| el.child(div().absolute().top(px(10.)).right(px(10.)).size(px(8.)).rounded_full().bg(theme.text1).border_2().border_color(theme.bg3)))
                    .on_click(cx.listener(|stage, _, _, cx| {
                        stage.chat_open = !stage.chat_open;
                        cx.notify();
                    })),
            );
        }
        bar.child(
            crate::ui::motion::track_hover(div().id("leave-control"), "leave-control".into())
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
                .tip("Disconnect", Side::Top)
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
                .child("Encrypted")
        };
        let stats_open = self.voice.read(cx).stats_open;
        let stats_voice = self.voice.clone();
        let stats = icon_button("voice-stats", "activity", 15., true, stats_open, cx).tip("Stream stats", Side::Bottom).on_click(move |_, _, cx| {
            stats_voice.update(cx, |voice, cx| {
                voice.stats_open = !voice.stats_open;
                cx.notify();
            })
        });
        if self.room.call {
            let voice = self.voice.clone();
            let expanded = self.expanded;
            return div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(10.))
                .h(px(40.))
                .child(encrypted("End-to-end encrypted, with keys from this conversation's members. The server and the media server can't listen in or watch."))
                .when_some(call_started, |el, started| {
                    let seconds = ((crate::format::now_ms() - started) / 1000.).max(0.) as u64;
                    let (hours, minutes, seconds) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60);
                    el.child(div().text_size(px(12.)).text_color(theme.text3).child(if hours > 0 { format!("{hours}:{minutes:02}:{seconds:02}") } else { format!("{minutes}:{seconds:02}") }))
                })
                .child(div().flex_1())
                .when(ring_again, |el| el.child(icon_button("ring-again", "bell-ring", 15., true, false, cx).tip("Ring everyone who isn't here", Side::Bottom).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.ring_again(cx)))))
                .child(stats)
                .child(icon_button("call-expand", if expanded { "chevrons-down-up" } else { "chevrons-up-down" }, 15., true, false, cx).tip(if expanded { "Show the chat" } else { "Hide the chat" }, Side::Bottom).on_click(cx.listener(|stage, _, _, cx| {
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
            .child(encrypted("End-to-end encrypted, with keys from this channel's members. The server and the media server can't listen in or watch."))
            .child(stats)
            .into_any_element()
    }
}
