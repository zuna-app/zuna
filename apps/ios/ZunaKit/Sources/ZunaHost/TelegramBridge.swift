import Foundation
import Network
import os
import ZunaCrypto

// The broker: the app's end of ZunaTelegram, the helper extension a linked Telegram account's
// TDLib runs in (docs/TELEGRAM_PLAN.md, "On the iPhone and iPad"), as `apps/desktop/src/telegram`
// is the desktop's. It starts and stops the helper, keeps the door, holds the key to the engine's
// database, and stands between the core and the engine: only the functions on the list go to it
// (`functions.json`), no faster than a limit, and what comes back is handed to the core as it came,
// for the adapter there to check.
//
// Nothing here reaches a Zuna server, and nothing of Telegram's goes anywhere but the core's
// adapter, which keeps none of it, and the files the interface shows, copied out of the helper's
// folder into the cache that's emptied whenever the core starts.

/// Starts the helper, which only the app can do: it's the app that defines the extension point
/// (`Zuna/Telegram/TelegramHelper.swift`). Each launch is a process of its own.
public protocol TelegramHelperLauncher: Sendable {
    func launch(_ handlers: TelegramHelperHandlers) async throws -> any TelegramHelperLink
}

/// What the helper says, as it says it.
public struct TelegramHelperHandlers: Sendable {
    /// One of TDLib's answers or updates, or one of the helper's own messages, as JSON.
    public var json: @Sendable (String) -> Void
    /// A part of a connection through the door, and what to call once it's been taken.
    public var data: @Sendable (_ stream: UInt32, _ bytes: Data, _ taken: @escaping @Sendable () -> Void) -> Void
    /// The helper went: ended, killed by the system, or never there.
    public var ended: @Sendable (String) -> Void

    public init(json: @escaping @Sendable (String) -> Void, data: @escaping @Sendable (UInt32, Data, @escaping @Sendable () -> Void) -> Void, ended: @escaping @Sendable (String) -> Void) {
        self.json = json
        self.data = data
        self.ended = ended
    }
}

/// One run of the helper.
public protocol TelegramHelperLink: AnyObject, Sendable {
    func send(json: String)
    /// A part of a connection through the door, and `taken` once the helper has written it, or false if it's gone.
    func send(stream: UInt32, bytes: Data, taken: @escaping @Sendable (Bool) -> Void)
    /// A file of the helper's folder, by the path TDLib gave, opened for reading.
    func open(path: String, done: @escaping @Sendable (Result<FileHandle, Error>) -> Void)
    /// Ends the session, which the helper takes as the app going: TDLib closes, saving what it has, and the process ends.
    func close()
}

public final class TelegramBridge: @unchecked Sendable {
    /// The app's own `api_id` and `api_hash` from Telegram (docs/TELEGRAM_PLAN.md, The api_id),
    /// which a build puts in the app's Info.plist from `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`,
    /// never from the repository. A build without them has no Telegram.
    public struct Credentials: Sendable, Equatable {
        public var apiId: Int64
        public var apiHash: String
        public var testDc: Bool

        public init?(apiId: String, apiHash: String, testDc: Bool) {
            guard let id = Int64(apiId.trimmingCharacters(in: .whitespaces)), id > 0 else { return nil }
            let hash = apiHash.trimmingCharacters(in: .whitespaces)
            guard hash.utf8.count == 32, hash.allSatisfy(\.isHexDigit) else { return nil }
            self.apiId = id
            self.apiHash = hash
            self.testDc = testDc
        }
    }

    public struct Configuration: Sendable {
        public var credentials: Credentials
        public var launcher: any TelegramHelperLauncher
        /// What Telegram is told this is: the app's version, the system's name, and an iPhone or an iPad.
        public var version: String
        public var system: String
        public var device: String
        /// How much TDLib logs, from 0 to 5.
        public var verbosity = 1
        /// Whether the app's push token is for Apple's sandbox, as a development build's is, which
        /// Telegram has to know to push to it.
        public var pushSandbox = false

        public init(credentials: Credentials, launcher: any TelegramHelperLauncher, version: String, system: String, device: String) {
            self.credentials = credentials
            self.launcher = launcher
            self.version = version
            self.system = system
            self.device = device
        }
    }

