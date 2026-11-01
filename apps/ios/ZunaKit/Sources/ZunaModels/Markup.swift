import Foundation

/// Message text parsed the way the desktop renders it (packages/ui/src/lib/markup.tsx):
/// fenced code, `>` quotes, then inline code, spoilers, bold, strikethrough,
/// italics, links, @mentions and 7TV emotes. The UI turns the result into
/// styled text; a golden corpus rendered by the desktop keeps the two in step.
public enum Markup {
    public enum Inline: Equatable, Sendable {
        case text(String)
        case emote(name: String, emote: EmoteRef)
        /// `@username`, highlighted because the username belongs to someone on the server.
        case mention(username: String, userId: String)
        case link(String)
        case code(String)
        case spoiler([Inline])
        case bold([Inline])
        case strike([Inline])
        case italic([Inline])
    }

    public enum Block: Equatable, Sendable {
        case text([Inline])
        case quote([Inline])
        case code(String, language: String?)
    }

    public struct Context: Sendable {
        public var emotes: [String: EmoteRef]
        /// Lowercased username to user ID.
        public var mentionable: [String: String]

        public init(emotes: [String: EmoteRef] = [:], mentionable: [String: String] = [:]) {
            self.emotes = emotes
            self.mentionable = mentionable
        }
    }

    public static func parse(_ text: String, _ context: Context) -> [Block] {
        splitBlocks(text).map { block in
            switch block {
            case let .text(raw): .text(inline(raw, context))
            case let .quote(raw): .quote(inline(raw, context))
            case let .code(code, language): .code(code, language: language)
            }
        }
    }

    /// Messages that are only emoji or emotes show larger: 2 for up to three, 1 for up to eight, otherwise 0.
    public static func jumboSize(_ text: String, emotes: [String: EmoteRef]) -> Int {
        let words = split(trimmed(text), on: whitespaceRun)
        guard !words.isEmpty, words.count <= 6 else { return 0 }
        guard words.allSatisfy({ emotes[$0] != nil || (matches(emojiOnly, $0) && matches(hasEmoji, $0)) }) else { return 0 }
        let glyphs = words.reduce(0) { $0 + (emotes[$1] != nil ? 1 : $1.count) }
        guard glyphs <= 8 else { return 0 }
        return glyphs <= 3 ? 2 : 1
    }

    // MARK: Blocks

    private enum RawBlock {
        case text(String)
        case quote(String)
        case code(String, language: String?)
    }

    private static func splitBlocks(_ text: String) -> [RawBlock] {
        var blocks: [RawBlock] = []
        let ns = text as NSString
        var last = 0
        func pushText(_ chunk: String) {
            guard !chunk.isEmpty else { return }
            let lines = replace(edgeNewlines, in: chunk, with: "").components(separatedBy: "\n")
            for line in lines {
                let isQuote = matches(quoteMarker, line)
                let value = isQuote ? replace(quoteMarker, in: line, with: "", first: true) : line
                switch (blocks.last, isQuote) {
                case let (.quote(current)?, true):
                    blocks[blocks.count - 1] = .quote(current + "\n" + value)
                case let (.text(current)?, false):
                    blocks[blocks.count - 1] = .text(current + "\n" + value)
                default:
                    blocks.append(isQuote ? .quote(value) : .text(value))
                }
            }
        }
        for match in fence.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            pushText(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
            let language = ns.substring(with: match.range(at: 1))
            var code = ns.substring(with: match.range(at: 2))
            if code.hasSuffix("\n") { code.removeLast() }
            blocks.append(.code(code, language: language.isEmpty ? nil : language))
            last = match.range.location + match.range.length
        }
        pushText(ns.substring(from: last))
        return blocks
    }

    // MARK: Inline

    private static func inline(_ text: String, _ context: Context) -> [Inline] {
        merged(renderInline(text, context))
    }

    /// Formatting inside formatting, this deep. Further in, it's just text.
    private static let maxInlineDepth = 8

