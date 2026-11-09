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

    private let cache = NSCache<NSString, EmotePicture>()
    private var loading: [String: Task<EmotePicture?, Never>] = [:]
    /// When each animated emote's loop began, by ID. Every view showing it plays from that one
    /// moment, at any size, so copies move together, as a browser plays them, and one back in
    /// view carries on where the others are.
    private var clocks: [String: CFTimeInterval] = [:]

    /// When an emote's loop began, which is now the first time it's shown.
    func clock(_ id: String) -> CFTimeInterval {
        if let start = clocks[id] { return start }
        let start = CACurrentMediaTime()
        clocks[id] = start
        return start
    }
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

    func cached(_ id: String, _ size: Size) -> EmotePicture? {
        cache.object(forKey: "\(id)/\(size.rawValue)" as NSString)
    }

    func hasFailed(_ id: String, _ size: Size) -> Bool {
        failedRecently("\(id)/\(size.rawValue)")
    }

    func picture(_ id: String, _ size: Size, serverUrl: String) async -> EmotePicture? {
        let key = "\(id)/\(size.rawValue)"
        if let picture = cache.object(forKey: key as NSString) { return picture }
        if failedRecently(key) { return nil }
        if let task = loading[key] { return await task.value }
        let task = Task<EmotePicture?, Never>.detached(priority: .userInitiated) {
            guard let data = await EmoteFiles.shared.data(id, size.rawValue, serverUrl: serverUrl) else { return nil }
            return Self.decode(data)
        }
        loading[key] = task
        let picture = await task.value
        loading[key] = nil
        if let picture {
            cache.setObject(picture, forKey: key as NSString)
        } else {
            failed[key] = Date()
        }
        return picture
    }

    /// A still or animated picture, decoded here rather than as the main thread first draws it.
    nonisolated static func decode(_ data: Data) -> EmotePicture? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        var frames: [CGImage] = []
        var delays: [Double] = []
        for index in 0..<CGImageSourceGetCount(source) {
            guard let image = CGImageSourceCreateImageAtIndex(source, index, options) else { continue }
            frames.append(image)
            delays.append(delay(source, index))
        }
        guard !frames.isEmpty else { return nil }
        return EmotePicture(frames: frames, delays: delays)
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

/// An emote's frames, with each one's own time in the loop, which Core Animation plays as they
/// are rather than rounded to one rate, as `UIImage.animatedImage` would.
final class EmotePicture: @unchecked Sendable {
    /// The first frame, and the only one of a still emote.
    let still: UIImage
    let frames: [CGImage]
    /// Where each frame starts in the loop, from 0, and 1 for its end.
    let keyTimes: [NSNumber]
    let duration: CFTimeInterval

    init(frames: [CGImage], delays: [Double]) {
        still = UIImage(cgImage: frames[0])
        self.frames = frames
        duration = delays.reduce(0, +)
        var start = 0.0
        var keyTimes: [NSNumber] = [0]
        for delay in delays.dropLast() {
            start += delay
            keyTimes.append(NSNumber(value: start / duration))
        }
        self.keyTimes = keyTimes + [1]
    }

    var animated: Bool { frames.count > 1 }
}

/// An emote's image, playing its animation on the emote's own clock. Shows the emote's name if it
/// can't load.
final class EmoteImageView: UIView {
    private static let animationKey = "emote"
    private let imageView = UIImageView()
    private let fallback = UILabel()
    private var loadTask: Task<Void, Never>?
    /// The picture showing, by its ID and size, so a view shown the same again keeps playing.
    private var showing: String?

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
        let key = "\(id)/\(size.rawValue)"
        if showing == key { return }
        // A view used again for another emote: a load still going for the last one mustn't land
        // over this, nor its name stay showing.
        loadTask?.cancel()
        loadTask = nil
        fallback.isHidden = true
        let images = EmoteImages.shared
        if let picture = images.cached(id, size) {
            play(picture, key: key, id: id)
            return
        }
        play(nil, key: nil, id: id)
        loadTask = Task { [weak self] in
            let picture = await images.picture(id, size, serverUrl: serverUrl)
            guard let self, !Task.isCancelled else { return }
            play(picture, key: picture == nil ? nil : key, id: id)
            fallback.isHidden = picture != nil
        }
    }

    /// Shows a picture, and plays an animated one from where its clock is now, which every other
    /// view showing the emote shares.
    private func play(_ picture: EmotePicture?, key: String?, id: String) {
        showing = key
        imageView.layer.removeAnimation(forKey: Self.animationKey)
        imageView.image = picture?.still
        guard let picture, picture.animated else { return }
        let animation = CAKeyframeAnimation(keyPath: "contents")
        animation.values = picture.frames
        animation.keyTimes = picture.keyTimes
        animation.calculationMode = .discrete
        animation.duration = picture.duration
        animation.repeatCount = .infinity
        animation.beginTime = imageView.layer.convertTime(EmoteImages.shared.clock(id), from: nil)
        // Kept through the app going to the background and back.
        animation.isRemovedOnCompletion = false
        imageView.layer.add(animation, forKey: Self.animationKey)
    }
}
