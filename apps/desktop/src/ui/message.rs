//! One message in a chat, as a bubble (packages/ui/src/features/chat/MessageItem.tsx).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Div, ElementId, Entity, FontStyle, FontWeight, Hsla, Image, InteractiveText, IntoElement, MouseButton, ParentElement, Pixels,
    SharedString, Stateful, StrikethroughStyle, Styled, StyledText, TextRun, UnderlineStyle, Window, div, img, prelude::*, px, relative,
};
use serde_json::json;

use super::components::*;
use super::motion::{Enter, Motion};
use super::menu::{MenuEntry, open_menu_with_reactions};
use super::selection;
use crate::format::{format_bytes, format_day_separator, format_time, name_color, timer_change_text};
use crate::markup::{self, Block, Rich};
use crate::models::{Attachment, EmoteRef, MessageView, ReactionView, UserView};
use crate::state::{AppState, Overlay, Picture, ToastKind};
use crate::theme::{self, Theme, FONT_MONO, FONT_UI, RADIUS_M, RADIUS_S};

pub const QUICK_REACTIONS: [&str; 6] = ["👍", "❤️", "😂", "🔥", "😮", "😢"];

/// What every row of a chat shares.
pub struct ChatContext {
    pub state: Entity<AppState>,
    pub server_id: String,
    pub server_url: String,
    pub list_id: String,
    pub self_id: String,
    pub is_group: bool,
    pub is_group_admin: bool,
    pub read_up_to: f64,
    pub users: HashMap<String, UserView>,
    pub mentionable: HashMap<String, String>,
    pub blocked: Vec<String>,
    pub unread_line: Option<String>,
    pub has_more: bool,
    pub detached: bool,
    pub highlight: Option<String>,
    pub revealed: Rc<std::cell::RefCell<HashSet<String>>>,
    pub images: HashMap<String, Arc<Image>>,
    pub avatars: HashMap<String, Arc<Image>>,
    /// Picking messages in this chat, and those picked.
    pub selecting: bool,
    pub selected: HashSet<String>,
    /// Who's in the chat and how far each has read, for "Read by n".
    pub members: Vec<String>,
    pub read_by: HashMap<String, f64>,
    /// A text channel, laid out as Discord's, and what its welcome says.
    pub is_channel: bool,
    pub channel_title: String,
    pub channel_description: String,
    /// A voice channel's chat, beside its stage, which a speaker stands for in place of the #.
    pub voice_channel: bool,
    pub channel_id: Option<String>,
    pub is_server_admin: bool,
    /// The message being edited where it is, in a channel, and the field it's edited in.
    pub editing_id: Option<String>,
    pub inline_editor: Option<Entity<super::text_input::TextInput>>,
    /// Each message's text, parsed once while this context lasts. The context is built again
    /// after anything in the app's state changes, so every message drawn is parsed again then.
    pub parsed: std::cell::RefCell<HashMap<String, Rc<Vec<Block>>>>,
    /// Where the videos are drawn, above the messages.
    pub video_slots: super::media_views::VideoSlots,
    /// The width and height of each emote in the server's set, by id, so that its place is
    /// kept before its picture is here.
    pub emote_sizes: HashMap<String, (f32, f32)>,
}

const GROUP_WINDOW_MS: f64 = 5. * 60. * 1000.;

/// How wide an emote `height` tall is drawn, at most `widest`, by its size in the server's set,
/// so that its place is kept from before its picture is here and nothing moves when the picture
/// comes and is decoded. None for one the set doesn't know.
pub(super) fn emote_width(context: &ChatContext, id: &str, height: f32, widest: f32) -> Option<f32> {
    context.emote_sizes.get(id).map(|&(width, tall)| (height * width / tall).min(widest))
}

/// An emote's place while its picture is on its way: empty, as a browser keeps it, as wide as
/// the set says, or square for one the set doesn't know. Its name stands in only for a picture
/// that couldn't be had.
pub(super) fn emote_placeholder(context: &ChatContext, url: &str, name: &str, width: Option<f32>, height: f32, cx: &App) -> gpui::Div {
    if matches!(context.state.read(cx).pictures.get(url), Some(Picture::Failed(_))) {
        return div().text_color(theme(cx).text2).child(name.to_string());
    }
    div().flex_none().h(px(height)).w(px(width.unwrap_or(height)))
}

/// A double click replies, as in Telegram, except on something clickable, such as a link, a
/// button, a picture or a player, which all show the hand (`repliesOnDoubleClick`).
pub(super) fn reply_on_double_click(message: &MessageView, context: &ChatContext) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static {
    let (state, list_id, id) = (context.state.clone(), context.list_id.clone(), message.id.clone());
    move |event, window, cx| {
        if event.click_count() != 2 || window.cursor_style_under_mouse() == gpui::CursorStyle::PointingHand {
            return;
        }
        let found = state.read(cx).lists.get(&list_id).and_then(|list| list.items.iter().find(|item| item.id == id).cloned());
        if let Some(message) = found {
            state.update(cx, |state, cx| state.set_reply(&list_id, Some(message), cx));
        }
    }
}

/// Whether `b` carries on `a`'s run: the same person, within five minutes, on the same day.
pub fn continues(a: Option<&MessageView>, b: Option<&MessageView>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            a.system.is_none() && b.system.is_none() && a.sender_id == b.sender_id && b.created_at - a.created_at < GROUP_WINDOW_MS && crate::format::same_day(a.created_at, b.created_at)
        }
        _ => false,
    }
}

pub(super) fn name_of(context: &ChatContext, id: &str) -> String {
    if id == context.self_id {
        return "You".into();
    }
    context.users.get(id).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into())
}

pub(super) fn system_text(message: &MessageView, context: &ChatContext) -> String {
    let system = message.system.as_ref().unwrap();
    let actor = system.actor_id.as_deref().map(|id| name_of(context, id)).unwrap_or_else(|| "Someone".into());
    let targets = system.target_ids.clone().unwrap_or_default().iter().map(|id| name_of(context, id)).collect::<Vec<_>>().join(", ");
    match system.kind.as_str() {
        "group_created" => format!("{actor} created this group"),
        "member_added" => format!("{actor} added {targets}"),
        "member_removed" => format!("{actor} removed {targets}"),
        "member_left" => format!("{actor} left the group"),
        "member_rejoined" => format!("{actor} rejoined this chat"),
        "unexpected_join" => format!("{actor} joined without being added by a member. Check that this is expected."),
        "identity_changed" => format!("{actor}'s security key changed. Verify it before trusting new messages."),
        "identity_rotated" => format!("{actor}'s security key changed since you verified it. You can compare keys again if you'd like."),
        "device_added" => format!("{actor} added a device"),
        "timer_changed" => timer_change_text(&actor, system.seconds.unwrap_or(0.)),
        _ => String::new(),
    }
}

fn pill(text: String, theme: &Theme) -> gpui::Div {
    div().px(px(10.)).py(px(2.)).rounded(px(10.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).bg(theme.bg2).child(text)
}

/// One row: the separators above a message, then the message.
pub fn render_row(items: &[MessageView], index: usize, context: &ChatContext, window: &mut Window, cx: &mut App) -> AnyElement {
    if context.is_channel {
        return super::channel_message::render_row(items, index, context, window, cx);
    }
    let theme = theme(cx);
    let message = &items[index];
    let previous = index.checked_sub(1).and_then(|i| items.get(i));
    let next = items.get(index + 1);
    let show_day = match previous {
        Some(previous) => !crate::format::same_day(previous.created_at, message.created_at),
        None => !context.has_more,
    };
    let grouped = !show_day && if previous.is_some() { continues(previous, Some(message)) } else { context.has_more && !context.detached };
    let last_in_group = !continues(Some(message), next);
    let unread = context.unread_line.as_deref() == Some(message.id.as_str());
    let mut row = div().w_full().flex().flex_col().pl(px(14.)).pr(px(10.));
    if index == 0 {
        row = row.child(div().h(px(8.)));
    }
    if unread {
        row = row.child(
            div().mt(px(12.)).mb(px(4.)).ml(px(-14.)).mr(px(-10.)).py(px(4.)).flex().justify_center().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).bg(theme.bg2).child("Unread messages"),
        );
    }
    if show_day {
        row = row.child(div().flex().justify_center().pt(px(14.)).pb(px(8.)).child(pill(format_day_separator(message.created_at), &theme)));
    }
    row = row.child(render_message(message, grouped, last_in_group, context, window, cx));
    if next.is_none() {
        row = row.child(div().h(px(12.)));
    }
    row.into_any_element()
}