    /// How many requests the core may make, as a bucket that fills at `rate` a second up to
    /// `burst`: a fault in the adapter can't become a flood, which is what Telegram bans for.
    static let rate = 100.0
    static let burst = 500.0
    /// How often the helper is asked whether it's still there, and how long it has to answer.
    static let watchdogEvery: TimeInterval = 30
    static let watchdogWait: TimeInterval = 20
    /// How many times the helper is started again after failing, in a row, before it stays off.
    static let mostRestarts = 3
    /// How long it must run before a failure counts as a new one rather than one more in a row.
    static let ranWell: TimeInterval = 120

    static let keyInfo = Data("zuna/telegram/key/v1".utf8)

    private let configuration: Configuration
    private let dataDirectory: URL
    private let filesDirectory: URL
    private let deviceKey: Data
    private let deliver: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "chat.zuna.telegram.broker")
    private let logger = Logger(subsystem: "chat.zuna", category: "telegram")

    /// One run of the helper, from its launch to its end.
    private final class Run: @unchecked Sendable {
        let generation: Int
        var link: (any TelegramHelperLink)?
        var door: TelegramDoor?
        var pending: [String] = []
        let started = Date()
        let ended = DispatchSemaphore(value: 0)
        /// TDLib said it closed, as after signing out.
        let closed = DispatchSemaphore(value: 0)
        /// The account is signed in, so its push token can be given.
        var ready = false
        init(generation: Int) { self.generation = generation }
    }

    private var run: Run?
    /// Which run is the current one: what an older one says is ignored.
    private var generation = 0
    /// The core asked for it to run, and hasn't asked for it to stop.
    private var wanted = false
    private var failures = 0
    private var tokens = TelegramBridge.burst
    private var filled = Date()
    /// When the watchdog last asked, while it waits for the answer, and when it last looked.
    private var asked: Date?
    private var looked = Date()
    /// Files copied out of the helper's folder, by TDLib's path.
    private var copies: [String: URL] = [:]
    /// The app's push token from Apple, as hex, which Telegram pushes the account's messages to.
    private var pushToken: String?
    #if DEBUG
    /// What a probe of the box found, for the checks.
    private var probed: (@Sendable ([String: String]) -> Void)?
    #endif

    public init(configuration: Configuration, dataDirectory: URL, cacheDirectory: URL, deviceKey: Data, deliver: @escaping @Sendable (String) -> Void) {
        self.configuration = configuration
        self.dataDirectory = dataDirectory
        filesDirectory = cacheDirectory.appendingPathComponent("telegram", isDirectory: true)
        self.deviceKey = deviceKey
        self.deliver = deliver
    }

    // MARK: The key to the engine's database

    /// Where the key is kept, sealed with the device key: beside the app's other secrets, in the
    /// app's container, which the helper can't read.
    var keyFile: URL { dataDirectory.appendingPathComponent("telegram-key.sealed") }

    /// The key, made the first time and sealed with the device key. One that won't open, as after
    /// the device key changed, means the database can't be read either: an error, and the caller starts over.
    func databaseKey() throws -> Data {
        let sealing = try hkdfSha256(ikm: deviceKey, salt: Data(), info: Self.keyInfo, len: 32)
        if let sealed = try? Data(contentsOf: keyFile) {
            do {
                return try aeadOpen(key: sealing, data: sealed, aad: Self.keyInfo)
            } catch {
                throw CoreError(description: "The key to Telegram's database couldn't be opened.")
            }
        }
        let key = try randomBytes(len: 32)
        let sealed = try aeadSeal(key: sealing, plaintext: key, aad: Self.keyInfo)
        try sealed.write(to: keyFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return key
    }

    // MARK: What the core asks

    /// Starts the helper, if it isn't running. Requests made while it starts wait for it.
    public func start() -> String? {
        queue.sync {
            wanted = true
            failures = 0
            if run != nil { return nil }
            return launch()
        }
    }

    /// Hands the engine one of the core's requests, if it's on the list and within the limit,
    /// and otherwise answers it with an error, as TDLib answers what it won't do.
    public func send(_ json: String) {
        guard let data = json.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        // The core's own labels, which are text (`Engine` in packages/core/src/telegram/engine.ts).
        let extra = request["@extra"] as? String
        let refuse: @Sendable (Int, String) -> Void = { code, message in
            var answer: [String: Any] = ["@type": "error", "code": code, "message": message]
            answer["@extra"] = extra
            self.deliver(Self.encode(answer))
        }
        if let why = TelegramFunctions.refusal(request) {
            logger.warning("refused: \(why, privacy: .public)")
            return refuse(403, why)
        }
        // What the core asks for carries its own `@extra`, never the broker's.
        if let label = extra, label.hasPrefix("zuna:") {
            return refuse(400, "That request's label is the app's own.")
        }
        queue.async { [self] in
            let now = Date()
            tokens = min(tokens + now.timeIntervalSince(filled) * Self.rate, Self.burst)
            filled = now
            guard tokens >= 1 else {
                logger.warning("too many requests, one refused")
                return refuse(429, "Too many requests at once.")
            }
            tokens -= 1
            guard let run else { return refuse(503, "Telegram isn't running.") }
            if let link = run.link {
                link.send(json: json)
            } else {
                run.pending.append(json)
            }
        }
    }

    /// Stops the helper. With `signOut`, the session is ended at Telegram first, if it can be in a
    /// few seconds, and then everything of the account's on this device is erased all the same.
    /// The core is told how it went (`zunaStopped`).
    public func stop(signOut: Bool) {
        queue.async { [self] in
            wanted = false
            generation += 1
            let stopping = run
            run = nil
            copies.removeAll()
            Thread.detachNewThread { [self] in
                var signedOut = false
                if let stopping {
                    if signOut, let link = stopping.link {
                        // The engine's answers go to nobody now, so its end of signing out is seen
                        // as the helper going: TDLib closes once it's done.
                        link.send(json: Self.encode(["@type": "logOut", "@extra": "zuna:logout"]))
                        signedOut = stopping.closed.wait(timeout: .now() + 15) == .success
                    }
                    stopping.door?.closeAll(tell: false)
                    stopping.link?.close()
                    _ = stopping.ended.wait(timeout: .now() + 10)
                }
                if signOut { eraseAll() }
                deliver(Self.encode(["@type": "zunaStopped", "erased": signOut, "signedOut": signedOut]))
            }
        }
    }

    /// The proxy changed: every connection through the door ends, and TDLib makes them again,
    /// through the new one or none.
    public func networkChanged() {
        queue.async { [self] in run?.door?.closeAll(tell: true) }
    }

    /// A file TDLib downloaded, copied out of the helper's folder into the app's cache, where the
    /// interface reads it, and its path there.
    public func file(path: String, done: @escaping @Sendable (Result<String, Error>) -> Void) {
        queue.async { [self] in
            if let copied = copies[path], FileManager.default.fileExists(atPath: copied.path) {
                return done(.success(copied.path))
            }
            guard let link = run?.link else { return done(.failure(CoreError(description: "Telegram isn't running."))) }
            let generation = self.generation
            let destination = filesDirectory.appendingPathComponent(UUID().uuidString + Self.fileExtension(of: path))
            link.open(path: path) { [self] opened in
                switch opened {
                case .failure(let error):
                    done(.failure(error))
                case .success(let handle):
                    do {
                        try Self.copy(handle, to: destination)
                        queue.async { [self] in
                            if self.generation == generation { copies[path] = destination }
                            done(.success(destination.path))
                        }
                    } catch {
                        done(.failure(error))
                    }
                }
            }
        }
    }

    /// The app's push token from Apple, given to Telegram once the account is signed in and again
    /// each time the helper starts, as Telegram asks, so that its messages are pushed to this phone
    /// while the app is closed (docs/TELEGRAM_PLAN.md, Notifications). Signing out takes it back.
    public func setPushToken(_ token: String?) {
        queue.async { [self] in
            guard token != pushToken else { return }
            pushToken = token
            if let run, run.ready { register(run) }
        }
    }

    private func register(_ run: Run) {
        guard let token = pushToken, !token.isEmpty, let link = run.link else { return }
        link.send(json: Self.encode([
            "@type": "registerDevice",
            "device_token": ["@type": "deviceTokenApplePush", "device_token": token, "is_app_sandbox": configuration.pushSandbox],
            "other_user_ids": [Int](),
            "@extra": "zuna:push",
        ]))
    }

    #if DEBUG
    /// Asks the helper what its box lets it do (`Probe.swift`), for the checks.
    public func probe(appDirectory: String, done: @escaping @Sendable ([String: String]) -> Void) {
        queue.async { [self] in
            probed = done
            let ask = Self.encode(["zuna": "probe", "app": appDirectory])
            if let link = run?.link { link.send(json: ask) } else { done(["error": "Telegram isn't running."]) }
        }
    }
    #endif

    // MARK: Runs

    /// Launches the helper. Its start goes first once it's there, then whatever waited.
    private func launch() -> String? {
        let key: Data
        do {
            key = try databaseKey()
        } catch {
            // A database nobody can open is no account: it's erased, and Telegram's own apps still
            // list the session until it's ended there.
            logger.warning("\(error.localizedDescription, privacy: .public), so what was linked is erased")
            eraseAll()
            do { key = try databaseKey() } catch { return error.localizedDescription }
        }
        generation += 1
        let run = Run(generation: generation)
        self.run = run
        asked = nil
        let handlers = TelegramHelperHandlers(
            json: { [weak self, run] json in
                guard let self else { return }
                queue.async { self.heard(run, json) }
            },
            data: { [run] stream, bytes, taken in
                guard let door = run.door else { return taken() }
                door.data(stream: stream, bytes: bytes, taken: taken)
            },
            ended: { [weak self, run] why in
                run.ended.signal()
                guard let self else { return }
                queue.async { self.ended(run, why) }
            }
        )
        let start = Self.encode([
            "zuna": "start",
            "key": key.base64EncodedString(),
            "apiId": configuration.credentials.apiId,
            "apiHash": configuration.credentials.apiHash,
            "testDc": configuration.credentials.testDc,
            "version": configuration.version,
            "system": configuration.system,
            "device": configuration.device,
            "verbosity": configuration.verbosity,
        ])
        let launcher = configuration.launcher
        Task { [weak self] in
            do {
                let link = try await launcher.launch(handlers)
                guard let self else { return link.close() }
                queue.async {
                    guard self.run === run else { return link.close() }
                    run.door = TelegramDoor(link: link)
                    link.send(json: start)
                    for request in run.pending { link.send(json: request) }
                    run.pending.removeAll()
                    run.link = link
                    self.watch(run)
                }
            } catch {
                run.ended.signal()
                guard let self else { return }
                queue.async { self.ended(run, "Telegram's engine couldn't start: \(error.localizedDescription)") }
            }
        }
        return nil
    }

    private func heard(_ run: Run, _ json: String) {
        guard let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        // The door's and the helper's own messages, whatever run they're of: a run being stopped
        // still opens connections, so it can sign out.
        if let kind = value["zuna"] as? String {
            let id = (value["id"] as? NSNumber).map(\.uint32Value)
            switch (kind, id) {
            case ("open", let id?):
                run.door?.open(stream: id, host: value["host"] as? String ?? "", port: (value["port"] as? NSNumber)?.intValue ?? 0)
            case ("closed", let id?):
                run.door?.closed(stream: id)
            case ("failed", _):
                if self.run === run { deliver(Self.encode(["@type": "zunaFailed", "reason": value["reason"] as? String ?? "Telegram's engine failed."])) }
            #if DEBUG
            case ("probed", _):
                let results = (value["results"] as? [String: String]) ?? [:]
                probed?(results)
                probed = nil
            #endif
            default:
                break
            }
            return
        }
        let state = value["@type"] as? String == "updateAuthorizationState" ? (value["authorization_state"] as? [String: Any])?["@type"] as? String : nil
        let closing = state == "authorizationStateClosed"
        if closing { run.closed.signal() }
        guard self.run === run else { return }
        if state == "authorizationStateReady", !run.ready {
            run.ready = true
            register(run)
        }
        switch value["@extra"] as? String {
        case "zuna:watchdog":
            asked = nil
            return
        case "zuna:push":
            if value["@type"] as? String == "error" {
                logger.warning("Telegram didn't take the push token: \(value["message"] as? String ?? "", privacy: .public)")
            } else {
                logger.info("Telegram took the push token")
            }
            return
        // The broker's own requests, whose answers are nobody else's.
        case let extra? where extra.hasPrefix("zuna:"):
            if value["@type"] as? String == "error" {
                logger.warning("the engine refused \(extra, privacy: .public): \(value["message"] as? String ?? "", privacy: .public)")
            }
            return
        default:
            break
        }
        // TDLib closed, as when its session was ended from another device: it isn't started
        // again, and the core decides what happens to what it held.
        if closing { wanted = false }
        deliver(json)
    }

    /// The helper went. If nobody stopped it, it's started again, up to a few times in a row.
    private func ended(_ run: Run, _ why: String) {
        run.door?.closeAll(tell: false)
        guard self.run === run else { return }
        self.run = nil
        copies.removeAll()
        guard wanted else { return }
        if Date().timeIntervalSince(run.started) > Self.ranWell { failures = 0 }
        failures += 1
        logger.warning("the engine stopped (\(why, privacy: .public)), failure \(self.failures) in a row")
        if failures > Self.mostRestarts {
            wanted = false
            deliver(Self.encode(["@type": "zunaFailed", "reason": why]))
            return
        }
        if let why = launch() {
            deliver(Self.encode(["@type": "zunaFailed", "reason": why]))
        } else {
            deliver(Self.encode(["@type": "zunaRestarted"]))
        }
    }

    /// Asks the helper now and then whether it's still there, and ends one that doesn't answer.
    /// A wait that spans the app's being suspended, when nothing runs, counts for nothing.
    private func watch(_ run: Run) {
        looked = Date()
        queue.asyncAfter(deadline: .now() + Self.watchdogEvery) { [weak self] in
            guard let self, self.run === run, let link = run.link else { return }
            let now = Date()
            let slept = now.timeIntervalSince(looked) > Self.watchdogEvery * 2
            looked = now
            if slept { asked = nil }
            if let asked, now.timeIntervalSince(asked) > Self.watchdogWait {
                logger.warning("the engine stopped answering, so it's ended")
                // Its session ends as it goes, and `ended` starts it again.
                link.close()
                return
            }
            if asked == nil {
                asked = now
                link.send(json: Self.encode(["@type": "getOption", "name": "version", "@extra": "zuna:watchdog"]))
            }
            watch(run)
        }
    }

    /// Erases everything of the account's on this device: the key, the files copied out, and the
    /// helper's folder, which only a helper of its own can reach.
    private func eraseAll() {
        try? FileManager.default.removeItem(at: keyFile)
        try? FileManager.default.removeItem(at: filesDirectory)
        let erased = DispatchSemaphore(value: 0)
        let handlers = TelegramHelperHandlers(
            json: { json in if json.contains("\"erased\"") { erased.signal() } },
            data: { _, _, taken in taken() },
            ended: { _ in erased.signal() }
        )
        let launcher = configuration.launcher
        let helper = LinkBox()
        Task {
            do {
                let link = try await launcher.launch(handlers)
                helper.link = link
                link.send(json: Self.encode(["zuna": "erase"]))
            } catch {
                erased.signal()
            }
        }
        if erased.wait(timeout: .now() + 10) == .timedOut {
            logger.warning("the engine's folder couldn't be erased in time")
        }
        helper.link?.close()
    }

    private final class LinkBox: @unchecked Sendable {
        var link: (any TelegramHelperLink)?
    }

    // MARK: Helpers

    static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }

    /// A file's extension as TDLib named it, if it's a plain one, so that what reads the copy knows its kind.
    static func fileExtension(of path: String) -> String {
        let found = (path as NSString).pathExtension.lowercased()
        guard (1...8).contains(found.count), found.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return "" }
        return "." + found
    }

    static func copy(_ handle: FileHandle, to destination: URL) throws {
        defer { try? handle.close() }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]),
              let out = FileHandle(forWritingAtPath: destination.path) else {
            throw CoreError(description: "Telegram's file couldn't be saved.")
        }
        defer { try? out.close() }
        while let part = try handle.read(upToCount: 1 << 20), !part.isEmpty {
            try out.write(contentsOf: part)
        }
    }
}

