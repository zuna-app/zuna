//! Stand-ins for the desktop's own services, on the check's session bus: a notification
//! server, a StatusNotifierWatcher with a host that reads the tray's item and clicks it, and
//! a listener for the badge. What the app asks of them comes out as `{"event": ...}` lines.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Value as Json, json};
use zbus::blocking::{Connection, MessageIterator};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{MatchRule, interface};

/// Says what happened, a line of JSON among the driver's answers.
pub fn event(value: Json) {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{}", json!({ "event": value })).ok();
    out.flush().ok();
}

struct Notifications {
    next: u32,
    inhibited: bool,
}

/// The `image-data` hint's picture: its size, and its RGBA rows in hex.
fn image(value: &Value) -> Option<Json> {
    let Value::Structure(structure) = value else { return None };
    let fields = structure.fields();
    let number = |index: usize| match fields.get(index) {
        Some(Value::I32(number)) => Some(*number),
        _ => None,
    };
    let Some(Value::Array(bytes)) = fields.get(6) else { return None };
    let hex: String = bytes.iter().filter_map(|byte| if let Value::U8(byte) = byte { Some(format!("{byte:02x}")) } else { None }).collect();
    Some(json!({ "width": number(0)?, "height": number(1)?, "stride": number(2)?, "channels": number(5)?, "hex": hex }))
}

#[interface(name = "org.freedesktop.Notifications")]
impl Notifications {
    #[allow(clippy::too_many_arguments)]
    fn notify(&mut self, app_name: String, _replaces_id: u32, _app_icon: String, summary: String, body: String, actions: Vec<String>, hints: HashMap<String, OwnedValue>, _expire_timeout: i32) -> u32 {
        self.next += 1;
        let hint = |name: &str| hints.get(name).map(|value| format!("{:?}", &**value));
        event(json!({
            "notified": {
                "id": self.next,
                "app": app_name,
                "summary": summary,
                "body": body,
                "actions": actions,
                "desktopEntry": hints.get("desktop-entry").and_then(|value| String::try_from(value.try_clone().ok()?).ok()),
                "suppressSound": hints.get("suppress-sound").and_then(|value| bool::try_from(&**value).ok()),
                "image": hints.get("image-data").and_then(|value| image(value)),
                "category": hint("category"),
            }
        }));
        self.next
    }

    fn close_notification(&mut self, id: u32) {
        event(json!({ "closed": id }));
    }

    fn get_capabilities(&self) -> Vec<String> {
        vec!["body".into(), "actions".into(), "body-markup".into(), "icon-static".into()]
    }

    fn get_server_information(&self) -> (String, String, String, String) {
        ("Zuna checks".into(), "Zuna".into(), "1".into(), "1.2".into())
    }

    #[zbus(property)]
    fn inhibited(&self) -> bool {
        self.inhibited
    }

    #[zbus(signal)]
    async fn action_invoked(emitter: &SignalEmitter<'_>, id: u32, action_key: &str) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn activation_token(emitter: &SignalEmitter<'_>, id: u32, token: &str) -> zbus::Result<()>;
}

struct Watcher {
    items: Vec<String>,
}

#[interface(name = "org.kde.StatusNotifierWatcher")]
impl Watcher {
    fn register_status_notifier_item(&mut self, service: String, #[zbus(header)] header: zbus::message::Header<'_>) {
        // An item gives its bus name, or its path on the caller's own.
        let service = if service.starts_with('/') { format!("{}{service}", header.sender().map(|sender| sender.to_string()).unwrap_or_default()) } else { service };
        event(json!({ "trayRegistered": service }));
        self.items.push(service);
    }

    fn register_status_notifier_host(&mut self, _service: String) {}

    #[zbus(property)]
    fn registered_status_notifier_items(&self) -> Vec<String> {
        self.items.clone()
    }

