import XCTest
import ZunaHost
import ZunaModels

/// Sign-up must judge passwords and suggest usernames as the desktop does.
/// Expected values come from running the desktop's functions in Node.
final class AccountRulesTests: XCTestCase {
    /// The meter is the desktop's own estimator, run in JavaScriptCore.
    func testRatesPasswordsLikeTheDesktop() async {
        let cases: [(String, [String], Int, String)] = [
            ("", [], 0, ""),
            ("short", [], 1, "Too easy to guess"),
            ("aaaaaaaaaaaa", [], 1, "Too easy to guess"),
            ("Haslo123!", [], 1, "Too easy to guess"),
            ("Summer2024!", [], 1, "Too easy to guess"),
            ("Zaq12wsx", [], 1, "Too easy to guess"),
            ("password12345", [], 1, "Too easy to guess"),
            ("DanaScully1!", ["dana_scully", "Dana Scully"], 1, "Too easy to guess"),
            ("correct horse battery", [], 3, "Good"),
            ("Tr0ub4dor&3", [], 2, "Could be stronger"),
            ("zażółć gęślą jaźń", [], 4, "Strong"),
            ("kot w butach", [], 2, "Could be stronger"),
            ("k7Rm2pQx9z", [], 2, "Could be stronger"),
            ("Gdansk#Lato77", [], 3, "Good"),
            ("x9$Lq!2vR#pW", [], 3, "Good"),
            ("purple monkey dishwasher", [], 4, "Strong"),
        ]
        for (password, related, score, label) in cases {
            let strength = await PasswordMeter.shared.strength(password, related: related)
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

    func testPointsOutAMistypedConfirmation() {
        let password = "correct horse"
        XCTAssertNil(AccountRules.confirmationError(password, confirmation: ""))
        XCTAssertNil(AccountRules.confirmationError(password, confirmation: "correct h"))
        XCTAssertNil(AccountRules.confirmationError(password, confirmation: password))
        XCTAssertEqual(AccountRules.confirmationError(password, confirmation: "correct j"), "The passwords don't match.")
        XCTAssertEqual(AccountRules.confirmationError(password, confirmation: "correct horses"), "The passwords don't match.")
    }
}
