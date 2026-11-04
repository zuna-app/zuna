import SwiftUI

extension View {
    /// On a capsule of Liquid Glass from iOS 26, as the bar's buttons are, and a plain one before.
    /// Interactive glass answers a touch as a button does, which a field holding buttons of its own shouldn't.
    @ViewBuilder
    func glassCapsule(interactive: Bool = true) -> some View {
        if #available(iOS 26, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: .capsule)
        } else {
            background(Theme.bg3, in: .capsule)
        }
    }
}

extension ToolbarContent {
    /// Without the glass iOS 26 puts behind items in the navigation bar.
    @ToolbarContentBuilder
    func withoutSharedBackground() -> some ToolbarContent {
        if #available(iOS 26, *) {
            sharedBackgroundVisibility(.hidden)
        } else {
            self
        }
    }
}
