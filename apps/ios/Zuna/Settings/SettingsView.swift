import SwiftUI
import UIKit
import ZunaModels

/// Settings, laid out like Telegram's: your profile on the active server at
/// the top, then grouped sections, as the desktop's settings and server
/// settings have them. With more than one server, a picker says which one the
/// account's sections are for. Notifications come later.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingSignOut = false
    @State private var confirmingUnlink = false
    /// Closes it, where it's a sheet, as on an iPad, which has no tab bar to leave it by.
    var onDone: (() -> Void)?

    var body: some View {
        NavigationStack {
            List {
                if model.hasServerList {
                    Section {
                        Picker("Server", selection: Binding(get: { model.activeServerId ?? "" }, set: { model.selectServer($0) })) {
                            ForEach(model.order, id: \.self) { id in
                                Text(model.servers[id]?.entry.name ?? "").tag(id)
                            }
                        }
                        .tint(Theme.text2)
                        .accessibilityIdentifier(A11y.Settings.serverPicker)
                    }
                    .listRowBackground(Theme.bg2)
                }
                if let server = model.activeServer, server.entry.isTelegram {
                    // The account's own settings are Telegram's app's (docs/TELEGRAM_PLAN.md).
                    Section {
                        header(server)
                    } footer: {
                        Text("Your Telegram account's name, privacy and devices are set in Telegram's own app.")
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                    }
                    .listRowBackground(Color.clear)
                } else if let server = model.activeServer {
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
                        NavigationLink { ServerDataView(serverId: server.entry.id) } label: {
                            SettingsLabel("Your data", systemImage: "externaldrive.fill", color: Color(hex: 0x5F6775))
                        }
                        .accessibilityIdentifier(A11y.Settings.serverData)
                    } footer: {
                        Text("These apply to \(server.entry.name). Each server you join has its own.")
                    }
                    .listRowBackground(Theme.bg2)
                }
                Section {
                    NavigationLink { NotificationSettingsView() } label: {
                        SettingsLabel("Notifications", systemImage: "bell.badge.fill", color: Color(hex: 0xD9534A))
                    }
                    .accessibilityIdentifier(A11y.Settings.notifications)
                    NavigationLink { VoiceSettingsView() } label: {
                        SettingsLabel("Voice and video", systemImage: "waveform", color: Color(hex: 0x3FA66B))
                    }
                    .accessibilityIdentifier(A11y.Settings.voice)
                    NavigationLink { AppearanceView() } label: {
                        SettingsLabel("Appearance", systemImage: "paintpalette.fill", color: Color(hex: 0x4B8FE0))
                    }
                    .accessibilityIdentifier(A11y.Settings.appearance)
                    NavigationLink { AppLockView() } label: {
                        SettingsLabel("App lock", systemImage: "faceid", color: Color(hex: 0xD9962A))
                    }
                    .accessibilityIdentifier(A11y.Settings.appLock)
                    if model.telegramAvailable || model.telegram != nil {
                        NavigationLink { TelegramConnectionsView() } label: {
                            SettingsLabel("Connections", systemImage: "bubble.left.and.bubble.right.fill", color: Color(hex: 0x3D8FD9))
                        }
                        .accessibilityIdentifier(A11y.Telegram.connections)
                    }
                }
                .listRowBackground(Theme.bg2)
                if let server = model.activeServer, server.entry.isTelegram {
                    Section {
                        Button(role: .destructive) {
                            confirmingUnlink = true
                        } label: {
                            SettingsLabel("Unlink Telegram", systemImage: "rectangle.portrait.and.arrow.right", color: Theme.red)
                        }
                        .accessibilityIdentifier(A11y.Telegram.unlink)
                    }
                    .listRowBackground(Theme.bg2)
                    .confirmationDialog(
                        "This signs Zuna out of your Telegram account and erases what it kept of it on this device. Your chats stay on Telegram.",
                        isPresented: $confirmingUnlink,
                        titleVisibility: .visible
                    ) {
                        Button("Unlink Telegram", role: .destructive) {
                            Task { await model.unlinkTelegram() }
                        }
                    }
                } else if let server = model.activeServer {
                    Section {
                        if server.me?.role != .member {
                            NavigationLink { ServerSettingsView(serverId: server.entry.id) } label: {
                                SettingsLabel("Server settings", systemImage: "server.rack", color: Color(hex: 0x5F6775))
                            }
                            .accessibilityIdentifier(A11y.Settings.server)
                        } else if BotsSettingsView.shows(server) {
                            // Someone who isn't an admin has their own bots here, where the server lets them make any.
                            NavigationLink { BotsSettingsView(serverId: server.entry.id) } label: {
                                SettingsLabel("Bots", systemImage: "cpu", color: Color(hex: 0x5F6775))
                            }
                        }
                        Button(role: .destructive) {
                            confirmingSignOut = true
                        } label: {
                            SettingsLabel("Sign out of \(server.entry.name)", systemImage: "rectangle.portrait.and.arrow.right", color: Theme.red)
                        }
                        .accessibilityIdentifier(A11y.Settings.signOut)
                        NavigationLink { DeleteAccountView(serverId: server.entry.id) } label: {
                            SettingsLabel("Delete account", systemImage: "trash.fill", color: Theme.red)
                        }
                        .accessibilityIdentifier(A11y.Settings.deleteAccount)
                    }
                    .listRowBackground(Theme.bg2)
                    .confirmationDialog(
                        Self.signOutWarning(server.entry.name),
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
                    if model.showsTelegram {
                        Label("Telegram's chats aren't end-to-end encrypted. Zuna's are.", systemImage: "lock.open")
                            .font(.footnote)
                    } else {
                        Label("Messages and files are end-to-end encrypted.", systemImage: "lock.fill")
                            .font(.footnote)
                    }
                }
                .listRowBackground(Theme.bg2)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg0)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg0, for: .navigationBar)
            .toolbar {
                if let onDone {
                    ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) }
                }
            }
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
                Text(me.username.isEmpty ? server.entry.name : "@\(me.username) · \(server.entry.name)")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// What signing out of a server does, before it's confirmed.
    static func signOutWarning(_ serverName: String) -> String {
        "This signs you out of \(serverName) on this device and erases its local copy of your messages. Your account and history stay on the server, and you can sign back in with your password."
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
