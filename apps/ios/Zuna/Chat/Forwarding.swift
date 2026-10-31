import SwiftUI
import ZunaModels

/// Link previews' pictures, decoded once: they travel inside messages as data URLs.
@MainActor
enum PreviewImages {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(_ picture: LinkPreview.Image) -> UIImage? {
        let key = picture.data as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let comma = picture.data.firstIndex(of: ","),
              let data = Data(base64Encoded: String(picture.data[picture.data.index(after: comma)...])),
              let image = UIImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}

/// A link's preview in a message, as in Telegram: a bar on the left, the site,
/// title and description, and the picture, below when it's wide and beside
/// the text when it's small. The sender's device made it.
struct LinkCard: View {
    let preview: LinkPreview
    let own: Bool
    let messageId: String
    @Environment(\.openURL) private var openURL

    var body: some View {
        let picture = preview.image.flatMap(PreviewImages.image)
        let wide = (preview.image?.width ?? 0) >= 300 && (preview.image?.width ?? 0) >= (preview.image?.height ?? 0) * 1.2
        Button {
            if let url = URL(string: preview.url) { openURL(url) }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        if let site = preview.siteName {
                            Text(site).font(.footnote.weight(.semibold)).foregroundStyle(own ? Color.white : Theme.text1).lineLimit(1)
                        }
                        if let title = preview.title {
                            Text(title).font(.footnote.weight(.semibold)).foregroundStyle(own ? Color.white : Theme.text1).lineLimit(2)
                        }
                        if let description = preview.description {
                            Text(description).font(.footnote).foregroundStyle(own ? Color.white.opacity(0.7) : Theme.text2).lineLimit(3)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let picture, !wide {
                        Image(uiImage: picture).resizable().scaledToFill().frame(width: 56, height: 56).clipShape(.rect(cornerRadius: 6))
                    }
                }
                if let picture, wide, let size = preview.image {
                    Image(uiImage: picture)
                        .resizable()
                        .aspectRatio(CGSize(width: size.width, height: size.height), contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipShape(.rect(cornerRadius: 6))
                }
            }
            .multilineTextAlignment(.leading)
            .padding(.leading, 10)
            .padding(.trailing, 8)
            .padding(.vertical, 5)
            .background(Color.white.opacity(own ? 0.07 : 0.05), in: .rect(cornerRadius: 4))
            .overlay(alignment: .leading) {
                Rectangle().fill(own ? Color.white.opacity(0.55) : Theme.text3).frame(width: 2)
            }
            .clipShape(.rect(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.linkPreview(messageId))
    }
}

/// Whose message this was, as in Telegram; a tap shows them. Forwarded from
/// another server, it only says it's forwarded.
struct ForwardedLabel: View {
    let forwarded: ForwardInfo
    let own: Bool
    let server: AppModel.ServerState
    let open: (_ userId: String) -> Void

    var body: some View {
        let name = forwarded.userId.flatMap { $0 == server.me?.userId ? "You" : server.users[$0]?.displayName }
        Button {
            if let userId = forwarded.userId, name != nil { open(userId) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrowshape.turn.up.right").font(.system(size: 11, weight: .semibold))
                if let name {
                    Text("Forwarded from \(Text(name).fontWeight(.semibold))")
                } else {
                    Text("Forwarded")
                }
            }
            .font(.footnote)
            .foregroundStyle(own ? Color.white.opacity(0.7) : Theme.text2)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Chat.forwarded)
    }
}

/// Where to forward a message: any chat on any server, this one first. Picking
/// one sends it there and says so, as Telegram does on the phone.
struct ForwardSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let serverId: String
    let messages: [MessageView]
    var onForwarded: () -> Void = {}
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections, id: \.server.entry.id) { section in
                    Section {
                        ForEach(section.chats) { chat in
                            Button {
                                dismiss()
                                onForwarded()
                                Task { await model.forward(messages, from: serverId, to: section.server.entry.id, chat) }
                            } label: {
                                row(chat, server: section.server)
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Theme.bg2)
                            .accessibilityIdentifier(A11y.Forward.row(chat.title))
                        }
                    } header: {
                        if sections.count > 1 || section.server.entry.id != serverId { Text(section.server.entry.name) }
                    }
                }
                if sections.isEmpty {
                    ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search chats")
            .navigationTitle("Forward to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .accessibilityIdentifier(A11y.Forward.sheet)
    }

    private var sections: [(server: AppModel.ServerState, chats: [ConversationView])] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return ([serverId] + model.order.filter { $0 != serverId })
            .compactMap { model.servers[$0] }
            .map { server in
                (server, server.conversations.filter { chat in
                    !server.prefs.hidden.contains(chat.key) && (needle.isEmpty || chat.title.lowercased().contains(needle))
                })
            }
            .filter { !$0.chats.isEmpty }
    }

    private func row(_ chat: ConversationView, server: AppModel.ServerState) -> some View {
        HStack(spacing: 12) {
            if chat.peerId != nil && chat.peerId == server.me?.userId {
                Image(systemName: "bookmark.fill")
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.text1)
                    .frame(width: 40, height: 40)
                    .background(Theme.bg4, in: .circle)
            } else {
                AvatarView(
                    name: chat.title,
                    seed: chat.peerId ?? chat.groupId ?? chat.key,
                    source: chat.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                    size: 40
                )
            }
            Text(chat.title).font(.body.weight(.medium)).foregroundStyle(Theme.text1).lineLimit(1)
            Spacer(minLength: 0)
        }
        .contentShape(.rect)
    }
}
