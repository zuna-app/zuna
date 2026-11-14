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
                if model.telegram != nil {
                    Button("Unlink Telegram", role: .destructive) { unlinking = true }
                        .accessibilityIdentifier(A11y.Telegram.unlink)
                } else {
                    Button("Connect Telegram") { model.startLinkingTelegram() }
                        .accessibilityIdentifier(A11y.Servers.linkTelegram)
                }
            } footer: {
                Text("Zuna signs in to your own Telegram account as another device, using Telegram's API. Zuna isn't made by Telegram, these chats aren't end-to-end encrypted, and no Zuna server hears of them.")
            }
            .listRowBackground(Theme.bg2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Connections")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "This signs Zuna out of your Telegram account and erases what it kept of it on this device. Your chats stay on Telegram.",
            isPresented: $unlinking,
            titleVisibility: .visible
        ) {
            Button("Unlink Telegram", role: .destructive) {
                Task { await model.unlinkTelegram() }
            }
        }
    }

    private var status: String {
        guard let telegram = model.telegram else { return "Not linked" }
        let me = telegram.selfUser
        return me.map { $0.username.isEmpty ? "Linked as \($0.displayName)" : "Linked as @\($0.username)" } ?? "Linked"
    }
}
