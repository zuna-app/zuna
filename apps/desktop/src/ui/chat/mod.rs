//! A conversation: its header, messages and message box
//! (packages/ui/src/features/chat/ChatView.tsx, MessageList.tsx and Composer.tsx).

mod header;
mod list;
mod select;
mod composer;
mod sending;
mod recording;
#[cfg(test)]
mod tests;

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
use gpui::Focusable as _;
use regex::Regex;
use serde_json::json;

use super::components::*;
use super::motion::{Enter, Motion};
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::message::{ChatContext, render_row};
use super::selection;
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
/// How wide a channel's member list is.
const MEMBERS_WIDTH: f32 = 240.;
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
    /// A message jumped to, which goes in the middle of the list once it's been measured,
    /// and whether the list has been laid out with it at the top yet.
    center_on: Option<(String, bool)>,
    last_typing: f64,
    revealed: Rc<RefCell<HashSet<String>>>,
    hovered_link: Rc<RefCell<Option<(SharedString, usize)>>>,
    side_panel: Option<Entity<SidePanel>>,
    /// When the member list came back as the side panel finished closing, to fade it in.
    members_back: Option<std::time::Instant>,
    /// The conversation someone's typed in since it was opened, after which its header's
    /// line fades between typing and the usual status, as `.chat-status.is-changing`.
    typed_in: RefCell<Option<String>>,
    /// Messages that arrived at the end while the chat was open, and when, which fade in as
    /// `.msg.is-fresh` does, for 400 ms.
    fresh: Rc<RefCell<HashMap<String, std::time::Instant>>>,
    /// The list moving to messages that arrived while it was at the newest, from where it
    /// was, as the web's list glides over 180 ms instead of jumping.
    glide: Option<(f32, std::time::Instant)>,
    /// The glide waited a frame for rows to be measured, which it doesn't do twice running.
    glide_waited: bool,
    /// The call this device is in, above the chat of its conversation.
    call_stage: Option<Entity<super::voice_stage::VoiceStage>>,
    /// The voice channel's stage this chat sits beside, as `ChatView`'s `voice`: no member
    /// list, a speaker for its name's #, and an × that hides it.
    pub beside_voice: Option<gpui::WeakEntity<super::voice_stage::VoiceStage>>,
    last_list_id: String,
    /// The list was a window reading on when its rows last changed, so rows added at its end
    /// are the page after, read into rather than moved to.
    reading_on: bool,
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
    last_seen_tick: Option<crate::ui::components::LastSeenTick>,
    /// Whether messages were being picked when last drawn: rows change width when it changes.
    was_selecting: bool,
    /// Files are being dragged over the chat, so "Drop to send" is shown.
    drop_over: bool,
    /// Holds focus while messages are picked, so Escape stops picking.
    focus: gpui::FocusHandle,
    inline_editor: Entity<TextInput>,
    /// The channel message being edited where it is.
    inline_editing: Option<String>,
    /// The message being edited in the message box, which was given its text.
    composer_editing: Option<String>,
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
    /// What the rows need, from the last time the chat's state changed. The messages aren't in
    /// it: each row reads its own and those beside it from the app's state as it's drawn.
    context_cache: Option<Rc<ChatContext>>,
    /// Messages' parsed text, which outlives each context: see `ChatContext::parsed`.
    parsed: Rc<RefCell<HashMap<String, (u64, Rc<Vec<crate::markup::Block>>)>>>,
    /// This chat's conversation as the state has it, taken once per change of the state rather
    /// than cloned on every frame, a channel's members and all.
    conversation_cache: RefCell<Option<Rc<ConversationView>>>,
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
    /// A window around an old message that hasn't read on to the newest yet.
    reading_on: bool,
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

