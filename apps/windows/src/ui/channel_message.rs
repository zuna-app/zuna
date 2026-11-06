//! A text channel's messages, laid out as Discord's: full-width rows under a picture and a
//! name, the time beside it, a bar of actions on hover, and lines across for days and what's
//! new (the channel branch of MessageItem.tsx, MessageList.tsx and styles/channel.css).

use gpui::{AnyElement, App, FontWeight, IntoElement, MouseButton, ParentElement, SharedString, Styled, Window, div, img, prelude::*, px, relative};
use serde_json::json;

use super::components::*;
use super::menu::open_menu_with_reactions;
use super::message::{ChatContext, QUICK_REACTIONS, attachments, continues, jumbo_body, menu_entries, name_of, system_text, text_body};
use crate::format::{format_full, format_time, name_color};
use crate::markup;
use crate::models::{MessageView, ReactionView};
use crate::state::Overlay;
use crate::theme::{self, Theme};

/// Discord's quieter gray, for times and hints in a channel.
fn muted() -> gpui::Hsla {
    theme::color(theme::hex(0x8b8b92))
}

fn spine() -> gpui::Hsla {
    theme::color(theme::hex(0x505057))
}

/// "Today at 14:32", "Yesterday at 9:05", or the date and time (`formatStamp`).
pub fn format_stamp(at_ms: f64) -> String {
    let local = |ms: f64| chrono::DateTime::from_timestamp_millis(ms as i64).map(|time| time.with_timezone(&chrono::Local)).unwrap_or_default();
    let days = (local(crate::format::now_ms()).date_naive() - local(at_ms).date_naive()).num_days();
    match days {
        0 => format!("Today at {}", format_time(at_ms)),
        1 => format!("Yesterday at {}", format_time(at_ms)),
        _ => format!("{} {}", local(at_ms).format("%m/%d/%Y"), format_time(at_ms)),
    }
}

/// "November 6, 2026", as on the line between days in a channel.
fn format_day(at_ms: f64) -> String {
    chrono::DateTime::from_timestamp_millis(at_ms as i64).map(|time| time.with_timezone(&chrono::Local).format("%B %-d, %Y").to_string()).unwrap_or_default()
}

/// One row of a channel: the welcome at the start, the line for a new day or what's new, then the message.
pub fn render_row(items: &[MessageView], index: usize, context: &ChatContext, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let message = &items[index];
    let previous = index.checked_sub(1).and_then(|i| items.get(i));
    let show_day = match previous {
        Some(previous) => !crate::format::same_day(previous.created_at, message.created_at),
        None => !context.has_more,
    };
    let unread = context.unread_line.as_deref() == Some(message.id.as_str());
    // A reply starts a run of its own, with its line up to the picture.
    let grouped = !show_day && !unread && message.reply.is_none() && if previous.is_some() { continues(previous, Some(message)) } else { context.has_more && !context.detached };
    let mut row = div().w_full().flex().flex_col();
    if index == 0 && !context.has_more {
        row = row.child(welcome(context, &theme, cx));
    }
    if show_day || unread {
        let color = if unread { theme.red } else { theme.line_strong };
        let mut line = div()
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .h(px(1.))
            .mx(px(16.))
            .mt(px(if show_day || index == 0 { 24. } else { 10. }))
            .mb(px(8.))
            .bg(color);
        if show_day {
            line = line.child(div().px(px(4.)).py(px(2.)).bg(theme.bg_chat).text_size(px(12.)).line_height(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(if unread { theme.red } else { muted() }).child(format_day(message.created_at)));
        }
        if unread {
            line = line.child(
                div()
                    .absolute()
                    .right_0()
                    .top(px(-7.))
                    .h(px(13.))
                    .pl(px(6.))
                    .pr(px(4.))
                    .rounded_r(px(3.))
                    .bg(theme.red)
                    .text_size(px(10.))
                    .line_height(px(13.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(gpui::white())
                    .child("NEW"),
            );
        }
        row = row.child(line);
    }
    let after_line = show_day || unread || (index == 0 && !context.has_more);
    row = row.child(render_message(message, grouped, after_line, context, window, cx));
    if index + 1 == items.len() {
        row = row.child(div().h(px(22.)));
    }
    row.into_any_element()
}

/// The top of a channel's history, as in Discord.
fn welcome(context: &ChatContext, theme: &Theme, cx: &mut App) -> AnyElement {
    let title = context.channel_title.clone();
    let mut text = format!("This is the start of the #{title} channel.");
    if !context.channel_description.is_empty() {
        text.push(' ');
        text.push_str(&context.channel_description);
    }
    let mut column = div()
        .mx(px(16.))
        .mt(px(16.))
        .mb(px(8.))
        .flex()
        .flex_col()
        .items_start()
        .child(div().size(px(68.)).rounded_full().bg(theme.bg3).flex().items_center().justify_center().child(icon("hash", 44., theme.text1)))
        .child(div().my(px(8.)).text_size(px(32.)).line_height(px(40.)).font_weight(FontWeight::BOLD).child(format!("Welcome to #{title}!")))
        .child(div().text_size(px(16.)).line_height(px(22.)).text_color(theme.text2).child(text))
        .child(
            div()
                .mt(px(6.))
                .flex()
                .items_start()
                .gap(px(6.))
                .text_size(px(13.))
                .line_height(px(18.))
                .text_color(muted())
                .child(div().mt(px(2.)).child(icon("lock", 13., muted())))
                .child("End-to-end encrypted. Everyone on this server can read it, and the server itself can't."),
        );
    if let (true, Some(channel_id)) = (context.is_server_admin, context.channel_id.clone()) {
        let state = context.state.clone();
        column = column.child(
            div()
                .id("welcome-edit")
                .mt(px(12.))
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.link)
                .cursor_pointer()
                .hover(|style| style.underline())
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(channel_id.clone()), category: None }), cx)))
                .child(icon("pencil", 15., theme.link))
                .child("Edit channel"),
        );
    }
    let _ = cx;
    column.into_any_element()
}

