import AVFoundation
import AVKit
import os
import SwiftUI
import UIKit
import ZunaModels

/// Video messages, as Telegram's: up to a minute of the front camera, square, shown in a
/// circle. H.264 and AAC in MP4, as the desktop records them where it can
/// (packages/ui/src/lib/round.ts).
@MainActor
@Observable
final class RoundRecorder {
    struct Recording {
        let url: URL
        let duration: Double
        /// The first frame, small and blurred, as `Attachment.thumb`.
        let thumb: String?
    }

    /// Video messages longer than this are sent when they reach it.
    static let limit: TimeInterval = 60
    /// How many pixels across a video message is.
    static let size = 480

    private static let log = Logger(subsystem: "chat.zuna", category: "round")

    #if DEBUG
    /// The control channel starting and stopping a recording, as holding the button and letting go do.
    static let control = Notification.Name("ZunaRoundControl")
    #endif

    private(set) var elapsed: TimeInterval = 0
    private(set) var isRecording = false
    /// The camera is on and its circle shows: from just before recording, until it's over.
    private(set) var isPreviewing = false

    /// What the camera sees, for the circle the person watches themselves in while recording.
    @ObservationIgnored let session = AVCaptureSession()
    /// The camera as the person sees themselves, mirrored as a mirror is. It's made before the session starts:
    /// one added to a session that's already recording rebuilds it, which stops the recording.
    @ObservationIgnored private(set) lazy var preview: AVCaptureVideoPreviewLayer = {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        return layer
    }()
    @ObservationIgnored private let output = AVCaptureMovieFileOutput()
    @ObservationIgnored private let queue = DispatchQueue(label: "chat.zuna.round")
    @ObservationIgnored private let delegate = RecordingDelegate()
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var startedAt = Date()
    @ObservationIgnored private var raw: URL?
    /// Keeps the preview level with the screen, which for the front camera, mirrored, isn't the recording's own turn.
    @ObservationIgnored private var rotation: AVCaptureDevice.RotationCoordinator?
    @ObservationIgnored private var rotationWatch: NSKeyValueObservation?

    #if DEBUG
    /// UI tests record moving bars instead: the simulator has no camera.
    private var fake: Bool { VoiceTesting.fakeCamera }
    #else
    private var fake: Bool { false }
    #endif

    enum Failure: LocalizedError {
        case camera, microphone, unavailable, unrecorded, unreadable
        var errorDescription: String? {
            switch self {
            case .camera: "Zuna can't use the camera. Allow it in Settings, under Zuna."
            case .microphone: "Zuna can't use the microphone. Allow it in Settings, under Zuna."
            case .unavailable: "The camera isn't available right now."
            case .unrecorded: "The camera stopped recording. Try again."
            case .unreadable: "The video message couldn't be made."
            }
        }
    }

