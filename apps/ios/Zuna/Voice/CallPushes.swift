import Foundation
import PushKit

/// Calls ringing this phone while Zuna isn't running. A VoIP push through PushKit wakes the
/// app, which has to hand the call to CallKit at once, before it has caught up with its server
/// (`rangByPush` in VoiceModel). Only where CallKit is allowed: elsewhere, as on China's App
/// Store, no VoIP token is asked for, and the server pushes a notification instead, which the
/// notification extension words.
@MainActor
final class CallPushes: NSObject {
    private let registry = PKPushRegistry(queue: .main)
    /// The VoIP token as hex, once PushKit has given one.
    private(set) var token: String? {
        didSet { if token != oldValue { onToken?(token) } }
    }
    var onToken: ((String?) -> Void)?
    /// A push that rings: the call has to be with CallKit by the time this returns.
    var onRing: ((PushStore.Message?) -> Void)?

    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }
}

extension CallPushes: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated { token = hex }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        MainActor.assumeIsolated { token = nil }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let push = PushStore.open(payload.dictionaryPayload)
        MainActor.assumeIsolated { onRing?(push) }
        completion()
    }
}
