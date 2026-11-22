import Foundation
import os
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
    /// The extension's core, which the expiring activity of a share sent out of sight reaches from
    /// its own thread, to close TDLib before the lock goes (`ShareModel.hostLeft`).
    nonisolated let runtime: CoreRuntime
    private let progress: ProgressRelay
    private let deviceKey: Data
    private let logger = Logger(subsystem: "chat.zuna", category: "share")

    /// How far the files of the message being sent have gone up, from 0 to 1.
    var onProgress: ((Double) -> Void)? {
        get { progress.report }
        set { progress.report = newValue }
    }

    private init(runtime: CoreRuntime, deviceKey: Data) {
        let progress = ProgressRelay()
        self.progress = progress
        self.runtime = runtime
        self.deviceKey = deviceKey
        // Events come on the core's queue. Only the upload's progress matters here.
        connection = CoreConnection(runtime: runtime) { event in
            guard case let .message(_, message, _, _) = event, let fraction = message.uploadProgress else { return }
            Task { @MainActor in progress.report?(fraction) }
        }
    }

    /// Starts the core, or wakes the one this process already has, once the
    /// lock is this extension's. `moved` says the app had it meanwhile.
    static func wake(deviceKey: Data, moved: Bool) async throws -> ShareCore {
        // The proxy set in Privacy, before anything connects, and again each time, as it may have changed.
        if ProxyStore.apply() { current?.runtime.networkChanged() }
        // And the language the app shows, which the core words its errors in.
        let language = I18n.forCore
        if let current {
            current.runtime.setLanguage(language.tag, catalog: language.catalog)
            if moved {
                try await current.connection.reload()
            } else {
                try await current.connection.resume()
            }
            return current
        }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        var options = CoreRuntime.Options(
            dataDirectory: try SharedStorage.dataDirectory(),
            cacheDirectory: caches.appendingPathComponent("decrypted", isDirectory: true),
            deviceKey: deviceKey,
            deviceName: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        )
        // A linked Telegram account, whose TDLib runs here only from Send until sent, as the core's
        // lock is this extension's then (docs/IOS_TELEGRAM_SHARE_PLAN.md).
        options.telegram = TelegramSetup.configuration(inShareExtension: true)
        options.telegramSendsOnly = true
        let runtime = try CoreRuntime(options: options)
        runtime.setLanguage(language.tag, catalog: language.catalog)
        try await runtime.start()
        let core = ShareCore(runtime: runtime, deviceKey: deviceKey)
        current = core
        return core
    }

    /// Every server's chats, as the extension offers them, and the linked Telegram account's as the
    /// app last listed them, as TDLib doesn't run here until Send.
    func servers() async throws -> [ShareServer] {
        var servers: [ShareServer] = []
        for entry in try await connection.listServers() {
            if entry.isTelegram {
                if let telegram = telegramServer() { servers.append(telegram) }
                continue
            }
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

    /// The sealed copy the app keeps (`ShareInbox.keepTelegramTargets`), for the account the core
    /// lists, which it does only in a build with Telegram where one is linked.
    private func telegramServer() -> ShareServer? {
        guard let file = try? ShareMailbox.telegramTargetsFile,
              let kept = try? ShareMailbox.read(ShareServer.self, from: file, deviceKey: deviceKey), kept.isTelegram else { return nil }
        return kept
    }

    /// How much memory the extension must have left to start TDLib in it: 70 MB was the most it used
    /// on its own on an iPhone 17 Pro Max with 220 MB to use, and TDLib took over 35 as it started.
    static let telegramMemory = 80 * 1_048_576

    /// What the extension has left before iOS ends it, or nil where nothing says, as in the simulator.
    nonisolated static func memoryLeft() -> Int? {
        #if targetEnvironment(simulator)
        return nil
        #else
        let left = os_proc_available_memory()
        return left > 0 ? Int(left) : nil
        #endif
    }

    /// Sends to the linked Telegram account's chats with its TDLib running here, from now until
    /// `send` is done, as the extension holds the core's lock: only with memory enough for it, said
    /// before anything starts, and closed again before the lock can go. What's left is logged both
    /// times, so a phone's log tells what the extension has there.
    func withTelegram(_ send: () async throws -> Void) async throws {
        let before = Self.memoryLeft()
        logger.notice("Before TDLib, \(before.map { "\($0 / 1_048_576) MB" } ?? "nothing said", privacy: .public) of memory left")
        if let before, before < Self.telegramMemory { throw ShareFailure(message: t("share.telegramNoMemory")) }
        runtime.takeBackTelegram()
        do {
            try await send()
        } catch {
            _ = await runtime.letGoOfTelegram()
            throw error
        }
        let after = Self.memoryLeft()
        logger.notice("Sent to Telegram, \(after.map { "\($0 / 1_048_576) MB" } ?? "nothing said", privacy: .public) of memory left")
        _ = await runtime.letGoOfTelegram()
    }

    /// Closes TDLib, if it runs, then the core's connections, and stops it writing, before the lock goes.
    func putAway() async {
        _ = await runtime.letGoOfTelegram()
        try? await connection.suspend()
    }

    /// Closes TDLib from a thread that can't wait for it asynchronously, as a share's expiring
    /// activity's, within a second.
    nonisolated static func letGoOfTelegramNow(_ runtime: CoreRuntime) {
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            _ = await runtime.letGoOfTelegram(within: 1)
            done.signal()
        }
        _ = done.wait(timeout: .now() + 1.5)
    }
}

@MainActor
private final class ProgressRelay {
    var report: ((Double) -> Void)?
}
