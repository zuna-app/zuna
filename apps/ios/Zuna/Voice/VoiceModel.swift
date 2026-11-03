import AVFoundation
import Combine
import Foundation
import LiveKit
import Observation
import UIKit
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
    /// The most this device's shares may send, in kbit/s, or nil for what the server suggests.
    var screenBitrate: Int?

    private static let key = "zuna-voice-settings"

    static func load() -> VoiceSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let settings = try? JSONDecoder().decode(VoiceSettings.self, from: data) else { return VoiceSettings() }
        return settings
    }

    init() {}

    // Settings saved by an earlier version lack the newer fields; they take their defaults.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sounds = try container.decodeIfPresent(Bool.self, forKey: .sounds) ?? true
        startMuted = try container.decodeIfPresent(Bool.self, forKey: .startMuted) ?? false
        screenVolume = try container.decodeIfPresent(Double.self, forKey: .screenVolume) ?? 1
        screenFocus = try container.decodeIfPresent(Bool.self, forKey: .screenFocus) ?? true
        screenBitrate = try container.decodeIfPresent(Int.self, forKey: .screenBitrate)
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

/// The voice channel this device is in, wherever in the app the person is looking.
/// There's one at a time, across all servers, as in Discord. The iPhone's
/// counterpart of the desktop's packages/ui/src/voice/store.ts.
@MainActor
@Observable
final class VoiceModel {
    enum Status: Equatable { case idle, connecting, connected, reconnecting }

    private(set) var status: Status = .idle
    private(set) var serverId: String?
    private(set) var channelId: String?
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
    private(set) var camera = false
    private(set) var cameraFront = true
    /// This device's screen is going out.
    private(set) var screen = false
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
    /// What keys the call's media is under, for its details.
    private(set) var keyEpoch: Int?

    /// Called when the call ends, so the app can let go of what it kept running for it in the background.
    @ObservationIgnored var onEnded: (() -> Void)?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var room: VoiceRoom?
    /// Each join counts, so one that takes a while can tell it's been replaced.
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var reconnects = 0
    @ObservationIgnored private let sounds = VoiceSounds()
    /// How loud a share was before being silenced here, to go back to.
    @ObservationIgnored private var streamVolumeBefore: [String: Double] = [:]
    /// Each share asked for counts, so one that takes a while can tell it's been stopped.
    @ObservationIgnored private var shareAttempt = 0
    /// When this device's share last went away by itself. The server stopping one takes it out of the room before it says why.
    @ObservationIgnored private var shareVanishedAt: Date?
    @ObservationIgnored private var broadcastWatch: AnyCancellable?

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

    var inCall: Bool { status != .idle }

    /// Sound is going out from here, as far as this device can tell.
    var micOff: Bool { muted || deafened || serverMuted || noMic }

    private func sound(_ name: VoiceSounds.Sound) {
        if settings.sounds { sounds.play(name) }
    }

    private var session: SessionCalls? {
        serverId.flatMap { app?.core.session($0) }
    }

    /// Tells everyone on the server what this device is doing.
    private func announce() {
        guard let channelId, let session else { return }
        let update = VoiceUpdate(muted: micOff, deafened: deafened, camera: camera, screen: screen)
        Task { try? await session.setVoiceState(channelId, update) }
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

    /// Comes into a voice channel, or opens the one this device is already in.
    func join(serverId: String, channelId: String) async {
        stageShown = true
        if self.serverId == serverId, self.channelId == channelId, status != .idle { return }
        if status != .idle { leave() }
        stageShown = true
        attempt += 1
        let mine = attempt
        reconnects = 0
        reset(status: .connecting)
        self.serverId = serverId
        self.channelId = channelId
        await connect(serverId: serverId, channelId: channelId, mine: mine)
    }

    private func reset(status: Status) {
        self.status = status
        serverId = nil
        channelId = nil
        serverMuted = false
        noMic = false
        speaking = []
        videos = []
        quality = .unknown
        camera = false
        cameraFront = true
        focus = nil
        keyEpoch = nil
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
            announce()
            syncVideos()
            if reconnects == 0 { sound(.selfJoin) }
        } catch {
            guard mine == attempt else { return }
            app.toast(Self.describe(error), .error)
            // A server that hasn't set this up, or a channel that's full, won't change in a moment.
            let session = app.core.session(serverId)
            reset(status: .idle)
            stageShown = false
            Task { try? await session.setVoiceState(nil, nil) }
            onEnded?()
        }
    }

    private static func describe(_ error: Error) -> String {
        if let error = error as? CoreCallError { return error.message }
        if error is LiveKitError { return "Couldn't connect to voice." }
        return "Couldn't connect to voice."
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

    func leave() {
        guard status != .idle else { return }
        attempt += 1
        let session = session
        room?.close()
        room = nil
        Task { try? await session?.setVoiceState(nil, nil) }
        reset(status: .idle)
        stageShown = false
        sound(.selfLeave)
        onEnded?()
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
        reset(status: .idle)
        stageShown = false
        let messages = [
            "elsewhere": "You joined this voice channel on another device.",
            "disconnected": "An admin took you out of the voice channel.",
            "deleted": "That voice channel was deleted.",
            "banned": "You were removed from this server.",
        ]
        app?.toast(messages[reason] ?? "You left the voice channel.")
        sound(.selfLeave)
        onEnded?()
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
        announce()
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
        let limit = server.channels.first { $0.id == channelId }?.screenLimit ?? 0
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
            _ = try await session.voiceScreenAccess(channelId, ScreenRequest(browser: true, sound: false))
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
        Voice.screenTerms(ScreenChoices(height: 0, kbps: settings.screenBitrate), rules: server?.info?.screenShare, role: server?.me?.role)
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
                BroadcastSignal.refuse("Come into a voice channel in Zuna, then share your screen from the call.")
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
