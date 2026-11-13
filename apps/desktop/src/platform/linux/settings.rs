//! What the desktop's settings say that the app follows: whether animations are off, from
//! the Settings portal, as Chromium reads it on Linux. Read once and kept current from the
//! portal's signal, so asking costs nothing.

use std::sync::atomic::{AtomicBool, Ordering};

use zbus::blocking::MessageIterator;
use zbus::zvariant::{OwnedValue, Value};
use zbus::MatchRule;

/// Whether KDE's setting, and GNOME's, has animations off. Either can, as a portal answers
/// the other desktop's key with its default.
struct Animations {
    kde_off: AtomicBool,
    gnome_off: AtomicBool,
}

impl Animations {
    const fn new() -> Self {
        Animations { kde_off: AtomicBool::new(false), gnome_off: AtomicBool::new(false) }
    }

    fn set(&self, namespace: &str, off: bool) {
        let before = self.off();
        if namespace.starts_with("org.kde") { &self.kde_off } else { &self.gnome_off }.store(off, Ordering::Relaxed);
        if self.off() != before {
            log::info!("the desktop's animations are {}", if self.off() { "off" } else { "on" });
        }
    }

    fn off(&self) -> bool {
        self.kde_off.load(Ordering::Relaxed) || self.gnome_off.load(Ordering::Relaxed)
    }
}

static ANIMATIONS: Animations = Animations::new();

fn set_animations_off(namespace: &str, off: bool) {
    ANIMATIONS.set(namespace, off);
}

/// Whether the desktop has its animations off: KDE's speed at its slowest end, GNOME's
/// switch turned off.
pub fn animations_off() -> bool {
    ANIMATIONS.off()
}

/// What a setting's value says about animations, if it's one about them.
fn says_off(namespace: &str, key: &str, value: &Value) -> Option<bool> {
    let value = match value {
        Value::Value(inner) => inner.as_ref(),
        other => other,
    };
    match (namespace, key) {
        ("org.kde.kdeglobals.KDE", "AnimationDurationFactor") => {
            let factor = match value {
                Value::F64(factor) => *factor,
                Value::Str(text) => text.parse().ok()?,
                _ => return None,
            };
            Some(factor <= 0.)
        }
        ("org.gnome.desktop.interface", "enable-animations") => match value {
            Value::Bool(on) => Some(!on),
            _ => None,
        },
        _ => None,
    }
}

pub fn start() {
    std::thread::Builder::new()
        .name("zuna-settings".into())
        .spawn(|| {
            let Some(bus) = super::bus::session() else { return };
            for (namespace, key) in [("org.kde.kdeglobals.KDE", "AnimationDurationFactor"), ("org.gnome.desktop.interface", "enable-animations")] {
                let reply = bus.call_method(Some("org.freedesktop.portal.Desktop"), "/org/freedesktop/portal/desktop", Some("org.freedesktop.portal.Settings"), "ReadOne", &(namespace, key));
                if let Ok(value) = reply.and_then(|reply| reply.body().deserialize::<OwnedValue>()) {
                    if let Some(off) = says_off(namespace, key, &value) {
                        set_animations_off(namespace, off);
                    }
                }
            }
            let Ok(rule) = MatchRule::builder().msg_type(zbus::message::Type::Signal).interface("org.freedesktop.portal.Settings").and_then(|rule| rule.member("SettingChanged")).map(|rule| rule.build()) else { return };
            let Ok(signals) = MessageIterator::for_match_rule(rule, bus, Some(16)) else { return };
            for message in signals.flatten() {
                if let Ok((namespace, key, value)) = message.body().deserialize::<(String, String, OwnedValue)>() {
                    if let Some(off) = says_off(&namespace, &key, &value) {
                        set_animations_off(&namespace, off);
                    }
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    const KDE: (&str, &str) = ("org.kde.kdeglobals.KDE", "AnimationDurationFactor");
    const GNOME: (&str, &str) = ("org.gnome.desktop.interface", "enable-animations");

    fn says((namespace, key): (&str, &str), value: Value) -> Option<bool> {
        says_off(namespace, key, &value)
    }

    #[test]
    fn reads_kdes_animation_speed() {
        assert_eq!(says(KDE, Value::F64(0.)), Some(true));
        assert_eq!(says(KDE, Value::F64(-1.)), Some(true));
        assert_eq!(says(KDE, Value::F64(1.)), Some(false));
        assert_eq!(says(KDE, Value::F64(0.25)), Some(false));
        assert_eq!(says(KDE, Value::from("0")), Some(true));
        assert_eq!(says(KDE, Value::from("1.5")), Some(false));
        assert_eq!(says(KDE, Value::from("abc")), None);
        assert_eq!(says(KDE, Value::Bool(false)), None);
        // As the portal's ReadOne wraps it.
        assert_eq!(says(KDE, Value::Value(Box::new(Value::F64(0.)))), Some(true));
        assert_eq!(says(KDE, Value::Value(Box::new(Value::from("1")))), Some(false));
    }

    #[test]
    fn reads_gnomes_animation_switch() {
        assert_eq!(says(GNOME, Value::Bool(false)), Some(true));
        assert_eq!(says(GNOME, Value::Bool(true)), Some(false));
        assert_eq!(says(GNOME, Value::Value(Box::new(Value::Bool(false)))), Some(true));
        assert_eq!(says(GNOME, Value::from("false")), None);
        assert_eq!(says(GNOME, Value::F64(0.)), None);
    }

    #[test]
    fn ignores_every_other_setting() {
        assert_eq!(says(("org.kde.kdeglobals.KDE", "SingleClick"), Value::F64(0.)), None);
        assert_eq!(says(("org.gnome.desktop.interface", "color-scheme"), Value::Bool(false)), None);
        assert_eq!(says(("org.freedesktop.appearance", "AnimationDurationFactor"), Value::F64(0.)), None);
        assert_eq!(says(("org.kde.kdeglobals.KDE", "enable-animations"), Value::Bool(false)), None);
    }

    #[test]
    fn has_animations_off_while_either_desktop_says_so() {
        // Its own, as the app's are read by other tests.
        let animations = Animations::new();
        assert!(!animations.off());
        animations.set(KDE.0, true);
        assert!(animations.off());
        animations.set(GNOME.0, true);
        animations.set(KDE.0, false);
        assert!(animations.off(), "GNOME's still is");
        animations.set(GNOME.0, false);
        assert!(!animations.off());
        // A namespace that isn't KDE's counts as GNOME's.
        animations.set("org.freedesktop.appearance", true);
        assert!(animations.gnome_off.load(Ordering::Relaxed) && !animations.kde_off.load(Ordering::Relaxed));
    }
}
