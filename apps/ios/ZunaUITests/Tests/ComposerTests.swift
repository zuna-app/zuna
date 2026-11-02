import UIKit
import XCTest

/// Writing: the composer with its suggestions, replies, edits, deletes, pins,
/// reactions, search in a chat and files. Each test checks what the desktop received.
final class ComposerTests: XCTestCase {
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

    private func message(_ id: String) -> XCUIElement {
        zuna.element(A11y.Chat.message(id))
    }

    /// Alice's copy of the DM with bob, newest last.
    private func aliceMessages(_ alice: Peer) throws -> [[String: Any]] {
        let groupId = try XCTUnwrap(try alice.conversation("user:\(bobId)")?["groupId"] as? String)
        let page = try alice.call("loadMessages", [groupId]) as? [String: Any]
        return page?["messages"] as? [[String: Any]] ?? []
    }

    private func aliceMessage(_ alice: Peer, containing text: String) throws -> [String: Any]? {
        try aliceMessages(alice).last { ($0["text"] as? String)?.contains(text) == true }
    }

    private func type(_ text: String) {
        let input = zuna.element(A11y.Composer.input)
        if (input.value(forKey: "hasKeyboardFocus") as? Bool) != true { input.tap() }
        input.typeText(text)
    }

    /// An item of a message's menu. After sending, the keyboard can go and come back, moving
    /// the list under a press, so it waits for the message to stay put, and tries again.
    private func menu(_ id: String, _ action: String) {
        let button = zuna.app.buttons[action]
        for _ in 0..<3 where !button.exists {
            var last = CGRect.null
            _ = try? waitFor("the message to stay put", timeout: 5) {
                let frame = self.message(id).frame
                defer { last = frame }
                return frame == last && self.message(id).isHittable
            }
            message(id).press(forDuration: 1.0)
            _ = button.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(button.exists, "no \(action) in the menu")
        button.tap()
    }

    /// An item of the chat's menu, under the avatar. A menu closing just before may swallow the first tap.
    private func chatMenu(_ item: String) throws {
        let button = zuna.app.buttons[item]
        try waitFor("\(item) in the chat's menu", timeout: 10) {
            if !button.exists { self.zuna.element(A11y.Chat.menu).tap() }
            return button.waitForExistence(timeout: 2)
        }
        button.tap()
    }

    func testSendsMarkupEmotesAndMentionsLikeTheDesktop() throws {
        let alice = try Peer("alice")
        try openAlice()
        let tag = String(UUID().uuidString.prefix(4))

        type("**hi \(tag)** @ali")
        let person = zuna.element(A11y.Composer.suggestion("alice"))
        XCTAssertTrue(person.waitForExistence(timeout: 5))
        zuna.screenshot("70-composer-mention")
        person.tap()
        type(":zunaD")
        let emote = zuna.element(A11y.Composer.suggestion("zunaDance"))
        XCTAssertTrue(emote.waitForExistence(timeout: 5))
        emote.tap()
        XCTAssertEqual(zuna.element(A11y.Composer.input).value as? String, "**hi \(tag)** @alice zunaDance ")
        zuna.element(A11y.Composer.send).tap()

        // The desktop gets the same text, emotes and mentions its own composer would send.
        var received: [String: Any]?
        try waitFor("alice to receive it") {
            received = try self.aliceMessage(alice, containing: tag)
            return received != nil
        }
        XCTAssertEqual(received?["text"] as? String, "**hi \(tag)** @alice zunaDance")
        XCTAssertEqual(received?["mentions"] as? [String], [aliceId])
        let emotes = received?["emotes"] as? [String: [String: Any]]
        XCTAssertEqual(emotes?["zunaDance"]?["id"] as? String, "01ZUNATESTANIMATED0000001")
        XCTAssertEqual(emotes?["zunaDance"]?["animated"] as? Bool, true)
        XCTAssertEqual(zuna.element(A11y.Composer.input).value as? String, "Message alice")
    }

    func testRepliesEditsAndDeletes() throws {
        let alice = try Peer("alice")
        let tag = String(UUID().uuidString.prefix(4))
        let question = try alice.send(to: "user:\(bobId)", ["text": "Question \(tag)?"])
        try openAlice()
        XCTAssertTrue(message(question).waitForExistence(timeout: 20))

        // Swiping a message to the left answers it, as in Telegram.
        message(question).swipeLeft()
        XCTAssertTrue(zuna.element(A11y.Composer.context).waitForExistence(timeout: 5))
        type("Answer \(tag)")
        zuna.screenshot("71-composer-reply")
        zuna.element(A11y.Composer.send).tap()
        var answer: [String: Any]?
        try waitFor("alice to receive the reply") {
            answer = try self.aliceMessage(alice, containing: "Answer \(tag)")
            return answer != nil
        }
        XCTAssertEqual((answer?["reply"] as? [String: Any])?["id"] as? String, question)
        let answerId = try XCTUnwrap(answer?["id"] as? String)

        // Edited from the menu: the composer holds the text, and saving updates alice's copy.
        XCTAssertTrue(message(answerId).waitForExistence(timeout: 10))
        menu(answerId, "Edit")
        XCTAssertEqual(zuna.element(A11y.Composer.input).value as? String, "Answer \(tag)")
        type(" (edited)")
        zuna.element(A11y.Composer.send).tap()
        try waitFor("alice to see the edit") {
            let edited = try self.aliceMessage(alice, containing: "Answer \(tag)")
            return edited?["text"] as? String == "Answer \(tag) (edited)" && edited?["editedAt"] is Int
        }

        menu(answerId, "Delete for everyone")
        try waitFor("alice to see it deleted") {
            try self.aliceMessages(alice).first { $0["id"] as? String == answerId }?["deletedAt"] is Int
        }
    }

    func testPinsReactsAndSearchesInAChat() throws {
        let alice = try Peer("alice")
        let tag = String(UUID().uuidString.prefix(4))
        let note = try alice.send(to: "user:\(bobId)", ["text": "Remember the pineapple \(tag)"])
        try openAlice()
        XCTAssertTrue(message(note).waitForExistence(timeout: 20))

        menu(note, "Pin")
        try waitFor("alice to see the pin") {
            try self.aliceMessages(alice).first { $0["id"] as? String == note }?["pinnedAt"] is Int
        }

        menu(note, "👍")
        let chip = message(note).descendants(matching: .any)[A11y.Chat.reaction("👍")]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        try waitFor("alice to see the reaction") {
            let reactions = try self.aliceMessages(alice).first { $0["id"] as? String == note }?["reactions"] as? [[String: Any]]
            return (reactions?.first?["userIds"] as? [String]) == [self.bobId]
        }
        zuna.screenshot("72-pinned-and-reacted")

        // Search in this chat finds it in the index on the phone.
        try chatMenu("Search")
        let field = zuna.app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("pineapple \(tag)")
        let result = zuna.element(A11y.Chat.result(note))
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        result.tap()
        XCTAssertTrue(message(note).waitForExistence(timeout: 10))

        // Unpinned from the screen of pins, opened from the bar as on the desktop.
        zuna.element(A11y.Chat.pins).tap()
        XCTAssertTrue(zuna.element(A11y.Chat.result(note)).waitForExistence(timeout: 10))
        let unpin = zuna.app.buttons["Unpin"]
        XCTAssertTrue(unpin.waitForExistence(timeout: 10))
        unpin.tap()
        try waitFor("alice to see it unpinned") {
            try self.aliceMessages(alice).first { $0["id"] as? String == note }?["pinnedAt"] is NSNull
        }
    }

    func testSendsAPictureAndAFile() throws {
        let alice = try Peer("alice")
        try openAlice()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let tag = String(UUID().uuidString.prefix(4))
        let picture = folder.appendingPathComponent("view-\(tag).png")
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        try UIGraphicsImageRenderer(size: CGSize(width: 300, height: 200), format: format).pngData { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 300, height: 200))
        }.write(to: picture)
        let document = folder.appendingPathComponent("notes-\(tag).txt")
        try Data("Zuna notes \(tag)".utf8).write(to: document)