fn render_message(message: &MessageView, grouped: bool, last_in_group: bool, context: &ChatContext, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let highlighted = context.highlight.as_deref() == Some(message.id.as_str());
    if message.system.is_some() {
        let warning = matches!(message.system.as_ref().map(|s| s.kind.as_str()), Some("unexpected_join" | "identity_changed"));
        let mut pill = div().flex().items_center().gap(px(6.)).px(px(10.)).py(px(2.)).rounded(px(10.)).text_size(px(12.)).max_w(relative(0.8));
        pill = if warning {
            pill.bg(theme.amber_soft).text_color(theme.amber_text).child(icon("shield-alert", 13., theme.amber))
        } else {
            pill.bg(theme.bg2).text_color(theme.text2)
        };
        return div()
            .flex()
            .justify_center()
            .py(px(5.))
            .rounded(RADIUS_M)
            .when(highlighted, |el| el.bg(theme.hover_strong))
            .child(pill.child(div().text_center().child(system_text(message, context))))
            .into_any_element();
    }

    let own = message.sender_id == context.self_id;
    let blocked_sender = !own && context.blocked.contains(&message.sender_id);
    let revealed = context.revealed.borrow().contains(&message.id);
    if blocked_sender && !revealed {
        let revealed_set = context.revealed.clone();
        let id = message.id.clone();
        let state = context.state.clone();
        return div()
            .flex()
            .items_end()
            .gap(px(8.))
            .mt(px(8.))
            .when(context.is_group, |el| el.child(div().w(px(32.)).mr(px(3.))))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .px(px(2.))
                    .py(px(3.))
                    .text_size(px(12.5))
                    .text_color(theme.text3)
                    .child(icon("ban", 13., theme.text3))
                    .child("A message from someone you blocked")
                    .child(
                        div()
                            .id(SharedString::from(format!("show-{}", message.id)))
                            .text_color(theme.text2)
                            .cursor_pointer()
                            .hover(move |style| style.text_color(theme.text1))
                            .on_click(move |_, _, cx| {
                                revealed_set.borrow_mut().insert(id.clone());
                                state.update(cx, |_, cx| cx.notify());
                            })
                            .child("Show"),
                    ),
            )
            .into_any_element();
    }

    let is_deleted = message.deleted_at.is_some();
    let can_act = message.seq.is_some() && !is_deleted && !matches!(message.status.as_str(), "undecryptable" | "unverified" | "invalid" | "sending" | "failed");
    let jumbo = if message.attachments.is_empty() { markup::jumbo_size(&message.text, &message.emotes) } else { 0 };
    let has_reactions = !message.reactions.is_empty();
    let placeholder = is_deleted || matches!(message.status.as_str(), "undecryptable" | "unverified" | "invalid");
    let meta_in_text = !message.text.is_empty() && jumbo == 0 && message.preview.is_none() && !has_reactions && !placeholder;
    let images: Vec<&Attachment> = message.attachments.iter().filter(|a| a.mime.starts_with("image/") && a.width.is_some()).collect();
    let only_images = message.text.is_empty() && !images.is_empty() && images.len() == message.attachments.len() && !has_reactions;
    // A video message alone is a circle, without a bubble, as large emoji are.
    let only_round = message.text.is_empty() && message.attachments.len() == 1 && message.attachments[0].round == Some(true) && message.reply.is_none() && message.forwarded.is_none() && !placeholder;
    let bare = jumbo > 0 || only_round;

    let bubble_bg = if bare { gpui::transparent_black() } else if own { theme.bubble_own } else { theme.bubble_other };
    let text_color = if own { theme.bubble_own_text } else { theme.text1 };
    let faint = if own { theme.bubble_own_faint } else { theme.text2 };
    let meta_color = if bare { theme.text3 } else { theme.bubble_meta };

    let meta = meta_element(message, own, is_deleted, context.read_up_to, meta_color, only_images, &theme, window);

    let mut bubble = div()
        .relative()
        .flex()
        .flex_col()
        .min_w(px(64.))
        .max_w(px(600.))
        .bg(bubble_bg)
        .text_color(text_color)
        .text_size(theme.message_size)
        .line_height(relative(1.38));
    if !bare {
        bubble = bubble.px(px(11.)).py(px(7.)).rounded(px(15.));
        bubble = if own { bubble.rounded_br(px(5.)) } else { bubble.rounded_bl(px(5.)) };
        if grouped {
            bubble = if own { bubble.rounded_tr(px(5.)) } else { bubble.rounded_tl(px(5.)) };
        }
    }
    // `.bubble.is-sending`: dimmed only after half a second, so a quick send doesn't blink.
    let dim = super::motion::delayed_dim(&format!("bubble-{}", message.id), message.status == "sending", 500, 200, 0.7, 150, window);
    if dim < 1. {
        bubble = bubble.opacity(dim);
    }
    if message.status == "failed" {
        bubble = bubble.border_1().border_color(theme.red);
    }

    if !own && context.is_group && !grouped && !bare {
        let name = context.users.get(&message.sender_id).map(|u| u.display_name.clone()).unwrap_or_else(|| "Unknown".into());
        bubble = bubble.child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).mb(px(1.)).line_height(px(18.)).text_color(theme::css(name_color(&message.sender_id))).child(name));
    }

    if placeholder {
        let (icon_name, text, danger) = if is_deleted {
            (None, "Message deleted", false)
        } else if message.status == "undecryptable" {
            (Some("spinner"), "Waiting for this message's keys", false)
        } else if message.status == "unverified" {
            (Some("shield-alert"), "This message couldn't be verified, so it isn't shown.", true)
        } else {
            (Some("shield-alert"), "This message couldn't be displayed.", true)
        };
        let color = if danger { theme.danger_text } else if own { theme.bubble_own_faint } else { theme.text2 };
        let mut line = div().flex().items_center().gap(px(7.)).text_size(px(13.5)).text_color(color);
        match icon_name {
            Some("spinner") => line = line.child(spinner(12., color)),
            Some(name) => line = line.child(icon(name, 14., color)),
            None => {}
        }
        bubble = bubble.child(line.child(text));
    } else {
        if let Some(forwarded) = &message.forwarded {
            let name = forwarded.user_id.as_deref().map(|id| name_of(context, id));
            bubble = bubble.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .mt(px(1.))
                    .mb(px(3.))
                    .text_size(px(12.5))
                    .text_color(faint)
                    .child(icon("forward", 13., faint))
                    .child(match name {
                        Some(name) => div().flex().gap(px(4.)).child("Forwarded from").child(div().font_weight(FontWeight::SEMIBOLD).text_color(text_color).child(name)).into_any_element(),
                        None => div().child("Forwarded").into_any_element(),
                    }),
            );
        }
        if let Some(reply) = &message.reply {
            let reply_name = if reply.sender_id.is_empty() { "Earlier message".to_string() } else { name_of(context, &reply.sender_id) };
            let blocked_reply = context.blocked.contains(&reply.sender_id);
            let reply_text = if reply.deleted {
                "Message deleted".to_string()
            } else if blocked_reply {
                "A message from someone you blocked".into()
            } else {
                let plain = markup::plain_text(&reply.text);
                if !plain.is_empty() {
                    plain
                } else if reply.has_attachment {
                    "Attachment".into()
                } else {
                    "Tap to view".into()
                }
            };
            let state = context.state.clone();
            let group = message.group_id.clone();
            let target = reply.id.clone();
            let border = if own { theme.bubble_own_faint } else { theme.text3 };
            let bg = if own { theme::color(theme::white_a(0.07)) } else { theme.hover };
            let author_color = if own { theme.bubble_own_text } else { theme::css(name_color(if reply.sender_id.is_empty() { "x" } else { &reply.sender_id })) };
            bubble = bubble.child(
                div()
                    .id(SharedString::from(format!("reply-{}", message.id)))
                    .w_full()
                    .mt(px(2.))
                    .mb(px(4.))
                    .px(px(8.))
                    .py(px(2.))
                    .rounded(px(4.))
                    .border_l_2()
                    .border_color(border)
                    .bg(bg)
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.hover_strong))
                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.jump_to_message(&group, &target, cx)))
                    .child(div().text_size(px(12.5)).line_height(px(17.)).font_weight(FontWeight::SEMIBOLD).text_color(author_color).child(reply_name))
                    .child(div().max_w(px(340.)).one_line().text_size(px(12.5)).line_height(px(17.)).text_color(faint).child(reply_text)),
            );
        }
        if !message.attachments.is_empty() {
            // Under the name, a forwarded line or a reply, pictures start below them (`.msg-author + .media-grid`).
            let after_header = (!own && context.is_group && !grouped && !bare) || message.forwarded.is_some() || message.reply.is_some();
            bubble = bubble.child(attachments(message, &images, only_images, own, grouped, after_header, context, &theme, cx));
        }
        if !message.text.is_empty() {
            if jumbo > 0 {
                bubble = bubble.child(jumbo_body(message, context, cx));
            } else {
                bubble = bubble.child(text_body(message, own, meta_in_text, context, &theme, window, cx));
            }
        }
        if let Some(preview) = &message.preview {
            bubble = bubble.child(link_card(preview, own, &theme, cx));
        }
        if let Some(location) = &message.location {
            bubble = bubble.child(location_card(&message.id, location, own, false, &theme));
        }
    }

    if has_reactions {
        let total: usize = message.reactions.iter().map(|r| r.user_ids.len()).sum();
        let mut row = div().flex().flex_wrap().items_center().gap(px(4.)).mt(px(5.));
        for reaction in &message.reactions {
            row = row.child(reaction_chip(reaction, message, own, bare, total <= 3, context, &theme, cx));
        }
        row = row.child(div().flex_1().flex().justify_end().pl(px(8.)).child(meta));
        bubble = bubble.child(row);
    } else if !meta_in_text {
        if bare {
            bubble = bubble.child(div().flex().justify_end().mt(px(if only_round { 3. } else { 1. })).child(meta));
        } else if only_images {
            bubble = bubble.child(div().absolute().right(px(7.)).bottom(px(7.)).child(meta));
        } else {
            bubble = bubble.child(div().flex().justify_end().mt(px(5.)).mb(px(-2.)).mr(px(-2.)).child(meta));
        }
    } else {
        bubble = bubble.child(div().absolute().right(px(9.)).bottom(px(4.)).child(meta));
    }

    // The tail on the last message of a run, reaching over the bubble's corner.
    if last_in_group && !bare && message.status != "failed" && !only_images {
        let tail = gpui::svg().path(if own { "icons/bubble-tail-right.svg" } else { "icons/bubble-tail-left.svg" }).w(px(11.)).h(px(10.)).text_color(bubble_bg);
        bubble = bubble.child(if own { div().absolute().bottom_0().right(px(-6.)).child(tail) } else { div().absolute().bottom_0().left(px(-6.)).child(tail) });
    }

    let id = message.id.clone();
    let group = SharedString::from(format!("msg-{id}"));
    let mut stack = div().flex().flex_col().min_w_0().max_w(relative(0.74)).child(bubble);
    if own {
        stack = stack.items_end();
    }
    if message.status == "failed" {
        let state = context.state.clone();
        let (group_id, message_id) = (message.group_id.clone(), message.id.clone());
        stack = stack.child(
            div()
                .id(SharedString::from(format!("retry-{id}")))
                .flex()
                .items_center()
                .gap(px(5.))
                .mt(px(3.))
                .text_size(px(12.))
                .text_color(theme.red)
                .cursor_pointer()
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("retryMessage", vec![json!(group_id), json!(message_id)], cx)))
                .child(icon("circle-alert", 13., theme.red))
                .child("Not sent. Try again"),
        );
    }

    let entries = menu_entries(message, own, can_act, context);
    let selecting = context.selecting;
    let selected = context.selected.contains(&message.id);
    let react_state = context.state.clone();
    let (react_group, react_id) = (message.group_id.clone(), message.id.clone());
    let menu_entries_for_right_click = entries.clone();
    let mut row = div()
        .id(SharedString::from(format!("msg-row-{id}")))
        .group(group.clone())
        .when(can_act && !selecting, |el| el.on_click(reply_on_double_click(message, context)))
        .relative()
        .flex()
        .items_end()
        .gap(px(8.))
        .mt(px(if grouped { 2. } else { 8. }))
        .rounded(px(12.))
        .when(highlighted, |el| el.bg(theme.hover_strong))
        .when(own, |el| el.flex_row_reverse())
        // Picking, as in Telegram: a circle on the left, the row highlighted, and a click picks.
        .when(selecting, |el| {
            let state = context.state.clone();
            let (list_id, id) = (context.list_id.clone(), message.id.clone());
            el.pl(px(34.))
                .pr(px(8.))
                .cursor_pointer()
                .when(selected, |el| el.bg(theme.accent_soft))
                .on_click(move |_, _, cx| {
                    if can_act {
                        state.update(cx, |state, cx| state.toggle_selected(&list_id, Some(&id), cx));
                    }
                })
                .child(
                    div()
                        .absolute()
                        .left(px(6.))
                        .bottom(px(6.))
                        .size(px(20.))
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .border_2()
                        .border_color(if selected { theme.accent } else { theme.text3 })
                        .when(selected, |el| el.bg(theme.accent).child(icon("check", 13., theme.on_accent)))
                        .when(!can_act, |el| el.opacity(0.3)),
                )
        })
        .on_mouse_down(MouseButton::Right, move |event, _, cx| {
            if menu_entries_for_right_click.is_empty() {
                return;
            }
            let state = react_state.clone();
            let (group, id) = (react_group.clone(), react_id.clone());
            let reactions = if can_act { QUICK_REACTIONS.to_vec() } else { Vec::new() };
            open_menu_with_reactions(
                event.position,
                menu_entries_for_right_click.clone(),
                reactions,
                move |emoji, _, cx| state.update(cx, |state, cx| state.act("toggleReaction", vec![json!(group), json!(id), json!(emoji)], cx)),
                false,
                cx,
            );
        });
    if !own && context.is_group {
        let mut slot = div().w(px(32.)).flex_none().mr(px(3.)).flex();
        if last_in_group {
            let user = context.users.get(&message.sender_id);
            let name = user.map(|u| u.display_name.clone()).unwrap_or_else(|| "Unknown".into());
            let image = context.avatars.get(&message.sender_id).cloned();
            slot = slot.child(avatar(AvatarProps { name, seed: message.sender_id.clone(), image, size: 32., online: false, rounded: false, dot_border: theme.bg_chat }, cx));
        }
        row = row.child(slot);
    }
    row = row.child(stack);
    if can_act && !selecting {
        let state = context.state.clone();
        let list_id = context.list_id.clone();
        let reply_message = message.clone();
        let more_entries = entries;
        let more_state = context.state.clone();
        let (more_group, more_id) = (message.group_id.clone(), message.id.clone());
        let picker_state = context.state.clone();
        let (picker_group, picker_id) = (message.group_id.clone(), message.id.clone());
        row = row.child(
            div()
                .flex()
                .flex_none()
                .self_center()
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .when(own, |el| el.flex_row_reverse())
                .child(icon_button_in(SharedString::from(format!("react-{id}")), "face-slightly-smiling-plus", 15., true, false, theme.text3, cx).tip("React", Side::Top).on_click(move |event, window, cx| {
                    let state = picker_state.clone();
                    let (group, id) = (picker_group.clone(), picker_id.clone());
                    super::picker::open_picker(
                        event.position(),
                        false,
                        move |pick, _, cx| {
                            let args = match pick {
                                super::picker::Pick::Emoji(value) => vec![json!(group), json!(id), json!(value)],
                                super::picker::Pick::Emote(emote) => vec![
                                    json!(group),
                                    json!(id),
                                    json!(emote.name),
                                    emote.to_ref(),
                                ],
                            };
                            state.update(cx, |state, cx| state.act("toggleReaction", args, cx));
                        },
                        window,
                        cx,
                    );
                }))
                .child(
                    icon_button_in(SharedString::from(format!("reply-btn-{id}")), "corner-up-left", 15., true, false, theme.text3, cx)
                        .tip("Reply", Side::Top)
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_reply(&list_id, Some(reply_message.clone()), cx))),
                )
                .child(icon_button_in(SharedString::from(format!("more-{id}")), "ellipsis", 15., true, false, theme.text3, cx).tip("More", Side::Top).on_click(move |event, _, cx| {
                    let state = more_state.clone();
                    let (group, id) = (more_group.clone(), more_id.clone());
                    open_menu_with_reactions(
                        event.position(),
                        more_entries.clone(),
                        QUICK_REACTIONS.to_vec(),
                        move |emoji, _, cx| state.update(cx, |state, cx| state.act("toggleReaction", vec![json!(group), json!(id), json!(emoji)], cx)),
                        own,
                        cx,
                    );
                })),
        );
    }
    row.into_any_element()
}

