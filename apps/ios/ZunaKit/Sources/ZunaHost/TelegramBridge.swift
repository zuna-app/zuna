import Darwin
import Foundation
import os
import ZunaCrypto

// The broker for a Telegram account linked on this iPhone or iPad (docs/TELEGRAM_PLAN.md, "On the
// iPhone and iPad"), as `apps/desktop/src/telegram` is the desktop's. TDLib runs in the app's own
// process here, through an engine the app gives (`TelegramEngine`), and the broker stands between
// it and the core: it starts and stops it, keeps the door (`TelegramDoor`), holds the key to its
// database, and passes on only the functions on the list (`functions.json`), no faster than a
// limit. What comes back is handed to the core as it came, for the adapter there to check.
//
// Nothing here reaches a Zuna server, and nothing of Telegram's goes anywhere but the core's
// adapter, which keeps none of it, and the interface, which reads the files TDLib downloaded where
// TDLib keeps them.

/// TDLib, as the broker needs it: the app gives the one over TDLib's JSON client
/// (`Zuna/Telegram/TDLibEngine.swift`), and the tests a fake, so that this builds and is tested
/// without TDLib.
public protocol TelegramEngine: Sendable {
    /// A new client. Its answers and updates come to `heard` as JSON, from a thread of the
    /// engine's, until it says it closed (`authorizationStateClosed`), after which `closed` is
    /// called once and nothing more comes.
    func makeClient(heard: @escaping @Sendable (String) -> Void, closed: @escaping @Sendable () -> Void) -> any TelegramClient
    /// One of TDLib's synchronous requests, such as its log's settings.
    @discardableResult func execute(_ json: String) -> String?
    /// What TDLib says as it ends the process on purpose, its own checks having failed, handed to
    /// `said` on TDLib's thread just before it does, so what's kept of it is kept before `said` returns.
    func onLastWords(_ said: @escaping @Sendable (String) -> Void)
}

/// One of TDLib's clients.
public protocol TelegramClient: AnyObject, Sendable {
    /// A request, whose answer comes back with the same `@extra`.
    func send(_ json: String)
}

