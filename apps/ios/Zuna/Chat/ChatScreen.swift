import SwiftUI
import ZunaModels

/// A chat, laid out like Telegram's: who it's with and their status in the
/// bar, the pinned message, the messages with a button back to the newest one,
/// and the composer.
struct ChatScreen: View {
    let conversationKey: String

    @Environment(AppModel.self) private var model
    @Environment(ImageStore.self) private var images
    @Environment(\.scenePhase) private var scenePhase
    @State private var atBottom = true
    @State private var highlighted: String?
    @State private var bridge = MessageListBridge()
    @State private var emoteCard: EmoteCardInfo?
    @State private var sheet: ChatSheet?

    private enum ChatSheet: Identifiable {
        case search, pins
        case react(messageId: String)

        var id: String {
            switch self {
            case .search: "search"
            case .pins: "pins"
            case let .react(id): "react-\(id)"
            }
        }
    }

    var body: some View {
        ZStack {
            if let server = model.activeServer, let conversation = server.conversations.first(where: { $0.key == conversationKey }) {
                content(server, conversation)
            } else {
                ContentUnavailableView("This chat isn't available", systemImage: "bubble.left.and.exclamationmark.bubble.right")
            }
        }
        .background(Theme.bg0)
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg1, for: .navigationBar)
        // A container, so the screen's identifier doesn't replace its elements' own.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.screen)
    }

    private func content(_ server: AppModel.ServerState, _ conversation: ConversationView) -> some View {
        let serverId = server.entry.id
        let listId = AppModel.listId(for: conversation)
        let list = model.list(serverId, listId)
        let peer = conversation.peerId.flatMap { server.users[$0] }
        let isSaved = conversation.peerId != nil && conversation.peerId == server.me?.userId
        return VStack(spacing: 0) {
            if peer?.trust == .changed, !isSaved {
                Label {
                    Text("\(Text("\(conversation.title)'s security key changed.").bold()) This can mean someone is intercepting this chat. Compare keys before sharing anything private.")
                } icon: {
                    Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.amber)
                }
                .font(.footnote)
                .foregroundStyle(Theme.text1)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.amber.opacity(0.12))
                .accessibilityIdentifier(A11y.Chat.banner)
            }
            PinnedBar(serverId: serverId, conversation: conversation) { sheet = .pins }
            ZStack(alignment: .bottomTrailing) {
                if let list, list.loaded || !list.items.isEmpty {
                    if list.items.isEmpty {
                        EmptyChat(conversation: conversation, isSaved: isSaved)
                    } else {
                        messages(server, conversation, list, listId: listId)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if let list, !atBottom || list.detached {
                    toBottom(unread: atBottom ? 0 : conversation.unread) {
                        if list.detached {
                            Task { await model.returnToLatest(serverId, listId) }
                        } else {
                            bridge.scrollToBottom()
                        }
                    }
                }
            }
            if peer?.banned == true, !isSaved {
                Label("This person was removed from the server.", systemImage: "xmark")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.bg1)
                    .accessibilityIdentifier(A11y.Composer.disabled)
            } else {
                Composer(serverId: serverId, conversation: conversation, server: server)
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                ChatHeader(conversation: conversation, server: server, peer: peer, isSaved: isSaved)
            }
            ToolbarItem(placement: .topBarTrailing) {
                // Details come with F6; for now the avatar opens search and pins.
                Menu {
                    Button("Search", systemImage: "magnifyingglass") { sheet = .search }
                        .disabled(conversation.groupId == nil)
                    Button("Pinned messages", systemImage: "pin") { sheet = .pins }
                        .disabled(conversation.groupId == nil)
                } label: {
                    if isSaved {
                        Image(systemName: "bookmark.fill")
                            .frame(width: 34, height: 34)
                            .background(Theme.bg4, in: .circle)
                    } else {
                        AvatarView(name: conversation.title, seed: conversation.peerId ?? conversation.groupId ?? conversation.key, source: conversation.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 34, online: peer?.online ?? false)
                    }
                }
                .accessibilityLabel("Chat options")
                .accessibilityIdentifier(A11y.Chat.menu)
            }
        }
        .task(id: listId) {
            await model.loadList(serverId, listId, groupId: conversation.groupId)
        }
        .sheet(item: $emoteCard) { info in
            EmoteCard(info: info, server: server)
                .presentationDetents([.height(150)])
                .presentationBackground(Theme.bg2)
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .search:
                ChatSearchSheet(serverId: serverId, conversation: conversation, server: server)
            case .pins:
                PinsSheet(serverId: serverId, conversation: conversation, server: server)
                    .presentationDetents([.medium, .large])
            case let .react(messageId):
                EmojiPicker(server: server) { pick in
                    self.sheet = nil
                    guard let groupId = conversation.groupId else { return }
                    let (key, emote): (String, EmoteRef?) = switch pick {
                    case let .emoji(value): (value, nil)
                    case let .emote(emote): (emote.name, EmoteRef(id: emote.id, animated: emote.animated, zeroWidth: emote.zeroWidth, owner: emote.owner))
                    }
                    run { try await model.core.session(serverId).toggleReaction(groupId, messageId: messageId, key: key, emote: emote) }
                }
                .presentationDetents([.medium, .large])
            }
        }
        .onChange(of: readKey(conversation, list)) {
            markRead(serverId, conversation, list)
        }
        .onChange(of: scenePhase) {
            markRead(serverId, conversation, list)
        }
    }

    private func messages(_ server: AppModel.ServerState, _ conversation: ConversationView, _ list: MessageList, listId: String) -> some View {
        let serverId = server.entry.id
        let jump = model.jumpTarget.flatMap { $0.listKey == AppModel.listKey(serverId, listId) ? $0 : nil }
        let actions = ChatActions(
            jump: { id in Task { await model.jumpToMessage(serverId, groupId: listId, messageId: id) } },
            open: { attachment in
                Task {
                    do {
                        FilePreview.show(try await images.openable(attachment, serverId: serverId))
                    } catch {
                        model.toast("Couldn't open \(attachment.name): \(OnboardingText.describe(error))", .error)
                    }
                }
            },
            react: { messageId, key, emote in
                guard let groupId = conversation.groupId else { return }
                Task {
                    do {
                        try await model.core.session(serverId).toggleReaction(groupId, messageId: messageId, key: key, emote: emote)
                    } catch {
                        model.toast(OnboardingText.describe(error), .error)
                    }
                }
            },
            retry: { id in run { try await model.core.session(serverId).retryMessage(listId, id: id) } },
            emoteCard: { name, emote, note in emoteCard = EmoteCardInfo(name: name, emote: emote, note: note) },
            reply: { model.reply(serverId, conversation.key, to: $0) },
            edit: { model.edit(serverId, conversation.key, $0) },
            pin: { message, pinned in run { try await model.core.session(serverId).setPinned(message.groupId, id: message.id, pinned: pinned) } },
            delete: { message in run { try await model.core.session(serverId).deleteMessage(message.groupId, id: message.id) } },
            discard: { id in run { try await model.core.session(serverId).discardMessage(listId, id: id) } },
            pickReaction: { sheet = .react(messageId: $0) },
            isGroupAdmin: conversation.members.first { $0.userId == server.me?.userId }?.role == .admin
        )
        return MessageListView(
            input: MessageListController.Input(
                listKey: AppModel.listKey(serverId, listId),
                detached: list.detached,
                items: list.items,
                server: server,
                conversation: conversation,
                highlighted: highlighted,
                jump: jump,
                actions: actions
            ),
            bridge: bridge,
            onAtBottomChange: { atBottom = $0 },
            onNearOldest: {
                guard list.hasMore, !list.loading, !list.detached else { return }
                Task { await model.loadOlder(serverId, listId) }
            },
            onJumpHandled: { id in
                highlighted = id
                Task {
                    try? await Task.sleep(for: .seconds(1.2))
                    if highlighted == id { highlighted = nil }
                }
            }
        )
    }

    /// Runs an action on the core, explaining a failure in a toast.
    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
            } catch {
                model.toast(OnboardingText.describe(error), .error)
            }
        }
    }

    private func toBottom(unread: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "chevron.down")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.text1)
                .frame(width: 42, height: 42)
                .background(Theme.bg3, in: .circle)
                .overlay(Circle().stroke(Theme.lineStrong))
                .overlay(alignment: .top) {
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(model.settings.accent.onAccent)
                            .padding(.horizontal, 5)
                            .frame(minHeight: 18)
                            .background(model.settings.accent.color, in: .capsule)
                            .offset(y: -9)
                    }
                }
        }
        .buttonStyle(.plain)
        .padding(12)
        .accessibilityLabel("Go to the newest messages")
        .accessibilityIdentifier(A11y.Chat.toBottom)
    }

    // MARK: Read receipts

    private struct ReadKey: Equatable {
        let atBottom: Bool
        let newest: Int
        let ownRead: Int
        let detached: Bool
    }

    private func readKey(_ conversation: ConversationView, _ list: MessageList?) -> ReadKey {
        ReadKey(atBottom: atBottom, newest: newestSeq(list), ownRead: conversation.ownRead, detached: list?.detached ?? false)
    }

    private func newestSeq(_ list: MessageList?) -> Int {
        list?.items.last(where: { $0.seq != nil && !$0.id.hasPrefix("sys-") })?.seq ?? 0
    }

    /// Marks as read while the newest messages are on screen in the open app, as on the desktop.
    private func markRead(_ serverId: String, _ conversation: ConversationView, _ list: MessageList?) {
        guard atBottom, scenePhase == .active, let groupId = conversation.groupId, let list, !list.detached else { return }
        let newest = newestSeq(list)
        if newest > conversation.ownRead { model.markRead(serverId, groupId: groupId, seq: newest) }
    }
}

