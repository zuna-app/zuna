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
    /// A warning's words on amber_soft, and a danger's on red_soft (`.notice` in base.css).
    pub amber_text: Hsla,
    pub danger_text: Hsla,
    /// Discord's quieter gray, for times and hints in a channel, and the line from a reply to
    /// what it answers (`--channel-muted` and `--spine` in channel.css).
    pub channel_muted: Hsla,
    pub spine: Hsla,
    /// bg5 under the pointer, as `.to-bottom:hover`.
    pub bg5_hover: Hsla,
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
            amber_text: color(hex(0xe8d3a2)),
            danger_text: color(hex(0xf4bcbe)),
            channel_muted: color(hex(0x8b8b92)),
            spine: color(hex(0x505057)),
            bg5_hover: color(hex(0x45454b)),
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

    /// A plugin's theme over these colors: each token it names, as `#rrggbb` or `#rrggbbaa`
    /// (plugins/manifest.rs checks them), in the SDK's camelCase names.
    pub fn apply(&mut self, colors: &std::collections::BTreeMap<String, String>) {
        for (token, value) in colors {
            let digits = value.trim_start_matches('#');
            let Ok(all) = u32::from_str_radix(digits, 16) else { continue };
            let rgba = match digits.len() {
                6 => hex(all),
                8 => Rgba { a: (all & 0xff) as f32 / 255.0, ..hex(all >> 8) },
                _ => continue,
            };
            let slot = match token.as_str() {
                "bg0" => &mut self.bg0,
                "bg1" => &mut self.bg1,
                "bg2" => &mut self.bg2,
                "bg3" => &mut self.bg3,
                "bg4" => &mut self.bg4,
                "bg5" => &mut self.bg5,
                "bgChat" => &mut self.bg_chat,
                "line" => &mut self.line,
                "lineStrong" => &mut self.line_strong,
                "hover" => &mut self.hover,
                "hoverStrong" => &mut self.hover_strong,
                "text1" => &mut self.text1,
                "text2" => &mut self.text2,
                "text3" => &mut self.text3,
                "accent" => &mut self.accent,
                "accentHover" => &mut self.accent_hover,
                "onAccent" => &mut self.on_accent,
                "accentSoft" => &mut self.accent_soft,
                "accentText" => &mut self.accent_text,
                "bubbleOwn" => &mut self.bubble_own,
                "bubbleOwnText" => &mut self.bubble_own_text,
                "bubbleOther" => &mut self.bubble_other,
                "bubbleMeta" => &mut self.bubble_meta,
                "link" => &mut self.link,
                "green" => &mut self.green,
                "red" => &mut self.red,
                "amber" => &mut self.amber,
                _ => continue,
            };
            *slot = color(rgba);
        }
        // What's drawn over the danger color, and the pale backgrounds beside the colors, follow them.
        self.red_soft = Hsla { a: 0.13, ..self.red };
        self.amber_soft = Hsla { a: 0.12, ..self.amber };
        if colors.contains_key("accent") {
            self.neutral = false;
        }
    }

    /// The swatch shown for an accent in Appearance.
    pub fn swatch(accent: Accent) -> Hsla {
        Theme::new(accent, TextSize::Medium).accent
    }
}

impl gpui::Global for Theme {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn the_text_size_is_how_large_messages_are() {
        let [small, medium, large] = [TextSize::Small, TextSize::Medium, TextSize::Large].map(|size| Theme::new(Accent::Blue, size).message_size);
        assert!(small < medium && medium < large);
    }

    #[test]
    fn a_plugins_theme_sets_every_token_it_names() {
        let tokens = [
            "bg0", "bg1", "bg2", "bg3", "bg4", "bg5", "bgChat", "line", "lineStrong", "hover", "hoverStrong", "text1", "text2", "text3", "accent", "accentHover", "onAccent",
            "accentSoft", "accentText", "bubbleOwn", "bubbleOwnText", "bubbleOther", "bubbleMeta", "link", "green", "red", "amber",
        ];
        let mut theme = Theme::new(Accent::Neutral, TextSize::Medium);
        theme.apply(&tokens.iter().map(|token| (token.to_string(), "#102030".to_string())).collect());
        let set = color(hex(0x102030));
        let t = theme;
        let read = [
            t.bg0, t.bg1, t.bg2, t.bg3, t.bg4, t.bg5, t.bg_chat, t.line, t.line_strong, t.hover, t.hover_strong, t.text1, t.text2, t.text3, t.accent, t.accent_hover, t.on_accent,
            t.accent_soft, t.accent_text, t.bubble_own, t.bubble_own_text, t.bubble_other, t.bubble_meta, t.link, t.green, t.red, t.amber,
        ];
        for (token, value) in tokens.iter().zip(read) {
            assert_eq!(value, set, "{token} wasn't set");
        }
        // The pale backgrounds follow the colors they're beside, and an accent of its own isn't neutral.
        assert_eq!(theme.red_soft, Hsla { a: 0.13, ..set });
        assert_eq!(theme.amber_soft, Hsla { a: 0.12, ..set });
        assert!(!theme.neutral);
    }

    #[test]
    fn a_plugins_theme_takes_an_alpha_and_passes_over_what_it_cant_read() {
        let before = Theme::new(Accent::Neutral, TextSize::Medium);
        let mut theme = before;
        theme.apply(&BTreeMap::from([
            ("bg0".to_string(), "#10203080".to_string()),
            ("bg1".to_string(), "#zzzzzz".to_string()),
            ("bg2".to_string(), "#1234".to_string()),
            ("nothing".to_string(), "#ffffff".to_string()),
        ]));
        assert_eq!(theme.bg0, color(Rgba { a: 128. / 255., ..hex(0x102030) }));
        assert_eq!((theme.bg1, theme.bg2), (before.bg1, before.bg2));
        assert!(theme.neutral, "a theme without an accent of its own made the neutral accent a color");
    }
}