/// How long a message can take to send before it's shown as waiting, with the clock in place of
/// its tick: as long as its bubble waits to dim.
pub const SLOW_SEND_MS: f64 = 500.;

fn meta_element(message: &MessageView, own: bool, is_deleted: bool, read_up_to: f64, color: Hsla, overlay: bool, theme: &Theme, window: &mut Window) -> gpui::Div {
    let color = if overlay { gpui::white() } else { color };
    let mut meta = div().flex().flex_none().items_center().gap(px(3.)).h(px(16.)).text_size(px(11.5)).line_height(px(16.)).text_color(color).whitespace_nowrap();
    if overlay {
        meta = meta.px(px(6.)).h(px(18.)).rounded(px(9.)).bg(theme::color(theme::black_a(0.55)));
    }
    if message.time_differs == Some(true) {
        meta = meta.child(icon("shield-alert", 11., color));
    }
    if message.expires_at.is_some() {
        meta = meta.child(icon("timer", 10., color));
    }
    if message.pinned_at.is_some() {
        meta = meta.child(icon("pin", 10., color).with_transformation(gpui::Transformation::rotate(gpui::radians(35f32.to_radians()))));
    }
    if message.edited_at.is_some() && !is_deleted {
        meta = meta.child("edited");
    }
    meta = meta.child(format_time(message.created_at));
    if own && !is_deleted {
        let ticks = |read: bool| {
            gpui::svg()
                .path(if read { "icons/ticks-read.svg" } else { "icons/ticks-sent.svg" })
                .w(px(18.))
                .h(px(10.))
                .text_color(if read { theme.accent_text } else { color })
        };
        // Ticks pop in when they first show, as `.msg.is-fresh .msg-tick`, under one id while the
        // message sends and once it's sent, so a quick send's tick is simply there all along. Shown
        // only after the clock, they're new to GPUI, and pop in then.
        let popping = |ticks: gpui::Svg| ticks.enter(SharedString::from(format!("tick-sent-{}", message.id)), Enter::Pop, 120).into_any_element();
        let tick: AnyElement = match message.status.as_str() {
            // Shown as sent at once, as nearly every message is a moment later. Its time is this
            // device's own until the server takes it, so this is how long it's been sending.
            "sending" if read_up_to >= 0. && crate::format::now_ms() - message.created_at < SLOW_SEND_MS => {
                // Drawn again to show the clock if it's still sending by then.
                window.request_animation_frame();
                popping(ticks(false))
            }
            // `.msg-tick.is-sending`: once it's been sending for as long as the bubble takes to dim.
            "sending" => icon("clock", 11., color).enter(SharedString::from(format!("tick-sending-{}", message.id)), Enter::Fade, 120).into_any_element(),
            "failed" => icon("circle-alert", 12., theme.danger_text).into_any_element(),
            _ => match message.seq {
                Some(seq) if read_up_to >= 0. => {
                    let read = read_up_to >= seq;
                    // A just-sent message's ticks, or one sent from another device.
                    if crate::format::now_ms() - message.created_at < 1500. {
                        popping(ticks(read))
                    } else {
                        ticks(read).into_any_element()
                    }
                }
                _ => div().into_any_element(),
            },
        };
        meta = meta.child(div().flex_none().w(px(18.)).h(px(14.)).ml(px(3.)).mr(px(-3.)).mb(px(2.)).flex().items_center().justify_center().child(tick));
    }
    meta
}

