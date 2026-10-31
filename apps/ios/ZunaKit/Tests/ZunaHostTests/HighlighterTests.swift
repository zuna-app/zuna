import XCTest
import ZunaHost

/// Code blocks are colored by the desktop's Shiki setup, bundled for JavaScriptCore.
final class HighlighterTests: XCTestCase {
    func testColorsKnownLanguagesAndAliases() async throws {
        let typescript = await Highlighter.shared.tokens("const a = 1;\nlet b = 'x';", language: "ts")
        let lines = try XCTUnwrap(typescript)
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0].map(\.text).joined(), "const a = 1;")
        // github-dark-default colors keywords red.
        XCTAssertEqual(lines[0].first?.color?.uppercased(), "#FF7B72")
        let golang = await Highlighter.shared.tokens("func main() {}", language: "golang")
        let go = try XCTUnwrap(golang)
        XCTAssertEqual(go.first?.map(\.text).joined(), "func main() {}")
    }

    /// The golden file comes from the desktop's own highlightCode (tests/e2e/golden/highlight.ts).
    func testColorsExactlyLikeTheDesktop() async throws {
        struct Golden: Decodable {
            struct Sample: Decodable {
                let language: String
                let code: String
                let tokens: [[[String?]]]
            }

            let samples: [Sample]
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/highlight-golden.json")
        let golden = try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(golden.samples.count, 10)
        for sample in golden.samples {
            let lines = await Highlighter.shared.tokens(sample.code, language: sample.language)
            let ours = (lines ?? []).map { line in line.map { [$0.text, $0.color] } }
            XCTAssertEqual(ours, sample.tokens, sample.language)
        }
    }

    func testLeavesUnknownLanguagesPlain() async {
        let lines = await Highlighter.shared.tokens("whatever", language: "brainfudge")
        XCTAssertNil(lines)
    }
}
