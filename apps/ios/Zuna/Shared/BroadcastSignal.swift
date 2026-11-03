import Foundation

/// What the app tells its broadcast extension (ZunaBroadcast) about a broadcast that's started: that a call
/// took it, or why none could. Darwin notifications carry nothing, so the reason goes through the App
/// Group's defaults. Without an answer the extension would go on for as long as it ran, since LiveKit's
/// waits for the app for ever, and the screen would be recorded for nobody.
enum BroadcastSignal {
    static let taken = "chat.zuna.mobile.broadcast.taken"
    static let refused = "chat.zuna.mobile.broadcast.refused"

    private static let reasonKey = "zuna-broadcast-refusal"

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    }

    /// Ends a broadcast no call can take, with something to tell the person.
    static func refuse(_ reason: String) {
        UserDefaults(suiteName: SharedStorage.appGroup)?.set(reason, forKey: reasonKey)
        post(refused)
    }

    /// Why the app last refused a broadcast.
    static var reason: String? {
        UserDefaults(suiteName: SharedStorage.appGroup)?.string(forKey: reasonKey)
    }
}
