import CryptoKit
import Foundation

/// What the app and its notification extension share about pushes, in the
/// App Group: each server's registration, the notification settings and the
/// badge count.
enum PushStore {
    /// One server's registration: the app's ID for it is what a push names,
    /// and the key is what the push is sealed with.
    struct Registration: Codable, Equatable {
        var serverId: String
        var key: Data
    }

    /// Hiding a notification needs Apple's notification filtering entitlement.
    /// Until it's granted, servers are told which chats are muted instead.
    static let canFilter = false

    static var defaults: UserDefaults {
        UserDefaults(suiteName: SharedStorage.appGroup) ?? .standard
    }

    /// Registrations by their ID.
    static func registrations() -> [String: Registration] {
        guard let data = defaults.data(forKey: "zuna-push-registrations") else { return [:] }
        return (try? JSONDecoder().decode([String: Registration].self, from: data)) ?? [:]
    }

    /// A server's registration, made the first time it's asked for.
    static func registration(for serverId: String) -> (id: String, registration: Registration) {
        var all = registrations()
        if let existing = all.first(where: { $0.value.serverId == serverId }) {
            return (existing.key, existing.value)
        }
        let id = random(16).map { String(format: "%02x", $0) }.joined()
        let registration = Registration(serverId: serverId, key: random(32))
        all[id] = registration
        save(all)
        return (id, registration)
    }

    /// Drops the registrations of servers this device is no longer on.
    static func keep(servers: [String]) {
        let all = registrations()
        let kept = all.filter { servers.contains($0.value.serverId) }
        if kept != all { save(kept) }
    }

    private static func save(_ registrations: [String: Registration]) {
        defaults.set(try? JSONEncoder().encode(registrations), forKey: "zuna-push-registrations")
    }

    private static func random(_ count: Int) -> Data {
        Data(SymmetricKey(size: SymmetricKeySize(bitCount: count * 8)).withUnsafeBytes { Array($0) })
    }

    /// What a push is about, opened with the registration's key: a new
    /// message, or, in a silent push, a chat read or a message deleted elsewhere;
    /// or a call ringing this person, and, silently, that it stopped.
    struct Message: Equatable {
        enum Kind: String {
            case message, read, delete
            case call
            case callEnd = "call_end"
        }

        let kind: Kind
        let serverId: String
        let groupId: String
        let messageId: String?
        /// For a call: who started it, and when, which says which call it is.
        var callerId: String? = nil
        var startedAt: Int? = nil
    }

    static func open(_ userInfo: [AnyHashable: Any]) -> Message? {
        guard let zuna = userInfo["zuna"] as? [String: Any],
              let id = zuna["r"] as? String,
              let sealed = (zuna["p"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let registration = registrations()[id],
              let box = try? AES.GCM.SealedBox(combined: sealed),
              let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: registration.key), authenticating: Data("zuna/push/v1|\(id)".utf8)),
              let fields = try? JSONDecoder().decode([String: String].self, from: plaintext),
              let kind = Message.Kind(rawValue: fields["t"] ?? "message"),
              let groupId = fields["g"] else { return nil }
        return Message(kind: kind, serverId: registration.serverId, groupId: groupId, messageId: fields["m"], callerId: fields["c"], startedAt: fields["s"].flatMap { Int($0) })
    }

    /// The badge on the app's icon: the app sets it to the unread count, and
    /// the extension adds one for each notification it shows meanwhile.
    static var badge: Int {
        get { defaults.integer(forKey: "zuna-badge") }
        set { defaults.set(max(0, newValue), forKey: "zuna-badge") }
    }
}

/// Notification settings for this device, as on the desktop (state/settings.ts).
/// They're in the App Group, so the extension follows them too.
struct NotificationSettings: Codable, Equatable, Sendable {
    enum Preview: String, Codable, CaseIterable, Sendable {
        /// The sender and the message.
        case full
        /// Only who it's from.
        case sender
        /// Only that something arrived.
        case none
    }

    var enabled = true
    var sound = true
    var preview = Preview.full

    static func load() -> NotificationSettings {
        guard let data = PushStore.defaults.data(forKey: "zuna-notification-settings"),
              let settings = try? JSONDecoder().decode(NotificationSettings.self, from: data) else { return NotificationSettings() }
        return settings
    }

    func save() {
        PushStore.defaults.set(try? JSONEncoder().encode(self), forKey: "zuna-notification-settings")
    }

    #if DEBUG
    /// For tests that start from a fresh install.
    static func reset() {
        PushStore.defaults.removeObject(forKey: "zuna-notification-settings")
        PushStore.defaults.removeObject(forKey: "zuna-push-registrations")
        PushStore.defaults.removeObject(forKey: "zuna-badge")
        for key in PushStore.defaults.dictionaryRepresentation().keys where key.hasPrefix("zuna-relay-handle|") {
            PushStore.defaults.removeObject(forKey: key)
        }
    }
    #endif
}
