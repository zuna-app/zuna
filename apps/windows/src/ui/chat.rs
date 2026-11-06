//! A conversation: its header, messages and message box
//! (packages/ui/src/features/chat/ChatView.tsx, MessageList.tsx and Composer.tsx).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use std::path::PathBuf;
use std::sync::LazyLock;

use gpui::{
    AnyElement, Context, Entity, ExternalPaths, FontWeight, Image, IntoElement, ListAlignment, ListState, MouseButton, ParentElement, Render, SharedString,
    Styled, Subscription, Task, Window, div, img, prelude::*, px,
};
use regex::Regex;
use serde_json::json;

use super::components::*;
use super::motion::{Enter, Motion};
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::message::{ChatContext, render_row};
use super::side_panel::SidePanel;
use super::text_input::{InputEvent, TextInput};
use crate::format::{format_bytes, format_last_seen, now_ms, timer_text, wait_text};
use crate::markup::{find_link, mentions_in, plain_text};
use crate::models::{ConversationView, Emote, LinkPreview, MessageView, UserView};
use crate::state::{AppState, Panel, Picture, ToastKind, is_unread};
use crate::theme::{self, RADIUS_M, RADIUS_S};

const MAX_TEXT_LENGTH: usize = 4000;
const MAX_FILES: usize = 10;
const MAX_SUGGESTIONS: usize = 8;
/// How long typing pauses before a link's page is fetched.
const PREVIEW_DELAY_MS: u64 = 400;

/// A file waiting to go with the next message: what the core is given, and its chip.
#[derive(Clone)]
struct StagedFile {
    file: serde_json::Value,
    name: String,
    size: u64,
    preview: Option<Arc<Image>>,
}

#[derive(Clone)]
enum Suggested {
    Emote(Emote),
    Person(UserView),
}

/// One line of autocomplete: ":name" for the server's emotes, "@name" for people.
#[derive(Clone)]
struct Suggestion {
    key: String,
    label: String,
    hint: Option<String>,
    insert: String,
    what: Suggested,
}

/// A drag across messages that picks them: where it began, what was picked before, and
/// whether it lets go of them instead.
struct DragPick {
    start: String,
    base: Vec<String>,
    let_go: bool,
    dragging: bool,
    y: gpui::Pixels,
}

/// A voice or video message being recorded.
enum Recording {
    Voice(crate::media::record::Microphone),
    Round(crate::media::record::RoundRecorder),
}

/// Voice messages longer than this are sent when they reach it.
const MAX_VOICE_SECONDS: f64 = 15. * 60.;

/// The first link's preview, made on this device once typing pauses.
struct LinkDraft {
    url: String,
    preview: Option<LinkPreview>,
    loading: bool,
}

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
    /// The conversation someone's typed in since it was opened, after which its header's
    /// line fades between typing and the usual status, as `.chat-status.is-changing`.
    typed_in: RefCell<Option<String>>,
    /// Messages that arrived at the end while the chat was open, and when, which fade in as
    /// `.msg.is-fresh` does, for 400 ms.
    fresh: Rc<RefCell<HashMap<String, std::time::Instant>>>,
    /// The list moving to messages that arrived while it was at the newest, from where it
    /// was, as the desktop's list glides over 180 ms instead of jumping.
    glide: Option<(f32, std::time::Instant)>,
    /// The call this device is in, above the chat of its conversation.
    call_stage: Option<Entity<super::voice_stage::VoiceStage>>,
    last_list_id: String,
    files: Vec<StagedFile>,
    /// What's being completed: ':' or '@', what's typed after it, and where it starts.
    trigger: Option<(char, String, usize)>,
    suggestions: Vec<Suggestion>,
    /// The suggestion Enter would pick, or none until two letters follow a ':', as in ":D".
    selected: Option<usize>,
    link_draft: Option<LinkDraft>,
    /// The link whose preview is being made or shown.
    link_wanted: Option<String>,
    dismissed_link: Option<String>,
    link_task: Option<Task<()>>,
    /// When the message just sent here lets the next go in slow mode, before the core says.
    sent_until: f64,
    slow_tick: Option<Task<()>>,
    /// Whether messages were being picked when last drawn: rows change width when it changes.
    was_selecting: bool,
    /// Holds focus while messages are picked, so Escape stops picking.
    focus: gpui::FocusHandle,
    inline_editor: Entity<TextInput>,
    /// The channel message being edited where it is.
    inline_editing: Option<String>,
    /// The rows on screen, and a drag picking messages across them.
    visible: std::ops::Range<usize>,
    row_bounds: Rc<RefCell<HashMap<usize, gpui::Bounds<gpui::Pixels>>>>,
    drag: Option<DragPick>,
    drag_tick: Option<Task<()>>,
    recording: Option<Recording>,
    recording_tick: Option<Task<()>>,
    preview_frame: Option<Arc<gpui::RenderImage>>,
    retired_frames: Vec<Arc<gpui::RenderImage>>,
    /// Unread messages here that mention you or reply to you, oldest first, and what they were asked for.
    mentions: Vec<(String, f64)>,
    mentions_asked: Option<(f64, f64)>,
    /// The messages, drawn as a view of their own that keeps last frame's drawing unless
    /// `refresh_messages` asks for a new one. So typing, the caret's blink, the message
    /// box's suggestions and anything else above or below the messages don't draw every
    /// message on screen again.
    messages: Entity<MessageList>,
    /// The messages and what their rows need, from the last time the chat's state changed.
    context_cache: Option<(Rc<Vec<MessageView>>, Rc<ChatContext>)>,
    /// A channel's member list, once it's been shown.
    member_view: Option<Entity<MemberList>>,
    /// Where the messages placed their videos, which are drawn above them.
    video_slots: super::media_views::VideoSlots,
    _subscriptions: Vec<Subscription>,
}

/// What the message body needs to know of the list, without copying its messages.
struct ListShape {
    loaded: bool,
    empty: bool,
    detached: bool,
}

/// The chat's messages, which `ChatView` draws for it (`render_body`).
pub struct MessageList {
    chat: gpui::WeakEntity<ChatView>,
}

impl Render for MessageList {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = self.chat.upgrade().map(|chat| chat.update(cx, |chat, cx| chat.render_body(window, cx)));
        // Laid out as a root in the box `ChatView` gives it, so it fills that box itself.
        div().size_full().flex().flex_col().children(body)
    }
}

/// A channel's members beside it: a view of its own, drawn again only when the server's
/// state changes rather than on every frame of the chat beside it, as it lists everyone.
pub struct MemberList {
    state: Entity<AppState>,
    server_id: String,
    _observe: Subscription,
}

impl MemberList {
    fn new(state: Entity<AppState>, server_id: String, cx: &mut Context<Self>) -> Self {
        let _observe = cx.observe(&state, |_, _, cx| cx.notify());
        MemberList { state, server_id, _observe }
    }
}

impl Render for MemberList {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        member_list(&self.state, &self.server_id, cx)
    }
}

