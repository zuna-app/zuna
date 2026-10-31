import SwiftUI
import UIKit

/// Notifications on this device, as on the desktop: on or off, sound, and how
/// much they show. Previews are decrypted on the phone.
struct NotificationSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(Notifications.self) private var notifications

    var body: some View {
        @Bindable var notifications = notifications
        List {
            if notifications.authorization == .denied {
                Section {
                    Button("Open iOS Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                } footer: {
                    Text("Notifications are turned off for Zuna in iOS Settings.")
                }
                .listRowBackground(Theme.bg2)
            }
            Section {
                Toggle("Notifications", isOn: $notifications.settings.enabled)
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.notificationsToggle)
                Toggle("Sound", isOn: $notifications.settings.sound)
                    .tint(model.settings.accent.switchTint)
                    .disabled(!notifications.settings.enabled)
                    .accessibilityIdentifier(A11y.Settings.notificationSound)
            } footer: {
                Text("Previews are decrypted on this device. No notification service ever sees them.")
            }
            .listRowBackground(Theme.bg2)
            Section {
                Picker("What notifications show", selection: $notifications.settings.preview) {
                    Text("Sender and message").tag(NotificationSettings.Preview.full)
                    Text("Sender only").tag(NotificationSettings.Preview.sender)
                    Text("Nothing").tag(NotificationSettings.Preview.none)
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .disabled(!notifications.settings.enabled)
                .accessibilityIdentifier(A11y.Settings.notificationPreview)
            } header: {
                Text("What notifications show")
            } footer: {
                Text("Choose less if others can see your screen.")
            }
            .listRowBackground(Theme.bg2)
            let unsupported = model.order.filter { notifications.unsupported.contains($0) }.compactMap { model.servers[$0]?.entry.name }
            if !unsupported.isEmpty {
                Section {} footer: {
                    Text("\(unsupported.formatted(.list(type: .and))) doesn't send notifications to phones yet. A server's owner can turn them on.")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: notifications.settings.enabled) { _, enabled in
            if enabled { Task { await notifications.askOnce() } }
        }
    }
}
