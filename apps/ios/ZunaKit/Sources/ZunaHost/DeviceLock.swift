import Darwin
import Foundation
import ZunaCrypto

/// The device key, locked with account passwords.
///
/// The app asks for a Zuna password once after every restart of the phone. On
/// disk, the key that encrypts all local data exists only sealed with a key
/// derived from the password (Argon2id, like account passwords), one copy per
/// account signed in on this device, so any of their passwords unlocks it.
/// After unlocking, the app keeps the key in the Keychain tied to the current
/// boot session (see `BootSession`) and forgets it after the next restart.
///
/// The usernames and server addresses here aren't encrypted: the unlock screen
/// has to show them before anything can be decrypted.
public struct DeviceLock: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable, Identifiable {
        public var serverUrl: String
        public var username: String
        public var serverName: String
        public var salt: Data
        public var memory: UInt32
        public var iterations: UInt32
        public var sealed: Data

        public var id: String { "\(username.lowercased())@\(serverUrl)" }
    }

    public var version = 1
    public var entries: [Entry] = []

    public static let fileName = "device-lock.json"
    /// The same work factor as account passwords (`DEFAULT_KDF` in the core).
    static let memory: UInt32 = 64 << 10
    static let iterations: UInt32 = 3

    public init() {}

    public static func load(from directory: URL) -> DeviceLock? {
        let url = directory.appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(DeviceLock.self, from: data)
    }

    public func save(to directory: URL) throws {
        let url = directory.appendingPathComponent(Self.fileName)
        if entries.isEmpty {
            try? FileManager.default.removeItem(at: url)
            return
        }
        try JSONEncoder().encode(self).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Seals the device key with a password, replacing any earlier entry for the same account.
    public mutating func add(deviceKey: Data, password: String, serverUrl: String, username: String, serverName: String) throws {
        let salt = try randomBytes(len: 16)
        let key = try Self.unlockKey(password: password, salt: salt, memory: Self.memory, iterations: Self.iterations)
        let sealed = try aeadSeal(key: key, plaintext: deviceKey, aad: Self.aad(serverUrl: serverUrl, username: username))
        remove(serverUrl: serverUrl, username: username)
        entries.append(Entry(
            serverUrl: serverUrl, username: username, serverName: serverName,
            salt: salt, memory: Self.memory, iterations: Self.iterations, sealed: sealed
        ))
    }

    public mutating func remove(serverUrl: String, username: String) {
        entries.removeAll { $0.serverUrl == serverUrl && $0.username.lowercased() == username.lowercased() }
    }

    /// The device key, or nil if the password is wrong. Slow on purpose (Argon2id), so call it off the main thread.
    public static func unlock(_ entry: Entry, password: String) -> Data? {
        // Refuse weakened parameters, like the core does for account passwords.
        guard entry.memory >= 32 << 10, entry.iterations >= 2,
              let key = try? unlockKey(password: password, salt: entry.salt, memory: entry.memory, iterations: entry.iterations) else {
            return nil
        }
        return try? aeadOpen(key: key, data: entry.sealed, aad: aad(serverUrl: entry.serverUrl, username: entry.username))
    }

    static func unlockKey(password: String, salt: Data, memory: UInt32, iterations: UInt32) throws -> Data {
        // NFKC, like the core, so the same password typed differently still matches.
        let normalized = Data(password.precomposedStringWithCompatibilityMapping.utf8)
        let master = try argon2id(password: normalized, salt: salt, memoryKib: memory, iterations: iterations, parallelism: 1, outLen: 32)
        return try hkdfSha256(ikm: master, salt: Data(), info: Data("zuna/local/unlock/v1".utf8), len: 32)
    }

    private static func aad(serverUrl: String, username: String) -> Data {
        Data("zuna/local/unlock/v1|\(serverUrl)|\(username.lowercased())".utf8)
    }
}

/// Identifies the current run of the operating system, which changes with every
/// restart. The unlocked device key is only kept for one boot session.
public enum BootSession {
    public static var current: String {
        #if DEBUG
        // Lets tests simulate a restart of the phone.
        if let override = UserDefaults.standard.string(forKey: "ZunaBootSession") { return override }
        #endif
        if let session = sysctlString("kern.bootsessionuuid"), !session.isEmpty { return session }
        var bootTime = timeval()
        var size = MemoryLayout<timeval>.size
        if sysctlbyname("kern.boottime", &bootTime, &size, nil, 0) == 0 {
            return "boottime-\(bootTime.tv_sec)"
        }
        return "unknown"
    }

    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}
