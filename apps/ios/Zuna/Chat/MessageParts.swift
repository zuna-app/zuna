import SwiftUI
import UIKit
import ZunaHost
import ZunaModels

// MARK: Attachments

/// Pictures two to a row, videos with their picture, then audio and
/// other files as cards. Pictures open in the photo viewer, everything else in
/// QuickLook, decrypted into the protected cache.
struct AttachmentsView: View {
    let message: MessageView
    let serverId: String
    /// No text around the pictures and videos: they fill the bubble.
    let flush: Bool
    var own = false
    let open: (Attachment) -> Void

    var body: some View {
        let images = message.attachments.filter { $0.mime.hasPrefix("image/") && $0.width != nil }
        let others = message.attachments.filter { item in !images.contains(item) }
        VStack(alignment: .leading, spacing: 4) {
            if !images.isEmpty {
                ImageGrid(images: images, serverId: serverId, uploadProgress: message.uploadProgress, open: open)
                    .clipShape(.rect(cornerRadius: flush ? 0 : 10))
            }
            ForEach(Array(others.enumerated()), id: \.offset) { _, attachment in
                let progress = progress(of: attachment)
                if attachment.voice == true {
                    VoiceCard(attachment: attachment, serverId: serverId, own: own, messageId: message.id, uploadProgress: progress)
                } else if attachment.round == true, attachment.mime.hasPrefix("video/") {
                    RoundVideoCard(attachment: attachment, serverId: serverId, messageId: message.id, uploadProgress: progress)
                } else if attachment.mime.hasPrefix("video/") {
                    VideoTile(attachment: attachment, serverId: serverId, uploadProgress: progress, flush: flush) { open(attachment) }
                } else {
                    FileCard(attachment: attachment, uploadProgress: progress) { open(attachment) }
                }
            }
        }
    }

    /// How far one file is, from how far the whole message is: its files go up one after another.
    private func progress(of attachment: Attachment) -> Double? {
        guard let overall = message.uploadProgress else { return nil }
        let total = message.attachments.reduce(0) { $0 + $1.size }
        let before = message.attachments.prefix { $0 != attachment }.reduce(0) { $0 + $1.size }
        guard attachment.size > 0 else { return overall }
        return min(1, max(0, (overall * Double(total) - Double(before)) / Double(attachment.size)))
    }
}

extension Attachment {
    /// Small enough to download and decrypt with no tap, as on the desktop. The file's
    /// chunks, unlike its stated size, can't be lied about: decrypting checks them.
    var loadsByItself: Bool { size <= 20 << 20 && chunks <= 21 }
}

/// A video with its picture straight away, as on the desktop: the frame the
/// sender's device took, or, for one small enough, a frame taken here once it's
/// decrypted. A tap plays it.
private struct VideoTile: View {
    @Environment(ImageStore.self) private var images
    let attachment: Attachment
    let serverId: String
    let uploadProgress: Double?
    /// Fills the bubble, which rounds it.
    let flush: Bool
    let open: () -> Void
    @State private var frame: UIImage?

    var body: some View {
        let uploading = attachment.fileId.isEmpty
        let width = CGFloat(max(1, attachment.width ?? 16)), height = CGFloat(max(1, attachment.height ?? 9))
        let scale = min(1, 260 / width, 300 / height)
        let shownWidth = max(160, width * scale)
        let shownHeight = min(ImageGrid.tallest, shownWidth * height / width)
        Button(action: open) {
            ZStack {
                Color.black
                if let poster = frame ?? images.cachedVideoFrame(attachment) ?? attachment.thumb.flatMap(ImageStore.thumbnail) {
                    Image(uiImage: poster).resizable().scaledToFill()
                }
                if uploading {
                    UploadRing(progress: uploadProgress ?? 0)
                } else {
                    Image(systemName: "play.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.5), in: .circle)
                }
            }
            .shrinking(toFit: shownWidth, shownHeight)
            .clipped()
            .overlay(alignment: .topLeading) {
                Text(badge(uploading: uploading))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.black.opacity(0.55), in: .capsule)
                    .padding(7)
            }
            .clipShape(.rect(cornerRadius: flush ? 0 : 10))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(uploading)
        .accessibilityLabel("Play \(attachment.name)")
        .accessibilityIdentifier(A11y.Chat.attachment(attachment.name))
        .task(id: attachment.fileId) {
            // Only one small enough to download with no tap, as for pictures.
            guard !uploading, frame == nil, attachment.loadsByItself else { return }
            frame = await images.videoFrame(attachment, serverId: serverId, size: 260)
        }
    }

    private func badge(uploading: Bool) -> String {
        if uploading {
            let done = Int(Double(attachment.size) * (uploadProgress ?? 0))
            return "\(Format.bytes(done)) of \(Format.bytes(attachment.size))"
        }
        return [attachment.duration.map(Format.duration), Format.bytes(attachment.size)].compactMap { $0 }.joined(separator: " · ")
    }
}

private struct ImageGrid: View {
    /// The most a picture or a video takes up and down in a chat.
    static let tallest: CGFloat = 340

