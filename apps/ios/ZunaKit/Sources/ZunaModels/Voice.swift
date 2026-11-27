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

    /// How long a key goes on opening what others send once a newer epoch's has come (`VOICE_OLD_KEY_MS`).
    /// Someone who hears of the new epoch late, or is a few behind for a moment, sends under the old one
    /// meanwhile. After it, someone removed who kept the old one can't be played to the others, even
    /// with the media server's help.
    public static let oldKeyKept: Duration = .seconds(30)
}

/// Which epoch's key each slot of the key ring holds, and when one that's been replaced is retired,
/// as `VoiceKeySlots` in packages/core/src/voice.ts keeps them. An epoch's slot is given a random key
/// once, `Voice.oldKeyKept` after the epoch after it came, unless by then it holds another epoch's key,
/// as it does when the ring has gone round, or it's the current one.
public struct VoiceKeySlots: Sendable {
    public typealias Instant = ContinuousClock.Instant

    private struct Retiring: Sendable {
        var epoch: Int
        var at: Instant
    }

    /// The epoch whose key each slot holds.
    private var held: [Int32: Int] = [:]
    /// The slots to retire, with the epoch each held and when.
    private var retiring: [Int32: Retiring] = [:]
    private var current: Int?

    public init() {}

    /// The newest epoch's key goes in its slot, which takes it off any list to be retired, and the
    /// epoch it replaces starts its time. Says which slot, and when the replaced one is due, if it is.
    public mutating func take(epoch: Int, now: Instant) -> (index: Int32, retireAt: Instant?) {
        let index = Voice.keyIndex(epoch: epoch)
        let previous = current
        current = epoch
        retiring[index] = nil
        held[index] = epoch
        guard let previous, previous != epoch else { return (index, nil) }
        let old = Voice.keyIndex(epoch: previous)
        guard old != index, held[old] == previous else { return (index, nil) }
        let at = now + Voice.oldKeyKept
        retiring[old] = Retiring(epoch: previous, at: at)
        return (index, at)
    }

    /// The slots due by `now`, each to be given a random key: they hold nothing from here on.
    public mutating func due(now: Instant) -> [(index: Int32, epoch: Int)] {
        let currentIndex = current.map { Voice.keyIndex(epoch: $0) }
        var out: [(index: Int32, epoch: Int)] = []
        for (index, slot) in retiring.sorted(by: { $0.key < $1.key }) where slot.at <= now {
            retiring[index] = nil
            guard held[index] == slot.epoch, index != currentIndex else { continue }
            held[index] = nil
            out.append((index, slot.epoch))
        }
        return out
    }

    /// Whether a slot still holds an epoch's key, so that it may be set for someone.
    public func holds(_ index: Int32, epoch: Int) -> Bool {
        held[index] == epoch
    }
}

/// The timers retiring a room's key slots, which leaving the room stops, and which take no more after that.
@MainActor
public final class VoiceKeyTimers {
    private var running: [Int: Task<Void, Never>] = [:]
    private var next = 0
    private var stopped = false

    public init() {}

    /// Does `then` at `at`, unless stopped first.
    public func at(_ at: ContinuousClock.Instant, _ then: @escaping @MainActor () -> Void) {
        guard !stopped else { return }
        let id = next
        next += 1
        running[id] = Task { [weak self] in
            try? await Task.sleep(until: at, clock: .continuous)
            guard let self, !Task.isCancelled, !stopped else { return }
            running[id] = nil
            then()
        }
    }

    public func stop() {
        stopped = true
        for task in running.values { task.cancel() }
        running = [:]
    }
}

/// Who a participant in a room is. Mirrors `VoiceIdentity`.
public struct VoiceIdentity: Equatable, Sendable {
    public var userId: String
    public var deviceId: String

    public init(userId: String, deviceId: String) {
        self.userId = userId
        self.deviceId = deviceId
    }

    /// Who a participant is, or nil for a name that isn't ours to have let in.
    public init?(_ identity: String) {
        let parts = identity.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2, Self.isId(parts[0]), Self.isId(parts[1]) else { return nil }
        userId = parts[0]
        deviceId = parts[1]
    }

