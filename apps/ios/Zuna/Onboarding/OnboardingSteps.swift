import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers
import ZunaModels

// The steps of the join flow, as on the desktop: welcome, the invite link, join
// (or set up), the recovery key, the server's name, sign in, and recovery.

/// The first screen: what Zuna is in the middle, and the two ways in at the
/// bottom, within reach of a thumb, as in Telegram's and Signal's.
struct WelcomeStep: View {
    let onJoin: () -> Void
    let onSignIn: () -> Void

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 24)
                    VStack(spacing: 18) {
                        StepHeader("Welcome to Zuna", message: Text("Private chat on servers you and your friends run.")) {
                            ZunaLogo(size: 88)
                        }
                        TrustRow()
                    }
                    Spacer(minLength: 40)
                    VStack(spacing: 10) {
                        PrimaryButton(title: "Join with an invite", systemImage: "link", action: onJoin)
                            .accessibilityIdentifier(A11y.Onboarding.joinWithInvite)
                        SecondaryButton(title: "Sign in", action: onSignIn)
                            .accessibilityIdentifier(A11y.Onboarding.signIn)
                        Link(destination: OnboardingText.selfHostingURL) {
                            HStack(spacing: 6) {
                                Image(systemName: "server.rack")
                                Text("Host your own server")
                                Image(systemName: "arrow.up.right")
                                    .font(.caption.weight(.semibold))
                            }
                            .font(.callout.weight(.medium))
                            .foregroundStyle(Theme.text2)
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Theme.bg0)
        .accessibilityIdentifier(A11y.Onboarding.welcome)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// What Zuna promises, in three chips, on two lines where one is too narrow.
private struct TrustRow: View {
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { encrypted; openSource; selfHosted }
            VStack(spacing: 6) {
                HStack(spacing: 6) { encrypted; openSource }
                selfHosted
            }
        }
        .labelStyle(CompactLabelStyle())
        .font(.caption.weight(.medium))
        .foregroundStyle(Theme.text2)
    }

    private var encrypted: some View { chip(Label("End-to-end encrypted", systemImage: "lock.fill")) }
    private var openSource: some View { chip(Label("Open source", systemImage: "checkmark.shield.fill")) }
    private var selfHosted: some View { chip(Label("Self-hosted", systemImage: "server.rack")) }

    private func chip(_ label: some View) -> some View {
        label
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Theme.bg2, in: .capsule)
    }
}

/// The invite link, pasted or typed. A plain address works for servers with open sign-ups.
/// Inside the app, for another server, it's the first screen, with signing in under it.
struct InviteLinkStep: View {
    let embedded: Bool
    let onInvite: (InvitePreview) -> Void
    let onSignIn: () -> Void

    @Environment(AppModel.self) private var model
    @State private var link = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        StepScreen {
            StepHeader("Join a server", message: Text("Paste the invite link someone sent you."), systemImage: "link")

            FormField(label: nil, error: error) {
                HStack(spacing: 8) {
                    TextField("https://chat.example.com/invite/…", text: $link)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.continue)
                        .onSubmit(submit)
                        .onChange(of: link) { error = nil }
                        .accessibilityLabel("Invite link")
                        .accessibilityIdentifier(A11y.Onboarding.link)
                    if link.isEmpty {
                        PasteButton(payloadType: String.self) { strings in
                            Task { @MainActor in
                                link = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                                submit()
                            }
                        }
                        .labelStyle(.titleAndIcon)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .accessibilityIdentifier(A11y.Onboarding.paste)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .overlay(alignment: .bottomLeading) {
                if let error {
                    Color.clear.frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityLabel(error)
                        .accessibilityIdentifier(A11y.Onboarding.error)
                }
            }

            PrimaryButton(title: "Continue", busy: busy, action: submit)
                .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier(A11y.Onboarding.continue)

            // On the first run the welcome screen offers signing in, one step back.
            if embedded {
                SecondaryButton(title: "I already have an account", action: onSignIn)
                    .accessibilityIdentifier(A11y.Onboarding.signIn)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: takePendingLink)
        .onChange(of: model.pendingLink) { takePendingLink() }
    }

    private func takePendingLink() {
        guard let pending = model.pendingLink else { return }
        model.pendingLink = nil
        link = pending
        submit()
    }

    private func submit() {
        let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                onInvite(try await model.core.previewInvite(text))
            } catch {
                self.error = OnboardingText.describe(error)
            }
            busy = false
        }
    }
}

