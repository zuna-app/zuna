import UIKit
import XCTest

/// Reading a chat: messages from a desktop client with markup, emotes, replies,
/// pictures and reactions; read receipts both ways; history and jumps.
final class ChatReadingTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }
    private var aliceKey: String { "user:\(World.current["alice"].userId)" }

    private func openChat(_ key: String) {
        let row = zuna.element(A11y.ChatList.row(key))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Chat.screen).waitForExistence(timeout: 10))
    }

    private func message(_ id: String) -> XCUIElement {
        zuna.element(A11y.Chat.message(id))
    }

    private func text(_ id: String) -> XCUIElement {
        zuna.element(A11y.Chat.text(id))
    }

    func testShowsMarkupEmotesRepliesAndMarksAsRead() throws {
        let alice = try Peer("alice")
        let tag = UUID().uuidString.prefix(4)
        let welcome = try alice.send(to: "user:\(bobId)", ["text": "Hi Bob \(tag)"])
        let styled = try alice.send(to: "user:\(bobId)", ["text": "**Bold**, _italic_, ~~gone~~, `code` and https://example.com"])
        let emotes = try alice.sendWithEmotes(to: "user:\(bobId)", "zunaDance zunaRing hi @bob", mentions: [bobId])
        let jumbo = try alice.sendWithEmotes(to: "user:\(bobId)", "zunaHappy")
        let code = try alice.send(to: "user:\(bobId)", ["text": "```ts\nconst answer: number = 42;\n```"])
        let reply = try alice.send(to: "user:\(bobId)", ["text": "And a ||secret||", "replyTo": welcome])

        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        openChat(aliceKey)

        // The chat opens at the first unread message, which other tests may have left above these.
        let toBottom = zuna.element(A11y.Chat.toBottom)
        try waitFor("the newest message", timeout: 20) {
            if self.message(reply).exists { return true }
            if toBottom.exists { toBottom.tap() }
            return false
        }
        XCTAssertTrue(text(styled).label.hasPrefix("Bold, italic, gone, code and https://example.com"), text(styled).label)
        XCTAssertTrue(text(emotes).label.contains("hi @bob"), text(emotes).label)
        XCTAssertTrue(message(jumbo).exists)
        XCTAssertTrue(message(code).staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "const answer")).firstMatch.exists)
        let quote = message(reply).buttons[A11y.Chat.reply]
        XCTAssertTrue(quote.label.contains("Hi Bob \(tag)"), "the reply quotes the original: \(quote.label)")
        zuna.screenshot("60-chat-markup-emotes")

        // A tap on an emote shows its card.
        text(emotes).coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5)).tap()
        let card = zuna.element(A11y.Chat.emoteCard)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertTrue(card.label.contains("zunaDance"), card.label)
        zuna.screenshot("67-emote-card")
        // A tap above the card closes it.
        zuna.app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        try waitFor("the card to close") { !card.exists }

        // A tap on the quote shows the original.
        quote.tap()
        XCTAssertTrue(message(welcome).waitForExistence(timeout: 5))

        // Bob is at the newest message, so the desktop sees it read.
        try waitFor("alice to see bob's read receipt") {
            let readBy = try alice.conversation("user:\(self.bobId)")?["readBy"] as? [String: Int]
            return (readBy?[self.bobId] ?? 0) > 0
        }
    }

    func testOwnMessagesShowSentAndThenRead() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let text = "Read me \(UUID().uuidString.prefix(4))"
        try zuna.send(to: aliceKey, text)
        openChat(aliceKey)

        let mine = zuna.app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", A11y.Chat.text(""), text)).firstMatch
        XCTAssertTrue(mine.waitForExistence(timeout: 20))
        let id = String(mine.identifier.dropFirst(A11y.Chat.text("").count))
        let meta = zuna.element(A11y.Chat.meta(id))
        try waitFor("the sent tick") { meta.label.contains("Sent") }

        // Alice reads it on the desktop: two ticks.
        let alice = try Peer("alice")
        let conversation = try XCTUnwrap(try alice.conversation("user:\(bobId)"))
        let groupId = try XCTUnwrap(conversation["groupId"] as? String)
        let last = try XCTUnwrap((conversation["lastMessage"] as? [String: Any])?["seq"] as? Int)
        try alice.call("markRead", [groupId, last])
        try waitFor("the read ticks") { meta.label.contains("Read") }
        zuna.screenshot("61-chat-read-ticks")
    }

    func testOpensAPictureFromTheDesktop() throws {
        let alice = try Peer("alice")
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 240, height: 160))
        let png = renderer.pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 240, height: 160))
            UIColor.white.setFill()
            context.fill(CGRect(x: 80, y: 40, width: 80, height: 80))
        }
        let name = "square-\(UUID().uuidString.prefix(4)).png"
        try alice.sendImage(to: "user:\(bobId)", png: png, name: name, width: 240, height: 160, text: "")

        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        openChat(aliceKey)
        let tile = zuna.element(A11y.Chat.attachment(name))
        XCTAssertTrue(tile.waitForExistence(timeout: 30))
        zuna.screenshot("62-chat-picture")

        // It opens decrypted on the whole screen, and a drag down closes it, as in Telegram.
        try waitFor("the picture to load") { tile.value as? String == "Loaded" }
        tile.tap()
        let viewer = zuna.element(A11y.Chat.photoViewer)
        XCTAssertTrue(viewer.waitForExistence(timeout: 10))
        XCTAssertTrue(zuna.app.buttons["Share"].exists)
        zuna.screenshot("63-picture-preview")
        let start = viewer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: viewer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
        try waitFor("the viewer to close") { !viewer.exists }
    }

    func testShowsReactionsAndTogglesThemBothWays() throws {
        let alice = try Peer("alice")
        let id = try alice.send(to: "user:\(bobId)", ["text": "React to this \(UUID().uuidString.prefix(4))"])
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        openChat(aliceKey)
        XCTAssertTrue(message(id).waitForExistence(timeout: 20))

        let conversation = try XCTUnwrap(try alice.conversation("user:\(bobId)"))
        let groupId = try XCTUnwrap(conversation["groupId"] as? String)
        try alice.call("toggleReaction", [groupId, id, "👍"])
        let chip = message(id).descendants(matching: .any)[A11y.Chat.reaction("👍")]
        XCTAssertTrue(chip.waitForExistence(timeout: 20))
        XCTAssertFalse(chip.isSelected)

        chip.tap()
        try waitFor("bob's reaction") { chip.isSelected }
        try waitFor("alice to see both") {
            let page = try alice.call("loadMessages", [groupId]) as? [String: Any]
            let messages = page?["messages"] as? [[String: Any]] ?? []
            let reactions = messages.first { $0["id"] as? String == id }?["reactions"] as? [[String: Any]] ?? []
            return (reactions.first?["userIds"] as? [String])?.count == 2
        }
        zuna.screenshot("64-reactions")
    }

    func testLoadsOlderMessagesAndReturnsToTheNewest() throws {
        let carol = try Peer("carol")
        let tag = UUID().uuidString.prefix(4)
        let first = try carol.send(to: "user:\(bobId)", ["text": "History \(tag) 1"])
        for index in 2...130 {
            try carol.send(to: "user:\(bobId)", ["text": "History \(tag) \(index)"])
        }
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let carolKey = "user:\(World.current["carol"].userId)"
        try waitFor("all of carol's messages", timeout: 60) {
            (try carol.conversation("user:\(self.bobId)")?["lastMessage"] as? [String: Any])?["text"] as? String == "History \(tag) 130"
        }

        // Bob's laptop reads all but the last 20, and the phone opens at the first of
        // those, under a line, as Telegram does.
        let laptop = try Peer("bobLaptop")
        var groupId = ""
        try waitFor("the laptop to have carol's messages", timeout: 60) {
            let chat = try laptop.conversation(carolKey)
            groupId = chat?["groupId"] as? String ?? ""
            return (chat?["lastMessage"] as? [String: Any])?["text"] as? String == "History \(tag) 130"
        }
        let page = try laptop.call("loadMessages", [groupId]) as? [String: Any]
        let loaded = page?["messages"] as? [[String: Any]] ?? []
        let readUpTo = loaded.first { $0["text"] as? String == "History \(tag) 110" }?["seq"] as? Int ?? 0
        let firstUnread = loaded.first { $0["text"] as? String == "History \(tag) 111" }?["id"] as? String ?? ""
        try laptop.call("markRead", [groupId, readUpTo])
        let row = zuna.element(A11y.ChatList.row(carolKey))
        try waitFor("the phone to have the laptop's place", timeout: 30) { row.label.contains("20 unread") }
        openChat(carolKey)
        XCTAssertTrue(zuna.element(A11y.Chat.unreadLine).waitForExistence(timeout: 30))
        XCTAssertTrue(message(firstUnread).isHittable)
        zuna.screenshot("64-unread")

        // The way down reads the rest.
        let toBottom = zuna.element(A11y.Chat.toBottom)
        XCTAssertTrue(toBottom.waitForExistence(timeout: 5))
        toBottom.tap()
        let newest = zuna.app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", A11y.Chat.text(""), "History \(tag) 130")).firstMatch
        try waitFor("the newest message") { newest.isHittable }
        try waitFor("the laptop to see it all read", timeout: 20) {
            try laptop.conversation(carolKey)?["unread"] as? Int == 0
        }

        // Scrolling up loads the older pages, back to the first message.
        let list = zuna.element(A11y.Chat.list)
        try waitFor("the first message", timeout: 60) {
            list.swipeDown(velocity: .fast)
            return self.message(first).exists
        }
        XCTAssertTrue(toBottom.waitForExistence(timeout: 5))
        zuna.screenshot("65-history")

        // Leaving and coming back keeps the place.
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        openChat(carolKey)
        XCTAssertTrue(message(first).waitForExistence(timeout: 10))
        XCTAssertTrue(toBottom.waitForExistence(timeout: 5))
        toBottom.tap()
        try waitFor("the newest message again") { newest.isHittable }
    }

    func testGoesToUnreadMentionsOneByOne() throws {
        let alice = try Peer("alice")
        let tag = UUID().uuidString.prefix(4)
        let conversations = try alice.call("getConversations") as? [[String: Any]] ?? []
        let weekend = try XCTUnwrap(conversations.first { $0["title"] as? String == "Weekend" }?["groupId"] as? String)
        var mentions: [String] = []
        for index in 1...60 {
            if index % 20 == 0 {
                mentions.append(try alice.send(to: "group:\(weekend)", ["text": "Mention \(tag) \(index) @bob", "mentions": [bobId]]))
            } else {
                try alice.send(to: "group:\(weekend)", ["text": "Plain \(tag) \(index)"])
            }
        }
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let row = zuna.element(A11y.ChatList.row("group:\(weekend)"))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        try waitFor("all of alice's messages", timeout: 60) { row.label.contains("Mention \(tag) 60") }
        openChat("group:\(weekend)")

        // It opens at the first unread message, and "@" counts the mentions not on screen yet.
        XCTAssertTrue(zuna.element(A11y.Chat.unreadLine).waitForExistence(timeout: 30))
        let toMention = zuna.element(A11y.Chat.toMention)
        XCTAssertTrue(toMention.waitForExistence(timeout: 10))
        XCTAssertTrue(toMention.label.hasSuffix("3 left"), toMention.label)
        zuna.screenshot("68-mentions")

        // It goes to the oldest, and the rest are counted.
        toMention.tap()
        try waitFor("the oldest mention") { self.message(mentions[0]).isHittable }
        try waitFor("two left") { toMention.label.hasSuffix("2 left") }

        // At the newest message everything is read, and it goes.
        zuna.element(A11y.Chat.toBottom).tap()
        try waitFor("the button to go") { !toMention.exists }
    }

    func testOpensASearchHitAtTheMessage() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let search = try zuna.pulledDownSearch(A11y.ChatList.search)
        search.tap()
        search.typeText("hike")
        let hit = zuna.app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", A11y.ChatList.messageHit(""))).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 20))
        let id = String(hit.identifier.dropFirst(A11y.ChatList.messageHit("").count))
        hit.tap()
        XCTAssertTrue(zuna.element(A11y.Chat.screen).waitForExistence(timeout: 10))
        XCTAssertTrue(message(id).waitForExistence(timeout: 10))
        XCTAssertTrue(message(id).isHittable)
        zuna.screenshot("66-search-hit")
    }
}
