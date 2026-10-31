import Foundation

// Typed calls for the methods of ZunaClient and ServerSession in packages/core.
// The names and arguments match the TypeScript exactly; the core's RPC calls
// them by name.

extension CoreConnection {
    // MARK: Client

    public func listServers() async throws -> [ServerEntry] { try await call("listServers") }
    public func previewInvite(_ link: String) async throws -> InvitePreview { try await call("previewInvite", [link]) }
    public func serverInfo(url: String) async throws -> ServerInfo { try await call("serverInfo", [url]) }

    public func register(_ invite: InvitePreview, username: String, password: String, profile: Profile) async throws -> Registration {
        try await call("register", [invite, username, password, profile])
    }

    public func login(url: String, username: String, password: String) async throws -> String {
        try await call("login", [url, username, password])
    }

    public func recover(url: String, username: String, recoveryKey: String, newPassword: String) async throws -> String {
        try await call("recover", [url, username, recoveryKey, newPassword])
    }

    public func reorderServers(_ ids: [String]) async throws { try await call("reorderServers", [ids]) }
    public func leaveServer(_ serverId: String) async throws { try await call("leaveServer", [serverId]) }
    public func nudge() async throws { try await call("nudge") }
    /// Closes every connection while the app is in the background.
    public func suspend() async throws { try await call("suspend") }
    /// Reconnects after `suspend()` and catches up.
    public func resume() async throws { try await call("resume") }

    public func session(_ serverId: String) -> SessionCalls { SessionCalls(connection: self, serverId: serverId) }
}

/// Calls on one server's session.
public struct SessionCalls: Sendable {
    let connection: CoreConnection
    public let serverId: String

    private func call<Value: Codable & Sendable>(_ method: String, _ arguments: [any Encodable & Sendable] = []) async throws -> Value {
        try await connection.call(method, server: serverId, arguments)
    }

    private func run(_ method: String, _ arguments: [any Encodable & Sendable] = []) async throws {
        try await connection.call(method, server: serverId, arguments)
    }

    // MARK: State

    public func getConnectionState() async throws -> ConnectionState { try await call("getConnectionState") }
    public func getSelf() async throws -> SelfInfo { try await call("getSelf") }
    public func getInfo() async throws -> ServerInfo? { try await call("getInfo") }
    public func getUsers() async throws -> [UserView] { try await call("getUsers") }
    public func getConversations() async throws -> [ConversationView] { try await call("getConversations") }
    public func getPreferences() async throws -> Preferences { try await call("getPreferences") }
    /// Changes only the lists that are set, so another device's change to the others isn't undone.
    public func updatePreferences(_ changes: PreferenceChanges) async throws { try await run("updatePreferences", [changes]) }
    public func getEmotes() async throws -> EmoteSet { try await call("getEmotes") }
    public func getDevices() async throws -> [DeviceView] { try await call("getDevices") }

    // MARK: Messages

    public func loadMessages(_ groupId: String, before: Int? = nil) async throws -> MessagePage {
        try await call("loadMessages", before.map { [groupId, $0] } ?? [groupId])
    }

    public func loadAround(_ groupId: String, seq: Int) async throws -> [MessageView] { try await call("loadAround", [groupId, seq]) }
    public func messageById(_ groupId: String, id: String) async throws -> MessageView? { try await call("messageById", [groupId, id]) }
    public func loadPins(_ groupId: String) async throws -> [MessageView] { try await call("loadPins", [groupId]) }
    public func search(_ query: String, groupId: String? = nil, limit: Int = 50) async throws -> [SearchResult] {
        try await call("search", groupId.map { [query, $0, limit] } ?? [query, String?.none, limit])
    }
    public func searchCoverage() async throws -> SearchCoverage { try await call("searchCoverage") }

    @discardableResult
    public func sendMessage(_ conversationKey: String, _ body: MessageBody) async throws -> MessageView {
        try await call("sendMessage", [conversationKey, body])
    }

