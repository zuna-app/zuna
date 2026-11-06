//! The sidebar: the server's name, search, filters and the conversations
//! (packages/ui/src/features/shell/ConversationList.tsx).

use std::time::Duration;

use gpui::{
    AnyElement, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Render, SharedString, Styled, Subscription, Task, Window,
    div, prelude::*, px,
};
use serde_json::json;

use super::components::*;
use super::menu::{MenuEntry, open_menu};
use super::text_input::{InputEvent, TextInput};
use crate::format::format_list_time;
use crate::markup::plain_text;
use crate::models::{ChannelView, ConversationView, MessageView, SearchResult, UserView, VoiceMember};
use crate::state::{AppState, Overlay, ServerState};
use crate::theme::{RADIUS_M, RADIUS_S};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    All,
    Channels,
    People,
    Groups,
    Unread,
}

pub struct ConversationList {
    state: Entity<AppState>,
    search: Entity<TextInput>,
    filter: Filter,
    show_hidden: bool,
    hits: Vec<SearchResult>,
    searching: Option<Task<()>>,
    search_focused: bool,
    _subscriptions: Vec<Subscription>,
}

/// What a row says under its name (previewFor).
pub fn preview_for(message: Option<&MessageView>, users: &std::collections::HashMap<String, UserView>, self_id: &str, kind: &str) -> String {
    let Some(message) = message else { return String::new() };
    if let Some(system) = &message.system {
        if system.kind == "timer_changed" {
            let seconds = system.seconds.unwrap_or(0.);
            return if seconds > 0. { format!("Messages disappear after {}", crate::format::timer_text(seconds)) } else { "Disappearing messages turned off".into() };
        }
        return "Membership changed".into();
    }
    match message.status.as_str() {
        "undecryptable" => return "Waiting for keys".into(),
        "invalid" | "unverified" => return "A message that couldn't be displayed".into(),
        _ => {}
    }
    let author = if message.sender_id == self_id {
        Some("You".to_string())
    } else if kind == "group" {
        users.get(&message.sender_id).map(|user| user.display_name.split(' ').next().unwrap_or("").to_string())
    } else {
        None
    };
    let body = if !message.text.is_empty() {
        plain_text(&message.text).chars().take(80).collect()
    } else if message.location.is_some() {
        "Location".to_string()
    } else if let Some(first) = message.attachments.first() {
        if first.voice == Some(true) {
            "Voice message".into()
        } else if first.round == Some(true) {
            "Video message".into()
        } else if first.mime.starts_with("image/") {
            "Photo".into()
        } else if first.mime.starts_with("video/") {
            "Video".into()
        } else {
            first.name.clone()
        }
    } else {
        String::new()
    };
    match author {
        Some(author) => format!("{author}: {body}"),
        None => body,
    }
}

