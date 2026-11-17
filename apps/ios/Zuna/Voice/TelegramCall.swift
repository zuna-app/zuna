import AVFoundation
import Foundation
import LiveKitWebRTC
import os
import SwiftUI
import ZunaHost
import ZunaModels

// A Telegram call's sound and picture (docs/TELEGRAM_CALLS_PLAN.md, The media): one peer
// connection, made with LiveKit's WebRTC taken directly, as its SDK keeps its own to itself, and
// beside its rooms, never in one. It's a pair of hands: the core says what to do with it
// (`telegram_call_media`), in order, and is told what comes of it. It relays only, through
// Telegram's TURN servers at Telegram's own addresses, so the other person never learns this
// device's, and it reads nothing the other side sends but media and the data channel's text,
// which goes to the core. The desktop's `voice/telegram/media.rs`.

/// The call's audio session, which is WebRTC's own here, not LiveKit's: CallKit starts it, as it
/// does a room's for LiveKit (`SystemCall`), and the call waits for it. Without CallKit, as on
/// China's App Store and in the tests, the call starts it itself.
@MainActor
enum TelegramAudio {
    /// Whether the call started the session itself, and so stops it.
    private static var startedHere = false

    /// Set before the factory's audio is made: the session as a call of Zuna's has it, with the
    /// speaker, and nothing started until CallKit says so.
    static func prepare() {
        let configuration = LKRTCAudioSessionConfiguration.webRTC()
        configuration.category = AVAudioSession.Category.playAndRecord.rawValue
        configuration.mode = AVAudioSession.Mode.videoChat.rawValue
        configuration.categoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay, .defaultToSpeaker]
        LKRTCAudioSessionConfiguration.setWebRTC(configuration)
        let session = LKRTCAudioSession.sharedInstance()
        session.useManualAudio = true
        session.isAudioEnabled = false
    }

    /// CallKit started the call's audio.
    static func activated(_ session: AVAudioSession) {
        let rtc = LKRTCAudioSession.sharedInstance()
        rtc.audioSessionDidActivate(session)
        rtc.isAudioEnabled = true
    }

    /// CallKit stopped it, as for a phone call coming in.
    static func deactivated(_ session: AVAudioSession) {
        let rtc = LKRTCAudioSession.sharedInstance()
        rtc.audioSessionDidDeactivate(session)
        rtc.isAudioEnabled = false
    }

    /// Without CallKit: the call starts the session itself.
    static func startHere() {
        let rtc = LKRTCAudioSession.sharedInstance()
        guard !rtc.isAudioEnabled else { return }
        rtc.lockForConfiguration()
        do {
            try rtc.setConfiguration(LKRTCAudioSessionConfiguration.webRTC(), active: true)
            startedHere = true
        } catch {
            Logger(subsystem: "chat.zuna", category: "voice").error("The Telegram call's audio didn't start: \(String(describing: error), privacy: .public)")
        }
        rtc.unlockForConfiguration()
        rtc.isAudioEnabled = true
    }

    /// The call is over: nothing plays or records for it any more.
    static func stop() {
        let rtc = LKRTCAudioSession.sharedInstance()
        rtc.isAudioEnabled = false
        guard startedHere else { return }
        startedHere = false
        rtc.lockForConfiguration()
        try? rtc.setActive(false)
        rtc.unlockForConfiguration()
    }
}

@MainActor
final class TelegramMedia {
    struct Events {
        /// What's being sent and shown changed.
        var media: () -> Void
        /// The other side's app took none of the codecs this stream goes in.
        var refused: (_ stream: String) -> Void
    }

    /// The one factory, made the first time a call needs it, with an audio device of its own,
    /// which plays and records only while a Telegram call has its session (`TelegramAudio`).
    fileprivate static let factory: LKRTCPeerConnectionFactory = {
        TelegramAudio.prepare()
        LKRTCInitializeSSL()
        return LKRTCPeerConnectionFactory(
            audioDeviceModuleType: .platformDefault,
            bypassVoiceProcessing: false,
            encoderFactory: LKRTCDefaultVideoEncoderFactory(),
            decoderFactory: LKRTCDefaultVideoDecoderFactory(),
            audioProcessingModule: nil
        )
    }()

