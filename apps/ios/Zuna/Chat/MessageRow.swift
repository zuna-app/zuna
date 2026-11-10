import SwiftUI
import ZunaModels

/// What a row needs besides its message: where it sits among its neighbors,
/// and what it should know about the server. Built by the list for each row.
struct MessageRowContext: Equatable {
    let message: MessageView
    let showDay: Bool
    /// Follows a message from the same sender within five minutes.
    let grouped: Bool
    let lastInGroup: Bool
    let own: Bool
    /// A group or a channel, where messages say who sent them.
    let isGroup: Bool
    /// How far anyone else has read, for the read ticks, as `ReadTicks` takes it. The list
    /// gives each row only what tells its ticks apart, so a read further on redraws only the
    /// messages whose ticks change.
    let readUpTo: Int
    /// The first unread message when the chat opened, with a line above it.
    let unreadLine: Bool
    let highlighted: Bool
    /// Messages are being picked to act on together, and whether this one is.
    let selecting: Bool
    let selected: Bool
    /// Laid out as in a Discord channel, rather than in bubbles.
    var channel = false
    /// The oldest message there is, under the channel's welcome.
    var startOfChat = false
    /// Being edited where it is, in a channel.
    var editing = false
    /// Only emoji or emotes, without attachments, shown larger: `Markup.jumboSize`, worked out once
    /// per update rather than each time the row reads it, which is many times a draw.
    var jumbo = 0
}

/// The things a message can ask its chat to do.
@MainActor
struct ChatActions {
    var jump: (_ messageId: String) -> Void = { _ in }
    /// A file from a message, the picture viewer naming who sent it and when.
    var open: (_ attachment: Attachment, _ message: MessageView) -> Void = { _, _ in }
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
    /// A press of a button under a bot's message, by its row and its place in it.
    var press: (_ message: MessageView, _ row: Int, _ column: Int) -> Void = { _, _, _ in }
    /// The full picker, for a reaction that isn't among the quick ones.
    var pickReaction: (_ messageId: String) -> Void = { _ in }
    /// Who in this group has read a message, as far as their read receipts say.
    var readers: (_ message: MessageView) -> [UserView] = { _ in [] }
    /// The names of those who reacted, as a list to read: "You, alice".
    var reactedBy: (_ userIds: [String]) -> String = { _ in "" }
    var openChat: (_ conversationKey: String) -> Void = { _ in }
    /// You can delete others' messages here: you're an admin of this group, or of the server in a channel.
    var isGroupAdmin = false
    /// Edits the channel, for a server admin, from its welcome.
    var editChannel: (() -> Void)?
}

/// The reactions offered first, as on the desktop.
let quickReactions = ["👍", "❤️", "😂", "🔥", "😮", "😢"]

/// How far a message is pulled to the left to answer it. The list sets it as the
/// finger moves, and the row follows.
@MainActor
@Observable
final class RowSwipe {
    /// How far to pull before letting go answers the message.
    static let threshold: CGFloat = 64
    var offset: CGFloat = 0
    /// Pulled past the threshold, so letting go answers.
    var armed = false
}

extension View {
    /// Follows a pull to the left to answer the message, as in Telegram: an arrow comes in
    /// from the screen's edge, `inset` past this view's trailing edge, and pops once letting
    /// go would answer.
    func swipeToReply(inset: CGFloat) -> some View {
        modifier(SwipeToReply(inset: inset))
    }
}

/// Reads the pull itself, so that only this follows the finger, not the message's own view.
private struct SwipeToReply: ViewModifier {
    @Environment(RowSwipe.self) private var swipe: RowSwipe?
    let inset: CGFloat

