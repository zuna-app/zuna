//! The client core, hosted natively. `Core` is the UI's handle on it: calls go in as
//! the RPC messages of `packages/core/src/rpc.ts`, and replies and `CoreEvent`s come
//! back the same way, as they do between the web's page and its Worker.

mod crypto;
mod db;
pub mod device_key;
mod js;
mod runtime;
mod tls;
pub mod web;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, OnceLock};

use futures::channel::{mpsc, oneshot};
use parking_lot::Mutex;
use serde_json::{Value, json};

pub use runtime::shrink_image;
use runtime::Task;

const CORE_BUNDLE: &str = include_str!("../../assets/core/zuna-core.js");
const PASSWORD_BUNDLE: &str = include_str!("../../assets/core/zuna-password.js");
/// The UI's channel. Channel 0 broadcasts, which is how events arrive.
const UI_CHANNEL: u32 = 1;

/// A failed call, as the core described it.
#[derive(Clone, Debug)]
pub struct CoreError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CoreError {}

type Reply = oneshot::Sender<Result<Value, CoreError>>;

struct Inner {
    tasks: Sender<Task>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
}

#[derive(Clone)]
pub struct Core {
    inner: Arc<Inner>,
}

static TOKIO: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// The network's and the timers' threads.
pub fn tokio() -> &'static tokio::runtime::Runtime {
    TOKIO.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("zuna-net")
            .enable_all()
            .build()
            .expect("a tokio runtime")
    })
}

/// Where files are decrypted to while the app runs, beside the voice and video messages it
/// records, the sounds it makes and the pictures pasted into it. Nothing there is sealed, so
/// it's emptied as the app starts and as it quits, as iOS empties its own as the core starts.
pub fn cache_dir() -> PathBuf {
    cache_in(&data_dir())
}

fn cache_in(dir: &Path) -> PathBuf {
    dir.join("cache")
}

/// Empties the cache in a data folder, as far as it can: a file still open stays until next time.
pub fn clear_cache(dir: &Path) {
    std::fs::remove_dir_all(cache_in(dir)).ok();
}

/// Writes a file whole or not at all: beside it first, then moved over it, so that a write cut
/// short, as by a crash or a full disk, leaves the old one rather than half of the new.
pub fn write_whole(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = path.with_extension("partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, path)
}

/// Where this app keeps its data: `ZUNA_DATA_DIR` where it's set, and otherwise in the system's
/// folder for app data. On Windows and macOS only the installed copy keeps it in `Zuna Native`:
/// a copy started from anywhere else, as a build is, keeps its own in `Zuna Native Dev`, so
/// that it never opens the installed app's messages and keys.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ZUNA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    #[cfg(any(windows, target_os = "macos"))]
    if !std::env::current_exe().is_ok_and(|exe| crate::platform::updates::installed(&exe)) {
        return base.join(format!("{} Dev", crate::platform::DATA_FOLDER));
    }
    base.join(crate::platform::DATA_FOLDER)
}

impl Core {
    /// Starts the core's thread. Events arrive on the receiver as `CoreEvent` JSON.
    pub fn start(dir: PathBuf) -> (Core, mpsc::UnboundedReceiver<Value>) {
        let (tasks, inbox) = std::sync::mpsc::channel::<Task>();
        let (events_tx, events) = mpsc::unbounded::<Value>();
        let inner = Arc::new(Inner { tasks: tasks.clone(), pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });

        let weak = Arc::downgrade(&inner);
        let post = Arc::new(move |channel: u32, json: String| {
            let Ok(message) = serde_json::from_str::<Value>(&json) else { return };
            match message.get("kind").and_then(Value::as_str) {
                Some("event") => {
                    if let Some(event) = message.get("event") {
                        events_tx.unbounded_send(event.clone()).ok();
                    }
                }
                Some("reply") if channel == UI_CHANNEL => {
                    let Some(inner) = weak.upgrade() else { return };
                    let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
                    let Some(reply) = inner.pending.lock().remove(&id) else { return };
                    let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                        Ok(message.get("value").cloned().unwrap_or(Value::Null))
                    } else {
                        let error = message.get("error");
                        Err(CoreError {
                            message: error
                                .and_then(|error| error.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("Something went wrong.")
                                .to_string(),
                            code: error.and_then(|error| error.get("code")).and_then(Value::as_str).map(str::to_string),
                            status: error.and_then(|error| error.get("status")).and_then(Value::as_u64).map(|status| status as u16),
                        })
                    };
                    reply.send(result).ok();
                }
                _ => {}
            }
        });

        let options = runtime::Options {
            bundle: CORE_BUNDLE.to_string(),
            data_dir: dir,
            tokio: tokio().handle().clone(),
            post,
            test_hooks: std::env::var_os("ZUNA_TEST_HOOKS").is_some(),
            password_bundle: PASSWORD_BUNDLE,
        };
        std::thread::Builder::new()
            .name("zuna-core".into())
            .stack_size(32 * 1024 * 1024)
            .spawn(move || runtime::run(tasks, inbox, options))
            .expect("the core's thread starts");
        (Core { inner }, events)
    }

    /// Opens the client with this device's key.
    pub async fn boot(&self, key: Vec<u8>, name: String) -> Result<(), String> {
        self.start_boot(key, name).await
    }

