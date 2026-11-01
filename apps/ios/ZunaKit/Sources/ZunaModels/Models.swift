// Swift mirrors of packages/core/src/types.ts, the shapes the core hands to
// the UI. Field names match the JSON exactly. In Debug builds CoreConnection
// checks every payload against these, so a field added to the core can't go
// unnoticed (see Drift.swift).

import Foundation

public enum Role: String, Codable, Sendable { case owner, admin, member }
public enum GroupRole: String, Codable, Sendable { case admin, member }
public enum GroupKind: String, Codable, Sendable { case dm, group }
public enum TrustState: String, Codable, Sendable { case unverified, verified, changed }
public enum ConnectionState: String, Codable, Sendable { case connecting, syncing, online, offline }
public enum MessageStatus: String, Codable, Sendable { case sending, sent, failed, undecryptable, unverified, invalid }

/// A list that keeps what it can: one row that can't be decoded doesn't lose the
/// rest. The core checks everything first, so this is the second line of defence.
public struct LossyList<Element: Codable & Sendable>: Codable, Sendable {
    public var items: [Element]

    private struct Skipped: Decodable {
        init(from decoder: Decoder) {}
    }

    public init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var items: [Element] = []
        while !container.isAtEnd {
            if let item = try? container.decode(Element.self) {
                items.append(item)
            } else {
                _ = try? container.decode(Skipped.self)
            }
        }
        self.items = items
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(contentsOf: items)
    }
}

public struct ServerInfo: Codable, Sendable, Hashable {
    public var name: String
    public var version: String
    public var hasIcon: Bool
    public var claimed: Bool
    public var registration: String
    public var maxUploadMb: Int
    public var allowMemberInvites: Bool
    public var retentionDays: Int
    public var emoteSetId: String
    public var emoteSetName: String
    public var userCount: Int
    public var communityKey: String?
    public var accountProtocol: Int?

    enum CodingKeys: String, CodingKey {
        case name, version, claimed, registration
        case hasIcon = "has_icon"
        case maxUploadMb = "max_upload_mb"
        case allowMemberInvites = "allow_member_invites"
        case retentionDays = "retention_days"
        case emoteSetId = "emote_set_id"
        case emoteSetName = "emote_set_name"
        case userCount = "user_count"
        case accountProtocol = "account_protocol"
        case communityKey = "community_key"
    }
}

public struct InvitePreview: Codable, Sendable, Hashable {
    public var url: String
    public var code: String
    public var communityKey: String?
    public var setup: Bool
    public var server: ServerInfo
}

public struct Invite: Codable, Sendable, Equatable {
    public var code: String
    public var createdBy: String
    public var grantsRole: String
    public var maxUses: Int
    public var uses: Int
    public var expiresAt: Int?
    public var createdAt: Int

    enum CodingKeys: String, CodingKey {
        case code, uses
        case createdBy = "created_by"
        case grantsRole = "grants_role"
        case maxUses = "max_uses"
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }
}

public struct AvatarRef: Codable, Sendable, Equatable, Hashable {
    public var fileId: String
    public var key: String
    public var prefix: String
    public var chunks: Int
    public var mime: String
}

public struct Profile: Codable, Sendable, Equatable {
    public var displayName: String
    public var bio: String?
    public var avatar: AvatarRef?

    public init(displayName: String, bio: String? = nil, avatar: AvatarRef? = nil) {
        self.displayName = displayName
        self.bio = bio
        self.avatar = avatar
    }
}

public struct UserView: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var username: String
    public var role: Role
    public var displayName: String
    public var bio: String
    public var avatar: AvatarRef?
    public var online: Bool
    public var lastSeenAt: Int?
    public var hidesLastSeen: Bool
    public var banned: Bool
    public var trust: TrustState
    public var isSelf: Bool
}

