import ImageIO
import UIKit
import ZunaModels

/// Pictures on the whole screen, as in Telegram: swipe sideways between a chat's pictures, pinch
/// or double tap to zoom, drag one around once it's bigger than the screen, and drag it up or
/// down to close, the chat showing through as it goes. Above it, Close, who sent it and when,
/// and Share. A tap hides or shows them, the status bar and the shade behind them.
@MainActor
final class PhotoViewer: UIViewController, UIPageViewControllerDataSource, UIPageViewControllerDelegate, UIGestureRecognizerDelegate {
    private let items: [Item]
    private var index: Int
    private let pages = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal, options: [.interPageSpacing: 16])
    private let backdrop = UIView()
    private let shade = TopShade()
    private let closeButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)
    private let titleView = PhotoViewer.glass()
    private let nameLabel = UILabel()
    private let badge = UIImageView(image: UIImage(systemName: "checkmark.seal.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)))
    private let dateLabel = UILabel()
    private var chromeHidden = false
    /// The decrypted files under their own names, for Share. Removed when the viewer closes.
    private var opened: [URL] = []

    /// Who sent the picture and when, between the buttons.
    struct Caption {
        var name: String
        var verified: Bool
        var date: String
    }

    /// A picture the viewer can show, opened once it's shown or next to the one that is.
    struct Item {
        let name: String
        let caption: Caption
        /// What it shows until the picture's made: the bubble's copy, or the message's blurred preview.
        let placeholder: UIImage?
        /// The decrypted file under its own name.
        let open: @MainActor () async throws -> URL
    }

    /// Whether an attachment opens here, rather than in QuickLook.
    static func shows(_ attachment: Attachment) -> Bool {
        attachment.mime.hasPrefix("image/") && !attachment.fileId.isEmpty
    }

    /// Shows `items[index]` over whatever is on screen, the others a swipe away, oldest on the left.
    static func show(_ items: [Item], at index: Int) {
        guard items.indices.contains(index), let top = topViewController() else { return }
        let viewer = PhotoViewer(items: items, index: index)
        viewer.modalPresentationStyle = .overFullScreen
        viewer.modalTransitionStyle = .crossDissolve
        top.present(viewer, animated: true)
    }

    private init(items: [Item], index: Int) {
        self.items = items
        self.index = index
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

        addChild(pages)
        pages.view.frame = view.bounds
        pages.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        pages.view.backgroundColor = .clear
        view.addSubview(pages.view)
        pages.didMove(toParent: self)
        // One picture alone has nothing to swipe to.
        pages.dataSource = items.count > 1 ? self : nil
        pages.delegate = self
        pages.setViewControllers([page(items.indices.contains(index) ? index : 0)], direction: .forward, animated: false)

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
        showCurrent()

        let drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
        drag.delegate = self
        view.addGestureRecognizer(drag)
    }

    // MARK: Pages

    private func page(_ index: Int) -> PhotoPage {
        let page = PhotoPage(index: index, item: items[index])
        page.onTap = { [weak self] in self?.toggleChrome() }
        page.onOpened = { [weak self] file in
            self?.opened.append(file)
            self?.showCurrent()
        }
        return page
    }

    private var current: PhotoPage? { pages.viewControllers?.first as? PhotoPage }

    func pageViewController(_ pageViewController: UIPageViewController, viewControllerBefore viewController: UIViewController) -> UIViewController? {
        guard let shown = viewController as? PhotoPage, shown.index > 0 else { return nil }
        return page(shown.index - 1)
    }

    func pageViewController(_ pageViewController: UIPageViewController, viewControllerAfter viewController: UIViewController) -> UIViewController? {
        guard let shown = viewController as? PhotoPage, shown.index + 1 < items.count else { return nil }
        return page(shown.index + 1)
    }

    func pageViewController(_ pageViewController: UIPageViewController, didFinishAnimating finished: Bool, previousViewControllers: [UIViewController], transitionCompleted completed: Bool) {
        guard completed, let current else { return }
        index = current.index
        showCurrent()
    }

    /// The title and Share for the picture on show.
    private func showCurrent() {
        let caption = items[index].caption
        nameLabel.text = caption.name
        badge.isHidden = !caption.verified
        // Which of how many, as Telegram's title says, when there's more than one.
        let place = items.count > 1 ? "\(index + 1) of \(items.count)" : nil
        dateLabel.text = [caption.date, place].compactMap { $0 }.joined(separator: " · ")
        titleView.accessibilityLabel = [caption.name, caption.verified ? "Verified" : nil, caption.date, place].compactMap { $0 }.joined(separator: ", ")
        shareButton.isEnabled = current?.file != nil
    }

    // MARK: Dragging to close

    /// Only a mostly vertical drag of a picture as it fits the screen closes it; zoomed in, a drag
    /// moves it, and a sideways one goes to the next.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let drag = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let velocity = drag.velocity(in: view)
        return current?.zoomed == false && abs(velocity.y) > abs(velocity.x)
    }

    /// The picture's and the pages' own drags, which give way once this one begins.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other.view is UIScrollView
    }

    /// The scroll view that moves between pages.
    private var pager: UIScrollView? { pages.view.subviews.lazy.compactMap { $0 as? UIScrollView }.first }

    @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
        let travel = gesture.translation(in: view).y
        let progress = min(1, abs(travel) / (view.bounds.height / 2))
        switch gesture.state {
        case .began:
            // Not to the next picture as well.
            pager?.isScrollEnabled = false
            setChrome(hidden: true)
        case .changed:
            pages.view.transform = CGAffineTransform(translationX: gesture.translation(in: view).x * 0.3, y: travel)
            backdrop.alpha = 1 - progress * 0.85
        case .ended, .cancelled:
            pager?.isScrollEnabled = true
            let velocity = gesture.velocity(in: view).y
            if gesture.state == .ended, abs(travel) > 100 || abs(velocity) > 900 {
                let direction: CGFloat = travel + velocity * 0.1 >= 0 ? 1 : -1
                UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseOut) {
                    self.pages.view.transform = CGAffineTransform(translationX: 0, y: direction * self.view.bounds.height)
                    self.backdrop.alpha = 0
                }
                // Animated as Close is, and while the picture goes, so a keyboard the chat had slides back up straight after.
                dismiss(animated: true) { self.cleanUp() }
            } else {
                UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
                    self.pages.view.transform = .identity
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
        nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        nameLabel.textColor = .white
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        badge.tintColor = UIColor.white.withAlphaComponent(0.7)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
        let nameRow = UIStackView(arrangedSubviews: [nameLabel, badge])
        nameRow.spacing = 4
        nameRow.alignment = .center
        dateLabel.font = .systemFont(ofSize: 12)
        dateLabel.textColor = UIColor.white.withAlphaComponent(0.7)
        dateLabel.lineBreakMode = .byTruncatingTail
        let stack = UIStackView(arrangedSubviews: [nameRow, dateLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        titleView.contentView.addSubview(stack)

        titleView.isAccessibilityElement = true
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
        guard let file = current?.file else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = shareButton
        present(sheet, animated: true)
    }

    /// The named copies go when the viewer closes; the decrypted files stay in the cache.
    private func cleanUp() {
        for file in opened {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
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

    nonisolated fileprivate static func downsampled(_ url: URL, maxPixels: Int) -> UIImage? {
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

@MainActor
extension PhotoViewer.Item {
    /// A chat's picture, opened through the image store.
    init(_ attachment: Attachment, of message: MessageView, server: AppModel.ServerState?, images: ImageStore) {
        let serverId = server?.entry.id ?? ""
        name = attachment.name
        caption = .init(message, server: server)
        placeholder = images.cachedAttachment(attachment) ?? attachment.thumb.flatMap { ImageStore.thumbnail($0) }
        open = { try await images.openable(attachment, serverId: serverId) }
    }

    /// The pictures among messages, in the order given, and which of them is `attachment`, of `message`.
    static func pictures(in messages: [MessageView], showing attachment: Attachment, of message: MessageView, server: AppModel.ServerState?, images: ImageStore) -> (items: [PhotoViewer.Item], index: Int) {
        var items: [PhotoViewer.Item] = []
        var index: Int?
        // Someone blocked's are left out, as their messages are hidden.
        for message in messages where message.deletedAt == nil && server?.isBlocked(message.senderId) != true {
            for picture in message.attachments where PhotoViewer.shows(picture) {
                if picture.fileId == attachment.fileId { index = items.count }
                items.append(PhotoViewer.Item(picture, of: message, server: server, images: images))
            }
        }
        // One that isn't among them opens alone.
        guard let index else { return ([PhotoViewer.Item(attachment, of: message, server: server, images: images)], 0) }
        return (items, index)
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

/// One picture in the viewer, fitted to the screen, which zooms on its own. It shows its
/// placeholder until the picture's opened and made.
@MainActor
private final class PhotoPage: UIViewController, UIScrollViewDelegate {
    let index: Int
    private let item: PhotoViewer.Item
    /// The decrypted file, once it's opened, for Share.
    private(set) var file: URL?
    var onTap: () -> Void = {}
    var onOpened: (URL) -> Void = { _ in }
    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let failure = UILabel()
    private var image: UIImage?

    var zoomed: Bool { scrollView.zoomScale > scrollView.minimumZoomScale + 0.01 }

    init(index: Int, item: PhotoViewer.Item) {
        self.index = index
        self.item = item
        image = item.placeholder
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
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
        imageView.accessibilityLabel = item.name
        imageView.accessibilityTraits = .image
        scrollView.addSubview(imageView)

        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        spinner.startAnimating()
        view.addSubview(spinner)
        failure.textColor = UIColor.white.withAlphaComponent(0.7)
        failure.font = .preferredFont(forTextStyle: .subheadline)
        failure.numberOfLines = 0
        failure.textAlignment = .center
        failure.isHidden = true
        failure.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failure)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failure.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failure.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            failure.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.require(toFail: doubleTap)
        scrollView.addGestureRecognizer(tap)
        load()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        fit()
    }

    /// Opens the picture and makes it, off the main thread, as one from a big photo takes a moment.
    private func load() {
        Task { [weak self, item] in
            do {
                let file = try await item.open()
                guard let self else { return }
                self.file = file
                onOpened(file)
                let sharp = await Task.detached(priority: .userInitiated) { PhotoViewer.downsampled(file, maxPixels: 4096) }.value
                if let sharp { show(sharp) } else { fail("This picture can't be shown.") }
            } catch {
                self?.fail(ErrorText.describe(error))
            }
        }
    }

    /// The sharp copy, in place of the placeholder. It's the same picture, so it fits the same.
    private func show(_ sharp: UIImage) {
        image = sharp
        imageView.image = sharp
        spinner.stopAnimating()
        view.setNeedsLayout()
    }

    private func fail(_ reason: String) {
        spinner.stopAnimating()
        imageView.isHidden = true
        failure.text = reason
        failure.isHidden = false
    }

    // MARK: Zoom

    /// Fits the picture to the screen, and lets it zoom to its own size or three times the fitted size.
    private func fit() {
        let bounds = scrollView.bounds.size
        guard bounds.width > 0, let image, image.size.width > 0, image.size.height > 0 else { return }
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

    @objc private func tapped() { onTap() }

    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        if zoomed {
            scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
            return
        }
        let scale = min(scrollView.maximumZoomScale, 2.5)
        let point = gesture.location(in: imageView)
        let size = CGSize(width: scrollView.bounds.width / scale, height: scrollView.bounds.height / scale)
        scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
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
