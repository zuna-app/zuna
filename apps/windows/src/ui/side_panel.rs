//! A chat's details, its search and its pins, beside it (packages/ui/src/features/chat/SidePanel.tsx).

use std::time::Duration;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, Window, div, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::conversations::mute_entries;
use super::menu::open_menu;
use super::text_input::{InputEvent, TextInput};
use crate::format::{format_last_seen, format_list_time, timer_text};
use crate::markup::plain_text;
use crate::models::{ConversationView, MessageView, SearchResult};
use crate::state::{AppState, Overlay, Panel, ServerState};
use crate::theme::{RADIUS_L, RADIUS_M};

pub struct SidePanel {
    state: Entity<AppState>,
    server_id: String,
    key: String,
    search: Entity<TextInput>,
    results: Vec<SearchResult>,
    pins: Option<Vec<MessageView>>,
    searching: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl SidePanel {
    pub fn new(state: Entity<AppState>, server_id: String, key: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| TextInput::new(cx, "Search messages"));
        let subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.subscribe_in(&search, window, |panel, _, event, _, cx| {
                if *event == InputEvent::Changed {
                    panel.run_search(cx);
                }
            }),
        ];
        SidePanel { state, server_id, key, search, results: Vec::new(), pins: None, searching: None, _subscriptions: subscriptions }
    }

    fn conversation(&self, cx: &gpui::App) -> Option<(ServerState, ConversationView)> {
        let state = self.state.read(cx);
        let server = state.servers.get(&self.server_id)?;
        let conversation = server.find_conversation(&self.key)?.clone();
        Some((server.clone(), conversation))
    }

    fn run_search(&mut self, cx: &mut Context<Self>) {
        let query = self.search.read(cx).text().trim().to_string();
        let Some((_, conversation)) = self.conversation(cx) else { return };
        let Some(group) = conversation.group_id.clone() else { return };
        if query.chars().count() < 2 {
            self.results.clear();
            cx.notify();
            return;
        }
        let call = self.state.read(cx).core.call(Some(&self.server_id), "search", vec![json!(query), json!(group), json!(50)]);
        self.searching = Some(cx.spawn(async move |panel, cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            if let Ok(value) = call.await {
                panel
                    .update(cx, |panel, cx| {
                        panel.results = crate::models::from_value(value);
                        cx.notify();
                    })
                    .ok();
            }
        }));
    }

    fn load_pins(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        if self.pins.is_some() {
            return;
        }
        let Some(group) = conversation.group_id.clone() else { return };
        self.pins = Some(Vec::new());
        let call = self.state.read(cx).core.call(Some(&self.server_id), "loadPins", vec![json!(group)]);
        cx.spawn(async move |panel, cx| {
            if let Ok(value) = call.await {
                panel
                    .update(cx, |panel, cx| {
                        panel.pins = Some(crate::models::from_value(value));
                        cx.notify();
                    })
                    .ok();
            }
        })
        .detach();
    }

    fn section(cx: &gpui::App) -> gpui::Div {
        let theme = theme(cx);
        div().flex().flex_col().gap(px(1.)).p(px(4.)).rounded(RADIUS_L).bg(theme.bg2)
    }

    fn row(id: impl Into<SharedString>, icon_name: &str, label: String, hint: Option<String>, danger: bool, cx: &gpui::App) -> gpui::Stateful<gpui::Div> {
        let theme = theme(cx);
        let color = if danger { theme.red } else { theme.text1 };
        let hover = if danger { theme.red_soft } else { theme.hover };
        let id: SharedString = id.into();
        div()
            .id(id)
            .w_full()
            .flex()
            .items_center()
            .gap(px(11.))
            .px(px(8.))
            .py(px(7.))
            .min_h(px(36.))
            .rounded(RADIUS_M)
            .text_size(px(13.5))
            .text_color(color)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .child(icon(icon_name, 17., if danger { theme.red } else { theme.text2 }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(label)
                    .when_some(hint, |el, hint| el.child(div().text_size(px(12.)).text_color(theme.text3).child(hint))),
            )
    }

    fn preferences(&self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.clone();
        let key = conversation.key.clone();
        let muted = conversation.muted;
        let mut section = Self::section(cx).child(
            div()
                .flex()
                .items_center()
                .gap(px(11.))
                .px(px(8.))
                .py(px(7.))
                .min_h(px(36.))
                .text_size(px(13.5))
                .child(icon(if muted { "bell-off" } else { "bell" }, 17., theme.text2))
                .child(div().flex_1().min_w_0().child("Notifications"))
                .child(switch("notifications", !muted, cx).on_click(move |event, _, cx| {
                    if muted {
                        state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx));
                    } else {
                        open_menu(event.position(), mute_entries(key.clone(), state.clone()), true, cx);
                    }
                })),
        );
        if conversation.kind == "group" {
            let state = self.state.clone();
            let key = conversation.key.clone();
            let on = conversation.mentions_only;
            section = section.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(11.))
                    .px(px(8.))
                    .py(px(7.))
                    .text_size(px(13.5))
                    .child(icon("at-sign", 17., theme.text2))
                    .child(div().flex_1().min_w_0().flex().flex_col().child("Only mentions").child(div().text_size(px(12.)).text_color(theme.text3).child("Notify only when someone mentions you or replies to you")))
                    .child(switch("mentions-only", on, cx).on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("setMentionsOnly", vec![json!(key), json!(!on)], cx)))),
            );
        }
        let toggle = |list: &'static str, current: Vec<String>, key: String, state: Entity<AppState>| {
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut gpui::App| {
                let next: Vec<String> = if current.contains(&key) { current.iter().filter(|item| **item != key).cloned().collect() } else { [current.clone(), vec![key.clone()]].concat() };
                state.update(cx, |state, cx| state.act("updatePreferences", vec![json!({ list: next })], cx));
            }
        };
        section = section
            .child(
                Self::row("pin-row", if conversation.pinned { "pin-off" } else { "pin" }, if conversation.pinned { "Unpin from top" } else { "Pin to top" }.into(), None, false, cx)
                    .on_click(toggle("pinned", server.prefs.pinned.clone(), conversation.key.clone(), self.state.clone())),
            )
            .child(
                Self::row("hide-row", if conversation.hidden { "eye" } else { "eye-off" }, if conversation.hidden { "Show in list" } else { "Hide from list" }.into(), None, false, cx)
                    .on_click(toggle("hidden", server.prefs.hidden.clone(), conversation.key.clone(), self.state.clone())),
            );
        section.into_any_element()
    }

    fn info(&self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let mut parts = Vec::new();
        let peer = conversation.peer_id.as_ref().and_then(|id| server.users.get(id)).cloned();
        let is_self = conversation.peer_id.as_deref() == Some(server.self_id());
        let image = conversation.avatar.as_ref().and_then(|avatar| {
            let server_id = self.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
        });
        let mut card = div()
            .flex()
            .flex_col()
            .items_center()
            .text_center()
            .gap(px(2.))
            .pt(px(10.))
            .px(px(4.))
            .pb(px(6.))
            .child(avatar(
                AvatarProps {
                    name: conversation.title.clone(),
                    seed: conversation.peer_id.clone().or(conversation.group_id.clone()).unwrap_or_default(),
                    image,
                    size: 80.,
                    online: peer.as_ref().is_some_and(|p| p.online),
                    rounded: false,
                    dot_border: theme.bg1,
                },
                cx,
            ))
            .child(div().mt(px(8.)).text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(if is_self { peer.as_ref().map(|p| p.display_name.clone()).unwrap_or_default() } else { conversation.title.clone() }));
        if conversation.kind == "group" {
            if !conversation.description.is_empty() {
                card = card.child(div().mt(px(8.)).text_size(px(13.5)).text_color(theme.text2).child(conversation.description.clone()));
            }
        } else if let Some(peer) = &peer {
            card = card.child(div().text_color(theme.text2).child(format!("@{}", peer.username)));
            if !is_self {
                card = card.child(
                    div()
                        .text_size(px(12.5))
                        .text_color(if peer.online { theme.green } else { theme.text3 })
                        .child(if peer.online { "online".to_string() } else { format_last_seen(peer.last_seen_at, peer.hides_last_seen) }),
                );
            }
            if !peer.bio.is_empty() {
                card = card.child(div().mt(px(8.)).text_size(px(13.5)).text_color(theme.text2).child(peer.bio.clone()));
            }
        }
        parts.push(card.into_any_element());

        if let (Some(peer), false) = (&peer, is_self) {
            let state = self.state.clone();
            let user_id = peer.id.clone();
            let (icon_name, color, title, text, bg) = match peer.trust.as_str() {
                "verified" => ("shield-check", theme.green, "Verified", "You've confirmed this is really them.", None),
                "changed" => ("shield-alert", theme.amber, "Security key changed", "Compare emoji to make sure nobody is in between.", Some(theme.amber_soft)),
                _ => ("shield", theme.text2, "Not verified yet", "Compare emoji to make sure nobody is in between.", None),
            };
            parts.push(
                Self::section(cx)
                    .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).px(px(8.)).py(px(5.)).child("Encryption"))
                    .child(
                        div()
                            .id("trust-card")
                            .w_full()
                            .flex()
                            .items_center()
                            .gap(px(11.))
                            .p(px(8.))
                            .rounded(RADIUS_M)
                            .when_some(bg, |el, bg| el.bg(bg))
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.hover))
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user_id.clone() }), cx)))
                            .child(icon(icon_name, 20., color))
                            .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).child(title)).child(div().text_size(px(12.5)).text_color(theme.text2).child(text))),
                    )
                    .into_any_element(),
            );
        }

        if conversation.kind == "group" {
            let mut members = Self::section(cx).child(
                div()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text3)
                    .px(px(8.))
                    .py(px(5.))
                    .child(format!("{} {}", conversation.members.len(), if conversation.members.len() == 1 { "member" } else { "members" })),
            );
            let mut sorted = conversation.members.clone();
            sorted.sort_by_key(|member| (member.role != "admin", server.users.get(&member.user_id).map(|u| u.display_name.to_lowercase()).unwrap_or_default()));
            for member in sorted {
                let user = server.users.get(&member.user_id).cloned();
                let name = user.as_ref().map(|u| u.display_name.clone()).unwrap_or_else(|| "Unknown".into());
                let image = user.as_ref().and_then(|u| u.avatar.clone()).and_then(|avatar| {
                    let server_id = self.server_id.clone();
                    self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
                });
                let is_me = member.user_id == server.self_id();
                let state = self.state.clone();
                let user_id = member.user_id.clone();
                members = members.child(
                    div()
                        .id(SharedString::from(format!("member-{}", member.user_id)))
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(RADIUS_M)
                        .text_size(px(13.5))
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover))
                        .on_click(move |_, _, cx| {
                            if !is_me {
                                state.update(cx, |state, cx| state.select_conversation(Some(format!("user:{user_id}")), cx));
                            }
                        })
                        .child(avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 36., online: user.as_ref().is_some_and(|u| u.online), rounded: false, dot_border: theme.bg2 }, cx))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().one_line().font_weight(FontWeight::MEDIUM).child(if is_me { format!("{name} (you)") } else { name }))
                                .child(div().one_line().text_size(px(12.)).text_color(theme.text3).child(if member.no_keys == Some(true) {
                                    "No device in this chat yet".to_string()
                                } else {
                                    format!("@{}", user.as_ref().map(|u| u.username.clone()).unwrap_or_default())
                                })),
                        )
                        .when(member.role == "admin", |el| el.child(icon("crown", 13., theme.text3)))
                        .when(user.as_ref().is_some_and(|u| u.trust == "verified"), |el| el.child(icon("badge-check", 14., theme.text2))),
                );
            }
            parts.push(members.into_any_element());
        }

        if conversation.group_id.is_some() {
            let can_change = conversation.kind == "dm" || conversation.members.iter().any(|m| m.user_id == server.self_id() && m.role == "admin");
            let label = if conversation.disappear_after > 0. { format!("Messages disappear after {}", timer_text(conversation.disappear_after)) } else { "Disappearing messages".to_string() };
            let hint = if conversation.disappear_after > 0. { None } else { Some("Off".to_string()) };
            let state = self.state.clone();
            let group = conversation.group_id.clone().unwrap_or_default();
            let mut row = Self::row("disappearing", "timer", label, hint, false, cx);
            if can_change {
                row = row.on_click(move |event, _, cx| {
                    let choices = [0., 3600., 86400., 7. * 86400., 30. * 86400.];
                    let entries = choices
                        .iter()
                        .map(|seconds| {
                            let (state, group, seconds) = (state.clone(), group.clone(), *seconds);
                            super::menu::MenuEntry::new(if seconds == 0. { "Off".to_string() } else { timer_text(seconds) }, "timer", move |_, cx| {
                                state.update(cx, |state, cx| state.act("setDisappearing", vec![json!(group), json!(seconds)], cx))
                            })
                        })
                        .collect();
                    open_menu(event.position(), entries, false, cx);
                });
            }
            parts.push(Self::section(cx).child(row).into_any_element());
        }

        parts.push(self.preferences(server, conversation, cx));

        if let (Some(peer), false) = (&peer, is_self) {
            let blocked = server.prefs.blocked().contains(&peer.id);
            let state = self.state.clone();
            let id = peer.id.clone();
            parts.push(
                Self::section(cx)
                    .child(
                        Self::row(
                            "block",
                            "ban",
                            if blocked { format!("Unblock {}", peer.display_name) } else { format!("Block {}", peer.display_name) },
                            if blocked { None } else { Some("You won't see their messages or hear about them. They aren't told.".into()) },
                            !blocked,
                            cx,
                        )
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("setBlocked", vec![json!(id), json!(!blocked)], cx))),
                    )
                    .into_any_element(),
            );
        }
        if conversation.kind == "group" {
            if let Some(group) = conversation.group_id.clone() {
                let state = self.state.clone();
                let is_admin = conversation.members.iter().any(|m| m.user_id == server.self_id() && m.role == "admin");
                let delete_state = self.state.clone();
                let delete_group = group.clone();
                parts.push(
                    Self::section(cx)
                        .child(Self::row("leave-group", "log-out", "Leave group".into(), None, true, cx).on_click(move |_, _, cx| {
                            state.update(cx, |state, cx| {
                                state.act("leaveGroup", vec![json!(group)], cx);
                                state.select_conversation(None, cx);
                            })
                        }))
                        .when(is_admin, |el| {
                            el.child(Self::row("delete-group", "trash", "Delete group for everyone".into(), None, true, cx).on_click(move |_, _, cx| {
                                delete_state.update(cx, |state, cx| {
                                    state.act("deleteGroup", vec![json!(delete_group)], cx);
                                    state.select_conversation(None, cx);
                                })
                            }))
                        })
                        .into_any_element(),
                );
            }
        }
        parts
    }

    fn result_row(&self, message: &MessageView, server: &ServerState, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let sender = server.users.get(&message.sender_id).cloned();
        let name = sender.as_ref().map(|s| s.display_name.clone()).unwrap_or_else(|| "Unknown".into());
        let state = self.state.clone();
        let (group, id) = (message.group_id.clone(), message.id.clone());
        div()
            .id(SharedString::from(format!("result-{}", message.id)))
            .flex()
            .items_start()
            .gap(px(10.))
            .px(px(8.))
            .py(px(7.))
            .rounded(RADIUS_M)
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover))
            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.jump_to_message(&group, &id, cx)))
            .child(avatar(AvatarProps { name: name.clone(), seed: message.sender_id.clone(), image: None, size: 32., online: false, rounded: false, dot_border: theme.bg1 }, cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(div().flex_1().one_line().text_size(px(13.)).font_weight(FontWeight::MEDIUM).child(name))
                            .child(div().text_size(px(11.5)).text_color(theme.text3).child(format_list_time(message.created_at))),
                    )
                    .child(div().text_size(px(13.)).text_color(theme.text2).line_clamp(3).child(plain_text(&message.text))),
            )
            .into_any_element()
    }
}

