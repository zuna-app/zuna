//! Dialogs over the app: joining another server, a new group, invites, verifying
//! someone and leaving a server (packages/ui/src/features/overlays/Overlays.tsx).

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use gpui::{AnyElement, AnyView, App, Context, Entity, FontWeight, IntoElement, ParentElement, Pixels, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px};
use gpui::Focusable as _;
use serde_json::json;

use super::components::*;
use super::motion::{Enter, Motion};
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::onboarding::Onboarding;
use super::text_input::{InputEvent, TextInput};
use crate::models::{SafetyCheck, from_value};
use crate::state::{AppState, Overlay, ToastKind};
use crate::theme::{self, RADIUS_L, RADIUS_M, RADIUS_XL};

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
        Overlay::Forward { server_id, group_id, ids } => cx.new(|cx| Dialog::new(state, DialogKind::Forward { server_id, group_id, ids }, window, cx)).into(),
        Overlay::ShareLocation { conversation_key } => cx.new(|cx| Dialog::new(state, DialogKind::ShareLocation(conversation_key), window, cx)).into(),
        Overlay::AddMembers { group_id } => cx.new(|cx| Dialog::new(state, DialogKind::AddMembers(group_id), window, cx)).into(),
        Overlay::Channel { channel_id, category } => cx.new(|cx| Dialog::new(state, DialogKind::Channel { channel_id, kind: category }, window, cx)).into(),
        Overlay::Settings { .. } | Overlay::ServerSettings { .. } => return None,
        Overlay::ScreenPicker => cx.new(|cx| super::screen_picker::ScreenPicker::new(state, window, cx)).into(),
        Overlay::Image { file_id, name } => cx.new(|cx| ImageViewer::new(state, file_id, name, window, cx)).into(),
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
        .child(card.appear("confirm-card", Enter::Pop, 120))
        .appear("confirm-layer", Enter::Fade, 80)
        .into_any_element()
}

