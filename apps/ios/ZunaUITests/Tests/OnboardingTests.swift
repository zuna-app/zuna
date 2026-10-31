import XCTest

/// The first screens: joining with an invite, signing in, recovering with the
/// key, links from outside the app, and setting up a new server.
final class OnboardingTests: XCTestCase {
    private let zuna = AppUnderTest()
    private let password = "correct horse battery staple"

    override func setUp() {
        continueAfterFailure = false
    }

    func testJoinsWithAnInviteLinkAndKeepsTheRecoveryKey() throws {
        try zuna.launch()
        XCTAssertTrue(zuna.element(A11y.Onboarding.link).waitForExistence(timeout: 15))
        zuna.screenshot("40-welcome")

        zuna.type(World.current.invite, into: A11y.Onboarding.link)
        zuna.element(A11y.Onboarding.continue).tap()
        let join = zuna.element(A11y.Onboarding.joinScreen)
        XCTAssertTrue(join.waitForExistence(timeout: 15))
        XCTAssertTrue(zuna.app.staticTexts["Join \(World.current.serverName)"].exists)

        // The username follows the name until it's edited.
        zuna.type("Dana Scully", into: A11y.Onboarding.displayName)
        XCTAssertEqual(zuna.element(A11y.Onboarding.username).value as? String, "dana_scully")
        let create = zuna.element(A11y.Onboarding.create)
        let strength = zuna.element(A11y.Onboarding.strength)
        zuna.type("short", into: A11y.Onboarding.password)
        try waitFor("a weak rating") { strength.value as? String == "Too easy to guess" }
        XCTAssertFalse(create.isEnabled)
        zuna.element(A11y.Onboarding.password).typeText(" and now much longer")
        try waitFor("a strong rating") { strength.value as? String == "Strong" }
        XCTAssertTrue(create.isEnabled)
        zuna.screenshot("41-join")
        create.tap()

        // The account exists now; the key shows before anything else.
        let key = zuna.element(A11y.Onboarding.recoveryKey)
        XCTAssertTrue(key.waitForExistence(timeout: 30))
        zuna.declineSavingPassword()
        XCTAssertEqual((key.value as? String)?.split(separator: "-").count, 10)
        XCTAssertEqual(try zuna.serverCount(), 1)
        XCTAssertFalse(zuna.element(A11y.Shell.title).exists)
        let next = zuna.element(A11y.Onboarding.keyContinue)
        XCTAssertFalse(next.isEnabled)
        zuna.element(A11y.Onboarding.copyKey).tap()
        XCTAssertTrue(zuna.app.buttons["Copied"].waitForExistence(timeout: 2))
        zuna.toggle(A11y.Onboarding.keyStored)
        zuna.screenshot("42-recovery-key")
        XCTAssertTrue(next.isEnabled)
        next.tap()

        try zuna.waitForChats()
        let alice = World.current["alice"]
        XCTAssertTrue(zuna.element(A11y.ChatList.row("user:\(alice.userId)")).waitForExistence(timeout: 20))
        zuna.screenshot("43-joined")
    }

    func testSignsInAndExplainsAWrongPassword() throws {
        try zuna.launch()
        zuna.element(A11y.Onboarding.signIn).tap()
        let submit = zuna.element(A11y.Onboarding.signInSubmit)
        XCTAssertTrue(submit.waitForExistence(timeout: 5))
        XCTAssertFalse(submit.isEnabled)

        zuna.type(World.current.serverUrl, into: A11y.Onboarding.serverAddress)
        zuna.type("bob", into: A11y.Onboarding.username)
        zuna.type("not my password", into: A11y.Onboarding.password)
        submit.tap()
        let error = zuna.element(A11y.Onboarding.error)
        XCTAssertTrue(error.waitForExistence(timeout: 20))
        zuna.screenshot("44-sign-in-wrong-password")
        XCTAssertEqual(try zuna.serverCount(), 0)

        zuna.type(World.current["bob"].password, into: A11y.Onboarding.password, clearing: true)
        submit.tap()
        try zuna.waitForChats(timeout: 30)
        XCTAssertEqual(try zuna.lockEntries(), "1")
    }

