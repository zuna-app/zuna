import XCTest

/// Notifications on the simulator. `simctl push` hands a push straight to the
/// system, skipping the notification extension, so the text shown here is the
/// push's own; the extension's decryption is checked by the cross-client tests
/// (tests/e2e), with the same code and without JIT, as on a phone.
final class NotificationTests: XCTestCase {
    private let zuna = AppUnderTest()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUp() {
        continueAfterFailure = false
    }

    func testAsksOnceTheChatsShowAndShowsPushes() throws {
        try zuna.launch(notifications: true)
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        // Asked once the chats show, as Telegram does. "Allow" is the second button, whatever the system's language.
        let question = springboard.alerts.firstMatch
        XCTAssertTrue(question.waitForExistence(timeout: 10))
        zuna.screenshotScreen("100-notification-question")
        question.buttons.element(boundBy: 1).tap()
        XCUIDevice.shared.press(.home)
        // A push that arrives while the app is in front isn't shown.
        try waitFor("the app to leave the screen") { self.zuna.app.state != .runningForeground }

        let alice = try Peer("alice")
        let bob = World.current["bob"].userId
        let messageId = try alice.send(to: "user:\(bob)", ["text": "Dinner at eight?"])
        let groupId = try XCTUnwrap(try alice.conversation("user:\(bob)")?["groupId"] as? String)
        try WorldControl.push([
            "aps": ["alert": ["title": "Zuna", "body": "New message"], "mutable-content": 1, "sound": "default"],
            "zuna": ["s": zuna.serverId, "g": groupId, "m": messageId],
        ])
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "New message")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 20))
        zuna.screenshotScreen("101-notification")
    }
}
