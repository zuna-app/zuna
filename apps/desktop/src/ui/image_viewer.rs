//! A picture from a chat, in a window of its own over the whole screen, as Telegram's media
//! viewer opens: what's behind dimmed through it, and the picture fitted to the screen. It
//! zooms as `ImageViewer` in packages/ui/src/features/overlays/Overlays.tsx does, and goes
//! between the chat's pictures as that does.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, Context, Image, IntoElement, ParentElement, Pixels, Render, Styled, TitlebarOptions, Window, WindowBackgroundAppearance, WindowBounds, WindowHandle,
    WindowKind, WindowOptions, div, point, prelude::*, px, size,
};

use super::components::*;
use super::motion::{Enter, Motion};
use crate::models::{Attachment, AvatarRef, MessageView};
use crate::platform;
use crate::state::{AppState, Picture, Store};
use crate::theme::{self, RADIUS_L, RADIUS_M};

/// A picture the viewer can go to: what it's decrypted from, its name, and whether it's small
/// enough to be fetched before it's shown, as the ones either side of the one on show are.
#[derive(Clone)]
pub struct Item {
    reference: AvatarRef,
    name: String,
    small: bool,
}

impl Item {
    pub fn of(attachment: &Attachment) -> Self {
        Item {
            reference: AvatarRef { file_id: attachment.file_id.clone(), key: attachment.key.clone(), prefix: attachment.prefix.clone(), chunks: attachment.chunks, mime: attachment.mime.clone() },
            name: attachment.name.clone(),
            small: super::shared_media::loads_by_itself(attachment),
        }
    }

    pub fn file_id(&self) -> &str {
        &self.reference.file_id
    }
}

/// Whether an attachment is a picture the viewer shows.
pub fn is_picture(attachment: &Attachment) -> bool {
    attachment.mime.starts_with("image/") && attachment.width.is_some() && !attachment.file_id.is_empty()
}

/// The pictures the viewer goes between, oldest first, as Telegram's does, and the one it
/// opens on, already decrypted.
pub struct Gallery {
    server_id: String,
    items: Vec<Item>,
    index: usize,
    image: Arc<Image>,
}

impl Gallery {
    pub fn new(server_id: &str, items: Vec<Item>, index: usize, image: Arc<Image>) -> Self {
        let index = index.min(items.len().saturating_sub(1));
        Gallery { server_id: server_id.to_string(), items, index, image }
    }

    /// The pictures among `messages`, in their order, opening on `attachment`'s, which is
    /// `image`. Someone blocked's are left out, as their messages are hidden.
    pub fn among(server_id: &str, messages: &[MessageView], attachment: &Attachment, image: Arc<Image>, blocked: &[String]) -> Self {
        let mut items = Vec::new();
        let mut index = None;
        for message in messages.iter().filter(|message| message.deleted_at.is_none() && !blocked.contains(&message.sender_id)) {
            for picture in message.attachments.iter().filter(|picture| is_picture(picture)) {
                if picture.file_id == attachment.file_id {
                    index = Some(items.len());
                }
                items.push(Item::of(picture));
            }
        }
        match index {
            Some(index) => Gallery::new(server_id, items, index, image),
            // One that isn't among them opens alone.
            None => Gallery::new(server_id, vec![Item::of(attachment)], 0, image),
        }
    }
}

/// The viewer's window while it's open, so another picture is shown in it rather than in a second one.
struct Open(WindowHandle<ImageViewer>);

impl gpui::Global for Open {}

