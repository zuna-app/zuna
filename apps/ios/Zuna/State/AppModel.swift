import Foundation
import UIKit
import Observation
import ZunaModels

/// All UI state, kept in step with the core through its events. The iOS
/// counterpart of the desktop's packages/ui/src/state/store.ts.
@MainActor
@Observable
final class AppModel {
    struct ServerState: Equatable {
        var entry: ServerEntry
        var info: ServerInfo?
        var connection: ConnectionState
        var me: SelfInfo?
        var conversations: [ConversationView] = []
        /// The server's channels, in order, apart from the conversations, as the core gives them.
        var channels: [ChannelView] = []
        /// Who's in the voice channels and the calls, by device.
        var voice: [String: VoiceMember] = [:]
        /// The calls going on in this person's conversations, by group.
        var calls: [String: CallView] = [:]
        /// Changed through setUsers, which also works out who can be mentioned. Their presence
        /// here is as it was when they were loaded: what's come since is in `LiveState`.
        private(set) var users: [String: UserView]
        /// Lowercased username to user ID, for highlighting mentions.
        private(set) var mentionable: [String: String]
        var emotes: EmoteSet
        /// The server's soundboard, for its voice channels and calls.
        var sounds: [SoundView]
        var prefs: Preferences

        init(entry: ServerEntry, info: ServerInfo?, connection: ConnectionState, me: SelfInfo?, conversations: [ConversationView], channels: [ChannelView], voice: [VoiceMember], calls: [CallView] = [], users: [String: UserView], emotes: EmoteSet, sounds: [SoundView] = [], prefs: Preferences) {
            self.entry = entry
            self.info = info
            self.connection = connection
            self.me = me
            self.conversations = conversations
            self.channels = channels
            self.voice = Dictionary(voice.map { ($0.deviceId, $0) }, uniquingKeysWith: { $1 })
            self.calls = Dictionary(calls.map { ($0.groupId, $0) }, uniquingKeysWith: { $1 })
            self.users = users
            self.mentionable = Self.mentionable(users)
            self.emotes = emotes
            self.sounds = sounds
            self.prefs = prefs
        }

        /// The people, as the core gives them, and who of them can be mentioned.
        mutating func setUsers(_ users: [String: UserView]) {
            self.users = users
            mentionable = Self.mentionable(users)
        }

        private static func mentionable(_ users: [String: UserView]) -> [String: String] {
            Dictionary(users.values.map { ($0.username.lowercased(), $0.id) }, uniquingKeysWith: { first, _ in first })
        }

        /// Unread messages outside muted conversations, for the list of servers.
        /// A chat only marked as unread counts as one, and in a channel only
        /// what mentions you or answers you counts, as on the desktop.
        var unread: Int {
            chatsUnread + channelMentions
        }

        /// What's unread in the conversations, for the Chats tab.
        var chatsUnread: Int {
            conversations.reduce(0) { $0 + ($1.muted ? 0 : $1.unread > 0 ? $1.unread : $1.markedUnread ? 1 : 0) }
        }

        /// What mentions you or answers you in channels that aren't muted, for the Channels tab.
        var channelMentions: Int {
            channels.reduce(0) { total, channel in
                guard let conversation = channel.conversation, !conversation.muted else { return total }
                return total + conversation.unreadMentions
            }
        }

        /// Anything new at all, even what doesn't count, such as a text channel's
        /// messages that don't mention you, for the desktop rail's pill.
        var hasNew: Bool {
            unread > 0 || channels.contains { $0.type == .text && ($0.conversation.map { !$0.muted && $0.unread > 0 } ?? false) }
        }

        /// The server has channels to show: some, or none yet for an admin to make.
        var showsChannels: Bool {
            !channels.isEmpty || isAdmin
        }

        /// An owner or admin of the server, who makes and changes its channels.
        var isAdmin: Bool {
            let role = me?.role ?? entry.role
            return role == .owner || role == .admin
        }

        /// A conversation by its key, whether it's in the list or is a channel's.
        func conversation(_ key: String) -> ConversationView? {
            conversations.first { $0.key == key } ?? channels.first { $0.key == key }?.conversation
        }

        func conversation(groupId: String) -> ConversationView? {
            conversations.first { $0.groupId == groupId } ?? channels.first { $0.id == groupId }?.conversation
        }

