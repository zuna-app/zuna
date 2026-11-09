//! The sidebar: the server's name, search, filters and the conversations
//! (packages/ui/src/features/shell/ConversationList.tsx).

mod rows;
mod channels;

use std::time::Duration;

use gpui::{
    AnyElement, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Render, SharedString, Styled, Subscription, Task, Window,
    div, prelude::*, px,
};
use gpui::Focusable as _;
use serde_json::json;

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::menu::{MenuEntry, open_menu};
use super::motion::{Enter, Motion};
use super::text_input::{InputEvent, TextInput};
use crate::format::format_list_time;
use crate::markup::plain_text;
use crate::models::{ChannelView, ConversationView, MessageView, SearchResult, UserView, VoiceMember};
use crate::state::{AppState, Overlay, ServerState, ToastKind};
use crate::theme::{Theme, RADIUS_M, RADIUS_S};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    All,
    Channels,
    People,
    Bots,
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
    /// From a key press until the message hits are in, so "Nothing matches" waits for them.
    search_pending: bool,
    search_focused: bool,
    /// The channel row under the pointer, whose edit button shows. It takes no room otherwise,
    /// as the web's is `display: none`, so a voice channel's limit sits at the row's end.
    hovered_channel: Option<String>,
    /// The server the list shows, so that switching servers lets go of this one's search.
    shown_server: Option<String>,
    /// The channel being dragged to another place, and the order the list shows meanwhile,
    /// which it keeps until the core has it.
    dragging: Option<String>,
    drag_order: Option<Vec<String>>,
    /// Whether the server's menu was open, for its name's chevron, last the menus changed.
    server_menu_open: bool,
    _subscriptions: Vec<Subscription>,
}

