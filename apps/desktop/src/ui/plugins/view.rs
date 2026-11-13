//! Drawing a plugin's view (plugins/view.rs) with the app's own components, so it looks like
//! Zuna and follows the theme. A handler is the plugin's id for it, which goes back to the
//! plugin through the broker when it's used. Nothing here runs a plugin's code: it only draws
//! what was sent, inside the slot it was sent for.

use std::cell::RefCell;
use std::collections::HashMap;

use gpui::{AnyElement, App, AppContext, Entity, FontWeight, Hsla, IntoElement, ParentElement, Styled, Subscription, div, prelude::*, px};
use serde_json::{Value, json};

use crate::plugins::view::{Align, BoxStyle, Color, Node};
use crate::theme::{self, RADIUS_M, RADIUS_S, Theme};
use crate::ui::components::*;
use crate::ui::text_input::{InputEvent, TextInput};

thread_local! {
    /// The text fields plugins' views hold, by plugin and place, so typing in one survives the
    /// view being sent again.
    static INPUTS: RefCell<HashMap<String, (Entity<TextInput>, Subscription)>> = RefCell::new(HashMap::new());
}

/// The field a plugin's view holds at a place, for the tests.
#[cfg(test)]
pub fn input_of(uid: &str, path: &str) -> Option<Entity<TextInput>> {
    INPUTS.with(|inputs| inputs.borrow().get(&format!("{uid}|{path}")).map(|(input, _)| input.clone()))
}

/// Forgets the fields of a plugin that stopped.
pub fn forget(uid: &str) {
    INPUTS.with(|inputs| inputs.borrow_mut().retain(|key, _| !key.starts_with(&format!("{uid}|"))));
}

fn color_of(color: &Color, theme: &Theme) -> Hsla {
    match color {
        Color::Rgba(rgb, alpha) => {
            let mut rgba = theme::hex(*rgb);
            rgba.a = *alpha;
            theme::color(rgba)
        }
        Color::Token(token) => match token.as_str() {
            "text2" => theme.text2,
            "text3" => theme.text3,
            "accent" => theme.accent,
            "accentText" => theme.accent_text,
            "green" => theme.green,
            "red" => theme.red,
            "amber" => theme.amber,
            "bg1" => theme.bg1,
            "bg2" => theme.bg2,
            "bg3" => theme.bg3,
            _ => theme.text1,
        },
    }
}

/// Sends a handler's use to its plugin.
fn use_handler(uid: &str, id: &str, value: Value, cx: &mut App) {
    if let Some(plugins) = crate::plugins::get(cx) {
        let (uid, id) = (uid.to_string(), id.to_string());
        plugins.update(cx, |plugins, cx| plugins.handler(&uid, id, value, cx));
    }
}

fn styled(el: gpui::Div, style: &BoxStyle, theme: &Theme) -> gpui::Div {
    let mut el = el.gap(px(style.gap)).p(px(style.padding)).min_w_0();
    el = match style.align {
        Some(Align::Start) => el.items_start(),
        Some(Align::Center) => el.items_center(),
        Some(Align::End) => el.items_end(),
        _ => el,
    };
    el = match style.justify {
        Some(Align::Center) => el.justify_center(),
        Some(Align::End) => el.justify_end(),
        Some(Align::Between) => el.justify_between(),
        _ => el,
    };
    if style.grow {
        el = el.flex_1();
    }
    if let Some(background) = &style.background {
        el = el.bg(color_of(background, theme));
    }
    if style.rounded {
        el = el.rounded(RADIUS_M);
    }
    el
}

/// Draws a plugin's view. Only boxes recurse, each through a small function of its own: a frame of
/// the large match below, as an unoptimized build lays it out, is many kilobytes, and a view is
/// drawn on the main thread, whose stack is a megabyte on Windows.
pub fn render(uid: &str, node: &Node, cx: &mut App) -> AnyElement {
    match node {
        Node::Column(style, children) => column(uid, style, children, cx),
        Node::Row(style, wrap, children) => row(uid, style, *wrap, children, cx),
        Node::Stack(style, children) => stack(uid, style, children, cx),
        Node::Scroll(style, height, path, children) => scroll(uid, style, *height, path, children, cx),
        Node::Field { label, hint, children } => field_node(uid, label, hint.as_deref(), children, cx),
        _ => leaf(uid, node, cx),
    }
}

