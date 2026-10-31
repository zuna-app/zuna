import Foundation

/// Settings that belong to this device rather than an account, as on the
/// desktop (state/settings.ts). Notification settings come with notifications.
struct AppSettings: Codable, Equatable, Sendable {
    var accent: Accent = .neutral
    var messageSize: MessageSize = .medium
    var reduceMotion = false
    /// Return sends on a hardware keyboard; the on-screen keyboard always inserts a new line.
    var enterToSend = true

    private static let key = "zuna-settings"

    static func load() -> AppSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let settings = try? JSONDecoder().decode(AppSettings.self, from: data) else { return AppSettings() }
        return settings
    }

    #if DEBUG
    /// For tests that start from a fresh install.
    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
    }
    #endif

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
