import CryptoKit
import Foundation

/// The pictures of the linked Telegram account's chats, small, for its notifications, which the
/// notification extension can't ask the engine for: it shares nothing with the helper, where
/// TDLib keeps them. The app keeps them here as it lists the chats (`TelegramPictureKeeper`), in
/// the App Group, each sealed with a key made from the device key, under a name made from the
/// chat's with another, so nothing in the folder says whose a picture is. Without the device key,
/// as before the phone's first unlock with the Zuna password, a notification has initials instead.
enum TelegramPictures {
    /// How many chats keep a picture: the top of the list, which is where messages come from.
    static let most = 100

    private static let info = "zuna/telegram/pictures/v1"

    /// The keys, made once for all the pictures a pass reads or writes.
    struct Keys {
        fileprivate let seal: SymmetricKey
        fileprivate let name: SymmetricKey
    }

    static func keys() -> Keys? {
        guard let deviceKey = DeviceKeyStore.unlockedKey() else { return nil }
        let base = SymmetricKey(data: deviceKey)
        func derive(_ what: String) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: base, info: Data("\(info)|\(what)".utf8), outputByteCount: 32)
        }
        return Keys(seal: derive("seal"), name: derive("name"))
    }

    private static var folder: URL? {
        try? SharedStorage.dataDirectory().appendingPathComponent("telegram-pictures", isDirectory: true)
    }

    private static func file(_ chatId: String, _ keys: Keys) -> URL? {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(chatId.utf8), using: keys.name)
        return folder?.appendingPathComponent(Data(mac).prefix(16).map { String(format: "%02x", $0) }.joined())
    }

    /// A chat's picture and which of Telegram's files it was made from, by TDLib's chat ID.
    static func read(_ chatId: String, _ keys: Keys) -> (picture: Data, version: String)? {
        guard let url = file(chatId, keys), let sealed = try? Data(contentsOf: url),
              let box = try? AES.GCM.SealedBox(combined: sealed),
              let opened = try? AES.GCM.open(box, using: keys.seal, authenticating: Data("\(info)|\(chatId)".utf8)),
              let length = opened.first, opened.count > 1 + Int(length) else { return nil }
        let version = String(decoding: opened.dropFirst().prefix(Int(length)), as: UTF8.self)
        return (Data(opened.dropFirst(1 + Int(length))), version)
    }

    /// A chat's picture, for its notification.
    static func picture(_ chatId: String) -> Data? {
        keys().flatMap { read(chatId, $0)?.picture }
    }

    static func keep(_ picture: Data, version: String, for chatId: String, _ keys: Keys) {
        guard let folder, let url = file(chatId, keys) else { return }
        let named = Data(version.utf8.prefix(255))
        guard let sealed = try? AES.GCM.seal(Data([UInt8(named.count)]) + named + picture, using: keys.seal, authenticating: Data("\(info)|\(chatId)".utf8)).combined else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? sealed.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func forget(_ chatId: String, _ keys: Keys) {
        if let url = file(chatId, keys) { try? FileManager.default.removeItem(at: url) }
    }

    /// Every picture but those of these chats, as they leave the top of the list.
    static func keepOnly(_ chatIds: [String], _ keys: Keys) {
        guard let folder, let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
        let kept = Set(chatIds.compactMap { file($0, keys)?.lastPathComponent })
        for name in names where !kept.contains(name) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    /// All of them, as the account is unlinked.
    static func eraseAll() {
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }
}
