import Darwin
import Foundation
import Network
import os

/// The door, the one way a linked Telegram account's TDLib is given to Telegram
/// (docs/TELEGRAM_PLAN.md, "The door"), as the desktop's is in two halves, the engine's
/// (`apps/desktop/telegram/src/door.rs`) and the app's (`apps/desktop/src/telegram/door.rs`). Here
/// it's one piece: a SOCKS5 proxy on this process's loopback, which TDLib is told to use
/// (`addProxy`), and the connections it opens outward for each one TDLib makes through it.
///
/// It lets a connection through only to one of Telegram's own addresses, on a port Telegram uses.
/// A name is always refused: Telegram's servers are reached by address, and what TDLib does when it
/// can't reach them, asking other companies' servers where they went, isn't Telegram's and doesn't
/// go. It goes through the proxy set in Privacy where there is one, as everything else does, and
/// nowhere while that can't be reached. It takes only a username and password made for this run,
/// so that nothing else on the device uses it as a way to Telegram.
///
/// On the iPhone TDLib runs in the app's own process, so the door holds TDLib to this only for what
/// TDLib is told to do: code that had taken the process over could open a socket of its own
/// (`docs/SECURITY_DETAILS.md`, "Telegram on the iPhone and iPad").
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
    /// How long a connection outward may take to open.
    static let connectTimeout: TimeInterval = 15
    /// How long TDLib's handshake may take.
    static let handshakeTimeout: TimeInterval = 30
    /// How often, in milliseconds, the listener is looked at while nobody connects.
    static let lookEvery: Int32 = 5000
    /// The most one part of a connection carries, either way.
    static let mostPart = 64 << 10

    /// Whether an address is in Telegram's ranges, at whatever port: what a Telegram call's relays
    /// are held to (docs/TELEGRAM_CALLS_PLAN.md, The media). Only a written-out address, never a name.
    static func isTelegrams(_ host: String) -> Bool {
        if let address = IPv4Address(host) { return inRanges(address.rawValue, rangesV4.map { (IPv4Address($0.0)!.rawValue, $0.1) }) }
        if let address = IPv6Address(host) {
            if let mapped = address.asIPv4 { return isTelegrams("\(mapped)") }
            return inRanges(address.rawValue, rangesV6.map { (IPv6Address($0.0)!.rawValue, $0.1) })
        }
        return false
    }

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

    let username = TelegramDoor.randomText()
    let password = TelegramDoor.randomText()

    /// The port TDLib is told to use, which stays the same when the door listens again, if it can.
    var port: UInt16 { lock.withLock { listening } }

    private let lock = NSLock()
    /// What listens for TDLib, and on which port: both made again when iOS takes it back (`listenAgain`).
    private var listener: Int32
    private var listening: UInt16
    /// The door was closed, as its run ended: it listens no more, and its thread ends.
    private var shut = false
    /// A pipe that wakes the listening thread at once, to look at its listener or to end, and
    /// whether that thread has closed it, after which nothing writes to it.
    private let wakeRead: Int32
    private let wakeWrite: Int32
    private var pipeClosed = false
    /// What waits for the listener to have been looked at (`look`).
    private var looks: [@Sendable () -> Void] = []
    private var streams: [UInt32: Stream] = [:]
    private var next: UInt32 = 1
    /// Called when the door had to move to another port, which TDLib has to be told.
    private let moved: @Sendable (TelegramDoor) -> Void
    /// Where every connection outward says how it's doing.
    private let queue = DispatchQueue(label: "chat.zuna.telegram.door")
    private let logger = Logger(subsystem: "chat.zuna", category: "telegram")

    /// One connection through the door: TDLib's end, and the one opened to Telegram.
    private final class Stream: @unchecked Sendable {
        let socket: Int32
        var connection: NWConnection?
        /// What's written to TDLib's end goes here one part at a time, and so does closing it,
        /// so that nothing is written to the descriptor after it's closed.
        let writes = DispatchQueue(label: "chat.zuna.telegram.door-write")
        /// Set on `writes` once the socket is closed.
        var socketClosed = false
        /// Set under the door's lock once either end has gone.
        var ended = false
        init(socket: Int32) { self.socket = socket }
    }

    /// How a connection outward came out, waited for by the thread that serves TDLib's end.
    private final class Outcome: @unchecked Sendable {
        private let lock = NSLock()
        private var result: (Bool, String)?
        let ready = DispatchSemaphore(value: 0)

        func set(_ opened: Bool, _ why: String) {
            let first = lock.withLock { () -> Bool in
                guard result == nil else { return false }
                result = (opened, why)
                return true
            }
            if first { ready.signal() }
        }

        var value: (Bool, String)? { lock.withLock { result } }
    }

    init(moved: @escaping @Sendable (TelegramDoor) -> Void) throws {
        self.moved = moved
        var pipe = [Int32](repeating: -1, count: 2)
        guard Darwin.pipe(&pipe) == 0 else { throw TelegramDoor.failure("pipe") }
        wakeRead = pipe[0]
        wakeWrite = pipe[1]
        _ = fcntl(wakeRead, F_SETFL, fcntl(wakeRead, F_GETFL) | O_NONBLOCK)
        _ = fcntl(wakeWrite, F_SETFL, fcntl(wakeWrite, F_GETFL) | O_NONBLOCK)
        do {
            (listener, listening) = try TelegramDoor.openListener(port: 0)
        } catch {
            Darwin.close(pipe[0])
            Darwin.close(pipe[1])
            throw error
        }
        let accepting = Thread { [self] in acceptAll() }
        accepting.name = "telegram-door"
        accepting.start()
    }

    // MARK: What the broker asks

    /// The listener is looked at now, rather than at the next look, and made again if it has to
    /// be: the app is back, and iOS may have taken it back while the app was suspended. `then`
    /// once it has been, on a queue of the system's, unless the door closes first.
    func look(then: (@Sendable () -> Void)? = nil) {
        lock.withLock {
            guard !pipeClosed else { return }
            if let then { looks.append(then) }
            var byte: UInt8 = 1
            _ = Darwin.write(wakeWrite, &byte, 1)
        }
    }

    /// Every connection through the door ends, and TDLib makes them again, as when the proxy changed.
    func closeAll() {
        let all = lock.withLock { Array(streams.values) }
        for stream in all { end(stream) }
    }

    /// The door closes for good, as its run ended: it listens no more, and every connection ends.
    func close() {
        lock.withLock { shut = true }
        closeAll()
        look()
    }

    #if DEBUG
    /// Does what iOS does to a suspended process's sockets when it takes them back: the listener
    /// listens no more, from then on, and every connection through the door ends. For the checks
    /// (`telegramReclaim`), as the simulator never does it.
    func reclaim() {
        let listener = lock.withLock { self.listener }
        // A socket that isn't listening in its place, as the one iOS took back no longer is.
        let dead = socket(AF_INET, SOCK_STREAM, 0)
        if dead >= 0, listener >= 0 {
            dup2(dead, listener)
        }
        if dead >= 0 { Darwin.close(dead) }
        closeAll()
        logger.notice("the door's sockets were taken, for the checks")
    }
    #endif

    // MARK: Listening

    /// A socket listening on this process's loopback, on the port given or on any for 0, and its port.
    private static func openListener(port: UInt16) throws -> (Int32, UInt16) {
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        guard listener >= 0 else { throw failure("socket") }
        _ = fcntl(listener, F_SETFD, FD_CLOEXEC)
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
            let error = failure("bind")
            Darwin.close(listener)
            throw error
        }
        let named = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) } }
        guard named == 0 else {
            let error = failure("getsockname")
            Darwin.close(listener)
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

    /// Takes each connection TDLib makes, until the door closes. iOS takes back the sockets of a
    /// process it suspended when it likes, a listener's too, which then listens no more though the
    /// process goes on (TN2277, "Socket Resource Reclaim"): each accept fails from then on, or
    /// nothing wakes it, and TDLib, which reaches Telegram through nothing else, would say it was
    /// connecting for good. So a listener that fails, or that's found with an error or no longer
    /// listening, is made again: looked at every few seconds, and at once when the app is back (`look`).
    private func acceptAll() {
        while true {
            let (listener, shut) = lock.withLock { (self.listener, self.shut) }
            if shut { break }
            var ready = [pollfd(fd: listener, events: Int16(POLLIN), revents: 0), pollfd(fd: wakeRead, events: Int16(POLLIN), revents: 0)]
            let polled = poll(&ready, 2, TelegramDoor.lookEvery)
            if lock.withLock({ self.shut }) { break }
            if polled < 0 {
                if errno == EINTR { continue }
                listenAgain(listener, why: String(cString: strerror(errno)))
                continue
            }
            if ready[1].revents != 0 {
                // Asked to look now.
                var drained = [UInt8](repeating: 0, count: 64)
                while Darwin.read(wakeRead, &drained, drained.count) > 0 {}
                let relisten = broken(listener)
                if let why = relisten { listenAgain(listener, why: why) }
                let waiting = lock.withLock { () -> [@Sendable () -> Void] in
                    defer { looks.removeAll() }
                    return looks
                }
                // Not on this thread, which takes TDLib's connections.
                for then in waiting { DispatchQueue.global().async(execute: then) }
                if relisten != nil { continue }
            }
            if ready[0].revents & Int16(POLLIN) == 0 {
                if ready[0].revents & Int16(POLLERR | POLLHUP | POLLNVAL) != 0 {
                    listenAgain(listener, why: "the listener has an error")
                } else if polled == 0, let why = broken(listener) {
                    listenAgain(listener, why: why)
                }
                continue
            }
            let connection = accept(listener, nil, nil)
            if connection < 0 {
                if errno == EINTR || errno == EAGAIN || errno == ECONNABORTED { continue }
                listenAgain(listener, why: String(cString: strerror(errno)))
                continue
            }
            _ = fcntl(connection, F_SETFD, FD_CLOEXEC)
            var yes: Int32 = 1
            setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(connection, Int32(IPPROTO_TCP), TCP_NODELAY, &yes, socklen_t(MemoryLayout<Int32>.size))
            let serving = Thread { [self] in serve(connection) }
            serving.name = "telegram-door-stream"
            serving.start()
        }
        lock.withLock {
            if listener >= 0 { Darwin.close(listener) }
            listener = -1
            pipeClosed = true
            Darwin.close(wakeRead)
            Darwin.close(wakeWrite)
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
    /// less and less often, until the door closes.
    private func listenAgain(_ old: Int32, why: String) {
        logger.notice("the door stopped listening (\(why, privacy: .public)), so it listens again")
        lock.withLock { listener = -1 }
        Darwin.close(old)
        var wait: TimeInterval = 0.1
        var tries = 0
        while !lock.withLock({ shut }) {
            let port = lock.withLock { listening }
            if case let (listener, _)? = try? TelegramDoor.openListener(port: port) {
                lock.withLock { self.listener = listener }
                return
            }
            tries += 1
            if tries >= 3, case let (listener, moved)? = try? TelegramDoor.openListener(port: 0) {
                lock.withLock {
                    self.listener = listener
                    listening = moved
                }
                logger.notice("the door listens on another port, which TDLib is told")
                self.moved(self)
                return
            }
            Thread.sleep(forTimeInterval: wait)
            wait = min(wait * 2, 5)
        }
    }

    // MARK: One connection

    private func refuse(_ socket: Int32, _ reply: UInt8, _ host: String, _ port: UInt16, _ why: String) {
        logger.info("the door refused \(host, privacy: .public):\(port): \(why, privacy: .public)")
        TelegramDoor.writeAll(socket, Data([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]))
        Darwin.close(socket)
    }

    /// One connection TDLib made, on a thread of its own: its handshake, the connection outward
    /// if it may have one, and then what TDLib sends, carried to Telegram a part at a time, each
    /// read once the one before has gone, until either end closes.
    private func serve(_ socket: Int32) {
        TelegramDoor.setTimeout(socket, TelegramDoor.handshakeTimeout)
        guard let (host, port) = TelegramDoor.handshake(socket, username: username, password: password) else {
            Darwin.close(socket)
            return
        }
        // "Connection not allowed by ruleset".
        guard TelegramDoor.allowed(host: host, port: Int(port)), let endpointPort = NWEndpoint.Port(rawValue: port) else {
            return refuse(socket, 2, host, port, "not one of Telegram's")
        }
        let options = NWProtocolTCP.Options()
        options.noDelay = true
        options.connectionTimeout = Int(TelegramDoor.connectTimeout)
        let parameters = NWParameters(tls: nil, tcp: options)
        NetworkProxy.apply(NetworkProxy.current, to: parameters)
        let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: parameters)
        let stream = Stream(socket: socket)
        stream.connection = connection
        let registered: UInt32? = lock.withLock {
            guard !shut else { return nil }
            let id = next
            next &+= 1
            streams[id] = stream
            return id
        }
        guard let id = registered else { return refuse(socket, 1, host, port, "the door is closing") }

        let outcome = Outcome()
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready: outcome.set(true, "")
            // Not waited for: a connection that can't go now is one TDLib tries again itself.
            case .waiting(let error), .failed(let error): outcome.set(false, error.localizedDescription)
            case .cancelled: outcome.set(false, "it was closed")
            default: break
            }
        }
        connection.start(queue: queue)
        let answered = outcome.ready.wait(timeout: .now() + TelegramDoor.connectTimeout) == .success
        guard answered, outcome.value?.0 == true, lock.withLock({ !stream.ended }) else {
            end(stream)
            finish(id, stream, refusing: answered ? (outcome.value?.1 ?? "it was closed") : "it took too long", host, port)
            return
        }
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.end(stream)
            default: break
            }
        }
        // "Succeeded", from then on carried both ways.
        let accepted = stream.writes.sync { !stream.socketClosed && TelegramDoor.writeAll(socket, Data([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])) }
        guard accepted else {
            end(stream)
            return finish(id, stream)
        }
        TelegramDoor.setTimeout(socket, 0)
        receive(stream, connection)

        var buffer = [UInt8](repeating: 0, count: TelegramDoor.mostPart)
        reading: while true {
            let count = buffer.withUnsafeMutableBytes { recv(socket, $0.baseAddress, $0.count, 0) }
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { break }
            let sent = DispatchSemaphore(value: 0)
            let failed = Outcome()
            connection.send(content: Data(buffer[0..<count]), completion: .contentProcessed { error in
                if error != nil { failed.set(true, "") }
                sent.signal()
            })
            // Until it's gone, or the connection has ended, whose sends then needn't be waited for.
            while sent.wait(timeout: .now() + 1) == .timedOut {
                if lock.withLock({ stream.ended }) { break reading }
            }
            if failed.value != nil { break }
        }
        end(stream)
        finish(id, stream)
    }

    /// What Telegram sends, written to TDLib's end a part at a time, each asked for once the one
    /// before is written.
    private func receive(_ stream: Stream, _ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: TelegramDoor.mostPart) { [weak self] content, _, complete, error in
            guard let self else { return }
            if let content, !content.isEmpty {
                stream.writes.async {
                    let written = !stream.socketClosed && TelegramDoor.writeAll(stream.socket, content)
                    self.queue.async {
                        if written && !complete && error == nil { self.receive(stream, connection) } else { self.end(stream) }
                    }
                }
            } else if complete || error != nil {
                end(stream)
            } else {
                receive(stream, connection)
            }
        }
    }

    /// Either end of a connection went: the other is ended too, once. TDLib's end is shut, which
    /// wakes the thread reading it, and that thread closes it (`finish`).
    private func end(_ stream: Stream) {
        let (first, connection) = lock.withLock { () -> (Bool, NWConnection?) in
            guard !stream.ended else { return (false, nil) }
            stream.ended = true
            return (true, stream.connection)
        }
        guard first else { return }
        connection?.cancel()
        stream.writes.async {
            if !stream.socketClosed { shutdown(stream.socket, SHUT_RDWR) }
        }
    }

    /// The thread serving TDLib's end is done: the socket goes once whatever was being written to
    /// it is, after a refusal if it was never opened, and the connection outward is let go.
    private func finish(_ id: UInt32, _ stream: Stream, refusing why: String? = nil, _ host: String = "", _ port: UInt16 = 0) {
        let connection = lock.withLock { () -> NWConnection? in
            streams[id] = nil
            defer { stream.connection = nil }
            return stream.connection
        }
        connection?.stateUpdateHandler = nil
        if let why { logger.info("the door refused \(host, privacy: .public):\(port): \(why, privacy: .public)") }
        stream.writes.async {
            guard !stream.socketClosed else { return }
            // "Connection refused".
            if why != nil { TelegramDoor.writeAll(stream.socket, Data([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])) }
            stream.socketClosed = true
            Darwin.close(stream.socket)
        }
    }

    // MARK: SOCKS5

    private static func setTimeout(_ socket: Int32, _ seconds: TimeInterval) {
        var time = timeval(tv_sec: Int(seconds), tv_usec: 0)
        setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
    }

    @discardableResult
    static func writeAll(_ socket: Int32, _ data: Data) -> Bool {
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
    static func same(_ given: [UInt8], _ expected: [UInt8]) -> Bool {
        given.count == expected.count && zip(given, expected).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

/// Telegram's published ranges, for the app: a Telegram call's relays are held to them, as the
/// engine's door is (`TelegramDoor.rangesV4` and `rangesV6`).
public enum TelegramRanges {
    /// Whether a written-out address is Telegram's. A name is never Telegram's here.
    public static func contains(_ host: String) -> Bool { TelegramDoor.isTelegrams(host) }
}