    #[zbus(property)]
    fn is_status_notifier_host_registered(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn protocol_version(&self) -> i32 {
        0
    }
}

pub struct Services {
    connection: Connection,
}

/// The tray's item: its bus name and object path.
fn tray_item(connection: &Connection) -> Result<(String, String), String> {
    let watcher = connection.object_server().interface::<_, Watcher>("/StatusNotifierWatcher").map_err(|error| error.to_string())?;
    let item = watcher.get().items.last().cloned().ok_or("no tray item")?;
    Ok(match item.split_once('/') {
        Some((name, path)) => (name.to_string(), format!("/{path}")),
        None => (item, "/StatusNotifierItem".into()),
    })
}

impl Services {
    /// Takes the services' names and listens for the badge.
    pub fn start() -> Result<Services, String> {
        let connection = zbus::blocking::connection::Builder::session()
            .and_then(|builder| builder.name("org.freedesktop.Notifications"))
            .and_then(|builder| builder.name("org.kde.StatusNotifierWatcher"))
            .and_then(|builder| builder.serve_at("/org/freedesktop/Notifications", Notifications { next: 0, inhibited: false }))
            .and_then(|builder| builder.serve_at("/StatusNotifierWatcher", Watcher { items: Vec::new() }))
            .and_then(|builder| builder.build())
            .map_err(|error| error.to_string())?;
        let listener = connection.clone();
        std::thread::spawn(move || {
            let Ok(rule) = MatchRule::builder().msg_type(zbus::message::Type::Signal).interface("com.canonical.Unity.LauncherEntry").map(|rule| rule.build()) else { return };
            let Ok(signals) = MessageIterator::for_match_rule(rule, &listener, Some(64)) else { return };
            for message in signals.flatten() {
                if let Ok((app, properties)) = message.body().deserialize::<(String, HashMap<String, OwnedValue>)>() {
                    let count = properties.get("count").and_then(|value| i64::try_from(&**value).ok());
                    let visible = properties.get("count-visible").and_then(|value| bool::try_from(&**value).ok());
                    event(json!({ "badge": { "app": app, "count": count, "visible": visible } }));
                }
            }
        });
        Ok(Services { connection })
    }

