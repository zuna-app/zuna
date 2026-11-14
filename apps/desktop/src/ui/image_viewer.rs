//! A picture or a video from a chat, in a window of its own over the whole screen, as
//! Telegram's media viewer opens: what's behind dimmed through it, and the picture fitted to
//! the screen. A picture zooms as `ImageViewer` in packages/ui/src/features/overlays/Overlays.tsx
//! does, a video plays with a bar to move through it, and it goes between the chat's pictures
//! and videos.

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
use crate::state::{AppState, MediaFile, Picture, Store};
use crate::ui::media_views::VideoPlayer;
use crate::theme::{self, RADIUS_L, RADIUS_M};

/// A picture or a video the viewer can go to: what it's decrypted from, its name, whether
/// it's a picture small enough to be fetched before it's shown, as the ones either side of the
/// one on show are, and a video's attachment, which it plays from.
#[derive(Clone)]
pub struct Item {
    reference: AvatarRef,
    name: String,
    small: bool,
    video: Option<Attachment>,
}

impl Item {
    pub fn of(attachment: &Attachment) -> Self {
        let video = is_video(attachment);
        Item {
            reference: AvatarRef { file_id: attachment.file_id.clone(), key: attachment.key.clone(), prefix: attachment.prefix.clone(), chunks: attachment.chunks, mime: attachment.mime.clone() },
            name: attachment.name.clone(),
            small: !video && super::shared_media::loads_by_itself(attachment),
            video: video.then(|| attachment.clone()),
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

/// Whether an attachment is a video the viewer plays: not a video message, which plays in its circle.
pub fn is_video(attachment: &Attachment) -> bool {
    attachment.mime.starts_with("video/") && attachment.round != Some(true) && !attachment.file_id.is_empty()
}

/// The pictures and videos the viewer goes between, oldest first, as Telegram's does, the
/// one it opens on, a picture already decrypted, and the chat they're in.
pub struct Gallery {
    server_id: String,
    list_id: String,
    items: Vec<Item>,
    index: usize,
    image: Option<Arc<Image>>,
}

impl Gallery {
    pub fn new(server_id: &str, items: Vec<Item>, index: usize, image: Option<Arc<Image>>) -> Self {
        let index = index.min(items.len().saturating_sub(1));
        Gallery { server_id: server_id.to_string(), list_id: String::new(), items, index, image }
    }

    /// The pictures and videos among `messages`, the chat `list_id`'s, in their order, opening
    /// on `attachment`, a picture's `image` or a video. Someone blocked's are left out, as
    /// their messages are hidden.
    pub fn among(server_id: &str, list_id: &str, messages: &[MessageView], attachment: &Attachment, image: Option<Arc<Image>>, blocked: &[String]) -> Self {
        let mut items = Vec::new();
        let mut index = None;
        for message in messages.iter().filter(|message| message.deleted_at.is_none() && !blocked.contains(&message.sender_id)) {
            for shown in message.attachments.iter().filter(|shown| is_picture(shown) || is_video(shown)) {
                if shown.file_id == attachment.file_id {
                    index = Some(items.len());
                }
                items.push(Item::of(shown));
            }
        }
        let gallery = match index {
            Some(index) => Gallery::new(server_id, items, index, image),
            // One that isn't among them opens alone.
            None => Gallery::new(server_id, vec![Item::of(attachment)], 0, image),
        };
        Gallery { list_id: list_id.to_string(), ..gallery }
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
                // A video keeps its frame rate with another window focused, as the main window's does.
                inactive_frame_interval: None,
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
/// where the pointer is, and once it's bigger than the screen it can be dragged around. A
/// video is fitted to the screen and plays, which a click or Space pauses. The arrows and the
/// arrow keys go to the pictures and videos either side. A click outside it or Escape closes
/// it, and it can be saved.
pub struct ImageViewer {
    /// The picture on show, once it's decrypted.
    image: Option<Arc<Image>>,
    /// The video on show, once its file is here: its player, which its message gives up while
    /// it's here.
    video: Option<gpui::Entity<VideoPlayer>>,
    /// It couldn't be decrypted.
    failed: bool,
    server_id: String,
    list_id: String,
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
    _release: gpui::Subscription,
}

/// The room a video leaves under itself for the viewer's tools, so they never cover its bar.
const VIDEO_TOOLS_ROOM: f32 = 56.;

impl ImageViewer {
    fn new(gallery: Gallery, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        // A picture gone to that's still being decrypted shows once it is, and a video once its file is here.
        let watch = cx.try_global::<Store>().map(|store| store.0.clone()).map(|state| cx.observe(&state, |viewer, state, cx| viewer.picture_came(&state, cx)));
        // However the window goes, a video in it goes back to its message, playing on if it was.
        let release = cx.on_release(|viewer, cx| viewer.give_back(false, cx));
        let mut viewer = ImageViewer {
            image: None,
            video: None,
            failed: false,
            server_id: String::new(),
            list_id: String::new(),
            items: Vec::new(),
            index: 0,
            focus,
            view: FITTED,
            glide: None,
            drag: None,
            natural: None,
            viewport: window.viewport_size(),
            _watch: watch,
            _release: release,
        };
        viewer.show_gallery(gallery, cx);
        viewer
    }

    /// Another gallery in its place, fitted again.
    fn show_gallery(&mut self, gallery: Gallery, cx: &mut Context<Self>) {
        self.give_back(true, cx);
        self.server_id = gallery.server_id;
        self.list_id = gallery.list_id;
        self.items = gallery.items;
        self.index = gallery.index;
        self.reset();
        self.image = gallery.image;
        if self.current_video().is_some() {
            self.take_video(cx);
        } else if self.image.is_none() {
            self.image = self.fetch(self.index, cx);
        }
        self.fetch_near(cx);
        cx.notify();
    }

    /// The attachment of the video on show, if it's a video.
    fn current_video(&self) -> Option<&Attachment> {
        self.items.get(self.index).and_then(|item| item.video.as_ref())
    }

    /// The video on show's player, from its message if it has one, or started once its file is
    /// here, shown here rather than there.
    fn take_video(&mut self, cx: &mut Context<Self>) {
        if self.video.is_some() || self.failed {
            return;
        }
        let (Some(attachment), Some(state)) = (self.current_video().cloned(), cx.try_global::<Store>().map(|store| store.0.clone())) else { return };
        let (server_id, list_id, key) = (self.server_id.clone(), self.list_id.clone(), attachment.cache_id());
        let player = state.update(cx, |state, cx| {
            state.open_video(&server_id, &list_id, &attachment, false, cx);
            state.touch_media(&key);
            state.videos.get(&key).cloned()
        });
        match player {
            Some(player) => {
                player.update(cx, |player, cx| player.set_full(true, cx));
                self.video = Some(player);
            }
            None if matches!(state.read(cx).media_files.get(&key), Some(MediaFile::Failed)) => self.failed = true,
            // Its file is still on its way.
            None => return,
        }
        cx.notify();
    }

    /// Gives the video on show back to its message, paused if `pause` says so, as it is when
    /// the viewer goes to something else.
    fn give_back(&mut self, pause: bool, cx: &mut App) {
        let state = cx.try_global::<Store>().map(|store| store.0.clone());
        let Some(player) = self.video.take() else {
            // One whose file is still on its way isn't started in its message once it comes.
            if let (Some(key), Some(state)) = (self.current_video().map(Attachment::cache_id), state) {
                state.update(cx, |state, _| state.unwant_video(&key));
            }
            return;
        };
        player.update(cx, |player, cx| {
            if pause {
                player.pause(cx);
            }
            player.set_full(false, cx);
        });
        // The chat draws it again where it was.
        if let Some(state) = state {
            state.update(cx, |_, cx| cx.notify());
        }
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
        self.give_back(true, cx);
        self.index = next;
        self.reset();
        if self.current_video().is_some() {
            self.take_video(cx);
        } else {
            self.image = self.fetch(next, cx);
            if self.image.is_none() {
                if let Some(state) = cx.try_global::<Store>().map(|store| store.0.clone()) {
                    self.picture_came(&state, cx);
                }
            }
        }
        self.fetch_near(cx);
        cx.notify();
    }

    /// A picture from the app's, decrypting it if it isn't there yet.
    fn fetch(&self, index: usize, cx: &mut Context<Self>) -> Option<Arc<Image>> {
        let state = cx.try_global::<Store>()?.0.clone();
        let item = self.items.get(index).filter(|item| item.video.is_none())?;
        let (server_id, reference) = (self.server_id.clone(), item.reference.clone());
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
        if self.current_video().is_some() {
            // A video's file came, or didn't.
            self.take_video(cx);
            return;
        }
        if self.image.is_some() || self.failed {
            return;
        }
        let Some(item) = self.items.get(self.index) else { return };
        match state.read(cx).pictures.get(&format!("file:{}", item.reference.cache_id())) {
            Some(Picture::Ready(image)) => self.image = Some(image.clone()),
            Some(Picture::Failed(_)) => self.failed = true,
            _ => return,
        }
        cx.notify();
    }

    fn close(&mut self, window: &mut Window) {
        window.remove_window();
    }

    /// Its size fitted to the screen less 40 px around, a picture never larger than its own,
    /// and a video as large as the screen takes it, less the room for the tools under it.
    fn fitted(&self) -> (f32, f32) {
        let Some((_, width, height)) = self.natural else { return (0., 0.) };
        let video = self.current_video().is_some();
        let (room_width, room_height) = (f32::from(self.viewport.width) - 80., f32::from(self.viewport.height) - 80. - if video { VIDEO_TOOLS_ROOM } else { 0. });
        let fit = (room_width / width).min(room_height / height);
        let fit = if video { fit } else { fit.min(1.) }.max(0.);
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
        let Some(item) = self.items.get(self.index) else { return };
        // A video's decrypted file is copied, a picture written from its bytes.
        enum Saved {
            Bytes(Vec<u8>),
            File(std::path::PathBuf),
        }
        let saved = match (&item.video, &self.image) {
            (Some(attachment), _) => match cx.try_global::<Store>().and_then(|store| store.0.read(cx).media_files.get(&attachment.cache_id()).cloned()) {
                Some(MediaFile::Ready(path)) => Saved::File(path),
                _ => return,
            },
            (None, Some(image)) => Saved::Bytes(image.bytes().to_vec()),
            (None, None) => return,
        };
        let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
        let chosen = cx.prompt_for_new_path(&downloads, Some(&item.name));
        cx.spawn(async move |_| {
            if let Ok(Ok(Some(path))) = chosen.await {
                match saved {
                    Saved::Bytes(bytes) => std::fs::write(path, bytes).ok(),
                    Saved::File(file) => std::fs::copy(file, path).ok().map(|_| ()),
                };
            }
        })
        .detach();
    }

    fn on_wheel(&mut self, event: &gpui::ScrollEvent, cx: &mut Context<Self>) {
        if self.current_video().is_some() {
            return;
        }
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
        // A video's shape from its pictures once one is decoded, and from its message until then.
        let video = self.video.clone();
        let is_video = self.current_video().is_some();
        if let Some(attachment) = self.current_video().cloned() {
            let decoded = video.as_ref().and_then(|player| player.read(cx).natural_size());
            let given = attachment.width.zip(attachment.height).map(|(width, height)| (width as f32, height as f32));
            self.natural = decoded.or(given).or(Some((16., 9.))).map(|(width, height)| (0, width.max(1.), height.max(1.)));
            if let Some(state) = cx.try_global::<Store>() {
                state.0.read(cx).touch_media(&attachment.cache_id());
            }
        }
        let (index, count) = (self.index, self.items.len());
        // The pictures either side, as the web's arrows.
        let nav = |id: &'static str, name: &'static str, step: isize, cx: &mut Context<Self>| {
            named_div(id)
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
        // A video sits higher, over the room its tools take under it.
        let top = (f32::from(viewport.height) - if is_video { VIDEO_TOOLS_ROOM } else { 0. } - height) / 2. + view.y;
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
            .on_click(cx.listener(|viewer, event: &gpui::ClickEvent, window, _| {
                // GPUI makes Space and Enter clicks on what has focus, as this has: Space plays and
                // pauses a video, and neither closes it, as on the web, where only Escape does.
                if !event.is_keyboard() {
                    viewer.close(window);
                }
            }))
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
                if let Some(player) = viewer.video.clone() {
                    if key == "space" {
                        player.update(cx, |player, cx| player.toggle_pause(cx));
                        return;
                    }
                }
                if viewer.current_video().is_some() && matches!(key, "=" | "+" | "-" | "0") {
                    return;
                }
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
                    named_div("image-viewer-picture")
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
            // The player draws the video and its bar in the box fitted to it.
            .when_some(video.filter(|_| fitted_width > 0.), |el, player| {
                el.child(named_div("video-viewer-player").absolute().left(px(left)).top(px(top)).w(px(width)).h(px(height)).child(player))
            })
            .when(if is_video { self.video.is_none() } else { self.image.is_none() }, |el| {
                let state = div().absolute().inset_0().flex().items_center().justify_center().gap(px(8.)).text_size(px(14.)).text_color(theme.text2);
                el.child(if self.failed {
                    state.child(icon("triangle-alert", 18., theme.text2)).child(if is_video { "This video couldn't be loaded." } else { "This picture couldn't be loaded." })
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
                    // A video doesn't zoom.
                    .when(!is_video, |el| el.child(tool("zoom-out", "zoom-out", zoomed, cx).on_click(cx.listener(|viewer, _, _, cx| {
                        if viewer.view.scale > 1. {
                            let scale = viewer.view.scale;
                            viewer.zoom_to(scale / 1.5, None, true, cx);
                        }
                    })))
                    .child(
                        named_div("image-zoom")
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
                    }))))
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
                        named_div("close-image")
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
    use gpui::{Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ScrollDelta, ScrollEvent, TestAppContext, VisualTestContext};
    use serde_json::json;

    use super::*;
    use crate::testing::{App as Running, World, refused};

    fn picture(file_id: &str) -> Attachment {
        Attachment { file_id: file_id.into(), name: format!("{file_id}.png"), mime: "image/png".into(), width: Some(400.), height: Some(300.), ..Default::default() }
    }

    fn message(sender: &str, attachments: Vec<Attachment>) -> MessageView {
        MessageView { sender_id: sender.into(), attachments, ..Default::default() }
    }

    fn video(file_id: &str) -> Attachment {
        Attachment { file_id: file_id.into(), key: "a2V5".into(), name: format!("{file_id}.mp4"), mime: "video/mp4".into(), width: Some(320.), height: Some(180.), duration: Some(12.), ..Default::default() }
    }

    #[test]
    fn a_gallery_goes_between_the_pictures_and_videos_in_order_leaving_out_files_video_messages_and_someone_blocked() {
        let document = Attachment { mime: "application/pdf".into(), width: None, ..picture("document") };
        let round = Attachment { round: Some(true), ..video("round") };
        let messages = [message("ann", vec![picture("a"), document]), message("bob", vec![picture("b")]), message("ann", vec![video("v"), round]), message("ann", vec![picture("c")])];
        let image = Arc::new(Image::from_bytes(gpui::ImageFormat::Png, Vec::new()));
        let gallery = Gallery::among("server", "group", &messages, &picture("c"), Some(image.clone()), &["bob".to_string()]);
        assert_eq!(gallery.items.iter().map(Item::file_id).collect::<Vec<_>>(), ["a", "v", "c"]);
        assert_eq!(gallery.index, 2);
        assert_eq!(gallery.list_id, "group");
        assert!(gallery.items[1].video.is_some() && !gallery.items[1].small, "a video plays from its attachment, and isn't fetched as a picture");
        // Opening on the video.
        let on_video = Gallery::among("server", "group", &messages, &video("v"), None, &[]);
        assert_eq!((on_video.index, on_video.items.len()), (2, 4));
        // A picture not among them still opens, alone.
        let alone = Gallery::among("server", "group", &messages, &picture("d"), Some(image), &[]);
        assert_eq!(alone.items.iter().map(Item::file_id).collect::<Vec<_>>(), ["d"]);
        assert_eq!(alone.index, 0);
    }

    /// A picture of this size, as a PNG.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(width, height, image::Rgba([200, 30, 30, 255])).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn viewer<T>(handle: WindowHandle<ImageViewer>, cx: &mut TestAppContext, read: impl FnOnce(&ImageViewer) -> T) -> T {
        handle.update(cx, |viewer, _, _| read(viewer)).expect("the viewer is open")
    }

    /// Where an element of the viewer's was drawn.
    fn bounds_of(handle: WindowHandle<ImageViewer>, cx: &mut TestAppContext, selector: &'static str) -> Bounds<Pixels> {
        VisualTestContext::from_window(handle.into(), cx).debug_bounds(selector).unwrap_or_else(|| panic!("{selector} is drawn"))
    }

    fn click(handle: WindowHandle<ImageViewer>, cx: &mut TestAppContext, selector: &'static str) {
        let at = bounds_of(handle, cx, selector).center();
        VisualTestContext::from_window(handle.into(), cx).simulate_click(at, Modifiers::none());
    }

    fn event(handle: WindowHandle<ImageViewer>, cx: &mut TestAppContext, event: impl gpui::InputEvent) {
        VisualTestContext::from_window(handle.into(), cx).simulate_event(event);
    }

    fn wheel(position: gpui::Point<Pixels>, delta: ScrollDelta, control: bool) -> ScrollEvent {
        ScrollEvent { position, delta, modifiers: Modifiers { control, ..Modifiers::none() }, touch_phase: gpui::TouchPhase::Moved, source: gpui::ScrollSource::Pointer }
    }

    #[gpui::test]
    fn the_viewer_zooms_pans_goes_between_pictures_saves_and_closes(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let app = Running::open(cx, &World::new("image-viewer"));
        let second = png(300, 200);
        app.answer("downloadFile", move |args| match args[0]["fileId"].as_str() {
            Some("b") => Ok(json!({ "$bytes": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &second) })),
            _ => Err(refused("It's no longer on the server.")),
        });
        let first = png(800, 600);
        let gallery = || Gallery::new(crate::testing::fixtures::SERVER, vec![Item::of(&picture("a")), Item::of(&picture("b")), Item::of(&picture("c"))], 0, Some(Arc::new(Image::from_bytes(gpui::ImageFormat::Png, png(800, 600)))));
        app.window.update(cx, |_, window, cx| open(gallery(), window, cx)).unwrap();
        app.run(cx);
        let handle = cx.update(|cx| cx.global::<Open>().0);
        assert_eq!(viewer(handle, cx, |viewer| (viewer.index, viewer.natural.map(|(_, width, height)| (width, height)))), (0, Some((800., 600.))));
        assert!(app.calls_of("downloadFile").iter().any(|call| call[0]["fileId"] == "b"), "the one after is fetched before it's shown");
        let scale = |cx: &mut TestAppContext| viewer(handle, cx, |viewer| viewer.view.scale);

        // The keys and the buttons zoom, and the percentage fits it again.
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("=");
        assert_eq!(scale(cx), 1.5);
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("-");
        assert_eq!(scale(cx), 1.);
        click(handle, cx, "zoom-in");
        click(handle, cx, "zoom-in");
        assert_eq!(scale(cx), 2.25);
        click(handle, cx, "zoom-out");
        assert_eq!(scale(cx), 1.5);
        click(handle, cx, "image-zoom");
        assert_eq!(scale(cx), 1.);
        click(handle, cx, "zoom-out");
        assert_eq!(scale(cx), 1., "no smaller than fitted");
        for _ in 0..8 {
            VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("=");
        }
        assert_eq!(scale(cx), MAX_ZOOM, "nor bigger than its limit");
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("0");
        assert_eq!(scale(cx), 1.);

        // A mouse wheel's notch zooms towards the pointer, a touchpad pans, and a pinch zooms smoothly.
        let middle = bounds_of(handle, cx, "image-viewer-picture").center();
        event(handle, cx, wheel(middle, ScrollDelta::Lines(gpui::point(0., 1.)), false));
        assert_eq!(scale(cx), 1.25);
        event(handle, cx, wheel(middle, ScrollDelta::Lines(gpui::point(0., -1.)), false));
        assert_eq!(scale(cx), 1.);
        // Bigger than the screen, a touchpad pans it.
        for _ in 0..4 {
            VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("=");
        }
        let before = viewer(handle, cx, |viewer| viewer.view);
        event(handle, cx, wheel(middle, ScrollDelta::Pixels(gpui::point(px(0.), px(20.))), false));
        let after = viewer(handle, cx, |viewer| viewer.view);
        assert!(after.scale == before.scale && (after.y - before.y - 20.).abs() < 0.5, "a touchpad pans it");
        event(handle, cx, wheel(middle, ScrollDelta::Pixels(gpui::point(px(0.), px(-30.))), true));
        assert!(scale(cx) < before.scale, "a pinch in");
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("0");

        // Two clicks show it at its own size or twice as big; two more fit it again.
        let double = |cx: &mut TestAppContext| {
            let at = bounds_of(handle, cx, "image-viewer-picture").center();
            event(handle, cx, MouseDownEvent { position: at, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: 2, first_mouse: false });
            event(handle, cx, MouseUpEvent { position: at, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: 2 });
        };
        double(cx);
        assert_eq!(scale(cx), viewer(handle, cx, |viewer| viewer.closer_scale()));
        assert!(scale(cx) >= 2.);
        // Bigger than the screen, it's dragged around, and kept from leaving it.
        let at = bounds_of(handle, cx, "image-viewer-picture").center();
        event(handle, cx, MouseDownEvent { position: at, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: 1, first_mouse: false });
        assert!(viewer(handle, cx, |viewer| viewer.drag.is_some()));
        event(handle, cx, MouseMoveEvent { position: at + gpui::point(px(300.), px(300.)), modifiers: Modifiers::none(), pressed_button: Some(MouseButton::Left) });
        let dragged = viewer(handle, cx, |viewer| viewer.view);
        let (fitted_width, fitted_height) = viewer(handle, cx, |viewer| viewer.fitted());
        let viewport = viewer(handle, cx, |viewer| viewer.viewport);
        let spare = |fitted: f32, room: Pixels| ((fitted * dragged.scale - f32::from(room)) / 2.).max(0.);
        assert_eq!((dragged.x, dragged.y), (spare(fitted_width, viewport.width), spare(fitted_height, viewport.height)), "as far as its edges reach past the screen, and no further");
        assert!(dragged.x + dragged.y > 0.);
        event(handle, cx, MouseUpEvent { position: at, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: 1 });
        assert!(viewer(handle, cx, |viewer| viewer.drag.is_none()));
        double(cx);
        assert_eq!(scale(cx), 1.);

        // Saved where the person says.
        let dir = std::env::temp_dir().join(format!("zuna-viewer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("a.png");
        click(handle, cx, "save-image");
        cx.simulate_new_path_selection(|_| Some(target.clone()));
        cx.run_until_parked();
        assert_eq!(std::fs::read(&target).unwrap(), first);
        std::fs::remove_dir_all(&dir).ok();

        // The arrows go between the pictures: one fetched already, and one that can't be.
        click(handle, cx, "image-after");
        app.run(cx);
        assert_eq!(viewer(handle, cx, |viewer| (viewer.index, viewer.image.is_some(), viewer.natural.map(|(_, width, _)| width))), (1, true, Some(300.)));
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("right");
        app.run(cx);
        assert_eq!(viewer(handle, cx, |viewer| (viewer.index, viewer.image.is_some(), viewer.failed)), (2, false, true), "This picture couldn't be loaded.");
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("right");
        assert_eq!(viewer(handle, cx, |viewer| viewer.index), 2, "no further than the last");
        click(handle, cx, "image-before");
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("left");
        assert_eq!(viewer(handle, cx, |viewer| viewer.index), 0);

        // Another picture opens in the same window.
        app.window.update(cx, |_, window, cx| open(Gallery::new(crate::testing::fixtures::SERVER, vec![Item::of(&picture("z"))], 5, Some(Arc::new(Image::from_bytes(gpui::ImageFormat::Png, png(10, 10))))), window, cx)).unwrap();
        app.run(cx);
        assert_eq!(cx.update(|cx| cx.global::<Open>().0), handle);
        assert_eq!(viewer(handle, cx, |viewer| (viewer.index, viewer.items.len())), (0, 1), "a gallery's index is kept inside it");
        // Escape closes it, and so does a click beside the picture.
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("escape");
        assert!(handle.update(cx, |_, _, _| ()).is_err());
        app.window.update(cx, |_, window, cx| open(gallery(), window, cx)).unwrap();
        app.run(cx);
        let handle = cx.update(|cx| cx.global::<Open>().0);
        VisualTestContext::from_window(handle.into(), cx).simulate_click(gpui::point(px(3.), px(300.)), Modifiers::none());
        assert!(handle.update(cx, |_, _, _| ()).is_err());
        app.window.update(cx, |_, window, cx| open(gallery(), window, cx)).unwrap();
        app.run(cx);
        let handle = cx.update(|cx| cx.global::<Open>().0);
        click(handle, cx, "close-image");
        assert!(handle.update(cx, |_, _, _| ()).is_err());
    }

    /// A video's file as the app keeps it decrypted on disk. Nothing decodes it, so the tests play no sound.
    fn video_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zuna-video-viewer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, format!("{name}'s bytes")).unwrap();
        file
    }

    /// A video played in its message, as its player is there.
    fn played(app: &Running, cx: &mut TestAppContext, attachment: &Attachment) -> gpui::Entity<VideoPlayer> {
        let file = video_file(&format!("{}.mp4", attachment.file_id));
        app.state.update(cx, |state, cx| {
            state.media_files.insert(attachment.cache_id(), MediaFile::Ready(file));
            state.open_video(crate::testing::fixtures::SERVER, "group", attachment, false, cx);
        });
        app.run(cx);
        app.read(cx, |state| state.videos.get(&attachment.cache_id()).cloned()).expect("its player")
    }

    fn shown_full(cx: &mut TestAppContext) -> Option<gpui::EntityId> {
        cx.read(|cx| cx.try_global::<crate::ui::media_views::ShownFull>().and_then(|shown| shown.0))
    }

    #[gpui::test]
    fn a_video_plays_over_the_whole_screen_among_the_pictures_and_goes_back_to_its_message(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let app = Running::open(cx, &World::new("video-viewer"));
        app.answer("downloadFile", |_| Err(refused("It's no longer on the server.")));
        let clip = video("v");
        let player = played(&app, cx, &clip);
        let gallery = Gallery::new(crate::testing::fixtures::SERVER, vec![Item::of(&picture("a")), Item::of(&clip), Item::of(&picture("c"))], 1, None);
        app.window.update(cx, |_, window, cx| open(gallery, window, cx)).unwrap();
        app.run(cx);
        let handle = cx.update(|cx| cx.global::<Open>().0);
        let showing = |cx: &mut TestAppContext| viewer(handle, cx, |viewer| viewer.video.as_ref().map(|player| player.entity_id()));
        assert_eq!(showing(cx), Some(player.entity_id()), "its message's player, shown here");
        assert!(cx.read(|cx| player.read(cx).is_full()));
        assert_eq!(shown_full(cx), Some(player.entity_id()), "which the chat leaves out meanwhile");

        // Fitted to the screen, keeping its shape and larger than its own, with room for the tools under it.
        let drawn = bounds_of(handle, cx, "video-viewer-player");
        let viewport = viewer(handle, cx, |viewer| viewer.viewport);
        assert!((f32::from(drawn.size.width) / f32::from(drawn.size.height) - 16. / 9.).abs() < 0.01);
        assert!(f32::from(drawn.size.width) > 320.);
        assert!(f32::from(drawn.bottom()) <= f32::from(viewport.height) - VIDEO_TOOLS_ROOM - 40. + 0.5);
        assert!(VisualTestContext::from_window(handle.into(), cx).debug_bounds("zoom-in").is_none(), "a video doesn't zoom");
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("=");
        assert_eq!(viewer(handle, cx, |viewer| viewer.view.scale), 1.);

        // Space, its button and a click on it pause and play it.
        let playing = |cx: &mut TestAppContext| cx.read(|cx| player.read(cx).is_playing());
        let before = playing(cx);
        // Pressed and let go, which GPUI would make a click on the viewer too.
        let space = gpui::Keystroke::parse("space").unwrap();
        event(handle, cx, gpui::KeyDownEvent { keystroke: space.clone(), is_held: false, prefer_character_input: false });
        event(handle, cx, gpui::KeyUpEvent { keystroke: space });
        assert_eq!(playing(cx), !before);
        assert!(handle.update(cx, |_, _, _| ()).is_ok(), "Space doesn't close the viewer");
        let enter = gpui::Keystroke::parse("enter").unwrap();
        event(handle, cx, gpui::KeyDownEvent { keystroke: enter.clone(), is_held: false, prefer_character_input: false });
        event(handle, cx, gpui::KeyUpEvent { keystroke: enter });
        assert!(handle.update(cx, |_, _, _| ()).is_ok(), "nor Enter");
        click(handle, cx, "video-play-pause");
        assert_eq!(playing(cx), before);
        click(handle, cx, "video-viewer-player");
        assert_eq!(playing(cx), !before);
        assert!(handle.update(cx, |_, _, _| ()).is_ok(), "a click on the video doesn't close the viewer");

        // The bar moves it: halfway along is halfway through, paused there.
        if playing(cx) {
            click(handle, cx, "video-play-pause");
        }
        click(handle, cx, "video-seek-bar");
        assert!((cx.read(|cx| player.read(cx).position()) - 6.).abs() < 0.2, "at once on the bar");
        app.run(cx);
        assert!((cx.read(|cx| player.read(cx).position()) - 6.).abs() < 0.5);
        assert!(!playing(cx), "paused as it was");

        // Saved where the person says: a copy of its file.
        let target = std::env::temp_dir().join(format!("zuna-video-viewer-{}", std::process::id())).join("saved-here.mp4");
        click(handle, cx, "save-image");
        cx.simulate_new_path_selection(|_| Some(target.clone()));
        cx.run_until_parked();
        assert_eq!(std::fs::read(&target).unwrap(), b"v.mp4's bytes");

        // The arrows go to the pictures either side, pausing it and giving it back to its message.
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("space");
        assert!(playing(cx));
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("right");
        assert_eq!((viewer(handle, cx, |viewer| viewer.index), showing(cx)), (2, None));
        assert!(!cx.read(|cx| player.read(cx).is_full()) && !playing(cx));
        assert_eq!(shown_full(cx), None);
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("left");
        assert_eq!(showing(cx), Some(player.entity_id()));
        assert!(cx.read(|cx| player.read(cx).is_full()));

        // Escape leaves full screen: back in its message, playing on as it was.
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("space");
        assert!(playing(cx));
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("escape");
        assert!(handle.update(cx, |_, _, _| ()).is_err());
        assert!(!cx.read(|cx| player.read(cx).is_full()) && playing(cx));
        assert_eq!(shown_full(cx), None);

        // So does its bar's button.
        app.window.update(cx, |_, window, cx| open(Gallery::new(crate::testing::fixtures::SERVER, vec![Item::of(&clip)], 0, None), window, cx)).unwrap();
        app.run(cx);
        let handle = cx.update(|cx| cx.global::<Open>().0);
        assert!(cx.read(|cx| player.read(cx).is_full()));
        click(handle, cx, "video-exit-full");
        cx.run_until_parked();
        assert!(handle.update(cx, |_, _, _| ()).is_err());
        assert!(!cx.read(|cx| player.read(cx).is_full()));

        // One whose file can't be had says so.
        app.window.update(cx, |_, window, cx| open(Gallery::new(crate::testing::fixtures::SERVER, vec![Item::of(&video("gone"))], 0, None), window, cx)).unwrap();
        app.run(cx);
        let handle = cx.update(|cx| cx.global::<Open>().0);
        assert_eq!(viewer(handle, cx, |viewer| (viewer.failed, viewer.video.is_none())), (true, true), "This video couldn't be loaded.");
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("escape");
        assert!(handle.update(cx, |_, _, _| ()).is_err());
        // Left before it had a player, it isn't started in its message if its file comes after all.
        assert!(!app.read(cx, |state| state.wants_video(&video("gone").cache_id())));
    }

    #[gpui::test]
    fn a_video_playing_in_its_message_goes_full_screen_from_its_button_or_two_clicks(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let app = Running::open(cx, &World::new("video-full-screen"));
        let clip = video("w");
        let player = played(&app, cx, &clip);
        let button: &'static str = Box::leak(format!("video-full-{}", clip.cache_id()).into_boxed_str());
        // The player alone in a window, as the chat draws it in its message.
        let chat = cx.update(|cx| cx.open_window(gpui::WindowOptions::default(), |_, _| player.clone())).unwrap();
        let mut in_chat = VisualTestContext::from_window(chat.into(), cx);
        in_chat.run_until_parked();
        let at = in_chat.debug_bounds(button).expect("its full screen button").center();
        in_chat.simulate_click(at, Modifiers::none());
        app.run(cx);
        let handle = cx.update(|cx| cx.global::<Open>().0);
        assert_eq!(viewer(handle, cx, |viewer| viewer.video.as_ref().map(|player| player.entity_id())), Some(player.entity_id()));
        assert!(cx.read(|cx| player.read(cx).is_full()));
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("escape");
        assert!(!cx.read(|cx| player.read(cx).is_full()));

        // Two clicks on it go full screen, playing or paused as it was before them.
        app.run(cx);
        let before = cx.read(|cx| player.read(cx).is_playing());
        let mut in_chat = VisualTestContext::from_window(chat.into(), cx);
        let middle = in_chat.debug_bounds(button).expect("drawn in its message again").center() - gpui::point(px(100.), px(60.));
        for count in 1..=2 {
            in_chat.simulate_event(MouseDownEvent { position: middle, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: count, first_mouse: false });
            in_chat.simulate_event(MouseUpEvent { position: middle, modifiers: Modifiers::none(), button: MouseButton::Left, click_count: count });
        }
        cx.run_until_parked();
        let handle = cx.update(|cx| cx.global::<Open>().0);
        assert!(handle.update(cx, |_, _, _| ()).is_ok() && cx.read(|cx| player.read(cx).is_full()));
        assert_eq!(cx.read(|cx| player.read(cx).is_playing()), before);
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("escape");
    }

    #[gpui::test]
    fn a_video_is_fitted_by_the_shape_of_its_own_pictures(cx: &mut TestAppContext) {
        crate::ui::motion::set_reduced(true);
        let app = Running::open(cx, &World::new("video-shape"));
        // A real one, with no sound to play: 64 by 48, where its message says 16 by 9. H.264 in
        // 4:2:0, which every system's decoder reads: Windows' takes neither the WebM beside it,
        // which is VP9 in 4:4:4, nor the other fixtures' H.264, which is 4:4:4 too.
        let clip = Attachment { mime: "video/quicktime".into(), name: "real.mov".into(), ..video("real") };
        let file = video_file("real.mov");
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/core/test/fixtures/metadata/timed.mov"), &file).unwrap();
        app.state.update(cx, |state, cx| {
            state.media_files.insert(clip.cache_id(), MediaFile::Ready(file));
        });
        app.window.update(cx, |_, window, cx| open(Gallery::new(crate::testing::fixtures::SERVER, vec![Item::of(&clip)], 0, None), window, cx)).unwrap();
        cx.run_until_parked();
        let handle = cx.update(|cx| cx.global::<Open>().0);
        let player = viewer(handle, cx, |viewer| viewer.video.clone()).expect("started here, its file being here");
        for _ in 0..200 {
            if cx.read(|cx| player.read(cx).natural_size()).is_some() {
                break;
            }
            cx.executor().advance_clock(std::time::Duration::from_millis(20));
            std::thread::sleep(std::time::Duration::from_millis(5));
            cx.run_until_parked();
        }
        assert_eq!(cx.read(|cx| player.read(cx).natural_size()), Some((64., 48.)));
        VisualTestContext::from_window(handle.into(), cx).run_until_parked();
        let drawn = bounds_of(handle, cx, "video-viewer-player");
        assert!((f32::from(drawn.size.width) / f32::from(drawn.size.height) - 4. / 3.).abs() < 0.01);
        VisualTestContext::from_window(handle.into(), cx).simulate_keystrokes("escape");
    }
}
