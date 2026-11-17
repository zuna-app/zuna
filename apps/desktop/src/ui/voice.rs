//! What voice puts around the app: the panel at the bottom of the sidebar while in a voice
//! channel or a call (VoicePanel.tsx), calls ringing over everything (IncomingCalls.tsx),
//! and a conversation's call buttons and banner (CallButtons and CallBanner in ChatView.tsx).


use gpui::{AnyElement, App, Entity, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::components::*;
use super::motion::{Enter, Motion};
use crate::i18n::t;
use crate::models::ConversationView;
use crate::state::{AppState, Overlay};
use crate::theme::{self, RADIUS_L, RADIUS_M, RADIUS_S};
use crate::voice::room::Quality;
use crate::voice::{self, JoinHow, Voice, VoiceStatus};

/// A colour part of the way to another, as CSS's `color-mix` gives it.
pub fn mix(over: gpui::Hsla, base: gpui::Hsla, amount: f32) -> gpui::Hsla {
    let (a, b) = (over.to_rgb(), base.to_rgb());
    theme::color(gpui::Rgba { r: b.r + (a.r - b.r) * amount, g: b.g + (a.g - b.g) * amount, b: b.b + (a.b - b.b) * amount, a: 1. })
}

fn quality_icon(voice: &Voice, cx: &App) -> AnyElement {
    let theme = theme(cx);
    let (name, color, words) = match voice.quality {
        Quality::Poor => ("signal-low", theme.amber, t("voice.quality.weak")),
        Quality::Lost => ("signal-low", theme.red, t("voice.quality.lost")),
        Quality::Good => ("signal-medium", theme.green, t("voice.quality.good")),
        Quality::Excellent => ("signal", theme.green, t("voice.quality.great")),
        Quality::Unknown => ("signal", theme.green, t("voice.quality.connected")),
    };
    let text = match voice.rtt {
        Some(rtt) => tr!("voice.panel.quality", quality = words, rtt = rtt),
        None => words.to_string(),
    };
    div().id("voice-quality").flex().tip(text, Side::Top).child(icon(name, 14., color)).into_any_element()
}

/// Stays at the bottom of the sidebar while in a voice channel or a call, wherever else the person is.
pub fn voice_panel(state: &Entity<AppState>, voice_entity: &Entity<Voice>, cx: &mut App) -> Option<AnyElement> {
    let theme = theme(cx);
    let voice = voice_entity.read(cx);
    if voice.status == VoiceStatus::Idle {
        return None;
    }
    let server_id = voice.server_id.clone()?;
    let channel_id = voice.channel_id.clone()?;
    let app = state.read(cx);
    // Borrowed, and only what's shown taken out of it: this draws every frame of a call.
    let server = app.servers.get(&server_id)?;
    let server_name = server.entry.name.clone();
    let channel = server.channels.iter().find(|item| item.id == channel_id).cloned();
    let conversation = if voice.call { voice::conversation_of_group(server, &channel_id).cloned() } else { None };
    let me = server.users.get(server.self_id()).cloned();
    let share_refusal = voice::rules::screen_refusal(server.info.as_ref().and_then(|info| info.screen_share.as_ref()), server.me.as_ref().map(|me| me.role.as_str()).unwrap_or(""), if voice.call { 0. } else { channel.as_ref().map(|channel| channel.screen_limit).unwrap_or(0.) });
    let mic_off = voice.mic_off();
    let speaking = voice.self_speaking();
    let status_text = match voice.status {
        VoiceStatus::Connected if voice.call => t("voice.panel.callConnected"),
        VoiceStatus::Connected => t("voice.panel.voiceConnected"),
        VoiceStatus::Reconnecting => t("voice.panel.reconnecting"),
        _ => t("voice.panel.connecting"),
    };
    let where_text = if voice.call { conversation.as_ref().map(|item| item.title.clone()).unwrap_or_else(|| t("voice.panel.call").into()) } else { channel.as_ref().map(|item| item.name.clone()).unwrap_or_else(|| t("voice.panel.voiceChannel").into()) };
    let status_color = if voice.status == VoiceStatus::Connected { theme.green } else { theme.amber };
    let self_line = if voice.server_muted {
        t("voice.panel.adminMuted").to_string()
    } else if voice.no_mic {
        t("voice.controls.noMic").to_string()
    } else if voice.settings.input_mode == "ptt" {
        if voice.settings.ptt_key.is_empty() {
            t("voice.panel.setKey").into()
        } else {
            let key = voice.key_bound.clone().unwrap_or_else(|| voice::settings::key_name(&voice.settings.ptt_key));
            if voice.key_held { tr!("voice.panel.holding", key = key) } else { tr!("voice.panel.hold", key = key) }
        }
    } else {
        t("voice.settings.voiceActivity").to_string()
    };
    let (camera, sharing, deafened, server_muted, no_mic, can_share) = (voice.camera, voice.screen.is_some(), voice.deafened, voice.server_muted, voice.no_mic, voice.can_share());
    let status_icon = if voice.status == VoiceStatus::Connected { quality_icon(voice, cx) } else { spinner(12., status_color).into_any_element() };
    let key = conversation.as_ref().map(|item| item.key.clone()).or_else(|| channel.as_ref().map(|item| item.key.clone()));
    let go = {
        let (state, server_id) = (state.clone(), server_id.clone());
        move |_: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut App| {
            state.update(cx, |state, cx| {
                state.select_server(&server_id, cx);
                state.select_conversation(key.clone(), cx);
            })
        }
    };
    let action = |id: &'static str, on: bool, icon_name: &'static str, label: String, disabled: bool| {
        div()
            .id(id)
            .flex_1()
            .min_w_0()
            .h(px(30.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(RADIUS_S)
            .bg(if on { theme.accent_soft } else { theme.bg3 })
            .when(!disabled, |el| el.cursor_pointer().hover(move |style| if on { style } else { style.bg(theme.bg4) }))
            .when(disabled, |el| el.opacity(0.55))
            .tip(label, Side::Top)
            .child(icon(icon_name, 16., if on { theme.green } else { theme.text1 }))
    };
    let (voice_for_camera, voice_for_share, voice_for_leave, voice_for_mute, voice_for_deafen) = (voice_entity.clone(), voice_entity.clone(), voice_entity.clone(), voice_entity.clone(), voice_entity.clone());
    let picker_state = state.clone();
    let settings_state = state.clone();
    Some(
        div()
            .flex_none()
            .border_t_1()
            .border_color(theme.line)
            .bg(theme.bg2)
            .pt(px(8.))
            .px(px(8.))
            .pb(px(6.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div()
                            .id("voice-panel-where")
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .px(px(4.))
                            .py(px(2.))
                            .rounded(RADIUS_S)
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.hover))
                            .on_click(go)
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(5.))
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(status_color)
                                    .child(status_icon)
                                    .child(status_text)
                                    .child(div().id("voice-panel-lock").tip(t("voice.panel.encrypted"), Side::Top).child(icon("lock", 11., theme.text3))),
                            )
                            .child(div().one_line().text_size(px(12.)).text_color(theme.text3).child(format!("{where_text} / {server_name}"))),
                    )
                    .child(
                        div()
                            .id("voice-leave")
                            .size(px(32.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_M)
                            .group("voice-leave")
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.red_soft))
                            .tip(t("voice.controls.disconnect"), Side::Top)
                            .on_click(move |_, _, cx| voice_for_leave.update(cx, |voice, cx| voice.leave(cx)))
                            // `.icon-btn.voice-leave`: text-2, and red under the pointer.
                            .child(icon("phone-off", 17., theme.text2).group_hover("voice-leave", move |style| style.text_color(theme.red))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(action("voice-camera", camera, if camera { "camera" } else { "camera-off" }, if camera { t("voice.controls.cameraOff").into() } else { t("voice.controls.cameraOn").into() }, false).on_click(move |_, _, cx| voice_for_camera.update(cx, |voice, cx| voice.toggle_camera(cx))))
                    .when(can_share, |el| {
                        el.child(
                            action("voice-share", sharing, if sharing { "monitor-off" } else { "monitor-up" }, if sharing { t("voice.controls.stopSharing").into() } else { share_refusal.unwrap_or(t("voice.controls.shareScreen")).to_string() }, !sharing && share_refusal.is_some()).on_click(move |_, _, cx| {
                                if sharing {
                                    voice_for_share.update(cx, |voice, cx| voice.stop_screen(cx));
                                } else if share_refusal.is_none() {
                                    picker_state.update(cx, |state, cx| state.set_overlay(Some(Overlay::ScreenPicker), cx));
                                }
                            }),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .pl(px(4.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .line_height(gpui::relative(1.2))
                            .child(div().one_line().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(me.map(|me| me.display_name).unwrap_or_else(|| t("common.you").into())))
                            .child(div().one_line().text_size(px(11.5)).text_color(theme.text3).child(self_line)),
                    )
                    .child(small_toggle("voice-mute", if mic_off { "mic-off" } else { "mic" }, if mic_off { Some(theme.red) } else if speaking { Some(theme.green) } else { None }, if server_muted { t("voice.controls.adminMuted") } else if mic_off { t("voice.controls.unmute") } else { t("voice.controls.mute") }, server_muted || no_mic, cx).on_click(move |_, _, cx| voice_for_mute.update(cx, |voice, cx| voice.toggle_mute(cx))))
                    .child(small_toggle("voice-deafen", if deafened { "headphone-off" } else { "headphones" }, deafened.then_some(theme.red), if deafened { t("voice.controls.undeafen") } else { t("voice.controls.deafen") }, false, cx).on_click(move |_, _, cx| voice_for_deafen.update(cx, |voice, cx| voice.toggle_deafen(cx))))
                    .child(small_toggle("voice-settings", "settings", None, t("voice.controls.settings"), false, cx).on_click(move |_, _, cx| settings_state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Settings { section: Some("voice".into()) }), cx)))),
            )
            .into_any_element(),
    )
}

/// A small icon button in the panel: red when something's off, green when it's live.
fn small_toggle(id: &'static str, icon_name: &'static str, color: Option<gpui::Hsla>, label: &'static str, disabled: bool, cx: &App) -> gpui::Stateful<gpui::Div> {
    let theme = theme(cx);
    let red = color == Some(theme.red);
    // `.icon-btn.is-small`: text-2, or red or green, and text-1 under the pointer unless it's red.
    div()
        .id(id)
        .group(id)
        .size(px(26.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(RADIUS_S)
        .when(!disabled, |el| el.cursor_pointer().hover(move |style| style.bg(if red { theme.red_soft } else { theme.hover_strong })))
        .when(disabled, |el| el.opacity(0.55))
        .tip(label, Side::Top)
        .child(icon(icon_name, 16., color.unwrap_or(theme.text2)).when(!disabled && !red, |el| el.group_hover(id, move |style| style.text_color(theme.text1))))
}

/// Calls ringing this person, wherever in the app they are.
pub fn incoming_calls(state: &Entity<AppState>, voice_entity: &Entity<Voice>, cx: &mut App) -> Option<AnyElement> {
    let theme = theme(cx);
    let voice = voice_entity.read(cx);
    let incoming = voice::incoming_calls(state.read(cx), voice.server_id.as_deref(), voice.channel_id.as_deref());
    if incoming.is_empty() {
        return None;
    }
    let several = state.read(cx).servers.len() > 1;
    let mut column = div().absolute().top(px(12.)).left_0().right_0().flex().flex_col().items_center().gap(px(8.)).occlude();
    for item in incoming {
        let server = state.read(cx).servers.get(&item.server_id).cloned();
        let caller = server.as_ref().and_then(|server| server.users.get(&item.call.started_by)).map(|user| user.display_name.clone()).unwrap_or_else(|| t("common.someone").into());
        let what = if item.conversation.kind == "dm" { t("notify.callingYou").to_string() } else { tr!("notify.startedCall", name = caller) };
        // A Telegram call says so after the name, as its notifications do.
        let title = if item.server_id == crate::voice::telegram::TELEGRAM { tr!("notifications.telegramTitle", title = item.conversation.title) } else { item.conversation.title.clone() };
        let several = several && item.server_id != crate::voice::telegram::TELEGRAM;
        let image = item.conversation.avatar.clone().and_then(|avatar| {
            let server_id = item.server_id.clone();
            state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        let id = SharedString::from(format!("{}:{}", item.server_id, item.call.group_id));
        let answer = |camera: bool| {
            let (state, voice, item) = (state.clone(), voice_entity.clone(), item.clone());
            move |_: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut App| {
                state.update(cx, |state, cx| {
                    state.select_server(&item.server_id, cx);
                    state.select_conversation(Some(item.conversation.key.clone()), cx);
                });
                voice.update(cx, |voice, cx| voice.join(item.server_id.clone(), item.call.group_id.clone(), None, JoinHow { camera, ..Default::default() }, cx));
            }
        };
        let decline = {
            let (voice, server_id, group_id) = (voice_entity.clone(), item.server_id.clone(), item.call.group_id.clone());
            move |_: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut App| voice.update(cx, |voice, cx| voice.decline(&server_id, &group_id, cx))
        };
        let round = |name: &str, bg: gpui::Hsla, fg: gpui::Hsla, icon_name: &'static str, label: &'static str| {
            div()
                .id(SharedString::from(format!("{id}-{name}")))
                .size(px(38.))
                .flex_none()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(bg)
                .cursor_pointer()
                .hover(move |style| style.opacity(0.9))
                .tip(label, Side::Top)
                .child(icon(icon_name, 18., fg))
        };
        column = column.child(
            div()
                .w(px(380.))
                .flex()
                .items_center()
                .gap(px(10.))
                .p(px(12.))
                .rounded(RADIUS_L)
                .bg(theme.bg3)
                .border_1()
                .border_color(theme.line_strong)
                .shadow(shadow_l())
                .child(
                    div().child(avatar(AvatarProps { name: item.conversation.title.clone(), seed: item.conversation.peer_id.clone().or(item.conversation.group_id.clone()).unwrap_or_default(), image, size: 48., online: false, rounded: false, dot_border: theme.bg3 }, cx)).map(|ring| super::motion::pulse(ring, SharedString::from(format!("{id}-pulse")), 1600, |el, delta| el.opacity(1. - 0.3 * (1. - (delta * 2. - 1.).abs())))),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(1.))
                        .child(div().one_line().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(title))
                        .child(div().one_line().text_size(px(12.5)).text_color(theme.text2).child(format!("{what}{}", if several { server.map(|server| format!(" · {}", server.entry.name)).unwrap_or_default() } else { String::new() }))),
                )
                .child(round("decline", theme.red, gpui::white(), "phone-off", t("voice.incoming.decline")).on_click(decline))
                .child(round("video", theme.bg5, theme.text1, "video", t("voice.incoming.answerVideo")).on_click(answer(true)))
                .child(round("answer", theme.green, gpui::white(), "phone", t("voice.incoming.answer")).on_click(answer(false)))
                // `.incoming-call`: rise-in 0.14s.
                .enter(SharedString::from(format!("{id}-in")), Enter::Rise(5.), 140),
        );
    }
    Some(column.into_any_element())
}

/// The card that asks how a Telegram call was, when Telegram asks (`need_rating`): one to five
/// stars, and under five which of Telegram's problems it had. It can be closed.
pub fn telegram_rating(voice_entity: &Entity<Voice>, cx: &mut App) -> Option<AnyElement> {
    let theme = theme(cx);
    let rating = voice_entity.read(cx).telegram_rating.clone()?;
    let stars = rating.stars.unwrap_or(0);
    let mut row = div().flex().items_center().gap(px(2.));
    for star in 1..=5u8 {
        let voice = voice_entity.clone();
        row = row.child(
            named_div(SharedString::from(format!("rate-{star}")))
                .p(px(3.))
                .rounded(RADIUS_S)
                .cursor_pointer()
                .hover(move |style| style.bg(theme.hover))
                .child(icon("star", 22., if star <= stars { theme.amber } else { theme.text3 }))
                .on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.rate_stars(star, cx))),
        );
    }
    let close = {
        let voice = voice_entity.clone();
        icon_button("rate-close", "x", 15., true, false, cx).tip(t("common.close"), Side::Top).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.dismiss_rating(cx)))
    };
    let mut card = div()
        .w(px(380.))
        .flex()
        .flex_col()
        .gap(px(10.))
        .p(px(12.))
        .rounded(RADIUS_L)
        .bg(theme.bg3)
        .border_1()
        .border_color(theme.line_strong)
        .shadow(shadow_l())
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().flex_1().min_w_0().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(tr!("telegram.call.rateTitle", name = rating.name)))
                .child(close),
        )
        .child(row);
    if stars > 0 && stars < 5 {
        let mut chips = div().flex().flex_wrap().gap(px(6.));
        for (problem, key) in crate::voice::telegram::PROBLEMS {
            let chosen = rating.problems.contains(problem);
            let voice = voice_entity.clone();
            chips = chips.child(
                named_div(SharedString::from(format!("rate-problem-{problem}")))
                    .px(px(9.))
                    .py(px(4.))
                    .rounded(px(99.))
                    .text_size(px(12.5))
                    .cursor_pointer()
                    .bg(if chosen { theme.accent } else { theme.bg2 })
                    .text_color(if chosen { theme.on_accent } else { theme.text2 })
                    .child(t(key))
                    .on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.toggle_problem(problem, cx))),
            );
        }
        let voice = voice_entity.clone();
        card = card
            .child(div().text_size(px(12.5)).text_color(theme.text2).child(t("telegram.call.rateWhatWasWrong")))
            .child(chips)
            .child(div().flex().justify_end().child(button("rate-send", ButtonKind::Primary, ButtonSize::Small, false, cx).child(t("telegram.call.rateSend")).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.send_rating(cx)))));
    }
    Some(div().absolute().bottom(px(16.)).left_0().right_0().flex().justify_center().occlude().child(card.enter("telegram-rating-in", Enter::Rise(5.), 140)).into_any_element())
}