fn render_message(message: &MessageView, grouped: bool, after_line: bool, context: &ChatContext, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let size = theme.message_size + px(1.5);
    let highlighted = context.highlight.as_deref() == Some(message.id.as_str());
    let top = if grouped || after_line { 0. } else { 17. };
    if message.system.is_some() {
        let warning = matches!(message.system.as_ref().map(|s| s.kind.as_str()), Some("unexpected_join" | "identity_changed"));
        return div()
            .relative()
            .mt(px(8.))
            .pl(px(72.))
            .pr(px(48.))
            .py(px(2.))
            .text_size(size)
            .text_color(theme.text2)
            .when(highlighted, |el| el.bg(theme.accent_soft))
            .child(div().absolute().left_0().top(px(5.)).w(px(72.)).flex().justify_center().child(icon(if warning { "shield-alert" } else { "arrow-right" }, 16., if warning { theme.amber } else { muted() })))
            .child(div().flex().flex_wrap().items_baseline().child(system_text(message, context)).child(div().ml(px(8.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(muted()).child(format_stamp(message.created_at))))
            .into_any_element();
    }
    let own = message.sender_id == context.self_id;
    if !own && context.blocked.contains(&message.sender_id) && !context.revealed.borrow().contains(&message.id) {
        let (revealed, id, state) = (context.revealed.clone(), message.id.clone(), context.state.clone());
        return div()
            .mt(px(8.))
            .pl(px(72.))
            .pr(px(48.))
            .py(px(4.))
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(14.))
            .text_color(muted())
            .child("A message from someone you blocked.")
            .child(
                div()
                    .id(SharedString::from(format!("show-{}", message.id)))
                    .text_color(theme.text2)
                    .cursor_pointer()
                    .hover(move |style| style.text_color(theme.text1))
                    .on_click(move |_, _, cx| {
                        revealed.borrow_mut().insert(id.clone());
                        state.update(cx, |_, cx| cx.notify());
                    })
                    .child("Show"),
            )
            .into_any_element();
    }
    let is_deleted = message.deleted_at.is_some();
    let can_act = message.seq.is_some() && !is_deleted && !matches!(message.status.as_str(), "undecryptable" | "unverified" | "invalid" | "sending" | "failed");
    let mentions_me = !own && (message.mentions.contains(&context.self_id) || message.reply.as_ref().is_some_and(|reply| reply.sender_id == context.self_id));
    let can_edit = can_act && own && !message.text.is_empty() && message.forwarded.is_none();
    let selecting = context.selecting;
    let selected = context.selected.contains(&message.id);
    let editing_here = context.editing_id.as_deref() == Some(message.id.as_str());
    let name = context.users.get(&message.sender_id).map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into());
    let group = SharedString::from(format!("cmsg-{}", message.id));
    let entries = menu_entries(message, own, can_act, context);

    let mut row = div()
        .id(SharedString::from(format!("cmsg-row-{}", message.id)))
        .group(group.clone())
        .relative()
        .mt(px(top))
        .pl(px(if selecting { 104. } else { 72. }))
        .pr(px(48.))
        .py(px(2.))
        .min_h(px(if grouped { 22. } else { 44. }))
        .text_size(size)
        .line_height(relative(1.375))
        .text_color(theme.text1)
        // Mentioning you, or answering you: gold, with a line down the left, as in Discord.
        .hover(move |style| style.bg(if mentions_me { theme::color(theme::rgba(229, 165, 10, 0.11)) } else { theme::color(theme::white_a(0.025)) }))
        .when(mentions_me, |el| el.bg(theme::color(theme::rgba(229, 165, 10, 0.08))).child(div().absolute().left_0().top_0().bottom_0().w(px(2.)).bg(theme.amber)))
        .when(highlighted || selected, |el| el.bg(theme.accent_soft));
    {
        let entries = entries.clone();
        let state = context.state.clone();
        let (group, id) = (message.group_id.clone(), message.id.clone());
        row = row.on_mouse_down(MouseButton::Right, move |event, _, cx| {
            if selecting || entries.is_empty() {
                return;
            }
            let state = state.clone();
            let (group, id) = (group.clone(), id.clone());
            let reactions = if can_act { QUICK_REACTIONS.to_vec() } else { Vec::new() };
            open_menu_with_reactions(event.position, entries.clone(), reactions, move |emoji, _, cx| state.update(cx, |state, cx| state.act("toggleReaction", vec![json!(group), json!(id), json!(emoji)], cx)), false, cx);
        });
    }
    if selecting {
        let state = context.state.clone();
        let (list_id, id) = (context.list_id.clone(), message.id.clone());
        row = row
            .cursor_pointer()
            .on_click(move |_, _, cx| {
                if can_act {
                    state.update(cx, |state, cx| state.toggle_selected(&list_id, Some(&id), cx));
                }
            })
            .child(
                div()
                    .absolute()
                    .left(px(22.))
                    .top(px(if grouped { 3. } else { 12. }))
                    .size(px(20.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_2()
                    .border_color(if selected { theme.accent } else { theme.text3 })
                    .when(selected, |el| el.bg(theme.accent).child(icon("check", 13., theme.on_accent)))
                    .when(!can_act, |el| el.opacity(0.3)),
            );
    }
    if let Some(reply) = message.reply.as_ref().filter(|_| !is_deleted) {
        row = row.child(channel_reply(message, reply, context, &theme, cx));
    }

    let mut main = div().relative();
    if grouped {
        main = main.child(
            div()
                .id(SharedString::from(format!("gutter-{}", message.id)))
                .absolute()
                .left(px(-72.))
                .w(px(56.))
                .top_0()
                .flex()
                .justify_end()
                .text_size(px(11.))
                .line_height(px(22.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted())
                .opacity(0.)
                .group_hover(group.clone(), |style| style.opacity(1.))
                .tooltip(tooltip(format_full(message.created_at)))
                .child(format_time(message.created_at)),
        );
    } else {
        let state = context.state.clone();
        let sender = message.sender_id.clone();
        let image = context.avatars.get(&message.sender_id).cloned();
        main = main
            .child(
                div()
                    .id(SharedString::from(format!("cmsg-avatar-{}", message.id)))
                    .absolute()
                    .left(px(-56.))
                    .top(px(2.))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: sender.clone() }), cx)))
                    .child(avatar(AvatarProps { name: name.clone(), seed: message.sender_id.clone(), image, size: 40., online: false, rounded: false, dot_border: theme.bg_chat }, cx)),
            )
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .min_h(px(22.))
                    .line_height(px(22.))
                    .child({
                        let state = context.state.clone();
                        let sender = message.sender_id.clone();
                        div()
                            .id(SharedString::from(format!("cmsg-author-{}", message.id)))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme::css(name_color(&message.sender_id)))
                            .cursor_pointer()
                            .hover(|style| style.underline())
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: sender.clone() }), cx)))
                            .child(name.clone())
                    })
                    .child(
                        div()
                            .id(SharedString::from(format!("cmsg-time-{}", message.id)))
                            .ml(px(6.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(muted())
                            .tooltip(tooltip(format_full(message.created_at)))
                            .child(format_stamp(message.created_at)),
                    ),
            );
    }

    let mut body = div().min_w_0().flex().flex_col().when(message.status == "sending", |el| el.opacity(0.55));
    let placeholder = if is_deleted {
        Some(("Message deleted", false))
    } else {
        match message.status.as_str() {
            "undecryptable" => Some(("Waiting for this message's keys", false)),
            "unverified" => Some(("This message couldn't be verified, so it isn't shown.", true)),
            "invalid" => Some(("This message couldn't be displayed.", true)),
            _ => None,
        }
    };
    if let Some((text, danger)) = placeholder {
        body = body.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_color(if danger { theme::color(theme::hex(0xf4bcbe)) } else { muted() })
                .when(!danger, |el| el.italic())
                .when(danger, |el| el.child(icon("shield-alert", 14., theme.red)))
                .child(text),
        );
    } else if editing_here {
        if let Some(editor) = context.inline_editor.clone() {
            let state = context.state.clone();
            let list_id = context.list_id.clone();
            body = body.child(
                div()
                    .pt(px(2.))
                    .pb(px(4.))
                    .child(div().min_h(px(44.)).px(px(16.)).py(px(11.)).rounded(px(8.)).bg(theme.bg3).line_height(px(22.)).child(editor))
                    .child(
                        div()
                            .mt(px(4.))
                            .flex()
                            .gap(px(3.))
                            .text_size(px(12.))
                            .text_color(theme.text2)
                            .child("escape to")
                            .child(
                                div()
                                    .id("inline-cancel")
                                    .text_color(theme.link)
                                    .cursor_pointer()
                                    .hover(|style| style.underline())
                                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_editing(&list_id, None, cx)))
                                    .child("cancel"),
                            )
                            .child("• enter to save"),
                    ),
            );
        }
    } else {
        if let Some(forwarded) = &message.forwarded {
            let from = forwarded.user_id.as_deref().map(|id| name_of(context, id));
            body = body.child(
                div()
                    .mb(px(2.))
                    .pl(px(8.))
                    .border_l_2()
                    .border_color(spine())
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .italic()
                    .text_size(px(12.5))
                    .text_color(theme.text2)
                    .child(icon("forward", 13., theme.text2))
                    .child(match from {
                        Some(name) => format!("Forwarded from {name}"),
                        None => "Forwarded".to_string(),
                    }),
            );
        }
        if !message.text.is_empty() {
            let jumbo = if message.attachments.is_empty() { markup::jumbo_size(&message.text, &message.emotes) } else { 0 };
            let text = if jumbo > 0 { jumbo_body(message, jumbo, context, cx) } else { text_body(message, false, false, context, &theme, window, cx) };
            let mut line = div().flex().flex_wrap().items_baseline().when(message.status == "failed", |el| el.text_color(theme.red)).child(text);
            if message.edited_at.is_some() {
                line = line.child(div().ml(px(4.)).text_size(px(10.)).text_color(muted()).child("(edited)"));
            }
            if message.time_differs == Some(true) {
                line = line.child(div().id(SharedString::from(format!("time-flag-{}", message.id))).ml(px(4.)).tooltip(tooltip("The sender's device gives a very different time for this message.")).child(icon("shield-alert", 13., muted())));
            }
            if let Some(expires) = message.expires_at {
                line = line.child(div().id(SharedString::from(format!("timer-flag-{}", message.id))).ml(px(4.)).tooltip(tooltip(format!("Disappears {}", format_full(expires)))).child(icon("timer", 12., muted())));
            }
            body = body.child(line);
        }
        if !message.attachments.is_empty() {
            let images: Vec<&crate::models::Attachment> = message.attachments.iter().filter(|a| a.mime.starts_with("image/") && a.width.is_some()).collect();
            body = body.child(div().my(px(2.)).flex().flex_col().items_start().gap(px(4.)).child(attachments(message, &images, false, false, false, false, context, &theme, cx)));
        }
        if let Some(preview) = &message.preview {
            body = body.child(channel_link_card(preview, &theme));
        }
    }
    if !message.reactions.is_empty() {
        let mut reactions = div().mt(px(4.)).flex().flex_wrap().items_center().gap(px(4.));
        for reaction in &message.reactions {
            reactions = reactions.child(channel_reaction(reaction, message, context, &theme, cx));
        }
        body = body.child(reactions);
    }
    if message.status == "failed" {
        let state = context.state.clone();
        let (group_id, id) = (message.group_id.clone(), message.id.clone());
        body = body.child(
            div()
                .id(SharedString::from(format!("cretry-{}", message.id)))
                .mt(px(2.))
                .flex()
                .items_center()
                .gap(px(5.))
                .text_size(px(12.))
                .text_color(theme.red)
                .cursor_pointer()
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("retryMessage", vec![json!(group_id), json!(id)], cx)))
                .child(icon("circle-alert", 13., theme.red))
                .child("Not sent. Try again"),
        );
    }
    row = row.child(main.child(body));
    if can_act && !selecting && !editing_here {
        row = row.child(toolbar(message, can_edit, entries, context, &theme, group, cx));
    }
    row.into_any_element()
}

