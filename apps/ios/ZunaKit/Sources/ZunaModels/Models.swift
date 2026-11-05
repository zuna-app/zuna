// Swift mirrors of packages/core/src/types.ts, the shapes the core hands to
// the UI. Field names match the JSON exactly. In Debug builds CoreConnection
// checks every payload against these, so a field added to the core can't go
// unnoticed (see Drift.swift).

import Foundation

public enum Role: String, Codable, Sendable { case owner, admin, member }
public enum GroupRole: String, Codable, Sendable { case admin, member }
public enum GroupKind: String, Codable, Sendable { case dm, group, channel }
public enum ChannelType: String, Codable, Sendable { case text, voice }
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
    /// Whether this server has a media server, without which voice channels can't be joined.
    public var voice: Int?
    /// Whether direct messages and groups can have calls there.
    public var calls: Int?
    /// What its admins say about sharing a screen.
    public var screenShare: ScreenRules?

    enum CodingKeys: String, CodingKey {
        case name, version, claimed, registration, voice, calls
        case hasIcon = "has_icon"
        case maxUploadMb = "max_upload_mb"
        case allowMemberInvites = "allow_member_invites"
        case retentionDays = "retention_days"
        case emoteSetId = "emote_set_id"
        case emoteSetName = "emote_set_name"
        case userCount = "user_count"
        case communityKey = "community_key"
        case screenShare = "screen_share"
    }
}

/// What a server's admins say about sharing a screen. Mirrors `ScreenRules`.
public struct ScreenRules: Codable, Sendable, Hashable {
    public var who: String
    public var sound: Bool
    public var adminsExempt: Bool
    public var maxPerChannel: Int
    public var maxPerServer: Int
    public var maxHeight: Int
    public var maxFps: Int
    public var maxKbps: Int
    public var maxSoundKbps: Int
    public var defaultHeight: Int
    public var defaultFps: Int
    public var defaultKbps: Int

    public init(who: String, sound: Bool, adminsExempt: Bool, maxPerChannel: Int, maxPerServer: Int, maxHeight: Int, maxFps: Int, maxKbps: Int, maxSoundKbps: Int, defaultHeight: Int, defaultFps: Int, defaultKbps: Int) {
        self.who = who
        self.sound = sound
        self.adminsExempt = adminsExempt
        self.maxPerChannel = maxPerChannel
        self.maxPerServer = maxPerServer
        self.maxHeight = maxHeight
        self.maxFps = maxFps
        self.maxKbps = maxKbps
        self.maxSoundKbps = maxSoundKbps
        self.defaultHeight = defaultHeight
        self.defaultFps = defaultFps
        self.defaultKbps = defaultKbps
    }

    /// What a server's rules come to before its admins have said anything. Mirrors `DEFAULT_SCREEN_RULES`.
    public static let defaults = ScreenRules(who: "everyone", sound: true, adminsExempt: false, maxPerChannel: 0, maxPerServer: 0, maxHeight: 0, maxFps: 0, maxKbps: 0, maxSoundKbps: 0, defaultHeight: 0, defaultFps: 60, defaultKbps: 20_000)

    enum CodingKeys: String, CodingKey {
        case who, sound
        case adminsExempt = "admins_exempt"
        case maxPerChannel = "max_per_channel"
        case maxPerServer = "max_per_server"
        case maxHeight = "max_height"
        case maxFps = "max_fps"
        case maxKbps = "max_kbps"
        case maxSoundKbps = "max_sound_kbps"
        case defaultHeight = "default_height"
        case defaultFps = "default_fps"
        case defaultKbps = "default_kbps"
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
    /// A video message recorded in the app: square, shown in a circle, playing by itself without sound.
    public var round: Bool?
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

/// Where someone's device said they were when they shared it. Mirrors `SharedLocation`.
public struct SharedLocation: Codable, Sendable, Equatable, Hashable {
    /// Degrees north, from -90 to 90.
    public var lat: Double
    /// Degrees east, from -180 to 180.
    public var lon: Double
    /// How far off it may be, in meters, as the device said.
    public var accuracy: Double?