    /// Uploads the files, encrypted, then sends the message. Progress shows on the local echo.
    public func sendWithAttachments(_ conversationKey: String, files: [OutgoingFile], body: MessageBody) async throws {
        try await run("sendWithAttachments", [conversationKey, files, body])
    }

    public func emotesIn(_ text: String) async throws -> [String: EmoteRef] { try await call("emotesIn", [text]) }

    public func retryMessage(_ groupId: String, id: String) async throws { try await run("retryMessage", [groupId, id]) }
    public func discardMessage(_ groupId: String, id: String) async throws { try await run("discardMessage", [groupId, id]) }
    public func editMessage(_ groupId: String, id: String, text: String, emotes: [String: EmoteRef], mentions: [String]) async throws {
        try await run("editMessage", [groupId, id, text, emotes, mentions])
    }
    public func deleteMessage(_ groupId: String, id: String) async throws { try await run("deleteMessage", [groupId, id]) }
    public func setPinned(_ groupId: String, id: String, pinned: Bool) async throws { try await run("setPinned", [groupId, id, pinned]) }
    public func toggleReaction(_ groupId: String, messageId: String, key: String, emote: EmoteRef? = nil) async throws {
        try await run("toggleReaction", emote.map { [groupId, messageId, key, $0] } ?? [groupId, messageId, key])
    }
    public func sendTyping(_ groupId: String) async throws { try await run("sendTyping", [groupId]) }
    public func markRead(_ groupId: String, seq: Int) async throws { try await run("markRead", [groupId, seq]) }

    // MARK: Server administration

    /// Changes only the fields that are set.
    public func updateServerSettings(_ changes: ServerSettingsChanges) async throws { try await run("updateServerSettings", [changes]) }

    // MARK: Files

    /// Decrypts an attachment or avatar into the app's protected cache.
    public func downloadFile(_ attachment: Attachment) async throws -> WireFile { try await call("downloadFile", [attachment]) }
    public func downloadFile(_ avatar: AvatarRef) async throws -> WireFile { try await call("downloadFile", [avatar]) }
}

/// Server settings an admin can change, named as the server's API names them.
public struct ServerSettingsChanges: Codable, Sendable, Equatable {
    public var name: String?
    public var registration: String?
    public var allowMemberInvites: Bool?
    public var maxUploadMb: Int?
    public var retentionDays: Int?

    public init(name: String? = nil, registration: String? = nil, allowMemberInvites: Bool? = nil, maxUploadMb: Int? = nil, retentionDays: Int? = nil) {
        self.name = name
        self.registration = registration
        self.allowMemberInvites = allowMemberInvites
        self.maxUploadMb = maxUploadMb
        self.retentionDays = retentionDays
    }

    enum CodingKeys: String, CodingKey {
        case name, registration
        case allowMemberInvites = "allow_member_invites"
        case maxUploadMb = "max_upload_mb"
        case retentionDays = "retention_days"
    }
}

/// Part of `Preferences`, for `updatePreferences`.
public struct PreferenceChanges: Codable, Sendable, Equatable {
    public var pinned: [String]?
    public var hidden: [String]?
    public var muted: [String]?
    public var sendReadReceipts: Bool?

    public init(pinned: [String]? = nil, hidden: [String]? = nil, muted: [String]? = nil, sendReadReceipts: Bool? = nil) {
        self.pinned = pinned
        self.hidden = hidden
        self.muted = muted
        self.sendReadReceipts = sendReadReceipts
    }
}

/// A file to send: on disk, with what a message records about it.
public struct OutgoingFile: Codable, Sendable, Equatable {
    public var blob: WireFile
    public var name: String
    public var mime: String
    public var width: Int?
    public var height: Int?
    /// A tiny preview as a JPEG data URL, shown blurred until the picture is decrypted.
    public var thumb: String?
    public var duration: Double?

    public init(blob: WireFile, name: String, mime: String, width: Int? = nil, height: Int? = nil, thumb: String? = nil, duration: Double? = nil) {
        self.blob = blob
        self.name = name
        self.mime = mime
        self.width = width
        self.height = height
        self.thumb = thumb
        self.duration = duration
    }
}
