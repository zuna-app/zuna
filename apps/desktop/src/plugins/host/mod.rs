//! The plugin host: the app's own executable, started as `zuna --plugin-host`, running one
//! plugin in a QuickJS runtime of its own. It loads no account, opens no database, reads no
//! file and reaches no network, and never holds the device key: everything it may do goes to
//! the broker in the app as a message on its standard output (protocol.rs). So a plugin that
//! breaks out of QuickJS, which is C and is brought code written to break it, lands in a
//! process with no keys and no messages but those it was sent.
//!
//! The runtime has a memory limit, a stack limit, and an interrupt handler that ends a script
//! which runs past its deadline without yielding. Going over the memory ends the process;
//! running too long is reported as a fault, and the app turns the plugin off after three.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use rquickjs::function::Rest;
use rquickjs::{Context, Ctx, Function, Runtime, TypedArray, Value};
use serde::Deserialize;
use serde_json::json;

use super::protocol::{MAX_FROM_HOST, MAX_TO_HOST, read_frame, write_frame};

const PRELUDE: &str = include_str!("prelude.js");
/// The most timers a plugin may have waiting at once.
const MAX_TIMERS: usize = 1000;

/// What the host is started with, the first message the app sends.
#[derive(Deserialize)]
pub struct Boot {
    pub t: String,
    #[serde(default)]
    pub source: Option<String>,
    pub limits: Limits,
}

#[derive(Clone, Copy, Deserialize)]
pub struct Limits {
    /// Bytes QuickJS may allocate.
    pub memory: usize,
    /// Bytes of stack a script may use.
    pub stack: usize,
    /// How long one piece of script may run without yielding, in milliseconds.
    pub slice_ms: u64,
}

/// Runs as `zuna --plugin-host`: reads the app's messages from standard input and writes its
/// own to standard output, until the app stops it or goes.
pub fn run() -> i32 {
    let (frames_tx, frames) = std::sync::mpsc::channel::<Option<String>>();
    std::thread::Builder::new()
        .name("plugin-pipe".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            loop {
                match read_frame(&mut input, MAX_TO_HOST) {
                    Ok(Some(frame)) => {
                        if frames_tx.send(Some(frame)).is_err() {
                            break;
                        }
                    }
                    _ => {
                        frames_tx.send(None).ok();
                        break;
                    }
                }
            }
        })
        .expect("the pipe's thread starts");
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    serve(frames, move |json| write_frame(&mut out, json).is_ok())
}

/// What a timer waits for.
struct Timer {
    due: Instant,
    period: Option<Duration>,
}

/// What the host functions share, all on this thread.
struct State {
    timers: HashMap<u32, Timer>,
}

