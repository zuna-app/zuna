import SwiftUI

/// A list with its search field above the first row, out of sight until the
/// list is pulled down, as Telegram's chat list has it. The field waits above
/// the top edge; pulled more than halfway into view, it stays, and pushed
/// back up or scrolled past, it goes back to wait. The system's search bar
/// can't do this: it shows whenever its list is at the top.
struct PullSearchList<Content: View>: View {
    @Binding var query: String
    let prompt: String
    var identifier = ""
    /// When it changes, such as the server, the field goes back to wait.
    var resetKey: String?
    @ViewBuilder let content: () -> Content

    @FocusState private var focused: Bool
    @State private var open = false
    /// How far a pull has brought it into view, in tenths, as it fades in: waiting, it's under the bar's glass.
    @State private var reveal: CGFloat = 0

    /// The field's row, its padding included.
    private static var fieldRow: CGFloat { 60 }
    /// What goes above the top edge while it waits: the field, not the gap under it.
    private static var hidden: CGFloat { 48 }

    private var active: Bool { focused || !query.isEmpty }

    var body: some View {
        List {
            field
                .opacity(open || active ? 1 : reveal)
                .frame(height: Self.fieldRow - 16)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 12, trailing: 16))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            content()
        }
        // Waiting, the field sits above the top edge, where pulling the list down shows it.
        .contentMargins(.top, open || active ? 0 : -Self.hidden, for: .scrollContent)
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            let y = geometry.contentOffset.y + geometry.contentInsets.top
            return (min(max(-y / Self.hidden, 0), 1) * 10).rounded() / 10
        } action: { _, value in
            reveal = value
        }
        .onScrollPhaseChange { old, phase, context in
            let y = context.geometry.contentOffset.y + context.geometry.contentInsets.top
            if old == .interacting, !open, y < -Self.hidden / 2 {
                withAnimation(.snappy(duration: 0.25)) { open = true }
            } else if old == .interacting, open, !active, y > 12 {
                // Pushed up or scrolled on, even in a list too short to scroll it away, which gives way only a little.
                withAnimation(.snappy(duration: 0.25)) { open = false }
            }
        }
        .onChange(of: resetKey) { if !active { open = false } }
    }

    private var field: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
                TextField(prompt, text: $query)
                    .focused($focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .foregroundStyle(Theme.text1)
                    .accessibilityIdentifier(identifier)
                if !query.isEmpty {
                    // Taps rather than buttons: a list row holding a text field takes its buttons' taps for the field.
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.text3)
                        .frame(width: 28, height: 44)
                        .contentShape(.rect)
                        .onTapGesture { query = "" }
                        .accessibilityLabel("Clear")
                        .accessibilityAddTraits(.isButton)
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .glassCapsule(interactive: false)
            if active {
                Text("Cancel")
                    .foregroundStyle(Theme.text1)
                    .frame(height: 44)
                    .contentShape(.rect)
                    .onTapGesture {
                        query = ""
                        focused = false
                        withAnimation(.snappy(duration: 0.25)) { open = false }
                    }
                    .accessibilityAddTraits(.isButton)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.2), value: active)
    }
}
