//! What's been shared in a chat, by kind, as Telegram's details list it
//! (packages/ui/src/features/chat/SharedMedia.tsx).

use std::sync::Arc;

use gpui::{AnyElement, App, Entity, FontWeight, Image, IntoElement, MouseButton, ParentElement, SharedString, Styled, div, img, prelude::*, px};

use super::components::*;
use super::menu::{MenuEntry, open_menu};
use crate::format::{avatar_color, format_bytes, format_duration, format_full, name_color};
use crate::markup::plain_text;
use crate::models::{Attachment, AvatarRef, ConversationView, MessageView};
use crate::state::{AppState, Overlay, Picture, ServerState, SharedKind};
use crate::theme::{self, RADIUS_M};

/// Pictures this large wait to be asked for, as on the desktop (`loadsByItself`).
const AUTO_LOAD_BYTES: f64 = (20 << 20) as f64;
const AUTO_LOAD_CHUNKS: f64 = 21.;

pub fn loads_by_itself(attachment: &Attachment) -> bool {
    attachment.size <= AUTO_LOAD_BYTES && attachment.chunks <= AUTO_LOAD_CHUNKS
}

/// Each kind in Telegram's order: its icon, how one and many are called, and its title.
pub const KINDS: [(SharedKind, &str, &str, &str, &str); 7] = [
    (SharedKind::Photo, "image", "photo", "photos", "Photos"),
    (SharedKind::Video, "video", "video", "videos", "Videos"),
    (SharedKind::File, "file", "file", "files", "Files"),
    (SharedKind::Audio, "headphones", "audio file", "audio files", "Audio files"),
    (SharedKind::Link, "link-2", "shared link", "shared links", "Shared links"),
    (SharedKind::Voice, "mic", "voice message", "voice messages", "Voice messages"),
    (SharedKind::Groups, "users", "group in common", "groups in common", "Groups in common"),
];

pub fn title(kind: SharedKind) -> &'static str {
    KINDS.iter().find(|entry| entry.0 == kind).map(|entry| entry.4).unwrap_or("")
}

/// The core's name for a kind, as `mediaCounts` and `loadMedia` use it.
pub fn core_name(kind: SharedKind) -> &'static str {
    match kind {
        SharedKind::Photo => "photo",
        SharedKind::Video => "video",
        SharedKind::File => "file",
        SharedKind::Audio => "audio",
        SharedKind::Link => "link",
        SharedKind::Voice => "voice",
        SharedKind::Groups => "groups",
    }
}

/// Which kind an attachment is (`attachmentKind` in the core).
pub fn attachment_kind(attachment: &Attachment) -> SharedKind {
    if attachment.mime.starts_with("image/") && attachment.width.is_some_and(|width| width > 0.) {
        SharedKind::Photo
    } else if attachment.voice == Some(true) {
        SharedKind::Voice
    } else if attachment.mime.starts_with("video/") {
        SharedKind::Video
    } else if attachment.mime.starts_with("audio/") {
        SharedKind::Audio
    } else {
        SharedKind::File
    }
}

/// The groups this person and this account are both in.
pub fn groups_in_common(server: &ServerState, peer_id: Option<&str>) -> Vec<ConversationView> {
    let Some(peer) = peer_id.filter(|peer| *peer != server.self_id()) else { return Vec::new() };
    server
        .conversations
        .iter()
        .filter(|item| item.kind == "group" && !item.removed && item.members.iter().any(|member| member.user_id == peer && member.not_on_roster != Some(true)))
        .cloned()
        .collect()
}

fn reference(attachment: &Attachment) -> AvatarRef {
    AvatarRef { file_id: attachment.file_id.clone(), key: attachment.key.clone(), prefix: attachment.prefix.clone(), chunks: attachment.chunks, mime: attachment.mime.clone() }
}

/// "Show in chat" on a right click, for anything listed.
fn show_in_chat(state: Entity<AppState>, message: &MessageView) -> impl Fn(&gpui::MouseDownEvent, &mut gpui::Window, &mut App) + 'static {
    let (group, id) = (message.group_id.clone(), message.id.clone());
    move |event, _, cx| {
        let (state, group, id) = (state.clone(), group.clone(), id.clone());
        let entry = MenuEntry::new("Show in chat", "message-square", move |_, cx| state.update(cx, |state, cx| state.jump_to_message(&group, &id, cx)));
        open_menu(event.position, vec![entry], false, cx);
    }
}

