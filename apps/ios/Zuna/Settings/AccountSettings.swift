import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import ZunaModels

/// Your profile on a server, as the desktop's Profile section: the picture,
/// display name and bio, which only its members can see.
struct ProfileView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var displayName = ""
    @State private var bio = ""
    @State private var loaded = false
    @State private var busy = false
    @State private var photo: PhotosPickerItem?

    var body: some View {
        let server = model.servers[serverId]
        let me = server?.selfUser
        let dirty = displayName.trimmingCharacters(in: .whitespaces) != (me?.displayName ?? "") || bio != (me?.bio ?? "")
        List {
            Section {
                VStack(spacing: 10) {
                    if let me {
                        // Made here, as the picker's label isn't on the main actor.
                        let avatar = AvatarView(name: me.displayName, seed: me.id, source: me.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 96)
                        let uploading = busy
                        PhotosPicker(selection: $photo, matching: .images) {
                            avatar
                                .overlay {
                                    // A new picture on its way up.
                                    if uploading {
                                        Circle().fill(.black.opacity(0.45))
                                        ProgressView().tint(.white)
                                    }
                                }
                                .overlay(alignment: .bottomTrailing) {
                                    Image(systemName: "camera.fill")
                                        .font(.footnote)
                                        .foregroundStyle(Theme.text1)
                                        .frame(width: 30, height: 30)
                                        .background(Theme.bg4, in: .circle)
                                        .overlay(Circle().stroke(Theme.bg0, lineWidth: 2))
                                }
                        }
                        .accessibilityLabel(t("settings.profile.changePicture"))
                        Text("@\(me.username)").font(.subheadline).foregroundStyle(Theme.text2)
                        if me.avatar != nil {
                            Button(t("settings.profile.removePicture")) {
                                run { try await model.core.session(serverId).updateProfile(ProfileChanges(), avatar: .removed) }
                            }
                            .font(.footnote)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
            Section {
                TextField(t("settings.profile.displayName"), text: $displayName)
                    .textContentType(.name)
                    .onChange(of: displayName) { if displayName.count > 64 { displayName = String(displayName.prefix(64)) } }
                    .accessibilityIdentifier(A11y.Settings.displayName)
            } header: {
                Text(t("settings.profile.displayName"))
            }
            .listRowBackground(Theme.bg2)
            Section {
                TextField(t("settings.profile.bioPlaceholder"), text: $bio, axis: .vertical)
                    .lineLimit(2...6)
                    .onChange(of: bio) { if bio.count > 300 { bio = String(bio.prefix(300)) } }
                    .accessibilityIdentifier(A11y.Settings.bio)
            } header: {
                Text(t("settings.profile.bio"))
            } footer: {
                Text(server.map { t("settings.profile.lead", ["server": $0.entry.name]) } ?? t("settings.profile.bioHintNoServer"))
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.sections.profile"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(t("common.save")) {
                    run {
                        try await model.core.session(serverId).updateProfile(ProfileChanges(displayName: displayName.trimmingCharacters(in: .whitespaces), bio: bio))
                        model.toast(t("settings.profile.saved"))
                    }
                }
                .disabled(!dirty || displayName.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                .accessibilityIdentifier(A11y.Settings.save)
            }
        }
        .onAppear {
            guard !loaded, let me else { return }
            loaded = true
            displayName = me.displayName
            bio = me.bio
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            photo = nil
            run {
                guard let media = try await item.loadTransferable(type: PickedMedia.self) else { return }
                let url = media.url
                let file = try await Task.detached(priority: .userInitiated) { try OutgoingFiles.avatar(from: url) }.value
                try await model.core.session(serverId).updateProfile(ProfileChanges(), avatar: .set(file))
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        busy = true
        Task {
            do {
                try await action()
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
            busy = false
        }
    }
}

/// Read receipts and online status, per server, and what this device sends, as on the desktop.
struct PrivacyView: View {
    let serverId: String
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @State private var confirmingKeep = false
    /// Read again each time the row shows, as coming back from the proxy's screen.
    @State private var proxy = ProxyStore.load()

    var body: some View {
        let server = model.servers[serverId]
        let me = server?.selfUser
        List {
            Section {
                SavingToggle(t("settings.privacy.readReceipts"), value: server?.prefs.sendReadReceipts ?? true) { value in
                    try await model.core.session(serverId).updatePreferences(PreferenceChanges(sendReadReceipts: value))
                }
                .accessibilityIdentifier(A11y.Settings.readReceipts)
            } footer: {
                Text(t("settings.privacy.readReceiptsHint"))
            }
            Section {
                SavingToggle(t("settings.privacy.showOnline"), value: !(me?.hidesLastSeen ?? false)) { value in
                    try await model.core.session(serverId).setHideLastSeen(!value)
                }
                .accessibilityIdentifier(A11y.Settings.showOnline)
            } footer: {
                Text(t("settings.privacy.showOnlineHint"))
            }
            Section {
                let blocked = (server?.prefs.blocked ?? []).compactMap { server?.users[$0] }
                    .sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
                if blocked.isEmpty {
                    Text(t("settings.privacy.blockedEmpty"))
                        .foregroundStyle(Theme.text2)
                }
                ForEach(blocked) { user in
                    HStack(spacing: 12) {
                        AvatarView(name: user.displayName, seed: user.id, source: user.avatar.map { .avatar($0, serverId: serverId) } ?? .none, size: 32)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(user.displayName).foregroundStyle(Theme.text1)
                            Text("@\(user.username)").font(.caption).foregroundStyle(Theme.text3)
                        }
                        Spacer()
                        Button(t("settings.privacy.unblock")) { model.setBlocked(user.id, false, on: serverId) }
                            .buttonStyle(.borderless)
                    }
                }
            } header: {
                Text(t("settings.privacy.blocked"))
            } footer: {
                Text(t("settings.privacy.blockedHint"))
            }
            .accessibilityIdentifier(A11y.Settings.blocked)
            Section {
                NavigationLink { ProxySettingsView() } label: {
                    LabeledContent(t("settings.proxy.title"), value: proxy.on ? proxy.host : t("settings.privacy.proxyOff"))
                }
                .accessibilityIdentifier(A11y.Settings.proxy)
                .onAppear { proxy = ProxyStore.load() }
            } header: {
                Text(t("settings.privacy.onThisDevice"))
            } footer: {
                Text(t("settings.privacy.proxyHint"))
            }
            Section {
                Toggle(t("settings.privacy.linkPreviews"), isOn: Binding(get: { model.settings.linkPreviews }, set: { model.settings.linkPreviews = $0 }))
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.linkPreviews)
            } footer: {
                Text(t("settings.privacy.linkPreviewsHint"))
            }
            Section {
                // Turning it off waits for a yes, so the switch only follows the setting.
                Toggle(t("settings.privacy.removeMetadata"), isOn: Binding(get: { model.settings.removeMetadata }, set: { value in
                    if value { model.settings.removeMetadata = true } else { confirmingKeep = true }
                }))
                .tint(model.settings.accent.switchTint)
                .accessibilityIdentifier(A11y.Settings.removeMetadata)
            } footer: {
                Text(t("settings.privacy.removeMetadataHint"))
            }
            Section {
                @Bindable var voice = voice
                Toggle(t("settings.privacy.playYouTube"), isOn: $voice.playYouTube)
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.playYouTube)
            } footer: {
                Text(t("settings.privacy.playYouTubeHint"))
            }
        }
        .alert(t("settings.privacy.keepMetadataTitle"), isPresented: $confirmingKeep) {
            Button(t("common.cancel"), role: .cancel) {}
            Button(t("settings.privacy.keepMetadataTurnOff"), role: .destructive) { model.settings.removeMetadata = false }
        } message: {
            Text(t("settings.privacy.keepMetadataMessage"))
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.sections.privacy"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(ErrorText.describe(error), .error) }
        }
    }
}

/// Your key, devices, password and recovery key, as the desktop's Security section.
struct SecurityView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var devices: [DeviceView] = []
    @State private var current = ""
    @State private var next = ""
    @State private var confirm = ""
    @State private var rating = PasswordRating()
    @State private var recoveryPassword = ""
    @State private var recoveryKey: String?
    @State private var busy = false
    @State private var verifying = false
    @State private var removing: DeviceView?

    var body: some View {
        let strength = rating.strength
        List {
            Section {
                Button {
                    verifying = true
                } label: {
                    Label(t("settings.security.securityKey"), systemImage: "key")
                }
            } footer: {
                Text(t("settings.security.securityKeyHint"))
            }
            Section {
                ForEach(devices) { device in
                    HStack(spacing: 12) {
                        Image(systemName: device.name.lowercased().contains("iphone") || device.name.lowercased().contains("ipad") ? "iphone" : "laptopcomputer")
                            .foregroundStyle(Theme.text2)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(device.name).foregroundStyle(Theme.text1)
                                if device.isCurrent {
                                    Text(t("settings.devices.thisDevice")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.green)
                                }
                            }
                            Text(t("settings.security.signedIn", ["date": Format.full(device.createdAt)])).font(.caption).foregroundStyle(Theme.text3)
                        }
                        Spacer()
                        if !device.isCurrent {
                            Button(t("common.remove"), role: .destructive) { removing = device }
                                .buttonStyle(.borderless)
                                .font(.footnote)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(A11y.Settings.device(device.id))
                }
            } header: {
                Text(t("settings.devices.title"))
            } footer: {
                // A server that makes its own certificate needs its pin too, which only its links carry.
                if let address = model.servers[serverId]?.entry.address {
                    Text(sentence: t("settings.devices.addDevice"), drawing: ["address": Text(verbatim: address).font(.system(.footnote, design: .monospaced))])
                        .textSelection(.enabled)
                }
            }
            Section {
                SecureField(t("settings.security.currentPassword"), text: $current)
                    .textContentType(.password)
                    .accessibilityIdentifier(A11y.Settings.currentPassword)
                SecureField(t("settings.security.newPassword"), text: $next)
                    .textContentType(.newPassword)
                    .accessibilityIdentifier(A11y.Settings.newPassword)
                    .task(id: next) {
                        let me = model.servers[serverId]?.me
                        await rating.rate(next, related: [me?.username ?? "", me.flatMap { model.servers[serverId]?.users[$0.userId]?.displayName } ?? ""])
                    }
                SecureField(t("settings.security.confirmNewPassword"), text: $confirm)
                    .textContentType(.newPassword)
                    .accessibilityIdentifier(A11y.Settings.confirmPassword)
                Button(t("settings.security.changePassword")) { changePassword() }
                    .disabled(current.isEmpty || next.count < AccountRules.minimumPasswordLength || !rating.strongEnough || confirm != next || busy)
                    .accessibilityIdentifier(A11y.Settings.changePassword)
            } header: {
                Text(t("settings.security.changePassword"))
            } footer: {
                if AccountRules.confirmationError(next, confirmation: confirm) != nil {
                    Text(t("onboarding.password.mismatch")).foregroundStyle(Theme.red)
                } else {
                    Text(next.isEmpty ? t("settings.security.passwordMinimum", ["count": AccountRules.minimumPasswordLength]) : I18n.translate(strength.label))
                }
            }
            Section {
                if let recoveryKey {
                    Text(recoveryKey)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityIdentifier(A11y.Settings.recoveryKey)
                    Button(t("common.copy"), systemImage: "doc.on.doc") {
                        UIPasteboard.general.setItems([[UTType.plainText.identifier: recoveryKey]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)])
                        model.toast(t("common.copied"))
                    }
                } else {
                    SecureField(t("settings.security.currentPassword"), text: $recoveryPassword)
                        .textContentType(.password)
                        .accessibilityIdentifier(A11y.Settings.recoveryPassword)
                    Button(t("settings.security.newRecoveryKey")) { newRecoveryKey() }
                        .disabled(recoveryPassword.isEmpty || busy)
                        .accessibilityIdentifier(A11y.Settings.newRecoveryKey)
                }
            } header: {
                Text(t("settings.security.recoveryKey"))
            } footer: {
                Text(t("settings.security.recoveryKeyHint"))
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.sections.security"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.servers[serverId]?.users.count) { await refresh() }
        .sheet(isPresented: $verifying) {
            if let me = model.servers[serverId]?.me { VerifyView(serverId: serverId, userId: me.userId) }
        }
        .confirmationDialog(removing.map { t("settings.security.removeDeviceConfirm", ["device": $0.name]) } ?? t("settings.security.removeThisDeviceConfirm"), isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { device in
            Button(t("settings.security.removeDevice"), role: .destructive) {
                run {
                    try await model.core.session(serverId).revokeDevice(device.id)
                    await refresh()
                }
            }
        }
    }

    private func refresh() async {
        let all = (try? await model.core.session(serverId).getDevices()) ?? []
        devices = all.filter(\.isCurrent) + all.filter { !$0.isCurrent }
    }

    private func changePassword() {
        let current = current, next = next
        run {
            guard await rating.accepts(next) else { return }
            try await model.core.session(serverId).changePassword(current: current, next: next)
            self.current = ""
            self.next = ""
            confirm = ""
            model.toast(t("settings.security.passwordChanged"))
        }
    }

    private func newRecoveryKey() {
        let password = recoveryPassword
        run {
            recoveryKey = try await model.core.session(serverId).regenerateRecoveryKey(password: password)
            recoveryPassword = ""
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        busy = true
        Task {
            do { try await action() } catch { model.toast(ErrorText.describe(error), .error) }
            busy = false
        }
    }
}

/// Deleting the account on a server, once its password is typed, as the desktop's
/// "Delete account" does. What was sent stays with everyone who has it, from
/// "Deleted account".
struct DeleteAccountView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var confirming = false
    @State private var busy = false

    var body: some View {
        let server = model.servers[serverId]
        let name = server?.entry.name
        List {
            if let name, server?.me?.role == .owner {
                Section {
                    Text(t("settings.deleteAccount.owner", ["server": name]))
                        .foregroundStyle(Theme.text2)
                }
            } else {
                Section {
                    SecureField(t("common.password"), text: $password)
                        .textContentType(.password)
                        .accessibilityIdentifier(A11y.Settings.deleteAccountPassword)
                    Button(t("settings.deleteAccount.button"), role: .destructive) { confirming = true }
                        .disabled(password.isEmpty || busy)
                        .accessibilityIdentifier(A11y.Settings.deleteAccountButton)
                } footer: {
                    Text(name.map { t("settings.deleteAccount.hint", ["server": $0]) } ?? t("settings.deleteAccount.hintNoServer"))
                }
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.account.delete"))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(name.map { t("settings.deleteAccount.confirm", ["server": $0]) } ?? t("settings.deleteAccount.confirmNoServer"), isPresented: $confirming, titleVisibility: .visible) {
            Button(t("settings.account.delete"), role: .destructive) { delete() }
        }
    }

    private func delete() {
        let password = password
        busy = true
        Task {
            do {
                try await model.deleteAccount(serverId, password: password)
                dismiss()
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
            busy = false
        }
    }
}

/// Face ID, Touch ID or the passcode each time the app opens. New on iOS.
struct AppLockView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        // Face ID, Touch ID or Optic ID by its name, or the passcode, which is said in words of its own.
        let method = AppLock.biometryName
        let available = AppLock.available
        List {
            Section {
                Toggle(method.map { t("settings.appLock.lockWith", ["method": $0]) } ?? t("settings.appLock.lockWithPasscode"), isOn: Binding(get: { model.settings.appLock }, set: { value in
                    guard value else {
                        model.settings.appLock = false
                        return
                    }
                    Task {
                        // Turning it on proves the person can unlock, so nobody locks themselves out.
                        switch await AppLock.authenticate(reason: t("settings.appLock.turnOnReason")) {
                        case .unlocked: model.settings.appLock = true
                        case .unavailable: model.toast(t("settings.appLock.setPasscodeFirst"))
                        case .refused: break
                        }
                    }
                }))
                .tint(model.settings.accent.switchTint)
                .disabled(!available && !model.settings.appLock)
                .accessibilityIdentifier(A11y.Settings.lockToggle)
            } footer: {
                Text(!available ? t("settings.appLock.needsPasscode")
                    : method.map { t("settings.appLock.hint", ["method": $0]) } ?? t("settings.appLock.hintPasscode"))
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.appLock.title"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension AppLock {
    /// Face ID, Touch ID or Optic ID, by its name, which no language translates, or nil where the
    /// app unlocks with the passcode alone, which each text says in words of its own.
    static var biometryName: String? {
        let name = methodName
        return ["Face ID", "Touch ID", "Optic ID"].contains(name) ? name : nil
    }
}

/// The version, license and where to read more, as the desktop's About section.
struct AboutView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let server = model.activeServer
        List {
            Section {
                VStack(spacing: 10) {
                    ZunaLogo(size: 64)
                    Text("Zuna").font(.title.weight(.bold)).foregroundStyle(Theme.text1)
                    Text(t("settings.about.version", ["version": SettingsView.version]))
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
            Section {
                Label {
                    Text(Self.encryption(server))
                } icon: {
                    Image(systemName: "checkmark.shield.fill").foregroundStyle(Theme.green)
                }
                .font(.footnote)
                .foregroundStyle(Theme.text1)
            }
            .listRowBackground(Theme.bg2)
            Section {
                Link(destination: OnboardingText.projectURL) { Label(t("settings.about.sourceCode"), systemImage: "chevron.left.forwardslash.chevron.right") }
                Link(destination: OnboardingText.projectURL.appending(path: "blob/main/SECURITY.md")) { Label(t("settings.about.securityModel"), systemImage: "lock.shield") }
                Link(destination: OnboardingText.termsURL) { Label(t("settings.about.terms"), systemImage: "doc.text") }
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.sections.about"))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// How messages are encrypted, and which server this is, with its version once it's known.
    private static func encryption(_ server: AppModel.ServerState?) -> String {
        guard let server else { return t("settings.about.encryption") }
        guard let info = server.info else { return t("settings.about.encryptionConnected", ["server": server.entry.name]) }
        return t("settings.about.encryptionConnectedVersion", ["server": server.entry.name, "version": info.version])
    }
}
