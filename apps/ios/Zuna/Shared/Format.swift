import Foundation
import ZunaModels

/// Formatting shared by the screens, matching the desktop's lib/format.ts, in the language shown:
/// its words from the catalogs, and dates and times for I18n.locale, read each time, so a change
/// of language reaches them.
enum Format {
    /// A time of day, as "14:32" or "2:32 PM".
    private static func clock(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: I18n.locale))
    }

    /// A date in numbers, as "02/11/2026".
    private static func numericDay(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .numeric, time: .omitted, locale: I18n.locale))
    }

    /// The compact time in the conversation list: the time today, the weekday within a week, else the date.
    static func listTime(_ milliseconds: Int, now: Date = .now) -> String {
        guard milliseconds > 0 else { return "" }
        let date = Date(milliseconds: milliseconds)
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return clock(date) }
        if days < 7 { return date.formatted(.dateTime.weekday(.abbreviated).locale(I18n.locale)) }
        return date.formatted(.dateTime.month(.abbreviated).day().locale(I18n.locale))
    }

    static func time(_ milliseconds: Int) -> String {
        clock(Date(milliseconds: milliseconds))
    }

    static func full(_ milliseconds: Int) -> String {
        Date(milliseconds: milliseconds).formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: I18n.locale))
    }

    /// The pill between days: "Today", "Yesterday", or the date.
    static func daySeparator(_ milliseconds: Int, now: Date = .now) -> String {
        let date = Date(milliseconds: milliseconds)
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return t("date.today") }
        if days == 1 { return t("date.yesterday") }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.weekday(.wide).month(.wide).day().locale(I18n.locale))
        }
        return date.formatted(.dateTime.month(.wide).day().year().locale(I18n.locale))
    }

    /// Beside a name in a channel, as the desktop's `formatStamp`: "Today at 14:32", "Yesterday at 9:05", or the date and time.
    static func stamp(_ milliseconds: Int, now: Date = .now) -> String {
        let date = Date(milliseconds: milliseconds)
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        let time = clock(date)
        if days == 0 { return t("date.todayAt", ["time": time]) }
        if days == 1 { return t("date.yesterdayAt", ["time": time]) }
        return t("date.dateTime", ["date": numericDay(date), "time": time])
    }

    /// When something began, for a sentence that says "since": the time and whether it was
    /// yesterday, which the sentence words, as "since yesterday at 9:05"; else "14:32" today, or
    /// the date and time.
    static func since(_ milliseconds: Int, now: Date = .now) -> (yesterday: Bool, time: String) {
        let date = Date(milliseconds: milliseconds)
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        let time = clock(date)
        if days <= 0 { return (false, time) }
        if days == 1 { return (true, time) }
        return (false, t("date.dateTime", ["date": numericDay(date), "time": time]))
    }

    /// A day in full, on the line between days in a channel: "November 2, 2026".
    static func fullDay(_ milliseconds: Int) -> String {
        Date(milliseconds: milliseconds).formatted(.dateTime.month(.wide).day().year().locale(I18n.locale))
    }

    static func sameDay(_ a: Int, _ b: Int) -> Bool {
        Calendar.current.isDate(Date(milliseconds: a), inSameDayAs: Date(milliseconds: b))
    }

    /// The day a time falls on, as one number, the same for two times on the same day: to
    /// compare many times by working out each one's day once.
    static func day(_ milliseconds: Int) -> Int {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: Date(milliseconds: milliseconds))
        return (parts.year ?? 0) * 10_000 + (parts.month ?? 0) * 100 + (parts.day ?? 0)
    }

    /// When someone was last seen, worded as Telegram's desktop app words it (lib/format.ts): in a
    /// chat's header the minutes, or the hours under 12, and in their details (`full`) the time.
    /// Someone hiding it was seen "recently", and someone never seen "a long time ago".
    static func lastSeen(_ milliseconds: Int?, hidden: Bool, full: Bool = false, now: Date = .now) -> String {
        if hidden { return t("lastSeen.recently") }
        guard let milliseconds else { return t("lastSeen.longAgo") }
        let date = Date(milliseconds: milliseconds)
        if !full {
            let minutes = Int(max(0, now.timeIntervalSince(date)) / 60)
            if minutes == 0 { return t("lastSeen.justNow") }
            if minutes < 60 { return t("lastSeen.minutesAgo", ["count": minutes]) }
            let hours = minutes / 60
            if hours < 12 { return t("lastSeen.hoursAgo", ["count": hours]) }
        }
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        let time = clock(date)
        if days <= 0 { return t("lastSeen.todayAt", ["time": time]) }
        if days == 1 { return t("lastSeen.yesterdayAt", ["time": time]) }
        let day = numericDay(date)
        return full ? t("lastSeen.dateAt", ["date": day, "time": time]) : t("lastSeen.date", ["date": day])
    }

    /// The last turn of a minute since someone was last seen, from which `lastSeen`'s words can
    /// change each minute: what a `TimelineView(.periodic(from:by: 60))` starts from to keep
    /// them true as the minutes pass, so "just now" turns into "1 min ago" on time.
    static func lastSeenTurn(_ milliseconds: Int?, now: Date = .now) -> Date {
        guard let milliseconds else { return now }
        let date = Date(milliseconds: milliseconds)
        let minutes = (max(0, now.timeIntervalSince(date)) / 60).rounded(.down)
        return date.addingTimeInterval(minutes * 60)
    }

    static func bytes(_ count: Int) -> String {
        if count < 1024 { return t("common.size.bytes", ["size": count]) }
        let units = [mark("common.size.kb"), mark("common.size.mb"), mark("common.size.gb"), mark("common.size.tb")]
        var value = Double(count)
        var unit = -1
        repeat {
            value /= 1024
            unit += 1
        } while value >= 1024 && unit < units.count - 1
        return t(units[unit], ["size": value >= 100 ? "\(Int(value.rounded()))" : String(format: "%.1f", value)])
    }

    static func duration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// The muted avatar backgrounds and name colors (lib/format.ts), as RGB, picked by `colorIndex`.
    /// Here rather than in Theme so the notification extension draws the same, without SwiftUI.
    static let avatarColors: [UInt32] = [0x5B6B7A, 0x6E625C, 0x5F7065, 0x7A6C58, 0x6B6470, 0x557072, 0x7A6060, 0x5F6775]
    static let nameColors: [UInt32] = [0xA9B7C4, 0xC4B4AC, 0xA8BDAC, 0xC9B89A, 0xB8B0B9, 0xA2BCBE, 0xC9ABAB, 0xAAB2C4]

    /// Same hash as `colorIndex` in lib/format.ts, so a person gets the same color on both apps.
    static func colorIndex(_ seed: String, count: Int) -> Int {
        var hash: Int32 = 0
        for unit in seed.utf16 { hash = hash &* 31 &+ Int32(unit) }
        return Int(hash.magnitude) % count
    }

    /// Up to two initials, from the first and last word, like the desktop's `initialsOf`.
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.first else { return "?" }
        let last = words.count > 1 ? words.last?.first.map(String.init) ?? "" : ""
        return (String(first) + last).uppercased()
    }

    /// How long a chat's messages last, in the desktop's words: "1 day", "2 weeks", or "Off" for 0.
    static func timer(_ seconds: Int) -> String {
        guard seconds > 0 else { return t("common.off") }
        let units: [(Int, String)] = [
            (30 * 86400, mark("date.duration.months")), (7 * 86400, mark("date.duration.weeks")), (86400, mark("date.duration.days")),
            (3600, mark("date.duration.hours")), (60, mark("date.duration.minutes")), (1, mark("date.duration.seconds")),
        ]
        let (size, key) = units.first { seconds % $0.0 == 0 }!
        return t(key, ["count": seconds / size])
    }

    /// The line in a chat when someone changes how long its messages last, worded on its own when
    /// it was you, as other languages say that differently.
    static func timerChange(_ who: String, seconds: Int, you: Bool = false) -> String {
        if you { return seconds > 0 ? t("message.system.youSetTimer", ["time": timer(seconds)]) : t("message.system.youTurnedOffTimer") }
        return seconds > 0 ? t("message.system.timerSet", ["name": who, "time": timer(seconds)]) : t("message.system.timerOff", ["name": who])
    }

    /// How long a chat's messages can be set to last, as the core offers: an hour, a day, a week and a month.
    static let disappearingTimes = [3600, 86400, 7 * 86400, 30 * 86400]

    /// How long a channel's slow mode can hold each person back, as the core offers (SLOW_MODE_TIMES): 5 seconds to 6 hours.
    static let slowModeTimes = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600]

    /// A wait as a clock shows it, as the desktop's waitText: "0:24", "4:59" or "1:59:59".
    static func wait(_ seconds: Int) -> String {
        let hours = seconds / 3600, minutes = seconds % 3600 / 60, rest = seconds % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }

    /// A message with no words, in a line that names it, as above the box when answering it: by
    /// its first file's name, or as a sticker, whose file's name says nothing.
    static func attachmentName(_ attachment: Attachment?) -> String {
        guard let attachment else { return t("message.reply.attachment") }
        return attachment.sticker == true ? t("conversations.preview.sticker") : attachment.name
    }

    /// The preview under a conversation's title, as the desktop builds it.
    static func preview(_ message: MessageView?, users: [String: UserView], selfId: String, kind: GroupKind) -> (author: String?, body: String) {
        guard let message else { return (nil, "") }
        if let system = message.system, system.type == .timerChanged {
            let seconds = system.seconds ?? 0
            return (nil, seconds > 0 ? t("conversations.preview.timer", ["time": timer(seconds)]) : t("conversations.preview.timerOff"))
        }
        if message.system != nil { return (nil, t("conversations.preview.membership")) }
        if message.status == .undecryptable { return (nil, t("conversations.preview.waitingForKeys")) }
        if message.status == .invalid || message.status == .unverified { return (nil, t("conversations.preview.unreadable")) }
        let author: String? = if message.senderId == selfId {
            t("common.you")
        } else if kind != .dm {
            users[message.senderId]?.displayName.split(separator: " ").first.map(String.init)
        } else {
            nil
        }
        let body: String
        if !message.text.isEmpty {
            // By characters, so an emoji at the cut isn't split into half of one.
            body = String(plainText(message.text).prefix(80))
        } else if message.location != nil {
            body = t("conversations.preview.location")
        } else if let attachment = message.attachments.first {
            body = attachment.voice == true ? t("conversations.preview.voiceMessage") : attachment.round == true ? t("conversations.preview.videoMessage")
                : attachment.sticker == true ? t("conversations.preview.sticker")
                : attachment.mime.hasPrefix("image/") ? t("conversations.preview.photo") : attachment.mime.hasPrefix("video/") ? t("conversations.preview.video") : attachment.name
        } else {
            body = ""
        }
        return (author, body)
    }
}

extension Date {
    init(milliseconds: Int) {
        self.init(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
    }
}
