import JavaScriptCore
import Network
import XCTest
@testable import ZunaHost

/// The native side of the core bundle's `fetch` and `WebSocket`, against servers on loopback,
/// called the way the bundle calls it, with what it hands back to JavaScript recorded.
final class NetworkBridgeTests: XCTestCase {
    private let queue = DispatchQueue(label: "network-bridge-tests")
    private var context: JSContext!
    private var host: JSValue!
    private var bridge: NetworkBridge!
    private let delivered = Locked<[(function: String, arguments: [Any])]>([])

    override func setUp() {
        context = JSContext()!
        host = JSValue(newObjectIn: context)
        bridge = NetworkBridge(queue: queue) { [delivered] function, arguments in
            delivered.value.append((function, arguments))
        }
        bridge.install(into: host)
    }

    override func tearDown() {
        NetworkProxy.use(nil)
    }

    /// Calls one of the bridge's functions on its queue, as the core does.
    private func call(_ name: String, _ arguments: [Any]) {
        queue.sync { _ = host.objectForKeyedSubscript(name).call(withArguments: arguments) }
    }

    private func bytes(_ data: Data) -> JSValue {
        queue.sync { JSBytes.make(data, in: context) }
    }

    /// What came back for one request: its status, headers, body and error.
    private func response(_ id: Int) async throws -> (status: Int, headers: [String: String], body: Data?, error: String?) {
        let found = await eventually { delivered.value.contains { $0.function == "__zunaHttpDone" && ($0.arguments.first as? Int) == id } }
        guard found, let done = delivered.value.first(where: { $0.function == "__zunaHttpDone" && ($0.arguments.first as? Int) == id }) else {
            throw CoreError(description: "no answer to request \(id)")
        }
        let headers = (done.arguments[2] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String] } ?? [:]
        return (done.arguments[1] as? Int ?? -1, headers, done.arguments[3] as? Data, done.arguments[4] as? String)
    }

    /// The socket events delivered for one socket, as "kind" or "kind:detail".
    private func events(_ id: Int) -> [String] {
        delivered.value.filter { $0.function == "__zunaWsEvent" && ($0.arguments.first as? Int) == id }.map { event in
            let kind = event.arguments[1] as? String ?? "?"
            switch kind {
            case "message": return "message:\(event.arguments[2] as? String ?? "")"
            case "close": return "close:\(event.arguments[3] as? Int ?? -1)"
            default: return kind
            }
        }
    }

    func testARequestCarriesItsHeadersAndBodyAndGetsTheAnswer() async throws {
        let server = try await LocalHTTP.start { request in
            HTTPResponse(status: 201, headers: ["X-Echo": request.headers["x-zuna"] ?? "", "Content-Type": "application/octet-stream"],
                         body: Data(request.method.utf8) + Data([0]) + request.body)
        }
        defer { server.stop() }
        call("http", [1, "POST", "\(server.base)/api/thing", #"{"X-Zuna":"hello","Content-Type":"application/octet-stream"}"#,
                      bytes(Data([0, 1, 2, 255])), 5000, false])
        let answer = try await response(1)
        XCTAssertEqual(answer.status, 201)
        XCTAssertNil(answer.error)
        // Header names come back in lower case, as fetch has them.
        XCTAssertEqual(answer.headers["x-echo"], "hello")
        XCTAssertEqual(answer.body, Data("POST".utf8) + Data([0, 0, 1, 2, 255]))
        XCTAssertEqual(server.requests.first?.path, "/api/thing")

        // Text goes as UTF-8, and sealed requests go on their own connections, to the same answer.
        call("http", [2, "PUT", "\(server.base)/text", "{}", "zażółć", 0, true])
        let text = try await response(2)
        XCTAssertEqual(text.body, Data("PUT".utf8) + Data([0]) + Data("zażółć".utf8))
        // No body at all, and headers that aren't JSON, are left out.
        call("http", [3, "GET", "\(server.base)/plain", "not json", NSNull(), 0, false])
        let plain = try await response(3)
        XCTAssertEqual(plain.body, Data("GET".utf8) + Data([0]))
        XCTAssertEqual(server.requests.last?.headers["x-zuna"], nil)
    }

    func testRequestsThatCantBeMadeFailAsFetchWould() async throws {
        call("http", [1, "GET", "", "{}", NSNull(), 0, false])
        let invalid = try await response(1)
        XCTAssertEqual(invalid.status, 0)
        XCTAssertEqual(invalid.error, "Invalid URL")

        let port = try await closedPort()
        call("http", [2, "GET", "http://127.0.0.1:\(port)/", "{}", NSNull(), 2000, false])
        let refused = try await response(2)
        XCTAssertEqual(refused.status, 0)
        XCTAssertNotNil(refused.error)

        queue.sync { bridge.offline = true }
        call("http", [3, "GET", "http://127.0.0.1:\(port)/", "{}", NSNull(), 0, false])
        let offline = try await response(3)
        XCTAssertEqual(offline.error, "The network is offline.")
        queue.sync { bridge.offline = false }

        // Under a proxy, this device's own addresses aren't asked for: the system would go around it.
        NetworkProxy.use(NetworkProxy(host: "127.0.0.1", port: port))
        call("http", [4, "GET", "http://127.0.0.1:\(port)/", "{}", NSNull(), 0, false])
        let around = try await response(4)
        XCTAssertEqual(around.error, NetworkProxy.goesAroundMessage)
    }

    func testACancelledRequestIsAnsweredNoMoreAndLosingTheNetworkFailsWhatsOpen() async throws {
        // This server never answers, so requests stay in flight.
        let server = try await LocalHTTP.start { _ in nil }
        defer { server.stop() }
        call("http", [1, "GET", "\(server.base)/slow", "{}", NSNull(), 0, false])
        call("http", [2, "GET", "\(server.base)/slow", "{}", NSNull(), 0, false])
        let asked = await eventually { server.requests.count == 2 }
        XCTAssertTrue(asked)
        call("httpCancel", [1])
        let sockets = try await LocalWebSocket.start()
        defer { sockets.stop() }
        call("wsOpen", [7, sockets.url])
        let opened = await eventually { self.events(7) == ["open"] }
        XCTAssertTrue(opened)

        queue.sync { bridge.cancelAll() }
        let lost = try await response(2)
        XCTAssertEqual(lost.error, "The network connection was lost.")
        XCTAssertEqual(events(7), ["open", "error", "close:1006"])
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(delivered.value.contains { $0.function == "__zunaHttpDone" && ($0.arguments.first as? Int) == 1 })
    }

    func testASocketOpensEchoesAndCloses() async throws {
        let server = try await LocalWebSocket.start()
        defer { server.stop() }
        call("wsOpen", [1, server.url])
        let opened = await eventually { self.events(1) == ["open"] }
        XCTAssertTrue(opened, "\(events(1))")
        call("wsSend", [1, "hello"])
        let echoed = await eventually { self.events(1).contains("message:echo: hello") }
        XCTAssertTrue(echoed, "\(events(1))")
        // Closed from here: told at once, with the code given, and nothing after it.
        call("wsClose", [1, 1000])
        XCTAssertEqual(events(1), ["open", "message:echo: hello", "close:1000"])
        call("wsSend", [1, "after"])
        call("wsClose", [1, 1000])

        // Closed by the server, with a code of its own and with one of the protocol's.
        call("wsOpen", [2, server.url])
        _ = await eventually { self.events(2) == ["open"] }
        call("wsSend", [2, "close 4001"])
        let closed = await eventually { self.events(2).last == "close:4001" }
        XCTAssertTrue(closed, "\(events(2))")
        call("wsOpen", [3, server.url])
        _ = await eventually { self.events(3) == ["open"] }
        call("wsSend", [3, "close 1001"])
        let away = await eventually { self.events(3).last == "close:1001" }
        XCTAssertTrue(away, "\(events(3))")

        // Closed from here with a code of the core's own.
        call("wsOpen", [4, server.url])
        _ = await eventually { self.events(4) == ["open"] }
        call("wsClose", [4, 4000])
        XCTAssertEqual(events(4), ["open", "close:4000"])
    }

    func testASocketThatCantOpenReportsAnErrorThenACloseAsABrowserDoes() async throws {
        let port = try await closedPort()
        call("wsOpen", [1, "ws://127.0.0.1:\(port)/socket"])
        let failed = await eventually(within: 20) { self.events(1) == ["error", "close:1006"] }
        XCTAssertTrue(failed, "\(events(1))")

        // What isn't a URL, or has no host, is refused before anything opens.
        call("wsOpen", [2, ""])
        call("wsOpen", [5, "not a url"])
        call("wsOpen", [6, "ws:///api/ws"])
        let invalid = await eventually { [2, 5, 6].allSatisfy { self.events($0) == ["error", "close:1006"] } }
        XCTAssertTrue(invalid, "\([2, 5, 6].map(events))")

        queue.sync { bridge.offline = true }
        call("wsOpen", [3, "ws://127.0.0.1:\(port)/socket"])
        let offline = await eventually { self.events(3) == ["error", "close:1006"] }
        XCTAssertTrue(offline, "\(events(3))")
        queue.sync { bridge.offline = false }

        NetworkProxy.use(NetworkProxy(host: "127.0.0.1", port: port))
        call("wsOpen", [4, "ws://localhost:\(port)/socket"])
        let around = await eventually { self.events(4) == ["error", "close:1006"] }
        XCTAssertTrue(around, "\(events(4))")
    }

    func testASocketTheServerDropsIsAnErrorAndAnAbnormalClose() async throws {
        let server = try await LocalWebSocket.start()
        defer { server.stop() }
        call("wsOpen", [1, server.url])
        _ = await eventually { self.events(1) == ["open"] }
        call("wsSend", [1, "drop"])
        let dropped = await eventually { self.events(1).last == "close:1006" }
        XCTAssertTrue(dropped, "\(events(1))")
        XCTAssertEqual(events(1), ["open", "error", "close:1006"])
    }

    func testAServersPinIsTakenOnlyWhenItCanBeRead() {
        let result = queue.sync { () -> [Bool] in
            let pin = host.objectForKeyedSubscript("pinServer")!
            return [pin.call(withArguments: ["https://203.0.113.9:8443", "not a pin"]).toBool(),
                    pin.call(withArguments: ["https://203.0.113.9:8443", "VD-Ikn5cNN0KSCr99lLkkNSqllK1AH9BBobkHYVBcbA"]).toBool()]
        }
        XCTAssertEqual(result, [false, true])
        XCTAssertEqual(PinnedServers.shared.pins(for: "203.0.113.9"), ["VD-Ikn5cNN0KSCr99lLkkNSqllK1AH9BBobkHYVBcbA"])
    }
}
