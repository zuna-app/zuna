//! A plugin's dialog, in a frame the app draws: its title, the plugin's name, with its mark if
//! it isn't verified, and the app's own close button. What the plugin draws fills only the body.

use gpui::{Context, Entity, FocusHandle, FontWeight, IntoElement, ParentElement, Render, Styled, Subscription, Window, div, prelude::*, px};

use crate::state::AppState;
use crate::theme::{self, RADIUS_XL};
use crate::ui::components::*;
use crate::ui::motion::{Enter, Motion};
use crate::ui::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};

pub struct PluginDialog {
    state: Entity<AppState>,
    handle: u32,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl PluginDialog {
    pub fn new(state: Entity<AppState>, handle: u32, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut subscriptions = vec![cx.observe(&state, |_, _, cx| cx.notify())];
        if let Some(plugins) = crate::plugins::get(cx) {
            subscriptions.push(cx.observe(&plugins, |_, _, cx| cx.notify()));
        }
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        PluginDialog { state, handle, focus, _subscriptions: subscriptions }
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }
}

impl Render for PluginDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let (title, uid) = super::title(self.handle, cx).unwrap_or_else(|| (String::new(), String::new()));
        let width = crate::plugins::get(cx).and_then(|plugins| plugins.read(cx).slots.get(&uid).and_then(|slots| slots.dialog.as_ref()).map(|slot| slot.width)).unwrap_or(440.);
        let body = super::body(self.handle, cx);
        let handle = scroll_handle("plugin-dialog-body");
        let card = div()
            .id("plugin-dialog")
            .w(px(width))
            .max_w_full()
            .max_h_full()
            .flex()
            .flex_col()
            .bg(theme.bg1)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(RADIUS_XL)
            .shadow(shadow_l())
            .overflow_hidden()
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .pt(px(14.))
                    .pr(px(14.))
                    .pb(px(4.))
                    .pl(px(20.))
                    .child(div().flex_1().min_w_0().flex().flex_col().gap(px(2.)).child(div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).one_line().child(title)).child(super::plugin_name(&uid, cx)))
                    .child(icon_button("close-plugin-dialog", "x", 16., true, false, cx).on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx)))),
            )
            .child(div().id("plugin-dialog-body").overflow_y_scroll().track_scroll(&handle).px(px(20.)).pr(px(20.) + gutter(&handle)).pt(px(10.)).pb(px(20.)).child(body).child(scrollbar("plugin-dialog-body", Scrolls::Div(handle.clone()))));
        div()
            .id("plugin-dialog-layer")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(28.))
            .bg(theme::color(theme::black_a(0.6)))
            .occlude()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|dialog, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    dialog.close(cx);
                }
            }))
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|dialog, _, _, cx| dialog.close(cx)))
            .child(card.appear("plugin-dialog-card", Enter::Rise(18.), 240))
    }
}