public struct Attachment: Codable, Sendable, Equatable, Hashable {
    public var fileId: String
    public var key: String
    public var prefix: String
    public var chunks: Int
    public var name: String
    public var mime: String
    public var size: Int
    public var width: Double?
    public var height: Double?
    /// Tiny inline preview shown while the full image loads (data URL).
    public var thumb: String?
    public var duration: Double?
    /// Recorded in the app, so it plays as a voice message.
    public var voice: Bool?
    /// A voice message's loudness over time: one byte (0 to 255) per bar, base64.
    public var waveform: String?
}

public struct EmoteRef: Codable, Sendable, Equatable, Hashable {
    public var id: String
    public var animated: Bool?
    public var zeroWidth: Bool?
    public var owner: String?

    public init(id: String, animated: Bool? = nil, zeroWidth: Bool? = nil, owner: String? = nil) {
        self.id = id
        self.animated = animated
        self.zeroWidth = zeroWidth
        self.owner = owner
    }
}

/// What the UI sends. Mirrors `MessageBody`.
public struct MessageBody: Codable, Sendable, Equatable {
    public var text: String?
    public var replyTo: String?
    public var emotes: [String: EmoteRef]?
    public var attachments: [Attachment]?
    public var mentions: [String]?
    public var preview: LinkPreview?

    public init(text: String? = nil, replyTo: String? = nil, emotes: [String: EmoteRef]? = nil, attachments: [Attachment]? = nil, mentions: [String]? = nil, preview: LinkPreview? = nil) {
        self.text = text
        self.replyTo = replyTo
        self.emotes = emotes
        self.attachments = attachments
        self.mentions = mentions
        self.preview = preview
    }
}

/// How a message is sent: `previewUrl` is a link whose preview isn't ready yet. Mirrors the core's send options.
public struct SendOptions: Codable, Sendable, Equatable {
    public var previewUrl: String?

    public init(previewUrl: String? = nil) {
        self.previewUrl = previewUrl
    }
}

/// A link's preview, made by the sender's device and sent inside the message. Mirrors `LinkPreview`.
public struct LinkPreview: Codable, Sendable, Equatable, Hashable {
    public struct Image: Codable, Sendable, Equatable, Hashable {
        /// A small JPEG, as a data URL.
        public var data: String
        public var width: Double
        public var height: Double
    }

    /// The link as it appears in the message's text.
    public var url: String
    public var title: String?
    public var description: String?
    public var siteName: String?
    public var image: Image?
}

/// Marks a forwarded message: whose it was on the same server, or nobody named when it came from another server.
public struct ForwardInfo: Codable, Sendable, Equatable, Hashable {
    public var userId: String?
}

public struct ReactionView: Codable, Sendable, Equatable, Hashable {
    /// The unicode emoji, or an emote's name.
    public var key: String
    public var emote: EmoteRef?
    public var userIds: [String]
}

public struct SystemEvent: Codable, Sendable, Equatable, Hashable {
    public enum Kind: String, Codable, Sendable {
        case memberAdded = "member_added"
        case memberRemoved = "member_removed"
        case memberLeft = "member_left"
        case memberRejoined = "member_rejoined"
        case deviceAdded = "device_added"
        case unexpectedJoin = "unexpected_join"
        case identityChanged = "identity_changed"
        case identityRotated = "identity_rotated"
        case groupCreated = "group_created"
    }

    public var type: Kind
    public var actorId: String?
    public var targetIds: [String]?
}

public struct ReplyPreview: Codable, Sendable, Equatable, Hashable {
    public var id: String
    public var senderId: String
    public var text: String
    public var hasAttachment: Bool
    public var deleted: Bool
}

