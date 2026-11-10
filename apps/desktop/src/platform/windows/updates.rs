//! Windows's part of updating (docs/RELEASES.md): downloading an update's installer, running
//! it, and Authenticode. What an update is trusted by, and when one is looked for, is in
//! `platform/updates.rs`, the same for every system.
//!
//! Authenticode is a second lock, behind the manifest's signature. If the app running now is
//! signed, an update has to carry the same publisher's signature too. A build that isn't signed
//! has nothing to compare with, so only the manifest's checks hold for it.

use std::io::Write;
use std::path::Path;

use windows::Win32::Foundation::HWND;
use windows::Win32::Security::Cryptography::*;
use windows::Win32::Security::WinTrust::*;
use windows::core::{GUID, HSTRING, PCWSTR};

/// Whether this copy is the one the installer put in place.
pub fn installed(exe: &Path) -> bool {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return false };
    let home = Path::new(&local).join("Programs").join("Zuna Native");
    exe.to_string_lossy().to_lowercase().starts_with(&home.to_string_lossy().to_lowercase())
}

/// Downloads a file of a known size, and stops as soon as it's larger than that.
pub fn download(client: &reqwest::Client, url: &str, to: &Path, size: u64) -> Result<(), String> {
    let mut file = std::fs::File::create(to).map_err(|error| error.to_string())?;
    crate::host::tokio().block_on(async {
        let mut response = client.get(url).send().await.and_then(|response| response.error_for_status()).map_err(crate::platform::updates::problem)?;
        let mut written = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(crate::platform::updates::problem)? {
            written += chunk.len() as u64;
            if written > size {
                return Err(format!("{url} is larger than its manifest says"));
            }
            file.write_all(&chunk).map_err(|error| error.to_string())?;
        }
        file.sync_all().map_err(|error| error.to_string())
    })
}

/// Runs an installer quietly: it waits for this app to quit, installs over it, and with
/// `relaunch` starts it again.
pub fn run_installer(installer: &Path, relaunch: bool) -> bool {
    let mut command = std::process::Command::new(installer);
    command.arg("/S");
    if relaunch {
        command.arg("/relaunch");
    }
    // The update check's copy is installed wherever the check put it, never over the real one.
    // NSIS takes the folder as its last argument, unquoted.
    #[cfg(feature = "update-check")]
    if let Some(folder) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        use std::os::windows::process::CommandExt;
        command.raw_arg(format!("/D={}", folder.display()));
    }
    command.spawn().is_ok()
}

/// Who signed this program, if anyone did. It hashes all of the file, so it's asked off the
/// window's thread.
pub fn publisher(exe: &Path) -> Option<Signer> {
    signer(exe, false)
}

/// Who signed a downloaded file, by a signature that checks out and whose certificates
/// weren't revoked. Only the same publisher's counts, by the whole of its certificate's
/// subject and issuer: any CA could issue a certificate whose display name is the same.
pub fn signed_by(path: &Path) -> Option<Signer> {
    signer(path, true)
}

/// Whether a file's Authenticode signature checks out, and with `revocation` that no
/// certificate in its chain was revoked, which asks the CAs, so only a download does.
fn verified(path: &Path, revocation: bool) -> bool {
    let wide = HSTRING::from(path.as_os_str());
    unsafe {
        let mut file = WINTRUST_FILE_INFO { cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32, pcwszFilePath: PCWSTR(wide.as_ptr()), ..Default::default() };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: if revocation { WTD_REVOKE_WHOLECHAIN } else { WTD_REVOKE_NONE },
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

/// Who signed a file: the name on the signing certificate, and the whole of its subject and
/// of its issuer, which are what's compared.
#[derive(Clone, Debug, PartialEq)]
pub struct Signer {
    pub name: String,
    subject: String,
    issuer: String,
}

/// A certificate's name, subject or issuer, written out as X.500 names are.
unsafe fn name_of(blob: &CRYPT_INTEGER_BLOB) -> String {
    let mut text = vec![0u16; 1024];
    let length = unsafe { CertNameToStrW(X509_ASN_ENCODING, blob, CERT_X500_NAME_STR, Some(&mut text)) };
    if length > 1 { String::from_utf16_lossy(&text[..length as usize - 1]) } else { String::new() }
}

/// Who signed a file, as the signing certificate says.
fn signer_of(path: &Path) -> Option<Signer> {
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
            let details = &*(*certificate).pCertInfo;
            let (subject, issuer) = (name_of(&details.Subject), name_of(&details.Issuer));
            let _ = CertFreeCertificateContext(Some(certificate));
            (length > 1 && !subject.is_empty() && !issuer.is_empty()).then(|| Signer { name: String::from_utf16_lossy(&name[..length as usize - 1]), subject, issuer })
        })();
        let _ = CryptMsgClose(Some(message));
        let _ = CertCloseStore(Some(store), 0);
        found
    }
}

/// Who signed a file whose signature checks out.
fn signer(path: &Path, revocation: bool) -> Option<Signer> {
    if !verified(path, revocation) {
        return None;
    }
    signer_of(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With ZUNA_SIGNED_EXE naming a signed program, its publisher is read from its certificate.
    #[test]
    fn reads_a_signed_program_s_publisher() {
        let Some(path) = std::env::var_os("ZUNA_SIGNED_EXE") else { return };
        let expected = std::env::var("ZUNA_SIGNED_BY").unwrap_or_default();
        assert_eq!(signer(Path::new(&path), false).map(|signer| signer.name).as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn an_unsigned_build_has_no_publisher() {
        let exe = std::env::current_exe().unwrap();
        assert_eq!(signer(&exe, false), None);
    }
}
