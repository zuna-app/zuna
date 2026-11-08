//! Push to talk's key under Wayland, where only the compositor sees a key held in another
//! window: the global shortcuts portal binds it, asking the person through the compositor
//! where it wants to, and says when it goes down and up, as the Electron
//! app's push to talk did. KDE, GNOME and Hyprland have it; a compositor that
//! doesn't has no portal for it at all. Keys are named as the browser's `KeyboardEvent.code`
//! names them, so a setting reads the same in either app, and given to the portal by XKB's
//! names. One is chosen by pressing it in this window, as the web's `KeyBinder` hears it.
//! A mouse button can't be, as the portal's shortcuts are keys alone.
//!
//! Each talk with the portal is on a D-Bus connection of its own, which first names the app to
//! it as `zuna` through the host registry, as ashpd can't (it takes only dotted IDs).
//! The portal only gives shortcuts to an app it can name, and otherwise knows one only by how
//! it was started: from its .desktop file, not from a terminal or a development build.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use futures::StreamExt;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::platform::{KeyWatchSupport, NoKeyWatch};

const DESKTOP: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS: &str = "org.freedesktop.portal.GlobalShortcuts";
const ID: &str = "push-to-talk";

/// The watch going on, which stops as this is dropped or sent to.
static WATCHING: Mutex<Option<futures::channel::oneshot::Sender<()>>> = Mutex::new(None);
type Chosen = Box<dyn FnOnce(String) + Send>;
static CHOOSING: Mutex<Option<Chosen>> = Mutex::new(None);
static SUPPORT: Mutex<Option<KeyWatchSupport>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Binds the key, by its browser name, through the portal, then tells `listener` as it goes
/// down and up, and `bound` what the portal bound, which the person may have changed. None
/// stops watching.
pub fn watch(code: Option<String>, listener: impl Fn(bool) + Send + 'static, bound: impl FnOnce(String) + Send + 'static) {
    // Dropping the last watch's sender ends it, and its connection, which closes its session.
    let (stop, stopped) = futures::channel::oneshot::channel::<()>();
    *lock(&WATCHING) = None;
    let Some(code) = code.filter(|code| !code.starts_with("Mouse")) else { return };
    *lock(&WATCHING) = Some(stop);
    // A modifier alone isn't a shortcut, so the compositor's dialog asks for a key instead.
    let trigger = trigger_of(&code).unwrap_or_default();
    std::thread::Builder::new()
        .name("zuna-push-to-talk".into())
        .spawn(move || {
            let watching = Box::pin(listen(&trigger, &listener, bound));
            if let futures::future::Either::Left((Err(error), _)) = futures::executor::block_on(futures::future::select(watching, stopped)) {
                log::warn!("push to talk can't hear the key: {error}");
            }
            // A key nothing listens for any more can't be held.
            listener(false);
        })
        .ok();
}

async fn listen(trigger: &str, listener: &(impl Fn(bool) + Send), bound: impl FnOnce(String)) -> Result<(), String> {
    let bus = connect().await.map_err(text)?;
    let session = create_session(&bus).await?;
    let token = token();
    let shortcut: HashMap<&str, Value> = [("description", Value::from("Push to talk")), ("preferred_trigger", Value::from(trigger))].into();
    let options: HashMap<&str, Value> = [("handle_token", Value::from(token.as_str()))].into();
    let mut results = request(&bus, "BindShortcuts", &token, &(&session, vec![(ID, shortcut)], "", options)).await?;
    let given: Vec<(String, HashMap<String, OwnedValue>)> = results.remove("shortcuts").and_then(|value| value.try_into().ok()).unwrap_or_default();
    let description = given.into_iter().find(|(id, _)| id == ID).and_then(|(_, about)| about.get("trigger_description").and_then(|value| String::try_from(value.try_clone().ok()?).ok()));
    log::info!("push to talk is bound to {}", description.as_deref().unwrap_or("a key the portal didn't name"));
    bound(description.unwrap_or_default());

    let signal = |member: &'static str| {
        zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal).interface(SHORTCUTS).and_then(|rule| rule.member(member)).map(|rule| rule.build())
    };
    let down = zbus::MessageStream::for_match_rule(signal("Activated").map_err(text)?, &bus, None).await.map_err(text)?;
    let up = zbus::MessageStream::for_match_rule(signal("Deactivated").map_err(text)?, &bus, None).await.map_err(text)?;
    let mut events = futures::stream::select(down.map(|message| (true, message)), up.map(|message| (false, message)));
    while let Some((held, message)) = events.next().await {
        let Ok(message) = message else { continue };
        let Ok((from, id, _, _)) = message.body().deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>() else { continue };
        // KDE says each of these twice, which changes nothing.
        if from == session && id == ID {
            listener(held);
        }
    }
    Ok(())
}

