import JavaScriptCore
import XCTest
@testable import ZunaHost

/// Link previews fetched from pages on loopback, which test builds may reach (`isTestPage`):
/// redirects followed only where previews may go, a page cut at what a preview needs, and one
/// in another encoding handed back as UTF-8.
final class WebBridgeTests: XCTestCase {
    private let queue = DispatchQueue(label: "web-bridge-tests")
    private var object: JSValue!
    private var bridge: WebBridge!
    private let delivered = Locked<[Int: [Any]]>([:])
    private var server: LocalHTTP!

    override func setUp() async throws {
        let context = JSContext()!
        object = JSValue(newObjectIn: context)
        bridge = WebBridge(queue: queue) { [delivered] _, arguments in
            if let id = arguments.first as? Int { delivered.value[id] = arguments }
        }
        bridge.install(into: object)
        server = try await LocalHTTP.start { request in
            switch request.path {
            case "/page": HTTPResponse(headers: ["Content-Type": "text/html; charset=utf-8"], body: Data("<title>Here</title>".utf8))
            case "/latin2":
                // "Zażółć" in ISO-8859-2.
                HTTPResponse(headers: ["Content-Type": "text/html; charset=iso-8859-2"], body: Data([0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6]))
            case "/long": HTTPResponse(headers: ["Content-Type": "text/plain"], body: Data(repeating: 0x61, count: 200_000))
            case "/hop": HTTPResponse(status: 302, headers: ["Location": "/page"])
            case "/loop": HTTPResponse(status: 302, headers: ["Location": "/loop"])
            case "/inside": HTTPResponse(status: 302, headers: ["Location": "https://10.0.0.1/admin"])
            case "/gone": HTTPResponse(status: 404, body: Data("missing".utf8))
            default: HTTPResponse(status: 500)
            }
        }
    }

    override func tearDown() {
        server.stop()
        NetworkProxy.use(nil)
    }

    private func fetch(_ id: Int, _ url: String, maxBytes: Int = 60000) async throws -> (url: String, type: String, body: Data?, error: String?) {
        queue.sync { _ = object.objectForKeyedSubscript("webFetch").call(withArguments: [id, url, maxBytes]) }
        let arrived = await eventually(within: 15) { self.delivered.value[id] != nil }
        guard arrived, let result = delivered.value[id] else { throw CoreError(description: "no answer to fetch \(id)") }
        return (result[1] as? String ?? "", result[2] as? String ?? "", result[3] as? Data, result[4] as? String)
    }

    func testARedirectIsFollowedToWherePreviewsMayGo() async throws {
        let followed = try await fetch(1, "\(server.base)/hop")
        XCTAssertNil(followed.error)
        XCTAssertEqual(followed.url, "\(server.base)/page")
        XCTAssertEqual(followed.body.map { String(decoding: $0, as: UTF8.self) }, "<title>Here</title>")
        XCTAssertEqual(followed.type, "text/html; charset=utf-8")

        // Not to a private network, and not forever: the redirect itself is no page.
        let inside = try await fetch(2, "\(server.base)/inside")
        XCTAssertEqual(inside.error, "The page isn't available.")
        let loop = try await fetch(3, "\(server.base)/loop")
        XCTAssertEqual(loop.error, "The page isn't available.")
        XCTAssertEqual(server.requests.filter { $0.path == "/loop" }.count, 6)
        let missing = try await fetch(4, "\(server.base)/gone")
        XCTAssertEqual(missing.error, "The page isn't available.")
    }

    func testAPageIsCutAtWhatAPreviewNeedsAndReadAsUTF8() async throws {
        let long = try await fetch(1, "\(server.base)/long", maxBytes: 1000)
        XCTAssertNil(long.error)
        XCTAssertEqual(long.body?.count, 1000)
        let latin = try await fetch(2, "\(server.base)/latin2")
        XCTAssertEqual(latin.body.map { String(decoding: $0, as: UTF8.self) }, "Zażółć")
        XCTAssertEqual(latin.type, "text/html; charset=utf-8")
    }

    func testWhatCantBePreviewedIsNeverFetched() async throws {
        let ftp = try await fetch(1, "ftp://files.example/readme")
        XCTAssertEqual(ftp.error, "That link can't be previewed.")
        // Under a proxy, this device's own pages are out of reach: the system would go around it.
        NetworkProxy.use(NetworkProxy(host: "127.0.0.1", port: 9))
        let around = try await fetch(2, "\(server.base)/page")
        XCTAssertEqual(around.error, "That link can't be previewed.")
        XCTAssertTrue(server.requests.isEmpty)
    }
}
