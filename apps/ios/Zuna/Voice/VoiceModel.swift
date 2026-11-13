import AVFoundation
import CallKit
import Combine
import Foundation
import LiveKit
import Observation
import UIKit
import UserNotifications
import ZunaModels

/// How this device does voice. These stay on this device, as on the desktop
/// (packages/ui/src/voice/settings.ts), which has many more for its microphone
/// and its shares.
struct VoiceSettings: Codable, Equatable, Sendable {
    /// Sounds for people coming and going, and for muting.
    var sounds = true
    /// Whether to come in muted.
    var startMuted = false
    /// How loud others' shares are, from 0 to 2.
    var screenVolume = 1.0
    /// A screen someone starts sharing fills the stage.
    var screenFocus = true
    /// The most this device's shares may send, in kbit/s, or nil to leave it to the app.
    var screenBitrate: Int?
    /// How loud sounds from the soundboard are, from 0 to 1. At 0 none of them plays.
    var soundboardVolume = 0.6

    private static let key = "zuna-voice-settings"

    static func load() -> VoiceSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let settings = try? JSONDecoder().decode(VoiceSettings.self, from: data) else { return VoiceSettings() }
        return settings
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }

    /// How loud each person is for this device, by user.
    static var volumes: [String: Double] {
        get { (UserDefaults.standard.dictionary(forKey: volumesKey) as? [String: Double]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: volumesKey) }
    }

    /// How loud each person's shared screen is for this device, by user.
    static var streamVolumes: [String: Double] {
        get { (UserDefaults.standard.dictionary(forKey: streamVolumesKey) as? [String: Double]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: streamVolumesKey) }
    }

    private static let volumesKey = "zuna-voice-volumes"
    private static let streamVolumesKey = "zuna-voice-stream-volumes"

    #if DEBUG
    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: volumesKey)
        UserDefaults.standard.removeObject(forKey: streamVolumesKey)
    }
    #endif
}

/// A call ringing this person, which this device could answer.
struct IncomingCall: Identifiable, Equatable {
    let serverId: String
    let groupId: String
    let startedAt: Int
    let startedBy: String
    let key: String
    let title: String
    let kind: GroupKind
    /// The conversation is muted, so it rings without a sound.
    let quiet: Bool

    var id: String { "\(serverId)|\(groupId)|\(startedAt)" }
    /// What the system knows it by.
    var systemId: UUID { SystemCall.callId(serverId: serverId, groupId: groupId, startedAt: startedAt) }
}

/// A room this person asked to come into here, while another of their devices is in one on its server.
struct VoiceMove: Equatable {
    let serverId: String
    let channelId: String
    let ring: Bool
    let camera: Bool
    /// The room the other device is in.
    let from: String
}

/// The voice channel or call this device is in, wherever in the app the person is looking.
/// There's one at a time, across all servers, as in Discord. A call is a direct message's or a
/// group's, in a room of its own under the conversation's group, and works as a voice channel
/// does. The iPhone's counterpart of the desktop's packages/ui/src/voice/store.ts.
@MainActor
@Observable
final class VoiceModel {
    enum Status: Equatable { case idle, connecting, connected, reconnecting }

    private(set) var status: Status = .idle {
        didSet { CallAudio.active = status != .idle }
    }
    private(set) var serverId: String?
    /// The voice channel, or the group of the conversation whose call it is.
    private(set) var channelId: String?
    /// It's a conversation's call rather than a voice channel.
    private(set) var isCall = false
    /// Calls ringing this person that this device could answer.
    private(set) var incoming: [IncomingCall] = []
    /// Whether calls coming in ring through the system here, once that's known. Where they don't, the app rings by itself.
    private(set) var systemRings: Bool?
    /// Muted by the person.
    private(set) var muted: Bool
    private(set) var deafened = false
    /// Muted by an admin, which only an admin can undo.
    private(set) var serverMuted = false
    /// No microphone could be used, so this device can only listen.
    private(set) var noMic = false
    /// Who's being heard right now, by user.
    private(set) var speaking: Set<String> = []
    private(set) var videos: [CallVideo] = []
    private(set) var quality: ConnectionQuality = .unknown
    private(set) var camera = false {
        didSet { holdAwake() }
    }
    private(set) var cameraFront = true
    /// This device's screen is going out.
    private(set) var screen = false {
        didSet { holdAwake() }
    }
    /// Sharing has been asked for, and waits on the server or the system's picker.
    private(set) var screenStarting = false
    /// What this device's share goes out with, once it's going.
    private(set) var screenTerms: ScreenTerms?
    /// The video filling the stage, by its key.
    var focus: String?
    /// The call fills the screen, rather than waiting in the bar at the top.
    var stageShown = false
    var settings = VoiceSettings.load() {
        didSet {
            settings.save()
            applyVolumes()
        }
    }
    /// How loud each person is for this device, by user.
    private(set) var volumes = VoiceSettings.volumes
    /// How loud each person's shared screen is for this device, by user.
    private(set) var streamVolumes = VoiceSettings.streamVolumes
    /// People muted for this device only.
    private(set) var localMutes: Set<String> = []
    /// Who's playing a sound from the soundboard right now, by user, with what to show for it.
    private(set) var sounding: [String: String] = [:]
    /// What keys the call's media is under, for its details.
    private(set) var keyEpoch: Int?
    /// Coming into a room that waits for the person's word, as it takes another of their devices out of voice.
    var moving: VoiceMove?
    /// What the room watches together, as the core holds it, or nil when nothing's on.
    private(set) var watch: WatchView?
    /// The session this device's person pressed Watch for, which plays here until it ends or they stop it.
    private(set) var watching: String?
    /// This device may contact YouTube to play what a room watches, which its person agreed to once. Kept apart
    /// from the other settings, as on the web (`playYouTube` in packages/ui/src/state/settings.ts).
    var playYouTube = UserDefaults.standard.bool(forKey: VoiceModel.playYouTubeKey) {
        didSet { UserDefaults.standard.set(playYouTube, forKey: Self.playYouTubeKey) }
    }
    /// A video watched together is silent here. A page can't set a video's volume on a phone, so there's only this.
    var watchMuted = UserDefaults.standard.bool(forKey: VoiceModel.watchMutedKey) {
        didSet { UserDefaults.standard.set(watchMuted, forKey: Self.watchMutedKey) }
    }
    /// What fills the stage when it's the video watched together, among the videos' keys.
    nonisolated static let watchFocus = "watch"
    private static let playYouTubeKey = "zuna-play-youtube"
    private static let watchMutedKey = "zuna-watch-muted"

