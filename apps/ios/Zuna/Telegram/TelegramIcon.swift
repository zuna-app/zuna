import SwiftUI
import ZunaModels

/// The linked Telegram account's picture, where a server's would be: a drawing of Zuna's own, as
/// Telegram's terms keep its logo for its own apps, and as the desktop's rail draws it.
struct TelegramIcon: View {
    var size: CGFloat
    /// The symbol it's drawn with, which its tab wears too: not Chats' bubbles, nor Telegram's plane.
    static let symbol = "ellipsis.bubble.fill"

    var body: some View {
        Image(systemName: Self.symbol)
            .font(.system(size: size * 0.42, weight: .medium))
            .foregroundStyle(Theme.text1)
            .frame(width: size, height: size)
            .background(Theme.bg3, in: .rect(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityLabel("Telegram")
    }
}

/// A server's picture, or the Telegram account's drawing.
struct ServerIcon: View {
    let entry: ServerEntry
    var size: CGFloat

    var body: some View {
        if entry.isTelegram {
            TelegramIcon(size: size)
        } else {
            AvatarView(name: entry.name, seed: entry.url, source: .serverIcon(entry), size: size, rounded: true)
        }
    }
}
