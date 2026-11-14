//! All UI state, kept in sync with the core through its events, as the web's
//! zustand store (packages/ui/src/state/store.ts) keeps it.

mod events;
mod lists;
mod notify;
mod media;
pub use media::checked_download;
mod telegram;

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
    /// Devices that signed in to this account after this one, which the person has to answer for.
    pub new_devices: Vec<NewDevice>,
}

impl ServerState {
    pub fn self_id(&self) -> &str {
        self.me.as_ref().map(|me| me.user_id.as_str()).unwrap_or("")
    }

    pub fn is_admin(&self) -> bool {
        self.me.as_ref().is_some_and(|me| me.role == "owner" || me.role == "admin")
    }

    /// Whether this person may add someone to a group, which only a bot may say no to: its owner
    /// always may, and for a listed bot whoever its owner chose (`mayAddBot`). The server holds
    /// everyone to it, and the bot itself does too.
    pub fn may_add(&self, user: &UserView) -> bool {
        let Some(bot) = &user.bot else { return true };
        bot.owner_id == self.self_id() || (bot.listed && (bot.add == "anyone" || (bot.add == "admins" && self.is_admin())))
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
    /// Such a window has messages after its newest, so it reads on rather than taking new ones.
    pub has_newer: bool,
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
    /// Asking before coming into voice here takes another of this person's devices out of it.
    MoveVoice(crate::voice::VoiceMove),
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
    /// Asking before an update restarts the app in the middle of a call.
    InstallUpdate,
    /// Asking before this device first contacts YouTube, for a video its room watches together,
    /// and then asking for a link to put on, or watching what's on.
    WatchConsent { then_link: bool },
    /// A YouTube link to put on for everyone in the room.
    WatchLink,
    /// The SOCKS5 proxy everything this device sends goes through, from Settings, which it
    /// goes back to, or from the first screen.
    Proxy { from_settings: bool },
    /// A plugin's dialog, in a frame the app draws, by the number the plugins know it by.
    Plugin(u32),
    /// Linking a Telegram account: what it is, then a QR code or a phone number.
    Telegram,
    /// Joining a Telegram group by a link to it.
    TelegramJoin,
    /// Asking before a plugin is installed or updated: what it can do, and for one Zuna hasn't
    /// checked, the warning. The package waits in the plugins' state.
    PluginInstall { id: u64 },
}

/// Goes through the proxy the settings have, if that's a change: what's open ends and opens
/// again the new way, and a call ends.
pub fn apply_proxy(state: &gpui::Entity<AppState>, cx: &mut gpui::App) {
    let proxy = state.read(cx).settings.proxy.in_use();
    if !crate::host::net::set(proxy) {
        return;
    }
    if let Some(voice) = crate::voice::get(cx) {
        voice.update(cx, |voice, cx| {
            if voice.status != crate::voice::VoiceStatus::Idle {
                voice.leave(cx);
            }
            voice.set_watching(false, cx);
        });
    }
    state.read(cx).core.network_changed();
    cx.refresh_windows();
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
    /// A plugin's panel, by the number the plugins know it by.
    Plugin(u32),
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

/// A picture the interface shows, fetched or decrypted once and kept. One that failed is tried
/// again once `PICTURE_RETRY` has passed, so a moment without the network doesn't last the run.
#[derive(Clone)]
pub enum Picture {
    Loading,
    Ready(Arc<Image>),
    Failed(std::time::Instant),
}

const PICTURE_RETRY: Duration = Duration::from_secs(60);

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
    /// A plugin's page over the main area, opened from its item in the rail.
    pub plugin_page: Option<u32>,
    /// Text plugins put in the message box, for the open chat to take.
    pub composer_inserts: Vec<String>,
    pub toasts: Vec<Toast>,
    /// The new device being answered for, while the core removes it or forgets it.
    pub answering_device: Option<String>,
    /// A new device the person said wasn't them was removed: on which server, and the secret
    /// it signed in with, which they're asked to change next.
    pub device_removed: Option<(String, Option<String>)>,
    /// Where linking a Telegram account stands, while it's being linked or unlinked (docs/TELEGRAM_PLAN.md).
    pub telegram_link: Option<TelegramLink>,
    pub settings: Settings,
    pub window_focused: bool,
    /// When the window last came in front, which counts as input (`person_here`), as Telegram
    /// counts the app being activated.
    pub in_front_since: Option<std::time::Instant>,
    /// When the person last pressed a key, clicked or scrolled in the main window.
    pub last_input: Option<std::time::Instant>,
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
    videos_wanted: HashMap<String, (bool, f64, crate::ui::media_views::VideoSource)>,
    pub paused_at: HashMap<String, f64>,
    pub play_when_ready: Option<(String, f64, f64)>,
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
    /// Whether the core was last told this person is here (activity.ts), and on which server.
    reported_active: Option<(bool, Option<String>)>,
    _events: Option<Task<()>>,
    _activity: Option<Task<()>>,
}

/// How a picture is decoded: by its own first bytes where they say, as the type a file is given
/// can be wrong (a photo sent to Telegram stays here as it was sent, though Telegram calls every
/// photo a JPEG), and by that type where they don't, as for SVG.
pub fn image_format(mime: &str, bytes: &[u8]) -> ImageFormat {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => ImageFormat::Png,
        [b'G', b'I', b'F', b'8', ..] => ImageFormat::Gif,
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ImageFormat::Webp,
        [0xff, 0xd8, 0xff, ..] => ImageFormat::Jpeg,
        _ => match mime {
            "image/png" => ImageFormat::Png,
            "image/gif" => ImageFormat::Gif,
            "image/webp" => ImageFormat::Webp,
            "image/svg+xml" => ImageFormat::Svg,
            "image/bmp" => ImageFormat::Bmp,
            _ => ImageFormat::Jpeg,
        },
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;

    #[test]
    fn a_picture_is_decoded_as_what_its_bytes_say() {
        assert_eq!(image_format("image/jpeg", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a]), ImageFormat::Png);
        assert_eq!(image_format("image/png", &[0xff, 0xd8, 0xff, 0xe0]), ImageFormat::Jpeg);
        assert_eq!(image_format("image/jpeg", b"RIFF\0\0\0\0WEBPVP8 "), ImageFormat::Webp);
        assert_eq!(image_format("image/svg+xml", b"<svg xmlns"), ImageFormat::Svg);
        assert_eq!(image_format("", b"GIF89a"), ImageFormat::Gif);
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
        // The title bar's Update button and Settings follow what the updater finds.
        let mut updates = crate::platform::updates::changes();
        cx.spawn(async move |this, cx| {
            use futures::StreamExt;
            while updates.next().await.is_some() {
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        // Quitting shows the person offline at once, rather than after the server's linger for a
        // connection lost, as Telegram's desktop app says so before it quits (`Updates::isQuitPrevent`):
        // the core says so as it stops, and the frame gets a moment to go, within GPUI's 200 ms.
        cx.on_app_quit(|state, cx| {
            let stopping = state.core.call(None, "stop", vec![]);
            let flushed = cx.background_executor().timer(std::time::Duration::from_millis(150));
            async move {
                let _ = stopping.await;
                flushed.await;
            }
        })
        .detach();
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
            plugin_page: None,
            composer_inserts: Vec::new(),
            toasts: Vec::new(),
            answering_device: None,
            device_removed: None,
            telegram_link: None,
            settings,
            window_focused: false,
            in_front_since: None,
            last_input: None,
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

    /// The person says whether a new device of their account on a server was them. If it
    /// wasn't, the core removes it, and they're asked to change the secret it signed in with.
    pub fn answer_new_device(&mut self, server_id: &str, device_id: &str, mine: bool, cx: &mut Context<Self>) {
        if self.answering_device.is_some() {
            return;
        }
        self.answering_device = Some(device_id.to_string());
        let secret = self.servers.get(server_id).and_then(|server| server.new_devices.iter().find(|device| device.id == device_id)).and_then(|device| device.secret.clone());
        let (server, device) = (server_id.to_string(), device_id.to_string());
        self.call(Some(server_id), "answerNewDevice", vec![json!(device_id), json!(mine)], cx, move |state, result, cx| {
            state.answering_device = None;
            match result {
                Ok(_) => {
                    if let Some(entry) = state.servers.get_mut(&server) {
                        entry.new_devices.retain(|item| item.id != device);
                    }
                    if !mine {
                        state.device_removed = Some((server, secret));
                    }
                }
                Err(error) => state.toast(error.message, ToastKind::Error, cx),
            }
            cx.notify();
        });
        cx.notify();
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
            // All at once, not one after another, so each server joined adds nothing to the wait.
            let loaded = futures::future::join_all(entries.iter().map(|entry| load_server(&core, entry.clone()))).await;
            this.update(cx, |state, _| {
                for (entry, server) in entries.iter().zip(loaded) {
                    state.servers.insert(entry.id.clone(), server);
                }
            })
            .ok();
            this.update(cx, |state, cx| {
                state.order = entries.iter().map(|entry| entry.id.clone()).collect();
                // Where the person was when the app last ran, if it's still here.
                let last = state.settings.last_server.clone().filter(|id| state.order.contains(id));
                state.active_server = last.or_else(|| entries.first().map(|entry| entry.id.clone()));
                state.phase = Phase::Ready;
                state.watch_activity(cx);
                state.update_badge(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A server joined or signed in to, which takes the place of any earlier account on it, and is
    /// shown where `joined` says the person just did that. One that only comes in as the app
    /// starts, as the linked Telegram account does once its engine is ready, is shown only where
    /// it's the one shown when the app last ran and no chat is open yet.
    pub fn add_server(&mut self, server_id: String, joined: bool, cx: &mut Context<Self>) {
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
                let remembered = state.settings.last_server.as_deref() == Some(server_id.as_str()) && state.active().is_none_or(|server| server.active_key.is_none());
                if joined || remembered || state.active().is_none() {
                    state.active_server = Some(server_id.clone());
                    state.remember_server();
                }
                if joined {
                    state.overlay = None;
                }
                state.refresh_conversations(&server_id, cx);
                state.refresh_users(&server_id, cx);
                state.report_activity(cx);
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
            self.remember_server();
        }
        self.panel = None;
        self.overlay = None;
        self.report_activity(cx);
        cx.notify();
    }

    pub fn select_server(&mut self, server_id: &str, cx: &mut Context<Self>) {
        let leaving = self.active_server.clone().filter(|id| id != server_id).and_then(|id| Some((id.clone(), self.servers.get(&id)?.active_key.clone()?)));
        self.active_server = Some(server_id.to_string());
        self.remember_server();
        self.panel = None;
        self.plugin_page = None;
        if let Some((id, key)) = leaving {
            self.close_list(&id, &key);
        }
        // Online on the server now shown, and no longer on the one left.
        self.report_activity(cx);
        cx.notify();
    }

    /// Keeps the server shown, for the app to open on when it's started again.
    fn remember_server(&mut self) {
        if self.settings.last_server != self.active_server {
            self.settings.last_server = self.active_server.clone();
            self.settings.save();
        }
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
        self.plugin_page = None;
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

    pub fn set_overlay(&mut self, overlay: Option<Overlay>, cx: &mut Context<Self>) {
        // Each dialog opens at its top, not where the last one was scrolled.
        if overlay.is_some() && overlay != self.overlay {
            for name in ["modal-body", "modal-flow", "new-group-people", "forward-list", "add-people"] {
                crate::ui::scrollbar::forget_scroll(name);
            }
        }
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
        self.refresh_theme(cx);
        cx.notify();
    }

    /// The colors for the accent and text size chosen, under a plugin's theme if one is chosen and its plugin is on.
    pub fn refresh_theme(&mut self, cx: &mut Context<Self>) {
        let mut theme = Theme::new(self.settings.accent, self.settings.message_size);
        if let (Some(key), Some(plugins)) = (self.settings.theme.as_deref(), crate::plugins::get(cx)) {
            if let Some(colors) = plugins.read(cx).theme_colors(key) {
                theme.apply(&colors);
            }
        }
        cx.set_global(theme);
        cx.refresh_windows();
    }

    // --- Plugins ---

    /// Calls a method of a server's session once plugins' filters of a kind let it, at once when
    /// none has one: typing and read marks, which a plugin with `activity.intercept` may keep from
    /// going. A failure shows as a toast.
    pub fn act_filtered(&mut self, server_id: &str, kind: crate::plugins::FilterKind, payload: Value, method: &'static str, args: Vec<Value>, cx: &mut Context<Self>) {
        let server = server_id.to_string();
        let go = move |state: &mut AppState, cx: &mut Context<AppState>| {
            state.call(Some(&server), method, args, cx, |state, result, cx| {
                if let Err(error) = result {
                    state.toast(error.message, ToastKind::Error, cx);
                }
            })
        };
        match crate::plugins::filter(kind, payload, cx) {
            None => go(self, cx),
            Some(task) => cx
                .spawn(async move |this, cx| {
                    if let crate::plugins::Verdict::Go(_) = task.await {
                        this.update(cx, |state, cx| go(state, cx)).ok();
                    }
                })
                .detach(),
        }
    }

    /// Opens a plugin's panel, page or dialog, by the number the plugins know it by.
    pub fn open_plugin_view(&mut self, kind: &str, handle: u32, cx: &mut Context<Self>) {
        match kind {
            "panel" => self.panel = Some(Panel::Plugin(handle)),
            "page" => self.plugin_page = Some(handle),
            "dialog" => self.set_overlay(Some(Overlay::Plugin(handle)), cx),
            _ => {}
        }
        cx.notify();
    }

    /// Closes whatever of these a plugin has open, as it stops or asks to.
    pub fn close_plugin_views(&mut self, handles: &[u32], cx: &mut Context<Self>) {
        if matches!(self.panel, Some(Panel::Plugin(handle)) if handles.contains(&handle)) {
            self.panel = None;
        }
        if self.plugin_page.is_some_and(|handle| handles.contains(&handle)) {
            self.plugin_page = None;
        }
        if matches!(self.overlay, Some(Overlay::Plugin(handle)) if handles.contains(&handle)) {
            self.overlay = None;
        }
        cx.notify();
    }

    /// Text a plugin puts in the message box, where the cursor is, in the open chat.
    pub fn insert_into_composer(&mut self, text: String, cx: &mut Context<Self>) {
        self.composer_inserts.push(text);
        cx.notify();
    }

    /// A notification of a plugin's own, under its name.
    pub fn show_plugin_notification(&mut self, name: &str, title: String, body: String, cx: &mut Context<Self>) {
        if !self.settings.notifications {
            return;
        }
        if self.window_focused {
            self.toast(format!("{name}: {title}{}{body}", if body.is_empty() { "" } else { " — " }), ToastKind::Info, cx);
            return;
        }
        let system = crate::platform::notification_state();
        if !system.show {
            return;
        }
        let payload = crate::ui::notifications::Payload {
            title: format!("{name}: {title}"),
            body,
            server_id: String::new(),
            key: String::new(),
            message_id: String::new(),
            kind: "plugin".into(),
            picture: None,
            can_reply: false,
            wait_for_input: system.wait_for_input,
        };
        self.show_notification(payload, "", None, cx);
    }

    // --- Notifications, the badge and activity ---

    /// The unread count across servers, on the taskbar and the tray (updateBadge).
    pub fn update_badge(&self, cx: &App) {
        let total: u32 = self.servers.values().map(ServerState::unread).sum();
        crate::platform::later(cx, move || crate::platform::icons::set_unread(total));
    }

}

/// What `tick_media` notifies while something plays.
pub struct MediaClock;

/// Everything the interface keeps about a server, read from its session at start and when
/// one is added. What fails to load is left empty, for the next event to fill in.
async fn load_server(core: &Core, entry: ServerEntry) -> ServerState {
    let id = entry.id.clone();
    let get = |method: &'static str| core.call(Some(&id), method, vec![]);
    let (conversations, users, emotes, prefs, me, connection, info, channels, voice, calls, sounds, new_devices) = futures::join!(
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
        get("getNewDevices"),
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
        new_devices: new_devices.map(from_value).unwrap_or_default(),
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

/// The state's entity, if the app has made it yet.
pub fn try_store(cx: &App) -> Option<Entity<AppState>> {
    cx.try_global::<Store>().map(|store| store.0.clone())
}
