//! Times, sizes, initials and colors, as packages/ui/src/lib/format.ts makes them. Their words
//! are looked up (crate::i18n): a month's name with its day, so that a language can order and
//! inflect them, and a weekday's where it stands alone.

use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

use crate::i18n::{mark, t};

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

fn format_time_of(time: &DateTime<Local>) -> String {
    if hour12() {
        let clock = time.format("%-I:%M").to_string();
        if time.hour() < 12 { tr!("date.timeAm", time = clock) } else { tr!("date.timePm", time = clock) }
    } else {
        time.format("%H:%M").to_string()
    }
}

pub fn format_time(at_ms: f64) -> String {
    format_time_of(&local(at_ms))
}

/// "November 6": a month's name with its day, a key for each month.
fn month_day(time: &DateTime<Local>) -> String {
    const KEYS: [&str; 12] = [
        mark("date.monthDay.january"),
        mark("date.monthDay.february"),
        mark("date.monthDay.march"),
        mark("date.monthDay.april"),
        mark("date.monthDay.may"),
        mark("date.monthDay.june"),
        mark("date.monthDay.july"),
        mark("date.monthDay.august"),
        mark("date.monthDay.september"),
        mark("date.monthDay.october"),
        mark("date.monthDay.november"),
        mark("date.monthDay.december"),
    ];
    crate::i18n::format(KEYS[time.month0() as usize % 12], &[("day", &time.day() as &dyn std::fmt::Display)])
}

/// "Nov 6": a month's short name with its day.
fn month_day_short(time: &DateTime<Local>) -> String {
    const KEYS: [&str; 12] = [
        mark("date.monthDayShort.january"),
        mark("date.monthDayShort.february"),
        mark("date.monthDayShort.march"),
        mark("date.monthDayShort.april"),
        mark("date.monthDay.may"),
        mark("date.monthDayShort.june"),
        mark("date.monthDayShort.july"),
        mark("date.monthDayShort.august"),
        mark("date.monthDayShort.september"),
        mark("date.monthDayShort.october"),
        mark("date.monthDayShort.november"),
        mark("date.monthDayShort.december"),
    ];
    crate::i18n::format(KEYS[time.month0() as usize % 12], &[("day", &time.day() as &dyn std::fmt::Display)])
}

/// "Thursday", standing alone.
fn weekday(time: &DateTime<Local>) -> &'static str {
    const KEYS: [&str; 7] = [
        mark("date.weekday.monday"),
        mark("date.weekday.tuesday"),
        mark("date.weekday.wednesday"),
        mark("date.weekday.thursday"),
        mark("date.weekday.friday"),
        mark("date.weekday.saturday"),
        mark("date.weekday.sunday"),
    ];
    t(KEYS[time.weekday().num_days_from_monday() as usize % 7])
}

/// "Thu", standing alone.
fn weekday_short(time: &DateTime<Local>) -> &'static str {
    const KEYS: [&str; 7] = [
        mark("date.weekdayShort.monday"),
        mark("date.weekdayShort.tuesday"),
        mark("date.weekdayShort.wednesday"),
        mark("date.weekdayShort.thursday"),
        mark("date.weekdayShort.friday"),
        mark("date.weekdayShort.saturday"),
        mark("date.weekdayShort.sunday"),
    ];
    t(KEYS[time.weekday().num_days_from_monday() as usize % 7])
}

/// A month and day with the year: "November 6, 2026".
fn with_year(date: String, time: &DateTime<Local>) -> String {
    tr!("date.withYear", date = date, year = time.year())
}

/// A moment still to come, with its date unless it's today: "14:32", or "Nov 6, 14:32" (`formatUpcoming`).
pub fn format_upcoming(at_ms: f64) -> String {
    let when = local(at_ms);
    if when.date_naive() == Local::now().date_naive() {
        return format_time_of(&when);
    }
    tr!("date.dayTime", date = month_day_short(&when), time = format_time_of(&when))
}

/// "Nov 5, 2026, 14:32", as Intl's medium date and short time.
/// "Today at 14:32", "Yesterday at 9:05", or the date and time, as a channel's messages say
/// when they were sent (`formatStamp`).
pub fn format_stamp(at_ms: f64) -> String {
    let when = local(at_ms);
    let days = (Local::now().date_naive() - when.date_naive()).num_days();
    let time = format_time_of(&when);
    match days {
        0 => tr!("date.todayAt", time = time),
        1 => tr!("date.yesterdayAt", time = time),
        _ => tr!("date.numericDateTime", month = when.format("%m"), day = when.format("%d"), year = when.format("%Y"), time = time),
    }
}

