//! The core's thread. It runs the core bundle in QuickJS, as the iOS app runs it in
//! JavaScriptCore (CoreRuntime.swift), with `__zunaHost` for everything outside it:
//! timers, the network, files and the UI. Everything the core calls happens on this
//! thread; network and timers run on tokio and come back here as tasks.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::{SinkExt, StreamExt};
use rquickjs::function::Rest;
use rquickjs::{Array, Context, Ctx, Function, Object, Result, Runtime, Value};
use tokio::runtime::Handle;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::js::*;
use super::{crypto, db, tls};

/// Work for the core's thread.
pub enum Task {
    /// An RPC message from a channel of the UI.
    Receive { channel: u32, json: String },
    Boot { key: Vec<u8>, name: String, done: futures::channel::oneshot::Sender<std::result::Result<(), String>> },
    Timer(u32),
    HttpDone { id: u32, status: u16, headers: String, body: Option<Vec<u8>>, error: Option<String> },
    Socket { id: u32, kind: &'static str, data: Option<String>, code: u16 },
    WebDone { id: u32, url: String, mime: String, body: Option<Vec<u8>>, error: Option<String> },
    /// Script for checks and tests, whose result comes back as JSON.
    Eval { source: String, done: futures::channel::oneshot::Sender<String> },
    /// How hard a password is to guess, as JSON `{ score, label }`, from the estimator every app shares.
    Password { password: String, related: Vec<String>, done: futures::channel::oneshot::Sender<String> },
    /// The proxy changed (net.rs): everything open ends, and goes the new way when it's made again.
    Network,
    /// What a linked Telegram account's engine said, through the broker (src/telegram).
    Telegram(String),
}

enum SocketCommand {
    Send(String),
    Close(u16),
}

/// What the host functions share, all on the core's thread.
struct Host {
    tasks: Sender<Task>,
    tokio: Handle,
    http: reqwest::Client,
    /// What adds to a conversation without saying who's sending, on connections of its own,
    /// with a TLS session cache of its own, sharing nothing with `http`'s.
    sealed_http: reqwest::Client,
    /// For link previews alone, under their address rules (web.rs).
    web: reqwest::Client,
    timers: HashMap<u32, (AbortHandle, bool)>,
    requests: HashMap<u32, AbortHandle>,
    sockets: HashMap<u32, (UnboundedSender<SocketCommand>, AbortHandle)>,
    files: PathBuf,
    post: Arc<dyn Fn(u32, String) + Send + Sync>,
    data_dir: PathBuf,
    /// This device's key, from when the core boots, which the Telegram engine's database key is sealed with.
    device_key: Option<Vec<u8>>,
    /// A linked Telegram account's engine, once the core first starts it.
    telegram: Option<crate::telegram::Engine>,
}

pub struct Options {
    pub bundle: String,
    pub data_dir: PathBuf,
    pub tokio: Handle,
    pub post: Arc<dyn Fn(u32, String) + Send + Sync>,
    pub test_hooks: bool,
    /// The password meter, loaded into a context of its own when first asked.
    pub password_bundle: &'static str,
}

pub fn run(tasks: Sender<Task>, inbox: Receiver<Task>, options: Options) {
    let runtime = Runtime::new().expect("QuickJS starts");
    runtime.set_max_stack_size(12 * 1024 * 1024);
    runtime.set_host_promise_rejection_tracker(Some(Box::new(|ctx, _promise, reason, handled| {
        if !handled {
            let text = if let Some(exception) = reason.as_exception() {
                format!("{}\n{}", exception.message().unwrap_or_default(), exception.stack().unwrap_or_default())
            } else {
                ctx.json_stringify(reason).ok().flatten().and_then(|text| text.to_string().ok()).unwrap_or_default()
            };
            log::warn!(target: "core", "unhandled rejection: {text}");
        }
    })));
    let context = Context::full(&runtime).expect("a QuickJS context");

    let (http, sealed_http, web) = clients();

    let files = super::cache_in(&options.data_dir).join("files");
    std::fs::create_dir_all(&files).ok();
    let host = Rc::new(RefCell::new(Host {
        tasks: tasks.clone(),
        tokio: options.tokio.clone(),
        http,
        sealed_http,
        web,
        timers: HashMap::new(),
        requests: HashMap::new(),
        sockets: HashMap::new(),
        files,
        post: options.post.clone(),
        data_dir: options.data_dir.clone(),
        device_key: None,
        telegram: None,
    }));

    let loaded = context.with(|ctx| -> Result<()> {
        install_host(&ctx, host.clone(), options.test_hooks)?;
        crypto::install(&ctx)?;
        db::install(&ctx, options.data_dir.join("db"))?;
        ctx.eval::<(), _>(options.bundle.as_bytes())
    });
    if let Err(error) = loaded {
        let detail = context.with(|ctx| describe_exception(&ctx));
        log::error!(target: "core", "the core bundle didn't load: {error}: {detail}");
    }
    drain(&runtime);

    let mut password: Option<Context> = None;
    while let Ok(task) = inbox.recv() {
        if let Task::Password { password: text, related, done } = task {
            let meter = password.get_or_insert_with(|| {
                let meter = Context::full(&runtime).expect("a QuickJS context");
                meter.with(|ctx| {
                    if ctx.eval::<(), _>(options.password_bundle.as_bytes()).is_err() {
                        log::error!(target: "core", "the password meter didn't load: {}", describe_exception(&ctx));
                    }
                });
                meter
            });
            let result = meter.with(|ctx| -> Result<String> {
                let estimate: Function = ctx.globals().get("__zunaPasswordStrength")?;
                estimate.call((text, related))
            });
            done.send(result.unwrap_or_else(|_| "{\"score\":0,\"label\":\"\"}".into())).ok();
            continue;
        }
        context.with(|ctx| {
            if let Err(error) = dispatch(&ctx, &host, task) {
                log::error!(target: "core", "{error}: {}", describe_exception(&ctx));
            }
        });
        drain(&runtime);
    }
}

/// The core's clients: its session's, the sealed requests', on connections and a TLS session
/// cache of their own, and link previews'. Through the proxy, where one is set (net.rs).
fn clients() -> (reqwest::Client, reqwest::Client, reqwest::Client) {
    let client = || super::net::client().use_preconfigured_tls(tls::client_config(&[b"h2", b"http/1.1"])).connect_timeout(Duration::from_secs(15)).build().expect("an HTTP client");
    (client(), client(), super::web::client(tls::client_config(&[b"h2", b"http/1.1"])))
}

/// Runs the promise jobs a task left, until there are none.
fn drain(runtime: &Runtime) {
    loop {
        match runtime.execute_pending_job() {
            Ok(true) => continue,
            Ok(false) => break,
            Err(error) => {
                let detail = error.0.with(|ctx| describe_exception(&ctx));
                log::error!(target: "core", "a job failed: {detail}");
            }
        }
    }
}

fn call<'js>(ctx: &Ctx<'js>, name: &str, args: Vec<Value<'js>>) -> Result<()> {
    let function: Function = ctx.globals().get(name)?;
    let array = Array::new(ctx.clone())?;
    for (index, arg) in args.into_iter().enumerate() {
        array.set(index, arg)?;
    }
    let apply: Function = function.get("apply")?;
    apply.call::<_, ()>((rquickjs::function::This(function.clone()), Value::new_undefined(ctx.clone()), array))
}

