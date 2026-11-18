import AVFoundation
import LiveKit
import LiveKitWebRTC
import os
import UIKit

/// Where a call's sound plays: on an iPhone, the receiver, held to the ear as a phone call is, or
/// the loudspeaker; or headphones, a car, or a Bluetooth or AirPlay device, which iOS moves a call
/// to by itself once one's there, and which the person can pick among. A voice channel starts on
/// the loudspeaker, as the app's calls always did, and so does a call with this device's camera
/// on. A call without it starts at the ear, as Telegram's and FaceTime's do, and moves to the
/// loudspeaker when the camera goes on, unless the person picked. What they pick holds until the
/// call ends. An iPad has no receiver, so it's always the loudspeaker there, or a device.
///
/// The session is set as LiveKit sets it for each (`playAndRecordSpeaker` and
/// `playAndRecordReceiver` in its `AudioSessionConfiguration`) by whatever has it: CallKit's
/// actions while CallKit has the call (`SystemCall`), LiveKit itself without CallKit
/// (`AudioManager.isSpeakerOutputPreferred`), and WebRTC's own session in a Telegram call
/// (`TelegramAudio`). While the sound is at the ear, the screen goes dark against it.
@MainActor
@Observable
final class CallOutput {
    static let shared = CallOutput()

    /// Where the sound plays now.
    enum Route: Equatable {
        case receiver
        case speaker
        /// Headphones, a car, a Bluetooth or AirPlay device, by the name iOS gives it.
        case device(name: String, symbol: String)
    }

    /// Something besides the phone itself that the sound can play through.
    struct Device: Identifiable, Equatable {
        /// The system's ID for it, or `current` for the one playing that can't be picked.
        let id: String
        let name: String
        let symbol: String
    }

    /// What the person picks, among `devices`' IDs.
    nonisolated static let receiverChoice = "receiver"
    nonisolated static let speakerChoice = "speaker"
    nonisolated static let currentChoice = "current"

    /// Whether there's a receiver to hold to the ear: an iPhone has one, an iPad doesn't.
    static let hasReceiver = UIDevice.current.userInterfaceIdiom == .phone

    /// The phone's own sound goes to the loudspeaker, not the receiver.
    private(set) var speaker = true
    private(set) var route: Route = .speaker
    /// What the sound could play through besides the phone: headphones and devices with a
    /// microphone, which can be picked, and the one playing if it can't be.
    private(set) var devices: [Device] = []
    /// What's picked now, among the choices.
    private(set) var selected = CallOutput.speakerChoice
    /// A call's sound is set here, from its start to its end.
    private(set) var active = false
    /// The person chose where it plays in this call.
    @ObservationIgnored private var picked = false
    /// The call's audio session is WebRTC's own, a Telegram call's.
    @ObservationIgnored private var telegram = false
    @ObservationIgnored private let logger = Logger(subsystem: "chat.zuna", category: "voice")

