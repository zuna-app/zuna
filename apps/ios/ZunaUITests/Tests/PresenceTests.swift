import XCTest

/// Online and last seen, as the desktop peer alice sees the person on this phone.
final class PresenceTests: XCTestCase {
    private let zuna = AppUnderTest()

    override func setUp() {
        continueAfterFailure = false
    }

    /// Locked with the app open, the phone takes bob offline at once, as Telegram's does,
    /// rather than after the linger of a connection lost. The core stays
    /// connected for as long as the app's does, so it's the app saying so that counts,
    /// not its connection closing.
    func testLockingThePhoneGoesOfflineAtOnce() throws {
        try zuna.launch(suspendDelay: 20)
        try zuna.signIn(as: "bob")
        try zuna.waitForChats()
        let alice = try Peer("alice"), bob = World.current["bob"].userId
        func bobOnline() throws -> Bool? {
            let users = try alice.call("getUsers") as? [[String: Any]] ?? []
            return users.first { $0["id"] as? String == bob }?["online"] as? Bool
        }
        try waitFor("alice to see bob online") { try bobOnline() == true }

        // Well within the 20 s the core stays connected, and sooner than a lost connection's 5 s linger.
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        try waitFor("alice to see bob offline", timeout: 4) { try bobOnline() == false }

        // Unlocked and back in the app: online again.
        XCUIDevice.shared.press(.home)
        zuna.app.activate()
        try waitFor("the app to be in front") { self.zuna.app.state == .runningForeground }
        try waitFor("alice to see bob online again") { try bobOnline() == true }
    }
}
