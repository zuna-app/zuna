import XCTest

/// The iPad's layout, like Mail's: the servers in the sidebar when there's
/// more than one, the conversations beside them and the open chat filling the
/// rest. Runs on an iPad simulator (ZUNA_E2E_SIMULATOR="Zuna E2E iPad");
/// phones skip it.
final class PadTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(zuna.isPad, "for iPads")
    }

    func testShowsTheListAndTheChatTogether() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        // With one server there's no sidebar of servers.
        XCTAssertFalse(zuna.element(A11y.Servers.list).exists)
        zuna.screenshot("pad-10-start")

        let alice = zuna.element(A11y.ChatList.row("user:\(World.current["alice"].userId)"))
        XCTAssertTrue(alice.waitForExistence(timeout: 20))
        alice.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 10))
        // The list stays beside the chat, with the chat marked.
        XCTAssertTrue(alice.exists)
        XCTAssertTrue(alice.isSelected)
        zuna.screenshot("pad-11-chat")

        zuna.element(A11y.Shell.settingsTab).tap()
        XCTAssertTrue(zuna.element(A11y.Settings.screen).waitForExistence(timeout: 10))
        zuna.screenshot("pad-12-settings")
    }

    func testShowsAChannelsMembersBesideIt() throws {
        // Landscape, where the chat is wide enough for them, as the desktop's needs 780 points.
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let alice = try Peer("alice")
        let general = try XCTUnwrap((try alice.call("getChannels") as? [[String: Any]])?.first { $0["name"] as? String == "general" }?["id"] as? String)
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let row = zuna.element(A11y.Channels.row(general))
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 30))

        // Everyone on the server, beside the chat, with a crown for the owner.
        let list = zuna.element(A11y.Channels.memberList)
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        let owner = zuna.element(A11y.Channels.listedMember(World.current["alice"].userId))
        XCTAssertTrue(owner.waitForExistence(timeout: 10))
        XCTAssertTrue(owner.label.contains("Owner"))
        XCTAssertTrue(zuna.element(A11y.Channels.listedMember(World.current["bob"].userId)).exists)
        zuna.screenshotScreen("pad-15-channel-members")

        // A tap shows their profile.
        owner.tap()
        let profile = zuna.element(A11y.Verify.screen)
        XCTAssertTrue(profile.waitForExistence(timeout: 10))
        profile.swipeDown(velocity: .fast)
        try waitFor("the profile to close") { !profile.exists }

        // Hidden, it stays hidden, here and in the channel opened again.
        let toggle = zuna.element(A11y.Channels.memberListToggle)
        try waitFor("the member list's button") { toggle.isHittable }
        toggle.tap()
        try waitFor("the list to go") { !list.exists }
        zuna.element(A11y.ChatList.row("user:\(World.current["alice"].userId)")).tap()
        XCTAssertTrue(zuna.element(A11y.Chat.menu).waitForExistence(timeout: 10))
        XCTAssertFalse(toggle.exists)
        row.tap()
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertFalse(list.exists)
        toggle.tap()
        XCTAssertTrue(list.waitForExistence(timeout: 5))

        // Narrower than that, in portrait, the list goes, and so does its button.
        XCUIDevice.shared.orientation = .portrait
        try waitFor("the list to go in portrait") { !list.exists && !toggle.exists }
    }

    func testListsTheServersInTheSidebar() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        try zuna.setUpServer(World.current.padSetupLink, name: "Garden", password: "a garden of forking paths")
        let title = zuna.element(A11y.Shell.title)
        try waitFor("the new server to open") { title.label == "Garden" }

        // The sidebar may start hidden in portrait; its button shows it.
        let list = zuna.element(A11y.Servers.list)
        if !list.waitForExistence(timeout: 3) {
            zuna.app.buttons.matching(NSPredicate(format: "identifier == 'ToggleSidebar' OR label CONTAINS[c] 'sidebar'")).firstMatch.tap()
        }
        let first = zuna.element(A11y.Servers.row(zuna.serverId))
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        let garden = zuna.app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", A11y.Servers.row(""), "Garden"))
            .firstMatch
        XCTAssertTrue(garden.isSelected)
        zuna.screenshot("pad-13-servers")

        // Choosing a server shows its chats; in portrait the servers step aside.
        first.tap()
        try waitFor("the first server's chats") { title.label == World.current.serverName }
        zuna.screenshot("pad-14-first-server")
    }
}
