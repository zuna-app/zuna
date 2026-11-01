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
}
