import SwiftUI

/// Three dots that rise and brighten in turn, in the color of the text beside them, as the
/// desktop's `.typing-dots`: 4 points, a 1.1 s cycle, each 0.14 s behind the one before,
/// 2.5 points up at their brightest. With less motion they rest, faint and level.
struct TypingDots: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TimelineView(.animation(paused: model.reduceMotion)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<3) { index in
                    let lift = model.reduceMotion ? 0 : Self.lift(time - Double(index) * 0.14)
                    Circle()
                        .fill(.foreground)
                        .frame(width: 4, height: 4)
                        .opacity(0.35 + 0.65 * lift)
                        .offset(y: -2.5 * lift)
                }
            }
            .frame(height: 8)
        }
        .accessibilityHidden(true)
    }

    /// How far up a dot is, from 0 to 1: up and back down over the first half of its
    /// cycle, as the keyframes' 0%, 25% and 50%, and resting through the second.
    private static func lift(_ time: Double) -> Double {
        let phase = (time / 1.1).truncatingRemainder(dividingBy: 1)
        return phase < 0.5 ? sin(phase * 2 * .pi) : 0
    }
}
