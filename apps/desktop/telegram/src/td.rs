//! TDLib's JSON interface (td/telegram/td_json_client.h), linked statically (build.rs).

use std::ffi::{CStr, CString, c_char, c_double, c_int};

unsafe extern "C" {
    fn td_create_client_id() -> c_int;
    fn td_send(client_id: c_int, request: *const c_char);
    fn td_receive(timeout: c_double) -> *const c_char;
    fn td_execute(request: *const c_char) -> *const c_char;
}

/// One TDLib client. This process runs one.
pub struct Client(c_int);

impl Client {
    pub fn new() -> Client {
        Client(unsafe { td_create_client_id() })
    }

    /// Sends a request, whose answer comes back through `receive` with the same `@extra`. A
    /// request with a NUL in it, which JSON escapes and TDLib couldn't read, is dropped.
    pub fn send(&self, json: &str) {
        if let Ok(request) = CString::new(json) {
            unsafe { td_send(self.0, request.as_ptr()) }
        }
    }
}

/// Waits up to `timeout` seconds for the next answer or update from any client. Only one thread
/// may call it: what it returns lives until it's called again, so it's copied out at once.
pub fn receive(timeout: f64) -> Option<String> {
    let answer = unsafe { td_receive(timeout) };
    if answer.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(answer) }.to_string_lossy().into_owned())
}

/// Runs one of TDLib's synchronous requests, such as its log's settings.
pub fn execute(json: &str) -> Option<String> {
    let request = CString::new(json).ok()?;
    let answer = unsafe { td_execute(request.as_ptr()) };
    if answer.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(answer) }.to_string_lossy().into_owned())
}
