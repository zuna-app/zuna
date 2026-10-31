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
