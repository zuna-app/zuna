import Foundation
import os
import UserNotifications
import ZunaHost
import ZunaModels

/// Shows what a push announces, with the message's text, as the desktop words
/// it. The server only says which message arrived; it's fetched and decrypted
/// here with the device's keys, by the same core the app runs. Until the phone
/// has been unlocked with the Zuna password since it started, the push's own
/// generic text shows instead.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private let logger = Logger(subsystem: "chat.zuna", category: "notifications")
    private var deliver: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?

    /// One core per process: iOS may keep the extension for several pushes.
    nonisolated(unsafe) private static var runtime: CoreRuntime?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        deliver = contentHandler
        fallback = request.content
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent,
              let push = PushPayload(request.content.userInfo) else {
            finish(request.content)
            return
        }
        // Only this task touches it until it's delivered.
        nonisolated(unsafe) let content = mutable
        Task {
            await fill(content, for: push)
            finish(content)
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

    private func fill(_ content: UNMutableNotificationContent, for push: PushPayload) async {
        guard let runtime = Self.makeRuntime() else {
            logger.info("The device key is locked; showing the push's own text")
            return
        }
        let started = Date()
        let before = Self.footprint()
        do {
            let preview = try await runtime.pushPreview(serverId: push.serverId, groupId: push.groupId, messageId: push.messageId)
            logger.info(
                "Previewed a push in \(Int(Date().timeIntervalSince(started) * 1000)) ms, memory \(before, format: .fixed(precision: 1)) → \(Self.footprint(), format: .fixed(precision: 1)) MB"
            )
            // Without Apple's filtering entitlement a notification can't be dropped; muted chats are skipped by the server.
            guard !preview.hidden, !preview.muted else { return }
            content.title = preview.title
            content.body = preview.body
            if let key = preview.conversationKey {
                content.threadIdentifier = "\(preview.serverId)/\(key)"
                content.userInfo["conversationKey"] = key
            }
            content.userInfo["serverId"] = preview.serverId
        } catch {
            logger.error("A push couldn't be previewed: \(String(describing: error), privacy: .public)")
        }
    }

    private static func makeRuntime() -> CoreRuntime? {
        if let runtime { return runtime }
        guard let key = DeviceKeyStore.unlockedKey(), let directory = try? SharedStorage.dataDirectory() else { return nil }
        let created = try? CoreRuntime(options: CoreRuntime.Options(dataDirectory: directory, deviceKey: key, deviceName: ""))
        runtime = created
        return created
    }

    /// The extension's memory footprint, which iOS caps at about 24 MB, in MB.
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

/// Which message a push is about.
struct PushPayload {
    let serverId: String
    let groupId: String
    let messageId: String

    init?(_ userInfo: [AnyHashable: Any]) {
        guard let zuna = userInfo["zuna"] as? [String: Any],
              let serverId = zuna["s"] as? String,
              let groupId = zuna["g"] as? String,
              let messageId = zuna["m"] as? String else { return nil }
        self.serverId = serverId
        self.groupId = groupId
        self.messageId = messageId
    }
}
