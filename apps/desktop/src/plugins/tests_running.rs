//! Plugins running, on GPUI's test platform: the broker answering each request a plugin makes and
//! refusing what it wasn't granted, its slots and views, filters with their deadlines and strikes,
//! decorations, the core's events, hosts that crash or say what a plugin can't, and installing,
//! updating, withdrawing and removing. Each plugin's host is one the test speaks for
//! (`process::Process::fake`), in front of the app's state with its stand-in for the core.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use gpui::{AppContext, Entity, TestAppContext};
use serde_json::{Value, json};

use super::store::{Kind, Origin};
use super::{FilterKind, LogLine, PluginStore, Plugins, Verdict, filter};
use crate::state::{Overlay, Panel};
use crate::testing::fixtures::{BOB, DM, GENERAL, LOUNGE, SERVER};
use crate::testing::{App, World};

/// An empty folder of the test's own.
fn fresh(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zuna-plugins-{name}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn manifest(id: &str, permissions: &[&str], change: impl FnOnce(&mut Value)) -> Value {
    let mut manifest = json!({
        "manifest": 1, "id": id, "name": format!("Plugin {id}"), "version": "1.0.0", "description": "For the tests.",
        "author": { "name": "Someone" }, "license": "MIT", "main": "main.js", "api": 1, "permissions": permissions,
    });
    change(&mut manifest);
    manifest
}

/// A developer's folder of a plugin with these permissions, and whatever else `change` sets in its manifest.
fn source(id: &str, permissions: &[&str], change: impl FnOnce(&mut Value)) -> PathBuf {
    let dir = fresh(&format!("{id}-source"));
    let manifest = manifest(id, permissions, change);
    std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    if manifest.get("main").is_some() {
        std::fs::write(dir.join("main.js"), "globalThis.__zunaDefine(() => {});").unwrap();
    }
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("assets").join("icon.svg"), "<svg/>").unwrap();
    dir
}

/// An unsigned package of a plugin.
fn package(manifest: &Value, script: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("plugin.json", options).unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        if manifest.get("main").is_some() {
            writer.start_file("main.js", options).unwrap();
            writer.write_all(script).unwrap();
        }
        writer.finish().unwrap();
    }
    out.into_inner()
}

/// The plugins' side of the app, keeping its data in `data`, as the app makes it.
fn plugins_in(cx: &mut TestAppContext, data: &Path, no_plugins: bool) -> Entity<Plugins> {
    cx.update(|cx| {
        let plugins = cx.new(|cx| Plugins::new(data.to_path_buf(), Some(&[9u8; 32]), no_plugins, cx));
        cx.set_global(PluginStore(plugins.clone()));
        plugins
    })
}

/// The app open on its test server, with one plugin from a developer's folder running in a host
/// the test speaks for.
struct Harness {
    app: App,
    plugins: Entity<Plugins>,
    uid: String,
    next: Cell<u64>,
}

impl Harness {
    fn open(cx: &mut TestAppContext, id: &str, permissions: &[&str], change: impl FnOnce(&mut Value)) -> Harness {
        let app = App::open(cx, &World::new(id));
        app.update(cx, |state, cx| state.select_server(SERVER, cx));
        let plugins = plugins_in(cx, &fresh(id), false);
        let dir = source(id, permissions, change);
        let uid = plugins.update(cx, |plugins, cx| {
            plugins.set_allow_unverified(true, cx);
            let uid = plugins.load_folder(&dir, cx).expect("the folder loads");
            plugins.start_all(cx);
            uid
        });
        let harness = Harness { app, plugins, uid, next: Cell::new(0) };
        harness.say(cx, json!({ "t": "ready" }));
        harness
    }

    fn read<T>(&self, cx: &mut TestAppContext, read: impl FnOnce(&Plugins) -> T) -> T {
        cx.read(|cx| read(self.plugins.read(cx)))
    }

    /// Says something as the plugin's host would, and lets the app take it in.
    fn say(&self, cx: &mut TestAppContext, message: Value) {
        self.say_raw(cx, Some(message.to_string()));
    }

    fn say_raw(&self, cx: &mut TestAppContext, message: Option<String>) {
        cx.update(|cx| {
            if let Some(running) = self.plugins.read(cx).running.get(&self.uid) {
                running.process.say(message);
            }
        });
        cx.run_until_parked();
    }

    /// What the app sent the plugin's host since this was last asked.
    fn sent(&self, cx: &mut TestAppContext) -> Vec<Value> {
        self.read(cx, |plugins| plugins.running.get(&self.uid).map(|running| running.process.sent()).unwrap_or_default())
    }

    /// Asks the broker for something as the plugin would, and gives its answer.
    fn ask(&self, cx: &mut TestAppContext, op: &str, args: Value) -> Result<Value, String> {
        let n = self.ask_later(cx, op, args);
        self.reply(cx, n)
    }

    fn ask_later(&self, cx: &mut TestAppContext, op: &str, args: Value) -> u64 {
        let n = self.next.get() + 1;
        self.next.set(n);
        self.sent(cx);
        self.say(cx, json!({ "t": "ask", "n": n, "op": op, "args": args }));
        n
    }

    /// The broker's answer to an ask, once it's come.
    fn reply(&self, cx: &mut TestAppContext, n: u64) -> Result<Value, String> {
        for _ in 0..50 {
            if let Some(reply) = self.sent(cx).into_iter().find(|message| message["t"] == "reply" && message["n"] == n) {
                return if reply["ok"] == true { Ok(reply["value"].clone()) } else { Err(reply["error"]["message"].as_str().unwrap_or_default().to_string()) };
            }
            cx.run_until_parked();
        }
        panic!("the broker never answered ask {n}");
    }

    /// The person just used the plugin, as a click on its button does.
    fn activate(&self, cx: &mut TestAppContext) {
        self.plugins.update(cx, |plugins, _| plugins.activate(&self.uid));
    }

    fn running(&self, cx: &mut TestAppContext) -> bool {
        self.read(cx, |plugins| plugins.running(&self.uid))
    }

    fn log(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.read(cx, |plugins| plugins.logs.get(&self.uid).map(|log| log.iter().map(|LogLine { text, .. }| text.clone()).collect()).unwrap_or_default())
    }

    fn off_reason(&self, cx: &mut TestAppContext) -> Option<String> {
        self.read(cx, |plugins| plugins.record.find(&self.uid).and_then(|record| record.off_reason.clone()))
    }
}

/// What a filter decided, once it has.
fn verdict(cx: &mut TestAppContext, kind: FilterKind, payload: Value) -> std::rc::Rc<std::cell::RefCell<Option<Option<Verdict>>>> {
    let slot = std::rc::Rc::new(std::cell::RefCell::new(None));
    let filled = slot.clone();
    cx.update(|cx| match filter(kind, payload, cx) {
        None => *filled.borrow_mut() = Some(None),
        Some(task) => cx
            .spawn(async move |_| {
                let verdict = task.await;
                *filled.borrow_mut() = Some(Some(verdict));
            })
            .detach(),
    });
    cx.run_until_parked();
    slot
}

#[gpui::test]
fn a_plugin_boots_with_what_it_kept_and_stops_with_all_it_registered(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("booting"));
    let data = fresh("booting");
    let plugins = plugins_in(cx, &data, false);
    let dir = source("booter", &["messages.read"], |m| {
        m["contributes"] = json!({ "settings": [{ "type": "select", "key": "language", "label": "Language", "choices": ["en", "pl"] }, { "type": "switch", "key": "loud", "label": "Loud", "default": true }] });
    });
    let uid = plugins.update(cx, |plugins, cx| {
        assert!(plugins.load_folder(&dir, cx).unwrap_err().contains("Turn them on"), "not without the switch for plugins Zuna hasn't checked");
        plugins.set_allow_unverified(true, cx);
        let uid = plugins.load_folder(&dir, cx).unwrap();
        plugins.storage().unwrap().set(&uid, Kind::Storage, "count", &json!(7)).unwrap();
        plugins.start_all(cx);
        uid
    });
    let harness = Harness { app, plugins, uid: uid.clone(), next: Cell::new(0) };
    let boot = harness.sent(cx).remove(0);
    assert_eq!(boot["t"], "boot");
    assert_eq!(boot["plugin"], json!({ "id": "booter", "version": "1.0.0", "verified": false, "permissions": ["messages.read"] }));
    assert_eq!(boot["settings"], json!({ "language": "en", "loud": true }), "each setting at its default");
    assert_eq!(boot["storage"], json!({ "count": 7 }));
    assert_eq!(boot["limits"]["memory"], json!(super::MEMORY));
    assert!(!harness.running(cx), "not running until its host says it's ready");
    harness.say(cx, json!({ "t": "ready" }));
    assert!(harness.running(cx));
    assert_eq!(harness.log(cx), vec!["Started.".to_string()]);
    assert_eq!(harness.read(cx, |plugins| (plugins.name(&uid), plugins.verified(&uid))), ("Plugin booter".to_string(), false));

    // Its logs, held to their length.
    harness.say(cx, json!({ "t": "log", "level": "warn", "text": "x".repeat(5000) }));
    assert_eq!(harness.log(cx).last().unwrap().chars().count(), 4000);
    for n in 0..600 {
        harness.say(cx, json!({ "t": "log", "text": format!("line {n}") }));
    }
    assert_eq!(harness.log(cx).len(), super::MAX_LOG);
    assert_eq!(harness.log(cx).last().unwrap(), "line 599");

    // What it registered goes with it, and its panel shuts.
    harness.ask(cx, "ui.register", json!({ "kind": "panel", "id": "stats", "title": "Stats" })).unwrap();
    harness.activate(cx);
    harness.ask(cx, "ui.open", json!({ "kind": "panel", "id": "stats" })).unwrap();
    harness.app.run(cx);
    assert!(matches!(harness.app.read(cx, |state| state.panel.clone()), Some(Panel::Plugin(_))));
    harness.plugins.update(cx, |plugins, cx| plugins.set_enabled(&uid, false, cx));
    harness.app.run(cx);
    assert!(!harness.running(cx) && harness.read(cx, |plugins| plugins.slots.get(&uid).is_none()));
    assert_eq!(harness.app.read(cx, |state| state.panel.clone()), None, "its panel shut as it stopped");
    // On again, it boots anew.
    harness.plugins.update(cx, |plugins, cx| plugins.set_enabled(&uid, true, cx));
    assert_eq!(harness.sent(cx)[0]["t"], "boot");
    std::fs::remove_dir_all(&data).ok();
}

