//! The broker: the other end of each plugin's pipe, in the app. Every message from a plugin is a
//! request it checks before anything happens: is this plugin running, does what the person
//! granted cover it, are the arguments the shape and size they should be. It trusts nothing a
//! host process says about which plugin is asking beyond the pipe it came on, and what comes back
//! from a plugin is untrusted, as what arrives decrypted is.
//!
//! Some things no plugin gets, whatever it asks for: keys of any kind, passwords, sessions,
//! devices, verification, the question a new device raises, voice and video themselves, updates,
//! the disk, and other plugins. The core's methods are classified in the SDK's table (surface.rs);
//! what reaches the core by a request of the broker's own, as `messages.send` does, goes through
//! the same checks.

use std::time::{Duration, Instant};

use base64::Engine;
use gpui::Context;
use serde_json::{Value, json};

use super::manifest::Permission;
use super::store::{Kind, Origin};
use super::surface::{Rule, surface};
use super::{Decoration, FilterKind, Plugins, Slot, view};

/// The most a plugin may register of a kind, and how many filters it may have.
const MAX_SLOTS: usize = 10;
const MAX_FILTERS: usize = 20;
/// The most toasts and notifications a plugin may show in a while.
const MAX_TOASTS: usize = 5;
const TOAST_WINDOW: Duration = Duration::from_secs(10);
/// The most a core call's arguments may weigh.
const MAX_ARGS: usize = 256 << 10;

type Answer = Result<Value, String>;

fn needs(permission: Permission) -> String {
    format!("That needs the {} permission, which this plugin doesn't have.", permission.name())
}

fn text(args: &Value, name: &str) -> String {
    args.get(name).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn slot_id_ok(id: &str) -> bool {
    let mut bytes = id.bytes();
    (1..=40).contains(&id.len()) && bytes.next().is_some_and(|first| first.is_ascii_alphanumeric()) && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// Whether a value from a plugin holds a path on disk, which the core would read: `$file`.
fn holds_path(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.contains_key("$file") || map.values().any(holds_path),
        Value::Array(items) => items.iter().any(holds_path),
        _ => false,
    }
}

/// What a plugin may be told of a value from the core: no file's key or path, nor anything named
/// as a secret. An attachment's key would let whoever has it open the file from the server.
pub fn sanitize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            if map.contains_key("$file") {
                return Value::Null;
            }
            let attachment = map.contains_key("fileId");
            let mut out = serde_json::Map::new();
            for (key, item) in map {
                if attachment && matches!(key.as_str(), "key" | "prefix") {
                    continue;
                }
                if matches!(key.as_str(), "secret" | "itemSecret" | "sendKey" | "token" | "password" | "recoveryKey" | "seed") {
                    continue;
                }
                out.insert(key.clone(), sanitize(item));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize).collect()),
        other => other.clone(),
    }
}

/// A message as a plugin with `messages.read` is told of it. Who wrote it is the app's, from its signature.
pub fn plugin_message(server_id: &str, message: &Value) -> Value {
    let get = |name: &str| message.get(name).cloned().unwrap_or(Value::Null);
    let attachments: Vec<Value> = message
        .get("attachments")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|item| json!({ "name": item.get("name").cloned().unwrap_or(json!("")), "mime": item.get("mime").cloned().unwrap_or(json!("")), "size": item.get("size").cloned().unwrap_or(json!(0)) })).collect())
        .unwrap_or_default();
    json!({
        "serverId": server_id,
        "groupId": get("groupId"),
        "id": get("id"),
        "senderId": get("senderId"),
        "text": message.get("text").and_then(Value::as_str).unwrap_or_default(),
        "createdAt": get("createdAt"),
        "editedAt": get("editedAt"),
        "attachments": attachments,
    })
}

/// The list of servers as plugins are given it: without the linked Telegram account.
pub fn without_telegram(_: &str, value: Value) -> Value {
    match value {
        Value::Array(entries) => {
            sanitize(&Value::Array(entries.into_iter().filter(|entry| entry.get("kind").and_then(Value::as_str) != Some("telegram") && entry.get("id").and_then(Value::as_str) != Some(crate::telegram::SERVER_ID)).collect()))
        }
        other => sanitize(&other),
    }
}

