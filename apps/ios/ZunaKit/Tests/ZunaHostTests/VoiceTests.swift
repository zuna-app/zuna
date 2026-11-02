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
        XCTAssertEqual(hex(Voice.senderKey(roomKey: roomKey, identity: "\(device).screen")), "8f97c41be6f15a9bf2d33b211acadcf2ddabcaedb3f805e81896d05462275ba3")
    }

    func testPutsEachEpochInTheDesktopsSlot() {
        XCTAssertEqual(Voice.keyIndex(epoch: 0), 0)
        XCTAssertEqual(Voice.keyIndex(epoch: 37), 5)
    }

    func testOnlyTakesIdentitiesTheServerWouldGive() {
        XCTAssertEqual(VoiceIdentity(device), VoiceIdentity(userId: "0123456789abcdef0123456789abcdef", deviceId: "fedcba9876543210fedcba9876543210", screen: false))
        XCTAssertEqual(VoiceIdentity("\(device).screen")?.screen, true)
        for wrong in ["", "\(device).x", "\(device).screen.more", "0123456789ABCDEF0123456789ABCDEF.fedcba9876543210fedcba9876543210", "agent-123", "\(device)."] {
            XCTAssertNil(VoiceIdentity(wrong), wrong)
        }
    }

    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
