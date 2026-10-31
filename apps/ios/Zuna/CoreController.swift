import Foundation
import Observation
import UIKit
import ZunaHost
#if DEBUG
import ZunaControl
#endif

/// Starts the client core and keeps it for the life of the app.
@MainActor
@Observable
final class CoreController {
    enum Phase: Equatable {
        case booting
        case ready
        case failed(String)
    }

    private(set) var phase: Phase = .booting
    private(set) var runtime: CoreRuntime?
    #if DEBUG
    private var control: ControlServer?
    #endif

    static let appGroup = "group.chat.zuna.app"

    func start() async {
        do {
            let directory = try Self.dataDirectory()
            let deviceKey = try Self.deviceKey(dataDirectory: directory)
            var options = CoreRuntime.Options(
                dataDirectory: directory,
                deviceKey: deviceKey,
                deviceName: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
            )
            #if DEBUG
            options.logToStandardError = true
            #endif
            let runtime = try CoreRuntime(options: options)
            try await runtime.start()
            self.runtime = runtime
            #if DEBUG
            // Launch arguments arrive as strings, which integer(forKey:) parses.
            let port = UserDefaults.standard.integer(forKey: "ZunaControlPort")
            if port > 0 {
                let server = ControlServer(runtime: runtime)
                let bound = try await server.start(port: UInt16(port))
                control = server
                print("ZUNA_HOST_READY port=\(bound)")
            }
            #endif
            phase = .ready
        } catch {
            phase = .failed(String(describing: error))
        }
    }

    /// Where the databases live: the App Group container, so a notification
    /// extension can read them later. Protected until the first unlock after a
    /// restart, and kept out of backups, since they're useless without the
    /// device-only key.
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

    /// The device key, created on first launch. Databases without their key
    /// (a backup restored onto another phone) can't be read, so they're erased
    /// and the account is signed in again from the server.
    static func deviceKey(dataDirectory: URL) throws -> Data {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "ZunaResetData") {
            DeviceKeyStore.delete()
            try? FileManager.default.contentsOfDirectory(at: dataDirectory, includingPropertiesForKeys: nil)
                .forEach { try? FileManager.default.removeItem(at: $0) }
        }
        #endif
        if let key = try DeviceKeyStore.load() { return key }
        let fileManager = FileManager.default
        for file in (try? fileManager.contentsOfDirectory(at: dataDirectory, includingPropertiesForKeys: nil)) ?? [] {
            try? fileManager.removeItem(at: file)
        }
        return try DeviceKeyStore.create()
    }
}
