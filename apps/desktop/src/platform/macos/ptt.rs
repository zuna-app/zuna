//! Push to talk's key, held in any app, through a listen-only event tap, as Windows hears it
//! through its low-level hooks (`windows/ptt.rs`). macOS allows one with Input Monitoring,
//! which it asks the person for once, in System Settings. Keys are named as the browser's
//! `KeyboardEvent.code` names them, from macOS's virtual key codes, so a setting reads the same
//! in either app. The tap is only in place while a key is watched for or one is being chosen.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};

use objc2_core_foundation::{CFMachPort, CFRetained, CFRunLoop, kCFRunLoopCommonModes};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType, CGPreflightListenEventAccess,
    CGRequestListenEventAccess,
};

use crate::platform::{KeyWatchSupport, NoKeyWatch};

type Listener = Box<dyn Fn(bool) + Send>;
type Chooser = Box<dyn FnOnce(String) + Send>;

#[derive(Default)]
struct Tap {
    /// The run loop the tap is on, while it's in place.
    run_loop: Option<CFRetainedSend>,
    watching: Option<(String, Listener)>,
    choosing: Option<Chooser>,
    down: bool,
}

/// A run loop, which may be stopped from any thread.
struct CFRetainedSend(CFRetained<CFRunLoop>);

// SAFETY: CFRunLoopStop may be called from any thread.
unsafe impl Send for CFRetainedSend {}

fn tap() -> std::sync::MutexGuard<'static, Tap> {
    static TAP: OnceLock<Mutex<Tap>> = OnceLock::new();
    TAP.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The browser's name for a key, from macOS's virtual key code (kVK_* in Events.h).
pub fn code_of(keycode: i64) -> Option<String> {
    let letters = [
        (0x00, 'A'), (0x0B, 'B'), (0x08, 'C'), (0x02, 'D'), (0x0E, 'E'), (0x03, 'F'), (0x05, 'G'), (0x04, 'H'), (0x22, 'I'), (0x26, 'J'), (0x28, 'K'), (0x25, 'L'), (0x2E, 'M'),
        (0x2D, 'N'), (0x1F, 'O'), (0x23, 'P'), (0x0C, 'Q'), (0x0F, 'R'), (0x01, 'S'), (0x11, 'T'), (0x20, 'U'), (0x09, 'V'), (0x0D, 'W'), (0x07, 'X'), (0x10, 'Y'), (0x06, 'Z'),
    ];
    if let Some((_, letter)) = letters.iter().find(|(code, _)| *code == keycode) {
        return Some(format!("Key{letter}"));
    }
    let digits = [(0x1D, 0), (0x12, 1), (0x13, 2), (0x14, 3), (0x15, 4), (0x17, 5), (0x16, 6), (0x1A, 7), (0x1C, 8), (0x19, 9)];
    if let Some((_, digit)) = digits.iter().find(|(code, _)| *code == keycode) {
        return Some(format!("Digit{digit}"));
    }
    let keypad = [(0x52, 0), (0x53, 1), (0x54, 2), (0x55, 3), (0x56, 4), (0x57, 5), (0x58, 6), (0x59, 7), (0x5B, 8), (0x5C, 9)];
    if let Some((_, digit)) = keypad.iter().find(|(code, _)| *code == keycode) {
        return Some(format!("Numpad{digit}"));
    }
    let functions = [
        (0x7A, 1), (0x78, 2), (0x63, 3), (0x76, 4), (0x60, 5), (0x61, 6), (0x62, 7), (0x64, 8), (0x65, 9), (0x6D, 10), (0x67, 11), (0x6F, 12), (0x69, 13), (0x6B, 14), (0x71, 15),
        (0x6A, 16), (0x40, 17), (0x4F, 18), (0x50, 19), (0x5A, 20),
    ];
    if let Some((_, number)) = functions.iter().find(|(code, _)| *code == keycode) {
        return Some(format!("F{number}"));
    }
    let name = match keycode {
        0x18 => "Equal",
        0x1B => "Minus",
        0x1E => "BracketRight",
        0x21 => "BracketLeft",
        0x24 => "Enter",
        0x27 => "Quote",
        0x29 => "Semicolon",
        0x2A => "Backslash",
        0x2B => "Comma",
        0x2C => "Slash",
        0x2F => "Period",
        0x30 => "Tab",
        0x31 => "Space",
        0x32 => "Backquote",
        0x33 => "Backspace",
        0x35 => "Escape",
        0x36 => "MetaRight",
        0x37 => "MetaLeft",
        0x38 => "ShiftLeft",
        0x39 => "CapsLock",
        0x3A => "AltLeft",
        0x3B => "ControlLeft",
        0x3C => "ShiftRight",
        0x3D => "AltRight",
        0x3E => "ControlRight",
        0x41 => "NumpadDecimal",
        0x43 => "NumpadMultiply",
        0x45 => "NumpadAdd",
        0x47 => "NumLock",
        0x4B => "NumpadDivide",
        0x4C => "NumpadEnter",
        0x4E => "NumpadSubtract",
        0x51 => "NumpadEqual",
        0x72 => "Insert",
        0x73 => "Home",
        0x74 => "PageUp",
        0x75 => "Delete",
        0x77 => "End",
        0x79 => "PageDown",
        0x7B => "ArrowLeft",
        0x7C => "ArrowRight",
        0x7D => "ArrowDown",
        0x7E => "ArrowUp",
        _ => return None,
    };
    Some(name.to_string())
}

