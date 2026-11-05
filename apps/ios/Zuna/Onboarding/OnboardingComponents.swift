import SwiftUI
import ZunaHost
import ZunaModels

/// The parts the join screens share: a header, fields, the strength meter and the main button.

struct StepHeader<Icon: View>: View {
    let title: String
    let message: Text?
    @ViewBuilder var icon: Icon

    init(_ title: String, message: Text? = nil, @ViewBuilder icon: () -> Icon) {
        self.title = title
        self.message = message
        self.icon = icon()
    }

    var body: some View {
        VStack(spacing: 12) {
            icon
            Text(title)
                .font(.title.weight(.bold))
                .foregroundStyle(Theme.text1)
                .multilineTextAlignment(.center)
            if let message {
                message
                    .font(.callout)
                    .foregroundStyle(Theme.text2)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }
}

extension StepHeader where Icon == StepIcon {
    init(_ title: String, message: Text? = nil, systemImage: String) {
        self.init(title, message: message) { StepIcon(systemImage: systemImage) }
    }
}

struct StepIcon: View {
    let systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 30, weight: .medium))
            .foregroundStyle(Theme.text1)
            .frame(width: 72, height: 72)
            .background(Theme.bg3, in: .rect(cornerRadius: 22, style: .continuous))
    }
}

/// A labeled field on a rounded background, as in Telegram's sign-in screens.
struct FormField<Field: View>: View {
    let label: String?
    var hint: String?
    var error: String?
    @ViewBuilder var field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.text2)
                    .padding(.leading, 4)
            }
            field
                .font(.body)
                .foregroundStyle(Theme.text1)
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(Theme.bg2, in: .rect(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(error == nil ? Theme.line : Theme.red.opacity(0.7))
                }
            if let message = error ?? hint {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(error == nil ? Theme.text3 : Theme.red)
                    .padding(.leading, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A new password typed again, which says when it stops matching.
struct ConfirmPasswordField: View {
    var label = "Confirm password"
    let password: String
    @Binding var confirmation: String

    var body: some View {
        FormField(label: label, error: AccountRules.confirmationError(password, confirmation: confirmation)) {
            SecureField("", text: $confirmation)
                .textContentType(.newPassword)
                .accessibilityLabel(label)
                .accessibilityIdentifier(A11y.Onboarding.confirmPassword)
        }
    }
}

/// A password's strength, kept with the password it's for, so that nothing goes
/// ahead on a rating of what was typed a moment ago.
@MainActor
@Observable
final class PasswordRating {
    private(set) var strength = PasswordMeter.Strength.none
    private var rated = ""
    @ObservationIgnored private var related: [String] = []

    /// `related` is what anyone guessing would try first: the username and display name.
    func rate(_ password: String, related: [String]) async {
        self.related = related
        let strength = await PasswordMeter.shared.strength(password, related: related)
        guard !Task.isCancelled else { return }
        self.strength = strength
        rated = password
    }

    /// Whether the latest rating is strong enough. It can trail what was typed by a
    /// moment, and a button goes by it, so that it doesn't flicker off with each key.
    var strongEnough: Bool { strength.score >= 2 }

    /// Whether `password` is strong enough, rated first if the latest rating is for
    /// something else.
    func accepts(_ password: String) async -> Bool {
        if rated != password { await rate(password, related: related) }
        return !password.isEmpty && rated == password && strength.score >= 2
    }
}

/// How hard a new password is to guess, as on the desktop: four bars and a word.
struct StrengthMeter: View {
    let rating: PasswordRating

    var body: some View {
        let strength = rating.strength
        let colors = [Theme.bg5, Theme.red, Theme.amber, Theme.text2, Theme.green]
        HStack(spacing: 10) {
            HStack(spacing: 4) {
                ForEach(1...4, id: \.self) { bar in
                    Capsule()
                        .fill(strength.score >= bar ? colors[strength.score] : Theme.bg4)
                        .frame(height: 4)
                }
            }
            .frame(width: 120)
            Text(strength.label.isEmpty ? "At least \(AccountRules.minimumPasswordLength) characters" : strength.label)
                .font(.footnote)
                .foregroundStyle(strength.score > 0 ? colors[strength.score] : Theme.text3)
        }
        .padding(.leading, 4)
        .animation(.easeOut(duration: 0.15), value: strength.score)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Password strength")
        .accessibilityValue(strength.label.isEmpty ? "At least \(AccountRules.minimumPasswordLength) characters" : strength.label)
        .accessibilityIdentifier(A11y.Onboarding.strength)
    }
}

/// The screen's main action: full width, in the accent color, with a spinner while busy.
/// Until it can go, it's a gray one with its title still readable, not a faded accent.
struct PrimaryButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.isEnabled) private var isEnabled
    let title: String
    var busyTitle: String?
    var systemImage: String?
    var busy = false
    let action: () -> Void

    var body: some View {
        let accent = model.settings.accent
        Button(action: action) {
            HStack(spacing: 8) {
                if busy {
                    ProgressView().tint(accent.onAccent)
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(busy ? busyTitle ?? title : title)
            }
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(isEnabled ? accent.onAccent : Theme.text3)
            .background(isEnabled ? accent.color : Theme.bg2, in: .rect(cornerRadius: 14, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(StepButtonStyle())
        .disabled(busy)
    }
}

/// The other way forward from a screen: as big as the main button, on a quieter fill.
struct SecondaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 52)
                .foregroundStyle(Theme.text1)
                .background(Theme.bg3, in: .rect(cornerRadius: 14, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Theme.lineStrong)
                }
                .contentShape(.rect)
        }
        .buttonStyle(StepButtonStyle())
    }
}

/// Fades while pressed. Unlike `.plain`, it leaves a disabled button's colors
/// alone, which on the black background had faded the main button away.
private struct StepButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// A screen of the join flow: scrolls with the keyboard, on the app's background.
struct StepScreen<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                content
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg0)
    }
}

enum OnboardingText {
    /// Network failures read better without the core's wording, as on the desktop.
    static func describe(_ error: Error) -> String {
        let message = (error as? CoreCallError)?.message ?? error.localizedDescription
        if message.range(of: "Couldn't reach|fetch", options: [.regularExpression, .caseInsensitive]) != nil {
            return "Couldn't reach that server. Check the address and your connection."
        }
        return message.isEmpty ? "Something went wrong. Please try again." : message
    }

    static let projectURL = URL(string: "https://github.com/SocketByte/zuna-chat")!
    static let selfHostingURL = projectURL.appending(path: "blob/main/docs/SELF_HOSTING.md")
}