    func body(content: Content) -> some View {
        let offset = swipe?.offset ?? 0
        let size: CGFloat = 32
        content
            .offset(x: offset)
            .overlay(alignment: .trailing) {
                if let swipe, offset < 0 {
                    let progress = min(1, -offset / RowSwipe.threshold)
                    Image(systemName: "arrowshape.turn.up.left.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.text1)
                        .frame(width: size, height: size)
                        .background(Theme.bg4, in: .circle)
                        .scaleEffect(swipe.armed ? 1 : 0.5 + 0.35 * progress)
                        .animation(.spring(response: 0.3, dampingFraction: 0.5), value: swipe.armed)
                        .opacity(progress)
                        // Just past the screen's edge at rest, coming in with the message.
                        .offset(x: inset + size + offset)
                        .transition(.scale(scale: 0.2).combined(with: .opacity))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }
}

extension VerticalAlignment {
    /// The bottom of a message's text, which the time beside its last line sits on.
    private enum LastTextLine: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat { context[.bottom] }
    }

    static let lastTextLine = VerticalAlignment(LastTextLine.self)
}

/// One message in the list, with the day's separator above it when a new day starts.
struct MessageRow: View {
    @Environment(AppModel.self) private var model
    let context: MessageRowContext
    let server: AppModel.ServerState
    let actions: ChatActions

    var body: some View {
        Group {
            if context.channel {
                ChannelMessageRow(context: context, server: server, actions: actions)
            } else {
                bubbleRow
            }
        }
        // A tap on the chat beside a message puts the keyboard away, as in Telegram. Behind
        // the row, so what's on it, the message and what opens from it, takes its own taps.
        .background {
            Color.clear
                .contentShape(.rect)
                .onTapGesture { Keyboard.dismiss() }
        }
    }

    private var bubbleRow: some View {
        VStack(spacing: 0) {
            if context.unreadLine {
                // Across the whole list, as Telegram's.
                Text("Unread messages")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.text2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                    .background(Theme.bg2)
                    .padding(.horizontal, -8)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier(A11y.Chat.unreadLine)
            }
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
                .swipeToReply(inset: 8)
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
        case .memberAdded:
            // The line that says a bot was added names it as one.
            let added = (system.targetIds ?? []).map { id in server.users[id]?.bot != nil ? "the bot " + name(id) : name(id) }.joined(separator: ", ")
            return "\(name(system.actorId)) added \(added)"
        case .memberRemoved: return "\(name(system.actorId)) removed \(targets)"
        case .memberLeft: return "\(name(system.actorId)) left the group"
        case .memberRejoined: return "\(name(system.actorId)) rejoined this chat"
        case .unexpectedJoin: return "\(name(system.actorId)) joined without being added by a member. Check that this is expected."
        case .identityChanged: return "\(name(system.actorId))'s security key changed. Verify it before trusting new messages."
        case .identityRotated: return "\(name(system.actorId))'s security key changed since you verified it. You can compare keys again if you'd like."
        case .deviceAdded: return "\(name(system.actorId)) added a device"
        case .timerChanged: return Format.timerChange(name(system.actorId), seconds: system.seconds ?? 0)
        }
    }
}

/// A bubble's outline, as in Telegram and on the desktop: one person's messages share a
/// tighter inner edge, and the last of them ends in a tail, which reaches out past the frame.
private struct BubbleShape: Shape {
    let own: Bool
    /// Follows a message from the same sender, so its inner top corner is tight too.
    let grouped: Bool
    let tail: Bool

    func path(in rect: CGRect) -> Path {
        let inner: CGFloat = 5, radius: CGFloat = 17
        let bubble = UnevenRoundedRectangle(
            topLeadingRadius: !own && grouped ? inner : radius,
            bottomLeadingRadius: own ? radius : inner,
            bottomTrailingRadius: own ? inner : radius,
            topTrailingRadius: own && grouped ? inner : radius,
            style: .continuous
        ).path(in: rect)
        guard tail else { return bubble }
        // The web's, `.msg.is-last .bubble::before`: 10 points up the bubble's inner edge, out to a
        // tip 6 points past its bottom corner, and back in over the corner, so no gap shows between them.
        let edge = own ? rect.maxX : rect.minX, out: CGFloat = own ? 1 : -1
        var tail = Path()
        tail.move(to: CGPoint(x: edge, y: rect.maxY - 10))
        tail.addCurve(
            to: CGPoint(x: edge + 6 * out, y: rect.maxY),
            control1: CGPoint(x: edge + out, y: rect.maxY - 6),
            control2: CGPoint(x: edge + 3 * out, y: rect.maxY - 2)
        )
        tail.addLine(to: CGPoint(x: edge - 8 * out, y: rect.maxY))
        tail.addLine(to: CGPoint(x: edge - 8 * out, y: rect.maxY - 10))
        tail.closeSubpath()
        return bubble.union(tail)
    }
}

/// A message bubble, laid out like Telegram's: yours on the right in the
/// accent's color, others on the left, the time tucked into the last line.
private struct MessageItem: View {
    @Environment(AppModel.self) private var model
    /// Read so the row draws again when the text size changes, which the time's size follows.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let context: MessageRowContext
    let server: AppModel.ServerState
    let actions: ChatActions
    @State private var revealed: Set<Int> = []
    /// A message from someone blocked shows as a line, as on the desktop, and itself only when asked.
    @State private var showBlocked = false

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
    private var jumbo: Int { context.jumbo }

    /// The time goes at the end of the text, or below a link's preview.
    private var metaInText: Bool {
        !message.text.isEmpty && message.preview == nil && message.reactions.isEmpty && !deleted && message.status != .undecryptable && message.status != .unverified && message.status != .invalid
    }

    /// Pictures and videos, which fill the bubble, with the time over them, when they're all a message has.
    private var media: [Attachment] {
        message.attachments.filter { ($0.mime.hasPrefix("image/") && $0.width != nil) || ($0.mime.hasPrefix("video/") && $0.voice != true && $0.round != true) }
    }

    /// A video message alone is a circle, without a bubble, as large emoji are.
    private var onlyRound: Bool {
        message.text.isEmpty && message.attachments.count == 1 && message.attachments[0].round == true && message.reply == nil && message.forwarded == nil
    }

    private var onlyMedia: Bool {
        message.text.isEmpty && !media.isEmpty && media.count == message.attachments.count && message.reactions.isEmpty
    }

    var body: some View {
        if !own && server.isBlocked(message.senderId) && !showBlocked {
            HStack(spacing: 6) {
                if context.isGroup { Color.clear.frame(width: 32, height: 1) }
                Label("A message from someone you blocked", systemImage: "nosign")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                Button("Show") { showBlocked = true }
                    .font(.footnote.weight(.semibold))
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(A11y.Chat.blockedMessage(message.id))
        } else {
            bubbleRow
        }
    }

    private var bubbleRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if own { Spacer(minLength: 48) }
            if !own && context.isGroup {
                Group {
                    if context.lastInGroup, !message.senderId.isEmpty {
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
                if !deleted, !(message.buttons ?? []).isEmpty {
                    MessageButtonsView(message: message) { row, column in actions.press(message, row, column) }
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
            if !own { Spacer(minLength: 48) }
        }
        .padding(.top, context.grouped ? 2 : 7)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.message(message.id))
    }

    private var bubble: some View {
        let accent = model.settings.accent
        let bare = jumbo > 0 || onlyRound
        // Not on pictures alone, which fill the bubble to its corner, nor under a failed one's outline.
        let shape = BubbleShape(own: own, grouped: context.grouped, tail: context.lastInGroup && !bare && !onlyMedia && message.status != .failed)
        return VStack(alignment: .leading, spacing: 4) {
            // Whoever wrote one that hasn't opened isn't known yet, so it's shown under no name.
            if !own, context.isGroup, !context.grouped, jumbo == 0, !message.senderId.isEmpty {
                HStack(spacing: 5) {
                    Text(server.users[message.senderId]?.displayName ?? "Unknown")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.nameColor(message.senderId))
                        .lineLimit(1)
                    if server.users[message.senderId]?.bot != nil { BotBadge() }
                }
                // Pictures alone fill the bubble to its edges, which the name keeps away from.
                .padding(.horizontal, onlyMedia || onlyRound ? 12 : 0)
                .padding(.top, onlyMedia ? 6 : 0)
            }
            content
        }
        // The time at the end of the text goes to the bubble's edge, which can be further out than
        // the text's, as when a reply's quote or a picture makes the bubble wider, as in Telegram.
        .overlay(alignment: Alignment(horizontal: .trailing, vertical: .lastTextLine)) {
            if metaInText && jumbo == 0 { meta.offset(y: 2) }
        }
        .padding(.horizontal, jumbo > 0 || onlyMedia || onlyRound ? 0 : 12)
        .padding(.top, jumbo > 0 || onlyMedia || onlyRound ? 0 : 6)
        .padding(.bottom, jumbo > 0 || onlyMedia || onlyRound ? 0 : 7)
        .frame(minWidth: bare ? 0 : 64, alignment: .leading)
        // Before the bubble is drawn behind it, whose tail reaches out past this.
        .clipShape(onlyMedia ? AnyShape(shape) : AnyShape(Rectangle()))
        .background(bare ? .clear : own ? accent.bubbleOwn : Theme.bubbleOther, in: shape)
        .overlay {
            if message.status == .failed { shape.stroke(Theme.red) }
        }
        .modifier(SendingDim(message: message, opacity: 0.7))
        .contentShape(.contextMenuPreview, shape)
        .contextMenu { MessageMenu(context: context, actions: actions) }
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
            if onlyRound {
                // A video message has the time below it, at its right edge, as large emoji do.
                VStack(alignment: .trailing, spacing: 2) {
                    AttachmentsView(message: message, serverId: server.entry.id, flush: false, own: own, open: { actions.open($0, message) })
                    if message.reactions.isEmpty { meta }
                }
                .fixedSize(horizontal: true, vertical: false)
            } else if !message.attachments.isEmpty {
                AttachmentsView(message: message, serverId: server.entry.id, flush: onlyMedia, own: own, open: { actions.open($0, message) })
                    .overlay(alignment: .bottomTrailing) {
                        if onlyMedia { meta.padding(.horizontal, 6).padding(.vertical, 1).background(.black.opacity(0.55), in: .capsule).padding(7) }
                    }
            }
            if !message.text.isEmpty, jumbo > 0 {
                // Large emoji have the time below them, at their right edge, as under a sticker.
                VStack(alignment: .trailing, spacing: 1) {
                    MessageBodyView(message: message, style: style, server: server, reserveMeta: nil, revealed: revealed, actions: actions) {
                        revealed.insert($0)
                    }
                    if metaInText { meta }
                }
                .fixedSize(horizontal: true, vertical: false)
            } else if !message.text.isEmpty {
                MessageBodyView(message: message, style: style, server: server, reserveMeta: metaInText ? metaWidth : nil, revealed: revealed, actions: actions) {
                    revealed.insert($0)
                }
                .alignmentGuide(.lastTextLine) { $0[.bottom] }
            }
            if let preview = message.preview {
                LinkCard(preview: preview, own: own, messageId: message.id)
            }
            if let location = message.location {
                LocationCard(location: location, own: own, messageId: message.id)
            }
            if !message.reactions.isEmpty {
                ReactionsView(message: message, own: own, server: server, react: { actions.react(message.id, $0, $1) }) {
                    meta
                }
            } else if !metaInText && !onlyMedia && !onlyRound {
                meta.frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    private func placeholder(_ text: String, icon: String?) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(own ? Color.white.opacity(0.55) : Theme.text2)
    }

    /// The time's size: 11 points at the default text size, growing and shrinking with it.
    private var metaSize: CGFloat {
        UIFontMetrics(forTextStyle: .caption2).scaledValue(for: 11, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize)))
    }

    /// The time and its marks, as the desktop shows them.
    private var meta: some View {
        HStack(spacing: 3) {
            if message.timeDiffers == true {
                Image(systemName: "exclamationmark.shield").font(.system(size: metaSize * 9 / 11)).accessibilityLabel("The time of this message may not be right")
            }
            if message.pinnedAt != nil {
                Image(systemName: "pin.fill").font(.system(size: metaSize * 9 / 11)).rotationEffect(.degrees(35))
            }
            if message.expiresAt != nil {
                Image(systemName: "timer").font(.system(size: metaSize * 9 / 11)).accessibilityLabel("Disappears")
            }
            if message.editedAt != nil && !deleted { Text("edited") }
            Text(Format.time(message.createdAt))
            if own && !deleted { ticks }
        }
        .font(.system(size: metaSize))
        .monospacedDigit()
        .foregroundStyle(onlyMedia ? .white : own ? Color.white.opacity(0.55) : Theme.text3)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.meta(message.id))
    }

    private var ticks: some View {
        ReadTicks(message: message, readUpTo: context.readUpTo, failed: Color(hex: 0xF4BCBE))
    }

    /// Room for the meta at the end of the last line, measured as it will draw.
    private var metaWidth: CGFloat {
        let font = UIFont.monospacedDigitSystemFont(ofSize: metaSize, weight: .regular)
        let grow = metaSize / 11
        var width = (Format.time(message.createdAt) as NSString).size(withAttributes: [.font: font]).width
        if message.editedAt != nil { width += ("edited" as NSString).size(withAttributes: [.font: font]).width + 3 }
        if message.timeDiffers == true { width += 12 * grow }
        if message.pinnedAt != nil { width += 12 * grow }
        if message.expiresAt != nil { width += 12 * grow }
        if own { width += 21 * grow }
        return ceil(width) + 8
    }
}

extension ConversationView {
    /// How far anyone else has read here, for the ticks, or -1 where nobody's reading is known, as in a channel.
    func readUpTo(selfId: String) -> Int {
        if kind == .channel { return -1 }
        return readBy.reduce(0) { highest, entry in entry.key == selfId ? highest : max(highest, entry.value) }
    }
}

/// The desktop's marks on your own message, in its bubble and in the chat list:
/// a thin tick once sent, and at once while sending, a clock in its place if
/// sending takes a while, and a second tick beside the first, in the accent's
/// color, once read.
struct ReadTicks: View {
    @Environment(AppModel.self) private var model
    let message: MessageView
    /// Below zero where nobody's reading is known, as in a channel.
    let readUpTo: Int
    /// The color of the mark on a message that couldn't be sent.
    let failed: Color

