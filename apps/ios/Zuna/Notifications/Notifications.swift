import UserNotifications

/// Notifications on this device. The app asks for them once a server's chats
/// first show, as Telegram does after signing in.
@MainActor
enum Notifications {
    static func askOnce() async {
        #if DEBUG
        // UI tests keep the system's question out of the way unless they're about notifications.
        let defaults = UserDefaults.standard
        if defaults.object(forKey: "ZunaAskForNotifications") != nil, !defaults.bool(forKey: "ZunaAskForNotifications") { return }
        #endif
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }
}
