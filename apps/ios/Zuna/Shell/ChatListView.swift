import SwiftUI
import ZunaModels

/// The server ended this device's session. Nothing is erased on its word: what's
/// here stays until the person signs in again or clears it, or after a month.
struct SignedOutView: View {
    @Environment(AppModel.self) private var model
    let server: AppModel.ServerState
    let reason: String

    var body: some View {
        VStack(spacing: 14) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.text1)
                .multilineTextAlignment(.center)
            Text(reason == "account_deleted"
                ? "\(explanation) What's on this device stays here for 30 days, or until you remove it."
                : "\(explanation) What's on this device stays here for 30 days, or until you sign in again or remove it.")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .multilineTextAlignment(.center)
            if reason != "banned" && reason != "account_deleted" {
                Button("Sign in again") {
                    model.signInAgain = server.entry.address
                    model.joining = true
                }
                .buttonStyle(.borderedProminent)
            }
            Button("Remove from this device", role: .destructive) {
                Task { await model.signOut(server.entry.id) }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var title: String {
        switch reason {
        case "banned": "You were removed from \(server.entry.name)"
        case "account_deleted": "Your account on \(server.entry.name) was deleted"
        default: "You're signed out of \(server.entry.name)"
        }
    }

    private var explanation: String {
        switch reason {
        case "device_revoked": "This device was removed from your account."
        case "banned": "Its admins ended your access."
        case "account_deleted": "It was deleted from another of your devices."
        default: "The server ended this device's session."
        }
    }
}

/// The active server's conversations, laid out like Telegram's chat list: a
/// search bar, filters, then the rows. The title shows the connection state
/// while it isn't connected, as Telegram does. On a phone the channels have
/// a tab of their own; on an iPad, which has no tabs, they head this list.
struct ChatListView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", channels = "Channels", people = "People", groups = "Groups", unread = "Unread"
        var id: Self { self }
    }

    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var filter = Filter.all
    @State private var showHidden = false
    @State private var messageHits: [SearchResult] = []
    @State private var sheet: ListSheet?
    /// A chat whose mute is being chosen, from its swipe action.
    @State private var muting: MutingTarget?
    @State private var deletingChannel: ChannelView?

    struct MutingTarget: Identifiable {
        let key: String
        let title: String
        let serverId: String
        var id: String { key }
    }

    private enum ListSheet: Identifiable {
        case invite, newGroup
        case channel(ChannelEditor.Target)

        var id: String {
            switch self {
            case .invite: "invite"
            case .newGroup: "newGroup"
            case let .channel(target): "channel-\(target.id)"
            }
        }
    }

    /// On a phone, the list is on the Chats tab's stack and chats are pushed
    /// over it; on an iPad, it's the column beside the open chat.
    var sidebar = false
    /// Opens Settings, on an iPad, which has no tab bar.
    var onSettings: (() -> Void)?

    var body: some View {
        Group {
            if let server = model.activeServer {
                if let reason = server.entry.signedOut {
                    SignedOutView(server: server, reason: reason)
                } else {
                    list(server)
                }
            } else {
                Color.clear
            }
        }
        .background(Theme.bg0)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !sidebar {
                ServerToolbarItem()
            }
            if let onSettings {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: onSettings) {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier(A11y.Shell.settingsTab)
                }
            }
            ToolbarItem(placement: .principal) { serverMenu }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    sheet = .newGroup
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("New group")
                .accessibilityIdentifier(A11y.Shell.newGroup)
            }
        }
        .sheet(item: $sheet) { sheet in
            if let serverId = model.activeServerId {
                switch sheet {
                case .invite: InviteSheet(serverId: serverId)
                case .newGroup: NewGroupSheet(serverId: serverId)
                case let .channel(target): ChannelEditor(serverId: serverId, target: target)
                }
            }
        }
        .confirmationDialog(muting.map { "Mute \($0.title)" } ?? "", isPresented: Binding(get: { muting != nil }, set: { if !$0 { muting = nil } }), titleVisibility: .visible, presenting: muting) { target in
            MuteButtons(conversationKey: target.key, serverId: target.serverId)
        }
        .confirmationDialog(deletingChannel.map { "Delete #\($0.title)? Its messages go for everyone." } ?? "", isPresented: Binding(get: { deletingChannel != nil }, set: { if !$0 { deletingChannel = nil } }), titleVisibility: .visible, presenting: deletingChannel) { channel in
            Button("Delete channel", role: .destructive) {
                if let serverId = model.activeServerId { model.deleteChannel(channel, on: serverId) }
            }
        }
        .toolbarBackground(Theme.bg0, for: .navigationBar)
        .task(id: SearchKey(serverId: model.activeServerId, query: query)) { await searchMessages() }
        .onChange(of: model.activeServerId) {
            query = ""
            showHidden = false
        }
        .onChange(of: model.activeServer.map(showsChannels) ?? false) { _, shows in
            if !shows, filter == .channels { filter = .all }
        }
    }

    // MARK: List

    private func list(_ server: AppModel.ServerState) -> some View {
        let (visible, hidden) = partition(server)
        let needle = query.trimmingCharacters(in: .whitespaces)
        // On a phone the channels have a tab of their own, but searching here still finds them by name.
        let channelHits = !needle.isEmpty && server.showsChannels && server.channels.contains { $0.name.lowercased().contains(needle.lowercased()) }
        let channels = (showsChannels(server) || channelHits) && (filter == .all || filter == .channels)
        return PullSearchList(query: $query, prompt: "Search", identifier: A11y.ChatList.search, resetKey: model.activeServerId) {
            Section {
                // The server's channels first, as on the desktop.
                if channels {
                    ChannelRows(server: server, query: query, sidebar: sidebar, actions: channelActions(server))
                    if !visible.isEmpty {
                        Color.clear
                            .frame(height: 10)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Theme.bg0)
                            .listRowSeparator(.hidden)
                    }
                }
                ForEach(visible) { row($0, server) }
                if visible.isEmpty, hidden.isEmpty, messageHits.isEmpty, !channelHits, filter != .channels {
                    emptyState(searching: !needle.isEmpty)
                }
            }
            .listSectionSeparator(.hidden, edges: .top)
            if !hidden.isEmpty {
                Section {
                    if showHidden {
                        ForEach(hidden) { row($0, server) }
                    }
                } header: {
                    Button {
                        withAnimation { showHidden.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right")
                                .rotationEffect(.degrees(showHidden ? 90 : 0))
                            Text("Hidden (\(hidden.count))")
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(A11y.ChatList.hiddenToggle)
                }
            }
            if !messageHits.isEmpty {
                Section {
                    ForEach(messageHits, id: \.message.id) { hit in
                        Button {
                            open(hit, serverId: server.entry.id)
                        } label: {
                            MessageHitRow(hit: hit, server: server)
                        }
                        .buttonStyle(.plain)
                            .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 14))
                            .listRowBackground(Theme.bg0)
                            .listRowSeparatorTint(Theme.line)
                    }
                } header: {
                    Text("Messages")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                }
            }
        }
        // On the list itself: on what holds the filters too, it would take the filters' own.
        .accessibilityIdentifier(A11y.ChatList.list)
        .listStyle(.plain)
        // Channel rows are Discord's height, lower than the list's usual rows.
        .environment(\.defaultMinListRowHeight, 1)
        // The filters stay above the list, close under the search bar: a plain
        // list's section header would take a gap above it that can't be set.
        .contentMargins(.top, 0, for: .scrollContent)
        .safeAreaInset(edge: .top, spacing: 0) {
            filterBar(server)
                .padding(.horizontal, 16)
                .background(Theme.bg0)
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .animation(model.reduceMotion ? nil : .snappy(duration: 0.25), value: visible.map(\.key))
    }

    private func row(_ conversation: ConversationView, _ server: AppModel.ServerState) -> some View {
        // On an iPad the open chat is beside the list, so its row stays marked, as on the desktop.
        let open = sidebar && model.chatPath.first == .chat(conversation.key)
        return Button {
            model.openChat(conversation.key)
        } label: {
            ChatRow(conversation: conversation, server: server)
        }
        .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 14))
            .listRowBackground(open ? Theme.bg3 : Theme.bg0)
            .accessibilityAddTraits(open ? .isSelected : [])
            .listRowSeparatorTint(Theme.line)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 76 }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if conversation.unread > 0 || conversation.markedUnread {
                    Button {
                        model.markChatRead(conversation.key, on: server.entry.id)
                    } label: {
                        Label("Read", systemImage: "message.fill")
                    }
                    .tint(model.settings.accent.color)
                } else if conversation.groupId != nil {
                    Button {
                        model.setMarkedUnread(conversation.key, true, on: server.entry.id)
                    } label: {
                        Label("Unread", systemImage: "message.badge.fill")
                    }
                    .tint(model.settings.accent.color)
                }
                Button {
                    model.toggle(.pinned, conversation.key, on: server.entry.id)
                } label: {
                    Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash.fill" : "pin.fill")
                }
                .tint(Theme.green)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button {
                    model.toggle(.hidden, conversation.key, on: server.entry.id)
                } label: {
                    Label(conversation.hidden ? "Show" : "Hide", systemImage: conversation.hidden ? "eye.fill" : "eye.slash.fill")
                }
                .tint(Theme.bg5)
                Button {
                    if conversation.muted {
                        model.unmute(conversation.key, on: server.entry.id)
                    } else {
                        muting = MutingTarget(key: conversation.key, title: conversation.title, serverId: server.entry.id)
                    }
                } label: {
                    Label(conversation.muted ? "Unmute" : "Mute", systemImage: conversation.muted ? "speaker.wave.2.fill" : "speaker.slash.fill")
                }
                .tint(Theme.amber)
            }
            .contextMenu {
                if conversation.unread > 0 || conversation.markedUnread {
                    Button {
                        model.markChatRead(conversation.key, on: server.entry.id)
                    } label: {
                        Label("Mark as read", systemImage: "checkmark.message")
                    }
                } else if conversation.groupId != nil {
                    Button {
                        model.setMarkedUnread(conversation.key, true, on: server.entry.id)
                    } label: {
                        Label("Mark as unread", systemImage: "message.badge")
                    }
                }
                Button {
                    model.toggle(.pinned, conversation.key, on: server.entry.id)
                } label: {
                    Label(conversation.pinned ? "Unpin" : "Pin to top", systemImage: conversation.pinned ? "pin.slash" : "pin")
                }
                if conversation.muted {
                    Button {
                        model.unmute(conversation.key, on: server.entry.id)
                    } label: {
                        Label("Unmute", systemImage: "speaker.wave.2")
                    }
                } else {
                    Menu {
                        MuteButtons(conversationKey: conversation.key, serverId: server.entry.id)
                    } label: {
                        Label("Mute", systemImage: "speaker.slash")
                    }
                }
                Button {
                    model.toggle(.hidden, conversation.key, on: server.entry.id)
                } label: {
                    Label(conversation.hidden ? "Show in list" : "Hide from list", systemImage: conversation.hidden ? "eye" : "eye.slash")
                }
            }
    }

    /// What the filter and search let through, split into the list and its hidden part, as on the desktop.
    private func partition(_ server: AppModel.ServerState) -> (visible: [ConversationView], hidden: [ConversationView]) {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = server.conversations.filter { item in
            if !needle.isEmpty {
                let username = item.peerId.flatMap { server.users[$0]?.username.lowercased() } ?? ""
                if !item.title.lowercased().contains(needle), !username.contains(needle) { return false }
            }
            switch filter {
            case .all: return true
            case .channels: return false
            case .people: return item.kind == .dm
            case .groups: return item.kind == .group
            case .unread: return item.unread > 0 || item.markedUnread
            }
        }
        // Searching looks through hidden conversations too, so nothing gets lost.
        // People you blocked only turn up in a search.
        if !needle.isEmpty { return (filtered, []) }
        return (filtered.filter { !$0.hidden && !$0.blocked }, filtered.filter { $0.hidden && !$0.blocked })
    }

    private func filterBar(_ server: AppModel.ServerState) -> some View {
        Picker("Show", selection: $filter) {
            // Channels, when the server has some, as the desktop's tab.
            ForEach(Filter.allCases.filter { $0 != .channels || showsChannels(server) }) { item in
                Text(item.rawValue).tag(item)
            }
        }
        .pickerStyle(.segmented)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .accessibilityIdentifier(A11y.ChatList.filter)
    }

    @ViewBuilder
    private func emptyState(searching: Bool) -> some View {
        let (title, image): (String, String) = if searching {
            ("Nothing matches that search.", "magnifyingglass")
        } else {
            switch filter {
            case .unread: ("You're all caught up.", "checkmark.circle")
            case .groups: ("No groups yet.", "person.3")
            default: ("It's quiet here.", "bubble.left.and.bubble.right")
            }
        }
        ContentUnavailableView(title, systemImage: image)
            .foregroundStyle(Theme.text2)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
            .listRowBackground(Theme.bg0)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier(A11y.ChatList.empty)
    }

    // MARK: Channels

    /// Channels are in this list only beside the open chat on an iPad.
    private func showsChannels(_ server: AppModel.ServerState) -> Bool {
        sidebar && server.showsChannels
    }

    private func channelActions(_ server: AppModel.ServerState) -> ChannelListActions {
        ChannelListActions(
            create: { type, category in sheet = .channel(.new(type, category: category)) },
            edit: { sheet = .channel(.edit(channelId: $0.id)) },
            delete: { deletingChannel = $0 },
            mute: { muting = MutingTarget(key: $0.key, title: "#\($0.title)", serverId: server.entry.id) }
        )
    }

    // MARK: Message search

    /// Opens the chat on the message that was found, highlighted.
    private func open(_ hit: SearchResult, serverId: String) {
        Task {
            await model.jumpToMessage(serverId, groupId: hit.message.groupId, messageId: hit.message.id, seq: hit.message.seq)
            model.openChat(hit.conversationKey)
        }
    }

    private struct SearchKey: Equatable {
        let serverId: String?
        let query: String
    }

    /// Searches the encrypted index on this device, once typing pauses, from two characters on.
    private func searchMessages() async {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard needle.count >= 2, let serverId = model.activeServerId else {
            messageHits = []
            return
        }
        try? await Task.sleep(for: .milliseconds(120))
        guard !Task.isCancelled else { return }
        let hits = (try? await model.core.session(serverId).search(needle, limit: 30)) ?? []
        guard !Task.isCancelled else { return }
        messageHits = hits
    }

    // MARK: Navigation bar

    /// The server's menu under its name, as on the desktop. On an iPad with one
    /// server, joining another starts here; otherwise, from the list of servers.
    private var serverMenu: some View {
        Menu {
            Button("Invite people", systemImage: "link") { sheet = .invite }
            Button("New group", systemImage: "person.2") { sheet = .newGroup }
            if sidebar, model.activeServer?.isAdmin ?? false {
                Button("New channel", systemImage: "number") { sheet = .channel(.new(.text, category: "")) }
            }
            if sidebar, !model.hasServerList {
                Divider()
                Button("Join a server", systemImage: "plus") { model.joining = true }
            }
        } label: {
            HStack(spacing: 4) {
                title
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(Theme.text3)
            }
        }
        // The title is what the menu says, for VoiceOver and the tests.
        .accessibilityLabel(titleText(model.activeServer?.connection ?? .online))
        .accessibilityIdentifier(A11y.Shell.title)
    }

    private var title: some View {
        HStack(spacing: 8) {
            let connection = model.activeServer?.connection ?? .online
            if connection != .online {
                ProgressView().controlSize(.small)
            }
            Text(titleText(connection))
                .font(.headline)
                .foregroundStyle(Theme.text1)
                .lineLimit(1)
        }
    }

    private func titleText(_ connection: ConnectionState) -> String {
        switch connection {
        case .online: model.activeServer?.entry.name ?? "Zuna"
        case .syncing: "Updating…"
        case .connecting: "Connecting…"
        case .offline: "Waiting for network…"
        }
    }
}

