import SwiftUI
import ZunaModels

/// Settings, laid out like Telegram's: your profile on the active server at
/// the top, then grouped sections, as the desktop's settings and server
/// settings have them. Notifications come later.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            List {
                if let server = model.activeServer {
                    Section {
                        NavigationLink {
                            ProfileView(serverId: server.entry.id)
                        } label: {
                            header(server)
                        }
                        .accessibilityIdentifier(A11y.Settings.profile)
                    }
                    .listRowBackground(Color.clear)
                    Section {
                        NavigationLink { PrivacyView(serverId: server.entry.id) } label: {
                            SettingsLabel("Privacy", systemImage: "hand.raised.fill", color: Color(hex: 0x6B6470))
                        }
                        .accessibilityIdentifier(A11y.Settings.privacy)
                        NavigationLink { SecurityView(serverId: server.entry.id) } label: {
                            SettingsLabel("Security", systemImage: "key.fill", color: Color(hex: 0x3FA772))
                        }
                        .accessibilityIdentifier(A11y.Settings.security)
                    } footer: {
                        Text("These apply to \(server.entry.name). Each server you join has its own.")
                    }
                    .listRowBackground(Theme.bg2)
                }
                Section {
                    NavigationLink { AppearanceView() } label: {
                        SettingsLabel("Appearance", systemImage: "paintpalette.fill", color: Color(hex: 0x4B8FE0))
                    }
                    .accessibilityIdentifier(A11y.Settings.appearance)
                    NavigationLink { AppLockView() } label: {
                        SettingsLabel("App lock", systemImage: "faceid", color: Color(hex: 0xD9962A))
                    }
                    .accessibilityIdentifier(A11y.Settings.appLock)
                }
                .listRowBackground(Theme.bg2)
                if let server = model.activeServer {
                    Section {
                        if server.me?.role != .member {
                            NavigationLink { ServerSettingsView(serverId: server.entry.id) } label: {
                                SettingsLabel("Server settings", systemImage: "server.rack", color: Color(hex: 0x5F6775))
                            }
                            .accessibilityIdentifier(A11y.Settings.server)
                        }
                        Button(role: .destructive) {
                            confirmingSignOut = true
                        } label: {
                            SettingsLabel("Sign out of \(server.entry.name)", systemImage: "rectangle.portrait.and.arrow.right", color: Theme.red)
                        }
                        .accessibilityIdentifier(A11y.Settings.signOut)
                    }
                    .listRowBackground(Theme.bg2)
                    .confirmationDialog(
                        "This signs you out of \(server.entry.name) on this device and erases its local copy of your messages. Your account and history stay on the server, and you can sign back in with your password.",
                        isPresented: $confirmingSignOut,
                        titleVisibility: .visible
                    ) {
                        Button("Sign out and erase local data", role: .destructive) {
                            Task { await model.signOut(server.entry.id) }
                        }
                    }
                }
                Section {
                    NavigationLink { AboutView() } label: {
                        SettingsLabel("About Zuna", systemImage: "info.circle.fill", color: Color(hex: 0x5B6B7A))
                    }
                    .accessibilityIdentifier(A11y.Settings.about)
                } footer: {
                    Label("Messages and files are end-to-end encrypted.", systemImage: "lock.fill")
                        .font(.footnote)
                }
                .listRowBackground(Theme.bg2)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg0)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg1, for: .navigationBar)
            .accessibilityIdentifier(A11y.Settings.screen)
        }
    }

    private func header(_ server: AppModel.ServerState) -> some View {
        VStack(spacing: 6) {
            if let me = server.selfUser {
                AvatarView(
                    name: me.displayName,
                    seed: me.id,
                    source: me.avatar.map { .avatar($0, serverId: server.entry.id) } ?? .none,
                    size: 96
                )
                .padding(.bottom, 6)
                Text(me.displayName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Theme.text1)
                Text("@\(me.username) · \(server.entry.name)")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
            }
        }
        .frame(maxWidth: .infinity)
    }

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }
}

/// A settings row with a colored icon, as in Telegram.
struct SettingsLabel: View {
    let title: String
    let systemImage: String
    let color: Color

    init(_ title: String, systemImage: String, color: Color) {
        self.title = title
        self.systemImage = systemImage
        self.color = color
    }

    var body: some View {
        Label {
            Text(title).foregroundStyle(Theme.text1)
        } icon: {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: 29, height: 29)
                .background(color, in: .rect(cornerRadius: 7, style: .continuous))
        }
    }
}

/// The accent, message size and motion, kept on this device as on the desktop.
struct AppearanceView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List {
            Section("Accent") {
                HStack(spacing: 0) {
                    ForEach(Accent.allCases, id: \.self) { accent in
                        Button {
                            model.settings.accent = accent
                        } label: {
                            Circle()
                                .fill(accent.color)
                                .frame(width: 36, height: 36)
                                .overlay {
                                    if model.settings.accent == accent {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 15, weight: .bold))
                                            .foregroundStyle(accent.onAccent)
                                    }
                                }
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(accent.rawValue.capitalized)
                        .accessibilityAddTraits(model.settings.accent == accent ? .isSelected : [])
                        .accessibilityIdentifier(A11y.Settings.accent(accent.rawValue))
                    }
                }
                .padding(.vertical, 6)
            }
            Section("Message size") {
                Picker("Message size", selection: $model.settings.messageSize) {
                    Text("Small").tag(MessageSize.small)
                    Text("Medium").tag(MessageSize.medium)
                    Text("Large").tag(MessageSize.large)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            Section {
                Toggle("Reduce motion", isOn: $model.settings.reduceMotion)
                    .tint(model.settings.accent.switchTint)
            } footer: {
                Text("Turns off most animations. It's also on when Reduce Motion is on in the system's settings.")
            }
            Section {
                Toggle("Return sends", isOn: $model.settings.enterToSend)
                    .tint(model.settings.accent.switchTint)
            } footer: {
                Text("On a hardware keyboard: Return sends and Shift-Return makes a new line. If off, Return makes a new line and Command-Return sends. The on-screen keyboard's Return always makes a new line.")
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}
