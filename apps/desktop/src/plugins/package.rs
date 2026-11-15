//! A plugin's package, `<id>-<version>.zunaplugin`: a zip with a fixed layout, read whole into
//! memory and never unpacked to disk.
//!
//! ```text
//! plugin.json        the manifest
//! main.js            one bundled script
//! assets/            icons, images, sounds, theme files
//! signature          a verified plugin's signature, absent otherwise
//! ```
//!
//! The app refuses a package over 8 MB, packed or unpacked, with a path outside this layout,
//! with a name that climbs out of its folder, with more than `MAX_FILES` files, or whose
//! manifest doesn't parse exactly. A developer's folder is read the same way, from the files
//! `zuna-plugin build` leaves in it.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::manifest::Manifest;
use crate::i18n::t;

/// The most a package may be, packed or unpacked.
pub const MAX_PACKAGE: usize = 8 << 20;
pub const MAX_FILES: usize = 200;
const MAX_DEPTH: usize = 6;

/// What a package's signature starts with, which nothing else Zuna signs does.
pub const PACKAGE_LABEL: &str = "zuna-plugin-package/v1\n";

/// A package, read and checked, whose signature isn't checked yet (`trust.rs` does that).
#[derive(Clone, Debug)]
pub struct Package {
    pub manifest: Manifest,
    /// Every file by its path, `signature` left out.
    pub files: BTreeMap<String, Vec<u8>>,
    /// The signature's bytes, decoded from the `signature` file, if there was one.
    pub signature: Option<Vec<u8>>,
    /// The SHA-256 of the package's bytes, in hex, which installed.sealed and revocations name it by. A folder has none.
    pub sha256: Option<String>,
}

