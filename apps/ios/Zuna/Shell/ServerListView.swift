import SwiftUI
import ZunaModels

/// The server button's place at the top left, on its own rather than in a
/// glass bubble from iOS 26, so the picture and its count have room.
struct ServerToolbarItem: ToolbarContent {
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { ServerButton() }
            .withoutSharedBackground()
    }
}

/// The open server's picture, at the top left of Chats and Channels on a
/// phone, which opens the list of servers in a sheet. It carries what's
/// unread on the others, as the desktop's rail does: a count, or a dot for
/// what's new there but doesn't count.
struct ServerButton: View {
    @Environment(AppModel.self) private var model
    @State private var choosing = false
    @State private var joinAfter = false

    var body: some View {
        let unread = model.otherServersUnread
        let dot = unread == 0 && model.otherServersHaveNew
        Button {
            choosing = true
        } label: {
            Group {
                if let server = model.activeServer {
                    ServerIcon(entry: server.entry, size: 36)
                } else {
                    Image(systemName: "square.stack")
                }
            }
            .overlay(alignment: .topTrailing) {
                if unread > 0 {
                    Text(unread > 99 ? "99+" : "\(unread)")
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Theme.red, in: .capsule)
                        .overlay(Capsule().stroke(Theme.bg0, lineWidth: 2))
                        .offset(x: 8, y: -6)
                } else if dot {
                    Circle()
                        .fill(Theme.text1)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(Theme.bg0, lineWidth: 2))
                        .offset(x: 3, y: -3)
                }
            }
        }
        .accessibilityLabel(model.activeServer.map { "Servers, \($0.entry.name)" } ?? "Servers")
        .accessibilityValue(unread > 0 ? "\(unread) unread on other servers" : dot ? "New messages on other servers" : "")
        .accessibilityIdentifier(A11y.Shell.servers)
        // The join screens are a sheet of the app's, so they wait for this one to go.
        .sheet(isPresented: $choosing, onDismiss: {
            if joinAfter {
                joinAfter = false
                model.joining = true
            }
        }) {
            NavigationStack {
                ServerListView(onPick: { choosing = false }, onJoin: {
                    joinAfter = true
                    choosing = false
                })
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(Theme.bg1)
        }
    }
}

/// Every server, as Mail lists its mailboxes: the picture, the name, the
/// latest message and the unread count. On a phone, in a sheet from the
/// server button; on an iPad, beside the chats when there's more than one.
struct ServerListView: View {
    @Environment(AppModel.self) private var model
    /// On an iPad, the sidebar beside the open server's chats, with that server marked.
    var sidebar = false
    /// In the sheet on a phone: a server was picked, so the sheet can close.
    var onPick: (() -> Void)?
    /// In the sheet on a phone: the join screens come once the sheet has closed.
    var onJoin: (() -> Void)?
    @State private var inviting: String?
    @State private var signingOut: String?
    @State private var unlinkingTelegram = false

