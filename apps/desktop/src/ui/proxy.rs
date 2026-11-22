//! The proxy everything this device sends goes through (host/net.rs, docs/SOCKS5.md): the form
//! Settings' Proxy section shows, and the dialog from the first screen, before any server is
//! joined, so that even signing up goes through it.

use std::time::Duration;

use gpui::{AnyElement, App, Context, Entity, EventEmitter, FontWeight, IntoElement, ParentElement, Styled, Subscription, div, prelude::*, px};
use gpui::Focusable as _;

use super::components::*;
use super::text_input::{InputEvent, TextInput};
use crate::host::net::{Proxy, Report};
use crate::i18n::t;
use crate::settings::ProxySetting;
use crate::state::AppState;
use crate::theme::RADIUS_M;

/// What's being set: the switch, the four fields, and what Check found.
pub struct ProxyForm {
    state: Entity<AppState>,
    pub(super) on: bool,
    pub(super) host: Entity<TextInput>,
    pub(super) port: Entity<TextInput>,
    pub(super) username: Entity<TextInput>,
    pub(super) password: Entity<TextInput>,
    /// A password is kept already, which an empty field leaves as it is.
    kept_password: bool,
    /// Which of the four fields has focus.
    focused: Option<usize>,
    pub(super) checking: bool,
    pub(super) report: Option<Report>,
    pub(super) problem: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// What whoever shows the form hears of it: it was saved, or Escape was pressed in a field.
pub enum ProxyEvent {
    Saved,
    Escape,
}

impl EventEmitter<ProxyEvent> for ProxyForm {}

impl ProxyForm {
    /// The form as the setting has it. `on_if_unset` opens it switched on while no proxy was
    /// ever written, for one to be, as the first screen's dialog does.
    pub fn new(state: Entity<AppState>, on_if_unset: bool, cx: &mut Context<Self>) -> ProxyForm {
        let setting = state.read(cx).settings.proxy.clone();
        let make = |placeholder: &str, text: String, masked: bool, cx: &mut Context<Self>| {
            cx.new(|cx| {
                let mut input = TextInput::new(cx, placeholder.to_string()).masked(masked);
                input.set_text(text, cx);
                input
            })
        };
        let host = make(t("proxy.dialog.addressPlaceholder"), setting.host.clone(), false, cx);
        let port = make("1080", if setting.port == 0 { String::new() } else { setting.port.to_string() }, false, cx);
        let username = make(t("common.optional"), setting.username.clone(), false, cx);
        let kept_password = !setting.username.is_empty() && ProxySetting::kept_password().is_some();
        let password = make(if kept_password { t("proxy.dialog.passwordKept") } else { t("common.optional") }, String::new(), true, cx);
        let mut subscriptions = Vec::new();
        for (index, input) in [&host, &port, &username, &password].into_iter().enumerate() {
            subscriptions.push(cx.subscribe(input, move |form, _, event, cx| {
                match event {
                    InputEvent::Focused => form.focused = Some(index),
                    InputEvent::Blurred if form.focused == Some(index) => form.focused = None,
                    InputEvent::Escape => cx.emit(ProxyEvent::Escape),
                    InputEvent::Submit => form.save(cx),
                    InputEvent::Changed => {
                        form.report = None;
                        form.problem = None;
                    }
                    _ => {}
                }
                cx.notify();
            }));
        }
        ProxyForm {
            state,
            on: setting.on || (on_if_unset && setting.host.is_empty()),
            host,
            port,
            username,
            password,
            kept_password,
            focused: None,
            checking: false,
            report: None,
            problem: None,
            _subscriptions: subscriptions,
        }
    }

    /// The address's, to put the caret in.
    pub fn focus_handle(&self, cx: &App) -> gpui::FocusHandle {
        self.host.focus_handle(cx)
    }