#[gpui::test]
fn slots_and_views_are_held_to_their_rules(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "slotter", &[], |_| {});
    for kind in ["panel", "page", "headerButton", "composerButton", "messageAction", "conversationAction"] {
        harness.ask(cx, "ui.register", json!({ "kind": kind, "id": "one", "label": "  Labelled  ", "icon": "star", "width": 9000 })).unwrap();
    }
    harness.ask(cx, "ui.register", json!({ "kind": "settings", "id": "settings" })).unwrap();
    harness.ask(cx, "ui.register", json!({ "kind": "dialog", "id": "ask", "title": "" })).unwrap();
    let slots = harness.read(cx, |plugins| plugins.slots[&harness.uid].clone());
    let panel = &slots.panels["one"];
    assert_eq!((panel.title.as_str(), panel.width), ("Labelled", 720.), "a label trimmed, a width held to its range");
    assert_eq!(slots.dialog.as_ref().unwrap().title, "Plugin slotter", "an empty title is the plugin's name");
    assert!(slots.settings_view);
    assert_eq!(harness.read(cx, |plugins| plugins.each_slot(|slots| &slots.header_buttons)).len(), 1);

    assert!(harness.ask(cx, "ui.register", json!({ "kind": "panel", "id": "has space" })).unwrap_err().contains("1 to 40"));
    assert!(harness.ask(cx, "ui.register", json!({ "kind": "panel", "id": "" })).is_err());
    assert!(harness.ask(cx, "ui.register", json!({ "kind": "sidebar", "id": "x" })).unwrap_err().contains("no slot called sidebar"));
    for n in 0..9 {
        harness.ask(cx, "ui.register", json!({ "kind": "panel", "id": format!("p{n}") })).unwrap();
    }
    assert!(harness.ask(cx, "ui.register", json!({ "kind": "panel", "id": "eleventh" })).unwrap_err().contains("at most 10"));
    harness.ask(cx, "ui.register", json!({ "kind": "panel", "id": "p0", "title": "Again" })).expect("one already there can be registered again");

    let tree = json!({ "type": "text", "props": {}, "children": [{ "type": "string", "props": { "text": "hi" }, "children": [] }] });
    for id in ["panel:one", "page:one", "dialog:ask", "settings:settings"] {
        harness.ask(cx, "ui.view", json!({ "id": id, "tree": tree })).unwrap_or_else(|error| panic!("{id}: {error}"));
    }
    assert!(harness.read(cx, |plugins| plugins.view(&harness.uid, "panel:one").is_some()));
    assert!(harness.ask(cx, "ui.view", json!({ "id": "panel:none", "tree": tree })).unwrap_err().contains("No such view"));
    assert!(harness.ask(cx, "ui.view", json!({ "id": "nonsense", "tree": tree })).is_err());
    assert!(harness.ask(cx, "ui.view", json!({ "id": "panel:one", "tree": "not a tree" })).is_err());

    harness.ask(cx, "ui.remove", json!({ "id": "one" })).unwrap();
    let slots = harness.read(cx, |plugins| plugins.slots[&harness.uid].clone());
    assert!(!slots.panels.contains_key("one") && !slots.header_buttons.contains_key("one") && !slots.views.contains_key("panel:one"));
    assert!(slots.views.contains_key("dialog:ask"), "a view of another slot stays");
    assert_eq!(harness.ask(cx, "no.such", json!({})).unwrap_err(), "There's no no.such.");
    assert!(harness.log(cx).iter().any(|line| line == "Refused no.such: There's no no.such."), "a refusal is in its log");
}

#[gpui::test]
fn what_a_plugin_draws_opens_only_right_after_the_person_uses_it(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "opener", &[], |_| {});
    for kind in ["panel", "page", "dialog"] {
        harness.ask(cx, "ui.register", json!({ "kind": kind, "id": "main" })).unwrap();
    }
    assert!(harness.ask(cx, "ui.open", json!({ "kind": "panel", "id": "main" })).unwrap_err().contains("right after the person uses it"));
    assert!(harness.ask(cx, "ui.open", json!({ "kind": "panel", "id": "other" })).unwrap_err().contains("No such thing"));
    harness.activate(cx);
    for kind in ["panel", "page", "dialog"] {
        harness.ask(cx, "ui.open", json!({ "kind": kind, "id": "main" })).unwrap();
    }
    harness.app.run(cx);
    let (panel, page, overlay) = harness.app.read(cx, |state| (state.panel.clone(), state.plugin_page, state.overlay.clone()));
    let [panel_handle, page_handle, dialog_handle] = ["panel", "page", "dialog"].map(|kind| harness.plugins.update(cx, |plugins, _| plugins.handle(&harness.uid, kind, "main")));
    assert_eq!(panel, Some(Panel::Plugin(panel_handle)));
    assert_eq!(page, Some(page_handle), "each kept the number it was opened by");
    assert_eq!(overlay, Some(Overlay::Plugin(dialog_handle)));
    assert_eq!(harness.read(cx, |plugins| plugins.of_handle(page_handle)), Some((harness.uid.clone(), "page".to_string(), "main".to_string())));
    assert_eq!(harness.read(cx, |plugins| plugins.of_handle(99)), None);
    harness.ask(cx, "ui.close", json!({ "kind": "page" })).unwrap();
    harness.app.run(cx);
    assert_eq!(harness.app.read(cx, |state| state.plugin_page), None);
    assert!(harness.app.read(cx, |state| state.panel.is_some()), "only the kind it closed");

    // Nothing of a plugin's opens over a question the app is asking.
    harness.app.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: BOB.into() }), cx));
    harness.activate(cx);
    assert!(harness.ask(cx, "ui.open", json!({ "kind": "page", "id": "main" })).unwrap_err().contains("asking the person"));
    // Nor long after the person used it.
    harness.app.update(cx, |state, cx| state.set_overlay(None, cx));
    harness.plugins.update(cx, |plugins, _| plugins.running.get_mut(&harness.uid).unwrap().activated_until = Some(std::time::Instant::now() - Duration::from_secs(1)));
    assert!(harness.ask(cx, "ui.open", json!({ "kind": "page", "id": "main" })).is_err());
}

#[gpui::test]
fn toasts_and_notifications_go_under_the_plugins_name_a_few_at_a_time(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "toaster", &["notifications"], |_| {});
    harness.app.update(cx, |state, _| {
        state.window_focused = true;
        state.settings.notifications = true;
        state.toasts.clear();
    });
    harness.ask(cx, "ui.toast", json!({ "text": "Saved" })).unwrap();
    harness.app.run(cx);
    assert_eq!(harness.app.toasts(cx), vec!["Plugin toaster: Saved".to_string()], "it can't pass for the app's own");
    harness.ask(cx, "notify.show", json!({ "title": "Hey", "body": "there" })).unwrap();
    harness.app.run(cx);
    assert_eq!(harness.app.toasts(cx).last().unwrap(), "Plugin toaster: Hey — there", "a notification shows as a toast while the window has focus");
    for _ in 0..3 {
        harness.ask(cx, "ui.toast", json!({ "text": "x".repeat(500), "kind": "error" })).unwrap();
    }
    assert_eq!(harness.ask(cx, "ui.toast", json!({ "text": "sixth" })).unwrap_err(), "Too many at once.");
    assert_eq!(harness.ask(cx, "notify.show", json!({ "title": "seventh" })).unwrap_err(), "Too many at once.");
    harness.app.run(cx);
    assert!(harness.app.toasts(cx).iter().all(|toast| toast.chars().count() <= "Plugin toaster: ".len() + 200));

    let plain = Harness::open(cx, "quiet", &[], |_| {});
    assert!(plain.ask(cx, "notify.show", json!({ "title": "Hey" })).unwrap_err().contains("notifications permission"));
}

