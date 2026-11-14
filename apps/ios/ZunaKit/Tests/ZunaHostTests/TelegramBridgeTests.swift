import Foundation
import XCTest
@testable import ZunaHost

/// The broker for a linked Telegram account's helper (TelegramBridge.swift), as the desktop's is
/// tested in apps/desktop/src/telegram: what may be asked of the engine, where the door goes, and
/// the key to the engine's database, sealed with the device key.
final class TelegramBridgeTests: XCTestCase {
    func testWhatsListedGoesAndNothingElse() {
        XCTAssertNil(TelegramFunctions.refusal(["@type": "getChats", "limit": 20]))
        XCTAssertNil(TelegramFunctions.refusal(["@type": "sendMessage", "chat_id": 1]))
        for kind in ["deleteAccount", "setPassword", "terminateAllOtherSessions", "terminateSession", "changePhoneNumber", "importContacts", "addProxy", "setTdlibParameters", "logOut", "destroy", "sendPaymentForm", "setLoginEmailAddress"] {
            XCTAssertNotNil(TelegramFunctions.refusal(["@type": kind]), "\(kind) was let through")
        }
        XCTAssertNotNil(TelegramFunctions.refusal(["limit": 20]))
    }

    func testAFieldHeldToValuesTakesOnlyThose() {
        XCTAssertNil(TelegramFunctions.refusal(["@type": "setOption", "name": "online", "value": ["@type": "optionValueBoolean", "value": true]]))
        XCTAssertNotNil(TelegramFunctions.refusal(["@type": "setOption", "name": "use_storage_optimizer"]))
        XCTAssertNotNil(TelegramFunctions.refusal(["@type": "setOption"]))
        XCTAssertNil(TelegramFunctions.refusal(["@type": "deleteChatHistory", "chat_id": 1, "remove_from_chat_list": true, "revoke": false]))
        // JSON's true isn't 1, and a history can't be taken back for everyone.
        XCTAssertNotNil(TelegramFunctions.refusal(["@type": "deleteChatHistory", "chat_id": 1, "remove_from_chat_list": 1, "revoke": false]))
        XCTAssertNotNil(TelegramFunctions.refusal(["@type": "deleteChatHistory", "chat_id": 1, "remove_from_chat_list": true, "revoke": true]))
        XCTAssertNil(TelegramFunctions.refusal(["@type": "setChatMemberStatus", "status": ["@type": "chatMemberStatusLeft"]]))
        XCTAssertNotNil(TelegramFunctions.refusal(["@type": "setChatMemberStatus", "status": ["@type": "chatMemberStatusBanned"]]))
    }

    func testTheDoorGoesToTelegramsAddressesAlone() {
        XCTAssertTrue(TelegramDoor.allowed(host: "149.154.167.40", port: 443))
        XCTAssertTrue(TelegramDoor.allowed(host: "91.108.56.130", port: 80))
        XCTAssertTrue(TelegramDoor.allowed(host: "2001:67c:4e8:f002::a", port: 443))
        XCTAssertTrue(TelegramDoor.allowed(host: "::ffff:149.154.175.10", port: 5222))
        XCTAssertFalse(TelegramDoor.allowed(host: "149.154.167.40", port: 22), "a port Telegram doesn't use")
        XCTAssertFalse(TelegramDoor.allowed(host: "149.154.176.1", port: 443), "just past 149.154.160.0/20")
        XCTAssertFalse(TelegramDoor.allowed(host: "8.8.8.8", port: 443))
        XCTAssertFalse(TelegramDoor.allowed(host: "127.0.0.1", port: 443))
        XCTAssertFalse(TelegramDoor.allowed(host: "2001:4860:4860::8888", port: 443))
        XCTAssertFalse(TelegramDoor.allowed(host: "dns.google", port: 443), "a name, which the door never resolves")
    }

