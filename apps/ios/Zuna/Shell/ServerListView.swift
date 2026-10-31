import SwiftUI
import ZunaModels

/// Every server, as Mail lists its mailboxes: the picture, the name, the
/// latest message and the unread count. Shown when there's more than one
/// server; with one, the Chats tab opens on its conversations.
struct ServerListView: View {
    @Environment(AppModel.self) private var model
    /// On an iPad, the sidebar beside the open server's chats, with that server marked.
    var sidebar = false
    @State private var inviting: String?
    @State private var signingOut: String?

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
        .background(Theme.bg0)
        .navigationTitle("Servers")
        .navigationBarTitleDisplayMode(.large)
        .toolbarBackground(Theme.bg1, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { EditButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.joining = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Join a server")
                .accessibilityIdentifier(A11y.Servers.join)
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
        .accessibilityIdentifier(A11y.Servers.list)
    }

    private struct SheetServer: Identifiable {
        let id: String
    }

    private func row(_ server: AppModel.ServerState) -> some View {
        let id = server.entry.id
        let open = sidebar && id == model.activeServerId
        return Button {
            model.openServer(id)
        } label: {
            ServerRow(server: server)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 14))
        .listRowBackground(open ? Theme.bg3 : Theme.bg0)
        .listRowSeparatorTint(Theme.line)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 78 }
        .accessibilityAddTraits(open ? .isSelected : [])
        .contextMenu {
            Button("Invite people", systemImage: "link") { inviting = id }
            Button("Sign out of \(server.entry.name)", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                signingOut = id
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
            AvatarView(name: server.entry.name, seed: server.entry.url, source: .serverIcon(server.entry), size: 54, rounded: true)
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
        case .connecting: Text("Connecting…").foregroundStyle(Theme.text3)
        case .offline: Text("Waiting for network…").foregroundStyle(Theme.text3)
        case .online, .syncing:
            if let latest, latest.lastMessage != nil {
                let (author, body) = Format.preview(latest.lastMessage, users: server.users, selfId: server.me?.userId ?? "", kind: latest.kind)
                let lead = author.map { "\(latest.title) · \($0)" } ?? latest.title
                Text("\(Text(lead + ": ").foregroundStyle(Theme.text1))\(Text(body).foregroundStyle(Theme.text2))")
            } else {
                Text(URL(string: server.entry.url)?.host() ?? server.entry.url).foregroundStyle(Theme.text3)
            }
        }
    }
}