/// Serves one plugin: `frames` brings the app's messages (None once it's gone), and `send` takes
/// the host's, saying whether they went. Tests run it on a thread, with channels for the pipe.
pub fn serve(frames: Receiver<Option<String>>, send: impl FnMut(&str) -> bool + 'static) -> i32 {
    let send = Rc::new(RefCell::new(send));
    let say = {
        let send = send.clone();
        move |message: serde_json::Value| {
            (send.borrow_mut())(&message.to_string());
        }
    };
    let boot = match frames.recv() {
        Ok(Some(frame)) => frame,
        _ => return 1,
    };
    let parsed: Boot = match serde_json::from_str::<Boot>(&boot) {
        Ok(boot) if boot.t == "boot" => boot,
        _ => {
            say(json!({ "t": "failed", "error": "The host wasn't started as the app starts it." }));
            return 1;
        }
    };
    let limits = parsed.limits;
    let Ok(runtime) = Runtime::new() else {
        say(json!({ "t": "failed", "error": "QuickJS didn't start." }));
        return 1;
    };
    runtime.set_memory_limit(limits.memory);
    runtime.set_max_stack_size(limits.stack);
    let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
    let interrupted = Rc::new(Cell::new(false));
    {
        let (deadline, interrupted) = (deadline.clone(), interrupted.clone());
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let over = deadline.get().is_some_and(|deadline| Instant::now() > deadline);
            if over {
                interrupted.set(true);
            }
            over
        })));
    }
    {
        let say = say.clone();
        runtime.set_host_promise_rejection_tracker(Some(Box::new(move |ctx, _promise, reason, handled| {
            if !handled {
                say(json!({ "t": "log", "level": "warn", "text": format!("Unhandled rejection: {}", describe(&ctx, &reason)) }));
            }
        })));
    }
    let Ok(context) = Context::full(&runtime) else {
        say(json!({ "t": "failed", "error": "QuickJS didn't start." }));
        return 1;
    };
    let state = Rc::new(RefCell::new(State { timers: HashMap::new() }));

    let slice = Duration::from_millis(limits.slice_ms.max(10));
    let begin = |deadline: &Cell<Option<Instant>>| deadline.set(Some(Instant::now() + slice));

    // The prelude, the boot message, then the plugin's own script, each within the deadline.
    begin(&deadline);
    let started = context.with(|ctx| -> Result<(), String> {
        install(&ctx, send.clone(), state.clone()).map_err(|_| "The host's functions didn't install.".to_string())?;
        ctx.eval::<(), _>(PRELUDE).map_err(|_| format!("The prelude didn't load: {}", exception(&ctx)))?;
        let receive: Function = ctx.globals().get("__zunaReceive").map_err(|_| "The prelude is broken.".to_string())?;
        receive.call::<_, ()>((boot.as_str(),)).map_err(|_| exception(&ctx))?;
        if let Some(source) = &parsed.source {
            ctx.eval::<(), _>(source.as_str()).map_err(|_| exception(&ctx))?;
        }
        let start: Function = ctx.globals().get("__zunaStart").map_err(|_| "The prelude is broken.".to_string())?;
        start.call::<_, ()>(()).map_err(|_| exception(&ctx))
    });
    drop(boot);
    drain(&runtime, &say);
    deadline.set(None);
    // A setup that ran past its deadline was ended: the plugin doesn't run.
    let started = if interrupted.get() { Err("Its script ran too long as it started.".to_string()) } else { started };
    if let Err(error) = started {
        let error = if interrupted.get() { "Its script ran too long as it started.".to_string() } else { error };
        say(json!({ "t": "failed", "error": error }));
        return 1;
    }
    if over_memory(&runtime, limits.memory) {
        say(json!({ "t": "fault", "reason": "memory" }));
        return 3;
    }

    loop {
        let next = state.borrow().timers.values().map(|timer| timer.due).min();
        let wait = next.map(|due| due.saturating_duration_since(Instant::now()));
        let frame = match wait {
            Some(wait) => match frames.recv_timeout(wait) {
                Ok(frame) => Some(frame),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return 0,
            },
            None => match frames.recv() {
                Ok(frame) => Some(frame),
                Err(_) => return 0,
            },
        };
        interrupted.set(false);
        match frame {
            Some(None) => return 0,
            Some(Some(json)) => {
                if json.len() < 64 && serde_json::from_str::<serde_json::Value>(&json).ok().and_then(|value| value.get("t").cloned()) == Some(json!("stop")) {
                    return 0;
                }
                begin(&deadline);
                context.with(|ctx| {
                    if let Ok(receive) = ctx.globals().get::<_, Function>("__zunaReceive") {
                        if receive.call::<_, ()>((json.as_str(),)).is_err() {
                            let problem = exception(&ctx);
                            say(json!({ "t": "log", "level": "error", "text": problem }));
                        }
                    }
                });
            }
            None => {
                // Every timer that's due, oldest first.
                let now = Instant::now();
                let mut due: Vec<(Instant, u32)> = state.borrow().timers.iter().filter(|(_, timer)| timer.due <= now).map(|(id, timer)| (timer.due, *id)).collect();
                due.sort();
                begin(&deadline);
                for (_, id) in due {
                    {
                        let mut state = state.borrow_mut();
                        let Some(timer) = state.timers.get_mut(&id) else { continue };
                        match timer.period {
                            Some(period) => timer.due = now.max(timer.due) + period,
                            None => {
                                state.timers.remove(&id);
                            }
                        }
                    }
                    context.with(|ctx| {
                        if let Ok(receive) = ctx.globals().get::<_, Function>("__zunaReceive") {
                            let message = json!({ "t": "event", "name": "timer", "data": { "id": id } }).to_string();
                            receive.call::<_, ()>((message.as_str(),)).ok();
                        }
                    });
                }
            }
        }
        drain(&runtime, &say);
        context.with(|ctx| {
            if let Ok(after) = ctx.globals().get::<_, Function>("__zunaAfter") {
                after.call::<_, ()>(()).ok();
            }
        });
        drain(&runtime, &say);
        deadline.set(None);
        if over_memory(&runtime, limits.memory) {
            say(json!({ "t": "fault", "reason": "memory" }));
            return 3;
        }
        if interrupted.get() {
            say(json!({ "t": "fault", "reason": "slow" }));
        }
    }
}

