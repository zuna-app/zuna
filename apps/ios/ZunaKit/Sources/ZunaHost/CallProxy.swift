import CryptoKit
import Foundation
import Network
import os

/// A call through the proxy (docs/SOCKS5_PLAN.md, "Calls"): LiveKit's SDK is only ever told
/// addresses on this device. Its socket comes to an endpoint here, on loopback, at an address
/// with a secret made for this call, which opens the real one through the proxy and rewrites what
/// passes (`VoiceRelay`). Each of LiveKit's candidates becomes a relay here, which carries the
/// media through the proxy: over UDP where the proxy grants an association, and over TCP. All of
/// it lives as long as the room, takes connections only from this device, and closes with it. As
/// `voice/proxy.rs` in the desktop app, which hands the SDK its own socket instead.
public final class CallProxy: @unchecked Sendable {
    /// What the SDK is given in place of LiveKit's address.
    public let url: String
    /// Whether the proxy carries UDP, so that LiveKit's UDP candidates get relays.
    public let udp: Bool

    let proxy: NetworkProxy
    /// LiveKit's address, as the server gave it.
    let target: String
    let secret: String
    let queue = DispatchQueue(label: "chat.zuna.call-proxy")
    /// Where relays' listeners say they're ready, which `relay(for:)` waits on from the rewriter's queue.
    private let listening = DispatchQueue(label: "chat.zuna.call-proxy.listening")
    let logger = Logger(subsystem: "chat.zuna", category: "call-proxy")
    private let listener: NWListener
    private let lock = NSLock()
    private var relays: [String: Relay] = [:]
    private var sockets: [ObjectIdentifier: SignalSocket] = [:]
    private var closed = false
    private var lastUDP: Date?
    private var lastTCP: Date?

    private init(proxy: NetworkProxy, target: String, udp: Bool, listener: NWListener, secret: String, port: UInt16) {
        self.proxy = proxy
        self.target = target
        self.udp = udp
        self.listener = listener
        self.secret = secret
        url = "ws://127.0.0.1:\(port)/\(secret)"
    }

    /// Opens the endpoint for a call to LiveKit at `target`, once it has asked the proxy whether
    /// it carries UDP. Throws when the proxy can't be had at all.
    public static func start(target: String, proxy: NetworkProxy) async throws -> CallProxy {
        let probe = DispatchQueue(label: "chat.zuna.call-proxy.probe")
        var udp = false
        do {
            let (control, _) = try await Socks.associate(proxy, queue: probe)
            control.cancel()
            udp = true
        } catch let failure as Socks.Failure where !failure.atProxy {
            udp = false
        }
        let listener = try loopbackListener(.tcp)
        let secret = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        // A listener takes its handler before it starts: until the call is made, nothing is taken.
        let made = WeakCall()
        listener.newConnectionHandler = { connection in
            guard let call = made.call else { return connection.cancel() }
            call.accept(connection)
        }
        let port = try await ready(listener)
        let call = CallProxy(proxy: proxy, target: target, udp: udp, listener: listener, secret: secret, port: port)
        made.call = call
        call.logger.info("A call goes through the proxy, \(udp ? "over UDP and TCP" : "over TCP only", privacy: .public)")
        return call
    }

    /// Closes the endpoint, every socket through it and every relay.
    public func close() {
        let (sockets, relays) = lock.withLock { () -> ([SignalSocket], [Relay]) in
            closed = true
            defer {
                self.sockets.removeAll()
                self.relays.removeAll()
            }
            return (Array(self.sockets.values), Array(self.relays.values))
        }
        listener.cancel()
        for socket in sockets { socket.close() }
        for relay in relays { relay.close() }
    }

    /// Which way the call's media is going, for the stream stats.
    public var way: String {
        lock.withLock {
            let now = Date()
            if let lastUDP, now.timeIntervalSince(lastUDP) < 5 { return "Through the proxy, over UDP" }
            if let lastTCP, now.timeIntervalSince(lastTCP) < 5 { return "Through the proxy, over TCP" }
            return "Through the proxy"
        }
    }

