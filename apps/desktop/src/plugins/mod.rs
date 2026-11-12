//! Plugins: packages someone installs into the app to change it, each run in a host process of
//! its own (host/), behind the broker (broker.rs), which checks every request against what the
//! person granted. docs/PLUGINS.md says how to write one, and docs/SECURITY_DETAILS.md how it's kept
//! from what it shouldn't reach.
//!
//! `Plugins` is the app's side of all of it: what's installed and granted (store.rs), the
//! packages read and checked (package.rs, trust.rs), the host processes running, what each plugin
//! registered in the interface's slots, the decorations it gave messages, and the filters it
//! put on what the app sends.

pub mod broker;
pub mod host;
pub mod install;
pub mod manifest;
pub mod market;
pub mod net;
pub mod package;
pub mod process;
pub mod protocol;
pub mod store;
pub mod surface;
pub mod trust;
pub mod view;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::channel::{mpsc, oneshot};
use gpui::{App, AppContext, Context, Entity, Task};
use serde_json::{Value, json};

use manifest::{Manifest, Permission};
use package::Package;
use store::{Installed, Keys, Origin, Record, Storage};

/// How much a plugin's runtime may hold, how deep its stack may go, and how long one piece of its
/// script may run without yielding.
pub const MEMORY: usize = 64 << 20;
pub const STACK: usize = 1 << 20;
pub const SLICE_MS: u64 = 1000;
/// How long the app waits on each kind of answer.
const FILTER_DEADLINE: Duration = Duration::from_millis(1500);
const QUICK_DEADLINE: Duration = Duration::from_millis(500);
const DECORATE_DEADLINE: Duration = Duration::from_secs(3);
const CALL_DEADLINE: Duration = Duration::from_secs(10);
/// How long after the person used a plugin it may open a dialog, a panel or a page, put text in
/// the message box, or use the clipboard or a file dialog.
const ACTIVATION: Duration = Duration::from_secs(10);
/// Failures in a row that turn a plugin off.
const STRIKES: u32 = 3;
const MAX_LOG: usize = 500;

/// A plugin installed, with its package read and checked.
#[derive(Clone)]
pub struct Loaded {
    pub record: Installed,
    pub package: Arc<Package>,
}

impl Loaded {
    pub fn manifest(&self) -> &Manifest {
        &self.package.manifest
    }
}

/// What a plugin put in one of the interface's places.
#[derive(Clone, Debug, PartialEq)]
pub struct Slot {
    pub id: String,
    pub title: String,
    pub icon: String,
    pub hover: bool,
    pub width: f32,
}

/// Everything a plugin registered, which empties as it stops.
#[derive(Clone, Default)]
pub struct Slots {
    pub settings_view: bool,
    pub panels: BTreeMap<String, Slot>,
    pub pages: BTreeMap<String, Slot>,
    pub header_buttons: BTreeMap<String, Slot>,
    pub composer_buttons: BTreeMap<String, Slot>,
    pub message_actions: BTreeMap<String, Slot>,
    pub conversation_actions: BTreeMap<String, Slot>,
    pub dialog: Option<Slot>,
    pub views: HashMap<String, view::Node>,
}

/// A kind of filter, each on something the app is about to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FilterKind {
    /// A message going out, or an edit: `messages.intercept`.
    Outgoing,
    /// Saying the person is typing: `activity.intercept`.
    Typing,
    /// Marking messages read: `activity.intercept`.
    Read,
    /// Showing someone typing: `activity.intercept`.
    TypingShown,
    /// Notifying of a message: `notifications`, with `messages.read`.
    Notify,
}

impl FilterKind {
    fn parse(name: &str) -> Option<FilterKind> {
        match name {
            "outgoing" => Some(FilterKind::Outgoing),
            "typing" => Some(FilterKind::Typing),
            "read" => Some(FilterKind::Read),
            "typingShown" => Some(FilterKind::TypingShown),
            "notify" => Some(FilterKind::Notify),
            _ => None,
        }
    }

    fn needs(self) -> &'static [Permission] {
        match self {
            FilterKind::Outgoing => &[Permission::MessagesIntercept],
            FilterKind::Typing | FilterKind::Read | FilterKind::TypingShown => &[Permission::ActivityIntercept],
            FilterKind::Notify => &[Permission::Notifications, Permission::MessagesRead],
        }
    }

    fn deadline(self) -> Duration {
        match self {
            FilterKind::Outgoing | FilterKind::Notify => FILTER_DEADLINE,
            _ => QUICK_DEADLINE,
        }
    }
}

/// What filters decided.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    /// Go ahead, with what may have been changed.
    Go(Value),
    /// A plugin stopped it: its name.
    Stopped(String),
    /// A plugin that must answer didn't, so it's held: its name.
    Held(String),
}

/// What a plugin did to a message's look here.
#[derive(Clone, Debug, PartialEq)]
pub struct Decoration {
    pub uid: String,
    pub name: String,
    pub verified: bool,
    pub text: Option<String>,
    pub hidden: bool,
    pub mark: Option<(Option<String>, String)>,
    pub view: Option<(String, view::Node)>,
}

/// A line in a plugin's log, which a developer's folder shows.
#[derive(Clone, Debug)]
pub struct LogLine {
    pub level: String,
    pub text: String,
}

/// A host process running, and what it registered.
struct Running {
    process: process::Process,
    generation: u64,
    ready: bool,
    pending: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    next_call: u64,
    strikes: u32,
    subscriptions: HashSet<String>,
    filters: HashMap<String, (FilterKind, bool)>,
    decorates: bool,
    activated_until: Option<Instant>,
    toasts: VecDeque<Instant>,
    /// Stopping on purpose, so its pipe closing isn't a crash.
    stopping: bool,
}

