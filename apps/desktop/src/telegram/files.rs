//! Reading a file the engine downloaded, by the path it names: opened first, and only then
//! checked, on the handle, to be a file of the engine's folder, then read from that same handle.
//! Checking a path and opening it by name after would let an engine taken over swap the file for
//! a link to one of the person's in between, which the app, outside the box, would follow.

use std::fs::File;
use std::path::{Path, PathBuf};

/// The most of one file the app reads of the engine's: Telegram's largest, 4000 MB with Premium.
pub const MOST: u64 = 4 << 30;

/// The file at `path`, opened without following a link at its end, if what was opened is a
/// file, no larger than `MOST`, whose real name, as the system gives it for the handle, is inside
/// the engine's folder. Whatever is read of it is read from the handle this gives.
pub fn open_inside(path: &Path, engine_folder: &Path) -> Option<File> {
    let root = std::fs::canonicalize(engine_folder).ok()?;
    let file = open_no_follow(path).ok()?;
    let found = file.metadata().ok()?;
    if !found.is_file() || found.len() > MOST {
        return None;
    }
    let real = real_path(&file)?;
    (real.starts_with(&root) && real != root).then_some(file)
}

/// Opens for reading, refusing a link in the last place: a FIFO or a device is opened without
/// waiting on it, and turned away by its type after.
#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(path)
}

/// Opens the link itself rather than what it leads to, for a symbolic link or a junction, which
/// the file's type then turns away (`FileType::is_file` is false for either).
#[cfg(windows)]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    let file = std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).open(path)?;
    use std::os::windows::fs::MetadataExt;
    // Any reparse point at all, which a link of a kind the standard library doesn't know may be.
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::other("a reparse point"));
    }
    Ok(file)
}

/// The path the system has for an open file, which follows nothing anyone can change after.
#[cfg(target_os = "macos")]
fn real_path(file: &File) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;
    let mut buffer = vec![0u8; libc::PATH_MAX as usize + 1];
    // SAFETY: F_GETPATH writes at most MAXPATHLEN bytes, a NUL among them, into the buffer.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return None;
    }
    let length = buffer.iter().position(|&byte| byte == 0)?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..length])))
}

#[cfg(target_os = "linux")]
fn real_path(file: &File) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

/// By the same call `std::fs::canonicalize` gives the engine's folder by, so the two compare.
#[cfg(windows)]
fn real_path(file: &File) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{FILE_NAME_NORMALIZED, GETFINALPATHNAMEBYHANDLE_FLAGS, GetFinalPathNameByHandleW, VOLUME_NAME_DOS};
    let handle = HANDLE(file.as_raw_handle());
    let flags = GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0);
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: the handle is the open file's, and the call writes no more than the buffer holds.
        let length = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, flags) } as usize;
        if length == 0 {
            return None;
        }
        if length < buffer.len() {
            return Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length])));
        }
        // Too small, and `length` is what it needs, its NUL with it.
        buffer.resize(length + 1, 0);
    }
}

/// Copies an open file to `target`, replacing whatever is there: on macOS as a clone where the
/// disk allows it and nothing is there yet, as `std::fs::copy` does by name.
pub fn copy_to(mut file: File, target: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::io::AsRawFd;
        // Only where nothing is yet, as a clone replaces nothing: a file there is written over below.
        if let Ok(name) = std::ffi::CString::new(target.as_os_str().as_bytes()) {
            // SAFETY: the descriptor is the open file's, and the name a NUL-ended string.
            if unsafe { libc::fclonefileat(file.as_raw_fd(), libc::AT_FDCWD, name.as_ptr(), 0) } == 0 {
                return Ok(());
            }
        }
    }
    use std::io::Read;
    let mut out = File::create(target)?;
    std::io::copy(&mut (&mut file).take(MOST), &mut out)?;
    Ok(())
}

/// All of an open file, no more than `MOST` of it, which the engine may still be writing to.
pub fn read_all(file: File) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(MOST).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("zuna-telegram-files-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(base.join("engine").join("files").join("photos")).unwrap();
        base
    }

    #[test]
    fn a_file_of_the_engine_s_is_read_from_the_handle_it_was_checked_on() {
        let base = scratch("inside");
        let engine = base.join("engine");
        let inside = engine.join("files").join("photos").join("1.jpg");
        std::fs::write(&inside, b"jpeg").unwrap();
        let file = open_inside(&inside, &engine).expect("a file of its own folder opens");
        // Swapped for something else once it's open: what was checked is what's read.
        std::fs::rename(&inside, engine.join("files").join("moved.jpg")).unwrap();
        std::fs::write(&inside, b"another").unwrap();
        assert_eq!(read_all(file).unwrap(), b"jpeg");
        let target = base.join("copy.jpg");
        std::fs::write(&target, b"was here before").unwrap();
        copy_to(open_inside(&inside, &engine).unwrap(), &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"another");
        // By a name with `..` in it that still ends inside, as it's the file that counts.
        assert!(open_inside(&engine.join("files").join("..").join("files").join("photos").join("1.jpg"), &engine).is_some());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn nothing_outside_the_folder_is_opened_however_it_is_named() {
        let base = scratch("outside");
        let engine = base.join("engine");
        let secret = base.join("device-key.sealed");
        std::fs::write(&secret, b"secret").unwrap();
        assert!(open_inside(&secret, &engine).is_none());
        assert!(open_inside(&engine.join("files").join("..").join("..").join("device-key.sealed"), &engine).is_none());
        // Not the folder, nor one inside it, nor what isn't there.
        assert!(open_inside(&engine, &engine).is_none());
        assert!(open_inside(&engine.join("files"), &engine).is_none());
        assert!(open_inside(&engine.join("files").join("none.jpg"), &engine).is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_the_engine_makes_in_its_folder_leads_nowhere() {
        use std::os::unix::fs::symlink;
        let base = scratch("links");
        let engine = base.join("engine");
        let secret = base.join("device-key.sealed");
        std::fs::write(&secret, b"secret").unwrap();
        // A link to a file of the person's, at the end of the path.
        let link = engine.join("files").join("photos").join("2.jpg");
        symlink(&secret, &link).unwrap();
        assert!(open_inside(&link, &engine).is_none());
        // Inside it to a file inside, still a link, which the engine never needs.
        let inside = engine.join("files").join("photos").join("3.jpg");
        std::fs::write(&inside, b"jpeg").unwrap();
        symlink(&inside, engine.join("files").join("photos").join("4.jpg")).unwrap();
        assert!(open_inside(&engine.join("files").join("photos").join("4.jpg"), &engine).is_none());
        // A folder on the way that leads out, which only the handle's real name shows.
        symlink(&base, engine.join("files").join("out")).unwrap();
        assert!(open_inside(&engine.join("files").join("out").join("device-key.sealed"), &engine).is_none());
        // A pipe, which opening by name would wait on for good.
        let pipe = engine.join("files").join("pipe");
        let name = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
        // SAFETY: a NUL-ended name.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(open_inside(&pipe, &engine).is_none());
        std::fs::remove_dir_all(&base).ok();
    }
}