/// "November 6, 2026", as on the line between days in a channel.
pub fn format_day(at_ms: f64) -> String {
    let time = local(at_ms);
    with_year(month_day(&time), &time)
}

pub fn format_full(at_ms: f64) -> String {
    let time = local(at_ms);
    tr!("date.dayTime", date = with_year(month_day_short(&time), &time), time = format_time_of(&time))
}

/// The compact time shown in the conversation list.
pub fn format_list_time(at_ms: f64) -> String {
    if at_ms <= 0.0 {
        return String::new();
    }
    let when = local(at_ms);
    let days = (Local::now().date_naive() - when.date_naive()).num_days();
    if days <= 0 {
        format_time_of(&when)
    } else if days < 7 {
        weekday_short(&when).to_string()
    } else {
        month_day_short(&when)
    }
}

pub fn format_day_separator(at_ms: f64) -> String {
    let days = days_ago(at_ms);
    if days == 0 {
        return t("date.today").into();
    }
    if days == 1 {
        return t("date.yesterday").into();
    }
    let time = local(at_ms);
    if time.year() == Local::now().year() { tr!("date.withWeekday", weekday = weekday(&time), date = month_day(&time)) } else { with_year(month_day(&time), &time) }
}

/// When someone was last seen, worded as Telegram's desktop app words it (`formatLastSeen`): in a
/// chat's header (`Data::OnlineText`) the minutes, or the hours under 12, and in their details
/// (`full`, `Data::OnlineTextFull`) the time. Someone hiding it was seen "recently", and someone
/// never seen "a long time ago".
pub fn format_last_seen(at_ms: Option<f64>, hidden: bool, full: bool) -> String {
    if hidden {
        return t("lastSeen.recently").into();
    }
    let Some(at) = at_ms else { return t("lastSeen.longAgo").into() };
    if !full {
        let minutes = ((now_ms() - at).max(0.) / 60_000.0).floor() as i64;
        if minutes == 0 {
            return t("lastSeen.justNow").into();
        }
        if minutes < 60 {
            return tr!("lastSeen.minutesAgo", count = minutes);
        }
        let hours = minutes / 60;
        if hours < 12 {
            return tr!("lastSeen.hoursAgo", count = hours);
        }
    }
    match days_ago(at) {
        ..=0 => tr!("lastSeen.todayAt", time = format_time(at)),
        1 => tr!("lastSeen.yesterdayAt", time = format_time(at)),
        _ if full => tr!("lastSeen.dateAt", date = short_date(at), time = format_time(at)),
        _ => tr!("lastSeen.date", date = short_date(at)),
    }
}

/// A date as Qt's short format gives it in English: "11/9/26".
fn short_date(at_ms: f64) -> String {
    let time = local(at_ms);
    tr!("date.numericShort", month = time.month(), day = time.day(), year = time.format("%y"))
}

/// How long until `format_last_seen`'s words next change, or None if they never do, as Telegram
/// works it out (`OnlinePhraseChangeInSeconds`): at the turn of a minute under an hour, of an hour
/// under 12, and at midnight after.
pub fn last_seen_changes_in(at_ms: Option<f64>, hidden: bool) -> Option<std::time::Duration> {
    const MINUTE: f64 = 60_000.;
    const HOUR: f64 = 3_600_000.;
    let at = at_ms.filter(|_| !hidden)?;
    let since = (now_ms() - at).max(0.);
    let wait = if since < HOUR {
        MINUTE - since % MINUTE
    } else if since < 12. * HOUR {
        HOUR - since % HOUR
    } else {
        let tomorrow = Local::now().date_naive().succ_opt().and_then(|day| day.and_hms_opt(0, 0, 0)).and_then(|midnight| midnight.and_local_timezone(Local).earliest());
        tomorrow.map_or(HOUR, |midnight| (midnight.timestamp_millis() as f64 - now_ms()).max(1_000.))
    };
    Some(std::time::Duration::from_millis(wait as u64 + 50))
}

