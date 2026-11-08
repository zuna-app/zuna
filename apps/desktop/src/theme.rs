//! The web's design tokens (packages/ui/src/styles/tokens.css), as GPUI colors.

use gpui::{Hsla, Rgba, px, Pixels};

/// A color from 0xRRGGBB.
pub const fn hex(value: u32) -> Rgba {
    Rgba {
        r: ((value >> 16) & 0xff) as f32 / 255.0,
        g: ((value >> 8) & 0xff) as f32 / 255.0,
        b: (value & 0xff) as f32 / 255.0,
        a: 1.0,
    }
}

/// White or black with this alpha, as the CSS's rgba(255, 255, 255, a).
pub const fn white_a(alpha: f32) -> Rgba {
    Rgba { r: 1.0, g: 1.0, b: 1.0, a: alpha }
}

pub const fn black_a(alpha: f32) -> Rgba {
    Rgba { r: 0.0, g: 0.0, b: 0.0, a: alpha }
}

pub const fn rgba(r: u8, g: u8, b: u8, a: f32) -> Rgba {
    Rgba { r: r as f32 / 255.0, g: g as f32 / 255.0, b: b as f32 / 255.0, a }
}

pub fn color(rgba: Rgba) -> Hsla {
    rgba.into()
}

/// Parses "#rrggbb", as the avatar and name colors are written.
pub fn css(value: &str) -> Hsla {
    let digits = value.trim_start_matches('#');
    u32::from_str_radix(digits, 16).map(|v| color(hex(v))).unwrap_or_else(|_| color(hex(0x5b6b7a)))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accent {
    #[default]
    Neutral,
    Blue,
    Green,
    Red,
    Amber,
}

impl Accent {
    pub const ALL: [Accent; 5] = [Accent::Neutral, Accent::Blue, Accent::Green, Accent::Red, Accent::Amber];

    pub fn label(self) -> &'static str {
        match self {
            Accent::Neutral => "Neutral",
            Accent::Blue => "Blue",
            Accent::Green => "Green",
            Accent::Red => "Red",
            Accent::Amber => "Amber",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextSize {
    Small,
    #[default]
    Medium,
    Large,
}

/// Every color the interface uses, for the accent chosen.
#[derive(Clone, Copy)]
pub struct Theme {
    pub bg0: Hsla,
    pub bg1: Hsla,
    pub bg2: Hsla,
    pub bg3: Hsla,
    pub bg4: Hsla,
    pub bg5: Hsla,
    pub bg_chat: Hsla,
    pub line: Hsla,
    pub line_strong: Hsla,
    pub hover: Hsla,
    pub hover_strong: Hsla,
    pub text1: Hsla,
    pub text2: Hsla,
    pub text3: Hsla,
    pub accent: Hsla,
    pub accent_hover: Hsla,
    pub on_accent: Hsla,
    pub accent_soft: Hsla,
    pub accent_text: Hsla,
    pub bubble_own: Hsla,
    pub bubble_own_text: Hsla,
    pub bubble_own_faint: Hsla,
    pub bubble_other: Hsla,
    pub bubble_meta: Hsla,
    pub link: Hsla,
    pub green: Hsla,
    pub red: Hsla,
    pub red_soft: Hsla,
    pub amber: Hsla,
    pub amber_soft: Hsla,
    pub message_size: Pixels,
    pub neutral: bool,
}

pub const RADIUS_S: Pixels = px(6.);
pub const RADIUS_M: Pixels = px(8.);
pub const RADIUS_L: Pixels = px(12.);
pub const RADIUS_XL: Pixels = px(14.);
pub const TITLEBAR_HEIGHT: Pixels = px(32.);
pub const RAIL_WIDTH: Pixels = px(64.);

pub const FONT_UI: &str = "Inter";
pub const FONT_MONO: &str = "JetBrains Mono";

impl Theme {
    pub fn new(accent: Accent, size: TextSize) -> Theme {
        let mut theme = Theme {
            bg0: color(hex(0x0f0f11)),
            bg1: color(hex(0x151517)),
            bg2: color(hex(0x1b1b1e)),
            bg3: color(hex(0x232326)),
            bg4: color(hex(0x2c2c30)),
            bg5: color(hex(0x38383d)),
            bg_chat: color(hex(0x0f0f11)),
            line: color(white_a(0.07)),
            line_strong: color(white_a(0.13)),
            hover: color(white_a(0.05)),
            hover_strong: color(white_a(0.09)),
            text1: color(hex(0xececee)),
            text2: color(hex(0xa0a0a6)),
            text3: color(hex(0x6e6e75)),
            accent: color(hex(0xececee)),
            accent_hover: color(hex(0xffffff)),
            on_accent: color(hex(0x111113)),
            accent_soft: color(white_a(0.1)),
            accent_text: color(hex(0xececee)),
            bubble_own: color(hex(0x26262a)),
            bubble_own_text: color(hex(0xf2f2f3)),
            bubble_own_faint: color(white_a(0.55)),
            bubble_other: color(hex(0x2f2f33)),
            bubble_meta: color(white_a(0.45)),
            link: color(hex(0x8ab4f8)),
            green: color(hex(0x4cc38a)),
            red: color(hex(0xf2555a)),
            red_soft: color(rgba(242, 85, 90, 0.13)),
            amber: color(hex(0xe5a50a)),
            amber_soft: color(rgba(229, 165, 10, 0.12)),
            message_size: match size {
                TextSize::Small => px(13.5),
                TextSize::Medium => px(14.5),
                TextSize::Large => px(16.),
            },
            neutral: accent == Accent::Neutral,
        };
        let set = |theme: &mut Theme, accent: u32, hover: u32, on: u32, soft: Rgba, text: u32, bubble: u32| {
            theme.accent = color(hex(accent));
            theme.accent_hover = color(hex(hover));
            theme.on_accent = color(hex(on));
            theme.accent_soft = color(soft);
            theme.accent_text = color(hex(text));
            theme.bubble_own = color(hex(bubble));
            theme.bubble_own_text = color(hex(0xffffff));
        };
        match accent {
            Accent::Neutral => {}
            Accent::Blue => set(&mut theme, 0x4b8fe0, 0x5e9de6, 0xffffff, rgba(75, 143, 224, 0.16), 0x7fb0ec, 0x24486f),
            Accent::Green => set(&mut theme, 0x3fa772, 0x4cb780, 0xffffff, rgba(63, 167, 114, 0.16), 0x6cc798, 0x235240),
            Accent::Red => set(&mut theme, 0xd9534f, 0xe2635f, 0xffffff, rgba(217, 83, 79, 0.16), 0xec8784, 0x6a2c2b),
            Accent::Amber => set(&mut theme, 0xd9962a, 0xe3a43f, 0x111113, rgba(217, 150, 42, 0.16), 0xe8b562, 0x5a4318),
        }
        theme
    }

    /// The swatch shown for an accent in Appearance.
    pub fn swatch(accent: Accent) -> Hsla {
        Theme::new(accent, TextSize::Medium).accent
    }
}

impl gpui::Global for Theme {}
