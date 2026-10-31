import XCTest
import ZunaModels

/// Sign-up must judge passwords and suggest usernames as the desktop does.
/// Expected values come from running the desktop's functions in Node.
final class AccountRulesTests: XCTestCase {
    func testRatesPasswordsLikeTheDesktop() {
        let cases: [(String, Int, String)] = [
            ("", 0, ""),
            ("short", 1, "Too easy to guess"),
            ("aaaaaaaaaaaa", 1, "Too easy to guess"),
            ("password12345", 3, "Good"),
            ("correct horse battery", 4, "Strong"),
            ("Tr0ub4dor&3", 4, "Strong"),
            ("hunter2hunter2", 4, "Strong"),
            ("zażółć gęślą jaźń", 4, "Strong"),
            ("abcdefghij", 2, "Could be stronger"),
            ("abcdefghij1234", 3, "Good"),
            ("AbCdEfGhIjKl", 3, "Good"),
            ("x9$Lq!2vR#pW", 4, "Strong"),
            ("ZunaZunaZuna1", 2, "Could be stronger"),
            ("Ab1!", 1, "Too easy to guess"),
            ("longpasswordwithoutanythingelse", 4, "Strong"),
        ]
        for (password, score, label) in cases {
            let strength = AccountRules.passwordStrength(password)
            XCTAssertEqual(strength.score, score, "for \(password.debugDescription)")
            XCTAssertEqual(strength.label, label, "for \(password.debugDescription)")
        }
    }

    func testSuggestsUsernamesLikeTheDesktop() {
        let cases: [(String, String)] = [
            ("Dana Scully", "dana_scully"),
            ("  Fox Mulder  ", "fox_mulder"),
            ("Zoë Ångström", "zoe_angstrom"),
            ("李小龍", ""),
            ("Jean-Luc Picard", "jean-luc_picard"),
            ("__init__", "init"),
            ("a.b.c", "a.b.c"),
            ("Ünïcödé Ñame!!", "unicode_name"),
            ("x", "x"),
            ("Émile Zola the Third of His Name, Esquire", "emile_zola_the_third_of_his_name"),
            ("İstanbul", "istanbul"),
        ]
        for (name, username) in cases {
            XCTAssertEqual(AccountRules.suggestUsername(name), username, "for \(name.debugDescription)")
        }
    }

    func testValidatesUsernames() {
        XCTAssertTrue(AccountRules.isValidUsername("dana_scully"))
        XCTAssertTrue(AccountRules.isValidUsername("_x"))
        XCTAssertFalse(AccountRules.isValidUsername("x"))
        XCTAssertFalse(AccountRules.isValidUsername(".dana"))
        XCTAssertFalse(AccountRules.isValidUsername("dana scully"))
        XCTAssertFalse(AccountRules.isValidUsername(String(repeating: "a", count: 33)))
    }
}