#[gpui::test]
fn the_message_box_and_the_clipboard_need_the_person(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "clipper", &["clipboard.read", "clipboard.write"], |_| {});
    assert!(harness.ask(cx, "composer.insert", json!({ "text": "hi" })).unwrap_err().contains("right after the person uses it"));
    assert!(harness.ask(cx, "clipboard.write", json!({ "text": "copied" })).unwrap_err().contains("right after"));
    assert!(harness.ask(cx, "clipboard.read", json!({})).unwrap_err().contains("right after"));
    harness.app.update(cx, |state, cx| state.select_conversation(Some(format!("user:{BOB}")), cx));
    harness.activate(cx);
    harness.ask(cx, "composer.insert", json!({ "text": "x".repeat(5000) })).unwrap();
    harness.app.run(cx);
    let chat = harness.app.window.update(cx, |root, _, _| root.open_chat()).unwrap().expect("a chat is open");
    assert_eq!(cx.read(|cx| chat.read(cx).composer_text(cx).chars().count()), crate::ui::chat::MAX_TEXT_LENGTH, "into the open chat's box, held to a message's length");
    harness.ask(cx, "clipboard.write", json!({ "text": "copied" })).unwrap();
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("copied"));
    cx.write_to_clipboard(gpui::ClipboardItem::new_string("from elsewhere".into()));
    assert_eq!(harness.ask(cx, "clipboard.read", json!({})).unwrap(), json!("from elsewhere"));

    let plain = Harness::open(cx, "noclip", &[], |_| {});
    plain.activate(cx);
    assert!(plain.ask(cx, "clipboard.read", json!({})).unwrap_err().contains("clipboard.read permission"));
    assert!(plain.ask(cx, "clipboard.write", json!({ "text": "x" })).unwrap_err().contains("clipboard.write permission"));
}

#[gpui::test]
fn storage_and_settings_keep_what_they_may(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "keeper", &[], |m| {
        m["contributes"] = json!({ "settings": [{ "type": "select", "key": "language", "label": "Language", "choices": ["en", "pl"] }, { "type": "slider", "key": "level", "label": "Level" }] });
    });
    harness.ask(cx, "storage.set", json!({ "key": "count", "value": 3 })).unwrap();
    assert_eq!(harness.read(cx, |plugins| plugins.storage().unwrap().load(&harness.uid, Kind::Storage).get("count").cloned()), Some(json!(3)));
    harness.ask(cx, "storage.delete", json!({ "key": "count" })).unwrap();
    assert!(harness.read(cx, |plugins| plugins.storage().unwrap().load(&harness.uid, Kind::Storage).is_empty()));
    assert!(harness.ask(cx, "storage.set", json!({ "key": "big", "value": "x".repeat(600 << 10) })).is_err());

    harness.ask(cx, "settings.set", json!({ "key": "language", "value": "pl" })).unwrap();
    assert_eq!(harness.ask(cx, "settings.set", json!({ "key": "language", "value": "de" })).unwrap_err(), "That isn't a value the setting takes.");
    assert_eq!(harness.ask(cx, "settings.set", json!({ "key": "level", "value": 2 })).unwrap_err(), "That isn't a value the setting takes.");
    assert_eq!(harness.ask(cx, "settings.set", json!({ "key": "colour", "value": "red" })).unwrap_err(), "The manifest names no such setting.");
    assert_eq!(harness.read(cx, |plugins| plugins.settings_of(&harness.uid)), serde_json::from_value::<serde_json::Map<String, Value>>(json!({ "language": "pl", "level": 0.5 })).unwrap());

    // The person changes one in Settings: the plugin is told, and decorations are asked for again.
    let before = harness.read(cx, |plugins| plugins.decorations_changed);
    harness.plugins.update(cx, |plugins, cx| {
        plugins.set_setting(&harness.uid, "level", json!(0.25), cx);
        plugins.set_setting(&harness.uid, "level", json!("loud"), cx);
        plugins.set_setting(&harness.uid, "nothing", json!(1), cx);
    });
    let events: Vec<Value> = harness.sent(cx).into_iter().filter(|message| message["t"] == "event").collect();
    assert_eq!(events, vec![json!({ "t": "event", "name": "settings", "data": { "key": "level", "value": 0.25 } })], "only a value the setting takes");
    assert!(harness.read(cx, |plugins| plugins.decorations_changed) > before);
    assert_eq!(harness.read(cx, |plugins| plugins.settings_of("folder:nobody")), serde_json::Map::new());
}

#[gpui::test]
fn a_plugin_reaches_the_core_only_as_the_table_allows(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "caller", &["messages.send", "users.read", "servers.read"], |_| {});
    let app = &harness.app;
    let call = |method: &str, server: Option<&str>, args: Value| json!({ "method": method, "server": server, "args": args });
    assert!(harness.ask(cx, "core.call", call("changePassword", Some(SERVER), json!([]))).unwrap_err().contains("No plugin may call changePassword"));
    assert!(harness.ask(cx, "core.call", call("loadMessages", Some(SERVER), json!([DM]))).unwrap_err().contains("messages.read permission"));
    assert!(harness.ask(cx, "core.call", call("getUsers", Some("server-9"), json!([]))).unwrap_err().contains("isn't a server this device is on"));
    assert!(harness.ask(cx, "core.call", call("getUsers", Some(crate::telegram::SERVER_ID), json!([]))).unwrap_err().contains("isn't a server"), "never the linked Telegram account");
    assert!(harness.ask(cx, "core.call", call("getUsers", Some(SERVER), json!((0..17).collect::<Vec<_>>()))).unwrap_err().contains("larger than a call takes"));
    assert!(harness.ask(cx, "core.call", call("getUsers", Some(SERVER), json!(["x".repeat(300 << 10)]))).unwrap_err().contains("larger"));
    assert!(harness.ask(cx, "core.call", call("sendMessage", Some(SERVER), json!(["user:u-bob", { "text": "hi", "attachments": [{ "$file": { "path": "/etc/passwd" } }] }]))).unwrap_err().contains("never a path"));
    assert!(harness.log(cx).iter().any(|line| line.starts_with("Refused core.call changePassword")));

    // What a message from a plugin may carry: what the person could write, and nothing else.
    app.answer("sendMessage", |_| Ok(Value::Null));
    app.forget_calls();
    harness.ask(cx, "core.call", call("sendMessage", Some(SERVER), json!(["user:u-bob", { "text": "hi", "mentions": [BOB], "buttons": [{ "label": "Pay" }], "signal": { "kind": "x" } }, "extra"]))).unwrap();
    assert_eq!(app.calls_of("sendMessage"), vec![vec![json!("user:u-bob"), json!({ "text": "hi", "mentions": [BOB] })]]);
    harness.ask(cx, "core.call", call("sendWithAttachments", Some(SERVER), json!(["user:u-bob", [], { "text": "files", "signal": 1 }, "extra"]))).ok();
    assert_eq!(app.calls_of("sendWithAttachments").last().unwrap(), &vec![json!("user:u-bob"), json!([]), json!({ "text": "files" })]);
    harness.ask(cx, "core.call", call("editMessage", Some(SERVER), json!([DM, "m01", "new", {}, [], "extra", "more"]))).ok();
    assert_eq!(app.calls_of("editMessage").last().unwrap().len(), 5);

    // What comes back is made fit for it: no secrets, and no Telegram account among the servers.
    app.answer("getUsers", |_| Ok(json!([{ "id": BOB, "token": "t", "profile": { "secret": "s", "name": "Bob" } }])));
    assert_eq!(harness.ask(cx, "core.call", call("getUsers", Some(SERVER), json!([]))).unwrap(), json!([{ "id": BOB, "profile": { "name": "Bob" } }]));
    app.answer("listServers", |_| Ok(json!([{ "id": SERVER, "name": "Test Server" }, { "id": "telegram", "kind": "telegram" }, { "id": "x", "kind": "telegram" }])));
    assert_eq!(harness.ask(cx, "core.call", call("listServers", None, json!([]))).unwrap(), json!([{ "id": SERVER, "name": "Test Server" }]));
    app.answer("getUsers", |_| Err(crate::testing::refused("Not now.")));
    assert_eq!(harness.ask(cx, "core.call", call("getUsers", Some(SERVER), json!([]))).unwrap_err(), "Not now.");
}

