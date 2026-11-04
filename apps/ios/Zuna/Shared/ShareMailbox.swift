import CryptoKit
import Foundation
import ZunaModels

/// A chat something can be shared to, as the share extension lists it.
struct ShareTarget: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case person, saved, group, textChannel, voiceChannel
    }

    var serverId: String
    /// The conversation's key: `user:<id>` or `group:<id>`.
    var key: String
    var title: String
    var kind: Kind
    /// What a picture-less avatar's color comes from, as in the app.
    var seed: String
    var avatar: AvatarRef?
    /// The line under the name, as the chat list has it: the latest message, or a channel's topic.
    var subtitle = ""

    /// As notifications name a conversation, and so as the share sheet's suggestions do.
    var id: String { "\(serverId)/\(key)" }
}

/// One server's chats, in its chat list's order, then its channels.
struct ShareServer: Codable, Identifiable, Sendable {
    var id: String
    var name: String
    var url: String
    var hasIcon: Bool
    var targets: [ShareTarget]

    /// What the share extension offers of a server: the chats you could write in, as the forward sheet does.
    init(entry: ServerEntry, selfId: String?, users: [String: UserView], conversations: [ConversationView], channels: [ChannelView], hidden: [String]) {
        id = entry.id
        name = entry.name
        url = entry.url
        hasIcon = entry.hasIcon
        let open = { (chat: ConversationView) in !chat.removed && !chat.blocked && !hidden.contains(chat.key) }
        let latest = { (chat: ConversationView) -> String in
            let (author, body) = Format.preview(chat.lastMessage, users: users, selfId: selfId ?? "", kind: chat.kind)
            return author.map { "\($0): \(body)" } ?? body
        }
        var targets = conversations.filter(open).map { chat in
            let saved = chat.peerId != nil && chat.peerId == selfId
            return ShareTarget(
                serverId: entry.id,
                key: chat.key,
                title: chat.title,
                kind: saved ? .saved : chat.kind == .dm ? .person : .group,
                seed: chat.peerId ?? chat.groupId ?? chat.key,
                avatar: chat.avatar,
                subtitle: saved && chat.lastMessage == nil ? "Notes to yourself" : latest(chat)
            )
        }
        for channel in channels where !channel.unreadable {
            guard let chat = channel.conversation, open(chat) else { continue }
            targets.append(ShareTarget(
                serverId: entry.id,
                key: chat.key,
                title: channel.name,
                kind: channel.type == .voice ? .voiceChannel : .textChannel,
                seed: channel.id,
                subtitle: channel.topic.isEmpty ? latest(chat) : channel.topic
            ))
        }
        self.targets = entry.signedOut == nil ? targets : []
    }
}

/// What's being shared, and to which chats. The files are in the request's folder.
struct ShareRequest: Codable, Sendable {
    var targets: [ShareTarget]
    var text: String
    var files: [OutgoingFile]
}

/// How a request handed to the app went.
struct ShareResult: Codable, Sendable {
    /// Nil if everything went.
    var error: String?
}

/// How the share extension and the app talk while the app runs, since then the
/// app's core is the one sending: Darwin notifications, which carry nothing,
/// and files in the App Group, sealed with a key from the device key, which
/// both have.
///
/// The extension asks for the chats, and the app writes them to `targets`.
/// For a send, the extension leaves a folder with its files and `request`;
/// the app renames that `taken`, sends, and writes `result`.
enum ShareMailbox {
    static let askTargets = "chat.zuna.mobile.share.ask"
    static let targetsReady = "chat.zuna.mobile.share.targets"
    static let send = "chat.zuna.mobile.share.send"
    static let sent = "chat.zuna.mobile.share.sent"

