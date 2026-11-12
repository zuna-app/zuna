//! Asking before a plugin is installed or updated. A verified one gets a plain question with what
//! it can do. One Zuna hasn't checked gets the warning: it covers the whole window, in the danger
//! colors, over everything, as the question about a new device does, and nothing a plugin draws
//! is on screen while it's up. Cancel holds the focus, Enter and Escape both cancel, and "Install
//! anyway" stays off until the box is ticked and five seconds have passed.

use std::time::{Duration, Instant};

use gpui::{AnyElement, Context, Entity, FocusHandle, FontWeight, IntoElement, ParentElement, Render, Styled, Subscription, Window, div, prelude::*, px};

use crate::plugins::install::Proposal;
use crate::state::AppState;
use crate::theme::{self, RADIUS_M, RADIUS_XL};
use crate::ui::components::*;
use crate::ui::motion::{Enter, Motion};

/// How long the warning stays up before it can be agreed to.
pub const WAIT: Duration = Duration::from_secs(5);

pub struct InstallDialog {
    state: Entity<AppState>,
    id: u64,
    ticked: bool,
    opened: Instant,
    focus: FocusHandle,
    _wait: gpui::Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl InstallDialog {
    pub fn new(state: Entity<AppState>, id: u64, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut subscriptions = Vec::new();
        if let Some(plugins) = crate::plugins::get(cx) {
            subscriptions.push(cx.observe(&plugins, |_, _, cx| cx.notify()));
        }
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        // Drawn again once the wait is over, so "Install anyway" comes on by itself.
        let wait = cx.spawn(async move |view, cx| {
            cx.background_executor().timer(WAIT + Duration::from_millis(50)).await;
            view.update(cx, |_, cx| cx.notify()).ok();
        });
        InstallDialog { state, id, ticked: false, opened: Instant::now(), focus, _wait: wait, _subscriptions: subscriptions }
    }

    fn proposal(&self, cx: &gpui::App) -> Option<Proposal> {
        crate::plugins::get(cx)?.read(cx).proposal.clone().filter(|proposal| proposal.id == self.id)
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        let id = self.id;
        if let Some(plugins) = crate::plugins::get(cx) {
            plugins.update(cx, |plugins, _| plugins.cancel(id));
        }
        self.back_to_settings(cx);
    }

    /// Back where it was asked from: Settings → Plugins, which every proposal comes from.
    fn back_to_settings(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Settings { section: Some("plugins".into()) }), cx));
    }

    /// Whether the warning may be agreed to yet.
    pub fn may_install(&self, verified: bool) -> bool {
        verified || (self.ticked && self.opened.elapsed() >= WAIT)
    }

    fn install(&mut self, cx: &mut Context<Self>) {
        let Some(proposal) = self.proposal(cx) else { return };
        if !self.may_install(proposal.verified) {
            return;
        }
        let id = self.id;
        self.back_to_settings(cx);
        if let Some(plugins) = crate::plugins::get(cx) {
            plugins.update(cx, |plugins, cx| plugins.confirm(id, cx));
        }
    }

    fn lines(proposal: &Proposal, danger: bool, cx: &gpui::App) -> Vec<AnyElement> {
        let theme = theme(cx);
        let told = proposal.told();
        if told.is_empty() {
            return vec![div().text_color(if danger { theme.danger_text } else { theme.text2 }).child("It asks for nothing of your account.").into_any_element()];
        }
        told.into_iter()
            .map(|(line, strong)| {
                div()
                    .flex()
                    .gap(px(8.))
                    .text_size(px(13.5))
                    .text_color(if danger { theme.danger_text } else { theme.text1 })
                    .child(div().flex_none().child("â€¢"))
                    .child(div().flex_1().min_w_0().when(strong, |el| el.font_weight(FontWeight::SEMIBOLD)).child(line))
                    .into_any_element()
            })
            .collect()
    }
}

