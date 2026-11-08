import ImageIO
import UIKit
import ZunaHost
import ZunaModels

/// 7TV emotes, which each Zuna server serves and caches for its members
/// (`/api/emotes/<id>/<1x|2x|3x>.webp`), decoded with their animation.
/// The pictures come from disk, where each server's set is fetched ahead (EmoteFiles).
@MainActor
final class EmoteImages {
    enum Size: String {
        /// Reactions.
        case small = "1x"
        /// Inline in text.
        case inline = "2x"
        /// Large-emoji messages and the emote card.
        case large = "3x"
    }

    static let shared = EmoteImages()

    private let cache = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]
    /// Emotes that failed to load, and when: they show their name instead, as on the desktop, and
    /// are tried again a minute later, so a moment without the network doesn't last the whole run.
    private var failed: [String: Date] = [:]
    private static let retryAfter: TimeInterval = 60

    private func failedRecently(_ key: String) -> Bool {
        guard let at = failed[key] else { return false }
        if Date().timeIntervalSince(at) < Self.retryAfter { return true }
        failed[key] = nil
        return false
    }
    /// By server address: fetching its set ahead.
    private var prefetching: [String: Task<Void, Never>] = [:]

    /// A server's whole set onto disk in the background, so showing any of it asks the
    /// server for nothing, as the desktop's prefetchEmotes does. A newer set takes over.
    func prefetch(_ emotes: [Emote], serverUrl: String) {
        prefetching[serverUrl]?.cancel()
        let ids = emotes.map(\.id)
        prefetching[serverUrl] = Task.detached(priority: .background) {
            await EmoteFiles.shared.prefetch(ids, serverUrl: serverUrl)
        }
    }

    func cached(_ id: String, _ size: Size) -> UIImage? {
        cache.object(forKey: "\(id)/\(size.rawValue)" as NSString)
    }

    func hasFailed(_ id: String, _ size: Size) -> Bool {
        failedRecently("\(id)/\(size.rawValue)")
    }

    func image(_ id: String, _ size: Size, serverUrl: String) async -> UIImage? {
        let key = "\(id)/\(size.rawValue)"
        if let image = cache.object(forKey: key as NSString) { return image }
        if failedRecently(key) { return nil }
        if let task = loading[key] { return await task.value }
        let task = Task<UIImage?, Never>.detached(priority: .userInitiated) {
            guard let data = await EmoteFiles.shared.data(id, size.rawValue, serverUrl: serverUrl) else { return nil }
            return Self.decode(data)
        }
        loading[key] = task
        let image = await task.value
        loading[key] = nil
        if let image {
            cache.setObject(image, forKey: key as NSString)
        } else {
            failed[key] = Date()
        }
        return image
    }

    /// A still or animated image. UIKit plays animations at a fixed rate, so
    /// frames that show longer are repeated to keep each frame's own timing.
    nonisolated static func decode(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1 else {
            return CGImageSourceCreateImageAtIndex(source, 0, nil).map { UIImage(cgImage: $0) }
        }
        var frames: [(image: UIImage, delay: Double)] = []
        for index in 0..<count {
            guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
            frames.append((UIImage(cgImage: image), delay(source, index)))
        }
        guard !frames.isEmpty else { return nil }
        let tick = max(0.02, frames.map(\.delay).min() ?? 0.1)
        var sequence: [UIImage] = []
        for frame in frames {
            let repeats = min(50, max(1, Int((frame.delay / tick).rounded())))
            sequence += Array(repeating: frame.image, count: repeats)
        }
        return UIImage.animatedImage(with: sequence, duration: Double(sequence.count) * tick)
    }

    /// How long a frame shows, as browsers read it: very short delays mean 0.1 seconds.
    private nonisolated static func delay(_ source: CGImageSource, _ index: Int) -> Double {
        let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
        let webp = properties?[kCGImagePropertyWebPDictionary] as? [CFString: Any]
        let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let value = (webp?[kCGImagePropertyWebPUnclampedDelayTime] ?? webp?[kCGImagePropertyWebPDelayTime]
            ?? gif?[kCGImagePropertyGIFUnclampedDelayTime] ?? gif?[kCGImagePropertyGIFDelayTime]) as? Double ?? 0.1
        return value < 0.011 ? 0.1 : value
    }
}

/// An emote's image, playing its animation. Shows the emote's name if it can't load.
final class EmoteImageView: UIView {
    private let imageView = UIImageView()
    private let fallback = UILabel()
    private var loadTask: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFit
        imageView.frame = bounds
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(imageView)
        fallback.textColor = UIColor(Theme.text2)
        fallback.adjustsFontSizeToFitWidth = true
        fallback.minimumScaleFactor = 0.5
        fallback.frame = bounds
        fallback.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        fallback.isHidden = true
        addSubview(fallback)
        isAccessibilityElement = true
        accessibilityTraits = .image
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        loadTask?.cancel()
    }

    func show(name: String, id: String, size: EmoteImages.Size, serverUrl: String) {
        accessibilityLabel = name
        fallback.text = name
        // A view used again for another emote: a load still going for the last one mustn't land
        // over this, nor its name stay showing.
        loadTask?.cancel()
        loadTask = nil
        fallback.isHidden = true
        let images = EmoteImages.shared
        if let image = images.cached(id, size) {
            imageView.image = image
            return
        }
        imageView.image = nil
        loadTask = Task { [weak self] in
            let image = await images.image(id, size, serverUrl: serverUrl)
            guard let self, !Task.isCancelled else { return }
            imageView.image = image
            fallback.isHidden = image != nil
        }
    }
}
