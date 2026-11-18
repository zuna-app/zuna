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
    /// Voice and calls, from launch: a VoIP push has to ring even while the app waits to be unlocked.
    let voice: VoiceModel
    private(set) var images: ImageStore?
    /// Notifications, from the moment the core is running.
    private(set) var notifications: Notifications?
    /// The APNs token, which may arrive before the core is running.
    var pushToken: String? {
        didSet {
            notifications?.token = pushToken
            runtime?.setTelegramPushToken(pushToken)
        }
    }
    /// The language the interface is in, by its tag, which the whole of it is made again for when it
    /// changes (`RootView`). Read as the app starts, once the language kept is shown.
    private(set) var languageTag = ""
    /// A link opened before the app was ready, such as while it waits to be unlocked.
    private var pendingLink: String?
    private var directory: URL?
    private var suspendTask: Task<Void, Never>?
    /// Which process runs the core on this device's data: this app, except while it sleeps, when the share extension may.
    /// Held only with a background task, whose end it goes before, so iOS never suspends the app holding it.
    private var lock: LockKeeper?
    /// The core is connected and the lock is this app's, rather than both put away in the background.
    private var awake = false
    /// The share extension has had the data since the core last read it, which it reads again as it wakes.
    private var behind = false
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

    init() {
        #if DEBUG
        // Before the voice reads its settings, which `start` resets with everything else.
        if UserDefaults.standard.bool(forKey: "ZunaResetData") { VoiceSettings.reset() }
        #endif
        voice = VoiceModel()
    }

    /// Hands VoIP pushes to CallKit from launch, before the core is running or has been unlocked.
    func listenForCalls() {
        voice.onPushed = { [weak self] in self?.callPushed() }
        voice.onTelegramCallPush = { [weak self] payload, done in self?.telegramCallPushed(payload, done) }
        voice.onTelegramTakesCalls = { [weak self] _ in self?.giveTelegramVoipToken() }
        voice.listenForCalls()
    }

    /// Telegram's calls' pushes that came before the core was running, as before the app was unlocked.
    private var telegramCallPushes: [(payload: String, done: @Sendable (Bool) -> Void)] = []

    private func telegramCallPushed(_ payload: String, _ done: @escaping @Sendable (Bool) -> Void) {
        guard let runtime else { return telegramCallPushes.append((payload, done)) }
        runtime.telegramCallPushed(payload, done: done)
    }

    /// The VoIP token Telegram pushes the linked account's calls to, while this device takes them, and only
    /// where CallKit is allowed, as a VoIP push has to ring through it (docs/TELEGRAM_CALLS_PLAN.md).
    private func giveTelegramVoipToken() {
        runtime?.setTelegramVoipToken(voice.telegramTakesCalls == false ? nil : voice.callPushToken)
    }

    func start() async {
        languageTag = I18n.tag
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
                ProxyStore.reset()
            }
            await startControl()
            #endif
            // Before anything connects, servers' pictures on the unlock screen among them.
            ProxyStore.apply()
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
        // Before the core starts, so nothing it sends goes around the proxy set in Privacy.
        ProxyStore.apply()
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
        // The chat list has a tab for bots, where one nobody has written to yet is found.
        options.listsBots = true
        // A Telegram account linked on this device, its TDLib in the app's own process (docs/TELEGRAM_PLAN.md).
        options.telegram = TelegramSetup.configuration()
        options.telegramCalls = options.telegram != nil
        #if DEBUG
        options.logToStandardError = true
        #endif
        let runtime = try CoreRuntime(options: options)
        // The core words its errors and notifications, and the server's messages, in the app's language.
        let language = I18n.forCore
        runtime.setLanguage(language.tag, catalog: language.catalog)
        // Launched in the background, as for a push, Telegram's TDLib waits for the app to come on screen.
        runtime.setTelegramOutOfSight(UIApplication.shared.applicationState == .background)
        // The share extension may be sending with a core of its own: this one starts once it's done.
        let lock = try self.lock ?? keeper(of: CoreLock(directory: directory))
        self.lock = lock
        _ = await lock.take()
        do {
            try await runtime.start()
        } catch {
            lock.release()
            throw error
        }
        // Unless the time ran out while it started, and the lock went (`lockLost`).
        awake = lock.isHeld
        self.runtime = runtime
        giveTelegramVoipToken()
        for push in telegramCallPushes { runtime.telegramCallPushed(push.payload, done: push.done) }
        telegramCallPushes.removeAll()
        // Whatever the app did while the core started, which nothing told it of.
        runtime.setTelegramOutOfSight(UIApplication.shared.applicationState == .background)
        #if DEBUG
        // Tests give a made-up token, as the relay's stand-in does, where the simulator gets none from Apple.
        runtime.setTelegramPushToken(pushToken ?? UserDefaults.standard.string(forKey: "ZunaPushToken"))
        #else
        runtime.setTelegramPushToken(pushToken)
        #endif
        // Events arrive on the core's queue and are applied on the main actor in the order they were sent.
        let inbox = EventInbox()
        let connection = CoreConnection(runtime: runtime) { inbox.add($0) }
        let model = AppModel(core: connection, voice: voice)
        // Before anything is delivered, which happens on the main actor once this one waits.
        inbox.deliver = { events in
            for event in events { model.handle(event) }
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
        model.voice.onCallPushToken = { [weak self] token in
            notifications.callToken = token
            self?.giveTelegramVoipToken()
        }
        notifications.preview = { serverId, groupId, messageId in
            try await runtime.pushPreview(serverId: serverId, groupId: groupId, messageId: messageId, pictures: true)
        }
        model.onServersChanged = { Task { await notifications.refresh() } }
        model.onNetworkChanged = { runtime.networkChanged() }
        model.onActiveServerChanged = { [weak self] in self?.reportActivity() }
        model.onNotify = { serverId, groupId, messageId, inUse in
            Task { await notifications.showLive(serverId: serverId, groupId: groupId, messageId: messageId, inUse: inUse) }
        }
        model.onTelegramNotify = { title, body, conversationKey, groupId, messageId in
            Task { await notifications.showTelegram(title: title, body: body, conversationKey: conversationKey, groupId: groupId, messageId: messageId) }
        }
        let telegramPictures = TelegramPictureKeeper(core: connection)
        model.onTelegramChats = { telegramPictures.listChanged($0) }
        notifications.keepTelegramPicture = { await telegramPictures.ensure($0) }
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
        let shareInbox = ShareInbox(model: model, core: connection, deviceKey: key)
        // So does something the share extension handed over, once it's gone.
        shareInbox.onIdle = { [weak self] in
            if UIApplication.shared.applicationState == .background { self?.didEnterBackground() }
        }
        shareInbox.listening = awake
        self.shareInbox = shareInbox
        reportActivity()
        self.notifications = notifications
        Task { await notifications.updateAuthorization() }
        watchNetwork()
        #if DEBUG
        control?.attach(runtime)
        #endif
        phase = .ready
        if !awake {
            // The time ran out while the core started, and the lock went: it sleeps until it's woken,
            // which the app coming back meanwhile couldn't do yet.
            inTurn { try? await connection.suspend() }
            if UIApplication.shared.applicationState == .active { inTurn { [self] in await wakeUp() } }
        }
        // Launched in the background, as for a push: it goes to sleep as it would on leaving the screen.
        if UIApplication.shared.applicationState == .background { didEnterBackground() }
    }

    /// Shows the app in a language chosen in Settings, or in the system's (nil): keeps the choice where
    /// the extensions read it too, tells the core, which words its errors and notifications in it, and
    /// has the whole interface made again in it.
    func chooseLanguage(_ choice: String?) {
        let tag = I18n.choose(choice)
        let language = I18n.forCore
        runtime?.setLanguage(language.tag, catalog: language.catalog)
        // The notifications' actions, which iOS keeps as they were registered, in the new language too.
        UNUserNotificationCenter.current().setNotificationCategories(Notifications.categories)
        languageTag = tag
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

    /// iOS stops the app soon after it leaves the screen. The core keeps
    /// running a while to finish sending, through the background task the lock
    /// is held with, then closes its connections cleanly, and hands its data to
    /// the share extension until the app is back.
    /// Not during a call, which goes on out of sight, or one ringing: the
    /// server would take this device out of its voice channel once its
    /// connection had gone. Nor while sending what the share extension handed over.
    func didEnterBackground() {
        reportActivity()
        // iOS suspends Telegram's TDLib with the app, which starts nothing for it while out of sight.
        runtime?.setTelegramOutOfSight(true)
        guard connection != nil, suspendTask == nil, !keptAwake else { return }
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

    /// A silent push said a chat was read, or a message deleted, on another device, and what it names is
    /// cleared already. iOS hands such pushes over when it likes, so this one may be the first of several
    /// to arrive: the server is asked which chats it still counts this device as showing, and the rest go
    /// too. And the notification it's about may still be with the extension, fetching its message, as when
    /// a chat is read the moment a message comes, so what it names is cleared again a little later.
    func clearedElsewhere(_ push: PushStore.Message) async {
        let rest = Task { await clearRead(serverId: push.serverId) }
        for wait in [2, 3] {
            try? await Task.sleep(for: .seconds(wait))
            await Notifications.clear(push)
        }
        // Woken for a push, the app only has so long.
        _ = await result(of: rest, within: 10)
    }

    /// Clears the notifications of a server's chats that it no longer counts this device as showing one for,
    /// and says how many went. Without the device's key, as before the phone is first unlocked, none.
    @discardableResult
    func clearRead(serverId: String) async -> Int {
        guard let runtime else { return 0 }
        let asked = Date()
        guard let notified = try? await runtime.stillNotified(serverId: serverId) else { return 0 }
        let cleared = await PushStore.clearRead(serverId: serverId, stillNotified: notified, shownBefore: asked)
        if cleared > 0 { try? await UNUserNotificationCenter.current().setBadgeCount(PushStore.badge) }
        return cleared
    }

    /// Back on screen: reconnect right away and catch up.
    func didBecomeActive() {
        runtime?.setTelegramOutOfSight(false)
        Task { await notifications?.updateAuthorization() }
        suspendTask?.cancel()
        suspendTask = nil
        sleepWanted = false
        reportActivity()
        guard let connection else { return }
        inTurn { [self] in
            await wakeUp()
            model?.catchUpChatOnScreen()
            try? await connection.nudge()
        }
    }

    /// On screen, the person is using this device, as in Telegram: nothing is
    /// pushed here, and their other devices hold notifications back for a while
    /// and drop those they read here. Off it, they put the phone away, locked or
    /// left for another app, and show as offline at once, as on Telegram.
    /// Each report sends the state at the time it goes out, so a late one can't
    /// contradict a newer one.
    private func reportActivity() {
        guard let connection else { return }
        Task {
            let active = UIApplication.shared.applicationState == .active
            try? await connection.setActive(active, shownServer: model?.activeServerId)
        }
    }

    private func suspendNow() {
        suspendTask?.cancel()
        suspendTask = nil
        // It goes to sleep once the call or the share is over (`onEnded`, `onIdle`), or the lock goes as the time runs out.
        guard !keptAwake else { return }
        sleepWanted = true
        inTurn { [self] in
            if sleepWanted { await goToSleep() }
        }
    }

    /// A VoIP push woke the app for a call, which goes to CallKit at once and is answered or let go once
    /// the core has caught up with it, so the core wakes if it was asleep. It stays awake while the call
    /// rings (`keepsCoreAwake`), and goes to sleep again after, out of sight, through `onEnded`.
    private func callPushed() {
        suspendTask?.cancel()
        suspendTask = nil
        guard let connection else { return }
        inTurn { [self] in
            await wakeUp()
            try? await connection.nudge()
        }
    }

    /// Holds the lock with a background task, so that iOS never suspends the app holding it.
    private func keeper(of lock: CoreLock) -> LockKeeper {
        let keeper = LockKeeper(lock: lock, as: .app, keepRunning: { expiring in
            let task = UIApplication.shared.beginBackgroundTask(withName: "Hold the core's data") {
                MainActor.assumeIsolated { expiring() }
            }
            return task == .invalid ? nil : task.rawValue
        }, stopRunning: { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: $0)) })
        keeper.onLost = { [weak self] in self?.lockLost() }
        return keeper
    }

    /// The background task the lock was held with ran out of time, and iOS suspends the app once it ends,
    /// so the lock has gone already, though the core is a moment from stopping. In a call too: iOS gives
    /// the app all the time it likes while a call's sound plays, and is about to suspend it otherwise.
    private func lockLost() {
        suspendTask?.cancel()
        suspendTask = nil
        guard awake else { return }
        let connection = connection
        Task { try? await connection?.suspend() }
        awake = false
        shareInbox?.listening = false
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
        if await lock.take() { behind = true }
        // The time ran out as it was taken, and it went again (`lockLost`): the core wakes when next asked.
        guard lock.isHeld else { return }
        awake = true
        let reloaded: Bool
        if behind {
            behind = false
            try? await connection.reload()
            reloaded = true
        } else {
            reloaded = (try? await connection.resume()) ?? false
        }
        shareInbox?.listening = awake
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
        case "telegramReclaim":
            // Telegram's door loses its sockets, as iOS takes back a suspended process's.
            guard let runtime else { return "not-running" }
            let asked = await withCheckedContinuation { continuation in runtime.reclaimTelegram { continuation.resume(returning: $0) } }
            return asked ? "reclaimed" : "not-running"
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
        case "watchHere":
            // Plays what the room watches here, as pressing Watch and agreeing does, or stops it here.
            guard let voice = model?.voice else { return "no-voice" }
            let watching = on ?? true
            if watching { voice.playYouTube = true }
            voice.setWatching(watching)
            return voice.watching != nil ? "watching" : "not-watching"
        case "voiceIncoming":
            // The calls ringing here, as the app's own card shows them where the system doesn't ring.
            let calls = model?.voice.incoming.map { ["groupId": $0.groupId, "startedBy": $0.startedBy, "title": $0.title] } ?? []
            let data = (try? JSONSerialization.data(withJSONObject: calls, options: [.sortedKeys])) ?? Data("[]".utf8)
            return String(decoding: data, as: UTF8.self)
        case "telegramVoipPush":
            // A VoIP push of Telegram's, its JSON in `path`, as PushKit hands one to the app, which the simulator can't.
            guard let path, let info = (try? JSONSerialization.jsonObject(with: Data(path.utf8))) as? [AnyHashable: Any] else { return "unreadable" }
            voice.ringByTelegramPush(info)
            return "rung"
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
                "output": CallOutput.shared.report,
                "watch": voice.watch != nil,
                "watching": voice.watching != nil,
                "playerPhase": voice.playerPhase.map { $0 as Any } ?? NSNull(),
                "awake": UIApplication.shared.isIdleTimerDisabled,
            ]
            let data = (try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])) ?? Data("{}".utf8)
            return String(decoding: data, as: UTF8.self)
        case "voiceReport":
            return VoiceTesting.report()
        case "telegramCallAudio":
            // Whether a call's sound stays on when its audio starts before the call's factory is made.
            return TelegramCallFixtures.audio()
        case "telegramCallOffers":
            // The offers a Telegram call's peer connection makes here, in each shape, for the core's tests.
            return await TelegramCallFixtures.offers()
        case "telegramCallAnswers":
            // The core's answers to them, in `path`, set on real peer connections, and what was taken.
            return await TelegramCallFixtures.check(path ?? "")
        case "telegramCallState":
            // The Telegram call as this device has it.
            guard let voice = model?.voice else { return "{}" }
            let state: [String: Any] = [
                "status": "\(voice.status)",
                "telegram": voice.isTelegram,
                "state": voice.telegram?.state ?? NSNull(),
                "emoji": voice.telegram?.emoji ?? [],
                "rating": voice.telegramRating != nil,
                "takesCalls": voice.telegramTakesCalls.map { $0 as Any } ?? NSNull(),
            ]
            let data = (try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])) ?? Data("{}".utf8)
            return String(decoding: data, as: UTF8.self)
        case "voiceStats":
            // What the stream stats show, as text. The first call only starts reading.
            guard let voice = model?.voice else { return "" }
            let reader = statsReader ?? StreamStats()
            statsReader = reader
            return StreamStats.asText(voice.readStats(reader))
        case "drift":
            return connection?.driftReports.joined(separator: "\n") ?? ""
        case "clearRead":
            // Asks the server at `path` which chats it still counts this device as showing, and clears the rest, as a silent push has the app do.
            guard let server = model?.servers.values.first(where: { $0.entry.url == path }) else { return "no-server" }
            return String(await clearRead(serverId: server.entry.id))
        case "telegramPush":
            // A push of Telegram's, its JSON in `path`, handed over as iOS hands a silent one; says how many notifications it cleared.
            guard let path, let info = (try? JSONSerialization.jsonObject(with: Data(path.utf8))) as? [AnyHashable: Any],
                  let push = TelegramPush(info) else { return "not-telegram" }
            return String(await TelegramPush.clear(push))
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

/// The core's events, handed to the main actor in batches: all that arrived
/// since it last took them, so a burst, as when catching up after a while on
/// another device, is drawn once and not once a message.
private final class EventInbox: @unchecked Sendable {
    /// Set once, and only used, on the main actor.
    nonisolated(unsafe) var deliver: @MainActor ([CoreEvent]) -> Void = { _ in }
    private let lock = NSLock()
    private var waiting: [CoreEvent] = []

    func add(_ event: CoreEvent) {
        let first = lock.withLock {
            waiting.append(event)
            return waiting.count == 1
        }
        guard first else { return }
        DispatchQueue.main.async { [self] in
            let events = lock.withLock {
                defer { waiting = [] }
                return waiting
            }
            MainActor.assumeIsolated { deliver(events) }
        }
    }
}
