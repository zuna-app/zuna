import SwiftUI
import ZunaModels

/// Joining a server, signing in, or getting back in with the recovery key: the
/// first screens of the app, and the sheet for joining another server. The
/// same steps as the desktop's onboarding, laid out like Telegram's sign-in.
struct JoinFlow: View {
    enum Step: Hashable {
        case invite(InvitePreview)
        case recoveryKey(serverId: String, key: String, setup: Bool)
        case nameServer(serverId: String)
        case signIn(url: String?)
        case recover(url: String, username: String)

        /// Past the account's creation, where going back would lose the recovery key.
        var isAfterSignUp: Bool {
            switch self {
            case .recoveryKey, .nameServer: true
            default: false
            }
        }
    }

    /// Inside the app, for another server, rather than the first run.
    let embedded: Bool
    @Environment(AppModel.self) private var model
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            StartStep(embedded: embedded) { preview in
                path.append(.invite(preview))
            } onSignIn: {
                path.append(.signIn(url: nil))
            }
            .toolbar {
                if embedded {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { model.joining = false }
                            .accessibilityIdentifier(A11y.Onboarding.cancel)
                    }
                }
            }
            .navigationDestination(for: Step.self) { step in
                destination(step)
                    .navigationBarBackButtonHidden(step.isAfterSignUp)
            }
        }
        .interactiveDismissDisabled(path.contains { $0.isAfterSignUp } || model.accountFlowActive)
        .onChange(of: model.pendingLink) { _, link in
            // A link opened from outside starts over, unless an account was just made here.
            if link != nil, !path.contains(where: \.isAfterSignUp) { path = [] }
        }
    }

    @ViewBuilder
    private func destination(_ step: Step) -> some View {
        switch step {
        case let .invite(preview):
            InviteStep(preview: preview) { serverId, recoveryKey in
                path.append(.recoveryKey(serverId: serverId, key: recoveryKey, setup: preview.setup))
            }
        case let .recoveryKey(serverId, key, setup):
            RecoveryKeyStep(recoveryKey: key) {
                if setup {
                    path.append(.nameServer(serverId: serverId))
                } else {
                    Task { await model.finishJoining(serverId) }
                }
            }
        case let .nameServer(serverId):
            NameServerStep(serverId: serverId) {
                Task { await model.finishJoining(serverId) }
            }
        case let .signIn(url):
            SignInStep(initialUrl: url) { url, username in
                path.append(.recover(url: url, username: username))
            } onSignedIn: { serverId in
                Task { await model.finishJoining(serverId) }
            }
        case let .recover(url, username):
            RecoverStep(url: url, username: username) { serverId in
                Task { await model.finishJoining(serverId) }
            }
        }
    }
}