    /// The offer the one called answers before it makes its first: the data channel's section
    /// alone, with ICE and DTLS parameters that stand for the other side's until its first answer
    /// gives them (`FIRST_OFFER` in the desktop's `voice/telegram/media.rs`).
    static let firstOffer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS *\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:zuna\r\na=ice-pwd:zunazunazunazunazunazuna\r\na=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00\r\na=setup:active\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n"

    let id: Int
    let caller: Bool
    private let session: SessionCalls?
    private let events: Events
    private let pc: LKRTCPeerConnection
    private let listener: Listener
    private let microphone: LKRTCAudioTrack
    private var data: LKRTCDataChannel?
    /// What each section the other side sends is, by MID, as its answers said.
    private var tracks: [String: String] = [:]
    /// What the other side sends, by MID.
    private var remotes: [String: LKRTCMediaStreamTrack] = [:]
    private var camera: Camera?
    /// The relays on this device it reaches Telegram's through, with a proxy set.
    private let proxy: CallProxy?
    private var commands: AsyncStream<TelegramCallMedia>.Continuation?
    private var listening: Task<Void, Never>?
    private var closed = false
    /// How loud the other person comes out here, from 0, which covers being deafened.
    private var volume = 1.0
    /// When the other person was last heard above a whisper.
    private var loudAt: Date?
    private let logger = Logger(subsystem: "chat.zuna", category: "voice")

    /// This device's camera, going out on its own transceiver, made the first time it's turned on.
    private struct Camera {
        let transceiver: LKRTCRtpTransceiver
        let source: LKRTCVideoSource
        let track: LKRTCVideoTrack
        let capturer: LKRTCCameraVideoCapturer
        var on = false
        var front = true
    }

