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
    /// This device fetches a page to preview the first link in a message being written.
    var linkPreviews = true
    /// Before a file is sent, this device takes out where, when and on what it was made.
    var removeMetadata = true

    private static let key = "zuna-settings"

    /// In the App Group, so the share extension follows them too: App lock, link previews and metadata.
    private static var shared: UserDefaults { UserDefaults(suiteName: SharedStorage.appGroup) ?? .standard }

    static func load() -> AppSettings {
        guard let data = shared.data(forKey: key),
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
        linkPreviews = try container.decodeIfPresent(Bool.self, forKey: .linkPreviews) ?? true
        removeMetadata = try container.decodeIfPresent(Bool.self, forKey: .removeMetadata) ?? true
    }

    init() {}

    /// The server that was open last, to open it again at launch, and first in the share extension.
    static var lastServer: String? {
        get { shared.string(forKey: lastServerKey) }
        set { shared.set(newValue, forKey: lastServerKey) }
    }

    private static let lastServerKey = "zuna-last-server"

    /// The channel headings folded on this device, by name, as the desktop remembers them.
    static var collapsedCategories: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: collapsedKey) ?? []) }
        set { UserDefaults.standard.set(newValue.sorted(), forKey: collapsedKey) }
    }

    private static let collapsedKey = "zuna-collapsed-categories"

    /// A channel's member list was hidden on this device, which keeps it hidden in every channel, as on the desktop.
    static let memberListHiddenKey = "zuna-member-list-hidden"

    #if DEBUG
    /// For tests that start from a fresh install.
    static func reset() {
        shared.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
        shared.removeObject(forKey: lastServerKey)
        UserDefaults.standard.removeObject(forKey: lastServerKey)
        UserDefaults.standard.removeObject(forKey: collapsedKey)
        UserDefaults.standard.removeObject(forKey: memberListHiddenKey)
    }
    #endif

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        Self.shared.set(data, forKey: Self.key)
        UserDefaults.standard.removeObject(forKey: Self.key)
    }
}