/// The title and, under it, who's typing, members and online, or last seen, as on the desktop.
private struct ChatHeader: View {
    @Environment(AppModel.self) private var model
    let conversation: ConversationView
    let server: AppModel.ServerState
    let peer: UserView?
    let isSaved: Bool

    var body: some View {
        VStack(spacing: 1) {
            HStack(spacing: 4) {
                Text(conversation.title)
                    .font(.headline)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(1)
                if peer?.trust == .verified, !isSaved {
                    Image(systemName: "checkmark.seal.fill").font(.caption).foregroundStyle(Theme.text2).accessibilityLabel("Verified")
                }
            }
            .accessibilityIdentifier(A11y.Chat.title)
            Text(status)
                .font(.caption)
                .foregroundStyle(online ? model.settings.accent.text : Theme.text2)
                .lineLimit(1)
                .accessibilityIdentifier(A11y.Chat.status)
        }
    }

    private var typingNames: [String] {
        let ids = conversation.groupId.flatMap { server.typing[$0]?.keys } ?? Dictionary<String, Date>().keys
        return ids.map { server.users[$0]?.displayName.split(separator: " ").first.map(String.init) ?? "Someone" }
    }

    private var online: Bool {
        typingNames.isEmpty && conversation.kind == .dm && !isSaved && peer?.online == true && peer?.banned != true
    }

