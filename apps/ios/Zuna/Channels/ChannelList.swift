import SwiftUI
import ZunaModels

extension ChannelType {
    /// "#" for text, a speaker for voice, as in Discord.
    var symbol: String { self == .voice ? "speaker.wave.2.fill" : "number" }
}

extension ChannelView {
    /// What it's called, or why it can't be said.
    var title: String { name.isEmpty ? (unreadable ? "Unreadable channel" : "Channel") : name }
}

extension AppModel {
    /// Deletes a channel for everyone, and closes it if it's open.
    func deleteChannel(_ channel: ChannelView, on serverId: String) {
        Task {
            do {
                try await core.session(serverId).deleteChannel(channel.id)
                if chatPath.first == .chat(channel.key) { chatPath = [] }
            } catch {
                toast(ErrorText.describe(error), .error)
            }
        }
    }
}

/// A channel where a picture would be, such as among the chats to forward to.
struct ChannelIcon: View {
    let type: ChannelType
    let size: CGFloat

    var body: some View {
        Image(systemName: type.symbol)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(Theme.text1)
            .frame(width: size, height: size)
            .background(Theme.bg4, in: .circle)
            .accessibilityHidden(true)
    }
}

/// What the list asks of its chat list for a channel: edit it, delete it, mute it,
/// or make a new one under a heading.
struct ChannelListActions {
    var create: (_ type: ChannelType, _ category: String) -> Void
    var edit: (_ channel: ChannelView) -> Void
    var delete: (_ channel: ChannelView) -> Void
    var mute: (_ channel: ChannelView) -> Void
}

