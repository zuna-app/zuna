//! What the app asks of Linux itself, under Wayland, with the same functions as Windows's:
//! the main window, the tray, the unread count, idle time, the notification sound, and
//! whether the system wants quiet.

mod awake;
mod bus;
mod desktop_entry;
mod frame;
pub mod icons;
mod idle;
pub mod location;
pub mod notifications;
pub mod ptt;
pub mod screens;
mod settings;
mod sound;
pub mod tray;
pub mod updates;
pub mod watch_view;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{AnyWindowHandle, App, AsyncApp};

pub use awake::keep_screen_on;
pub use frame::{own_frame, title_button, title_drag, window_frame};
pub use idle::{idle_known, idle_ms};
pub use settings::animations_off;
pub use sound::play_notification_sound;

/// What's asked of the main window from outside an update, done on the next one.
enum Command {
    Show,
    Hide,
    Flash,
}

static MAIN: Mutex<Option<AnyWindowHandle>> = Mutex::new(None);
static COMMANDS: OnceLock<UnboundedSender<Command>> = OnceLock::new();

/// Whether the main window is minimized by the app itself, until it's active again. Wayland
/// doesn't tell a window it's minimized, so this is all there is to know.
struct Minimized {
    minimized: AtomicBool,
    /// Whether the window, once minimized, has been away from the front, so that being active
    /// again means it was brought back.
    away: AtomicBool,
}

impl Minimized {
    const fn new() -> Self {
        Minimized { minimized: AtomicBool::new(false), away: AtomicBool::new(false) }
    }

    fn minimized(&self) {
        self.away.store(false, Ordering::Relaxed);
        self.minimized.store(true, Ordering::Relaxed);
    }

    fn shown(&self) {
        self.minimized.store(false, Ordering::Relaxed);
    }

    fn activation(&self, active: bool) {
        if !self.minimized.load(Ordering::Relaxed) {
            return;
        }
        if !active {
            self.away.store(true, Ordering::Relaxed);
        } else if self.away.load(Ordering::Relaxed) {
            self.minimized.store(false, Ordering::Relaxed);
        }
    }

    fn visible(&self) -> bool {
        !self.minimized.load(Ordering::Relaxed)
    }
}

static MINIMIZED: Minimized = Minimized::new();

/// The main window became active or stopped being, as GPUI says: one the app minimized is
/// visible again once it's been away and then active, from the taskbar or anywhere.
pub fn main_activation(active: bool) {
    MINIMIZED.activation(active);
}
/// The latest activation token handed over, by a second start, the tray or a notification,
/// which the next showing of the window uses: Wayland only lets a window come to the front
/// with one.
static ACTIVATION_TOKEN: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn set_activation_token(token: String) {
    *ACTIVATION_TOKEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(token);
}

pub(super) fn take_activation_token() -> Option<String> {
    ACTIVATION_TOKEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
}

/// Starts what acts on the main window for the functions below, which aren't given a context,
/// and what listens to the desktop: idle time and its settings.
pub fn install(cx: &mut App) {
    let (sender, mut receiver) = unbounded();
    if COMMANDS.set(sender).is_err() {
        return;
    }
    // What the launcher gave this start, for its window.
    if let Ok(token) = std::env::var("XDG_ACTIVATION_TOKEN") {
        set_activation_token(token);
    }
    idle::start();
    settings::start();
    desktop_entry::keep();
    cx.spawn(async move |cx| {
        while let Some(command) = receiver.next().await {
            run(command, cx).await;
        }
    })
    .detach();
}

