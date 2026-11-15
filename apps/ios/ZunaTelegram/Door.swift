import Darwin
import Foundation

/// The helper's end of the door, as `apps/desktop/telegram/src/door.rs` is the desktop engine's: a
/// SOCKS5 proxy on this process's own loopback, which TDLib is told to use, and which opens
/// nothing itself. Each connection TDLib makes through it is asked of the app (`open`), which
/// decides whether it may go anywhere and opens the real one if so (`opened` or `refused`). From
/// then on what either side sends goes over the session, until one of them closes it (`closed`).
///
/// It takes only a username and password made for this run, so that nothing else on the device
/// uses it as a way to Telegram, and only addresses, never names: Telegram's servers are reached
/// by address, and the app connects to Telegram's own ranges alone.
final class Door: @unchecked Sendable {
    let username = Door.randomText()
    let password = Door.randomText()

    /// The port TDLib is told to use, which stays the same when the door listens again, if it can.
    var port: UInt16 { lock.withLock { listening } }

    /// What listens for TDLib, and on which port: both made again when iOS takes it back (`listenAgain`).
    private var listener: Int32
    private var listening: UInt16
    private unowned let helper: Helper
    private let lock = NSLock()
    private var streams: [UInt32: Stream] = [:]
    private var next: UInt32 = 1

    /// How long the handshake and the app's answer may take.
    private static let handshake: TimeInterval = 30
    /// How often, in milliseconds, the listener is looked at while nobody connects.
    private static let lookEvery: Int32 = 5000

    private final class Answer: @unchecked Sendable {
        let ready = DispatchSemaphore(value: 0)
        var opened = false
    }

    private enum Stream {
        /// Asked of the app, waiting for its answer.
        case waiting(Answer)
        /// Open: what the app sends is written to TDLib's end on the queue, which also closes it,
        /// so nothing is written to a descriptor after it's closed.
        case open(Int32, DispatchQueue)
    }

    init(helper: Helper) throws {
        self.helper = helper
        (listener, listening) = try Door.openListener(port: 0)
        let accepting = Thread { [self] in acceptAll() }
        accepting.name = "door"
        accepting.start()
    }

