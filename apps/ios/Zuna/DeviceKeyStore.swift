import Foundation
import Security

/// The 32-byte device key that encrypts everything the core stores locally.
///
/// It lives in the Keychain, readable after the first unlock since the phone
/// started, so the app opens without a password and a future notification
/// extension can decrypt messages while the phone is locked. It never leaves
/// this device: it isn't synced to iCloud Keychain or included in backups.
enum DeviceKeyStore {
    static let accessGroup = "SGKB9R23YT.chat.zuna.shared"
    private static let service = "chat.zuna.device-key"
    private static let account = "device-key"

    enum Failure: Error {
        case keychain(OSStatus)
        case randomness
    }

    /// The stored key, or nil if there isn't one yet.
    static func load() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count == 32 else { throw Failure.keychain(status) }
        return data
    }

    /// Creates and stores a new key.
    static func create() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.randomness }
        let key = Data(bytes)
        var item = baseQuery
        item[kSecValueData as String] = key
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        return key
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
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
