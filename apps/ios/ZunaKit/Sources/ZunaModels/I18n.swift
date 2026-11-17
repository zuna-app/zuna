// Interface text in the person's language (docs/TRANSLATING.md), as packages/i18n has it for the
// core and the web app, held to the same vectors. Code names each text by its key in
// packages/i18n/locales/en.json: t("settings.privacy.readReceipts"), with what's filled in as
// t("chat.typing.one", ["name": who]), and a count's form by "count". The catalogs come with the
// app, copied beside this by apps/ios/core-bundle/build.mjs, English always, and another
// language's are read the first time it's chosen. The language is kept in the App Group, so the
// notification and share extensions word things the same.

import Foundation

/// One language's words.
public struct Catalog: Sendable {
    public let tag: String
    /// The language's own name for itself.
    public let name: String
    fileprivate let rules: [(category: String, rule: PluralRule)]
    fileprivate let entries: [String: Entry]

    fileprivate enum Entry: Sendable {
        case text(String)
        case plural([String: String], other: String)
    }

    /// CLDR's plural categories, in the order a catalog's rules are tried.
    static let categories = ["zero", "one", "two", "few", "many", "other"]

    /// A catalog from its file, checked as packages/i18n checks it.
    public init(tag: String, data: Data) throws {
        guard let record = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw I18nError("\(tag): a catalog is a JSON object.") }
        guard let name = (record["$language"] as? String)?.trimmingCharacters(in: .whitespaces), !name.isEmpty else { throw I18nError("\(tag): $language is the language's own name.") }
        var rules: [(String, PluralRule)] = []
        if let plural = record["$plural"] {
            guard let plural = plural as? [String: Any] else { throw I18nError("\(tag): $plural is an object of rules.") }
            for key in plural.keys where !Self.categories.dropLast().contains(key) {
                throw I18nError("\(tag): \"\(key)\" isn't a plural category with a rule.")
            }
            for category in Self.categories.dropLast() {
                guard let source = plural[category] else { continue }
                guard let source = source as? String else { throw I18nError("\(tag): the rule for \(category) is text.") }
                rules.append((category, try PluralRule(source)))
            }
        }
        var entries: [String: Entry] = [:]
        for (key, value) in record {
            if key.hasPrefix("$") {
                if key != "$language" && key != "$plural" { throw I18nError("\(tag): \"\(key)\" isn't something a catalog says.") }
                continue
            }
            switch value {
            case is NSNull:
                continue
            case let text as String:
                if !text.isEmpty { entries[key] = .text(text) }
            case let forms as [String: Any]:
                var kept: [String: String] = [:]
                for (category, form) in forms {
                    guard Self.categories.contains(category) else { throw I18nError("\(tag): \"\(key)\" has a form for \"\(category)\", which isn't a plural category.") }
                    if form is NSNull { continue }
                    guard let form = form as? String else { throw I18nError("\(tag): \"\(key)\"'s \"\(category)\" form is text.") }
                    if !form.isEmpty { kept[category] = form }
                }
                if let other = kept.removeValue(forKey: "other") { entries[key] = .plural(kept, other: other) }
            default:
                throw I18nError("\(tag): \"\(key)\" is text, null or plural forms.")
            }
        }
        self.tag = tag
        self.name = name
        self.rules = rules
        self.entries = entries
    }

    /// Which form a count takes.
    func category(_ count: Int) -> String {
        let whole = count.magnitude
        return rules.first { $0.rule.holds(UInt64(whole)) }?.category ?? "other"
    }

    /// A key's words, with the form a count takes.
    func words(_ key: String, count: Int?) -> String? {
        switch entries[key] {
        case .text(let text): return text
        case .plural(let forms, let other):
            guard let count else { return other }
            return forms[category(count)] ?? other
        case nil: return nil
        }
    }

    /// The key English has a text under, for `translate` and the vectors' test.
    func key(forEnglish text: String) -> String? {
        entries.first { if case .text(let english) = $0.value { return english == text } else { return false } }?.key
    }
}

public struct I18nError: Error, CustomStringConvertible, Sendable {
    public let description: String
    init(_ description: String) { self.description = description }
}

/// A CLDR plural rule for whole numbers: n and i are the number, and v, w, f, t, c and e are 0.
struct PluralRule: Sendable {
    private struct Relation: Sendable {
        let whole: Bool
        let modulo: UInt64?
        let equal: Bool
        let ranges: [ClosedRange<UInt64>]
    }
    private let ors: [[Relation]]

