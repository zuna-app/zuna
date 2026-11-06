//! This device's key, which seals everything the core keeps here. It's sealed in turn
//! with Windows's data protection for this user, as Electron's safeStorage does for
//! the desktop app on Windows, so another account on this computer can't read it.

use std::path::Path;

pub struct DeviceKey {
    pub key: Vec<u8>,
    /// Sealed by the system. False only if Windows wouldn't, and it's kept as it is.
    pub protected: bool,
}

pub fn load(dir: &Path) -> std::io::Result<DeviceKey> {
    std::fs::create_dir_all(dir)?;
    let sealed_path = dir.join("device-key.sealed");
    let plain_path = dir.join("device-key.bin");
    if let Ok(sealed) = std::fs::read(&sealed_path) {
        if let Some(key) = unprotect(&sealed) {
            return Ok(DeviceKey { key, protected: true });
        }
        return Err(std::io::Error::other("Windows couldn't unseal this device's key."));
    }
    if let Ok(key) = std::fs::read(&plain_path) {
        return Ok(DeviceKey { key, protected: false });
    }
    let key = zuna_crypto::primitives::random_bytes(32).map_err(std::io::Error::other)?;
    match protect(&key) {
        Some(sealed) => {
            write_new(&sealed_path, &sealed)?;
            Ok(DeviceKey { key, protected: true })
        }
        None => {
            write_new(&plain_path, &key)?;
            Ok(DeviceKey { key, protected: false })
        }
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = path.with_extension("partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(partial, path)
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, windows::core::w!("Zuna device key"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()?;
        Some(take_blob(output))
    }
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()?;
        Some(take_blob(output))
    }
}

#[cfg(windows)]
unsafe fn take_blob(blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    unsafe {
        let bytes = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(blob.pbData as *mut _)));
        bytes
    }
}

#[cfg(not(windows))]
fn protect(_: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
    None
}
