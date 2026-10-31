import XCTest

/// The conversation list's filters, search and row actions, the connection
/// state, and what the server and the core report: sign-outs and security alerts.
final class ConversationListTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var rows: XCUIElementQuery {
        zuna.app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", A11y.ChatList.row("")))
    }

    private func row(_ key: String) -> XCUIElement {
        zuna.element(A11y.ChatList.row(key))
    }

    func testFiltersAndSearchesPeopleGroupsAndMessages() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let alice = row("user:\(World.current["alice"].userId)")
        let carol = row("user:\(World.current["carol"].userId)")
        XCTAssertTrue(alice.waitForExistence(timeout: 20))

        let filters = zuna.element(A11y.ChatList.filter)
        filters.buttons["Groups"].tap()
        try waitFor("only the group") { self.rows.count == 1 && self.rows.firstMatch.label.contains("Weekend") }
        // Other tests may leave more unread, but notes to yourself never are.
        filters.buttons["All"].tap()
        let saved = row("user:\(World.current["bob"].userId)")
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        filters.buttons["Unread"].tap()
        try waitFor("the unread ones") { self.rows.count > 0 && !saved.exists }
        zuna.screenshot("50-filter-unread")
        filters.buttons["People"].tap()
        try waitFor("people only") { carol.exists && !self.rows.firstMatch.label.contains("Weekend") }
        filters.buttons["All"].tap()

        // People by name, and messages in the index on this device.
        let search = zuna.app.searchFields.firstMatch
        search.tap()
        search.typeText("car")
        try waitFor("carol alone") { carol.exists && !alice.exists }
        search.typeText(XCUIKeyboardKey.delete.rawValue + XCUIKeyboardKey.delete.rawValue + XCUIKeyboardKey.delete.rawValue + "hike")
        let hits = zuna.app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", A11y.ChatList.messageHit("")))
        try waitFor("the message about the hike") { hits.firstMatch.exists && hits.firstMatch.label.contains("Who's up for a hike on Saturday?") }
        XCTAssertTrue(hits.firstMatch.label.contains("Weekend"))
        zuna.screenshot("51-search-messages")
    }

    func testPinsMutesAndHidesConversations() throws {
        // A new account, so the other tests keep bob's list as it was.
        try zuna.launch()
        _ = try zuna.register("gina", password: "correct horse battery staple")
        try zuna.waitForChats()
        let carolKey = "user:\(World.current["carol"].userId)"
        let carol = row(carolKey)
        XCTAssertTrue(carol.waitForExistence(timeout: 20))

        // Pinned from a swipe: it moves to the top, and the core keeps it.
        carol.swipeRight()
        zuna.app.buttons["Pin"].tap()
        try waitFor("carol at the top") { self.rows.firstMatch.identifier == A11y.ChatList.row(carolKey) }
        XCTAssertTrue(carol.label.contains("Pinned"))
        XCTAssertTrue(try zuna.preferences()["pinned"]?.contains(carolKey) ?? false)

        // Muted from the context menu, until it's unmuted.
        carol.press(forDuration: 1)
        zuna.app.buttons["Mute"].tap()
        let forever = zuna.app.buttons["Until I turn it back on"]
        XCTAssertTrue(forever.waitForExistence(timeout: 5))
        forever.tap()
        try waitFor("the muted mark") { carol.label.contains("Muted") }
        zuna.screenshot("52-pinned-and-muted")

        // Hidden from a swipe: it moves under "Hidden (1)", and comes back from there.
        carol.swipeLeft()
        zuna.app.buttons["Hide"].tap()
        let hidden = zuna.element(A11y.ChatList.hiddenToggle)
        XCTAssertTrue(hidden.waitForExistence(timeout: 5))
        XCTAssertTrue(hidden.label.contains("Hidden (1)"))
        XCTAssertFalse(carol.exists)
        hidden.tap()
        XCTAssertTrue(carol.waitForExistence(timeout: 5))
        zuna.screenshot("53-hidden-section")
        carol.press(forDuration: 1)
        zuna.app.buttons["Show in list"].tap()
        try waitFor("the hidden section to go") { !hidden.exists }
        XCTAssertEqual(try zuna.preferences()["hidden"], [])
    }

    func testShowsTheConnectionStateInTheTitle() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let title = zuna.element(A11y.Shell.title)
        var seen = ""
        do {
            try waitFor("the server's name", timeout: 30) {
                seen = title.label
                return seen == World.current.serverName
            }
        } catch {
            XCTFail("The title stayed at \(seen); the core says \(try zuna.connectionState())")
            throw error
        }

        try zuna.setOffline(true)
        try waitFor("a connection state instead") { ["Connecting…", "Waiting for network…"].contains(title.label) }
        zuna.screenshot("54-connecting")
        try zuna.setOffline(false)
        try waitFor("the server's name again", timeout: 30) { title.label == World.current.serverName }
    }

    func testLeavesAServerThatRemovedTheAccount() throws {
        try zuna.launch()
        _ = try zuna.register("hank", password: "correct horse battery staple")
        try zuna.waitForChats()
        let hankId = try zuna.selfId()

        try Peer("alice").call("banUser", [hankId])
        let toast = zuna.element(A11y.Toast.item)
        XCTAssertTrue(toast.waitForExistence(timeout: 20))
        XCTAssertEqual(toast.label, "You were removed from a server by its admins.")
        // It was the only server, so the welcome screens are back.
        XCTAssertTrue(zuna.element(A11y.Onboarding.link).waitForExistence(timeout: 10))
        zuna.screenshot("55-removed-by-admins")
        XCTAssertEqual(try zuna.serverCount(), 0)
    }

    func testWarnsLongerAboutANewDeviceOnTheAccount() throws {
        try zuna.launch()
        _ = try zuna.register("ivan", password: "correct horse battery staple")
        try zuna.waitForChats()

        try WorldControl.newDevice(for: "ivan", password: "correct horse battery staple")
        let toast = zuna.toast(startingWith: "A new device just signed in to your account")
        XCTAssertTrue(toast.waitForExistence(timeout: 30))
        zuna.screenshot("56-new-device-alert")
        // Security alerts stay longer than the 4.5 seconds of other toasts.
        RunLoop.current.run(until: Date().addingTimeInterval(6))
        XCTAssertTrue(toast.exists)
    }
}
