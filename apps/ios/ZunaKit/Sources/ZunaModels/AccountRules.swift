import Foundation

/// The rules for new accounts, the same as the desktop's onboarding
/// (features/onboarding/Onboarding.tsx and lib/format.ts).
public enum AccountRules {
    public static let minimumPasswordLength = 8

    /// What the server accepts as a username.
    public static func isValidUsername(_ username: String) -> Bool {
        username.range(of: #"^[A-Za-z0-9_][A-Za-z0-9_.-]{1,31}$"#, options: .regularExpression) != nil
    }

    /// A username made from a display name: accents dropped, everything else
    /// that isn't allowed turned into underscores.
    public static func suggestUsername(_ name: String) -> String {
        let marks: Set<Unicode.GeneralCategory> = [.nonspacingMark, .spacingMark, .enclosingMark]
        let scalars = name.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !marks.contains($0.properties.generalCategory) }
        let unmarked = String(String.UnicodeScalarView(scalars))
        let replaced = unmarked.lowercased()
            .replacingOccurrences(of: #"[^a-z0-9_.-]+"#, with: "_", options: .regularExpression)
            .replacingOccurrences(of: #"^[._-]+|[._-]+$"#, with: "", options: .regularExpression)
        return String(replaced.prefix(32))
    }

    public struct Strength: Equatable, Sendable {
        /// 0 for nothing typed, then 1 to 4.
        public let score: Int
        public let label: String
    }

    /// Rates a password from 0 to 4 by estimating how hard it is to guess. Sign-up asks for 2 or more.
    public static func passwordStrength(_ password: String) -> Strength {
        guard !password.isEmpty else { return Strength(score: 0, label: "") }
        func has(_ pattern: String, _ options: String.CompareOptions = []) -> Bool {
            password.range(of: pattern, options: options.union(.regularExpression)) != nil
        }
        var alphabet = 0
        if has("[a-z]") { alphabet += 26 }
        if has("[A-Z]") { alphabet += 26 }
        if has("[0-9]") { alphabet += 10 }
        if has("[^a-zA-Z0-9]") { alphabet += 20 }
        // Length in UTF-16 units, as JavaScript counts it.
        var bits = Double(password.utf16.count) * log2(Double(max(alphabet, 2)))
        if has(#"^(.)\1+$"#) { bits = 4 }
        if has("(password|qwerty|123456|letmein|admin|welcome|zuna)", .caseInsensitive) { bits -= 24 }
        if has(#"^[a-z]+\d{0,4}$"#, .caseInsensitive) { bits *= 0.65 }
        if bits < 28 { return Strength(score: 1, label: "Too easy to guess") }
        if bits < 42 { return Strength(score: 2, label: "Could be stronger") }
        if bits < 60 { return Strength(score: 3, label: "Good") }
        return Strength(score: 4, label: "Strong")
    }
}
