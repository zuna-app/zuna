//! Drives the native app in a KWin of its own, for apps/desktop/test/linux-check.mjs: moves
//! the pointer, clicks, scrolls and types through KWin's `org_kde_kwin_fake_input`, and says
//! what windows there are through `org_kde_plasma_window_management`. KWin only gives either
//! to a program whose `.desktop` file names them, which the check writes for this one.
//!
//! It reads one command a line, as JSON, on its standard input, and answers each with a line
//! of JSON: `{"do":"click","x":640,"y":500}`, `{"do":"type","text":"hello"}`,
//! `{"do":"press","keys":["ctrl","k"]}`, `{"do":"windows"}` and the rest below.

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::wl_registry;
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols_plasma::fake_input::client::org_kde_kwin_fake_input::OrgKdeKwinFakeInput;
use wayland_protocols_plasma::plasma_window_management::client::org_kde_plasma_window::{self, OrgKdePlasmaWindow};
use wayland_protocols_plasma::plasma_window_management::client::org_kde_plasma_window_management::{self, OrgKdePlasmaWindowManagement};

const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;
const BTN_MIDDLE: u32 = 0x112;

struct Window {
    proxy: OrgKdePlasmaWindow,
    uuid: String,
    title: String,
    app_id: String,
    flags: u32,
    geometry: (i32, i32, u32, u32),
    unmapped: bool,
}