/// The server's channels at the top of the chat list, as on the desktop: uppercase
/// headings that fold, "#" and speaker rows, a white mark for unread and a red count
/// of mentions, and who's in each voice channel. Rows of the list it's in.
struct ChannelRows: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    let server: AppModel.ServerState
    let query: String
    /// The open chat stays marked, beside the list on an iPad.
    let sidebar: Bool
    let actions: ChannelListActions
    @State private var collapsed = AppSettings.collapsedCategories

    private struct Heading: Identifiable {
        let name: String
        /// What its add button makes.
        let type: ChannelType
        var channels: [ChannelView]
        var id: String { name }
    }

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = needle.isEmpty ? server.channels : server.channels.filter { $0.name.lowercased().contains(needle) }
        let all = headings(shown)
        ForEach(all) { heading in
            let folded = collapsed.contains(heading.name) && needle.isEmpty
            headingRow(heading, folded: folded, first: heading.id == all.first?.id)
            // A folded heading keeps showing what mentions you.
            ForEach(folded ? heading.channels.filter { ($0.conversation?.unreadMentions ?? 0) > 0 } : heading.channels) { channel in
                row(channel)
                ForEach(occupants(channel), id: \.deviceId) { member in
                    occupantRow(member)
                }
            }
        }
        if server.channels.isEmpty, server.isAdmin, needle.isEmpty {
            Button {
                actions.create(.text, "")
            } label: {
                Label("New channel", systemImage: "plus")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 14))
            .listRowBackground(Theme.bg0)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier(A11y.Channels.newChannel)
        }
    }

    /// A channel's own heading if it has one, or one for its type, in the order they come up.
    private func headings(_ channels: [ChannelView]) -> [Heading] {
        var headings: [Heading] = []
        for channel in channels {
            let name = channel.category.isEmpty ? (channel.type == .voice ? "Voice channels" : "Text channels") : channel.category
            if let index = headings.firstIndex(where: { $0.name == name }) {
                headings[index].channels.append(channel)
            } else {
                headings.append(Heading(name: name, type: channel.type, channels: [channel]))
            }
        }
        return headings
    }

    /// The first heading sits close under what's above the list; the rest keep a gap between groups.
    private func headingRow(_ heading: Heading, folded: Bool, first: Bool) -> some View {
        HStack(spacing: 4) {
            Button {
                withAnimation(model.reduceMotion ? nil : .snappy(duration: 0.2)) {
                    if collapsed.contains(heading.name) { collapsed.remove(heading.name) } else { collapsed.insert(heading.name) }
                }
                AppSettings.collapsedCategories = collapsed
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .heavy))
                        .rotationEffect(.degrees(folded ? -90 : 0))
                    Text(heading.name.uppercased())
                        .font(.caption.weight(.semibold))
                        .tracking(0.4)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .accessibilityValue(folded ? "Folded" : "Open")
            .accessibilityIdentifier(A11y.Channels.heading(heading.name))
            if server.isAdmin {
                Button {
                    actions.create(heading.type, heading.name == "Text channels" || heading.name == "Voice channels" ? "" : heading.name)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .semibold))
                        .frame(width: 30, height: 26)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("New channel in \(heading.name)")
                .accessibilityIdentifier(A11y.Channels.add(heading.name))
            }
        }
        .foregroundStyle(Theme.channelMuted)
        .listRowInsets(EdgeInsets(top: first ? 4 : 12, leading: 14, bottom: 2, trailing: 10))
        .listRowBackground(Theme.bg0)
        .listRowSeparator(.hidden)
    }

    private func row(_ channel: ChannelView) -> some View {
        let conversation = channel.conversation
        // A voice channel is somewhere to go, not something to read, so only a mention marks one.
        let unread = channel.type == .text && (conversation?.unread ?? 0) > 0 && conversation?.muted != true
        let mentions = conversation?.unreadMentions ?? 0
        let open = sidebar && model.chatPath.first == .chat(channel.key)
        let count = occupants(channel).count
        // The voice channel this device is in, as on the desktop.
        let connected = voice.inCall && voice.serverId == server.entry.id && voice.channelId == channel.id
        return Button {
            openChannel(channel)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: channel.type.symbol)
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 24)
                    .accessibilityHidden(true)
                Text(channel.title)
                    .font(.body.weight(unread || open ? .semibold : .medium))
                    .lineLimit(1)
                if conversation?.muted == true {
                    Image(systemName: "bell.slash.fill")
                        .font(.caption2)
                        .accessibilityLabel("Muted")
                }
                Spacer(minLength: 6)
                if channel.type == .voice, channel.userLimit > 0 {
                    Text("\(count)/\(channel.userLimit)")
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .padding(.horizontal, 6)
                        .frame(height: 18)
                        .background(Theme.bg3, in: .capsule)
                }
                if mentions > 0 {
                    Text(mentions > 99 ? "99+" : "\(mentions)")
                        .font(.caption.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Theme.red, in: .capsule)
                        .accessibilityLabel("\(mentions) mentioning you")
                }
            }
            .foregroundStyle(connected ? Theme.green : unread || open ? Theme.text1 : conversation?.muted == true ? Theme.text3 : Theme.channelMuted)
            .padding(.horizontal, 8)
            .frame(minHeight: 40)
            .background(open ? Theme.bg3 : .clear, in: .rect(cornerRadius: 8))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(channel.unreadable)
        // The white mark at the edge, as in Discord.
        .overlay(alignment: .leading) {
            if unread {
                UnevenRoundedRectangle(bottomTrailingRadius: 4, topTrailingRadius: 4)
                    .fill(Theme.text1)
                    .frame(width: 4, height: 8)
                    .offset(x: -8)
            }
        }
        .listRowInsets(EdgeInsets(top: 1, leading: 8, bottom: 1, trailing: 8))
        .listRowBackground(Theme.bg0)
        .listRowSeparator(.hidden)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(open || connected ? .isSelected : [])
        .accessibilityValue(connected ? "Connected" : unread ? "Unread" : "")
        .accessibilityIdentifier(A11y.Channels.row(channel.id))
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if let conversation, conversation.unread > 0 {
                Button {
                    model.markChatRead(channel.key, on: server.entry.id)
                } label: {
                    Label("Read", systemImage: "message.fill")
                }
                .tint(model.settings.accent.color)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let conversation {
                Button {
                    if conversation.muted { model.unmute(channel.key, on: server.entry.id) } else { actions.mute(channel) }
                } label: {
                    Label(conversation.muted ? "Unmute" : "Mute", systemImage: conversation.muted ? "speaker.wave.2.fill" : "speaker.slash.fill")
                }
                .tint(Theme.amber)
            }
        }
        .contextMenu { menu(channel) }
    }

    @ViewBuilder
    private func menu(_ channel: ChannelView) -> some View {
        if let conversation = channel.conversation {
            if conversation.unread > 0 {
                Button("Mark as read", systemImage: "checkmark.message") { model.markChatRead(channel.key, on: server.entry.id) }
            }
            if conversation.muted {
                Button("Unmute", systemImage: "speaker.wave.2") { model.unmute(channel.key, on: server.entry.id) }
            } else {
                Menu {
                    MuteButtons(conversationKey: channel.key, serverId: server.entry.id)
                } label: {
                    Label("Mute", systemImage: "speaker.slash")
                }
            }
        }
        if server.isAdmin {
            Divider()
            Button("Edit channel", systemImage: "pencil") { actions.edit(channel) }
            Button("Delete channel", systemImage: "trash", role: .destructive) { actions.delete(channel) }
        }
    }

    /// Who's in a voice channel, in the order they came.
    private func occupants(_ channel: ChannelView) -> [VoiceMember] {
        guard channel.type == .voice else { return [] }
        return server.voice.values.filter { $0.channelId == channel.id }.sorted { $0.since < $1.since }
    }

    private func occupantRow(_ member: VoiceMember) -> some View {
        let user = server.users[member.userId]
        let name = user?.displayName ?? "Someone"
        // Who's talking shows only to those in the same call, as only they hear it.
        let inThisCall = voice.status == .connected && voice.serverId == server.entry.id && voice.channelId == member.channelId
        let speaking = inThisCall && voice.speaking.contains(member.userId) && !(member.userId == server.me?.userId && voice.micOff)
        return HStack(spacing: 8) {
            AvatarView(name: name, seed: member.userId, source: user?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 22)
                .overlay {
                    Circle().strokeBorder(speaking ? Theme.green : .clear, lineWidth: 2).padding(-2)
                }
            Text(name)
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .lineLimit(1)
            Spacer(minLength: 4)
            if member.screen {
                Text("LIVE")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .frame(height: 16)
                    .background(Theme.red, in: .rect(cornerRadius: 4))
            }
            if member.camera {
                Image(systemName: "video.fill").font(.caption2).accessibilityLabel("Camera on")
            }
            if member.serverMuted {
                Image(systemName: "mic.slash.fill").font(.caption2).foregroundStyle(Theme.red).accessibilityLabel("Muted by an admin")
            } else if member.muted && !member.deafened {
                Image(systemName: "mic.slash.fill").font(.caption2).accessibilityLabel("Muted")
            }
            if member.deafened {
                Image(systemName: "speaker.slash.fill").font(.caption2).accessibilityLabel("Deafened")
            }
        }
        .foregroundStyle(Theme.channelMuted)
        .padding(.leading, 40)
        .frame(minHeight: 30)
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
        .listRowBackground(Theme.bg0)
        .listRowSeparator(.hidden)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Channels.occupant(member.deviceId))
    }

    private func openChannel(_ channel: ChannelView) {
        guard channel.type == .text else {
            // Tapping a voice channel is coming into it, as in Discord, or opening the call already there.
            guard (server.info?.voice ?? 0) > 0 else {
                model.toast("This server has no media server yet, so its voice channels can't be joined.")
                return
            }
            let serverId = server.entry.id
            Task { await voice.join(serverId: serverId, channelId: channel.id) }
            return
        }
        model.openChat(channel.key)
    }
}
