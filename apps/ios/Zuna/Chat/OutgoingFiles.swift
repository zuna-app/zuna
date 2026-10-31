import AVFoundation
import CoreTransferable
import ImageIO
import UIKit
import UniformTypeIdentifiers
import ZunaModels

/// A file picked to send, staged in the app's protected cache until it's sent.
struct StagedFile: Identifiable, Equatable {
    let id = UUID()
    var file: OutgoingFile
    var size: Int
}

/// Prepares files for a message the way the desktop does (lib/media.ts): a copy
/// the core reads from, the picture's size, a tiny blurred preview, and a
/// recording's length. Pictures in formats the desktop can't show become JPEG.
enum OutgoingFiles {
    /// Up to ten files go in one message, as on the desktop.
    static let limit = 10

    static var folder: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("outgoing", isDirectory: true)
    }

    /// Copies a file into the staging folder and reads what a message records about it.
    static func stage(_ source: URL, name: String? = nil) throws -> StagedFile {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let originalName = name ?? source.lastPathComponent
        let type = UTType(filenameExtension: source.pathExtension) ?? .data
        var target = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(source.pathExtension)
        var fileName = originalName
        var mime = type.preferredMIMEType ?? "application/octet-stream"

        if type.conforms(to: .image), !webImageTypes.contains(where: type.conforms(to:)) {
            // HEIC and the like: Chromium on the desktop can't show them.
            target = target.deletingPathExtension().appendingPathExtension("jpg")
            guard let image = UIImage(contentsOfFile: source.path), let jpeg = image.jpegData(compressionQuality: 0.9) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            try jpeg.write(to: target, options: .completeFileProtection)
            fileName = (originalName as NSString).deletingPathExtension + ".jpg"
            mime = "image/jpeg"
        } else {
            try fileManager.copyItem(at: source, to: target)
        }

        var file = OutgoingFile(blob: WireFile(path: target.path, type: mime), name: fileName, mime: mime)
        if mime.hasPrefix("image/"), let details = imageDetails(target) {
            file.width = details.width
            file.height = details.height
            file.thumb = details.thumb
        }
        let size = (try? fileManager.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
        return StagedFile(file: file, size: size)
    }

    /// A recording's length, which a message shows on its card.
    static func withDuration(_ staged: StagedFile) async -> StagedFile {
        guard staged.file.mime.hasPrefix("video/") || staged.file.mime.hasPrefix("audio/") else { return staged }
        var staged = staged
        let asset = AVURLAsset(url: URL(fileURLWithPath: staged.file.blob.path))
        if let duration = try? await asset.load(.duration), duration.isNumeric {
            staged.file.duration = duration.seconds
        }
        if staged.file.mime.hasPrefix("video/"), let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (size, transform) = try? await track.load(.naturalSize, .preferredTransform) {
            let shown = size.applying(transform)
            staged.file.width = Int(abs(shown.width))
            staged.file.height = Int(abs(shown.height))
        }
        return staged
    }

    static func discard(_ staged: StagedFile) {
        try? FileManager.default.removeItem(atPath: staged.file.blob.path)
    }

    private static let webImageTypes: [UTType] = [.jpeg, .png, .gif, .webP]

    /// The picture's size as shown, and a preview at most 48 pixels across, as a JPEG data URL like the desktop's.
    private static func imageDetails(_ url: URL) -> (width: Int, height: Int, thumb: String?)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let orientation = properties[kCGImagePropertyOrientation] as? UInt32 ?? 1
        let rotated = orientation >= 5 && orientation <= 8
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 48,
        ]
        let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
            .flatMap { UIImage(cgImage: $0).jpegData(compressionQuality: 0.5) }
            .map { "data:image/jpeg;base64," + $0.base64EncodedString() }
        return (rotated ? height : width, rotated ? width : height, thumb)
    }
}

/// A photo or video from the photo picker, received as a file.
struct PickedMedia: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            try PickedMedia(url: copy(received.file))
        }
        FileRepresentation(importedContentType: .image) { received in
            try PickedMedia(url: copy(received.file))
        }
    }

    /// The picker's file only lasts until this returns.
    private static func copy(_ file: URL) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(file.lastPathComponent)
        try FileManager.default.copyItem(at: file, to: target)
        return target
    }
}
