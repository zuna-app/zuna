import SwiftUI
import ZunaHost
import ZunaModels

/// Shown once after every restart of the phone: the device key stays locked
/// until someone enters the Zuna password of an account on this device.
struct UnlockView: View {
    @Environment(CoreController.self) private var core
    @State private var selected = 0
    @State private var password = ""
    @State private var busy = false
    @State private var wrong = false
    @State private var confirmErase = false
    @FocusState private var focused: Bool

    var body: some View {
        let accounts = core.lockedAccounts
        VStack(spacing: 16) {
            Image(systemName: "lock.fill")
                .font(.system(size: 30))
                .foregroundStyle(.white)
            Text(t("onboarding.unlock.title"))
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Text(t("onboarding.unlock.lead"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if accounts.count > 1 {
                Picker(t("onboarding.unlock.account"), selection: $selected) {
                    ForEach(accounts.indices, id: \.self) { index in
                        Text(t("onboarding.unlock.accountOn", ["username": accounts[index].username, "server": accounts[index].serverName])).tag(index)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier(A11y.Unlock.account)
            } else if let account = accounts.first {
                Text(t("onboarding.unlock.accountOn", ["username": account.username, "server": account.serverName]))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            SecureField(t("common.password"), text: $password)
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(unlock)
                .padding(12)
                .background(Color(white: 0.16), in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(.white)
                .accessibilityIdentifier(A11y.Unlock.password)

            if wrong {
                Text(t("onboarding.unlock.wrongPassword"))
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(A11y.Unlock.error)
            }

            Button(action: unlock) {
                Group {
                    if busy {
                        ProgressView().tint(.black)
                    } else {
                        Text(t("onboarding.unlock.button")).fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 22)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(white: 0.93))
            .foregroundStyle(.black)
            .disabled(password.isEmpty || busy)
            .accessibilityIdentifier(A11y.Unlock.submit)

            Button(t("onboarding.signIn.forgot")) { confirmErase = true }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(A11y.Unlock.forgot)
        }
        .padding(28)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Unlock.screen)
        .frame(maxWidth: 420)
        .onAppear { focused = true }
        .alert(t("onboarding.unlock.eraseTitle"), isPresented: $confirmErase) {
            Button(t("onboarding.unlock.erase"), role: .destructive) {
                Task { await core.eraseAndStartOver() }
            }
            Button(t("common.cancel"), role: .cancel) {}
        } message: {
            Text(t("onboarding.unlock.eraseMessage"))
        }
    }

    private func unlock() {
        guard !password.isEmpty, !busy, core.lockedAccounts.indices.contains(selected) else { return }
        busy = true
        wrong = false
        Task {
            let unlocked = await core.unlock(core.lockedAccounts[selected], password: password)
            busy = false
            if !unlocked {
                wrong = true
                password = ""
                focused = true
            }
        }
    }
}
