import Foundation
import UIKit
import ZunaModels

/// The app's side of sharing into Zuna while it runs: the share extension
/// can't run a core of its own then (`CoreLock`), so it asks the app which
/// chats there are, and hands it what to send (`ShareMailbox`).
@MainActor
final class ShareInbox {
    private let model: AppModel
    private let core: CoreConnection
    private let deviceKey: Data
    private var observers: [DarwinObserver] = []
    private var sending = 0
    /// Called once the last request handed over has gone, so the app can go to sleep.
    var onIdle: (() -> Void)?

    init(model: AppModel, core: CoreConnection, deviceKey: Data) {
        self.model = model
        self.core = core
        self.deviceKey = deviceKey
    }

    /// Requests are answered only while the app holds the core.
    var listening = false {
        didSet {
            guard listening != oldValue else { return }
            if listening {
                observers = [
                    DarwinObserver(ShareMailbox.askTargets) { [weak self] in self?.answerTargets() },
                    DarwinObserver(ShareMailbox.send) { [weak self] in self?.takeRequests() },
                ]
                // One left while the app was coming back.
                takeRequests()
            } else {
                observers = []
            }
        }
    }

    /// Whether a request handed over is still being sent.
    var busy: Bool { sending > 0 }

    private func answerTargets() {
        guard listening else { return }
        let servers = model.order.compactMap { model.servers[$0] }.map { server in
            ShareServer(entry: server.entry, selfId: server.me?.userId, users: server.users, conversations: server.conversations, channels: server.channels, hidden: server.prefs.hidden)
        }
        do {
            try ShareMailbox.write(servers, to: ShareMailbox.targetsFile, deviceKey: deviceKey)
            ShareMailbox.post(ShareMailbox.targetsReady)
        } catch {
            // The extension stops waiting and says Zuna didn't answer.
        }
    }

    private func takeRequests() {
        guard listening else { return }
        for folder in ShareMailbox.waitingRequests() {
            let taken = folder.appendingPathComponent("taken")
            // Renaming it is what takes it, so the extension can tell it was.
            guard (try? FileManager.default.moveItem(at: folder.appendingPathComponent("request"), to: taken)) != nil else { continue }
            guard let request = try? ShareMailbox.read(ShareRequest.self, from: taken, deviceKey: deviceKey) else {
                try? ShareMailbox.write(ShareResult(error: "Zuna couldn't read what was shared."), to: folder.appendingPathComponent("result"), deviceKey: deviceKey)
                ShareMailbox.post(ShareMailbox.sent)
                continue
            }
            sending += 1
            let task = UIApplication.shared.beginBackgroundTask(withName: "Send what was shared")
            Task {
                var result = ShareResult()
                do {
                    try await ShareSender.send(request, through: core)
                } catch {
                    result.error = ErrorText.describe(error)
                }
                try? ShareMailbox.write(result, to: folder.appendingPathComponent("result"), deviceKey: deviceKey)
                ShareMailbox.post(ShareMailbox.sent)
                await ShareSender.suggest(request, through: core)
                sending -= 1
                if sending == 0 { onIdle?() }
                UIApplication.shared.endBackgroundTask(task)
            }
        }
    }
}
