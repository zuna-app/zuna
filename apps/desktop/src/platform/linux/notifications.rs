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
    /// The server wouldn't show it.
    Failed(u64),
    Clicked(u32),
    Token(u32, String),
    Closed(u32),
}

/// How many shown notifications are followed, for their clicks and for taking them back.
const SHOWN_KEPT: usize = 100;

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
                            Err(error) => {
                                log::warn!("the notification wasn't shown: {error}");
                                heard.unbounded_send(Heard::Failed(local)).ok();
                            }
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

/// What `Notify` is given: the app's name, the ID of none it replaces, no icon by name, the
/// title and body, the actions, the hints, and the server's own timeout.
type Notify = (&'static str, u32, &'static str, String, String, Vec<&'static str>, HashMap<&'static str, Value<'static>>, i32);

fn notify_arguments(payload: &Payload) -> Notify {
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
    ("Zuna", 0u32, "", escaped(&payload.title), escaped(&payload.body), actions, hints, -1i32)
}

fn notify(bus: &zbus::blocking::Connection, payload: &Payload) -> zbus::Result<u32> {
    let reply = bus.call_method(Some("org.freedesktop.Notifications"), "/org/freedesktop/Notifications", Some("org.freedesktop.Notifications"), "Notify", &notify_arguments(payload))?;
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
                    // A server that keeps notifications in its history may never say one closed,
                    // so only the newest are followed.
                    if self.shown.len() > SHOWN_KEPT {
                        self.shown.remove(0);
                    }
                }
            }
            Heard::Failed(local) => {
                self.waiting.remove(&local);
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

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use std::sync::Arc;
    use std::sync::mpsc::Receiver;

    fn payload(server_id: &str, key: &str, message_id: &str) -> Payload {
        Payload {
            title: "Ann".into(),
            body: "Hi".into(),
            server_id: server_id.into(),
            key: key.into(),
            message_id: message_id.into(),
            kind: "message".into(),
            picture: None,
            can_reply: false,
            wait_for_input: true,
        }
    }

    fn photo() -> Picture {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(40, 40, image::Rgba([0, 90, 200, 255])).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        Picture { image: Some(Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes.into_inner()))), initials: "A".into(), seed: "ann".into() }
    }

    /// The picture's width, height, row length, alpha, bits, channels and pixels.
    fn image_fields(value: &Value) -> (i32, i32, i32, bool, i32, i32, Vec<u8>) {
        let Value::Structure(structure) = value else { panic!("the picture is a structure: {value:?}") };
        let fields = structure.fields();
        assert_eq!(fields.len(), 7);
        let number = |at: usize| i32::try_from(&fields[at]).unwrap();
        let bytes = match &fields[6] {
            Value::Array(array) => array.inner().iter().map(|byte| u8::try_from(byte).unwrap()).collect(),
            other => panic!("the pixels are bytes: {other:?}"),
        };
        (number(0), number(1), number(2), bool::try_from(&fields[3]).unwrap(), number(4), number(5), bytes)
    }

    #[test]
    fn shows_text_as_plain_text() {
        assert_eq!(escaped("<b>Ann</b> & co"), "&lt;b&gt;Ann&lt;/b&gt; &amp; co");
        assert_eq!(escaped("&lt;"), "&amp;lt;");
        assert_eq!(escaped("Hi there"), "Hi there");
    }

    #[test]
    fn hands_the_picture_over_in_rgba_rows() {
        for picture in [None, Some(photo())] {
            let value = image_data(picture.as_ref()).expect("there's a picture");
            let (width, height, row, alpha, bits, channels, bytes) = image_fields(&value);
            assert_eq!((width, height, row, alpha, bits, channels), (128, 128, 128 * 4, true, 8, 4));
            assert_eq!(bytes.len(), 128 * 128 * 4);
            let drawn = crate::platform::notification::drawn(picture.as_ref()).unwrap();
            assert!(bytes == drawn.into_raw());
        }
    }

    #[test]
    fn asks_for_a_notification_that_opens_the_chat() {
        let mut said = payload("server", "chat", "message");
        said.title = "<i>Ann</i>".into();
        said.body = "1 < 2 & 3 > 2".into();
        let (app, replaces, icon, title, body, actions, hints, timeout) = notify_arguments(&said);
        assert_eq!((app, replaces, icon, timeout), ("Zuna", 0, "", -1));
        assert_eq!(title, "&lt;i&gt;Ann&lt;/i&gt;");
        assert_eq!(body, "1 &lt; 2 &amp; 3 &gt; 2");
        assert_eq!(actions, ["default", "Open"]);
        let mut keys: Vec<&str> = hints.keys().copied().collect();
        keys.sort();
        assert_eq!(keys, ["category", "desktop-entry", "image-data", "suppress-sound"]);
        assert_eq!(hints["desktop-entry"], Value::from("zuna"));
        assert_eq!(hints["suppress-sound"], Value::from(true));
        assert_eq!(hints["category"], Value::from("im.received"));
        // Without a picture of the chat, the app's icon.
        let icon = crate::platform::app_icon(128).into_raw();
        assert!(image_fields(&hints["image-data"]).6 == icon);

        said.picture = Some(photo());
        let (.., hints, _) = notify_arguments(&said);
        let pixels = image_fields(&hints["image-data"]).6;
        assert!(pixels != icon);
        assert_eq!(&pixels[64 * 128 * 4 + 64 * 4..][..4], [0, 90, 200, 255]);
    }

    /// A center whose requests come here rather than to a notification server.
    fn center(cx: &mut TestAppContext) -> (Entity<NotificationCenter>, Receiver<Request>) {
        let (requests, asked) = channel();
        let center = cx.new(|_| NotificationCenter { state: WeakEntity::new_invalid(), shown: Vec::new(), waiting: HashMap::new(), next: 1, requests: Some(requests) });
        (center, asked)
    }

    fn closed(asked: &Receiver<Request>) -> Vec<u32> {
        asked.try_iter().filter_map(|request| if let Request::Close(id) = request { Some(id) } else { None }).collect()
    }

    /// Shows one, and has the server give it an ID.
    fn shown(center: &Entity<NotificationCenter>, asked: &Receiver<Request>, id: u32, payload: Payload, cx: &mut TestAppContext) {
        center.update(cx, |center, cx| center.show(payload, false, cx));
        let Ok(Request::Show { local, .. }) = asked.try_recv() else { panic!("it's asked for") };
        center.update(cx, |center, cx| center.heard(Heard::Shown { local, id }, cx));
    }

    #[gpui::test]
    fn takes_back_what_matches_everything_given(cx: &mut TestAppContext) {
        let (center, asked) = center(cx);
        shown(&center, &asked, 1, payload("one", "a", "m1"), cx);
        shown(&center, &asked, 2, payload("one", "b", "m2"), cx);
        shown(&center, &asked, 3, payload("two", "a", "m3"), cx);
        shown(&center, &asked, 4, payload("two", "c", "m4"), cx);

        center.update(cx, |center, cx| center.clear(Some("one"), Some(&["a".to_string()]), None, cx));
        assert_eq!(closed(&asked), [1]);
        center.update(cx, |center, cx| center.clear(None, None, Some("m4"), cx));
        assert_eq!(closed(&asked), [4]);
        // Gone already, so not asked again.
        center.update(cx, |center, cx| center.clear(Some("one"), Some(&["a".to_string()]), None, cx));
        assert_eq!(closed(&asked), Vec::<u32>::new());
        center.update(cx, |center, cx| center.clear(Some("one"), None, None, cx));
        assert_eq!(closed(&asked), [2]);
        center.update(cx, |center, cx| center.clear(None, Some(&["a".to_string(), "c".to_string()]), None, cx));
        assert_eq!(closed(&asked), [3]);
        center.read_with(cx, |center, _| assert!(center.shown.is_empty()));
    }

    #[gpui::test]
    fn takes_back_one_cleared_while_it_waited_for_its_id(cx: &mut TestAppContext) {
        let (center, asked) = center(cx);
        center.update(cx, |center, cx| {
            center.show(payload("one", "a", "m1"), false, cx);
            center.show(payload("one", "b", "m2"), false, cx);
        });
        let locals: Vec<u64> = asked.try_iter().filter_map(|request| if let Request::Show { local, .. } = request { Some(local) } else { None }).collect();
        assert_eq!(locals, [1, 2]);
        center.update(cx, |center, cx| center.clear(None, Some(&["a".to_string()]), None, cx));
        center.read_with(cx, |center, _| {
            assert!(center.waiting[&1].1, "the first is cleared");
            assert!(!center.waiting[&2].1, "the second isn't");
        });
        assert_eq!(closed(&asked), Vec::<u32>::new());

        center.update(cx, |center, cx| {
            center.heard(Heard::Shown { local: 1, id: 10 }, cx);
            center.heard(Heard::Shown { local: 2, id: 11 }, cx);
        });
        assert_eq!(closed(&asked), [10]);
        center.read_with(cx, |center, _| {
            assert!(center.waiting.is_empty());
            assert_eq!(center.shown.iter().map(|(id, _)| *id).collect::<Vec<_>>(), [11]);
        });
    }

    #[gpui::test]
    fn forgets_what_failed_closed_or_was_clicked(cx: &mut TestAppContext) {
        let (center, asked) = center(cx);
        center.update(cx, |center, cx| center.show(payload("one", "a", "m1"), false, cx));
        center.update(cx, |center, cx| center.heard(Heard::Failed(1), cx));
        center.read_with(cx, |center, _| assert!(center.waiting.is_empty()));

        shown(&center, &asked, 5, payload("one", "a", "m2"), cx);
        shown(&center, &asked, 6, payload("one", "b", "m3"), cx);
        center.update(cx, |center, cx| center.heard(Heard::Closed(5), cx));
        center.update(cx, |center, cx| center.heard(Heard::Clicked(6), cx));
        center.read_with(cx, |center, _| assert!(center.shown.is_empty()));
        // Nothing left to take back.
        center.update(cx, |center, cx| center.clear(Some("one"), None, None, cx));
        assert_eq!(closed(&asked), Vec::<u32>::new());
    }

    #[gpui::test]
    fn follows_only_the_newest_shown(cx: &mut TestAppContext) {
        let (center, asked) = center(cx);
        for id in 0..SHOWN_KEPT as u32 + 5 {
            shown(&center, &asked, id, payload("one", "a", &format!("m{id}")), cx);
        }
        center.read_with(cx, |center, _| {
            assert_eq!(center.shown.len(), SHOWN_KEPT);
            assert_eq!(center.shown[0].0, 5);
        });
    }
}
