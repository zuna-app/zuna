import SwiftUI
import ZunaModels

/// One message in a channel, laid out as the desktop lays out Discord's: a picture
/// and a name with the time over a run of messages, each a full-width row, what it
/// answers above it joined to the picture by a line, "(edited)" after the text,
/// and files, previews and reactions under it. Direct messages and groups keep
/// their bubbles (MessageRow.swift).
struct ChannelMessageRow: View {
    @Environment(AppModel.self) private var model
    let context: MessageRowContext
    let server: AppModel.ServerState
    let actions: ChatActions
    @State private var revealed: Set<Int> = []
    /// A message from someone blocked shows as a line, as on the desktop, and itself only when asked.
    @State private var showBlocked = false

    private var message: MessageView { context.message }
    private var deleted: Bool { message.deletedAt != nil }
    private var selfId: String { server.me?.userId ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if context.startOfChat, let channel = server.channels.first(where: { $0.id == message.groupId }) {
                ChannelWelcome(channel: channel, edit: actions.editChannel)
            }
            if context.showDay || context.unreadLine {
                ChannelDivider(day: context.showDay ? message.createdAt : nil, unread: context.unreadLine)
            }
            if message.system != nil {
                ChannelSystemLine(message: message, server: server)
            } else if !context.own && server.isBlocked(message.senderId) && !showBlocked {
                blockedLine
            } else {
                item
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blockedLine: some View {
        HStack(spacing: 6) {
            Label("A message from someone you blocked", systemImage: "nosign")
                .font(.footnote)
                .foregroundStyle(Theme.channelMuted)
            Button("Show") { showBlocked = true }
                .font(.footnote.weight(.semibold))
            Spacer(minLength: 0)
        }
        .padding(.leading, 68)
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.blockedMessage(message.id))
    }

    private var mentionsMe: Bool {
        !context.own && (message.mentions.contains(selfId) || message.reply?.senderId == selfId)
    }

    private var item: some View {
        HStack(alignment: .center, spacing: 10) {
            if context.selecting { checkmark }
            VStack(alignment: .leading, spacing: 2) {
                if let reply = message.reply, message.status == .sent || message.status == .sending || message.status == .failed {
                    ChannelReplyLine(reply: reply, server: server) { actions.jump(reply.id) }
                }
                HStack(alignment: .top, spacing: 12) {
                    if context.grouped {
                        Color.clear.frame(width: 40, height: 1)
                    } else {
                        let sender = server.users[message.senderId]
                        Button {
                            // Whoever wrote one that hasn't opened isn't known yet: there's nobody to mention.
                            if !message.senderId.isEmpty { actions.mention(message.senderId) }
                        } label: {
                            AvatarView(
                                name: sender?.displayName ?? "?",
                                seed: message.senderId,
                                source: sender?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                                size: 40
                            )
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 2)
                        .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        if !context.grouped { head }
                        content
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.top, context.grouped ? 2 : 14)
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
        .overlay(alignment: .leading) {
            // Mentioning you, or answering you: gold, with a line down the left, as in Discord.
            if mentionsMe { Rectangle().fill(Theme.amber).frame(width: 2) }
        }
        .contentShape(.rect)
        .contentShape(.contextMenuPreview, .rect)
        // Not while it's being edited, where a long press is for the text.
        .contextMenu { if !context.editing { MessageMenu(context: context, actions: actions) } }
        // While picking, a tap anywhere on the row picks it, instead of opening what's under it.
        .overlay {
            if context.selecting {
                Color.clear
                    .contentShape(.rect)
                    .onTapGesture { if selectable { actions.select(message) } }
                    .accessibilityElement()
                    .accessibilityLabel(context.selected ? "Selected" : "Not selected")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier(A11y.Chat.selectToggle(message.id))
            }
        }
        .animation(.easeOut(duration: 0.4), value: context.highlighted)
        .swipeToReply(inset: 0)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.message(message.id))
    }

    private var background: Color {
        if context.selected { return model.settings.accent.color.opacity(0.18) }
        if context.highlighted { return Color.white.opacity(0.09) }
        return mentionsMe ? Theme.amber.opacity(0.08) : .clear
    }

    private var selectable: Bool {
        message.seq != nil && !deleted && message.status == .sent
    }

    private var checkmark: some View {
        ZStack {
            Circle().strokeBorder(Theme.text3, lineWidth: 2).opacity(context.selected ? 0 : 1)
            if context.selected {
                Circle().fill(model.settings.accent.color)
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(model.settings.accent.onAccent)
            }
        }
        .frame(width: 22, height: 22)
        .opacity(selectable ? 1 : 0.3)
    }

    /// The name and when, over a run.
    private var head: some View {
        let known = !message.senderId.isEmpty
        let name = known ? server.users[message.senderId]?.displayName ?? "Unknown" : "Not known yet"
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button {
                if known { actions.mention(message.senderId) }
            } label: {
                Text(name)
                    .font(.system(size: textSize, weight: .semibold))
                    .foregroundStyle(known ? Theme.nameColor(message.senderId) : Theme.channelMuted)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            if server.users[message.senderId]?.bot != nil { BotBadge() }
            Text(Format.stamp(message.createdAt))
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.channelMuted)
                .lineLimit(1)
                .layoutPriority(-1)
            if message.timeDiffers == true {
                Image(systemName: "exclamationmark.shield").font(.caption2).foregroundStyle(Theme.channelMuted)
                    .accessibilityLabel("This message's time may be wrong")
            }
            if message.expiresAt != nil {
                Image(systemName: "timer").font(.caption2).foregroundStyle(Theme.channelMuted).accessibilityLabel("Disappears")
            }
            if message.pinnedAt != nil {
                Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Theme.channelMuted).rotationEffect(.degrees(35)).accessibilityLabel("Pinned")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.meta(message.id))
    }

    /// A little larger than in a bubble, as the desktop's channels are.
    private var textSize: CGFloat {
        UIFontMetrics(forTextStyle: .body).scaledValue(for: model.settings.messageSize.points + 1)
    }

    private var jumbo: Int { context.jumbo }

    private var style: TextStyle {
        TextStyle(size: textSize, own: false, color: UIColor(Theme.text1), faint: UIColor(Theme.channelMuted), jumbo: jumbo)
    }

    /// "(edited)" after the text, small and faint, as in Discord.
    private var edited: NSAttributedString? {
        guard message.editedAt != nil, !deleted else { return nil }
        return NSAttributedString(string: " (edited)", attributes: [.font: UIFont.systemFont(ofSize: UIFontMetrics(forTextStyle: .caption2).scaledValue(for: 11)), .foregroundColor: UIColor(Theme.channelMuted)])
    }

    @ViewBuilder
    private var content: some View {
        if deleted {
            placeholder("Message deleted")
        } else if message.status == .undecryptable {
            HStack(spacing: 7) {
                ProgressView().controlSize(.mini)
                Text("Waiting for this message's keys")
            }
            .font(.subheadline)
            .foregroundStyle(Theme.channelMuted)
        } else if message.status == .unverified {
            Label("This message couldn't be verified, so it isn't shown.", systemImage: "exclamationmark.shield")
                .font(.subheadline)
                .foregroundStyle(Color(hex: 0xF4BCBE))
        } else if message.status == .invalid {
            Label("This message couldn't be displayed.", systemImage: "exclamationmark.shield")
                .font(.subheadline)
                .foregroundStyle(Color(hex: 0xF4BCBE))
        } else {
            if context.editing {
                InPlaceEditor(message: message, serverId: server.entry.id, size: textSize)
            } else {
                said
            }
            if !(message.buttons ?? []).isEmpty {
                MessageButtonsView(message: message) { row, column in actions.press(message, row, column) }
            }
            if !message.reactions.isEmpty {
                ChannelReactions(message: message, server: server, canAdd: selectable, react: { actions.react(message.id, $0, $1) }, add: { actions.pickReaction(message.id) })
            }
            if message.status == .failed {
                Button {
                    actions.retry(message.id)
                } label: {
                    Label("Not sent. Try again", systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(Theme.red)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// What the message says and carries: the text, files, a link's preview and a place.
    private var said: some View {
        Group {
            if let forwarded = message.forwarded {
                ForwardedLabel(forwarded: forwarded, own: false, server: server, open: actions.mention)
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.spine).frame(width: 2) }
            }
            if !message.text.isEmpty {
                MessageBodyView(message: message, style: style, server: server, reserveMeta: nil, revealed: revealed, actions: actions, suffix: edited) {
                    revealed.insert($0)
                }
                .fixedSize(horizontal: jumbo > 0, vertical: false)
            }
            if !message.attachments.isEmpty {
                AttachmentsView(message: message, serverId: server.entry.id, flush: false, open: { actions.open($0, message) })
                    .frame(maxWidth: 420, alignment: .leading)
            }
            if let preview = message.preview {
                LinkCard(preview: preview, own: false, messageId: message.id)
                    .frame(maxWidth: 420, alignment: .leading)
            }
            if let location = message.location {
                LocationCard(location: location, own: false, messageId: message.id)
                    .frame(maxWidth: 420, alignment: .leading)
            }
        }
        .modifier(SendingDim(message: message, opacity: 0.55))
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.system(size: textSize))
            .italic()
            .foregroundStyle(Theme.channelMuted)
    }
}

/// A message in a channel edited where it is, as in Discord. On a hardware keyboard
/// Return saves it and Escape leaves it as it was, as on the desktop; the links under
/// it do the same on screen. The composer's draft stays as it was.
private struct InPlaceEditor: View {
    @Environment(AppModel.self) private var model
    let message: MessageView
    let serverId: String
    let size: CGFloat
    @FocusState private var focused: Bool

    private var key: String { AppModel.listKey(serverId, message.groupId) }

    private var text: Binding<String> {
        Binding(get: { model.inPlaceText[key] ?? "" }, set: { model.inPlaceText[key] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            TextField("Edit message", text: text, axis: .vertical)
                .lineLimit(1...12)
                .font(.system(size: size))
                .foregroundStyle(Theme.text1)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Theme.bg2, in: .rect(cornerRadius: 8))
                .onKeyPress(phases: .down) { press in handleKey(press) }
                .accessibilityIdentifier(A11y.Channels.inPlaceInput)
            HStack(spacing: 5) {
                Button("Cancel", action: cancel)
                    .accessibilityIdentifier(A11y.Channels.inPlaceCancel)
                Text("•").foregroundStyle(Theme.channelMuted).accessibilityHidden(true)
                Button("Save", action: save)
                    .accessibilityIdentifier(A11y.Channels.inPlaceSave)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.link)
            .buttonStyle(.plain)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Channels.inPlaceEditor)
        // Once it's in the list, which isn't yet as it first appears.
        .task { focused = true }
    }

    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        switch press.key {
        case .escape:
            cancel()
            return .handled
        case .return:
            if press.modifiers.contains(.shift) { return .ignored }
            guard model.settings.enterToSend || press.modifiers.contains(.command) || press.modifiers.contains(.control) else { return .ignored }
            save()
            return .handled
        default:
            return .ignored
        }
    }

    private func save() {
        model.saveInPlace(serverId, in: message.groupId)
    }

    private func cancel() {
        model.editInPlace(serverId, nil, in: message.groupId)
    }
}

/// What a message answers, above it: the line from the picture below, the author's
/// small picture and name, and the start of what they said. A tap shows it.
private struct ChannelReplyLine: View {
    let reply: ReplyPreview
    let server: AppModel.ServerState
    let jump: () -> Void

    var body: some View {
        let user = server.users[reply.senderId]
        let name = user?.displayName ?? "Unknown"
        let text = reply.deleted ? "Original message was deleted" : server.isBlocked(reply.senderId) ? "Message from someone you blocked" : plainText(reply.text)
        Button(action: jump) {
            HStack(spacing: 4) {
                ReplySpine()
                    .stroke(Theme.spine, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 48, height: 18)
                if reply.deleted {
                    Image(systemName: "arrowshape.turn.up.left.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(Theme.text2)
                        .frame(width: 16, height: 16)
                        .background(Theme.bg3, in: .circle)
                } else {
                    AvatarView(name: name, seed: reply.senderId, source: user?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 16)
                    Text("@\(name)")
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.nameColor(reply.senderId.isEmpty ? "x" : reply.senderId))
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                Text(text.isEmpty ? (reply.hasAttachment ? "Tap to see attachment" : "Tap to see message") : text)
                    .italic(text.isEmpty)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                if text.isEmpty && reply.hasAttachment {
                    Image(systemName: "photo").foregroundStyle(Theme.text2)
                }
                Spacer(minLength: 0)
            }
            .font(.subheadline)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.leading, 0)
        .accessibilityIdentifier(A11y.Chat.reply)
    }
}

/// The line from the middle of the picture below up and over to the reply, as Discord draws it.
private struct ReplySpine: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let x: CGFloat = 20
        let y = rect.midY
        path.move(to: CGPoint(x: x, y: rect.maxY + 4))
        path.addLine(to: CGPoint(x: x, y: y + 6))
        path.addQuadCurve(to: CGPoint(x: x + 6, y: y), control: CGPoint(x: x, y: y))
        path.addLine(to: CGPoint(x: rect.maxX - 2, y: y))
        return path
    }
}

/// Reactions under a message, as Discord's: the emoji and how many, outlined when one is yours.
private struct ChannelReactions: View {
    @Environment(AppModel.self) private var model
    let message: MessageView
    let server: AppModel.ServerState
    let canAdd: Bool
    let react: (String, EmoteRef?) -> Void
    let add: () -> Void

    var body: some View {
        let selfId = server.me?.userId ?? ""
        let accent = model.settings.accent
        FlowLayout(spacing: 4) {
            ForEach(message.reactions, id: \.key) { reaction in
                let mine = reaction.userIds.contains(selfId)
                Button {
                    react(reaction.key, reaction.emote)
                } label: {
                    HStack(spacing: 6) {
                        if let emote = reaction.emote {
                            EmoteView(name: reaction.key, id: emote.id, size: .small, serverUrl: server.entry.url)
                                .frame(width: 20, height: 20)
                        } else {
                            Text(reaction.key).font(.system(size: 16))
                        }
                        Text("\(reaction.userIds.count)")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(mine ? Theme.text1 : Theme.text2)
                    }
                    .padding(.horizontal, 7)
                    .frame(minHeight: 28)
                    .background(mine ? accent.color.opacity(0.16) : Theme.bg2, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(mine ? accent.color : .clear))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(reaction.key), \(names(reaction, selfId))")
                .accessibilityAddTraits(mine ? .isSelected : [])
                .accessibilityIdentifier(A11y.Chat.reaction(reaction.key))
            }
            if canAdd {
                Button(action: add) {
                    Image(systemName: "face.smiling")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.text2)
                        .padding(.horizontal, 8)
                        .frame(minHeight: 28)
                        .background(Theme.bg2, in: .rect(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add reaction")
            }
        }
        .padding(.top, 3)
    }

    private func names(_ reaction: ReactionView, _ selfId: String) -> String {
        reaction.userIds.map { $0 == selfId ? "You" : server.users[$0]?.displayName ?? "Someone" }.joined(separator: ", ")
    }
}

/// One line across the list, as in Discord: a new day in the middle of it, and red
/// with "New" at its end above the first unread message.
private struct ChannelDivider: View {
    let day: Int?
    let unread: Bool

    var body: some View {
        let color = unread ? Theme.red : Theme.lineStrong
        HStack(spacing: 6) {
            Rectangle().fill(color).frame(height: 1)
            if let day {
                Text(Format.fullDay(day))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(unread ? Theme.red : Theme.channelMuted)
                    .fixedSize()
                Rectangle().fill(color).frame(height: 1)
            }
            if unread {
                Text("NEW")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.leading, 9)
                    .padding(.trailing, 4)
                    .frame(height: 14)
                    .background(Theme.red, in: NewTag())
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, unread ? 0 : 16)
        .padding(.top, day == nil ? 12 : 20)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier(unread ? A11y.Chat.unreadLine : "")
    }
}

/// The red tag at the end of the "New" line, pointed on the left.
private struct NewTag: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.minX + 5, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + 5, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// A change to the channel, as a line of its own with an arrow where a picture would be.
private struct ChannelSystemLine: View {
    let message: MessageView
    let server: AppModel.ServerState

    var body: some View {
        let system = message.system!
        let warning = system.type == .unexpectedJoin || system.type == .identityChanged
        let actor = system.actorId.map { $0 == server.me?.userId ? "You" : server.users[$0]?.displayName ?? "Someone" } ?? "Someone"
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: warning ? "exclamationmark.shield.fill" : "arrow.right")
                .font(.footnote)
                .foregroundStyle(warning ? Theme.amber : Theme.channelMuted)
                .frame(width: 40)
            Text("\(text(system, actor: actor))  \(Text(Format.stamp(message.createdAt)).font(.caption).foregroundStyle(Theme.channelMuted))")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.message(message.id))
    }

    private func text(_ system: SystemEvent, actor: String) -> String {
        switch system.type {
        case .timerChanged: Format.timerChange(actor, seconds: system.seconds ?? 0)
        case .unexpectedJoin: "\(actor) joined without being added by a member. Check that this is expected."
        case .identityChanged: "\(actor)'s security key changed. Verify it before trusting new messages."
        case .identityRotated: "\(actor)'s security key changed since you verified it."
        case .deviceAdded: "\(actor) added a device"
        default: "\(actor) changed who's here"
        }
    }
}

/// The top of a channel's history, as in Discord.
struct ChannelWelcome: View {
    let channel: ChannelView
    /// Edits the channel, for a server admin.
    var edit: (() -> Void)?

    var body: some View {
        let name = channel.title
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: channel.type.symbol)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.text1)
                .frame(width: 68, height: 68)
                .background(Theme.bg3, in: .circle)
            Text("Welcome to #\(name)!")
                .font(.title.weight(.bold))
                .foregroundStyle(Theme.text1)
                .padding(.top, 4)
            Text("This is the start of the #\(name) channel.\(channel.topic.isEmpty ? "" : " \(channel.topic)")")
                .font(.body)
                .foregroundStyle(Theme.text2)
            Label("End-to-end encrypted. Everyone on this server can read it, but the server itself can't.", systemImage: "lock.fill")
                .font(.footnote)
                .foregroundStyle(Theme.channelMuted)
                .padding(.top, 2)
            if let edit {
                Button(action: edit) {
                    Label("Edit channel", systemImage: "pencil")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.link)
                }
                .buttonStyle(.plain)
                .padding(.top, 6)
                .accessibilityIdentifier(A11y.Channels.welcomeEdit)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Channels.welcome)
    }
}

/// Who's typing in a channel, just above the message box, as in Discord. Always
/// there, as on the desktop, so nothing moves when someone starts.
struct ChannelTyping: View {
    let names: [String]

    var body: some View {
        HStack(spacing: 6) {
            if !names.isEmpty {
                TypingDots()
                    .foregroundStyle(Theme.text1)
                Text(sentence)
                    .font(.footnote)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 22, maxHeight: 22, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(names.isEmpty ? "" : A11y.Channels.typing)
    }

    private var sentence: AttributedString {
        let bold = { (name: String) in AttributedString(name, attributes: AttributeContainer().font(.footnote.weight(.bold))) }
        switch names.count {
        case 1: return bold(names[0]) + AttributedString(" is typing…")
        case 2: return bold(names[0]) + AttributedString(" and ") + bold(names[1]) + AttributedString(" are typing…")
        case 3: return bold(names[0]) + AttributedString(", ") + bold(names[1]) + AttributedString(" and ") + bold(names[2]) + AttributedString(" are typing…")
        default: return AttributedString("Several people are typing…")
        }
    }
}
