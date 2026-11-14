import Foundation
import UserNotifications

/// A push Telegram sends the linked account's phone through Apple (docs/TELEGRAM_PLAN.md,
/// Notifications), told from a server's by its shape: Telegram's, with a kind in `loc-key` and
/// what it names beside it, where a server's push is sealed under `zuna`. Nothing in it can pass
/// for a server's, which is sealed with a key Telegram doesn't have.
///
/// The notification extension words it as the app does for Telegram, with "(Telegram)" after the
/// chat's name and its picture as the app keeps it (`TelegramPictures`), and the app opens its chat
/// from it; where the extension doesn't run, iOS words it by itself, from the
/// sentence the app carries for each kind (`en.lproj/Localizable.strings`, written by
/// `apps/ios/scripts/telegram-push-texts.mjs` from the list Telegram publishes).
struct TelegramPush {
    enum Kind: Equatable {
        /// A message, or anything else to show.
        case message
        /// A chat read on another device, up to a message.
        case read
        /// Messages deleted.
        case deleted
        /// What changes something in Telegram's app and shows nothing: a muted chat's message, a
        /// data center's address, a story read, and the like.
        case quiet
    }

    /// The kind, as Telegram names it: `MESSAGE_TEXT`, `CHAT_MESSAGE_PHOTO`, `READ_HISTORY`…
    let key: String
    /// What its sentence names: who, which group, what they wrote.
    let args: [String]
    let kind: Kind
    /// The chat's key in the core (`chatKey` in packages/core/src/telegram/map.ts) and its group,
    /// which is TDLib's chat ID, if the push names one.
    let conversationKey: String?
    let groupId: String?
    /// The messages it's about, by TDLib's numbers.
    let messageIds: [String]
    /// Sent silently, so without a sound.
    let silent: Bool