/// How much room the time takes at the end of the last line, as spaces of the message's own font:
/// as wide as `meta_element` draws it, 12 px from the text as `.msg-meta`'s margin, less the 2 px
/// it reaches into the bubble's padding.
fn meta_padding(message: &MessageView, own: bool, theme: &Theme, window: &mut Window) -> String {
    let small = TextRun { len: 0, font: gpui::font(FONT_UI), color: gpui::black(), background_color: None, underline: None, strikethrough: None };
    let mut label = format_time(message.created_at);
    if message.edited_at.is_some() {
        label = format!("edited {label}");
    }
    let measure = |text: &str, size: Pixels, window: &mut Window| -> f32 {
        let run = TextRun { len: text.len(), ..small.clone() };
        f32::from(window.text_system().shape_line(SharedString::from(text.to_string()), size, &[run], None).width)
    };
    let mut width = measure(&label, px(11.5), window) + 10.;
    if own {
        width += 21.;
    }
    if message.time_differs == Some(true) {
        width += 14.;
    }
    if message.pinned_at.is_some() {
        width += 13.;
    }
    if message.expires_at.is_some() {
        width += 13.;
    }
    let space = measure("\u{a0}\u{a0}\u{a0}\u{a0}", theme.message_size, window) / 4.;
    let count = (width / space.max(1.)).round() as usize;
    "\u{a0}".repeat(count)
}

fn runs_for(rich: &Rich, own: bool, revealed: bool, theme: &Theme, base: Hsla) -> Vec<TextRun> {
    let mut runs = Vec::new();
    let mut position = 0;
    let plain_font = gpui::font(FONT_UI);
    for (range, style) in &rich.spans {
        if range.start > position {
            runs.push(TextRun { len: range.start - position, font: plain_font.clone(), color: base, background_color: None, underline: None, strikethrough: None });
        }
        let mut font = if style.code { gpui::font(FONT_MONO) } else { plain_font.clone() };
        if style.bold {
            font.weight = FontWeight::BOLD;
        }
        if style.mention.is_some() {
            font.weight = FontWeight::MEDIUM;
        }
        if style.italic {
            font.style = FontStyle::Italic;
        }
        let mut color = base;
        let mut background = None;
        let mut underline = None;
        if style.code {
            background = Some(theme::color(theme::white_a(0.09)));
        }
        if let Some((_, is_self)) = &style.mention {
            background = Some(theme::color(theme::white_a(if *is_self { 0.18 } else { 0.09 })));
        }
        if style.link.is_some() {
            if own {
                color = theme.bubble_own_text;
                underline = Some(UnderlineStyle { color: Some(color), thickness: px(1.), wavy: false });
            } else {
                color = theme.link;
            }
        }
        if style.emote.is_some() {
            color = theme.text2;
        }
        if style.spoiler && !revealed {
            color = gpui::transparent_black();
            background = Some(theme.bg5);
        }
        runs.push(TextRun {
            len: range.end - range.start,
            font,
            color,
            background_color: background,
            underline,
            strikethrough: style.strike.then(|| StrikethroughStyle { thickness: px(1.), color: Some(color) }),
        });
        position = range.end;
    }
    if position < rich.text.len() {
        runs.push(TextRun { len: rich.text.len() - position, font: plain_font, color: base, background_color: None, underline: None, strikethrough: None });
    }
    runs
}

/// A block with emotes in it, as words and pictures that wrap together: 26 px emotes
/// on the line, as `.emote-inline` draws them, and a gap for the time at the end.
#[allow(clippy::too_many_arguments)]
fn flow_text(
    message: &MessageView,
    index: usize,
    rich: &Rich,
    own: bool,
    revealed: bool,
    trailing: bool,
    color: gpui::Hsla,
    context: &ChatContext,
    theme: &Theme,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut row = div().flex().flex_wrap().items_end();
    let mut piece = 0;
    for (range, style) in &rich.spans {
        let text = &rich.text[range.clone()];
        if let Some((name, emote)) = &style.emote {
            let url = crate::models::emote_url(&context.server_url, &emote.id);
            let image = context.state.update(cx, |state, cx| state.remote_picture(&url, cx));
            let zero_width = emote.zero_width == Some(true);
            let width = emote_width(context, &emote.id, 26., 110.);
            let picture = match image {
                Some(image) => with_emote_card(
                    img(image)
                        .h(px(26.))
                        .when_some(width, |el, width| el.w(px(width)))
                        .max_w(px(110.))
                        .object_fit(gpui::ObjectFit::Contain)
                        // An id keeps an animated emote's place between frames.
                        .id(SharedString::from(format!("emote-{}-{}-{}", message.id, index, range.start))),
                    SharedString::from(format!("emote-card-{}-{}-{}", message.id, index, range.start)),
                    name,
                    emote,
                    None,
                    context,
                    cx,
                )
                .mx(px(1.))
                .my(px(-3.))
                .when(zero_width, |el| el.ml(px(-28.)))
                .into_any_element(),
                None => emote_placeholder(context, &url, name, width, 26., cx).mx(px(1.)).my(px(-3.)).when(zero_width, |el| el.ml(px(-28.))).into_any_element(),
            };
            // Selected whole, and copied as its name.
            row = row.child(selection::selectable(&message.id, index * 10_000 + piece, index, name.clone(), None, picture));
            piece += 1;
            continue;
        }
        // Words with their spaces, so lines break between them.
        let mut start = 0;
        let mut words = Vec::new();
        for (offset, ch) in text.char_indices() {
            if ch.is_whitespace() {
                let end = offset + ch.len_utf8();
                words.push(&text[start..end]);
                start = end;
            }
        }
        if start < text.len() {
            words.push(&text[start..]);
        }
        for word in words {
            let mut single = Rich { text: word.to_string(), spans: vec![(0..word.len(), style.clone())] };
            single.spans.retain(|(range, _)| !range.is_empty());
            let runs = runs_for(&single, own, revealed, theme, color);
            let len = single.text.len();
            row = row.child(interactive_text(&message.id, index * 10_000 + piece, index, single, runs, len, context));
            piece += 1;
        }
    }
    if trailing {
        // Room for the time, which wraps to a line of its own when the last one is full.
        let padding = meta_padding(message, own, theme, window);
        let run = TextRun { len: padding.len(), font: gpui::font(FONT_UI), color: gpui::transparent_black(), background_color: None, underline: None, strikethrough: None };
        row = row.child(StyledText::new(SharedString::from(padding)).with_runs(vec![run]));
    }
    row.into_any_element()
}

pub(super) fn text_body(message: &MessageView, own: bool, meta_in_text: bool, context: &ChatContext, theme: &Theme, window: &mut Window, cx: &mut App) -> AnyElement {
    let cached = context.parsed.borrow().get(&message.id).cloned();
    let blocks = cached.unwrap_or_else(|| {
        let markup_context = markup::Context { emotes: &message.emotes, mentionable: &context.mentionable, self_id: &context.self_id };
        let blocks = Rc::new(markup::parse(&message.text, &markup_context));
        context.parsed.borrow_mut().insert(message.id.clone(), blocks.clone());
        blocks
    });
    let base = if own { theme.bubble_own_text } else { theme.text1 };
    let revealed = context.revealed.borrow().contains(&message.id);
    let last_text = blocks.iter().rposition(|block| matches!(block, Block::Text(_)));
    let ends_in_text = matches!(blocks.last(), Some(Block::Text(_)));
    let mut column = div().flex().flex_col().gap(px(3.));
    for (index, block) in blocks.iter().enumerate() {
        match block {
            Block::Text(rich) | Block::Quote(rich) => {
                let quote = matches!(block, Block::Quote(_));
                let mut rich = rich.clone();
                let color = if quote { if own { theme.bubble_own_faint } else { theme.text2 } } else { base };
                if rich.has_emotes() {
                    // Pictures can't sit inside GPUI's text, so the block flows as words and emotes.
                    let trailing = meta_in_text && Some(index) == last_text && ends_in_text;
                    let element = flow_text(message, index, &rich, own, revealed, trailing, color, context, theme, window, cx);
                    column = column.child(if quote {
                        div().pl(px(9.)).my(px(2.)).border_l_2().border_color(if own { theme.bubble_own_faint } else { theme.text3 }).child(element).into_any_element()
                    } else {
                        element
                    });
                    continue;
                }
                // What can be selected: the text, not the room left for the time.
                let len = rich.text.len();
                if meta_in_text && Some(index) == last_text && ends_in_text {
                    let padding = meta_padding(message, own, theme, window);
                    let start = rich.text.len();
                    rich.text.push_str(&padding);
                    rich.spans.push((start..rich.text.len(), markup::SpanStyle::default()));
                }
                let mut runs = runs_for(&rich, own, revealed, theme, color);
                if meta_in_text && Some(index) == last_text && ends_in_text {
                    if let Some(last) = runs.last_mut() {
                        last.color = gpui::transparent_black();
                        last.background_color = None;
                    }
                }
                let element = interactive_text(&message.id, index * 10_000, index, rich, runs, len, context);
                column = column.child(if quote {
                    div().pl(px(9.)).my(px(2.)).border_l_2().border_color(if own { theme.bubble_own_faint } else { theme.text3 }).child(element).into_any_element()
                } else {
                    element
                });
            }
            Block::Code { text, language } => {
                column = column.child(code_block(text, language.as_deref(), &message.id, index, theme));
            }
        }
    }
    if meta_in_text && !ends_in_text {
        column = column.child(div().h(px(16.)));
    }
    column.into_any_element()
}