/// A new account on the server the invite is for, or the owner's account on a new server.
struct InviteStep: View {
    let preview: InvitePreview
    let onCreated: (_ serverId: String, _ recoveryKey: String) -> Void

    @Environment(AppModel.self) private var model
    @State private var displayName = ""
    @State private var username = ""
    @State private var usernameEdited = false
    @State private var password = ""
    @State private var confirm = ""
    @State private var rating = PasswordRating()
    @State private var error: String?
    @State private var busy = false

    private var canSubmit: Bool {
        !displayName.trimmingCharacters(in: .whitespaces).isEmpty
            && AccountRules.isValidUsername(username)
            && password.count >= AccountRules.minimumPasswordLength
            && rating.strongEnough
            && confirm == password
            && !busy
    }

    private var usernameError: String? {
        if let error, error.localizedCaseInsensitiveContains("username") { return error }
        if !username.isEmpty, !AccountRules.isValidUsername(username) { return "Usernames need at least 2 valid characters." }
        return nil
    }

    var body: some View {
        let server = preview.server
        StepScreen {
            StepHeader(
                preview.setup ? "Set up your server" : "Join \(server.name)",
                message: preview.setup
                    ? Text("You're creating the owner account.")
                    : server.userCount > 0
                        ? Text("\(Image(systemName: "person.2.fill")) \(server.userCount) \(server.userCount == 1 ? "member" : "members")")
                        : Text("Open sign-ups")
            ) {
                AvatarView(name: server.name, seed: preview.url, source: .serverAt(url: preview.url, hasIcon: server.hasIcon), size: 72, rounded: true)
            }
            .accessibilityIdentifier(A11y.Onboarding.joinScreen)

            FormField(label: "Your name") {
                TextField("How people will see you", text: $displayName)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                    .onChange(of: displayName) { _, name in
                        if displayName.count > 64 { displayName = String(displayName.prefix(64)) }
                        if !usernameEdited { username = AccountRules.suggestUsername(name) }
                    }
                    .accessibilityIdentifier(A11y.Onboarding.displayName)
            }
            FormField(label: "Username", hint: "Letters, numbers, dots, dashes and underscores.", error: usernameError) {
                TextField("alex", text: Binding(get: { username }, set: { value in
                    username = String(value.prefix(32))
                    usernameEdited = true
                    error = nil
                }))
                .textContentType(.username)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier(A11y.Onboarding.username)
            }
            VStack(alignment: .leading, spacing: 8) {
                FormField(label: "Password") {
                    SecureField("", text: $password)
                        .textContentType(.newPassword)
                        .accessibilityLabel("Password")
                        .accessibilityIdentifier(A11y.Onboarding.password)
                }
                StrengthMeter(rating: rating)
                    .task(id: [password, username, displayName]) {
                        await rating.rate(password, related: [username, displayName])
                    }
            }
            ConfirmPasswordField(password: password, confirmation: $confirm)
            Label("Your password unlocks your encryption keys. It never leaves this device, and your server can't reset it.", systemImage: "lock.fill")
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Theme.bg1, in: .rect(cornerRadius: 12, style: .continuous))
            if let error, usernameError != error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.red)
                    .accessibilityIdentifier(A11y.Onboarding.error)
            }
            PrimaryButton(title: "Agree and create account", busyTitle: "Securing your account", busy: busy, action: submit)
                .disabled(!canSubmit)
                .accessibilityIdentifier(A11y.Onboarding.create)
            Text("By creating an account, you agree to the [Terms of Use](https://zuna.chat/terms/).")
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .tint(Theme.link)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier(A11y.Onboarding.terms)
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        let profile = Profile(displayName: displayName.trimmingCharacters(in: .whitespaces))
        Task {
            guard await rating.accepts(password) else {
                busy = false
                return
            }
            model.accountFlowActive = true
            do {
                let result = try await model.core.register(preview, username: username, password: password, profile: profile)
                onCreated(result.serverId, result.recoveryKey)
            } catch {
                self.error = OnboardingText.describe(error)
                model.accountFlowActive = false
                busy = false
            }
        }
    }
}

/// The recovery key, shown once: the only way back in without the password.
struct RecoveryKeyStep: View {
    let recoveryKey: String
    let onDone: () -> Void

    @Environment(AppModel.self) private var model
    @State private var stored = false
    @State private var copied = false

