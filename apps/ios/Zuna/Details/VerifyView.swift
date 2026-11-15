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
        let name = user?.displayName ?? t("verify.them")
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    if !isSelf, let username = user?.username {
                        Text("@\(username)")
                            .font(.subheadline)
                            .foregroundStyle(Theme.text2)
                            .accessibilityIdentifier(A11y.Verify.username)
                    }
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
            // The username goes just under the title, as a long name with it no longer fit the bar.
            .navigationTitle(isSelf ? t("verify.ownTitle") : t("verify.titleNamed", ["name": name]))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(t("common.close")) { dismiss() } } }
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
                // Markdown's bold, around the first words in English, wherever the language puts them.
                Text(Self.markdown(t("verify.changedMarkdown", ["name": Self.escaped(name)])))
            } icon: {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.amber)
            }
            .font(.subheadline)
            .foregroundStyle(Theme.text1)
            .padding(12)
            .background(Theme.amber.opacity(0.12), in: .rect(cornerRadius: 12))
        case .verified:
            Label(t("verify.verified", ["name": name]), systemImage: "checkmark.shield.fill")
                .font(.subheadline)
                .foregroundStyle(Theme.text1)
                .padding(12)
                .background(Theme.green.opacity(0.12), in: .rect(cornerRadius: 12))
        case .unverified:
            Text(isSelf
                ? t("verify.selfHint")
                : t("verify.compare", ["name": name]))
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
        }
    }

    /// A sentence written in markdown, as only its bold is.
    private static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    /// A name to put in markdown, which shows it as it's written, whatever marks it has.
    private static func escaped(_ name: String) -> String {
        String(name.flatMap { character -> [Character] in
            character.isASCII && (character.isPunctuation || character.isSymbol) ? ["\\", character] : [character]
        })
    }

    @ViewBuilder
    private func actions(trust: TrustState, name: String) -> some View {
        if trust == .verified {
            Button(t("verify.remove")) {
                run { try await model.core.session(serverId).clearVerification(userId) }
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier(A11y.Verify.remove)
        } else {
            HStack(spacing: 10) {
                Button {
                    model.toast(t("verify.mismatchToast"), .security)
                    dismiss()
                } label: {
                    Label(t("verify.noMatch"), systemImage: "exclamationmark.triangle").frame(maxWidth: .infinity, minHeight: 44)
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
                        model.toast(t("verify.verifiedToast", ["name": name]))
                        dismiss()
                    }
                } label: {
                    Label(t("verify.match"), systemImage: "checkmark.seal.fill").frame(maxWidth: .infinity, minHeight: 44)
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
                model.toast(ErrorText.describe(error), .error)
            }
            busy = false
        }
    }
}