enum DialogKind {
    AddServer(Entity<Onboarding>),
    NewGroup,
    Invite,
    Verify(String),
    LeaveServer,
    Forward { server_id: String, group_id: String, ids: Vec<String> },
    AddMembers(String),
    ShareLocation(String),
    Channel { channel_id: Option<String>, kind: Option<String> },
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
    // A trailing space becomes a dash as it's typed, as on the desktop.
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
    check: Option<SafetyCheck>,
    invite_link: Option<String>,
    busy: bool,
    focused: Option<usize>,
    channel_form: Option<ChannelForm>,
    invite_panel: Option<Entity<super::invites::InvitePanel>>,
    /// Where this device was found, or why it wasn't, while sharing a location.
    location: Option<Result<(f64, f64, Option<f64>), String>>,
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
                slow_on: channel.as_ref().is_some_and(|c| c.slow_mode > 0.),
                slow_mode: channel.as_ref().map(|c| c.slow_mode).filter(|value| *value > 0.).unwrap_or(30.),
            });
        }
        if matches!(kind, DialogKind::AddMembers(_)) {
            people_search.focus_handle(cx).focus(window, cx);
        }
        if matches!(kind, DialogKind::Forward { .. }) {
            people_search.update(cx, |input, cx| input.set_placeholder("Search chats", cx));
            people_search.focus_handle(cx).focus(window, cx);
        }
        let mut dialog = Dialog { state, kind, name, people_search, selected: BTreeSet::new(), history: false, check: None, invite_link: None, busy: false, focused: None, channel_form, invite_panel: None, location: None, _subscriptions: subscriptions };
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
                        div().id("modal-body").overflow_y_scroll().track_scroll(&handle).px(px(20.)).pr(px(20.) + gutter(&handle)).pt(px(10.)).pb(px(20.)).flex().flex_col().gap(px(14.)).children(body).child(scrollbar("modal-body", Scrolls::Div(handle.clone())))
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
                        .child(scrollbar("modal-flow", Scrolls::Div(scroll_handle("modal-flow")))),
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
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|dialog, _, _, cx| dialog.close(cx)))
            .on_key_down(cx.listener(|dialog, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    dialog.close(cx);
                }
            }))
            // As `Modal`: the backdrop fades in over 80 ms, the card with motion's `quick`.
            .child(card.appear("modal-card", Enter::Pop, 120))
            .appear("modal-layer", Enter::Fade, 80)
            .into_any_element()
    }

    fn new_group(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let mut users: Vec<_> = server.users.values().filter(|user| user.id != server.self_id() && !user.banned).cloned().collect();
        users.sort_by_key(|user| user.display_name.to_lowercase());
        let filtered: Vec<_> = users.into_iter().filter(|user| query.is_empty() || user.display_name.to_lowercase().contains(&query) || user.username.to_lowercase().contains(&query)).collect();
        let people_scroll = scroll_handle("new-group-people");
        let mut people = div().id("people-list").max_h(px(260.)).overflow_y_scroll().track_scroll(&people_scroll).pr(gutter(&people_scroll)).flex().flex_col().gap(px(1.)).mx(px(-4.));
        if filtered.is_empty() {
            people = people.child(div().p(px(16.)).text_center().text_color(theme.text2).child("Nobody matches that search."));
        }
        for user in filtered {
            let selected = self.selected.contains(&user.id);
            let id = user.id.clone();
            let image = user.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            let row_bg = if selected { theme.bg3 } else { theme.bg1 };
            people = people.child(
                div()
                    .id(SharedString::from(format!("person-{}", user.id)))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(RADIUS_M)
                    .text_size(px(13.5))
                    .bg(row_bg)
                    .cursor_pointer()
                    .hover(move |style| if selected { style } else { style.bg(theme.hover) })
                    .on_click(cx.listener(move |dialog, _, _, cx| {
                        if !dialog.selected.remove(&id) {
                            dialog.selected.insert(id.clone());
                        }
                        cx.notify();
                    }))
                    .child(avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 36., online: user.online, rounded: false, dot_border: row_bg }, cx))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().one_line().font_weight(FontWeight::SEMIBOLD).child(user.display_name.clone())).child(div().text_size(px(12.)).text_color(theme.text3).child(format!("@{}", user.username))))
                    .child(
                        div()
                            .size(px(18.))
                            .rounded(px(4.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .border_1()
                            .border_color(if selected { theme.accent } else { theme.line_strong })
                            .when(selected, |el| el.bg(theme.accent).child(icon("check", 13., theme.on_accent))),
                    ),
            );
        }
        let name = self.name.read(cx).text().trim().to_string();
        let count = self.selected.len();
        let history = self.history;
        let busy = self.busy;
        let body = vec![
            field(Some("Group name"), self.name.clone(), None, None, self.focused == Some(0), None, cx).into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Invite people"))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .bg(theme.bg3)
                        .rounded(RADIUS_M)
                        .border_1()
                        .border_color(if self.focused == Some(1) { theme.line_strong } else { gpui::transparent_black() })
                        .px(px(11.))
                        .h(px(34.))
                        .text_size(px(13.5))
                        .child(icon("search", 14., theme.text3))
                        .child(div().flex_1().min_w_0().child(self.people_search.clone())),
                )
                .child(people.child(scrollbar("new-group-people", Scrolls::Div(people_scroll.clone()))))
                .into_any_element(),
            div()
                .flex()
                .items_center()
                .gap(px(16.))
                .py(px(10.))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(div().font_weight(FontWeight::MEDIUM).child("New members can read earlier messages"))
                        .child(div().text_size(px(12.5)).text_color(theme.text2).child("If off, people only see what's sent after they join.")),
                )
                .child(switch("history", history, cx).on_click(cx.listener(|dialog, _, _, cx| {
                    dialog.history = !dialog.history;
                    cx.notify();
                })))
                .into_any_element(),
        ];
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(
                button("create", ButtonKind::Primary, ButtonSize::Normal, name.is_empty() || busy, cx)
                    .child(if count > 0 { format!("Create with {} people", count + 1) } else { "Create".to_string() })
                    .when(!name.is_empty() && !busy, |el| {
                        el.on_click(cx.listener(move |dialog, _, _, cx| {
                            dialog.busy = true;
                            let members: Vec<String> = dialog.selected.iter().cloned().collect();
                            let name = name.clone();
                            let history = dialog.history;
                            dialog.state.update(cx, |state, cx| {
                                let server = state.active_server.clone();
                                state.call(server.as_deref(), "createGroup", vec![json!(name), json!(members), json!(history)], cx, |state, result, cx| match result {
                                    Ok(value) => {
                                        let group = value.as_str().unwrap_or_default().to_string();
                                        state.overlay = None;
                                        state.select_conversation(Some(format!("group:{group}")), cx);
                                        if let Some(server) = state.active_server.clone() {
                                            state.refresh_conversations(&server, cx);
                                        }
                                    }
                                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                });
                            });
                        }))
                    }),
            )
            .into_any_element();
        self.modal(Some("New group".into()), 440., body, Some(footer), cx)
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

    fn verify(&mut self, user_id: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let Some(user) = server.users.get(&user_id).cloned() else { return div().into_any_element() };
        let is_self = user_id == server.self_id();
        let trust = self.check.as_ref().map(|check| check.trust.clone()).unwrap_or(user.trust.clone());
        let title = if is_self { "Your security key".to_string() } else { format!("Verify {} (@{})", user.display_name, user.username) };
        let notice = |icon_name: &str, color: gpui::Hsla, bg: gpui::Hsla, text_color: gpui::Hsla, text: String| {
            div().flex().gap(px(10.)).px(px(12.)).py(px(10.)).rounded(RADIUS_M).bg(bg).text_size(px(13.)).text_color(text_color).child(icon(icon_name, 16., color)).child(div().flex_1().min_w_0().child(text)).into_any_element()
        };
        let mut body = Vec::new();
        match trust.as_str() {
            "changed" => body.push(notice(
                "shield-alert",
                theme.red,
                theme.red_soft,
                theme::color(theme::hex(0xf4bcbe)),
                format!("{}'s security key changed in a way that doesn't follow from the one before, so this may mean someone is intercepting your messages. Only continue after comparing these emoji with them directly.", user.display_name),
            )),
            "verified" => body.push(notice("shield-check", theme.text2, theme.bg2, theme.text2, format!("You've verified {}. Nobody can quietly get between you.", user.display_name))),
            _ if !is_self => body.push(
                div()
                    .text_size(px(13.5))
                    .text_color(theme.text2)
                    .child(format!("Compare these emoji with {} in person or on a call. If they match exactly, nobody, including this server, is reading your conversation.", user.display_name))
                    .into_any_element(),
            ),
            _ => {}
        }
        let emoji = self.check.as_ref().map(|check| check.emoji.clone()).unwrap_or_default();
        // Four to a row, as `.verify-grid`'s columns. Rows of their own, as GPUI's grid measured
        // itself far taller than it drew, and the dialog with it.
        let cells: Vec<_> = emoji.into_iter().collect();
        body.push(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .p(px(12.))
                .rounded(RADIUS_L)
                .bg(theme.bg2)
                .children(cells.chunks(4).map(|row| {
                    div().flex().gap(px(6.)).children(row.iter().map(|item| {
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(2.))
                            .px(px(2.))
                            .py(px(6.))
                            .child(div().text_size(px(30.)).line_height(gpui::relative(1.1)).child(item.emoji.clone()))
                            .child(div().text_size(px(11.)).text_color(theme.text2).text_center().child(item.name.clone()))
                    }))
                }))
                .into_any_element(),
        );
        if !is_self {
            let state = self.state.clone();
            let id = user_id.clone();
            let name = user.display_name.clone();
            if trust == "verified" {
                body.push(
                    button("clear-verification", ButtonKind::Default, ButtonSize::Normal, false, cx)
                        .w_full()
                        .child("Remove verification")
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("clearVerification", vec![json!(id)], cx)))
                        .into_any_element(),
                );
            } else {
                let covers = self.check.as_ref().map(|check| check.covers.clone());
                let dismiss_state = self.state.clone();
                body.push(
                    div()
                        .flex()
                        .gap(px(10.))
                        .child(button("no-match", ButtonKind::Default, ButtonSize::Normal, false, cx).flex_1().child(icon("triangle-alert", 15., theme.text1)).child("They don't match").on_click(move |_, _, cx| {
                            dismiss_state.update(cx, |state, cx| {
                                state.toast("Don't share anything private with them until you know why the emoji differ.", ToastKind::Security, cx);
                                state.set_overlay(None, cx);
                            })
                        }))
                        .child(
                            button("match", ButtonKind::Primary, ButtonSize::Normal, covers.is_none(), cx)
                                .flex_1()
                                .child(icon("badge-check", 16., theme.on_accent))
                                .child("They match")
                                .when_some(covers, |el, covers| {
                                    el.on_click(move |_, _, cx| {
                                        let (id, covers, name) = (id.clone(), covers.clone(), name.clone());
                                        state.update(cx, |state, cx| {
                                            let server = state.active_server.clone();
                                            state.call(server.as_deref(), "markVerified", vec![json!(id), json!(covers)], cx, move |state, result, cx| match result {
                                                Ok(_) => {
                                                    state.toast(format!("{name} is verified"), ToastKind::Info, cx);
                                                    state.set_overlay(None, cx);
                                                }
                                                Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                            })
                                        })
                                    })
                                }),
                        )
                        .into_any_element(),
                );
            }
        }
        self.modal(Some(title), 460., body, None, cx)
    }

    /// Where to forward messages: any chat on any server, this one first. Picking one sends
    /// them there and opens it, as Telegram's desktop app does.
    fn forward(&mut self, from_server: String, group_id: String, ids: Vec<String>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let state = self.state.read(cx);
        let order: Vec<String> = std::iter::once(from_server.clone()).chain(state.order.iter().filter(|id| **id != from_server).cloned()).collect();
        let mut sections = Vec::new();
        for server_id in order {
            let Some(server) = state.servers.get(&server_id) else { continue };
            let chats: Vec<crate::models::ConversationView> = server
                .conversations
                .iter()
                .cloned()
                .chain(server.channels.iter().filter_map(|channel| channel.conversation.clone()))
                .filter(|chat| !server.prefs.hidden.contains(&chat.key) && (query.is_empty() || chat.title.to_lowercase().contains(&query)))
                .collect();
            if !chats.is_empty() {
                sections.push((server_id.clone(), server.entry.name.clone(), chats));
            }
        }
        let show_names = sections.len() > 1 || sections.first().is_some_and(|(id, _, _)| *id != from_server);
        let forward_scroll = scroll_handle("forward-list");
        let mut list = div().id("forward-list").max_h(px(380.)).mt(px(10.)).overflow_y_scroll().track_scroll(&forward_scroll).pr(gutter(&forward_scroll)).flex().flex_col().mx(px(-4.));
        if sections.is_empty() {
            list = list.child(div().p(px(16.)).text_center().text_color(theme.text2).child("No chats match that search."));
        }
        let busy = self.busy;
        for (index, (server_id, server_name, chats)) in sections.into_iter().enumerate() {
            let mut section = div().flex().flex_col().gap(px(1.)).when(index > 0, |el| el.mt(px(8.)));
            if show_names {
                section = section.child(div().px(px(8.)).py(px(4.)).text_size(px(11.5)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text3).child(server_name.to_uppercase()));
            }
            for chat in chats {
                let image = chat.avatar.as_ref().and_then(|avatar| {
                    let server_id = server_id.clone();
                    self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
                });
                let seed = chat.peer_id.clone().or(chat.group_id.clone()).unwrap_or(chat.key.clone());
                let (to_server, key) = (server_id.clone(), chat.key.clone());
                let (from_server, group_id, ids) = (from_server.clone(), group_id.clone(), ids.clone());
                section = section.child(
                    div()
                        .id(SharedString::from(format!("forward-{server_id}-{}", chat.key)))
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(RADIUS_M)
                        .text_size(px(13.5))
                        .when(!busy, |el| el.cursor_pointer().hover(move |style| style.bg(theme.hover)))
                        .on_click(cx.listener(move |dialog, _, _, cx| {
                            if dialog.busy {
                                return;
                            }
                            dialog.busy = true;
                            cx.notify();
                            let args = vec![json!(from_server), json!(group_id), json!(ids), json!(to_server), json!(key)];
                            let call = dialog.state.read(cx).core.call(None, "forwardMessages", args);
                            let (to_server, key) = (to_server.clone(), key.clone());
                            cx.spawn(async move |dialog, cx| {
                                let result = call.await;
                                dialog
                                    .update(cx, |dialog, cx| match result {
                                        Ok(_) => dialog.state.update(cx, |state, cx| {
                                            state.selection = None;
                                            if state.active_server.as_deref() != Some(to_server.as_str()) {
                                                state.select_server(&to_server, cx);
                                            }
                                            state.select_conversation(Some(key.clone()), cx);
                                            state.set_overlay(None, cx);
                                        }),
                                        Err(error) => {
                                            dialog.busy = false;
                                            dialog.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
                                            cx.notify();
                                        }
                                    })
                                    .ok();
                            })
                            .detach();
                        }))
                        .child(avatar(AvatarProps { name: chat.title.clone(), seed, image, size: 36., online: false, rounded: false, dot_border: theme.bg1 }, cx))
                        .child(div().flex_1().min_w_0().one_line().font_weight(FontWeight::SEMIBOLD).child(chat.title.clone())),
                );
            }
            list = list.child(section);
        }
        let search = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .bg(theme.bg3)
            .rounded(RADIUS_M)
            .border_1()
            .border_color(if self.focused == Some(1) { theme.line_strong } else { gpui::transparent_black() })
            .px(px(11.))
            .h(px(34.))
            .text_size(px(13.5))
            .child(icon("search", 14., theme.text3))
            .child(div().flex_1().min_w_0().child(self.people_search.clone()));
        self.modal(Some("Forward to".into()), 440., vec![div().flex().flex_col().child(search).child(list.child(scrollbar("forward-list", Scrolls::Div(forward_scroll.clone())))).into_any_element()], None, cx)
    }

    /// People to pick from, with a search above them, as `PeoplePicker` lists them.
    fn people_picker(&mut self, server: &crate::state::ServerState, users: Vec<crate::models::UserView>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let filtered: Vec<_> = users.into_iter().filter(|user| query.is_empty() || user.display_name.to_lowercase().contains(&query) || user.username.to_lowercase().contains(&query)).collect();
        let people_scroll = scroll_handle("add-people");
        let mut people = div().id("add-people").max_h(px(260.)).overflow_y_scroll().track_scroll(&people_scroll).pr(gutter(&people_scroll)).flex().flex_col().gap(px(1.)).mx(px(-4.));
        if filtered.is_empty() {
            people = people.child(div().p(px(16.)).text_center().text_color(theme.text2).child("Nobody matches that search."));
        }
        for user in filtered {
            let selected = self.selected.contains(&user.id);
            let id = user.id.clone();
            let image = user.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            let row_bg = if selected { theme.bg3 } else { theme.bg1 };
            people = people.child(
                div()
                    .id(SharedString::from(format!("person-{}", user.id)))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(RADIUS_M)
                    .text_size(px(13.5))
                    .bg(row_bg)
                    .cursor_pointer()
                    .hover(move |style| if selected { style } else { style.bg(theme.hover) })
                    .on_click(cx.listener(move |dialog, _, _, cx| {
                        if !dialog.selected.remove(&id) {
                            dialog.selected.insert(id.clone());
                        }
                        cx.notify();
                    }))
                    .child(avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 36., online: user.online, rounded: false, dot_border: row_bg }, cx))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().one_line().font_weight(FontWeight::SEMIBOLD).child(user.display_name.clone())).child(div().text_size(px(12.)).text_color(theme.text3).child(format!("@{}", user.username))))
                    .child(
                        div()
                            .size(px(18.))
                            .rounded(px(4.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .border_1()
                            .border_color(if selected { theme.accent } else { theme.line_strong })
                            .when(selected, |el| el.bg(theme.accent).child(icon("check", 13., theme.on_accent))),
                    ),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .bg(theme.bg3)
                    .rounded(RADIUS_M)
                    .border_1()
                    .border_color(if self.focused == Some(1) { theme.line_strong } else { gpui::transparent_black() })
                    .px(px(11.))
                    .h(px(34.))
                    .text_size(px(13.5))
                    .child(icon("search", 14., theme.text3))
                    .child(div().flex_1().min_w_0().child(self.people_search.clone())),
            )
            .child(people.child(scrollbar("add-people", Scrolls::Div(people_scroll.clone()))))
            .into_any_element()
    }

    /// Asks Windows where this device is, away from the window.
    fn locate(&mut self, cx: &mut Context<Self>) {
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
    fn share_location(&mut self, key: String, cx: &mut Context<Self>) -> AnyElement {
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

    /// People to add to a group: everyone on the server who isn't in it yet.
    fn add_members(&mut self, group_id: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let conversation = server.conversations.iter().find(|item| item.group_id.as_deref() == Some(group_id.as_str())).cloned();
        let members: std::collections::HashSet<String> = conversation.as_ref().map(|c| c.members.iter().map(|member| member.user_id.clone()).collect()).unwrap_or_default();
        let mut users: Vec<_> = server.users.values().filter(|user| !members.contains(&user.id) && !user.banned).cloned().collect();
        users.sort_by_key(|user| user.display_name.to_lowercase());
        let mut body = Vec::new();
        if conversation.as_ref().is_some_and(|c| c.history_visible) {
            body.push(notice("users-round", "This group shares its history, so they'll be able to read earlier messages.", cx).into_any_element());
        }
        if users.is_empty() {
            body.push(div().p(px(16.)).text_center().text_color(theme.text2).child("Everyone on this server is already here.").into_any_element());
        } else {
            body.push(self.people_picker(&server, users, cx));
        }
        let count = self.selected.len();
        let busy = self.busy;
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("add", ButtonKind::Primary, ButtonSize::Normal, count == 0 || busy, cx).child(if busy { "Adding…" } else { "Add" }).when(count > 0 && !busy, |el| {
                el.on_click(cx.listener(move |dialog, _, _, cx| {
                    dialog.busy = true;
                    let ids: Vec<String> = dialog.selected.iter().cloned().collect();
                    let group = group_id.clone();
                    dialog.state.update(cx, |state, cx| {
                        let server = state.active_server.clone();
                        state.call(server.as_deref(), "addMembers", vec![json!(group), json!(ids)], cx, |state, result, cx| match result {
                            Ok(_) => state.set_overlay(None, cx),
                            Err(error) => state.toast(error.message, ToastKind::Error, cx),
                        });
                    });
                    cx.notify();
                }))
            }));
        self.modal(Some("Add people".into()), 440., body, Some(footer.into_any_element()), cx)
    }

    /// Making a channel, or changing one, for a server admin (ChannelDialog.tsx).
    fn channel(&mut self, channel_id: Option<String>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let channel = channel_id.as_ref().and_then(|id| server.channels.iter().find(|item| item.id == *id)).cloned();
        let Some(form) = &self.channel_form else { return div().into_any_element() };
        let text = form.kind == "text";
        let final_name = if text { text_channel_name(self.name.read(cx).text()).trim_matches('-').to_string() } else { self.name.read(cx).text().trim().to_string() };
        let voice_ready = server.info.as_ref().is_some_and(|info| info.voice.is_some_and(|voice| voice > 0.));
        let mut body = Vec::new();
        if channel.is_none() {
            let choice = |kind: &'static str, icon_name: &'static str, title: &'static str, text: &'static str, active: bool, cx: &mut Context<Self>| {
                // Two equal columns, as `.channel-types`, the text wrapping inside each.
                div()
                    .id(kind)
                    .flex_1()
                    .flex_basis(px(0.))
                    .min_w_0()
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .p(px(10.))
                    .rounded(RADIUS_M)
                    .border_1()
                    .border_color(if active { theme.accent } else { theme.line_strong })
                    .when(active, |el| el.bg(theme.accent_soft))
                    .text_color(if active { theme.text1 } else { theme.text2 })
                    .cursor_pointer()
                    .hover(move |style| if active { style } else { style.bg(theme.hover) })
                    .on_click(cx.listener(move |dialog, _, _, cx| {
                        if let Some(form) = &mut dialog.channel_form {
                            form.kind = kind.to_string();
                        }
                        let placeholder = if kind == "text" { "new-channel" } else { "Lounge" };
                        dialog.name.update(cx, |input, cx| input.set_placeholder(placeholder, cx));
                        cx.notify();
                    }))
                    .child(icon(icon_name, 18., if active { theme.text1 } else { theme.text2 }))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(title)).child(div().mt(px(1.)).text_size(px(12.)).text_color(theme.text3).child(text)))
            };
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Type"))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(choice("text", "hash", "Text", "Messages, pictures and files", text, cx))
                            .child(choice("voice", "volume-2", "Voice", "Talk, share a camera or a screen", !text, cx)),
                    )
                    .into_any_element(),
            );
        }
        if !text && !voice_ready {
            body.push(
                div()
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(RADIUS_M)
                    .bg(theme.amber_soft)
                    .text_size(px(13.))
                    .text_color(theme.amber)
                    .child("This server has no media server yet, so nobody can join voice channels. Whoever runs it can set up LiveKit (see SELF_HOSTING.md).")
                    .into_any_element(),
            );
        }
        let form = self.channel_form.as_ref().unwrap();
        body.push(field(Some("Name"), self.name.clone(), None, None, self.focused == Some(0), None, cx).into_any_element());
        body.push(field(Some("Topic"), form.topic.clone(), None, None, false, None, cx).into_any_element());
        body.push(field(Some("Heading"), form.category.clone(), None, None, false, None, cx).into_any_element());
        let (slow_on, slow_mode) = (form.slow_on, form.slow_mode);
        body.push(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Slow mode")).child(div().text_size(px(12.5)).text_color(theme.text3).child("Each person waits between messages, except admins.")))
                .child(switch("slow-mode", slow_on, cx).on_click(cx.listener(|dialog, _, _, cx| {
                    if let Some(form) = &mut dialog.channel_form {
                        form.slow_on = !form.slow_on;
                    }
                    cx.notify();
                })))
                .into_any_element(),
        );
        if slow_on {
            let mut times: Vec<f64> = SLOW_MODE_TIMES.to_vec();
            if !times.contains(&slow_mode) {
                times.push(slow_mode);
            }
            let weak = cx.entity().downgrade();
            let choices = times
                .iter()
                .map(|seconds| {
                    let (weak, seconds) = (weak.clone(), *seconds);
                    let action: std::rc::Rc<dyn Fn(&mut Window, &mut gpui::App)> = std::rc::Rc::new(move |_, cx| {
                        weak.update(cx, |dialog, cx| {
                            if let Some(form) = &mut dialog.channel_form {
                                form.slow_mode = seconds;
                            }
                            cx.notify();
                        })
                        .ok();
                    });
                    (crate::format::timer_text(seconds), action)
                })
                .collect();
            body.push(labeled("Time between messages", select_box("slow-time", crate::format::timer_text(slow_mode), choices, cx).into_any_element(), cx));
        }
        if !text {
            let form = self.channel_form.as_ref().unwrap();
            let weak = cx.entity().downgrade();
            let pick = |value: f64, apply: fn(&mut ChannelForm, f64)| -> std::rc::Rc<dyn Fn(&mut Window, &mut gpui::App)> {
                let weak = weak.clone();
                std::rc::Rc::new(move |_, cx| {
                    weak.update(cx, |dialog, cx| {
                        if let Some(form) = &mut dialog.channel_form {
                            apply(form, value);
                        }
                        cx.notify();
                    })
                    .ok();
                })
            };
            let qualities = [(0., "Usual (64 kbit/s)"), (96., "Better (96 kbit/s)"), (128., "Great (128 kbit/s)"), (256., "Best (256 kbit/s)")];
            let quality_label = qualities.iter().find(|(kbps, _)| *kbps == form.bitrate).map(|(_, label)| label.to_string()).unwrap_or_else(|| format!("{} kbit/s", form.bitrate));
            let quality_choices = qualities.iter().map(|(kbps, label)| (label.to_string(), pick(*kbps, |form, value| form.bitrate = value))).collect();
            body.push(labeled("Audio quality", select_box("audio-quality", quality_label, quality_choices, cx).into_any_element(), cx));
            let limit = form.user_limit;
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .child(div().flex().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("People who fit: ").child(div().text_color(theme.text1).child(if limit == 0. { "no limit".to_string() } else { (limit as u32).to_string() })))
                    .child(slider("user-limit", (limit / 99.) as f32, {
                        let weak = weak.clone();
                        move |value, _, cx| {
                            weak.update(cx, |dialog, cx| {
                                if let Some(form) = &mut dialog.channel_form {
                                    form.user_limit = (value * 99.).round() as f64;
                                }
                                cx.notify();
                            })
                            .ok();
                        }
                    }, cx))
                    .into_any_element(),
            );
            let mut limits: Vec<(f64, String)> = vec![(0., "As the server's rules say".into()), (-1., "Off in this channel".into())];
            limits.extend([1., 2., 3., 4., 5., 10.].iter().map(|limit| (*limit, if *limit == 1. { "One at a time".to_string() } else { format!("Up to {limit} at once") })));
            if !limits.iter().any(|(limit, _)| *limit == form.screen_limit) {
                limits.push((form.screen_limit, format!("Up to {} at once", form.screen_limit)));
            }
            let screen_label = limits.iter().find(|(limit, _)| *limit == form.screen_limit).map(|(_, label)| label.clone()).unwrap_or_default();
            let screen_choices = limits.iter().map(|(limit, label)| (label.clone(), pick(*limit, |form, value| form.screen_limit = value))).collect();
            body.push(labeled("Screen sharing", select_box("screen-limit", screen_label, screen_choices, cx).into_any_element(), cx));
            let sounds = form.sounds;
            body.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Soundboard")).child(div().text_size(px(12.5)).text_color(theme.text3).child("Anyone in the channel can play the server's sounds to everyone there.")))
                    .child(switch("soundboard", sounds, cx).on_click(cx.listener(|dialog, _, _, cx| {
                        if let Some(form) = &mut dialog.channel_form {
                            form.sounds = !form.sounds;
                        }
                        cx.notify();
                    })))
                    .into_any_element(),
            );
        }
        body.push(div().text_size(px(12.5)).text_color(theme.text3).child("Everyone on this server can see and join channels. The name and everything said are end-to-end encrypted, so the server can't read them.").into_any_element());
        let busy = self.busy;
        let ready = !final_name.is_empty() && !busy;
        let editing = channel.is_some();
        let delete_channel = channel.clone();
        let footer = div()
            .flex()
            .w_full()
            .gap(px(8.))
            .when_some(delete_channel, |el, channel| {
                el.child(button("delete-channel", ButtonKind::Danger, ButtonSize::Normal, busy, cx).child(icon("trash", 14., theme.red)).child("Delete").on_click(cx.listener(move |_, _, window, cx| {
                    let answer = window.prompt(gpui::PromptLevel::Warning, &format!("Delete {}?", channel.name), Some("Its messages go for everyone."), &["Delete", "Cancel"], cx);
                    let (id, key) = (channel.id.clone(), channel.key.clone());
                    cx.spawn(async move |dialog, cx| {
                        if answer.await != Ok(0) {
                            return;
                        }
                        dialog
                            .update(cx, |dialog, cx| {
                                dialog.state.update(cx, |state, cx| {
                                    let server = state.active_server.clone();
                                    let open = state.active().and_then(|server| server.active_key.clone()) == Some(key.clone());
                                    state.call(server.as_deref(), "deleteChannel", vec![json!(id)], cx, move |state, result, cx| match result {
                                        Ok(_) => {
                                            if open {
                                                state.select_conversation(None, cx);
                                            }
                                            state.set_overlay(None, cx);
                                        }
                                        Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                    });
                                })
                            })
                            .ok();
                    })
                    .detach();
                })))
                .child(div().flex_1())
            })
            .child(button("cancel", ButtonKind::Default, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("save-channel", ButtonKind::Primary, ButtonSize::Normal, !ready, cx).child(if busy { "Saving…" } else if editing { "Save" } else { "Create channel" }).when(ready, |el| el.on_click(cx.listener(move |dialog, _, _, cx| dialog.save_channel(cx)))));
        self.modal(Some(if editing { "Edit channel".into() } else { "New channel".into() }), 460., body, Some(footer.into_any_element()), cx)
    }

    fn save_channel(&mut self, cx: &mut Context<Self>) {
        let DialogKind::Channel { channel_id, .. } = &self.kind else { return };
        let Some(form) = &self.channel_form else { return };
        let channel_id = channel_id.clone();
        let text = form.kind == "text";
        let name = if text { text_channel_name(self.name.read(cx).text()).trim_matches('-').to_string() } else { self.name.read(cx).text().trim().to_string() };
        let mut details = json!({
            "name": name,
            "topic": form.topic.read(cx).text().trim(),
            "category": form.category.read(cx).text().trim(),
            "userLimit": if text { 0. } else { form.user_limit },
            "screenLimit": if text { 0. } else { form.screen_limit },
            "slowMode": if form.slow_on { form.slow_mode } else { 0. },
        });
        if !text && form.bitrate > 0. {
            details["bitrate"] = json!(form.bitrate);
        }
        if !text {
            details["sounds"] = json!(form.sounds);
        }
        let call = {
            let state = self.state.read(cx);
            let server = state.active_server.clone();
            match &channel_id {
                Some(id) => state.core.call(server.as_deref(), "updateChannel", vec![json!(id), details]),
                None => {
                    details["type"] = json!(if text { "text" } else { "voice" });
                    state.core.call(server.as_deref(), "createChannel", vec![details])
                }
            }
        };
        self.busy = true;
        cx.notify();
        let created = channel_id.is_none();
        cx.spawn(async move |dialog, cx| {
            let result = call.await;
            dialog
                .update(cx, |dialog, cx| match result {
                    Ok(id) => dialog.state.update(cx, |state, cx| {
                        // Opening a voice channel is coming into it, which making one isn't asking for.
                        if created && text {
                            if let Some(id) = id.as_str() {
                                state.select_conversation(Some(format!("group:{id}")), cx);
                            }
                        }
                        state.set_overlay(None, cx);
                    }),
                    Err(error) => {
                        dialog.busy = false;
                        dialog.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
                        cx.notify();
                    }
                })
                .ok();
        })
        .detach();
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
}

