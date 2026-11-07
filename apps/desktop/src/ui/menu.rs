//! Popup menus at a point, kept inside the window (PopupMenu in components/ui.tsx).

use std::rc::Rc;

use gpui::{
    AnyElement, Anchor, App, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Pixels, Point, Render, Styled, Window, anchored,
    deferred, div, prelude::*, px,
};

use super::components::*;
use super::motion::{Enter, Motion};
use crate::theme::{RADIUS_L, RADIUS_S};

pub type Action = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(Clone)]
pub struct MenuEntry {
    pub label: String,
    pub icon: Option<&'static str>,
    pub danger: bool,
    pub separator: bool,
    pub action: Option<Action>,
    /// Choices that replace the menu's entries when this one is picked.
    pub submenu: Option<Vec<MenuEntry>>,
    /// A person's picture in place of the icon: their name, seed and photo.
    pub avatar: Option<(String, String, Option<std::sync::Arc<gpui::Image>>)>,
}

impl MenuEntry {
    pub fn new(label: impl Into<String>, icon: &'static str, action: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        MenuEntry { label: label.into(), icon: Some(icon), danger: false, separator: false, action: Some(Rc::new(action)), submenu: None, avatar: None }
    }

    /// A choice with no icon, as in a list of options.
    pub fn plain(label: impl Into<String>, action: Action) -> Self {
        MenuEntry { label: label.into(), icon: None, danger: false, separator: false, action: Some(action), submenu: None, avatar: None }
    }

    pub fn with_avatar(mut self, name: String, seed: String, image: Option<std::sync::Arc<gpui::Image>>) -> Self {
        self.icon = None;
        self.avatar = Some((name, seed, image));
        self
    }

    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    pub fn separator() -> Self {
        MenuEntry { label: String::new(), icon: None, danger: false, separator: true, action: None, submenu: None, avatar: None }
    }

    pub fn submenu(label: impl Into<String>, icon: &'static str, entries: Vec<MenuEntry>) -> Self {
        MenuEntry { label: label.into(), icon: Some(icon), danger: false, separator: false, action: None, submenu: Some(entries), avatar: None }
    }
}

#[derive(Clone)]
struct OpenMenu {
    /// Which opening this is, so each one comes in afresh.
    id: u64,
    position: Point<Pixels>,
    entries: Vec<MenuEntry>,
    /// Quick reactions above the entries, as on a message.
    reactions: Option<(Vec<&'static str>, Rc<dyn Fn(&'static str, &mut Window, &mut App)>)>,
    align_right: bool,
    /// Drawn above the entries each frame, such as a person's volume.
    header: Option<Header>,
    /// Opens upwards from the point, as from a button at the bottom of the window.
    above: bool,
}

pub type Header = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

thread_local! {
    /// A popup a left press outside it just closed: when, and where it had been opened.
    static PRESSED_SHUT: std::cell::Cell<Option<(std::time::Instant, Point<Pixels>)>> = const { std::cell::Cell::new(None) };
}

/// Remembers that a press outside closed a popup opened at this point, if it was a left one.
pub(super) fn closed_by_press(event: &gpui::MouseDownEvent, position: Point<Pixels>) {
    if event.button == MouseButton::Left {
        PRESSED_SHUT.set(Some((std::time::Instant::now(), position)));
    }
}

/// Whether opening a popup here would only open again the one this same click's press just
/// closed. Then the click on what opened it closes it, as the desktop's dropdowns do, rather
/// than opening it anew. A right click's menu is never held back.
pub(super) fn reopens_closed(position: Point<Pixels>) -> bool {
    match PRESSED_SHUT.take() {
        Some((at, was)) => at.elapsed() < std::time::Duration::from_millis(500) && (was.x - position.x).abs() <= px(28.) && (was.y - position.y).abs() <= px(28.),
        None => false,
    }
}

pub struct MenuLayer {
    open: Option<OpenMenu>,
    /// One just closed, fading out over 60 ms as `PopupMenu`'s exit does.
    closing: Option<(OpenMenu, std::time::Instant)>,
    opened: u64,
    /// Held while a menu is open, so Escape closes it, and what had focus before.
    focus: gpui::FocusHandle,
    restore: Option<gpui::FocusHandle>,
}

