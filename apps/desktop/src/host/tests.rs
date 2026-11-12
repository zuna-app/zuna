//! The host tested in QuickJS itself: the core's own bundle booted and called as the window
//! calls it, and a bundle of the tests' own driving every function the host gives a bundle,
//! its timers, requests, sockets and files against servers on this machine, its database and
//! its cryptography, MLS groups included.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use super::runtime::{self, Options, Task};
use super::*;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zuna-host-tests-{}-{name}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// What the tests' bundle sets up: a record of every callback the host makes into it.
const BUNDLE: &str = r#"
globalThis.seen = { timers: [], http: [], ws: [], web: [] };
globalThis.__zunaTimerFired = (id) => seen.timers.push(id);
globalThis.__zunaHttpDone = (id, status, headers, body, error) =>
  seen.http.push({ id, status, headers: JSON.parse(headers), body: body && __zunaHost.utf8Decode(body), error });
globalThis.__zunaWsEvent = (id, kind, data, code) => seen.ws.push({ id, kind, data, code });
globalThis.__zunaWebDone = (id, url, mime, body, error) => seen.web.push({ id, url, mime, body: !!body, error });
globalThis.__zunaReceive = (channel, json) => __zunaHost.post(channel, json);
globalThis.__zunaBoot = (key, name, done) => done(name === 'fail' ? 'It would not boot.' : null);
globalThis.eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
globalThis.enc = (text) => __zunaHost.utf8Encode(text);
"#;

const METER: &str = r#"
globalThis.__zunaPasswordStrength = (password, related) =>
  JSON.stringify({ score: Math.min(4, password.length >> 2), label: 'related ' + related.length });
"#;

/// A core's thread running a bundle, and what it posted.
struct Script {
    tasks: std::sync::mpsc::Sender<Task>,
    posted: Arc<Mutex<Vec<(u32, String)>>>,
}

impl Script {
    fn start(name: &str, bundle: &str, meter: &'static str) -> Script {
        let (tasks, inbox) = std::sync::mpsc::channel();
        let posted = Arc::new(Mutex::new(Vec::new()));
        let sink = posted.clone();
        let options = Options {
            bundle: bundle.into(),
            data_dir: temp(name),
            tokio: tokio().handle().clone(),
            post: Arc::new(move |channel, json| sink.lock().unwrap().push((channel, json))),
            test_hooks: true,
            password_bundle: meter,
        };
        let sender = tasks.clone();
        std::thread::Builder::new().stack_size(32 << 20).spawn(move || runtime::run(sender, inbox, options)).unwrap();
        Script { tasks, posted }
    }

    fn run(name: &str) -> Script {
        Script::start(name, BUNDLE, METER)
    }

    /// The script's result as JSON, or what it threw as a string.
    fn eval(&self, source: &str) -> Value {
        let (done, wait) = futures::channel::oneshot::channel();
        self.tasks.send(Task::Eval { source: source.into(), done }).unwrap();
        let text = block_on(wait).unwrap();
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    }

    /// Waits for the script to give something true.
    fn until(&self, source: &str) -> Value {
        let start = Instant::now();
        loop {
            let value = self.eval(source);
            if !matches!(value, Value::Null | Value::Bool(false)) && value != json!(0) && value != json!("undefined") {
                return value;
            }
            assert!(start.elapsed() < Duration::from_secs(20), "waited too long for {source}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn password(&self, password: &str) -> String {
        let (done, wait) = futures::channel::oneshot::channel();
        self.tasks.send(Task::Password { password: password.into(), related: vec!["alice".into()], done }).unwrap();
        block_on(wait).unwrap()
    }
}

/// An HTTP server on this machine that answers with the request's first line.
fn serve_http() -> String {
    tokio().block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let end = loop {
                        if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                            break end + 4;
                        }
                        match stream.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => request.extend_from_slice(&buffer[..read]),
                        }
                    };
                    let head = String::from_utf8_lossy(&request[..end]).to_string();
                    let length = head
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    while request.len() < end + length {
                        match stream.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => request.extend_from_slice(&buffer[..read]),
                        }
                    }
                    let line = head.lines().next().unwrap_or_default().to_string();
                    let body = format!("{line} {}", String::from_utf8_lossy(&request[end..]));
                    if line.contains("/slow") {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    if line.contains("/short") {
                        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nonly some").await.ok();
                        return;
                    }
                    let response = format!(
                        "HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nX-Twice: a\r\nX-Twice: b\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.ok();
                    stream.shutdown().await.ok();
                });
            }
        });
        format!("http://{address}")
    })
}