/// Whether push to talk can hear a key in another window, once it's been asked.
pub fn support() -> Option<KeyWatchSupport> {
    *lock(&SUPPORT)
}

/// Asks the portal what it allows, then tells `then`. A portal that wasn't up yet, or turned
/// this app down, is asked again next time.
pub fn check_support(then: impl FnOnce() + Send + 'static) {
    if support().is_some_and(|found| found.anywhere) {
        return then();
    }
    std::thread::Builder::new()
        .name("zuna-push-to-talk-check".into())
        .spawn(move || {
            let (answer, answered) = std::sync::mpsc::channel();
            std::thread::spawn(move || answer.send(futures::executor::block_on(ask_support())).ok());
            let none = KeyWatchSupport { anywhere: false, mouse: false, why: Some(NoKeyWatch::Compositor) };
            let found = answered.recv_timeout(Duration::from_secs(5)).unwrap_or(none);
            log::info!("push to talk in other windows: {found:?}");
            *lock(&SUPPORT) = Some(found);
            then();
        })
        .ok();
}

async fn ask_support() -> KeyWatchSupport {
    let none = |why| KeyWatchSupport { anywhere: false, mouse: false, why: Some(why) };
    let Ok(bus) = connect().await else { return none(NoKeyWatch::Compositor) };
    let version = bus
        .call_method(Some(DESKTOP), PATH, Some("org.freedesktop.DBus.Properties"), "Get", &(SHORTCUTS, "version"))
        .await
        .ok()
        .and_then(|reply| reply.body().deserialize::<OwnedValue>().ok())
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    if version == 0 {
        return none(NoKeyWatch::Compositor);
    }
    // A session shows the person nothing, and is refused to an app the portal can't name.
    match create_session(&bus).await {
        Ok(_) => KeyWatchSupport { anywhere: true, mouse: false, why: None },
        Err(_) => none(NoKeyWatch::Uninstalled),
    }
}

/// Hears the next key pressed in this window, for choosing one.
pub fn choose(then: impl FnOnce(String) + Send + 'static) {
    *lock(&CHOOSING) = Some(Box::new(then));
}

/// Stops waiting for a key to be chosen.
pub fn stop_choosing() {
    lock(&CHOOSING).take();
}

/// Takes a key pressed in the window while one is being chosen, and says whether it did, so
/// that nothing else hears it. Keys without a browser name are let through.
pub fn hear(keystroke: &gpui::Keystroke) -> bool {
    let Some(code) = code_of(&keystroke.key) else { return false };
    let Some(then) = lock(&CHOOSING).take() else { return false };
    then(code);
    true
}

/// A connection to the portals that has named the app to them where it's installed.
async fn connect() -> zbus::Result<zbus::Connection> {
    let bus = zbus::Connection::session().await?;
    // Only allowed before anything else is asked on the connection, and refused where no
    // .desktop file by that name is installed.
    let named = bus.call_method(Some(DESKTOP), PATH, Some("org.freedesktop.host.portal.Registry"), "Register", &(crate::platform::APP_ID, HashMap::<&str, Value>::new())).await;
    if let Err(error) = named {
        log::debug!("the portals don't know Zuna by its name: {error}");
    }
    Ok(bus)
}

async fn create_session(bus: &zbus::Connection) -> Result<OwnedObjectPath, String> {
    let (token, session_token) = (token(), token());
    let options: HashMap<&str, Value> = [("handle_token", Value::from(token.as_str())), ("session_handle_token", Value::from(session_token.as_str()))].into();
    let results = request(bus, "CreateSession", &token, &(options,)).await?;
    // A string, as the specification has it, or a path, as some portals send it.
    let handle = results.get("session_handle").and_then(|value| value.try_clone().ok()).ok_or("no session")?;
    String::try_from(handle.try_clone().map_err(text)?)
        .ok()
        .and_then(|path| OwnedObjectPath::try_from(path).ok())
        .or_else(|| OwnedObjectPath::try_from(handle).ok())
        .ok_or_else(|| "no session".into())
}

