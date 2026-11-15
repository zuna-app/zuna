import Foundation

/// A mention by name in the message box of a Telegram chat: where its words are in what's
/// written, in UTF-16 code units, and whose user ID it is. The box shows the name alone, and what's
/// sent, and kept as the draft, has it written out as the markup holds it, `[name](tg://user?id=123)`,
/// as the core writes Telegram's (telegram/markup.ts). The desktop's twin is in its `markup.rs`.
public struct NamedMention: Equatable, Hashable, Sendable {
    public var location: Int
    public var length: Int
    public var userId: String

    public init(location: Int, length: Int, userId: String) {
        self.location = location
        self.length = length
        self.userId = userId
    }

    var end: Int { location + length }
}

public enum NamedMentions {
    private static let pattern = try! NSRegularExpression(pattern: #"\[([^\[\]\n]{1,100})\]\(tg://user\?id=([1-9][0-9]{0,15})\)"#)
    /// JavaScript's largest exact integer, past which a user's number is no one's.
    private static let mostUserId: UInt64 = (1 << 53) - 1
    /// The most a mention by name says, in UTF-16 code units as the core counts them.
    private static let mostWords = 100
    /// The most a mention put in from a suggestion says, as Telegram's names are up to 64 characters.
    private static let mostName = 64

    private static func isUserId(_ id: String) -> Bool {
        UInt64(id).map { $0 > 0 && $0 <= mostUserId } ?? false
    }

    /// What mentioning someone on Telegram by name writes: their first name, as Telegram's apps
    /// write it, or their whole name, with nothing the markup couldn't hold, or none for an
    /// account that can't be mentioned, such as a chat speaking as itself.
    public static func name(for user: UserView) -> String? {
        guard isUserId(user.id) else { return nil }
        for name in [user.firstName ?? "", user.displayName] {
            let scalars = name.unicodeScalars.filter { !["[", "]", "\n", "\r"].contains($0) }
            let clean = String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespaces)
            var used = 0
            var fitted = ""
            for character in clean {
                used += character.utf16.count
                if used > mostName { break }
                fitted.append(character)
            }
            fitted = fitted.trimmingCharacters(in: .whitespaces)
            if !fitted.isEmpty { return fitted }
        }
        return nil
    }

    /// Text with its mentions by name as the names alone, for the message box, and where each is.
    public static func take(_ markup: String) -> (text: String, named: [NamedMention]) {
        let ns = markup as NSString
        var text = ""
        var length = 0
        var named: [NamedMention] = []
        var last = 0
        for match in pattern.matches(in: markup, range: NSRange(location: 0, length: ns.length)) {
            let id = ns.substring(with: match.range(at: 2))
            guard isUserId(id) else { continue }
            let between = ns.substring(with: NSRange(location: last, length: match.range.location - last))
            text += between
            length += (between as NSString).length
            let name = ns.substring(with: match.range(at: 1))
            named.append(NamedMention(location: length, length: (name as NSString).length, userId: id))
            text += name
            length += (name as NSString).length
            last = match.range.location + match.range.length
        }
        text += ns.substring(from: last)
        return (text, named)
    }

    /// What the message box holds, with each mention by name still there written out again.
    public static func put(_ text: String, _ named: [NamedMention]) -> String {
        let ns = text as NSString
        let held = named.filter { mention in
            guard mention.location >= 0, mention.length > 0, mention.end <= ns.length, mention.length <= mostWords, isUserId(mention.userId) else { return false }
            let words = ns.substring(with: NSRange(location: mention.location, length: mention.length))
            return !words.contains("[") && !words.contains("]") && !words.contains("\n")
        }.sorted { $0.location < $1.location }
        var out = ""
        var last = 0
        for mention in held where mention.location >= last {
            out += ns.substring(with: NSRange(location: last, length: mention.location - last))
            out += "[\(ns.substring(with: NSRange(location: mention.location, length: mention.length)))](tg://user?id=\(mention.userId))"
            last = mention.end
        }
        return out + ns.substring(from: last)
    }

    /// Follows the mentions by name through a change to the message box, from `before` to
    /// `after`: those before or after the change move with the text, and one the change reached
    /// into is plain words from then on. Where it was typed isn't known here, so of the two places
    /// a change could have been, as the same letters may lie on either side of it, a mention is kept
    /// if either leaves it whole, the later place first, as one typed after it.
    public static func follow(from before: String, to after: String, _ named: [NamedMention]) -> [NamedMention] {
        if named.isEmpty || before == after { return named }
        if after.isEmpty { return [] }
        let old = Array(before.utf16), new = Array(after.utf16)
        let shortest = min(old.count, new.count)
        func common(_ a: some Sequence<UInt16>, _ b: some Sequence<UInt16>) -> Int {
            zip(a, b).prefix { $0 == $1 }.count
        }
        let prefix = common(old, new), suffix = common(old.reversed(), new.reversed())
        // The change as late as it can be, then as early.
        let late = (prefix: min(prefix, shortest), suffix: min(suffix, shortest - min(prefix, shortest)))
        let early = (prefix: min(prefix, shortest - min(suffix, shortest)), suffix: min(suffix, shortest))
        let moved = new.count - old.count
        func placed(_ mention: NamedMention, _ change: (prefix: Int, suffix: Int)) -> NamedMention? {
            if mention.end <= change.prefix { return mention }
            if mention.location >= old.count - change.suffix {
                var shifted = mention
                shifted.location += moved
                return shifted
            }
            return nil
        }
        return named.compactMap { placed($0, late) ?? placed($0, early) }
    }
}
