import XCTest

/// Marking a chat as unread, a group that notifies only about mentions, who read
/// a message, and blocking someone. Each checks what bob's laptop or the others
/// see, and undoes what it changed, since the other tests share the account.
final class ChatControlsTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }
    private var aliceId: String { World.current["alice"].userId }

    private func start() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
    }

    private func weekend(_ peer: Peer) throws -> (key: String, groupId: String) {
        let conversations = try peer.call("getConversations") as? [[String: Any]] ?? []
        let group = try XCTUnwrap(conversations.first { $0["title"] as? String == "Weekend" })
        return (try XCTUnwrap(group["key"] as? String), try XCTUnwrap(group["groupId"] as? String))
    }

    private func open(_ key: String) {
        let row = zuna.element(A11y.ChatList.row(key))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 10))
    }

    /// Scrolls until all of an element is on screen, above the home indicator: one
    /// only just showing at the bottom counts as hittable, but a tap there misses it.
    private func scrolledTo(_ element: XCUIElement, _ what: String) throws -> XCUIElement {
        try waitFor("\(what) on screen", timeout: 15) {
            if element.exists && element.isHittable && element.frame.maxY < self.zuna.app.frame.maxY - 50 { return true }
            self.zuna.app.swipeUp(velocity: .slow)
            return false
        }
        return element
    }

    func testMarksAChatUnreadAndReadsItFromTheList() throws {
        try start()
        let laptop = try Peer("bobLaptop")
        let key = "user:\(aliceId)"
        let row = zuna.element(A11y.ChatList.row(key))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.press(forDuration: 1.0)
        // With unread messages the menu reads them; otherwise it marks the chat unread.
        if zuna.app.buttons["Mark as read"].waitForExistence(timeout: 3) {
            zuna.app.buttons["Mark as read"].tap()
            try waitFor("the laptop to see it read") { try laptop.conversation(key)?["unread"] as? Int == 0 }
            row.press(forDuration: 1.0)
        }
        let mark = zuna.app.buttons["Mark as unread"]
        XCTAssertTrue(mark.waitForExistence(timeout: 5))
        mark.tap()
        try waitFor("the laptop to see the mark") { try laptop.conversation(key)?["markedUnread"] as? Bool == true }
        try waitFor("the row to show it") { row.label.contains("Marked as unread") }
        zuna.screenshot("130-marked-unread")
        row.tap()
        try waitFor("opening it to take the mark off everywhere") { try laptop.conversation(key)?["markedUnread"] as? Bool == false }
    }

    func testHasAGroupNotifyOnlyAboutMentions() throws {
        try start()
        let laptop = try Peer("bobLaptop")
        let group = try weekend(laptop)
        open(group.key)
        addTeardownBlock { _ = try? laptop.call("setMentionsOnly", [group.key, false]) }
        zuna.element(A11y.Chat.title).tap()
        let only = try scrolledTo(zuna.app.switches[A11y.Details.mentionsOnly], "Only mentions")
        XCTAssertEqual(only.value as? String, "0")
        only.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("the laptop to see it") { try laptop.conversation(group.key)?["mentionsOnly"] as? Bool == true }
        XCTAssertEqual(try laptop.conversation(group.key)?["muted"] as? Bool, false)
        zuna.screenshot("131-only-mentions")
        only.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("the laptop to see it off") { try laptop.conversation(group.key)?["mentionsOnly"] as? Bool == false }
    }

    func testShowsWhoReadAMessageInAGroup() throws {
        try start()
        let alice = try Peer("alice")
        let group = try weekend(alice)
        open(group.key)
        let text = "Who's driving? \(UUID().uuidString.prefix(4))"
        try zuna.send(to: group.key, text)
        var sent: [String: Any]?
        try waitFor("alice to get it") {
            let page = try alice.call("loadMessages", [group.groupId]) as? [String: Any]
            sent = (page?["messages"] as? [[String: Any]] ?? []).last { $0["text"] as? String == text }
            return sent != nil
        }
        let id = try XCTUnwrap(sent?["id"] as? String)
        let seq = try XCTUnwrap(sent?["seq"] as? Int)
        try alice.call("markRead", [group.groupId, seq])

        let message = zuna.element(A11y.Chat.message(id))
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        let readBy = zuna.app.buttons["Read by 1"]
        // The menu works out who read it as it opens, so it may take a second try.
        try waitFor("alice's read to reach the menu", timeout: 20) {
            message.press(forDuration: 1.0)
            if readBy.waitForExistence(timeout: 2) { return true }
            self.zuna.app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
            return false
        }
        readBy.tap()
        let name = zuna.app.buttons["alice"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        zuna.screenshot("132-read-by")
        name.tap()
        XCTAssertTrue(zuna.element(A11y.Chat.title).waitForExistence(timeout: 10))
        try waitFor("alice's chat to open") { self.zuna.element(A11y.Chat.title).label.contains("alice") }
    }

    func testBlocksSomeoneAndUnblocksThemInPrivacy() throws {
        try start()
        let laptop = try Peer("bobLaptop")
        let carol = try Peer("carol")
        let carolId = World.current["carol"].userId
        let group = try weekend(carol)
        open("user:\(carolId)")

        addTeardownBlock { _ = try? laptop.call("setBlocked", [carolId, false]) }
        zuna.element(A11y.Chat.title).tap()
        try scrolledTo(zuna.app.buttons["Block carol"], "Block").tap()
        try waitFor("the laptop to see the block") {
            let blocked = try laptop.call("getPreferences") as? [String: Any]
            return (blocked?["blocked"] as? [String])?.contains(carolId) == true
        }
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        let notice = zuna.app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "You blocked carol")).firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 10))
        zuna.screenshot("133-blocked-chat")

        // Her messages in a group fold into a line, which shows the message when asked.
        let text = "Still on for Saturday? \(UUID().uuidString.prefix(4))"
        let id = try carol.send(to: group.key, ["text": text])
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertFalse(zuna.element(A11y.ChatList.row("user:\(carolId)")).waitForExistence(timeout: 3))
        open(group.key)
        let folded = zuna.element(A11y.Chat.blockedMessage(id))
        XCTAssertTrue(folded.waitForExistence(timeout: 15))
        zuna.screenshot("134-blocked-message")
        folded.buttons["Show"].tap()
        XCTAssertTrue(zuna.element(A11y.Chat.text(id)).waitForExistence(timeout: 5))
        XCTAssertFalse(zuna.element(A11y.Chat.blockedMessage(id)).exists)

        // The tab bar is hidden while a chat is open.
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        zuna.tab("Settings").tap()
        let privacy = zuna.element(A11y.Settings.privacy)
        XCTAssertTrue(privacy.waitForExistence(timeout: 10))
        privacy.tap()
        let unblock = zuna.app.buttons["Unblock"]
        XCTAssertTrue(unblock.waitForExistence(timeout: 10))
        zuna.screenshot("135-blocked-people")
        unblock.tap()
        try waitFor("the laptop to see the unblock") {
            let prefs = try laptop.call("getPreferences") as? [String: Any]
            return (prefs?["blocked"] as? [String])?.contains(carolId) != true
        }
    }
}