/// Everyone on the server, as Discord lists a channel's members: online first, then the rest, faded.
/// A bot only reads the channels it was given, so the bots listed are the ones in the channel
/// that's open, in a group of their own.
fn member_list(state_entity: &Entity<AppState>, server_id: &str, cx: &mut gpui::App) -> AnyElement {
    let theme = theme(cx);
    let state = state_entity.read(cx);
    let Some(server) = state.servers.get(server_id) else { return div().into_any_element() };
    // Each name lowercased once rather than at every comparison, and sorted before being copied.
    let mut users: Vec<&UserView> = server.users.values().filter(|user| !user.banned && !user.deleted).collect();
    users.sort_by_cached_key(|user| user.display_name.to_lowercase());
    let in_channel: std::collections::HashSet<&String> = server.active_key.as_deref().and_then(|key| server.find_conversation(key)).map(|chat| chat.members.iter().map(|member| &member.user_id).collect()).unwrap_or_default();
    let (bots, users): (Vec<&UserView>, Vec<&UserView>) = users.into_iter().partition(|user| user.bot.is_some());
    let bots: Vec<UserView> = bots.into_iter().filter(|bot| in_channel.contains(&bot.id)).cloned().collect();
    let (online, offline): (Vec<UserView>, Vec<UserView>) = users.into_iter().cloned().partition(|user| user.online || user.is_self);
    let server_id = server_id.to_string();
    let members_scroll = scroll_handle("member-list");
    let mut list = div().id("member-list").size_full().overflow_y_scroll().track_scroll(&members_scroll).pr(gutter(&members_scroll)).pb(px(20.)).bg(theme.bg1).border_l_1().border_color(theme.line);
    for (title, people, here) in [("Bots", bots, true), ("Online", online, true), ("Offline", offline, false)] {
        if people.is_empty() {
            continue;
        }
        list = list.child(div().h(px(40.)).pt(px(24.)).pr(px(8.)).pl(px(16.)).text_size(px(12.)).line_height(px(16.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.channel_muted).child(format!("{} — {}", title.to_uppercase(), people.len())));
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
                    .child(avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 32., online: user.bot.is_none() && (here && !user.is_self || user.online), rounded: false, dot_border: theme.bg1 }, cx))
                    .child(div().flex_none().max_w(px(if user.role == "owner" { 140. } else { 164. })).one_line().text_size(px(16.)).line_height(px(20.)).font_weight(FontWeight::MEDIUM).text_color(theme::css(crate::format::name_color(&user.id))).child(user.display_name.clone()))
                    .when(user.bot.is_some(), |el| el.child(div().flex_none().ml(px(-4.)).child(bot_badge(cx))))
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
        // Each chat's message box scrolls on its own.
        super::scrollbar::forget_scroll("composer-scroll");
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
        let media_clock = state.read(cx).media_clock.clone();
        let subscriptions = vec![
            cx.observe(&state, |view, _, cx| {
                view.context_cache = None;
                view.conversation_cache.replace(None);
                view.sync_rows(cx);
                view.refresh_messages(cx);
                cx.notify();
            }),
            // Something playing moves its own time and waveform, and nothing else here.
            cx.observe(&media_clock, |view, _, cx| view.refresh_messages(cx)),
            cx.subscribe_in(&composer, window, |view, _, event, window, cx| view.on_composer(event, window, cx)),
            cx.subscribe_in(&inline_editor, window, |view, _, event, _, cx| view.on_inline_editor(event, cx)),
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
            center_on: None,
            last_typing: 0.,
            revealed: Rc::new(RefCell::new(HashSet::new())),
            hovered_link: Rc::default(),
            side_panel: None,
            members_back: None,
            typed_in: RefCell::new(None),
            fresh: Rc::new(RefCell::new(HashMap::new())),
            glide: None,
            glide_waited: false,
            call_stage: None,
            beside_voice: None,
            last_list_id: String::new(),
            reading_on: false,
            drop_over: false,
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
            last_seen_tick: None,
            was_selecting: false,
            focus: cx.focus_handle(),
            inline_editor,
            inline_editing: None,
            composer_editing: None,
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
            parsed: Rc::default(),
            conversation_cache: RefCell::new(None),
            member_view: None,
            video_slots: Default::default(),
            _subscriptions: subscriptions,
        };
        view.open(window, cx);
        view
    }

    /// Moves to the newest message and tells the chat it's there, as the list's own scrolling
    /// would: the button for it goes, and what's there counts as read.
    fn to_newest(&mut self, cx: &mut Context<Self>) {
        let count = self.list.item_count();
        self.list.scroll_to(gpui::ListOffset { item_ix: count, offset_in_item: px(0.) });
        self.at_bottom = true;
        self.refresh_messages(cx);
        cx.notify();
    }

    /// Has the messages drawn again on the next frame, for a change in what they show.
    /// Never during a draw, when it would only take effect a frame late.
    pub fn refresh_messages(&self, cx: &mut Context<Self>) {
        self.messages.update(cx, |_, cx| cx.notify());
    }

    pub fn composer_has_focus(&self) -> bool {
        self.composer_focused
    }

    pub fn focus_composer(&self, window: &mut Window, cx: &mut gpui::App) {
        if !self.was_selecting {
            self.composer.focus_handle(cx).focus(window, cx);
        }
    }

    /// Typing that had nowhere to go: the message box takes focus and what was typed, or
    /// what's pasted. False while messages are being picked, when it has no message box.
    pub fn type_into_composer(&mut self, text: Option<&str>, paste: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.was_selecting {
            return false;
        }
        self.composer.focus_handle(cx).focus(window, cx);
        self.composer.update(cx, |input, cx| {
            if let Some(text) = text {
                input.insert(text, window, cx);
            }
            if paste {
                input.paste(&super::text_input::Paste, window, cx);
            }
        });
        true
    }

    fn conversation(&self, cx: &gpui::App) -> Option<Rc<ConversationView>> {
        if let Some(cached) = self.conversation_cache.borrow().as_ref() {
            return Some(cached.clone());
        }
        let found = self.state.read(cx).servers.get(&self.server_id).and_then(|server| server.find_conversation(&self.key)).cloned().map(Rc::new);
        self.conversation_cache.replace(found.clone());
        found
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
        self.composer.focus_handle(cx).focus(window, cx);
    }

}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(conversation) = self.conversation(cx) else { return div().into_any_element() };
        self.mark_read(&conversation, cx);
        let is_channel = conversation.kind == "channel";
        // Files dragged out of the window, or dropped, take "Drop to send" with them.
        if self.drop_over && !cx.has_active_drag() {
            self.drop_over = false;
        }
        for old in self.retired_frames.drain(..) {
            window.drop_image(old).ok();
        }
        self.sync_inline_editor(&conversation, window, cx);
        self.sync_composer_editing(&conversation, window, cx);
        let header = if is_channel { self.channel_header(&conversation, cx) } else { self.header(&conversation, cx) };
        // The header's last seen, while it shows one, is kept true as the minutes pass.
        let last_seen = conversation.peer_id.as_ref().filter(|_| conversation.kind == "dm").and_then(|id| self.state.read(cx).servers.get(&self.server_id)?.users.get(id)).filter(|peer| !peer.online && !peer.deleted && !peer.banned && !peer.is_self).map(|peer| (peer.last_seen_at, peer.hides_last_seen));
        let (seen_at, seen_hidden) = last_seen.unwrap_or((None, true));
        crate::ui::components::redraw_last_seen(&mut self.last_seen_tick, seen_at, seen_hidden, cx);
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
                window.focus(&self.focus, cx);
            } else {
                self.composer.focus_handle(cx).focus(window, cx);
            }
        }
        self.update_mentions(&conversation, cx);
        let composer = if selecting { self.selection_bar(&conversation, cx) } else { self.composer_area(&conversation, cx) };
        // A video message's preview is pulled each frame while it records, which nothing else
        // asks for once Reduce motion stops the red dot's pulse.
        if matches!(self.recording, Some(Recording::Round(_))) {
            window.request_animation_frame();
        }
        // The panel opens by growing from the right edge, its content sliding in with that
        // edge as the chat narrows, and closes the same way back. In a channel it grows from
        // the member list it takes the place of, and the list fades back in after it.
        let has_members = is_channel && self.beside_voice.is_none() && !self.state.read(cx).settings.hide_member_list;
        let closed_width = if has_members { MEMBERS_WIDTH } else { 0. };
        let target = if panel.is_some() { super::side_panel::WIDTH } else { closed_width };
        let (panel_width, panel_moving) = super::motion::tween(format!("side-panel-{}", cx.entity_id()), target, if panel.is_some() { 260 } else { 200 }, super::motion::ease_out(), window);
        let panel_closing = panel.is_none() && panel_moving && self.side_panel.is_some();
        if panel.is_some() {
            if self.side_panel.is_none() {
                let state = self.state.clone();
                let server_id = self.server_id.clone();
                let key = self.key.clone();
                self.side_panel = Some(cx.new(|cx| SidePanel::new(state, server_id, key, window, cx)));
            }
        } else if !panel_closing && self.side_panel.take().is_some() && has_members && !super::motion::reduced_or_system() {
            self.members_back = Some(std::time::Instant::now());
        }
        let side_panel = self.side_panel.clone().map(|view| {
            // Faded by how far it's grown past the member list, which it covers at once.
            let shown = if closed_width > 0. { ((panel_width - closed_width) / (super::side_panel::WIDTH - closed_width)).clamp(0., 1.) } else { 1. };
            div()
                .flex_none()
                .h_full()
                .w(px(panel_width))
                .overflow_hidden()
                .flex()
                .child(div().flex_none().h_full().opacity(shown).child(view))
                .when(panel_closing, |el| el.child(div().id("side-panel-closing").absolute().inset_0().occlude()))
                .relative()
                .into_any_element()
        });
        let state = self.state.clone();
        let user_id = conversation.peer_id.clone().unwrap_or_default();
        let typing_line = is_channel.then(|| self.channel_typing(&conversation, cx));
        let members = (has_members && side_panel.is_none()).then(|| {
            let (state, server_id) = (self.state.clone(), self.server_id.clone());
            let view = self.member_view.get_or_insert_with(|| cx.new(|cx| MemberList::new(state, server_id, cx))).clone();
            match self.members_back {
                // Drawn afresh each frame as it fades in: cached, it would keep the paint of
                // its first, faint frame.
                Some(since) if since.elapsed() < std::time::Duration::from_millis(160) => {
                    div().flex_none().w(px(MEMBERS_WIDTH)).h_full().child(gpui::AnyView::from(view)).enter_since(since, Enter::Fade, 160, window).into_any_element()
                }
                _ => {
                    self.members_back = None;
                    gpui::AnyView::from(view).cached(gpui::StyleRefinement::default().flex_none().w(px(MEMBERS_WIDTH)).h_full()).into_any_element()
                }
            }
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
                                    .text_color(theme.amber_text)
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
            .when_some(side_panel, |el, panel| el.child(panel))
            .when_some(members, |el, members| el.child(members))
            .relative()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|view, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && view.was_selecting {
                    let list_id = view.last_list_id.clone();
                    view.state.update(cx, |state, cx| state.toggle_selected(&list_id, None, cx));
                }
            }))
            .on_drag_move(cx.listener(|view, event: &gpui::DragMoveEvent<ExternalPaths>, _, cx| {
                let over = event.bounds.contains(&event.event.position);
                if over != view.drop_over {
                    view.drop_over = over;
                    cx.notify();
                }
            }))
            .on_drop(cx.listener(|view, paths: &ExternalPaths, _, cx| {
                view.drop_over = false;
                view.add_files(paths.paths().to_vec(), cx);
            }))
            .when(self.drop_over, |el| {
                el.child(
                    // Shown only while files are dragged over the chat, fading in over 80 ms as `.drop-overlay`.
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(theme::color(theme::rgba(0, 0, 0, 0.7)))
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
                        )
                        .enter("drop-overlay", Enter::Fade, 80),
                )
            })
            .into_any_element()
    }
}
