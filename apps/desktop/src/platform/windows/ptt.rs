//! Push to talk's key, held in any window, through Windows's low-level keyboard and mouse
//! hooks, as the desktop hears it on Windows (platform.watchKey). Keys are named as the
//! browser's `KeyboardEvent.code` names them, so a setting reads the same in either app.
//! The hooks are only in place while a key is watched for or one is being chosen.

use std::sync::Mutex;
use std::sync::OnceLock;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::*;

type Listener = Box<dyn Fn(bool) + Send>;
type Chooser = Box<dyn FnOnce(String) + Send>;

#[derive(Default)]
struct Hooks {
    /// The thread running the hooks, while they're in place.
    thread: Option<u32>,
    watching: Option<(String, Listener)>,
    choosing: Option<Chooser>,
    down: bool,
}

fn hooks() -> &'static Mutex<Hooks> {
    static HOOKS: OnceLock<Mutex<Hooks>> = OnceLock::new();
    HOOKS.get_or_init(Mutex::default)
}

/// The browser's name for a key, from what the hook reports.
pub fn code_of(vk: u32, extended: bool) -> Option<String> {
    let name = match vk {
        0x41..=0x5A => return Some(format!("Key{}", char::from_u32(vk)?)),
        0x30..=0x39 => return Some(format!("Digit{}", vk - 0x30)),
        0x60..=0x69 => return Some(format!("Numpad{}", vk - 0x60)),
        0x70..=0x87 => return Some(format!("F{}", vk - 0x6F)),
        0xA0 => "ShiftLeft",
        0xA1 => "ShiftRight",
        0xA2 => "ControlLeft",
        0xA3 => "ControlRight",
        0xA4 => "AltLeft",
        0xA5 => "AltRight",
        0x5B => "MetaLeft",
        0x5C => "MetaRight",
        0x20 => "Space",
        0xC0 => "Backquote",
        0x14 => "CapsLock",
        0x09 => "Tab",
        0x0D if extended => "NumpadEnter",
        0x0D => "Enter",
        0x1B => "Escape",
        0x08 => "Backspace",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x2D => "Insert",
        0x2E => "Delete",
        0x24 => "Home",
        0x23 => "End",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0xBD => "Minus",
        0xBB => "Equal",
        0xDB => "BracketLeft",
        0xDD => "BracketRight",
        0xDC => "Backslash",
        0xBA => "Semicolon",
        0xDE => "Quote",
        0xBC => "Comma",
        0xBE => "Period",
        0xBF => "Slash",
        0x6A => "NumpadMultiply",
        0x6B => "NumpadAdd",
        0x6D => "NumpadSubtract",
        0x6E => "NumpadDecimal",
        0x6F => "NumpadDivide",
        0x13 => "Pause",
        0x91 => "ScrollLock",
        0x90 => "NumLock",
        0x2C => "PrintScreen",
        0x5D => "ContextMenu",
        _ => return None,
    };
    Some(name.into())
}

/// Whether one of this app's windows is the one in front.
fn ours_in_front() -> bool {
    unsafe {
        let window = GetForegroundWindow();
        let mut process = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process));
        process == std::process::id()
    }
}

/// A key or button went down or up somewhere.
fn heard(code: String, down: bool) {
    let mut hooks = hooks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if down {
        if let Some(choose) = hooks.choosing.take() {
            choose(code);
            drop(hooks);
            settle();
            return;
        }
    }
    let Some((watched, _)) = &hooks.watching else { return };
    if *watched != code {
        return;
    }
    // A letter being typed into a message isn't someone wanting to talk.
    if down && code.starts_with("Key") && ours_in_front() {
        return;
    }
    if hooks.down == down {
        return;
    }
    hooks.down = down;
    if let Some((_, listener)) = &hooks.watching {
        listener(down);
    }
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let message = wparam.0 as u32;
        let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let up = message == WM_KEYUP || message == WM_SYSKEYUP;
        if down || up {
            if let Some(name) = code_of(info.vkCode, info.flags.0 & LLKHF_EXTENDED.0 != 0) {
                heard(name, down);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        if message == WM_XBUTTONDOWN || message == WM_XBUTTONUP {
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            // The browser numbers the side buttons 3 (back) and 4 (forward).
            let button = if (info.mouseData >> 16) as u16 == XBUTTON1 { 3 } else { 4 };
            heard(format!("Mouse{button}"), message == WM_XBUTTONDOWN);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Puts the hooks in place, or takes them away, as what's wanted asks.
fn settle() {
    let mut hooks = hooks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let wanted = hooks.watching.is_some() || hooks.choosing.is_some();
    match (wanted, hooks.thread) {
        (true, None) => {
            let (ready, started) = std::sync::mpsc::channel();
            std::thread::Builder::new()
                .name("zuna-push-to-talk".into())
                .spawn(move || unsafe {
                    let module = GetModuleHandleW(None).ok();
                    let keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module.map(|module| module.into()), 0);
                    let buttons = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module.map(|module| module.into()), 0);
                    ready.send(GetCurrentThreadId()).ok();
                    // The hooks are called on this thread, as it waits for messages.
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).as_bool() {}
                    if let Ok(keys) = keys {
                        let _ = UnhookWindowsHookEx(keys);
                    }
                    if let Ok(buttons) = buttons {
                        let _ = UnhookWindowsHookEx(buttons);
                    }
                })
                .ok();
            hooks.thread = started.recv().ok();
        }
        (false, Some(thread)) => {
            unsafe {
                let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            hooks.thread = None;
            hooks.down = false;
        }
        _ => {}
    }
}

/// Watches for a key, by its browser name, telling `listener` as it goes down and up. None
/// stops watching. Windows binds nothing itself, so `_bound` is never told another key.
pub fn watch(code: Option<String>, listener: impl Fn(bool) + Send + 'static, _bound: impl FnOnce(String) + Send + 'static) {
    {
        let mut hooks = hooks().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        hooks.down = false;
        hooks.watching = code.map(|code| (code, Box::new(listener) as Listener));
    }
    settle();
}

/// Hears the next key or side button pressed, anywhere, for choosing one.
pub fn choose(then: impl FnOnce(String) + Send + 'static) {
    hooks().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).choosing = Some(Box::new(then));
    settle();
}

/// Stops waiting for a key to be chosen.
pub fn stop_choosing() {
    hooks().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).choosing = None;
    settle();
}

/// The hooks hear keys and mouse buttons in any window.
pub fn support() -> Option<crate::platform::KeyWatchSupport> {
    Some(crate::platform::KeyWatchSupport { anywhere: true, mouse: true, why: None })
}

/// There's nothing to ask, so `then` is told at once.
pub fn check_support(then: impl FnOnce() + Send + 'static) {
    then();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keys_as_the_browser_does() {
        assert_eq!(code_of(0x41, false).as_deref(), Some("KeyA"));
        assert_eq!(code_of(0x35, false).as_deref(), Some("Digit5"));
        assert_eq!(code_of(0x70, false).as_deref(), Some("F1"));
        assert_eq!(code_of(0xA3, false).as_deref(), Some("ControlRight"));
        assert_eq!(code_of(0x0D, true).as_deref(), Some("NumpadEnter"));
        assert_eq!(code_of(0xC0, false).as_deref(), Some("Backquote"));
    }
}
