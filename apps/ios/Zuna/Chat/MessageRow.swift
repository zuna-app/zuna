import SwiftUI
import ZunaModels

/// What a row needs besides its message: where it sits among its neighbors,
/// and what it should know about the server. Built by the list for each row.
struct MessageRowContext {
    let message: MessageView
    let showDay: Bool
    /// Follows a message from the same sender within five minutes.
    let grouped: Bool
    let lastInGroup: Bool
    let own: Bool
    let isGroup: Bool
    /// The highest message anyone else has read, for the read ticks.
    let readUpTo: Int
    let highlighted: Bool
    /// Messages are being picked to act on together, and whether this one is.
    let selecting: Bool
    let selected: Bool
}

/// The things a message can ask its chat to do.
@MainActor
struct ChatActions {
    var jump: (_ messageId: String) -> Void = { _ in }
    var open: (_ attachment: Attachment) -> Void = { _ in }
    var react: (_ messageId: String, _ key: String, _ emote: EmoteRef?) -> Void = { _, _, _ in }
    var retry: (_ messageId: String) -> Void = { _ in }
    var mention: (_ userId: String) -> Void = { _ in }
    /// Shows an emote's card: its name, who made it, and who reacted with it.
    var emoteCard: (_ name: String, _ emote: EmoteRef, _ note: String?) -> Void = { _, _, _ in }
    var reply: (_ message: MessageView) -> Void = { _ in }
    var forward: (_ message: MessageView) -> Void = { _ in }
    /// Starts picking messages with this one, or adds or removes it.
    var select: (_ message: MessageView) -> Void = { _ in }
    var edit: (_ message: MessageView) -> Void = { _ in }
    var pin: (_ message: MessageView, _ pinned: Bool) -> Void = { _, _ in }
    var delete: (_ message: MessageView) -> Void = { _ in }
    var discard: (_ messageId: String) -> Void = { _ in }
    /// The full picker, for a reaction that isn't among the quick ones.
    var pickReaction: (_ messageId: String) -> Void = { _ in }
    /// You can delete others' messages here: you're an admin of this group.
    var isGroupAdmin = false
}

/// The reactions offered first, as on the desktop.
let quickReactions = ["👍", "❤️", "😂", "🔥", "😮", "😢"]

/// One message in the list, with the day's separator above it when a new day starts.
struct MessageRow: View {
    @Environment(AppModel.self) private var model
    let context: MessageRowContext
    let server: AppModel.ServerState
    let actions: ChatActions

    var body: some View {
        VStack(spacing: 0) {
            if context.showDay {
                Text(Format.daySeparator(context.message.createdAt))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.text2)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .background(Theme.bg2, in: .capsule)
                    .padding(.top, 14)
                    .padding(.bottom, 8)
                    .accessibilityAddTraits(.isHeader)
            }
            if context.message.system != nil {
                SystemRow(message: context.message, server: server)
            } else {
                HStack(alignment: .bottom, spacing: 6) {
                    if context.selecting { checkmark.padding(.bottom, 6) }
                    MessageItem(context: context, server: server, actions: actions)
                }
                // While picking, a tap anywhere on the row picks it, instead of opening what's under it.
                .overlay {
                    if context.selecting {
                        Color.clear
                            .contentShape(.rect)
                            .onTapGesture { if selectable { actions.select(context.message) } }
                            .accessibilityElement()
                            .accessibilityLabel(context.selected ? "Selected" : "Not selected")
                            .accessibilityAddTraits(.isButton)
                            .accessibilityIdentifier(A11y.Chat.selectToggle(context.message.id))
                    }
                }
                .background(context.selected ? model.settings.accent.color.opacity(0.18) : .clear, in: .rect(cornerRadius: 12))
            }
        }
        .padding(.horizontal, 8)
        .background(context.highlighted ? Color.white.opacity(0.09) : .clear, in: .rect(cornerRadius: 12))
        .animation(.easeOut(duration: 0.4), value: context.highlighted)
    }

    private var selectable: Bool {
        let message = context.message
        return message.seq != nil && message.deletedAt == nil && message.status == .sent
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
}