    /// Starts recording, asking for the camera and the microphone the first time.
    func start() async throws {
        guard !isRecording else { return }
        if fake {
            try FileManager.default.createDirectory(at: OutgoingFiles.folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            try begin(OutgoingFiles.folder.appendingPathComponent(UUID().uuidString).appendingPathExtension("mov"))
            return
        }
        guard await AVCaptureDevice.requestAccess(for: .video) else { throw Failure.camera }
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.microphone }
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let microphone = AVCaptureDevice.default(for: .audio),
              let cameraInput = try? AVCaptureDeviceInput(device: camera),
              let microphoneInput = try? AVCaptureDeviceInput(device: microphone) else { throw Failure.unavailable }
        // The app's audio is set up for recording here rather than by the session, which keeps the mode it finds:
        // after a call that's the call's, which the camera's recording can't take sound in (kAudioUnitErr_FormatNotSupported).
        // An audio session of the recording's own interrupts the app's, which ends the recording a moment in.
        session.automaticallyConfiguresApplicationAudioSession = false
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .videoRecording, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audio.setActive(true)
        session.beginConfiguration()
        for input in session.inputs { session.removeInput(input) }
        session.sessionPreset = .hd1280x720
        guard session.canAddInput(cameraInput), session.canAddInput(microphoneInput), session.outputs.contains(output) || session.canAddOutput(output) else {
            session.commitConfiguration()
            throw Failure.unavailable
        }
        session.addInput(cameraInput)
        session.addInput(microphoneInput)
        if !session.outputs.contains(output) { session.addOutput(output) }
        if let connection = output.connection(with: .video) {
            // Upright, and as others see the person rather than as a mirror does.
            if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = false
            }
        }
        session.commitConfiguration()
        let rotation = AVCaptureDevice.RotationCoordinator(device: camera, previewLayer: preview)
        self.rotation = rotation
        preview.connection?.videoRotationAngle = rotation.videoRotationAngleForHorizonLevelPreview
        rotationWatch = rotation.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            Task { @MainActor in self?.preview.connection?.videoRotationAngle = angle }
        }
        output.maxRecordedDuration = CMTime(seconds: Self.limit + 1, preferredTimescale: 600)
        // Starting takes a while, so it's done off the main thread, as Apple says; the session copes.
        nonisolated(unsafe) let starting = session
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async {
                starting.startRunning()
                done.resume()
            }
        }
        guard session.isRunning else { throw Failure.unavailable }
        // The circle shows first, and recording waits for the preview to be on screen and turned level with it:
        // turning the preview once recording has started rebuilds the session, which ends the recording there.
        isPreviewing = true
        for _ in 0..<40 where preview.superlayer == nil {
            try? await Task.sleep(for: .milliseconds(25))
        }
        try? await Task.sleep(for: .milliseconds(150))
        rotationWatch?.invalidate()
        rotationWatch = nil
        if preview.connection?.videoRotationAngle != rotation.videoRotationAngleForHorizonLevelPreview {
            preview.connection?.videoRotationAngle = rotation.videoRotationAngleForHorizonLevelPreview
        }
        // A recording started before the camera's connection is live captures nothing.
        for _ in 0..<40 where output.connection(with: .video)?.isActive != true {
            try await Task.sleep(for: .milliseconds(25))
        }
        delegate.error = nil
        try FileManager.default.createDirectory(at: OutgoingFiles.folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let raw = OutgoingFiles.folder.appendingPathComponent(UUID().uuidString).appendingPathExtension("mov")
        // The clock starts once the camera really writes, a moment after it's asked to, so what's shown is what's sent.
        await withCheckedContinuation { (started: CheckedContinuation<Void, Never>) in
            delegate.onStart = { started.resume() }
            output.startRecording(to: raw, recordingDelegate: delegate)
        }
        try begin(raw)
    }

    /// Where the camera's file goes, and the clock, from now.
    private func begin(_ raw: URL) throws {
        self.raw = raw
        isPreviewing = true
        elapsed = 0
        startedAt = Date()
        isRecording = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.elapsed = Date().timeIntervalSince(self.startedAt)
            }
        }
    }

    /// Stops, and returns the recording, square and ready to send.
    func stop() async throws -> Recording? {
        guard isRecording, let raw else { return nil }
        let duration = min(Self.limit, Date().timeIntervalSince(startedAt))
        await finish()
        defer { try? FileManager.default.removeItem(at: raw) }
        #if DEBUG
        if fake { try await Self.writeBars(to: raw, seconds: duration) }
        #endif
        if let error = delegate.error, (error as NSError).userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool != true {
            Self.log.error("Recording a video message failed: \(String(describing: error), privacy: .public)")
            throw Failure.unrecorded
        }
        do {
            let url = try await Self.square(raw)
            // As long as what was really recorded, which the clock can only come close to.
            let recorded = (try? await AVURLAsset(url: url).load(.duration).seconds).flatMap { $0 > 0 ? $0 : nil } ?? duration
            let camera = (try? await AVURLAsset(url: raw).load(.duration).seconds) ?? -1
            Self.log.info("A video message: \(duration, privacy: .public) s by the clock, \(camera, privacy: .public) s from the camera, \(recorded, privacy: .public) s made square")
            return Recording(url: url, duration: recorded, thumb: await Self.thumb(url))
        } catch {
            let size = (try? FileManager.default.attributesOfItem(atPath: raw.path)[.size] as? Int) ?? -1
            Self.log.error("Making a video message square failed, from \(size) bytes: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    /// Stops and throws the recording away.
    func cancel() {
        guard isRecording, let raw else { return }
        Task {
            await finish()
            try? FileManager.default.removeItem(at: raw)
        }
    }

    private func finish() async {
        timer?.invalidate()
        timer = nil
        isRecording = false
        isPreviewing = false
        rotationWatch?.invalidate()
        rotationWatch = nil
        if fake { return }
        if output.isRecording {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                delegate.onFinish = { done.resume() }
                output.stopRecording()
            }
        }
        nonisolated(unsafe) let stopping = session
        queue.async {
            stopping.stopRunning()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// The middle of the recording, square, upright and smaller, as H.264 and AAC in MP4.
    private static func square(_ source: URL) async throws -> URL {
        let asset = AVURLAsset(url: source)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Failure.unreadable }
        // The frames are already upright, as the connection was asked, and as the preview showed them. The file's
        // own turn is how the phone was held as it started, which a picture already upright mustn't be turned by again.
        let natural = try await track.load(.naturalSize)
        let side = min(natural.width, natural.height)
        let scale = CGFloat(size) / side
        let placed = CGAffineTransform(translationX: -(natural.width - side) / 2, y: -(natural.height - side) / 2)
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
        layer.setTransform(placed, at: .zero)
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: try await asset.load(.duration))
        instruction.layerInstructions = [layer]
        let composition = AVMutableVideoComposition()
        composition.renderSize = CGSize(width: size, height: size)
        composition.frameDuration = CMTime(value: 1, timescale: 30)
        composition.instructions = [instruction]
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else { throw Failure.unreadable }
        export.videoComposition = composition
        export.shouldOptimizeForNetworkUse = true
        let target = OutgoingFiles.folder.appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
        try await export.export(to: target, as: .mp4)
        return target
    }

    #if DEBUG
    /// Moving bars, wider than tall as a camera's picture is, in place of the camera.
    private static func writeBars(to url: URL, seconds: Double) async throws {
        let width = 640, height = 360, fps = 30
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw Failure.unreadable }
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<max(1, Int(seconds * Double(fps))) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            guard let pool = adaptor.pixelBufferPool else { throw Failure.unreadable }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { throw Failure.unreadable }
            CVPixelBufferLockBaseAddress(buffer, [])
            let row = CVPixelBufferGetBytesPerRow(buffer)
            let pixels = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
            for y in 0..<height {
                for x in 0..<width {
                    let bar = ((x + frame * 8) / 80) % 4
                    let at = y * row + x * 4
                    pixels[at] = bar == 0 ? 220 : 40
                    pixels[at + 1] = bar == 1 ? 220 : 40
                    pixels[at + 2] = bar == 2 ? 220 : 40
                    pixels[at + 3] = 255
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw Failure.unreadable }
    }
    #endif

    /// A tiny, blurred copy of a frame near the start, as a picture's preview is.
    private static func thumb(_ url: URL) async -> String? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.maximumSize = CGSize(width: 32, height: 32)
        guard let (frame, _) = try? await generator.image(at: CMTime(seconds: 0.2, preferredTimescale: 600)),
              let jpeg = UIImage(cgImage: frame).jpegData(compressionQuality: 0.6) else { return nil }
        return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }
}