/// Who sent something, and when.
fn sent_by(message: &MessageView, server: &ServerState, cx: &App) -> AnyElement {
    let theme = theme(cx);
    let name = if message.sender_id == server.self_id() {
        "You".to_string()
    } else {
        server.users.get(&message.sender_id).map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into())
    };
    div()
        .flex()
        .min_w_0()
        .text_size(px(12.))
        .text_color(theme.text3)
        .child(div().flex_none().text_color(theme::css(name_color(&message.sender_id))).child(name))
        .child(div().min_w_0().one_line().child(format!(" · {}", format_full(message.created_at))))
        .into_any_element()
}

fn month_of(at_ms: f64) -> String {
    chrono::DateTime::from_timestamp_millis(at_ms as i64)
        .map(|time| time.with_timezone(&chrono::Local).format("%B %Y").to_string())
        .unwrap_or_default()
}

fn nothing(cx: &App) -> AnyElement {
    let theme = theme(cx);
    div().p(px(30.)).flex().justify_center().text_color(theme.text2).child("Nothing here anymore.").into_any_element()
}

/// One kind from a chat, newest first.
pub fn content(state: &Entity<AppState>, server: &ServerState, kind: SharedKind, messages: &[MessageView], has_more: bool, cx: &mut App) -> Vec<AnyElement> {
    let theme = theme(cx);
    if messages.is_empty() {
        return vec![nothing(cx)];
    }
    let mut parts = Vec::new();
    if matches!(kind, SharedKind::Photo | SharedKind::Video) {
        let tiles: Vec<(MessageView, Attachment)> = messages
            .iter()
            .flat_map(|message| message.attachments.iter().filter(|attachment| attachment_kind(attachment) == kind).map(move |attachment| (message.clone(), attachment.clone())))
            .collect();
        let mut grid = div().flex().flex_col().gap(px(2.)).rounded(RADIUS_M).overflow_hidden();
        for row in tiles.chunks(3) {
            let mut line = div().flex().gap(px(2.));
            for (message, attachment) in row {
                line = line.child(tile(state, server, message, attachment, kind == SharedKind::Video, cx));
            }
            for _ in row.len()..3 {
                line = line.child(div().flex_1());
            }
            grid = grid.child(line);
        }
        parts.push(grid.into_any_element());
    } else {
        let mut list = div().flex().flex_col().gap(px(1.));
        for (index, message) in messages.iter().enumerate() {
            let month = month_of(message.created_at);
            if index == 0 || month_of(messages[index - 1].created_at) != month {
                list = list.child(div().px(px(8.)).pt(px(if index == 0 { 2. } else { 10. })).pb(px(4.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).child(month));
            }
            if kind == SharedKind::Link {
                list = list.child(link_row(state, server, message, cx));
            } else {
                for attachment in message.attachments.iter().filter(|attachment| attachment_kind(attachment) == kind) {
                    list = list.child(attachment_row(state, server, message, attachment, cx));
                }
            }
        }
        parts.push(list.into_any_element());
    }
    if has_more {
        parts.push(div().py(px(10.)).flex().justify_center().child(spinner(16., theme.text2)).into_any_element());
    }
    parts
}

/// A photo or a video, as a square. A photo opens in the viewer, loading first if it's
/// one too big to load by itself; a video shows where it was sent.
fn tile(state: &Entity<AppState>, server: &ServerState, message: &MessageView, attachment: &Attachment, video: bool, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = format!("file:{}", attachment.file_id);
    let wanted = loads_by_itself(attachment) || state.read(cx).pictures.contains_key(&key);
    let picture: Option<Arc<Image>> = if video || !wanted {
        None
    } else {
        let server_id = server.entry.id.clone();
        let reference = reference(attachment);
        state.update(cx, |state, cx| state.decrypted_picture(&server_id, &reference, cx))
    };
    let thumb = attachment.thumb.as_ref().and_then(|thumb| super::message::data_url_image(thumb));
    let (group, id) = (message.group_id.clone(), message.id.clone());
    let (file_id, name) = (attachment.file_id.clone(), attachment.name.clone());
    let click_state = state.clone();
    let server_id = server.entry.id.clone();
    let load = reference(attachment);
    let ready = picture.is_some();
    div()
        .id(SharedString::from(format!("shared-{}-{}", message.id, attachment.file_id)))
        .relative()
        .flex_1()
        .h(px(96.))
        .overflow_hidden()
        .bg(theme.bg3)
        .cursor_pointer()
        .tooltip(tooltip(format_full(message.created_at)))
        .on_click(move |_, _, cx| {
            click_state.update(cx, |state, cx| {
                if video {
                    state.jump_to_message(&group, &id, cx);
                } else if ready {
                    state.set_overlay(Some(Overlay::Image { file_id: file_id.clone(), name: name.clone() }), cx);
                } else {
                    state.decrypted_picture(&server_id, &load, cx);
                }
            })
        })
        .on_mouse_down(MouseButton::Right, show_in_chat(state.clone(), message))
        .when_some(thumb, |el, thumb| el.child(img(thumb).absolute().inset_0().size_full().object_fit(gpui::ObjectFit::Cover)))
        .when_some(picture, |el, picture| el.child(img(picture).absolute().inset_0().size_full().object_fit(gpui::ObjectFit::Cover)))
        .when(video || !wanted, |el| {
            el.child(
                div().absolute().inset_0().flex().items_center().justify_center().child(
                    div()
                        .size(px(32.))
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(theme::color(theme::black_a(0.55)))
                        .child(icon(if video { "play" } else { "download" }, if video { 16. } else { 15. }, gpui::white())),
                ),
            )
        })
        .when(video && attachment.duration.is_some_and(|duration| duration > 0.), |el| {
            el.child(
                div()
                    .absolute()
                    .left(px(4.))
                    .bottom(px(4.))
                    .px(px(5.))
                    .rounded(px(4.))
                    .bg(theme::color(theme::black_a(0.55)))
                    .text_size(px(11.))
                    .text_color(gpui::white())
                    .child(format_duration(attachment.duration.unwrap_or(0.))),
            )
        })
        .hover(|style| style.opacity(0.92))
        .into_any_element()
}

/// A file, a sound file or a voice message, and who sent it.
fn attachment_row(state: &Entity<AppState>, server: &ServerState, message: &MessageView, attachment: &Attachment, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let label = if attachment.voice == Some(true) { "Voice message".to_string() } else { attachment.name.clone() };
    let detail = match attachment.duration {
        Some(duration) if attachment.voice == Some(true) || attachment.mime.starts_with("audio/") => format!("{} · {}", format_duration(duration), format_bytes(attachment.size)),
        _ => format_bytes(attachment.size),
    };
    let icon_name = if attachment.voice == Some(true) {
        "mic"
    } else if attachment.mime.starts_with("audio/") {
        "headphones"
    } else {
        "file"
    };
    let save_state = state.clone();
    let server_id = server.entry.id.clone();
    let file = serde_json::json!({ "fileId": attachment.file_id, "key": attachment.key, "prefix": attachment.prefix, "chunks": attachment.chunks, "mime": attachment.mime });
    let name = attachment.name.clone();
    div()
        .id(SharedString::from(format!("shared-row-{}-{}", message.id, attachment.file_id)))
        .flex()
        .flex_col()
        .gap(px(3.))
        .px(px(8.))
        .py(px(6.))
        .rounded(RADIUS_M)
        .cursor_pointer()
        .hover(move |style| style.bg(theme.hover))
        .on_click(move |_, _, cx| super::message::save_attachment(save_state.clone(), server_id.clone(), file.clone(), name.clone(), cx))
        .on_mouse_down(MouseButton::Right, show_in_chat(state.clone(), message))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(div().size(px(38.)).flex_none().rounded_full().flex().items_center().justify_center().bg(theme.bg3).child(icon(icon_name, 17., theme.text1)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().one_line().font_weight(FontWeight::MEDIUM).text_size(px(13.5)).child(label))
                        .child(div().text_size(px(12.)).text_color(theme.text2).child(detail)),
                )
                .child(icon("download", 15., theme.text3)),
        )
        .child(sent_by(message, server, cx))
        .into_any_element()
}

