//! Dialogs over the app: joining another server, a new group, invites, verifying
//! someone, leaving a server and moving voice to this device
//! (packages/ui/src/features/overlays/Overlays.tsx).

mod groups;
mod verify;
mod location;
mod channel;

use std::collections::BTreeSet;

use gpui::{AnyElement, AnyView, App, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px};
use gpui::Focusable as _;
use serde_json::json;

use super::components::*;
use super::motion::{Enter, Motion};
use super::scrollbar::{RevealsFocus, Scrolls, gutter, scroll_handle, scrollbar};
use super::onboarding::Onboarding;
use super::text_input::{InputEvent, TabScope, TextInput};
use crate::models::{SafetyCheck, from_value};
use crate::state::{AppState, Overlay, ToastKind};
use crate::theme::{self, RADIUS_L, RADIUS_M, RADIUS_XL};

/// How far a dialog's card rises as it comes in, and over how long, with motion's `quick`:
/// GPUI can't scale it as `Modal` does, so it moves far enough to be seen.
const DIALOG_RISE: f32 = 18.;
const DIALOG_MS: u64 = 240;
/// How long the backdrop under a dialog takes to darken.
const BACKDROP_MS: u64 = 180;

pub fn open(overlay: &Overlay, state: Entity<AppState>, window: &mut Window, cx: &mut gpui::App) -> Option<AnyView> {
    Some(match overlay.clone() {
        Overlay::AddServer { link, sign_in_url } => {
            let flow = cx.new(|cx| Onboarding::embedded(state.clone(), link, sign_in_url, window, cx));
            cx.new(|cx| Dialog::new(state, DialogKind::AddServer(flow), window, cx)).into()
        }
        Overlay::NewGroup => cx.new(|cx| Dialog::new(state, DialogKind::NewGroup, window, cx)).into(),
        Overlay::Invite => cx.new(|cx| Dialog::new(state, DialogKind::Invite, window, cx)).into(),
        Overlay::Verify { user_id } => cx.new(|cx| Dialog::new(state, DialogKind::Verify(user_id), window, cx)).into(),
        Overlay::LeaveServer => cx.new(|cx| Dialog::new(state, DialogKind::LeaveServer, window, cx)).into(),
        Overlay::MoveVoice(moving) => cx.new(|cx| Dialog::new(state, DialogKind::MoveVoice(moving), window, cx)).into(),
        Overlay::InstallUpdate => cx.new(|cx| Dialog::new(state, DialogKind::InstallUpdate, window, cx)).into(),
        Overlay::WatchConsent { then_link } => cx.new(|cx| Dialog::new(state, DialogKind::WatchConsent { then_link }, window, cx)).into(),
        Overlay::WatchLink => cx.new(|cx| Dialog::new(state, DialogKind::WatchLink, window, cx)).into(),
        Overlay::Forward { server_id, group_id, ids } => cx.new(|cx| Dialog::new(state, DialogKind::Forward { server_id, group_id, ids }, window, cx)).into(),
        Overlay::ShareLocation { conversation_key } => cx.new(|cx| Dialog::new(state, DialogKind::ShareLocation(conversation_key), window, cx)).into(),
        Overlay::AddMembers { group_id } => cx.new(|cx| Dialog::new(state, DialogKind::AddMembers(group_id), window, cx)).into(),
        Overlay::Channel { channel_id, category } => cx.new(|cx| Dialog::new(state, DialogKind::Channel { channel_id, kind: category }, window, cx)).into(),
        Overlay::Settings { .. } | Overlay::ServerSettings { .. } => return None,
        Overlay::ScreenPicker => cx.new(|cx| super::screen_picker::ScreenPicker::new(state, window, cx)).into(),
        Overlay::Plugin(handle) => cx.new(|cx| super::plugins::dialog::PluginDialog::new(state, handle, window, cx)).into(),
        Overlay::PluginInstall { id } => cx.new(|cx| super::plugins::install::InstallDialog::new(state, id, window, cx)).into(),
    })
}

