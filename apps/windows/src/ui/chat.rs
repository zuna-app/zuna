//! A conversation: its header, messages and message box
//! (packages/ui/src/features/chat/ChatView.tsx, MessageList.tsx and Composer.tsx).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, Context, Entity, FontWeight, Image, IntoElement, ListAlignment, ListState, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, list, prelude::*, px,
};
use serde_json::json;

use super::components::*;
use super::message::{ChatContext, render_row};
use super::side_panel::SidePanel;
use super::text_input::{InputEvent, TextInput};
use crate::format::{format_last_seen, now_ms, timer_text};
use crate::markup::{mentions_in, plain_text};
use crate::models::{ConversationView, MessageView};
use crate::state::{AppState, Panel, Picture, ToastKind, is_unread};
use crate::theme::{self, RADIUS_M};

const MAX_TEXT_LENGTH: usize = 4000;

pub struct ChatView {
    state: Entity<AppState>,
    server_id: String,
    key: String,
    list: ListState,
    rows: Vec<(String, u64)>,
    composer: Entity<TextInput>,
    composer_focused: bool,
    /// The first unread message when the chat opened, decided once.
    unread_line: Option<Option<String>>,
    at_bottom: bool,
    visible_newest: f64,
    highlight: Option<(String, u64)>,
    last_typing: f64,
    revealed: Rc<RefCell<HashSet<String>>>,
    side_panel: Option<Entity<SidePanel>>,
    last_list_id: String,
    _subscriptions: Vec<Subscription>,
}

fn fingerprint(message: &MessageView) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    message.status.hash(&mut hasher);
    message.text.hash(&mut hasher);
    message.edited_at.map(f64::to_bits).hash(&mut hasher);
    message.deleted_at.map(f64::to_bits).hash(&mut hasher);
    message.pinned_at.map(f64::to_bits).hash(&mut hasher);
    message.seq.map(f64::to_bits).hash(&mut hasher);
    message.upload_progress.map(f64::to_bits).hash(&mut hasher);
    for attachment in &message.attachments {
        attachment.file_id.hash(&mut hasher);
    }
    for reaction in &message.reactions {
        reaction.key.hash(&mut hasher);
        reaction.user_ids.hash(&mut hasher);
    }
    hasher.finish()
}