// MARK: The list

/// What the core may ask of the engine: `packages/core/src/telegram/functions.json`, which the core
/// bundle's build copies beside it and nothing changes while the app runs, as the desktop's
/// broker has it.
enum TelegramFunctions {
    enum Rule: Sendable {
        case any
        /// The values each named field may have.
        case only([String: [JSON]])
    }

    static let rules: [String: Rule] = {
        guard let url = Bundle.module.url(forResource: "telegram-functions", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let list = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let functions = list["functions"] as? [String: Any] else { return [:] }
        var rules: [String: Rule] = [:]
        for (name, rule) in functions {
            if let fields = rule as? [String: [Any]] {
                rules[name] = .only(fields.mapValues { $0.map(JSON.init) })
            } else if JSON(rule) == .bool(true) {
                rules[name] = .any
            }
        }
        return rules
    }()

    /// Why a request may not go to the engine, or nil if it may.
    static func refusal(_ request: [String: Any]) -> String? {
        guard let kind = request["@type"] as? String else { return "a request with no type" }
        switch rules[kind] {
        case nil:
            return "\(kind) isn't something Zuna does on Telegram"
        case .any:
            return nil
        case .only(let fields):
            for (field, values) in fields.sorted(by: { $0.key < $1.key }) {
                guard let given = request[field], values.contains(JSON(given)) else {
                    return "\(kind) with that \(field) isn't something Zuna does on Telegram"
                }
            }
            return nil
        }
    }

    /// A JSON value, compared as JSON is: `true` isn't 1.
    enum JSON: Equatable, Sendable {
        case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

        init(_ value: Any) {
            switch value {
            case let number as NSNumber where CFGetTypeID(number) == CFBooleanGetTypeID():
                self = .bool(number.boolValue)
            case let number as NSNumber:
                self = .number(number.doubleValue)
            case let text as String:
                self = .string(text)
            case let items as [Any]:
                self = .array(items.map(JSON.init))
            case let fields as [String: Any]:
                self = .object(fields.mapValues(JSON.init))
            default:
                self = .null
            }
        }
    }
}

// MARK: The door

/// The app's end of the door (the helper's `Door.swift` is the other): each connection TDLib asks
/// for is opened here, if it's to one of Telegram's own addresses on a port Telegram uses, and
/// refused otherwise. A name is always refused: Telegram's servers are reached by address, and
/// what TDLib does when it can't reach them, asking other companies' servers where they went,
/// isn't Telegram's and doesn't go. Through the proxy set in Privacy where there is one, as
/// everything else goes, and nowhere while it can't be reached.
final class TelegramDoor: @unchecked Sendable {
    /// The ranges Telegram publishes (https://core.telegram.org/resources/cidr.txt, read on
    /// 2026-11-13), as the desktop's door has them: nine for IPv4, five for IPv6.
    static let rangesV4: [(String, Int)] = [
        ("91.108.56.0", 22), ("91.108.4.0", 22), ("91.108.8.0", 22), ("91.108.16.0", 22), ("91.108.12.0", 22),
        ("149.154.160.0", 20), ("91.105.192.0", 23), ("91.108.20.0", 22), ("185.76.151.0", 24),
    ]
    static let rangesV6: [(String, Int)] = [
        ("2001:b28:f23d::", 48), ("2001:b28:f23f::", 48), ("2001:67c:4e8::", 48), ("2001:b28:f23c::", 48), ("2a0a:f280::", 32),
    ]
    /// The ports Telegram's data centers answer on: 443 first, and 80 and 5222 where it's blocked.
    static let ports: Set<Int> = [443, 80, 5222]
    static let connectTimeout: TimeInterval = 15

