import SwiftUI
import ZunaModels

/// Settings, laid out like Telegram's: the account on the active server at the
/// top, then grouped sections. Profile, privacy, devices and the rest come in
/// F6; appearance is here from the start, since it applies to every screen.
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                if let server = model.activeServer {
                    Section { header(server) }
                        .listRowBackground(Color.clear)
                }
                Section {
                    NavigationLink {
                        AppearanceView()
                    } label: {
                        SettingsLabel("Appearance", systemImage: "paintpalette.fill", color: Color(hex: 0x4B8FE0))
                    }
                    .accessibilityIdentifier(A11y.Settings.appearance)
                }
                .listRowBackground(Theme.bg2)
                Section {
                    LabeledContent("Version", value: Self.version)
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
        .accessibilityElement(children: .combine)
    }

    private static var version: String {
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
                Text("Fewer animations when opening chats and the server drawer.")
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}