/// Whether the runtime is at its limit: a plugin that catches its out-of-memory errors would
/// otherwise go on at the edge of it.
fn over_memory(runtime: &Runtime, limit: usize) -> bool {
    let used = runtime.memory_usage().malloc_size.max(0) as usize;
    used + (256 << 10) >= limit
}

fn drain(runtime: &Runtime, say: &impl Fn(serde_json::Value)) {
    // A plugin's promises can make more of themselves forever; the deadline ends that too.
    for _ in 0..100_000 {
        match runtime.execute_pending_job() {
            Ok(true) => continue,
            Ok(false) => return,
            Err(error) => {
                let problem = error.0.with(|ctx| exception(&ctx));
                say(json!({ "t": "log", "level": "error", "text": problem }));
            }
        }
    }
}

fn describe<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> String {
    if let Some(exception) = value.as_exception() {
        return format!("{}\n{}", exception.message().unwrap_or_default(), exception.stack().unwrap_or_default()).trim().to_string();
    }
    ctx.json_stringify(value.clone()).ok().flatten().and_then(|text| text.to_string().ok()).unwrap_or_else(|| "something".into())
}

fn exception(ctx: &Ctx<'_>) -> String {
    let caught = ctx.catch();
    describe(ctx, &caught)
}

fn install<'js>(ctx: &Ctx<'js>, send: Rc<RefCell<impl FnMut(&str) -> bool + 'static>>, state: Rc<RefCell<State>>) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    globals.set(
        "__zunaSend",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, json: String| -> rquickjs::Result<()> {
            if json.len() > MAX_FROM_HOST {
                return Err(rquickjs::Exception::throw_range(&ctx, "That's more than a plugin may send at once."));
            }
            if !(send.borrow_mut())(&json) {
                return Err(rquickjs::Exception::throw_internal(&ctx, "The app is gone."));
            }
            Ok(())
        })?,
    )?;
    let timers = state.clone();
    globals.set(
        "__zunaSetTimer",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, id: u32, ms: f64, repeats: bool| -> rquickjs::Result<()> {
            let mut state = timers.borrow_mut();
            if state.timers.len() >= MAX_TIMERS {
                return Err(rquickjs::Exception::throw_range(&ctx, "Too many timers are waiting."));
            }
            let wait = Duration::from_millis(ms.clamp(0.0, 1e10) as u64);
            // A timer that repeats waits at least 10 ms, so one can't spin the process.
            let period = repeats.then(|| wait.max(Duration::from_millis(10)));
            state.timers.insert(id, Timer { due: Instant::now() + period.unwrap_or(wait), period });
            Ok(())
        })?,
    )?;
    globals.set(
        "__zunaClearTimer",
        Function::new(ctx.clone(), move |id: u32| {
            state.borrow_mut().timers.remove(&id);
        })?,
    )?;
    globals.set("__zunaUtf8Encode", Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| TypedArray::<u8>::new_copy(ctx, text.as_bytes()))?)?;
    globals.set(
        "__zunaUtf8Decode",
        Function::new(ctx.clone(), |Rest(args): Rest<Value<'js>>| -> String {
            let bytes = args.first().and_then(read_bytes).unwrap_or_default();
            String::from_utf8_lossy(&bytes).into_owned()
        })?,
    )?;
    Ok(())
}

/// The bytes of a typed array or an array buffer.
fn read_bytes(value: &Value<'_>) -> Option<Vec<u8>> {
    let object = value.as_object()?;
    // SAFETY (each as_bytes): no JavaScript runs while the slice is alive.
    if let Some(array) = object.as_typed_array::<u8>() {
        return unsafe { array.as_bytes() }.map(<[u8]>::to_vec);
    }
    if let Some(buffer) = object.as_array_buffer() {
        return unsafe { buffer.as_bytes() }.map(<[u8]>::to_vec);
    }
    None
}

#[cfg(test)]
pub fn spawn_for_test(boot: serde_json::Value) -> (std::sync::mpsc::Sender<Option<String>>, std::sync::mpsc::Receiver<serde_json::Value>, std::thread::JoinHandle<i32>) {
    let (to_host, frames) = std::sync::mpsc::channel::<Option<String>>();
    let (sent, from_host) = std::sync::mpsc::channel::<serde_json::Value>();
    to_host.send(Some(boot.to_string())).unwrap();
    let thread = std::thread::Builder::new()
        .stack_size(16 << 20)
        .spawn(move || serve(frames, move |json| sent.send(serde_json::from_str(json).unwrap_or(serde_json::Value::Null)).is_ok()))
        .unwrap();
    (to_host, from_host, thread)
}