impl Render for InstallDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(proposal) = self.proposal(cx) else { return div().into_any_element() };
        let keys = cx.listener(|dialog, event: &gpui::KeyDownEvent, _, cx| {
            // Enter cancels too, so nothing typed can install a plugin.
            if matches!(event.keystroke.key.as_str(), "escape" | "enter") {
                dialog.cancel(cx);
                cx.stop_propagation();
            }
        });
        let ready = self.may_install(proposal.verified);
        let update_line = proposal.update_of.as_ref().map(|(older, permissions, hosts)| {
            let more: Vec<String> = permissions.iter().map(|permission| permission.told().to_string()).chain(hosts.iter().map(|host| format!("Contacts {host}"))).collect();
            if more.is_empty() { format!("This replaces version {older}.") } else { format!("This replaces version {older}, and asks for more: {}.", more.join("; ")) }
        });
        if proposal.verified {
            let card = div()
                .id("plugin-install")
                .w(px(460.))
                .max_w_full()
                .flex()
                .flex_col()
                .gap(px(12.))
                .p(px(22.))
                .bg(theme.bg1)
                .border_1()
                .border_color(theme.line_strong)
                .rounded(RADIUS_XL)
                .shadow(shadow_l())
                .occlude()
                .child(div().flex().items_center().gap(px(10.)).child(icon("puzzle", 20., theme.text2)).child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child(format!("Install {}?", proposal.name))))
                .child(div().text_size(px(13.)).text_color(theme.text2).child(format!("Version {}, by {}. Checked by Zuna's team, and signed by Zuna.", proposal.version, proposal.author)))
                .when(!proposal.description.is_empty(), |el| el.child(div().text_size(px(13.5)).child(proposal.description.clone())))
                .when_some(update_line, |el, line| el.child(notice("info", line, cx)))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Once installed it can:"))
                .children(Self::lines(&proposal, false, cx))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .pt(px(6.))
                        .child(button("plugin-install-cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.cancel(cx))))
                        .child(button("plugin-install-confirm", ButtonKind::Primary, ButtonSize::Normal, false, cx).child("Install").on_click(cx.listener(|dialog, _, _, cx| dialog.install(cx)))),
                );
            return div()
                .id("plugin-install-layer")
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .p(px(28.))
                .bg(theme::color(theme::black_a(0.6)))
                .occlude()
                .track_focus(&self.focus)
                .on_key_down(keys)
                .child(card.appear("plugin-install-card", Enter::Rise(18.), 240))
                .into_any_element();
        }
        let ticked = self.ticked;
        let checkbox = div()
            .id("plugin-install-trust")
            .flex()
            .items_center()
            .gap(px(10.))
            .cursor_pointer()
            .text_size(px(13.5))
            .text_color(theme.danger_text)
            .on_click(cx.listener(|dialog, _, _, cx| {
                dialog.ticked = !dialog.ticked;
                cx.notify();
            }))
            .child(
                div()
                    .size(px(18.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .border_2()
                    .border_color(theme.red)
                    .when(ticked, |el| el.bg(theme.red).child(icon("check", 13., theme::color(theme::hex(0xffffff))))),
            )
            .child("I understand, and I trust where this came from");
        let waited = self.opened.elapsed() >= WAIT;
        let action = if ticked && !waited { format!("Install anyway ({})", (WAIT.saturating_sub(self.opened.elapsed()).as_secs() + 1)) } else { "Install anyway".to_string() };
        let body = div()
            .id("plugin-install-warning")
            .w(px(560.))
            .max_w_full()
            .flex()
            .flex_col()
            .gap(px(14.))
            .p(px(28.))
            .rounded(RADIUS_XL)
            .bg(theme.bg1)
            .border_2()
            .border_color(theme.red)
            .shadow(shadow_l())
            .occlude()
            .child(div().flex().items_center().gap(px(12.)).child(icon("shield-alert", 26., theme.red)).child(div().text_size(px(21.)).font_weight(FontWeight::BOLD).text_color(theme.red).child("Zuna hasn't checked this plugin")))
            .child(div().text_size(px(14.)).text_color(theme.text1).child(format!(
                "Nobody on Zuna's team has read its code. It calls itself \"{}\", by \"{}\", which nothing confirms. Once installed it can:",
                proposal.name, proposal.author
            )))
            .child(div().flex().flex_col().gap(px(6.)).p(px(14.)).rounded(RADIUS_M).bg(theme.red_soft).children(Self::lines(&proposal, true, cx)))
            .when_some(update_line, |el, line| el.child(div().text_size(px(13.5)).text_color(theme.amber_text).child(line)))
            .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child("If someone told you to install this to fix a problem, to win something, or to see something hidden, it's a scam."))
            .child(checkbox)
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .pt(px(4.))
                    .child(button("plugin-install-cancel", ButtonKind::Primary, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.cancel(cx))))
                    .child(button("plugin-install-anyway", ButtonKind::Danger, ButtonSize::Normal, !ready, cx).child(action).when(ready, |el| el.on_click(cx.listener(|dialog, _, _, cx| dialog.install(cx))))),
            );
        if ticked && !waited {
            // The countdown on the button.
            window.request_animation_frame();
        }
        div()
            .id("plugin-install-danger")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(28.))
            .bg(theme::color(theme::rgba(40, 6, 8, 0.94)))
            .occlude()
            .track_focus(&self.focus)
            .on_key_down(keys)
            .child(body.appear("plugin-install-warning", Enter::Fade, 160))
            .into_any_element()
    }
}
