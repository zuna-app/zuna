import LocalAuthentication

/// Unlocking with the device's owner authentication: Face ID, Touch ID or the passcode.
enum AppLock {
    enum Outcome {
        case unlocked
        /// Cancelled, or not them.
        case refused
        /// The phone has no passcode, which Face ID and Touch ID need too, so nothing can unlock it.
        case unavailable
    }

    static var methodName: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "your passcode"
        }
    }

    /// Whether the phone has a passcode to lock with.
    static var available: Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) || !passcodeMissing(error)
    }

    @MainActor
    static func authenticate(reason: String) async -> Outcome {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return passcodeMissing(error) ? .unavailable : .refused
        }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true ? .unlocked : .refused
    }

    private static func passcodeMissing(_ error: NSError?) -> Bool {
        error.map { $0.domain == LAError.errorDomain && $0.code == LAError.Code.passcodeNotSet.rawValue } ?? false
    }
}
