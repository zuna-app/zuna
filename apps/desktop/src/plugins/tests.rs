//! The plugins' tests: manifests and every refusal, packages, signatures and the index's order
//! of checks, the table, what plugins are told, views' limits, sealed storage, and a host running
//! real plugins, the hostile one among them.

use std::io::Write;
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};

use super::broker::{may_call, plugin_message, sanitize};
use super::manifest::{Manifest, Permission};
use super::market::{Index, Version, matches_with, open_index};
use super::package::{Package, bad_path, sha256_hex};
use super::store::{Keys, Kind, Origin, Record, Storage};
use super::surface::{Rule, surface};
use super::{net, trust, view};

const HOSTILE: &str = include_str!("../../../../examples/plugins/hostile/main.js");

fn manifest(change: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut value = json!({
        "manifest": 1,
        "id": "hello",
        "name": "Hello",
        "version": "1.2.0",
        "description": "Says hello.",
        "author": { "name": "Someone", "url": "https://example.com" },
        "license": "MIT",
        "main": "main.js",
        "api": 1,
        "permissions": ["messages.read", "messages.decorate"],
        "contributes": {
            "settings": [{ "key": "language", "type": "select", "label": "Translate into", "choices": ["en", "pl"], "default": "en" }],
            "commands": [{ "id": "hello", "title": "Say hello", "keys": "ctrl-shift-y", "slash": "hello" }]
        }
    });
    change(&mut value);
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn a_good_manifest_parses() {
    let parsed = Manifest::parse(&manifest(|_| {})).expect("it parses");
    assert_eq!(parsed.id, "hello");
    assert_eq!(parsed.sorted_permissions(), vec![Permission::MessagesRead, Permission::MessagesDecorate]);
    assert!(!parsed.can_leak());
}

#[test]
fn manifests_are_refused_for_anything_out_of_place() {
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        ("an unknown field", Box::new(|m| m["extra"] = json!(true))),
        ("an id with capitals", Box::new(|m| m["id"] = json!("Hello"))),
        ("too short an id", Box::new(|m| m["id"] = json!("hi"))),
        ("a version that isn't one", Box::new(|m| m["version"] = json!("1.2"))),
        ("a version with leading zeros", Box::new(|m| m["version"] = json!("1.02.0"))),
        ("a newer API", Box::new(|m| m["api"] = json!(2))),
        ("an older API", Box::new(|m| m["api"] = json!(0))),
        ("a permission there isn't", Box::new(|m| m["permissions"] = json!(["keys.read"]))),
        ("a permission twice", Box::new(|m| m["permissions"] = json!(["messages.read", "messages.read"]))),
        ("decorating without reading", Box::new(|m| m["permissions"] = json!(["messages.decorate"]))),
        ("the network without hosts", Box::new(|m| m["permissions"] = json!(["network"]))),
        ("hosts without the network", Box::new(|m| m["hosts"] = json!(["api.example.com"]))),
        ("a host with a scheme", Box::new(|m| {
            m["permissions"] = json!(["network"]);
            m["hosts"] = json!(["https://api.example.com"]);
        })),
        ("an address for a host", Box::new(|m| {
            m["permissions"] = json!(["network"]);
            m["hosts"] = json!(["127.0.0.1"]);
        })),
        ("a script that isn't main.js", Box::new(|m| m["main"] = json!("other.js"))),
        ("an icon outside assets", Box::new(|m| m["icon"] = json!("../icon.svg"))),
        ("a source that isn't https", Box::new(|m| m["source"] = json!("http://example.com"))),
        ("a select's default that isn't a choice", Box::new(|m| m["contributes"]["settings"][0]["default"] = json!("de"))),
        ("a setting of no type there is", Box::new(|m| m["contributes"]["settings"][0]["type"] = json!("color"))),
        ("a chord for keys", Box::new(|m| m["contributes"]["commands"][0]["keys"] = json!("ctrl-k ctrl-t"))),
        ("a theme setting a color there isn't", Box::new(|m| m["contributes"]["themes"] = json!([{ "id": "dusk", "name": "Dusk", "colors": { "glow": "#000000" } }]))),
        ("a theme color that isn't one", Box::new(|m| m["contributes"]["themes"] = json!([{ "id": "dusk", "name": "Dusk", "colors": { "bg0": "black" } }]))),
        ("permissions with no script", Box::new(|m| m.as_object_mut().unwrap().remove("main").map(|_| ()).unwrap_or(()))),
    ];
    for (what, change) in cases {
        assert!(Manifest::parse(&manifest(|m| change(m))).is_err(), "{what} is refused");
    }
    // A theme alone, with no script and no permissions, is a plugin.
    let theme = manifest(|m| {
        m.as_object_mut().unwrap().remove("main");
        m["permissions"] = json!([]);
        m["contributes"] = json!({ "themes": [{ "id": "dusk", "name": "Dusk", "colors": { "bg0": "#000000", "accentSoft": "#6c8cff29" } }] });
    });
    assert!(Manifest::parse(&theme).is_ok());
}

