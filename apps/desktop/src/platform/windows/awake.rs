//! Keeping the screen on, with the thread's execution state, as a video player does. It's the
//! state of the thread that sets it, so it's only ever set from the app's main thread, which
//! lasts as long as the app.

use windows::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState};

/// Asks for the screen not to turn off, and the computer not to sleep, while `on`.
pub fn keep_screen_on(on: bool) {
    let state = if on { ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
    if unsafe { SetThreadExecutionState(state) }.0 == 0 {
        log::warn!("the screen can't be kept on");
    }
}
