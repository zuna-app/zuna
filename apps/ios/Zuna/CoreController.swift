import Foundation
import Network
import Observation
import UIKit
import UserNotifications
import ZunaHost
import ZunaModels
#if DEBUG
import ZunaControl
#endif

/// Starts the client core and keeps it for the life of the app.
///
/// After a restart of the phone the device key is locked (see `DeviceLock`), so
/// the app waits for a Zuna password before starting the core. Within one boot
/// session the key stays unlocked and the app opens straight away.
@MainActor
@Observable
final class CoreController {
    enum Phase: Equatable {
        case booting
        case locked
        case ready
        case failed(String)
    }

    private(set) var phase: Phase = .booting
    private(set) var lockedAccounts: [DeviceLock.Entry] = []
    private(set) var runtime: CoreRuntime?
    private(set) var connection: CoreConnection?
    /// The UI's state, from the moment the core is running.
    private(set) var model: AppModel?
    private(set) var images: ImageStore?
    /// Notifications, from the moment the core is running.
    private(set) var notifications: Notifications?
    /// The APNs token, which may arrive before the core is running.
    var pushToken: String? {
        didSet { notifications?.token = pushToken }
    }
    /// A link opened before the app was ready, such as while it waits to be unlocked.
    private var pendingLink: String?
    private var directory: URL?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var suspendTask: Task<Void, Never>?
    private let network = NWPathMonitor()
    /// How long the core keeps running after the app goes to the background, so sends can finish.
    private var suspendDelay: Duration = .seconds(20)
    #if DEBUG
    private var control: ControlServer?
    /// Reads the stream stats for `voiceStats`, kept between calls so what's moved can be told.
    private var statsReader: StreamStats?
    #endif


    func start() async {
        do {
            let directory = try SharedStorage.dataDirectory()
            self.directory = directory
            #if DEBUG
            if UserDefaults.standard.bool(forKey: "ZunaResetData") {
                DeviceKeyStore.forget()
                Self.erase(directory)
                AppSettings.reset()
                NotificationSettings.reset()
                VoiceSettings.reset()
            }
            await startControl()
            #endif
            if let key = DeviceKeyStore.unlockedKey() {
                try await run(key: key)
                return
            }
            if let lock = DeviceLock.load(from: directory), !lock.entries.isEmpty {
                lockedAccounts = lock.entries
                phase = .locked
                return
            }
            // Nothing is locked: a new install, or every account has signed out.
            // Whatever is stored can't be read without a key, so start clean.
            Self.erase(directory)
            let key = try DeviceKeyStore.newKey()
            try DeviceKeyStore.keep(key)
            try await run(key: key)
        } catch {
            phase = .failed(String(describing: error))
        }
    }

    /// Unlocks with an account's password. False if the password is wrong.
    func unlock(_ entry: DeviceLock.Entry, password: String) async -> Bool {
        let key = await Task.detached(priority: .userInitiated) { DeviceLock.unlock(entry, password: password) }.value
        guard let key else { return false }
        do {
            try DeviceKeyStore.keep(key)
            try await run(key: key)
        } catch {
            phase = .failed(String(describing: error))
        }
        return true
    }

    /// For a forgotten password: erases what this device stores so the person
    /// can sign in again. Their account and messages stay on the server.
    func eraseAndStartOver() async {
        guard let directory else { return }
        DeviceKeyStore.forget()
        Self.erase(directory)
        lockedAccounts = []
        phase = .booting
        await start()
    }

    private func run(key: Data) async throws {
        guard let directory else { return }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        var options = CoreRuntime.Options(
            dataDirectory: directory,
            cacheDirectory: caches.appendingPathComponent("decrypted", isDirectory: true),
            deviceKey: key,
            deviceName: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        )
        // Runs on the core's queue before the core answers the sign-in or
        // password change, so the lock is saved before anyone can close the app.
        options.onAccountEvent = { event in
            Self.updateLock(in: directory, deviceKey: key, with: event)
        }
        #if DEBUG
        options.logToStandardError = true
        #endif
        let runtime = try CoreRuntime(options: options)
        try await runtime.start()
        self.runtime = runtime
        // Events arrive on the core's queue and are applied on the main actor in the order they were sent.
        let (events, continuation) = AsyncStream.makeStream(of: CoreEvent.self)
        let connection = CoreConnection(runtime: runtime) { continuation.yield($0) }
        let model = AppModel(core: connection)
        Task {
            for await event in events { model.handle(event) }
        }
        await model.load()
        if let pendingLink {
            model.open(link: pendingLink)
            self.pendingLink = nil
        }
        self.connection = connection
        self.model = model
        images = ImageStore(core: connection)
        let notifications = Notifications(model: model)
        if let pushToken { notifications.token = pushToken }
        notifications.preview = { serverId, groupId, messageId in
            try await runtime.pushPreview(serverId: serverId, groupId: groupId, messageId: messageId, pictures: true)
        }
        model.onServersChanged = { Task { await notifications.refresh() } }
        model.onNotify = { serverId, groupId, messageId in
            Task { await notifications.showLive(serverId: serverId, groupId: groupId, messageId: messageId) }
        }
        // What a silent push would clear, when the app hears of it itself.
        model.onCaughtUp = { serverId in
            Task { await notifications.clearRead(serverId: serverId) }
        }
        model.onMessageGone = { serverId, groupId, messageId in
            Task { await Notifications.clear(PushStore.Message(kind: .delete, serverId: serverId, groupId: groupId, messageId: messageId)) }
        }
        // A call kept the core connected out of sight; once it's over, the app can go to sleep as usual.
        model.voice.onEnded = { [weak self] in
            if UIApplication.shared.applicationState == .background { self?.didEnterBackground() }
        }
        reportActivity()
        self.notifications = notifications
        Task { await notifications.updateAuthorization() }
        watchNetwork()
        #if DEBUG
        control?.attach(runtime)
        #endif
        phase = .ready
    }