/// What a message answers: above it, joined to its picture by a line.
fn channel_reply(message: &MessageView, reply: &crate::models::ReplyPreview, context: &ChatContext, theme: &Theme, cx: &mut App) -> AnyElement {
    let blocked = context.blocked.contains(&reply.sender_id);
    let name = context.users.get(&reply.sender_id).map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into());
    let text = if reply.deleted {
        "Original message was deleted".to_string()
    } else if blocked {
        "Message from someone you blocked".to_string()
    } else {
        markup::plain_text(&reply.text)
    };
    let image = context.avatars.get(&reply.sender_id).cloned();
    let state = context.state.clone();
    let (group, target) = (message.group_id.clone(), reply.id.clone());
    let empty = text.is_empty();
    let mut line = div()
        .relative()
        .flex()
        .items_center()
        .gap(px(4.))
        .h(px(18.))
        .mb(px(4.))
        .text_size(px(14.))
        .line_height(px(18.))
        .text_color(theme.text2)
        // The line from the picture below up to what's answered.
        .child(div().absolute().left(px(-38.)).w(px(33.)).top(px(9.)).h(px(11.)).border_l_2().border_t_2().border_color(spine()).rounded_tl(px(6.)));
    if reply.deleted {
        line = line.child(div().size(px(16.)).flex_none().rounded_full().bg(theme.bg3).flex().items_center().justify_center().child(icon("corner-up-left", 10., theme.text2)));
    } else {
        line = line
            .child(avatar(AvatarProps { name: name.clone(), seed: reply.sender_id.clone(), image, size: 16., online: false, rounded: false, dot_border: theme.bg_chat }, cx).text_size(px(7.)))
            .child(div().flex_none().font_weight(FontWeight::MEDIUM).text_color(theme::css(name_color(if reply.sender_id.is_empty() { "x" } else { &reply.sender_id }))).child(format!("@{name}")));
    }
    line = line.child(
        div()
            .id(SharedString::from(format!("creply-{}", message.id)))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .cursor_pointer()
            .hover(move |style| style.text_color(theme.text1))
            .when(empty, |el| el.italic())
            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.jump_to_message(&group, &target, cx)))
            .child(div().min_w_0().one_line().child(if empty { if reply.has_attachment { "Click to see attachment".to_string() } else { "Click to see message".to_string() } } else { text }))
            .when(empty && reply.has_attachment, |el| el.child(icon("image", 15., theme.text2))),
    );
    line.into_any_element()
}

