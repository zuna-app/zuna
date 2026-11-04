import SwiftUI

/// A row of buttons under a chat's picture and name, as in Telegram's profile
/// pages: calls, notifications, search and pins, which the chat's bar leaves out.
struct DetailsActions: View {
    struct Action: Identifiable {
        let id: String
        let title: String
        let icon: String
        var tint = Theme.text1
        var disabled = false
        let run: () -> Void
    }

    let actions: [Action]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(actions) { action in
                Button(action: action.run) {
                    VStack(spacing: 6) {
                        Image(systemName: action.icon)
                            .font(.system(size: 19, weight: .medium))
                            .frame(height: 24)
                        Text(action.title)
                            .font(.caption)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(action.disabled ? Theme.text3 : action.tint)
                    .frame(maxWidth: .infinity, minHeight: 66)
                    .background(Theme.bg2, in: .rect(cornerRadius: 14, style: .continuous))
                    .contentShape(.rect)
                }
                // Each its own button, rather than the whole row one, as a list row's buttons otherwise are.
                .buttonStyle(.plain)
                .disabled(action.disabled)
                .accessibilityIdentifier(A11y.Details.action(action.id))
            }
        }
    }
}
