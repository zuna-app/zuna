import Foundation

/// The page a video watched together plays in, built from packages/watch (apps/ios/core-bundle/build.mjs), with
/// nothing in it but YouTube's player and what keeps it in step. The app loads it into a WKWebView.
public enum WatchPage {
    /// YouTube's privacy-enhanced player, which is all the page may frame.
    public static let youtube = "https://www.youtube-nocookie.com"

    /// The page, allowed to frame `player` alone: YouTube's, or in tests a fake of it.
    public static func html(player: String = youtube) -> String? {
        guard let url = Bundle.module.url(forResource: "watch", withExtension: "html"),
              let page = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return page.replacingOccurrences(of: "{{player}}", with: player)
    }
}