    private init() {
        // Kept as long as the app runs, as this is.
        _ = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init) ?? .unknown
            MainActor.assumeIsolated { self?.routeChanged(reason) }
        }
    }

    /// The session's mode and options for where the phone's own sound goes, as LiveKit's presets have them.
    nonisolated static func preset(speaker: Bool) -> (mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) {
        let options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay]
        return speaker ? (.videoChat, options.union(.defaultToSpeaker)) : (.voiceChat, options)
    }

    /// The session as it should be now, for CallKit's actions to set.
    var preset: (mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) { Self.preset(speaker: speaker) }

    /// A call or a voice channel is starting here, on the loudspeaker or at the ear. One already
    /// going on is over.
    func begin(speaker: Bool, telegram: Bool = false) {
        if active { end() }
        active = true
        picked = false
        self.telegram = telegram
        self.speaker = speaker || !Self.hasReceiver
        settle()
        refresh()
    }

    /// The call is over: nothing is held for it, so a voice message plays as it would have.
    func end() {
        guard active else { return }
        active = false
        picked = false
        let session = AVAudioSession.sharedInstance()
        try? session.overrideOutputAudioPort(.none)
        if session.preferredInput != nil { try? session.setPreferredInput(nil) }
        telegram = false
        refresh()
    }

    /// This device's camera went on: a call held at the ear moves to the loudspeaker, unless the person chose.
    func cameraOn() {
        guard active, !picked, !speaker else { return }
        speaker = true
        settle()
        configure(preset: true) { _ in }
        refresh()
    }

    /// The loudspeaker on, or off for the receiver, or headphones or a device while there's one.
    func toggleSpeaker() {
        pick(speaker ? Self.receiverChoice : Self.speakerChoice)
    }

    /// Plays the call through the receiver, the loudspeaker, or a device, by its ID among `devices`.
    func pick(_ choice: String) {
        guard active, choice != Self.currentChoice else { return }
        picked = true
        switch choice {
        case Self.speakerChoice:
            speaker = true
            settle()
            // Over headphones or a device too, which iOS would otherwise keep.
            configure(preset: true) { try $0.override(.speaker) }
        case Self.receiverChoice where Self.hasReceiver:
            speaker = false
            settle()
            let microphone = AVAudioSession.sharedInstance().availableInputs?.first { $0.portType == .builtInMic }
            configure(preset: true) { session in
                try session.override(.none)
                // A Bluetooth device keeps the call unless the phone's own microphone is asked for.
                if let microphone { try session.prefer(microphone) }
            }
        default:
            guard let port = AVAudioSession.sharedInstance().availableInputs?.first(where: { $0.uid == choice }) else { break }
            configure(preset: false) { session in
                try session.override(.none)
                try session.prefer(port)
            }
        }
        refresh()
    }

    // MARK: The session

    /// What sets the session up from now on: WebRTC's configuration, which a Telegram call's audio
    /// starts with and goes back to whenever it starts again, and LiveKit's own preference, which
    /// it follows without CallKit.
    private func settle() {
        Self.setWebRTC(speaker: speaker)
        if !telegram { AudioManager.shared.isSpeakerOutputPreferred = speaker }
    }

    /// Before a Telegram call's audio is first made, so that it starts as `begin` said.
    func prepareWebRTC() {
        Self.setWebRTC(speaker: speaker)
    }

    private static func setWebRTC(speaker: Bool) {
        let (mode, options) = preset(speaker: speaker)
        let configuration = LKRTCAudioSessionConfiguration.webRTC()
        configuration.category = AVAudioSession.Category.playAndRecord.rawValue
        configuration.mode = mode.rawValue
        configuration.categoryOptions = options
        LKRTCAudioSessionConfiguration.setWebRTC(configuration)
    }

    /// The session itself, as AVFoundation's, or WebRTC's in a Telegram call, which WebRTC holds a lock on.
    private enum Session {
        case plain(AVAudioSession)
        case webRTC(LKRTCAudioSession)

        func set(speaker: Bool) throws {
            let (mode, options) = CallOutput.preset(speaker: speaker)
            switch self {
            case let .plain(session): try session.setCategory(.playAndRecord, mode: mode, options: options)
            case let .webRTC(session): try session.setCategory(.playAndRecord, mode: mode, options: options)
            }
        }

        func override(_ port: AVAudioSession.PortOverride) throws {
            switch self {
            case let .plain(session): try session.overrideOutputAudioPort(port)
            case let .webRTC(session): try session.overrideOutputAudioPort(port)
            }
        }

        /// The microphone the call takes, and with it the device it plays through, or none to leave it to iOS.
        func prefer(_ input: AVAudioSessionPortDescription?) throws {
            // WebRTC's own takes no `nil`, so iOS is asked directly for that.
            if case let .webRTC(session) = self, let input {
                try session.setPreferredInput(input)
            } else {
                try AVAudioSession.sharedInstance().setPreferredInput(input)
            }
        }
    }

    /// Changes the session for the call, with its mode and options for `speaker` first where the
    /// app sets them: while CallKit has the call, as LiveKit leaves the session alone then, and in
    /// a Telegram call. Without CallKit, LiveKit set them already, from `settle`.
    private func configure(preset: Bool, _ change: (Session) throws -> Void) {
        do {
            if telegram {
                let rtc = LKRTCAudioSession.sharedInstance()
                rtc.lockForConfiguration()
                defer { rtc.unlockForConfiguration() }
                let session = Session.webRTC(rtc)
                if preset { try session.set(speaker: speaker) }
                try change(session)
            } else {
                let session = Session.plain(AVAudioSession.sharedInstance())
                if preset, !AudioManager.shared.audioSession.isAutomaticConfigurationEnabled { try session.set(speaker: speaker) }
                try change(session)
            }
        } catch {
            logger.warning("Couldn't move the call's sound: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: Following the route

    private func routeChanged(_ reason: AVAudioSession.RouteChangeReason) {
        guard active else { return }
        let output = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType
        switch reason {
        case .newDeviceAvailable:
            // Headphones or a device that's just come take the call, as they would a phone call, whatever was picked before.
            configure(preset: false) { session in
                try session.override(.none)
                try session.prefer(nil)
            }
        case .override where output == .builtInSpeaker || output == .builtInReceiver:
            // The system's own call controls moved it, as on the lock screen.
            let onSpeaker = output == .builtInSpeaker
            if onSpeaker != speaker {
                speaker = onSpeaker
                picked = true
                settle()
            }
        default:
            break
        }
        refresh()
    }

    /// What the route is, what else there is, and the screen going dark at the ear.
    private func refresh() {
        let session = AVAudioSession.sharedInstance()
        let output = session.currentRoute.outputs.first
        let input = session.currentRoute.inputs.first
        var devices = (session.availableInputs ?? []).filter { $0.portType != .builtInMic }.map {
            Device(id: $0.uid, name: $0.portName, symbol: Self.symbol($0.portType))
        }
        if let output, ![.builtInSpeaker, .builtInReceiver].contains(output.portType) {
            route = .device(name: output.portName, symbol: Self.symbol(output.portType))
            if let input, devices.contains(where: { $0.id == input.uid }) {
                selected = input.uid
            } else {
                // Headphones without a microphone, or AirPlay, which the phone's microphone goes with.
                devices.insert(Device(id: Self.currentChoice, name: output.portName, symbol: Self.symbol(output.portType)), at: 0)
                selected = Self.currentChoice
            }
        } else {
            // Before the call's audio starts, the route is still what it was: the call's is what it'll be.
            route = speaker ? .speaker : .receiver
            selected = speaker ? Self.speakerChoice : Self.receiverChoice
        }
        if self.devices != devices { self.devices = devices }
        UIDevice.current.isProximityMonitoringEnabled = active && route == .receiver
    }

    private static func symbol(_ port: AVAudioSession.Port) -> String {
        switch port {
        case .carAudio: "car.fill"
        case .airPlay: "airplayaudio"
        case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .headphones, .headsetMic: "headphones"
        default: "hifispeaker.fill"
        }
    }

    #if DEBUG
    /// Where the call's sound goes, for tests.
    var report: [String: Any] {
        let session = AVAudioSession.sharedInstance()
        return [
            "active": active,
            "speaker": speaker,
            "selected": selected,
            "proximity": UIDevice.current.isProximityMonitoringEnabled,
            "livekitSpeaker": AudioManager.shared.isSpeakerOutputPreferred,
            "webrtcMode": LKRTCAudioSessionConfiguration.webRTC().mode,
            "mode": session.mode.rawValue,
            "defaultToSpeaker": session.categoryOptions.contains(.defaultToSpeaker),
        ]
    }
    #endif
}
