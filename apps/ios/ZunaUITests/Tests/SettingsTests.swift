import XCTest

/// Settings and administration, each change checked where it lands: on the
/// desktop peers, in the core, or in the device lock. Tests that change an
/// account use a new one, so the shared world stays as the other tests expect.
final class SettingsTests: XCTestCase {
    private let zuna = AppUnderTest()
    private let password = "correct horse battery staple"

    override func setUp() {
        continueAfterFailure = false
    }

    private func newAccount(_ prefix: String) throws -> String {
        let username = "\(prefix)\(UUID().uuidString.prefix(4).lowercased())"
        try zuna.launch()
        _ = try zuna.register(username, password: password)
        try zuna.waitForChats()
        return username
    }

    private func openSettings(_ row: String) {
        zuna.tab("Settings").tap()
        let item = zuna.element(row)
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        item.tap()
    }

    /// Someone as the desktop peer alice sees them.
    private func aliceSees(_ userId: String) throws -> [String: Any]? {
        let users = try Peer("alice").call("getUsers") as? [[String: Any]] ?? []
        return users.first { $0["id"] as? String == userId }
    }

    private func type(_ text: String, into identifier: String, replacing: Bool = false) {
        zuna.type(text, into: identifier, clearing: replacing)
    }

    func testEditsTheProfileAndPrivacyTheDesktopSees() throws {
        _ = try newAccount("lena")
        let id = try zuna.selfId()
        openSettings(A11y.Settings.profile)
        type("Lena Example", into: A11y.Settings.displayName, replacing: true)
        type("Here for the book club", into: A11y.Settings.bio)
        zuna.screenshot("90-profile")
        zuna.element(A11y.Settings.save).tap()
        try waitFor("alice to see the profile", timeout: 30) {
            let user = try self.aliceSees(id)
            return user?["displayName"] as? String == "Lena Example" && user?["bio"] as? String == "Here for the book club"
        }

        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        zuna.element(A11y.Settings.privacy).tap()
        let online = zuna.app.switches[A11y.Settings.showOnline]
        XCTAssertTrue(online.waitForExistence(timeout: 5))
        online.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("alice to see the status hidden", timeout: 30) { try self.aliceSees(id)?["hidesLastSeen"] as? Bool == true }
        zuna.app.switches[A11y.Settings.readReceipts].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("read receipts off") { try self.zuna.preferencesFlag("sendReadReceipts") == false }

        // Removing metadata from files is on, and turning it off asks first.
        let metadata = zuna.app.switches[A11y.Settings.removeMetadata]
        zuna.app.swipeUp()
        XCTAssertTrue(metadata.waitForExistence(timeout: 5))
        XCTAssertEqual(metadata.value as? String, "1")
        zuna.toggle(A11y.Settings.removeMetadata)
        let question = zuna.app.alerts["Send files with their metadata?"]
        XCTAssertTrue(question.waitForExistence(timeout: 5))
        zuna.screenshot("90b-keep-metadata")
        question.buttons["Cancel"].tap()
        try waitFor("the question to go") { !question.exists }
        XCTAssertEqual(metadata.value as? String, "1")
        zuna.toggle(A11y.Settings.removeMetadata)
        XCTAssertTrue(question.waitForExistence(timeout: 5))
        question.buttons["Turn Off"].tap()
        try waitFor("metadata to be kept") { metadata.value as? String == "0" }
        // On again doesn't ask, and leaves it as the other tests expect.
        zuna.toggle(A11y.Settings.removeMetadata)
        try waitFor("metadata to be removed again") { metadata.value as? String == "1" }
        XCTAssertFalse(question.exists)
    }

