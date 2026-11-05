import SwiftUI
import ZunaModels

/// The Channels tab on a phone: the active server's channels, with the
/// channels opened from them pushed over the list.
struct ChannelsTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.channelsPath) {
            ChannelsScreen()
                .navigationDestination(for: ChatRoute.self) { ChatRouteView(route: $0) }
        }
    }
}

/// The active server's text and voice channels, under their headings as on
/// the desktop, with the server button to show another server's.
private struct ChannelsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var editing: ChannelEditor.Target?
    @State private var muting: ChatListView.MutingTarget?
    @State private var deleting: ChannelView?

    var body: some View {
        Group {
            if let server = model.activeServer {
                if let reason = server.entry.signedOut {
                    SignedOutView(server: server, reason: reason)
                } else if server.showsChannels {
                    list(server)
                } else {
                    ContentUnavailableView(
                        "No channels",
                        systemImage: "number",
                        description: Text("Nobody has made a channel on \(server.entry.name) yet.")
                    )
                    .foregroundStyle(Theme.text2)
                    .accessibilityIdentifier(A11y.Channels.empty)
                }
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg0)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ServerToolbarItem()
            ToolbarItem(placement: .principal) { title }
            if let server = model.activeServer, server.isAdmin {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        editing = .new(.text, category: "")
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New channel")
                    .accessibilityIdentifier(A11y.Channels.newChannel)
                }
            }
        }
        .toolbarBackground(Theme.bg0, for: .navigationBar)
        .onChange(of: model.activeServerId) { query = "" }
        .sheet(item: $editing) { target in
            if let serverId = model.activeServerId {
                ChannelEditor(serverId: serverId, target: target)
            }
        }
        .confirmationDialog(muting.map { "Mute \($0.title)" } ?? "", isPresented: Binding(get: { muting != nil }, set: { if !$0 { muting = nil } }), titleVisibility: .visible, presenting: muting) { target in
            MuteButtons(conversationKey: target.key, serverId: target.serverId)
        }
        .confirmationDialog(deleting.map { "Delete #\($0.title)? Its messages go for everyone." } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { channel in
            Button("Delete channel", role: .destructive) {
                if let serverId = model.activeServerId { model.deleteChannel(channel, on: serverId) }
            }
        }
    }

    private func list(_ server: AppModel.ServerState) -> some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let nothingFound = !needle.isEmpty && !server.channels.contains { $0.name.lowercased().contains(needle) }
        return PullSearchList(query: $query, prompt: "Search channels", identifier: A11y.Channels.listSearch, resetKey: model.activeServerId) {
            ChannelRows(server: server, query: query, sidebar: false, actions: actions(server))
            if nothingFound {
                ContentUnavailableView.search(text: query)
                    .foregroundStyle(Theme.text2)
                    .listRowBackground(Theme.bg0)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        // Channel rows are Discord's height, lower than the list's usual rows.
        .environment(\.defaultMinListRowHeight, 1)
        // The first heading close under the search bar, as the chats' filters are.
        .contentMargins(.top, 0, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .accessibilityIdentifier(A11y.Channels.list)
    }

    private func actions(_ server: AppModel.ServerState) -> ChannelListActions {
        ChannelListActions(
            create: { type, category in editing = .new(type, category: category) },
            edit: { editing = .edit(channelId: $0.id) },
            delete: { deleting = $0 },
            mute: { muting = ChatListView.MutingTarget(key: $0.key, title: "#\($0.title)", serverId: server.entry.id) }
        )
    }

    // MARK: Navigation bar

    /// The server's name, or how it's connecting.
    private var title: some View {
        titleLabel
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
    }

    private var titleLabel: some View {
        HStack(spacing: 8) {
            if (model.activeServer?.connection ?? .online) != .online {
                ProgressView().controlSize(.small)
            }
            Text(titleText)
                .font(.headline)
                .foregroundStyle(Theme.text1)
                .lineLimit(1)
        }
    }

    private var titleText: String {
        switch model.activeServer?.connection ?? .online {
        case .online: model.activeServer?.entry.name ?? "Channels"
        case .syncing: "Updating…"
        case .connecting: "Connecting…"
        case .offline: "Waiting for network…"
        }
    }
}
