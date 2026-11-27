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

    // When a replaced epoch's slot is retired, as packages/core/test/small-parts.test.ts has it.

    private let start = ContinuousClock.now
    private func at(_ ms: Int) -> ContinuousClock.Instant { start + .milliseconds(ms) }
    private func pairs(_ due: [(index: Int32, epoch: Int)]) -> [[Int]] { due.map { [Int($0.index), $0.epoch] } }

    func testRetiresAReplacedSlotOnceAfterItsTimeAndNeverTheCurrentOne() {
        var slots = VoiceKeySlots()
        XCTAssertNil(slots.take(epoch: 5, now: at(0)).retireAt)
        let taken = slots.take(epoch: 6, now: at(1000))
        XCTAssertEqual(taken.index, 6)
        XCTAssertEqual(taken.retireAt, at(1000) + Voice.oldKeyKept)
        XCTAssertTrue(slots.due(now: at(999) + Voice.oldKeyKept).isEmpty)
        XCTAssertTrue(slots.holds(5, epoch: 5))
        XCTAssertEqual(pairs(slots.due(now: taken.retireAt!)), [[5, 5]])
        XCTAssertFalse(slots.holds(5, epoch: 5))
        XCTAssertTrue(slots.due(now: at(1_000_000)).isEmpty)
        XCTAssertTrue(slots.holds(6, epoch: 6))
        XCTAssertNil(slots.take(epoch: 6, now: at(2000)).retireAt)
    }

    func testRetiresEachOfSeveralQuickEpochsInTurn() {
        var slots = VoiceKeySlots()
        _ = slots.take(epoch: 1, now: at(0))
        _ = slots.take(epoch: 2, now: at(100))
        _ = slots.take(epoch: 3, now: at(200))
        XCTAssertTrue(slots.due(now: at(99) + Voice.oldKeyKept).isEmpty)
        XCTAssertEqual(pairs(slots.due(now: at(100) + Voice.oldKeyKept)), [[1, 1]])
        XCTAssertEqual(pairs(slots.due(now: at(200) + Voice.oldKeyKept)), [[2, 2]])
        // A device that skipped epochs retires the last it held.
        XCTAssertEqual(slots.take(epoch: 9, now: at(300)).retireAt, at(300) + Voice.oldKeyKept)
        XCTAssertEqual(pairs(slots.due(now: at(300) + Voice.oldKeyKept)), [[3, 3]])
    }

    func testLeavesASlotTheRingCameRoundTo() {
        let ring = Int(Voice.keyRing)
        var slots = VoiceKeySlots()
        // A whole ring's worth of joins and leaves within the time: epoch 0's slot is epoch 16's by then.
        for epoch in 0...ring { _ = slots.take(epoch: epoch, now: at(epoch)) }
        XCTAssertEqual(pairs(slots.due(now: at(ring) + Voice.oldKeyKept)), (1..<ring).map { [$0, $0] })
        XCTAssertTrue(slots.holds(0, epoch: ring))
        let next = slots.take(epoch: ring + 1, now: at(100))
        XCTAssertEqual(next.index, 1)
        XCTAssertEqual(pairs(slots.due(now: next.retireAt!)), [[0, ring]])
        // Straight from epoch 3 to 19, the same slot: nothing older is left in it to retire.
        var skipping = VoiceKeySlots()
        _ = skipping.take(epoch: 3, now: at(0))
        XCTAssertNil(skipping.take(epoch: 3 + ring, now: at(1)).retireAt)
        XCTAssertTrue(skipping.due(now: at(1_000_000)).isEmpty)
        XCTAssertTrue(skipping.holds(3, epoch: 3 + ring))
    }

    func testKeepsAnEpochAGroupWasTakenBackTo() {
        var slots = VoiceKeySlots()
        _ = slots.take(epoch: 4, now: at(0))
        _ = slots.take(epoch: 5, now: at(10))
        // A commit nobody could apply is undone, and the group is back at 4.
        XCTAssertEqual(slots.take(epoch: 4, now: at(20)).retireAt, at(20) + Voice.oldKeyKept)
        XCTAssertEqual(pairs(slots.due(now: at(1_000_000))), [[5, 5]])
        XCTAssertTrue(slots.holds(4, epoch: 4))
    }

    @MainActor
    func testTimersGoOffAtTheirTimeUnlessTheRoomIsLeft() async throws {
        var fired = 0
        let kept = VoiceKeyTimers()
        kept.at(.now + .milliseconds(150)) { fired += 1 }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(fired, 0)
        let left = VoiceKeyTimers()
        left.at(.now + .milliseconds(50)) { fired += 1 }
        left.stop()
        left.at(.now) { fired += 1 }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(fired, 1)
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

    func testSharesABigScreenWithinTheMostPixels() {
        // iPhone 17 Pro Max, held either way: two thirds, upright.
        XCTAssertTrue(Voice.shareSize(screenWidth: 1320, screenHeight: 2868, limit: 0) == (884, 1922))
        XCTAssertTrue(Voice.shareSize(screenWidth: 2868, screenHeight: 1320, limit: 0) == (884, 1922))
        // An iPhone SE's whole screen fits, and a 13-inch iPad's goes at a little over half.
        XCTAssertTrue(Voice.shareSize(screenWidth: 750, screenHeight: 1334, limit: 0) == (750, 1334))
        XCTAssertTrue(Voice.shareSize(screenWidth: 2064, screenHeight: 2752, limit: 0) == (1130, 1506))
        for (width, height) in [(1320, 2868), (1206, 2622), (1668, 2420), (2064, 2752)] {
            let share = Voice.shareSize(screenWidth: width, screenHeight: height, limit: 0)
            XCTAssertLessThanOrEqual(share.across * share.along, Voice.screenMaxPixels + 4000)
            XCTAssertTrue(share.across.isMultiple(of: 2) && share.along.isMultiple(of: 2))
        }
    }

    func testHoldsAShareToTheServersLimitAcrossItsShorterSide() {
        XCTAssertTrue(Voice.shareSize(screenWidth: 1320, screenHeight: 2868, limit: 720) == (720, 1564))
        // A limit above what fits changes nothing.
        XCTAssertTrue(Voice.shareSize(screenWidth: 1320, screenHeight: 2868, limit: 1080) == (884, 1922))
        XCTAssertTrue(Voice.shareSize(screenWidth: 750, screenHeight: 1334, limit: 1080) == (750, 1334))
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