/// A run of a message's text, which can be selected: `order` places it among the message's
/// pieces, in its `block`, and the first `len` bytes of it are the message's own.
#[allow(clippy::too_many_arguments)]
fn interactive_text(message_id: &str, order: usize, block: usize, rich: Rich, runs: Vec<TextRun>, len: usize, context: &ChatContext) -> AnyElement {
    let targets: Vec<(std::ops::Range<usize>, Target)> = rich
        .spans
        .iter()
        .filter_map(|(range, style)| {
            if let Some(link) = &style.link {
                Some((range.clone(), Target::Link(link.clone())))
            } else if let Some((user, _)) = &style.mention {
                Some((range.clone(), Target::User(user.clone())))
            } else if style.spoiler {
                Some((range.clone(), Target::Spoiler))
            } else {
                None
            }
        })
        .collect();
    let styled = StyledText::new(SharedString::from(rich.text.clone())).with_runs(runs);
    let layout = styled.layout().clone();
    let text = SharedString::from(rich.text[..len].to_string());
    if targets.is_empty() {
        return div().whitespace_normal().child(selection::selectable(message_id, order, block, text, Some(layout), styled)).into_any_element();
    }
    let ranges: Vec<_> = targets.iter().map(|(range, _)| range.clone()).collect();
    let state = context.state.clone();
    let revealed = context.revealed.clone();
    let id = message_id.to_string();
    let interactive = InteractiveText::new(SharedString::from(format!("text-{message_id}-{order}")), styled)
        .on_click(ranges, move |clicked, _window, cx| match &targets[clicked].1 {
            Target::Link(url) => cx.open_url(url),
            Target::User(user) => state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user.clone() }), cx)),
            Target::Spoiler => {
                revealed.borrow_mut().insert(id.clone());
                state.update(cx, |_, cx| cx.notify());
            }
        });
    selection::selectable(message_id, order, block, text, Some(layout), interactive).into_any_element()
}

enum Target {
    Link(String),
    User(String),
    Spoiler,
}

fn code_block(text: &str, language: Option<&str>, message_id: &str, index: usize, theme: &Theme) -> AnyElement {
    let copy_text = text.to_string();
    div()
        .mt(px(4.))
        .mb(px(2.))
        .rounded(RADIUS_M)
        .overflow_hidden()
        .bg(theme.bg0)
        .border_1()
        .border_color(theme.line)
        .min_w(px(300.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .pl(px(10.))
                .pr(px(5.))
                .py(px(3.))
                .text_size(px(11.5))
                .line_height(px(16.))
                .text_color(theme.text3)
                .border_b_1()
                .border_color(theme.line)
                .child(language.unwrap_or("code").to_string())
                .child(
                    div()
                        .id(SharedString::from(format!("copy-{message_id}-{index}")))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover_strong).text_color(theme.text1))
                        .on_click(move |_, _, cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy_text.clone())))
                        .child(icon("copy", 12., theme.text3))
                        .child("Copy"),
                ),
        )
        .child(
            div()
                .id(SharedString::from(format!("code-{message_id}-{index}")))
                .overflow_x_scroll()
                .px(px(11.))
                .py(px(8.))
                .font_family(FONT_MONO)
                .text_size(px(12.5))
                .line_height(relative(1.5))
                .text_color(theme::color(theme::hex(0xe6edf3)))
                .whitespace_nowrap()
                .child({
                    let styled = StyledText::new(SharedString::from(text.to_string()));
                    let layout = styled.layout().clone();
                    selection::selectable(message_id, index * 10_000, index, text.to_string(), Some(layout), styled)
                }),
        )
        .into_any_element()
}

pub(super) fn jumbo_body(message: &MessageView, context: &ChatContext, cx: &mut App) -> AnyElement {
    let mut row = div().flex().flex_wrap().items_end().gap(px(2.));
    for (position, word) in message.text.split_whitespace().enumerate() {
        if let Some(emote) = message.emotes.get(word) {
            let url = crate::models::emote_url(&context.server_url, &emote.id);
            let image = context.state.update(cx, |state, cx| state.remote_picture(&url, cx));
            let width = emote_width(context, &emote.id, 48., 150.);
            row = row.child(match image {
                Some(image) => {
                    let picture = img(image).h(px(48.)).when_some(width, |el, width| el.w(px(width))).max_w(px(150.)).object_fit(gpui::ObjectFit::Contain).id(SharedString::from(format!("jumbo-{}-{position}", message.id)));
                    with_emote_card(picture, SharedString::from(format!("jumbo-card-{}-{position}", message.id)), word, emote, None, context, cx).into_any_element()
                }
                None => emote_placeholder(context, &url, word, width, 48., cx).into_any_element(),
            });
        } else {
            row = row.child(div().text_size(px(34.)).line_height(relative(1.15)).child(word.to_string()));
        }
    }
    row.into_any_element()
}

/// An emote with its card, as `Emote` in `components/Emote.tsx`: after 120 ms under the
/// pointer, its picture larger, its name, who made it, and a note, such as who reacted with it.
pub(super) fn with_emote_card(picture: impl IntoElement, id: impl Into<ElementId>, name: &str, emote: &EmoteRef, note: Option<String>, context: &ChatContext, cx: &App) -> Stateful<Div> {
    // Recorded in the message, or known from the server's set.
    let owner = emote.owner.clone().filter(|owner| !owner.is_empty()).or_else(|| {
        let server = context.state.read(cx).servers.get(&context.server_id)?;
        server.emotes.emotes.iter().find(|item| item.id == emote.id).map(|item| item.owner.clone()).filter(|owner| !owner.is_empty())
    });
    let bounds = Rc::new(std::cell::Cell::new(None));
    let seen = bounds.clone();
    let state = context.state.clone();
    let address = format!("{}/api/emotes/{}", context.server_url, emote.id);
    let name = SharedString::from(name.to_string());
    div()
        .id(id)
        .relative()
        .child(picture)
        .child(gpui::canvas(move |area, _, _| seen.set(Some(area)), |_, _, _, _| {}).absolute().inset_0())
        .tooltip_show_delay(std::time::Duration::from_millis(120))
        .tooltip(move |window, cx| {
            let card = EmoteCard {
                state: state.clone(),
                address: address.clone(),
                name: name.clone(),
                owner: owner.clone().map(SharedString::from),
                note: note.clone().map(SharedString::from),
                target: bounds.get(),
                from: window.mouse_position(),
            };
            let state = state.clone();
            cx.new(|cx| {
                // The larger picture, once it's fetched.
                cx.observe(&state, |_, _, cx| cx.notify()).detach();
                card
            })
            .into()
        })
}

/// `.emote-card`, above the emote, or below it where there's no room, kept inside the window.
struct EmoteCard {
    state: Entity<AppState>,
    address: String,
    name: SharedString,
    owner: Option<SharedString>,
    note: Option<SharedString>,
    target: Option<gpui::Bounds<Pixels>>,
    /// GPUI lays a tooltip out from the pointer, as it was when it was built.
    from: gpui::Point<Pixels>,
}

