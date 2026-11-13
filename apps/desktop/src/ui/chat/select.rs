//! Picking messages by dragging across them, selecting their text, and the bar for what's picked.

use super::*;

impl ChatView {
    /// The message row at this height, held to the list's own top and bottom.
    pub(super) fn row_at(&self, y: gpui::Pixels) -> Option<usize> {
        let view = self.list.viewport_bounds();
        let at = y.clamp(view.top() + px(1.), view.bottom() - px(1.));
        self.row_bounds.borrow().iter().find(|(index, bounds)| **index < self.rows.len() && bounds.top() <= at && at < bounds.bottom()).map(|(index, _)| *index)
    }

    /// A press on a message's text starts selecting it, except while messages are picked,
    /// when a press picks instead, as `use-drag-pick.ts` keeps it.
    pub(super) fn select_start(&mut self, event: &gpui::MouseDownEvent, cx: &mut Context<Self>) {
        let picking = self.state.read(cx).selection.as_ref().is_some_and(|(list, _)| *list == self.last_list_id);
        let modifiers = &event.modifiers;
        let changed = if picking || modifiers.control || modifiers.alt || modifiers.platform { selection::clear() } else { selection::press(event.position, modifiers.shift) };
        if changed {
            self.refresh_messages(cx);
        }
    }

    /// A press on a message may start picking by dragging, as in Telegram's desktop app.
    pub(super) fn drag_start(&mut self, event: &gpui::MouseDownEvent, cx: &mut Context<Self>) {
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

    pub(super) fn drag_move(&mut self, y: gpui::Pixels, cx: &mut Context<Self>) {
        let found = self.row_at(y).map(|index| self.rows[index].0.clone());
        let Some(drag) = &mut self.drag else { return };
        drag.y = y;
        let Some(id) = found else { return };
        if !drag.dragging && id == drag.start {
            return;
        }
        if !drag.dragging {
            drag.dragging = true;
            // Onto another message: picking, and the text selected so far goes.
            if selection::clear() {
                self.refresh_messages(cx);
            }
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
    pub(super) fn pick_to(&mut self, id: &str, cx: &mut Context<Self>) {
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

    /// While a press is selecting text, the pointer stretches it wherever it goes in the window,
    /// as a browser's does, and the button coming up anywhere ends it.
    pub(super) fn selecting_text(&self, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity().downgrade();
        gpui::canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                window.on_mouse_event(move |event: &gpui::MouseMoveEvent, phase, _, cx| {
                    if phase != gpui::DispatchPhase::Bubble || !selection::held() {
                        return;
                    }
                    if event.pressed_button != Some(MouseButton::Left) {
                        selection::release();
                    } else if selection::stretch(event.position) {
                        view.update(cx, |view, cx| view.refresh_messages(cx)).ok();
                    }
                });
                window.on_mouse_event(|_: &gpui::MouseUpEvent, phase, _, _| {
                    if phase == gpui::DispatchPhase::Capture {
                        selection::release();
                    }
                });
            },
        )
        .absolute()
        .size_0()
        .into_any_element()
    }

    /// Ends a drag; the click a drag ends with doesn't also pick, or open, what it lands on.
    pub(super) fn drag_end(&mut self, cx: &mut Context<Self>) {
        let dragged = self.drag.take().is_some_and(|drag| drag.dragging);
        self.drag_tick = None;
        if dragged {
            cx.stop_propagation();
        }
    }

    // --- Suggestions, link previews and files ---

    /// What can be done with the picked messages, in place of the message box, as in Telegram.
    pub(super) fn selection_bar(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return div().into_any_element() };
        let list_id = conversation.list_id();
        let ids = state.selection.as_ref().map(|(_, ids)| ids.clone()).unwrap_or_default();
        // In the chat's order, whatever order they were picked in.
        let picked: Vec<MessageView> = state.lists.get(&list_id).map(|list| list.items.iter().filter(|item| ids.contains(&item.id)).cloned().collect()).unwrap_or_default();
        let self_id = server.self_id().to_string();
        let is_admin = conversation.is_admin(&self_id);
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
                    .when(self.server_id != crate::telegram::SERVER_ID, |el| el.child(button("forward-selection", ButtonKind::Default, ButtonSize::Normal, count == 0 || group.is_none(), cx).child(icon("forward", 15., theme.text1)).child("Forward").on_click(forward)))
                    .when(can_delete, |el| el.child(button("delete-selection", ButtonKind::Danger, ButtonSize::Normal, false, cx).child(icon("trash", 15., theme.red)).child("Delete for everyone").on_click(delete))),
            )
            .into_any_element()
    }
}
