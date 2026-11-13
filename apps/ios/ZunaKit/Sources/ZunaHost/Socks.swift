import Foundation
import Network

/// A small SOCKS5 client of the app's own (RFC 1928, with RFC 1929's username and password), for
/// what the system's SOCKS5 doesn't do: asking the proxy for a UDP association, which carries a
/// call's media, and checking the proxy itself. Everything else goes through the system's
/// (`NetworkProxy.configuration`). As `host/socks.rs` in the desktop app.
public enum Socks {
    public enum Failure: LocalizedError, CustomStringConvertible, Equatable, Sendable {
        /// The proxy couldn't be reached, or didn't speak SOCKS5.
        case unreachable(String)
        /// It refused the username or password, or wanted one it wasn't given.
        case refused
        /// It turned down what it was asked, with its reply's code.
        case declined(UInt8)

        public var description: String {
            switch self {
            case let .unreachable(why): "Can't reach the proxy: \(why)"
            case .refused: "The proxy refused the username or password."
            case let .declined(code):
                switch code {
                case 2: "The proxy doesn't allow that connection."
                case 3: "The proxy can't reach that network."
                case 4: "The proxy can't reach that server."
                case 5: "That server refused the proxy's connection."
                case 6: "The proxy's connection timed out."
                case 7: "The proxy doesn't support that."
                case 8: "The proxy doesn't support that type of address."
                default: "The proxy couldn't make the connection."
                }
            }
        }

        public var errorDescription: String? { description }

        /// Whether it's the proxy that can't be had, rather than what was asked of it.
        public var atProxy: Bool {
            if case .declined = self { return false }
            return true
        }
    }

    static let connect: UInt8 = 1
    static let udpAssociate: UInt8 = 3

    // MARK: Talking to the proxy

    /// A connection to the proxy itself, signed in and ready for one request. It goes straight to
    /// the proxy, past any proxy the system has, as nothing stands between them.
    static func signIn(_ proxy: NetworkProxy, queue: DispatchQueue, within seconds: Double = 15) async throws -> NWConnection {
        guard let port = NWEndpoint.Port(rawValue: proxy.port), proxy.port > 0 else { throw Failure.unreachable("It has no port.") }
        guard proxy.username.utf8.count <= 255, proxy.password.utf8.count <= 255 else { throw Failure.refused }
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = Int(seconds)
        tcp.noDelay = true
        let parameters = NWParameters(tls: nil, tcp: tcp)
        parameters.preferNoProxies = true
        let connection = NWConnection(host: NWEndpoint.Host(proxy.host), port: port, using: parameters)
        let deadline = Deadline(connection, queue: queue, after: seconds)
        do {
            try await ready(connection, queue: queue)
            try await send(Data(proxy.signsIn ? [5, 2, 0, 2] : [5, 1, 0]), on: connection)
            let choice = try await read(2, from: connection)
            guard choice[0] == 5 else { throw Failure.unreachable("It isn't a SOCKS5 proxy.") }
            switch choice[1] {
            case 0:
                break
            case 2 where proxy.signsIn:
                let username = Data(proxy.username.utf8), password = Data(proxy.password.utf8)
                try await send(Data([1, UInt8(username.count)]) + username + Data([UInt8(password.count)]) + password, on: connection)
                let answer = try await read(2, from: connection)
                guard answer[1] == 0 else { throw Failure.refused }
            default:
                throw Failure.refused
            }
            deadline.met()
            return connection
        } catch {
            deadline.met()
            connection.cancel()
            throw deadline.passed ? Failure.unreachable("It didn't answer in time.") : error
        }
    }

    /// Asks a signed-in connection for `command` to `host`, and gives the address the proxy answers with.
    static func request(_ command: UInt8, host: String, port: UInt16, on connection: NWConnection, queue: DispatchQueue, within seconds: Double = 15) async throws -> (host: String, port: UInt16) {
        guard let address = encodeAddress(host, port) else { throw Failure.declined(8) }
        let deadline = Deadline(connection, queue: queue, after: seconds)
        defer { deadline.met() }
        do {
            try await send(Data([5, command, 0]) + address, on: connection)
            let head = try await read(4, from: connection)
            guard head[0] == 5 else { throw Failure.unreachable("It isn't a SOCKS5 proxy.") }
            guard head[1] == 0 else { throw Failure.declined(head[1]) }
            let length: Int
            switch head[3] {
            case 1: length = 4
            case 4: length = 16
            case 3: length = Int(try await read(1, from: connection)[0])
            default: throw Failure.unreachable("Its response couldn't be read.")
            }
            let rest = try await read(length + 2, from: connection)
            let bound: String
            switch head[3] {
            case 1: bound = IPv4Address(rest.prefix(4)).map { "\($0)" } ?? ""
            case 4: bound = IPv6Address(rest.prefix(16)).map { "\($0)" } ?? ""
            default: bound = String(decoding: rest.prefix(length), as: UTF8.self)
            }
            return (bound, UInt16(rest[rest.startIndex + length]) << 8 | UInt16(rest[rest.startIndex + length + 1]))
        } catch {
            throw deadline.passed ? Failure.unreachable("It didn't answer in time.") : error
        }
    }