#[test]
fn the_dangerous_pair_is_named_first() {
    let parsed = Manifest::parse(&manifest(|m| {
        m["permissions"] = json!(["network", "messages.read"]);
        m["hosts"] = json!(["api.example.com"]);
    }))
    .unwrap();
    assert!(parsed.can_leak());
    let told = parsed.told();
    assert_eq!(told[0], ("Can send your messages to api.example.com".to_string(), true));
    assert_eq!(told[1].0, "Reads your messages");
}

fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in files {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }
    out.into_inner()
}

fn signed(files: &[(&str, &[u8])], secret: &[u8]) -> Vec<u8> {
    let unsigned = Package::open(&zip(files)).expect("the package opens");
    let signature = zuna_crypto::hybrid::sign(secret, &unsigned.signed_message()).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(signature);
    let mut all: Vec<(&str, &[u8])> = files.to_vec();
    all.push(("signature", encoded.as_bytes()));
    zip(&all)
}

#[test]
fn packages_open_and_their_signatures_cover_every_file() {
    let secret = zuna_crypto::hybrid::generate(zuna_crypto::hybrid::LASTING).unwrap();
    let key = zuna_crypto::hybrid::public(&secret).unwrap();
    let manifest = manifest(|_| {});
    let files: Vec<(&str, &[u8])> = vec![("plugin.json", &manifest), ("main.js", b"definePlugin(() => {})"), ("assets/icon.svg", b"<svg/>")];
    let bytes = signed(&files, &secret);
    let package = Package::open(&bytes).expect("it opens");
    assert_eq!(package.sha256.as_deref(), Some(sha256_hex(&bytes).as_str()));
    assert!(trust::verified_with(&package, std::slice::from_ref(&key)), "signed with the key");
    assert!(!trust::verified(&package), "not with Zuna's keys");
    // Any file changed, the signature no longer holds.
    let other = zuna_crypto::hybrid::generate(zuna_crypto::hybrid::LASTING).unwrap();
    assert!(!trust::verified_with(&package, &[zuna_crypto::hybrid::public(&other).unwrap()]));
    let mut changed = Package::open(&bytes).unwrap();
    changed.files.insert("main.js".into(), b"steal()".to_vec());
    assert!(!trust::verified_with(&changed, &[key]));
    assert!(String::from_utf8(package.signed_message()).unwrap().starts_with("zuna-plugin-package/v1\n"));
}

#[test]
fn packages_are_refused_for_what_doesnt_belong() {
    let good = manifest(|_| {});
    let script: &[u8] = b"x";
    let refused = |files: &[(&str, &[u8])], what: &str| assert!(Package::open(&zip(files)).is_err(), "{what} is refused");
    refused(&[("plugin.json", &good), ("main.js", script), ("../escape.js", script)], "a path that climbs");
    refused(&[("plugin.json", &good), ("main.js", script), ("assets/../main.js", script)], "a path that climbs inside");
    refused(&[("plugin.json", &good), ("main.js", script), ("src/main.ts", script)], "a file outside the layout");
    refused(&[("plugin.json", &good)], "a manifest naming a script that's missing");
    refused(&[("main.js", script)], "no manifest");
    refused(&[("plugin.json", b"{not json"), ("main.js", script)], "a manifest that doesn't parse");
    let large = vec![0u8; 9 << 20];
    refused(&[("plugin.json", &good), ("main.js", &large)], "more than 8 MB");
    assert!(Package::open(b"not a zip at all").is_err());
    for path in ["../x", "assets/../x", "assets//x", "/assets/x", "assets\\x", "assets/a b", "assets/a/b/c/d/e/f/g/h"] {
        assert!(bad_path(path).is_some(), "{path} is refused");
    }
    for path in ["plugin.json", "main.js", "signature", "assets/icon.svg", "assets/themes/dusk.json"] {
        assert!(bad_path(path).is_none(), "{path} is fine");
    }
}

