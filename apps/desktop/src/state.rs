//! All UI state, kept in sync with the core through its events, as the desktop's
//! zustand store (packages/ui/src/state/store.ts) keeps it.

use std::collections::{HashMap, HashSet, VecDeque};
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
    /// The soundboard, oldest first.
    pub sounds: Vec<SoundView>,
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
    /// Choosing what to share from a voice channel or a call.
    ScreenPicker,
    Settings { section: Option<String> },
    NewGroup,
    Invite,
    Verify { user_id: String },
    LeaveServer,
    /// Where to forward messages: any chat on any server.
    Forward { server_id: String, group_id: String, ids: Vec<String> },
    /// People to add to a group.
    AddMembers { group_id: String },
    /// Finding where this device is, to send it to a chat.
    ShareLocation { conversation_key: String },
    /// A server's settings, for its admins, and signing out of it.
    ServerSettings { section: Option<String> },
    /// Making a channel, or editing one, for server admins.
    Channel { channel_id: Option<String>, category: Option<String> },
}

/// A media file decrypted to disk for playing.
#[derive(Clone)]
pub enum MediaFile {
    Loading,
    Ready(std::path::PathBuf),
    Failed,
}

/// A media file's sound, decoded.
#[derive(Clone)]
pub enum ClipState {
    Loading,
    Ready(crate::media::player::Clip),
    Failed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Panel {
    Info,
    Search,
    Pins,
    /// One kind of what's been shared in the chat.
    Media(SharedKind),
}

/// What a chat's details list by kind, in Telegram's order.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum SharedKind {
    Photo,
    Video,
    File,
    Audio,
    Link,
    Voice,
    Groups,
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

/// A notification waiting to be shown, and the key of the photo it waits for.
struct WaitingNotification {
    id: u64,
    payload: crate::ui::notifications::Payload,
    photo: Option<String>,
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
    /// What was written in each chat and not sent, by its key, for as long as the app runs.
    pub drafts: HashMap<String, String>,
    /// Messages picked in one chat, by its list, in the order they were picked.
    pub selection: Option<(String, Vec<String>)>,
    /// Voice messages, sound files and videos: their files, sound, players, and where each was paused.
    pub media_files: HashMap<String, MediaFile>,
    pub clips: HashMap<String, ClipState>,
    pub videos: HashMap<String, Entity<crate::ui::media_views::VideoPlayer>>,
    /// Players to make once their files are here: whether each is a video message, and its length.
    videos_wanted: HashMap<String, (bool, f64)>,
    pub paused_at: HashMap<String, f64>,
    pub play_when_ready: Option<(String, f64)>,
    media_tick: Option<Task<()>>,
    /// Notified while something plays, in place of the whole state, so only the chat draws again.
    pub media_clock: Entity<MediaClock>,
    pub editing: HashMap<String, MessageView>,
    /// A message to scroll to and highlight: (groupId, messageId, nonce).
    pub jump_target: Option<(String, String, u64)>,
    pub pictures: HashMap<String, Picture>,
    /// When each picture, sound, video and media file was last shown, by its key, on a count
    /// that goes up with each showing, so the least recently shown go first once a cache is full.
    media_used: std::cell::RefCell<HashMap<String, u64>>,
    media_count: std::cell::Cell<u64>,
    pending: HashSet<String>,
    next_toast: u64,
    reading: HashMap<String, f64>,
    /// When each chat was last notified about, by server: what may still be up.
    notified: HashMap<String, HashMap<String, f64>>,
    /// Notifications waiting for their chat's photo, or behind one that is.
    waiting_notifications: VecDeque<WaitingNotification>,
    next_notification: u64,
    /// Whether the core was last told this person is here (activity.ts).
    reported_active: Option<bool>,
    _events: Option<Task<()>>,
    _activity: Option<Task<()>>,
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

/// How many of a chat's newest messages stay loaded once it's closed, as on the web. Opening
/// it again loads older ones as it's scrolled.
const KEPT_WHEN_CLOSED: usize = 150;

/// How much of each kind of decrypted media stays in memory, or on disk, before the least
/// recently shown goes: pictures by their encoded bytes, sounds by their decoded samples,
/// video players and decrypted media files by count. Whatever plays is always kept.
const PICTURE_BYTES: usize = 128 << 20;
const CLIP_BYTES: usize = 128 << 20;
const VIDEOS_KEPT: usize = 12;
const MEDIA_FILES_KEPT: usize = 48;

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
            window_focused: false,
            reply_to: HashMap::new(),
            drafts: HashMap::new(),
            selection: None,
            media_files: HashMap::new(),
            clips: HashMap::new(),
            videos: HashMap::new(),
            videos_wanted: HashMap::new(),
            paused_at: HashMap::new(),
            play_when_ready: None,
            media_tick: None,
            media_clock: cx.new(|_| MediaClock),
            editing: HashMap::new(),
            jump_target: None,
            pictures: HashMap::new(),
            pending: HashSet::new(),
            media_used: std::cell::RefCell::new(HashMap::new()),
            media_count: std::cell::Cell::new(0),
            next_toast: 1,
            reading: HashMap::new(),
            notified: HashMap::new(),
            waiting_notifications: VecDeque::new(),
            next_notification: 1,
            reported_active: None,
            _events: Some(events),
            _activity: None,
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

