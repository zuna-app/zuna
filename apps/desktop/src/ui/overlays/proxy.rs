//! The proxy's dialog, from the first screen, before any server is joined, so that even signing
//! up goes through it: what it is, then the form Settings' Proxy section shows too (ui/proxy.rs).

use super::*;
use crate::ui::proxy::{ProxyEvent, ProxyForm};

impl Dialog {
    /// The form, opened switched on while no proxy was ever set, and the caret in its address.
    pub(super) fn proxy_form(state: &Entity<AppState>, window: &mut Window, subscriptions: &mut Vec<Subscription>, cx: &mut Context<Self>) -> Entity<ProxyForm> {
        let state = state.clone();
        let form = cx.new(|cx| ProxyForm::new(state, true, cx));
        let focus = form.read(cx).focus_handle(cx);
        focus.focus(window, cx);
        subscriptions.push(cx.observe(&form, |_, _, cx| cx.notify()));
        subscriptions.push(cx.subscribe(&form, |dialog, _, event: &ProxyEvent, cx| match event {
            ProxyEvent::Saved | ProxyEvent::Escape => dialog.close(cx),
        }));
        form
    }

    pub(super) fn proxy(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(form) = self.proxy_form.clone() else { return div().into_any_element() };
        let mut body = vec![div().text_size(px(13.5)).child(t("proxy.dialog.intro")).into_any_element()];
        body.extend(form.update(cx, |form, cx| form.body(cx)));
        let (check, save) = form.update(cx, |form, cx| (form.check_button(cx), form.save_button(cx)));
        let footer = div()
            .flex()
            .gap(px(8.))
            .children(check)
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child(t("common.cancel")).on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(save)
            .into_any_element();
        self.modal(Some(t("proxy.dialog.title").into()), 520., body, Some(footer), cx)
    }
}

#[cfg(test)]
mod tests {
    //! The proxy's dialog, short of saving, which would send this process's every connection
    //! through it: the switch, and what its fields must hold before it's tried.

    use std::time::Duration;

    use gpui::TestAppContext;

    use super::*;
    use crate::state::Overlay;
    use crate::testing::{App as Running, World};

    fn form(app: &Running, cx: &mut TestAppContext) -> Entity<ProxyForm> {
        let dialog = app.window.update(cx, |root, _, _| root.overlay.as_ref().and_then(|(_, view)| view.clone().downcast::<Dialog>().ok())).unwrap().expect("the proxy's dialog is up");
        cx.read(|cx| dialog.read(cx).proxy_form.clone()).expect("it holds the form")
    }

    #[gpui::test]
    fn a_proxy_is_checked_only_once_its_fields_make_one(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let app = Running::open(cx, &World::new("proxy-dialog"));
        app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Proxy), cx));
        let view = form(&app, cx);
        let fields = cx.read(|cx| {
            let form = view.read(cx);
            [form.host.clone(), form.port.clone(), form.username.clone(), form.password.clone()]
        });
        let problem = |cx: &mut TestAppContext| cx.read(|cx| view.read(cx).problem.clone());
        let fill = |cx: &mut TestAppContext, values: [&str; 4]| {
            for (field, value) in fields.iter().zip(values) {
                field.update(cx, |input, cx| input.set_text(value, cx));
            }
            app.run(cx);
        };
        // With none set yet, it opens switched on, for one to be written.
        assert!(cx.read(|cx| view.read(cx).on));
        for (values, why) in [
            (["", "1080", "", ""], "Enter the proxy's address: a host name or an IP address."),
            (["proxy example", "1080", "", ""], "Enter the proxy's address: a host name or an IP address."),
            (["proxy.example/socks", "1080", "", ""], "Enter the proxy's address: a host name or an IP address."),
            (["127.0.0.1", "0", "", ""], "The port must be a number from 1 to 65535."),
            (["127.0.0.1", "70000", "", ""], "The port must be a number from 1 to 65535."),
        ] {
            fill(cx, values);
            app.click(cx, "proxy-check");
            assert_eq!(problem(cx).as_deref(), Some(why), "{values:?}");
        }
        let long = "x".repeat(256);
        fill(cx, ["[::1]", "9050", &long, ""]);
        app.click(cx, "proxy-check");
        assert_eq!(problem(cx).as_deref(), Some("SOCKS5 usernames and passwords can be at most 255 bytes each."));
        // Typing again takes what was wrong away.
        fill(cx, ["[::1]", "9050", "me", "secret"]);
        assert_eq!(problem(cx), None);
        assert_eq!(cx.read(|cx| view.read(cx).proxy(cx)).map(|proxy| (proxy.host, proxy.port, proxy.username, proxy.password)), Ok(("::1".into(), 9050, "me".into(), "secret".into())));
        // Switched off, its fields go, and Escape in one closes it.
        app.click(cx, "proxy-on");
        assert!(!cx.read(|cx| view.read(cx).on) && !app.drawn(cx, "proxy-check"));
        app.click(cx, "proxy-on");
        fields[0].update(cx, |_, cx| cx.emit(InputEvent::Escape));
        app.run(cx);
        assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
        assert_eq!(crate::ui::proxy::milliseconds(Duration::from_micros(10)), "1 ms");
    }

    #[gpui::test]
    fn a_checks_report_says_what_worked(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let app = Running::open(cx, &World::new("proxy-report"));
        app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Proxy), cx));
        let view = form(&app, cx);
        let show = |cx: &mut TestAppContext, checking: bool, report: Option<crate::host::net::Report>| {
            view.update(cx, |form, cx| {
                form.checking = checking;
                form.report = report;
                cx.notify();
            });
            app.run(cx);
        };
        // While it's checked, then each way it went.
        show(cx, true, None);
        assert!(app.drawn(cx, "proxy-check"));
        let reached = vec![("Test Server".to_string(), Ok(Duration::from_millis(40))), ("Elsewhere".to_string(), Err("It refused the connection.".to_string()))];
        show(cx, false, Some(crate::host::net::Report { signed_in: Ok(Duration::from_millis(12)), udp: true, servers: reached.clone() }));
        show(cx, false, Some(crate::host::net::Report { signed_in: Ok(Duration::from_millis(12)), udp: false, servers: reached }));
        show(cx, false, Some(crate::host::net::Report { signed_in: Err(crate::host::socks::Failure::Refused), udp: false, servers: Vec::new() }));
        // Typing in a field takes the report away, and Enter there tries to save what's wrong.
        let host = cx.read(|cx| view.read(cx).host.clone());
        host.update(cx, |_, cx| cx.emit(InputEvent::Focused));
        host.update(cx, |input, cx| input.set_text("bad host", cx));
        host.update(cx, |_, cx| cx.emit(InputEvent::Submit));
        app.run(cx);
        assert_eq!(cx.read(|cx| view.read(cx).problem.clone()).as_deref(), Some("Enter the proxy's address: a host name or an IP address."));
        assert!(cx.read(|cx| view.read(cx).report.is_none()));
    }
}
