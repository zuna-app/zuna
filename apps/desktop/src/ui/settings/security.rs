//! The Security section: the person's devices, their security key, the password and the
//! recovery key.

use super::*;

impl SettingsView {
    pub(super) fn security(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some((server, me)) = self.me(cx) else { return Vec::new() };
        let key_protected = self.state.read(cx).key_protected;
        let verify_state = self.state.clone();
        let user_id = me.id.clone();
        let mut parts = vec![Self::heading("Security", &theme)];
        if !key_protected {
            parts.push(
                div()
                    .flex()
                    .gap(px(10.))
                    .px(px(12.))
                    .py(px(10.))
                    .rounded(RADIUS_M)
                    .bg(theme.amber_soft)
                    .text_size(px(13.))
                    .text_color(theme.amber_text)
                    .child(icon("lock", 15., theme.amber))
                    .child(crate::platform::KEY_WARNING)
                    .into_any_element(),
            );
        }
        parts.push(Self::row(
            "Your security key",
            Some("Compare it with friends to prove nobody is in between."),
            button("view-key", ButtonKind::Default, ButtonSize::Small, false, cx)
                .child(icon("key-round", 14., theme.text1))
                .child("View")
                .on_click(move |_, _, cx| verify_state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user_id.clone() }), cx))),
            &theme,
        ));
        let mut devices = div().flex().flex_col().gap(px(3.));
        for device in self.devices.clone() {
            let state = self.state.clone();
            let id = device.id.clone();
            devices = devices.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(11.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg2)
                    .text_size(px(13.5))
                    .child(div().size(px(34.)).rounded_full().bg(theme.bg3).flex().items_center().justify_center().child(icon("laptop", 18., theme.text2)))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .child(div().font_weight(FontWeight::MEDIUM).child(device.name.clone()))
                                    .when(device.is_current, |el| el.child(div().ml(px(8.)).px(px(7.)).py(px(1.)).rounded(px(10.)).text_size(px(11.)).bg(theme.bg4).text_color(theme.text2).child("This device"))),
                            )
                            .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("Signed in {}", format_full(device.created_at)))),
                    )
                    .when(!device.is_current, |el| {
                        el.child(button(SharedString::from(format!("revoke-{}", device.id)), ButtonKind::Danger, ButtonSize::Small, false, cx).child(icon("trash", 13., theme.red)).child("Remove").on_click(move |_, _, cx| {
                            state.update(cx, |state, cx| state.act("revokeDevice", vec![json!(id)], cx))
                        }))
                    }),
            );
        }
        parts.push(
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Your devices on this server"))
                .child(devices)
                .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("To add one, sign in there to {}", server.entry.address)))
                .into_any_element(),
        );
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("Change password"));
        let current = self.current.read(cx).text().to_string();
        let next = self.next.read(cx).text().to_string();
        let confirm = self.confirm.read(cx).text().to_string();
        let can_change = !current.is_empty() && next.chars().count() >= MIN_PASSWORD && self.strength.0 >= 2 && confirm == next;
        parts.push(field(Some("Current password"), self.current.clone(), None, None, self.focused == Some(2), None, cx).into_any_element());
        parts.push(
            field(
                Some("New password"),
                self.next.clone(),
                None,
                Some(if next.is_empty() { format!("At least {MIN_PASSWORD} characters.") } else { self.strength.1.clone() }),
                self.focused == Some(3),
                None,
                cx,
            )
            .into_any_element(),
        );
        let confirm_error = if !confirm.is_empty() && !next.starts_with(&confirm) { Some("The passwords don't match.".to_string()) } else { None };
        parts.push(field(Some("Confirm new password"), self.confirm.clone(), confirm_error, None, self.focused == Some(4), None, cx).into_any_element());
        let state = self.state.clone();
        parts.push(
            div()
                .child(button("change-password", ButtonKind::Default, ButtonSize::Normal, !can_change, cx).child("Change password").when(can_change, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| {
                        let (current, next) = (view.current.read(cx).text().to_string(), view.next.read(cx).text().to_string());
                        let inputs = [view.current.clone(), view.next.clone(), view.confirm.clone()];
                        state.update(cx, |state, cx| {
                            let server = state.active_server.clone();
                            state.call(server.as_deref(), "changePassword", vec![json!(current), json!(next)], cx, move |state, result, cx| match result {
                                Ok(_) => {
                                    for input in &inputs {
                                        input.update(cx, |input, cx| input.set_text("", cx));
                                    }
                                    state.toast("Password changed", ToastKind::Info, cx)
                                }
                                Err(error) => state.toast(error.message, ToastKind::Error, cx),
                            });
                        });
                    }))
                }))
                .into_any_element(),
        );
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("Recovery key"));
        parts.push(div().text_size(px(13.5)).text_color(theme.text2).child("Create a new key if you've lost the old one or think someone saw it. The old key stops working immediately.").into_any_element());
        if let Some(key) = self.recovery_key.clone() {
            let copy = key.clone();
            let state = self.state.clone();
            parts.push(
                div()
                    .grid()
                    .grid_cols(5)
                    .gap(px(8.))
                    .p(px(14.))
                    .bg(theme.bg2)
                    .border_1()
                    .border_color(theme.line)
                    .rounded(RADIUS_M)
                    .font_family(theme::FONT_MONO)
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .children(key.split('-').map(|part| div().flex().justify_center().child(part.to_string())))
                    .into_any_element(),
            );
            parts.push(
                button("copy-new-key", ButtonKind::Default, ButtonSize::Normal, false, cx)
                    .child(icon("copy", 14., theme.text1))
                    .child("Copy")
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy.clone()));
                        state.update(cx, |state, cx| state.toast("Copied", ToastKind::Info, cx));
                    })
                    .into_any_element(),
            );
        } else {
            parts.push(field(Some("Current password"), self.recovery_password.clone(), None, None, self.focused == Some(5), None, cx).into_any_element());
            let password = self.recovery_password.read(cx).text().to_string();
            let state = self.state.clone();
            parts.push(
                div()
                    .child(button("new-recovery-key", ButtonKind::Default, ButtonSize::Normal, password.is_empty(), cx).child("Create a new recovery key").when(!password.is_empty(), |el| {
                        el.on_click(cx.listener(move |view, _, _, cx| {
                            let call = {
                                let state = state.read(cx);
                                state.active_server.clone().map(|server| state.core.call(Some(&server), "regenerateRecoveryKey", vec![json!(password)]))
                            };
                            let Some(call) = call else { return };
                            let state = state.clone();
                            cx.spawn(async move |view, cx| {
                                let result = call.await;
                                view.update(cx, |view, cx| match result {
                                    Ok(value) => {
                                        view.recovery_key = value.as_str().map(str::to_string);
                                        view.recovery_password.update(cx, |input, cx| input.set_text("", cx));
                                        cx.notify();
                                    }
                                    Err(error) => state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                                })
                                .ok();
                            })
                            .detach();
                            let _ = view;
                        }))
                    }))
                    .into_any_element(),
            );
        }
        parts
    }
}
