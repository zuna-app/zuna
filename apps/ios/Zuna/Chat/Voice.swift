import AVFoundation
import SwiftUI
import ZunaModels

/// Voice messages: AAC in MP4, as this app and the desktop on Windows and macOS record
/// them, or Opus in MP4 from the desktop on Linux (lib/voice.ts), with a waveform of
/// one byte per bar.
enum Waveform {
    static let bars = 48

    /// Spreads loudness samples (0 to 1) over the bars, as bytes, base64.
    static func encode(_ levels: [Float]) -> String {
        let peak = max(0.01, levels.max() ?? 0)
        var bytes = [UInt8](repeating: 0, count: bars)
        for bar in 0..<bars {
            let from = bar * levels.count / bars
            let to = max(from + 1, (bar + 1) * levels.count / bars)
            let loudest = levels.isEmpty ? 0 : (levels[min(from, levels.count - 1)..<min(to, levels.count)].max() ?? 0)
            bytes[bar] = UInt8((min(1, loudest / peak) * 255).rounded())
        }
        return Data(bytes).base64EncodedString()
    }

    /// Bar heights from 0 to 1. A message without a waveform gets a flat one.
    static func decode(_ waveform: String?) -> [CGFloat] {
        guard let waveform, let data = Data(base64Encoded: waveform), !data.isEmpty else {
            return Array(repeating: 0.15, count: bars)
        }
        return data.map { CGFloat($0) / 255 }
    }
}

/// Whether a voice channel or a call is going on this device. Its audio session is
/// then CallKit's or LiveKit's, so a voice message plays and records within it and
/// leaves it as it was: `.playback` has no microphone, and deactivating it would stop
/// the call's sound. `VoiceModel` keeps it.
@MainActor
enum CallAudio {
    static var active = false
}

/// Records a voice message from the microphone, sampling how loud it is for the waveform.
@MainActor
@Observable
final class VoiceRecorder {
    struct Recording {
        let url: URL
        let duration: Double
        let waveform: String
    }

    /// Voice messages longer than this are sent when they reach it.
    static let limit: TimeInterval = 15 * 60

    private(set) var levels: [Float] = []
    private(set) var elapsed: TimeInterval = 0
    private(set) var isRecording = false

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var startedAt = Date()
    @ObservationIgnored private var url: URL?
    /// Whether this recording set the audio session up, and so should let it go.
    @ObservationIgnored private var ownsSession = false

    #if DEBUG
    /// UI tests record a tone instead: the simulator's microphone is the Mac's, behind its own permission.
    private var fake: Bool { UserDefaults.standard.bool(forKey: "ZunaFakeMicrophone") }
    #else
    private var fake: Bool { false }
    #endif

    enum Failure: LocalizedError {
        case denied, unavailable
        var errorDescription: String? {
            switch self {
            case .denied: "Zuna can't use the microphone. Allow it in Settings, under Zuna."
            case .unavailable: "The microphone isn't available right now."
            }
        }
    }

