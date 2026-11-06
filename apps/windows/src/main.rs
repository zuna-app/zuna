//! Zuna for Windows: the desktop app's interface drawn with GPUI, around the same
//! client core every app runs.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod emoji_data;
mod format;
mod host;
mod markup;
mod media;
mod models;
mod platform;
mod settings;
mod state;
mod theme;
mod ui;
mod voice;

use gpui::{App, Application, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions, actions, point, prelude::*, px, size};

use state::{AppState, Store};

actions!(zuna, [Quit]);

fn main() {
    // With where each line came from: GPUI logs errors it swallowed, and their message alone rarely says enough.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|out, record| {
            use std::io::Write;
            let place = match (record.file(), record.line()) {
                (Some(file), Some(line)) => format!("{file}:{line}"),
                _ => record.target().to_string(),
            };
            writeln!(out, "[{} {} {place}] {}", chrono::Local::now().format("%H:%M:%S%.3f"), record.level(), record.args())
        })
        .init();
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = checks(&args) {
        std::process::exit(code);
    }

    Application::new().with_assets(assets::Assets).run(|cx: &mut App| {
        assets::load_fonts(cx);
        ui::text_input::bind_keys(cx);
        ui::bind_keys(cx);
        cx.bind_keys([KeyBinding::new("ctrl-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| quit(cx));

        let dir = host::data_dir();
        let device_key = host::device_key::load(&dir);
        let (core, events) = host::Core::start(dir);
        let state = cx.new(|cx| AppState::new(core, events, cx));
        cx.set_global(Store(state.clone()));
        ui::notifications::install(state.downgrade(), cx);

        // The tray's icon, and what's picked from it.
        let mut tray = platform::tray::start();
        cx.spawn(async move |cx| {
            use futures::StreamExt;
            while let Some(event) = tray.next().await {
                // Outside an update, as showing the window sends it messages GPUI answers.
                match event {
                    platform::tray::TrayEvent::Open => platform::show_main(),
                    platform::tray::TrayEvent::Quit => {
                        cx.update(quit).ok();
                        break;
                    }
                }
            }
        })
        .detach();
        match device_key {
            Ok(key) => state.update(cx, |state, cx| state.boot(key.key, key.protected, cx)),
            Err(error) => state.update(cx, |state, cx| {
                state.phase = state::Phase::Failed(error.to_string());
                cx.notify();
            }),
        }

        let bounds = Bounds::centered(None, size(px(1280.), px(832.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions { title: Some("Zuna".into()), appears_transparent: true, traffic_light_position: Some(point(px(12.), px(10.))) }),
                window_min_size: Some(size(px(720.), px(480.))),
                app_id: Some("Zuna".into()),
                ..Default::default()
            },
            |window, cx| {
                platform::set_main_window(window);
                // Closing keeps it running in the tray, so messages still arrive, unless that's turned off.
                let closing = state.clone();
                window.on_window_should_close(cx, move |_, cx| {
                    if closing.read(cx).settings.close_to_tray {
                        platform::later(cx, platform::hide_main);
                        false
                    } else {
                        quit(cx);
                        true
                    }
                });
                cx.new(|cx| ui::Root::new(state.clone(), window, cx))
            },
        )
        .expect("the window opens");
        cx.activate(true);
    });
}

/// Quits for good, taking the tray's icon with it.
fn quit(cx: &mut App) {
    platform::tray::remove();
    cx.quit();
}

/// Checks of the hosted core with no window, for development:
/// `zuna --core-eval <script>...` and `zuna --core-check <method> [args as JSON...]`.
fn checks(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str) {
        Some("--core-eval") => {
            let dir = host::data_dir();
            let key = host::device_key::load(&dir).expect("a device key");
            let (core, _events) = host::Core::start(dir);
            futures::executor::block_on(core.boot(key.key, "Windows PC".into())).expect("the core boots");
            for source in &args[2..] {
                if let Some(ms) = source.strip_prefix("sleep:") {
                    std::thread::sleep(std::time::Duration::from_millis(ms.parse().unwrap_or(500)));
                    continue;
                }
                println!("{}", futures::executor::block_on(core.eval(source.clone())));
            }
            Some(0)
        }
        Some("--core-check") => {
            let dir = host::data_dir();
            let key = host::device_key::load(&dir).expect("a device key");
            let (core, _events) = host::Core::start(dir);
            let result = futures::executor::block_on(async {
                core.boot(key.key, "Windows PC".into()).await?;
                let method = args.get(2).cloned().unwrap_or_else(|| "listServers".into());
                let call_args: Vec<serde_json::Value> = args[3.min(args.len())..].iter().map(|arg| serde_json::from_str(arg).unwrap_or(serde_json::Value::String(arg.clone()))).collect();
                // ZUNA_CHECK_SERVER asks a server's session rather than the client.
                let server = std::env::var("ZUNA_CHECK_SERVER").ok();
                core.call(server.as_deref(), &method, call_args).await.map_err(|error| error.message)
            });
            match result {
                Ok(value) => {
                    println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
                    Some(0)
                }
                Err(error) => {
                    eprintln!("{error}");
                    Some(1)
                }
            }
        }
        _ => None,
    }
}
