//! One Zuna at a time for each data folder, as Electron's single-instance lock gave the
//! Electron app: a second start hands a `zuna://` link, or just a wish to be seen, to the one
//! already running, over a named pipe, and leaves. And `zuna://` registered as this app's,
//! as `app.setAsDefaultProtocolClient` registers it for a packaged desktop app.

use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::mpsc::channel;

use sha2::{Digest, Sha256};
use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows::Win32::Security::{GetLengthSid, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAGS_AND_ATTRIBUTES, PIPE_ACCESS_INBOUND, ReadFile};
use windows::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT};
use windows::Win32::System::Threading::{CreateMutexW, GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::core::{HSTRING, PWSTR};

pub use crate::platform::Claim;

fn names(data_dir: &Path) -> (String, String) {
    let digest = Sha256::digest(data_dir.to_string_lossy().to_lowercase().as_bytes());
    let tag: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    (format!("Local\\zuna-native-{tag}"), format!("\\\\.\\pipe\\zuna-native-{tag}"))
}

/// The account a process runs as, as its SID's bytes, or None if that can't be asked.
fn user_of(process: HANDLE) -> Option<Vec<u8>> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut size = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
        // In u64s, for TOKEN_USER's pointer to be where it should.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
        let read = GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr().cast()), size, &mut size);
        let _ = CloseHandle(token);
        read.ok()?;
        let sid = (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid;
        Some(std::slice::from_raw_parts(sid.0 as *const u8, GetLengthSid(sid) as usize).to_vec())
    }
}

/// A security descriptor that lets this account alone open the pipe, as anyone on the computer
/// could otherwise, from another account, send it whatever they like.
fn this_account_only() -> Option<PSECURITY_DESCRIPTOR> {
    let mut sid = user_of(unsafe { GetCurrentProcess() })?;
    unsafe {
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(PSID(sid.as_mut_ptr().cast()), &mut text).ok()?;
        let account = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(format!("D:P(A;;GA;;;{})", account?)), SDDL_REVISION_1, &mut descriptor, None).ok()?;
        Some(descriptor)
    }
}

/// Whether the one serving a pipe this start opened runs as this account: the pipe's name is one
/// anyone can work out, so another account on the computer could have made it first, and would
/// otherwise be handed the links this person opens, an invite's code and community key among them.
fn served_by_this_account(pipe: &std::fs::File) -> bool {
    let mut pid = 0u32;
    if unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut pid) }.is_err() {
        return false;
    }
    let Ok(server) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return false };
    let theirs = user_of(server);
    unsafe {
        let _ = CloseHandle(server);
    }
    theirs.is_some() && theirs == user_of(unsafe { GetCurrentProcess() })
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
        .spawn(move || {
            let descriptor = this_account_only();
            let attributes = descriptor.map(|descriptor| SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: false.into() });
            // The first instance only if nobody holds the name yet, and every one after it made
            // before the one before it goes, so that the name is never free for anyone else.
            let make = |first: bool| unsafe {
                let open = PIPE_ACCESS_INBOUND | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { FILE_FLAGS_AND_ATTRIBUTES(0) };
                CreateNamedPipeW(&HSTRING::from(pipe.as_str()), open, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 0, 4096, 0, attributes.as_ref().map(|attributes| attributes as *const _))
            };
            let mut handle: HANDLE = make(true);
            if attributes.is_none() || handle.is_invalid() {
                log::warn!("another program holds this data folder's pipe, so links opened later won't reach this window");
                return;
            }
            loop {
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
                    let next = make(false);
                    let _ = DisconnectNamedPipe(handle);
                    let _ = CloseHandle(handle);
                    if sender.send(String::from_utf8_lossy(&message).trim().to_string()).is_err() || next.is_invalid() {
                        break;
                    }
                    handle = next;
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
            if served_by_this_account(&file) {
                let _ = file.write_all(message.as_bytes());
            }
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

