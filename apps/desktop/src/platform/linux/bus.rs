//! The session bus, with one connection for what the app says on it: notifications, the
//! badge, and the Settings portal.

use std::sync::OnceLock;

use zbus::blocking::Connection;

/// The session bus, or None without one, as under a bare window manager.
pub fn session() -> Option<&'static Connection> {
    static SESSION: OnceLock<Option<Connection>> = OnceLock::new();
    SESSION
        .get_or_init(|| {
            Connection::session()
                .inspect_err(|error| log::warn!("no session bus: {error}"))
                .ok()
        })
        .as_ref()
}
