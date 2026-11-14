import CoreImage.CIFilterBuiltins
import SwiftUI
import ZunaModels

/// Linking a Telegram account (docs/TELEGRAM_PLAN.md, Linking an account), as the desktop's dialog
/// does it: first what it is and what Telegram learns, before anything is sent to Telegram, then a
/// QR code, which Telegram on another device scans, or a button that asks Telegram on this phone,
/// with a phone number and its code as the fallback, and the account's password if it has one.
/// No account is made here.
struct LinkTelegramView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    /// The person chose a phone number over the QR code.
    @State private var byPhone = false
    /// The QR code was asked for once already.
    @State private var askedQr = false
    @State private var phone = ""
    @State private var code = ""
    @State private var password = ""
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            StepScreen {
                content
            }
            .navigationTitle("Telegram")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg0, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.cancelLinkingTelegram() }
                        .accessibilityIdentifier(A11y.Telegram.cancel)
                }
            }
        }
        .interactiveDismissDisabled(model.telegramLink != nil)
        .onChange(of: model.telegramLink) { _, link in
            problem = nil
            // The engine waits for a way in: the QR code, unless the person chose a number.
            if case .phone = link, !byPhone, !askedQr {
                askedQr = true
                ask { try await model.core.session(ServerEntry.telegram).linkWithQr() }
            }
        }
        .accessibilityIdentifier(A11y.Telegram.screen)
    }

    @ViewBuilder
    private var content: some View {
        switch model.telegramLink {
        case nil:
            intro
        case .starting?:
            waiting
        case let .qr(link)? where !byPhone:
            qr(link)
        case .qr?, .phone?:
            phoneStep
        case let .code(number, length, via, canResend)?:
            codeStep(Self.whereCodeWent(via: via, phone: number), length: length, canResend: canResend)
        case let .email(pattern, length)?:
            codeStep("Telegram sent a code to \(pattern.isEmpty ? "your login email" : pattern).", length: length, canResend: false)
        case let .password(hint)?:
            passwordStep(hint)
        case .signup?:
            StepHeader("No Telegram account", message: Text("There's no Telegram account with that number. Zuna can't create one, so sign up in Telegram's own app first, then link it here."), systemImage: "person.crop.circle.badge.questionmark")
            SecondaryButton(title: "Use another number") {
                phone = ""
                restart()
            }
        case .ready?:
            waiting
        case let .failed(reason)?:
            StepHeader("Telegram couldn't be linked", message: Text(reason), systemImage: "exclamationmark.triangle")
            PrimaryButton(title: "Try again") { restart() }
        case .unlinked?:
            intro
        }
        if let problem {
            Text(problem)
                .font(.footnote)
                .foregroundStyle(Theme.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(A11y.Telegram.problem)
        }
    }

    // MARK: The steps

    private var intro: some View {
        VStack(spacing: 18) {
            StepHeader("Use Telegram in Zuna", message: Text("Zuna will sign in to your Telegram account as another device, using Telegram's API. Zuna isn't made by Telegram."), systemImage: "bubble.left.and.bubble.right.fill")
            VStack(alignment: .leading, spacing: 14) {
                point("These chats aren't end-to-end encrypted.", "Telegram keeps them on its servers, as it does for its own apps. Zuna's servers never see them.")
                point("Telegram will see", "that you use Zuna, this device's IP address and operating system, and when you're online.")
                point("Telegram monitors accounts that use other apps,", "and sometimes restricts them by mistake. It's safest to link an account you've had for a while.")
                point("Notifications come while Zuna is open.", "With Zuna closed, Telegram's own app tells you of new messages.")
                point("Channels, calls and secret chats", "are only in Telegram's own app.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            PrimaryButton(title: "Continue", busy: busy) {
                ask { try await model.beginLinkingTelegram() }
            }
            .accessibilityIdentifier(A11y.Telegram.begin)
        }
    }

    private var waiting: some View {
        VStack(spacing: 14) {
            ProgressView().tint(Theme.text2)
            Text("Reaching Telegram…")
                .font(.callout)
                .foregroundStyle(Theme.text2)
        }
        .frame(maxWidth: .infinity, minHeight: 240)
        .accessibilityIdentifier(A11y.Telegram.waiting)
    }

    private func qr(_ link: String) -> some View {
        VStack(spacing: 18) {
            StepHeader("Link with Telegram", message: Text("On another device, open Telegram, then Settings, Devices, Link Desktop Device, and scan this."), systemImage: "qrcode")
            if let image = Self.qrImage(link) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 240, height: 240)
                    .padding(12)
                    .background(.white, in: .rect(cornerRadius: 16, style: .continuous))
                    .accessibilityLabel("QR code to link Telegram")
                    .accessibilityIdentifier(A11y.Telegram.qr)
            }
            // A phone can't scan its own screen: Telegram here asks whether to let this device in.
            PrimaryButton(title: "Confirm in Telegram", systemImage: "paperplane") {
                if let url = URL(string: link) { openURL(url) }
            }
            .accessibilityIdentifier(A11y.Telegram.confirm)
            Text("The code refreshes about every 30 seconds. You don't need to type anything, and no code is sent by text message.")
                .font(.footnote)
                .foregroundStyle(Theme.text3)
                .multilineTextAlignment(.center)
            SecondaryButton(title: "Use a phone number instead") {
                byPhone = true
                restart()
            }
            .accessibilityIdentifier(A11y.Telegram.byPhone)
        }
    }

    private var phoneStep: some View {
        VStack(spacing: 18) {
            StepHeader("Your phone number", message: Text("Telegram will send the code to your other devices, or by email. It doesn't send codes by text message to apps like Zuna."), systemImage: "phone")
            FormField(label: "Phone number", hint: "Include the country code.") {
                TextField("+1 555 010 0000", text: $phone)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                    .accessibilityIdentifier(A11y.Telegram.phone)
            }
            PrimaryButton(title: "Next", busy: busy) {
                let number = phone
                ask { try await model.core.session(ServerEntry.telegram).linkWithPhone(number) }
            }
            .disabled(phone.filter(\.isNumber).count < 5)
        }
    }

    private func codeStep(_ said: String, length: Int, canResend: Bool) -> some View {
        VStack(spacing: 18) {
            StepHeader("Enter the code", message: Text(said), systemImage: "number")
            FormField(label: "Code", hint: length > 0 ? "\(length) digits." : nil) {
                TextField("12345", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .accessibilityIdentifier(A11y.Telegram.code)
            }
            PrimaryButton(title: "Next", busy: busy) {
                let typed = code
                ask {
                    try await model.core.session(ServerEntry.telegram).enterCode(typed)
                    code = ""
                }
            }
            .disabled(code.filter(\.isNumber).isEmpty)
            if canResend {
                SecondaryButton(title: "Send another") {
                    ask { try await model.core.session(ServerEntry.telegram).resendCode() }
                }
            }
        }
    }

    private func passwordStep(_ hint: String) -> some View {
        VStack(spacing: 18) {
            StepHeader("Your Telegram password", message: Text("Your account has two-step verification. Your password is checked without ever being sent to Telegram."), systemImage: "lock")
            FormField(label: "Password", hint: hint.isEmpty ? nil : "Hint: \(hint)") {
                SecureField("Your Telegram password", text: $password)
                    .textContentType(.password)
                    .accessibilityIdentifier(A11y.Telegram.password)
            }
            PrimaryButton(title: "Link", busy: busy) {
                let typed = password
                ask {
                    try await model.core.session(ServerEntry.telegram).enterPassword(typed)
                    password = ""
                }
            }
            .disabled(password.isEmpty)
        }
    }

    // MARK: Helpers

    private func point(_ lead: String, _ rest: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(Theme.text3).frame(width: 5, height: 5).offset(y: -3)
            Text("\(Text(lead).bold().foregroundStyle(Theme.text1)) \(Text(rest).foregroundStyle(Theme.text2))")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func ask(_ work: @escaping @MainActor () async throws -> Void) {
        busy = true
        problem = nil
        Task {
            do { try await work() } catch { problem = ErrorText.describe(error) }
            busy = false
        }
    }

    private func restart() {
        askedQr = false
        ask { try await model.restartLinkingTelegram() }
    }

    static func whereCodeWent(via: String, phone: String) -> String {
        switch via {
        case "telegram": "Telegram sent a code to the Telegram app on your other devices."
        case "call": "Telegram is calling \(phone) with a code."
        case "fragment": "Telegram sent a code to your number on Fragment."
        case "sms": "Telegram sent a code to \(phone)."
        default: "Telegram sent you a code."
        }
    }

    /// A QR code for `text`, its modules drawn sharp, with the quiet zone readers need.
    static func qrImage(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}
