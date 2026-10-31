import Foundation
import os
import UIKit
import UserNotifications
import ZunaModels

/// Notifications on this device: asking for them, registering with the push
/// relay and every server, showing them while the app is open, and acting on
/// them. The notification extension (ZunaNotifications) fills in the text.
@MainActor
@Observable
final class Notifications {
    /// The category of message notifications, with Reply and Mark as read.
    static let messageCategory = "message"
    static let replyAction = "reply"
    static let markReadAction = "markRead"

    var settings = NotificationSettings.load() {
        didSet {
            guard settings != oldValue else { return }
            settings.save()
            Task { await refresh() }
        }
    }
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// Servers that don't send notifications through this app's relay.
    private(set) var unsupported: Set<String> = []
    /// The device's APNs token, as hex.
    var token: String? {
        didSet { if token != oldValue { Task { await refresh() } } }
    }

    private let model: AppModel
    private let logger = Logger(subsystem: "chat.zuna", category: "notifications")
    private var refreshing = false
    private var refreshAgain = false

    init(model: AppModel) {
        self.model = model
        #if DEBUG
        // UI tests stand in for APNs, which the simulator can't use without the app's push key.
        if let token = UserDefaults.standard.string(forKey: "ZunaPushToken") { self.token = token }
        #endif
        observeUnread()
    }

    static var categories: Set<UNNotificationCategory> {
        let reply = UNTextInputNotificationAction(
            identifier: replyAction,
            title: "Reply",
            options: [.authenticationRequired],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Message"
        )
        let read = UNNotificationAction(identifier: markReadAction, title: "Mark as read", options: [.authenticationRequired])
        return [UNNotificationCategory(identifier: messageCategory, actions: [reply, read], intentIdentifiers: [], options: [])]
    }

    /// The relay the app registers with: the build's, or a test's.
    static var relay: String? {
        #if DEBUG
        if let relay = UserDefaults.standard.string(forKey: "ZunaPushRelay") { return relay }
        #endif
        let relay = Bundle.main.object(forInfoDictionaryKey: "ZunaPushRelay") as? String ?? ""
        return relay.isEmpty ? nil : relay
    }

    // MARK: Asking and registering

    /// Asks for notifications once a server's chats first show, as Telegram does after signing in.
    func askOnce() async {
        #if DEBUG
        // UI tests keep the system's question out of the way unless they're about notifications.
        let defaults = UserDefaults.standard
        if defaults.object(forKey: "ZunaAskForNotifications") != nil, !defaults.bool(forKey: "ZunaAskForNotifications") {
            await updateAuthorization()
            return
        }
        #endif
        let center = UNUserNotificationCenter.current()
        if await center.notificationSettings().authorizationStatus == .notDetermined, settings.enabled {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        await updateAuthorization()
    }

    /// Picks up a change made in iOS Settings, and registers for pushes when allowed.
    func updateAuthorization() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        let changed = status != authorization
        authorization = status
        if allowed { UIApplication.shared.registerForRemoteNotifications() }
        if changed { await refresh() }
    }

    private var allowed: Bool {
        [.authorized, .provisional, .ephemeral].contains(authorization)
    }