    func testRecoversWithTheRecoveryKey() throws {
        try zuna.launch()
        let key = try zuna.register("erin", password: password)
        XCTAssertFalse(key.isEmpty)

        // A new phone: nothing stored, and the password forgotten.
        zuna.app.terminate()
        try zuna.launch()
        zuna.element(A11y.Onboarding.signIn).tap()
        zuna.type(World.current.serverUrl, into: A11y.Onboarding.serverAddress)
        zuna.type("erin", into: A11y.Onboarding.username)
        zuna.element(A11y.Onboarding.forgot).tap()

        let recover = zuna.element(A11y.Onboarding.recover)
        XCTAssertTrue(recover.waitForExistence(timeout: 5))
        zuna.type(key, into: A11y.Onboarding.recoveryInput)
        zuna.type("a whole new password", into: A11y.Onboarding.newPassword)
        zuna.screenshot("45-recover")
        recover.tap()
        try zuna.waitForChats(timeout: 30)
    }

    func testOpensInviteLinksFromOutsideTheApp() throws {
        try zuna.launch()
        XCTAssertTrue(zuna.element(A11y.Onboarding.link).waitForExistence(timeout: 15))
        try open(World.current.invite)
        XCTAssertTrue(zuna.element(A11y.Onboarding.joinScreen).waitForExistence(timeout: 15))

        // Signed in, a link opens the join screens over the app.
        zuna.app.terminate()
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        try open(World.current.invite)
        XCTAssertTrue(zuna.element(A11y.Onboarding.joinScreen).waitForExistence(timeout: 15))
        zuna.screenshot("46-link-while-signed-in")
    }

    func testSetsUpASecondServerAndListsThemLikeMailboxes() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        // With one server, its chats are the first screen.
        XCTAssertFalse(zuna.serversButton.exists)
        try zuna.setUpServer(World.current.setupLink, name: "Book club", password: password, screenshots: true)

        // The new server opens, over the list of both.
        let title = zuna.element(A11y.Shell.title)
        try waitFor("the new server to open") { title.label == "Book club" }
        XCTAssertEqual(try zuna.serverCount(), 2)
        XCTAssertTrue(zuna.serversButton.waitForExistence(timeout: 5))
        zuna.serversButton.tap()
        let servers = zuna.app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", A11y.Servers.row("")))
        try waitFor("both servers in the list") { servers.count == 2 }
        let first = zuna.element(A11y.Servers.row(zuna.serverId))
        XCTAssertTrue(first.label.contains(World.current.serverName), first.label)
        zuna.screenshot("48-two-servers")

        // The one opened last opens again with the app.
        first.tap()
        try waitFor("the first server to open") { title.label == World.current.serverName }
        zuna.app.terminate()
        try zuna.launch(fresh: false)
        try zuna.waitForChats()
        // The title says "Updating…" while the app catches up.
        try waitFor("the first server to open again") { title.label == World.current.serverName }
        XCTAssertTrue(zuna.serversButton.exists)

        // Settings say which server the account's sections are for.
        zuna.tab("Settings").tap()
        XCTAssertTrue(zuna.element(A11y.Settings.serverPicker).waitForExistence(timeout: 5))
        XCTAssertTrue(zuna.app.staticTexts["@bob · \(World.current.serverName)"].exists)
    }

    /// Opens a link the way another app would, as `zuna://join?link=…`.
    private func open(_ invite: String) throws {
        var components = URLComponents(string: "zuna://join")!
        components.queryItems = [URLQueryItem(name: "link", value: invite)]
        XCUIDevice.shared.system.open(components.url!)
        // The system may ask before opening the app.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let confirm = springboard.buttons["Open"]
        if confirm.waitForExistence(timeout: 3) { confirm.tap() }
    }
}