impl Render for Dialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match &self.kind {
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
        }
    }
}

/// How far a picture can be zoomed, from fitted to the window.
const MAX_ZOOM: f32 = 8.;
/// How long a step of zooming glides, as `transform 0.12s` does.
const GLIDE: Duration = Duration::from_millis(120);

/// How the picture is shown: its scale from fitted, and where its center is from the
/// middle of the window.
#[derive(Clone, Copy, PartialEq)]
struct View {
    scale: f32,
    x: f32,
    y: f32,
}

const FITTED: View = View { scale: 1., x: 0., y: 0. };

/// A picture, fitted to the window over everything, as the desktop's ImageViewer shows it.
/// It zooms with the mouse wheel, a pinch, a double click, the keys or the buttons, towards
/// where the pointer is, and once it's bigger than the window it can be dragged around. A
/// click outside it or Escape closes it, and it can be saved.
pub struct ImageViewer {
    state: Entity<AppState>,
    file_id: String,
    name: String,
    focus: gpui::FocusHandle,
    /// Where it's going.
    view: View,
    /// Where a glide towards `view` started, and when.
    glide: Option<(View, Instant)>,
    /// Where a drag started: the pointer, and the view then.
    drag: Option<(gpui::Point<Pixels>, View)>,
    /// The picture's own size, by its id.
    natural: Option<(u64, f32, f32)>,
    viewport: gpui::Size<Pixels>,
}