        try zuna.attachFile(picture)
        try zuna.attachFile(document)
        XCTAssertTrue(zuna.element(A11y.Composer.file("view-\(tag).png")).waitForExistence(timeout: 10))
        XCTAssertTrue(zuna.element(A11y.Composer.file("notes-\(tag).txt")).waitForExistence(timeout: 10))
        type("Two files \(tag)")
        zuna.screenshot("73-composer-files")
        zuna.element(A11y.Composer.send).tap()

        var received: [String: Any]?
        try waitFor("alice to receive the files", timeout: 60) {
            received = try self.aliceMessage(alice, containing: "Two files \(tag)")
            return (received?["attachments"] as? [[String: Any]])?.allSatisfy { ($0["fileId"] as? String)?.isEmpty == false } == true
        }
        let attachments = try XCTUnwrap(received?["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 2)
        let image = try XCTUnwrap(attachments.first { $0["name"] as? String == "view-\(tag).png" })
        XCTAssertEqual(image["mime"] as? String, "image/png")
        XCTAssertEqual(image["width"] as? Int, 300)
        XCTAssertEqual(image["height"] as? Int, 200)
        XCTAssertTrue((image["thumb"] as? String)?.hasPrefix("data:image/jpeg;base64,") == true)
        let text = try XCTUnwrap(attachments.first { $0["name"] as? String == "notes-\(tag).txt" })
        XCTAssertEqual(text["mime"] as? String, "text/plain")
        XCTAssertEqual(text["size"] as? Int, "Zuna notes \(tag)".utf8.count)
        XCTAssertTrue(zuna.element(A11y.Chat.attachment("view-\(tag).png")).waitForExistence(timeout: 20))
        zuna.screenshot("74-sent-files")
    }
}