/// Membership changes and warnings, as a pill in the middle.
private struct SystemRow: View {
    let message: MessageView
    let server: AppModel.ServerState

    var body: some View {
        let system = message.system!
        let warning = system.type == .unexpectedJoin || system.type == .identityChanged
        HStack(spacing: 6) {
            if warning {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.amber)
            }
            Text(text(system))
        }
        .font(.footnote)
        .foregroundStyle(warning ? Color(hex: 0xE8D3A2) : Theme.text2)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(warning ? Theme.amber.opacity(0.12) : Theme.bg2, in: .rect(cornerRadius: 10))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.message(message.id))
    }

    private func name(_ id: String?) -> String {
        guard let id else { return "Someone" }
        if id == server.me?.userId { return "You" }
        return server.users[id]?.displayName ?? "Someone"
    }

    /// The desktop's wording for each kind.
    private func text(_ system: SystemEvent) -> String {
        let targets = (system.targetIds ?? []).map(name).joined(separator: ", ")
        switch system.type {
        case .groupCreated: return "\(name(system.actorId)) created this group"
        case .memberAdded: return "\(name(system.actorId)) added \(targets)"
        case .memberRemoved: return "\(name(system.actorId)) removed \(targets)"
        case .memberLeft: return "\(name(system.actorId)) left the group"
        case .memberRejoined: return "\(name(system.actorId)) rejoined this chat"
        case .unexpectedJoin: return "\(name(system.actorId)) joined without being added by a member. Check that this is expected."
        case .identityChanged: return "\(name(system.actorId))'s security key changed. Verify it before trusting new messages."
        case .deviceAdded: return "\(name(system.actorId)) added a device"
        }
    }
}

/// A message bubble, laid out like Telegram's: yours on the right in the
/// accent's color, others on the left, the time tucked into the last line.
private struct MessageItem: View {
    @Environment(AppModel.self) private var model
    let context: MessageRowContext
    let server: AppModel.ServerState
    let actions: ChatActions
    @State private var revealed: Set<Int> = []

    private var message: MessageView { context.message }
    private var own: Bool { context.own }
    private var deleted: Bool { message.deletedAt != nil }
    private var style: TextStyle {
        let accent = model.settings.accent
        return TextStyle(
            size: UIFontMetrics(forTextStyle: .body).scaledValue(for: model.settings.messageSize.points),
            own: own,
            color: UIColor(own ? accent.bubbleOwnText : Theme.text1),
            faint: own ? UIColor.white.withAlphaComponent(0.55) : UIColor(Theme.text3),
            jumbo: jumbo
        )
    }

    /// Only emoji or emotes, without attachments: shown larger, without a bubble.
    private var jumbo: Int {
        message.attachments.isEmpty && !deleted ? Markup.jumboSize(message.text, emotes: message.emotes) : 0
    }

    /// The time goes at the end of the text, or below a link's preview.
    private var metaInText: Bool {
        !message.text.isEmpty && message.preview == nil && message.reactions.isEmpty && !deleted && message.status != .undecryptable && message.status != .unverified && message.status != .invalid
    }

    /// Pictures and videos, which fill the bubble, with the time over them, when they're all a message has.
    private var media: [Attachment] {
        message.attachments.filter { ($0.mime.hasPrefix("image/") && $0.width != nil) || ($0.mime.hasPrefix("video/") && $0.voice != true) }
    }

    private var onlyMedia: Bool {
        message.text.isEmpty && !media.isEmpty && media.count == message.attachments.count && message.reactions.isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if own { Spacer(minLength: 48) }
            if !own && context.isGroup {
                Group {
                    if context.lastInGroup {
                        let sender = server.users[message.senderId]
                        AvatarView(
                            name: sender?.displayName ?? "?",
                            seed: message.senderId,
                            source: sender?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                            size: 32
                        )
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 32, height: 32)
            }
            VStack(alignment: own ? .trailing : .leading, spacing: 3) {
                bubble
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
            if !own { Spacer(minLength: 48) }
        }
        .padding(.top, context.grouped ? 2 : 7)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.message(message.id))
    }

