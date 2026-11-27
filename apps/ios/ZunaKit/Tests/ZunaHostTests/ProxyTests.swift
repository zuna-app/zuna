import Network
import XCTest
@testable import ZunaHost

/// The proxy set in Privacy (docs/SOCKS5.md): its address, what the system would reach
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

    func testACallsSignallingGoesThroughTheProxyRewrittenBothWays() async throws {
        // What LiveKit sends once the socket opens: a candidate, which is given a relay here, then
        // what the relay drops, text and a kind it doesn't know, then what it passes as it is.
        let pong = Data([0x90, 0x01, 0x05])
        let response = message(field: 20, size: 200)
        let longResponse = message(field: 20, size: 70000)
        let livekit = try await FakeLiveKit.start(greeting: [
            (false, trickle("candidate:1 1 tcp 2130706431 203.0.113.5 7881 typ host tcptype passive")),
            (true, Data("hello".utf8)),
            (false, Data([0x98, 0x03, 0x00])),
            (false, pong),
            (false, response),
            (false, longResponse),
        ])
        defer { livekit.stop() }
        let proxy = try await FakeProxy.start(username: "", password: "", forward: ["livekit.example": livekit.port])
        defer { proxy.stop() }
        let call = try await CallProxy.start(target: "ws://livekit.example:\(livekit.port)/", proxy: NetworkProxy(host: "127.0.0.1", port: proxy.port))
        defer { call.close() }
        let endpoint = try XCTUnwrap(URL(string: call.url))

        let sdk = try await SDKSocket(port: UInt16(endpoint.port!))
        let head = try await sdk.request(
            "GET \(endpoint.path)/rtc?access_token=token HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer token\r\n\r\n")
        XCTAssertTrue(head.hasPrefix("HTTP/1.1 101 "), head)
        XCTAssertTrue(head.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), head)
        XCTAssertEqual(proxy.asked, ["livekit.example:\(livekit.port)"])

        let candidate = try await sdk.frame()
        let relay = try XCTUnwrap(call.relay(for: "tcp", address: "203.0.113.5", port: 7881))
        let text = String(decoding: candidate.payload, as: UTF8.self)
        XCTAssertEqual(candidate.opcode, 2)
        XCTAssertTrue(text.contains("127.0.0.1 \(relay.port) typ host"), text)
        XCTAssertFalse(text.contains("203.0.113.5"), text)
        let passed = try await sdk.frame()
        XCTAssertEqual(passed.payload, pong, "what the relay drops went on")
        let long = try await sdk.frame()
        XCTAssertEqual(long.payload, response)
        let longest = try await sdk.frame()
        XCTAssertEqual(longest.payload, longResponse)

        // A ping is answered here. What the SDK sends goes on to LiveKit, in pieces or whole and
        // however long, but not as text, nor this device's own candidates.
        try await sdk.send(opcode: 9, Data("are you there".utf8))
        let answered = try await sdk.frame()
        XCTAssertEqual(answered.opcode, 10)
        XCTAssertEqual(answered.payload, Data("are you there".utf8))
        let ping = Data([0x70, 0x01])
        let request = message(field: 15, size: 200)
        let longRequest = message(field: 15, size: 70000)
        try await sdk.send(fin: false, opcode: 2, ping.prefix(1))
        try await sdk.send(opcode: 0, ping.suffix(1))
        try await sdk.send(opcode: 1, Data("text".utf8))
        try await sdk.send(opcode: 3, Data())
        try await sdk.send(opcode: 2, trickle("candidate:2 1 udp 2122260223 192.168.1.20 51234 typ host", field: 0x1a))
        try await sdk.send(opcode: 2, request)
        try await sdk.send(opcode: 2, longRequest)
        try await eventually("everything reaching LiveKit") { livekit.received.count == 3 }
        XCTAssertEqual(livekit.received, [ping, request, longRequest])
        XCTAssertEqual(livekit.authorization, "Bearer token")

        // The SDK's goodbye goes on to LiveKit too, and is answered.
        try await sdk.send(opcode: 8, Data([0x03, 0xe8]))
        let goodbye = try await sdk.frame()
        XCTAssertEqual(goodbye.opcode, 8)
        try await eventually("LiveKit hearing the socket close") { livekit.closed }
    }

    func testACallsEndpointAsksLiveKitWhyItWasRefusedThroughTheProxy() async throws {
        let livekit = try await FakeRefusal.start()
        defer { livekit.stop() }
        let proxy = try await FakeProxy.start(username: "", password: "", forward: ["livekit.example": livekit.port])
        defer { proxy.stop() }
        let call = try await CallProxy.start(target: "ws://livekit.example:\(livekit.port)", proxy: NetworkProxy(host: "127.0.0.1", port: proxy.port))
        defer { call.close() }
        let endpoint = try XCTUnwrap(URL(string: call.url))
        let sdk = try await SDKSocket(port: UInt16(endpoint.port!))
        let head = try await sdk.request("GET \(endpoint.path)/rtc/validate?access_token=token HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer token\r\n\r\n")
        XCTAssertTrue(head.hasPrefix("HTTP/1.1 401 "), head)
        let body = try await sdk.read(13)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "invalid token")
        XCTAssertEqual(livekit.asked.first, "GET /rtc/validate?access_token=token HTTP/1.1")
    }

    func testACallsEndpointRefusesWhatIsntTheSDKsHandshake() async throws {
        let proxy = try await FakeProxy.start(username: "", password: "")
        defer { proxy.stop() }
        let call = try await CallProxy.start(target: "wss://chat.example/livekit", proxy: NetworkProxy(host: "127.0.0.1", port: proxy.port))
        defer { call.close() }
        let endpoint = try XCTUnwrap(URL(string: call.url))
        let port = UInt16(endpoint.port!)
        func answer(_ request: String) async throws -> String {
            try await SDKSocket(port: port).request(request)
        }
        let posted = try await answer("POST \(endpoint.path)/rtc HTTP/1.1\r\n\r\n")
        XCTAssertTrue(posted.hasPrefix("HTTP/1.1 400 "), posted)
        let keyless = try await answer("GET \(endpoint.path)/rtc HTTP/1.1\r\nUpgrade: websocket\r\n\r\n")
        XCTAssertTrue(keyless.hasPrefix("HTTP/1.1 400 "), keyless)
        let unreadable = try await answer("GET \(endpoint.path)/rtc?join_request=CAU HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        XCTAssertTrue(unreadable.hasPrefix("HTTP/1.1 500 "), unreadable)
        let endless = try await answer("GET \(endpoint.path)/rtc HTTP/1.1\r\nX-Long: " + String(repeating: "a", count: 1 << 18))
        XCTAssertTrue(endless.hasPrefix("HTTP/1.1 431 "), endless)
        XCTAssertTrue(proxy.asked.isEmpty, "\(proxy.asked)")
    }

    func testACallsRelaysCarryMediaOverTCPThroughTheProxy() async throws {
        let proxy = try await FakeProxy.start(username: "", password: "")
        defer { proxy.stop() }
        let call = try await CallProxy.start(target: "wss://chat.example/livekit", proxy: NetworkProxy(host: "127.0.0.1", port: proxy.port))
        defer { call.close() }
        XCTAssertEqual(call.way, .unsure)
        let relay = try XCTUnwrap(call.relay(for: "TCP", address: "203.0.113.5", port: 7881))
        let media = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: relay.port)!, using: .tcp)
        try await Socks.ready(media, queue: DispatchQueue(label: "media"))
        try await Socks.send(Data("media".utf8), on: media)
        // This proxy echoes, so what went to the candidate comes back.
        let back = try await Socks.read(5, from: media)
        XCTAssertEqual(String(decoding: back, as: UTF8.self), "media")
        XCTAssertEqual(proxy.asked, ["203.0.113.5:7881"])
        XCTAssertEqual(call.way, .tcp)

        // Closed, the call ends its relays' connections and makes no more of them.
        call.close()
        do {
            _ = try await Socks.read(1, from: media)
            XCTFail("the relay's connection went on after the call closed")
        } catch {}
        XCTAssertNil(call.relay(for: "tcp", address: "203.0.113.6", port: 7881))
        media.cancel()
    }

    /// Waits up to five seconds for something to be so.
    private func eventually(_ what: String, _ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("\(what) never happened")
    }

    /// A protobuf message of one field, of bytes this long, of which nothing is read.
    private func message(field: Int, size: Int) -> Data {
        var out = varint(field << 3 | 2) + varint(size)
        out.append(Data(repeating: 0, count: size))
        return out
    }

    private func varint(_ value: Int) -> Data {
        var value = value, out = Data()
        while value >= 0x80 {
            out.append(UInt8(value & 0x7f) | 0x80)
            value >>= 7
        }
        out.append(UInt8(value))
        return out
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
        // A join request compressed some way the relay doesn't know isn't joined by: field 1, compression, is 5 here.
        guard case let .failure(unread) = relay.joinAddress("ws://127.0.0.1:7880/rtc?join_request=CAU") else { return XCTFail("an unreadable join went on") }
        XCTAssertFalse(unread.description.isEmpty)
    }

    /// A trickled candidate as LiveKit's Swift SDK decodes one (its `IceCandidate`), with
    /// `JSONDecoder`, which takes the first of a key said twice where the relay's `JSON.parse`
    /// takes the last.
    private struct TrickledCandidate: Decodable {
        let sdp: String
        let sdpMLineIndex: Int32
        let sdpMid: String?

        enum CodingKeys: String, CodingKey {
            case sdpMLineIndex, sdpMid
            case sdp = "candidate"
        }
    }

    func testACandidatesJsonIsWrittenAgainSoTheSdkReadsWhatTheRelayDid() throws {
        let relay = VoiceRelay.shared
        let outside = "candidate:1 1 udp 2130706431 203.0.113.66 3478 typ host"
        func rewritten(_ json: String) throws -> TrickledCandidate {
            let text = Data(json.utf8)
            let inner = Data([0x0a, UInt8(text.count)]) + text + Data([0x10, 0x01])
            let message = try relay.fromLiveKit(Data([0x22, UInt8(inner.count)]) + inner) { _, _, _ in ("127.0.0.1", 41000) }.get()
            XCTAssertFalse(String(decoding: message, as: UTF8.self).contains("203.0.113.66"), json)
            // The TrickleRequest's own JSON: after the two tags and lengths, up to its target.
            XCTAssertEqual(Array(message.suffix(2)), [0x10, 0x01])
            return try JSONDecoder().decode(TrickledCandidate.self, from: message.dropFirst(4).dropLast(2))
        }
        // As LiveKit wrote it, `JSONDecoder` reads a candidate here that the relay never saw.
        let twice = #"{"candidate":"\#(outside)","sdpMLineIndex":0,"sdpMid":"0","candidate":""}"#
        XCTAssertEqual(try JSONDecoder().decode(TrickledCandidate.self, from: Data(twice.utf8)).sdp, outside)
        let end = try rewritten(twice)
        XCTAssertEqual(end.sdp, "")
        XCTAssertEqual(end.sdpMLineIndex, 0)
        XCTAssertEqual(end.sdpMid, "0")
        // The other way round, the relay's candidate is the one that's read.
        let relayed = try rewritten(#"{"candidate":"","sdpMLineIndex":0,"sdpMid":"0","candidate":"\#(outside)"}"#)
        XCTAssertEqual(relayed.sdp, "candidate:1 1 udp 2130706431 127.0.0.1 41000 typ host")
    }

    func testWhatTheProxySaysIsToldInWords() {
        XCTAssertEqual(Socks.Failure.unreachable("It closed.").description, "Can't reach the proxy: It closed.")
        XCTAssertEqual(Socks.Failure.refused.errorDescription, "The proxy refused the username or password.")
        let codes: [UInt8: String] = [
            2: "The proxy doesn't allow that connection.", 3: "The proxy can't reach that network.", 4: "The proxy can't reach that server.",
            5: "That server refused the proxy's connection.", 6: "The proxy's connection timed out.", 7: "The proxy doesn't support that.",
            8: "The proxy doesn't support that type of address.", 1: "The proxy couldn't make the connection.",
        ]
        for (code, words) in codes {
            XCTAssertEqual(Socks.Failure.declined(code).description, words)
            // A refusal from past the proxy is no fault of the proxy's own.
            XCTAssertFalse(Socks.Failure.declined(code).atProxy)
        }
    }

    func testDatagramsFromAnyKindOfAddressAreRead() throws {
        let six = try XCTUnwrap(Socks.wrap(Data("v6".utf8), to: "[2001:db8::7]", port: 9))
        let fromSix = try XCTUnwrap(Socks.unwrap(six))
        XCTAssertEqual(fromSix.host, "2001:db8::7")
        XCTAssertEqual(fromSix.port, 9)
        XCTAssertEqual(fromSix.payload, Data("v6".utf8))
        let named = try XCTUnwrap(Socks.wrap(Data("hi".utf8), to: "relay.example", port: 3478))
        let fromName = try XCTUnwrap(Socks.unwrap(named))
        XCTAssertEqual(fromName.host, "relay.example")
        XCTAssertEqual(fromName.port, 3478)
        XCTAssertEqual(fromName.payload, Data("hi".utf8))
        // Cut short, or of a kind SOCKS5 doesn't have, it's nobody's.
        XCTAssertNil(Socks.unwrap(six.prefix(10)))
        XCTAssertNil(Socks.unwrap(named.prefix(6)))
        XCTAssertNil(Socks.unwrap(Data([0, 0, 0, 3])))
        XCTAssertNil(Socks.unwrap(Data([0, 0, 0, 9, 1, 2, 3, 4, 0, 1])))
    }

    func testConnectionsAndSessionsAreMadeToGoThroughTheProxy() {
        let proxy = NetworkProxy(host: "127.0.0.1", port: 1080, username: "zuna", password: "secret")
        let parameters = NWParameters.tcp
        NetworkProxy.apply(nil, to: parameters)
        NetworkProxy.apply(proxy, to: parameters)
        let configuration = URLSessionConfiguration.ephemeral
        NetworkProxy.apply(proxy, to: configuration)
        XCTAssertEqual(configuration.proxyConfigurations.count, 1)
        NetworkProxy.apply(nil, to: configuration)
        XCTAssertTrue(configuration.proxyConfigurations.isEmpty)

        // A session is made again once the proxy changes, from the same configuration.
        let base = URLSessionConfiguration.ephemeral
        let proxied = ProxiedSession(configuration: base)
        XCTAssertTrue(proxied.baseConfiguration === base)
        let before = proxied.session
        XCTAssertTrue(proxied.session === before)
        defer { NetworkProxy.use(nil) }
        XCTAssertTrue(NetworkProxy.use(proxy))
        XCTAssertFalse(NetworkProxy.use(proxy))
        XCTAssertFalse(proxied.session === before)
        XCTAssertEqual(proxied.session.configuration.proxyConfigurations.count, 1)
    }
}

