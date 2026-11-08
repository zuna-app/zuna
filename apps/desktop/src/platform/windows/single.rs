//! One Zuna at a time for each data folder, as Electron's single-instance lock gave the
//! Electron app: a second start hands a `zuna://` link, or just a wish to be seen, to the one
//! already running, over a named pipe, and leaves. And `zuna://` registered as this app's,
//! as `app.setAsDefaultProtocolClient` registers it for a packaged desktop app.

use std::io::Write;
use std::path::Path;
use std::sync::mpsc::channel;

use sha2::{Digest, Sha256};
use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows::Win32::Storage::FileSystem::{PIPE_ACCESS_INBOUND, ReadFile};
use windows::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT};
use windows::Win32::System::Threading::CreateMutexW;
use windows::core::HSTRING;

pub use crate::platform::Claim;

fn names(data_dir: &Path) -> (String, String) {
    let digest = Sha256::digest(data_dir.to_string_lossy().to_lowercase().as_bytes());
    let tag: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    (format!("Local\\zuna-native-{tag}"), format!("\\\\.\\pipe\\zuna-native-{tag}"))
}

/// Becomes the one running for this data folder, or says one already is.
pub fn claim(data_dir: &Path) -> Claim {
    let (mutex, pipe) = names(data_dir);
    let held = unsafe { CreateMutexW(None, true, &HSTRING::from(mutex)) };
    let already = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    match held {
        Ok(handle) if !already => {
            // Held for as long as this process runs.
            std::mem::forget(handle);
        }
        Ok(handle) => {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Claim::Running;
        }
        Err(_) => return Claim::Running,
    }
    let (sender, receiver) = channel();
    std::thread::Builder::new()
        .name("zuna-single-instance".into())
        .spawn(move || loop {
            let handle: HANDLE = unsafe { CreateNamedPipeW(&HSTRING::from(pipe.as_str()), PIPE_ACCESS_INBOUND, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, PIPE_UNLIMITED_INSTANCES, 0, 4096, 0, None) };
            if handle.is_invalid() {
                break;
            }
            unsafe {
                // A client that connected before this call counts as connected too.
                let _ = ConnectNamedPipe(handle, None);
                let mut message = Vec::new();
                let mut buffer = [0u8; 1024];
                loop {
                    let mut read = 0u32;
                    if ReadFile(handle, Some(&mut buffer), Some(&mut read), None).is_err() || read == 0 {
                        break;
                    }
                    message.extend_from_slice(&buffer[..read as usize]);
                    if message.len() > 8192 {
                        break;
                    }
                }
                let _ = DisconnectNamedPipe(handle);
                let _ = CloseHandle(handle);
                if sender.send(String::from_utf8_lossy(&message).trim().to_string()).is_err() {
                    break;
                }
            }
        })
        .ok();
    Claim::First(receiver)
}

/// Hands what this start was given to the one already running.
pub fn forward(data_dir: &Path, message: &str) {
    let (_, pipe) = names(data_dir);
    for _ in 0..20 {
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(&pipe) {
            let _ = file.write_all(message.as_bytes());
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