fn member_list(state_entity: &Entity<AppState>, server_id: &str, cx: &mut gpui::App) -> AnyElement {
    let theme = theme(cx);
    let state = state_entity.read(cx);
    let Some(server) = state.servers.get(server_id) else { return div().into_any_element() };
    let mut users: Vec<UserView> = server.users.values().filter(|user| !user.banned).cloned().collect();
    users.sort_by_key(|user| user.display_name.to_lowercase());
    let (online, offline): (Vec<UserView>, Vec<UserView>) = users.into_iter().partition(|user| user.online || user.is_self);
    let server_id = server_id.to_string();
    let members_scroll = scroll_handle("member-list");
    let mut list = div().id("member-list").size_full().overflow_y_scroll().track_scroll(&members_scroll).pr(gutter(&members_scroll)).pb(px(20.)).bg(theme.bg1).border_l_1().border_color(theme.line);
    for (title, people, here) in [("Online", online, true), ("Offline", offline, false)] {
        if people.is_empty() {
            continue;
        }
        list = list.child(div().h(px(40.)).pt(px(24.)).pr(px(8.)).pl(px(16.)).text_size(px(12.)).line_height(px(16.)).font_weight(FontWeight::SEMIBOLD).text_color(theme::color(theme::hex(0x8b8b92))).child(format!("{} — {}", title.to_uppercase(), people.len())));
        for user in people {
            let image = user.avatar.as_ref().and_then(|avatar| state_entity.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx)));
            let (open_state, profile_id) = (state_entity.clone(), user.id.clone());
            let (menu_state, menu_id, is_self) = (state_entity.clone(), user.id.clone(), user.is_self);
            let group = SharedString::from(format!("member-item-{}", user.id));
            list = list.child(
                div()
                    .id(group.clone())
                    .group(group.clone())
                    .mx(px(8.))
                    .mt(px(1.))
                    .h(px(42.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .px(px(8.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .when(!here, |el| el.opacity(0.35))
                    .hover(move |style| style.bg(theme.hover_strong).opacity(1.))
                    .on_click(move |_, _, cx| open_state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Verify { user_id: profile_id.clone() }), cx)))
                    .on_mouse_down(MouseButton::Right, move |event, _, cx| {
                        let mut entries = Vec::new();
                        let (state, id) = (menu_state.clone(), menu_id.clone());
                        entries.push(super::menu::MenuEntry::new("Profile", "user-round", move |_, cx| state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Verify { user_id: id.clone() }), cx))));
                        if !is_self {
                            let (state, key) = (menu_state.clone(), format!("user:{}", menu_id));
                            entries.push(super::menu::MenuEntry::new("Message", "message-circle", move |_, cx| state.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx))));
                        }
                        super::menu::open_menu(event.position, entries, false, cx);
                    })
                    .child(avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 32., online: here && !user.is_self || user.online, rounded: false, dot_border: theme.bg1 }, cx))
                    .child(div().flex_none().max_w(px(if user.role == "owner" { 140. } else { 164. })).one_line().text_size(px(16.)).line_height(px(20.)).font_weight(FontWeight::MEDIUM).text_color(theme::css(crate::format::name_color(&user.id))).child(user.display_name.clone()))
                    .when(user.role == "owner", |el| el.child(div().id(SharedString::from(format!("crown-{}", user.id))).flex_none().ml(px(-6.)).tip("Server owner", Side::Bottom).child(icon("crown", 14., theme::color(theme::hex(0xf0b232)))))),
            );
        }
    }
    list.child(scrollbar("member-list", Scrolls::Div(members_scroll))).into_any_element()
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
            let mut input = TextInput::new(cx, "Message").multiline().accepts_files();
            input.set_newline_on_enter(false);
            input
        });
        let inline_editor = cx.new(|cx| TextInput::new(cx, "").multiline());
        let list = ListState::new(0, ListAlignment::Bottom, px(800.));
        let weak = cx.entity().downgrade();
        let messages = cx.new(|_| MessageList { chat: weak.clone() });
        list.set_scroll_handler(move |event, _window, cx| {
            let visible = event.visible_range.clone();
            let scrolled = event.is_scrolled;
            if let Some(view) = weak.upgrade() {
                view.update(cx, |view, cx| view.on_scroll(visible, scrolled, cx));
            }
        });
        let subscriptions = vec![
            cx.observe(&state, |view, _, cx| {
                view.context_cache = None;
                view.sync_rows(cx);
                view.refresh_messages(cx);
                cx.notify();
            }),
            cx.subscribe_in(&composer, window, |view, _, event, window, cx| view.on_composer(event, window, cx)),
            cx.subscribe_in(&inline_editor, window, |view, _, event, window, cx| view.on_inline_editor(event, window, cx)),
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
            typed_in: RefCell::new(None),
            fresh: Rc::new(RefCell::new(HashMap::new())),
            glide: None,
            call_stage: None,
            last_list_id: String::new(),
            files: Vec::new(),
            trigger: None,
            suggestions: Vec::new(),
            selected: None,
            link_draft: None,
            link_wanted: None,
            dismissed_link: None,
            link_task: None,
            sent_until: 0.,
            slow_tick: None,
            was_selecting: false,
            focus: cx.focus_handle(),
            inline_editor,
            inline_editing: None,
            visible: 0..0,
            row_bounds: Rc::new(RefCell::new(HashMap::new())),
            drag: None,
            drag_tick: None,
            recording: None,
            recording_tick: None,
            preview_frame: None,
            retired_frames: Vec::new(),
            mentions: Vec::new(),
            mentions_asked: None,
            messages,
            context_cache: None,
            member_view: None,
            video_slots: Default::default(),
            _subscriptions: subscriptions,
        };
        view.open(window, cx);
        view
    }

    /// Has the messages drawn again on the next frame, for a change in what they show.
    /// Never during a draw, when it would only take effect a frame late.
    fn refresh_messages(&self, cx: &mut Context<Self>) {
        self.messages.update(cx, |_, cx| cx.notify());
    }

    pub fn focus_composer(&self, window: &mut Window, cx: &gpui::App) {
        self.composer.read(cx).focus(window);
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
        let draft = self.state.read(cx).drafts.get(&conversation.key).cloned().unwrap_or_default();
        self.composer.update(cx, |input, cx| {
            input.set_newline_on_enter(!enter);
            input.set_placeholder(placeholder, cx);
            if !draft.is_empty() {
                input.set_text(draft, cx);
            }
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
            let added: Vec<String> = new_rows[old.len()..].iter().map(|(id, _)| id.clone()).collect();
            if !added.is_empty() {
                let now = std::time::Instant::now();
                {
                    let mut fresh = self.fresh.borrow_mut();
                    fresh.retain(|_, at| now - *at < std::time::Duration::from_millis(400));
                    for id in &added {
                        fresh.insert(id.clone(), now);
                    }
                }
                if self.at_bottom && !super::motion::reduced_or_system() {
                    // Held where it shows now, so the new rows come in below it, then moved to them.
                    if self.glide.is_none() {
                        let height = self.list.viewport_bounds().size.height;
                        self.list.scroll_by(-height);
                    }
                    let from = -f32::from(self.list.scroll_px_offset_for_scrollbar().y);
                    self.glide = Some((from, now));
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
            self.context_cache = None;
            self.refresh_messages(cx);
            cx.spawn(async move |view, cx| {
                cx.background_executor().timer(std::time::Duration::from_millis(1500)).await;
                view.update(cx, |view, cx| {
                    view.highlight = None;
                    view.context_cache = None;
                    view.refresh_messages(cx);
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    fn on_scroll(&mut self, visible: std::ops::Range<usize>, scrolled: bool, cx: &mut Context<Self>) {
        self.at_bottom = !scrolled;
        self.visible = visible.clone();
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
        self.refresh_messages(cx);
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
            InputEvent::Submit if self.recording.is_some() => self.send_recording(cx),
            InputEvent::Escape if self.recording.is_some() => self.cancel_recording(window, cx),
            InputEvent::Submit => {
                if let Some(index) = self.selected.filter(|_| !self.suggestions.is_empty()) {
                    self.apply_suggestion(index, cx);
                } else if !self.suggestions.is_empty() && !self.state.read(cx).settings.enter_to_send {
                    // Suggestions take Enter, but with none picked it still makes a new line.
                    self.composer.update(cx, |input, cx| input.insert("\n", window, cx));
                } else {
                    self.send(window, cx);
                }
            }
            InputEvent::Changed => {
                let Some(conversation) = self.conversation(cx) else { return };
                let text = self.composer.read(cx).text().to_string();
                let key = conversation.key.clone();
                self.state.update(cx, |state, _| {
                    if text.is_empty() {
                        state.drafts.remove(&key);
                    } else {
                        state.drafts.insert(key, text.clone());
                    }
                });
                if let Some(group) = conversation.group_id.clone() {
                    let now = now_ms();
                    if !text.is_empty() && now - self.last_typing > 3000. {
                        self.last_typing = now;
                        self.state.update(cx, |state, cx| state.act("sendTyping", vec![json!(group)], cx));
                    }
                }
                self.update_suggestions(&conversation, cx);
                self.update_link(&text, cx);
                cx.notify();
            }
            InputEvent::Escape => {
                let list_id = self.last_list_id.clone();
                let editing = self.state.read(cx).editing.contains_key(&list_id);
                self.state.update(cx, |state, cx| {
                    if editing {
                        state.set_editing(&list_id, None, cx);
                    } else if state.reply_to.contains_key(&list_id) {
                        state.set_reply(&list_id, None, cx);
                    } else if state.panel.is_some() {
                        state.panel = None;
                        cx.notify();
                    }
                });
                if editing {
                    self.composer.update(cx, |input, cx| input.set_text("", cx));
                }
            }
            InputEvent::Tab if !self.suggestions.is_empty() => {
                self.apply_suggestion(self.selected.unwrap_or(0), cx);
            }
            InputEvent::Down if !self.suggestions.is_empty() => {
                let count = self.suggestions.len();
                self.selected = Some(self.selected.map_or(0, |index| (index + 1) % count));
                cx.notify();
            }
            InputEvent::Up if !self.suggestions.is_empty() => {
                let count = self.suggestions.len();
                self.selected = Some(self.selected.map_or(count - 1, |index| (index + count - 1) % count));
                cx.notify();
            }
            InputEvent::Files(paths) => self.add_files(paths.clone(), cx),
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
                    let channel = self.conversation(cx).is_some_and(|c| c.kind == "channel");
                    self.state.update(cx, |state, cx| state.set_editing(&list_id, Some(message), cx));
                    if !channel {
                        self.composer.update(cx, |input, cx| input.set_text(text, cx));
                    }
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

    // --- Voice and video messages ---

    fn start_voice(&mut self, cx: &mut Context<Self>) {
        match crate::media::record::Microphone::start() {
            Ok(microphone) => {
                self.recording = Some(Recording::Voice(microphone));
                self.tick_recording(cx);
            }
            Err(error) => self.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx)),
        }
        cx.notify();
    }

    fn start_round(&mut self, cx: &mut Context<Self>) {
        let path = std::env::temp_dir().join("Zuna").join("media").join(format!("round-{}.mp4", now_ms() as u64));
        std::fs::create_dir_all(path.parent().unwrap()).ok();
        match crate::media::record::RoundRecorder::start(path) {
            Ok(recorder) => {
                self.recording = Some(Recording::Round(recorder));
                self.tick_recording(cx);
            }
            Err(error) => self.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx)),
        }
        cx.notify();
    }

    /// Draws the time and the bars as it records, and sends what reaches its limit.
    fn tick_recording(&mut self, cx: &mut Context<Self>) {
        self.recording_tick = Some(cx.spawn(async move |view, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
            let going = view
                .update(cx, |view, cx| {
                    let over = match &view.recording {
                        Some(Recording::Voice(microphone)) => microphone.elapsed() >= MAX_VOICE_SECONDS,
                        Some(Recording::Round(recorder)) => recorder.elapsed() >= crate::media::record::MAX_ROUND_SECONDS,
                        None => return false,
                    };
                    if over {
                        view.send_recording(cx);
                        return false;
                    }
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            if !going {
                break;
            }
        }));
    }

    fn cancel_recording(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.recording = None;
        self.recording_tick = None;
        self.composer.read(cx).focus(window);
        cx.notify();
    }

    /// Sends what was recorded, written away from the window. A click straight back isn't a message.
    fn send_recording(&mut self, cx: &mut Context<Self>) {
        let Some(recording) = self.recording.take() else { return };
        self.recording_tick = None;
        let Some(conversation) = self.conversation(cx) else { return };
        let key = conversation.key.clone();
        let list_id = conversation.list_id();
        let reply = self.state.read(cx).reply_to.get(&list_id).map(|message| message.id.clone());
        let server_id = self.server_id.clone();
        let is_admin = conversation.members.iter().any(|member| member.role == "admin" && self.state.read(cx).servers.get(&self.server_id).is_some_and(|server| server.self_id() == member.user_id));
        if conversation.slow_mode > 0. && !is_admin {
            self.sent_until = now_ms() + conversation.slow_mode * 1000.;
        }
        self.state.update(cx, |state, cx| state.set_reply(&list_id, None, cx));
        cx.spawn(async move |view, cx| {
            let prepared: Result<Option<serde_json::Value>, String> = cx
                .background_executor()
                .spawn(async move {
                    match recording {
                        Recording::Voice(microphone) => {
                            let (samples, levels) = microphone.stop();
                            let duration = samples.len() as f64 / crate::media::encode::RATE as f64;
                            if duration < 0.5 {
                                return Ok(None);
                            }
                            let path = std::env::temp_dir().join("Zuna").join("media").join(format!("voice-{}.m4a", now_ms() as u64));
                            std::fs::create_dir_all(path.parent().unwrap()).ok();
                            crate::media::encode::write_voice(&path, &samples).map_err(|_| "The voice message couldn't be recorded.".to_string())?;
                            Ok(Some(json!({
                                "blob": crate::host::file(&path.to_string_lossy(), "audio/mp4"),
                                "name": "Voice message.m4a",
                                "mime": "audio/mp4",
                                "duration": duration,
                                "voice": true,
                                "waveform": crate::media::record::encode_waveform(&levels),
                            })))
                        }
                        Recording::Round(recorder) => {
                            let path = recorder.path.clone();
                            let duration = recorder.stop()?;
                            if duration < 0.5 {
                                return Ok(None);
                            }
                            let thumb = crate::media::mf::poster(&path, 0., 160, 50).map(|(jpeg, _, _)| {
                                use base64::Engine;
                                format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg))
                            });
                            let size = crate::media::encode::ROUND_SIZE;
                            Ok(Some(json!({
                                "blob": crate::host::file(&path.to_string_lossy(), "video/mp4"),
                                "name": "Video message.mp4",
                                "mime": "video/mp4",
                                "width": size,
                                "height": size,
                                "duration": duration,
                                "thumb": thumb,
                                "round": true,
                            })))
                        }
                    }
                })
                .await;
            view.update(cx, |view, cx| {
                match prepared {
                    Ok(Some(file)) => {
                        let mut body = json!({});
                        if let Some(reply) = reply {
                            body["replyTo"] = json!(reply);
                        }
                        view.state.update(cx, |state, cx| {
                            state.call(Some(&server_id), "sendWithAttachments", vec![json!(key), json!([file]), body], cx, |state, result, cx| {
                                if let Err(error) = result {
                                    state.toast(error.message, ToastKind::Error, cx);
                                }
                            })
                        });
                    }
                    Ok(None) => {}
                    Err(error) => view.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The row in place of the message box while recording: delete, the time, the bars, send.
    fn recording_row(&mut self, is_channel: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = theme(cx);
        let recording = self.recording.as_ref()?;
        let (elapsed, levels, round) = match recording {
            Recording::Voice(microphone) => (microphone.elapsed(), microphone.levels(60), false),
            Recording::Round(recorder) => (recorder.elapsed(), Vec::new(), true),
        };
        let mut bars = div().flex_1().h(px(24.)).flex().items_center().gap(px(2.)).overflow_hidden();
        for level in &levels {
            bars = bars.child(div().w(px(3.)).flex_none().h(gpui::relative((level * 1.).max(0.08))).rounded(px(2.)).bg(theme.text2));
        }
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(10.))
                .when(is_channel, |el| el.pl(px(8.)).min_h(px(44.)))
                .when(!is_channel, |el| el.py(px(8.)))
                .child(icon_button("delete-recording", "trash", 18., false, false, cx).tip("Delete recording", Side::Top).on_click(cx.listener(|view, _, window, cx| view.cancel_recording(window, cx))))
                // `.recording-dot`: 9 px, its opacity pulsing every 1.2 s.
                .child(super::motion::pulse(div().size(px(9.)).flex_none().rounded_full().bg(theme.red), "recording-dot", 1200, |el, t| el.opacity(1. - 0.65 * gpui::ease_in_out(1. - (t * 2. - 1.).abs()))))
                .child(div().text_size(px(13.)).text_color(theme.text1).child(crate::format::format_duration(elapsed)))
                .when(round, |el| el.child(div().flex_1().text_size(px(13.5)).text_color(theme.text2).child("Recording a video message")))
                .when(!round, |el| el.child(bars))
                .child(
                    div()
                        .id("send-recording")
                        .size(px(32.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(RADIUS_M)
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover_strong))
                        
                        .on_click(cx.listener(|view, _, _, cx| view.send_recording(cx)))
                        .child(icon("send-horizontal", 18., theme.text1)),
                )
                .into_any_element(),
        )
    }

    /// The camera while a video message is recorded, mirrored, with the minute going round.
    fn round_preview(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = theme(cx);
        let Some(Recording::Round(recorder)) = &self.recording else { return None };
        let progress = (recorder.elapsed() / crate::media::record::MAX_ROUND_SECONDS).min(1.) as f32;
        if let Some(frame) = recorder.preview() {
            let size = crate::media::encode::ROUND_SIZE;
            if let Some(buffer) = image::RgbaImage::from_raw(size, size, frame) {
                let image = Arc::new(gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
                if let Some(old) = self.preview_frame.replace(image) {
                    self.retired_frames.push(old);
                }
            }
        }
        let accent = theme.accent;
        Some(
            div()
                .absolute()
                .right(px(18.))
                .bottom(gpui::relative(1.))
                .mb(px(14.))
                .size(px(240.))
                .rounded_full()
                .overflow_hidden()
                .bg(gpui::black())
                .shadow(shadow_m())
                .when_some(self.preview_frame.clone(), |el, frame| el.child(img(frame).size_full().object_fit(gpui::ObjectFit::Cover).rounded_full()))
                .child(
                    gpui::canvas(
                        |_, _, _| {},
                        move |bounds, _, window, _| {
                            let center = bounds.center();
                            let radius = bounds.size.width / 2. - px(2.5);
                            let mut path = gpui::PathBuilder::stroke(px(3.));
                            let steps = (progress * 120.).ceil().max(2.) as usize;
                            for step in 0..=steps {
                                let angle = -std::f32::consts::FRAC_PI_2 + progress * std::f32::consts::TAU * step as f32 / steps as f32;
                                let at = gpui::point(center.x + radius * angle.cos(), center.y + radius * angle.sin());
                                if step == 0 { path.move_to(at) } else { path.line_to(at) }
                            }
                            if let Ok(path) = path.build() {
                                window.paint_path(path, accent);
                            }
                        },
                    )
                    .absolute()
                    .inset_0(),
                )
                .into_any_element(),
        )
    }

    // --- Picking by dragging ---

    /// The message row at this height, held to the list's own top and bottom.
    fn row_at(&self, y: gpui::Pixels) -> Option<usize> {
        let view = self.list.viewport_bounds();
        let at = y.clamp(view.top() + px(1.), view.bottom() - px(1.));
        self.row_bounds.borrow().iter().find(|(index, bounds)| **index < self.rows.len() && bounds.top() <= at && at < bounds.bottom()).map(|(index, _)| *index)
    }

    /// A press on a message may start picking by dragging, as in Telegram's desktop app.
    fn drag_start(&mut self, event: &gpui::MouseDownEvent, cx: &mut Context<Self>) {
        if event.button != MouseButton::Left || event.modifiers.shift || event.modifiers.control || event.modifiers.alt || event.modifiers.platform {
            return;
        }
        let found = self.row_at(event.position.y);
        let Some(index) = found else { return };
        let start = self.rows[index].0.clone();
        let base = match &self.state.read(cx).selection {
            Some((list, ids)) if *list == self.last_list_id => ids.clone(),
            _ => Vec::new(),
        };
        let let_go = base.contains(&start);
        self.drag = Some(DragPick { start, base, let_go, dragging: false, y: event.position.y });
    }

    fn drag_move(&mut self, y: gpui::Pixels, cx: &mut Context<Self>) {
        let found = self.row_at(y).map(|index| self.rows[index].0.clone());
        let Some(drag) = &mut self.drag else { return };
        drag.y = y;
        let Some(id) = found else { return };
        if !drag.dragging && id == drag.start {
            return;
        }
        if !drag.dragging {
            drag.dragging = true;
            // Held near the top or bottom, or past it, the list scrolls, faster the further out.
            self.drag_tick = Some(cx.spawn(async move |view, cx| loop {
                cx.background_executor().timer(std::time::Duration::from_millis(16)).await;
                let going = view
                    .update(cx, |view, cx| {
                        let Some(y) = view.drag.as_ref().map(|drag| drag.y) else { return false };
                        let bounds = view.list.viewport_bounds();
                        let edge = px(56.);
                        let over = if y < bounds.top() + edge { f32::from(y - bounds.top() - edge) } else if y > bounds.bottom() - edge { f32::from(y - bounds.bottom() + edge) } else { 0. };
                        if over != 0. {
                            view.list.scroll_by(px((over / 56.).clamp(-3., 3.) * 12.));
                            view.drag_move(y, cx);
                            view.refresh_messages(cx);
                            cx.notify();
                        }
                        true
                    })
                    .unwrap_or(false);
                if !going {
                    break;
                }
            }));
        }
        self.pick_to(&id, cx);
    }

    /// Picks what's between where the drag began and here, or lets go of it.
    fn pick_to(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(drag) = &self.drag else { return };
        let state = self.state.read(cx);
        let Some(list) = state.lists.get(&self.last_list_id) else { return };
        let blocked = state.servers.get(&self.server_id).map(|server| server.prefs.blocked().to_vec()).unwrap_or_default();
        let (Some(from), Some(to)) = (list.items.iter().position(|item| item.id == drag.start), list.items.iter().position(|item| item.id == id)) else { return };
        // Only what a click could pick: not a line about the chat, nor a hidden message from someone blocked.
        let range: Vec<String> = list.items[from.min(to)..=from.max(to)]
            .iter()
            .filter(|item| item.system.is_none() && item.seq.is_some() && item.deleted_at.is_none() && item.status == "sent" && !blocked.contains(&item.sender_id))
            .map(|item| item.id.clone())
            .collect();
        let ids: Vec<String> = if drag.let_go {
            drag.base.iter().filter(|item| !range.contains(item)).cloned().collect()
        } else {
            drag.base.iter().cloned().chain(range.into_iter().filter(|item| !drag.base.contains(item))).collect()
        };
        let list_id = self.last_list_id.clone();
        self.state.update(cx, |state, cx| {
            state.selection = (!ids.is_empty()).then(|| (list_id, ids));
            cx.notify();
        });
    }

    /// Ends a drag; the click a drag ends with doesn't also pick, or open, what it lands on.
    fn drag_end(&mut self, cx: &mut Context<Self>) {
        let dragged = self.drag.take().is_some_and(|drag| drag.dragging);
        self.drag_tick = None;
        if dragged {
            cx.stop_propagation();
        }
    }

    // --- Suggestions, link previews and files ---

    /// What ":" or "@" just before the caret asks to complete, and what fits it.
    fn update_suggestions(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        static TRIGGER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|\s)([:@])([\p{L}\p{N}_.-]{0,32})$").unwrap());
        let input = self.composer.read(cx);
        let text = input.text().to_string();
        let caret = input.cursor().min(text.len());
        let trigger = TRIGGER.captures(&text[..caret]).and_then(|found| {
            let kind = found[1].chars().next()?;
            let query = found[2].to_lowercase();
            (kind == ':' || !query.is_empty()).then(|| (kind, query, caret - found[2].len() - 1))
        });
        let changed = trigger.as_ref().map(|(kind, query, _)| (*kind, query.clone())) != self.trigger.as_ref().map(|(kind, query, _)| (*kind, query.clone()));
        self.trigger = trigger.clone();
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return };
        self.suggestions = match &trigger {
            None => Vec::new(),
            Some((':', query, _)) => {
                let emotes = &server.emotes.emotes;
                let picked: Vec<&Emote> = if query.is_empty() {
                    emotes.iter().take(MAX_SUGGESTIONS).collect()
                } else {
                    let mut starts = Vec::new();
                    let mut contains = Vec::new();
                    for emote in emotes {
                        let lower = emote.name.to_lowercase();
                        if lower.starts_with(query.as_str()) {
                            starts.push(emote);
                        } else if lower.contains(query.as_str()) {
                            contains.push(emote);
                        }
                        if starts.len() >= MAX_SUGGESTIONS {
                            break;
                        }
                    }
                    starts.into_iter().chain(contains).take(MAX_SUGGESTIONS).collect()
                };
                picked
                    .into_iter()
                    .map(|emote| Suggestion {
                        key: emote.id.clone(),
                        label: emote.name.clone(),
                        hint: (!emote.owner.is_empty()).then(|| format!("by {}", emote.owner)),
                        insert: format!("{} ", emote.name),
                        what: Suggested::Emote(emote.clone()),
                    })
                    .collect()
            }
            Some((_, query, _)) => {
                // Anyone on the server can be mentioned in a channel, even someone whose device hasn't come in yet.
                let mut people: Vec<&UserView> = if conversation.kind == "group" {
                    conversation.members.iter().filter_map(|member| server.users.get(&member.user_id)).collect()
                } else {
                    let mut all: Vec<&UserView> = server.users.values().collect();
                    all.sort_by_key(|user| user.display_name.to_lowercase());
                    all
                };
                people.retain(|user| !user.banned && (user.username.to_lowercase().contains(query.as_str()) || user.display_name.to_lowercase().contains(query.as_str())));
                people
                    .into_iter()
                    .take(MAX_SUGGESTIONS)
                    .map(|user| Suggestion {
                        key: user.id.clone(),
                        label: user.display_name.clone(),
                        hint: Some(format!("@{}", user.username)),
                        insert: format!("@{} ", user.username),
                        what: Suggested::Person(user.clone()),
                    })
                    .collect()
            }
        };
        if changed {
            let tentative = matches!(&self.trigger, Some((':', query, _)) if query.chars().count() < 2);
            self.selected = if tentative { None } else { Some(0) };
        }
        let suggesting = !self.suggestions.is_empty();
        self.composer.update(cx, |input, _| input.set_suggesting(suggesting));
    }

    fn apply_suggestion(&mut self, index: usize, cx: &mut Context<Self>) {
        let (Some((_, _, start)), Some(suggestion)) = (self.trigger.clone(), self.suggestions.get(index).cloned()) else { return };
        let caret = self.composer.read(cx).cursor();
        self.composer.update(cx, |input, cx| input.replace_range(start..caret, &suggestion.insert, cx));
    }

    /// Makes the first link's preview once typing pauses, unless it was taken away.
    fn update_link(&mut self, text: &str, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let editing = state.editing.contains_key(&self.last_list_id);
        let link = if state.settings.link_previews && !editing { find_link(text) } else { None };
        let link = link.filter(|link| Some(link) != self.dismissed_link.as_ref());
        if link == self.link_wanted {
            return;
        }
        self.link_wanted = link.clone();
        self.link_draft = None;
        self.link_task = None;
        let Some(url) = link else { return };
        let core = self.state.read(cx).core.clone();
        self.link_task = Some(cx.spawn(async move |view, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(PREVIEW_DELAY_MS)).await;
            view.update(cx, |view, cx| {
                view.link_draft = Some(LinkDraft { url: url.clone(), preview: None, loading: true });
                cx.notify();
            })
            .ok();
            let result = core.call(None, "linkPreview", vec![json!(url)]).await;
            view.update(cx, |view, cx| {
                if view.link_wanted.as_ref() != Some(&url) {
                    return;
                }
                view.link_draft = match result {
                    Ok(value) => Some(LinkDraft { url: url.clone(), preview: serde_json::from_value(value).ok(), loading: false }),
                    Err(_) => None,
                };
                cx.notify();
            })
            .ok();
        }));
    }

    /// Adds files to go with the next message, up to ten, read for their chips away from the window.
    fn add_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let room = MAX_FILES.saturating_sub(self.files.len());
        let paths: Vec<PathBuf> = paths.into_iter().filter(|path| path.is_file()).take(room).collect();
        if paths.is_empty() {
            return;
        }
        cx.spawn(async move |view, cx| {
            let staged = cx.background_executor().spawn(async move { paths.iter().map(|path| stage_file(path)).collect::<Vec<_>>() }).await;
            view.update(cx, |view, cx| {
                view.files.extend(staged);
                view.files.truncate(MAX_FILES);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Seconds until slow mode lets a new message go here, counting down while it holds.
    fn slow_wait(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) -> u64 {
        if conversation.slow_mode <= 0. {
            return 0;
        }
        let until = conversation.slow_until.max(self.sent_until);
        let left = ((until - now_ms()) / 1000.).ceil().max(0.) as u64;
        if left > 0 && self.slow_tick.is_none() {
            self.slow_tick = Some(cx.spawn(async move |view, cx| {
                loop {
                    cx.background_executor().timer(std::time::Duration::from_millis(250)).await;
                    let done = view
                        .update(cx, |view, cx| {
                            cx.notify();
                            let until = view.conversation(cx).map(|c| c.slow_until).unwrap_or(0.).max(view.sent_until);
                            until <= now_ms()
                        })
                        .unwrap_or(true);
                    if done {
                        break;
                    }
                }
                view.update(cx, |view, _| view.slow_tick = None).ok();
            }));
        }
        left
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let value = self.composer.read(cx).text().trim().to_string();
        let list_id = conversation.list_id();
        let waiting = self.slow_wait(&conversation, cx) > 0;
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return };
        let editing = if conversation.kind == "channel" { None } else { state.editing.get(&list_id).cloned() };
        let reply = state.reply_to.get(&list_id).cloned();
        if value.is_empty() && (self.files.is_empty() || editing.is_some()) {
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
        // What's written stays until it may go.
        if waiting {
            return;
        }
        let mut body = json!({ "emotes": emotes, "mentions": mentions });
        if !value.is_empty() {
            body["text"] = json!(value);
        }
        if let Some(reply) = reply {
            body["replyTo"] = json!(reply.id);
        }
        // A preview that isn't ready yet, as when a link is pasted and sent at once, goes with
        // the message if it's ready within a few seconds; the message shows straight away.
        let link = self.link_wanted.clone();
        let ready = self.link_draft.as_ref().filter(|draft| Some(&draft.url) == link.as_ref());
        if let Some(preview) = ready.and_then(|draft| draft.preview.as_ref()).filter(|preview| value.contains(&preview.url)) {
            body["preview"] = serde_json::to_value(preview).unwrap_or_default();
        }
        let settled = ready.is_some_and(|draft| !draft.loading);
        let mut options = json!({});
        if let (Some(link), true, false) = (&link, body.get("preview").is_none(), settled) {
            options["previewUrl"] = json!(link);
        }
        let key = conversation.key.clone();
        let files: Vec<serde_json::Value> = std::mem::take(&mut self.files).into_iter().map(|staged| staged.file).collect();
        let keep_metadata = !state.settings.remove_metadata;
        let is_admin = conversation.members.iter().any(|member| member.user_id == server.self_id() && member.role == "admin");
        let server_id = self.server_id.clone();
        self.state.update(cx, |state, cx| {
            if files.is_empty() {
                state.act("sendMessage", vec![json!(key), body, options], cx);
            } else {
                options["keepMetadata"] = json!(keep_metadata);
                state.call(Some(&server_id), "sendWithAttachments", vec![json!(key), json!(files), body, options], cx, |state, result, cx| {
                    if let Err(error) = result {
                        state.toast(error.message, ToastKind::Error, cx);
                    }
                });
            }
            state.set_reply(&list_id, None, cx);
            state.drafts.remove(&key);
            if state.lists.get(&list_id).is_some_and(|list| list.detached) {
                state.return_to_latest(&list_id, cx);
            }
        });
        // In slow mode the next one waits from now, unless you're an admin.
        if conversation.slow_mode > 0. && !is_admin {
            self.sent_until = now_ms() + conversation.slow_mode * 1000.;
        }
        self.link_wanted = None;
        self.link_draft = None;
        self.link_task = None;
        self.dismissed_link = None;
        self.composer.update(cx, |input, cx| input.set_text("", cx));
        self.list.scroll_to(gpui::ListOffset { item_ix: self.rows.len(), offset_in_item: px(0.) });
        self.composer.read(cx).focus(window);
    }

    /// What the attach button offers: a photo or file, or where this device is.
    fn attach_menu(&mut self, position: gpui::Point<gpui::Pixels>, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let view = cx.entity().downgrade();
        let state = self.state.clone();
        let key = conversation.key.clone();
        let entries = vec![
            super::menu::MenuEntry::new("Photo or file", "file", move |window, cx| {
                view.update(cx, |view, cx| view.attach(window, cx)).ok();
            }),
            super::menu::MenuEntry::new("Location", "map-pin", move |_, cx| {
                state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::ShareLocation { conversation_key: key.clone() }), cx))
            }),
        ];
        super::menu::open_menu(gpui::point(position.x - px(10.), position.y - px(96.)), entries, false, cx);
    }

    /// Picks files to go with the next message, as the desktop's attach button does.
    fn attach(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |view, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            view.update(cx, |view, cx| view.add_files(paths, cx)).ok();
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
            title = title.child(div().id("timer-icon").tip(format!("Messages disappear after {}", timer_text(conversation.disappear_after)), Side::Bottom).child(icon("timer", 14., theme.text2)));
        }
        let toggle = |panel_kind: Panel, state: Entity<AppState>| move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut gpui::App| state.update(cx, |state, cx| state.toggle_panel(panel_kind, cx));
        let has_group = conversation.group_id.is_some();
        let call_buttons = super::voice::call_buttons(&self.state, &self.server_id, conversation, cx);
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
                    .child(div().min_w_0().flex().flex_col().child(title).child({
                        let line = div().text_size(px(12.5)).line_height(gpui::relative(1.3)).child(status);
                        if !typing.is_empty() {
                            *self.typed_in.borrow_mut() = Some(conversation.key.clone());
                        }
                        if self.typed_in.borrow().as_deref() == Some(conversation.key.as_str()) {
                            // Faded in afresh each time it turns between typing and not.
                            line.enter(if typing.is_empty() { "status-idle" } else { "status-typing" }, Enter::Fade, 140).into_any_element()
                        } else {
                            line.into_any_element()
                        }
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(2.))
                    .children(call_buttons)
                    .child(
                        icon_button("chat-search", "search", 17., false, panel == Some(Panel::Search), cx)
                            .tip("Search this chat", Side::Bottom)
                            .when(has_group, |el| el.on_click(toggle(Panel::Search, self.state.clone())))
                            .when(!has_group, |el| el.opacity(0.35)),
                    )
                    .child(
                        icon_button("chat-pins", "pin", 17., false, panel == Some(Panel::Pins), cx)
                            .tip("Pinned messages", Side::Bottom)
                            .when(has_group, |el| el.on_click(toggle(Panel::Pins, self.state.clone())))
                            .when(!has_group, |el| el.opacity(0.35)),
                    )
                    .child(icon_button("chat-details", "panel-right", 17., false, panel == Some(Panel::Info), cx).tip("Details", Side::Bottom).on_click(toggle(Panel::Info, self.state.clone()))),
            )
            .into_any_element()
    }

    /// The call above this chat while this device is in it, or the banner for one going on.
    fn call_area(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) -> (Option<AnyElement>, bool) {
        let in_call = conversation.group_id.is_some() && crate::voice::connected_channel(cx).is_some_and(|(server_id, channel_id)| server_id == self.server_id && Some(&channel_id) == conversation.group_id.as_ref());
        if !in_call {
            self.call_stage = None;
            return (super::voice::call_banner(&self.state, &self.server_id, conversation, cx), false);
        }
        let stage = match &self.call_stage {
            Some(stage) => stage.clone(),
            None => {
                let room = super::voice_stage::StageRoom { server_id: self.server_id.clone(), id: conversation.group_id.clone().unwrap_or_default(), call: true };
                let state = self.state.clone();
                let stage = cx.new(|cx| super::voice_stage::VoiceStage::new(state, room, cx));
                cx.observe(&stage, |_, _, cx| cx.notify()).detach();
                self.call_stage = Some(stage.clone());
                stage
            }
        };
        let expanded = stage.read(cx).expanded;
        (Some(stage.into_any_element()), expanded)
    }

    fn composer_area(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
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
        let is_channel = conversation.kind == "channel";
        let editing = if is_channel { None } else { state.editing.get(&list_id).cloned() };
        let reply = state.reply_to.get(&list_id).cloned();
        let can_send = !self.composer.read(cx).text().trim().is_empty() || (!self.files.is_empty() && editing.is_none());
        let server_url = server.entry.url.clone();
        let mut area = if is_channel { div().relative().rounded(px(8.)).bg(theme.bg2) } else { div().flex_none().relative().bg(theme.bg1).border_t_1().border_color(theme.line) };
        if let (true, Some(context)) = (is_channel, reply.clone()) {
            // What's being replied to, joined to the top of the box.
            let sender = if context.sender_id == server.self_id() { "yourself".to_string() } else { server.display_name(&context.sender_id) };
            let state = self.state.clone();
            let list = list_id.clone();
            area = area.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .h(px(34.))
                    .pl(px(16.))
                    .pr(px(6.))
                    .rounded_t(px(8.))
                    .bg(theme.bg1)
                    .text_size(px(14.))
                    .text_color(theme.text2)
                    .child(div().flex_1().min_w_0().flex().child("Replying to ").child(div().font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(sender)))
                    .child(
                        div()
                            .id("cancel-reply")
                            .size(px(26.))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.hover_strong))
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_reply(&list, None, cx)))
                            .child(icon("x", 15., theme.text2)),
                    )
                    .enter("composer-context", Enter::Fade, 100),
            );
        } else if editing.is_some() || reply.is_some() {
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
                )
                .enter("composer-context", Enter::Fade, 100),
            );
        }
        if let Some(draft) = self.link_draft.as_ref().filter(|draft| draft.loading || draft.preview.is_some()) {
            let title = draft
                .preview
                .as_ref()
                .and_then(|preview| preview.title.clone().or_else(|| preview.site_name.clone()))
                .unwrap_or_else(|| "Loading the link's preview…".into());
            let text = draft.preview.as_ref().and_then(|preview| preview.description.clone()).unwrap_or_else(|| draft.url.clone());
            let picture = draft.preview.as_ref().and_then(|preview| preview.image.as_ref()).and_then(|image| super::message::data_url_image(&image.data));
            let url = draft.url.clone();
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
                        .child(icon("link", 15., theme.text2))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().one_line().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(title))
                                .child(div().one_line().text_size(px(12.5)).text_color(theme.text2).child(text)),
                        )
                        .when_some(picture, |el, picture| el.child(cover_image(picture, 36., 36., RADIUS_S, cx)))
                        .child(icon_button("remove-link", "x", 15., true, false, cx).on_click(cx.listener(move |view, _, _, cx| {
                            view.dismissed_link = Some(url.clone());
                            view.link_wanted = None;
                            view.link_draft = None;
                            view.link_task = None;
                            cx.notify();
                        }))),
                )
                .enter("link-draft", Enter::Fade, 100),
            );
        }
        if !self.files.is_empty() && editing.is_none() {
            let mut chips = div().id("composer-files").flex().gap(px(6.)).pt(px(8.)).px(px(12.)).overflow_x_scroll();
            for (index, staged) in self.files.iter().enumerate() {
                let picture: AnyElement = match &staged.preview {
                    Some(image) => cover_image(image.clone(), 36., 36., RADIUS_S, cx).into_any_element(),
                    None => div().size(px(36.)).flex_none().rounded(RADIUS_S).bg(theme.bg4).flex().items_center().justify_center().child(icon("file", 16., theme.text2)).into_any_element(),
                };
                chips = chips.child(
                    div()
                        .relative()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .w(px(180.))
                        .p(px(5.))
                        .rounded(RADIUS_M)
                        .bg(theme.bg3)
                        .child(picture)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .text_size(px(12.5))
                                .child(div().one_line().child(staged.name.clone()))
                                .child(div().text_size(px(11.5)).text_color(theme.text3).child(format_bytes(staged.size as f64))),
                        )
                        .child(
                            div()
                                .id(("remove-file", index))
                                .absolute()
                                .top(px(3.))
                                .right(px(3.))
                                .size(px(16.))
                                .rounded_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(theme.bg5)
                                .cursor_pointer()
                                
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    if index < view.files.len() {
                                        view.files.remove(index);
                                    }
                                    cx.notify();
                                }))
                                .child(icon("x", 11., theme.text1)),
                        )
                        .enter(SharedString::from(format!("chip-{}-{}", staged.name, staged.size)), Enter::Pop, 100),
                );
            }
            area = area.child(chips);
        }
        if !self.suggestions.is_empty() {
            area = area.child(self.suggestion_list(&server_url, cx));
        }
        if let Some(row) = self.recording_row(is_channel, cx) {
            area = area.child(row);
            if let Some(preview) = self.round_preview(cx) {
                area = area.child(preview);
            }
            if is_channel {
                return div().flex_none().px(px(16.)).bg(theme.bg_chat).child(area).into_any_element();
            }
            return area.into_any_element();
        }
        let wait = if editing.is_none() { self.slow_wait(conversation, cx) } else { 0 };
        // With nothing written, the camera and the microphone are where the send button was.
        let show_record = !can_send && editing.is_none() && wait == 0;
        let send_ready = can_send;
        // A channel's waiting send button is text-2, a chat's text-3.
        let send_color = if send_ready { theme.text1 } else if is_channel { theme.text2 } else { theme.text3 };
        // `.composer-area.is-channel .icon-btn`: 36 by 44, with no background, only a brighter
        // icon under the pointer; a chat's are plain `.icon-btn`s.
        let composer_button = |id: &'static str, icon_name: &'static str, cx: &mut Context<Self>| {
            if is_channel {
                div()
                    .id(id)
                    .group(id)
                    .w(px(36.))
                    .h(px(44.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(icon(icon_name, 18., theme.text2).group_hover(id, move |style| style.text_color(theme.text1)))
            } else {
                icon_button(id, icon_name, 18., false, false, cx)
            }
        };
        let row = if is_channel {
            div()
                .flex()
                .items_start()
                .min_h(px(44.))
                .pr(px(6.))
                .child(
                    div()
                        .id("attach")
                        .w(px(56.))
                        .h(px(44.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .group("attach")
                        .tip("Attach", Side::Top)
                        .on_click(cx.listener(|view, event: &gpui::ClickEvent, _, cx| view.attach_menu(event.position(), cx)))
                        .child(icon("plus-circle-filled", 22., theme.text2).group_hover("attach", move |style| style.text_color(theme.text1))),
                )
        } else {
            div().flex().items_end().gap(px(2.)).px(px(10.)).py(px(8.)).when(editing.is_none(), |el| {
                el.child(icon_button("attach", "paperclip", 18., false, false, cx).tip("Attach", Side::Top).on_click(cx.listener(|view, event: &gpui::ClickEvent, _, cx| view.attach_menu(event.position(), cx))))
            })
        };
        let message_size = if is_channel { theme.message_size + px(1.5) } else { theme.message_size };
        let (emoji_bounds, emoji_probe) = bounds_probe();
        let composer_scroll = scroll_handle("composer-scroll");
        area = area.child(
            row
                .child(
                    div()
                        .id("composer-scroll")
                        .flex_1()
                        .min_w_0()
                        .max_h(px(220.))
                        .overflow_y_scroll()
                        .track_scroll(&composer_scroll)
                        .when(!is_channel, |el| el.px(px(6.)).py(px(6.)).min_h(px(32.)).line_height(px(20.)))
                        .when(is_channel, |el| el.py(px(11.)).min_h(px(44.)).line_height(px(22.)))
                        .pr(px(6.) + gutter(&composer_scroll))
                        .text_size(message_size)
                        .child(self.composer.clone())
                        .child(scrollbar("composer-scroll", Scrolls::Div(composer_scroll.clone()))),
                )
                .child(composer_button("emoji", "face-slightly-smiling", cx).child(emoji_probe).tip("Emoji and emotes", Side::Top).on_click(cx.listener(move |view, _: &gpui::ClickEvent, window, cx| {
                    let composer = view.composer.clone();
                    // As the desktop's: 330 px left of the button's right edge, at its top.
                    let at = emoji_bounds.get();
                    let position = gpui::point(at.right() - px(330.), at.top());
                    super::picker::open_picker(
                        position,
                        true,
                        move |pick, window, cx| {
                            composer.update(cx, |input, cx| {
                                let text = match pick {
                                    super::picker::Pick::Emoji(value) => value,
                                    super::picker::Pick::Emote(emote) => {
                                        let before = &input.text()[..input.cursor().min(input.text().len())];
                                        let space = if before.is_empty() || before.ends_with(char::is_whitespace) { "" } else { " " };
                                        format!("{space}{} ", emote.name)
                                    }
                                };
                                input.insert(&text, window, cx);
                            });
                            composer.read(cx).focus(window);
                        },
                        window,
                        cx,
                    );
                })))
                .when(wait > 0, |el| {
                    // Slow mode: what's written waits, with the time until it may go.
                    el.child(
                        div()
                            .h(px(32.))
                            .min_w(px(36.))
                            .px(px(6.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text2)
                            .child(wait_text(wait)),
                    )
                })
                .when(show_record, |el| {
                    el.child(composer_button("record-round", "video", cx).tip("Record a video message", Side::Top).on_click(cx.listener(|view, _, _, cx| view.start_round(cx))))
                        .child(
                            div()
                                .id("record-voice")
                                .when(is_channel, |el| el.w(px(36.)).h(px(44.)))
                                .when(!is_channel, |el| el.size(px(32.)).rounded(RADIUS_M).hover(move |style| style.bg(theme.hover_strong)))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .tip("Record a voice message", Side::Top)
                                .on_click(cx.listener(|view, _, _, cx| view.start_voice(cx)))
                                .child(icon("mic", 18., theme.text1)),
                        )
                })
                .when(wait == 0 && !show_record, |el| {
                    el.child(
                        div()
                            .id("send")
                            .when(is_channel, |el| el.w(px(36.)).h(px(44.)))
                            .when(!is_channel, |el| el.size(px(32.)).rounded(RADIUS_M).when(send_ready, |el| el.hover(move |style| style.bg(theme.hover_strong))))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .when(send_ready, |el| el.cursor_pointer())
                            .on_click(cx.listener(|view, _, window, cx| view.send(window, cx)))
                            .child(icon(if editing.is_some() { "check" } else { "send-horizontal" }, if send_ready { 18. } else { 16.2 }, send_color)),
                    )
                }),
        );
        if is_channel {
            return div().flex_none().px(px(16.)).bg(theme.bg_chat).child(area).into_any_element();
        }
        area.into_any_element()
    }

    // --- Channels ---

    /// A channel's header, as Discord's: its name and topic, then notifications, pins,
    /// the member list and a search box.
    fn channel_header(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let panel = state.panel;
        let show_members = !state.settings.hide_member_list;
        let muted = conversation.muted;
        let muted_color = theme::color(theme::hex(0x8b8b92));
        let details = |id: &'static str, state: Entity<AppState>| {
            div().id(id).cursor_pointer().on_click(move |_, _, cx| {
                state.update(cx, |state, cx| state.toggle_panel(Panel::Info, cx));
            })
        };
        let action = |id: &'static str, icon_name: &'static str, active: bool| {
            div()
                .id(id)
                .size(px(32.))
                .mx(px(2.))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .group(id)
                // `.channel-head .icon-btn`: no background, only a brighter icon under the pointer.
                .child(icon(icon_name, 20., if active { theme.text1 } else { theme.text2 }).group_hover(id, move |style| style.text_color(theme.text1)))
        };
        let (mute_state, mute_key) = (self.state.clone(), conversation.key.clone());
        let pins_state = self.state.clone();
        let members_state = self.state.clone();
        let search_state = self.state.clone();
        let searching = panel == Some(Panel::Search);
        div()
            .flex_none()
            .h(px(48.))
            .flex()
            .items_center()
            .pl(px(16.))
            .pr(px(8.))
            .bg(theme.bg_chat)
            .border_b_1()
            .border_color(theme.line)
            .shadow(vec![gpui::BoxShadow { color: theme::color(theme::black_a(0.25)), offset: gpui::point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.) }])
            .child(
                details("channel-name", self.state.clone())
                    .flex_shrink()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(icon("hash", 22., muted_color))
                    .child(div().min_w_0().one_line().text_size(px(16.)).line_height(px(20.)).font_weight(FontWeight::SEMIBOLD).child(conversation.title.clone())),
            )
            .when(!conversation.description.is_empty(), |el| {
                el.child(div().flex_none().w(px(1.)).h(px(24.)).mx(px(12.)).bg(theme.line_strong))
                    .child(details("channel-topic", self.state.clone()).flex_shrink().min_w_0().one_line().text_size(px(14.)).line_height(px(18.)).text_color(theme.text2).tooltip(tooltip(conversation.description.clone())).child(conversation.description.clone()))
            })
            .child(div().flex_1())
            .child(
                action("channel-mute", if muted { "bell-off" } else { "bell" }, false)
                    .tip(if muted { "Unmute channel" } else { "Notification settings" }, Side::Bottom)
                    .on_click(move |event, _, cx| {
                        if muted {
                            mute_state.update(cx, |state, cx| state.act("unmute", vec![json!(mute_key)], cx));
                        } else {
                            super::menu::open_menu(event.position(), super::conversations::mute_entries(mute_key.clone(), mute_state.clone()), true, cx);
                        }
                    }),
            )
            .child(action("channel-pins", "pin", panel == Some(Panel::Pins)).tip("Pinned messages", Side::Bottom).on_click(move |_, _, cx| pins_state.update(cx, |state, cx| state.toggle_panel(Panel::Pins, cx))))
            .child(
                action("channel-members", "users", show_members && panel.is_none())
                    .tip(if show_members { "Hide member list" } else { "Show member list" }, Side::Bottom)
                    .on_click(move |_, _, cx| {
                        members_state.update(cx, |state, cx| {
                            // It takes the place of whatever panel was open.
                            if state.panel.is_some() {
                                state.panel = None;
                                cx.notify();
                                if !state.settings.hide_member_list {
                                    return;
                                }
                            }
                            state.update_settings(|settings| settings.hide_member_list = !settings.hide_member_list, cx);
                        })
                    }),
            )
            .child(
                div()
                    .id("channel-search")
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(6.))
                    .w(px(if searching { 220. } else { 144. }))
                    .h(px(26.))
                    .ml(px(8.))
                    .mr(px(4.))
                    .pl(px(8.))
                    .pr(px(7.))
                    .rounded(px(6.))
                    .bg(theme.bg2)
                    .text_size(px(14.))
                    .text_color(if searching { theme.text1 } else { muted_color })
                    .cursor_pointer()
                    .hover(move |style| style.text_color(theme.text2))
                    .on_click(move |_, _, cx| search_state.update(cx, |state, cx| state.toggle_panel(Panel::Search, cx)))
                    .child("Search")
                    .child(icon("search", 15., if searching { theme.text1 } else { muted_color })),
            )
            .into_any_element()
    }

    /// Everyone on the server, as Discord lists a channel's members: online first, then the rest, faded.
    /// Who's typing in a channel, under the message box, with slow mode on the right. Always there, so nothing moves.
    fn channel_typing(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let server = state.servers.get(&self.server_id);
        let names: Vec<String> = conversation
            .group_id
            .as_ref()
            .and_then(|group| server.and_then(|server| server.typing.get(group)))
            .map(|typing| typing.keys().filter(|id| server.is_some_and(|server| *id != server.self_id())).map(|id| server.and_then(|server| server.users.get(id)).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into())).collect())
            .unwrap_or_default();
        let bold = |name: &str| div().font_weight(FontWeight::BOLD).child(name.to_string());
        let text: Option<gpui::Div> = match names.len() {
            0 => None,
            1 => Some(div().flex().child(bold(&names[0])).child("\u{a0}is typing…")),
            2 => Some(div().flex().child(bold(&names[0])).child("\u{a0}and\u{a0}").child(bold(&names[1])).child("\u{a0}are typing…")),
            3 => Some(div().flex().child(bold(&names[0])).child(",\u{a0}").child(bold(&names[1])).child("\u{a0}and\u{a0}").child(bold(&names[2])).child("\u{a0}are typing…")),
            _ => Some(div().child("Several people are typing…")),
        };
        div()
            .flex_none()
            .h(px(24.))
            .flex()
            .items_center()
            .gap(px(6.))
            .pl(px(18.))
            .pr(px(16.))
            .text_size(px(14.))
            .text_color(theme.text1)
            .bg(theme.bg_chat)
            .overflow_hidden()
            .when_some(text, |el, text| el.child(typing_dots(theme.text1)).child(div().min_w_0().overflow_hidden().child(text)))
            .when(conversation.slow_mode > 0., |el| {
                el.child(
                    div()
                        .id("slow-mode")
                        .ml_auto()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .tip(format!("One message every {} for each person, except admins", crate::format::timer_text(conversation.slow_mode)), Side::Top)
                        .child(icon("timer", 14., theme.text2))
                        .child("Slow mode is on"),
                )
            })
            .into_any_element()
    }

    /// Back to the newest messages from a channel's older ones: a bar along the bottom of the list.
    fn jump_present(&self, conversation: &ConversationView, unread_below: u32, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let first_unread = self.unread_line.clone().flatten().and_then(|id| self.state.read(cx).lists.get(&conversation.list_id()).and_then(|list| list.items.iter().find(|item| item.id == id).map(|item| item.created_at)));
        let text = if unread_below > 0 {
            let count = if unread_below > 99 { "99+".to_string() } else { unread_below.to_string() };
            let since = first_unread.map(|at| format!(" since {}", crate::format::format_time(at))).unwrap_or_default();
            format!("{count} new {}{since}", if unread_below == 1 { "message" } else { "messages" })
        } else {
            "You're viewing older messages".to_string()
        };
        let list_state = self.list.clone();
        let state = self.state.clone();
        let list_id = conversation.list_id();
        let count = self.rows.len();
        let detached = self.state.read(cx).lists.get(&list_id).is_some_and(|list| list.detached);
        div()
            .id("jump-present")
            .absolute()
            .left(px(16.))
            .right(px(16.))
            .bottom_0()
            .h(px(32.))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .px(px(12.))
            .rounded_t(px(8.))
            .bg(theme.bg3)
            .shadow(shadow_s())
            .text_size(px(14.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.text2)
            .cursor_pointer()
            .hover(move |style| style.bg(theme.bg4).text_color(theme.text1))
            .on_click(move |_, _, cx| {
                if detached {
                    state.update(cx, |state, cx| state.return_to_latest(&list_id, cx));
                } else {
                    list_state.scroll_to(gpui::ListOffset { item_ix: count, offset_in_item: px(0.) });
                }
            })
            .child(div().min_w_0().one_line().child(text))
            .child(div().flex_none().flex().items_center().gap(px(4.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child("Jump to present").child(icon("arrow-down", 15., theme.text1)))
            .enter("jump-present-in", Enter::Rise(5.), 120)
            .into_any_element()
    }

    /// Editing a channel message where it is: the field, focused, holding its text.
    fn sync_inline_editor(&mut self, conversation: &ConversationView, window: &mut Window, cx: &mut Context<Self>) {
        let editing = if conversation.kind == "channel" { self.state.read(cx).editing.get(&conversation.list_id()).cloned() } else { None };
        match editing {
            Some(message) if self.inline_editing.as_deref() != Some(message.id.as_str()) => {
                self.inline_editing = Some(message.id.clone());
                let text = message.text.clone();
                let editor = self.inline_editor.clone();
                editor.update(cx, |input, cx| input.set_text(text, cx));
                editor.read(cx).focus(window);
            }
            None if self.inline_editing.is_some() => {
                self.inline_editing = None;
                self.composer.read(cx).focus(window);
            }
            _ => {}
        }
    }

    fn on_inline_editor(&mut self, event: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        let list_id = self.last_list_id.clone();
        match event {
            InputEvent::Submit => {
                let Some(message) = self.state.read(cx).editing.get(&list_id).cloned() else { return };
                let value = self.inline_editor.read(cx).text().trim().to_string();
                if !value.is_empty() && value != message.text {
                    let state = self.state.read(cx);
                    let Some(server) = state.servers.get(&self.server_id) else { return };
                    let mentions = mentions_in(&value, &server.mentionable);
                    let emotes: serde_json::Map<String, serde_json::Value> = value
                        .split_whitespace()
                        .filter_map(|word| server.emotes.emotes.iter().find(|emote| emote.name == word).map(|emote| (word.to_string(), json!({ "id": emote.id, "animated": emote.animated, "zeroWidth": emote.zero_width, "owner": emote.owner }))))
                        .collect();
                    let args = vec![json!(message.group_id), json!(message.id), json!(value), json!(emotes), json!(mentions)];
                    self.state.update(cx, |state, cx| state.act("editMessage", args, cx));
                }
                self.state.update(cx, |state, cx| state.set_editing(&list_id, None, cx));
            }
            InputEvent::Escape => self.state.update(cx, |state, cx| state.set_editing(&list_id, None, cx)),
            _ => {}
        }
        let _ = window;
    }

    /// Asks the core which unread messages mention you, whenever how far you've read changes.
    fn update_mentions(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else { return };
        let asked = (conversation.own_read, conversation.unread_mentions);
        if self.mentions_asked == Some(asked) {
            return;
        }
        self.mentions_asked = Some(asked);
        if conversation.unread_mentions <= 0. && !conversation.mentioned {
            self.mentions.clear();
            return;
        }
        let call = self.state.read(cx).core.call(Some(&self.server_id), "unreadMentions", vec![json!(group), json!(conversation.own_read)]);
        cx.spawn(async move |view, cx| {
            let Ok(found) = call.await else { return };
            let found: Vec<(String, f64)> = found
                .as_array()
                .map(|items| items.iter().filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item.get("seq")?.as_f64()?))).collect())
                .unwrap_or_default();
            view.update(cx, |view, cx| {
                if view.mentions_asked == Some(asked) {
                    view.mentions = found;
                    view.refresh_messages(cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// As Telegram's "@": goes to the oldest unread message that mentions you, then the next.
    fn mention_button(&self, conversation: &ConversationView, raised: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = theme(cx);
        let (next_id, _) = self.mentions.first()?.clone();
        let group = conversation.group_id.clone()?;
        let count = self.mentions.len();
        Some(
            div()
                .id("to-mention")
                .absolute()
                .right(px(14.))
                .bottom(px(if conversation.kind == "channel" { 44. } else if raised { 66. } else { 16. }))
                .size(px(40.))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.bg5)
                .shadow(shadow_s())
                .cursor_pointer()
                .hover(|style| style.bg(theme::color(theme::hex(0x45454b))))
                .on_click(cx.listener(move |view, _, _, cx| {
                    if !view.mentions.is_empty() {
                        view.mentions.remove(0);
                    }
                    let (group, id) = (group.clone(), next_id.clone());
                    view.state.update(cx, |state, cx| {
                        state.act("markMentionSeen", vec![json!(group), json!(id)], cx);
                        state.jump_to_message(&group, &id, cx);
                    });
                    view.refresh_messages(cx);
                    cx.notify();
                }))
                .child(icon("at-sign", 21., theme.text1))
                .child(
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
                        .child(if count > 99 { "99+".to_string() } else { count.to_string() }),
                )
                .into_any_element(),
        )
    }

    /// What can be done with the picked messages, in place of the message box, as in Telegram.
    fn selection_bar(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return div().into_any_element() };
        let list_id = conversation.list_id();
        let ids = state.selection.as_ref().map(|(_, ids)| ids.clone()).unwrap_or_default();
        // In the chat's order, whatever order they were picked in.
        let picked: Vec<MessageView> = state.lists.get(&list_id).map(|list| list.items.iter().filter(|item| ids.contains(&item.id)).cloned().collect()).unwrap_or_default();
        let self_id = server.self_id().to_string();
        let is_admin = conversation.members.iter().any(|member| member.user_id == self_id && member.role == "admin");
        let can_delete = !picked.is_empty() && picked.iter().all(|item| item.sender_id == self_id || (conversation.kind != "dm" && is_admin));
        let names: HashMap<String, String> = server.users.iter().map(|(id, user)| (id.clone(), user.display_name.clone())).collect();
        let count = picked.len();
        let group = conversation.group_id.clone();
        let server_id = self.server_id.clone();
        let picked_ids: Vec<String> = picked.iter().map(|item| item.id.clone()).collect();
        let stop = {
            let list_id = list_id.clone();
            cx.listener(move |view, _, _, cx| view.state.update(cx, |state, cx| state.toggle_selected(&list_id, None, cx)))
        };
        let copy = {
            let (picked, list_id, self_id) = (picked.clone(), list_id.clone(), self_id.clone());
            cx.listener(move |view, _, _, cx| {
                let name = |id: &str| if id == self_id { "You".to_string() } else { names.get(id).cloned().unwrap_or_else(|| "Unknown".into()) };
                let text = if picked.len() == 1 {
                    picked[0].text.clone()
                } else {
                    picked
                        .iter()
                        .map(|item| {
                            let body = if item.text.is_empty() { item.attachments.iter().map(|file| file.name.clone()).collect::<Vec<_>>().join(", ") } else { item.text.clone() };
                            format!("{}, [{}]\n{}", name(&item.sender_id), crate::format::format_full(item.created_at), body)
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                };
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                let count = picked.len();
                view.state.update(cx, |state, cx| {
                    state.toast(if count == 1 { "Copied".to_string() } else { format!("Copied {count} messages") }, ToastKind::Info, cx);
                    state.toggle_selected(&list_id, None, cx);
                });
            })
        };
        let forward = {
            let (ids, group, server_id) = (picked_ids.clone(), group.clone(), server_id.clone());
            cx.listener(move |view, _, _, cx| {
                let Some(group_id) = group.clone() else { return };
                let overlay = crate::state::Overlay::Forward { server_id: server_id.clone(), group_id, ids: ids.clone() };
                view.state.update(cx, |state, cx| state.set_overlay(Some(overlay), cx));
            })
        };
        let delete = {
            let (ids, group, list_id) = (picked_ids.clone(), group.clone(), list_id.clone());
            cx.listener(move |view, _, _, cx| {
                let Some(group_id) = group.clone() else { return };
                view.state.update(cx, |state, cx| {
                    state.act("deleteMessages", vec![json!(group_id), json!(ids)], cx);
                    state.toggle_selected(&list_id, None, cx);
                });
            })
        };
        div()
            .flex_none()
            .bg(theme.bg1)
            .border_t_1()
            .border_color(theme.line)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .w_full()
                    .pt(px(10.))
                    .pr(px(12.))
                    .pb(px(12.))
                    .pl(px(8.))
                    .child(icon_button("cancel-selection", "x", 18., false, false, cx).tip("Cancel", Side::Top).on_click(stop))
                    .child(div().flex_1().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).child(format!("{count} {} selected", if count == 1 { "message" } else { "messages" })))
                    .child(button("copy-selection", ButtonKind::Default, ButtonSize::Normal, count == 0, cx).child(icon("copy", 15., theme.text1)).child("Copy").on_click(copy))
                    .child(button("forward-selection", ButtonKind::Default, ButtonSize::Normal, count == 0 || group.is_none(), cx).child(icon("forward", 15., theme.text1)).child("Forward").on_click(forward))
                    .when(can_delete, |el| el.child(button("delete-selection", ButtonKind::Danger, ButtonSize::Normal, false, cx).child(icon("trash", 15., theme.red)).child("Delete for everyone").on_click(delete))),
            )
            .into_any_element()
    }

    /// The autocomplete list over the message box (`.suggestions`).
    fn suggestion_list(&self, server_url: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let mut list = div()
            .id("suggestions")
            .occlude()
            .w(px(320.))
            .max_w(gpui::relative(0.9))
            .max_h(px(300.))
            .overflow_y_scroll()
            .track_scroll(&scroll_handle("suggestions"))
            .p(px(4.))
            .pr(px(4.) + gutter(&scroll_handle("suggestions")))
            .bg(theme.bg3)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(theme::RADIUS_L)
            .shadow(shadow_m());
        for (index, suggestion) in self.suggestions.iter().enumerate() {
            let picture: AnyElement = match &suggestion.what {
                Suggested::Emote(emote) => {
                    let url = format!("{server_url}/api/emotes/{}/2x.webp", emote.id);
                    let image = self.state.update(cx, |state, cx| state.remote_picture(&url, cx));
                    match image {
                        Some(image) => img(image).size(px(24.)).flex_none().object_fit(gpui::ObjectFit::Contain).id(SharedString::from(format!("suggested-emote-{index}"))).into_any_element(),
                        None => div().size(px(24.)).flex_none().into_any_element(),
                    }
                }
                Suggested::Person(user) => {
                    let image = user.avatar.as_ref().and_then(|avatar| match self.state.read(cx).pictures.get(&format!("file:{}", avatar.file_id)) {
                        Some(Picture::Ready(image)) => Some(image.clone()),
                        _ => None,
                    });
                    avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 24., online: false, rounded: false, dot_border: theme.bg3 }, cx).into_any_element()
                }
            };
            let chosen = self.selected == Some(index);
            list = list.child(
                div()
                    .id(SharedString::from(format!("suggestion-{}", suggestion.key)))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(9.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(RADIUS_S)
                    .text_size(px(13.5))
                    .cursor_pointer()
                    .when(chosen, |el| el.bg(theme.hover_strong))
                    .on_hover(cx.listener(move |view, hovered: &bool, _, cx| {
                        if *hovered && view.selected != Some(index) {
                            view.selected = Some(index);
                            cx.notify();
                        }
                    }))
                    .on_mouse_down(MouseButton::Left, cx.listener(move |view, _, window, cx| {
                        view.apply_suggestion(index, cx);
                        view.composer.read(cx).focus(window);
                    }))
                    .child(picture)
                    .child(div().min_w_0().one_line().child(suggestion.label.clone()))
                    .when_some(suggestion.hint.clone(), |el, hint| el.child(div().min_w_0().one_line().text_color(theme.text3).child(hint))),
            );
        }
        // `.suggestions`: rise-in 0.1s.
        div().absolute().left(px(14.)).right(px(14.)).bottom(gpui::relative(1.)).pb(px(6.)).child(list).enter("suggestions-in", Enter::Rise(5.), 100).into_any_element()
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
        let selection = state.selection.clone().filter(|(list, _)| *list == conversation.list_id());
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
            is_channel: conversation.kind == "channel",
            channel_title: conversation.title.clone(),
            channel_description: conversation.description.clone(),
            channel_id: conversation.group_id.clone(),
            is_server_admin: server.is_admin(),
            editing_id: if conversation.kind == "channel" { state.editing.get(&conversation.list_id()).map(|message| message.id.clone()) } else { None },
            inline_editor: (conversation.kind == "channel").then(|| self.inline_editor.clone()),
            selecting: selection.is_some(),
            selected: selection.map(|(_, ids)| ids.into_iter().collect()).unwrap_or_default(),
            members: conversation.members.iter().map(|member| member.user_id.clone()).collect(),
            read_by: conversation.read_by.clone(),
            parsed: Default::default(),
            video_slots: self.video_slots.clone(),
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
        // As `EmptyChat` words it.
        let (title, text) = if is_saved {
            ("Your saved messages".to_string(), "Keep notes, links and files here. They're encrypted and sync across your devices.".to_string())
        } else if conversation.kind == "group" {
            (conversation.title.clone(), "Messages here are end-to-end encrypted. Only members can read them.".to_string())
        } else {
            (format!("Say hello to {}", conversation.title), "Your messages are end-to-end encrypted. Not even this server can read them.".to_string())
        };
        // Someone not yet verified can be, from here.
        let verify = (!is_saved && conversation.kind != "group").then_some(()).and(peer.filter(|peer| peer.trust != "verified"));
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
                    .child(div().text_size(px(13.5)).child(text))
                    .when_some(verify, |el, peer| {
                        let state = self.state.clone();
                        el.child(
                            button("verify-empty", ButtonKind::Default, ButtonSize::Small, false, cx)
                                .mt(px(8.))
                                .child("Verify with emoji")
                                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Verify { user_id: peer.id.clone() }), cx))),
                        )
                    }),
            )
            .into_any_element()
    }
}

