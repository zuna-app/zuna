import Foundation
import JavaScriptCore
import os

public struct CoreError: Error, CustomStringConvertible {
    public let description: String
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
    private let crypto = CryptoBridge()
    private let database: DatabaseBridge
    private var network: NetworkBridge!
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
        // Decrypted files from an earlier run aren't needed any more.
        try? FileManager.default.removeItem(at: options.cacheDirectory)
        try FileManager.default.createDirectory(at: options.cacheDirectory, withIntermediateDirectories: true)
        context = JSContext(virtualMachine: JSVirtualMachine())!
        context.name = "Zuna core"
        context.exceptionHandler = { [weak self] _, exception in
            let stack = exception?.forProperty("stack")?.toString() ?? ""
            self?.log("error", "Uncaught \(exception?.toString() ?? "exception")\n\(stack)")
        }
        network = NetworkBridge(queue: queue) { [unowned self] function, arguments in
            call(function, arguments)
        }
        installHost()
        crypto.install(in: context)
        database.install(in: context)
        context.evaluateScript(source, withSourceURL: url)
        if context.objectForKeyedSubscript("__zunaBoot")?.isUndefined ?? true {
            throw CoreError(description: "The core bundle didn't load.")
        }
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
        network.install(into: host)
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