#[test]
fn a_developers_folder_loads_as_it_was_built() {
    let dir = std::env::temp_dir().join(format!("zuna-plugin-folder-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    std::fs::write(dir.join("plugin.json"), manifest(|_| {})).unwrap();
    assert!(Package::open_folder(&dir).unwrap_err().contains("isn't built"));
    std::fs::write(dir.join("dist").join("main.js"), "definePlugin(() => {})").unwrap();
    let package = Package::open_folder(&dir).expect("it loads");
    assert!(package.sha256.is_none() && package.signature.is_none());
    std::fs::remove_dir_all(&dir).ok();
}

fn index_bytes(serial: u64, sha256: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "serial": serial,
        "made": "2026-12-01T12:00:00Z",
        "plugins": [{
            "id": "hello", "name": "Hello", "summary": "Says hello.", "author": "Someone", "source": "", "icon": "",
            "versions": [
                { "version": "1.2.0", "api": 1, "minBuild": 0, "file": "hello-1.2.0.zunaplugin", "size": 10, "sha256": sha256, "permissions": ["messages.read", "messages.decorate"], "hosts": [] },
                { "version": "1.10.0", "api": 1, "minBuild": 0, "file": "hello-1.10.0.zunaplugin", "size": 10, "sha256": "ab", "permissions": ["messages.read", "messages.decorate"], "hosts": [] },
                { "version": "2.0.0", "api": 2, "minBuild": 0, "file": "hello-2.0.0.zunaplugin", "size": 10, "sha256": "cd", "permissions": [], "hosts": [] }
            ]
        }],
        "revoked": [{ "id": "hello", "versions": ["1.10.0"], "reason": "It sent too much." }, { "sha256": "ef", "reason": "Harmful." }]
    }))
    .unwrap()
}

fn sign_index(bytes: &[u8], secret: &[u8]) -> String {
    let mut message = trust::INDEX_LABEL.as_bytes().to_vec();
    message.extend_from_slice(bytes);
    base64::engine::general_purpose::STANDARD.encode(zuna_crypto::hybrid::sign(secret, &message).unwrap())
}

#[test]
fn the_index_is_checked_in_order() {
    let secret = zuna_crypto::hybrid::generate(zuna_crypto::hybrid::LASTING).unwrap();
    let keys = vec![zuna_crypto::hybrid::public(&secret).unwrap()];
    let bytes = index_bytes(42, "00");
    let signature = sign_index(&bytes, &secret);
    let index = open_index(&bytes, &signature, &keys, 41).expect("a good index opens");
    // The signature is checked before anything in the index is read.
    assert!(open_index(b"{ not json", &sign_index(b"{ other", &secret), &keys, 0).unwrap_err().contains("isn't signed"));
    assert!(open_index(&bytes, &signature, &[zuna_crypto::hybrid::public(&zuna_crypto::hybrid::generate(2).unwrap()).unwrap()], 0).unwrap_err().contains("isn't signed"));
    // A package's signature, under its own label, never passes for an index's.
    let mut as_package = super::package::PACKAGE_LABEL.as_bytes().to_vec();
    as_package.extend_from_slice(&bytes);
    let package_signature = base64::engine::general_purpose::STANDARD.encode(zuna_crypto::hybrid::sign(&secret, &as_package).unwrap());
    assert!(open_index(&bytes, &package_signature, &keys, 0).is_err());
    // An older index can't bring back a withdrawn plugin.
    assert!(open_index(&bytes, &signature, &keys, 43).unwrap_err().contains("older"));
    // The newest this app runs: not a withdrawn version, nor one for another API.
    let (_, newest) = index.newest("hello").expect("a version runs here");
    assert_eq!(newest.version, "1.2.0");
    assert_eq!(index.revocation("hello", "1.10.0", None).as_deref(), Some("It sent too much."));
    assert_eq!(index.revocation("other", "1.0.0", Some("ef")).as_deref(), Some("Harmful."));
    assert!(index.revocation("hello", "1.2.0", Some("00")).is_none());
}

