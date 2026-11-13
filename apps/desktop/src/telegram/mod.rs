//! The broker: the app's end of zuna-telegram, the process a linked Telegram account's TDLib
//! runs in (docs/TELEGRAM_PLAN.md). It starts and stops the process, keeps the door
//! (`door.rs`), holds the key to the engine's database, and stands between the core and the
//! engine: only the functions on the list go to it (`functions.rs`), no faster than a limit, and
//! what comes back is handed to the core as it came, for the adapter there to check.
//!
//! Nothing here reaches a Zuna server, and nothing of Telegram's goes anywhere but the core's
//! adapter, which keeps none of it.

mod door;
#[path = "../../telegram/src/frame.rs"]
mod frame;
mod functions;

use std::io::{BufRead, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use crate::platform::sandbox::Process as Child;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use parking_lot::Mutex;
use serde_json::{Value, json};

use door::Door;
use frame::{Frame, read_frame, write_data, write_json};

/// The server ID the linked account goes by in the core and the interface (`TELEGRAM_ID` in types.ts).
pub const SERVER_ID: &str = "telegram";

/// What goes to the engine.
pub enum Outgoing {
    Json(String),
    Data(u32, Vec<u8>),
}

/// The engine's folder in the app's data folder: TDLib's database and the files it downloads.
pub fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join("telegram")
}

/// Where the key to the engine's database is kept, sealed with the device key: beside the app's
/// other sealed secrets, outside the folder the engine may read.
fn key_file(data_dir: &Path) -> PathBuf {
    data_dir.join("telegram-key.sealed")
}

const KEY_AAD: &[u8] = b"zuna/telegram/key/v1";

/// The app's own `api_id` and `api_hash`, which a release build is given from the release
/// environment's secrets and never the repository's (docs/TELEGRAM_PLAN.md, The api_id). A
/// build without them has no Telegram. A development build also takes them from the
/// environment as it runs, and uses Telegram's test servers unless `ZUNA_TELEGRAM_TEST_DC=0`.
#[derive(Clone)]
pub struct Credentials {
    pub api_id: i64,
    pub api_hash: String,
    pub test_dc: bool,
}

pub fn credentials() -> Option<Credentials> {
    let built = option_env!("TELEGRAM_API_ID").zip(option_env!("TELEGRAM_API_HASH")).map(|(id, hash)| (id.to_string(), hash.to_string()));
    let (id, hash) = if cfg!(debug_assertions) {
        std::env::var("TELEGRAM_API_ID").ok().zip(std::env::var("TELEGRAM_API_HASH").ok()).or(built)?
    } else {
        built?
    };
    let api_id = id.trim().parse::<i64>().ok().filter(|id| *id > 0)?;
    let api_hash = hash.trim().to_string();
    if api_hash.len() != 32 || !api_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let test_dc = cfg!(debug_assertions) && std::env::var("ZUNA_TELEGRAM_TEST_DC").map_or(true, |value| value != "0");
    Some(Credentials { api_id, api_hash, test_dc })
}

/// Whether this build can link a Telegram account at all.
/// Only where the engine has its box (platform/sandbox.rs), which is Windows so far: elsewhere it
/// would run unconfined, so there's no Telegram there yet.
pub fn available() -> bool {
    cfg!(windows) && credentials().is_some() && engine_path().is_some_and(|path| path.is_file())
}

fn engine_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(if cfg!(windows) { "zuna-telegram.exe" } else { "zuna-telegram" }))
}

/// The key to the engine's database, made the first time and sealed with the device key. One
/// that won't open, as after the device key changed, means the database can't be read either:
/// None, and the caller starts over.
fn database_key(data_dir: &Path, device_key: &[u8]) -> Result<Vec<u8>, String> {
    let sealing = zuna_crypto::primitives::hkdf_sha256(device_key, &[], KEY_AAD, 32).map_err(|error| error.to_string())?;
    let path = key_file(data_dir);
    if let Ok(sealed) = std::fs::read(&path) {
        return zuna_crypto::primitives::aead_open(&sealing, &sealed, KEY_AAD).map_err(|_| "the key to Telegram's database couldn't be opened".to_string());
    }
    let key = zuna_crypto::primitives::random_bytes(32).map_err(|error| error.to_string())?;
    let sealed = zuna_crypto::primitives::aead_seal(&sealing, &key, KEY_AAD).map_err(|error| error.to_string())?;
    crate::host::write_whole(&path, &sealed).map_err(|error| error.to_string())?;
    Ok(key)
}

