import Foundation

/// The test world the orchestrator (tests/e2e/src/ui-run.ts) sets up before
/// the UI tests run: a server, its emotes, and desktop clients ("peers") with
/// accounts and history. It arrives as JSON in TEST_RUNNER_ZUNA_WORLD.
struct World: Decodable {
    struct Account: Decodable {
        let username: String
        let password: String
        let userId: String
        let serverId: String
    }

    let serverUrl: String
    let serverName: String
    let invite: String
    /// The setup link of a second server, which nobody owns yet.
    let setupLink: String
    /// The setup link of a third, for the iPad's test of the list of servers.
    let padSetupLink: String
    /// The setup link of a fourth, for choosing a server to share to.
    let shareSetupLink: String
    /// The orchestrator's stand-in for zuna-push, which the server allows.
    let pushRelay: String
    /// A website on the Mac, for link previews.
    let siteUrl: String
    let peersUrl: String
    /// alice, carol and bob's laptop are peers; the app signs in as bob.
    let accounts: [String: Account]

    static let current: World = {
        guard let json = ProcessInfo.processInfo.environment["ZUNA_WORLD"], let data = json.data(using: .utf8) else {
            fatalError("No test world. Run the UI tests with npm run test:ios:ui.")
        }
        do {
            return try JSONDecoder().decode(World.self, from: data)
        } catch {
            fatalError("The test world couldn't be read: \(error)")
        }
    }()

    subscript(name: String) -> Account {
        guard let account = accounts[name] else { fatalError("No account named \(name) in the test world") }
        return account
    }
}
