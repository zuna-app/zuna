import Foundation

/// Settings that belong to this device rather than an account, as on the
/// desktop (state/settings.ts). Notification settings come with notifications.
struct AppSettings: Codable, Equatable, Sendable {
    var accent: Accent = .neutral
    var messageSize: MessageSize = .medium
    var reduceMotion = false
    /// Return sends on a hardware keyboard; the on-screen keyboard always inserts a new line.
    var enterToSend = true
    /// Face ID, Touch ID or the passcode each time the app opens, and a cover in the app switcher.
    var appLock = false

    private static let key = "zuna-settings"

    static func load() -> AppSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let settings = try? JSONDecoder().decode(AppSettings.self, from: data) else { return AppSettings() }
        return settings
    }

    // Settings saved by an earlier version lack the newer fields; they take their defaults.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accent = try container.decodeIfPresent(Accent.self, forKey: .accent) ?? .neutral
        messageSize = try container.decodeIfPresent(MessageSize.self, forKey: .messageSize) ?? .medium
        reduceMotion = try container.decodeIfPresent(Bool.self, forKey: .reduceMotion) ?? false
        enterToSend = try container.decodeIfPresent(Bool.self, forKey: .enterToSend) ?? true
        appLock = try container.decodeIfPresent(Bool.self, forKey: .appLock) ?? false
    }

    init() {}

    /// The server that was open last, to open it again at launch.
    static var lastServer: String? {
        get { UserDefaults.standard.string(forKey: lastServerKey) }
        set { UserDefaults.standard.set(newValue, forKey: lastServerKey) }
    }

    private static let lastServerKey = "zuna-last-server"

    #if DEBUG
    /// For tests that start from a fresh install.
    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: lastServerKey)
    }
    #endif

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
