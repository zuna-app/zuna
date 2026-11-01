import Foundation

// What a message holds, for the lists in a chat's details: the Swift twin of
// packages/core/src/media.ts and of `linkHost` in packages/core/src/links.ts.
// The links themselves are `Markup.sharedLinks`.

extension Attachment {
    /// Which list an attachment goes in. A picture with no size can't be laid out, so it's a file.
    public var mediaKind: MediaKind {
        if mime.hasPrefix("image/"), let width, width != 0 { return .photo }
        if voice == true { return .voice }
        if mime.hasPrefix("video/") { return .video }
        if mime.hasPrefix("audio/") { return .audio }
        return .file
    }
}

/// The site a link really goes to, to show beside whatever its preview claims.
public func linkHost(_ link: String) -> String {
    guard let host = URL(string: link)?.host()?.lowercased() else { return "" }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}