impl Render for EmoteCard {
    fn render(&mut self, window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(target) = self.target else { return div() };
        // Gone once the pointer leaves the emote, as GPUI judges by its bounds even under an overlay.
        if !target.contains(&window.mouse_position()) {
            return div();
        }
        let (large, small) = (format!("{}/3x.webp", self.address), format!("{}/2x.webp", self.address));
        let image = self.state.update(cx, |state, cx| state.remote_picture(&large, cx).or_else(|| state.remote_picture(&small, cx)));
        let measure = |text: &str, size: f32, weight: FontWeight, window: &mut Window| {
            let run = TextRun { len: text.len(), font: gpui::Font { weight, ..gpui::font(FONT_UI) }, color: theme.text1, background_color: None, underline: None, strikethrough: None };
            f32::from(window.text_system().shape_line(SharedString::from(text.to_string()), px(size), &[run], None).width)
        };
        let owner = self.owner.as_ref().map(|owner| format!("by {owner}"));
        let mut text_width = measure(&self.name, 14., FontWeight::SEMIBOLD, window);
        let mut text_height: f32 = 19.;
        if let Some(owner) = &owner {
            text_width = text_width.max(measure(owner, 12.5, FontWeight::NORMAL, window));
            text_height += 17.;
        }
        if let Some(note) = &self.note {
            text_width = text_width.max(measure(note, 11., FontWeight::NORMAL, window));
            text_height += 17.;
        }
        // Its padding, picture, gap and border around the text, from 170 to 300 px wide.
        let width = px((text_width + 10. + 56. + 12. + 14. + 2.).clamp(170., 300.));
        let height = px(text_height.max(56.) + 22.);
        let viewport = window.viewport_size();
        let left = (target.center().x - width / 2.).min(viewport.width - width - px(8.)).max(px(8.));
        let above = target.top() - height - px(8.);
        let top = if above >= px(8.) { above } else { target.bottom() + px(8.) };
        let card = div()
            .w(width)
            .flex()
            .items_center()
            .gap(px(12.))
            .pl(px(10.))
            .pr(px(14.))
            .py(px(10.))
            .bg(theme.bg3)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(theme::RADIUS_L)
            .shadow(shadow_m())
            .font_family(FONT_UI)
            .child(match image {
                Some(image) => img(image).id("emote-card-picture").size(px(56.)).flex_none().object_fit(gpui::ObjectFit::Contain).into_any_element(),
                None => div().size(px(56.)).flex_none().into_any_element(),
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().text_size(px(14.)).line_height(px(19.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(self.name.clone()))
                    .when_some(owner, |el, owner| el.child(div().text_size(px(12.5)).line_height(px(17.)).text_color(theme.text2).child(owner)))
                    .when_some(self.note.clone(), |el, note| el.child(div().mt(px(2.)).text_size(px(11.)).line_height(px(15.)).text_color(theme.text3).child(note))),
            );
        // Nothing of its own size, so GPUI never moves it, and the card placed from the pointer.
        let origin = self.from + gpui::point(px(1.), px(1.));
        div()
            .size_0()
            .child(card.absolute().left(left - origin.x).top(top - origin.y).enter("emote-card-in", Enter::Fade, 80))
            // Drawn again as the pointer moves, so it's gone as soon as it leaves.
            .child(gpui::canvas(|_, _, _| {}, |_, _, window, _| window.on_mouse_event(|_: &gpui::MouseMoveEvent, _, window, _| window.refresh())))
    }
}

fn reaction_chip(reaction: &ReactionView, message: &MessageView, own: bool, jumbo: bool, show_people: bool, context: &ChatContext, theme: &Theme, cx: &mut App) -> AnyElement {
    let mine = reaction.user_ids.contains(&context.self_id);
    let names = reaction.user_ids.iter().map(|id| name_of(context, id)).collect::<Vec<_>>().join(", ");
    let (bg, fg, hover) = if mine {
        if !theme.neutral && own { (gpui::white(), theme::color(theme::hex(0x111113)), gpui::white()) } else { (theme.text1, theme.bg1, gpui::white()) }
    } else if jumbo {
        (theme.bg3, theme.text1, theme.bg4)
    } else {
        (theme::color(theme::white_a(0.08)), if own { theme.bubble_own_text } else { theme.text1 }, theme::color(theme::white_a(0.13)))
    };
    let state = context.state.clone();
    let (group, id, key) = (message.group_id.clone(), message.id.clone(), reaction.key.clone());
    let emote = reaction.emote.clone();
    // `.reaction`: its background comes up over 100 ms under the pointer.
    let hover_key = format!("reaction-{}-{}", message.id, reaction.key);
    let mut chip = super::motion::track_hover(div().id(SharedString::from(hover_key.clone())), hover_key.clone())
        .relative()
        .flex()
        .items_center()
        .gap(px(4.))
        .h(px(24.))
        .pl(px(6.))
        .pr(px(7.))
        .rounded(px(12.))
        .bg(bg)
        .text_color(fg)
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .child(super::motion::hover_layer(&hover_key, hover, px(12.), 100))
        // An emote's card says who reacted, in place of the tooltip.
        .when(reaction.emote.is_none(), |el| el.tip(names.clone(), Side::Top))
        .on_click(move |_, _, cx| {
            let mut args = vec![json!(group), json!(id), json!(key)];
            if let Some(emote) = &emote {
                args.push(serde_json::to_value(emote).unwrap_or_default());
            }
            state.update(cx, |state, cx| state.act("toggleReaction", args, cx))
        });
    chip = match &reaction.emote {
        Some(emote) => {
            let url = crate::models::emote_url(&context.server_url, &emote.id);
            match context.state.update(cx, |state, cx| state.remote_picture(&url, cx)) {
                Some(image) => {
                    let picture = img(image).h(px(18.)).when_some(emote_width(context, &emote.id, 18., 40.), |el, width| el.w(px(width))).max_w(px(40.)).object_fit(gpui::ObjectFit::Contain).id(SharedString::from(format!("reaction-emote-{}-{}", message.id, reaction.key)));
                    chip.child(with_emote_card(picture, SharedString::from(format!("reaction-card-{}-{}", message.id, reaction.key)), &reaction.key, emote, Some(format!("Reacted by {names}")), context, cx))
                }
                None => chip.child(emote_placeholder(context, &url, &reaction.key, emote_width(context, &emote.id, 18., 40.), 18., cx)),
            }
        }
        None => chip.child(div().text_size(px(14.)).line_height(px(14.)).child(reaction.key.clone())),
    };
    if show_people {
        let mut people = div().flex().ml(px(1.));
        for (index, user_id) in reaction.user_ids.iter().enumerate() {
            let name = context.users.get(user_id).map(|u| u.display_name.clone()).unwrap_or("?".into());
            let image = context.avatars.get(user_id).cloned();
            let mut face = avatar(AvatarProps { name, seed: user_id.clone(), image, size: 16., online: false, rounded: false, dot_border: bg }, cx).text_size(px(7.)).line_height(px(9.));
            if index > 0 {
                face = face.ml(px(-5.));
            }
            people = people.child(face);
        }
        chip = chip.child(people);
    } else {
        chip = chip.child(reaction.user_ids.len().to_string());
    }
    // `.reaction`: pop-in 0.1s, when it's first there.
    chip.enter_once(format!("reaction-in-{}-{}", message.id, reaction.key), Enter::Pop, 100)
}

/// The corners of the pictures above a message, as `.media-grid`'s `border-radius: inherit`
/// takes the bubble's, or a channel's 8 px. GPUI clips to rectangles, so the pictures at the
/// grid's corners are rounded themselves.
fn media_corners(is_channel: bool, only_images: bool, own: bool, grouped_top: bool, after_header: bool) -> gpui::Corners<Pixels> {
    if is_channel {
        return gpui::Corners::all(px(8.));
    }
    let big = px(15.);
    let small = px(5.);
    let top_inner = if grouped_top { small } else { big };
    let (top_left, top_right) = if after_header { (px(0.), px(0.)) } else if own { (big, top_inner) } else { (top_inner, big) };
    let (bottom_left, bottom_right) = if only_images { if own { (big, small) } else { (small, big) } } else { (px(0.), px(0.)) };
    gpui::Corners { top_left, top_right, bottom_right, bottom_left }
}

/// Which of the grid's corners the picture at `index` of `count`, two to a row, is at.
fn tile_corners(grid: gpui::Corners<Pixels>, index: usize, count: usize) -> gpui::Corners<Pixels> {
    if count == 1 {
        return grid;
    }
    let (row, column, last_row) = (index / 2, index % 2, (count - 1) / 2);
    let zero = px(0.);
    gpui::Corners {
        top_left: if row == 0 && column == 0 { grid.top_left } else { zero },
        top_right: if row == 0 && column == 1 { grid.top_right } else { zero },
        bottom_right: if row == last_row && column == 1 { grid.bottom_right } else { zero },
        bottom_left: if row == last_row && column == 0 { grid.bottom_left } else { zero },
    }
}


pub(super) fn attachments(message: &MessageView, images: &[&Attachment], only_images: bool, own: bool, grouped_top: bool, after_header: bool, context: &ChatContext, theme: &Theme, cx: &mut App) -> AnyElement {
    let mut column = div().flex().flex_col();
    if !images.is_empty() {
        let single = images.len() == 1;
        let mut grid = div().relative().flex().flex_wrap().gap(px(2.)).overflow_hidden();
        if context.is_channel {
            grid = grid.max_w(px(550.)).rounded(px(8.));
        } else {
            grid = grid.mx(px(-11.)).mt(px(if after_header { 4. } else { -7. })).mb(px(if only_images { -7. } else { 6. }));
            if !after_header {
                grid = grid.rounded_t(px(15.));
            }
            if only_images {
                grid = if after_header { grid.rounded_b(px(15.)) } else { grid.rounded(px(15.)) };
            }
        }
        let corners = media_corners(context.is_channel, only_images, own, grouped_top, after_header);
        for (index, attachment) in images.iter().enumerate() {
            let corners = tile_corners(corners, index, images.len());
            // A lone picture's box is its own shape; the others are squares.
            let shape = if single { (attachment.width.unwrap_or(320.) / attachment.height.unwrap_or(240.)) as f32 } else { 1. };
            let width = attachment.width.unwrap_or(320.);
            let height = attachment.height.unwrap_or(240.);
            let (w, h) = if single {
                let scale = (420. / width).min(380. / height).min(1.);
                let w = (width * scale).max(140.);
                (w, w * height / width)
            } else {
                (209., 209.)
            };
            let image = context.images.get(&attachment.file_id).cloned();
            if image.is_some() {
                context.state.read(cx).touch_media(&format!("file:{}", attachment.file_id));
            }
            let thumb = attachment.thumb.as_ref().and_then(|thumb| data_url_image(thumb));
            // As `.media-tile.is-single`: its own width sizes the bubble, then it fills the
            // bubble's width, as wide as text or a link preview made it, keeping its shape. It
            // lies over a box that's sized so (`aspect_fill`). A channel's has no bubble to fill,
            // and stays its own size.
            let fills = single && !context.is_channel;
            let mut tile = round_corners(
                div()
                    .id(SharedString::from(format!("tile-{}-{}", message.id, attachment.file_id)))
                    .relative()
                    .when(image.is_none(), |el| el.bg(theme.bg3))
                    .overflow_hidden(),
                corners,
            );
            tile = if fills { tile.absolute().inset_0() } else { tile.w(px(w as f32)).h(px(h as f32)) };
            if let Some(image) = image {
                let (full, name) = (image.clone(), attachment.name.clone());
                tile = tile.cursor_pointer().on_click(move |_, window, cx| super::image_viewer::open(full.clone(), name.clone(), window, cx));
                // Drawn at twice the size it's shown at, for a sharp screen, never whole: a photo from a
                // camera decoded whole is 48 MB. The preview stays until it's ready.
                let picture = match covered(&image, shape, if single { 1200 } else { 418 }, cx) {
                    Covered::Ready(cropped) => Some(img(cropped).object_fit(gpui::ObjectFit::Fill)),
                    Covered::AsItIs => Some(img(image).object_fit(gpui::ObjectFit::Cover)),
                    Covered::Working => None,
                };
                tile = match picture {
                    // `.media-full`: faded in over the preview once it's here.
                    Some(picture) => tile.child(round_corners(picture.size_full(), corners).enter_once(format!("media-full-{}-{}", message.id, attachment.file_id), Enter::Fade, 120)),
                    None => tile.when_some(thumb, |tile, thumb| tile.child(round_corners(cover(thumb, shape, 200, cx).size_full().opacity(0.85), corners))),
                };
            } else {
                if let Some(thumb) = thumb {
                    tile = tile.child(round_corners(cover(thumb, shape, 200, cx).size_full().opacity(0.85), corners));
                }
                if attachment.file_id.is_empty() {
                    tile = tile.child(div().absolute().inset_0().flex().items_center().justify_center().child(spinner(18., gpui::white())));
                } else {
                    let server_id = context.server_id.clone();
                    let reference = crate::models::AvatarRef {
                        file_id: attachment.file_id.clone(),
                        key: attachment.key.clone(),
                        prefix: attachment.prefix.clone(),
                        chunks: attachment.chunks,
                        mime: attachment.mime.clone(),
                    };
                    let asked = context.state.read(cx).pictures.contains_key(&format!("file:{}", attachment.file_id));
                    if super::shared_media::loads_by_itself(attachment) || asked {
                        // Ask for it; it shows on a later frame.
                        context.state.update(cx, |state, cx| {
                            state.decrypted_picture(&server_id, &reference, cx);
                        });
                        tile = tile.child(div().absolute().inset_0().flex().items_center().justify_center().child(spinner(18., gpui::white())));
                    } else {
                        // Very large pictures wait to be asked for, with their size.
                        let state = context.state.clone();
                        tile = tile.cursor_pointer().on_click(move |_, _, cx| state.update(cx, |state, cx| {
                            state.decrypted_picture(&server_id, &reference, cx);
                        })).child(
                            div().absolute().inset_0().flex().flex_col().items_center().justify_center().gap(px(4.)).child(
                                div().size(px(40.)).rounded_full().flex().items_center().justify_center().bg(theme::color(theme::black_a(0.55))).child(icon("download", 18., gpui::white())),
                            ).child(div().px(px(6.)).rounded(px(4.)).bg(theme::color(theme::black_a(0.55))).text_size(px(11.)).text_color(gpui::white()).child(format_bytes(attachment.size))),
                        );
                    }
                }
            }
            grid = if fills { grid.child(div().relative().w_full().child(aspect_fill(w as f32, h as f32)).child(tile)) } else { grid.child(tile) };
        }
        column = column.child(grid);
    }
    for attachment in message.attachments.iter().filter(|a| !images.iter().any(|image| std::ptr::eq(*image, *a))) {
        if attachment.voice == Some(true) {
            column = column.child(super::media_views::voice(attachment, own && !context.is_channel, context, cx));
            continue;
        }
        if attachment.round == Some(true) && attachment.mime.starts_with("video/") {
            column = column.child(super::media_views::round(attachment, context, cx));
            continue;
        }
        if attachment.mime.starts_with("video/") {
            column = column.child(super::media_views::video(attachment, context, cx));
            continue;
        }
        if attachment.mime.starts_with("audio/") {
            column = column.child(super::media_views::audio(attachment, own && !context.is_channel, context, cx));
            continue;
        }
        let size_color = if own { theme.bubble_own_faint } else { theme.text2 };
        let label = if attachment.voice == Some(true) {
            "Voice message".to_string()
        } else if attachment.round == Some(true) {
            "Video message".to_string()
        } else {
            attachment.name.clone()
        };
        let state = context.state.clone();
        let server_id = context.server_id.clone();
        let reference = serde_json::json!({ "fileId": attachment.file_id, "key": attachment.key, "prefix": attachment.prefix, "chunks": attachment.chunks, "mime": attachment.mime });
        let name = attachment.name.clone();
        if context.is_channel {
            column = column.child(
                div()
                    .id(SharedString::from(format!("file-{}-{}", message.id, attachment.file_id)))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .w(px(432.))
                    .max_w_full()
                    .p(px(12.))
                    .rounded(px(8.))
                    .bg(theme.bg2)
                    .border_1()
                    .border_color(theme.line)
                    .cursor_pointer()
                    .hover(|style| style.border_color(theme.line_strong))
                    .on_click({
                        let (state, server_id, reference, name) = (state.clone(), server_id.clone(), reference.clone(), name.clone());
                        move |_, _, cx| save_attachment(state.clone(), server_id.clone(), reference.clone(), name.clone(), cx)
                    })
                    .child(div().size(px(40.)).flex_none().rounded(px(8.)).flex().items_center().justify_center().bg(theme.bg3).child(icon("file", 18., theme.text1)))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().one_line().text_size(px(15.)).text_color(theme.link).child(label.clone())).child(div().text_size(px(12.)).text_color(theme.text2).child(format_bytes(attachment.size))))
                    .child(icon("download", 15., theme.text2)),
            );
            continue;
        }
        column = column.child(
            div()
                .id(SharedString::from(format!("file-{}-{}", message.id, attachment.file_id)))
                .flex()
                .items_center()
                .gap(px(10.))
                .w(px(280.))
                .py(px(3.))
                .cursor_pointer()
                .on_click(move |_, _, cx| save_attachment(state.clone(), server_id.clone(), reference.clone(), name.clone(), cx))
                .child(div().size(px(38.)).flex_none().rounded_full().flex().items_center().justify_center().bg(theme::color(theme::white_a(0.09))).child(icon("file", 17., theme.text1)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().one_line().font_weight(FontWeight::MEDIUM).text_size(px(13.5)).line_height(px(18.)).child(label))
                        .child(div().text_size(px(12.)).line_height(px(16.)).text_color(size_color).child(format_bytes(attachment.size))),
                )
                .child(icon("download", 15., size_color).opacity(0.55)),
        );
    }
    column.into_any_element()
}

