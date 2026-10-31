import XCTest

/// Notifications, end to end on the simulator: the app registers with the
/// orchestrator's stand-in for zuna-push, the server pushes sealed IDs through
/// it, and it hands them to the simulator as APNs would. `simctl push` skips
/// the notification extension, so the text shown is the push's own; the
/// extension's decryption is checked by the cross-client tests (tests/e2e),
/// with the same code and without JIT, as on a phone.
final class NotificationTests: XCTestCase {
    private let zuna = AppUnderTest()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var bob: String { World.current["bob"].userId }

    override func setUp() {
        continueAfterFailure = false
    }

    /// Signs in as bob with notifications allowed and registered.
    private func start() throws {
        let before = try WorldControl.relayCounts().registrations
        try zuna.launch(notifications: true)
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        // Asked once the chats show, as Telegram does; later tests find it answered.
        // "Allow" is the second button, whatever the system's language.
        let question = springboard.alerts.firstMatch
        if question.waitForExistence(timeout: 5) {
            zuna.screenshotScreen("100-notification-question")
            question.buttons.element(boundBy: 1).tap()
        }
        try waitFor("the app to register with the relay", timeout: 20) { try WorldControl.relayCounts().registrations > before }
        // The server hears about it right after the relay.
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    }

    private func leaveTheApp() throws {
        XCUIDevice.shared.press(.home)
        try waitFor("the app to leave the screen") { self.zuna.app.state != .runningForeground }
        // While bob uses the phone, nothing is pushed to it; his laptop hears when he stops.
        let laptop = try Peer("bobLaptop")
        try waitFor("the server to hear bob left the phone") { try laptop.call("isActiveElsewhere") as? Bool == false }
    }

