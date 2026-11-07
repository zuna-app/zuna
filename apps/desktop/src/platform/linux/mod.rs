//! What the app asks of Linux itself, under Wayland, with the same functions as Windows's:
//! the main window, the tray, the unread count, idle time, the notification sound, and
//! whether the system wants quiet. The Electron app gets these from Electron.

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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{AnyWindowHandle, App, AsyncApp};

pub use frame::{own_frame, title_button, title_drag, window_frame};
pub use idle::idle_ms;
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
/// Minimized by the app itself, until the window is active again. Wayland doesn't tell a
/// window it's minimized, so this is all there is to know.
static MINIMIZED: AtomicBool = AtomicBool::new(false);
/// The latest activation token handed over, by a second start, the tray or a notification,
/// which the next showing of the window uses: Wayland only lets a window come to the front
/// with one.
static ACTIVATION_TOKEN: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn set_activation_token(token: String) {
    *ACTIVATION_TOKEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(token);
}

fn take_activation_token() -> Option<String> {
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
            MINIMIZED.store(false, Ordering::Relaxed);
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
            MINIMIZED.store(true, Ordering::Relaxed);
            // Visible again once it's been away and then active, from the taskbar or anywhere,
            // watched apart, so what's asked meanwhile, as showing it, isn't held up.
            cx.spawn(async move |cx| {
                let mut away = false;
                loop {
                    cx.background_executor().timer(Duration::from_millis(250)).await;
                    if !MINIMIZED.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(active) = handle.update(cx, |_, window, _| window.is_window_active()) else { return };
                    if !active {
                        away = true;
                    } else if away {
                        MINIMIZED.store(false, Ordering::Relaxed);
                        return;
                    }
                }
            })
            .detach();
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
    !MINIMIZED.load(Ordering::Relaxed)
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
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty())
}