#[derive(Default)]
struct State {
    windows: Vec<Window>,
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<OrgKdeKwinFakeInput, ()> for State {
    fn event(_: &mut Self, _: &OrgKdeKwinFakeInput, _: <OrgKdeKwinFakeInput as wayland_client::Proxy>::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<OrgKdePlasmaWindowManagement, ()> for State {
    fn event(state: &mut Self, manager: &OrgKdePlasmaWindowManagement, event: org_kde_plasma_window_management::Event, _: &(), _: &Connection, queue: &QueueHandle<Self>) {
        if let org_kde_plasma_window_management::Event::WindowWithUuid { uuid, .. } = event {
            let proxy = manager.get_window_by_uuid(uuid.clone(), queue, uuid.clone());
            state.windows.push(Window { proxy, uuid, title: String::new(), app_id: String::new(), flags: 0, geometry: (0, 0, 0, 0), unmapped: false });
        }
    }
}

impl Dispatch<OrgKdePlasmaWindow, String> for State {
    fn event(state: &mut Self, _: &OrgKdePlasmaWindow, event: org_kde_plasma_window::Event, uuid: &String, _: &Connection, _: &QueueHandle<Self>) {
        let Some(window) = state.windows.iter_mut().find(|window| &window.uuid == uuid) else { return };
        match event {
            org_kde_plasma_window::Event::TitleChanged { title } => window.title = title,
            org_kde_plasma_window::Event::AppIdChanged { app_id } => window.app_id = app_id,
            org_kde_plasma_window::Event::StateChanged { flags } => window.flags = flags,
            org_kde_plasma_window::Event::Geometry { x, y, width, height } => window.geometry = (x, y, width, height),
            org_kde_plasma_window::Event::Unmapped => window.unmapped = true,
            _ => {}
        }
    }
}

/// The evdev code of a key, by a short name.
fn key_code(name: &str) -> Option<u32> {
    let name = name.to_ascii_lowercase();
    let letters = "qwertyuiop";
    let middle = "asdfghjkl";
    let bottom = "zxcvbnm";
    if name.len() == 1 {
        let c = name.chars().next()?;
        if let Some(i) = letters.find(c) {
            return Some(16 + i as u32);
        }
        if let Some(i) = middle.find(c) {
            return Some(30 + i as u32);
        }
        if let Some(i) = bottom.find(c) {
            return Some(44 + i as u32);
        }
        if c == '0' {
            return Some(11);
        }
        if let Some(digit) = c.to_digit(10) {
            return Some(1 + digit);
        }
    }
    if let Some(number) = name.strip_prefix('f').and_then(|rest| rest.parse::<u32>().ok()) {
        return match number {
            1..=10 => Some(58 + number),
            11 => Some(87),
            12 => Some(88),
            _ => None,
        };
    }
    Some(match name.as_str() {
        "escape" | "esc" => 1,
        "minus" => 12,
        "equal" => 13,
        "backspace" => 14,
        "tab" => 15,
        "bracketleft" => 26,
        "bracketright" => 27,
        "enter" | "return" => 28,
        "ctrl" | "control" => 29,
        "semicolon" => 39,
        "quote" => 40,
        "backquote" => 41,
        "shift" => 42,
        "backslash" => 43,
        "comma" => 51,
        "period" => 52,
        "slash" => 53,
        "alt" => 56,
        "space" => 57,
        "home" => 102,
        "up" => 103,
        "pageup" => 104,
        "left" => 105,
        "right" => 106,
        "end" => 107,
        "down" => 108,
        "pagedown" => 109,
        "insert" => 110,
        "delete" => 111,
        "meta" | "super" => 125,
        _ => return None,
    })
}

/// The key that types a character on a US layout, and whether it needs Shift.
fn key_for(c: char) -> Option<(u32, bool)> {
    if c.is_ascii_uppercase() {
        return Some((key_code(&c.to_ascii_lowercase().to_string())?, true));
    }
    if c.is_ascii_lowercase() || c.is_ascii_digit() {
        return Some((key_code(&c.to_string())?, false));
    }
    let (name, shift) = match c {
        ' ' => ("space", false),
        '\n' => ("enter", false),
        '.' => ("period", false),
        ',' => ("comma", false),
        '-' => ("minus", false),
        '_' => ("minus", true),
        '=' => ("equal", false),
        '+' => ("equal", true),
        '/' => ("slash", false),
        '?' => ("slash", true),
        ';' => ("semicolon", false),
        ':' => ("semicolon", true),
        '\'' => ("quote", false),
        '"' => ("quote", true),
        '[' => ("bracketleft", false),
        ']' => ("bracketright", false),
        '{' => ("bracketleft", true),
        '}' => ("bracketright", true),
        '\\' => ("backslash", false),
        '|' => ("backslash", true),
        '`' => ("backquote", false),
        '~' => ("backquote", true),
        '!' => ("1", true),
        '@' => ("2", true),
        '#' => ("3", true),
        '$' => ("4", true),
        '%' => ("5", true),
        '^' => ("6", true),
        '&' => ("7", true),
        '*' => ("8", true),
        '(' => ("9", true),
        ')' => ("0", true),
        _ => return None,
    };
    Some((key_code(name)?, shift))
}

struct Driver {
    connection: Connection,
    queue: wayland_client::EventQueue<State>,
    state: State,
    input: OrgKdeKwinFakeInput,
}

impl Driver {
    fn sync(&mut self) -> Result<(), String> {
        self.queue.roundtrip(&mut self.state).map(|_| ()).map_err(|error| error.to_string())
    }

    fn key(&mut self, code: u32, down: bool) {
        self.input.keyboard_key(code, down as u32);
    }

    fn button(&mut self, button: u32, down: bool) {
        self.input.button(button, down as u32);
    }

    fn pause(&mut self, ms: u64) -> Result<(), String> {
        self.connection.flush().map_err(|error| error.to_string())?;
        std::thread::sleep(Duration::from_millis(ms));
        Ok(())
    }

    fn run(&mut self, command: &Value) -> Result<Value, String> {
        let number = |name: &str| command.get(name).and_then(Value::as_f64);
        let button = match command.get("button").and_then(Value::as_str).unwrap_or("left") {
            "right" => BTN_RIGHT,
            "middle" => BTN_MIDDLE,
            _ => BTN_LEFT,
        };
        let to = |driver: &mut Driver| {
            if let (Some(x), Some(y)) = (number("x"), number("y")) {
                driver.input.pointer_motion_absolute(x, y);
            }
        };
        match command.get("do").and_then(Value::as_str).unwrap_or_default() {
            "move" => to(self),
            "down" => {
                to(self);
                self.button(button, true);
            }
            "up" => {
                to(self);
                self.button(button, false);
            }
            "click" => {
                to(self);
                let count = command.get("count").and_then(Value::as_u64).unwrap_or(1);
                for i in 0..count {
                    if i > 0 {
                        self.pause(40)?;
                    }
                    self.button(button, true);
                    self.pause(20)?;
                    self.button(button, false);
                }
            }
            "drag" => {
                let from = command.get("from").and_then(Value::as_array).ok_or("drag needs from")?;
                let end = command.get("to").and_then(Value::as_array).ok_or("drag needs to")?;
                let point = |list: &Vec<Value>, i: usize| list.get(i).and_then(Value::as_f64).unwrap_or(0.);
                let (x0, y0, x1, y1) = (point(from, 0), point(from, 1), point(end, 0), point(end, 1));
                let steps = command.get("steps").and_then(Value::as_u64).unwrap_or(10).max(1);
                self.input.pointer_motion_absolute(x0, y0);
                self.pause(20)?;
                self.button(button, true);
                for step in 1..=steps {
                    self.pause(16)?;
                    let t = step as f64 / steps as f64;
                    self.input.pointer_motion_absolute(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
                }
                self.pause(20)?;
                self.button(button, false);
            }
            "scroll" => {
                to(self);
                // In degrees, as a wheel's notch is 15.
                self.input.axis(0, number("dy").unwrap_or(1.) * 15.);
            }
            "key" => {
                let name = command.get("key").and_then(Value::as_str).ok_or("key needs key")?;
                let code = key_code(name).ok_or_else(|| format!("no key {name}"))?;
                match command.get("state").and_then(Value::as_str) {
                    Some("down") => self.key(code, true),
                    Some("up") => self.key(code, false),
                    _ => {
                        self.key(code, true);
                        self.pause(20)?;
                        self.key(code, false);
                    }
                }
            }
            "press" => {
                let keys: Vec<u32> = command
                    .get("keys")
                    .and_then(Value::as_array)
                    .ok_or("press needs keys")?
                    .iter()
                    .map(|key| key.as_str().and_then(key_code).ok_or_else(|| format!("no key {key}")))
                    .collect::<Result<_, _>>()?;
                for &code in &keys {
                    self.key(code, true);
                    self.pause(15)?;
                }
                for &code in keys.iter().rev() {
                    self.key(code, false);
                    self.pause(15)?;
                }
            }
            "type" => {
                let text = command.get("text").and_then(Value::as_str).ok_or("type needs text")?;
                let shift = key_code("shift").unwrap_or(42);
                for c in text.chars() {
                    let (code, shifted) = key_for(c).ok_or_else(|| format!("can't type {c:?}"))?;
                    if shifted {
                        self.key(shift, true);
                    }
                    self.key(code, true);
                    self.pause(8)?;
                    self.key(code, false);
                    if shifted {
                        self.key(shift, false);
                    }
                    self.pause(8)?;
                }
            }
            "sleep" => self.pause(number("ms").unwrap_or(100.) as u64)?,
            // What the taskbar does with a window: bring it back from minimized, and to the front.
            "restore" | "activate" => {
                self.sync()?;
                let app_id = command.get("appId").and_then(Value::as_str).unwrap_or_default();
                let window = self.state.windows.iter().find(|window| !window.unmapped && (app_id.is_empty() || window.app_id == app_id)).ok_or("no such window")?;
                window.proxy.set_state(0x1 | 0x2, 0x1);
            }
            "windows" => {
                self.sync()?;
                let windows: Vec<Value> = self
                    .state
                    .windows
                    .iter()
                    .filter(|window| !window.unmapped)
                    .map(|window| {
                        json!({
                            "title": window.title,
                            "appId": window.app_id,
                            "active": window.flags & 0x1 != 0,
                            "minimized": window.flags & 0x2 != 0,
                            "maximized": window.flags & 0x4 != 0,
                            "demandsAttention": window.flags & 0x80 != 0,
                            "x": window.geometry.0,
                            "y": window.geometry.1,
                            "width": window.geometry.2,
                            "height": window.geometry.3,
                        })
                    })
                    .collect();
                return Ok(json!({ "ok": true, "windows": windows }));
            }
            other => return Err(format!("no command {other:?}")),
        }
        self.sync()?;
        Ok(json!({ "ok": true }))
    }
}

fn main() {
    let connection = Connection::connect_to_env().expect("a Wayland display");
    let (globals, queue) = registry_queue_init::<State>(&connection).expect("the registry");
    let handle = queue.handle();
    let input: OrgKdeKwinFakeInput = globals.bind(&handle, 4..=5, ()).expect("KWin's fake input, which its .desktop file has to name");
    let _manager: OrgKdePlasmaWindowManagement = globals.bind(&handle, 16..=18, ()).expect("KWin's window management, which its .desktop file has to name");
    input.authenticate("Zuna's checks".into(), "Drives the app in its tests".into());
    let mut driver = Driver { connection, queue, state: State::default(), input };
    driver.sync().expect("the first roundtrip");
    let stdout = std::io::stdout();
    println!("{}", json!({ "ready": true }));
    stdout.lock().flush().ok();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(command) => driver.run(&command).unwrap_or_else(|error| json!({ "ok": false, "error": error })),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        };
        let mut out = stdout.lock();
        writeln!(out, "{answer}").ok();
        out.flush().ok();
    }
}
