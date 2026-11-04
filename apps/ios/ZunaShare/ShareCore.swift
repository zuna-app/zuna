import Foundation
import UIKit
import ZunaHost
import ZunaModels

/// The extension's own client core, for when the app isn't running: the same
/// core on the same data, which it may use only while it holds `CoreLock`.
/// One per process, since iOS may keep the extension for the next share.
@MainActor
final class ShareCore {
    private static var current: ShareCore?

    let connection: CoreConnection
    private let runtime: CoreRuntime
    private let progress: ProgressRelay

    /// How far the files of the message being sent have gone up, from 0 to 1.
    var onProgress: ((Double) -> Void)? {
        get { progress.report }
        set { progress.report = newValue }
    }

    private init(runtime: CoreRuntime) {
        let progress = ProgressRelay()
        self.progress = progress
        self.runtime = runtime
        // Events come on the core's queue. Only the upload's progress matters here.
        connection = CoreConnection(runtime: runtime) { event in
            guard case let .message(_, message, _) = event, let fraction = message.uploadProgress else { return }
            Task { @MainActor in progress.report?(fraction) }
        }
    }

    /// Starts the core, or wakes the one this process already has, once the
    /// lock is this extension's. `moved` says the app had it meanwhile.
    static func wake(deviceKey: Data, moved: Bool) async throws -> ShareCore {
        if let current {
            if moved {
                try await current.connection.reload()
            } else {
                try await current.connection.resume()
            }
            return current
        }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let runtime = try CoreRuntime(options: CoreRuntime.Options(
            dataDirectory: try SharedStorage.dataDirectory(),
            cacheDirectory: caches.appendingPathComponent("decrypted", isDirectory: true),
            deviceKey: deviceKey,
            deviceName: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        ))
        try await runtime.start()
        let core = ShareCore(runtime: runtime)
        current = core
        return core
    }

    /// Every server's chats, as the extension offers them.
    func servers() async throws -> [ShareServer] {
        var servers: [ShareServer] = []
        for entry in try await connection.listServers() {
            let session = connection.session(entry.id)
            async let me = session.getSelf()
            async let users = session.getUsers()
            async let conversations = session.getConversations()
            async let channels = session.getChannels()
            async let prefs = session.getPreferences()
            servers.append(ShareServer(
                entry: entry,
                selfId: try? await me.userId,
                users: Dictionary(((try? await users) ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 }),
                conversations: (try? await conversations) ?? [],
                channels: (try? await channels) ?? [],
                hidden: (try? await prefs.hidden) ?? []
            ))
        }
        return servers
    }

    /// Closes the core's connections and stops it writing, before the lock goes.
    func putAway() async {
        try? await connection.suspend()
    }
}

@MainActor
private final class ProgressRelay {
    var report: ((Double) -> Void)?
}
