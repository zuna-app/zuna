import Foundation
import os
import UIKit
import ZunaHost
import ZunaModels
#if ZUNA_TELEGRAM
import TDLib
#endif

/// What the core is given for Telegram (docs/TELEGRAM_PLAN.md, "On the iPhone and iPad"): TDLib in
/// the app's own process, behind the broker (`ZunaHost/TelegramBridge.swift`), in a build given
/// Telegram's api_id, which links it (`ZUNA_TELEGRAM`, apps/ios/telegram.yml). Without one the app
/// has no TDLib and no Telegram.
enum TelegramSetup {
    /// The api_id and api_hash come from the app's Info.plist (`TELEGRAM_API_ID` and
    /// `TELEGRAM_API_HASH`, apps/ios/project.yml). A development build uses Telegram's test servers,
    /// unless launched with `-ZunaTelegramTestDC NO`.
    @MainActor static func configuration() -> TelegramBridge.Configuration? {
        #if ZUNA_TELEGRAM
        let info = Bundle.main.infoDictionary ?? [:]
        #if DEBUG
        let testDc = UserDefaults.standard.object(forKey: "ZunaTelegramTestDC") as? Bool ?? true
        #else
        let testDc = false
        #endif
        guard let credentials = TelegramBridge.Credentials(apiId: info["ZunaTelegramApiId"] as? String ?? "", apiHash: info["ZunaTelegramApiHash"] as? String ?? "", testDc: testDc) else { return nil }
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        guard let folder = folder() else { return nil }
        var configuration = TelegramBridge.Configuration(
            credentials: credentials,
            engine: TDLibEngine.shared,
            folder: folder,
            version: info["CFBundleShortVersionString"] as? String ?? "0",
            system: pad ? "iPadOS" : "iOS",
            device: pad ? "iPad" : "iPhone"
        )
        configuration.words = { key, values in t(key, values) }
        // A development build's push token is for Apple's sandbox, as its entitlement says; TestFlight's and the App Store's aren't.
        #if DEBUG
        configuration.pushSandbox = true
        #endif
        return configuration
        #else
        return nil
        #endif
    }

    /// TDLib's folder: beside the core's data in the App Group, under the core's lock, so that
    /// whichever process holds the lock can open it, the app or the share extension
    /// (docs/IOS_TELEGRAM_SHARE_PLAN.md). Each closes TDLib before it lets go of the lock, as iOS
    /// ends a process it suspends with a lock held there, and TDLib holds its database's.
    static func folder() -> URL? {
        try? SharedStorage.dataDirectory().appendingPathComponent("telegram", isDirectory: true)
    }