#[gpui::test]
fn messages_are_read_and_sent_through_the_broker(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "messenger", &["messages.read", "messages.send"], |_| {});
    let app = &harness.app;
    app.forget_calls();
    let history = harness.ask(cx, "messages.history", json!({ "serverId": SERVER, "groupId": DM, "before": 12 })).unwrap();
    assert_eq!(app.calls_of("loadMessages"), vec![vec![json!(DM), json!(12.0)]]);
    assert_eq!(history["hasMore"], false);
    let first = &history["messages"][0];
    assert_eq!(first["serverId"], SERVER);
    assert!(first.get("preview").is_none() && first.get("reactions").is_none(), "only what a plugin is told of a message");
    let photo = history["messages"].as_array().unwrap().iter().find(|message| message["id"] == "m04").unwrap();
    assert_eq!(photo["attachments"], json!([{ "name": "photo.png", "mime": "image/png", "size": 123456 }]), "no key to the file");

    let found = harness.ask(cx, "messages.search", json!({ "serverId": SERVER, "query": "x".repeat(300), "groupId": DM })).unwrap();
    assert_eq!(found[0]["id"], "m01");
    let searched = app.calls_of("search");
    assert_eq!(searched[0][0].as_str().unwrap().len(), 200);
    assert_eq!(searched[0][1], json!(DM));
    harness.ask(cx, "messages.search", json!({ "serverId": SERVER, "query": "hi" })).unwrap();
    assert_eq!(app.calls_of("search")[1], vec![json!("hi")], "everywhere, without a group");

    assert_eq!(harness.ask(cx, "messages.send", json!({ "serverId": SERVER, "conversationKey": "user:u-bob", "text": "   " })).unwrap_err(), "A message has text.");
    app.answer("sendMessage", |_| Ok(json!({ "id": "new" })));
    assert_eq!(harness.ask(cx, "messages.send", json!({ "serverId": SERVER, "conversationKey": "user:u-bob", "text": "hello" })).unwrap(), Value::Null);
    assert_eq!(app.calls_of("sendMessage")[0], vec![json!("user:u-bob"), json!({ "text": "hello", "mentions": [], "emotes": {} })]);
    app.answer("editMessage", |_| Ok(Value::Null));
    app.answer("deleteMessage", |_| Ok(Value::Null));
    harness.ask(cx, "messages.edit", json!({ "serverId": SERVER, "groupId": DM, "id": "m02", "text": "changed" })).unwrap();
    assert_eq!(app.calls_of("editMessage")[0], vec![json!(DM), json!("m02"), json!("changed"), json!({}), json!([])]);
    harness.ask(cx, "messages.delete", json!({ "serverId": SERVER, "groupId": DM, "id": "m02" })).unwrap();
    assert_eq!(app.calls_of("deleteMessage")[0], vec![json!(DM), json!("m02")]);
    harness.ask(cx, "messages.react", json!({ "serverId": SERVER, "groupId": DM, "id": "m02", "emoji": "👍".repeat(20) })).unwrap();
    assert_eq!(app.calls_of("toggleReaction")[0][2].as_str().unwrap().chars().count(), 16);
    assert!(harness.ask(cx, "messages.history", json!({ "serverId": "server-9", "groupId": DM })).unwrap_err().contains("isn't a server"));

    let reader = Harness::open(cx, "onlyreads", &["messages.read"], |_| {});
    assert!(reader.ask(cx, "messages.send", json!({ "serverId": SERVER, "conversationKey": "user:u-bob", "text": "hi" })).unwrap_err().contains("messages.send permission"));
    let writer = Harness::open(cx, "onlywrites", &["messages.send"], |_| {});
    assert!(writer.ask(cx, "messages.search", json!({ "serverId": SERVER, "query": "hi" })).unwrap_err().contains("messages.read permission"));
}

#[gpui::test]
fn voice_and_files_need_their_permissions(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "voicer", &["voice.read", "voice.control", "files.read"], |_| {});
    let members = harness.ask(cx, "voice.members", json!({ "serverId": SERVER })).unwrap();
    assert_eq!(members[0]["channelId"], LOUNGE);
    assert!(harness.ask(cx, "voice.members", json!({ "serverId": "server-9" })).unwrap_err().contains("isn't a server"));
    assert!(harness.ask(cx, "voice.join", json!({ "serverId": SERVER, "channelId": GENERAL })).unwrap_err().contains("isn't a voice channel"), "a text channel");
    assert!(harness.ask(cx, "voice.join", json!({ "serverId": "server-9", "channelId": LOUNGE })).unwrap_err().contains("isn't a voice channel"));

    // A file of a message, read whole, up to its limit.
    let bytes = b"the file's bytes";
    harness.app.answer("messageById", |args| {
        let size = if args[1] == "big" { 20 << 20 } else { 16 };
        Ok(json!({ "id": args[1], "attachments": [{ "fileId": "f1", "key": "k", "prefix": "p", "chunks": 1, "name": "notes.txt", "mime": "text/plain", "size": size }] }))
    });
    harness.app.answer("downloadFile", move |args| {
        assert_eq!(args[0]["fileId"], "f1");
        Ok(json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(bytes) }))
    });
    let file = harness.ask(cx, "files.attachment", json!({ "serverId": SERVER, "groupId": DM, "messageId": "m05" })).unwrap();
    assert_eq!(file, json!({ "name": "notes.txt", "mime": "text/plain", "bytes": base64::engine::general_purpose::STANDARD.encode(bytes) }));
    assert!(harness.ask(cx, "files.attachment", json!({ "serverId": SERVER, "groupId": DM, "messageId": "big" })).unwrap_err().contains("at most 16 MB"));
    assert!(harness.ask(cx, "files.attachment", json!({ "serverId": SERVER, "groupId": DM, "messageId": "m05", "index": 3 })).unwrap_err().contains("no such file"));
    assert!(harness.ask(cx, "files.attachment", json!({ "serverId": "server-9", "groupId": DM, "messageId": "m05" })).unwrap_err().contains("isn't a server"));
    harness.app.answer("downloadFile", |_| Ok(json!({})));
    assert!(harness.ask(cx, "files.attachment", json!({ "serverId": SERVER, "groupId": DM, "messageId": "m05" })).unwrap_err().contains("didn't download"));

    // Its own package's files.
    assert_eq!(harness.ask(cx, "files.asset", json!({ "path": "assets/icon.svg" })).unwrap(), json!(base64::engine::general_purpose::STANDARD.encode("<svg/>")));
    assert!(harness.ask(cx, "files.asset", json!({ "path": "assets/none.svg" })).unwrap_err().contains("no assets/none.svg"));

    let plain = Harness::open(cx, "novoice", &[], |_| {});
    assert!(plain.ask(cx, "voice.members", json!({ "serverId": SERVER })).unwrap_err().contains("voice.read permission"));
    assert!(plain.ask(cx, "voice.leave", json!({})).unwrap_err().contains("voice.control permission"));
    assert!(plain.ask(cx, "files.attachment", json!({ "serverId": SERVER })).unwrap_err().contains("files.read permission"));
    assert!(plain.ask(cx, "net.fetch", json!({ "url": "https://example.com" })).unwrap_err().contains("network permission"));
}

#[gpui::test]
fn files_go_in_and_out_only_through_the_persons_own_dialogs(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "filer", &[], |_| {});
    assert!(harness.ask(cx, "files.open", json!({})).unwrap_err().contains("right after"));
    assert!(harness.ask(cx, "files.save", json!({ "name": "x", "bytes": "" })).unwrap_err().contains("right after"));
    harness.activate(cx);
    let dir = fresh("filer-files");
    let picked = dir.join("picked.txt");
    std::fs::write(&picked, "picked bytes").unwrap();
    let n = harness.ask_later(cx, "files.open", json!({}));
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|_| Some(vec![picked.clone()]));
    cx.run_until_parked();
    assert_eq!(harness.reply(cx, n).unwrap(), json!({ "name": "picked.txt", "bytes": base64::engine::general_purpose::STANDARD.encode("picked bytes") }));
    let n = harness.ask_later(cx, "files.open", json!({}));
    cx.simulate_path_prompt_response(|_| None);
    cx.run_until_parked();
    assert_eq!(harness.reply(cx, n).unwrap(), Value::Null, "the person picked nothing");
    let large = dir.join("large.bin");
    std::fs::write(&large, vec![0u8; (8 << 20) + 1]).unwrap();
    let n = harness.ask_later(cx, "files.open", json!({}));
    cx.simulate_path_prompt_response(|_| Some(vec![large.clone()]));
    cx.run_until_parked();
    assert!(harness.reply(cx, n).unwrap_err().contains("at most 8 MB"));

    assert_eq!(harness.ask(cx, "files.save", json!({ "name": "x", "bytes": "not base64!" })).unwrap_err(), "The file's bytes aren't readable.");
    let target = dir.join("saved.txt");
    let n = harness.ask_later(cx, "files.save", json!({ "name": "../../evil:name", "bytes": base64::engine::general_purpose::STANDARD.encode("saved") }));
    cx.simulate_new_path_selection(|_| Some(target.clone()));
    cx.run_until_parked();
    assert_eq!(harness.reply(cx, n).unwrap(), json!(true));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "saved");
    let n = harness.ask_later(cx, "files.save", json!({ "name": "", "bytes": "" }));
    cx.simulate_new_path_selection(|_| None);
    cx.run_until_parked();
    assert_eq!(harness.reply(cx, n).unwrap(), json!(false), "the person saved nothing");
    std::fs::remove_dir_all(&dir).ok();
}