    private var banner: XCUIElement {
        springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "New message")).firstMatch
    }

    func testAPushThroughTheRelayOpensTheChat() throws {
        try start()
        try leaveTheApp()
        try Peer("alice").send(to: "user:\(bob)", ["text": "Are you coming tonight?"])
        XCTAssertTrue(banner.waitForExistence(timeout: 20))
        zuna.screenshotScreen("101-notification")

        banner.tap()
        let title = zuna.element(A11y.Chat.title)
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertTrue(title.label.contains("alice"), title.label)
        zuna.screenshot("102-opened-from-notification")
    }

    func testRepliesFromTheNotification() throws {
        try start()
        try leaveTheApp()
        let alice = try Peer("alice")
        try alice.send(to: "user:\(bob)", ["text": "Lunch tomorrow?"])
        XCTAssertTrue(banner.waitForExistence(timeout: 20))

        banner.press(forDuration: 1.2)
        let reply = springboard.buttons["Reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertTrue(springboard.buttons["Mark as read"].exists)
        zuna.screenshotScreen("103-notification-actions")
        reply.tap()
        springboard.typeText("Sure, at noon")
        springboard.buttons["Send"].tap()
        // The app does it in the background, and the desktop gets it.
        try waitFor("alice to get the reply", timeout: 30) { try alice.texts(with: self.bob).contains("Sure, at noon") }
    }

    func testShowsMessagesWhileTheAppIsOpenWithTheSendersPicture() throws {
        try start()
        let alice = try Peer("alice")
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let face = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format).pngData { context in
            UIColor(red: 0.85, green: 0.45, blue: 0.3, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
            UIColor.white.setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 78, y: 48, width: 100, height: 100))
            context.cgContext.fillEllipse(in: CGRect(x: 38, y: 160, width: 180, height: 140))
        }
        try alice.setPicture(face)
        defer { try? alice.setPicture(nil) }
        let control = zuna.control!, serverId = zuna.serverId, aliceId = World.current["alice"].userId
        try waitFor("bob's phone to see alice's picture") {
            try blocking {
                let users = try await control.call("getUsers", server: serverId) as? [[String: Any]] ?? []
                return users.first { $0["id"] as? String == aliceId }?["avatar"] is [String: Any]
            }
        }

        // While the app is open, it shows a new message itself, as the extension would:
        // the sender's name and picture, and the message.
        let text = "Here's my new picture"
        try alice.send(to: "user:\(bob)", ["text": text])
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 15))
        XCTAssertTrue(banner.label.contains("alice"), banner.label)
        zuna.screenshotScreen("105-notification-with-picture")

        // A group: its name, the sender's picture, and the message without the name in front.
        let conversations = try alice.call("getConversations") as? [[String: Any]] ?? []
        let weekend = try XCTUnwrap(conversations.first { $0["title"] as? String == "Weekend" }?["groupId"] as? String)
        let plans = "Bring the board games"
        try alice.send(to: "group:\(weekend)", ["text": plans])
        let groupBanner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", plans)).firstMatch
        XCTAssertTrue(groupBanner.waitForExistence(timeout: 15))
        XCTAssertTrue(groupBanner.label.contains("Weekend"), groupBanner.label)
        XCTAssertFalse(groupBanner.label.contains("alice: \(plans)"), groupBanner.label)
        zuna.screenshotScreen("106-group-notification")
    }

    func testThePhoneKeepsQuietWhileTheDesktopIsInUse() throws {
        try start()
        try leaveTheApp()
        let alice = try Peer("alice"), laptop = try Peer("bobLaptop"), aliceId = World.current["alice"].userId

        // Bob at his laptop: nothing is pushed to the phone.
        _ = try laptop.callClient("setActive", [true])
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        let pushes = try WorldControl.relayCounts().pushes
        try alice.send(to: "user:\(bob)", ["text": "Are you at your desk?"])
        try waitFor("the laptop to get it") { try laptop.texts(with: aliceId).contains("Are you at your desk?") }
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertEqual(try WorldControl.relayCounts().pushes, pushes)

        // Away from it: the phone gets them again.
        _ = try laptop.callClient("setActive", [false])
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        try alice.send(to: "user:\(bob)", ["text": "Now?"])
        XCTAssertTrue(banner.waitForExistence(timeout: 20))
    }

    func testClearsWhatWasReadOrDeletedElsewhere() throws {
        try start()
        try zuna.clearNotifications()
        try leaveTheApp()
        let alice = try Peer("alice"), laptop = try Peer("bobLaptop"), aliceId = World.current["alice"].userId
        let before = try WorldControl.relayCounts()
        let first = try alice.send(to: "user:\(bob)", ["text": "Take one"])
        try alice.send(to: "user:\(bob)", ["text": "Take two"])
        try waitFor("both pushes") { try WorldControl.relayCounts().pushes >= before.pushes + 2 }
        XCTAssertTrue(banner.waitForExistence(timeout: 20))
        XCTAssertTrue(openNotificationCenter().waitForExistence(timeout: 5))
        zuna.screenshotScreen("107-notification-center")
        XCUIDevice.shared.press(.home)

        // Alice deletes one, and bob reads the chat on his laptop: each sends the phone a silent push.
        let groupId = try XCTUnwrap(try alice.conversation("user:\(bob)")?["groupId"] as? String)
        _ = try alice.call("deleteMessage", [groupId, first])
        try waitFor("the laptop to have the rest") { try laptop.texts(with: aliceId).contains("Take two") }
        let chat = try XCTUnwrap(try laptop.conversation("user:\(aliceId)"))
        let seq = try XCTUnwrap((chat["lastMessage"] as? [String: Any])?["seq"] as? Int)
        _ = try laptop.call("markRead", [groupId, seq])
        try waitFor("two silent pushes to the phone", timeout: 15) { try WorldControl.relayCounts().silent >= before.silent + 2 }

        // simctl turns a silent push into a background fetch without the push, so the
        // phone clears them once the app catches up, with the same code the push runs.
        zuna.app.activate()
        try waitFor("the notifications to go", timeout: 20) { try self.zuna.deliveredNotifications() == 0 }
    }

    /// Pulls down the notification center and finds Zuna's notification in it.
    private func openNotificationCenter() -> XCUIElement {
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.0))
        top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.7)))
        return springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "New message")).firstMatch
    }

    func testTurningNotificationsOffStopsPushes() throws {
        try start()
        zuna.tab("Settings").tap()
        zuna.element(A11y.Settings.notifications).tap()
        let toggle = zuna.app.switches[A11y.Settings.notificationsToggle]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        zuna.screenshot("104-notification-settings")
        zuna.toggle(A11y.Settings.notificationsToggle)
        try waitFor("notifications to be off") { toggle.value as? String == "0" }
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))

        // Away from the app, which would otherwise be pushed to.
        try leaveTheApp()
        let pushes = try WorldControl.relayCounts().pushes
        let alice = try Peer("alice"), laptop = try Peer("bobLaptop")
        try alice.send(to: "user:\(bob)", ["text": "Quiet now?"])
        try waitFor("the server to have it") { try laptop.texts(with: World.current["alice"].userId).contains("Quiet now?") }
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertEqual(try WorldControl.relayCounts().pushes, pushes)

        // On again, for the other tests.
        zuna.app.activate()
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        zuna.toggle(A11y.Settings.notificationsToggle)
        try waitFor("notifications to be on") { toggle.value as? String == "1" }
    }
}
