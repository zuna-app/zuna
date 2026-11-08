import SwiftUI
import ZunaModels

extension AppModel.ServerState {
    /// Who can read a channel, which is everyone on the server, as the desktop lists
    /// them: those online, and you, first, then the rest, each by name.
    @MainActor func channelMembers(_ live: LiveState) -> (online: [UserView], offline: [UserView]) {
        let people = users.values
            .filter { !$0.banned && !$0.deleted }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        let here = people.filter { live.isOnline($0) || $0.isSelf }
        return (here, people.filter { !live.isOnline($0) && !$0.isSelf })
    }
}

/// A channel's members beside its chat, as on the desktop's right, on an iPad with
/// room for them: online first, then the rest, faded, with a crown for the owner.
/// A tap shows someone's profile, and a long press can also open a chat with them.
struct ChannelMemberList: View {
    @Environment(AppModel.self) private var model
    let server: AppModel.ServerState
    let profile: (_ userId: String) -> Void

    static let width: CGFloat = 240

    var body: some View {
        let members = server.channelMembers(model.live(server.entry.id))
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 1) {
                if !members.online.isEmpty {
                    heading("Online — \(members.online.count)")
                    ForEach(members.online) { row($0, online: true) }
                }
                if !members.offline.isEmpty {
                    heading("Offline — \(members.offline.count)")
                    ForEach(members.offline) { row($0, online: false) }
                }
            }
            .padding(.bottom, 20)
        }
        .frame(width: Self.width)
        .background(Theme.bg1)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Members")
        .accessibilityIdentifier(A11y.Channels.memberList)
    }

    private func heading(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .kerning(0.3)
            .foregroundStyle(Theme.channelMuted)
            .lineLimit(1)
            .padding(.leading, 16)
            .padding(.trailing, 8)
            .padding(.top, 22)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func row(_ user: UserView, online: Bool) -> some View {
        Button {
            if !user.isSelf { profile(user.id) }
        } label: {
            HStack(spacing: 12) {
                AvatarView(name: user.displayName, seed: user.id, source: user.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 32, online: online)
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
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(height: 42)
            .opacity(online ? 1 : 0.35)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .contextMenu {
            if !user.isSelf {
                Button("Profile", systemImage: "person.crop.circle") { profile(user.id) }
                Button("Message", systemImage: "bubble.left") { model.openChat("user:\(user.id)") }
            }
        }
        .accessibilityIdentifier(A11y.Channels.listedMember(user.id))
    }
}