    /// Makes the call's peer connection, through these relays alone, with the microphone going out
    /// on it. It throws if WebRTC won't make one.
    init(session: SessionCalls?, id: Int, servers: [LKRTCIceServer], proxy: CallProxy?, caller: Bool, muted: Bool, events: Events) throws {
        self.session = session
        self.id = id
        self.caller = caller
        self.proxy = proxy
        self.events = events
        let listener = Listener()
        self.listener = listener
        guard let pc = Self.connection(servers: servers, caller: caller, delegate: listener) else {
            proxy?.close()
            throw TelegramMediaError.noConnection
        }
        self.pc = pc.connection
        microphone = pc.microphone
        data = pc.data
        microphone.isEnabled = !muted
        listener.owner = self
        data?.delegate = listener
        let (stream, continuation) = AsyncStream.makeStream(of: TelegramCallMedia.self)
        commands = continuation
        listening = Task { [weak self] in
            for await command in stream {
                guard let self, !closed else { break }
                do {
                    try await run(command)
                } catch {
                    logger.warning("Telegram call: \(command.kind, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
        listenForSpeaking()
    }

    /// A peer connection as a call makes one: relaying only, through these servers; the
    /// microphone going out on a transceiver that only sends, the other side's sound and picture
    /// coming on their own; and the data channel, `data`, on stream 0, which the caller opens and
    /// the one called has ready, so that the section for it is in its offers too.
    static func connection(servers: [LKRTCIceServer], caller: Bool, delegate: LKRTCPeerConnectionDelegate?) -> (connection: LKRTCPeerConnection, microphone: LKRTCAudioTrack, data: LKRTCDataChannel?)? {
        let configuration = LKRTCConfiguration()
        configuration.iceServers = servers
        configuration.iceTransportPolicy = .relay
        configuration.continualGatheringPolicy = .gatherContinually
        configuration.sdpSemantics = .unifiedPlan
        configuration.bundlePolicy = .maxBundle
        configuration.rtcpMuxPolicy = .require
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: configuration, constraints: constraints, delegate: delegate) else { return nil }
        let source = factory.audioSource(with: constraints)
        let microphone = factory.audioTrack(with: source, trackId: "microphone")
        let sending = LKRTCRtpTransceiverInit()
        sending.direction = .sendOnly
        sending.streamIds = ["zuna"]
        guard pc.addTransceiver(with: microphone, init: sending) != nil else {
            pc.close()
            return nil
        }
        let channel = LKRTCDataChannelConfiguration()
        channel.isOrdered = true
        channel.isNegotiated = !caller
        channel.channelId = 0
        let data = pc.dataChannel(forLabel: "data", configuration: channel)
        return (pc, microphone, data)
    }

    /// Turns the relays Telegram named into ones WebRTC may use: only TURN, only over UDP, only at one
    /// of Telegram's addresses, whatever port it gave, and with a proxy set, the ports on loopback
    /// that carry them there. None left means the call can't be had.
    static func relays(_ servers: [TelegramCallServer], through proxy: CallProxy?) -> [LKRTCIceServer] {
        var out: [LKRTCIceServer] = []
        for server in servers.prefix(16) where !server.username.isEmpty && !server.password.isEmpty {
            let urls = server.urls.compactMap { url -> String? in
                guard let (address, port) = relayAddress(url), allowedRelay(address) else { return nil }
                guard let proxy else { return url }
                guard let local = proxy.udpRelay(to: address, port: port) else { return nil }
                return "turn:\(local.address):\(local.port)?transport=udp"
            }
            if !urls.isEmpty { out.append(LKRTCIceServer(urlStrings: urls, username: server.username, credential: server.password)) }
        }
        return out
    }

    /// The address and port of a `turn:` URL as the core writes it: `turn:1.2.3.4:3478?transport=udp`, or
    /// `turn:[2001:db8::1]:3478?transport=udp`.
    static func relayAddress(_ url: String) -> (String, UInt16)? {
        guard url.hasPrefix("turn:"), url.hasSuffix("?transport=udp") else { return nil }
        let rest = url.dropFirst("turn:".count).dropLast("?transport=udp".count)
        guard let colon = rest.lastIndex(of: ":"), let port = UInt16(rest[rest.index(after: colon)...]), port > 0 else { return nil }
        var host = rest[..<colon]
        if host.hasPrefix("[") {
            guard host.hasSuffix("]") else { return nil }
            host = host.dropFirst().dropLast()
        }
        let address = String(host)
        guard IPv4Address(address) != nil || IPv6Address(address) != nil else { return nil }
        return (address, port)
    }

    /// Telegram's addresses, and in test builds asked to, a relay of the test's own on this machine.
    private static func allowedRelay(_ address: String) -> Bool {
        #if DEBUG
        if VoiceTesting.loopbackRelays, address == "127.0.0.1" || address == "::1" { return true }
        #endif
        return TelegramRanges.contains(address)
    }

    /// The legacy options as the desktop's are set, so that no section loses the direction it has.
    static let offering = LKRTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "true"], optionalConstraints: nil)

    // MARK: What the core says

    /// One thing the core said to do, which is done before the next.
    func command(_ media: TelegramCallMedia) {
        commands?.yield(media)
    }

    private func run(_ command: TelegramCallMedia) async throws {
        switch command.kind {
        case "offer":
            Self.receive(pc, audio: command.receive?.audio ?? 1, video: command.receive?.video ?? 1)
            if !caller, pc.localDescription == nil { try await Self.answerFirst(pc) }
            let offer = try await Self.offer(pc)
            guard let session else { return }
            let prepared = try await session.telegramCallOffer(id, sdp: offer.sdp)
            guard !closed else { return }
            try await Self.setLocal(pc, LKRTCSessionDescription(type: .offer, sdp: prepared))
        case "answer":
            for (mid, kind) in command.tracks ?? [:] { tracks[mid] = kind }
            try await Self.setRemote(pc, LKRTCSessionDescription(type: .answer, sdp: command.sdp ?? ""))
            // What the other side sends where nothing was before: each section the answer says it sends.
            var changed = false
            for transceiver in pc.transceivers where transceiver.direction == .recvOnly && tracks[transceiver.mid] != nil && remotes[transceiver.mid] == nil {
                remotes[transceiver.mid] = transceiver.receiver.track
                changed = true
            }
            if changed {
                applyVolume()
                events.media()
            }
        case "candidate":
            guard let line = command.candidate else { return }
            let candidate = LKRTCIceCandidate(sdp: line, sdpMLineIndex: Int32(command.index ?? 0), sdpMid: command.mid)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                pc.add(candidate) { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        case "send":
            guard let text = command.text, let data else { return }
            data.sendData(LKRTCDataBuffer(data: Data(text.utf8), isBinary: false))
        case "refused":
            events.refused(command.stream ?? "")
        case "close":
            close()
        default:
            break
        }
    }

    // MARK: Descriptions

    /// Adds transceivers that only take the other side's streams, until there are as many of each kind as asked.
    static func receive(_ pc: LKRTCPeerConnection, audio: Int, video: Int) {
        let taking = LKRTCRtpTransceiverInit()
        taking.direction = .recvOnly
        for (type, wanted) in [(LKRTCRtpMediaType.audio, audio), (.video, video)] {
            let have = pc.transceivers.filter { $0.direction == .recvOnly && $0.mediaType == type }.count
            for _ in have..<max(have, min(wanted, 4)) { _ = pc.addTransceiver(of: type, init: taking) }
        }
    }

    /// Makes the one called ICE's controlled agent and DTLS's server, for the whole call, by
    /// answering an offer before it sets one of its own. WebRTC makes whoever sets an offer first
    /// the controlling agent, and Telegram's own apps take the caller for that and never give way:
    /// they answer each check of a controlling callee as a role conflict, and never connect.
    static func answerFirst(_ pc: LKRTCPeerConnection) async throws {
        try await setRemote(pc, LKRTCSessionDescription(type: .offer, sdp: firstOffer))
        let answer = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<LKRTCSessionDescription, Error>) in
            pc.answer(for: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { description, error in
                if let description { continuation.resume(returning: description) } else { continuation.resume(throwing: error ?? TelegramMediaError.noDescription) }
            }
        }
        try await setLocal(pc, answer)
    }

    static func offer(_ pc: LKRTCPeerConnection) async throws -> LKRTCSessionDescription {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<LKRTCSessionDescription, Error>) in
            pc.offer(for: offering) { description, error in
                if let description { continuation.resume(returning: description) } else { continuation.resume(throwing: error ?? TelegramMediaError.noDescription) }
            }
        }
    }

    static func setLocal(_ pc: LKRTCPeerConnection, _ description: LKRTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    static func setRemote(_ pc: LKRTCPeerConnection, _ description: LKRTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(description) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    // MARK: Sound

    /// Whether sound goes out from here. Muted, the microphone sends silence, and keeps running so
    /// iOS doesn't chime and the call goes on in the background.
    func setMuted(_ muted: Bool) {
        microphone.isEnabled = !muted
    }

    /// How loud the other person comes out here, which covers being deafened.
    func setVolume(_ volume: Double) {
        self.volume = volume
        applyVolume()
    }

    private func applyVolume() {
        for track in remotes.values {
            (track as? LKRTCAudioTrack)?.source.volume = volume
        }
    }

    /// Whether the other person is speaking right now.
    var speaking: Bool { loudAt.map { Date().timeIntervalSince($0) < 0.4 } ?? false }

    /// Reads how loud the other person is a few times a second, for how they're drawn.
    private func listenForSpeaking() {
        Task { [weak self] in
            var was = false
            while let self, !closed {
                let level = await Self.inboundLevel(pc)
                if level > 0.035 { loudAt = Date() }
                if speaking != was {
                    was = speaking
                    events.media()
                }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
    }

    private static func inboundLevel(_ pc: LKRTCPeerConnection) async -> Double {
        await withCheckedContinuation { continuation in
            pc.statistics { report in
                let level = report.statistics.values.filter { $0.type == "inbound-rtp" && $0.values["kind"] as? String == "audio" }
                    .compactMap { ($0.values["audioLevel"] as? NSNumber)?.doubleValue }.max() ?? 0
                continuation.resume(returning: level)
            }
        }
    }

    // MARK: Pictures

    /// The other side's pictures, as they come, each by its section.
    var remoteVideos: [(mid: String, track: LKRTCVideoTrack)] {
        remotes.compactMap { mid, track in (track as? LKRTCVideoTrack).map { (mid, $0) } }.sorted { $0.mid < $1.mid }
    }

    /// This device's camera, while it's on.
    var localVideo: LKRTCVideoTrack? { camera?.on == true ? camera?.track : nil }
    var cameraOn: Bool { camera?.on == true }
    var cameraFront: Bool { camera?.front ?? true }

    /// Turns the camera on or off. On the first time, it's a stream the other side hasn't been
    /// offered yet, which the core offers once it hears of it. Off, it stops sending pictures and
    /// the other side is told, as Telegram's apps do, rather than the stream going.
    func setCamera(_ on: Bool) async throws {
        guard !closed else { return }
        if !on {
            guard var camera, camera.on else { return }
            await withCheckedContinuation { continuation in camera.capturer.stopCapture { continuation.resume() } }
            camera.on = false
            self.camera = camera
            events.media()
            return
        }
        if camera == nil {
            let source = Self.factory.videoSource()
            let track = Self.factory.videoTrack(with: source, trackId: "camera")
            let sending = LKRTCRtpTransceiverInit()
            sending.direction = .sendOnly
            sending.streamIds = ["zuna"]
            guard let transceiver = pc.addTransceiver(with: track, init: sending) else { throw TelegramMediaError.noCamera }
            camera = Camera(transceiver: transceiver, source: source, track: track, capturer: LKRTCCameraVideoCapturer(delegate: source))
        }
        guard var camera else { return }
        try await Self.capture(camera.capturer, front: camera.front)
        camera.on = true
        self.camera = camera
        events.media()
    }

    /// The front camera or the back one.
    func flipCamera() async {
        guard var camera, camera.on else { return }
        do {
            try await Self.capture(camera.capturer, front: !camera.front)
            camera.front.toggle()
            self.camera = camera
            events.media()
        } catch {
            logger.warning("The camera didn't turn: \(String(describing: error), privacy: .public)")
        }
    }

    /// Captures from a camera at about 720p and 30 frames a second, as a room's camera goes.
    private static func capture(_ capturer: LKRTCCameraVideoCapturer, front: Bool) async throws {
        let devices = LKRTCCameraVideoCapturer.captureDevices()
        guard let device = devices.first(where: { $0.position == (front ? .front : .back) }) ?? devices.first else { throw TelegramMediaError.noCamera }
        let formats = LKRTCCameraVideoCapturer.supportedFormats(for: device)
        let format = formats.min { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription), db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return abs(Int(da.height) - 720) + abs(Int(da.width) - 1280) < abs(Int(db.height) - 720) + abs(Int(db.width) - 1280)
        }
        guard let format else { throw TelegramMediaError.noCamera }
        let fps = min(30, Int(format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30))
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            capturer.startCapture(with: device, format: format, fps: fps) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    // MARK: Closing

    /// Closes everything of the call's: the connection, what it was playing and showing.
    func close() {
        guard !closed else { return }
        closed = true
        commands?.finish()
        commands = nil
        listening?.cancel()
        if let camera { camera.capturer.stopCapture() }
        remotes = [:]
        data?.delegate = nil
        data?.close()
        data = nil
        pc.close()
        proxy?.close()
    }

    var isClosed: Bool { closed }

    // MARK: What WebRTC says

    fileprivate func generated(_ candidate: String) {
        guard !closed, let session else { return }
        // The core sends only a relay's, but the line goes to it whole.
        Task { try? await session.telegramCallCandidate(id, candidate: candidate) }
    }

    fileprivate func connectionChanged(_ state: LKRTCPeerConnectionState) {
        let word: String
        switch state {
        case .connected: word = "connected"
        case .disconnected: word = "disconnected"
        case .failed: word = "failed"
        // The first answer resets DTLS for a moment, which is nothing to tell.
        default: return
        }
        guard !closed, let session else { return }
        Task { try? await session.telegramCallConnection(id, state: word) }
    }

    fileprivate func dataOpened() {
        guard !closed, let session else { return }
        Task { try? await session.telegramCallConnection(id, state: "data") }
    }

    fileprivate func heard(_ text: String) {
        guard !closed, let session, text.utf8.count <= 16_384 else { return }
        Task { try? await session.telegramCallHeard(id, text: text) }
    }

    fileprivate func dataChannelCame(_ channel: LKRTCDataChannel) {
        guard !closed, channel.label == "data" else { return }
        data = channel
        channel.delegate = listener
    }

    /// Hears the peer connection on WebRTC's threads, and tells the call on the main actor.
    private final class Listener: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate, @unchecked Sendable {
        weak var owner: TelegramMedia?

        private func onMain(_ work: @escaping @MainActor (TelegramMedia) -> Void) {
            Task { @MainActor [weak self] in
                guard let owner = self?.owner, !owner.isClosed else { return }
                work(owner)
            }
        }

        func peerConnection(_: LKRTCPeerConnection, didChange state: LKRTCPeerConnectionState) {
            onMain { $0.connectionChanged(state) }
        }

        func peerConnection(_: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
            let line = candidate.sdp
            onMain { $0.generated(line) }
        }

        func peerConnection(_: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
            onMain { $0.dataChannelCame(dataChannel) }
        }

        func peerConnectionShouldNegotiate(_: LKRTCPeerConnection) {}
        func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCIceConnectionState) {}
        func peerConnection(_: LKRTCPeerConnection, didRemove _: LKRTCMediaStream) {}
        func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCSignalingState) {}
        func peerConnection(_: LKRTCPeerConnection, didAdd _: LKRTCMediaStream) {}
        func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCIceGatheringState) {}
        func peerConnection(_: LKRTCPeerConnection, didRemove _: [LKRTCIceCandidate]) {}

        func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {
            guard dataChannel.readyState == .open else { return }
            onMain { $0.dataOpened() }
        }

        func dataChannel(_: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
            let text = String(decoding: buffer.data, as: UTF8.self)
            onMain { $0.heard(text) }
        }
    }
}

