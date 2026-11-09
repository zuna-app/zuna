//! Keeping the screen on, with an IOKit power assertion against the display sleeping, as a
//! browser's screen wake lock holds one. `pmset -g assertions` lists it, by its name.

use std::ffi::c_void;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2_foundation::NSString;

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMAssertionCreateWithName(kind: *const c_void, level: u32, name: *const c_void, id: *mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

/// `kIOPMAssertionLevelOn`.
const LEVEL_ON: u32 = 255;

/// The assertion while it's held.
static HELD: Mutex<Option<u32>> = Mutex::new(None);

/// Asks for the screen not to dim or sleep, and so the Mac not to either, while `on`.
pub fn keep_screen_on(on: bool) {
    let mut held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match (on, *held) {
        (true, None) => {
            // CFStrings, as NSStrings are the same objects.
            let kind = NSString::from_str("PreventUserIdleDisplaySleep");
            let name = NSString::from_str("Zuna is showing a call's video");
            let mut id = 0;
            let result = unsafe { IOPMAssertionCreateWithName(Retained::as_ptr(&kind).cast(), LEVEL_ON, Retained::as_ptr(&name).cast(), &mut id) };
            if result == 0 {
                *held = Some(id);
            } else {
                log::warn!("the screen can't be kept on: IOKit's {result:#x}");
            }
        }
        (false, Some(id)) => {
            unsafe { IOPMAssertionRelease(id) };
            *held = None;
        }
        _ => {}
    }
}
