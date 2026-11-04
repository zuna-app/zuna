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

    /// Copies a file into the staging folder, or `destination`, and reads what a message records about it.
    static func stage(_ source: URL, name: String? = nil, into destination: URL? = nil) throws -> StagedFile {
        let fileManager = FileManager.default
        let folder = destination ?? folder
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

    /// A recording's length, and a video's size and picture, which a message shows.
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
            staged.file.thumb = await poster(asset, duration: staged.file.duration)
        }
        return staged
    }

    /// How big a video's picture is, the frame shown before it loads, from the sharpest
    /// down, as on the desktop. It travels inside the message, which takes at most 22 KB of it.
    private static let posterSteps: [(size: CGFloat, quality: CGFloat)] = [(320, 0.65), (240, 0.55), (160, 0.5)]
    private static let posterLength = 22 << 10

    /// A frame a moment in, since many videos start on a black one, as a JPEG data URL.
    private static func poster(_ asset: AVURLAsset, duration: Double?) async -> String? {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        guard let (frame, _) = try? await generator.image(at: CMTime(seconds: min(0.5, (duration ?? 1) / 3), preferredTimescale: 600)) else { return nil }
        let image = UIImage(cgImage: frame)
        for step in posterSteps {
            let scale = min(1, step.size / max(image.size.width, image.size.height))
            let size = CGSize(width: max(1, (image.size.width * scale).rounded()), height: max(1, (image.size.height * scale).rounded()))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = scaled.jpegData(compressionQuality: step.quality) else { continue }
            let poster = "data:image/jpeg;base64," + jpeg.base64EncodedString()
            if poster.count <= posterLength { return poster }
        }
        return nil
    }

    /// A square picture for a group or profile, as the desktop's prepareAvatar: 256 pixels, WebP where the system can write it.
    static func avatar(from source: URL, size: Int = 256) throws -> WireFile {
        guard let image = UIImage(contentsOfFile: source.path)?.cgImageOriented() else { throw CocoaError(.fileReadCorruptFile) }
        let side = min(image.width, image.height)
        let crop = CGRect(x: (image.width - side) / 2, y: (image.height - side) / 2, width: side, height: side)
        guard let square = image.cropping(to: crop),
              let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        context.interpolationQuality = .high
        context.draw(square, in: CGRect(x: 0, y: 0, width: size, height: size))
        guard let scaled = context.makeImage() else { throw CocoaError(.fileReadCorruptFile) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        for (type, mime, ext) in [(UTType.webP, "image/webp", "webp"), (UTType.jpeg, "image/jpeg", "jpg")] {
            let target = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
            guard let destination = CGImageDestinationCreateWithURL(target as CFURL, type.identifier as CFString, 1, nil) else { continue }
            CGImageDestinationAddImage(destination, scaled, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
            if CGImageDestinationFinalize(destination) { return WireFile(path: target.path, type: mime) }
        }
        throw CocoaError(.fileWriteUnknown)
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

/// Any file dragged onto a chat on an iPad.
struct DroppedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = folder.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: target)
            return DroppedFile(url: target)
        }
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

private extension UIImage {
    /// The bitmap turned the way the picture is meant to be seen.
    func cgImageOriented() -> CGImage? {
        guard imageOrientation != .up else { return cgImage }
        return UIGraphicsImageRenderer(size: size, format: { let format = UIGraphicsImageRendererFormat(); format.scale = 1; return format }()).image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }.cgImage
    }
}
