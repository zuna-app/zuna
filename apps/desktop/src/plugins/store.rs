//! What's installed, and each plugin's own data.
//!
//! `plugins/installed.sealed` holds each plugin's id, version, hash, where it came from, what it
//! was granted and whether it's on, with the switch for unverified plugins, the highest index
//! serial seen and what that index withdrew, sealed with a key made from the device key, as what
//! decides whom to trust is. A package is kept in `plugins/packages` and hashed again each time it's loaded, so one
//! swapped on disk doesn't run.
//!
//! `plugins.db` holds each plugin's storage and settings, every value sealed with a key made from
//! the device key and the plugin's uid, so a plugin from a file that borrows a verified plugin's
//! id never reads its data. Removing a plugin removes its data.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::manifest::Permission;

/// Where a plugin came from, which keeps verified ones and the rest apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// From the marketplace or a file, signed with the plugins' key.
    Verified,
    /// From a file, unsigned.
    File,
    /// A developer's folder, run as it's written.
    Folder,
}

impl Origin {
    pub fn name(self) -> &'static str {
        match self {
            Origin::Verified => "verified",
            Origin::File => "file",
            Origin::Folder => "folder",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub id: String,
    pub origin: Origin,
    pub name: String,
    pub version: String,
    /// The package's SHA-256, in hex. A folder has none.
    pub sha256: Option<String>,
    /// The package's file name in plugins/packages, or a folder's path.
    pub path: String,
    pub granted: Vec<Permission>,
    pub hosts: Vec<String>,
    pub enabled: bool,
    /// Why it was turned off, when the app turned it off rather than the person.
    #[serde(default)]
    pub off_reason: Option<String>,
    pub installed_at: f64,
}

impl Installed {
    /// What it's known by: its origin and id, so the same id from two places are two plugins.
    pub fn uid(&self) -> String {
        uid(self.origin, &self.id)
    }

    pub fn verified(&self) -> bool {
        self.origin == Origin::Verified
    }
}

pub fn uid(origin: Origin, id: &str) -> String {
    format!("{}:{id}", origin.name())
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Record {
    pub plugins: Vec<Installed>,
    /// "Allow plugins Zuna hasn't checked", off until the person turns it on.
    pub allow_unverified: bool,
    /// The highest serial of an index the app has taken, so an older one can't bring back a withdrawn plugin.
    pub seen_serial: u64,
    /// Packages withdrawn by their hash, as the last index said, which never load again.
    pub revoked_hashes: Vec<String>,
    /// Verified plugins withdrawn by their id, as the last index said, kept so they stay
    /// withdrawn after a restart and while the index can't be read.
    pub revoked_plugins: Vec<Withdrawn>,
}

/// A plugin the marketplace's index withdrew by its id: every version of it, or those it names.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Withdrawn {
    pub id: String,
    /// None for every version.
    pub versions: Option<Vec<String>>,
    pub reason: String,
}

impl Withdrawn {
    pub fn covers(&self, id: &str, version: &str) -> bool {
        self.id == id && self.versions.as_ref().is_none_or(|versions| versions.iter().any(|item| item == version))
    }
}

/// The keys plugins' data is sealed with, made from the device key, which isn't kept here.
#[derive(Clone)]
pub struct Keys {
    installed: Vec<u8>,
    storage: Vec<u8>,
}

impl Keys {
    pub fn from_device_key(device_key: &[u8]) -> Keys {
        let derive = |info: &str| zuna_crypto::primitives::hkdf_sha256(device_key, &[], info.as_bytes(), 32).unwrap_or_default();
        Keys { installed: derive("zuna/plugins/installed/v1"), storage: derive("zuna/plugins/storage/v1") }
    }

    fn for_plugin(&self, uid: &str) -> Vec<u8> {
        zuna_crypto::primitives::hkdf_sha256(&self.storage, &[], format!("zuna/plugins/storage/v1|{uid}").as_bytes(), 32).unwrap_or_default()
    }
}

const INSTALLED_AAD: &[u8] = b"zuna/plugins/installed/v1";

pub fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join("plugins")
}

pub fn packages(data_dir: &Path) -> PathBuf {
    folder(data_dir).join("packages")
}

