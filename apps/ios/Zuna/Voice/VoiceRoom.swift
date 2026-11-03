import AVFoundation
import Foundation
import LiveKit
import os
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
import UIKit
import ZunaModels

/// One video someone is sending. Mirrors `CallVideo` in packages/ui/src/voice/room.ts.
struct CallVideo: Identifiable, Equatable {
    enum Source { case camera, screen }
    let id: String
    let userId: String
    let source: Source
    let track: VideoTrack
    let local: Bool
    /// A share someone else is sending with its sound, which can be made quieter here.
    let sound: Bool

    static func == (a: CallVideo, b: CallVideo) -> Bool { a.id == b.id && a.track === b.track && a.sound == b.sound }
}

/// One connection to a voice channel's room on the media server, which only ever sees
/// encrypted media. Keys come from the channel's MLS group through the core. The
/// iPhone's counterpart of packages/ui/src/voice/room.ts.
@MainActor
final class VoiceRoom {
    enum Status: Equatable { case connected, reconnecting, closed(LiveKitErrorType?) }

    struct Events {
        var status: (Status) -> Void
        /// Who's sending what changed.
        var media: () -> Void
        var speaking: (Set<String>) -> Void
        var quality: (ConnectionQuality) -> Void
        /// Someone came into the room or left it.
        var participants: (_ joined: String?, _ left: String?) -> Void
    }

    /// How long after hearing of a new key this device starts sending under it, so that
    /// everyone else has heard too. It keeps listening under both meanwhile.
    private static let newKeySendDelay: Duration = .milliseconds(1500)
    private static let defaultAudioKbps = 64

    private let room: Room
    // A key that doesn't open a frame is no reason to give up on it: the sender may just be ahead.
    // HKDF, as the desktop's keys go through, since a key from the MLS exporter is already random.
    private let keys = BaseKeyProvider(options: KeyProviderOptions(
        sharedKey: false,
        ratchetWindowSize: 0,
        failureTolerance: -1,
        keyRingSize: Voice.keyRing,
        keyDerivationAlgorithm: .hkdf
    ))
    private var listener: Listener?
    private let session: SessionCalls
    private let channelId: String
    private let bitrate: Int
    private let events: Events
    /// The media server's address, for the stream stats.
    private var mediaUrl = ""
    /// The keys in use, newest first: what's being sent under may be one behind for a moment.
    private var roomKeys: [(index: Int32, key: Data, epoch: Int)] = []
    private var sendTask: Task<Void, Never>?
    private var micPublication: LocalTrackPublication?
    private var muted = false
    private var closed = false
    /// LiveKit says what this participant may send while it's still joining, which isn't news to act on yet.
    private var joined = false
    private let logger = Logger(subsystem: "chat.zuna", category: "voice")

    /// Who this device is in the room.
    private(set) var identity = ""
    /// An admin has muted this person, so the media server wouldn't take a microphone anyway.
    private(set) var serverMuted = false
    /// Why there's no microphone, if there isn't one. Nothing about voice needs one: someone without one can still listen.
    private(set) var micProblem: String?
    /// How loud each person is, by user and what they're sending, which also covers being deafened.
    var volumes: (String, Track.Source) -> Double = { _, _ in 1 } {
        didSet { applyVolumes() }
    }

    /// Test builds count the packets that arrive, for checks to tell what didn't arrive from what didn't decrypt.
    private static var testing: Bool {
        #if DEBUG
        VoiceTesting.toneMicrophone
        #else
        false
        #endif
    }

    /// Whether tracks read their statistics without the stream stats open.
    static var reportsStatistics: Bool { testing }

    private init(session: SessionCalls, channelId: String, bitrate: Int, events: Events) {
        self.session = session
        self.channelId = channelId
        self.bitrate = bitrate
        self.events = events
        room = Room(roomOptions: RoomOptions(
            defaultCameraCaptureOptions: CameraCaptureOptions(position: .front, dimensions: .h720_169),
            adaptiveStream: true,
            dynacast: true,
            encryptionOptions: EncryptionOptions(keyProvider: keys),
            reportRemoteTrackStatistics: Self.testing,
            // One connection, offered along with the request to join, which is quicker, and loses its first
            // answer far less often than two do (`connectRoom`).
            singlePeerConnection: true
        ))
        let listener = Listener(owner: self)
        self.listener = listener
        room.add(delegate: listener)
    }

