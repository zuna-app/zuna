//! A chat's details, its search and its pins, beside it (packages/ui/src/features/chat/SidePanel.tsx).

use std::collections::HashMap;
use std::time::Duration;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, Window, div, prelude::*, px};
use gpui::Focusable as _;
use serde_json::json;

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scrollbar};
use super::conversations::mute_entries;
use super::menu::{MenuEntry, open_menu};
use super::shared_media;
use super::text_input::{InputEvent, TextInput};
use crate::format::{format_last_seen, format_list_time, timer_text};
use crate::markup::plain_text;
use crate::models::{ConversationView, MessageView, REPORT_REASONS, SearchResult, UserView};
use crate::state::{AppState, Overlay, Panel, ServerState, SharedKind, ToastKind};
use crate::theme::{RADIUS_L, RADIUS_M};

pub struct SidePanel {
    state: Entity<AppState>,
    server_id: String,
    key: String,
    search: Entity<TextInput>,
    results: Vec<SearchResult>,
    pins: Option<Vec<MessageView>>,
    searching: Option<Task<()>>,
    /// How many of each kind have been shared, and for which state of the chat.
    counts: Option<HashMap<String, f64>>,
    counts_for: Option<(String, u64, usize)>,
    /// One kind's messages and whether there are more, and for which state of the chat.
    media: Option<(Vec<MessageView>, bool)>,
    media_for: Option<(SharedKind, String, u64, usize)>,
    media_loading: bool,
    scroll: gpui::ScrollHandle,
    /// Changing a group's name and description.
    editing: bool,
    edit_name: Entity<TextInput>,
    edit_description: Entity<TextInput>,
    /// What it last showed, which it keeps showing while it closes.
    shown: Option<Panel>,
    _subscriptions: Vec<Subscription>,
}

