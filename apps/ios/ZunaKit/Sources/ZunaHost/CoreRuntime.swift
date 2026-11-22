import Foundation
import JavaScriptCore
import os

public struct CoreError: Error, CustomStringConvertible, LocalizedError {
    public let description: String

    public init(description: String) {
        self.description = description
    }

    public var errorDescription: String? { description }
}

/// A sign-in, password change or sign-out, reported by the core bundle so the
/// app can keep its device lock in step. `password` is set for sign-ins and
/// password changes.
public struct AccountEvent: Decodable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case signedIn, passwordChanged, signedOut
    }

    public let type: Kind
    public let serverUrl: String
    public let username: String
    public let serverName: String
    public let password: String?
}

/// Runs the shared TypeScript client core (`@zuna/core`) in JavaScriptCore on a
/// queue of its own, like the desktop runs it in a Worker. Everything that
/// touches the JavaScript context happens on that queue, so the core keeps the
/// single-threaded behavior it was written for.
///
/// Callers talk to the core through channels that carry the same RPC messages
/// as `packages/core/src/rpc.ts`: the app's UI is one channel, and in test
/// builds the control server opens more.
public final class CoreRuntime: @unchecked Sendable {
    public struct Options: Sendable {
        public var dataDirectory: URL
        /// Where downloaded files are decrypted to. Emptied whenever the core starts.
        public var cacheDirectory: URL
        public var deviceKey: Data
        public var deviceName: String
        /// Also print the core's log to standard error, for the command-line host.
        public var logToStandardError = false
        /// Called on the core's queue when an account signs in, changes its password or signs out.
        public var onAccountEvent: (@Sendable (AccountEvent) -> Void)?
        /// The app lists a server's bots itself, so the core gives it a chat with a bot nobody has written to yet.
        public var listsBots = false
        /// A linked Telegram account's engine, TDLib in the app's own process (docs/TELEGRAM_PLAN.md),
        /// where the app has one: in a build given Telegram's api_id. Without it, no Telegram.
        public var telegram: TelegramBridge.Configuration?
        /// The app has calls on the linked Telegram account, whose media it runs itself
        /// (docs/TELEGRAM_CALLS_PLAN.md). Without it, Telegram's own apps take them.
        public var telegramCalls = false
        /// The app gives Telegram its push token, so Telegram pushes it the linked account's messages while
        /// it's away (`setTelegramPushToken`): what the engine hears of late, as it catches up, the core
        /// then notifies of nowhere, as the push told of it, or Telegram left it untold as read elsewhere.
        public var telegramPushed = false

        public init(dataDirectory: URL, cacheDirectory: URL? = nil, deviceKey: Data, deviceName: String) {
            self.dataDirectory = dataDirectory
            self.cacheDirectory = cacheDirectory ?? dataDirectory.appendingPathComponent("decrypted", isDirectory: true)
            self.deviceKey = deviceKey
            self.deviceName = deviceName
        }
    }

    public let options: Options
    let queue = DispatchQueue(label: "chat.zuna.core", qos: .userInitiated)
    private let logger = Logger(subsystem: "chat.zuna", category: "core")
    private var context: JSContext!
    /// The language last given (`setLanguage`), for each context loaded after it: `start()` loads
    /// the core anew, which would otherwise word everything in English.
    private var language: (tag: String, catalog: String?)?
    private let crypto = CryptoBridge()
    private let database: DatabaseBridge
    private var network: NetworkBridge!
    private var web: WebBridge!
    private var telegram: TelegramBridge?
    /// The app's push token, for Telegram's pushes, kept until the bridge is made.
    private var telegramPushToken: String?
    /// Whether the app is out of sight, for a bridge made while it is.
    private var telegramOutOfSight = false
    /// Whether this process holds the core's lock, under which a linked Telegram account's database
    /// is: TDLib runs only while it does (docs/IOS_TELEGRAM_SHARE_PLAN.md). The app does from its
    /// start, and the share extension only once it says so.
    private lazy var telegramHeld = !(options.telegram?.waitsForLock ?? false)
    /// The VoIP token for Telegram's calls, while this device takes them, kept until the bridge is made.
    private var telegramVoipToken: String?
    /// Calls' pushes that came before the bridge was made.
    private var telegramCallPushes: [(payload: String, done: @Sendable (Bool) -> Void)] = []
    private var timers: [Int: DispatchSourceTimer] = [:]
    private var channels: [Int: Channel] = [:]
    private var nextChannel = 1

