import SwiftUI
import UIKit
import ZunaModels

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
                    Button(t("settings.notifications.openSystemSettings")) {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                } footer: {
                    Text(t("settings.notifications.deniedHint"))
                }
                .listRowBackground(Theme.bg2)
            }
            Section {
                Toggle(t("settings.sections.notifications"), isOn: $notifications.settings.enabled)
                    .tint(model.settings.accent.switchTint)
                    .accessibilityIdentifier(A11y.Settings.notificationsToggle)
                Toggle(t("settings.notifications.sound"), isOn: $notifications.settings.sound)
                    .tint(model.settings.accent.switchTint)
                    .disabled(!notifications.settings.enabled)
                    .accessibilityIdentifier(A11y.Settings.notificationSound)
            } footer: {
                Text(t("settings.notifications.lead"))
            }
            .listRowBackground(Theme.bg2)
            Section {
                Picker(t("settings.notifications.preview"), selection: $notifications.settings.preview) {
                    Text(t("settings.notifications.previewFull")).tag(NotificationSettings.Preview.full)
                    Text(t("settings.notifications.previewSender")).tag(NotificationSettings.Preview.sender)
                    Text(t("settings.notifications.previewNone")).tag(NotificationSettings.Preview.none)
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .disabled(!notifications.settings.enabled)
                .accessibilityIdentifier(A11y.Settings.notificationPreview)
            } header: {
                Text(t("settings.notifications.preview"))
            } footer: {
                Text(t("settings.notifications.previewHint"))
            }
            .listRowBackground(Theme.bg2)
            let unsupported = model.order.filter { notifications.unsupported.contains($0) }.compactMap { model.servers[$0]?.entry.name }
            if !unsupported.isEmpty {
                Section {} footer: {
                    Text(t("settings.notifications.unsupported", ["servers": unsupported.formatted(.list(type: .and).locale(I18n.locale)), "count": unsupported.count]))
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("settings.sections.notifications"))
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: notifications.settings.enabled) { _, enabled in
            if enabled { Task { await notifications.askOnce() } }
        }
    }
}