    let images: [Attachment]
    let serverId: String
    let uploadProgress: Double?
    let open: (Attachment) -> Void

    var body: some View {
        if images.count == 1, let image = images.first {
            // Sized up front, so the list doesn't jump when the picture arrives. One much taller than
            // wide, as a long screenshot, is cut to a height a screen holds, as Telegram does.
            let width = CGFloat(max(1, image.width ?? 320)), height = CGFloat(max(1, image.height ?? 240))
            let scale = min(1, 260 / width, 300 / height)
            let shownWidth = max(140, width * scale)
            ImageTile(attachment: image, serverId: serverId, uploadProgress: uploadProgress, open: open)
                .shrinking(toFit: shownWidth, min(Self.tallest, max(80, height * shownWidth / width)))
        } else {
            // Two to a row, as on the desktop, with the first across both when one is left over.
            let odd = images.count % 2
            let rows = (odd == 1 ? [[images[0]]] : []) + stride(from: odd, to: images.count, by: 2).map { Array(images[$0..<$0 + 2]) }
            VStack(spacing: 2) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 2) {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, image in
                            ImageTile(attachment: image, serverId: serverId, uploadProgress: uploadProgress, open: open)
                                .aspectRatio(row.count == 1 ? 258 / 160 : 1, contentMode: .fit)
                        }
                    }
                }
            }
            .frame(idealWidth: 258, maxWidth: 258)
        }
    }
}

extension View {
    /// This size where there's room, and smaller as a whole where a bubble has less, as beside
    /// the sender's picture in a group on the smallest phones.
    func shrinking(toFit width: CGFloat, _ height: CGFloat) -> some View {
        aspectRatio(CGSize(width: width, height: height), contentMode: .fit)
            .frame(idealWidth: width, maxWidth: width)
    }
}

private struct ImageTile: View {
    @Environment(ImageStore.self) private var images
    let attachment: Attachment
    let serverId: String
    let uploadProgress: Double?
    let open: (Attachment) -> Void
    @State private var image: UIImage?
    @State private var failed = false
    /// A very large picture waits for a tap, as a video does.
    @State private var tapped = false
    /// Tries after one that failed, each from a tap on it.
    @State private var attempt = 0

    var body: some View {
        let uploading = attachment.fileId.isEmpty
        let wanted = attachment.loadsByItself || tapped
        Button {
            if image != nil {
                open(attachment)
            } else if failed {
                failed = false
                attempt += 1
            } else {
                tapped = true
            }
        } label: {
            // Over the tile's color rather than in a stack with it, so a picture filling it can't make it wider.
            Theme.bg3.overlay {
                if let thumb = attachment.thumb.flatMap(ImageStore.thumbnail), image == nil {
                    Image(uiImage: thumb).resizable().scaledToFill().blur(radius: 8)
                }
                if let image = image ?? images.cachedAttachment(attachment) {
                    Image(uiImage: image).resizable().scaledToFill()
                } else if !wanted && !uploading {
                    Label(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file), systemImage: "arrow.down.circle")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.55), in: .capsule)
                } else if uploading {
                    UploadRing(progress: uploadProgress ?? 0)
                } else if failed {
                    // A tap tries again.
                    Label("Try again", systemImage: "arrow.clockwise")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.55), in: .capsule)
                } else {
                    ProgressView().tint(.white)
                }
            }
            .clipped()
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(image == nil && !wanted && !uploading ? "Download \(attachment.name)" : "Open \(attachment.name)")
        .accessibilityValue(image != nil ? "Loaded" : failed ? "Couldn't load. Tap to try again" : wanted ? "Loading" : Format.bytes(attachment.size))
        .accessibilityIdentifier(A11y.Chat.attachment(attachment.name))
        .task(id: "\(attachment.fileId)/\(wanted)/\(attempt)") {
            guard !uploading, wanted, image == nil else { return }
            image = await images.attachment(attachment, serverId: serverId, size: 260)
            failed = image == nil
        }
    }
}