enum TelegramMediaError: Error {
    case noConnection, noDescription, noCamera
}

/// A picture of a Telegram call, the other side's or this device's camera, drawn by WebRTC.
struct TelegramVideoView: UIViewRepresentable {
    let track: LKRTCVideoTrack
    var fill = true
    var mirror = false

    final class Coordinator {
        var track: LKRTCVideoTrack?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> LKRTCMTLVideoView {
        let view = LKRTCMTLVideoView(frame: .zero)
        view.clipsToBounds = true
        track.add(view)
        context.coordinator.track = track
        update(view)
        return view
    }

    func updateUIView(_ view: LKRTCMTLVideoView, context: Context) {
        if context.coordinator.track !== track {
            context.coordinator.track?.remove(view)
            track.add(view)
            context.coordinator.track = track
        }
        update(view)
    }

    private func update(_ view: LKRTCMTLVideoView) {
        view.videoContentMode = fill ? .scaleAspectFill : .scaleAspectFit
        view.transform = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    }

    static func dismantleUIView(_ view: LKRTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track?.remove(view)
    }
}

#if DEBUG
/// What this WebRTC and the core make of each other's descriptions, for `tests/e2e/src/telegram-call-run.ts`,
/// as `voice/telegram/media/tests.rs` checks the desktop's: the offers this WebRTC makes, kept as files the
/// core's tests read, and the answers the core writes from them, which a real peer connection here must
/// take, the caller as ICE's controlling agent and the one called as its controlled one. Nothing of it
/// connects anywhere: no relay is given, and nothing is gathered.
@MainActor
enum TelegramCallFixtures {
    /// The calls' shapes: the caller's and the one called's first offers, by voice, and the caller's once its camera is on.
    static let shapes: [(name: String, caller: Bool, camera: Bool)] = [("caller", true, false), ("callee", false, false), ("caller-camera", true, true)]

