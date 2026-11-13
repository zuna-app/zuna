
import AVFoundation
import SwiftUI
import UIKit
import ZunaHost
import ZunaModels

extension AvatarRef {
    /// What a decrypted picture is kept by while the app runs: its file and the key it opens with. A
    /// message elsewhere can name the same file with any key, and must never be shown this one's copy.
    var cacheId: String { "\(fileId)\n\(key)\n\(prefix)" }
}

extension Attachment {
    /// The same, for a file a message carries.
    var cacheId: String { "\(fileId)\n\(key)\n\(prefix)" }
}

/// Decrypted avatars and server icons, kept in memory while the app runs.
@MainActor
@Observable
final class ImageStore {
    @ObservationIgnored private let cache = NSCache<NSString, UIImage>()
    @ObservationIgnored private var loading: [String: Task<UIImage?, Never>] = [:]
    /// Pictures kept at their own size, as they were no bigger than asked for: one of
    /// these is never too small, however large it's shown.
    @ObservationIgnored private var whole: Set<String> = []
    @ObservationIgnored private let core: CoreConnection
    /// Files decrypted while the app runs, by file ID, so a video's frame, playing it and Share
    /// use one download. They're in the core's decrypted cache, which is emptied as the app starts.
    @ObservationIgnored private var decryptedFiles: [String: URL] = [:]
    @ObservationIgnored private var decrypting: [String: Task<URL, Error>] = [:]
    /// Videos playing as they come, by file ID: kept, as their assets only hold them weakly.
    @ObservationIgnored private var videoStreams: [String: VideoStream] = [:]
    /// Bumped when a server's icon changes, so the views showing it load it again.
    private(set) var iconVersion = 0

    init(core: CoreConnection) {
        self.core = core
    }

    func cached(_ key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    /// A person's or group's avatar, decrypted by the core.
    func avatar(_ avatar: AvatarRef, serverId: String, size: CGFloat) async -> UIImage? {
        await load(avatar.cacheId, size: size) { [core] in
            let file = try await core.session(serverId).downloadFile(avatar)
            return try Data(contentsOf: URL(fileURLWithPath: file.path))
        }
    }

    /// A picture sent in a message, decrypted by the core.
    func attachment(_ attachment: Attachment, serverId: String, size: CGFloat) async -> UIImage? {
        await load("file:\(attachment.cacheId)", size: size) { [self] in
            try Data(contentsOf: try await decrypted(attachment, serverId: serverId))
        }
    }

    /// A frame from a video sent in a message, taken once the core has decrypted it.
    func videoFrame(_ attachment: Attachment, serverId: String, size: CGFloat) async -> UIImage? {
        await load("frame:\(attachment.cacheId)", size: size) { [self] in
            let file = try await decrypted(attachment, serverId: serverId)
            let asset = AVURLAsset(url: file, options: [AVURLAssetOverrideMIMETypeKey: attachment.mime])
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 720, height: 720)
            // A moment in, since many videos start on a black frame.
            let at = min(0.5, (attachment.duration ?? 1) / 3)
            let (frame, _) = try await generator.image(at: CMTime(seconds: at, preferredTimescale: 600))
            return UIImage(cgImage: frame).jpegData(compressionQuality: 0.85)
        }
    }

    func cachedVideoFrame(_ attachment: Attachment) -> UIImage? {
        attachment.fileId.isEmpty ? nil : cached("frame:\(attachment.cacheId)")
    }

