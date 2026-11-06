//! All UI state, kept in sync with the core through its events, as the desktop's
//! zustand store (packages/ui/src/state/store.ts) keeps it.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use gpui::{App, AppContext, Context, Entity, Image, ImageFormat, Task};
use serde_json::{Value, json};

use crate::format::now_ms;
use crate::host::{self, Core, CoreError};
use crate::models::*;
use crate::settings::Settings;
use crate::theme::Theme;

#[derive(Clone)]
pub struct ServerState {
    pub entry: ServerEntry,
    pub info: Option<ServerInfo>,
    pub connection: String,
    pub me: Option<ServerSelf>,
    pub conversations: Vec<ConversationView>,
    pub channels: Vec<ChannelView>,
    pub voice: HashMap<String, VoiceMember>,
    pub calls: HashMap<String, CallView>,
    pub users: HashMap<String, UserView>,
    /// username (lowercase) -> user ID.
    pub mentionable: HashMap<String, String>,
    pub emotes: EmoteSet,
    pub prefs: Preferences,
    pub active_key: Option<String>,
    /// groupId -> userId -> when their typing stops showing (ms).
    pub typing: HashMap<String, HashMap<String, f64>>,
}

impl ServerState {
    pub fn self_id(&self) -> &str {
        self.me.as_ref().map(|me| me.user_id.as_str()).unwrap_or("")
    }

    pub fn is_admin(&self) -> bool {
        self.me.as_ref().is_some_and(|me| me.role == "owner" || me.role == "admin")
    }

    pub fn find_conversation(&self, key: &str) -> Option<&ConversationView> {
        self.conversations
            .iter()
            .find(|item| item.key == key)
            .or_else(|| self.channels.iter().find_map(|channel| channel.conversation.as_ref().filter(|c| c.key == key)))
    }

    pub fn active_conversation(&self) -> Option<&ConversationView> {
        self.active_key.as_deref().and_then(|key| self.find_conversation(key))
    }

    pub fn active_channel(&self) -> Option<&ChannelView> {
        let key = self.active_key.as_deref()?;
        self.channels.iter().find(|channel| channel.key == key)
    }

    pub fn display_name(&self, user_id: &str) -> String {
        self.users.get(user_id).map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into())
    }

    /// Unread messages for the rail's badge: what's said to you in channels, everything elsewhere.
    pub fn unread(&self) -> u32 {
        let conversations: u32 = self.conversations.iter().map(ConversationView::counted_unread).sum();
        let channels: u32 = self
            .channels
            .iter()
            .filter_map(|channel| channel.conversation.as_ref())
            .filter(|conversation| !conversation.muted)
            .map(|conversation| conversation.unread_mentions as u32)
            .sum();
        conversations + channels
    }

    pub fn has_new(&self) -> bool {
        self.unread() > 0
            || self
                .channels
                .iter()
                .any(|channel| channel.kind == "text" && channel.conversation.as_ref().is_some_and(|c| !c.muted && c.unread > 0.0))
    }

    fn set_users(&mut self, users: Vec<UserView>) {
        self.mentionable = users.iter().map(|user| (user.username.to_lowercase(), user.id.clone())).collect();
        self.users = users.into_iter().map(|user| (user.id.clone(), user)).collect();
    }
}