    func carried(udp: Bool) {
        lock.withLock {
            if udp { lastUDP = Date() } else { lastTCP = Date() }
        }
    }

    // MARK: The SDK's socket

    private func accept(_ connection: NWConnection) {
        guard case let .hostPort(host, _) = connection.endpoint, NetworkProxy.isThisDevice("\(host)") else {
            logger.warning("Refused a connection to a call's endpoint from somewhere else")
            return connection.cancel()
        }
        let socket = SignalSocket(call: self, local: connection)
        let kept = lock.withLock { () -> Bool in
            guard !closed else { return false }
            sockets[ObjectIdentifier(socket)] = socket
            return true
        }
        guard kept else { return connection.cancel() }
        socket.start()
    }

    func ended(_ socket: SignalSocket) {
        lock.withLock { _ = sockets.removeValue(forKey: ObjectIdentifier(socket)) }
    }

    // MARK: Relays

    /// The relay on loopback the SDK is to reach one of LiveKit's candidates at, made the first
    /// time it's asked for, or nil to leave the candidate out: a UDP one when the proxy carries no
    /// UDP, or one of a kind there's no relay for.
    func relay(for proto: String, address: String, port: UInt16) -> (address: String, port: UInt16)? {
        let kind = proto.lowercased()
        guard kind == "tcp" || (kind == "udp" && udp) else { return nil }
        let key = "\(kind) \(address) \(port)"
        if let relay = lock.withLock({ relays[key] }) { return ("127.0.0.1", relay.port) }
        guard let listener = try? Self.loopbackListener(kind == "udp" ? .udp : .tcp) else { return nil }
        let waited = DispatchSemaphore(value: 0)
        let bound = Locked<UInt16?>(nil)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                bound.value = listener.port?.rawValue
                waited.signal()
            case .failed, .cancelled:
                waited.signal()
            default:
                break
            }
        }
        let relay = Relay(call: self, listener: listener, udp: kind == "udp", target: (address, port))
        listener.newConnectionHandler = { [weak relay] connection in
            guard let relay else { return connection.cancel() }
            relay.accept(connection)
        }
        listener.start(queue: listening)
        guard waited.wait(timeout: .now() + 3) == .success, let loopback = bound.value else {
            listener.cancel()
            logger.error("A relay for a \(kind, privacy: .public) candidate didn't open")
            return nil
        }
        relay.port = loopback
        let kept = lock.withLock { () -> Bool in
            guard !closed else { return false }
            relays[key] = relay
            return true
        }
        guard kept else {
            relay.close()
            return nil
        }
        logger.debug("A \(kind, privacy: .public) relay on loopback port \(loopback) for one of LiveKit's candidates")
        return ("127.0.0.1", loopback)
    }

    // MARK: Listening

    enum Transport { case tcp, udp }

    /// A listener on 127.0.0.1 alone, at a port the system picks.
    static func loopbackListener(_ transport: Transport) throws -> NWListener {
        let parameters: NWParameters = transport == .tcp ? .tcp : .udp
        // Bound to loopback, so nothing off this device reaches it; what comes is checked to be from it too.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        return try NWListener(using: parameters)
    }

    private static func ready(_ listener: NWListener) async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            let once = Once()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.run { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case let .failed(error):
                    once.run { continuation.resume(throwing: error) }
                case .cancelled:
                    once.run { continuation.resume(throwing: Socks.Failure.unreachable("The call's endpoint closed.")) }
                default:
                    break
                }
            }
            listener.start(queue: DispatchQueue(label: "chat.zuna.call-proxy.endpoint"))
        }
    }
}

/// The call a listener hands its connections to, which it doesn't keep alive.
final class WeakCall: @unchecked Sendable {
    weak var call: CallProxy?
}

/// A value read and written from more than one queue.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

// MARK: - The SDK's socket, and the real one behind it