/// One conversation: avatar, title with its marks, time, a two-line preview
/// and the unread count, as in Telegram.
private struct ChatRow: View {
    @Environment(AppModel.self) private var model
    let conversation: ConversationView
    let server: AppModel.ServerState

    var body: some View {
        let peer = conversation.peerId.flatMap { server.users[$0] }
        let selfId = server.me?.userId ?? ""
        let isSaved = conversation.peerId != nil && conversation.peerId == selfId
        HStack(spacing: 12) {
            avatar(peer: peer, isSaved: isSaved)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if conversation.kind == .group {
                        Image(systemName: "person.2.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.text3)
                    }
                    Text(conversation.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text1)
                        .lineLimit(1)
                    marks(peer: peer)
                    Spacer(minLength: 6)
                    HStack(spacing: 2) {
                        if let message = ownLast(selfId: selfId, isSaved: isSaved) {
                            ReadTicks(message: message, readUpTo: conversation.readUpTo(selfId: selfId), failed: Theme.red)
                                .foregroundStyle(Theme.text3)
                        }
                        Text(Format.listTime(conversation.lastMessage?.createdAt ?? 0))
                            .font(.subheadline)
                            .foregroundStyle((conversation.unread > 0 || conversation.markedUnread) && !conversation.muted ? Theme.text1 : Theme.text3)
                            .monospacedDigit()
                    }
                }
                HStack(alignment: .top, spacing: 6) {
                    preview(selfId: selfId, isSaved: isSaved, peer: peer)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    badge
                }
            }
        }
        .padding(.vertical, 8)
        .frame(minHeight: 76)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.ChatList.row(conversation.key))
    }

    @ViewBuilder
    private func avatar(peer: UserView?, isSaved: Bool) -> some View {
        if isSaved {
            Image(systemName: "bookmark.fill")
                .font(.system(size: 24))
                .foregroundStyle(Theme.text1)
                .frame(width: 56, height: 56)
                .background(Theme.bg4, in: .circle)
        } else {
            AvatarView(
                name: conversation.title,
                seed: conversation.peerId ?? conversation.groupId ?? conversation.key,
                source: conversation.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                size: 56,
                online: peer?.online ?? false
            )
        }
    }

    @ViewBuilder
    private func marks(peer: UserView?) -> some View {
        if peer?.trust == .verified {
            Image(systemName: "checkmark.seal.fill")
                .font(.caption)
                .foregroundStyle(Theme.text2)
                .accessibilityLabel("Verified")
        } else if peer?.trust == .changed {
            Image(systemName: "exclamationmark.shield.fill")
                .font(.caption)
                .foregroundStyle(Theme.amber)
                .accessibilityLabel("Security key changed")
        }
        if conversation.muted {
            Image(systemName: "speaker.slash.fill")
                .font(.caption2)
                .foregroundStyle(Theme.text3)
                .accessibilityLabel("Muted")
        }
        if conversation.blocked {
            Image(systemName: "nosign")
                .font(.caption2)
                .foregroundStyle(Theme.text3)
                .accessibilityLabel("Blocked")
        }
    }

    /// The last message when it's one you sent, to someone who can read it, so it
    /// shows its ticks beside the time, as in Telegram. Notes to yourself never get read.
    private func ownLast(selfId: String, isSaved: Bool) -> MessageView? {
        guard let message = conversation.lastMessage, message.senderId == selfId,
              message.system == nil, message.deletedAt == nil, !isSaved else { return nil }
        return message
    }

    @ViewBuilder
    private func preview(selfId: String, isSaved: Bool, peer: UserView?) -> some View {
        let typing = conversation.groupId.flatMap { server.typing[$0] }.map { !$0.isEmpty } ?? false
        let (author, body) = Format.preview(conversation.lastMessage, users: server.users, selfId: selfId, kind: conversation.kind)
        Group {
            if typing {
                Text("typing…").foregroundStyle(Theme.link)
            } else if conversation.groupId.flatMap({ server.calls[$0] }) != nil {
                Label("In a call", systemImage: "phone.fill").foregroundStyle(Theme.green)
            } else if body.isEmpty, author == nil {
                Text(isSaved ? "Notes to yourself" : peer.map { "@\($0.username)" } ?? "")
                    .foregroundStyle(Theme.text3)
            } else if let author {
                Text("\(Text(author + ": ").foregroundStyle(Theme.text1))\(Text(body).foregroundStyle(Theme.text2))")
            } else {
                Text(body).foregroundStyle(Theme.text2)
            }
        }
        .font(.subheadline)
        .lineLimit(2)
    }

    @ViewBuilder
    private var badge: some View {
        if conversation.unreadMentions > 0 {
            // A mention stands out even in a muted chat, as in Telegram.
            Image(systemName: "at")
                .font(.footnote.weight(.bold))
                .foregroundStyle(model.settings.accent.onAccent)
                .frame(width: 22, height: 22)
                .background(model.settings.accent.color, in: .circle)
                .padding(.top, 2)
                .accessibilityLabel("Mentions you")
        }
        if conversation.unread > 0 {
            let accent = model.settings.accent
            Text(conversation.unread > 99 ? "99+" : "\(conversation.unread)")
                .font(.footnote.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(conversation.muted ? Theme.text2 : accent.onAccent)
                .padding(.horizontal, 7)
                .frame(minWidth: 22, minHeight: 22)
                .background(conversation.muted ? Theme.bg5 : accent.color, in: .capsule)
                .padding(.top, 2)
                .accessibilityLabel("\(conversation.unread) unread")
        } else if conversation.markedUnread {
            Circle()
                .fill(conversation.muted ? Theme.bg5 : model.settings.accent.color)
                .frame(width: 22, height: 22)
                .padding(.top, 2)
                .accessibilityLabel("Marked as unread")
        } else if conversation.pinned {
            Image(systemName: "pin.fill")
                .font(.caption)
                .foregroundStyle(Theme.text3)
                .rotationEffect(.degrees(45))
                .padding(.top, 4)
                .accessibilityLabel("Pinned")
        }
    }
}

