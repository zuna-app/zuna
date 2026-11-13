//! Verifying someone: comparing emoji with them, and what changed in their security key.

use super::*;

impl Dialog {
    pub(super) fn verify(&mut self, user_id: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let Some(user) = server.users.get(&user_id).cloned() else { return div().into_any_element() };
        let is_self = user_id == server.self_id();
        let trust = self.check.as_ref().map(|check| check.trust.clone()).unwrap_or(user.trust.clone());
        let title = if is_self { "Your security key".to_string() } else { format!("Verify {} (@{})", user.display_name, user.username) };
        let notice = |icon_name: &str, color: gpui::Hsla, bg: gpui::Hsla, text_color: gpui::Hsla, text: String| {
            div().flex().gap(px(10.)).px(px(12.)).py(px(10.)).rounded(RADIUS_M).bg(bg).text_size(px(13.)).text_color(text_color).child(icon(icon_name, 16., color)).child(div().flex_1().min_w_0().child(text)).into_any_element()
        };
        let mut body = Vec::new();
        match trust.as_str() {
            "changed" => body.push(notice(
                "shield-alert",
                theme.red,
                theme.red_soft,
                theme.danger_text,
                format!("{}'s security key changed in a way that doesn't follow from the one before, so this may mean someone is intercepting your messages. Only continue after comparing these emoji with them directly.", user.display_name),
            )),
            "verified" => body.push(notice("shield-check", theme.text2, theme.bg2, theme.text2, format!("You've verified {}. Nobody can secretly intercept your messages.", user.display_name))),
            _ if !is_self => body.push(
                div()
                    .text_size(px(13.5))
                    .text_color(theme.text2)
                    .child(format!("Compare these emoji with {} in person or on a call. If they match exactly, nobody else, not even this server, can read your conversation.", user.display_name))
                    .into_any_element(),
            ),
            _ => {}
        }
        let emoji = self.check.as_ref().map(|check| check.emoji.clone()).unwrap_or_default();
        // Four to a row, as `.verify-grid`'s columns. Rows of their own, as GPUI's grid measured
        // itself far taller than it drew, and the dialog with it.
        let cells: Vec<_> = emoji.into_iter().collect();
        body.push(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .p(px(12.))
                .rounded(RADIUS_L)
                .bg(theme.bg2)
                .children(cells.chunks(4).map(|row| {
                    div().flex().gap(px(6.)).children(row.iter().map(|item| {
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(2.))
                            .px(px(2.))
                            .py(px(6.))
                            .child(div().text_size(px(30.)).line_height(gpui::relative(1.1)).child(item.emoji.clone()))
                            .child(div().text_size(px(11.)).text_color(theme.text2).text_center().child(item.name.clone()))
                    }))
                }))
                .into_any_element(),
        );
        if !is_self {
            let state = self.state.clone();
            let id = user_id.clone();
            let name = user.display_name.clone();
            if trust == "verified" {
                body.push(
                    button("clear-verification", ButtonKind::Default, ButtonSize::Normal, false, cx)
                        .w_full()
                        .child("Remove verification")
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("clearVerification", vec![json!(id)], cx)))
                        .into_any_element(),
                );
            } else {
                let covers = self.check.as_ref().map(|check| check.covers.clone());
                let dismiss_state = self.state.clone();
                body.push(
                    div()
                        .flex()
                        .gap(px(10.))
                        .child(button("no-match", ButtonKind::Default, ButtonSize::Normal, false, cx).flex_1().child(icon("triangle-alert", 15., theme.text1)).child("They don't match").on_click(move |_, _, cx| {
                            dismiss_state.update(cx, |state, cx| {
                                state.toast("Don't share anything private with them until you know why the emoji differ.", ToastKind::Security, cx);
                                state.set_overlay(None, cx);
                            })
                        }))
                        .child(
                            button("match", ButtonKind::Primary, ButtonSize::Normal, covers.is_none(), cx)
                                .flex_1()
                                .child(icon("badge-check", 16., theme.on_accent))
                                .child("They match")
                                .when_some(covers, |el, covers| {
                                    el.on_click(move |_, _, cx| {
                                        let (id, covers, name) = (id.clone(), covers.clone(), name.clone());
                                        state.update(cx, |state, cx| {
                                            let server = state.active_server.clone();
                                            state.call(server.as_deref(), "markVerified", vec![json!(id), json!(covers)], cx, move |state, result, cx| match result {
                                                Ok(_) => {
                                                    state.toast(format!("{name} is verified"), ToastKind::Info, cx);
                                                    state.set_overlay(None, cx);
                                                }
                                                Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                            })
                                        })
                                    })
                                }),
                        )
                        .into_any_element(),
                );
            }
        }
        self.modal(Some(title), 460., body, None, cx)
    }
}
