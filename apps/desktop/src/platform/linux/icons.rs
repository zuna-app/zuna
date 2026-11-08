//! The unread count on the taskbar's icon, through `com.canonical.Unity.LauncherEntry`, as
//! Electron's `app.setBadgeCount` gave it on Linux. KDE's task manager shows it, as do
//! Ubuntu's dock and Dash to Dock, finding the app by its `.desktop` file.

use std::collections::HashMap;

use zbus::zvariant::Value;

/// Shows the unread count over the app's icon on the taskbar, and in the tray's tooltip.
pub fn set_unread(count: u32) {
    super::tray::set_unread(count);
    let Some(bus) = super::bus::session() else { return };
    let properties: HashMap<&str, Value> = HashMap::from([("count", Value::from(count as i64)), ("count-visible", Value::from(count > 0))]);
    let app = format!("application://{}.desktop", crate::platform::APP_ID);
    if let Err(error) = bus.emit_signal(None::<&str>, "/com/canonical/unity/launcherentry/zuna_native", "com.canonical.Unity.LauncherEntry", "Update", &(app, properties)) {
        log::warn!("the unread count didn't reach the taskbar: {error}");
    }
}