/// Whether a modifier is down, from the flags a FlagsChanged event carries, which tell left
/// from right by the device's own bits (NX_DEVICE*KEYMASK in IOLLEvent.h).
fn modifier_down(code: &str, flags: CGEventFlags) -> Option<bool> {
    let bit = match code {
        "ControlLeft" => 0x0000_0001,
        "ShiftLeft" => 0x0000_0002,
        "ShiftRight" => 0x0000_0004,
        "MetaLeft" => 0x0000_0008,
        "MetaRight" => 0x0000_0010,
        "AltLeft" => 0x0000_0020,
        "AltRight" => 0x0000_0040,
        "ControlRight" => 0x0000_2000,
        "CapsLock" => 0x0001_0000,
        _ => return None,
    };
    Some(flags.0 & bit != 0)
}

/// A key or button went down or up somewhere.
fn heard(code: String, down: bool) {
    let mut tap = tap();
    if down {
        if let Some(choose) = tap.choosing.take() {
            choose(code);
            drop(tap);
            settle();
            return;
        }
    }
    let Some((watched, _)) = &tap.watching else { return };
    if *watched != code || tap.down == down {
        return;
    }
    tap.down = down;
    if let Some((_, listener)) = &tap.watching {
        listener(down);
    }
}

/// The tap's port while it's in place, for turning it on again: macOS turns a tap off after
/// one slow answer, or while secure input is on, and push to talk would stop for the session.
/// Set and cleared on the tap's own thread, which is the only one that uses it.
static TAP_PORT: std::sync::atomic::AtomicPtr<CFMachPort> = std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

/// The key counts as let go: a tap that was off may have missed it going up.
fn released() {
    let mut tap = tap();
    if tap.down {
        tap.down = false;
        if let Some((_, listener)) = &tap.watching {
            listener(false);
        }
    }
}

unsafe extern "C-unwind" fn on_event(_proxy: CGEventTapProxy, kind: CGEventType, event: NonNull<CGEvent>, _info: *mut c_void) -> *mut CGEvent {
    // SAFETY: the event is valid for the call.
    let event_ref = unsafe { event.as_ref() };
    match kind {
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
            let port = TAP_PORT.load(std::sync::atomic::Ordering::Acquire);
            if !port.is_null() {
                // SAFETY: the port stays alive on this thread, whose run loop calls this, until
                // it's cleared, after the run loop stops.
                CGEvent::tap_enable(unsafe { &*port }, true);
            }
            released();
        }
        CGEventType::KeyDown | CGEventType::KeyUp => {
            // A key held repeats its key down, which says nothing new.
            let repeat = CGEvent::integer_value_field(Some(event_ref), CGEventField::KeyboardEventAutorepeat) != 0;
            let keycode = CGEvent::integer_value_field(Some(event_ref), CGEventField::KeyboardEventKeycode);
            if let Some(code) = code_of(keycode).filter(|_| !repeat) {
                heard(code, kind == CGEventType::KeyDown);
            }
        }
        CGEventType::FlagsChanged => {
            let keycode = CGEvent::integer_value_field(Some(event_ref), CGEventField::KeyboardEventKeycode);
            if let Some(code) = code_of(keycode) {
                if let Some(down) = modifier_down(&code, CGEvent::flags(Some(event_ref))) {
                    heard(code, down);
                }
            }
        }
        CGEventType::OtherMouseDown | CGEventType::OtherMouseUp => {
            // The browser numbers the side buttons 3 (back) and 4 (forward), as macOS does,
            // and the middle one 1, which macOS numbers 2.
            let number = CGEvent::integer_value_field(Some(event_ref), CGEventField::MouseEventButtonNumber);
            let button = if number == 2 { 1 } else { number };
            heard(format!("Mouse{button}"), kind == CGEventType::OtherMouseDown);
        }
        _ => {}
    }
    event.as_ptr()
}