    func testTheDatabaseKeyIsSealedAndComesBack() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zuna-telegram-key-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let bridge = { (deviceKey: Data) in
            TelegramBridge(configuration: TelegramBridge.Configuration(credentials: TelegramBridge.Credentials(apiId: "1", apiHash: String(repeating: "0", count: 32), testDc: true)!, launcher: NoHelper(), version: "0", system: "iOS", device: "iPhone"),
                           dataDirectory: directory, cacheDirectory: directory, deviceKey: deviceKey) { _ in }
        }
        let first = try bridge(Data(repeating: 7, count: 32)).databaseKey()
        XCTAssertEqual(first.count, 32)
        XCTAssertEqual(try bridge(Data(repeating: 7, count: 32)).databaseKey(), first)
        let sealed = try Data(contentsOf: bridge(Data(repeating: 7, count: 32)).keyFile)
        XCTAssertNil(sealed.range(of: first), "the key is kept sealed")
        // Another device key opens nothing.
        XCTAssertThrowsError(try bridge(Data(repeating: 8, count: 32)).databaseKey())
    }

    func testCredentialsAreOnlyWhatTelegramGives() {
        XCTAssertNotNil(TelegramBridge.Credentials(apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef", testDc: false))
        XCTAssertNil(TelegramBridge.Credentials(apiId: "", apiHash: "0123456789abcdef0123456789abcdef", testDc: false), "a build without them has no Telegram")
        XCTAssertNil(TelegramBridge.Credentials(apiId: "$(TELEGRAM_API_ID)", apiHash: "", testDc: false))
        XCTAssertNil(TelegramBridge.Credentials(apiId: "12345", apiHash: "not hex", testDc: false))
    }

    func testACopysExtensionIsAPlainOne() {
        XCTAssertEqual(TelegramBridge.fileExtension(of: "/x/files/photos/1_2.jpg"), ".jpg")
        XCTAssertEqual(TelegramBridge.fileExtension(of: "/x/files/documents/note"), "")
        XCTAssertEqual(TelegramBridge.fileExtension(of: "/x/files/a.b/c../.."), "")
        XCTAssertEqual(TelegramBridge.fileExtension(of: "/x/files/a.m4a/../evil.toolongext"), "")
    }

    func testAHelperThatCantStartTDLibIsStartedAgainThenGivenUpOnUntilAskedAgain() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zuna-telegram-failed-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let launcher = FailingHelper()
        let heard = Heard()
        let bridge = TelegramBridge(configuration: TelegramBridge.Configuration(credentials: TelegramBridge.Credentials(apiId: "1", apiHash: String(repeating: "0", count: 32), testDc: true)!, launcher: launcher, version: "0", system: "iOS", device: "iPhone"),
                                    dataDirectory: directory, cacheDirectory: directory, deviceKey: Data(repeating: 7, count: 32)) { heard.add($0) }
        let gaveUp = expectation(description: "given up on")
        heard.onFailed(gaveUp)
        XCTAssertNil(bridge.start())
        wait(for: [gaveUp], timeout: 10)
        XCTAssertEqual(launcher.launches, TelegramBridge.mostRestarts + 1)
        XCTAssertEqual(heard.count("zunaRestarted"), TelegramBridge.mostRestarts)
        XCTAssertEqual(heard.count("zunaFailed"), 1)
        XCTAssertTrue(heard.last?.contains("couldn't open its door") == true, "the helper's reason is the one given")
        // The core asks again, as when the app comes back on screen: its restarts are counted afresh.
        let again = expectation(description: "given up on again")
        heard.onFailed(again)
        XCTAssertNil(bridge.start())
        wait(for: [again], timeout: 10)
        XCTAssertEqual(launcher.launches, 2 * (TelegramBridge.mostRestarts + 1))
    }

    /// A launcher for tests that reach no helper.
    private struct NoHelper: TelegramHelperLauncher {
        func launch(_ handlers: TelegramHelperHandlers) async throws -> any TelegramHelperLink {
            throw CoreError(description: "No helper in tests.")
        }
    }

    /// A helper that starts, and then says it couldn't start TDLib, as when its door can't open.
    private final class FailingHelper: TelegramHelperLauncher, @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var launches: Int { lock.withLock { count } }

        func launch(_ handlers: TelegramHelperHandlers) async throws -> any TelegramHelperLink {
            lock.withLock { count += 1 }
            return FailingLink(handlers)
        }
    }

    private final class FailingLink: TelegramHelperLink, @unchecked Sendable {
        private let handlers: TelegramHelperHandlers
        init(_ handlers: TelegramHelperHandlers) { self.handlers = handlers }

        func send(json: String) {
            if json.contains(#""zuna":"start""#) {
                handlers.json(#"{"zuna":"failed","reason":"Telegram's engine couldn't open its door: bind"}"#)
            }
        }

        func send(stream: UInt32, bytes: Data, taken: @escaping @Sendable (Bool) -> Void) { taken(false) }

        func open(path: String, done: @escaping @Sendable (Result<FileHandle, Error>) -> Void) {
            done(.failure(CoreError(description: "No files in tests.")))
        }

        func close() { handlers.ended("stopped") }
    }

    /// What the broker told the core, and an expectation met by the next `zunaFailed`.
    private final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var messages: [String] = []
        private var waiting: XCTestExpectation?

        func onFailed(_ expectation: XCTestExpectation) { lock.withLock { waiting = expectation } }

        func add(_ json: String) {
            let met: XCTestExpectation? = lock.withLock {
                messages.append(json)
                guard json.contains("zunaFailed") else { return nil }
                defer { waiting = nil }
                return waiting
            }
            met?.fulfill()
        }

        func count(_ kind: String) -> Int { lock.withLock { messages.filter { $0.contains(kind) }.count } }
        var last: String? { lock.withLock { messages.last } }
    }
}