pub struct Plugins {
    data_dir: PathBuf,
    keys: Option<Keys>,
    pub record: Record,
    storage: Option<Storage>,
    /// Why plugins aren't running this time, if they aren't: `--no-plugins`, or two failed starts.
    pub safe_mode: Option<String>,
    pub loaded: BTreeMap<String, Loaded>,
    /// Plugins installed that didn't load this time, and why.
    pub problems: BTreeMap<String, String>,
    running: HashMap<String, Running>,
    pub slots: HashMap<String, Slots>,
    pub logs: HashMap<String, VecDeque<LogLine>>,
    /// Plugins' panels, pages and dialogs by a number of their own, which the app's state names them by.
    handles: Vec<(String, String, String)>,
    decorations: HashMap<String, Vec<Decoration>>,
    asked: HashSet<String>,
    /// Messages whose original the person asked to see, by their key.
    pub shown_original: HashSet<String>,
    /// Commands bound to keys: the keystroke, the plugin, the command.
    bound: Vec<(gpui::Keystroke, String, String)>,
    heard: mpsc::UnboundedSender<(String, u64, Option<String>)>,
    next_generation: u64,
    started: bool,
    /// When each folder's files last changed, to load it again when they do.
    folder_stamps: HashMap<String, std::time::SystemTime>,
    pub market: market::Market,
    /// What the install dialog is asking about.
    pub proposal: Option<install::Proposal>,
    next_proposal: u64,
    _tasks: Vec<Task<()>>,
}

/// The plugins' entity, shared by every view.
#[derive(Clone)]
pub struct PluginStore(pub Entity<Plugins>);

impl gpui::Global for PluginStore {}

pub fn get(cx: &App) -> Option<Entity<Plugins>> {
    cx.try_global::<PluginStore>().map(|store| store.0.clone())
}

/// Starts the plugins' side of the app, as it starts. Plugins themselves start once the window
/// is up and the core has booted, so they never slow the start. `device_key` is None when it
/// couldn't be read, and then nothing of plugins loads.
pub fn init(device_key: Option<&[u8]>, no_plugins: bool, cx: &mut App) -> Entity<Plugins> {
    let data_dir = crate::host::data_dir();
    let plugins = cx.new(|cx| Plugins::new(data_dir, device_key, no_plugins, cx));
    cx.set_global(PluginStore(plugins.clone()));
    plugins
}

thread_local! {
    /// Messages a view drew whose decorations aren't known yet, gathered for the next ask.
    static WANTED: RefCell<Vec<(String, String, Value)>> = const { RefCell::new(Vec::new()) };
    static WAKE: RefCell<Option<mpsc::UnboundedSender<()>>> = const { RefCell::new(None) };
}

