import Foundation
import JavaScriptCore

/// How hard a new password is to guess, with the estimator the desktop and the
/// web use, in a JavaScriptCore context of its own (Resources/zuna-password.js,
/// built from apps/ios/core-bundle/src/password.ts). The script loads on first use.
public final class PasswordMeter: @unchecked Sendable {
    public struct Strength: Equatable, Sendable {
        /// 0 for nothing typed, then 1 to 4. Sign-up and changing a password ask for 2 or more.
        public let score: Int
        public let label: String

        public static let none = Strength(score: 0, label: "")
    }

    public static let shared = PasswordMeter()

    private let queue = DispatchQueue(label: "chat.zuna.password", qos: .userInitiated)
    private var context: JSContext?

    /// `related` is what anyone guessing would try first, such as the username and display name.
    public func strength(_ password: String, related: [String] = []) async -> Strength {
        guard !password.isEmpty else { return .none }
        return await withCheckedContinuation { continuation in
            queue.async { [self] in
                continuation.resume(returning: rate(password, related: related))
            }
        }
    }

    private func rate(_ password: String, related: [String]) -> Strength {
        guard let context = loadedContext(),
              let json = context.objectForKeyedSubscript("__zunaPasswordStrength").call(withArguments: [password, related])?.toString(),
              let data = json.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let score = raw["score"] as? Int, let label = raw["label"] as? String else {
            // Without the estimator, nothing counts as strong enough.
            return Strength(score: 1, label: "Too easy to guess")
        }
        return Strength(score: score, label: label)
    }

    private func loadedContext() -> JSContext? {
        if let context { return context }
        guard let url = Bundle.module.url(forResource: "zuna-password", withExtension: "js"),
              let script = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else { return nil }
        let ignore: @convention(block) (JSValue) -> Void = { _ in }
        context.evaluateScript("var console = {}")
        for level in ["log", "warn", "error", "info", "debug"] {
            context.objectForKeyedSubscript("console").setObject(ignore, forKeyedSubscript: level as NSString)
        }
        context.evaluateScript(script)
        self.context = context
        return context
    }
}