    var body: some View {
        StepScreen {
            StepHeader(
                "Save your recovery key",
                message: Text("If you forget your password, this key is the only way back in. Nobody can reset it for you, not even your server's admin."),
                systemImage: "key.fill"
            )

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 58), spacing: 8)], spacing: 10) {
                ForEach(Array(recoveryKey.split(separator: "-").enumerated()), id: \.offset) { _, part in
                    Text(part)
                        .font(.system(.body, design: .monospaced).weight(.medium))
                        .foregroundStyle(Theme.text1)
                }
            }
            .padding(16)
            .background(Theme.bg2, in: .rect(cornerRadius: 14, style: .continuous))
            .textSelection(.enabled)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Recovery key")
            .accessibilityValue(recoveryKey)
            .accessibilityIdentifier(A11y.Onboarding.recoveryKey)

            HStack(spacing: 10) {
                Button(action: copy) {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .frame(maxWidth: .infinity, minHeight: 46)
                }
                .accessibilityIdentifier(A11y.Onboarding.copyKey)
                ShareLink(item: RecoveryKeyFile(key: recoveryKey), preview: SharePreview("zuna-recovery-key.txt", image: Image(systemName: "key.fill"))) {
                    Label("Save as file", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity, minHeight: 46)
                }
                .accessibilityIdentifier(A11y.Onboarding.saveKey)
            }
            .buttonStyle(.plain)
            .font(.callout.weight(.medium))
            .foregroundStyle(Theme.text1)
            .background {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.bg3)
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.bg3)
                }
            }

            Toggle("I've stored it somewhere safe", isOn: $stored)
                .tint(model.settings.accent.switchTint)
                .font(.callout)
                .foregroundStyle(Theme.text1)
                .padding(.horizontal, 4)
                .accessibilityIdentifier(A11y.Onboarding.keyStored)

            PrimaryButton(title: "Continue", action: onDone)
                .disabled(!stored)
                .accessibilityIdentifier(A11y.Onboarding.keyContinue)
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func copy() {
        // Kept off other devices through Universal Clipboard, and cleared after a while.
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: recoveryKey]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)]
        )
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// The recovery key as a text file, for the share sheet's Save to Files.
struct RecoveryKeyFile: Transferable {
    let key: String

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .plainText) { file in
            Data("Zuna recovery key\n\n\(file.key)\n\nKeep this somewhere safe. It's the only way back into your account if you forget your password.\n".utf8)
        }
        .suggestedFileName("zuna-recovery-key.txt")
    }
}

/// For the owner of a new server: its name, or skip.
struct NameServerStep: View {
    let serverId: String
    let onDone: () -> Void

    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var busy = false

    var body: some View {
        StepScreen {
            StepHeader("Name your server", message: Text("People see this name when you invite them. You can change it later."), systemImage: "server.rack")
            FormField(label: nil) {
                TextField("Our corner of the internet", text: $name)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.done)
                    .onSubmit(submit)
                    .onChange(of: name) { if name.count > 64 { name = String(name.prefix(64)) } }
                    .accessibilityLabel("Server name")
                    .accessibilityIdentifier(A11y.Onboarding.serverName)
            }
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            PrimaryButton(title: trimmed.isEmpty ? "Skip for now" : "Finish", busy: busy, action: submit)
                .accessibilityIdentifier(A11y.Onboarding.nameDone)
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func submit() {
        guard !busy else { return }
        busy = true
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        Task {
            if !trimmed.isEmpty {
                do {
                    try await model.core.session(serverId).updateServerSettings(ServerSettingsChanges(name: trimmed))
                } catch {
                    model.toast("Couldn't rename the server: \(OnboardingText.describe(error))", .error)
                }
            }
            onDone()
        }
    }
}

/// An existing account, on a new device.
struct SignInStep: View {
    let initialUrl: String?
    let onForgot: (_ url: String, _ username: String) -> Void
    let onSignedIn: (_ serverId: String) -> Void