    public init(lat: Double, lon: Double, accuracy: Double? = nil) {
        self.lat = lat
        self.lon = lon
        self.accuracy = accuracy
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
    public var location: SharedLocation?

    public init(text: String? = nil, replyTo: String? = nil, emotes: [String: EmoteRef]? = nil, attachments: [Attachment]? = nil, mentions: [String]? = nil, preview: LinkPreview? = nil, location: SharedLocation? = nil) {
        self.text = text
        self.replyTo = replyTo
        self.emotes = emotes
        self.attachments = attachments
        self.mentions = mentions
        self.preview = preview
        self.location = location
    }
}

/// How a message is sent: `previewUrl` is a link whose preview isn't ready yet, and
/// `keepMetadata` sends files with their metadata. Mirrors the core's send options.
public struct SendOptions: Codable, Sendable, Equatable {
    public var previewUrl: String?
    public var keepMetadata: Bool?

    public init(previewUrl: String? = nil, keepMetadata: Bool? = nil) {
        self.previewUrl = previewUrl
        self.keepMetadata = keepMetadata
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
        case timerChanged = "timer_changed"
    }

    public var type: Kind
    public var actorId: String?
    public var targetIds: [String]?
    /// For `timerChanged`: how long messages now last, in seconds, or 0 for as long as they're kept.
    public var seconds: Int?
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
    public var location: SharedLocation?
    public var uploadProgress: Double?
    /// The time the sender's device signed is far from the server's.
    public var timeDiffers: Bool?
    /// When it disappears from this device (ms), or nil if it doesn't.
    public var expiresAt: Int?
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
    /// Whether any of those mention you or reply to you.
    public var mentioned: Bool
    /// How many unread messages in a group mention you or reply to you, and haven't been jumped to. Always 0 in a direct message.
    public var unreadMentions: Int
    public var pinned: Bool
    public var muted: Bool
    /// When a chat muted for a while is heard again (ms), or nil.
    public var mutedUntil: Double?
    public var hidden: Bool
    /// Marked as unread by hand, as in Telegram, until it's opened.
    public var markedUnread: Bool
    /// Notifies only about messages that mention you or reply to you, though its unread messages still count.
    public var mentionsOnly: Bool
    /// A direct message with someone you blocked.
    public var blocked: Bool
    public var members: [GroupMemberView]
    public var historyVisible: Bool
    public var readBy: [String: Int]
    public var ownRead: Int
    public var ready: Bool
    /// You're no longer in this conversation. Its messages stay until you clear them, or for a while.
    public var removed: Bool
    /// How long messages sent here now last, in seconds, or 0 if they don't disappear.
    public var disappearAfter: Int
    /// In a channel with slow mode: how long each person waits between messages, in seconds, or 0.
    public var slowMode: Int
    /// When slow mode lets you send here again (ms), or 0 if it does now. Always 0 for the channel's admins, whom it doesn't hold back.
    public var slowUntil: Double

    public var id: String { key }
}

/// A channel anyone on the server can see and join. Mirrors `ChannelView`.
public struct ChannelView: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var type: ChannelType
    /// `group:<id>`, as a conversation's key.
    public var key: String
    /// What it's called, or empty if what the server gave couldn't be read or checked.
    public var name: String
    public var topic: String
    /// The heading it goes under, or empty for the usual one.
    public var category: String
    /// For a voice channel: how good its audio is, in kbit/s, or 0 for the usual.
    public var bitrate: Int
    public var position: Int
    /// For a voice channel: how many people fit, or 0 for no limit.
    public var userLimit: Int
    /// For a voice channel: how many may share a screen at once, 0 for what the server's rules say, or -1 for nobody.
    public var screenLimit: Int
    /// For a voice channel: whether the soundboard plays there.
    public var sounds: Bool
    /// Slow mode: how long each person waits between messages, in seconds, or 0 for off. It doesn't hold back the channel's admins.
    public var slowMode: Int
    /// The details couldn't be read or checked, so they aren't shown.
    public var unreadable: Bool
    /// Nil until this device has joined it, which it does by itself.
    public var conversation: ConversationView?
}

/// A sound on the server's soundboard. Mirrors `SoundView`.
public struct SoundView: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// An emoji to show with it, or empty.
    public var emoji: String
    public var durationMs: Int

    public init(id: String, name: String, emoji: String, durationMs: Int) {
        self.id = id
        self.name = name
        self.emoji = emoji
        self.durationMs = durationMs
    }
}

/// What changes about a sound, for `updateSound`; nil fields stay as they are.
public struct SoundChanges: Codable, Sendable, Equatable {
    public var name: String?
    public var emoji: String?