        /// The conversations and the channels this device has joined, for what goes through all of them.
        var allConversations: [ConversationView] {
            conversations + channels.compactMap(\.conversation)
        }

        /// The channel a conversation is, if it's one.
        func channel(_ key: String) -> ChannelView? {
            channels.first { $0.key == key }
        }

        var selfUser: UserView? {
            me.flatMap { users[$0.userId] }
        }

        func isBlocked(_ userId: String) -> Bool {
            prefs.blocked?.contains(userId) ?? false
        }

        /// Whether direct messages and groups can have calls here.
        var hasCalls: Bool { (info?.calls ?? 0) > 0 }

        /// Who's in a conversation's call, or a voice channel, by user, in the order they came.
        func inRoom(_ roomId: String) -> [String] {
            var seen = Set<String>()
            return voice.values.filter { $0.channelId == roomId }.sorted { $0.since < $1.since }.map(\.userId).filter { seen.insert($0).inserted }
        }
    }

    struct Toast: Identifiable, Equatable {
        enum Kind { case info, error, security }
        let id: Int
        let kind: Kind
        let message: String
    }

    enum Tab: Hashable { case chats, channels, settings }

    private(set) var servers: [String: ServerState] = [:]
    private(set) var order: [String] = []
    /// The server whose chats are open, remembered for the next launch, as Mail remembers its mailbox.
    var activeServerId: String? {
        didSet {
            AppSettings.lastServer = activeServerId
            if activeServerId != oldValue { onActiveServerChanged?() }
        }
    }
    /// The person is online on the server shown alone, as Telegram is only in the account shown.
    @ObservationIgnored var onActiveServerChanged: (() -> Void)?
    var tab: Tab = .chats
    /// The welcome screens: until the first server is joined, and again if none are left.
    private(set) var onboarding = false
    /// While the join screens are signing up or in. They decide when they're
    /// done, since a new account still has its recovery key to show.
    var accountFlowActive = false
    /// The join screens over the app, for another server.
    var joining = false
    /// The address signing in again starts from, for a server that ended this device's session.
    var signInAgain: String?
    /// An invite link opened from outside the app, for the join screens to pick up.
    var pendingLink: String?
    /// The screens opened from the conversation list: chats and their details.
    /// On an iPad, which has no tabs, also the channels beside them.
    var chatsPath: [ChatRoute] = []
    /// The screens opened from the Channels tab, apart, so each tab keeps its place.
    var channelsPath: [ChatRoute] = []

    /// The screens opened from the tab on show: chats or channels, and their details.
    var chatPath: [ChatRoute] {
        get { tab == .channels ? channelsPath : chatsPath }
        set {
            if tab == .channels { channelsPath = newValue } else { chatsPath = newValue }
        }
    }

    /// Opens a conversation from anywhere, like the desktop's selectConversation.
    /// A channel opens on the Channels tab, anything else on Chats; `channel` says
    /// which where the model may not know yet, as for a channel just made.
    func openChat(_ conversationKey: String, channel: Bool? = nil) {
        tab = (channel ?? (activeServer?.channel(conversationKey) != nil)) ? .channels : .chats
        chatPath = [.chat(conversationKey)]
        // Opening a chat marked as unread takes the mark off, as in Telegram.
        if let serverId = activeServerId, servers[serverId]?.conversation(conversationKey)?.markedUnread == true {
            setMarkedUnread(conversationKey, false, on: serverId)
        }
    }

    /// While the app catches up, as it comes back from the background, a chat that opens fetches its
    /// new messages first, rather than after the account's keys and who everyone is: from the list, from
    /// a notification, or the one on screen as the app comes back. Once caught up, the core asks nothing.
    func catchUpFirst(serverId: String, groupId: String) {
        Task { try? await core.session(serverId).catchUpFirst(groupId) }
    }

    func catchUpChatOnScreen() {
        guard let serverId = activeServerId, tab != .settings, case let .chat(key)? = chatPath.last,
              let groupId = servers[serverId]?.conversation(key)?.groupId else { return }
        catchUpFirst(serverId: serverId, groupId: groupId)
    }