    public init(options: Options) throws {
        self.options = options
        try FileManager.default.createDirectory(at: options.dataDirectory, withIntermediateDirectories: true)
        database = DatabaseBridge(directory: options.dataDirectory)
    }

    /// Loads the core bundle and opens the client. Throws if the core couldn't start.
    public func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                do {
                    // Decrypted files from an earlier run aren't needed any more.
                    try? FileManager.default.removeItem(at: options.cacheDirectory)
                    try FileManager.default.createDirectory(at: options.cacheDirectory, withIntermediateDirectories: true)
                    try load()
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                let done: @convention(block) (JSValue) -> Void = { error in
                    if error.isNull || error.isUndefined {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: CoreError(description: error.toString() ?? "The core failed to start."))
                    }
                }
                call("__zunaBoot", [options.deviceKey, options.deviceName, JSValue(object: done, in: context) as Any])
            }
        }
    }

    /// What a notification shows for a pushed message, as JSON (`PushPreview`
    /// in the core). For the notification extension, which loads the bundle
    /// without booting a client: nothing connects, and nothing is written.
    /// With `pictures`, the sender's and the group's pictures come along, as base64.
    public func previewPush(serverId: String, groupId: String, messageId: String, pictures: Bool = false) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            queue.async { [self] in
                do {
                    if context == nil { try load() }
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                let done: @convention(block) (JSValue, JSValue) -> Void = { error, json in
                    if error.isNull || error.isUndefined {
                        continuation.resume(returning: json.toString() ?? "")
                    } else {
                        continuation.resume(throwing: CoreError(description: error.toString() ?? "The message couldn't be read."))
                    }
                }
                call("__zunaPreviewPush", [options.deviceKey, serverId, groupId, messageId, pictures, JSValue(object: done, in: context) as Any])
            }
        }
    }

    /// The chats a server still counts this device as showing a notification for, as JSON: their groups'
    /// IDs, and when those read elsewhere were (`notifiedChats` in the core). Like a preview, it needs no
    /// client: nothing connects but the one request, and nothing is written.
    public func notifiedChats(serverId: String) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            queue.async { [self] in
                do {
                    if context == nil { try load() }
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                let done: @convention(block) (JSValue, JSValue) -> Void = { error, json in
                    if error.isNull || error.isUndefined {
                        continuation.resume(returning: json.toString() ?? "")
                    } else {
                        continuation.resume(throwing: CoreError(description: error.toString() ?? "The server couldn't be asked."))
                    }
                }
                call("__zunaNotifiedChats", [options.deviceKey, serverId, JSValue(object: done, in: context) as Any])
            }
        }
    }

    /// What a phone shows for a call it was woken to ring for, as JSON (`CallPreview` in the core), from what's on
    /// the device alone. For the notification extension and for PushKit, which wants a call reported at once.
    public func previewCall(serverId: String, groupId: String, callerId: String) async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            queue.async { [self] in
                do {
                    if context == nil { try load() }
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                let done: @convention(block) (JSValue, JSValue) -> Void = { error, json in
                    if error.isNull || error.isUndefined {
                        continuation.resume(returning: json.toString() ?? "")
                    } else {
                        continuation.resume(throwing: CoreError(description: error.toString() ?? "The call couldn't be read."))
                    }
                }
                call("__zunaPreviewCall", [options.deviceKey, serverId, groupId, callerId, JSValue(object: done, in: context) as Any])
            }
        }
    }

    /// Opens a channel to the core. `onMessage` receives replies to this
    /// channel's calls and every event, on the core's queue.
    public func connect(onMessage: @escaping @Sendable (String) -> Void) -> Channel {
        queue.sync {
            let channel = Channel(id: nextChannel, runtime: self, onMessage: onMessage)
            nextChannel += 1
            channels[channel.id] = channel
            return channel
        }
    }

    public final class Channel: @unchecked Sendable {
        public let id: Int
        fileprivate weak var runtime: CoreRuntime?
        fileprivate let onMessage: @Sendable (String) -> Void

        fileprivate init(id: Int, runtime: CoreRuntime, onMessage: @escaping @Sendable (String) -> Void) {
            self.id = id
            self.runtime = runtime
            self.onMessage = onMessage
        }

        /// Sends one RPC message, as JSON.
        public func send(_ json: String) {
            guard let runtime else { return }
            runtime.queue.async { runtime.call("__zunaReceive", [self.id, json]) }
        }

        public func close() {
            guard let runtime else { return }
            runtime.queue.async { runtime.channels[self.id] = nil }
        }
    }

    // MARK: Loading

    private func load() throws {
        guard let url = Bundle.module.url(forResource: "zuna-core", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw CoreError(description: "The core bundle is missing. Run apps/ios/core-bundle/build.mjs.")
        }
        context = JSContext(virtualMachine: JSVirtualMachine())!
        context.name = "Zuna core"
        context.exceptionHandler = { [weak self] _, exception in
            let stack = exception?.forProperty("stack")?.toString() ?? ""
            self?.log("error", "Uncaught \(exception?.toString() ?? "exception")\n\(stack)")
        }
        network = NetworkBridge(queue: queue) { [unowned self] function, arguments in
            call(function, arguments)
        }
        web = WebBridge(queue: queue) { [unowned self] function, arguments in
            call(function, arguments)
        }
        installHost()
        crypto.install(in: context)
        database.install(in: context)
        context.evaluateScript(source, withSourceURL: url)
        if context.objectForKeyedSubscript("__zunaBoot")?.isUndefined ?? true {
            throw CoreError(description: "The core bundle didn't load.")
        }
        if let language { call("__zunaLanguage", [language.tag, language.catalog as Any? ?? NSNull()]) }
    }

    private func installHost() {
        let host = JSValue(newObjectIn: context)!
        func define(_ name: String, _ block: Any) {
            host.setObject(block, forKeyedSubscript: name as NSString)
        }

        let log: @convention(block) (String, String) -> Void = { [unowned self] level, message in
            self.log(level, message)
        }
        define("log", log)

        let setTimer: @convention(block) (Double, Double, Bool) -> Void = { [unowned self] id, ms, repeats in
            let key = Int(id)
            let timer = DispatchSource.makeTimerSource(queue: queue)
            let interval = DispatchTimeInterval.microseconds(max(Int(ms * 1000), repeats ? 1000 : 0))
            timer.schedule(deadline: .now() + interval, repeating: repeats ? interval : .never)
            timer.setEventHandler { [unowned self] in
                if !repeats { timers.removeValue(forKey: key)?.cancel() }
                call("__zunaTimerFired", [key])
            }
            timers[key] = timer
            timer.resume()
        }
        define("setTimer", setTimer)

        let clearTimer: @convention(block) (Double) -> Void = { [unowned self] id in
            timers.removeValue(forKey: Int(id))?.cancel()
        }
        define("clearTimer", clearTimer)

        let utf8Encode: @convention(block) (String) -> JSValue = { text in
            JSBytes.make(Data(text.utf8), in: JSContext.current())
        }
        define("utf8Encode", utf8Encode)

        let utf8Decode: @convention(block) (JSValue) -> String = { value in
            let data = JSBytes.read(value) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
        define("utf8Decode", utf8Decode)

        let base64Encode: @convention(block) (JSValue) -> String = { value in
            (JSBytes.read(value) ?? Data()).base64EncodedString()
        }
        define("base64Encode", base64Encode)

        let base64Decode: @convention(block) (String) -> JSValue = { text in
            let context = JSContext.current()!
            guard let data = Data(base64Encoded: text) else {
                return throwError("The string to be decoded is not correctly encoded.", in: context)
            }
            return JSBytes.make(data, in: context)
        }
        define("base64Decode", base64Decode)

        let accountEvent: @convention(block) (String) -> Void = { [unowned self] json in
            guard let data = json.data(using: .utf8), let event = try? JSONDecoder().decode(AccountEvent.self, from: data) else {
                self.log("error", "An account event couldn't be read.")
                return
            }
            options.onAccountEvent?(event)
        }
        define("accountEvent", accountEvent)

        let post: @convention(block) (Double, String) -> Void = { [unowned self] channel, json in
            if channel == 0 {
                for target in channels.values { target.onMessage(json) }
            } else {
                channels[Int(channel)]?.onMessage(json)
            }
        }
        define("post", post)

        installFiles(into: host)
        installTelegram(into: host)
        network.install(into: host)
        web.install(into: host)
        if options.listsBots {
            host.setObject(true, forKeyedSubscript: "listsBots" as NSString)
        }
        if options.telegramCalls {
            host.setObject(true, forKeyedSubscript: "telegramCalls" as NSString)
        }
        if options.telegramPushed {
            host.setObject(true, forKeyedSubscript: "telegramPushed" as NSString)
        }
        // The App Store's rules: what TDLib restricts on a linked Telegram account is withheld on
        // every iPhone and iPad, with no way to lift it, and 18+ media unless the account lets it
        // through from another device (docs/TELEGRAM.md).
        host.setObject(true, forKeyedSubscript: "telegramRestricted" as NSString)
        #if DEBUG
        // Turns on the bundle's test hooks (a movable clock, access to the client). Release builds leave them off.
        host.setObject(true, forKeyedSubscript: "testHooks" as NSString)
        #endif
        context.setObject(host, forKeyedSubscript: "__zunaHost" as NSString)
    }

    /// Reading files to upload a chunk at a time, and writing downloaded ones to the cache.
    private func installFiles(into host: JSValue) {
        let fileSize: @convention(block) (String) -> Double = { path in
            ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.doubleValue ?? 0
        }
        host.setObject(fileSize, forKeyedSubscript: "fileSize" as NSString)

        let fileRead: @convention(block) (String, Double, Double) -> JSValue = { path, start, end in
            let context = JSContext.current()!
            guard let handle = FileHandle(forReadingAtPath: path) else { return throwError("Couldn't open a file to send.", in: context) }
            defer { try? handle.close() }
            do {
                try handle.seek(toOffset: UInt64(start))
                return JSBytes.make(try handle.read(upToCount: Int(end - start)) ?? Data(), in: context)
            } catch {
                return throwError("Couldn't read a file to send: \(error.localizedDescription)", in: context)
            }
        }
        host.setObject(fileRead, forKeyedSubscript: "fileRead" as NSString)

        let fileAssemble: @convention(block) (JSValue, String) -> JSValue = { [unowned self] parts, fileExtension in
            let context = JSContext.current()!
            let url = options.cacheDirectory.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]),
                  let handle = FileHandle(forWritingAtPath: url.path) else {
                return throwError("Couldn't save a downloaded file.", in: context)
            }
            defer { try? handle.close() }
            do {
                for part in parts.arrayElements {
                    if let data = JSBytes.read(part) { try handle.write(contentsOf: data) }
                }
            } catch {
                return throwError("Couldn't save a downloaded file: \(error.localizedDescription)", in: context)
            }
            return JSValue(object: url.path, in: context)
        }
        host.setObject(fileAssemble, forKeyedSubscript: "fileAssemble" as NSString)
    }

    /// A linked Telegram account's engine: started, asked and stopped by the core's adapter,
    /// through the broker, which answers back through `__zunaTelegram`.
    private func installTelegram(into host: JSValue) {
        guard let configuration = options.telegram else { return }
        host.setObject(true, forKeyedSubscript: "telegramAvailable" as NSString)

        let bridge: () -> TelegramBridge = { [unowned self] in
            if let telegram { return telegram }
            let made = TelegramBridge(configuration: configuration, dataDirectory: options.dataDirectory, deviceKey: options.deviceKey) { [weak self] json in
                guard let self else { return }
                queue.async { self.call("__zunaTelegram", [json]) }
            }
            made.setPushToken(telegramPushToken)
            made.setVoipToken(telegramVoipToken)
            if telegramOutOfSight { made.sleep() }
            // Let go of or taken back before there was a bridge.
            if telegramHeld, configuration.waitsForLock { made.takeBack() }
            if !telegramHeld, !configuration.waitsForLock { made.letGo(within: 0) { _ in } }
            for push in telegramCallPushes { made.callPushed(push.payload, done: push.done) }
            telegramCallPushes.removeAll()
            telegram = made
            return made
        }

        let start: @convention(block) (Bool) -> String = { linked in
            bridge().start(linked: linked) ?? ""
        }
        host.setObject(start, forKeyedSubscript: "telegramStart" as NSString)

        let send: @convention(block) (String) -> Void = { [unowned self] json in
            telegram?.send(json)
        }
        host.setObject(send, forKeyedSubscript: "telegramSend" as NSString)

        let stop: @convention(block) (Bool) -> Void = { signOut in
            // With nothing running, nothing at Telegram can be ended from here: what's on this
            // device goes all the same.
            bridge().stop(signOut: signOut)
        }
        host.setObject(stop, forKeyedSubscript: "telegramStop" as NSString)

        let file: @convention(block) (Double, String) -> Void = { [unowned self] id, path in
            guard let telegram else {
                call("__zunaTelegramFile", [id, "Telegram isn't running.", NSNull()])
                return
            }
            telegram.file(path: path) { [weak self] result in
                guard let self else { return }
                queue.async {
                    switch result {
                    case .success(let found): self.call("__zunaTelegramFile", [id, NSNull(), found])
                    case .failure(let error): self.call("__zunaTelegramFile", [id, error.localizedDescription, NSNull()])
                    }
                }
            }
        }
        host.setObject(file, forKeyedSubscript: "telegramFile" as NSString)
    }

    /// The app's push token from Apple, as hex, which a linked Telegram account is pushed to.
    public func setTelegramPushToken(_ token: String?) {
        queue.async { [self] in
            telegramPushToken = token
            telegram?.setPushToken(token)
        }
    }

    /// The app's VoIP token, for Telegram's calls, while this device takes them; nil takes it back.
    public func setTelegramVoipToken(_ token: String?) {
        queue.async { [self] in
            telegramVoipToken = token
            telegram?.setVoipToken(token)
        }
    }

    /// A call's push of Telegram's woke the app: TDLib is started for it, out of sight, once the core
    /// asks for it, and `done` is told whether it was a call (`TelegramBridge.callPushed`).
    public func telegramCallPushed(_ payload: String, done: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            if let telegram {
                telegram.callPushed(payload, done: done)
            } else {
                telegramCallPushes.append((payload, done))
            }
        }
    }

    /// Closes a linked Telegram account's TDLib before this process lets go of the core's lock, as
    /// its database is under that lock: whether it closed within `limit`. Nothing starts it again
    /// until `takeBackTelegram`.
    public func letGoOfTelegram(within limit: TimeInterval = TelegramBridge.letGoWait) async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                telegramHeld = false
                guard let telegram else { return continuation.resume(returning: true) }
                telegram.letGo(within: limit) { continuation.resume(returning: $0) }
            }
        }
    }

    /// The process holds the core's lock again: TDLib starts, if it's wanted and nothing else holds
    /// it back, as the app being out of sight does.
    public func takeBackTelegram() {
        queue.async { [self] in
            telegramHeld = true
            telegram?.takeBack()
        }
    }

    /// The app left the screen, or is back on it: iOS suspends a linked Telegram account's TDLib
    /// with the app, so its broker starts nothing meanwhile, and as the app comes back has TDLib
    /// connect again at once, or starts what's owed (`TelegramBridge.sleep`, `wake`).
    public func setTelegramOutOfSight(_ away: Bool) {
        queue.async { [self] in
            telegramOutOfSight = away
            if away { telegram?.sleep() } else { telegram?.wake() }
        }
    }

    #if DEBUG
    /// Has the Telegram door lose its sockets, as iOS takes a suspended process's back.
    public func reclaimTelegram(done: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in done(telegram?.reclaim() ?? false) }
    }
    #endif

    // MARK: Calling into JavaScript

    /// Calls a global function. Data becomes Uint8Array, NSNull becomes null.
    func call(_ function: String, _ arguments: [Any]) {
        guard let target = context.objectForKeyedSubscript(function), !target.isUndefined else { return }
        let converted: [Any] = arguments.map { argument in
            if let data = argument as? Data { return JSBytes.make(data, in: context) }
            return argument
        }
        target.call(withArguments: converted)
    }

    func log(_ level: String, _ message: String) {
        switch level {
        case "error": logger.error("\(message, privacy: .public)")
        case "warn": logger.warning("\(message, privacy: .public)")
        case "debug": logger.debug("\(message, privacy: .public)")
        default: logger.info("\(message, privacy: .public)")
        }
        if options.logToStandardError {
            FileHandle.standardError.write(Data("[core \(level)] \(message)\n".utf8))
        }
    }

    /// The language the app shows, for what the core words itself, a push's preview included
    /// (`ZunaI18n`): a tag, and its catalog's JSON, or nil for English. Kept for the core loaded
    /// later, as before `start()`.
    public func setLanguage(_ tag: String, catalog: String?) {
        queue.async { [self] in
            language = (tag, catalog)
            if context != nil { call("__zunaLanguage", [tag, catalog as Any? ?? NSNull()]) }
        }
    }

    /// Closes every request and socket after the proxy changed (`NetworkProxy.use`), so that the
    /// core opens them again the new way. A runtime that hasn't loaded has nothing open.
    public func networkChanged() {
        queue.async { [self] in
            network?.cancelAll()
            telegram?.networkChanged()
        }
    }

    // MARK: Test hooks, in Debug builds only

    #if DEBUG
    /// Makes HTTP and WebSocket connections fail, as if the device were offline.
    public func setOffline(_ offline: Bool) {
        queue.async { [self] in
            network.offline = offline
            if offline { network.cancelAll() }
        }
    }

    /// Exits the process as soon as a response to `method` on a URL matching `urlPattern` arrives.
    public func crashOnResponse(method: String, urlPattern: String) {
        guard let pattern = try? NSRegularExpression(pattern: urlPattern) else { return }
        queue.async { [self] in network.crashOnResponse = (method, pattern) }
    }

    /// Runs a script in the core's context, for tests that measure or inspect it.
    public func evaluateForTesting(_ script: String, completion: @escaping @Sendable (String) -> Void) {
        queue.async { [self] in
            let value = context.evaluateScript(script)
            if let exception = context.exception {
                context.exception = nil
                completion("Error: \(exception.toString() ?? "")")
            } else {
                completion(value?.toString() ?? "undefined")
            }
        }
    }
    #endif
}