/// Decrypts a file and saves it where the person chooses.
pub fn save_attachment(state: Entity<AppState>, server_id: String, reference: serde_json::Value, name: String, cx: &mut App) {
    let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let chosen = cx.prompt_for_new_path(&downloads, Some(&name));
    state.update(cx, |_, cx| {
        cx.spawn(async move |state, cx| {
            let Ok(Ok(Some(path))) = chosen.await else { return };
            let Ok(call) = state.update(cx, |state, _| state.core.call(Some(&server_id), "downloadFile", vec![reference])) else { return };
            let result = call.await;
            state
                .update(cx, |state, cx| match result {
                    Ok(value) => match crate::host::save_value(&value, &path, false) {
                        Ok(()) => state.toast("Saved", ToastKind::Info, cx),
                        Err(error) => state.toast(format!("Couldn't save the file: {error}"), ToastKind::Error, cx),
                    },
                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                })
                .ok();
        })
        .detach();
    });
}

/// A tiny picture inside a message, as a data URL.
pub fn data_url_image(data: &str) -> Option<Arc<Image>> {
    use base64::Engine;
    let (header, encoded) = data.split_once(',')?;
    let mime = header.trim_start_matches("data:").split(';').next().unwrap_or("image/jpeg");
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    Some(Arc::new(Image::from_bytes(crate::state::image_format(mime, &bytes), bytes)))
}

