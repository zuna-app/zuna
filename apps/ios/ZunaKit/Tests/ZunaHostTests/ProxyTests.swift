import Network
import XCTest
@testable import ZunaHost

/// The proxy set in Privacy (docs/SOCKS5_PLAN.md): its address, what the system would reach
/// around it, the app's own SOCKS5 against a small proxy here, and the rewriting of LiveKit's
/// signalling, which is the core's, run in a context of its own.
final class ProxyTests: XCTestCase {
    func testAProxyIsReadFromItsAddressWithItsPasswordDecoded() throws {
        let proxy = try XCTUnwrap(NetworkProxy(url: "socks5://zuna:p%40ss%20w'rd@proxy.example:1080"))
        XCTAssertEqual(proxy.host, "proxy.example")
        XCTAssertEqual(proxy.port, 1080)
        XCTAssertEqual(proxy.username, "zuna")
        XCTAssertEqual(proxy.password, "p@ss w'rd")
        // What's shown never says the password.
        XCTAssertEqual(proxy.description, "proxy.example:1080")
        XCTAssertEqual(NetworkProxy(url: "socks5h://[2001:db8::1]:9050")?.description, "[2001:db8::1]:9050")
        XCTAssertNil(NetworkProxy(url: "http://proxy.example:1080"))
        XCTAssertNil(NetworkProxy(url: "socks5://proxy.example"))
        XCTAssertFalse(NetworkProxy(url: "socks5://proxy.example:1080")!.signsIn)
    }

    func testWhatTheSystemWouldReachAroundTheProxyIsRefused() {
        for host in ["localhost", "LOCALHOST.", "127.0.0.1", "127.0.0.2", "[::1]", "::ffff:127.0.0.1", "169.254.1.1", "fe80::1", "fd00::1", "0.0.0.0", "224.0.0.1"] {
            XCTAssertTrue(NetworkProxy.goesAround(host), host)
        }
        // Names go to the proxy as names, *.localhost among them, and other addresses to it as addresses.
        for host in ["chat.example.com", "zuna-server.localhost", "zuna-dotless", "printer.local", "10.255.255.1", "192.168.250.250", "203.0.113.5", "2001:db8::1"] {
            XCTAssertFalse(NetworkProxy.goesAround(host), host)
        }
    }

    func testTheDevicesOwnAddressesAreItsOwn() {
        XCTAssertTrue(NetworkProxy.isThisDevice("127.0.0.1"))
        XCTAssertTrue(NetworkProxy.isThisDevice("::1"))
        XCTAssertFalse(NetworkProxy.isThisDevice("203.0.113.5"))
        XCTAssertFalse(NetworkProxy.isThisDevice("relay.example"))
    }

    func testAddressesAndDatagramsAreWrittenAsSocks5HasThem() throws {
        XCTAssertEqual(Socks.encodeAddress("203.0.113.5", 7882), Data([1, 203, 0, 113, 5, 0x1e, 0xca]))
        XCTAssertEqual(Socks.encodeAddress("chat.example", 443), Data([3, 12]) + Data("chat.example".utf8) + Data([1, 0xbb]))
        XCTAssertEqual(Socks.encodeAddress("[2001:db8::1]", 1)?.prefix(2), Data([4, 0x20]))
        XCTAssertNil(Socks.encodeAddress(String(repeating: "a", count: 256), 1))
        let wrapped = try XCTUnwrap(Socks.wrap(Data("stun".utf8), to: "203.0.113.5", port: 7882))
        XCTAssertEqual(wrapped.prefix(3), Data([0, 0, 0]))
        let unwrapped = try XCTUnwrap(Socks.unwrap(wrapped))
        XCTAssertEqual(unwrapped.host, "203.0.113.5")
        XCTAssertEqual(unwrapped.port, 7882)
        XCTAssertEqual(unwrapped.payload, Data("stun".utf8))
        // A datagram in pieces, or cut short, is nobody's.
        var fragment = wrapped
        fragment[2] = 1
        XCTAssertNil(Socks.unwrap(fragment))
        XCTAssertNil(Socks.unwrap(wrapped.prefix(6)))
    }

