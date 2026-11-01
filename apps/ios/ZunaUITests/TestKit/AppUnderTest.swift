import XCTest

/// Runs async work (RPC over the network) to completion from a synchronous
/// test. UI tests stay synchronous on purpose: XCUIApplication waits for the
/// app by spinning the main run loop, which an async test on the main actor
/// would block.
@discardableResult
func blocking<Value: Sendable>(_ body: @escaping @Sendable () async throws -> Value) throws -> Value {
    let semaphore = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var result: Result<Value, Error>!
    // The main thread waits, so the work runs at its priority.
    Task.detached(priority: .userInitiated) {
        do { result = .success(try await body()) } catch { result = .failure(error) }
        semaphore.signal()
    }
    semaphore.wait()
    return try result.get()
}

/// Waits for a condition, keeping the main run loop turning, without fixed sleeps.
func waitFor(_ what: String, timeout: TimeInterval = 20, _ condition: () throws -> Bool) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if (try? condition()) == true { return }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    throw RPCError(description: "Timed out waiting for \(what)")
}

/// The Zuna app as the UI tests drive it. Its control channel lets a test set
/// things up quickly (signing in, for instance) and check the core's state,
/// while everything a person would do goes through the UI.
final class AppUnderTest {
    let app = XCUIApplication()
    private(set) var control: RPCSocket!
    private(set) var serverId = ""

