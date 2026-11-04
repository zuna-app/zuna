import SwiftUI
import UIKit

/// Zuna in the share sheet: what another app shares goes to the chats picked
/// here, sent before the sheet closes. See `ShareModel` for how it's sent.
final class ShareViewController: UIViewController {
    private var model: ShareModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Theme.bg1)
        // Swiping the sheet away would leave the core's data held; Cancel lets go of it first.
        isModalInPresentation = true
        let model = ShareModel { [weak self] sent in
            guard let context = self?.extensionContext else { return }
            if sent {
                context.completeRequest(returningItems: nil)
            } else {
                context.cancelRequest(withError: CocoaError(.userCancelled))
            }
        }
        self.model = model
        let host = UIHostingController(rootView: ShareView().environment(model))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)

        // The app sharing goes out of sight: the extension may be suspended, and mustn't hold the data then.
        NotificationCenter.default.addObserver(forName: .NSExtensionHostDidEnterBackground, object: nil, queue: .main) { [weak model] _ in
            MainActor.assumeIsolated { model?.hostLeft() }
        }
        NotificationCenter.default.addObserver(forName: .NSExtensionHostWillEnterForeground, object: nil, queue: .main) { [weak model] _ in
            MainActor.assumeIsolated { model?.hostBack() }
        }
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let intent = extensionContext?.intent
        Task { await model.start(items: items, intent: intent) }
    }
}