#[derive(Clone, Default)]
pub struct MessageList {
    pub items: Vec<MessageView>,
    pub has_more: bool,
    pub loading: bool,
    pub loaded: bool,
    /// Showing a window around a jump target, not the latest messages.
    pub detached: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToastKind {
    Info,
    Error,
    Security,
}

#[derive(Clone)]
pub struct Toast {
    pub id: u64,
    pub kind: ToastKind,
    pub message: String,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Overlay {
    AddServer { link: Option<String>, sign_in_url: Option<String> },
    Settings { section: Option<String> },
    NewGroup,
    Invite,
    Verify { user_id: String },
    LeaveServer,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Panel {
    Info,
    Search,
    Pins,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Phase {
    Booting,
    Ready,
    Failed(String),
}

/// A picture the interface shows, fetched or decrypted once and kept.
#[derive(Clone)]
pub enum Picture {
    Loading,
    Ready(Arc<Image>),
    Failed,
}

pub struct AppState {
    pub core: Core,
    pub phase: Phase,
    pub key_protected: bool,
    pub servers: HashMap<String, ServerState>,
    pub order: Vec<String>,
    pub active_server: Option<String>,
    pub lists: HashMap<String, MessageList>,
    pub overlay: Option<Overlay>,
    pub panel: Option<Panel>,
    pub toasts: Vec<Toast>,
    pub settings: Settings,
    pub window_focused: bool,
    pub reply_to: HashMap<String, MessageView>,
    pub editing: HashMap<String, MessageView>,
    /// A message to scroll to and highlight: (groupId, messageId, nonce).
    pub jump_target: Option<(String, String, u64)>,
    pub pictures: HashMap<String, Picture>,
    pending: HashSet<String>,
    next_toast: u64,
    reading: HashMap<String, f64>,
    _events: Option<Task<()>>,
}

pub fn image_format(mime: &str, bytes: &[u8]) -> ImageFormat {
    match mime {
        "image/png" => ImageFormat::Png,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        "image/svg+xml" => ImageFormat::Svg,
        "image/bmp" => ImageFormat::Bmp,
        "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
        _ => match bytes {
            [0x89, b'P', b'N', b'G', ..] => ImageFormat::Png,
            [b'G', b'I', b'F', ..] => ImageFormat::Gif,
            [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ImageFormat::Webp,
            _ => ImageFormat::Jpeg,
        },
    }
}

fn sort_messages(items: &mut [MessageView]) {
    items.sort_by(|a, b| match (a.seq, b.seq) {
        (Some(x), Some(y)) => x
            .partial_cmp(&y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then((a.system.is_some() as u8).cmp(&(b.system.is_some() as u8)))
            .then(a.created_at.partial_cmp(&b.created_at).unwrap_or(std::cmp::Ordering::Equal)),
        (None, None) => a.created_at.partial_cmp(&b.created_at).unwrap_or(std::cmp::Ordering::Equal),
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
    });
}

/// Whether a message counts as unread, as the core counts them.
pub fn is_unread(message: &MessageView, own_read: f64, self_id: &str, blocked: &[String]) -> bool {
    message.seq.is_some_and(|seq| seq > own_read)
        && message.sender_id != self_id
        && !message.id.starts_with("sys-")
        && message.deleted_at.is_none()
        && !blocked.contains(&message.sender_id)
}

/// How many pages a chat loads to open at its first unread message.
const UNREAD_PAGES: usize = 20;

impl AppState {
    pub fn new(core: Core, events: futures::channel::mpsc::UnboundedReceiver<Value>, cx: &mut Context<Self>) -> Self {
        let settings = Settings::load();
        cx.set_global(Theme::new(settings.accent, settings.message_size));
        let events = cx.spawn(async move |this, cx| {
            use futures::StreamExt;
            let mut events = events;
            while let Some(event) = events.next().await {
                if this.update(cx, |state, cx| state.handle_event(event, cx)).is_err() {
                    break;
                }
            }
        });
        AppState {
            core,
            phase: Phase::Booting,
            key_protected: true,
            servers: HashMap::new(),
            order: Vec::new(),
            active_server: None,
            lists: HashMap::new(),
            overlay: None,
            panel: None,
            toasts: Vec::new(),
            settings,
            window_focused: true,
            reply_to: HashMap::new(),
            editing: HashMap::new(),
            jump_target: None,
            pictures: HashMap::new(),
            pending: HashSet::new(),
            next_toast: 1,
            reading: HashMap::new(),
            _events: Some(events),
        }
    }

    // --- Calling the core ---

    /// Calls the core and hands the result to `then` back on the UI thread.
    pub fn call(
        &self,
        server: Option<&str>,
        method: &str,
        args: Vec<Value>,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, Result<Value, CoreError>, &mut Context<Self>) + 'static,
    ) {
        let call = self.core.call(server, method, args);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |state, cx| then(state, result, cx)).ok();
        })
        .detach();
    }

    /// Calls a method of the active server's session, showing a failure as a toast.
    pub fn act(&self, method: &str, args: Vec<Value>, cx: &mut Context<Self>) {
        let Some(server) = self.active_server.clone() else { return };
        self.call(Some(&server), method, args, cx, |state, result, cx| {
            if let Err(error) = result {
                state.toast(error.message, ToastKind::Error, cx);
            }
        });
    }

    pub fn active(&self) -> Option<&ServerState> {
        self.active_server.as_ref().and_then(|id| self.servers.get(id))
    }

    fn active_mut(&mut self) -> Option<&mut ServerState> {
        let id = self.active_server.clone()?;
        self.servers.get_mut(&id)
    }

    // --- Starting ---

    pub fn boot(&mut self, key: Vec<u8>, protected: bool, cx: &mut Context<Self>) {
        self.key_protected = protected;
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            if let Err(error) = core.boot(key, "Windows PC".into()).await {
                this.update(cx, |state, cx| {
                    state.phase = Phase::Failed(error);
                    cx.notify();
                })
                .ok();
                return;
            }
            let entries: Vec<ServerEntry> = match core.call(None, "listServers", vec![]).await {
                Ok(value) => from_value(value),
                Err(error) => {
                    this.update(cx, |state, cx| {
                        state.phase = Phase::Failed(error.message);
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            };
            for entry in &entries {
                let loaded = load_server(&core, entry.clone()).await;
                this.update(cx, |state, _| {
                    state.servers.insert(entry.id.clone(), loaded);
                })
                .ok();
            }
            this.update(cx, |state, cx| {
                state.order = entries.iter().map(|entry| entry.id.clone()).collect();
                state.active_server = entries.first().map(|entry| entry.id.clone());
                state.phase = Phase::Ready;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A server joined or signed in to, which takes the place of any earlier account on it.
    pub fn add_server(&mut self, server_id: String, cx: &mut Context<Self>) {
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            let Ok(value) = core.call(None, "listServers", vec![]).await else { return };
            let entries: Vec<ServerEntry> = from_value(value);
            let Some(entry) = entries.iter().find(|entry| entry.id == server_id).cloned() else { return };
            let loaded = load_server(&core, entry).await;
            this.update(cx, |state, cx| {
                state.servers.retain(|id, _| entries.iter().any(|entry| &entry.id == id));
                state.servers.insert(server_id.clone(), loaded);
                state.order = entries.iter().map(|entry| entry.id.clone()).collect();
                state.active_server = Some(server_id.clone());
                state.overlay = None;
                state.refresh_conversations(&server_id, cx);
                state.refresh_users(&server_id, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn remove_server(&mut self, server_id: &str, cx: &mut Context<Self>) {
        self.servers.remove(server_id);
        self.order.retain(|id| id != server_id);
        if self.active_server.as_deref() == Some(server_id) {
            self.active_server = self.order.first().cloned();
        }
        self.panel = None;
        self.overlay = None;
        cx.notify();
    }

    pub fn select_server(&mut self, server_id: &str, cx: &mut Context<Self>) {
        self.active_server = Some(server_id.to_string());
        self.panel = None;
        cx.notify();
    }

    pub fn select_conversation(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        let Some(server) = self.active_mut() else { return };
        server.active_key = key.clone();
        let marked = key.as_ref().and_then(|key| server.conversations.iter().find(|item| &item.key == key)).is_some_and(|item| item.marked_unread);
        self.panel = None;
        if let (Some(key), true) = (key, marked) {
            self.act("setMarkedUnread", vec![json!(key), json!(false)], cx);
        }
        cx.notify();
    }

    // --- Refreshing from the core ---

    /// Runs `work` once after `ms`, however often it's asked for in between.
    fn debounced(&mut self, key: String, ms: u64, cx: &mut Context<Self>, work: impl FnOnce(&mut Self, &mut Context<Self>) + 'static) {
        if !self.pending.insert(key.clone()) {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(ms)).await;
            this.update(cx, |state, cx| {
                state.pending.remove(&key);
                work(state, cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn refresh_conversations(&mut self, server_id: &str, cx: &mut Context<Self>) {
        let id = server_id.to_string();
        self.debounced(format!("conversations:{id}"), 60, cx, move |state, cx| {
            let core = state.core.clone();
            cx.spawn(async move |this, cx| {
                let conversations = core.call(Some(&id), "getConversations", vec![]).await;
                let channels = core.call(Some(&id), "getChannels", vec![]).await;
                this.update(cx, |state, cx| {
                    if let Some(server) = state.servers.get_mut(&id) {
                        if let Ok(conversations) = conversations {
                            server.conversations = from_value(conversations);
                        }
                        if let Ok(channels) = channels {
                            server.channels = from_value(channels);
                        }
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        });
    }

    pub fn refresh_users(&mut self, server_id: &str, cx: &mut Context<Self>) {
        let id = server_id.to_string();
        self.debounced(format!("users:{id}"), 60, cx, move |state, cx| {
            let core = state.core.clone();
            cx.spawn(async move |this, cx| {
                let users = core.call(Some(&id), "getUsers", vec![]).await;
                let me = core.call(Some(&id), "getSelf", vec![]).await;
                this.update(cx, |state, cx| {
                    if let Some(server) = state.servers.get_mut(&id) {
                        if let Ok(users) = users {
                            server.set_users(from_value(users));
                        }
                        if let Ok(me) = me {
                            server.me = Some(from_value(me));
                        }
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        });
    }

    fn refresh_field(&mut self, server_id: &str, method: &'static str, cx: &mut Context<Self>, apply: fn(&mut ServerState, Value)) {
        let id = server_id.to_string();
        self.call(Some(server_id), method, vec![], cx, move |state, result, cx| {
            if let (Ok(value), Some(server)) = (result, state.servers.get_mut(&id)) {
                apply(server, value);
                cx.notify();
            }
        });
    }

    fn upsert_message(&mut self, message: MessageView) {
        let Some(list) = self.lists.get_mut(&message.group_id) else { return };
        if let Some(index) = list.items.iter().position(|item| item.id == message.id) {
            list.items[index] = message;
        } else if !list.detached {
            list.items.push(message);
            sort_messages(&mut list.items);
        }
    }

    pub fn handle_event(&mut self, event: Value, cx: &mut Context<Self>) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
        let server_id = event.get("serverId").and_then(Value::as_str).unwrap_or_default().to_string();
        let text = |name: &str| event.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        match kind.as_str() {
            "connection" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.connection = text("state");
                }
            }
            "conversations" | "read" => self.refresh_conversations(&server_id, cx),
            "channels" => self.refresh_conversations(&server_id, cx),
            "users" => {
                self.refresh_users(&server_id, cx);
                self.refresh_conversations(&server_id, cx);
            }
            "message" => {
                let message: MessageView = from_value(event.get("message").cloned().unwrap_or_default());
                let is_new = event.get("isNew").and_then(Value::as_bool).unwrap_or(false);
                if is_new {
                    if let Some(server) = self.servers.get_mut(&server_id) {
                        if let Some(typing) = server.typing.get_mut(&message.group_id) {
                            typing.remove(&message.sender_id);
                        }
                    }
                }
                self.upsert_message(message);
            }
            "message_removed" => {
                let group = text("groupId");
                let id = text("id");
                if let Some(list) = self.lists.get_mut(&group) {
                    list.items.retain(|item| item.id != id);
                }
            }
            "message_moved" => {
                let from = text("fromGroupId");
                let message: MessageView = from_value(event.get("message").cloned().unwrap_or_default());
                let mut has_more = true;
                if let Some(list) = self.lists.get_mut(&from) {
                    list.items.retain(|item| item.id != message.id);
                    has_more = list.has_more;
                }
                let target = self.lists.entry(message.group_id.clone()).or_insert_with(|| MessageList { has_more, ..Default::default() });
                target.items.retain(|item| item.id != message.id);
                target.items.push(message.clone());
                sort_messages(&mut target.items);
                let key = from.trim_start_matches("pending:").to_string();
                if let Some(server) = self.servers.get_mut(&server_id) {
                    for conversation in server.conversations.iter_mut().filter(|item| item.key == key) {
                        conversation.group_id = Some(message.group_id.clone());
                    }
                }
            }
            "presence" => {
                if let Some(user) = self.servers.get_mut(&server_id).and_then(|server| server.users.get_mut(&text("userId"))) {
                    user.online = event.get("online").and_then(Value::as_bool).unwrap_or(false);
                    user.last_seen_at = event.get("lastSeenAt").and_then(Value::as_f64);
                }
            }
            "typing" => {
                let group = text("groupId");
                let user = text("userId");
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.typing.entry(group.clone()).or_default().insert(user.clone(), now_ms() + 5000.0);
                }
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(5100)).await;
                    this.update(cx, |state, cx| {
                        if let Some(typing) = state.servers.get_mut(&server_id).and_then(|server| server.typing.get_mut(&group)) {
                            if typing.get(&user).is_some_and(|until| *until <= now_ms()) {
                                typing.remove(&user);
                                cx.notify();
                            }
                        }
                    })
                    .ok();
                })
                .detach();
            }
            "settings" => {
                let info: ServerInfo = from_value(event.get("info").cloned().unwrap_or_default());
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.name = info.name.clone();
                    server.entry.has_icon = info.has_icon;
                    server.info = Some(info);
                }
            }
            "emotes" => self.refresh_field(&server_id, "getEmotes", cx, |server, value| server.emotes = from_value(value)),
            "preferences" => self.refresh_field(&server_id, "getPreferences", cx, |server, value| server.prefs = from_value(value)),
            "voice" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    let device = text("deviceId");
                    match event.get("member").filter(|member| !member.is_null()) {
                        Some(member) => {
                            server.voice.insert(device, from_value(member.clone()));
                        }
                        None => {
                            server.voice.remove(&device);
                        }
                    }
                }
            }
            "call" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    let group = text("groupId");
                    match event.get("call").filter(|call| !call.is_null()) {
                        Some(call) => {
                            server.calls.insert(group, from_value(call.clone()));
                        }
                        None => {
                            server.calls.remove(&group);
                        }
                    }
                }
            }
            "signed_out" => {
                let reason = text("reason");
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.signed_out = Some(reason.clone());
                }
                let message = if reason == "banned" { "You were removed from a server by its admins." } else { "You've been signed out of a server." };
                self.toast(message, ToastKind::Info, cx);
            }
            "signed_in" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.signed_out = None;
                }
            }
            "security" => self.toast(text("message"), ToastKind::Security, cx),
            _ => {}
        }
        cx.notify();
    }

    // --- Messages ---

    /// The newest page, and with unread messages, the pages back to the first of them.
    pub fn load_list(&mut self, list_id: &str, group_id: Option<String>, cx: &mut Context<Self>) {
        if let Some(existing) = self.lists.get(list_id) {
            if existing.loaded || existing.loading {
                return;
            }
        }
        let list = self.lists.entry(list_id.to_string()).or_insert_with(|| MessageList { has_more: true, ..Default::default() });
        list.loading = true;
        let Some(group_id) = group_id else {
            list.loading = false;
            list.loaded = true;
            list.has_more = false;
            return;
        };
        let Some(server) = self.active() else { return };
        let server_id = server.entry.id.clone();
        let self_id = server.self_id().to_string();
        let blocked = server.prefs.blocked().to_vec();
        let (own_read, unread) = server
            .conversations
            .iter()
            .find(|item| item.group_id.as_deref() == Some(group_id.as_str()))
            .or_else(|| server.channels.iter().find(|channel| channel.id == group_id).and_then(|channel| channel.conversation.as_ref()))
            .map(|conversation| (conversation.own_read, conversation.unread))
            .unwrap_or((0.0, 0.0));
        let core = self.core.clone();
        let list_id = list_id.to_string();
        cx.spawn(async move |this, cx| {
            let mut page: MessagePage = match core.call(Some(&server_id), "loadMessages", vec![json!(group_id)]).await {
                Ok(value) => from_value(value),
                Err(error) => {
                    this.update(cx, |state, cx| {
                        if let Some(list) = state.lists.get_mut(&list_id) {
                            list.loading = false;
                        }
                        state.toast(error.message, ToastKind::Error, cx);
                    })
                    .ok();
                    return;
                }
            };
            let unread_in = |messages: &[MessageView]| messages.iter().filter(|m| is_unread(m, own_read, &self_id, &blocked)).count() as f64;
            let mut pages = 1;
            while page.has_more && pages < UNREAD_PAGES && unread_in(&page.messages) < unread {
                let Some(oldest) = page.messages.iter().find_map(|message| message.seq) else { break };
                if oldest <= own_read + 1.0 {
                    break;
                }
                let Ok(value) = core.call(Some(&server_id), "loadMessages", vec![json!(group_id), json!(oldest)]).await else { break };
                let older: MessagePage = from_value(value);
                let mut messages = older.messages;
                messages.append(&mut page.messages);
                page.messages = messages;
                page.has_more = older.has_more;
                pages += 1;
            }
            this.update(cx, |state, cx| {
                let list = state.lists.entry(list_id.clone()).or_default();
                let mut by_id: HashMap<String, MessageView> = page.messages.into_iter().map(|m| (m.id.clone(), m)).collect();
                for item in list.items.drain(..) {
                    by_id.entry(item.id.clone()).or_insert(item);
                }
                let mut items: Vec<MessageView> = by_id.into_values().collect();
                sort_messages(&mut items);
                list.items = items;
                list.has_more = page.has_more;
                list.loading = false;
                list.loaded = true;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn load_older(&mut self, list_id: &str, cx: &mut Context<Self>) {
        let Some(server_id) = self.active_server.clone() else { return };
        let Some(list) = self.lists.get_mut(list_id) else { return };
        if list.loading || !list.has_more || list.detached {
            return;
        }
        let Some(oldest) = list.items.iter().find_map(|item| item.seq) else { return };
        list.loading = true;
        let list_id = list_id.to_string();
        self.call(Some(&server_id), "loadMessages", vec![json!(list_id), json!(oldest)], cx, move |state, result, cx| {
            let Some(list) = state.lists.get_mut(&list_id) else { return };
            list.loading = false;
            if let Ok(value) = result {
                let page: MessagePage = from_value(value);
                let known: HashSet<String> = list.items.iter().map(|item| item.id.clone()).collect();
                let mut older: Vec<MessageView> = page.messages.into_iter().filter(|m| !known.contains(&m.id)).collect();
                older.append(&mut list.items);
                list.items = older;
                list.has_more = page.has_more;
            }
            cx.notify();
        });
    }

    pub fn jump_to_message(&mut self, group_id: &str, message_id: &str, cx: &mut Context<Self>) {
        let present = self.lists.get(group_id).is_some_and(|list| list.items.iter().any(|item| item.id == message_id));
        let nonce = now_ms() as u64;
        if present {
            self.jump_target = Some((group_id.to_string(), message_id.to_string(), nonce));
            cx.notify();
            return;
        }
        let Some(server_id) = self.active_server.clone() else { return };
        let core = self.core.clone();
        let group = group_id.to_string();
        let id = message_id.to_string();
        cx.spawn(async move |this, cx| {
            let found = core.call(Some(&server_id), "messageById", vec![json!(group), json!(id)]).await.ok();
            let seq = found.and_then(|value| value.get("seq").and_then(Value::as_f64));
            let Some(seq) = seq else {
                this.update(cx, |state, cx| state.toast("That message isn't available.", ToastKind::Info, cx)).ok();
                return;
            };
            let Ok(window) = core.call(Some(&server_id), "loadAround", vec![json!(group), json!(seq)]).await else { return };
            let mut items: Vec<MessageView> = from_value(window);
            sort_messages(&mut items);
            this.update(cx, |state, cx| {
                state.lists.insert(group.clone(), MessageList { items, has_more: true, loading: false, loaded: true, detached: true });
                state.jump_target = Some((group, id, nonce));
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn return_to_latest(&mut self, list_id: &str, cx: &mut Context<Self>) {
        self.lists.remove(list_id);
        self.load_list(list_id, Some(list_id.to_string()), cx);
        cx.notify();
    }

    /// Tells the server how far this person has read, one position at a time.
    pub fn mark_read(&mut self, group_id: &str, seq: f64, cx: &mut Context<Self>) {
        if self.reading.get(group_id).is_some_and(|sent| *sent >= seq) {
            return;
        }
        self.reading.insert(group_id.to_string(), seq);
        self.act("markRead", vec![json!(group_id), json!(seq)], cx);
    }

    pub fn set_reply(&mut self, list_id: &str, message: Option<MessageView>, cx: &mut Context<Self>) {
        match message {
            Some(message) => {
                self.editing.remove(list_id);
                self.reply_to.insert(list_id.to_string(), message);
            }
            None => {
                self.reply_to.remove(list_id);
            }
        }
        cx.notify();
    }

    pub fn set_editing(&mut self, list_id: &str, message: Option<MessageView>, cx: &mut Context<Self>) {
        match message {
            Some(message) => {
                self.reply_to.remove(list_id);
                self.editing.insert(list_id.to_string(), message);
            }
            None => {
                self.editing.remove(list_id);
            }
        }
        cx.notify();
    }

    // --- Overlays, panels, toasts and settings ---

    pub fn set_overlay(&mut self, overlay: Option<Overlay>, cx: &mut Context<Self>) {
        self.overlay = overlay;
        cx.notify();
    }

    pub fn toggle_panel(&mut self, panel: Panel, cx: &mut Context<Self>) {
        self.panel = if self.panel == Some(panel) { None } else { Some(panel) };
        cx.notify();
    }

    pub fn toast(&mut self, message: impl Into<String>, kind: ToastKind, cx: &mut Context<Self>) {
        let id = self.next_toast;
        self.next_toast += 1;
        if self.toasts.len() > 3 {
            self.toasts.remove(0);
        }
        self.toasts.push(Toast { id, kind, message: message.into() });
        let wait = if kind == ToastKind::Security { 12_000 } else { 4_500 };
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(wait)).await;
            this.update(cx, |state, cx| state.dismiss_toast(id, cx)).ok();
        })
        .detach();
        cx.notify();
    }

    pub fn dismiss_toast(&mut self, id: u64, cx: &mut Context<Self>) {
        self.toasts.retain(|toast| toast.id != id);
        cx.notify();
    }

    pub fn update_settings(&mut self, change: impl FnOnce(&mut Settings), cx: &mut Context<Self>) {
        change(&mut self.settings);
        self.settings.save();
        cx.set_global(Theme::new(self.settings.accent, self.settings.message_size));
        cx.refresh_windows();
        cx.notify();
    }

    // --- Pictures ---

    fn store_picture(&mut self, key: String, result: Result<(Vec<u8>, String), String>, cx: &mut Context<Self>) {
        let picture = match result {
            Ok((bytes, mime)) if !bytes.is_empty() => Picture::Ready(Arc::new(Image::from_bytes(image_format(&mime, &bytes), bytes))),
            _ => Picture::Failed,
        };
        self.pictures.insert(key, picture);
        cx.notify();
    }

    /// Something a server serves openly, such as its icon or an emote, by address.
    pub fn remote_picture(&mut self, url: &str, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        match self.pictures.get(url) {
            Some(Picture::Ready(image)) => return Some(image.clone()),
            Some(_) => return None,
            None => {}
        }
        self.pictures.insert(url.to_string(), Picture::Loading);
        let key = url.to_string();
        let fetching = host::fetch(url.to_string());
        cx.spawn(async move |this, cx| {
            let result = fetching.await.map(|bytes| (bytes, String::new()));
            this.update(cx, |state, cx| state.store_picture(key, result, cx)).ok();
        })
        .detach();
        None
    }

    /// An encrypted picture, such as a profile picture, decrypted by the core.
    pub fn decrypted_picture(&mut self, server_id: &str, avatar: &AvatarRef, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        let key = format!("file:{}", avatar.file_id);
        match self.pictures.get(&key) {
            Some(Picture::Ready(image)) => return Some(image.clone()),
            Some(_) => return None,
            None => {}
        }
        self.pictures.insert(key.clone(), Picture::Loading);
        let reference = serde_json::to_value(avatar).unwrap_or_default();
        let mime = avatar.mime.clone();
        self.call(Some(server_id), "downloadFile", vec![reference], cx, move |state, result, cx| {
            let bytes = result.map_err(|error| error.message).and_then(|value| {
                if let Some(path) = value.get("$file").and_then(|file| file.get("path")).and_then(Value::as_str) {
                    std::fs::read(path).map_err(|error| error.to_string())
                } else {
                    host::read_bytes(&value).ok_or_else(|| "no picture".to_string())
                }
            });
            state.store_picture(key, bytes.map(|bytes| (bytes, mime)), cx);
        });
        None
    }

    pub fn emote_url(&self, server_url: &str, id: &str) -> String {
        format!("{server_url}/api/emotes/{id}/2x.webp")
    }
}

async fn load_server(core: &Core, entry: ServerEntry) -> ServerState {
    let id = entry.id.clone();
    let get = |method: &'static str| core.call(Some(&id), method, vec![]);
    let (conversations, users, emotes, prefs, me, connection, info, channels, voice, calls) = futures::join!(
        get("getConversations"),
        get("getUsers"),
        get("getEmotes"),
        get("getPreferences"),
        get("getSelf"),
        get("getConnectionState"),
        get("getInfo"),
        get("getChannels"),
        get("getVoiceMembers"),
        get("getCalls"),
    );
    let mut server = ServerState {
        entry,
        info: info.ok().filter(|value| !value.is_null()).map(from_value),
        connection: connection.ok().and_then(|value| value.as_str().map(str::to_string)).unwrap_or_else(|| "connecting".into()),
        me: me.ok().map(from_value),
        conversations: conversations.map(from_value).unwrap_or_default(),
        channels: channels.map(from_value).unwrap_or_default(),
        voice: voice
            .map(from_value::<Vec<VoiceMember>>)
            .unwrap_or_default()
            .into_iter()
            .map(|member| (member.device_id.clone(), member))
            .collect(),
        calls: calls.map(from_value::<Vec<CallView>>).unwrap_or_default().into_iter().map(|call| (call.group_id.clone(), call)).collect(),
        users: HashMap::new(),
        mentionable: HashMap::new(),
        emotes: emotes.map(from_value).unwrap_or_default(),
        prefs: prefs.map(from_value).unwrap_or_default(),
        active_key: None,
        typing: HashMap::new(),
    };
    server.set_users(users.map(from_value).unwrap_or_default());
    server
}

/// The state's entity, shared by every view.
#[derive(Clone)]
pub struct Store(pub Entity<AppState>);

impl gpui::Global for Store {}

pub fn store(cx: &App) -> Entity<AppState> {
    cx.global::<Store>().0.clone()
}