    /// The earliest match of any rule wins; on a tie, the rule listed first.
    /// It's a loop, so a message with thousands of spans can't run out of stack,
    /// and each rule's next match is kept, so a long one isn't searched from
    /// scratch for every span.
    private static func renderInline(_ text: String, _ context: Context, depth: Int = 0) -> [Inline] {
        guard depth < maxInlineDepth else { return links(text, context) }
        let ns = text as NSString
        var nodes: [Inline] = []
        var searched = [Bool](repeating: false, count: inlineRules.count)
        // Where each rule next matches, and its inside, counted from the start of the text.
        var found = [(range: NSRange, inner: NSRange)?](repeating: nil, count: inlineRules.count)
        var position = 0
        while true {
            // What came before a span no longer counts, so the rest is searched on its own,
            // as the desktop slices it: a search range would still let lookbehinds see it.
            let rest = ns.substring(from: position)
            let restRange = NSRange(location: 0, length: (rest as NSString).length)
            let start = position
            let placed = { (match: NSTextCheckingResult) -> (range: NSRange, inner: NSRange) in
                let inner = match.range(at: 1)
                return (NSRange(location: match.range.location + start, length: match.range.length), NSRange(location: inner.location + start, length: inner.length))
            }
            var earliest: Int?
            for (index, rule) in inlineRules.enumerated() {
                let known = found[index]
                if !searched[index] || (known.map { $0.range.location < position } ?? false) {
                    found[index] = rule.firstMatch(in: rest, range: restRange).map(placed)
                    searched[index] = true
                } else if known == nil || known!.range.location > position {
                    // Further on, everything reads the same as before. Only the very start can differ.
                    if let match = rule.firstMatch(in: rest, options: .anchored, range: restRange) { found[index] = placed(match) }
                }
                if let current = found[index], earliest == nil || current.range.location < found[earliest!]!.range.location {
                    earliest = index
                }
            }
            guard let earliest, let match = found[earliest] else { break }
            nodes += links(ns.substring(with: NSRange(location: position, length: match.range.location - position)), context)
            let inner = ns.substring(with: match.inner)
            let node: Inline = switch earliest {
            case 0: .code(inner)
            case 1: .spoiler(renderInline(inner, context, depth: depth + 1))
            case 2: .bold(renderInline(inner, context, depth: depth + 1))
            case 3: .strike(renderInline(inner, context, depth: depth + 1))
            default: .italic(renderInline(inner, context, depth: depth + 1))
            }
            nodes.append(node)
            position = match.range.location + match.range.length
        }
        return nodes + links(ns.substring(from: position), context)
    }

