//! One Zuna at a time for each data folder, as Electron's single-instance lock gave the
//! Electron app: a lock on a file in the data folder, and a second start hands its `zuna://` link,
//! or just a wish to be seen, to the one running over a Unix socket, and leaves. On Linux
//! with it goes the activation token a launcher gave the second start, as Wayland only lets a
//! window come to the front with one. `zuna://` itself belongs to the app through its
//! `.desktop` file on Linux, and its bundle on macOS, where macOS keeps one copy of a bundle
//! running and this is for a copy started outside one.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;

use sha2::{Digest, Sha256};

pub use crate::platform::Claim;

/// The socket the first start listens on, named from the data folder, as Windows names its pipe.
fn socket_path(data_dir: &Path) -> PathBuf {
    let digest = Sha256::digest(data_dir.to_string_lossy().as_bytes());
    let tag: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    #[cfg(target_os = "linux")]
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir.to_path_buf());
    // The person's own temporary folder, short enough for a socket's address of 104 bytes,
    // which a data folder deep in the file system isn't.
    #[cfg(target_os = "macos")]
    let runtime = std::env::temp_dir();
    runtime.join(format!("zuna-{tag}.sock"))
}

/// Becomes the one running for this data folder, or says one already is.
pub fn claim(data_dir: &Path) -> Claim {
    let (sender, receiver) = channel();
    std::fs::create_dir_all(data_dir).ok();
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(data_dir.join("running.lock"));
    match lock.as_ref().map(|file| file.try_lock()) {
        Ok(Ok(())) => {}
        Ok(Err(std::fs::TryLockError::WouldBlock)) => return Claim::Running,
        // Without a lock to take, it runs as if it were the only one.
        _ => log::warn!("the data folder couldn't be locked"),
    }
    // Held for as long as this process runs.
    std::mem::forget(lock);
    let path = socket_path(data_dir);
    std::fs::remove_file(&path).ok();
    let Ok(listener) = UnixListener::bind(&path) else {
        log::warn!("a second start can't reach this one");
        drop(sender);
        return Claim::First(receiver);
    };
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok();
    std::thread::Builder::new()
        .name("zuna-single-instance".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut message = String::new();
                if stream.take(8192).read_to_string(&mut message).is_err() {
                    continue;
                }
                let mut lines = message.lines();
                let link = lines.next().unwrap_or_default().trim().to_string();
                #[cfg(target_os = "linux")]
                if let Some(token) = lines.next().map(str::trim).filter(|token| !token.is_empty()) {
                    crate::platform::set_activation_token(token.to_string());
                }
                if sender.send(link).is_err() {
                    break;
                }
            }
        })
        .ok();
    Claim::First(receiver)
}

/// Hands what this start was given, and the token it was started with, to the one running.
pub fn forward(data_dir: &Path, message: &str) {
    let token = std::env::var("XDG_ACTIVATION_TOKEN").unwrap_or_default();
    for _ in 0..20 {
        if let Ok(mut stream) = UnixStream::connect(socket_path(data_dir)) {
            let _ = stream.write_all(format!("{message}\n{token}\n").as_bytes());
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn names_one_socket_for_each_data_folder() {
        let one = socket_path(Path::new("/home/a/.local/share/zuna"));
        assert_eq!(one, socket_path(Path::new("/home/a/.local/share/zuna")));
        assert_ne!(one, socket_path(Path::new("/home/b/.local/share/zuna")));
        let name = one.file_name().unwrap().to_str().unwrap();
        let tag = name.strip_prefix("zuna-").and_then(|rest| rest.strip_suffix(".sock")).expect(name);
        assert!(tag.len() == 16 && tag.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{name}");
    }

    #[test]
    fn hands_a_second_start_to_the_first() {
        #[cfg(target_os = "linux")]
        let _held = crate::platform::linux::tests::TOKEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let data_dir = std::env::temp_dir().join(format!("zuna-single-{}", std::process::id()));
        std::fs::remove_dir_all(&data_dir).ok();
        let Claim::First(handed) = claim(&data_dir) else { panic!("nothing else runs for this folder") };
        // A lock on a file is held by the file opened, so this process's second open waits too.
        assert!(matches!(claim(&data_dir), Claim::Running));
        let socket = socket_path(&data_dir);
        assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);

        let send = |message: &str| UnixStream::connect(&socket).unwrap().write_all(message.as_bytes()).unwrap();
        send("zuna://invite/abc\ntoken-1\n");
        assert_eq!(handed.recv_timeout(Duration::from_secs(10)).unwrap(), "zuna://invite/abc");
        #[cfg(target_os = "linux")]
        assert_eq!(crate::platform::linux::take_activation_token().as_deref(), Some("token-1"));

        // Just to be seen, without a token.
        send("\n\n");
        assert_eq!(handed.recv_timeout(Duration::from_secs(10)).unwrap(), "");
        #[cfg(target_os = "linux")]
        assert_eq!(crate::platform::linux::take_activation_token(), None);

        forward(&data_dir, "zuna://quit");
        assert_eq!(handed.recv_timeout(Duration::from_secs(10)).unwrap(), "zuna://quit");
        #[cfg(target_os = "linux")]
        crate::platform::linux::take_activation_token();

        std::fs::remove_file(&socket).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }
}
