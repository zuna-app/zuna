import XCTest

/// The iPad's layout, like the desktop's: the server rail always there, the
/// conversations beside it and the open chat filling the rest. Runs on an iPad
/// simulator (ZUNA_E2E_SIMULATOR="Zuna E2E iPad"); phones skip it.
final class PadTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(zuna.isPad, "for iPads")
    }

    func testShowsTheRailTheListAndTheChatTogether() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let server = zuna.element(A11y.Drawer.server(zuna.serverId))
        XCTAssertTrue(server.waitForExistence(timeout: 10))
        zuna.screenshot("pad-10-start")

        let alice = zuna.element(A11y.ChatList.row("user:\(World.current["alice"].userId)"))
        XCTAssertTrue(alice.waitForExistence(timeout: 20))
        alice.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 10))
        // The list stays beside the chat.
        XCTAssertTrue(alice.exists)
        XCTAssertTrue(server.exists)
        zuna.screenshot("pad-11-chat")

        zuna.element(A11y.Shell.settingsTab).tap()
        XCTAssertTrue(zuna.element(A11y.Settings.screen).waitForExistence(timeout: 10))
        zuna.screenshot("pad-12-settings")
    }
}