/// Asks before something that can't be taken back, such as a ban, as `Confirm` does: a card
/// over what's open, where Cancel or a click outside say no. Focus stays with whoever draws
/// it, so they take Escape as no too, and close only this.
pub fn confirm(title: String, action: &str, text: String, on_cancel: impl Fn(&mut Window, &mut App) + Clone + 'static, on_confirm: impl Fn(&mut Window, &mut App) + 'static, cx: &App) -> AnyElement {
    let theme = theme(cx);
    let (close, cancel) = (on_cancel.clone(), on_cancel.clone());
    let card = div()
        .id("confirm")
        .w(px(420.))
        .max_w_full()
        .flex()
        .flex_col()
        .bg(theme.bg1)
        .border_1()
        .border_color(theme.line_strong)
        .rounded(RADIUS_XL)
        .shadow(shadow_l())
        .overflow_hidden()
        .occlude()
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .pt(px(16.))
                .pr(px(16.))
                .pb(px(4.))
                .pl(px(20.))
                .child(div().flex_1().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(title))
                .child(icon_button("close-confirm", "x", 16., true, false, cx).on_click(move |_, window, cx| close(window, cx))),
        )
        .child(div().px(px(20.)).pt(px(10.)).pb(px(20.)).text_size(px(13.5)).child(text))
        .child(
            div()
                .flex()
                .justify_end()
                .gap(px(8.))
                .px(px(20.))
                .pb(px(16.))
                .child(button("confirm-cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(move |_, window, cx| cancel(window, cx)))
                .child(button("confirm-action", ButtonKind::Danger, ButtonSize::Normal, false, cx).child(action.to_string()).on_click(move |_, window, cx| on_confirm(window, cx))),
        );
    div()
        .id("confirm-layer")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .p(px(28.))
        .bg(theme::color(theme::black_a(0.6)))
        .occlude()
        .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| on_cancel(window, cx))
        .child(card.appear("confirm-card", Enter::Rise(DIALOG_RISE), DIALOG_MS))
        .appear("confirm-layer", Enter::Fade, BACKDROP_MS)
        .into_any_element()
}

enum DialogKind {
    AddServer(Entity<Onboarding>),
    NewGroup,
    Invite,
    Verify(String),
    LeaveServer,
    MoveVoice(crate::voice::VoiceMove),
    InstallUpdate,
    Forward { server_id: String, group_id: String, ids: Vec<String> },
    AddMembers(String),
    ShareLocation(String),
    Channel { channel_id: Option<String>, kind: Option<String> },
    WatchConsent { then_link: bool },
    WatchLink,
}

/// What's being set for a channel, beside its name.
struct ChannelForm {
    kind: String,
    topic: Entity<TextInput>,
    category: Entity<TextInput>,
    user_limit: f64,
    bitrate: f64,
    screen_limit: f64,
    sounds: bool,
    watch: bool,
    slow_on: bool,
    slow_mode: f64,
}

/// How long slow mode may hold each person back (`SLOW_MODE_TIMES` in the core).
const SLOW_MODE_TIMES: [f64; 13] = [5., 10., 15., 30., 60., 120., 300., 600., 900., 1800., 3600., 7200., 21600.];

/// Text channels go by lowercase names with dashes, as in Discord, which also keeps them easy to mention.
fn text_channel_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut out = String::new();
    for part in lower.split_whitespace().collect::<Vec<_>>().join("-").chars() {
        if part == '-' && out.ends_with('-') {
            continue;
        }
        out.push(part);
    }
    // A trailing space becomes a dash as it's typed, as on the web.
    if lower.ends_with(char::is_whitespace) && !out.ends_with('-') {
        out.push('-');
    }
    out
}

/// A control under its label, as a `.field` lays them out.
fn labeled(label: &str, control: AnyElement, cx: &gpui::App) -> AnyElement {
    let theme = theme(cx);
    div().flex().flex_col().gap(px(5.)).child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child(label.to_string())).child(control).into_any_element()
}

