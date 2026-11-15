import SwiftUI
import ZunaModels

/// Settings, Connections: the Telegram account linked on this device, or a way to link one, and
/// what that means (docs/TELEGRAM_PLAN.md, Linking an account).
struct TelegramConnectionsView: View {
    @Environment(AppModel.self) private var model
    @State private var unlinking = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    TelegramIcon(size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Telegram")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Theme.text1)
                        Text(status)
                            .font(.subheadline)
                            .foregroundStyle(Theme.text2)
                    }
                }
                .padding(.vertical, 4)
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
                } else {
                    Button(t("telegram.connect")) { model.startLinkingTelegram() }
                        .accessibilityIdentifier(A11y.Servers.linkTelegram)
                }
            } footer: {
                Text(t("telegram.connections.hint"))
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.connections.title"))
        .navigationBarTitleDisplayMode(.inline)
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

    /// What the core last said stopped the linked account's engine, until it starts again.
    private var problem: String? {
        guard model.telegram != nil, case let .failed(reason)? = model.telegramLink else { return nil }
        return reason
    }

    private var status: String {
        guard let telegram = model.telegram else { return t("telegram.connections.notLinked") }
        let me = telegram.selfUser
        return me.map { t("telegram.connections.linkedAs", ["name": $0.username.isEmpty ? $0.displayName : "@\($0.username)"]) } ?? t("telegram.connections.linked")
    }
}
