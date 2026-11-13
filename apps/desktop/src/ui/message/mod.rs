//! One message in a chat, as a bubble (packages/ui/src/features/chat/MessageItem.tsx).

mod actions;
mod media;
mod text;

pub use media::{data_url_image, save_attachment};
pub(super) use actions::menu_entries;
pub(super) use media::{attachments, location_card};
pub(super) use text::{jumbo_body, mentionable_print, text_body, with_emote_card};
use actions::reaction_chip;
use media::link_card;
use text::meta_element;

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
    /// The link under the pointer, as the id of the text it's in and its place among that
    /// text's targets, underlined as `a:hover` underlines it.
    pub hovered_link: Rc<std::cell::RefCell<Option<(SharedString, usize)>>>,
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
    /// Each message's text, parsed, kept by the chat across the contexts it builds, with what
    /// it was parsed from (`parse_key`), so a message is parsed again only when that changed.
    pub parsed: Rc<std::cell::RefCell<HashMap<String, (u64, Rc<Vec<Block>>)>>>,
    /// Who can be mentioned, reduced to a number, as parsing a message depends on it.
    pub mentionable_print: u64,
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

/// Whether `b` carries on `a`'s run: the same person, within five minutes, on the same day. A message
/// that hasn't opened yet has no known author, so it's nobody's run, and nothing carries on from it.
pub fn continues(a: Option<&MessageView>, b: Option<&MessageView>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            a.system.is_none()
                && b.system.is_none()
                && !a.sender_id.is_empty()
                && a.sender_id == b.sender_id
                && b.created_at - a.created_at < GROUP_WINDOW_MS
                && crate::format::same_day(a.created_at, b.created_at)
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
    // The line that says a bot was added names it as one.
    let named = |id: &String| if system.kind == "member_added" && context.users.get(id).is_some_and(|user| user.bot.is_some()) { format!("the bot {}", name_of(context, id)) } else { name_of(context, id) };
    let targets = system.target_ids.clone().unwrap_or_default().iter().map(named).collect::<Vec<_>>().join(", ");
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

/// The rows of buttons under a bot's message (`MessageButtons.tsx`). One with a link opens it, as
/// a link in a message does. One with data sends that back to the bot: a press goes to the whole
/// chat, as a chat's messages do, and nobody's app shows it.
pub(super) fn message_buttons(message: &MessageView, context: &ChatContext, theme: &Theme) -> Option<gpui::Div> {
    if message.buttons.is_empty() || message.deleted_at.is_some() {
        return None;
    }
    let (bg, hover) = (theme.bg3, theme.bg4);
    let mut rows = div().flex().flex_col().gap(px(3.)).mt(px(4.)).min_w(px(180.)).max_w(px(420.));
    for (row_index, row) in message.buttons.iter().enumerate() {
        let mut line = div().flex().gap(px(3.));
        for (column, button) in row.iter().enumerate() {
            let mut cell = named_div(SharedString::from(format!("msg-button-{}-{row_index}-{column}", message.id)))
                .flex_1()
                .min_w_0()
                .h(px(32.))
                .px(px(10.))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(4.))
                .rounded(RADIUS_S)
                .bg(bg)
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text1)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .child(div().min_w_0().one_line().child(button.text.clone()));
            if let Some(url) = button.url.clone() {
                cell = cell.child(icon("arrow-up-right", 12., theme.text3)).on_click(move |_, _, cx| cx.open_url(&url));
            } else if message.status == "sent" {
                let state = context.state.clone();
                let (group_id, message_id) = (message.group_id.clone(), message.id.clone());
                let telegram = context.server_id == crate::telegram::SERVER_ID;
                cell = cell.on_click(move |_, _, cx| {
                    state.update(cx, |state, cx| {
                        // A Telegram bot may answer the press with words, which are shown.
                        if telegram {
                            state.press_telegram_button(group_id.clone(), message_id.clone(), row_index, column, cx);
                        } else {
                            state.act("pressButton", vec![json!(group_id), json!(message_id), json!(row_index), json!(column)], cx);
                        }
                    })
                });
            }
            line = line.child(cell);
        }
        rows = rows.child(line);
    }
    Some(rows)
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

