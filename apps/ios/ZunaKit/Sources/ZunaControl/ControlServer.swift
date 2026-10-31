import Foundation
import Network
import ZunaHost

/// Exposes a core over a WebSocket on the loopback interface, speaking the
/// same RPC messages as `packages/core/src/rpc.ts`. End-to-end tests use it to
/// drive the iOS client exactly as its UI does. Linked into test builds only.
public final class ControlServer: @unchecked Sendable {
    private let runtime: CoreRuntime
    private let queue = DispatchQueue(label: "chat.zuna.control")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: (NWConnection, CoreRuntime.Channel)] = [:]

    public init(runtime: CoreRuntime) {
        self.runtime = runtime
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
                    continuation.resume(returning: listener.port?.rawValue ?? port)
                case let .failed(error):
                    once.done = true
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        let channel = runtime.connect { [weak connection] json in
            guard let connection else { return }
            let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
            let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
            connection.send(content: Data(json.utf8), contentContext: context, isComplete: true, completion: .idempotent)
        }
        connections[key] = (connection, channel)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.drop(key)
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(on: connection, key: key, channel: channel)
    }

    private func receive(on connection: NWConnection, key: ObjectIdentifier, channel: CoreRuntime.Channel) {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if error != nil || metadata?.opcode == .close {
                connection.cancel()
                drop(key)
                return
            }
            if metadata?.opcode == .text, let content, let json = String(data: content, encoding: .utf8) {
                if json.hasPrefix("{\"kind\":\"host\"") {
                    handleHostCommand(json, from: connection)
                } else {
                    channel.send(json)
                }
            }
            receive(on: connection, key: key, channel: channel)
        }
    }

    /// Commands for the host itself rather than the core, such as going offline.
    private func handleHostCommand(_ json: String, from connection: NWConnection) {
        guard let data = json.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch command["command"] as? String {
        case "offline":
            runtime.setOffline((command["value"] as? Bool) ?? true)
        case "exit":
            exit(Int32((command["code"] as? Int) ?? 0))
        case "evaluate":
            #if DEBUG
            let id = command["id"] as? Int ?? 0
            runtime.evaluateForTesting(command["script"] as? String ?? "") { value in
                let reply = ["kind": "host-result", "id": id, "value": value] as [String: Any]
                guard let body = try? JSONSerialization.data(withJSONObject: reply) else { return }
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
                connection.send(content: body, contentContext: context, isComplete: true, completion: .idempotent)
            }
            #endif
        default:
            break
        }
    }

    private func drop(_ key: ObjectIdentifier) {
        connections.removeValue(forKey: key)?.1.close()
    }
}
