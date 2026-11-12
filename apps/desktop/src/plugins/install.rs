//! Asking before a plugin is installed: what's proposed waits here while the install dialog
//! (ui/plugins/install.rs) shows what it can do, and goes in only on the person's word. No
//! plugin can install, turn on, update or remove a plugin, or answer this: only Settings proposes,
//! from a file, a folder or the marketplace, and only the dialog confirms.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::Context;

use super::manifest::{Manifest, Permission};
use super::package::Package;
use super::store::Origin;
use super::{Plugins, trust};

/// Where what's proposed comes from.
#[derive(Clone)]
pub enum Source {
    File(Arc<Vec<u8>>),
    Folder(PathBuf),
    Market(String),
}

/// What the install dialog shows.
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub source: Source,
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    pub verified: bool,
    pub permissions: Vec<Permission>,
    pub hosts: Vec<String>,
    /// For a new version: the version installed, and what this one asks for that it didn't.
    pub update_of: Option<(String, Vec<Permission>, Vec<String>)>,
}

impl Proposal {
    fn of(id: u64, source: Source, manifest: &Manifest, verified: bool, installed: Option<&Manifest>) -> Proposal {
        Proposal {
            id,
            source,
            name: manifest.name.clone(),
            author: manifest.author.name.clone(),
            version: manifest.version.clone(),
            description: manifest.description.clone(),
            verified,
            permissions: manifest.sorted_permissions(),
            hosts: manifest.hosts.clone(),
            update_of: installed.map(|older| {
                let (permissions, hosts) = manifest.more_than(older);
                (older.version.clone(), permissions, hosts)
            }),
        }
    }

    /// What it can do, in the dialogs' words, worst first.
    pub fn told(&self) -> Vec<(String, bool)> {
        let manifest_like = (self.permissions.contains(&Permission::MessagesRead) || self.permissions.contains(&Permission::FilesRead)) && self.permissions.contains(&Permission::Network);
        let mut lines = Vec::new();
        if manifest_like {
            lines.push((format!("Read your messages and send them to {}", self.hosts.join(", ")), true));
        }
        for permission in &self.permissions {
            let line = if *permission == Permission::Network { format!("Contact {}: each learns your address and whatever the plugin sends", self.hosts.join(", ")) } else { permission.told().to_string() };
            lines.push((line, permission.strong()));
        }
        lines
    }
}

impl Plugins {
    fn propose(&mut self, proposal: Proposal, cx: &mut Context<Self>) -> u64 {
        let id = proposal.id;
        self.proposal = Some(proposal);
        if let Some(state) = crate::state::try_store(cx) {
            cx.defer(move |cx| state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::PluginInstall { id }), cx)));
        }
        id
    }

    fn next_proposal(&mut self) -> u64 {
        self.next_proposal += 1;
        self.next_proposal
    }

    fn installed_manifest(&self, origin: Origin, id: &str) -> Option<Manifest> {
        self.loaded.get(&super::store::uid(origin, id)).map(|loaded| loaded.manifest().clone())
    }

    /// Proposes a package from a file the person picked or dropped on the Plugins page.
    pub fn propose_file(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) -> Result<u64, String> {
        if !self.usable() {
            return Err("Plugins can't be installed, as this device's key couldn't be read.".into());
        }
        let package = Package::open(&bytes)?;
        let verified = trust::verified(&package);
        if !verified && !self.record.allow_unverified {
            return Err("This plugin isn't one Zuna checked. To install it anyway, turn on \"Allow plugins Zuna hasn't checked\" under Advanced first.".into());
        }
        if package.sha256.as_ref().is_some_and(|hash| self.record.revoked_hashes.contains(hash)) || self.market.revoked(&package) {
            return Err("Zuna withdrew this plugin as harmful.".into());
        }
        let origin = if verified { Origin::Verified } else { Origin::File };
        let installed = self.installed_manifest(origin, &package.manifest.id);
        let id = self.next_proposal();
        let proposal = Proposal::of(id, Source::File(Arc::new(bytes)), &package.manifest, verified, installed.as_ref());
        Ok(self.propose(proposal, cx))
    }

    /// Proposes a developer's folder: the dialog once for each folder, then it loads as it changes.
    pub fn propose_folder(&mut self, dir: PathBuf, cx: &mut Context<Self>) -> Result<(), String> {
        if !self.record.allow_unverified {
            return Err("Turn on \"Allow plugins Zuna hasn't checked\" under Advanced first.".into());
        }
        let package = Package::open_folder(&dir)?;
        let known = self.record.plugins.iter().any(|plugin| plugin.origin == Origin::Folder && std::path::Path::new(&plugin.path) == dir && plugin.id == package.manifest.id);
        if known {
            return self.load_folder(&dir, cx).map(|_| ());
        }
        let installed = self.installed_manifest(Origin::Folder, &package.manifest.id);
        let id = self.next_proposal();
        let proposal = Proposal::of(id, Source::Folder(dir), &package.manifest, false, installed.as_ref());
        self.propose(proposal, cx);
        Ok(())
    }

    /// Proposes the newest version of a plugin on the marketplace, from what the index says of it.
    pub fn propose_market(&mut self, plugin: &str, cx: &mut Context<Self>) -> Result<(), String> {
        let Some(index) = self.market.index.as_ref() else { return Err("The marketplace isn't loaded.".into()) };
        let Some((entry, version)) = index.newest(plugin).map(|(entry, version)| (entry.clone(), version.clone())) else { return Err("No version of it runs in this Zuna.".into()) };
        let permissions: Vec<Permission> = version.permissions.iter().filter_map(|name| Permission::parse(name)).collect();
        if permissions.len() != version.permissions.len() {
            return Err("It asks for something this Zuna doesn't know.".into());
        }
        let mut sorted = permissions.clone();
        sorted.sort();
        let installed = self.installed_manifest(Origin::Verified, plugin);
        let id = self.next_proposal();
        let proposal = Proposal {
            id,
            source: Source::Market(plugin.to_string()),
            name: entry.name.clone(),
            author: entry.author.clone(),
            version: version.version.clone(),
            description: entry.summary.clone(),
            verified: true,
            permissions: sorted.clone(),
            hosts: version.hosts.clone(),
            update_of: installed.map(|older| {
                let more: Vec<Permission> = sorted.iter().copied().filter(|permission| !older.has(*permission)).collect();
                let hosts = version.hosts.iter().filter(|host| !older.hosts.contains(host)).cloned().collect();
                (older.version.clone(), more, hosts)
            }),
        };
        self.propose(proposal, cx);
        Ok(())
    }

    /// The person agreed in the dialog.
    pub fn confirm(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(proposal) = self.proposal.take().filter(|proposal| proposal.id == id) else { return };
        let result = match proposal.source {
            Source::File(bytes) => self.install(&bytes, None, cx).map(|_| ()),
            Source::Folder(dir) => self.load_folder(&dir, cx).map(|_| ()),
            Source::Market(plugin) => {
                self.install_from_market(&plugin, cx);
                Ok(())
            }
        };
        match result {
            Ok(()) => self.toast_app(format!("{} is installed.", proposal.name), crate::state::ToastKind::Info, cx),
            Err(error) => self.toast_app(error, crate::state::ToastKind::Error, cx),
        }
        cx.notify();
    }

    pub fn cancel(&mut self, id: u64) {
        if self.proposal.as_ref().is_some_and(|proposal| proposal.id == id) {
            self.proposal = None;
        }
    }
}