    /// Launches the app. `fresh` erases its data first; `bootSession` simulates a restart of the phone.
    /// `notifications` lets the app ask for notifications, as it does once its
    /// chats first show; other tests keep the system's question out of the way.
    func launch(fresh: Bool = true, bootSession: String? = nil, textSize: String? = nil, notifications: Bool = false) throws {
        let port = Int.random(in: 40_000..<50_000)
        app.launchArguments = [
            "-ZunaControlPort", String(port),
            "-ZunaSuspendDelay", "0.5",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        if fresh { app.launchArguments += ["-ZunaResetData", "YES"] }
        // Voice messages record a tone: the simulator's microphone is the Mac's, behind the Mac's own permission.
        app.launchArguments += ["-ZunaFakeMicrophone", "YES"]
        app.launchArguments += ["-ZunaAskForNotifications", notifications ? "YES" : "NO"]
        if notifications {
            // The test relay and a made-up token stand in for APNs, which the simulator can't use without the app's key.
            app.launchArguments += ["-ZunaPushRelay", World.current.pushRelay, "-ZunaPushToken", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"]
        } else {
            // Never the real relay the app is built with.
            app.launchArguments += ["-ZunaPushRelay", ""]
        }
        if let bootSession { app.launchArguments += ["-ZunaBootSession", bootSession] }
        // Dynamic Type, as a UIContentSizeCategory name such as UICTContentSizeCategoryAccessibilityXL.
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
        app.launchEnvironment["TZ"] = "UTC"
        app.launch()
        control = try blocking { try await RPCSocket.connect(to: URL(string: "ws://127.0.0.1:\(port)")!) }
        try waitFor("the app to start") { try self.state() != "booting" }
    }

    /// How many accounts' passwords can unlock the device key.
    func lockEntries() throws -> String {
        let control = control!
        return try blocking { try await control.host("lockEntries") as? String ?? "" }
    }

    func state() throws -> String {
        let control = control!
        return try blocking { try await control.host("state") as? String ?? "" }
    }

    /// Signs in programmatically, as a new device of an account in the test world.
    func signIn(as name: String) throws {
        let account = World.current[name]
        let control = control!
        serverId = try blocking {
            try await control.call("login", [World.current.serverUrl, account.username, account.password]) as? String ?? ""
        }
        let serverId = serverId
        try waitFor("the app to come online") {
            try blocking { try await control.call("getConnectionState", server: serverId) as? String == "online" }
        }
    }

    /// Creates an account through the app's core, as the join screens would, and returns its recovery key.
    func register(_ username: String, password: String) throws -> String {
        let control = control!
        let result = try blocking {
            let preview = try await control.call("previewInvite", [World.current.invite]) as? [String: Any] ?? [:]
            return try await control.call("register", [preview, username, password, ["displayName": username.capitalized]]) as? [String: Any] ?? [:]
        }
        serverId = result["serverId"] as? String ?? ""
        return result["recoveryKey"] as? String ?? ""
    }

    /// The conversation preferences of the signed-in server: pinned, muted and hidden keys.
    func preferences() throws -> [String: [String]] {
        let control = control!
        let serverId = serverId
        let prefs = try blocking { try await control.call("getPreferences", server: serverId) as? [String: Any] ?? [:] }
        return prefs.compactMapValues { $0 as? [String] }
    }

    /// The core's connection state for the signed-in server.
    func connectionState() throws -> String {
        let control = control!
        let serverId = serverId
        return try blocking { try await control.call("getConnectionState", server: serverId) as? String ?? "" }
    }

    /// Sends a message from the app's core, as the composer would (it comes in F5).
    func send(to key: String, _ text: String) throws {
        let control = control!
        let serverId = serverId
        try blocking { _ = try await control.call("sendMessage", server: serverId, [key, ["text": text]]) }
    }

    /// Adds a file to the open chat's composer, as if picked (Debug builds only).
    func attachFile(_ url: URL) throws {
        let control = control!
        let path = url.path
        try blocking { _ = try await control.host("attachFile", ["path": path]) }
    }

    /// How many of the app's notifications are in the notification center.
    func deliveredNotifications() throws -> Int {
        let control = control!
        return try blocking { Int(try await control.host("deliveredNotifications") as? String ?? "") ?? -1 }
    }

    /// Clears the notifications already delivered, so a test sees only its own.
    func clearNotifications() throws {
        let control = control!
        try blocking { _ = try await control.host("clearNotifications") }
    }

    /// A yes-or-no preference of the signed-in server, such as sendReadReceipts.
    func preferencesFlag(_ name: String) throws -> Bool? {
        let control = control!
        let serverId = serverId
        return try blocking { (try await control.call("getPreferences", server: serverId) as? [String: Any])?[name] as? Bool }
    }

    /// The signed-in account's user ID.
    func selfId() throws -> String {
        let control = control!
        let serverId = serverId
        return try blocking { (try await control.call("getSelf", server: serverId) as? [String: Any])?["userId"] as? String ?? "" }
    }

    /// Cuts the core off the network, or reconnects it.
    func setOffline(_ offline: Bool) throws {
        let control = control!
        try blocking { _ = try await control.host("offline", ["value": offline]) }
    }

    /// A toast whose text starts with these words.
    func toast(startingWith text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: A11y.Toast.item)
            .matching(NSPredicate(format: "label BEGINSWITH %@", text))
            .firstMatch
    }

    /// How many servers the app's core has accounts on.
    func serverCount() throws -> Int {
        let control = control!
        return try blocking { (try await control.call("listServers") as? [Any])?.count ?? 0 }
    }

    /// Types into a field after tapping it, replacing what was there.
    func type(_ text: String, into identifier: String, clearing: Bool = false) {
        let field = element(identifier)
        field.tap()
        let secure = field.elementType == .secureTextField
        if secure { declineStrongPassword(for: field) }
        if clearing, let current = field.value as? String, !current.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 4))
        }
        field.typeText(text)
        // On an iPad the offer may only come up once typing starts, and take the rest of it.
        if secure, declineStrongPassword(for: field) {
            let typed = (field.value as? String)?.count ?? 0
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed + 4) + text)
        }
    }

    /// New-password fields bring up the system's offer of a strong password,
    /// which takes the keyboard's place. A person can type their own instead.
    @discardableResult
    private func declineStrongPassword(for field: XCUIElement) -> Bool {
        guard app.buttons["GenerateStrongPasswordButton"].waitForExistence(timeout: 1.5) else { return false }
        app.buttons["xmark"].firstMatch.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 1) { field.tap() }
        return true
    }

    /// After a sign-up the system offers to save the password, over the app.
    /// Its first button declines, whatever language the simulator is in.
    func declineSavingPassword() {
        let sheet = app.sheets.firstMatch
        guard sheet.waitForExistence(timeout: 3), sheet.buttons.count >= 2 else { return }
        sheet.buttons.element(boundBy: 0).tap()
        _ = sheet.waitForNonExistence(timeout: 5)
    }

    /// Turns a switch on or off by tapping the switch itself, not its label.
    func toggle(_ identifier: String) {
        app.switches[identifier].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    }

    /// The messages of a conversation, as the app's core sees them.
    func texts(with userId: String) throws -> [String] {
        let control = control!
        let serverId = serverId
        return try blocking {
            let conversations = try await control.call("getConversations", server: serverId) as? [[String: Any]] ?? []
            guard let groupId = conversations.first(where: { $0["key"] as? String == "user:\(userId)" })?["groupId"] as? String else { return [] }
            let page = try await control.call("loadMessages", server: serverId, [groupId]) as? [String: Any]
            return (page?["messages"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
        }
    }

    /// Waits for a server's conversation list, which shows once a server is
    /// signed in, under the server's name.
    func waitForChats(timeout: TimeInterval = 20) throws {
        let title = element(A11y.Shell.title)
        try waitFor("the conversation list", timeout: timeout) { title.exists }
    }

    /// Sets up a new server from its setup link, as its owner, from the
    /// conversation list's menu, which offers it while there's one server.
    func setUpServer(_ link: String, name: String, password: String, screenshots: Bool = false) throws {
        element(A11y.Shell.title).tap()
        app.buttons["Join a server"].tap()
        let field = element(A11y.Onboarding.link)
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        type(link, into: A11y.Onboarding.link)
        element(A11y.Onboarding.continue).tap()
        XCTAssertTrue(app.staticTexts["Set up your server"].waitForExistence(timeout: 15))

        type("Fox Mulder", into: A11y.Onboarding.displayName)
        type(password, into: A11y.Onboarding.password)
        // The password is rated a moment after it's typed.
        let create = element(A11y.Onboarding.create)
        try waitFor("the password to be rated") { create.isEnabled }
        create.tap()
        XCTAssertTrue(element(A11y.Onboarding.recoveryKey).waitForExistence(timeout: 30))
        declineSavingPassword()
        toggle(A11y.Onboarding.keyStored)
        element(A11y.Onboarding.keyContinue).tap()

        let serverName = element(A11y.Onboarding.serverName)
        XCTAssertTrue(serverName.waitForExistence(timeout: 5))
        type(name, into: A11y.Onboarding.serverName)
        if screenshots { screenshot("47-name-server") }
        element(A11y.Onboarding.nameDone).tap()
    }

    /// The back button to the list of servers, over a server's conversations.
    var serversButton: XCUIElement {
        app.navigationBars.buttons["Servers"]
    }

    var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// A tab in the tab bar, by its title.
    func tab(_ title: String) -> XCUIElement {
        app.tabBars.buttons[title]
    }

    func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    /// Keeps a screenshot of the whole screen, such as the lock screen or a notification.
    func screenshotScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: "Screenshot \(name)") { $0.add(attachment) }
    }

    /// Keeps a screenshot with the test results, for reviewing how screens look.
    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: "Screenshot \(name)") { $0.add(attachment) }
    }
}
