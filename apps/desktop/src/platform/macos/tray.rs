//! There's no tray on macOS, as the Electron app had none there: the Dock's icon opens the
//! window and its menu quits. These are the same calls as Windows's and Linux's, doing nothing.

use futures::channel::mpsc::{UnboundedReceiver, unbounded};

pub use crate::platform::TrayEvent;

/// What's clicked, which here is never anything. The sender is kept, so the stream stays open.
pub fn start() -> UnboundedReceiver<TrayEvent> {
    let (events, receiver) = unbounded();
    std::mem::forget(events);
    receiver
}

pub fn remove() {}
