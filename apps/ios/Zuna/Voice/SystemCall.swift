import AVFoundation
import CallKit
import CryptoKit
import LiveKit
import os
import StoreKit

/// The call as the system knows it, through CallKit: on the lock screen, in the Dynamic Island
/// and the system's call controls, which can mute and end it, and before a phone call that
/// comes in. Nothing goes in the Phone app's recents, which iCloud would keep. CallKit
/// starts the call's audio, so LiveKit's engine waits for it
/// (livekit/client-sdk-swift's README, "Integration with CallKit").
///
/// A direct message's or a group's call ringing this person comes in through it too, as a
/// phone call does. Where CallKit is left out, as on China's App Store, the app rings by itself
/// (`VoiceModel.incoming`).
@MainActor
final class SystemCall: NSObject {
    struct Actions {
        /// Muted or unmuted from the system's controls. False if that can't be done here.
        var mute: (Bool) -> Bool
        /// Ended from the system's controls, or by a phone call taking its place.
        var end: () -> Void
    }

    /// What the system's screen for a call coming in can do with it.
    struct Ringing {
        /// Answered. The call it becomes is the system's current one already.
        var answer: () -> Void
        /// Declined, before it was answered.
        var decline: () -> Void
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
    /// Calls ringing here that the system is showing, by their ID.
    private var ringing: [UUID: Ringing] = [:]
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
    func allowed() async -> Bool {
        guard Self.mayBeAllowed else { return false }
        return await storefront.value != "CHN"
    }

    /// What can be told of `allowed()` at once, as the app launches, without the App Store's country.
    static var mayBeAllowed: Bool {
        #if DEBUG
        // The simulator's CallKit ends a call as soon as it has it, having no audio to give it, and its audio
        // session is the Mac's. Test builds only hand a call to it when a test asks.
        if VoiceTesting.toneMicrophone, !VoiceTesting.systemCall { return false }
        #endif
        return Locale.current.region?.identifier != "CN"
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

    /// The call has come in. One that was answered here already had.
    func connected() {
        guard let current, !hasConnected else { return }
        hasConnected = true
        provider.reportOutgoingCall(with: current, connectedAt: nil)
    }

    // MARK: Calls coming in

    /// The same ID for a call on every device and in every push, so the system shows it once.
    nonisolated static func callId(serverId: String, groupId: String, startedAt: Int) -> UUID {
        var bytes = Array(SHA256.hash(data: Data("zuna/call/v1|\(serverId)|\(groupId)|\(startedAt)".utf8)).prefix(16))
        // A version 5 UUID's layout, as one made from a name.
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    /// Shows a call ringing this person, on the lock screen and over other apps, as a phone call. False where the
    /// system doesn't take it, and the app rings by itself.
    func ring(_ id: UUID, title: String, actions: Ringing) async -> Bool {
        guard await allowed() else { return false }
        if ringing[id] != nil { return true }
        ringing[id] = actions
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: title)
        update.localizedCallerName = title
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        do {
            try await provider.reportNewIncomingCall(with: id, update: update)
            return true
        } catch let error as CXErrorCodeIncomingCallError where error.code == .callUUIDAlreadyExists {
            return true
        } catch {
            logger.warning("The system didn't take a call coming in: \(String(describing: error), privacy: .public)")
            if ringing[id] != nil { ringing[id] = nil }
            return false
        }
    }

    /// A call a VoIP push says is ringing, handed to the system before this returns, as PushKit insists: an app
    /// that doesn't is stopped from being woken. Only ever asked for where CallKit is allowed.
    func ringNow(_ id: UUID, title: String, actions: Ringing) {
        let known = ringing[id] != nil || current == id
        if ringing[id] == nil, current != id { ringing[id] = actions }
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: title)
        update.localizedCallerName = title
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
            guard let error, !known else { return }
            Task { @MainActor in
                self?.logger.warning("The system didn't take a pushed call: \(String(describing: error), privacy: .public)")
                self?.ringing[id] = nil
            }
        }
    }

    /// A push that couldn't be read still has to be reported as a call, so it's reported and ended at once.
    func ringUnreadable() {
        let id = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "Zuna")
        update.localizedCallerName = "Zuna"
        provider.reportNewIncomingCall(with: id, update: update) { [weak self] _ in
            Task { @MainActor in self?.provider.reportCall(with: id, endedAt: nil, reason: .failed) }
        }
    }

    /// What a call ringing here is called, once the app knows.
    func retitle(_ id: UUID, _ title: String) {
        guard ringing[id] != nil else { return }
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: title)
        update.localizedCallerName = title
        provider.reportCall(with: id, updated: update)
    }

    /// Whether the system is ringing for this call.
    func isRinging(_ id: UUID) -> Bool { ringing[id] != nil }

    /// Whether this is the system's current call.
    func isCurrent(_ id: UUID) -> Bool { current == id }

    /// A call stopped ringing here without being answered here: answered or declined on another device, ended, or
    /// not answered for long enough.
    func stopRinging(_ id: UUID, reason: CXCallEndedReason) {
        guard ringing.removeValue(forKey: id) != nil else { return }
        provider.reportCall(with: id, endedAt: nil, reason: reason)
    }

    /// The app has come into the call that was answered from the system's screen, which ends and mutes it from now on.
    func answered(_ id: UUID, actions: Actions) {
        guard current == id else { return }
        self.actions = actions
    }

    /// The system's screen answered a call: it becomes the current call, whose audio CallKit starts, so LiveKit waits.
    private func answeredBySystem(_ id: UUID) -> Bool {
        guard let actions = ringing.removeValue(forKey: id) else { return false }
        // Answering while in another call ended that one first, as the system's screen offered.
        if current != nil { letGo() }
        current = id
        hasConnected = true
        muted = false
        audioActive = false
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        try? AudioManager.shared.setEngineAvailability(.none)
        audioFallback = Task { [weak self] in
            try? await Task.sleep(for: Self.audioWait)
            guard let self, !Task.isCancelled, current == id, !audioActive else { return }
            logger.warning("CallKit didn't start the answered call's audio, so LiveKit does")
            releaseAudio()
        }
        actions.answer()
        return true
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

    /// Ended from the system's controls. One the app ended has already been let go of. One still ringing was declined.
    private func endedBySystem(_ id: UUID) {
        if let declined = ringing.removeValue(forKey: id) {
            declined.decline()
            return
        }
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
            ringing = [:]
            letGo()
            end?()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        // As a call this device starts has it.
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .videoChat, options: [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay, .defaultToSpeaker])
        let id = action.callUUID
        if MainActor.assumeIsolated({ answeredBySystem(id) }) { action.fulfill() } else { action.fail() }
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