    @Environment(AppModel.self) private var model
    @State private var url = ""
    @State private var username = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        StepScreen {
            StepHeader("Sign in", message: Text("Your history will load on this device after you sign in."), systemImage: "person.crop.circle")
            FormField(label: "Server address", hint: "Or paste any link to the server.") {
                TextField("chat.example.com", text: $url)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier(A11y.Onboarding.serverAddress)
            }
            FormField(label: "Username") {
                TextField("", text: $username)
                    .textContentType(.username)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Username")
                    .accessibilityIdentifier(A11y.Onboarding.username)
            }
            FormField(label: "Password") {
                SecureField("", text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .accessibilityLabel("Password")
                    .accessibilityIdentifier(A11y.Onboarding.password)
            }
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier(A11y.Onboarding.error)
            }
            PrimaryButton(title: "Sign in", busyTitle: "Unlocking your keys", busy: busy, action: submit)
                .disabled(url.isEmpty || username.isEmpty || password.isEmpty)
                .accessibilityIdentifier(A11y.Onboarding.signInSubmit)
            Button("Forgot your password?") { onForgot(url, username) }
                .font(.callout.weight(.medium))
                .foregroundStyle(Theme.text2)
                .disabled(url.isEmpty || username.isEmpty)
                .accessibilityIdentifier(A11y.Onboarding.forgot)
        }
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let initialUrl, url.isEmpty { url = initialUrl }
        }
    }

    private func submit() {
        guard !url.isEmpty, !username.isEmpty, !password.isEmpty, !busy else { return }
        busy = true
        error = nil
        model.accountFlowActive = true
        Task {
            do {
                onSignedIn(try await model.core.login(url: url, username: username, password: password))
            } catch {
                self.error = OnboardingText.describe(error)
                model.accountFlowActive = false
                busy = false
            }
        }
    }
}

/// Back in with the recovery key, and a new password.
struct RecoverStep: View {
    let url: String
    let username: String
    let onRecovered: (_ serverId: String) -> Void

    @Environment(AppModel.self) private var model
    @State private var key = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var rating = PasswordRating()
    @State private var error: String?
    @State private var busy = false

    private var canSubmit: Bool {
        !key.isEmpty && password.count >= AccountRules.minimumPasswordLength && rating.strongEnough && confirm == password && !busy
    }

    var body: some View {
        StepScreen {
            StepHeader(
                "Use your recovery key",
                message: Text("Enter the key you saved when you created your account, then choose a new password for \(Text(username).bold())."),
                systemImage: "key.fill"
            )
            FormField(label: "Recovery key") {
                TextField("", text: $key, axis: .vertical)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .lineLimit(1...3)
                    .padding(.vertical, 12)
                    .accessibilityLabel("Recovery key")
                    .accessibilityIdentifier(A11y.Onboarding.recoveryInput)
            }
            VStack(alignment: .leading, spacing: 8) {
                FormField(label: "New password") {
                    SecureField("", text: $password)
                        .textContentType(.newPassword)
                        .accessibilityLabel("New password")
                        .accessibilityIdentifier(A11y.Onboarding.newPassword)
                }
                StrengthMeter(rating: rating)
                    .task(id: password) {
                        await rating.rate(password, related: [username])
                    }
            }
            ConfirmPasswordField(label: "Confirm new password", password: password, confirmation: $confirm)
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier(A11y.Onboarding.error)
            }
            PrimaryButton(title: "Recover account", busy: busy, action: submit)
                .disabled(!canSubmit)
                .accessibilityIdentifier(A11y.Onboarding.recover)
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        Task {
            guard await rating.accepts(password) else {
                busy = false
                return
            }
            model.accountFlowActive = true
            do {
                onRecovered(try await model.core.recover(url: url, username: username, recoveryKey: key, newPassword: password))
            } catch {
                self.error = OnboardingText.describe(error)
                model.accountFlowActive = false
                busy = false
            }
        }
    }
}

/// The desktop's logo: a white Z on a black rounded square, as the app icon is (`icon.svg`).
struct ZunaLogo: View {
    var size: CGFloat = 52

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 230 / 1024, style: .continuous)
                .fill(Color.black)
            LogoZ()
                .stroke(Color.white, style: StrokeStyle(lineWidth: size * 96 / 1024, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The Z from the desktop's SVG, a line drawn in its 1024-point box, with two rounded corners.
    private struct LogoZ: Shape {
        func path(in rect: CGRect) -> Path {
            let scale = min(rect.width, rect.height) / 1024
            let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * scale, y: rect.minY + y * scale) }
            var path = Path()
            path.move(to: point(248, 524))
            path.addArc(tangent1End: point(248, 248), tangent2End: point(392, 248), radius: 144 * scale)
            path.addLine(to: point(776, 248))
            path.addLine(to: point(248, 776))
            path.addArc(tangent1End: point(776, 776), tangent2End: point(776, 632), radius: 144 * scale)
            path.addLine(to: point(776, 500))
            return path
        }
    }
}

/// An icon and a short word, tight together, for the welcome screen's last line.
private struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}