fn string<'js>(ctx: &Ctx<'js>, text: &str) -> Result<Value<'js>> {
    Ok(rquickjs::String::from_str(ctx.clone(), text)?.into_value())
}

fn optional_string<'js>(ctx: &Ctx<'js>, text: Option<&str>) -> Result<Value<'js>> {
    match text {
        Some(text) => string(ctx, text),
        None => Ok(Value::new_null(ctx.clone())),
    }
}

fn dispatch<'js>(ctx: &Ctx<'js>, host: &Rc<RefCell<Host>>, task: Task) -> Result<()> {
    match task {
        Task::Receive { channel, json } => call(ctx, "__zunaReceive", vec![number(ctx, channel as f64), string(ctx, &json)?]),
        Task::Boot { key, name, done } => {
            host.borrow_mut().device_key = Some(key.clone());
            let done = RefCell::new(Some(done));
            let callback = Function::new(ctx.clone(), move |Rest(args): Rest<Value<'js>>| {
                let error = args.first().and_then(|value| value.as_string()).and_then(|text| text.to_string().ok());
                if let Some(done) = done.borrow_mut().take() {
                    done.send(match error {
                        Some(error) => Err(error),
                        None => Ok(()),
                    })
                    .ok();
                }
            })?;
            call(ctx, "__zunaBoot", vec![new_bytes(ctx, &key)?, string(ctx, &name)?, callback.into_value()])
        }
        Task::Timer(id) => {
            {
                let mut host = host.borrow_mut();
                match host.timers.get(&id) {
                    None => return Ok(()),
                    Some((_, false)) => {
                        host.timers.remove(&id);
                    }
                    Some(_) => {}
                }
            }
            call(ctx, "__zunaTimerFired", vec![number(ctx, id as f64)])
        }
        Task::HttpDone { id, status, headers, body, error } => {
            if host.borrow_mut().requests.remove(&id).is_none() {
                return Ok(());
            }
            call(
                ctx,
                "__zunaHttpDone",
                vec![
                    number(ctx, id as f64),
                    number(ctx, status as f64),
                    string(ctx, &headers)?,
                    optional_bytes(ctx, body.as_ref())?,
                    optional_string(ctx, error.as_deref())?,
                ],
            )
        }
        Task::Socket { id, kind, data, code } => {
            // What a socket said before it was dropped for a change of proxy goes nowhere.
            let open = if kind == "close" { host.borrow_mut().sockets.remove(&id).is_some() } else { host.borrow().sockets.contains_key(&id) };
            if !open {
                return Ok(());
            }
            call(
                ctx,
                "__zunaWsEvent",
                vec![number(ctx, id as f64), string(ctx, kind)?, optional_string(ctx, data.as_deref())?, number(ctx, code as f64)],
            )
        }
        Task::Password { .. } => Ok(()),
        Task::Network => {
            let (requests, sockets) = {
                let mut host = host.borrow_mut();
                // Telegram's connections too: TDLib makes them again, the new way.
                if let Some(engine) = &host.telegram {
                    engine.network_changed();
                }
                (host.http, host.sealed_http, host.web) = clients();
                (host.requests.drain().collect::<Vec<_>>(), host.sockets.drain().collect::<Vec<_>>())
            };
            for (id, handle) in requests {
                handle.abort();
                call(ctx, "__zunaHttpDone", vec![number(ctx, id as f64), number(ctx, 0.), string(ctx, "{}")?, Value::new_null(ctx.clone()), string(ctx, "The connection changed.")?])?;
            }
            for (id, (_, handle)) in sockets {
                handle.abort();
                call(ctx, "__zunaWsEvent", vec![number(ctx, id as f64), string(ctx, "error")?, Value::new_null(ctx.clone()), number(ctx, 0.)])?;
                call(ctx, "__zunaWsEvent", vec![number(ctx, id as f64), string(ctx, "close")?, Value::new_null(ctx.clone()), number(ctx, 1006.)])?;
            }
            Ok(())
        }
        Task::Telegram(json) => call(ctx, "__zunaTelegram", vec![string(ctx, &json)?]),
        Task::Eval { source, done } => {
            let result = match ctx.eval::<Value, _>(source.as_bytes()) {
                Ok(value) => ctx.json_stringify(value).ok().flatten().and_then(|text| text.to_string().ok()).unwrap_or_else(|| "undefined".into()),
                Err(_) => format!("throws: {}", describe_exception(ctx)),
            };
            done.send(result).ok();
            Ok(())
        }
        Task::WebDone { id, url, mime, body, error } => call(
            ctx,
            "__zunaWebDone",
            vec![
                number(ctx, id as f64),
                string(ctx, &url)?,
                string(ctx, &mime)?,
                optional_bytes(ctx, body.as_ref())?,
                optional_string(ctx, error.as_deref())?,
            ],
        ),
    }
}

