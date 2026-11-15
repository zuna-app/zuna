import CoreImage.CIFilterBuiltins
import SwiftUI
import ZunaModels

/// Linking a Telegram account (docs/TELEGRAM_PLAN.md, Linking an account): first what it is and
/// what Telegram learns, before anything is sent to Telegram, then, on a phone that can't scan its
/// own screen, a phone number, whose code Telegram sends to its app on this phone or another
/// device, and the account's password if it has one. A QR code is the other way, which Telegram
/// on another device scans, or a button that asks Telegram on this phone. No account is made here.
struct LinkTelegramView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    /// A phone number rather than the QR code, which is how it starts here.
    @State private var byPhone = true
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
                    Button(t("common.cancel")) { model.cancelLinkingTelegram() }
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
            codeStep(pattern.isEmpty ? t("telegram.link.codeToLoginEmail") : t("telegram.link.codeToEmail", ["email": pattern]), length: length, canResend: false)
        case let .password(hint)?:
            passwordStep(hint)
        case .signup?:
            StepHeader(t("telegram.link.noAccount"), message: Text(t("telegram.link.signUpFirst")), systemImage: "person.crop.circle.badge.questionmark")
            SecondaryButton(title: t("telegram.link.anotherNumber")) {
                phone = ""
                restart()
            }
        case .ready?:
            waiting
        case let .failed(reason)?:
            StepHeader(t("telegram.link.failed"), message: Text(reason), systemImage: "exclamationmark.triangle")
            PrimaryButton(title: t("common.tryAgain")) { restart() }
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
            StepHeader(t("telegram.link.title"), message: Text(t("telegram.link.intro")), systemImage: "bubble.left.and.bubble.right.fill")
            VStack(alignment: .leading, spacing: 14) {
                point(t("telegram.link.pointEncryption"))
                point(t("telegram.link.pointSees"))
                point(t("telegram.link.pointMonitors"))
                point(t("telegram.link.pointNotifications"))
                point(t("telegram.link.pointChannels"))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            PrimaryButton(title: t("common.continue"), busy: busy) {
                ask { try await model.beginLinkingTelegram() }
            }
            .accessibilityIdentifier(A11y.Telegram.begin)
        }
    }

    private var waiting: some View {
        VStack(spacing: 14) {
            ProgressView().tint(Theme.text2)
            Text(t("telegram.link.reaching"))
                .font(.callout)
                .foregroundStyle(Theme.text2)
        }
        .frame(maxWidth: .infinity, minHeight: 240)
        .accessibilityIdentifier(A11y.Telegram.waiting)
    }

    private func qr(_ link: String) -> some View {
        VStack(spacing: 18) {
            StepHeader(t("telegram.link.qrTitle"), message: Text(t("telegram.link.qrLead")), systemImage: "qrcode")
            if let image = Self.qrImage(link) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 240, height: 240)
                    .padding(12)
                    .background(.white, in: .rect(cornerRadius: 16, style: .continuous))
                    .accessibilityLabel(t("telegram.link.qrLabel"))
                    .accessibilityIdentifier(A11y.Telegram.qr)
            }
            // A phone can't scan its own screen: Telegram here asks whether to let this device in.
            PrimaryButton(title: t("telegram.link.confirm"), systemImage: "paperplane") {
                if let url = URL(string: link) { openURL(url) }
            }
            .accessibilityIdentifier(A11y.Telegram.confirm)
            Text(t("telegram.link.qrHint"))
                .font(.footnote)
                .foregroundStyle(Theme.text3)
                .multilineTextAlignment(.center)
            SecondaryButton(title: t("telegram.link.usePhone")) {
                byPhone = true
                restart()
            }
            .accessibilityIdentifier(A11y.Telegram.byPhone)
        }
    }

    private var phoneStep: some View {
        VStack(spacing: 18) {
            StepHeader(t("telegram.link.phoneTitle"), message: Text(t("telegram.link.phoneLead")), systemImage: "phone")
            FormField(label: t("telegram.link.phone"), hint: t("telegram.link.phoneHint")) {
                TextField("+1 555 010 0000", text: $phone)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                    .accessibilityIdentifier(A11y.Telegram.phone)
            }
            PrimaryButton(title: t("common.next"), busy: busy) {
                let number = phone
                ask { try await model.core.session(ServerEntry.telegram).linkWithPhone(number) }
            }
            .disabled(phone.filter(\.isNumber).count < 5)
            // From another device's Telegram, by its camera, or Telegram on this phone confirming it.
            SecondaryButton(title: t("telegram.link.useQr")) {
                byPhone = false
                askedQr = true
                ask { try await model.core.session(ServerEntry.telegram).linkWithQr() }
            }
            .accessibilityIdentifier(A11y.Telegram.byQr)
        }
    }

    private func codeStep(_ said: String, length: Int, canResend: Bool) -> some View {
        VStack(spacing: 18) {
            StepHeader(t("telegram.link.codeTitle"), message: Text(said), systemImage: "number")
            FormField(label: t("telegram.link.code"), hint: length > 0 ? t("telegram.link.digits", ["count": length]) : nil) {
                TextField("12345", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .accessibilityIdentifier(A11y.Telegram.code)
            }
            PrimaryButton(title: t("common.next"), busy: busy) {
                let typed = code
                ask {
                    try await model.core.session(ServerEntry.telegram).enterCode(typed)
                    code = ""
                }
            }
            .disabled(code.filter(\.isNumber).isEmpty)
            if canResend {
                SecondaryButton(title: t("telegram.link.resend")) {
                    ask { try await model.core.session(ServerEntry.telegram).resendCode() }
                }
            }
        }
    }

    private func passwordStep(_ hint: String) -> some View {
        VStack(spacing: 18) {
            StepHeader(t("telegram.link.passwordTitle"), message: Text(t("telegram.link.passwordLead")), systemImage: "lock")
            FormField(label: t("common.password"), hint: hint.isEmpty ? nil : t("telegram.link.passwordHint", ["hint": hint])) {
                SecureField(t("telegram.link.passwordTitle"), text: $password)
                    .textContentType(.password)
                    .accessibilityIdentifier(A11y.Telegram.password)
            }
            PrimaryButton(title: t("telegram.link.link"), busy: busy) {
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

    /// One thing to know, its lead in bold: the part of the sentence between ** and **.
    private func point(_ sentence: String) -> some View {
        var text = (try? AttributedString(markdown: sentence)) ?? AttributedString(sentence)
        for run in text.runs {
            text[run.range].foregroundColor = run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true ? Theme.text1 : Theme.text2
        }
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(Theme.text3).frame(width: 5, height: 5).offset(y: -3)
            Text(text)
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
        case "telegram": t("telegram.link.sentToApp")
        case "call": t("telegram.link.codeViaCall", ["phone": phone])
        case "fragment": t("telegram.link.sentToFragment")
        case "sms": t("telegram.link.codeViaSms", ["phone": phone])
        default: t("telegram.link.sent")
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
