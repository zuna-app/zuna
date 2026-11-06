//! Popup menus at a point, kept inside the window (PopupMenu in components/ui.tsx).

use std::rc::Rc;

use gpui::{
    AnyElement, App, Context, Corner, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Pixels, Point, Render, Styled, Window, anchored,
    deferred, div, prelude::*, px,
};

use super::components::*;
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

struct OpenMenu {
    position: Point<Pixels>,
    entries: Vec<MenuEntry>,
    /// Quick reactions above the entries, as on a message.
    reactions: Option<(Vec<&'static str>, Rc<dyn Fn(&'static str, &mut Window, &mut App)>)>,
    align_right: bool,
}

pub struct MenuLayer {
    open: Option<OpenMenu>,
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
    let layer = cx.new(|cx| MenuLayer { open: None, focus: cx.focus_handle(), restore: None });
    cx.set_global(MenuGlobal(layer.clone()));
    layer
}

/// Opens a menu at a point in the window.
pub fn open_menu(position: Point<Pixels>, entries: Vec<MenuEntry>, align_right: bool, cx: &mut App) {
    let layer = menu_layer(cx);
    layer.update(cx, |layer, cx| {
        layer.open = Some(OpenMenu { position, entries, reactions: None, align_right });
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
    let layer = menu_layer(cx);
    layer.update(cx, |layer, cx| {
        layer.open = Some(OpenMenu { position, entries, reactions: Some((reactions, Rc::new(on_react))), align_right });
        cx.notify();
    });
}

pub fn close_menu(cx: &mut App) {
    let layer = menu_layer(cx);
    layer.update(cx, |layer, cx| {
        layer.open = None;
        cx.notify();
    });
}

impl Render for MenuLayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.open.is_none() {
            if let Some(previous) = self.restore.take() {
                if self.focus.is_focused(window) {
                    window.focus(&previous);
                }
            }
            return div().into_any_element();
        }
        if !self.focus.is_focused(window) && self.restore.is_none() {
            self.restore = window.focused(cx);
            window.focus(&self.focus);
        }
        let Some(open) = &self.open else { return div().into_any_element() };
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
                    layer.open = None;
                    cx.notify();
                }
            }))
            .on_mouse_down_out(cx.listener(|layer, _, _, cx| {
                layer.open = None;
                cx.notify();
            }));
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
                            layer.open = None;
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
                layer.open = None;
                cx.notify();
                if let Some(action) = &entry.action {
                    action(window, cx);
                }
            })));
        }
        let corner = if open.align_right { Corner::TopRight } else { Corner::TopLeft };
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