    init(_ source: String) throws {
        let text = source.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !text.isEmpty else { throw I18nError("A plural rule is empty.") }
        let bad = I18nError("A plural rule can't be read: \(source)")
        let normal = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        ors = try normal.components(separatedBy: " or ").map { part in
            try part.components(separatedBy: " and ").map { relation in
                let relation = relation.replacingOccurrences(of: " ", with: "")
                let (left, right, equal): (String, String, Bool)
                if let range = relation.range(of: "!=") {
                    (left, right, equal) = (String(relation[..<range.lowerBound]), String(relation[range.upperBound...]), false)
                } else if let index = relation.firstIndex(of: "=") {
                    (left, right, equal) = (String(relation[..<index]), String(relation[relation.index(after: index)...]), true)
                } else {
                    throw bad
                }
                let parts = left.split(separator: "%", omittingEmptySubsequences: false).map(String.init)
                guard parts.count <= 2, let operand = parts.first, ["n", "i", "v", "w", "f", "t", "c", "e"].contains(operand), !right.isEmpty else { throw bad }
                var modulo: UInt64?
                if parts.count == 2 {
                    guard let value = UInt64(parts[1]), value > 0 else { throw bad }
                    modulo = value
                }
                let ranges = try right.split(separator: ",", omittingEmptySubsequences: false).map { item -> ClosedRange<UInt64> in
                    let bounds = item.components(separatedBy: "..")
                    guard bounds.count <= 2, bounds.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
                          let low = UInt64(bounds[0]), let high = UInt64(bounds[bounds.count - 1]), low <= high else { throw bad }
                    return low...high
                }
                return Relation(whole: operand == "n" || operand == "i", modulo: modulo, equal: equal, ranges: ranges)
            }
        }
    }

    func holds(_ count: UInt64) -> Bool {
        ors.contains { ands in
            ands.allSatisfy { relation in
                let value = relation.whole ? relation.modulo.map { count % $0 } ?? count : 0
                return relation.ranges.contains { $0.contains(value) } == relation.equal
            }
        }
    }
}

