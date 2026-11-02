import XCTest

/// Text channels: listed above the chats under headings, as on the desktop, laid
/// out as Discord's, read and written in, with what's said to you counted; and
/// made, changed and deleted by the server's admins. Each test checks what the
/// desktop received.
final class ChannelsTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }

    private func channels(_ peer: Peer) throws -> [[String: Any]] {
        try peer.call("getChannels") as? [[String: Any]] ?? []
    }

    private func channelId(_ peer: Peer, _ name: String) throws -> String {
        try XCTUnwrap(try channels(peer).first { $0["name"] as? String == name }?["id"] as? String, "no #\(name)")
    }

    /// A peer's copy of a channel, newest last.
    private func messages(_ peer: Peer, in channelId: String) throws -> [[String: Any]] {
        let page = try peer.call("loadMessages", [channelId]) as? [String: Any]
        return page?["messages"] as? [[String: Any]] ?? []
    }

    /// The app's own copy of a channel, as its core has it.
    private func appChannel(_ id: String) throws -> [String: Any]? {
        let control = zuna.control!, serverId = zuna.serverId
        let data = try blocking {
            let list = try await control.call("getChannels", server: serverId)
            return try JSONSerialization.data(withJSONObject: list)
        }
        return (try JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first { $0["id"] as? String == id }
    }

    /// An item of a message's menu. The list may still be moving to the newest message, which takes the press.
    private func menu(_ id: String, _ item: String) throws {
        let button = zuna.app.buttons[item]
        try waitFor("\(item) in the message's menu", timeout: 15) {
            if !button.exists { self.zuna.element(A11y.Chat.message(id)).press(forDuration: 1.0) }
            return button.waitForExistence(timeout: 2)
        }
        button.tap()
    }

    private func type(_ text: String) {
        let input = zuna.element(A11y.Composer.input)
        if (input.value(forKey: "hasKeyboardFocus") as? Bool) != true { input.tap() }
        input.typeText(text)
    }

    func testReadsAndWritesInAChannelLaidOutAsDiscords() throws {
        let alice = try Peer("alice")
        let carol = try Peer("carol")
        let general = try channelId(alice, "general")
        let lounge = try channelId(alice, "Lounge")
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()

        // Above the chats, under their headings, joined by this device by itself.
        let row = zuna.element(A11y.Channels.row(general))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        XCTAssertTrue(zuna.element(A11y.Channels.heading("Text channels")).exists)
        XCTAssertTrue(zuna.element(A11y.Channels.row(lounge)).exists)
        try waitFor("the phone to come into #general", timeout: 30) {
            (try self.appChannel(general)?["conversation"] as? [String: Any])?["ready"] as? Bool == true
        }

        // Something said to bob is counted on the row; the rest only marks it.
        try carol.send(to: "group:\(general)", ["text": "@bob are you around this weekend?", "mentions": [bobId]])
        try waitFor("the mention on the row") { row.label.contains("1 mentioning you") }
        zuna.screenshot("90-channels-in-the-list")

        // The Channels filter shows only them.
        zuna.element(A11y.ChatList.filter).buttons["Channels"].tap()
        let aliceRow = zuna.element(A11y.ChatList.row("user:\(World.current["alice"].userId)"))
        try waitFor("only channels") { row.exists && !aliceRow.exists }
        zuna.element(A11y.ChatList.filter).buttons["All"].tap()

        // Opened: its name and topic in the bar, the messages under names, and the new ones under a red line.
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Chat.title).waitForExistence(timeout: 10))
        XCTAssertTrue(zuna.element(A11y.Chat.title).label.contains("general"))
        XCTAssertEqual(zuna.element(A11y.Chat.status).label, "Anything goes")
        let mention = try XCTUnwrap(try messages(alice, in: general).last { ($0["text"] as? String)?.contains("are you around") == true }?["id"] as? String)
        XCTAssertTrue(zuna.element(A11y.Chat.message(mention)).waitForExistence(timeout: 10))
        XCTAssertTrue(zuna.element(A11y.Chat.unreadLine).exists)
        XCTAssertTrue(zuna.element(A11y.Chat.meta(mention)).label.contains("carol"))
        XCTAssertTrue(zuna.element(A11y.Chat.meta(mention)).label.contains("Today at"))
        // Read on the way in, so the count goes.
        try waitFor("the mention to be read") {
            (try self.appChannel(general)?["conversation"] as? [String: Any])?["unreadMentions"] as? Int == 0
        }

        // Written from the box, which says where it goes, and read on the desktop.
        XCTAssertEqual(zuna.element(A11y.Composer.input).placeholderValue, "Message #general")
        type("Yes, count me in from the phone")
        zuna.element(A11y.Composer.send).tap()
        try waitFor("alice to read it") { try self.messages(alice, in: general).contains { $0["text"] as? String == "Yes, count me in from the phone" } }

        // A reply from the message's menu goes above the answer, joined to it.
        try menu(mention, "Reply")
        type("Saturday works")
        zuna.element(A11y.Composer.send).tap()
        try waitFor("carol to get the reply") {
            try self.messages(carol, in: general).contains { $0["text"] as? String == "Saturday works" && ($0["reply"] as? [String: Any])?["id"] as? String == mention }
        }
        let answer = try XCTUnwrap(try messages(alice, in: general).last { $0["text"] as? String == "Saturday works" }?["id"] as? String)
        try waitFor("the reply above it") { self.zuna.element(A11y.Chat.message(answer)).descendants(matching: .any)[A11y.Chat.reply].exists }

        // Who's typing shows above the box.
        try carol.call("sendTyping", [general])
        XCTAssertTrue(zuna.element(A11y.Channels.typing).waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.element(A11y.Channels.typing).label.contains("carol is typing"))
        zuna.screenshot("91-channel-chat")

        // Its details list everyone on the server, as the desktop's member list does.
        zuna.element(A11y.Chat.title).tap()
        XCTAssertTrue(zuna.element(A11y.Channels.details).waitForExistence(timeout: 10))
        XCTAssertTrue(zuna.element(A11y.Channels.member(World.current["carol"].userId)).waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.element(A11y.Channels.member(World.current["alice"].userId)).label.contains("Owner"))
        // Not an admin, so nothing to edit.
        XCTAssertFalse(zuna.element(A11y.Channels.edit).exists)
        zuna.screenshot("92-channel-details")
    }

    func testAdminsMakeChangeAndDeleteChannels() throws {
        let carol = try Peer("carol")
        try zuna.launch()
        try zuna.signIn(as: "alice")
        try zuna.waitForChats()
        XCTAssertTrue(zuna.element(A11y.Channels.heading("Text channels")).waitForExistence(timeout: 30))

        // Made under a heading, with a name the way text channels are written.
        zuna.element(A11y.Channels.add("Text channels")).tap()
        XCTAssertTrue(zuna.element(A11y.Channels.editor).waitForExistence(timeout: 5))
        zuna.type("Road Trip", into: A11y.Channels.editorName)
        XCTAssertEqual(zuna.element(A11y.Channels.editorFinalName).label, "It'll be #road-trip")
        zuna.type("Plans for the summer", into: A11y.Channels.editorTopic)
        zuna.screenshot("93-new-channel")
        zuna.element(A11y.Channels.editorSave).tap()

        // It opens, at its welcome, and everyone's apps come into it by themselves.
        XCTAssertTrue(zuna.element(A11y.Channels.welcome).waitForExistence(timeout: 15))
        XCTAssertTrue(zuna.app.staticTexts["Welcome to #road-trip!"].exists)
        var made = ""
        try waitFor("carol to see it", timeout: 30) {
            made = try self.channelId(carol, "road-trip")
            return true
        }
        try waitFor("carol to come into it", timeout: 30) {
            let channel = try self.channels(carol).first { $0["id"] as? String == made }
            return (channel?["conversation"] as? [String: Any])?["ready"] as? Bool == true
        }
        zuna.screenshot("94-channel-welcome")

        // Changed from its welcome.
        zuna.element(A11y.Channels.welcomeEdit).tap()
        XCTAssertTrue(zuna.element(A11y.Channels.editor).waitForExistence(timeout: 5))
        // At the end of what's there, which a tap in the middle of the field doesn't always put the cursor at.
        let topic = zuna.element(A11y.Channels.editorTopic)
        topic.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        topic.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 30) + "Who drives, and where we stop")
        zuna.element(A11y.Channels.editorSave).tap()
        try waitFor("carol to see the new topic", timeout: 20) {
            try self.channels(carol).first { $0["id"] as? String == made }?["topic"] as? String == "Who drives, and where we stop"
        }
        XCTAssertEqual(zuna.element(A11y.Chat.status).label, "Who drives, and where we stop")

        // Deleted from its details, for everyone.
        zuna.element(A11y.Chat.title).tap()
        let delete = zuna.element(A11y.Channels.delete)
        XCTAssertTrue(delete.waitForExistence(timeout: 10))
        delete.tap()
        let confirm = zuna.app.sheets.buttons["Delete channel"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        try waitFor("carol to lose it", timeout: 20) { try !self.channels(carol).contains { $0["id"] as? String == made } }
        try waitFor("back at the list") { self.zuna.element(A11y.Channels.heading("Text channels")).exists }
        XCTAssertFalse(zuna.element(A11y.Channels.row(made)).exists)
    }
}
