#if DEBUG
import SwiftUI
import UIKit

/// F0 spike: message text with animated emotes inline, including a zero-width
/// emote stacked on the one before it, laid out by TextKit 2. Shown instead of
/// the root view when the app is launched with `-ZunaSpike emoteText`.
struct EmoteTextSpike: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(red: 15 / 255, green: 15 / 255, blue: 17 / 255).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 12) {
                Text("Emote text spike").font(.headline).foregroundStyle(.white)
                EmoteTextView()
                    .frame(maxWidth: 300)
                    .padding(10)
                    .background(Color(white: 0.16), in: RoundedRectangle(cornerRadius: 16))
                    .accessibilityIdentifier("spike.emoteText")
            }
            .padding(20)
        }
    }
}

private struct EmoteTextView: UIViewRepresentable {
    func makeUIView(context: Context) -> EmoteTextLabel {
        let font = UIFont.systemFont(ofSize: 16)
        let plain: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
        let text = NSMutableAttributedString(string: "Inline ", attributes: plain)
        text.append(EmoteAttachment.string(colors: [.systemPink, .systemOrange, .systemYellow], overlay: nil, font: font))
        text.append(NSAttributedString(string: " and stacked ", attributes: plain))
        text.append(EmoteAttachment.string(colors: [.systemTeal, .systemBlue], overlay: [.white, .clear], font: font))
        text.append(NSAttributedString(string: " emotes keep animating while the line wraps across several lines like a long message would.", attributes: plain))
        let label = EmoteTextLabel()
        label.attributedText = text
        return label
    }

    func updateUIView(_ view: EmoteTextLabel, context: Context) {}

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: EmoteTextLabel, context: Context) -> CGSize? {
        uiView.sizeThatFits(CGSize(width: proposal.width ?? 300, height: .greatestFiniteMagnitude))
    }
}

/// Lays out text with TextKit 2, draws it, and places each attachment's view
/// in the frame the layout gave it, so animated emotes sit inside the text.
final class EmoteTextLabel: UIView {
    private let contentStorage = NSTextContentStorage()
    private let layoutManager = NSTextLayoutManager()
    private let container = NSTextContainer(size: .zero)
    private var attachmentViews: [UIView] = []

    var attributedText = NSAttributedString() {
        didSet {
            contentStorage.attributedString = attributedText
            setNeedsLayout()
            invalidateIntrinsicContentSize()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        container.lineFragmentPadding = 0
        layoutManager.textContainer = container
        contentStorage.addTextLayoutManager(layoutManager)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        container.size = CGSize(width: size.width, height: 0)
        layoutManager.ensureLayout(for: layoutManager.documentRange)
        let used = layoutManager.usageBoundsForTextContainer
        return CGSize(width: ceil(min(size.width, used.width)), height: ceil(used.height))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        container.size = CGSize(width: bounds.width, height: 0)
        attachmentViews.forEach { $0.removeFromSuperview() }
        attachmentViews.removeAll()
        layoutManager.ensureLayout(for: layoutManager.documentRange)
        let whole = NSRange(location: 0, length: attributedText.length)
        attributedText.enumerateAttribute(.attachment, in: whole) { value, range, _ in
            guard let emote = value as? EmoteAttachment,
                  let location = contentStorage.location(contentStorage.documentRange.location, offsetBy: range.location),
                  let fragment = layoutManager.textLayoutFragment(for: location) else { return }
            let view = emote.makeView()
            view.frame = fragment.frameForTextAttachment(at: location)
                .offsetBy(dx: fragment.layoutFragmentFrame.minX, dy: fragment.layoutFragmentFrame.minY)
            addSubview(view)
            attachmentViews.append(view)
        }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        layoutManager.enumerateTextLayoutFragments(from: layoutManager.documentRange.location, options: [.ensuresLayout]) { fragment in
            fragment.draw(at: fragment.layoutFragmentFrame.origin, in: context)
            return true
        }
    }
}

/// An inline emote: an animated image sized to the line, optionally with a
/// zero-width emote drawn over it.
final class EmoteAttachment: NSTextAttachment {
    var frames: [UIImage] = []
    var overlay: [UIImage]?

    static func string(colors: [UIColor], overlay: [UIColor]?, font: UIFont) -> NSAttributedString {
        let attachment = EmoteAttachment()
        attachment.frames = colors.map(frame)
        attachment.overlay = overlay?.map(ring)
        let side = font.lineHeight * 1.25
        attachment.bounds = CGRect(x: 0, y: font.descender - 2, width: side, height: side)
        // Without an image the attachment draws a document icon under the view.
        attachment.image = UIImage()
        return NSAttributedString(attachment: attachment)
    }

    /// The emote's view: its animation, and any zero-width emote drawn over it.
    func makeView() -> UIView {
        let container = UIView(frame: CGRect(origin: .zero, size: bounds.size))
        let base = UIImageView(image: UIImage.animatedImage(with: frames, duration: 0.6))
        base.frame = container.bounds
        base.contentMode = .scaleAspectFit
        base.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(base)
        if let overlay {
            let top = UIImageView(image: UIImage.animatedImage(with: overlay, duration: 0.4))
            top.frame = container.bounds
            top.contentMode = .scaleAspectFit
            top.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(top)
        }
        return container
    }

    private static func frame(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 56, height: 56)).image { _ in
            color.setFill()
            UIBezierPath(ovalIn: CGRect(x: 4, y: 4, width: 48, height: 48)).fill()
        }
    }

    private static func ring(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 56, height: 56)).image { _ in
            color.setStroke()
            let path = UIBezierPath(ovalIn: CGRect(x: 10, y: 10, width: 36, height: 36))
            path.lineWidth = 6
            path.stroke()
        }
    }
}
#endif
