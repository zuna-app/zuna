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
    /// Deletes the account on a server, once the password proves it, and then this device's copy of it.
    public func deleteAccount(_ serverId: String, password: String) async throws { try await call("deleteAccount", [serverId, password]) }
    public func nudge() async throws { try await call("nudge") }
    /// Closes every connection while the app is in the background, and writes nothing until `resume()` or `reload()`.
    public func suspend() async throws { try await call("suspend") }
    /// Reconnects after `suspend()` and catches up. True if it read everything again first, as `reload()` does.
    @discardableResult
    public func resume() async throws -> Bool { try await call("resume") }
    /// Reads everything again and reconnects, after the share extension used this device's data.
    public func reload() async throws { try await call("reload") }
    /// Whether the person is using this device: while they are, their other devices keep quiet and nothing is pushed.
    /// They show as online while they are, on `shownServer` alone, as Telegram is only in the account shown, and offline at once when they aren't.
    public func setActive(_ active: Bool, shownServer: String?) async throws { try await call("setActive", [active, shownServer]) }

    /// The first link in a draft that can have a preview.
    public func findLink(_ text: String) async throws -> String? { try await call("findLink", [text]) }
    /// Fetches a link's page on this device and makes its preview. Only when the person allows link previews.
    public func linkPreview(_ url: String) async throws -> LinkPreview? { try await call("linkPreview", [url]) }
    /// Forwards messages, in order, to a conversation on any server (see ZunaClient.forwardMessages).
    public func forwardMessages(from serverId: String, groupId: String, ids: [String], to targetServerId: String, conversationKey: String) async throws {
        try await call("forwardMessages", [serverId, groupId, ids, targetServerId, conversationKey])
    }

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
    public func getConversations() async throws -> [ConversationView] {
        let rows: LossyList<ConversationView> = try await call("getConversations")
        return rows.items
    }
    public func getPreferences() async throws -> Preferences { try await call("getPreferences") }
    /// Changes only the lists that are set, so another device's change to the others isn't undone.
    public func updatePreferences(_ changes: PreferenceChanges) async throws { try await run("updatePreferences", [changes]) }
    public func getEmotes() async throws -> EmoteSet { try await call("getEmotes") }
    public func getDevices() async throws -> [DeviceView] { try await call("getDevices") }
    public func getNewDevices() async throws -> [NewDevice] { try await call("getNewDevices") }
    /// Whether a device that signed in after this one was the person. One that wasn't is removed.
    public func answerNewDevice(_ deviceId: String, mine: Bool) async throws { try await run("answerNewDevice", [deviceId, mine]) }

    // MARK: Messages

    public func loadMessages(_ groupId: String, before: Int? = nil) async throws -> MessagePage {
        try await call("loadMessages", before.map { [groupId, $0] } ?? [groupId])
    }

    public func loadAround(_ groupId: String, seq: Int) async throws -> [MessageView] { try await call("loadAround", [groupId, seq]) }
    /// The page after `after`, oldest first, for reading on from a message jumped to; with no more, the newest.
    public func loadNewer(_ groupId: String, after: Int) async throws -> MessagePage { try await call("loadNewer", [groupId, after]) }
    public func messageById(_ groupId: String, id: String) async throws -> MessageView? { try await call("messageById", [groupId, id]) }
    /// Fetches what a chat got while the app was away ahead of catching up on everything else, where it can be read as it is.
    public func catchUpFirst(_ groupId: String) async throws { try await run("catchUpFirst", [groupId]) }
    /// The messages in a group after `after` that mention you or reply to you, oldest first, leaving out those already jumped to.
    public func unreadMentions(_ groupId: String, after: Int) async throws -> [MessagePlace] { try await call("unreadMentions", [groupId, after]) }
    /// A mention that was jumped to, which no longer counts as waiting.
    public func markMentionSeen(_ groupId: String, id: String) async throws { try await run("markMentionSeen", [groupId, id]) }
    public func loadPins(_ groupId: String) async throws -> [MessageView] { try await call("loadPins", [groupId]) }
    public func search(_ query: String, groupId: String? = nil, limit: Int = 50) async throws -> [SearchResult] {
        try await call("search", groupId.map { [query, $0, limit] } ?? [query, String?.none, limit])
    }
    public func searchCoverage() async throws -> SearchCoverage { try await call("searchCoverage") }
    /// How many photos, files, links and so on a chat holds, among its messages on this device.
    public func mediaCounts(_ groupId: String) async throws -> MediaCounts { try await call("mediaCounts", [groupId]) }
    /// A page of a chat's messages that hold one kind, newest first: `limit` of them, or the core's page size.
    public func loadMedia(_ groupId: String, kind: MediaKind, before: Int? = nil, limit: Int? = nil) async throws -> MessagePage {
        // The core reads a missing `before` as the newest, but needs its default for a missing `limit`.
        try await call("loadMedia", limit.map { [groupId, kind, before, $0] } ?? [groupId, kind, before])
    }

    /// Sends a message. `previewUrl` is a link whose preview is still being made:
    /// the message waits a moment for it, so a link pasted and sent at once gets one.
    @discardableResult
    public func sendMessage(_ conversationKey: String, _ body: MessageBody, previewUrl: String? = nil) async throws -> MessageView {
        try await call("sendMessage", [conversationKey, body, SendOptions(previewUrl: previewUrl)])
    }

    /// Uploads the files, encrypted, then sends the message. Progress shows on the local echo.
    /// What the files say about where, when and on what they were made is taken out, unless `keepMetadata`.
    public func sendWithAttachments(_ conversationKey: String, files: [OutgoingFile], body: MessageBody, previewUrl: String? = nil, keepMetadata: Bool = false) async throws {
        try await run("sendWithAttachments", [conversationKey, files, body, SendOptions(previewUrl: previewUrl, keepMetadata: keepMetadata ? true : nil)])
    }

    /// Sends a message, with any files, and returns once it's gone, for the share extension, which stops straight after.
    public func sendNow(_ conversationKey: String, files: [OutgoingFile], body: MessageBody, previewUrl: String? = nil, keepMetadata: Bool = false) async throws {
        try await run("sendNow", [conversationKey, files, body, SendOptions(previewUrl: previewUrl, keepMetadata: keepMetadata ? true : nil)])
    }

    public func emotesIn(_ text: String) async throws -> [String: EmoteRef] { try await call("emotesIn", [text]) }

    public func retryMessage(_ groupId: String, id: String) async throws { try await run("retryMessage", [groupId, id]) }
    public func discardMessage(_ groupId: String, id: String) async throws { try await run("discardMessage", [groupId, id]) }
    public func editMessage(_ groupId: String, id: String, text: String, emotes: [String: EmoteRef], mentions: [String]) async throws {
        try await run("editMessage", [groupId, id, text, emotes, mentions])
    }
    public func deleteMessage(_ groupId: String, id: String) async throws { try await run("deleteMessage", [groupId, id]) }
    public func deleteMessages(_ groupId: String, ids: [String]) async throws { try await run("deleteMessages", [groupId, ids]) }
    /// Mutes a chat until `until` (ms since 1970), or without it until it's unmuted.
    public func mute(_ conversationKey: String, until: Double? = nil) async throws {
        try await run("mute", until.map { [conversationKey, $0] } ?? [conversationKey])
    }
    public func unmute(_ conversationKey: String) async throws { try await run("unmute", [conversationKey]) }
    /// Marks a chat as unread by hand, or takes the mark off, on every device.
    public func setMarkedUnread(_ conversationKey: String, marked: Bool) async throws { try await run("setMarkedUnread", [conversationKey, marked]) }
    /// Blocks someone, or unblocks them. Their messages stay, out of sight, unread counts and notifications; nobody else learns of it.
    public func setBlocked(_ userId: String, blocked: Bool) async throws { try await run("setBlocked", [userId, blocked]) }
    /// Has a chat notify only about messages that mention you or reply to you, or about all of them again.
    public func setMentionsOnly(_ conversationKey: String, on: Bool) async throws { try await run("setMentionsOnly", [conversationKey, on]) }
    /// Reads a chat to its newest message without opening it, and takes off any mark of being unread.
    public func markChatRead(_ conversationKey: String) async throws { try await run("markChatRead", [conversationKey]) }
    public func setPinned(_ groupId: String, id: String, pinned: Bool) async throws { try await run("setPinned", [groupId, id, pinned]) }
    public func toggleReaction(_ groupId: String, messageId: String, key: String, emote: EmoteRef? = nil) async throws {
        try await run("toggleReaction", emote.map { [groupId, messageId, key, $0] } ?? [groupId, messageId, key])
    }
    /// Presses a button under a bot's message, by its row and its place in it. The press goes to the whole chat and is shown nowhere.
    public func pressButton(_ groupId: String, messageId: String, row: Int, column: Int) async throws { try await run("pressButton", [groupId, messageId, row, column]) }
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
    /// Clears a conversation this person was removed from, from this device.
    public func forgetConversation(_ groupId: String) async throws { try await run("forgetConversation", [groupId]) }
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

    /// Sets how long messages sent to a chat from now on last, in seconds, or 0 for as long as they're kept.
    public func setDisappearing(_ groupId: String, seconds: Int) async throws { try await run("setDisappearing", [groupId, seconds]) }

    // MARK: Channels

    /// Every channel on this server, in order. Their chats come in `conversation` once this device has joined them.
    public func getChannels() async throws -> [ChannelView] {
        let rows: LossyList<ChannelView> = try await call("getChannels")
        return rows.items
    }
    /// Who's in the voice channels, by device.
    public func getVoiceMembers() async throws -> [VoiceMember] {
        let rows: LossyList<VoiceMember> = try await call("getVoiceMembers")
        return rows.items
    }
    /// Makes a channel, for a server admin, and returns its ID. Everyone else's apps join it by themselves.
    public func createChannel(_ channel: NewChannel) async throws -> String { try await call("createChannel", [channel]) }
    /// Changes what a channel says about itself, for a server admin.
    public func updateChannel(_ id: String, _ changes: ChannelChanges) async throws { try await run("updateChannel", [id, changes]) }
    /// Puts the channels in this order, for a server admin.
    public func reorderChannels(_ ids: [String]) async throws { try await run("reorderChannels", [ids]) }
    /// Deletes a channel for everyone, for a server admin.
    public func deleteChannel(_ id: String) async throws { try await run("deleteChannel", [id]) }

    // MARK: Voice channels

    /// How to reach a voice channel's room. It lets this device in, and nothing else: its media is under keys only members have.
    public func voiceAccess(_ channelId: String) async throws -> VoiceAccess { try await call("voiceAccess", [channelId]) }
    /// The channel's media key for its current epoch, straight from MLS. It's kept nowhere.
    public func voiceKey(_ channelId: String) async throws -> VoiceKey { try await call("voiceKey", [channelId]) }
    /// What this device is doing in a voice channel, for everyone to see, or in a call, for the conversation to see, or nil
    /// for both once it's left. Coming into a call with `ring` starts it, ringing everyone else, if nobody's in it yet.
    public func setVoiceState(_ channelId: String?, _ update: VoiceUpdate?, ring: Bool = false) async throws { try await run("setVoiceState", [channelId, update, ring]) }
    /// Takes someone out of a voice channel, for a server admin.
    public func voiceDisconnect(_ channelId: String, userId: String) async throws { try await run("voiceDisconnect", [channelId, userId]) }
    /// Mutes someone until an admin unmutes them, for a server admin. The media server makes it stick.
    public func voiceMute(_ channelId: String, userId: String, muted: Bool) async throws { try await run("voiceMute", [channelId, userId, muted]) }
    /// Asks to share this device's screen over its own connection, which throws with something to tell the person if the
    /// server's rules say no. Once the media server hears, it lets the connection publish one. The place is held until `voiceScreenStop`.
    public func voiceScreenAccess(_ channelId: String, _ request: ScreenRequest) async throws -> ScreenAccess { try await call("voiceScreenAccess", [channelId, request]) }
    /// Gives up this device's place to share a screen, once it's stopped.
    public func voiceScreenStop(_ channelId: String) async throws { try await run("voiceScreenStop", [channelId]) }
    /// Stops someone else's screen share, for a server admin.
    public func voiceScreenStopOf(_ channelId: String, userId: String) async throws { try await run("voiceScreenStopOf", [channelId, userId]) }

    // MARK: Calls in direct messages and groups

    /// The calls going on in this person's conversations. Who's in each are the voice members under its group.
    public func getCalls() async throws -> [CallView] {
        let rows: LossyList<CallView> = try await call("getCalls")
        return rows.items
    }
    /// Gets a conversation ready for a call, starting a direct message nobody has written in yet, and says which group
    /// the call is in. Coming into it is the room's to do, through `voiceAccess`.
    public func prepareCall(_ key: String) async throws -> String { try await call("prepareCall", [key]) }
    /// Rings people in the conversation again, from inside its call: those named, or everyone not in it.
    public func ringCall(_ groupId: String, userIds: [String] = []) async throws { try await run("ringCall", [groupId, userIds]) }
    /// Stops a call ringing this person, on all their devices.
    public func declineCall(_ groupId: String) async throws { try await run("declineCall", [groupId]) }

    // MARK: Soundboard

    /// The server's soundboard, oldest first.
    public func getSounds() async throws -> [SoundView] {
        let rows: LossyList<SoundView> = try await call("getSounds")
        return rows.items
    }
    /// Adds a sound, for a server admin, from WAV in one channel at 48 kHz. The core cuts its silence, holds it to five
    /// seconds and makes it about as loud as the rest, and returns its ID.
    public func addSound(_ wav: WireFile, name: String, emoji: String) async throws -> String { try await call("addSound", [wav, name, emoji]) }
    /// Renames a sound, or gives it another emoji, for a server admin.
    public func updateSound(_ id: String, _ changes: SoundChanges) async throws { try await run("updateSound", [id, changes]) }
    /// Takes a sound off the soundboard, for a server admin.
    public func deleteSound(_ id: String) async throws { try await run("deleteSound", [id]) }
    /// A sound's file, decrypted and checked to be the WAV every sound is, for playing.
    public func soundFile(_ id: String) async throws -> WireFile { try await call("soundFile", [id]) }
    /// Plays a sound to the others in the voice channel or call this device is in, who each play it themselves. It
    /// throws with something to tell the person when the server says no, as while muted.
    public func playSound(_ channelId: String, soundId: String) async throws { try await run("playSound", [channelId, soundId]) }

    // MARK: Watching together

    /// What the voice channel or call this device is in watches together, or nil when nothing's on.
    public func getWatch(_ channelId: String) async throws -> WatchView? { try await call("getWatch", [channelId]) }
    /// Puts a YouTube video on for everyone in the room, from a link. This device fetches its title and picture, so
    /// its person should have agreed to contact YouTube. It throws with words for them when the link isn't YouTube's.
    public func watchStart(_ channelId: String, url: String) async throws { try await run("watchStart", [channelId, url]) }
    /// A change this person made: play or pause, a seek, a speed.
    public func watchControl(_ channelId: String, _ change: WatchChange) async throws { try await run("watchControl", [channelId, change]) }
    /// Stops the video for everyone in the room.
    public func watchStop(_ channelId: String) async throws { try await run("watchStop", [channelId]) }

    // MARK: Invites and verification

    public func invites() async throws -> [Invite] { try await call("invites") }

    /// Creates an invite link. 0 uses means no limit; 0 seconds means it doesn't expire.
    public func createInvite(maxUses: Int, expiresInSeconds: Int) async throws -> String { try await call("createInvite", [maxUses, expiresInSeconds]) }
    public func linkForInvite(_ code: String) async throws -> String { try await call("linkForInvite", [code]) }
    public func revokeInvite(_ code: String) async throws { try await run("revokeInvite", [code]) }

    /// The sixteen emoji to compare with someone, from both people's keys.
    public func safetyCheck(_ userId: String) async throws -> SafetyCheck? { try await call("safetyCheck", [userId]) }
    public func markVerified(_ userId: String, covers: String) async throws { try await run("markVerified", [userId, covers]) }
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
    /// Who is banned, when and by whom, the latest first. For admins.
    public func getBans() async throws -> [BanView] { try await call("getBans") }
    /// Reports someone to the server's admins, who see whom and why, never what was said nor who reported them.
    public func reportUser(_ userId: String, reason: ReportReason) async throws { try await run("reportUser", [userId, reason]) }
    /// What people were reported for, one entry a person, the latest first. For admins.
    public func getReports() async throws -> [ReportView] { try await call("getReports") }
    public func dismissReports(_ userId: String) async throws { try await run("dismissReports", [userId]) }

    /// Changes only the fields that are set.
    public func updateServerSettings(_ changes: ServerSettingsChanges) async throws { try await run("updateServerSettings", [changes]) }

    // MARK: Bots

    /// The bots this person may manage: their own, and for a server admin the listed ones.
    public func getBots() async throws -> [BotView] { try await call("getBots") }
    /// Makes a bot, and the link its program is set up with, which works once, for an hour, and is only given here.
    public func createBot(_ bot: NewBot) async throws -> CreatedBot { try await call("createBot", [bot]) }
    /// A new setup link for a bot that hasn't been set up, which ends the one before.
    public func newBotLink(_ botId: String) async throws -> String { try await call("newBotLink", [botId]) }
    /// Changes only the fields that are set.
    public func updateBot(_ botId: String, _ changes: BotChanges) async throws { try await run("updateBot", [botId, changes]) }
    /// Asks a bot to change its name, description and picture, in its owner's chat with it. The bot does when it's running.
    public func updateBotProfile(_ botId: String, _ changes: ProfileChanges, avatar: AvatarChange = .unchanged) async throws {
        let avatarArgument: any Encodable & Sendable = switch avatar {
        case .unchanged: Absent()
        case .removed: Optional<WireFile>.none
        case let .set(file): file
        }
        try await run("updateBotProfile", [botId, changes, avatarArgument])
    }
    /// Deletes a bot for good, taking it out of all its chats.
    public func deleteBot(_ botId: String) async throws { try await run("deleteBot", [botId]) }
    /// The channels a listed bot is given, by a server admin: the only ones it joins.
    public func setBotChannels(_ botId: String, channelIds: [String]) async throws { try await run("setBotChannels", [botId, channelIds]) }

    // MARK: Files

    /// Decrypts an attachment or avatar into the app's protected cache.
    public func downloadFile(_ attachment: Attachment) async throws -> WireFile { try await call("downloadFile", [attachment]) }
    public func downloadFile(_ avatar: AvatarRef) async throws -> WireFile { try await call("downloadFile", [avatar]) }
    /// One chunk of a file, decrypted, as a file of its own: for a video that plays as it comes.
    public func downloadChunk(_ attachment: Attachment, index: Int) async throws -> WireFile { try await call("downloadChunk", [attachment, index]) }
}

