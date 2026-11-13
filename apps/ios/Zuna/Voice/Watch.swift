import SwiftUI
import WebKit
import ZunaHost
import ZunaModels

// Watching a YouTube video together in a voice channel or a call, as the web app does
// (packages/ui/src/features/voice/Watch.tsx). The video comes from YouTube to each device whose
// person pressed Watch, in YouTube's own player, in a WKWebView holding watch.html from
// packages/watch and nothing else. Until then the tile shows what came inside the room's state,
// and this device contacts nobody. Zuna's controls are under the player, never on it.

/// Something about watching together to tell the person.
struct WatchFailure: LocalizedError {
    var errorDescription: String?
}

/// What the player says about itself, for the bar under it.
struct WatchPlayerStatus: Equatable {
    var phase = "loading"
    var error: String?
}

/// What each of YouTube's errors is, in words, so people know it isn't Zuna (WATCH_ERRORS in packages/watch).
private let watchErrors: [String: String] = [
    "gone": "This video was removed or is private.",
    "not-embeddable": "Its owner only allows it to play on YouTube.",
    "unplayable": "YouTube won't play this video here.",
    "no-referrer": "YouTube refused to play it here. That's a bug in Zuna.",
    "unknown": "YouTube couldn't play this video.",
]

/// The address the page is loaded under, which YouTube's player is told as the Referer: `https://` and the app's ID.
/// A check's fake player is served over plain HTTP, which WebKit won't frame in an HTTPS page, so for it the page is
/// under `http://`.
private var watchPageOrigin: URL {
    URL(string: watchPlayerHost.hasPrefix("http:") ? "http://chat.zuna.mobile" : "https://chat.zuna.mobile")!
}

/// YouTube's player, or in a development build's checks the fake that `-ZunaWatchPlayer` or `ZUNA_WATCH_PLAYER` names
/// (packages/watch/fake/player.html), which the page may frame and nothing else.
private var watchPlayerHost: String {
    #if DEBUG
    let fake = UserDefaults.standard.string(forKey: "ZunaWatchPlayer") ?? ProcessInfo.processInfo.environment["ZUNA_WATCH_PLAYER"] ?? ""
    if fake.range(of: #"^https?://[^/]+$"#, options: .regularExpression) != nil { return fake }
    #endif
    return WatchPage.youtube
}

/// YouTube's player, kept in step with the room.
struct WatchPlayer: UIViewRepresentable {
    let watch: WatchView
    let muted: Bool
    /// Paused here while it can't be seen, as with the app in the background.
    let held: Bool
    let onIntent: (WatchChange) -> Void
    let onStatus: (WatchPlayerStatus) -> Void
    let onBlocked: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // It keeps nothing: no cookie outlives a session. Under the proxy set in Privacy, YouTube is
        // reached through it, as everything else is, with names left to it and nothing around it.
        let store = WKWebsiteDataStore.nonPersistent()
        if let proxy = NetworkProxy.current { store.proxyConfigurations = [proxy.configuration] }
        configuration.websiteDataStore = store
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.userContentController.add(WeakHandler(context.coordinator), name: "zuna")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.accessibilityIdentifier = A11y.Voice.watchPlayer
        context.coordinator.view = view
        if let page = WatchPage.html(player: watchPlayerHost) {
            view.loadHTMLString(page, baseURL: watchPageOrigin)
        } else {
            onStatus(WatchPlayerStatus(phase: "idle", error: "The player is missing from this build of Zuna."))
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.update(self)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "zuna")
        view.stopLoading()
        view.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        var parent: WatchPlayer
        weak var view: WKWebView?
        private var ready = false
        private var sent: (watch: WatchView, muted: Bool, held: Bool)?

        init(parent: WatchPlayer) {
            self.parent = parent
        }

        func update(_ next: WatchPlayer) {
            parent = next
            guard ready else { return }
            if sent?.watch != next.watch { apply(next.watch) }
            if sent?.muted != next.muted { send(["type": "muted", "muted": next.muted]) }
            if sent?.held != next.held { send(["type": "hold", "held": next.held]) }
            sent = (next.watch, next.muted, next.held)
        }

        private func apply(_ watch: WatchView) {
            let age = Date().timeIntervalSince1970 * 1000 - watch.at
            send(["type": "apply", "video": watch.video.id, "playing": watch.playing, "position": watch.position, "age": age, "rate": watch.rate])
        }

        private func send(_ message: [String: Any]) {
            guard let view, let data = try? JSONSerialization.data(withJSONObject: message), let json = String(data: data, encoding: .utf8) else { return }
            view.evaluateJavaScript("window.zunaWatch && window.zunaWatch.receive(\(json))")
        }

        // What the page says, which is checked as anything from outside is.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let text = message.body as? String, text.count < 10_000,
                  let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let type = object["type"] as? String else { return }
            switch type {
            case "ready":
                ready = true
                send(["type": "start", "host": watchPlayerHost, "muted": parent.muted, "fullscreen": true])
                apply(parent.watch)
                if parent.held { send(["type": "hold", "held": true]) }
                sent = (parent.watch, parent.muted, parent.held)
            case "intent":
                guard let change = object["change"] as? [String: Any] else { return }
                let playing = change["playing"] as? Bool
                let position = (change["position"] as? NSNumber)?.doubleValue
                let rate = (change["rate"] as? NSNumber)?.doubleValue
                guard playing != nil || position != nil || rate != nil else { return }
                parent.onIntent(WatchChange(playing: playing, position: position.map { max(0, $0) }, rate: rate))
            case "status":
                guard let status = object["status"] as? [String: Any] else { return }
                let error = (status["error"] as? String).flatMap { watchErrors[$0] ?? watchErrors["unknown"] }
                parent.onStatus(WatchPlayerStatus(phase: status["phase"] as? String ?? "loading", error: error))
            case "blocked":
                parent.onBlocked()
            default:
                break
            }
        }

        /// The page itself, and YouTube's frames inside it. A link pressed in the player opens in the browser.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if action.targetFrame?.isMainFrame == false {
                return decisionHandler(.allow)
            }
            if url.host == watchPageOrigin.host, action.navigationType == .other {
                return decisionHandler(.allow)
            }
            if ["http", "https"].contains(url.scheme) { UIApplication.shared.open(url) }
            decisionHandler(.cancel)
        }

        /// Nothing downloads.
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .cancel)
        }

        /// No new windows: what YouTube opens in one opens in the browser.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, ["http", "https"].contains(url.scheme) { UIApplication.shared.open(url) }
            return nil
        }

        /// No camera or microphone for it.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
            decisionHandler(.deny)
        }
    }
}

