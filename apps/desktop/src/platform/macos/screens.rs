//! What can be shared, for the screen picker. macOS's own picker chooses which screen or
//! window, once Share is pressed, as the Electron app had it choose there, so the app's picker
//! offers one of each kind, as under Wayland, and lists nothing itself: listing would need
//! Screen Recording permission, which content picked in macOS's picker doesn't.

pub use crate::platform::{Source, THUMB_HEIGHT, THUMB_WIDTH};

pub fn screens() -> Vec<Source> {
    vec![Source { id: "portal:screen".into(), name: "Entire screen".into(), screen: true, thumbnail: None }]
}

pub fn windows() -> Vec<Source> {
    vec![Source { id: "portal:window".into(), name: "A window".into(), screen: false, thumbnail: None }]
}
