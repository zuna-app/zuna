import SwiftUI
import UIKit
import ZunaModels

extension NSAttributedString.Key {
    static let zunaLink = NSAttributedString.Key("zuna.link")
    static let zunaMention = NSAttributedString.Key("zuna.mention")
    static let zunaSpoiler = NSAttributedString.Key("zuna.spoiler")
}

/// How a message's text looks: its size and colors, which differ in your own bubbles.
struct TextStyle {
    var size: CGFloat
    var own: Bool
    var color: UIColor
    var faint: UIColor
    /// Large-emoji messages: bigger emoji and emotes, no bubble.
    var jumbo = 0

    var font: UIFont { .systemFont(ofSize: size) }

    /// Emotes stand a little taller than the text, as on the desktop (26 px at 14.5 px).
    var emoteHeight: CGFloat {
        switch jumbo {
        case 2: 64 * size / 14.5
        case 1: 48 * size / 14.5
        default: size * 1.8
        }
    }
}

/// Turns parsed markup into styled text for `MessageTextLabel`.
enum MessageTextBuilder {
    struct Options {
        var style: TextStyle
        var selfId: String
        var serverUrl: String
        var revealed: Set<Int> = []
        /// Emote widths for their height, from the server's set.
        var aspect: (String) -> CGFloat = { _ in 1 }
    }

    static func build(_ nodes: [Markup.Inline], _ options: Options) -> NSAttributedString {
        let out = NSMutableAttributedString()
        var spoilerIndex = 0
        append(nodes, to: out, options, base: baseAttributes(options.style), spoiler: nil, spoilerIndex: &spoilerIndex)
        return out
    }

    /// Room at the end of the last line for the time, which sits over it, as in Telegram.
    static func reserve(_ width: CGFloat, in text: NSMutableAttributedString, style: TextStyle) {
        text.append(NSAttributedString(string: "\u{00A0}", attributes: [.font: style.font, .kern: width]))
    }

    static func baseAttributes(_ style: TextStyle) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = 1.08
        return [.font: style.jumbo > 0 ? UIFont.systemFont(ofSize: style.jumbo == 2 ? style.size * 2.9 : style.size * 2.3) : style.font, .foregroundColor: style.color, .paragraphStyle: paragraph]
    }

    private static func append(
        _ nodes: [Markup.Inline],
        to out: NSMutableAttributedString,
        _ options: Options,
        base: [NSAttributedString.Key: Any],
        spoiler: Int?,
        spoilerIndex: inout Int
    ) {
        let style = options.style
        var attributes = base
        if let spoiler {
            attributes[.zunaSpoiler] = spoiler
            if options.revealed.contains(spoiler) {
                attributes[.backgroundColor] = UIColor.white.withAlphaComponent(0.07)
            } else {
                attributes[.foregroundColor] = UIColor.clear
                attributes[.backgroundColor] = UIColor(Theme.bg5)
            }
        }
        for node in nodes {
            switch node {
            case let .text(text):
                out.append(NSAttributedString(string: text, attributes: attributes))
            case let .emote(name, emote):
                let attachment = EmoteAttachment(name: name, emote: emote, hidden: spoiler.map { !options.revealed.contains($0) } ?? false)
                let height = style.emoteHeight
                let width = emote.zeroWidth == true ? 0 : min(height * options.aspect(emote.id), height * 4.2)
                let font = attributes[.font] as? UIFont ?? style.font
                attachment.bounds = CGRect(x: 0, y: (font.capHeight - height) / 2, width: width, height: height)
                let piece = NSMutableAttributedString(attachment: attachment)
                piece.addAttributes(attributes, range: NSRange(location: 0, length: piece.length))
                out.append(piece)
            case let .mention(username, userId):
                var mention = attributes
                mention[.font] = UIFont.systemFont(ofSize: style.size, weight: .semibold)
                mention[.zunaMention] = userId
                if spoiler == nil {
                    mention[.backgroundColor] = UIColor.white.withAlphaComponent(userId == options.selfId ? 0.18 : 0.09)
                }
                out.append(NSAttributedString(string: "@" + username, attributes: mention))
            case let .link(url):
                var link = attributes
                link[.zunaLink] = url
                if spoiler == nil || options.revealed.contains(spoiler!) {
                    link[.foregroundColor] = style.own ? style.color : UIColor(Theme.link)
                    if style.own { link[.underlineStyle] = NSUnderlineStyle.single.rawValue }
                }
                out.append(NSAttributedString(string: url, attributes: link))
            case let .code(code):
                var mono = attributes
                mono[.font] = UIFont.monospacedSystemFont(ofSize: style.size * 0.87, weight: .regular)
                if spoiler == nil { mono[.backgroundColor] = UIColor.white.withAlphaComponent(0.09) }
                out.append(NSAttributedString(string: code, attributes: mono))
            case let .spoiler(children):
                let index = spoilerIndex
                spoilerIndex += 1
                append(children, to: out, options, base: base, spoiler: spoiler ?? index, spoilerIndex: &spoilerIndex)
            case let .bold(children):
                append(children, to: out, options, base: styled(attributes, traits: .traitBold), spoiler: spoiler, spoilerIndex: &spoilerIndex)
            case let .italic(children):
                append(children, to: out, options, base: styled(attributes, traits: .traitItalic), spoiler: spoiler, spoilerIndex: &spoilerIndex)
            case let .strike(children):
                var struck = attributes
                struck[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                append(children, to: out, options, base: struck, spoiler: spoiler, spoilerIndex: &spoilerIndex)
            }
        }
    }

    private static func styled(_ attributes: [NSAttributedString.Key: Any], traits: UIFontDescriptor.SymbolicTraits) -> [NSAttributedString.Key: Any] {
        var result = attributes
        let font = attributes[.font] as? UIFont ?? .systemFont(ofSize: 16)
        let combined = font.fontDescriptor.symbolicTraits.union(traits)
        if let descriptor = font.fontDescriptor.withSymbolicTraits(combined) {
            result[.font] = UIFont(descriptor: descriptor, size: font.pointSize)
        }
        return result
    }
}

