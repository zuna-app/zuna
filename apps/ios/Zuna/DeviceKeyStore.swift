import Foundation
import Security
import ZunaHost

/// The unlocked device key, kept in the Keychain for the current boot session
/// only. Locked copies live in `DeviceLock`; after a restart of the phone this
/// copy is discarded and the app asks for a password again.
///
/// It's readable after the first unlock since the phone started, so a future
/// notification extension can use it while the phone is locked. It never
/// leaves this device: it isn't synced to iCloud Keychain or included in backups.
enum DeviceKeyStore {
    static let accessGroup = "SGKB9R23YT.chat.zuna.shared"
    private static let service = "chat.zuna.device-key"
    private static let account = "unlocked"

    enum Failure: Error {
        case keychain(OSStatus)
        case randomness
    }

    /// The unlocked key, if it was unlocked during this boot session.
    static func unlockedKey() -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let item = result as? [String: Any],
              let key = item[kSecValueData as String] as? Data, key.count == 32 else { return nil }
        let session = (item[kSecAttrGeneric as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
        guard session == BootSession.current else {
            // Unlocked before the phone restarted: forget it.
            forget()
            return nil
        }
        return key
    }

    /// Keeps the key until the phone restarts.
    static func keep(_ key: Data) throws {
        forget()
        var item = baseQuery
        item[kSecValueData as String] = key
        item[kSecAttrGeneric as String] = Data(BootSession.current.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    static func forget() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    static func newKey() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.randomness }
        return Data(bytes)
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}