impl Record {
    /// Reads what's installed. One that can't be opened, as after the device key changed, is
    /// nothing installed: the plugins are gone from the app, and their packages stay on disk.
    pub fn load(data_dir: &Path, keys: &Keys) -> Record {
        let Ok(sealed) = std::fs::read(folder(data_dir).join("installed.sealed")) else { return Record::default() };
        match zuna_crypto::primitives::aead_open(&keys.installed, &sealed, INSTALLED_AAD) {
            Ok(json) => serde_json::from_slice(&json).unwrap_or_else(|error| {
                log::warn!("the list of installed plugins couldn't be read: {error}");
                Record::default()
            }),
            Err(_) => {
                log::warn!("the list of installed plugins couldn't be opened, so none are loaded");
                Record::default()
            }
        }
    }

    pub fn save(&self, data_dir: &Path, keys: &Keys) {
        let Ok(json) = serde_json::to_vec(self) else { return };
        let Ok(sealed) = zuna_crypto::primitives::aead_seal(&keys.installed, &json, INSTALLED_AAD) else { return };
        std::fs::create_dir_all(folder(data_dir)).ok();
        if let Err(error) = crate::host::write_whole(&folder(data_dir).join("installed.sealed"), &sealed) {
            log::warn!("couldn't save the list of installed plugins: {error}");
        }
    }

    pub fn find(&self, uid: &str) -> Option<&Installed> {
        self.plugins.iter().find(|plugin| plugin.uid() == uid)
    }

    pub fn find_mut(&mut self, uid: &str) -> Option<&mut Installed> {
        self.plugins.iter_mut().find(|plugin| plugin.uid() == uid)
    }
}

/// How much of its own a plugin may keep.
pub const MAX_VALUE: usize = 512 << 10;
pub const MAX_TOTAL: usize = 4 << 20;
pub const MAX_KEYS: usize = 2000;
pub const MAX_KEY: usize = 200;

struct QuotaState {
    sizes: HashMap<(Kind, String), usize>,
    total: usize,
}

/// The plugins' database, of storage and settings.
pub struct Storage {
    db: rusqlite::Connection,
    keys: Keys,
    derived_keys: Mutex<HashMap<String, Vec<u8>>>,
    quotas: Mutex<HashMap<String, QuotaState>>,
}

/// Which of a plugin's two stores a value is in.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Storage,
    Settings,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Storage => "storage",
            Kind::Settings => "settings",
        }
    }

    fn parse(name: &str) -> Option<Kind> {
        match name {
            "storage" => Some(Kind::Storage),
            "settings" => Some(Kind::Settings),
            _ => None,
        }
    }
}

