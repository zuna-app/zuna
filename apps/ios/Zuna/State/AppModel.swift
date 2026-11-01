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
        var users: [String: UserView] {
            didSet { mentionable = Self.mentionable(users) }
        }
        /// Lowercased username to user ID, for highlighting mentions. Changes only with the people, not with presence.
        private(set) var mentionable: [String: String]
        var emotes: EmoteSet
        var prefs: Preferences
        /// groupId -> userId -> when the typing indicator expires.
        var typing: [String: [String: Date]] = [:]

        init(entry: ServerEntry, info: ServerInfo?, connection: ConnectionState, me: SelfInfo?, conversations: [ConversationView], users: [String: UserView], emotes: EmoteSet, prefs: Preferences) {
            self.entry = entry
            self.info = info
            self.connection = connection
            self.me = me
            self.conversations = conversations
            self.users = users
            self.mentionable = Self.mentionable(users)
            self.emotes = emotes
            self.prefs = prefs
        }

        private static func mentionable(_ users: [String: UserView]) -> [String: String] {
            Dictionary(users.values.map { ($0.username.lowercased(), $0.id) }, uniquingKeysWith: { first, _ in first })
        }

        /// Unread messages outside muted conversations, for the list of servers.
        var unread: Int {
            conversations.reduce(0) { $0 + ($1.muted ? 0 : $1.unread) }
        }

        var selfUser: UserView? {
            me.flatMap { users[$0.userId] }
        }
    }

    struct Toast: Identifiable, Equatable {
        enum Kind { case info, error, security }
        let id: Int
        let kind: Kind
        let message: String
    }

    enum Tab: Hashable { case chats, settings }

    private(set) var servers: [String: ServerState] = [:]
    private(set) var order: [String] = []
    /// The server whose chats are open, remembered for the next launch, as Mail remembers its mailbox.
    var activeServerId: String? {
        didSet { AppSettings.lastServer = activeServerId }
    }
    var tab: Tab = .chats
    /// The list of servers is on screen rather than a server's chats. Only
    /// with more than one server; with one, the Chats tab opens on its chats.
    var showingServers = false
    /// The welcome screens: until the first server is joined, and again if none are left.
    private(set) var onboarding = false
    /// While the join screens are signing up or in. They decide when they're
    /// done, since a new account still has its recovery key to show.
    var accountFlowActive = false
    /// The join screens over the app, for another server.
    var joining = false
    /// An invite link opened from outside the app, for the join screens to pick up.
    var pendingLink: String?
    /// The screens opened from the conversation list: chats and their details.
    var chatPath: [ChatRoute] = []

    /// Opens a conversation from anywhere, like the desktop's selectConversation.
    func openChat(_ conversationKey: String) {
        tab = .chats
        showingServers = false
        chatPath = [.chat(conversationKey)]
    }

    /// With more than one server, the Chats tab starts at the list of them, as
    /// Mail starts at its mailboxes.
    var hasServerList: Bool {
        order.count > 1
    }

    /// The Chats tab's stack on a phone: the active server's chats over the
    /// list of servers, when there is one, then the chats opened from them.
    var chatsStack: [ChatRoute] {
        get {
            guard hasServerList else { return chatPath }
            guard !showingServers, let activeServerId else { return [] }
            return [.server(activeServerId)] + chatPath
        }
        set {
            guard hasServerList else {
                chatPath = newValue
                return
            }
            guard case let .server(serverId)? = newValue.first else {
                // Back at the list of servers.
                showingServers = true
                chatPath = []
                return
            }
            selectServer(serverId)
            showingServers = false
            chatPath = Array(newValue.dropFirst())
        }
    }
    /// Loaded messages, by `listKey(serverId, listId)` (see MessageLists.swift).
    var lists: [String: MessageList] = [:]
    var jumpTarget: JumpTarget?
    var nextJump = 0
    /// Files on their way into the open chat's composer: dropped on an iPad, or added by a UI test.
    var pendingAttachments: [URL] = []
    /// Drafts, replies, edits and files being written, by `composerKey(serverId, conversationKey)`.
    var composers: [String: ComposerState] = [:]
    /// Where each chat was scrolled to, when it wasn't at the newest message: the message at the top of the screen.
    @ObservationIgnored var savedPositions: [String: String] = [:]
    private(set) var toasts: [Toast] = []
    var settings = AppSettings.load() {
        didSet { settings.save() }
    }
    /// App lock is waiting for Face ID, Touch ID or the passcode; nothing under it shows or is read out.
    var appLocked = AppSettings.load().appLock

    let core: CoreConnection
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

    init(core: CoreConnection) {
        self.core = core
    }

    var activeServer: ServerState? {
        activeServerId.flatMap { servers[$0] }
    }

    /// Unread messages on every server, for the Chats tab, like the desktop's dock badge.
    var totalUnread: Int {
        servers.values.reduce(0) { $0 + $1.unread }
    }


    // MARK: Loading

    /// Loads every server's state. Also used when a server appears that the
    /// model doesn't know yet; a sign-in replaces any earlier account on the
    /// same server, so servers that are gone are dropped.
    func load() async {
        do {
            let entries = try await core.listServers()
            var loaded: [String: ServerState] = [:]
            for entry in entries {
                loaded[entry.id] = await loadServer(entry)
            }
            servers = loaded
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
            toast("Couldn't load your servers: \(error)", .error)
        }
    }

    private func loadServer(_ entry: ServerEntry) async -> ServerState? {
        let session = core.session(entry.id)
        do {
            async let conversations = session.getConversations()
            async let users = session.getUsers()
            async let emotes = session.getEmotes()
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
                users: Dictionary(uniqueKeysWithValues: try await users.map { ($0.id, $0) }),
                emotes: try await emotes,
                prefs: try await prefs
            )
        } catch {
            toast("Couldn't load \(entry.name): \(error)", .error)
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
            toast(OnboardingText.describe(error), .error)
        }
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
        showingServers = false
        tab = .chats
    }

    /// A `zuna://join?link=…` link, or an invite link shared to the app.
    func open(link: String) {
        pendingLink = link
        if !onboarding { joining = true }
    }

    /// Makes a server the active one, for its chats and its settings.
    func selectServer(_ serverId: String) {
        if serverId != activeServerId { chatPath = [] }
        activeServerId = serverId
    }

    /// Opens a server's chats from the list of servers.
    func openServer(_ serverId: String) {
        selectServer(serverId)
        showingServers = false
    }

    /// Reorders the list of servers, as dragging them on the desktop's rail does.
    func moveServers(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        let ids = order
        Task {
            do { try await core.reorderServers(ids) } catch { toast(OnboardingText.describe(error), .error) }
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
        case let .conversations(serverId), let .read(serverId, _, _, _):
            refresh("conversations", serverId)
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
            servers[serverId]?.users[userId]?.online = online
            servers[serverId]?.users[userId]?.lastSeenAt = lastSeenAt
        case let .typing(serverId, groupId, userId):
            servers[serverId]?.typing[groupId, default: [:]][userId] = Date().addingTimeInterval(5)
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(5100))
                guard let self, let expiry = servers[serverId]?.typing[groupId]?[userId], expiry <= Date() else { return }
                servers[serverId]?.typing[groupId]?[userId] = nil
            }
        case let .settings(serverId, info):
            servers[serverId]?.info = info
            servers[serverId]?.entry.name = info.name
            servers[serverId]?.entry.hasIcon = info.hasIcon
        case let .emotes(serverId):
            refresh("emotes", serverId)
        case let .preferences(serverId):
            refresh("preferences", serverId)
        case let .signedOut(serverId, reason):
            // Nothing is erased on the server's word: what's here stays until the person decides.
            servers[serverId]?.entry.signedOut = reason
            toast(reason == "banned" ? "You were removed from a server by its admins." : "You've been signed out of a server.")
        case let .signedIn(serverId):
            servers[serverId]?.entry.signedOut = nil
        case let .security(_, _, message):
            toast(message, .security)
        case let .notify(serverId, _, _, _, groupId, messageId):
            onNotify?(serverId, groupId, messageId)
        case .activity:
            // The core already keeps notifications where the person is.
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
        servers[serverId] = nil
        lists = lists.filter { !$0.key.hasPrefix("\(serverId)/") }
        order.removeAll { $0 == serverId }
        if activeServerId == serverId {
            chatPath = []
            activeServerId = order.first
            // Back to the servers that are left, rather than into one of them.
            showingServers = hasServerList
        }
        if order.isEmpty { onboarding = true }
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
                    let conversations = try await session.getConversations()
                    servers[serverId]?.conversations = conversations
                case "users":
                    let users = try await session.getUsers()
                    let me = try await session.getSelf()
                    servers[serverId]?.users = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })
                    servers[serverId]?.me = me
                case "emotes":
                    let emotes = try await session.getEmotes()
                    servers[serverId]?.emotes = emotes
                    prefetchEmotesSoon()
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
        Task {
            do {
                try await core.session(serverId).updatePreferences(changes)
            } catch {
                toast("Couldn't save that: \(error)", .error)
            }
        }
    }

    /// Mutes a chat until a time, or (nil) until it's unmuted. Synced like the other preferences.
    func mute(_ key: String, until: Date?, on serverId: String) {
        let session = core.session(serverId)
        Task {
            do {
                try await session.mute(key, until: until.map { $0.timeIntervalSince1970 * 1000 })
            } catch {
                toast("Couldn't save that: \(error)", .error)
            }
        }
    }

    func unmute(_ key: String, on serverId: String) {
        let session = core.session(serverId)
        Task {
            do {
                try await session.unmute(key)
            } catch {
                toast("Couldn't save that: \(error)", .error)
            }
        }
    }

    // MARK: Toasts

    func toast(_ message: String, _ kind: Toast.Kind = .info) {
        let toast = Toast(id: nextToast, kind: kind, message: message)
        nextToast += 1
        toasts = Array(toasts.suffix(3)) + [toast]
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
    case server(String)
    case chat(String)
    case details(String)
    case pins(String)
    /// One kind of thing from a chat's details, such as its photos.
    case media(String, SharedKind)
}