#[gpui::test]
fn the_network_is_the_brokers_and_refuses_before_it_connects(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "fetcher", &["network"], |m| m["hosts"] = json!(["api.example.com", "printer.local"]));
    let refused = |cx: &mut TestAppContext, args: Value| {
        let n = harness.ask_later(cx, "net.fetch", args);
        for _ in 0..200 {
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(10));
            if let Some(reply) = harness.sent(cx).into_iter().find(|message| message["t"] == "reply" && message["n"] == n) {
                assert_eq!(reply["ok"], false, "{reply}");
                return reply["error"]["message"].as_str().unwrap().to_string();
            }
        }
        panic!("the fetch never answered: {n}");
    };
    assert!(refused(cx, json!({ "url": "not a url" })).contains("isn't an address"));
    assert!(refused(cx, json!({ "url": "https://evil.example.org/" })).contains("may only reach api.example.com, printer.local, over HTTPS"));
    assert!(refused(cx, json!({ "url": "https://api.example.com/", "method": "CONNECT" })).contains("isn't a method"));
    assert!(refused(cx, json!({ "url": "https://api.example.com/", "method": "POST", "body": "%%%" })).contains("body isn't readable"));
    let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; (1 << 20) + 1]);
    assert!(refused(cx, json!({ "url": "https://api.example.com/", "method": "POST", "body": big })).contains("at most 1 MB"));
    let many: serde_json::Map<String, Value> = (0..41).map(|n| (format!("x-{n}"), json!("v"))).collect();
    assert!(refused(cx, json!({ "url": "https://api.example.com/", "headers": many })).contains("Too many headers"));
    for header in ["Cookie", "Sec-Fetch-Site", "Proxy-Foo", "Origin"] {
        assert!(refused(cx, json!({ "url": "https://api.example.com/", "headers": { header: "x" } })).contains(&format!("can't set {header}")), "{header}");
    }
    assert!(harness.log(cx).iter().any(|line| line.starts_with("A fetch failed")));
}

#[test]
fn a_name_on_this_computers_network_is_refused_as_its_resolved() {
    let hosts = vec!["printer.local".to_string()];
    let fetched = futures::executor::block_on(super::net::fetch(json!({ "url": "https://printer.local/" }), hosts.clone(), false));
    assert!(fetched.unwrap_err().contains("on this computer's network"));
}

#[gpui::test]
fn plugins_hear_only_the_events_they_may(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "listener", &["messages.read"], |_| {});
    assert!(harness.ask(cx, "subscribe", json!({ "type": "voice" })).unwrap_err().contains("voice.read permission"));
    assert_eq!(harness.ask(cx, "subscribe", json!({ "type": "security" })).unwrap_err(), "No plugin is told of security.");
    harness.ask(cx, "subscribe", json!({ "type": "message" })).unwrap();
    let message = json!({ "id": "m1", "groupId": DM, "senderId": BOB, "text": "hi", "attachments": [{ "fileId": "f", "key": "k", "name": "a.png", "mime": "image/png", "size": 1 }] });
    harness.plugins.update(cx, |plugins, _| {
        plugins.core_event(&json!({ "type": "message", "serverId": SERVER, "message": message, "token": "secret" }));
        plugins.core_event(&json!({ "type": "message", "serverId": crate::telegram::SERVER_ID, "message": message }));
        plugins.core_event(&json!({ "type": "typing", "serverId": SERVER }));
        plugins.core_event(&json!({ "type": "voice_key", "serverId": SERVER }));
        plugins.core_event(&json!({ "no": "type" }));
    });
    let events: Vec<Value> = harness.sent(cx).into_iter().filter(|message| message["t"] == "event").collect();
    assert_eq!(events.len(), 1, "only the message it listens for, and nothing of Telegram's: {events:?}");
    let told = &events[0]["data"]["event"];
    assert!(told.get("token").is_none());
    assert_eq!(told["message"], json!({ "serverId": SERVER, "groupId": DM, "id": "m1", "senderId": BOB, "text": "hi", "createdAt": null, "editedAt": null, "attachments": [{ "name": "a.png", "mime": "image/png", "size": 1 }] }));
}

#[gpui::test]
fn filters_change_stop_or_hold_what_the_app_does(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "filterer", &["messages.intercept", "activity.intercept", "notifications", "messages.read"], |_| {});
    let draft = json!({ "serverId": SERVER, "text": "teh cat" });
    assert_eq!(*verdict(cx, FilterKind::Outgoing, draft.clone()).borrow(), Some(None), "no filter: the app goes on at once");
    assert_eq!(harness.ask(cx, "filter.register", json!({ "id": "f", "kind": "sideways" })).unwrap_err(), "No such filter.");
    assert_eq!(harness.ask(cx, "filter.register", json!({ "id": "", "kind": "typing" })).unwrap_err(), "Too many filters.");
    harness.ask(cx, "filter.register", json!({ "id": "spell", "kind": "outgoing", "required": true })).unwrap();
    harness.ask(cx, "filter.register", json!({ "id": "quiet", "kind": "typing", "required": true })).unwrap();
    harness.ask(cx, "filter.register", json!({ "id": "names", "kind": "notify" })).unwrap();
    assert_eq!(*verdict(cx, FilterKind::Outgoing, json!({ "serverId": crate::telegram::SERVER_ID, "text": "x" })).borrow(), Some(None), "nothing of Telegram's passes a plugin");

    // The plugin is asked, and its answer changes the message.
    let answer = |cx: &mut TestAppContext, value: Value| {
        let call = harness.sent(cx).into_iter().find(|message| message["t"] == "call" && message["fn"] == "filter").expect("the filter is asked");
        harness.say(cx, json!({ "t": "done", "n": call["n"], "ok": true, "value": value }));
        call
    };
    let slot = verdict(cx, FilterKind::Outgoing, draft.clone());
    let call = answer(cx, json!({ "text": "the cat" }));
    assert_eq!(call["args"], json!({ "id": "spell", "payload": draft }));
    assert_eq!(*slot.borrow(), Some(Some(Verdict::Go(json!({ "serverId": SERVER, "text": "the cat" })))));
    let slot = verdict(cx, FilterKind::Outgoing, draft.clone());
    answer(cx, json!({ "stop": true }));
    assert_eq!(*slot.borrow(), Some(Some(Verdict::Stopped("Plugin filterer".into()))));
    let slot = verdict(cx, FilterKind::Outgoing, draft.clone());
    answer(cx, json!({ "text": "  " }));
    assert_eq!(*slot.borrow(), Some(Some(Verdict::Stopped("Plugin filterer".into()))), "nothing left to send");
    let slot = verdict(cx, FilterKind::Notify, json!({ "serverId": SERVER, "title": "Bob", "body": "hi" }));
    answer(cx, json!({ "title": "x".repeat(600), "body": "changed" }));
    let Some(Some(Verdict::Go(notified))) = slot.borrow().clone() else { panic!("it goes") };
    assert_eq!((notified["title"].as_str().unwrap().len(), notified["body"].as_str().unwrap()), (500, "changed"));

    // One that throws: a required one holds what it was asked about.
    let slot = verdict(cx, FilterKind::Outgoing, draft.clone());
    let call = harness.sent(cx).into_iter().find(|message| message["fn"] == "filter").unwrap();
    harness.say(cx, json!({ "t": "done", "n": call["n"], "ok": false, "error": { "message": "boom" } }));
    assert_eq!(*slot.borrow(), Some(Some(Verdict::Held("Plugin filterer".into()))));
    assert!(harness.log(cx).iter().any(|line| line == "Its filter failed: boom"));
    // One that never answers: a required one holds it after its deadline.
    let slot = verdict(cx, FilterKind::Outgoing, draft.clone());
    cx.executor().advance_clock(Duration::from_millis(1600));
    cx.run_until_parked();
    assert_eq!(*slot.borrow(), Some(Some(Verdict::Held("Plugin filterer".into()))));
    // Only a filter on what goes out can be required: one on typing that said it was is left
    // out when it fails, and a third failure in a row turns the plugin off.
    assert_eq!(harness.read(cx, |plugins| plugins.running[&harness.uid].filters["quiet"]), (FilterKind::Typing, false));
    let slot = verdict(cx, FilterKind::Typing, json!({ "serverId": SERVER }));
    cx.executor().advance_clock(Duration::from_millis(600));
    cx.run_until_parked();
    assert_eq!(*slot.borrow(), Some(Some(Verdict::Go(json!({ "serverId": SERVER })))));
    assert_eq!(harness.off_reason(cx).as_deref(), Some("It failed to answer in time three times in a row."));
    harness.app.run(cx);
    assert!(harness.app.toasts(cx).iter().any(|toast| toast.starts_with("Plugin filterer was turned off.")));
    assert_eq!(*verdict(cx, FilterKind::Outgoing, draft).borrow(), Some(None), "and its filters with it");
}