fn link_card(preview: &crate::models::LinkPreview, own: bool, theme: &Theme, cx: &mut App) -> AnyElement {
    let host = url::Url::parse(&preview.url).ok().and_then(|url| url.host_str().map(|host| host.trim_start_matches("www.").to_string())).unwrap_or_default();
    let site = match &preview.site_name {
        Some(name) if name.to_lowercase() != host => format!("{host} · {name}"),
        _ => host,
    };
    let url = preview.url.clone();
    let mut text = div().flex_1().min_w_0().flex().flex_col().gap(px(1.)).child(
        div().one_line().text_size(px(12.5)).line_height(px(17.)).font_weight(FontWeight::SEMIBOLD).text_color(if own { theme.bubble_own_text } else { theme.text1 }).child(site),
    );
    if let Some(title) = &preview.title {
        text = text.child(div().text_size(px(13.)).line_height(px(18.)).font_weight(FontWeight::SEMIBOLD).child(clamped(title.clone(), 2)));
    }
    if let Some(description) = &preview.description {
        text = text.child(div().text_size(px(12.5)).line_height(px(17.)).text_color(if own { theme.bubble_own_faint } else { theme.text2 }).child(clamped(description.clone(), 3)));
    }
    let mut card = div()
        .id(SharedString::from(format!("link-{}", preview.url)))
        .flex()
        .gap(px(10.))
        .mt(px(5.))
        .mb(px(2.))
        .pl(px(8.))
        .pr(px(8.))
        .pt(px(5.))
        .pb(px(6.))
        .rounded(px(4.))
        .max_w(px(420.))
        .border_l_2()
        .border_color(if own { theme.bubble_own_faint } else { theme.text3 })
        .bg(if own { theme::color(theme::white_a(0.07)) } else { theme.hover })
        .cursor_pointer()
        .hover(move |style| style.bg(theme.hover_strong))
        .on_click(move |_, _, cx| cx.open_url(&url))
        .child(text);
    if let Some(image) = preview.image.as_ref().and_then(|image| data_url_image(&image.data)) {
        card = card.child(cover_image(image, 56., 56., RADIUS_S, cx));
    }
    card.into_any_element()
}

pub(super) fn menu_entries(message: &MessageView, own: bool, can_act: bool, context: &ChatContext) -> Vec<MenuEntry> {
    let mut entries = Vec::new();
    let state = context.state.clone();
    let list_id = context.list_id.clone();
    let group = message.group_id.clone();
    let id = message.id.clone();
    let is_deleted = message.deleted_at.is_some();
    if can_act {
        let (state, list_id, message) = (state.clone(), list_id.clone(), message.clone());
        entries.push(MenuEntry::new("Reply", "corner-up-left", move |_, cx| state.update(cx, |state, cx| state.set_reply(&list_id, Some(message.clone()), cx))));
        let (forward_state, server_id, forward_group, forward_id) = (context.state.clone(), context.server_id.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Forward", "forward", move |_, cx| {
            let overlay = Overlay::Forward { server_id: server_id.clone(), group_id: forward_group.clone(), ids: vec![forward_id.clone()] };
            forward_state.update(cx, |state, cx| state.set_overlay(Some(overlay), cx))
        }));
        let (select_state, select_list, select_id) = (context.state.clone(), context.list_id.clone(), id.clone());
        entries.push(MenuEntry::new("Select", "circle-check", move |_, cx| select_state.update(cx, |state, cx| state.toggle_selected(&select_list, Some(&select_id), cx))));
    }
    if !message.text.is_empty() && !is_deleted {
        // What's selected in it, if anything, as the web's "Copy selection".
        let selected = selection::text_in(&message.id);
        let label = if selected.is_some() { "Copy selection" } else { "Copy text" };
        let (state, text) = (state.clone(), selected.unwrap_or_else(|| message.text.clone()));
        entries.push(MenuEntry::new(label, "copy", move |_, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text.clone()));
            state.update(cx, |state, cx| state.toast("Copied", ToastKind::Info, cx));
        }));
    }
    if can_act && own && !message.text.is_empty() && message.forwarded.is_none() {
        let (state, list_id, message) = (state.clone(), list_id.clone(), message.clone());
        entries.push(MenuEntry::new("Edit", "pencil", move |_, cx| state.update(cx, |state, cx| state.set_editing(&list_id, Some(message.clone()), cx))));
    }
    if can_act {
        let pinned = message.pinned_at.is_some();
        let (state, group, id) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new(if pinned { "Unpin" } else { "Pin" }, if pinned { "pin-off" } else { "pin" }, move |_, cx| {
            state.update(cx, |state, cx| state.act("setPinned", vec![json!(group), json!(id), json!(!pinned)], cx))
        }));
    }
    // Who in a group has read your message, as far as their read receipts say.
    if let (true, true, true, Some(seq)) = (own, context.is_group, can_act, message.seq) {
        let mut readers: Vec<&UserView> = context
            .members
            .iter()
            .filter(|member| **member != context.self_id && context.read_by.get(*member).copied().unwrap_or(0.) >= seq)
            .filter_map(|member| context.users.get(member))
            .collect();
        readers.sort_by_key(|user| user.display_name.to_lowercase());
        if !readers.is_empty() {
            let people = readers
                .iter()
                .map(|user| {
                    let (state, key) = (state.clone(), format!("user:{}", user.id));
                    MenuEntry::new(user.display_name.clone(), "user", move |_, cx| state.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx)))
                        .with_avatar(user.display_name.clone(), user.id.clone(), context.avatars.get(&user.id).cloned())
                })
                .collect();
            entries.push(MenuEntry::submenu(format!("Read by {}", readers.len()), "check-check", people));
        }
    }
    if message.status == "failed" {
        let (retry_state, group_a, id_a) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Try again", "refresh-cw", move |_, cx| retry_state.update(cx, |state, cx| state.act("retryMessage", vec![json!(group_a), json!(id_a)], cx))));
        let (state, group, id) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Discard", "trash", move |_, cx| state.update(cx, |state, cx| state.act("discardMessage", vec![json!(group), json!(id)], cx))).danger());
    }
    if can_act && (own || (context.is_group && context.is_group_admin)) {
        entries.push(MenuEntry::separator());
        let (state, group, id) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Delete for everyone", "trash", move |_, cx| state.update(cx, |state, cx| state.act("deleteMessage", vec![json!(group), json!(id)], cx))).danger());
    }
    entries
}

/// A shared location: a pin, the coordinates and how far off they may be, opening a map.
pub(super) fn location_card(id: &str, location: &crate::models::SharedLocation, own: bool, channel: bool, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let url = crate::format::map_link(location.lat, location.lon);
    let bg = if channel { theme.bg2 } else if own { theme::color(theme::white_a(0.07)) } else { theme.hover };
    div()
        .id(SharedString::from(format!("location-{id}")))
        .flex()
        .items_center()
        .gap(px(10.))
        .my(px(2.))
        .when(channel, |el| el.mt(px(4.)).mb(px(0.)).border_1().border_color(theme.line))
        .pl(px(8.))
        .pr(px(12.))
        .py(px(8.))
        .min_w(px(220.))
        .rounded(RADIUS_M)
        .bg(bg)
        .cursor_pointer()
        .hover(move |style| style.bg(theme.hover_strong))
        .tooltip(tooltip("Open on OpenStreetMap"))
        .on_click(move |_, _, cx| cx.open_url(&url))
        .child(div().size(px(40.)).flex_none().rounded_full().bg(theme.accent).flex().items_center().justify_center().child(icon("map-pin", 20., theme.on_accent)))
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(1.))
                .text_size(px(13.))
                .child(div().font_weight(FontWeight::SEMIBOLD).child("Location"))
                .child(crate::format::coordinates_text(location.lat, location.lon))
                .when_some(location.accuracy, |el, meters| el.child(div().text_size(px(12.)).text_color(if own && !channel { theme.bubble_own_faint } else { theme.text2 }).child(crate::format::accuracy_text(meters)))),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use gpui::RenderImage;
    use image::{Delay, Frame, RgbaImage};
    use std::time::{Duration, Instant};

    fn animation(delays_ms: &[u32]) -> RenderImage {
        RenderImage::new(delays_ms.iter().map(|&ms| Frame::from_parts(RgbaImage::new(2, 2), 0, 0, Delay::from_numer_denom_ms(ms, 1))).collect::<Vec<_>>())
    }

    #[test]
    fn copies_of_an_animated_emote_show_the_frame_its_clock_is_at() {
        let emote = animation(&[40, 60, 100]);
        let start = Instant::now();
        // Its clock starts when it's first drawn, and every copy drawn later reads the same one.
        assert_eq!(emote.frame_at(start), (0, Some(start + Duration::from_millis(40))));
        let later = start + Duration::from_millis(50);
        assert_eq!(emote.frame_at(later), (1, Some(start + Duration::from_millis(100))));
        assert_eq!(emote.frame_at(later), emote.frame_at(later));
        // However late a redraw comes, it's the frame that's due, and it goes round.
        assert_eq!(emote.frame_at(start + Duration::from_millis(150)).0, 2);
        assert_eq!(emote.frame_at(start + Duration::from_millis(210)), (0, Some(start + Duration::from_millis(240))));
    }

    #[test]
    fn frames_of_10_ms_or_less_last_100_ms_as_in_browsers() {
        let emote = animation(&[0, 10, 20]);
        let start = Instant::now();
        assert_eq!(emote.frame_at(start).0, 0);
        assert_eq!(emote.frame_at(start + Duration::from_millis(99)).0, 0);
        assert_eq!(emote.frame_at(start + Duration::from_millis(150)).0, 1);
        assert_eq!(emote.frame_at(start + Duration::from_millis(205)).0, 2);
    }

    #[test]
    fn a_still_picture_has_one_frame_and_nothing_due() {
        assert_eq!(animation(&[50]).frame_at(Instant::now()), (0, None));
    }
}
