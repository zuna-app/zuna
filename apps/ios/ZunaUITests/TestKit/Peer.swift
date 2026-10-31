import Foundation

/// A desktop client in the test world (the desktop's core, run by the
/// orchestrator in Node), driven over the same RPC protocol as the app.
final class Peer: @unchecked Sendable {
    let name: String
    let account: World.Account
    private let socket: RPCSocket

    init(_ name: String) throws {
        self.name = name
        account = World.current[name]
        let url = URL(string: "\(World.current.peersUrl)/\(name)")!
        socket = try blocking { try await RPCSocket.connect(to: url) }
    }

    /// Calls a method of the peer's session whose result isn't needed. Arguments are JSON values.
    func call(_ method: String, _ arguments: [String]) throws {
        let socket = socket, serverId = account.serverId
        try blocking { _ = try await socket.call(method, server: serverId, arguments) }
    }

    func send(to userId: String, _ text: String) throws {
        let socket = socket, serverId = account.serverId
        try blocking { try await socket.call("sendMessage", server: serverId, ["user:\(userId)", ["text": text]]) }
    }

    func texts(with userId: String) throws -> [String] {
        let socket = socket, serverId = account.serverId
        return try blocking {
            let conversations = try await socket.call("getConversations", server: serverId) as? [[String: Any]] ?? []
            guard let groupId = conversations.first(where: { $0["key"] as? String == "user:\(userId)" })?["groupId"] as? String else { return [] }
            let page = try await socket.call("loadMessages", server: serverId, [groupId]) as? [String: Any]
            return (page?["messages"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
        }
    }
}

/// The test world itself, for what no single client can do.
enum WorldControl {
    /// Signs in to an account on another new device, as if on a new laptop.
    static func newDevice(for name: String, password: String) throws {
        let url = URL(string: "\(World.current.peersUrl)/world")!
        try blocking {
            let socket = try await RPCSocket.connect(to: url)
            _ = try await socket.call("newDevice", [name, password])
        }
    }
}