public struct MessageView: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var groupId: String
    public var seq: Int?
    public var senderId: String
    public var createdAt: Int
    public var editedAt: Int?
    public var deletedAt: Int?
    public var pinnedAt: Int?
    public var pinnedBy: String?
    public var status: MessageStatus
    public var text: String
    public var emotes: [String: EmoteRef]
    public var attachments: [Attachment]
    public var mentions: [String]
    public var reply: ReplyPreview?
    public var reactions: [ReactionView]
    public var system: SystemEvent?
    public var preview: LinkPreview?
    public var forwarded: ForwardInfo?
    public var uploadProgress: Double?
    /// The time the sender's device signed is far from the server's.
    public var timeDiffers: Bool?
}

public struct GroupMemberView: Codable, Sendable, Equatable, Hashable {
    public var userId: String
    public var role: GroupRole
    public var joinedAt: Int
    /// The server says they're a member, but no device of theirs holds this group's keys.
    public var noKeys: Bool?
    /// A device of theirs holds this group's keys, but the server doesn't list them.
    public var notOnRoster: Bool?
}

/// One row of the conversation list: a group, or a person even before the first message.
public struct ConversationView: Codable, Sendable, Equatable, Identifiable {
    /// `user:<id>` or `group:<id>`.
    public var key: String
    public var kind: GroupKind
    public var groupId: String?
    public var peerId: String?
    public var title: String
    public var avatar: AvatarRef?
    public var description: String
    public var lastMessage: MessageView?
    public var lastActivityAt: Int
    public var unread: Int
    public var mentioned: Bool
    public var pinned: Bool
    public var muted: Bool
    /// When a chat muted for a while is heard again (ms), or nil.
    public var mutedUntil: Double?
    public var hidden: Bool
    public var members: [GroupMemberView]
    public var historyVisible: Bool
    public var readBy: [String: Int]
    public var ownRead: Int
    public var ready: Bool
    /// You're no longer in this conversation. Its messages stay until you clear them, or for a while.
    public var removed: Bool

    public var id: String { key }
}

public struct Emote: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var animated: Bool
    public var zeroWidth: Bool
    public var width: Int
    public var height: Int
    public var owner: String

    enum CodingKeys: String, CodingKey {
        case id, name, animated, width, height, owner
        case zeroWidth = "zero_width"
    }
}

public struct EmoteSet: Codable, Sendable, Equatable {
    public var setId: String
    public var setName: String
    public var emotes: [Emote]

    enum CodingKeys: String, CodingKey {
        case emotes
        case setId = "set_id"
        case setName = "set_name"
    }
}

public struct Preferences: Codable, Sendable, Equatable {
    public var pinned: [String]
    public var hidden: [String]
    public var muted: [String]
    /// Chats muted for a while: conversation key -> when it ends (ms).
    public var mutedUntil: [String: Double]?
    public var sendReadReceipts: Bool
}

public struct DeviceView: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var createdAt: Int
    public var lastSeenAt: Int
    public var isCurrent: Bool
    public var name: String
}

public struct SearchResult: Codable, Sendable, Equatable {
    public var message: MessageView
    public var conversationKey: String
}

public struct ServerEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var url: String
    public var name: String
    public var hasIcon: Bool
    public var username: String
    public var userId: String
    public var role: Role
    /// The server ended this device's session, and why. What's on this device stays until you decide.
    public var signedOut: String?
}

public struct SafetyCheck: Codable, Sendable, Equatable {
    public struct Item: Codable, Sendable, Equatable {
        public var emoji: String
        public var name: String
    }

    public var emoji: [Item]
    public var trust: TrustState
    /// What those emoji cover, to hand back to `markVerified` if they match.
    public var covers: String
}

/// `getSelf()`.
public struct SelfInfo: Codable, Sendable, Equatable {
    public var userId: String
    public var username: String
    public var role: Role
    public var deviceId: String
}

/// `loadMessages()`: one page, newest last.
public struct MessagePage: Codable, Sendable, Equatable {
    public var messages: [MessageView]
    public var hasMore: Bool

    private enum CodingKeys: String, CodingKey { case messages, hasMore }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messages = try container.decode(LossyList<MessageView>.self, forKey: .messages).items
        hasMore = try container.decode(Bool.self, forKey: .hasMore)
    }
}

