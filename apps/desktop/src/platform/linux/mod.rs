//! What the app asks of Linux itself, under Wayland, with the same functions as Windows's:
//! the main window, the tray, the unread count, idle time, the notification sound, and
//! whether the system wants quiet. The Electron app gets these from Electron.

mod frame;
pub mod icons;
pub mod location;
pub mod notifications;
pub mod ptt;
pub mod screens;
pub mod single;
pub mod tray;
pub mod updates;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{AnyWindowHandle, App, AsyncApp};

pub use frame::{title_button, title_drag, window_frame};

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

/// Starts what acts on the main window for the functions below, which aren't given a context.
pub fn install(cx: &mut App) {
    let (sender, mut receiver) = unbounded();
    if COMMANDS.set(sender).is_err() {
        return;
    }
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
            handle.update(cx, |_, window, _| window.activate_window()).ok();
        }
        // Asking for activation without a token is refused, which KWin shows as wanting attention.
        Command::Flash => {
            handle.update(cx, |_, window, _| window.activate_window()).ok();
        }
        Command::Hide => {
            let minimized = handle.update(cx, |_, window, _| window.minimize_window()).is_ok();
            if !minimized {
                return;
            }
            MINIMIZED.store(true, Ordering::Relaxed);
            // Visible again once it's been away and then active, from the taskbar or anywhere.
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
        }
    }
}

fn send(command: Command) {
    if let Some(commands) = COMMANDS.get() {
        commands.unbounded_send(command).ok();
    }
}

/// The app's main window, which the tray, notifications and the badge act on.
pub fn set_main_window(window: &gpui::Window) {
    *MAIN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(window.window_handle());
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

/// How long since anyone touched the computer, in milliseconds.
pub fn idle_ms() -> u32 {
    0
}

pub fn play_notification_sound() {}

/// What the system wants right now.
pub fn notification_state() -> super::NotificationState {
    super::NotificationState { show: true, sound: true, wait_for_input: true }
}

/// The files copied in a file manager, if that's what the clipboard holds.
pub fn clipboard_files() -> Vec<PathBuf> {
    Vec::new()
}

/// Whether the system asks for animations to be off.
pub fn animations_off() -> bool {
    false
}

/// Whether there's a Wayland session to open the window in.
pub fn wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty())
}
