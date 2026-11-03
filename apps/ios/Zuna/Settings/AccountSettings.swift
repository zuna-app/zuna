import LocalAuthentication
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
                        PhotosPicker(selection: $photo, matching: .images) {
                            avatar
                                .overlay(alignment: .bottomTrailing) {
                                    Image(systemName: "camera.fill")
                                        .font(.footnote)
                                        .foregroundStyle(Theme.text1)
                                        .frame(width: 30, height: 30)
                                        .background(Theme.bg4, in: .circle)
                                        .overlay(Circle().stroke(Theme.bg0, lineWidth: 2))
                                }
                        }
                        .accessibilityLabel("Change profile picture")
                        Text("@\(me.username)").font(.subheadline).foregroundStyle(Theme.text2)
                        if me.avatar != nil {
                            Button("Remove picture") {
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
                TextField("Display name", text: $displayName)
                    .textContentType(.name)
                    .onChange(of: displayName) { if displayName.count > 64 { displayName = String(displayName.prefix(64)) } }
                    .accessibilityIdentifier(A11y.Settings.displayName)
            } header: {
                Text("Display name")
            }
            .listRowBackground(Theme.bg2)
            Section {
                TextField("A few words about you", text: $bio, axis: .vertical)
                    .lineLimit(2...6)
                    .onChange(of: bio) { if bio.count > 300 { bio = String(bio.prefix(300)) } }
                    .accessibilityIdentifier(A11y.Settings.bio)
            } header: {
                Text("Bio")
            } footer: {
                Text("Only members of \(server?.entry.name ?? "this server") can see this. Your server stores it encrypted.")
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    run {
                        try await model.core.session(serverId).updateProfile(ProfileChanges(displayName: displayName.trimmingCharacters(in: .whitespaces), bio: bio))
                        model.toast("Profile saved")
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
                let file = try OutgoingFiles.avatar(from: media.url)
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
                model.toast(OnboardingText.describe(error), .error)
            }
            busy = false
        }
    }
}

/// Read receipts and online status, per server, and what this device sends, as on the desktop.
struct PrivacyView: View {
    let serverId: String
    @Environment(AppModel.self) private var model
    @State private var confirmingKeep = false

