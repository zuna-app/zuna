import XCTest

/// Runs async work (RPC over the network) to completion from a synchronous
/// test. UI tests stay synchronous on purpose: XCUIApplication waits for the
/// app by spinning the main run loop, which an async test on the main actor
/// would block.
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