    /// Where requests wait: the App Group container, outside the databases' folder.
    static func folder() throws -> URL {
        let fileManager = FileManager.default
        guard let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: SharedStorage.appGroup) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let folder = container.appendingPathComponent("Share", isDirectory: true)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return folder
    }

    static var targetsFile: URL {
        get throws { try folder().appendingPathComponent("targets") }
    }

    /// A new folder for one share's files and request.
    static func newRequestFolder() throws -> URL {
        let folder = try folder().appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// The folders with a request nobody has taken yet.
    static func waitingRequests() -> [URL] {
        guard let folder = try? folder(),
              let entries = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return [] }
        return entries.filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("request").path) }
    }

    /// Clears what's left of shares from more than an hour ago, which a process ended in the middle of.
    static func clearOld() {
        guard let folder = try? folder(),
              let entries = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let hourAgo = Date().addingTimeInterval(-3600)
        for entry in entries where entry.hasDirectoryPath {
            let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if modified < hourAgo { try? FileManager.default.removeItem(at: entry) }
        }
    }

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    }

    static func write<Value: Encodable>(_ value: Value, to url: URL, deviceKey: Data) throws {
        let data = try JSONEncoder().encode(value)
        let sealed = try AES.GCM.seal(data, using: key(deviceKey)).combined!
        try sealed.write(to: url, options: .atomic)
    }

    static func read<Value: Decodable>(_ type: Value.Type, from url: URL, deviceKey: Data) throws -> Value {
        let box = try AES.GCM.SealedBox(combined: Data(contentsOf: url))
        return try JSONDecoder().decode(type, from: AES.GCM.open(box, using: key(deviceKey)))
    }

    private static func key(_ deviceKey: Data) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: deviceKey), info: Data("zuna/ios/share".utf8), outputByteCount: 32)
    }
}

/// Calls `heard` on the main thread each time another process posts the Darwin notification.
final class DarwinObserver: @unchecked Sendable {
    private let name: String
    private let heard: @MainActor () -> Void

    init(_ name: String, heard: @escaping @MainActor () -> Void) {
        self.name = name
        self.heard = heard
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(), { _, observer, _, _, _ in
            guard let observer else { return }
            let me = Unmanaged<DarwinObserver>.fromOpaque(observer).takeUnretainedValue()
            DispatchQueue.main.async { MainActor.assumeIsolated { me.heard() } }
        }, name as CFString, nil, .deliverImmediately)
    }

    deinit {
        CFNotificationCenterRemoveObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(), CFNotificationName(name as CFString), nil)
    }
}

/// Sends what was shared through a core, the app's or the extension's own, as
/// the composer would: up to ten files a message, the text with the first.
enum ShareSender {
    static func send(_ request: ShareRequest, through core: CoreConnection) async throws {
        let settings = AppSettings.load()
        let text = request.text.trimmingCharacters(in: .whitespacesAndNewlines)
        var previewUrl: String?
        if settings.linkPreviews, !text.isEmpty { previewUrl = (try? await core.findLink(text)) ?? nil }
        let batches = stride(from: 0, to: request.files.count, by: OutgoingFiles.limit).map {
            Array(request.files[$0..<min($0 + OutgoingFiles.limit, request.files.count)])
        }
        var failed: [String] = []
        for target in request.targets {
            let session = core.session(target.serverId)
            do {
                if batches.isEmpty, !text.isEmpty {
                    try await session.sendNow(target.key, files: [], body: MessageBody(text: text), previewUrl: previewUrl)
                }
                for (index, files) in batches.enumerated() {
                    let body = MessageBody(text: index == 0 && !text.isEmpty ? text : nil)
                    try await session.sendNow(target.key, files: files, body: body, previewUrl: index == 0 ? previewUrl : nil, keepMetadata: !settings.removeMetadata)
                }
            } catch {
                failed.append("\(target.title): \(error)")
            }
        }
        if !failed.isEmpty { throw ShareFailure(message: failed.joined(separator: "\n")) }
    }

    /// Tells iOS who was shared to, for the share sheet's suggestions, once whoever
    /// waits on the send has heard how it went.
    static func suggest(_ request: ShareRequest, through core: CoreConnection) async {
        for target in request.targets {
            await ShareSuggestions.sent(to: target.key, on: target.serverId, title: target.title, avatar: target.avatar, through: core)
        }
    }
}

struct ShareFailure: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}
