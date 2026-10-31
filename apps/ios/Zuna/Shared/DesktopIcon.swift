import SwiftUI

/// Icons drawn as the desktop draws them, from Lucide's outlines on a 24-point
/// grid, so a message is marked the same way in both apps.
enum DesktopIcon {
    case check, checkCheck, clock

    /// The outline at `size` points, with Lucide's stroke, in the current color.
    func view(size: CGFloat) -> some View {
        Outline(icon: self)
            .stroke(style: StrokeStyle(lineWidth: 2 * size / 24, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
    }

    private struct Outline: Shape {
        let icon: DesktopIcon

        func path(in rect: CGRect) -> Path {
            let unit = min(rect.width, rect.height) / 24
            let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit) }
            var path = Path()
            switch icon {
            case .check:
                path.addLines([point(20, 6), point(9, 17), point(4, 12)])
            case .checkCheck:
                path.addLines([point(18, 6), point(7, 17), point(2, 12)])
                path.addLines([point(22, 10), point(14.5, 17.5), point(13, 16)])
            case .clock:
                path.addEllipse(in: CGRect(origin: point(2, 2), size: CGSize(width: 20 * unit, height: 20 * unit)))
                path.addLines([point(12, 6), point(12, 12), point(16, 14)])
            }
            return path
        }
    }
}