/// A message's links, under its preview if it has one. What the preview says is the
/// sender's claim, so each link shows where it really goes, as in the chat.
fn link_row(state: &Entity<AppState>, server: &ServerState, message: &MessageView, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let links = crate::markup::shared_links(&message.text);
    let preview = message.preview.as_ref().filter(|preview| links.contains(&preview.url));
    let host = links.first().and_then(|link| url::Url::parse(link).ok()).and_then(|url| url.host_str().map(|host| host.trim_start_matches("www.").to_string())).unwrap_or_default();
    let text = plain_text(&message.text);
    let description = preview
        .and_then(|preview| preview.description.clone())
        .unwrap_or_else(|| links.iter().fold(text.clone(), |rest, link| rest.replace(link.as_str(), "")).split_whitespace().collect::<Vec<_>>().join(" "));
    let picture = preview.and_then(|preview| preview.image.as_ref()).and_then(|image| super::message::data_url_image(&image.data));
    let mark: AnyElement = match picture {
        Some(picture) => cover_image(picture, 44., 44., RADIUS_M).into_any_element(),
        None => div()
            .size(px(44.))
            .flex_none()
            .rounded(RADIUS_M)
            .flex()
            .items_center()
            .justify_center()
            .bg(theme::css(avatar_color(&host)))
            .text_size(px(18.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(gpui::white())
            .child(host.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| "?".into()))
            .into_any_element(),
    };
    let title = preview.and_then(|preview| preview.title.clone()).unwrap_or_else(|| host.clone());
    let mut body = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(1.))
        .child(div().one_line().text_size(px(13.5)).font_weight(FontWeight::SEMIBOLD).child(title));
    if !description.is_empty() {
        body = body.child(div().text_size(px(12.5)).text_color(theme.text2).line_clamp(3).child(description));
    }
    for (index, link) in links.iter().enumerate() {
        let url = link.clone();
        body = body.child(
            div()
                .id(SharedString::from(format!("shared-link-{}-{index}", message.id)))
                .one_line()
                .text_size(px(12.5))
                .text_color(theme.link)
                .cursor_pointer()
                .hover(|style| style.underline())
                .tooltip(tooltip(link.clone()))
                .on_click(move |_, _, cx| cx.open_url(&url))
                .child(link.clone()),
        );
    }
    body = body.child(sent_by(message, server, cx));
    div()
        .id(SharedString::from(format!("shared-link-row-{}", message.id)))
        .flex()
        .items_start()
        .gap(px(10.))
        .px(px(8.))
        .py(px(6.))
        .rounded(RADIUS_M)
        .hover(move |style| style.bg(theme.hover))
        .on_mouse_down(MouseButton::Right, show_in_chat(state.clone(), message))
        .child(mark)
        .child(body)
        .into_any_element()
}

