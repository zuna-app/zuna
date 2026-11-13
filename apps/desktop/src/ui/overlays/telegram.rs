//! Linking a Telegram account (docs/TELEGRAM_PLAN.md, Linking an account): first what it is and
//! what Telegram learns, before anything is sent to Telegram, then a QR code, which Telegram on
//! the person's phone scans, with a phone number and its code as the fallback, and the account's
//! password if it has one. No account is made here.

use std::sync::Arc;

use super::*;
use crate::telegram::SERVER_ID;

/// What's being typed while an account is linked.
pub(super) struct TelegramForm {
    /// The explanation was read and continued from, and the engine started.
    started: bool,
    /// The person chose a phone number over the QR code.
    by_phone: bool,
    /// The QR code was asked for once already.
    asked_qr: bool,
    phone: Entity<TextInput>,
    code: Entity<TextInput>,
    password: Entity<TextInput>,
    /// The QR code drawn for the link it holds.
    qr: Option<(String, Arc<gpui::Image>)>,
    busy: bool,
    problem: Option<String>,
}

const FIRST_FIELD: usize = 20;

impl TelegramForm {
    pub(super) fn new(window: &mut Window, subscriptions: &mut Vec<Subscription>, cx: &mut Context<Dialog>) -> TelegramForm {
        let phone = cx.new(|cx| TextInput::new(cx, "+1 555 010 0000"));
        let code = cx.new(|cx| TextInput::new(cx, "12345"));
        let password = cx.new(|cx| TextInput::new(cx, "Your Telegram password").masked(true));
        for (index, input) in [&phone, &code, &password].into_iter().enumerate() {
            subscriptions.push(cx.subscribe_in(input, window, move |dialog, input, event, _, cx| {
                match event {
                    InputEvent::Focused => dialog.focused = Some(FIRST_FIELD + index),
                    InputEvent::Blurred if dialog.focused == Some(FIRST_FIELD + index) => dialog.focused = None,
                    InputEvent::Escape => dialog.close(cx),
                    InputEvent::Submit => dialog.telegram_submit(cx),
                    // Typing again takes the last error away, and a field emptied after a try doesn't.
                    InputEvent::Changed if !input.read(cx).text().is_empty() => {
                        if let Some(form) = dialog.telegram_form.as_mut() {
                            form.problem = None;
                        }
                    }
                    _ => {}
                }
                cx.notify();
            }));
        }
        TelegramForm { started: false, by_phone: false, asked_qr: false, phone, code, password, qr: None, busy: false, problem: None }
    }
}

/// A QR code for `text`, as a PNG: dark modules on white, with the quiet zone QR readers need.
fn qr_image(text: &str) -> Option<Arc<gpui::Image>> {
    let code = qrcodegen::QrCode::encode_text(text, qrcodegen::QrCodeEcc::Medium).ok()?;
    let scale = 8u32;
    let border = 4i32;
    let size = code.size();
    let pixels = ((size + border * 2) as u32) * scale;
    let mut image = image::GrayImage::from_pixel(pixels, pixels, image::Luma([255]));
    for y in 0..size {
        for x in 0..size {
            if !code.get_module(x, y) {
                continue;
            }
            for dy in 0..scale {
                for dx in 0..scale {
                    image.put_pixel(((x + border) as u32) * scale + dx, ((y + border) as u32) * scale + dy, image::Luma([0]));
                }
            }
        }
    }
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, png.into_inner())))
}

