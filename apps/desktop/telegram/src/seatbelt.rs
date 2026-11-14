//! What the engine does to itself on macOS before it runs a line of TDLib's or reads a byte from
//! Telegram (docs/TELEGRAM_PLAN.md, A process of its own, in a box): it closes its box behind it,
//! on the one thread there is so far, with its door's port already bound. The app has started it
//! with its three pipes alone and nothing of its environment, and waits to see from outside that
//! the box holds before it sends anything, its database's key least of all (`platform/sandbox.rs`).
//!
//! The box is Seatbelt, the sandbox in macOS's kernel that Safari's and Chromium's renderers run
//! in, given a profile of its own (`PROFILE`) through `sandbox_init_with_parameters`. It refuses
//! everything the profile doesn't name: the disk outside the engine's folder, the keychain and
//! every other service of the system's, other processes, starting a program, the camera, the
//! microphone, the screen, the clipboard, and the network but its own loopback at the door's port.
//! It lasts for the life of the process, and nothing inside can loosen it.
//!
//! macOS's App Sandbox, an entitlement on the program, was the other way. It reaches the network
//! all or nothing: the loopback the door is on needs the right to connect anywhere, and it keeps
//! the engine's folder in a container of its own in the person's Library rather than the app's
//! data folder. A profile of our own says exactly what's allowed.
//!
//! Besides the box:
//!
//! - **No core dump,** which would hold the session's keys.
//! - **Nobody to attach,** on top of the hardened runtime's own refusal, as the engine is signed
//!   with no entitlements in every build (`scripts/macos-dist.mjs`).
//! - **Ended with the app,** whatever ends it: the kernel says when the app's process goes, as
//!   Windows' job and Linux's signal at its parent's death do, so that a copy left running never
//!   holds TDLib's database from the next.

use std::ffi::{CStr, CString, c_char};
use std::io::{Error, Result};
use std::os::unix::ffi::OsStrExt;

/// What the engine may do. `(param …)` is what `lock` gives it: its folder, as the system names
/// it, and the door's port.
const PROFILE: &str = r#"
(version 1)
(deny default)

; Its own folder: TDLib's database, the files it downloads and sends, and what it moves between them.
(allow file-read* file-write* (subpath (param "FOLDER")))

; The system's random numbers, which OpenSSL may read, and the null device.
(allow file-read-data (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read-data file-write-data (literal "/dev/null"))

; Its own loopback, at the door's port alone, where TDLib's every connection goes.
(allow network-outbound (remote ip (string-append "localhost:" (param "PORT"))))
(allow network-inbound (local ip (string-append "localhost:" (param "PORT"))))

; Itself: its own signals and what it is.
(allow signal (target self))
(allow process-info* (target self))

; What the C library and TDLib ask of the kernel about the computer: its processors and memory,
; its page size, and the system's kind and version.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.cachelinesize")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.l1dcachesize")
  (sysctl-name "hw.l2cachesize")
  (sysctl-name "hw.optional.arm64")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.version")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "vm.footprint_suspend")
  (sysctl-name "sysctl.proc_translated"))
"#;

unsafe extern "C" {
    // libsystem_sandbox's, which Chromium and Firefox declare as this does: the header has only
    // the older `sandbox_init`, which takes no parameters.
    fn sandbox_init_with_parameters(profile: *const c_char, flags: u64, parameters: *const *const c_char, error: *mut *mut c_char) -> libc::c_int;
    fn sandbox_free_error(error: *mut c_char);
}

pub fn lock(door_port: u16) -> Result<()> {
    let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) } != 0 {
        return Err(Error::last_os_error());
    }
    if unsafe { libc::ptrace(libc::PT_DENY_ATTACH, 0, std::ptr::null_mut(), 0) } != 0 {
        return Err(Error::last_os_error());
    }
    end_with_app()?;
    // The folder the app starts it in, by its own name rather than a link's, which is what
    // Seatbelt matches a path against.
    let folder = CString::new(std::env::current_dir()?.canonicalize()?.as_os_str().as_bytes()).map_err(Error::other)?;
    let port = CString::new(door_port.to_string()).map_err(Error::other)?;
    let profile = CString::new(PROFILE).map_err(Error::other)?;
    let parameters = [c"FOLDER".as_ptr(), folder.as_ptr(), c"PORT".as_ptr(), port.as_ptr(), std::ptr::null()];
    let mut error: *mut c_char = std::ptr::null_mut();
    if unsafe { sandbox_init_with_parameters(profile.as_ptr(), 0, parameters.as_ptr(), &mut error) } != 0 {
        let why = if error.is_null() { "no reason given".to_string() } else { unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned() };
        if !error.is_null() {
            unsafe { sandbox_free_error(error) };
        }
        return Err(Error::other(format!("Seatbelt refused the profile: {why}")));
    }
    Ok(())
}

/// Ends the process the moment the app's does: the kernel's word through a kqueue, asked for
/// before the box, and heard by a thread that does nothing else.
fn end_with_app() -> Result<()> {
    let app = unsafe { libc::getppid() };
    // Started by launchd, not the app: there's no app to end with, and no reason to run.
    if app <= 1 {
        return Err(Error::other("the app that started it has already gone"));
    }
    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return Err(Error::last_os_error());
    }
    let watch = libc::kevent { ident: app as usize, filter: libc::EVFILT_PROC, flags: libc::EV_ADD | libc::EV_ONESHOT, fflags: libc::NOTE_EXIT, data: 0, udata: std::ptr::null_mut() };
    if unsafe { libc::kevent(queue, &watch, 1, std::ptr::null_mut(), 0, std::ptr::null()) } != 0 {
        // ESRCH: it went before it could be watched.
        return Err(Error::last_os_error());
    }
    std::thread::Builder::new()
        .name("app-watch".into())
        .spawn(move || {
            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            loop {
                let heard = unsafe { libc::kevent(queue, std::ptr::null(), 0, &mut event, 1, std::ptr::null()) };
                if heard > 0 {
                    unsafe { libc::_exit(0) };
                }
                if heard < 0 && Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                    // The queue broke, which leaves the pipe: the app's end of it goes with the app.
                    return;
                }
            }
        })
        .map(|_| ())
}