    /// Boots it now and gives what to wait on, so it boots while the window is still being made.
    pub fn start_boot(&self, key: Vec<u8>, name: String) -> impl Future<Output = Result<(), String>> + use<> {
        let (done, wait) = oneshot::channel();
        let sent = self.inner.tasks.send(Task::Boot { key, name, done });
        async move {
            if sent.is_err() {
                return Err("The core stopped.".to_string());
            }
            wait.await.unwrap_or_else(|_| Err("The core stopped.".into()))
        }
    }

    /// Runs script in the core's context and returns its result as JSON, for checks.
    #[allow(dead_code)]
    pub async fn eval(&self, source: String) -> String {
        let (done, wait) = oneshot::channel();
        if self.inner.tasks.send(Task::Eval { source, done }).is_err() {
            return "The core stopped.".into();
        }
        wait.await.unwrap_or_default()
    }

    /// How hard a password is to guess: a score from 0 to 4, and what to call it.
    pub fn password_strength(&self, password: String, related: Vec<String>) -> impl Future<Output = (u8, String)> + use<> {
        let (done, wait) = oneshot::channel();
        let sent = self.inner.tasks.send(Task::Password { password, related, done });
        async move {
            if sent.is_err() {
                return (0, String::new());
            }
            let json = wait.await.unwrap_or_default();
            let value: Value = serde_json::from_str(&json).unwrap_or(Value::Null);
            (value.get("score").and_then(Value::as_u64).unwrap_or(0) as u8, value.get("label").and_then(Value::as_str).unwrap_or("").to_string())
        }
    }

    /// Calls a method of the client, or of a server's session.
    pub fn call(&self, server: Option<&str>, method: &str, args: Vec<Value>) -> impl Future<Output = Result<Value, CoreError>> + use<> {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let (reply, wait) = oneshot::channel();
        self.inner.pending.lock().insert(id, reply);
        let message = json!({ "kind": "call", "id": id, "serverId": server, "method": method, "args": args });
        let sent = self.inner.tasks.send(Task::Receive { channel: UI_CHANNEL, json: message.to_string() });
        async move {
            if sent.is_err() {
                return Err(CoreError { message: "The core stopped.".into(), code: None, status: None });
            }
            wait.await.unwrap_or_else(|_| Err(CoreError { message: "The core stopped.".into(), code: None, status: None }))
        }
    }
}

/// The certificate rules everything else here reaches the internet with.
pub fn tls_config() -> rustls::ClientConfig {
    tls::client_config(&[b"h2", b"http/1.1"])
}

/// Fetches something a server serves openly, such as its icon or an emote, with the
/// same certificate rules as the core. It never carries anything of the account.
pub fn fetch(url: String) -> impl Future<Output = Result<Vec<u8>, String>> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .use_preconfigured_tls(tls::client_config(&[b"h2", b"http/1.1"]))
                .connect_timeout(std::time::Duration::from_secs(15))
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("an HTTP client")
        })
        .clone();
    let task = tokio().spawn(async move {
        let response = client.get(&url).send().await.map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("{} answered {}", url, response.status()));
        }
        // An icon or an emote is small, and a server mustn't be able to fill the app's memory.
        const MOST: usize = 8 << 20;
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if body.len() + chunk.len() > MOST {
                return Err(format!("{url} sent more than 8 MB"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    });
    async move { task.await.map_err(|error| error.to_string())? }
}

/// An argument left out in the middle of a call, which JSON's null can't say (wire.ts).
pub fn undefined() -> Value {
    json!({ "$undefined": true })
}

/// Bytes as the wire carries them.
pub fn bytes(data: &[u8]) -> Value {
    use base64::Engine;
    json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(data) })
}

/// A file on disk, which the core reads a chunk at a time (files.ts).
pub fn file(path: &str, mime: &str) -> Value {
    json!({ "$file": { "path": path, "type": mime } })
}

/// The bytes of a `$bytes`, `$blob` or `$file` value from the wire, reading a file from disk.
pub fn value_bytes(value: &Value) -> Option<Vec<u8>> {
    if let Some(path) = value.get("$file").and_then(|file| file.get("path")).and_then(Value::as_str) {
        return std::fs::read(path).ok();
    }
    read_bytes(value)
}

/// Writes a `$bytes`, `$blob` or `$file` value from the wire to `target`, moving a file there
/// when `moving` and copying it otherwise. A value with nothing in it is an error, never a
/// file left unwritten and said to be saved.
pub fn save_value(value: &Value, target: &std::path::Path, moving: bool) -> Result<(), String> {
    if let Some(source) = value.get("$file").and_then(|file| file.get("path")).and_then(Value::as_str) {
        if moving && std::fs::rename(source, target).is_ok() {
            return Ok(());
        }
        return std::fs::copy(source, target).map(|_| ()).map_err(|error| error.to_string());
    }
    let bytes = read_bytes(value).ok_or_else(|| "nothing came to save".to_string())?;
    std::fs::write(target, bytes).map_err(|error| error.to_string())
}

/// The bytes of a `$bytes` or `$blob` value from the wire.
pub fn read_bytes(value: &Value) -> Option<Vec<u8>> {
    use base64::Engine;
    let encoded = value.get("$bytes").or_else(|| value.get("$blob").and_then(|blob| blob.get("bytes")))?.as_str()?;
    base64::engine::general_purpose::STANDARD.decode(encoded).ok()
}

#[cfg(all(test, windows))]
mod tests {
    /// The tests run from where they were built, as a development build does.
    #[test]
    fn a_copy_that_was_not_installed_keeps_its_data_apart() {
        if std::env::var_os("ZUNA_DATA_DIR").is_some() {
            return;
        }
        assert!(super::data_dir().ends_with("Zuna Native Dev"));
    }
}
