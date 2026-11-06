//! Joining with an invite, signing in and recovering an account
//! (packages/ui/src/features/onboarding/Onboarding.tsx).

use std::time::Duration;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, Window, div, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::text_input::{InputEvent, TextInput};
use crate::format::MIN_PASSWORD;
use crate::models::{InvitePreview, Registered, from_value};
use crate::state::AppState;
use crate::theme::{self, FONT_MONO, RADIUS_M};

#[derive(Clone)]
enum Step {
    Welcome,
    Link,
    Invite(InvitePreview),
    RecoveryKey { server_id: String, recovery_key: String, setup: bool },
    NameServer { server_id: String },
    SignIn,
    Recover { url: String, username: String },
}

pub struct Onboarding {
    state: Entity<AppState>,
    step: Step,
    /// Inside the app, for another server: the link comes first, and there's no welcome.
    embedded: bool,
    link: Entity<TextInput>,
    display_name: Entity<TextInput>,
    username: Entity<TextInput>,
    password: Entity<TextInput>,
    confirm: Entity<TextInput>,
    server: Entity<TextInput>,
    recovery: Entity<TextInput>,
    server_name: Entity<TextInput>,
    focused: Option<usize>,
    show_password: bool,
    username_edited: bool,
    error: Option<String>,
    busy: bool,
    saved: bool,
    copied: bool,
    strength: (u8, String),
    rating: Option<Task<()>>,
    /// A field to focus on the next frame, after a step changes outside `go`.
    pending_focus: Option<Entity<TextInput>>,
    _subscriptions: Vec<Subscription>,
}

fn describe_error(message: &str) -> String {
    if message.contains("Load failed") || message.contains("error sending request") || message.contains("connect") {
        "Couldn't reach that server. Check the address and your connection.".into()
    } else {
        message.to_string()
    }
}

fn suggest_username(name: &str) -> String {
    let lowered: String = name.chars().filter(|c| c.is_ascii() || c.is_alphanumeric()).collect::<String>().to_lowercase();
    let mut out = String::new();
    let mut last_sep = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
            out.push(ch);
            last_sep = false;
        } else if !last_sep {
            out.push('_');
            last_sep = true;
        }
    }
    out.trim_matches(|c| c == '.' || c == '_' || c == '-').chars().take(32).collect()
}