    /// A socket listening on this process's loopback, on the port given or on any for 0, and its port.
    private static func openListener(port: UInt16) throws -> (Int32, UInt16) {
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        guard listener >= 0 else { throw Door.failure("socket") }
        // The same port again, while connections that came through the one before are closing.
        var yes: Int32 = 1
        setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = in_addr_t(INADDR_LOOPBACK).bigEndian
        address.sin_port = port.bigEndian
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, length) } }
        guard bound == 0, listen(listener, 16) == 0 else {
            let error = Door.failure("bind")
            close(listener)
            throw error
        }
        let named = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) } }
        guard named == 0 else {
            let error = Door.failure("getsockname")
            close(listener)
            throw error
        }
        return (listener, UInt16(bigEndian: address.sin_port))
    }

    private static func failure(_ call: String) -> Error {
        NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(call): \(String(cString: strerror(errno)))"])
    }

    private static func randomText() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        arc4random_buf(&bytes, bytes.count)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: What the app says

    /// The app's answer to `open`.
    func answered(stream id: UInt32, opened: Bool) {
        lock.lock()
        defer { lock.unlock() }
        if case .waiting(let answer) = streams[id] {
            answer.opened = opened
            answer.ready.signal()
        }
    }

    /// What the app's end of a connection sent, and `done` once it's written to TDLib's.
    func write(stream id: UInt32, bytes: Data, done: @escaping @Sendable () -> Void) {
        lock.lock()
        guard case .open(let socket, let queue) = streams[id] else {
            lock.unlock()
            return done()
        }
        lock.unlock()
        queue.async {
            Door.writeAll(socket, bytes)
            done()
        }
    }

    /// The app's end closed: TDLib's is shut, and its reader finishes it.
    func closed(stream id: UInt32) {
        lock.lock()
        let stream = streams.removeValue(forKey: id)
        lock.unlock()
        if case .open(let socket, let queue) = stream {
            queue.async { shutdown(socket, SHUT_RDWR) }
        }
    }

    /// Every connection ends, as when the app goes.
    func closeAll() {
        lock.lock()
        let all = streams
        streams.removeAll()
        lock.unlock()
        for stream in all.values {
            switch stream {
            case .waiting(let answer):
                answer.ready.signal()
            case .open(let socket, let queue):
                queue.async { shutdown(socket, SHUT_RDWR) }
            }
        }
    }

    #if DEBUG
    /// Does what iOS does to a suspended process's sockets when it takes them back: the listener
    /// listens no more, from then on, and every connection through the door ends. For the checks
    /// (`telegramReclaim`), as the simulator never does it.
    func reclaim() {
        lock.lock()
        let listener = self.listener
        let open = streams.values.compactMap { stream -> Int32? in
            if case .open(let socket, _) = stream { return socket }
            return nil
        }
        lock.unlock()
        // A socket that isn't listening in its place, as the one iOS took back no longer is.
        let dead = socket(AF_INET, SOCK_STREAM, 0)
        if dead >= 0 {
            dup2(dead, listener)
            close(dead)
        }
        for socket in open { shutdown(socket, SHUT_RDWR) }
        log.notice("the door's sockets were taken, for the checks")
    }
    #endif

    // MARK: TDLib's end

    /// Takes each connection TDLib makes, for as long as this process runs. iOS takes back the
    /// sockets of a process it suspended when it likes, a listener's too, which then listens no more
    /// though the process goes on (TN2277, "Socket Resource Reclaim"): each accept fails from then
    /// on, or nothing wakes it, and TDLib, which reaches Telegram through nothing else, said it was
    /// connecting until the app was started again. So a listener that fails, or that's found with an
    /// error or no longer listening, is made again.
    private func acceptAll() {
        while true {
            let listener = lock.withLock { self.listener }
            var ready = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            let polled = poll(&ready, 1, Door.lookEvery)
            if polled < 0 {
                if errno == EINTR { continue }
                listenAgain(listener, why: String(cString: strerror(errno)))
                continue
            }
            if polled == 0 {
                if let why = broken(listener) { listenAgain(listener, why: why) }
                continue
            }
            let connection = accept(listener, nil, nil)
            if connection < 0 {
                if errno == EINTR { continue }
                listenAgain(listener, why: String(cString: strerror(errno)))
                continue
            }
            var yes: Int32 = 1
            setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(connection, Int32(IPPROTO_TCP), TCP_NODELAY, &yes, socklen_t(MemoryLayout<Int32>.size))
            let serving = Thread { [self] in serve(connection) }
            serving.name = "door-stream"
            serving.start()
        }
    }

    /// Why a listener nobody connected to can't be used any more, if it can't. One iOS took back has
    /// an error waiting, which nothing else reads, and refuses to listen; one put in its place is on
    /// another port.
    private func broken(_ listener: Int32) -> String? {
        var error: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(listener, SOL_SOCKET, SO_ERROR, &error, &length) == 0 else { return String(cString: strerror(errno)) }
        if error != 0 { return String(cString: strerror(error)) }
        var address = sockaddr_in()
        length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) } }
        guard named == 0 else { return String(cString: strerror(errno)) }
        guard UInt16(bigEndian: address.sin_port) == lock.withLock({ listening }) else { return "not on the door's port" }
        // Listening again changes nothing on a listener that is one.
        guard listen(listener, 16) == 0 else { return String(cString: strerror(errno)) }
        return nil
    }

    /// Listens again: on the port TDLib was told if it can, and otherwise on another, which it's
    /// told now. Until a socket can be had, as with none left to this process, it's tried again
    /// less and less often.
    private func listenAgain(_ old: Int32, why: String) {
        log.notice("the door stopped listening (\(why, privacy: .public)), so it listens again")
        lock.withLock { listener = -1 }
        close(old)
        var wait: TimeInterval = 0.1
        var tries = 0
        while true {
            let port = lock.withLock { listening }
            if case let (listener, _)? = try? Door.openListener(port: port) {
                lock.withLock { self.listener = listener }
                return
            }
            tries += 1
            if tries >= 3, case let (listener, moved)? = try? Door.openListener(port: 0) {
                lock.withLock {
                    self.listener = listener
                    listening = moved
                }
                log.notice("the door listens on another port, which TDLib is told")
                helper.doorMoved(self)
                return
            }
            Thread.sleep(forTimeInterval: wait)
            wait = min(wait * 2, 5)
        }
    }

    private func serve(_ socket: Int32) {
        Door.setTimeout(socket, Door.handshake)
        guard let (host, port) = Door.handshake(socket, username: username, password: password) else {
            close(socket)
            return
        }
        let answer = Answer()
        let id: UInt32 = lock.withLock {
            let id = next
            next &+= 1
            streams[id] = .waiting(answer)
            return id
        }
        helper.send(["zuna": "open", "id": Int(id), "host": host, "port": Int(port)])
        let answeredInTime = answer.ready.wait(timeout: .now() + Door.handshake) == .success
        guard answeredInTime, answer.opened else {
            lock.withLock { _ = streams.removeValue(forKey: id) }
            // "Connection not allowed by ruleset".
            Door.writeAll(socket, Data([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))
            // Not answered in time: whatever the app opens late is closed.
            if !answeredInTime { helper.send(["zuna": "closed", "id": Int(id)]) }
            close(socket)
            return
        }
        let queue = DispatchQueue(label: "chat.zuna.telegram.door-write")
        let stillAsked: Bool = lock.withLock {
            guard streams[id] != nil else { return false }
            streams[id] = .open(socket, queue)
            return true
        }
        guard stillAsked, Door.writeAll(socket, Data([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])) else {
            finish(id, socket, queue)
            return
        }
        Door.setTimeout(socket, 0)
        // What TDLib sends, carried to the app a part at a time, until either end closes.
        var buffer = [UInt8](repeating: 0, count: TelegramWire.mostData)
        while true {
            let count = buffer.withUnsafeMutableBytes { recv(socket, $0.baseAddress, $0.count, 0) }
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { break }
            if !helper.sendWaiting(stream: id, bytes: Data(buffer[0..<count])) { break }
        }
        finish(id, socket, queue)
    }

    /// TDLib's end closed, or failed: the app's is told, if it's still open, and the socket goes
    /// once whatever was being written to it is done.
    private func finish(_ id: UInt32, _ socket: Int32, _ queue: DispatchQueue) {
        let wasOpen: Bool = lock.withLock { streams.removeValue(forKey: id) != nil }
        if wasOpen { helper.send(["zuna": "closed", "id": Int(id)]) }
        queue.async {
            shutdown(socket, SHUT_RDWR)
            close(socket)
        }
    }

    private static func setTimeout(_ socket: Int32, _ seconds: TimeInterval) {
        var time = timeval(tv_sec: Int(seconds), tv_usec: 0)
        setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
    }

    @discardableResult
    private static func writeAll(_ socket: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { buffer in
            var sent = 0
            while sent < buffer.count {
                let count = send(socket, buffer.baseAddress! + sent, buffer.count - sent, 0)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return false }
                sent += count
            }
            return true
        }
    }

    private static func readExact(_ socket: Int32, _ count: Int) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: count)
        var got = 0
        while got < count {
            let read = bytes.withUnsafeMutableBytes { recv(socket, $0.baseAddress! + got, count - got, 0) }
            if read < 0 && errno == EINTR { continue }
            if read <= 0 { return nil }
            got += read
        }
        return bytes
    }

    /// SOCKS5's handshake (RFC 1928, with RFC 1929's username and password), for a CONNECT to an
    /// address. Anything else is answered with the failure SOCKS5 has for it, and nil.
    static func handshake(_ socket: Int32, username: String, password: String) -> (String, UInt16)? {
        guard let head = readExact(socket, 2), head[0] == 5, let methods = readExact(socket, Int(head[1])) else { return nil }
        guard methods.contains(2) else {
            writeAll(socket, Data([5, 0xff]))
            return nil
        }
        writeAll(socket, Data([5, 2]))
        guard let version = readExact(socket, 2), let givenUser = readExact(socket, Int(version[1])),
              let length = readExact(socket, 1), let givenPassword = readExact(socket, Int(length[0])) else { return nil }
        guard version[0] == 1, same(givenUser, Array(username.utf8)), same(givenPassword, Array(password.utf8)) else {
            writeAll(socket, Data([1, 1]))
            return nil
        }
        writeAll(socket, Data([1, 0]))
        guard let request = readExact(socket, 4) else { return nil }
        guard request[0] == 5, request[1] == 1 else {
            // "Command not supported".
            writeAll(socket, Data([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
            return nil
        }
        let host: String
        switch request[3] {
        case 1:
            guard let octets = readExact(socket, 4) else { return nil }
            host = octets.map(String.init).joined(separator: ".")
        case 4:
            guard let octets = readExact(socket, 16) else { return nil }
            var address = in6_addr()
            withUnsafeMutableBytes(of: &address) { $0.copyBytes(from: octets) }
            var text = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            guard inet_ntop(AF_INET6, &address, &text, socklen_t(text.count)) != nil else { return nil }
            host = String(decoding: text.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        default:
            // "Address type not supported": a name, which the door never resolves.
            writeAll(socket, Data([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]))
            return nil
        }
        guard let port = readExact(socket, 2) else { return nil }
        return (host, UInt16(port[0]) << 8 | UInt16(port[1]))
    }

    /// Compares two secrets in time that doesn't depend on where they differ.
    private static func same(_ given: [UInt8], _ expected: [UInt8]) -> Bool {
        given.count == expected.count && zip(given, expected).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
