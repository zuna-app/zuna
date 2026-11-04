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

    /// Calls a method of the peer's session. Arguments and the result are JSON
    /// values; they cross into the background task as JSON so nothing unsafe is shared.
    @discardableResult
    func call(_ method: String, _ arguments: [Any] = []) throws -> Any {
        let socket = socket, serverId = account.serverId
        let encoded = try JSONSerialization.data(withJSONObject: arguments)
        let result = try blocking {
            let arguments = try JSONSerialization.jsonObject(with: encoded) as? [Any] ?? []
            let value = try await socket.call(method, server: serverId, arguments)
            return try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        }
        return try JSONSerialization.jsonObject(with: result, options: .fragmentsAllowed)
    }

    /// Calls a method of the peer's client, outside any server, such as previewInvite.
    @discardableResult
    func callClient(_ method: String, _ arguments: [Any] = []) throws -> Any {
        let socket = socket
        let encoded = try JSONSerialization.data(withJSONObject: arguments)
        let result = try blocking {
            let arguments = try JSONSerialization.jsonObject(with: encoded) as? [Any] ?? []
            let value = try await socket.call(method, arguments)
            return try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        }
        return try JSONSerialization.jsonObject(with: result, options: .fragmentsAllowed)
    }

    /// Sends a message with any of the body's fields (text, emotes, mentions, replyTo), and returns its ID.
    @discardableResult
    func send(to key: String, _ body: [String: Any]) throws -> String {
        let message = try call("sendMessage", [key, body]) as? [String: Any]
        return message?["id"] as? String ?? ""
    }

    /// A message with the emotes in its text, as the desktop's composer records them.
    @discardableResult
    func sendWithEmotes(to key: String, _ text: String, mentions: [String] = []) throws -> String {
        let emotes = try call("emotesIn", [text])
        return try send(to: key, ["text": text, "emotes": emotes, "mentions": mentions])
    }

    /// Sends a picture with a caption, as the desktop does after picking a file.
    func sendImage(to key: String, png: Data, name: String, width: Int, height: Int, text: String = "") throws {
        let file: [String: Any] = [
            "blob": ["$blob": ["bytes": png.base64EncodedString(), "type": "image/png"]],
            "name": name,
            "mime": "image/png",
            "width": width,
            "height": height,
        ]
        try call("sendWithAttachments", [key, [file], ["text": text]])
    }

    /// Sets or removes this person's picture, as the desktop's profile settings do.
    func setPicture(_ png: Data?) throws {
        let blob: Any = png.map { ["$blob": ["bytes": $0.base64EncodedString(), "type": "image/png"]] } ?? NSNull()
        _ = try call("updateProfile", [png == nil ? ["avatar": NSNull()] : [:], blob])
    }

    func conversation(_ key: String) throws -> [String: Any]? {
        let conversations = try call("getConversations") as? [[String: Any]] ?? []
        return conversations.first { $0["key"] as? String == key }
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
    /// Shows the simulator's Face ID the enrolled face, or someone else's.
    static func faceId(match: Bool) throws {
        let url = URL(string: "\(World.current.peersUrl)/world")!
        try blocking {
            let socket = try await RPCSocket.connect(to: url)
            _ = try await socket.call("faceId", [match])
        }
    }

    /// Signs in to an account on another new device, as if on a new laptop.
    /// How many times the app registered with the test relay, and how many pushes (and of those, silent ones) it passed on.
    static func relayCounts() throws -> (registrations: Int, pushes: Int, silent: Int) {
        let url = URL(string: "\(World.current.peersUrl)/world")!
        let data = try blocking {
            let socket = try await RPCSocket.connect(to: url)
            return try JSONSerialization.data(withJSONObject: try await socket.call("relayCounts", []))
        }
        let counts = try JSONSerialization.jsonObject(with: data) as? [String: Int] ?? [:]
        return (counts["registrations"] ?? 0, counts["pushes"] ?? 0, counts["silent"] ?? 0)
    }

    /// A file as a peer decrypts it.
    static func download(_ name: String, _ attachment: [String: Any]) throws -> Data {
        let url = URL(string: "\(World.current.peersUrl)/world")!
        let encoded = try JSONSerialization.data(withJSONObject: attachment)
        let data = try blocking {
            let socket = try await RPCSocket.connect(to: url)
            return try JSONSerialization.data(withJSONObject: try await socket.call("download", [name, try JSONSerialization.jsonObject(with: encoded)]))
        }
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return Data(base64Encoded: value?["$bytes"] as? String ?? "") ?? Data()
    }

    /// The sounds from the soundboard a peer has heard someone play, by who and which.
    static func soundsHeard(_ name: String) throws -> [[String: String]] {
        let url = URL(string: "\(World.current.peersUrl)/world")!
        let data = try blocking {
            let socket = try await RPCSocket.connect(to: url)
            return try JSONSerialization.data(withJSONObject: try await socket.call("soundsHeard", [name]))
        }
        return try JSONSerialization.jsonObject(with: data) as? [[String: String]] ?? []
    }

    /// Delivers a push to the app, as APNs would.
    static func push(_ payload: [String: Any]) throws {
        let url = URL(string: "\(World.current.peersUrl)/world")!
        let encoded = try JSONSerialization.data(withJSONObject: payload)
        try blocking {
            let socket = try await RPCSocket.connect(to: url)
            _ = try await socket.call("push", [try JSONSerialization.jsonObject(with: encoded)])
        }
    }

    static func newDevice(for name: String, password: String) throws {
        let url = URL(string: "\(World.current.peersUrl)/world")!
        try blocking {
            let socket = try await RPCSocket.connect(to: url)
            _ = try await socket.call("newDevice", [name, password])
        }
    }
}
