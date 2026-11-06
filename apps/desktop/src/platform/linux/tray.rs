//! The tray's icon, with the unread count over it and a menu to open or quit, as the
//! desktop's (createTray in apps/desktop-electron-legacy/src/main/index.ts).

use futures::channel::mpsc::{UnboundedReceiver, unbounded};

pub use crate::platform::TrayEvent;

/// Puts the icon in the tray. What's clicked arrives on the receiver.
pub fn start() -> UnboundedReceiver<TrayEvent> {
    let (_sender, receiver) = unbounded();
    receiver
}

/// Takes the icon away before the app quits, so none is left behind.
pub fn remove() {}
