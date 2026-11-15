import SwiftUI
import ZunaModels

/// What a chat's details list, in Telegram's order, as the desktop's SharedMedia.tsx
/// does. GIFs aren't a kind of their own here.
enum SharedKind: String, Hashable, CaseIterable {
    case photo, video, file, audio, link, voice, groups

    /// What the core counts and pages; groups in common come from the conversations instead.
    var media: MediaKind? { MediaKind(rawValue: rawValue) }

    var icon: String {
        switch self {
        case .photo: "photo"
        case .video: "video"
        case .file: "doc"
        case .audio: "headphones"
        case .link: "link"
        case .voice: "mic"
        case .groups: "person.2"
        }
    }

    var title: String {
        switch self {
        case .photo: t("details.media.photos")
        case .video: t("details.media.videos")
        case .file: t("details.media.files")
        case .audio: t("details.media.audio")
        case .link: t("details.media.links")
        case .voice: t("details.media.voice")
        case .groups: t("details.media.groups")
        }
    }

    /// "2 photos", "1 shared link".
    func counted(_ count: Int) -> String {
        switch self {
        case .photo: t("details.media.photoCount", ["count": count])
        case .video: t("details.media.videoCount", ["count": count])
        case .file: t("details.media.fileCount", ["count": count])
        case .audio: t("details.media.audioCount", ["count": count])
        case .link: t("details.media.linkCount", ["count": count])
        case .voice: t("details.media.voiceCount", ["count": count])
        case .groups: t("details.media.groupCount", ["count": count])
        }
    }

    func count(in counts: MediaCounts?, groups: Int) -> Int {
        switch self {
        case .photo: counts?.photo ?? 0
        case .video: counts?.video ?? 0
        case .file: counts?.file ?? 0
        case .audio: counts?.audio ?? 0
        case .link: counts?.link ?? 0
        case .voice: counts?.voice ?? 0
        case .groups: groups
        }
    }
}

/// A new value whenever a chat's messages may have changed: those loaded in it, or its last activity.
struct ChatChange: Equatable {
    let items: [MessageView]?
    let lastActivityAt: Int
}

extension AppModel {
    func chatChange(_ serverId: String, _ conversation: ConversationView) -> ChatChange {
        ChatChange(items: conversation.groupId.flatMap { list(serverId, $0)?.items }, lastActivityAt: conversation.lastActivityAt)
    }
}

extension AppModel.ServerState {
    /// The groups this person and this account are both in.
    func groupsInCommon(with peerId: String?) -> [ConversationView] {
        guard let peerId, peerId != me?.userId else { return [] }
        return conversations.filter { conversation in
            conversation.kind == .group && !conversation.removed && conversation.members.contains { $0.userId == peerId && $0.notOnRoster != true }
        }
    }
}

/// One kind of thing from a chat, newest first, more of it as it's scrolled.
/// Anything listed can be shown in the chat from its menu.
struct SharedMediaView: View {
    @Environment(AppModel.self) private var model
    let conversationKey: String
    let kind: SharedKind

    var body: some View {
        ZStack {
            if let server = model.activeServer, let conversation = server.conversation(conversationKey) {
                if let media = kind.media {
                    if let groupId = conversation.groupId {
                        SharedMessages(server: server, conversation: conversation, groupId: groupId, kind: media)
                    } else {
                        NothingShared(kind: kind)
                    }
                } else {
                    GroupsInCommon(server: server, conversation: conversation)
                }
            } else {
                ContentUnavailableView(t("details.unavailable"), systemImage: "bubble.left.and.exclamationmark.bubble.right")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg0)
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Shared.screen)
    }
}

private struct NothingShared: View {
    let kind: SharedKind

    var body: some View {
        ContentUnavailableView(t("details.media.nothing"), systemImage: kind.icon)
            .foregroundStyle(Theme.text2)
    }
}

private struct SharedMessages: View {
    @Environment(AppModel.self) private var model
    let server: AppModel.ServerState
    let conversation: ConversationView
    let groupId: String
    let kind: MediaKind

    @State private var messages: [MessageView]?
    @State private var hasMore = false
    @State private var loadingMore = false
    /// Why the first page couldn't be loaded, rather than saying there's nothing.
    @State private var failed: String?
    @State private var attempt = 0

    private static let page = 50

