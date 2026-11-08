//! Notifications on Linux are the system's, as the Electron app showed them there, through
//! `org.freedesktop.Notifications`, with the same calls as the cards Windows gets in
//! `ui/notifications.rs`: a click opens the chat, and one is taken back when its chat is read
//! or its message deleted. Do Not Disturb is the notification server's own; the app only
//! asks it whether to play its sound (`inhibited`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{App, AppContext, Context, Entity, WeakEntity};
use zbus::MatchRule;
use zbus::blocking::MessageIterator;
use zbus::zvariant::{OwnedValue, StructureBuilder, Value};

use crate::state::AppState;

pub use crate::platform::notification::{Payload, Picture};

/// Whether the notification server holds notifications back, as for Do Not Disturb.
static INHIBITED: AtomicBool = AtomicBool::new(false);

pub fn inhibited() -> bool {
    INHIBITED.load(Ordering::Relaxed)
}

/// What's asked of the notification server, on a thread of its own.
enum Request {
    Show { local: u64, payload: Payload },
    Close(u32),
}

/// What the notification server said.
enum Heard {
    Shown { local: u64, id: u32 },
    Clicked(u32),
    Token(u32, String),
    Closed(u32),
}

pub struct NotificationCenter {
    state: WeakEntity<AppState>,
    /// Shown, by the server's ID.
    shown: Vec<(u32, Payload)>,
    /// Asked for, until the server gives its ID, and whether it's been taken back since.
    waiting: HashMap<u64, (Payload, bool)>,
    next: u64,
    requests: Option<Sender<Request>>,
}

#[derive(Clone)]
struct CenterGlobal(Entity<NotificationCenter>);

impl gpui::Global for CenterGlobal {}

pub fn center(cx: &App) -> Option<Entity<NotificationCenter>> {
    cx.try_global::<CenterGlobal>().map(|global| global.0.clone())
}

pub fn install(state: WeakEntity<AppState>, cx: &mut App) {
    let (heard, mut hearing) = unbounded::<Heard>();
    let requests = super::bus::session().map(|bus| {
        listen(bus, heard.clone());
        let (requests, asked) = channel::<Request>();
        std::thread::Builder::new()
            .name("zuna-notifications".into())
            .spawn(move || {
                for request in asked {
                    match request {
                        Request::Show { local, payload } => match notify(bus, &payload) {
                            Ok(id) => {
                                heard.unbounded_send(Heard::Shown { local, id }).ok();
                            }
                            Err(error) => log::warn!("the notification wasn't shown: {error}"),
                        },
                        Request::Close(id) => {
                            bus.call_method(Some("org.freedesktop.Notifications"), "/org/freedesktop/Notifications", Some("org.freedesktop.Notifications"), "CloseNotification", &(id,)).ok();
                        }
                    }
                }
            })
            .ok();
        requests
    });
    let center = cx.new(|_| NotificationCenter { state, shown: Vec::new(), waiting: HashMap::new(), next: 1, requests });
    cx.set_global(CenterGlobal(center.clone()));
    cx.spawn(async move |cx| {
        while let Some(heard) = hearing.next().await {
            center.update(cx, |center, cx| center.heard(heard, cx));
        }
    })
    .detach();
}

/// Listens for clicks, activation tokens and closing, and for Do Not Disturb changing.
fn listen(bus: &'static zbus::blocking::Connection, heard: UnboundedSender<Heard>) {
    std::thread::Builder::new()
        .name("zuna-notifications-heard".into())
        .spawn(move || {
            let inhibited = bus
                .call_method(Some("org.freedesktop.Notifications"), "/org/freedesktop/Notifications", Some("org.freedesktop.DBus.Properties"), "Get", &("org.freedesktop.Notifications", "Inhibited"))
                .and_then(|reply| reply.body().deserialize::<OwnedValue>());
            if let Ok(value) = inhibited {
                if let Ok(on) = bool::try_from(&*value) {
                    INHIBITED.store(on, Ordering::Relaxed);
                }
            }
            let Ok(rule) = MatchRule::builder().msg_type(zbus::message::Type::Signal).path("/org/freedesktop/Notifications").map(|rule| rule.build()) else { return };
            let Ok(signals) = MessageIterator::for_match_rule(rule, bus, Some(64)) else { return };
            for message in signals.flatten() {
                let header = message.header();
                let Some(member) = header.member() else { continue };
                let body = message.body();
                let said = match member.as_str() {
                    "ActionInvoked" => body.deserialize::<(u32, String)>().ok().filter(|(_, action)| action == "default").map(|(id, _)| Heard::Clicked(id)),
                    "ActivationToken" => body.deserialize::<(u32, String)>().ok().map(|(id, token)| Heard::Token(id, token)),
                    "NotificationClosed" => body.deserialize::<(u32, u32)>().ok().map(|(id, _)| Heard::Closed(id)),
                    "PropertiesChanged" => {
                        if let Ok((_, changed, _)) = body.deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>() {
                            if let Some(on) = changed.get("Inhibited").and_then(|value| bool::try_from(&**value).ok()) {
                                INHIBITED.store(on, Ordering::Relaxed);
                            }
                        }
                        None
                    }
                    _ => None,
                };
                if let Some(said) = said {
                    if heard.unbounded_send(said).is_err() {
                        break;
                    }
                }
            }
        })
        .ok();
}