/// WKUserContentController holds its handlers strongly, which would keep the coordinator and its web view alive.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// A picture that came inside the room's state, as a data URL.
private func watchImage(_ image: LinkPreview.Image?) -> UIImage? {
    guard let data = image?.data, let comma = data.firstIndex(of: ","), let bytes = Data(base64Encoded: String(data[data.index(after: comma)...])) else { return nil }
    return UIImage(data: bytes)
}

/// The video watched together, filling the stage: its picture until Watch is pressed, then YouTube's player, with Zuna's bar under it.
struct WatchStage: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @Environment(\.scenePhase) private var scenePhase
    let watch: WatchView
    @State private var asking: Asked?
    @State private var linking = false
    @State private var status = WatchPlayerStatus()
    @State private var blocked = false

    private enum Asked: Identifiable {
        case watch, another
        var id: Self { self }
    }

    private var watchingHere: Bool { voice.watching == watch.session }
    private var title: String { watch.video.title.isEmpty ? "A YouTube video" : watch.video.title }

    private func name(_ userId: String) -> String {
        if userId == voice.serverId.flatMap({ model.servers[$0]?.me?.userId }) { return "you" }
        return voice.serverId.flatMap { model.servers[$0]?.users[userId]?.displayName } ?? "someone"
    }

    private var note: String {
        if let error = status.error { return error }
        if blocked { return "It didn't start automatically. Press play in the video." }
        if watchingHere, status.phase == "catching-up" { return "Catching up…" }
        if !watch.playing { return "Paused by \(name(watch.changedBy))" }
        return "Shared by \(name(watch.video.startedBy))\(watch.video.author.isEmpty ? "" : " · \(watch.video.author)")"
    }

    var body: some View {
        VStack(spacing: 0) {
            if watchingHere {
                WatchPlayer(
                    watch: watch,
                    muted: voice.watchMuted || voice.deafened,
                    held: scenePhase != .active,
                    onIntent: { voice.watchControl($0) },
                    onStatus: { next in
                        status = next
                        #if DEBUG
                        voice.playerPhase = next.phase
                        #endif
                        if next.phase == "in-step" { blocked = false }
                    },
                    onBlocked: { blocked = true }
                )
                .id(watch.session)
                .frame(minWidth: 200, minHeight: 200)
            } else {
                cover
            }
            bar
        }
        .background(.black)
        .clipShape(.rect(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Voice.watchStage)
        .onChange(of: watch.video.id) { status = WatchPlayerStatus(); blocked = false }
        .sheet(item: $asking) { asked in
            WatchConsent(action: asked == .watch ? "Watch" : "Continue") {
                asking = nil
                if asked == .watch { voice.setWatching(true) } else { linking = true }
            }
        }
        .sheet(isPresented: $linking) { WatchLinkSheet() }
    }

    private var cover: some View {
        ZStack {
            if let image = watchImage(watch.video.image) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .brightness(-0.45)
            } else {
                Theme.bg2
            }
            VStack(spacing: 6) {
                Text(title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                if !watch.video.author.isEmpty {
                    Text(watch.video.author).font(.subheadline)
                }
                Text("Shared by \(name(watch.video.startedBy)). It plays from YouTube when you press Watch.")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)
                Button {
                    if voice.playYouTube { voice.setWatching(true) } else { asking = .watch }
                } label: {
                    Label("Watch", systemImage: "play.rectangle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
                .padding(.top, 6)
                .accessibilityIdentifier(A11y.Voice.watchHere)
            }
            .foregroundStyle(.white)
            .padding(20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
    }

    private var bar: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(note).font(.caption).foregroundStyle(Theme.text2).lineLimit(1)
                    .accessibilityIdentifier(A11y.Voice.watchNote)
            }
            Spacer(minLength: 0)
            if watchingHere {
                Button {
                    voice.watchMuted.toggle()
                } label: {
                    Image(systemName: voice.watchMuted || voice.deafened ? "speaker.slash.fill" : "speaker.wave.2.fill")
                }
                .disabled(voice.deafened)
                .accessibilityLabel(voice.watchMuted || voice.deafened ? "Unmute video" : "Mute video")
            }
            Menu {
                Button("Another video", systemImage: "link") {
                    if voice.playYouTube { linking = true } else { asking = .another }
                }
                Button("Stop for everyone", systemImage: "stop.fill", role: .destructive) { voice.watchStop() }
                if watchingHere {
                    Button("Stop watching here", systemImage: "xmark") { voice.setWatching(false) }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("Video options")
            .accessibilityIdentifier(A11y.Voice.watchMenu)
        }
        .foregroundStyle(Theme.text1)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.bg1)
    }
}

/// What's on, small, in the strip under something else that fills the stage.
struct WatchThumb: View {
    let watch: WatchView

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let image = watchImage(watch.video.image) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Theme.bg2.overlay(Image(systemName: "play.rectangle").font(.title2).foregroundStyle(Theme.text2))
            }
            Label(watch.video.title.isEmpty ? "A YouTube video" : watch.video.title, systemImage: "play.rectangle")
                .font(.caption2)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(.black.opacity(0.6), in: .rect(cornerRadius: 5))
                .foregroundStyle(.white)
                .padding(6)
        }
        .clipShape(.rect(cornerRadius: 12))
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Fills the stage")
    }
}

