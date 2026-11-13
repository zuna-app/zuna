import Foundation
import Security
import ZunaHost

/// The SOCKS5 proxy set in Privacy, which everything this device sends goes through
/// (docs/SOCKS5.md). It belongs to the device, not an account, as it's needed before there
/// is one: the address, port and username in the App Group, the password in the keychain group
/// the extensions share, so that the notification and share extensions use the same proxy. The
/// password is readable after the first unlock since the phone started, as the extension needs it
/// while the phone is locked, and never leaves this device.
enum ProxyStore {
    struct Setting: Codable, Equatable {
        var on = false
        var host = ""
        var port: UInt16 = 1080
        var username = ""
    }

    private static let key = "zuna-proxy"
    private static let service = "chat.zuna.proxy-password"
    private static let account = "password"

    private static var shared: UserDefaults { UserDefaults(suiteName: SharedStorage.appGroup) ?? .standard }

    static func load() -> Setting {
        guard let data = shared.data(forKey: key), let setting = try? JSONDecoder().decode(Setting.self, from: data) else { return Setting() }
        return setting
    }

    /// Keeps the setting, and the password with it: nil keeps the one already kept, and an empty one forgets it.
    static func save(_ setting: Setting, password: String?) throws {
        if let password {
            forgetPassword()
            if !password.isEmpty {
                var item = baseQuery
                item[kSecValueData as String] = Data(password.utf8)
                item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                let status = SecItemAdd(item as CFDictionary, nil)
                guard status == errSecSuccess else { throw DeviceKeyStore.Failure.keychain(status) }
            }
        }
        shared.set(try JSONEncoder().encode(setting), forKey: key)
    }

    static func password() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static var keepsPassword: Bool { password() != nil }

    static func forgetPassword() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    /// The proxy in use: the setting with its password, when it's on.
    static func inUse() -> NetworkProxy? {
        #if DEBUG
        // A check's proxy, for that run alone (`-ZunaProxy socks5://user:password@host:port`).
        if let given = UserDefaults.standard.string(forKey: "ZunaProxy") { return NetworkProxy(url: given) }
        #endif
        let setting = load()
        guard setting.on, !setting.host.isEmpty, setting.port > 0 else { return nil }
        return NetworkProxy(host: setting.host, port: setting.port, username: setting.username, password: password() ?? "")
    }

    /// Sets this process to go through the proxy in use, and says whether that changed anything.
    /// Each process does this before its core starts, so nothing goes out the old way.
    @discardableResult
    static func apply() -> Bool {
        NetworkProxy.use(inUse())
    }

    #if DEBUG
    /// For tests that start from a fresh install.
    static func reset() {
        shared.removeObject(forKey: key)
        forgetPassword()
    }
    #endif

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: DeviceKeyStore.accessGroup,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}
