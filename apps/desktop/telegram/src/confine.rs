//! Landlock, the part of the engine's box on Linux that holds it to its files, its signals and
//! its ports (docs/TELEGRAM_PLAN.md, A process of its own, in a box). Shared by the app, which
//! makes the first layer between fork and exec (`platform/sandbox.rs`, which takes this file with
//! `#[path]`, as the broker takes `frame.rs`), and the engine, which adds its own once its door
//! is open (`lockdown.rs`). Each layer only takes away: what one allows, another may still refuse.
//!
//! Only plain system calls, and nothing that allocates once a ruleset is made, as the app's half
//! runs in a child that may not.

#![allow(dead_code)]

use std::ffi::CString;
use std::io::{Error, Result};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

// What a file or folder may be used for (linux/landlock.h), by the version that brought each.
pub const EXECUTE: u64 = 1 << 0;
pub const WRITE_FILE: u64 = 1 << 1;
pub const READ_FILE: u64 = 1 << 2;
const ABI_1_FS: u64 = (1 << 13) - 1;
/// Moving or linking a file from one folder to another, which every layer refuses unless it allows it.
pub const REFER: u64 = 1 << 13;
const TRUNCATE: u64 = 1 << 14;
const IOCTL_DEV: u64 = 1 << 15;
/// What applies to a file rather than a folder.
const FILE_ONLY: u64 = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV;

// TCP, from version 4 (kernel 6.7).
pub const BIND_TCP: u64 = 1 << 0;
pub const CONNECT_TCP: u64 = 1 << 1;

// What may cross the box's edge at all, from version 6 (kernel 6.12): an abstract socket of a
// program outside it, and a signal to one.
const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
const SCOPE_SIGNAL: u64 = 1 << 1;

const CREATE_RULESET_VERSION: libc::c_uint = 1 << 0;
const RULE_PATH_BENEATH: libc::c_int = 1;
const RULE_NET_PORT: libc::c_int = 2;

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

#[repr(C)]
struct NetPortAttr {
    allowed_access: u64,
    port: u64,
}

/// The version of Landlock this kernel has, or 0 for none.
pub fn abi() -> u32 {
    let version = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<RulesetAttr>(), 0usize, CREATE_RULESET_VERSION) };
    u32::try_from(version).unwrap_or(0)
}

/// Every right over files this version knows, all of which a ruleset refuses unless a rule allows it.
pub fn files(abi: u32) -> u64 {
    let mut rights = if abi >= 1 { ABI_1_FS } else { 0 };
    if abi >= 2 {
        rights |= REFER;
    }
    if abi >= 3 {
        rights |= TRUNCATE;
    }
    if abi >= 5 {
        rights |= IOCTL_DEV;
    }
    rights
}

/// TCP's two rights, where this version knows them.
pub fn network(abi: u32) -> u64 {
    if abi >= 4 { BIND_TCP | CONNECT_TCP } else { 0 }
}

/// What this version keeps from crossing the box's edge.
pub fn scopes(abi: u32) -> u64 {
    if abi >= 6 { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 }
}

/// A ruleset being made: what it handles is refused, but for what its rules allow.
pub struct Ruleset(OwnedFd);

impl Ruleset {
    pub fn new(files: u64, network: u64, scoped: u64) -> Result<Ruleset> {
        let attributes = RulesetAttr { handled_access_fs: files, handled_access_net: network, scoped };
        let fd = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, &attributes as *const RulesetAttr, std::mem::size_of::<RulesetAttr>(), 0) };
        if fd < 0 {
            return Err(Error::last_os_error());
        }
        // The kernel makes it close-on-exec, so the engine never holds it.
        Ok(Ruleset(unsafe { OwnedFd::from_raw_fd(fd as RawFd) }))
    }

    /// Allows `access` on a file, or on a folder and everything under it, of what's handled.
    pub fn allow_path(&self, path: &Path, access: u64) -> Result<()> {
        let name = CString::new(path.as_os_str().as_bytes()).map_err(|_| Error::from_raw_os_error(libc::EINVAL))?;
        let fd = unsafe { libc::open(name.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(Error::last_os_error());
        }
        let opened = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut access = access;
        if !std::fs::metadata(path)?.is_dir() {
            access &= FILE_ONLY;
        }
        let rule = PathBeneathAttr { allowed_access: access, parent_fd: opened.as_raw_fd() };
        self.add(RULE_PATH_BENEATH, &rule as *const PathBeneathAttr as *const libc::c_void)
    }

    /// Allows `access` on one TCP port.
    pub fn allow_port(&self, port: u16, access: u64) -> Result<()> {
        let rule = NetPortAttr { allowed_access: access, port: port.into() };
        self.add(RULE_NET_PORT, &rule as *const NetPortAttr as *const libc::c_void)
    }

    fn add(&self, kind: libc::c_int, rule: *const libc::c_void) -> Result<()> {
        if unsafe { libc::syscall(libc::SYS_landlock_add_rule, self.0.as_raw_fd(), kind, rule, 0) } != 0 {
            return Err(Error::last_os_error());
        }
        Ok(())
    }

    pub fn raw(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}

/// Holds the calling thread, and whatever it starts from now on, to a ruleset, for good. Needs no
/// new privileges set first. One plain system call, so the app's child may make it.
pub fn restrict(ruleset: RawFd) -> Result<()> {
    if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0) } != 0 {
        return Err(Error::last_os_error());
    }
    Ok(())
}
