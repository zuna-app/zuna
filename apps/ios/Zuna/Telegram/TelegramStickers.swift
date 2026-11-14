import SwiftUI
import ZunaModels

/// The linked Telegram account's own sticker sets, in the picker's Stickers tab, as the desktop's
/// picker has them: a set at a time, its stickers in a grid, one sent as it's tapped. Still
/// stickers show as they are, and animated ones as their still picture.
struct TelegramStickers: View {
    @Environment(AppModel.self) private var model
    let onPick: (TelegramSticker) -> Void
    @State private var sets: [TelegramStickerSet]?
    @State private var shown: String?
    @State private var stickers: [String: [TelegramSticker]] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let sets, sets.isEmpty {
                ContentUnavailableView("No sticker sets", systemImage: "face.smiling", description: Text("Add sticker sets in Telegram's own app."))
                    .padding(.top, 40)
            } else if let sets {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(sets) { set in
                            Button(set.title) { shown = set.id }
                                .buttonStyle(.bordered)
                                .tint(shown == set.id ? model.settings.accent.color : Theme.text2)
                                .accessibilityIdentifier("telegram.stickers.set.\(set.id)")
                        }
                    }
                    .padding(.horizontal)
                }
                if let shown {
                    if let list = stickers[shown] {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                            ForEach(list, id: \.file) { sticker in
                                Button { onPick(sticker) } label: {
                                    StickerPicture(fileId: sticker.picture)
                                        .frame(width: 72, height: 72)
                                        .contentShape(.rect)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(sticker.emoji.isEmpty ? "Sticker" : "\(sticker.emoji) sticker")
                            }
                        }
                        .padding(.horizontal)
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
            }
        }
        .task {
            let found = (try? await model.core.session(ServerEntry.telegram).getStickerSets()) ?? []
            sets = found
            if shown == nil { shown = found.first?.id }
        }
        .task(id: shown) {
            guard let shown, stickers[shown] == nil else { return }
            stickers[shown] = (try? await model.core.session(ServerEntry.telegram).getStickers(shown)) ?? []
        }
    }
}

/// A sticker's picture, downloaded by Telegram's engine and copied out of its helper.
private struct StickerPicture: View {
    @Environment(ImageStore.self) private var images
    let fileId: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.bg3)
            }
        }
        .task(id: fileId) {
            guard let attachment = Self.attachment(fileId) else { return }
            image = await images.attachment(attachment, serverId: ServerEntry.telegram, size: 144)
        }
    }

    /// A sticker's picture as the attachment the image store loads, by its `tg:` reference.
    static func attachment(_ fileId: String) -> Attachment? {
        let json: [String: Any] = ["fileId": fileId, "key": "", "prefix": "", "chunks": 0, "name": "sticker.webp", "mime": "image/webp", "size": 0, "sticker": true]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(Attachment.self, from: data)
    }
}