/// A SOCKS5 proxy with a username and password, which answers CONNECT and echoes what it's sent,
/// or passes it on to a port on loopback for a name in `forward`, and refuses UDP associations.
private final class FakeProxy: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "fake-proxy")
    private let username: String
    private let password: String
    private let forward: [String: UInt16]
    private let lock = NSLock()
    private var requests: [String] = []
    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var asked: [String] { lock.withLock { requests } }

    private init(listener: NWListener, username: String, password: String, forward: [String: UInt16]) {
        self.listener = listener
        self.username = username
        self.password = password
        self.forward = forward
    }

    static func start(username: String, password: String, forward: [String: UInt16] = [:]) async throws -> FakeProxy {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let proxy = FakeProxy(listener: try NWListener(using: parameters), username: username, password: password, forward: forward)
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
                if let onward = forward[host] {
                    let server = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: onward)!, using: .tcp)
                    try await Socks.ready(server, queue: queue)
                    try await Socks.send(Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]), on: connection)
                    pipe(from: connection, to: server)
                    pipe(from: server, to: connection)
                    return
                }
                try await Socks.send(Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]), on: connection)
                while true {
                    try await Socks.send(try await Socks.read(1, from: connection), on: connection)
                }
            } catch {
                connection.cancel()
            }
        }
    }

    private func pipe(from source: NWConnection, to sink: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            if let data, !data.isEmpty { sink.send(content: data, completion: .idempotent) }
            if complete || error != nil {
                source.cancel()
                sink.cancel()
            } else {
                self?.pipe(from: source, to: sink)
            }
        }
    }
}