    /// An invite link opened from outside the app (`zuna://join?link=…`).
    func open(_ url: URL) {
        guard url.scheme == "zuna" else { return }
        if let model {
            model.open(link: url.absoluteString)
        } else {
            pendingLink = url.absoluteString
        }
    }

    // MARK: Lifecycle

    /// iOS stops the app soon after it leaves the screen. The core gets a
    /// background task to finish sending, then closes its connections cleanly.
    /// Not during a call, which goes on out of sight: the server would take
    /// this device out of its voice channel once its connection had gone.
    func didEnterBackground() {
        reportActivity()
        guard connection != nil, suspendTask == nil, model?.voice.inCall != true else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish sending") { [weak self] in
            MainActor.assumeIsolated { self?.suspendNow() }
        }
        let delay = suspendDelay
        suspendTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.suspendNow()
        }
    }

    /// Acts on a notification once the core is running: the app may have just
    /// been launched in the background for it, and keeps running until it's done.
    func respond(to response: UNNotificationResponse) async {
        let task = UIApplication.shared.beginBackgroundTask(withName: "Act on a notification")
        defer { UIApplication.shared.endBackgroundTask(task) }
        for _ in 0..<100 where notifications == nil {
            try? await Task.sleep(for: .milliseconds(100))
        }
        // The core may have closed its connections when the app left the screen.
        suspendTask?.cancel()
        suspendTask = nil
        try? await connection?.resume()
        await notifications?.respond(to: response)
        if UIApplication.shared.applicationState != .active { suspendNow() }
    }

    /// Back on screen: reconnect right away and catch up.
    func didBecomeActive() {
        Task { await notifications?.updateAuthorization() }
        suspendTask?.cancel()
        suspendTask = nil
        endBackgroundTask()
        reportActivity()
        guard let connection else { return }
        Task {
            try? await connection.resume()
            try? await connection.nudge()
        }
    }

    /// On screen, the person is using this device: their other devices keep
    /// quiet, and nothing is pushed here. Each report sends the state at the
    /// time it goes out, so a late one can't contradict a newer one.
    private func reportActivity() {
        guard let connection else { return }
        Task { try? await connection.setActive(UIApplication.shared.applicationState == .active) }
    }

    private func suspendNow() {
        suspendTask?.cancel()
        suspendTask = nil
        guard model?.voice.inCall != true else {
            endBackgroundTask()
            return
        }
        let connection = connection
        Task { try? await connection?.suspend() }
        endBackgroundTask()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Reconnects as soon as the network comes back, like the desktop's "online" event.
    private func watchNetwork() {
        network.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in
                guard let connection = self?.connection else { return }
                try? await connection.nudge()
            }
        }
        network.start(queue: DispatchQueue(label: "chat.zuna.network"))
    }

    /// Keeps the device lock in step with the accounts on this device: each
    /// account's password can unlock the key, and only while it's signed in.
    nonisolated private static func updateLock(in directory: URL, deviceKey: Data, with event: AccountEvent) {
        var lock = DeviceLock.load(from: directory) ?? DeviceLock()
        switch event.type {
        case .signedIn, .passwordChanged:
            guard let password = event.password else { return }
            try? lock.add(deviceKey: deviceKey, password: password, serverUrl: event.serverUrl, username: event.username, serverName: event.serverName)
        case .signedOut:
            lock.remove(serverUrl: event.serverUrl, username: event.username)
        }
        try? lock.save(to: directory)
    }

    private static func erase(_ directory: URL) {
        let fileManager = FileManager.default
        for file in (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            try? fileManager.removeItem(at: file)
        }
    }

    #if DEBUG
    /// Test builds take commands over a local WebSocket, before and after unlocking.
    private func startControl() async {
        let port = UserDefaults.standard.integer(forKey: "ZunaControlPort")
        guard port > 0, control == nil else { return }
        let delay = UserDefaults.standard.double(forKey: "ZunaSuspendDelay")
        if delay > 0 { suspendDelay = .milliseconds(Int(delay * 1000)) }
        let server = ControlServer()
        server.commandHandler = { [weak self] raw in
            let command = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] ?? [:]
            let name = command["command"] as? String
            let password = command["password"] as? String
            let account = command["account"] as? Int
            let path = command["path"] as? String
            let channel = command["channel"] as? String
            let on = command["on"] as? Bool
            return await self?.handleControl(name: name, password: password, account: account, path: path, channel: channel, on: on)
        }
        control = server
        guard let bound = try? await server.start(port: UInt16(port)) else { return }
        print("ZUNA_HOST_READY port=\(bound)")
    }

    private func handleControl(name: String?, password: String?, account: Int?, path: String?, channel: String?, on: Bool?) async -> String {
        switch name {
        case "state":
            switch phase {
            case .booting: return "booting"
            case .locked: return "locked"
            case .ready: return "ready"
            case .failed: return "failed"
            }
        case "unlock":
            guard phase == .locked, let password, lockedAccounts.indices.contains(account ?? 0) else { return "not-locked" }
            return await unlock(lockedAccounts[account ?? 0], password: password) ? "ready" : "wrong-password"
        case "lockedAccounts":
            return lockedAccounts.map(\.id).joined(separator: ",")
        case "lockEntries":
            guard let directory else { return "0" }
            return String(DeviceLock.load(from: directory)?.entries.count ?? 0)
        case "background":
            didEnterBackground()
            return "background"
        case "foreground":
            didBecomeActive()
            return "active"
        case "attachFile":
            // The open chat's composer stages it, as it would a picked file.
            guard let path, let model else { return "no-chat" }
            model.pendingAttachments.append(URL(fileURLWithPath: path))
            return "attached"
        case "voiceJoin":
            // Comes into a voice channel on the active server, as tapping its row does, and says how that went.
            guard let model, let channel, let serverId = model.activeServerId else { return "no-server" }
            await model.voice.join(serverId: serverId, channelId: channel)
            return model.voice.status == .connected ? "connected" : "\(model.voice.status)"
        case "voiceLeave":
            model?.voice.leave()
            return "left"
        case "voiceCamera":
            guard let voice = model?.voice else { return "no-call" }
            if voice.camera != (on ?? true) { await voice.toggleCamera() }
            return voice.camera ? "on" : "off"
        case "voiceScreen":
            // Shares the screen, or stops, as the button does; test builds share moving bars (-ZunaFakeScreen).
            guard let voice = model?.voice else { return "no-call" }
            if voice.screen != (on ?? true) { await voice.toggleScreen() }
            return voice.screen ? "on" : "off"
        case "voiceState":
            guard let voice = model?.voice else { return "{}" }
            let state: [String: Any] = [
                "status": "\(voice.status)",
                "muted": voice.muted,
                "deafened": voice.deafened,
                "serverMuted": voice.serverMuted,
                "noMic": voice.noMic,
                "camera": voice.camera,
                "screen": voice.screen,
                "screenKbps": voice.screenTerms.map { $0.kbps as Any } ?? NSNull(),
                "epoch": voice.keyEpoch.map { $0 as Any } ?? NSNull(),
                "focus": voice.focus.map { $0 as Any } ?? NSNull(),
                "speaking": Array(voice.speaking),
                "videos": voice.videos.map { ["id": $0.id, "userId": $0.userId, "source": $0.source == .screen ? "screen" : "camera", "local": $0.local, "sound": $0.sound] },
                "systemCall": voice.systemCallReport,
            ]
            let data = (try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])) ?? Data("{}".utf8)
            return String(decoding: data, as: UTF8.self)
        case "voiceReport":
            return VoiceTesting.report()
        case "voiceStats":
            // What the stream stats show, as text. The first call only starts reading.
            guard let voice = model?.voice else { return "" }
            let reader = statsReader ?? StreamStats()
            statsReader = reader
            return StreamStats.asText(voice.readStats(reader))
        case "drift":
            return connection?.driftReports.joined(separator: "\n") ?? ""
        case "clearNotifications":
            // So a test sees only its own notifications.
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            return "cleared"
        case "deliveredNotifications":
            return String(await UNUserNotificationCenter.current().deliveredNotifications().count)
        default:
            return "unknown"
        }
    }
    #endif
}