/// Hears when the camera's file is finished, which is when it can be read.
private final class RecordingDelegate: NSObject, AVCaptureFileOutputRecordingDelegate, @unchecked Sendable {
    var onFinish: (() -> Void)?
    var onStart: (() -> Void)?
    /// How the last recording ended, if it went wrong, which can be after the file was finished all the same.
    var error: Error?

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        let start = onStart
        onStart = nil
        start?()
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        self.error = error
        // One that never started still finishes, with why.
        let start = onStart
        onStart = nil
        start?()
        let finish = onFinish
        onFinish = nil
        finish?()
    }
}

/// The camera, as the person sees themselves, filling a circle: the recorder's own preview, which it
/// made before recording, as one added later would stop the recording.
struct CameraPreview: UIViewRepresentable {
    let preview: AVCaptureVideoPreviewLayer

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.layer.addSublayer(preview)
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}

    static func dismantleUIView(_ view: PreviewView, coordinator: ()) {
        view.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    }

    final class PreviewView: UIView {
        override func layoutSubviews() {
            super.layoutSubviews()
            layer.sublayers?.forEach { $0.frame = bounds }
        }
    }
}

/// A video for a player, filling the view. A video message's circle clips it.
struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer?

    func makeUIView(context: Context) -> SurfaceView {
        let view = SurfaceView()
        view.surface.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: SurfaceView, context: Context) {
        if view.surface.player !== player { view.surface.player = player }
    }

    final class SurfaceView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var surface: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// A video message in a chat, as in Telegram: a circle that plays by itself without sound,