fn main_window() -> Option<AnyWindowHandle> {
    *MAIN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn run(command: Command, cx: &mut AsyncApp) {
    let Some(handle) = main_window() else { return };
    match command {
        Command::Show => {
            MINIMIZED.shown();
            let token = take_activation_token();
            if token.is_some() {
                log::info!("showing the window with an activation token");
            }
            handle
                .update(cx, |_, window, _| match &token {
                    Some(token) => window.activate_window_with_token(token),
                    None => window.activate_window(),
                })
                .ok();
        }
        // Asking for activation without a token is refused, which KWin shows as wanting attention.
        Command::Flash => {
            handle.update(cx, |_, window, _| window.activate_window()).ok();
        }
        Command::Hide => {
            // Minimizing only keeps the app running in the tray where there's a tray, and a
            // compositor that minimizes, as Sway doesn't. Otherwise closing quits.
            let can_minimize = handle.update(cx, |_, window, _| window.window_controls().minimize).unwrap_or(false);
            if !can_minimize || !tray::available() {
                cx.update(|cx| cx.dispatch_action(&crate::Quit));
                return;
            }
            let minimized = handle.update(cx, |_, window, _| window.minimize_window()).is_ok();
            if !minimized {
                return;
            }
            // Visible again once it's been away and then active, which main_activation hears from
            // the window's activation, rather than asking it four times a second.
            MINIMIZED.minimized();
        }
    }
}

fn send(command: Command) {
    if let Some(commands) = COMMANDS.get() {
        commands.unbounded_send(command).ok();
    }
}

/// The app's main window, which the tray, notifications and the badge act on. It comes to
/// the front with the token the launcher gave, if there was one.
pub fn set_main_window(window: &gpui::Window) {
    *MAIN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(window.window_handle());
    if ACTIVATION_TOKEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some() {
        send(Command::Show);
    }
}

pub fn main_visible() -> bool {
    MINIMIZED.visible()
}

/// Out of sight but still running. GPUI can't hide a window on Linux, so it's minimized.
pub fn hide_main() {
    send(Command::Hide);
}

/// In front, restored if it was minimized.
pub fn show_main() {
    send(Command::Show);
}

/// Asks the person to look at the window, as for a new message.
pub fn flash_main() {
    send(Command::Flash);
}

/// What the system wants right now. The notification server holds notifications back itself,
/// so they always go to it, and only the app's own sound asks whether it's quiet.
pub fn notification_state() -> super::NotificationState {
    super::NotificationState { show: true, sound: !notifications::inhibited(), wait_for_input: true }
}

/// Whether there's a Wayland session to open the window in.
pub fn wayland_session() -> bool {
    wayland_display(std::env::var_os("WAYLAND_DISPLAY"))
}

fn wayland_display(display: Option<std::ffi::OsString>) -> bool {
    display.is_some_and(|display| !display.is_empty())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Held by each test that hands over an activation token, which the app keeps one of.
    pub(crate) static TOKEN: Mutex<()> = Mutex::new(());

    #[test]
    fn uses_an_activation_token_once_and_the_latest() {
        let _held = TOKEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take_activation_token();
        assert_eq!(take_activation_token(), None);
        set_activation_token("first".into());
        set_activation_token("second".into());
        assert_eq!(take_activation_token().as_deref(), Some("second"));
        assert_eq!(take_activation_token(), None);
    }

    #[test]
    fn is_visible_again_once_it_was_away_and_then_active() {
        // Its own, as the app's is read by other tests.
        let window = Minimized::new();
        assert!(window.visible());
        // Activation changes nothing until the app minimizes it.
        window.activation(false);
        window.activation(true);
        assert!(window.visible());

        window.minimized();
        assert!(!window.visible());
        // Still active as it goes down, which isn't coming back.
        window.activation(true);
        assert!(!window.visible());
        window.activation(false);
        assert!(!window.visible());
        window.activation(true);
        assert!(window.visible());

        // Minimized again, it has to be away again first.
        window.minimized();
        window.activation(true);
        assert!(!window.visible());
        window.shown();
        assert!(window.visible());
    }

    #[test]
    fn needs_a_wayland_display_named() {
        assert!(wayland_display(Some("wayland-0".into())));
        assert!(!wayland_display(Some("".into())));
        assert!(!wayland_display(None));
    }
}
