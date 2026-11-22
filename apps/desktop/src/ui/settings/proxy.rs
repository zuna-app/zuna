//! Proxy: the SOCKS5 proxy everything this device sends goes through, for every server on it
//! (ui/proxy.rs, docs/SOCKS5.md), set here once the first screen is behind.

use super::*;
use crate::ui::proxy::{ProxyEvent, ProxyForm};

impl SettingsView {
    pub(super) fn proxy_page(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let form = match self.proxy_form.clone() {
            Some(form) => form,
            None => {
                let state = self.state.clone();
                let form = cx.new(|cx| ProxyForm::new(state, false, cx));
                self._subscriptions.push(cx.observe(&form, |_, _, cx| cx.notify()));
                self._subscriptions.push(cx.subscribe(&form, |view, _, event: &ProxyEvent, cx| match event {
                    ProxyEvent::Saved => view.state.update(cx, |state, cx| state.toast(t("common.saved"), ToastKind::Info, cx)),
                    ProxyEvent::Escape => view.close(cx),
                }));
                self.proxy_form = Some(form.clone());
                form
            }
        };
        let mut parts = vec![Self::heading(t("settings.proxy.title"), &theme), Self::lead(t("proxy.dialog.intro").into(), &theme)];
        parts.extend(form.update(cx, |form, cx| form.body(cx)));
        let (check, save) = form.update(cx, |form, cx| (form.check_button(cx), form.save_button(cx)));
        parts.push(div().flex().justify_end().gap(px(8.)).children(check).child(save).into_any_element());
        parts
    }
}