impl ConversationList {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| TextInput::new(cx, "Search"));
        let mut subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.subscribe_in(&search, window, |list, input, event, window, cx| match event {
                InputEvent::Changed => list.run_search(cx),
                InputEvent::Escape => {
                    input.update(cx, |input, cx| input.set_text("", cx));
                    window.blur();
                }
                InputEvent::Focused => {
                    list.search_focused = true;
                    cx.notify();
                }
                InputEvent::Blurred => {
                    list.search_focused = false;
                    cx.notify();
                }
                _ => {}
            }),
        ];
        // Who's speaking in a voice channel shows in the list.
        if let Some(voice) = crate::voice::get(cx) {
            subscriptions.push(cx.observe(&voice, |_, _, cx| cx.notify()));
        }
        ConversationList { state, search, filter: Filter::All, show_hidden: false, hits: Vec::new(), searching: None, search_focused: false, _subscriptions: subscriptions }
    }

    pub fn focus_search(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.read(cx).focus(window);
    }

    /// Message search runs against the encrypted index on this device.
    fn run_search(&mut self, cx: &mut Context<Self>) {
        let query = self.search.read(cx).text().trim().to_string();
        if query.chars().count() < 2 {
            self.hits.clear();
            self.searching = None;
            cx.notify();
            return;
        }
        let state = self.state.clone();
        self.searching = Some(cx.spawn(async move |list, cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            let Ok(call) = state.update(cx, |state, _| {
                state.active_server.clone().map(|server| state.core.call(Some(&server), "search", vec![json!(query), crate::host::undefined(), json!(30)]))
            }) else {
                return;
            };
            let Some(call) = call else { return };
            if let Ok(value) = call.await {
                let hits: Vec<SearchResult> = crate::models::from_value(value);
                list.update(cx, |list, cx| {
                    list.hits = hits;
                    cx.notify();
                })
                .ok();
            }
        }));
    }

    fn row(&self, item: &ConversationView, server: &ServerState, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let active = server.active_key.as_deref() == Some(item.key.as_str());
        let self_id = server.self_id().to_string();
        let peer = item.peer_id.as_ref().and_then(|id| server.users.get(id)).cloned();
        let is_saved = item.peer_id.as_deref() == Some(self_id.as_str());
        let typing = item.group_id.as_ref().is_some_and(|group| server.typing.get(group).is_some_and(|typing| !typing.is_empty()));
        let call = item.group_id.as_ref().is_some_and(|group| server.calls.contains_key(group));
        let preview = preview_for(item.last_message.as_ref(), &server.users, &self_id, &item.kind);
        let fallback = if item.kind == "dm" && !is_saved {
            peer.as_ref().map(|peer| format!("@{}", peer.username)).unwrap_or_default()
        } else if is_saved {
            "Notes to yourself".into()
        } else {
            String::new()
        };
        let row_bg = if active { theme.bg3 } else { theme.bg1 };
        let avatar_el: AnyElement = if is_saved {
            div().size(px(46.)).flex_none().rounded_full().bg(theme.bg4).flex().items_center().justify_center().child(icon("bookmark", 19., theme.text1)).into_any_element()
        } else {
            let image = item.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            avatar(
                AvatarProps {
                    name: item.title.clone(),
                    seed: item.peer_id.clone().or(item.group_id.clone()).unwrap_or(item.key.clone()),
                    image,
                    size: 46.,
                    online: peer.as_ref().is_some_and(|peer| peer.online),
                    rounded: false,
                    dot_border: row_bg,
                },
                cx,
            )
            .into_any_element()
        };
        let mut title = div().flex_1().min_w_0().flex().items_center().gap(px(5.)).text_size(px(14.)).font_weight(FontWeight::MEDIUM);
        if item.kind == "group" {
            title = title.child(icon("users-round", 13., theme.text3));
        }
        title = title.child(div().min_w_0().one_line().child(item.title.clone()));
        if let Some(peer) = &peer {
            if peer.trust == "verified" {
                title = title.child(icon("badge-check", 14., theme.text2));
            } else if peer.trust == "changed" {
                title = title.child(icon("shield-alert", 14., theme.amber));
            }
        }
        if item.muted {
            title = title.child(icon("bell-off", 12., theme.text3));
        }
        if item.blocked {
            title = title.child(icon("ban", 12., theme.text3));
        }
        let preview_el: AnyElement = if typing {
            div().flex().items_center().gap(px(4.)).text_color(theme.text1).child("typing").child(typing_dots(theme.text1)).into_any_element()
        } else if call {
            div().flex().items_center().gap(px(4.)).text_color(theme.green).child(icon("phone", 12., theme.green)).child("In a call").into_any_element()
        } else if preview.is_empty() {
            div().text_color(theme.text3).one_line().child(fallback).into_any_element()
        } else {
            div().one_line().child(preview).into_any_element()
        };
        let badge = |text: String, muted: bool| {
            div()
                .flex_none()
                .min_w(px(18.))
                .h(px(18.))
                .px(px(5.))
                .rounded(px(9.))
                .bg(if muted { theme.bg5 } else { theme.accent })
                .text_color(if muted { theme.text2 } else { theme.on_accent })
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .line_height(px(18.))
                .flex()
                .justify_center()
                .child(text)
        };
        let mut second = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .min_h(px(20.))
            .child(div().flex_1().min_w_0().text_size(px(13.)).text_color(theme.text2).child(preview_el));
        if item.pinned && item.unread == 0. && !item.marked_unread {
            second = second.child(icon("pin", 13., theme.text3).with_transformation(gpui::Transformation::rotate(gpui::radians(35f32.to_radians()))));
        }
        if item.unread_mentions > 0. {
            second = second.child(
                div().flex_none().size(px(18.)).rounded(px(9.)).bg(if item.muted { theme.bg5 } else { theme.accent }).flex().items_center().justify_center().child(icon(
                    "at-sign",
                    12.,
                    if item.muted { theme.text2 } else { theme.on_accent },
                )),
            );
        }
        if item.unread > 0. {
            let count = item.unread as u32;
            second = second.child(badge(if count > 99 { "99+".into() } else { count.to_string() }, item.muted));
        } else if item.marked_unread {
            second = second.child(badge(String::new(), item.muted));
        }
        let key = item.key.clone();
        let state = self.state.clone();
        let menu_item = item.clone();
        let menu_state = self.state.clone();
        let prefs = server.prefs.clone();
        div()
            .id(SharedString::from(format!("conv-{}", item.key)))
            .w_full()
            .flex()
            .items_center()
            .gap(px(11.))
            .px(px(12.))
            .py(px(7.))
            .bg(row_bg)
            .when(!active, |el| el.hover(move |style| style.bg(theme.hover)))
            .cursor_pointer()
            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx)))
            .on_mouse_down(MouseButton::Right, move |event, _, cx| {
                open_menu(event.position, row_entries(&menu_item, &prefs, menu_state.clone()), false, cx);
            })
            .child(avatar_el)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .min_h(px(20.))
                            .child(title)
                            .child(div().flex_none().text_size(px(11.5)).text_color(theme.text3).child(format_list_time(item.last_message.as_ref().map(|m| m.created_at).unwrap_or(0.)))),
                    )
                    .child(second),
            )
            .into_any_element()
    }
}

