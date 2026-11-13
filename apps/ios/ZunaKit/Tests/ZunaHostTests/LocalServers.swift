import Foundation
import Network
@testable import ZunaHost

/// Waits for `condition` to hold, checking every few milliseconds, and says whether it did in time.
func eventually(within seconds: Double = 5, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

/// Starts a listener on loopback and gives its port once it's ready.
func listen(_ parameters: NWParameters, queue: DispatchQueue, handler: @escaping @Sendable (NWConnection) -> Void) async throws -> NWListener {
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let listener = try NWListener(using: parameters)
    listener.newConnectionHandler = handler
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let once = Once()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: once.run { continuation.resume() }
            case let .failed(error): once.run { continuation.resume(throwing: error) }
            default: break
            }
        }
        listener.start(queue: queue)
    }
    return listener
}

/// A request as `LocalHTTP` read it.
struct HTTPRequest: Sendable {
    var method: String
    var path: String
    var headers: [String: String]
    var body: Data
}

/// What `LocalHTTP` answers, or nil to hold the connection open and answer nothing.
struct HTTPResponse: Sendable {
    var status: Int = 200
    var headers: [String: String] = [:]
    var body = Data()
}

/// An HTTP/1.1 server on loopback that answers each request with what `respond` says, and
/// remembers every request it read.
final class LocalHTTP: @unchecked Sendable {
    private var listener: NWListener!
    private let queue = DispatchQueue(label: "local-http")
    private let respond: @Sendable (HTTPRequest) -> HTTPResponse?
    private let seen = Locked<[HTTPRequest]>([])
    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var base: String { "http://127.0.0.1:\(port)" }
    var requests: [HTTPRequest] { seen.value }

    private init(respond: @escaping @Sendable (HTTPRequest) -> HTTPResponse?) {
        self.respond = respond
    }

    static func start(_ respond: @escaping @Sendable (HTTPRequest) -> HTTPResponse?) async throws -> LocalHTTP {
        let server = LocalHTTP(respond: respond)
        server.listener = try await listen(.tcp, queue: server.queue) { [weak server] connection in
            guard let server else { return connection.cancel() }
            connection.start(queue: server.queue)
            server.read(connection, Data())
        }
        return server
    }

    func stop() { listener.cancel() }

    private func read(_ connection: NWConnection, _ buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                let start = head[0].split(separator: " ")
                var headers: [String: String] = [:]
                for line in head.dropFirst() {
                    guard let colon = line.firstIndex(of: ":") else { continue }
                    headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                let length = Int(headers["content-length"] ?? "0") ?? 0
                let body = buffer[end.upperBound...]
                if body.count >= length {
                    let request = HTTPRequest(method: String(start[0]), path: String(start[1]), headers: headers, body: Data(body.prefix(length)))
                    seen.value.append(request)
                    guard let response = respond(request) else { return }
                    var text = "HTTP/1.1 \(response.status) \(HTTPURLResponse.localizedString(forStatusCode: response.status))\r\n"
                    for (name, value) in response.headers { text += "\(name): \(value)\r\n" }
                    text += "Content-Length: \(response.body.count)\r\nConnection: close\r\n\r\n"
                    connection.send(content: Data(text.utf8) + response.body, completion: .contentProcessed { _ in connection.cancel() })
                    return
                }
            }
            if complete || error != nil { return connection.cancel() }
            read(connection, buffer)
        }
    }
}

/// A WebSocket server on loopback that echoes text, and closes with the code a message names
/// ("close 4001"), or with nothing at all ("drop").
final class LocalWebSocket: @unchecked Sendable {
    private var listener: NWListener!
    private let queue = DispatchQueue(label: "local-websocket")
    private let received = Locked<[String]>([])
    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var url: String { "ws://127.0.0.1:\(port)/socket" }
    var messages: [String] { received.value }

    static func start() async throws -> LocalWebSocket {
        let server = LocalWebSocket()
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        server.listener = try await listen(parameters, queue: server.queue) { [weak server] connection in
            guard let server else { return connection.cancel() }
            connection.start(queue: server.queue)
            server.read(connection)
        }
        return server
    }

    func stop() { listener.cancel() }

    private func read(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self, error == nil else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            guard metadata?.opcode == .text else {
                if metadata?.opcode == .close { connection.cancel() } else { read(connection) }
                return
            }
            let text = String(decoding: content ?? Data(), as: UTF8.self)
            received.value.append(text)
            if text == "drop" { return connection.forceCancel() }
            if text.hasPrefix("close "), let code = UInt16(text.dropFirst(6)) {
                let close = NWProtocolWebSocket.Metadata(opcode: .close)
                close.closeCode = code == 1001 ? .protocolCode(.goingAway) : .privateCode(code)
                let context = NWConnection.ContentContext(identifier: "close", metadata: [close])
                connection.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
                return
            }
            let reply = NWProtocolWebSocket.Metadata(opcode: .text)
            connection.send(content: Data("echo: \(text)".utf8), contentContext: NWConnection.ContentContext(identifier: "text", metadata: [reply]),
                            isComplete: true, completion: .contentProcessed { _ in })
            read(connection)
        }
    }
}

/// A port nothing listens on: one a listener had, closed again.
func closedPort() async throws -> UInt16 {
    let listener = try await listen(.tcp, queue: DispatchQueue(label: "closed-port")) { $0.cancel() }
    let port = listener.port?.rawValue ?? 1
    listener.cancel()
    try await Task.sleep(for: .milliseconds(100))
    return port
}
