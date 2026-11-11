//! Asking about a device that signed in to the person's account after this one, over
//! everything, until they say whether it was them: no click outside, Escape or close button
//! sends it away (packages/ui/src/features/overlays/NewDevice.tsx). One that wasn't is removed,
//! and they're asked next to change the secret it signed in with.

use gpui::{AnyElement, App, Entity, FocusHandle, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::components::*;
use super::motion::{Enter, Motion};
use super::text_input::TabScope;
use crate::format::format_full;
use crate::state::{AppState, Overlay};
use crate::theme::{self, RADIUS_XL};

pub fn prompt(state: &Entity<AppState>, focus: &FocusHandle, cx: &App) -> Option<AnyElement> {
    let theme = theme(cx);
    let app = state.read(cx);
    let (title, text, buttons): (&str, String, Vec<AnyElement>) = if let Some((server_id, secret)) = app.device_removed.clone() {
        let text = match secret.as_deref() {
            Some("recovery") => "Whoever signed in on it has your recovery key, so they can sign in again until you make a new one. Make one now.",
            Some(_) => "Whoever signed in on it knows your password, so they can sign in again until you change it. Change it now.",
            None => "Whoever signed in on it may know your password or your recovery key. Change your password and make a new recovery key now.",
        };
        let action = if secret.as_deref() == Some("recovery") { "Make a new recovery key" } else { "Change password" };
        let (later, open) = (state.clone(), state.clone());
        (
            "The device was removed",
            text.to_string(),
            vec![
                button("new-device-later", ButtonKind::Ghost, ButtonSize::Normal, false, cx)
                    .child("Later")
                    .on_click(move |_, _, cx| later.update(cx, |state, cx| {
                        state.device_removed = None;
                        cx.notify();
                    }))
                    .into_any_element(),
                button("new-device-secure", ButtonKind::Primary, ButtonSize::Normal, false, cx)
                    .child(action)
                    .on_click(move |_, _, cx| open.update(cx, |state, cx| {
                        state.device_removed = None;
                        state.select_server(&server_id, cx);
                        state.set_overlay(Some(Overlay::Settings { section: Some("security".into()) }), cx);
                    }))
                    .into_any_element(),
            ],
        )
    } else {
        let (server_id, server) = app.order.iter().find_map(|id| app.servers.get(id).filter(|server| !server.new_devices.is_empty()).map(|server| (id.clone(), server)))?;
        let device = server.new_devices[0].clone();
        let busy = app.answering_device.is_some();
        let secret = if device.secret.as_deref() == Some("recovery") { "your recovery key" } else { "your password" };
        let place = server.info.as_ref().map(|info| info.name.clone()).filter(|name| !name.is_empty()).unwrap_or_else(|| server.entry.name.clone());
        let text = format!(
            "\u{201c}{}\u{201d} signed in to your account on {} on {}. If it wasn't you, someone else has {} and is signed in as you.",
            device.name,
            place,
            format_full(device.created_at),
            secret
        );
        let (no, yes) = (state.clone(), state.clone());
        let (no_server, no_device, yes_server, yes_device) = (server_id.clone(), device.id.clone(), server_id, device.id);
        (
            "Was this you?",
            text,
            vec![
                button("new-device-not-me", ButtonKind::Danger, ButtonSize::Normal, busy, cx)
                    .child("No, remove it")
                    .on_click(move |_, _, cx| no.update(cx, |state, cx| state.answer_new_device(&no_server, &no_device, false, cx)))
                    .into_any_element(),
                button("new-device-me", ButtonKind::Primary, ButtonSize::Normal, busy, cx)
                    .child("Yes, it was me")
                    .on_click(move |_, _, cx| yes.update(cx, |state, cx| state.answer_new_device(&yes_server, &yes_device, true, cx)))
                    .into_any_element(),
            ],
        )
    };
    let card = div()
        .id("new-device")
        .w(px(440.))
        .max_w_full()
        .flex()
        .flex_col()
        .bg(theme.bg1)
        .border_1()
        .border_color(theme.line_strong)
        .rounded(RADIUS_XL)
        .shadow(shadow_l())
        .overflow_hidden()
        .occlude()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .pt(px(18.))
                .px(px(20.))
                .pb(px(4.))
                .child(icon("shield-alert", 18., theme.amber))
                .child(div().flex_1().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(title)),
        )
        .child(div().px(px(20.)).pt(px(10.)).pb(px(20.)).text_size(px(13.5)).child(SharedString::from(text)))
        .child(div().flex().justify_end().gap(px(8.)).px(px(20.)).pb(px(16.)).children(buttons));
    Some(
        div()
            .id("new-device-layer")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(28.))
            .bg(theme::color(theme::black_a(0.6)))
            // Nothing under it takes a click or a key until it's answered.
            .occlude()
            .track_focus(focus)
            .tab_scope(focus)
            .child(card.appear("new-device-card", Enter::Rise(18.), 240))
            .appear("new-device-layer", Enter::Fade, 180)
            .into_any_element(),
    )
}