fn valid_username(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else { return false };
    (first.is_ascii_alphanumeric() || first == '_') && name.len() >= 2 && name.len() <= 32 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

impl Onboarding {
    pub fn new(state: Entity<AppState>, sign_in_url: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(state, sign_in_url, None, false, window, cx)
    }

    pub fn embedded(state: Entity<AppState>, link: Option<String>, sign_in_url: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(state, sign_in_url, link, true, window, cx)
    }

    fn build(state: Entity<AppState>, sign_in_url: Option<String>, link: Option<String>, embedded: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let inputs: Vec<Entity<TextInput>> = [
            ("https://chat.example.com/invite/...", false),
            ("How people will see you", false),
            ("alex", false),
            ("", true),
            ("", true),
            ("chat.example.com", false),
            ("", false),
            ("Our corner of the internet", false),
        ]
        .into_iter()
        .map(|(placeholder, masked)| cx.new(|cx| TextInput::new(cx, placeholder).masked(masked)))
        .collect();
        let mut subscriptions = vec![cx.observe(&state, |_, _, cx| cx.notify())];
        for (index, input) in inputs.iter().enumerate() {
            subscriptions.push(cx.subscribe_in(input, window, move |view, _, event, window, cx| view.on_input(index, event, window, cx)));
        }
        let step = if sign_in_url.is_some() { Step::SignIn } else if embedded { Step::Link } else { Step::Welcome };
        let mut view = Onboarding {
            state,
            step,
            embedded,
            link: inputs[0].clone(),
            display_name: inputs[1].clone(),
            username: inputs[2].clone(),
            password: inputs[3].clone(),
            confirm: inputs[4].clone(),
            server: inputs[5].clone(),
            recovery: inputs[6].clone(),
            server_name: inputs[7].clone(),
            focused: None,
            show_password: false,
            username_edited: false,
            error: None,
            busy: false,
            saved: false,
            copied: false,
            strength: (0, String::new()),
            rating: None,
            pending_focus: None,
            _subscriptions: subscriptions,
        };
        if let Some(url) = sign_in_url {
            view.server.update(cx, |input, cx| input.set_text(url, cx));
        }
        if let Some(link) = link {
            view.link.update(cx, |input, cx| input.set_text(link, cx));
            view.preview_invite(cx);
        }
        view
    }

    fn on_input(&mut self, index: usize, event: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            InputEvent::Focused => self.focused = Some(index),
            InputEvent::Blurred => {
                if self.focused == Some(index) {
                    self.focused = None;
                }
            }
            InputEvent::Changed => {
                self.error = None;
                if index == 1 && !self.username_edited {
                    let suggested = suggest_username(self.display_name.read(cx).text());
                    self.username.update(cx, |input, cx| input.set_text(suggested, cx));
                    self.username_edited = false;
                }
                if index == 2 && self.focused == Some(2) {
                    self.username_edited = true;
                }
                if index == 3 || index == 1 || index == 2 {
                    self.rate_password(cx);
                }
            }
            InputEvent::Submit => self.submit(window, cx),
            _ => {}
        }
        cx.notify();
    }

    fn rate_password(&mut self, cx: &mut Context<Self>) {
        let password = self.password.read(cx).text().to_string();
        let related = vec![self.username.read(cx).text().to_string(), self.display_name.read(cx).text().to_string()];
        let rating = self.state.read(cx).core.password_strength(password, related);
        self.rating = Some(cx.spawn(async move |view, cx| {
            let strength = rating.await;
            view.update(cx, |view, cx| {
                view.strength = strength;
                cx.notify();
            })
            .ok();
        }));
    }

    fn go(&mut self, step: Step, window: &mut Window, cx: &mut Context<Self>) {
        self.step = step;
        self.error = None;
        self.busy = false;
        match &self.step {
            Step::Link => self.link.read(cx).focus(window),
            Step::Invite(_) => self.display_name.read(cx).focus(window),
            Step::SignIn => self.server.read(cx).focus(window),
            Step::Recover { .. } => self.recovery.read(cx).focus(window),
            Step::NameServer { .. } => self.server_name.read(cx).focus(window),
            _ => {}
        }
        cx.notify();
    }

    fn preview_invite(&mut self, cx: &mut Context<Self>) {
        let link = self.link.read(cx).text().trim().to_string();
        if link.is_empty() {
            return;
        }
        self.busy = true;
        self.error = None;
        let call = self.state.read(cx).core.call(None, "previewInvite", vec![json!(link)]);
        cx.spawn_in_window_or_detached(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok(value) => {
                        view.step = Step::Invite(from_value(value));
                        view.pending_focus = Some(view.display_name.clone());
                    }
                    Err(error) => view.error = Some(describe_error(&error.message)),
                }
                cx.notify();
            })
            .ok();
        });
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        match self.step.clone() {
            Step::Link => self.preview_invite(cx),
            Step::Invite(preview) => {
                let display_name = self.display_name.read(cx).text().trim().to_string();
                let username = self.username.read(cx).text().to_string();
                let password = self.password.read(cx).text().to_string();
                let confirm = self.confirm.read(cx).text().to_string();
                if display_name.is_empty() || !valid_username(&username) || password.chars().count() < MIN_PASSWORD || self.strength.0 < 2 || confirm != password {
                    return;
                }
                self.busy = true;
                let call = self.state.read(cx).core.call(None, "register", vec![serde_json::to_value(&preview).unwrap_or_default(), json!(username), json!(password), json!({ "displayName": display_name })]);
                let setup = preview.setup;
                cx.spawn_in_window_or_detached(async move |view, cx| {
                    let result = call.await;
                    view.update(cx, |view, cx| {
                        view.busy = false;
                        match result {
                            Ok(value) => {
                                let registered: Registered = from_value(value);
                                view.step = Step::RecoveryKey { server_id: registered.server_id, recovery_key: registered.recovery_key, setup };
                            }
                            Err(error) => view.error = Some(describe_error(&error.message)),
                        }
                        cx.notify();
                    })
                    .ok();
                });
            }
            Step::RecoveryKey { server_id, setup, .. } => {
                if !self.saved {
                    return;
                }
                if setup {
                    self.go(Step::NameServer { server_id }, window, cx);
                } else {
                    self.finish(server_id, cx);
                }
            }
            Step::NameServer { server_id } => {
                let name = self.server_name.read(cx).text().trim().to_string();
                if name.is_empty() {
                    self.finish(server_id, cx);
                    return;
                }
                self.busy = true;
                let call = self.state.read(cx).core.call(Some(&server_id), "updateServerSettings", vec![json!({ "name": name })]);
                cx.spawn_in_window_or_detached(async move |view, cx| {
                    let result = call.await;
                    view.update(cx, |view, cx| {
                        view.busy = false;
                        match result {
                            Ok(_) => view.finish(server_id, cx),
                            Err(error) => view.error = Some(error.message),
                        }
                        cx.notify();
                    })
                    .ok();
                });
            }
            Step::SignIn => {
                let url = self.server.read(cx).text().trim().to_string();
                let username = self.username.read(cx).text().trim().to_string();
                let password = self.password.read(cx).text().to_string();
                if url.is_empty() || username.is_empty() || password.is_empty() {
                    return;
                }
                self.busy = true;
                let call = self.state.read(cx).core.call(None, "login", vec![json!(url), json!(username), json!(password)]);
                cx.spawn_in_window_or_detached(async move |view, cx| {
                    let result = call.await;
                    view.update(cx, |view, cx| {
                        view.busy = false;
                        match result {
                            Ok(value) => view.finish(value.as_str().unwrap_or_default().to_string(), cx),
                            Err(error) => view.error = Some(describe_error(&error.message)),
                        }
                        cx.notify();
                    })
                    .ok();
                });
            }
            Step::Recover { url, username } => {
                let key = self.recovery.read(cx).text().trim().to_string();
                let password = self.password.read(cx).text().to_string();
                let confirm = self.confirm.read(cx).text().to_string();
                if key.is_empty() || password.chars().count() < MIN_PASSWORD || self.strength.0 < 2 || confirm != password {
                    return;
                }
                self.busy = true;
                let call = self.state.read(cx).core.call(None, "recover", vec![json!(url), json!(username), json!(key), json!(password)]);
                cx.spawn_in_window_or_detached(async move |view, cx| {
                    let result = call.await;
                    view.update(cx, |view, cx| {
                        view.busy = false;
                        match result {
                            Ok(value) => view.finish(value.as_str().unwrap_or_default().to_string(), cx),
                            Err(error) => view.error = Some(describe_error(&error.message)),
                        }
                        cx.notify();
                    })
                    .ok();
                });
            }
            Step::Welcome => {}
        }
    }

    fn finish(&mut self, server_id: String, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.add_server(server_id, cx));
    }

    fn header(&self, icon_name: Option<&str>, title: String, text: Option<String>, back: Option<Step>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        div()
            .relative()
            .flex()
            .flex_col()
            .items_center()
            .text_center()
            .gap(px(6.))
            .when_some(back, |el, back| {
                el.child(div().absolute().left(px(-6.)).top(px(-4.)).child(icon_button("back", "arrow-left", 18., false, false, cx).on_click(cx.listener(move |view, _, window, cx| view.go(back.clone(), window, cx)))))
            })
            .when_some(icon_name, |el, name| el.child(div().mb(px(4.)).child(icon(name, 26., theme.text2))))
            .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(title))
            .when_some(text, |el, text| el.child(div().text_size(px(13.5)).text_color(theme.text2).child(text)))
            .into_any_element()
    }

    fn input_field(&self, index: usize, input: &Entity<TextInput>, label: Option<&str>, hint: Option<&str>, error: Option<String>, suffix: Option<AnyElement>, cx: &mut Context<Self>) -> AnyElement {
        field(label, input.clone(), error, hint.map(str::to_string), self.focused == Some(index), suffix, cx).into_any_element()
    }

    fn password_suffix(&self, cx: &mut Context<Self>) -> AnyElement {
        let visible = self.show_password;
        icon_button("toggle-password", if visible { "eye-off" } else { "eye" }, 15., true, false, cx)
            .on_click(cx.listener(|view, _, _, cx| {
                view.show_password = !view.show_password;
                let masked = !view.show_password;
                view.password.update(cx, |input, cx| input.set_masked(masked, cx));
                view.confirm.update(cx, |input, cx| input.set_masked(masked, cx));
                cx.notify();
            }))
            .into_any_element()
    }

    fn strength_meter(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let (score, label) = &self.strength;
        let colors = [theme.bg5, theme.red, theme.amber, theme.text2, theme.green];
        let typed = !self.password.read(cx).text().is_empty();
        let label = if label.is_empty() || !typed { format!("At least {MIN_PASSWORD} characters") } else { label.clone() };
        let color = if *score > 0 && typed { colors[*score as usize] } else { theme.text3 };
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(18.))
            .mt(px(3.))
            .text_size(px(12.))
            .child(div().flex().gap(px(3.)).w(px(84.)).flex_none().children((1..=4u8).map(|bar| {
                div().h(px(3.)).flex_1().rounded(px(3.)).bg(if typed && *score >= bar { colors[*score as usize] } else { theme.bg4 })
            })))
            .child(div().text_color(color).child(label))
            .into_any_element()
    }

    fn primary(&self, id: &'static str, label: &str, enabled: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let busy = self.busy;
        button(id, ButtonKind::Primary, ButtonSize::Large, !enabled || busy, cx)
            .w_full()
            .when(busy, |el| el.child(spinner(18., theme.text3)))
            .when(!busy, |el| el.child(label.to_string()))
            .when(enabled && !busy, |el| el.on_click(cx.listener(|view, _, window, cx| view.submit(window, cx))))
            .into_any_element()
    }

    fn welcome(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let chip = |icon_name: &str, label: &str| {
            div()
                .flex()
                .items_center()
                .gap(px(5.))
                .px(px(10.))
                .py(px(4.))
                .rounded_full()
                .bg(theme.bg2)
                .text_color(theme.text2)
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .child(icon(icon_name, 13., theme.text2))
                .child(label.to_string())
        };
        vec![
            div()
                .flex()
                .flex_col()
                .items_center()
                .text_center()
                .gap(px(6.))
                .child(div().mb(px(14.)).child(logo(64.)))
                .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child("Welcome to Zuna"))
                .child(div().text_size(px(13.5)).text_color(theme.text2).child("Private chat on servers you and your friends run."))
                // Two rows, as they wrap at this width on the desktop. GPUI measures a wrapping
                // row as one line when centering, which would put everything lower.
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(6.))
                        .mt(px(10.))
                        .child(div().flex().gap(px(6.)).child(chip("lock", "End-to-end encrypted")).child(chip("shield-check", "Open source")))
                        .child(chip("server", "Self-hosted")),
                )
                .into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .mt(px(16.))
                .child(
                    button("join", ButtonKind::Primary, ButtonSize::Large, false, cx)
                        .w_full()
                        .child(icon("link", 16., theme.on_accent))
                        .child("Join with an invite")
                        .on_click(cx.listener(|view, _, window, cx| view.go(Step::Link, window, cx))),
                )
                .child(button("sign-in", ButtonKind::Default, ButtonSize::Large, false, cx).w_full().child("Sign in").on_click(cx.listener(|view, _, window, cx| view.go(Step::SignIn, window, cx))))
                .child(
                    div()
                        .id("host-own")
                        .self_center()
                        .h(px(32.))
                        .mt(px(2.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(theme.text1))
                        .on_click(|_, _, cx| cx.open_url("https://github.com/SocketByte/zuna-chat/blob/main/docs/SELF_HOSTING.md"))
                        .child(icon("server", 14., theme.text2))
                        .child("Host your own server")
                        .child(icon("arrow-up-right", 14., theme.text2)),
                )
                .into_any_element(),
        ]
    }
}

