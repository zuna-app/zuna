//! The window, its web view, and the app's lines in and out.

use std::cell::{Cell, RefCell};
use std::fs::File;
use std::io::{BufRead, Write};
use std::os::fd::FromRawFd;
use std::rc::Rc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_channel::mpsc;
use serde_json::{Value, json};
use webkit6::prelude::*;
use webkit6::{AutoplayPolicy, NavigationPolicyDecision, NetworkSession, PolicyDecisionType, UserContentManager, WebProcessTerminationReason, WebView, WebsitePolicies, gio, glib, gtk};

/// The name the page posts its messages to (`window.webkit.messageHandlers.zuna`).
const HANDLER: &str = "zuna";
/// The longest message the page may post, which is far more than any it has.
const LONGEST: usize = 10_000;

/// Where the app reads what this says: standard output as it was, kept apart from what
/// anything else in the process, or the web processes it starts, prints there.
static OUT: OnceLock<Mutex<File>> = OnceLock::new();

/// Tells the app something, in one line.
fn say(message: Value) {
    let Some(out) = OUT.get() else { return };
    let mut out = out.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // An app that's gone takes the window with it, as its end of standard input closes too.
    let _ = writeln!(out, "{message}").and_then(|_| out.flush());
}

/// Standard output, from here on the app's alone, and fd 1 pointed at standard error.
fn keep_output() -> bool {
    // SAFETY: dup and dup2 on the process's own standard descriptors, before any thread starts.
    unsafe {
        let kept = libc::dup(1);
        if kept < 0 || libc::dup2(2, 1) < 0 {
            return false;
        }
        libc::fcntl(kept, libc::F_SETFD, libc::FD_CLOEXEC);
        OUT.set(Mutex::new(File::from_raw_fd(kept))).is_ok()
    }
}

