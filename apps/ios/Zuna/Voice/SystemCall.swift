import AVFoundation
import CallKit
import LiveKit
import os
import StoreKit

/// The call as the system knows it, through CallKit: on the lock screen, in the Dynamic Island
/// and the system's call controls, which can mute and end it, and before a phone call that
/// comes in. Nothing goes in the Phone app's recents, which iCloud would keep. CallKit
/// starts the call's audio, so LiveKit's engine waits for it
/// (livekit/client-sdk-swift's README, "Integration with CallKit").
@MainActor
final class SystemCall: NSObject {
    struct Actions {
        /// Muted or unmuted from the system's controls. False if that can't be done here.
        var mute: (Bool) -> Bool
        /// Ended from the system's controls, or by a phone call taking its place.
        var end: () -> Void
    }

    private let provider: CXProvider
    private let controller = CXCallController()
    private var actions: Actions?
    /// The call the system has, if it has one.
    private var current: UUID?
    /// Whether the call has come in, as the system was told.
    private var hasConnected = false
    /// Whether the system shows the call muted.
    private var muted = false
    /// Whether CallKit has started the call's audio.
    private var audioActive = false
    /// Should CallKit not start the audio, the call still has sound, without it.
    private var audioFallback: Task<Void, Never>?
    private let logger = Logger(subsystem: "chat.zuna", category: "voice")

    /// How long CallKit is given to start the audio before LiveKit starts it itself.
    private static let audioWait: Duration = .seconds(3)

    /// The App Store's country, looked up as the app starts, since coming into a channel waits for it.
    private let storefront = Task { await Storefront.current?.countryCode }

    /// Apps on the App Store in mainland China may not use CallKit. The phone's region alone doesn't tell: someone
    /// on China's App Store can have theirs set elsewhere.
    private func allowed() async -> Bool {
        #if DEBUG
        // The simulator's CallKit ends a call as soon as it has it, having no audio to give it, and its audio
        // session is the Mac's. Test builds only hand a call to it when a test asks.
        if VoiceTesting.toneMicrophone, !VoiceTesting.systemCall { return false }
        #endif
        if Locale.current.region?.identifier == "CN" { return false }
        return await storefront.value != "CHN"
    }

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// Hands a call that's starting to the system, which then shows it as connecting.
    func start(title: String, actions: Actions) async {
        // Asked first, so nothing waits between ending the last call and taking this one.
        let handOver = await allowed()
        end()
        guard handOver else { return }
        let id = UUID()
        current = id
        hasConnected = false
        muted = false
        self.actions = actions
        // CallKit starts the audio once it has the call, so LiveKit leaves it until then.
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        try? AudioManager.shared.setEngineAvailability(.none)
        do {
            try await controller.request(CXTransaction(action: CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: title))))
        } catch {
            logger.warning("The system didn't take the call: \(String(describing: error), privacy: .public)")
            if current == id { letGo() }
            return
        }
        #if DEBUG
        handed = true
        #endif
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: title)
        update.localizedCallerName = title
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportCall(with: id, updated: update)
        audioFallback = Task { [weak self] in
            try? await Task.sleep(for: Self.audioWait)
            guard let self, !Task.isCancelled, current == id, !audioActive else { return }
            logger.warning("CallKit didn't start the call's audio, so LiveKit does")
            releaseAudio()
        }
    }

    /// The call has come in.
    func connected() {
        guard let current else { return }
        hasConnected = true
        provider.reportOutgoingCall(with: current, connectedAt: nil)
    }

    /// The call's camera went on or off, which the system shows as a video call or not.
    func video(_ on: Bool) {
        guard let current else { return }
        let update = CXCallUpdate()
        update.hasVideo = on
        provider.reportCall(with: current, updated: update)
    }

    /// Shows the call muted or not, as it is in the app.
    func setMuted(_ muted: Bool) {
        guard let current, muted != self.muted else { return }
        self.muted = muted
        let controller = controller
        Task { try? await controller.request(CXTransaction(action: CXSetMutedCallAction(call: current, muted: muted))) }
    }

    /// The app ended the call.
    func end() {
        guard let current else { return }
        letGo()
        let controller = controller, provider = provider
        Task {
            do {
                try await controller.request(CXTransaction(action: CXEndCallAction(call: current)))
            } catch {
                provider.reportCall(with: current, endedAt: nil, reason: .failed)
            }
        }
    }

    /// The call ended without anyone here ending it: the server took this device out, or it couldn't connect.
    func ended(failed: Bool) {
        guard let current else { return }
        letGo()
        provider.reportCall(with: current, endedAt: nil, reason: failed ? .failed : .remoteEnded)
    }

    /// Forgets the call, and gives the audio back to LiveKit, as it is without CallKit.
    private func letGo() {
        current = nil
        actions = nil
        audioActive = false
        releaseAudio()
    }

    private func releaseAudio() {
        audioFallback?.cancel()
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = true
        try? AudioManager.shared.setEngineAvailability(.default)
    }

    /// Ended from the system's controls. One the app ended has already been let go of.
    private func endedBySystem(_ id: UUID) {
        guard id == current else { return }
        // Before the call has come in, it's the system that couldn't keep it, as the simulator's can't, and the
        // call goes on without it, as calls did before CallKit.
        guard hasConnected else {
            logger.warning("The system ended the call before it came in, so it goes on without CallKit")
            return letGo()
        }
        let end = actions?.end
        letGo()
        end?()
    }

    /// Muted or unmuted from the system's controls, or as the app asked. False if the app can't do it.
    private func mutedBySystem(_ id: UUID, _ muted: Bool) -> Bool {
        guard id == current else { return false }
        if muted != self.muted, actions?.mute(muted) == false { return false }
        self.muted = muted
        return true
    }

    #if DEBUG
    /// Whether the system took the last call it was handed, for tests.
    private var handed = false

    /// What the system has of the call, for tests.
    var report: [String: Any] {
        ["handed": handed, "current": current != nil, "connected": hasConnected]
    }
    #endif
}

extension SystemCall: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            let end = actions?.end
            letGo()
            end?()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        // As LiveKit has it with the speaker, which is where the app's calls have always played.
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .videoChat, options: [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay, .defaultToSpeaker])
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let id = action.callUUID
        action.fulfill()
        MainActor.assumeIsolated { endedBySystem(id) }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let id = action.callUUID, muted = action.isMuted
        if MainActor.assumeIsolated({ mutedBySystem(id, muted) }) { action.fulfill() } else { action.fail() }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            guard current != nil else { return }
            audioActive = true
            audioFallback?.cancel()
            do {
                try AudioManager.shared.setEngineAvailability(.default)
            } catch {
                logger.error("Couldn't start the call's audio: \(String(describing: error), privacy: .public)")
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            guard current != nil else { return }
            audioActive = false
            // A call still with the system waits for its audio to start again.
            try? AudioManager.shared.setEngineAvailability(.none)
        }
    }
}
