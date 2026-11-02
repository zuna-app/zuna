import AVFoundation
import Foundation
import LiveKit
import os
import ZunaModels

/// One video someone is sending. Mirrors `CallVideo` in packages/ui/src/voice/room.ts.
struct CallVideo: Identifiable, Equatable {
    enum Source { case camera, screen }
    let id: String
    let userId: String
    let source: Source
    let track: VideoTrack
    let local: Bool

    static func == (a: CallVideo, b: CallVideo) -> Bool { a.id == b.id && a.track === b.track }
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
        let participants: [(Participant, Bool)] = [(room.localParticipant, true)] + room.remoteParticipants.values.map { ($0, false) }
        for (participant, local) in participants {
            guard let identity = participant.identity?.stringValue, let parsed = VoiceIdentity(identity) else { continue }
            for publication in participant.videoTracks {
                guard let track = publication.track as? VideoTrack, !publication.isMuted else { continue }
                let source: CallVideo.Source = publication.source == .screenShareVideo ? .screen : .camera
                tiles.append(CallVideo(id: "\(identity)/\(publication.sid.stringValue)", userId: parsed.userId, source: source, track: track, local: local))
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

    // MARK: Closing

    func close() {
        guard !closed else { return }
        closed = true
        sendTask?.cancel()
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
