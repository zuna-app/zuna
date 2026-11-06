//! Push to talk's key, held in any window. Keys are named as the browser's
//! `KeyboardEvent.code` names them, so a setting reads the same in either app.

/// Watches for a key, by its browser name, telling `listener` as it goes down and up. None stops watching.
pub fn watch(_code: Option<String>, _listener: impl Fn(bool) + Send + 'static) {}

/// Hears the next key pressed, for choosing one.
pub fn choose(_then: impl FnOnce(String) + Send + 'static) {}

/// Stops waiting for a key to be chosen.
pub fn stop_choosing() {}
