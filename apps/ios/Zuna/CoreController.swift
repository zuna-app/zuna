import Foundation
import Network
import Observation
import UIKit
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
    #endif

    static let appGroup = "group.chat.zuna.app"

    func start() async {
        do {
            let directory = try Self.dataDirectory()
            self.directory = directory
            #if DEBUG
            if UserDefaults.standard.bool(forKey: "ZunaResetData") {
                DeviceKeyStore.forget()
                Self.erase(directory)
                AppSettings.reset()
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
    func didEnterBackground() {
        guard connection != nil, suspendTask == nil else { return }
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

    /// Back on screen: reconnect right away and catch up.
    func didBecomeActive() {
        suspendTask?.cancel()
        suspendTask = nil
        endBackgroundTask()
        guard let connection else { return }
        Task {
            try? await connection.resume()
            try? await connection.nudge()
        }
    }

    private func suspendNow() {
        suspendTask?.cancel()
        suspendTask = nil
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

    /// Where the databases live: the App Group container, so a notification
    /// extension can read them later. Protected until the first unlock after a
    /// restart, and kept out of backups, since they're useless without the
    /// device key.
    static func dataDirectory() throws -> URL {
        let fileManager = FileManager.default
        let base = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var directory = base.appendingPathComponent("Zuna", isDirectory: true)
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory
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
            return await self?.handleControl(name: name, password: password, account: account)
        }
        control = server
        guard let bound = try? await server.start(port: UInt16(port)) else { return }
        print("ZUNA_HOST_READY port=\(bound)")
    }

    private func handleControl(name: String?, password: String?, account: Int?) async -> String {
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
        case "drift":
            return connection?.driftReports.joined(separator: "\n") ?? ""
        default:
            return "unknown"
        }
    }
    #endif
}