#[test]
fn a_package_must_be_what_the_index_says() {
    let secret = zuna_crypto::hybrid::generate(zuna_crypto::hybrid::LASTING).unwrap();
    let keys = vec![zuna_crypto::hybrid::public(&secret).unwrap()];
    let manifest = manifest(|_| {});
    let bytes = signed(&[("plugin.json", &manifest), ("main.js", b"x")], &secret);
    let package = Package::open(&bytes).unwrap();
    let index: Index = serde_json::from_slice(&index_bytes(1, &sha256_hex(&bytes))).unwrap();
    let expected: Version = index.plugins[0].versions[0].clone();
    assert!(matches_with(&expected, &package, &keys).is_ok());
    let mut other_hash = expected.clone();
    other_hash.sha256 = "00".into();
    assert!(matches_with(&other_hash, &package, &keys).is_err());
    let mut more = expected.clone();
    more.permissions.push("network".into());
    assert!(matches_with(&more, &package, &keys).is_err(), "permissions the index didn't name");
    let mut version = expected.clone();
    version.version = "1.2.1".into();
    assert!(matches_with(&version, &package, &keys).is_err());
    assert!(matches_with(&expected, &package, &[]).is_err(), "unsigned by the keys");
}

#[test]
fn the_table_refuses_every_method_without_its_permission_and_every_never_with_all() {
    let all: Vec<Permission> = Permission::ALL.to_vec();
    let methods = surface().methods();
    assert!(methods.len() > 150, "every method of the client and the session is classified");
    for (server, method, rule) in methods {
        match rule {
            Rule::Never => assert!(may_call(&all, server, &method).is_err(), "{method} is never"),
            Rule::Needs(permission) => {
                assert!(may_call(&[], server, &method).is_err(), "{method} needs {}", permission.name());
                let others: Vec<Permission> = all.iter().copied().filter(|other| *other != permission).collect();
                assert!(may_call(&others, server, &method).is_err(), "{method} needs exactly {}", permission.name());
                assert!(may_call(&[permission], server, &method).is_ok());
            }
        }
    }
    for never in ["voiceKey", "voiceAccess", "voiceScreenAccess", "changePassword", "regenerateRecoveryKey", "rotate", "deleteAccount", "signOut", "answerNewDevice", "prepareNewDevice", "revokeDevice", "markVerified", "clearVerification", "getDevices", "createBot", "banUser", "updateServerSettings"] {
        assert!(may_call(&all, true, never).is_err(), "{never} is out of reach");
    }
    for never in ["login", "register", "recover", "deleteAccount", "leaveServer", "linkPreview", "serverInfo", "open"] {
        assert!(may_call(&all, false, never).is_err(), "{never} is out of reach");
    }
    assert!(may_call(&all, true, "noSuchMethod").is_err(), "a method the table doesn't have is never");
    for never in ["voice_key", "security", "new_devices", "button", "activity", "preferences"] {
        assert_eq!(surface().event(never), Rule::Never, "{never} is told to no plugin");
    }
    assert_eq!(surface().event("message"), Rule::Needs(Permission::MessagesRead));
}

#[test]
fn plugins_are_told_nothing_that_opens_a_file_or_names_a_path() {
    let message = json!({
        "id": "m1", "groupId": "g1", "senderId": "u1", "text": "hi", "createdAt": 1, "editedAt": null,
        "attachments": [{ "fileId": "f1", "key": "secret-key", "prefix": "p", "chunks": 1, "name": "photo.jpg", "mime": "image/jpeg", "size": 10 }],
        "itemSecret": "s", "path": { "$file": { "path": "C:/Users/someone/cache/x", "type": "image/jpeg" } }
    });
    let clean = sanitize(&message);
    assert!(clean["attachments"][0].get("key").is_none() && clean["attachments"][0].get("prefix").is_none());
    assert_eq!(clean["attachments"][0]["name"], "photo.jpg");
    assert!(clean.get("itemSecret").is_none());
    assert_eq!(clean["path"], Value::Null);
    let told = plugin_message("s1", &message);
    assert_eq!(told, json!({ "serverId": "s1", "groupId": "g1", "id": "m1", "senderId": "u1", "text": "hi", "createdAt": 1, "editedAt": null, "attachments": [{ "name": "photo.jpg", "mime": "image/jpeg", "size": 10 }] }));
}