pub struct Dialog {
    state: Entity<AppState>,
    kind: DialogKind,
    name: Entity<TextInput>,
    people_search: Entity<TextInput>,
    selected: BTreeSet<String>,
    history: bool,
    /// Asking what adding the bots picked means, before they're added.
    asking: bool,
    check: Option<SafetyCheck>,
    invite_link: Option<String>,
    busy: bool,
    focused: Option<usize>,
    channel_form: Option<ChannelForm>,
    invite_panel: Option<Entity<super::invites::InvitePanel>>,
    /// Where this device was found, or why it wasn't, while sharing a location.
    location: Option<Result<(f64, f64, Option<f64>), String>>,
    /// Why a link to watch together wasn't put on.
    link_error: Option<String>,
    /// Holds focus where the dialog has no field to, so Escape closes it.
    focus: gpui::FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl Dialog {
    fn new(state: Entity<AppState>, kind: DialogKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| TextInput::new(cx, "Weekend trip"));
        let people_search = cx.new(|cx| TextInput::new(cx, "Search people"));
        let mut subscriptions = vec![cx.observe(&state, |_, _, cx| cx.notify())];
        for (index, input) in [&name, &people_search].into_iter().enumerate() {
            subscriptions.push(cx.subscribe_in(input, window, move |view, _, event, _, cx| {
                match event {
                    InputEvent::Submit if index == 0 && matches!(view.kind, DialogKind::WatchLink) => view.put_on(cx),
                    InputEvent::Focused => view.focused = Some(index),
                    InputEvent::Blurred if view.focused == Some(index) => view.focused = None,
                    InputEvent::Escape => view.close(cx),
                    _ => {}
                }
                cx.notify();
            }));
        }
        if let DialogKind::AddServer(flow) = &kind {
            subscriptions.push(cx.observe(flow, |_, _, cx| cx.notify()));
        }
        if matches!(kind, DialogKind::NewGroup) {
            name.focus_handle(cx).focus(window, cx);
        }
        let mut channel_form = None;
        if let DialogKind::Channel { channel_id, kind: wanted } = &kind {
            let channel = channel_id.as_ref().and_then(|id| state.read(cx).active().and_then(|server| server.channels.iter().find(|item| item.id == *id).cloned()));
            let kind_name = channel.as_ref().map(|c| c.kind.clone()).or(wanted.clone()).unwrap_or_else(|| "text".into());
            let topic = cx.new(|cx| TextInput::new(cx, "What it's for"));
            let category = cx.new(|cx| TextInput::new(cx, if kind_name == "voice" { "Voice channels" } else { "Text channels" }));
            name.update(cx, |input, cx| input.set_placeholder(if kind_name == "voice" { "Lounge" } else { "new-channel" }, cx));
            if let Some(channel) = &channel {
                name.update(cx, |input, cx| input.set_text(channel.name.clone(), cx));
                topic.update(cx, |input, cx| input.set_text(channel.topic.clone(), cx));
                category.update(cx, |input, cx| input.set_text(channel.category.clone(), cx));
            }
            for input in [&topic, &category] {
                subscriptions.push(cx.subscribe_in(input, window, |view, _, event, _, cx| {
                    if *event == InputEvent::Escape {
                        view.close(cx);
                    }
                    cx.notify();
                }));
            }
            // Text channels' names are written as they'll be shown, as they're typed.
            subscriptions.push(cx.subscribe_in(&name, window, |view, input, event, _, cx| {
                if *event != InputEvent::Changed || !view.channel_form.as_ref().is_some_and(|form| form.kind == "text") {
                    return;
                }
                let typed = input.read(cx).text().to_string();
                let shown = text_channel_name(&typed);
                if shown != typed {
                    input.update(cx, |input, cx| input.set_text(shown, cx));
                }
            }));
            name.focus_handle(cx).focus(window, cx);
            channel_form = Some(ChannelForm {
                kind: kind_name,
                topic,
                category,
                user_limit: channel.as_ref().map(|c| c.user_limit).unwrap_or(0.),
                bitrate: channel.as_ref().map(|c| c.bitrate).unwrap_or(0.),
                screen_limit: channel.as_ref().map(|c| c.screen_limit).unwrap_or(0.),
                sounds: channel.as_ref().map(|c| c.sounds).unwrap_or(true),
                watch: channel.as_ref().map(|c| c.watch).unwrap_or(true),
                slow_on: channel.as_ref().is_some_and(|c| c.slow_mode > 0.),
                slow_mode: channel.as_ref().map(|c| c.slow_mode).filter(|value| *value > 0.).unwrap_or(30.),
            });
        }
        if matches!(kind, DialogKind::WatchLink) {
            name.update(cx, |input, cx| input.set_placeholder("https://www.youtube.com/watch?v=…", cx));
            name.focus_handle(cx).focus(window, cx);
        }
        if matches!(kind, DialogKind::AddMembers(_)) {
            people_search.focus_handle(cx).focus(window, cx);
        }
        if matches!(kind, DialogKind::Forward { .. }) {
            people_search.update(cx, |input, cx| input.set_placeholder("Search chats", cx));
            people_search.focus_handle(cx).focus(window, cx);
        }
        let focus = cx.focus_handle();
        if matches!(kind, DialogKind::MoveVoice(_) | DialogKind::InstallUpdate | DialogKind::WatchConsent { .. }) {
            window.focus(&focus, cx);
        }
        let mut dialog = Dialog { state, kind, name, people_search, selected: BTreeSet::new(), history: false, asking: false, check: None, invite_link: None, busy: false, focused: None, channel_form, invite_panel: None, location: None, link_error: None, focus, _subscriptions: subscriptions };
        if matches!(dialog.kind, DialogKind::ShareLocation(_)) {
            dialog.locate(cx);
        }
        if let DialogKind::Verify(user_id) = &dialog.kind {
            let user_id = user_id.clone();
            dialog.load_check(user_id, cx);
        }
        dialog
    }