/// A file, video or recording: its name and size, opened with a tap.
private struct FileCard: View {
    let attachment: Attachment
    let uploadProgress: Double?
    let open: () -> Void

    var body: some View {
        let uploading = attachment.fileId.isEmpty
        let playable = attachment.mime.hasPrefix("video/") || attachment.mime.hasPrefix("audio/")
        Button(action: open) {
            HStack(spacing: 10) {
                ZStack {
                    Circle().fill(Color.white.opacity(0.1))
                    if uploading {
                        UploadRing(progress: uploadProgress ?? 0)
                    } else {
                        Image(systemName: playable ? "play.fill" : "doc.fill").font(.system(size: 16))
                    }
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name).font(.subheadline.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    if uploading {
                        ProgressView(value: uploadProgress ?? 0)
                            .tint(.white)
                            .frame(maxWidth: 160)
                    }
                    Text(uploading ? "\(Format.bytes(Int(Double(attachment.size) * (uploadProgress ?? 0)))) of \(Format.bytes(attachment.size))" : details)
                        .font(.caption)
                        .monospacedDigit()
                        .opacity(0.6)
                }
            }
            .frame(maxWidth: 260, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(uploading)
        .accessibilityIdentifier(A11y.Chat.attachment(attachment.name))
    }

    private var details: String {
        var text = Format.bytes(attachment.size)
        if let duration = attachment.duration { text += " · " + Format.duration(duration) }
        return text
    }
}

private struct UploadRing: View {
    let progress: Double

    var body: some View {
        ZStack {
            Circle().fill(.black.opacity(0.45))
            Circle().stroke(.white.opacity(0.2), lineWidth: 2.5).padding(4)
            Circle().trim(from: 0, to: progress).stroke(.white, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90)).padding(4)
        }
        .frame(width: 36, height: 36)
        .accessibilityLabel("Uploading \(Int(progress * 100))%")
    }
}

// MARK: Reactions

/// Reactions inside the bubble with the time beside them, as in Telegram: the
/// emoji or emote with up to three people's avatars, or a count once there are more.
struct ReactionsView<Meta: View>: View {
    @Environment(AppModel.self) private var model
    let message: MessageView
    let own: Bool
    let server: AppModel.ServerState
    let react: (String, EmoteRef?) -> Void
    let card: (String, EmoteRef, String?) -> Void
    @ViewBuilder var meta: Meta

    var body: some View {
        let selfId = server.me?.userId ?? ""
        let showPeople = message.reactions.reduce(0) { $0 + $1.userIds.count } <= 3
        FlowLayout(spacing: 4) {
            ForEach(message.reactions, id: \.key) { reaction in
                let mine = reaction.userIds.contains(selfId)
                Button {
                    react(reaction.key, reaction.emote)
                } label: {
                    HStack(spacing: 4) {
                        if let emote = reaction.emote {
                            EmoteView(name: reaction.key, id: emote.id, size: .small, serverUrl: server.entry.url)
                                .frame(width: 18, height: 18)
                        } else {
                            Text(reaction.key).font(.system(size: 14))
                        }
                        if showPeople {
                            HStack(spacing: -5) {
                                ForEach(reaction.userIds, id: \.self) { id in
                                    let user = server.users[id]
                                    AvatarView(name: user?.displayName ?? "?", seed: id, source: user?.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 16)
                                }
                            }
                        } else {
                            Text("\(reaction.userIds.count)").font(.caption.weight(.medium)).monospacedDigit()
                        }
                    }
                    .padding(.leading, 6)
                    .padding(.trailing, 7)
                    .frame(height: 24)
                    .foregroundStyle(mine ? (own && model.settings.accent != .neutral ? Color(hex: 0x111113) : Theme.bg1) : (own ? model.settings.accent.bubbleOwnText : Theme.text1))
                    .background(mine ? (own && model.settings.accent != .neutral ? Color.white : Theme.text1) : Color.white.opacity(0.08), in: .capsule)
                }
                .buttonStyle(.plain)
                .simultaneousGesture(LongPressGesture().onEnded { _ in
                    if let emote = reaction.emote { card(reaction.key, emote, "Reacted by \(names(reaction, selfId))") }
                })
                .accessibilityLabel("\(reaction.key), \(names(reaction, selfId))")
                .accessibilityAddTraits(mine ? .isSelected : [])
                .accessibilityIdentifier(A11y.Chat.reaction(reaction.key))
            }
            meta.padding(.leading, 8)
        }
        .padding(.top, 5)
    }