/// Server settings an admin can change, named as the server's API names them.
/// A change to what a room watches together, for `watchControl`; nil fields stay as they are.
public struct WatchChange: Codable, Sendable, Equatable {
    public var playing: Bool?
    /// Milliseconds into the video.
    public var position: Double?
    /// One of YouTube's speeds, 0.25 to 2.
    public var rate: Double?

    public init(playing: Bool? = nil, position: Double? = nil, rate: Double? = nil) {
        self.playing = playing
        self.position = position
        self.rate = rate
    }
}

public struct ServerSettingsChanges: Codable, Sendable, Equatable {
    public var name: String?
    public var registration: String?
    public var allowMemberInvites: Bool?
    public var maxUploadMb: Int?
    public var retentionDays: Int?
    public var screenShare: ScreenRules?
    public var allowMemberBots: Bool?
    public var maxBots: Int?

    public init(name: String? = nil, registration: String? = nil, allowMemberInvites: Bool? = nil, maxUploadMb: Int? = nil, retentionDays: Int? = nil, screenShare: ScreenRules? = nil, allowMemberBots: Bool? = nil, maxBots: Int? = nil) {
        self.name = name
        self.registration = registration
        self.allowMemberInvites = allowMemberInvites
        self.maxUploadMb = maxUploadMb
        self.retentionDays = retentionDays
        self.screenShare = screenShare
        self.allowMemberBots = allowMemberBots
        self.maxBots = maxBots
    }