/// Why a path can't be in a package, or None if it can.
pub fn bad_path(name: &str) -> Option<String> {
    if matches!(name, "plugin.json" | "main.js" | "signature") {
        return None;
    }
    if !name.starts_with("assets/") {
        return Some(tr!("plugins.package.outsideLayout", name = name));
    }
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() > MAX_DEPTH + 1 {
        return Some(tr!("plugins.package.tooDeep", name = name));
    }
    if parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..") {
        return Some(tr!("plugins.package.notPlain", name = name));
    }
    if !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-')) {
        return Some(tr!("plugins.package.badCharacters", name = name));
    }
    None
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Package {
    /// Reads a package from its bytes.
    pub fn open(bytes: &[u8]) -> Result<Package, String> {
        if bytes.len() > MAX_PACKAGE {
            return Err(t("plugins.package.tooLarge").into());
        }
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| t("plugins.package.notPackage").to_string())?;
        if archive.len() > MAX_FILES + 1 {
            return Err(tr!("plugins.package.tooManyFiles", count = MAX_FILES));
        }
        let mut files = BTreeMap::new();
        let mut total = 0usize;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|_| t("plugins.package.damaged").to_string())?;
            let name = entry.name().map(|name| name.to_string()).map_err(|_| t("plugins.package.unreadableName").to_string())?;
            // Folders come in some zips as their own entries, which hold nothing.
            if entry.is_dir() {
                let folder = name.trim_end_matches('/');
                if folder == "assets" || bad_path(folder).is_none() && folder.starts_with("assets/") {
                    continue;
                }
                return Err(tr!("plugins.package.outsideLayout", name = name));
            }
            if entry.is_symlink() {
                return Err(tr!("plugins.package.link", name = name));
            }
            if let Some(problem) = bad_path(&name) {
                return Err(problem);
            }
            // What's read is counted as it comes, not as the zip says it will be, so a small
            // package that unpacks to gigabytes stops at the limit.
            let mut data = Vec::new();
            let left = MAX_PACKAGE.saturating_sub(total) as u64 + 1;
            (&mut entry).take(left).read_to_end(&mut data).map_err(|_| tr!("plugins.package.doesntUnpack", name = name))?;
            total += data.len();
            if total > MAX_PACKAGE {
                return Err(t("plugins.package.unpacksTooLarge").into());
            }
            if files.insert(name.clone(), data).is_some() {
                return Err(tr!("plugins.package.twice", name = name));
            }
        }
        let mut package = Package::from_files(files, false)?;
        package.sha256 = Some(sha256_hex(bytes));
        Ok(package)
    }

    /// Reads a developer's folder: plugin.json, the script `zuna-plugin build` made (dist/main.js, or main.js
    /// beside the manifest), and assets/.
    pub fn open_folder(dir: &Path) -> Result<Package, String> {
        let read = |path: PathBuf| std::fs::read(&path).map_err(|error| tr!("plugins.package.couldntRead", path = path.display(), error = error));
        let mut files = BTreeMap::new();
        files.insert("plugin.json".to_string(), read(dir.join("plugin.json"))?);
        let built = [dir.join("dist").join("main.js"), dir.join("main.js")].into_iter().find(|path| path.is_file());
        if let Some(path) = built {
            files.insert("main.js".to_string(), read(path)?);
        }
        let mut total: usize = files.values().map(Vec::len).sum();
        let mut stack = vec![dir.join("assets")];
        while let Some(folder) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&folder) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                if kind.is_symlink() {
                    return Err(tr!("plugins.package.folderLink", path = path.display()));
                }
                if kind.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = path.strip_prefix(dir).map_err(|_| t("plugins.package.outsideFolder").to_string())?.to_string_lossy().replace('\\', "/");
                if let Some(problem) = bad_path(&name) {
                    return Err(problem);
                }
                let data = read(path)?;
                total += data.len();
                if total > MAX_PACKAGE || files.len() >= MAX_FILES {
                    return Err(t("plugins.package.folderTooLarge").into());
                }
                files.insert(name, data);
            }
        }
        let mut package = Package::from_files(files, true)?;
        // A script the manifest names and the folder lacks is said plainly: it isn't built yet.
        if package.manifest.scripted() && !package.files.contains_key("main.js") {
            return Err(t("plugins.package.notBuilt").into());
        }
        package.signature = None;
        Ok(package)
    }

    fn from_files(mut files: BTreeMap<String, Vec<u8>>, folder: bool) -> Result<Package, String> {
        let manifest = Manifest::parse(files.get("plugin.json").ok_or(t("plugins.package.noManifest"))?)?;
        let signature = match files.remove("signature") {
            Some(text) => {
                use base64::Engine;
                let text = String::from_utf8(text).map_err(|_| t("plugins.package.badSignature").to_string())?;
                Some(base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|_| t("plugins.package.badSignature").to_string())?)
            }
            None => None,
        };
        if !manifest.scripted() && files.contains_key("main.js") {
            return Err(t("plugins.package.unlistedScript").into());
        }
        if manifest.scripted() && !files.contains_key("main.js") && !folder {
            return Err(t("plugins.package.missingScript").into());
        }
        if let Some(icon) = &manifest.icon {
            if !files.contains_key(icon) {
                return Err(t("plugins.package.missingIcon").into());
            }
        }
        Ok(Package { manifest, files, signature, sha256: None })
    }

    /// What its signature covers: the label, then each file's SHA-256 and path, by path.
    pub fn signed_message(&self) -> Vec<u8> {
        let mut message = PACKAGE_LABEL.to_string();
        for (name, data) in &self.files {
            message.push_str(&sha256_hex(data));
            message.push(' ');
            message.push_str(name);
            message.push('\n');
        }
        message.into_bytes()
    }

    pub fn script(&self) -> Option<String> {
        self.files.get("main.js").map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    }

    /// One of its assets, by its path under the package.
    pub fn asset(&self, path: &str) -> Option<&[u8]> {
        if !path.starts_with("assets/") || bad_path(path).is_some() {
            return None;
        }
        self.files.get(path).map(Vec::as_slice)
    }
}
