import SwiftUI
import UIKit
import ZunaModels

/// Decrypted avatars and server icons, kept in memory while the app runs.
@MainActor
@Observable
final class ImageStore {
    @ObservationIgnored private let cache = NSCache<NSString, UIImage>()
    @ObservationIgnored private var loading: [String: Task<UIImage?, Never>] = [:]
    @ObservationIgnored private let core: CoreConnection

    init(core: CoreConnection) {
        self.core = core
    }

    func cached(_ key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    /// A person's or group's avatar, decrypted by the core.
    func avatar(_ avatar: AvatarRef, serverId: String, size: CGFloat) async -> UIImage? {
        await load(avatar.fileId, size: size) { [core] in
            let file = try await core.session(serverId).downloadFile(avatar)
            return try Data(contentsOf: URL(fileURLWithPath: file.path))
        }
    }

    /// A picture sent in a message, decrypted by the core.
    func attachment(_ attachment: Attachment, serverId: String, size: CGFloat) async -> UIImage? {
        await load("file:\(attachment.fileId)", size: size) { [core] in
            let file = try await core.session(serverId).downloadFile(attachment)
            return try Data(contentsOf: URL(fileURLWithPath: file.path))
        }
    }

    /// The decrypted file under its own name, for QuickLook and the share sheet.
    func openable(_ attachment: Attachment, serverId: String) async throws -> URL {
        let file = try await core.session(serverId).downloadFile(attachment)
        let folder = URL(fileURLWithPath: file.path).deletingLastPathComponent()
            .appendingPathComponent("open", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safeName = attachment.name.replacingOccurrences(of: "/", with: "_")
        let target = folder.appendingPathComponent(safeName.isEmpty ? URL(fileURLWithPath: file.path).lastPathComponent : safeName)
        try FileManager.default.linkItem(at: URL(fileURLWithPath: file.path), to: target)
        return target
    }

    func cachedAttachment(_ attachment: Attachment) -> UIImage? {
        cached("file:\(attachment.fileId)")
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
            let (data, response) = try await URLSession.shared.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200 ? data : nil
        }
    }

    private func load(_ key: String, size: CGFloat, fetch: @escaping @Sendable () async throws -> Data?) async -> UIImage? {
        if let image = cached(key) { return image }
        if let task = loading[key] { return await task.value }
        let scale = UITraitCollection.current.displayScale
        let task = Task<UIImage?, Never> {
            guard let data = try? await fetch(), let image = UIImage(data: data) else { return nil }
            // Twice the size on screen is plenty, and keeps big pictures out of memory.
            let factor = size * scale * 2 / min(image.size.width, image.size.height)
            guard factor < 1 else { return image }
            let target = CGSize(width: image.size.width * factor, height: image.size.height * factor)
            return await image.byPreparingThumbnail(ofSize: target) ?? image
        }
        loading[key] = task
        let image = await task.value
        loading[key] = nil
        if let image { cache.setObject(image, forKey: key as NSString) }
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
        .task(id: source) {
            image = await load()
        }
    }

    private var cacheKey: String? {
        switch source {
        case .none: nil
        case let .avatar(avatar, _): avatar.fileId
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
