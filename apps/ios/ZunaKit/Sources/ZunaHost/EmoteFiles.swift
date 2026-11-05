import CryptoKit
import Foundation

/// 7TV emote pictures as each Zuna server serves them (`/api/emotes/<id>/<1x|2x|3x>.webp`),
/// kept on disk. A server's whole set is fetched ahead, as the desktop and the web fetch it
/// into the browser's cache (`prefetchEmotes` in packages/ui/src/lib/media.ts), so showing an
/// emote asks the server for nothing, and it can't tell from that who read what, or when.
/// URLSession's own cache is too small to fetch a whole set into, hence a folder of its own.
public final class EmoteFiles: Sendable {
    public static let sizes = ["1x", "2x", "3x"]
    static let atOnce = 2

    public static let shared = EmoteFiles(
        directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Emotes", isDirectory: true)
    )

    let directory: URL
    private let session: URLSession
    /// For fetching ahead, which waits while someone has asked to save data.
    private let ahead: URLSession

    public init(directory: URL, configuration: URLSessionConfiguration = .ephemeral) {
        // No cookies and no cache besides this one.
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        self.directory = directory
        session = URLSession(configuration: configuration, delegate: PinnedServers.shared, delegateQueue: nil)
        let saving = configuration.copy() as! URLSessionConfiguration
        saving.allowsConstrainedNetworkAccess = false
        ahead = URLSession(configuration: saving, delegate: PinnedServers.shared, delegateQueue: nil)
    }

    var aheadConfiguration: URLSessionConfiguration { ahead.configuration }

    /// A picture's bytes: from disk when it's there, otherwise fetched and kept.
    public func data(_ id: String, _ size: String, serverUrl: String) async -> Data? {
        guard let file = file(id, size, serverUrl: serverUrl) else { return nil }
        if let data = try? Data(contentsOf: file), !data.isEmpty { return data }
        guard let data = try? await fetch(id, size, serverUrl: serverUrl, with: session) else { return nil }
        keep(data, at: file)
        return data
    }

    /// Fetches whatever of a server's set isn't on disk yet, a couple at a time, then drops
    /// the pictures of emotes no longer in it. Nothing on Low Data Mode, as the desktop holds
    /// back when someone asks to save data. Stops where it is if cancelled.
    public func prefetch(_ ids: [String], serverUrl: String) async {
        let wanted = ids.flatMap { id in Self.sizes.map { (id: id, size: $0) } }.filter { item in
            file(item.id, item.size, serverUrl: serverUrl).map { !FileManager.default.fileExists(atPath: $0.path) } ?? false
        }
        let finished = await withTaskGroup(of: Bool.self, returning: Bool.self) { group in
            var pending = wanted.makeIterator()
            for _ in 0..<Self.atOnce {
                guard let item = pending.next() else { break }
                group.addTask { await self.fetchAhead(item.id, item.size, serverUrl: serverUrl) }
            }
            var going = true
            while let result = await group.next() {
                going = going && result && !Task.isCancelled
                guard going, let item = pending.next() else { continue }
                group.addTask { await self.fetchAhead(item.id, item.size, serverUrl: serverUrl) }
            }
            return going
        }
        if finished { prune(keeping: Set(ids), serverUrl: serverUrl) }
    }

    /// Whether to go on: not once the network says it's saving data.
    private func fetchAhead(_ id: String, _ size: String, serverUrl: String) async -> Bool {
        guard let file = file(id, size, serverUrl: serverUrl) else { return true }
        do {
            keep(try await fetch(id, size, serverUrl: serverUrl, with: ahead), at: file)
        } catch let error as URLError where error.networkUnavailableReason == .constrained {
            return false
        } catch {
            // One the server doesn't have, or a moment without a network: it's fetched when it's shown.
        }
        return true
    }

    private struct NotAPicture: Error {}

    private func fetch(_ id: String, _ size: String, serverUrl: String, with session: URLSession) async throws -> Data {
        guard let url = URL(string: "\(serverUrl)/api/emotes/\(id)/\(size).webp") else { throw NotAPicture() }
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { throw NotAPicture() }
        return data
    }

    private func keep(_ data: Data, at file: URL) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }

    private func prune(keeping ids: Set<String>, serverUrl: String) {
        let folder = folder(serverUrl)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
        for name in names where !ids.contains(String(name.prefix { $0 != "." })) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    /// Where a picture is kept: a folder for each server, as the browser's cache goes by
    /// address. Nil for anything the core wouldn't accept as an emote's ID.
    func file(_ id: String, _ size: String, serverUrl: String) -> URL? {
        guard Self.isEmoteId(id), Self.sizes.contains(size) else { return nil }
        return folder(serverUrl).appendingPathComponent("\(id).\(size).webp")
    }

    private func folder(_ serverUrl: String) -> URL {
        let digest = SHA256.hash(data: Data(serverUrl.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(digest, isDirectory: true)
    }

    /// EMOTE_ID in packages/core/src/validate.ts.
    static func isEmoteId(_ id: String) -> Bool {
        (1...64).contains(id.utf8.count) && id.utf8.allSatisfy { byte in
            (0x30...0x39).contains(byte) || (0x41...0x5a).contains(byte) || (0x61...0x7a).contains(byte) || byte == 0x5f || byte == 0x2d
        }
    }
}