/// The groups both of you are in, each opening on a click.
pub fn groups(state: &Entity<AppState>, server: &ServerState, peer_id: Option<&str>, cx: &mut App) -> Vec<AnyElement> {
    let theme = theme(cx);
    let found = groups_in_common(server, peer_id);
    if found.is_empty() {
        return vec![nothing(cx)];
    }
    let mut list = div().flex().flex_col().gap(px(1.));
    for group in found {
        let image = group.avatar.as_ref().and_then(|avatar| match state.read(cx).pictures.get(&format!("file:{}", avatar.file_id)) {
            Some(Picture::Ready(image)) => Some(image.clone()),
            _ => None,
        });
        let (open_state, key) = (state.clone(), group.key.clone());
        list = list.child(
            div()
                .id(SharedString::from(format!("common-{}", group.key)))
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(8.))
                .py(px(5.))
                .rounded(RADIUS_M)
                .text_size(px(13.5))
                .cursor_pointer()
                .hover(move |style| style.bg(theme.hover))
                .on_click(move |_, _, cx| open_state.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx)))
                .child(avatar(AvatarProps { name: group.title.clone(), seed: group.group_id.clone().unwrap_or_default(), image, size: 36., online: false, rounded: false, dot_border: theme.bg1 }, cx))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().one_line().font_weight(FontWeight::SEMIBOLD).child(group.title.clone()))
                        .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("{} {}", group.members.len(), if group.members.len() == 1 { "member" } else { "members" }))),
                ),
        );
    }
    vec![list.into_any_element()]
}
