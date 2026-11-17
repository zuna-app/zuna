import XCTest
import ZunaModels

/// A chat's details list links and attachments the way the core counts them.
/// Expected values come from running the core's `sharedLinks` and `linkHost` in Node.
final class MediaTests: XCTestCase {
    func testFindsTheLinksTheCoreCounts() {
        let cases: [(String, [String])] = [
            ("see https://example.com/a and http://www.Example.org/b?x=1.", ["https://example.com/a", "http://www.Example.org/b?x=1"]),
            ("code `https://hidden.example` and ```\nhttps://fenced.example\n``` and https://shown.example", ["https://shown.example"]),
            ("spoiler ||https://secret.example|| then https://open.example/path_(with)_parens)", ["https://open.example/path_(with)_parens"]),
            ("unclosed ```https://after-fence.example", []),
            ("no links here, just text", []),
            ("(https://wiki.example/A_(b)), done!", ["https://wiki.example/A_(b)"]),
            ("xhttps://glued.example and https://ok.example/ż", ["https://ok.example/ż"]),
            ("two `` https://empty-code.example `` ticks", ["https://empty-code.example"]),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(Markup.sharedLinks(input), expected, "for \(input.debugDescription)")
        }
    }

    func testNamesTheSiteALinkGoesTo() {
        XCTAssertEqual(linkHost("https://www.Example.org/b"), "example.org")
        XCTAssertEqual(linkHost("http://127.0.0.1:8080/x"), "127.0.0.1")
        XCTAssertEqual(linkHost("https://sub.domain.example"), "sub.domain.example")
        XCTAssertEqual(linkHost("not a url"), "")
    }

    func testSortsAttachmentsAsTheCoreDoes() throws {
        func attachment(_ mime: String, width: Double? = nil, voice: Bool? = nil) throws -> Attachment {
            var fields: [String: Any] = ["fileId": "f", "key": "k", "prefix": "p", "chunks": 1, "name": "n", "mime": mime, "size": 1]
            if let width { fields["width"] = width }
            if let voice { fields["voice"] = voice }
            return try JSONDecoder().decode(Attachment.self, from: JSONSerialization.data(withJSONObject: fields))
        }
        XCTAssertEqual(try attachment("image/png", width: 40).mediaKind, .photo)
        // A picture with no size can't be laid out, so it's a file.
        XCTAssertEqual(try attachment("image/png").mediaKind, .file)
        XCTAssertEqual(try attachment("audio/mp4", voice: true).mediaKind, .voice)
        XCTAssertEqual(try attachment("video/mp4").mediaKind, .video)
        XCTAssertEqual(try attachment("audio/mpeg").mediaKind, .audio)
        XCTAssertEqual(try attachment("application/pdf").mediaKind, .file)
    }

    /// A sticker, or a custom emoji sent alone, as `attachmentsOf` in the core's `telegram/map.ts` gives one.
    private func sticker(width: Double? = 512, height: Double? = 512, mime: String = "image/webp") -> [String: Any] {
        var fields: [String: Any] = ["fileId": "tg:1:2", "key": "", "prefix": "", "chunks": 0, "name": "sticker.webp", "mime": mime, "size": 4000, "sticker": true]
        if let width { fields["width"] = width }
        if let height { fields["height"] = height }
        return fields
    }

    private func message(_ changes: [String: Any] = [:]) throws -> MessageView {
        var fields: [String: Any] = [
            "id": "m1", "groupId": "g", "seq": 3, "senderId": "u", "createdAt": 1, "status": "sent", "text": "",
            "emotes": [String: Any](), "attachments": [sticker()], "mentions": [String](), "reactions": [Any](),
        ]
        fields.merge(changes) { $1 }
        return try JSONDecoder().decode(MessageView.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    func testSizesAStickerAsTheDesktopDoes() throws {
        func size(_ width: Double?, _ height: Double?) throws -> CGSize {
            try JSONDecoder().decode(Attachment.self, from: JSONSerialization.data(withJSONObject: sticker(width: width, height: height))).stickerSize
        }
        XCTAssertEqual(try size(512, 512), CGSize(width: 160, height: 160))
        // A custom emoji's picture is smaller, and shows as large as a sticker.
        XCTAssertEqual(try size(100, 100), CGSize(width: 160, height: 160))
        XCTAssertEqual(try size(512, 256), CGSize(width: 160, height: 80))
        XCTAssertEqual(try size(300, 600), CGSize(width: 80, height: 160))
        XCTAssertEqual(try size(nil, nil), CGSize(width: 160, height: 160))
    }

    func testShowsAStickerAloneWithoutABubble() throws {
        XCTAssertEqual(try message().loneSticker?.fileId, "tg:1:2")
        XCTAssertNotNil(try message(["reactions": [["key": "👍", "userIds": ["u"]]]]).loneSticker)
        XCTAssertNotNil(try message(["status": "sending"]).loneSticker)
        // Anything with it keeps the bubble: words, another file, what it answers or where it's from.
        XCTAssertNil(try message(["text": "hi"]).loneSticker)
        XCTAssertNil(try message(["attachments": [sticker(), sticker()]]).loneSticker)
        XCTAssertNil(try message(["reply": ["id": "m0", "senderId": "v", "text": "", "hasAttachment": true, "deleted": false]]).loneSticker)
        XCTAssertNil(try message(["forwarded": ["userId": "v"]]).loneSticker)
        // A picture that isn't a sticker is a picture, and a sticker that isn't a picture can't show as one.
        var photo = sticker()
        photo["sticker"] = nil
        XCTAssertNil(try message(["attachments": [photo]]).loneSticker)
        XCTAssertNil(try message(["attachments": [sticker(mime: "application/x-tgsticker")]]).loneSticker)
        XCTAssertNil(try message(["deletedAt": 2]).loneSticker)
        XCTAssertNil(try message(["status": "unverified"]).loneSticker)
    }
}
