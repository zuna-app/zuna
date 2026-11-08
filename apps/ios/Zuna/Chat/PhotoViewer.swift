import ImageIO
import UIKit
import ZunaModels

/// A picture on the whole screen, as in Telegram: pinch or double tap to zoom,
/// drag it around once it's bigger than the screen, and drag it up or down to
/// close, the chat showing through as it goes. Above it, Close, who sent it and
/// when, and Share. A tap hides or shows them, the status bar and the shade behind them.
@MainActor
final class PhotoViewer: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    /// The decrypted file under its own name, for Share. Removed when the viewer closes.
    private let file: URL
    private var image: UIImage
    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    private let backdrop = UIView()
    private let shade = TopShade()
    private let closeButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)
    private let caption: Caption
    private let titleView = PhotoViewer.glass()
    private var chromeHidden = false

    /// Who sent the picture and when, between the buttons.
    struct Caption {
        var name: String
        var verified: Bool
        var date: String
    }

    /// Shows a decrypted picture over whatever is on screen. With `placeholder`, the copy its bubble
    /// already shows, it opens at once with that and turns sharp once the big copy is made; without,
    /// it opens once that's made. Making it from a big photo takes a moment, so it's made off the
    /// main thread either way.
    static func show(_ file: URL, caption: Caption, placeholder: UIImage? = nil) {
        if let placeholder, let top = topViewController() {
            let viewer = PhotoViewer(file: file, image: placeholder, caption: caption)
            present(viewer, over: top)
            Task {
                if let sharp = await downsampledAway(file) { viewer.replace(sharp) }
            }
            return
        }
        Task {
            guard let image = await downsampledAway(file), let top = topViewController() else {
                FilePreview.show(file)
                return
            }
            present(PhotoViewer(file: file, image: image, caption: caption), over: top)
        }
    }

    private static func present(_ viewer: PhotoViewer, over top: UIViewController) {
        viewer.modalPresentationStyle = .overFullScreen
        viewer.modalTransitionStyle = .crossDissolve
        top.present(viewer, animated: true)
    }

    /// Big photos are drawn at most this size, which is sharp on any screen and keeps memory in check.
    private static func downsampledAway(_ file: URL) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { downsampled(file, maxPixels: 4096) }.value
    }

    /// The sharp copy, in place of the one it opened with. It's the same picture, so it fits the same.
    private func replace(_ sharp: UIImage) {
        image = sharp
        imageView.image = sharp
        view.setNeedsLayout()
    }

    private init(file: URL, image: UIImage, caption: Caption) {
        self.file = file
        self.image = image
        self.caption = caption
        super.init(nibName: nil, bundle: nil)
        // The glass is the dark kind over the black, whatever the system's appearance.
        overrideUserInterfaceStyle = .dark
        // Over the whole screen the status bar stays the chat's unless the viewer takes it, so a tap couldn't hide it.
        modalPresentationCapturesStatusBarAppearance = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// The status bar goes with the buttons, as in Telegram, so a tap shows the whole picture, a screenshot's top too.
    override var prefersStatusBarHidden: Bool { chromeHidden }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .fade }
    override var prefersHomeIndicatorAutoHidden: Bool { chromeHidden }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.accessibilityIdentifier = A11y.Chat.photoViewer

        backdrop.backgroundColor = .black
        backdrop.frame = view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(backdrop)

        scrollView.frame = view.bounds
        scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scrollView.delegate = self
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.decelerationRate = .fast
        if #available(iOS 26.0, *) {
            // The system's blur at a scroll view's edges would smear a picture that reaches them, such as a phone's screenshot.
            for edge in [scrollView.topEdgeEffect, scrollView.bottomEdgeEffect, scrollView.leftEdgeEffect, scrollView.rightEdgeEffect] {
                edge.isHidden = true
            }
        }
        view.addSubview(scrollView)

        imageView.image = image
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = file.lastPathComponent
        imageView.accessibilityTraits = .image
        scrollView.addSubview(imageView)

        // As in Telegram, so the status bar and the buttons read over a bright picture.
        shade.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(shade)

        configure(closeButton, symbol: "xmark", label: "Close", action: #selector(close))
        configure(shareButton, symbol: "square.and.arrow.up", label: "Share", action: #selector(share))
        configureTitle()
        let centered = titleView.centerXAnchor.constraint(equalTo: view.centerXAnchor)
        centered.priority = .defaultHigh
        NSLayoutConstraint.activate([
            shade.topAnchor.constraint(equalTo: view.topAnchor),
            shade.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            shade.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            shade.bottomAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 32),
            closeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            shareButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            shareButton.topAnchor.constraint(equalTo: closeButton.topAnchor),
            centered,
            titleView.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            titleView.leadingAnchor.constraint(greaterThanOrEqualTo: closeButton.trailingAnchor, constant: 10),
            titleView.trailingAnchor.constraint(lessThanOrEqualTo: shareButton.leadingAnchor, constant: -10),
        ])

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleChrome))
        tap.require(toFail: doubleTap)
        scrollView.addGestureRecognizer(tap)
        let drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
        drag.delegate = self
        view.addGestureRecognizer(drag)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        fit()
    }

    // MARK: Zoom

    /// Fits the picture to the screen, and lets it zoom to its own size or three times the fitted size.
    private func fit() {
        let bounds = scrollView.bounds.size
        guard bounds.width > 0, image.size.width > 0, image.size.height > 0 else { return }
        let fitted = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let size = CGSize(width: image.size.width * fitted, height: image.size.height * fitted)
        // Each time, as the sharp copy that takes the place of the one it opened with goes further.
        scrollView.maximumZoomScale = max(3, 1 / fitted)
        guard imageView.bounds.size != size else { return }
        scrollView.zoomScale = 1
        imageView.frame = CGRect(origin: .zero, size: size)
        scrollView.contentSize = size
        scrollView.minimumZoomScale = 1
        center()
    }

    /// Keeps a picture smaller than the screen in the middle of it.
    private func center() {
        let bounds = scrollView.bounds.size
        let content = scrollView.contentSize
        scrollView.contentInset = UIEdgeInsets(
            top: max(0, (bounds.height - content.height) / 2),
            left: max(0, (bounds.width - content.width) / 2),
            bottom: 0,
            right: 0
        )
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { center() }

    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        if scrollView.zoomScale > scrollView.minimumZoomScale {
            scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
            return
        }
        let scale = min(scrollView.maximumZoomScale, 2.5)
        let point = gesture.location(in: imageView)
        let size = CGSize(width: scrollView.bounds.width / scale, height: scrollView.bounds.height / scale)
        scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }

    // MARK: Dragging to close

    /// Only a mostly vertical drag of the picture as it fits the screen closes it; zoomed in, a drag moves it.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let drag = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let velocity = drag.velocity(in: view)
        return scrollView.zoomScale <= scrollView.minimumZoomScale + 0.01 && abs(velocity.y) > abs(velocity.x)
    }

    /// The scroll view's own drag does nothing while the picture fits, so both can run.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other === scrollView.panGestureRecognizer
    }

    @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
        let travel = gesture.translation(in: view).y
        let progress = min(1, abs(travel) / (view.bounds.height / 2))
        switch gesture.state {
        case .began:
            setChrome(hidden: true)
        case .changed:
            scrollView.transform = CGAffineTransform(translationX: gesture.translation(in: view).x * 0.3, y: travel)
            backdrop.alpha = 1 - progress * 0.85
        case .ended, .cancelled:
            let velocity = gesture.velocity(in: view).y
            if gesture.state == .ended, abs(travel) > 100 || abs(velocity) > 900 {
                let direction: CGFloat = travel + velocity * 0.1 >= 0 ? 1 : -1
                UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseOut) {
                    self.scrollView.transform = CGAffineTransform(translationX: 0, y: direction * self.view.bounds.height)
                    self.backdrop.alpha = 0
                }
                // Animated as Close is, and while the picture goes, so a keyboard the chat had slides back up straight after.
                dismiss(animated: true) { self.cleanUp() }
            } else {
                UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
                    self.scrollView.transform = .identity
                    self.backdrop.alpha = 1
                }
                setChrome(hidden: false)
            }
        default:
            break
        }
    }

    // MARK: Buttons

    /// The height of the buttons and the title between them.
    private static let barHeight: CGFloat = 44

    /// A round button of glass, as Telegram's, or of a dark tint before iOS 26.
    private func configure(_ button: UIButton, symbol: String, label: String, action: Selector) {
        var configuration: UIButton.Configuration
        if #available(iOS 26.0, *) {
            configuration = .glass()
        } else {
            configuration = .plain()
            configuration.background.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        }
        configuration.cornerStyle = .capsule
        configuration.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        configuration.baseForegroundColor = .white
        button.configuration = configuration
        button.accessibilityLabel = label
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: Self.barHeight).isActive = true
        button.heightAnchor.constraint(equalToConstant: Self.barHeight).isActive = true
        button.addTarget(self, action: action, for: .primaryActionTriggered)
        view.addSubview(button)
    }

    /// The sender's name, with the badge when they're verified, over the date, in a capsule of glass.
    private func configureTitle() {
        let name = UILabel()
        name.text = caption.name
        name.font = .systemFont(ofSize: 15, weight: .semibold)
        name.textColor = .white
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let badge = UIImageView(image: UIImage(systemName: "checkmark.seal.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)))
        badge.tintColor = UIColor.white.withAlphaComponent(0.7)
        badge.isHidden = !caption.verified
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
        let nameRow = UIStackView(arrangedSubviews: [name, badge])
        nameRow.spacing = 4
        nameRow.alignment = .center
        let date = UILabel()
        date.text = caption.date
        date.font = .systemFont(ofSize: 12)
        date.textColor = UIColor.white.withAlphaComponent(0.7)
        date.lineBreakMode = .byTruncatingTail
        let stack = UIStackView(arrangedSubviews: [nameRow, date])
        stack.axis = .vertical
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        titleView.contentView.addSubview(stack)

        titleView.isAccessibilityElement = true
        titleView.accessibilityLabel = [caption.name, caption.verified ? "Verified" : nil, caption.date].compactMap { $0 }.joined(separator: ", ")
        titleView.accessibilityIdentifier = A11y.Chat.photoViewerTitle
        titleView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(titleView)
        NSLayoutConstraint.activate([
            titleView.heightAnchor.constraint(equalToConstant: Self.barHeight),
            stack.leadingAnchor.constraint(equalTo: titleView.contentView.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: titleView.contentView.trailingAnchor, constant: -16),
            stack.centerYAnchor.constraint(equalTo: titleView.contentView.centerYAnchor),
        ])
    }

    @objc private func toggleChrome() {
        setChrome(hidden: !chromeHidden)
    }

    private func setChrome(hidden: Bool) {
        chromeHidden = hidden
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        UIView.animate(withDuration: 0.2) {
            self.setNeedsStatusBarAppearanceUpdate()
            self.shade.alpha = hidden ? 0 : 1
            self.closeButton.alpha = hidden ? 0 : 1
            self.titleView.alpha = hidden ? 0 : 1
            self.shareButton.alpha = hidden ? 0 : 1
        }
    }

    @objc private func close() {
        dismiss(animated: true) { self.cleanUp() }
    }

    /// VoiceOver's two-finger scrub closes it, as it does any screen over another.
    override func accessibilityPerformEscape() -> Bool {
        close()
        return true
    }

    @objc private func share() {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = shareButton
        present(sheet, animated: true)
    }

    /// The named copy goes when the viewer closes; the decrypted file stays in the cache.
    private func cleanUp() {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    // MARK: Helpers

    /// A capsule of Liquid Glass, as Telegram's title is, or of a dark blur before iOS 26.
    private static func glass() -> UIVisualEffectView {
        if #available(iOS 26.0, *) {
            let view = UIVisualEffectView(effect: UIGlassEffect())
            view.cornerConfiguration = .capsule()
            return view
        }
        let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
        view.layer.cornerRadius = barHeight / 2
        view.layer.cornerCurve = .continuous
        view.clipsToBounds = true
        return view
    }

    nonisolated private static func downsampled(_ url: URL, maxPixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixels,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

extension PhotoViewer.Caption {
    /// As the chat names the sender, with the badge the chat's title has for someone verified.
    init(_ message: MessageView, server: AppModel.ServerState?) {
        let own = message.senderId == server?.me?.userId
        let sender = server?.users[message.senderId]
        name = own ? "You" : sender?.displayName ?? "Unknown"
        verified = !own && sender?.trust == .verified
        date = Format.stamp(message.createdAt)
    }
}

/// Black at the top fading to nothing, behind the status bar and the buttons.
private final class TopShade: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        let gradient = layer as? CAGradientLayer
        gradient?.colors = [0.6, 0.3, 0].map { UIColor.black.withAlphaComponent($0).cgColor }
        gradient?.locations = [0, 0.5, 1]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}