/// The host of an address, in lower case, or nothing for an address without one.
fn host_of(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("https://").or_else(|| uri.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// What a link pressed in the player opens: the browser, for the web's own addresses alone.
fn open_in_browser(window: &gtk::Window, uri: &str) {
    if host_of(uri).is_some() {
        let context = WidgetExt::display(window).app_launch_context();
        if let Err(error) = gio::AppInfo::launch_default_for_uri(uri, Some(&context)) {
            eprintln!("zuna-watch: couldn't open a link in the browser: {error}");
        }
    }
}

/// Whether WebKit's web processes can run in bubblewrap here, as WebKitGTK 6.0 always runs them:
/// bwrap and xdg-dbus-proxy installed, and user namespaces allowed.
fn sandbox_works() -> bool {
    let found = |name: &str| std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()));
    found("bwrap")
        && found("xdg-dbus-proxy")
        && std::process::Command::new("bwrap")
            .args(["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

pub fn run() -> i32 {
    if !keep_output() {
        eprintln!("zuna-watch: couldn't keep standard output for the app");
        return 1;
    }
    // WebKitGTK 6.0 always sandboxes its web processes, and a web process that can't start
    // plays nothing, so where bubblewrap can't run here they go without it, as before 6.0 they
    // always did. Set before any thread starts, which might read the environment meanwhile.
    if !sandbox_works() {
        eprintln!("zuna-watch: WebKit's web processes run without bubblewrap, which isn't usable here");
        // SAFETY: nothing else runs yet to read the environment as it changes.
        unsafe { std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1") };
    }
    // A video's volume is the app's own slider, which YouTube's player sets on its video, and
    // WebKit on the stream it plays through. PipeWire's session manager would keep that as
    // Zuna's volume, by the name below, which the app's own streams share, and give it to the
    // next of them: everyone's voices as quiet as the last video, or silent after one that was
    // muted. So it's told to keep nothing of what WebKit's web processes play and to give them
    // nothing, through PulseAudio, which GStreamer plays through, and for PipeWire's own streams.
    // SAFETY: as above.
    unsafe {
        std::env::set_var("PULSE_PROP_state.restore-props", "false");
        std::env::set_var("PIPEWIRE_PROPS", "{ state.restore-props = false }");
    }
    // Shown as Zuna by the desktop, whose zuna.desktop names the icon: Wayland's app ID is this.
    glib::set_prgname(Some("zuna"));
    glib::set_application_name("Zuna");
    if let Err(error) = gtk::init() {
        say(json!({ "type": "failed", "problem": format!("GTK couldn't start: {error}") }));
        return 1;
    }

    // What the app says, read on a thread of its own and handled on GTK's.
    let (lines, mut incoming) = mpsc::unbounded::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if lines.unbounded_send(line).is_err() {
                return;
            }
        }
        lines.close_channel();
    });
    let main_loop = glib::MainLoop::new(None, false);
    let player: Rc<RefCell<Option<Player>>> = Rc::default();
    let quit = main_loop.clone();
    glib::MainContext::default().spawn_local(async move {
        use futures_util::StreamExt;
        while let Some(line) = incoming.next().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
            match message.get("type").and_then(Value::as_str).unwrap_or_default() {
                "load" if player.borrow().is_none() => {
                    *player.borrow_mut() = Player::open(&text("page"), &text("origin"), &text("title"), &quit);
                    if player.borrow().is_none() {
                        say(json!({ "type": "failed", "problem": "the page couldn't be loaded" }));
                        quit.quit();
                    }
                }
                "page" => {
                    if let (Some(player), Some(message)) = (player.borrow().as_ref(), message.get("message")) {
                        player.send(message);
                    }
                }
                "title" => {
                    if let Some(player) = player.borrow().as_ref() {
                        player.window.set_title(Some(&text("title")));
                    }
                }
                "raise" => {
                    if let Some(player) = player.borrow().as_ref() {
                        player.window.present();
                    }
                }
                _ => {}
            }
        }
        // The app is done with it, or gone.
        quit.quit();
    });

    // Whether GStreamer can decode YouTube's video, asked once the window is up, off GTK's thread.
    std::thread::spawn(|| {
        if let Some((video, sound)) = crate::decoders::check() {
            say(json!({ "type": "decoders", "video": video, "sound": sound }));
        }
    });

    main_loop.run();
    0
}

struct Player {
    window: gtk::Window,
    web: WebView,
}