impl ChatView {
    pub fn new(state: Entity<AppState>, server_id: String, key: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| {
            let mut input = TextInput::new(cx, "Message").multiline();
            input.set_newline_on_enter(false);
            input
        });
        let list = ListState::new(0, ListAlignment::Bottom, px(800.));
        let weak = cx.entity().downgrade();
        list.set_scroll_handler(move |event, _window, cx| {
            let visible = event.visible_range.clone();
            let scrolled = event.is_scrolled;
            if let Some(view) = weak.upgrade() {
                view.update(cx, |view, cx| view.on_scroll(visible, scrolled, cx));
            }
        });
        let subscriptions = vec![
            cx.observe(&state, |view, _, cx| {
                view.sync_rows(cx);
                cx.notify();
            }),
            cx.subscribe_in(&composer, window, |view, _, event, window, cx| view.on_composer(event, window, cx)),
        ];
        let mut view = ChatView {
            state,
            server_id,
            key,
            list,
            rows: Vec::new(),
            composer,
            composer_focused: false,
            unread_line: None,
            at_bottom: true,
            visible_newest: 0.,
            highlight: None,
            last_typing: 0.,
            revealed: Rc::new(RefCell::new(HashSet::new())),
            side_panel: None,
            last_list_id: String::new(),
            _subscriptions: subscriptions,
        };
        view.open(window, cx);
        view
    }

    fn conversation(&self, cx: &gpui::App) -> Option<ConversationView> {
        self.state.read(cx).servers.get(&self.server_id).and_then(|server| server.find_conversation(&self.key)).cloned()
    }

    fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let list_id = conversation.list_id();
        self.last_list_id = list_id.clone();
        let enter = self.state.read(cx).settings.enter_to_send;
        let is_saved = conversation.peer_id.as_deref() == self.state.read(cx).servers.get(&self.server_id).map(|s| s.self_id());
        let placeholder = if is_saved { "Write a note to yourself".to_string() } else if conversation.kind == "channel" { format!("Message #{}", conversation.title) } else { format!("Message {}", conversation.title) };
        self.composer.update(cx, |input, cx| {
            input.set_newline_on_enter(!enter);
            input.set_placeholder(placeholder, cx);
        });
        self.state.update(cx, |state, cx| state.load_list(&list_id, conversation.group_id.clone(), cx));
        self.sync_rows(cx);
        self.composer.read(cx).focus(window);
    }

    /// Keeps the list's rows matching the messages, re-measuring only those that changed.
    fn sync_rows(&mut self, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let list_id = conversation.list_id();
        if list_id != self.last_list_id {
            // The first message of a direct message moved its list to the new group.
            self.last_list_id = list_id.clone();
        }
        let state = self.state.read(cx);
        let Some(list) = state.lists.get(&list_id) else { return };
        if self.unread_line.is_none() && (list.loaded || !list.items.is_empty()) {
            let server = state.servers.get(&self.server_id);
            let self_id = server.map(|s| s.self_id().to_string()).unwrap_or_default();
            let blocked = server.map(|s| s.prefs.blocked().to_vec()).unwrap_or_default();
            let first = if conversation.unread > 0. && !list.detached {
                list.items.iter().find(|item| is_unread(item, conversation.own_read, &self_id, &blocked)).map(|item| item.id.clone())
            } else {
                None
            };
            self.unread_line = Some(first);
        }
        let new_rows: Vec<(String, u64)> = list.items.iter().map(|item| (item.id.clone(), fingerprint(item))).collect();
        if new_rows == self.rows {
            return;
        }
        let old = std::mem::take(&mut self.rows);
        let old_ids: Vec<&String> = old.iter().map(|(id, _)| id).collect();
        let new_ids: Vec<&String> = new_rows.iter().map(|(id, _)| id).collect();
        if old.is_empty() {
            self.list.reset(new_rows.len());
            // Opening at the first unread message, as Telegram does.
            if let Some(Some(first)) = &self.unread_line {
                if let Some(index) = new_rows.iter().position(|(id, _)| id == first) {
                    self.list.scroll_to(gpui::ListOffset { item_ix: index, offset_in_item: px(0.) });
                }
            }
        } else if new_ids.len() >= old_ids.len() && new_ids[..old_ids.len()] == old_ids[..] {
            // Newer messages at the end, and any of the old ones that changed.
            for (index, (old_row, new_row)) in old.iter().zip(new_rows.iter()).enumerate() {
                if old_row.1 != new_row.1 {
                    self.list.splice(index..index + 1, 1);
                }
            }
            self.list.splice(old.len()..old.len(), new_rows.len() - old.len());
            // Neighbors change shape when a message joins their run.
            if old.len() > 0 {
                self.list.splice(old.len() - 1..old.len(), 1);
            }
        } else if new_ids.len() >= old_ids.len() && new_ids[new_ids.len() - old_ids.len()..] == old_ids[..] {
            // Older messages loaded above.
            let added = new_ids.len() - old_ids.len();
            self.list.splice(0..0, added);
            self.list.splice(added..added + 1, 1);
        } else {
            self.list.reset(new_rows.len());
        }
        self.rows = new_rows;
        self.jump_if_asked(cx);
    }

    fn jump_if_asked(&mut self, cx: &mut Context<Self>) {
        let Some((group, id, nonce)) = self.state.read(cx).jump_target.clone() else { return };
        if group != self.last_list_id || self.highlight.as_ref().is_some_and(|(_, seen)| *seen == nonce) {
            return;
        }
        if let Some(index) = self.rows.iter().position(|(row, _)| *row == id) {
            self.list.scroll_to_reveal_item(index);
            self.highlight = Some((id, nonce));
            cx.spawn(async move |view, cx| {
                cx.background_executor().timer(std::time::Duration::from_millis(1500)).await;
                view.update(cx, |view, cx| {
                    view.highlight = None;
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    fn on_scroll(&mut self, visible: std::ops::Range<usize>, scrolled: bool, cx: &mut Context<Self>) {
        self.at_bottom = !scrolled;
        let Some(conversation) = self.conversation(cx) else { return };
        let list_id = conversation.list_id();
        // Older messages, well before the top is reached.
        if visible.start < 15 {
            self.state.update(cx, |state, cx| state.load_older(&list_id, cx));
        }
        let state = self.state.read(cx);
        if let Some(list) = state.lists.get(&list_id) {
            let newest = list.items[visible.start.min(list.items.len())..visible.end.min(list.items.len())]
                .iter()
                .filter(|item| !item.id.starts_with("sys-"))
                .filter_map(|item| item.seq)
                .fold(0., f64::max);
            self.visible_newest = newest;
        }
        cx.notify();
    }

    fn mark_read(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        if !state.window_focused {
            return;
        }
        let Some(group) = conversation.group_id.clone() else { return };
        let Some(list) = state.lists.get(&group) else { return };
        let newest = list.items.iter().filter(|item| !item.id.starts_with("sys-")).filter_map(|item| item.seq).fold(0., f64::max);
        let up_to = if self.at_bottom && !list.detached { newest } else { self.visible_newest };
        if up_to > conversation.own_read {
            self.state.update(cx, |state, cx| state.mark_read(&group, up_to, cx));
        }
    }

    fn on_composer(&mut self, event: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            InputEvent::Submit => self.send(window, cx),
            InputEvent::Changed => {
                let Some(conversation) = self.conversation(cx) else { return };
                if let Some(group) = conversation.group_id {
                    let now = now_ms();
                    if !self.composer.read(cx).text().is_empty() && now - self.last_typing > 3000. {
                        self.last_typing = now;
                        self.state.update(cx, |state, cx| state.act("sendTyping", vec![json!(group)], cx));
                    }
                }
                cx.notify();
            }
            InputEvent::Escape => {
                let list_id = self.last_list_id.clone();
                self.state.update(cx, |state, cx| {
                    if state.editing.contains_key(&list_id) {
                        state.set_editing(&list_id, None, cx);
                    } else {
                        state.set_reply(&list_id, None, cx);
                    }
                });
                if self.state.read(cx).editing.get(&list_id).is_none() {
                    // Editing ended: what was being edited leaves the box.
                }
            }
            InputEvent::Up => {
                // Up in an empty box edits your last message, as in Telegram.
                if !self.composer.read(cx).text().is_empty() {
                    return;
                }
                let list_id = self.last_list_id.clone();
                let state = self.state.read(cx);
                let self_id = state.servers.get(&self.server_id).map(|s| s.self_id().to_string()).unwrap_or_default();
                let last = state.lists.get(&list_id).and_then(|list| {
                    list.items.iter().rev().find(|item| item.sender_id == self_id && !item.text.is_empty() && item.deleted_at.is_none() && item.seq.is_some() && item.forwarded.is_none()).cloned()
                });
                if let Some(message) = last {
                    let text = message.text.clone();
                    self.state.update(cx, |state, cx| state.set_editing(&list_id, Some(message), cx));
                    self.composer.update(cx, |input, cx| input.set_text(text, cx));
                }
            }
            InputEvent::Focused => {
                self.composer_focused = true;
                cx.notify();
            }
            InputEvent::Blurred => {
                self.composer_focused = false;
                cx.notify();
            }
            _ => {}
        }
        let _ = window;
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let value = self.composer.read(cx).text().trim().to_string();
        let list_id = conversation.list_id();
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return };
        let editing = state.editing.get(&list_id).cloned();
        let reply = state.reply_to.get(&list_id).cloned();
        if value.is_empty() {
            return;
        }
        if value.chars().count() > MAX_TEXT_LENGTH {
            self.state.update(cx, |state, cx| state.toast("That message is too long. Try sending it as a file.", ToastKind::Error, cx));
            return;
        }
        let mentions = mentions_in(&value, &server.mentionable);
        let emotes: serde_json::Map<String, serde_json::Value> = value
            .split_whitespace()
            .filter_map(|word| {
                server.emotes.emotes.iter().find(|emote| emote.name == word).map(|emote| {
                    (word.to_string(), json!({ "id": emote.id, "animated": emote.animated, "zeroWidth": emote.zero_width, "owner": emote.owner }))
                })
            })
            .collect();
        if let Some(editing) = editing {
            if value != editing.text {
                let args = vec![json!(editing.group_id), json!(editing.id), json!(value), json!(emotes), json!(mentions)];
                self.state.update(cx, |state, cx| state.act("editMessage", args, cx));
            }
            self.state.update(cx, |state, cx| state.set_editing(&list_id, None, cx));
            self.composer.update(cx, |input, cx| input.set_text("", cx));
            return;
        }
        let mut body = json!({ "text": value, "emotes": emotes, "mentions": mentions });
        if let Some(reply) = reply {
            body["replyTo"] = json!(reply.id);
        }
        let key = conversation.key.clone();
        self.state.update(cx, |state, cx| {
            state.act("sendMessage", vec![json!(key), body], cx);
            state.set_reply(&list_id, None, cx);
            if state.lists.get(&list_id).is_some_and(|list| list.detached) {
                state.return_to_latest(&list_id, cx);
            }
        });
        self.composer.update(cx, |input, cx| input.set_text("", cx));
        self.list.scroll_to(gpui::ListOffset { item_ix: self.rows.len(), offset_in_item: px(0.) });
        self.composer.read(cx).focus(window);
    }

    /// Picks files and sends them, as the desktop's attach button does.
    fn attach(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        let state = self.state.clone();
        let server_id = self.server_id.clone();
        let key = conversation.key.clone();
        let remove_metadata = self.state.read(cx).settings.remove_metadata;
        let list_id = conversation.list_id();
        let reply = self.state.read(cx).reply_to.get(&list_id).map(|m| m.id.clone());
        cx.spawn(async move |_, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let files: Vec<serde_json::Value> = paths.iter().map(|path| file_for_sending(path)).collect();
            let mut body = json!({});
            if let Some(reply) = reply {
                body["replyTo"] = json!(reply);
            }
            let options = json!({ "keepMetadata": !remove_metadata });
            state
                .update(cx, |state, cx| {
                    state.call(Some(&server_id), "sendWithAttachments", vec![json!(key), json!(files), body, options], cx, |state, result, cx| {
                        if let Err(error) = result {
                            state.toast(error.message, ToastKind::Error, cx);
                        }
                    });
                    state.set_reply(&list_id, None, cx);
                })
                .ok();
        })
        .detach();
    }

    fn header(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return div().into_any_element() };
        let panel = state.panel;
        let peer = conversation.peer_id.as_ref().and_then(|id| server.users.get(id)).cloned();
        let is_saved = conversation.peer_id.as_deref() == Some(server.self_id());
        let typing: Vec<String> = conversation.group_id.as_ref().and_then(|group| server.typing.get(group)).map(|typing| typing.keys().cloned().collect()).unwrap_or_default();
        let status: AnyElement = if !typing.is_empty() {
            let names: Vec<String> = typing.iter().map(|id| server.users.get(id).map(|u| u.display_name.split(' ').next().unwrap_or("").to_string()).unwrap_or("Someone".into())).collect();
            let label = if conversation.kind == "dm" {
                "typing".to_string()
            } else if names.len() == 1 {
                format!("{} is typing", names[0])
            } else {
                format!("{} people are typing", names.len())
            };
            div().flex().items_center().gap(px(5.)).text_color(theme.text1).child(label).child(typing_dots(theme.text1)).into_any_element()
        } else if conversation.kind == "group" {
            let online = conversation.members.iter().filter(|member| server.users.get(&member.user_id).is_some_and(|u| u.online)).count();
            let count = conversation.members.len();
            div()
                .text_color(theme.text3)
                .child(format!("{count} {}{}", if count == 1 { "member" } else { "members" }, if online > 0 { format!(", {online} online") } else { String::new() }))
                .into_any_element()
        } else if is_saved {
            div().text_color(theme.text3).child("Notes to yourself").into_any_element()
        } else if peer.as_ref().is_some_and(|p| p.banned) {
            div().text_color(theme.text3).child("Removed from this server").into_any_element()
        } else if peer.as_ref().is_some_and(|p| p.online) {
            div().text_color(theme.green).child("online").into_any_element()
        } else {
            div().text_color(theme.text3).child(format_last_seen(peer.as_ref().and_then(|p| p.last_seen_at), peer.as_ref().is_some_and(|p| p.hides_last_seen))).into_any_element()
        };
        let avatar_el: AnyElement = if is_saved {
            div().size(px(36.)).flex_none().rounded_full().bg(theme.bg4).flex().items_center().justify_center().child(icon("bookmark", 16., theme.text1)).into_any_element()
        } else {
            let image = conversation.avatar.as_ref().and_then(|avatar| {
                let server_id = self.server_id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            avatar(
                AvatarProps {
                    name: conversation.title.clone(),
                    seed: conversation.peer_id.clone().or(conversation.group_id.clone()).unwrap_or_default(),
                    image,
                    size: 36.,
                    online: false,
                    rounded: false,
                    dot_border: theme.bg1,
                },
                cx,
            )
            .into_any_element()
        };
        let mut title = div().flex().items_center().gap(px(5.)).text_size(px(14.5)).font_weight(FontWeight::SEMIBOLD).line_height(gpui::relative(1.3)).child(div().one_line().child(conversation.title.clone()));
        if peer.as_ref().is_some_and(|p| p.trust == "verified") && !is_saved {
            title = title.child(icon("badge-check", 14., theme.text2));
        }
        if conversation.disappear_after > 0. {
            title = title.child(div().id("timer-icon").tooltip(tooltip(format!("Messages disappear after {}", timer_text(conversation.disappear_after)))).child(icon("timer", 14., theme.text2)));
        }
        let toggle = |panel_kind: Panel, state: Entity<AppState>| move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut gpui::App| state.update(cx, |state, cx| state.toggle_panel(panel_kind, cx));
        let has_group = conversation.group_id.is_some();
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .h(px(52.))
            .pl(px(14.))
            .pr(px(10.))
            .bg(theme.bg1)
            .border_b_1()
            .border_color(theme.line)
            .child(
                div()
                    .id("chat-identity")
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .cursor_pointer()
                    .on_click(toggle(Panel::Info, self.state.clone()))
                    .child(avatar_el)
                    .child(div().min_w_0().flex().flex_col().child(title).child(div().text_size(px(12.5)).line_height(gpui::relative(1.3)).child(status))),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(2.))
                    .child(
                        icon_button("chat-search", "search", 17., false, panel == Some(Panel::Search), cx)
                            .tooltip(tooltip("Search this chat"))
                            .when(has_group, |el| el.on_click(toggle(Panel::Search, self.state.clone())))
                            .when(!has_group, |el| el.opacity(0.35)),
                    )
                    .child(
                        icon_button("chat-pins", "pin", 17., false, panel == Some(Panel::Pins), cx)
                            .tooltip(tooltip("Pinned messages"))
                            .when(has_group, |el| el.on_click(toggle(Panel::Pins, self.state.clone())))
                            .when(!has_group, |el| el.opacity(0.35)),
                    )
                    .child(icon_button("chat-details", "panel-right", 17., false, panel == Some(Panel::Info), cx).tooltip(tooltip("Details")).on_click(toggle(Panel::Info, self.state.clone()))),
            )
            .into_any_element()
    }

    fn composer_area(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return div().into_any_element() };
        let list_id = conversation.list_id();
        let peer = conversation.peer_id.as_ref().and_then(|id| server.users.get(id)).cloned();
        let is_saved = conversation.peer_id.as_deref() == Some(server.self_id());
        let disabled = |content: AnyElement| {
            div()
                .flex_none()
                .bg(theme.bg1)
                .border_t_1()
                .border_color(theme.line)
                .child(div().flex().items_center().justify_center().gap(px(8.)).p(px(14.)).text_color(theme.text2).text_size(px(13.5)).child(content))
                .into_any_element()
        };
        if conversation.removed {
            let state = self.state.clone();
            let group = conversation.group_id.clone().unwrap_or_default();
            return disabled(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(icon("x", 15., theme.text2))
                    .child("You're no longer in this conversation. Its messages stay on this device for 30 days.")
                    .child(button("forget", ButtonKind::Default, ButtonSize::Small, false, cx).child("Remove now").on_click(move |_, _, cx| {
                        state.update(cx, |state, cx| {
                            state.select_conversation(None, cx);
                            state.act("forgetConversation", vec![json!(group)], cx);
                        })
                    }))
                    .into_any_element(),
            );
        }
        if let Some(peer) = &peer {
            if peer.banned && !is_saved {
                return disabled(div().flex().items_center().gap(px(8.)).child(icon("x", 15., theme.text2)).child("This person was removed from the server.").into_any_element());
            }
            if conversation.blocked {
                let state = self.state.clone();
                let id = peer.id.clone();
                return disabled(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(icon("ban", 15., theme.text2))
                        .child(format!("You blocked {}.", peer.display_name))
                        .child(button("unblock", ButtonKind::Default, ButtonSize::Small, false, cx).child("Unblock").on_click(move |_, _, cx| {
                            state.update(cx, |state, cx| state.act("setBlocked", vec![json!(id), json!(false)], cx))
                        }))
                        .into_any_element(),
                );
            }
        }
        let editing = state.editing.get(&list_id).cloned();
        let reply = state.reply_to.get(&list_id).cloned();
        let can_send = !self.composer.read(cx).text().trim().is_empty();
        let mut area = div().flex_none().relative().bg(theme.bg1).border_t_1().border_color(theme.line);
        if editing.is_some() || reply.is_some() {
            let context = editing.clone().or(reply.clone()).unwrap();
            let sender = if context.sender_id == server.self_id() { "yourself".to_string() } else { server.display_name(&context.sender_id) };
            let title = if editing.is_some() { "Editing message".to_string() } else { format!("Replying to {sender}") };
            let text = {
                let plain = plain_text(&context.text);
                if !plain.is_empty() { plain } else { context.attachments.first().map(|a| a.name.clone()).unwrap_or("Attachment".into()) }
            };
            let state = self.state.clone();
            let composer = self.composer.clone();
            let is_editing = editing.is_some();
            let list = list_id.clone();
            area = area.child(
                div().pt(px(8.)).pl(px(16.)).pr(px(10.)).child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .pl(px(10.))
                        .border_l_2()
                        .border_color(theme.text3)
                        .text_color(theme.text2)
                        .child(icon(if is_editing { "pencil" } else { "corner-up-left" }, 16., theme.text2))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(title))
                                .child(div().one_line().text_size(px(12.5)).text_color(theme.text2).child(text)),
                        )
                        .child(icon_button("cancel-context", "x", 16., true, false, cx).on_click(move |_, _, cx| {
                            state.update(cx, |state, cx| {
                                if is_editing {
                                    state.set_editing(&list, None, cx);
                                } else {
                                    state.set_reply(&list, None, cx);
                                }
                            });
                            if is_editing {
                                composer.update(cx, |input, cx| input.set_text("", cx));
                            }
                        })),
                ),
            );
        }
        let send_ready = can_send;
        let send_color = if send_ready { theme.text1 } else { theme.text3 };
        area = area.child(
            div()
                .flex()
                .items_end()
                .gap(px(2.))
                .px(px(10.))
                .py(px(8.))
                .when(editing.is_none(), |el| el.child(icon_button("attach", "paperclip", 18., false, false, cx).tooltip(tooltip("Attach")).on_click(cx.listener(|view, _, window, cx| view.attach(window, cx)))))
                .child(
                    div()
                        .id("composer-scroll")
                        .flex_1()
                        .min_w_0()
                        .max_h(px(220.))
                        .overflow_y_scroll()
                        .px(px(6.))
                        .py(px(6.))
                        .min_h(px(32.))
                        .text_size(theme.message_size)
                        .line_height(px(20.))
                        .child(self.composer.clone()),
                )
                .child(
                    div()
                        .id("send")
                        .size(px(32.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(RADIUS_M)
                        .when(send_ready, |el| el.cursor_pointer().hover(move |style| style.bg(theme.hover_strong)))
                        .tooltip(tooltip(if editing.is_some() { "Save edit" } else { "Send" }))
                        .on_click(cx.listener(|view, _, window, cx| view.send(window, cx)))
                        .child(icon(if editing.is_some() { "check" } else { "send-horizontal" }, if send_ready { 18. } else { 16.2 }, send_color)),
                ),
        );
        area.into_any_element()
    }

    fn chat_context(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> Option<(Rc<Vec<MessageView>>, ChatContext)> {
        let state = self.state.read(cx);
        let server = state.servers.get(&self.server_id)?;
        let list = state.lists.get(&conversation.list_id())?;
        let self_id = server.self_id().to_string();
        let read_up_to = if conversation.kind == "channel" {
            -1.
        } else {
            conversation.read_by.iter().filter(|(id, _)| **id != self_id).map(|(_, seq)| *seq).fold(0., f64::max)
        };
        let is_group_admin = conversation.members.iter().any(|member| member.user_id == self_id && member.role == "admin");
        let items = Rc::new(list.items.clone());
        // The pictures already here: decrypted images and people's avatars.
        let mut images = HashMap::new();
        for message in items.iter() {
            for attachment in &message.attachments {
                if let Some(Picture::Ready(image)) = state.pictures.get(&format!("file:{}", attachment.file_id)) {
                    images.insert(attachment.file_id.clone(), image.clone());
                }
            }
        }
        let mut avatars: HashMap<String, Arc<Image>> = HashMap::new();
        let mut wanted = Vec::new();
        for user in server.users.values() {
            if let Some(avatar) = &user.avatar {
                match state.pictures.get(&format!("file:{}", avatar.file_id)) {
                    Some(Picture::Ready(image)) => {
                        avatars.insert(user.id.clone(), image.clone());
                    }
                    None if conversation.members.iter().any(|m| m.user_id == user.id) => wanted.push(avatar.clone()),
                    _ => {}
                }
            }
        }
        let context = ChatContext {
            state: self.state.clone(),
            server_id: self.server_id.clone(),
            server_url: server.entry.url.clone(),
            list_id: conversation.list_id(),
            self_id,
            is_group: conversation.kind != "dm",
            is_group_admin,
            read_up_to,
            users: server.users.clone(),
            mentionable: server.mentionable.clone(),
            blocked: server.prefs.blocked().to_vec(),
            unread_line: self.unread_line.clone().flatten(),
            has_more: list.has_more,
            detached: list.detached,
            highlight: self.highlight.as_ref().map(|(id, _)| id.clone()),
            revealed: self.revealed.clone(),
            images,
            avatars,
        };
        let server_id = self.server_id.clone();
        if !wanted.is_empty() {
            self.state.update(cx, |state, cx| {
                for avatar in wanted {
                    state.decrypted_picture(&server_id, &avatar, cx);
                }
            });
        }
        Some((items, context))
    }

    fn empty_chat(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let server = state.servers.get(&self.server_id);
        let is_saved = server.is_some_and(|s| conversation.peer_id.as_deref() == Some(s.self_id()));
        let peer = conversation.peer_id.as_ref().and_then(|id| server.and_then(|s| s.users.get(id))).cloned();
        let (title, text) = if is_saved {
            ("Your saved messages".to_string(), "Keep notes, links and files here. They're encrypted and sync across your devices.".to_string())
        } else if conversation.kind == "group" {
            ("No messages yet".to_string(), "Messages here are end-to-end encrypted for everyone in the group.".to_string())
        } else {
            (
                format!("Say hello to {}", peer.as_ref().map(|p| p.display_name.split(' ').next().unwrap_or("").to_string()).unwrap_or_else(|| conversation.title.clone())),
                "Messages here are end-to-end encrypted. Only the two of you can read them.".to_string(),
            )
        };
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .p(px(20.))
            .child(
                div()
                    .max_w(px(320.))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(6.))
                    .text_center()
                    .text_color(theme.text2)
                    .child(div().mb(px(4.)).child(icon("lock", 20., theme.text3)))
                    .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(title))
                    .child(div().text_size(px(13.5)).child(text)),
            )
            .into_any_element()
    }
}