/// A message as plugins decorated it here: its text replaced or hidden, under the app's own line
/// saying which plugin did it, and their marks and views under it. What's stored stays as it was.
fn render_message(message: &MessageView, grouped: bool, last_in_group: bool, context: &ChatContext, window: &mut Window, cx: &mut App) -> AnyElement {
    let decorations = if message.system.is_none() { crate::ui::plugins::decorations(&context.server_id, message, cx) } else { Vec::new() };
    if decorations.is_empty() {
        return render_message_as(message, grouped, last_in_group, context, window, cx);
    }
    let original = crate::ui::plugins::showing_original(&context.server_id, message, cx);
    let changer = decorations.iter().find(|decoration| decoration.text.is_some() || decoration.hidden).cloned();
    let own = message.sender_id == context.self_id;
    let body = match &changer {
        Some(decoration) if !original && decoration.hidden => None,
        Some(decoration) if !original => {
            let mut shown = message.clone();
            shown.text = decoration.text.clone().unwrap_or_default();
            Some(render_message_as(&shown, grouped, last_in_group, context, window, cx))
        }
        _ => Some(render_message_as(message, grouped, last_in_group, context, window, cx)),
    };
    let indent = if !own && context.is_group { px(43.) } else { px(0.) };
    let mut column = div().flex().flex_col().when(own, |el| el.items_end()).children(body);
    if let Some(decoration) = &changer {
        column = column.child(div().pl(indent).child(crate::ui::plugins::changed_line(&context.server_id, message, decoration, cx)));
    }
    if let Some(extras) = crate::ui::plugins::extras(&decorations, cx) {
        column = column.child(div().pl(indent).max_w(px(600.)).child(extras));
    }
    column.into_any_element()
}

fn render_message_as(message: &MessageView, grouped: bool, last_in_group: bool, context: &ChatContext, window: &mut Window, cx: &mut App) -> AnyElement {
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
        // Named by what it says, which tests look for.
        let text = system_text(message, context);
        return named(div(), &ElementId::Name(format!("system: {text}").into()))
            .flex()
            .justify_center()
            .py(px(5.))
            .rounded(RADIUS_M)
            .when(highlighted, |el| el.bg(theme.hover_strong))
            .child(pill.child(div().text_center().child(text)))
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
    // A sticker alone goes without a bubble too, at its own size, not in a picture's grid.
    let only_sticker = message.text.is_empty() && message.attachments.len() == 1 && message.attachments[0].sticker == Some(true) && message.reply.is_none() && message.forwarded.is_none() && !placeholder;
    let images: Vec<&Attachment> = message.attachments.iter().filter(|a| a.mime.starts_with("image/") && a.width.is_some() && !only_sticker).collect();
    let only_images = message.text.is_empty() && !images.is_empty() && images.len() == message.attachments.len() && !has_reactions;
    // A video message alone is a circle, without a bubble, as large emoji are.
    let only_round = message.text.is_empty() && message.attachments.len() == 1 && message.attachments[0].round == Some(true) && message.reply.is_none() && message.forwarded.is_none() && !placeholder;
    let bare = jumbo > 0 || only_round || only_sticker;

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

    // Whoever wrote one that hasn't opened isn't known yet, so it's shown under no name.
    if !own && context.is_group && !grouped && !bare && !message.sender_id.is_empty() {
        let name = context.users.get(&message.sender_id).map(|u| u.display_name.clone()).unwrap_or_else(|| "Unknown".into());
        let is_bot = context.users.get(&message.sender_id).is_some_and(|user| user.bot.is_some());
        bubble = bubble.child(div().flex().items_center().gap(px(5.)).text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).mb(px(1.)).line_height(px(18.)).text_color(theme::css(name_color(&message.sender_id))).child(name).when(is_bot, |el| el.child(bot_badge(cx))));
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
            bubble = bubble.child(div().flex().justify_end().mt(px(if only_round || only_sticker { 3. } else { 1. })).child(meta));
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
    if !placeholder {
        stack = stack.children(message_buttons(message, context, &theme));
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

    let mut entries = menu_entries(message, own, can_act, context);
    if can_act {
        entries.extend(crate::ui::plugins::message_entries(&context.server_id, message, cx));
    }
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
        if last_in_group && !message.sender_id.is_empty() {
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
        let plugin_actions = crate::ui::plugins::hover_actions(&context.server_id, message, cx);
        row = row.child(
            div()
                .flex()
                .flex_none()
                .self_center()
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .when(own, |el| el.flex_row_reverse())
                .children(plugin_actions)
                .child(icon_button_in(SharedString::from(format!("react-{id}")), "face-slightly-smiling-plus", 15., true, false, theme.text3, cx).tip("React", Side::Top).on_click(move |event, window, cx| {
                    let state = picker_state.clone();
                    let (group, id) = (picker_group.clone(), picker_id.clone());
                    super::picker::open_picker(
                        event.position(),
                        false,
                        move |pick, _, cx| {
                            let args = match pick {
                                super::picker::Pick::Sticker(_) => return,
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
