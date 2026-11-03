#if DEBUG
import AVFoundation
import CoreVideo
import Foundation
import LiveKit
import os
import ZunaModels

/// What test builds put in place of the phone's microphone, camera and screen, and how they
/// report what arrives, so a check can tell that media crosses to and from the
/// desktop, encrypted, without a person to listen or a camera to point. Like the
/// fake devices `apps/desktop/test/voice-check.mjs` gives Chromium.
@MainActor
enum VoiceTesting {
    /// A moving picture stands in for the camera, which the simulator hasn't got.
    static var fakeCamera: Bool { UserDefaults.standard.bool(forKey: "ZunaFakeCamera") }
    /// Another stands in for the screen, without the system's picker, which nothing can answer in a test.
    static var fakeScreen: Bool { UserDefaults.standard.bool(forKey: "ZunaFakeScreen") }
    /// A steady 440 Hz tone goes out in place of whatever the microphone hears.
    static var toneMicrophone: Bool { UserDefaults.standard.bool(forKey: "ZunaFakeMicrophone") }
    /// Calls are handed to CallKit, which test builds otherwise leave out (`SystemCall.allowed`).
    static var systemCall: Bool { UserDefaults.standard.bool(forKey: "ZunaSystemCall") }

    /// LiveKit says everything it does, for a check that wants to know why a call didn't connect.
    static func logIfAsked() {
        if UserDefaults.standard.bool(forKey: "ZunaVoiceLog") { LiveKitSDK.setLogLevel(.debug) }
    }

    private static var tone: Tone?
    private static var camera: FakeVideo?
    private static var screen: FakeVideo?
    private static var meters: [String: Meter] = [:]
    private static var cryption: [String: (state: String, failures: Int)] = [:]

    /// Sends the tone without opening the microphone at all: the simulator's is the Mac's, and
    /// starting it can hang until the Mac's own question about it is answered, which takes the
    /// app down. LiveKit then runs its audio without any device, and nothing plays out loud.
    static func prepareAudio() {
        guard toneMicrophone, tone == nil else { return }
        try? AudioManager.shared.setManualRenderingMode(true)
        let tone = Tone()
        self.tone = tone
        AudioManager.shared.capturePostProcessingDelegate = tone
    }

    static func setFakeCamera(_ on: Bool, in participant: LocalParticipant) async throws {
        if on {
            let camera = await FakeVideo.start(name: "camera", source: .camera, width: 640, height: 360)
            self.camera = camera
            _ = try await participant.publish(videoTrack: camera.track, options: VideoPublishOptions(name: "camera", simulcast: true, preferredCodec: .h264))
        } else if let camera {
            self.camera = nil
            camera.stop()
            if let publication = participant.localVideoTracks.first(where: { $0.track === camera.track }) {
                try await participant.unpublish(publication: publication)
            }
        }
    }

    /// Shares a picture the shape of a phone's screen, with what a real share would be published with.
    static func setFakeScreen(_ on: Bool, in participant: LocalParticipant, options: VideoPublishOptions) async throws {
        if on {
            let screen = await FakeVideo.start(name: Track.screenShareVideoName, source: .screenShareVideo, width: 360, height: 780)
            self.screen = screen
            _ = try await participant.publish(videoTrack: screen.track, options: options)
        } else if let screen {
            self.screen = nil
            screen.stop()
            if let publication = participant.localVideoTracks.first(where: { $0.track === screen.track }) {
                try await participant.unpublish(publication: publication)
            }
        }
    }

    /// Measures what arrives from a participant once it's decrypted and decoded.
    static func watch(_ publication: RemoteTrackPublication, of participant: RemoteParticipant) {
        guard let identity = participant.identity?.stringValue else { return }
        let key = "\(identity)/\(publication.source)"
        let meter = Meter(key: key, track: publication.track)
        meters[key] = meter
        if let track = publication.track as? RemoteAudioTrack { track.add(audioRenderer: meter) }
        if let track = publication.track as? RemoteVideoTrack { track.add(videoRenderer: meter) }
    }

    /// What the frame cryptor last said about someone's track, and how often it couldn't open a frame: "ok" once
    /// one opened with the sender's key. So a check can tell a track that doesn't decrypt from one that's quiet.
    static func cryption(_ state: E2EEState, of publication: TrackPublication, in room: Room) {
        guard let identity = room.remoteParticipants.values.first(where: { $0.trackPublications[publication.sid] != nil })?.identity?.stringValue else { return }
        let key = "\(identity)/\(publication.source)"
        let failed = state == .decryption_failed || state == .missing_key || state == .internal_error
        cryption[key] = (state.toString(), (cryption[key]?.failures ?? 0) + (failed ? 1 : 0))
    }

    static func stop() {
        AudioManager.shared.capturePostProcessingDelegate = nil
        tone = nil
        camera?.stop()
        camera = nil
        screen?.stop()
        screen = nil
        meters = [:]
        cryption = [:]
    }