/// An inline emote. The label places an `EmoteImageView` where TextKit lays it out.
final class EmoteAttachment: NSTextAttachment {
    let name: String
    let emote: EmoteRef
    /// Inside a spoiler that isn't revealed yet.
    let hidden: Bool

    init(name: String, emote: EmoteRef, hidden: Bool) {
        self.name = name
        self.emote = emote
        self.hidden = hidden
        super.init(data: nil, ofType: nil)
        // Without an image the attachment draws a document icon under the view.
        image = UIImage()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// Text laid out by TextKit 2 and drawn by hand, with animated emotes placed
/// in the frames TextKit gives their attachments, and taps on links, mentions
/// and spoilers.
final class MessageTextLabel: UIView {
    private let contentStorage = NSTextContentStorage()
    private let layoutManager = NSTextLayoutManager()
    private let container = NSTextContainer(size: .zero)
    private var emoteViews: [EmoteImageView] = []
    private var emoteInfo: [(String, EmoteRef)] = []
    var serverUrl = ""
    var emoteSize: EmoteImages.Size = .inline
    var onLink: ((URL) -> Void)?
    var onMention: ((String) -> Void)?
    var onSpoiler: ((Int) -> Void)?
    /// A long press on an emote, for its card.
    var onEmote: ((String, EmoteRef) -> Void)?

    var attributedText = NSAttributedString() {
        didSet {
            guard attributedText != oldValue else { return }
            contentStorage.attributedString = attributedText
            setNeedsLayout()
            setNeedsDisplay()
            invalidateIntrinsicContentSize()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        container.lineFragmentPadding = 0
        layoutManager.textContainer = container
        contentStorage.addTextLayoutManager(layoutManager)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:))))
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var accessibilityLabel: String? {
        get { attributedText.string.replacingOccurrences(of: "\u{FFFC}", with: "") }
        set {}
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        container.size = CGSize(width: size.width, height: 0)
        layoutManager.ensureLayout(for: layoutManager.documentRange)
        let used = layoutManager.usageBoundsForTextContainer
        return CGSize(width: ceil(min(size.width, used.width)), height: ceil(used.height))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        container.size = CGSize(width: bounds.width, height: 0)
        layoutManager.ensureLayout(for: layoutManager.documentRange)
        placeEmotes()
        setNeedsDisplay()
    }

