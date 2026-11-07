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

        // On a tab of their own, under their headings, joined by this device by itself.
        zuna.tab("Channels").tap()
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
        zuna.screenshot("90-channels-tab")

        // The chats leave them out, unless a search names one.
        zuna.tab("Chats").tap()
        let aliceRow = zuna.element(A11y.ChatList.row("user:\(World.current["alice"].userId)"))
        try waitFor("the chats without channels") { aliceRow.exists && !row.exists }
        let search = try zuna.pulledDownSearch(A11y.ChatList.search)
        search.tap()
        search.typeText("general")
        try waitFor("the channel found by its name") { row.exists && !aliceRow.exists }
        zuna.app.buttons["Cancel"].tap()
        try waitFor("the search to close") { aliceRow.exists }
        zuna.tab("Channels").tap()

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
        // Last: the peers aren't using Zuna, so they show as offline, below bob.
        XCTAssertTrue(scrolledTo(A11y.Channels.member(World.current["carol"].userId)).waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.element(A11y.Channels.member(World.current["alice"].userId)).label.contains("Owner"))
        // Not an admin, so nothing to edit.
        XCTAssertFalse(zuna.element(A11y.Channels.edit).exists)
        zuna.screenshot("92-channel-details")
    }

    func testEditsWhereTheMessageIsAndJumpsToThePresent() throws {
        let alice = try Peer("alice")
        let carol = try Peer("carol")
        let general = try channelId(alice, "general")
        let tag = UUID().uuidString.prefix(4)
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(general))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        try waitFor("the phone to come into #general", timeout: 30) {
            (try self.appChannel(general)?["conversation"] as? [String: Any])?["ready"] as? Bool == true
        }
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 10))

        // Edited where it is, as on the desktop, with the draft left in the box.
        type("Meet at noon \(tag)")
        zuna.element(A11y.Composer.send).tap()
        var mine = ""
        try waitFor("carol to get it") {
            mine = try self.messages(carol, in: general).last { $0["text"] as? String == "Meet at noon \(tag)" }?["id"] as? String ?? ""
            return !mine.isEmpty
        }
        type("A draft \(tag)")
        try menu(mine, "Edit")
        let editor = zuna.element(A11y.Channels.inPlaceInput)
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, "Meet at noon \(tag)")
        try waitFor("the editor to take the keyboard") { (editor.value(forKey: "hasKeyboardFocus") as? Bool) == true }
        editor.typeText(", or one")
        zuna.screenshot("91b-channel-edit-in-place")
        zuna.element(A11y.Channels.inPlaceSave).tap()
        try waitFor("carol to see it edited") {
            try self.messages(carol, in: general).contains { $0["id"] as? String == mine && $0["text"] as? String == "Meet at noon \(tag), or one" }
        }
        try waitFor("the editor to go") { !editor.exists }
        XCTAssertTrue(zuna.element(A11y.Chat.text(mine)).label.contains("or one"))
        XCTAssertEqual(zuna.element(A11y.Composer.input).value as? String, "A draft \(tag)")

        // Cancelled, it stays as it was.
        try menu(mine, "Edit")
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        try waitFor("the editor to take the keyboard") { (editor.value(forKey: "hasKeyboardFocus") as? Bool) == true }
        editor.typeText(" maybe")
        zuna.element(A11y.Channels.inPlaceCancel).tap()
        try waitFor("the editor to go") { !editor.exists }
        XCTAssertFalse(zuna.element(A11y.Chat.text(mine)).label.contains("maybe"))

        // Further up, a bar along the bottom leads back, as in Discord, rather than the round button.
        // From alice, so carol's next message in another test starts a run of its own, under her name.
        for index in 1...40 {
            try alice.send(to: "group:\(general)", ["text": "Backlog \(tag) \(index)"])
        }
        let fortieth = zuna.app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", A11y.Chat.text(""), "Backlog \(tag) 40")).firstMatch
        try waitFor("alice's messages", timeout: 30) { fortieth.exists }
        let bar = zuna.element(A11y.Channels.jumpToPresent)
        try waitFor("the bar", timeout: 15) {
            if !bar.exists { self.zuna.element(A11y.Chat.list).swipeDown(velocity: .fast) }
            return bar.waitForExistence(timeout: 2)
        }
        XCTAssertTrue(bar.label.contains("You're viewing older messages"))
        XCTAssertFalse(zuna.element(A11y.Chat.toBottom).exists)

        // What arrives meanwhile is counted on it, with when it started.
        for index in 41...43 {
            try alice.send(to: "group:\(general)", ["text": "Backlog \(tag) \(index)"])
        }
        try waitFor("the new ones on the bar", timeout: 20) { bar.label.contains("3 new messages since") }
        zuna.screenshot("91c-channel-jump-to-present")
        bar.tap()
        try waitFor("the bar to go") { !bar.exists }
        let newest = zuna.app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", A11y.Chat.text(""), "Backlog \(tag) 43")).firstMatch
        try waitFor("the newest message") { newest.isHittable }
        try waitFor("the channel read") {
            (try self.appChannel(general)?["conversation"] as? [String: Any])?["unread"] as? Int == 0
        }
    }

    func testAdminsMakeChangeAndDeleteChannels() throws {
        let carol = try Peer("carol")
        try zuna.launch()
        try zuna.signIn(as: "alice")
        try zuna.waitForChats()
        zuna.tab("Channels").tap()
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
        // Slow mode, off until it's turned on, at a time chosen from the desktop's.
        let slowMode = zuna.app.switches[A11y.Channels.editorSlowMode]
        XCTAssertEqual(slowMode.value as? String, "0")
        slowMode.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        choose("10 seconds", in: A11y.Channels.editorSlowModeTime)
        zuna.element(A11y.Channels.editorSave).tap()
        try waitFor("carol to see the new topic and slow mode", timeout: 20) {
            let channel = try self.channels(carol).first { $0["id"] as? String == made }
            return channel?["topic"] as? String == "Who drives, and where we stop" && channel?["slowMode"] as? Int == 10
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

    func testHoldsBackTheNextMessageInSlowMode() throws {
        let alice = try Peer("alice")
        let made = try XCTUnwrap(try alice.call("createChannel", [["type": "text", "name": "slow-lane"]]) as? String)
        defer { _ = try? alice.call("deleteChannel", [made]) }
        _ = try alice.call("updateChannel", [made, ["slowMode": 5]])
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        zuna.tab("Channels").tap()
        let row = zuna.element(A11y.Channels.row(made))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        try waitFor("the phone to come into it", timeout: 30) {
            (try self.appChannel(made)?["conversation"] as? [String: Any])?["ready"] as? Bool == true
        }
        row.tap()

        // The box says so, and once a message goes, the next waits, with the time where the send button was.
        XCTAssertEqual(zuna.element(A11y.Composer.input).placeholderValue, "Slow mode: 5 seconds")
        type("First, at once")
        zuna.element(A11y.Composer.send).tap()
        let wait = zuna.element(A11y.Composer.slowWait)
        XCTAssertTrue(wait.waitForExistence(timeout: 2))
        type("Second, after the wait")
        XCTAssertFalse(zuna.element(A11y.Composer.send).exists)
        zuna.screenshot("94b-slow-mode")
        try waitFor("alice to get the first") { try self.messages(alice, in: made).contains { $0["text"] as? String == "First, at once" } }

        // Once it's over, the send button is back, and the second goes.
        let send = zuna.element(A11y.Composer.send)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        XCTAssertFalse(wait.exists)
        send.tap()
        try waitFor("alice to get the second") { try self.messages(alice, in: made).contains { $0["text"] as? String == "Second, after the wait" } }
    }

    /// A row further down, scrolled to, as a form or list only draws the rows in sight:
    /// the editor's voice section is below slow mode's, and the details' members are last.
    private func scrolledTo(_ identifier: String) -> XCUIElement {
        let element = zuna.element(identifier)
        for _ in 0..<6 where !(element.exists && element.isHittable) { zuna.app.swipeUp(velocity: .slow) }
        return element
    }

    /// Picks an option from one of the editor's menus.
    private func choose(_ option: String, in picker: String) {
        scrolledTo(picker).tap()
        let button = zuna.app.buttons[option]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "no \(option)")
        button.tap()
    }

    func testAdminsSetAVoiceChannelsSoundSizeAndSharing() throws {
        let carol = try Peer("carol")
        try zuna.launch()
        try zuna.signIn(as: "alice")
        try zuna.waitForChats()
        zuna.tab("Channels").tap()
        let add = zuna.element(A11y.Channels.add("Voice channels"))
        XCTAssertTrue(add.waitForExistence(timeout: 30))

        // Made with the best sound, room for a few, and one screen at a time.
        add.tap()
        XCTAssertTrue(zuna.element(A11y.Channels.editor).waitForExistence(timeout: 5))
        zuna.type("Studio", into: A11y.Channels.editorName)
        choose("Best (256 kbit/s)", in: A11y.Channels.editorBitrate)
        // The last menu brings the slider up from under the keyboard.
        choose("One at a time", in: A11y.Channels.editorScreenLimit)
        zuna.element(A11y.Channels.editorUserLimit).adjust(toNormalizedSliderPosition: 0.3)
        zuna.screenshot("93b-new-voice-channel")
        zuna.element(A11y.Channels.editorSave).tap()
        var made = ""
        try waitFor("carol to see it with its sound, size and sharing", timeout: 30) {
            guard let channel = try self.channels(carol).first(where: { $0["name"] as? String == "Studio" }) else { return false }
            made = channel["id"] as? String ?? ""
            return channel["bitrate"] as? Int == 256 && (channel["userLimit"] as? Int ?? 0) > 0 && channel["screenLimit"] as? Int == 1
        }

        // Changed from its row: the usual sound, no limit, and no sharing there.
        let row = zuna.element(A11y.Channels.row(made))
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1.0)
        let edit = zuna.app.buttons["Edit channel"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        XCTAssertTrue(zuna.element(A11y.Channels.editor).waitForExistence(timeout: 5))
        choose("Usual (64 kbit/s)", in: A11y.Channels.editorBitrate)
        choose("Off in this channel", in: A11y.Channels.editorScreenLimit)
        zuna.element(A11y.Channels.editorUserLimit).adjust(toNormalizedSliderPosition: 0)
        zuna.element(A11y.Channels.editorSave).tap()
        try waitFor("carol to see it changed", timeout: 30) {
            guard let channel = try self.channels(carol).first(where: { $0["id"] as? String == made }) else { return false }
            return (channel["bitrate"] as? Int ?? 0) == 0 && channel["userLimit"] as? Int == 0 && channel["screenLimit"] as? Int == -1
        }

        // Deleted, so the other tests find the server as it was.
        row.press(forDuration: 1.0)
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        scrolledTo(A11y.Channels.delete).tap()
        let confirm = zuna.app.sheets.buttons["Delete channel"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        try waitFor("carol to lose it", timeout: 20) { try !self.channels(carol).contains { $0["id"] as? String == made } }
    }
}
