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

    func testOpensOnTheServersChatsWithItsMenuInTheTitleAndJoinsFromTheServerButton() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        // The chats are the first screen, with the server's picture at the top left.
        XCTAssertFalse(zuna.element(A11y.Servers.list).exists)
        XCTAssertTrue(zuna.serverButton.label.contains(World.current.serverName), zuna.serverButton.label)

        // Joining another server starts from the list of servers.
        zuna.serverButton.tap()
        XCTAssertTrue(zuna.element(A11y.Servers.list).waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.element(A11y.Servers.row(zuna.serverId)).exists)
        zuna.screenshot("21-servers-sheet")
        zuna.element(A11y.Servers.join).tap()
        XCTAssertTrue(zuna.element(A11y.Onboarding.link).waitForExistence(timeout: 10))
        // Inside the app the link comes first, with signing in to another server under it.
        XCTAssertTrue(zuna.element(A11y.Onboarding.signIn).exists)
        zuna.app.buttons["Cancel"].tap()
        try waitFor("the join screens to close") { !self.zuna.element(A11y.Onboarding.link).exists }

        // The server's own menu is under its name, last, as nothing closes it but a choice.
        zuna.element(A11y.Shell.title).tap()
        for item in ["Invite people", "New group"] {
            XCTAssertTrue(zuna.app.buttons[item].waitForExistence(timeout: 5), item)
        }
        zuna.screenshot("20-server-menu")
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

    func testPicksTheLightAppIconAndKeepsIt() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let light = zuna.element(A11y.Settings.appIcon("light"))
        let dark = zuna.element(A11y.Settings.appIcon("dark"))

        zuna.tab("Settings").tap()
        zuna.element(A11y.Settings.appearance).tap()
        XCTAssertTrue(dark.waitForExistence(timeout: 5))
        XCTAssertTrue(dark.isSelected)
        light.tap()
        try dismissIconChanged()
        XCTAssertTrue(light.isSelected)
        zuna.screenshot("32-appearance-light-icon")

        // iOS keeps the icon, not the app, so it outlasts the app and its data.
        zuna.app.terminate()
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        zuna.tab("Settings").tap()
        zuna.element(A11y.Settings.appearance).tap()
        XCTAssertTrue(light.waitForExistence(timeout: 5))
        XCTAssertTrue(light.isSelected)

        // Back to the dark one, which the other tests and the next run expect.
        dark.tap()
        try dismissIconChanged()
        XCTAssertTrue(dark.isSelected)
    }

    /// iOS says each time that the icon changed, showing the new one: SpringBoard's
    /// alert, in the system's language, with only OK.
    private func dismissIconChanged() throws {
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        zuna.screenshotScreen("33-app-icon-changed")
        alert.buttons.firstMatch.tap()
        try waitFor("the alert to close") { !alert.exists }
    }
}
