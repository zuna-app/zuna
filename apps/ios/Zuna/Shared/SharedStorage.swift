import Foundation

/// What the app shares with its notification extension: the App Group
/// container, where the databases live.
enum SharedStorage {
    static let appGroup = "group.chat.zuna.mobile"

    /// Where the databases live: the App Group container, so the notification
    /// extension can read them. Protected until the first unlock after a
    /// restart, and kept out of backups, since they're useless without the
    /// device key.
    static func dataDirectory() throws -> URL {
        let fileManager = FileManager.default
        let base = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var directory = base.appendingPathComponent("Zuna", isDirectory: true)
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory
    }
}