    private static func isId(_ text: String) -> Bool {
        text.utf8.count == 32 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

/// What someone has chosen for their shares. Mirrors `ScreenChoices`.
public struct ScreenChoices: Equatable, Sendable {
    /// The tallest the picture may be, or 0 for the screen's own.
    public var height: Int
    public var fps: Int
    /// The most it may send, or nil to leave it to the app.
    public var kbps: Int?

    public init(height: Int = 0, fps: Int = Voice.screenDefaultFps, kbps: Int? = nil) {
        self.height = height
        self.fps = fps
        self.kbps = kbps
    }
}

/// What a share will really use, once what someone chose has met what their server allows. Mirrors `ScreenTerms`.
public struct ScreenTerms: Equatable, Sendable {
    public enum Limit: String, Sendable { case height, fps, kbps }

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
    /// What a share sends, at most, when it's left to the app (`SCREEN_AUTO_KBPS`).
    public static let screenAutoKbps = 20_000
    /// A share's frame rate unless someone chooses another (`SCREEN_DEFAULT_FPS`).
    public static let screenDefaultFps = 60
    /// What a share's sound sends (`SCREEN_SOUND_KBPS`).
    public static let screenSoundKbps = 128
    /// The most pixels a share from a phone or an iPad goes out with: an iPhone 17 Pro Max's screen at about
    /// two thirds, 884×1922. At the few Mbit/s a phone's network is often estimated to take, a frame of its whole
    /// screen at 1320×2868 that moved after standing still came to dozens of frames' worth, and libwebrtc
    /// dropped the frames after it to make up: 16 fps went out of 60, where 38 do at this size, and 9 of an
    /// iPad's at 2064×2752 (docs/SCREEN_SHARE.md, "From an iPhone or iPad").
    public static let screenMaxPixels = 1_700_000

    /// The size a share of a screen goes out at, upright: the screen's own within `screenMaxPixels`, and its
    /// shorter side within `limit` when there is one, as the server's limit on a share's height holds a phone's
    /// width. Even on both sides, as the encoder takes it.
    public static func shareSize(screenWidth: Int, screenHeight: Int, limit: Int) -> (across: Int, along: Int) {
        let across = Double(min(screenWidth, screenHeight)), along = Double(max(screenWidth, screenHeight))
        guard across > 0 else { return (0, 0) }
        var scale = min(1, (Double(screenMaxPixels) / (across * along)).squareRoot())
        if limit > 0 { scale = min(scale, Double(limit) / across) }
        let even = { (side: Double) in Int((side * scale / 2).rounded()) * 2 }
        return (even(across), even(along))
    }

    /// What a share uses: what someone chose, held to the server's limits unless it leaves admins
    /// out of them, with the bitrate left to the app within them. As `screenTerms` in packages/core/src/voice.ts.
    public static func screenTerms(_ choices: ScreenChoices, rules: ScreenRules?, role: Role?) -> ScreenTerms {
        let rules = rules ?? .defaults
        let exempt = rules.adminsExempt && (role == .owner || role == .admin)
        var held: [ScreenTerms.Limit] = []
        func atMost(_ name: ScreenTerms.Limit, _ wanted: Int, _ limit: Int) -> Int {
            if exempt || limit <= 0 || wanted <= limit { return wanted }
            held.append(name)
            return limit
        }
        // The screen's own size could be any height, so it's only known to fit without a limit.
        var height = atMost(.height, choices.height, rules.maxHeight)
        if choices.height == 0, !exempt, rules.maxHeight > 0 {
            height = rules.maxHeight
            held.append(.height)
        }
        // Left to the app, it's whichever is lower, which nobody chose to go past.
        let limit = exempt ? 0 : rules.maxKbps
        let kbps = choices.kbps.map { atMost(.kbps, $0, rules.maxKbps) } ?? (limit > 0 ? min(limit, screenAutoKbps) : screenAutoKbps)
        let fps = atMost(.fps, choices.fps, rules.maxFps)
        return ScreenTerms(height: height, fps: fps, kbps: kbps, soundKbps: screenSoundKbps, sound: rules.sound, held: held)
    }

    /// Why someone can't share a screen at all right now, as a sentence, or nil if they may try. As `screenRefusal`.
    public static func screenRefusal(rules: ScreenRules?, role: Role?, channelLimit: Int = 0) -> String? {
        let rules = rules ?? .defaults
        if rules.who == "nobody" { return t("server.screenSharingIsOffOn") }
        if rules.who == "admins", role != .owner, role != .admin { return t("server.onlyAdminsCanShareA") }
        if channelLimit < 0 { return t("server.screenSharingIsOffIn") }
        return nil
    }
}