    var body: some View {
        Group {
            if let messages, messages.isEmpty {
                NothingShared(kind: SharedKind(rawValue: kind.rawValue) ?? .file)
            } else if let messages {
                if kind == .photo || kind == .video { grid(messages) } else { list(messages) }
            } else if let failed {
                ContentUnavailableView {
                    Label(t("details.shared.loadFailed"), systemImage: "exclamationmark.circle")
                } description: {
                    Text(failed)
                } actions: {
                    Button(t("common.tryAgain")) {
                        self.failed = nil
                        attempt += 1
                    }
                }
                .foregroundStyle(Theme.text2)
            } else {
                ProgressView()
            }
        }
        // When the chat changes, everything shown so far is read again, so deletions and edits show.
        .task(id: Reload(change: model.chatChange(server.entry.id, conversation), attempt: attempt)) {
            // New messages come in bursts as history arrives, so reading again waits for a quiet moment.
            if messages != nil { try? await Task.sleep(for: .milliseconds(150)) }
            guard !Task.isCancelled else { return }
            do {
                let page = try await model.core.session(server.entry.id).loadMedia(groupId, kind: kind, limit: max(Self.page, messages?.count ?? 0))
                guard !Task.isCancelled else { return }
                messages = page.messages
                hasMore = page.hasMore
            } catch {
                if !Task.isCancelled, messages == nil { failed = ErrorText.describe(error) }
            }
        }
    }

    private struct Reload: Equatable {
        let change: ChatChange
        let attempt: Int
    }

    private func grid(_ messages: [MessageView]) -> some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 2)], spacing: 2) {
                ForEach(items(of: messages)) { item in
                    MediaTile(message: item.message, attachment: item.attachment, serverId: server.entry.id, others: messages) { show(item.message) }
                }
            }
            more
        }
    }

    private func list(_ messages: [MessageView]) -> some View {
        List {
            ForEach(months(messages)) { month in
                Section(month.title) {
                    if kind == .link {
                        ForEach(month.messages) { message in
                            LinkRow(message: message, server: server) { show(message) }
                        }
                    } else {
                        ForEach(items(of: month.messages)) { item in
                            AttachmentRow(message: item.message, attachment: item.attachment, server: server) { show(item.message) }
                        }
                    }
                }
                .listRowBackground(Theme.bg2)
            }
            more.listRowBackground(Color.clear)
        }
        .scrollContentBackground(.hidden)
    }

    /// Asks for more once it's scrolled into view. Made anew for each page, so it asks again if it's still in view.
    @ViewBuilder
    private var more: some View {
        if hasMore {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .id(messages?.count ?? 0)
                .onAppear { Task { await loadMore() } }
        }
    }

    private func loadMore() async {
        guard !loadingMore, hasMore, let oldest = messages?.last?.seq else { return }
        loadingMore = true
        defer { loadingMore = false }
        guard let page = try? await model.core.session(server.entry.id).loadMedia(groupId, kind: kind, before: oldest) else { return }
        let have = Set(messages?.map(\.id) ?? [])
        messages = (messages ?? []) + page.messages.filter { !have.contains($0.id) }
        hasMore = page.hasMore
    }

    /// One attachment of one message, a tile or a row, known by both. Known by its place in its
    /// message alone, as it was, every tile of a chat's photos was the first one's, and only it showed.
    private struct Item: Identifiable {
        let message: MessageView
        let attachment: Attachment
        let id: String
    }

    /// The attachments of this kind in these messages, in order.
    private func items(of messages: [MessageView]) -> [Item] {
        messages.flatMap { message in
            message.attachments.enumerated()
                .filter { $0.element.mediaKind == kind }
                .map { Item(message: message, attachment: $0.element, id: "\(message.id)/\($0.offset)") }
        }
    }

    private struct Month: Identifiable {
        let title: String
        var messages: [MessageView]
        var id: String { messages[0].id }
    }

    private func months(_ messages: [MessageView]) -> [Month] {
        var months: [Month] = []
        for message in messages {
            let title = Date(milliseconds: message.createdAt).formatted(.dateTime.month(.wide).year())
            if months.last?.title == title {
                months[months.count - 1].messages.append(message)
            } else {
                months.append(Month(title: title, messages: [message]))
            }
        }
        return months
    }

    /// Back to the chat, at the message.
    private func show(_ message: MessageView) {
        if let index = model.chatPath.firstIndex(of: .chat(conversation.key)) {
            model.chatPath = Array(model.chatPath.prefix(through: index))
        } else {
            model.openChat(conversation.key)
        }
        Task { await model.jumpToMessage(server.entry.id, groupId: message.groupId, messageId: message.id, seq: message.seq) }
    }
}