    var body: some View {
        let server = model.servers[serverId]
        let me = server?.selfUser
        List {
            Section {
                Toggle("Send read receipts", isOn: Binding(get: { server?.prefs.sendReadReceipts ?? true }, set: { value in
                    run { try await model.core.session(serverId).updatePreferences(PreferenceChanges(sendReadReceipts: value)) }
                }))
                .tint(model.settings.accent.switchTint)
                .accessibilityIdentifier(A11y.Settings.readReceipts)
            } footer: {
                Text("Others see when you've read their messages. If off, your devices still stay in sync.")
            }
            Section {
                Toggle("Show when I'm online", isOn: Binding(get: { !(me?.hidesLastSeen ?? false) }, set: { value in
                    run { try await model.core.session(serverId).setHideLastSeen(!value) }
                }))
                .tint(model.settings.accent.switchTint)
                .accessibilityIdentifier(A11y.Settings.showOnline)
            } footer: {
                Text("If off, people see \u{201C}last seen recently\u{201D} instead of your status.")
            }
            Section {
                let blocked = (server?.prefs.blocked ?? []).compactMap { server?.users[$0] }
                    .sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
                if blocked.isEmpty {
                    Text("Nobody. You can block someone from their details in a chat, or from a group's members.")
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
                        Button("Unblock") { model.setBlocked(user.id, false, on: serverId) }
                            .buttonStyle(.borderless)
                    }
                }
            } header: {
                Text("Blocked people")
            } footer: {
                Text("You don't see messages from people you block, or hear about them. Nobody is told, and your server can't see who you block.")
            }
            .accessibilityIdentifier(A11y.Settings.blocked)
            Section {
                Toggle("Link previews", isOn: Binding(get: { model.settings.linkPreviews }, set: { model.settings.linkPreviews = $0 }))
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.linkPreviews)
            } header: {
                Text("On this device")
            } footer: {
                Text("When you write a link, this device fetches the page to show its title and picture, and sends them encrypted with your message. The site sees your address, as when you open a link. Your server never sees it.")
            }
            Section {
                // Turning it off waits for a yes, so the switch only follows the setting.
                Toggle("Remove metadata from files", isOn: Binding(get: { model.settings.removeMetadata }, set: { value in
                    if value { model.settings.removeMetadata = true } else { confirmingKeep = true }
                }))
                .tint(model.settings.accent.switchTint)
                .accessibilityIdentifier(A11y.Settings.removeMetadata)
            } footer: {
                Text("Before a file is sent, this device takes out where and when it was made, the camera or phone and its serial number, the program, and editing history. Photos: JPEG, PNG, WebP, GIF, HEIC and AVIF. Videos: MP4, MOV, 3GP, WebM and MKV. Drawings: SVG. Other files are sent as they are.")
            }
        }
        .alert("Send files with their metadata?", isPresented: $confirmingKeep) {
            Button("Cancel", role: .cancel) {}
            Button("Turn Off", role: .destructive) { model.settings.removeMetadata = false }
        } message: {
            Text("Photos and videos from phones usually record where they were taken, to within a few meters, and when. With this off, everyone in a chat you send them to can see that, along with the camera or phone and its serial number, the program used, and what was changed in it. So can anyone they pass the files on to.\n\nYour server still can't see any of it, as files are encrypted. This is only for this device, and for files you send from now on.")
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { model.toast(OnboardingText.describe(error), .error) }
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
                    Label("Your security key", systemImage: "key")
                }
            } footer: {
                Text("Compare it with friends to prove nobody is in between.")
            }
            Section("Your devices on this server") {
                ForEach(devices) { device in
                    HStack(spacing: 12) {
                        Image(systemName: device.name.lowercased().contains("iphone") || device.name.lowercased().contains("ipad") ? "iphone" : "laptopcomputer")
                            .foregroundStyle(Theme.text2)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(device.name).foregroundStyle(Theme.text1)
                                if device.isCurrent {
                                    Text("This device").font(.caption2.weight(.semibold)).foregroundStyle(Theme.green)
                                }
                            }
                            Text("Signed in \(Format.full(device.createdAt))").font(.caption).foregroundStyle(Theme.text3)
                        }
                        Spacer()
                        if !device.isCurrent {
                            Button("Remove", role: .destructive) { removing = device }
                                .buttonStyle(.borderless)
                                .font(.footnote)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(A11y.Settings.device(device.id))
                }
            }
            Section {
                SecureField("Current password", text: $current)
                    .textContentType(.password)
                    .accessibilityIdentifier(A11y.Settings.currentPassword)
                SecureField("New password", text: $next)
                    .textContentType(.newPassword)
                    .accessibilityIdentifier(A11y.Settings.newPassword)
                    .task(id: next) {
                        let me = model.servers[serverId]?.me
                        await rating.rate(next, related: [me?.username ?? "", me.flatMap { model.servers[serverId]?.users[$0.userId]?.displayName } ?? ""])
                    }
                Button("Change password") { changePassword() }
                    .disabled(current.isEmpty || next.count < AccountRules.minimumPasswordLength || !rating.accepts(next) || busy)
                    .accessibilityIdentifier(A11y.Settings.changePassword)
            } header: {
                Text("Change password")
            } footer: {
                Text(next.isEmpty ? "At least \(AccountRules.minimumPasswordLength) characters." : strength.label)
            }
            Section {
                if let recoveryKey {
                    Text(recoveryKey)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityIdentifier(A11y.Settings.recoveryKey)
                    Button("Copy", systemImage: "doc.on.doc") {
                        UIPasteboard.general.setItems([[UTType.plainText.identifier: recoveryKey]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)])
                        model.toast("Copied")
                    }
                } else {
                    SecureField("Current password", text: $recoveryPassword)
                        .textContentType(.password)
                        .accessibilityIdentifier(A11y.Settings.recoveryPassword)
                    Button("Create new recovery key") { newRecoveryKey() }
                        .disabled(recoveryPassword.isEmpty || busy)
                        .accessibilityIdentifier(A11y.Settings.newRecoveryKey)
                }
            } header: {
                Text("Recovery key")
            } footer: {
                Text("Create a new key if you've lost the old one or think someone saw it. The old key stops working immediately.")
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Security")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.servers[serverId]?.users.count) { await refresh() }
        .sheet(isPresented: $verifying) {
            if let me = model.servers[serverId]?.me { VerifyView(serverId: serverId, userId: me.userId) }
        }
        .confirmationDialog("Remove \(removing?.name ?? "this device")? It's signed out and can't read new messages.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { device in
            Button("Remove device", role: .destructive) {
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
            try await model.core.session(serverId).changePassword(current: current, next: next)
            self.current = ""
            self.next = ""
            model.toast("Password changed")
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
            do { try await action() } catch { model.toast(OnboardingText.describe(error), .error) }
            busy = false
        }
    }
}

/// Face ID, Touch ID or the passcode each time the app opens. New on iOS.
struct AppLockView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let method = AppLock.methodName
        List {
            Section {
                Toggle("Lock with \(method)", isOn: Binding(get: { model.settings.appLock }, set: { value in
                    Task {
                        // Turning it on proves the person can unlock, so nobody locks themselves out.
                        let allowed = value ? await AppLock.authenticate(reason: "Turn on App lock") : true
                        if allowed { model.settings.appLock = value }
                    }
                }))
                .tint(model.settings.accent.switchTint)
                .accessibilityIdentifier(A11y.Settings.lockToggle)
            } footer: {
                Text("Zuna asks for \(method) each time it opens, and hides your chats in the app switcher. After the phone restarts, your Zuna password is still needed once.")
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("App lock")
        .navigationBarTitleDisplayMode(.inline)
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
                    Text("Version \(SettingsView.version) · Free software under the AGPL-3.0 license")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
            Section {
                Label {
                    Text("Messages use MLS (RFC 9420) through the independently audited OpenMLS library. Your server stores only ciphertext." + (server.map { " Connected to \($0.entry.name)" + ($0.info.map { ", running server version \($0.version)." } ?? ".") } ?? ""))
                } icon: {
                    Image(systemName: "checkmark.shield.fill").foregroundStyle(Theme.green)
                }
                .font(.footnote)
                .foregroundStyle(Theme.text1)
            }
            .listRowBackground(Theme.bg2)
            Section {
                Link(destination: OnboardingText.projectURL) { Label("Source code", systemImage: "chevron.left.forwardslash.chevron.right") }
                Link(destination: OnboardingText.projectURL.appending(path: "blob/main/SECURITY.md")) { Label("Security model", systemImage: "lock.shield") }
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Unlocking with the device's owner authentication: Face ID, Touch ID or the passcode.
enum AppLock {
    static var methodName: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "your passcode"
        }
    }

    @MainActor
    static func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}