/// over and over, and from the start with sound on a tap, a ring going round as it plays.
struct RoundVideoCard: View {
    @Environment(AppModel.self) private var model
    @Environment(ImageStore.self) private var images
    let attachment: Attachment
    let serverId: String
    let messageId: String
    let uploadProgress: Double?
    @State private var player = VoicePlayer.shared
    @State private var file: URL?
    @State private var looping: AVQueuePlayer?
    @State private var looper: AVPlayerLooper?
    @State private var failed = false

    static let diameter: CGFloat = 220

    var body: some View {
        let accent = model.settings.accent
        let mine = player.current == attachment.fileId && !attachment.fileId.isEmpty
        let duration = attachment.duration ?? 0
        let progress = mine && duration > 0 ? min(1, player.position / duration) : 0
        ZStack {
            if let thumb = attachment.thumb.flatMap(ImageStore.thumbnail) {
                Image(uiImage: thumb).resizable().scaledToFill()
            } else {
                Theme.bg3
            }
            PlayerSurface(player: mine ? player.videoPlayer : looping)
            if attachment.fileId.isEmpty || (file == nil && !failed) {
                ProgressView().tint(.white)
            } else if failed {
                Image(systemName: "exclamationmark.circle").font(.title2).foregroundStyle(.white)
            }
            Circle()
                .trim(from: 0, to: progress)
                .stroke(accent.color, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .padding(2)
            Text(Format.duration(mine && player.isPlaying ? player.position : duration))
                .font(.caption.monospacedDigit().weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(.black.opacity(0.45), in: .capsule)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, 14)
            if !mine || !player.isPlaying {
                Image(systemName: "speaker.slash.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(6)
                    .background(.black.opacity(0.45), in: .circle)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.top, 14)
                    .opacity(file == nil ? 0 : 1)
            }
        }
        .frame(width: Self.diameter, height: Self.diameter)
        .clipShape(.circle)
        .contentShape(.circle)
        .onTapGesture { toggle() }
        .task(id: attachment.fileId) { await load() }
        .onChange(of: mine) { _, playing in
            // Back to playing by itself, without sound, once it's been heard.
            if playing { looping?.pause() } else { looping?.play() }
        }
        .onDisappear {
            looping?.pause()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Video message, \(Format.duration(duration))")
        .accessibilityValue(mine && player.isPlaying ? "Playing" : "")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(A11y.Chat.round(messageId))
    }

    /// The file, decrypted once, and then a copy of it playing without sound, over and over.
    private func load() async {
        guard !attachment.fileId.isEmpty, file == nil else { return }
        do {
            let url = try await images.openable(attachment, serverId: serverId)
            file = url
            let queue = AVQueuePlayer()
            queue.isMuted = true
            queue.preventsDisplaySleepDuringVideoPlayback = false
            looper = AVPlayerLooper(player: queue, templateItem: AVPlayerItem(url: url))
            looping = queue
            if player.current != attachment.fileId { queue.play() }
        } catch {
            failed = true
        }
    }

    private func toggle() {
        guard let file else { return }
        if player.current == attachment.fileId {
            if player.isPlaying { player.stop() } else { Task { try? await player.play(file, id: attachment.fileId, from: player.position, video: true) } }
            return
        }
        Task {
            do {
                try await player.play(file, id: attachment.fileId, from: 0, video: true)
            } catch {
                model.toast("Couldn't play it: \(OnboardingText.describe(error))", .error)
            }
        }
    }
}