    /// The switch, the fields while it's on, and what's wrong or what Check found.
    pub fn body(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let on = self.on;
        let focused = |index: usize| self.focused == Some(index);
        let mut body = vec![
            div()
                .flex()
                .items_center()
                .gap(px(16.))
                .child(div().flex_1().text_size(px(14.)).font_weight(FontWeight::MEDIUM).child(t("proxy.dialog.switch")))
                .child(switch("proxy-on", on, cx).on_click(cx.listener(|form, _, _, cx| {
                    form.on = !form.on;
                    form.problem = None;
                    cx.notify();
                })))
                .into_any_element(),
        ];
        if on {
            body.push(
                div()
                    .flex()
                    .gap(px(10.))
                    .child(div().flex_1().min_w_0().child(field(Some(t("proxy.dialog.address")), self.host.clone(), None, None, focused(0), None, cx)))
                    .child(div().w(px(96.)).flex_none().child(field(Some(t("proxy.dialog.port")), self.port.clone(), None, None, focused(1), None, cx)))
                    .into_any_element(),
            );
            body.push(
                div()
                    .flex()
                    .gap(px(10.))
                    .child(div().flex_1().min_w_0().child(field(Some(t("proxy.dialog.username")), self.username.clone(), None, None, focused(2), None, cx)))
                    .child(div().flex_1().min_w_0().child(field(Some(t("common.password")), self.password.clone(), None, None, focused(3), None, cx)))
                    .into_any_element(),
            );
            body.push(
                div()
                    .text_size(px(12.5))
                    .text_color(theme.text2)
                    .child(if cfg!(target_os = "macos") { t("proxy.dialog.warning") } else { t("proxy.dialog.warningNoWatch") })
                    .into_any_element(),
            );
        }
        if let Some(problem) = &self.problem {
            body.push(div().text_size(px(13.)).text_color(theme.danger_text).child(problem.clone()).into_any_element());
        }
        if self.checking {
            body.push(div().text_size(px(13.)).text_color(theme.text2).child(t("proxy.dialog.checking")).into_any_element());
        }
        if let Some(report) = &self.report {
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
                    lines.push(line(true, tr!("proxy.check.connected", time = milliseconds(*took))));
                    lines.push(if report.udp {
                        line(true, t("proxy.check.udp").into())
                    } else {
                        line(false, t("proxy.check.noUdp").into())
                    });
                }
                Err(failure) => lines.push(line(false, failure.to_string())),
            }
            for (name, reached) in &report.servers {
                lines.push(match reached {
                    Ok(took) => line(true, tr!("proxy.check.reached", server = name, time = milliseconds(*took))),
                    Err(why) => line(false, tr!("proxy.check.failed", server = name, reason = why)),
                });
            }
            body.push(div().flex().flex_col().gap(px(6.)).p(px(12.)).rounded(RADIUS_M).bg(theme.bg2).children(lines).into_any_element());
        }
        body
    }

    /// Check, while the switch is on.
    pub fn check_button(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.on.then(|| button("proxy-check", ButtonKind::Default, ButtonSize::Normal, self.checking, cx).child(t("proxy.dialog.check")).on_click(cx.listener(|form, _, _, cx| form.check(cx))).into_any_element())
    }

    pub fn save_button(&mut self, cx: &mut Context<Self>) -> AnyElement {
        button("proxy-save", ButtonKind::Primary, ButtonSize::Normal, self.checking, cx).child(t("common.save")).on_click(cx.listener(|form, _, _, cx| form.save(cx))).into_any_element()
    }

    /// The proxy as the fields have it, with the kept password where none was typed, or why it can't be one.
    pub(super) fn proxy(&self, cx: &App) -> Result<Proxy, String> {
        let host = self.host.read(cx).text().trim().trim_start_matches('[').trim_end_matches(']').to_string();
        if host.is_empty() || host.contains(char::is_whitespace) || host.contains('/') {
            return Err(t("proxy.dialog.badAddress").into());
        }
        let port = self.port.read(cx).text().trim().parse::<u16>().ok().filter(|port| *port > 0).ok_or(t("proxy.dialog.badPort"))?;
        let username = self.username.read(cx).text().to_string();
        let typed = self.password.read(cx).text().to_string();
        if username.len() > 255 || typed.len() > 255 {
            return Err(t("proxy.dialog.tooLong").into());
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

    /// Signs in to the proxy as it's written, and reaches each server joined through it.
    fn check(&mut self, cx: &mut Context<Self>) {
        let servers: Vec<(String, String)> = self.state.read(cx).servers.values().map(|server| (server.entry.name.clone(), server.entry.url.clone())).collect();
        let proxy = match self.proxy(cx) {
            Ok(proxy) => proxy,
            Err(problem) => {
                self.problem = Some(problem);
                cx.notify();
                return;
            }
        };
        self.checking = true;
        self.report = None;
        self.problem = None;
        let task = crate::host::tokio().spawn(crate::host::net::check(proxy, servers));
        cx.spawn(async move |form, cx| {
            let report = task.await.ok();
            form.update(cx, |form, cx| {
                form.checking = false;
                form.report = report;
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Keeps the setting and goes through the proxy from now on, or stops: every connection
    /// open ends, a call in progress with it, and opens again the new way.
    fn save(&mut self, cx: &mut Context<Self>) {
        let setting = if self.on {
            let proxy = match self.proxy(cx) {
                Ok(proxy) => proxy,
                Err(problem) => {
                    self.problem = Some(problem);
                    cx.notify();
                    return;
                }
            };
            if let Err(error) = ProxySetting::keep_password(&proxy.password) {
                self.problem = Some(tr!("proxy.dialog.saveFailed", error = error));
                cx.notify();
                return;
            }
            // The password typed is the one kept now, which the field no longer holds.
            self.kept_password = !proxy.username.is_empty();
            let placeholder = if self.kept_password { t("proxy.dialog.passwordKept") } else { t("common.optional") };
            self.password.update(cx, |input, cx| {
                input.set_text(String::new(), cx);
                input.set_placeholder(placeholder, cx);
            });
            ProxySetting { on: true, host: proxy.host, port: proxy.port, username: proxy.username }
        } else {
            ProxySetting { on: false, ..self.state.read(cx).settings.proxy.clone() }
        };
        self.problem = None;
        self.state.update(cx, |state, cx| state.update_settings(|settings| settings.proxy = setting.clone(), cx));
        crate::state::apply_proxy(&self.state, cx);
        cx.emit(ProxyEvent::Saved);
        cx.notify();
    }
}

pub(super) fn milliseconds(took: Duration) -> String {
    tr!("proxy.check.milliseconds", ms = took.as_millis().max(1))
}
