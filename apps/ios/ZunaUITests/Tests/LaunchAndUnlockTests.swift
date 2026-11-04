import XCTest

final class LaunchAndUnlockTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    func testAFreshInstallStartsWithoutAPassword() throws {
        try zuna.launch()
        XCTAssertTrue(zuna.element(A11y.Onboarding.joinWithInvite).waitForExistence(timeout: 15))
        XCTAssertFalse(zuna.element(A11y.Unlock.screen).exists)
    }

    func testAsksForThePasswordOnceAfterThePhoneRestarts() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        // Saved before the sign-in finished, so closing the app right away can't lose it.
        XCTAssertEqual(try zuna.lockEntries(), "1")

        // Reopening the app the same day doesn't ask.
        zuna.app.terminate()
        try zuna.launch(fresh: false)
        try zuna.waitForChats()

        // After a restart of the phone it does.
        zuna.app.terminate()
        try zuna.launch(fresh: false, bootSession: "ui-test-restart")
        let password = zuna.element(A11y.Unlock.password)
        XCTAssertTrue(password.waitForExistence(timeout: 15))
        zuna.screenshot("02-unlock")

        password.tap()
        password.typeText("not my password")
        zuna.element(A11y.Unlock.submit).tap()
        XCTAssertTrue(zuna.element(A11y.Unlock.error).waitForExistence(timeout: 15))
        zuna.screenshot("03-unlock-wrong-password")

        password.tap()
        password.typeText(World.current["bob"].password)
        zuna.element(A11y.Unlock.submit).tap()
        try zuna.waitForChats()
        XCTAssertEqual(try zuna.state(), "ready")
    }

    func testMessagesFromADesktopPeerReachTheApp() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        let alice = try Peer("alice")
        let text = "hello from the desktop, \(UUID().uuidString.prefix(6))"
        try alice.send(to: World.current["bob"].userId, text)
        try waitFor("bob's phone to receive alice's message") {
            try self.zuna.texts(with: alice.account.userId).contains(text)
        }
    }
}