impl Storage {
    pub fn open(path: &Path, keys: Keys) -> Result<Storage, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let db = rusqlite::Connection::open(path).map_err(|error| error.to_string())?;
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; CREATE TABLE IF NOT EXISTS kv (plugin TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (plugin, kind, key));")
            .map_err(|error| error.to_string())?;
        Ok(Storage { db, keys, derived_keys: Mutex::new(HashMap::new()), quotas: Mutex::new(HashMap::new()) })
    }

    fn plugin_key(&self, uid: &str) -> Vec<u8> {
        let mut cache = self.derived_keys.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(key) = cache.get(uid) {
            return key.clone();
        }
        let key = self.keys.for_plugin(uid);
        cache.insert(uid.to_string(), key.clone());
        key
    }

    fn aad(uid: &str, kind: Kind, key: &str) -> Vec<u8> {
        let kind_name = kind.name();
        let mut buf = Vec::with_capacity(uid.len() + 1 + kind_name.len() + 1 + key.len());
        buf.extend_from_slice(uid.as_bytes());
        buf.push(0);
        buf.extend_from_slice(kind_name.as_bytes());
        buf.push(0);
        buf.extend_from_slice(key.as_bytes());
        buf
    }

    /// Everything a plugin keeps of a kind, opened. A value that won't open is left out.
    pub fn load(&self, uid: &str, kind: Kind) -> BTreeMap<String, Value> {
        let key = self.plugin_key(uid);
        let mut out = BTreeMap::new();
        let Ok(mut statement) = self.db.prepare_cached("SELECT key, value FROM kv WHERE plugin = ? AND kind = ?") else { return out };
        let kind_name = kind.name();
        let mut aad = Vec::with_capacity(uid.len() + 1 + kind_name.len() + 1 + 64);
        aad.extend_from_slice(uid.as_bytes());
        aad.push(0);
        aad.extend_from_slice(kind_name.as_bytes());
        aad.push(0);
        let prefix_len = aad.len();
        let rows = statement.query_map(rusqlite::params![uid, kind_name], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)));
        if let Ok(rows) = rows {
            for (name, sealed) in rows.flatten() {
                aad.truncate(prefix_len);
                aad.extend_from_slice(name.as_bytes());
                let Ok(json) = zuna_crypto::primitives::aead_open(&key, &sealed, &aad) else { continue };
                if let Ok(value) = serde_json::from_slice(&json) {
                    out.insert(name, value);
                }
            }
        }
        out
    }

    /// Keeps a value, within the plugin's quota.
    pub fn set(&self, uid: &str, kind: Kind, name: &str, value: &Value) -> Result<(), String> {
        if name.is_empty() || name.len() > MAX_KEY {
            return Err("A key must be 1 to 200 bytes.".into());
        }
        let json = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        if json.len() > MAX_VALUE {
            return Err("That's more than one value can hold (512 KB).".into());
        }
        let mut quotas = self.quotas.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = if let Some(state) = quotas.get_mut(uid) {
            state
        } else {
            let mut sizes = HashMap::new();
            let mut total = 0usize;
            let mut stmt = self.db.prepare_cached("SELECT kind, key, LENGTH(value) FROM kv WHERE plugin = ?").map_err(|error| error.to_string())?;
            let rows = stmt.query_map(rusqlite::params![uid], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))).map_err(|error| error.to_string())?;
            for row in rows {
                let (k_str, k_name, len) = row.map_err(|error| error.to_string())?;
                if let Some(k) = Kind::parse(&k_str) {
                    let len = len.max(0) as usize;
                    total += len;
                    sizes.insert((k, k_name), len);
                }
            }
            quotas.entry(uid.to_string()).or_insert(QuotaState { sizes, total })
        };
        let lookup = (kind, name.to_string());
        let existing = state.sizes.get(&lookup).copied();
        let other_count = state.sizes.len() - usize::from(existing.is_some());
        let other_total = state.total - existing.unwrap_or(0);
        if other_count >= MAX_KEYS || other_total + json.len() > MAX_TOTAL {
            return Err("The plugin's storage is full (4 MB).".into());
        }
        let sealed = zuna_crypto::primitives::aead_seal(&self.plugin_key(uid), &json, &Storage::aad(uid, kind, name)).map_err(|error| error.to_string())?;
        let mut stmt = self
            .db
            .prepare_cached("INSERT INTO kv (plugin, kind, key, value) VALUES (?, ?, ?, ?) ON CONFLICT (plugin, kind, key) DO UPDATE SET value = excluded.value")
            .map_err(|error| error.to_string())?;
        stmt.execute(rusqlite::params![uid, kind.name(), name, &sealed]).map_err(|error| error.to_string())?;
        state.total = other_total + sealed.len();
        state.sizes.insert(lookup, sealed.len());
        Ok(())
    }

    pub fn delete(&self, uid: &str, kind: Kind, name: &str) -> Result<(), String> {
        let mut stmt = self.db.prepare_cached("DELETE FROM kv WHERE plugin = ? AND kind = ? AND key = ?").map_err(|error| error.to_string())?;
        stmt.execute(rusqlite::params![uid, kind.name(), name]).map_err(|error| error.to_string())?;
        let mut quotas = self.quotas.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(state) = quotas.get_mut(uid) {
            if let Some(old) = state.sizes.remove(&(kind, name.to_string())) {
                state.total = state.total.saturating_sub(old);
            }
        }
        Ok(())
    }

    /// Everything a plugin kept, as it's removed.
    pub fn remove_all(&self, uid: &str) {
        if let Ok(mut stmt) = self.db.prepare_cached("DELETE FROM kv WHERE plugin = ?") {
            stmt.execute(rusqlite::params![uid]).ok();
        }
        self.quotas.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(uid);
        self.derived_keys.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(uid);
    }
}