    private static func links(_ text: String, _ context: Context) -> [Inline] {
        let ns = text as NSString
        var nodes: [Inline] = []
        var last = 0
        for match in url.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > last {
                nodes += plain(ns.substring(with: NSRange(location: last, length: match.range.location - last)), context)
            }
            nodes.append(.link(ns.substring(with: match.range)))
            last = match.range.location + match.range.length
        }
        if last < ns.length { nodes += plain(ns.substring(from: last), context) }
        return nodes
    }

    /// Words that are emotes or mentions, with the text between them.
    private static func plain(_ text: String, _ context: Context) -> [Inline] {
        var nodes: [Inline] = []
        var buffer = ""
        func flush() {
            if !buffer.isEmpty { nodes.append(.text(buffer)) }
            buffer = ""
        }
        for token in tokens(text) {
            if let emote = context.emotes[token] {
                flush()
                nodes.append(.emote(name: token, emote: emote))
                continue
            }
            let ns = token as NSString
            if let match = mention.firstMatch(in: token, range: NSRange(location: 0, length: ns.length)) {
                let username = ns.substring(with: match.range(at: 1))
                if let userId = context.mentionable[username.lowercased()] {
                    flush()
                    nodes.append(.mention(username: username, userId: userId))
                    buffer += ns.substring(with: match.range(at: 2))
                    continue
                }
            }
            buffer += token
        }
        flush()
        return nodes
    }

    /// Like JavaScript's `text.split(/(\s+)/)`: the words and the whitespace between them.
    private static func tokens(_ text: String) -> [String] {
        let ns = text as NSString
        var result: [String] = []
        var last = 0
        for match in whitespaceRun.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            result.append(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
            result.append(ns.substring(with: match.range))
            last = match.range.location + match.range.length
        }
        result.append(ns.substring(from: last))
        return result
    }

    /// Adjacent text joined, as it reads.
    private static func merged(_ nodes: [Inline]) -> [Inline] {
        var result: [Inline] = []
        for node in nodes {
            let node: Inline = switch node {
            case let .spoiler(children): .spoiler(merged(children))
            case let .bold(children): .bold(merged(children))
            case let .strike(children): .strike(merged(children))
            case let .italic(children): .italic(merged(children))
            default: node
            }
            if case let .text(next) = node, case let .text(previous)? = result.last {
                result[result.count - 1] = .text(previous + next)
            } else {
                result.append(node)
            }
        }
        return result
    }

    // MARK: Shared links

    /// The links a message shares, leaving out those in code and spoilers: the
    /// twin of `sharedLinks` in packages/core/src/links.ts, which counts them.
    public static func sharedLinks(_ text: String) -> [String] {
        let visible = hiddenFromLinks.reduce(text) { replace($1, in: $0, with: " ") }
        let ns = visible as NSString
        return url.matches(in: visible, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
    }

    // MARK: Patterns

    /// JavaScript's `\s`, which differs a little from ICU's.
    private static let space = #"\t\n\x{0B}\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"#
    /// JavaScript's `\w`, which is ASCII only.
    private static let word = "A-Za-z0-9_"

    private static let whitespaceRun = regex("[\(space)]+")
    // \A and \z, since ICU's ^ and $ also match around a final line break.
    private static let edgeNewlines = regex(#"\A\n+|\n+\z"#)
    private static let quoteMarker = regex("^>[\(space)]?")
    private static let fence = regex("```([^\(space)`]*)\\n?([\\s\\S]*?)```")
    // Brackets that pair up stay in a link, as in Wikipedia's addresses; one around it doesn't.
    private static let url = regex(
        "(?<![\(word)])https?://(?:[^\(space)<>\"'()]|\\([^\(space)<>\"'()]*\\))*(?:[^\(space)<>\"'.,;:!?()\\]}]|\\([^\(space)<>\"'()]*\\))",
        options: .caseInsensitive
    )
    /// Code, whether or not its fence is closed, and spoilers, in the order the core takes them out.
    private static let hiddenFromLinks = [regex(#"```[\s\S]*?(?:```|\z)"#), regex("`[^`\\n]*`"), regex(#"\|\|[\s\S]*?\|\|"#)]
    private static let mention = regex(#"^@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})([.,:;!?]*)$"#)
    private static let emojiOnly = regex("^(?:\\p{Extended_Pictographic}|\\p{Emoji_Component}|\\x{200D}|\\x{FE0F}|[\(space)])+$")
    /// Digits, # and * are emoji components only as part of a keycap, so a word needs a real emoji.
    private static let hasEmoji = regex(#"\p{Extended_Pictographic}|\p{Regional_Indicator}|\x{20E3}"#)
    private static let inlineRules = [
        regex("`([^`\\n]+)`"),
        regex(#"\|\|([^\n]+?)\|\|"#),
        regex(#"\*\*([^\n]+?)\*\*"#),
        regex(#"~~([^\n]+?)~~"#),
        regex("(?<![\(word)*])\\*([^\(space)*](?:[^\\n*]*[^\(space)*])?)\\*(?![\(word)*])"),
        regex("(?<![\(word)_])_([^\(space)_](?:[^\\n_]*[^\(space)_])?)_(?![\(word)_])"),
    ]

    private static func regex(_ pattern: String, options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // The patterns are constants; a mistake in one is a programming error.
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    private static func replace(_ regex: NSRegularExpression, in text: String, with template: String, first: Bool = false) -> String {
        let ns = text as NSString
        guard first else {
            return regex.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: ns.length), withTemplate: template)
        }
        guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return text }
        return ns.replacingCharacters(in: match.range, with: template)
    }

    private static func split(_ text: String, on regex: NSRegularExpression) -> [String] {
        guard !text.isEmpty else { return [] }
        let ns = text as NSString
        var parts: [String] = []
        var last = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            parts.append(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
            last = match.range.location + match.range.length
        }
        parts.append(ns.substring(from: last))
        return parts.filter { !$0.isEmpty }
    }

    /// JavaScript's `trim()`.
    private static func trimmed(_ text: String) -> String {
        replace(regex("\\A[\(space)]+|[\(space)]+\\z"), in: text, with: "")
    }
}