impl ImageViewer {
    fn new(state: Entity<AppState>, file_id: String, name: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        ImageViewer { state, file_id, name, focus, view: FITTED, glide: None, drag: None, natural: None, viewport: window.viewport_size() }
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }

    /// Its size fitted to the window less 40 px around, never larger than its own.
    fn fitted(&self) -> (f32, f32) {
        let Some((_, width, height)) = self.natural else { return (0., 0.) };
        let (room_width, room_height) = (f32::from(self.viewport.width) - 80., f32::from(self.viewport.height) - 80.);
        let fit = (room_width / width).min(room_height / height).min(1.).max(0.);
        (width * fit, height * fit)
    }

    /// Where it is now, partway through a glide.
    fn current(&self) -> View {
        let Some((from, started)) = self.glide else { return self.view };
        let t = (started.elapsed().as_secs_f32() / GLIDE.as_secs_f32()).min(1.);
        // Close to the desktop's ease-out, cubic-bezier(0.2, 0, 0, 1).
        let eased = 1. - (1. - t).powi(3);
        let between = |a: f32, b: f32| a + (b - a) * eased;
        View { scale: between(from.scale, self.view.scale), x: between(from.x, self.view.x), y: between(from.y, self.view.y) }
    }

    /// Moves to a view, kept from going further than its edges reach past the window.
    fn show(&mut self, next: View, glide: bool, cx: &mut Context<Self>) {
        let scale = next.scale.clamp(1., MAX_ZOOM);
        let mut limited = FITTED;
        if scale > 1. {
            let (width, height) = self.fitted();
            let spare_x = ((width * scale - f32::from(self.viewport.width)) / 2.).max(0.);
            let spare_y = ((height * scale - f32::from(self.viewport.height)) / 2.).max(0.);
            limited = View { scale, x: next.x.clamp(-spare_x, spare_x), y: next.y.clamp(-spare_y, spare_y) };
        }
        self.glide = if glide { Some((self.current(), Instant::now())) } else { None };
        self.view = limited;
        cx.notify();
    }

