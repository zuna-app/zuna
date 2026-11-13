import SwiftUI
import UIKit
import ZunaModels

/// Asks about a device that signed in to the person's account after this one, in a window of its
/// own over every screen and sheet, until they say whether it was them: nothing else sends it away.
/// One that wasn't is removed, and they're asked next to change the secret it signed in with, in
/// Security, there and then (packages/ui/src/features/overlays/NewDevice.tsx).
struct NewDeviceWindowHost: ViewModifier {
    let model: AppModel
    @State private var window = NewDeviceWindow()

    private var shown: Bool {
        !model.appLocked && (model.deviceRemoved != nil || model.askedDevice != nil)
    }

    func body(content: Content) -> some View {
        content.onChange(of: shown, initial: true) { _, shown in
            window.show(shown, model: model)
        }
    }
}

@MainActor
final class NewDeviceWindow {
    private var window: UIWindow?

    func show(_ shown: Bool, model: AppModel) {
        if shown, window == nil {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return }
            let window = UIWindow(windowScene: scene)
            // Over the app's sheets and its own alerts.
            window.windowLevel = .alert + 1
            window.backgroundColor = .clear
            let host = UIHostingController(rootView: NewDevicePrompt().environment(model).tint(model.settings.accent.color))
            host.view.backgroundColor = .clear
            window.rootViewController = host
            window.makeKeyAndVisible()
            self.window = window
        } else if !shown, let window {
            window.isHidden = true
            self.window = nil
            window.windowScene?.windows.first { $0 !== window && !$0.isHidden }?.makeKey()
        }
    }
}

struct NewDevicePrompt: View {
    @Environment(AppModel.self) private var model
    @State private var failure: String?
    /// The server whose Security is open, to change what whoever it was knows.
    @State private var securing: String?

    var body: some View {
        if let serverId = securing {
            NavigationStack {
                SecurityView(serverId: serverId)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") {
                                securing = nil
                                model.deviceRemoved = nil
                            }
                            .accessibilityIdentifier(A11y.NewDevice.done)
                        }
                    }
            }
            .preferredColorScheme(.dark)
        } else {
            ZStack {
                Color.black.opacity(0.6).ignoresSafeArea()
                card
                    .padding(.horizontal, 24)
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
            .preferredColorScheme(.dark)
        }
    }

    @ViewBuilder private var card: some View {
        if let removed = model.deviceRemoved {
            let recovery = removed.secret == "recovery"
            prompt(
                title: "The device was removed",
                text: recovery
                    ? "Whoever signed in on it has your recovery key and can sign in again until you make a new one. Make a new one now."
                    : removed.secret == "password"
                        ? "Whoever signed in on it knows your password and can sign in again until you change it. Change it now."
                        : "Whoever signed in on it may know your password or your recovery key. Change your password and make a new recovery key now."
            ) {
                PrimaryButton(title: recovery ? "Make a new recovery key" : "Change password") { securing = removed.serverId }
                    .accessibilityIdentifier(A11y.NewDevice.secure)
                SecondaryButton(title: "Later") { model.deviceRemoved = nil }
                    .accessibilityIdentifier(A11y.NewDevice.later)
            }
        } else if let (serverId, device) = model.askedDevice {
            let server = model.servers[serverId]
            let place = server?.info?.name.isEmpty == false ? server?.info?.name ?? "" : server?.entry.name ?? ""
            let secret = device.secret == "recovery" ? "your recovery key" : "your password"
            let busy = model.answeringDevice != nil
            prompt(
                title: "Was this you?",
                text: "\u{201c}\(device.name)\u{201d} signed in to your account on \(place) on \(Format.full(device.createdAt)). If it wasn't you, someone else has \(secret) and is signed in as you."
            ) {
                PrimaryButton(title: "Yes, it was me") { answer(device.id, on: serverId, mine: true) }
                    .disabled(busy)
                    .accessibilityIdentifier(A11y.NewDevice.mine)
                RemoveButton(title: "No, remove it") { answer(device.id, on: serverId, mine: false) }
                    .disabled(busy)
                    .accessibilityIdentifier(A11y.NewDevice.notMine)
            }
            .id(device.id)
        }
    }

    private func prompt(title: String, text: String, @ViewBuilder buttons: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.amber)
                Text(title).font(.headline).foregroundStyle(Theme.text1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Text(text).font(.subheadline).foregroundStyle(Theme.text2).fixedSize(horizontal: false, vertical: true)
            if let failure {
                Text(failure).font(.footnote).foregroundStyle(Theme.red)
            }
            VStack(spacing: 10) {
                buttons()
            }
            .padding(.top, 6)
        }
        .padding(20)
        .frame(maxWidth: 420)
        .background(Theme.bg1, in: .rect(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.lineStrong))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.NewDevice.prompt)
    }

    private func answer(_ deviceId: String, on serverId: String, mine: Bool) {
        Task {
            failure = await model.answerNewDevice(deviceId, on: serverId, mine: mine)
        }
    }
}

/// The answer that removes the device: as big as the others, in red on a quiet fill.
private struct RemoveButton: View {
    @Environment(\.isEnabled) private var isEnabled
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 52)
                .foregroundStyle(isEnabled ? Theme.red : Theme.text3)
                .background(Theme.red.opacity(0.14), in: .rect(cornerRadius: 14, style: .continuous))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}
