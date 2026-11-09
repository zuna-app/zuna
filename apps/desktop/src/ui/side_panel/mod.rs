//! A chat's details, its search and its pins, beside it (packages/ui/src/features/chat/SidePanel.tsx).

mod info;
mod media;
mod group;

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
    /// The chat's pinned messages, or None while the first answer is on its way.
    pins: Option<Vec<MessageView>>,
    /// Which of the loaded messages were pinned when the pins were last asked for, so
    /// that pinning or unpinning one asks again, as the web does.
    pins_for: Option<String>,
    searching: Option<Task<()>>,
    /// From a key press until its results are in, so "No messages match" waits for them.
    search_pending: bool,
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
    /// What `conversation` gives, until the state changes.
    snapshot: std::cell::RefCell<Option<(std::rc::Rc<ServerState>, std::rc::Rc<ConversationView>)>>,
    last_seen_tick: Option<crate::ui::components::LastSeenTick>,
    _subscriptions: Vec<Subscription>,
}

/// How wide the panel is.
pub const WIDTH: f32 = 320.;

impl SidePanel {
    pub fn new(state: Entity<AppState>, server_id: String, key: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| TextInput::new(cx, "Search messages"));
        let subscriptions = vec![
            cx.observe(&state, |panel, _, cx| {
                panel.snapshot.replace(None);
                cx.notify();
            }),
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
            pins_for: None,
            searching: None,
            search_pending: false,
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
            snapshot: std::cell::RefCell::new(None),
            last_seen_tick: None,
            _subscriptions: subscriptions,
        }
    }

    /// The server and this panel's conversation, copied once per change of the state rather
    /// than on every frame the panel is drawn.
    fn conversation(&self, cx: &gpui::App) -> Option<(std::rc::Rc<ServerState>, std::rc::Rc<ConversationView>)> {
        if let Some(snapshot) = self.snapshot.borrow().as_ref() {
            return Some(snapshot.clone());
        }
        let state = self.state.read(cx);
        let server = state.servers.get(&self.server_id)?;
        let conversation = server.find_conversation(&self.key)?.clone();
        let snapshot = (std::rc::Rc::new(server.clone()), std::rc::Rc::new(conversation));
        self.snapshot.replace(Some(snapshot.clone()));
        Some(snapshot)
    }

    fn run_search(&mut self, cx: &mut Context<Self>) {
        let query = self.search.read(cx).text().trim().to_string();
        let Some((_, conversation)) = self.conversation(cx) else { return };
        let Some(group) = conversation.group_id.clone() else { return };
        if query.chars().count() < 2 {
            self.results.clear();
            self.searching = None;
            self.search_pending = false;
            cx.notify();
            return;
        }
        let call = self.state.read(cx).core.call(Some(&self.server_id), "search", vec![json!(query), json!(group), json!(50)]);
        self.search_pending = true;
        self.searching = Some(cx.spawn(async move |panel, cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            let results = call.await;
            panel
                .update(cx, |panel, cx| {
                    panel.results = results.map(crate::models::from_value).unwrap_or_default();
                    panel.search_pending = false;
                    cx.notify();
                })
                .ok();
        }));
    }

    fn load_pins(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else { return };
        let pinned = self.state.read(cx).lists.get(&group).map(|list| list.items.iter().filter(|item| item.pinned_at.is_some()).map(|item| item.id.as_str()).collect::<Vec<_>>().join(",")).unwrap_or_default();
        if self.pins_for.as_deref() == Some(pinned.as_str()) {
            return;
        }
        self.pins_for = Some(pinned);
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

    fn result_row(&self, message: &MessageView, server: &ServerState, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let sender = server.users.get(&message.sender_id).cloned();
        let name = sender.as_ref().map(|s| s.display_name.clone()).unwrap_or_else(|| "Unknown".into());
        let picture = sender.as_ref().and_then(|sender| sender.avatar.clone()).and_then(|avatar| {
            let server_id = server.entry.id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
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
            .child(avatar(AvatarProps { name: name.clone(), seed: message.sender_id.clone(), image: picture, size: 32., online: false, rounded: false, dot_border: theme.bg1 }, cx))
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
                if results.is_empty() && !self.search_pending && self.search.read(cx).text().trim().chars().count() >= 2 {
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
                // Nothing while the first answer is on its way, rather than a moment of "nothing pinned".
                if self.pins.is_none() {
                    Vec::new()
                } else if pins.is_empty() {
                    vec![div().p(px(30.)).flex().flex_col().items_center().gap(px(6.)).text_color(theme.text2).child(icon("pin", 22., theme.text3)).child("Nothing is pinned yet. Right-click a message to pin it.").into_any_element()]
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
