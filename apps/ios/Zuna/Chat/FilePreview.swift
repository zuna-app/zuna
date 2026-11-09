import QuickLook
import UIKit

/// Shows a decrypted file in QuickLook, presented by UIKit over whatever is on
/// screen: pictures, videos, recordings and documents, with Share and Save.
@MainActor
enum FilePreview {
    private final class Source: NSObject, QLPreviewControllerDataSource, @preconcurrency QLPreviewControllerDelegate {
        let url: URL

        init(url: URL) {
            self.url = url
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }

        /// The named copy goes when the preview closes; the decrypted file stays in the cache.
        func previewControllerDidDismiss(_ controller: QLPreviewController) {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            FilePreview.source = nil
        }
    }

    /// QuickLook holds its data source weakly.
    private static var source: Source?
    /// A file on its way to being shown.
    private static var opening = false

    /// Shows a file once it's decrypted. Taps while it's on its way, or while one is shown, do
    /// nothing, so one preview comes up rather than one for each, each to be closed.
    static func open(_ file: @MainActor () async throws -> URL) async throws {
        guard !opening, source == nil else { return }
        opening = true
        defer { opening = false }
        show(try await file())
    }

    static func show(_ url: URL) {
        guard source == nil, let top = topViewController() else { return }
        let source = Source(url: url)
        self.source = source
        let controller = QLPreviewController()
        controller.dataSource = source
        controller.delegate = source
        top.present(controller, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
