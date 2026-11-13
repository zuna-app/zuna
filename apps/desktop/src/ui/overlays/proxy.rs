//! The proxy everything this device sends goes through (host/net.rs, docs/SOCKS5_PLAN.md):
//! from Settings, Privacy, and from the first screen, before any server is joined, so that even
//! signing up goes through it.

use std::time::Duration;

use super::*;
use crate::host::net::{Proxy, Report};
use crate::settings::ProxySetting;

/// What's being set: the switch, the four fields, and what Check found.
pub(super) struct ProxyForm {
    on: bool,
    host: Entity<TextInput>,
    port: Entity<TextInput>,
    username: Entity<TextInput>,
    password: Entity<TextInput>,
    /// A password is kept already, which an empty field leaves as it is.
    kept_password: bool,
    checking: bool,
    report: Option<Report>,
    problem: Option<String>,
}

/// Where the proxy's fields are among the dialog's, for `focused`.
const FIRST_FIELD: usize = 10;

impl ProxyForm {
    pub(super) fn new(state: &Entity<AppState>, window: &mut Window, subscriptions: &mut Vec<Subscription>, cx: &mut Context<Dialog>) -> ProxyForm {
        let setting = state.read(cx).settings.proxy.clone();
        let make = |placeholder: &str, text: String, masked: bool, cx: &mut Context<Dialog>| {
            cx.new(|cx| {
                let mut input = TextInput::new(cx, placeholder.to_string()).masked(masked);
                input.set_text(text, cx);
                input
            })
        };
        let host = make("127.0.0.1 or proxy.example.com", setting.host.clone(), false, cx);
        let port = make("1080", if setting.port == 0 { String::new() } else { setting.port.to_string() }, false, cx);
        let username = make("Optional", setting.username.clone(), false, cx);
        let kept_password = !setting.username.is_empty() && ProxySetting::kept_password().is_some();
        let password = make(if kept_password { "Kept on this device" } else { "Optional" }, String::new(), true, cx);
        for (index, input) in [&host, &port, &username, &password].into_iter().enumerate() {
            subscriptions.push(cx.subscribe_in(input, window, move |dialog, _, event, _, cx| {
                match event {
                    InputEvent::Focused => dialog.focused = Some(FIRST_FIELD + index),
                    InputEvent::Blurred if dialog.focused == Some(FIRST_FIELD + index) => dialog.focused = None,
                    InputEvent::Escape => dialog.close(cx),
                    InputEvent::Submit => dialog.save_proxy(cx),
                    InputEvent::Changed => {
                        if let Some(form) = dialog.proxy_form.as_mut() {
                            form.report = None;
                            form.problem = None;
                        }
                    }
                    _ => {}
                }
                cx.notify();
            }));
        }
        host.focus_handle(cx).focus(window, cx);
        ProxyForm { on: setting.on || setting.host.is_empty(), host, port, username, password, kept_password, checking: false, report: None, problem: None }
    }

    /// The proxy as the fields have it, with the kept password where none was typed, or why it can't be one.
    fn proxy(&self, cx: &App) -> Result<Proxy, String> {
        let host = self.host.read(cx).text().trim().trim_start_matches('[').trim_end_matches(']').to_string();
        if host.is_empty() || host.contains(char::is_whitespace) || host.contains('/') {
            return Err("Give the proxy's address: a name or an IP address.".into());
        }
        let port = self.port.read(cx).text().trim().parse::<u16>().ok().filter(|port| *port > 0).ok_or("The port is a number from 1 to 65535.")?;
        let username = self.username.read(cx).text().to_string();
        let typed = self.password.read(cx).text().to_string();
        if username.len() > 255 || typed.len() > 255 {
            return Err("SOCKS5 carries a username and a password of at most 255 bytes each.".into());
        }
        let password = if username.is_empty() {
            String::new()
        } else if typed.is_empty() && self.kept_password {
            ProxySetting::kept_password().unwrap_or_default()
        } else {
            typed
        };
        Ok(Proxy { host, port, username, password })
    }
}

