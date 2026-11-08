//! Automatic updates, so that a security fix reaches people without their having to
//! notice it. An update is only ever installed if it
//! carries the same publisher's signature as the app running now. A build that isn't
//! signed has nothing to compare with, so it doesn't update itself, and neither does one
//! that wasn't installed, or a development build.
//!
//! It looks at the newest release on GitHub every six hours, downloads its installer when
//! it's newer, and runs it quietly as the app quits, as electron-updater's
//! `autoInstallOnAppQuit` did for the Electron app.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use windows::Win32::Foundation::HWND;
use windows::Win32::Security::Cryptography::*;
use windows::Win32::Security::WinTrust::*;
use windows::core::{GUID, HSTRING, PCWSTR};

pub use crate::platform::VERSION;

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const RELEASES: &str = "https://api.github.com/repos/SocketByte/zuna-chat/releases/latest";

/// An update downloaded and checked, to install as the app quits.
static READY: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Starts looking for updates, where this copy may update itself.
pub fn start() {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if !installed(&exe) {
        return;
    }
    let Some(publisher) = publisher(&exe) else { return };
    std::thread::Builder::new()
        .name("zuna-updates".into())
        .spawn(move || loop {
            if let Err(error) = check(&publisher) {
                log::warn!("checking for updates: {error}");
            }
            std::thread::sleep(CHECK_EVERY);
        })
        .ok();
}

/// Runs a downloaded update quietly, once the app has quit.
pub fn install_on_quit() {
    let ready = READY.lock().ok().and_then(|ready| ready.clone());
    if let Some(installer) = ready {
        let _ = std::process::Command::new(installer).arg("/S").spawn();
    }
}

/// Whether this copy is the one the installer put in place.
pub fn installed(exe: &Path) -> bool {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return false };
    let home = Path::new(&local).join("Programs").join("Zuna Native");
    exe.to_string_lossy().to_lowercase().starts_with(&home.to_string_lossy().to_lowercase())
}

fn newer(candidate: &str, current: &str) -> bool {
    let parts = |text: &str| -> Vec<u64> { text.trim_start_matches('v').split('.').map(|part| part.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0)).collect() };
    parts(candidate) > parts(current)
}

fn check(publisher: &str) -> Result<(), String> {
    if READY.lock().map(|ready| ready.is_some()).unwrap_or(false) {
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .tls_backend_preconfigured(crate::host::tls_config())
        .user_agent("Zuna")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())?;
    let runtime = crate::host::tokio();
    let body = runtime.block_on(async { client.get(RELEASES).header("Accept", "application/vnd.github+json").send().await?.error_for_status()?.bytes().await }).map_err(|error| error.to_string())?;
    let release: Value = serde_json::from_slice(&body).map_err(|error| error.to_string())?;
    let tag = release.get("tag_name").and_then(Value::as_str).unwrap_or_default();
    if !newer(tag, VERSION) {
        return Ok(());
    }
    let version = tag.trim_start_matches('v');
    let wanted = format!("Zuna-Native-Setup-{version}.exe");
    let Some(url) = release.get("assets").and_then(Value::as_array).and_then(|assets| assets.iter().find(|asset| asset.get("name").and_then(Value::as_str) == Some(wanted.as_str()))).and_then(|asset| asset.get("browser_download_url")).and_then(Value::as_str) else {
        return Ok(());
    };
    let bytes = runtime.block_on(async { client.get(url).send().await?.error_for_status()?.bytes().await }).map_err(|error| error.to_string())?;
    let folder = std::env::temp_dir().join("Zuna").join("update");
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let path = folder.join(&wanted);
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;
    // Only the same publisher's: anyone could put a file on a release page.
    if publisher_of_valid(&path).as_deref() != Some(publisher) {
        std::fs::remove_file(&path).ok();
        return Err(format!("{wanted} isn't signed by {publisher}"));
    }
    if let Ok(mut ready) = READY.lock() {
        *ready = Some(path);
    }
    Ok(())
}

/// Whether a file's Authenticode signature checks out.
fn verified(path: &Path) -> bool {
    let wide = HSTRING::from(path.as_os_str());
    unsafe {
        let mut file = WINTRUST_FILE_INFO { cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32, pcwszFilePath: PCWSTR(wide.as_ptr()), ..Default::default() };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            ..Default::default()
        };
        let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let result = WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut _ as *mut _);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut _ as *mut _);
        result == 0
    }
}

/// Who signed a file, by the name on the signing certificate.
fn signer_name(path: &Path) -> Option<String> {
    let wide = HSTRING::from(path.as_os_str());
    unsafe {
        let mut encoding = CERT_QUERY_ENCODING_TYPE::default();
        let mut content = CERT_QUERY_CONTENT_TYPE::default();
        let mut format = CERT_QUERY_FORMAT_TYPE::default();
        let mut store = HCERTSTORE::default();
        let mut message: *mut std::ffi::c_void = std::ptr::null_mut();
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            wide.as_ptr() as *const _,
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            Some(&mut encoding),
            Some(&mut content),
            Some(&mut format),
            Some(&mut store),
            Some(&mut message),
            None,
        )
        .ok()?;
        let mut size = 0u32;
        let found = (|| {
            CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, None, &mut size).ok()?;
            let mut buffer = vec![0u8; size as usize];
            CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, Some(buffer.as_mut_ptr() as *mut _), &mut size).ok()?;
            let signer = &*(buffer.as_ptr() as *const CMSG_SIGNER_INFO);
            let info = CERT_INFO { Issuer: signer.Issuer, SerialNumber: signer.SerialNumber, ..Default::default() };
            let certificate = CertFindCertificateInStore(store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0, CERT_FIND_SUBJECT_CERT, Some(&info as *const _ as *const _), None);
            if certificate.is_null() {
                return None;
            }
            let mut name = vec![0u16; 512];
            let length = CertGetNameStringW(certificate, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(&mut name));
            let _ = CertFreeCertificateContext(Some(certificate));
            (length > 1).then(|| String::from_utf16_lossy(&name[..length as usize - 1]))
        })();
        let _ = CryptMsgClose(Some(message));
        let _ = CertCloseStore(Some(store), 0);
        found
    }
}

/// The publisher of a file whose signature checks out.
fn publisher_of_valid(path: &Path) -> Option<String> {
    if !verified(path) {
        return None;
    }
    signer_name(path)
}

/// This app's own publisher, if it's signed.
fn publisher(exe: &Path) -> Option<String> {
    publisher_of_valid(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_as_numbers() {
        assert!(newer("v1.10.0", "1.9.3"));
        assert!(newer("1.0.1", "1.0.0"));
        assert!(!newer("v1.0.0", "1.0.0"));
        assert!(!newer("0.9.9", "1.0.0"));
    }

    /// With ZUNA_SIGNED_EXE naming a signed program, its publisher is read from its certificate.
    #[test]
    fn reads_a_signed_program_s_publisher() {
        let Some(path) = std::env::var_os("ZUNA_SIGNED_EXE") else { return };
        let expected = std::env::var("ZUNA_SIGNED_BY").unwrap_or_default();
        assert_eq!(publisher(Path::new(&path)).as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn an_unsigned_build_has_no_publisher() {
        let exe = std::env::current_exe().unwrap();
        assert_eq!(publisher(&exe), None);
    }
}
