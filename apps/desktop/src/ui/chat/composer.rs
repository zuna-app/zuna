//! The message box as it's drawn, and the suggestions above it.

use super::*;

impl ChatView {
    pub(super) fn composer_area(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
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
            if (peer.banned || peer.deleted) && !is_saved {
                let why = if peer.deleted { "This account was deleted." } else { "This person was removed from the server." };
                return disabled(div().flex().items_center().gap(px(8.)).child(icon("x", 15., theme.text2)).child(why).into_any_element());
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
            let picture = draft.preview.as_ref().and_then(|preview| preview.image.as_ref()).and_then(|image| crate::ui::message::data_url_image(&image.data));
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
                .children(crate::ui::plugins::composer_buttons(cx).into_iter().map(|button| div().h(px(44.)).flex().items_center().child(button)))
        } else {
            let plugin_buttons = if editing.is_none() { crate::ui::plugins::composer_buttons(cx) } else { Vec::new() };
            div().flex().items_end().gap(px(2.)).px(px(10.)).py(px(8.)).when(editing.is_none(), |el| {
                el.child(icon_button("attach", "paperclip", 18., false, false, cx).tip("Attach", Side::Top).on_click(cx.listener(|view, event: &gpui::ClickEvent, _, cx| view.attach_menu(event.position(), cx))))
            })
            .children(plugin_buttons)
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
                    // As the web's: 330 px left of the button's right edge, at its top.
                    let at = emoji_bounds.get();
                    let position = gpui::point(at.right() - px(330.), at.top());
                    crate::ui::picker::open_picker(
                        position,
                        true,
                        move |pick, window, cx| {
                            composer.update(cx, |input, cx| {
                                let text = match pick {
                                    crate::ui::picker::Pick::Emoji(value) => value,
                                    crate::ui::picker::Pick::Emote(emote) => {
                                        let before = &input.text()[..input.cursor().min(input.text().len())];
                                        let space = if before.is_empty() || before.ends_with(char::is_whitespace) { "" } else { " " };
                                        format!("{space}{} ", emote.name)
                                    }
                                };
                                input.insert(&text, window, cx);
                            });
                            composer.focus_handle(cx).focus(window, cx);
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

    /// The autocomplete list over the message box (`.suggestions`).
    pub(super) fn suggestion_list(&self, server_url: &str, cx: &mut Context<Self>) -> AnyElement {
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
                    let url = crate::models::emote_url(&server_url, &emote.id);
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
                        view.composer.focus_handle(cx).focus(window, cx);
                    }))
                    .child(picture)
                    .child(div().min_w_0().one_line().child(suggestion.label.clone()))
                    .when_some(suggestion.hint.clone(), |el, hint| el.child(div().min_w_0().one_line().text_color(theme.text3).child(hint))),
            );
        }
        // Up from behind the message box's edge, as the picker comes.
        div().absolute().left(px(14.)).right(px(14.)).bottom(gpui::relative(1.)).pb(px(6.)).child(list).enter("suggestions-in", Enter::Drop(crate::ui::motion::Edge::Bottom, 14.), 170).into_any_element()
    }
}