    pub fn run(&self, command: &Json) -> Result<Json, String> {
        let text = |name: &str| command.get(name).and_then(Json::as_str).unwrap_or_default().to_string();
        match command.get("do").and_then(Json::as_str).unwrap_or_default() {
            // A click on a notification, as KDE's server sends it: a token, then the action.
            "invoke" => {
                let id = command.get("id").and_then(Json::as_u64).ok_or("invoke needs id")? as u32;
                let notifications = self.connection.object_server().interface::<_, Notifications>("/org/freedesktop/Notifications").map_err(|error| error.to_string())?;
                let emitter = notifications.signal_emitter();
                zbus::block_on(async {
                    Notifications::activation_token(emitter, id, "check-token").await?;
                    Notifications::action_invoked(emitter, id, "default").await
                })
                .map_err(|error| error.to_string())?;
            }
            "inhibit" => {
                let on = command.get("on").and_then(Json::as_bool).unwrap_or(true);
                let notifications = self.connection.object_server().interface::<_, Notifications>("/org/freedesktop/Notifications").map_err(|error| error.to_string())?;
                notifications.get_mut().inhibited = on;
                zbus::block_on(notifications.get().inhibited_changed(notifications.signal_emitter())).map_err(|error| error.to_string())?;
            }
            "tray" => {
                let (name, path) = tray_item(&self.connection)?;
                let all = self
                    .connection
                    .call_method(Some(name.as_str()), path.as_str(), Some("org.freedesktop.DBus.Properties"), "GetAll", &("org.kde.StatusNotifierItem",))
                    .and_then(|reply| reply.body().deserialize::<HashMap<String, OwnedValue>>())
                    .map_err(|error| error.to_string())?;
                let tooltip = all.get("ToolTip").and_then(|value| <(String, Vec<(i32, i32, Vec<u8>)>, String, String)>::try_from(value.try_clone().ok()?).ok());
                let icons = all.get("IconPixmap").and_then(|value| <Vec<(i32, i32, Vec<u8>)>>::try_from(value.try_clone().ok()?).ok()).unwrap_or_default();
                let id = all.get("Id").and_then(|value| String::try_from(value.try_clone().ok()?).ok());
                return Ok(json!({ "ok": true, "id": id, "tooltip": tooltip.map(|tooltip| tooltip.2), "icons": icons.iter().map(|icon| icon.0).collect::<Vec<_>>() }));
            }
            // A click on the tray's icon, as KDE's host makes it: a token, then Activate.
            "tray-activate" => {
                let (name, path) = tray_item(&self.connection)?;
                let call = |method: &str, body: &dyn erased::Body| body.call(&self.connection, &name, &path, method);
                call("ProvideXdgActivationToken", &("check-token".to_string(),))?;
                call("Activate", &(0i32, 0i32))?;
            }
            // Picks an item from the tray's menu by its label.
            "tray-menu" => {
                let label = text("label");
                let (name, path) = tray_item(&self.connection)?;
                let menu: OwnedObjectPath = self
                    .connection
                    .call_method(Some(name.as_str()), path.as_str(), Some("org.freedesktop.DBus.Properties"), "Get", &("org.kde.StatusNotifierItem", "Menu"))
                    .and_then(|reply| reply.body().deserialize::<OwnedValue>())
                    .map_err(|error| error.to_string())
                    .and_then(|value| OwnedObjectPath::try_from(value).map_err(|error| error.to_string()))?;
                let (_, layout): (u32, (i32, HashMap<String, OwnedValue>, Vec<OwnedValue>)) = self
                    .connection
                    .call_method(Some(name.as_str()), menu.as_str(), Some("com.canonical.dbusmenu"), "GetLayout", &(0i32, -1i32, Vec::<String>::new()))
                    .and_then(|reply| reply.body().deserialize())
                    .map_err(|error| error.to_string())?;
                let id = layout
                    .2
                    .iter()
                    .filter_map(|child| <(i32, HashMap<String, OwnedValue>, Vec<OwnedValue>)>::try_from(child.try_clone().ok()?).ok())
                    .find(|(_, properties, _)| properties.get("label").and_then(|value| String::try_from(value.try_clone().ok()?).ok()).as_deref() == Some(label.as_str()))
                    .map(|(id, _, _)| id)
                    .ok_or_else(|| format!("no menu item {label:?}"))?;
                self.connection
                    .call_method(Some(name.as_str()), menu.as_str(), Some("com.canonical.dbusmenu"), "Event", &(id, "clicked", Value::from(0i32), 0u32))
                    .map_err(|error| error.to_string())?;
            }
            other => return Err(format!("no command {other:?}")),
        }
        Ok(json!({ "ok": true }))
    }
}

/// Calling a tray item's method with whichever body it takes.
mod erased {
    use zbus::blocking::Connection;

    pub trait Body {
        fn call(&self, connection: &Connection, name: &str, path: &str, method: &str) -> Result<(), String>;
    }

    impl<T: serde::Serialize + zbus::zvariant::DynamicType> Body for T {
        fn call(&self, connection: &Connection, name: &str, path: &str, method: &str) -> Result<(), String> {
            connection.call_method(Some(name), path, Some("org.kde.StatusNotifierItem"), method, self).map(|_| ()).map_err(|error| error.to_string())
        }
    }
}

/// Whether a command is the services'.
pub fn handles(command: &Json) -> bool {
    matches!(command.get("do").and_then(Json::as_str), Some("invoke" | "inhibit" | "tray" | "tray-activate" | "tray-menu"))
}

pub static SERVICES: Mutex<Option<Services>> = Mutex::new(None);