/// "Show in chat", for anything listed.
private struct ShowInChat: ViewModifier {
    let show: () -> Void

    func body(content: Content) -> some View {
        content.contextMenu {
            Button(t("details.media.showInChat"), systemImage: "text.bubble", action: show)
        }
    }
}

/// A photo or a video, as a square. A photo opens in the viewer, loading first if
/// it's one too big to load by itself; a video plays where it was sent.
private struct MediaTile: View {
    @Environment(AppModel.self) private var model
    @Environment(ImageStore.self) private var images
    let message: MessageView
    let attachment: Attachment
    let serverId: String
    /// The messages around it, newest first, whose pictures the viewer goes between.
    let others: [MessageView]
    let show: () -> Void
    @State private var image: UIImage?
    @State private var failed = false
    @State private var tapped = false
    /// Tries after one that failed, each from a tap on it.
    @State private var attempt = 0

    var body: some View {
        let video = attachment.mediaKind == .video
        let wanted = attachment.loadsByItself || tapped
        let shown = image ?? (video ? images.cachedVideoFrame(attachment) : images.cachedAttachment(attachment))
        Button {
            if video {
                show()
            } else if shown != nil {
                open()
            } else if failed {
                failed = false
                attempt += 1
            } else {
                tapped = true
            }
        } label: {
            Theme.bg3
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let shown {
                        Image(uiImage: shown).resizable().scaledToFill()
                    } else if let thumb = attachment.thumb.flatMap(ImageStore.thumbnail) {
                        Image(uiImage: thumb).resizable().scaledToFill().blur(radius: video ? 0 : 8)
                    }
                }
                .overlay {
                    if video {
                        Image(systemName: "play.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(.black.opacity(0.5), in: .circle)
                    } else if failed {
                        // A tap tries again.
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(.black.opacity(0.5), in: .circle)
                    } else if !wanted {
                        Image(systemName: "arrow.down.circle")
                            .font(.system(size: 18))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(.black.opacity(0.5), in: .circle)
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if video, let duration = attachment.duration {
                        Text(Format.duration(duration))
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.black.opacity(0.55), in: .capsule)
                            .padding(5)
                    }
                }
                .clipped()
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .modifier(ShowInChat(show: show))
        .accessibilityLabel(video ? t("details.shared.showFile", ["name": attachment.name]) : wanted ? t("details.shared.openFile", ["name": attachment.name]) : t("details.media.load", ["name": attachment.name]))
        .accessibilityValue(video ? "" : shown != nil ? t("details.shared.loaded") : failed ? t("details.shared.loadFailedTap") : wanted ? t("details.shared.loading") : Format.bytes(attachment.size))
        .accessibilityHint(Format.full(message.createdAt))
        .accessibilityIdentifier(A11y.Shared.item(attachment.name))
        // Only once it's on screen, since the grid makes its tiles as they scroll in.
        .task(id: "\(attachment.fileId)/\(wanted)/\(attempt)") {
            guard image == nil, wanted else { return }
            image = video
                ? await images.videoFrame(attachment, serverId: serverId, size: 260)
                : await images.attachment(attachment, serverId: serverId, size: 260)
            // A video without a frame still has its picture and plays.
            failed = image == nil && !video
        }
    }

    private func open() {
        // Oldest on the left, as in the chat.
        let gallery = PhotoViewer.Item.media(in: others.reversed(), showing: attachment, of: message, server: model.servers[serverId], images: images)
        PhotoViewer.show(gallery.items, at: gallery.index)
    }
}

/// Who sent something, and when.
private struct SentBy: View {
    let message: MessageView
    let server: AppModel.ServerState

    var body: some View {
        HStack(spacing: 0) {
            Text(message.senderId == server.me?.userId ? t("common.you") : server.users[message.senderId]?.displayName ?? t("chat.unknown"))
                .foregroundStyle(Theme.nameColor(message.senderId))
            Text(" · \(Format.full(message.createdAt))")
                .foregroundStyle(Theme.text3)
        }
        .font(.caption)
        .lineLimit(1)
    }
}

/// A file, a sound file or a voice message, with who sent it and when. A voice
/// message plays where it is; the others open in QuickLook, as in the chat.
private struct AttachmentRow: View {
    @Environment(AppModel.self) private var model
    @Environment(ImageStore.self) private var images
    let message: MessageView
    let attachment: Attachment
    let server: AppModel.ServerState
    let show: () -> Void
    @State private var opening = false