    /// Called when the call ends, or one stops ringing here, so the app can let go of what it kept running for it in the background.
    @ObservationIgnored var onEnded: (() -> Void)?
    /// Called when a VoIP push says a call is ringing: iOS woke the app for it, and its core may be asleep.
    @ObservationIgnored var onPushed: (() -> Void)?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var room: VoiceRoom?
    /// Each join counts, so one that takes a while can tell it's been replaced.
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var reconnects = 0
    @ObservationIgnored private let sounds = VoiceSounds()
    /// Sounds from the soundboard once fetched, by server and sound.
    @ObservationIgnored private var soundFiles: [String: Data] = [:]
    /// What's playing from the soundboard, held until it ends.
    @ObservationIgnored private var soundPlayers: [AVAudioPlayer] = []
    @ObservationIgnored private var soundingEnds: [String: Task<Void, Never>] = [:]
    /// Seeks go four a second at most, however fast someone drags.
    @ObservationIgnored private var seekSentAt = Date.distantPast
    @ObservationIgnored private var seekLater: Task<Void, Never>?
    /// The call as the system shows it, on the lock screen and in its call controls.
    @ObservationIgnored private let systemCall = SystemCall()
    /// How loud a share was before being silenced here, to go back to.
    @ObservationIgnored private var streamVolumeBefore: [String: Double] = [:]
    /// Each share asked for counts, so one that takes a while can tell it's been stopped.
    @ObservationIgnored private var shareAttempt = 0
    /// When this device's share last went away by itself. The server stopping one takes it out of the room before it says why.
    @ObservationIgnored private var shareVanishedAt: Date?
    @ObservationIgnored private var broadcastWatch: AnyCancellable?
    /// This device still has to say it's starting the call it's in, which rings everyone else.
    @ObservationIgnored private var ringOnAnnounce = false
    /// The camera goes on once in.
    @ObservationIgnored private var cameraOnJoin = false
    /// The call this device is in has rung someone, so that nobody being rung any more means something.
    @ObservationIgnored private var callRang = false
    @ObservationIgnored private var hangUp: Task<Void, Never>?
    /// The calls ringing here, by ID, to tell which stopped.
    @ObservationIgnored private var rung: [String: IncomingCall] = [:]
    /// VoIP pushes, which wake the app while Zuna isn't running to ring through CallKit.
    @ObservationIgnored private let callPushes = CallPushes()
    /// Calls a VoIP push rang for, by the system's ID, until the app has heard of them itself.
    @ObservationIgnored private var pushed: [UUID: PushStore.Message] = [:]
    /// A pushed call answered before the app had heard of it, to come into once it has.
    @ObservationIgnored private var pendingAnswer: UUID?
    /// Servers whose calls the app has caught up on since it started, so a pushed call it doesn't know of is over.
    @ObservationIgnored private var callsKnown: Set<String> = []
    /// The VoIP token, for the push relay, once PushKit has one.
    @ObservationIgnored var onCallPushToken: ((String?) -> Void)?

    private static let reconnectAttempts = 3
    private static let reconnectWait: Duration = .seconds(2)

