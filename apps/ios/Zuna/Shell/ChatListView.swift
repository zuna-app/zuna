import SwiftUI
import ZunaModels

/// The active server's conversations, laid out like Telegram's chat list: a
/// search bar, filters, then the rows. The title shows the connection state
/// while it isn't connected, as Telegram does.
struct ChatListView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", people = "People", groups = "Groups", unread = "Unread"
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

    struct MutingTarget: Identifiable {
        let key: String
        let title: String
        let serverId: String
        var id: String { key }
    }

    private enum ListSheet: String, Identifiable {
        case invite, newGroup
        var id: String { rawValue }
    }

    /// On a phone, the list is on the Chats tab's stack and chats are pushed
    /// over it; on an iPad, it's the column beside the open chat.
    var sidebar = false
    /// Opens Settings, on an iPad, which has no tab bar.
    var onSettings: (() -> Void)?

    var body: some View {
        Group {
            if let server = model.activeServer {
                list(server)
            } else {
                Color.clear
            }
        }
        .background(Theme.bg0)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
                }
            }
        }
        .confirmationDialog(muting.map { "Mute \($0.title)" } ?? "", isPresented: Binding(get: { muting != nil }, set: { if !$0 { muting = nil } }), titleVisibility: .visible, presenting: muting) { target in
            MuteButtons(conversationKey: target.key, serverId: target.serverId)
        }
        .toolbarBackground(Theme.bg1, for: .navigationBar)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
        .task(id: SearchKey(serverId: model.activeServerId, query: query)) { await searchMessages() }
        .onChange(of: model.activeServerId) {
            query = ""
            showHidden = false
        }
    }

    // MARK: List

    private func list(_ server: AppModel.ServerState) -> some View {
        let (visible, hidden) = partition(server)
        let needle = query.trimmingCharacters(in: .whitespaces)
        return List {
            Section {
                ForEach(visible) { row($0, server) }
                if visible.isEmpty, hidden.isEmpty, messageHits.isEmpty {
                    emptyState(searching: !needle.isEmpty)
                }
            } header: {
                filterBar
            }
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
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .animation(model.reduceMotion ? nil : .snappy(duration: 0.25), value: visible.map(\.key))
        .accessibilityIdentifier(A11y.ChatList.list)
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
            case .people: return item.kind == .dm
            case .groups: return item.kind == .group
            case .unread: return item.unread > 0
            }
        }
        // Searching looks through hidden conversations too, so nothing gets lost.
        if !needle.isEmpty { return (filtered, []) }
        return (filtered.filter { !$0.hidden }, filtered.filter(\.hidden))
    }

    private var filterBar: some View {
        Picker("Show", selection: $filter) {
            ForEach(Filter.allCases) { item in
                Text(item.rawValue).tag(item)
            }
        }
        .pickerStyle(.segmented)
        .padding(.vertical, 6)
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

    /// The server's menu under its name, as on the desktop. With one server,
    /// joining another starts here; with more, from the list of servers.
    private var serverMenu: some View {
        Menu {
            Button("Invite people", systemImage: "link") { sheet = .invite }
            Button("New group", systemImage: "person.2") { sheet = .newGroup }
            if !model.hasServerList {
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
                    Text(Format.listTime(conversation.lastMessage?.createdAt ?? 0))
                        .font(.subheadline)
                        .foregroundStyle(conversation.unread > 0 && !conversation.muted ? Theme.text1 : Theme.text3)
                        .monospacedDigit()
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
    }

    @ViewBuilder
    private func preview(selfId: String, isSaved: Bool, peer: UserView?) -> some View {
        let typing = conversation.groupId.flatMap { server.typing[$0] }.map { !$0.isEmpty } ?? false
        let (author, body) = Format.preview(conversation.lastMessage, users: server.users, selfId: selfId, kind: conversation.kind)
        Group {
            if typing {
                Text("typing…").foregroundStyle(Theme.link)
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
        let conversation = server.conversations.first { $0.key == hit.conversationKey }
        HStack(spacing: 12) {
            AvatarView(
                name: sender?.displayName ?? "?",
                seed: hit.message.senderId,
                source: sender?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                size: 44
            )
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(conversation?.title ?? "Conversation")
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
    let route: ChatRoute

    var body: some View {
        switch route {
        // Always the active server's, since opening a server makes it the active one.
        case .server: ChatListView()
        case let .chat(key): ChatScreen(conversationKey: key)
        case let .details(key): ConversationDetails(conversationKey: key)
        }
    }
}