    var body: some View {
        if attachment.mediaKind == .voice {
            VStack(alignment: .leading, spacing: 4) {
                VoiceCard(attachment: attachment, serverId: server.entry.id, own: false, messageId: message.id, uploadProgress: nil)
                SentBy(message: message, server: server)
            }
            .modifier(ShowInChat(show: show))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(A11y.Shared.item(attachment.name))
        } else {
            Button(action: open) {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(Theme.bg4)
                        if opening {
                            ProgressView().tint(Theme.text1)
                        } else {
                            Image(systemName: attachment.mediaKind == .audio ? "play.fill" : "doc.fill")
                                .font(.system(size: 16))
                                .foregroundStyle(Theme.text1)
                        }
                    }
                    .frame(width: 42, height: 42)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment.name)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.text1)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text([Format.bytes(attachment.size), attachment.duration.map(Format.duration)].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.text2)
                        SentBy(message: message, server: server)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(opening)
            .modifier(ShowInChat(show: show))
            .accessibilityIdentifier(A11y.Shared.item(attachment.name))
        }
    }

    private func open() {
        opening = true
        Task {
            defer { opening = false }
            do {
                let file = try await images.openable(attachment, serverId: server.entry.id)
                FilePreview.show(file)
            } catch {
                model.toast(t("details.shared.openFailed", ["name": attachment.name, "error": ErrorText.describe(error)]), .error)
            }
        }
    }
}

/// A message's links, under its preview if it has one. What the preview says is
/// the sender's claim, so each link shows where it really goes, as in the chat.
private struct LinkRow: View {
    @Environment(\.openURL) private var openURL
    let message: MessageView
    let server: AppModel.ServerState
    let show: () -> Void

    var body: some View {
        let links = Markup.sharedLinks(message.text)
        // Only a preview of one of the message's own links.
        let preview = message.preview.flatMap { links.contains($0.url) ? $0 : nil }
        let host = linkHost(links.first ?? "")
        let description = preview?.description ?? withoutLinks(plainText(message.text), links)
        HStack(alignment: .top, spacing: 12) {
            if let picture = preview?.image.flatMap(PreviewImages.image) {
                Image(uiImage: picture).resizable().scaledToFill().frame(width: 46, height: 46).clipShape(.rect(cornerRadius: 8))
            } else {
                Text(host.first.map { String($0).uppercased() } ?? "?")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(Theme.avatarColor(host), in: .rect(cornerRadius: 8))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(preview?.title ?? host)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text1)
                    .lineLimit(1)
                if !description.isEmpty {
                    Text(description).font(.footnote).foregroundStyle(Theme.text2).lineLimit(3)
                }
                ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                    Button(link) {
                        if let url = URL(string: link) { openURL(url) }
                    }
                    .buttonStyle(.borderless)
                    .font(.footnote)
                    .foregroundStyle(Theme.link)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
                SentBy(message: message, server: server)
            }
            Spacer(minLength: 0)
        }
        .modifier(ShowInChat(show: show))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Shared.item(message.id))
    }

    /// The message's own words, for a link with no preview: its text with each link taken out once, as the desktop does.
    private func withoutLinks(_ text: String, _ links: [String]) -> String {
        var rest = text
        for link in links {
            if let range = rest.range(of: link) { rest.replaceSubrange(range, with: "") }
        }
        return rest.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

/// The groups this person and this account are both in; a tap opens one.
private struct GroupsInCommon: View {
    @Environment(AppModel.self) private var model
    let server: AppModel.ServerState
    let conversation: ConversationView

    var body: some View {
        let groups = conversation.kind == .group ? [] : server.groupsInCommon(with: conversation.peerId)
        if groups.isEmpty {
            NothingShared(kind: .groups)
        } else {
            List {
                ForEach(groups) { group in
                    Button {
                        model.openChat(group.key)
                    } label: {
                        HStack(spacing: 12) {
                            AvatarView(name: group.title, seed: group.groupId ?? group.key, source: group.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none, size: 40)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(group.title).foregroundStyle(Theme.text1).lineLimit(1)
                                Text(t("details.group.members", ["count": group.members.count]))
                                    .font(.caption)
                                    .foregroundStyle(Theme.text3)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(A11y.Shared.group(group.key))
                }
                .listRowBackground(Theme.bg2)
            }
            .scrollContentBackground(.hidden)
        }
    }
}
