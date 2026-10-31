import Foundation
import ZunaModels

/// One chat's loaded messages, as the desktop's store keeps them (state/store.ts).
struct MessageList: Equatable {
    var items: [MessageView] = []
    var hasMore = true
    var loading = false
    var loaded = false
    /// Showing a window around a jump target, not the newest messages.
    var detached = false
}

/// A request to show a message: a reply's original, a pin or a search hit.
struct JumpTarget: Equatable {
    let listKey: String
    let messageId: String
    let nonce: Int
}

extension AppModel {
    /// Where a conversation's messages live before and after its group exists, as on the desktop.
    static func listId(for conversation: ConversationView) -> String {
        conversation.groupId ?? "pending:\(conversation.key)"
    }

    /// Lists are kept per server, since a group belongs to one server.
    static func listKey(_ serverId: String, _ listId: String) -> String {
        "\(serverId)/\(listId)"
    }

    func list(_ serverId: String, _ listId: String) -> MessageList? {
        lists[Self.listKey(serverId, listId)]
    }

    /// The newest page, once per chat; later changes arrive as events.
    func loadList(_ serverId: String, _ listId: String, groupId: String?) async {
        let key = Self.listKey(serverId, listId)
        if let existing = lists[key], existing.loaded || existing.loading { return }
        lists[key, default: MessageList()].loading = true
        guard let groupId else {
            // A conversation that hasn't started yet has nothing to load.
            lists[key]?.loading = false
            lists[key]?.loaded = true
            lists[key]?.hasMore = false
            return
        }
        do {
            let page = try await core.session(serverId).loadMessages(groupId)
            var current = lists[key] ?? MessageList()
            var byId = Dictionary(page.messages.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
            for item in current.items where byId[item.id] == nil { byId[item.id] = item }
            current.items = Self.sorted(Array(byId.values))
            current.hasMore = page.hasMore
            current.loading = false
            current.loaded = true
            lists[key] = current
        } catch {
            lists[key]?.loading = false
            toast(OnboardingText.describe(error), .error)
        }
    }

    /// The page before the oldest loaded message.
    func loadOlder(_ serverId: String, _ listId: String) async {
        let key = Self.listKey(serverId, listId)
        guard let list = lists[key], !list.loading, list.hasMore,
              let oldest = list.items.first(where: { $0.seq != nil })?.seq else { return }
        lists[key]?.loading = true
        do {
            let page = try await core.session(serverId).loadMessages(listId, before: oldest)
            guard var current = lists[key] else { return }
            let known = Set(current.items.map(\.id))
            current.items = page.messages.filter { !known.contains($0.id) } + current.items
            current.hasMore = page.hasMore
            current.loading = false
            lists[key] = current
        } catch {
            lists[key]?.loading = false
        }
    }

    /// Shows a message, loading the messages around it if they aren't loaded.
    func jumpToMessage(_ serverId: String, groupId: String, messageId: String, seq: Int? = nil) async {
        let key = Self.listKey(serverId, groupId)
        let present = lists[key]?.items.contains { $0.id == messageId } ?? false
        if !present {
            var target = seq
            if target == nil {
                target = (try? await core.session(serverId).messageById(groupId, id: messageId))?.seq
            }
            guard let target else {
                toast("That message isn't available.")
                return
            }
            do {
                let window = try await core.session(serverId).loadAround(groupId, seq: target)
                lists[key] = MessageList(items: Self.sorted(window), hasMore: true, loading: false, loaded: true, detached: true)
            } catch {
                toast(OnboardingText.describe(error), .error)
                return
            }
        }
        nextJump += 1
        jumpTarget = JumpTarget(listKey: key, messageId: messageId, nonce: nextJump)
    }

    /// Leaves a detached window for the newest messages.
    func returnToLatest(_ serverId: String, _ listId: String) async {
        lists[Self.listKey(serverId, listId)] = nil
        await loadList(serverId, listId, groupId: listId)
    }

    func markRead(_ serverId: String, groupId: String, seq: Int) {
        Task { try? await core.session(serverId).markRead(groupId, seq: seq) }
    }

    // MARK: Events

    func upsert(_ serverId: String, _ message: MessageView) {
        let key = Self.listKey(serverId, message.groupId)
        guard var list = lists[key] else { return }
        if let index = list.items.firstIndex(where: { $0.id == message.id }) {
            list.items[index] = message
        } else {
            guard !list.detached else { return }
            list.items = Self.sorted(list.items + [message])
        }
        lists[key] = list
    }

    func remove(_ serverId: String, groupId: String, id: String) {
        lists[Self.listKey(serverId, groupId)]?.items.removeAll { $0.id == id }
    }

    /// The first message of a DM moves once its group exists; it stays on screen.
    func move(_ serverId: String, from fromGroupId: String, _ message: MessageView) {
        lists[Self.listKey(serverId, fromGroupId)]?.items.removeAll { $0.id == message.id }
        let key = Self.listKey(serverId, message.groupId)
        var target = lists[key] ?? MessageList()
        target.items = Self.sorted(target.items.filter { $0.id != message.id } + [message])
        lists[key] = target
    }

    /// By sequence number; messages still being sent, which have none, go last in the order they were written.
    static func sorted(_ items: [MessageView]) -> [MessageView] {
        items.sorted { a, b in
            switch (a.seq, b.seq) {
            case let (x?, y?): x < y
            case (nil, nil): a.createdAt < b.createdAt
            case (nil, _?): false
            case (_?, nil): true
            }
        }
    }
}