/// A WebSocket server on this machine: it pings, sends something binary, echoes text, closes
/// with 4000 when told "bye", and drops the connection when told "drop".
fn serve_sockets() -> String {
    tokio().block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { return };
                    socket.send(Message::Ping(vec![1].into())).await.ok();
                    socket.send(Message::Binary(b"binary".to_vec().into())).await.ok();
                    while let Some(Ok(message)) = socket.next().await {
                        match message {
                            Message::Text(text) if text.as_str() == "bye" => {
                                let frame = CloseFrame { code: 4000.into(), reason: "".into() };
                                socket.send(Message::Close(Some(frame))).await.ok();
                            }
                            Message::Text(text) if text.as_str() == "drop" => return,
                            Message::Text(text) => {
                                socket.send(Message::Text(text)).await.ok();
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        format!("ws://{address}")
    })
}

#[test]
fn the_cores_own_bundle_boots_and_answers() {
    let (core, _events) = Core::start(temp("core"));
    block_on(core.boot(vec![7; 32], "Tests".into())).expect("the core boots");
    assert_eq!(block_on(core.call(None, "listServers", vec![])).expect("it lists servers"), json!([]));
    let error = block_on(core.call(Some("server-nobody-joined"), "getUsers", vec![])).expect_err("no such server");
    assert!(!error.message.is_empty());
    let error = block_on(core.call(None, "noSuchMethod", vec![])).expect_err("no such method");
    assert!(!error.message.is_empty());
    let (score, label) = block_on(core.password_strength("correct horse battery staple".into(), vec!["alice".into()]));
    assert!(score >= 3, "a long password scores high, not {score}");
    assert!(!label.is_empty());
    assert_eq!(block_on(core.eval("1 + 1".into())), "2");
}

#[test]
fn values_cross_both_ways() {
    let script = Script::run("values");
    let png = {
        let mut out = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(40, 20, image::Rgb([200, 30, 30])).write_to(&mut out, image::ImageFormat::Png).unwrap();
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, out.into_inner())
    };
    let result = script.eval(&format!(
        r#"(() => {{
          const H = __zunaHost, out = {{}};
          out.flags = [H.testHooks, H.listsBots];
          out.utf8 = H.utf8Decode(H.utf8Encode('zażółć'));
          out.base64 = [H.base64Encode(enc('hi')), H.utf8Decode(H.base64Decode('aGk')), H.utf8Decode(H.base64Decode('aGk='))];
          try {{ H.base64Decode('!!'); }} catch (error) {{ out.badBase64 = error.message; }}
          for (const level of ['error', 'warn', 'debug', 'info']) H.log(level, 'a line at ' + level);
          H.accountEvent('signedIn');
          const picture = H.imageShrink(H.base64Decode('{png}'), 10);
          out.picture = [picture.width, picture.height, picture.data.startsWith('data:image/jpeg;base64,')];
          out.whole = H.imageShrink(H.base64Decode('{png}'), 100).width;
          out.notPicture = H.imageShrink(enc('not a picture'), 10);
          const parts = [enc('ab'), new Uint8Array([99]).buffer, new DataView(new Uint8Array([0, 100, 101, 0]).buffer, 1, 2), new Uint16Array([0x6766])];
          const path = H.fileAssemble(parts, 'txt!');
          out.size = H.fileSize(path);
          out.read = H.utf8Decode(H.fileRead(path, 1, 4));
          out.unnamed = H.fileAssemble([], '').endsWith('.bin');
          out.missingSize = H.fileSize(path + '.missing');
          try {{ H.fileRead(path + '.missing', 0, 1); }} catch (error) {{ out.missingRead = error.message.startsWith("Couldn't read"); }}
          out.pins = [H.pinServer('http://server.example', 'pin'), H.pinServer('not an address', 'pin')];
          return out;
        }})()"#
    ));
    assert_eq!(result["flags"], json!([true, true]));
    assert_eq!(result["utf8"], "zażółć");
    assert_eq!(result["base64"], json!(["aGk=", "hi", "hi"]));
    assert_eq!(result["badBase64"], "That isn't base64.");
    assert_eq!(result["picture"], json!([10, 5, true]));
    assert_eq!(result["whole"], 40);
    assert_eq!(result["notPicture"], Value::Null);
    assert_eq!(result["size"], 7, "every part was written: {result}");
    assert_eq!(result["read"], "bcd");
    assert_eq!(result["unnamed"], true);
    assert_eq!(result["missingSize"], 0);
    assert_eq!(result["missingRead"], true);
    assert_eq!(result["pins"], json!([false, false]));

    // What the UI sends goes in, and what the core posts comes out.
    script.tasks.send(Task::Receive { channel: 3, json: r#"{"kind":"call"}"#.into() }).unwrap();
    script.until("1");
    assert_eq!(script.posted.lock().unwrap().as_slice(), &[(3, r#"{"kind":"call"}"#.to_string())]);

    // Booting, and a boot that fails.
    for (name, expected) in [("Tests", Ok(())), ("fail", Err("It would not boot.".to_string()))] {
        let (done, wait) = futures::channel::oneshot::channel();
        script.tasks.send(Task::Boot { key: vec![1; 32], name: name.into(), done }).unwrap();
        assert_eq!(block_on(wait).unwrap(), expected);
    }

    // A script that throws, and a promise nobody handles.
    assert!(script.eval("throw new Error('on purpose')").as_str().is_some_and(|text| text.starts_with("throws: on purpose")));
    assert!(script.eval("throw 'a string'").as_str().is_some_and(|text| text.contains("a string")));
    assert_eq!(script.eval("Promise.reject(new Error('nobody waits')); Promise.reject({ plain: true }); 1"), json!(1));
    assert_eq!(script.eval("undefined"), json!("undefined"));
}

#[test]
fn timers_fire_repeat_and_stop() {
    let script = Script::run("timers");
    script.eval("__zunaHost.setTimer(1, 5, false); __zunaHost.setTimer(2, 5, true); __zunaHost.setTimer(3, 2000, false); __zunaHost.clearTimer(3); __zunaHost.clearTimer(42)");
    script.until("seen.timers.includes(1) && seen.timers.filter((id) => id === 2).length >= 3");
    script.eval("__zunaHost.clearTimer(2)");
    let fired = script.eval("seen.timers.filter((id) => id === 2).length");
    // A tick already on its way when the timer stopped is dropped as one nobody wants.
    script.tasks.send(Task::Timer(2)).unwrap();
    script.tasks.send(Task::Timer(77)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(script.eval("seen.timers.filter((id) => id === 2).length"), fired);
    assert!(!script.eval("seen.timers").as_array().unwrap().contains(&json!(3)));
}

#[test]
fn requests_and_their_answers() {
    let script = Script::run("http");
    let url = serve_http();
    script.eval(&format!(
        r#"const H = __zunaHost;
        H.http(1, 'POST', '{url}/path', JSON.stringify({{ 'x-test': '1' }}), 'a body', 5000, false);
        H.http(2, 'PUT', '{url}/bytes', '{{}}', new Uint8Array([104, 105]), 0, true);
        H.http(3, 'NOT A METHOD', '{url}/', '{{}}', undefined, 0);
        H.http(4, 'GET', 'http://127.0.0.1:1/', 'not json', undefined, 2000);
        H.http(5, 'GET', '{url}/slow', '{{}}', undefined, 0);
        H.httpCancel(5);
        H.httpCancel(55);
        H.http(6, 'GET', '{url}/short', '{{}}', undefined, 5000);"#
    ));
    let answers = script.until("seen.http.length >= 5 && seen.http");
    // An answer for a request nobody's waiting on is dropped.
    script.tasks.send(Task::HttpDone { id: 99, status: 200, headers: "{}".into(), body: None, error: None }).unwrap();
    let by_id = |id: u64| answers.as_array().unwrap().iter().find(|answer| answer["id"] == id).cloned().unwrap_or(Value::Null);
    assert_eq!(by_id(1)["status"], 201);
    assert_eq!(by_id(1)["body"], "POST /path HTTP/1.1 a body");
    assert_eq!(by_id(1)["headers"]["x-twice"], "a, b");
    assert_eq!(by_id(2)["body"], "PUT /bytes HTTP/1.1 hi");
    assert_eq!(by_id(3)["error"], "Invalid method");
    assert_eq!(by_id(4)["status"], 0);
    assert!(by_id(4)["error"].as_str().is_some_and(|error| !error.is_empty()));
    assert_eq!(by_id(5), Value::Null, "a cancelled request never answers");
    assert_eq!(by_id(6)["status"], 0, "a body cut short is an error: {}", by_id(6));
    assert_eq!(script.eval("seen.http.length"), 5);
}

#[test]
fn sockets_open_talk_and_close() {
    let script = Script::run("sockets");
    let url = serve_sockets();
    script.eval(&format!("__zunaHost.wsOpen(1, '{url}'); __zunaHost.wsOpen(2, '{url}'); __zunaHost.wsOpen(3, '{url}'); __zunaHost.wsOpen(4, 'ws://127.0.0.1:1/')"));
    script.until("[1, 2, 3].every((id) => seen.ws.some((event) => event.id === id && event.data === 'binary'))");
    script.eval("__zunaHost.wsSend(1, 'hello'); __zunaHost.wsSend(2, 'bye'); __zunaHost.wsSend(3, 'drop'); __zunaHost.wsSend(99, 'nobody'); __zunaHost.wsClose(99, 1000)");
    script.until("seen.ws.some((event) => event.id === 1 && event.data === 'hello')");
    script.eval("__zunaHost.wsClose(1, 1000)");
    let closes = script.until("[1, 2, 3, 4].every((id) => seen.ws.some((event) => event.id === id && event.kind === 'close')) && Object.fromEntries(seen.ws.filter((event) => event.kind === 'close').map((event) => [event.id, event.code]))");
    assert_eq!(closes, json!({ "1": 1000, "2": 4000, "3": 1006, "4": 1006 }));
    assert_eq!(script.eval("seen.ws.filter((event) => event.kind === 'error').map((event) => event.id).sort()"), json!([3, 4]));
    assert_eq!(script.eval("seen.ws.filter((event) => event.kind === 'open').length"), 3);
    // Sending on a socket that closed reaches nothing.
    script.eval("__zunaHost.wsSend(1, 'late'); __zunaHost.wsClose(1, 1000)");
}

#[test]
fn link_previews_are_fetched_off_the_thread() {
    let script = Script::run("web");
    let url = serve_http();
    script.eval(&format!("__zunaHost.webFetch(1, '{url}/page', 0); __zunaHost.webFetch(2, 'not an address', 1000)"));
    let done = script.until("seen.web.length === 2 && seen.web");
    assert!(done.as_array().unwrap().iter().any(|answer| answer["id"] == 2 && answer["error"].is_string()));
}

#[test]
fn the_password_meter_loads_when_first_asked() {
    let script = Script::run("meter");
    assert_eq!(script.password("short"), r#"{"score":1,"label":"related 1"}"#);
    assert_eq!(script.password("a much longer password"), r#"{"score":4,"label":"related 1"}"#);
    let broken = Script::start("meter-broken", "throw new Error('the bundle is broken')", "throw new Error('so is the meter')");
    assert_eq!(broken.password("anything"), r#"{"score":0,"label":""}"#);
    // A bundle that didn't load leaves a thread that still answers.
    assert_eq!(broken.eval("1 + 2"), json!(3));
}

#[test]
fn the_database_keeps_every_kind_of_value() {
    let script = Script::run("db");
    let result = script.eval(
        r#"(() => {
          const D = __zunaDb, out = {};
          const handle = D.open('tests/../one');
          out.same = D.open('tests/../one') === handle;
          D.run(handle, 'CREATE TABLE t (a, b, c, d, e, f); CREATE TABLE u (x)');
          const insert = D.prepare(handle, 'INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)');
          D.exec(insert, [null, true, 7, 2.5, 'text', new Uint8Array([1, 2, 3])]);
          D.exec(insert, [undefined, false, 2 ** 40, 3.0, '', new Uint16Array([0x0102])]);
          D.exec(insert, [{}, -1, 2 ** 31, 1e300, 'z', new DataView(new Uint8Array([5, 6, 7]).buffer, 1, 2)]);
          const rows = D.query(D.prepare(handle, 'SELECT * FROM t ORDER BY rowid'), []);
          out.rows = rows.map((row) => [row.a, row.b, row.c, row.d, row.e, Array.from(row.f)]);
          out.where = D.query(D.prepare(handle, 'SELECT e FROM t WHERE b = ?'), [true]).map((row) => row.e);
          try { D.prepare(handle, 'SELEC nonsense'); } catch (error) { out.badSql = error.message.length > 0; }
          try { D.run(999, 'SELECT 1'); } catch (error) { out.notOpen = error.message; }
          try { D.run(handle, 'NOT SQL'); } catch (error) { out.badBatch = true; }
          try { D.prepare(999, 'SELECT 1'); } catch (error) { out.prepareNotOpen = true; }
          try { D.exec(insert, [1]); } catch (error) { out.tooFew = true; }
          D.drop(handle);
          try { D.exec(insert, []); } catch (error) { out.dropped = error.message; }
          try { D.query(insert, []); } catch (error) { out.droppedQuery = true; }
          D.close(handle);
          const again = D.open('tests/../one');
          out.reopened = again !== handle && D.query(D.prepare(again, 'SELECT count(*) AS n FROM t'), [])[0].n;
          D.remove('tests/../one');
          const fresh = D.open('tests/../one');
          out.removed = D.query(D.prepare(fresh, "SELECT count(*) AS n FROM sqlite_master WHERE name = 't'"), [])[0].n;
          D.remove('never-opened');
          return out;
        })()"#,
    );
    assert_eq!(result["same"], true);
    assert_eq!(
        result["rows"],
        json!([[null, 1, 7, 2.5, "text", [1, 2, 3]], [null, 0, 1099511627776_u64, 3, "", [2, 1]], [null, -1, 2147483648_u64, 1e300, "z", [6, 7]]])
    );
    assert_eq!(result["where"], json!(["text"]));
    assert_eq!(result["badSql"], true);
    assert_eq!(result["notOpen"], "That database isn't open.");
    assert_eq!(result["badBatch"], true);
    assert_eq!(result["prepareNotOpen"], true);
    assert_eq!(result["tooFew"], true);
    assert_eq!(result["dropped"], "That statement was let go.");
    assert_eq!(result["droppedQuery"], true);
    assert_eq!(result["reopened"], 3);
    assert_eq!(result["removed"], 0);
}

#[test]
fn cryptography_through_quickjs() {
    let script = Script::run("crypto");
    let result = script.eval(
        r#"(() => {
          const C = __zunaCrypto, H = __zunaHost, out = {};
          out.named = C.sign.name;
          out.random = C.randomBytes(16).length;
          out.argon = C.argon2id(enc('pw'), C.randomBytes(16), 64, 1, 1, 32).length;
          try { C.argon2id(enc('pw'), enc('s'), 0, 0, 0, 0); } catch (error) { out.argonRefused = true; }
          out.hkdf = C.hkdfSha256(enc('ikm'), enc('salt'), enc('info'), 42).length;
          out.sha = Array.from(C.sha256(enc('abc')).slice(0, 4));
          const key = C.randomBytes(32);
          const sealed = C.aeadSeal(key, enc('secret'), enc('aad'));
          out.aead = H.utf8Decode(C.aeadOpen(key, sealed, enc('aad')));
          try { C.aeadOpen(key, sealed, enc('other')); } catch (error) { out.aeadRefused = true; }
          const prefix = C.randomBytes(15);
          out.stream = H.utf8Decode(C.streamOpen(key, prefix, 3, true, C.streamSeal(key, prefix, 3, true, enc('chunk'))));
          try { C.streamOpen(key, prefix, 4, true, C.streamSeal(key, prefix, 3, true, enc('chunk'))); } catch (error) { out.reordered = true; }
          const signer = C.signingKeygen();
          const signature = C.sign(signer.secretKey, enc('m'));
          out.verify = [C.verify(signer.publicKey, enc('m'), signature), C.verify(signer.publicKey, enc('n'), signature)];
          out.public = eq(C.signingPublic(signer.secretKey), signer.publicKey);
          try { C.sign(enc('short'), enc('m')); } catch (error) { out.signRefused = true; }
          const hpke = C.hpkeKeygen();
          out.hpke = H.utf8Decode(C.hpkeOpen(hpke.secretKey, enc('info'), enc('aad'), C.hpkeSeal(hpke.publicKey, enc('info'), enc('aad'), enc('hi'))));
          out.digest = eq(C.safetyDigest(enc('a'), enc('b')), C.safetyDigest(enc('b'), enc('a')));
          out.blinds = C.tokenBlind(2).length > 0;
          try { C.tokenFinalize(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)); } catch (error) { out.finalizeRefused = true; }

          // A group of three: made, joined from a welcome and from outside, someone removed.
          const device = (name) => { const key = C.signingKeygen(); return [key, C.mlsNew(key.publicKey, key.secretKey, enc(name), [])]; };
          const [, alice] = device('alice'), [bobKey, bob] = device('bob'), [, carol] = device('carol');
          const group = enc('group-1');
          out.created = C.mls(alice, 'createGroup', group, enc('roster-1'));
          const package_ = C.mls(bob, 'generateKeyPackage', false);
          out.packageOf = [H.utf8Decode(C.mls(alice, 'keyPackageCredential', package_)), eq(C.mls(alice, 'keyPackageSignatureKey', package_), bobKey.publicKey)];
          const adding = C.mls(alice, 'commitChanges', group, [package_], [], enc('roster-2'));
          out.adding = [adding.commit.length > 0, adding.welcome !== null, C.mls(alice, 'hasPending', group)];
          out.merged = C.mls(alice, 'mergePending', group);
          const joined = C.mls(bob, 'joinFromWelcome', adding.welcome, group);
          out.joined = [joined.epoch, eq(joined.groupId, group)];
          out.sameSecret = eq(C.mls(alice, 'exportSecret', group, 'label', enc('ctx'), 32), C.mls(bob, 'exportSecret', group, 'label', enc('ctx'), 32));
          out.members = C.mls(alice, 'members', group).map((member) => [member.leafIndex, H.utf8Decode(member.credential), member.signatureKey.length > 0]);
          out.roster = H.utf8Decode(C.mls(bob, 'roster', group));
          out.leaf = C.mls(bob, 'ownLeafIndex', group);
          const outside = C.mls(carol, 'joinExternal', group, C.mls(alice, 'exportGroupInfo', group));
          const seenByAlice = C.mls(alice, 'processCommit', group, outside.commit);
          C.mls(bob, 'processCommit', group, outside.commit);
          out.external = [outside.epoch, seenByAlice.epoch, seenByAlice.isExternal, seenByAlice.addedCredentials.map((c) => H.utf8Decode(c)), H.utf8Decode(seenByAlice.senderCredential)];
          const removing = C.mls(bob, 'commitChanges', group, [], new Uint32Array([C.mls(carol, 'ownLeafIndex', group)]), undefined);
          C.mls(bob, 'mergePending', group);
          const removal = C.mls(alice, 'processCommit', group, removing.commit);
          out.removed = [removal.removedCredentials.map((c) => H.utf8Decode(c)), removal.selfRemoved, C.mls(carol, 'processCommit', group, removing.commit).selfRemoved];
          C.mls(alice, 'commitChanges', group, [], [1], null);
          out.pendingSecret = C.mls(alice, 'exportPendingSecret', group, 'label', enc(''), 16).length;
          C.mls(alice, 'clearPending', group);
          out.cleared = C.mls(alice, 'hasPending', group);
          out.epoch = C.mls(alice, 'epoch', group);
          const changes = C.mls(alice, 'takeChanges');
          out.changes = changes.set.length > 0 && Array.isArray(changes.deleted);
          C.mls(alice, 'rollback');
          C.mls(alice, 'setCredential', enc('alice-2'));
          out.hasGroup = [C.mls(alice, 'hasGroup', group), C.mls(alice, 'hasGroup', enc('nope'))];
          const saved = C.mls(bob, 'takeChanges').set;
          const restored = C.mlsNew(bobKey.publicKey, bobKey.secretKey, enc('bob'), saved);
          out.restored = C.mls(restored, 'epoch', group);
          C.mls(bob, 'deleteGroup', group);
          out.deleted = C.mls(bob, 'hasGroup', group);
          C.mlsFree(restored);
          try { C.mls(restored, 'epoch', group); } catch (error) { out.freed = error.message; }
          try { C.mls(alice, 'nonsense'); } catch (error) { out.unknown = error.message; }
          try { C.mls(alice, 'epoch', enc('nope')); } catch (error) { out.noGroup = true; }
          return out;
        })()"#,
    );
    assert_eq!(result["named"], "sign");
    assert_eq!(result["random"], 16);
    assert_eq!(result["argon"], 32);
    assert_eq!(result["argonRefused"], true);
    assert_eq!(result["hkdf"], 42);
    assert_eq!(result["sha"], json!([0xba, 0x78, 0x16, 0xbf]));
    assert_eq!(result["aead"], "secret");
    assert_eq!(result["aeadRefused"], true);
    assert_eq!(result["stream"], "chunk");
    assert_eq!(result["reordered"], true);
    assert_eq!(result["verify"], json!([true, false]));
    assert_eq!(result["public"], true);
    assert_eq!(result["signRefused"], true);
    assert_eq!(result["hpke"], "hi");
    assert_eq!(result["digest"], true);
    assert_eq!(result["blinds"], true);
    assert_eq!(result["finalizeRefused"], true);
    assert_eq!(result["created"], 0, "{result}");
    assert_eq!(result["packageOf"], json!(["bob", true]));
    assert_eq!(result["adding"], json!([true, true, true]));
    assert_eq!(result["merged"], 1);
    assert_eq!(result["joined"], json!([1, true]));
    assert_eq!(result["sameSecret"], true);
    assert_eq!(result["members"], json!([[0, "alice", true], [1, "bob", true]]));
    assert_eq!(result["roster"], "roster-2");
    assert_eq!(result["leaf"], 1);
    // Someone joining from outside comes in with no add proposal.
    assert_eq!(result["external"], json!([2, 2, true, [], "carol"]));
    assert_eq!(result["removed"], json!([["carol"], false, true]));
    assert_eq!(result["pendingSecret"], 16);
    assert_eq!(result["cleared"], false);
    assert_eq!(result["epoch"], 3);
    assert_eq!(result["changes"], true);
    assert_eq!(result["hasGroup"], json!([true, false]));
    assert_eq!(result["restored"], 3);
    assert_eq!(result["deleted"], false);
    assert!(result["freed"].as_str().is_some_and(|text| text.contains("doesn't exist")));
    assert_eq!(result["unknown"], "Unknown MLS method nonsense");
    assert_eq!(result["noGroup"], true);
}

#[test]
fn values_on_the_wire() {
    let dir = temp("wire");
    assert_eq!(undefined(), json!({ "$undefined": true }));
    let bytes_value = bytes(b"hello");
    assert_eq!(read_bytes(&bytes_value).unwrap(), b"hello");
    assert_eq!(read_bytes(&json!({ "$blob": { "bytes": "aGk=" } })).unwrap(), b"hi");
    assert_eq!(read_bytes(&json!({ "$bytes": "!!" })), None);
    assert_eq!(read_bytes(&json!("plain")), None);

    let source = dir.join("source.txt");
    write_whole(&source, b"on disk").unwrap();
    assert!(!dir.join("source.partial").exists());
    let on_disk = file(source.to_str().unwrap(), "text/plain");
    assert_eq!(on_disk["$file"]["type"], "text/plain");
    assert_eq!(value_bytes(&on_disk).unwrap(), b"on disk");
    assert_eq!(value_bytes(&bytes_value).unwrap(), b"hello");

    let copied = dir.join("copied.txt");
    save_value(&on_disk, &copied, false).unwrap();
    assert!(source.exists());
    let moved = dir.join("moved.txt");
    save_value(&on_disk, &moved, true).unwrap();
    assert!(!source.exists());
    assert_eq!(std::fs::read(&moved).unwrap(), b"on disk");
    assert!(save_value(&on_disk, &dir.join("again.txt"), false).is_err(), "the file moved away");
    save_value(&bytes_value, &dir.join("bytes.txt"), false).unwrap();
    assert_eq!(save_value(&json!({}), &dir.join("nothing.txt"), false), Err("nothing came to save".to_string()));

    std::fs::create_dir_all(dir.join("cache").join("files")).unwrap();
    std::fs::write(dir.join("cache").join("files").join("left"), b"x").unwrap();
    clear_cache(&dir);
    assert!(!dir.join("cache").exists());
    assert!(cache_dir().ends_with("cache"));
    assert!(tls_config().alpn_protocols.contains(&b"h2".to_vec()));
}

/// The tests run from where they were built, as a development build does.
#[cfg(windows)]
#[test]
fn a_copy_that_was_not_installed_keeps_its_data_apart() {
    if std::env::var_os("ZUNA_DATA_DIR").is_some() {
        return;
    }
    assert!(data_dir().ends_with("Zuna Native Dev"));
}

#[cfg(windows)]
#[test]
fn the_device_key_is_sealed_by_the_system() {
    let dir = temp("device-key");
    let first = device_key::load(&dir).unwrap();
    assert!(first.protected);
    assert_eq!(first.key.len(), 32);
    assert_eq!(device_key::load(&dir).unwrap().key, first.key, "the same key comes back");

    // One kept plain before the system would seal it is sealed now, and the plain copy goes.
    let plain = temp("device-key-plain");
    std::fs::write(plain.join("device-key.bin"), [5; 32]).unwrap();
    let key = device_key::load(&plain).unwrap();
    assert_eq!((key.key, key.protected), (vec![5; 32], true));
    assert!(!plain.join("device-key.bin").exists());
    assert!(plain.join("device-key.sealed").exists());

    // A sealed key the system can't open is an error, never a new key in its place.
    let broken = temp("device-key-broken");
    std::fs::write(broken.join("device-key.sealed"), b"not sealed by anyone").unwrap();
    assert!(device_key::load(&broken).is_err());
}