macro_rules! host_fn {
    ($object:expr, $ctx:expr, $host:expr, $name:literal, |$c:ident, $h:ident, $a:ident| $body:expr) => {{
        let $h = $host.clone();
        $object.set(
            $name,
            Function::new($ctx.clone(), move |$c: Ctx<'js>, Rest($a): Rest<Value<'js>>| -> Result<Value<'js>> {
                #[allow(unused_variables)]
                let $h = &$h;
                $body
            })?,
        )?;
    }};
}

fn install_host<'js>(ctx: &Ctx<'js>, host: Rc<RefCell<Host>>, test_hooks: bool) -> Result<()> {
    let object = Object::new(ctx.clone())?;
    object.set("testHooks", test_hooks)?;
    // The app lists bots in a tab of their own, so the core gives it one nobody has written to yet.
    object.set("listsBots", true)?;

    host_fn!(object, ctx, host, "log", |c, h, a| {
        let level = string_arg(&a, 0);
        let message = string_arg(&a, 1);
        match level.as_str() {
            "error" => log::error!(target: "core", "{message}"),
            "warn" => log::warn!(target: "core", "{message}"),
            "debug" => log::debug!(target: "core", "{message}"),
            _ => log::info!(target: "core", "{message}"),
        }
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "setTimer", |c, h, a| {
        let id = number_arg(&a, 0) as u32;
        let ms = number_arg(&a, 1).max(0.0) as u64;
        let repeats = bool_arg(&a, 2);
        let mut host = h.borrow_mut();
        let tasks = host.tasks.clone();
        let handle = host.tokio.spawn(async move {
            let period = Duration::from_millis(ms.max(if repeats { 1 } else { 0 }));
            if repeats {
                let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                // After a stall, as when the computer sleeps, one tick and on from there, not every one missed at once.
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    interval.tick().await;
                    if tasks.send(Task::Timer(id)).is_err() {
                        break;
                    }
                }
            } else {
                tokio::time::sleep(period).await;
                tasks.send(Task::Timer(id)).ok();
            }
        });
        host.timers.insert(id, (handle.abort_handle(), repeats));
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "clearTimer", |c, h, a| {
        if let Some((handle, _)) = h.borrow_mut().timers.remove(&(number_arg(&a, 0) as u32)) {
            handle.abort();
        }
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "utf8Encode", |c, h, a| new_bytes(&c, string_arg(&a, 0).as_bytes()));
    host_fn!(object, ctx, host, "utf8Decode", |c, h, a| {
        let bytes = bytes_arg(&a, 0);
        string(&c, &String::from_utf8_lossy(&bytes))
    });
    host_fn!(object, ctx, host, "base64Encode", |c, h, a| string(&c, &STANDARD.encode(bytes_arg(&a, 0))));
    host_fn!(object, ctx, host, "base64Decode", |c, h, a| {
        let text = string_arg(&a, 0);
        let decoded = STANDARD
            .decode(text.trim_end_matches('=').to_string() + &"=".repeat((4 - text.trim_end_matches('=').len() % 4) % 4))
            .map_err(|_| fail(&c, "That isn't base64."))?;
        new_bytes(&c, decoded)
    });

    // The desktop seals its device key with the system (device_key.rs), not with a password.
    host_fn!(object, ctx, host, "accountEvent", |c, h, _a| Ok(Value::new_undefined(c)));

    host_fn!(object, ctx, host, "post", |c, h, a| {
        let post = h.borrow().post.clone();
        post(number_arg(&a, 0) as u32, string_arg(&a, 1));
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "http", |c, h, a| {
        let id = number_arg(&a, 0) as u32;
        let method = string_arg(&a, 1);
        let url = string_arg(&a, 2);
        let headers: HashMap<String, String> = serde_json::from_str(&string_arg(&a, 3)).unwrap_or_default();
        let body: Option<Vec<u8>> = match a.get(4) {
            Some(value) if value.is_string() => Some(string_arg(&a, 4).into_bytes()),
            Some(value) => read_bytes(value),
            None => None,
        };
        let timeout = number_arg(&a, 5);
        let sealed = a.get(6).is_some_and(|value| value.as_bool() == Some(true));
        let mut host = h.borrow_mut();
        let tasks = host.tasks.clone();
        let client = if sealed { host.sealed_http.clone() } else { host.http.clone() };
        let handle = host.tokio.spawn(async move {
            let done = |status: u16, headers: String, body: Option<Vec<u8>>, error: Option<String>| {
                tasks.send(Task::HttpDone { id, status, headers, body, error }).ok();
            };
            let Ok(method) = reqwest::Method::from_bytes(method.as_bytes()) else {
                return done(0, "{}".into(), None, Some("Invalid method".into()));
            };
            let mut request = client.request(method, &url);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            if let Some(body) = body {
                request = request.body(body);
            }
            if timeout > 0.0 {
                request = request.timeout(Duration::from_millis(timeout as u64));
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let mut fields: HashMap<String, String> = HashMap::new();
                    for (name, value) in response.headers() {
                        let value = value.to_str().unwrap_or_default().to_string();
                        fields
                            .entry(name.as_str().to_lowercase())
                            .and_modify(|existing| {
                                existing.push_str(", ");
                                existing.push_str(&value);
                            })
                            .or_insert(value);
                    }
                    let headers = serde_json::to_string(&fields).unwrap_or_else(|_| "{}".into());
                    match response.bytes().await {
                        Ok(bytes) => done(status, headers, Some(bytes.to_vec()), None),
                        Err(error) => done(0, "{}".into(), None, Some(error.to_string())),
                    }
                }
                Err(error) => {
                    let error = error.without_url();
                    log::debug!(target: "core", "a request didn't go through: {}", describe_request_error(&error));
                    done(0, "{}".into(), None, Some(describe_request_error(&error)))
                }
            }
        });
        host.requests.insert(id, handle.abort_handle());
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "httpCancel", |c, h, a| {
        if let Some(handle) = h.borrow_mut().requests.remove(&(number_arg(&a, 0) as u32)) {
            handle.abort();
        }
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "wsOpen", |c, h, a| {
        let id = number_arg(&a, 0) as u32;
        let url = string_arg(&a, 1);
        let mut host = h.borrow_mut();
        let tasks = host.tasks.clone();
        let (commands, mut inbox) = unbounded_channel::<SocketCommand>();
        let handle = host.tokio.spawn(async move {
            let event = |kind: &'static str, data: Option<String>, code: u16| {
                tasks.send(Task::Socket { id, kind, data, code }).ok();
            };
            let connector = if url.starts_with("wss:") {
                tokio_tungstenite::Connector::Rustls(Arc::new(tls::client_config(&[b"http/1.1"])))
            } else {
                tokio_tungstenite::Connector::Plain
            };
            let config = WebSocketConfig::default().max_message_size(Some(16 << 20)).max_frame_size(Some(16 << 20));
            // Its own connection, through the proxy where there is one (net.rs), then TLS and the
            // WebSocket's handshake over it.
            let connecting = async {
                use tokio_tungstenite::tungstenite::client::IntoClientRequest;
                let request = url.as_str().into_client_request()?;
                let host = request.uri().host().unwrap_or_default().to_string();
                let port = request.uri().port_u16().unwrap_or(if url.starts_with("wss:") { 443 } else { 80 });
                let stream = super::net::tcp(&host, port).await.map_err(tokio_tungstenite::tungstenite::Error::Io)?;
                tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), Some(connector)).await
            };
            let stream = match tokio::time::timeout(Duration::from_secs(15), connecting).await {
                Ok(Ok((stream, _))) => stream,
                Ok(Err(error)) => {
                    log::debug!(target: "core", "socket {id} didn't open: {error}");
                    event("error", None, 0);
                    return event("close", None, 1006);
                }
                Err(_) => {
                    event("error", None, 0);
                    return event("close", None, 1006);
                }
            };
            event("open", None, 0);
            let (mut write, mut read) = stream.split();
            let mut closing = false;
            loop {
                tokio::select! {
                    message = read.next() => match message {
                        Some(Ok(Message::Text(text))) => event("message", Some(text.to_string()), 0),
                        Some(Ok(Message::Binary(bytes))) => event("message", Some(String::from_utf8_lossy(&bytes).into_owned()), 0),
                        Some(Ok(Message::Ping(payload))) => { write.send(Message::Pong(payload)).await.ok(); }
                        Some(Ok(Message::Close(frame))) => {
                            let code = frame.map(|frame| u16::from(frame.code)).unwrap_or(1005);
                            return event("close", None, code);
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => {
                            if !closing { event("error", None, 0); }
                            return event("close", None, if closing { 1000 } else { 1006 });
                        }
                    },
                    command = inbox.recv(), if !closing => match command {
                        Some(SocketCommand::Send(text)) => {
                            if write.send(Message::Text(text.into())).await.is_err() {
                                event("error", None, 0);
                                return event("close", None, 1006);
                            }
                        }
                        Some(SocketCommand::Close(code)) => {
                            closing = true;
                            let frame = CloseFrame { code: CloseCode::from(code), reason: "".into() };
                            write.send(Message::Close(Some(frame))).await.ok();
                            // The other end answers, or it doesn't, soon.
                            let answered = async {
                                while let Some(Ok(message)) = read.next().await {
                                    if let Message::Close(_) = message {
                                        break;
                                    }
                                }
                            };
                            tokio::time::timeout(Duration::from_secs(3), answered).await.ok();
                            return event("close", None, code);
                        }
                        None => {
                            write.send(Message::Close(None)).await.ok();
                            return;
                        }
                    },
                }
            }
        });
        host.sockets.insert(id, (commands, handle.abort_handle()));
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "wsSend", |c, h, a| {
        if let Some((socket, _)) = h.borrow().sockets.get(&(number_arg(&a, 0) as u32)) {
            socket.send(SocketCommand::Send(string_arg(&a, 1))).ok();
        }
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "wsClose", |c, h, a| {
        if let Some((socket, _)) = h.borrow().sockets.get(&(number_arg(&a, 0) as u32)) {
            socket.send(SocketCommand::Close(number_arg(&a, 1) as u16)).ok();
        }
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "pinServer", |c, h, a| Ok(boolean(&c, tls::add_pin(&string_arg(&a, 0), &string_arg(&a, 1)))));

    host_fn!(object, ctx, host, "fileSize", |c, h, a| {
        let size = std::fs::metadata(string_arg(&a, 0)).map(|meta| meta.len()).unwrap_or(0);
        Ok(number(&c, size as f64))
    });

    host_fn!(object, ctx, host, "fileRead", |c, h, a| {
        use std::io::{Read, Seek, SeekFrom};
        let path = string_arg(&a, 0);
        let start = number_arg(&a, 1).max(0.0) as u64;
        let end = number_arg(&a, 2).max(0.0) as u64;
        let mut file = std::fs::File::open(&path).map_err(|error| fail(&c, format!("Couldn't read the file: {error}")))?;
        file.seek(SeekFrom::Start(start)).map_err(|error| fail(&c, error.to_string()))?;
        let mut buffer = Vec::with_capacity(end.saturating_sub(start) as usize);
        file.take(end.saturating_sub(start)).read_to_end(&mut buffer).map_err(|error| fail(&c, error.to_string()))?;
        new_bytes(&c, buffer)
    });

    host_fn!(object, ctx, host, "fileAssemble", |c, h, a| {
        use std::io::Write;
        let extension: String = string_arg(&a, 1).chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        let name = format!("{}.{}", hex(&zuna_crypto::primitives::random_bytes(12).unwrap_or_default()), if extension.is_empty() { "bin".into() } else { extension });
        let path = h.borrow().files.join(name);
        let mut file = std::fs::File::create(&path).map_err(|error| fail(&c, format!("Couldn't save the file: {error}")))?;
        // What was written of a file that couldn't be finished goes.
        let written: rquickjs::Result<()> = (|| {
            if let Some(parts) = a.first().and_then(|value| value.as_array()) {
                for part in parts.iter::<Value>() {
                    let part = part?;
                    let bytes = read_bytes(&part).unwrap_or_default();
                    file.write_all(&bytes).map_err(|error| fail(&c, error.to_string()))?;
                }
            }
            Ok(())
        })();
        if let Err(error) = written {
            drop(file);
            std::fs::remove_file(&path).ok();
            return Err(error);
        }
        string(&c, &path.to_string_lossy())
    });

    // Link previews' pages and pictures, under the address rules every host keeps (web.rs).
    host_fn!(object, ctx, host, "webFetch", |c, h, a| {
        let id = number_arg(&a, 0) as u32;
        let url = string_arg(&a, 1);
        let max_bytes = (number_arg(&a, 2) as usize).clamp(1, 5 << 20);
        let (tasks, web, tokio) = {
            let host = h.borrow();
            (host.tasks.clone(), host.web.clone(), host.tokio.clone())
        };
        tokio.spawn(async move {
            let task = match super::web::fetch(&web, &url, max_bytes).await {
                Ok((url, mime, body)) => Task::WebDone { id, url, mime, body: Some(body), error: None },
                Err(error) => Task::WebDone { id, url, mime: String::new(), body: None, error: Some(error) },
            };
            tasks.send(task).ok();
        });
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "imageShrink", |c, h, a| {
        let bytes = bytes_arg(&a, 0);
        let max = number_arg(&a, 1).max(1.0) as u32;
        match shrink_image(&bytes, max) {
            Some((data, width, height)) => object_value(&c, data, width, height),
            None => Ok(Value::new_null(c)),
        }
    });

    install_telegram(ctx, &object, &host)?;
    ctx.globals().set("__zunaHost", object)?;
    Ok(())
}

/// A linked Telegram account's engine (docs/TELEGRAM_PLAN.md): started, asked and stopped by the
/// core's adapter, through the broker, which answers back through `__zunaTelegram`.
fn install_telegram<'js>(ctx: &Ctx<'js>, object: &Object<'js>, host: &Rc<RefCell<Host>>) -> Result<()> {
    object.set("telegramAvailable", crate::telegram::available())?;

    host_fn!(object, ctx, host, "telegramStart", |c, h, _a| {
        let engine = {
            let mut host = h.borrow_mut();
            if host.telegram.is_none() {
                let Some(device_key) = host.device_key.clone() else { return string(&c, "The core hasn't started.") };
                let tasks = host.tasks.clone();
                let deliver: crate::telegram::Deliver = Arc::new(move |json| {
                    tasks.send(Task::Telegram(json)).ok();
                });
                host.telegram = Some(crate::telegram::Engine::new(host.data_dir.clone(), device_key, deliver));
            }
            host.telegram.clone().expect("just made")
        };
        match engine.start() {
            Ok(()) => string(&c, ""),
            Err(why) => string(&c, &why),
        }
    });

    host_fn!(object, ctx, host, "telegramSend", |c, h, a| {
        let engine = h.borrow().telegram.clone();
        if let Some(engine) = engine {
            engine.send(&string_arg(&a, 0));
        }
        Ok(Value::new_undefined(c))
    });

    host_fn!(object, ctx, host, "telegramStop", |c, h, a| {
        let sign_out = bool_arg(&a, 0);
        let engine = h.borrow().telegram.clone();
        match engine {
            Some(engine) => engine.stop(sign_out),
            None if sign_out => {
                // Nothing running, so nothing at Telegram can be ended from here: what's on this
                // device goes all the same.
                let host = h.borrow();
                crate::telegram::erase(&host.data_dir);
                let stopped = serde_json::json!({ "@type": "zunaStopped", "erased": true, "signedOut": false });
                host.tasks.send(Task::Telegram(stopped.to_string())).ok();
            }
            None => {}
        }
        Ok(Value::new_undefined(c))
    });
    Ok(())
}

fn object_value<'js>(ctx: &Ctx<'js>, data: String, width: u32, height: u32) -> Result<Value<'js>> {
    object(ctx, vec![("data", string(ctx, &data)?), ("width", number(ctx, width as f64)), ("height", number(ctx, height as f64))])
}

pub(super) fn describe_request_error(error: &reqwest::Error) -> String {
    use std::error::Error;
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A picture shrunk to fit within `max` pixels, as a JPEG data URL.
pub fn shrink_image(bytes: &[u8], max: u32) -> Option<(String, u32, u32)> {
    let image = image::load_from_memory(bytes).ok()?;
    let image = if image.width() > max || image.height() > max { image.thumbnail(max, max) } else { image };
    let rgb = image.to_rgb8();
    let mut out = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    encoder.encode_image(&rgb).ok()?;
    Some((format!("data:image/jpeg;base64,{}", STANDARD.encode(&out)), rgb.width(), rgb.height()))
}
