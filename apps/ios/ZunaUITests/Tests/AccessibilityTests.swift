import XCTest

/// The screens with the largest accessibility text sizes: everything still
/// reachable, nothing cut off where it matters. Screenshots for review.
final class AccessibilityTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    func testLargeTextKeepsTheScreensUsable() throws {
        let alice = try Peer("alice")
        try alice.send(to: "user:\(World.current["bob"].userId)", ["text": "Large text should wrap **nicely** in a bubble, even when it's long."])
        try zuna.launch(textSize: "UICTContentSizeCategoryAccessibilityXL")
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        zuna.screenshot("a11y-10-list")

        let row = zuna.element(A11y.ChatList.row("user:\(World.current["alice"].userId)"))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        let input = zuna.element(A11y.Composer.input)
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue(input.isHittable)
        // With nothing written, the microphone takes Send's place.
        XCTAssertTrue(zuna.element(A11y.Composer.microphone).isHittable)
        zuna.screenshot("a11y-11-chat")

        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        zuna.tab("Settings").tap()
        XCTAssertTrue(zuna.element(A11y.Settings.screen).waitForExistence(timeout: 10))
        zuna.screenshot("a11y-12-settings")
    }
}
