import Foundation
import ImageIO
import Intents
import UIKit
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
        // A chat read elsewhere before this was sent doesn't take it away.
        if let sentAt = preview.sentAt { base.userInfo["sentAt"] = sentAt }
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
        // A message that can't be read is laid out as its chat's, as its title names it: the picture of
        // the person it's with, or of the group, in place of the app's icon.
        guard let sender = preview.sender ?? preview.chat else { return base }

        let person = INPerson(
            personHandle: INPersonHandle(value: sender.id, type: .unknown),
            nameComponents: nil,
            displayName: sender.name,
            // Without an image iOS shows the app's icon, so someone with no picture gets the list's initials.
            image: INImage(imageData: picture(sender.picture) ?? placeholder(name: sender.name, seed: sender.id)),
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
        // A group without a picture shows the sender's.
        if let image = picture(preview.group?.picture) {
            intent.setImage(INImage(imageData: image), forParameterNamed: \.speakableGroupName)
        }
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        try? await interaction.donate()
        return (try? base.updating(from: intent)) ?? base
    }

    /// The size pictures are drawn at, as the system shows them at most.
    private static let side = 256

    /// A picture as a notification can show it: a small PNG of its first frame,
    /// whatever the file was, as iOS shows its app icon in place of a WebP, which
    /// the web app makes.
    private static func picture(_ base64: String?) -> Data? {
        guard let data = base64.flatMap({ Data(base64Encoded: $0) }),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: side,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image).pngData()
    }

    /// Initials on the color the chat list gives them (`AvatarView`).
    private static func placeholder(name: String, seed: String) -> Data {
        let rgb = Format.avatarColors[Format.colorIndex(seed, count: Format.avatarColors.count)]
        let color = UIColor(red: CGFloat(rgb >> 16 & 0xFF) / 255, green: CGFloat(rgb >> 8 & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
        let size = CGSize(width: side, height: side)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            color.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            let initials = Format.initials(name) as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: size.width * 0.38, weight: .semibold),
                .foregroundColor: UIColor.white,
            ]
            let text = initials.size(withAttributes: attributes)
            initials.draw(at: CGPoint(x: (size.width - text.width) / 2, y: (size.height - text.height) / 2), withAttributes: attributes)
        }
    }
}