/// A message found by search: who sent it, where, and the text.
private struct MessageHitRow: View {
    let hit: SearchResult
    let server: AppModel.ServerState

    var body: some View {
        let sender = server.users[hit.message.senderId]
        let conversation = server.conversation(hit.conversationKey)
        let channel = server.channel(hit.conversationKey)
        HStack(spacing: 12) {
            AvatarView(
                name: sender?.displayName ?? "?",
                seed: hit.message.senderId,
                source: sender?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                size: 44
            )
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(channel.map { "#\($0.title)" } ?? conversation?.title ?? "Conversation")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text1)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(Format.listTime(hit.message.createdAt))
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                }
                Text(plainText(hit.message.text))
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.ChatList.messageHit(hit.message.id))
    }
}

/// The screen for a route on the chat stack.
struct ChatRouteView: View {
    @Environment(AppModel.self) private var model
    let route: ChatRoute

    var body: some View {
        switch route {
        case let .chat(key): ChatScreen(conversationKey: key)
        case let .details(key):
            if model.activeServer?.channel(key) != nil {
                ChannelDetails(conversationKey: key)
            } else {
                ConversationDetails(conversationKey: key)
            }
        case let .pins(key): PinnedMessagesView(conversationKey: key)
        case let .media(key, kind): SharedMediaView(conversationKey: key, kind: kind)
        }
    }
}
