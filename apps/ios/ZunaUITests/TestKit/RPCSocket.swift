import Foundation

struct RPCError: LocalizedError, CustomStringConvertible {
    let description: String
    var errorDescription: String? { description }
}

/// The core's RPC protocol (packages/core/src/rpc.ts) over a WebSocket, from
/// the test side. It talks to the app's control channel and to the peers.
final class RPCSocket: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let lock = NSLock()
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var nextId = 0

    private init(url: URL) {
        task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = 64 << 20
        task.resume()
        receive()
    }

    /// Connects, retrying while the other side is still starting.
    static func connect(to url: URL, timeout: TimeInterval = 30) async throws -> RPCSocket {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let socket = RPCSocket(url: url)
            do {
                try await socket.ping()
                return socket
            } catch {
                socket.task.cancel()
                if Date() > deadline { throw RPCError(description: "Couldn't connect to \(url): \(error)") }
                try await Task.sleep(for: .milliseconds(200))
            }
        }
    }

    /// A ping that gives up after a few seconds: a socket that never finishes
    /// its handshake would otherwise never answer.
    private func ping() async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    self.task.sendPing { error in
                        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                    }
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(3))
                throw RPCError(description: "no answer to a ping")
            }
            defer { group.cancelAll() }
            try await group.next()
        }
    }

    /// Calls a client method (`server` nil) or a session method, returning the JSON result.
    @discardableResult
    func call(_ method: String, server: String? = nil, _ arguments: [Any] = []) async throws -> Any {
        try await request(["kind": "call", "serverId": server ?? NSNull(), "method": method, "args": arguments])
    }

    /// A command for the host or the app rather than the core, such as "state".
    @discardableResult
    func host(_ command: String, _ fields: [String: Any] = [:]) async throws -> Any {
        try await request(fields.merging(["kind": "host", "command": command]) { _, new in new })
    }

    private func request(_ message: [String: Any]) async throws -> Any {
        let id = lock.withLock {
            nextId += 1
            return nextId
        }
        var message = message
        message["id"] = id
        let text = String(decoding: try JSONSerialization.data(withJSONObject: message), as: UTF8.self)
        let data = try await withCheckedThrowingContinuation { continuation in
            lock.withLock { pending[id] = continuation }
            task.send(.string(text)) { [weak self] error in
                if let error { self?.fail(id, error) }
            }
        }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    private func fail(_ id: Int, _ error: Error) {
        lock.withLock { pending.removeValue(forKey: id) }?.resume(throwing: error)
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(.string(text)):
                handle(text)
                receive()
            case .success:
                receive()
            case let .failure(error):
                let waiting = lock.withLock { () -> [CheckedContinuation<Data, Error>] in
                    defer { self.pending.removeAll() }
                    return Array(self.pending.values)
                }
                waiting.forEach { $0.resume(throwing: error) }
            }
        }
    }

    private func handle(_ text: String) {
        guard let message = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let kind = message["kind"] as? String, kind == "reply" || kind == "host-result",
              let id = message["id"] as? Int,
              let continuation = lock.withLock({ pending.removeValue(forKey: id) }) else { return }
        if kind == "reply", message["ok"] as? Bool != true {
            let error = message["error"] as? [String: Any]
            continuation.resume(throwing: RPCError(description: error?["message"] as? String ?? "The call failed"))
            return
        }
        let value = message["value"] ?? NSNull()
        continuation.resume(returning: (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("null".utf8))
    }
}