/// Shows a gallery in the viewer: in its window if it's open, or in a new one over the whole
/// screen `window` is on.
pub fn open(gallery: Gallery, window: &Window, cx: &mut App) {
    let display = window.display(cx);
    let display_id = display.as_ref().map(|display| display.id());
    let bounds = match &display {
        Some(display) => display.bounds(),
        None => Bounds::centered(None, size(px(1280.), px(832.)), cx),
    };
    // Right after the click: a new window is drawn at once, which can't be done in the middle
    // of the one it came from being updated.
    cx.spawn(async move |cx| {
        cx.update(|cx| {
            let mut gallery = Some(gallery);
            if let Some(Open(handle)) = cx.try_global::<Open>() {
                let handle = *handle;
                let shown = handle.update(cx, |viewer, window, cx| {
                    if let Some(gallery) = gallery.take() {
                        viewer.show_gallery(gallery, cx);
                    }
                    window.activate_window();
                });
                if shown.is_ok() {
                    return;
                }
            }
            let Some(gallery) = gallery else { return };
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Fullscreen(bounds)),
                // Hidden, as the main window's, so Windows draws no frame around it.
                titlebar: Some(TitlebarOptions { title: Some("Zuna".into()), appears_transparent: true, traffic_light_position: Some(point(px(12.), px(10.))) }),
                focus: true,
                show: true,
                kind: WindowKind::Normal,
                display_id,
                // What's behind shows through the shade, as Telegram's does.
                window_background: WindowBackgroundAppearance::Transparent,
                app_id: Some(platform::APP_ID.into()),
                // Full screen has no title bar, and the compositor's shouldn't come for a moment first.
                #[cfg(target_os = "linux")]
                window_decorations: Some(gpui::WindowDecorations::Client),
                ..Default::default()
            };
            let opened = cx.open_window(options, |window, cx| {
                // The picture's name stays out of the title, which other apps and the taskbar can read.
                #[cfg(target_os = "linux")]
                window.set_window_title("Zuna");
                cx.new(|cx| ImageViewer::new(gallery, window, cx))
            });
            if let Ok(handle) = opened {
                cx.set_global(Open(handle));
            }
        })
    })
    .detach();
}

/// How far a picture can be zoomed, from fitted to the screen.
const MAX_ZOOM: f32 = 8.;
/// How long a step of zooming glides, as `transform 0.12s` does.
const GLIDE: Duration = Duration::from_millis(120);

/// How the picture is shown: its scale from fitted, and where its center is from the
/// middle of the screen.
#[derive(Clone, Copy, PartialEq)]
struct View {
    scale: f32,
    x: f32,
    y: f32,
}

const FITTED: View = View { scale: 1., x: 0., y: 0. };

/// A picture, fitted to the screen, as the web's ImageViewer shows it in its window. It
/// zooms with the mouse wheel, a pinch, a double click, the keys or the buttons, towards
/// where the pointer is, and once it's bigger than the screen it can be dragged around. The
/// arrows and the arrow keys go to the pictures either side. A click outside it or Escape
/// closes it, and it can be saved.
pub struct ImageViewer {
    /// The picture on show, once it's decrypted.
    image: Option<Arc<Image>>,
    /// It couldn't be decrypted.
    failed: bool,
    server_id: String,
    items: Vec<Item>,
    index: usize,
    focus: gpui::FocusHandle,
    /// Where it's going.
    view: View,
    /// Where a glide towards `view` started, and when.
    glide: Option<(View, Instant)>,
    /// Where a drag started: the pointer, and the view then.
    drag: Option<(gpui::Point<Pixels>, View)>,
    /// The picture's own size, by its id.
    natural: Option<(u64, f32, f32)>,
    viewport: gpui::Size<Pixels>,
    _watch: Option<gpui::Subscription>,
}

impl ImageViewer {
    fn new(gallery: Gallery, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        // A picture gone to that's still being decrypted shows once it is.
        let watch = cx.try_global::<Store>().map(|store| store.0.clone()).map(|state| cx.observe(&state, |viewer, state, cx| viewer.picture_came(&state, cx)));
        let mut viewer = ImageViewer {
            image: None,
            failed: false,
            server_id: String::new(),
            items: Vec::new(),
            index: 0,
            focus,
            view: FITTED,
            glide: None,
            drag: None,
            natural: None,
            viewport: window.viewport_size(),
            _watch: watch,
        };
        viewer.show_gallery(gallery, cx);
        viewer
    }

    /// Another gallery in its place, fitted again.
    fn show_gallery(&mut self, gallery: Gallery, cx: &mut Context<Self>) {
        self.server_id = gallery.server_id;
        self.items = gallery.items;
        self.index = gallery.index;
        self.reset();
        self.image = Some(gallery.image);
        self.fetch_near(cx);
        cx.notify();
    }

