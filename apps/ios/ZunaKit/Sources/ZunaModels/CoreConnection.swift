import Foundation
import os
import ZunaHost

/// An error the core reported for a call, like `CoreError` in rpc.ts.
public struct CoreCallError: Error, CustomStringConvertible, Sendable, Equatable {
    public let message: String
    public let code: String?
    public let status: Int?
    public var description: String { message }
}

/// A file on disk, passed to the core by path (a photo or document to send)
/// or returned by it (a downloaded attachment, decrypted into the cache).
public struct WireFile: Codable, Sendable, Equatable {
    public var path: String
    public var type: String

    public init(path: String, type: String) {
        self.path = path
        self.type = type
    }

    private enum Outer: String, CodingKey { case file = "$file" }
    private enum Inner: String, CodingKey { case path, type }

    public init(from decoder: Decoder) throws {
        let inner = try decoder.container(keyedBy: Outer.self).nestedContainer(keyedBy: Inner.self, forKey: .file)
        path = try inner.decode(String.self, forKey: .path)
        type = try inner.decodeIfPresent(String.self, forKey: .type) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var outer = encoder.container(keyedBy: Outer.self)
        var inner = outer.nestedContainer(keyedBy: Inner.self, forKey: .file)
        try inner.encode(path, forKey: .path)
        try inner.encode(type, forKey: .type)
    }
}

/// The Swift side of `connectCore` in packages/core/src/rpc.ts: async calls to
/// the client and its sessions, and a stream of `CoreEvent`s. Bytes travel as
/// `{"$bytes": base64}`, files as `{"$file": {...}}`, like the core bundle expects.
public final class CoreConnection: @unchecked Sendable {
    private var channel: CoreRuntime.Channel?
    private let lock = NSLock()
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var nextId = 1
    private let onEvent: @Sendable (CoreEvent) -> Void
    private let logger = Logger(subsystem: "chat.zuna", category: "rpc")
    private var drift: Set<String> = []

    public init(runtime: CoreRuntime, onEvent: @escaping @Sendable (CoreEvent) -> Void) {
        self.onEvent = onEvent
        channel = runtime.connect { [weak self] json in self?.receive(json) }
    }

    deinit {
        channel?.close()
    }

    /// Fields the core sent that the Swift models don't have. Always empty unless the core changed.
    public var driftReports: [String] {
        lock.withLock { drift.sorted() }
    }

    /// Calls a method on the client (`server` nil) or on a server's session.
    public func call<Value: Codable & Sendable>(_ method: String, server: String? = nil, _ arguments: [any Encodable & Sendable] = [], as type: Value.Type = Value.self) async throws -> Value {
        let data = try await send(method, server: server, arguments)
        let value: Value
        do {
            value = try Self.decoder.decode(Value.self, from: data)
        } catch {
            logger.error("Couldn't decode the result of \(method, privacy: .public): \(String(describing: error), privacy: .public)")
            throw error
        }
        #if DEBUG
        report(Drift.missing(in: data, decodedAs: value), from: method)
        #endif
        return value
    }

    /// Calls a method whose result isn't needed.
    public func call(_ method: String, server: String? = nil, _ arguments: [any Encodable & Sendable] = []) async throws {
        _ = try await send(method, server: server, arguments)
    }

    private func send(_ method: String, server: String?, _ arguments: [any Encodable & Sendable]) async throws -> Data {
        let encoded = try arguments.map { argument in
            String(decoding: try Self.encoder.encode(AnyEncodable(argument)), as: UTF8.self)
        }
        let id = lock.withLock {
            nextId += 1
            return nextId
        }
        let serverJSON = try server.map { String(decoding: try Self.encoder.encode($0), as: UTF8.self) } ?? "null"
        let methodJSON = String(decoding: try Self.encoder.encode(method), as: UTF8.self)
        let message = #"{"kind":"call","id":\#(id),"serverId":\#(serverJSON),"method":\#(methodJSON),"args":[\#(encoded.joined(separator: ","))]}"#
        return try await withCheckedThrowingContinuation { continuation in
            lock.withLock { pending[id] = continuation }
            channel?.send(message)
        }
    }

    private func receive(_ json: String) {
        guard let data = json.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch message["kind"] as? String {
        case "reply":
            guard let id = message["id"] as? Int, let continuation = lock.withLock({ pending.removeValue(forKey: id) }) else { return }
            if message["ok"] as? Bool == true {
                let value = message["value"] ?? NSNull()
                let valueData = (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("null".utf8)
                continuation.resume(returning: valueData)
            } else {
                let error = message["error"] as? [String: Any]
                continuation.resume(throwing: CoreCallError(
                    message: error?["message"] as? String ?? "Something went wrong.",
                    code: error?["code"] as? String,
                    status: error?["status"] as? Int
                ))
            }
        case "event":
            guard let event = message["event"],
                  let eventData = try? JSONSerialization.data(withJSONObject: event) else { return }
            do {
                let decoded = try Self.decoder.decode(CoreEvent.self, from: eventData)
                #if DEBUG
                report(Drift.missing(in: eventData, decodedAs: decoded), from: "event")
                #endif
                onEvent(decoded)
            } catch {
                logger.error("Couldn't decode an event: \(String(describing: error), privacy: .public)")
            }
        default:
            break
        }
    }

    private func report(_ missing: [String], from source: String) {
        guard !missing.isEmpty else { return }
        let new = lock.withLock { () -> [String] in
            let fresh = missing.map { "\(source): \($0)" }.filter { !drift.contains($0) }
            drift.formUnion(fresh)
            return fresh
        }
        for field in new {
            logger.error("The core sent a field the Swift models don't have: \(field, privacy: .public)")
        }
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dataEncodingStrategy = .custom { data, encoder in
            var container = encoder.container(keyedBy: BytesKey.self)
            try container.encode(data.base64EncodedString(), forKey: .bytes)
        }
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dataDecodingStrategy = .custom { decoder in
            let container = try decoder.container(keyedBy: BytesKey.self)
            let text = try container.decode(String.self, forKey: .bytes)
            guard let data = Data(base64Encoded: text) else {
                throw DecodingError.dataCorruptedError(forKey: .bytes, in: container, debugDescription: "Invalid base64")
            }
            return data
        }
        return decoder
    }()

    private enum BytesKey: String, CodingKey { case bytes = "$bytes" }
}

private struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