    var body: some View {
        List {
            ForEach(model.order, id: \.self) { id in
                if let server = model.servers[id] {
                    row(server)
                }
            }
            .onMove { model.moveServers(from: $0, to: $1) }
            .listSectionSeparator(.hidden, edges: .top)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(background)
        .navigationTitle("Servers")
        .navigationBarTitleDisplayMode(onPick == nil ? .large : .inline)
        .toolbarBackground(background, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { EditButton() }
            ToolbarItem(placement: .topBarTrailing) {
                if model.canLinkTelegram {
                    // Joining a server, or linking the one Telegram account this device may have.
                    Menu {
                        Button("Join a server", systemImage: "server.rack") { join() }
                            .accessibilityIdentifier(A11y.Servers.join)
                        Button("Connect Telegram", systemImage: "bubble.left.and.bubble.right") {
                            onPick?()
                            model.startLinkingTelegram()
                        }
                        .accessibilityIdentifier(A11y.Servers.linkTelegram)
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Join a server or connect Telegram")
                } else {
                    Button(action: join) {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Join a server")
                    .accessibilityIdentifier(A11y.Servers.join)
                }
            }
        }
        .sheet(item: Binding(get: { inviting.map(SheetServer.init) }, set: { inviting = $0?.id })) { InviteSheet(serverId: $0.id) }
        .confirmationDialog(
            SettingsView.signOutWarning(signingOut.flatMap { model.servers[$0]?.entry.name } ?? ""),
            isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { signingOut = nil } }),
            titleVisibility: .visible,
            presenting: signingOut
        ) { serverId in
            Button("Sign out and erase local data", role: .destructive) {
                Task { await model.signOut(serverId) }
            }
        }
        .confirmationDialog(
            "This signs Zuna out of your Telegram account and erases what it kept of it on this device. Your chats stay on Telegram.",
            isPresented: $unlinkingTelegram,
            titleVisibility: .visible
        ) {
            Button("Unlink Telegram", role: .destructive) {
                Task { await model.unlinkTelegram() }
            }
        }
        .accessibilityIdentifier(A11y.Servers.list)
    }

    private func join() {
        if let onJoin { onJoin() } else { model.joining = true }
    }

    private struct SheetServer: Identifiable {
        let id: String
    }

    /// A sheet sits above the screen, a step lighter; the sidebar is the screen's own black.
    private var background: Color {
        onPick == nil ? Theme.bg0 : Theme.bg1
    }

    private func row(_ server: AppModel.ServerState) -> some View {
        let id = server.entry.id
        let open = (sidebar || onPick != nil) && id == model.activeServerId
        return Button {
            model.selectServer(id)
            onPick?()
        } label: {
            ServerRow(server: server)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 14))
        .listRowBackground(open ? Theme.bg3 : background)
        .listRowSeparatorTint(Theme.line)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 78 }
        .accessibilityAddTraits(open ? .isSelected : [])
        .contextMenu {
            if server.entry.isTelegram {
                Button("Unlink Telegram", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    unlinkingTelegram = true
                }
            } else {
                Button("Invite people", systemImage: "link") { inviting = id }
                Button("Sign out of \(server.entry.name)", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    signingOut = id
                }
            }
        }
    }
}

/// A server in the list: its picture, name, the newest message on it, and
/// the unread count, or how it's connecting while it isn't.
private struct ServerRow: View {
    @Environment(AppModel.self) private var model
    let server: AppModel.ServerState

    var body: some View {
        let latest = server.conversations.max { ($0.lastMessage?.createdAt ?? 0) < ($1.lastMessage?.createdAt ?? 0) }
        HStack(spacing: 12) {
            ServerIcon(entry: server.entry, size: 54)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(server.entry.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text1)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let createdAt = latest?.lastMessage?.createdAt {
                        Text(Format.listTime(createdAt))
                            .font(.subheadline)
                            .foregroundStyle(server.unread > 0 ? Theme.text1 : Theme.text3)
                            .monospacedDigit()
                    }
                }
                HStack(alignment: .top, spacing: 6) {
                    subtitle(latest)
                        .font(.subheadline)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if server.unread > 0 {
                        Text(server.unread > 99 ? "99+" : "\(server.unread)")
                            .font(.footnote.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(model.settings.accent.onAccent)
                            .padding(.horizontal, 7)
                            .frame(minWidth: 22, minHeight: 22)
                            .background(model.settings.accent.color, in: .capsule)
                            .padding(.top, 2)
                            .accessibilityLabel("\(server.unread) unread")
                    } else if server.hasNew {
                        // New in channels, but nothing for you: the desktop rail's pill.
                        Circle()
                            .fill(Theme.text1)
                            .frame(width: 10, height: 10)
                            .padding(.top, 8)
                            .accessibilityLabel("New messages")
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .frame(minHeight: 72)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Servers.row(server.entry.id))
    }

    @ViewBuilder
    private func subtitle(_ latest: ConversationView?) -> some View {
        switch server.connection {
        case .connecting, .offline: Text(model.waitingText(server.connection)).foregroundStyle(Theme.text3)
        case .online, .syncing:
            if let latest, latest.lastMessage != nil {
                let (author, body) = Format.preview(latest.lastMessage, users: server.users, selfId: server.me?.userId ?? "", kind: latest.kind)
                let lead = author.map { "\(latest.title) · \($0)" } ?? latest.title
                Text("\(Text(lead + ": ").foregroundStyle(Theme.text1))\(Text(body).foregroundStyle(Theme.text2))")
            } else if server.entry.isTelegram {
                Text("Not end-to-end encrypted").foregroundStyle(Theme.text3)
            } else {
                Text(URL(string: server.entry.url)?.host() ?? server.entry.url).foregroundStyle(Theme.text3)
            }
        }
    }
}
