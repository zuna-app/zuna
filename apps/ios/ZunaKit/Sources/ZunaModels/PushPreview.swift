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
}
