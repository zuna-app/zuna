//! Joining with an invite, signing in and recovering an account
//! (packages/ui/src/features/onboarding/Onboarding.tsx).

#[cfg(test)]
mod tests;
mod view;

use std::time::Duration;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, Window, div, prelude::*, px};
use gpui::Focusable as _;
use serde_json::json;

use super::components::*;
use super::motion::{Enter, Motion};
use super::scrollbar::{RevealsFocus, Scrolls, gutter, scroll_handle, scrollbar};
use super::text_input::{InputEvent, TextInput};
use crate::format::MIN_PASSWORD;
use crate::models::{InvitePreview, Registered, from_value};
use crate::state::AppState;
use crate::theme::{FONT_MONO, RADIUS_M};

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
            Step::Link => self.link.focus_handle(cx).focus(window, cx),
            Step::Invite(_) => self.display_name.focus_handle(cx).focus(window, cx),
            Step::SignIn => self.server.focus_handle(cx).focus(window, cx),
            Step::Recover { .. } => self.recovery.focus_handle(cx).focus(window, cx),
            Step::NameServer { .. } => self.server_name.focus_handle(cx).focus(window, cx),
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