    /// Zooms, keeping the point under the pointer, or the middle, where it is.
    fn zoom_to(&mut self, scale: f32, at: Option<gpui::Point<Pixels>>, glide: bool, cx: &mut Context<Self>) {
        let current = self.view;
        let target = scale.clamp(1., MAX_ZOOM);
        let (point_x, point_y) = match at {
            Some(at) => (f32::from(at.x) - f32::from(self.viewport.width) / 2., f32::from(at.y) - f32::from(self.viewport.height) / 2.),
            None => (0., 0.),
        };
        let ratio = target / current.scale;
        self.show(View { scale: target, x: point_x - (point_x - current.x) * ratio, y: point_y - (point_y - current.y) * ratio }, glide, cx);
    }

    /// A double click shows the picture at its own size, or twice as big if it already fits.
    fn closer_scale(&self) -> f32 {
        let (width, _) = self.fitted();
        match self.natural {
            Some((_, natural, _)) if width > 0. => (natural / width).min(MAX_ZOOM).max(2.),
            _ => 2.,
        }
    }

    fn save(&self, cx: &mut App) {
        let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
        let chosen = cx.prompt_for_new_path(&downloads, Some(&self.name));
        let bytes = match self.state.read(cx).pictures.get(&format!("file:{}", self.file_id)) {
            Some(crate::state::Picture::Ready(image)) => Some(image.bytes().to_vec()),
            _ => None,
        };
        cx.spawn(async move |_| {
            if let (Ok(Ok(Some(path))), Some(bytes)) = (chosen.await, bytes) {
                std::fs::write(path, bytes).ok();
            }
        })
        .detach();
    }

