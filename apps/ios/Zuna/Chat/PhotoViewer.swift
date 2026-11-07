import ImageIO
import UIKit

/// A picture on the whole screen, as in Telegram: pinch or double tap to zoom,
/// drag it around once it's bigger than the screen, and drag it up or down to
/// close, the chat showing through as it goes. A tap hides or shows the buttons.
@MainActor
final class PhotoViewer: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    /// The decrypted file under its own name, for Share. Removed when the viewer closes.
    private let file: URL
    private let image: UIImage
    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    private let backdrop = UIView()
    private let closeButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)
    private var chromeHidden = false

    /// Shows a decrypted picture over whatever is on screen.
    static func show(_ file: URL) {
        // Big photos are drawn at most this size, which is sharp on any screen and keeps memory in check.
        guard let image = downsampled(file, maxPixels: 4096), let top = topViewController() else {
            FilePreview.show(file)
            return
        }
        let viewer = PhotoViewer(file: file, image: image)
        viewer.modalPresentationStyle = .overFullScreen
        viewer.modalTransitionStyle = .crossDissolve
        top.present(viewer, animated: true)
    }

    private init(file: URL, image: UIImage) {
        self.file = file
        self.image = image
        super.init(nibName: nil, bundle: nil)
        // Over the whole screen the status bar stays the chat's unless the viewer takes it, and it covers a screenshot's top.
        modalPresentationCapturesStatusBarAppearance = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var prefersStatusBarHidden: Bool { true }
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

        configure(closeButton, symbol: "xmark", label: "Close", action: #selector(close))
        configure(shareButton, symbol: "square.and.arrow.up", label: "Share", action: #selector(share))
        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            shareButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            shareButton.topAnchor.constraint(equalTo: closeButton.topAnchor),
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
        guard imageView.bounds.size != size else { return }
        scrollView.zoomScale = 1
        imageView.frame = CGRect(origin: .zero, size: size)
        scrollView.contentSize = size
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = max(3, 1 / fitted)
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

    private func configure(_ button: UIButton, symbol: String, label: String, action: Selector) {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        configuration.baseForegroundColor = .white
        configuration.background.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        configuration.background.cornerRadius = 20
        button.configuration = configuration
        button.accessibilityLabel = label
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 40).isActive = true
        button.heightAnchor.constraint(equalToConstant: 40).isActive = true
        button.addTarget(self, action: action, for: .primaryActionTriggered)
        view.addSubview(button)
    }

    @objc private func toggleChrome() {
        setChrome(hidden: !chromeHidden)
    }

    private func setChrome(hidden: Bool) {
        chromeHidden = hidden
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        UIView.animate(withDuration: 0.2) {
            self.closeButton.alpha = hidden ? 0 : 1
            self.shareButton.alpha = hidden ? 0 : 1
        }
    }

    @objc private func close() {
        dismiss(animated: true) { self.cleanUp() }
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

    private static func downsampled(_ url: URL, maxPixels: Int) -> UIImage? {
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