    /// Comes into a channel. It throws if that can't be done, with something to tell the person.
    static func join(session: SessionCalls, channelId: String, bitrate: Int, muted: Bool, events: Events) async throws -> VoiceRoom {
        let voiceRoom = VoiceRoom(session: session, channelId: channelId, bitrate: bitrate, events: events)
        voiceRoom.muted = muted
        do {
            try await voiceRoom.connect()
            return voiceRoom
        } catch {
            voiceRoom.close()
            throw error
        }
    }

    private func connect() async throws {
        #if DEBUG
        VoiceTesting.logIfAsked()
        VoiceTesting.prepareAudio()
        #endif
        // Muting keeps the microphone running, so iOS doesn't chime and the call keeps going in the background.
        try? AudioManager.shared.set(microphoneMuteMode: .inputMixer)
        micProblem = await Self.microphoneProblem()
        let access = try await session.voiceAccess(channelId)
        identity = access.identity
        serverMuted = access.serverMuted
        mediaUrl = access.url
        try await updateKeys(first: true)
        try await connectRoom(url: access.url, token: access.token)
        joined = true
        // Those already here, and everything they send.
        for participant in room.remoteParticipants.values {
            installFor(participant)
        }
        await permissionsChanged()
    }

    /// LiveKit 2.19 sometimes loses the first answer while it connects. With two connections, the media server's
    /// offer waits in a queue, and the answer made once it's let through can go out a moment before requests are,
    /// which drops it (`resumeQueues` in its `SignalClient`). With one, the media server's answer to ours now and
    /// then goes unused. Either way the connection never comes up and times out, and another try connects.
    /// Reported as livekit/client-sdk-swift#1196: this can go once that's fixed.
    private func connectRoom(url: String, token: String) async throws {
        for attempt in 1...3 {
            do {
                try await room.connect(url: url, token: token, connectOptions: ConnectOptions(autoSubscribe: true))
                return
            } catch let error as LiveKitError where error.type == .timedOut && attempt < 3 && !closed {
                logger.warning("Connecting to the voice channel timed out, trying again")
            }
        }
    }

