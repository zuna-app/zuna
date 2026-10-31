import Foundation
import Intents
import UserNotifications
import ZunaModels

/// How a message's notification looks: the desktop's words, laid out as a
/// conversation with the sender's picture (and a group's name and picture), as
/// Messages and Telegram show them. Built by the notification extension, and
/// in Debug builds by the app too, for the simulator, where `simctl push`
/// skips the extension.
enum MessageNotification {
    static func content(for preview: PushPreview, settings: NotificationSettings, base: UNMutableNotificationContent) async -> UNNotificationContent {
        base.userInfo["serverId"] = preview.serverId
        if let key = preview.conversationKey {
            base.threadIdentifier = "\(preview.serverId)/\(key)"
            base.userInfo["conversationKey"] = key
        }
        switch settings.preview {
        case .none:
            // Only that something arrived: no names, no pictures.
            return base
        case .sender:
            base.title = preview.title
            base.body = "New message"
        case .full:
            base.title = preview.title
            base.body = preview.body
        }
        guard let sender = preview.sender else { return base }

        let picture = { (base64: String?) in base64.flatMap { Data(base64Encoded: $0) }.map { INImage(imageData: $0) } }
        let person = INPerson(
            personHandle: INPersonHandle(value: sender.id, type: .unknown),
            nameComponents: nil,
            displayName: sender.name,
            image: picture(sender.picture),
            contactIdentifier: nil,
            customIdentifier: sender.id
        )
        let me = INPerson(
            personHandle: INPersonHandle(value: "me", type: .unknown),
            nameComponents: nil,
            displayName: nil,
            image: nil,
            contactIdentifier: nil,
            customIdentifier: nil,
            isMe: true
        )
        // In a group the layout names the sender, so the text goes without it.
        if settings.preview == .full, preview.group != nil, let text = preview.text { base.body = text }
        let intent = INSendMessageIntent(
            recipients: preview.group == nil ? [me] : [me, person],
            outgoingMessageType: .outgoingMessageText,
            content: base.body,
            speakableGroupName: preview.group.map { INSpeakableString(spokenPhrase: $0.name) },
            conversationIdentifier: base.threadIdentifier,
            serviceName: nil,
            sender: person,
            attachments: nil
        )
        if let image = picture(preview.group?.picture) {
            intent.setImage(image, forParameterNamed: \.speakableGroupName)
        }
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        try? await interaction.donate()
        return (try? base.updating(from: intent)) ?? base
    }
}
