import Foundation
import ZunaHost

/// What a notification shows for a pushed message (`PushPreview` in the core's push.ts).
public struct PushPreview: Decodable, Sendable, Equatable {
    public let serverId: String
    /// The chat to open, when the device knows it.
    public let conversationKey: String?
    public let title: String
    public let body: String
    /// False when the message can't be read yet: the text is then generic.
    public let decrypted: Bool
    /// The chat is muted and the message doesn't mention you.
    public let muted: Bool
    /// Nothing to show: your own message, or one deleted since.
    public let hidden: Bool
    /// Who wrote it, with their picture as base64 when asked for.
    public let sender: Person?
    /// The group it's in, with its picture.
    public let group: Group?
    /// The message alone, without the sender's name in front.
    public let text: String?
    /// The chat, for a message that can't be read: the other person in a direct message, or the group, with
    /// its picture when asked for and the server could be reached. It says nothing of who wrote it.
    public let chat: Person?
    /// When the server took the message, by its clock (ms), if it could be fetched: a chat read after that has read it.
    public let sentAt: Int?

    public struct Person: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let picture: String?
    }

    public struct Group: Decodable, Sendable, Equatable {
        public let name: String
        public let picture: String?
    }
}

extension CoreRuntime {
    /// Fetches and decrypts one pushed message, for the notification extension.
    public func pushPreview(serverId: String, groupId: String, messageId: String, pictures: Bool = false) async throws -> PushPreview {
        let json = try await previewPush(serverId: serverId, groupId: groupId, messageId: messageId, pictures: pictures)
        return try JSONDecoder().decode(PushPreview.self, from: Data(json.utf8))
    }

    /// The chats a server still counts this device as showing a notification for: it pushed one, or left
    /// the app to show one, and the chat hasn't been read on any device since.
    public func stillNotified(serverId: String) async throws -> StillNotified {
        let json = try await notifiedChats(serverId: serverId)
        return try JSONDecoder().decode(StillNotified.self, from: Data(json.utf8))
    }
}

/// What a server still counts a phone as showing notifications for (`NotifiedChats` in the core's push.ts).
public struct StillNotified: Decodable, Sendable, Equatable {
    /// The chats, by their groups' IDs.
    public let groups: Set<String>
    /// Of those, the ones read on another device before their newest message came, with when, by the
    /// server's clock (ms): what the phone shows from before then was read (`PushPreview.sentAt`).
    public let read: [String: Int]

    public init(groups: Set<String>, read: [String: Int] = [:]) {
        self.groups = groups
        self.read = read
    }

    /// Whether a message the phone shows a notification of was read on another device: one in a chat the
    /// server no longer counts was, as the whole chat was read, and in a chat read before its newest message
    /// came, one the server took before then. One it couldn't say the time of stays.
    public func hasRead(groupId: String, sentAt: Int?) -> Bool {
        guard groups.contains(groupId) else { return true }
        guard let readAt = read[groupId], let sentAt else { return false }
        return sentAt <= readAt
    }
}

/// What a phone shows for a call it was woken to ring for (`CallPreview` in the core's push.ts).
public struct CallPreview: Decodable, Sendable, Equatable {
    public let serverId: String
    /// The chat it's in, when the device knows it.
    public let conversationKey: String?
    /// Who's calling in a direct message, or the group's name.
    public let title: String
    public let body: String
    /// The conversation is muted, so it rings without a sound.
    public let muted: Bool
    /// Nothing to ring for: someone blocked, or a conversation this device doesn't have.
    public let hidden: Bool
}

extension CoreRuntime {
    /// Words a call ringing this phone from what's on the device, for the notification extension and for PushKit.
    public func callPreview(serverId: String, groupId: String, callerId: String) async throws -> CallPreview {
        let json = try await previewCall(serverId: serverId, groupId: groupId, callerId: callerId)
        return try JSONDecoder().decode(CallPreview.self, from: Data(json.utf8))
    }
}