    /// Registers this device with the relay and every server, or stops pushes
    /// when notifications are off. Runs again after the servers change.
    func refresh() async {
        guard !refreshing else {
            refreshAgain = true
            return
        }
        refreshing = true
        defer {
            refreshing = false
            if refreshAgain {
                refreshAgain = false
                Task { await refresh() }
            }
        }
        PushStore.keep(servers: model.order)
        guard let relay = Self.relay else { return }
        let wanted = settings.enabled && allowed
        var handle: String?
        if wanted, let token {
            handle = await relayHandle(relay: relay, token: token)
        }
        for serverId in model.order {
            let session = model.core.session(serverId)
            do {
                if !wanted {
                    try await session.setPush(nil)
                } else if let handle {
                    let (id, registration) = PushStore.registration(for: serverId)
                    try await session.setPush(PushSettings(relay: relay, handle: handle, key: registration.key, registration: id, sendMuted: !PushStore.canFilter))
                }
                unsupported.remove(serverId)
            } catch let error as CoreCallError where error.code == "relay_not_allowed" {
                unsupported.insert(serverId)
            } catch {
                logger.warning("Couldn't update notifications for a server: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// The relay's handle for this device, remembered for the same token.
    private func relayHandle(relay: String, token: String) async -> String? {
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let cacheKey = "zuna-relay-handle|\(relay)|\(token)|\(environment)"
        if let cached = PushStore.defaults.string(forKey: cacheKey) { return cached }
        guard let url = URL(string: "\(relay)/v1/register") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["platform": "apns", "token": token, "environment": environment])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let handle = try JSONDecoder().decode([String: String].self, from: data)["handle"] else { return nil }
            PushStore.defaults.set(handle, forKey: cacheKey)
            return handle
        } catch {
            logger.warning("The push relay couldn't be reached: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    // MARK: Showing and acting

    /// Where a notification leads: the server and the chat, as the extension
    /// filled them in, or from the push itself.
    private func target(of userInfo: [AnyHashable: Any]) -> (serverId: String, groupId: String?, key: String?)? {
        let opened = PushStore.open(userInfo)
        guard let serverId = userInfo["serverId"] as? String ?? opened?.serverId else { return nil }
        let groupId = opened?.groupId
        let key = userInfo["conversationKey"] as? String
            ?? groupId.flatMap { id in model.servers[serverId]?.conversations.first { $0.groupId == id }?.key }
        return (serverId, groupId, key)
    }

    /// While the app is open, notifications show as banners, except for the chat on screen.
    func presentation(for notification: UNNotification) -> UNNotificationPresentationOptions {
        if let target = target(of: notification.request.content.userInfo), let key = target.key,
           model.activeServerId == target.serverId, model.tab == .chats, model.chatPath.last == .chat(key) {
            return []
        }
        return settings.sound ? [.banner, .list, .sound] : [.banner, .list]
    }

    /// A tap opens the chat; Reply sends, and Mark as read marks it, both as the desktop would.
    func respond(to response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        guard let target = target(of: userInfo) else {
            logger.warning("A notification's push couldn't be opened")
            return
        }
        logger.info("Acting on a notification: \(response.actionIdentifier, privacy: .public)")
        switch response.actionIdentifier {
        case Self.replyAction:
            guard let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else { return }
            await reply(text, to: target)
        case Self.markReadAction:
            await markRead(target)
        default:
            model.selectServer(target.serverId)
            if let key = await conversationKey(target) {
                model.openChat(key)
            } else {
                model.tab = .chats
                model.showingServers = false
            }
        }
    }

    /// The chat's key, waiting for the server to catch up if the chat is new to this device.
    private func conversationKey(_ target: (serverId: String, groupId: String?, key: String?)) async -> String? {
        if let key = target.key { return key }
        guard let groupId = target.groupId else { return nil }
        for _ in 0..<50 {
            if let key = model.servers[target.serverId]?.conversations.first(where: { $0.groupId == groupId })?.key { return key }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return nil
    }

    private func reply(_ text: String, to target: (serverId: String, groupId: String?, key: String?)) async {
        guard let key = await conversationKey(target) else { return }
        let session = model.core.session(target.serverId)
        do {
            let sent = try await session.sendMessage(key, MessageBody(text: text))
            // Wait for it to leave the outbox before the app may be suspended again.
            for _ in 0..<75 {
                let page = try await session.loadMessages(sent.groupId)
                if page.messages.contains(where: { $0.id == sent.id && $0.status == .sent }) { break }
                try await Task.sleep(for: .milliseconds(200))
            }
        } catch {
            logger.error("A reply from a notification couldn't be sent: \(String(describing: error), privacy: .public)")
        }
        await markRead(target)
    }

    private func markRead(_ target: (serverId: String, groupId: String?, key: String?)) async {
        guard let key = await conversationKey(target) else { return }
        // Up to the newest message the server has, once this device has caught up.
        for _ in 0..<50 {
            if model.servers[target.serverId]?.connection == .online { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard let conversation = model.servers[target.serverId]?.conversations.first(where: { $0.key == key }),
              let groupId = conversation.groupId, let seq = conversation.lastMessage?.seq else { return }
        try? await model.core.session(target.serverId).markRead(groupId, seq: seq)
    }

    // MARK: Badge and clearing

    /// Keeps the icon's badge at the unread count, and clears the notifications of chats that were read, here or elsewhere.
    private func observeUnread() {
        withObservationTracking {
            _ = model.totalUnread
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.syncUnread()
                self.observeUnread()
            }
        }
        syncUnread()
    }

    private func syncUnread() {
        let total = model.totalUnread
        PushStore.badge = total
        UNUserNotificationCenter.current().setBadgeCount(total)
        var read: Set<String> = []
        for (serverId, server) in model.servers {
            for conversation in server.conversations where conversation.unread == 0 {
                read.insert("\(serverId)/\(conversation.key)")
            }
        }
        Task {
            let center = UNUserNotificationCenter.current()
            let stale = await center.deliveredNotifications()
                .filter { read.contains($0.request.content.threadIdentifier) }
                .map(\.request.identifier)
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
        }
    }
}
