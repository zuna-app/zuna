import SwiftUI

/// A switch for something kept on the server: it moves at once, rather than springing back
/// until the server says so, and goes back only if saving fails.
struct SavingToggle<Label: View>: View {
    @Environment(AppModel.self) private var model
    let value: Bool
    let save: (Bool) async throws -> Void
    @ViewBuilder let label: Label
    /// Where it was moved to, until the server's value catches up.
    @State private var pending: Bool?

    var body: some View {
        Toggle(isOn: Binding(get: { pending ?? value }, set: { next in
            pending = next
            Task {
                do {
                    try await save(next)
                } catch {
                    pending = nil
                    model.toast("Couldn't save that. \(ErrorText.describe(error))", .error)
                }
            }
        })) {
            label
        }
        .tint(model.settings.accent.switchTint)
        .onChange(of: value) { _, now in
            if now == pending { pending = nil }
        }
    }
}

extension SavingToggle where Label == Text {
    init(_ title: String, value: Bool, save: @escaping (Bool) async throws -> Void) {
        self.init(value: value, save: save) { Text(title) }
    }
}