/// Erases everything of the account's on this device: the engine's folder and its key.
pub fn erase(data_dir: &Path) {
    std::fs::remove_dir_all(folder(data_dir)).ok();
    std::fs::remove_file(key_file(data_dir)).ok();
    crate::platform::sandbox::forget(&folder(data_dir));
}

/// How many requests the core may make, as a bucket that fills at `RATE` a second up to `BURST`:
/// a fault in the adapter can't become a flood, which is what Telegram bans for.
const RATE: f64 = 100.0;
const BURST: f64 = 500.0;
/// How often the engine is asked whether it's still there, and how long it has to answer.
const WATCHDOG_EVERY: Duration = Duration::from_secs(30);
const WATCHDOG_WAIT: Duration = Duration::from_secs(20);
/// How many times the engine is started again after failing, in a row, before it stays off.
const MOST_RESTARTS: u32 = 3;
/// How long it must run before a failure counts as a new one rather than one more in a row.
const RAN_WELL: Duration = Duration::from_secs(120);

/// What the core is handed: TDLib's updates and answers, as JSON, and the broker's own, whose
/// `@type` begins with `zuna`.
pub type Deliver = Arc<dyn Fn(String) + Send + Sync>;

struct Running {
    child: Child,
    out: Sender<Outgoing>,
    door: Door,
    /// When it was started, for telling a run that went well from one that failed at once.
    started: Instant,
}

struct State {
    running: Option<Running>,
    /// Which run is the current one: what an older one's threads report is ignored.
    generation: u64,
    /// The core asked for it to run, and hasn't asked for it to stop.
    wanted: bool,
    failures: u32,
    tokens: f64,
    filled: Instant,
    /// When the watchdog last asked, while it waits for the answer.
    asked: Option<Instant>,
}

/// One linked account's engine. The core's host makes one, and starts and stops it as the core asks.
#[derive(Clone)]
pub struct Engine {
    data_dir: PathBuf,
    device_key: Arc<Vec<u8>>,
    deliver: Deliver,
    state: Arc<Mutex<State>>,
}

impl Engine {
    pub fn new(data_dir: PathBuf, device_key: Vec<u8>, deliver: Deliver) -> Engine {
        let state = State { running: None, generation: 0, wanted: false, failures: 0, tokens: BURST, filled: Instant::now(), asked: None };
        Engine { data_dir, device_key: Arc::new(device_key), deliver, state: Arc::new(Mutex::new(state)) }
    }

    /// Starts the engine, if it isn't running.
    pub fn start(&self) -> Result<(), String> {
        let mut state = self.state.lock();
        state.wanted = true;
        state.failures = 0;
        if state.running.is_some() {
            return Ok(());
        }
        self.launch(&mut state)
    }

