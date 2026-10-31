import SwiftUI

@main
struct ZunaApp: App {
    @State private var core = CoreController()

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
    }
}

/// The app's first screen. It shows the core starting up; the real interface
/// replaces it from phase F2 on.
struct RootView: View {
    @Environment(CoreController.self) private var core

    var body: some View {
        ZStack {
            Color(red: 15 / 255, green: 15 / 255, blue: 17 / 255).ignoresSafeArea()
            VStack(spacing: 14) {
                Text("Zuna")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.white)
                switch core.phase {
                case .booting:
                    ProgressView().tint(.white)
                case .ready:
                    Label("End-to-end encrypted", systemImage: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("root.ready")
                case let .failed(message):
                    Text("Zuna couldn't start")
                        .font(.headline)
                        .foregroundStyle(.white)
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