pub fn format_bytes(bytes: f64) -> String {
    if bytes < 1024.0 {
        return tr!("common.size.bytes", size = bytes as u64);
    }
    let units = [mark("common.size.kb"), mark("common.size.mb"), mark("common.size.gb"), mark("common.size.tb")];
    let mut value = bytes;
    let mut unit = 0;
    value /= 1024.0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let size = if value >= 100.0 { format!("{}", value.round()) } else { format!("{:.1}", value) };
    crate::i18n::format(units[unit], &[("size", &size as &dyn std::fmt::Display)])
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
        return t("common.off").into();
    }
    let seconds = seconds as u64;
    let units: [(u64, &'static str); 6] = [
        (30 * 86_400, mark("date.duration.months")),
        (7 * 86_400, mark("date.duration.weeks")),
        (86_400, mark("date.duration.days")),
        (3600, mark("date.duration.hours")),
        (60, mark("date.duration.minutes")),
        (1, mark("date.duration.seconds")),
    ];
    let (size, key) = units.iter().find(|(size, _)| seconds % size == 0).copied().unwrap_or((1, mark("date.duration.seconds")));
    let count = seconds / size;
    crate::i18n::format(key, &[("count", &count as &dyn std::fmt::Display)])
}

/// What a chat says when someone changes how long its messages last.
pub fn timer_change_text(who: &str, seconds: f64) -> String {
    if seconds > 0.0 { tr!("message.system.timerSet", name = who, time = timer_text(seconds)) } else { tr!("message.system.timerOff", name = who) }
}

/// What a chat says when you change how long its messages last.
pub fn own_timer_change_text(seconds: f64) -> String {
    if seconds > 0.0 { tr!("message.system.youSetTimer", time = timer_text(seconds)) } else { t("message.system.youTurnedOffTimer").to_string() }
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
    let (latitude, longitude) = (format!("{:.5}", lat.abs()), format!("{:.5}", lon.abs()));
    match (lat >= 0., lon >= 0.) {
        (true, true) => tr!("location.coordinatesNE", latitude = latitude, longitude = longitude),
        (true, false) => tr!("location.coordinatesNW", latitude = latitude, longitude = longitude),
        (false, true) => tr!("location.coordinatesSE", latitude = latitude, longitude = longitude),
        (false, false) => tr!("location.coordinatesSW", latitude = latitude, longitude = longitude),
    }
}

/// "Within 20 m", or "Within 1.5 km".
pub fn accuracy_text(meters: f64) -> String {
    if meters < 1000. {
        tr!("location.withinMeters", distance = meters.round().max(1.) as u64)
    } else if meters < 10_000. {
        tr!("location.withinKilometers", distance = format!("{:.1}", meters / 1000.))
    } else {
        tr!("location.withinKilometers", distance = format!("{:.0}", meters / 1000.))
    }
}