/// The bar of actions over the top right of the message on hover.
fn toolbar(message: &MessageView, can_edit: bool, entries: Vec<super::menu::MenuEntry>, context: &ChatContext, theme: &Theme, group: SharedString, cx: &mut App) -> AnyElement {
    let theme = *theme;
    let tool = |id: String, icon_name: &'static str, size: f32, label: &'static str| {
        div()
            .id(SharedString::from(id))
            .size(px(32.))
            .rounded(px(6.))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover_strong))
            .tooltip(tooltip(label))
            .child(icon(icon_name, size, theme.text2))
    };
    let mut bar = div()
        .absolute()
        .top(px(-16.))
        .right(px(14.))
        .h(px(34.))
        .px(px(1.))
        .flex()
        .items_center()
        .bg(theme.bg2)
        .border_1()
        .border_color(theme.line_strong)
        .rounded(px(8.))
        .shadow(shadow_s())
        .invisible()
        .group_hover(group, |style| style.visible());
    for emoji in QUICK_REACTIONS.iter().take(3).copied() {
        let state = context.state.clone();
        let (group_id, id) = (message.group_id.clone(), message.id.clone());
        bar = bar.child(
            div()
                .id(SharedString::from(format!("quick-{}-{emoji}", message.id)))
                .size(px(32.))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(18.))
                .cursor_pointer()
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("toggleReaction", vec![json!(group_id), json!(id), json!(emoji)], cx)))
                .child(emoji),
        );
    }
    bar = bar.child(div().w(px(1.)).h(px(20.)).mx(px(4.)).bg(theme.line_strong));
    {
        let state = context.state.clone();
        let (group_id, id) = (message.group_id.clone(), message.id.clone());
        bar = bar.child(tool(format!("react-{}", message.id), "face-slightly-smiling-plus", 19., "Add reaction").on_click(move |event, window, cx| {
            let state = state.clone();
            let (group_id, id) = (group_id.clone(), id.clone());
            super::picker::open_picker(
                event.position(),
                false,
                move |pick, _, cx| {
                    let args = match pick {
                        super::picker::Pick::Emoji(value) => vec![json!(group_id), json!(id), json!(value)],
                        super::picker::Pick::Emote(emote) => vec![json!(group_id), json!(id), json!(emote.name), json!({ "id": emote.id, "animated": emote.animated, "zeroWidth": emote.zero_width, "owner": emote.owner })],
                    };
                    state.update(cx, |state, cx| state.act("toggleReaction", args, cx));
                },
                window,
                cx,
            );
        }));
    }
    if can_edit {
        let state = context.state.clone();
        let (list_id, message) = (context.list_id.clone(), message.clone());
        bar = bar.child(tool(format!("edit-{}", message.id), "pencil", 17., "Edit").on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_editing(&list_id, Some(message.clone()), cx))));
    }
    {
        let state = context.state.clone();
        let (list_id, reply) = (context.list_id.clone(), message.clone());
        bar = bar.child(tool(format!("reply-{}", message.id), "corner-up-left", 19., "Reply").on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_reply(&list_id, Some(reply.clone()), cx))));
    }
    {
        let state = context.state.clone();
        let (server_id, group_id, id) = (context.server_id.clone(), message.group_id.clone(), message.id.clone());
        bar = bar.child(tool(format!("forward-{}", message.id), "forward", 19., "Forward").on_click(move |_, _, cx| {
            let overlay = Overlay::Forward { server_id: server_id.clone(), group_id: group_id.clone(), ids: vec![id.clone()] };
            state.update(cx, |state, cx| state.set_overlay(Some(overlay), cx))
        }));
    }
    {
        let state = context.state.clone();
        let (group_id, id) = (message.group_id.clone(), message.id.clone());
        bar = bar.child(tool(format!("more-{}", message.id), "ellipsis", 19., "More").on_click(move |event, _, cx| {
            let state = state.clone();
            let (group_id, id) = (group_id.clone(), id.clone());
            open_menu_with_reactions(event.position(), entries.clone(), QUICK_REACTIONS.to_vec(), move |emoji, _, cx| state.update(cx, |state, cx| state.act("toggleReaction", vec![json!(group_id), json!(id), json!(emoji)], cx)), true, cx);
        }));
    }
    let _ = cx;
    bar.into_any_element()
}