    fn load_check(&mut self, user_id: String, cx: &mut Context<Self>) {
        let call = {
            let state = self.state.read(cx);
            state.active_server.clone().map(|server| state.core.call(Some(&server), "safetyCheck", vec![json!(user_id)]))
        };
        let Some(call) = call else { return };
        cx.spawn(async move |dialog, cx| {
            if let Ok(value) = call.await {
                dialog
                    .update(cx, |dialog, cx| {
                        dialog.check = if value.is_null() { None } else { Some(from_value(value)) };
                        cx.notify();
                    })
                    .ok();
            }
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }

    /// A modal card with a title and close button, as `Modal` draws it.
    fn modal(&self, title: Option<String>, width: f32, body: Vec<AnyElement>, footer: Option<AnyElement>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let mut card = div()
            .id("modal")
            // Its own width, capped by the window: as a share of the window, GPUI measured its
            // text unwrapped, and the dialog came out short of it.
            .w(px(width))
            .max_w_full()
            .max_h_full()
            .flex()
            .flex_col()
            .bg(theme.bg1)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(RADIUS_XL)
            .shadow(shadow_l())
            .overflow_hidden()
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation());
        match title {
            Some(title) => {
                card = card
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .pt(px(16.))
                            .pr(px(16.))
                            .pb(px(4.))
                            .pl(px(20.))
                            .child(div().flex_1().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(title))
                            .child(icon_button("close-modal", "x", 16., true, false, cx).on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx)))),
                    )
                    .child({
                        let handle = scroll_handle("modal-body");
                        div().id("modal-body").overflow_y_scroll().track_scroll(&handle).px(px(20.)).pr(px(20.) + gutter(&handle)).pt(px(10.)).pb(px(20.)).flex().flex_col().gap(px(14.)).children(body).child(scrollbar("modal-body", Scrolls::Div(handle.clone()))).reveals_focus(&handle)
                    });
                if let Some(footer) = footer {
                    card = card.child(div().flex().justify_end().gap(px(8.)).px(px(20.)).pb(px(16.)).child(footer));
                }
            }
            None => {
                card = card.child(
                    div()
                        .relative()
                        .id("modal-flow")
                        .p(px(24.))
                        .overflow_y_scroll()
                        .track_scroll(&scroll_handle("modal-flow"))
                        .pr(px(24.) + gutter(&scroll_handle("modal-flow")))
                        .child(div().absolute().right(px(10.)).top(px(10.)).child(icon_button("close-modal", "x", 17., true, false, cx).on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx)))))
                        .children(body)
                        .child(scrollbar("modal-flow", Scrolls::Div(scroll_handle("modal-flow"))))
                        .reveals_focus(&scroll_handle("modal-flow")),
                );
            }
        }
        div()
            .id("modal-layer")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(28.))
            .bg(theme::color(theme::black_a(0.6)))
            .occlude()
            .track_focus(&self.focus)
            .tab_scope(&self.focus)
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|dialog, _, _, cx| dialog.close(cx)))
            .on_key_down(cx.listener(|dialog, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    dialog.close(cx);
                }
            }))
            // The backdrop fades in, and the card rises into place as it does.
            .child(card.appear("modal-card", Enter::Rise(DIALOG_RISE), DIALOG_MS))
            .appear("modal-layer", Enter::Fade, BACKDROP_MS)
            .into_any_element()
    }

    fn invite(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        if self.invite_panel.is_none() {
            let state = self.state.clone();
            self.invite_panel = Some(cx.new(|cx| super::invites::InvitePanel::new(state, cx)));
        }
        let body = vec![
            div()
                .text_size(px(13.5))
                .text_color(theme.text2)
                .child("Anyone with a link can create an account here. It also holds the key that protects member profiles, so only share it with people you trust.")
                .into_any_element(),
            self.invite_panel.clone().map(|panel| panel.into_any_element()).unwrap_or_else(|| div().into_any_element()),
        ];
        self.modal(Some("Invite people".into()), 440., body, None, cx)
    }

    fn leave_server(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let id = server.entry.id.clone();
        let body = vec![div()
            .text_size(px(13.5))
            .text_color(theme.text2)
            .child(format!("This signs this device out of {} and removes its messages from this device. Your account stays, and you can sign in again later.", server.entry.name))
            .into_any_element()];
        let state = self.state.clone();
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("leave", ButtonKind::Danger, ButtonSize::Normal, false, cx).child("Leave this server").on_click(move |_, _, cx| {
                let id = id.clone();
                state.update(cx, |state, cx| state.call(None, "leaveServer", vec![json!(id.clone())], cx, move |state, _, cx| state.remove_server(&id, cx)))
            }))
            .into_any_element();
        self.modal(Some(format!("Leave {}?", server.entry.name)), 440., body, Some(footer), cx)
    }

    /// Asks before coming into a voice channel or a call here, while another of this person's
    /// devices is in one on the same server, which that takes out (`MoveVoice`).
    fn move_voice(&mut self, moving: crate::voice::VoiceMove, cx: &mut Context<Self>) -> AnyElement {
        let server = self.state.read(cx).servers.get(&moving.server_id);
        let channel = server.and_then(|server| server.channels.iter().find(|channel| channel.id == moving.from));
        // Where the other device is, in words that follow "You're in".
        let place = match (channel, server.and_then(|server| crate::voice::conversation_of_group(server, &moving.from))) {
            (Some(_), _) if moving.from == moving.channel_id => "this voice channel".to_string(),
            (None, _) if moving.from == moving.channel_id => "this call".to_string(),
            (Some(channel), _) if !channel.name.is_empty() => channel.name.clone(),
            (Some(_), _) => "a voice channel".to_string(),
            (None, Some(conversation)) if conversation.kind == "dm" => format!("a call with {}", conversation.title),
            (None, Some(conversation)) => format!("a call in {}", conversation.title),
            (None, None) => "a call".to_string(),
        };
        let body = vec![div().text_size(px(13.5)).child(format!("You're in {place} on another device. Joining here disconnects that device.")).into_any_element()];
        let state = self.state.clone();
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("move-voice", ButtonKind::Primary, ButtonSize::Normal, false, cx).child("Join here").on_click(move |_, _, cx| {
                state.update(cx, |state, cx| state.set_overlay(None, cx));
                if let Some(voice) = crate::voice::get(cx) {
                    let moving = moving.clone();
                    voice.update(cx, |voice, cx| voice.come_in(moving.server_id, moving.channel_id, moving.return_to, moving.how, cx));
                }
            }))
            .into_any_element();
        self.modal(Some("Join on this device?".into()), 420., body, Some(footer), cx)
    }

    /// Asks before an update restarts the app while this device is in a voice channel or a
    /// call, which that ends (`InstallUpdate`).
    fn install_update(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let version = crate::platform::updates::current().ready.map(|update| update.label()).unwrap_or_default();
        let body = vec![div().text_size(px(13.5)).child(format!("Updating to {version} restarts Zuna, which takes you out of the call you're in. You can join again once it's back.")).into_any_element()];
        let state = self.state.clone();
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Not now").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("install-update", ButtonKind::Primary, ButtonSize::Normal, false, cx).child("Update and restart").on_click(move |_, _, cx| {
                state.update(cx, |state, cx| state.set_overlay(None, cx));
                crate::ui::restart_into_update(cx);
            }))
            .into_any_element();
        self.modal(Some("Update now?".into()), 420., body, Some(footer), cx)
    }
}