    private static func microphoneProblem() async -> String? {
        #if DEBUG
        if VoiceTesting.toneMicrophone { return nil }
        #endif
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return nil
        case .denied: return "Zuna can't use the microphone. Allow it in Settings."
        default:
            return await AVAudioApplication.requestRecordPermission() ? nil : "Zuna can't use the microphone. Allow it in Settings."
        }
    }

    var hasMic: Bool { micProblem == nil }

    private func publishMic() async {
        guard hasMic, !serverMuted, micPublication == nil, !closed else { return }
        do {
            micPublication = try await room.localParticipant.setMicrophone(
                enabled: true,
                publishOptions: AudioPublishOptions(name: "microphone", encoding: AudioEncoding(maxBitrate: (bitrate > 0 ? bitrate : Self.defaultAudioKbps) * 1000), dtx: true, red: true)
            )
            if muted { try await (micPublication?.track as? LocalAudioTrack)?.mute() }
        } catch {
            logger.error("Couldn't publish the microphone: \(String(describing: error), privacy: .public)")
            micProblem = "The microphone couldn't be used."
        }
    }

    // MARK: Keys

    /// Installs everyone's keys for this channel's epoch, or for a new epoch once it's come.
    func updateKeys(first: Bool = false) async throws {
        let current = try await session.voiceKey(channelId)
        guard !closed, roomKeys.first?.epoch != current.epoch else { return }
        let index = Voice.keyIndex(epoch: current.epoch)
        roomKeys = [(index, current.key, current.epoch)] + roomKeys.prefix(1)
        for participant in room.remoteParticipants.values {
            guard let identity = participant.identity?.stringValue else { continue }
            keys.setKey(keyData: Voice.senderKey(roomKey: current.key, identity: identity), participantId: identity, index: index)
        }
        sendTask?.cancel()
        let own = Voice.senderKey(roomKey: current.key, identity: identity)
        if first {
            keys.setKey(keyData: own, participantId: identity, index: index)
            keys.setCurrentKeyIndex(index)
            return
        }
        sendTask = Task { [weak self] in
            try? await Task.sleep(for: Self.newKeySendDelay)
            guard let self, !Task.isCancelled, !closed else { return }
            keys.setKey(keyData: own, participantId: identity, index: index)
            keys.setCurrentKeyIndex(index)
        }
    }

    /// The keys a participant may be sending under: the older first, so the newer ends up current.
    private func installFor(_ participant: Participant) {
        guard let identity = participant.identity?.stringValue, identity != self.identity else { return }
        for (index, key, _) in roomKeys.reversed() {
            keys.setKey(keyData: Voice.senderKey(roomKey: key, identity: identity), participantId: identity, index: index)
        }
    }

    /// Which room key is in use now, and for which epoch, for the call's details.
    var currentKey: (index: Int32, epoch: Int)? {
        roomKeys.first.map { ($0.index, $0.epoch) }
    }

    // MARK: Microphone

    /// Whether sound goes out from here.
    func setMuted(_ muted: Bool) async {
        self.muted = muted
        guard let track = micPublication?.track as? LocalAudioTrack else { return }
        do {
            if muted { try await track.mute() } else { try await track.unmute() }
        } catch {
            logger.error("Couldn't change the microphone: \(String(describing: error), privacy: .public)")
        }
    }

    /// An admin muted or unmuted this person, which takes the microphone away or lets it back.
    fileprivate func permissionsChanged() async {
        guard joined else { return }
        let allowed = room.localParticipant.permissions.canPublishSources
        serverMuted = !allowed.isEmpty && !allowed.contains(Track.Source.microphone.rawValue)
        if serverMuted, let publication = micPublication {
            micPublication = nil
            try? await room.localParticipant.unpublish(publication: publication)
        } else if !serverMuted {
            await publishMic()
        }
    }

    // MARK: Listening

    func applyVolumes() {
        for participant in room.remoteParticipants.values {
            guard let user = participant.identity.flatMap({ VoiceIdentity($0.stringValue) })?.userId else { continue }
            for publication in participant.audioTracks {
                (publication.track as? RemoteAudioTrack)?.volume = volumes(user, publication.source)
            }
        }
    }

    fileprivate func subscribed(_ publication: RemoteTrackPublication, of participant: RemoteParticipant) {
        if let track = publication.track as? RemoteAudioTrack, let user = participant.identity.flatMap({ VoiceIdentity($0.stringValue) })?.userId {
            track.volume = volumes(user, publication.source)
        }
        #if DEBUG
        VoiceTesting.watch(publication, of: participant)
        #endif
        events.media()
    }

    // MARK: Video

    /// Everything being sent that can be watched, and from here.
    func videos() -> [CallVideo] {
        var tiles: [CallVideo] = []
        // A native share's sound goes out from the person's own connection, beside the picture from another.
        let sound = Set(room.remoteParticipants.values.compactMap { participant -> String? in
            guard participant.audioTracks.contains(where: { $0.source == .screenShareAudio }) else { return nil }
            return participant.identity.flatMap { VoiceIdentity($0.stringValue) }?.userId
        })
        let participants: [(Participant, Bool)] = [(room.localParticipant, true)] + room.remoteParticipants.values.map { ($0, false) }
        for (participant, local) in participants {
            guard let identity = participant.identity?.stringValue, let parsed = VoiceIdentity(identity) else { continue }
            for publication in participant.videoTracks {
                guard let track = publication.track as? VideoTrack, !publication.isMuted else { continue }
                let source: CallVideo.Source = publication.source == .screenShareVideo ? .screen : .camera
                tiles.append(CallVideo(id: "\(identity)/\(publication.sid.stringValue)", userId: parsed.userId, source: source, track: track, local: local, sound: source == .screen && !local && sound.contains(parsed.userId)))
            }
        }
        return tiles.sorted { $0.id < $1.id }
    }

    var cameraOn: Bool {
        room.localParticipant.isCameraEnabled()
    }

    /// Turns the camera on or off. It throws if there's no camera to use.
    func setCamera(_ on: Bool) async throws {
        #if DEBUG
        if VoiceTesting.fakeCamera {
            try await VoiceTesting.setFakeCamera(on, in: room.localParticipant)
            events.media()
            return
        }
        #endif
        try await room.localParticipant.setCamera(
            enabled: on,
            // H.264 is what the phone encodes in hardware, and everyone else already plays it from shares.
            publishOptions: VideoPublishOptions(name: "camera", simulcast: true, preferredCodec: .h264)
        )
        events.media()
    }

    /// The front camera or the back one.
    func flipCamera() async {
        guard let capturer = room.localParticipant.localVideoTracks.first(where: { $0.source == .camera })?.track.flatMap({ ($0 as? LocalVideoTrack)?.capturer as? CameraCapturer }) else { return }
        _ = try? await capturer.switchCameraPosition()
    }

    var cameraFacingFront: Bool {
        let capturer = room.localParticipant.localVideoTracks.first(where: { $0.source == .camera })?.track.flatMap { ($0 as? LocalVideoTrack)?.capturer as? CameraCapturer }
        return (capturer?.position ?? .front) != .back
    }

    // MARK: Screen

    /// How this device shares its screen. From iOS 27, ScreenCaptureKit's picker lets the app capture other apps
    /// itself. Before it, ReplayKit only lets the app capture its own screen, and a broadcast extension
    /// (ZunaBroadcast) records the rest, handing each frame over a socket in the App Group. The simulator
    /// has no ScreenCaptureKit, on any iOS.
    enum ScreenRoute { case screenCaptureKit, broadcast }

    static var screenRoute: ScreenRoute {
        #if canImport(ScreenCaptureKit)
        if #available(iOS 27.0, *), SCContentSharingPicker.shared.isAvailable { return .screenCaptureKit }
        #endif
        return .broadcast
    }

    /// Whether this device can share its screen at all. The broadcast extension hands its frames over a Unix socket
    /// LiveKit puts in the App Group's container, whose path has to fit in a socket's address. On a device it does,
    /// but the simulator's containers are too deep for it, so there only ScreenCaptureKit could, which it hasn't got.
    static var canShareScreen: Bool {
        #if DEBUG
        if VoiceTesting.fakeScreen { return true }
        #endif
        return screenRoute == .screenCaptureKit || broadcastSocketFits
    }

    private static let broadcastSocketFits: Bool = {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedStorage.appGroup) else { return false }
        // LiveKit's name for it, in BroadcastBundleInfo.
        return container.appendingPathComponent("rtc_SSFD").path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path)
    }()

    /// How long the system's broadcast picker is given to be answered, as long as LiveKit gives ScreenCaptureKit's.
    private static let broadcastWait: Duration = .seconds(60)
    /// How long the media server is given to let a share out, once the server has said yes.
    private static let shareAllowedWait: Duration = .seconds(5)

    /// The share from the broadcast extension, which this room published itself.
    private var broadcastPublication: LocalTrackPublication?
    /// Each share asked for counts, so stopping can tell one that's still starting it's no longer wanted.
    private var screenAttempt = 0

    /// Whether this device's screen is going out.
    var sharingScreen: Bool { room.localParticipant.isScreenShareEnabled() }

    /// Whether it's going out from the broadcast extension, which can be stopped from the system's own controls.
    var sharingByBroadcast: Bool { broadcastPublication != nil }

    /// How this device's share goes out, in words, for the stream stats.
    var shareRoute: String {
        #if DEBUG
        if VoiceTesting.fakeScreen { return "Moving bars, in place of the screen" }
        #endif
        return sharingByBroadcast ? "The broadcast extension" : "ScreenCaptureKit"
    }

    /// Shares this device's screen once the media server lets it, with what the person picks in the system's picker,
    /// or with the broadcast that's already going. It throws LiveKit's `.cancelled` if they change their mind, or
    /// `stopScreen` comes first.
    func startScreen(_ terms: ScreenTerms) async throws {
        screenAttempt += 1
        let mine = screenAttempt
        let wanted = { [weak self] in self.map { !$0.closed && $0.screenAttempt == mine } ?? false }
        // One layer, in H.264, which the phone encodes in hardware, keeping its sharpness over its frame rate, as the desktop's do.
        let publish = VideoPublishOptions(
            screenShareEncoding: VideoEncoding(maxBitrate: terms.kbps * 1000, maxFps: terms.fps),
            simulcast: false,
            preferredCodec: .h264,
            degradationPreference: .maintainResolution
        )
        let capture = ScreenShareCaptureOptions(dimensions: Self.screenDimensions(height: terms.height), fps: terms.fps)
        await whenAllowedToShare()
        guard wanted() else { throw LiveKitError(.cancelled) }
        #if DEBUG
        if VoiceTesting.fakeScreen {
            try await VoiceTesting.setFakeScreen(true, in: room.localParticipant, options: publish)
            events.media()
            return
        }
        #endif
        if Self.screenRoute == .screenCaptureKit, !BroadcastManager.shared.isBroadcasting {
            // Waits for the picker, which stopping the share cancels.
            guard try await room.localParticipant.set(source: .screenShareVideo, enabled: true, captureOptions: capture, publishOptions: publish) != nil else {
                throw LiveKitError(.invalidState, message: "The screen share didn't start")
            }
        } else {
            try await publishBroadcast(capture: capture, publish: publish, wanted: wanted)
        }
        guard wanted() else {
            await stopScreen()
            throw LiveKitError(.cancelled)
        }
        events.media()
    }

    /// Publishes what the broadcast extension records, asking for a broadcast first unless one is already going,
    /// as one started from Control Center is.
    private func publishBroadcast(capture: ScreenShareCaptureOptions, publish: VideoPublishOptions, wanted: () -> Bool) async throws {
        let broadcasts = BroadcastManager.shared
        if !broadcasts.isBroadcasting {
            broadcasts.requestActivation()
            let deadline = ContinuousClock.now + Self.broadcastWait
            while !broadcasts.isBroadcasting {
                guard wanted(), ContinuousClock.now < deadline else { throw LiveKitError(.cancelled) }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
        guard wanted() else { throw LiveKitError(.cancelled) }
        let track = await LocalVideoTrack.createBroadcastScreenCapturerTrack(options: capture)
        do {
            broadcastPublication = try await room.localParticipant.publish(videoTrack: track, options: publish)
        } catch {
            BroadcastSignal.refuse("Zuna couldn't share your screen.")
            throw error
        }
        BroadcastSignal.post(BroadcastSignal.taken)
    }

    /// Stops sharing this device's screen, or asking to: an unanswered picker is put away.
    func stopScreen() async {
        screenAttempt += 1
        #if DEBUG
        if VoiceTesting.fakeScreen {
            try? await VoiceTesting.setFakeScreen(false, in: room.localParticipant, options: VideoPublishOptions())
            events.media()
            return
        }
        #endif
        if let publication = broadcastPublication {
            broadcastPublication = nil
            try? await room.localParticipant.unpublish(publication: publication)
        }
        if BroadcastManager.shared.isBroadcasting { BroadcastManager.shared.requestStop() }
        _ = try? await room.localParticipant.setScreenShare(enabled: false)
        events.media()
    }

    /// Waits to hear from the media server that a share may go out, since it only allows one once the chat server
    /// has told it to. Should that not come, publishing says what's wrong.
    private func whenAllowedToShare() async {
        let deadline = ContinuousClock.now + Self.shareAllowedWait
        while !closed, ContinuousClock.now < deadline {
            let allowed = room.localParticipant.permissions.canPublishSources
            if allowed.isEmpty || allowed.contains(Track.Source.screenShareVideo.rawValue) { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// The size to capture at: the screen's own, or held to `height` across its shorter side, which a phone held
    /// upright has as a computer's screen has its height. Its shape is the screen's upright, as iOS draws it.
    private static func screenDimensions(height: Int) -> Dimensions {
        let screen = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
        let size = screen?.nativeBounds.size ?? CGSize(width: 1080, height: 1920)
        let across = min(size.width, size.height), along = max(size.width, size.height)
        let scale = height > 0 && CGFloat(height) < across ? CGFloat(height) / across : 1
        return Dimensions(width: Int32((across * scale).rounded()), height: Int32((along * scale).rounded()))
    }

    // MARK: Stream stats

    /// Where this connection is, and everything going through it that can be read.
    func statsRoom() -> StatsRoom {
        var streams: [StatsRoom.Stream] = []
        let participants: [(Participant, Bool)] = [(room.localParticipant, true)] + room.remoteParticipants.values.map { ($0, false) }
        for (participant, local) in participants {
            guard let identity = participant.identity?.stringValue, let parsed = VoiceIdentity(identity) else { continue }
            for publication in participant.trackPublications.values {
                guard let track = publication.track else { continue }
                streams.append(StatsRoom.Stream(key: "\(identity)/\(publication.sid.stringValue)", userId: parsed.userId, local: local, source: publication.source, native: parsed.screen, track: track, publication: publication))
            }
        }
        // A native share comes from a participant of its own, who isn't another person.
        let people = room.remoteParticipants.values.filter { participant in participant.identity.flatMap { VoiceIdentity($0.stringValue) }.map { !$0.screen } ?? false }.count + 1
        return StatsRoom(
            url: mediaUrl,
            serverVersion: room.serverVersion,
            serverRegion: room.serverRegion,
            serverNode: room.serverNodeId,
            people: people,
            encrypted: room.e2eeManager != nil,
            keyIndex: currentKey?.index,
            keyEpoch: currentKey?.epoch,
            streams: streams
        )
    }

    // MARK: Closing

    func close() {
        guard !closed else { return }
        closed = true
        sendTask?.cancel()
        // A broadcast would go on recording for a call that's gone.
        if broadcastPublication != nil { BroadcastManager.shared.requestStop() }
        if let listener { room.remove(delegate: listener) }
        listener = nil
        #if DEBUG
        VoiceTesting.stop()
        #endif
        let room = room
        Task { await room.disconnect() }
    }

    fileprivate var isClosed: Bool { closed }

    // MARK: Events

    /// Hears the room on LiveKit's threads and tells the room on the main actor.
    private final class Listener: NSObject, RoomDelegate, @unchecked Sendable {
        private weak var owner: VoiceRoom?

        init(owner: VoiceRoom) {
            self.owner = owner
        }

        private func onMain(_ work: @escaping @MainActor (VoiceRoom) -> Void) {
            Task { @MainActor [weak self] in
                guard let owner = self?.owner, !owner.isClosed else { return }
                work(owner)
            }
        }

        func room(_ room: Room, didUpdateConnectionState connectionState: LiveKit.ConnectionState, from oldConnectionState: LiveKit.ConnectionState) {
            onMain { owner in
                switch connectionState {
                case .connected: owner.events.status(.connected)
                case .reconnecting: owner.events.status(.reconnecting)
                default: break
                }
            }
        }

        func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
            onMain { $0.events.status(.closed(error?.type)) }
        }

        func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
            onMain { owner in
                owner.installFor(participant)
                if let parsed = participant.identity.flatMap({ VoiceIdentity($0.stringValue) }), !parsed.screen {
                    owner.events.participants(parsed.userId, nil)
                }
            }
        }

        func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
            onMain { owner in
                if let parsed = participant.identity.flatMap({ VoiceIdentity($0.stringValue) }), !parsed.screen {
                    owner.events.participants(nil, parsed.userId)
                }
                owner.events.media()
            }
        }

        func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
            onMain { $0.subscribed(publication, of: participant) }
        }

        func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
            onMain { $0.events.media() }
        }

        func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
            onMain { $0.events.media() }
        }

        func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) {
            onMain { $0.events.media() }
        }

        func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) {
            onMain { $0.events.media() }
        }

        func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
            onMain { $0.events.media() }
        }

        func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
            onMain { $0.events.media() }
        }

        func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
            let users = Set(participants.compactMap { participant -> String? in
                guard let parsed = participant.identity.flatMap({ VoiceIdentity($0.stringValue) }), !parsed.screen else { return nil }
                return parsed.userId
            })
            onMain { $0.events.speaking(users) }
        }

        func room(_ room: Room, participant: Participant, didUpdateConnectionQuality quality: ConnectionQuality) {
            guard participant is LocalParticipant else { return }
            onMain { $0.events.quality(quality) }
        }

        func room(_ room: Room, participant: Participant, didUpdatePermissions permissions: ParticipantPermissions) {
            guard participant is LocalParticipant else { return }
            onMain { owner in Task { await owner.permissionsChanged() } }
        }

        func room(_ room: Room, trackPublication: TrackPublication, didUpdateE2EEState state: E2EEState) {
            // Someone new can't open what others send under the old key for a moment, which is expected.
            if state == .decryption_failed || state == .encryption_failed || state == .internal_error {
                Logger(subsystem: "chat.zuna", category: "voice").warning("Voice encryption: \(String(describing: state), privacy: .public)")
            }
            #if DEBUG
            onMain { VoiceTesting.cryption(state, of: trackPublication, in: $0.room) }
            #endif
        }
    }
}
