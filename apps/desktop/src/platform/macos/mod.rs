//! What the app asks of macOS itself, with the same functions as Windows's and Linux's: the
//! main window, the Dock's badge and its click, idle time, the notification sound, and the
//! settings the app follows. The Electron app gets these from Electron. There's no tray on
//! macOS, as the Electron app has none there: closing the window hides the app, and the Dock
//! brings it back.

pub mod icons;
pub mod location;
mod menu;
pub mod notifications;
pub mod ptt;
pub mod screens;
pub mod tray;
pub mod updates;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{AnyWindowHandle, App, AsyncApp, Div, InteractiveElement, MouseButton, Stateful};
use objc2_app_kit::NSWorkspace;
use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType};

pub use menu::set_menus;

/// What's asked of the main window from outside an update, done on the next one.
enum Command {
    Show,
    Hide,
    Flash,
}

static MAIN: Mutex<Option<AnyWindowHandle>> = Mutex::new(None);
static COMMANDS: OnceLock<UnboundedSender<Command>> = OnceLock::new();
/// Whether macOS shows any of the main window: not hidden, minimized or covered.
static VISIBLE: AtomicBool = AtomicBool::new(true);

/// Starts what acts on the main window for the functions below, which aren't given a context.
pub fn install(cx: &mut App) {
    let (sender, mut receiver) = unbounded();
    if COMMANDS.set(sender).is_err() {
        return;
    }
    cx.spawn(async move |cx| {
        while let Some(command) = receiver.next().await {
            run(command, cx);
        }
    })
    .detach();
}

fn main_window() -> Option<AnyWindowHandle> {
    *MAIN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn run(command: Command, cx: &mut AsyncApp) {
    match command {
        // Unhides the app, as the Dock's icon does, and brings the window forward, restored if
        // it was minimized.
        Command::Show => {
            cx.update(|cx| cx.activate(true));
            if let Some(handle) = main_window() {
                handle.update(cx, |_, window, _| window.activate_window()).ok();
            }
        }
        // The whole app, as ⌘H hides it: GPUI can't hide a single window.
        Command::Hide => cx.update(|cx| cx.hide()),
        // Bounces the Dock's icon once, unless the window is in front.
        Command::Flash => {
            if let Some(handle) = main_window() {
                handle.update(cx, |_, window, _| window.request_attention()).ok();
            }
        }
    }
}

fn send(command: Command) {
    if let Some(commands) = COMMANDS.get() {
        commands.unbounded_send(command).ok();
    }
}

/// The app's main window, which the Dock, notifications and the badge act on.
pub fn set_main_window(window: &gpui::Window) {
    *MAIN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(window.window_handle());
    VISIBLE.store(window.is_visible(), Ordering::Relaxed);
    window.observe_window_visibility(|visibility, _, _| VISIBLE.store(visibility.is_visible(), Ordering::Relaxed)).detach();
}

/// On screen: not hidden, minimized or covered by other windows.
pub fn main_visible() -> bool {
    VISIBLE.load(Ordering::Relaxed)
}

/// Out of sight but still running, with its icon in the Dock.
pub fn hide_main() {
    send(Command::Hide);
}

/// In front, restored if it was minimized or hidden.
pub fn show_main() {
    send(Command::Show);
}

/// Asks the person to look at the window, as for a new message.
pub fn flash_main() {
    send(Command::Flash);
}

/// How long since anyone touched the computer, in milliseconds. Asking needs no permission.
pub fn idle_ms() -> u32 {
    // kCGAnyInputEventType, ~0.
    let seconds = CGEventSource::seconds_since_last_event_type(CGEventSourceStateID::CombinedSessionState, CGEventType(u32::MAX));
    (seconds * 1000.).clamp(0., u32::MAX as f64) as u32
}

/// What the system wants right now. macOS holds notifications back itself for Focus, and
/// quiets their sound with them, so they always go to it.
pub fn notification_state() -> super::NotificationState {
    super::NotificationState { show: true, sound: true, wait_for_input: true }
}

/// The notification sound goes with the notification, so that Focus and the person's own
/// settings for Zuna quiet it too (`notifications.rs`).
pub fn play_notification_sound() {
    notifications::sound_next();
}

/// Whether Reduce motion is on in Accessibility's settings, which Chromium reads for
/// `prefers-reduced-motion` on macOS.
pub fn animations_off() -> bool {
    NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
}

/// The title bar's empty part: dragging moves the window, as Zed's own title bar on macOS
/// starts it, and a double click does what the person chose for that in System Settings.
/// GPUI's macOS windows don't act on `window_control_area`, as its Wayland windows don't.
pub fn title_drag(area: Stateful<Div>) -> Stateful<Div> {
    thread_local! {
        /// The title bar was pressed and the pointer hasn't moved since: moving starts a drag.
        static PRESSED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    area.on_mouse_down(MouseButton::Left, |event, window, _| {
        if event.click_count >= 2 {
            PRESSED.with(|pressed| pressed.set(false));
            window.titlebar_double_click();
        } else {
            PRESSED.with(|pressed| pressed.set(true));
        }
    })
    .on_mouse_up(MouseButton::Left, |_, _, _| PRESSED.with(|pressed| pressed.set(false)))
    .on_mouse_move(|event, window, _| {
        if event.pressed_button == Some(MouseButton::Left) && PRESSED.with(|pressed| pressed.replace(false)) {
            window.start_window_move();
        }
    })
}

/// Where macOS's three buttons leave room in the title bar, as `.titlebar.is-mac` does.
pub const TRAFFIC_LIGHTS_WIDTH: f32 = 80.;
