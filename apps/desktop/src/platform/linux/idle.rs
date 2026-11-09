//! How long since anyone touched the computer. KDE's `org.freedesktop.ScreenSaver` doesn't
//! say under Wayland, so this asks the compositor itself, through `ext-idle-notify-v1`, on a
//! Wayland connection of its own: it says once the person has been away for a while, and
//! again when they're back. Only its version 2 counts input alone: version 1's notification
//! never comes while anything holds an idle inhibitor, as a video playing or a game does, so
//! the person would never be away. With version 1 or none, `idle_known` is false and the app
//! goes by input to itself, as Telegram's does when the system can't say.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols::ext::idle_notify::v1::client::{ext_idle_notification_v1, ext_idle_notifier_v1};

use crate::platform::AWAY_AFTER_MS;

/// When the person went quiet, in milliseconds since `epoch()`, or 0 while they're here.
static QUIET_SINCE: AtomicU64 = AtomicU64::new(0);
/// Whether the compositor says when the person stops touching the computer, which some don't.
static KNOWN: AtomicBool = AtomicBool::new(false);

/// Whether `idle_ms` means anything: only once the compositor has agreed to say when the person
/// stops giving input, whatever holds the screen on. Otherwise the app counts only input to
/// itself (`quiet_ms` in `state/notify.rs`).
pub fn idle_known() -> bool {
    KNOWN.load(Ordering::Relaxed)
}

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

/// Starts listening. Without the protocol, `idle_known` stays false.
pub fn start() {
    epoch();
    std::thread::Builder::new()
        .name("zuna-idle".into())
        .spawn(|| {
            let Ok(connection) = Connection::connect_to_env() else { return };
            let Ok((globals, mut queue)) = registry_queue_init::<Idle>(&connection) else { return };
            let handle = queue.handle();
            let Ok(seat) = globals.bind::<wl_seat::WlSeat, _, _>(&handle, 1..=1, ()) else { return };
            let Ok(notifier) = globals.bind::<ext_idle_notifier_v1::ExtIdleNotifierV1, _, _>(&handle, 1..=2, ()) else {
                log::info!("the compositor doesn't say when the person is away, so only input to the app counts");
                return;
            };
            if notifier.version() >= 2 {
                notifier.get_input_idle_notification(AWAY_AFTER_MS, &seat, &handle, ());
                KNOWN.store(true, Ordering::Relaxed);
            } else {
                // Still asked, for the log: it can't tell a video playing from someone at the computer.
                log::info!("the compositor's idle notifications wait for idle inhibitors, so only input to the app counts");
                notifier.get_idle_notification(AWAY_AFTER_MS, &seat, &handle, ());
            }
            while queue.blocking_dispatch(&mut Idle).is_ok() {}
            // The connection is gone, and with it word of the person going or coming back.
            KNOWN.store(false, Ordering::Relaxed);
        })
        .ok();
}