    func testTheAppsOwnSocks5SignsInConnectsAndIsRefused() async throws {
        let proxy = try await FakeProxy.start(username: "zuna", password: "p@ss w'rd")
        defer { proxy.stop() }
        let good = NetworkProxy(host: "127.0.0.1", port: proxy.port, username: "zuna", password: "p@ss w'rd")
        let queue = DispatchQueue(label: "proxy-tests")
        let connection = try await Socks.connect(good, to: "chat.example", port: 443, queue: queue)
        try await Socks.send(Data("hello".utf8), on: connection)
        let echoed = try await Socks.read(5, from: connection)
        XCTAssertEqual(String(decoding: echoed, as: UTF8.self), "hello")
        connection.cancel()
        XCTAssertEqual(proxy.asked, ["chat.example:443"])
        let probeMissed = await Socks.probe(good)
        XCTAssertNil(probeMissed)

        let wrong = NetworkProxy(host: "127.0.0.1", port: proxy.port, username: "zuna", password: "wrong")
        let refused = await Socks.probe(wrong)
        XCTAssertEqual(refused, .refused)
        let none = await Socks.probe(NetworkProxy(host: "127.0.0.1", port: proxy.port))
        XCTAssertEqual(none, .refused)
        // It asked nothing more of the proxy than the one connection.
        XCTAssertEqual(proxy.asked, ["chat.example:443"])

        let report = await Socks.check(wrong, servers: [])
        guard case .failure(.refused) = report.signedIn else { return XCTFail("\(report.signedIn)") }
        // This one grants no UDP association.
        let checked = await Socks.check(good, servers: [(name: "Here", url: "http://localhost:1")])
        guard case .success = checked.signedIn else { return XCTFail("\(checked.signedIn)") }
        XCTAssertFalse(checked.udp)
        guard case let .failed(why) = checked.servers.first?.reached else { return XCTFail("localhost was checked") }
        XCTAssertEqual(why, NetworkProxy.goesAroundMessage)
    }

    func testAProxyThatIsGoneIsUnreachable() async throws {
        let proxy = try await FakeProxy.start(username: "", password: "")
        let port = proxy.port
        proxy.stop()
        try await Task.sleep(for: .milliseconds(200))
        let failure = await Socks.probe(NetworkProxy(host: "127.0.0.1", port: port))
        guard case .unreachable = failure else { return XCTFail("\(String(describing: failure))") }
        XCTAssertTrue(failure!.atProxy)
    }

    func testACallsEndpointListensOnLoopbackBehindASecret() async throws {
        let proxy = try await FakeProxy.start(username: "", password: "")
        defer { proxy.stop() }
        let call = try await CallProxy.start(target: "wss://chat.example/livekit", proxy: NetworkProxy(host: "127.0.0.1", port: proxy.port))
        defer { call.close() }
        // This proxy grants no UDP association, so calls go over TCP.
        XCTAssertFalse(call.udp)
        XCTAssertTrue(call.url.hasPrefix("ws://127.0.0.1:"), call.url)
        XCTAssertNil(call.relay(for: "udp", address: "203.0.113.5", port: 7882))
        let relay = try XCTUnwrap(call.relay(for: "tcp", address: "203.0.113.5", port: 7881))
        XCTAssertEqual(relay.address, "127.0.0.1")
        XCTAssertEqual(call.relay(for: "tcp", address: "203.0.113.5", port: 7881)?.port, relay.port)
        // Without the secret, the endpoint answers nothing.
        let url = try XCTUnwrap(URL(string: call.url))
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(url.port!)/wrong/rtc/validate")!)
        request.timeoutInterval = 5
        let (_, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 404)
    }

