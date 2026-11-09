//! Sharing where this device is, as the system finds it.

use super::*;

impl Dialog {
    /// Asks Windows where this device is, away from the window.
    pub(super) fn locate(&mut self, cx: &mut Context<Self>) {
        self.location = None;
        cx.notify();
        cx.spawn(async move |dialog, cx| {
            let found = cx.background_executor().spawn(async { crate::platform::location::locate() }).await;
            dialog
                .update(cx, |dialog, cx| {
                    dialog.location = Some(found);
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    /// Finds where this device is and, once that's shown, sends it to a chat (ShareLocation.tsx).
    pub(super) fn share_location(&mut self, key: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let text: AnyElement = match &self.location {
            Some(Ok((lat, lon, accuracy))) => div()
                .flex()
                .flex_col()
                .gap(px(1.))
                .text_size(px(13.))
                .child(div().font_weight(FontWeight::SEMIBOLD).child("Your current location"))
                .child(crate::format::coordinates_text(*lat, *lon))
                .when_some(*accuracy, |el, meters| el.child(div().text_color(theme.text3).child(crate::format::accuracy_text(meters))))
                .into_any_element(),
            Some(Err(error)) => div().text_size(px(13.)).child(error.clone()).into_any_element(),
            None => div().flex().items_center().gap(px(8.)).text_size(px(13.)).child(spinner(14., theme.text2)).child("Finding where you are…").into_any_element(),
        };
        let body = vec![
            div()
                .flex()
                .items_center()
                .gap(px(14.))
                .pt(px(6.))
                .pb(px(12.))
                .child(div().size(px(52.)).flex_none().rounded_full().bg(theme.accent).flex().items_center().justify_center().child(icon("map-pin", 26., theme.on_accent)))
                .child(text)
                .into_any_element(),
            div().text_size(px(12.5)).text_color(theme.text3).child("It's sent encrypted, like a message. Nobody else learns it, unless someone opens it on a map.").into_any_element(),
        ];
        let busy = self.busy;
        let found = match &self.location {
            Some(Ok(found)) => Some(*found),
            _ => None,
        };
        let failed = matches!(self.location, Some(Err(_)));
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(if failed {
                button("retry-location", ButtonKind::Primary, ButtonSize::Normal, false, cx).child("Try again").on_click(cx.listener(|dialog, _, _, cx| dialog.locate(cx)))
            } else {
                button("send-location", ButtonKind::Primary, ButtonSize::Normal, found.is_none() || busy, cx).child(if busy { "Sending…" } else { "Send location" }).when_some(found.filter(|_| !busy), |el, (lat, lon, accuracy)| {
                    el.on_click(cx.listener(move |dialog, _, _, cx| {
                        dialog.busy = true;
                        let mut location = json!({ "lat": lat, "lon": lon });
                        if let Some(meters) = accuracy {
                            location["accuracy"] = json!(meters);
                        }
                        let key = key.clone();
                        dialog.state.update(cx, |state, cx| {
                            let server = state.active_server.clone();
                            state.call(server.as_deref(), "sendMessage", vec![json!(key), json!({ "location": location })], cx, |state, result, cx| match result {
                                Ok(_) => state.set_overlay(None, cx),
                                Err(error) => state.toast(error.message, ToastKind::Error, cx),
                            });
                        });
                        cx.notify();
                    }))
                })
            });
        self.modal(Some("Share location".into()), 400., body, Some(footer.into_any_element()), cx)
    }
}