#[derive(Clone)]
struct MenuGlobal(Entity<MenuLayer>);

impl gpui::Global for MenuGlobal {}

pub fn menu_layer(cx: &mut App) -> Entity<MenuLayer> {
    if let Some(global) = cx.try_global::<MenuGlobal>() {
        return global.0.clone();
    }
    let layer = cx.new(|cx| MenuLayer { open: None, closing: None, opened: 0, focus: cx.focus_handle(), restore: None });
    cx.set_global(MenuGlobal(layer.clone()));
    layer
}

/// Opens a menu at a point in the window.
pub fn open_menu(position: Point<Pixels>, entries: Vec<MenuEntry>, align_right: bool, cx: &mut App) {
    if reopens_closed(position) {
        return;
    }
    let layer = menu_layer(cx);
    layer.update(cx, |layer, cx| {
        layer.opened += 1;
        layer.closing = None;
        layer.open = Some(OpenMenu { id: layer.opened, position, entries, reactions: None, align_right, header: None, above: false });
        cx.notify();
    });
}

/// Opens a menu with something drawn above its entries, upwards from the point if `above`.
pub fn open_menu_with_header(position: Point<Pixels>, header: Option<Header>, entries: Vec<MenuEntry>, above: bool, cx: &mut App) {
    if reopens_closed(position) {
        return;
    }
    let layer = menu_layer(cx);
    layer.update(cx, |layer, cx| {
        layer.opened += 1;
        layer.closing = None;
        layer.open = Some(OpenMenu { id: layer.opened, position, entries, reactions: None, align_right: false, header, above });
        cx.notify();
    });
}

/// Opens a message's menu, with its quick reactions on top.
pub fn open_menu_with_reactions(
    position: Point<Pixels>,
    entries: Vec<MenuEntry>,
    reactions: Vec<&'static str>,
    on_react: impl Fn(&'static str, &mut Window, &mut App) + 'static,
    align_right: bool,
    cx: &mut App,
) {
    if reopens_closed(position) {
        return;
    }
    let layer = menu_layer(cx);
    layer.update(cx, |layer, cx| {
        layer.opened += 1;
        layer.closing = None;
        layer.open = Some(OpenMenu { id: layer.opened, position, entries, reactions: Some((reactions, Rc::new(on_react))), align_right, header: None, above: false });
        cx.notify();
    });
}

/// Whether a menu is open.
pub fn is_open(cx: &App) -> bool {
    cx.try_global::<MenuGlobal>().is_some_and(|global| global.0.read(cx).open.is_some())
}

pub fn close_menu(cx: &mut App) {
    let layer = menu_layer(cx);
    layer.update(cx, |layer, cx| {
        layer.close();
        cx.notify();
    });
}

impl MenuLayer {
    fn close(&mut self) {
        if let Some(open) = self.open.take() {
            if !super::motion::reduced_or_system() {
                self.closing = Some((open, std::time::Instant::now()));
            }
        }
    }
}

const CLOSING: std::time::Duration = std::time::Duration::from_millis(60);

impl Render for MenuLayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.open.is_none() {
            if let Some(previous) = self.restore.take() {
                if self.focus.is_focused(window) {
                    window.focus(&previous, cx);
                }
            }
            return match self.closing.clone() {
                Some((closing, closed)) if closed.elapsed() < CLOSING => {
                    window.request_animation_frame();
                    let left = 1. - closed.elapsed().as_secs_f32() / CLOSING.as_secs_f32();
                    self.draw(&closing, Some(left), window, cx)
                }
                _ => {
                    self.closing = None;
                    div().into_any_element()
                }
            };
        }
        if !self.focus.is_focused(window) && self.restore.is_none() {
            self.restore = window.focused(cx);
            window.focus(&self.focus, cx);
        }
        let Some(open) = self.open.clone() else { return div().into_any_element() };
        self.draw(&open, None, window, cx)
    }
}

