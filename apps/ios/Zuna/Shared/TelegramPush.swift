import CryptoKit
import Foundation
import os
import UserNotifications
import ZunaModels

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

    /// The kind, as Telegram names it: `MESSAGE_TEXT`, `CHAT_MESSAGE_PHOTO`, `READ_HISTORY`…; empty
    /// for a push that names none, which shows its alert's own words.
    let key: String
    /// What its sentence names: who, which group, what they wrote.
    let args: [String]
    /// The alert's title and text, as Telegram's server wrote them.
    let alertTitle: String?
    let alertBody: String?
    /// Where the kind was found, for the log: beside `aps`, in the alert, under `data`, or nowhere.
    let keyFrom: String
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
        let aps = userInfo["aps"] as? [AnyHashable: Any]
        let alert = aps?["alert"] as? [AnyHashable: Any]
        // The kind and its words: beside `aps`, as Telegram's own app reads them, since a push to an
        // iPhone carries none in its alert (seen on one on 2026-11-15); in the alert, where Apple's
        // own sentences go; or under `data`, as Telegram's page on pushes shows them. With a dash or
        // an underscore, which the page and the app spell differently.
        func look(_ name: String) -> (place: String, value: Any)? {
            let spellings = [name, name.replacingOccurrences(of: "-", with: "_")]
            for (place, fields) in [("root", userInfo), ("alert", alert ?? [:]), ("data", data)] {
                if let value = spellings.lazy.compactMap({ fields[$0] }).first { return (place, value) }
            }
            return nil
        }
        func text(_ value: Any?) -> String? {
            (value as? String).map { String($0.prefix(1024)) }.flatMap { $0.isEmpty ? nil : $0 }
        }
        alertTitle = text(alert?["title"])
        alertBody = text(alert?["body"]) ?? text(aps?["alert"])
        let found = look("loc-key")
        if let found {
            guard let key = found.value as? String, (1...64).contains(key.count),
                  key.allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber || $0 == "_") }) else { return nil }
            self.key = key
            keyFrom = found.place
        } else {
            // Nothing else pushes this app unsealed, so an alert with no kind is Telegram's too, worded by its server.
            guard alertTitle != nil || alertBody != nil else { return nil }
            key = ""
            keyFrom = "none"
        }
        let rawArgs = look("loc-args")?.value as? [Any] ?? []
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
        guard !key.isEmpty else { return nil }
        let template = Self.texts.localizedString(forKey: key, value: "", table: nil)
        guard !template.isEmpty, template != key else { return nil }
        // Every placeholder is an object, numbered; a missing word is left empty rather than crashing.
        let words: [CVarArg] = (0..<8).map { $0 < args.count ? args[$0] : "" }
        return String(format: template, arguments: words)
    }

    /// The person's or the group's name: a group's is the second word of its sentences, a
    /// channel's and a person's the first, and the alert's title for a push with no words.
    var name: String? {
        let name = inGroup && key.hasPrefix("CHAT_") && args.count >= 2 ? args[1] : args.first ?? alertTitle
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
            return sentence ?? alertBody ?? t("notify.newMessage")
        }()
        let title = name.map(Self.titled) ?? "Telegram"
        switch settings.preview {
        case .full:
            content.title = title
            content.body = text
        case .sender:
            content.title = title
            content.body = t("notify.newMessage")
        case .none:
            content.title = "Zuna"
            content.subtitle = "Telegram"
            content.body = t("notify.newMessage")
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

    /// Takes away what a chat read, or messages deleted, on another device leave behind
    /// (`READ_HISTORY`, `MESSAGE_DELETED`): a read chat's notifications up to the message it was
    /// read to, as one that came after it is still unread, and the deleted messages'. Each was
    /// counted in the badge, which goes down with them. The extension does it for a push it's
    /// handed, and the app for one iOS hands it silently, whichever way Telegram sends it; the
    /// other then finds nothing left. Returns how many went.
    static func clear(_ push: TelegramPush) async -> Int {
        guard push.kind == .read || push.kind == .deleted, let groupId = push.groupId else { return 0 }
        let ids = Set(push.messageIds.compactMap { Int64($0) })
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let stale = delivered.filter { notification in
            let info = notification.request.content.userInfo
            let messageId: String?
            if info["serverId"] as? String == serverId {
                // Worded by the extension, or shown by the app while it ran.
                guard info["groupId"] as? String == groupId else { return false }
                messageId = info["messageId"] as? String
            } else if info["serverId"] == nil, let shown = TelegramPush(info), shown.kind == .message {
                // Shown by iOS itself, where the extension didn't run, with only Telegram's fields.
                guard shown.groupId == groupId else { return false }
                messageId = shown.messageIds.first
            } else {
                return false
            }
            let id = messageId.flatMap { Int64($0) }
            if push.kind == .deleted { return id.map(ids.contains) ?? false }
            guard let readTo = ids.max(), let id else { return true }
            return id <= readTo
        }.map(\.request.identifier)
        let by = Bundle.main.bundleURL.pathExtension == "appex" ? "extension" : "app"
        Logger(subsystem: "chat.zuna", category: "notifications")
            .notice("Telegram said a chat was \(push.kind == .read ? "read" : "deleted from", privacy: .public) elsewhere, to the \(by, privacy: .public): clearing \(stale.count) of \(delivered.count) notifications")
        guard !stale.isEmpty else { return 0 }
        center.removeDeliveredNotifications(withIdentifiers: stale)
        PushStore.badge -= stale.count
        return stale.count
    }

    // MARK: What a push showed

    /// How many messages the extension remembers showing: more than come while the app is away.
    private static let remembered = 300
    private static let shownKey = "zuna-telegram-shown"

    /// A message's tag in what the extension remembers, made with a key from the device key, so
    /// nothing kept says which chats had messages; nil while the device key is locked.
    private static func tag(groupId: String, messageId: String) -> String? {
        guard let deviceKey = DeviceKeyStore.unlockedKey() else { return nil }
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: deviceKey), info: Data("zuna/telegram/shown/v1".utf8), outputByteCount: 32)
        let mac = HMAC<SHA256>.authenticationCode(for: Data("\(groupId)/\(messageId)".utf8), using: key)
        return Data(mac).prefix(12).base64EncodedString()
    }

    /// Remembers a message the extension showed, for `shown`.
    static func remember(groupId: String, messageId: String) {
        guard let tag = tag(groupId: groupId, messageId: messageId) else { return }
        var tags = PushStore.defaults.stringArray(forKey: shownKey) ?? []
        guard !tags.contains(tag) else { return }
        tags.append(tag)
        PushStore.defaults.set(Array(tags.suffix(remembered)), forKey: shownKey)
    }

    /// Whether this message was shown already: the engine, catching up as the app opens, hears of
    /// what came while it was away as new, though Telegram pushed it. Its notification is still
    /// there, worded by the extension, by iOS or by the app, or the extension remembers showing it,
    /// as after the person cleared it.
    static func shown(groupId: String, messageId: String) async -> Bool {
        let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
        let there = delivered.contains { notification in
            let info = notification.request.content.userInfo
            if info["serverId"] as? String == serverId {
                // Worded by the extension, or by the app itself already.
                return info["groupId"] as? String == groupId && info["messageId"] as? String == messageId
            }
            guard info["serverId"] == nil, let push = TelegramPush(info) else { return false }
            return push.groupId == groupId && push.messageIds.first == messageId
        }
        if there { return true }
        guard let tag = tag(groupId: groupId, messageId: messageId) else { return false }
        return PushStore.defaults.stringArray(forKey: shownKey)?.contains(tag) == true
    }

    /// Forgets what the extension showed, as the account is unlinked.
    static func forgetShown() {
        PushStore.defaults.removeObject(forKey: shownKey)
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