    /// Whether the door lets a connection to this address and port through.
    static func allowed(host: String, port: Int) -> Bool {
        guard ports.contains(port) else { return false }
        if let address = IPv4Address(host) { return inRanges(address.rawValue, rangesV4.map { (IPv4Address($0.0)!.rawValue, $0.1) }) }
        if let address = IPv6Address(host) {
            // An IPv4 address written as IPv6 is judged as itself.
            if let mapped = address.asIPv4 { return allowed(host: "\(mapped)", port: port) }
            return inRanges(address.rawValue, rangesV6.map { (IPv6Address($0.0)!.rawValue, $0.1) })
        }
        return false
    }

    private static func inRanges(_ address: Data, _ ranges: [(Data, Int)]) -> Bool {
        ranges.contains { network, bits in
            guard network.count == address.count else { return false }
            var left = bits
            for (a, b) in zip(address, network) {
                if left <= 0 { break }
                let mask: UInt8 = left >= 8 ? 0xff : ~(0xff >> UInt8(left))
                if a & mask != b & mask { return false }
                left -= 8
            }
            return true
        }
    }

    private weak var link: (any TelegramHelperLink)?
    private let queue = DispatchQueue(label: "chat.zuna.telegram.door")
    private var connections: [UInt32: NWConnection] = [:]
    private let logger = Logger(subsystem: "chat.zuna", category: "telegram")