/// How wide the panel is.
pub const WIDTH: f32 = 320.;

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
        let edit_name = cx.new(|cx| TextInput::new(cx, "Name"));
        let edit_description = cx.new(|cx| TextInput::new(cx, "Description"));
        SidePanel {
            state,
            server_id,
            key,
            search,
            results: Vec::new(),
            pins: None,
            searching: None,
            counts: None,
            counts_for: None,
            media: None,
            media_for: None,
            media_loading: false,
            scroll: gpui::ScrollHandle::new(),
            editing: false,
            edit_name,
            edit_description,
            shown: None,
            _subscriptions: subscriptions,
        }
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

    fn info(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if conversation.kind == "channel" {
            return self.channel_info(server, conversation, cx);
        }
        if conversation.kind == "group" {
            return self.group_info(server, conversation, cx);
        }
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
            if !peer.deleted {
                card = card.child(div().text_color(theme.text2).child(format!("@{}", peer.username)));
            }
            if !is_self {
                card = card.child(
                    div()
                        .text_size(px(12.5))
                        .text_color(if peer.online { theme.green } else { theme.text3 })
                        .child(if peer.deleted {
                            "Deleted their account".to_string()
                        } else if peer.online {
                            "online".to_string()
                        } else {
                            format_last_seen(peer.last_seen_at, peer.hides_last_seen)
                        }),
                );
            }
            if !peer.bio.is_empty() {
                card = card.child(div().mt(px(8.)).text_size(px(13.5)).text_color(theme.text2).child(peer.bio.clone()));
            }
        }
        parts.push(card.into_any_element());

        // Nothing about keys, blocking or reports for an account that's gone.
        let peer = peer.filter(|peer| !peer.deleted || is_self);
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

        if let Some(rows) = self.media_rows(server, conversation, cx) {
            parts.push(rows);
        }
        parts.push(self.disappearing_row(conversation, true, cx));

        parts.push(self.preferences(server, conversation, cx));

        if let (Some(peer), false) = (&peer, is_self) {
            let blocked = server.prefs.blocked().contains(&peer.id);
            let reported = server.prefs.reported().contains(&peer.id);
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
                    .when(!peer.banned, |el| el.child(self.report_row(peer, reported, cx)))
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

    /// Reporting someone to the server's admins, last in their profile (ReportRow). The admins
    /// learn whom and why, never what was said nor who reported them.
    fn report_row(&self, peer: &UserView, reported: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        if reported {
            return div()
                .w_full()
                .flex()
                .items_center()
                .gap(px(11.))
                .px(px(8.))
                .py(px(7.))
                .min_h(px(36.))
                .text_size(px(13.5))
                .text_color(theme.text3)
                .child(icon("flag", 17., theme.text2))
                .child("Reported to the server's admins")
                .into_any_element();
        }
        let (state, id) = (self.state.clone(), peer.id.clone());
        Self::row("report", "flag", format!("Report {}", peer.display_name), Some("The server's admins see whom and why, never what was said or who reported.".into()), false, cx)
            .on_click(move |event, _, cx| {
                let entries = REPORT_REASONS
                    .iter()
                    .map(|&(reason, label)| {
                        let (state, id) = (state.clone(), id.clone());
                        MenuEntry::plain(
                            label,
                            std::rc::Rc::new(move |_, cx| {
                                state.update(cx, |state, cx| {
                                    let Some(server) = state.active_server.clone() else { return };
                                    state.call(Some(&server), "reportUser", vec![json!(id), json!(reason)], cx, |state, result, cx| match result {
                                        Ok(_) => state.toast("Reported to the server's admins", ToastKind::Info, cx),
                                        Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                    })
                                })
                            }),
                        )
                    })
                    .collect();
                open_menu(event.position(), entries, true, cx);
            })
            .into_any_element()
    }

    // --- Shared media ---

    /// Counts what's been shared, again whenever the chat's messages may have changed.
    fn ensure_counts(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else {
            self.counts = None;
            return;
        };
        let loaded = self.state.read(cx).lists.get(&group).map(|list| list.items.len()).unwrap_or(0);
        let key = (group.clone(), conversation.last_activity_at.to_bits(), loaded);
        if self.counts_for.as_ref() == Some(&key) {
            return;
        }
        self.counts_for = Some(key.clone());
        let call = self.state.read(cx).core.call(Some(&self.server_id), "mediaCounts", vec![json!(group)]);
        cx.spawn(async move |panel, cx| {
            let Ok(found) = call.await else { return };
            let counts: HashMap<String, f64> = found.as_object().map(|map| map.iter().filter_map(|(kind, count)| Some((kind.clone(), count.as_f64()?))).collect()).unwrap_or_default();
            panel
                .update(cx, |panel, cx| {
                    if panel.counts_for.as_ref() == Some(&key) {
                        panel.counts = Some(counts);
                        cx.notify();
                    }
                })
                .ok();
        })
        .detach();
    }

    /// How many photos, files, links and so on are in the chat, one row each.
    fn media_rows(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.ensure_counts(conversation, cx);
        let groups = if conversation.kind == "group" { 0 } else { shared_media::groups_in_common(server, conversation.peer_id.as_deref()).len() };
        // All the rows at once, rather than the groups in common before the counts.
        if conversation.group_id.is_some() && self.counts.is_none() {
            return None;
        }
        let mut section = Self::section(cx);
        let mut any = false;
        for (kind, icon_name, one, many, _) in shared_media::KINDS {
            let count = if kind == SharedKind::Groups { groups as f64 } else { self.counts.as_ref().and_then(|counts| counts.get(shared_media::core_name(kind))).copied().unwrap_or(0.) };
            if count <= 0. {
                continue;
            }
            any = true;
            let state = self.state.clone();
            section = section.child(Self::row(format!("media-{}", shared_media::core_name(kind)), icon_name, format!("{} {}", count as u64, if count == 1. { one } else { many }), None, false, cx).on_click(move |_, _, cx| {
                state.update(cx, |state, cx| {
                    state.panel = Some(Panel::Media(kind));
                    cx.notify();
                })
            }));
        }
        any.then(|| section.into_any_element())
    }

    /// Loads one kind, newest first, again whenever the chat changes so deletions and edits show.
    fn ensure_media(&mut self, kind: SharedKind, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else { return };
        let loaded = self.state.read(cx).lists.get(&group).map(|list| list.items.len()).unwrap_or(0);
        let key = (kind, group.clone(), conversation.last_activity_at.to_bits(), loaded);
        if self.media_for.as_ref() == Some(&key) {
            return;
        }
        if self.media_for.as_ref().is_some_and(|(shown, ..)| *shown != kind) {
            self.media = None;
        }
        self.media_for = Some(key.clone());
        let count = self.media.as_ref().map(|(messages, _)| messages.len()).unwrap_or(0).max(50);
        let call = self.state.read(cx).core.call(Some(&self.server_id), "loadMedia", vec![json!(group), json!(shared_media::core_name(kind)), serde_json::Value::Null, json!(count)]);
        cx.spawn(async move |panel, cx| {
            let result = call.await;
            panel
                .update(cx, |panel, cx| {
                    if panel.media_for.as_ref() != Some(&key) {
                        return;
                    }
                    let page = result.unwrap_or_default();
                    let messages: Vec<MessageView> = crate::models::from_value(page.get("messages").cloned().unwrap_or_default());
                    let has_more = page.get("hasMore").and_then(|more| more.as_bool()).unwrap_or(false);
                    panel.media = Some((messages, has_more));
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    /// The next page, once the list is scrolled near its end.
    fn load_more_media(&mut self, kind: SharedKind, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else { return };
        let Some((messages, true)) = &self.media else { return };
        let Some(oldest) = messages.last().and_then(|message| message.seq) else { return };
        if self.media_loading {
            return;
        }
        self.media_loading = true;
        let call = self.state.read(cx).core.call(Some(&self.server_id), "loadMedia", vec![json!(group), json!(shared_media::core_name(kind)), json!(oldest)]);
        cx.spawn(async move |panel, cx| {
            let result = call.await;
            panel
                .update(cx, |panel, cx| {
                    panel.media_loading = false;
                    let Ok(page) = result else { return };
                    let more: Vec<MessageView> = crate::models::from_value(page.get("messages").cloned().unwrap_or_default());
                    let has_more = page.get("hasMore").and_then(|more| more.as_bool()).unwrap_or(false);
                    if let Some((messages, flag)) = &mut panel.media {
                        let have: std::collections::HashSet<String> = messages.iter().map(|message| message.id.clone()).collect();
                        messages.extend(more.into_iter().filter(|message| !have.contains(&message.id)));
                        *flag = has_more;
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    // --- Groups and channels ---

    /// A channel's details: what it's for, and what's been shared there. Who's in it is everyone.
    fn channel_info(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let mut parts = Vec::new();
        let mut section = Self::section(cx).child(div().px(px(8.)).py(px(4.)).text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child(format!("#{}", conversation.title)));
        if !conversation.description.is_empty() {
            section = section.child(div().px(px(8.)).pb(px(6.)).text_size(px(12.)).text_color(theme.text3).child(conversation.description.clone()));
        }
        if server.is_admin() {
            let state = self.state.clone();
            let channel_id = conversation.group_id.clone().unwrap_or_default();
            section = section.child(Self::row("edit-channel", "pencil", "Edit channel".into(), None, false, cx).on_click(move |_, _, cx| {
                state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(channel_id.clone()), category: None }), cx))
            }));
        }
        let (state, key, muted) = (self.state.clone(), conversation.key.clone(), conversation.muted);
        section = section.child(
            Self::row(
                "channel-mute",
                if muted { "bell-off" } else { "bell" },
                if muted { "Unmute" } else { "Mute" }.into(),
                Some(if muted { "You won't hear about anything here." } else { "You hear about what's said to you." }.into()),
                false,
                cx,
            )
            .on_click(move |event, _, cx| {
                if muted {
                    state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx));
                } else {
                    open_menu(event.position(), mute_entries(key.clone(), state.clone()), true, cx);
                }
            }),
        );
        parts.push(section.into_any_element());
        if let Some(rows) = self.media_rows(server, conversation, cx) {
            parts.push(rows);
        }
        parts.push(
            Self::section(cx)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(11.))
                        .px(px(8.))
                        .py(px(7.))
                        .text_size(px(13.5))
                        .child(icon("lock", 17., theme.text2))
                        .child(div().flex_1().min_w_0().flex().flex_col().child("End-to-end encrypted").child(div().text_size(px(12.)).text_color(theme.text3).child("Everyone on this server can read it, and the server itself can't."))),
                )
                .into_any_element(),
        );
        parts
    }

    /// The group's picture and name, which its admins can change.
    fn group_card(&mut self, conversation: &ConversationView, is_admin: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let group = conversation.group_id.clone().unwrap_or_default();
        let image = conversation.avatar.as_ref().and_then(|avatar| {
            let server_id = self.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
        });
        let picture = div()
            .relative()
            .child(avatar(AvatarProps { name: conversation.title.clone(), seed: group.clone(), image, size: 80., online: false, rounded: false, dot_border: theme.bg1 }, cx))
            .when(is_admin, |el| {
                let (state, server_id, group) = (self.state.clone(), self.server_id.clone(), group.clone());
                el.child(
                    div()
                        .id("group-picture")
                        .absolute()
                        .right(px(-4.))
                        .bottom(px(-4.))
                        .size(px(32.))
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(theme.bg4)
                        .border_2()
                        .border_color(theme.bg1)
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.bg5))
                        
                        .on_click(move |_, _, cx| {
                            let picked = crate::media::pick_avatar(cx);
                            let (state, server_id, group) = (state.clone(), server_id.clone(), group.clone());
                            cx.spawn(async move |cx| {
                                let Some(prepared) = picked.await else { return };
                                state
                                    .update(cx, |state, cx| match prepared {
                                        Ok(file) => state.call(
                                            Some(&server_id),
                                            "updateGroupMeta",
                                            vec![json!(group), json!({}), crate::host::file(&file.to_string_lossy(), "image/jpeg")],
                                            cx,
                                            |state, result, cx| {
                                                if let Err(error) = result {
                                                    state.toast(error.message, crate::state::ToastKind::Error, cx);
                                                }
                                            },
                                        ),
                                        Err(()) => state.toast("That image couldn't be processed.", crate::state::ToastKind::Error, cx),
                                    });
                            })
                            .detach();
                        })
                        .child(icon("camera", 18., theme.text1)),
                )
            });
        let mut card = div().flex().flex_col().items_center().text_center().gap(px(2.)).pt(px(10.)).px(px(4.)).pb(px(6.)).child(picture);
        if self.editing {
            let (save_state, server_id, save_group) = (self.state.clone(), self.server_id.clone(), group.clone());
            let (name_input, description_input) = (self.edit_name.clone(), self.edit_description.clone());
            let title = conversation.title.clone();
            card = card.child(
                div()
                    .w_full()
                    .mt(px(10.))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .text_left()
                    .child(field(Some("Name"), self.edit_name.clone(), None, None, false, None, cx))
                    .child(field(Some("Description"), self.edit_description.clone(), None, None, false, None, cx))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(button("cancel-edit", ButtonKind::Default, ButtonSize::Small, false, cx).flex_1().justify_center().child("Cancel").on_click(cx.listener(|panel, _, _, cx| {
                                panel.editing = false;
                                cx.notify();
                            })))
                            .child(button("save-edit", ButtonKind::Primary, ButtonSize::Small, false, cx).flex_1().justify_center().child("Save").on_click(cx.listener(move |panel, _, _, cx| {
                                let name = name_input.read(cx).text().trim().to_string();
                                let description = description_input.read(cx).text().to_string();
                                let name = if name.is_empty() { title.clone() } else { name };
                                save_state.update(cx, |state, cx| {
                                    state.call(Some(&server_id), "updateGroupMeta", vec![json!(save_group), json!({ "name": name, "description": description })], cx, |state, result, cx| {
                                        if let Err(error) = result {
                                            state.toast(error.message, crate::state::ToastKind::Error, cx);
                                        }
                                    })
                                });
                                panel.editing = false;
                                cx.notify();
                            }))),
                    ),
            );
        } else {
            let (title, description) = (conversation.title.clone(), conversation.description.clone());
            card = card.child(
                div()
                    .mt(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(conversation.title.clone()))
                    .when(is_admin, |el| {
                        el.child(icon_button("edit-group", "pencil", 14., true, false, cx).on_click(cx.listener(move |panel, _, window, cx| {
                            panel.edit_name.update(cx, |input, cx| input.set_text(title.clone(), cx));
                            panel.edit_description.update(cx, |input, cx| input.set_text(description.clone(), cx));
                            panel.editing = true;
                            panel.edit_name.focus_handle(cx).focus(window, cx);
                            cx.notify();
                        })))
                    }),
            );
            if !conversation.description.is_empty() {
                card = card.child(div().mt(px(8.)).text_size(px(13.5)).text_color(theme.text2).child(conversation.description.clone()));
            }
        }
        card.into_any_element()
    }

    fn group_info(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let self_id = server.self_id().to_string();
        let is_admin = conversation.members.iter().any(|member| member.user_id == self_id && member.role == "admin");
        let group = conversation.group_id.clone().unwrap_or_default();
        let mut parts = vec![self.group_card(conversation, is_admin, cx)];
        parts.push(notice("lock", "The server can see who is in this group, but not its name, picture or messages.", cx).into_any_element());
        if let Some(rows) = self.media_rows(server, conversation, cx) {
            parts.push(rows);
        }
        let count = conversation.members.len();
        let mut members = Self::section(cx).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .px(px(8.))
                .py(px(5.))
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text3)
                .child(format!("{count} {}", if count == 1 { "member" } else { "members" }))
                .when(is_admin, |el| {
                    let (state, group) = (self.state.clone(), group.clone());
                    el.child(icon_button("add-people", "user-plus", 15., true, false, cx).tip("Add people", Side::Bottom).on_click(move |_, _, cx| {
                        state.update(cx, |state, cx| state.set_overlay(Some(Overlay::AddMembers { group_id: group.clone() }), cx))
                    }))
                }),
        );
        let mut sorted = conversation.members.clone();
        sorted.sort_by_key(|member| (member.role != "admin", server.users.get(&member.user_id).map(|user| user.display_name.to_lowercase()).unwrap_or_default()));
        for member in sorted {
            let user = server.users.get(&member.user_id).cloned();
            let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into());
            let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
                let server_id = self.server_id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
            });
            let is_me = member.user_id == self_id;
            let detail = if member.not_on_roster == Some(true) {
                "Has this chat's keys, but isn't listed as a member".to_string()
            } else if member.no_keys == Some(true) {
                "No device in this chat yet".to_string()
            } else {
                format!("@{}", user.as_ref().map(|user| user.username.clone()).unwrap_or_default())
            };
            let menu = self.member_menu(server, conversation, &member.user_id, is_admin);
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
                    .when(!is_me, |el| el.cursor_pointer().hover(move |style| style.bg(theme.hover)))
                    .on_click(move |event, _, cx| {
                        if !is_me {
                            open_menu(event.position(), menu.clone(), false, cx);
                        }
                    })
                    .child(avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 36., online: user.as_ref().is_some_and(|user| user.online), rounded: false, dot_border: theme.bg2 }, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().flex().min_w_0().font_weight(FontWeight::MEDIUM).child(div().min_w_0().one_line().child(name)).when(is_me, |el| el.child(div().flex_none().text_color(theme.text3).child("\u{a0}(you)"))))
                            .child(div().one_line().text_size(px(12.)).text_color(theme.text3).child(detail)),
                    )
                    .when(member.not_on_roster == Some(true), |el| el.child(icon("shield-alert", 14., theme.amber)))
                    .when(member.role == "admin", |el| el.child(icon("crown", 13., theme.text3)))
                    .when(user.as_ref().is_some_and(|user| user.trust == "verified"), |el| el.child(icon("badge-check", 14., theme.text2))),
            );
        }
        parts.push(members.into_any_element());
        parts.push(self.disappearing_row(conversation, is_admin, cx));
        if is_admin {
            let (state, server_id, group) = (self.state.clone(), self.server_id.clone(), group.clone());
            let on = conversation.history_visible;
            parts.push(
                Self::section(cx)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(11.))
                            .px(px(8.))
                            .py(px(7.))
                            .text_size(px(13.5))
                            .child(icon("eye", 17., theme.text2))
                            .child(div().flex_1().min_w_0().flex().flex_col().child("New members can read earlier messages").child(div().text_size(px(12.)).text_color(theme.text3).child("Applies to people added after this is turned on.")))
                            .child(switch("history-visible", on, cx).on_click(move |_, _, cx| {
                                state.update(cx, |state, cx| {
                                    state.call(Some(&server_id), "updateGroupMeta", vec![json!(group), json!({}), serde_json::Value::Null, json!(!on)], cx, |state, result, cx| {
                                        if let Err(error) = result {
                                            state.toast(error.message, crate::state::ToastKind::Error, cx);
                                        }
                                    })
                                })
                            })),
                    )
                    .into_any_element(),
            );
        }
        parts.push(self.preferences(server, conversation, cx));
        let (state, delete_state, delete_group) = (self.state.clone(), self.state.clone(), group.clone());
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
        parts
    }

    /// What can be done to someone in a group, from their row.
    fn member_menu(&self, server: &ServerState, conversation: &ConversationView, user_id: &str, is_admin: bool) -> Vec<MenuEntry> {
        let state = self.state.clone();
        let group = conversation.group_id.clone().unwrap_or_default();
        let user_id = user_id.to_string();
        let mut entries = Vec::new();
        let (s, key) = (state.clone(), format!("user:{user_id}"));
        entries.push(MenuEntry::new("Message", "check", move |_, cx| s.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx))));
        let (s, id) = (state.clone(), user_id.clone());
        entries.push(MenuEntry::new("Verify security key", "shield", move |_, cx| s.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: id.clone() }), cx))));
        if user_id != server.self_id() {
            let blocked = server.prefs.blocked().contains(&user_id);
            let (s, id) = (state.clone(), user_id.clone());
            entries.push(MenuEntry::new(if blocked { "Unblock" } else { "Block" }, "ban", move |_, cx| s.update(cx, |state, cx| state.act("setBlocked", vec![json!(id), json!(!blocked)], cx))));
        }
        if is_admin {
            let admin = conversation.members.iter().any(|member| member.user_id == user_id && member.role == "admin");
            let (s, g, id) = (state.clone(), group.clone(), user_id.clone());
            entries.push(MenuEntry::new(if admin { "Remove admin" } else { "Make admin" }, "crown", move |_, cx| {
                s.update(cx, |state, cx| state.act("setGroupRole", vec![json!(g), json!(id), json!(if admin { "member" } else { "admin" })], cx))
            }));
            entries.push(MenuEntry::separator());
            let (s, g, id) = (state.clone(), group.clone(), user_id.clone());
            entries.push(MenuEntry::new("Remove from group", "user-minus", move |_, cx| s.update(cx, |state, cx| state.act("removeMember", vec![json!(g), json!(id)], cx))).danger());
        }
        entries
    }

    /// The disappearing messages timer, which only those who may change it can open (DisappearingRow).
    fn disappearing_row(&self, conversation: &ConversationView, can_change: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        if conversation.group_id.is_none() || !conversation.ready {
            return div().into_any_element();
        }
        let after = conversation.disappear_after;
        let hint = if after > 0. { format!("New messages disappear {} after they're sent.", timer_text(after)) } else { "New messages stay until they're deleted.".to_string() };
        let state = self.state.clone();
        let group = conversation.group_id.clone().unwrap_or_default();
        let mut row = div()
            .id("disappearing")
            .w_full()
            .flex()
            .items_center()
            .gap(px(11.))
            .px(px(8.))
            .py(px(7.))
            .min_h(px(36.))
            .rounded(RADIUS_M)
            .text_size(px(13.5))
            .child(icon("timer", 17., theme.text2))
            .child(div().flex_1().min_w_0().flex().flex_col().child("Disappearing messages").child(div().mt(px(1.)).text_size(px(12.)).text_color(theme.text3).child(hint)))
            .child(div().text_color(theme.text3).child(timer_text(after)));
        if can_change {
            row = row.cursor_pointer().hover(move |style| style.bg(theme.hover)).on_click(move |event, _, cx| {
                let choices = [0., 3600., 86400., 7. * 86400., 30. * 86400.];
                let entries = choices
                    .iter()
                    .map(|seconds| {
                        let (state, group, seconds) = (state.clone(), group.clone(), *seconds);
                        let label = format!("{}{}", if seconds == after { "✓ " } else { "" }, timer_text(seconds));
                        MenuEntry::plain(label, std::rc::Rc::new(move |_, cx| state.update(cx, |state, cx| state.act("setDisappearing", vec![json!(group), json!(seconds)], cx))))
                    })
                    .collect();
                open_menu(event.position(), entries, true, cx);
            });
        }
        Self::section(cx).child(row).into_any_element()
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
                    .child(div().text_size(px(13.)).text_color(theme.text2).child(clamped(plain_text(&message.text), 3))),
            )
            .into_any_element()
    }
}