fn children_of(uid: &str, children: &[Node], cx: &mut App) -> Vec<AnyElement> {
    children.iter().map(|child| render(uid, child, cx)).collect()
}

#[inline(never)]
fn column(uid: &str, style: &BoxStyle, children: &[Node], cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let children = children_of(uid, children, cx);
    styled(div().flex().flex_col(), style, &theme).children(children).into_any_element()
}

#[inline(never)]
fn row(uid: &str, style: &BoxStyle, wrap: bool, children: &[Node], cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let children = children_of(uid, children, cx);
    let el = styled(div().flex().flex_row(), style, &theme).when(wrap, |el| el.flex_wrap());
    let el = if style.align.is_none() { el.items_center() } else { el };
    el.children(children).into_any_element()
}

#[inline(never)]
fn stack(uid: &str, style: &BoxStyle, children: &[Node], cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let children: Vec<AnyElement> = children_of(uid, children, cx).into_iter().map(|child| div().absolute().inset_0().child(child).into_any_element()).collect();
    styled(div().relative(), style, &theme).children(children).into_any_element()
}

#[inline(never)]
fn scroll(uid: &str, style: &BoxStyle, height: Option<f32>, path: &str, children: &[Node], cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let children = children_of(uid, children, cx);
    let inner = styled(div().flex().flex_col(), style, &theme).children(children);
    div().id(gpui::ElementId::Name(format!("plugin-{uid}-{path}").into())).overflow_y_scroll().when_some(height, |el, height| el.max_h(px(height))).child(inner).into_any_element()
}

#[inline(never)]
fn field_node(uid: &str, label: &str, hint: Option<&str>, children: &[Node], cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let children = children_of(uid, children, cx);
    let mut el = div().flex().flex_col().gap(px(5.)).child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child(label.to_string())).children(children);
    if let Some(hint) = hint {
        el = el.child(div().text_size(px(12.)).text_color(theme.text3).child(hint.to_string()));
    }
    el.into_any_element()
}

