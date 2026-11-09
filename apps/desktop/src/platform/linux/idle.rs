//! How long since anyone touched the computer, counting input alone, as Telegram's desktop app
//! counts it (`base_last_input_linux.cpp` in its lib_base: the X screensaver's time since input,
//! or Mutter's `GetIdletime`, or else only its own events). KDE's `org.freedesktop.ScreenSaver`
//! doesn't say under Wayland, so this asks the compositor itself, through `ext-idle-notify-v1`,
//! on a Wayland connection of its own: it says once the person has been away for a while, and
//! again when they're back. Only its version 2 counts input alone: version 1's notification
//! never comes while anything holds an idle inhibitor, as a video playing or a game does, so
//! the person would never be away. Without version 2, GNOME's Mutter is asked over D-Bus, and
//! without that `idle_known` is false and the app goes by input to itself.

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
/// stops giving input, whatever holds the screen on, or while Mutter answers. Otherwise the app
/// counts only input to itself (`quiet_ms` in `state/notify.rs`).
pub fn idle_known() -> bool {
    KNOWN.load(Ordering::Relaxed) || FROM_MUTTER.load(Ordering::Relaxed)
}

fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64 + 1
}

/// Milliseconds since the last input, as far as the compositor has said, 0 until it says the
/// person has been away for `AWAY_AFTER_MS`, or else as Mutter last said, counted on since.
pub fn idle_ms() -> u32 {
    let idle = if KNOWN.load(Ordering::Relaxed) {
        match QUIET_SINCE.load(Ordering::Relaxed) {
            0 => 0,
            since => now_ms().saturating_sub(since),
        }
    } else {
        MUTTER_IDLE.load(Ordering::Relaxed) + now_ms().saturating_sub(MUTTER_AT.load(Ordering::Relaxed))
    };
    idle.min(u32::MAX as u64) as u32
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

/// Starts listening: to the compositor's input-only notification, or else to GNOME's Mutter, as
/// Telegram does (`MutterDBusLastUserInputTime`). With neither, `idle_known` stays false.
pub fn start() {
    epoch();
    std::thread::Builder::new()
        .name("zuna-idle".into())
        .spawn(|| {
            let Ok(connection) = Connection::connect_to_env() else { return watch_mutter() };
            let Ok((globals, mut queue)) = registry_queue_init::<Idle>(&connection) else { return watch_mutter() };
            let handle = queue.handle();
            let Ok(seat) = globals.bind::<wl_seat::WlSeat, _, _>(&handle, 1..=1, ()) else { return watch_mutter() };
            let Ok(notifier) = globals.bind::<ext_idle_notifier_v1::ExtIdleNotifierV1, _, _>(&handle, 1..=2, ()) else {
                log::info!("the compositor doesn't say when the person is away");
                return watch_mutter();
            };
            if notifier.version() >= 2 {
                notifier.get_input_idle_notification(AWAY_AFTER_MS, &seat, &handle, ());
                KNOWN.store(true, Ordering::Relaxed);
            } else {
                // Still asked, for the log: it can't tell a video playing from someone at the computer.
                log::info!("the compositor's idle notifications wait for idle inhibitors, so they don't count");
                notifier.get_idle_notification(AWAY_AFTER_MS, &seat, &handle, ());
                watch_mutter();
            }
            while queue.blocking_dispatch(&mut Idle).is_ok() {}
            // The connection is gone, and with it word of the person going or coming back.
            KNOWN.store(false, Ordering::Relaxed);
        })
        .ok();
}

/// GNOME's idle time, which Mutter gives over D-Bus rather than through the protocol: what it last
/// said, in ms, and when, in ms since `epoch()`, while it answers.
static MUTTER_IDLE: AtomicU64 = AtomicU64::new(0);
static MUTTER_AT: AtomicU64 = AtomicU64::new(0);
static FROM_MUTTER: AtomicBool = AtomicBool::new(false);

/// Asks Mutter how long since the person's last input every 900 ms, as Telegram's desktop app looks
/// for them coming back, and stops for good once it doesn't answer, as it never will off GNOME.
fn watch_mutter() {
    std::thread::Builder::new()
        .name("zuna-idle-mutter".into())
        .spawn(|| {
            let Some(bus) = super::bus::session() else { return };
            loop {
                let idle = bus
                    .call_method(Some("org.gnome.Mutter.IdleMonitor"), "/org/gnome/Mutter/IdleMonitor/Core", Some("org.gnome.Mutter.IdleMonitor"), "GetIdletime", &())
                    .and_then(|reply| reply.body().deserialize::<u64>());
                let Ok(idle) = idle else {
                    log::info!("Mutter doesn't say when the person is away either, so only input to the app counts");
                    FROM_MUTTER.store(false, Ordering::Relaxed);
                    return;
                };
                MUTTER_IDLE.store(idle, Ordering::Relaxed);
                MUTTER_AT.store(now_ms(), Ordering::Relaxed);
                FROM_MUTTER.store(true, Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(900));
            }
        })
        .ok();
}