    /// A peer connection as a call makes one in a shape, with its offer.
    private static func peer(caller: Bool, camera: Bool) async throws -> (LKRTCPeerConnection, LKRTCSessionDescription) {
        guard let made = TelegramMedia.connection(servers: [], caller: caller, delegate: nil) else { throw TelegramMediaError.noConnection }
        let pc = made.connection
        if camera {
            let track = TelegramMedia.factory.videoTrack(with: TelegramMedia.factory.videoSource(), trackId: "camera")
            let sending = LKRTCRtpTransceiverInit()
            sending.direction = .sendOnly
            sending.streamIds = ["zuna"]
            guard pc.addTransceiver(with: track, init: sending) != nil else { throw TelegramMediaError.noCamera }
        }
        TelegramMedia.receive(pc, audio: 1, video: 1)
        if !caller { try await TelegramMedia.answerFirst(pc) }
        return (pc, try await TelegramMedia.offer(pc))
    }

    /// Each shape's offer, as JSON: `{ shape: sdp }`.
    static func offers() async -> String {
        var out: [String: String] = [:]
        for shape in shapes {
            do {
                let (pc, offer) = try await peer(caller: shape.caller, camera: shape.camera)
                out[shape.name] = offer.sdp
                pc.close()
            } catch {
                out[shape.name] = "error: \(error)"
            }
        }
        return json(out)
    }