    /// More than one server: an iPad lists them beside the chats, as Mail lists
    /// its mailboxes, and Settings asks which one it's for.
    var hasServerList: Bool {
        order.count > 1
    }
    /// Who's typing and who's online on each server, apart from `servers` (see LiveState.swift).
    private(set) var liveStates: [String: LiveState] = [:]

    /// A server's typing and presence, which a view reads only where it shows them.
    func live(_ serverId: String) -> LiveState {
        liveStates[serverId] ?? .none
    }

    private func liveState(_ serverId: String) -> LiveState {
        if let state = liveStates[serverId] { return state }
        let state = LiveState()
        liveStates[serverId] = state
        return state
    }

    /// Loaded messages, by `listKey(serverId, listId)` (see MessageLists.swift).
    var lists: [String: MessageList] = [:]
    /// When each list was last opened, to let go of those not opened for longest (`keepRecentLists`).
    @ObservationIgnored var listOpened: [String: Int] = [:]
    @ObservationIgnored var listOpenings = 0
    var jumpTarget: JumpTarget?
    var nextJump = 0
    /// Files on their way into the open chat's composer: dropped on an iPad, or added by a UI test.
    var pendingAttachments: [URL] = []
    /// Drafts, replies, edits and files being written, by `composerKey(serverId, conversationKey)`.
    var composers: [String: ComposerState] = [:]
    /// A channel's message being edited where it is, by `listKey`, which leaves the composer's draft alone.
    var editingInPlace: [String: MessageView] = [:]
    /// What those edits say so far: apart, so typing in one draws only the editor, not the whole chat.
    var inPlaceText: [String: String] = [:]
    /// Where each chat was scrolled to, when it wasn't at the newest message: the message at the top of the screen.
    @ObservationIgnored var savedPositions: [String: String] = [:]
    /// The furthest read position waiting to be sent for each chat, by `listKey`, while one is on its way.
    @ObservationIgnored var readsWanted: [String: Int] = [:]
    private(set) var toasts: [Toast] = []
    var settings = AppSettings.load() {
        didSet { settings.save() }
    }
    /// App lock is waiting for Face ID, Touch ID or the passcode; nothing under it shows or is read out.
    var appLocked = AppSettings.load().appLock

    let core: CoreConnection
    /// The voice channel this device is in, if any. It's there from launch, before this is, for calls pushed meanwhile.
    let voice: VoiceModel
    /// Called when servers are added or removed, so notifications can follow.
    @ObservationIgnored var onServersChanged: (() -> Void)?
    /// Called for a new message the person should hear about while the app runs: server, group and message.
    @ObservationIgnored var onNotify: ((String, String, String) -> Void)?
    /// Called when a message was deleted, so its notification goes too: server, group and message.
    @ObservationIgnored var onMessageGone: ((String, String, String) -> Void)?
    /// Called when a server's conversations are up to date: caught up with the server, and no refresh on its way.
    @ObservationIgnored var onCaughtUp: ((String) -> Void)?
    @ObservationIgnored private var refreshesInFlight: Set<String> = []
    private var pendingRefreshes: Set<String> = []
    private var nextToast = 1
    @ObservationIgnored private var emotePrefetch: Task<Void, Never>?
    /// By server: the set last fetched ahead, so it's fetched again only when it changes.
    @ObservationIgnored private var prefetchedEmotes: [String: String] = [:]

    init(core: CoreConnection, voice: VoiceModel) {
        self.core = core
        self.voice = voice
        voice.attach(self)
    }

    var activeServer: ServerState? {
        activeServerId.flatMap { servers[$0] }
    }

    /// Unread messages on every server, like the desktop's dock badge.
    var totalUnread: Int {
        servers.values.reduce(0) { $0 + $1.unread }
    }

    /// What's unread on the servers that aren't open, for the server button, as the desktop's rail counts them.
    var otherServersUnread: Int {
        servers.values.reduce(0) { $0 + ($1.entry.id == activeServerId ? 0 : $1.unread) }
    }

    /// Something new on a server that isn't open, though nothing that counts, for the server button's dot.
    var otherServersHaveNew: Bool {
        servers.values.contains { $0.entry.id != activeServerId && $0.hasNew }
    }


    // MARK: Loading