/// One WebSocket the SDK opened to the endpoint: its handshake read here, the real one opened
/// through the proxy, and each message rewritten on its way, in order.
final class SignalSocket: @unchecked Sendable {
    private weak var call: CallProxy?
    private let local: NWConnection
    private let queue: DispatchQueue
    private let logger: Logger
    private var upstream: NWConnection?
    private var buffer = Data()
    /// The SDK's request has been read, and answered or passed on.
    private var requested = false
    private var handshaken = false
    private var fragments: (opcode: UInt8, data: Data)?
    private var done = false

    private static let maximumRequest = 1 << 18
    private static let maximumMessage = 16 << 20

    init(call: CallProxy, local: NWConnection) {
        self.call = call
        self.local = local
        queue = call.queue
        logger = call.logger
    }

    func start() {
        local.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.close()
            default: break
            }
        }
        local.start(queue: queue)
        readLocal()
    }

    func close() {
        queue.async { [self] in
            guard !done else { return }
            done = true
            local.cancel()
            upstream?.cancel()
            call?.ended(self)
        }
    }

    private func readLocal() {
        local.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            guard let self, !done else { return }
            if let data { buffer.append(data) }
            if handshaken {
                readFrames()
            } else if !requested {
                readRequest()
            }
            if complete || error != nil {
                close()
            } else if !done {
                readLocal()
            }
        }
    }

    // MARK: The handshake

    private func readRequest() {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            if buffer.count > Self.maximumRequest { answer(431, "Request Header Fields Too Large") }
            return
        }
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        buffer.removeSubrange(..<end.upperBound)
        requested = true
        var lines = head.components(separatedBy: "\r\n")
        let start = lines.removeFirst().split(separator: " ")
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard let call, start.count >= 2, start[0] == "GET" else { return answer(400, "Bad Request") }
        let path = String(start[1])
        let prefix = "/\(call.secret)"
        // Nothing but the SDK on this device knows the secret, which keeps anything else from using the endpoint.
        guard path.hasPrefix(prefix + "/") || path.hasPrefix(prefix + "?") else {
            logger.warning("Refused a request to a call's endpoint without its secret")
            return answer(404, "Not Found")
        }
        let real = call.target.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path.dropFirst(prefix.count)
        if headers["upgrade"]?.lowercased() != "websocket" {
            return validate(real, authorization: headers["authorization"])
        }
        guard let key = headers["sec-websocket-key"] else { return answer(400, "Bad Request") }
        switch VoiceRelay.shared.joinAddress(real) {
        case let .success(address):
            open(address, key: key, authorization: headers["authorization"])
        case let .failure(why):
            logger.error("The address to join by couldn't be rewritten: \(why, privacy: .public)")
            answer(500, "Internal Server Error")
        }
    }

    /// The SDK checking why it couldn't connect: asked of LiveKit through the proxy, and answered as LiveKit answered.
    private func validate(_ address: String, authorization: String?) {
        guard let call, var components = URLComponents(string: address) else { return answer(400, "Bad Request") }
        components.scheme = components.scheme == "wss" ? "https" : "http"
        guard let url = components.url else { return answer(400, "Bad Request") }
        var request = URLRequest(url: url, timeoutInterval: 15)
        if let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        NetworkProxy.apply(call.proxy, to: configuration)
        let session = URLSession(configuration: configuration, delegate: PinnedServers.shared, delegateQueue: nil)
        session.dataTask(with: request) { [weak self] data, response, _ in
            session.finishTasksAndInvalidate()
            guard let self else { return }
            queue.async { [self] in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 502
                let body = data ?? Data()
                let head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status))\r\nContent-Type: text/plain\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                local.send(content: Data(head.utf8) + body, completion: .contentProcessed { [weak self] _ in self?.close() })
            }
        }.resume()
    }

    /// Answers the SDK's request with an error, and closes once it's sent.
    private func answer(_ status: Int, _ reason: String) {
        requested = true
        handshaken = false
        let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        local.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] _ in self?.close() })
    }

    /// Opens the real socket through the proxy, and answers the SDK's handshake once it's open.
    private func open(_ address: String, key: String, authorization: String?) {
        guard let call, let url = URL(string: address) else { return answer(400, "Bad Request") }
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.maximumMessageSize = Self.maximumMessage
        if let authorization { options.setAdditionalHeaders([(name: "Authorization", value: authorization)]) }
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 15
        let parameters = url.scheme == "wss"
            ? NWParameters(tls: PinnedServers.shared.tls(host: url.host ?? "", queue: queue), tcp: tcp)
            : NWParameters(tls: nil, tcp: tcp)
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        NetworkProxy.apply(call.proxy, to: parameters)
        let upstream = NWConnection(to: .url(url), using: parameters)
        self.upstream = upstream
        upstream.stateUpdateHandler = { [weak self, weak upstream] state in
            guard let self, let upstream, !done else { return }
            switch state {
            case .ready:
                let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
                let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
                local.send(content: Data(head.utf8), completion: .idempotent)
                handshaken = true
                readFrames()
                readUpstream(upstream)
            case let .waiting(error), let .failed(error):
                logger.warning("LiveKit couldn't be reached through the proxy: \(String(describing: error), privacy: .public)")
                if handshaken { close() } else { answer(502, "Bad Gateway") }
            case .cancelled:
                close()
            default:
                break
            }
        }
        upstream.start(queue: queue)
    }

    // MARK: From LiveKit

    private func readUpstream(_ upstream: NWConnection) {
        upstream.receiveMessage { [weak self] content, context, _, error in
            guard let self, !done else { return }
            if error != nil { return close() }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            switch metadata?.opcode {
            case .binary:
                guard let call else { return close() }
                switch VoiceRelay.shared.fromLiveKit(content ?? Data(), relayFor: { [weak call] in call?.relay(for: $0, address: $1, port: $2) }) {
                case let .success(message): writeFrame(2, message)
                case let .failure(why): logger.info("Dropped a message from LiveKit: \(why, privacy: .public)")
                }
            case .text:
                // LiveKit's protocol is binary: nothing it sends as text is read, so nothing passes unread.
                logger.warning("Dropped a message from LiveKit sent as text")
            case .close:
                writeFrame(8, Data([0x03, 0xe8]))
                return close()
            default:
                break
            }
            readUpstream(upstream)
        }
    }

    private func writeFrame(_ opcode: UInt8, _ payload: Data) {
        var frame = Data([0x80 | opcode])
        if payload.count < 126 {
            frame.append(UInt8(payload.count))
        } else if payload.count <= 0xffff {
            frame.append(126)
            frame.append(UInt8(payload.count >> 8))
            frame.append(UInt8(payload.count & 0xff))
        } else {
            frame.append(127)
            for shift in stride(from: 56, through: 0, by: -8) { frame.append(UInt8((UInt64(payload.count) >> UInt64(shift)) & 0xff)) }
        }
        frame.append(payload)
        local.send(content: frame, completion: .idempotent)
    }

    // MARK: From the SDK

    /// Reads whatever whole frames the SDK has sent: a client's, so masked.
    private func readFrames() {
        while !done {
            let bytes = [UInt8](buffer.prefix(14))
            guard bytes.count >= 2 else { return }
            let fin = bytes[0] & 0x80 != 0, opcode = bytes[0] & 0x0f, masked = bytes[1] & 0x80 != 0
            var length = Int(bytes[1] & 0x7f)
            var index = 2
            if length == 126 {
                guard bytes.count >= 4 else { return }
                length = Int(bytes[2]) << 8 | Int(bytes[3])
                index = 4
            } else if length == 127 {
                guard bytes.count >= 10 else { return }
                length = bytes[2..<10].reduce(0) { $0 << 8 | Int($1) }
                index = 10
            }
            guard masked, length <= Self.maximumMessage else { return close() }
            guard buffer.count >= index + 4 + length else { return }
            let mask = [UInt8](buffer[buffer.startIndex + index..<buffer.startIndex + index + 4])
            let start = buffer.startIndex + index + 4
            var payload = [UInt8](buffer[start..<start + length])
            for offset in payload.indices { payload[offset] ^= mask[offset & 3] }
            buffer.removeSubrange(..<(start + length))
            frame(fin: fin, opcode: opcode, payload: Data(payload))
        }
    }

    private func frame(fin: Bool, opcode: UInt8, payload: Data) {
        switch opcode {
        case 0:
            guard var pending = fragments else { return close() }
            pending.data.append(payload)
            guard pending.data.count <= Self.maximumMessage else { return close() }
            if fin {
                fragments = nil
                message(pending.opcode, pending.data)
            } else {
                fragments = pending
            }
        case 1, 2:
            if fin { message(opcode, payload) } else { fragments = (opcode, payload) }
        case 8:
            sendUpstream(.close, Data())
            writeFrame(8, payload.prefix(2))
            close()
        case 9:
            writeFrame(10, payload)
        default:
            break
        }
    }

    private func message(_ opcode: UInt8, _ data: Data) {
        guard opcode == 2 else {
            logger.warning("Dropped a message from the SDK sent as text")
            return
        }
        switch VoiceRelay.shared.toLiveKit(data) {
        case let .success(message): sendUpstream(.binary, message)
        case let .failure(why): logger.info("Dropped a message to LiveKit: \(why, privacy: .public)")
        }
    }

    private func sendUpstream(_ opcode: NWProtocolWebSocket.Opcode, _ data: Data) {
        guard let upstream else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
        if opcode == .close { metadata.closeCode = .protocolCode(.normalClosure) }
        let context = NWConnection.ContentContext(identifier: "message", metadata: [metadata])
        upstream.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
    }
}

