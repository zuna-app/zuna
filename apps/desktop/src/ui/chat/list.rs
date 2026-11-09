//! The message list: keeping its rows, scrolling and reading, unread mentions, and what
//! shows in place of messages.

use super::*;

impl ChatView {
    /// The messages, or the spinner or empty state in their place: what `MessageList` draws.
    pub fn render_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.video_slots.clear();
        let theme = theme(cx);
        let Some(conversation) = self.conversation(cx) else { return div().into_any_element() };
        let is_channel = conversation.kind == "channel";
        let list = self.state.read(cx).lists.get(&conversation.list_id()).map(|list| ListShape { loaded: list.loaded, empty: list.items.is_empty(), reading_on: list.detached && list.has_newer });
        match &list {
            Some(list) if !list.loaded && list.empty => div().flex_1().flex().items_center().justify_center().child(spinner(18., theme.text2)).into_any_element(),
            Some(list) if list.empty => self.empty_chat(&conversation, cx),
            None => div().flex_1().into_any_element(),
            Some(_) => {
                // Kept between frames, as it copies every person on the server, and built again
                // after anything in the app's state changes, however far from this chat.
                if self.context_cache.is_none() {
                    self.context_cache = self.chat_context(&conversation, cx).map(Rc::new);
                }
                let Some(context) = self.context_cache.clone() else { return div().into_any_element() };
                let list_id = conversation.list_id();
                let count = self.state.read(cx).lists.get(&list_id).map_or(0, |list| list.items.len());
                if self.list.item_count() != count {
                    self.list.reset(count);
                }
                let rows_state = self.state.clone();
                // A message jumped to, in the middle as the web's list puts it, or at the top
                // if it's taller than the list. It waits a frame at the top, where it's measured,
                // and so are the rows above it in the list's overdraw, which moving it counts on.
                // Where the list's end put it lower down, it stays.
                if let Some((id, laid_out)) = self.center_on.take() {
                    match self.rows.iter().position(|(row, _)| *row == id) {
                        Some(_) if !laid_out => {
                            self.center_on = Some((id, true));
                            window.request_animation_frame();
                        }
                        Some(index) => {
                            if let Some(bounds) = self.list.bounds_for_item(index) {
                                let view = self.list.viewport_bounds();
                                self.list.scroll_by((bounds.center().y - view.center().y).min(bounds.top() - view.top()));
                            }
                        }
                        None => {}
                    }
                }
                // The glide to new messages, over 180 ms with `--ease-out`.
                if let Some((from, began)) = self.glide {
                    let t = began.elapsed().as_secs_f32() / 0.18;
                    // A row from the top down that's new or changed counts as no height until
                    // it's laid out, which would move the end, and the glide with it, up by its
                    // height for a frame: the rows above seemed to jump down and back as a
                    // message went from sending to sent. It waits a frame for them instead.
                    let top = self.list.logical_scroll_top().item_ix;
                    let unmeasured = (top..count).any(|ix| self.list.bounds_for_item(ix).is_none());
                    if t >= 1. {
                        self.list.scroll_to(gpui::ListOffset { item_ix: count, offset_in_item: px(0.) });
                        self.glide = None;
                        self.glide_waited = false;
                    } else if unmeasured && !self.glide_waited {
                        self.glide_waited = true;
                        window.request_animation_frame();
                    } else {
                        self.glide_waited = false;
                        let now_at = -f32::from(self.list.scroll_px_offset_for_scrollbar().y);
                        let end = f32::from(self.list.max_offset_for_scrollbar().y);
                        let target = from + (end - from) * crate::ui::motion::ease_out()(t);
                        self.list.scroll_by(px(target - now_at));
                        window.request_animation_frame();
                    }
                }
                let fresh = self.fresh.clone();
                // Where each drawn row is, for picking by dragging across them, and its text, for selecting it.
                self.row_bounds.borrow_mut().clear();
                selection::forget_pieces();
                let row_bounds = self.row_bounds.clone();
                let rows = gpui::list(self.list.clone(), move |index, window, cx| {
                    // The message and those beside it, which is all a row looks at, read from the
                    // app's state as it's drawn: copying every message for each change cost a
                    // dropped frame each time a page of older messages came in.
                    let near = rows_state.read(cx).lists.get(&list_id).filter(|list| index < list.items.len()).map(|list| {
                        let start = index.saturating_sub(1);
                        (list.items[start..(index + 2).min(list.items.len())].to_vec(), index - start)
                    });
                    let Some((near, at)) = near else { return div().into_any_element() };
                    let recorded = row_bounds.clone();
                    let row = div()
                        .relative()
                        .child(render_row(&near, at, &context, window, cx))
                        .child(gpui::canvas(move |bounds, _, _| { recorded.borrow_mut().insert(index, bounds); }, |_, _, _, _| {}).absolute().inset_0());
                    let since = fresh.borrow().get(&near[at].id).copied();
                    match since {
                        Some(since) => row.enter_since(since, Enter::Fade, 120, window).into_any_element(),
                        None => row.into_any_element(),
                    }
                })
                .size_full();
                let chat = cx.entity().downgrade();
                let settle = gpui::canvas(move |_, _, cx| cx.defer(move |cx| chat.update(cx, |view, cx| view.settle_scroll(cx)).unwrap_or(())), |_, _, _, _| {}).absolute().size_0();
                let unread_below = if !self.at_bottom { conversation.unread as u32 } else { 0 };
                let raised = !self.at_bottom || list.as_ref().is_some_and(|list| list.reading_on);
                let mention_button = self.mention_button(&conversation, raised, cx);
                let jump_bar = (is_channel && raised).then(|| self.jump_present(&conversation, unread_below, cx));
                let detached = list.as_ref().is_some_and(|list| list.reading_on);
                let to_bottom_state = self.state.clone();
                let list_id = conversation.list_id();
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|view, event: &gpui::MouseDownEvent, _, cx| {
                            view.select_start(event, cx);
                            view.drag_start(event, cx);
                        }),
                    )
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
                    // After the rows are laid out, where they ended up.
                    .child(settle)
                    .child(self.selecting_text(cx))
                    .child(scrollbar("chat-list", Scrolls::List(self.list.clone())).thin())
                    .when_some(mention_button, |el, button| el.child(button))
                    .when_some(jump_bar, |el, bar| el.child(bar))
                    .when(!is_channel && (!self.at_bottom || detached), |el| {
                        el.child(
                            crate::ui::motion::track_hover(div().id("to-bottom"), "to-bottom".into())
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
                                .child(crate::ui::motion::hover_layer("to-bottom", theme.bg5_hover, px(20.), 100))
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    if detached {
                                        to_bottom_state.update(cx, |state, cx| state.return_to_latest(&list_id, cx));
                                    } else {
                                        view.to_newest(cx);
                                    }
                                }))
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

impl ChatView {
    /// Keeps the list's rows matching the messages, re-measuring only those that changed.
    pub(super) fn sync_rows(&mut self, cx: &mut Context<Self>) {
        let Some(conversation) = self.conversation(cx) else { return };
        let list_id = conversation.list_id();
        if list_id != self.last_list_id {
            // The first message of a direct message moved its list to the new group, whose
            // messages are loaded as the web's list loads whenever its id changes. Without
            // this the chat kept showing it was empty while its messages came in.
            self.last_list_id = list_id.clone();
            let group_id = conversation.group_id.clone();
            self.state.update(cx, |state, cx| state.load_list(&list_id, group_id, cx));
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
        let paging = std::mem::replace(&mut self.reading_on, list.detached && list.has_newer);
        if new_rows == self.rows {
            // A jump to a message that's already loaded changes no rows.
            self.jump_if_asked(cx);
            return;
        }
        let old = std::mem::take(&mut self.rows);
        let old_ids: Vec<&String> = old.iter().map(|(id, _)| id).collect();
        let new_ids: Vec<&String> = new_rows.iter().map(|(id, _)| id).collect();
        if old.is_empty() {
            self.list.reset(new_rows.len());
            // Opening at the first unread message, as Telegram does. Not at the newest, so only
            // what's on screen counts as read until the list is laid out and says where it is.
            if let Some(Some(first)) = &self.unread_line {
                if let Some(index) = new_rows.iter().position(|(id, _)| id == first) {
                    self.list.scroll_to(gpui::ListOffset { item_ix: index, offset_in_item: px(0.) });
                    self.at_bottom = false;
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
            if !added.is_empty() && paging {
                // The page after the window's end, which stays where it is to be read on into.
                // At its end the list keeps no top of its own, and would follow the page down.
                if self.list.logical_scroll_top().item_ix >= self.list.item_count() {
                    let height = self.list.viewport_bounds().size.height;
                    self.list.scroll_by(-height);
                }
            } else if !added.is_empty() {
                let now = std::time::Instant::now();
                {
                    let mut fresh = self.fresh.borrow_mut();
                    fresh.retain(|_, at| now - *at < std::time::Duration::from_millis(400));
                    for id in &added {
                        fresh.insert(id.clone(), now);
                    }
                }
                if self.at_bottom && !crate::ui::motion::reduced_or_system() {
                    // Held where it shows now, so the new rows come in below it, then moved to
                    // them from there. At its end the list keeps no top of its own, so it's given
                    // the one it shows, a glide still going or not: the top it says it has there
                    // is a view's height further down, and a glide from it slid the messages up
                    // towards the chat's start and back, as two came in close together.
                    if self.list.logical_scroll_top().item_ix >= self.list.item_count() {
                        let height = self.list.viewport_bounds().size.height;
                        self.list.scroll_by(-height);
                    }
                    let from = -f32::from(self.list.scroll_px_offset_for_scrollbar().y);
                    self.glide = Some((from, now));
                }
            }
            self.list.splice(old.len()..old.len(), new_rows.len() - old.len());
            // Neighbors change shape when a message joins their run.
            if !added.is_empty() && old.len() > 0 {
                self.list.splice(old.len() - 1..old.len(), 1);
            }
        } else if new_ids.len() >= old_ids.len() && new_ids[new_ids.len() - old_ids.len()..] == old_ids[..] {
            // Older messages loaded above.
            let added = new_ids.len() - old_ids.len();
            self.list.splice(0..0, added);
            self.list.splice(added..added + 1, 1);
        } else {
            // At the newest again, so no glide is left to go there.
            self.list.reset(new_rows.len());
            self.glide = None;
        }
        self.rows = new_rows;
        self.jump_if_asked(cx);
    }

    pub(super) fn jump_if_asked(&mut self, cx: &mut Context<Self>) {
        let Some((group, id, nonce)) = self.state.read(cx).jump_target.clone() else { return };
        if group != self.last_list_id {
            return;
        }
        let Some(index) = self.rows.iter().position(|(row, _)| *row == id) else { return };
        // Only this once: the rows changing later, as a message comes in, aren't another jump.
        self.state.update(cx, |state, _| state.jump_target = None);
        self.glide = None;
        // At the top first, where the rows above it are measured, and in the middle from there.
        self.list.scroll_to(gpui::ListOffset { item_ix: index, offset_in_item: px(0.) });
        self.center_on = Some((id.clone(), false));
        self.highlight = Some((id, nonce));
        self.context_cache = None;
        self.refresh_messages(cx);
        cx.notify();
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(1500)).await;
            view.update(cx, |view, cx| {
                // A later jump keeps its own highlight.
                if view.highlight.as_ref().is_some_and(|(_, seen)| *seen == nonce) {
                    view.highlight = None;
                    view.context_cache = None;
                    view.refresh_messages(cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn on_scroll(&mut self, visible: std::ops::Range<usize>, scrolled: bool, cx: &mut Context<Self>) {
        self.at_bottom = !scrolled;
        let Some(conversation) = self.conversation(cx) else { return };
        let list_id = conversation.list_id();
        // Older messages, well before the top is reached.
        if visible.start < 15 {
            self.state.update(cx, |state, cx| state.load_older(&list_id, cx));
        }
        // And newer ones before the end of a window around an old message.
        if visible.end + 15 > self.rows.len() && self.reading_on {
            self.state.update(cx, |state, cx| state.load_newer(&list_id, cx));
        }
        self.note_visible(visible, &list_id, cx);
        self.refresh_messages(cx);
        cx.notify();
    }

    /// The rows on screen, and the newest message among them, which is as far as is read away
    /// from the newest.
    pub(super) fn note_visible(&mut self, visible: std::ops::Range<usize>, list_id: &str, cx: &gpui::App) {
        if let Some(list) = self.state.read(cx).lists.get(list_id) {
            let newest = list.items[visible.start.min(list.items.len())..visible.end.min(list.items.len())]
                .iter()
                .filter(|item| !item.id.starts_with("sys-"))
                .filter_map(|item| item.seq)
                .fold(0., f64::max);
            self.visible_newest = newest;
        }
        self.visible = visible;
    }

    /// Where the list was laid out, which it reaches or leaves without being scrolled: sending
    /// from older messages takes it to the newest, a quote clicked takes it up to the message
    /// quoted, and it opens at the first unread one. The button down to the newest and what
    /// counts as read follow that as they follow scrolling, a frame later.
    pub(super) fn settle_scroll(&mut self, cx: &mut Context<Self>) {
        // A glide or a jump still moving says where it ends itself.
        if self.glide.is_some() || self.center_on.is_some() {
            return;
        }
        let top = -f32::from(self.list.scroll_px_offset_for_scrollbar().y);
        let end = f32::from(self.list.max_offset_for_scrollbar().y);
        let at_bottom = top >= end - 1.;
        let drawn = {
            let rows = self.row_bounds.borrow();
            rows.keys().min().zip(rows.keys().max()).map(|(first, last)| *first..*last + 1)
        };
        let read_before = self.visible_newest;
        if let Some(drawn) = drawn {
            let list_id = self.last_list_id.clone();
            self.note_visible(drawn, &list_id, cx);
        }
        if at_bottom != self.at_bottom {
            self.at_bottom = at_bottom;
            self.refresh_messages(cx);
            cx.notify();
        } else if self.visible_newest != read_before {
            cx.notify();
        }
    }

    pub(super) fn mark_read(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let Some(group) = conversation.group_id.clone() else { return };
        let Some(list) = state.lists.get(&group) else { return };
        // The list is in order, so the newest is found from the end, as this runs every frame.
        let newest = list.items.iter().rev().filter(|item| !item.id.starts_with("sys-")).find_map(|item| item.seq).unwrap_or(0.);
        let up_to = if self.at_bottom && !(list.detached && list.has_newer) { newest } else { self.visible_newest };
        // Read as Telegram's desktop app reads (`MainWindow::markingAsRead`): only while the person
        // is here to see it, not in a minimized window, nor one left in front with nobody at it for
        // 30 s, nor under a dialog. They read it once they're back (`watch_activity`).
        if up_to > conversation.own_read && state.overlay.is_none() && state.person_here() {
            self.state.update(cx, |state, cx| state.mark_read(&group, up_to, cx));
        }
    }

    /// Back to the newest messages from a channel's older ones: a bar along the bottom of the list.
    pub(super) fn jump_present(&self, conversation: &ConversationView, unread_below: u32, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let first_unread = self.unread_line.clone().flatten().and_then(|id| self.state.read(cx).lists.get(&conversation.list_id()).and_then(|list| list.items.iter().find(|item| item.id == id).map(|item| item.created_at)));
        let text = if unread_below > 0 {
            let count = if unread_below > 99 { "99+".to_string() } else { unread_below.to_string() };
            let since = first_unread.map(|at| format!(" since {}", crate::format::format_time(at))).unwrap_or_default();
            format!("{count} new {}{since}", if unread_below == 1 { "message" } else { "messages" })
        } else {
            "You're viewing older messages".to_string()
        };
        let state = self.state.clone();
        let list_id = conversation.list_id();
        let detached = self.state.read(cx).lists.get(&list_id).is_some_and(|list| list.detached && list.has_newer);
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
            .on_click(cx.listener(move |view, _, _, cx| {
                if detached {
                    state.update(cx, |state, cx| state.return_to_latest(&list_id, cx));
                } else {
                    view.to_newest(cx);
                }
            }))
            .child(div().min_w_0().one_line().child(text))
            .child(div().flex_none().flex().items_center().gap(px(4.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child("Jump to present").child(icon("arrow-down", 15., theme.text1)))
            .enter("jump-present-in", Enter::Rise(10.), 180)
            .into_any_element()
    }

    /// Asks the core which unread messages mention you, whenever how far you've read changes.
    pub(super) fn update_mentions(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
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
    pub(super) fn mention_button(&self, conversation: &ConversationView, raised: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
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
                .hover(|style| style.bg(theme.bg5_hover))
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

    pub(super) fn chat_context(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> Option<ChatContext> {
        let state = self.state.read(cx);
        let server = state.servers.get(&self.server_id)?;
        let list = state.lists.get(&conversation.list_id())?;
        let self_id = server.self_id().to_string();
        let read_up_to = conversation.read_up_to(&self_id);
        let is_group_admin = conversation.is_admin(&self_id);
        let items = &list.items;
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
            hovered_link: self.hovered_link.clone(),
            images,
            avatars,
            is_channel: conversation.kind == "channel",
            channel_title: conversation.title.clone(),
            channel_description: conversation.description.clone(),
            voice_channel: self.beside_voice.is_some(),
            channel_id: conversation.group_id.clone(),
            is_server_admin: server.is_admin(),
            editing_id: if conversation.kind == "channel" { state.editing.get(&conversation.list_id()).map(|message| message.id.clone()) } else { None },
            inline_editor: (conversation.kind == "channel").then(|| self.inline_editor.clone()),
            selecting: selection.is_some(),
            selected: selection.map(|(_, ids)| ids.into_iter().collect()).unwrap_or_default(),
            members: conversation.members.iter().map(|member| member.user_id.clone()).collect(),
            read_by: conversation.read_by.clone(),
            parsed: self.parsed.clone(),
            mentionable_print: crate::ui::message::mentionable_print(&server.mentionable),
            video_slots: self.video_slots.clone(),
            emote_sizes: server.emotes.emotes.iter().filter(|emote| emote.width > 0. && emote.height > 0.).map(|emote| (emote.id.clone(), (emote.width as f32, emote.height as f32))).collect(),
        };
        let server_id = self.server_id.clone();
        if !wanted.is_empty() {
            self.state.update(cx, |state, cx| {
                for avatar in wanted {
                    state.decrypted_picture(&server_id, &avatar, cx);
                }
            });
        }
        Some(context)
    }

    pub(super) fn empty_chat(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
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