impl Dialog {
    /// Asks once before this device first contacts YouTube, saying what Google learns, and
    /// remembers the answer in Privacy (`WatchConsent` in Watch.tsx).
    fn watch_consent(&mut self, then_link: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let body = vec![
            div().text_size(px(13.5)).child("Videos play from YouTube, in YouTube's own player. When you watch one, Google learns this device's IP address, which video it is and when, as it would if you opened it on YouTube. Nobody is signed in to YouTube here, so there may be adverts.").into_any_element(),
            div().pt(px(10.)).text_size(px(13.5)).text_color(theme.text2).child("Your server only learns that something was sent in the room, never which video. Until you press Watch, this device contacts nobody. You can turn this off in Settings, Privacy.").into_any_element(),
            div()
                .pt(px(10.))
                .flex()
                .gap(px(14.))
                .text_size(px(13.))
                .child(div().id("youtube-terms").text_color(theme.accent).cursor_pointer().child("YouTube's Terms of Service").on_click(|_, _, cx| cx.open_url("https://www.youtube.com/t/terms")))
                .child(div().id("google-privacy").text_color(theme.accent).cursor_pointer().child("Google's Privacy Policy").on_click(|_, _, cx| cx.open_url("https://policies.google.com/privacy")))
                .into_any_element(),
        ];
        let state = self.state.clone();
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("watch-agree", ButtonKind::Primary, ButtonSize::Normal, false, cx).child(if then_link { "Continue" } else { "Watch" }).on_click(move |_, _, cx| {
                state.update(cx, |state, cx| {
                    state.update_settings(|settings| settings.play_youtube = true, cx);
                    state.set_overlay(if then_link { Some(Overlay::WatchLink) } else { None }, cx);
                });
                if !then_link {
                    if let Some(voice) = crate::voice::get(cx) {
                        voice.update(cx, |voice, cx| voice.set_watching(true, cx));
                    }
                }
            }))
            .into_any_element();
        self.modal(Some("Play YouTube videos?".into()), 460., body, Some(footer), cx)
    }

    /// A YouTube link to put on for everyone in the room (`WatchLinkDialog`).
    fn watch_link(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let focused = self.focused == Some(0);
        let mut body = vec![field(Some("YouTube link"), self.name.clone(), self.link_error.clone(), None, focused, None, cx).into_any_element()];
        if self.link_error.is_none() {
            body.push(div().pt(px(8.)).text_size(px(12.5)).text_color(theme.text2).child("It plays for everyone here who presses Watch, at the same moment. Anyone in the room can pause it, skip, change its speed or stop it.").into_any_element());
        }
        let busy = self.busy;
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("watch-put-on", ButtonKind::Primary, ButtonSize::Normal, busy, cx).child(if busy { "Putting it on…" } else { "Put it on" }).on_click(cx.listener(|dialog, _, _, cx| dialog.put_on(cx))))
            .into_any_element();
        self.modal(Some("Watch together".into()), 460., body, Some(footer), cx)
    }

    fn put_on(&mut self, cx: &mut Context<Self>) {
        let link = self.name.read(cx).text().trim().to_string();
        if link.is_empty() || self.busy {
            return;
        }
        let Some(voice) = crate::voice::get(cx) else { return };
        self.busy = true;
        self.link_error = None;
        let dialog = cx.entity().downgrade();
        voice.update(cx, |voice, cx| {
            voice.watch_start(
                link,
                move |result, cx| {
                    dialog
                        .update(cx, |dialog, cx| {
                            dialog.busy = false;
                            match result {
                                Ok(()) => dialog.close(cx),
                                Err(message) => dialog.link_error = Some(message),
                            }
                            cx.notify();
                        })
                        .ok();
                },
                cx,
            )
        });
        cx.notify();
    }
}

