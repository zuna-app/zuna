import SwiftUI

/// Icons drawn as the desktop draws them, from the same outlines, so a message
/// is marked the same way in both apps.
enum DesktopIcon {
    /// Sent: one thin, slanted tick, as in Telegram (the desktop's `Ticks`).
    case sent
    /// Read: a second tick beside the first, which stays put.
    case read
    /// Sending: Lucide's clock.
    case clock

    func view() -> some View {
        Outline(icon: self)
            .stroke(style: StrokeStyle(lineWidth: lineWidth, lineCap: self == .clock ? .round : .butt, lineJoin: self == .clock ? .round : .miter))
            .frame(width: box.width, height: box.height)
    }

    /// The desktop's size in points; the outlines are drawn in this box.
    private var box: CGSize {
        self == .clock ? CGSize(width: 11, height: 11) : CGSize(width: 18, height: 10)
    }

    private var lineWidth: CGFloat {
        self == .clock ? 2 * 11 / 24 : 1.4
    }

    private struct Outline: Shape {
        let icon: DesktopIcon

        func path(in rect: CGRect) -> Path {
            var path = Path()
            switch icon {
            case .sent, .read:
                // The desktop's 18 × 10 view box.
                let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * rect.width / 18, y: rect.minY + y * rect.height / 10) }
                path.addLines([point(0.6, 5.6), point(3.7, 8.8), point(12, 0.6)])
                if icon == .read { path.addLines([point(7.4, 7.4), point(8.9, 8.8), point(17.2, 0.6)]) }
            case .clock:
                // Lucide's 24-point grid.
                let unit = min(rect.width, rect.height) / 24
                let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit) }
                path.addEllipse(in: CGRect(origin: point(2, 2), size: CGSize(width: 20 * unit, height: 20 * unit)))
                path.addLines([point(12, 6), point(12, 12), point(16, 14)])
            }
            return path
        }
    }
}