/// `register()`.
public struct Registration: Codable, Sendable, Equatable {
    public var serverId: String
    /// Shown once. It's the only way back in if the password is forgotten.
    public var recoveryKey: String
}

public struct SearchCoverage: Codable, Sendable, Equatable {
    public var done: Int
    public var total: Int
}

/// Everything the core pushes to the UI. Mirrors `CoreEvent`.
public enum CoreEvent: Sendable, Equatable {
    case connection(serverId: String, state: ConnectionState)
    case conversations(serverId: String)
    case message(serverId: String, message: MessageView, isNew: Bool)
    case messageRemoved(serverId: String, groupId: String, id: String)
    case messageMoved(serverId: String, fromGroupId: String, message: MessageView)
    case users(serverId: String)
    case presence(serverId: String, userId: String, online: Bool, lastSeenAt: Int?)
    case typing(serverId: String, groupId: String, userId: String)
    case read(serverId: String, groupId: String, userId: String, seq: Int)
    case settings(serverId: String, info: ServerInfo)
    case emotes(serverId: String)
    case preferences(serverId: String)
    case signedOut(serverId: String, reason: String)
    /// A session that seemed to be over is working after all.
    case signedIn(serverId: String)
    case security(serverId: String, userId: String, message: String)
    case notify(serverId: String, title: String, body: String, conversationKey: String, groupId: String, messageId: String)
    /// Whether the person is using another of their devices, where notifications go instead.
    case activity(serverId: String, elsewhere: Bool)
}

extension CoreEvent {
    /// The server the event is about.
    public var serverId: String {
        switch self {
        case let .connection(serverId, _), let .conversations(serverId), let .message(serverId, _, _),
             let .messageRemoved(serverId, _, _), let .messageMoved(serverId, _, _), let .users(serverId),
             let .presence(serverId, _, _, _), let .typing(serverId, _, _), let .read(serverId, _, _, _),
             let .settings(serverId, _), let .emotes(serverId), let .preferences(serverId),
             let .signedOut(serverId, _), let .signedIn(serverId), let .security(serverId, _, _), let .notify(serverId, _, _, _, _, _),
             let .activity(serverId, _):
            serverId
        }
    }

    public var isSignedOut: Bool {
        if case .signedOut = self { true } else { false }
    }
}

