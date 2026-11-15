import XCTest
import ZunaModels

/// Telegram's mentions by name in the message box, as the desktop's `keeps_mentions_by_name_in_the_message_box`.
final class NamedMentionsTests: XCTestCase {
    private func ann(_ location: Int) -> [NamedMention] { [NamedMention(location: location, length: 3, userId: "5")] }

    func testKeepsMentionsByNameInTheMessageBox() {
        let markup = "hi [Łukasz](tg://user?id=42) and [Ann](tg://user?id=5)!"
        let (text, named) = NamedMentions.take(markup)
        XCTAssertEqual(text, "hi Łukasz and Ann!")
        XCTAssertEqual(named, [NamedMention(location: 3, length: 6, userId: "42"), NamedMention(location: 14, length: 3, userId: "5")])
        XCTAssertEqual(NamedMentions.put(text, named), markup)

        // Typing before one moves it, even where the letters typed are its own.
        let typedBefore = NamedMentions.follow(from: text, to: "Ahi Łukasz and Ann!", named)
        XCTAssertEqual(NamedMentions.put("Ahi Łukasz and Ann!", typedBefore), "Ahi [Łukasz](tg://user?id=42) and [Ann](tg://user?id=5)!")
        XCTAssertEqual(NamedMentions.put("AAnn", NamedMentions.follow(from: "Ann", to: "AAnn", ann(0))), "A[Ann](tg://user?id=5)")
        // Typing right after one leaves it as it was, the same letter or another.
        XCTAssertEqual(NamedMentions.put("Annn", NamedMentions.follow(from: "Ann", to: "Annn", ann(0))), "[Ann](tg://user?id=5)n")
        XCTAssertEqual(NamedMentions.put("Anna", NamedMentions.follow(from: "Ann", to: "Anna", ann(0))), "[Ann](tg://user?id=5)a")
        // Changing its words makes them plain, and taking text out between moves what follows.
        let changed = NamedMentions.follow(from: text, to: "hi Łukaz and Ann!", named)
        XCTAssertEqual(NamedMentions.put("hi Łukaz and Ann!", changed), "hi Łukaz and [Ann](tg://user?id=5)!")
        let cut = NamedMentions.follow(from: text, to: "hi Łukasz Ann!", named)
        XCTAssertEqual(NamedMentions.put("hi Łukasz Ann!", cut), "hi [Łukasz](tg://user?id=42) [Ann](tg://user?id=5)!")
        XCTAssertEqual(NamedMentions.follow(from: text, to: "", named), [])
        // What can't be written out stays the words it is.
        XCTAssertEqual(NamedMentions.put("a]b c", [NamedMention(location: 0, length: 3, userId: "5"), NamedMention(location: 4, length: 1, userId: "0"), NamedMention(location: 9, length: 3, userId: "5")]), "a]b c")
        XCTAssertEqual(NamedMentions.take("[x](tg://user?id=9999999999999999)").named, [])
    }

    func testMentionsSomeoneByTheirFirstName() throws {
        let json = #"{"id":"2","username":"","role":"member","displayName":"Grace [the] Hopper","bio":"","online":false,"hidesLastSeen":true,"banned":false,"deleted":false,"trust":"unverified","isSelf":false}"#
        var grace = try JSONDecoder().decode(UserView.self, from: Data(json.utf8))
        XCTAssertEqual(NamedMentions.name(for: grace), "Grace the Hopper")
        grace.firstName = " Grace\r\n"
        XCTAssertEqual(NamedMentions.name(for: grace), "Grace")
        grace.id = "chat:9"
        XCTAssertNil(NamedMentions.name(for: grace), "a chat speaking as itself")
    }
}
