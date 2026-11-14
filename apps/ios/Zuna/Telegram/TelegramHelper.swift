import ExtensionFoundation
import Foundation
import os
import UIKit
@preconcurrency import XPC
import ZunaHost

/// Where the Telegram helper binds (`ZunaTelegram`), which iOS runs as a process of its own in an
/// extension's sandbox, apart from the app (docs/TELEGRAM_PLAN.md, "On the iPhone and iPad"). Only
/// an extension inside Zuna's own bundle binds to it, which is the default.
///
/// Not `EnhancedSecurity()`: on a phone that sandbox lets the helper write no file anywhere, its
/// own container included, nor connect or bind a socket, its own loopback included, nor make a
/// socket pair or a kqueue, so TDLib can't keep its session or run at all, and descriptors the
/// app sends over XPC don't reach it. Measured on
/// iOS 27.0.1 on 2026-11-14 with `telegramProbe`.
@available(iOS 26.0, *)
extension AppExtensionPoint {
    @Definition
    static var telegram: AppExtensionPoint {
        Name("telegram")
    }
}

enum TelegramHelper {
    /// The helper's bundle, inside the app's.
    static let bundle = "chat.zuna.mobile.telegram"

    /// What the core is given for Telegram, on an iPhone that can run the helper, in a build given
    /// Telegram's api_id (`TELEGRAM_API_ID` and `TELEGRAM_API_HASH`, apps/ios/project.yml). A
    /// development build uses Telegram's test servers, unless launched with `-ZunaTelegramTestDC NO`.
    @MainActor static func configuration() -> TelegramBridge.Configuration? {
        guard #available(iOS 26.0, *) else { return nil }
        // A build without the helper, as one made without Telegram's api_id, has no Telegram.
        guard FileManager.default.fileExists(atPath: Bundle.main.bundleURL.appendingPathComponent("Extensions/ZunaTelegram.appex").path) else { return nil }
        let info = Bundle.main.infoDictionary ?? [:]
        #if DEBUG
        let testDc = UserDefaults.standard.object(forKey: "ZunaTelegramTestDC") as? Bool ?? true
        #else
        let testDc = false
        #endif
        guard let credentials = TelegramBridge.Credentials(apiId: info["ZunaTelegramApiId"] as? String ?? "", apiHash: info["ZunaTelegramApiHash"] as? String ?? "", testDc: testDc) else { return nil }
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        var configuration = TelegramBridge.Configuration(
            credentials: credentials,
            launcher: XPCLauncher(),
            version: info["CFBundleShortVersionString"] as? String ?? "0",
            system: pad ? "iPadOS" : "iOS",
            device: pad ? "iPad" : "iPhone"
        )
        // A development build's push token is for Apple's sandbox, as its entitlement says; TestFlight's and the App Store's aren't.
        #if DEBUG
        configuration.pushSandbox = true
        #endif
        return configuration
    }
}

@available(iOS 26.0, *)
private struct XPCLauncher: TelegramHelperLauncher {
    private static let log = Logger(subsystem: "chat.zuna", category: "telegram")

    func launch(_ handlers: TelegramHelperHandlers) async throws -> any TelegramHelperLink {
        let monitor = try await AppExtensionPoint.Monitor(appExtensionPoint: .telegram)
        guard let identity = monitor.identities.first(where: { $0.bundleIdentifier == TelegramHelper.bundle }) else {
            throw CoreError(description: "Telegram's engine isn't in this build of Zuna.")
        }
        // A helper still closing from the run before turns a new session away, until it's gone.
        var lastError: Error = CoreError(description: "Telegram's engine didn't start.")
        for _ in 0..<20 {
            do {
                return try await XPCLink.connect(identity, handlers)
            } catch {
                lastError = error
                Self.log.info("the helper isn't ready yet: \(error.localizedDescription, privacy: .public)")
                try await Task.sleep(for: .milliseconds(500))
            }
        }
        throw lastError
    }
}

/// One run of the helper, over its XPC session.
@available(iOS 26.0, *)
private final class XPCLink: TelegramHelperLink, @unchecked Sendable {
    private let process: AppExtensionProcess
    private let session: XPCSession
    private let handlers: TelegramHelperHandlers
    private let lock = NSLock()
    private var over = false

    private init(process: AppExtensionProcess, session: XPCSession, handlers: TelegramHelperHandlers) {
        self.process = process
        self.session = session
        self.handlers = handlers
    }

    /// Its process, and a session it has taken.
    static func connect(_ identity: AppExtensionIdentity, _ handlers: TelegramHelperHandlers) async throws -> XPCLink {
        let interrupted = Interrupted()
        let process = try await AppExtensionProcess(configuration: .init(appExtensionIdentity: identity, onInterruption: {
            interrupted.link?.end("Telegram's engine stopped.")
        }))
        let session: XPCSession
        do {
            session = try process.makeXPCSession()
        } catch {
            process.invalidate()
            throw error
        }
        let link = XPCLink(process: process, session: session, handlers: handlers)
        session.setIncomingMessageHandler { (message: XPCDictionary) -> XPCDictionary? in
            link.received(message)
        }
        do {
            try session.activate()
            // That it's there and took this session.
            var hello = XPCDictionary()
            hello["hello"] = true
            let reply = try session.sendSync(message: hello)
            guard reply["ok"] == true else { throw CoreError(description: "Telegram's engine turned the app away.") }
        } catch {
            session.cancel(reason: "not started")
            process.invalidate()
            throw error
        }
        interrupted.link = link
        return link
    }

    private final class Interrupted: @unchecked Sendable {
        weak var link: XPCLink?
    }

    private func received(_ message: XPCDictionary) -> XPCDictionary? {
        if let json: String = message[TelegramWire.json] {
            if json.utf8.count <= TelegramWire.mostJSON { handlers.json(json) }
            return nil
        }
        if let stream = TelegramWire.streamID(in: message), let bytes = TelegramWire.data(TelegramWire.bytes, in: message) {
            // Answered once it's gone to Telegram, which is when the helper reads the next part.
            let answer = TelegramWire.Answer(message)
            handlers.data(stream, bytes) { answer.reply() }
            return nil
        }
        return nil
    }

    /// The helper went, or this ended it: said once.
    fileprivate func end(_ why: String) {
        let first = lock.withLock { () -> Bool in
            defer { over = true }
            return !over
        }
        if first { handlers.ended(why) }
    }

    func send(json: String) {
        do { try session.send(message: TelegramWire.message(json: json)) } catch { end("Telegram's engine can't be reached: \(error.localizedDescription)") }
    }

    func send(stream: UInt32, bytes: Data, taken: @escaping @Sendable (Bool) -> Void) {
        session.send(message: TelegramWire.message(stream: stream, bytes: bytes)) { result in
            if case .success = result { taken(true) } else { taken(false) }
        }
    }

    func open(path: String, done: @escaping @Sendable (Result<FileHandle, Error>) -> Void) {
        var ask = XPCDictionary()
        ask[TelegramWire.file] = path
        session.send(message: ask) { result in
            switch result {
            case .success(let reply):
                if let descriptor = TelegramWire.descriptor(in: reply) {
                    done(.success(FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)))
                } else {
                    done(.failure(CoreError(description: reply[TelegramWire.error] ?? "Telegram's file couldn't be read.")))
                }
            case .failure(let error):
                done(.failure(error))
            }
        }
    }

    func close() {
        session.cancel(reason: "the app stopped Telegram")
        process.invalidate()
        end("stopped")
    }
}
