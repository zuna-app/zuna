//! Dialogs over the app: joining another server, a new group, invites, verifying
//! someone and leaving a server (packages/ui/src/features/overlays/Overlays.tsx).

use std::collections::BTreeSet;

use gpui::{AnyElement, AnyView, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px};
use serde_json::json;

use super::components::*;
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
        Overlay::AddMembers { group_id } => cx.new(|cx| Dialog::new(state, DialogKind::AddMembers(group_id), window, cx)).into(),
        Overlay::Channel { channel_id, category } => cx.new(|cx| Dialog::new(state, DialogKind::Channel { channel_id, kind: category }, window, cx)).into(),
        Overlay::Settings { .. } | Overlay::ServerSettings { .. } => return None,
        Overlay::Image { file_id, name } => cx.new(|cx| ImageViewer::new(state, file_id, name, window, cx)).into(),
    })
}

enum DialogKind {
    AddServer(Entity<Onboarding>),
    NewGroup,
    Invite,
    Verify(String),
    LeaveServer,
    Forward { server_id: String, group_id: String, ids: Vec<String> },
    AddMembers(String),
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
            name.read(cx).focus(window);
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
            name.read(cx).focus(window);
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
            people_search.read(cx).focus(window);
        }
        if matches!(kind, DialogKind::Forward { .. }) {
            people_search.update(cx, |input, cx| input.set_placeholder("Search chats", cx));
            people_search.read(cx).focus(window);
        }
        let mut dialog = Dialog { state, kind, name, people_search, selected: BTreeSet::new(), history: false, check: None, invite_link: None, busy: false, focused: None, channel_form, invite_panel: None, _subscriptions: subscriptions };
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
            .w_full()
            .max_w(px(width))
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
                    .child(div().id("modal-body").overflow_y_scroll().px(px(20.)).pt(px(10.)).pb(px(20.)).flex().flex_col().gap(px(14.)).children(body));
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
                        .child(div().absolute().right(px(10.)).top(px(10.)).child(icon_button("close-modal", "x", 17., true, false, cx).on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx)))))
                        .children(body),
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
            .child(card)
            .into_any_element()
    }

    fn new_group(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let mut users: Vec<_> = server.users.values().filter(|user| user.id != server.self_id() && !user.banned).cloned().collect();
        users.sort_by_key(|user| user.display_name.to_lowercase());
        let filtered: Vec<_> = users.into_iter().filter(|user| query.is_empty() || user.display_name.to_lowercase().contains(&query) || user.username.to_lowercase().contains(&query)).collect();
        let mut people = div().id("people-list").max_h(px(260.)).overflow_y_scroll().flex().flex_col().gap(px(1.)).mx(px(-4.));
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
                .child(people)
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
        body.push(
            div()
                .grid()
                .grid_cols(4)
                .gap(px(6.))
                .p(px(12.))
                .rounded(RADIUS_L)
                .bg(theme.bg2)
                .children(emoji.into_iter().map(|item| {
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(2.))
                        .px(px(2.))
                        .py(px(6.))
                        .child(div().text_size(px(30.)).line_height(gpui::relative(1.1)).child(item.emoji))
                        .child(div().text_size(px(11.)).text_color(theme.text2).text_center().child(item.name))
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
        let mut list = div().id("forward-list").max_h(px(380.)).mt(px(10.)).overflow_y_scroll().flex().flex_col().mx(px(-4.));
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
        self.modal(Some("Forward to".into()), 440., vec![div().flex().flex_col().child(search).child(list).into_any_element()], None, cx)
    }

    /// People to pick from, with a search above them, as `PeoplePicker` lists them.
    fn people_picker(&mut self, server: &crate::state::ServerState, users: Vec<crate::models::UserView>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let filtered: Vec<_> = users.into_iter().filter(|user| query.is_empty() || user.display_name.to_lowercase().contains(&query) || user.username.to_lowercase().contains(&query)).collect();
        let mut people = div().id("people-list").max_h(px(260.)).overflow_y_scroll().flex().flex_col().gap(px(1.)).mx(px(-4.));
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
            .child(people)
            .into_any_element()
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
                div()
                    .id(kind)
                    .flex_1()
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
                    .child(div().flex().flex_col().child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(title)).child(div().text_size(px(12.)).text_color(theme.text3).child(text)))
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
                el.child(button("delete-channel", ButtonKind::Danger, ButtonSize::Normal, busy, cx).child(icon("trash", 14., theme.red)).child("Delete").on_click(cx.listener(move |dialog, _, window, cx| {
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

/// A picture, fitted to the window over everything, as the desktop's ImageViewer shows it:
/// a click outside or Escape closes it, and it can be saved.
pub struct ImageViewer {
    state: Entity<AppState>,
    file_id: String,
    name: String,
    focus: gpui::FocusHandle,
}

impl ImageViewer {
    fn new(state: Entity<AppState>, file_id: String, name: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus);
        ImageViewer { state, file_id, name, focus }
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }
}

impl Render for ImageViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let image = match self.state.read(cx).pictures.get(&format!("file:{}", self.file_id)) {
            Some(crate::state::Picture::Ready(image)) => Some(image.clone()),
            _ => None,
        };
        let viewport = window.viewport_size();
        let name = self.name.clone();
        let file_id = self.file_id.clone();
        let state = self.state.clone();
        div()
            .id("image-viewer")
            .track_focus(&self.focus)
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme::color(theme::black_a(0.92)))
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|viewer, _, _, cx| viewer.close(cx)))
            .on_key_down(cx.listener(|viewer, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    viewer.close(cx);
                }
            }))
            .when_some(image, |el, image| {
                el.child(
                    gpui::img(image)
                        .max_w(viewport.width - px(80.))
                        .max_h(viewport.height - px(80.))
                        .rounded(crate::theme::RADIUS_S)
                        .object_fit(gpui::ObjectFit::Contain),
                )
            })
            .child(
                div()
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
                    .child(icon_button("save-image", "download", 18., false, false, cx).tooltip(tooltip("Save")).on_click(move |_, _, cx| {
                        let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
                        let chosen = cx.prompt_for_new_path(&downloads, Some(&name));
                        let source = crate::host::data_dir();
                        let key = format!("file:{}", file_id);
                        let bytes = match state.read(cx).pictures.get(&key) {
                            Some(crate::state::Picture::Ready(image)) => Some(image.bytes().to_vec()),
                            _ => None,
                        };
                        let _ = source;
                        cx.spawn(async move |_| {
                            if let (Ok(Ok(Some(path))), Some(bytes)) = (chosen.await, bytes) {
                                std::fs::write(path, bytes).ok();
                            }
                        })
                        .detach();
                    })),
            )
            .child(
                div()
                    .absolute()
                    .top(px(44.))
                    .right(px(18.))
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(icon_button("close-image", "x", 18., false, false, cx).bg(theme.bg3).on_click(cx.listener(|viewer, _, _, cx| viewer.close(cx)))),
            )
    }
}
