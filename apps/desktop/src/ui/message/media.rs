//! What a message carries: pictures and videos in their grid, files, link previews and places.

use super::*;

/// The corners of the pictures above a message, as `.media-grid`'s `border-radius: inherit`
/// takes the bubble's, or a channel's 8 px. GPUI clips to rectangles, so the pictures at the
/// grid's corners are rounded themselves.
pub(super) fn media_corners(is_channel: bool, only_images: bool, own: bool, grouped_top: bool, after_header: bool) -> gpui::Corners<Pixels> {
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
pub(super) fn tile_corners(grid: gpui::Corners<Pixels>, index: usize, count: usize) -> gpui::Corners<Pixels> {
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

/// A Telegram sticker alone: at most 160 px, as Telegram's apps show one, on nothing. It always
/// loads by itself, being small.
fn sticker(message: &MessageView, attachment: &Attachment, context: &ChatContext, cx: &mut App) -> AnyElement {
    let (width, height) = (attachment.width.unwrap_or(512.).max(1.), attachment.height.unwrap_or(512.).max(1.));
    let scale = (160. / width).min(160. / height);
    let image = context.images.get(&attachment.cache_id()).cloned();
    if image.is_some() {
        context.state.read(cx).touch_media(&format!("file:{}", attachment.cache_id()));
    } else if !attachment.file_id.is_empty() {
        let server_id = context.server_id.clone();
        let reference = crate::models::AvatarRef { file_id: attachment.file_id.clone(), key: attachment.key.clone(), prefix: attachment.prefix.clone(), chunks: attachment.chunks, mime: attachment.mime.clone() };
        context.state.update(cx, |state, cx| {
            state.decrypted_picture(&server_id, &reference, cx);
        });
    }
    div()
        .id(SharedString::from(format!("sticker-{}-{}", message.id, attachment.file_id)))
        .w(px((width * scale) as f32))
        .h(px((height * scale) as f32))
        .when_some(image, |el, image| el.child(img(image).size_full().object_fit(gpui::ObjectFit::Contain).enter_once(format!("sticker-in-{}-{}", message.id, attachment.file_id), Enter::Fade, 120)))
        .into_any_element()
}

pub(in crate::ui) fn attachments(message: &MessageView, images: &[&Attachment], only_images: bool, own: bool, grouped_top: bool, after_header: bool, context: &ChatContext, theme: &Theme, cx: &mut App) -> AnyElement {
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
            let image = context.images.get(&attachment.cache_id()).cloned();
            if image.is_some() {
                context.state.read(cx).touch_media(&format!("file:{}", attachment.cache_id()));
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
                let (full, opened) = (image.clone(), (*attachment).clone());
                let (state, server_id, group_id) = (context.state.clone(), context.server_id.clone(), message.group_id.clone());
                tile = tile.cursor_pointer().on_click(move |_, window, cx| {
                    // With the chat's other pictures loaded, which the viewer goes between.
                    let gallery = {
                        let state = state.read(cx);
                        let messages = state.lists.get(&group_id).map(|list| list.items.as_slice()).unwrap_or_default();
                        let blocked = state.servers.get(&server_id).map(|server| server.prefs.blocked().to_vec()).unwrap_or_default();
                        crate::ui::image_viewer::Gallery::among(&server_id, messages, &opened, full.clone(), &blocked)
                    };
                    crate::ui::image_viewer::open(gallery, window, cx);
                });
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
                    let asked = context.state.read(cx).pictures.contains_key(&format!("file:{}", attachment.cache_id()));
                    if crate::ui::shared_media::loads_by_itself(attachment) || asked {
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
            column = column.child(crate::ui::media_views::voice(attachment, own && !context.is_channel, context, cx));
            continue;
        }
        if attachment.round == Some(true) && attachment.mime.starts_with("video/") {
            column = column.child(crate::ui::media_views::round(attachment, context, cx));
            continue;
        }
        if attachment.sticker == Some(true) && attachment.mime.starts_with("image/") {
            column = column.child(sticker(message, attachment, context, cx));
            continue;
        }
        if attachment.mime.starts_with("video/") {
            column = column.child(crate::ui::media_views::video(attachment, context, cx));
            continue;
        }
        if attachment.mime.starts_with("audio/") {
            column = column.child(crate::ui::media_views::audio(attachment, own && !context.is_channel, context, cx));
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
                .update(cx, |state, cx| match result.map_err(|error| error.message).and_then(|value| crate::state::checked_download(&server_id, value)) {
                    Ok(value) => match crate::host::save_value(&value, &path, false) {
                        Ok(()) => state.toast("Saved", ToastKind::Info, cx),
                        Err(error) => state.toast(format!("Couldn't save the file: {error}"), ToastKind::Error, cx),
                    },
                    Err(error) => state.toast(error, ToastKind::Error, cx),
                })
                .ok();
        })
        .detach();
    });
}

thread_local! {
    /// Pictures from data URLs, by a hash of the URL: thumbnails and link previews are drawn with
    /// every frame of their row, and decoding one, then hashing its bytes into an image, each time
    /// came to more than the rest of the row.
    static DATA_URL_IMAGES: std::cell::RefCell<HashMap<u64, Option<Arc<Image>>>> = std::cell::RefCell::new(HashMap::new());
}

/// How many decoded data URLs are kept, all let go together once there are more.
pub(super) const DATA_URL_IMAGES_KEPT: usize = 512;

/// A tiny picture inside a message, as a data URL, decoded once.
pub fn data_url_image(data: &str) -> Option<Arc<Image>> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    let key = hasher.finish();
    if let Some(found) = DATA_URL_IMAGES.with(|images| images.borrow().get(&key).cloned()) {
        return found;
    }
    let image = decode_data_url(data);
    DATA_URL_IMAGES.with(|images| {
        let mut images = images.borrow_mut();
        if images.len() >= DATA_URL_IMAGES_KEPT {
            images.clear();
        }
        images.insert(key, image.clone());
    });
    image
}

pub(super) fn decode_data_url(data: &str) -> Option<Arc<Image>> {
    use base64::Engine;
    let (header, encoded) = data.split_once(',')?;
    let mime = header.trim_start_matches("data:").split(';').next().unwrap_or("image/jpeg");
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    Some(Arc::new(Image::from_bytes(crate::state::image_format(mime, &bytes), bytes)))
}

pub(super) fn link_card(preview: &crate::models::LinkPreview, own: bool, theme: &Theme, cx: &mut App) -> AnyElement {
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

/// A shared location: a pin, the coordinates and how far off they may be, opening a map.
pub(in crate::ui) fn location_card(id: &str, location: &crate::models::SharedLocation, own: bool, channel: bool, theme: &Theme) -> AnyElement {
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
