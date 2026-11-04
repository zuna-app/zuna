import Foundation
import XCTest
@testable import ZunaHost
@testable import ZunaModels

/// The Swift RPC client against the real core bundle, in this process.
final class CoreConnectionTests: XCTestCase {
    private var directory: URL!
    private var runtime: CoreRuntime!
    private var connection: CoreConnection!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        runtime = try CoreRuntime(options: .init(dataDirectory: directory, deviceKey: Data(repeating: 7, count: 32), deviceName: "Test"))
        try await runtime.start()
        connection = CoreConnection(runtime: runtime) { _ in }
    }

    override func tearDown() async throws {
        connection = nil
        try? FileManager.default.removeItem(at: directory)
    }

    func testCallsTheClientAndDecodesResults() async throws {
        let servers = try await connection.listServers()
        XCTAssertEqual(servers, [])
        try await connection.suspend()
        try await connection.resume()
        XCTAssertEqual(connection.driftReports, [])
    }

    func testPassesOnTheCoresErrors() async throws {
        do {
            _ = try await connection.previewInvite("not a link at all")
            XCTFail("expected an error")
        } catch let error as CoreCallError {
            XCTAssertEqual(error.message, "That doesn't look like a Zuna invite link.")
        }
    }

    func testCallsFromSeveralTasksGetTheirOwnReplies() async throws {
        let connection = connection!
        try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<20 { group.addTask { try await connection.listServers().count } }
            for try await count in group { XCTAssertEqual(count, 0) }
        }
    }
}

final class DriftTests: XCTestCase {
    func testFindsFieldsTheModelsDontHave() throws {
        let json = #"""
        {"id":"m1","groupId":"g1","seq":3,"senderId":"u1","createdAt":1,"editedAt":null,"deletedAt":null,"pinnedAt":null,
         "pinnedBy":null,"status":"sent","text":"hi","emotes":{"KEKW":{"id":"e1","animated":true}},"attachments":[],"mentions":[],
         "reply":null,"reactions":[{"key":"👍","userIds":["u2"],"brandNew":1}],"system":null,"forwardedFrom":"u3"}
        """#
        let data = Data(json.utf8)
        let message = try CoreConnection.decoder.decode(MessageView.self, from: data)
        XCTAssertEqual(message.emotes["KEKW"]?.animated, true)
        XCTAssertEqual(Set(Drift.missing(in: data, decodedAs: message)), ["forwardedFrom", "reactions[].brandNew"])
    }

    func testReadsTheSoundboardWholly() throws {
        let sound = Data(#"{"id":"s1","name":"Airhorn","emoji":"📯","durationMs":1010}"#.utf8)
        let decoded = try CoreConnection.decoder.decode(SoundView.self, from: sound)
        XCTAssertEqual(decoded, SoundView(id: "s1", name: "Airhorn", emoji: "📯", durationMs: 1010))
        XCTAssertEqual(Drift.missing(in: sound, decodedAs: decoded), [])

        let played = Data(#"{"type":"sound","serverId":"x","channelId":"c2","userId":"u1","soundId":"s1"}"#.utf8)
        let event = try CoreConnection.decoder.decode(CoreEvent.self, from: played)
        XCTAssertEqual(event, .sound(serverId: "x", channelId: "c2", userId: "u1", soundId: "s1"))
        XCTAssertEqual(try CoreConnection.decoder.decode(CoreEvent.self, from: JSONEncoder().encode(event)), event)
        XCTAssertEqual(try CoreConnection.decoder.decode(CoreEvent.self, from: Data(#"{"type":"sounds","serverId":"x"}"#.utf8)), .sounds(serverId: "x"))
    }

    func testReadsChannelsAndWhoIsInThemWholly() throws {
        let channel = Data(#"""
        {"id":"c1","type":"text","key":"group:c1","name":"general","topic":"Anything goes","category":"","bitrate":0,"position":0,
         "userLimit":0,"screenLimit":0,"sounds":true,"unreadable":false,"conversation":null}
        """#.utf8)
        let decoded = try CoreConnection.decoder.decode(ChannelView.self, from: channel)
        XCTAssertEqual(decoded.key, "group:c1")
        XCTAssertTrue(decoded.sounds)
        XCTAssertNil(decoded.conversation)
        XCTAssertEqual(Drift.missing(in: channel, decodedAs: decoded), [])

        let joined = Data(#"""
        {"type":"voice","serverId":"s1","channelId":"c2","userId":"u1","deviceId":"d1",
         "member":{"channelId":"c2","userId":"u1","deviceId":"d1","muted":true,"deafened":false,"serverMuted":false,"camera":false,"screen":true,"since":5}}
        """#.utf8)
        let event = try CoreConnection.decoder.decode(CoreEvent.self, from: joined)
        guard case let .voice(_, channelId, _, _, member) = event else { return XCTFail("not a voice event: \(event)") }
        XCTAssertEqual(channelId, "c2")
        XCTAssertEqual(member?.screen, true)
        XCTAssertEqual(Drift.missing(in: joined, decodedAs: event), [])

        let left = Data(#"{"type":"voice","serverId":"s1","channelId":"c2","userId":"u1","deviceId":"d1","member":null}"#.utf8)
        guard case let .voice(_, _, _, _, gone) = try CoreConnection.decoder.decode(CoreEvent.self, from: left) else { return XCTFail("not a voice event") }
        XCTAssertNil(gone)
        XCTAssertEqual(try CoreConnection.decoder.decode(CoreEvent.self, from: Data(#"{"type":"channels","serverId":"s1"}"#.utf8)), .channels(serverId: "s1"))
    }

    func testReadsCallsWholly() throws {
        let ringing = Data(#"""
        {"type":"call","serverId":"s1","groupId":"g1","call":{"groupId":"g1","startedBy":"u1","startedAt":5,"ringing":["u2"],"declined":[]}}
        """#.utf8)
        let event = try CoreConnection.decoder.decode(CoreEvent.self, from: ringing)
        guard case let .call(_, groupId, call) = event else { return XCTFail("not a call event: \(event)") }
        XCTAssertEqual(groupId, "g1")
        XCTAssertEqual(call, CallView(groupId: "g1", startedBy: "u1", startedAt: 5, ringing: ["u2"], declined: []))
        XCTAssertEqual(Drift.missing(in: ringing, decodedAs: event), [])

        let ended = Data(#"{"type":"call","serverId":"s1","groupId":"g1","call":null}"#.utf8)
        XCTAssertEqual(try CoreConnection.decoder.decode(CoreEvent.self, from: ended), .call(serverId: "s1", groupId: "g1", call: nil))
        XCTAssertEqual(try CoreConnection.decoder.decode(CoreEvent.self, from: Data(#"{"type":"calls","serverId":"s1"}"#.utf8)), .calls(serverId: "s1"))
    }

    func testCarriesBytesAndFilesTagged() throws {
        let encoded = String(decoding: try CoreConnection.encoder.encode([Data([1, 2, 3])]), as: UTF8.self)
        XCTAssertEqual(encoded, #"[{"$bytes":"AQID"}]"#)
        let file = try CoreConnection.decoder.decode(WireFile.self, from: Data(#"{"$file":{"path":"/tmp/a.jpg","type":"image/jpeg"}}"#.utf8))
        XCTAssertEqual(file, WireFile(path: "/tmp/a.jpg", type: "image/jpeg"))
    }
}
