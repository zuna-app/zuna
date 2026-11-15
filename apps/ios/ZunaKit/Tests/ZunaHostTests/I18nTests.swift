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

    func testEveryCatalogThatCameWithTheAppReads() throws {
        XCTAssertNotNil(I18n.files["en"])
        for (tag, url) in I18n.files {
            XCTAssertNoThrow(try Catalog(tag: tag, data: Data(contentsOf: url)), tag)
        }
        XCTAssertEqual(I18n.languages.first?.tag, "en")
        XCTAssertEqual(t("nowhere.at.all"), "nowhere.at.all")
    }
}