/// A file to go with the next message, with its size and, for a picture, a small preview for its chip.
fn stage_file(path: &std::path::Path) -> StagedFile {
    let file = file_for_sending(path);
    let name = file["name"].as_str().unwrap_or("file").to_string();
    let mime = file["mime"].as_str().unwrap_or("").to_string();
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let preview = (mime.starts_with("image/") && mime != "image/svg+xml")
        .then(|| std::fs::read(path).ok())
        .flatten()
        .and_then(|bytes| image::load_from_memory(&bytes).ok())
        .and_then(|picture| {
            let mut png = Vec::new();
            picture.thumbnail(72, 72).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
            Some(Arc::new(Image::from_bytes(gpui::ImageFormat::Png, png)))
        });
    StagedFile { file, name, size, preview }
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
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    };
    let path_text = path.to_string_lossy().into_owned();
    let mut file = json!({ "blob": crate::host::file(&path_text, mime), "name": name, "mime": mime });
    // Dimensions and a tiny blurred preview, as the desktop's prepareFile makes them.
    if mime.starts_with("image/") {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(image) = image::load_from_memory(&bytes) {
                file["width"] = json!(image.width());
                file["height"] = json!(image.height());
                if let Some((thumb, _, _)) = crate::host::shrink_image(&bytes, 48) {
                    file["thumb"] = json!(thumb);
                }
            }
        }
    } else if mime.starts_with("video/") || mime.starts_with("audio/") {
        // A video's length and size, and its picture from a moment in, at most 22 KB of it.
        if let Some(details) = crate::media::mf::details(path) {
            if let Some(duration) = details.duration {
                file["duration"] = json!(duration);
            }
            if let (Some(width), Some(height)) = (details.width, details.height) {
                file["width"] = json!(width);
                file["height"] = json!(height);
                let moment = (details.duration.unwrap_or(0.) / 3.).min(0.5);
                for (size, quality) in [(320, 65), (240, 55), (160, 50)] {
                    if let Some((jpeg, _, _)) = crate::media::mf::poster(path, moment, size, quality) {
                        use base64::Engine;
                        let data = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg));
                        if data.len() <= 22 << 10 {
                            file["thumb"] = json!(data);
                            break;
                        }
                    }
                }
            }
        }
    }
    file
}


