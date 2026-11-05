import SwiftUI
import ZunaModels

/// Comparing sixteen emoji with someone, as the desktop's verification does:
/// matching emoji mean nobody, the server included, is in between.
struct VerifyView: View {
    let serverId: String
    let userId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var check: SafetyCheck?
    @State private var busy = false

    var body: some View {
        let server = model.servers[serverId]
        let user = server?.users[userId]
        let isSelf = userId == server?.me?.userId
        let trust = check?.trust ?? user?.trust ?? .unverified
        let name = user?.displayName ?? "them"
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    notice(trust: trust, name: name, isSelf: isSelf)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 14) {
                        ForEach(Array((check?.emoji ?? []).enumerated()), id: \.offset) { _, item in
                            VStack(spacing: 4) {
                                Text(item.emoji).font(.system(size: 36))
                                Text(item.name).font(.caption).foregroundStyle(Theme.text2).lineLimit(1).minimumScaleFactor(0.7)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Theme.bg2, in: .rect(cornerRadius: 12, style: .continuous))
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(A11y.Verify.emoji)
                    if !isSelf {
                        actions(trust: trust, name: name)
                    }
                }
                .padding(20)
            }
            .background(Theme.bg1)
            .navigationTitle(isSelf ? "Your security key" : "Verify \(name) (@\(user?.username ?? ""))")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task(id: user?.trust) {
                check = try? await model.core.session(serverId).safetyCheck(userId)
            }
        }
        .accessibilityIdentifier(A11y.Verify.screen)
    }

    @ViewBuilder
    private func notice(trust: TrustState, name: String, isSelf: Bool) -> some View {
        switch trust {
        case .changed:
            Label {
                Text("\(Text("\(name)'s security key changed").bold()) in a way that doesn't follow from the one before, so this may mean someone is intercepting your messages. Only continue after comparing these emoji with them directly.")
            } icon: {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.amber)
            }
            .font(.subheadline)
            .foregroundStyle(Theme.text1)
            .padding(12)
            .background(Theme.amber.opacity(0.12), in: .rect(cornerRadius: 12))
        case .verified:
            Label("You've verified \(name). Nobody can quietly get between you.", systemImage: "checkmark.shield.fill")
                .font(.subheadline)
                .foregroundStyle(Theme.text1)
                .padding(12)
                .background(Theme.green.opacity(0.12), in: .rect(cornerRadius: 12))
        case .unverified:
            Text(isSelf
                ? "These are your emoji. Someone verifying you compares them with what they see."
                : "Compare these emoji with \(name) in person or on a call. If they match exactly, nobody, including this server, is reading your conversation.")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
        }
    }

    @ViewBuilder
    private func actions(trust: TrustState, name: String) -> some View {
        if trust == .verified {
            Button("Remove verification") {
                run { try await model.core.session(serverId).clearVerification(userId) }
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier(A11y.Verify.remove)
        } else {
            HStack(spacing: 10) {
                Button {
                    model.toast("Don't share anything private with them until you know why the emoji differ.", .security)
                    dismiss()
                } label: {
                    Label("They don't match", systemImage: "exclamationmark.triangle").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier(A11y.Verify.mismatch)
                Button {
                    run {
                        guard let covers = check?.covers else { return }
                        do {
                            try await model.core.session(serverId).markVerified(userId, covers: covers)
                        } catch {
                            // Whatever changed, these are no longer the emoji to compare.
                            check = try? await model.core.session(serverId).safetyCheck(userId)
                            throw error
                        }
                        model.toast("\(name) is verified")
                        dismiss()
                    }
                } label: {
                    Label("They match", systemImage: "checkmark.seal.fill").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(model.settings.accent.color)
                .foregroundStyle(model.settings.accent.onAccent)
                // Until the emoji are here, there's nothing to say matches.
                .disabled(check == nil)
                .accessibilityIdentifier(A11y.Verify.match)
            }
            .disabled(busy)
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
