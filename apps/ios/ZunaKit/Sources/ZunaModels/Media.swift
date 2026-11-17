import Foundation

// What a message holds, for the lists in a chat's details: the Swift twin of
// packages/core/src/media.ts and of `linkHost` in packages/core/src/links.ts.
// The links themselves are `Markup.sharedLinks`. And how a sticker shows in a chat.

extension Attachment {
    /// Which list an attachment goes in. A picture with no size can't be laid out, so it's a file.
    public var mediaKind: MediaKind {
        if mime.hasPrefix("image/"), let width, width != 0 { return .photo }
        if voice == true { return .voice }
        if mime.hasPrefix("video/") { return .video }
        if mime.hasPrefix("audio/") { return .audio }
        return .file
    }

    /// The size a sticker shows at, as Telegram's apps and the desktop's `sticker` in
    /// `ui/message/media.rs` show one: its longer side 160 points, keeping its shape. One that
    /// says no size is square.
    public var stickerSize: CGSize {
        let width = max(1, width ?? 512), height = max(1, height ?? 512)
        let scale = min(160 / width, 160 / height)
        return CGSize(width: width * scale, height: height * scale)
    }
}

extension MessageView {
    /// A Telegram sticker, or a custom emoji sent alone, which is all the message is: shown on its
    /// own, without a bubble, as the desktop's `only_sticker` in `ui/message/mod.rs`. One answering
    /// or forwarding something keeps its bubble, for what it says of that.
    public var loneSticker: Attachment? {
        guard text.isEmpty, attachments.count == 1, let sticker = attachments.first, sticker.sticker == true, sticker.mime.hasPrefix("image/"),
              reply == nil, forwarded == nil, deletedAt == nil, status != .undecryptable, status != .unverified, status != .invalid
        else { return nil }
        return sticker
    }
}

/// The site a link really goes to, to show beside whatever its preview claims.
public func linkHost(_ link: String) -> String {
    guard let host = URL(string: link)?.host()?.lowercased() else { return "" }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}
