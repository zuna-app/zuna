import Foundation
import LiveKit
import ReplayKit

/// Records the screen for the app before iOS 27, where nothing else can see past Zuna. LiveKit's handler
/// hands each frame to the app over a socket in the App Group, so the call's keys and its connection stay
/// in the app, and this process only ever has pictures. The app publishes them in the call it's in, and
/// says so (BroadcastSignal): a broadcast no call takes ends here, with why, rather than going on unseen.
final class SampleHandler: LKSampleHandler, @unchecked Sendable {
    /// How long the app has to take a broadcast: asking the server, and its media server's say.
    private static let answerWait: TimeInterval = 15

    /// Only touched on the main queue.
    private var answered = false

    override init() {
        super.init()
        listen(BroadcastSignal.taken)
        listen(BroadcastSignal.refused)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.answerWait) { [weak self] in
            guard let self, !answered else { return }
            end(because: "Come into a voice channel in Zuna, then share your screen from the call.")
        }
    }

    deinit {
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }

    private func listen(_ name: String) {
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(), { _, observer, name, _, _ in
            guard let observer, let name = name?.rawValue as String? else { return }
            let handler = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
            DispatchQueue.main.async { handler.heard(name) }
        }, name as CFString, nil, .deliverImmediately)
    }

    private func heard(_ name: String) {
        guard !answered else { return }
        answered = true
        if name == BroadcastSignal.refused {
            end(because: BroadcastSignal.reason ?? "Zuna couldn't share your screen.")
        }
    }

    private func end(because reason: String) {
        finishBroadcastWithError(NSError(domain: "chat.zuna.broadcast", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]))
    }
}