fn row_entries(item: &ConversationView, prefs: &crate::models::Preferences, state: Entity<AppState>) -> Vec<MenuEntry> {
    let key = item.key.clone();
    let toggle = |list: &'static str, current: Vec<String>, key: String, state: Entity<AppState>| {
        move |_: &mut Window, cx: &mut gpui::App| {
            let next: Vec<String> = if current.contains(&key) { current.iter().filter(|item| **item != key).cloned().collect() } else { [current.clone(), vec![key.clone()]].concat() };
            state.update(cx, |state, cx| state.act("updatePreferences", vec![json!({ list: next })], cx));
        }
    };
    let mut entries = vec![if item.pinned {
        MenuEntry::new("Unpin", "pin-off", toggle("pinned", prefs.pinned.clone(), key.clone(), state.clone()))
    } else {
        MenuEntry::new("Pin to top", "pin", toggle("pinned", prefs.pinned.clone(), key.clone(), state.clone()))
    }];
    if item.unread > 0. || item.marked_unread {
        let (state, key) = (state.clone(), key.clone());
        entries.push(MenuEntry::new("Mark as read", "check-check", move |_, cx| state.update(cx, |state, cx| state.act("markChatRead", vec![json!(key)], cx))));
    } else if item.group_id.is_some() {
        let (state, key) = (state.clone(), key.clone());
        entries.push(MenuEntry::new("Mark as unread", "message-square-dot", move |_, cx| {
            state.update(cx, |state, cx| state.act("setMarkedUnread", vec![json!(key), json!(true)], cx))
        }));
    }
    if item.muted {
        let (state, key) = (state.clone(), key.clone());
        entries.push(MenuEntry::new("Unmute", "volume-2", move |_, cx| state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx))));
    } else {
        entries.push(MenuEntry::submenu("Mute", "volume-x", mute_entries(key.clone(), state.clone())));
    }
    entries.push(if item.hidden {
        MenuEntry::new("Show in list", "eye", toggle("hidden", prefs.hidden.clone(), key.clone(), state.clone()))
    } else {
        MenuEntry::new("Hide from list", "eye-off", toggle("hidden", prefs.hidden.clone(), key.clone(), state.clone()))
    });
    entries
}

/// For an hour, eight hours, a day, a week, or until unmuted (lib/mute.ts).
pub fn mute_entries(key: String, state: Entity<AppState>) -> Vec<MenuEntry> {
    let choice = |label: &str, hours: Option<f64>| {
        let (state, key) = (state.clone(), key.clone());
        MenuEntry::new(label, "clock", move |_, cx| {
            let until = hours.map(|hours| json!(crate::format::now_ms() + hours * 3_600_000.)).unwrap_or_else(crate::host::undefined);
            state.update(cx, |state, cx| state.act("mute", vec![json!(key), until], cx))
        })
    };
    let mut entries = vec![choice("For 1 hour", Some(1.)), choice("For 8 hours", Some(8.)), choice("For 1 day", Some(24.)), choice("For 1 week", Some(168.))];
    let (state, key) = (state.clone(), key.clone());
    entries.push(MenuEntry::new("Until I unmute", "bell-off", move |_, cx| state.update(cx, |state, cx| state.act("mute", vec![json!(key)], cx))));
    entries
}