    enum CodingKeys: String, CodingKey {
        case name, registration
        case allowMemberInvites = "allow_member_invites"
        case maxUploadMb = "max_upload_mb"
        case retentionDays = "retention_days"
        case screenShare = "screen_share"
        case allowMemberBots = "allow_member_bots"
        case maxBots = "max_bots"
    }
}

/// A bot to make: its username and name, whether everyone sees it, who may add it to groups, and whether it may send files.
public struct NewBot: Codable, Sendable, Equatable {
    public var username: String
    public var name: String
    public var listed: Bool
    public var add: BotAdd
    public var files: Bool

    public init(username: String, name: String, listed: Bool, add: BotAdd, files: Bool) {
        self.username = username
        self.name = name
        self.listed = listed
        self.add = add
        self.files = files
    }
}

/// A bot just made, with the link its program is set up with.
public struct CreatedBot: Codable, Sendable, Equatable {
    public var bot: BotView
    public var link: String
}

/// What a bot's owner can change about it; nil fields stay as they are.
public struct BotChanges: Codable, Sendable, Equatable {
    public var listed: Bool?
    public var add: BotAdd?
    public var files: Bool?

    public init(listed: Bool? = nil, add: BotAdd? = nil, files: Bool? = nil) {
        self.listed = listed
        self.add = add
        self.files = files
    }
}