    fn reset(&mut self) {
        self.image = None;
        self.failed = false;
        self.view = FITTED;
        self.glide = None;
        self.drag = None;
        self.natural = None;
    }

    /// The picture before or after, fitted.
    fn go(&mut self, step: isize, cx: &mut Context<Self>) {
        let next = (self.index as isize + step).clamp(0, self.items.len() as isize - 1) as usize;
        if next == self.index {
            return;
        }
        self.index = next;
        self.reset();
        self.image = self.fetch(next, cx);
        if self.image.is_none() {
            if let Some(state) = cx.try_global::<Store>().map(|store| store.0.clone()) {
                self.picture_came(&state, cx);
            }
        }
        self.fetch_near(cx);
        cx.notify();
    }

    /// A picture from the app's, decrypting it if it isn't there yet.
    fn fetch(&self, index: usize, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        let state = cx.try_global::<Store>()?.0.clone();
        let (server_id, reference) = (self.server_id.clone(), self.items.get(index)?.reference.clone());
        state.update(cx, |state, cx| state.decrypted_picture(&server_id, &reference, cx))
    }

    /// The ones either side, so going to one shows it at once.
    fn fetch_near(&self, cx: &mut Context<Self>) {
        for near in [self.index.wrapping_sub(1), self.index + 1] {
            if self.items.get(near).is_some_and(|item| item.small) {
                self.fetch(near, cx);
            }
        }
    }

    fn picture_came(&mut self, state: &gpui::Entity<AppState>, cx: &mut Context<Self>) {
        if self.image.is_some() || self.failed {
            return;
        }
        let Some(item) = self.items.get(self.index) else { return };
        match state.read(cx).pictures.get(&format!("file:{}", item.reference.file_id)) {
            Some(Picture::Ready(image)) => self.image = Some(image.clone()),
            Some(Picture::Failed(_)) => self.failed = true,
            _ => return,
        }
        cx.notify();
    }

    fn close(&mut self, window: &mut Window) {
        window.remove_window();
    }

    /// Its size fitted to the screen less 40 px around, never larger than its own.
    fn fitted(&self) -> (f32, f32) {
        let Some((_, width, height)) = self.natural else { return (0., 0.) };
        let (room_width, room_height) = (f32::from(self.viewport.width) - 80., f32::from(self.viewport.height) - 80.);
        let fit = (room_width / width).min(room_height / height).min(1.).max(0.);
        (width * fit, height * fit)
    }

    /// Where it is now, partway through a glide.
    fn current(&self) -> View {
        let Some((from, started)) = self.glide else { return self.view };
        let t = (started.elapsed().as_secs_f32() / GLIDE.as_secs_f32()).min(1.);
        // Close to the web's ease-out, cubic-bezier(0.2, 0, 0, 1).
        let eased = 1. - (1. - t).powi(3);
        let between = |a: f32, b: f32| a + (b - a) * eased;
        View { scale: between(from.scale, self.view.scale), x: between(from.x, self.view.x), y: between(from.y, self.view.y) }
    }

    /// Moves to a view, kept from going further than its edges reach past the screen.
    fn show(&mut self, next: View, glide: bool, cx: &mut Context<Self>) {
        let scale = next.scale.clamp(1., MAX_ZOOM);
        let mut limited = FITTED;
        if scale > 1. {
            let (width, height) = self.fitted();
            let spare_x = ((width * scale - f32::from(self.viewport.width)) / 2.).max(0.);
            let spare_y = ((height * scale - f32::from(self.viewport.height)) / 2.).max(0.);
            limited = View { scale, x: next.x.clamp(-spare_x, spare_x), y: next.y.clamp(-spare_y, spare_y) };
        }
        self.glide = if glide { Some((self.current(), Instant::now())) } else { None };
        self.view = limited;
        cx.notify();
    }

