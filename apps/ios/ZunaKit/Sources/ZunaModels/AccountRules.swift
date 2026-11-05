import Foundation

/// The rules for new accounts, the same as the desktop's onboarding
/// (features/onboarding/Onboarding.tsx and lib/format.ts). How strong a password
/// is comes from ZunaHost's PasswordMeter, the desktop's own estimator.
public enum AccountRules {
    public static let minimumPasswordLength = 8

    /// What the server accepts as a username.
    public static func isValidUsername(_ username: String) -> Bool {
        username.range(of: #"^[A-Za-z0-9_][A-Za-z0-9_.-]{1,31}$"#, options: .regularExpression) != nil
    }

    /// What's wrong with a new password typed again, if anything. A typo would lock the
    /// account, as nobody can reset a password, but while the second one is still being
    /// typed, it's only wrong once it stops matching.
    public static func confirmationError(_ password: String, confirmation: String) -> String? {
        !confirmation.isEmpty && !password.hasPrefix(confirmation) ? "The passwords don't match." : nil
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
}
