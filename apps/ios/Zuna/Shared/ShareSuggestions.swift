import Intents
import UIKit
import ZunaModels

/// The chats this device sends to, told to iOS as messages sent, which is what
/// the share sheet's row of people and groups is made from; notifications tell
/// it of messages received. Who it went to, never what was said, and nothing
/// while notifications are set to show no names.
enum ShareSuggestions {
    /// A chat this device just sent to, named as `ShareTarget.id` and notifications name it,
    /// so the share extension opens with it picked. On the main actor, as its pictures are kept there.
    @MainActor static func sent(to key: String, on serverId: String, title: String, avatar: AvatarRef?, through core: CoreConnection) async {
        guard NotificationSettings.load().preview != .none else { return }
        let id = "\(serverId)/\(key)"
        let image = await picture(avatar, serverId: serverId, through: core)
        let intent: INSendMessageIntent
        if key.hasPrefix("user:") {
            let person = INPerson(
                personHandle: INPersonHandle(value: String(key.dropFirst("user:".count)), type: .unknown),
                nameComponents: nil,
                displayName: title,
                image: image,
                contactIdentifier: nil,
                customIdentifier: String(key.dropFirst("user:".count))
            )
            intent = INSendMessageIntent(recipients: [person], outgoingMessageType: .outgoingMessageText, content: nil, speakableGroupName: nil, conversationIdentifier: id, serviceName: nil, sender: nil, attachments: nil)
        } else {
            intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText, content: nil, speakableGroupName: INSpeakableString(spokenPhrase: title), conversationIdentifier: id, serviceName: nil, sender: nil, attachments: nil)
            if let image { intent.setImage(image, forParameterNamed: \.speakableGroupName) }
        }
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .outgoing
        interaction.groupIdentifier = id
        try? await interaction.donate()
    }

    /// Each picture made small, by its file, so that sending to a chat again doesn't
    /// download, decode and shrink its picture again.
    @MainActor private static var pictures: [String: Data] = [:]

    /// The chat's picture, small, as the share sheet shows it.
    @MainActor private static func picture(_ avatar: AvatarRef?, serverId: String, through core: CoreConnection) async -> INImage? {
        guard let avatar else { return nil }
        if let data = pictures[avatar.cacheId] { return INImage(imageData: data) }
        guard let file = try? await core.session(serverId).downloadFile(avatar),
              let image = UIImage(contentsOfFile: file.path),
              let small = await image.byPreparingThumbnail(ofSize: CGSize(width: 180, height: 180)),
              let data = small.jpegData(compressionQuality: 0.8) else { return nil }
        if pictures.count >= 64 { pictures.removeAll() }
        pictures[avatar.cacheId] = data
        return INImage(imageData: data)
    }
}