    /// Zooms, keeping the point under the pointer, or the middle, where it is.
    fn zoom_to(&mut self, scale: f32, at: Option<gpui::Point<Pixels>>, glide: bool, cx: &mut Context<Self>) {
        let current = self.view;
        let target = scale.clamp(1., MAX_ZOOM);
        let (point_x, point_y) = match at {
            Some(at) => (f32::from(at.x) - f32::from(self.viewport.width) / 2., f32::from(at.y) - f32::from(self.viewport.height) / 2.),
            None => (0., 0.),
        };
        let ratio = target / current.scale;
        self.show(View { scale: target, x: point_x - (point_x - current.x) * ratio, y: point_y - (point_y - current.y) * ratio }, glide, cx);
    }

    /// A double click shows the picture at its own size, or twice as big if it already fits.
    fn closer_scale(&self) -> f32 {
        let (width, _) = self.fitted();
        match self.natural {
            Some((_, natural, _)) if width > 0. => (natural / width).min(MAX_ZOOM).max(2.),
            _ => 2.,
        }
    }

    fn save(&self, cx: &mut App) {
        let (Some(image), Some(item)) = (&self.image, self.items.get(self.index)) else { return };
        let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
        let chosen = cx.prompt_for_new_path(&downloads, Some(&item.name));
        let bytes = image.bytes().to_vec();
        cx.spawn(async move |_| {
            if let Ok(Ok(Some(path))) = chosen.await {
                std::fs::write(path, bytes).ok();
            }
        })
        .detach();
    }

    fn on_wheel(&mut self, event: &gpui::ScrollEvent, cx: &mut Context<Self>) {
        // Windows gives lines: a mouse wheel's notch is a whole number of them, a touchpad's
        // scrolling a fraction, which pans instead. A line is about 33 px, as Chromium counts.
        let (delta, lines) = match event.delta {
            gpui::ScrollDelta::Lines(lines) => (lines, true),
            gpui::ScrollDelta::Pixels(pixels) => (gpui::point(f32::from(pixels.x) / 33.3, f32::from(pixels.y) / 33.3), false),
        };
        let wheel = lines && delta.x == 0. && delta.y != 0. && delta.y.fract().abs() < 0.001;
        let current = self.view;
        if event.modifiers.control || wheel {
            // A pinch comes as small steps with Ctrl held, a mouse wheel as whole notches.
            let pinch = event.modifiers.control && !wheel;
            let factor = if pinch { (delta.y * 33.3 / 100.).exp() } else if delta.y > 0. { 1.25 } else { 0.8 };
            self.zoom_to(current.scale * factor, Some(event.position), !pinch, cx);
        } else {
            self.show(View { x: current.x + delta.x * 33.3, y: current.y + delta.y * 33.3, ..current }, false, cx);
        }
    }
}

