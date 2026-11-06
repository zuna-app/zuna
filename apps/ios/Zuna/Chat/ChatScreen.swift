import SwiftUI
import ZunaModels

/// A chat, laid out like Telegram's: who it's with and their status in the
/// middle of the bar, their picture on the right for the details, which hold
/// calls, search and pins, then the messages with a button back to the newest
/// one, and the composer. Pinned messages have a screen of their own, as on the desktop.
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
    /// How wide the chat is, for whether a channel's member list fits beside it.
    @State private var width: CGFloat = 0
    @AppStorage(AppSettings.memberListHiddenKey) private var memberListHidden = false

    private enum ChatSheet: Identifiable {
        case search
        case react(messageId: String)
        case verify(userId: String)
        case forward([MessageView])
        case editChannel(String)

        var id: String {
            switch self {
            case .search: "search"
            case let .editChannel(id): "edit-channel-\(id)"
            case let .react(id): "react-\(id)"
            case let .verify(userId): "verify-\(userId)"
            case let .forward(messages): "forward-\(messages.map(\.id).joined(separator: ","))"
            }
        }
    }

    var body: some View {
        ZStack {
            if let server = model.activeServer, let conversation = server.conversation(conversationKey) {
                content(server, conversation)
            } else if let channel = model.activeServer?.channel(conversationKey) {
                JoiningChannel(channel: channel)
            } else {
                ContentUnavailableView("This chat isn't available", systemImage: "bubble.left.and.exclamationmark.bubble.right")
            }
        }
        .background(Theme.bg0)
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg0, for: .navigationBar)
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
        let channel = server.channel(conversation.key)
        // As the desktop's, which goes when the chat is narrower than 780 points: on an iPad, with the chat wide enough.
        let roomForMembers = channel != nil && UIDevice.current.userInterfaceIdiom == .pad && width >= 780
        return HStack(spacing: 0) {
            chat(server, conversation, list: list, listId: listId, peer: peer, isSaved: isSaved, channel: channel)
            if roomForMembers, !memberListHidden {
                ChannelMemberList(server: server) { sheet = .verify(userId: $0) }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {
                    openDetails(conversation.key)
                } label: {
                    Group {
                        if let channel {
                            ChannelHeader(channel: channel, muted: conversation.muted)
                        } else {
                            ChatHeader(conversation: conversation, server: server, peer: peer, isSaved: isSaved)
                        }
                    }
                    // In a bubble of its own, as Telegram's title, the bar's buttons' height.
                    .padding(.horizontal, 18)
                    .frame(minHeight: 44)
                    .glassCapsule()
                    .contentShape(.capsule)
                }
                .buttonStyle(.plain)
            }
            if channel != nil {
                if roomForMembers {
                    ToolbarItem(placement: .topBarTrailing) {
                        // Shown or hidden in every channel, as on the desktop.
                        Button {
                            memberListHidden.toggle()
                        } label: {
                            Image(systemName: memberListHidden ? "person.2" : "person.2.fill")
                        }
                        .accessibilityLabel(memberListHidden ? "Show member list" : "Hide member list")
                        .accessibilityIdentifier(A11y.Channels.memberListToggle)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        sheet = .search
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel("Search this channel")
                    .accessibilityIdentifier(A11y.Channels.search)
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    // The picture opens the details, as Telegram's, where calls, search and pins are.
                    Button {
                        openDetails(conversation.key)
                    } label: {
                        if isSaved {
                            Image(systemName: "bookmark.fill")
                                .frame(width: 36, height: 36)
                                .background(Theme.bg4, in: .circle)
                        } else {
                            AvatarView(name: conversation.title, seed: conversation.peerId ?? conversation.groupId ?? conversation.key, source: conversation.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 36, online: peer?.online ?? false)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(conversation.kind == .group ? "Group details" : "Details")
                    .accessibilityIdentifier(A11y.Chat.menu)
                }
                // The avatar is a picture of its own, without the bar's gray glass behind it.
                .withoutSharedBackground()
            }
        }
        .task(id: listId) {
            await model.loadList(serverId, listId, groupId: conversation.groupId)
        }
        // Files dragged onto the chat go into the composer, as on the desktop.
        .dropDestination(for: DroppedFile.self) { files, _ in
            guard !((peer?.banned == true || peer?.deleted == true) && !isSaved), !conversation.removed, !conversation.blocked else { return false }
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
            case let .editChannel(id):
                ChannelEditor(serverId: serverId, target: .edit(channelId: id))
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
        .onChange(of: conversation.ownRead) {
            markRead(serverId, conversation)
        }
        .onChange(of: scenePhase) {
            markRead(serverId, conversation)
        }
    }

    /// The chat's details, with the keyboard put away first. Left up, UIKit gives the
    /// message box its focus back on the way back, and the keyboard comes up over the
    /// chat before the chat has made room for it.
    private func openDetails(_ key: String) {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        model.chatPath.append(.details(key))
    }

    /// Whether a call can be started here: a direct message with someone else, or a group still had, on a server with calls.
    static func canCall(_ server: AppModel.ServerState, _ conversation: ConversationView, peer: UserView?, isSaved: Bool) -> Bool {
        guard server.hasCalls, !conversation.removed else { return false }
        if conversation.kind == .dm { return !isSaved && conversation.peerId != nil && !conversation.blocked && peer?.banned != true && peer?.deleted != true }
        return conversation.kind == .group
    }

    /// The chat itself: the key's banner, the messages, who's typing, and the composer or what stands in for it.
    private func chat(_ server: AppModel.ServerState, _ conversation: ConversationView, list: MessageList?, listId: String, peer: UserView?, isSaved: Bool, channel: ChannelView?) -> some View {
        let serverId = server.entry.id
        return VStack(spacing: 0) {
            if channel == nil, let groupId = conversation.groupId, server.calls[groupId] != nil {
                CallBanner(server: server, groupId: groupId)
            }
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
                    if list.items.isEmpty, let channel {
                        // At the bottom, where the first message will be, as in Discord.
                        ChannelWelcome(channel: channel, edit: editChannel(server, channel))
                            .frame(maxHeight: .infinity, alignment: .bottom)
                    } else if list.items.isEmpty {
                        EmptyChat(conversation: conversation, isSaved: isSaved)
                    } else {
                        messages(server, conversation, list, listId: listId)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                VStack(alignment: .trailing, spacing: 0) {
                    if let groupId = conversation.groupId, conversation.kind != .dm {
                        MentionButton(serverId: serverId, groupId: groupId, conversation: conversation, hidden: atBottom && list?.detached != true)
                            .id(listId)
                    }
                    if let list, !atBottom || list.detached {
                        let action = {
                            if list.detached {
                                Task { await model.returnToLatest(serverId, listId) }
                            } else {
                                bridge.scrollToBottom()
                            }
                        }
                        if channel != nil {
                            jumpToPresent(unread: atBottom ? 0 : conversation.unread, list: list, server: server, conversation: conversation, action: action)
                        } else {
                            toBottom(unread: atBottom ? 0 : conversation.unread, action: action)
                        }
                    }
                }
            }
            if channel != nil, !conversation.removed, selection == nil {
                ChannelTyping(names: typingNames(server, conversation))
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
                .background(Theme.bg0)
                .accessibilityIdentifier(A11y.Composer.disabled)
            } else if peer?.banned == true || peer?.deleted == true, !isSaved {
                Label(peer?.deleted == true ? "This account was deleted." : "This person was removed from the server.", systemImage: "xmark")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.bg0)
                    .accessibilityIdentifier(A11y.Composer.disabled)
            } else if conversation.blocked, let peer {
                HStack(spacing: 10) {
                    Label("You blocked \(peer.displayName).", systemImage: "nosign")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                    Button("Unblock") { model.setBlocked(peer.id, false, on: serverId) }
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Theme.bg0)
                .accessibilityIdentifier(A11y.Composer.disabled)
            } else if let selection, let list {
                selectionBar(selection, server: server, conversation: conversation, list: list)
            } else {
                Composer(serverId: serverId, conversation: conversation, server: server)
            }
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
            // A channel's message is edited where it is, as on the desktop; elsewhere in the composer.
            edit: { message in
                if conversation.kind == .channel {
                    model.editInPlace(serverId, message, in: message.groupId)
                } else {
                    model.edit(serverId, conversation.key, message)
                }
            },
            pin: { message, pinned in run { try await model.core.session(serverId).setPinned(message.groupId, id: message.id, pinned: pinned) } },
            delete: { message in run { try await model.core.session(serverId).deleteMessage(message.groupId, id: message.id) } },
            discard: { id in run { try await model.core.session(serverId).discardMessage(listId, id: id) } },
            pickReaction: { sheet = .react(messageId: $0) },
            readers: { message in
                guard let seq = message.seq else { return [] }
                return conversation.members
                    .filter { $0.userId != server.me?.userId && (conversation.readBy[$0.userId] ?? 0) >= seq }
                    .compactMap { server.users[$0.userId] }
                    .sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
            },
            openChat: { model.openChat($0) },
            isGroupAdmin: conversation.members.first { $0.userId == server.me?.userId }?.role == .admin,
            editChannel: server.channel(conversation.key).flatMap { editChannel(server, $0) }
        )
        return MessageListView(
            input: MessageListController.Input(
                listKey: AppModel.listKey(serverId, listId),
                detached: list.detached,
                items: list.items,
                hasMore: list.hasMore,
                server: server,
                conversation: conversation,
                highlighted: highlighted,
                selection: selection,
                editing: conversation.kind == .channel ? model.editingInPlace[AppModel.listKey(serverId, listId)]?.id : nil,
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
            },
            onSeen: { seen in
                bridge.seen = seen
                markRead(serverId, conversation)
            }
        )
    }

    /// What can be done with the picked messages, in place of the composer, as in Telegram.
    private func selectionBar(_ ids: [String], server: AppModel.ServerState, conversation: ConversationView, list: MessageList) -> some View {
        // In the chat's order, whatever order they were picked in.
        let picked = list.items.filter { ids.contains($0.id) }
        let selfId = server.me?.userId
        let isAdmin = conversation.members.first { $0.userId == selfId }?.role == .admin
        let canDelete = !picked.isEmpty && picked.allSatisfy { $0.senderId == selfId || (conversation.kind != .dm && isAdmin) }
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
        .background(Theme.bg0)
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

    /// Editing the channel from its welcome, for a server admin.
    private func editChannel(_ server: AppModel.ServerState, _ channel: ChannelView) -> (() -> Void)? {
        server.isAdmin ? { sheet = .editChannel(channel.id) } : nil
    }

    /// Who's typing in a channel, by name, apart from you.
    private func typingNames(_ server: AppModel.ServerState, _ conversation: ConversationView) -> [String] {
        let ids = conversation.groupId.flatMap { server.typing[$0]?.keys } ?? Dictionary<String, Date>().keys
        return ids.filter { $0 != server.me?.userId }.sorted().map { server.users[$0]?.displayName ?? "Someone" }
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

    /// A channel's way back down, as Discord's: a bar along the bottom of the list
    /// saying how many new messages are below, and since when.
    private func jumpToPresent(unread: Int, list: MessageList, server: AppModel.ServerState, conversation: ConversationView, action: @escaping () -> Void) -> some View {
        let since = unread > 0
            ? list.items.first { AppModel.isUnread($0, ownRead: conversation.ownRead, selfId: server.me?.userId, blocked: server.prefs.blocked ?? []) }?.createdAt
            : nil
        let what = unread > 0
            ? "\(unread > 99 ? "99+" : "\(unread)") new \(unread == 1 ? "message" : "messages")\(since.map { " since \(Format.time($0))" } ?? "")"
            : "You're viewing older messages"
        return Button(action: action) {
            HStack(spacing: 12) {
                Text(what)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Text("Jump to present")
                    Image(systemName: "arrow.down").font(.footnote.weight(.bold))
                }
                .fontWeight(.semibold)
                .foregroundStyle(Theme.text1)
                .fixedSize()
            }
            // Smaller than the desktop's, so a phone has room for the time.
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(Theme.bg3, in: UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(what). Jump to present")
        .accessibilityIdentifier(A11y.Channels.jumpToPresent)
    }

    // MARK: Read receipts

    /// Reads as far as has been on screen in the open app, as on the desktop. The list
    /// says how far, which at the newest message is everything.
    private func markRead(_ serverId: String, _ conversation: ConversationView) {
        guard scenePhase == .active, let groupId = conversation.groupId, bridge.seen > conversation.ownRead else { return }
        model.markRead(serverId, groupId: groupId, seq: bridge.seen)
    }
}

/// As Telegram's "@": goes to the oldest unread message here that mentions you or
/// replies to you, then the next. Those read by scrolling past them drop out, and it
/// goes at the newest message, where everything is read, as on the desktop.
private struct MentionButton: View {
    let serverId: String
    let groupId: String
    let conversation: ConversationView
    let hidden: Bool
    @Environment(AppModel.self) private var model
    @State private var mentions: [MessagePlace] = []

    private struct Ask: Equatable {
        let ownRead: Int
        let waiting: Int
    }

    var body: some View {
        // A stack rather than a Group, which would pass the task to children it doesn't have yet.
        VStack(spacing: 0) {
            if let next = mentions.first, !hidden {
                Button {
                    mentions.removeFirst()
                    Task {
                        try? await model.core.session(serverId).markMentionSeen(groupId, id: next.id)
                        await model.jumpToMessage(serverId, groupId: groupId, messageId: next.id, seq: next.seq)
                    }
                } label: {
                    Image(systemName: "at")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.text1)
                        .frame(width: 42, height: 42)
                        .background(Theme.bg3, in: .circle)
                        .overlay(Circle().stroke(Theme.lineStrong))
                        .overlay(alignment: .top) {
                            Text(mentions.count > 99 ? "99+" : "\(mentions.count)")
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
                .accessibilityLabel("Go to the next message that mentions you, \(mentions.count) left")
                .accessibilityIdentifier(A11y.Chat.toMention)
            }
        }
        .task(id: Ask(ownRead: conversation.ownRead, waiting: conversation.unreadMentions)) {
            let found = try? await model.core.session(serverId).unreadMentions(groupId, after: conversation.ownRead)
            if let found, !Task.isCancelled { mentions = found }
        }
    }
}

/// The title and, under it, who's typing, members and online, or last seen, as on the desktop.
/// A call going on in this conversation that this device isn't in: who's there, and a way in.
private struct CallBanner: View {
    @Environment(VoiceModel.self) private var voice
    let server: AppModel.ServerState
    let groupId: String

    var body: some View {
        let people = server.inRoom(groupId)
        let me = server.me?.userId
        let here = voice.serverId == server.entry.id && voice.channelId == groupId && voice.inCall
        if !here, !people.isEmpty {
            let elsewhere = people.contains { $0 == me }
            let names = people.filter { $0 != me }.map { server.users[$0]?.displayName.split(separator: " ").first.map(String.init) ?? "Someone" }
            let who = names.count <= 2 ? names.joined(separator: " and ") : "\(names[0]), \(names[1]) and \(names.count - 2) more"
            HStack(spacing: 10) {
                Image(systemName: "phone.fill").foregroundStyle(Theme.green)
                Text(elsewhere ? "You're in this call on another device" : "\(who) \(names.count == 1 ? "is" : "are") in a call")
                    .font(.footnote)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(elsewhere ? "Move here" : "Join") {
                    let serverId = server.entry.id
                    Task { await voice.join(serverId: serverId, channelId: groupId) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.green)
                .controlSize(.small)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Theme.green.opacity(0.1))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(A11y.Chat.callBanner)
        }
    }
}

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
        typingNames.isEmpty && conversation.kind == .dm && !isSaved && peer?.online == true && peer?.banned != true && peer?.deleted != true
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
        if peer?.deleted == true { return "Deleted their account" }
        if peer?.banned == true { return "Removed from this server" }
        if peer?.online == true { return "online" }
        return Format.lastSeen(peer?.lastSeenAt, hidden: peer?.hidesLastSeen ?? false)
    }
}

/// A channel's name and topic in the bar, as Discord's phone app shows them.
private struct ChannelHeader: View {
    let channel: ChannelView
    let muted: Bool

    var body: some View {
        VStack(spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: channel.type.symbol)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Theme.channelMuted)
                    .accessibilityHidden(true)
                Text(channel.title)
                    .font(.headline)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(1)
                if muted {
                    Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(Theme.text3).accessibilityLabel("Muted")
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(A11y.Chat.title)
            if !channel.topic.isEmpty {
                Text(channel.topic)
                    .font(.caption)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                    .accessibilityIdentifier(A11y.Chat.status)
            }
        }
    }
}

/// A channel this device hasn't come into yet, which it does by itself, soon after it appears.
private struct JoiningChannel: View {
    let channel: ChannelView

    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text("Coming into #\(channel.title)…")
                .font(.headline)
                .foregroundStyle(Theme.text1)
            Text("This device joins every channel on the server by itself. Its messages will be here in a moment.")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("#\(channel.title)")
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Channels.joining)
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