    fn launch(&self, state: &mut State) -> Result<(), String> {
        let credentials = credentials().ok_or("This build of Zuna can't use Telegram.")?;
        let path = engine_path().filter(|path| path.is_file()).ok_or("Telegram's engine isn't beside the app.")?;
        let key = match database_key(&self.data_dir, &self.device_key) {
            Ok(key) => key,
            Err(why) => {
                // A database nobody can open is no account: it's erased, and Telegram's own
                // apps still list the session until it's ended there.
                log::warn!(target: "telegram", "{why}, so what was linked is erased");
                erase(&self.data_dir);
                database_key(&self.data_dir, &self.device_key)?
            }
        };
        let directory = folder(&self.data_dir);
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

        // In its box (platform/sandbox.rs): its folder, its pipes and nothing else of the person's.
        let spawned = crate::platform::sandbox::spawn(&path, &[], &directory).map_err(|error| format!("Telegram's engine couldn't start: {error}"))?;
        let crate::platform::sandbox::Spawned { stdin, stdout, stderr, process: child } = spawned;

        state.generation += 1;
        let generation = state.generation;
        let (out, outgoing) = channel::<Outgoing>();
        let door = Door::new(out.clone());
        let start = json!({
            "zuna": "start",
            "directory": directory.to_string_lossy(),
            "key": STANDARD.encode(&key),
            "apiId": credentials.api_id,
            "apiHash": credentials.api_hash,
            "testDc": credentials.test_dc,
            "version": crate::platform::VERSION,
            "system": if cfg!(windows) { "Windows" } else if cfg!(target_os = "macos") { "macOS" } else { "Linux" },
            "verbosity": verbosity(),
        });
        out.send(Outgoing::Json(start.to_string())).ok();

        std::thread::Builder::new().name("telegram-out".into()).spawn(move || write_out(stdin, outgoing)).map_err(|error| error.to_string())?;
        let engine = self.clone();
        let reader_door = door.clone();
        std::thread::Builder::new()
            .name("telegram-in".into())
            .spawn(move || engine.read_in(generation, stdout, reader_door))
            .map_err(|error| error.to_string())?;
        std::thread::Builder::new()
            .name("telegram-log".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    log::debug!(target: "telegram-engine", "{line}");
                }
            })
            .map_err(|error| error.to_string())?;
        let watching = self.clone();
        std::thread::Builder::new().name("telegram-watchdog".into()).spawn(move || watching.watch(generation)).map_err(|error| error.to_string())?;

        state.running = Some(Running { child, out, door, started: Instant::now() });
        state.asked = None;
        Ok(())
    }

    /// The proxy changed: every connection through the door ends, and TDLib makes them again,
    /// through the new one or none.
    pub fn network_changed(&self) {
        if let Some(running) = &self.state.lock().running {
            running.door.close_all(true);
        }
    }

    /// Hands the engine one of the core's requests, if it's on the list and within the limit,
    /// and otherwise answers it with an error, as TDLib answers what it won't do.
    pub fn send(&self, json: &str) {
        let Ok(request) = serde_json::from_str::<Value>(json) else { return };
        let extra = request.get("@extra").cloned().unwrap_or(Value::Null);
        let refuse = |code: u16, message: String| {
            (self.deliver)(json!({ "@type": "error", "code": code, "message": message, "@extra": extra }).to_string());
        };
        if let Some(why) = functions::refusal(&request) {
            log::warn!(target: "telegram", "refused: {why}");
            return refuse(403, why);
        }
        // What the core asks for carries its own `@extra`, never the broker's.
        if extra.as_str().is_some_and(|extra| extra.starts_with("zuna:")) {
            return refuse(400, "That request's label is the app's own.".into());
        }
        let mut state = self.state.lock();
        let now = Instant::now();
        state.tokens = (state.tokens + now.duration_since(state.filled).as_secs_f64() * RATE).min(BURST);
        state.filled = now;
        if state.tokens < 1.0 {
            drop(state);
            log::warn!(target: "telegram", "too many requests, one refused");
            return refuse(429, "Too many requests at once.".into());
        }
        state.tokens -= 1.0;
        match &state.running {
            Some(running) => {
                running.out.send(Outgoing::Json(json.to_string())).ok();
            }
            None => {
                drop(state);
                refuse(503, "Telegram isn't running.".into());
            }
        }
    }

    /// Stops the engine. With `sign_out`, the session is ended at Telegram first, if it can be
    /// in a few seconds, and then everything of the account's on this device is erased all the
    /// same. The core is told how it went (`zunaStopped`).
    pub fn stop(&self, sign_out: bool) {
        let running = {
            let mut state = self.state.lock();
            state.wanted = false;
            state.generation += 1;
            state.running.take()
        };
        let engine = self.clone();
        std::thread::Builder::new()
            .name("telegram-stop".into())
            .spawn(move || {
                let signed_out = match running {
                    Some(running) => engine.finish(running, sign_out),
                    None => false,
                };
                if sign_out {
                    erase(&engine.data_dir);
                }
                (engine.deliver)(json!({ "@type": "zunaStopped", "erased": sign_out, "signedOut": signed_out }).to_string());
            })
            .ok();
    }

    /// Ends a run: signs out first if asked, then closes TDLib by closing its pipe, which saves
    /// what it has, and ends the process if it hasn't gone in a while. Says whether it signed out.
    fn finish(&self, mut running: Running, sign_out: bool) -> bool {
        let mut signed_out = false;
        if sign_out {
            // The engine's answers go to nobody now, so its end of signing out is seen as the
            // process going: TDLib closes once it's done.
            running.out.send(Outgoing::Json(json!({ "@type": "logOut", "@extra": "zuna:logout" }).to_string())).ok();
            signed_out = wait_for_exit(&mut running.child, Duration::from_secs(15));
        }
        drop(running.out);
        running.door.close_all(false);
        if !wait_for_exit(&mut running.child, Duration::from_secs(10)) {
            running.child.kill();
            running.child.wait();
        }
        signed_out
    }

    /// Reads what the engine sends, until it goes.
    fn read_in(&self, generation: u64, stdout: std::fs::File, door: Door) {
        let mut input = BufReader::new(stdout);
        let why = loop {
            match read_frame(&mut input) {
                Ok(Some(Frame::Json(json))) => {
                    if !self.current(generation) {
                        // A run being stopped: its door still works, so it can sign out.
                        if let Ok(value) = serde_json::from_str::<Value>(&json) {
                            self.door_message(&door, &value);
                        }
                        continue;
                    }
                    self.heard(&door, json);
                }
                Ok(Some(Frame::Data(id, bytes))) => door.data(id, bytes),
                Ok(None) => break "it stopped".to_string(),
                Err(error) => break error.to_string(),
            }
        };
        door.close_all(false);
        self.ended(generation, &why);
    }

    fn current(&self, generation: u64) -> bool {
        self.state.lock().generation == generation
    }

    /// Answers the door's messages, and says whether it was one.
    fn door_message(&self, door: &Door, value: &Value) -> bool {
        let Some(kind) = value.get("zuna").and_then(Value::as_str) else { return false };
        let id = value.get("id").and_then(Value::as_u64).and_then(|id| u32::try_from(id).ok());
        match (kind, id) {
            ("open", Some(id)) => {
                let host = value.get("host").and_then(Value::as_str).unwrap_or("");
                let port = value.get("port").and_then(Value::as_u64).and_then(|port| u16::try_from(port).ok()).unwrap_or(0);
                door.open(id, host, port);
            }
            ("closed", Some(id)) => door.closed(id),
            _ => {}
        }
        true
    }

    fn heard(&self, door: &Door, json: String) {
        let Ok(value) = serde_json::from_str::<Value>(&json) else { return };
        if self.door_message(door, &value) {
            return;
        }
        match value.get("@extra").and_then(Value::as_str) {
            Some("zuna:watchdog") => {
                self.state.lock().asked = None;
                return;
            }
            // The broker's own requests, whose answers are nobody else's.
            Some(extra) if extra.starts_with("zuna:") => {
                if value.get("@type").and_then(Value::as_str) == Some("error") {
                    log::warn!(target: "telegram", "the engine refused {extra}: {}", value.get("message").and_then(Value::as_str).unwrap_or(""));
                }
                return;
            }
            _ => {}
        }
        (self.deliver)(json);
    }

    /// The engine went. If nobody stopped it, it's started again, up to a few times in a row.
    fn ended(&self, generation: u64, why: &str) {
        let mut state = self.state.lock();
        if state.generation != generation {
            return;
        }
        let Some(mut running) = state.running.take() else { return };
        running.child.kill();
        running.child.wait();
        if !state.wanted {
            return;
        }
        if running.started.elapsed() > RAN_WELL {
            state.failures = 0;
        }
        state.failures += 1;
        log::warn!(target: "telegram", "the engine stopped ({why}), failure {} in a row", state.failures);
        if state.failures > MOST_RESTARTS {
            state.wanted = false;
            drop(state);
            (self.deliver)(json!({ "@type": "zunaFailed", "reason": why }).to_string());
            return;
        }
        let restarted = self.launch(&mut state);
        drop(state);
        match restarted {
            Ok(()) => (self.deliver)(json!({ "@type": "zunaRestarted" }).to_string()),
            Err(why) => (self.deliver)(json!({ "@type": "zunaFailed", "reason": why }).to_string()),
        }
    }

    /// Asks the engine now and then whether it's still there, and ends one that doesn't answer.
    fn watch(&self, generation: u64) {
        loop {
            std::thread::sleep(WATCHDOG_EVERY);
            let mut state = self.state.lock();
            if state.generation != generation || state.running.is_none() {
                return;
            }
            if let Some(asked) = state.asked {
                if asked.elapsed() > WATCHDOG_WAIT {
                    log::warn!(target: "telegram", "the engine stopped answering, so it's ended");
                    if let Some(running) = state.running.as_mut() {
                        // Its pipe closes as it goes, and `read_in` starts it again.
                        running.child.kill();
                    }
                    return;
                }
                continue;
            }
            state.asked = Some(Instant::now());
            if let Some(running) = &state.running {
                running.out.send(Outgoing::Json(json!({ "@type": "getOption", "name": "version", "@extra": "zuna:watchdog" }).to_string())).ok();
            }
        }
    }
}

