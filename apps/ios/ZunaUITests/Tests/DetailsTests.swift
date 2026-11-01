import XCTest

/// Details, groups, invites and verification, each checked from the desktop's side too.
final class DetailsTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }
    private var aliceId: String { World.current["alice"].userId }
    private var carolId: String { World.current["carol"].userId }

    private func start() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
    }

    private func open(_ key: String) {
        let row = zuna.element(A11y.ChatList.row(key))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Chat.screen).waitForExistence(timeout: 10))
    }

    private func openDetails() {
        zuna.element(A11y.Chat.title).tap()
        XCTAssertTrue(zuna.element(A11y.Details.screen).waitForExistence(timeout: 10))
    }

    /// The group's conversation on a peer, if they're in it.
    private func groupOn(_ peer: Peer, _ groupId: String) throws -> [String: Any]? {
        try peer.conversation("group:\(groupId)")
    }

    func testVerifiesAPersonWithTheSameEmojiTheDesktopShows() throws {
        try start()
        open("user:\(aliceId)")
        openDetails()
        let header = zuna.element(A11y.Details.header)
        XCTAssertTrue(header.staticTexts["@alice"].exists)
        zuna.screenshot("80-details-person")

        zuna.element(A11y.Details.trust).tap()
        let emoji = zuna.element(A11y.Verify.emoji)
        XCTAssertTrue(emoji.waitForExistence(timeout: 10))
        // Alice's desktop computes the same twelve emoji for bob.
        let alice = try Peer("alice")
        let check = try XCTUnwrap(try alice.call("safetyCheck", [bobId]) as? [String: Any])
        let expected = (check["emoji"] as? [[String: Any]] ?? []).compactMap { $0["emoji"] as? String }
        XCTAssertEqual(expected.count, 12)
        try waitFor("the emoji to show") { expected.allSatisfy { emoji.label.contains($0) } }
        zuna.screenshot("81-verify")

        zuna.element(A11y.Verify.match).tap()
        try waitFor("alice to be verified on the phone") { try self.trust(of: self.aliceId) == "verified" }
        XCTAssertTrue(zuna.element(A11y.Details.trust).waitForExistence(timeout: 5))
        try waitFor("the card to say so") { self.zuna.element(A11y.Details.trust).label.contains("Verified") }

        zuna.element(A11y.Details.trust).tap()
        let remove = zuna.element(A11y.Verify.remove)
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        try waitFor("the verification to go") { try self.trust(of: self.aliceId) == "unverified" }
    }

    private func trust(of userId: String) throws -> String? {
        let control = zuna.control!
        let serverId = zuna.serverId
        return try blocking {
            let users = try await control.call("getUsers", server: serverId) as? [[String: Any]] ?? []
            return users.first { $0["id"] as? String == userId }?["trust"] as? String
        }
    }

    func testCreatesAGroupAndManagesItsMembersForEveryone() throws {
        let alice = try Peer("alice")
        let carol = try Peer("carol")
        try start()
        let name = "Book club \(UUID().uuidString.prefix(4))"

        // A new group with carol, sharing its history.
        zuna.element(A11y.Shell.newGroup).tap()
        let field = zuna.element(A11y.Groups.name)
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(name)
        zuna.element(A11y.Groups.person("carol")).tap()
        zuna.screenshot("82-new-group")
        zuna.element(A11y.Groups.create).tap()
        XCTAssertTrue(zuna.element(A11y.Chat.screen).waitForExistence(timeout: 20))
        let groupId = try XCTUnwrap(try groupId(named: name))
        try waitFor("carol to be in it", timeout: 30) { try self.groupOn(carol, groupId)?["title"] as? String == name }

        // Alice added from the details, then made an admin.
        openDetails()
        zuna.element(A11y.Details.addMembers).tap()
        let person = zuna.element(A11y.Groups.person("alice"))
        XCTAssertTrue(person.waitForExistence(timeout: 5))
        person.tap()
        zuna.element(A11y.Groups.add).tap()
        try waitFor("alice to be in it", timeout: 30) { try self.groupOn(alice, groupId) != nil }
        let aliceRow = zuna.element(A11y.Details.member(aliceId))
        XCTAssertTrue(aliceRow.waitForExistence(timeout: 20))
        aliceRow.tap()
        zuna.app.buttons["Make admin"].tap()
        try waitFor("alice to be an admin for carol") {
            let members = try self.groupOn(carol, groupId)?["members"] as? [[String: Any]] ?? []
            return members.first { $0["userId"] as? String == self.aliceId }?["role"] as? String == "admin"
        }
        zuna.screenshot("83-group-details")

        // Carol removed, with a confirmation.
        zuna.element(A11y.Details.member(carolId)).tap()
        zuna.app.buttons["Remove from group"].tap()
        let confirm = zuna.app.buttons["Remove from group"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        try waitFor("carol to be out", timeout: 30) {
            let members = try self.groupOn(alice, groupId)?["members"] as? [[String: Any]] ?? []
            return !members.contains { $0["userId"] as? String == self.carolId }
        }

        // Renamed for everyone left.
        zuna.element(A11y.Details.edit).tap()
        let rename = zuna.element(A11y.Groups.name)
        XCTAssertTrue(rename.waitForExistence(timeout: 5))
        rename.tap()
        rename.typeText(" II")
        zuna.element(A11y.Groups.save).tap()
        try waitFor("alice to see the new name", timeout: 30) { try self.groupOn(alice, groupId)?["title"] as? String == "\(name) II" }

        // Deleted for everyone.
        zuna.app.swipeUp()
        zuna.app.buttons["Delete group for everyone"].firstMatch.tap()
        let delete = zuna.app.sheets.buttons["Delete group for everyone"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()
        // Nothing is erased on the server's word, so alice keeps it, marked as no longer hers.
        try waitFor("the group to go for alice", timeout: 30) { try self.groupOn(alice, groupId)?["removed"] as? Bool == true }
        XCTAssertNil(try self.groupId(named: "\(name) II"))
    }

    private func groupId(named name: String) throws -> String? {
        let control = zuna.control!
        let serverId = zuna.serverId
        return try blocking {
            let conversations = try await control.call("getConversations", server: serverId) as? [[String: Any]] ?? []
            return conversations.first { $0["title"] as? String == name }?["groupId"] as? String
        }
    }

    func testCreatesAndRevokesInviteLinksTheDesktopCanUse() throws {
        // A member, on a server where only admins invite, is told so.
        try start()
        zuna.element(A11y.Shell.title).tap()
        zuna.app.buttons["Invite people"].tap()
        XCTAssertTrue(zuna.app.staticTexts["On this server, only admins can create invite links. Ask one of them for a link."].waitForExistence(timeout: 10))
        XCTAssertFalse(zuna.element(A11y.Invites.create).exists)

        // The owner, on a new phone, creates a link.
        zuna.app.terminate()
        try zuna.launch()
        try zuna.signIn(as: "alice")
        try zuna.waitForChats()
        zuna.element(A11y.Shell.title).tap()
        zuna.app.buttons["Invite people"].tap()
        let create = zuna.element(A11y.Invites.create)
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.tap()
        let link = zuna.element(A11y.Invites.link)
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        let url = link.label
        XCTAssertTrue(url.contains("/invite/"), url)
        zuna.screenshot("84-invite")

        // The desktop reads the link, until it's revoked.
        let carol = try Peer("carol")
        let preview = try carol.callClient("previewInvite", [url]) as? [String: Any]
        let code = try XCTUnwrap(preview?["code"] as? String)
        let row = zuna.element(A11y.Invites.row(code))
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.buttons["Revoke link"].tap()
        try waitFor("the link to stop working") {
            (try? carol.callClient("previewInvite", [url])) == nil
        }
    }

    func testMutesFromTheDetails() throws {
        try start()
        open("user:\(carolId)")
        openDetails()
        let key = "user:\(carolId)"
        let toggle = zuna.app.switches[A11y.Details.notifications]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        // Turning notifications off asks for how long.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let forever = zuna.app.buttons["Until I turn it back on"]
        XCTAssertTrue(forever.waitForExistence(timeout: 5))
        forever.tap()
        try waitFor("the chat to be muted") { try self.zuna.preferences()["muted"]?.contains(key) == true }
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        try waitFor("the chat to be unmuted") { try self.zuna.preferences()["muted"]?.contains(key) == false }
    }
}