    var body: some View {
        switch message.status {
        case .sending:
            SendingMark(createdAt: message.createdAt, tick: readUpTo >= 0).id(message.id)
        case .failed:
            Image(systemName: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(failed).accessibilityLabel("Not sent")
        default:
            if let seq = message.seq, readUpTo >= 0 {
                if readUpTo >= seq {
                    DesktopIcon.read.view()
                        .foregroundStyle(model.settings.accent.text)
                        .accessibilityLabel("Read")
                } else {
                    DesktopIcon.sent.view().accessibilityLabel("Sent")
                }
            }
        }
    }
}

/// A message still sending, dimmed only once it's taken half a second, so a quick send
/// doesn't blink, as the desktop's `.bubble.is-sending`: over 200 ms with CSS's `ease`,
/// and back over 150 once it's sent. Counted from its time, as `SendingMark`'s clock is,
/// so the two come together.
struct SendingDim: ViewModifier {
    @Environment(AppModel.self) private var model
    let message: MessageView
    let opacity: Double
    /// The message dimmed, by id, as a cell is used again for another.
    @State private var dimmed: String?

    func body(content: Content) -> some View {
        let sending = message.status == .sending
        content
            .opacity((model.reduceMotion ? sending : dimmed == message.id) ? opacity : 1)
            .task(id: sending ? message.id : "") {
                guard sending else {
                    if dimmed != nil { withAnimation(.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.15)) { dimmed = nil } }
                    return
                }
                let waited = Date.now.timeIntervalSince1970 * 1000 - Double(message.createdAt)
                if waited < 500 { try? await Task.sleep(for: .milliseconds(500 - waited)) }
                guard !Task.isCancelled else { return }
                withAnimation(.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.2)) { dimmed = message.id }
            }
    }
}