    private func placeEmotes() {
        var frames: [(EmoteAttachment, CGRect)] = []
        var previous: CGRect?
        attributedText.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attributedText.length)) { value, range, _ in
            guard let emote = value as? EmoteAttachment,
                  let location = contentStorage.location(contentStorage.documentRange.location, offsetBy: range.location),
                  let fragment = layoutManager.textLayoutFragment(for: location) else { return }
            var frame = fragment.frameForTextAttachment(at: location)
                .offsetBy(dx: fragment.layoutFragmentFrame.minX, dy: fragment.layoutFragmentFrame.minY)
            if emote.emote.zeroWidth == true {
                // 7TV zero-width emotes draw over the emote before them.
                frame = previous ?? CGRect(x: frame.minX, y: frame.minY, width: emote.bounds.height, height: emote.bounds.height)
            } else {
                previous = frame
            }
            frames.append((emote, frame))
        }
        while emoteViews.count < frames.count {
            let view = EmoteImageView()
            addSubview(view)
            emoteViews.append(view)
        }
        while emoteViews.count > frames.count {
            emoteViews.removeLast().removeFromSuperview()
        }
        emoteInfo = frames.map { ($0.0.name, $0.0.emote) }
        for (view, (emote, frame)) in zip(emoteViews, frames) {
            view.frame = frame
            view.isHidden = emote.hidden
            view.show(name: emote.name, id: emote.emote.id, size: emoteSize, serverUrl: serverUrl)
        }
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        layoutManager.enumerateTextLayoutFragments(from: layoutManager.documentRange.location, options: [.ensuresLayout]) { fragment in
            fragment.draw(at: fragment.layoutFragmentFrame.origin, in: context)
            return true
        }
    }

    // MARK: Taps

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        let whole = NSRange(location: 0, length: attributedText.length)
        for key in [NSAttributedString.Key.zunaSpoiler, .zunaMention, .zunaLink] {
            var hit: (Any, NSRange)?
            attributedText.enumerateAttribute(key, in: whole) { value, range, stop in
                guard let value, contains(point, range) else { return }
                hit = (value, range)
                stop.pointee = true
            }
            guard let (value, _) = hit else { continue }
            switch key {
            case .zunaSpoiler:
                // A hidden spoiler reveals itself before anything inside it reacts.
                if let index = value as? Int, (attributedText.attribute(.foregroundColor, at: hit!.1.location, effectiveRange: nil) as? UIColor) == .clear {
                    onSpoiler?(index)
                    return
                }
            case .zunaMention:
                if let userId = value as? String { onMention?(userId) }
                return
            default:
                if let text = value as? String, let url = URL(string: text) { onLink?(url) }
                return
            }
        }
    }

    @objc private func pressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began else { return }
        let point = gesture.location(in: self)
        for (view, (name, emote)) in zip(emoteViews, emoteInfo) where !view.isHidden && view.frame.insetBy(dx: -4, dy: -4).contains(point) {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onEmote?(name, emote)
            return
        }
    }

    private func contains(_ point: CGPoint, _ range: NSRange) -> Bool {
        guard let start = contentStorage.location(contentStorage.documentRange.location, offsetBy: range.location),
              let end = contentStorage.location(start, offsetBy: range.length),
              let textRange = NSTextRange(location: start, end: end) else { return false }
        var found = false
        layoutManager.enumerateTextSegments(in: textRange, type: .standard, options: []) { _, frame, _, _ in
            if frame.insetBy(dx: -4, dy: -4).contains(point) { found = true }
            return !found
        }
        return found
    }
}

/// `MessageTextLabel` in SwiftUI, sized to the width it's offered.
struct MessageTextView: UIViewRepresentable {
    let text: NSAttributedString
    let serverUrl: String
    var emoteSize: EmoteImages.Size = .inline
    var onMention: (String) -> Void = { _ in }
    var onSpoiler: (Int) -> Void = { _ in }
    var onEmote: (String, EmoteRef) -> Void = { _, _ in }

    @Environment(\.openURL) private var openURL

    func makeUIView(context: Context) -> MessageTextLabel {
        let label = MessageTextLabel()
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    func updateUIView(_ label: MessageTextLabel, context: Context) {
        label.serverUrl = serverUrl
        label.emoteSize = emoteSize
        label.attributedText = text
        label.onLink = { openURL($0) }
        label.onMention = onMention
        label.onSpoiler = onSpoiler
        label.onEmote = onEmote
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MessageTextLabel, context: Context) -> CGSize? {
        uiView.sizeThatFits(CGSize(width: proposal.width ?? 300, height: .greatestFiniteMagnitude))
    }
}