/// Where a location opens: OpenStreetMap, in the browser, so nothing here loads a map.
pub fn map_link(lat: f64, lon: f64) -> String {
    format!("https://www.openstreetmap.org/?mlat={lat:.6}&mlon={lon:.6}#map=16/{lat:.6}/{lon:.6}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: f64 = 60_000.;
    const HOUR: f64 = 60. * MINUTE;
    const DAY: f64 = 24. * HOUR;

    #[test]
    fn times_and_days_are_said_relative_to_today() {
        let now = now_ms();
        assert!(same_day(now, now));
        assert!(!same_day(now, now - 3. * DAY));
        assert!(format_stamp(now).starts_with("Today at "));
        assert!(format_stamp(now - DAY).starts_with("Yesterday at "));
        assert!(format_stamp(now - 10. * DAY).contains('/'));
        assert_eq!(format_day_separator(now), "Today");
        assert_eq!(format_day_separator(now - DAY), "Yesterday");
        assert!(!format_day_separator(now - 3. * DAY).is_empty());
        assert!(format_day_separator(now - 400. * DAY).contains(','));
        assert_eq!(format_list_time(0.), "");
        assert_eq!(format_list_time(now), format_time(now));
        assert_eq!(format_list_time(now - 3. * DAY).len(), 3, "a weekday's short name");
        assert!(format_list_time(now - 30. * DAY).contains(' '));
        assert!(format_day(now).contains(','));
        assert!(format_full(now).contains(", "));
        assert!(format_time(now).contains(':'));
    }

    #[test]
    fn last_seen_is_worded_as_telegram_words_it() {
        let now = now_ms();
        assert_eq!(format_last_seen(Some(now), true, false), "last seen recently");
        assert_eq!(format_last_seen(None, false, false), "last seen a long time ago");
        assert_eq!(format_last_seen(Some(now), false, false), "last seen just now");
        assert_eq!(format_last_seen(Some(now - MINUTE), false, false), "last seen 1 minute ago");
        assert_eq!(format_last_seen(Some(now - 5. * MINUTE), false, false), "last seen 5 minutes ago");
        assert_eq!(format_last_seen(Some(now - HOUR - MINUTE), false, false), "last seen 1 hour ago");
        assert_eq!(format_last_seen(Some(now - 3. * HOUR), false, false), "last seen 3 hours ago");
        assert!(format_last_seen(Some(now), false, true).starts_with("last seen today at"));
        assert!(format_last_seen(Some(now - DAY), false, true).starts_with("last seen yesterday at"));
        assert!(format_last_seen(Some(now - 5. * DAY), false, true).contains(" at "));
        assert!(!format_last_seen(Some(now - 5. * DAY), false, false).contains(" at "));
    }

    #[test]
    fn last_seen_changes_at_the_next_minute_hour_or_midnight() {
        let now = now_ms();
        assert_eq!(last_seen_changes_in(None, false), None);
        assert_eq!(last_seen_changes_in(Some(now), true), None);
        assert!(last_seen_changes_in(Some(now - 30_000.), false).unwrap() <= std::time::Duration::from_secs(61));
        assert!(last_seen_changes_in(Some(now - 2. * HOUR), false).unwrap() <= std::time::Duration::from_secs(3601));
        assert!(last_seen_changes_in(Some(now - 20. * HOUR), false).unwrap() <= std::time::Duration::from_secs(86_401));
    }

    #[test]
    fn sizes_lengths_and_waits() {
        assert_eq!(format_bytes(512.), "512 B");
        assert_eq!(format_bytes(1536.), "1.5 KB");
        assert_eq!(format_bytes(150. * 1024. * 1024.), "150 MB");
        assert_eq!(format_bytes(5. * 1024f64.powi(5)), "5120 TB");
        assert_eq!(format_duration(75.4), "1:15");
        assert_eq!(format_duration(-3.), "0:00");
        assert_eq!(wait_text(24), "0:24");
        assert_eq!(wait_text(299), "4:59");
        assert_eq!(wait_text(7199), "1:59:59");
    }

    #[test]
    fn initials_and_colors_follow_the_name() {
        assert_eq!(initials_of("ada lovelace"), "AL");
        assert_eq!(initials_of("  ada  "), "A");
        assert_eq!(initials_of("ada byron lovelace"), "AL");
        assert_eq!(initials_of(""), "?");
        assert_eq!(avatar_color("ada"), avatar_color("ada"));
        assert_ne!(name_color("x"), "");
        // The web's hash: "a" is 97, which is 1 of the 8.
        assert_eq!(avatar_color("a"), AVATAR_COLORS[97 % 8]);
    }

    #[test]
    fn timers_say_their_largest_whole_unit() {
        assert_eq!(timer_text(0.), "Off");
        assert_eq!(timer_text(1.), "1 second");
        assert_eq!(timer_text(90.), "90 seconds");
        assert_eq!(timer_text(3600.), "1 hour");
        assert_eq!(timer_text(2. * 86_400.), "2 days");
        assert_eq!(timer_text(14. * 86_400.), "2 weeks");
        assert_eq!(timer_text(30. * 86_400.), "1 month");
        assert_eq!(timer_change_text("Ann", 86_400.), "Ann set messages to disappear after 1 day");
        assert_eq!(timer_change_text("Ann", 0.), "Ann turned off disappearing messages");
    }

    #[test]
    fn places_are_written_and_linked() {
        assert_eq!(coordinates_text(52.2297, -21.0122), "52.22970° N, 21.01220° W");
        assert_eq!(coordinates_text(-1., 2.), "1.00000° S, 2.00000° E");
        assert_eq!(accuracy_text(0.2), "Within 1 m");
        assert_eq!(accuracy_text(1500.), "Within 1.5 km");
        assert_eq!(accuracy_text(25_000.), "Within 25 km");
        assert_eq!(map_link(1., 2.), "https://www.openstreetmap.org/?mlat=1.000000&mlon=2.000000#map=16/1.000000/2.000000");
    }
}
