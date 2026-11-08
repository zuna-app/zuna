import Foundation
import ZunaModels

/// Formatting shared by the screens, matching the desktop's lib/format.ts.
enum Format {
    /// The compact time in the conversation list: the time today, the weekday within a week, else the date.
    static func listTime(_ milliseconds: Int, now: Date = .now) -> String {
        guard milliseconds > 0 else { return "" }
        let date = Date(milliseconds: milliseconds)
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return date.formatted(date: .omitted, time: .shortened) }
        if days < 7 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    static func time(_ milliseconds: Int) -> String {
        Date(milliseconds: milliseconds).formatted(date: .omitted, time: .shortened)
    }

    static func full(_ milliseconds: Int) -> String {
        Date(milliseconds: milliseconds).formatted(date: .abbreviated, time: .shortened)
    }

    /// The pill between days: "Today", "Yesterday", or the date.
    static func daySeparator(_ milliseconds: Int, now: Date = .now) -> String {
        let date = Date(milliseconds: milliseconds)
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.weekday(.wide).month(.wide).day())
        }
        return date.formatted(.dateTime.month(.wide).day().year())
    }

    /// Beside a name in a channel, as the desktop's `formatStamp`: "Today at 14:32", "Yesterday at 9:05", or the date and time.
    static func stamp(_ milliseconds: Int, now: Date = .now) -> String {
        let date = Date(milliseconds: milliseconds)
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        let time = date.formatted(date: .omitted, time: .shortened)
        if days == 0 { return "Today at \(time)" }
        if days == 1 { return "Yesterday at \(time)" }
        return "\(date.formatted(date: .numeric, time: .omitted)) \(time)"
    }

    /// A day in full, on the line between days in a channel: "November 2, 2026".
    static func fullDay(_ milliseconds: Int) -> String {
        Date(milliseconds: milliseconds).formatted(.dateTime.month(.wide).day().year())
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

    /// As the desktop words it (lib/format.ts).
    static func lastSeen(_ milliseconds: Int?, hidden: Bool, now: Date = .now) -> String {
        guard !hidden, let milliseconds else { return "last seen recently" }
        let date = Date(milliseconds: milliseconds)
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "last seen just now" }
        if minutes < 60 { return "last seen \(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "last seen \(hours) hour\(hours == 1 ? "" : "s") ago" }
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 1 { return "last seen yesterday at \(date.formatted(date: .omitted, time: .shortened))" }
        return "last seen \(date.formatted(.dateTime.month(.abbreviated).day()))"
    }

    static func bytes(_ count: Int) -> String {
        if count < 1024 { return "\(count) B" }
        let units = ["KB", "MB", "GB", "TB"]
        var value = Double(count)
        var unit = -1
        repeat {
            value /= 1024
            unit += 1
        } while value >= 1024 && unit < units.count - 1
        return value >= 100 ? "\(Int(value.rounded())) \(units[unit])" : String(format: "%.1f %@", value, units[unit])
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
        guard seconds > 0 else { return "Off" }
        let units: [(Int, String)] = [(30 * 86400, "month"), (7 * 86400, "week"), (86400, "day"), (3600, "hour"), (60, "minute"), (1, "second")]
        let (size, name) = units.first { seconds % $0.0 == 0 }!
        let count = seconds / size
        return "\(count) \(name)\(count == 1 ? "" : "s")"
    }

    /// The line in a chat when someone changes how long its messages last.
    static func timerChange(_ who: String, seconds: Int) -> String {
        seconds > 0 ? "\(who) set messages to disappear after \(timer(seconds))" : "\(who) turned off disappearing messages"
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

    /// The preview under a conversation's title, as the desktop builds it.
    static func preview(_ message: MessageView?, users: [String: UserView], selfId: String, kind: GroupKind) -> (author: String?, body: String) {
        guard let message else { return (nil, "") }
        if let system = message.system, system.type == .timerChanged {
            let seconds = system.seconds ?? 0
            return (nil, seconds > 0 ? "Messages disappear after \(timer(seconds))" : "Disappearing messages turned off")
        }
        if message.system != nil { return (nil, "Membership changed") }
        if message.status == .undecryptable { return (nil, "Waiting for keys") }
        if message.status == .invalid || message.status == .unverified { return (nil, "A message that couldn't be displayed") }
        let author: String? = if message.senderId == selfId {
            "You"
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
            body = "Location"
        } else if let attachment = message.attachments.first {
            body = attachment.voice == true ? "Voice message" : attachment.round == true ? "Video message"
                : attachment.mime.hasPrefix("image/") ? "Photo" : attachment.mime.hasPrefix("video/") ? "Video" : attachment.name
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
