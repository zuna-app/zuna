import XCTest

/// The app's frame: the conversation list with live data, its menu and the tabs.
final class ShellTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    func testTheListShowsTheServersConversationsAndFollowsTheCore() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()

        let alice = World.current["alice"]
        let dm = zuna.element(A11y.ChatList.row("user:\(alice.userId)"))
        XCTAssertTrue(dm.waitForExistence(timeout: 20))
        XCTAssertTrue(dm.label.contains("alice"), dm.label)
        // Other tests may have made more groups.
        let group = zuna.app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", A11y.ChatList.row("group:"), "Weekend"))
            .firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 20))
        XCTAssertTrue(group.label.contains("Weekend"), group.label)
        XCTAssertEqual(zuna.element(A11y.Shell.title).label, World.current.serverName)
        zuna.screenshot("10-chat-list")

        // A message from the desktop moves into the preview, with an unread count.
        let text = "Lunch at noon? \(UUID().uuidString.prefix(4))"
        try Peer("alice").send(to: World.current["bob"].userId, text)
        try waitFor("the preview to show alice's message") { dm.label.contains(text) }
        XCTAssertTrue(dm.label.contains("unread"), dm.label)
        zuna.screenshot("11-chat-list-new-message")
    }

    func testOneServerOpensOnItsChatsWithItsMenuInTheTitle() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        // No list of servers to go back to while there's only one.
        XCTAssertFalse(zuna.serversButton.exists)
        XCTAssertFalse(zuna.element(A11y.Servers.list).exists)

        zuna.element(A11y.Shell.title).tap()
        for item in ["Invite people", "New group", "Join a server"] {
            XCTAssertTrue(zuna.app.buttons[item].waitForExistence(timeout: 5), item)
        }
        zuna.screenshot("20-server-menu")
        zuna.app.buttons["Join a server"].tap()
        XCTAssertTrue(zuna.element(A11y.Onboarding.link).waitForExistence(timeout: 5))
        zuna.app.buttons["Cancel"].tap()
        try waitFor("the join screens to close") { !self.zuna.element(A11y.Onboarding.link).exists }
    }

    func testSettingsShowTheAccountAndKeepTheAccent() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()

        zuna.tab("Settings").tap()
        XCTAssertTrue(zuna.app.staticTexts["@bob · \(World.current.serverName)"].waitForExistence(timeout: 10))
        zuna.screenshot("30-settings")

        zuna.element(A11y.Settings.appearance).tap()
        let blue = zuna.element(A11y.Settings.accent("blue"))
        XCTAssertTrue(blue.waitForExistence(timeout: 5))
        blue.tap()
        XCTAssertTrue(blue.isSelected)
        zuna.screenshot("31-appearance-blue")

        // Settings belong to the device, so they outlast the app.
        zuna.app.terminate()
        try zuna.launch(fresh: false)
        try zuna.waitForChats()
        zuna.tab("Settings").tap()
        zuna.element(A11y.Settings.appearance).tap()
        XCTAssertTrue(zuna.element(A11y.Settings.accent("blue")).waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.element(A11y.Settings.accent("blue")).isSelected)
    }
}
