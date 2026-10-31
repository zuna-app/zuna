import XCTest
import ZunaModels

/// The previews in the conversation list must read the same as on the desktop.
/// Expected values come from running the core's `plainText` in Node.
final class PlainTextTests: XCTestCase {
    func testMatchesTheCore() {
        let cases: [(String, String)] = [
            ("hello world", "hello world"),
            ("**bold** and ~~gone~~ and `code`", "bold and gone and code"),
            ("```ts\nconst a = 1;\n```\nafter", "[code] after"),
            ("secret: ||the butler|| did it", "secret: [spoiler] did it"),
            ("*italic* but not 2*3*4 or *nope *", "italic but not 2*3*4 or *nope *"),
            ("_under_ snake_case_name _ x_", "under snake_case_name _ x_"),
            ("> quoted line\n>second\nplain", "quoted line second plain"),
            ("  lots   of\n\n spaces\t ", "lots of spaces"),
            ("**unclosed and *mixed**", "unclosed and *mixed"),
            ("zażółć *gęślą* jaźń", "zażółć gęślą jaźń"),
            ("emoji 👋 *wave* 🎉", "emoji 👋 wave 🎉"),
            ("a*b*c and _a_b", "a*b*c and _a_b"),
            ("ż*x* y", "żx y"),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(plainText(input), expected, "for \(input.debugDescription)")
        }
    }
}
