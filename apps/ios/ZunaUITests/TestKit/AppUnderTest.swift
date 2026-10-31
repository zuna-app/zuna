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
    func launch(fresh: Bool = true, bootSession: String? = nil) throws {
        let port = Int.random(in: 40_000..<50_000)
        app.launchArguments = [
            "-ZunaControlPort", String(port),
            "-ZunaSuspendDelay", "0.5",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        if fresh { app.launchArguments += ["-ZunaResetData", "YES"] }
        if let bootSession { app.launchArguments += ["-ZunaBootSession", bootSession] }
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
        if field.elementType == .secureTextField { declineStrongPassword(for: field) }
        if clearing, let current = field.value as? String, !current.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 4))
        }
        field.typeText(text)
    }

    /// New-password fields bring up the system's offer of a strong password,
    /// which takes the keyboard's place. A person can type their own instead.
    private func declineStrongPassword(for field: XCUIElement) {
        guard app.buttons["GenerateStrongPasswordButton"].waitForExistence(timeout: 1.5) else { return }
        app.buttons["xmark"].firstMatch.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 1) { field.tap() }
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

    /// Waits for the conversation list, which shows once a server is signed in.
    func waitForChats(timeout: TimeInterval = 20) throws {
        guard element(A11y.Shell.serverButton).waitForExistence(timeout: timeout) else {
            throw RPCError(description: "The conversation list didn't show")
        }
    }

    /// A tab in the tab bar, by its title.
    func tab(_ title: String) -> XCUIElement {
        app.tabBars.buttons[title]
    }

    func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    /// Keeps a screenshot with the test results, for reviewing how screens look.
    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: "Screenshot \(name)") { $0.add(attachment) }
    }
}
