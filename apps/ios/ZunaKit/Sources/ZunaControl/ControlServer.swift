import Foundation
import Network
import os
import ZunaHost

/// Exposes a core over a WebSocket on the loopback interface, speaking the
/// same RPC messages as `packages/core/src/rpc.ts`. End-to-end tests use it to
/// drive the iOS client exactly as its UI does. Linked into test builds only.
///
/// It can start before the core does, so tests can also drive the app while
/// it's locked: messages for the core wait until `attach(_:)`, and host
/// commands (`{"kind": "host", ...}`) go to `commandHandler`.
public final class ControlServer: @unchecked Sendable {
    /// Handles a host command the server doesn't know itself, returning the
    /// reply's value. Runs off the main thread.
    public var commandHandler: (@Sendable ([String: Any]) async -> Any?)?

    private var runtime: CoreRuntime?
    private let queue = DispatchQueue(label: "chat.zuna.control")
    private let logger = Logger(subsystem: "chat.zuna", category: "control")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: Client] = [:]

    private final class Client {
        let connection: NWConnection
        var channel: CoreRuntime.Channel?
        var waiting: [String] = []

        init(connection: NWConnection) {
            self.connection = connection
        }
    }

    public init(runtime: CoreRuntime? = nil) {
        self.runtime = runtime
    }

    /// Connects the core once it's running; messages that waited for it go through.
    public func attach(_ runtime: CoreRuntime) {
        queue.async { [self] in
            self.runtime = runtime
            for client in connections.values { open(client) }
        }
    }

    /// Starts listening and returns the port. Pass 0 for any free port.
    public func start(port: UInt16) async throws -> UInt16 {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.maximumMessageSize = 64 << 20
        let parameters = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        return try await withCheckedThrowingContinuation { continuation in
            // The handler only ever runs on `queue`, one call at a time.
            final class Once: @unchecked Sendable { var done = false }
            let once = Once()
            listener.stateUpdateHandler = { state in
                guard !once.done else { return }
                switch state {
                case .ready:
                    once.done = true
                    self.logger.info("Control server listening on \(listener.port?.rawValue ?? port)")
                    continuation.resume(returning: listener.port?.rawValue ?? port)
                case let .failed(error):
                    once.done = true
                    self.logger.error("Control server failed: \(String(describing: error), privacy: .public)")
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        logger.info("Control connection from \(String(describing: connection.endpoint), privacy: .public)")
        let key = ObjectIdentifier(connection)
        let client = Client(connection: connection)
        connections[key] = client
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.drop(key)
            default:
                break
            }
        }
        connection.start(queue: queue)
        if runtime != nil { open(client) }
        receive(on: client, key: key)
    }

    private func open(_ client: Client) {
        guard client.channel == nil, let runtime else { return }
        let channel = runtime.connect { [weak connection = client.connection] json in
            guard let connection else { return }
            Self.send(json, on: connection)
        }
        client.channel = channel
        for json in client.waiting { channel.send(json) }
        client.waiting.removeAll()
    }

    private func receive(on client: Client, key: ObjectIdentifier) {
        client.connection.receiveMessage { [weak self] content, context, _, error in
            guard let self else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if error != nil || metadata?.opcode == .close {
                client.connection.cancel()
                drop(key)
                return
            }
            if metadata?.opcode == .text, let content, let json = String(data: content, encoding: .utf8) {
                // JSON objects have no key order, so look at "kind" properly.
                let object = try? JSONSerialization.jsonObject(with: content) as? [String: Any]
                if let object, object["kind"] as? String == "host" {
                    handleHostCommand(object, from: client.connection)
                } else if let channel = client.channel {
                    channel.send(json)
                } else {
                    client.waiting.append(json)
                }
            }
            receive(on: client, key: key)
        }
    }

    /// Commands for the host itself rather than the core, such as going offline.
    private func handleHostCommand(_ command: [String: Any], from connection: NWConnection) {
        let id = command["id"] as? Int
        let reply = { (value: Any?) in
            guard let id else { return }
            let message: [String: Any] = ["kind": "host-result", "id": id, "value": value ?? NSNull()]
            guard let body = try? JSONSerialization.data(withJSONObject: message), let text = String(data: body, encoding: .utf8) else { return }
            Self.send(text, on: connection)
        }
        switch command["command"] as? String {
        case "offline":
            runtime?.setOffline((command["value"] as? Bool) ?? true)
            reply(true)
        case "exit":
            exit(Int32((command["code"] as? Int) ?? 0))
        case "crashOn":
            #if DEBUG
            runtime?.crashOnResponse(method: command["method"] as? String ?? "POST", urlPattern: command["url"] as? String ?? "$^")
            #endif
            reply(true)
        case "evaluate":
            #if DEBUG
            guard let runtime else { return reply("Error: the core isn't running") }
            runtime.evaluateForTesting(command["script"] as? String ?? "") { value in reply(value) }
            #else
            reply(NSNull())
            #endif
        default:
            guard let handler = commandHandler else { return reply(NSNull()) }
            Task { reply(await handler(command)) }
        }
    }

    private static func send(_ text: String, on connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .idempotent)
    }

    private func drop(_ key: ObjectIdentifier) {
        connections.removeValue(forKey: key)?.channel?.close()
    }
}
