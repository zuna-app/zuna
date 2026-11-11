//! The window, its web view, and the app's lines in and out.

use std::cell::{Cell, RefCell};
use std::fs::File;
use std::io::{BufRead, Write};
use std::os::fd::FromRawFd;
use std::rc::Rc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_channel::mpsc;
use gtk::prelude::*;
use serde_json::{Value, json};
use webkit2gtk::{
    AutoplayPolicy, DownloadExt, NavigationPolicyDecision, NavigationPolicyDecisionExt, PermissionRequestExt, PolicyDecisionExt, PolicyDecisionType, SettingsExt, URIRequestExt, UserContentManager,
    UserContentManagerExt, WebContext, WebContextExt, WebProcessTerminationReason, WebView, WebViewExt, WebsitePolicies,
};

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
        if let Err(error) = gtk::show_uri_on_window(Some(window), uri, gtk::current_event_time()) {
            eprintln!("zuna-watch: couldn't open a link in the browser: {error}");
        }
    }
}

/// Whether WebKit's web processes can run in bubblewrap here, as they do where WebKitGTK is
/// asked to sandbox them: bwrap and xdg-dbus-proxy installed, and user namespaces allowed.
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
    let player: Rc<RefCell<Option<Player>>> = Rc::default();
    glib::MainContext::default().spawn_local(async move {
        use futures_util::StreamExt;
        while let Some(line) = incoming.next().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
            match message.get("type").and_then(Value::as_str).unwrap_or_default() {
                "load" if player.borrow().is_none() => {
                    *player.borrow_mut() = Player::open(&text("page"), &text("origin"), &text("title"));
                    if player.borrow().is_none() {
                        say(json!({ "type": "failed", "problem": "the page couldn't be loaded" }));
                        gtk::main_quit();
                    }
                }
                "page" => {
                    if let (Some(player), Some(message)) = (player.borrow().as_ref(), message.get("message")) {
                        player.send(message);
                    }
                }
                "title" => {
                    if let Some(player) = player.borrow().as_ref() {
                        player.window.set_title(&text("title"));
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
        gtk::main_quit();
    });

    // Whether GStreamer can decode YouTube's video, asked once the window is up, off GTK's thread.
    std::thread::spawn(|| {
        if let Some((video, sound)) = crate::decoders::check() {
            say(json!({ "type": "decoders", "video": video, "sound": sound }));
        }
    });

    gtk::main();
    0
}

struct Player {
    window: gtk::Window,
    web: WebView,
}

impl Player {
    /// The window, with the page loaded in it under `origin`.
    fn open(page: &str, origin: &str, title: &str) -> Option<Player> {
        let page_host = host_of(origin)?;
        if page.is_empty() {
            return None;
        }
        // The only other host the page may frame, which it names in its content security policy.
        let player_host = page.split("frame-src ").nth(1).and_then(|rest| rest.split(['"', ';', ' ']).next()).and_then(host_of);

        // It keeps nothing: no cookie outlives a session.
        let context = WebContext::new_ephemeral();
        if sandbox_works() {
            context.set_sandbox_enabled(true);
        } else {
            eprintln!("zuna-watch: WebKit's web processes run without bubblewrap, which isn't usable here");
        }
        // Nothing is downloaded.
        context.connect_download_started(|_, download| download.cancel());
        let content = UserContentManager::new();
        content.register_script_message_handler(HANDLER);
        let settings = webkit2gtk::Settings::new();
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
        let web = WebView::builder().web_context(&context).user_content_manager(&content).settings(&settings).website_policies(&policies).build();

        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_title(if title.is_empty() { "Watching together" } else { title });
        window.set_icon_name(Some("zuna"));
        window.set_default_size(960, 540);
        window.add(&web);

        // What the page says, which the app checks as anything from outside. A frame of YouTube's
        // can post here too, as WebKitGTK says nothing of which frame posted, but it can say
        // nothing the player in it couldn't already say of itself by playing or pausing.
        content.connect_script_message_received(Some(HANDLER), |_, result| {
            let Some(value) = result.js_value() else { return };
            if !javascriptcore::ValueExt::is_string(&value) {
                return;
            }
            let text = javascriptcore::ValueExt::to_str(&value).to_string();
            if text.len() <= LONGEST {
                say(json!({ "type": "page", "message": text }));
            }
        });

        // The page itself, YouTube's frames inside it, and what a frame loads by itself. A link
        // pressed opens in the browser, as does whatever would open a window.
        let link_window = window.clone();
        let (own_host, framed_host) = (page_host.clone(), player_host.clone());
        web.connect_decide_policy(move |_, decision, kind| {
            let navigation = decision.downcast_ref::<NavigationPolicyDecision>().and_then(|decision| decision.navigation_action());
            let uri = navigation.as_ref().and_then(|action| action.request()).and_then(|request| request.uri()).map(|uri| uri.to_string()).unwrap_or_default();
            match kind {
                PolicyDecisionType::NewWindowAction => {
                    open_in_browser(&link_window, &uri);
                    decision.ignore();
                    true
                }
                PolicyDecisionType::NavigationAction => {
                    let host = host_of(&uri);
                    let ours = host.as_deref() == Some(own_host.as_str()) || (host.is_some() && host == framed_host);
                    if ours || !navigation.is_some_and(|action| action.is_user_gesture()) {
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
        window.connect_delete_event(|_, _| {
            say(json!({ "type": "closed" }));
            gtk::main_quit();
            glib::Propagation::Proceed
        });

        web.load_html(page, Some(origin));
        window.show_all();
        Some(Player { window, web })
    }

    /// Tells the page something, as JSON the app made.
    fn send(&self, message: &Value) {
        let script = format!("window.zunaWatch && window.zunaWatch.receive({message})");
        self.web.evaluate_javascript(&script, None, None, None::<&gio::Cancellable>, |_| {});
    }
}