/// A message still sending, shown as sent at once, as nearly every message is a
/// moment later. The clock takes the tick's place only once it's taken as long
/// as the desktop's bubble waits to dim. Its time is this device's own until the
/// server takes it, so one found sending for longer than that shows the clock.
private struct SendingMark: View {
    let createdAt: Int
    /// Whether it has a tick at all, which it hasn't where nobody's reading is known.
    let tick: Bool
    @State private var slow = false

    var body: some View {
        Group {
            if slow {
                DesktopIcon.clock.view().transition(.opacity)
            } else if tick {
                DesktopIcon.sent.view()
            }
        }
        .accessibilityLabel("Sending")
        .task {
            let waited = Date.now.timeIntervalSince1970 * 1000 - Double(createdAt)
            if waited < 500 { try? await Task.sleep(for: .milliseconds(500 - waited)) }
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.12)) { slow = true }
        }
    }
}

/// What a long press on a message offers, as the desktop's message menu: reactions, then actions.
struct MessageMenu: View {
    let context: MessageRowContext
    let actions: ChatActions

    private var message: MessageView { context.message }
    private var own: Bool { context.own }
    private var deleted: Bool { message.deletedAt != nil }

    var body: some View {
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
        // Who reacted with what, which the desktop shows on hover; an emote's card from it, as a
        // long press on the reaction itself only opens this menu.
        if !message.reactions.isEmpty && !deleted {
            Menu("Reactions", systemImage: "face.smiling") {
                ForEach(message.reactions, id: \.key) { reaction in
                    let names = actions.reactedBy(reaction.userIds)
                    Button {
                        if let emote = reaction.emote { actions.emoteCard(reaction.key, emote, "Reacted by \(names)") }
                    } label: {
                        Text(reaction.emote == nil ? reaction.key : ":\(reaction.key):")
                        Text(names)
                    }
                    .accessibilityIdentifier(A11y.Chat.reactionInMenu(reaction.key))
                }
            }
            .accessibilityIdentifier(A11y.Chat.reactionsMenu)
        }
        // As on the desktop, for your own messages in a group.
        if canAct && own && context.isGroup {
            let readers = actions.readers(message)
            if !readers.isEmpty {
                Menu("Read by \(readers.count)", systemImage: "checkmark.message") {
                    ForEach(readers) { user in
                        Button(user.displayName) { actions.openChat("user:\(user.id)") }
                    }
                }
                .accessibilityIdentifier(A11y.Chat.readBy)
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
}

/// The text of a message: its blocks of text, quotes and code, or large emoji.
struct MessageBodyView: View {
    @Environment(AppModel.self) private var model
    let message: MessageView
    let style: TextStyle
    let server: AppModel.ServerState
    let reserveMeta: CGFloat?
    let revealed: Set<Int>
    let actions: ChatActions
    /// After the last line, as "(edited)" is in a channel.
    var suffix: NSAttributedString?
    let reveal: (Int) -> Void

    var body: some View {
        let blocks = Markup.parse(message.text, Markup.Context(emotes: message.emotes, mentionable: server.mentionable))
        let endsInText = blocks.last.map { if case .text = $0 { true } else { false } } ?? false
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                let last = index == blocks.count - 1
                switch block {
                case let .text(nodes):
                    text(nodes, reserve: last ? reserveMeta : nil, suffix: last ? suffix : nil)
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
            if let reserveMeta, !endsInText {
                Color.clear.frame(width: reserveMeta, height: 14)
            }
            if let suffix, !endsInText {
                Text(AttributedString(suffix))
            }
        }
        .accessibilityIdentifier(A11y.Chat.text(message.id))
    }

    private func text(_ nodes: [Markup.Inline], reserve: CGFloat?, suffix: NSAttributedString? = nil, color: UIColor? = nil) -> some View {
        var textStyle = style
        if let color { textStyle.color = color }
        let options = MessageTextBuilder.Options(style: textStyle, selfId: server.me?.userId ?? "", serverUrl: server.entry.url, revealed: revealed) { id in
            guard let emote = server.emotes.emotes.first(where: { $0.id == id }), emote.height > 0 else { return 1 }
            return CGFloat(emote.width) / CGFloat(emote.height)
        }
        let built = NSMutableAttributedString(attributedString: MessageTextBuilder.build(nodes, options))
        if let reserve { MessageTextBuilder.reserve(reserve, in: built, style: textStyle) }
        if let suffix { built.append(suffix) }
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
                Text(reply.deleted ? "Message deleted" : server.isBlocked(reply.senderId) ? "A message from someone you blocked" : plainText(reply.text).isEmpty ? (reply.hasAttachment ? "Attachment" : "Tap to view") : plainText(reply.text))
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