#[gpui::test]
fn a_filter_that_misses_its_deadline_once_is_forgiven_by_its_next_answer(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "forgiven", &["activity.intercept"], |_| {});
    harness.ask(cx, "filter.register", json!({ "id": "read", "kind": "read" })).unwrap();
    for _ in 0..2 {
        let slot = verdict(cx, FilterKind::Read, json!({ "serverId": SERVER }));
        cx.executor().advance_clock(Duration::from_millis(600));
        cx.run_until_parked();
        assert_eq!(*slot.borrow(), Some(Some(Verdict::Go(json!({ "serverId": SERVER })))));
    }
    harness.app.run(cx);
    assert!(harness.app.toasts(cx).iter().any(|toast| toast == "Plugin forgiven didn't answer in time, so Zuna went on without it."));
    assert_eq!(harness.read(cx, |plugins| plugins.running[&harness.uid].strikes), 2);
    let slot = verdict(cx, FilterKind::Read, json!({ "serverId": SERVER }));
    let call = harness.sent(cx).into_iter().filter(|message| message["fn"] == "filter").last().unwrap();
    harness.say(cx, json!({ "t": "done", "n": call["n"], "ok": true, "value": {} }));
    assert!(slot.borrow().is_some());
    assert_eq!(harness.read(cx, |plugins| plugins.running[&harness.uid].strikes), 0);
    harness.ask(cx, "filter.unregister", json!({ "id": "read" })).unwrap();
    assert_eq!(*verdict(cx, FilterKind::Read, json!({ "serverId": SERVER })).borrow(), Some(None));
    assert!(harness.ask(cx, "filter.register", json!({ "id": "out", "kind": "outgoing" })).unwrap_err().contains("messages.intercept permission"));
    for n in 0..20 {
        harness.ask(cx, "filter.register", json!({ "id": format!("f{n}"), "kind": "typing" })).unwrap();
    }
    assert_eq!(harness.ask(cx, "filter.register", json!({ "id": "f20", "kind": "typing" })).unwrap_err(), "Too many filters.");
}

#[gpui::test]
fn the_persons_actions_and_commands_reach_the_plugin(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "commander", &["conversations.read"], |m| {
        m["contributes"] = json!({ "commands": [
            { "id": "hello", "title": "Say hello", "keys": "ctrl-shift-y", "slash": "hello" },
            { "id": "bad", "title": "Bad keys", "keys": "ctrl-nonsense-key-that-isnt" },
            { "id": "plain", "title": "Plain" }
        ] });
    });
    harness.app.update(cx, |state, cx| state.select_conversation(Some(format!("user:{BOB}")), cx));
    assert_eq!(harness.read(cx, |plugins| plugins.slash("hello")), Some((harness.uid.clone(), "hello".to_string())));
    assert_eq!(harness.read(cx, |plugins| plugins.slash("nope")), None);
    assert_eq!(harness.read(cx, |plugins| plugins.slash_commands()), vec![("hello".to_string(), "Say hello".to_string(), "Plugin commander".to_string())]);
    let keystroke = gpui::Keystroke::parse("ctrl-shift-y").unwrap();
    assert_eq!(harness.read(cx, |plugins| plugins.command_for(&keystroke)), Some((harness.uid.clone(), "hello".to_string())));
    assert!(harness.log(cx).iter().any(|line| line.contains("isn't a keystroke")));

    harness.sent(cx);
    harness.plugins.update(cx, |plugins, cx| plugins.run_command(&harness.uid, "hello", "there", cx));
    let call = harness.sent(cx).remove(0);
    assert_eq!(call["fn"], "command");
    assert_eq!(call["args"], json!({ "id": "hello", "context": { "conversation": { "serverId": SERVER, "key": format!("user:{BOB}"), "groupId": DM, "name": "Bob" }, "args": "there" } }));
    assert!(harness.read(cx, |plugins| plugins.activated(&harness.uid)), "a command lets it open what it draws");
    harness.say(cx, json!({ "t": "done", "n": call["n"], "ok": true }));

    harness.plugins.update(cx, |plugins, cx| {
        plugins.action(&harness.uid, "messageAction", "quote", json!({ "id": "m01" }), cx);
        plugins.action(&harness.uid, "headerButton", "go", json!(null), cx);
        plugins.handler(&harness.uid, "panel:x|0|onClick".into(), json!(3), cx);
    });
    let calls = harness.sent(cx);
    assert_eq!(calls[0]["args"], json!({ "id": "messageAction:quote", "kind": "target", "target": { "id": "m01" } }));
    assert_eq!(calls[1]["args"]["kind"], "context");
    assert_eq!(calls[2]["args"], json!({ "id": "panel:x|0|onClick", "value": 3 }));
    harness.say(cx, json!({ "t": "done", "n": calls[0]["n"], "ok": false, "error": { "message": "It threw." } }));
    assert!(harness.log(cx).iter().any(|line| line == "It threw."));
    // One it never answers counts against it.
    cx.executor().advance_clock(super::CALL_DEADLINE + Duration::from_millis(10));
    cx.run_until_parked();
    assert_eq!(harness.read(cx, |plugins| plugins.running[&harness.uid].strikes), 2);

    // Without conversations.read, a command doesn't learn where it was used.
    let plain = Harness::open(cx, "nowhere", &[], |_| {});
    plain.app.update(cx, |state, cx| state.select_conversation(Some(format!("user:{BOB}")), cx));
    assert_eq!(cx.update(|cx| plain.plugins.read(cx).context_for(&plain.uid, "", cx)), json!({ "conversation": null, "args": "" }));
}

#[gpui::test]
fn decorations_are_asked_for_once_and_dropped_as_messages_change(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "decorator", &["messages.read", "messages.decorate"], |_| {});
    let message: crate::models::MessageView = serde_json::from_value(crate::testing::fixtures::message("m01", DM, 1.0, BOB, "hi", json!({}))).unwrap();
    let decorations = |cx: &mut TestAppContext| harness.read(cx, |plugins| plugins.decorations_for(SERVER, &message));
    assert!(decorations(cx).is_empty(), "nothing decorates yet");
    harness.ask(cx, "subscribe", json!({ "type": "message" })).unwrap();
    harness.ask(cx, "decorate.register", json!({})).unwrap();
    harness.sent(cx);
    assert!(decorations(cx).is_empty(), "asked for, not known yet");
    cx.executor().advance_clock(Duration::from_millis(20));
    cx.run_until_parked();
    let call = harness.sent(cx).into_iter().find(|message| message["fn"] == "decorate").expect("the plugin is asked");
    assert_eq!(call["args"]["messages"][0]["id"], "m01");
    assert!(decorations(cx).is_empty() && harness.sent(cx).is_empty(), "and asked only once");
    harness.say(cx, json!({ "t": "done", "n": call["n"], "ok": true, "value": [{ "text": "x".repeat(5000), "mark": { "label": "y".repeat(50), "icon": "star" }, "hidden": true }] }));
    let found = decorations(cx);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].text.as_ref().unwrap().chars().count(), crate::ui::chat::MAX_TEXT_LENGTH);
    assert_eq!(found[0].mark.as_ref().unwrap().1.chars().count(), 40);
    assert!(found[0].hidden && !found[0].verified);
    assert_eq!(super::decoration_key(SERVER, &message), format!("{SERVER}/{DM}/m01/0"));

    // A message changed: it's asked about again.
    harness.plugins.update(cx, |plugins, _| plugins.core_event(&json!({ "type": "message", "serverId": SERVER, "message": { "id": "m01", "groupId": DM } })));
    assert!(decorations(cx).is_empty());
    harness.plugins.update(cx, |plugins, cx| plugins.toggle_original(super::decoration_key(SERVER, &message), cx));
    assert!(harness.read(cx, |plugins| plugins.shown_original.len()) == 1);
    harness.plugins.update(cx, |plugins, cx| plugins.toggle_original(super::decoration_key(SERVER, &message), cx));
    assert!(harness.read(cx, |plugins| plugins.shown_original.is_empty()));
    harness.ask(cx, "decorate.unregister", json!({})).unwrap();
    assert!(decorations(cx).is_empty());

    // What isn't decorated: the app's own lines, deleted messages, and anything a plugin answers that holds nothing.
    let mut system = message.clone();
    system.id = "sys-1".into();
    assert!(harness.read(cx, |plugins| plugins.decorations_for(SERVER, &system)).is_empty());
    assert!(super::broker::decoration("u", "n", false, "k", &json!("text")).is_none());
    assert!(super::broker::decoration("u", "n", false, "k", &json!({ "mark": { "icon": "star" } })).is_none(), "a mark needs a label");
    let viewed = super::broker::decoration("u", "n", true, "k", &json!({ "view": { "type": "text", "props": {}, "children": [] } })).unwrap();
    assert_eq!(viewed.view.as_ref().map(|(key, _)| key.as_str()), Some("k"));

    let plain = Harness::open(cx, "nodecor", &["messages.read"], |_| {});
    assert!(plain.ask(cx, "decorate.register", json!({})).unwrap_err().contains("messages.decorate permission"));
}