    /// Where it was until 2026-11-22: the app's own container, which no extension can open.
    private static var formerFolder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("telegram", isDirectory: true)
    }

    /// Moves TDLib's folder from the app's own container into the App Group, once, so that an account
    /// linked before keeps its database and isn't linked again. Only by the app, with the core's lock
    /// held and before TDLib first starts: a rename, as both are on one volume. With both there, the
    /// App Group's is the one TDLib last ran on, and the other goes.
    static func moveFolder() {
        let files = FileManager.default
        let former = formerFolder
        guard files.fileExists(atPath: former.path), let folder = folder() else { return }
        if files.fileExists(atPath: folder.path) {
            try? files.removeItem(at: former)
            return
        }
        do {
            try files.moveItem(at: former, to: folder)
        } catch {
            Logger(subsystem: "chat.zuna", category: "telegram").error("TDLib's folder couldn't be moved into the app group: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// A VoIP push of Telegram's, for a call on the linked account (docs/TELEGRAM_CALLS_PLAN.md, An
/// iPhone ringing with Zuna closed). It comes to the same handler as a server's, as an app has one
/// VoIP token, and is told from one by its shape: Telegram's encrypted field, for the ID kept.
enum TelegramCallPush {
    /// Whether a push that isn't a server's is Telegram's for this account. One whose ID can't be
    /// checked yet, as before the phone's first unlock, is taken for Telegram's.
    @MainActor static func isOurs(_ payload: [AnyHashable: Any]) -> Bool {
        #if ZUNA_TELEGRAM
        guard let folder = TelegramSetup.configuration()?.folder else { return false }
        return TelegramBridge.isCallPush(payload, engine: TDLibEngine.shared, folder: folder) ?? (payload["p"] is String)
        #else
        return false
        #endif
    }

    /// The push as TDLib reads it.
    static func json(_ payload: [AnyHashable: Any]) -> String {
        let fields = Dictionary(uniqueKeysWithValues: payload.compactMap { key, value in (key as? String).map { ($0, value) } })
        guard JSONSerialization.isValidJSONObject(fields), let data = try? JSONSerialization.data(withJSONObject: fields) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

#if ZUNA_TELEGRAM
/// TDLib's JSON interface (`td/telegram/td_json_client.h`), in the ZunaTD framework, which links what
/// `scripts/tdlib.mjs --ios` builds (apps/ios/telegram.yml). Every client's answers and updates come from one call,
/// `td_receive`, which only one thread may make, so one thread makes it while there's a client and
/// hands each to its client by the `@client_id` TDLib puts at its end. The broker makes one client
/// at a time.
final class TDLibEngine: TelegramEngine, @unchecked Sendable {
    static let shared = TDLibEngine()

    private static let log = Logger(subsystem: "chat.zuna", category: "telegram")
    private let lock = NSLock()
    private var clients: [Int32: Client] = [:]
    private var receiving = false

    final class Client: TelegramClient, @unchecked Sendable {
        let id: Int32
        let heard: @Sendable (String) -> Void
        let closed: @Sendable () -> Void

        init(id: Int32, heard: @escaping @Sendable (String) -> Void, closed: @escaping @Sendable () -> Void) {
            self.id = id
            self.heard = heard
            self.closed = closed
        }

        /// One with a NUL in it, which JSON escapes and TDLib couldn't read, goes nowhere.
        func send(_ json: String) {
            guard !json.utf8.contains(0) else { return }
            #if DEBUG
            TDLibEngine.endIfAsked(before: json)
            #endif
            json.withCString { td_send(id, $0) }
        }
    }

    func makeClient(heard: @escaping @Sendable (String) -> Void, closed: @escaping @Sendable () -> Void) -> any TelegramClient {
        let client = Client(id: td_create_client_id(), heard: heard, closed: closed)
        let start = lock.withLock { () -> Bool in
            clients[client.id] = client
            defer { receiving = true }
            return !receiving
        }
        if start {
            let thread = Thread { [self] in receive() }
            thread.name = "td-receive"
            thread.start()
        }
        return client
    }

    @discardableResult
    func execute(_ json: String) -> String? {
        guard let answer = json.withCString({ td_execute($0) }) else { return nil }
        return String(cString: answer)
    }

    // MARK: TDLib's last words

    private static let wordsLock = NSLock()
    nonisolated(unsafe) private static var lastWords: (@Sendable (String) -> Void)?

    func onLastWords(_ said: @escaping @Sendable (String) -> Void) {
        Self.wordsLock.withLock { Self.lastWords = said }
        // Only what's logged at 0, which is a fatal error: TDLib ends the process when this returns.
        td_set_log_message_callback(0) { level, message in
            guard level == 0, let message else { return }
            TDLibEngine.said(String(cString: message))
        }
    }

    private static func said(_ words: String) {
        log.fault("TDLib ends the app: \(words, privacy: .public)")
        let said = wordsLock.withLock { lastWords }
        said?(words)
    }

    #if DEBUG
    /// For the checks of what keeps a TDLib that ends the app from ending it at every start: with
    /// `-ZunaTelegramEndAtStart YES`, the app ends as TDLib would, saying so, just before TDLib is
    /// given its parameters, which is after the start's mark is left.
    fileprivate static func endIfAsked(before json: String) {
        guard json.contains("\"setTdlibParameters\""), UserDefaults.standard.bool(forKey: "ZunaTelegramEndAtStart") else { return }
        said("[ 0][t 1][1700000000.0][Td.cpp:1][#1][!Td]\tCheck failed, as the checks asked (ZunaTelegramEndAtStart)")
        abort()
    }
    #endif

    // MARK: Receiving

    /// Hands each answer and update to its client, until the last client has closed.
    private func receive() {
        while true {
            // What td_receive returns lives until it's called again, so it's copied at once.
            if let answer = td_receive(10) {
                let json = String(cString: answer)
                let id = Self.clientID(of: json)
                let client = lock.withLock { id.flatMap { clients[$0] } }
                if let client {
                    client.heard(json)
                    if Self.isClosing(json) {
                        lock.withLock { _ = clients.removeValue(forKey: client.id) }
                        client.closed()
                    }
                }
            }
            let done = lock.withLock { () -> Bool in
                guard clients.isEmpty else { return false }
                receiving = false
                return true
            }
            if done { return }
        }
    }

    /// The client an answer is for, by the `@client_id` TDLib writes last in it.
    static func clientID(of json: String) -> Int32? {
        guard let found = json.range(of: "\"@client_id\":", options: .backwards) else { return nil }
        let digits = json[found.upperBound...].prefix { $0.isNumber }
        return Int32(digits)
    }

    private static func isClosing(_ json: String) -> Bool {
        guard json.contains("\"authorizationStateClosed\""), let data = json.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["@type"] as? String == "updateAuthorizationState",
              let state = value["authorization_state"] as? [String: Any] else { return false }
        return state["@type"] as? String == "authorizationStateClosed"
    }
}
#endif