impl Player {
    /// The window, with the page loaded in it under `origin`.
    fn open(page: &str, origin: &str, title: &str, main_loop: &glib::MainLoop) -> Option<Player> {
        let page_host = host_of(origin)?;
        if page.is_empty() {
            return None;
        }
        // The only other host the page may frame, which it names in its content security policy.
        let player_host = page.split("frame-src ").nth(1).and_then(|rest| rest.split(['"', ';', ' ']).next()).and_then(host_of);

        // It keeps nothing: no cookie outlives a session.
        let session = NetworkSession::new_ephemeral();
        // Nothing is downloaded.
        session.connect_download_started(|_, download| download.cancel());
        let content = UserContentManager::new();
        content.register_script_message_handler(HANDLER, None);
        let settings = webkit6::Settings::new();
        settings.set_enable_developer_extras(false);
        settings.set_enable_write_console_messages_to_stdout(false);
        settings.set_javascript_can_open_windows_automatically(false);
        settings.set_javascript_can_access_clipboard(false);
        settings.set_media_playback_requires_user_gesture(false);
        settings.set_enable_media_stream(false);
        settings.set_enable_webrtc(false);
        settings.set_enable_mediasource(true);
        // A window of its own can go to full screen, which YouTube's button does.
        settings.set_enable_fullscreen(true);
        settings.set_enable_back_forward_navigation_gestures(false);
        let policies = WebsitePolicies::builder().autoplay(AutoplayPolicy::Allow).build();
        let web = WebView::builder().network_session(&session).user_content_manager(&content).settings(&settings).website_policies(&policies).build();

        let window = gtk::Window::new();
        window.set_title(Some(if title.is_empty() { "Watching together" } else { title }));
        window.set_icon_name(Some("zuna"));
        window.set_default_size(960, 540);
        window.set_child(Some(&web));

        // What the page says, which the app checks as anything from outside. A frame of YouTube's
        // can post here too, as WebKitGTK says nothing of which frame posted, but it can say
        // nothing the player in it couldn't already say of itself by playing or pausing.
        content.connect_script_message_received(Some(HANDLER), |_, value| {
            if !value.is_string() {
                return;
            }
            let text = value.to_str().to_string();
            if text.len() <= LONGEST {
                say(json!({ "type": "page", "message": text }));
            }
        });

        // The page itself, YouTube's frames inside it, and what a frame loads by itself. A link
        // pressed opens in the browser, as does whatever would open a window.
        let link_window = window.clone();
        let (own_host, framed_host) = (page_host.clone(), player_host.clone());
        web.connect_decide_policy(move |_, decision, kind| {
            let mut navigation = decision.downcast_ref::<NavigationPolicyDecision>().and_then(|decision| decision.navigation_action());
            let uri = navigation.as_mut().and_then(|action| action.request()).and_then(|request| request.uri()).map(|uri| uri.to_string()).unwrap_or_default();
            match kind {
                PolicyDecisionType::NewWindowAction => {
                    open_in_browser(&link_window, &uri);
                    decision.ignore();
                    true
                }
                PolicyDecisionType::NavigationAction => {
                    let host = host_of(&uri);
                    let ours = host.as_deref() == Some(own_host.as_str()) || (host.is_some() && host == framed_host);
                    if ours || !navigation.is_some_and(|mut action| action.is_user_gesture()) {
                        return false;
                    }
                    open_in_browser(&link_window, &uri);
                    decision.ignore();
                    true
                }
                _ => false,
            }
        });
        // Should the window's own page ever be left, it's opened again.
        let (reload_page, reload_origin, page_host_again) = (page.to_string(), origin.to_string(), page_host.clone());
        web.connect_uri_notify(move |web| {
            let Some(uri) = web.uri().map(|uri| uri.to_string()) else { return };
            if uri.is_empty() || host_of(&uri).as_deref() == Some(page_host_again.as_str()) {
                return;
            }
            eprintln!("zuna-watch: the window's page was left, so it's loaded again");
            web.stop_loading();
            web.load_html(&reload_page, Some(&reload_origin));
        });
        // No camera, microphone, location, notifications or keys for protected media.
        web.connect_permission_request(|_, request| {
            request.deny();
            true
        });
        // A web process that crashed is started again, a few times.
        let (crash_page, crash_origin, crashes) = (page.to_string(), origin.to_string(), Rc::new(Cell::new((0u32, Instant::now()))));
        web.connect_web_process_terminated(move |web, reason| {
            eprintln!("zuna-watch: WebKit's web process ended: {reason:?}");
            if reason == WebProcessTerminationReason::TerminatedByApi {
                return;
            }
            let (count, since) = crashes.get();
            let count = if since.elapsed() > Duration::from_secs(60) { 1 } else { count + 1 };
            crashes.set((count, if count == 1 { Instant::now() } else { since }));
            if count <= 3 {
                web.load_html(&crash_page, Some(&crash_origin));
            } else {
                say(json!({ "type": "failed", "problem": "WebKit's web process keeps crashing" }));
            }
        });
        let quit = main_loop.clone();
        window.connect_close_request(move |_| {
            say(json!({ "type": "closed" }));
            quit.quit();
            glib::Propagation::Proceed
        });

        web.load_html(page, Some(origin));
        window.present();
        Some(Player { window, web })
    }

    /// Tells the page something, as JSON the app made.
    fn send(&self, message: &Value) {
        let script = format!("window.zunaWatch && window.zunaWatch.receive({message})");
        self.web.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
    }
}
