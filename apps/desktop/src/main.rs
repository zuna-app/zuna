//! Zuna for Windows, Linux and macOS: the web app's interface (packages/ui) drawn with GPUI, around
//! the same client core every app runs.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod devices;
mod emoji_data;
mod format;
mod host;
mod markup;
mod media;
mod models;
mod platform;
mod plugins;
mod settings;
mod state;
mod telegram;
#[cfg(all(feature = "test-control", unix))]
mod test_control;
#[cfg(test)]
mod testing;
mod theme;
mod ui;
mod voice;

use gpui::{App, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions, actions, point, prelude::*, px, size};

use state::{AppState, Store};

actions!(zuna, [Quit]);

fn main() {
    // A plugin's host process is this program too, started for one plugin and nothing else: it
    // goes straight to running it, before anything of the app starts (plugins/host).
    if std::env::args().nth(1).as_deref() == Some("--plugin-host") {
        std::process::exit(plugins::host::run());
    }
    // MangoHud, which some turn on for every Vulkan program with MANGOHUD=1 to see a game's frame
    // rate, has no place over a chat window, which draws through Vulkan on Linux. Its layer stands
    // aside for this, which has to be set before Vulkan starts.
    #[cfg(target_os = "linux")]
    // SAFETY: nothing else runs yet to read the environment as it changes.
    unsafe {
        std::env::set_var("DISABLE_MANGOHUD", "1");
    }
    // With where each line came from: GPUI logs errors it swallowed, and their message alone rarely says enough.
    let mut logger = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    logger.format(|out, record| {
        use std::io::Write;
        let place = match (record.file(), record.line()) {
            (Some(file), Some(line)) => format!("{file}:{line}"),
            _ => record.target().to_string(),
        };
        writeln!(out, "[{} {} {place}] {}", chrono::Local::now().format("%H:%M:%S%.3f"), record.level(), record.args())
    });
    // libwebrtc's logs stay off whatever RUST_LOG says, since its frame cryptor has been reported
    // to log key material (webrtc-sdk/webrtc#308), and logs end up in bug reports. ZUNA_WEBRTC_LOG
    // lets them through, which is how test/key-log-check.mjs looks for that.
    if std::env::var_os("ZUNA_WEBRTC_LOG").is_none() {
        logger.filter_module("libwebrtc", log::LevelFilter::Off);
    }
    logger.init();
    host::tls::install();
    // LiveKit's signalling goes through the app's own clients, and through the proxy where one is set.
    voice::proxy::install();
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = checks(&args) {
        std::process::exit(code);
    }
    // Without Wayland, GPUI would run with no window at all.
    #[cfg(target_os = "linux")]
    if !platform::wayland_session() {
        eprintln!("Zuna needs Wayland, but this session isn't using it.");
        std::process::exit(1);
    }
    // One Zuna for each data folder: a second start hands its zuna:// link to the first, or asks it to show itself.
    // Started with --quit, as `npm run install:windows` starts it before installing over it, it asks the
    // first to quit as Quit in the tray does, and never opens itself.
    let link = platform::link_in(&args);
    let quitting = args.get(1).is_some_and(|arg| arg == "--quit");
    #[cfg(feature = "update-check")]
    let updating = args.get(1).is_some_and(|arg| arg == "--update");
    #[cfg(not(feature = "update-check"))]
    let updating = false;
    let handed = match platform::single::claim(&host::data_dir()) {
        platform::single::Claim::First(_) if quitting || updating => return,
        platform::single::Claim::First(receiver) => receiver,
        platform::single::Claim::Running => {
            platform::single::forward(&host::data_dir(), if quitting { QUIT } else if updating { UPDATE } else { link.as_deref().unwrap_or("") });
            return;
        }
    };
    // The core starts and boots before GPUI does, as GPUI spends most of its start loading the
    // graphics driver, and the core is ready by the time the window is.
    let dir = host::data_dir();
    // What the last run decrypted or recorded, should it have stopped without quitting.
    host::clear_cache(&dir);
    let device_key = host::device_key::load(&dir);
    // Started with --no-plugins, the app runs no plugin, as it does by itself after two failed starts with them.
    let no_plugins = args.iter().any(|arg| arg == "--no-plugins");
    // Before anything connects, so that with a proxy set nothing ever goes around it.
    host::net::set(settings::Settings::load().proxy.in_use());
    let (core, events) = host::Core::start(dir);
    let booting = device_key.as_ref().ok().map(|key| core.start_boot(key.key.clone(), platform::DEVICE_NAME.into()));
    // What a second start, or this one, was given: a zuna:// link opens the invite in it, once the app is ready.
    let (links, mut incoming) = futures::channel::mpsc::unbounded::<String>();
    let application = gpui_platform::application().with_assets(assets::Assets);
    // macOS keeps one copy of a bundle running, and hands it links as they're opened, and a
    // click on the Dock's icon, rather than starting another.
    #[cfg(target_os = "macos")]
    {
        let opened = links.clone();
        application.on_open_urls(move |urls| {
            for url in urls {
                opened.unbounded_send(url).ok();
            }
        });
        application.on_reopen(|_| platform::show_main());
    }
    application.run(move |cx: &mut App| {
        // Windows knows the app by this, as the Start menu's shortcut has it, rather than a name
        // it would work out from the program's path, which Focus Assist's list never matched.
        // A copy that wasn't installed, as a build, has one of its own, so it isn't taken for the installed app.
        #[cfg(windows)]
        {
            let installed = std::env::current_exe().is_ok_and(|exe| platform::updates::installed(&exe));
            cx.set_app_identity(if installed { platform::AUMID } else { concat!("chat.zuna.desktop", ".dev") }, "Zuna");
        }
        assets::load_fonts(cx);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        platform::install(cx);
        ui::text_input::bind_keys(cx);
        ui::bind_keys(cx);
        cx.bind_keys([KeyBinding::new(if cfg!(target_os = "macos") { "cmd-q" } else { "ctrl-q" }, Quit, None)]);
        cx.on_action(|_: &Quit, cx| quit(cx));
        #[cfg(target_os = "macos")]
        platform::set_menus(cx);

        let state = cx.new(|cx| AppState::new(core, events, cx));
        cx.set_global(Store(state.clone()));
        let plugins = plugins::init(device_key.as_ref().ok().map(|key| key.key.as_slice()), no_plugins, cx);
        // Plugins start once the window is up and the core has booted, so they never slow the start.
        cx.observe(&state, move |state, cx| {
            if matches!(state.read(cx).phase, state::Phase::Ready) {
                plugins.update(cx, |plugins, cx| plugins.start_all(cx));
            }
        })
        .detach();
        voice::init(&state, cx);
        #[cfg(all(feature = "test-control", unix))]
        test_control::start(cx);
        ui::notifications::install(state.downgrade(), cx);

        if let Some(link) = link.clone() {
            links.unbounded_send(link).ok();
        }
        std::thread::spawn(move || {
            while let Ok(message) = handed.recv() {
                if links.unbounded_send(message).is_err() {
                    break;
                }
            }
        });
        let opening = state.clone();
        cx.spawn(async move |cx| {
            use futures::StreamExt;
            while let Some(message) = incoming.next().await {
                if message == QUIT {
                    cx.update(quit);
                    break;
                }
                // The update check presses Update this way, having no pointer to press it with.
                #[cfg(feature = "update-check")]
                if message == UPDATE {
                    cx.update(ui::install_update);
                    continue;
                }
                platform::show_main();
                if !message.starts_with("zuna://") {
                    continue;
                }
                // Each link waits on its own for the app to finish starting, so a quit that comes
                // behind it isn't held up, and it's dropped if starting failed.
                let opening = opening.clone();
                cx.spawn(async move |cx| {
                    while cx.update(|cx| matches!(opening.read(cx).phase, state::Phase::Booting)) {
                        cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
                    }
                    if cx.update(|cx| matches!(opening.read(cx).phase, state::Phase::Ready)) {
                        cx.update(|cx| opening.update(cx, |state, cx| state.set_overlay(Some(state::Overlay::AddServer { link: Some(message), sign_in_url: None }), cx)));
                    }
                })
                .detach();
            }
        })
        .detach();

        // The tray's icon, and what's picked from it.
        let mut tray = platform::tray::start();
        cx.spawn(async move |cx| {
            use futures::StreamExt;
            while let Some(event) = tray.next().await {
                // Outside an update, as showing the window sends it messages GPUI answers.
                match event {
                    platform::tray::TrayEvent::Open => platform::show_main(),
                    platform::tray::TrayEvent::Quit => {
                        cx.update(quit);
                        break;
                    }
                }
            }
        })
        .detach();
        match device_key {
            Ok(key) => state.update(cx, |state, cx| state.boot(booting.expect("booting with the key"), key.protected, cx)),
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
                // The update check's copy stays out of sight, as it runs on a person's desktop too.
                show: cfg!(not(feature = "update-check")),
                focus: cfg!(not(feature = "update-check")),
                app_id: Some(platform::APP_ID.into()),
                // GPUI draws a window that isn't focused 30 times a second at most, which is what a
                // share watched beside a game, or a video, would then be shown at.
                inactive_frame_interval: None,
                // Under Wayland the compositor's title bar, through xdg-decoration, where it has
                // one, and the app's own where it hasn't, as on GNOME.
                #[cfg(target_os = "linux")]
                window_decorations: Some(gpui::WindowDecorations::Server),
                ..Default::default()
            },
            |window, cx| {
                platform::set_main_window(window);
                // GPUI only names a window from its title bar's options on Windows.
                #[cfg(target_os = "linux")]
                window.set_window_title("Zuna");
                // Closing keeps it running in the tray, so messages still arrive, unless that's turned off.
                let closing = state.clone();
                window.on_window_should_close(cx, move |_, cx| {
                    // macOS keeps the app running with its window closed, as it does every app.
                    if cfg!(target_os = "macos") || closing.read(cx).settings.close_to_tray {
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
        if cfg!(not(feature = "update-check")) {
            cx.activate(true);
        }
        platform::updates::start(state.read(cx).settings.update_channel.as_deref());
    });
}

/// What a start with --quit hands the copy already running.
const QUIT: &str = "quit";
/// What a start with --update hands it, in a build made for the update check.
#[cfg_attr(not(feature = "update-check"), allow(dead_code))]
const UPDATE: &str = "update";

/// Quits for good, taking the tray's icon with it, and installs a downloaded update, unless
/// its installer was already started, as pressing Update does.
pub(crate) fn quit(cx: &mut App) {
    platform::tray::remove();
    platform::updates::install_on_quit();
    host::clear_cache(&host::data_dir());
    // A start that ends in quitting finished, so it doesn't count toward plugins' safe mode.
    plugins::started_well(&host::data_dir());
    cx.quit();
}

/// Checks of the hosted core with no window, for development:
/// `zuna --core-eval <script>...` and `zuna --core-check <method> [args as JSON...]`, on
/// macOS `zuna --write-notification-sound <path>` as the bundle is made, and on Linux
/// `zuna --check-dmabuf [render node]`.
fn checks(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str) {
        // The notification sound, which scripts/macos-app.mjs puts in the bundle.
        #[cfg(target_os = "macos")]
        Some("--write-notification-sound") => {
            let path = args.get(2)?;
            Some(if std::fs::write(path, platform::notification_wav()).is_ok() { 0 } else { 1 })
        }
        // Whether DMA-BUFs of every modifier EGL offers reach NVENC, without a compositor.
        #[cfg(target_os = "linux")]
        Some("--check-dmabuf") => match zuna_screenshare::check_dmabuf(args.get(2).map_or("/dev/dri/renderD128", String::as_str)) {
            Ok(report) => {
                print!("{report}");
                Some(0)
            }
            Err(problem) => {
                eprintln!("{problem}");
                Some(1)
            }
        },
        Some("--core-eval") => {
            let dir = host::data_dir();
            let key = host::device_key::load(&dir).expect("a device key");
            let (core, _events) = host::Core::start(dir);
            futures::executor::block_on(core.boot(key.key, platform::DEVICE_NAME.into())).expect("the core boots");
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
                core.boot(key.key, platform::DEVICE_NAME.into()).await?;
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
