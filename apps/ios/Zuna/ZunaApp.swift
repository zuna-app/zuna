import SwiftUI

@main
struct ZunaApp: App {
    @State private var core = CoreController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            root
        }
    }

    private var root: some View {
        RootView()
            .environment(core)
            .task { await core.start() }
            .onOpenURL { core.open($0) }
            .preferredColorScheme(.dark)
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background: core.didEnterBackground()
                case .active: core.didBecomeActive()
                default: break
                }
            }
    }
}

/// Starting up, unlocking after a restart, and then the app itself.
struct RootView: View {
    @Environment(CoreController.self) private var core

    var body: some View {
        ZStack {
            Theme.bg0.ignoresSafeArea()
            if core.phase == .locked {
                UnlockView()
            } else if core.phase == .ready, let model = core.model, let images = core.images {
                Group {
                    if model.appLocked {
                        // Nothing under App lock's cover, so VoiceOver can't read the chats either.
                        Theme.bg0.ignoresSafeArea()
                    } else if model.onboarding {
                        JoinFlow(embedded: false)
                    } else {
                        MainView()
                    }
                }
                .overlay(alignment: .top) { ToastStack() }
                .overlay { AppLockGate() }
                .environment(model)
                .environment(images)
                .tint(model.settings.accent.color)
            } else {
                status
            }
        }
    }

    /// Starting up, or failing to.
    private var status: some View {
        VStack(spacing: 14) {
            Text("Zuna")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.text1)
            switch core.phase {
            case .booting:
                ProgressView().tint(Theme.text1)
            case .locked, .ready:
                EmptyView()
            case let .failed(message):
                Text("Zuna couldn't start")
                    .font(.headline)
                    .foregroundStyle(Theme.text1)
                    .accessibilityIdentifier(A11y.Root.failed)
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.text2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
        }
    }
}

/// App lock: with it on, the app asks for Face ID, Touch ID or the passcode
/// each time it opens, and covers the chats while it isn't in front, so the
/// app switcher doesn't show them.
private struct AppLockGate: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var asking = false

    private var locked: Bool { model.appLocked }

    var body: some View {
        Group {
            if model.settings.appLock && (locked || scenePhase != .active) {
                ZStack {
                    Theme.bg0.ignoresSafeArea()
                    VStack(spacing: 18) {
                        ZunaLogo(size: 72)
                        if locked && scenePhase == .active {
                            Button {
                                unlock()
                            } label: {
                                Label("Unlock with \(AppLock.methodName)", systemImage: "lock.fill")
                                    .padding(.horizontal, 18)
                                    .frame(minHeight: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(model.settings.accent.color)
                            .foregroundStyle(model.settings.accent.onAccent)
                            .accessibilityIdentifier(A11y.Root.unlockApp)
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(A11y.Root.appLock)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background, model.settings.appLock { model.appLocked = true }
            if phase == .active, locked { unlock() }
        }
        .onAppear {
            if locked { unlock() }
        }
    }

    private func unlock() {
        guard !asking else { return }
        asking = true
        Task {
            if await AppLock.authenticate(reason: "Unlock Zuna") { model.appLocked = false }
            asking = false
        }
    }
}