impl Render for ConversationList {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let query = self.search.read(cx).text().trim().to_lowercase();
        let filter = self.filter;
        let matches = |item: &ConversationView| {
            if !query.is_empty() {
                let username = item.peer_id.as_ref().and_then(|id| server.users.get(id)).map(|user| user.username.to_lowercase()).unwrap_or_default();
                if !item.title.to_lowercase().contains(&query) && !username.contains(&query) {
                    return false;
                }
            }
            match filter {
                Filter::Channels => false,
                Filter::People => item.kind == "dm",
                Filter::Groups => item.kind == "group",
                Filter::Unread => item.unread > 0. || item.marked_unread,
                Filter::All => true,
            }
        };
        let filtered: Vec<&ConversationView> = server.conversations.iter().filter(|item| matches(item)).collect();
        let (visible, hidden): (Vec<&ConversationView>, Vec<&ConversationView>) = if query.is_empty() {
            (
                filtered.iter().copied().filter(|item| !item.hidden && !item.blocked).collect(),
                filtered.iter().copied().filter(|item| item.hidden && !item.blocked).collect(),
            )
        } else {
            (filtered.clone(), Vec::new())
        };

        let header_state = self.state.clone();
        let is_admin = server.is_admin();
        let header = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .px(px(8.))
            .h(px(52.))
            .child(
                div()
                    .id("server-title")
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(RADIUS_M)
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.hover))
                    .on_click(move |event, _, cx| {
                        let state = header_state.clone();
                        let mut entries = vec![
                            {
                                let state = state.clone();
                                MenuEntry::new("Invite people", "link", move |_, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Invite), cx)))
                            },
                            {
                                let state = state.clone();
                                MenuEntry::new("New group", "users-round", move |_, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::NewGroup), cx)))
                            },
                        ];
                        if is_admin {
                            let settings = state.clone();
                            entries.push(MenuEntry::new("Server settings", "settings", move |_, cx| settings.update(cx, |state, cx| state.set_overlay(Some(Overlay::ServerSettings { section: None }), cx))));
                        }
                        entries.push(MenuEntry::separator());
                        let leave = state.clone();
                        entries.push(MenuEntry::new("Leave this server", "log-out", move |_, cx| leave.update(cx, |state, cx| state.set_overlay(Some(Overlay::LeaveServer), cx))).danger());
                        let position = gpui::point(event.position().x - px(60.), event.position().y + px(18.));
                        open_menu(position, entries, false, cx);
                    })
                    .child(div().min_w_0().one_line().child(server.entry.name.clone()))
                    .child(icon("chevron-down", 15., theme.text3)),
            )
            .child({
                let state = self.state.clone();
                icon_button("new-group", "square-pen", 17., false, false, cx)
                    .tooltip(tooltip("New group"))
                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::NewGroup), cx)))
            });

        let has_query = !self.search.read(cx).text().is_empty();
        let search_input = self.search.clone();
        let search = div().flex_none().px(px(10.)).pb(px(8.)).child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .bg(theme.bg3)
                .rounded(RADIUS_M)
                .border_1()
                .border_color(if self.search_focused { theme.line_strong } else { gpui::transparent_black() })
                .px(px(11.))
                .h(px(34.))
                .text_size(px(13.5))
                .line_height(px(20.))
                .child(icon("search", 14., theme.text3))
                .child(div().flex_1().min_w_0().child(self.search.clone()))
                .when(has_query, |el| {
                    el.child(icon_button("clear-search", "x", 14., true, false, cx).on_click(move |_, _, cx| search_input.update(cx, |input, cx| input.set_text("", cx))))
                }),
        );

        let shows_channels = !server.channels.is_empty() || server.is_admin();
        let mut filters = vec![(Filter::All, "All")];
        if shows_channels {
            filters.push((Filter::Channels, "Channels"));
        }
        filters.extend([(Filter::People, "People"), (Filter::Groups, "Groups"), (Filter::Unread, "Unread")]);
        let tabs = div().flex().flex_none().gap(px(16.)).px(px(14.)).border_b_1().border_color(theme.line).children(filters.into_iter().map(|(id, label)| {
            let active = self.filter == id;
            div()
                .id(label)
                .relative()
                .pt(px(5.))
                .pb(px(8.))
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if active { theme.text1 } else { theme.text3 })
                .cursor_pointer()
                .when(!active, |el| el.hover(move |style| style.text_color(theme.text2)))
                .on_click(cx.listener(move |list, _, _, cx| {
                    list.filter = id;
                    cx.notify();
                }))
                .child(label)
                .when(active, |el| el.child(div().absolute().left_0().right_0().bottom(px(-1.)).h(px(2.)).rounded_t(px(2.)).bg(theme.text1)))
        }));

        let mut rows: Vec<AnyElement> = Vec::new();
        if matches!(self.filter, Filter::All | Filter::Channels) {
            rows.extend(self.channel_rows(&server, &query, cx));
        }
        for item in &visible {
            rows.push(self.row(item, &server, cx));
        }
        if !self.hits.is_empty() {
            rows.push(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).px(px(14.)).py(px(6.)).mt(px(6.)).child("Messages").into_any_element());
            for hit in self.hits.clone() {
                let conversation = server.find_conversation(&hit.conversation_key).map(|c| c.title.clone()).unwrap_or_else(|| "Conversation".into());
                let sender = server.users.get(&hit.message.sender_id).cloned();
                let state = self.state.clone();
                let key = hit.conversation_key.clone();
                let group = hit.message.group_id.clone();
                let id = hit.message.id.clone();
                rows.push(
                    div()
                        .id(SharedString::from(format!("hit-{}", hit.message.id)))
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(11.))
                        .px(px(12.))
                        .py(px(7.))
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover))
                        .on_click(move |_, _, cx| {
                            state.update(cx, |state, cx| {
                                state.select_conversation(Some(key.clone()), cx);
                                state.jump_to_message(&group, &id, cx);
                            })
                        })
                        .child(avatar(
                            AvatarProps {
                                name: sender.as_ref().map(|s| s.display_name.clone()).unwrap_or("?".into()),
                                seed: hit.message.sender_id.clone(),
                                image: None,
                                size: 36.,
                                online: false,
                                rounded: false,
                                dot_border: theme.bg1,
                            },
                            cx,
                        ))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(1.))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .child(div().flex_1().min_w_0().one_line().font_weight(FontWeight::MEDIUM).child(conversation))
                                        .child(div().text_size(px(11.5)).text_color(theme.text3).child(format_list_time(hit.message.created_at))),
                                )
                                .child(div().one_line().text_size(px(13.)).text_color(theme.text2).child(plain_text(&hit.message.text))),
                        )
                        .into_any_element(),
                );
            }
        }
        if visible.is_empty() && hidden.is_empty() && self.hits.is_empty() && self.filter != Filter::Channels {
            let message = if !query.is_empty() {
                "Nothing matches that search."
            } else if self.filter == Filter::Unread {
                "You're all caught up."
            } else if self.filter == Filter::Groups {
                "No groups yet."
            } else {
                "It's quiet here."
            };
            let groups = self.filter == Filter::Groups;
            let state = self.state.clone();
            rows.push(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(6.))
                    .px(px(20.))
                    .py(px(32.))
                    .text_color(theme.text2)
                    .child(message)
                    .when(query.is_empty() && self.filter != Filter::Unread, |el| {
                        el.child(
                            button("empty-action", ButtonKind::Default, ButtonSize::Small, false, cx)
                                .child(if groups { "Create a group" } else { "Invite people" })
                                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(if groups { Overlay::NewGroup } else { Overlay::Invite }), cx))),
                        )
                    })
                    .into_any_element(),
            );
        }
        if !hidden.is_empty() {
            let open = self.show_hidden;
            rows.push(
                div()
                    .id("hidden-toggle")
                    .mt(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(14.))
                    .py(px(6.))
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text3)
                    .cursor_pointer()
                    .hover(move |style| style.text_color(theme.text2))
                    .on_click(cx.listener(|list, _, _, cx| {
                        list.show_hidden = !list.show_hidden;
                        cx.notify();
                    }))
                    .child(icon(if open { "chevron-down" } else { "chevron-right" }, 14., theme.text3))
                    .child(format!("Hidden ({})", hidden.len()))
                    .into_any_element(),
            );
            if open {
                for item in &hidden {
                    rows.push(self.row(item, &server, cx));
                }
            }
        }

        div()
            .flex()
            .flex_col()
            .size_full()
            .child(header)
            .child(search)
            .child(tabs)
            .child(div().id("conv-list").flex_1().min_h_0().overflow_y_scroll().pt(px(4.)).pb(px(8.)).children(rows))
            .into_any_element()
    }
}

