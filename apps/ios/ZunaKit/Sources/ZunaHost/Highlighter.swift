import Foundation
import JavaScriptCore

/// Colors code blocks with the desktop's Shiki setup, in a JavaScriptCore
/// context of its own (Resources/zuna-highlight.js, built from
/// apps/ios/core-bundle/src/highlight.ts). The script loads on first use.
public final class Highlighter: @unchecked Sendable {
    /// One line of code as runs of text, each with its color as `#rrggbb`, or nil for the default.
    public typealias Line = [(text: String, color: String?)]

    public static let shared = Highlighter()

    private let queue = DispatchQueue(label: "chat.zuna.highlight", qos: .userInitiated)
    private var context: JSContext?
    private var cache: [String: [Line]] = [:]

    /// The tokens for each line, or nil if the desktop wouldn't color this language.
    public func tokens(_ code: String, language: String) async -> [Line]? {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                continuation.resume(returning: highlight(code, language: language))
            }
        }
    }

    private func highlight(_ code: String, language: String) -> [Line]? {
        let key = "\(language)\u{0}\(code)"
        if let cached = cache[key] { return cached }
        guard let context = loadedContext() else { return nil }
        var result: String?
        let done: @convention(block) (JSValue, JSValue) -> Void = { value, _ in
            result = value.isNull || value.isUndefined ? nil : value.toString()
        }
        context.objectForKeyedSubscript("__zunaHighlight").call(withArguments: [code, language, done as Any])
        // Shiki's promises settle on JavaScriptCore's microtask queue, drained when the call returns.
        guard let result, let data = result.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [[[Any]]] else { return nil }
        let lines = raw.map { line in
            line.map { token in (text: token.first as? String ?? "", color: token.count > 1 ? token[1] as? String : nil) }
        }
        if cache.count > 500 { cache.removeAll() }
        cache[key] = lines
        return lines
    }

    private func loadedContext() -> JSContext? {
        if let context { return context }
        guard let url = Bundle.module.url(forResource: "zuna-highlight", withExtension: "js"),
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
