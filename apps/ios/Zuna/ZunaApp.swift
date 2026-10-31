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

/// The app's first screen. It shows the core starting up; the real interface
/// replaces it from phase F2 on.
struct RootView: View {
    @Environment(CoreController.self) private var core

    var body: some View {
        ZStack {
            Color(red: 15 / 255, green: 15 / 255, blue: 17 / 255).ignoresSafeArea()
            if core.phase == .locked {
                UnlockView()
            } else {
                status
            }
        }
    }

    private var status: some View {
        ZStack {
            VStack(spacing: 14) {
                Text("Zuna")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.white)
                switch core.phase {
                case .booting:
                    ProgressView().tint(.white)
                case .locked:
                    EmptyView()
                case .ready:
                    Label("End-to-end encrypted", systemImage: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(A11y.Root.ready)
                case let .failed(message):
                    Text("Zuna couldn't start")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .accessibilityIdentifier(A11y.Root.failed)
                    Text(message)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
            }
        }
    }
}
