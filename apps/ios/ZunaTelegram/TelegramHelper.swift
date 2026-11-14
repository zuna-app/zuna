import Darwin
import ExtensionFoundation
import Foundation
import os
@preconcurrency import XPC

// ZunaTelegram: TDLib in a process of its own, for a Telegram account linked to Zuna on this
// iPhone or iPad (docs/TELEGRAM_PLAN.md, "On the iPhone and iPad"). The app starts it, through the
// extension point it defines (`Zuna/Telegram/TelegramHelper.swift`), and is the only thing it talks
// to, over one XPC session (`TelegramWire`). iOS runs it as an enhanced security extension: a
// sandbox of its own that keeps it from most of the system's services, apart from the app's
// container, its app group and its keychain, and compiled with pointer authentication and typed
// allocation, against the faults a C++ parser of strangers' data has.
//
// It holds no key of Zuna's, and keeps nothing but TDLib's own folder, in its own container, whose
// database key the app sends each time it starts. The app's broker decides what may be asked of
// TDLib (`ZunaHost/TelegramBridge.swift`). This process only refuses what would let TDLib past the
// door (`Door.swift`), as the desktop's engine does.

/// The extension point the app defines, which this binds to.
protocol TelegramExtension: AppExtension {}

extension TelegramExtension {
    @MainActor var configuration: some AppExtensionConfiguration {
        ConnectionHandler(onSessionRequest: { request in Helper.shared.accept(request) })
    }
}

@main
struct ZunaTelegram: TelegramExtension {
    @AppExtensionPoint.Bind
    var boundExtensionPoint: AppExtensionPoint {
        AppExtensionPoint.Identifier(host: "chat.zuna.mobile", name: "telegram")
    }
}

let log = Logger(subsystem: "chat.zuna.telegram", category: "helper")

/// What the app sends first.
struct Start: Decodable {
    var key: String
    var apiId: Int64
    var apiHash: String
    /// Telegram's test servers, for development and the checks.
    var testDc: Bool?
    /// What Telegram is told this is: the app's version, the system's name and the kind of
    /// device, an iPhone or an iPad, and nothing more.
    var version: String
    var system: String
    var device: String
    /// How much TDLib logs, from 0 (nothing) to 5. 1 is its errors.
    var verbosity: Int?
}

/// Requests the app may never pass on, whatever its broker allows: those that would change the
/// way out TDLib was given, or its parameters. The desktop's engine has the same list.
let refused: Set<String> = ["addProxy", "editProxy", "enableProxy", "disableProxy", "removeProxy", "setTdlibParameters", "setLogStream", "testProxy", "testNetwork", "pingProxy"]

final class Helper: @unchecked Sendable {
    static let shared = Helper()

    private let lock = NSLock()
    private var session: XPCSession?
    private var engine: Engine?
    private var door: Door?
    private var closing = false
    private let writes = DispatchQueue(label: "chat.zuna.telegram.writes")

