import Foundation
import ZunaModels

/// Keeps the pictures of the Telegram account's chats where its notifications find them
/// (`TelegramPictures`), as the list changes: one for each of the top chats with a picture, made
/// again when it changes, and none for the rest. Each comes from the engine once, small.
@MainActor
final class TelegramPictureKeeper {
    private let core: CoreConnection
    /// The chats as the list last had them, top first.
    private var listed: [ConversationView] = []
    /// Which of Telegram's files each chat's kept picture was made from, as this run knows it: "" for none.
    private var kept: [String: String] = [:]
    /// Pictures that couldn't be had, which aren't asked for again for a while.
    private var failed: [String: Date] = [:]
    private var running = false
    private var again = false

    init(core: CoreConnection) {
        self.core = core
    }

    /// The chats as the list has them now; none once the account is unlinked, which takes every picture away.
    func listChanged(_ conversations: [ConversationView]) {
        listed = Array(conversations.prefix(TelegramPictures.most))
        guard !running else {
            again = true
            return
        }
        running = true
        Task {
            repeat {
                again = false
                await pass()
            } while again
            running = false
        }
    }

    /// A chat's picture, made now if it isn't kept yet, as for a notification about to show.
    func ensure(_ chatId: String) async {
        guard let chat = listed.first(where: { $0.groupId == chatId }), let keys = TelegramPictures.keys() else { return }
        await keep(chat, chatId, keys)
    }

    private func pass() async {
        if listed.isEmpty { TelegramPictures.eraseAll() }
        guard let keys = TelegramPictures.keys() else { return }
        let chats = listed
        for chat in chats {
            guard let chatId = chat.groupId else { continue }
            await keep(chat, chatId, keys)
        }
        let ids = chats.compactMap(\.groupId)
        TelegramPictures.keepOnly(ids, keys)
        let listedIds = Set(ids)
        kept = kept.filter { listedIds.contains($0.key) }
    }

    private func keep(_ chat: ConversationView, _ chatId: String, _ keys: TelegramPictures.Keys) async {
        let version = chat.avatar.map(Self.version) ?? ""
        guard kept[chatId] != version else { return }
        if let avatar = chat.avatar {
            if TelegramPictures.read(chatId, keys)?.version != version {
                if let at = failed[chatId], Date().timeIntervalSince(at) < 600 { return }
                guard let file = try? await core.session(ServerEntry.telegram).downloadFile(avatar),
                      let data = try? Data(contentsOf: URL(fileURLWithPath: file.path)),
                      let small = MessageNotification.small(data, jpeg: true) else {
                    failed[chatId] = Date()
                    return
                }
                failed[chatId] = nil
                TelegramPictures.keep(small, version: version, for: chatId, keys)
            }
        } else {
            TelegramPictures.forget(chatId, keys)
        }
        kept[chatId] = version
    }

    /// Telegram's lasting ID for a picture's file (`tg:<number>:<ID>`), which stays when the engine
    /// numbers its files anew, as it does each time it starts.
    private static func version(_ avatar: AvatarRef) -> String {
        let parts = avatar.fileId.split(separator: ":", maxSplits: 2)
        return parts.count == 3 ? String(parts[2]) : avatar.fileId
    }
}
