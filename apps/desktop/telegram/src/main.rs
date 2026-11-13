//! zuna-telegram: TDLib in a process of its own, for a Telegram account linked to Zuna on this
//! device (docs/TELEGRAM_PLAN.md). The app starts it and is the only thing it talks to: TDLib's
//! requests come in on standard input and its answers and updates go out on standard output, in
//! the frames of `frame.rs`, and every connection TDLib makes goes through the door (`door.rs`).
//!
//! It holds no key of Zuna's, and keeps nothing but TDLib's own folder, which the app names and
//! whose database key it sends each time this starts. The app's broker decides what may be asked
//! of TDLib. This process only refuses what would let TDLib past the door.

mod door;
mod frame;
#[cfg(target_os = "linux")]
mod lockdown;
#[cfg(feature = "probe")]
mod probe;
mod td;

use std::io::{BufReader, BufWriter};
use std::sync::mpsc::{Receiver, channel};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use door::{Door, Outgoing};
use frame::{Frame, read_frame, write_data, write_json};

/// What the app sends first.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    /// TDLib's folder: its database in `db`, the files it downloads in `files`.
    directory: String,
    /// The database's key, 32 random bytes in base64, which the app keeps sealed.
    key: String,
    api_id: i64,
    api_hash: String,
    /// Telegram's test servers, for development and the checks.
    #[serde(default)]
    test_dc: bool,
    /// What Telegram is told this is: the app's version and the system's name, and nothing more.
    version: String,
    system: String,
    /// How much TDLib writes to standard error, from 0 (nothing) to 5. 1 is its errors.
    #[serde(default = "errors_only")]
    verbosity: u8,
}

fn errors_only() -> u8 {
    1
}

/// Requests the app may never pass on, whatever its broker allows: those that would change the
/// way out TDLib was given, or its parameters.
const REFUSED: &[&str] = &["addProxy", "editProxy", "enableProxy", "disableProxy", "removeProxy", "setTdlibParameters", "setLogStream", "testProxy", "testNetwork", "pingProxy"];

