import Foundation
import XCTest
@testable import ZunaModels

/// The lookups held to packages/i18n's vectors, which the core's, the web's and the native app's
/// are held to too.
final class I18nTests: XCTestCase {
    private var vectors: [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../packages/i18n/test/vectors.json").standardized
        return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    private func catalog(_ tag: String, _ value: Any) throws -> Catalog {
        try Catalog(tag: tag, data: JSONSerialization.data(withJSONObject: value))
    }

    private func vars(_ value: Any?) -> [String: Any] {
        (value as? [String: Any]) ?? [:]
    }

    private func lookUp(_ english: Catalog, _ other: Catalog?, _ lookup: [String: Any]) -> String {
        if lookup["call"] as? String == "translate" {
            let text = lookup["text"] as! String
            guard let other, let key = english.key(forEnglish: text) else { return text }
            return other.words(key, count: nil) ?? text
        }
        let key = lookup["key"] as! String
        let vars = vars(lookup["vars"])
        let count = I18n.count(of: vars)
        return I18n.fill(other?.words(key, count: count) ?? english.words(key, count: count) ?? key, vars)
    }

    func testPluralRulesFollowCldrAsIntlDoes() throws {
        for case let item as [String: Any] in vectors["plural"] as! [Any] {
            let catalog = try catalog("xx", ["$language": "x", "$plural": item["rules"]!])
            for (count, category) in item["cases"] as! [String: String] {
                XCTAssertEqual(catalog.category(Int(count)!), category, "\(item["tag"]!) \(count)")
            }
        }
    }

    func testPluralRulesThatCantBeReadAreRefused() {
        for case let source as String in vectors["badRules"] as! [Any] {
            XCTAssertThrowsError(try PluralRule(source), source)
        }
        XCTAssertNoThrow(try PluralRule("i = 1 and v = 0 @integer 1"))
    }

    func testFillingInReplacesEachNameGivenAndLeavesTheRest() {
        for case let item as [String: Any] in vectors["fill"] as! [Any] {
            XCTAssertEqual(I18n.fill(item["text"] as! String, vars(item["vars"])), item["out"] as? String)
        }
    }

    func testACountsFormIsPickedByTheNumber() {
        for case let item as [String: Any] in vectors["counts"] as! [Any] {
            XCTAssertEqual(I18n.count(of: vars(item["vars"])), item["out"] as? Int, "\(item["vars"]!)")
        }
    }

    func testLanguagesMatchAsTheCoreMatchesThem() {
        for case let item as [String: Any] in vectors["match"] as! [Any] {
            XCTAssertEqual(I18n.match(item["preferred"] as! [String], item["available"] as! [String]), item["out"] as? String)
        }
    }

    func testCatalogsLookTextUpWithEnglishWhereTheyreSilent() throws {
        let english = try catalog("en", vectors["english"]!)
        let polish = try catalog("pl", (vectors["catalog"] as! [String: Any])["data"]!)
        XCTAssertEqual(polish.name, "Polski")
        for case let lookup as [String: Any] in vectors["lookups"] as! [Any] {
            XCTAssertEqual(lookUp(english, polish, lookup), lookup["out"] as? String, "\(lookup)")
        }
        for case let lookup as [String: Any] in vectors["englishLookups"] as! [Any] {
            XCTAssertEqual(lookUp(english, nil, lookup), lookup["out"] as? String, "\(lookup)")
        }
    }

    func testMalformedCatalogsAreRefused() {
        let bad: [Any] = [
            [Any](),
            [String: Any](),
            ["$language": " "],
            ["$language": "Polski", "$plural": ["other": "n = 1"]],
            ["$language": "Polski", "$plural": ["one": "nonsense"]],
            ["$language": "Polski", "$comment": "x"],
            ["$language": "Polski", "common.cancel": 1],
            ["$language": "Polski", "group.days": ["lots": "x", "other": "y"]],
            ["$language": "Polski", "group.days": ["other": 2]],
        ]
        for value in bad {
            XCTAssertThrowsError(try catalog("pl", value), "\(value)")
        }
    }

    /// A Polish phone gives the app, which only has English's localization, en_PL as
    /// `Locale.current`, while the Polish catalog is shown: dates are written in Polish, the
    /// region's way, with the clock and first weekday the person has.
    func testDatesAreWrittenInTheLanguageShownTheSystemsWay() throws {
        let date = try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2025, month: 11, day: 15, hour: 14, minute: 32)))
        let polish = I18n.locale(showing: "pl", system: Locale(identifier: "en_PL"))
        XCTAssertEqual(polish.language.languageCode?.identifier, "pl")
        XCTAssertEqual(polish.region?.identifier, "PL")
        XCTAssertEqual(date.formatted(.dateTime.weekday(.wide).month(.wide).day().locale(polish)), "sobota, 15 listopada")
        XCTAssertEqual(date.formatted(.dateTime.weekday(.abbreviated).locale(polish)), "sob.")
        XCTAssertEqual(date.formatted(Date.FormatStyle(date: .numeric, time: .shortened, locale: polish)), "15.11.2025, 14:32")

        let american = I18n.locale(showing: "pl", system: Locale(identifier: "en_US"))
        XCTAssertEqual(american.region?.identifier, "US")
        XCTAssertEqual(date.formatted(Date.FormatStyle(date: .numeric, time: .omitted, locale: american)), "11/15/2025")
        XCTAssertEqual(date.formatted(.dateTime.month(.wide).year().locale(american)), "listopad 2025")

        let twelve = I18n.locale(showing: "pl", system: Locale(identifier: "en_PL@hours=h12;fw=sun"))
        XCTAssertEqual(twelve.hourCycle, .oneToTwelve)
        XCTAssertEqual(twelve.firstDayOfWeek, .sunday)
        XCTAssertTrue(date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: twelve)).hasSuffix("PM"))

        let chinese = I18n.locale(showing: "zh-Hans", system: Locale(identifier: "zh_Hant_TW"))
        XCTAssertEqual(chinese.language.script?.identifier, "Hans")
        XCTAssertEqual(chinese.region?.identifier, "TW")

        // In the language shown already, the system's is kept as it is.
        let british = Locale(identifier: "en_GB@calendar=buddhist")
        XCTAssertEqual(I18n.locale(showing: "en", system: british), british)
        XCTAssertEqual(I18n.locale(showing: "pl", system: Locale(identifier: "pl_PL")), Locale(identifier: "pl_PL"))
    }

    /// Following the system or choosing a language in Settings, dates are in the catalog shown
    /// with the rest of the system's locale.
    func testTheLocaleFollowsTheCatalogShown() {
        let saved = I18n.defaults
        let shown = I18n.tag
        let suite = "zuna-i18n-\(UUID().uuidString)"
        I18n.defaults = UserDefaults(suiteName: suite)!
        defer {
            // The language shown before, as the tests after this one expect it, kept in the
            // throwaway defaults alone.
            I18n.choose(shown)
            I18n.defaults.removePersistentDomain(forName: suite)
            I18n.defaults = saved
        }
        func language(_ locale: Locale) -> String {
            locale.language.languageCode?.identifier ?? ""
        }
        I18n.choose(nil)
        XCTAssertEqual(language(I18n.locale), language(Locale(identifier: I18n.tag)))
        XCTAssertEqual(I18n.locale.region, Locale.current.region)
        XCTAssertEqual(I18n.locale.hourCycle, Locale.current.hourCycle)
        for tag in ["pl", "de", "en"] {
            XCTAssertEqual(I18n.choose(tag), tag)
            XCTAssertEqual(language(I18n.locale), tag)
            XCTAssertEqual(I18n.locale.region, Locale.current.region, tag)
            XCTAssertEqual(I18n.locale.hourCycle, Locale.current.hourCycle, tag)
        }
    }

    func testEveryCatalogThatCameWithTheAppReads() throws {
        XCTAssertNotNil(I18n.files["en"])
        for (tag, url) in I18n.files {
            XCTAssertNoThrow(try Catalog(tag: tag, data: Data(contentsOf: url)), tag)
        }
        XCTAssertEqual(I18n.languages.first?.tag, "en")
        XCTAssertEqual(t("nowhere.at.all"), "nowhere.at.all")
    }
}
