import Foundation
import os
import UserNotifications
import ZunaHost
import ZunaModels

/// Shows what a push announces, with the message's text, as the desktop words
/// it. The server only says which message arrived, sealed with this device's
/// key; it's fetched and decrypted here with the device's keys, by the same
/// core the app runs. Until the phone has been unlocked with the Zuna password
/// since it started, the push's own generic text shows instead. A call ringing
/// comes here only where CallKit is left out, as on China's App Store, which
/// otherwise has it ring as a phone call through PushKit.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private let logger = Logger(subsystem: "chat.zuna", category: "notifications")
    private var deliver: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?

    /// One core per process: iOS may keep the extension for several pushes.
    nonisolated(unsafe) private static var runtime: CoreRuntime?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        deliver = contentHandler
        fallback = request.content
        let settings = NotificationSettings.load()
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            finish(request.content)
            return
        }
        // Telegram's own, for an account linked on this phone (docs/TELEGRAM_PLAN.md): worded here
        // from the push alone, as nothing on the phone can fetch the message.
        if let telegram = TelegramPush(request.content.userInfo) {
            finish(Self.telegram(telegram, mutable, settings: settings))
            return
        }
        let opened = PushStore.open(request.content.userInfo)
        if opened == nil, !PushStore.registrations().isEmpty {
            // Not sealed for a server this device is on, such as one it left, which can push until its handle
            // stops working. Without the filtering entitlement iOS shows it all the same, so it's quiet and
            // doesn't count. With no registrations to read, as before the phone is first unlocked, it can't tell.
            mutable.sound = nil
            finish(mutable)
            return
        }
        mutable.sound = settings.sound ? .default : nil
        PushStore.badge += 1
        mutable.badge = NSNumber(value: PushStore.badge)
        if let push = opened, push.kind == .call, let callerId = push.callerId {
            PushStore.badge -= 1
            mutable.badge = nil
            mutable.userInfo["serverId"] = push.serverId
            mutable.userInfo["groupId"] = push.groupId
            nonisolated(unsafe) let content = mutable
            Task {
                finish(await ring(content, for: push, callerId: callerId, settings: settings))
            }
            return
        }
        guard let push = opened, push.kind == .message, let messageId = push.messageId else {
            finish(mutable)
            return
        }
        mutable.userInfo["serverId"] = push.serverId
        // Only this task touches it until it's delivered.
        nonisolated(unsafe) let content = mutable
        Task {
            let clearing = Self.clearRead(serverId: push.serverId)
            nonisolated(unsafe) let filled = await fill(content, for: push, messageId: messageId, settings: settings)
            finish(await Self.counted(filled, after: clearing))
        }
    }

    /// While the message is fetched, the server is asked which chats it still counts this phone as showing a
    /// notification for, and what it shows for any other goes: they were read on another device, and the
    /// silent push that says so came late or not at all, as it never does to an app its person closed. The
    /// extension runs for every message pushed, whatever state the app is in.
    private static func clearRead(serverId: String) -> Task<Int, Never>? {
        guard let runtime = makeRuntime() else { return nil }
        let asked = Date()
        return Task {
            guard let notified = try? await runtime.stillNotified(serverId: serverId) else { return 0 }
            return await PushStore.clearRead(serverId: serverId, stillNotified: notified, shownBefore: asked)
        }
    }

    /// The notification with the badge as it is once the read chats' notifications have gone, which the
    /// message isn't kept waiting for long.
    private static func counted(_ content: UNNotificationContent, after clearing: Task<Int, Never>?) async -> UNNotificationContent {
        guard let clearing, let cleared = await result(of: clearing, within: 1), cleared > 0, content.badge != nil,
              let counted = content.mutableCopy() as? UNMutableNotificationContent else { return content }
        counted.badge = NSNumber(value: PushStore.badge)
        return counted
    }

    /// Telegram's push as the app words Telegram's notifications, counted in the app's own badge
    /// rather than Telegram's. What shows nothing in Telegram's app is quiet here too, as far as iOS
    /// lets a push be without the filtering entitlement.
    private static func telegram(_ push: TelegramPush, _ content: UNMutableNotificationContent, settings: NotificationSettings) -> UNNotificationContent {
        guard push.kind == .message else {
            content.sound = nil
            content.badge = nil
            return content
        }
        PushStore.badge += 1
        let worded = push.content(base: content, settings: settings)
        worded.badge = NSNumber(value: PushStore.badge)
        return worded
    }

    override func serviceExtensionTimeWillExpire() {
        logger.warning("Ran out of time for a notification")
        if let fallback { finish(fallback) }
    }

    private func finish(_ content: UNNotificationContent) {
        guard let deliver else { return }
        self.deliver = nil
        deliver(content)
    }

    /// The message's notification. Empty when it shouldn't show at all, which
    /// only takes effect with Apple's filtering entitlement.
    private func fill(_ content: UNMutableNotificationContent, for push: PushStore.Message, messageId: String, settings: NotificationSettings) async -> UNNotificationContent {
        guard let runtime = Self.makeRuntime() else {
            logger.info("The device key is locked; showing the push's own text")
            return content
        }
        let started = Date()
        do {
            let preview = try await runtime.pushPreview(
                serverId: push.serverId,
                groupId: push.groupId,
                messageId: messageId,
                pictures: settings.preview != .none
            )
            logger.info("Previewed a push in \(Int(Date().timeIntervalSince(started) * 1000)) ms, using \(Self.footprint(), format: .fixed(precision: 1)) MB")
            // Kept in the log, as it's what someone asks about later: a notification that only said a message came.
            if !preview.decrypted, !preview.hidden { logger.notice("A pushed message couldn't be read with what this device holds") }
            if preview.hidden || preview.muted {
                guard PushStore.canFilter else { return content }
                PushStore.badge -= 1
                return UNNotificationContent()
            }
            return await MessageNotification.content(for: preview, settings: settings, base: content)
        } catch {
            logger.error("A push couldn't be previewed: \(String(describing: error), privacy: .public)")
            return content
        }
    }

    /// A call ringing, worded as the app would, with a ringtone unless the conversation is muted.
    private func ring(_ content: UNMutableNotificationContent, for push: PushStore.Message, callerId: String, settings: NotificationSettings) async -> UNNotificationContent {
        content.sound = settings.sound ? .defaultRingtone : nil
        content.categoryIdentifier = "call"
        guard let runtime = Self.makeRuntime() else { return content }
        do {
            let call = try await runtime.callPreview(serverId: push.serverId, groupId: push.groupId, callerId: callerId)
            if call.hidden {
                guard PushStore.canFilter else { return content }
                return UNNotificationContent()
            }
            if settings.preview != .none {
                content.title = call.title
                content.body = call.body
            }
            if let key = call.conversationKey { content.userInfo["conversationKey"] = key }
            if call.muted { content.sound = nil }
            return content
        } catch {
            logger.error("A call's push couldn't be worded: \(String(describing: error), privacy: .public)")
            return content
        }
    }

    private static func makeRuntime() -> CoreRuntime? {
        // The proxy set in Privacy, read again for each push, as it may have changed since the last.
        if ProxyStore.apply() { runtime?.networkChanged() }
        if let runtime { return runtime }
        guard let key = DeviceKeyStore.unlockedKey(), let directory = try? SharedStorage.dataDirectory() else { return nil }
        let created = try? CoreRuntime(options: CoreRuntime.Options(dataDirectory: directory, deviceKey: key, deviceName: ""))
        runtime = created
        return created
    }

    /// The extension's memory footprint in MB; iOS caps it at about 24.
    private static func footprint() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }
}