fn main() {
    // The door's port first, then the box closed behind it, on the one thread there is, before
    // anything is read or TDLib does a thing (`lockdown.rs`).
    let listener = Door::bind().unwrap_or_else(|error| fail(&format!("the door couldn't open: {error}")));
    let port = listener.local_addr().map(|address| address.port()).unwrap_or_else(|error| fail(&format!("the door has no port: {error}")));
    #[cfg(target_os = "linux")]
    if let Err(error) = lockdown::lock(port) {
        fail(&format!("the box couldn't be closed: {error}"));
    }
    #[cfg(feature = "probe")]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some("--probe") {
            return probe::run(&args[1..], listener);
        }
    }
    let (out, outgoing) = channel::<Outgoing>();
    let writer = std::thread::Builder::new().name("pipe-out".into()).spawn(move || write_out(outgoing)).expect("a thread");

    let mut input = BufReader::new(std::io::stdin().lock());
    let start: Start = match read_frame(&mut input) {
        Ok(Some(Frame::Json(json))) => match serde_json::from_str::<Value>(&json) {
            Ok(value) if value.get("zuna").and_then(Value::as_str) == Some("start") => match serde_json::from_value(value) {
                Ok(start) => start,
                Err(error) => fail(&format!("a start that can't be read: {error}")),
            },
            _ => fail("no start"),
        },
        _ => fail("no start"),
    };

    // TDLib writes its log to standard error, which the app reads, at errors alone unless asked.
    td::execute(&json!({ "@type": "setLogVerbosityLevel", "new_verbosity_level": start.verbosity.min(5) }).to_string());

    let door = Door::open(listener, out.clone()).unwrap_or_else(|error| fail(&format!("the door couldn't open: {error}")));
    debug_assert_eq!(door.port, port);
    let client = td::Client::new();
    // The way out first: a proxy added before the parameters takes effect as TDLib starts, before
    // it first connects (Td::init_options_and_network). TDLib keeps it, and a second start adds
    // it again with this run's port and secret.
    client.send(
        &json!({
            "@type": "addProxy",
            "proxy": {
                "@type": "proxy",
                "server": "127.0.0.1",
                "port": door.port,
                "type": { "@type": "proxyTypeSocks5", "username": door.username, "password": door.password },
            },
            "enable": true,
            "comment": "Zuna",
            "@extra": "zuna:door",
        })
        .to_string(),
    );
    let directory = std::path::Path::new(&start.directory);
    client.send(
        &json!({
            "@type": "setTdlibParameters",
            "use_test_dc": start.test_dc,
            "database_directory": directory.join("db").to_string_lossy(),
            "files_directory": directory.join("files").to_string_lossy(),
            "database_encryption_key": start.key,
            "use_file_database": true,
            "use_chat_info_database": true,
            "use_message_database": true,
            "use_secret_chats": false,
            "api_id": start.api_id,
            "api_hash": start.api_hash,
            "system_language_code": "en",
            // Not the computer's model, nor the system's version, which TDLib would find out
            // for itself if these were empty.
            "device_model": "Desktop",
            "system_version": start.system,
            "application_version": start.version,
            "@extra": "zuna:parameters",
        })
        .to_string(),
    );
    drop(start);

    let closed = Arc::new(AtomicBool::new(false));
    let receiving = {
        let out = out.clone();
        let closed = closed.clone();
        std::thread::Builder::new()
            .name("td-receive".into())
            .spawn(move || {
                while !closed.load(Ordering::Relaxed) {
                    let Some(json) = td::receive(1.0) else { continue };
                    let ended = is_closed(&json);
                    if out.send(Outgoing::Json(json)).is_err() {
                        break;
                    }
                    if ended {
                        // TDLib closed, as after its session was ended from another device:
                        // the process ends once that's written, whatever the app is doing.
                        closed.store(true, Ordering::Relaxed);
                        out.send(Outgoing::End).ok();
                        break;
                    }
                }
            })
            .expect("a thread")
    };

    // What the app sends, until it stops.
    loop {
        match read_frame(&mut input) {
            Ok(Some(Frame::Json(json))) => {
                let Ok(value) = serde_json::from_str::<Value>(&json) else { continue };
                if let Some(kind) = value.get("@type").and_then(Value::as_str) {
                    if REFUSED.contains(&kind) {
                        let refusal = json!({ "@type": "error", "code": 403, "message": "Not here", "@extra": value.get("@extra") });
                        out.send(Outgoing::Json(refusal.to_string())).ok();
                    } else {
                        client.send(&json);
                    }
                    continue;
                }
                let id = value.get("id").and_then(Value::as_u64).and_then(|id| u32::try_from(id).ok());
                match (value.get("zuna").and_then(Value::as_str), id) {
                    (Some("opened"), Some(id)) => door.answered(id, true),
                    (Some("refused"), Some(id)) => door.answered(id, false),
                    (Some("closed"), Some(id)) => door.closed(id),
                    _ => {}
                }
            }
            Ok(Some(Frame::Data(stream, bytes))) => door.data(stream, bytes),
            // The app went, or its pipe broke: TDLib is closed, which saves what it has.
            Ok(None) | Err(_) => break,
        }
        if closed.load(Ordering::Relaxed) {
            break;
        }
    }

    if !closed.load(Ordering::Relaxed) {
        client.send(&json!({ "@type": "close", "@extra": "zuna:close" }).to_string());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !closed.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    closed.store(true, Ordering::Relaxed);
    receiving.join().ok();
    // The door's threads hold senders of their own, so the writer is told to finish, which ends
    // the process with them still waiting.
    out.send(Outgoing::End).ok();
    writer.join().ok();
    drop(door);
}

/// Whether TDLib says it has closed, after which this client does nothing more.
fn is_closed(json: &str) -> bool {
    json.contains("\"authorizationStateClosed\"")
        && serde_json::from_str::<Value>(json).is_ok_and(|value| {
            value.get("@type").and_then(Value::as_str) == Some("updateAuthorizationState")
                && value.pointer("/authorization_state/@type").and_then(Value::as_str) == Some("authorizationStateClosed")
        })
}

/// Writes what's for the app to standard output, until it's told to end, which ends the process,
/// or the app's end of the pipe goes.
fn write_out(outgoing: Receiver<Outgoing>) {
    let mut stdout = BufWriter::new(std::io::stdout().lock());
    while let Ok(message) = outgoing.recv() {
        let written = match message {
            Outgoing::Json(json) => write_json(&mut stdout, &json),
            Outgoing::Data(stream, bytes) => write_data(&mut stdout, stream, &bytes),
            Outgoing::End => {
                std::io::Write::flush(&mut stdout).ok();
                std::process::exit(0);
            }
        };
        if written.is_err() {
            break;
        }
    }
}

fn fail(why: &str) -> ! {
    eprintln!("zuna-telegram: {why}");
    std::process::exit(2);
}
