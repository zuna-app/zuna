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
    /// Has the server wake this device through a push relay for new messages, or stops it with nil.
    public func setPush(_ push: PushSettings?) async throws { try await run("setPush", [push]) }

    // MARK: Groups

    /// Creates a group with these people, and returns its ID. With `historyVisible`, people added later can read earlier messages.
    public func createGroup(_ name: String, memberIds: [String], historyVisible: Bool) async throws -> String {
        try await call("createGroup", [name, memberIds, historyVisible])
    }

    public func addMembers(_ groupId: String, userIds: [String]) async throws { try await run("addMembers", [groupId, userIds]) }
    public func removeMember(_ groupId: String, userId: String) async throws { try await run("removeMember", [groupId, userId]) }
    public func leaveGroup(_ groupId: String) async throws { try await run("leaveGroup", [groupId]) }
    public func deleteGroup(_ groupId: String) async throws { try await run("deleteGroup", [groupId]) }
    public func setGroupRole(_ groupId: String, userId: String, role: GroupRole) async throws { try await run("setGroupRole", [groupId, userId, role]) }

    /// Changes a group's name or description, its picture, and whether new members see history; what's left out stays.
    public func updateGroupMeta(_ groupId: String, _ changes: GroupMetaChanges, avatar: AvatarChange = .unchanged, historyVisible: Bool? = nil) async throws {
        let avatarArgument: any Encodable & Sendable = switch avatar {
        case .unchanged: Absent()
        case .removed: Optional<WireFile>.none
        case let .set(file): file
        }
        let history: any Encodable & Sendable = historyVisible.map { $0 as any Encodable & Sendable } ?? Absent()
        try await run("updateGroupMeta", [groupId, changes, avatarArgument, history])
    }

    // MARK: Invites and verification

    public func invites() async throws -> [Invite] { try await call("invites") }

    /// Creates an invite link. 0 uses means no limit; 0 seconds means it doesn't expire.
    public func createInvite(maxUses: Int, expiresInSeconds: Int) async throws -> String { try await call("createInvite", [maxUses, expiresInSeconds]) }
    public func linkForInvite(_ code: String) async throws -> String { try await call("linkForInvite", [code]) }
    public func revokeInvite(_ code: String) async throws { try await run("revokeInvite", [code]) }

    /// The twelve emoji to compare with someone, from both people's keys.
    public func safetyCheck(_ userId: String) async throws -> SafetyCheck? { try await call("safetyCheck", [userId]) }
    public func markVerified(_ userId: String) async throws { try await run("markVerified", [userId]) }
    public func clearVerification(_ userId: String) async throws { try await run("clearVerification", [userId]) }

    // MARK: Profile and security

    /// Changes the profile's fields that are set, and its picture.
    public func updateProfile(_ changes: ProfileChanges, avatar: AvatarChange = .unchanged) async throws {
        let avatarArgument: any Encodable & Sendable = switch avatar {
        case .unchanged: Absent()
        case .removed: Optional<WireFile>.none
        case let .set(file): file
        }
        try await run("updateProfile", [changes, avatarArgument])
    }

    public func setHideLastSeen(_ hide: Bool) async throws { try await run("setHideLastSeen", [hide]) }
    public func revokeDevice(_ deviceId: String) async throws { try await run("revokeDevice", [deviceId]) }
    public func changePassword(current: String, next: String) async throws { try await run("changePassword", [current, next]) }
    /// A new recovery key; the old one stops working.
    public func regenerateRecoveryKey(password: String) async throws -> String { try await call("regenerateRecoveryKey", [password]) }

    // MARK: Server administration

    public func updateServerIcon(_ image: WireFile) async throws { try await run("updateServerIcon", [image]) }
    public func setEmoteSet(_ link: String) async throws -> EmoteSetChange { try await call("setEmoteSet", [link]) }
    public func setServerRole(_ userId: String, role: Role) async throws { try await run("setServerRole", [userId, role]) }
    public func banUser(_ userId: String) async throws { try await run("banUser", [userId]) }
    public func unbanUser(_ userId: String) async throws { try await run("unbanUser", [userId]) }

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

/// Where a server wakes this device for new messages (`PushSettings` in the core).
public struct PushSettings: Encodable, Sendable, Equatable {
    public var relay: String
    public var handle: String
    public var key: Data
    public var registration: String
    /// Tell the server which chats are muted, for an app that can't hide notifications itself.
    public var sendMuted: Bool

    public init(relay: String, handle: String, key: Data, registration: String, sendMuted: Bool) {
        self.relay = relay
        self.handle = handle
        self.key = key
        self.registration = registration
        self.sendMuted = sendMuted
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

/// A group's name and description; nil fields stay as they are.
public struct GroupMetaChanges: Codable, Sendable, Equatable {
    public var name: String?
    public var description: String?

    public init(name: String? = nil, description: String? = nil) {
        self.name = name
        self.description = description
    }
}

/// What happens to a picture: kept, removed, or replaced by a file.
public enum AvatarChange: Sendable {
    case unchanged
    case removed
    case set(WireFile)
}

/// An argument left out of a call, so the core sees `undefined` rather than null.
struct Absent: Encodable, Sendable {
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(true, forKey: .undefined)
    }

    private enum Key: String, CodingKey { case undefined = "$undefined" }
}

/// Profile fields to change; nil fields stay as they are.
public struct ProfileChanges: Codable, Sendable, Equatable {
    public var displayName: String?
    public var bio: String?

    public init(displayName: String? = nil, bio: String? = nil) {
        self.displayName = displayName
        self.bio = bio
    }
}

/// The emote set a server switched to.
public struct EmoteSetChange: Codable, Sendable, Equatable {
    public var setId: String
    public var setName: String
    public var count: Int

    enum CodingKeys: String, CodingKey {
        case count
        case setId = "set_id"
        case setName = "set_name"
    }
}