    /// Starts recording, asking for the microphone the first time.
    func start() async throws {
        guard !isRecording else { return }
        if !fake {
            guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
            // A call's session already records.
            ownsSession = !CallAudio.active
            if ownsSession {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
                try session.setActive(true)
            }
        }
        try FileManager.default.createDirectory(at: OutgoingFiles.folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let url = OutgoingFiles.folder.appendingPathComponent(UUID().uuidString).appendingPathExtension("m4a")
        if !fake {
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 48_000,
            ])
            recorder.isMeteringEnabled = true
            guard recorder.record() else { throw Failure.unavailable }
            self.recorder = recorder
        }
        self.url = url
        levels = []
        elapsed = 0
        startedAt = Date()
        isRecording = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
    }

    private func sample() {
        elapsed = Date().timeIntervalSince(startedAt)
        let level: Float
        if let recorder {
            recorder.updateMeters()
            // Decibels to 0 to 1, with -50 dB as silence.
            level = max(0, min(1, (recorder.averagePower(forChannel: 0) + 50) / 50))
        } else {
            level = Float(0.5 + 0.45 * sin(elapsed * 9))
        }
        levels.append(level)
    }

    /// Stops and returns the recording.
    func stop() throws -> Recording? {
        guard isRecording, let url else { return nil }
        let duration = Date().timeIntervalSince(startedAt)
        finish()
        if fake {
            try Self.writeTone(to: url, seconds: duration)
        }
        return Recording(url: url, duration: duration, waveform: Waveform.encode(levels))
    }

    /// Stops and throws the recording away.
    func cancel() {
        guard isRecording else { return }
        finish()
        if let url { try? FileManager.default.removeItem(at: url) }
    }

    private func finish() {
        timer?.invalidate()
        timer = nil
        recorder?.stop()
        recorder = nil
        isRecording = false
        // A call that started meanwhile has the session now.
        if ownsSession, !CallAudio.active { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        ownsSession = false
    }

    /// A 440 Hz tone, in place of the microphone, encoded as a real recording is.
    private static func writeTone(to url: URL, seconds: Double) throws {
        let rate = 48_000.0
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 48_000,
        ])
        let frames = AVAudioFrameCount(seconds * rate)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        for frame in 0..<Int(frames) {
            buffer.floatChannelData![0][frame] = Float(sin(Double(frame) / rate * 2 * .pi * 440) * 0.3)
        }
        try file.write(from: buffer)
    }
}

/// Plays voice messages and video messages with their sound, one at a time. Through
/// AVPlayer, as AVAudioPlayer can't read Opus in MP4, which the Linux desktop records.
@MainActor
@Observable
final class VoicePlayer {
    static let shared = VoicePlayer()

    /// The voice message playing or paused, by file ID.
    private(set) var current: String?
    private(set) var isPlaying = false
    private(set) var position: TimeInterval = 0

    @ObservationIgnored private var player: AVPlayer?
    /// The player of a video message playing with its sound, for its circle to show.
    private(set) var videoPlayer: AVPlayer?
    @ObservationIgnored private var ticks: Any?
    @ObservationIgnored private var ended: NSObjectProtocol?

    enum Failure: LocalizedError {
        case unavailable
        var errorDescription: String? { "Sound isn't available right now." }
    }

    func play(_ url: URL, id: String, from time: TimeInterval, video: Bool = false) async throws {
        if current != id || player == nil {
            stop()
            let playable = video ? url : try await Self.playable(url)
            // Another one was asked for meanwhile.
            guard player == nil else { return }
            // Voice messages play even with the phone set to silent, as in other messengers,
            // and within a call's session, which plays and keeps its microphone.
            if !CallAudio.active {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
                try AVAudioSession.sharedInstance().setActive(true)
            }
            let item = AVPlayerItem(url: playable)
            let player = AVPlayer(playerItem: item)
            self.player = player
            videoPlayer = video ? player : nil
            current = id
            ended = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.stop() }
            }
            ticks = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 20), queue: .main) { [weak self] time in
                MainActor.assumeIsolated {
                    if self?.isPlaying == true { self?.position = time.seconds }
                }
            }
        }
        guard let player else { return }
        isPlaying = true
        position = time
        // Playing waits for the seek.
        player.seek(to: CMTime(seconds: time, preferredTimescale: 48_000), toleranceBefore: .zero, toleranceAfter: .zero) { _ in }
        player.play()
        // With nothing to play sound on, or a file it can't read, it never starts, and would never say it finished.
        for _ in 0..<60 where self.player === player && isPlaying {
            if player.timeControlStatus == .playing { return }
            if player.currentItem?.status == .failed { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard self.player === player, isPlaying else { return }
        stop()
        throw Failure.unavailable
    }

    func pause() {
        player?.pause()
        isPlaying = false
    }

    func stop() {
        if let ticks { player?.removeTimeObserver(ticks) }
        if let ended { NotificationCenter.default.removeObserver(ended) }
        ticks = nil
        ended = nil
        player?.pause()
        player = nil
        videoPlayer = nil
        current = nil
        isPlaying = false
        position = 0
    }

    /// The file to play: a copy with its durations put right, for Opus as Chromium writes it (`VoiceFile`).
    private static func playable(_ url: URL) async throws -> URL {
        try await Task.detached {
            guard let fixed = VoiceFile.fixingOpusDurations(try Data(contentsOf: url)) else { return url }
            let copy = url.deletingLastPathComponent().appendingPathComponent("playable-\(url.lastPathComponent)")
            try fixed.write(to: copy, options: [.atomic, .completeFileProtection])
            return copy
        }.value
    }
}

