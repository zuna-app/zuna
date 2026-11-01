import XCTest
@testable import ZunaHost

/// A server's emote pictures, served from memory a little slowly, counting what's asked for.
final class EmoteServer: URLProtocol {
    private static let lock = NSLock()
    private static var asked: [String] = []
    private static var inFlight = 0
    private static var mostAtOnce = 0
    static var missing: Set<String> = []

    static func reset() {
        lock.withLock {
            asked = []
            inFlight = 0
            mostAtOnce = 0
            missing = []
        }
    }

    static var requested: [String] { lock.withLock { asked } }
    static var concurrency: Int { lock.withLock { mostAtOnce } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let address = "\(url.host ?? "")\(url.path)"
        let found = Self.lock.withLock {
            Self.asked.append(address)
            Self.inFlight += 1
            Self.mostAtOnce = max(Self.mostAtOnce, Self.inFlight)
            return !Self.missing.contains(address)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) { [self] in
            Self.lock.withLock { Self.inFlight -= 1 }
            let response = HTTPURLResponse(url: url, statusCode: found ? 200 : 404, httpVersion: nil, headerFields: ["Content-Type": "image/webp"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("picture at \(address)".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

final class EmoteFilesTests: XCTestCase {
    private let server = "https://chat.example"
    private var directory: URL!
    private var files: EmoteFiles!

    override func setUpWithError() throws {
        EmoteServer.reset()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EmoteServer.self]
        files = EmoteFiles(directory: directory, configuration: configuration)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func addresses(_ ids: [String], host: String = "chat.example") -> Set<String> {
        Set(ids.flatMap { id in EmoteFiles.sizes.map { "\(host)/api/emotes/\(id)/\($0).webp" } })
    }

    func testFetchesEverySizeOfTheSetAheadTwoAtATime() async {
        await files.prefetch(["a", "b", "c", "d"], serverUrl: server)
        XCTAssertEqual(Set(EmoteServer.requested), addresses(["a", "b", "c", "d"]))
        XCTAssertEqual(EmoteServer.requested.count, 12)
        XCTAssertEqual(EmoteServer.concurrency, EmoteFiles.atOnce)
    }

    func testShowingAFetchedEmoteAsksTheServerForNothing() async {
        await files.prefetch(["a"], serverUrl: server)
        EmoteServer.reset()
        for size in EmoteFiles.sizes {
            let data = await files.data("a", size, serverUrl: server)
            XCTAssertEqual(data, Data("picture at chat.example/api/emotes/a/\(size).webp".utf8))
        }
        XCTAssertEqual(EmoteServer.requested, [])
    }

    func testFetchesOnlyWhatsNewAndDropsWhatLeftTheSet() async {
        await files.prefetch(["a", "b"], serverUrl: server)
        EmoteServer.reset()
        await files.prefetch(["b", "c"], serverUrl: server)
        XCTAssertEqual(Set(EmoteServer.requested), addresses(["c"]))
        XCTAssertNil(files.file("a", "1x", serverUrl: server).flatMap { try? Data(contentsOf: $0) })
        EmoteServer.reset()
        _ = await files.data("a", "2x", serverUrl: server)
        XCTAssertEqual(EmoteServer.requested, ["chat.example/api/emotes/a/2x.webp"])
    }

    func testKeepsWhatIsFetchedWhenShown() async {
        let first = await files.data("z", "3x", serverUrl: server)
        let second = await files.data("z", "3x", serverUrl: server)
        XCTAssertNotNil(first)
        XCTAssertEqual(first, second)
        XCTAssertEqual(EmoteServer.requested, ["chat.example/api/emotes/z/3x.webp"])
    }

    func testDoesntKeepWhatTheServerDoesntHave() async {
        EmoteServer.missing = ["chat.example/api/emotes/gone/1x.webp"]
        let missing = await files.data("gone", "1x", serverUrl: server)
        XCTAssertNil(missing)
        _ = await files.data("gone", "1x", serverUrl: server)
        XCTAssertEqual(EmoteServer.requested.count, 2)
    }

    func testKeepsEachServersPicturesApart() async {
        await files.prefetch(["a"], serverUrl: server)
        await files.prefetch(["a"], serverUrl: "https://other.example")
        XCTAssertEqual(Set(EmoteServer.requested), addresses(["a"]).union(addresses(["a"], host: "other.example")))
    }

    func testAsksForNothingWithAnIdTheCoreWouldRefuse() async {
        for id in ["../a", "a/b", "a.b", "", String(repeating: "a", count: 65), "é"] {
            let data = await files.data(id, "1x", serverUrl: server)
            XCTAssertNil(data, id)
        }
        await files.prefetch(["../a", "a?b", "a#b"], serverUrl: server)
        let unknownSize = await files.data("a", "4x", serverUrl: server)
        XCTAssertNil(unknownSize)
        XCTAssertEqual(EmoteServer.requested, [])
        XCTAssertTrue(EmoteFiles.isEmoteId("01GB2S8Z_tAm-x"))
    }

    func testFetchingAheadWaitsOnLowDataMode() {
        XCTAssertFalse(files.aheadConfiguration.allowsConstrainedNetworkAccess)
        XCTAssertNil(files.aheadConfiguration.urlCache)
        XCTAssertFalse(files.aheadConfiguration.httpShouldSetCookies)
    }
}