    fn on_wheel(&mut self, event: &gpui::ScrollEvent, cx: &mut Context<Self>) {
        // Windows gives lines: a mouse wheel's notch is a whole number of them, a touchpad's
        // scrolling a fraction, which pans instead. A line is about 33 px, as Chromium counts.
        let (delta, lines) = match event.delta {
            gpui::ScrollDelta::Lines(lines) => (lines, true),
            gpui::ScrollDelta::Pixels(pixels) => (gpui::point(f32::from(pixels.x) / 33.3, f32::from(pixels.y) / 33.3), false),
        };
        let wheel = lines && delta.x == 0. && delta.y != 0. && delta.y.fract().abs() < 0.001;
        let current = self.view;
        if event.modifiers.control || wheel {
            // A pinch comes as small steps with Ctrl held, a mouse wheel as whole notches.
            let pinch = event.modifiers.control && !wheel;
            let factor = if pinch { (delta.y * 33.3 / 100.).exp() } else if delta.y > 0. { 1.25 } else { 0.8 };
            self.zoom_to(current.scale * factor, Some(event.position), !pinch, cx);
        } else {
            self.show(View { x: current.x + delta.x * 33.3, y: current.y + delta.y * 33.3, ..current }, false, cx);
        }
    }
}

impl Render for ImageViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let image = match self.state.read(cx).pictures.get(&format!("file:{}", self.file_id)) {
            Some(crate::state::Picture::Ready(image)) => Some(image.clone()),
            _ => None,
        };
        if let Some(image) = &image {
            if self.natural.map(|(id, _, _)| id) != Some(image.id()) {
                let size = image::ImageReader::new(std::io::Cursor::new(image.bytes())).with_guessed_format().ok().and_then(|reader| reader.into_dimensions().ok());
                self.natural = size.map(|(width, height)| (image.id(), width.max(1) as f32, height.max(1) as f32));
            }
        }
        // Resizing keeps it within its edges, without a glide.
        let viewport = window.viewport_size();
        if viewport != self.viewport {
            self.viewport = viewport;
            let view = self.view;
            self.show(view, false, cx);
        }
        let view = self.current();
        if self.glide.is_some_and(|(_, started)| started.elapsed() < GLIDE) {
            window.request_animation_frame();
        } else {
            self.glide = None;
        }
        let (fitted_width, fitted_height) = self.fitted();
        let zoomed = self.view.scale > 1.;
        let dragging = self.drag.is_some();
        // The size it's shown at next to its own, as the desktop counts it.
        let percent = match self.natural {
            Some((_, natural, _)) if natural > 0. => (self.view.scale * fitted_width / natural * 100.).round(),
            _ => 100.,
        };
        let (width, height) = (fitted_width * view.scale, fitted_height * view.scale);
        let left = (f32::from(viewport.width) - width) / 2. + view.x;
        let top = (f32::from(viewport.height) - height) / 2. + view.y;
        let can_zoom_in = self.view.scale < MAX_ZOOM;
        let tool = |id: &'static str, name: &'static str, enabled: bool, cx: &mut Context<Self>| {
            icon_button(id, name, 17., false, false, cx).when(!enabled, |el| el.opacity(0.4).cursor_default())
        };
        div()
            .id("image-viewer")
            .track_focus(&self.focus)
            .absolute()
            .inset_0()
            .overflow_hidden()
            .bg(theme::color(theme::black_a(0.92)))
            .occlude()
            .on_click(cx.listener(|viewer, _, _, cx| viewer.close(cx)))
            .on_scroll(cx.listener(|viewer, event: &gpui::ScrollEvent, _, cx| viewer.on_wheel(event, cx)))
            .on_mouse_move(cx.listener(|viewer, event: &gpui::MouseMoveEvent, _, cx| {
                if let Some((from, start)) = viewer.drag {
                    if event.pressed_button == Some(gpui::MouseButton::Left) {
                        let current = viewer.view;
                        let moved = event.position - from;
                        viewer.show(View { x: start.x + f32::from(moved.x), y: start.y + f32::from(moved.y), ..current }, false, cx);
                    } else {
                        viewer.drag = None;
                        cx.notify();
                    }
                }
            }))
            .on_mouse_up(gpui::MouseButton::Left, cx.listener(|viewer, _, _, cx| {
                if viewer.drag.take().is_some() {
                    cx.notify();
                }
            }))
            .on_key_down(cx.listener(|viewer, event: &gpui::KeyDownEvent, _, cx| {
                let key = event.keystroke.key.as_str();
                let typed = event.keystroke.key_char.as_deref();
                let scale = viewer.view.scale;
                match key {
                    "escape" => viewer.close(cx),
                    "=" | "+" => viewer.zoom_to(scale * 1.5, None, true, cx),
                    "-" => viewer.zoom_to(scale / 1.5, None, true, cx),
                    "0" => viewer.show(FITTED, true, cx),
                    _ if typed == Some("+") => viewer.zoom_to(scale * 1.5, None, true, cx),
                    _ => {}
                }
            }))
            .when_some(image.filter(|_| fitted_width > 0.), |el, image| {
                el.child(
                    div()
                        .id("image-viewer-picture")
                        .absolute()
                        .left(px(left))
                        .top(px(top))
                        .w(px(width))
                        .h(px(height))
                        .when(zoomed, |el| el.cursor(if dragging { gpui::CursorStyle::ClosedHand } else { gpui::CursorStyle::OpenHand }))
                        .on_mouse_down(gpui::MouseButton::Left, cx.listener(|viewer, event: &gpui::MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            if event.click_count == 2 {
                                viewer.drag = None;
                                if viewer.view.scale > 1. {
                                    viewer.show(FITTED, true, cx);
                                } else {
                                    let closer = viewer.closer_scale();
                                    viewer.zoom_to(closer, Some(event.position), true, cx);
                                }
                            } else if viewer.view.scale > 1. {
                                viewer.drag = Some((event.position, viewer.view));
                                cx.notify();
                            }
                        }))
                        .child(gpui::img(image).size_full().when(!zoomed, |el| el.rounded(crate::theme::RADIUS_S))),
                )
            })
            .child(
                div()
                    .id("image-tools")
                    .absolute()
                    .right(px(18.))
                    .bottom(px(18.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .p(px(4.))
                    .rounded(RADIUS_L)
                    .bg(theme::color(theme::rgba(24, 24, 27, 0.85)))
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(tool("zoom-out", "zoom-out", zoomed, cx).on_click(cx.listener(|viewer, _, _, cx| {
                        if viewer.view.scale > 1. {
                            let scale = viewer.view.scale;
                            viewer.zoom_to(scale / 1.5, None, true, cx);
                        }
                    })))
                    .child(
                        div()
                            .id("image-zoom")
                            .min_w(px(50.))
                            .h(px(30.))
                            .px(px(6.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_M)
                            .text_size(px(12.5))
                            .text_color(theme.text2)
                            .when(zoomed, |el| el.cursor_pointer().hover(move |style| style.bg(theme.hover_strong).text_color(theme.text1)))
                            .on_click(cx.listener(|viewer, _, _, cx| {
                                if viewer.view.scale > 1. {
                                    viewer.show(FITTED, true, cx);
                                }
                            }))
                            .child(format!("{percent}%")),
                    )
                    .child(tool("zoom-in", "zoom-in", can_zoom_in, cx).on_click(cx.listener(|viewer, _, _, cx| {
                        let scale = viewer.view.scale;
                        viewer.zoom_to(scale * 1.5, None, true, cx);
                    })))
                    .child(button("save-image", ButtonKind::Default, ButtonSize::Normal, false, cx).ml(px(4.)).child("Save").on_click(cx.listener(|viewer, _, _, cx| viewer.save(cx)))),
            )
            .child(
                div()
                    .absolute()
                    .top(px(44.))
                    .right(px(18.))
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        // `.icon-btn.image-close`: on bg-3, and bg-4 under the pointer.
                        div()
                            .id("close-image")
                            .size(px(32.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_M)
                            .bg(theme.bg3)
                            .group("close-image")
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.bg4))
                            .child(gpui::svg().path("icons/x.svg").size(px(18.)).flex_none().text_color(theme.text2).group_hover("close-image", move |style| style.text_color(theme.text1)))
                            .on_click(cx.listener(|viewer, _, _, cx| {
                                cx.stop_propagation();
                                viewer.close(cx)
                            })),
                    ),
            )
            .enter("image-viewer-in", Enter::Fade, 100)
    }
}
