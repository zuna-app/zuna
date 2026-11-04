import Foundation
import Intents
import Observation
import UIKit
import ZunaModels

/// What the share sheet does, and how what's picked is sent, which happens
/// before the sheet closes:
///
/// - While the app is asleep, the extension takes `CoreLock` and runs a core
///   of its own on the app's data, as the app would.
/// - While the app is awake, as during a call, the app holds the lock, so the
///   extension asks it for the chats and hands it what to send (`ShareMailbox`).
///   Should the app go to sleep before taking it, the extension sends it itself.
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case starting
        /// Nothing can be shared, and why.
        case unavailable(String)
        /// App lock is on and hasn't been passed yet.
        case appLocked
        case picking
        case sending
        case sent
    }

    private(set) var phase: Phase = .starting
    private(set) var servers: [ShareServer] = []
    /// In the order they were picked.
    private(set) var selected: [ShareTarget] = []
    private(set) var items = SharedItems()
    private(set) var itemsLoaded = false
    /// How far the files have gone up, while the extension sends them itself.
    private(set) var progress: Double?
    /// Why the last send failed, shown until it's dismissed.
    var failure: String?
    var text = ""
    var query = ""
    /// The server whose chats show: the one open last in the app, or the one a suggestion was on.
    private(set) var serverId: String?
    var choosingServer = false
    let settings = AppSettings.load()
    /// Avatars, while the extension runs a core of its own.
    private(set) var images: ImageStore?
    /// Whose core the chats came from: "extension" or "app". Tests read it.
    private(set) var route = ""

    private static var lock: CoreLock?
    private let finish: (Bool) -> Void
    private var deviceKey: Data?
    private var lock: CoreLock?
    private var core: ShareCore?
    private var folder: URL?
    private var loading: Task<Void, Never>?
    private var preselect: String?
    private var hostAway = false
    /// Signalled once a send that went on out of sight is over.
    private var sendFinished: DispatchSemaphore?

    init(finish: @escaping (Bool) -> Void) {
        self.finish = finish
    }

    // MARK: Starting

    func start(items: [NSExtensionItem], intent: INIntent?) async {
        // Picked from the share sheet's suggestions, which notifications' conversations fill.
        preselect = (intent as? INSendMessageIntent)?.conversationIdentifier
        guard let key = DeviceKeyStore.unlockedKey() else {
            phase = .unavailable("Open Zuna first. After the phone restarts, Zuna needs your password once before anything can be shared.")
            return
        }
        deviceKey = key
        do {
            // One per process, as the core is, so it remembers whether the app had the data since the last share.
            let lock = try Self.lock ?? CoreLock(directory: SharedStorage.dataDirectory())
            Self.lock = lock
            self.lock = lock
            ShareMailbox.clearOld()
            let folder = try ShareMailbox.newRequestFolder()
            self.folder = folder
            // Only the loading reads them from here on.
            nonisolated(unsafe) let items = items
            loading = Task { [weak self] in
                let loaded = await SharedItems.load(items, into: folder)
                guard let self else { return }
                self.items = loaded
                if text.isEmpty { text = loaded.text }
                itemsLoaded = true
            }
        } catch {
            phase = .unavailable("Zuna couldn't open its data: \(error)")
            return
        }
        if settings.appLock {
            phase = .appLocked
            await unlock()
        } else {
            await listChats()
        }
    }

    /// App lock, as the app asks for it each time it opens.
    func unlock() async {
        guard phase == .appLocked else { return }
        if await AppLock.authenticate(reason: "Unlock Zuna") { await listChats() }
    }

    private func listChats() async {
        phase = .starting
        guard let lock, let deviceKey else { return }
        // The app is asleep or not running unless it holds the lock. Another share holding it is waited for.
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if let moved = lock.tryTake(as: .share) {
                do {
                    let core = try await ShareCore.wake(deviceKey: deviceKey, moved: moved)
                    self.core = core
                    images = ImageStore(core: core.connection)
                    route = "extension"
                    show(try await core.servers())
                    if hostAway { await putAway() }
                } catch {
                    await putAway()
                    phase = .unavailable("Zuna couldn't start: \(error)")
                }
                return
            }
            if lock.holder() == .app, let servers = await askApp() {
                route = "app"
                show(servers)
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        phase = .unavailable("Zuna is busy. Please try again in a moment.")
    }

    private func show(_ servers: [ShareServer]) {
        self.servers = servers
        guard servers.contains(where: { !$0.targets.isEmpty }) else {
            phase = .unavailable("There's nobody to share with yet. Sign in to a server in Zuna first.")
            return
        }
        let withChats = servers.filter { !$0.targets.isEmpty }.map(\.id)
        serverId = AppSettings.lastServer.flatMap { withChats.contains($0) ? $0 : nil } ?? withChats.first
        if let preselect, let target = servers.flatMap(\.targets).first(where: { $0.id == preselect }) {
            selected = [target]
            serverId = target.serverId
        }
        phase = .picking
    }

    /// The chats, from the app, which has them in memory. Nil if it doesn't answer.
    private func askApp() async -> [ShareServer]? {
        guard let deviceKey, let file = try? ShareMailbox.targetsFile else { return nil }
        try? FileManager.default.removeItem(at: file)
        let answered = await waitFor(ShareMailbox.targetsReady, seconds: 2) {
            ShareMailbox.post(ShareMailbox.askTargets)
        }
        guard answered else { return nil }
        defer { try? FileManager.default.removeItem(at: file) }
        return try? ShareMailbox.read([ShareServer].self, from: file, deviceKey: deviceKey)
    }

    // MARK: Picking

    var server: ShareServer? {
        servers.first { $0.id == serverId }
    }

    /// The server's chats, then its channels, that match the search.
    var targets: [ShareTarget] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return (server?.targets ?? []).filter { needle.isEmpty || $0.title.lowercased().contains(needle) }
    }

    func choose(_ serverId: String) {
        self.serverId = serverId
        query = ""
        choosingServer = false
    }

    func isSelected(_ target: ShareTarget) -> Bool {
        selected.contains(target)
    }

    func toggle(_ target: ShareTarget) {
        if let index = selected.firstIndex(of: target) {
            selected.remove(at: index)
        } else {
            selected.append(target)
        }
    }

    var canSend: Bool {
        !selected.isEmpty && itemsLoaded && (!items.files.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    // MARK: Sending

    func send() async {
        guard canSend, phase == .picking, let folder else { return }
        phase = .sending
        progress = nil
        defer {
            sendFinished?.signal()
            sendFinished = nil
        }
        let request = ShareRequest(targets: selected, text: text, files: items.files.map(\.file))
        do {
            try await deliver(request, folder: folder)
            phase = .sent
            await putAway()
            try? FileManager.default.removeItem(at: folder)
            try? await Task.sleep(for: .milliseconds(700))
            finish(true)
        } catch {
            failure = "\(error)"
            phase = .picking
            if hostAway { await putAway() }
        }
    }

    private func deliver(_ request: ShareRequest, folder: URL) async throws {
        guard let lock, let deviceKey else { return }
        if !lock.isHeld, let moved = lock.tryTake(as: .share) {
            core = try await ShareCore.wake(deviceKey: deviceKey, moved: moved)
        }
        if lock.isHeld, let core {
            try await sendHere(request, core: core)
            return
        }
        try await handToApp(request, folder: folder)
    }

    private func sendHere(_ request: ShareRequest, core: ShareCore) async throws {
        core.onProgress = { [weak self] fraction in self?.progress = fraction }
        defer { core.onProgress = nil }
        try await ShareSender.send(request, through: core.connection)
    }

    /// The app is awake: it sends, and says how that went. If it goes to sleep
    /// before taking the request, the lock comes free and this sends it.
    private func handToApp(_ request: ShareRequest, folder: URL) async throws {
        guard let lock, let deviceKey else { return }
        let requestFile = folder.appendingPathComponent("request")
        let resultFile = folder.appendingPathComponent("result")
        try ShareMailbox.write(request, to: requestFile, deviceKey: deviceKey)
        ShareMailbox.post(ShareMailbox.send)
        let posted = Date()
        let result = { () throws -> Bool in
            guard FileManager.default.fileExists(atPath: resultFile.path) else { return false }
            let result = try ShareMailbox.read(ShareResult.self, from: resultFile, deviceKey: deviceKey)
            if let error = result.error { throw ShareFailure(message: error) }
            return true
        }
        while true {
            if try result() { return }
            if let moved = lock.tryTake(as: .share) {
                if try result() { return }
                guard FileManager.default.fileExists(atPath: requestFile.path) else {
                    throw ShareFailure(message: "Zuna stopped before it could say whether this was sent. Check the chat in Zuna.")
                }
                try FileManager.default.removeItem(at: requestFile)
                let core = try await ShareCore.wake(deviceKey: deviceKey, moved: moved)
                self.core = core
                try await sendHere(request, core: core)
                return
            }
            if FileManager.default.fileExists(atPath: requestFile.path), Date().timeIntervalSince(posted) > 10 {
                try? FileManager.default.removeItem(at: requestFile)
                throw ShareFailure(message: "Zuna didn't answer. Please try again.")
            }
            _ = await waitFor(ShareMailbox.sent, seconds: 0.5)
        }
    }

    // MARK: Leaving

    func cancel() {
        loading?.cancel()
        Task {
            await putAway()
            if let folder { try? FileManager.default.removeItem(at: folder) }
            finish(false)
        }
    }

    /// The app that's sharing went out of sight, so this may be suspended, and
    /// mustn't hold the data then: a send carries on for as long as iOS allows,
    /// and otherwise the lock goes until the next send.
    func hostLeft() {
        hostAway = true
        switch phase {
        case .starting:
            // Let go of once the core has started.
            break
        case .sending:
            let done = DispatchSemaphore(value: 0)
            sendFinished = done
            ProcessInfo.processInfo.performExpiringActivity(withReason: "Send what was shared") { [lock] expired in
                if expired {
                    lock?.release()
                    done.signal()
                } else {
                    _ = done.wait(timeout: .now() + 300)
                }
            }
        default:
            Task { await putAway() }
        }
    }

    func hostBack() {
        hostAway = false
    }

    /// Stops the extension's core writing and lets go of the lock, so the app can wake.
    private func putAway() async {
        guard let lock, lock.isHeld else { return }
        await core?.putAway()
        lock.release()
    }

    /// Waits for a Darwin notification, after doing `then` once listening.
    private func waitFor(_ name: String, seconds: Double, then: () -> Void = {}) async -> Bool {
        await withCheckedContinuation { continuation in
            var resumed = false
            var observer: DarwinObserver?
            let done = { (heard: Bool) in
                guard !resumed else { return }
                resumed = true
                observer = nil
                continuation.resume(returning: heard)
            }
            observer = DarwinObserver(name) { done(true) }
            then()
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(seconds))
                done(false)
            }
            _ = observer
        }
    }
}