    /// Loads every server's state. Also used when a server appears that the
    /// model doesn't know yet; a sign-in replaces any earlier account on the
    /// same server, so servers that are gone are dropped.
    func load() async {
        do {
            let entries = try await core.listServers()
            // All at once, not one after another, so each server joined adds nothing to the wait.
            let loaded = await withTaskGroup(of: (String, ServerState?).self) { group in
                for entry in entries {
                    group.addTask { (entry.id, await self.loadServer(entry)) }
                }
                var loaded: [String: ServerState] = [:]
                for await (id, state) in group {
                    if let state { loaded[id] = state }
                }
                return loaded
            }
            servers = loaded
            // The people came with their presence as it is now.
            liveStates = liveStates.filter { loaded[$0.key] != nil }
            for state in liveStates.values { state.forgetPresence() }
            prefetchEmotesSoon()
            let previous = order
            order = entries.map(\.id).filter { loaded[$0] != nil }
            if order != previous { onServersChanged?() }
            if activeServerId.map({ servers[$0] == nil }) ?? true {
                activeServerId = AppSettings.lastServer.flatMap { servers[$0] == nil ? nil : $0 } ?? order.first
            }
            if order.isEmpty {
                onboarding = true
            } else if !accountFlowActive {
                onboarding = false
            }
        } catch {
            toast("Couldn't load your servers. \(ErrorText.describe(error))", .error)
        }
    }

    private func loadServer(_ entry: ServerEntry) async -> ServerState? {
        let session = core.session(entry.id)
        do {
            async let conversations = session.getConversations()
            async let channels = session.getChannels()
            async let voice = session.getVoiceMembers()
            async let calls = session.getCalls()
            async let users = session.getUsers()
            async let emotes = session.getEmotes()
            async let sounds = session.getSounds()
            async let prefs = session.getPreferences()
            async let me = session.getSelf()
            async let connection = session.getConnectionState()
            async let info = session.getInfo()
            return ServerState(
                entry: entry,
                info: try await info,
                connection: try await connection,
                me: try await me,
                conversations: try await conversations,
                channels: try await channels,
                voice: try await voice,
                calls: try await calls,
                users: Dictionary(uniqueKeysWithValues: try await users.map { ($0.id, $0) }),
                emotes: try await emotes,
                sounds: try await sounds,
                prefs: try await prefs
            )
        } catch {
            toast("Couldn't load \(entry.name). \(ErrorText.describe(error))", .error)
            return nil
        }
    }

