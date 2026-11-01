import SwiftUI
import ZunaModels

/// A chat, laid out like Telegram's: who it's with and their status in the
/// bar, the messages with a button back to the newest one, and the composer.
/// Pinned messages have a screen of their own, as on the desktop.
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
    /// Messages picked to act on together, in the order picked, or nil when not picking.
    @State private var selection: [String]?
    @State private var confirmingDelete = false

    private enum ChatSheet: Identifiable {
        case search
        case react(messageId: String)
        case verify(userId: String)
        case forward([MessageView])

        var id: String {
            switch self {
            case .search: "search"
            case let .react(id): "react-\(id)"
            case let .verify(userId): "verify-\(userId)"
            case let .forward(messages): "forward-\(messages.map(\.id).joined(separator: ","))"
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
            if let peer, peer.trust == .changed, !isSaved {
                HStack(spacing: 10) {
                    Label {
                        Text("\(Text("\(conversation.title)'s security key changed.").bold()) This can mean someone is intercepting this chat. Compare keys before sharing anything private.")
                    } icon: {
                        Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.amber)
                    }
                    Button("Verify") { sheet = .verify(userId: peer.id) }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier(A11y.Chat.bannerVerify)
                }
                .font(.footnote)
                .foregroundStyle(Theme.text1)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.amber.opacity(0.12))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(A11y.Chat.banner)
            }
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
                VStack(spacing: 0) {
                    if conversation.unreadMentions > 0, let groupId = conversation.groupId {
                        toMention(count: conversation.unreadMentions) {
                            Task {
                                guard let next = try? await model.core.session(serverId).nextUnreadMention(groupId) else { return }
                                await model.jumpToMessage(serverId, groupId: groupId, messageId: next.id, seq: next.seq)
                            }
                        }
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
            }
            if conversation.removed {
                VStack(spacing: 8) {
                    Text("You're no longer in this conversation. Its messages stay on this device for 30 days.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                        .multilineTextAlignment(.center)
                    Button("Remove now", role: .destructive) {
                        guard let groupId = conversation.groupId else { return }
                        model.chatPath = []
                        Task { try? await model.core.session(serverId).forgetConversation(groupId) }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(14)
                .background(Theme.bg1)
                .accessibilityIdentifier(A11y.Composer.disabled)
            } else if peer?.banned == true, !isSaved {
                Label("This person was removed from the server.", systemImage: "xmark")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.bg1)
                    .accessibilityIdentifier(A11y.Composer.disabled)
            } else if let selection, let list {
                selectionBar(selection, server: server, conversation: conversation, list: list)
            } else {
                Composer(serverId: serverId, conversation: conversation, server: server)
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {
                    model.chatPath.append(.details(conversation.key))
                } label: {
                    ChatHeader(conversation: conversation, server: server, peer: peer, isSaved: isSaved)
                }
                .buttonStyle(.plain)
            }
            ToolbarItem(placement: .topBarTrailing) {
                // As the desktop's header button: pinned messages have a screen of their own.
                Button {
                    model.chatPath.append(.pins(conversation.key))
                } label: {
                    Image(systemName: "pin")
                }
                .disabled(conversation.groupId == nil)
                .accessibilityLabel("Pinned messages")
                .accessibilityIdentifier(A11y.Chat.pins)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(conversation.kind == .group ? "Group details" : "Details", systemImage: "info.circle") {
                        model.chatPath.append(.details(conversation.key))
                    }
                    Button("Search", systemImage: "magnifyingglass") { sheet = .search }
                        .disabled(conversation.groupId == nil)
                    Button("Pinned messages", systemImage: "pin") { model.chatPath.append(.pins(conversation.key)) }
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
            // The avatar is a picture of its own, without the bar's gray glass behind it.
            .withoutSharedBackground()
        }
        .task(id: listId) {
            await model.loadList(serverId, listId, groupId: conversation.groupId)
        }
        // Files dragged onto the chat go into the composer, as on the desktop.
        .dropDestination(for: DroppedFile.self) { files, _ in
            guard !(peer?.banned == true && !isSaved), !conversation.removed else { return false }
            model.pendingAttachments += files.map(\.url)
            return true
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
            case let .verify(userId):
                VerifyView(serverId: serverId, userId: userId)
            case let .forward(messages):
                ForwardSheet(serverId: serverId, messages: messages) { selection = nil }
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
                        let file = try await images.openable(attachment, serverId: serverId)
                        // Pictures open in a viewer that closes with a drag, as in Telegram; other files in QuickLook.
                        if attachment.mime.hasPrefix("image/") { PhotoViewer.show(file) } else { FilePreview.show(file) }
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
            mention: { sheet = .verify(userId: $0) },
            emoteCard: { name, emote, note in emoteCard = EmoteCardInfo(name: name, emote: emote, note: note) },
            reply: { model.reply(serverId, conversation.key, to: $0) },
            forward: { sheet = .forward([$0]) },
            select: { message in
                var picked = selection ?? []
                if let index = picked.firstIndex(of: message.id) { picked.remove(at: index) } else { picked.append(message.id) }
                selection = picked.isEmpty ? nil : picked
            },
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
                selection: selection,
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

    /// What can be done with the picked messages, in place of the composer, as in Telegram.
    private func selectionBar(_ ids: [String], server: AppModel.ServerState, conversation: ConversationView, list: MessageList) -> some View {
        // In the chat's order, whatever order they were picked in.
        let picked = list.items.filter { ids.contains($0.id) }
        let selfId = server.me?.userId
        let isAdmin = conversation.members.first { $0.userId == selfId }?.role == .admin
        let canDelete = !picked.isEmpty && picked.allSatisfy { $0.senderId == selfId || (conversation.kind == .group && isAdmin) }
        return HStack(spacing: 4) {
            Button("Cancel") { selection = nil }
                .padding(.horizontal, 8)
            Text("\(picked.count) selected")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.text1)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier(A11y.Chat.selectionCount)
            Button {
                copy(picked, server: server)
            } label: {
                Image(systemName: "doc.on.doc").frame(width: 40, height: 40)
            }
            .accessibilityLabel("Copy")
            Button {
                sheet = .forward(picked)
            } label: {
                Image(systemName: "arrowshape.turn.up.right").frame(width: 40, height: 40)
            }
            .accessibilityLabel("Forward")
            if canDelete {
                Button(role: .destructive) {
                    confirmingDelete = true
                } label: {
                    Image(systemName: "trash").frame(width: 40, height: 40)
                }
                .tint(Theme.red)
                .accessibilityLabel("Delete")
            }
        }
        .disabled(picked.isEmpty)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(Theme.bg1)
        .overlay(alignment: .top) { Divider().overlay(Theme.line) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.selectionBar)
        .confirmationDialog("Delete \(picked.count == 1 ? "this message" : "\(picked.count) messages") for everyone?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete for everyone", role: .destructive) {
                guard let groupId = conversation.groupId else { return }
                let serverId = server.entry.id
                selection = nil
                run { try await model.core.session(serverId).deleteMessages(groupId, ids: picked.map(\.id)) }
            }
        }
    }

    /// One message's text, or several with who wrote each and when, as Telegram copies them.
    private func copy(_ picked: [MessageView], server: AppModel.ServerState) {
        let name = { (id: String) in id == server.me?.userId ? "You" : server.users[id]?.displayName ?? "Unknown" }
        UIPasteboard.general.string = picked.count == 1
            ? picked[0].text
            : picked.map { "\(name($0.senderId)), [\(Format.full($0.createdAt))]\n\($0.text.isEmpty ? $0.attachments.map(\.name).joined(separator: ", ") : $0.text)" }.joined(separator: "\n\n")
        model.toast(picked.count == 1 ? "Copied" : "Copied \(picked.count) messages")
        selection = nil
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

    /// As Telegram's "@": the oldest unread message that mentions you or replies to you, then the next.
    private func toMention(count: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "at")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.text1)
                .frame(width: 42, height: 42)
                .background(Theme.bg3, in: .circle)
                .overlay(Circle().stroke(Theme.lineStrong))
                .overlay(alignment: .top) {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(model.settings.accent.onAccent)
                        .padding(.horizontal, 5)
                        .frame(minHeight: 18)
                        .background(model.settings.accent.color, in: .capsule)
                        .offset(y: -9)
                }
        }
        .buttonStyle(.plain)
        .padding([.horizontal, .top], 12)
        .accessibilityLabel("Go to the next message that mentions you, \(count) unread")
        .accessibilityIdentifier(A11y.Chat.toMention)
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
                if conversation.disappearAfter > 0 {
                    Image(systemName: "timer").font(.caption).foregroundStyle(Theme.text2)
                        .accessibilityLabel("Messages disappear after \(Format.timer(conversation.disappearAfter))")
                }
            }
            .accessibilityIdentifier(A11y.Chat.title)
            Text(status)
                .font(.caption)
                .foregroundStyle(online ? Theme.green : Theme.text2)
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

private extension ToolbarContent {
    /// Without the glass iOS 26 puts behind items in the navigation bar.
    @ToolbarContentBuilder
    func withoutSharedBackground() -> some ToolbarContent {
        if #available(iOS 26, *) {
            sharedBackgroundVisibility(.hidden)
        } else {
            self
        }
    }
}