impl Render for Dialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dialog = match &self.kind {
            DialogKind::AddServer(flow) => {
                let flow = flow.clone();
                self.modal(None, 420., vec![flow.into_any_element()], None, cx)
            }
            DialogKind::NewGroup => self.new_group(cx),
            DialogKind::Invite => self.invite(cx),
            DialogKind::Verify(user_id) => {
                let user_id = user_id.clone();
                self.verify(user_id, cx)
            }
            DialogKind::LeaveServer => self.leave_server(cx),
            DialogKind::MoveVoice(moving) => {
                let moving = moving.clone();
                self.move_voice(moving, cx)
            }
            DialogKind::InstallUpdate => self.install_update(cx),
            DialogKind::WatchConsent { then_link } => {
                let then_link = *then_link;
                self.watch_consent(then_link, cx)
            }
            DialogKind::WatchLink => self.watch_link(cx),
            DialogKind::ShareLocation(key) => {
                let key = key.clone();
                self.share_location(key, cx)
            }
            DialogKind::AddMembers(group_id) => {
                let group_id = group_id.clone();
                self.add_members(group_id, cx)
            }
            DialogKind::Channel { channel_id, .. } => {
                let channel_id = channel_id.clone();
                self.channel(channel_id, cx)
            }
            DialogKind::Forward { server_id, group_id, ids } => {
                let (server_id, group_id, ids) = (server_id.clone(), group_id.clone(), ids.clone());
                self.forward(server_id, group_id, ids, cx)
            }
        };
        match self.bot_question(cx) {
            Some(question) => div().absolute().inset_0().child(dialog).child(question).into_any_element(),
            None => dialog,
        }
    }
}