    /// What of an offer is this peer connection's own, in order: its ICE name and password, its
    /// certificate's fingerprint, its CNAME and its SSRCs.
    private static func own(_ sdp: String) -> [String] {
        let lines = sdp.components(separatedBy: "\r\n")
        var found: [String] = []
        for prefix in ["a=ice-ufrag:", "a=ice-pwd:", "a=fingerprint:sha-256 "] {
            if let line = lines.first(where: { $0.hasPrefix(prefix) }) { found.append(String(line.dropFirst(prefix.count))) }
        }
        if let cname = lines.lazy.compactMap({ line -> String? in
            guard line.hasPrefix("a=ssrc:"), let range = line.range(of: " cname:") else { return nil }
            return String(line[range.upperBound...])
        }).first { found.append(cname) }
        for line in lines where line.hasPrefix("a=ssrc:") {
            let ssrc = String(line.dropFirst("a=ssrc:".count).prefix { $0 != " " })
            if !found.contains(ssrc) { found.append(ssrc) }
        }
        return found
    }

    /// Sets the core's answers on real peer connections, from `{ shape: { prepared, answer } }`, and says
    /// for each what was taken: `{ shape: { error?, receiving, sending, roles, orientation } }`.
    static func check(_ given: String) async -> String {
        guard let pairs = (try? JSONSerialization.jsonObject(with: Data(given.utf8))) as? [String: [String: String]] else { return json(["error": "unreadable"]) }
        var report: [String: Any] = [:]
        for shape in shapes {
            guard let pair = pairs[shape.name], let prepared = pair["prepared"], let answer = pair["answer"] else { continue }
            var result: [String: Any] = [:]
            do {
                let (pc, offer) = try await peer(caller: shape.caller, camera: shape.camera)
                defer { pc.close() }
                // The offer as the core gave it back, made this peer connection's own.
                let theirs = own(prepared), mine = own(offer.sdp)
                guard theirs.count == mine.count else { throw TelegramMediaError.noDescription }
                var sdp = prepared
                for (from, to) in zip(theirs, mine) { sdp = sdp.replacingOccurrences(of: from, with: "\u{0}\(to)\u{0}") }
                sdp = sdp.replacingOccurrences(of: "\u{0}", with: "")
                try await TelegramMedia.setLocal(pc, LKRTCSessionDescription(type: .offer, sdp: sdp))
                try await TelegramMedia.setRemote(pc, LKRTCSessionDescription(type: .answer, sdp: answer))
                var receiving = 0
                var sending: [String] = []
                for transceiver in pc.transceivers {
                    var direction = LKRTCRtpTransceiverDirection.inactive
                    guard transceiver.currentDirection(&direction) else { continue }
                    if direction == .recvOnly { receiving += 1 }
                    if direction == .sendOnly, let track = transceiver.sender.track { sending.append(track.trackId) }
                }
                result["receiving"] = receiving
                result["sending"] = sending
                result["roles"] = await withCheckedContinuation { continuation in
                    pc.statistics { stats in
                        continuation.resume(returning: stats.statistics.values.filter { $0.type == "transport" }.compactMap { $0.values["iceRole"] as? String })
                    }
                }
                // WebRTC offers a section again with only the header extensions its last answer had, so
                // a section quiet for now still has the picture's orientation for when it isn't.
                let again = try await TelegramMedia.offer(pc).sdp
                result["orientation"] = again.components(separatedBy: "m=").filter { $0.hasPrefix("video") }.allSatisfy { $0.contains("urn:3gpp:video-orientation") }
            } catch {
                result["error"] = String(describing: error)
            }
            report[shape.name] = result
        }
        return json(report)
    }

    private static func json(_ value: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