    public init(name: String? = nil, emoji: String? = nil) {
        self.name = name
        self.emoji = emoji
    }
}

/// Someone's device in a voice channel, as it says. Mirrors `VoiceMember`.
public struct VoiceMember: Codable, Sendable, Equatable {
    /// The voice channel, or the conversation whose call it is.
    public var channelId: String
    public var userId: String
    public var deviceId: String
    public var muted: Bool
    public var deafened: Bool
    /// Muted by an admin, which LiveKit itself enforces.
    public var serverMuted: Bool
    public var camera: Bool
    public var screen: Bool
    /// When they came in (ms).
    public var since: Int

    public init(channelId: String, userId: String, deviceId: String, muted: Bool, deafened: Bool, serverMuted: Bool, camera: Bool, screen: Bool, since: Int) {
        self.channelId = channelId
        self.userId = userId
        self.deviceId = deviceId
        self.muted = muted
        self.deafened = deafened
        self.serverMuted = serverMuted
        self.camera = camera
        self.screen = screen
        self.since = since
    }
}

/// A call in a direct message or a group, from when someone comes into it until the last one
/// leaves. Who's in it are the voice members with its conversation's group ID.
public struct CallView: Codable, Sendable, Equatable {
    public var groupId: String
    public var startedBy: String
    /// When it started (ms).
    public var startedAt: Int
    /// People whose devices it's ringing, until they answer or decline, or a while passes.
    public var ringing: [String]
    /// People who declined it.
    public var declined: [String]

    public init(groupId: String, startedBy: String, startedAt: Int, ringing: [String], declined: [String]) {
        self.groupId = groupId
        self.startedBy = startedBy
        self.startedAt = startedAt
        self.ringing = ringing
        self.declined = declined
    }
}

/// What this device is doing in a voice channel, for everyone to see. Mirrors `VoiceUpdate`.
public struct VoiceUpdate: Codable, Sendable, Equatable {
    public var muted: Bool
    public var deafened: Bool
    public var camera: Bool
    public var screen: Bool

    public init(muted: Bool, deafened: Bool, camera: Bool, screen: Bool) {
        self.muted = muted
        self.deafened = deafened
        self.camera = camera
        self.screen = screen
    }
}

/// How to reach a voice channel's room. The token only lets this device in: media keys come from MLS. Mirrors `VoiceAccess`.
public struct VoiceAccess: Codable, Sendable, Equatable {
    public var url: String
    public var token: String
    public var identity: String
    /// An admin has muted this person, so the microphone won't be let through.
    public var serverMuted: Bool
}

/// Being let share a screen, which holds a place until it's given back. Mirrors `ScreenAccess`.
public struct ScreenAccess: Codable, Sendable, Equatable {
    /// The device's sound may go with it.
    public var sound: Bool
    /// How a native process reaches the room, as a participant that can do nothing else. The iPhone app
    /// shares over its own connection, so it never asks for this.
    public var native: NativeScreenAccess?
}

public struct NativeScreenAccess: Codable, Sendable, Equatable {
    public var url: String
    public var token: String
    public var identity: String
}

/// How a share is asked for, for `voiceScreenAccess`: over this device's own connection, the
/// desktop's "browser", or from a native process of its own.
public struct ScreenRequest: Codable, Sendable, Equatable {
    public var browser: Bool
    public var sound: Bool

    public init(browser: Bool, sound: Bool) {
        self.browser = browser
        self.sound = sound
    }
}

/// A voice channel's media key for its current epoch, straight from MLS, as `voiceKey` gives it.
public struct VoiceKey: Codable, Sendable, Equatable {
    public var epoch: Int
    public var key: Data
}

/// What a channel is made with, for `createChannel`.
public struct NewChannel: Codable, Sendable, Equatable {
    public var type: ChannelType
    public var name: String
    public var topic: String?
    public var category: String?
    /// For a voice channel, as `ChannelView` has them.
    public var bitrate: Int?
    public var userLimit: Int?
    public var screenLimit: Int?
    /// For a voice channel: whether the soundboard plays there, which it does unless this says otherwise.
    public var sounds: Bool?
    /// Slow mode, in seconds, or nil or 0 for off.
    public var slowMode: Int?