/// Asks the portal something it answers through a request, and waits for the answer.
async fn request<B: serde::Serialize + zbus::zvariant::DynamicType>(bus: &zbus::Connection, method: &str, token: &str, body: &B) -> Result<HashMap<String, OwnedValue>, String> {
    let sender = bus.unique_name().ok_or("no name on the bus")?.trim_start_matches(':').replace('.', "_");
    let path = format!("{PATH}/request/{sender}/{token}");
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.portal.Request")
        .and_then(|rule| rule.member("Response"))
        .and_then(|rule| rule.path(path.as_str()))
        .map_err(text)?
        .build();
    // Listened for before asking, so that a quick answer isn't missed.
    let mut responses = zbus::MessageStream::for_match_rule(rule, bus, Some(1)).await.map_err(text)?;
    bus.call_method(Some(DESKTOP), PATH, Some(SHORTCUTS), method, body).await.map_err(text)?;
    let message = responses.next().await.ok_or("no answer")?.map_err(text)?;
    let (code, results) = message.body().deserialize::<(u32, HashMap<String, OwnedValue>)>().map_err(text)?;
    match code {
        0 => Ok(results),
        1 => Err(format!("{method} was turned down")),
        _ => Err(format!("{method} failed")),
    }
}

fn token() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    format!("zuna{}_{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// A key as GPUI names it on Linux, by its browser name.
fn code_of(key: &str) -> Option<String> {
    let mut chars = key.chars();
    if let (Some(only), None) = (chars.next(), chars.next()) {
        if only.is_ascii_lowercase() {
            return Some(format!("Key{}", only.to_ascii_uppercase()));
        }
        if only.is_ascii_digit() {
            return Some(format!("Digit{only}"));
        }
    }
    if let Some(number) = key.strip_prefix('f').filter(|number| number.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))) {
        return Some(format!("F{number}"));
    }
    let code = match key {
        "escape" => "Escape",
        "space" => "Space",
        "tab" => "Tab",
        "caps_lock" => "CapsLock",
        "`" => "Backquote",
        "-" => "Minus",
        "=" => "Equal",
        "[" => "BracketLeft",
        "]" => "BracketRight",
        "\\" => "Backslash",
        ";" => "Semicolon",
        "'" => "Quote",
        "," => "Comma",
        "." => "Period",
        "/" => "Slash",
        "insert" => "Insert",
        "delete" => "Delete",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "pause" => "Pause",
        "scroll_lock" => "ScrollLock",
        _ => return None,
    };
    Some(code.into())
}

/// A browser name as the XDG shortcuts specification names the key, which is XKB's name for it
/// (as the Electron app's `triggerOf` did).
fn trigger_of(code: &str) -> Option<String> {
    if let Some(letter) = code.strip_prefix("Key").filter(|rest| rest.len() == 1) {
        return Some(letter.to_lowercase());
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return Some(digit.into());
    }
    if let Some(digit) = code.strip_prefix("Numpad").filter(|rest| rest.len() == 1) {
        return Some(format!("KP_{digit}"));
    }
    if code.starts_with('F') && code[1..].parse::<u8>().is_ok() {
        return Some(code.into());
    }
    let name = match code {
        "Space" => "space",
        "Tab" => "Tab",
        "CapsLock" => "Caps_Lock",
        "Backquote" => "grave",
        "Minus" => "minus",
        "Equal" => "equal",
        "BracketLeft" => "bracketleft",
        "BracketRight" => "bracketright",
        "Backslash" => "backslash",
        "Semicolon" => "semicolon",
        "Quote" => "apostrophe",
        "Comma" => "comma",
        "Period" => "period",
        "Slash" => "slash",
        "Insert" => "Insert",
        "Delete" => "Delete",
        "Home" => "Home",
        "End" => "End",
        "PageUp" => "Prior",
        "PageDown" => "Next",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "Pause" => "Pause",
        "ScrollLock" => "Scroll_Lock",
        _ => return None,
    };
    Some(name.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keys_as_the_browser_and_xkb_do() {
        for (gpui, code, trigger) in [("a", "KeyA", Some("a")), ("7", "Digit7", Some("7")), ("f8", "F8", Some("F8")), ("space", "Space", Some("space")), ("pagedown", "PageDown", Some("Next")), ("`", "Backquote", Some("grave"))] {
            assert_eq!(code_of(gpui).as_deref(), Some(code));
            assert_eq!(trigger_of(code).as_deref(), trigger);
        }
        assert_eq!(code_of("shift_l"), None);
        assert_eq!(trigger_of("ShiftLeft"), None);
        assert_eq!(trigger_of("Numpad4").as_deref(), Some("KP_4"));
    }
}