/// LiveKit's signalling, as far as a call's endpoint reaches it: a WebSocket server on loopback that
/// sends what it was given to once a socket opens, and keeps what comes and the headers it came with.
private final class FakeLiveKit: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "fake-livekit")
    private let greeting: [(text: Bool, data: Data)]
    private let headers: Locked<[String: String]>
    private let lock = NSLock()
    private var messages: [Data] = []
    private var ended = false
    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var received: [Data] { lock.withLock { messages } }
    var closed: Bool { lock.withLock { ended } }
    var authorization: String? { headers.value["authorization"] }

    private init(listener: NWListener, greeting: [(text: Bool, data: Data)], headers: Locked<[String: String]>) {
        self.listener = listener
        self.greeting = greeting
        self.headers = headers
    }

    static func start(greeting: [(text: Bool, data: Data)]) async throws -> FakeLiveKit {
        let headers = Locked<[String: String]>([:])
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.maximumMessageSize = 1 << 20
        options.setClientRequestHandler(DispatchQueue(label: "fake-livekit-request")) { _, additional in
            headers.value = Dictionary(additional.map { ($0.name.lowercased(), $0.value) }, uniquingKeysWith: { $1 })
            return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let server = FakeLiveKit(listener: try NWListener(using: parameters), greeting: greeting, headers: headers)
        server.listener.newConnectionHandler = { connection in server.serve(connection) }
        try await listen(server.listener, on: server.queue)
        return server
    }

    func stop() { listener.cancel() }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        for (text, data) in greeting {
            let context = NWConnection.ContentContext(identifier: "greeting", metadata: [NWProtocolWebSocket.Metadata(opcode: text ? .text : .binary)])
            connection.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
        }
        receive(on: connection)
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self, error == nil else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            switch metadata?.opcode {
            case .binary: lock.withLock { self.messages.append(content ?? Data()) }
            case .close: return lock.withLock { self.ended = true }
            default: break
            }
            receive(on: connection)
        }
    }
}