// MARK: - Relays

/// A port on loopback standing for one of LiveKit's candidates, which carries what libwebrtc
/// sends it through the proxy to that candidate: each of libwebrtc's sockets in a UDP association
/// of its own, so answers find their way back, or each of its connections in a connection of its own.
final class Relay: @unchecked Sendable {
    private weak var call: CallProxy?
    private let listener: NWListener
    let udp: Bool
    /// The candidate's address and port, at LiveKit.
    private let target: (host: String, port: UInt16)
    /// Its own port on loopback, once it's listening.
    var port: UInt16 = 0
    private let lock = NSLock()
    private var flows: [Flow] = []
    private var closed = false

    init(call: CallProxy, listener: NWListener, udp: Bool, target: (host: String, port: UInt16)) {
        self.call = call
        self.listener = listener
        self.udp = udp
        self.target = target
    }

    func accept(_ connection: NWConnection) {
        guard let call, case let .hostPort(from, _) = connection.endpoint, NetworkProxy.isThisDevice("\(from)") else {
            return connection.cancel()
        }
        let flow: Flow = udp ? UDPFlow(call: call, local: connection, to: target) : TCPFlow(call: call, local: connection, to: target)
        let kept = lock.withLock { () -> Bool in
            guard !closed else { return false }
            flows.append(flow)
            return true
        }
        guard kept else { return connection.cancel() }
        flow.start()
    }