    /// A `SignalResponse` holding a trickled candidate, as LiveKit sends one: field 4, a
    /// `TrickleRequest` whose field 1 is the candidate as JSON.
    private func trickle(_ candidate: String, field: UInt8 = 0x22) -> Data {
        let json = Data(#"{"candidate":"\#(candidate)","sdpMid":"0","sdpMLineIndex":0}"#.utf8)
        let inner = Data([0x0a, UInt8(json.count)]) + json
        return Data([field, UInt8(inner.count)]) + inner
    }

    func testLiveKitsSignallingIsRewrittenByTheCoresOwnCode() throws {
        let relay = VoiceRelay.shared
        let rewritten = try relay.fromLiveKit(trickle("candidate:1 1 udp 2130706431 203.0.113.5 7882 typ host")) { proto, address, port in
            XCTAssertEqual(proto, "udp")
            XCTAssertEqual(address, "203.0.113.5")
            XCTAssertEqual(port, 7882)
            return ("127.0.0.1", 41000)
        }.get()
        let text = String(decoding: rewritten, as: UTF8.self)
        XCTAssertTrue(text.contains("candidate:1 1 udp 2130706431 127.0.0.1 41000 typ host"), text)
        XCTAssertFalse(text.contains("203.0.113.5"))
        // No relay, no candidate.
        XCTAssertEqual(relay.fromLiveKit(trickle("candidate:1 1 udp 2130706431 203.0.113.5 7882 typ host")) { _, _, _ in nil }, .failure(VoiceRelay.Dropped("a candidate of LiveKit's with no relay")))
        // The device's own candidates go nowhere: a SignalRequest's trickle is field 3.
        XCTAssertEqual(relay.toLiveKit(trickle("candidate:2 1 udp 2122260223 192.168.1.20 51234 typ host", field: 0x1a)), .failure(VoiceRelay.Dropped("a candidate of this device's")))
        guard case let .failure(unknown) = relay.fromLiveKit(Data([0x9a, 0x06, 0x01, 0x00]), relayFor: { _, _, _ in nil }) else { return XCTFail("an unknown kind went on") }
        XCTAssertTrue(unknown.reason.contains("doesn't know"), unknown.reason)
        XCTAssertEqual(try relay.joinAddress("ws://127.0.0.1:7880/rtc?access_token=x").get(), "ws://127.0.0.1:7880/rtc?access_token=x")
    }
}

/// A SOCKS5 proxy with a username and password, which answers CONNECT and echoes what it's sent,
/// and refuses UDP associations.
private final class FakeProxy: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "fake-proxy")
    private let username: String
    private let password: String
    private let lock = NSLock()
    private var requests: [String] = []
    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var asked: [String] { lock.withLock { requests } }

    private init(listener: NWListener, username: String, password: String) {
        self.listener = listener
        self.username = username
        self.password = password
    }

    static func start(username: String, password: String) async throws -> FakeProxy {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let proxy = FakeProxy(listener: try NWListener(using: parameters), username: username, password: password)
        proxy.listener.newConnectionHandler = { connection in proxy.serve(connection) }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = Once()
            proxy.listener.stateUpdateHandler = { state in
                if case .ready = state { once.run { continuation.resume() } }
                if case let .failed(error) = state { once.run { continuation.resume(throwing: error) } }
            }
            proxy.listener.start(queue: proxy.queue)
        }
        return proxy
    }

    func stop() { listener.cancel() }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        Task {
            do {
                let greeting = try await Socks.read(2, from: connection)
                let methods = [UInt8](try await Socks.read(Int(greeting[1]), from: connection))
                let wants = !username.isEmpty
                guard methods.contains(wants ? 2 : 0) else {
                    try await Socks.send(Data([5, 0xff]), on: connection)
                    return connection.cancel()
                }
                try await Socks.send(Data([5, wants ? 2 : 0]), on: connection)
                if wants {
                    let head = try await Socks.read(2, from: connection)
                    let user = try await Socks.read(Int(head[1]), from: connection)
                    let length = try await Socks.read(1, from: connection)
                    let pass = try await Socks.read(Int(length[0]), from: connection)
                    let good = String(decoding: user, as: UTF8.self) == username && String(decoding: pass, as: UTF8.self) == password
                    try await Socks.send(Data([1, good ? 0 : 1]), on: connection)
                    guard good else { return connection.cancel() }
                }
                let request = try await Socks.read(4, from: connection)
                var host = ""
                switch request[3] {
                case 1: host = "\(IPv4Address(try await Socks.read(4, from: connection))!)"
                case 3: host = String(decoding: try await Socks.read(Int(try await Socks.read(1, from: connection)[0]), from: connection), as: UTF8.self)
                default: return connection.cancel()
                }
                let port = try await Socks.read(2, from: connection)
                guard request[1] == Socks.connect else {
                    try await Socks.send(Data([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]), on: connection)
                    return connection.cancel()
                }
                lock.withLock { requests.append("\(host):\(Int(port[0]) << 8 | Int(port[1]))") }
                try await Socks.send(Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]), on: connection)
                while true {
                    try await Socks.send(try await Socks.read(1, from: connection), on: connection)
                }
            } catch {
                connection.cancel()
            }
        }
    }
}