public enum I18n {
    /// A text with its {name}s filled in. A name it isn't given stays as written.
    public static func fill(_ text: String, _ vars: [String: Any]) -> String {
        guard !vars.isEmpty, text.contains("{") else { return text }
        var out = ""
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest[rest.index(after: open)...]
            if let close = after.firstIndex(of: "}") {
                let name = String(after[..<close])
                if let first = name.first, first.isASCII, first.isLetter || first == "_", name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }), let value = vars[name] {
                    out += "\(value)"
                    rest = after[after.index(after: close)...]
                    continue
                }
            }
            out += "{"
            rest = after
        }
        return out + rest
    }

    /// The number a count's form is picked by: "count", written with separators or not.
    public static func count(of vars: [String: Any]) -> Int? {
        guard let count = vars["count"] else { return nil }
        if let number = count as? Int { return number }
        let digits = "\(count)".filter { $0.isASCII && ($0.isNumber || $0 == "-") }
        let negative = digits.hasPrefix("-")
        let body = negative ? String(digits.dropFirst()) : digits
        guard !body.isEmpty, !body.contains("-"), let value = Int(body) else { return nil }
        return negative ? -value : value
    }

    /// Which of the languages there are best suits someone who prefers some, in order: the same
    /// tag, or the same language in another region.
    public static func match(_ preferred: [String], _ available: [String]) -> String? {
        func normal(_ tag: String) -> String { String(tag.split(whereSeparator: { $0 == "." || $0 == "@" }).first ?? "").replacingOccurrences(of: "_", with: "-").lowercased() }
        func base(_ tag: String) -> String { String(normal(tag).split(separator: "-").first ?? "") }
        for wanted in preferred {
            let tag = normal(wanted)
            if tag.isEmpty || tag == "c" || tag == "posix" { continue }
            if let exact = available.first(where: { normal($0) == tag }) { return exact }
            let language = base(wanted)
            if let close = available.first(where: { normal($0) == language }) ?? available.first(where: { base($0) == language }) { return close }
        }
        return nil
    }

    /// Each catalog that came with the app, by its tag.
    static let files: [String: URL] = {
        let urls = Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "locales") ?? []
        return Dictionary(urls.map { ($0.deletingPathExtension().lastPathComponent, $0) }, uniquingKeysWith: { first, _ in first })
    }()

    /// Where the language chosen is kept: the App Group's defaults, which `useAppGroup` names.
    nonisolated(unsafe) static var defaults: UserDefaults = .standard
    static let choiceKey = "zuna-language"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var read: [String: Catalog] = [:]
    nonisolated(unsafe) private static var shownCatalog: Catalog?

    static let english: Catalog = {
        guard let url = files["en"], let data = try? Data(contentsOf: url), let catalog = try? Catalog(tag: "en", data: data) else {
            fatalError("en.json didn't come with the app: run apps/ios/core-bundle/build.mjs")
        }
        return catalog
    }()

    private static func catalog(_ tag: String) -> Catalog? {
        lock.lock()
        defer { lock.unlock() }
        if let catalog = read[tag] { return catalog }
        guard let url = files[tag], let data = try? Data(contentsOf: url), let catalog = try? Catalog(tag: tag, data: data) else { return nil }
        read[tag] = catalog
        return catalog
    }

    private static var current: Catalog? {
        lock.lock()
        defer { lock.unlock() }
        return shownCatalog
    }

    static func lookup(_ key: String, count: Int?) -> String? {
        current?.words(key, count: count) ?? english.words(key, count: count)
    }

    /// The languages there are, English first, then by their own names.
    public static var languages: [(tag: String, name: String)] {
        let others = files.keys.filter { $0 != "en" }.compactMap { tag in catalog(tag).map { (tag: tag, name: $0.name) } }
        return [(tag: "en", name: english.name)] + others.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The language chosen in Settings, by its tag, or nil for the system's.
    public static var choice: String? { defaults.string(forKey: choiceKey) }

    /// The language a choice comes to: a tag there is, or the system's, or English.
    public static func resolve(_ choice: String?) -> String {
        let tags = Array(files.keys)
        if let choice, tags.contains(choice) { return choice }
        return match(Locale.preferredLanguages, tags) ?? "en"
    }

    /// Keeps the language in the App Group's defaults and shows it from now on: a tag, or nil for
    /// the system's. Gives the tag it came to.
    @discardableResult
    public static func choose(_ choice: String?) -> String {
        defaults.set(choice, forKey: choiceKey)
        return apply()
    }

    /// Shows the language kept, as an app or an extension starts. Gives the tag it came to.
    @discardableResult
    public static func apply() -> String {
        let tag = resolve(choice)
        let catalog = tag == "en" ? nil : catalog(tag)
        lock.lock()
        shownCatalog = catalog
        lock.unlock()
        return catalog?.tag ?? "en"
    }

    /// Reads and keeps the language in an App Group's defaults, shared with the extensions.
    public static func useAppGroup(_ group: String) {
        if let shared = UserDefaults(suiteName: group) { defaults = shared }
        apply()
    }

    /// The language shown, by its tag.
    public static var tag: String { current?.tag ?? "en" }

    /// The locale dates and numbers are written for: the language shown, with everything else the
    /// system's (`locale(showing:system:)`).
    public static var locale: Locale { locale(showing: tag, system: .current) }

    /// The system's locale in the language shown, so that a date's words are the catalog's while
    /// the region's order of day and month, the 12 or 24 hours set in Settings, the first day of
    /// the week and the calendar stay the person's. `Locale.current` can't be taken as it is even
    /// while the language follows the system: iOS gives it the language of the app's own
    /// localizations, and the app only has English's, so a Polish phone's is en_PL. When the
    /// system's is in the language shown already, it's kept whole, with any date formats chosen
    /// in Settings, which a locale made anew loses.
    static func locale(showing tag: String, system: Locale) -> Locale {
        func base(_ language: Locale.Language) -> (String?, String?) {
            let full = Locale.Language(identifier: language.maximalIdentifier)
            return (full.languageCode?.identifier, full.script?.identifier)
        }
        let shown = Locale.Language.Components(identifier: tag)
        if base(system.language) == base(Locale.Language(components: shown)) { return system }
        var components = Locale.Components(locale: system)
        var language = shown
        if language.region == nil { language.region = system.language.region }
        components.languageComponents = language
        return Locale(components: components)
    }

    /// What the core is told of the language shown (`CoreRuntime.setLanguage`): its tag and
    /// catalog's JSON, or nil for English.
    public static var forCore: (tag: String, catalog: String?) {
        guard let catalog = current, let url = files[catalog.tag], let data = try? Data(contentsOf: url) else { return ("en", nil) }
        return (catalog.tag, String(data: data, encoding: .utf8))
    }

    /// English text from elsewhere, in the person's language when English has it under some key.
    public static func translate(_ text: String) -> String {
        guard let catalog = current, let key = english.key(forEnglish: text) else { return text }
        return catalog.words(key, count: nil) ?? text
    }
}

/// A key's text in the person's language, with its {name}s filled in, and a count's form by
/// "count". A key no catalog has is shown as it is, so that it's noticed.
public func t(_ key: String, _ vars: [String: Any] = [:]) -> String {
    I18n.fill(I18n.lookup(key, count: I18n.count(of: vars)) ?? key, vars)
}

/// Marks a key kept in a table, to look up with `t` where it's shown, so the check knows it's used.
public func mark(_ key: String) -> String { key }