fn verbosity() -> u8 {
    if cfg!(debug_assertions) {
        std::env::var("ZUNA_TDLIB_VERBOSITY").ok().and_then(|value| value.parse().ok()).unwrap_or(1)
    } else {
        1
    }
}

fn wait_for_exit(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn write_out(stdin: std::fs::File, outgoing: Receiver<Outgoing>) {
    let mut pipe = BufWriter::new(stdin);
    while let Ok(message) = outgoing.recv() {
        let written = match message {
            Outgoing::Json(json) => write_json(&mut pipe, &json),
            Outgoing::Data(id, bytes) => write_data(&mut pipe, id, &bytes),
        };
        if written.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_database_key_is_sealed_and_comes_back() {
        let dir = std::env::temp_dir().join(format!("zuna-telegram-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let device_key = vec![7u8; 32];
        let first = database_key(&dir, &device_key).unwrap();
        assert_eq!(first.len(), 32);
        assert_eq!(database_key(&dir, &device_key).unwrap(), first);
        let sealed = std::fs::read(key_file(&dir)).unwrap();
        assert!(!sealed.windows(32).any(|window| window == first.as_slice()), "the key is kept sealed");
        // Another device key opens nothing.
        assert!(database_key(&dir, &[8u8; 32]).is_err());
        erase(&dir);
        assert!(!key_file(&dir).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_request_off_the_list_is_answered_by_the_broker() {
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let keep = heard.clone();
        let engine = Engine::new(std::env::temp_dir(), vec![0; 32], Arc::new(move |json| keep.lock().push(json)));
        engine.send(r#"{"@type":"deleteAccount","reason":"","@extra":"7"}"#);
        engine.send(r#"{"@type":"getChats","limit":10,"@extra":"zuna:watchdog"}"#);
        engine.send(r#"{"@type":"getChats","limit":10,"@extra":"8"}"#);
        let heard = heard.lock();
        let answers: Vec<Value> = heard.iter().map(|json| serde_json::from_str(json).unwrap()).collect();
        assert_eq!(answers[0]["code"], 403);
        assert_eq!(answers[0]["@extra"], "7");
        assert_eq!(answers[1]["code"], 400);
        // Nothing running to take it.
        assert_eq!(answers[2]["code"], 503);
        assert_eq!(answers[2]["@extra"], "8");
    }
}
