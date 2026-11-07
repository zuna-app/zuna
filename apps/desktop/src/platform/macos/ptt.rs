//! Push to talk's key, heard in this window alone until macOS's own comes (M2 in
//! docs/MACOS_APP_PLAN.md).

use std::sync::Mutex;

use crate::platform::KeyWatchSupport;

type Chosen = Box<dyn FnOnce(String) + Send>;
static CHOOSING: Mutex<Option<Chosen>> = Mutex::new(None);

pub fn watch(_code: Option<String>, _listener: impl Fn(bool) + Send + 'static, _bound: impl FnOnce(String) + Send + 'static) {}

pub fn support() -> Option<KeyWatchSupport> {
    Some(KeyWatchSupport { anywhere: false, mouse: false, why: None })
}

pub fn check_support(then: impl FnOnce() + Send + 'static) {
    then();
}

pub fn choose(then: impl FnOnce(String) + Send + 'static) {
    *CHOOSING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Box::new(then));
}

pub fn stop_choosing() {
    CHOOSING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
}

pub fn hear(_keystroke: &gpui::Keystroke) -> bool {
    false
}