    public init(type: ChannelType, name: String, topic: String? = nil, category: String? = nil, bitrate: Int? = nil, userLimit: Int? = nil, screenLimit: Int? = nil, sounds: Bool? = nil, slowMode: Int? = nil) {
        self.type = type
        self.name = name
        self.topic = topic
        self.category = category
        self.bitrate = bitrate
        self.userLimit = userLimit
        self.screenLimit = screenLimit
        self.sounds = sounds
        self.slowMode = slowMode
    }
}

/// What changes about a channel, for `updateChannel`; nil fields stay as they are.
/// A `bitrate` of 0 goes back to the usual.
public struct ChannelChanges: Codable, Sendable, Equatable {
    public var name: String?
    public var topic: String?
    public var category: String?
    public var bitrate: Int?
    public var userLimit: Int?
    public var screenLimit: Int?
    public var sounds: Bool?
    /// Slow mode, in seconds, or 0 to turn it off.
    public var slowMode: Int?

    public init(name: String? = nil, topic: String? = nil, category: String? = nil, bitrate: Int? = nil, userLimit: Int? = nil, screenLimit: Int? = nil, sounds: Bool? = nil, slowMode: Int? = nil) {
        self.name = name
        self.topic = topic
        self.category = category
        self.bitrate = bitrate
        self.userLimit = userLimit
        self.screenLimit = screenLimit
        self.sounds = sounds
        self.slowMode = slowMode
    }
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
    /// Chats marked as unread by hand, by conversation key.
    public var markedUnread: [String]?
    /// Chats that notify only about messages that mention you or reply to you, by conversation key.
    public var mentionsOnly: [String]?
    /// People whose messages are kept out of sight, unread counts and notifications, by user ID. Nobody else learns of it.
    public var blocked: [String]?
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

/// What a chat's details list on their own, as Telegram does: its photos, files, links and so on.
public enum MediaKind: String, Codable, Sendable, CaseIterable { case photo, video, file, audio, voice, link }

/// How many of each kind a chat holds. A message with links counts once, however many it has.
public struct MediaCounts: Codable, Sendable, Equatable {
    public var photo: Int
    public var video: Int
    public var file: Int
    public var audio: Int
    public var voice: Int
    public var link: Int
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
    /// The channels changed.
    case channels(serverId: String)
    /// Someone's device came, went or changed in a voice channel.
    case voice(serverId: String, channelId: String, userId: String, deviceId: String, member: VoiceMember?)
    /// Who's in the voice channel this device is in changed, so its media key did too.
    case voiceKey(serverId: String, channelId: String)
    /// This device has been taken out of a voice channel.
    case voiceEnded(serverId: String, channelId: String, reason: String)
    /// This device's screen share has been stopped.
    case screenEnded(serverId: String, channelId: String, reason: String)
    /// A call in a conversation started, changed whom it's ringing, or ended (nil).
    case call(serverId: String, groupId: String, call: CallView?)
    /// The calls going on were caught up on, so ask again for them and who's in them.
    case calls(serverId: String)
    case message(serverId: String, message: MessageView, isNew: Bool)
    case messageRemoved(serverId: String, groupId: String, id: String)
    case messageMoved(serverId: String, fromGroupId: String, message: MessageView)
    case users(serverId: String)
    case presence(serverId: String, userId: String, online: Bool, lastSeenAt: Int?)
    case typing(serverId: String, groupId: String, userId: String)
    case read(serverId: String, groupId: String, userId: String, seq: Int)
    case settings(serverId: String, info: ServerInfo)
    case emotes(serverId: String)
    /// The soundboard changed.
    case sounds(serverId: String)
    /// Someone else in the voice channel or call this device is in played a sound.
    case sound(serverId: String, channelId: String, userId: String, soundId: String)
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
        case let .connection(serverId, _), let .conversations(serverId), let .channels(serverId), let .voice(serverId, _, _, _, _),
             let .voiceKey(serverId, _), let .voiceEnded(serverId, _, _), let .screenEnded(serverId, _, _), let .call(serverId, _, _), let .calls(serverId), let .message(serverId, _, _),
             let .messageRemoved(serverId, _, _), let .messageMoved(serverId, _, _), let .users(serverId),
             let .presence(serverId, _, _, _), let .typing(serverId, _, _), let .read(serverId, _, _, _),
             let .settings(serverId, _), let .emotes(serverId), let .sounds(serverId), let .sound(serverId, _, _, _), let .preferences(serverId),
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
        case channelId, deviceId, member, call, soundId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let serverId = try c.decode(String.self, forKey: .serverId)
        switch try c.decode(String.self, forKey: .type) {
        case "connection": self = .connection(serverId: serverId, state: try c.decode(ConnectionState.self, forKey: .state))
        case "conversations": self = .conversations(serverId: serverId)
        case "channels": self = .channels(serverId: serverId)
        case "voice":
            self = .voice(
                serverId: serverId,
                channelId: try c.decode(String.self, forKey: .channelId),
                userId: try c.decode(String.self, forKey: .userId),
                deviceId: try c.decode(String.self, forKey: .deviceId),
                member: try c.decodeIfPresent(VoiceMember.self, forKey: .member)
            )
        case "voice_key": self = .voiceKey(serverId: serverId, channelId: try c.decode(String.self, forKey: .channelId))
        case "voice_ended": self = .voiceEnded(serverId: serverId, channelId: try c.decode(String.self, forKey: .channelId), reason: try c.decode(String.self, forKey: .reason))
        case "screen_ended": self = .screenEnded(serverId: serverId, channelId: try c.decode(String.self, forKey: .channelId), reason: try c.decode(String.self, forKey: .reason))
        case "call": self = .call(serverId: serverId, groupId: try c.decode(String.self, forKey: .groupId), call: try c.decodeIfPresent(CallView.self, forKey: .call))
        case "calls": self = .calls(serverId: serverId)
        case "message": self = .message(serverId: serverId, message: try c.decode(MessageView.self, forKey: .message), isNew: try c.decode(Bool.self, forKey: .isNew))
        case "message_removed": self = .messageRemoved(serverId: serverId, groupId: try c.decode(String.self, forKey: .groupId), id: try c.decode(String.self, forKey: .id))
        case "message_moved": self = .messageMoved(serverId: serverId, fromGroupId: try c.decode(String.self, forKey: .fromGroupId), message: try c.decode(MessageView.self, forKey: .message))
        case "users": self = .users(serverId: serverId)
        case "presence": self = .presence(serverId: serverId, userId: try c.decode(String.self, forKey: .userId), online: try c.decode(Bool.self, forKey: .online), lastSeenAt: try c.decodeIfPresent(Int.self, forKey: .lastSeenAt))
        case "typing": self = .typing(serverId: serverId, groupId: try c.decode(String.self, forKey: .groupId), userId: try c.decode(String.self, forKey: .userId))
        case "read": self = .read(serverId: serverId, groupId: try c.decode(String.self, forKey: .groupId), userId: try c.decode(String.self, forKey: .userId), seq: try c.decode(Int.self, forKey: .seq))
        case "settings": self = .settings(serverId: serverId, info: try c.decode(ServerInfo.self, forKey: .info))
        case "emotes": self = .emotes(serverId: serverId)
        case "sounds": self = .sounds(serverId: serverId)
        case "sound":
            self = .sound(
                serverId: serverId,
                channelId: try c.decode(String.self, forKey: .channelId),
                userId: try c.decode(String.self, forKey: .userId),
                soundId: try c.decode(String.self, forKey: .soundId)
            )
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
        case let .channels(serverId):
            try c.encode("channels", forKey: .type); try c.encode(serverId, forKey: .serverId)
        case let .voice(serverId, channelId, userId, deviceId, member):
            try c.encode("voice", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(channelId, forKey: .channelId)
            try c.encode(userId, forKey: .userId); try c.encode(deviceId, forKey: .deviceId); try c.encodeIfPresent(member, forKey: .member)
        case let .voiceKey(serverId, channelId):
            try c.encode("voice_key", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(channelId, forKey: .channelId)
        case let .voiceEnded(serverId, channelId, reason):
            try c.encode("voice_ended", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(channelId, forKey: .channelId); try c.encode(reason, forKey: .reason)
        case let .screenEnded(serverId, channelId, reason):
            try c.encode("screen_ended", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(channelId, forKey: .channelId); try c.encode(reason, forKey: .reason)
        case let .call(serverId, groupId, call):
            try c.encode("call", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(groupId, forKey: .groupId); try c.encodeIfPresent(call, forKey: .call)
        case let .calls(serverId):
            try c.encode("calls", forKey: .type); try c.encode(serverId, forKey: .serverId)
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
        case let .sounds(serverId):
            try c.encode("sounds", forKey: .type); try c.encode(serverId, forKey: .serverId)
        case let .sound(serverId, channelId, userId, soundId):
            try c.encode("sound", forKey: .type); try c.encode(serverId, forKey: .serverId); try c.encode(channelId, forKey: .channelId)
            try c.encode(userId, forKey: .userId); try c.encode(soundId, forKey: .soundId)
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