impl MenuLayer {
    /// The menu, or one fading out, by how much of it is left.
    fn draw(&mut self, open: &OpenMenu, fading: Option<f32>, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let mut menu = div()
            .id("popup-menu")
            .min_w(px(180.))
            .p(px(4.))
            .bg(theme.bg3)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(RADIUS_L)
            .shadow(shadow_m())
            .flex()
            .flex_col()
            .occlude()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|layer, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    layer.close();
                    cx.notify();
                }
            }))
            .on_mouse_down_out(cx.listener(|layer, event: &gpui::MouseDownEvent, _, cx| {
                if let Some(open) = &layer.open {
                    closed_by_press(event, open.position);
                }
                layer.close();
                cx.notify();
            }));
        if let Some(header) = open.header.clone() {
            menu = menu.child(div().pb(px(4.)).mb(px(4.)).border_b_1().border_color(theme.line).child(header(window, cx)));
        }
        if let Some((reactions, on_react)) = &open.reactions {
            let mut row = div().flex().gap(px(1.)).p(px(1.)).pb(px(5.)).mb(px(4.)).border_b_1().border_color(theme.line);
            for emoji in reactions.iter().copied() {
                let on_react = on_react.clone();
                row = row.child(
                    div()
                        .id(gpui::ElementId::Name(format!("react-{emoji}").into()))
                        .size(px(32.))
                        .rounded(RADIUS_S)
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(18.))
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover_strong))
                        .on_click(cx.listener(move |layer, _, window, cx| {
                            layer.close();
                            cx.notify();
                            on_react(emoji, window, cx);
                        }))
                        .child(emoji),
                );
            }
            menu = menu.child(row);
        }
        for (index, entry) in open.entries.iter().enumerate() {
            if entry.separator {
                menu = menu.child(div().h(px(1.)).bg(theme.line).mx(px(5.)).my(px(4.)));
                continue;
            }
            let color = if entry.danger { theme.red } else { theme.text1 };
            let icon_color = if entry.danger { theme.red } else { theme.text2 };
            let hover = if entry.danger { theme.red_soft } else { theme.hover_strong };
            let entry = entry.clone();
            let mut row = div()
                .id(("menu-item", index))
                .w_full()
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(9.))
                .py(px(6.))
                .rounded(RADIUS_S)
                .text_size(px(13.5))
                .text_color(color)
                .cursor_pointer()
                .hover(move |style| style.bg(hover));
            if let Some(name) = entry.icon {
                row = row.child(icon(name, 15., icon_color));
            }
            if let Some((name, seed, image)) = entry.avatar.clone() {
                row = row.child(avatar(AvatarProps { name, seed, image, size: 20., online: false, rounded: false, dot_border: theme.bg3 }, cx));
            }
            row = row.child(div().flex_1().min_w_0().child(entry.label.clone()));
            if entry.submenu.is_some() {
                row = row.child(icon("chevron-right", 14., theme.text3));
            }
            menu = menu.child(row.on_click(cx.listener(move |layer, _, window, cx| {
                if let Some(submenu) = &entry.submenu {
                    if let Some(open) = &mut layer.open {
                        open.entries = submenu.clone();
                        open.reactions = None;
                    }
                    cx.notify();
                    return;
                }
                layer.close();
                cx.notify();
                if let Some(action) = &entry.action {
                    action(window, cx);
                }
            })));
        }
        let corner = match (open.align_right, open.above) {
            (true, true) => Anchor::BottomRight,
            (false, true) => Anchor::BottomLeft,
            (true, false) => Anchor::TopRight,
            (false, false) => Anchor::TopLeft,
        };
        // As `PopupMenu`: in over 80 ms, out over 60, where it's seen but no longer used.
        let menu = match fading {
            Some(left) => menu.opacity(left).child(div().id("menu-closing").absolute().inset_0().occlude()).into_any_element(),
            None => menu.appear(gpui::ElementId::Name(format!("menu-in-{}", open.id).into()), Enter::Pop, 80).into_any_element(),
        };
        deferred(anchored().position(open.position).anchor(corner).snap_to_window_with_margin(px(8.)).child(menu))
            .with_priority(2)
            .into_any_element()
    }
}

#[allow(dead_code)]
pub fn label(text: &str) -> AnyElement {
    div().font_weight(FontWeight::MEDIUM).child(text.to_string()).into_any_element()
}

#[allow(dead_code)]
pub fn right_click() -> MouseButton {
    MouseButton::Right
}
