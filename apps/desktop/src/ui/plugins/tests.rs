//! The plugins' interface, on GPUI's test platform: the warning before an unverified plugin is
//! installed, which Enter and Escape must cancel, installing nothing.

use std::io::Write;

use gpui::{TestAppContext, VisualTestContext};
use serde_json::json;

use crate::state::Overlay;
use crate::testing::{App, World};

/// An unsigned package of a plugin that reads messages.
fn package() -> Vec<u8> {
    let manifest = json!({
        "manifest": 1, "id": "reader", "name": "Reader", "version": "1.0.0", "description": "Reads.",
        "author": { "name": "Someone" }, "license": "MIT", "main": "main.js", "api": 1,
        "permissions": ["messages.read", "network"], "hosts": ["api.example.com"]
    });
    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("plugin.json", options).unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        writer.start_file("main.js", options).unwrap();
        writer.write_all(b"globalThis.__zunaDefine?.(() => {});").unwrap();
        writer.finish().unwrap();
    }
    out.into_inner()
}

#[gpui::test]
fn the_warning_is_cancelled_by_enter_and_escape_and_installs_nothing(cx: &mut TestAppContext) {
    let app = App::open(cx, &World::new("plugin-warning"));
    crate::ui::motion::set_reduced(true);
    let plugins = cx.update(|cx| crate::plugins::init(Some(&[3u8; 32]), false, cx));
    // Without the switch, an unverified plugin isn't even asked about.
    let refused = plugins.update(cx, |plugins, cx| plugins.propose_file(package(), cx));
    assert!(refused.unwrap_err().contains("Allow plugins Zuna hasn't checked"));
    plugins.update(cx, |plugins, cx| plugins.set_allow_unverified(true, cx));
    for key in ["enter", "escape"] {
        let id = plugins.update(cx, |plugins, cx| plugins.propose_file(package(), cx)).expect("it's proposed");
        app.run(cx);
        assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::PluginInstall { id }), "the warning is up");
        let proposal = cx.read(|cx| plugins.read(cx).proposal.clone()).expect("it waits for the person");
        assert!(!proposal.verified);
        assert_eq!(proposal.told()[0].0, "Read your messages and send them to api.example.com", "the dangerous pair first");
        let mut window = VisualTestContext::from_window(app.window.into(), cx);
        window.simulate_keystrokes(key);
        app.run(cx);
        assert_eq!(app.read(cx, |state| state.overlay.clone()), Some(Overlay::Settings { section: Some("plugins".into()) }), "{key} cancels, back in Settings");
        assert!(cx.read(|cx| plugins.read(cx).record.plugins.is_empty() && plugins.read(cx).proposal.is_none()), "{key} installs nothing");
    }
}

/// A view with one of every node the app draws, each handler named by where it is.
fn every_node() -> serde_json::Value {
    let text = |text: &str| json!({ "type": "string", "props": { "text": text }, "children": [] });
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    json!({ "type": "column", "props": { "gap": "m", "padding": "s", "align": "start", "justify": "between", "grow": true, "background": "bg2", "rounded": true }, "children": [
        { "type": "heading", "props": {}, "children": [text("Stats")] },
        { "type": "text", "props": { "size": "s", "weight": "bold", "color": "#ff000080", "mono": true }, "children": [text("Bold")] },
        { "type": "text", "props": { "size": "xl", "weight": "medium", "color": "accent" }, "children": [text("Medium")] },
        { "type": "markup", "props": { "text": "**markup** and `code`" }, "children": [] },
        { "type": "row", "props": { "wrap": true, "align": "center", "justify": "end" }, "children": [
            { "type": "button", "props": { "kind": "primary", "icon": "star", "onClick": "panel:stats|0.4.0|onClick" }, "children": [text("Go")] },
            { "type": "button", "props": { "kind": "danger", "disabled": true }, "children": [text("Off")] },
            { "type": "button", "props": { "kind": "ghost" }, "children": [text("Ghost")] },
            { "type": "iconButton", "props": { "icon": "star", "title": "Star", "active": true, "onClick": "panel:stats|0.4.3|onClick" }, "children": [] },
            { "type": "iconButton", "props": { "icon": "nonsense" }, "children": [] },
        ] },
        { "type": "stack", "props": { "align": "end" }, "children": [{ "type": "spinner", "props": { "size": 20 }, "children": [] }, { "type": "spacer", "props": {}, "children": [] }] },
        { "type": "scroll", "props": { "height": 200, "justify": "center" }, "children": [
            { "type": "field", "props": { "label": "On", "hint": "A switch" }, "children": [{ "type": "switch", "props": { "value": true, "onChange": "panel:stats|0.6.0.0|onChange" }, "children": [] }] },
            { "type": "field", "props": { "label": "Level" }, "children": [{ "type": "slider", "props": { "value": 0.3, "onChange": "panel:stats|0.6.1.0|onChange" }, "children": [] }] },
            { "type": "select", "props": { "value": "b", "options": ["a", { "value": "b", "label": "Bee" }, 3], "onChange": "panel:stats|0.6.2|onChange" }, "children": [] },
            { "type": "input", "props": { "value": "typed", "placeholder": "Type", "onChange": "panel:stats|0.6.3|onChange", "onSubmit": "panel:stats|0.6.3|onSubmit" }, "children": [] },
            { "type": "input", "props": { "placeholder": "Many", "multiline": true, "masked": true }, "children": [] },
        ] },
        { "type": "notice", "props": { "tone": "warning", "icon": "info" }, "children": [text("Careful")] },
        { "type": "notice", "props": { "tone": "danger" }, "children": [text("Danger")] },
        { "type": "notice", "props": {}, "children": [text("Plain")] },
        { "type": "image", "props": { "src": "assets/icon.svg", "width": 24, "height": 24, "rounded": true }, "children": [] },
        { "type": "image", "props": { "src": png }, "children": [] },
        { "type": "image", "props": { "src": "https://example.com/a.png" }, "children": [] },
        { "type": "avatar", "props": { "name": "Bob", "size": 40 }, "children": [] },
        { "type": "icon", "props": { "name": "star", "size": 20, "color": "green" }, "children": [] },
        { "type": "divider", "props": {}, "children": [] },
        { "type": "canvas", "props": { "width": 100, "height": 60, "shapes": [
            { "kind": "rect", "x": 1, "y": 1, "width": 20, "height": 10, "radius": 2, "color": "red" },
            { "kind": "rect", "x": 30, "y": 1, "width": 20, "height": 10, "fill": false },
            { "kind": "circle", "x": 60, "y": 20, "radius": 8, "color": "#00ff00" },
            { "kind": "circle", "x": 80, "y": 20, "radius": 8, "fill": false },
            { "kind": "line", "x": 0, "y": 50, "x2": 100, "y2": 50, "width": 2 },
            { "kind": "text", "x": 2, "y": 40, "text": "Hi", "size": 12, "color": "text3" },
            { "kind": "blob" },
        ] }, "children": [] },
    ] })
}

