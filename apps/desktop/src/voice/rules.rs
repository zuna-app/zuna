//! What a server's rules allow a screen share, once someone's choices meet them
//! (`screenRefusal` and `screenTerms` in packages/core/src/voice.ts).

use crate::models::ScreenRules;

/// What a share sends, at most, when it's left to the app (`SCREEN_AUTO_KBPS`).
pub const SCREEN_AUTO_KBPS: u32 = 20_000;
/// A share's frame rate unless someone chooses another (`SCREEN_DEFAULT_FPS`).
pub const SCREEN_DEFAULT_FPS: u32 = 60;
/// What a share's sound sends (`SCREEN_SOUND_KBPS`).
pub const SCREEN_SOUND_KBPS: u32 = 128;

/// Why someone can't share a screen at all right now, or None if they may try.
pub fn screen_refusal(rules: Option<&ScreenRules>, role: &str, channel_limit: f64) -> Option<&'static str> {
    let defaults = ScreenRules::default();
    let rules = rules.unwrap_or(&defaults);
    if rules.who == "nobody" {
        return Some("Screen sharing is off on this server");
    }
    if rules.who == "admins" && role != "owner" && role != "admin" {
        return Some("Only admins can share a screen on this server");
    }
    if channel_limit < 0. {
        return Some("Screen sharing is off in this voice channel");
    }
    None
}

/// What someone has chosen for their shares.
pub struct ScreenChoices {
    /// The tallest the picture may be, or 0 for the screen's own.
    pub height: u32,
    pub fps: u32,
    /// The most it may send, or None to leave it to the app.
    pub kbps: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    Height,
    Fps,
    Kbps,
}

/// What a share will really use, once what someone chose has met what their server allows.
#[derive(Clone, Debug)]
pub struct ScreenTerms {
    /// The tallest the picture may be, or 0 for the screen's own.
    pub height: u32,
    pub fps: u32,
    pub kbps: u32,
    pub sound_kbps: u32,
    /// Sound may go with it.
    pub sound: bool,
    /// Which of those the server's limits brought down.
    pub held: Vec<Held>,
}

/// What a share sends at most when it's left to the app: whichever is lower of the app's own
/// ceiling and the server's limit, which nobody chose to go past.
pub fn automatic_kbps(rules: Option<&ScreenRules>, role: &str) -> u32 {
    let defaults = ScreenRules::default();
    let rules = rules.unwrap_or(&defaults);
    let exempt = rules.admins_exempt && (role == "owner" || role == "admin");
    if exempt || rules.max_kbps == 0 { SCREEN_AUTO_KBPS } else { rules.max_kbps.min(SCREEN_AUTO_KBPS) }
}

pub fn screen_terms(choices: &ScreenChoices, rules: Option<&ScreenRules>, role: &str) -> ScreenTerms {
    let defaults = ScreenRules::default();
    let rules = rules.unwrap_or(&defaults);
    let exempt = rules.admins_exempt && (role == "owner" || role == "admin");
    let mut held = Vec::new();
    let mut at_most = |name: Held, wanted: u32, limit: u32| -> u32 {
        if exempt || limit == 0 || wanted <= limit {
            return wanted;
        }
        held.push(name);
        limit
    };
    // The screen's own size could be any height, so it's only known to fit without a limit.
    let mut height = at_most(Held::Height, choices.height, rules.max_height);
    let fps = at_most(Held::Fps, choices.fps, rules.max_fps);
    let kbps = match choices.kbps {
        Some(kbps) => at_most(Held::Kbps, kbps, rules.max_kbps),
        None => automatic_kbps(Some(rules), role),
    };
    if choices.height == 0 && !exempt && rules.max_height > 0 {
        height = rules.max_height;
        held.insert(0, Held::Height);
    }
    ScreenTerms { height, fps, kbps, sound_kbps: SCREEN_SOUND_KBPS, sound: rules.sound, held }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_a_share_to_the_server_s_limits() {
        let rules = ScreenRules { max_height: 1080, max_fps: 30, max_kbps: 8_000, ..ScreenRules::default() };
        let terms = screen_terms(&ScreenChoices { height: 0, fps: 60, kbps: Some(12_000) }, Some(&rules), "member");
        assert_eq!((terms.height, terms.fps, terms.kbps), (1080, 30, 8_000));
        assert_eq!(terms.held, vec![Held::Height, Held::Fps, Held::Kbps]);
        let exempt = ScreenRules { admins_exempt: true, ..rules.clone() };
        let theirs = screen_terms(&ScreenChoices { height: 0, fps: 60, kbps: None }, Some(&exempt), "admin");
        assert_eq!((theirs.height, theirs.fps, theirs.kbps), (0, 60, SCREEN_AUTO_KBPS));
        assert!(theirs.held.is_empty());
        assert_eq!(screen_refusal(Some(&ScreenRules { who: "admins".into(), ..ScreenRules::default() }), "member", 0.), Some("Only admins can share a screen on this server"));
    }

    #[test]
    fn leaves_the_bitrate_to_the_app_within_the_limit() {
        let free = screen_terms(&ScreenChoices { height: 0, fps: SCREEN_DEFAULT_FPS, kbps: None }, None, "member");
        assert_eq!((free.kbps, free.sound_kbps), (SCREEN_AUTO_KBPS, SCREEN_SOUND_KBPS));
        assert!(free.held.is_empty());
        let low = ScreenRules { max_kbps: 6_000, ..ScreenRules::default() };
        assert_eq!(screen_terms(&ScreenChoices { height: 0, fps: 60, kbps: None }, Some(&low), "member").kbps, 6_000);
        let high = ScreenRules { max_kbps: 50_000, ..ScreenRules::default() };
        assert_eq!(screen_terms(&ScreenChoices { height: 0, fps: 60, kbps: None }, Some(&high), "member").kbps, SCREEN_AUTO_KBPS);
    }
}