/// Who's in a conversation's call, each person once.
pub fn call_people(state: &AppState, server_id: &str, conversation: &ConversationView) -> Vec<String> {
    let Some(group) = &conversation.group_id else { return Vec::new() };
    let mut people = Vec::new();
    if let Some(server) = state.servers.get(server_id) {
        let mut members: Vec<_> = server.voice.values().filter(|member| &member.channel_id == group).collect();
        members.sort_by(|a, b| a.since.total_cmp(&b.since));
        for member in members {
            if !people.contains(&member.user_id) {
                people.push(member.user_id.clone());
            }
        }
    }
    people
}

/// Starting a call, or joining the one going on, from a conversation's header.
pub fn call_buttons(state: &Entity<AppState>, server_id: &str, conversation: &ConversationView, cx: &mut App) -> Option<AnyElement> {
    let theme = theme(cx);
    let voice_entity = voice::get(cx)?;
    let app = state.read(cx);
    let server = app.servers.get(server_id)?;
    let peer_banned = conversation.peer_id.as_ref().and_then(|peer| server.users.get(peer)).is_some_and(|user| user.banned || user.deleted);
    let is_saved = conversation.peer_id.as_deref() == Some(server.self_id());
    // A Telegram chat with a person can be called, as Telegram says when it's tried.
    let telegram = server_id == crate::voice::telegram::TELEGRAM;
    let servers_calls = telegram || server.info.as_ref().is_some_and(|info| info.calls.is_some_and(|calls| calls > 0.));
    let calls_here = servers_calls && !is_saved && voice::can_call(conversation, server.self_id(), peer_banned) && (!telegram || conversation.kind == "dm");
    let voice = voice_entity.read(cx);
    let in_call = conversation.group_id.is_some() && voice.status != VoiceStatus::Idle && voice.server_id.as_deref() == Some(server_id) && voice.channel_id == conversation.group_id;
    if !calls_here || in_call {
        return None;
    }
    let going = !call_people(app, server_id, conversation).is_empty();
    if going {
        let group = conversation.group_id.clone()?;
        let server_id = server_id.to_string();
        return Some(
            button("call-join", ButtonKind::Default, ButtonSize::Small, false, cx)
                .text_color(theme.green)
                .tip(t("voice.call.joinTitle"), Side::Bottom)
                .child(div().flex().items_center().gap(px(5.)).child(icon("phone", 15., theme.green)).child(t("voice.call.join")))
                .on_click(move |_, _, cx| voice_entity.update(cx, |voice, cx| voice.join(server_id.clone(), group.clone(), None, JoinHow::default(), cx)))
                .into_any_element(),
        );
    }
    let (voice_call, voice_video) = (voice_entity.clone(), voice_entity);
    let (server_call, server_video) = (server_id.to_string(), server_id.to_string());
    let (key_call, key_video) = (conversation.key.clone(), conversation.key.clone());
    Some(
        div()
            .flex()
            .items_center()
            .gap(px(2.))
            .child(icon_button("call-voice", "phone", 17., false, false, cx).tip(t("voice.call.startVoice"), Side::Bottom).on_click(move |_, _, cx| voice_call.update(cx, |voice, cx| voice.start_call(server_call.clone(), key_call.clone(), false, cx))))
            .child(icon_button("call-video", "video", 18., false, false, cx).tip(t("voice.call.startVideo"), Side::Bottom).on_click(move |_, _, cx| voice_video.update(cx, |voice, cx| voice.start_call(server_video.clone(), key_video.clone(), true, cx))))
            .into_any_element(),
    )
}