/// Asks once before this device first contacts YouTube, saying what Google learns, and remembers the answer.
struct WatchConsent: View {
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss
    let action: String
    let onAgree: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Videos play in YouTube's own player. When you watch one, Google sees this device's IP address and which video it is, just as if you'd opened it on YouTube. You aren't signed in to YouTube here, so you may see ads.")
                    Text("Your server only sees that something was shared in the room, not which video. Nothing is loaded from YouTube until you press Watch. You can turn this off in Settings, under Privacy.")
                        .foregroundStyle(Theme.text2)
                    Link("YouTube's Terms of Service", destination: URL(string: "https://www.youtube.com/t/terms")!)
                    Link("Google's Privacy Policy", destination: URL(string: "https://policies.google.com/privacy")!)
                }
                .font(.subheadline)
                .padding(20)
            }
            .navigationTitle("Play YouTube videos?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action) {
                        voice.playYouTube = true
                        onAgree()
                    }
                    .accessibilityIdentifier(A11y.Voice.watchAgree)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A YouTube link to put on for everyone in the room.
struct WatchLinkSheet: View {
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://www.youtube.com/watch?v=…", text: $link)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await submit() } }
                        .accessibilityLabel("YouTube link")
                        .accessibilityIdentifier(A11y.Voice.watchLink)
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Theme.red)
                    } else {
                        Text("It plays in sync for everyone here who presses Watch. Anyone in the room can pause, skip, change the speed or stop it.")
                    }
                }
            }
            .navigationTitle("Watch together")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Share video") { Task { await submit() } }
                            .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier(A11y.Voice.watchPutOn)
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            try await voice.watchStart(link)
            dismiss()
        } catch {
            self.error = ErrorText.describe(error)
        }
    }
}