/// A key the app words, named here so that `npm run i18n` finds it.
private func mark(_ key: String) -> String { key }

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
        public var engine: any TelegramEngine
        /// TDLib's folder, its database in `db` and its files in `files`, which the broker makes:
        /// in the app's own container, where a lock may be held while the app is suspended, never
        /// in the app group, which the extensions read and where it may not.
        public var folder: URL
        /// What Telegram is told this is: the app's version, the system's name, and an iPhone or an iPad.
        public var version: String
        public var system: String
        public var device: String
        /// How much TDLib logs, from 0 to 5.
        public var verbosity = 1
        /// Whether the app's push token is for Apple's sandbox, as a development build's is, which
        /// Telegram has to know to push to it.
        public var pushSandbox = false
        /// What the person is told, in the app's language: a key of `packages/i18n/locales` and
        /// what fills it in, as the app's `t` words it.
        public var words: @Sendable (_ key: String, _ values: [String: String]) -> String = { key, _ in key }

        public init(credentials: Credentials, engine: any TelegramEngine, folder: URL, version: String, system: String, device: String) {
            self.credentials = credentials
            self.engine = engine
            self.folder = folder
            self.version = version
            self.system = system
            self.device = device
        }
    }

    /// How many requests the core may make, as a bucket that fills at `rate` a second up to
    /// `burst`: a fault in the adapter can't become a flood, which is what Telegram bans for.
    static let rate = 100.0
    static let burst = 500.0
    /// How many starts in a row may leave their mark, ending the app before TDLib opened its
    /// database or ending it on purpose later, before the next isn't made (`StartMarks`).
    static let mostMarks = 2
    /// How long signing out may take at Telegram, and closing TDLib after it.
    static let signOutWait: TimeInterval = 15
    static let closeWait: TimeInterval = 10

    static let keyInfo = Data("zuna/telegram/key/v1".utf8)

    private let configuration: Configuration
    private let dataDirectory: URL
    /// TDLib's folder.
    let folder: URL
    private let deviceKey: Data
    private let deliver: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "chat.zuna.telegram.broker")
    private let logger = Logger(subsystem: "chat.zuna", category: "telegram")
    let marks: StartMarks

    /// One of TDLib's clients, from its start to its close, with the door it was given.
    private final class Run: @unchecked Sendable {
        var client: (any TelegramClient)?
        let door: TelegramDoor
        /// Its start came after erasing a database no key here opened, and isn't followed by another.
        let afterWipe: Bool
        /// TDLib said it closed.
        let closed = DispatchSemaphore(value: 0)
        var hasClosed = false
        /// TDLib opened its database and said where the account stands: the start's mark is taken back.
        var opened = false
        /// The account is signed in, so its push token can be given and signing out means something.
        var ready = false
        /// Why TDLib didn't take its parameters, which is why the run ends.
        var failure: String?
        /// Its database is one no key here opens, with no account linked: it's erased as the run ends.
        var wipe = false
        /// It was stopped, and it closed after its stop stopped waiting: the stop finishes as it does.
        var lateStop = false
        init(door: TelegramDoor, afterWipe: Bool) {
            self.door = door
            self.afterWipe = afterWipe
        }
    }

    private var run: Run?
    /// Stops whose client hasn't closed yet: no client is made until there are none, as two on one
    /// folder fight over its database's lock.
    private var stopping = 0
    /// Unlinking asked for TDLib's folder to go, which it does once no client holds it.
    private var eraseOwed = false
    /// The core asked for it to run, and hasn't asked for it to stop, nor been told it can't.
    private var wanted = false
    /// An account is signed in here, as the core said when it asked, or TDLib since: its database
    /// has to be in the folder, and nothing of it is erased for not being found or opened.
    private var linked = false
    /// The app is out of sight: iOS has suspended it, or is about to, and TDLib with it (`sleep`).
    private var asleep = false
    private var tokens = TelegramBridge.burst
    private var filled = Date()
    /// The app's push token from Apple, as hex, which Telegram pushes the account's messages to.
    private var pushToken: String?
    /// The app's VoIP token from PushKit, as hex, which Telegram pushes the account's calls to while
    /// this device takes them (docs/TELEGRAM_CALLS_PLAN.md, An iPhone ringing with Zuna closed).
    private var voipToken: String?
    /// A call's push woke the app: TDLib starts out of sight for it, as the call the system holds
    /// keeps the app running.
    private var forCall = false
    /// Pushes for calls waiting for TDLib to be signed in, each with who's told whether it was a call.
    private var callPushes: [(payload: String, done: @Sendable (Bool) -> Void)] = []
    private var nextCallPush = 0
    private var callPushesAsked: [Int: @Sendable (Bool) -> Void] = [:]

    public init(configuration: Configuration, dataDirectory: URL, deviceKey: Data, deliver: @escaping @Sendable (String) -> Void) {
        self.configuration = configuration
        self.dataDirectory = dataDirectory
        folder = configuration.folder.standardizedFileURL
        self.deviceKey = deviceKey
        self.deliver = deliver
        let marks = StartMarks(file: folder.appendingPathComponent("start-marks.json"))
        self.marks = marks
        configuration.engine.onLastWords { said in marks.lastWords(said) }
    }

    private func say(_ key: String, _ values: [String: String] = [:]) -> String {
        configuration.words(key, values)
    }

    // MARK: The key to the engine's database

    /// Where the key is kept, sealed with the device key: beside the app's other secrets.
    var keyFile: URL { dataDirectory.appendingPathComponent("telegram-key.sealed") }

    /// Why the key can't be had.
    enum KeyProblem: Error, LocalizedError, Equatable {
        /// Sealed with another device key, or damaged: nothing opens it, nor the database it was for.
        case unopenable
        /// There, and not to be read now: it may be later, so nothing is made in its place.
        case unreadable(String)

        var errorDescription: String? {
            switch self {
            case .unopenable: "The key to Telegram's database couldn't be opened."
            case .unreadable(let why): "The key to Telegram's database couldn't be read: \(why)"
            }
        }
    }

    /// The key, made the first time and sealed with the device key. One that won't open, as after
    /// the device key changed, means the database can't be read either: an error, and the caller
    /// starts over. One that's there and can't be read is another error, which nothing is erased
    /// for, and no new key takes its place, which would leave the account's database with none.
    func databaseKey() throws -> Data {
        let sealing = try hkdfSha256(ikm: deviceKey, salt: Data(), info: Self.keyInfo, len: 32)
        if FileManager.default.fileExists(atPath: keyFile.path) {
            let sealed: Data
            do {
                sealed = try Data(contentsOf: keyFile)
            } catch {
                throw KeyProblem.unreadable(error.localizedDescription)
            }
            do {
                return try aeadOpen(key: sealing, data: sealed, aad: Self.keyInfo)
            } catch {
                throw KeyProblem.unopenable
            }
        }
        let key = try randomBytes(len: 32)
        let sealed = try aeadSeal(key: sealing, plaintext: key, aad: Self.keyInfo)
        try sealed.write(to: keyFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return key
    }

    // MARK: What the core asks

    /// Starts TDLib, if it isn't running, and says why it can't, if it can't say so later. With the
    /// app out of sight, as when iOS started it for a push, it starts once the app is on screen
    /// (`wake`), and after a stop, once that stop's client has closed. `linked` says an account is
    /// signed in here, as the core knows: TDLib is then started only on that account's database,
    /// and none of it is erased because it wasn't found or opened.
    public func start(linked: Bool = false) -> String? {
        queue.sync {
            wanted = true
            self.linked = linked
            if run != nil || (asleep && !forCall) || stopping > 0 { return nil }
            return begin(afterWipe: false)
        }
    }

    /// The app left the screen, where iOS soon suspends it, and TDLib with it. Nothing is told to
    /// TDLib, and nothing is started until the app is back: a start iOS suspends halfway is one
    /// that's taken longer for no reason.
    public func sleep() {
        queue.async { [self] in asleep = true }
    }

    /// The app is back on screen, from a suspension that every connection TDLib had may not have
    /// lived through. The door looks at its listener at once, which iOS may have taken back, and
    /// then TDLib is told the network changed, which has it open every connection again at once
    /// rather than when it next notices: what makes the account online a second after the app is
    /// back. Or TDLib is started now, if a start waited for the app.
    public func wake() {
        queue.async { [self] in
            guard asleep else { return }
            asleep = false
            forCall = false
            if let run {
                run.door.look { [weak self, run] in
                    guard let self else { return }
                    queue.async {
                        guard self.run === run else { return }
                        run.client?.send(Self.setNetworkType)
                    }
                }
            } else {
                resume()
            }
        }
    }

    /// Hands TDLib one of the core's requests, if it's on the list and within the limit, and
    /// otherwise answers it with an error, as TDLib answers what it won't do.
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
                return refuse(429, say(mark("telegram.engine.tooMany")))
            }
            tokens -= 1
            guard let client = run?.client else { return refuse(503, say(mark("telegram.engine.notRunning"))) }
            client.send(json)
        }
    }

    /// Stops TDLib. With `signOut`, the session is ended at Telegram first, if it can be in a few
    /// seconds, and then everything of the account's on this device is erased all the same: the
    /// key at once, and TDLib's folder once its client has closed. The core is told how it went
    /// (`zunaStopped`).
    public func stop(signOut: Bool) {
        queue.async { [self] in
            wanted = false
            if signOut {
                linked = false
                eraseKey()
                eraseOwed = true
            }
            guard let stopping = run else {
                if self.stopping == 0 { stopsDone() }
                deliver(Self.encode(["@type": "zunaStopped", "erased": signOut, "signedOut": false]))
                return
            }
            run = nil
            self.stopping += 1
            let signedIn = stopping.ready
            Thread.detachNewThread { [self] in
                var signedOut = false
                if signOut, signedIn, let client = stopping.client {
                    // TDLib closes once it has signed out, and its answers go to nobody now.
                    client.send(Self.encode(["@type": "logOut", "@extra": "zuna:logout"]))
                    signedOut = stopping.closed.wait(timeout: .now() + Self.signOutWait) == .success
                }
                if !signedOut {
                    stopping.client?.send(Self.encode(["@type": "close", "@extra": "zuna:close"]))
                    _ = stopping.closed.wait(timeout: .now() + Self.closeWait)
                }
                let said = signedOut
                queue.async { [self] in
                    if stopping.hasClosed {
                        stopDone()
                    } else {
                        // Its folder goes, and another client is made, only once it has.
                        logger.warning("TDLib didn't close in time, so nothing more is started until it does")
                        stopping.lateStop = true
                    }
                    deliver(Self.encode(["@type": "zunaStopped", "erased": signOut, "signedOut": said]))
                }
            }
        }
    }

    /// The proxy changed: every connection through the door ends, and TDLib makes them again,
    /// through the new one or none, at once as it's told the network changed.
    public func networkChanged() {
        queue.async { [self] in
            guard let run else { return }
            run.door.closeAll()
            run.client?.send(Self.setNetworkType)
        }
    }

    /// A file TDLib downloaded, by the path it gave, for the interface to read where it is: only a
    /// regular file inside TDLib's folder, once every link on the way is followed.
    public func file(path: String, done: @escaping @Sendable (Result<String, Error>) -> Void) {
        // Both by their real names, found now, when both are there to be found.
        let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        let root = folder.resolvingSymlinksInPath().path
        var status = stat()
        guard real.hasPrefix(root + "/"), lstat(real, &status) == 0, status.st_mode & S_IFMT == S_IFREG else {
            logger.warning("refused a file outside TDLib's folder, or not a file")
            return done(.failure(CoreError(description: say(mark("telegram.engine.fileUnreadable")))))
        }
        done(.success(real))
    }

    /// The app's push token from Apple, given to Telegram once the account is signed in and again
    /// each time TDLib starts, as Telegram asks, so that its messages are pushed to this phone
    /// while the app is closed (docs/TELEGRAM_PLAN.md, Notifications). Signing out takes it back.
    public func setPushToken(_ token: String?) {
        queue.async { [self] in
            guard token != pushToken else { return }
            pushToken = token
            if let run, run.ready { register(run) }
        }
    }

    /// The app's VoIP token, given to Telegram encrypted, so that Apple reads nothing of a call's
    /// push, each time TDLib starts, while this device takes calls; nil takes it back, as when the
    /// switch goes off. Telegram's pushes then carry the ID it answers with, which is kept beside
    /// TDLib's database for a push to be known by before TDLib runs (`isCallPush`).
    public func setVoipToken(_ token: String?) {
        queue.async { [self] in
            guard token != voipToken else { return }
            voipToken = token
            if let run, run.ready { registerVoip(run) }
        }
    }

    private func registerVoip(_ run: Run) {
        guard let client = run.client else { return }
        let token = voipToken ?? ""
        // Nothing to take back that was never given.
        if token.isEmpty, !FileManager.default.fileExists(atPath: callReceiverFile(folder).path) { return }
        client.send(Self.encode([
            "@type": "registerDevice",
            "device_token": ["@type": "deviceTokenApplePushVoIP", "device_token": token, "is_app_sandbox": configuration.pushSandbox, "encrypt": true],
            "other_user_ids": [Int](),
            "@extra": token.isEmpty ? "zuna:voip-gone" : "zuna:voip",
        ]))
    }

    /// Where the ID Telegram's calls' pushes carry is kept.
    private func callReceiverFile(_ folder: URL) -> URL { folder.appendingPathComponent("call-push-receiver") }

    /// Whether a VoIP push is Telegram's for the account linked here, as far as can be told before
    /// TDLib runs: its encrypted field, and the ID TDLib reads from it, which needs no client, against
    /// the one kept. Nil where nothing is kept to tell by, or it can't be read yet, as before the
    /// phone's first unlock: it may be.
    public static func isCallPush(_ payload: [AnyHashable: Any], engine: any TelegramEngine, folder: URL) -> Bool? {
        guard payload["p"] is String else { return false }
        guard let kept = try? String(contentsOf: folder.standardizedFileURL.appendingPathComponent("call-push-receiver"), encoding: .utf8) else { return nil }
        let fields = Dictionary(uniqueKeysWithValues: payload.compactMap { key, value in (key as? String).map { ($0, value) } })
        guard JSONSerialization.isValidJSONObject(fields), let data = try? JSONSerialization.data(withJSONObject: fields),
              let answer = engine.execute(encode(["@type": "getPushReceiverId", "payload": String(decoding: data, as: UTF8.self)])),
              let read = (try? JSONSerialization.jsonObject(with: Data(answer.utf8))) as? [String: Any], read["@type"] as? String == "pushReceiverId" else { return false }
        return "\(read["id"] ?? "")" == kept.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A call's push came: TDLib starts, out of sight if it must, and is asked what it was
    /// (`processPushNotification`). `done` is told whether it was a call: TDLib answers a call's
    /// with error 406, as it leaves calls to come as `updateCall`, and anything else means it wasn't.
    public func callPushed(_ payload: String, done: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            forCall = true
            callPushes.append((payload, done))
            if let run, run.ready { askAboutPushes(run) } else { resume() }
        }
    }

    private func askAboutPushes(_ run: Run) {
        guard let client = run.client else { return }
        for (payload, done) in callPushes {
            nextCallPush += 1
            callPushesAsked[nextCallPush] = done
            client.send(Self.encode(["@type": "processPushNotification", "payload": payload, "@extra": "zuna:call-push:\(nextCallPush)"]))
        }
        callPushes.removeAll()
    }

    private func register(_ run: Run) {
        registerVoip(run)
        askAboutPushes(run)
        guard let token = pushToken, !token.isEmpty, let client = run.client else { return }
        client.send(Self.encode([
            "@type": "registerDevice",
            "device_token": ["@type": "deviceTokenApplePush", "device_token": token, "is_app_sandbox": configuration.pushSandbox],
            "other_user_ids": [Int](),
            "@extra": "zuna:push",
        ]))
    }

    #if DEBUG
    /// Has the door lose its sockets as iOS takes back a suspended process's, which the simulator
    /// never does, for the checks. Says whether TDLib was running.
    public func reclaim() -> Bool {
        queue.sync {
            guard let run else { return false }
            run.door.reclaim()
            return true
        }
    }
    #endif

    // MARK: Runs

    /// Starts a client, with the door given to it first and then its parameters, and says why it
    /// can't when that's the core's to show at once. When nothing it could do by itself would
    /// change it, the core is told so instead (`refuse`).
    private func begin(afterWipe: Bool) -> String? {
        let key: Data
        do {
            key = try databaseKey()
        } catch KeyProblem.unopenable {
            // A database nobody can open is no account: it's erased, and Telegram's own apps still
            // list the session until it's ended there.
            logger.warning("\(KeyProblem.unopenable.localizedDescription, privacy: .public), so what was linked is erased")
            eraseAll()
            do { key = try databaseKey() } catch { return say(mark("telegram.engine.cantStart"), ["error": error.localizedDescription]) }
        } catch KeyProblem.unreadable(let why) {
            // Not to be had now, which may pass: nothing is erased, and the next start asks again.
            logger.warning("the key to TDLib's database couldn't be read: \(why, privacy: .public)")
            return say(mark("telegram.engine.keyNotReadable"), ["error": why])
        } catch {
            return say(mark("telegram.engine.cantStart"), ["error": error.localizedDescription])
        }
        // An account signed in here before has its database here, or it's gone: started without
        // it, TDLib would make a new one and ask to sign in, which the core takes for the account
        // let go. So nothing is started or erased, and the person is told what to do.
        if linked, !hasDatabase() {
            logger.warning("a linked account with no database here, so TDLib isn't started")
            return refuse(say(mark("telegram.engine.noDatabase")))
        }
        let left = marks.read()
        if left.starts >= Self.mostMarks {
            logger.error("TDLib's last \(left.starts) starts ended the app, so it isn't started again. It last said: \(left.said ?? "nothing", privacy: .public)")
            if let said = left.said {
                return refuse(say(mark("telegram.engine.endedTheAppSaying"), ["said": String(said.prefix(80))]))
            }
            return refuse(say(mark("telegram.engine.endedTheApp")))
        }
        if let said = left.said { logger.notice("TDLib last said, as it ended the app: \(said, privacy: .public)") }
        let door: TelegramDoor
        do {
            try makeFolder()
            door = try TelegramDoor(moved: { [weak self] door in
                guard let self else { return }
                queue.async { self.doorMoved(door) }
            })
        } catch {
            return refuse(say(mark("telegram.engine.cantStart"), ["error": error.localizedDescription]))
        }
        // Left before TDLib opens its database, and taken back once it has, so that a database it
        // ends the app over can't end it at every start.
        marks.leave(left.starts + 1, said: left.said)
        let run = Run(door: door, afterWipe: afterWipe)
        self.run = run
        configuration.engine.execute(Self.encode(["@type": "setLogVerbosityLevel", "new_verbosity_level": min(max(configuration.verbosity, 0), 5)]))
        let client = configuration.engine.makeClient(
            heard: { [weak self, run] json in
                guard let self else { return }
                queue.async { self.heard(run, json) }
            },
            closed: { [weak self, run] in
                guard let self else { return }
                queue.async { self.closed(run) }
            }
        )
        run.client = client
        // The way out first: a proxy added before the parameters takes effect as TDLib starts,
        // before it first connects, as on the desktop.
        client.send(Self.useDoor(door))
        client.send(Self.encode([
            "@type": "setTdlibParameters",
            "use_test_dc": configuration.credentials.testDc,
            "database_directory": folder.appendingPathComponent("db").path,
            "files_directory": folder.appendingPathComponent("files").path,
            "database_encryption_key": key.base64EncodedString(),
            "use_file_database": true,
            "use_chat_info_database": true,
            "use_message_database": true,
            "use_secret_chats": false,
            "api_id": configuration.credentials.apiId,
            "api_hash": configuration.credentials.apiHash,
            "system_language_code": "en",
            // Not the phone's model, nor the system's version, which TDLib would find out for
            // itself if these were empty.
            "device_model": configuration.device,
            "system_version": configuration.system,
            "application_version": configuration.version,
            "@extra": "zuna:parameters",
        ]))
        return nil
    }

    /// Tells the core TDLib wasn't started, and why, which nothing will change by itself: it's
    /// started again only when the core asks, as when the app comes back (`TelegramSession.nudge`).
    private func refuse(_ why: String) -> String? {
        wanted = false
        deliver(Self.encode(["@type": "zunaFailed", "reason": why]))
        return nil
    }

    /// Starts a client that's owed, once nothing stands in its way.
    private func resume() {
        guard wanted, run == nil, stopping == 0, !asleep || forCall else { return }
        if let why = begin(afterWipe: false) { _ = refuse(why) }
    }

    private func heard(_ run: Run, _ json: String) {
        // A run that's been stopped says nothing more to anyone, nor one being closed for why it
        // failed, whose closing the core would take for the account's session ended elsewhere.
        guard self.run === run, run.failure == nil, let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let state = value["@type"] as? String == "updateAuthorizationState" ? (value["authorization_state"] as? [String: Any])?["@type"] as? String : nil
        if let state, state != "authorizationStateWaitTdlibParameters", !run.opened {
            // TDLib opened its database and said where the account stands: this start got through.
            run.opened = true
            marks.takeBack()
        }
        if state == "authorizationStateReady" {
            // Signed in, as a start after this one has to find it.
            linked = true
            if !run.ready {
                run.ready = true
                register(run)
            }
        }
        switch value["@extra"] as? String {
        case "zuna:parameters":
            if value["@type"] as? String == "error" { refused(run, value["message"] as? String ?? "") }
            return
        case "zuna:push":
            if value["@type"] as? String == "error" {
                logger.warning("Telegram didn't take the push token: \(value["message"] as? String ?? "", privacy: .public)")
            } else {
                logger.info("Telegram took the push token")
            }
            return
        case "zuna:voip":
            if value["@type"] as? String == "pushReceiverId" {
                // What its calls' pushes will carry, for one to be known by before TDLib runs.
                try? "\(value["id"] ?? "")".write(to: callReceiverFile(folder), atomically: true, encoding: .utf8)
                logger.info("Telegram took the VoIP token")
            } else {
                logger.warning("Telegram didn't take the VoIP token: \(value["message"] as? String ?? "", privacy: .public)")
            }
            return
        case "zuna:voip-gone":
            try? FileManager.default.removeItem(at: callReceiverFile(folder))
            return
        case let extra? where extra.hasPrefix("zuna:call-push:"):
            guard let number = Int(extra.dropFirst("zuna:call-push:".count)), let done = callPushesAsked.removeValue(forKey: number) else { return }
            done(value["@type"] as? String == "error" && value["code"] as? Int == 406)
            return
        // The broker's own requests, whose answers are nobody else's.
        case let extra? where extra.hasPrefix("zuna:"):
            if value["@type"] as? String == "error" {
                logger.warning("TDLib refused \(extra, privacy: .public): \(value["message"] as? String ?? "", privacy: .public)")
            }
            return
        default:
            break
        }
        // TDLib closed, as when its session was ended from another device: it isn't started
        // again, and the core decides what happens to what it held.
        if state == "authorizationStateClosed" { wanted = false }
        deliver(json)
    }

    /// TDLib didn't take its parameters, which is where it opens its database. It does nothing
    /// until it has and says nothing more, so its client is closed, and the core told why as it is.
    ///
    /// A database that the key kept here doesn't open is nobody's while no account is linked: its
    /// key went with an account unlinked while its folder couldn't be erased. It's erased once the
    /// client has closed, and one more start makes another. For a linked account nothing is erased.
    private func refused(_ run: Run, _ message: String) {
        logger.warning("TDLib couldn't open its database: \(message, privacy: .public)")
        guard run.failure == nil else { return }
        let wrongKey = message.localizedCaseInsensitiveContains("encryption key")
        run.wipe = wrongKey && !linked && !run.afterWipe
        run.failure = wrongKey ? say(mark("telegram.engine.wrongKey")) : say(mark("telegram.engine.cantOpenData"), ["error": message])
        run.client?.send(Self.encode(["@type": "close", "@extra": "zuna:close"]))
    }

    /// TDLib said a client closed: the process lived through its start, so its mark is taken back.
    private func closed(_ run: Run) {
        run.hasClosed = true
        run.closed.signal()
        run.door.close()
        marks.takeBack()
        if run.lateStop {
            run.lateStop = false
            stopDone()
            return
        }
        // A run that's been stopped goes on in its stop.
        guard self.run === run else { return }
        self.run = nil
        guard let failure = run.failure else {
            // It closed by itself, as when its session was ended from another device, which the
            // core heard of with its last update and decides about.
            return
        }
        if run.wipe, wanted {
            logger.warning("a database no key here opens, with no account linked, is erased, to link from nothing")
            eraseAll()
            if let why = begin(afterWipe: true) { _ = refuse(why) }
            return
        }
        _ = refuse(failure)
    }

    /// One stop's client has closed.
    private func stopDone() {
        stopping -= 1
        if stopping == 0 { stopsDone() }
    }

    /// No client is left: TDLib's folder goes if unlinking asked for it, and a start that waited is made.
    private func stopsDone() {
        if eraseOwed {
            eraseOwed = false
            eraseFolder()
        }
        resume()
    }

    /// The door listens on another port, as when iOS took back its socket and the old port couldn't
    /// be had again: TDLib is told, or it would reach Telegram no more.
    private func doorMoved(_ door: TelegramDoor) {
        guard let run, run.door === door else { return }
        run.client?.send(Self.useDoor(door))
    }

    // MARK: TDLib's folder

    /// Whether TDLib has a database in its folder: its binlog, where the account's session is kept,
    /// or the copy TDLib was writing in its place when it last stopped.
    func hasDatabase() -> Bool {
        let binlog = folder.appendingPathComponent("db/td\(configuration.credentials.testDc ? "_test" : "").binlog").path
        return FileManager.default.fileExists(atPath: binlog) || FileManager.default.fileExists(atPath: binlog + ".new")
    }

    /// The folder, made as the app's own data is: protected until the phone is first unlocked,
    /// which is also what TDLib's files in it are, and left out of backups.
    private func makeFolder() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = folder
        try url.setResourceValues(values)
    }

    private func eraseKey() {
        try? FileManager.default.removeItem(at: keyFile)
    }

    /// TDLib's folder: its database, its files and the marks its starts left. Only with no client.
    private func eraseFolder() {
        try? FileManager.default.removeItem(at: folder)
        marks.forget()
    }

    /// Everything of the account's on this device: the key and TDLib's folder. Only with no client.
    private func eraseAll() {
        eraseKey()
        eraseFolder()
    }

    // MARK: Requests of the broker's own

    /// The door, as TDLib's proxy: the only way it's given to Telegram.
    private static func useDoor(_ door: TelegramDoor) -> String {
        encode([
            "@type": "addProxy",
            "proxy": ["@type": "proxy", "server": "127.0.0.1", "port": Int(door.port), "type": ["@type": "proxyTypeSocks5", "username": door.username, "password": door.password]],
            "enable": true,
            "comment": "Zuna",
            "@extra": "zuna:door",
        ])
    }

    /// Tells TDLib the network changed, which it has to be told "even if the network type remains
    /// the same", as that's what has it open every connection again at once.
    static let setNetworkType = encode(["@type": "setNetworkType", "type": ["@type": "networkTypeOther"], "@extra": "zuna:network"])

    static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }
}