/// LiveKit refusing the SDK's token, as it answers the SDK asking why it couldn't connect: a
/// server on loopback that answers every request so, and keeps each request's first line.
private final class FakeRefusal: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "fake-refusal")
    private let lock = NSLock()
    private var requests: [String] = []
    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var asked: [String] { lock.withLock { requests } }

    private init(listener: NWListener) { self.listener = listener }

    static func start() async throws -> FakeRefusal {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let server = FakeRefusal(listener: try NWListener(using: parameters))
        server.listener.newConnectionHandler = { connection in server.serve(connection) }
        try await listen(server.listener, on: server.queue)
        return server
    }

    func stop() { listener.cancel() }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        Task {
            var head = Data()
            while !head.ends(with: "\r\n\r\n") {
                guard let byte = try? await Socks.read(1, from: connection) else { return connection.cancel() }
                head.append(byte)
            }
            let first = String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n")[0]
            lock.withLock { requests.append(first) }
            let answer = "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 13\r\nConnection: close\r\n\r\ninvalid token"
            try? await Socks.send(Data(answer.utf8), on: connection)
            connection.cancel()
        }
    }
}

/// The SDK's side of a call's socket, written out by hand so that each frame is as a test says:
/// a client's, so masked.
private final class SDKSocket: @unchecked Sendable {
    private let connection: NWConnection