    /// What has arrived from each participant and source, as JSON, for the control server's `voiceReport`.
    static func report() -> String {
        var rows = Dictionary(uniqueKeysWithValues: meters.map { ($0.key, $0.value.reading()) })
        for (key, cryption) in cryption {
            rows[key, default: ["key": key]]["cryption"] = cryption.state
            rows[key]?["failures"] = cryption.failures
        }
        let data = (try? JSONSerialization.data(withJSONObject: Array(rows.values), options: [.sortedKeys])) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Counts frames and how loud the sound was over the last second, and the packets that came for the track.
    private final class Meter: NSObject, AudioRenderer, VideoRenderer, @unchecked Sendable {
        let key: String
        private weak var track: Track?
        private let lock = NSLock()
        private var frames = 0
        private var width = 0
        private var height = 0
        private var loudest = 0.0
        private var lastLoud = Date.distantPast
        private var samples = 0

        init(key: String, track: Track?) {
            self.key = key
            self.track = track
        }

        func reading() -> [String: Any] {
            let packets = track?.statistics?.inboundRtpStream.reduce(0) { $0 + Int($1.packetsReceived ?? 0) } ?? 0
            return lock.withLock {
                // How loud it's been in the last second, so a track that went quiet reads as quiet.
                let level = Date().timeIntervalSince(lastLoud) < 1 ? loudest : 0
                return ["key": key, "frames": frames, "width": width, "height": height, "level": level, "samples": samples, "packets": packets]
            }
        }

        func render(pcmBuffer: AVAudioPCMBuffer) {
            var sum = 0.0
            let count = Int(pcmBuffer.frameLength)
            if let data = pcmBuffer.floatChannelData?[0] {
                for index in 0..<count { sum += Double(data[index] * data[index]) }
            } else if let data = pcmBuffer.int16ChannelData?[0] {
                for index in 0..<count {
                    let sample = Double(data[index]) / 32768
                    sum += sample * sample
                }
            }
            let rms = count > 0 ? (sum / Double(count)).squareRoot() : 0
            lock.withLock {
                samples += count
                let now = Date()
                if now.timeIntervalSince(lastLoud) >= 1 { loudest = 0 }
                if rms > loudest || now.timeIntervalSince(lastLoud) >= 1 {
                    loudest = max(loudest, rms)
                    lastLoud = now
                }
            }
        }

        @MainActor var isAdaptiveStreamEnabled: Bool { false }
        @MainActor var adaptiveStreamSize: CGSize { .zero }

        func render(frame: VideoFrame) {
            lock.withLock {
                frames += 1
                width = Int(frame.dimensions.width)
                height = Int(frame.dimensions.height)
            }
        }
    }

    /// Replaces the microphone's sound with a tone, after the system's processing.
    private final class Tone: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
        private var phase = 0.0
        private var rate = 48_000.0

        func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {
            rate = Double(sampleRateHz)
        }

        func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
            let step = 2 * Double.pi * 440 / rate
            var phase = self.phase
            for channel in 0..<audioBuffer.channels {
                let samples = audioBuffer.rawBuffer(forChannel: channel)
                phase = self.phase
                for index in 0..<audioBuffer.frames {
                    // WebRTC's buffers hold 16-bit sample values as floats.
                    samples[index] = Float(sin(phase) * 0.3 * 32767)
                    phase += step
                }
            }
            self.phase = phase.truncatingRemainder(dividingBy: 2 * .pi)
        }

        func audioProcessingRelease() {}
    }

    /// Frames of moving bars, 30 a second.
    private final class FakeVideo: @unchecked Sendable {
        let track: LocalVideoTrack
        private let capturer: BufferCapturer
        private let width: Int
        private let height: Int
        private var timer: DispatchSourceTimer?
        private var pool: CVPixelBufferPool?
        private var frame = 0

        private init(track: LocalVideoTrack, width: Int, height: Int) {
            self.track = track
            self.width = width
            self.height = height
            capturer = track.capturer as! BufferCapturer
        }

        static func start(name: String, source: Track.Source, width: Int, height: Int) async -> FakeVideo {
            let track = await LocalVideoTrack.createBufferTrack(name: name, source: source)
            let video = FakeVideo(track: track, width: width, height: height)
            video.run()
            return video
        }

        private func run() {
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
            CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "chat.zuna.fake-video"))
            timer.schedule(deadline: .now(), repeating: .milliseconds(33))
            timer.setEventHandler { [weak self] in self?.draw() }
            timer.resume()
            self.timer = timer
        }

        private func draw() {
            guard let pool else { return }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { return }
            CVPixelBufferLockBaseAddress(buffer, [])
            let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
            let row = CVPixelBufferGetBytesPerRow(buffer)
            if let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) {
                for y in 0..<height {
                    for x in 0..<width {
                        let pixel = base + y * row + x * 4
                        let band = ((x + frame * 4) / 80) % 4
                        pixel[0] = band == 0 ? 255 : 40
                        pixel[1] = band == 1 ? 255 : 40
                        pixel[2] = band == 2 ? 255 : 40
                        pixel[3] = 255
                    }
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            frame += 1
            capturer.capture(buffer)
        }

        func stop() {
            timer?.cancel()
            timer = nil
        }
    }
}
#endif