    func close() {
        let flows = lock.withLock { () -> [Flow] in
            closed = true
            defer { self.flows.removeAll() }
            return self.flows
        }
        listener.cancel()
        for flow in flows { flow.close() }
    }
}

protocol Flow: AnyObject {
    func start()
    func close()
}

/// One of libwebrtc's UDP sockets, carried in a UDP association of its own.
final class UDPFlow: Flow, @unchecked Sendable {
    private weak var call: CallProxy?
    private let local: NWConnection
    private let target: (host: String, port: UInt16)
    private let queue: DispatchQueue
    private var control: NWConnection?
    private var out: NWConnection?
    private var waiting: [Data] = []
    private var done = false

    init(call: CallProxy, local: NWConnection, to target: (host: String, port: UInt16)) {
        self.call = call
        self.local = local
        self.target = target
        queue = call.queue
    }

    func start() {
        local.start(queue: queue)
        readLocal()
        guard let call else { return close() }
        let proxy = call.proxy
        // Held until the proxy answers: a flow closed meanwhile lets the association go.
        Task { [self, queue] in
            do {
                let (control, relay) = try await Socks.associate(proxy, queue: queue)
                queue.async { self.associated(control, relay) }
            } catch {
                call.logger.warning("The proxy gave no UDP association: \(String(describing: error), privacy: .public)")
                close()
            }
        }
    }

