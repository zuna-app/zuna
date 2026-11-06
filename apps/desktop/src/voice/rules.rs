//! What a server's rules allow a screen share, once someone's choices meet them
//! (`screenRefusal` and `screenTerms` in packages/core/src/voice.ts).

use crate::models::ScreenRules;

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

/// What someone has chosen for their shares, with None where they've left it to the server.
pub struct ScreenChoices {
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub kbps: Option<u32>,
    pub sound_kbps: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    Height,
    Fps,
    Kbps,
    SoundKbps,
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
    let wanted_height = choices.height.unwrap_or(rules.default_height);
    // The screen's own size could be any height, so it's only known to fit without a limit.
    let mut height = at_most(Held::Height, wanted_height, rules.max_height);
    let fps = at_most(Held::Fps, choices.fps.unwrap_or(rules.default_fps), rules.max_fps);
    let kbps = at_most(Held::Kbps, choices.kbps.unwrap_or(rules.default_kbps), rules.max_kbps);
    let sound_kbps = at_most(Held::SoundKbps, choices.sound_kbps, rules.max_sound_kbps);
    if wanted_height == 0 && !exempt && rules.max_height > 0 {
        height = rules.max_height;
        held.insert(0, Held::Height);
    }
    ScreenTerms { height, fps, kbps, sound_kbps, sound: rules.sound, held }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_a_share_to_the_server_s_limits() {
        let rules = ScreenRules { max_height: 1080, max_fps: 30, ..ScreenRules::default() };
        let terms = screen_terms(&ScreenChoices { height: None, fps: Some(60), kbps: None, sound_kbps: 128 }, Some(&rules), "member");
        assert_eq!((terms.height, terms.fps, terms.kbps), (1080, 30, 20_000));
        assert!(terms.held.contains(&Held::Height) && terms.held.contains(&Held::Fps));
        let exempt = ScreenRules { admins_exempt: true, ..rules };
        assert_eq!(screen_terms(&ScreenChoices { height: None, fps: Some(60), kbps: None, sound_kbps: 128 }, Some(&exempt), "admin").fps, 60);
        assert_eq!(screen_refusal(Some(&ScreenRules { who: "admins".into(), ..ScreenRules::default() }), "member", 0.), Some("Only admins can share a screen on this server"));
    }
}