    /// Whether the proxy can be had: nil when it signs in, or what's wrong. For saying, while no
    /// server can be reached, whether it's the proxy.
    public static func probe(_ proxy: NetworkProxy) async -> Failure? {
        do {
            try await signIn(proxy, queue: DispatchQueue(label: "chat.zuna.proxy-probe"), within: 10).cancel()
            return nil
        } catch let failure as Failure {
            return failure
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }

    /// A connection through the proxy to `host`, which then carries that server's bytes.
    public static func connect(_ proxy: NetworkProxy, to host: String, port: UInt16, queue: DispatchQueue) async throws -> NWConnection {
        let connection = try await signIn(proxy, queue: queue)
        do {
            _ = try await request(connect, host: host, port: port, on: connection, queue: queue)
            return connection
        } catch {
            connection.cancel()
            throw error
        }
    }

    /// A UDP association: the connection that holds it open, which closing ends, and where the
    /// proxy takes datagrams for it.
    public static func associate(_ proxy: NetworkProxy, queue: DispatchQueue) async throws -> (control: NWConnection, relay: NWEndpoint) {
        let connection = try await signIn(proxy, queue: queue)
        do {
            let bound = try await request(udpAssociate, host: "0.0.0.0", port: 0, on: connection, queue: queue)
            // A proxy that answers with no address of its own means its own.
            let host = bound.host.isEmpty || bound.host == "0.0.0.0" || bound.host == "::" ? proxy.host : bound.host
            guard let port = NWEndpoint.Port(rawValue: bound.port), bound.port > 0 else { throw Failure.declined(1) }
            return (connection, .hostPort(host: NWEndpoint.Host(host), port: port))
        } catch {
            connection.cancel()
            throw error
        }
    }

    // MARK: The wire

    /// An address as a request or datagram carries it: four or sixteen bytes, or a name for the proxy to look up.
    static func encodeAddress(_ host: String, _ port: UInt16) -> Data? {
        var data = Data()
        let bare = PinnedServers.bare(host)
        if let address = IPv4Address(bare) {
            data.append(1)
            data.append(address.rawValue)
        } else if let address = IPv6Address(bare) {
            data.append(4)
            data.append(address.rawValue)
        } else {
            let name = Data(bare.utf8)
            guard !name.isEmpty, name.count <= 255 else { return nil }
            data.append(3)
            data.append(UInt8(name.count))
            data.append(name)
        }
        data.append(UInt8(port >> 8))
        data.append(UInt8(port & 0xff))
        return data
    }

    /// A datagram for the proxy to send on to `host`.
    public static func wrap(_ payload: Data, to host: String, port: UInt16) -> Data? {
        guard let address = encodeAddress(host, port) else { return nil }
        return Data([0, 0, 0]) + address + payload
    }

    /// A datagram from the proxy: who it came from, and what they sent. Nil for one in pieces,
    /// which nobody sends a call in, or one that can't be read.
    public static func unwrap(_ datagram: Data) -> (host: String, port: UInt16, payload: Data)? {
        let bytes = [UInt8](datagram)
        guard bytes.count >= 4, bytes[2] == 0 else { return nil }
        var index = 4
        let host: String
        switch bytes[3] {
        case 1:
            guard bytes.count >= index + 6, let address = IPv4Address(Data(bytes[index..<index + 4])) else { return nil }
            host = "\(address)"
            index += 4
        case 4:
            guard bytes.count >= index + 18, let address = IPv6Address(Data(bytes[index..<index + 16])) else { return nil }
            host = "\(address)"
            index += 16
        case 3:
            guard bytes.count >= index + 1 else { return nil }
            let length = Int(bytes[index])
            guard bytes.count >= index + 1 + length + 2 else { return nil }
            host = String(decoding: bytes[index + 1..<index + 1 + length], as: UTF8.self)
            index += 1 + length
        default:
            return nil
        }
        let port = UInt16(bytes[index]) << 8 | UInt16(bytes[index + 1])
        return (host, port, Data(bytes[(index + 2)...]))
    }

    // MARK: Checking it

    /// What a check of a proxy found: whether it signed in and how long that took, whether it
    /// carries UDP, and how long each server took to reach through it.
    public struct Report: Sendable {
        /// How long a server took to reach through the proxy, or why it couldn't be.
        public enum Reach: Sendable {
            case reached(TimeInterval)
            case failed(String)
        }

        public var signedIn: Result<TimeInterval, Failure>
        public var udp: Bool
        public var servers: [(name: String, reached: Reach)]
    }

    /// Signs in to the proxy, asks it for a UDP association, and reaches each server through it, as
    /// the app would with it set (`check` in the desktop's `host/net.rs`).
    public static func check(_ proxy: NetworkProxy, servers: [(name: String, url: String)]) async -> Report {
        let queue = DispatchQueue(label: "chat.zuna.proxy-check")
        let started = Date()
        var report = Report(signedIn: .success(0), udp: false, servers: [])
        do {
            let (control, _) = try await associate(proxy, queue: queue)
            control.cancel()
            report.signedIn = .success(Date().timeIntervalSince(started))
            report.udp = true
        } catch Failure.declined {
            report.signedIn = .success(Date().timeIntervalSince(started))
        } catch let failure as Failure {
            report.signedIn = .failure(failure)
            return report
        } catch {
            report.signedIn = .failure(.unreachable(error.localizedDescription))
            return report
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 20
        NetworkProxy.apply(proxy, to: configuration)
        let session = URLSession(configuration: configuration, delegate: PinnedServers.shared, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        for server in servers {
            let started = Date()
            guard let url = URL(string: server.url.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/healthz"), let host = url.host else {
                report.servers.append((server.name, .failed("Its address can't be read.")))
                continue
            }
            if NetworkProxy.goesAround(host) {
                report.servers.append((server.name, .failed(NetworkProxy.goesAroundMessage)))
                continue
            }
            do {
                let (_, response) = try await session.data(from: url)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                report.servers.append((server.name, (200..<300).contains(status) ? .reached(Date().timeIntervalSince(started)) : .failed("It responded with status \(status).")))
            } catch let error as URLError where error.code == .timedOut {
                report.servers.append((server.name, .failed("It didn't answer in time.")))
            } catch {
                report.servers.append((server.name, .failed("The proxy couldn't reach it.")))
            }
        }
        return report
    }

    // MARK: Network, awaited

    static func ready(_ connection: NWConnection, queue: DispatchQueue) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = Once()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.run { continuation.resume() }
                case let .waiting(error), let .failed(error):
                    once.run { continuation.resume(throwing: Failure.unreachable(Self.describe(error))) }
                    connection.cancel()
                case .cancelled:
                    once.run { continuation.resume(throwing: Failure.unreachable("It didn't answer in time.")) }
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    static func send(_ data: Data, on connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: Failure.unreachable(Self.describe(error))) } else { continuation.resume() }
            })
        }
    }

    static func read(_ count: Int, from connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: count, maximumLength: count) { data, _, complete, error in
                if let data, data.count == count {
                    continuation.resume(returning: data)
                } else if let error {
                    continuation.resume(throwing: Failure.unreachable(Self.describe(error)))
                } else {
                    continuation.resume(throwing: Failure.unreachable(complete ? "It closed the connection." : "Its response was cut off."))
                }
            }
        }
    }

    static func describe(_ error: NWError) -> String {
        switch error {
        case let .posix(code) where code == .ECONNREFUSED: "Nothing is responding at that address."
        case let .posix(code) where code == .ETIMEDOUT: "It didn't answer in time."
        case .dns: "Its name couldn't be found."
        default: error.localizedDescription
        }
    }
}

/// Runs something once, from whichever callback comes first.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func run(_ body: () -> Void) {
        let first = lock.withLock { () -> Bool in
            defer { done = true }
            return !done
        }
        if first { body() }
    }
}

/// Cancels a connection that hasn't done what it was asked in time, which fails what's waiting on it.
final class Deadline: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false
    private var expired = false

    init(_ connection: NWConnection, queue: DispatchQueue, after seconds: Double) {
        queue.asyncAfter(deadline: .now() + seconds) { [weak self, weak connection] in
            guard let self else { return }
            let expire = lock.withLock { () -> Bool in
                guard !settled else { return false }
                expired = true
                return true
            }
            if expire { connection?.cancel() }
        }
    }

    func met() { lock.withLock { settled = true } }
    var passed: Bool { lock.withLock { expired } }
}
