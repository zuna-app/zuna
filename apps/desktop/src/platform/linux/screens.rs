//! What can be shared, for the screen picker. Under Wayland the portal's own dialog says
//! what there is, once Share is pressed, so the app lists nothing itself.

pub use crate::platform::{Source, THUMB_HEIGHT, THUMB_WIDTH};

pub fn screens() -> Vec<Source> {
    Vec::new()
}

pub fn windows() -> Vec<Source> {
    Vec::new()
}
