import SwiftUI
import ZunaModels

/// A channel's details, as Discord's phone app opens them from the channel's name:
/// its topic, a row for notifications, search and pins, what's been shared, and the member
/// list, which on the desktop is on the right: everyone on the server, online
/// first, with a crown for the owner.
struct ChannelDetails: View {
    let conversationKey: String

    @Environment(AppModel.self) private var model
    @State private var sheet: DetailsSheet?
    @State private var choosingMute = false
    @State private var confirmingDelete = false
    @State private var mediaCounts: MediaCounts?

    private enum DetailsSheet: Identifiable {
        case search, edit(String), profile(String)

        var id: String {
            switch self {
            case .search: "search"
            case let .edit(id): "edit-\(id)"
            case let .profile(userId): "profile-\(userId)"
            }
        }
    }

    var body: some View {
        Group {
            if let server = model.activeServer, let channel = server.channel(conversationKey) {
                content(server, channel)
            } else {
                ContentUnavailableView("This channel isn't available", systemImage: "number")
            }
        }
        .background(Theme.bg0)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
    }

    private func content(_ server: AppModel.ServerState, _ channel: ChannelView) -> some View {
        let serverId = server.entry.id
        let conversation = channel.conversation
        return List {
            Section {
                VStack(spacing: 8) {
                    ChannelIcon(type: channel.type, size: 80)
                    Text("#\(channel.title)")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Theme.text1)
                        .multilineTextAlignment(.center)
                    if !channel.topic.isEmpty {
                        Text(channel.topic)
                            .font(.subheadline)
                            .foregroundStyle(Theme.text2)
                            .multilineTextAlignment(.center)
                    }
                    if let conversation {
                        DetailsActions(actions: [
                            .init(id: "mute", title: conversation.muted ? "Unmute" : "Mute", icon: conversation.muted ? "bell.slash.fill" : "bell.fill") {
                                if conversation.muted { model.unmute(conversation.key, on: serverId) } else { choosingMute = true }
                            },
                            .init(id: "search", title: "Search", icon: "magnifyingglass") { sheet = .search },
                            .init(id: "pins", title: "Pins", icon: "pin.fill") { model.chatPath.append(.pins(conversation.key)) },
                        ])
                        .padding(.top, 18)
                    }
                }
                .frame(maxWidth: .infinity)
                // The buttons as wide as the cards under them.
                .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
            }
            .listRowBackground(Color.clear)

            Section {
                Label("End-to-end encrypted. Everyone on this server can read it, and the server itself can't.", systemImage: "lock.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
            }
            .listRowBackground(Theme.bg2)

            if let conversation {
                Section {
                    Toggle(isOn: Binding(get: { !conversation.muted }, set: { on in
                        if on { model.unmute(conversation.key, on: serverId) } else { choosingMute = true }
                    })) {
                        Label {
                            Text("Notifications")
                            Text(conversation.mutedUntil.map(Format.mutedUntil) ?? "Only when someone mentions you or answers you")
                        } icon: {
                            Image(systemName: conversation.muted ? "bell.slash" : "bell")
                        }
                    }
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Details.notifications)
                }
                .foregroundStyle(Theme.text1)
                .listRowBackground(Theme.bg2)
                sharedMedia(conversation)
            }

            if server.isAdmin {
                Section {
                    Button("Edit channel", systemImage: "pencil") { sheet = .edit(channel.id) }
                        .foregroundStyle(Theme.text1)
                        .accessibilityIdentifier(A11y.Channels.edit)
                    Button("Delete channel", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                        .accessibilityIdentifier(A11y.Channels.delete)
                }
                .listRowBackground(Theme.bg2)
            }

            members(server)
        }
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier(A11y.Channels.details)
        .task(id: conversation.map { model.chatChange(serverId, $0) }) {
            guard let groupId = conversation?.groupId else { return }
            // New messages come in bursts as history arrives, so counting again waits for a quiet moment.
            if mediaCounts != nil { try? await Task.sleep(for: .milliseconds(150)) }
            guard !Task.isCancelled, let counts = try? await model.core.session(serverId).mediaCounts(groupId), !Task.isCancelled else { return }
            mediaCounts = counts
        }
        // On the list, not the switch: a list leaves out rows off screen, and the row under the name asks too.
        .confirmationDialog("Mute notifications", isPresented: $choosingMute, titleVisibility: .visible) {
            if let conversation { MuteButtons(conversationKey: conversation.key, serverId: serverId) }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .search:
                if let conversation { ChatSearchSheet(serverId: serverId, conversation: conversation, server: server) }
            case let .edit(id):
                ChannelEditor(serverId: serverId, target: .edit(channelId: id))
            case let .profile(userId):
                VerifyView(serverId: serverId, userId: userId)
            }
        }
        .confirmationDialog("Delete #\(channel.title)? Its messages go for everyone.", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete channel", role: .destructive) {
                Task {
                    do {
                        try await model.core.session(serverId).deleteChannel(channel.id)
                        model.chatPath = []
                    } catch {
                        model.toast(OnboardingText.describe(error), .error)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func sharedMedia(_ conversation: ConversationView) -> some View {
        let rows = SharedKind.allCases.filter { $0 != .groups }.map { ($0, $0.count(in: mediaCounts, groups: 0)) }.filter { $0.1 > 0 }
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.0) { kind, count in
                    NavigationLink(value: ChatRoute.media(conversation.key, kind)) {
                        Label(kind.counted(count), systemImage: kind.icon)
                    }
                    .accessibilityIdentifier(A11y.Details.shared(kind.rawValue))
                }
            }
            .foregroundStyle(Theme.text1)
            .listRowBackground(Theme.bg2)
        }
    }

    /// Everyone who can read the channel, which is everyone on the server: online first, then the rest, faded.
    @ViewBuilder
    private func members(_ server: AppModel.ServerState) -> some View {
        let (online, offline) = server.channelMembers
        if !online.isEmpty {
            Section("Online — \(online.count)") {
                ForEach(online) { member($0, server: server) }
            }
            .listRowBackground(Theme.bg2)
        }
        if !offline.isEmpty {
            Section("Offline — \(offline.count)") {
                ForEach(offline) { member($0, server: server).opacity(0.45) }
            }
            .listRowBackground(Theme.bg2)
        }
    }

    private func member(_ user: UserView, server: AppModel.ServerState) -> some View {
        Button {
            if !user.isSelf { sheet = .profile(user.id) }
        } label: {
            HStack(spacing: 12) {
                AvatarView(name: user.displayName, seed: user.id, source: user.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 36, online: user.online)
                Text(user.displayName)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.nameColor(user.id))
                    .lineLimit(1)
                if user.role == .owner {
                    Image(systemName: "crown.fill")
                        .font(.caption)
                        .foregroundStyle(Color(hex: 0xF0B232))
                        .accessibilityLabel("Owner")
                }
                if user.isSelf {
                    Text("(you)").foregroundStyle(Theme.text3)
                }
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(A11y.Channels.member(user.id))
    }
}