    /// Carries on from the boot `main` started, before the window.
    pub fn boot(&mut self, booting: impl std::future::Future<Output = Result<(), String>> + 'static, protected: bool, cx: &mut Context<Self>) {
        self.key_protected = protected;
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            let booting = booting.await;
            if let Err(error) = booting {
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
                state.watch_activity(cx);
                state.update_badge(cx);
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
        self.notified.remove(server_id);
        self.clear_notifications(Some(server_id), None, None, cx);
        // Its chats' messages, and what was being written in them, go with it.
        if let Some(server) = self.servers.get(server_id) {
            let conversations: Vec<&ConversationView> = server.conversations.iter().chain(server.channels.iter().filter_map(|channel| channel.conversation.as_ref())).collect();
            let lists: HashSet<String> = conversations.iter().map(|conversation| conversation.list_id()).collect();
            let keys: HashSet<String> = conversations.iter().map(|conversation| conversation.key.clone()).collect();
            self.lists.retain(|id, _| !lists.contains(id));
            self.reply_to.retain(|id, _| !lists.contains(id));
            self.editing.retain(|id, _| !lists.contains(id));
            self.drafts.retain(|key, _| !keys.contains(key));
        }
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
        let leaving = self.active_server.clone().filter(|id| id != server_id).and_then(|id| Some((id.clone(), self.servers.get(&id)?.active_key.clone()?)));
        self.active_server = Some(server_id.to_string());
        self.panel = None;
        if let Some((id, key)) = leaving {
            self.close_list(&id, &key);
        }
        cx.notify();
    }

    /// Cuts a chat back to its newest messages once it isn't shown, so a long run doesn't keep
    /// every page it ever loaded, and drops a window opened around an old message.
    fn close_list(&mut self, server_id: &str, key: &str) {
        let Some(list_id) = self.servers.get(server_id).and_then(|server| server.find_conversation(key)).map(|conversation| conversation.list_id()) else { return };
        let Some(list) = self.lists.get_mut(&list_id) else { return };
        if list.loading {
            return;
        }
        if list.detached {
            self.lists.remove(&list_id);
        } else if list.items.len() > KEPT_WHEN_CLOSED {
            let cut = list.items.len() - KEPT_WHEN_CLOSED;
            list.items.drain(..cut);
            list.has_more = true;
        }
    }

    pub fn select_conversation(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        let server_id = self.active_server.clone();
        let Some(server) = self.active_mut() else { return };
        let previous = std::mem::replace(&mut server.active_key, key.clone());
        let marked = key.as_ref().and_then(|key| server.conversations.iter().find(|item| &item.key == key)).is_some_and(|item| item.marked_unread);
        self.panel = None;
        if let (Some(server_id), Some(previous)) = (server_id, previous.filter(|previous| Some(previous) != key.as_ref())) {
            self.close_list(&server_id, &previous);
        }
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
                let asked = now_ms();
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
                    state.update_badge(cx);
                    state.clear_read(&id, asked, cx);
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
                // Deleted for everyone: what it said goes from everywhere.
                if message.deleted_at.is_some() {
                    self.clear_notifications(Some(&server_id), None, Some(&message.id), cx);
                }
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
                self.clear_notifications(Some(&server_id), None, Some(&id), cx);
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
            "sounds" => self.refresh_field(&server_id, "getSounds", cx, |server, value| server.sounds = from_value(value)),
            "calls" => {
                let server = server_id.clone();
                self.refresh_field(&server_id, "getCalls", cx, |state_server, value| {
                    state_server.calls = from_value::<Vec<CallView>>(value).into_iter().map(|call| (call.group_id.clone(), call)).collect();
                });
                self.refresh_field(&server, "getVoiceMembers", cx, |state_server, value| {
                    state_server.voice = from_value::<Vec<VoiceMember>>(value).into_iter().map(|member| (member.device_id.clone(), member)).collect();
                });
            }
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
                let group = text("groupId");
                let call: Option<CallView> = event.get("call").filter(|call| !call.is_null()).map(|call| from_value(call.clone()));
                let before = self.servers.get(&server_id).and_then(|server| server.calls.get(&group).cloned());
                if let Some(server) = self.servers.get_mut(&server_id) {
                    match &call {
                        Some(call) => {
                            server.calls.insert(group.clone(), call.clone());
                        }
                        None => {
                            server.calls.remove(&group);
                        }
                    }
                }
                self.notice_call(&server_id, &group, before, call, cx);
            }
            "signed_out" => {
                let reason = text("reason");
                self.notified.remove(&server_id);
                self.clear_notifications(Some(&server_id), None, None, cx);
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.signed_out = Some(reason.clone());
                }
                let message = match reason.as_str() {
                    "banned" => "You were removed from a server by its admins.",
                    "account_deleted" => "Your account on a server was deleted from another device.",
                    _ => "You've been signed out of a server.",
                };
                self.toast(message, ToastKind::Info, cx);
            }
            "signed_in" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.signed_out = None;
                }
            }
            "security" => self.toast(text("message"), ToastKind::Security, cx),
            "notify" => self.notify(&event, cx),
            _ => {}
        }
        // Voice reads this state, so it hears of its events once this update is over.
        if matches!(kind.as_str(), "voice" | "voice_key" | "voice_ended" | "screen_ended" | "call" | "calls" | "sound" | "signed_out") {
            cx.defer(move |cx| crate::voice::on_event(&event, cx));
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

    /// Picks or unpicks a message, or with none stops picking (toggleSelected).
    pub fn toggle_selected(&mut self, list_id: &str, id: Option<&str>, cx: &mut Context<Self>) {
        let Some(id) = id else {
            self.selection = None;
            cx.notify();
            return;
        };
        let mut ids = match &self.selection {
            Some((list, ids)) if list == list_id => ids.clone(),
            _ => Vec::new(),
        };
        if let Some(index) = ids.iter().position(|item| item == id) {
            ids.remove(index);
        } else {
            ids.push(id.to_string());
        }
        self.selection = (!ids.is_empty()).then(|| (list_id.to_string(), ids));
        cx.notify();
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

    // --- Notifications, the badge and activity ---

    /// The unread count across servers, on the taskbar and the tray (updateBadge).
    pub fn update_badge(&self, cx: &App) {
        let total: u32 = self.servers.values().map(ServerState::unread).sum();
        crate::platform::later(cx, move || crate::platform::icons::set_unread(total));
    }

    /// Chats an earlier run notified about, which the system still shows, to be taken back as
    /// this run's are once they're read.
    #[cfg(target_os = "macos")]
    pub fn notified_earlier(&mut self, chats: Vec<(String, String)>, cx: &mut Context<Self>) {
        let mut servers = HashSet::new();
        for (server_id, key) in chats {
            self.notified.entry(server_id.clone()).or_default().entry(key).or_insert(0.);
            servers.insert(server_id);
        }
        servers.retain(|id| self.servers.contains_key(id));
        for server_id in servers {
            self.refresh_conversations(&server_id, cx);
        }
    }

    /// A chat with nothing unread has nothing to notify about any more, however it came to be read.
    fn clear_read(&mut self, server_id: &str, asked: f64, cx: &mut Context<Self>) {
        let Some(server) = self.servers.get(server_id) else { return };
        let Some(in_server) = self.notified.get_mut(server_id) else { return };
        if in_server.is_empty() {
            return;
        }
        let conversations = server.conversations.iter().chain(server.channels.iter().filter_map(|channel| channel.conversation.as_ref()));
        // What was just notified about may be newer than this list of what's unread.
        let keys: Vec<String> = conversations
            .filter(|item| item.unread == 0. && in_server.get(&item.key).copied().unwrap_or(asked) < asked)
            .map(|item| item.key.clone())
            .collect();
        if keys.is_empty() {
            return;
        }
        for key in &keys {
            in_server.remove(key);
        }
        self.clear_notifications(Some(server_id), Some(&keys), None, cx);
    }

    /// A message the core says to notify about, unless its chat is open in front of the person (notify in store.ts).
    fn notify(&mut self, event: &Value, cx: &mut Context<Self>) {
        let text = |name: &str| event.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        let server_id = text("serverId");
        let key = text("conversationKey");
        let open_here = self.window_in_front()
            && self.active_server.as_deref() == Some(server_id.as_str())
            && self.active().is_some_and(|server| server.active_key.as_deref() == Some(key.as_str()));
        if open_here || !self.settings.notifications {
            return;
        }
        self.notified.entry(server_id.clone()).or_default().insert(key.clone(), now_ms());
        let system = crate::platform::notification_state();
        if self.settings.notification_sound && system.sound {
            crate::platform::play_notification_sound();
        }
        crate::platform::later(cx, crate::platform::flash_main);
        if !system.show {
            return;
        }
        let preview = self.settings.notification_preview.clone();
        let conversation = self.servers.get(&server_id).and_then(|server| server.find_conversation(&key)).cloned();
        let title = if preview == "none" { "Zuna".to_string() } else { text("title") };
        let body = if preview == "full" { text("body") } else { "New message".to_string() };
        // The same picture as beside the chat in the list.
        let picture = if preview == "none" {
            None
        } else {
            let image = conversation.as_ref().and_then(|conversation| conversation.avatar.as_ref()).and_then(|avatar| match self.pictures.get(&format!("file:{}", avatar.file_id)) {
                Some(Picture::Ready(image)) => Some(image.clone()),
                _ => None,
            });
            let title = conversation.as_ref().map(|c| c.title.clone()).unwrap_or_else(|| text("title"));
            let seed = conversation.as_ref().and_then(|c| c.peer_id.clone().or(c.group_id.clone())).unwrap_or_else(|| key.clone());
            Some(crate::ui::notifications::Picture { image, initials: crate::format::initials_of(&title), seed })
        };
        let payload = crate::ui::notifications::Payload {
            title,
            body,
            server_id: server_id.clone(),
            key,
            message_id: text("messageId"),
            kind: conversation.as_ref().map(|c| c.kind.clone()).unwrap_or_else(|| "dm".into()),
            picture,
            // Writing back needs to show what's being answered, and somewhere to write it.
            can_reply: preview == "full" && !conversation.as_ref().is_some_and(|c| c.removed),
            wait_for_input: system.wait_for_input,
        };
        let avatar = conversation.as_ref().and_then(|c| c.avatar.clone());
        self.show_notification(payload, &server_id, avatar.as_ref(), cx);
    }

    /// A call starting to ring this person, or one they missed: a card while the app isn't in front,
    /// and for a missed one a toast while it is (noticeCall in store.ts).
    fn notice_call(&mut self, server_id: &str, group_id: &str, before: Option<CallView>, call: Option<CallView>, cx: &mut Context<Self>) {
        let Some(self_id) = self.servers.get(server_id).map(|server| server.self_id().to_string()) else { return };
        if self_id.is_empty() {
            return;
        }
        let was_ringing = before.as_ref().is_some_and(|call| call.ringing.contains(&self_id));
        let ringing = call.as_ref().is_some_and(|call| call.ringing.contains(&self_id));
        if was_ringing == ringing {
            return;
        }
        let message_id = format!("call:{group_id}");
        if was_ringing {
            self.clear_notifications(Some(server_id), None, Some(&message_id), cx);
        }
        let Some(server) = self.servers.get(server_id) else { return };
        let Some(conversation) = crate::voice::conversation_of_group(server, group_id).cloned() else { return };
        let caller = call.as_ref().or(before.as_ref()).map(|call| call.started_by.clone()).unwrap_or_default();
        if conversation.muted || conversation.blocked || server.prefs.blocked().contains(&caller) {
            return;
        }
        // Answered on another device, or declined, isn't missed.
        let answered = server.voice.values().any(|member| member.channel_id == group_id && member.user_id == self_id);
        let missed = was_ringing && !answered && !call.as_ref().is_some_and(|call| call.declined.contains(&self_id));
        if !ringing && !missed {
            return;
        }
        let name = server.users.get(&caller).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let dm = conversation.kind == "dm";
        let body = match (ringing, dm) {
            (true, true) => "Calling you".to_string(),
            (true, false) => format!("{name} started a call"),
            (false, true) => "Missed call".to_string(),
            (false, false) => format!("Missed call from {name}"),
        };
        if self.window_in_front() {
            if missed {
                let message = if dm { format!("Missed call from {name}.") } else { format!("Missed call from {name} in {}.", conversation.title) };
                self.toast(message, ToastKind::Info, cx);
            }
            return;
        }
        if !self.settings.notifications {
            return;
        }
        crate::platform::later(cx, crate::platform::flash_main);
        let system = crate::platform::notification_state();
        if !system.show {
            return;
        }
        // A call's ringing has its own sound, so the notification makes none.
        let preview = self.settings.notification_preview.clone();
        let picture = (preview != "none").then(|| {
            let image = conversation.avatar.as_ref().and_then(|avatar| match self.pictures.get(&format!("file:{}", avatar.file_id)) {
                Some(Picture::Ready(image)) => Some(image.clone()),
                _ => None,
            });
            crate::ui::notifications::Picture { image, initials: crate::format::initials_of(&conversation.title), seed: conversation.peer_id.clone().or(conversation.group_id.clone()).unwrap_or_default() }
        });
        let payload = crate::ui::notifications::Payload {
            title: if preview == "none" { "Zuna".to_string() } else { conversation.title.clone() },
            body: if preview == "none" { (if ringing { "Incoming call" } else { "Missed call" }).to_string() } else { body },
            server_id: server_id.to_string(),
            key: conversation.key.clone(),
            message_id,
            kind: conversation.kind.clone(),
            picture,
            can_reply: false,
            wait_for_input: system.wait_for_input,
        };
        self.show_notification(payload, server_id, conversation.avatar.as_ref(), cx);
    }

    /// Shows a notification with its chat's photo, which, when it isn't decrypted yet, as for a chat
    /// on a server not in front, is waited for up to 400 ms before showing its initials. One at a
    /// time, so a photo that takes a moment can't reorder them (showNotification in store.ts).
    fn show_notification(&mut self, payload: crate::ui::notifications::Payload, server_id: &str, avatar: Option<&AvatarRef>, cx: &mut Context<Self>) {
        let id = self.next_notification;
        self.next_notification += 1;
        let mut photo = None;
        let without_photo = payload.picture.as_ref().is_some_and(|picture| picture.image.is_none());
        if let Some(avatar) = avatar.filter(|_| without_photo) {
            let key = format!("file:{}", avatar.file_id);
            if !matches!(self.pictures.get(&key), Some(Picture::Failed)) {
                self.decrypted_picture(server_id, avatar, cx);
                photo = Some(key);
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(400)).await;
                    this.update(cx, |state, cx| {
                        if let Some(waiting) = state.waiting_notifications.iter_mut().find(|waiting| waiting.id == id) {
                            waiting.photo = None;
                        }
                        state.show_waiting(cx);
                    })
                    .ok();
                })
                .detach();
            }
        }
        self.waiting_notifications.push_back(WaitingNotification { id, payload, photo });
        self.show_waiting(cx);
    }

    /// Shows the notifications in order, up to one still waiting for its photo.
    fn show_waiting(&mut self, cx: &mut Context<Self>) {
        let reduce_motion = self.settings.reduce_motion;
        while let Some(waiting) = self.waiting_notifications.front() {
            let image = match waiting.photo.as_ref().map(|key| self.pictures.get(key)) {
                Some(Some(Picture::Ready(image))) => Some(image.clone()),
                Some(Some(Picture::Loading) | None) => return,
                _ => None,
            };
            let Some(WaitingNotification { mut payload, .. }) = self.waiting_notifications.pop_front() else { return };
            if let (Some(picture), Some(image)) = (payload.picture.as_mut(), image) {
                picture.image = Some(image);
            }
            if let Some(center) = crate::ui::notifications::center(cx) {
                center.update(cx, |center, cx| center.show(payload, reduce_motion, cx));
            }
        }
    }

    /// Takes back notifications matching everything given, shown or waiting for a photo.
    fn clear_notifications(&mut self, server_id: Option<&str>, keys: Option<&[String]>, message_id: Option<&str>, cx: &mut Context<Self>) {
        self.waiting_notifications.retain(|waiting| {
            let payload = &waiting.payload;
            !(server_id.is_none_or(|id| payload.server_id == id) && keys.is_none_or(|keys| keys.contains(&payload.key)) && message_id.is_none_or(|id| payload.message_id == id))
        });
        self.show_waiting(cx);
        if let Some(center) = crate::ui::notifications::center(cx) {
            center.update(cx, |center, cx| center.clear(server_id, keys, message_id, cx));
        }
    }

    /// A reply typed into a notification: it reads the chat, and answers the message in a group (sendNotificationReply).
    pub fn send_notification_reply(&mut self, server_id: &str, key: &str, message_id: &str, text: &str, cx: &mut Context<Self>) {
        let Some(server) = self.servers.get(server_id) else { return };
        let Some(conversation) = server.find_conversation(key).cloned() else { return };
        let value = text.trim().to_string();
        if value.is_empty() {
            return;
        }
        let mentions = crate::markup::mentions_in(&value, &server.mentionable);
        let emotes: serde_json::Map<String, Value> = value
            .split_whitespace()
            .filter_map(|word| {
                server
                    .emotes
                    .emotes
                    .iter()
                    .find(|emote| emote.name == word)
                    .map(|emote| (word.to_string(), json!({ "id": emote.id, "animated": emote.animated, "zeroWidth": emote.zero_width, "owner": emote.owner })))
            })
            .collect();
        if let (Some(group), Some(newest)) = (&conversation.group_id, conversation.last_message.as_ref().and_then(|m| m.seq)) {
            self.call(Some(server_id), "markRead", vec![json!(group), json!(newest)], cx, |_, _, _| {});
        }
        let mut body = json!({ "text": value, "emotes": emotes, "mentions": mentions });
        if conversation.kind != "dm" {
            body["replyTo"] = json!(message_id);
        }
        self.call(Some(server_id), "sendMessage", vec![json!(key), body], cx, |state, result, cx| {
            if let Err(error) = result {
                state.toast(error.message, ToastKind::Error, cx);
            }
        });
    }

    /// Whether the window is in front: focused, and on screen, as GPUI can still think a minimized
    /// window focused. Only then does a chat open in it count as seen, or the person as here.
    pub fn window_in_front(&self) -> bool {
        self.window_focused && crate::platform::main_visible()
    }

    /// Tells the core whether the person is here, much as Telegram counts it: the window in front
    /// and input in the last 5 s (`AWAY_AFTER_MS`). While they are, they show as online, and their
    /// other devices hold notifications back (activity.ts).
    fn watch_activity(&mut self, cx: &mut Context<Self>) {
        if self._activity.is_some() {
            return;
        }
        self._activity = Some(cx.spawn(async move |this, cx| {
            loop {
                let alive = this
                    .update(cx, |state, cx| {
                        let here = state.window_in_front() && crate::platform::idle_ms() < crate::platform::AWAY_AFTER_MS;
                        if state.reported_active != Some(here) {
                            state.reported_active = Some(here);
                            state.call(None, "setActive", vec![json!(here)], cx, |_, _, _| {});
                        }
                    })
                    .is_ok();
                if !alive {
                    break;
                }
                cx.background_executor().timer(Duration::from_secs(5)).await;
            }
        }));
    }

    // --- Pictures ---

    fn store_picture(&mut self, key: String, result: Result<(Vec<u8>, String), String>, cx: &mut Context<Self>) {
        let picture = match result {
            Ok((bytes, mime)) if !bytes.is_empty() => Picture::Ready(Arc::new(Image::from_bytes(image_format(&mime, &bytes), bytes))),
            _ => Picture::Failed,
        };
        self.touch_media(&key);
        self.pictures.insert(key, picture);
        self.trim_media();
        self.show_waiting(cx);
        cx.notify();
    }

    /// Something a server serves openly, such as its icon or an emote, by address.
    pub fn remote_picture(&mut self, url: &str, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        match self.pictures.get(url) {
            Some(Picture::Ready(image)) => {
                let image = image.clone();
                self.touch_media(url);
                return Some(image);
            }
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
            Some(Picture::Ready(image)) => {
                let image = image.clone();
                self.touch_media(&key);
                return Some(image);
            }
            Some(_) => return None,
            None => {}
        }
        self.pictures.insert(key.clone(), Picture::Loading);
        let reference = serde_json::to_value(avatar).unwrap_or_default();
        let mime = avatar.mime.clone();
        self.call(Some(server_id), "downloadFile", vec![reference], cx, move |state, result, cx| {
            let bytes = result.map_err(|error| error.message).and_then(|value| host::value_bytes(&value).ok_or_else(|| "no picture".to_string()));
            state.store_picture(key, bytes.map(|bytes| (bytes, mime)), cx);
        });
        None
    }

    // --- Sound and video ---

    /// A media file decrypted to disk, with the extension Media Foundation needs, asked for once.
    pub fn media_file(&mut self, server_id: &str, attachment: &crate::models::Attachment, cx: &mut Context<Self>) -> MediaFile {
        if let Some(file) = self.media_files.get(&attachment.file_id) {
            return file.clone();
        }
        self.media_files.insert(attachment.file_id.clone(), MediaFile::Loading);
        let reference = serde_json::json!({ "fileId": attachment.file_id, "key": attachment.key, "prefix": attachment.prefix, "chunks": attachment.chunks, "mime": attachment.mime });
        let id = attachment.file_id.clone();
        let extension = media_extension(&attachment.mime, &attachment.name);
        self.call(Some(server_id), "downloadFile", vec![reference], cx, move |state, result, cx| {
            let target = host::cache_dir().join("media").join(format!("{id}.{extension}"));
            let written = result.map_err(|error| error.message).and_then(|value| {
                std::fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
                // Moved rather than copied, so there's one decrypted copy, under the name Media Foundation needs.
                host::save_value(&value, &target, true)
            });
            let ready = written.is_ok();
            state.touch_media(&id);
            state.media_files.insert(id.clone(), if ready { MediaFile::Ready(target) } else { MediaFile::Failed });
            if ready {
                state.media_arrived(&id, cx);
            }
            state.trim_media();
            cx.notify();
        });
        MediaFile::Loading
    }

    /// A file's sound, decoded away from the window once the file is here.
    pub fn clip(&mut self, server_id: &str, attachment: &crate::models::Attachment, cx: &mut Context<Self>) -> ClipState {
        if let Some(clip) = self.clips.get(&attachment.file_id) {
            if !matches!(clip, ClipState::Loading) || self.media_files.contains_key(&attachment.file_id) {
                return clip.clone();
            }
        }
        self.clips.insert(attachment.file_id.clone(), ClipState::Loading);
        match self.media_file(server_id, attachment, cx) {
            MediaFile::Ready(path) => self.decode_clip(attachment.file_id.clone(), path, cx),
            MediaFile::Failed => {
                self.clips.insert(attachment.file_id.clone(), ClipState::Failed);
            }
            MediaFile::Loading => {}
        }
        self.clips.get(&attachment.file_id).cloned().unwrap_or(ClipState::Loading)
    }

    fn decode_clip(&mut self, id: String, path: std::path::PathBuf, cx: &mut Context<Self>) {
        self.clips.insert(id.clone(), ClipState::Loading);
        cx.spawn(async move |state, cx| {
            let decoded = cx
                .background_executor()
                .spawn(async move {
                    crate::media::mf::decode_audio(&path)
                        .inspect_err(|error| log::warn!("a sound couldn't be decoded: {error}"))
                        .ok()
                        .map(|(samples, rate)| crate::media::player::Clip::from_floats(&samples, rate))
                })
                .await;
            state
                .update(cx, |state, cx| {
                    match decoded {
                        Some(clip) => {
                            state.touch_media(&id);
                            state.clips.insert(id.clone(), ClipState::Ready(clip.clone()));
                            state.trim_media();
                            // Pressed before it was ready: it starts now.
                            if let Some((key, from)) = state.play_when_ready.clone().filter(|(key, _)| *key == id) {
                                state.play_when_ready = None;
                                crate::media::player::play(&key, &clip, from);
                                state.tick_media(cx);
                            }
                            if let Some(player) = state.videos.get(&id).cloned() {
                                player.update(cx, |player, cx| player.set_clip(clip, cx));
                            }
                        }
                        None => {
                            state.clips.insert(id.clone(), ClipState::Failed);
                        }
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    /// What waits on a media file once it's on disk: its sound, or its player.
    fn media_arrived(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(MediaFile::Ready(path)) = self.media_files.get(id).cloned() else { return };
        if matches!(self.clips.get(id), Some(ClipState::Loading)) {
            self.decode_clip(id.to_string(), path.clone(), cx);
        }
        if let Some((round, duration)) = self.videos_wanted.remove(id) {
            let clip = match self.clips.get(id) {
                Some(ClipState::Ready(clip)) => Some(clip.clone()),
                _ => None,
            };
            let key = id.to_string();
            let player = cx.new(|cx| crate::ui::media_views::VideoPlayer::new(key, path.clone(), round, duration, clip, cx));
            self.touch_media(id);
            self.videos.insert(id.to_string(), player);
            self.trim_media();
            if !matches!(self.clips.get(id), Some(ClipState::Ready(_))) {
                self.decode_clip(id.to_string(), path, cx);
            }
        }
    }

    /// Starts a video where it's shown, once its file is here.
    pub fn open_video(&mut self, server_id: &str, attachment: &crate::models::Attachment, round: bool, cx: &mut Context<Self>) {
        if self.videos.contains_key(&attachment.file_id) {
            return;
        }
        self.videos_wanted.insert(attachment.file_id.clone(), (round, attachment.duration.unwrap_or(0.)));
        if let MediaFile::Ready(_) = self.media_file(server_id, attachment, cx) {
            self.media_arrived(&attachment.file_id.clone(), cx);
        }
    }

    /// Draws the chat again while something plays, so its time and waveform move. It ticks
    /// `media_clock`, which only the chat watches, rather than waking every view of the app.
    pub fn tick_media(&mut self, cx: &mut Context<Self>) {
        if self.media_tick.is_some() {
            return;
        }
        self.media_tick = Some(cx.spawn(async move |state, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
            let going = state
                .update(cx, |state, cx| {
                    state.media_clock.update(cx, |_, cx| cx.notify());
                    let going = crate::media::player::current().is_some();
                    if !going {
                        state.media_tick = None;
                    }
                    going
                })
                .unwrap_or(false);
            if !going {
                break;
            }
        }));
    }

    pub fn emote_url(&self, server_url: &str, id: &str) -> String {
        format!("{server_url}/api/emotes/{id}/2x.webp")
    }
}

impl AppState {
    /// Notes that a picture, sound, video or media file is being shown, so it's the last to go.
    pub fn touch_media(&self, key: &str) {
        let count = self.media_count.get() + 1;
        self.media_count.set(count);
        let mut used = self.media_used.borrow_mut();
        match used.get_mut(key) {
            Some(at) => *at = count,
            None => {
                used.insert(key.to_string(), count);
            }
        }
    }

    /// Lets the least recently shown pictures, sounds, video players and media files go while
    /// their caches are over the limits, down to three quarters of each, so it isn't done again
    /// at once. Whatever is playing stays, as does a media file with a player, and anything
    /// still loading.
    fn trim_media(&mut self) {
        let playing = crate::media::player::current();
        let used = self.media_used.borrow().clone();
        let last_shown = |key: &str| used.get(key).copied().unwrap_or(0);
        let oldest_first = |mut keys: Vec<(String, usize)>| {
            keys.sort_by_key(|(key, _)| last_shown(key));
            keys
        };

        let pictures: Vec<(String, usize)> = self
            .pictures
            .iter()
            .filter_map(|(key, picture)| match picture {
                Picture::Ready(image) => Some((key.clone(), image.bytes().len())),
                _ => None,
            })
            .collect();
        let mut total: usize = pictures.iter().map(|(_, size)| size).sum();
        if total > PICTURE_BYTES {
            for (key, size) in oldest_first(pictures) {
                if total <= PICTURE_BYTES / 4 * 3 {
                    break;
                }
                self.pictures.remove(&key);
                total -= size;
            }
        }

        let clips: Vec<(String, usize)> = self
            .clips
            .iter()
            .filter_map(|(key, clip)| match clip {
                ClipState::Ready(clip) if playing.as_deref() != Some(key.as_str()) => Some((key.clone(), clip.samples.len() * 2)),
                _ => None,
            })
            .collect();
        let mut total: usize = clips.iter().map(|(_, size)| size).sum();
        if total > CLIP_BYTES {
            for (key, size) in oldest_first(clips) {
                if total <= CLIP_BYTES / 4 * 3 {
                    break;
                }
                self.clips.remove(&key);
                total -= size;
            }
        }

        if self.videos.len() > VIDEOS_KEPT {
            let videos: Vec<(String, usize)> = self.videos.keys().filter(|key| playing.as_deref() != Some(key.as_str())).map(|key| (key.clone(), 1)).collect();
            let excess = self.videos.len() - VIDEOS_KEPT / 4 * 3;
            for (key, _) in oldest_first(videos).into_iter().take(excess) {
                self.videos.remove(&key);
            }
        }

        if self.media_files.len() > MEDIA_FILES_KEPT {
            let files: Vec<(String, usize)> = self
                .media_files
                .iter()
                .filter(|(key, file)| !matches!(file, MediaFile::Loading) && playing.as_deref() != Some(key.as_str()) && !self.videos.contains_key(*key))
                .map(|(key, _)| (key.clone(), 1))
                .collect();
            let excess = self.media_files.len() - MEDIA_FILES_KEPT / 4 * 3;
            for (key, _) in oldest_first(files).into_iter().take(excess) {
                // The decrypted copy on disk goes with it.
                if let Some(MediaFile::Ready(path)) = self.media_files.remove(&key) {
                    std::fs::remove_file(path).ok();
                }
            }
        }

        let mut used = self.media_used.borrow_mut();
        used.retain(|key, _| self.pictures.contains_key(key) || self.clips.contains_key(key) || self.videos.contains_key(key) || self.media_files.contains_key(key));
    }
}

/// What `tick_media` notifies while something plays.
pub struct MediaClock;

/// The extension a media file needs for Windows to read it.
fn media_extension(mime: &str, name: &str) -> String {
    let known = match mime {
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => "m4a",
        "video/mp4" => "mp4",
        "audio/webm" | "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/flac" => "flac",
        "video/quicktime" => "mov",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    std::path::Path::new(name).extension().map(|extension| extension.to_string_lossy().to_lowercase()).filter(|extension| extension.len() <= 5).unwrap_or_else(|| "bin".into())
}

/// Takes notifications back: those matching everything given.
async fn load_server(core: &Core, entry: ServerEntry) -> ServerState {
    let id = entry.id.clone();
    let get = |method: &'static str| core.call(Some(&id), method, vec![]);
    let (conversations, users, emotes, prefs, me, connection, info, channels, voice, calls, sounds) = futures::join!(
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
        get("getSounds"),
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
        sounds: sounds.map(from_value).unwrap_or_default(),
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
