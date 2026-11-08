//! What can be shared, for the screen picker. Under Wayland the portal's own dialog picks,
//! once Share is pressed, so the picker offers one of each kind the portal shares, as the
//! Electron app's `portalSources` did, and lists nothing itself.

use zbus::zvariant::OwnedValue;

pub use crate::platform::{Source, THUMB_HEIGHT, THUMB_WIDTH};

/// The kinds the ScreenCast portal shares: 1 for screens, 2 for windows. None without a portal.
fn shared_kinds() -> u32 {
    // The app's one session bus, not a new connection each time the picker asks.
    let Some(bus) = super::bus::session() else { return 0 };
    bus.call_method(Some("org.freedesktop.portal.Desktop"), "/org/freedesktop/portal/desktop", Some("org.freedesktop.DBus.Properties"), "Get", &("org.freedesktop.portal.ScreenCast", "AvailableSourceTypes"))
        .ok()
        .and_then(|reply| reply.body().deserialize::<OwnedValue>().ok())
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0)
}

pub fn screens() -> Vec<Source> {
    if shared_kinds() & 1 == 0 {
        return Vec::new();
    }
    vec![Source { id: "portal:screen".into(), name: "Entire screen".into(), screen: true, thumbnail: None }]
}

pub fn windows() -> Vec<Source> {
    if shared_kinds() & 2 == 0 {
        return Vec::new();
    }
    vec![Source { id: "portal:window".into(), name: "A window".into(), screen: false, thumbnail: None }]
}