    /// TDLib's folder: its database in `db`, the files it downloads in `files`. In this extension's
    /// own container, which the app can't read: what it shows comes out through `file`.
    static let folder: URL = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("telegram", isDirectory: true).resolvingSymlinksInPath()
    }()

    /// The app's session, and only one at a time: the app that started this is the one it serves.
    func accept(_ request: XPCListener.IncomingSessionRequest) -> XPCListener.IncomingSessionRequest.Decision {
        lock.lock()
        defer { lock.unlock() }
        if session != nil || closing { return request.reject(reason: "Telegram's engine is already in use.") }
        let (decision, accepted) = request.accept(
            incomingMessageHandler: { [unowned self] message in received(message) },
            cancellationHandler: { [unowned self] _ in appWent() }
        )
        session = accepted
        return decision
    }

    // MARK: To the app

    func send(json: String) {
        guard let session = lock.withLock({ session }) else { return }
        do { try session.send(message: TelegramWire.message(json: json)) } catch { log.error("couldn't write to the app: \(error.localizedDescription, privacy: .public)") }
    }

    func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return }
        send(json: json)
    }

    /// What a connection through the door carried, which waits until the app has taken it: TDLib
    /// sends no faster than the app's connection takes it. False if the app has gone.
    func sendWaiting(stream: UInt32, bytes: Data) -> Bool {
        guard let session = lock.withLock({ session }) else { return false }
        do {
            _ = try session.sendSync(message: TelegramWire.message(stream: stream, bytes: bytes))
            return true
        } catch {
            return false
        }
    }

    // MARK: From the app

    private func received(_ message: XPCDictionary) -> XPCDictionary? {
        if message["hello"] == true {
            var reply = XPCDictionary()
            reply["ok"] = true
            return reply
        }
        if let json: String = message[TelegramWire.json] {
            heard(json)
            return nil
        }
        if let stream = TelegramWire.streamID(in: message), let bytes = TelegramWire.data(TelegramWire.bytes, in: message) {
            // Answered once it's written, which is when the app sends the next part.
            guard let door = lock.withLock({ door }) else { return XPCDictionary() }
            let answer = TelegramWire.Answer(message)
            door.write(stream: stream, bytes: bytes) { answer.reply() }
            return nil
        }
        if let path: String = message[TelegramWire.file] {
            return opened(path)
        }
        return nil
    }

    private func heard(_ json: String) {
        guard json.utf8.count <= TelegramWire.mostJSON, let data = json.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let kind = value["@type"] as? String {
            if refused.contains(kind) {
                var refusal: [String: Any] = ["@type": "error", "code": 403, "message": "Not here"]
                refusal["@extra"] = value["@extra"]
                send(refusal)
            } else if let engine = lock.withLock({ engine }) {
                engine.send(json)
            }
            return
        }
        let id = (value["id"] as? NSNumber).map(\.uint32Value)
        switch (value["zuna"] as? String, id) {
        case ("start", _):
            start(data)
        case ("erase", _):
            erase()
        case ("opened", let id?):
            lock.withLock { door }?.answered(stream: id, opened: true)
        case ("refused", let id?):
            lock.withLock { door }?.answered(stream: id, opened: false)
        case ("closed", let id?):
            lock.withLock { door }?.closed(stream: id)
        #if DEBUG
        case ("probe", _):
            send(["zuna": "probed", "results": Probe.run(app: value["app"] as? String ?? "", door: lock.withLock { door })])
        #endif
        default:
            break
        }
    }

    /// A file of TDLib's folder, opened for reading, for the app to copy out. Only a file inside the
    /// folder, once every link on the way is followed, and only a file.
    private func opened(_ path: String) -> XPCDictionary {
        var reply = XPCDictionary()
        let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        let root = Self.folder.path
        guard real.hasPrefix(root + "/") else {
            reply[TelegramWire.error] = "That file isn't Telegram's."
            return reply
        }
        let descriptor = Darwin.open(real, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        var status = stat()
        guard descriptor >= 0, fstat(descriptor, &status) == 0, status.st_mode & S_IFMT == S_IFREG else {
            if descriptor >= 0 { close(descriptor) }
            reply[TelegramWire.error] = "Telegram's file couldn't be opened."
            return reply
        }
        TelegramWire.setDescriptor(descriptor, in: reply)
        // The message holds its own copy.
        close(descriptor)
        return reply
    }

    // MARK: TDLib

    private func start(_ data: Data) {
        guard let start = try? JSONDecoder().decode(Start.self, from: data) else {
            log.error("a start that can't be read")
            return
        }
        lock.lock()
        if engine != nil || closing {
            lock.unlock()
            return
        }
        let door: Door
        do {
            try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
            door = try Door(helper: self)
        } catch {
            lock.unlock()
            log.error("the door couldn't open: \(error.localizedDescription, privacy: .public)")
            send(["zuna": "failed", "reason": "Telegram's engine couldn't open its door: \(error.localizedDescription)"])
            return
        }
        let engine = Engine()
        self.engine = engine
        self.door = door
        lock.unlock()

        _ = Engine.execute(#"{"@type":"setLogVerbosityLevel","new_verbosity_level":\#(min(max(start.verbosity ?? 1, 0), 5))}"#)
        engine.receive { [unowned self] json in
            send(json: json)
        } closed: { [unowned self] in
            // TDLib closed, as after its session was ended from another device: this process ends
            // once that's said, whatever the app is doing.
            lock.withLock { closing = true }
            writes.asyncAfter(deadline: .now() + 0.5) { exit(0) }
        }
        // The way out first: a proxy added before the parameters takes effect as TDLib starts,
        // before it first connects, as on the desktop.
        engine.send(object: [
            "@type": "addProxy",
            "proxy": ["@type": "proxy", "server": "127.0.0.1", "port": Int(door.port), "type": ["@type": "proxyTypeSocks5", "username": door.username, "password": door.password]],
            "enable": true,
            "comment": "Zuna",
            "@extra": "zuna:door",
        ])
        engine.send(object: [
            "@type": "setTdlibParameters",
            "use_test_dc": start.testDc ?? false,
            "database_directory": Self.folder.appendingPathComponent("db").path,
            "files_directory": Self.folder.appendingPathComponent("files").path,
            "database_encryption_key": start.key,
            "use_file_database": true,
            "use_chat_info_database": true,
            "use_message_database": true,
            "use_secret_chats": false,
            "api_id": start.apiId,
            "api_hash": start.apiHash,
            "system_language_code": "en",
            // Not the phone's model, nor the system's version, which TDLib would find out for
            // itself if these were empty.
            "device_model": start.device,
            "system_version": start.system,
            "application_version": start.version,
            "@extra": "zuna:parameters",
        ])
    }

    /// Erases TDLib's folder, as the app asks when it unlinks or when the key to the database
    /// can't be opened, then ends: only before TDLib has started in this run.
    private func erase() {
        let running = lock.withLock { engine != nil }
        if !running {
            try? FileManager.default.removeItem(at: Self.folder)
        }
        send(["zuna": "erased", "erased": !running])
        if !running {
            lock.withLock { closing = true }
            writes.asyncAfter(deadline: .now() + 0.5) { exit(0) }
        }
    }

    /// The app went, or ended the session: TDLib is closed, which saves what it has, and then this ends.
    private func appWent() {
        let engine = lock.withLock { () -> Engine? in
            session = nil
            closing = true
            return self.engine
        }
        lock.withLock { door }?.closeAll()
        guard let engine else { exit(0) }
        engine.send(object: ["@type": "close", "@extra": "zuna:close"])
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(10)
            while !engine.closed && Date() < deadline { usleep(50_000) }
            exit(0)
        }
    }
}