/// A core event as plugins are told of it.
pub fn for_plugins(event: &Value) -> Value {
    let server = event.get("serverId").and_then(Value::as_str).unwrap_or_default();
    match event.get("type").and_then(Value::as_str) {
        Some("message") | Some("message_moved") => {
            let mut out = sanitize(event);
            if let Some(message) = event.get("message") {
                out["message"] = plugin_message(server, message);
            }
            out
        }
        _ => sanitize(event),
    }
}

/// Whether a plugin granted these may call a method of the core, as the table says: of a server's
/// session with `server`, of the client without.
pub fn may_call(granted: &[Permission], server: bool, method: &str) -> Result<(), String> {
    match surface().method(server, method) {
        Rule::Never => Err(format!("No plugin may call {method}.")),
        Rule::Needs(permission) if !granted.contains(&permission) => Err(needs(permission)),
        Rule::Needs(_) => Ok(()),
    }
}

/// A decoration a plugin answered for a message, read and held to its limits.
pub fn decoration(uid: &str, name: &str, verified: bool, key: &str, item: &Value) -> Option<Decoration> {
    if !item.is_object() {
        return None;
    }
    let text = item.get("text").and_then(Value::as_str).map(|text| text.chars().take(crate::ui::chat::MAX_TEXT_LENGTH).collect::<String>());
    let hidden = item.get("hidden").and_then(Value::as_bool).unwrap_or(false);
    let mark = item.get("mark").and_then(|mark| {
        let label: String = mark.get("label").and_then(Value::as_str)?.chars().take(40).collect();
        Some((view::icon_name(mark.get("icon")), label))
    });
    let view = item.get("view").filter(|view| !view.is_null()).and_then(|tree| view::parse(tree).ok()).map(|node| (key.to_string(), node));
    if text.is_none() && !hidden && mark.is_none() && view.is_none() {
        return None;
    }
    Some(Decoration { uid: uid.to_string(), name: name.to_string(), verified, text, hidden, mark, view })
}

impl Plugins {
    /// Answers one request from a plugin.
    pub(crate) fn ask(&mut self, uid: &str, n: u64, op: &str, args: Value, cx: &mut Context<Self>) {
        if !self.running.contains_key(uid) {
            return;
        }
        let answer = self.answer(uid, n, op, &args, cx);
        // A request answered later replies itself.
        if let Some(answer) = answer {
            if let Err(error) = &answer {
                self.log(uid, "warn", format!("Refused {op}: {error}"));
            }
            self.reply(uid, n, answer);
        }
    }

    fn grant(&self, uid: &str, permission: Permission) -> Result<(), String> {
        if self.granted(uid, permission) { Ok(()) } else { Err(needs(permission)) }
    }

    fn may_draw(&self, uid: &str, cx: &gpui::App) -> Result<(), String> {
        if !self.activated(uid) {
            return Err("A plugin opens what it draws only right after the person uses it.".into());
        }
        if super::security_question_up(cx) {
            return Err("Not while the app is asking the person something.".into());
        }
        Ok(())
    }

    fn rate(&mut self, uid: &str) -> Result<(), String> {
        let Some(running) = self.running.get_mut(uid) else { return Err("It isn't running.".into()) };
        let now = Instant::now();
        while running.toasts.front().is_some_and(|at| now.duration_since(*at) > TOAST_WINDOW) {
            running.toasts.pop_front();
        }
        if running.toasts.len() >= MAX_TOASTS {
            return Err("Too many at once.".into());
        }
        running.toasts.push_back(now);
        Ok(())
    }