impl Render for SidePanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some((server, conversation)) = self.conversation(cx) else { return div().into_any_element() };
        let panel = self.state.read(cx).panel;
        let title = match panel {
            Some(Panel::Search) => "Search this chat",
            Some(Panel::Pins) => "Pinned messages",
            _ if conversation.kind == "group" => "Group details",
            _ => "Details",
        };
        let close_state = self.state.clone();
        let body: Vec<AnyElement> = match panel {
            Some(Panel::Search) => {
                let mut parts = vec![
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .bg(theme.bg2)
                        .rounded(RADIUS_M)
                        .border_1()
                        .border_color(theme.line)
                        .px(px(11.))
                        .h(px(38.))
                        .child(icon("search", 14., theme.text3))
                        .child(div().flex_1().min_w_0().child(self.search.clone()))
                        .into_any_element(),
                ];
                let results = self.results.clone();
                if results.is_empty() && self.search.read(cx).text().trim().chars().count() >= 2 {
                    parts.push(div().p(px(20.)).text_center().text_color(theme.text2).child("No messages match.").into_any_element());
                }
                for result in &results {
                    parts.push(self.result_row(&result.message, &server, cx));
                }
                parts
            }
            Some(Panel::Pins) => {
                self.load_pins(&conversation, cx);
                let pins = self.pins.clone().unwrap_or_default();
                if pins.is_empty() {
                    vec![div().p(px(30.)).flex().flex_col().items_center().gap(px(6.)).text_color(theme.text2).child(icon("pin", 22., theme.text3)).child("No pinned messages yet.").into_any_element()]
                } else {
                    pins.iter().map(|message| self.result_row(message, &server, cx)).collect()
                }
            }
            _ => self.info(&server, &conversation, cx),
        };
        div()
            .flex_none()
            .w(px(320.))
            .h_full()
            .flex()
            .flex_col()
            .bg(theme.bg1)
            .border_l_1()
            .border_color(theme.line)
            .child(
                div()
                    .flex_none()
                    .h(px(52.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .pl(px(16.))
                    .pr(px(10.))
                    .border_b_1()
                    .border_color(theme.line)
                    .child(div().text_size(px(14.5)).font_weight(FontWeight::SEMIBOLD).child(title))
                    .child(icon_button("close-panel", "x", 16., true, false, cx).on_click(move |_, _, cx| {
                        close_state.update(cx, |state, cx| {
                            state.panel = None;
                            cx.notify();
                        })
                    })),
            )
            .child(div().id("side-body").flex_1().min_h_0().overflow_y_scroll().p(px(12.)).flex().flex_col().gap(px(10.)).children(body))
            .into_any_element()
    }
}
