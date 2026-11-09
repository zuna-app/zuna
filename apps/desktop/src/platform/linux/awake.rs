//! Keeping the screen on, as a browser's screen wake lock does: through the Inhibit portal,
//! which KDE's, GNOME's and GTK's portals keep, or where there's none, the screen saver's own
//! `org.freedesktop.ScreenSaver`. Either lets go by itself if the app goes. The calls wait on
//! the bus, so they're made on a thread of their own.

use std::collections::HashMap;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, OnceLock};

use zbus::zvariant::{OwnedObjectPath, Value};

/// What the desktop shows as holding the screen on, as KDE's battery applet does.
const REASON: &str = "Showing a call's video";

/// Asks for the screen not to dim or lock, and the computer not to sleep, while `on`.
pub fn keep_screen_on(on: bool) {
    static WORKER: OnceLock<Mutex<Option<Sender<bool>>>> = OnceLock::new();
    let worker = WORKER.get_or_init(|| {
        let (sender, receiver) = channel::<bool>();
        let started = std::thread::Builder::new().name("screen awake".into()).spawn(move || {
            let mut held = None;
            for on in receiver {
                match (on, held.take()) {
                    (true, None) => held = hold(),
                    (false, Some(inhibit)) => let_go(inhibit),
                    (_, kept) => held = kept,
                }
            }
        });
        Mutex::new(started.ok().map(|_| sender))
    });
    if let Some(sender) = worker.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
        sender.send(on).ok();
    }
}

/// What's holding the screen on, to let go of.
enum Inhibit {
    /// The portal's request, which closing ends.
    Portal(OwnedObjectPath),
    /// The screen saver's cookie.
    ScreenSaver(u32),
}

fn hold() -> Option<Inhibit> {
    let bus = super::bus::session()?;
    // 8 is idle: the session isn't marked idle, so the screen stays on and unlocked.
    let options = HashMap::from([("reason", Value::from(REASON))]);
    let portal = bus
        .call_method(Some("org.freedesktop.portal.Desktop"), "/org/freedesktop/portal/desktop", Some("org.freedesktop.portal.Inhibit"), "Inhibit", &("", 8u32, options))
        .and_then(|reply| reply.body().deserialize::<OwnedObjectPath>());
    match portal {
        Ok(request) => {
            log::info!("the screen is kept on through the Inhibit portal");
            return Some(Inhibit::Portal(request));
        }
        Err(error) => log::info!("no Inhibit portal ({error}), so the screen saver is asked to keep the screen on"),
    }
    let screen_saver = bus
        .call_method(Some("org.freedesktop.ScreenSaver"), "/org/freedesktop/ScreenSaver", Some("org.freedesktop.ScreenSaver"), "Inhibit", &("Zuna", REASON))
        .and_then(|reply| reply.body().deserialize::<u32>());
    match screen_saver {
        Ok(cookie) => {
            log::info!("the screen is kept on through the screen saver");
            Some(Inhibit::ScreenSaver(cookie))
        }
        Err(error) => {
            log::warn!("the screen can't be kept on: {error}");
            None
        }
    }
}

fn let_go(inhibit: Inhibit) {
    let Some(bus) = super::bus::session() else { return };
    let result = match &inhibit {
        Inhibit::Portal(request) => bus.call_method(Some("org.freedesktop.portal.Desktop"), request.as_str(), Some("org.freedesktop.portal.Request"), "Close", &()),
        Inhibit::ScreenSaver(cookie) => bus.call_method(Some("org.freedesktop.ScreenSaver"), "/org/freedesktop/ScreenSaver", Some("org.freedesktop.ScreenSaver"), "UnInhibit", &(*cookie,)),
    };
    match result {
        Ok(_) => log::info!("the screen may sleep again"),
        Err(error) => log::warn!("the screen's inhibition didn't end: {error}"),
    }
}
