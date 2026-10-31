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

    /// Up to two initials, from the first and last word, like the desktop's `initialsOf`.
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.first else { return "?" }
        let last = words.count > 1 ? words.last?.first.map(String.init) ?? "" : ""
        return (String(first) + last).uppercased()
    }

    /// The preview under a conversation's title, as the desktop builds it.
    static func preview(_ message: MessageView?, users: [String: UserView], selfId: String, kind: GroupKind) -> (author: String?, body: String) {
        guard let message else { return (nil, "") }
        if message.system != nil { return (nil, "Membership changed") }
        if message.status == .undecryptable { return (nil, "Waiting for keys") }
        let author: String? = if message.senderId == selfId {
            "You"
        } else if kind == .group {
            users[message.senderId]?.displayName.split(separator: " ").first.map(String.init)
        } else {
            nil
        }
        let body: String
        if !message.text.isEmpty {
            body = String(decoding: plainText(message.text).utf16.prefix(80), as: UTF16.self)
        } else if let attachment = message.attachments.first {
            body = attachment.mime.hasPrefix("image/") ? "Photo" : attachment.mime.hasPrefix("video/") ? "Video" : attachment.name
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
