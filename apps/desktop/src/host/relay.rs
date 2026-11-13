//! The rewriting of LiveKit's signalling while a proxy is set (packages/core/src/voice-relay.ts),
//! written once in the core for every app: here in a QuickJS context of its own, on a thread of
//! its own, so that a busy core never holds a call's signalling up (voice/proxy.rs).

use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, OnceLock};

use futures::channel::oneshot;
use rquickjs::function::Rest;
use rquickjs::{Array, Context, Ctx, Function, Runtime, Value};

use super::js::{describe_exception, new_bytes, number_arg, read_bytes, string_arg};

const RELAY_BUNDLE: &str = include_str!("../../assets/core/zuna-relay.js");

/// Where the SDK is to reach one of LiveKit's candidates instead, given its protocol, address
/// and port: a relay on this device, or None to leave it out.
pub type RelayFor = Arc<dyn Fn(&str, &str, u16) -> Option<(String, u16)> + Send + Sync>;

/// A message as it goes on, or why it doesn't.
pub type Rewritten = Result<Vec<u8>, String>;

enum Job {
    From(Vec<u8>, RelayFor, oneshot::Sender<Rewritten>),
    To(Vec<u8>, oneshot::Sender<Rewritten>),
    Join(String, oneshot::Sender<Result<String, String>>),
}

/// The rewriting thread, started the first time it's needed.
fn jobs() -> &'static Sender<Job> {
    static JOBS: OnceLock<Sender<Job>> = OnceLock::new();
    JOBS.get_or_init(|| {
        let (jobs, inbox) = channel::<Job>();
        std::thread::Builder::new()
            .name("zuna-relay".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let runtime = Runtime::new().expect("QuickJS starts");
                let context = Context::full(&runtime).expect("a QuickJS context");
                context.with(|ctx| {
                    if ctx.eval::<(), _>(RELAY_BUNDLE).is_err() {
                        log::error!("the relay's bundle didn't load: {}", describe_exception(&ctx));
                    }
                });
                while let Ok(job) = inbox.recv() {
                    context.with(|ctx| run(&ctx, job));
                }
            })
            .expect("the relay's thread starts");
        jobs
    })
}

/// What a rewriting function answered: the message, or, as a string, why it was dropped.
fn answer(value: &Value<'_>) -> Rewritten {
    if let Some(reason) = value.as_string() {
        return Err(reason.to_string().unwrap_or_default());
    }
    read_bytes(value).ok_or_else(|| "the relay gave nothing back".to_string())
}

fn run<'js>(ctx: &Ctx<'js>, job: Job) {
    match job {
        Job::From(message, relay_for, done) => {
            let result = (|| -> rquickjs::Result<Rewritten> {
                let rewrite: Function = ctx.globals().get("__zunaRelayFrom")?;
                let callback = Function::new(ctx.clone(), move |c: Ctx<'js>, Rest(args): Rest<Value<'js>>| -> rquickjs::Result<Value<'js>> {
                    let port = number_arg(&args, 2);
                    let relay = if (0. ..=65535.).contains(&port) { relay_for(&string_arg(&args, 0), &string_arg(&args, 1), port as u16) } else { None };
                    match relay {
                        Some((address, port)) => {
                            let pair = Array::new(c.clone())?;
                            pair.set(0, address)?;
                            pair.set(1, port as f64)?;
                            Ok(pair.into_value())
                        }
                        None => Ok(Value::new_null(c)),
                    }
                })?;
                let value: Value = rewrite.call((new_bytes(ctx, &message)?, callback))?;
                Ok(answer(&value))
            })();
            done.send(result.unwrap_or_else(|_| Err(describe_exception(ctx)))).ok();
        }
        Job::To(message, done) => {
            let result = (|| -> rquickjs::Result<Rewritten> {
                let rewrite: Function = ctx.globals().get("__zunaRelayTo")?;
                let value: Value = rewrite.call((new_bytes(ctx, &message)?,))?;
                Ok(answer(&value))
            })();
            done.send(result.unwrap_or_else(|_| Err(describe_exception(ctx)))).ok();
        }
        Job::Join(url, done) => {
            let result = (|| -> rquickjs::Result<String> {
                let rewrite: Function = ctx.globals().get("__zunaRelayJoin")?;
                rewrite.call((url,))
            })();
            done.send(result.map_err(|_| describe_exception(ctx))).ok();
        }
    }
}

async fn ask<T>(job: impl FnOnce(oneshot::Sender<Result<T, String>>) -> Job) -> Result<T, String> {
    let (done, answer) = oneshot::channel();
    jobs().send(job(done)).map_err(|_| "the relay's thread stopped".to_string())?;
    answer.await.map_err(|_| "the relay's thread stopped".to_string())?
}

/// A message from LiveKit as its SDK is to see it: no STUN or TURN server, nowhere else to
/// try, and each of LiveKit's candidates at the relay `relay_for` gives.
pub async fn from_livekit(message: Vec<u8>, relay_for: RelayFor) -> Rewritten {
    ask(|done| Job::From(message, relay_for, done)).await
}

/// A message from the SDK as LiveKit is to see it: no candidate of this device's in it.
pub async fn to_livekit(message: Vec<u8>) -> Rewritten {
    ask(|done| Job::To(message, done)).await
}

/// The address the SDK joins by, with no candidate in the join request it carries.
pub async fn join_address(url: String) -> Result<String, String> {
    ask(|done| Job::Join(url, done)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `SignalResponse` holding a trickled candidate, as LiveKit sends one: field 4, a
    /// `TrickleRequest` whose field 1 is the candidate as JSON.
    fn trickle(candidate: &str) -> Vec<u8> {
        let json = format!(r#"{{"candidate":"{candidate}","sdpMid":"0","sdpMLineIndex":0}}"#);
        let mut inner = vec![0x0a, json.len() as u8];
        inner.extend_from_slice(json.as_bytes());
        let mut message = vec![0x22, inner.len() as u8];
        message.extend(inner);
        message
    }

    #[test]
    fn rewrites_through_the_cores_own_code() {
        crate::host::tokio().block_on(async {
            let relay_for: RelayFor = Arc::new(|protocol, address, port| {
                assert_eq!((protocol, address, port), ("udp", "203.0.113.5", 7882));
                Some(("127.0.0.1".into(), 41000))
            });
            let rewritten = from_livekit(trickle("candidate:1 1 udp 2130706431 203.0.113.5 7882 typ host"), relay_for.clone()).await.unwrap();
            let text = String::from_utf8_lossy(&rewritten).to_string();
            assert!(text.contains("candidate:1 1 udp 2130706431 127.0.0.1 41000 typ host"), "{text}");
            assert!(!text.contains("203.0.113.5"));
            // No relay, no candidate.
            let none: RelayFor = Arc::new(|_, _, _| None);
            assert_eq!(from_livekit(trickle("candidate:1 1 udp 2130706431 203.0.113.5 7882 typ host"), none).await.unwrap_err(), "a candidate of LiveKit's with no relay");
            // The device's own candidates go nowhere: a SignalRequest's trickle is field 3.
            let mut own = trickle("candidate:2 1 udp 2122260223 192.168.1.20 51234 typ host");
            own[0] = 0x1a;
            assert_eq!(to_livekit(own).await.unwrap_err(), "a candidate of this device's");
            assert!(from_livekit(vec![0x9a, 0x06, 0x01, 0x00], relay_for).await.unwrap_err().contains("doesn't know"));
            assert_eq!(join_address("ws://127.0.0.1:7880/rtc?access_token=x".into()).await.unwrap(), "ws://127.0.0.1:7880/rtc?access_token=x");
        });
    }
}
