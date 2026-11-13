//! This device's key, which seals everything the core keeps here. It's sealed in turn
//! with Windows's data protection for this user, as Electron's safeStorage did for
//! the Electron app on Windows, so another account on this computer can't read it. On
//! Linux it's kept in the Secret Service, and on macOS in the login keychain, where
//! safeStorage keeps its own. The proxy's password is sealed the same way (`seal`).

use std::path::Path;

/// What a secret is called where the system keeps it: the keychain's service on macOS, and on
/// Linux the Secret Service's label and the attribute that names its item.
#[derive(Clone, Copy)]
pub struct Kind {
    #[cfg_attr(windows, allow(dead_code))]
    label: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    attribute: &'static str,
}

pub const DEVICE_KEY: Kind = Kind { label: "Zuna device key", attribute: "device-key" };
/// The password of the proxy everything goes through (host/net.rs), which can't wait for an
/// account, as the proxy is needed before there is one.
pub const PROXY_PASSWORD: Kind = Kind { label: "Zuna proxy password", attribute: "proxy-password" };

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
        if let Some(key) = unprotect(DEVICE_KEY, &sealed) {
            return Ok(DeviceKey { key, protected: true });
        }
        return Err(std::io::Error::other(UNSEAL_FAILED));
    }
    if let Ok(key) = std::fs::read(&plain_path) {
        // Kept plain because the system wouldn't seal it then, as when the app started with
        // the login before the Secret Service did: the same key is sealed once it will be,
        // and the plain copy goes.
        if let Some(sealed) = protect(DEVICE_KEY, &key) {
            write_new(&sealed_path, &sealed)?;
            std::fs::remove_file(&plain_path).ok();
            return Ok(DeviceKey { key, protected: true });
        }
        return Ok(DeviceKey { key, protected: false });
    }
    let key = zuna_crypto::primitives::random_bytes(32).map_err(std::io::Error::other)?;
    match protect(DEVICE_KEY, &key) {
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

/// Seals a secret as the device key is, as `<name>.sealed` in `dir`, or where the system won't
/// seal it, keeps it as it is in `<name>.bin`, for this person alone. Whatever was kept under
/// that name before goes, from the system too.
pub fn seal(dir: &Path, name: &str, kind: Kind, secret: &[u8]) -> std::io::Result<()> {
    forget(dir, name, kind);
    std::fs::create_dir_all(dir)?;
    match protect(kind, secret) {
        Some(sealed) => write_new(&dir.join(format!("{name}.sealed")), &sealed),
        None => write_new(&dir.join(format!("{name}.bin")), secret),
    }
}

/// A secret `seal` kept, if there is one and the system will unseal it.
pub fn unseal(dir: &Path, name: &str, kind: Kind) -> Option<Vec<u8>> {
    match std::fs::read(dir.join(format!("{name}.sealed"))) {
        Ok(sealed) => unprotect(kind, &sealed),
        Err(_) => std::fs::read(dir.join(format!("{name}.bin"))).ok(),
    }
}

/// Takes a secret `seal` kept out of the system and off the disk.
pub fn forget(dir: &Path, name: &str, kind: Kind) {
    let sealed_path = dir.join(format!("{name}.sealed"));
    if let Ok(sealed) = std::fs::read(&sealed_path) {
        remove(kind, &sealed);
    }
    std::fs::remove_file(sealed_path).ok();
    std::fs::remove_file(dir.join(format!("{name}.bin"))).ok();
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
fn protect(_kind: Kind, data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, windows::core::w!("Zuna device key"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()?;
        Some(take_blob(output))
    }
}

#[cfg(windows)]
fn unprotect(_kind: Kind, data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()?;
        Some(take_blob(output))
    }
}

/// A blob of Windows's is the whole of what it sealed, kept on disk alone.
#[cfg(windows)]
fn remove(_kind: Kind, _sealed: &[u8]) {}

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
fn protect(kind: Kind, data: &[u8]) -> Option<Vec<u8>> {
    let id: String = zuna_crypto::primitives::random_bytes(16).ok()?.iter().map(|byte| format!("{byte:02x}")).collect();
    let data = data.to_vec();
    within_wait(async move {
        let keyring = keyring().await?;
        keyring.unlock().await.ok()?;
        keyring.create_item(kind.label, &secret_attributes(kind, &id), data.as_slice(), true).await.inspect_err(|error| log::warn!("the {} wasn't sealed: {error}", kind.label)).ok()?;
        Some(format!("{SECRET_PREFIX}{id}").into_bytes())
    })
}

#[cfg(target_os = "linux")]
fn unprotect(kind: Kind, sealed: &[u8]) -> Option<Vec<u8>> {
    let id = std::str::from_utf8(sealed).ok()?.strip_prefix(SECRET_PREFIX)?.to_string();
    within_wait(async move {
        let keyring = keyring().await?;
        let items = keyring.search_items(&secret_attributes(kind, &id)).await.ok()?;
        let item = items.first()?;
        item.unlock().await.ok()?;
        Some(item.secret().await.ok()?.to_vec())
    })
}

#[cfg(target_os = "linux")]
fn remove(kind: Kind, sealed: &[u8]) {
    let Some(id) = std::str::from_utf8(sealed).ok().and_then(|text| text.strip_prefix(SECRET_PREFIX)).map(str::to_string) else { return };
    within_wait(async move {
        let keyring = keyring().await?;
        for item in keyring.search_items(&secret_attributes(kind, &id)).await.ok()? {
            item.delete().await.inspect_err(|error| log::warn!("the {} wasn't removed: {error}", kind.label)).ok();
        }
        Some(())
    });
}

#[cfg(target_os = "linux")]
const SECRET_PREFIX: &str = "secret-service:";

/// The Secret Service, waited for up to 20 seconds: started with the login, the app can ask
/// before the service is there, which would leave a new key unsealed, or a sealed one
/// unreadable until the app was started again by hand.
#[cfg(target_os = "linux")]
async fn keyring() -> Option<oo7::Keyring> {
    let started = std::time::Instant::now();
    loop {
        match oo7::Keyring::new().await {
            Ok(keyring) => return Some(keyring),
            Err(error) if started.elapsed() > std::time::Duration::from_secs(20) => {
                log::warn!("no Secret Service for the device key: {error}");
                return None;
            }
            // This runs on a thread of its own (`within_wait`), which may sleep.
            Err(_) => std::thread::sleep(std::time::Duration::from_secs(1)),
        }
    }
}

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
fn secret_attributes(kind: Kind, id: &str) -> std::collections::HashMap<&'static str, String> {
    std::collections::HashMap::from([("application", "chat.zuna".to_string()), (kind.attribute, id.to_string())])
}

