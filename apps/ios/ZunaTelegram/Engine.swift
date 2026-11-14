import Foundation

/// TDLib's JSON interface (`td/telegram/td_json_client.h`), linked statically from what
/// `scripts/tdlib.mjs --ios` builds. This process runs one client.
final class Engine: @unchecked Sendable {
    private let client: Int32
    private let lock = NSLock()
    private var isClosed = false

    init() {
        client = td_create_client_id()
    }

    /// Whether TDLib has said it closed, after which this client does nothing more.
    var closed: Bool { lock.withLock { isClosed } }

    /// Sends a request, whose answer comes back with the same `@extra`. One with a NUL in it, which
    /// JSON escapes and TDLib couldn't read, goes nowhere.
    func send(_ json: String) {
        guard !json.utf8.contains(0) else { return }
        json.withCString { td_send(client, $0) }
    }

    func send(object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return }
        send(json)
    }

    /// Hands every answer and update to `deliver`, on a thread of its own, until TDLib closes,
    /// which `closed` is told of once that's been delivered.
    func receive(deliver: @escaping @Sendable (String) -> Void, closed: @escaping @Sendable () -> Void) {
        let thread = Thread { [self] in
            while !self.closed {
                // What td_receive returns lives until it's called again, so it's copied at once.
                guard let answer = td_receive(1.0) else { continue }
                let json = String(cString: answer)
                deliver(json)
                if Self.isClosing(json) {
                    lock.withLock { isClosed = true }
                    closed()
                }
            }
        }
        thread.name = "td-receive"
        thread.start()
    }

    /// Runs one of TDLib's synchronous requests, such as its log's settings.
    static func execute(_ json: String) -> String? {
        guard let answer = json.withCString({ td_execute($0) }) else { return nil }
        return String(cString: answer)
    }

    private static func isClosing(_ json: String) -> Bool {
        guard json.contains("\"authorizationStateClosed\""), let data = json.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["@type"] as? String == "updateAuthorizationState",
              let state = value["authorization_state"] as? [String: Any] else { return false }
        return state["@type"] as? String == "authorizationStateClosed"
    }
}