impl Plugins {
    fn new(data_dir: PathBuf, device_key: Option<&[u8]>, no_plugins: bool, cx: &mut Context<Self>) -> Plugins {
        let keys = device_key.map(Keys::from_device_key);
        let record = keys.as_ref().map(|keys| Record::load(&data_dir, keys)).unwrap_or_default();
        let storage = keys.clone().and_then(|keys| Storage::open(&data_dir.join("plugins.db"), keys).map_err(|error| log::warn!(target: "plugins", "plugins.db didn't open: {error}")).ok());
        let (heard, mut hearing) = mpsc::unbounded::<(String, u64, Option<String>)>();
        let mut tasks = Vec::new();
        tasks.push(cx.spawn(async move |this, cx| {
            use futures::StreamExt;
            while let Some((uid, generation, message)) = hearing.next().await {
                if this.update(cx, |plugins, cx| plugins.heard(&uid, generation, message, cx)).is_err() {
                    break;
                }
            }
        }));
        let (wake, mut woken) = mpsc::unbounded::<()>();
        WAKE.with(|slot| *slot.borrow_mut() = Some(wake));
        tasks.push(cx.spawn(async move |this, cx| {
            use futures::StreamExt;
            while woken.next().await.is_some() {
                // A frame's worth of messages at once.
                cx.background_executor().timer(Duration::from_millis(16)).await;
                while futures::FutureExt::now_or_never(woken.next()).flatten().is_some() {}
                if this.update(cx, |plugins, cx| plugins.ask_decorations(cx)).is_err() {
                    break;
                }
            }
        }));
        let safe_mode = if no_plugins {
            Some("Zuna was started with --no-plugins, so no plugin is running.".to_string())
        } else if record.plugins.iter().any(|plugin| plugin.enabled) && failed_starts(&data_dir) >= 2 {
            Some("Zuna didn't finish starting twice in a row with plugins on, so it started without them this time.".to_string())
        } else {
            None
        };
        let mut plugins = Plugins {
            data_dir,
            keys,
            record,
            storage,
            safe_mode,
            loaded: BTreeMap::new(),
            problems: BTreeMap::new(),
            running: HashMap::new(),
            slots: HashMap::new(),
            logs: HashMap::new(),
            handles: Vec::new(),
            decorations: HashMap::new(),
            asked: HashSet::new(),
            shown_original: HashSet::new(),
            bound: Vec::new(),
            heard,
            next_generation: 1,
            started: false,
            folder_stamps: HashMap::new(),
            market: market::Market::default(),
            proposal: None,
            next_proposal: 0,
            _tasks: tasks,
        };
        plugins.load_all();
        // Each developer's folder is looked at once a second, and loaded again when its files change.
        plugins._tasks.push(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |plugins, cx| plugins.watch_folders(cx)).is_err() {
                    break;
                }
            }
        }));
        plugins
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Whether plugins can be installed here at all: the device key was read.
    pub fn usable(&self) -> bool {
        self.keys.is_some()
    }

    fn save(&self) {
        if let Some(keys) = &self.keys {
            self.record.save(&self.data_dir, keys);
        }
    }

    /// Reads every installed plugin's package, checking it again: its hash for a file, its signature for a verified one.
    fn load_all(&mut self) {
        self.loaded.clear();
        self.problems.clear();
        for record in self.record.plugins.clone() {
            match self.read_package(&record) {
                Ok(package) => {
                    self.loaded.insert(record.uid(), Loaded { record, package: Arc::new(package) });
                }
                Err(problem) => {
                    self.problems.insert(record.uid(), problem);
                }
            }
        }
    }

    fn read_package(&self, record: &Installed) -> Result<Package, String> {
        let package = match record.origin {
            Origin::Folder => Package::open_folder(Path::new(&record.path))?,
            Origin::Verified | Origin::File => {
                let path = store::packages(&self.data_dir).join(&record.path);
                let bytes = std::fs::read(&path).map_err(|_| "Its package is missing.".to_string())?;
                let package = Package::open(&bytes)?;
                if package.sha256.as_deref() != record.sha256.as_deref() {
                    return Err("Its package changed on disk since it was installed, so it doesn't run.".into());
                }
                if record.origin == Origin::Verified && !trust::verified(&package) {
                    return Err("Its package isn't signed by Zuna any more, so it doesn't run.".into());
                }
                package
            }
        };
        if package.manifest.id != record.id {
            return Err("Its package is of another plugin.".into());
        }
        if let Some(hash) = &package.sha256 {
            if self.record.revoked_hashes.contains(hash) {
                return Err("Zuna withdrew this plugin as harmful.".into());
            }
        }
        if package.manifest.min_build > crate::platform::BUILD && crate::platform::BUILD > 0 {
            return Err("It needs a newer Zuna.".into());
        }
        // What it was granted is what it asked for at install: a package asking for more doesn't get it.
        if package.manifest.permissions.iter().any(|permission| !record.granted.contains(permission)) || package.manifest.hosts.iter().any(|host| !record.hosts.contains(host)) {
            if record.origin != Origin::Folder {
                return Err("It asks for more than it was granted.".into());
            }
        }
        Ok(package)
    }

    // --- Starting and stopping ---

    /// Starts every plugin that's on, once the app is ready, unless in safe mode.
    pub fn start_all(&mut self, cx: &mut Context<Self>) {
        if self.started {
            return;
        }
        self.started = true;
        if let Some(reason) = self.safe_mode.clone() {
            self.toast_app(reason, crate::state::ToastKind::Info, cx);
            return;
        }
        // A device with a verified plugin looks for its updates and withdrawals now and then, at
        // the same host as the app's own updates. One with none never asks.
        self._tasks.push(cx.spawn(async move |this, cx| {
            loop {
                let wanted = this.update(cx, |plugins, cx| {
                    if plugins.wants_market() {
                        plugins.refresh_market(cx);
                    }
                });
                if wanted.is_err() {
                    break;
                }
                cx.background_executor().timer(market::CHECK_EVERY).await;
            }
        }));
        let enabled: Vec<String> = self.loaded.values().filter(|loaded| loaded.record.enabled).map(|loaded| loaded.record.uid()).collect();
        if !enabled.is_empty() {
            note_start(&self.data_dir);
            // Starting finished: the next start isn't a failed one.
            let dir = self.data_dir.clone();
            cx.spawn(async move |_, cx| {
                cx.background_executor().timer(Duration::from_secs(20)).await;
                started_well(&dir);
            })
            .detach();
        }
        for uid in enabled {
            self.start(&uid, cx);
        }
        self.refresh_theme(cx);
    }

    fn start(&mut self, uid: &str, cx: &mut Context<Self>) {
        if self.running.contains_key(uid) || self.safe_mode.is_some() {
            return;
        }
        let Some(loaded) = self.loaded.get(uid).cloned() else { return };
        self.slots.insert(uid.to_string(), Slots::default());
        self.bind_commands(uid, &loaded, cx);
        let Some(source) = loaded.package.script() else {
            // A theme alone runs nothing.
            cx.notify();
            return;
        };
        let (storage, settings) = self.data_of(uid, loaded.manifest());
        let generation = self.next_generation;
        self.next_generation += 1;
        let boot = json!({
            "t": "boot",
            "plugin": { "id": loaded.record.id, "version": loaded.manifest().version, "verified": loaded.record.verified(), "permissions": loaded.record.granted },
            "source": source,
            "settings": settings,
            "storage": storage,
            "limits": { "memory": MEMORY, "stack": STACK, "slice_ms": SLICE_MS },
        });
        let heard = self.heard.clone();
        let owner = uid.to_string();
        match process::Process::start(boot.to_string(), move |message| {
            heard.unbounded_send((owner.clone(), generation, message)).ok();
        }) {
            Ok(process) => {
                self.running.insert(
                    uid.to_string(),
                    Running {
                        process,
                        generation,
                        ready: false,
                        pending: HashMap::new(),
                        next_call: 1,
                        strikes: 0,
                        subscriptions: HashSet::new(),
                        filters: HashMap::new(),
                        decorates: false,
                        activated_until: None,
                        toasts: VecDeque::new(),
                        stopping: false,
                    },
                );
            }
            Err(error) => self.turn_off(uid, &format!("Its process didn't start: {error}"), cx),
        }
        cx.notify();
    }

    /// Ends a plugin's process, emptying its slots, at once.
    fn stop(&mut self, uid: &str, cx: &mut Context<Self>) {
        if let Some(mut running) = self.running.remove(uid) {
            running.stopping = true;
            for (_, reply) in running.pending.drain() {
                reply.send(Err("The plugin stopped.".into())).ok();
            }
        }
        self.slots.remove(uid);
        crate::ui::plugins::view::forget(uid);
        self.bound.retain(|(_, owner, _)| owner != uid);
        self.decorations.retain(|_, list| {
            list.retain(|decoration| decoration.uid != uid);
            true
        });
        // Whatever it had open goes.
        let handles: Vec<u32> = self.handles.iter().enumerate().filter(|(_, (owner, _, _))| owner == uid).map(|(index, _)| index as u32).collect();
        if let Some(state) = crate::state::try_store(cx) {
            cx.defer(move |cx| {
                state.update(cx, |state, cx| state.close_plugin_views(&handles, cx));
            });
        }
        cx.notify();
    }

    /// Turns a plugin off for a reason of the app's, saying so in a toast and in Settings.
    pub fn turn_off(&mut self, uid: &str, reason: &str, cx: &mut Context<Self>) {
        let name = self.name(uid);
        self.stop(uid, cx);
        if let Some(record) = self.record.find_mut(uid) {
            record.enabled = false;
            record.off_reason = Some(reason.to_string());
        }
        if let Some(loaded) = self.loaded.get_mut(uid) {
            loaded.record.enabled = false;
            loaded.record.off_reason = Some(reason.to_string());
        }
        self.save();
        self.log(uid, "error", format!("Turned off: {reason}"));
        let message = format!("{name} was turned off. {reason}");
        self.toast_app(message, crate::state::ToastKind::Error, cx);
        self.refresh_theme(cx);
    }

    /// The person's switch.
    pub fn set_enabled(&mut self, uid: &str, enabled: bool, cx: &mut Context<Self>) {
        if let Some(record) = self.record.find_mut(uid) {
            record.enabled = enabled;
            record.off_reason = None;
        }
        if let Some(loaded) = self.loaded.get_mut(uid) {
            loaded.record.enabled = enabled;
            loaded.record.off_reason = None;
        }
        self.save();
        if enabled {
            if !self.loaded.contains_key(uid) {
                self.load_all();
            }
            if self.started {
                self.start(uid, cx);
            }
        } else {
            self.stop(uid, cx);
        }
        self.refresh_theme(cx);
        cx.notify();
    }

    /// Removes a plugin, its package and everything it kept.
    pub fn remove(&mut self, uid: &str, cx: &mut Context<Self>) {
        self.stop(uid, cx);
        if let Some(record) = self.record.find(uid).cloned() {
            if record.origin != Origin::Folder {
                std::fs::remove_file(store::packages(&self.data_dir).join(&record.path)).ok();
            }
        }
        self.record.plugins.retain(|plugin| plugin.uid() != uid);
        self.loaded.remove(uid);
        self.problems.remove(uid);
        self.logs.remove(uid);
        if let Some(storage) = &self.storage {
            storage.remove_all(uid);
        }
        self.save();
        self.refresh_theme(cx);
        cx.notify();
    }

    // --- Installing ---

    /// Installs a package, or a new version of one, as the dialogs agreed to: verified wherever
    /// it came from if it carries a good signature, unverified otherwise, and then only with the
    /// switch on. Returns its uid.
    pub fn install(&mut self, bytes: &[u8], expected: Option<&market::Version>, cx: &mut Context<Self>) -> Result<String, String> {
        if !self.usable() {
            return Err("Plugins can't be installed, as this device's key couldn't be read.".into());
        }
        let package = Package::open(bytes)?;
        let verified = trust::verified(&package);
        if let Some(expected) = expected {
            market::matches(expected, &package)?;
            if !verified {
                return Err("The marketplace's package isn't signed by Zuna.".into());
            }
        }
        if !verified && !self.record.allow_unverified {
            return Err("Plugins Zuna hasn't checked are off. Turn them on in Settings → Plugins first.".into());
        }
        let hash = package.sha256.clone().unwrap_or_default();
        if self.record.revoked_hashes.contains(&hash) || self.market.revoked(&package) {
            return Err("Zuna withdrew this plugin as harmful.".into());
        }
        let origin = if verified { Origin::Verified } else { Origin::File };
        let manifest = package.manifest.clone();
        if manifest.min_build > crate::platform::BUILD && crate::platform::BUILD > 0 {
            return Err("It needs a newer Zuna.".into());
        }
        let file = format!("{}-{}-{}.zunaplugin", origin.name(), manifest.id, manifest.version);
        std::fs::create_dir_all(store::packages(&self.data_dir)).map_err(|error| error.to_string())?;
        crate::host::write_whole(&store::packages(&self.data_dir).join(&file), bytes).map_err(|error| error.to_string())?;
        let uid = store::uid(origin, &manifest.id);
        let previous = self.record.find(&uid).cloned();
        if let Some(previous) = &previous {
            if previous.path != file {
                std::fs::remove_file(store::packages(&self.data_dir).join(&previous.path)).ok();
            }
        }
        let record = Installed {
            id: manifest.id.clone(),
            origin,
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            sha256: Some(hash),
            path: file,
            granted: manifest.permissions.clone(),
            hosts: manifest.hosts.clone(),
            enabled: true,
            off_reason: None,
            installed_at: crate::format::now_ms(),
        };
        self.stop(&uid, cx);
        self.record.plugins.retain(|plugin| plugin.uid() != uid);
        self.record.plugins.push(record.clone());
        self.save();
        self.problems.remove(&uid);
        self.loaded.insert(uid.clone(), Loaded { record, package: Arc::new(package) });
        if self.started {
            self.start(&uid, cx);
        }
        self.refresh_theme(cx);
        cx.notify();
        Ok(uid)
    }

    /// Runs a developer's folder, as it's written, behind the same broker and the same mark.
    pub fn load_folder(&mut self, dir: &Path, cx: &mut Context<Self>) -> Result<String, String> {
        if !self.record.allow_unverified {
            return Err("Plugins Zuna hasn't checked are off. Turn them on first.".into());
        }
        let package = Package::open_folder(dir)?;
        let manifest = package.manifest.clone();
        let uid = store::uid(Origin::Folder, &manifest.id);
        let record = Installed {
            id: manifest.id.clone(),
            origin: Origin::Folder,
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            sha256: None,
            path: dir.to_string_lossy().into_owned(),
            granted: manifest.permissions.clone(),
            hosts: manifest.hosts.clone(),
            enabled: true,
            off_reason: None,
            installed_at: crate::format::now_ms(),
        };
        self.stop(&uid, cx);
        self.record.plugins.retain(|plugin| plugin.uid() != uid);
        self.record.plugins.push(record.clone());
        self.save();
        self.problems.remove(&uid);
        self.loaded.insert(uid.clone(), Loaded { record, package: Arc::new(package) });
        self.folder_stamps.insert(uid.clone(), folder_stamp(dir));
        if self.started {
            self.start(&uid, cx);
        }
        self.refresh_theme(cx);
        cx.notify();
        Ok(uid)
    }

    fn watch_folders(&mut self, cx: &mut Context<Self>) {
        let folders: Vec<(String, PathBuf)> = self.record.plugins.iter().filter(|plugin| plugin.origin == Origin::Folder && plugin.enabled).map(|plugin| (plugin.uid(), PathBuf::from(&plugin.path))).collect();
        for (uid, dir) in folders {
            let stamp = folder_stamp(&dir);
            match self.folder_stamps.get(&uid) {
                Some(seen) if *seen == stamp => continue,
                None => {
                    self.folder_stamps.insert(uid, stamp);
                    continue;
                }
                _ => {}
            }
            self.folder_stamps.insert(uid.clone(), stamp);
            match Package::open_folder(&dir) {
                Ok(package) => {
                    self.log(&uid, "info", "Its files changed, so it was loaded again.".into());
                    self.stop(&uid, cx);
                    if let Some(loaded) = self.loaded.get_mut(&uid) {
                        loaded.package = Arc::new(package);
                    }
                    self.problems.remove(&uid);
                    if self.started {
                        self.start(&uid, cx);
                    }
                }
                Err(problem) => {
                    self.log(&uid, "error", problem.clone());
                    self.problems.insert(uid, problem);
                }
            }
            self.refresh_theme(cx);
            cx.notify();
        }
    }

    pub fn set_allow_unverified(&mut self, allow: bool, cx: &mut Context<Self>) {
        self.record.allow_unverified = allow;
        self.save();
        cx.notify();
    }

    // --- What the interface asks ---

    pub fn name(&self, uid: &str) -> String {
        self.loaded.get(uid).map(|loaded| loaded.manifest().name.clone()).or_else(|| self.record.find(uid).map(|record| record.name.clone())).unwrap_or_else(|| "A plugin".into())
    }

    pub fn verified(&self, uid: &str) -> bool {
        self.loaded.get(uid).is_some_and(|loaded| loaded.record.verified())
    }

    pub fn running(&self, uid: &str) -> bool {
        self.running.get(uid).is_some_and(|running| running.ready)
    }

    pub fn granted(&self, uid: &str, permission: Permission) -> bool {
        self.loaded.get(uid).is_some_and(|loaded| loaded.record.granted.contains(&permission) && loaded.manifest().has(permission))
    }

    /// Each running plugin's slots of one kind, with whose they are.
    pub fn each_slot(&self, pick: impl Fn(&Slots) -> &BTreeMap<String, Slot>) -> Vec<(String, Slot)> {
        let mut out = Vec::new();
        for (uid, slots) in &self.slots {
            if !self.running(uid) {
                continue;
            }
            for slot in pick(slots).values() {
                out.push((uid.clone(), slot.clone()));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.id.cmp(&b.1.id)));
        out
    }

    pub fn view(&self, uid: &str, view_id: &str) -> Option<&view::Node> {
        self.slots.get(uid)?.views.get(view_id)
    }

    /// The number the app's state names a plugin's panel, page or dialog by.
    pub fn handle(&mut self, uid: &str, kind: &str, id: &str) -> u32 {
        if let Some(index) = self.handles.iter().position(|(owner, k, slot)| owner == uid && k == kind && slot == id) {
            return index as u32;
        }
        self.handles.push((uid.to_string(), kind.to_string(), id.to_string()));
        (self.handles.len() - 1) as u32
    }

    /// Whose panel, page or dialog a number is: the plugin, the kind and the id.
    pub fn of_handle(&self, handle: u32) -> Option<(String, String, String)> {
        self.handles.get(handle as usize).cloned()
    }

    /// A handler in a plugin's view was used: a click, a change, Enter.
    pub fn handler(&mut self, uid: &str, id: String, value: Value, cx: &mut Context<Self>) {
        self.activate(uid);
        self.fire(uid, "handler", json!({ "id": id, "value": value }), cx);
    }

    /// One of a plugin's buttons or menu entries was pressed.
    pub fn action(&mut self, uid: &str, kind: &str, id: &str, target: Value, cx: &mut Context<Self>) {
        self.activate(uid);
        let call_kind = if matches!(kind, "headerButton" | "composerButton") { "context" } else { "target" };
        self.fire(uid, "action", json!({ "id": format!("{kind}:{id}"), "kind": call_kind, "target": target }), cx);
    }

    /// Runs a plugin's command, from its keys or as a slash command.
    pub fn run_command(&mut self, uid: &str, command: &str, args: &str, cx: &mut Context<Self>) {
        self.activate(uid);
        let context = self.context_for(uid, args, cx);
        self.fire(uid, "command", json!({ "id": command, "context": context }), cx);
    }

    /// Where a command or button was used from, as the plugin may know it.
    pub fn context_for(&self, uid: &str, args: &str, cx: &App) -> Value {
        let conversation = if self.granted(uid, Permission::ConversationsRead) {
            crate::state::try_store(cx).and_then(|state| {
                let state = state.read(cx);
                let server = state.active()?;
                let conversation = server.active_conversation()?;
                Some(json!({ "serverId": server.entry.id, "key": conversation.key, "groupId": conversation.group_id, "name": conversation.title }))
            })
        } else {
            None
        };
        json!({ "conversation": conversation, "args": args })
    }

    /// The command a slash command names, if a running plugin has one: its plugin and id.
    pub fn slash(&self, name: &str) -> Option<(String, String)> {
        self.loaded.iter().filter(|(uid, _)| self.running(uid)).find_map(|(uid, loaded)| loaded.manifest().contributes.commands.iter().find(|command| command.slash.as_deref() == Some(name)).map(|command| (uid.clone(), command.id.clone())))
    }

    /// Every slash command, for the message box's suggestions: name, title, plugin.
    pub fn slash_commands(&self) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for (uid, loaded) in &self.loaded {
            if !self.running(uid) {
                continue;
            }
            for command in &loaded.manifest().contributes.commands {
                if let Some(slash) = &command.slash {
                    out.push((slash.clone(), command.title.clone(), loaded.manifest().name.clone()));
                }
            }
        }
        out.sort();
        out
    }

    /// The command bound to a keystroke, if any.
    pub fn command_for(&self, keystroke: &gpui::Keystroke) -> Option<(String, String)> {
        self.bound.iter().find(|(bound, uid, _)| bound.key == keystroke.key && bound.modifiers == keystroke.modifiers && self.running(uid)).map(|(_, uid, id)| (uid.clone(), id.clone()))
    }

    fn bind_commands(&mut self, uid: &str, loaded: &Loaded, cx: &App) {
        for command in &loaded.manifest().contributes.commands {
            let Some(keys) = &command.keys else { continue };
            let Ok(keystroke) = gpui::Keystroke::parse(lasting(keys)) else {
                self.log(uid, "warn", format!("{keys} isn't a keystroke, so {} has no keys.", command.id));
                continue;
            };
            let taken = !cx.all_bindings_for_input(std::slice::from_ref(&keystroke)).is_empty() || self.bound.iter().any(|(bound, _, _)| bound.key == keystroke.key && bound.modifiers == keystroke.modifiers);
            if taken {
                self.log(uid, "warn", format!("{keys} is taken, so {} isn't bound to it.", command.id));
                continue;
            }
            self.bound.push((keystroke, uid.to_string(), command.id.clone()));
        }
    }

    // --- Talking to a plugin ---

    fn send(&self, uid: &str, message: Value) {
        if let Some(running) = self.running.get(uid) {
            running.process.send(message.to_string());
        }
    }

    /// Asks a plugin to run something, answered through the receiver, or an error once it stops.
    fn call(&mut self, uid: &str, function: &str, args: Value) -> Option<oneshot::Receiver<Result<Value, String>>> {
        let running = self.running.get_mut(uid).filter(|running| running.ready)?;
        let n = running.next_call;
        running.next_call += 1;
        let (reply, wait) = oneshot::channel();
        running.pending.insert(n, reply);
        running.process.send(json!({ "t": "call", "n": n, "fn": function, "args": args }).to_string());
        Some(wait)
    }

    /// Calls a plugin without waiting on it, logging what went wrong, and counting a call it never answers.
    fn fire(&mut self, uid: &str, function: &str, args: Value, cx: &mut Context<Self>) {
        let Some(wait) = self.call(uid, function, args) else { return };
        let owner = uid.to_string();
        cx.spawn(async move |this, cx| {
            let result = within(cx, CALL_DEADLINE, wait).await;
            this.update(cx, |plugins, cx| match result {
                Some(Ok(_)) => plugins.cleared(&owner),
                Some(Err(error)) => plugins.log(&owner, "error", error),
                None => plugins.strike(&owner, false, cx),
            })
            .ok();
        })
        .detach();
    }

    fn event(&self, uid: &str, name: &str, data: Value) {
        self.send(uid, json!({ "t": "event", "name": name, "data": data }));
    }

    /// The person just used this plugin, which lets it open what it draws for a moment.
    fn activate(&mut self, uid: &str) {
        if let Some(running) = self.running.get_mut(uid) {
            running.activated_until = Some(Instant::now() + ACTIVATION);
        }
    }

    pub(crate) fn activated(&self, uid: &str) -> bool {
        self.running.get(uid).and_then(|running| running.activated_until).is_some_and(|until| Instant::now() < until)
    }

    /// A failure: a deadline missed, a filter that threw. Three in a row turn it off.
    fn strike(&mut self, uid: &str, toast: bool, cx: &mut Context<Self>) {
        let Some(running) = self.running.get_mut(uid) else { return };
        running.strikes += 1;
        let strikes = running.strikes;
        let name = self.name(uid);
        self.log(uid, "warn", format!("It didn't answer in time ({strikes} in a row)."));
        if strikes >= STRIKES {
            self.turn_off(uid, "It failed to answer in time three times in a row.", cx);
        } else if toast {
            self.toast_app(format!("{name} didn't answer in time, so Zuna went on without it."), crate::state::ToastKind::Error, cx);
        }
    }

    fn cleared(&mut self, uid: &str) {
        if let Some(running) = self.running.get_mut(uid) {
            running.strikes = 0;
        }
    }

    pub(crate) fn log(&mut self, uid: &str, level: &str, text: String) {
        let log = self.logs.entry(uid.to_string()).or_default();
        if log.len() >= MAX_LOG {
            log.pop_front();
        }
        match level {
            "error" => log::warn!(target: "plugins", "{uid}: {text}"),
            _ => log::debug!(target: "plugins", "{uid}: {text}"),
        }
        log.push_back(LogLine { level: level.to_string(), text });
    }

    fn toast_app(&self, message: String, kind: crate::state::ToastKind, cx: &mut Context<Self>) {
        if let Some(state) = crate::state::try_store(cx) {
            cx.defer(move |cx| state.update(cx, |state, cx| state.toast(message, kind, cx)));
        }
    }

    /// What a host process said.
    fn heard(&mut self, uid: &str, generation: u64, message: Option<String>, cx: &mut Context<Self>) {
        if self.running.get(uid).is_none_or(|running| running.generation != generation) {
            return;
        }
        let Some(message) = message else {
            // The pipe closed without being asked to: it crashed.
            let stopping = self.running.get(uid).is_some_and(|running| running.stopping);
            if !stopping {
                self.turn_off(uid, "It stopped working.", cx);
            }
            return;
        };
        let Ok(message) = serde_json::from_str::<Value>(&message) else {
            self.turn_off(uid, "It sent what a plugin can't.", cx);
            return;
        };
        let kind = message.get("t").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "ready" => {
                if let Some(running) = self.running.get_mut(uid) {
                    running.ready = true;
                }
                self.log(uid, "info", "Started.".into());
                cx.notify();
            }
            "failed" => {
                let error = message.get("error").and_then(Value::as_str).unwrap_or("It didn't start.").chars().take(300).collect::<String>();
                self.turn_off(uid, &format!("It didn't start: {error}"), cx);
            }
            "ask" => {
                let n = message.get("n").and_then(Value::as_u64).unwrap_or(0);
                let op = message.get("op").and_then(Value::as_str).unwrap_or_default().to_string();
                let args = message.get("args").cloned().unwrap_or(Value::Null);
                self.ask(uid, n, &op, args, cx);
            }
            "done" => {
                let n = message.get("n").and_then(Value::as_u64).unwrap_or(0);
                let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(message.get("value").cloned().unwrap_or(Value::Null))
                } else {
                    Err(message.get("error").and_then(|error| error.get("message")).and_then(Value::as_str).unwrap_or("It failed.").chars().take(500).collect())
                };
                if let Some(reply) = self.running.get_mut(uid).and_then(|running| running.pending.remove(&n)) {
                    reply.send(result).ok();
                }
            }
            "log" => {
                let level = message.get("level").and_then(Value::as_str).unwrap_or("info").to_string();
                let text = message.get("text").and_then(Value::as_str).unwrap_or_default().chars().take(4000).collect();
                self.log(uid, &level, text);
                cx.notify();
            }
            "fault" => match message.get("reason").and_then(Value::as_str) {
                Some("memory") => self.turn_off(uid, "It used more memory than a plugin may.", cx),
                Some("flood") => self.turn_off(uid, "It sent more than a plugin may.", cx),
                _ => self.strike(uid, false, cx),
            },
            _ => self.turn_off(uid, "It sent what a plugin can't.", cx),
        }
    }

    pub(crate) fn reply(&self, uid: &str, n: u64, result: Result<Value, String>) {
        let message = match result {
            Ok(value) => json!({ "t": "reply", "n": n, "ok": true, "value": value }),
            Err(error) => json!({ "t": "reply", "n": n, "ok": false, "error": { "message": error } }),
        };
        self.send(uid, message);
    }

    // --- The plugin's own data ---

    fn data_of(&self, uid: &str, manifest: &Manifest) -> (Value, Value) {
        let Some(storage) = &self.storage else { return (json!({}), json!({})) };
        let kept = storage.load(uid, store::Kind::Storage);
        let saved = storage.load(uid, store::Kind::Settings);
        let mut settings = serde_json::Map::new();
        for spec in &manifest.contributes.settings {
            let value = saved.get(spec.key()).filter(|value| spec.takes(value)).cloned().unwrap_or_else(|| spec.default_value());
            settings.insert(spec.key().to_string(), value);
        }
        (json!(kept), Value::Object(settings))
    }

    /// A plugin's settings, as its section in Settings draws them.
    pub fn settings_of(&self, uid: &str) -> serde_json::Map<String, Value> {
        let Some(loaded) = self.loaded.get(uid) else { return serde_json::Map::new() };
        match self.data_of(uid, loaded.manifest()).1 {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        }
    }

    /// The person changed a plugin's setting in Settings.
    pub fn set_setting(&mut self, uid: &str, key: &str, value: Value, cx: &mut Context<Self>) {
        let Some(spec) = self.loaded.get(uid).and_then(|loaded| loaded.manifest().contributes.settings.iter().find(|spec| spec.key() == key).cloned()) else { return };
        if !spec.takes(&value) {
            return;
        }
        if let Some(storage) = &self.storage {
            if let Err(error) = storage.set(uid, store::Kind::Settings, key, &value) {
                self.toast_app(error, crate::state::ToastKind::Error, cx);
                return;
            }
        }
        self.event(uid, "settings", json!({ "key": key, "value": value }));
        self.forget_decorations();
        cx.notify();
    }

    /// Asks for every message's decorations again, as after a plugin's settings changed what it decorates.
    pub(crate) fn forget_decorations(&mut self) {
        self.decorations.clear();
        self.asked.clear();
    }

    pub(crate) fn storage(&self) -> Option<&Storage> {
        self.storage.as_ref()
    }

    // --- Themes ---

    /// Every theme of a plugin that's on: its key (uid/theme id), its name, and whose.
    pub fn themes(&self) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for (uid, loaded) in &self.loaded {
            if !loaded.record.enabled || self.safe_mode.is_some() || self.problems.contains_key(uid) {
                continue;
            }
            for theme in &loaded.manifest().contributes.themes {
                out.push((format!("{uid}/{}", theme.id), theme.name.clone(), loaded.manifest().name.clone()));
            }
        }
        out
    }

    /// The colors of the theme a key names, if its plugin is on.
    pub fn theme_colors(&self, key: &str) -> Option<BTreeMap<String, String>> {
        let (uid, id) = key.rsplit_once('/')?;
        let loaded = self.loaded.get(uid).filter(|loaded| loaded.record.enabled && self.safe_mode.is_none())?;
        loaded.manifest().contributes.themes.iter().find(|theme| theme.id == id).map(|theme| theme.colors.clone())
    }

    fn refresh_theme(&self, cx: &mut Context<Self>) {
        if let Some(state) = crate::state::try_store(cx) {
            cx.defer(move |cx| state.update(cx, |state, cx| state.refresh_theme(cx)));
        }
    }

    // --- Events ---

    /// Hands a core event to each plugin whose permissions cover its kind and that listens for it.
    pub fn core_event(&mut self, event: &Value) {
        let Some(kind) = event.get("type").and_then(Value::as_str) else { return };
        let rule = surface::surface().event(kind);
        let surface::Rule::Needs(permission) = rule else { return };
        let listeners: Vec<String> = self.running.iter().filter(|(uid, running)| running.ready && running.subscriptions.contains(kind) && self.granted(uid, permission)).map(|(uid, _)| uid.clone()).collect();
        if listeners.is_empty() {
            return;
        }
        let shared = broker::for_plugins(event);
        for uid in listeners {
            self.event(&uid, "core", json!({ "event": shared }));
        }
        // A message changed: its decorations are asked for again.
        if kind == "message" {
            if let (Some(server), Some(message)) = (event.get("serverId").and_then(Value::as_str), event.get("message")) {
                let prefix = format!("{server}/{}/{}/", message.get("groupId").and_then(Value::as_str).unwrap_or_default(), message.get("id").and_then(Value::as_str).unwrap_or_default());
                self.decorations.retain(|key, _| !key.starts_with(&prefix));
                self.asked.retain(|key| !key.starts_with(&prefix));
            }
        }
    }

    // --- Filters ---

    /// Every filter of a kind that would run, in order: the plugin, the filter's id, whether it's required, the plugin's name.
    fn filters_of(&self, kind: FilterKind) -> Vec<(String, String, bool, String)> {
        let mut out = Vec::new();
        for (uid, running) in &self.running {
            if !running.ready || !kind.needs().iter().all(|permission| self.granted(uid, *permission)) {
                continue;
            }
            for (id, (filter_kind, required)) in &running.filters {
                if *filter_kind == kind {
                    out.push((uid.clone(), id.clone(), *required, self.name(uid)));
                }
            }
        }
        out.sort();
        out
    }

    // --- Decorations ---

    fn ask_decorations(&mut self, cx: &mut Context<Self>) {
        let wanted: Vec<(String, String, Value)> = WANTED.with(|wanted| std::mem::take(&mut *wanted.borrow_mut()));
        let decorators: Vec<String> = self.running.iter().filter(|(uid, running)| running.ready && running.decorates && self.granted(uid, Permission::MessagesDecorate)).map(|(uid, _)| uid.clone()).collect();
        if wanted.is_empty() || decorators.is_empty() {
            return;
        }
        let fresh: Vec<(String, Value)> = wanted.into_iter().filter(|(key, _, _)| self.asked.insert(key.clone())).map(|(key, _, message)| (key, message)).collect();
        if self.decorations.len() > 5000 {
            self.decorations.clear();
            self.asked.clear();
        }
        for chunk in fresh.chunks(50) {
            let keys: Vec<String> = chunk.iter().map(|(key, _)| key.clone()).collect();
            let messages: Vec<Value> = chunk.iter().map(|(_, message)| message.clone()).collect();
            for uid in &decorators {
                let Some(wait) = self.call(uid, "decorate", json!({ "messages": messages })) else { continue };
                let (owner, keys) = (uid.clone(), keys.clone());
                cx.spawn(async move |this, cx| {
                    let result = within(cx, DECORATE_DEADLINE, wait).await;
                    this.update(cx, |plugins, cx| {
                        match result {
                            Some(Ok(Value::Array(items))) => {
                                plugins.cleared(&owner);
                                let (name, verified) = (plugins.name(&owner), plugins.verified(&owner));
                                for (key, item) in keys.iter().zip(items) {
                                    if let Some(decoration) = broker::decoration(&owner, &name, verified, key, &item) {
                                        let list = plugins.decorations.entry(key.clone()).or_default();
                                        list.retain(|existing| existing.uid != owner);
                                        list.push(decoration);
                                    }
                                }
                            }
                            Some(Ok(_)) => {}
                            Some(Err(error)) => plugins.log(&owner, "error", error),
                            None => plugins.strike(&owner, false, cx),
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
        }
    }

    /// What plugins did to a message's look here, asking for it the first time it's drawn.
    pub fn decorations_for(&self, server_id: &str, message: &crate::models::MessageView) -> Vec<Decoration> {
        if message.system.is_some() || message.deleted_at.is_some() || message.sender_id.is_empty() || message.id.starts_with("sys-") {
            return Vec::new();
        }
        if !self.running.values().any(|running| running.ready && running.decorates) {
            return Vec::new();
        }
        let key = decoration_key(server_id, message);
        if let Some(found) = self.decorations.get(&key) {
            return found.iter().filter(|decoration| self.running(&decoration.uid)).cloned().collect();
        }
        if !self.asked.contains(&key) {
            let shared = broker::plugin_message(server_id, &serde_json::to_value(message).unwrap_or_default());
            WANTED.with(|wanted| wanted.borrow_mut().push((key, server_id.to_string(), shared)));
            WAKE.with(|wake| {
                if let Some(wake) = wake.borrow().as_ref() {
                    wake.unbounded_send(()).ok();
                }
            });
        }
        Vec::new()
    }

    pub fn toggle_original(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.shown_original.remove(&key) {
            self.shown_original.insert(key);
        }
        cx.notify();
    }
}

/// A keystroke's text kept for the run, as GPUI parses only text that lasts: each once, however
/// often its plugin starts again.
fn lasting(keys: &str) -> &'static str {
    static KEPT: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    let mut kept = KEPT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(found) = kept.iter().find(|item| **item == keys) {
        return found;
    }
    let leaked: &'static str = Box::leak(keys.to_string().into_boxed_str());
    kept.push(leaked);
    leaked
}

/// A message's decorations are known by where it is and which edit it is.
pub fn decoration_key(server_id: &str, message: &crate::models::MessageView) -> String {
    format!("{server_id}/{}/{}/{}", message.group_id, message.id, message.edited_at.unwrap_or(0.) as u64)
}

/// Waits for an answer until a deadline: None if it didn't come in time.
async fn within(cx: &mut gpui::AsyncApp, deadline: Duration, wait: oneshot::Receiver<Result<Value, String>>) -> Option<Result<Value, String>> {
    use futures::FutureExt;
    let timer = cx.background_executor().timer(deadline).fuse();
    let wait = wait.fuse();
    futures::pin_mut!(timer, wait);
    futures::select! {
        result = wait => Some(result.unwrap_or_else(|_| Err("The plugin stopped.".into()))),
        _ = timer => None,
    }
}

/// Runs a kind of filter on what the app is about to do, through each plugin that has one, in
/// turn: None when none would, so the app goes on at once. A filter that throws or misses its
/// deadline is left out, and what it was asked about goes as it was, unless it's required, which
/// holds it.
pub fn filter(kind: FilterKind, payload: Value, cx: &mut App) -> Option<Task<Verdict>> {
    let plugins = get(cx)?;
    let filters = plugins.read(cx).filters_of(kind);
    if filters.is_empty() {
        return None;
    }
    Some(cx.spawn(async move |cx| {
        let mut payload = payload;
        for (uid, id, required, name) in filters {
            let args = json!({ "id": id, "payload": payload });
            let Some(wait) = cx.update(|cx| plugins.update(cx, |plugins, _| plugins.call(&uid, "filter", args))) else { continue };
            match within(cx, kind.deadline(), wait).await {
                Some(Ok(answer)) => {
                    cx.update(|cx| plugins.update(cx, |plugins, _| plugins.cleared(&uid)));
                    if answer.get("stop").and_then(Value::as_bool) == Some(true) {
                        return Verdict::Stopped(name);
                    }
                    match kind {
                        FilterKind::Outgoing => {
                            if let Some(text) = answer.get("text").and_then(Value::as_str) {
                                if text.trim().is_empty() || text.chars().count() > crate::ui::chat::MAX_TEXT_LENGTH {
                                    return Verdict::Stopped(name);
                                }
                                payload["text"] = json!(text);
                            }
                        }
                        FilterKind::Notify => {
                            for field in ["title", "body"] {
                                if let Some(text) = answer.get(field).and_then(Value::as_str) {
                                    payload[field] = json!(text.chars().take(500).collect::<String>());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Some(Err(error)) => {
                    cx.update(|cx| {
                        plugins.update(cx, |plugins, cx| {
                            plugins.log(&uid, "error", format!("Its filter failed: {error}"));
                            plugins.strike(&uid, !required, cx);
                        })
                    });
                    if required {
                        return Verdict::Held(name);
                    }
                }
                None => {
                    cx.update(|cx| plugins.update(cx, |plugins, cx| plugins.strike(&uid, !required, cx)));
                    if required {
                        return Verdict::Held(name);
                    }
                }
            }
        }
        Verdict::Go(payload)
    }))
}

/// Whether the person is being asked one of the app's own security questions, while which no
/// plugin's view is drawn: a new device of theirs, or a plugin's install dialog.
pub fn security_question_up(cx: &App) -> bool {
    let Some(state) = crate::state::try_store(cx) else { return false };
    let state = state.read(cx);
    state.servers.values().any(|server| !server.new_devices.is_empty()) || matches!(state.overlay, Some(crate::state::Overlay::PluginInstall { .. }) | Some(crate::state::Overlay::Verify { .. }))
}

fn folder_stamp(dir: &Path) -> std::time::SystemTime {
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    let mut stack = vec![dir.join("plugin.json"), dir.join("dist"), dir.join("main.js"), dir.join("assets")];
    while let Some(path) = stack.pop() {
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if let Ok(modified) = meta.modified() {
            newest = newest.max(modified);
        }
        if meta.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                stack.extend(entries.flatten().map(|entry| entry.path()));
            }
        }
    }
    newest
}

/// How many starts in a row didn't finish with plugins on.
fn failed_starts(data_dir: &Path) -> u32 {
    std::fs::read_to_string(store::folder(data_dir).join("starting")).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(0)
}

/// This start went well, by lasting 20 seconds or by quitting: the next isn't counted as after a failed one.
pub fn started_well(data_dir: &Path) {
    std::fs::remove_file(store::folder(data_dir).join("starting")).ok();
}

fn note_start(data_dir: &Path) {
    let count = failed_starts(data_dir) + 1;
    std::fs::create_dir_all(store::folder(data_dir)).ok();
    std::fs::write(store::folder(data_dir).join("starting"), count.to_string()).ok();
}