/// Where a server wakes this device for new messages (`PushSettings` in the core).
public struct PushSettings: Encodable, Sendable, Equatable {
    public var relay: String
    public var handle: String
    /// The relay's handle for this device's VoIP token, which calls ring through as phone calls, if it has one.
    public var callHandle: String?
    public var key: Data
    public var registration: String
    /// Tell the server which chats are muted, for an app that can't hide notifications itself.
    /// Otherwise it's pushed for everything, channels too, and hides what it shouldn't show.
    public var sendMuted: Bool

    public init(relay: String, handle: String, callHandle: String? = nil, key: Data, registration: String, sendMuted: Bool) {
        self.relay = relay
        self.handle = handle
        self.callHandle = callHandle
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
    public var voice: Bool?
    public var waveform: String?
    public var round: Bool?

    public init(blob: WireFile, name: String, mime: String, width: Int? = nil, height: Int? = nil, thumb: String? = nil, duration: Double? = nil, voice: Bool? = nil, waveform: String? = nil, round: Bool? = nil) {
        self.blob = blob
        self.name = name
        self.mime = mime
        self.width = width
        self.height = height
        self.thumb = thumb
        self.duration = duration
        self.voice = voice
        self.waveform = waveform
        self.round = round
    }
}

/// Where a message is in its chat, to jump to it.
public struct MessagePlace: Codable, Sendable, Equatable {
    public var id: String
    public var seq: Int
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