/// A file picked to send, by path, which the core reads a chunk at a time.
fn file_for_sending(path: &std::path::Path) -> serde_json::Value {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    let path_text = path.to_string_lossy().into_owned();
    let mut file = json!({ "blob": crate::host::file(&path_text, mime), "name": name, "mime": mime });
    if mime.starts_with("image/") && mime != "image/gif" {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(image) = image::load_from_memory(&bytes) {
                file["width"] = json!(image.width());
                file["height"] = json!(image.height());
                if let Some((thumb, _, _)) = crate::host::shrink_image(&bytes, 24) {
                    file["thumb"] = json!(thumb);
                }
            }
        }
    }
    file
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(conversation) = self.conversation(cx) else { return div().into_any_element() };
        self.mark_read(&conversation, cx);
        let header = self.header(&conversation, cx);
        let state = self.state.read(cx);
        let list = state.lists.get(&conversation.list_id()).cloned();
        let panel = state.panel;
        let peer_changed = conversation
            .peer_id
            .as_ref()
            .and_then(|id| state.servers.get(&self.server_id).and_then(|s| s.users.get(id)))
            .is_some_and(|peer| peer.trust == "changed" && !peer.is_self);
        let body: AnyElement = match &list {
            Some(list) if !list.loaded && list.items.is_empty() => div().flex_1().flex().items_center().justify_center().child(spinner(18., theme.text2)).into_any_element(),
            Some(list) if list.items.is_empty() => self.empty_chat(&conversation, cx),
            None => div().flex_1().into_any_element(),
            Some(_) => {
                let Some((items, context)) = self.chat_context(&conversation, cx) else { return div().into_any_element() };
                let context = Rc::new(context);
                let count = items.len();
                if self.list.item_count() != count {
                    self.list.reset(count);
                }
                let items_for_rows = items.clone();
                let rows = gpui::list(self.list.clone(), move |index, window, cx| {
                    if index >= items_for_rows.len() {
                        return div().into_any_element();
                    }
                    render_row(&items_for_rows, index, &context, window, cx)
                })
                .size_full();
                let unread_below = if !self.at_bottom { conversation.unread as u32 } else { 0 };
                let list_state = self.list.clone();
                let detached = list.as_ref().is_some_and(|list| list.detached);
                let to_bottom_state = self.state.clone();
                let list_id = conversation.list_id();
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(rows)
                    .when(!self.at_bottom || detached, |el| {
                        el.child(
                            div()
                                .id("to-bottom")
                                .absolute()
                                .right(px(14.))
                                .bottom(px(16.))
                                .size(px(40.))
                                .rounded_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(theme.bg5)
                                .shadow(shadow_s())
                                .cursor_pointer()
                                .hover(|style| style.bg(theme::color(theme::hex(0x45454b))))
                                .on_click(move |_, _, cx| {
                                    if detached {
                                        to_bottom_state.update(cx, |state, cx| state.return_to_latest(&list_id, cx));
                                    } else {
                                        list_state.scroll_to(gpui::ListOffset { item_ix: count, offset_in_item: px(0.) });
                                    }
                                })
                                .child(icon("chevron-down", 22., theme.text1))
                                .when(unread_below > 0, |el| {
                                    el.child(
                                        div()
                                            .absolute()
                                            .top(px(-7.))
                                            .min_w(px(18.))
                                            .h(px(18.))
                                            .px(px(5.))
                                            .rounded(px(9.))
                                            .bg(theme.accent)
                                            .text_color(theme.on_accent)
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .line_height(px(18.))
                                            .flex()
                                            .justify_center()
                                            .child(if unread_below > 99 { "99+".to_string() } else { unread_below.to_string() }),
                                    )
                                }),
                        )
                    })
                    .into_any_element()
            }
        };
        let composer = self.composer_area(&conversation, cx);
        let side_panel = if panel.is_some() {
            if self.side_panel.is_none() {
                let state = self.state.clone();
                let server_id = self.server_id.clone();
                let key = self.key.clone();
                self.side_panel = Some(cx.new(|cx| SidePanel::new(state, server_id, key, window, cx)));
            }
            self.side_panel.clone().map(|panel| panel.into_any_element())
        } else {
            self.side_panel = None;
            None
        };
        let state = self.state.clone();
        let user_id = conversation.peer_id.clone().unwrap_or_default();
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .bg(theme.bg_chat)
                    .child(header)
                    .when(peer_changed, |el| {
                        el.child(
                            div().flex_none().bg(theme.amber_soft).border_b_1().border_color(theme::color(theme::rgba(229, 165, 10, 0.2))).child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(10.))
                                    .px(px(14.))
                                    .py(px(8.))
                                    .text_size(px(13.))
                                    .text_color(theme::color(theme::hex(0xe8d3a2)))
                                    .child(icon("shield-alert", 16., theme.amber))
                                    .child(div().flex_1().child(format!(
                                        "{}'s security key changed. This can mean someone is intercepting this chat. Compare keys before sharing anything private.",
                                        conversation.title
                                    )))
                                    .child(button("verify", ButtonKind::Default, ButtonSize::Small, false, cx).child("Verify").on_click(move |_, _, cx| {
                                        state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Verify { user_id: user_id.clone() }), cx))
                                    })),
                            ),
                        )
                    })
                    .child(body)
                    .child(composer),
            )
            .when_some(side_panel, |el, panel| el.child(panel))
            .into_any_element()
    }
}

#[allow(dead_code)]
fn unused(_: SharedString) {}
