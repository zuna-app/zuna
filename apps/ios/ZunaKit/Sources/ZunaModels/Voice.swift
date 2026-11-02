import CryptoKit
import Foundation

// How voice channels are keyed, as packages/core/src/voice.ts has it. A room's media
// key comes from the channel's MLS group through the core (`voiceKey`), and each
// sender's media is under a key of its own, derived from it and from who they are in
// the room, so the media server can't pass one person's voice off as another's.

public enum Voice {
    /// How many keys each sender's frames can be under at once, as LiveKit keeps them.
    public static let keyRing: Int32 = 16

    /// Who a device is in a room. It says nothing but IDs: names are in a profile only members can read.
    public static func identity(userId: String, deviceId: String) -> String { "\(userId).\(deviceId)" }

    /// The key one sender's media is under, from the room's key for an epoch.
    public static func senderKey(roomKey: Data, identity: String) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: roomKey),
            salt: Data(),
            info: Data("zuna/voice/sender/v1|\(identity)".utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    /// Which of a sender's key slots an epoch's key goes in. A few epochs go by before one is reused.
    public static func keyIndex(epoch: Int) -> Int32 { Int32(epoch % Int(keyRing)) }
}

/// Who a participant in a room is. Mirrors `VoiceIdentity`.
public struct VoiceIdentity: Equatable, Sendable {
    public var userId: String
    public var deviceId: String
    /// The native process sharing that device's screen, as a participant of its own.
    public var screen: Bool

    public init(userId: String, deviceId: String, screen: Bool) {
        self.userId = userId
        self.deviceId = deviceId
        self.screen = screen
    }

    /// Who a participant is, or nil for a name that isn't ours to have let in.
    public init?(_ identity: String) {
        let parts = identity.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 || parts.count == 3, Self.isId(parts[0]), Self.isId(parts[1]) else { return nil }
        if parts.count == 3, parts[2] != "screen" { return nil }
        userId = parts[0]
        deviceId = parts[1]
        screen = parts.count == 3
    }

    private static func isId(_ text: String) -> Bool {
        text.utf8.count == 32 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}