    init(link: any TelegramHelperLink) {
        self.link = link
    }

    /// Whether a connection asked for has been answered, opened or refused: only once.
    private final class Asked: @unchecked Sendable {
        var answered = false
    }

    private func refuse(_ id: UInt32, _ host: String, _ port: Int, _ why: String) {
        logger.info("the door refused \(host, privacy: .public):\(port): \(why, privacy: .public)")
        link?.send(json: TelegramBridge.encode(["zuna": "refused", "id": Int(id)]))
    }

    /// The helper asks for a connection.
    func open(stream id: UInt32, host: String, port: Int) {
        guard IPv4Address(host) != nil || IPv6Address(host) != nil else { return refuse(id, host, port, "not an address") }
        guard Self.allowed(host: host, port: port), let endpointPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return refuse(id, host, port, "not one of Telegram's") }
        let options = NWProtocolTCP.Options()
        options.noDelay = true
        options.connectionTimeout = Int(Self.connectTimeout)
        let parameters = NWParameters(tls: nil, tcp: options)
        NetworkProxy.apply(NetworkProxy.current, to: parameters)
        let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: parameters)
        let asked = Asked()
        // Every handler runs on the door's queue, which is what keeps `asked` and `connections` safe.
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready where !asked.answered:
                asked.answered = true
                connections[id] = connection
                link?.send(json: TelegramBridge.encode(["zuna": "opened", "id": Int(id)]))
                receive(id, connection)
            case .failed(let error) where !asked.answered, .waiting(let error) where !asked.answered:
                asked.answered = true
                connection.cancel()
                refuse(id, host, port, error.localizedDescription)
            case .failed, .cancelled:
                if connections.removeValue(forKey: id) != nil {
                    link?.send(json: TelegramBridge.encode(["zuna": "closed", "id": Int(id)]))
                }
            default:
                break
            }
        }
        queue.asyncAfter(deadline: .now() + Self.connectTimeout) { [weak self] in
            guard let self, !asked.answered else { return }
            asked.answered = true
            connection.cancel()
            refuse(id, host, port, "it took too long")
        }
        connection.start(queue: queue)
    }

    /// What Telegram sends, a part at a time, each waiting until the helper has written the one before.
    private func receive(_ id: UInt32, _ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 << 10) { [weak self] content, _, complete, error in
            guard let self else { return }
            if let content, !content.isEmpty, let link {
                link.send(stream: id, bytes: content) { [weak self] taken in
                    guard let self else { return }
                    queue.async {
                        if taken && !complete && error == nil { self.receive(id, connection) } else { self.finish(id) }
                    }
                }
            } else if complete || error != nil {
                finish(id)
            } else {
                receive(id, connection)
            }
        }
    }

    /// What TDLib sent on a connection, and `taken` once it's gone to Telegram's.
    func data(stream id: UInt32, bytes: Data, taken: @escaping @Sendable () -> Void) {
        queue.async { [self] in
            guard let connection = connections[id] else { return taken() }
            connection.send(content: bytes, completion: .contentProcessed { _ in taken() })
        }
    }

    /// The helper's end closed.
    func closed(stream id: UInt32) {
        queue.async { [self] in connections.removeValue(forKey: id)?.cancel() }
    }

    /// Telegram's end closed, or failed: the helper's end is told.
    private func finish(_ id: UInt32) {
        guard let connection = connections.removeValue(forKey: id) else { return }
        connection.cancel()
        link?.send(json: TelegramBridge.encode(["zuna": "closed", "id": Int(id)]))
    }

    /// Every connection ends, and the helper is told of each when `tell`, as when the proxy changed.
    func closeAll(tell: Bool) {
        queue.async { [self] in
            let all = connections
            connections.removeAll()
            for (id, connection) in all {
                connection.cancel()
                if tell { link?.send(json: TelegramBridge.encode(["zuna": "closed", "id": Int(id)])) }
            }
        }
    }
}