    init(port: UInt16) async throws {
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        try await Socks.ready(connection, queue: DispatchQueue(label: "sdk-socket"))
    }

    deinit { connection.cancel() }

    /// Sends a request, and reads the head of what answers it.
    func request(_ request: String) async throws -> String {
        try await Socks.send(Data(request.utf8), on: connection)
        var head = Data()
        while !head.ends(with: "\r\n\r\n") {
            head.append(try await Socks.read(1, from: connection))
        }
        return String(decoding: head, as: UTF8.self)
    }

    func read(_ count: Int) async throws -> Data {
        try await Socks.read(count, from: connection)
    }

    func send(fin: Bool = true, opcode: UInt8, _ payload: Data) async throws {
        let mask: [UInt8] = [0x12, 0x34, 0x56, 0x78]
        var frame = Data([(fin ? 0x80 : 0) | opcode])
        if payload.count < 126 {
            frame.append(0x80 | UInt8(payload.count))
        } else if payload.count <= 0xffff {
            frame.append(contentsOf: [0x80 | 126, UInt8(payload.count >> 8), UInt8(payload.count & 0xff)])
        } else {
            frame.append(0x80 | 127)
            for shift in stride(from: 56, through: 0, by: -8) { frame.append(UInt8((UInt64(payload.count) >> UInt64(shift)) & 0xff)) }
        }
        frame.append(contentsOf: mask)
        frame.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset & 3] })
        try await Socks.send(frame, on: connection)
    }

    /// The next frame, as LiveKit's side sends it: whole, and not masked.
    func frame() async throws -> (opcode: UInt8, payload: Data) {
        let head = [UInt8](try await Socks.read(2, from: connection))
        var length = Int(head[1] & 0x7f)
        if length == 126 {
            let more = [UInt8](try await Socks.read(2, from: connection))
            length = Int(more[0]) << 8 | Int(more[1])
        } else if length == 127 {
            length = [UInt8](try await Socks.read(8, from: connection)).reduce(0) { $0 << 8 | Int($1) }
        }
        let payload = length > 0 ? try await Socks.read(length, from: connection) : Data()
        return (head[0] & 0x0f, payload)
    }
}

/// Starts a listener, once it's ready.
private func listen(_ listener: NWListener, on queue: DispatchQueue) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let once = Once()
        listener.stateUpdateHandler = { state in
            if case .ready = state { once.run { continuation.resume() } }
            if case let .failed(error) = state { once.run { continuation.resume(throwing: error) } }
        }
        listener.start(queue: queue)
    }
}

private extension Data {
    func ends(with text: String) -> Bool {
        let tail = Data(text.utf8)
        return count >= tail.count && suffix(tail.count) == tail
    }
}
