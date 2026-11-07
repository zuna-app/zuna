//! How long since anyone touched the computer. KDE's `org.freedesktop.ScreenSaver` doesn't
//! say under Wayland, so this asks the compositor itself, through `ext-idle-notify-v1`, on a
//! Wayland connection of its own: it says once the person has been away for a while, and
//! again when they're back.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::ext::idle_notify::v1::client::{ext_idle_notification_v1, ext_idle_notifier_v1};

use crate::platform::AWAY_AFTER_MS;

/// When the person went quiet, in milliseconds since `epoch()`, or 0 while they're here.
static QUIET_SINCE: AtomicU64 = AtomicU64::new(0);

fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64 + 1
}

/// Milliseconds since the last input, as far as the compositor has said: 0 until it says
/// the person has been away for `AWAY_AFTER_MS`.
pub fn idle_ms() -> u32 {
    match QUIET_SINCE.load(Ordering::Relaxed) {
        0 => 0,
        since => now_ms().saturating_sub(since).min(u32::MAX as u64) as u32,
    }
}

struct Idle;

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Idle {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<wl_seat::WlSeat, ()> for Idle {
    fn event(_: &mut Self, _: &wl_seat::WlSeat, _: wl_seat::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<ext_idle_notifier_v1::ExtIdleNotifierV1, ()> for Idle {
    fn event(_: &mut Self, _: &ext_idle_notifier_v1::ExtIdleNotifierV1, _: ext_idle_notifier_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<ext_idle_notification_v1::ExtIdleNotificationV1, ()> for Idle {
    fn event(_: &mut Self, _: &ext_idle_notification_v1::ExtIdleNotificationV1, event: ext_idle_notification_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            ext_idle_notification_v1::Event::Idled => {
                log::info!("the person is away");
                QUIET_SINCE.store(now_ms().saturating_sub(AWAY_AFTER_MS as u64).max(1), Ordering::Relaxed);
            }
            ext_idle_notification_v1::Event::Resumed => {
                log::info!("the person is back");
                QUIET_SINCE.store(0, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

/// Starts listening. Without the protocol the person always counts as here, as before.
pub fn start() {
    epoch();
    std::thread::Builder::new()
        .name("zuna-idle".into())
        .spawn(|| {
            let Ok(connection) = Connection::connect_to_env() else { return };
            let Ok((globals, mut queue)) = registry_queue_init::<Idle>(&connection) else { return };
            let handle = queue.handle();
            let Ok(seat) = globals.bind::<wl_seat::WlSeat, _, _>(&handle, 1..=1, ()) else { return };
            let Ok(notifier) = globals.bind::<ext_idle_notifier_v1::ExtIdleNotifierV1, _, _>(&handle, 1..=1, ()) else {
                log::info!("the compositor doesn't say when the person is away");
                return;
            };
            notifier.get_idle_notification(AWAY_AFTER_MS, &seat, &handle, ());
            while queue.blocking_dispatch(&mut Idle).is_ok() {}
        })
        .ok();
}