/// On macOS the key itself goes into the login keychain, as Electron's safeStorage kept its
/// own there, and what's written to disk only names its item. The keychain lets the app that
/// wrote an item read it back without asking, by its signature, which a build signed with the
/// same identity keeps. None if the keychain won't take it, and it's kept unprotected.
#[cfg(target_os = "macos")]
fn protect(kind: Kind, data: &[u8]) -> Option<Vec<u8>> {
    let id: String = zuna_crypto::primitives::random_bytes(16).ok()?.iter().map(|byte| format!("{byte:02x}")).collect();
    security_framework::passwords::set_generic_password(kind.label, &id, data).inspect_err(|error| log::warn!("the {} wasn't put in the keychain: {error}", kind.label)).ok()?;
    Some(format!("{KEYCHAIN_PREFIX}{id}").into_bytes())
}

#[cfg(target_os = "macos")]
fn unprotect(kind: Kind, sealed: &[u8]) -> Option<Vec<u8>> {
    let id = std::str::from_utf8(sealed).ok()?.strip_prefix(KEYCHAIN_PREFIX)?;
    security_framework::passwords::get_generic_password(kind.label, id).inspect_err(|error| log::warn!("the {} wasn't read from the keychain: {error}", kind.label)).ok()
}

#[cfg(target_os = "macos")]
fn remove(kind: Kind, sealed: &[u8]) {
    let Some(id) = std::str::from_utf8(sealed).ok().and_then(|text| text.strip_prefix(KEYCHAIN_PREFIX)) else { return };
    security_framework::passwords::delete_generic_password(kind.label, id).inspect_err(|error| log::warn!("the {} wasn't taken out of the keychain: {error}", kind.label)).ok();
}

/// The prefix of what names a keychain item on disk. Its service, as Keychain Access lists it, is its kind's label.
#[cfg(target_os = "macos")]
const KEYCHAIN_PREFIX: &str = "keychain:";