#[test]
fn the_network_reaches_only_named_hosts_over_https() {
    let hosts = vec!["api.example.com".to_string()];
    let allowed = |url: &str| net::allowed(&url::Url::parse(url).unwrap(), &hosts);
    assert!(allowed("https://api.example.com/translate?q=hi"));
    assert!(!allowed("https://evil.example.org/steal"), "a host it didn't name");
    assert!(!allowed("http://api.example.com/"), "without TLS");
    assert!(!allowed("https://api.example.com:8443/"), "on another port");
    assert!(!allowed("https://user:pass@api.example.com/"), "with a name and password");
    assert!(!allowed("https://127.0.0.1/"), "this machine");
    assert!(!allowed("https://[::1]/"), "this machine, by IPv6");
    assert!(!allowed("https://api.example.com.evil.org/"), "a name that only starts like it");
}

fn leaf(index: usize) -> Value {
    json!({ "type": "text", "props": {}, "children": [{ "type": "string", "props": { "text": index.to_string() }, "children": [] }] })
}

#[test]
fn views_are_held_to_their_limits() {
    let tree = json!({ "type": "column", "props": { "gap": "m" }, "children": [
        { "type": "heading", "props": {}, "children": [{ "type": "string", "props": { "text": "Stats" }, "children": [] }] },
        { "type": "button", "props": { "kind": "primary", "onClick": "panel:stats|0.1|onClick" }, "children": [{ "type": "string", "props": { "text": "Reset" }, "children": [] }] },
        { "type": "iframe", "props": { "src": "https://evil.example.org" }, "children": [] },
        { "type": "image", "props": { "src": "file:///etc/passwd" }, "children": [] },
        { "type": "text", "props": { "color": "#ff000080" }, "children": [] }
    ]});
    let node = view::parse(&tree).expect("it parses");
    let view::Node::Column(_, children) = node else { panic!("a column") };
    assert_eq!(children.len(), 3, "a node the app doesn't know, and a picture from the disk, are left out");
    assert!(matches!(&children[1], view::Node::Button { on_click: Some(id), .. } if id == "panel:stats|0.1|onClick"));
    assert!(matches!(&children[2], view::Node::Text { color: Some(view::Color::Rgba(0xff0000, alpha)), .. } if (*alpha - 128. / 255.).abs() < 0.01));
    let wide = json!({ "type": "column", "props": {}, "children": (0..2500).map(leaf).collect::<Vec<_>>() });
    assert!(view::parse(&wide).is_err(), "too many nodes");
    let mut deep = leaf(0);
    for _ in 0..40 {
        deep = json!({ "type": "column", "props": {}, "children": [deep] });
    }
    assert!(view::parse(&deep).is_err(), "too deep");
    let long = json!({ "type": "column", "props": {}, "children": (0..30).map(|_| json!({ "type": "markup", "props": { "text": "x".repeat(10_000) }, "children": [] })).collect::<Vec<_>>() });
    assert!(view::parse(&long).is_err(), "too much text");
}

