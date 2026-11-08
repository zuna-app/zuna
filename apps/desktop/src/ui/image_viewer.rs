//! A picture from a chat, in a window of its own over the whole screen, as Telegram's media
//! viewer opens: what's behind dimmed through it, and the picture fitted to the screen. It
//! zooms as `ImageViewer` in packages/ui/src/features/overlays/Overlays.tsx does.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, Context, Image, IntoElement, ParentElement, Pixels, Render, Styled, TitlebarOptions, Window, WindowBackgroundAppearance, WindowBounds, WindowHandle,
    WindowKind, WindowOptions, div, point, prelude::*, px, size,
};

use super::components::*;
use super::motion::{Enter, Motion};
use crate::platform;
use crate::theme::{self, RADIUS_L, RADIUS_M};

/// The viewer's window while it's open, so another picture is shown in it rather than in a second one.
struct Open(WindowHandle<ImageViewer>);

impl gpui::Global for Open {}

/// Shows a picture in the viewer: in its window if it's open, or in a new one over the whole
/// screen `window` is on.
pub fn open(image: Arc<Image>, name: String, window: &Window, cx: &mut App) {
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
            if let Some(Open(handle)) = cx.try_global::<Open>() {
                let handle = *handle;
                let (image, name) = (image.clone(), name.clone());
                let shown = handle.update(cx, |viewer, window, cx| {
                    viewer.show_picture(image, name, cx);
                    window.activate_window();
                });
                if shown.is_ok() {
                    return;
                }
            }
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
                cx.new(|cx| ImageViewer::new(image, name, window, cx))
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
/// click outside it or Escape closes it, and it can be saved.
pub struct ImageViewer {
    image: Arc<Image>,
    name: String,
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
}

impl ImageViewer {
    fn new(image: Arc<Image>, name: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        ImageViewer { image, name, focus, view: FITTED, glide: None, drag: None, natural: None, viewport: window.viewport_size() }
    }

    /// Another picture in its place, fitted again.
    fn show_picture(&mut self, image: Arc<Image>, name: String, cx: &mut Context<Self>) {
        self.image = image;
        self.name = name;
        self.view = FITTED;
        self.glide = None;
        self.drag = None;
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
        let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
        let chosen = cx.prompt_for_new_path(&downloads, Some(&self.name));
        let bytes = self.image.bytes().to_vec();
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
        if self.natural.map(|(id, _, _)| id) != Some(image.id()) {
            let size = image::ImageReader::new(std::io::Cursor::new(image.bytes())).with_guessed_format().ok().and_then(|reader| reader.into_dimensions().ok());
            self.natural = size.map(|(width, height)| (image.id(), width.max(1) as f32, height.max(1) as f32));
        }
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
        let can_zoom_in = self.view.scale < MAX_ZOOM;
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
                    "=" | "+" => viewer.zoom_to(scale * 1.5, None, true, cx),
                    "-" => viewer.zoom_to(scale / 1.5, None, true, cx),
                    "0" => viewer.show(FITTED, true, cx),
                    _ if typed == Some("+") => viewer.zoom_to(scale * 1.5, None, true, cx),
                    _ => {}
                }
            }))
            .when(fitted_width > 0., |el| {
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
