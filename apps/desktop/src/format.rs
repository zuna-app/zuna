//! Times, sizes, initials and colors, as packages/ui/src/lib/format.ts makes them.

use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Local, TimeZone};

/// Whether the system's clock shows 12 hours, as the Electron app followed it.
fn hour12() -> bool {
    static HOUR12: OnceLock<bool> = OnceLock::new();
    *HOUR12.get_or_init(system_hour12)
}

#[cfg(windows)]
fn system_hour12() -> bool {
    use windows::Win32::Globalization::{GetLocaleInfoEx, LOCALE_STIMEFORMAT};
    let mut buffer = [0u16; 80];
    let length = unsafe { GetLocaleInfoEx(windows::core::PCWSTR::null(), LOCALE_STIMEFORMAT, Some(&mut buffer)) };
    if length <= 0 {
        return false;
    }
    let format = String::from_utf16_lossy(&buffer[..(length as usize).saturating_sub(1)]);
    !format.contains('H')
}

/// Whether the time format of the person's LC_TIME shows 12 hours, read from a locale of its
/// own, as setlocale would change it for everything else in the process.
#[cfg(target_os = "linux")]
fn system_hour12() -> bool {
    // SAFETY: the locale is made, read and freed here, and nl_langinfo_l's string is copied
    // before it is.
    unsafe {
        let locale = libc::newlocale(libc::LC_TIME_MASK, c"".as_ptr(), std::ptr::null_mut());
        if locale.is_null() {
            return false;
        }
        let format = std::ffi::CStr::from_ptr(libc::nl_langinfo_l(libc::T_FMT, locale)).to_string_lossy().into_owned();
        libc::freelocale(locale);
        format.contains("%I") || format.contains("%l") || format.contains("%r")
    }
}