#[gpui::test]
fn a_host_that_crashes_overreaches_or_talks_nonsense_is_turned_off(cx: &mut TestAppContext) {
    let cases: Vec<(&str, Option<String>, &str)> = vec![
        ("crasher", None, "It stopped working."),
        ("garbler", Some("{not json".into()), "It sent what a plugin can't."),
        ("stranger", Some(json!({ "t": "hello" }).to_string()), "It sent what a plugin can't."),
        ("failer", Some(json!({ "t": "failed", "error": "x".repeat(400) }).to_string()), "It didn't start: "),
        ("glutton", Some(json!({ "t": "fault", "reason": "memory" }).to_string()), "It used more memory than a plugin may."),
        ("flooder", Some(json!({ "t": "fault", "reason": "flood" }).to_string()), "It sent more than a plugin may."),
    ];
    for (id, message, reason) in cases {
        let harness = Harness::open(cx, id, &[], |_| {});
        harness.say_raw(cx, message);
        let off = harness.off_reason(cx).unwrap_or_else(|| panic!("{id} is turned off"));
        assert!(off.starts_with(reason), "{id}: {off}");
        assert!(off.chars().count() < 340, "what a host says is cut short");
        assert!(!harness.running(cx) && !harness.read(cx, |plugins| plugins.loaded[&harness.uid].record.enabled));
        harness.app.run(cx);
        assert!(harness.app.toasts(cx).iter().any(|toast| toast.starts_with(&format!("Plugin {id} was turned off."))), "{id} says so");
    }
    // A slow piece of script is a strike, not the end.
    let harness = Harness::open(cx, "sluggard", &[], |_| {});
    harness.say(cx, json!({ "t": "fault", "reason": "slow" }));
    assert!(harness.running(cx) && harness.off_reason(cx).is_none());
    // What a host that was stopped says afterwards is heard by nobody.
    let generation = harness.read(cx, |plugins| plugins.running[&harness.uid].generation);
    harness.plugins.update(cx, |plugins, cx| plugins.heard(&harness.uid, generation + 1, None, cx));
    assert!(harness.running(cx), "an older host's pipe closing isn't this one's");
}

#[gpui::test]
fn files_are_installed_checked_again_and_removed_with_all_they_kept(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("installing"));
    let data = fresh("installing");
    let plugins = plugins_in(cx, &data, false);
    let first = package(&manifest("installed", &["messages.read"], |_| {}), b"globalThis.__zunaDefine(() => {});");
    plugins.update(cx, |plugins, cx| {
        assert!(plugins.install(&first, None, cx).unwrap_err().contains("hasn't checked are off"));
        assert!(plugins.propose_file(first.clone(), cx).unwrap_err().contains("Allow plugins Zuna hasn't checked"));
        plugins.set_allow_unverified(true, cx);
        plugins.start_all(cx);
    });
    let id = plugins.update(cx, |plugins, cx| plugins.propose_file(first.clone(), cx)).unwrap();
    app.run(cx);
    assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::PluginInstall { id }));
    plugins.update(cx, |plugins, cx| plugins.confirm(id, cx));
    app.run(cx);
    assert!(app.toasts(cx).contains(&"Plugin installed is installed.".to_string()));
    let uid = super::store::uid(Origin::File, "installed");
    assert!(cx.read(|cx| plugins.read(cx).running.contains_key(&uid)), "it starts at once");
    let file = super::store::packages(&data).join("file-installed-1.0.0.zunaplugin");
    assert!(file.is_file());
    plugins.update(cx, |plugins, _| plugins.storage().unwrap().set(&uid, Kind::Storage, "kept", &json!(1)).unwrap());

    // A new version: the same plugin, its old package gone.
    let second = package(&manifest("installed", &["messages.read", "notifications"], |m| m["version"] = json!("1.1.0")), b"globalThis.__zunaDefine(() => {});");
    let proposed = plugins.update(cx, |plugins, cx| plugins.propose_file(second.clone(), cx)).unwrap();
    let update_of = cx.read(|cx| plugins.read(cx).proposal.clone().unwrap().update_of);
    assert_eq!(update_of, Some(("1.0.0".to_string(), vec![super::manifest::Permission::Notifications], vec![])), "what it asks for that it didn't");
    plugins.update(cx, |plugins, cx| {
        plugins.cancel(proposed + 1);
        assert!(plugins.proposal.is_some(), "cancelling another changes nothing");
        plugins.cancel(proposed);
        plugins.confirm(proposed, cx);
    });
    assert_eq!(cx.read(|cx| plugins.read(cx).loaded[&uid].record.version.clone()), "1.0.0", "a cancelled proposal installs nothing");
    plugins.update(cx, |plugins, cx| plugins.install(&second, None, cx)).unwrap();
    assert!(!file.exists() && super::store::packages(&data).join("file-installed-1.1.0.zunaplugin").is_file());

    // Read again as the app starts, each package is checked against what was installed.
    drop(plugins);
    let again = plugins_in(cx, &data, false);
    assert_eq!(cx.read(|cx| again.read(cx).loaded[&uid].manifest().version.clone()), "1.1.0");
    std::fs::write(super::store::packages(&data).join("file-installed-1.1.0.zunaplugin"), &first).unwrap();
    let tampered = plugins_in(cx, &data, false);
    assert!(cx.read(|cx| tampered.read(cx).problems[&uid].contains("changed on disk")));
    std::fs::remove_file(super::store::packages(&data).join("file-installed-1.1.0.zunaplugin")).unwrap();
    let missing = plugins_in(cx, &data, false);
    assert_eq!(cx.read(|cx| missing.read(cx).problems[&uid].clone()), "Its package is missing.");
    missing.update(cx, |plugins, cx| plugins.remove(&uid, cx));
    assert!(cx.read(|cx| missing.read(cx).record.plugins.is_empty() && missing.read(cx).problems.is_empty()));
    assert!(cx.read(|cx| missing.read(cx).storage().unwrap().load(&uid, Kind::Storage).is_empty()), "what it kept goes with it");

    // Withdrawn by its hash, it isn't proposed or installed.
    missing.update(cx, |plugins, cx| {
        plugins.record.revoked_hashes.push(super::package::sha256_hex(&first));
        assert_eq!(plugins.propose_file(first.clone(), cx).unwrap_err(), "Zuna withdrew this plugin as harmful.");
        assert_eq!(plugins.install(&first, None, cx).unwrap_err(), "Zuna withdrew this plugin as harmful.");
        assert!(plugins.propose_file(b"not a package".to_vec(), cx).is_err());
    });
    std::fs::remove_dir_all(&data).ok();
}