    /// Each server's whole emote set onto disk once the app has settled, and again when a
    /// set changes, as the desktop's Shell does (useEmotePrefetch).
    private func prefetchEmotesSoon() {
        emotePrefetch?.cancel()
        emotePrefetch = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled else { return }
            for server in servers.values {
                let set = "\(server.emotes.setId)/\(server.emotes.emotes.count)"
                guard prefetchedEmotes[server.entry.id] != set else { continue }
                prefetchedEmotes[server.entry.id] = set
                EmoteImages.shared.prefetch(server.emotes.emotes, serverUrl: server.entry.url)
            }
        }
    }

    /// After signing in or joining: the new server becomes the active one.
    func addServer(_ serverId: String) async {
        await load()
        selectServer(serverId)
    }

    /// Signs out of a server on this device and erases its local data, as the desktop's "Sign out" does.
    func signOut(_ serverId: String) async {
        do {
            try await core.leaveServer(serverId)
            removeServer(serverId)
        } catch {
            toast(ErrorText.describe(error), .error)
        }
    }

    /// Deletes the account on a server, and then this device's copy of it, as the desktop's "Delete account" does.
    func deleteAccount(_ serverId: String, password: String) async throws {
        try await core.deleteAccount(serverId, password: password)
        removeServer(serverId)
    }

    /// Fewer animations: the app's own setting, or the system's.
    var reduceMotion: Bool {
        settings.reduceMotion || UIAccessibility.isReduceMotionEnabled
    }

    /// The join screens are done: the new server opens on its chat list.
    func finishJoining(_ serverId: String) async {
        await addServer(serverId)
        accountFlowActive = false
        onboarding = order.isEmpty
        joining = false
        tab = .chats
    }

    /// A `zuna://join?link=…` link, or an invite link shared to the app.
    func open(link: String) {
        pendingLink = link
        if !onboarding { joining = true }
    }

    /// Makes a server the active one, for its chats and its settings.
    func selectServer(_ serverId: String) {
        if serverId != activeServerId { closeChats() }
        activeServerId = serverId
    }

    /// Back to the lists on both tabs, as when the server changes.
    private func closeChats() {
        chatsPath = []
        channelsPath = []
    }

    /// Reorders the list of servers, as dragging them on the desktop's rail does.
    func moveServers(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        let ids = order
        Task {
            do { try await core.reorderServers(ids) } catch { toast(ErrorText.describe(error), .error) }
        }
    }

    // MARK: Events

    func handle(_ event: CoreEvent) {
        if servers[event.serverId] == nil, !event.isSignedOut {
            // A server signed in to elsewhere, such as the onboarding screens or a test.
            reloadSoon()
            return
        }
        switch event {
        case let .connection(serverId, state):
            servers[serverId]?.connection = state
            if state == .online { checkCaughtUp(serverId) }
        case let .conversations(serverId):
            refresh("conversations", serverId)
        case let .read(serverId, groupId, userId, seq):
            readMoved(serverId, groupId: groupId, userId: userId, seq: seq)
        case let .channels(serverId):
            refresh("conversations", serverId)
            refresh("voice", serverId)
        case let .voice(serverId, channelId, userId, deviceId, member):
            servers[serverId]?.voice[deviceId] = member
            if let member { voice.memberChanged(serverId: serverId, member) } else { voice.memberLeft(serverId: serverId, roomId: channelId, userId: userId) }
        case let .voiceKey(serverId, channelId):
            voice.keyChanged(serverId: serverId, channelId: channelId)
        case let .voiceEnded(serverId, channelId, reason):
            voice.ended(serverId: serverId, channelId: channelId, reason: reason)
        case let .screenEnded(serverId, channelId, reason):
            voice.screenEnded(serverId: serverId, channelId: channelId, reason: reason)
        case let .call(serverId, groupId, call):
            servers[serverId]?.calls[groupId] = call
            voice.callChanged(serverId: serverId, groupId: groupId, call: call)
        case let .calls(serverId):
            refresh("calls", serverId)
        case let .users(serverId):
            refresh("users", serverId)
            refresh("conversations", serverId)
        case let .message(serverId, message, _):
            upsert(serverId, message)
            if message.deletedAt != nil { onMessageGone?(serverId, message.groupId, message.id) }
        case let .messageRemoved(serverId, groupId, id):
            remove(serverId, groupId: groupId, id: id)
            onMessageGone?(serverId, groupId, id)
        case let .messageMoved(serverId, fromGroupId, message):
            move(serverId, from: fromGroupId, message)
        case let .presence(serverId, userId, online, lastSeenAt):
            liveState(serverId).setPresence(userId, online: online, lastSeenAt: lastSeenAt)
        case let .typing(serverId, groupId, userId):
            let live = liveState(serverId)
            live.startTyping(userId, in: groupId)
            Task { [weak live] in
                try? await Task.sleep(for: .milliseconds(5100))
                live?.stopTyping(userId, in: groupId)
            }
        case let .settings(serverId, info):
            servers[serverId]?.info = info
            servers[serverId]?.entry.name = info.name
            servers[serverId]?.entry.hasIcon = info.hasIcon
        case let .emotes(serverId):
            refresh("emotes", serverId)
        case let .sounds(serverId):
            refresh("sounds", serverId)
        case let .sound(serverId, channelId, userId, soundId):
            voice.soundPlayed(serverId: serverId, channelId: channelId, userId: userId, soundId: soundId)
        case let .preferences(serverId):
            refresh("preferences", serverId)
        case let .signedOut(serverId, reason):
            voice.serverGone(serverId)
            let name = servers[serverId]?.entry.name ?? "a server"
            // Nothing is erased on the server's word: what's here stays until the person decides.
            servers[serverId]?.entry.signedOut = reason
            toast(
                reason == "banned" ? "You were removed from \(name) by its admins."
                    : reason == "account_deleted" ? "Your account on \(name) was deleted from another device."
                    : "You've been signed out of \(name)."
            )
        case let .signedIn(serverId):
            servers[serverId]?.entry.signedOut = nil
        case let .security(_, _, message):
            toast(message, .security)
        case let .notify(serverId, _, _, _, groupId, messageId):
            onNotify?(serverId, groupId, messageId)
        case .activity:
            // The core already holds notifications back while the person is on another device.
            break
        }
    }

    private var reloading = false

    private func reloadSoon() {
        guard !reloading else { return }
        reloading = true
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(60))
            await self?.load()
            self?.reloading = false
        }
    }

    private func removeServer(_ serverId: String) {
        defer { onServersChanged?() }
        voice.serverGone(serverId)
        servers[serverId] = nil
        liveStates[serverId] = nil
        // What was kept for its chats goes with it: their messages, drafts and staged files.
        let prefix = "\(serverId)/"
        lists = lists.filter { !$0.key.hasPrefix(prefix) }
        listOpened = listOpened.filter { !$0.key.hasPrefix(prefix) }
        for (key, composer) in composers where key.hasPrefix(prefix) {
            for staged in composer.files { try? FileManager.default.removeItem(atPath: staged.file.blob.path) }
        }
        composers = composers.filter { !$0.key.hasPrefix(prefix) }
        editingInPlace = editingInPlace.filter { !$0.key.hasPrefix(prefix) }
        inPlaceText = inPlaceText.filter { !$0.key.hasPrefix(prefix) }
        savedPositions = savedPositions.filter { !$0.key.hasPrefix(prefix) }
        readsWanted = readsWanted.filter { !$0.key.hasPrefix(prefix) }
        order.removeAll { $0 == serverId }
        if activeServerId == serverId {
            closeChats()
            activeServerId = order.first
        }
        if order.isEmpty { onboarding = true }
    }

    /// Someone else reading on only moves the ticks in one conversation, so it's set there,
    /// rather than every conversation and channel fetched again for each receipt, as the web's
    /// and the native app's are. This person's own comes with `.conversations` too, for what's unread.
    private func readMoved(_ serverId: String, groupId: String, userId: String, seq: Int) {
        guard let server = servers[serverId], userId != server.me?.userId,
              let index = server.conversations.firstIndex(where: { $0.groupId == groupId }),
              server.conversations[index].readBy[userId] ?? 0 < seq else { return }
        servers[serverId]?.conversations[index].readBy[userId] = seq
    }

    /// Coalesces bursts of events into one refresh, like the desktop's `debounced`.
    private func refresh(_ what: String, _ serverId: String) {
        let key = "\(what):\(serverId)"
        guard pendingRefreshes.insert(key).inserted else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(60))
            guard let self else { return }
            pendingRefreshes.remove(key)
            refreshesInFlight.insert(key)
            defer {
                refreshesInFlight.remove(key)
                if what == "conversations" { checkCaughtUp(serverId) }
            }
            let session = core.session(serverId)
            do {
                switch what {
                case "conversations":
                    async let conversations = session.getConversations()
                    async let channels = session.getChannels()
                    let (listed, joined) = try await (conversations, channels)
                    servers[serverId]?.conversations = listed
                    servers[serverId]?.channels = joined
                case "voice":
                    let members = try await session.getVoiceMembers()
                    servers[serverId]?.voice = Dictionary(members.map { ($0.deviceId, $0) }, uniquingKeysWith: { $1 })
                case "calls":
                    async let calls = session.getCalls()
                    async let members = session.getVoiceMembers()
                    let (listed, inRooms) = try await (calls, members)
                    servers[serverId]?.voice = Dictionary(inRooms.map { ($0.deviceId, $0) }, uniquingKeysWith: { $1 })
                    servers[serverId]?.calls = Dictionary(listed.map { ($0.groupId, $0) }, uniquingKeysWith: { $1 })
                    voice.callsChanged(serverId: serverId)
                case "users":
                    let users = try await session.getUsers()
                    let me = try await session.getSelf()
                    servers[serverId]?.setUsers(Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) }))
                    servers[serverId]?.me = me
                    liveStates[serverId]?.forgetPresence()
                case "emotes":
                    let emotes = try await session.getEmotes()
                    servers[serverId]?.emotes = emotes
                    prefetchEmotesSoon()
                case "sounds":
                    let sounds = try await session.getSounds()
                    servers[serverId]?.sounds = sounds
                case "preferences":
                    let prefs = try await session.getPreferences()
                    servers[serverId]?.prefs = prefs
                default:
                    break
                }
            } catch {
                // The server may have just been removed.
            }
        }
    }

    /// Tells `onCaughtUp` once a server's conversations reflect everything it said, and not before.
    private func checkCaughtUp(_ serverId: String) {
        let key = "conversations:\(serverId)"
        guard servers[serverId]?.connection == .online, !pendingRefreshes.contains(key), !refreshesInFlight.contains(key) else { return }
        onCaughtUp?(serverId)
    }

    // MARK: Conversation preferences

    enum PreferenceList { case pinned, hidden }

    /// Pins, mutes or hides a conversation, or undoes it. Synced to the account's other devices through the vault.
    func toggle(_ list: PreferenceList, _ key: String, on serverId: String) {
        guard let prefs = servers[serverId]?.prefs else { return }
        func flipped(_ keys: [String]) -> [String] {
            keys.contains(key) ? keys.filter { $0 != key } : keys + [key]
        }
        let changes = switch list {
        case .pinned: PreferenceChanges(pinned: flipped(prefs.pinned))
        case .hidden: PreferenceChanges(hidden: flipped(prefs.hidden))
        }
        perform(serverId) { try await $0.updatePreferences(changes) }
    }

    /// Runs a call on a server's session in the background, saying in a toast if it failed.
    private func perform(_ serverId: String, failure: String = "Couldn't save that.", _ call: @escaping @MainActor (SessionCalls) async throws -> Void) {
        let session = core.session(serverId)
        Task {
            do {
                try await call(session)
            } catch {
                toast("\(failure) \(ErrorText.describe(error))", .error)
            }
        }
    }

    /// Marks a chat as unread, or takes the mark off. Synced like the other preferences.
    func setMarkedUnread(_ key: String, _ marked: Bool, on serverId: String) {
        perform(serverId) { try await $0.setMarkedUnread(key, marked: marked) }
    }

    /// Blocks someone, or unblocks them. Synced like the other preferences, and nobody is told.
    func setBlocked(_ userId: String, _ blocked: Bool, on serverId: String) {
        perform(serverId) { try await $0.setBlocked(userId, blocked: blocked) }
    }

    /// Has a group notify only about messages that mention you or reply to you. Synced like the other preferences.
    func setMentionsOnly(_ key: String, _ on: Bool, on serverId: String) {
        perform(serverId) { try await $0.setMentionsOnly(key, on: on) }
    }

    /// Reads a chat to its newest message from the list, without opening it.
    func markChatRead(_ key: String, on serverId: String) {
        perform(serverId, failure: "Couldn't mark it as read.") { try await $0.markChatRead(key) }
    }

    /// Mutes a chat until a time, or (nil) until it's unmuted. Synced like the other preferences.
    func mute(_ key: String, until: Date?, on serverId: String) {
        let millis = until.map { $0.timeIntervalSince1970 * 1000 }
        perform(serverId) { try await $0.mute(key, until: millis) }
    }

    func unmute(_ key: String, on serverId: String) {
        perform(serverId) { try await $0.unmute(key) }
    }

    // MARK: Toasts

    func toast(_ message: String, _ kind: Toast.Kind = .info) {
        // The same again, as a failure repeated, shows once, from now.
        toasts.removeAll { $0.message == message && $0.kind == kind }
        let toast = Toast(id: nextToast, kind: kind, message: message)
        nextToast += 1
        toasts = Array(toasts.suffix(3)) + [toast]
        // VoiceOver says it, as a toast that only shows would go unheard: at once, over what
        // it's saying, for errors and security warnings.
        let priority: UIAccessibilityPriority = kind == .info ? .default : .high
        UIAccessibility.post(notification: .announcement, argument: NSAttributedString(string: message, attributes: [.accessibilitySpeechAnnouncementPriority: priority]))
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(kind == .security ? 12 : 4.5))
            self?.dismissToast(toast.id)
        }
    }

    func dismissToast(_ id: Int) {
        toasts.removeAll { $0.id == id }
    }
}

/// A screen on the Chats tab's stack: a server's chats, over the list of
/// servers, and the chats and details opened from them.
enum ChatRoute: Hashable {
    case chat(String)
    case details(String)
    case pins(String)
    /// One kind of thing from a chat's details, such as its photos.
    case media(String, SharedKind)
}