/// A reaction under a channel message: the emoji and how many, outlined when one is yours.
fn channel_reaction(reaction: &ReactionView, message: &MessageView, context: &ChatContext, theme: &Theme, cx: &mut App) -> AnyElement {
    let theme = *theme;
    let mine = reaction.user_ids.contains(&context.self_id);
    let names = reaction.user_ids.iter().map(|id| name_of(context, id)).collect::<Vec<_>>().join(", ");
    let state = context.state.clone();
    let (group, id, key) = (message.group_id.clone(), message.id.clone(), reaction.key.clone());
    let emote = reaction.emote.clone();
    let mut chip = div()
        .id(SharedString::from(format!("creaction-{}-{}", message.id, reaction.key)))
        .flex()
        .items_center()
        .gap(px(6.))
        .min_h(px(26.))
        .px(px(6.))
        .py(px(2.))
        .rounded(px(8.))
        .border_1()
        .border_color(if mine { theme.accent } else { gpui::transparent_black() })
        .bg(if mine { theme.accent_soft } else { theme.bg2 })
        .text_color(if mine { theme.text1 } else { theme.text2 })
        .text_size(px(14.))
        .line_height(px(16.))
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .when(!mine, |el| el.hover(move |style| style.bg(theme.bg3).border_color(theme.line_strong)))
        .tooltip(tooltip(names))
        .on_click(move |_, _, cx| {
            let mut args = vec![json!(group), json!(id), json!(key)];
            if let Some(emote) = &emote {
                args.push(serde_json::to_value(emote).unwrap_or_default());
            }
            state.update(cx, |state, cx| state.act("toggleReaction", args, cx))
        });
    chip = match &reaction.emote {
        Some(emote) => {
            let url = format!("{}/api/emotes/{}/2x.webp", context.server_url, emote.id);
            match context.state.update(cx, |state, cx| state.remote_picture(&url, cx)) {
                Some(image) => chip.child(img(image).h(px(20.)).max_w(px(44.)).object_fit(gpui::ObjectFit::Contain)),
                None => chip.child(reaction.key.clone()),
            }
        }
        None => chip.child(div().text_size(px(16.)).line_height(px(20.)).child(reaction.key.clone())),
    };
    chip.child(reaction.user_ids.len().to_string()).into_any_element()
}