impl ChatView {
    /// The messages, or the spinner or empty state in their place: what `MessageList` draws.
    pub fn render_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.video_slots.clear();
        let theme = theme(cx);
        let Some(conversation) = self.conversation(cx) else { return div().into_any_element() };
        let is_channel = conversation.kind == "channel";
        let list = self.state.read(cx).lists.get(&conversation.list_id()).map(|list| ListShape { loaded: list.loaded, empty: list.items.is_empty(), detached: list.detached });
        match &list {
            Some(list) if !list.loaded && list.empty => div().flex_1().flex().items_center().justify_center().child(spinner(18., theme.text2)).into_any_element(),
            Some(list) if list.empty => self.empty_chat(&conversation, cx),
            None => div().flex_1().into_any_element(),
            Some(_) => {
                // Built again only when the chat's state changed, not each frame: it copies
                // every message here and every person on the server.
                if self.context_cache.is_none() {
                    self.context_cache = self.chat_context(&conversation, cx).map(|(items, context)| (items, Rc::new(context)));
                }
                let Some((items, context)) = self.context_cache.clone() else { return div().into_any_element() };
                let count = items.len();
                if self.list.item_count() != count {
                    self.list.reset(count);
                }
                let items_for_rows = items.clone();
                // The glide to new messages, over 180 ms with `--ease-out`.
                if let Some((from, began)) = self.glide {
                    let t = began.elapsed().as_secs_f32() / 0.18;
                    if t >= 1. {
                        self.list.scroll_to(gpui::ListOffset { item_ix: count, offset_in_item: px(0.) });
                        self.glide = None;
                    } else {
                        let now_at = -f32::from(self.list.scroll_px_offset_for_scrollbar().y);
                        let end = f32::from(self.list.max_offset_for_scrollbar().height);
                        let target = from + (end - from) * super::motion::ease_out()(t);
                        self.list.scroll_by(px(target - now_at));
                        window.request_animation_frame();
                    }
                }
                let fresh = self.fresh.clone();
                // Where each drawn row is, for picking by dragging across them.
                self.row_bounds.borrow_mut().clear();
                let row_bounds = self.row_bounds.clone();
                let rows = gpui::list(self.list.clone(), move |index, window, cx| {
                    if index >= items_for_rows.len() {
                        return div().into_any_element();
                    }
                    let recorded = row_bounds.clone();
                    let row = div()
                        .relative()
                        .child(render_row(&items_for_rows, index, &context, window, cx))
                        .child(gpui::canvas(move |bounds, _, _| { recorded.borrow_mut().insert(index, bounds); }, |_, _, _, _| {}).absolute().inset_0());
                    let id = &items_for_rows[index].id;
                    if fresh.borrow().get(id).is_some_and(|at| at.elapsed() < std::time::Duration::from_millis(400)) {
                        row.enter(SharedString::from(format!("fresh-{id}")), Enter::Fade, 120).into_any_element()
                    } else {
                        row.into_any_element()
                    }
                })
                .size_full();
                let unread_below = if !self.at_bottom { conversation.unread as u32 } else { 0 };
                let raised = !self.at_bottom || list.as_ref().is_some_and(|list| list.detached);
                let mention_button = self.mention_button(&conversation, raised, cx);
                let jump_bar = (is_channel && raised).then(|| self.jump_present(&conversation, unread_below, cx));
                let list_state = self.list.clone();
                let detached = list.as_ref().is_some_and(|list| list.detached);
                let to_bottom_state = self.state.clone();
                let list_id = conversation.list_id();
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .on_mouse_down(MouseButton::Left, cx.listener(|view, event: &gpui::MouseDownEvent, _, cx| view.drag_start(event, cx)))
                    .on_mouse_move(cx.listener(|view, event: &gpui::MouseMoveEvent, _, cx| {
                        if event.pressed_button == Some(MouseButton::Left) && view.drag.is_some() {
                            view.drag_move(event.position.y, cx);
                        } else if view.drag.is_some() && event.pressed_button.is_none() {
                            view.drag = None;
                            view.drag_tick = None;
                        }
                    }))
                    .capture_any_mouse_up(cx.listener(|view, _: &gpui::MouseUpEvent, _, cx| view.drag_end(cx)))
                    .child(rows)
                    .child(scrollbar("chat-list", Scrolls::List(self.list.clone())).thin())
                    .when_some(mention_button, |el, button| el.child(button))
                    .when_some(jump_bar, |el, bar| el.child(bar))
                    .when(!is_channel && (!self.at_bottom || detached), |el| {
                        el.child(
                            super::motion::track_hover(div().id("to-bottom"), "to-bottom".into())
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
                                // `.to-bottom`: background 0.1s.
                                .child(super::motion::hover_layer("to-bottom", theme::color(theme::hex(0x45454b)), px(20.), 100))
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
                                })
                                .enter("to-bottom-in", Enter::Fade, 100),
                        )
                    })
                    .into_any_element()
            }
        }
    }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(conversation) = self.conversation(cx) else { return div().into_any_element() };
        self.mark_read(&conversation, cx);
        let is_channel = conversation.kind == "channel";
        for old in self.retired_frames.drain(..) {
            window.drop_image(old).ok();
        }
        self.sync_inline_editor(&conversation, window, cx);
        let header = if is_channel { self.channel_header(&conversation, cx) } else { self.header(&conversation, cx) };
        let (call, call_expanded) = if is_channel { (None, false) } else { self.call_area(&conversation, cx) };
        let state = self.state.read(cx);
        let panel = state.panel;
        let peer_changed = conversation
            .peer_id
            .as_ref()
            .and_then(|id| state.servers.get(&self.server_id).and_then(|s| s.users.get(id)))
            .is_some_and(|peer| peer.trust == "changed" && !peer.is_self);
        let body = gpui::AnyView::from(self.messages.clone()).cached(gpui::StyleRefinement::default().flex_1().min_h_0().min_w_0()).into_any_element();
        let selecting = self.state.read(cx).selection.as_ref().is_some_and(|(list, _)| *list == conversation.list_id());
        if selecting != self.was_selecting {
            // The check circles take room on the left, so every row is measured again.
            self.was_selecting = selecting;
            let count = self.list.item_count();
            self.list.splice(0..count, count);
            if selecting {
                window.focus(&self.focus);
            } else {
                self.composer.read(cx).focus(window);
            }
        }
        self.update_mentions(&conversation, cx);
        let composer = if selecting { self.selection_bar(&conversation, cx) } else { self.composer_area(&conversation, cx) };
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
        let typing_line = is_channel.then(|| self.channel_typing(&conversation, cx));
        let members = (is_channel && side_panel.is_none() && !self.state.read(cx).settings.hide_member_list).then(|| {
            let (state, server_id) = (self.state.clone(), self.server_id.clone());
            let view = self.member_view.get_or_insert_with(|| cx.new(|cx| MemberList::new(state, server_id, cx))).clone();
            gpui::AnyView::from(view).cached(gpui::StyleRefinement::default().flex_none().w(px(240.)).h_full()).into_any_element()
        });
        div()
            .size_full()
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
                                    .child(div().flex_1().min_w_0().child(format!(
                                        "{}'s security key changed. This can mean someone is intercepting this chat. Compare keys before sharing anything private.",
                                        conversation.title
                                    )))
                                    .child(button("verify", ButtonKind::Default, ButtonSize::Small, false, cx).child("Verify").on_click(move |_, _, cx| {
                                        state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Verify { user_id: user_id.clone() }), cx))
                                    })),
                            ),
                        )
                    })
                    .when_some(call, |el, call| el.child(call))
                    .when(!call_expanded, |el| el.child(body).child(super::media_views::VideoLayer::new(self.video_slots.clone())).child(composer))
                    .when_some(typing_line, |el, line| el.child(line)),
            )
            .when_some(side_panel, |el, panel| el.child(div().flex().flex_none().child(panel).enter("side-panel-in", Enter::Slide(8.), 120)))
            .when_some(members, |el, members| el.child(members))
            .relative()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|view, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && view.was_selecting {
                    let list_id = view.last_list_id.clone();
                    view.state.update(cx, |state, cx| state.toggle_selected(&list_id, None, cx));
                }
            }))
            .group("chat-drop")
            .on_drop(cx.listener(|view, paths: &ExternalPaths, _, cx| view.add_files(paths.paths().to_vec(), cx)))
            .child(
                // Shown only while files are dragged over the chat (`.drop-overlay`).
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme::color(theme::rgba(0, 0, 0, 0.7)))
                    .opacity(0.)
                    .group_drag_over::<ExternalPaths>("chat-drop", |style| style.opacity(1.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(4.))
                            .px(px(40.))
                            .py(px(26.))
                            .rounded(theme::RADIUS_L)
                            .border_1()
                            .border_dashed()
                            .border_color(theme.line_strong)
                            .text_color(theme.text1)
                            .child(div().mb(px(4.)).child(icon("upload", 26., theme.text2)))
                            .child(div().font_weight(FontWeight::MEDIUM).child("Drop to send"))
                            .child(div().text_size(px(13.)).text_color(theme.text2).child("Files are encrypted before they leave this device")),
                    ),
            )
            .into_any_element()
    }
}

#[allow(dead_code)]
fn unused(_: SharedString) {}