impl Dialog {
    pub(super) fn telegram(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let link = self.state.read(cx).telegram_link.clone();
        let Some(form) = self.telegram_form.as_mut() else { return div().into_any_element() };
        let step = link.as_ref().map(|link| link.step.clone()).unwrap_or_default();
        // QR first: the engine starts waiting for a phone number, and is asked for a code instead.
        if form.started && step == "phone" && !form.by_phone && !form.asked_qr {
            form.asked_qr = true;
            self.telegram_ask("linkWithQr", vec![], cx);
        }
        let Some(form) = self.telegram_form.as_mut() else { return div().into_any_element() };
        let text = |content: &str| div().text_size(px(13.5)).child(content.to_string()).into_any_element();
        let small = |content: &str| div().text_size(px(12.5)).text_color(theme.text2).child(content.to_string()).into_any_element();
        let mut body: Vec<AnyElement> = Vec::new();
        let mut footer: Vec<AnyElement> = Vec::new();
        let cancel = |label: &'static str, cx: &mut Context<Dialog>| button("tg-cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child(label).on_click(cx.listener(|dialog, _, _, cx| dialog.telegram_cancel(cx))).into_any_element();
        let focused = |dialog_focus: Option<usize>, index: usize| dialog_focus == Some(FIRST_FIELD + index);
        let dialog_focus = self.focused;

        if !form.started {
            body.push(text("Zuna will sign in to your Telegram account as another device, using Telegram's API. Zuna isn't made by Telegram."));
            let point = |title: &str, rest: &str| {
                div()
                    .flex()
                    .gap(px(8.))
                    .text_size(px(13.5))
                    .child(div().flex_none().text_color(theme.text3).child("•"))
                    .child(div().flex_1().min_w_0().child(div().font_weight(FontWeight::SEMIBOLD).child(title.to_string())).child(div().text_color(theme.text2).child(rest.to_string())))
                    .into_any_element()
            };
            body.push(point("These chats aren't end-to-end encrypted.", "Telegram keeps them on its servers, as it does for its own apps. Zuna's servers never see them."));
            body.push(point("Telegram learns", "that you use Zuna, this device's address, its system and when you're online."));
            body.push(point("Telegram watches accounts that use other apps,", "and sometimes limits one by mistake. Link an account you've had for a while."));
            body.push(point("Channels, calls and secret chats", "stay in Telegram's own app."));
            footer.push(cancel("Cancel", cx));
            footer.push(
                button("tg-continue", ButtonKind::Primary, ButtonSize::Normal, false, cx)
                    .child("Continue")
                    .on_click(cx.listener(|dialog, _, _, cx| {
                        if let Some(form) = dialog.telegram_form.as_mut() {
                            form.started = true;
                        }
                        dialog.state.update(cx, |state, cx| state.link_telegram(cx));
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        } else {
            match step.as_str() {
                "qr" if !form.by_phone => {
                    let address = link.as_ref().map(|link| link.link.clone()).unwrap_or_default();
                    if form.qr.as_ref().is_none_or(|(held, _)| *held != address) {
                        form.qr = qr_image(&address).map(|image| (address.clone(), image));
                    }
                    body.push(text("On your phone, open Telegram, then Settings, Devices, Link Desktop Device, and scan this."));
                    if let Some((_, image)) = &form.qr {
                        body.push(
                            div()
                                .flex()
                                .justify_center()
                                .child(gpui::img(gpui::ImageSource::Image(image.clone())).size(px(232.)).rounded(RADIUS_M))
                                .into_any_element(),
                        );
                    }
                    body.push(small("The code changes every half minute or so. Nothing is typed into Zuna, and no code is sent by text message."));
                    footer.push(
                        button("tg-phone", ButtonKind::Ghost, ButtonSize::Normal, false, cx)
                            .child("Use a phone number instead")
                            .on_click(cx.listener(|dialog, _, window, cx| {
                                if let Some(form) = dialog.telegram_form.as_mut() {
                                    form.by_phone = true;
                                    form.phone.focus_handle(cx).focus(window, cx);
                                }
                                dialog.state.update(cx, |state, cx| state.restart_telegram_link(cx));
                                cx.notify();
                            }))
                            .into_any_element(),
                    );
                    footer.push(cancel("Cancel", cx));
                }
                "qr" | "phone" => {
                    body.push(text("The code comes in Telegram on another of your devices, or by email. Telegram doesn't send one by text message to an app like Zuna."));
                    body.push(field(Some("Phone number"), form.phone.clone(), None, Some("With its country code.".into()), focused(dialog_focus, 0), None, cx).into_any_element());
                    footer.push(cancel("Cancel", cx));
                    footer.push(button("tg-send", ButtonKind::Primary, ButtonSize::Normal, form.busy, cx).child("Next").on_click(cx.listener(|dialog, _, _, cx| dialog.telegram_submit(cx))).into_any_element());
                }
                "code" | "email" => {
                    let link = link.clone().unwrap_or_default();
                    let whereto = match (link.step.as_str(), link.via.as_str()) {
                        ("email", _) => format!("Telegram sent a code to {}.", if link.pattern.is_empty() { "your login email" } else { link.pattern.as_str() }),
                        (_, "telegram") => "Telegram sent a code to your account, in Telegram on your other devices.".to_string(),
                        (_, "call") => "Telegram is calling you with a code.".to_string(),
                        (_, "fragment") => "Telegram sent a code to your number on Fragment.".to_string(),
                        _ => "Telegram sent you a code.".to_string(),
                    };
                    body.push(text(&whereto));
                    if form.code.read(cx).text().is_empty() && dialog_focus.is_none() {
                        form.code.focus_handle(cx).focus(window, cx);
                    }
                    body.push(field(Some("Code"), form.code.clone(), None, None, focused(dialog_focus, 1), None, cx).into_any_element());
                    if link.can_resend {
                        footer.push(button("tg-resend", ButtonKind::Ghost, ButtonSize::Normal, form.busy, cx).child("Send another").on_click(cx.listener(|dialog, _, _, cx| dialog.telegram_ask("resendCode", vec![], cx))).into_any_element());
                    }
                    footer.push(cancel("Cancel", cx));
                    footer.push(button("tg-code", ButtonKind::Primary, ButtonSize::Normal, form.busy, cx).child("Next").on_click(cx.listener(|dialog, _, _, cx| dialog.telegram_submit(cx))).into_any_element());
                }
                "password" => {
                    let hint = link.as_ref().map(|link| link.hint.clone()).unwrap_or_default();
                    body.push(text("Your account has two-step verification. Its password is checked without being sent: Telegram's engine proves it knows it."));
                    if form.password.read(cx).text().is_empty() && dialog_focus.is_none() {
                        form.password.focus_handle(cx).focus(window, cx);
                    }
                    body.push(field(Some("Password"), form.password.clone(), None, (!hint.is_empty()).then(|| format!("Hint: {hint}")), focused(dialog_focus, 2), None, cx).into_any_element());
                    footer.push(cancel("Cancel", cx));
                    footer.push(button("tg-password", ButtonKind::Primary, ButtonSize::Normal, form.busy, cx).child("Link").on_click(cx.listener(|dialog, _, _, cx| dialog.telegram_submit(cx))).into_any_element());
                }
                "signup" => {
                    body.push(text("That number has no Telegram account. Zuna doesn't make one: sign up in Telegram's own app first, then link it here."));
                    footer.push(cancel("Close", cx));
                }
                "failed" => {
                    let reason = link.as_ref().map(|link| link.reason.clone()).unwrap_or_default();
                    body.push(div().text_size(px(13.5)).text_color(theme.danger_text).child(reason).into_any_element());
                    footer.push(cancel("Close", cx));
                }
                _ => {
                    body.push(div().flex().items_center().gap(px(10.)).child(spinner(16., theme.text2)).child(small("Reaching Telegram…")).into_any_element());
                    footer.push(cancel("Cancel", cx));
                }
            }
        }
        if let Some(problem) = &form.problem {
            body.push(div().text_size(px(13.)).text_color(theme.danger_text).child(problem.clone()).into_any_element());
        }
        let footer = div().flex().gap(px(8.)).children(footer).into_any_element();
        self.modal(Some("Use Telegram in Zuna".into()), 460., body, Some(footer), cx)
    }

    /// What the step's field holds goes to the linking account's session.
    fn telegram_submit(&mut self, cx: &mut Context<Self>) {
        let step = self.state.read(cx).telegram_link.as_ref().map(|link| link.step.clone()).unwrap_or_default();
        let Some(form) = self.telegram_form.as_ref() else { return };
        if form.busy {
            return;
        }
        match step.as_str() {
            "qr" | "phone" => {
                let phone = form.phone.read(cx).text().to_string();
                self.telegram_ask("linkWithPhone", vec![json!(phone)], cx);
            }
            "code" | "email" => {
                let code = form.code.read(cx).text().to_string();
                self.telegram_ask("enterCode", vec![json!(code)], cx);
            }
            "password" => {
                let password = form.password.read(cx).text().to_string();
                self.telegram_ask("enterPassword", vec![json!(password)], cx);
            }
            _ => {}
        }
    }

    fn telegram_ask(&mut self, method: &'static str, args: Vec<serde_json::Value>, cx: &mut Context<Self>) {
        let call = self.state.read(cx).core.call(Some(SERVER_ID), method, args);
        if let Some(form) = self.telegram_form.as_mut() {
            form.busy = true;
            form.problem = None;
        }
        cx.spawn(async move |dialog, cx| {
            let result = call.await;
            dialog
                .update(cx, |dialog, cx| {
                    if let Some(form) = dialog.telegram_form.as_mut() {
                        form.busy = false;
                        if let Err(error) = result {
                            form.problem = Some(error.message);
                        }
                        // A password is never kept on screen once it's been tried.
                        if method == "enterPassword" {
                            form.password.update(cx, |input, cx| input.set_text(String::new(), cx));
                        }
                        if method == "enterCode" {
                            form.code.update(cx, |input, cx| input.set_text(String::new(), cx));
                        }
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
        cx.notify();
    }

    /// Closing the dialog before the account is linked erases what was started.
    pub(super) fn telegram_cancel(&mut self, cx: &mut Context<Self>) {
        let started = self.telegram_form.as_ref().is_some_and(|form| form.started);
        self.state.update(cx, |state, cx| {
            if started && !state.servers.contains_key(SERVER_ID) {
                state.unlink_telegram(cx);
            }
            state.telegram_link = None;
            state.set_overlay(None, cx);
        });
    }
}

impl Dialog {
    /// Joining a Telegram group by a link to it, which the group's people give out.
    pub(super) fn telegram_join(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let mut body = vec![
            div().text_size(px(13.5)).child("Paste a link to a Telegram group. Channels stay in Telegram's own app.").into_any_element(),
            field(Some("Link"), self.name.clone(), None, None, self.focused == Some(0), None, cx).into_any_element(),
        ];
        if let Some(problem) = &self.link_error {
            body.push(div().text_size(px(13.)).text_color(theme.danger_text).child(problem.clone()).into_any_element());
        }
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("tg-join", ButtonKind::Primary, ButtonSize::Normal, self.busy, cx).child("Join").on_click(cx.listener(|dialog, _, _, cx| dialog.telegram_join_submit(cx))))
            .into_any_element();
        self.modal(Some("Join a Telegram group".into()), 440., body, Some(footer), cx)
    }

    pub(super) fn telegram_join_submit(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let link = self.name.read(cx).text().trim().to_string();
        self.busy = true;
        self.link_error = None;
        let task = self.state.update(cx, |state, cx| state.join_telegram_group(link, cx));
        cx.spawn(async move |dialog, cx| {
            let result = task.await;
            dialog
                .update(cx, |dialog, cx| {
                    dialog.busy = false;
                    if let Err(why) = result {
                        dialog.link_error = Some(why);
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_login_link_makes_a_qr_code() {
        assert!(super::qr_image("tg://login?token=AQEGV_ZqeAeVY_LiJgznHZALm63fhhDSJkn8gPrfeYLHVQ").is_some());
    }
}