/// Whether macOS shows times with AM and PM: the switch in Date & Time's settings first, as the
/// Electron app read it, then the locale's own time format.
#[cfg(target_os = "macos")]
fn system_hour12() -> bool {
    use objc2_foundation::{NSDateFormatter, NSLocale, NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    if defaults.boolForKey(&NSString::from_str("AppleICUForce24HourTime")) {
        return false;
    }
    if defaults.boolForKey(&NSString::from_str("AppleICUForce12HourTime")) {
        return true;
    }
    // "j" is the locale's own hour, which comes with "a" where it's the 12-hour clock.
    NSDateFormatter::dateFormatFromTemplate_options_locale(&NSString::from_str("j"), 0, Some(&NSLocale::currentLocale())).is_some_and(|format| format.to_string().contains('a'))
}

pub fn local(at_ms: f64) -> DateTime<Local> {
    Local.timestamp_millis_opt(at_ms as i64).single().unwrap_or_else(Local::now)
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn days_ago(at_ms: f64) -> i64 {
    let today = Local::now().date_naive();
    let then = local(at_ms).date_naive();
    (today - then).num_days()
}

pub fn same_day(a: f64, b: f64) -> bool {
    local(a).date_naive() == local(b).date_naive()
}

pub fn format_time(at_ms: f64) -> String {
    let time = local(at_ms);
    if hour12() { time.format("%-I:%M %p").to_string() } else { time.format("%H:%M").to_string() }
}

/// "Nov 5, 2026, 14:32", as Intl's medium date and short time.
/// "Today at 14:32", "Yesterday at 9:05", or the date and time, as a channel's messages say
/// when they were sent (`formatStamp`).
pub fn format_stamp(at_ms: f64) -> String {
    match days_ago(at_ms) {
        0 => format!("Today at {}", format_time(at_ms)),
        1 => format!("Yesterday at {}", format_time(at_ms)),
        _ => format!("{} {}", local(at_ms).format("%m/%d/%Y"), format_time(at_ms)),
    }
}

/// "November 6, 2026", as on the line between days in a channel.
pub fn format_day(at_ms: f64) -> String {
    local(at_ms).format("%B %-d, %Y").to_string()
}

pub fn format_full(at_ms: f64) -> String {
    let time = local(at_ms);
    format!("{}, {}", time.format("%b %-d, %Y"), format_time(at_ms))
}

/// The compact time shown in the conversation list.
pub fn format_list_time(at_ms: f64) -> String {
    if at_ms <= 0.0 {
        return String::new();
    }
    let days = days_ago(at_ms);
    if days <= 0 {
        format_time(at_ms)
    } else if days < 7 {
        local(at_ms).format("%a").to_string()
    } else {
        local(at_ms).format("%b %-d").to_string()
    }
}

pub fn format_day_separator(at_ms: f64) -> String {
    let days = days_ago(at_ms);
    if days == 0 {
        return "Today".into();
    }
    if days == 1 {
        return "Yesterday".into();
    }
    let time = local(at_ms);
    if time.year() == Local::now().year() { time.format("%A, %B %-d").to_string() } else { time.format("%B %-d, %Y").to_string() }
}

pub fn format_last_seen(at_ms: Option<f64>, hidden: bool) -> String {
    let Some(at) = at_ms.filter(|_| !hidden) else { return "last seen recently".into() };
    let minutes = ((now_ms() - at) / 60_000.0).floor() as i64;
    if minutes < 1 {
        return "last seen just now".into();
    }
    if minutes < 60 {
        return format!("last seen {minutes} min ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("last seen {hours} hour{} ago", if hours == 1 { "" } else { "s" });
    }
    if days_ago(at) == 1 {
        return format!("last seen yesterday at {}", format_time(at));
    }
    format!("last seen {}", local(at).format("%b %-d"))
}

pub fn format_bytes(bytes: f64) -> String {
    if bytes < 1024.0 {
        return format!("{} B", bytes as u64);
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut value = bytes;
    let mut unit = 0;
    value /= 1024.0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 100.0 { format!("{} {}", value.round(), units[unit]) } else { format!("{:.1} {}", value, units[unit]) }
}

pub fn format_duration(seconds: f64) -> String {
    let total = seconds.round().max(0.0) as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

pub fn initials_of(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().collect();
    let Some(first) = parts.first() else { return "?".into() };
    let mut initials: String = first.chars().next().map(String::from).unwrap_or_default();
    if parts.len() > 1 {
        if let Some(last) = parts.last().and_then(|word| word.chars().next()) {
            initials.push(last);
        }
    }
    initials.to_uppercase()
}

// Muted, flat tones. Enough to tell people apart without coloring the interface.
const AVATAR_COLORS: [&str; 8] = ["#5b6b7a", "#6e625c", "#5f7065", "#7a6c58", "#6b6470", "#557072", "#7a6060", "#5f6775"];
const NAME_COLORS: [&str; 8] = ["#a9b7c4", "#c4b4ac", "#a8bdac", "#c9b89a", "#b8b0b9", "#a2bcbe", "#c9abab", "#aab2c4"];

/// The same hash as the web's: 31 times, as 32-bit integers, over UTF-16 code units.
fn color_index(seed: &str, count: usize) -> usize {
    let mut hash: i32 = 0;
    for unit in seed.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    (hash.unsigned_abs() as usize) % count
}

pub fn avatar_color(seed: &str) -> &'static str {
    AVATAR_COLORS[color_index(seed, AVATAR_COLORS.len())]
}

/// A stable color for someone's name in group chats.
pub fn name_color(seed: &str) -> &'static str {
    NAME_COLORS[color_index(seed, NAME_COLORS.len())]
}

/// "1 day", "2 weeks", or "Off" for 0 (lib/disappearing.ts).
pub fn timer_text(seconds: f64) -> String {
    if seconds <= 0.0 {
        return "Off".into();
    }
    let seconds = seconds as u64;
    let units: [(u64, &str); 6] = [(30 * 86_400, "month"), (7 * 86_400, "week"), (86_400, "day"), (3600, "hour"), (60, "minute"), (1, "second")];
    let (size, name) = units.iter().find(|(size, _)| seconds % size == 0).copied().unwrap_or((1, "second"));
    let count = seconds / size;
    format!("{count} {name}{}", if count == 1 { "" } else { "s" })
}

/// What a chat says when someone changes how long its messages last.
pub fn timer_change_text(who: &str, seconds: f64) -> String {
    if seconds > 0.0 { format!("{who} set messages to disappear after {}", timer_text(seconds)) } else { format!("{who} turned off disappearing messages") }
}

/// The shortest password allowed when signing up or changing it.
pub const MIN_PASSWORD: usize = 8;

/// A wait as a clock shows it: "0:24", "4:59" or "1:59:59" (slow-mode.ts's waitText).
pub fn wait_text(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let rest = seconds % 60;
    if hours > 0 { format!("{hours}:{minutes:02}:{rest:02}") } else { format!("{minutes}:{rest:02}") }
}

/// "52.22970° N, 21.01220° E" (lib/location.ts).
pub fn coordinates_text(lat: f64, lon: f64) -> String {
    format!("{:.5}° {}, {:.5}° {}", lat.abs(), if lat >= 0. { "N" } else { "S" }, lon.abs(), if lon >= 0. { "E" } else { "W" })
}

/// "Within 20 m", or "Within 1.5 km".
pub fn accuracy_text(meters: f64) -> String {
    if meters < 1000. {
        format!("Within {} m", meters.round().max(1.) as u64)
    } else if meters < 10_000. {
        format!("Within {:.1} km", meters / 1000.)
    } else {
        format!("Within {:.0} km", meters / 1000.)
    }
}

/// Where a location opens: OpenStreetMap, in the browser, so nothing here loads a map.
pub fn map_link(lat: f64, lon: f64) -> String {
    format!("https://www.openstreetmap.org/?mlat={lat:.6}&mlon={lon:.6}#map=16/{lat:.6}/{lon:.6}")
}