/// Everything that isn't a box: drawn once, never recursing.
#[inline(never)]
fn leaf(uid: &str, node: &Node, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let id = |path: &str| gpui::ElementId::Name(format!("plugin-{uid}-{path}").into());
    match node {
        Node::Column(..) | Node::Row(..) | Node::Stack(..) | Node::Scroll(..) | Node::Field { .. } => render(uid, node, cx),
        Node::Text { text, size, bold, medium, color, mono } => div()
            .text_size(px(*size))
            .text_color(color.as_ref().map(|color| color_of(color, &theme)).unwrap_or(theme.text1))
            .when(bold.is_some(), |el| el.font_weight(FontWeight::BOLD))
            .when(*medium, |el| el.font_weight(FontWeight::MEDIUM))
            .when(*mono, |el| el.font_family(theme::FONT_MONO))
            .child(text.clone())
            .into_any_element(),
        Node::Heading(text) => div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(text.clone()).into_any_element(),
        // Zuna's markup is drawn as its text for now: the chat's own drawing of it is tied to a message.
        Node::Markup(text) => div().text_size(px(14.)).child(crate::markup::plain_text(text)).into_any_element(),
        Node::Button { label, kind, icon: icon_name, disabled, on_click, path } => {
            let kind = match kind.as_str() {
                "primary" => ButtonKind::Primary,
                "danger" => ButtonKind::Danger,
                "ghost" => ButtonKind::Ghost,
                _ => ButtonKind::Default,
            };
            let mut el = button(id(path), kind, ButtonSize::Normal, *disabled, cx);
            if let Some(name) = icon_name {
                el = el.child(icon(name, 15., if kind == ButtonKind::Primary { theme.on_accent } else { theme.text1 }));
            }
            el = el.child(label.clone());
            if let (Some(handler), false) = (on_click.clone(), *disabled) {
                let uid = uid.to_string();
                el = el.on_click(move |_, _, cx| use_handler(&uid, &handler, Value::Null, cx));
            }
            el.into_any_element()
        }
        Node::IconButton { icon: icon_name, title, active, on_click, path } => {
            let mut el = icon_button(id(path), icon_name, 17., false, *active, cx);
            if let Some(handler) = on_click.clone() {
                let uid = uid.to_string();
                el = el.on_click(move |_, _, cx| use_handler(&uid, &handler, Value::Null, cx));
            }
            match title {
                Some(title) => el.tooltip(tooltip(title.clone())).into_any_element(),
                None => el.into_any_element(),
            }
        }
        Node::Switch { value, on_change, path } => {
            let mut el = switch(id(path), *value, cx);
            if let Some(handler) = on_change.clone() {
                let (uid, next) = (uid.to_string(), !*value);
                el = el.on_click(move |_, _, cx| use_handler(&uid, &handler, json!(next), cx));
            }
            el.into_any_element()
        }
        Node::Slider { value, on_change, path } => {
            let (uid, handler) = (uid.to_string(), on_change.clone());
            slider(id(path), *value, move |value, _, cx| {
                if let Some(handler) = &handler {
                    use_handler(&uid, handler, json!(value), cx);
                }
            }, cx)
            .into_any_element()
        }
        Node::Select { value, options, on_change, path } => {
            let label = options.iter().find(|(option, _)| option == value).map(|(_, label)| label.clone()).unwrap_or_else(|| value.clone());
            let choices = options
                .iter()
                .map(|(option, label)| {
                    let (uid, handler, option) = (uid.to_string(), on_change.clone(), option.clone());
                    let action: std::rc::Rc<dyn Fn(&mut gpui::Window, &mut App)> = std::rc::Rc::new(move |_, cx| {
                        if let Some(handler) = &handler {
                            use_handler(&uid, handler, json!(option), cx);
                        }
                    });
                    (label.clone(), action)
                })
                .collect();
            select_box(id(path), label, choices, cx).into_any_element()
        }
        Node::Input { value, placeholder, multiline, masked, on_change, on_submit, path } => {
            let key = format!("{uid}|{path}");
            let input = INPUTS.with(|inputs| inputs.borrow().get(&key).map(|(input, _)| input.clone()));
            let input = match input {
                Some(input) => input,
                None => {
                    let (placeholder, multiline, masked) = (placeholder.clone(), *multiline, *masked);
                    let input = cx.new(|cx| {
                        let input = TextInput::new(cx, placeholder).masked(masked);
                        if multiline { input.multiline() } else { input }
                    });
                    let (owner, change, submit) = (uid.to_string(), on_change.clone(), on_submit.clone());
                    let subscription = cx.subscribe(&input, move |input, event: &InputEvent, cx| {
                        let text = input.read(cx).text().to_string();
                        match event {
                            InputEvent::Changed => {
                                if let Some(handler) = &change {
                                    use_handler(&owner, handler, json!(text), cx);
                                }
                            }
                            InputEvent::Submit => {
                                if let Some(handler) = &submit {
                                    use_handler(&owner, handler, json!(text), cx);
                                }
                            }
                            _ => {}
                        }
                    });
                    INPUTS.with(|inputs| inputs.borrow_mut().insert(key, (input.clone(), subscription)));
                    input
                }
            };
            // What the plugin says the field holds, unless the person is typing in it.
            if let Some(value) = value {
                let (current, focused) = { (input.read(cx).text().to_string(), false) };
                if current != *value && !focused {
                    let value = value.clone();
                    input.update(cx, |input, cx| input.set_text(value, cx));
                }
            }
            div()
                .flex()
                .items_center()
                .bg(theme.bg2)
                .rounded(RADIUS_M)
                .border_1()
                .border_color(theme.line)
                .px(px(11.))
                .when(*multiline, |el| el.py(px(9.)).min_h(px(72.)))
                .when(!*multiline, |el| el.h(px(38.)))
                .text_size(px(14.))
                .child(div().flex_1().min_w_0().child(input))
                .into_any_element()
        }
        Node::Notice { icon: icon_name, tone, text } => {
            let (background, foreground) = match tone.as_str() {
                "warning" => (theme.amber_soft, theme.amber_text),
                "danger" => (theme.red_soft, theme.danger_text),
                _ => (theme.bg2, theme.text2),
            };
            div()
                .flex()
                .gap(px(10.))
                .px(px(12.))
                .py(px(10.))
                .rounded(RADIUS_M)
                .bg(background)
                .text_color(foreground)
                .text_size(px(13.))
                .child(div().flex_none().mt(px(1.)).child(icon(icon_name.as_deref().unwrap_or("info"), 15., foreground)))
                .child(div().flex_1().min_w_0().child(text.clone()))
                .into_any_element()
        }
        Node::Image { src, width, height, rounded } => {
            let image = image_source(uid, src, cx);
            let (width, height) = (width.unwrap_or(120.), height.unwrap_or(120.));
            match image {
                Some(image) => div().size_full().w(px(width)).h(px(height)).child(cover_image(image, width, height, if *rounded { RADIUS_M } else { px(0.) }, cx)).into_any_element(),
                None => div().w(px(width)).h(px(height)).rounded(RADIUS_S).bg(theme.bg3).into_any_element(),
            }
        }
        Node::Avatar { name, seed, size } => avatar(AvatarProps { name: name.clone(), seed: seed.clone(), image: None, size: *size, online: false, rounded: false, dot_border: theme.bg1 }, cx).into_any_element(),
        Node::Icon { name, size, color } => icon(name, *size, color.as_ref().map(|color| color_of(color, &theme)).unwrap_or(theme.text2)).into_any_element(),
        Node::Divider => div().h(px(1.)).w_full().bg(theme.line).into_any_element(),
        Node::Spacer => div().flex_1().into_any_element(),
        Node::Spinner(size) => spinner(*size, theme.text2).into_any_element(),
        Node::Canvas { width, height, shapes } => canvas(shapes.clone(), *width, *height, &theme),
    }
}