    private func names(_ reaction: ReactionView, _ selfId: String) -> String {
        reaction.userIds.map { $0 == selfId ? "You" : server.users[$0]?.displayName ?? "Someone" }.joined(separator: ", ")
    }
}

/// An emote image in SwiftUI.
struct EmoteView: UIViewRepresentable {
    let name: String
    let id: String
    let size: EmoteImages.Size
    let serverUrl: String

    func makeUIView(context: Context) -> EmoteImageView { EmoteImageView() }

    func updateUIView(_ view: EmoteImageView, context: Context) {
        view.show(name: name, id: id, size: size, serverUrl: serverUrl)
    }
}

/// Lays its children out in lines, wrapping like text.
struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews)
        let width = rows.map { row in row.last.map { $0.x + $0.size.width } ?? 0 }.max() ?? 0
        return CGSize(width: width, height: rows.last.map { row in row.map { $0.y + $0.size.height }.max() ?? 0 } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (index, item) in arrange(width: bounds.width, subviews).flatMap({ $0 }).enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + item.y), proposal: ProposedViewSize(item.size))
        }
    }

    private func arrange(width: CGFloat, _ subviews: Subviews) -> [[(x: CGFloat, y: CGFloat, size: CGSize)]] {
        var rows: [[(x: CGFloat, y: CGFloat, size: CGSize)]] = [[]]
        var x: CGFloat = 0, y: CGFloat = 0, height: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                rows.append([])
                x = 0
                y += height + spacing
                height = 0
            }
            rows[rows.count - 1].append((x, y, size))
            x += size.width + spacing
            height = max(height, size.height)
        }
        return rows
    }
}

// MARK: Emote card

/// What the desktop shows when hovering an emote, on a tap: the emote
/// large, its name, who made it, and who reacted with it.
struct EmoteCardInfo: Identifiable {
    let name: String
    let emote: EmoteRef
    let note: String?
    var id: String { emote.id + name + (note ?? "") }
}

struct EmoteCard: View {
    let info: EmoteCardInfo
    let server: AppModel.ServerState

    var body: some View {
        let owner = info.emote.owner ?? server.emotes.emotes.first { $0.id == info.emote.id }?.owner
        HStack(spacing: 16) {
            EmoteView(name: info.name, id: info.emote.id, size: .large, serverUrl: server.entry.url)
                .frame(width: 84, height: 84)
            VStack(alignment: .leading, spacing: 4) {
                Text(info.name).font(.title3.weight(.semibold)).foregroundStyle(Theme.text1)
                if let owner, !owner.isEmpty {
                    Text("by \(owner)").font(.subheadline).foregroundStyle(Theme.text2)
                }
                if let note = info.note {
                    Text(note).font(.footnote).italic().foregroundStyle(Theme.text3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.emoteCard)
    }
}

// MARK: Code

/// A fenced code block: its language, a Copy button, and the code scrolling sideways.
struct CodeBlockView: View {
    let code: String
    let language: String?
    @State private var copied = false
    @State private var lines: [Highlighter.Line]?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code")
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.4))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.plain)
            }
            .font(.caption)
            .foregroundStyle(Theme.text3)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            Divider().overlay(Theme.line)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(highlighted)
                    // Monospaced at the footnote style's size, 13 points by default, which follows the text size.
                    .font(.system(.footnote, design: .monospaced))
                    .lineSpacing(3)
                    .fixedSize()
                    .textSelection(.enabled)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 8)
            }
        }
        .background(Theme.bg0, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
        .padding(.vertical, 2)
        .task(id: code) {
            guard let language else { return }
            lines = await Highlighter.shared.tokens(code, language: language)
        }
    }

    private var highlighted: AttributedString {
        guard let lines else { return AttributedString(code, attributes: AttributeContainer().foregroundColor(Color(hex: 0xE6EDF3))) }
        var out = AttributedString()
        for (index, line) in lines.enumerated() {
            for token in line {
                var piece = AttributedString(token.text)
                piece.foregroundColor = token.color.flatMap(Color.init(css:)) ?? Color(hex: 0xE6EDF3)
                out += piece
            }
            if index < lines.count - 1 { out += AttributedString("\n") }
        }
        return out
    }
}