impl Render for ImageViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let image = self.image.clone();
        if let Some(image) = image.as_ref().filter(|image| self.natural.map(|(id, _, _)| id) != Some(image.id())) {
            let size = image::ImageReader::new(std::io::Cursor::new(image.bytes())).with_guessed_format().ok().and_then(|reader| reader.into_dimensions().ok());
            self.natural = size.map(|(width, height)| (image.id(), width.max(1) as f32, height.max(1) as f32));
        }
        let (index, count) = (self.index, self.items.len());
        // The pictures either side, as the web's arrows.
        let nav = |id: &'static str, name: &'static str, step: isize, cx: &mut Context<Self>| {
            div()
                .id(id)
                .absolute()
                .top(gpui::relative(0.5))
                .mt(px(-20.))
                .size(px(40.))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.bg3)
                .cursor_pointer()
                .hover(move |style| style.bg(theme.bg4))
                .child(icon(name, 22., theme.text1))
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |viewer, _, _, cx| {
                    cx.stop_propagation();
                    viewer.go(step, cx);
                }))
        };
        // The window coming to full screen, or the screen changing, keeps it within its edges, without a glide.
        let viewport = window.viewport_size();
        if viewport != self.viewport {
            self.viewport = viewport;
            let view = self.view;
            self.show(view, false, cx);
        }
        let view = self.current();
        if self.glide.is_some_and(|(_, started)| started.elapsed() < GLIDE) {
            window.request_animation_frame();
        } else {
            self.glide = None;
        }
        let (fitted_width, fitted_height) = self.fitted();
        let zoomed = self.view.scale > 1.;
        let dragging = self.drag.is_some();
        // The size it's shown at next to its own, as the web counts it.
        let percent = match self.natural {
            Some((_, natural, _)) if natural > 0. => (self.view.scale * fitted_width / natural * 100.).round(),
            _ => 100.,
        };
        let (width, height) = (fitted_width * view.scale, fitted_height * view.scale);
        let left = (f32::from(viewport.width) - width) / 2. + view.x;
        let top = (f32::from(viewport.height) - height) / 2. + view.y;
        let can_zoom_in = image.is_some() && self.view.scale < MAX_ZOOM;
        let tool = |id: &'static str, name: &'static str, enabled: bool, cx: &mut Context<Self>| {
            icon_button(id, name, 17., false, false, cx).when(!enabled, |el| el.opacity(0.4).cursor_default())
        };
        div()
            .id("image-viewer")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(theme::color(theme::black_a(0.92)))
            .on_click(cx.listener(|viewer, _, window, _| viewer.close(window)))
            .on_scroll(cx.listener(|viewer, event: &gpui::ScrollEvent, _, cx| viewer.on_wheel(event, cx)))
            .on_mouse_move(cx.listener(|viewer, event: &gpui::MouseMoveEvent, _, cx| {
                if let Some((from, start)) = viewer.drag {
                    if event.pressed_button == Some(gpui::MouseButton::Left) {
                        let current = viewer.view;
                        let moved = event.position - from;
                        viewer.show(View { x: start.x + f32::from(moved.x), y: start.y + f32::from(moved.y), ..current }, false, cx);
                    } else {
                        viewer.drag = None;
                        cx.notify();
                    }
                }
            }))
            .on_mouse_up(gpui::MouseButton::Left, cx.listener(|viewer, _, _, cx| {
                if viewer.drag.take().is_some() {
                    cx.notify();
                }
            }))
            .on_key_down(cx.listener(|viewer, event: &gpui::KeyDownEvent, window, cx| {
                let key = event.keystroke.key.as_str();
                let typed = event.keystroke.key_char.as_deref();
                let scale = viewer.view.scale;
                match key {
                    "escape" => viewer.close(window),
                    "left" => viewer.go(-1, cx),
                    "right" => viewer.go(1, cx),
                    "=" | "+" => viewer.zoom_to(scale * 1.5, None, true, cx),
                    "-" => viewer.zoom_to(scale / 1.5, None, true, cx),
                    "0" => viewer.show(FITTED, true, cx),
                    _ if typed == Some("+") => viewer.zoom_to(scale * 1.5, None, true, cx),
                    _ => {}
                }
            }))
            .when_some(image.filter(|_| fitted_width > 0.), |el, image| {
                el.child(
                    div()
                        .id("image-viewer-picture")
                        .absolute()
                        .left(px(left))
                        .top(px(top))
                        .w(px(width))
                        .h(px(height))
                        .when(zoomed, |el| el.cursor(if dragging { gpui::CursorStyle::ClosedHand } else { gpui::CursorStyle::OpenHand }))
                        .on_mouse_down(gpui::MouseButton::Left, cx.listener(|viewer, event: &gpui::MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            if event.click_count == 2 {
                                viewer.drag = None;
                                if viewer.view.scale > 1. {
                                    viewer.show(FITTED, true, cx);
                                } else {
                                    let closer = viewer.closer_scale();
                                    viewer.zoom_to(closer, Some(event.position), true, cx);
                                }
                            } else if viewer.view.scale > 1. {
                                viewer.drag = Some((event.position, viewer.view));
                                cx.notify();
                            }
                        }))
                        .child(gpui::img(image).size_full().when(!zoomed, |el| el.rounded(crate::theme::RADIUS_S))),
                )
            })
            .when(self.image.is_none(), |el| {
                let state = div().absolute().inset_0().flex().items_center().justify_center().gap(px(8.)).text_size(px(14.)).text_color(theme.text2);
                el.child(if self.failed {
                    state.child(icon("triangle-alert", 18., theme.text2)).child("This picture couldn't be loaded.")
                } else {
                    state.child(spinner(18., theme.text2))
                })
            })
            .when(index > 0, |el| el.child(nav("image-before", "chevron-left", -1, cx).left(px(18.))))
            .when(index + 1 < count, |el| el.child(nav("image-after", "chevron-right", 1, cx).right(px(18.))))
            .child(
                div()
                    .id("image-tools")
                    .absolute()
                    .right(px(18.))
                    .bottom(px(18.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .p(px(4.))
                    .rounded(RADIUS_L)
                    .bg(theme::color(theme::rgba(24, 24, 27, 0.85)))
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .when(count > 1, |el| el.child(div().px(px(8.)).text_size(px(12.5)).text_color(theme.text2).child(format!("{} of {count}", index + 1))))
                    .child(tool("zoom-out", "zoom-out", zoomed, cx).on_click(cx.listener(|viewer, _, _, cx| {
                        if viewer.view.scale > 1. {
                            let scale = viewer.view.scale;
                            viewer.zoom_to(scale / 1.5, None, true, cx);
                        }
                    })))
                    .child(
                        div()
                            .id("image-zoom")
                            .min_w(px(50.))
                            .h(px(30.))
                            .px(px(6.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_M)
                            .text_size(px(12.5))
                            .text_color(theme.text2)
                            .when(zoomed, |el| el.cursor_pointer().hover(move |style| style.bg(theme.hover_strong).text_color(theme.text1)))
                            .on_click(cx.listener(|viewer, _, _, cx| {
                                if viewer.view.scale > 1. {
                                    viewer.show(FITTED, true, cx);
                                }
                            }))
                            .child(format!("{percent}%")),
                    )
                    .child(tool("zoom-in", "zoom-in", can_zoom_in, cx).on_click(cx.listener(|viewer, _, _, cx| {
                        let scale = viewer.view.scale;
                        viewer.zoom_to(scale * 1.5, None, true, cx);
                    })))
                    .child(button("save-image", ButtonKind::Default, ButtonSize::Normal, false, cx).ml(px(4.)).child("Save").on_click(cx.listener(|viewer, _, _, cx| viewer.save(cx)))),
            )
            .child(
                // In the screen's corner, as Telegram's, with no title bar to keep clear of.
                div()
                    .absolute()
                    .top(px(18.))
                    .right(px(18.))
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        // `.icon-btn.image-close`: on bg-3, and bg-4 under the pointer.
                        div()
                            .id("close-image")
                            .size(px(32.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_M)
                            .bg(theme.bg3)
                            .group("close-image")
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.bg4))
                            .child(gpui::svg().path("icons/x.svg").size(px(18.)).flex_none().text_color(theme.text2).group_hover("close-image", move |style| style.text_color(theme.text1)))
                            .on_click(cx.listener(|viewer, _, window, cx| {
                                cx.stop_propagation();
                                viewer.close(window)
                            })),
                    ),
            )
            .enter("image-viewer-in", Enter::Fade, 100)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(file_id: &str) -> Attachment {
        Attachment { file_id: file_id.into(), name: format!("{file_id}.png"), mime: "image/png".into(), width: Some(400.), height: Some(300.), ..Default::default() }
    }

    fn message(sender: &str, attachments: Vec<Attachment>) -> MessageView {
        MessageView { sender_id: sender.into(), attachments, ..Default::default() }
    }

    #[test]
    fn a_gallery_goes_between_the_pictures_in_order_leaving_out_files_and_someone_blocked() {
        let document = Attachment { mime: "application/pdf".into(), width: None, ..picture("document") };
        let messages = [message("ann", vec![picture("a"), document]), message("bob", vec![picture("b")]), message("ann", vec![picture("c")])];
        let image = Arc::new(Image::from_bytes(gpui::ImageFormat::Png, Vec::new()));
        let gallery = Gallery::among("server", &messages, &picture("c"), image.clone(), &["bob".to_string()]);
        assert_eq!(gallery.items.iter().map(Item::file_id).collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(gallery.index, 1);
        // A picture not among them still opens, alone.
        let alone = Gallery::among("server", &messages, &picture("d"), image, &[]);
        assert_eq!(alone.items.iter().map(Item::file_id).collect::<Vec<_>>(), ["d"]);
        assert_eq!(alone.index, 0);
    }
}
