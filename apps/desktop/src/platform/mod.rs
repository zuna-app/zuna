//! What the app asks of the system itself, each system's in a module of its own with the
//! same functions: Windows's in `windows/`.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;