#[gpui::test]
fn the_index_withdraws_what_it_names_and_holds_updates_that_ask_for_more(cx: &mut TestAppContext) {
    let _app = App::open(cx, &World::new("withdrawing"));
    let data = fresh("withdrawing");
    let plugins = plugins_in(cx, &data, false);
    let bytes = package(&manifest("withdrawn", &[], |_| {}), b"globalThis.__zunaDefine(() => {});");
    let uid = plugins.update(cx, |plugins, cx| {
        plugins.set_allow_unverified(true, cx);
        plugins.install(&bytes, None, cx).unwrap()
    });
    let index = |revoked: Value| -> super::market::Index {
        serde_json::from_value(json!({
            "serial": 7, "plugins": [{ "id": "shown", "name": "Shown", "versions": [{ "version": "2.0.0", "api": 1, "file": "shown-2.0.0.zunaplugin", "size": 1, "sha256": "aa", "permissions": ["network", "messages.read"], "hosts": ["api.example.com"] }] }],
            "revoked": revoked,
        }))
        .unwrap()
    };
    plugins.update(cx, |plugins, cx| plugins.apply_index(index(json!([{ "sha256": super::package::sha256_hex(&bytes), "reason": "It steals." }])), cx));
    cx.read(|cx| {
        let plugins = plugins.read(cx);
        assert_eq!(plugins.record.seen_serial, 7);
        assert_eq!(plugins.problems[&uid], "Zuna withdrew it: It steals.");
        assert!(!plugins.record.find(&uid).unwrap().enabled);
        assert!(plugins.market.revoked(&plugins.loaded[&uid].package));
    });

    // A verified plugin whose newest version asks for more waits for the person.
    let shown = manifest("shown", &["messages.read"], |m| m["version"] = json!("1.0.0"));
    let shown_package = super::package::Package::open(&package(&shown, b"x")).unwrap();
    plugins.update(cx, |plugins, cx| {
        let record = super::store::Installed {
            id: "shown".into(),
            origin: Origin::Verified,
            name: "Shown".into(),
            version: "1.0.0".into(),
            sha256: shown_package.sha256.clone(),
            path: "verified-shown-1.0.0.zunaplugin".into(),
            granted: vec![super::manifest::Permission::MessagesRead],
            hosts: vec![],
            enabled: true,
            off_reason: None,
            installed_at: 0.,
        };
        plugins.record.plugins.push(record.clone());
        plugins.loaded.insert(record.uid(), super::Loaded { record, package: std::sync::Arc::new(shown_package) });
        assert!(plugins.wants_market(), "a device with a verified plugin looks for its updates");
        plugins.apply_index(index(json!([])), cx);
        assert!(plugins.market.waiting.contains_key("verified:shown"));
        assert!(plugins.problems.get(&uid).is_none_or(|problem| problem.contains("withdrew")), "{:?}", plugins.problems);
        plugins.propose_market("shown", cx).unwrap();
        let proposal = plugins.proposal.clone().unwrap();
        assert!(proposal.verified);
        assert_eq!(proposal.update_of, Some(("1.0.0".into(), vec![super::manifest::Permission::Network], vec!["api.example.com".into()])));
        assert_eq!(proposal.told()[0].0, "Read your messages and send them to api.example.com");
        assert!(plugins.propose_market("unknown", cx).unwrap_err().contains("No version"));
        plugins.market.index = None;
        assert!(plugins.propose_market("shown", cx).unwrap_err().contains("isn't loaded"));
    });
    std::fs::remove_dir_all(&data).ok();
}

#[gpui::test]
fn themes_come_from_plugins_that_are_on(cx: &mut TestAppContext) {
    let _app = App::open(cx, &World::new("themes"));
    let data = fresh("themes");
    let plugins = plugins_in(cx, &data, false);
    let theme = manifest("dusky", &[], |m| {
        m.as_object_mut().unwrap().remove("main");
        m["contributes"] = json!({ "themes": [{ "id": "dusk", "name": "Dusk", "colors": { "bg0": "#000000" } }] });
    });
    let uid = plugins.update(cx, |plugins, cx| {
        plugins.set_allow_unverified(true, cx);
        let uid = plugins.install(&package(&theme, b""), None, cx).unwrap();
        plugins.start_all(cx);
        uid
    });
    assert!(cx.read(|cx| !plugins.read(cx).running.contains_key(&uid)), "a theme alone runs nothing");
    let key = format!("{uid}/dusk");
    assert_eq!(cx.read(|cx| plugins.read(cx).themes()), vec![(key.clone(), "Dusk".to_string(), "Plugin dusky".to_string())]);
    assert_eq!(cx.read(|cx| plugins.read(cx).theme_colors(&key)).unwrap()["bg0"], "#000000");
    assert!(cx.read(|cx| plugins.read(cx).theme_colors("nobody/dusk").is_none() && plugins.read(cx).theme_colors("no-slash").is_none()));
    plugins.update(cx, |plugins, cx| plugins.set_enabled(&uid, false, cx));
    assert!(cx.read(|cx| plugins.read(cx).themes().is_empty() && plugins.read(cx).theme_colors(&key).is_none()), "not once it's off");
    std::fs::remove_dir_all(&data).ok();
}

#[gpui::test]
fn a_start_that_never_finished_twice_starts_without_plugins(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("safe-mode"));
    let data = fresh("safe-mode");
    let plugins = plugins_in(cx, &data, false);
    let dir = source("safer", &[], |_| {});
    plugins.update(cx, |plugins, cx| {
        plugins.set_allow_unverified(true, cx);
        plugins.load_folder(&dir, cx).unwrap();
        plugins.start_all(cx);
        plugins.start_all(cx);
    });
    // Two starts that didn't last.
    assert_eq!(super::failed_starts(&data), 1);
    super::note_start(&data);
    let safe = plugins_in(cx, &data, false);
    let reason = cx.read(|cx| safe.read(cx).safe_mode.clone()).expect("safe mode");
    assert!(reason.contains("didn't finish starting twice"));
    safe.update(cx, |plugins, cx| plugins.start_all(cx));
    app.run(cx);
    assert!(app.toasts(cx).contains(&reason));
    assert!(cx.read(|cx| safe.read(cx).running.is_empty() && safe.read(cx).themes().is_empty()));
    // One that lasted clears it.
    super::started_well(&data);
    assert_eq!(super::failed_starts(&data), 0);
    let asked = plugins_in(cx, &data, true);
    assert!(cx.read(|cx| asked.read(cx).safe_mode.clone()).unwrap().contains("--no-plugins"));
    // A device whose key couldn't be read installs nothing.
    let keyless = cx.update(|cx| cx.new(|cx| Plugins::new(data.clone(), None, false, cx)));
    keyless.update(cx, |plugins, cx| {
        assert!(!plugins.usable());
        assert!(plugins.install(b"x", None, cx).unwrap_err().contains("device's key"));
        assert!(plugins.propose_file(b"x".to_vec(), cx).unwrap_err().contains("device's key"));
    });
    std::fs::remove_dir_all(&data).ok();
}

#[gpui::test]
fn a_developers_folder_loads_again_as_its_files_change(cx: &mut TestAppContext) {
    let harness = Harness::open(cx, "watched", &[], |_| {});
    let dir = std::path::PathBuf::from(harness.read(cx, |plugins| plugins.record.find(&harness.uid).unwrap().path.clone()));
    let later = std::time::SystemTime::now() + Duration::from_secs(60);
    let touch = |path: &Path| std::fs::File::options().write(true).open(path).unwrap().set_modified(later).unwrap();
    std::fs::write(dir.join("main.js"), "globalThis.__zunaDefine(() => { /* changed */ });").unwrap();
    touch(&dir.join("main.js"));
    harness.sent(cx);
    cx.executor().advance_clock(Duration::from_millis(1100));
    cx.run_until_parked();
    assert!(harness.log(cx).iter().any(|line| line == "Its files changed, so it was loaded again."));
    let boot = harness.sent(cx).into_iter().find(|message| message["t"] == "boot").expect("it boots again");
    assert!(boot["source"].as_str().unwrap().contains("changed"));
    // A change that breaks it is a problem shown, not a crash.
    std::fs::write(dir.join("plugin.json"), "{ broken").unwrap();
    std::fs::File::options().write(true).open(dir.join("plugin.json")).unwrap().set_modified(later + Duration::from_secs(60)).unwrap();
    cx.executor().advance_clock(Duration::from_millis(1100));
    cx.run_until_parked();
    assert!(harness.read(cx, |plugins| plugins.problems.get(&harness.uid).is_some_and(|problem| problem.contains("doesn't parse"))));
    // Proposed again, a folder that's installed already loads without asking.
    std::fs::write(dir.join("plugin.json"), manifest("watched", &[], |_| {}).to_string()).unwrap();
    harness.plugins.update(cx, |plugins, cx| plugins.propose_folder(dir.clone(), cx)).unwrap();
    assert!(harness.read(cx, |plugins| plugins.proposal.is_none() && plugins.problems.is_empty()));
    let other = source("another", &["messages.read"], |_| {});
    harness.plugins.update(cx, |plugins, cx| plugins.propose_folder(other.clone(), cx)).unwrap();
    let proposal = harness.read(cx, |plugins| plugins.proposal.clone()).expect("a new folder is asked about");
    assert!(!proposal.verified);
    harness.plugins.update(cx, |plugins, cx| plugins.confirm(proposal.id, cx));
    assert!(harness.read(cx, |plugins| plugins.loaded.contains_key("folder:another")));
    harness.plugins.update(cx, |plugins, cx| plugins.set_allow_unverified(false, cx));
    assert!(harness.plugins.update(cx, |plugins, cx| plugins.propose_folder(other.clone(), cx)).is_err());
}
