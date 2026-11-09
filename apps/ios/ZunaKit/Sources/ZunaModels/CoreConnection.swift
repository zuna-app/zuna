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
    /// Where replies and events are read, one at a time in the order the core sent them, so
    /// that the core's thread only hands each over rather than waiting while it's parsed.
    private let inbox = DispatchQueue(label: "chat.zuna.rpc")

    public init(runtime: CoreRuntime, onEvent: @escaping @Sendable (CoreEvent) -> Void) {
        self.onEvent = onEvent
        channel = runtime.connect { [weak self] json in
            guard let self else { return }
            inbox.async { [weak self] in self?.receive(json) }
        }
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
            value = try Self.decoder.decode(Reply<Value>.self, from: data).value
        } catch {
            logger.error("Couldn't decode the result of \(method, privacy: .public): \(String(describing: error), privacy: .public)")
            throw error
        }
        #if DEBUG
        if let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let valueData = try? JSONSerialization.data(withJSONObject: reply["value"] ?? NSNull(), options: [.fragmentsAllowed]) {
            report(Drift.missing(in: valueData, decodedAs: value), from: method)
        }
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

    /// Reads what kind of message came, and hands a reply over whole, for `call` to decode
    /// its value from in one pass, or decodes an event, also in one pass. What kind it is
    /// comes from its first bytes where the core wrote them as it always does, as reading
    /// the envelope parses all of it: 2.2 ms for 530 conversations, and half of a small event.
    private func receive(_ json: String) {
        let data = Data(json.utf8)
        if let id = Self.succeededReply(data) {
            lock.withLock { pending.removeValue(forKey: id) }?.resume(returning: data)
            return
        }
        if data.starts(with: Self.eventStart) { return event(data) }
        guard let envelope = try? Self.decoder.decode(Envelope.self, from: data) else { return }
        switch envelope.kind {
        case "reply":
            guard let id = envelope.id, let continuation = lock.withLock({ pending.removeValue(forKey: id) }) else { return }
            if envelope.ok == true {
                continuation.resume(returning: data)
            } else {
                continuation.resume(throwing: CoreCallError(
                    message: envelope.error?.message ?? "Something went wrong.",
                    code: envelope.error?.code,
                    status: envelope.error?.status
                ))
            }
        case "event":
            event(data)
        default:
            break
        }
    }

    private func event(_ data: Data) {
        do {
            let decoded = try Self.decoder.decode(EventMessage.self, from: data).event
            #if DEBUG
            if let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let event = message["event"],
               let eventData = try? JSONSerialization.data(withJSONObject: event) {
                report(Drift.missing(in: eventData, decodedAs: decoded), from: "event")
            }
            #endif
            onEvent(decoded)
        } catch {
            logger.error("Couldn't decode an event: \(String(describing: error), privacy: .public)")
        }
    }

    private static let replyStart = Array(#"{"kind":"reply","id":"#.utf8)
    private static let succeeded = Array(#","ok":true"#.utf8)
    private static let eventStart = Array(#"{"kind":"event","#.utf8)

    /// The id of a reply that went well, read from the start rpc.ts gives it,
    /// `{"kind":"reply","id":7,"ok":true,...}`, or nil for anything else.
    static func succeededReply(_ data: Data) -> Int? {
        data.withUnsafeBytes { raw -> Int? in
            let bytes = raw.bindMemory(to: UInt8.self)
            guard bytes.starts(with: replyStart) else { return nil }
            var index = replyStart.count
            var id = 0
            while index < bytes.count, index - replyStart.count < 15, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) {
                id = id * 10 + Int(bytes[index] - UInt8(ascii: "0"))
                index += 1
            }
            let end = index + succeeded.count
            guard index > replyStart.count, end < bytes.count, bytes[index..<end].elementsEqual(succeeded),
                  bytes[end] == UInt8(ascii: ",") || bytes[end] == UInt8(ascii: "}") else { return nil }
            return id
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

/// What a message from the core is, read without its value or event.
private struct Envelope: Decodable {
    struct Failure: Decodable {
        let message: String?
        let code: String?
        let status: Int?

        private enum Key: String, CodingKey { case message, code, status }

        /// Each part only if it's there and of the kind expected, as an error may carry anything.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Key.self)
            message = try? container.decodeIfPresent(String.self, forKey: .message)
            code = try? container.decodeIfPresent(String.self, forKey: .code)
            status = try? container.decodeIfPresent(Int.self, forKey: .status)
        }
    }

    let kind: String
    let id: Int?
    let ok: Bool?
    let error: Failure?

    private enum Key: String, CodingKey { case kind, id, ok, error }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        kind = try container.decode(String.self, forKey: .kind)
        id = try? container.decodeIfPresent(Int.self, forKey: .id)
        ok = try? container.decodeIfPresent(Bool.self, forKey: .ok)
        error = try? container.decodeIfPresent(Failure.self, forKey: .error)
    }
}

/// A reply's value, decoded straight from the reply the core sent. A call with no result
/// has no value at all, which reads as null.
private struct Reply<Value: Decodable>: Decodable {
    let value: Value

    private enum Key: String, CodingKey { case value }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        if container.contains(.value) {
            value = try container.decode(Value.self, forKey: .value)
        } else {
            value = try CoreConnection.decoder.decode(Value.self, from: Data("null".utf8))
        }
    }
}

private struct EventMessage: Decodable {
    let event: CoreEvent
}

private struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