/// Text as plain text, as the notification server reads markup in a body and what's shown
/// came from someone else.
fn escaped(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The picture as the server takes it, in RGBA rows (`notification::drawn`).
fn image_data(picture: Option<&Picture>) -> Option<Value<'static>> {
    let image = crate::platform::notification::drawn(picture)?;
    let (width, height) = (image.width() as i32, image.height() as i32);
    let structure = StructureBuilder::new()
        .add_field(width)
        .add_field(height)
        .add_field(width * 4)
        .add_field(true)
        .add_field(8i32)
        .add_field(4i32)
        .add_field(image.into_raw())
        .build()
        .ok()?;
    Some(Value::Structure(structure))
}

fn notify(bus: &zbus::blocking::Connection, payload: &Payload) -> zbus::Result<u32> {
    let mut hints: HashMap<&str, Value> = HashMap::from([
        ("desktop-entry", Value::from(crate::platform::APP_ID)),
        // The app plays its own, as on Windows.
        ("suppress-sound", Value::from(true)),
        ("category", Value::from("im.received")),
    ]);
    if let Some(image) = image_data(payload.picture.as_ref()) {
        hints.insert("image-data", image);
    }
    let actions = vec!["default", "Open"];
    let reply = bus.call_method(
        Some("org.freedesktop.Notifications"),
        "/org/freedesktop/Notifications",
        Some("org.freedesktop.Notifications"),
        "Notify",
        &("Zuna", 0u32, "", escaped(&payload.title), escaped(&payload.body), actions, hints, -1i32),
    )?;
    reply.body().deserialize::<u32>()
}

impl NotificationCenter {
    /// Shows one.
    pub fn show(&mut self, payload: Payload, _reduce_motion: bool, _cx: &mut Context<Self>) {
        let Some(requests) = &self.requests else { return };
        let local = self.next;
        self.next += 1;
        self.waiting.insert(local, (payload.clone(), false));
        requests.send(Request::Show { local, payload }).ok();
    }

    /// Takes back notifications matching everything given: a server's, read chats', or one message's.
    pub fn clear(&mut self, server_id: Option<&str>, keys: Option<&[String]>, message_id: Option<&str>, _cx: &mut Context<Self>) {
        let matches = |payload: &Payload| {
            server_id.is_none_or(|id| payload.server_id == id) && keys.is_none_or(|keys| keys.contains(&payload.key)) && message_id.is_none_or(|id| payload.message_id == id)
        };
        for (payload, cleared) in self.waiting.values_mut() {
            if matches(payload) {
                *cleared = true;
            }
        }
        let gone: Vec<u32> = self.shown.iter().filter(|(_, payload)| matches(payload)).map(|(id, _)| *id).collect();
        self.shown.retain(|(id, _)| !gone.contains(id));
        if let Some(requests) = &self.requests {
            for id in gone {
                requests.send(Request::Close(id)).ok();
            }
        }
    }

    fn heard(&mut self, heard: Heard, cx: &mut Context<Self>) {
        match heard {
            Heard::Shown { local, id } => {
                let Some((payload, cleared)) = self.waiting.remove(&local) else { return };
                if cleared {
                    if let Some(requests) = &self.requests {
                        requests.send(Request::Close(id)).ok();
                    }
                } else {
                    self.shown.push((id, payload));
                }
            }
            Heard::Token(id, token) => {
                if self.shown.iter().any(|(shown, _)| *shown == id) {
                    super::set_activation_token(token);
                }
            }
            Heard::Clicked(id) => {
                let Some(position) = self.shown.iter().position(|(shown, _)| *shown == id) else { return };
                let (_, payload) = self.shown.remove(position);
                // As a click on Windows's card opens it.
                crate::platform::later(cx, crate::platform::show_main);
                if let Some(state) = self.state.upgrade() {
                    state.update(cx, |state, cx| {
                        state.select_server(&payload.server_id, cx);
                        state.select_conversation(Some(payload.key.clone()), cx);
                    });
                }
            }
            Heard::Closed(id) => self.shown.retain(|(shown, _)| *shown != id),
        }
    }
}
