import Foundation
import os
import UserNotifications
import ZunaHost
import ZunaModels

/// Shows what a push announces, with the message's text, as the desktop words
/// it. The server only says which message arrived, sealed with this device's
/// key; it's fetched and decrypted here with the device's keys, by the same
/// core the app runs. Until the phone has been unlocked with the Zuna password
/// since it started, the push's own generic text shows instead.
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
        mutable.sound = settings.sound ? .default : nil
        PushStore.badge += 1
        mutable.badge = NSNumber(value: PushStore.badge)
        guard let push = PushStore.open(request.content.userInfo) else {
            finish(mutable)
            return
        }
        mutable.userInfo["serverId"] = push.serverId
        // Only this task touches it until it's delivered.
        nonisolated(unsafe) let content = mutable
        Task {
            let show = await fill(content, for: push, settings: settings)
            finish(show ? content : UNNotificationContent())
        }
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

    /// Fills in the message. False when it shouldn't show at all, which only
    /// takes effect with Apple's filtering entitlement.
    private func fill(_ content: UNMutableNotificationContent, for push: PushStore.Message, settings: NotificationSettings) async -> Bool {
        guard let runtime = Self.makeRuntime() else {
            logger.info("The device key is locked; showing the push's own text")
            return true
        }
        let started = Date()
        do {
            let preview = try await runtime.pushPreview(serverId: push.serverId, groupId: push.groupId, messageId: push.messageId)
            logger.info("Previewed a push in \(Int(Date().timeIntervalSince(started) * 1000)) ms, using \(Self.footprint(), format: .fixed(precision: 1)) MB")
            if preview.hidden || preview.muted {
                if PushStore.canFilter { PushStore.badge -= 1 }
                return !PushStore.canFilter
            }
            if let key = preview.conversationKey {
                content.threadIdentifier = "\(preview.serverId)/\(key)"
                content.userInfo["conversationKey"] = key
            }
            switch settings.preview {
            case .full:
                content.title = preview.title
                content.body = preview.body
            case .sender:
                content.title = preview.title
                content.body = "New message"
            case .none:
                break
            }
        } catch {
            logger.error("A push couldn't be previewed: \(String(describing: error), privacy: .public)")
        }
        return true
    }

    private static func makeRuntime() -> CoreRuntime? {
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