/// A call going on in this conversation that this device isn't in: who's there, and a way in.
pub fn call_banner(state: &Entity<AppState>, server_id: &str, conversation: &ConversationView, cx: &mut App) -> Option<AnyElement> {
    let theme = theme(cx);
    let voice_entity = voice::get(cx)?;
    let app = state.read(cx);
    let server = app.servers.get(server_id)?;
    let group = conversation.group_id.clone()?;
    let voice = voice_entity.read(cx);
    if voice.status != VoiceStatus::Idle && voice.server_id.as_deref() == Some(server_id) && voice.channel_id.as_deref() == Some(group.as_str()) {
        return None;
    }
    let people = call_people(app, server_id, conversation);
    if people.is_empty() {
        return None;
    }
    let self_id = server.self_id().to_string();
    let names: Vec<String> = people.iter().map(|id| if *id == self_id { t("common.you").to_string() } else { server.users.get(id).map(|user| user.display_name.split(' ').next().unwrap_or(t("common.someone")).to_string()).unwrap_or_else(|| t("common.someone").into()) }).collect();
    // Being in it on another device of yours is still being in it.
    let elsewhere = people.contains(&self_id);
    let text = if elsewhere {
        t("voice.call.elsewhere").to_string()
    } else {
        match names.len() {
            1 => tr!("voice.call.bannerOne", name = names[0]),
            2 => tr!("voice.call.bannerTwo", first = names[0], second = names[1]),
            count => tr!("voice.call.bannerMany", first = names[0], second = names[1], count = count - 2),
        }
    };
    let server_id = server_id.to_string();
    Some(
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .pl(px(14.))
            .pr(px(12.))
            .py(px(6.))
            .text_size(px(13.))
            .text_color(theme.green)
            .bg(mix(theme.green, theme.bg1, 0.1))
            .border_b_1()
            .border_color(theme.line)
            .child(icon("phone", 15., theme.green))
            .child(div().flex_1().min_w_0().one_line().text_color(theme.text1).child(text))
            .child(button("call-banner-join", ButtonKind::Primary, ButtonSize::Small, false, cx).child(if elsewhere { t("voice.call.moveHere") } else { t("voice.call.join") }).on_click(move |_, _, cx| voice_entity.update(cx, |voice, cx| voice.join(server_id.clone(), group.clone(), None, JoinHow::default(), cx))))
            .into_any_element(),
    )
}
