import XCTest

/// Sharing into Zuna from another app, Photos here, through the share sheet.
/// With the app asleep, the share extension sends with a core of its own; with
/// the app still awake, it hands the app what to send. Each test checks what
/// the desktop received, and that the app carries on after.
final class ShareTests: XCTestCase {
    private let zuna = AppUnderTest()
    private let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")

    override func setUp() {
        continueAfterFailure = false
    }

    private var bobId: String { World.current["bob"].userId }

    func testSendsAPhotoWithItsOwnCoreWhileZunaSleeps() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        XCUIDevice.shared.press(.home)

        try share(comment: "Shared while Zuna slept", expecting: "extension")
        let alice = try Peer("alice")
        try waitForPicture(alice, "Shared while Zuna slept")

        // Back in Zuna, which reads everything again: the chat has it, and the app sends as before.
        zuna.app.activate()
        try openAlice()
        XCTAssertTrue(message("Shared while Zuna slept").waitForExistence(timeout: 15))
        let input = zuna.element(A11y.Composer.input)
        input.tap()
        input.typeText("And from the app after")
        zuna.element(A11y.Composer.send).tap()
        try waitFor("alice to get the app's next message", timeout: 20) {
            try alice.texts(with: self.bobId).contains("And from the app after")
        }
        zuna.screenshot("150-after-sharing")
    }

    func testHandsAPhotoToZunaWhileItIsStillAwake() throws {
        // Out of sight for two minutes before it sleeps, as if a call kept it awake.
        try zuna.launch(suspendDelay: 120)
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        XCUIDevice.shared.press(.home)

        try share(comment: "Handed to the app", expecting: "app")
        let alice = try Peer("alice")
        try waitForPicture(alice, "Handed to the app")

        zuna.app.activate()
        try openAlice()
        XCTAssertTrue(message("Handed to the app").waitForExistence(timeout: 15))
    }

    func testChoosesTheServerToShareTo() throws {
        try zuna.launch()
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        // A second server, which bob sets up.
        _ = try zuna.register("bob", password: World.current["bob"].password, invite: World.current.shareSetupLink)
        XCUIDevice.shared.press(.home)

        try openShareSheet()
        let any = photos.descendants(matching: .any)
        let alice = any[A11y.Share.row("alice")]
        XCTAssertTrue(alice.waitForExistence(timeout: 30), "The server open in the app comes first: \(photos.debugDescription)")
        // The other server has only saved messages so far.
        any[A11y.Share.servers].tap()
        let servers = any.matching(NSPredicate(format: "identifier BEGINSWITH 'share.server.'"))
        try waitFor("both servers to be offered") { servers.count == 2 }
        zuna.screenshotScreen("154-share-servers")
        // Test servers share a name, so the other one is the one not marked.
        let unmarked = { (0..<servers.count).map { servers.element(boundBy: $0) }.first { !$0.isSelected } }
        try XCTUnwrap(unmarked()).tap()
        XCTAssertTrue(any[A11y.Share.row("Saved messages")].waitForExistence(timeout: 10))
        XCTAssertFalse(alice.exists)

        // And back, to send to alice there.
        any[A11y.Share.servers].tap()
        try waitFor("the servers to be offered again") { servers.count == 2 }
        try XCTUnwrap(unmarked()).tap()
        try send(to: "alice", comment: "Picked the server")
        try waitForPicture(try Peer("alice"), "Picked the server")
    }

    // MARK: Photos and the share sheet

    /// Shares Photos' first picture to alice with a comment, checking whose core the sheet's chats came from.
    private func share(comment: String, expecting route: String) throws {
        try openShareSheet()
        let sheet = photos.descendants(matching: .any)[A11y.Share.sheet]
        XCTAssertTrue(photos.descendants(matching: .any)[A11y.Share.row("alice")].waitForExistence(timeout: 30), "Zuna's sheet has no alice: \(photos.debugDescription)")
        XCTAssertEqual(sheet.value as? String, route)
        try send(to: "alice", comment: comment, screenshot: "151-share-sheet-\(route)")
    }

    /// Opens Photos' first picture, then Zuna in its share sheet.
    private func openShareSheet() throws {
        // In English, whatever the simulator speaks, as the app is.
        photos.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        photos.launch()
        // Photos asks for notifications, and says what's new, the first time it opens.
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if alert.waitForExistence(timeout: 3) { alert.buttons.element(boundBy: 0).tap() }
        let proceed = photos.buttons["Continue"]
        if proceed.waitForExistence(timeout: 2) { proceed.tap() }
        // Photos opens where it was left: on a picture, or the library's grid, whose pictures it marks so.
        let shareButton = photos.buttons["PUOneUpBarButtonItemIdentifierShare"]
        if !shareButton.waitForExistence(timeout: 3) {
            let picture = photos.images.matching(identifier: "PXGGridLayout-Info").firstMatch
            XCTAssertTrue(picture.waitForExistence(timeout: 10), "No picture in Photos: \(photos.debugDescription)")
            picture.tap()
            // The simulator's Photos sometimes lets the first tap go by.
            if !shareButton.waitForExistence(timeout: 8), picture.isHittable { picture.tap() }
        }
        XCTAssertTrue(shareButton.waitForExistence(timeout: 10), "Photos didn't open the picture: \(photos.debugDescription)")
        shareButton.tap()

        try shareSheetEntry("Zuna").tap()
        if !photos.descendants(matching: .any)[A11y.Share.sheet].waitForExistence(timeout: 20) {
            zuna.screenshotScreen("152-no-share-sheet")
            XCTFail("Zuna's sheet didn't show: \(photos.debugDescription)")
        }
    }

    /// Picks a chat in the open sheet, writes a comment and sends, then waits for the sheet to close.
    private func send(to title: String, comment: String, screenshot: String? = nil) throws {
        let any = photos.descendants(matching: .any)
        let row = any[A11y.Share.row(title)]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "No \(title) in Zuna's sheet: \(photos.debugDescription)")
        row.tap()
        let field = any[A11y.Share.comment]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(comment)
        if let screenshot { zuna.screenshotScreen(screenshot) }
        let send = any[A11y.Share.send]
        try waitFor("the picture to be ready to send") { send.isEnabled }
        send.tap()
        // The sheet closes once it's sent.
        let sheet = any[A11y.Share.sheet]
        try waitFor("the share sheet to close", timeout: 90) { !sheet.exists }
    }

    /// An app in the share sheet's row of apps, which may need scrolling to.
    private func shareSheetEntry(_ name: String) throws -> XCUIElement {
        let candidates = [photos.cells[name], photos.buttons[name], photos.otherElements[name]]
        for _ in 0..<6 {
            if let found = candidates.first(where: { $0.waitForExistence(timeout: 2) && $0.isHittable }) { return found }
            // The row of apps, below the row of people.
            let row = photos.collectionViews.element(boundBy: photos.collectionViews.count > 1 ? 1 : 0)
            row.swipeLeft()
        }
        XCTFail("Zuna isn't in the share sheet: \(photos.debugDescription)")
        throw RPCError(description: "no Zuna in the share sheet")
    }

    /// A message in the open chat, by its text.
    private func message(_ text: String) -> XCUIElement {
        zuna.app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'chat.text.' AND label BEGINSWITH %@", text)).firstMatch
    }

    private func openAlice() throws {
        try zuna.waitForChats()
        let row = zuna.element(A11y.ChatList.row("user:\(World.current["alice"].userId)"))
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(zuna.element(A11y.Composer.input).waitForExistence(timeout: 10))
    }

    /// Waits for alice's desktop to have the comment, with a picture.
    private func waitForPicture(_ alice: Peer, _ text: String) throws {
        try waitFor("alice to get the picture", timeout: 30) {
            let groupId = try XCTUnwrap(try alice.conversation("user:\(self.bobId)")?["groupId"] as? String)
            let page = try alice.call("loadMessages", [groupId]) as? [String: Any]
            let messages = page?["messages"] as? [[String: Any]] ?? []
            guard let message = messages.last(where: { $0["text"] as? String == text }) else { return false }
            let attachments = message["attachments"] as? [[String: Any]] ?? []
            return attachments.count == 1 && (attachments[0]["mime"] as? String)?.hasPrefix("image/") == true
        }
    }
}
