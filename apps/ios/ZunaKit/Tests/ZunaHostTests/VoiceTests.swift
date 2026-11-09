import XCTest
import ZunaModels

/// Voice channels must key their media exactly as the desktop and the web do, or
/// nobody hears anyone across them. Expected values come from running
/// `packages/core/src/voice.ts` in Node.
final class VoiceTests: XCTestCase {
    private let roomKey = Data((0..<32).map { UInt8($0) })
    private let device = "0123456789abcdef0123456789abcdef.fedcba9876543210fedcba9876543210"

    func testDerivesSenderKeysLikeTheDesktop() {
        XCTAssertEqual(hex(Voice.senderKey(roomKey: roomKey, identity: device)), "9d7aad69aa4a4cddac863597155db1a6b4a8eb79b6b1c40244d5919d0ed3e5cc")
    }

    func testPutsEachEpochInTheDesktopsSlot() {
        XCTAssertEqual(Voice.keyIndex(epoch: 0), 0)
        XCTAssertEqual(Voice.keyIndex(epoch: 37), 5)
    }

    func testOnlyTakesIdentitiesTheServerWouldGive() {
        XCTAssertEqual(VoiceIdentity(device), VoiceIdentity(userId: "0123456789abcdef0123456789abcdef", deviceId: "fedcba9876543210fedcba9876543210"))
        for wrong in ["", "\(device).x", "\(device).screen", "\(device).screen.more", "0123456789ABCDEF0123456789ABCDEF.fedcba9876543210fedcba9876543210", "agent-123", "\(device)."] {
            XCTAssertNil(VoiceIdentity(wrong), wrong)
        }
    }

    // What a share uses, as packages/core/test/channels.test.ts has it.

    private let automatic = ScreenChoices()
    private var limits: ScreenRules {
        var rules = ScreenRules.defaults
        rules.maxHeight = 1080
        rules.maxFps = 30
        rules.maxKbps = 8000
        return rules
    }

    func testLeavesTheBitrateToTheAppWithinTheLimit() {
        XCTAssertEqual(Voice.screenTerms(automatic, rules: nil, role: .member), ScreenTerms(height: 0, fps: 60, kbps: 20_000, soundKbps: 128, sound: true, held: []))
        XCTAssertEqual(Voice.screenTerms(automatic, rules: limits, role: .member).kbps, 8000)
        var high = ScreenRules.defaults
        high.maxKbps = 50_000
        XCTAssertEqual(Voice.screenTerms(automatic, rules: high, role: .member).kbps, 20_000)
    }

    func testSharesWithWhatSomeoneChoseAsFarAsTheLimitsAllow() {
        let under = Voice.screenTerms(ScreenChoices(height: 480, fps: 15, kbps: 2000), rules: limits, role: .member)
        XCTAssertEqual([under.height, under.fps, under.kbps, under.soundKbps], [480, 15, 2000, 128])
        XCTAssertEqual(under.held, [])
        let over = Voice.screenTerms(ScreenChoices(height: 2160, fps: 144, kbps: 50_000), rules: limits, role: .member)
        XCTAssertEqual([over.height, over.fps, over.kbps], [1080, 30, 8000])
        XCTAssertEqual(Set(over.held), [.height, .fps, .kbps])
    }

    func testCountsTheScreensOwnSizeAsOverALimitOnSize() {
        let own = ScreenChoices(height: 0)
        let held = Voice.screenTerms(own, rules: limits, role: .member)
        XCTAssertEqual(held.height, 1080)
        XCTAssertTrue(held.held.contains(.height))
        XCTAssertEqual(Voice.screenTerms(own, rules: nil, role: .member).height, 0)
        XCTAssertEqual(Voice.screenTerms(own, rules: nil, role: .member).held, [])
    }

    func testLeavesAdminsOutOfTheLimitsOnlyIfTheServerSaysSo() {
        let wanted = ScreenChoices(height: 0, fps: 144, kbps: 50_000)
        XCTAssertEqual(Voice.screenTerms(wanted, rules: limits, role: .admin).held.count, 3)
        var exempt = limits
        exempt.adminsExempt = true
        XCTAssertEqual(Voice.screenTerms(wanted, rules: exempt, role: .owner), ScreenTerms(height: 0, fps: 144, kbps: 50_000, soundKbps: 128, sound: true, held: []))
        XCTAssertEqual(Voice.screenTerms(automatic, rules: exempt, role: .admin).kbps, 20_000)
        XCTAssertEqual(Voice.screenTerms(wanted, rules: exempt, role: .member).held.count, 3)
    }

    func testSaysWhySomeoneCantShareAtAll() {
        XCTAssertNil(Voice.screenRefusal(rules: nil, role: .member))
        var off = ScreenRules.defaults
        off.who = "nobody"
        off.adminsExempt = true
        XCTAssertTrue(Voice.screenRefusal(rules: off, role: .owner)?.contains("off on this server") == true)
        var admins = ScreenRules.defaults
        admins.who = "admins"
        XCTAssertTrue(Voice.screenRefusal(rules: admins, role: .member)?.contains("Only admins") == true)
        XCTAssertNil(Voice.screenRefusal(rules: admins, role: .admin))
        XCTAssertTrue(Voice.screenRefusal(rules: nil, role: .owner, channelLimit: -1)?.contains("off in this voice channel") == true)
        XCTAssertNil(Voice.screenRefusal(rules: nil, role: .member, channelLimit: 2))
    }

    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
