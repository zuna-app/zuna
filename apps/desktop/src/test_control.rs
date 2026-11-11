//! For the checks in apps/desktop/test alone, compiled only with the `test-control` feature,
//! which no build anyone uses has: with `ZUNA_TEST_CONTROL` naming a socket, the app takes
//! input and gives screenshots of its window over it, one line of JSON each way, so that a
//! check can drive it with nothing asked of the system. Input goes through GPUI as the
//! system's would, so it lands on whatever's under the pointer or has focus; screenshots are
//! GPUI's own drawing of the window, without the system's frame around it. The window is drawn
//! for each request, so this works while the system draws nothing, as with the display asleep.
//!
//! `{"click": [x, y], "button": "left" | "right", "count": 1}` in the window's points,
//! `{"move": [x, y]}`, `{"key": "cmd-v"}`, `{"type": "text"}`, `{"shot": "/path.png"}`,
//! `{"core": "method", "args": [...], "server": "id"}` for the core, `{"state": true}` for
//! what the platform says about the window and the badge, `{"delivered": true}` for the
//! notifications macOS shows, and `{"quit": true}`.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;

use futures::StreamExt;
use futures::channel::{mpsc, oneshot};
use gpui::{App, AsyncApp, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput, point, px};
use serde_json::{Value, json};

type Request = (Value, oneshot::Sender<Value>);

/// Listens on `ZUNA_TEST_CONTROL`, if it's set.
pub fn start(cx: &mut App) {
    let Some(path) = std::env::var_os("ZUNA_TEST_CONTROL") else { return };
    std::fs::remove_file(&path).ok();
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) => return log::warn!("the test control can't listen: {error}"),
    };
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok();
    }
    log::info!("the test control listens on {}", std::path::Path::new(&path).display());
    let (requests, mut asked) = mpsc::unbounded::<Request>();
    std::thread::Builder::new()
        .name("zuna-test-control".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let requests = requests.clone();
                std::thread::spawn(move || {
                    let Ok(mut writer) = stream.try_clone() else { return };
                    for line in BufReader::new(stream).lines().map_while(Result::ok) {
                        let reply = match serde_json::from_str::<Value>(&line) {
                            Ok(request) => {
                                let (answer, answered) = oneshot::channel();
                                if requests.unbounded_send((request, answer)).is_err() {
                                    return;
                                }
                                futures::executor::block_on(answered).unwrap_or_else(|_| json!({ "error": "no answer" }))
                            }
                            Err(error) => json!({ "error": error.to_string() }),
                        };
                        if writeln!(writer, "{reply}").is_err() {
                            return;
                        }
                    }
                });
            }
        })
        .ok();
    cx.spawn(async move |cx| {
        while let Some((request, answer)) = asked.next().await {
            let reply = handle(request, cx).await;
            answer.send(reply).ok();
        }
    })
    .detach();
}

fn error(text: impl std::fmt::Display) -> Value {
    json!({ "error": text.to_string() })
}