    /// What a long press offers, as the desktop's message menu: reactions, then actions.
    @ViewBuilder
    private var menu: some View {
        let canAct = message.seq != nil && !deleted && message.status == .sent
        // There's no hovering here, so this is where the mark on the time gets explained.
        if message.timeDiffers == true {
            Button("The sender's device gives a very different time for this message.", systemImage: "exclamationmark.shield") {}
                .disabled(true)
            Divider()
        }
        if canAct {
            ControlGroup {
                ForEach(quickReactions, id: \.self) { emoji in
                    Button(emoji) { actions.react(message.id, emoji, nil) }
                        .accessibilityIdentifier(A11y.Chat.quickReaction(emoji))
                }
                Button("More reactions", systemImage: "plus") { actions.pickReaction(message.id) }
            }
            .controlGroupStyle(.palette)
            Divider()
            Button("Reply", systemImage: "arrowshape.turn.up.left") { actions.reply(message) }
            Button("Forward", systemImage: "arrowshape.turn.up.right") { actions.forward(message) }
            Button("Select", systemImage: "checkmark.circle") { actions.select(message) }
        }
        if !message.text.isEmpty && !deleted {
            Button("Copy text", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
        }
        if canAct && own && !message.text.isEmpty && message.forwarded == nil {
            Button("Edit", systemImage: "pencil") { actions.edit(message) }
        }
        if canAct {
            Button(message.pinnedAt != nil ? "Unpin" : "Pin", systemImage: message.pinnedAt != nil ? "pin.slash" : "pin") {
                actions.pin(message, message.pinnedAt == nil)
            }
        }
        if message.status == .failed {
            Button("Try again", systemImage: "arrow.clockwise") { actions.retry(message.id) }
            Button("Discard", systemImage: "trash", role: .destructive) { actions.discard(message.id) }
        }
        if canAct && (own || (context.isGroup && actions.isGroupAdmin)) {
            Divider()
            Button("Delete for everyone", systemImage: "trash", role: .destructive) { actions.delete(message) }
        }
    }

    private var bubble: some View {
        let accent = model.settings.accent
        let small: CGFloat = 4, grouped: CGFloat = 5, radius: CGFloat = 17
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: !own && context.grouped ? grouped : radius,
            bottomLeadingRadius: !own && context.lastInGroup ? small : radius,
            bottomTrailingRadius: own && context.lastInGroup ? small : radius,
            topTrailingRadius: own && context.grouped ? grouped : radius,
            style: .continuous
        )
        return VStack(alignment: .leading, spacing: 4) {
            if !own, context.isGroup, !context.grouped, jumbo == 0 {
                Text(server.users[message.senderId]?.displayName ?? "Unknown")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.nameColor(message.senderId))
            }
            content
        }
        .padding(.horizontal, jumbo > 0 || onlyMedia ? 0 : 12)
        .padding(.top, jumbo > 0 || onlyMedia ? 0 : 6)
        .padding(.bottom, jumbo > 0 || onlyMedia ? 0 : 7)
        .frame(minWidth: jumbo > 0 ? 0 : 64, alignment: .leading)
        .background(jumbo > 0 ? .clear : own ? accent.bubbleOwn : Theme.bubbleOther, in: shape)
        .clipShape(onlyMedia ? AnyShape(shape) : AnyShape(Rectangle()))
        .overlay {
            if message.status == .failed { shape.stroke(Theme.red) }
        }
        .opacity(message.status == .sending ? 0.7 : 1)
        .contentShape(.contextMenuPreview, shape)
        .contextMenu { menu }
    }

    @ViewBuilder
    private var content: some View {
        if deleted {
            placeholder("Message deleted", icon: nil)
            meta.frame(maxWidth: .infinity, alignment: .trailing)
        } else if message.status == .undecryptable {
            HStack(spacing: 7) {
                ProgressView().controlSize(.mini)
                Text("Waiting for this message's keys")
            }
            .font(.subheadline)
            .foregroundStyle(own ? Color.white.opacity(0.55) : Theme.text2)
            meta.frame(maxWidth: .infinity, alignment: .trailing)
        } else if message.status == .unverified {
            Label("This message couldn't be verified, so it isn't shown.", systemImage: "exclamationmark.shield")
                .font(.subheadline)
                .foregroundStyle(Color(hex: 0xF4BCBE))
            meta.frame(maxWidth: .infinity, alignment: .trailing)
        } else if message.status == .invalid {
            Label("This message couldn't be displayed.", systemImage: "exclamationmark.shield")
                .font(.subheadline)
                .foregroundStyle(Color(hex: 0xF4BCBE))
            meta.frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            if let forwarded = message.forwarded {
                ForwardedLabel(forwarded: forwarded, own: own, server: server, open: actions.mention)
            }
            if let reply = message.reply {
                ReplyQuote(reply: reply, own: own, server: server) { actions.jump(reply.id) }
            }
            if !message.attachments.isEmpty {
                AttachmentsView(message: message, serverId: server.entry.id, flush: onlyMedia, own: own, open: actions.open)
                    .overlay(alignment: .bottomTrailing) {
                        if onlyMedia { meta.padding(.horizontal, 6).padding(.vertical, 1).background(.black.opacity(0.55), in: .capsule).padding(7) }
                    }
            }
            if !message.text.isEmpty, jumbo > 0 {
                // Large emoji have the time below them, at their right edge, as under a sticker.
                VStack(alignment: .trailing, spacing: 1) {
                    MessageBody(message: message, style: style, server: server, reserveMeta: nil, revealed: revealed, actions: actions) {
                        revealed.insert($0)
                    }
                    if metaInText { meta }
                }
                .fixedSize(horizontal: true, vertical: false)
            } else if !message.text.isEmpty {
                MessageBody(message: message, style: style, server: server, reserveMeta: metaInText ? metaWidth : nil, revealed: revealed, actions: actions) {
                    revealed.insert($0)
                }
                .overlay(alignment: .bottomTrailing) {
                    if metaInText { meta.offset(y: 2) }
                }
            }
            if let preview = message.preview {
                LinkCard(preview: preview, own: own, messageId: message.id)
            }
            if !message.reactions.isEmpty {
                ReactionsView(message: message, own: own, server: server, react: { actions.react(message.id, $0, $1) }, card: actions.emoteCard) {
                    meta
                }
            } else if !metaInText && !onlyMedia {
                meta.frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    private func placeholder(_ text: String, icon: String?) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(own ? Color.white.opacity(0.55) : Theme.text2)
    }

    /// The time and its marks, as the desktop shows them.
    private var meta: some View {
        HStack(spacing: 3) {
            if message.timeDiffers == true {
                Image(systemName: "exclamationmark.shield").font(.system(size: 9)).accessibilityLabel("The time of this message may not be right")
            }
            if message.pinnedAt != nil {
                Image(systemName: "pin.fill").font(.system(size: 9)).rotationEffect(.degrees(35))
            }
            if message.editedAt != nil && !deleted { Text("edited") }
            Text(Format.time(message.createdAt))
            if own && !deleted { ticks }
        }
        .font(.system(size: 11))
        .monospacedDigit()
        .foregroundStyle(onlyMedia ? .white : own ? Color.white.opacity(0.55) : Theme.text3)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.meta(message.id))
    }

    /// The desktop's marks: a clock while sending, a thin tick once sent, and a
    /// second beside it, in the accent's color, once read.
    @ViewBuilder
    private var ticks: some View {
        switch message.status {
        case .sending:
            DesktopIcon.clock.view().accessibilityLabel("Sending")
        case .failed:
            Image(systemName: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(Color(hex: 0xF4BCBE)).accessibilityLabel("Not sent")
        default:
            if let seq = message.seq {
                if context.readUpTo >= seq {
                    DesktopIcon.read.view()
                        .foregroundStyle(model.settings.accent.text)
                        .accessibilityLabel("Read")
                } else {
                    DesktopIcon.sent.view().accessibilityLabel("Sent")
                }
            }
        }
    }

    /// Room for the meta at the end of the last line, measured as it will draw.
    private var metaWidth: CGFloat {
        let font = UIFont.systemFont(ofSize: 11)
        var width = (Format.time(message.createdAt) as NSString).size(withAttributes: [.font: font]).width
        if message.editedAt != nil { width += ("edited" as NSString).size(withAttributes: [.font: font]).width + 3 }
        if message.timeDiffers == true { width += 12 }
        if message.pinnedAt != nil { width += 12 }
        if own { width += 21 }
        return ceil(width) + 8
    }
}

/// The text of a message: its blocks of text, quotes and code, or large emoji.
private struct MessageBody: View {
    @Environment(AppModel.self) private var model
    let message: MessageView
    let style: TextStyle
    let server: AppModel.ServerState
    let reserveMeta: CGFloat?
    let revealed: Set<Int>
    let actions: ChatActions
    let reveal: (Int) -> Void

    var body: some View {
        let blocks = Markup.parse(message.text, Markup.Context(emotes: message.emotes, mentionable: server.mentionable))
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                let last = index == blocks.count - 1
                switch block {
                case let .text(nodes):
                    text(nodes, reserve: last ? reserveMeta : nil)
                case let .quote(nodes):
                    HStack(spacing: 8) {
                        Rectangle().fill(style.own ? Color.white.opacity(0.55) : Theme.text3).frame(width: 2)
                        text(nodes, reserve: nil, color: style.own ? UIColor.white.withAlphaComponent(0.55) : UIColor(Theme.text2))
                    }
                    .fixedSize(horizontal: false, vertical: true)
                case let .code(code, language):
                    CodeBlockView(code: code, language: language)
                }
            }
            if let reserveMeta, !(blocks.last.map { if case .text = $0 { true } else { false } } ?? false) {
                Color.clear.frame(width: reserveMeta, height: 14)
            }
        }
        .accessibilityIdentifier(A11y.Chat.text(message.id))
    }

    private func text(_ nodes: [Markup.Inline], reserve: CGFloat?, color: UIColor? = nil) -> some View {
        var textStyle = style
        if let color { textStyle.color = color }
        let options = MessageTextBuilder.Options(style: textStyle, selfId: server.me?.userId ?? "", serverUrl: server.entry.url, revealed: revealed) { id in
            guard let emote = server.emotes.emotes.first(where: { $0.id == id }), emote.height > 0 else { return 1 }
            return CGFloat(emote.width) / CGFloat(emote.height)
        }
        let built = NSMutableAttributedString(attributedString: MessageTextBuilder.build(nodes, options))
        if let reserve { MessageTextBuilder.reserve(reserve, in: built, style: textStyle) }
        return MessageTextView(
            text: built,
            serverUrl: server.entry.url,
            emoteSize: style.jumbo > 0 ? .large : .inline,
            onMention: actions.mention,
            onSpoiler: reveal,
            onEmote: { actions.emoteCard($0, $1, nil) }
        )
    }
}

/// The message this one answers, with its author; a tap shows it.
private struct ReplyQuote: View {
    let reply: ReplyPreview
    let own: Bool
    let server: AppModel.ServerState
    let jump: () -> Void

    var body: some View {
        let name = reply.senderId == server.me?.userId ? "You" : server.users[reply.senderId]?.displayName ?? "Unknown"
        Button(action: jump) {
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(own ? Color.white : Theme.nameColor(reply.senderId.isEmpty ? "x" : reply.senderId))
                Text(reply.deleted ? "Message deleted" : plainText(reply.text).isEmpty ? (reply.hasAttachment ? "Attachment" : "Tap to view") : plainText(reply.text))
                    .font(.footnote)
                    .foregroundStyle(own ? Color.white.opacity(0.55) : Theme.text2)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.white.opacity(own ? 0.07 : 0.05), in: .rect(cornerRadius: 4))
            .overlay(alignment: .leading) {
                Rectangle().fill(own ? Color.white.opacity(0.55) : Theme.text3).frame(width: 2)
            }
            .clipShape(.rect(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
        .accessibilityIdentifier(A11y.Chat.reply)
    }
}