#[gpui::test]
fn what_plugins_put_in_the_app_is_drawn_where_they_put_it(cx: &mut TestAppContext) {
    use crate::plugins::tests_running::Harness;
    use crate::state::Panel;
    use crate::testing::fixtures::{BOB, SERVER};
    crate::ui::motion::set_reduced(true);
    let harness = Harness::open(cx, "drawer", &["messages.read", "messages.decorate", "conversations.read"], |m| {
        m["contributes"] = json!({ "settings": [
            { "type": "switch", "key": "loud", "label": "Loud", "hint": "Makes it loud" },
            { "type": "select", "key": "language", "label": "Language", "choices": ["en", "pl"] },
            { "type": "text", "key": "name", "label": "Name", "placeholder": "Yours" },
            { "type": "slider", "key": "level", "label": "Level" }
        ] });
    });
    let (app, uid) = (&harness.app, harness.uid.clone());
    for (kind, id, hover) in [("panel", "stats", false), ("page", "home", false), ("dialog", "ask", false), ("headerButton", "head", false), ("composerButton", "box", false), ("messageAction", "quote", true), ("conversationAction", "pin", false), ("settings", "settings", false)] {
        harness.ask(cx, "ui.register", json!({ "kind": kind, "id": id, "title": format!("The {id}"), "icon": "star", "hover": hover })).unwrap();
    }
    // Before a view comes, a frame says it's starting.
    app.update(cx, |state, cx| state.select_conversation(Some(format!("user:{BOB}")), cx));
    // What it does to the chat's messages: changed, hidden, marked or drawn under.
    harness.ask(cx, "decorate.register", json!({})).unwrap();
    cx.executor().advance_clock(std::time::Duration::from_millis(20));
    cx.run_until_parked();
    let asked = harness.sent(cx).into_iter().find(|message| message["fn"] == "decorate").expect("the chat's messages are asked about");
    let count = asked["args"]["messages"].as_array().unwrap().len();
    let small = json!({ "type": "text", "props": {}, "children": [{ "type": "string", "props": { "text": "Under" }, "children": [] }] });
    let answers: Vec<serde_json::Value> = (0..count)
        .map(|index| match index % 4 {
            0 => json!({ "text": "Translated" }),
            1 => json!({ "hidden": true }),
            2 => json!({ "mark": { "label": "Checked", "icon": "check" } }),
            _ => json!({ "view": small }),
        })
        .collect();
    harness.say(cx, json!({ "t": "done", "n": asked["n"], "ok": true, "value": answers }));
    app.run(cx);
    let first = asked["args"]["messages"][0].clone();
    let decorated: crate::models::MessageView = serde_json::from_value(json!({ "id": first["id"], "groupId": first["groupId"], "senderId": first["senderId"], "createdAt": first["createdAt"], "status": "sent", "text": first["text"] })).unwrap();
    assert_eq!(cx.read(|cx| crate::ui::plugins::decorations(SERVER, &decorated, cx)).len(), 1);
    assert!(cx.read(|cx| crate::ui::plugins::decorations(crate::telegram::SERVER_ID, &decorated, cx).is_empty()));
    harness.plugins.update(cx, |plugins, cx| plugins.toggle_original(crate::plugins::decoration_key(SERVER, &decorated), cx));
    app.run(cx);
    assert!(cx.read(|cx| crate::ui::plugins::showing_original(SERVER, &decorated, cx)));

    cx.update(|cx| crate::ui::plugins::open(&uid, "panel", "stats", cx));
    app.run(cx);
    assert!(matches!(app.read(cx, |state| state.panel.clone()), Some(Panel::Plugin(_))));
    for view in ["panel:stats", "page:home", "dialog:ask", "settings:settings"] {
        harness.ask(cx, "ui.view", json!({ "id": view, "tree": every_node() })).unwrap();
    }
    app.run(cx);
    let handle = harness.plugins.update(cx, |plugins, _| plugins.handle(&uid, "panel", "stats"));
    assert_eq!(cx.read(|cx| crate::ui::plugins::title(handle, cx)), Some(("The stats".to_string(), uid.clone())));
    assert_eq!(cx.read(|cx| crate::ui::plugins::title_of(&uid, "Go", cx)), "Go (Plugin drawer, unverified)");
    assert_eq!(cx.read(|cx| crate::ui::plugins::rail_items(cx)).len(), 1);

    // The plugin's own inputs keep what's typed, and tell it.
    harness.sent(cx);
    let input = cx.read(|_| crate::ui::plugins::view::input_of(&uid, "0.6.3")).expect("the view's field");
    assert_eq!(cx.read(|cx| input.read(cx).text().to_string()), "typed", "it holds what the plugin said");
    input.update(cx, |input, cx| input.set_text("changed", cx));
    app.run(cx);
    let handled: Vec<serde_json::Value> = harness.sent(cx).into_iter().filter(|message| message["fn"] == "handler").collect();
    assert_eq!(handled[0]["args"], json!({ "id": "panel:stats|0.6.3|onChange", "value": "changed" }));
    for message in &handled {
        harness.say(cx, json!({ "t": "done", "n": message["n"], "ok": true }));
    }

    // Its page in the main area, and its dialog over the app.
    cx.update(|cx| crate::ui::plugins::open(&uid, "page", "home", cx));
    app.run(cx);
    assert!(app.read(cx, |state| state.plugin_page.is_some()));
    cx.update(|cx| crate::ui::plugins::open(&uid, "dialog", "ask", cx));
    app.run(cx);
    assert!(matches!(app.read(cx, |state| state.overlay.clone()), Some(crate::state::Overlay::Plugin(_))));
    app.update(cx, |state, cx| state.set_overlay(None, cx));

    // Its entries in a message's menu and a chat's, which tell it what they were used on.
    let message: crate::models::MessageView = serde_json::from_value(crate::testing::fixtures::message("m01", crate::testing::fixtures::DM, 1.0, BOB, "hi", json!({}))).unwrap();
    let conversation = app.read(cx, |state| state.active().and_then(|server| server.active_conversation().cloned())).expect("a chat is open");
    let entries = cx.read(|cx| crate::ui::plugins::message_entries(SERVER, &message, cx));
    assert!(entries[0].separator && entries[1].label == "The quote · Unverified");
    assert!(cx.read(|cx| crate::ui::plugins::message_entries(crate::telegram::SERVER_ID, &message, cx).is_empty()), "nothing on Telegram's");
    let chats = cx.read(|cx| crate::ui::plugins::conversation_entries(SERVER, &conversation, cx));
    assert_eq!(chats[1].label, "The pin · Unverified");
    harness.sent(cx);
    for action in [entries[1].action.clone().unwrap(), chats[1].action.clone().unwrap()] {
        app.window.update(cx, |_, window, cx| action(window, cx)).unwrap();
    }
    let actions: Vec<serde_json::Value> = harness.sent(cx).into_iter().filter(|message| message["fn"] == "action").collect();
    assert_eq!(actions[0]["args"]["target"]["text"], "hi", "with messages.read, the message itself");
    assert_eq!(actions[1]["args"]["target"]["name"], "Bob", "with conversations.read, the chat's name");
    for message in &actions {
        harness.say(cx, json!({ "t": "done", "n": message["n"], "ok": true }));
    }

    // Its section of Settings, and the Plugins page listing it with its log.
    for section in ["plugins".to_string(), format!("plugin:{uid}")] {
        app.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Settings { section: Some(section) }), cx));
    }
    harness.plugins.update(cx, |plugins, cx| plugins.set_setting(&uid, "loud", json!(true), cx));
    app.run(cx);
    app.update(cx, |state, cx| state.set_overlay(None, cx));

    // Nothing of it shows while the app asks the person something.
    app.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Verify { user_id: BOB.into() }), cx));
    assert!(cx.read(|cx| crate::plugins::security_question_up(cx)));
    app.update(cx, |state, cx| state.set_overlay(None, cx));
    // A stopped plugin's frames close, and its fields are forgotten.
    harness.plugins.update(cx, |plugins, cx| plugins.set_enabled(&uid, false, cx));
    app.run(cx);
    assert!(app.read(cx, |state| state.panel.is_none() && state.plugin_page.is_none()));
    assert!(crate::ui::plugins::view::input_of(&uid, "0.6.3").is_none());
}