async fn handle(request: Value, cx: &mut AsyncApp) -> Value {
    if let Some(method) = request.get("core").and_then(Value::as_str) {
        let Some(core) = cx.update(|cx| cx.try_global::<crate::state::Store>().map(|store| store.0.read(cx).core.clone())) else { return error("no core yet") };
        let args = request.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
        let server = request.get("server").and_then(Value::as_str).map(str::to_string);
        return match core.call(server.as_deref(), method, args).await {
            Ok(value) => json!({ "ok": value }),
            Err(failed) => error(failed.message),
        };
    }
    #[cfg(target_os = "macos")]
    if request.get("delivered").is_some() {
        let Some(asked) = cx.update(|cx| crate::ui::notifications::center(cx).map(|center| center.read(cx).delivered())) else { return error("no notifications") };
        let found = asked.await.unwrap_or_default();
        return json!({ "ok": found.into_iter().map(|(title, body)| json!({ "title": title, "body": body })).collect::<Vec<_>>() });
    }
    // Pressing Watch on what the room has on, as someone who agreed to YouTube would.
    if request.get("watchHere").is_some() {
        cx.update(|cx| {
            if let Some(store) = cx.try_global::<crate::state::Store>() {
                store.0.clone().update(cx, |state, cx| state.update_settings(|settings| settings.play_youtube = true, cx));
            }
            if let Some(voice) = crate::voice::get(cx) {
                voice.update(cx, |voice, cx| voice.set_watching(true, cx));
            }
        });
        return json!({ "ok": true });
    }
    if request.get("quit").is_some() {
        cx.update(|cx| cx.dispatch_action(&crate::Quit));
        return json!({ "ok": true });
    }
    let Some(window) = cx.update(|cx| cx.windows().first().copied()) else { return error("no window") };
    let result = window.update(cx, |_, window, cx| -> Value {
        // Drawn here first, so that where things are and what a screenshot shows are current
        // even while macOS draws nothing, as with the display asleep or the window covered.
        window.draw(cx).clear(cx);
        let position = |key: &str| {
            let pair = request.get(key)?.as_array()?;
            Some(point(px(pair.first()?.as_f64()? as f32), px(pair.get(1)?.as_f64()? as f32)))
        };
        let modifiers = Modifiers::default();
        if let Some(at) = position("move") {
            window.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent { position: at, pressed_button: None, modifiers }), cx);
            return json!({ "ok": true });
        }
        if let Some(at) = position("click") {
            let button = match request.get("button").and_then(Value::as_str) {
                Some("right") => MouseButton::Right,
                _ => MouseButton::Left,
            };
            let count = request.get("count").and_then(Value::as_u64).unwrap_or(1) as usize;
            window.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent { position: at, pressed_button: None, modifiers }), cx);
            for click_count in 1..=count {
                window.dispatch_event(PlatformInput::MouseDown(MouseDownEvent { button, position: at, modifiers, click_count, first_mouse: false }), cx);
                window.dispatch_event(PlatformInput::MouseUp(MouseUpEvent { button, position: at, modifiers, click_count }), cx);
            }
            return json!({ "ok": true });
        }
        if let Some(key) = request.get("key").and_then(Value::as_str) {
            return match Keystroke::parse_with_os(key, gpui::OperatingSystem::Mac) {
                Ok(keystroke) => json!({ "ok": window.dispatch_keystroke(keystroke, cx) }),
                Err(failed) => error(failed),
            };
        }
        if let Some(text) = request.get("type").and_then(Value::as_str) {
            for character in text.chars() {
                let key = match character {
                    ' ' => "space".to_string(),
                    '\n' => "enter".to_string(),
                    other => other.to_lowercase().to_string(),
                };
                let modifiers = Modifiers { shift: character.is_uppercase(), ..Default::default() };
                let keystroke = Keystroke { modifiers, key, key_char: (character != '\n').then(|| character.to_string()) };
                window.dispatch_keystroke(keystroke, cx);
            }
            return json!({ "ok": true });
        }
        if let Some(path) = request.get("shot").and_then(Value::as_str) {
            return match window.render_to_image() {
                Ok(image) => match image.save(path) {
                    Ok(()) => json!({ "ok": { "width": image.width(), "height": image.height() } }),
                    Err(failed) => error(failed),
                },
                Err(failed) => error(failed),
            };
        }
        if request.get("state").is_some() {
            let size = window.viewport_size();
            return json!({ "ok": {
                "active": window.is_window_active(),
                "visible": crate::platform::main_visible(),
                "fullscreen": window.is_fullscreen(),
                "width": f32::from(size.width),
                "height": f32::from(size.height),
                "scale": window.scale_factor(),
                "badge": badge(),
            } });
        }
        error("nothing asked")
    });
    result.unwrap_or_else(error)
}

#[cfg(target_os = "macos")]
fn badge() -> Option<String> {
    crate::platform::icons::badge()
}

#[cfg(not(target_os = "macos"))]
fn badge() -> Option<String> {
    None
}