#[test]
fn what_is_installed_and_kept_is_sealed() {
    let dir = std::env::temp_dir().join(format!("zuna-plugin-store-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let keys = Keys::from_device_key(&[7u8; 32]);
    let mut record = Record { allow_unverified: true, seen_serial: 42, ..Record::default() };
    record.plugins.push(super::store::Installed {
        id: "hello".into(),
        origin: Origin::File,
        name: "Hello".into(),
        version: "1.0.0".into(),
        sha256: Some("00".into()),
        path: "file-hello-1.0.0.zunaplugin".into(),
        granted: vec![Permission::MessagesRead],
        hosts: vec![],
        enabled: true,
        off_reason: None,
        installed_at: 0.,
    });
    record.save(&dir, &keys);
    let sealed = std::fs::read(super::store::folder(&dir).join("installed.sealed")).unwrap();
    assert!(!String::from_utf8_lossy(&sealed).contains("hello"), "nothing of it is readable on disk");
    assert_eq!(Record::load(&dir, &keys), record);
    assert_eq!(Record::load(&dir, &Keys::from_device_key(&[8u8; 32])), Record::default(), "another device key opens nothing");

    let storage = Storage::open(&dir.join("plugins.db"), keys.clone()).unwrap();
    storage.set("file:hello", Kind::Storage, "count", &json!(3)).unwrap();
    storage.set("file:hello", Kind::Settings, "language", &json!("pl")).unwrap();
    assert_eq!(storage.load("file:hello", Kind::Storage).get("count"), Some(&json!(3)));
    assert!(storage.load("verified:hello", Kind::Storage).is_empty(), "the same id from elsewhere gets none of it");
    assert!(storage.set("file:hello", Kind::Storage, "big", &json!("x".repeat(600 << 10))).is_err(), "a value over its limit");
    storage.remove_all("file:hello");
    assert!(storage.load("file:hello", Kind::Settings).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

// --- The host, running plugins ---

fn boot(source: &str, settings: Value) -> Value {
    json!({
        "t": "boot",
        "plugin": { "id": "test", "version": "1.0.0", "verified": false, "permissions": ["network"] },
        "source": source,
        "settings": settings,
        "storage": {},
        "limits": { "memory": 24 << 20, "stack": 512 << 10, "slice_ms": 300 },
    })
}

/// Waits for a message from the host that `wanted` picks, answering every ask on the way as
/// the broker would refuse it, unless `answer` says otherwise.
fn wait_for(from: &std::sync::mpsc::Receiver<Value>, to: &std::sync::mpsc::Sender<Option<String>>, wanted: impl Fn(&Value) -> bool) -> Value {
    loop {
        let message = from.recv_timeout(Duration::from_secs(20)).expect("the host answers in time");
        if wanted(&message) {
            return message;
        }
        if message["t"] == "ask" {
            let reply = json!({ "t": "reply", "n": message["n"], "ok": true, "value": null });
            to.send(Some(reply.to_string())).ok();
        }
    }
}

/// What the hostile plugin reported, which it writes as JSON.
fn toast_text(message: &Value) -> String {
    let text = message["args"]["text"].as_str().unwrap_or_default();
    serde_json::from_str::<String>(text).unwrap_or_else(|_| text.to_string())
}

#[test]
fn the_host_runs_a_plugin_and_draws_its_views_again_as_its_state_changes() {
    let source = r#"
        globalThis.__zunaDefine((zuna) => {
            zuna.commands.on("hello", ({ composer, args }) => composer.insert(`hello ${args}`));
            zuna.ui.panel("stats", { title: "Stats", render: (state) => ({ type: "column", props: {}, children: [
                { type: "text", props: {}, children: [{ type: "string", props: { text: String(state.count ?? 0) }, children: [] }] },
                { type: "button", props: { onClick: () => zuna.storage.set("count", (zuna.storage.get("count") ?? 0) + 1) }, children: [] },
            ] }) });
        });
    "#;
    let (to, from, thread) = super::host::spawn_for_test(boot(source, json!({})));
    let register = wait_for(&from, &to, |message| message["op"] == "ui.register");
    assert_eq!(register["args"]["kind"], "panel");
    let first = wait_for(&from, &to, |message| message["op"] == "ui.view");
    assert_eq!(first["args"]["tree"]["children"][0]["children"][0]["props"]["text"], "0");
    let handler = first["args"]["tree"]["children"][1]["props"]["onClick"].as_str().unwrap().to_string();
    assert_eq!(handler, "panel:stats|0.1|onClick", "a handler is named by where it is");
    wait_for(&from, &to, |message| message["t"] == "ready");
    // Pressing the button: the plugin keeps the new count, and the view goes again with it.
    to.send(Some(json!({ "t": "call", "n": 1, "fn": "handler", "args": { "id": handler, "value": null } }).to_string())).unwrap();
    let kept = wait_for(&from, &to, |message| message["op"] == "storage.set");
    assert_eq!(kept["args"], json!({ "key": "count", "value": 1 }));
    to.send(Some(json!({ "t": "reply", "n": kept["n"], "ok": true, "value": null }).to_string())).unwrap();
    let second = wait_for(&from, &to, |message| message["op"] == "ui.view");
    assert_eq!(second["args"]["tree"]["children"][0]["children"][0]["props"]["text"], "1");
    // A command, with what followed it.
    to.send(Some(json!({ "t": "call", "n": 2, "fn": "command", "args": { "id": "hello", "context": { "conversation": null, "args": "there" } } }).to_string())).unwrap();
    let insert = wait_for(&from, &to, |message| message["op"] == "composer.insert");
    assert_eq!(insert["args"]["text"], "hello there");
    to.send(Some(json!({ "t": "stop" }).to_string())).unwrap();
    assert_eq!(thread.join().unwrap(), 0);
}

#[test]
fn a_filter_answers_as_the_app_reads_it() {
    let source = r#"
        globalThis.__zunaDefine((zuna) => {
            zuna.messages.onOutgoing((draft) => draft.text.includes("secret") ? false : draft.text.replaceAll("teh", "the"));
        });
    "#;
    let (to, from, thread) = super::host::spawn_for_test(boot(source, json!({})));
    let registered = wait_for(&from, &to, |message| message["op"] == "filter.register");
    let id = registered["args"]["id"].as_str().unwrap().to_string();
    wait_for(&from, &to, |message| message["t"] == "ready");
    let ask = |n: u64, text: &str| json!({ "t": "call", "n": n, "fn": "filter", "args": { "id": id, "payload": { "text": text } } }).to_string();
    to.send(Some(ask(1, "teh cat"))).unwrap();
    assert_eq!(wait_for(&from, &to, |message| message["t"] == "done")["value"], json!({ "text": "the cat" }));
    to.send(Some(ask(2, "a secret"))).unwrap();
    assert_eq!(wait_for(&from, &to, |message| message["t"] == "done")["value"], json!({ "stop": true }));
    drop(to);
    assert_eq!(thread.join().unwrap(), 0, "the host goes once the app does");
}

#[test]
fn a_hostile_plugin_finds_nothing_of_the_app_in_its_context() {
    let (to, from, thread) = super::host::spawn_for_test(boot(HOSTILE, json!({ "attack": "globals" })));
    let report = wait_for(&from, &to, |message| message["op"] == "ui.toast");
    let found: Value = serde_json::from_str(&toast_text(&report)).unwrap();
    for (name, kind) in found.as_object().unwrap() {
        assert_eq!(kind, "undefined", "{name} isn't there");
    }
    to.send(Some(json!({ "t": "stop" }).to_string())).unwrap();
    thread.join().unwrap();
}

#[test]
fn a_hostile_plugins_endless_loop_is_ended() {
    let (to, from, thread) = super::host::spawn_for_test(boot(HOSTILE, json!({ "attack": "loop" })));
    let failed = wait_for(&from, &to, |message| message["t"] == "failed");
    let error = failed["error"].as_str().unwrap();
    assert!(error.contains("too long") || error.contains("interrupted"), "{failed}");
    assert_eq!(thread.join().unwrap(), 1, "the host ends");

    let (to, from, thread) = super::host::spawn_for_test(boot(HOSTILE, json!({ "attack": "loop-later" })));
    wait_for(&from, &to, |message| message["t"] == "ready");
    assert_eq!(wait_for(&from, &to, |message| message["t"] == "fault")["reason"], "slow");
    to.send(Some(json!({ "t": "stop" }).to_string())).unwrap();
    thread.join().unwrap();
}

#[test]
fn a_hostile_plugins_endless_memory_ends_it() {
    let (to, from, thread) = super::host::spawn_for_test(boot(HOSTILE, json!({ "attack": "memory" })));
    let ended = wait_for(&from, &to, |message| message["t"] == "failed" || message["t"] == "fault");
    assert!(ended["t"] == "failed" || ended["reason"] == "memory", "{ended}");
    // The app ends a plugin that failed to start; a host over its memory has ended itself.
    to.send(Some(json!({ "t": "stop" }).to_string())).ok();
    thread.join().unwrap();
}

#[test]
fn a_hostile_plugin_is_held_to_its_timers_and_what_it_sends() {
    let (to, from, thread) = super::host::spawn_for_test(boot(HOSTILE, json!({ "attack": "timers" })));
    assert!(toast_text(&wait_for(&from, &to, |message| message["op"] == "ui.toast")).starts_with("refused"));
    to.send(Some(json!({ "t": "stop" }).to_string())).unwrap();
    thread.join().unwrap();

    let (to, from, thread) = super::host::spawn_for_test(boot(HOSTILE, json!({ "attack": "spam" })));
    let report = wait_for(&from, &to, |message| message["op"] == "ui.toast");
    assert!(toast_text(&report).starts_with("refused"), "{report}");
    to.send(Some(json!({ "t": "stop" }).to_string())).unwrap();
    thread.join().unwrap();

    // Its view too large, its host unnamed, this machine and the Never list are the broker's to
    // refuse, which the tests above hold it to.
    let (to, from, thread) = super::host::spawn_for_test(boot(HOSTILE, json!({ "attack": "tree" })));
    let sent = wait_for(&from, &to, |message| message["op"] == "ui.view");
    assert!(view::parse(&sent["args"]["tree"]).is_err(), "the broker refuses its view");
    to.send(Some(json!({ "t": "stop" }).to_string())).unwrap();
    thread.join().unwrap();
}

