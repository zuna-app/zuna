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
