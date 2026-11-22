import SwiftUI
import ZunaModels

/// Settings, Connections, as the desktop's (`ui/settings/connections.rs`): every server on this
/// device, in the list's order, with its icon, name, address and version, or how its connection
/// stands, and Leave, which asks first; then the accounts elsewhere that Zuna uses here, which is
/// Telegram, linked and unlinked here (docs/TELEGRAM_PLAN.md, Linking an account), with its own
/// settings under it. Nothing about those reaches a Zuna server.
struct ConnectionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @State private var leaving: String?
    @State private var unlinking = false

    var body: some View {
        let servers = model.order.compactMap { model.servers[$0] }.filter { !$0.entry.isTelegram }
        List {
            if !servers.isEmpty {
                Section {
                    ForEach(servers, id: \.entry.id) { server in
                        serverRow(server)
                    }
                } header: {
                    Text(t("settings.connections.servers"))
                }
                .listRowBackground(Theme.bg2)
            }
            Section {
                telegramRow
                // Why the linked account's engine isn't running, while it's tried again: its
                // chats only say they're connecting.
                if let problem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(Theme.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(A11y.Telegram.problem)
                }
                if model.telegram != nil {
                    Button(t("telegram.unlink.action"), role: .destructive) { unlinking = true }
                        .accessibilityIdentifier(A11y.Telegram.unlink)
                } else if model.telegramAvailable {
                    Button(t("telegram.connect")) { model.startLinkingTelegram() }
                        .accessibilityIdentifier(A11y.Servers.linkTelegram)
                }
            } header: {
                Text(t("settings.connections.otherAccounts"))
            } footer: {
                Text(t("settings.connections.otherAccountsHint"))
            }
            .listRowBackground(Theme.bg2)
            // Telegram's own "Accept calls" for this device (docs/TELEGRAM_CALLS_PLAN.md, The switch).
            if model.telegram != nil {
                Section {
                    Toggle(t("settings.connections.telegramCalls"), isOn: Binding(get: { voice.telegramTakesCalls ?? true }, set: { on in
                        Task { await voice.setTelegramTakesCalls(on) }
                    }))
                    .tint(model.settings.accent.switchTint)
                    .disabled(voice.telegramTakesCalls == nil)
                    .accessibilityIdentifier(A11y.Telegram.takesCalls)
                } footer: {
                    Text(t("settings.connections.telegramCallsHint"))
                }
                .listRowBackground(Theme.bg2)
            }
        }
        .task { await voice.readTelegramTakesCalls() }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.connections.title"))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            SettingsView.signOutWarning(leaving.flatMap { model.servers[$0]?.entry.name } ?? ""),
            isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }),
            titleVisibility: .visible,
            presenting: leaving
        ) { serverId in
            Button(t("settings.signOut.confirm"), role: .destructive) {
                Task { await model.signOut(serverId) }
            }
        }
        .confirmationDialog(
            t("telegram.unlink.confirm"),
            isPresented: $unlinking,
            titleVisibility: .visible
        ) {
            Button(t("telegram.unlink.action"), role: .destructive) {
                Task { await model.unlinkTelegram() }
            }
        }
    }

    /// A server: its icon, its name, its address on one line, its version or how its connection
    /// stands, and Leave.
    private func serverRow(_ server: AppModel.ServerState) -> some View {
        let id = server.entry.id
        return HStack(spacing: 12) {
            ServerIcon(entry: server.entry, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.entry.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.text1)
                    .lineLimit(1)
                Text(verbatim: server.entry.url.hasPrefix("https://") ? String(server.entry.url.dropFirst("https://".count)) : server.entry.url)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                status(server)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            }
            Spacer(minLength: 8)
            Button(t("settings.connections.leave"), role: .destructive) { leaving = id }
                .buttonStyle(.borderless)
                .font(.subheadline)
                .accessibilityIdentifier(A11y.Settings.leaveServer(id))
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Settings.connectionServer(id))
    }

    /// "Signed out", how a connection that isn't up stands, or the server's version once it is.
    @ViewBuilder
    private func status(_ server: AppModel.ServerState) -> some View {
        if server.entry.signedOut != nil {
            Text(t("settings.connections.signedOut"))
        } else {
            switch server.connection {
            case .connecting, .offline: dotted(model.waitingText(server.connection), Theme.amber)
            case .syncing: dotted(t("servers.connection.syncing"), Theme.amber)
            case .online:
                if let version = server.info?.version {
                    Text(t("settings.connections.serverVersion", ["version": version]))
                }
            }
        }
    }

    private func dotted(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text)
        }
    }

    /// The Telegram account: linked, as whom, and how its connection stands, or what linking one
    /// means where this build can.
    private var telegramRow: some View {
        HStack(alignment: .top, spacing: 12) {
            TelegramIcon(size: 40)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(verbatim: "Telegram")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text1)
                    if let telegram = model.telegram {
                        switch telegram.connection {
                        case .connecting, .offline: dotted(model.waitingText(telegram.connection), Theme.amber)
                        case .syncing: dotted(t("servers.connection.syncing"), Theme.amber)
                        case .online: dotted(t("settings.connections.connected"), Theme.green)
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(Theme.text2)
                Text(hint)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(A11y.Settings.connectionTelegram)
    }

    /// What linking the account means, or what's been linked, with what that means for its chats.
    private var hint: String {
        guard let telegram = model.telegram else {
            return model.telegramAvailable ? t("settings.connections.connectHint") : t("settings.connections.unavailable")
        }
        guard let me = telegram.selfUser else { return t("settings.connections.linked") }
        return me.username.isEmpty
            ? t("settings.connections.linkedAs", ["name": me.displayName])
            : t("settings.connections.linkedAsWithUsername", ["name": me.displayName, "username": me.username])
    }

    /// What the core last said stopped the linked account's engine, until it starts again.
    private var problem: String? {
        guard model.telegram != nil, case let .failed(reason)? = model.telegramLink else { return nil }
        return reason
    }
}