impl Render for SidePanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some((server, conversation)) = self.conversation(cx) else { return div().into_any_element() };
        let panel = self.state.read(cx).panel.or(self.shown);
        self.shown = panel;
        let title = match panel {
            Some(Panel::Search) if conversation.kind == "channel" => "Search this channel",
            Some(Panel::Search) => "Search this chat",
            Some(Panel::Pins) => "Pinned messages",
            Some(Panel::Media(kind)) => shared_media::title(kind),
            _ if conversation.kind == "group" => "Group details",
            _ if conversation.kind == "channel" => "Channel details",
            _ => "Details",
        };
        let in_media = matches!(panel, Some(Panel::Media(_)));
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
            Some(Panel::Media(SharedKind::Groups)) => shared_media::groups(&self.state, &server, conversation.peer_id.as_deref(), cx),
            Some(Panel::Media(kind)) => {
                self.ensure_media(kind, &conversation, cx);
                // More once the list is scrolled near its end.
                let near_end = {
                    let offset = -f32::from(self.scroll.offset().y);
                    let max = f32::from(self.scroll.max_offset().y);
                    max - offset < 300.
                };
                if near_end && self.media.as_ref().is_some_and(|(_, more)| *more) {
                    self.load_more_media(kind, &conversation, cx);
                }
                match self.media.clone() {
                    Some((messages, more)) => shared_media::content(&self.state, &server, kind, &messages, more, cx),
                    None => Vec::new(),
                }
            }
            _ => self.info(&server, &conversation, cx),
        };
        let back_state = self.state.clone();
        div()
            .flex_none()
            .w(px(WIDTH))
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
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .when(in_media, |el| {
                                el.child(icon_button("back-to-details", "chevron-left", 17., true, false, cx).on_click(move |_, _, cx| {
                                    back_state.update(cx, |state, cx| {
                                        state.panel = Some(Panel::Info);
                                        cx.notify();
                                    })
                                }))
                            })
                            .child(div().text_size(px(14.5)).font_weight(FontWeight::SEMIBOLD).child(title)),
                    )
                    .child(icon_button("close-panel", "x", 16., true, false, cx).on_click(move |_, _, cx| {
                        close_state.update(cx, |state, cx| {
                            state.panel = None;
                            cx.notify();
                        })
                    })),
            )
            .child(div().id("side-body").flex_1().min_h_0().overflow_y_scroll().track_scroll(&self.scroll).p(px(12.)).pr(px(12.) + gutter(&self.scroll)).flex().flex_col().gap(px(10.)).children(body).child(scrollbar("side-body", Scrolls::Div(self.scroll.clone()))))
            .into_any_element()
    }
}
