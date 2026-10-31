import Foundation
import Observation
import UIKit
import ZunaHost
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
    private var directory: URL?
    /// Lock file updates run one at a time, off the main thread (Argon2id is slow on purpose).
    private let lockQueue = DispatchQueue(label: "chat.zuna.device-lock")
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
        var options = CoreRuntime.Options(
            dataDirectory: directory,
            deviceKey: key,
            deviceName: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        )
        let lockQueue = lockQueue
        options.onAccountEvent = { event in
            lockQueue.async { Self.updateLock(in: directory, deviceKey: key, with: event) }
        }
        #if DEBUG
        options.logToStandardError = true
        #endif
        let runtime = try CoreRuntime(options: options)
        try await runtime.start()
        self.runtime = runtime
        #if DEBUG
        control?.attach(runtime)
        #endif
        phase = .ready
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
        let server = ControlServer()
        server.commandHandler = { [weak self] command in
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
        default:
            return "unknown"
        }
    }
    #endif
}