/// A voice message, as in Telegram: play, a waveform that fills as it plays and
/// seeks on a tap, and the time.
struct VoiceCard: View {
    @Environment(AppModel.self) private var model
    @Environment(ImageStore.self) private var images
    let attachment: Attachment
    let serverId: String
    let own: Bool
    let messageId: String
    let uploadProgress: Double?
    @State private var player = VoicePlayer.shared
    @State private var file: URL?
    @State private var loading = false

    var body: some View {
        let accent = model.settings.accent
        let mine = player.current == attachment.fileId && !attachment.fileId.isEmpty
        let duration = attachment.duration ?? 0
        let position = mine ? player.position : 0
        let progress = duration > 0 ? position / duration : 0
        let bars = Waveform.decode(attachment.waveform)
        HStack(spacing: 10) {
            Button {
                toggle(from: mine ? player.position : 0)
            } label: {
                ZStack {
                    Circle().fill(own ? accent.bubbleOwnText : accent.color)
                    if attachment.fileId.isEmpty || loading {
                        ProgressView().tint(own ? accent.bubbleOwn : accent.onAccent)
                    } else {
                        Image(systemName: mine && player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(own ? accent.bubbleOwn : accent.onAccent)
                    }
                }
                .frame(width: 42, height: 42)
            }
            .buttonStyle(.plain)
            .disabled(attachment.fileId.isEmpty)
            .accessibilityLabel(mine && player.isPlaying ? "Pause" : "Play voice message")
            VStack(alignment: .leading, spacing: 4) {
                GeometryReader { geometry in
                    // Each bar's share of the width, as a narrow bubble narrows the whole wave.
                    let step = geometry.size.width / CGFloat(max(1, bars.count))
                    HStack(alignment: .center, spacing: step * 0.45) {
                        ForEach(Array(bars.enumerated()), id: \.offset) { index, height in
                            Capsule()
                                .fill(Double(index) / Double(bars.count) < progress
                                    ? (own ? Color.white : Theme.text1)
                                    : (own ? Color.white.opacity(0.4) : Theme.text3))
                                .frame(width: step * 0.55, height: max(3, height * 22))
                        }
                    }
                    .frame(maxHeight: .infinity)
                    .contentShape(.rect)
                    .onTapGesture { location in
                        toggle(from: min(1, max(0, location.x / geometry.size.width)) * duration, seeking: true)
                    }
                }
                .frame(minWidth: 120, idealWidth: CGFloat(bars.count) * 4.5, maxWidth: CGFloat(bars.count) * 4.5)
                .frame(height: 24)
                Text(Format.duration(mine && (player.isPlaying || position > 0) ? position : duration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(own ? Color.white.opacity(0.55) : Theme.text3)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Chat.voice(messageId))
    }

    private func toggle(from time: TimeInterval, seeking: Bool = false) {
        if player.current == attachment.fileId, player.isPlaying, !seeking {
            player.pause()
            return
        }
        Task {
            do {
                if file == nil {
                    loading = true
                    file = try await images.openable(attachment, serverId: serverId)
                    loading = false
                }
                try await player.play(file!, id: attachment.fileId, from: time)
            } catch {
                loading = false
                model.toast("Couldn't play it: \(ErrorText.describe(error))", .error)
            }
        }
    }
}
