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
    /// Which process runs the core on this device's data: this app, except while it sleeps, when the share extension may.
    private var lock: CoreLock?
    /// The core is connected and the lock is this app's, rather than both put away in the background.
    private var awake = false
    /// Going to sleep and waking up, one after another, since each waits for the core or the lock.
    private var lifecycle: Task<Void, Never>?
    /// Going to sleep was asked for, and not called off by coming back before its turn.
    private var sleepWanted = false
    /// What the share extension hands over while the app is awake.
    private var shareInbox: ShareInbox?
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
            // A phone being tested by hand stays unlocked while the app is in front, from the moment it starts.
            if UserDefaults.standard.bool(forKey: "ZunaKeepAwake") { ScreenAwake.hold(.testing, true) }
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
        // The share extension may be sending with a core of its own: this one starts once it's done.
        let lock = try self.lock ?? CoreLock(directory: directory)
        self.lock = lock
        _ = await lock.take(as: .app)
        do {
            try await runtime.start()
        } catch {
            lock.release()
            throw error
        }
        awake = true
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
        notifications.callToken = model.voice.callPushToken
        model.voice.onCallPushToken = { notifications.callToken = $0 }
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
        model.voice.onPushed = { [weak self] in self?.callPushed() }
        let shareInbox = ShareInbox(model: model, core: connection, deviceKey: key)
        // So does something the share extension handed over, once it's gone.
        shareInbox.onIdle = { [weak self] in
            if UIApplication.shared.applicationState == .background { self?.didEnterBackground() }
        }
        shareInbox.listening = true
        self.shareInbox = shareInbox
        reportActivity()
        self.notifications = notifications
        Task { await notifications.updateAuthorization() }
        watchNetwork()
        #if DEBUG
        control?.attach(runtime)
        #endif
        phase = .ready
        // Launched in the background, as for a push: it goes to sleep as it would on leaving the screen.
        if UIApplication.shared.applicationState == .background { didEnterBackground() }
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
    /// background task to finish sending, then closes its connections cleanly,
    /// and hands its data to the share extension until the app is back.
    /// Not during a call, which goes on out of sight, or one ringing: the
    /// server would take this device out of its voice channel once its
    /// connection had gone. Nor while sending what the share extension handed over.
    func didEnterBackground() {
        reportActivity()
        guard connection != nil, suspendTask == nil, !keptAwake else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish sending") { [weak self] in
            MainActor.assumeIsolated { self?.timeIsUp() }
        }
        let delay = suspendDelay
        suspendTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.suspendNow()
        }
    }

    private var keptAwake: Bool {
        model?.voice.keepsCoreAwake == true || shareInbox?.busy == true
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
        await inTurn { [self] in await wakeUp() }.value
        await notifications?.respond(to: response)
        if UIApplication.shared.applicationState != .active { suspendNow() }
    }

    /// Back on screen: reconnect right away and catch up.
    func didBecomeActive() {
        Task { await notifications?.updateAuthorization() }
        suspendTask?.cancel()
        suspendTask = nil
        sleepWanted = false
        endBackgroundTask()
        reportActivity()
        guard let connection else { return }
        inTurn { [self] in
            await wakeUp()
            try? await connection.nudge()
        }
    }

    /// On screen, the person is using this device, as in Telegram: nothing is
    /// pushed here, and their other devices hold notifications back for a while
    /// and drop those they read here. Off it, they put the phone away, locked or
    /// left for another app, and show as offline at once, as on Telegram, rather
    /// than for the minute a desktop's window left behind keeps them online.
    /// Each report sends the state at the time it goes out, so a late one can't
    /// contradict a newer one.
    private func reportActivity() {
        guard let connection else { return }
        Task {
            let active = UIApplication.shared.applicationState == .active
            try? await connection.setActive(active, putAway: !active)
        }
    }

    private func suspendNow() {
        suspendTask?.cancel()
        suspendTask = nil
        guard !keptAwake else {
            endBackgroundTask()
            return
        }
        sleepWanted = true
        inTurn { [self] in
            if sleepWanted { await goToSleep() }
            endBackgroundTask()
        }
    }

    /// A VoIP push woke the app for a call, which goes to CallKit at once and is answered or let go once
    /// the core has caught up with it, so the core wakes if it was asleep. It stays awake while the call
    /// rings (`keepsCoreAwake`), and goes to sleep again after, out of sight, through `onEnded`.
    private func callPushed() {
        suspendTask?.cancel()
        suspendTask = nil
        endBackgroundTask()
        guard let connection else { return }
        inTurn { [self] in
            await wakeUp()
            try? await connection.nudge()
        }
    }

    /// The background task's time is up, and iOS suspends the app once this returns:
    /// the lock has to be let go of now, though the core is a moment from stopping.
    private func timeIsUp() {
        suspendTask?.cancel()
        suspendTask = nil
        if awake, !keptAwake {
            let connection = connection
            Task { try? await connection?.suspend() }
            awake = false
            shareInbox?.listening = false
            lock?.release()
        }
        endBackgroundTask()
    }

    /// Closes the core's connections and lets go of its data, which nothing in
    /// the app may write to until it wakes, so the share extension can use it.
    private func goToSleep() async {
        guard awake else { return }
        try? await connection?.suspend()
        awake = false
        shareInbox?.listening = false
        lock?.release()
    }

    /// Takes the data back, once the share extension is done with it if it was
    /// using it, and reconnects. If it sent something meanwhile, the core reads
    /// everything again and the app's state follows.
    private func wakeUp() async {
        sleepWanted = false
        guard !awake, let lock, let connection else { return }
        let moved = await lock.take(as: .app)
        awake = true
        let reloaded: Bool
        if moved {
            try? await connection.reload()
            reloaded = true
        } else {
            reloaded = (try? await connection.resume()) ?? false
        }
        shareInbox?.listening = true
        if reloaded { await model?.reloaded() }
    }

    /// Runs a step of going to sleep or waking after the ones asked for before it.
    @discardableResult
    private func inTurn(_ step: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = lifecycle
        let next = Task { @MainActor in
            await previous?.value
            await step()
        }
        lifecycle = next
        return next
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
        // The lock stays: the share extension may have it open.
        for file in (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] where file.lastPathComponent != "core.lock" {
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
            let caller = command["caller"] as? String
            let startedAt = command["startedAt"] as? Int
            return await self?.handleControl(name: name, password: password, account: account, path: path, channel: channel, on: on, caller: caller, startedAt: startedAt)
        }
        control = server
        guard let bound = try? await server.start(port: UInt16(port)) else { return }
        print("ZUNA_HOST_READY port=\(bound)")
    }

    private func handleControl(name: String?, password: String?, account: Int?, path: String?, channel: String?, on: Bool?, caller: String?, startedAt: Int?) async -> String {
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
        case "roundStart", "roundStop":
            // The open chat's composer records a video message, or sends it, as holding its button and letting go do.
            NotificationCenter.default.post(name: RoundRecorder.control, object: name == "roundStart" ? "start" : "stop")
            return name ?? ""
        case "openChat":
            // Opens a conversation, by its key, on the server at `path`, as tapping its row does.
            guard let model, let path, let channel, let server = model.servers.values.first(where: { $0.entry.url == path }) else { return "no-server" }
            model.selectServer(server.entry.id)
            model.openChat(channel)
            return "opened"
        case "keepAwake":
            // A phone being tested by hand stays unlocked while the app is in front, whatever its Auto-Lock says.
            ScreenAwake.hold(.testing, on ?? true)
            return UIApplication.shared.isIdleTimerDisabled ? "awake" : "may-sleep"
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
        case "voiceIncoming":
            // The calls ringing here, as the app's own card shows them where the system doesn't ring.
            let calls = model?.voice.incoming.map { ["groupId": $0.groupId, "startedBy": $0.startedBy, "title": $0.title] } ?? []
            let data = (try? JSONSerialization.data(withJSONObject: calls, options: [.sortedKeys])) ?? Data("[]".utf8)
            return String(decoding: data, as: UTF8.self)
        case "voipPush":
            // A call ringing by a VoIP push, as PushKit hands it to the app, which the simulator can't.
            guard let model, let channel, let caller, let startedAt, let serverId = model.activeServerId else { return "no-server" }
            model.voice.ringByPush(PushStore.Message(kind: .call, serverId: serverId, groupId: channel, messageId: nil, callerId: caller, startedAt: startedAt))
            return "rung"
        case "voiceAnswer":
            // Answers the first call ringing here, as its card's button does, and says how that went.
            guard let model, let call = model.voice.incoming.first else { return "not-ringing" }
            await model.voice.answer(call, camera: on ?? false)
            return model.voice.status == .connected ? "connected" : "\(model.voice.status)"
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
                "call": voice.isCall,
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
                "awake": UIApplication.shared.isIdleTimerDisabled,
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
        case "notifications":
            // Each one shown, with its message and when, and whether a push brought it or the app showed it itself.
            let shown = await UNUserNotificationCenter.current().deliveredNotifications().map { notification -> [String: Any] in
                let info = notification.request.content.userInfo
                let pushed = PushStore.open(info)
                return [
                    "groupId": info["groupId"] as? String ?? pushed?.groupId ?? "",
                    "messageId": info["messageId"] as? String ?? pushed?.messageId ?? "",
                    "pushed": pushed != nil,
                    "at": Int(notification.date.timeIntervalSince1970 * 1000),
                ]
            }
            let data = (try? JSONSerialization.data(withJSONObject: shown)) ?? Data("[]".utf8)
            return String(decoding: data, as: UTF8.self)
        case "pushKeys":
            // So a test can open what the server pushes here: each registration's key, by its ID.
            let keys = PushStore.registrations().mapValues { $0.key.base64EncodedString() }
            let data = (try? JSONSerialization.data(withJSONObject: keys)) ?? Data("{}".utf8)
            return String(decoding: data, as: UTF8.self)
        case "notificationsAllowed":
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            return [.authorized, .provisional, .ephemeral].contains(status) ? "yes" : "no"
        default:
            return "unknown"
        }
    }
    #endif
}
