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
        // A push that arrives while the app is in front shows as a banner too, but not here.
        try waitFor("the app to leave the screen") { self.zuna.app.state != .runningForeground }
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

        let pushes = try WorldControl.relayCounts().pushes
        let alice = try Peer("alice")
        try alice.send(to: "user:\(bob)", ["text": "Quiet now?"])
        try waitFor("bob's phone to get it") { try self.zuna.texts(with: World.current["alice"].userId).contains("Quiet now?") }
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertEqual(try WorldControl.relayCounts().pushes, pushes)

        // On again, for the other tests.
        zuna.toggle(A11y.Settings.notificationsToggle)
        try waitFor("notifications to be on") { toggle.value as? String == "1" }
    }
}
