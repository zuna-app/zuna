import SwiftUI
import UIKit

/// A drawer under the content, as in Discord: the content slides right to show
/// it. It opens with a swipe from the left edge of the screen, or by setting
/// `isOpen`, and closes with a tap on the content or a swipe back.
struct DrawerContainer<Drawer: View, Content: View>: View {
    @Binding var isOpen: Bool
    /// Off while something else owns the edge swipe, like going back in a chat.
    var swipeEnabled: Bool
    var reduceMotion: Bool
    @ViewBuilder var drawer: Drawer
    @ViewBuilder var content: Content

    /// How far a swipe has moved the content, while a finger is down.
    @State private var drag: CGFloat?

    var body: some View {
        GeometryReader { geometry in
            let width = drawerWidth(in: geometry.size.width)
            let offset = min(max(drag ?? (isOpen ? width : 0), 0), width)
            let progress = offset / width
            ZStack(alignment: .leading) {
                // Only there while it shows, so it costs nothing and is out of
                // the accessibility tree while closed.
                if offset > 0 || isOpen {
                    drawer
                        .frame(width: width)
                        .offset(x: reduceMotion ? 0 : (offset - width) * 0.25)
                        .opacity(0.4 + 0.6 * progress)
                }
                // The content's shadow, on its own layer so the content isn't rendered offscreen.
                Rectangle()
                    .fill(Theme.bg0)
                    .shadow(color: .black.opacity(0.4 * progress), radius: 18)
                    .ignoresSafeArea()
                    .offset(x: offset)
                content
                    .accessibilityHidden(isOpen)
                    .overlay {
                        Color.black
                            .opacity(0.5 * progress)
                            .ignoresSafeArea()
                            .allowsHitTesting(isOpen)
                            .onTapGesture { setOpen(false) }
                            .accessibilityHidden(true)
                    }
                    .offset(x: offset)
                    .gesture(closingDrag(width: width), isEnabled: isOpen)
            }
            .accessibilityAction(.escape) { setOpen(false) }
            .gesture(EdgeSwipe(isEnabled: swipeEnabled && !isOpen) { translation in
                drag = translation
            } onEnd: { translation, velocity in
                drag = nil
                setOpen(translation + velocity * 0.15 > width / 2)
            })
        }
    }

    private func drawerWidth(in total: CGFloat) -> CGFloat {
        min(total - 64, 340)
    }

    private func closingDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                drag = width + min(0, value.translation.width)
            }
            .onEnded { value in
                drag = nil
                setOpen(width + value.predictedEndTranslation.width > width / 2)
            }
    }

    private func setOpen(_ open: Bool) {
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.9)) {
            isOpen = open
        }
    }
}

/// The system's screen-edge swipe, which SwiftUI gestures can't tell apart from a scroll.
private struct EdgeSwipe: UIGestureRecognizerRepresentable {
    var isEnabled: Bool
    var onChange: (CGFloat) -> Void
    var onEnd: (_ translation: CGFloat, _ velocity: CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let recognizer = UIScreenEdgePanGestureRecognizer()
        recognizer.edges = .left
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        let translation = recognizer.translation(in: recognizer.view).x
        switch recognizer.state {
        case .changed:
            onChange(translation)
        case .ended, .cancelled, .failed:
            onEnd(translation, recognizer.velocity(in: recognizer.view).x)
        default:
            break
        }
    }
}