impl ConversationList {
    /// The server's channels, under headings that fold away, as in Discord (features/voice/ChannelList.tsx).
    fn channel_rows(&self, server: &ServerState, query: &str, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let is_admin = server.is_admin();
        let mut channels: Vec<ChannelView> = server.channels.clone();
        channels.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap_or(std::cmp::Ordering::Equal));
        if channels.is_empty() && !is_admin {
            return Vec::new();
        }
        let order: Vec<String> = channels.iter().map(|channel| channel.id.clone()).collect();
        let shown: Vec<ChannelView> = channels.into_iter().filter(|channel| query.is_empty() || channel.name.to_lowercase().contains(query)).collect();
        // A channel's own heading if it has one, or one for its type, in the order they come up.
        let mut sections: Vec<(String, String, Vec<ChannelView>)> = Vec::new();
        for channel in shown {
            let name = if !channel.category.is_empty() { channel.category.clone() } else if channel.kind == "voice" { "Voice channels".into() } else { "Text channels".into() };
            match sections.iter_mut().find(|(section, _, _)| *section == name) {
                Some((_, _, list)) => list.push(channel),
                None => sections.push((name, channel.kind.clone(), vec![channel])),
            }
        }
        let collapsed = self.state.read(cx).settings.collapsed_categories.clone();
        let mut container = div().flex().flex_col().pt(px(2.)).pb(px(6.)).mb(px(4.)).border_b_1().border_color(theme.line);
        for (name, kind, list) in sections {
            let folded = collapsed.contains(&name) && query.is_empty();
            let group = SharedString::from(format!("section-{name}"));
            let toggle_state = self.state.clone();
            let toggle_name = name.clone();
            let mut head = div()
                .group(group.clone())
                .flex()
                .items_center()
                .gap(px(2.))
                .pt(px(6.))
                .pr(px(8.))
                .pb(px(4.))
                .pl(px(6.))
                .min_h(px(24.))
                .child(
                    div()
                        .id(SharedString::from(format!("section-title-{name}")))
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(2.))
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text3)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(theme.text1))
                        .on_click(move |_, _, cx| {
                            let name = toggle_name.clone();
                            toggle_state.update(cx, |state, cx| {
                                state.update_settings(
                                    |settings| {
                                        if let Some(index) = settings.collapsed_categories.iter().position(|item| *item == name) {
                                            settings.collapsed_categories.remove(index);
                                        } else {
                                            settings.collapsed_categories.push(name);
                                        }
                                    },
                                    cx,
                                )
                            })
                        })
                        .child(icon(if folded { "chevron-right" } else { "chevron-down" }, 12., theme.text3))
                        .child(div().min_w_0().one_line().child(name.to_uppercase())),
                );
            if is_admin {
                let (state, kind) = (self.state.clone(), kind.clone());
                head = head.child(
                    div().opacity(0.).group_hover(group.clone(), |style| style.opacity(1.)).child(
                        icon_button(SharedString::from(format!("new-in-{name}")), "plus", 14., true, false, cx)
                            .tooltip(tooltip("New channel"))
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: None, category: Some(kind.clone()) }), cx))),
                    ),
                );
            }
            let mut section = div().flex().flex_col().pt(px(10.)).child(head);
            // A folded heading keeps showing what someone's in, and what mentions them.
            let self_id = server.self_id().to_string();
            let visible: Vec<&ChannelView> = if folded {
                list.iter()
                    .filter(|channel| {
                        channel.conversation.as_ref().is_some_and(|c| c.unread_mentions > 0.) || server.voice.values().any(|member| member.channel_id == channel.id && member.user_id == self_id)
                    })
                    .collect()
            } else {
                list.iter().collect()
            };
            for channel in visible {
                section = section.child(self.channel_row(server, channel, is_admin && !folded && query.is_empty(), &order, cx));
            }
            container = container.child(section);
        }
        if server.channels.is_empty() && is_admin && query.is_empty() {
            let state = self.state.clone();
            container = container.child(
                div().px(px(14.)).pt(px(8.)).pb(px(10.)).child(
                    button("first-channel", ButtonKind::Default, ButtonSize::Small, false, cx)
                        .child(icon("plus", 14., theme.text1))
                        .child("New channel")
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: None, category: Some("text".into()) }), cx))),
                ),
            );
        }
        vec![container.into_any_element()]
    }

    fn channel_row(&self, server: &ServerState, channel: &ChannelView, can_reorder: bool, order: &[String], cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let is_admin = server.is_admin();
        let active = server.active_key.as_deref() == Some(channel.key.as_str());
        let conversation = channel.conversation.as_ref();
        // A voice channel is somewhere to go, not something to read, so only a mention marks one.
        let unread = channel.kind == "text" && conversation.is_some_and(|c| c.unread > 0. && !c.muted);
        let mentions = conversation.map(|c| c.unread_mentions).unwrap_or(0.);
        let muted = conversation.is_some_and(|c| c.muted);
        let mut occupants: Vec<VoiceMember> = server.voice.values().filter(|member| member.channel_id == channel.id).cloned().collect();
        occupants.sort_by(|a, b| a.since.partial_cmp(&b.since).unwrap_or(std::cmp::Ordering::Equal));
        let full = channel.user_limit > 0. && occupants.len() as f64 >= channel.user_limit;
        let connected = crate::voice::connected_channel(cx).is_some_and(|(server_id, channel_id)| server_id == server.entry.id && channel_id == channel.id);
        let title = if !channel.name.is_empty() { channel.name.clone() } else if channel.unreadable { "Unreadable channel".into() } else { "Channel".into() };
        let group = SharedString::from(format!("channel-{}", channel.id));
        let (open_state, open_channel) = (self.state.clone(), channel.clone());
        let menu = self.channel_menu(server, channel);
        let mut row = div()
            .id(group.clone())
            .group(group.clone())
            .relative()
            .mx(px(8.))
            .mt(px(2.))
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(8.))
            .py(px(6.))
            .min_h(px(34.))
            .rounded(RADIUS_S)
            .text_size(px(16.))
            .line_height(px(20.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if active || unread { theme.text1 } else { theme.text3 })
            .when(active, |el| el.bg(theme.bg3))
            .when(!active && !channel.unreadable, |el| el.hover(move |style| style.bg(theme.hover).text_color(theme.text2)))
            .when(channel.unreadable, |el| el.opacity(0.5))
            .when(!channel.unreadable, |el| el.cursor_pointer())
            .when(!channel.topic.is_empty(), |el| el.tooltip(tooltip(channel.topic.clone())))
            .on_click(move |_, window, cx| {
                if !open_channel.unreadable {
                    crate::voice::open_channel(&open_state, &open_channel, window, cx);
                }
            })
            .on_mouse_down(gpui::MouseButton::Right, move |event, _, cx| {
                if !menu.is_empty() {
                    open_menu(event.position, menu.clone(), false, cx);
                }
            })
            .when(unread, |el| el.child(div().absolute().left(px(-8.)).top(px(13.)).w(px(4.)).h(px(8.)).rounded_r(px(4.)).bg(theme.text1)))
            .child(icon(if channel.kind == "voice" { "volume-2" } else { "hash" }, 20., if connected { theme.green } else { theme.text3 }))
            .child(div().flex_1().min_w_0().one_line().when(unread, |el| el.font_weight(FontWeight::SEMIBOLD)).child(title.clone()))
            .when(muted, |el| el.child(icon("bell-off", 12., theme.text3)))
            .when(channel.kind == "voice" && channel.user_limit > 0., |el| {
                el.child(
                    div()
                        .flex_none()
                        .px(px(5.))
                        .py(px(1.))
                        .rounded(px(4.))
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .bg(if full { theme.red_soft } else { theme.bg3 })
                        .text_color(if full { theme.red } else { theme.text3 })
                        .child(format!("{}/{}", occupants.len(), channel.user_limit as u32)),
                )
            })
            .when(is_admin, |el| {
                let (state, id) = (self.state.clone(), channel.id.clone());
                el.child(
                    div()
                        .id(SharedString::from(format!("edit-{}", channel.id)))
                        .flex_none()
                        .flex()
                        .when(!active, |el| el.invisible().group_hover(group.clone(), |style| style.visible()))
                        .tooltip(tooltip("Edit channel"))
                        .on_click(move |_, _, cx| {
                            cx.stop_propagation();
                            state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(id.clone()), category: None }), cx))
                        })
                        .child(icon("settings", 16., theme.text2)),
                )
            })
            .when(mentions > 0., |el| {
                el.child(
                    div()
                        .flex_none()
                        .min_w(px(16.))
                        .h(px(16.))
                        .px(px(4.))
                        .rounded(px(8.))
                        .bg(theme.red)
                        .text_color(gpui::white())
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::BOLD)
                        .flex()
                        .justify_center()
                        .child(if mentions > 99. { "99+".to_string() } else { (mentions as u32).to_string() }),
                )
            });
        if can_reorder {
            // Dragged onto another, a channel takes its place, as the desktop's list reorders.
            let (id, name) = (channel.id.clone(), title.clone());
            let target = channel.id.clone();
            let order = order.to_vec();
            let state = self.state.clone();
            row = row
                .on_drag(ChannelDrag { id: id.clone(), name }, |drag, _, _, cx| cx.new(|_| drag.clone()))
                .drag_over::<ChannelDrag>(move |style, _, _, _| style.bg(theme.hover_strong))
                .on_drop(move |drag: &ChannelDrag, _, cx| {
                    if drag.id == target {
                        return;
                    }
                    let mut next = order.clone();
                    let Some(from) = next.iter().position(|item| *item == drag.id) else { return };
                    let moved = next.remove(from);
                    let to = next.iter().position(|item| *item == target).map(|index| if from <= index { index + 1 } else { index }).unwrap_or(next.len());
                    next.insert(to.min(next.len()), moved);
                    state.update(cx, |state, cx| state.act("reorderChannels", vec![json!(next)], cx));
                });
        }
        let mut block = div().flex().flex_col().child(row);
        if !occupants.is_empty() {
            let mut list = div().mt(px(2.)).mr(px(8.)).mb(px(4.)).ml(px(34.)).flex().flex_col().gap(px(1.));
            for member in occupants {
                list = list.child(self.voice_occupant(server, &member, cx));
            }
            block = block.child(list);
        }
        block.into_any_element()
    }

    /// Someone in a voice channel, under it, with a green ring while they speak.
    fn voice_occupant(&self, server: &ServerState, member: &VoiceMember, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let user = server.users.get(&member.user_id);
        let name = user.map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let image = user.and_then(|user| user.avatar.clone()).and_then(|avatar| {
            let server_id = server.entry.id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        let speaking = crate::voice::is_speaking(&server.entry.id, member, cx);
        div()
            .flex()
            .items_center()
            .gap(px(7.))
            .px(px(6.))
            .py(px(2.))
            .min_h(px(26.))
            .rounded(RADIUS_S)
            .text_size(px(13.))
            .text_color(if speaking { theme.text1 } else { theme.text2 })
            .child(
                div()
                    .flex_none()
                    .flex()
                    .rounded_full()
                    .when(speaking, |el| el.border_2().border_color(theme.green).m(px(-2.)))
                    .child(avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 22., online: false, rounded: false, dot_border: theme.bg1 }, cx)),
            )
            .child(div().flex_1().min_w_0().one_line().child(name))
            .when(member.screen, |el| {
                el.child(div().flex_none().px(px(5.)).rounded(px(4.)).bg(theme.red).text_size(px(10.)).line_height(px(15.)).font_weight(FontWeight::BOLD).text_color(gpui::white()).child("Live"))
            })
            .when(member.camera, |el| el.child(icon("camera", 13., theme.text3)))
            .when(member.server_muted, |el| el.child(icon("mic-off", 13., theme.red)))
            .when(!member.server_muted && member.muted && !member.deafened, |el| el.child(icon("mic-off", 13., theme.text3)))
            .when(member.deafened, |el| el.child(icon("headphone-off", 13., theme.text3)))
            .into_any_element()
    }

    /// What a channel's row offers on a right click.
    fn channel_menu(&self, server: &ServerState, channel: &ChannelView) -> Vec<MenuEntry> {
        let mut entries = Vec::new();
        if let Some(conversation) = &channel.conversation {
            let (state, key) = (self.state.clone(), channel.key.clone());
            if conversation.muted {
                entries.push(MenuEntry::new("Unmute", "volume-2", move |_, cx| state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx))));
            } else {
                entries.push(MenuEntry::submenu("Mute", "volume-x", mute_entries(key, state)));
            }
        }
        if server.is_admin() {
            let (state, id) = (self.state.clone(), channel.id.clone());
            entries.push(MenuEntry::new("Edit channel", "pencil", move |_, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(id.clone()), category: None }), cx))));
            let (state, id, name) = (self.state.clone(), channel.id.clone(), channel.name.clone());
            entries.push(
                MenuEntry::new("Delete channel", "trash", move |window, cx| {
                    let answer = window.prompt(gpui::PromptLevel::Warning, &format!("Delete {name}?"), Some("Its messages go for everyone."), &["Delete", "Cancel"], cx);
                    let (state, id) = (state.clone(), id.clone());
                    cx.spawn(async move |cx| {
                        if answer.await == Ok(0) {
                            state.update(cx, |state, cx| state.act("deleteChannel", vec![json!(id)], cx)).ok();
                        }
                    })
                    .detach();
                })
                .danger(),
            );
        }
        entries
    }
}

/// A channel being dragged to another place in the list, and what follows the mouse.
#[derive(Clone)]
struct ChannelDrag {
    id: String,
    name: String,
}

impl Render for ChannelDrag {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        div().px(px(10.)).py(px(6.)).rounded(RADIUS_S).bg(theme.bg3).border_1().border_color(theme.line_strong).shadow(shadow_m()).text_size(px(14.)).text_color(theme.text1).child(self.name.clone())
    }
}
