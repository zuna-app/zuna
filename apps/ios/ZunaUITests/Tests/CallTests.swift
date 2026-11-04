import XCTest

/// Calls in direct messages and groups: a desktop peer ringing the phone, declined and answered,
/// the phone calling from a chat, and a group's call ringing again. Test builds leave CallKit
/// out, so the phone rings with its own card, as it does where CallKit isn't allowed. The desktop
/// peers have no media of their own, so they're in a call only as far as the server can tell.
/// What crosses between the phone and a real desktop app is checked by `npm run test:ios:voice`.
final class CallTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }
    private var aliceId: String { World.current["alice"].userId }
    private let here: [String: Any] = ["muted": false, "deafened": false, "camera": false, "screen": false]

    private func phoneDevice() throws -> String {
        let control = zuna.control!, serverId = zuna.serverId
        return try blocking {
            let me = try await control.call("getSelf", server: serverId) as? [String: Any]
            return me?["deviceId"] as? String ?? ""
        }
    }

    /// The call in a conversation, as a peer is told.
    private func call(_ peer: Peer, _ groupId: String) throws -> [String: Any]? {
        (try peer.call("getCalls") as? [[String: Any]] ?? []).first { $0["groupId"] as? String == groupId }
    }

    /// The devices in a conversation's call, as a peer is told.
    private func inCall(_ peer: Peer, _ groupId: String) throws -> [String] {
        (try peer.call("getVoiceMembers") as? [[String: Any]] ?? []).filter { $0["channelId"] as? String == groupId }.compactMap { $0["deviceId"] as? String }
    }

    private func signIn() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
    }

    func testRingsAndIsDeclinedOrAnswered() throws {
        let alice = try Peer("alice")
        try signIn()
        let dm = try XCTUnwrap(try alice.call("prepareCall", ["user:\(bobId)"]) as? String)
        try alice.call("setVoiceState", [dm, here, true])

        // It rings over the app, saying who.
        let card = zuna.element(A11y.Voice.incoming)
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        XCTAssertTrue(card.staticTexts["alice"].exists)
        XCTAssertTrue(card.staticTexts["Calling you"].exists)
        zuna.screenshot("97-incoming-call")

        // Declining stops it on every device, and alice hears.
        zuna.element(A11y.Voice.decline).tap()
        try waitFor("alice to hear bob declined") { try self.call(alice, dm)?["declined"] as? [String] == [self.bobId] }
        try waitFor("the card to go") { !card.exists }

        // Rung again, answering comes into the call, with its own call screen.
        try alice.call("ringCall", [dm])
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        zuna.element(A11y.Voice.answer).tap()
        XCTAssertTrue(zuna.element(A11y.Voice.stage).waitForExistence(timeout: 10))
        let device = try phoneDevice()
        try waitFor("alice to see bob in the call", timeout: 30) { try self.inCall(alice, dm).contains(device) }
        try waitFor("it to stop ringing") { try (self.call(alice, dm)?["ringing"] as? [String])?.isEmpty == true }
        XCTAssertTrue(zuna.element(A11y.Voice.encrypted).exists)
        XCTAssertFalse(card.exists)
        zuna.screenshot("98-call")

        // The other one hanging up ends a direct message's call.
        try alice.call("setVoiceState", [NSNull(), NSNull()])
        try waitFor("the call to close", timeout: 15) { !self.zuna.element(A11y.Voice.stage).exists && !self.zuna.element(A11y.Voice.bar).exists }
        try waitFor("the server to see bob gone") { try self.inCall(alice, dm).isEmpty }
    }

    func testCallsFromAChatAndEndsWhenDeclined() throws {
        let alice = try Peer("alice")
        try signIn()
        let row = zuna.element(A11y.ChatList.row("user:\(aliceId)"))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        // From the details, as Telegram's: the chat's bar has only the name and the picture.
        let details = zuna.element(A11y.Chat.menu)
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        details.tap()
        let callButton = zuna.element(A11y.Details.action("call"))
        XCTAssertTrue(callButton.waitForExistence(timeout: 10))
        callButton.tap()

        // Alice is rung, and shows on the call screen until she answers.
        XCTAssertTrue(zuna.element(A11y.Voice.stage).waitForExistence(timeout: 10))
        let dm = try XCTUnwrap(try alice.call("getConversations") as? [[String: Any]]).first { $0["key"] as? String == "user:\(bobId)" }?["groupId"] as? String ?? ""
        try waitFor("alice to be rung", timeout: 30) { try self.call(alice, dm)?["ringing"] as? [String] == [self.aliceId] }
        XCTAssertTrue(zuna.element(A11y.Voice.ringing(aliceId)).waitForExistence(timeout: 10))
        zuna.screenshot("99-calling")

        // Her declining ends it here, as a phone call does.
        try alice.call("declineCall", [dm])
        XCTAssertTrue(zuna.toast(startingWith: "alice declined the call").waitForExistence(timeout: 10))
        try waitFor("the call to close") { !self.zuna.element(A11y.Voice.stage).exists && !self.zuna.element(A11y.Voice.bar).exists }
    }

    /// A VoIP push wakes an app iOS had suspended, whose core went to sleep when it left the screen.
    /// The simulator has no PushKit, so the push is handed over as PushKit would, with the core asleep
    /// as it is out of sight; CallKit, which a pushed call goes to, is on for this.
    func testACallPushedWhileTheAppSleepsWakesItsCore() throws {
        let alice = try Peer("alice")
        try zuna.launch(systemCall: true)
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let control = zuna.control!
        try blocking { _ = try await control.host("background") }
        try waitFor("the core to go to sleep") { try self.zuna.connectionState() == "offline" }

        let dm = try XCTUnwrap(try alice.call("prepareCall", ["user:\(bobId)"]) as? String)
        try alice.call("setVoiceState", [dm, here, true])
        var startedAt = 0
        try waitFor("alice's call to start") {
            startedAt = try self.call(alice, dm)?["startedAt"] as? Int ?? 0
            return startedAt > 0
        }
        let started = startedAt
        let rung = try blocking { try await control.host("voipPush", ["channel": dm, "caller": self.aliceId, "startedAt": started]) as? String }
        XCTAssertEqual(rung, "rung")

        // The core catches up with the call, which can then be answered.
        try waitFor("the core to wake for the call", timeout: 30) { try self.zuna.connectionState() == "online" }
        do {
            try waitFor("the call to ring here", timeout: 20) {
                (try blocking { try await control.host("voiceIncoming") as? String ?? "" }).contains(dm)
            }
        } catch {
            XCTFail("Not ringing; alice's call is \(String(describing: try? self.call(alice, dm)))")
        }
        let answered = try blocking { try await control.host("voiceAnswer") as? String }
        XCTAssertEqual(answered, "connected")
        let device = try phoneDevice()
        try waitFor("alice to see bob in the call", timeout: 30) { try self.inCall(alice, dm).contains(device) }
        try alice.call("setVoiceState", [NSNull(), NSNull()])
        try waitFor("the server to see bob gone") { try self.inCall(alice, dm).isEmpty }
    }

    func testAGroupsCallCanBeJoinedAndRingsAgain() throws {
        let alice = try Peer("alice")
        let carol = try Peer("carol")
        try signIn()
        let weekend = try XCTUnwrap((try carol.call("getConversations") as? [[String: Any]] ?? []).first { $0["title"] as? String == "Weekend" }?["groupId"] as? String)
        try carol.call("setVoiceState", [weekend, here, true])
        let card = zuna.element(A11y.Voice.incoming)
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        XCTAssertTrue(card.staticTexts["carol started a call"].exists)

        // Alice declines on her side, which leaves the phone ringing; answering here shows she isn't in it.
        try alice.call("declineCall", [weekend])
        try waitFor("alice to be out of the ringing") { try !(self.call(carol, weekend)?["ringing"] as? [String] ?? []).contains(self.aliceId) }
        XCTAssertTrue(card.exists)
        zuna.element(A11y.Voice.answer).tap()
        XCTAssertTrue(zuna.element(A11y.Voice.stage).waitForExistence(timeout: 10))
        let device = try phoneDevice()
        try waitFor("carol to see bob in the call", timeout: 30) { try self.inCall(carol, weekend).contains(device) }

        // Someone who isn't there can be rung again from inside the call.
        let ringAgain = zuna.element(A11y.Voice.ringAgain)
        XCTAssertTrue(ringAgain.waitForExistence(timeout: 10))
        ringAgain.tap()
        try waitFor("alice to be rung again") { try (self.call(carol, weekend)?["ringing"] as? [String] ?? []).contains(self.aliceId) }
        XCTAssertTrue(zuna.element(A11y.Voice.ringing(aliceId)).waitForExistence(timeout: 10))

        // Leaving a group's call leaves it going for the others, which its chat, opened on answering, shows.
        zuna.element(A11y.Voice.leave).tap()
        try waitFor("the server to see bob gone") { try !self.inCall(carol, weekend).contains(device) }
        XCTAssertTrue(zuna.element(A11y.Chat.callBanner).waitForExistence(timeout: 10))
        zuna.screenshot("99b-call-going-on")
        try carol.call("setVoiceState", [NSNull(), NSNull()])
        try waitFor("the banner to go") { !self.zuna.element(A11y.Chat.callBanner).exists }
    }
}