thread_local! {
    /// Each last message's text made plain for its row, by a hash of the text: every row is
    /// drawn again on every change to the app's state, and making it plain runs nine patterns.
    static PLAIN_PREVIEWS: std::cell::RefCell<std::collections::HashMap<u64, String>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// A message's text made plain, as its row shows it, at most 80 characters.
fn plain_preview(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    let key = hasher.finish();
    if let Some(found) = PLAIN_PREVIEWS.with(|previews| previews.borrow().get(&key).cloned()) {
        return found;
    }
    let plain: String = plain_text(text).chars().take(80).collect();
    PLAIN_PREVIEWS.with(|previews| {
        let mut previews = previews.borrow_mut();
        // Let go of all at once past a few thousand, which a server's rows never come to.
        if previews.len() > 4096 {
            previews.clear();
        }
        previews.insert(key, plain.clone());
    });
    plain
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
        plain_preview(&message.text)
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
        let menus = super::menu::menu_layer(cx);
        let mut subscriptions = vec![
            cx.observe(&state, |list, state, cx| {
                let server = state.read(cx).active_server.clone();
                if server != list.shown_server {
                    list.shown_server = server;
                    list.reset_search(cx);
                }
                cx.notify()
            }),
            cx.observe(&menus, |list, _, cx| {
                let open = super::menu::is_open_from("server-title", cx);
                if open != list.server_menu_open {
                    list.server_menu_open = open;
                    cx.notify();
                }
            }),
            // Whether the connection shows here, which follows who draws the title bar.
            cx.observe_window_appearance(window, |_, _, cx| cx.notify()),
            cx.subscribe_in(&search, window, |list, input, event, window, cx| match event {
                InputEvent::Changed => list.run_search(cx),
                InputEvent::Escape => {
                    input.update(cx, |input, cx| input.set_text("", cx));
                    window.blur(cx);
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
        let shown_server = state.read(cx).active_server.clone();
        ConversationList { state, search, filter: Filter::All, show_hidden: false, hits: Vec::new(), searching: None, search_pending: false, search_focused: false, hovered_channel: None, shown_server, dragging: None, drag_order: None, server_menu_open: false, _subscriptions: subscriptions }
    }

    pub fn focus_search(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.focus_handle(cx).focus(window, cx);
    }

    /// Another server's list starts with no search, as its hits and their ids belong to the
    /// server they came from.
    fn reset_search(&mut self, cx: &mut Context<Self>) {
        self.searching = None;
        self.search_pending = false;
        self.hits.clear();
        self.drag_order = None;
        self.hovered_channel = None;
        self.search.update(cx, |input, cx| input.set_text("", cx));
        // Another server's lists start at their top, not where this one's were.
        super::scrollbar::forget_scroll("conv-list");
        super::scrollbar::forget_scroll("member-list");
    }

    /// Message search runs against the encrypted index on this device.
    fn run_search(&mut self, cx: &mut Context<Self>) {
        let query = self.search.read(cx).text().trim().to_string();
        if query.chars().count() < 2 {
            self.hits.clear();
            self.searching = None;
            self.search_pending = false;
            cx.notify();
            return;
        }
        let state = self.state.clone();
        self.search_pending = true;
        self.searching = Some(cx.spawn(async move |list, cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            let call = state.update(cx, |state, _| {
                state.active_server.clone().map(|server| state.core.call(Some(&server), "search", vec![json!(query), crate::host::undefined(), json!(30)]))
            });
            let hits: Option<Vec<SearchResult>> = match call {
                Some(call) => call.await.ok().map(crate::models::from_value),
                None => None,
            };
            list.update(cx, |list, cx| {
                if let Some(hits) = hits {
                    list.hits = hits;
                }
                list.search_pending = false;
                cx.notify();
            })
            .ok();
        }));
    }

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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        // Without a title bar of the app's own, the connection shows here, as on the web.
        let status = if crate::platform::draws_title_bar(window) { None } else { connection_status(&server, &theme) };
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
                // The list of people stays the list of people: bots have a tab of their own, and one
                // somebody has written to is among the chats like any other.
                Filter::People => item.kind == "dm" && !item.bot,
                Filter::Bots => item.bot,
                Filter::Groups => item.kind == "group",
                Filter::Unread => (item.unread > 0. || item.marked_unread) && (!item.bot || item.group_id.is_some() || !query.is_empty()),
                Filter::All => !item.bot || item.group_id.is_some() || !query.is_empty(),
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
            .child({
                let (title_bounds, title_probe) = bounds_probe();
                // `.server-title`: background 0.1s.
                super::motion::track_hover(div().id("server-title"), "server-title".into())
                    .relative()
                    .child(title_probe)
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
                    .child(super::motion::hover_layer("server-title", theme.hover, RADIUS_M, 100))
                    .on_click(move |_, _, cx| {
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
                        // From the title's left edge, 4 px under it, as the web opens it.
                        let at = title_bounds.get();
                        super::menu::open_menu_from("server-title", gpui::point(at.left(), at.bottom() + px(4.)), entries, cx);
                    })
                    .child(div().min_w_0().one_line().child(server.entry.name.clone()))
                    // Turns over while the server's menu is open, as the menu drops down.
                    .child(super::motion::transition(
                        icon("chevron-down", 15., theme.text3),
                        "server-title-chevron",
                        if self.server_menu_open { 1. } else { 0. },
                        170,
                        super::motion::ease_out(),
                        |el, t| el.with_transformation(gpui::Transformation::rotate(gpui::radians(t * std::f32::consts::PI))),
                    ))
            })
            // `.sidebar-head .titlebar-status`.
            .children(status.map(|status| status.flex_none().text_size(px(12.)).pr(px(4.))))
            .child({
                let state = self.state.clone();
                icon_button("new-group", "square-pen", 17., false, false, cx)
                    .tip("New group", Side::Bottom)
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
        filters.push((Filter::People, "People"));
        if server.conversations.iter().any(|item| item.bot) {
            filters.push((Filter::Bots, "Bots"));
        }
        filters.extend([(Filter::Groups, "Groups"), (Filter::Unread, "Unread")]);
        // All six only fit the list at the width it starts with when they stand closer (`.is-tight`).
        let (gap, edge) = if filters.len() > 5 { (11., 12.) } else { (16., 14.) };
        let tabs = div().flex().flex_none().gap(px(gap)).px(px(edge)).border_b_1().border_color(theme.line).children(filters.into_iter().map(|(id, label)| {
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
        // A row moving when the order changes slides to its new place, as the web's do.
        let list_scroll = super::scrollbar::scroll_handle("conv-list");
        for item in &visible {
            rows.push(super::motion::sliding(format!("conv-{}", item.key), list_scroll.clone(), self.row(item, &server, window, cx)).into_any_element());
        }
        if !self.hits.is_empty() {
            rows.push(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).px(px(14.)).py(px(6.)).mt(px(6.)).child("Messages").into_any_element());
            for hit in self.hits.clone() {
                let conversation = server.find_conversation(&hit.conversation_key).map(|c| c.title.clone()).unwrap_or_else(|| "Conversation".into());
                let sender = server.users.get(&hit.message.sender_id).cloned();
                let picture = sender.as_ref().and_then(|sender| sender.avatar.clone()).and_then(|avatar| {
                    let server_id = server.entry.id.clone();
                    self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
                });
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
                                image: picture,
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
        if visible.is_empty() && hidden.is_empty() && self.hits.is_empty() && self.filter != Filter::Channels && !(self.search_pending && !query.is_empty()) {
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
                    .group("hidden-toggle")
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
                    // `.hidden-toggle svg`: turned a quarter when open, over 100 ms.
                    .child(super::motion::transition(icon("chevron-right", 14., theme.text3).group_hover("hidden-toggle", move |style| style.text_color(theme.text2)), "hidden-toggle-chevron", if open { 1. } else { 0. }, 100, super::motion::ease(), |el, t| el.with_transformation(gpui::Transformation::rotate(gpui::radians(t * std::f32::consts::FRAC_PI_2)))))
                    .child(format!("Hidden ({})", hidden.len()))
                    .into_any_element(),
            );
            if open {
                for item in &hidden {
                    rows.push(self.row(item, &server, window, cx));
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
            .child({
                let handle = scroll_handle("conv-list");
                div().id("conv-list").flex_1().min_h_0().overflow_y_scroll().track_scroll(&handle).pt(px(4.)).pb(px(8.)).pr(gutter(&handle)).children(rows).child(scrollbar("conv-list", Scrolls::Div(handle.clone())))
            })
            .into_any_element()
    }
}
