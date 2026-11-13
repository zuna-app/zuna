//! A plugin's view: the tree it sends, read into nodes the app draws with its own components
//! (ui/plugins/view.rs). What a plugin sends is untrusted, as what arrives decrypted is, so a tree
//! is held to a size: so many nodes, so deep, so much text, and only the nodes and props there are.
//! A node the app doesn't know is left out, never guessed at.

use serde_json::Value;

pub const MAX_NODES: usize = 2000;
pub const MAX_DEPTH: usize = 24;
const MAX_TEXT: usize = 10_000;
const MAX_TOTAL_TEXT: usize = 200_000;
const MAX_SHAPES: usize = 2000;

/// A color: one of the theme's tokens, or the plugin's own.
#[derive(Clone, Debug, PartialEq)]
pub enum Color {
    Token(String),
    Rgba(u32, f32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Align {
    Start,
    Center,
    End,
    Stretch,
    Between,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BoxStyle {
    pub gap: f32,
    pub padding: f32,
    pub align: Option<Align>,
    pub justify: Option<Align>,
    pub grow: bool,
    pub background: Option<Color>,
    pub rounded: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shape {
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub radius: f32,
    pub x2: f32,
    pub y2: f32,
    pub text: String,
    pub size: f32,
    pub color: Option<Color>,
    pub fill: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Column(BoxStyle, Vec<Node>),
    Row(BoxStyle, bool, Vec<Node>),
    Stack(BoxStyle, Vec<Node>),
    Scroll(BoxStyle, Option<f32>, String, Vec<Node>),
    Text { text: String, size: f32, bold: Option<bool>, medium: bool, color: Option<Color>, mono: bool },
    Heading(String),
    Markup(String),
    Button { label: String, kind: String, icon: Option<String>, disabled: bool, on_click: Option<String>, path: String },
    IconButton { icon: String, title: Option<String>, active: bool, on_click: Option<String>, path: String },
    Switch { value: bool, on_change: Option<String>, path: String },
    Slider { value: f32, on_change: Option<String>, path: String },
    Select { value: String, options: Vec<(String, String)>, on_change: Option<String>, path: String },
    Input { value: Option<String>, placeholder: String, multiline: bool, masked: bool, on_change: Option<String>, on_submit: Option<String>, path: String },
    Field { label: String, hint: Option<String>, children: Vec<Node> },
    Notice { icon: Option<String>, tone: String, text: String },
    Image { src: String, width: Option<f32>, height: Option<f32>, rounded: bool },
    Avatar { name: String, seed: String, size: f32 },
    Icon { name: String, size: f32, color: Option<Color> },
    Divider,
    Spacer,
    Spinner(f32),
    Canvas { width: f32, height: f32, shapes: Vec<Shape> },
}

struct Budget {
    nodes: usize,
    text: usize,
}

fn space(value: Option<&Value>) -> f32 {
    match value.and_then(Value::as_str) {
        Some("xs") => 4.,
        Some("s") => 8.,
        Some("m") => 12.,
        Some("l") => 16.,
        Some("xl") => 24.,
        _ => 0.,
    }
}

pub fn color(value: Option<&Value>) -> Option<Color> {
    let text = value?.as_str()?;
    if let Some(digits) = text.strip_prefix('#') {
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        return match digits.len() {
            6 => Some(Color::Rgba(u32::from_str_radix(digits, 16).ok()?, 1.)),
            8 => {
                let all = u32::from_str_radix(digits, 16).ok()?;
                Some(Color::Rgba(all >> 8, (all & 0xff) as f32 / 255.))
            }
            _ => None,
        };
    }
    const TOKENS: [&str; 11] = ["text1", "text2", "text3", "accent", "accentText", "green", "red", "amber", "bg1", "bg2", "bg3"];
    TOKENS.contains(&text).then(|| Color::Token(text.to_string()))
}

fn align(value: Option<&Value>) -> Option<Align> {
    match value?.as_str()? {
        "start" => Some(Align::Start),
        "center" => Some(Align::Center),
        "end" => Some(Align::End),
        "stretch" => Some(Align::Stretch),
        "between" => Some(Align::Between),
        _ => None,
    }
}

fn number(value: Option<&Value>, low: f32, high: f32) -> Option<f32> {
    value.and_then(Value::as_f64).map(|number| (number as f32).clamp(low, high)).filter(|number| number.is_finite())
}

/// A handler's id, as the plugin named it, if it's one.
fn handler(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 400).map(str::to_string)
}

/// An icon's name, if the app carries it.
pub fn icon_name(value: Option<&Value>) -> Option<String> {
    let name = value?.as_str()?;
    crate::assets::has_icon(name).then(|| name.to_string())
}

impl Budget {
    fn text(&mut self, value: &str) -> Result<String, String> {
        let text: String = value.chars().take(MAX_TEXT).collect();
        self.text += text.len();
        if self.text > MAX_TOTAL_TEXT {
            return Err("The view has too much text.".into());
        }
        Ok(text)
    }
}

/// Reads a view, or says why it's refused.
pub fn parse(value: &Value) -> Result<Node, String> {
    let mut budget = Budget { nodes: 0, text: 0 };
    node(value, 0, "0", &mut budget)?.ok_or_else(|| "The view is empty.".to_string())
}

fn text_of(children: &[Value], budget: &mut Budget) -> Result<String, String> {
    let mut text = String::new();
    for child in children {
        if child.get("type").and_then(Value::as_str) == Some("string") {
            if let Some(part) = child.get("props").and_then(|props| props.get("text")).and_then(Value::as_str) {
                text.push_str(part);
            }
        }
    }
    budget.text(&text)
}

fn children(value: &Value, depth: usize, path: &str, budget: &mut Budget) -> Result<Vec<Node>, String> {
    let mut out = Vec::new();
    if let Some(items) = value.get("children").and_then(Value::as_array) {
        for (index, child) in items.iter().enumerate() {
            let key = child.get("props").and_then(|props| props.get("key")).map(|key| match key {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            });
            let child_path = format!("{path}.{}", key.unwrap_or_else(|| index.to_string()));
            if let Some(node) = node(child, depth + 1, &child_path, budget)? {
                out.push(node);
            }
        }
    }
    Ok(out)
}

fn node(value: &Value, depth: usize, path: &str, budget: &mut Budget) -> Result<Option<Node>, String> {
    if depth > MAX_DEPTH {
        return Err("The view is nested too deeply.".into());
    }
    budget.nodes += 1;
    if budget.nodes > MAX_NODES {
        return Err("The view has too many elements.".into());
    }
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let empty = serde_json::Map::new();
    let props = value.get("props").and_then(Value::as_object).unwrap_or(&empty);
    let prop = |name: &str| props.get(name);
    let raw_children: &[Value] = value.get("children").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let style = || BoxStyle {
        gap: space(prop("gap")),
        padding: space(prop("padding")),
        align: align(prop("align")),
        justify: align(prop("justify")),
        grow: prop("grow").and_then(Value::as_bool).unwrap_or(false),
        background: color(prop("background")),
        rounded: prop("rounded").and_then(Value::as_bool).unwrap_or(false),
    };
    let text = |name: &str, budget: &mut Budget| -> Result<String, String> { budget.text(prop(name).and_then(Value::as_str).unwrap_or_default()) };
    let path = path.to_string();
    Ok(Some(match kind {
        "string" => Node::Text { text: text("text", budget)?, size: 14., bold: None, medium: false, color: None, mono: false },
        "column" => Node::Column(style(), children(value, depth, &path, budget)?),
        "row" => Node::Row(style(), prop("wrap").and_then(Value::as_bool).unwrap_or(false), children(value, depth, &path, budget)?),
        "stack" => Node::Stack(style(), children(value, depth, &path, budget)?),
        "scroll" | "list" => Node::Scroll(style(), number(prop("height"), 40., 4000.), path.clone(), children(value, depth, &path, budget)?),
        "text" => Node::Text {
            text: text_of(raw_children, budget)?,
            size: match prop("size").and_then(Value::as_str) {
                Some("s") => 12.5,
                Some("l") => 16.,
                Some("xl") => 22.,
                _ => 14.,
            },
            bold: (prop("weight").and_then(Value::as_str) == Some("bold")).then_some(true),
            medium: prop("weight").and_then(Value::as_str) == Some("medium"),
            color: color(prop("color")),
            mono: prop("mono").and_then(Value::as_bool).unwrap_or(false),
        },
        "heading" => Node::Heading(text_of(raw_children, budget)?),
        "markup" => Node::Markup(text("text", budget)?),
        "button" => Node::Button {
            label: text_of(raw_children, budget)?,
            kind: prop("kind").and_then(Value::as_str).filter(|kind| ["default", "primary", "danger", "ghost"].contains(kind)).unwrap_or("default").to_string(),
            icon: icon_name(prop("icon")),
            disabled: prop("disabled").and_then(Value::as_bool).unwrap_or(false),
            on_click: handler(prop("onClick")),
            path,
        },
        "iconButton" => Node::IconButton {
            icon: icon_name(prop("icon")).unwrap_or_else(|| "circle-question-mark".into()),
            title: prop("title").and_then(Value::as_str).map(|title| title.chars().take(80).collect()),
            active: prop("active").and_then(Value::as_bool).unwrap_or(false),
            on_click: handler(prop("onClick")),
            path,
        },
        "switch" => Node::Switch { value: prop("value").and_then(Value::as_bool).unwrap_or(false), on_change: handler(prop("onChange")), path },
        "slider" => Node::Slider { value: number(prop("value"), 0., 1.).unwrap_or(0.), on_change: handler(prop("onChange")), path },
        "select" => {
            let mut options = Vec::new();
            for option in prop("options").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().take(200) {
                match option {
                    Value::String(text) => options.push((budget.text(text)?, budget.text(text)?)),
                    Value::Object(object) => {
                        let value = object.get("value").and_then(Value::as_str).unwrap_or_default();
                        let label = object.get("label").and_then(Value::as_str).unwrap_or(value);
                        options.push((budget.text(value)?, budget.text(label)?));
                    }
                    _ => {}
                }
            }
            Node::Select { value: text("value", budget)?, options, on_change: handler(prop("onChange")), path }
        }
        "input" => Node::Input {
            value: prop("value").and_then(Value::as_str).map(|value| budget.text(value)).transpose()?,
            placeholder: text("placeholder", budget)?,
            multiline: prop("multiline").and_then(Value::as_bool).unwrap_or(false),
            masked: prop("masked").and_then(Value::as_bool).unwrap_or(false),
            on_change: handler(prop("onChange")),
            on_submit: handler(prop("onSubmit")),
            path,
        },
        "field" => Node::Field { label: text("label", budget)?, hint: prop("hint").and_then(Value::as_str).map(|hint| budget.text(hint)).transpose()?, children: children(value, depth, &path, budget)? },
        "notice" => Node::Notice {
            icon: icon_name(prop("icon")),
            tone: prop("tone").and_then(Value::as_str).filter(|tone| ["info", "warning", "danger"].contains(tone)).unwrap_or("info").to_string(),
            text: text_of(raw_children, budget)?,
        },
        "image" => {
            let src = text("src", budget)?;
            if !(src.starts_with("assets/") || src.starts_with("https://") || src.starts_with("data:image/")) {
                return Ok(None);
            }
            Node::Image { src, width: number(prop("width"), 1., 2000.), height: number(prop("height"), 1., 2000.), rounded: prop("rounded").and_then(Value::as_bool).unwrap_or(false) }
        }
        "avatar" => {
            let name = text("name", budget)?;
            let seed = prop("seed").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| name.clone());
            Node::Avatar { name, seed, size: number(prop("size"), 12., 128.).unwrap_or(32.) }
        }
        "icon" => Node::Icon { name: icon_name(prop("name")).unwrap_or_else(|| "circle-question-mark".into()), size: number(prop("size"), 8., 96.).unwrap_or(16.), color: color(prop("color")) },
        "divider" => Node::Divider,
        "spacer" => Node::Spacer,
        "spinner" => Node::Spinner(number(prop("size"), 8., 64.).unwrap_or(18.)),
        "canvas" => {
            let mut shapes = Vec::new();
            for shape in prop("shapes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
                if shapes.len() >= MAX_SHAPES {
                    return Err("The canvas has too many shapes.".into());
                }
                let get = |name: &str| number(shape.get(name), -10_000., 10_000.).unwrap_or(0.);
                let kind = shape.get("kind").and_then(Value::as_str).unwrap_or_default();
                if !["rect", "circle", "line", "text"].contains(&kind) {
                    continue;
                }
                shapes.push(Shape {
                    kind: kind.to_string(),
                    x: get("x"),
                    y: get("y"),
                    width: get("width"),
                    height: get("height"),
                    radius: get("radius"),
                    x2: get("x2"),
                    y2: get("y2"),
                    text: budget.text(shape.get("text").and_then(Value::as_str).unwrap_or_default())?,
                    size: number(shape.get("size"), 6., 96.).unwrap_or(13.),
                    color: color(shape.get("color")),
                    fill: shape.get("fill").and_then(Value::as_bool).unwrap_or(true),
                });
            }
            Node::Canvas { width: number(prop("width"), 1., 2000.).unwrap_or(200.), height: number(prop("height"), 1., 2000.).unwrap_or(120.), shapes }
        }
        _ => return Ok(None),
    }))
}
