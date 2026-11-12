//! The marketplace: a signed index in zuna-app/plugins, published as a release of that repository
//! with the packages beside it, on GitHub, where the app already goes for updates.
//!
//! The app checks, in order, as it does for an update: the index's signature, before anything in
//! it is read; that its serial isn't lower than the highest seen, so an old index can't bring back
//! a withdrawn plugin; then for a package, its size and SHA-256, its own signature, and that the
//! manifest inside says what the index said of it. GitHub and the connection are trusted for
//! nothing but being there. A device with no plugins never asks: only opening Browse, or having a
//! verified plugin installed, does.

use std::collections::HashMap;

use gpui::Context;
use serde::Deserialize;

use super::manifest::{API, Manifest, parse_version};
use super::package::{Package, sha256_hex};
use super::store::Origin;
use super::{Plugins, trust};

/// Where the index and the packages are.
const RELEASE: &str = "https://github.com/zuna-app/plugins/releases/download/plugins";
/// How often a device with a verified plugin looks for updates to it.
pub const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

fn release() -> String {
    #[cfg(feature = "plugin-check")]
    if let Ok(url) = std::env::var("ZUNA_PLUGIN_INDEX") {
        return url.trim_end_matches('/').to_string();
    }
    RELEASE.to_string()
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: String,
    pub api: u32,
    #[serde(default)]
    pub min_build: u32,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub permissions: Vec<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub icon: String,
    pub versions: Vec<Version>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Revoked {
    Hash { sha256: String, reason: String },
    Plugin { id: String, versions: RevokedVersions, reason: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum RevokedVersions {
    All(String),
    Some(Vec<String>),
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Index {
    pub serial: u64,
    #[serde(default)]
    pub made: String,
    pub plugins: Vec<Entry>,
    #[serde(default)]
    pub revoked: Vec<Revoked>,
}

impl Index {
    /// Why the index withdrew a plugin's version, if it did.
    pub fn revocation(&self, id: &str, version: &str, sha256: Option<&str>) -> Option<String> {
        self.revoked.iter().find_map(|revoked| match revoked {
            Revoked::Hash { sha256: hash, reason } => (Some(hash.as_str()) == sha256).then(|| reason.clone()),
            Revoked::Plugin { id: revoked_id, versions, reason } => {
                let hit = revoked_id == id
                    && match versions {
                        RevokedVersions::All(all) => all == "*",
                        RevokedVersions::Some(list) => list.iter().any(|item| item == version),
                    };
                hit.then(|| reason.clone())
            }
        })
    }

    /// The newest version of a plugin this app can run.
    pub fn newest(&self, id: &str) -> Option<(&Entry, &Version)> {
        let entry = self.plugins.iter().find(|entry| entry.id == id)?;
        entry
            .versions
            .iter()
            .filter(|version| version.api == API && (version.min_build <= crate::platform::BUILD || crate::platform::BUILD == 0) && self.revocation(id, &version.version, Some(&version.sha256)).is_none())
            .max_by_key(|version| parse_version(&version.version))
            .map(|version| (entry, version))
    }
}

/// What the app knows of the marketplace this run.
#[derive(Default)]
pub struct Market {
    pub index: Option<Index>,
    pub loading: bool,
    pub error: Option<String>,
    /// A plugin installing from the marketplace, by its id.
    pub installing: Option<String>,
    /// Updates that ask for more than the version installed, which wait for the person: by uid.
    pub waiting: HashMap<String, Version>,
    pub checked: Option<std::time::Instant>,
}

impl Market {
    /// Whether the index this run withdrew a package.
    pub fn revoked(&self, package: &Package) -> bool {
        self.index.as_ref().is_some_and(|index| index.revocation(&package.manifest.id, &package.manifest.version, package.sha256.as_deref()).is_some())
    }
}

/// Reads an index from its bytes and its signature, in the order the app checks them, against
/// the highest serial seen.
pub fn open_index(bytes: &[u8], signature: &str, keys: &[Vec<u8>], seen: u64) -> Result<Index, String> {
    if !trust::index_signed(bytes, signature, keys) {
        return Err("The marketplace's index isn't signed by Zuna.".into());
    }
    let index: Index = serde_json::from_slice(bytes).map_err(|_| "The marketplace's index can't be read.".to_string())?;
    if index.serial < seen {
        return Err("The marketplace's index is older than one this device has seen.".into());
    }
    Ok(index)
}

/// Whether a package is what the index said of it: its size, hash, signature, id, version, permissions and hosts.
pub fn matches(expected: &Version, package: &Package) -> Result<(), String> {
    matches_with(expected, package, &trust::keys())
}

pub fn matches_with(expected: &Version, package: &Package, keys: &[Vec<u8>]) -> Result<(), String> {
    let manifest: &Manifest = &package.manifest;
    if package.sha256.as_deref() != Some(expected.sha256.as_str()) {
        return Err("The package isn't the one the index names.".into());
    }
    if !trust::verified_with(package, keys) {
        return Err("The package isn't signed by Zuna.".into());
    }
    let permissions: Vec<&str> = manifest.permissions.iter().map(|permission| permission.name()).collect();
    let mut said: Vec<&str> = expected.permissions.iter().map(String::as_str).collect();
    let mut found = permissions.clone();
    said.sort();
    found.sort();
    if manifest.version != expected.version || said != found || manifest.hosts != expected.hosts {
        return Err("The package asks for something other than the index says.".into());
    }
    Ok(())
}

async fn fetch_bytes(url: String) -> Result<Vec<u8>, String> {
    crate::host::fetch(url).await
}

impl Plugins {
    /// Whether this device should look at the marketplace by itself: it has a verified plugin.
    pub fn wants_market(&self) -> bool {
        self.record.plugins.iter().any(|plugin| plugin.origin == Origin::Verified)
    }

    /// Reads the index again, and then withdraws, updates or offers what it says to.
    pub fn refresh_market(&mut self, cx: &mut Context<Self>) {
        if self.market.loading {
            return;
        }
        self.market.loading = true;
        self.market.error = None;
        cx.notify();
        let base = release();
        let seen = self.record.seen_serial;
        cx.spawn(async move |this, cx| {
            let fetched = async {
                let bytes = fetch_bytes(format!("{base}/index.json")).await?;
                let signature = fetch_bytes(format!("{base}/index.json.sig")).await?;
                open_index(&bytes, &String::from_utf8_lossy(&signature), &trust::keys(), seen)
            }
            .await;
            this.update(cx, |plugins, cx| {
                plugins.market.loading = false;
                plugins.market.checked = Some(std::time::Instant::now());
                match fetched {
                    Ok(index) => plugins.apply_index(index, cx),
                    Err(error) => {
                        log::warn!(target: "plugins", "the marketplace: {error}");
                        plugins.market.error = Some(error);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn apply_index(&mut self, index: Index, cx: &mut Context<Self>) {
        self.record.seen_serial = self.record.seen_serial.max(index.serial);
        self.record.revoked_hashes = index.revoked.iter().filter_map(|revoked| if let Revoked::Hash { sha256, .. } = revoked { Some(sha256.clone()) } else { None }).collect();
        self.save();
        // What's withdrawn is turned off wherever it came from: a verified one by id, anything by its hash.
        let installed: Vec<(String, String, String, Option<String>, Origin)> = self.record.plugins.iter().map(|plugin| (plugin.uid(), plugin.id.clone(), plugin.version.clone(), plugin.sha256.clone(), plugin.origin)).collect();
        for (uid, id, version, sha256, origin) in &installed {
            let by_id = if *origin == Origin::Verified { index.revocation(id, version, sha256.as_deref()) } else { None };
            let by_hash = sha256.as_deref().and_then(|hash| index.revocation("", "", Some(hash)));
            if let Some(reason) = by_id.or(by_hash) {
                if self.record.find(uid).is_some_and(|plugin| plugin.enabled) {
                    self.turn_off(uid, &format!("Zuna withdrew it: {reason}"), cx);
                }
                self.problems.insert(uid.clone(), format!("Zuna withdrew it: {reason}"));
            }
        }
        // Updates: one that asks for nothing more installs by itself, and one that does waits.
        self.market.waiting.clear();
        for (uid, id, version, _, origin) in installed {
            if origin != Origin::Verified || self.problems.contains_key(&uid) {
                continue;
            }
            let Some((_, newest)) = index.newest(&id) else { continue };
            if parse_version(&newest.version) <= parse_version(&version) {
                continue;
            }
            let Some(current) = self.loaded.get(&uid).map(|loaded| loaded.manifest().clone()) else { continue };
            let asks_more = newest.permissions.iter().any(|permission| !current.permissions.iter().any(|have| have.name() == permission)) || newest.hosts.iter().any(|host| !current.hosts.contains(host));
            if asks_more {
                self.market.waiting.insert(uid, newest.clone());
            } else {
                self.download(id, newest.clone(), false, cx);
            }
        }
        self.market.index = Some(index);
    }

    /// Installs a plugin from the marketplace, or updates it: the newest version this app can run.
    pub fn install_from_market(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(version) = self.market.index.as_ref().and_then(|index| index.newest(id)).map(|(_, version)| version.clone()) else { return };
        self.download(id.to_string(), version, true, cx);
    }

    fn download(&mut self, id: String, version: Version, asked: bool, cx: &mut Context<Self>) {
        if asked {
            self.market.installing = Some(id.clone());
        }
        let url = format!("{}/{}", release(), version.file);
        cx.spawn(async move |this, cx| {
            let bytes = fetch_bytes(url).await;
            this.update(cx, |plugins, cx| {
                if asked {
                    plugins.market.installing = None;
                }
                let result = bytes.and_then(|bytes| {
                    if bytes.len() as u64 != version.size || sha256_hex(&bytes) != version.sha256 {
                        return Err("The package isn't the one the index names.".to_string());
                    }
                    plugins.install(&bytes, Some(&version), cx)
                });
                match result {
                    Ok(uid) => {
                        plugins.market.waiting.remove(&uid);
                        if !asked {
                            plugins.log(&uid, "info", format!("Updated to {}.", version.version));
                        }
                    }
                    Err(error) => plugins.toast_app(format!("{id} couldn't be installed: {error}"), crate::state::ToastKind::Error, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