    func testChangesThePasswordWhichThenUnlocksAfterARestart() throws {
        let username = try newAccount("mia")
        let next = "a brand new passphrase"
        openSettings(A11y.Settings.security)
        type(password, into: A11y.Settings.currentPassword)
        type(next, into: A11y.Settings.newPassword)
        let change = zuna.element(A11y.Settings.changePassword)
        try waitFor("the new password to be rated") { change.isEnabled }
        change.tap()
        XCTAssertTrue(zuna.toast(startingWith: "Password changed").waitForExistence(timeout: 30))

        // A new device signs in with it, and shows up in the list.
        try WorldControl.newDevice(for: username, password: next)
        zuna.app.navigationBars.buttons.element(boundBy: 0).tap()
        zuna.element(A11y.Settings.security).tap()
        let devices = zuna.app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", A11y.Settings.device("")))
        try waitFor("two devices") { devices.count == 2 }
        zuna.screenshot("91-security")

        // A new recovery key.
        zuna.app.swipeUp()
        type(next, into: A11y.Settings.recoveryPassword)
        zuna.element(A11y.Settings.newRecoveryKey).tap()
        let key = zuna.element(A11y.Settings.recoveryKey)
        XCTAssertTrue(key.waitForExistence(timeout: 30))
        XCTAssertEqual(key.label.split(separator: "-").count, 10)

        // After a restart of the phone the new password unlocks, not the old one.
        XCTAssertEqual(try zuna.lockEntries(), "1")
        zuna.app.terminate()
        try zuna.launch(fresh: false, bootSession: "settings-restart-\(username)")
        let field = zuna.element(A11y.Unlock.password)
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText(password)
        zuna.element(A11y.Unlock.submit).tap()
        XCTAssertTrue(zuna.element(A11y.Unlock.error).waitForExistence(timeout: 15))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + next)
        zuna.element(A11y.Unlock.submit).tap()
        try zuna.waitForChats(timeout: 30)
    }

    func testSignsOutAndErasesTheLocalCopy() throws {
        _ = try newAccount("olaf")
        zuna.tab("Settings").tap()
        let signOut = zuna.element(A11y.Settings.signOut)
        XCTAssertTrue(signOut.waitForExistence(timeout: 10))
        signOut.tap()
        let confirm = zuna.app.buttons["Sign out and erase local data"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(zuna.element(A11y.Onboarding.joinWithInvite).waitForExistence(timeout: 20))
        XCTAssertEqual(try zuna.serverCount(), 0)
        XCTAssertEqual(try zuna.lockEntries(), "0")
    }

    func testAdministersTheServerAsItsOwner() throws {
        // Someone to ban, made first on the phone.
        let target = try newAccount("pete")
        let targetId = try zuna.selfId()
        zuna.app.terminate()
        try zuna.launch()
        try zuna.signIn(as: "alice")
        try zuna.waitForChats()
        openSettings(A11y.Settings.server)
        zuna.screenshot("92-server-settings")

        // Members may invite, then not again, as the desktop sees it.
        let invites = zuna.app.switches[A11y.Settings.memberInvites]
        XCTAssertTrue(invites.waitForExistence(timeout: 10))
        invites.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let carol = try Peer("carol")
        try waitFor("carol to see member invites allowed") { (try carol.call("getInfo") as? [String: Any])?["allow_member_invites"] as? Bool == true }
        invites.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("and not") { (try carol.call("getInfo") as? [String: Any])?["allow_member_invites"] as? Bool == false }

        // A member banned from the list.
        zuna.app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "members")).firstMatch.tap()
        let row = zuna.element(A11y.Settings.member(target))
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        zuna.app.buttons["Ban from server"].tap()
        let confirm = zuna.app.sheets.buttons["Ban from server"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        try waitFor("alice's desktop to see the ban", timeout: 30) { try self.aliceSees(targetId)?["banned"] as? Bool == true }
        zuna.screenshot("93-members")
    }

    func testSetsWhatTheServerAllowsForSharingAScreen() throws {
        let alice = try Peer("alice")
        let carol = try Peer("carol")
        let rules = { () throws -> [String: Any] in (try carol.call("getInfo") as? [String: Any])?["screen_share"] as? [String: Any] ?? [:] }
        let before = try rules()
        try zuna.launch()
        try zuna.signIn(as: "alice")
        try zuna.waitForChats()
        openSettings(A11y.Settings.server)
        // Further down than the screen goes, where the list only has rows once they're scrolled to.
        let link = zuna.element(A11y.Settings.screenRules)
        XCTAssertTrue(zuna.element(A11y.Settings.memberInvites).waitForExistence(timeout: 10))
        for _ in 0..<5 where !link.exists { zuna.app.swipeUp() }
        link.tap()

        // Admins only, without sound, and at most 8 Mbit/s, as a desktop's core then has it.
        let admins = zuna.app.buttons["Admins"]
        XCTAssertTrue(admins.waitForExistence(timeout: 5))
        admins.tap()
        zuna.app.switches[A11y.Settings.screenSound].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        zuna.element(A11y.Settings.screenMaxKbps).tap()
        let rate = zuna.app.buttons["8 Mbit/s"]
        XCTAssertTrue(rate.waitForExistence(timeout: 5))
        rate.tap()
        zuna.screenshot("93c-screen-rules")
        zuna.element(A11y.Settings.save).tap()
        try waitFor("carol to see the new rules", timeout: 20) {
            let now = try rules()
            // What's suggested comes down to what's allowed.
            return now["who"] as? String == "admins" && now["sound"] as? Bool == false && now["max_kbps"] as? Int == 8000 && now["default_kbps"] as? Int == 8000
        }

        // Back as they were, for the other tests.
        try alice.call("updateServerSettings", [["screen_share": before]])
        try waitFor("the rules to be back") { try rules()["who"] as? String == before["who"] as? String }
    }

    func testAppLockAsksForFaceIdEachTimeTheAppOpens() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        openSettings(A11y.Settings.appLock)
        let toggle = zuna.app.switches[A11y.Settings.lockToggle]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        // Turning it on asks for Face ID first.
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        try WorldControl.faceId(match: true)
        try waitFor("App lock to be on") { toggle.value as? String == "1" }

        // Opening the app again asks before showing anything.
        zuna.app.terminate()
        try zuna.launch(fresh: false)
        let lock = zuna.element(A11y.Root.appLock)
        XCTAssertTrue(lock.waitForExistence(timeout: 15))
        XCTAssertFalse(zuna.element(A11y.Shell.title).exists)
        zuna.screenshot("94-app-lock")
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        try WorldControl.faceId(match: true)
        try waitFor("the app to open") { !lock.exists }
        try zuna.waitForChats()

        // Turned off again, so the other tests open straight away.
        zuna.tab("Settings").tap()
        zuna.element(A11y.Settings.appLock).tap()
        zuna.app.switches[A11y.Settings.lockToggle].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("App lock to be off") { self.zuna.app.switches[A11y.Settings.lockToggle].value as? String == "0" }
    }
}