impl Dialog {
    pub(super) fn proxy(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(form) = self.proxy_form.as_ref() else { return div().into_any_element() };
        let on = form.on;
        let focused = |index: usize| self.focused == Some(FIRST_FIELD + index);
        let mut body = vec![
            div()
                .text_size(px(13.5))
                .child("Everything this device sends can go through a SOCKS5 proxy you choose, for every server you've joined: messages, files, link previews, updates and plugins. Your servers then see the proxy's address rather than yours. The proxy sees which servers you reach, when and how much, but nothing you send, which stays encrypted.")
                .into_any_element(),
            div()
                .flex()
                .items_center()
                .gap(px(16.))
                .child(div().flex_1().text_size(px(14.)).font_weight(FontWeight::MEDIUM).child("Connect through a proxy"))
                .child(switch("proxy-on", on, cx).on_click(cx.listener(|dialog, _, _, cx| {
                    if let Some(form) = dialog.proxy_form.as_mut() {
                        form.on = !form.on;
                        form.problem = None;
                    }
                    cx.notify();
                })))
                .into_any_element(),
        ];
        if on {
            body.push(
                div()
                    .flex()
                    .gap(px(10.))
                    .child(div().flex_1().min_w_0().child(field(Some("Address"), form.host.clone(), None, None, focused(0), None, cx)))
                    .child(div().w(px(96.)).flex_none().child(field(Some("Port"), form.port.clone(), None, None, focused(1), None, cx)))
                    .into_any_element(),
            );
            body.push(
                div()
                    .flex()
                    .gap(px(10.))
                    .child(div().flex_1().min_w_0().child(field(Some("Username"), form.username.clone(), None, None, focused(2), None, cx)))
                    .child(div().flex_1().min_w_0().child(field(Some("Password"), form.password.clone(), None, None, focused(3), None, cx)))
                    .into_any_element(),
            );
            body.push(
                div()
                    .text_size(px(12.5))
                    .text_color(theme.text2)
                    .child("While the proxy can't be reached, Zuna connects to nothing, and never goes around it. SOCKS5 isn't encrypted on the way to the proxy, so its password and the names of your servers cross that stretch as they are: a proxy on this computer, such as Tor or ssh -D, has none. Voice, calls and watching YouTube together don't go through a proxy yet, so they're off while one is set.")
                    .into_any_element(),
            );
        }
        if let Some(problem) = &form.problem {
            body.push(div().text_size(px(13.)).text_color(theme.danger_text).child(problem.clone()).into_any_element());
        }
        if form.checking {
            body.push(div().text_size(px(13.)).text_color(theme.text2).child("Checking…").into_any_element());
        }
        if let Some(report) = &form.report {
            let line = |good: bool, text: String| {
                div()
                    .flex()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .child(icon(if good { "check" } else { "x" }, 15., if good { theme.green } else { theme.red }))
                    .child(div().flex_1().min_w_0().child(text))
                    .into_any_element()
            };
            let mut lines = Vec::new();
            match &report.signed_in {
                Ok(took) => {
                    lines.push(line(true, format!("Signed in to the proxy in {}.", milliseconds(*took))));
                    lines.push(if report.udp {
                        line(true, "It carries UDP, which calls use.".into())
                    } else {
                        line(false, "It doesn't carry UDP, so calls through it would go over TCP, and may sound worse.".into())
                    });
                }
                Err(failure) => lines.push(line(false, failure.to_string())),
            }
            for (name, reached) in &report.servers {
                lines.push(match reached {
                    Ok(took) => line(true, format!("Reached {name} through it in {}.", milliseconds(*took))),
                    Err(why) => line(false, format!("{name}: {why}")),
                });
            }
            body.push(div().flex().flex_col().gap(px(6.)).p(px(12.)).rounded(RADIUS_M).bg(theme.bg2).children(lines).into_any_element());
        }
        let busy = self.busy || form.checking;
        let footer = div()
            .flex()
            .gap(px(8.))
            .when(on, |el| el.child(button("proxy-check", ButtonKind::Default, ButtonSize::Normal, busy, cx).child("Check").on_click(cx.listener(|dialog, _, _, cx| dialog.check_proxy(cx)))))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("proxy-save", ButtonKind::Primary, ButtonSize::Normal, busy, cx).child("Save").on_click(cx.listener(|dialog, _, _, cx| dialog.save_proxy(cx))))
            .into_any_element();
        self.modal(Some("Proxy".into()), 520., body, Some(footer), cx)
    }

    /// Signs in to the proxy as it's written, and reaches each server joined through it.
    fn check_proxy(&mut self, cx: &mut Context<Self>) {
        let servers: Vec<(String, String)> = self.state.read(cx).servers.values().map(|server| (server.entry.name.clone(), server.entry.url.clone())).collect();
        let Some(form) = self.proxy_form.as_mut() else { return };
        let proxy = match form.proxy(cx) {
            Ok(proxy) => proxy,
            Err(problem) => {
                form.problem = Some(problem);
                cx.notify();
                return;
            }
        };
        form.checking = true;
        form.report = None;
        form.problem = None;
        let task = crate::host::tokio().spawn(crate::host::net::check(proxy, servers));
        cx.spawn(async move |dialog, cx| {
            let report = task.await.ok();
            dialog
                .update(cx, |dialog, cx| {
                    if let Some(form) = dialog.proxy_form.as_mut() {
                        form.checking = false;
                        form.report = report;
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
        cx.notify();
    }

    /// Keeps the setting and goes through the proxy from now on, or stops: every connection
    /// open ends, a call in progress with it, and opens again the new way.
    fn save_proxy(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.proxy_form.as_mut() else { return };
        let setting = if form.on {
            let proxy = match form.proxy(cx) {
                Ok(proxy) => proxy,
                Err(problem) => {
                    form.problem = Some(problem);
                    cx.notify();
                    return;
                }
            };
            if let Err(error) = ProxySetting::keep_password(&proxy.password) {
                form.problem = Some(format!("The password couldn't be kept: {error}"));
                cx.notify();
                return;
            }
            ProxySetting { on: true, host: proxy.host, port: proxy.port, username: proxy.username }
        } else {
            ProxySetting { on: false, ..self.state.read(cx).settings.proxy.clone() }
        };
        self.state.update(cx, |state, cx| state.update_settings(|settings| settings.proxy = setting.clone(), cx));
        crate::state::apply_proxy(&self.state, cx);
        self.close(cx);
    }
}

fn milliseconds(took: Duration) -> String {
    format!("{} ms", took.as_millis().max(1))
}