    private var status: String {
        let typing = typingNames
        if !typing.isEmpty {
            if conversation.kind == .dm { return "typing…" }
            return typing.count == 1 ? "\(typing[0]) is typing…" : "\(typing.count) people are typing…"
        }
        if conversation.kind == .group {
            let count = conversation.members.count
            let online = conversation.members.filter { server.users[$0.userId]?.online == true }.count
            return "\(count) \(count == 1 ? "member" : "members")" + (online > 0 ? ", \(online) online" : "")
        }
        if isSaved { return "Notes to yourself" }
        if peer?.banned == true { return "Removed from this server" }
        if peer?.online == true { return "online" }
        return Format.lastSeen(peer?.lastSeenAt, hidden: peer?.hidesLastSeen ?? false)
    }
}

/// A chat with no messages yet, as on the desktop.
private struct EmptyChat: View {
    let conversation: ConversationView
    let isSaved: Bool

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "lock.fill").font(.title3).foregroundStyle(Theme.text2)
            Text(title).font(.headline).foregroundStyle(Theme.text1)
            Text(message).font(.subheadline).foregroundStyle(Theme.text2).multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: 300)
        .background(Theme.bg2, in: .rect(cornerRadius: 18, style: .continuous))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.empty)
    }

    private var title: String {
        if isSaved { return "Your saved messages" }
        return conversation.kind == .group ? conversation.title : "Say hello to \(conversation.title)"
    }

    private var message: String {
        if isSaved { return "Keep notes, links and files here. They're encrypted and sync across your devices." }
        return conversation.kind == .group
            ? "Messages here are end-to-end encrypted. Only members can read them."
            : "Your messages are end-to-end encrypted. Not even this server can read them."
    }
}