// MARK: The marks starts leave

/// What keeps a TDLib that ends the app as it starts from taking the app away for good: the
/// database it ends it over would end it at every start, before the person could reach Settings
/// and unlink. Each start leaves a mark before TDLib opens its database, taken back once it has
/// and said where the account stands, or once it closed. One TDLib ended on purpose, its own checks
/// having failed, is left again with what it said last, whenever it came. After `mostMarks` starts
/// in a row left theirs, none is made until the person unlinks, which erases the folder with them.
/// They're kept in TDLib's folder, across launches: the app coming back isn't the person acting.
final class StartMarks: @unchecked Sendable {
    struct Mark: Codable, Equatable {
        /// How many starts in a row left their mark.
        var starts: Int
        /// What TDLib last said as it ended the app, if it said anything.
        var said: String?
    }

    let file: URL
    private let lock = NSLock()
    /// The mark this launch's start left, which TDLib's last words leave again.
    private var current: Mark?

    init(file: URL) {
        self.file = file
    }

    func read() -> Mark {
        guard let data = try? Data(contentsOf: file), let mark = try? JSONDecoder().decode(Mark.self, from: data) else { return Mark(starts: 0) }
        return mark
    }

    /// The mark a start leaves before TDLib opens its database.
    func leave(_ starts: Int, said: String?) {
        let mark = Mark(starts: starts, said: said)
        lock.withLock { current = mark }
        write(mark)
    }

    /// The start got through, or its client closed: its mark goes, though TDLib's last words would leave it again.
    func takeBack() {
        try? FileManager.default.removeItem(at: file)
    }

    /// Unlinking: nothing is left, nor left again by this launch.
    func forget() {
        lock.withLock { current = nil }
        try? FileManager.default.removeItem(at: file)
    }

    /// What TDLib said as it ends the app on purpose, on its thread, just before it does: the start
    /// counts as one that ended the app, wherever it had got to.
    func lastWords(_ said: String) {
        guard var mark = lock.withLock({ current }) else { return }
        mark.said = Self.plain(said)
        write(mark)
    }

    /// TDLib's log line without what it puts before it: its level, thread, time, file and tags.
    static func plain(_ line: String) -> String {
        var text = Substring(line)
        while text.first == "[", let end = text.firstIndex(of: "]") {
            text = text[text.index(after: end)...].drop { $0 == " " || $0 == "\t" }
        }
        return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
    }

    private func write(_ mark: Mark) {
        guard let data = try? JSONEncoder().encode(mark) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: [.atomic])
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