    /// Checks a request and does it: Some(answer) now, or None when it answers later.
    fn answer(&mut self, uid: &str, n: u64, op: &str, args: &Value, cx: &mut Context<Self>) -> Option<Answer> {
        let state = crate::state::try_store(cx);
        Some(match op {
            "storage.set" => {
                let key = text(args, "key");
                let value = args.get("value").cloned().unwrap_or(Value::Null);
                match self.storage() {
                    Some(storage) => storage.set(uid, Kind::Storage, &key, &value).map(|_| Value::Null),
                    None => Err("Storage isn't open.".into()),
                }
            }
            "storage.delete" => match self.storage() {
                Some(storage) => storage.delete(uid, Kind::Storage, &text(args, "key")).map(|_| Value::Null),
                None => Err("Storage isn't open.".into()),
            },
            "settings.set" => {
                let key = text(args, "key");
                let value = args.get("value").cloned().unwrap_or(Value::Null);
                let spec = self.loaded.get(uid).and_then(|loaded| loaded.manifest().contributes.settings.iter().find(|spec| spec.key() == key).cloned());
                match (spec, self.storage()) {
                    (Some(spec), Some(storage)) if spec.takes(&value) => {
                        let saved = storage.set(uid, Kind::Settings, &key, &value).map(|_| Value::Null);
                        self.forget_decorations();
                        cx.notify();
                        saved
                    }
                    (Some(_), _) => Err("That isn't a value the setting takes.".into()),
                    (None, _) => Err("The manifest names no such setting.".into()),
                }
            }
            "ui.register" => self.register(uid, args, cx),
            "ui.view" => {
                let id = text(args, "id");
                let registered = self.slots.get(uid).is_some_and(|slots| match id.split_once(':') {
                    Some(("settings", _)) => slots.settings_view,
                    Some(("panel", slot)) => slots.panels.contains_key(slot),
                    Some(("page", slot)) => slots.pages.contains_key(slot),
                    Some(("dialog", _)) => slots.dialog.is_some(),
                    _ => false,
                });
                if !registered {
                    Err("No such view is registered.".into())
                } else {
                    match view::parse(args.get("tree").unwrap_or(&Value::Null)) {
                        Ok(node) => {
                            if let Some(slots) = self.slots.get_mut(uid) {
                                slots.views.insert(id, node);
                            }
                            cx.notify();
                            Ok(Value::Null)
                        }
                        Err(error) => Err(error),
                    }
                }
            }
            "ui.open" => {
                let kind = text(args, "kind");
                let id = text(args, "id");
                let registered = self.slots.get(uid).is_some_and(|slots| match kind.as_str() {
                    "panel" => slots.panels.contains_key(&id),
                    "page" => slots.pages.contains_key(&id),
                    "dialog" => slots.dialog.is_some(),
                    _ => false,
                });
                if !registered {
                    Err("No such thing is registered to open.".into())
                } else if let Err(error) = self.may_draw(uid, cx) {
                    Err(error)
                } else {
                    let handle = self.handle(uid, &kind, &id);
                    if let Some(state) = state {
                        cx.defer(move |cx| state.update(cx, |state, cx| state.open_plugin_view(&kind, handle, cx)));
                    }
                    Ok(Value::Null)
                }
            }
            "ui.close" => {
                let kind = text(args, "kind");
                let handles: Vec<u32> = (0..u32::MAX).map_while(|index| self.of_handle(index).map(|handle| (index, handle))).filter(|(_, (owner, k, _))| owner == uid && *k == kind).map(|(index, _)| index).collect();
                if let Some(state) = state {
                    cx.defer(move |cx| state.update(cx, |state, cx| state.close_plugin_views(&handles, cx)));
                }
                Ok(Value::Null)
            }
            "ui.toast" => {
                let message: String = text(args, "text").chars().take(200).collect();
                let kind = if text(args, "kind") == "error" { crate::state::ToastKind::Error } else { crate::state::ToastKind::Info };
                match self.rate(uid) {
                    Ok(()) => {
                        // Under the plugin's name, so it can't pass for the app's own.
                        let line = format!("{}: {message}", self.name(uid));
                        if let Some(state) = state {
                            cx.defer(move |cx| state.update(cx, |state, cx| state.toast(line, kind, cx)));
                        }
                        Ok(Value::Null)
                    }
                    Err(error) => Err(error),
                }
            }
            "ui.remove" => {
                let id = text(args, "id");
                if let Some(slots) = self.slots.get_mut(uid) {
                    for map in [&mut slots.panels, &mut slots.pages, &mut slots.header_buttons, &mut slots.composer_buttons, &mut slots.message_actions, &mut slots.conversation_actions] {
                        map.remove(&id);
                    }
                    slots.views.retain(|view, _| view.split_once(':').map(|(_, slot)| slot) != Some(id.as_str()));
                }
                cx.notify();
                Ok(Value::Null)
            }
            "composer.insert" => {
                if !self.activated(uid) {
                    Err("A plugin writes in the message box only right after the person uses it.".into())
                } else {
                    let insert: String = text(args, "text").chars().take(crate::ui::chat::MAX_TEXT_LENGTH).collect();
                    if let Some(state) = state {
                        cx.defer(move |cx| state.update(cx, |state, cx| state.insert_into_composer(insert, cx)));
                    }
                    Ok(Value::Null)
                }
            }
            "subscribe" => {
                let kind = text(args, "type");
                match surface().event(&kind) {
                    Rule::Needs(permission) if self.granted(uid, permission) => {
                        if let Some(running) = self.running.get_mut(uid) {
                            running.subscriptions.insert(kind);
                        }
                        Ok(Value::Null)
                    }
                    Rule::Needs(permission) => Err(needs(permission)),
                    Rule::Never => Err(format!("No plugin is told of {kind}.")),
                }
            }
            "filter.register" => {
                let id = text(args, "id");
                match FilterKind::parse(&text(args, "kind")) {
                    None => Err("No such filter.".into()),
                    Some(kind) => match kind.needs().iter().find(|permission| !self.granted(uid, **permission)) {
                        Some(permission) => Err(needs(*permission)),
                        None => {
                            let required = args.get("required").and_then(Value::as_bool).unwrap_or(false) && kind == FilterKind::Outgoing;
                            match self.running.get_mut(uid) {
                                Some(running) if running.filters.len() < MAX_FILTERS && !id.is_empty() && id.len() <= 60 => {
                                    running.filters.insert(id, (kind, required));
                                    Ok(Value::Null)
                                }
                                _ => Err("Too many filters.".into()),
                            }
                        }
                    },
                }
            }
            "filter.unregister" => {
                if let Some(running) = self.running.get_mut(uid) {
                    running.filters.remove(&text(args, "id"));
                }
                Ok(Value::Null)
            }
            "decorate.register" => self.grant(uid, Permission::MessagesDecorate).map(|_| {
                if let Some(running) = self.running.get_mut(uid) {
                    running.decorates = true;
                }
                self.forget_decorations();
                cx.notify();
                Value::Null
            }),
            "decorate.unregister" => {
                if let Some(running) = self.running.get_mut(uid) {
                    running.decorates = false;
                }
                self.decorations.retain(|_, list| {
                    list.retain(|decoration| decoration.uid != uid);
                    true
                });
                self.decorations_changed += 1;
                cx.notify();
                Ok(Value::Null)
            }
            "notify.show" => match self.grant(uid, Permission::Notifications).and_then(|_| self.rate(uid)) {
                Ok(()) => {
                    let (name, title, body) = (self.name(uid), text(args, "title").chars().take(120).collect::<String>(), text(args, "body").chars().take(300).collect::<String>());
                    if let Some(state) = state {
                        cx.defer(move |cx| state.update(cx, |state, cx| state.show_plugin_notification(&name, title, body, cx)));
                    }
                    Ok(Value::Null)
                }
                Err(error) => Err(error),
            },
            "core.call" => return self.core_call(uid, n, args, cx),
            "messages.history" | "messages.search" | "messages.send" | "messages.edit" | "messages.delete" | "messages.react" => return self.messages(uid, n, op, args, cx),
            "voice.members" | "voice.join" | "voice.leave" | "voice.mute" | "voice.deafen" => return self.voice(uid, n, op, args, cx),
            "net.fetch" => match self.grant(uid, Permission::Network) {
                Ok(()) => {
                    let Some(loaded) = self.loaded.get(uid) else { return Some(Err("It isn't installed.".into())) };
                    let hosts = loaded.manifest().hosts.clone();
                    let local = loaded.record.origin == Origin::Folder;
                    let (owner, request) = (uid.to_string(), args.clone());
                    cx.spawn(async move |this, cx| {
                        let result = super::net::fetch(request, hosts, local).await;
                        this.update(cx, |plugins, _| {
                            if let Err(error) = &result {
                                plugins.log(&owner, "warn", format!("A fetch failed: {error}"));
                            }
                            plugins.reply(&owner, n, result)
                        })
                        .ok();
                    })
                    .detach();
                    return None;
                }
                Err(error) => Err(error),
            },
            "files.open" => match self.may_draw(uid, cx) {
                Ok(()) => {
                    let chosen = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
                    let owner = uid.to_string();
                    cx.spawn(async move |this, cx| {
                        let picked = match chosen.await {
                            Ok(Ok(Some(paths))) => paths.into_iter().next(),
                            _ => None,
                        };
                        let answer = match picked {
                            None => Ok(Value::Null),
                            Some(path) => match std::fs::metadata(&path) {
                                Ok(meta) if meta.len() > 8 << 20 => Err("A plugin takes files of at most 8 MB.".to_string()),
                                Ok(_) => std::fs::read(&path)
                                    .map(|bytes| json!({ "name": path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(), "bytes": base64::engine::general_purpose::STANDARD.encode(bytes) }))
                                    .map_err(|error| error.to_string()),
                                Err(error) => Err(error.to_string()),
                            },
                        };
                        this.update(cx, |plugins, _| plugins.reply(&owner, n, answer)).ok();
                    })
                    .detach();
                    return None;
                }
                Err(error) => Err(error),
            },
            "files.save" => match self.may_draw(uid, cx) {
                Ok(()) => match base64::engine::general_purpose::STANDARD.decode(text(args, "bytes")) {
                    Ok(bytes) => {
                        let name: String = text(args, "name").chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0')).take(120).collect();
                        let downloads = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
                        let chosen = cx.prompt_for_new_path(&downloads, Some(if name.is_empty() { "file" } else { &name }));
                        let owner = uid.to_string();
                        cx.spawn(async move |this, cx| {
                            let answer = match chosen.await {
                                Ok(Ok(Some(path))) => std::fs::write(path, bytes).map(|_| json!(true)).map_err(|error| error.to_string()),
                                _ => Ok(json!(false)),
                            };
                            this.update(cx, |plugins, _| plugins.reply(&owner, n, answer)).ok();
                        })
                        .detach();
                        return None;
                    }
                    Err(_) => Err("The file's bytes aren't readable.".into()),
                },
                Err(error) => Err(error),
            },
            "files.attachment" => return self.attachment(uid, n, args, cx),
            "files.asset" => {
                let path = text(args, "path");
                match self.loaded.get(uid).and_then(|loaded| loaded.package.asset(&path).map(<[u8]>::to_vec)) {
                    Some(bytes) => Ok(json!(base64::engine::general_purpose::STANDARD.encode(bytes))),
                    None => Err(format!("The package has no {path}.")),
                }
            }
            "clipboard.read" => self.grant(uid, Permission::ClipboardRead).and_then(|_| {
                if !self.activated(uid) {
                    return Err("A plugin reads the clipboard only right after the person uses it.".into());
                }
                Ok(json!(cx.read_from_clipboard().and_then(|item| item.text()).unwrap_or_default()))
            }),
            "clipboard.write" => self.grant(uid, Permission::ClipboardWrite).and_then(|_| {
                if !self.activated(uid) {
                    return Err("A plugin writes to the clipboard only right after the person uses it.".into());
                }
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text(args, "text").chars().take(100_000).collect()));
                Ok(Value::Null)
            }),
            _ => Err(format!("There's no {op}.")),
        })
    }

    fn register(&mut self, uid: &str, args: &Value, cx: &mut Context<Self>) -> Answer {
        let kind = text(args, "kind");
        let id = text(args, "id");
        if !slot_id_ok(&id) {
            return Err("A slot's id is 1 to 40 letters, digits, dots, hyphens and underscores.".into());
        }
        let label = args.get("label").and_then(Value::as_str).or_else(|| args.get("title").and_then(Value::as_str)).unwrap_or_default();
        let title: String = label.trim().chars().take(60).collect();
        let icon = view::icon_name(args.get("icon")).unwrap_or_else(|| "puzzle".into());
        let width = args.get("width").and_then(Value::as_f64).map(|width| (width as f32).clamp(280., 720.)).unwrap_or(440.);
        let slot = Slot { id: id.clone(), title: if title.is_empty() { self.name(uid) } else { title }, icon, hover: args.get("hover").and_then(Value::as_bool).unwrap_or(false), width };
        let Some(slots) = self.slots.get_mut(uid) else { return Err("It isn't running.".into()) };
        let map = match kind.as_str() {
            "settings" => {
                slots.settings_view = true;
                cx.notify();
                return Ok(Value::Null);
            }
            "dialog" => {
                slots.dialog = Some(slot);
                return Ok(Value::Null);
            }
            "panel" => &mut slots.panels,
            "page" => &mut slots.pages,
            "headerButton" => &mut slots.header_buttons,
            "composerButton" => &mut slots.composer_buttons,
            "messageAction" => &mut slots.message_actions,
            "conversationAction" => &mut slots.conversation_actions,
            _ => return Err(format!("There's no slot called {kind}.")),
        };
        if map.len() >= MAX_SLOTS && !map.contains_key(&id) {
            return Err(format!("A plugin has at most {MAX_SLOTS} of these."));
        }
        map.insert(id, slot);
        cx.notify();
        Ok(Value::Null)
    }

    /// Whether a server is one this device is on.
    /// Whether a plugin may name this server: one the device is on, and never the linked
    /// Telegram account, which no plugin reaches with any permission (docs/TELEGRAM_PLAN.md).
    fn server_known(&self, server: &str, cx: &gpui::App) -> bool {
        server != crate::telegram::SERVER_ID && crate::state::try_store(cx).is_some_and(|state| state.read(cx).servers.contains_key(server))
    }

    /// Calls the core for a plugin and answers it later, with what comes back made fit for it.
    fn ask_core(&self, uid: &str, n: u64, server: Option<String>, method: &str, args: Vec<Value>, shape: fn(&str, Value) -> Value, cx: &mut Context<Self>) {
        let Some(state) = crate::state::try_store(cx) else {
            self.reply(uid, n, Err("The app isn't ready.".into()));
            return;
        };
        let call = state.read(cx).core.call(server.as_deref(), method, args);
        let owner = uid.to_string();
        cx.spawn(async move |this, cx| {
            let result = call.await.map(|value| shape(server.as_deref().unwrap_or_default(), value)).map_err(|error| error.message);
            this.update(cx, |plugins, _| plugins.reply(&owner, n, result)).ok();
        })
        .detach();
    }

    fn core_call(&mut self, uid: &str, n: u64, args: &Value, cx: &mut Context<Self>) -> Option<Answer> {
        let server = args.get("server").and_then(Value::as_str).map(str::to_string);
        let method = text(args, "method");
        let mut call_args: Vec<Value> = args.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
        let refused = |plugins: &mut Plugins, error: String| {
            plugins.log(uid, "warn", format!("Refused core.call {method}: {error}"));
            Some(Err(error))
        };
        let granted: Vec<Permission> = Permission::ALL.into_iter().filter(|permission| self.granted(uid, *permission)).collect();
        if let Err(error) = may_call(&granted, server.is_some(), &method) {
            return refused(self, error);
        }
        if let Some(server) = &server {
            if !self.server_known(server, cx) {
                return refused(self, "That isn't a server this device is on.".into());
            }
        }
        if call_args.len() > 16 || serde_json::to_vec(&call_args).map_or(true, |bytes| bytes.len() > MAX_ARGS) {
            return refused(self, "Those arguments are larger than a call takes.".into());
        }
        if holds_path(&Value::Array(call_args.clone())) {
            return refused(self, "A plugin hands the core bytes, never a path.".into());
        }
        // What a message may carry from a plugin: no buttons, no signal, nothing but what the person could write.
        match method.as_str() {
            "sendMessage" | "sendWithAttachments" => {
                let at = if method == "sendMessage" { 1 } else { 2 };
                if let Some(body) = call_args.get(at).cloned() {
                    let mut kept = serde_json::Map::new();
                    for field in ["text", "replyTo", "mentions", "emotes"] {
                        if let Some(value) = body.get(field) {
                            kept.insert(field.to_string(), value.clone());
                        }
                    }
                    call_args[at] = Value::Object(kept);
                }
                call_args.truncate(at + 1);
            }
            "editMessage" => call_args.truncate(5),
            _ => {}
        }
        // The list of servers never names the linked Telegram account.
        let shape: fn(&str, Value) -> Value = if method == "listServers" { without_telegram } else { |_, value| sanitize(&value) };
        self.ask_core(uid, n, server, &method, call_args, shape, cx);
        None
    }

    fn messages(&mut self, uid: &str, n: u64, op: &str, args: &Value, cx: &mut Context<Self>) -> Option<Answer> {
        let permission = if matches!(op, "messages.history" | "messages.search") { Permission::MessagesRead } else { Permission::MessagesSend };
        if let Err(error) = self.grant(uid, permission) {
            return Some(Err(error));
        }
        let server = text(args, "serverId");
        if !self.server_known(&server, cx) {
            return Some(Err("That isn't a server this device is on.".into()));
        }
        let group = text(args, "groupId");
        let id = text(args, "id");
        let (method, call_args, shape): (&str, Vec<Value>, fn(&str, Value) -> Value) = match op {
            "messages.history" => {
                let mut call_args = vec![json!(group)];
                if let Some(before) = args.get("before").and_then(Value::as_f64) {
                    call_args.push(json!(before));
                }
                ("loadMessages", call_args, |server, value| {
                    let messages: Vec<Value> = value.get("messages").and_then(Value::as_array).map(|items| items.iter().map(|message| plugin_message(server, message)).collect()).unwrap_or_default();
                    json!({ "messages": messages, "hasMore": value.get("hasMore").cloned().unwrap_or(json!(false)) })
                })
            }
            "messages.search" => {
                let query: String = text(args, "query").chars().take(200).collect();
                let mut call_args = vec![json!(query)];
                if !group.is_empty() {
                    call_args.push(json!(group));
                }
                ("search", call_args, |server, value| {
                    let found: Vec<Value> = value.as_array().map(|items| items.iter().map(|item| plugin_message(server, item.get("message").unwrap_or(item))).collect()).unwrap_or_default();
                    json!(found)
                })
            }
            "messages.send" => {
                let body: String = text(args, "text").chars().take(crate::ui::chat::MAX_TEXT_LENGTH).collect();
                if body.trim().is_empty() {
                    return Some(Err("A message has text.".into()));
                }
                ("sendMessage", vec![json!(text(args, "conversationKey")), json!({ "text": body, "mentions": [], "emotes": {} })], |_, _| Value::Null)
            }
            "messages.edit" => {
                let body: String = text(args, "text").chars().take(crate::ui::chat::MAX_TEXT_LENGTH).collect();
                ("editMessage", vec![json!(group), json!(id), json!(body), json!({}), json!([])], |_, _| Value::Null)
            }
            "messages.delete" => ("deleteMessage", vec![json!(group), json!(id)], |_, _| Value::Null),
            _ => {
                let emoji: String = text(args, "emoji").chars().take(16).collect();
                ("toggleReaction", vec![json!(group), json!(id), json!(emoji)], |_, _| Value::Null)
            }
        };
        self.ask_core(uid, n, Some(server), method, call_args, shape, cx);
        None
    }

    fn voice(&mut self, uid: &str, n: u64, op: &str, args: &Value, cx: &mut Context<Self>) -> Option<Answer> {
        let permission = if op == "voice.members" { Permission::VoiceRead } else { Permission::VoiceControl };
        if let Err(error) = self.grant(uid, permission) {
            return Some(Err(error));
        }
        if op == "voice.members" {
            let server = text(args, "serverId");
            if !self.server_known(&server, cx) {
                return Some(Err("That isn't a server this device is on.".into()));
            }
            self.ask_core(uid, n, Some(server), "getVoiceMembers", vec![], |_, value| sanitize(&value), cx);
            return None;
        }
        let Some(voice) = crate::voice::get(cx) else { return Some(Err("Voice isn't ready.".into())) };
        match op {
            "voice.join" => {
                let (server, channel) = (text(args, "serverId"), text(args, "channelId"));
                let is_voice = crate::state::try_store(cx).is_some_and(|state| state.read(cx).servers.get(&server).is_some_and(|known| known.channels.iter().any(|item| item.id == channel && item.kind == "voice")));
                if !is_voice {
                    return Some(Err("That isn't a voice channel on a server this device is on.".into()));
                }
                cx.defer(move |cx| voice.update(cx, |voice, cx| voice.join(server, channel, None, crate::voice::JoinHow::default(), cx)));
            }
            "voice.leave" => cx.defer(move |cx| voice.update(cx, |voice, cx| voice.leave(cx))),
            "voice.mute" => {
                let muted = args.get("muted").and_then(Value::as_bool).unwrap_or(false);
                cx.defer(move |cx| {
                    voice.update(cx, |voice, cx| {
                        if voice.muted != muted {
                            voice.toggle_mute(cx);
                        }
                    })
                });
            }
            _ => {
                let deafened = args.get("deafened").and_then(Value::as_bool).unwrap_or(false);
                cx.defer(move |cx| {
                    voice.update(cx, |voice, cx| {
                        if voice.deafened != deafened {
                            voice.toggle_deafen(cx);
                        }
                    })
                });
            }
        }
        Some(Ok(Value::Null))
    }

    fn attachment(&mut self, uid: &str, n: u64, args: &Value, cx: &mut Context<Self>) -> Option<Answer> {
        if let Err(error) = self.grant(uid, Permission::FilesRead) {
            return Some(Err(error));
        }
        let (server, group, id) = (text(args, "serverId"), text(args, "groupId"), text(args, "messageId"));
        let index = args.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        if !self.server_known(&server, cx) {
            return Some(Err("That isn't a server this device is on.".into()));
        }
        let Some(state) = crate::state::try_store(cx) else { return Some(Err("The app isn't ready.".into())) };
        let core = state.read(cx).core.clone();
        let owner = uid.to_string();
        cx.spawn(async move |this, cx| {
            let answer: Answer = async {
                let message = core.call(Some(&server), "messageById", vec![json!(group), json!(id)]).await.map_err(|error| error.message)?;
                let attachment = message.get("attachments").and_then(|items| items.get(index)).cloned().ok_or("That message has no such file.")?;
                if attachment.get("size").and_then(Value::as_f64).unwrap_or(0.) > (16 << 20) as f64 {
                    return Err("A plugin reads files of at most 16 MB.".to_string());
                }
                let reference = json!({ "fileId": attachment["fileId"], "key": attachment["key"], "prefix": attachment["prefix"], "chunks": attachment["chunks"], "mime": attachment["mime"] });
                let blob = core.call(Some(&server), "downloadFile", vec![reference]).await.map_err(|error| error.message)?;
                let bytes = crate::host::value_bytes(&blob).ok_or("The file didn't download.")?;
                Ok(json!({ "name": attachment["name"], "mime": attachment["mime"], "bytes": base64::engine::general_purpose::STANDARD.encode(bytes) }))
            }
            .await;
            this.update(cx, |plugins, _| plugins.reply(&owner, n, answer)).ok();
        })
        .detach();
        None
    }
}
