import SwiftUI
import ZunaModels

/// How long to mute a chat for, as in Telegram.
enum MuteDuration: CaseIterable, Identifiable {
    case hour, eightHours, day, forever

    var id: Self { self }

    var title: String {
        switch self {
        case .hour: t("conversations.mute.hour")
        case .eightHours: t("conversations.mute.eightHours")
        case .day: t("conversations.mute.day")
        case .forever: t("conversations.mute.untilUnmuted")
        }
    }

    /// When it ends, or nil for until it's unmuted.
    var until: Date? {
        switch self {
        case .hour: Date().addingTimeInterval(3600)
        case .eightHours: Date().addingTimeInterval(8 * 3600)
        case .day: Date().addingTimeInterval(24 * 3600)
        case .forever: nil
        }
    }
}

/// The choices of how long to mute a chat, for a menu or a dialog.
struct MuteButtons: View {
    @Environment(AppModel.self) private var model
    let conversationKey: String
    let serverId: String

    var body: some View {
        ForEach(MuteDuration.allCases) { duration in
            Button(duration.title) { model.mute(conversationKey, until: duration.until, on: serverId) }
        }
    }
}

extension Format {
    /// "Muted until 18:00", with the day unless it's today.
    static func mutedUntil(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let style: Date.FormatStyle = Calendar.current.isDateInToday(date) ? .dateTime.hour().minute() : .dateTime.weekday(.abbreviated).hour().minute()
        return t("conversations.mute.mutedUntil", ["time": date.formatted(style.locale(I18n.locale))])
    }
}