    init() {
        muted = VoiceSettings.load().startMuted
        // A broadcast only goes out once the server has made room for it, never as soon as it starts.
        BroadcastManager.shared.shouldPublishTrack = false
        broadcastWatch = BroadcastManager.shared.isBroadcastingPublisher
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] on in
                MainActor.assumeIsolated { self?.broadcastChanged(on) }
            }
    }

    func attach(_ app: AppModel) {
        self.app = app
    }

    /// Takes VoIP pushes from the moment the app launches, before the core has started and while the app
    /// waits to be unlocked after the phone restarted: iOS ends an app that doesn't hand each one to CallKit
    /// at once, and stops waking one that keeps failing to. One that comes before the app has caught up rings
    /// as `rangByPush` says, and is let go after a minute if the app never does.
    func listenForCalls() {
        callPushes.onToken = { [weak self] token in self?.callPushTokenChanged(token) }
        callPushes.onRing = { [weak self] push in self?.rangByPush(push) }
        if SystemCall.mayBeAllowed { callPushes.start() }
    }

    /// The VoIP token, for the push relay, once PushKit has given one, and only where CallKit is allowed.
    @ObservationIgnored private(set) var callPushToken: String?

    /// A VoIP push has to ring through CallKit, so the relay gets no token where CallKit is left out, which
    /// the App Store's country tells, once it's been looked up.
    private func callPushTokenChanged(_ token: String?) {
        Task {
            let allowed = await systemCall.allowed()
            // A newer one came meanwhile.
            guard callPushes.token == token else { return }
            callPushToken = allowed ? token : nil
            onCallPushToken?(callPushToken)
        }
    }

    var inCall: Bool { status != .idle }

    /// In a call, or one is ringing here: the core stays connected while the app is out of sight.
    var keepsCoreAwake: Bool { inCall || !rung.isEmpty || !pushed.isEmpty }

    /// Sound is going out from here, as far as this device can tell.
    var micOff: Bool { muted || deafened || serverMuted || noMic }

    private func sound(_ name: VoiceSounds.Sound) {
        if settings.sounds { sounds.play(name) }
    }

    private var session: SessionCalls? {
        serverId.flatMap { app?.core.session($0) }
    }

    /// Tells everyone on the server what this device is doing, or the conversation's members in a call.
    private func announce() {
        guard let channelId, let session else { return }
        let update = VoiceUpdate(muted: micOff, deafened: deafened, camera: camera, screen: screen)
        let ring = ringOnAnnounce
        ringOnAnnounce = false
        Task { try? await session.setVoiceState(channelId, update, ring: ring) }
    }

    private func applyVolumes() {
        room?.volumes = { [weak self] userId, source in
            guard let self else { return 1 }
            if deafened { return 0 }
            // A share's sound has a level of its own: it isn't how loud the person talks.
            if source == .screenShareAudio { return settings.screenVolume * (streamVolumes[userId] ?? 1) }
            return localMutes.contains(userId) ? 0 : volumes[userId] ?? 1
        }
    }

    /// A camera or a screen going out is watched by the others wherever this person is in the app, so the screen stays on for it.
    private func holdAwake() {
        ScreenAwake.hold(.sending, camera || screen)
    }

    private func syncVideos() {
        guard let room else { return }
        let next = room.videos()
        let stillThere = focus.map { key in next.contains { $0.id == key } } ?? true
        // A screen someone starts sharing is what everyone's there to see, unless they're already looking at something.
        let arrived = settings.screenFocus ? next.first { video in video.source == .screen && !video.local && !videos.contains { $0.id == video.id } } : nil
        videos = next
        focus = stillThere && focus != nil ? focus : arrived?.id
        camera = room.cameraOn
        cameraFront = room.cameraFacingFront
        // Stopped from the system's own controls, or taken out of the room by the server.
        if screen, !room.sharingScreen {
            shareVanishedAt = .now
            Task { await stopScreen() }
        }
    }

    // MARK: Joining and leaving

    /// Comes into a voice channel or a call, or opens the one this device is already in, asking first if that takes
    /// another of this person's devices out of one, unless they're `sure`. `ring` starts a call, ringing everyone else
    /// in the conversation, and `answered` is a call the system's screen answered, which it has already.
    func join(serverId: String, channelId: String, ring: Bool = false, camera: Bool = false, answered: UUID? = nil, sure: Bool = false) async {
        let here = self.serverId == serverId && self.channelId == channelId && status != .idle
        // The server keeps only a person's latest device in voice, so coming in here ends it on another of theirs.
        // A call the system's screen answered is being come into already, with nowhere left to ask.
        if !here, !sure, answered == nil, let other = app?.servers[serverId]?.voiceElsewhere {
            moving = VoiceMove(serverId: serverId, channelId: channelId, ring: ring, camera: camera, from: other.channelId)
            return
        }
        stageShown = true
        if here { return }
        if status != .idle { leave(keepingSystemCall: answered != nil) }
        stageShown = true
        attempt += 1
        let mine = attempt
        reconnects = 0
        reset(status: .connecting)
        self.serverId = serverId
        self.channelId = channelId
        let server = app?.servers[serverId]
        let channel = server?.channels.first { $0.id == channelId }
        isCall = channel == nil
        ringOnAnnounce = ring && isCall
        cameraOnJoin = camera
        refreshIncoming()
        let title = channel?.title ?? server?.conversation(groupId: channelId)?.title ?? "Voice channel"
        let actions = SystemCall.Actions(
            mute: { [weak self] muted in self?.mutedBySystem(muted) ?? false },
            end: { [weak self] in self?.leave() }
        )
        if let answered {
            systemCall.answered(answered, actions: actions)
        } else {
            await systemCall.start(title: title, actions: actions)
        }
        guard mine == attempt else { return }
        await connect(serverId: serverId, channelId: channelId, mine: mine)
    }

    /// Comes into the room that was asked about, whatever that ends on another of this person's devices.
    func move(_ move: VoiceMove) async {
        await join(serverId: move.serverId, channelId: move.channelId, ring: move.ring, camera: move.camera, sure: true)
    }

    /// Where the other device is, for the question about a move, in words that follow "You're in".
    func place(of move: VoiceMove) -> String {
        let server = app?.servers[move.serverId]
        let channel = server?.channels.first { $0.id == move.from }
        if move.from == move.channelId { return channel != nil ? "this voice channel" : "this call" }
        if let channel { return channel.name.isEmpty ? "a voice channel" : channel.name }
        guard let conversation = server?.conversation(groupId: move.from) else { return "a call" }
        return conversation.kind == .dm ? "a call with \(conversation.title)" : "a call in \(conversation.title)"
    }

    /// Calls the people in a conversation, starting a direct message if nobody's written in it yet.
    func startCall(serverId: String, key: String, camera: Bool) async {
        guard let app else { return }
        let groupId: String
        do {
            groupId = try await app.core.session(serverId).prepareCall(key)
        } catch {
            app.toast((error as? CoreCallError)?.message ?? "Couldn't start the call.", .error)
            return
        }
        // Someone else may have called meanwhile, which this joins rather than ringing anyone.
        let going = !(app.servers[serverId]?.inRoom(groupId).isEmpty ?? true)
        await join(serverId: serverId, channelId: groupId, ring: !going, camera: camera)
    }

    private func reset(status: Status) {
        self.status = status
        serverId = nil
        channelId = nil
        isCall = false
        ringOnAnnounce = false
        cameraOnJoin = false
        callRang = false
        hangUp?.cancel()
        serverMuted = false
        noMic = false
        speaking = []
        videos = []
        quality = .unknown
        camera = false
        cameraFront = true
        focus = nil
        keyEpoch = nil
        sounding = [:]
        watch = nil
        watching = nil
        seekLater?.cancel()
        forgetShare()
    }

    /// A share goes with the connection it went out on, and the server knows it's over from the next one.
    private func forgetShare() {
        shareAttempt += 1
        screen = false
        screenStarting = false
        screenTerms = nil
    }

    private func connect(serverId: String, channelId: String, mine: Int) async {
        guard let app else { return }
        let bitrate = app.servers[serverId]?.channels.first { $0.id == channelId }?.bitrate ?? 0
        // Not known until it's finished joining, and what happens before then has nobody to tell.
        var joined: VoiceRoom?
        let current = { [weak self] in joined != nil && self?.room === joined }
        do {
            let room = try await VoiceRoom.join(session: app.core.session(serverId), channelId: channelId, bitrate: bitrate, muted: micOff, events: VoiceRoom.Events(
                status: { [weak self] status in
                    guard let self, current() else { return }
                    switch status {
                    case .connected:
                        reconnects = 0
                        self.status = .connected
                    case .reconnecting:
                        self.status = .reconnecting
                    case let .closed(reason):
                        closed(reason)
                    }
                },
                media: { [weak self] in
                    if current() { self?.syncVideos() }
                },
                speaking: { [weak self] users in
                    if current() { self?.speaking = users }
                },
                quality: { [weak self] quality in
                    if current() { self?.quality = quality }
                },
                participants: { [weak self] joined, _ in
                    if current() { self?.sound(joined != nil ? .join : .leave) }
                }
            ))
            joined = room
            guard mine == attempt else {
                room.close()
                return
            }
            self.room = room
            applyVolumes()
            noMic = !room.hasMic
            serverMuted = room.serverMuted
            if let problem = room.micProblem { app.toast("\(problem) You can still listen.") }
            await room.setMuted(micOff)
            status = .connected
            keyEpoch = room.currentKey?.epoch
            systemCall.connected()
            systemCall.setMuted(micOff)
            announce()
            syncVideos()
            if reconnects == 0 { sound(.selfJoin) }
            if cameraOnJoin, !camera {
                cameraOnJoin = false
                await toggleCamera()
            }
        } catch {
            guard mine == attempt else { return }
            app.toast((error as? CoreCallError).map { ErrorText.describe($0) } ?? "Couldn't connect to voice.", .error)
            // A server that hasn't set this up, or a channel that's full, won't change in a moment.
            let session = app.core.session(serverId)
            reset(status: .idle)
            stageShown = false
            systemCall.ended(failed: true)
            Task { try? await session.setVoiceState(nil, nil) }
            onEnded?()
        }
    }

    /// What to do when the room goes away without anyone asking: try coming back, as far as that's worth it.
    private func closed(_ reason: LiveKitErrorType?) {
        guard let serverId, let channelId else { return }
        room?.close()
        room = nil
        forgetShare()
        switch reason {
        case .participantRemoved, .roomDeleted, .duplicateIdentity, .cancelled:
            leave()
            return
        default:
            break
        }
        if reconnects >= Self.reconnectAttempts {
            app?.toast("Lost the connection to voice.", .error)
            leave()
            return
        }
        reconnects += 1
        status = .reconnecting
        attempt += 1
        let mine = attempt
        Task { [weak self] in
            try? await Task.sleep(for: Self.reconnectWait)
            guard let self, mine == attempt else { return }
            await connect(serverId: serverId, channelId: channelId, mine: mine)
        }
    }

    /// Leaves the room. `keepingSystemCall` is for one answered from the system's screen, which is that call now.
    func leave(keepingSystemCall: Bool = false) {
        guard status != .idle else { return }
        attempt += 1
        let session = session
        room?.close()
        room = nil
        if !keepingSystemCall { systemCall.end() }
        Task { try? await session?.setVoiceState(nil, nil) }
        reset(status: .idle)
        stageShown = false
        sound(.selfLeave)
        refreshIncoming()
        if !keepingSystemCall { onEnded?() }
    }

    // MARK: What the core says

    /// Who's in the channel changed, so its key did too.
    func keyChanged(serverId: String, channelId: String) {
        guard self.serverId == serverId, self.channelId == channelId, let room else { return }
        Task {
            try? await room.updateKeys()
            if self.room === room { keyEpoch = room.currentKey?.epoch }
        }
    }

    /// This device was taken out of its voice channel.
    func ended(serverId: String, channelId: String, reason: String) {
        guard self.serverId == serverId, self.channelId == channelId else { return }
        attempt += 1
        room?.close()
        room = nil
        systemCall.ended(failed: false)
        reset(status: .idle)
        stageShown = false
        let wasCall = app?.servers[serverId]?.channels.contains { $0.id == channelId } == false
        let messages = wasCall ? [
            "elsewhere": "You joined this call on another device.",
            "removed": "You're no longer in this conversation, so you left the call.",
            "deleted": "That conversation was deleted.",
            "banned": "You were removed from this server.",
        ] : [
            "elsewhere": "You joined this voice channel on another device.",
            "disconnected": "An admin removed you from the voice channel.",
            "deleted": "That voice channel was deleted.",
            "banned": "You were removed from this server.",
        ]
        app?.toast(messages[reason] ?? (wasCall ? "You left the call." : "You left the voice channel."))
        sound(.selfLeave)
        refreshIncoming()
        onEnded?()
    }

    // MARK: Calls ringing

    /// A call in a conversation changed whom it's ringing, or ended. A direct message's call nobody answers ends by
    /// itself, as a phone call does.
    func callChanged(serverId: String, groupId: String, call: CallView?) {
        refreshIncoming()
        guard self.serverId == serverId, channelId == groupId, status != .idle, let call else { return }
        if !call.ringing.isEmpty {
            callRang = true
            return
        }
        guard let server = app?.servers[serverId], let me = server.me?.userId, callRang, call.startedBy == me,
              let conversation = server.conversation(groupId: groupId), conversation.kind == .dm,
              !server.inRoom(groupId).contains(where: { $0 != me }) else { return }
        let name = conversation.peerId.flatMap { server.users[$0]?.displayName } ?? conversation.title
        leave()
        app?.toast(conversation.peerId.map { call.declined.contains($0) } == true ? "\(name) declined the call." : "\(name) didn't answer.")
    }

    /// The calls going on were caught up on.
    func callsChanged(serverId: String) {
        callsKnown.insert(serverId)
        refreshIncoming()
        Task { await clearStaleCallNotifications() }
    }

    /// A call's notification, pushed while the app wasn't running, goes once the app knows it's stopped ringing:
    /// a silent push saying so may not have woken it.
    private func clearStaleCallNotifications() async {
        let center = UNUserNotificationCenter.current()
        let ringing = Set(incoming.map { "\($0.serverId)|\($0.groupId)" })
        let stale = await center.deliveredNotifications().filter { notification in
            let content = notification.request.content
            guard content.categoryIdentifier == Notifications.callCategory else { return false }
            let opened = PushStore.open(content.userInfo)
            guard let serverId = content.userInfo["serverId"] as? String ?? opened?.serverId,
                  let groupId = content.userInfo["groupId"] as? String ?? opened?.groupId else { return false }
            return callsKnown.contains(serverId) && !ringing.contains("\(serverId)|\(groupId)")
        }.map(\.request.identifier)
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }

    // MARK: Calls that woke the app

    #if DEBUG
    /// As PushKit hands the app a VoIP push, for tests: the simulator has no PushKit.
    func ringByPush(_ push: PushStore.Message) {
        rangByPush(push)
    }
    #endif

    /// A VoIP push says a call is ringing here. It goes to CallKit at once, as PushKit insists, called what the app
    /// knows so far, and is answered or let go once the app has caught up with its server.
    private func rangByPush(_ push: PushStore.Message?) {
        onPushed?()
        guard let push, push.kind == .call, let startedAt = push.startedAt, let callerId = push.callerId else {
            systemCall.ringUnreadable()
            return
        }
        let id = SystemCall.callId(serverId: push.serverId, groupId: push.groupId, startedAt: startedAt)
        let server = app?.servers[push.serverId]
        let title = server?.conversation(groupId: push.groupId)?.title ?? server?.users[callerId]?.displayName ?? "Zuna"
        if serverId == push.serverId, channelId == push.groupId, status != .idle {
            // Already in it here: the system still has to hear of the push, and ends it at once.
            systemCall.ringNow(id, title: title, actions: SystemCall.Ringing(answer: {}, decline: {}))
            systemCall.stopRinging(id, reason: .answeredElsewhere)
            return
        }
        pushed[id] = push
        systemCall.ringNow(id, title: title, actions: SystemCall.Ringing(
            answer: { [weak self] in self?.answeredPushed(id) },
            decline: { [weak self] in self?.declinePushed(id) }
        ))
        Task { await settlePushed(id) }
    }

    /// Once the app has caught up, a pushed call is one it rings for, which is called what its conversation is, or
    /// one that's over. A phone that can't catch up lets it go after a minute.
    private func settlePushed(_ id: UUID) async {
        for _ in 0..<300 {
            guard let push = pushed[id] else { return }
            if callsKnown.contains(push.serverId), app?.servers[push.serverId]?.connection == .online { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard pushed.removeValue(forKey: id) != nil else { return }
        if let call = rung.values.first(where: { $0.systemId == id }) {
            systemCall.retitle(id, call.title)
        } else {
            pendingAnswer = pendingAnswer == id ? nil : pendingAnswer
            systemCall.stopRinging(id, reason: .remoteEnded)
            if systemCall.isCurrent(id), status == .idle { systemCall.ended(failed: false) }
            if !keepsCoreAwake { onEnded?() }
        }
    }

    /// Answered from the system's screen: straight in if the app knows the call, or as soon as it does.
    private func answeredPushed(_ id: UUID) {
        if let call = incoming.first(where: { $0.systemId == id }) {
            answeredBySystem(call)
        } else {
            pendingAnswer = id
        }
    }

    private func declinePushed(_ id: UUID) {
        guard let push = pushed[id] ?? rung.values.first(where: { $0.systemId == id }).map({ PushStore.Message(kind: .call, serverId: $0.serverId, groupId: $0.groupId, messageId: nil) }),
              let app else { return }
        let session = app.core.session(push.serverId), groupId = push.groupId
        Task {
            // The core may still be starting, as the push woke the app.
            for attempt in 0..<5 {
                do {
                    try await session.declineCall(groupId)
                    return
                } catch {
                    try? await Task.sleep(for: .seconds(attempt + 1))
                }
            }
        }
    }

    /// A silent push says a call stopped ringing this person, which the app may not have heard yet.
    func callEndedByPush(serverId: String, groupId: String) {
        for (id, push) in pushed where push.serverId == serverId && push.groupId == groupId {
            pushed[id] = nil
            systemCall.stopRinging(id, reason: .remoteEnded)
        }
    }

    /// Someone's device left a room. Once the other person in a direct message's call hangs up, it's over, after a
    /// moment for another of their devices taking over.
    func memberLeft(serverId: String, roomId: String, userId: String) {
        guard self.serverId == serverId, channelId == roomId, status != .idle,
              let server = app?.servers[serverId], userId != server.me?.userId,
              server.conversation(groupId: roomId)?.kind == .dm else { return }
        hangUp?.cancel()
        hangUp = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled, self.serverId == serverId, channelId == roomId,
                  let server = app?.servers[serverId], let me = server.me?.userId else { return }
            if !server.inRoom(roomId).contains(where: { $0 != me }) { leave() }
        }
    }

    /// Answers a call ringing here, from the app's own card or its notification.
    func answer(_ call: IncomingCall, camera: Bool) async {
        app?.selectServer(call.serverId)
        app?.openChat(call.key)
        await join(serverId: call.serverId, channelId: call.groupId, camera: camera)
    }

    /// Stops a call ringing on all this person's devices.
    func decline(_ call: IncomingCall) {
        guard let app else { return }
        let session = app.core.session(call.serverId)
        Task {
            do {
                try await session.declineCall(call.groupId)
            } catch {
                app.toast((error as? CoreCallError)?.message ?? "Couldn't decline the call.", .error)
            }
        }
    }

    /// Rings everyone in the call's conversation who isn't in it.
    func ringAgain() {
        guard isCall, let channelId, let session else { return }
        Task { try? await session.ringCall(channelId) }
    }

    /// Who's being rung in the call this device is in, apart from anyone who has come.
    var ringingOthers: [String] {
        guard isCall, let serverId, let channelId, let server = app?.servers[serverId] else { return [] }
        let here = Set(server.inRoom(channelId))
        return (server.calls[channelId]?.ringing ?? []).filter { !here.contains($0) }
    }

    /// Works out which calls ring here now, and starts and stops their ringing: through the system where it can,
    /// and otherwise with the app's own card, ringtone and notification.
    private func refreshIncoming() {
        guard let app else { return }
        var next: [IncomingCall] = []
        for (serverId, server) in app.servers {
            guard let me = server.me?.userId, server.entry.signedOut == nil else { continue }
            for call in server.calls.values where call.ringing.contains(me) {
                if self.serverId == serverId, channelId == call.groupId, status != .idle { continue }
                guard let conversation = server.conversation(groupId: call.groupId), !conversation.removed, !conversation.blocked,
                      !server.isBlocked(call.startedBy) else { continue }
                next.append(IncomingCall(
                    serverId: serverId,
                    groupId: call.groupId,
                    startedAt: call.startedAt,
                    startedBy: call.startedBy,
                    key: conversation.key,
                    title: conversation.title,
                    kind: conversation.kind,
                    quiet: conversation.muted
                ))
            }
        }
        next.sort { $0.startedAt < $1.startedAt }
        let before = rung
        rung = Dictionary(next.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        if incoming != next { incoming = next }
        for call in next where before[call.id] == nil { startRinging(call) }
        for (id, call) in before where rung[id] == nil { stoppedRinging(call) }
        if !before.isEmpty, !keepsCoreAwake { onEnded?() }
        if let pending = pendingAnswer, let call = next.first(where: { $0.systemId == pending }) {
            pendingAnswer = nil
            answeredBySystem(call)
        }
        updateRingtone()
    }

    private func startRinging(_ call: IncomingCall) {
        let actions = SystemCall.Ringing(
            answer: { [weak self] in self?.answeredBySystem(call) },
            decline: { [weak self] in self?.decline(call) }
        )
        Task {
            let system = await systemCall.ring(call.systemId, title: call.title, actions: actions)
            systemRings = system
            if !system, rung[call.id] != nil { await notify(call, missed: false) }
            updateRingtone()
        }
    }

    /// The system's screen answered a call: it's the system's call already, so the room comes to it.
    private func answeredBySystem(_ call: IncomingCall) {
        pushed[call.systemId] = nil
        // Out of whatever room this device was in, whose call the system has ended by now.
        if status != .idle { leave(keepingSystemCall: true) }
        app?.selectServer(call.serverId)
        app?.openChat(call.key)
        Task { await join(serverId: call.serverId, channelId: call.groupId, answered: call.systemId) }
    }

    /// A call stopped ringing here: answered on this device or another, declined, ended, or rung long enough.
    private func stoppedRinging(_ call: IncomingCall) {
        let server = app?.servers[call.serverId]
        let me = server?.me?.userId ?? ""
        let here = serverId == call.serverId && channelId == call.groupId && status != .idle
        let elsewhere = !here && server?.inRoom(call.groupId).contains(me) == true
        let now = server?.calls[call.groupId]
        let declined = now?.declined.contains(me) == true
        systemCall.stopRinging(call.systemId, reason: elsewhere ? .answeredElsewhere : declined ? .declinedElsewhere : now == nil ? .remoteEnded : .unanswered)
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["call:\(call.id)"])
        guard !here, !elsewhere, !declined, !call.quiet else { return }
        if UIApplication.shared.applicationState == .active {
            app?.toast(call.kind == .dm ? "Missed call from \(call.title)." : "Missed call from \(name(call.serverId, call.startedBy)) in \(call.title).")
        } else {
            Task { await notify(call, missed: true) }
        }
    }

    private func name(_ serverId: String, _ userId: String) -> String {
        app?.servers[serverId]?.users[userId]?.displayName ?? "Someone"
    }

    /// A call ringing, or missed, as a notification, where the system doesn't ring and the app isn't in front.
    private func notify(_ call: IncomingCall, missed: Bool) async {
        let settings = NotificationSettings.load()
        guard settings.enabled, !call.quiet, UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        let caller = name(call.serverId, call.startedBy)
        content.title = settings.preview == .none ? "Zuna" : call.title
        content.body = settings.preview == .none ? (missed ? "Missed call" : "Incoming call")
            : missed ? (call.kind == .dm ? "Missed call" : "Missed call from \(caller)")
            : call.kind == .dm ? "Calling you" : "\(caller) started a call"
        content.sound = settings.sound ? (missed ? .default : .defaultRingtone) : nil
        content.categoryIdentifier = missed ? "" : Notifications.callCategory
        content.userInfo = ["serverId": call.serverId, "groupId": call.groupId, "conversationKey": call.key, "call": call.id]
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "call:\(call.id)", content: content, trigger: nil))
    }

    /// A call ringing here, by what its notification says.
    func incomingCall(_ id: String) -> IncomingCall? {
        incoming.first { $0.id == id }
    }

    /// Rings here while a call rings this person and the system doesn't, and for the one calling while it rings the others.
    private func updateRingtone() {
        let active = UIApplication.shared.applicationState == .active
        if systemRings == false, active, incoming.contains(where: { !$0.quiet }) {
            sounds.ring(.incoming)
        } else if status == .connected, !ringingOthers.isEmpty, let serverId, let channelId,
                  app?.servers[serverId]?.inRoom(channelId).contains(where: { $0 != app?.servers[serverId]?.me?.userId }) == false {
            sounds.ring(settings.sounds ? .outgoing : nil)
        } else {
            sounds.ring(nil)
        }
    }

    /// The server stopped this device's share: an admin did, or its rules changed.
    func screenEnded(serverId: String, channelId: String, reason: String) {
        guard self.serverId == serverId, self.channelId == channelId else { return }
        // The media server may have taken it out of the room already, and that's gone by.
        let vanished = shareVanishedAt.map { Date.now.timeIntervalSince($0) < 5 } ?? false
        guard screen || screenStarting || vanished else { return }
        shareVanishedAt = nil
        Task { await stopScreen() }
        app?.toast(reason == "stopped" ? "An admin stopped your screen share." : "This server's rules changed, so your screen share stopped.")
    }

    /// Being muted by an admin, or no longer, comes with the rest of what's said about this device.
    func memberChanged(serverId: String, _ member: VoiceMember) {
        guard self.serverId == serverId, channelId == member.channelId,
              member.deviceId == app?.servers[serverId]?.me?.deviceId, member.serverMuted != serverMuted else { return }
        serverMuted = member.serverMuted
        Task { await room?.setMuted(micOff) }
        systemCall.setMuted(micOff)
        app?.toast(member.serverMuted ? "An admin muted you." : "An admin unmuted you.")
        sound(member.serverMuted ? .mute : .unmute)
    }

    /// This device is no longer on a server, so it can't be in any of its voice channels.
    func serverGone(_ serverId: String) {
        if self.serverId == serverId { leave() }
    }

    // MARK: Controls

    func toggleMute() {
        guard !noMic, !serverMuted else { return }
        // Unmuting while deafened undoes both, as being deafened means hearing nothing and saying nothing.
        if deafened {
            deafened = false
            muted = false
            applyVolumes()
            applyMute()
            sound(.undeafen)
            return
        }
        muted.toggle()
        applyMute()
        sound(muted ? .mute : .unmute)
    }

    func toggleDeafen() {
        deafened.toggle()
        applyVolumes()
        applyMute()
        sound(deafened ? .deafen : .undeafen)
    }

    private func applyMute() {
        let off = micOff
        Task { await room?.setMuted(off) }
        systemCall.setMuted(off)
        announce()
    }

    /// The system's call controls muted the call or unmuted it, as on the lock screen. False if that can't be done.
    private func mutedBySystem(_ muted: Bool) -> Bool {
        guard muted != micOff else { return true }
        if muted {
            self.muted = true
            applyMute()
            sound(.mute)
            return true
        }
        guard !noMic, !serverMuted else { return false }
        // As the app's own button does, unmuting while deafened undoes both.
        let wasDeafened = deafened
        deafened = false
        self.muted = false
        if wasDeafened { applyVolumes() }
        applyMute()
        sound(wasDeafened ? .undeafen : .unmute)
        return true
    }

    func toggleCamera() async {
        guard let room else { return }
        let on = !camera
        if on, !(await Self.cameraAllowed()) {
            app?.toast("Zuna can't use the camera. Allow it in Settings.", .error)
            return
        }
        do {
            try await room.setCamera(on)
            camera = on
            cameraFront = room.cameraFacingFront
            systemCall.video(on)
            announce()
        } catch {
            app?.toast("There's no camera Zuna can use.", .error)
        }
    }

    // MARK: Sharing the screen

    var canShareScreen: Bool { VoiceRoom.canShareScreen }

    /// Why this device can't share its screen here, if it can't: the server's rules, or the channel's.
    var shareRefusal: String? {
        guard let serverId, let server = app?.servers[serverId] else { return nil }
        let limit = isCall ? 0 : server.channels.first { $0.id == channelId }?.screenLimit ?? 0
        return Voice.screenRefusal(rules: server.info?.screenShare, role: server.me?.role, channelLimit: limit)
    }

    func toggleScreen() async {
        if screen || screenStarting { await stopScreen() } else { await startScreen() }
    }

    /// Shares this device's screen, once the server has made room for it, at the screen's own size and with the most
    /// it may send chosen in settings, unless the server's admins hold shares to less. Only the picture goes: LiveKit
    /// on iOS would mix the screen's sound into the microphone, past the server's say over a share's sound.
    func startScreen() async {
        guard let app, let room, let channelId, let serverId, let session, !screen, !screenStarting, canShareScreen else { return }
        if let refusal = shareRefusal {
            refuseShare("\(refusal).")
            return
        }
        let server = app.servers[serverId]
        let terms = Self.shareTerms(settings, server: server)
        shareAttempt += 1
        let mine = shareAttempt
        let current = { [weak self] in self?.shareAttempt == mine && self?.room === room }
        screenStarting = true
        do {
            _ = try await session.voiceScreenAccess(channelId, ScreenRequest(sound: false))
        } catch {
            if current() { screenStarting = false }
            refuseShare((error as? CoreCallError)?.message ?? "Couldn't share your screen.")
            return
        }
        do {
            guard current() else { throw LiveKitError(.cancelled) }
            try await room.startScreen(terms)
            guard current() else {
                await room.stopScreen()
                throw LiveKitError(.cancelled)
            }
            screenStarting = false
            screen = true
            screenTerms = terms
            announce()
            sound(.selfJoin)
        } catch {
            if current() { screenStarting = false }
            Task { try? await session.voiceScreenStop(channelId) }
            // Choosing not to share after all is not a failure.
            if (error as? LiveKitError)?.type != .cancelled { refuseShare("Couldn't share your screen.") }
        }
    }

    /// What a share from this device goes out with on a server: the size is always the screen's own.
    static func shareTerms(_ settings: VoiceSettings, server: AppModel.ServerState?) -> ScreenTerms {
        Voice.screenTerms(ScreenChoices(height: 0, fps: Voice.screenDefaultFps, kbps: settings.screenBitrate), rules: server?.info?.screenShare, role: server?.me?.role)
    }

    /// Stops sharing this device's screen, or asking to, and gives its place back.
    func stopScreen() async {
        guard screen || screenStarting, let room else { return }
        let session = session, channelId = channelId
        forgetShare()
        await room.stopScreen()
        announce()
        if let session, let channelId { try? await session.voiceScreenStop(channelId) }
    }

    /// Says why a share didn't start, here and to a broadcast that's waiting for an answer.
    private func refuseShare(_ message: String) {
        app?.toast(message, .error)
        if BroadcastManager.shared.isBroadcasting { BroadcastSignal.refuse(message) }
    }

    /// A broadcast to Zuna's extension started or stopped: from the call, from Control Center, or from the system's controls.
    private func broadcastChanged(_ on: Bool) {
        if on {
            // One the call asked for is taken where it's waited for.
            guard !screen, !screenStarting else { return }
            guard status == .connected else {
                BroadcastSignal.refuse("Join a voice channel in Zuna, then share your screen from the call.")
                return
            }
            Task { await startScreen() }
        } else if screen, room?.sharingByBroadcast == true {
            Task { await stopScreen() }
        }
    }

    func flipCamera() async {
        await room?.flipCamera()
        cameraFront = room?.cameraFacingFront ?? true
    }

    private static func cameraAllowed() async -> Bool {
        #if DEBUG
        if VoiceTesting.fakeCamera { return true }
        #endif
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    func setVolume(_ volume: Double, for userId: String) {
        volumes[userId] = volume
        VoiceSettings.volumes = volumes
        applyVolumes()
    }

    func setStreamVolume(_ volume: Double, for userId: String) {
        streamVolumes[userId] = volume
        VoiceSettings.streamVolumes = streamVolumes
        applyVolumes()
    }

    /// Silences someone's share, or brings it back to how loud it was.
    func toggleStreamMute(_ userId: String) {
        let volume = streamVolumes[userId] ?? 1
        if volume > 0 { streamVolumeBefore[userId] = volume }
        setStreamVolume(volume > 0 ? 0 : streamVolumeBefore[userId] ?? 1, for: userId)
    }

    func toggleLocalMute(_ userId: String) {
        if localMutes.contains(userId) { localMutes.remove(userId) } else { localMutes.insert(userId) }
        applyVolumes()
    }

    // MARK: Soundboard

    /// Why this person can't play a sound in the room they're in, if they can't, as the desktop's soundboard says.
    var soundRefusal: String? {
        guard let serverId, let server = app?.servers[serverId] else { return nil }
        if !isCall, server.channels.first(where: { $0.id == channelId })?.sounds == false { return "The soundboard is off in this voice channel." }
        if serverMuted { return "An admin muted you, so you can't play sounds." }
        if deafened { return "Undeafen to play sounds." }
        // Without a microphone, someone can only listen, and so they're muted.
        if muted || noMic { return "Unmute to play sounds." }
        return nil
    }

    /// Plays a sound from the soundboard to everyone in the voice channel or call, once the server says it may, and here too.
    func playSound(_ soundId: String) async {
        guard let serverId, let channelId, let session, let me = app?.servers[serverId]?.me else { return }
        do {
            try await session.playSound(channelId, soundId: soundId)
        } catch {
            app?.toast(ErrorText.describe(error), .error)
            return
        }
        await playHere(serverId: serverId, soundId: soundId, userId: me.userId)
    }

    // MARK: Watching together

    /// What the room watches changed, or it stopped.
    func watchChanged(serverId: String, channelId: String, watch: WatchView?) {
        guard serverId == self.serverId, channelId == self.channelId else { return }
        let before = self.watch
        self.watch = watch
        // Pressing Watch is for one session, so a new one asks again.
        if watching != watch?.session { watching = nil }
        // A video put on is what everyone's there to see, unless they're already looking at something.
        if watch != nil, before == nil, focus == nil { focus = Self.watchFocus }
        if watch == nil, focus == Self.watchFocus { focus = nil }
    }

    /// Whether people may watch together in this room: always in a call, and in a voice channel unless its admins said no.
    var watchAllowed: Bool {
        guard let serverId, let channelId else { return false }
        return isCall || app?.servers[serverId]?.channels.first { $0.id == channelId }?.watch ?? true
    }

    /// Puts a YouTube video on for everyone in the room, from a link, and watches it here. Throws with words for the person.
    func watchStart(_ url: String) async throws {
        guard let channelId, let session else { throw WatchFailure(errorDescription: "Join the voice channel to watch together.") }
        try await session.watchStart(channelId, url: url)
        let now = try? await session.getWatch(channelId)
        guard channelId == self.channelId else { return }
        watch = now
        // Whoever puts it on watches it.
        watching = now?.session
        if now != nil { focus = Self.watchFocus }
    }

    /// Something this person did with the video, for everyone.
    func watchControl(_ change: WatchChange) {
        guard let channelId, let session else { return }
        seekLater?.cancel()
        let send = { [weak self] in
            self?.seekSentAt = Date()
            Task { [weak self] in
                do {
                    try await session.watchControl(channelId, change)
                } catch {
                    self?.app?.toast(ErrorText.describe(error), .error)
                }
            }
        }
        // Someone dragging the seek bar sends where they stopped, a few times a second.
        let onlySeek = change.position != nil && change.playing == nil && change.rate == nil
        let wait = 0.25 - Date().timeIntervalSince(seekSentAt)
        if onlySeek, wait > 0 {
            seekLater = Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled, self?.channelId == channelId else { return }
                send()
            }
        } else {
            send()
        }
    }

    /// Stops the video for everyone.
    func watchStop() {
        guard let channelId, let session else { return }
        Task { [weak self] in
            do {
                try await session.watchStop(channelId)
            } catch {
                self?.app?.toast(ErrorText.describe(error), .error)
            }
        }
    }

    /// Where this device's player last said it was, for checks, which only development builds set.
    @ObservationIgnored var playerPhase: String?

    /// Plays what the room watches on this device, or stops playing it here only.
    func setWatching(_ on: Bool) {
        watching = on ? watch?.session : nil
        if on, watch != nil { focus = Self.watchFocus }
    }

    /// Someone else in the room played a sound.
    func soundPlayed(serverId: String, channelId: String, userId: String, soundId: String) {
        guard serverId == self.serverId, channelId == self.channelId else { return }
        Task { await playHere(serverId: serverId, soundId: soundId, userId: userId) }
    }

    /// Plays a sound from its file on this device, as someone played it, unless this device hears nothing of theirs:
    /// deafened, the person muted for this device, or the soundboard turned all the way down.
    private func playHere(serverId: String, soundId: String, userId: String) async {
        guard room != nil, serverId == self.serverId, !deafened, !localMutes.contains(userId), settings.soundboardVolume > 0, let app else { return }
        let key = "\(serverId)/\(soundId)"
        var data = soundFiles[key]
        if data == nil {
            do {
                let file = try await app.core.session(serverId).soundFile(soundId)
                data = try Data(contentsOf: URL(fileURLWithPath: file.path))
                soundFiles[key] = data
            } catch {
                return
            }
        }
        guard let data, serverId == self.serverId, !deafened, let player = try? AVAudioPlayer(data: data) else { return }
        player.volume = Float(settings.soundboardVolume)
        soundPlayers.removeAll { !$0.isPlaying }
        soundPlayers.append(player)
        player.play()
        let emoji = app.servers[serverId]?.sounds.first { $0.id == soundId }?.emoji ?? ""
        sounding[userId] = emoji.isEmpty ? "🔊" : emoji
        soundingEnds[userId]?.cancel()
        soundingEnds[userId] = Task { [weak self] in
            // Held a little past its end, so a short one is seen.
            try? await Task.sleep(for: .seconds(player.duration + 0.6))
            guard !Task.isCancelled else { return }
            self?.sounding[userId] = nil
        }
    }

    #if DEBUG
    /// What the system has of the call, for tests.
    var systemCallReport: [String: Any] { systemCall.report }
    #endif

    // MARK: Stream stats

    /// Everything there is to know about what's going out and coming in, as `reader` last read it.
    func readStats(_ reader: StreamStats) -> [StatSection] {
        guard let room else { return [] }
        let share = screen ? screenTerms.map { StatsShare(through: room.shareRoute, terms: $0) } : nil
        let users = serverId.flatMap { app?.servers[$0]?.users } ?? [:]
        let words: String = switch status {
        case .idle: "closed"
        case .connecting: "connecting"
        case .connected: "connected"
        case .reconnecting: "reconnecting"
        }
        return reader.read(room.statsRoom(), status: words, share: share) { users[$0]?.displayName ?? "Someone" }
    }
}
