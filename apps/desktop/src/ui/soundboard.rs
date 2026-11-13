//! The soundboard: sounds a server's admins add, which anyone in a voice channel or a call
//! can play to everyone there (Soundboard.tsx). Each device plays a sound itself from its
//! file, so it goes out as it was made rather than through someone's microphone.

use gpui::{AnyElement, Anchor, App, Entity, FontWeight, IntoElement, ParentElement, SharedString, Styled, anchored, deferred, div, prelude::*, px};

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use crate::state::{AppState, Overlay};
use crate::theme::{RADIUS_L, RADIUS_M, RADIUS_S};
use crate::voice::Voice;

/// Why this person can't play a sound in the room they're in, if they can't.
fn refusal(voice: &Voice, room_sounds: bool) -> Option<&'static str> {
    if !room_sounds {
        return Some("The soundboard is off in this voice channel.");
    }
    if voice.server_muted {
        return Some("An admin muted you, so you can't play sounds.");
    }
    if voice.deafened {
        return Some("Undeafen to play sounds.");
    }
    // Without a microphone, someone can only listen, and so they're muted.
    if voice.muted || voice.no_mic {
        return Some("Unmute to play sounds.");
    }
    None
}

/// The soundboard's button among a call's controls, with its panel above it while open.
pub fn soundboard_button(state: &Entity<AppState>, voice_entity: &Entity<Voice>, room_sounds: bool, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let open = voice_entity.read(cx).soundboard_open;
    let toggle = voice_entity.clone();
    let mut button = div()
        .id("soundboard-control")
        .relative()
        .size(px(44.))
        .flex_none()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(if open { theme.accent } else { theme.bg3 })
        .cursor_pointer()
        .hover(move |style| if open { style } else { style.bg(theme.bg4) })
        .tip("Soundboard", Side::Top)
        .on_click(move |_, _, cx| {
            toggle.update(cx, |voice, cx| {
                voice.soundboard_open = !voice.soundboard_open;
                cx.notify();
            })
        })
        .child(icon("audio-lines", 20., if open { theme.on_accent } else { theme.text1 }));
    if open {
        button = button.child(deferred(anchored().anchor(Anchor::BottomLeft).position_mode(gpui::AnchoredPositionMode::Local).position(gpui::point(px(-146.), px(-8.))).snap_to_window_with_margin(px(8.)).child(panel(state, voice_entity, room_sounds, cx))).with_priority(1));
    }
    button.into_any_element()
}

fn panel(state: &Entity<AppState>, voice_entity: &Entity<Voice>, room_sounds: bool, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let voice = voice_entity.read(cx);
    let refusal = refusal(voice, room_sounds);
    let volume = voice.settings.soundboard_volume;
    let server_id = voice.server_id.clone().unwrap_or_default();
    let app = state.read(cx);
    let server = app.servers.get(&server_id);
    let sounds = server.map(|server| server.sounds.clone()).unwrap_or_default();
    let is_admin = server.and_then(|server| server.me.as_ref()).is_some_and(|me| me.role == "owner" || me.role == "admin");
    let close = voice_entity.clone();
    let manage = {
        let (state, voice) = (state.clone(), voice_entity.clone());
        move |cx: &mut App| {
            voice.update(cx, |voice, cx| {
                voice.soundboard_open = false;
                cx.notify();
            });
            state.update(cx, |state, cx| state.set_overlay(Some(Overlay::ServerSettings { section: Some("soundboard".into()) }), cx));
        }
    };
    let manage_link = manage.clone();
    let mut grid = div().flex().flex_wrap().gap(px(6.));
    for sound in &sounds {
        let play = voice_entity.clone();
        let id = sound.id.clone();
        let disabled = refusal.is_some();
        grid = grid.child(
            div()
                .id(SharedString::from(format!("sound-{}", sound.id)))
                .w(px(100.))
                .h(px(36.))
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(9.))
                .rounded(RADIUS_M)
                .bg(theme.bg2)
                .text_size(px(13.))
                .text_color(theme.text1)
                .tooltip(tooltip(format!("{}, {:.1} s", sound.name, sound.duration_ms / 1000.)))
                .when(!disabled, |el| el.cursor_pointer().hover(move |style| style.bg(theme.bg4)).on_click(move |_, _, cx| play.update(cx, |voice, cx| voice.play_sound(id.clone(), cx))))
                .when(disabled, |el| el.opacity(0.5))
                .child(div().flex_none().text_size(px(16.)).child(if sound.emoji.is_empty() { "🔊".to_string() } else { sound.emoji.clone() }))
                .child(div().min_w_0().one_line().child(sound.name.clone())),
        );
    }
    let slide = voice_entity.clone();
    div()
        .id("soundboard")
        .occlude()
        .w(px(336.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .p(px(10.))
        .bg(theme.bg3)
        .border_1()
        .border_color(theme.line_strong)
        .rounded(RADIUS_L)
        .shadow(shadow_m())
        .on_mouse_down_out(move |_, _, cx| {
            close.update(cx, |voice, cx| {
                voice.soundboard_open = false;
                cx.notify();
            })
        })
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text1)
                .child(icon("audio-lines", 15., theme.text2))
                .child(div().flex_1().child("Soundboard"))
                .when(is_admin, |el| el.child(icon_button("soundboard-manage", "settings", 15., true, false, cx).tip("Add and change sounds", Side::Bottom).on_click(move |_, _, cx| manage(cx)))),
        )
        .when(refusal.is_some() && !sounds.is_empty(), |el| el.child(div().text_size(px(12.5)).text_color(theme.text2).bg(theme.bg2).rounded(RADIUS_S).px(px(9.)).py(px(6.)).child(refusal.unwrap_or_default())))
        .child(if sounds.is_empty() {
            div()
                .flex()
                .flex_wrap()
                .gap(px(4.))
                .py(px(8.))
                .px(px(2.))
                .text_size(px(13.))
                .text_color(theme.text2)
                .child("This server has no sounds yet.")
                .child(if is_admin {
                    div().id("soundboard-add").font_weight(FontWeight::MEDIUM).text_color(theme.accent_text).cursor_pointer().on_click(move |_, _, cx| manage_link(cx)).child("Add some").into_any_element()
                } else {
                    div().child("Admins can add them.").into_any_element()
                })
                .into_any_element()
        } else {
            {
                let handle = scroll_handle("soundboard-grid");
                div().id("soundboard-grid").max_h(px(300.)).overflow_y_scroll().track_scroll(&handle).pr(gutter(&handle)).child(grid).child(scrollbar("soundboard-grid", Scrolls::Div(handle.clone()))).into_any_element()
            }
        })
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .pt(px(8.))
                .border_t_1()
                .border_color(theme.line)
                .text_size(px(12.5))
                .text_color(theme.text2)
                .child(div().flex().gap(px(4.)).child("Volume").child(div().font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(format!("{}%", (volume * 100.).round()))))
                .child(slider("soundboard-volume", volume, move |value, _, cx| slide.update(cx, |voice, cx| voice.update_settings(|settings| settings.soundboard_volume = value, cx)), cx)),
        )
        .into_any_element()
}