/// A picture a view names: one of the plugin's assets, or a data URL. One from a host is drawn
/// as an empty box for now, as the broker doesn't fetch pictures for views yet.
fn image_source(uid: &str, src: &str, cx: &App) -> Option<std::sync::Arc<gpui::Image>> {
    let bytes = if src.starts_with("assets/") {
        let path = src;
        let plugins = crate::plugins::get(cx)?;
        let plugins = plugins.read(cx);
        plugins.loaded.get(uid)?.package.asset(path)?.to_vec()
    } else if let Some(data) = src.strip_prefix("data:") {
        let (_, encoded) = data.split_once(";base64,")?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
        if bytes.len() > 1 << 20 {
            return None;
        }
        bytes
    } else {
        return None;
    };
    let format = crate::state::image_format("", &bytes);
    Some(std::sync::Arc::new(gpui::Image::from_bytes(format, bytes)))
}

/// A canvas: its shapes, drawn freely inside its own box.
fn canvas(shapes: Vec<crate::plugins::view::Shape>, width: f32, height: f32, theme: &Theme) -> AnyElement {
    let theme = *theme;
    gpui::canvas(
        |_, _, _| {},
        move |bounds, _, window, cx| {
            for shape in &shapes {
                let color = shape.color.as_ref().map(|color| color_of(color, &theme)).unwrap_or(theme.text1);
                let at = gpui::point(bounds.origin.x + px(shape.x), bounds.origin.y + px(shape.y));
                match shape.kind.as_str() {
                    "rect" => {
                        let area = gpui::Bounds::new(at, gpui::size(px(shape.width.max(0.)), px(shape.height.max(0.))));
                        let quad = if shape.fill { gpui::fill(area, color) } else { gpui::outline(area, color, gpui::BorderStyle::Solid) };
                        window.paint_quad(quad.corner_radii(px(shape.radius.max(0.))));
                    }
                    "circle" => {
                        let radius = shape.radius.max(0.);
                        let area = gpui::Bounds::new(gpui::point(at.x - px(radius), at.y - px(radius)), gpui::size(px(radius * 2.), px(radius * 2.)));
                        let quad = if shape.fill { gpui::fill(area, color) } else { gpui::outline(area, color, gpui::BorderStyle::Solid) };
                        window.paint_quad(quad.corner_radii(px(radius)));
                    }
                    "line" => {
                        let mut path = gpui::PathBuilder::stroke(px(shape.width.max(1.)));
                        path.move_to(at);
                        path.line_to(gpui::point(bounds.origin.x + px(shape.x2), bounds.origin.y + px(shape.y2)));
                        if let Ok(path) = path.build() {
                            window.paint_path(path, color);
                        }
                    }
                    "text" => {
                        let run = gpui::TextRun { len: shape.text.len(), font: gpui::font(theme::FONT_UI), color, background_color: None, underline: None, strikethrough: None };
                        let line = window.text_system().shape_line(shape.text.clone().into(), px(shape.size), &[run], None);
                        line.paint(at, px(shape.size * 1.3), gpui::TextAlign::Left, None, window, cx).ok();
                    }
                    _ => {}
                }
            }
        },
    )
    .w(px(width))
    .h(px(height))
    .into_any_element()
}
