import XCTest

/// The app's frame: the conversation list with live data, the server drawer and the tabs.
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

    func testTheServerDrawerOpensFromTheButtonAndTheEdge() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let drawer = zuna.element(A11y.Drawer.screen)
        let server = zuna.element(A11y.Drawer.server(zuna.serverId))

        zuna.element(A11y.Shell.serverButton).tap()
        XCTAssertTrue(server.waitForExistence(timeout: 5))
        zuna.screenshot("20-server-drawer")
        XCTAssertTrue(server.isSelected)
        XCTAssertTrue(zuna.element(A11y.Drawer.join).exists)
        XCTAssertTrue(zuna.element(A11y.Drawer.profile).exists, zuna.app.debugDescription)

        // Choosing the server closes the drawer.
        server.tap()
        try waitFor("the drawer to close") { !drawer.exists }

        // A swipe from the left edge opens it, a tap on the content closes it.
        let window = zuna.app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
        XCTAssertTrue(drawer.waitForExistence(timeout: 5))
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        try waitFor("the drawer to close") { !drawer.exists }
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