extension CoreEvent: Codable {
    private enum Keys: String, CodingKey {
        case type, serverId, state, message, isNew, groupId, id, fromGroupId, userId, online, lastSeenAt, seq, info, reason, title, body, conversationKey, elsewhere, messageId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let serverId = try c.decode(String.self, forKey: .serverId)
        switch try c.decode(String.self, forKey: .type) {
        case "connection": self = .connection(serverId: serverId, state: try c.decode(ConnectionState.self, forKey: .state))
        case "conversations": self = .conversations(serverId: serverId)
        case "message": self = .message(serverId: serverId, message: try c.decode(MessageView.self, forKey: .message), isNew: try c.decode(Bool.self, forKey: .isNew))
        case "message_removed": self = .messageRemoved(serverId: serverId, groupId: try c.decode(String.self, forKey: .groupId), id: try c.decode(String.self, forKey: .id))
        case "message_moved": self = .messageMoved(serverId: serverId, fromGroupId: try c.decode(String.self, forKey: .fromGroupId), message: try c.decode(MessageView.self, forKey: .message))
        case "users": self = .users(serverId: serverId)
        case "presence": self = .presence(serverId: serverId, userId: try c.decode(String.self, forKey: .userId), online: try c.decode(Bool.self, forKey: .online), lastSeenAt: try c.decodeIfPresent(Int.self, forKey: .lastSeenAt))
        case "typing": self = .typing(serverId: serverId, groupId: try c.decode(String.self, forKey: .groupId), userId: try c.decode(String.self, forKey: .userId))
        case "read": self = .read(serverId: serverId, groupId: try c.decode(String.self, forKey: .groupId), userId: try c.decode(String.self, forKey: .userId), seq: try c.decode(Int.self, forKey: .seq))
        case "settings": self = .settings(serverId: serverId, info: try c.decode(ServerInfo.self, forKey: .info))
        case "emotes": self = .emotes(serverId: serverId)
        case "preferences": self = .preferences(serverId: serverId)
        case "signed_out": self = .signedOut(serverId: serverId, reason: try c.decode(String.self, forKey: .reason))
        case "signed_in": self = .signedIn(serverId: serverId)
        case "security": self = .security(serverId: serverId, userId: try c.decode(String.self, forKey: .userId), message: try c.decode(String.self, forKey: .message))
        case "notify":
            self = .notify(
                serverId: serverId,
                title: try c.decode(String.self, forKey: .title),
                body: try c.decode(String.self, forKey: .body),
                conversationKey: try c.decode(String.self, forKey: .conversationKey),
                groupId: try c.decode(String.self, forKey: .groupId),
                messageId: try c.decode(String.self, forKey: .messageId)
            )
        case "activity": self = .activity(serverId: serverId, elsewhere: try c.decode(Bool.self, forKey: .elsewhere))
        case let other: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown core event \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .connection(serverId, state):
            try c.encode("connection", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(state, forKey: .state)
        case let .conversations(serverId):
            try c.encode("conversations", forKey: .type); try c.encode(serverId, forKey: .serverId)
        case let .message(serverId, message, isNew):
            try c.encode("message", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(message, forKey: .message); try c.encode(isNew, forKey: .isNew)
        case let .messageRemoved(serverId, groupId, id):
            try c.encode("message_removed", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(groupId, forKey: .groupId); try c.encode(id, forKey: .id)
        case let .messageMoved(serverId, fromGroupId, message):
            try c.encode("message_moved", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(fromGroupId, forKey: .fromGroupId); try c.encode(message, forKey: .message)
        case let .users(serverId):
            try c.encode("users", forKey: .type); try c.encode(serverId, forKey: .serverId)
        case let .presence(serverId, userId, online, lastSeenAt):
            try c.encode("presence", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(userId, forKey: .userId); try c.encode(online, forKey: .online); try c.encodeIfPresent(lastSeenAt, forKey: .lastSeenAt)
        case let .typing(serverId, groupId, userId):
            try c.encode("typing", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(groupId, forKey: .groupId); try c.encode(userId, forKey: .userId)
        case let .read(serverId, groupId, userId, seq):
            try c.encode("read", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(groupId, forKey: .groupId); try c.encode(userId, forKey: .userId); try c.encode(seq, forKey: .seq)
        case let .settings(serverId, info):
            try c.encode("settings", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(info, forKey: .info)
        case let .emotes(serverId):
            try c.encode("emotes", forKey: .type); try c.encode(serverId, forKey: .serverId)
        case let .preferences(serverId):
            try c.encode("preferences", forKey: .type); try c.encode(serverId, forKey: .serverId)
        case let .signedOut(serverId, reason):
            try c.encode("signed_out", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(reason, forKey: .reason)
        case let .signedIn(serverId):
            try c.encode("signed_in", forKey: .type); try c.encode(serverId, forKey: .serverId)
        case let .security(serverId, userId, message):
            try c.encode("security", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(userId, forKey: .userId); try c.encode(message, forKey: .message)
        case let .notify(serverId, title, body, conversationKey, groupId, messageId):
            try c.encode("notify", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(title, forKey: .title); try c.encode(body, forKey: .body); try c.encode(conversationKey, forKey: .conversationKey)
            try c.encode(groupId, forKey: .groupId); try c.encode(messageId, forKey: .messageId)
        case let .activity(serverId, elsewhere):
            try c.encode("activity", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(elsewhere, forKey: .elsewhere)
        }
    }
}