/// A link's preview in a channel, as Discord's embed: a bar on the left, the title as a link.
fn channel_link_card(preview: &crate::models::LinkPreview, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let host = url::Url::parse(&preview.url).ok().and_then(|url| url.host_str().map(|host| host.trim_start_matches("www.").to_string())).unwrap_or_default();
    let site = match &preview.site_name {
        Some(name) if name.to_lowercase() != host => format!("{host} · {name}"),
        _ => host,
    };
    let url = preview.url.clone();
    let mut text = div().flex_1().min_w_0().flex().flex_col().child(div().mb(px(4.)).text_size(px(12.)).text_color(theme.text2).child(site));
    if let Some(title) = &preview.title {
        text = text.child(div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.link).child(title.clone()));
    }
    if let Some(description) = &preview.description {
        text = text.child(div().mt(px(4.)).text_size(px(14.)).text_color(theme.text1).line_clamp(4).child(description.clone()));
    }
    let mut card = div()
        .id(SharedString::from(format!("clink-{}", preview.url)))
        .mt(px(4.))
        .max_w(px(432.))
        .flex()
        .gap(px(12.))
        .pl(px(12.))
        .pr(px(16.))
        .pt(px(8.))
        .pb(px(14.))
        .rounded(px(4.))
        .border_l_4()
        .border_color(theme.bg5)
        .bg(theme.bg2)
        .cursor_pointer()
        .on_click(move |_, _, cx| cx.open_url(&url))
        .child(text);
    if let Some(image) = preview.image.as_ref().and_then(|image| super::message::data_url_image(&image.data)) {
        card = card.child(cover_image(image, 80., 80., px(4.)));
    }
    card.into_any_element()
}