    init?(_ userInfo: [AnyHashable: Any]) {
        // A server's push is sealed for this device under `zuna`: never Telegram's.
        guard userInfo["zuna"] == nil else { return nil }
        let data = userInfo["data"] as? [AnyHashable: Any] ?? [:]
        let alert = (userInfo["aps"] as? [AnyHashable: Any])?["alert"] as? [AnyHashable: Any]
        let key = alert?["loc-key"] as? String ?? userInfo["loc_key"] as? String ?? data["loc_key"] as? String
        guard let key, (1...64).contains(key.count), key.allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber || $0 == "_") }) else { return nil }
        self.key = key
        let rawArgs = alert?["loc-args"] as? [Any] ?? userInfo["loc_args"] as? [Any] ?? data["loc_args"] as? [Any] ?? []
        args = rawArgs.prefix(8).map { String(describing: $0).prefix(1024) }.map(String.init)
        let custom = userInfo["custom"] as? [AnyHashable: Any] ?? data["custom"] as? [AnyHashable: Any] ?? [:]
        // What the push names: in `custom`, as Telegram's page on pushes shows it, or beside `aps`,
        // where a push through Apple carries it, as Telegram's own app reads it.
        func value(_ name: String) -> Any? { custom[name] ?? data[name] ?? userInfo[name] }

        func number(_ name: String) -> Int64? {
            if let value = value(name) as? NSNumber { return value.int64Value }
            if let value = value(name) as? String { return Int64(value.trimmingCharacters(in: .whitespaces)) }
            return nil
        }
        // TDLib's chat IDs: a person's is theirs, a basic group's its negative, a supergroup's
        // -100 before its own; and a message's is its number on the server times 2^20.
        if let channel = number("channel_id"), channel > 0 {
            groupId = String(-(1_000_000_000_000 + channel))
        } else if let chat = number("chat_id"), chat > 0 {
            groupId = String(-chat)
        } else if let user = number("from_id"), user > 0 {
            groupId = String(user)
        } else {
            groupId = nil
        }
        conversationKey = groupId.map { $0.hasPrefix("-") ? "group:\($0)" : "user:\($0)" }
        let ids: [Int64]
        switch key {
        case "MESSAGE_DELETED":
            ids = (value("messages") as? String ?? "").split(separator: ",").compactMap { Int64($0.trimmingCharacters(in: .whitespaces)) }
        case "READ_HISTORY":
            ids = number("max_id").map { [$0] } ?? []
        default:
            ids = number("msg_id").map { [$0] } ?? []
        }
        messageIds = ids.filter { $0 > 0 && $0 < (1 << 42) }.map { String($0 << 20) }
        silent = value("silent") as? Bool ?? (value("silent") as? NSNumber)?.boolValue ?? (value("silent") as? String == "1")
        switch key {
        case "READ_HISTORY": kind = .read
        case "MESSAGE_DELETED": kind = .deleted
        case "MESSAGE_MUTED", "DC_UPDATE", "GEO_LIVE_PENDING", "SESSION_REVOKE", "READ_REACTION", "READ_STORIES", "STORY_DELETED": kind = .quiet
        default: kind = .message
        }
    }

    /// Whether it's from a group or a channel, rather than a person.
    private var inGroup: Bool { groupId?.hasPrefix("-") == true }

    /// The sentence for this kind, as the app carries it, with its words put in; nil for a kind
    /// the app doesn't know.
    var sentence: String? {
        let template = Self.texts.localizedString(forKey: key, value: "", table: nil)
        guard !template.isEmpty, template != key else { return nil }
        // Every placeholder is an object, numbered; a missing word is left empty rather than crashing.
        let words: [CVarArg] = (0..<8).map { $0 < args.count ? args[$0] : "" }
        return String(format: template, arguments: words)
    }

    /// The person's or the group's name: a group's is the second word of its sentences, a
    /// channel's and a person's the first.
    var name: String? {
        let name = inGroup && key.hasPrefix("CHAT_") && args.count >= 2 ? args[1] : args.first
        return name?.isEmpty == false ? name : nil
    }

    /// A chat's name as a notification's title has it, so it's never taken for a Zuna chat's.
    static func titled(_ name: String) -> String { "\(name) (Telegram)" }

    /// A notification as the app words Telegram's, as `Notifications.showTelegram` does while the
    /// app runs: the person or group as its title, with "(Telegram)" after it, and the message under
    /// it; with no names, "Zuna" and "Telegram" under it. `MessageNotification.telegram` then adds
    /// the chat's picture.
    func content(base: UNMutableNotificationContent, settings: NotificationSettings) -> UNMutableNotificationContent {
        let content = base
        let isText = key.hasSuffix("MESSAGE_TEXT")
        let text: String = {
            if isText, key == "MESSAGE_TEXT", args.count >= 2 { return args[1] }
            if isText, key == "CHAT_MESSAGE_TEXT", args.count >= 3 { return "\(args[0]): \(args[2])" }
            if isText, key == "CHANNEL_MESSAGE_TEXT", args.count >= 2 { return args[1] }
            return sentence ?? "New message"
        }()
        let title = name.map(Self.titled) ?? "Telegram"
        switch settings.preview {
        case .full:
            content.title = title
            content.body = text
        case .sender:
            content.title = title
            content.body = "New message"
        case .none:
            content.title = "Zuna"
            content.subtitle = "Telegram"
            content.body = "New message"
        }
        content.sound = silent || !settings.sound ? nil : .default
        content.categoryIdentifier = ""
        if let groupId {
            content.threadIdentifier = "telegram/\(groupId)"
            content.userInfo["groupId"] = groupId
        }
        content.userInfo["serverId"] = Self.serverId
        content.userInfo["telegramPush"] = true
        if let conversationKey { content.userInfo["conversationKey"] = conversationKey }
        if let messageId = messageIds.first { content.userInfo["messageId"] = messageId }
        return content
    }

    /// The server ID a linked Telegram account goes by (`TELEGRAM_ID` in the core).
    static let serverId = "telegram"

    /// The app's bundle, which carries the sentences, from the app or from an extension inside it.
    static let texts: Bundle = {
        let main = Bundle.main
        guard main.bundleURL.pathExtension == "appex" else { return main }
        return Bundle(url: main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()) ?? main
    }()
}