/// A form's error, which takes a place only when there is one: without it, an empty row
/// pulls the next one up by the gap it would have added.
fn error_slot(error: Option<String>, theme: &crate::theme::Theme) -> AnyElement {
    match error {
        Some(error) => div().text_size(px(12.5)).text_color(theme.red).child(error).into_any_element(),
        None => div().mt(px(-14.)).into_any_element(),
    }
}

trait SpawnDetached {
    fn spawn_in_window_or_detached<F>(&mut self, f: F)
    where
        F: AsyncFnOnce(gpui::WeakEntity<Onboarding>, &mut gpui::AsyncApp) + 'static;
}

impl SpawnDetached for Context<'_, Onboarding> {
    fn spawn_in_window_or_detached<F>(&mut self, f: F)
    where
        F: AsyncFnOnce(gpui::WeakEntity<Onboarding>, &mut gpui::AsyncApp) + 'static,
    {
        self.spawn(f).detach();
    }
}

impl Render for Onboarding {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        if let Some(input) = self.pending_focus.take() {
            input.read(cx).focus(window);
        }
        let error = self.error.clone();
        let step = self.step.clone();
        let mut gap = 14.;
        let children: Vec<AnyElement> = match step {
            Step::Welcome => {
                gap = 10.;
                self.welcome(cx)
            }
            Step::Link => {
                gap = 18.;
                let has_link = !self.link.read(cx).text().trim().is_empty();
                let back = if self.embedded { None } else { Some(Step::Welcome) };
                let mut parts = vec![
                    self.header(Some("link"), "Join a server".into(), Some("Paste the invite link someone sent you.".into()), back, cx),
                    self.input_field(0, &self.link.clone(), None, None, error, None, cx),
                ];
                let busy = self.busy;
                parts.push(
                    button("continue", ButtonKind::Primary, ButtonSize::Large, !has_link || busy, cx)
                        .w_full()
                        .when(busy, |el| el.child(spinner(18., theme.text3)))
                        .when(!busy, |el| el.child("Continue").child(icon("arrow-right", 17., if has_link { theme.on_accent } else { theme.text3 })))
                        .when(has_link && !busy, |el| el.on_click(cx.listener(|view, _, _, cx| view.preview_invite(cx))))
                        .into_any_element(),
                );
                if self.embedded {
                    parts.push(button("have-account", ButtonKind::Default, ButtonSize::Large, false, cx).w_full().child("I already have an account").on_click(cx.listener(|view, _, window, cx| view.go(Step::SignIn, window, cx))).into_any_element());
                }
                parts
            }
            Step::Invite(preview) => {
                let server = &preview.server;
                let icon_image = if server.has_icon {
                    let url = format!("{}/api/icon", preview.url);
                    self.state.update(cx, |state, cx| state.remote_picture(&url, cx))
                } else {
                    None
                };
                let display_name = self.display_name.read(cx).text().trim().to_string();
                let username = self.username.read(cx).text().to_string();
                let password = self.password.read(cx).text().to_string();
                let confirm = self.confirm.read(cx).text().to_string();
                let username_error = if error.as_ref().is_some_and(|e| e.to_lowercase().contains("username")) {
                    error.clone()
                } else if !username.is_empty() && !valid_username(&username) {
                    Some("Usernames need at least 2 valid characters.".to_string())
                } else {
                    None
                };
                let error = error.filter(|e| !e.to_lowercase().contains("username"));
                let confirm_error = if !confirm.is_empty() && !password.starts_with(&confirm) { Some("The passwords don't match.".to_string()) } else { None };
                let can_submit = !display_name.is_empty() && valid_username(&username) && password.chars().count() >= MIN_PASSWORD && self.strength.0 >= 2 && confirm == password;
                let members = server.user_count as u64;
                let subtitle: AnyElement = if preview.setup {
                    div().child("You're creating the owner account.").into_any_element()
                } else if members > 0 {
                    div().flex().items_center().gap(px(5.)).child(icon("users", 13., theme.text2)).child(format!("{members} {}", if members == 1 { "member" } else { "members" })).into_any_element()
                } else {
                    div().child("Open sign-ups").into_any_element()
                };
                let suffix = self.password_suffix(cx);
                let confirm_suffix = self.password_suffix(cx);
                let busy = self.busy;
                vec![
                    div()
                        .relative()
                        .flex()
                        .flex_col()
                        .items_center()
                        .text_center()
                        .gap(px(6.))
                        .mb(px(6.))
                        .child(div().absolute().left(px(-6.)).top(px(-4.)).child(icon_button("back", "arrow-left", 18., false, false, cx).on_click(cx.listener(|view, _, window, cx| view.go(Step::Link, window, cx)))))
                        .child(avatar(AvatarProps { name: server.name.clone(), seed: preview.url.clone(), image: icon_image, size: 56., online: false, rounded: true, dot_border: theme.bg0 }, cx))
                        .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(if preview.setup { "Set up your server".to_string() } else { format!("Join {}", server.name) }))
                        .child(div().text_color(theme.text2).child(subtitle))
                        .into_any_element(),
                    self.input_field(1, &self.display_name.clone(), Some("Your name"), None, None, None, cx),
                    self.input_field(2, &self.username.clone(), Some("Username"), Some("Letters, numbers, dots, dashes and underscores."), username_error, None, cx),
                    div().flex().flex_col().child(self.input_field(3, &self.password.clone(), Some("Password"), None, None, Some(suffix), cx)).child(self.strength_meter(cx)).into_any_element(),
                    self.input_field(4, &self.confirm.clone(), Some("Confirm password"), None, confirm_error, Some(confirm_suffix), cx),
                    div()
                        .flex()
                        .gap(px(10.))
                        .px(px(12.))
                        .py(px(10.))
                        .rounded(RADIUS_M)
                        .bg(theme.bg2)
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .child(div().mt(px(1.)).child(icon("lock", 15., theme.text2)))
                        .child(div().flex_1().min_w_0().child("Your password unlocks your encryption keys. It never leaves this device, and your server can't reset it."))
                        .into_any_element(),
                    error_slot(error.clone(), &theme),
                    button("create", ButtonKind::Primary, ButtonSize::Large, !can_submit || busy, cx)
                        .w_full()
                        .when(busy, |el| el.child(spinner(18., theme.text3)).child("Securing your account"))
                        .when(!busy, |el| el.child("Create account"))
                        .when(can_submit && !busy, |el| el.on_click(cx.listener(|view, _, window, cx| view.submit(window, cx))))
                        .into_any_element(),
                ]
            }
            Step::RecoveryKey { recovery_key, .. } => {
                gap = 16.;
                let key_for_copy = recovery_key.clone();
                let key_for_file = recovery_key.clone();
                let saved = self.saved;
                let copied = self.copied;
                vec![
                    self.header(
                        Some("key-round"),
                        "Save your recovery key".into(),
                        Some("If you forget your password, this key is the only way back in. Nobody can reset it for you, not even your server's admin.".into()),
                        None,
                        cx,
                    ),
                    div()
                        .grid()
                        .grid_cols(5)
                        .gap(px(8.))
                        .p(px(14.))
                        .bg(theme.bg2)
                        .border_1()
                        .border_color(theme.line)
                        .rounded(RADIUS_M)
                        .font_family(FONT_MONO)
                        .text_size(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .children(recovery_key.split('-').map(|part| div().flex().justify_center().child(part.to_string())))
                        .into_any_element(),
                    div()
                        .flex()
                        .gap(px(10.))
                        .child(
                            button("copy-key", ButtonKind::Default, ButtonSize::Normal, false, cx)
                                .flex_1()
                                .child(icon(if copied { "check" } else { "copy" }, 15., theme.text1))
                                .child(if copied { "Copied" } else { "Copy" })
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(key_for_copy.clone()));
                                    view.copied = true;
                                    cx.notify();
                                    cx.spawn(async move |view, cx| {
                                        cx.background_executor().timer(Duration::from_millis(1500)).await;
                                        view.update(cx, |view, cx| {
                                            view.copied = false;
                                            cx.notify();
                                        })
                                        .ok();
                                    })
                                    .detach();
                                })),
                        )
                        .child(button("save-key", ButtonKind::Default, ButtonSize::Normal, false, cx).flex_1().child(icon("download", 15., theme.text1)).child("Save as file").on_click(move |_, _, cx| {
                            let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
                            let chosen = cx.prompt_for_new_path(&downloads, Some("zuna-recovery-key.txt"));
                            let text = format!("Zuna recovery key\n\n{key_for_file}\n\nKeep this somewhere safe. It's the only way back into your account if you forget your password.\n");
                            cx.spawn(async move |_| {
                                if let Ok(Ok(Some(path))) = chosen.await {
                                    std::fs::write(path, text).ok();
                                }
                            })
                            .detach();
                        }))
                        .into_any_element(),
                    div()
                        .id("saved-check")
                        .flex()
                        .items_center()
                        .gap(px(9.))
                        .text_size(px(13.5))
                        .cursor_pointer()
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.saved = !view.saved;
                            cx.notify();
                        }))
                        .child(
                            div()
                                .size(px(18.))
                                .rounded(px(4.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .border_1()
                                .border_color(if saved { theme.accent } else { theme.line_strong })
                                .bg(if saved { theme.accent } else { theme.bg2 })
                                .when(saved, |el| el.child(icon("check", 13., theme.on_accent))),
                        )
                        .child("I've stored it somewhere safe")
                        .into_any_element(),
                    self.primary("continue", "Continue", saved, cx),
                ]
            }
            Step::NameServer { .. } => vec![
                self.header(Some("server"), "Name your server".into(), Some("Everyone who joins sees this name.".into()), None, cx),
                self.input_field(7, &self.server_name.clone(), None, None, error, None, cx),
                self.primary("save-name", "Continue", true, cx),
            ],
            Step::SignIn => {
                let url = self.server.read(cx).text().trim().to_string();
                let username = self.username.read(cx).text().trim().to_string();
                let password = self.password.read(cx).text().to_string();
                let enabled = !url.is_empty() && !username.is_empty() && !password.is_empty();
                let suffix = self.password_suffix(cx);
                let busy = self.busy;
                let back = if self.embedded { Step::Link } else { Step::Welcome };
                vec![
                    self.header(None, "Sign in".into(), Some("Your history will load on this device after you sign in.".into()), Some(back), cx),
                    self.input_field(5, &self.server.clone(), Some("Server address"), Some("Or paste any link to the server."), None, None, cx),
                    self.input_field(2, &self.username.clone(), Some("Username"), None, None, None, cx),
                    self.input_field(3, &self.password.clone(), Some("Password"), None, None, Some(suffix), cx),
                    error_slot(error.clone(), &theme),
                    button("sign-in-submit", ButtonKind::Primary, ButtonSize::Large, !enabled || busy, cx)
                        .w_full()
                        .when(busy, |el| el.child(spinner(18., theme.text3)).child("Unlocking your keys"))
                        .when(!busy, |el| el.child("Sign in"))
                        .when(enabled && !busy, |el| el.on_click(cx.listener(|view, _, window, cx| view.submit(window, cx))))
                        .into_any_element(),
                    div()
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .id("forgot")
                                .text_size(px(13.))
                                .text_color(theme.text2)
                                .when(url.is_empty() || username.is_empty(), |el| el.opacity(0.45))
                                .when(!url.is_empty() && !username.is_empty(), |el| {
                                    el.cursor_pointer().hover(move |style| style.text_color(theme.text1)).on_click(cx.listener(move |view, _, window, cx| {
                                        view.go(Step::Recover { url: url.clone(), username: username.clone() }, window, cx)
                                    }))
                                })
                                .child("Forgot your password?"),
                        )
                        .into_any_element(),
                ]
            }
            Step::Recover { username, .. } => {
                let key = self.recovery.read(cx).text().trim().to_string();
                let password = self.password.read(cx).text().to_string();
                let confirm = self.confirm.read(cx).text().to_string();
                let enabled = !key.is_empty() && password.chars().count() >= MIN_PASSWORD && self.strength.0 >= 2 && confirm == password;
                let confirm_error = if !confirm.is_empty() && !password.starts_with(&confirm) { Some("The passwords don't match.".to_string()) } else { None };
                let suffix = self.password_suffix(cx);
                vec![
                    self.header(None, "Use your recovery key".into(), Some(format!("Choose a new password for {username}. Your other devices will need it next time.")), Some(Step::SignIn), cx),
                    self.input_field(6, &self.recovery.clone(), Some("Recovery key"), None, None, None, cx),
                    div().flex().flex_col().child(self.input_field(3, &self.password.clone(), Some("New password"), None, None, Some(suffix), cx)).child(self.strength_meter(cx)).into_any_element(),
                    self.input_field(4, &self.confirm.clone(), Some("Confirm new password"), None, confirm_error, None, cx),
                    error_slot(error.clone(), &theme),
                    self.primary("recover", "Set new password and sign in", enabled, cx),
                ]
            }
        };
        let _ = SharedString::default();
        // As CSS grid centering in a scrolling box: in the middle while it fits, from the top when it doesn't.
        div()
            .id("onboarding")
            .flex_1()
            .min_w_0()
            .overflow_y_scroll()
            .track_scroll(&scroll_handle("onboarding"))
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(24.))
            .pr(px(24.) + gutter(&scroll_handle("onboarding")))
            .py(px(32.))
            // A width of its own, so wrapping text is measured at it when centering.
            .child(div().flex_none().w(px(360.)).max_w_full().flex().flex_col().gap(px(gap)).children(children))
            .child(scrollbar("onboarding", Scrolls::Div(scroll_handle("onboarding"))))
    }
}

#[allow(dead_code)]
fn unused() -> gpui::Hsla {
    theme::color(theme::hex(0))
}
