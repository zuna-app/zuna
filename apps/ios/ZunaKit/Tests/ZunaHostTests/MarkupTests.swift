import XCTest
import ZunaModels

/// Message markup must read exactly as on the desktop. The golden file holds
/// what the desktop's own renderer made of a corpus of messages
/// (tests/e2e/golden/markup.tsx); this renders the Swift parse the same way.
final class MarkupTests: XCTestCase {
    private struct Golden: Decodable {
        struct Case: Decodable {
            let text: String
            let html: String
        }

        struct Jumbo: Decodable {
            let text: String
            let size: Int
        }

        let emotes: [String: EmoteRef]
        let users: [String: String]
        let selfId: String
        let cases: [Case]
        let jumbo: [Jumbo]
    }

    private let golden: Golden = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/markup-golden.json")
        return try! JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
    }()

    func testParsesLikeTheDesktop() {
        let context = Markup.Context(emotes: golden.emotes, mentionable: golden.users)
        XCTAssertGreaterThan(golden.cases.count, 50)
        for item in golden.cases {
            let html = Self.html(Markup.parse(item.text, context), selfId: golden.selfId)
            XCTAssertEqual(html, item.html, "for \(item.text.debugDescription)")
        }
    }

    func testSizesLargeEmojiLikeTheDesktop() {
        XCTAssertGreaterThan(golden.jumbo.count, 15)
        for item in golden.jumbo {
            XCTAssertEqual(Markup.jumboSize(item.text, emotes: golden.emotes), item.size, "for \(item.text.debugDescription)")
        }
    }

    // MARK: The desktop's HTML, with the stand-ins from tests/e2e/golden/stubs.tsx

    private static func html(_ blocks: [Markup.Block], selfId: String) -> String {
        var out = ""
        for (index, block) in blocks.enumerated() {
            let isLast = index == blocks.count - 1
            switch block {
            case let .text(nodes):
                out += #"<span class="text-block">"# + inline(nodes, selfId) + (isLast ? "<time></time>" : "") + "</span>"
            case let .quote(nodes):
                out += #"<blockquote class="quote">"# + inline(nodes, selfId) + "</blockquote>"
            case let .code(code, language):
                out += #"<pre data-language="\#(escape(language ?? ""))">"# + escape(code) + "</pre>"
            }
        }
        if case .text? = blocks.last {} else {
            out += #"<span class="text-block"><time></time></span>"#
        }
        return out
    }

    private static func inline(_ nodes: [Markup.Inline], _ selfId: String) -> String {
        nodes.map { node in
            switch node {
            case let .text(text):
                escape(text)
            case let .emote(name, emote):
                #"<i data-emote="\#(escape(name))" data-id="\#(escape(emote.id))" data-zw="\#(emote.zeroWidth == true ? "1" : "0")"></i>"#
            case let .mention(username, userId):
                #"<button class="mention\#(userId == selfId ? " is-self" : "")">@\#(escape(username))</button>"#
            case let .link(url):
                #"<a href="\#(escape(url))" target="_blank" rel="noreferrer noopener">\#(escape(url))</a>"#
            case let .code(code):
                #"<code class="inline-code">\#(escape(code))</code>"#
            case let .spoiler(children):
                #"<span class="spoiler">"# + inline(children, selfId) + "</span>"
            case let .bold(children):
                "<strong>" + inline(children, selfId) + "</strong>"
            case let .strike(children):
                "<del>" + inline(children, selfId) + "</del>"
            case let .italic(children):
                "<em>" + inline(children, selfId) + "</em>"
            }
        }.joined()
    }

    /// React's escaping of text and attributes.
    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#x27;")
    }
}
