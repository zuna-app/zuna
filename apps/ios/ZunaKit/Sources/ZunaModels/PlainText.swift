import Foundation

/// A message as one line of plain text, for previews and notifications: the
/// Swift twin of `plainText` in packages/core/src/plain-text.ts. Spoilers stay
/// hidden here, since a preview is often seen without the reader choosing to.
///
/// JavaScript's `\w` only covers ASCII, so it's spelled out as `[A-Za-z0-9_]`
/// for the results to match the desktop's.
public func plainText(_ text: String) -> String {
    // Only ever shown as one short line, however long the message is.
    var result = String(decoding: text.utf16.prefix(4096), as: UTF16.self)
    for (pattern, template) in plainTextRules {
        result = pattern.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: template)
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

private let plainTextRules: [(NSRegularExpression, String)] = [
    (#"```[\s\S]*?```"#, "[code]"),
    (#"\|\|[^\n]+?\|\|"#, "[spoiler]"),
    (#"`([^`\n]+)`"#, "$1"),
    (#"\*\*([^\n]+?)\*\*"#, "$1"),
    (#"~~([^\n]+?)~~"#, "$1"),
    (#"(?<![A-Za-z0-9_*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![A-Za-z0-9_*])"#, "$1"),
    (#"(?<![A-Za-z0-9_])_([^\s_](?:[^\n_]*[^\s_])?)_(?![A-Za-z0-9_])"#, "$1"),
    (#"(?m)^>\s?"#, ""),
    (#"\s+"#, " "),
].map { pattern, template in
    // The patterns are constants; a mistake in one is a programming error.
    (try! NSRegularExpression(pattern: pattern), template)
}
