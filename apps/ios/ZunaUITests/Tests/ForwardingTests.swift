import XCTest

/// Forwarding messages, and link previews made on the phone. Each test checks
/// what the desktop received.
final class ForwardingTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }
    private var aliceId: String { World.current["alice"].userId }

    private func openAlice() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let row = zuna.element(A11y.ChatList.row("user:\(aliceId)"))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 10))
    }

    /// A conversation's messages as alice's desktop has them, newest last.
    private func aliceMessages(_ alice: Peer, in key: String) throws -> [[String: Any]] {
        let groupId = try XCTUnwrap(try alice.conversation(key)?["groupId"] as? String)
        let page = try alice.call("loadMessages", [groupId]) as? [String: Any]
        return page?["messages"] as? [[String: Any]] ?? []
    }

    private func aliceMessage(_ alice: Peer, containing text: String, in key: String? = nil) throws -> [String: Any]? {
        try aliceMessages(alice, in: key ?? "user:\(bobId)").last { ($0["text"] as? String)?.contains(text) == true }
    }

    private func type(_ text: String) {
        let input = zuna.element(A11y.Composer.input)
        if (input.value(forKey: "hasKeyboardFocus") as? Bool) != true { input.tap() }
        input.typeText(text)
    }

    func testForwardsAMessageToAnotherChatSayingWhoseItWas() throws {
        try openAlice()
        let alice = try Peer("alice")
        let original = try alice.send(to: "user:\(bobId)", ["text": "Pass this on to the group"])
        let message = zuna.element(A11y.Chat.message(original))
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        message.press(forDuration: 1.0)
        let forward = zuna.app.buttons["Forward"]
        XCTAssertTrue(forward.waitForExistence(timeout: 5))
        forward.tap()

        let weekend = zuna.element(A11y.Forward.row("Weekend"))
        XCTAssertTrue(weekend.waitForExistence(timeout: 5))
        zuna.screenshot("110-forward-sheet")
        weekend.tap()
        XCTAssertTrue(zuna.toast(startingWith: "Forwarded to Weekend").waitForExistence(timeout: 15))

        // The desktop sees it in the group, from bob, saying it was alice's.
        let conversations = try alice.call("getConversations") as? [[String: Any]] ?? []
        let groupKey = try XCTUnwrap(conversations.first { $0["title"] as? String == "Weekend" }?["key"] as? String)
        try waitFor("alice to get it in the group", timeout: 20) {
            guard let copy = try self.aliceMessage(alice, containing: "Pass this on", in: groupKey) else { return false }
            return copy["senderId"] as? String == self.bobId && (copy["forwarded"] as? [String: Any])?["userId"] as? String == self.aliceId
        }

        // And so does the phone.
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        let row = zuna.element(A11y.ChatList.row(groupKey))
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let label = zuna.element(A11y.Chat.forwarded)
        XCTAssertTrue(label.waitForExistence(timeout: 10))
        XCTAssertTrue(label.label.contains("Forwarded from alice"), label.label)
        // A forwarded message can't be edited, only forwarded on.
        label.press(forDuration: 1.0)
        XCTAssertTrue(zuna.app.buttons["Forward"].waitForExistence(timeout: 5))
        XCTAssertFalse(zuna.app.buttons["Edit"].exists)
        zuna.screenshot("111-forwarded")
    }

    func testShowsALinksPreviewWhileWritingAndSendsIt() throws {
        try openAlice()
        let alice = try Peer("alice")
        let link = "\(World.current.siteUrl)/harbour"
        type("The harbour \(link)")
        let bar = zuna.element(A11y.Composer.linkPreview)
        XCTAssertTrue(bar.waitForExistence(timeout: 15))
        XCTAssertTrue(bar.staticTexts["The quiet harbour"].waitForExistence(timeout: 15))
        zuna.screenshot("112-link-draft")
        zuna.element(A11y.Composer.send).tap()

        try waitFor("alice to get the link with its preview", timeout: 20) {
            let preview = try self.aliceMessage(alice, containing: "The harbour")?["preview"] as? [String: Any]
            return preview?["title"] as? String == "The quiet harbour" && preview?["image"] != nil
        }
        let sent = try XCTUnwrap(try aliceMessage(alice, containing: "The harbour")?["id"] as? String)
        XCTAssertTrue(zuna.element(A11y.Chat.linkPreview(sent)).waitForExistence(timeout: 10))
        XCTAssertFalse(bar.exists)

        // A preview the desktop sent shows too.
        let fromAlice = try alice.send(to: "user:\(bobId)", [
            "text": "Saw this \(link)",
            "preview": ["url": link, "title": "Found on the desktop", "siteName": "Harbour Guide"],
        ])
        let received = zuna.element(A11y.Chat.linkPreview(fromAlice))
        XCTAssertTrue(received.waitForExistence(timeout: 15))
        XCTAssertTrue(received.label.contains("Found on the desktop"), received.label)
        zuna.screenshot("113-link-previews")

        // Removed before sending, it isn't sent.
        type("Without one \(link)/again")
        XCTAssertTrue(bar.staticTexts["The quiet harbour"].waitForExistence(timeout: 15))
        zuna.element(A11y.Composer.removeLinkPreview).tap()
        try waitFor("the bar to go") { !bar.exists }
        zuna.element(A11y.Composer.send).tap()
        try waitFor("alice to get it", timeout: 20) { try self.aliceMessage(alice, containing: "Without one") != nil }
        XCTAssertNil(try aliceMessage(alice, containing: "Without one")?["preview"] as? [String: Any])
    }

    /// Settings, then Privacy, unless the Settings tab is still showing it.
    private func openPrivacy() {
        zuna.tab("Settings").tap()
        let toggle = zuna.app.switches[A11y.Settings.linkPreviews]
        if toggle.waitForExistence(timeout: 2) { return }
        let row = zuna.element(A11y.Settings.privacy)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
    }

    func testLinkPreviewsCanBeTurnedOff() throws {
        try XCTSkipIf(zuna.isPad, "for iPhones: it goes to Settings through the tab bar")
        try openAlice()
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        openPrivacy()
        let toggle = zuna.app.switches[A11y.Settings.linkPreviews]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        zuna.screenshot("114-link-preview-setting")
        zuna.toggle(A11y.Settings.linkPreviews)
        try waitFor("previews to be off") { toggle.value as? String == "0" }

        zuna.tab("Chats").tap()
        let row = zuna.element(A11y.ChatList.row("user:\(aliceId)"))
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        type("No preview \(World.current.siteUrl)/harbour")
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertFalse(zuna.element(A11y.Composer.linkPreview).exists)

        // On again, for the other tests.
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        openPrivacy()
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        zuna.toggle(A11y.Settings.linkPreviews)
        try waitFor("previews to be on") { toggle.value as? String == "1" }
    }
}
