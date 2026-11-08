//! This device's key, which seals everything the core keeps here. It's sealed in turn
//! with Windows's data protection for this user, as Electron's safeStorage did for
//! the Electron app on Windows, so another account on this computer can't read it. On
//! Linux it's kept in the Secret Service, and on macOS in the login keychain, where
//! safeStorage keeps its own.

use std::path::Path;

pub struct DeviceKey {
    pub key: Vec<u8>,
    /// Sealed by the system. False only if the system wouldn't seal it, and it's kept as it is.
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
        return Err(std::io::Error::other(UNSEAL_FAILED));
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
    // For this person alone, as Electron wrote its own.
    #[cfg(unix)]
    std::fs::set_permissions(&partial, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
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

#[cfg(windows)]
const UNSEAL_FAILED: &str = "Windows couldn't unseal this device's key.";
#[cfg(target_os = "macos")]
const UNSEAL_FAILED: &str = "The keychain couldn't unseal this device's key.";
#[cfg(target_os = "linux")]
const UNSEAL_FAILED: &str = "The system's keyring couldn't unseal this device's key.";

/// On Linux the key itself goes into the Secret Service (GNOME Keyring, KWallet, KeePassXC),
/// as Electron's safeStorage kept its own there, and what's written to disk only names its
/// item. None with no Secret Service, and it's kept unprotected, as with `basic_text`.
#[cfg(target_os = "linux")]
fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let id: String = zuna_crypto::primitives::random_bytes(16).ok()?.iter().map(|byte| format!("{byte:02x}")).collect();
    let data = data.to_vec();
    within_wait(async move {
        let keyring = oo7::Keyring::new().await.inspect_err(|error| log::warn!("no Secret Service for the device key: {error}")).ok()?;
        keyring.unlock().await.ok()?;
        keyring.create_item("Zuna device key", &secret_attributes(&id), data.as_slice(), true).await.inspect_err(|error| log::warn!("the device key wasn't sealed: {error}")).ok()?;
        Some(format!("{SECRET_PREFIX}{id}").into_bytes())
    })
}

#[cfg(target_os = "linux")]
fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
    let id = std::str::from_utf8(sealed).ok()?.strip_prefix(SECRET_PREFIX)?.to_string();
    within_wait(async move {
        let keyring = oo7::Keyring::new().await.inspect_err(|error| log::warn!("no Secret Service for the device key: {error}")).ok()?;
        let items = keyring.search_items(&secret_attributes(&id)).await.ok()?;
        let item = items.first()?;
        item.unlock().await.ok()?;
        Some(item.secret().await.ok()?.to_vec())
    })
}

#[cfg(target_os = "linux")]
const SECRET_PREFIX: &str = "secret-service:";

/// Runs a request to the Secret Service, which can ask the person something first, such as
/// to make KWallet's wallet, so it gets two minutes. A service that never answers then
/// counts as none, rather than keeping the app from starting.
#[cfg(target_os = "linux")]
fn within_wait<T: Send + 'static>(work: impl std::future::Future<Output = Option<T>> + Send + 'static) -> Option<T> {
    let (done, answer) = std::sync::mpsc::channel();
    std::thread::Builder::new().name("zuna-secret-service".into()).spawn(move || done.send(futures::executor::block_on(work)).ok()).ok()?;
    answer.recv_timeout(std::time::Duration::from_secs(120)).inspect_err(|_| log::warn!("the Secret Service didn't answer")).ok().flatten()
}

#[cfg(target_os = "linux")]
fn secret_attributes(id: &str) -> std::collections::HashMap<&'static str, String> {
    std::collections::HashMap::from([("application", "chat.zuna".to_string()), ("device-key", id.to_string())])
}

/// On macOS the key itself goes into the login keychain, as Electron's safeStorage kept its
/// own there, and what's written to disk only names its item. The keychain lets the app that
/// wrote an item read it back without asking, by its signature, which a build signed with the
/// same identity keeps. None if the keychain won't take it, and it's kept unprotected.
#[cfg(target_os = "macos")]
fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let id: String = zuna_crypto::primitives::random_bytes(16).ok()?.iter().map(|byte| format!("{byte:02x}")).collect();
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, &id, data).inspect_err(|error| log::warn!("the device key wasn't put in the keychain: {error}")).ok()?;
    Some(format!("{KEYCHAIN_PREFIX}{id}").into_bytes())
}

#[cfg(target_os = "macos")]
fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
    let id = std::str::from_utf8(sealed).ok()?.strip_prefix(KEYCHAIN_PREFIX)?;
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, id).inspect_err(|error| log::warn!("the device key wasn't read from the keychain: {error}")).ok()
}

/// The keychain item's service, as Keychain Access lists it, and the prefix of what names it on disk.
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Zuna device key";
#[cfg(target_os = "macos")]
const KEYCHAIN_PREFIX: &str = "keychain:";