    private func associated(_ control: NWConnection, _ relay: NWEndpoint) {
        guard !done else { return control.cancel() }
        self.control = control
        // The association ends when the connection that asked for it does.
        control.receive(minimumIncompleteLength: 1, maximumLength: 1) { [weak self] _, _, _, _ in self?.close() }
        let parameters = NWParameters.udp
        parameters.preferNoProxies = true
        let out = NWConnection(to: relay, using: parameters)
        self.out = out
        out.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                for datagram in waiting { send(datagram) }
                waiting.removeAll()
                readOut(out)
            case .failed, .cancelled:
                close()
            default:
                break
            }
        }
        out.start(queue: queue)
    }

    private func readLocal() {
        local.receiveMessage { [weak self] data, _, _, error in
            guard let self, !done else { return }
            if error != nil { return close() }
            if let data, !data.isEmpty {
                if out?.state == .ready { send(data) } else if waiting.count < 32 { waiting.append(data) }
            }
            readLocal()
        }
    }

    private func send(_ payload: Data) {
        guard let datagram = Socks.wrap(payload, to: target.host, port: target.port) else { return }
        out?.send(content: datagram, completion: .idempotent)
        call?.carried(udp: true)
    }

    private func readOut(_ out: NWConnection) {
        out.receiveMessage { [weak self] data, _, _, error in
            guard let self, !done else { return }
            if error != nil { return close() }
            // Only what came from the candidate this relay stands for goes back.
            if let data, let datagram = Socks.unwrap(data), PinnedServers.bare(datagram.host) == PinnedServers.bare(target.host) {
                local.send(content: datagram.payload, completion: .idempotent)
            }
            readOut(out)
        }
    }

    func close() {
        queue.async { [self] in
            guard !done else { return }
            done = true
            local.cancel()
            out?.cancel()
            control?.cancel()
        }
    }
}

/// One of libwebrtc's TCP connections, carried in a connection through the proxy of its own.
final class TCPFlow: Flow, @unchecked Sendable {
    private weak var call: CallProxy?
    private let local: NWConnection
    private let target: (host: String, port: UInt16)
    private let queue: DispatchQueue
    private var remote: NWConnection?
    private var done = false

    init(call: CallProxy, local: NWConnection, to target: (host: String, port: UInt16)) {
        self.call = call
        self.local = local
        self.target = target
        queue = call.queue
    }

    func start() {
        local.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.close()
            default: break
            }
        }
        local.start(queue: queue)
        guard let call else { return close() }
        let proxy = call.proxy, target = target
        Task { [self, queue] in
            do {
                let remote = try await Socks.connect(proxy, to: target.host, port: target.port, queue: queue)
                queue.async { self.connected(remote) }
            } catch {
                call.logger.warning("The proxy couldn't reach LiveKit over TCP: \(String(describing: error), privacy: .public)")
                close()
            }
        }
    }

    private func connected(_ remote: NWConnection) {
        guard !done else { return remote.cancel() }
        self.remote = remote
        remote.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.close()
            default: break
            }
        }
        pipe(from: local, to: remote)
        pipe(from: remote, to: local)
    }

    private func pipe(from source: NWConnection, to sink: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            guard let self, !done else { return }
            if let data, !data.isEmpty {
                call?.carried(udp: false)
                sink.send(content: data, completion: .contentProcessed { [weak self] error in
                    guard let self else { return }
                    if error != nil || complete { close() } else { pipe(from: source, to: sink) }
                })
            } else if complete || error != nil {
                close()
            } else {
                pipe(from: source, to: sink)
            }
        }
    }

    func close() {
        queue.async { [self] in
            guard !done else { return }
            done = true
            local.cancel()
            remote?.cancel()
        }
    }
}
