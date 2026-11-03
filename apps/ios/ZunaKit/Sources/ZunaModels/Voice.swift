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

/// What someone has chosen for their shares, with nil where they've left it to the server. Mirrors `ScreenChoices`.
public struct ScreenChoices: Equatable, Sendable {
    public var height: Int?
    public var fps: Int?
    public var kbps: Int?
    public var soundKbps: Int

    public init(height: Int? = nil, fps: Int? = nil, kbps: Int? = nil, soundKbps: Int = 128) {
        self.height = height
        self.fps = fps
        self.kbps = kbps
        self.soundKbps = soundKbps
    }
}

/// What a share will really use, once what someone chose has met what their server allows. Mirrors `ScreenTerms`.
public struct ScreenTerms: Equatable, Sendable {
    public enum Limit: String, Sendable { case height, fps, kbps, soundKbps }

    /// The tallest the picture may be, or 0 for the screen's own.
    public var height: Int
    public var fps: Int
    public var kbps: Int
    public var soundKbps: Int
    /// Sound may go with it.
    public var sound: Bool
    /// Which of those the server's limits brought down.
    public var held: [Limit]

    public init(height: Int, fps: Int, kbps: Int, soundKbps: Int, sound: Bool, held: [Limit]) {
        self.height = height
        self.fps = fps
        self.kbps = kbps
        self.soundKbps = soundKbps
        self.sound = sound
        self.held = held
    }
}

extension Voice {
    /// What a share uses: what someone chose, or what the server suggests, held to the server's limits
    /// unless it leaves admins out of them. As `screenTerms` in packages/core/src/voice.ts.
    public static func screenTerms(_ choices: ScreenChoices, rules: ScreenRules?, role: Role?) -> ScreenTerms {
        let rules = rules ?? .defaults
        let exempt = rules.adminsExempt && (role == .owner || role == .admin)
        var held: [ScreenTerms.Limit] = []
        func atMost(_ name: ScreenTerms.Limit, _ wanted: Int, _ limit: Int) -> Int {
            if exempt || limit <= 0 || wanted <= limit { return wanted }
            held.append(name)
            return limit
        }
        let wantedHeight = choices.height ?? rules.defaultHeight
        // The screen's own size could be any height, so it's only known to fit without a limit.
        var height = atMost(.height, wantedHeight, rules.maxHeight)
        if wantedHeight == 0, !exempt, rules.maxHeight > 0 {
            height = rules.maxHeight
            held.append(.height)
        }
        let fps = atMost(.fps, choices.fps ?? rules.defaultFps, rules.maxFps)
        let kbps = atMost(.kbps, choices.kbps ?? rules.defaultKbps, rules.maxKbps)
        let soundKbps = atMost(.soundKbps, choices.soundKbps, rules.maxSoundKbps)
        return ScreenTerms(height: height, fps: fps, kbps: kbps, soundKbps: soundKbps, sound: rules.sound, held: held)
    }

    /// Why someone can't share a screen at all right now, or nil if they may try. As `screenRefusal`.
    public static func screenRefusal(rules: ScreenRules?, role: Role?, channelLimit: Int = 0) -> String? {
        let rules = rules ?? .defaults
        if rules.who == "nobody" { return "Screen sharing is off on this server" }
        if rules.who == "admins", role != .owner, role != .admin { return "Only admins can share a screen on this server" }
        if channelLimit < 0 { return "Screen sharing is off in this voice channel" }
        return nil
    }
}
