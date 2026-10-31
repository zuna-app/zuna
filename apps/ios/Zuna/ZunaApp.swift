import SwiftUI

@main
struct ZunaApp: App {
    @State private var core = CoreController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if UserDefaults.standard.string(forKey: "ZunaSpike") == "emoteText" {
                EmoteTextSpike()
            } else {
                root
            }
            #else
            root
            #endif
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
                    if model.onboarding {
                        JoinFlow(embedded: false)
                    } else {
                        MainView()
                    }
                }
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
