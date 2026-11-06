//! What the desktop's settings say that the app follows: whether animations are off, from
//! the Settings portal, as Chromium reads it on Linux. Read once and kept current from the
//! portal's signal, so asking costs nothing.

use std::sync::atomic::{AtomicBool, Ordering};

use zbus::blocking::MessageIterator;
use zbus::zvariant::{OwnedValue, Value};
use zbus::MatchRule;

static ANIMATIONS_OFF: AtomicBool = AtomicBool::new(false);

fn set_animations_off(off: bool) {
    if ANIMATIONS_OFF.swap(off, Ordering::Relaxed) != off {
        log::info!("the desktop's animations are {}", if off { "off" } else { "on" });
    }
}

/// Whether the desktop has its animations off: KDE's speed at its slowest end, GNOME's
/// switch turned off.
pub fn animations_off() -> bool {
    ANIMATIONS_OFF.load(Ordering::Relaxed)
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
                        set_animations_off(off);
                    }
                }
            }
            let Ok(rule) = MatchRule::builder().msg_type(zbus::message::Type::Signal).interface("org.freedesktop.portal.Settings").and_then(|rule| rule.member("SettingChanged")).map(|rule| rule.build()) else { return };
            let Ok(signals) = MessageIterator::for_match_rule(rule, bus, Some(16)) else { return };
            for message in signals.flatten() {
                if let Ok((namespace, key, value)) = message.body().deserialize::<(String, String, OwnedValue)>() {
                    if let Some(off) = says_off(&namespace, &key, &value) {
                        set_animations_off(off);
                    }
                }
            }
        })
        .ok();
}
