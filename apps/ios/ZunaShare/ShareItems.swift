import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers
import ZunaModels

/// What another app shared: files, staged in the share's folder in the App
/// Group as the composer stages them, and text, such as a link from Safari.
struct SharedItems: Sendable {
    var files: [StagedFile] = []
    var text = ""
    /// Small pictures of the files, for the sheet to show what's being sent.
    var previews: [Preview] = []

    struct Preview: Identifiable, Sendable {
        let id = UUID()
        let image: UIImage?
        let isVideo: Bool
    }

    /// Reads every item, in the order given. Files the system won't hand over are left out.
    static func load(_ items: [NSExtensionItem], into folder: URL) async -> SharedItems {
        var shared = SharedItems()
        var texts: [String] = []
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            switch await read(provider, into: folder) {
            case let .file(staged):
                shared.files.append(staged)
                shared.previews.append(Preview(image: preview(of: staged.file), isVideo: staged.file.mime.hasPrefix("video/")))
            case let .text(text):
                if !texts.contains(text) { texts.append(text) }
            case nil:
                break
            }
        }
        shared.text = texts.joined(separator: "\n")
        return shared
    }

    private enum Read {
        case file(StagedFile)
        case text(String)
    }

    private static func read(_ provider: NSItemProvider, into folder: URL) async -> Read? {
        let has = { (type: UTType) in provider.hasItemConformingToTypeIdentifier(type.identifier) }
        if has(.movie) { return await file(provider, as: .movie, into: folder) }
        if has(.image) {
            // Photos offers a JPEG beside HEIC, converted in its own process, which saves this one the memory.
            let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
            let jpeg = types.contains { $0.conforms(to: .heic) || $0.conforms(to: .heif) } && types.contains(.jpeg)
            return await file(provider, as: jpeg ? .jpeg : .image, into: folder)
        }
        if has(.fileURL) { return await file(provider, as: .item, into: folder) }
        if has(.url), let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
            return .text(url.absoluteString)
        }
        if has(.plainText), let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
            return .text(text)
        }
        if let type = provider.registeredTypeIdentifiers.compactMap(UTType.init).first(where: { $0.conforms(to: .data) }) {
            return await file(provider, as: type, into: folder)
        }
        return nil
    }

    /// The provider's file, copied while it lasts, then staged as the composer would.
    private static func file(_ provider: NSItemProvider, as type: UTType, into folder: URL) async -> Read? {
        let incoming = folder.appendingPathComponent("incoming", isDirectory: true)
        let suggested = provider.suggestedName
        let copy: (URL, String)? = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else {
                    continuation.resume(returning: nil)
                    return
                }
                let ext = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : url.pathExtension
                var name = suggested ?? url.deletingPathExtension().lastPathComponent
                if !ext.isEmpty, (name as NSString).pathExtension.lowercased() != ext.lowercased() { name += ".\(ext)" }
                let target = incoming.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
                do {
                    try FileManager.default.createDirectory(at: incoming, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: url, to: target)
                    continuation.resume(returning: (target, name))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
        guard let (source, name) = copy else { return nil }
        defer { try? FileManager.default.removeItem(at: source) }
        guard let staged = try? OutgoingFiles.stage(source, name: name, into: folder) else { return nil }
        // The app may send it, and go on doing so after the phone locks.
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: staged.file.blob.path)
        return .file(await OutgoingFiles.withDuration(staged))
    }

    private static func preview(of file: OutgoingFile) -> UIImage? {
        if file.mime.hasPrefix("image/"),
           let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: file.blob.path) as CFURL, nil),
           let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
               kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceCreateThumbnailWithTransform: true,
               kCGImageSourceThumbnailMaxPixelSize: 240,
           ] as CFDictionary) {
            return UIImage(cgImage: image)
        }
        // A video's frame, which staging already took.
        guard let thumb = file.thumb, let comma = thumb.firstIndex(of: ","), let data = Data(base64Encoded: String(thumb[thumb.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}
