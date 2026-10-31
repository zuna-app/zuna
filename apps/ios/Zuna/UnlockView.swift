import SwiftUI
import ZunaHost

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
            Text("Unlock Zuna")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Text("Your phone restarted. Enter your password to unlock your messages.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if accounts.count > 1 {
                Picker("Account", selection: $selected) {
                    ForEach(accounts.indices, id: \.self) { index in
                        Text("\(accounts[index].username) on \(accounts[index].serverName)").tag(index)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier(A11y.Unlock.account)
            } else if let account = accounts.first {
                Text("\(account.username) on \(account.serverName)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            SecureField("Password", text: $password)
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(unlock)
                .padding(12)
                .background(Color(white: 0.16), in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(.white)
                .accessibilityIdentifier(A11y.Unlock.password)

            if wrong {
                Text("That password isn't right.")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(A11y.Unlock.error)
            }

            Button(action: unlock) {
                Group {
                    if busy {
                        ProgressView().tint(.black)
                    } else {
                        Text("Unlock").fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 22)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(white: 0.93))
            .foregroundStyle(.black)
            .disabled(password.isEmpty || busy)
            .accessibilityIdentifier(A11y.Unlock.submit)

            Button("Forgot your password?") { confirmErase = true }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(A11y.Unlock.forgot)
        }
        .padding(28)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Unlock.screen)
        .frame(maxWidth: 420)
        .onAppear { focused = true }
        .alert("Sign in again?", isPresented: $confirmErase) {
            Button("Erase and sign in", role: .destructive) {
                Task { await core.eraseAndStartOver() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Nobody can reset your password from this phone. Erasing removes what's stored here; your messages stay on your server and come back when you sign in with a new password or your recovery key.")
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
