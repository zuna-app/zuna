import SwiftUI
import ZunaModels

/// The active server's conversations, laid out like Telegram's chat list. The
/// title shows the connection state while it isn't connected, as Telegram
/// does. Filters, search and row actions come in F3, the chat itself in F4.
struct ChatListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
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
                ToolbarItem(placement: .topBarLeading) { serverButton }
                ToolbarItem(placement: .principal) { title }
            }
            .toolbarBackground(Theme.bg1, for: .navigationBar)
        }
    }

    @ViewBuilder
    private func list(_ server: AppModel.ServerState) -> some View {
        let visible = server.conversations.filter { !$0.hidden }
        if visible.isEmpty {
            ContentUnavailableView("It's quiet here", systemImage: "bubble.left.and.bubble.right", description: Text("Conversations with people on \(server.entry.name) show up here."))
                .foregroundStyle(Theme.text2)
                .accessibilityIdentifier(A11y.ChatList.empty)
        } else {
            List(visible) { conversation in
                ChatRow(conversation: conversation, server: server)
                    .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 14))
                    .listRowBackground(Theme.bg0)
                    .listRowSeparatorTint(Theme.line)
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 76 }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier(A11y.ChatList.list)
        }
    }

    private var serverButton: some View {
        Button {
            model.drawerOpen = true
        } label: {
            if let server = model.activeServer {
                AvatarView(name: server.entry.name, seed: server.entry.url, source: .serverIcon(server.entry), size: 30, rounded: true)
                    .overlay(alignment: .topTrailing) {
                        if model.otherServersUnread > 0 {
                            Circle().fill(model.settings.accent.color).frame(width: 10, height: 10)
                                .overlay(Circle().stroke(Theme.bg1, lineWidth: 2))
                                .offset(x: 3, y: -3)
                        }
                    }
            }
        }
        .accessibilityLabel("Servers")
        .accessibilityIdentifier(A11y.Shell.serverButton)
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
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Shell.title)
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