/// Puts the tap in place, or takes it away, as what's wanted asks.
fn settle() {
    let mut tap = tap();
    let wanted = tap.watching.is_some() || tap.choosing.is_some();
    match (wanted, tap.run_loop.is_some()) {
        (true, false) => {
            let (ready, started) = std::sync::mpsc::channel();
            std::thread::Builder::new()
                .name("zuna-push-to-talk".into())
                .spawn(move || {
                    let mask = [CGEventType::KeyDown, CGEventType::KeyUp, CGEventType::FlagsChanged, CGEventType::OtherMouseDown, CGEventType::OtherMouseUp].iter().fold(0u64, |mask, kind| mask | 1 << kind.0);
                    // SAFETY: the callback matches what the tap calls, and takes nothing of its own.
                    let port: Option<CFRetained<CFMachPort>> =
                        unsafe { CGEvent::tap_create(CGEventTapLocation::SessionEventTap, CGEventTapPlacement::TailAppendEventTap, CGEventTapOptions::ListenOnly, mask, Some(on_event), std::ptr::null_mut()) };
                    let Some(port) = port else {
                        log::warn!("push to talk can't listen: Input Monitoring isn't allowed");
                        ready.send(None).ok();
                        return;
                    };
                    let Some(source) = CFMachPort::new_run_loop_source(None, Some(&port), 0) else {
                        ready.send(None).ok();
                        return;
                    };
                    let Some(run_loop) = CFRunLoop::current() else {
                        ready.send(None).ok();
                        return;
                    };
                    // SAFETY: the common modes are a constant the run loop takes.
                    run_loop.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
                    TAP_PORT.store(&*port as *const CFMachPort as *mut CFMachPort, std::sync::atomic::Ordering::Release);
                    ready.send(Some(CFRetainedSend(run_loop))).ok();
                    CFRunLoop::run();
                    TAP_PORT.store(std::ptr::null_mut(), std::sync::atomic::Ordering::Release);
                    drop(source);
                    drop(port);
                })
                .ok();
            tap.run_loop = started.recv().ok().flatten();
        }
        (false, true) => {
            if let Some(run_loop) = tap.run_loop.take() {
                run_loop.0.stop();
            }
            tap.down = false;
        }
        _ => {}
    }
}

/// Watches for a key, by its browser name, telling `listener` as it goes down and up. None
/// stops watching. macOS binds nothing itself, so `_bound` is never told another key.
pub fn watch(code: Option<String>, listener: impl Fn(bool) + Send + 'static, _bound: impl FnOnce(String) + Send + 'static) {
    {
        let mut tap = tap();
        tap.down = false;
        tap.watching = code.map(|code| (code, Box::new(listener) as Listener));
    }
    settle();
}

/// Hears the next key or button pressed, anywhere, for choosing one.
pub fn choose(then: impl FnOnce(String) + Send + 'static) {
    tap().choosing = Some(Box::new(then));
    settle();
}

/// Stops waiting for a key to be chosen.
pub fn stop_choosing() {
    tap().choosing = None;
    settle();
}

static SUPPORT: Mutex<Option<KeyWatchSupport>> = Mutex::new(None);

/// Whether keys held in another app can be heard, as Input Monitoring last said.
pub fn support() -> Option<KeyWatchSupport> {
    *SUPPORT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Asks whether Input Monitoring allows Zuna, and the first time asks the person, then tells
/// `then`. macOS only applies a change there to the app once it starts again.
pub fn check_support(then: impl FnOnce() + Send + 'static) {
    let allowed = CGPreflightListenEventAccess() || CGRequestListenEventAccess();
    let found = if allowed { KeyWatchSupport { anywhere: true, mouse: true, why: None } } else { KeyWatchSupport { anywhere: false, mouse: false, why: Some(NoKeyWatch::Permission) } };
    log::info!("push to talk in other apps: {found:?}");
    *SUPPORT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(found);
    then();
}

/// Keys are chosen through the tap, anywhere, as on Windows, so nothing in the window is taken.
pub fn hear(_keystroke: &gpui::Keystroke) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keys_as_the_browser_does() {
        assert_eq!(code_of(0x00).as_deref(), Some("KeyA"));
        assert_eq!(code_of(0x17).as_deref(), Some("Digit5"));
        assert_eq!(code_of(0x7A).as_deref(), Some("F1"));
        assert_eq!(code_of(0x3E).as_deref(), Some("ControlRight"));
        assert_eq!(code_of(0x4C).as_deref(), Some("NumpadEnter"));
        assert_eq!(code_of(0x32).as_deref(), Some("Backquote"));
    }
}