    /// The decrypted file under its own name, for QuickLook and the share sheet.
    func openable(_ attachment: Attachment, serverId: String) async throws -> URL {
        let file = try await decrypted(attachment, serverId: serverId)
        let folder = file.deletingLastPathComponent()
            .appendingPathComponent("open", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safeName = attachment.name.replacingOccurrences(of: "/", with: "_")
        let target = folder.appendingPathComponent(safeName.isEmpty ? file.lastPathComponent : safeName)
        try FileManager.default.linkItem(at: file, to: target)
        return target
    }

    /// All of a file, decrypted, once while the app runs: a video playing as it comes gives it once it has all come.
    private func decrypted(_ attachment: Attachment, serverId: String) async throws -> URL {
        let id = attachment.cacheId
        if let file = decryptedFiles[id], FileManager.default.fileExists(atPath: file.path) { return file }
        if let task = decrypting[id] { return try await task.value }
        let task = Task { [core, stream = videoStreams[id]] in
            if let stream { return try await stream.whole() }
            return URL(fileURLWithPath: try await core.session(serverId).downloadFile(attachment).path)
        }
        decrypting[id] = task
        defer { decrypting[id] = nil }
        let file = try await task.value
        decryptedFiles[id] = file
        return file
    }

    /// A video to play at once: from its file once all of it is here, otherwise as it comes, a few
    /// chunks ahead of where it plays. Nil for one that can't play as it comes, which plays once it's all here.
    func videoAsset(_ attachment: Attachment, serverId: String) -> AVURLAsset? {
        if let file = decryptedFiles[attachment.cacheId] { return AVURLAsset(url: file, options: [AVURLAssetOverrideMIMETypeKey: attachment.mime]) }
        if let stream = videoStreams[attachment.cacheId] { return stream.asset() }
        guard let stream = VideoStream(attachment, session: core.session(serverId)) else { return nil }
        videoStreams[attachment.cacheId] = stream
        return stream.asset()
    }

    /// Done with a video for now: what AVPlayer isn't waiting for stops coming.
    func stopFetching(_ attachment: Attachment) {
        videoStreams[attachment.cacheId]?.pause()
    }

    /// After an admin changes the server's picture, the next look fetches it again.
    func forgetServerIcon(_ entry: ServerEntry) {
        cache.removeObject(forKey: "icon:\(entry.url)" as NSString)
        iconVersion += 1
    }

    func cachedAttachment(_ attachment: Attachment) -> UIImage? {
        cached("file:\(attachment.cacheId)")
    }

    /// The small blurred preview a message carries, as a data URL.
    static func thumbnail(_ dataURL: String) -> UIImage? {
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }

    /// A server's icon, which servers serve in the clear.
    func serverIcon(url serverUrl: String, size: CGFloat) async -> UIImage? {
        await load("icon:\(serverUrl)", size: size) {
            guard let url = URL(string: "\(serverUrl)/api/icon") else { return nil }
            let (data, response) = try await PinnedServers.shared.session.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200 ? data : nil
        }
    }

    private func load(_ key: String, size: CGFloat, fetch: @escaping @Sendable () async throws -> Data?) async -> UIImage? {
        let scale = UITraitCollection.current.displayScale
        // Twice the size on screen is plenty, and keeps big pictures out of memory.
        let wanted = size * scale * 2
        // One shrunk for a smaller place, as a list's row, is loaded again for a larger one,
        // as a profile, rather than shown blurred.
        if let image = cached(key), whole.contains(key) || min(image.size.width, image.size.height) * image.scale >= wanted * 0.95 {
            return image
        }
        if let task = loading[key] { return await task.value }
        let task = Task<UIImage?, Never> {
            guard let data = try? await fetch(), let image = UIImage(data: data) else { return nil }
            let factor = wanted / min(image.size.width, image.size.height)
            guard factor < 1 else { return image }
            let target = CGSize(width: image.size.width * factor, height: image.size.height * factor)
            return await image.byPreparingThumbnail(ofSize: target) ?? image
        }
        loading[key] = task
        let image = await task.value
        loading[key] = nil
        if let image {
            cache.setObject(image, forKey: key as NSString)
            if min(image.size.width, image.size.height) * image.scale < wanted * 0.95 { whole.insert(key) } else { whole.remove(key) }
        }
        return image
    }
}

/// A round avatar, or a rounded square for servers: the picture once it's
/// decrypted, otherwise initials on a color picked from the seed, as on the desktop.
struct AvatarView: View {
    enum Source: Equatable {
        case none
        case avatar(AvatarRef, serverId: String)
        case serverIcon(ServerEntry)
        /// A server not joined yet, from an invite's preview.
        case serverAt(url: String, hasIcon: Bool)
    }

    let name: String
    let seed: String
    var source: Source = .none
    var size: CGFloat = 44
    var rounded = false
    var online = false

    @Environment(ImageStore.self) private var images: ImageStore?
    @State private var image: UIImage?

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: rounded ? size * 0.28 : size / 2, style: .continuous)
        ZStack {
            if let image = image ?? cachedImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Theme.avatarColor(seed)
                Text(Format.initials(name))
                    .font(.system(size: size * 0.38, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(alignment: .bottomTrailing) {
            if online {
                Circle()
                    .fill(Theme.green)
                    .frame(width: size * 0.28, height: size * 0.28)
                    .overlay(Circle().stroke(Theme.bg0, lineWidth: max(2, size * 0.05)))
                    .offset(x: -size * 0.02, y: -size * 0.02)
            }
        }
        .accessibilityHidden(true)
        .task(id: SourceKey(source: source, version: images?.iconVersion ?? 0)) {
            image = await load()
        }
    }

    private struct SourceKey: Equatable {
        let source: Source
        let version: Int
    }

    private var cacheKey: String? {
        switch source {
        case .none: nil
        case let .avatar(avatar, _): avatar.cacheId
        case let .serverIcon(entry): "icon:\(entry.url)"
        case let .serverAt(url, _): "icon:\(url)"
        }
    }

    private var cachedImage: UIImage? {
        cacheKey.flatMap { images?.cached($0) }
    }

    private func load() async -> UIImage? {
        guard let images else { return nil }
        switch source {
        case .none: return nil
        case let .avatar(avatar, serverId): return await images.avatar(avatar, serverId: serverId, size: size)
        case let .serverIcon(entry): return entry.hasIcon ? await images.serverIcon(url: entry.url, size: size) : nil
        case let .serverAt(url, hasIcon): return hasIcon ? await images.serverIcon(url: url, size: size) : nil
        }
    }
}
