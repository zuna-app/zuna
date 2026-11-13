import Foundation
import JavaScriptCore
import os

/// The rewriting of LiveKit's signalling while a proxy is set (packages/core/src/voice-relay.ts),
/// written once in the core for every app: here in a JavaScriptCore context of its own, on a queue
/// of its own, so that a busy core never holds a call's signalling up. As `host/relay.rs` in the
/// desktop app.
public final class VoiceRelay: @unchecked Sendable {
    /// Where the SDK is to reach one of LiveKit's candidates instead, given its protocol, address
    /// and port: a relay on this device, or nil to leave it out.
    public typealias RelayFor = (_ protocol: String, _ address: String, _ port: UInt16) -> (address: String, port: UInt16)?

    /// Why a message didn't go on: dropped by the rewriter, or the rewriter couldn't be run.
    public struct Dropped: Error, CustomStringConvertible, Equatable {
        public let reason: String
        public var description: String { reason }
        init(_ reason: String) { self.reason = reason }
    }

    public static let shared = VoiceRelay()

    private let queue = DispatchQueue(label: "chat.zuna.voice-relay", qos: .userInitiated)
    private let logger = Logger(subsystem: "chat.zuna", category: "voice-relay")
    private var context: JSContext?

    private init() {}

    private func loaded() -> JSContext? {
        if let context { return context }
        guard let url = Bundle.module.url(forResource: "zuna-relay", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext(virtualMachine: JSVirtualMachine()) else {
            logger.error("The relay's bundle is missing. Run apps/ios/core-bundle/build.mjs.")
            return nil
        }
        context.name = "Zuna voice relay"
        context.exceptionHandler = { [logger] _, exception in
            logger.error("The relay threw: \(exception?.toString() ?? "", privacy: .public)")
        }
        context.evaluateScript(source, withSourceURL: url)
        guard context.objectForKeyedSubscript("__zunaRelayFrom")?.isUndefined == false else {
            logger.error("The relay's bundle didn't load")
            return nil
        }
        self.context = context
        return context
    }

    /// The message as it goes on, or why it doesn't.
    private func answer(_ value: JSValue?, in context: JSContext) -> Result<Data, Dropped> {
        if let exception = context.exception {
            context.exception = nil
            return .failure(Dropped(exception.toString() ?? "the relay threw"))
        }
        guard let value else { return .failure(Dropped("the relay gave nothing back")) }
        if value.isString { return .failure(Dropped(value.toString() ?? "")) }
        return JSBytes.read(value).map { .success($0) } ?? .failure(Dropped("the relay gave nothing back"))
    }

    /// A message from LiveKit as its SDK is to see it: no STUN or TURN server, nowhere else to
    /// try, and each of LiveKit's candidates at the relay `relayFor` gives. Blocks the caller,
    /// which keeps a direction's messages in order.
    public func fromLiveKit(_ message: Data, relayFor: @escaping RelayFor) -> Result<Data, Dropped> {
        queue.sync {
            guard let context = loaded() else { return .failure(Dropped("the relay isn't there")) }
            let callback: @convention(block) (String, String, Double) -> Any = { proto, address, port in
                guard (0...65535).contains(port), let relay = relayFor(proto, address, UInt16(port)) else { return NSNull() }
                return [relay.address, Double(relay.port)] as NSArray
            }
            let rewrite = context.objectForKeyedSubscript("__zunaRelayFrom")
            let value = rewrite?.call(withArguments: [JSBytes.make(message, in: context), JSValue(object: callback, in: context) as Any])
            return answer(value, in: context)
        }
    }

    /// A message from the SDK as LiveKit is to see it: no candidate of this device's in it.
    public func toLiveKit(_ message: Data) -> Result<Data, Dropped> {
        queue.sync {
            guard let context = loaded() else { return .failure(Dropped("the relay isn't there")) }
            let value = context.objectForKeyedSubscript("__zunaRelayTo")?.call(withArguments: [JSBytes.make(message, in: context)])
            return answer(value, in: context)
        }
    }

    /// The address the SDK joins by, with no candidate in the join request it carries.
    public func joinAddress(_ url: String) -> Result<String, Dropped> {
        queue.sync {
            guard let context = loaded() else { return .failure(Dropped("the relay isn't there")) }
            let value = context.objectForKeyedSubscript("__zunaRelayJoin")?.call(withArguments: [url])
            if let exception = context.exception {
                context.exception = nil
                return .failure(Dropped(exception.toString() ?? "the relay threw"))
            }
            return value.flatMap { $0.isString ? $0.toString() : nil }.map { .success($0) } ?? .failure(Dropped("the relay gave nothing back"))
        }
    }
}
