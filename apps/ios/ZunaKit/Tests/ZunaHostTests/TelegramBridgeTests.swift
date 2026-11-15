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

    func testAHelperThatKeepsFailingIsStartedAgainForAsLongAsItsWanted() throws {
        let launcher = FailingHelper()
        let heard = Heard()
        let (bridge, directory) = try bridge(launcher, heard) { $0.retryDelays = [0, 0.01, 0.02] }
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertNil(bridge.start())
        // Past its first few failures the core is told why, each time, and that it's still tried.
        heard.wait(for: "zunaFailed", times: 3)
        let failed = try XCTUnwrap(heard.first("zunaFailed"))
        XCTAssertTrue(failed.contains("couldn't open its door"), "the helper's reason is the one given")
        XCTAssertTrue(failed.contains(#""retrying":true"#), "the core is told it isn't given up on")
        XCTAssertEqual(heard.index(of: "zunaFailed"), TelegramBridge.mostRestarts, "told only once it has failed a few times in a row")
        XCTAssertGreaterThanOrEqual(launcher.launches, TelegramBridge.mostRestarts + 3, "started again after the core was told")
        // Each start after a failure is said, so the core shows it connecting.
        XCTAssertGreaterThanOrEqual(heard.count("zunaRestarted"), TelegramBridge.mostRestarts + 2)
        // Until it's stopped, and then no more.
        bridge.stop(signOut: false)
        heard.wait(for: "zunaStopped", times: 1)
        let stopped = launcher.launches
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(launcher.launches, stopped, "nothing starts once it's stopped")
    }

    func testAHelperThatGoesWhileTheAppSleepsStartsAsItWakesAndCountsForNothing() throws {
        let launcher = LivingHelper()
        let heard = Heard()
        // A wait before any start after a failure that the test would never see the end of.
        let (bridge, directory) = try bridge(launcher, heard) { $0.retryDelays = [600] }
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertNil(bridge.start())
        let first = launcher.waitForLink(1)
        // iOS ends a suspended helper when it wants its memory, as often as the app sleeps.
        for round in 1...(TelegramBridge.mostRestarts + 2) {
            bridge.sleep()
            launcher.link(round).die()
            Thread.sleep(forTimeInterval: 0.15)
            XCTAssertEqual(launcher.launches, round, "nothing starts while the app sleeps")
            XCTAssertEqual(heard.count("zunaRestarted"), round - 1)
            bridge.wake()
            _ = launcher.waitForLink(round + 1)
            heard.wait(for: "zunaRestarted", times: round)
        }
        XCTAssertEqual(heard.count("zunaFailed"), 0, "a helper that went while the app slept hasn't failed")
        XCTAssertTrue(first.started, "the helper is given its start")
        // Awake, the same is a failure, which waits its turn to start again, and waking doesn't hurry one that never slept.
        let last = launcher.launches
        launcher.link(last).die()
        Thread.sleep(forTimeInterval: 0.15)
        bridge.wake()
        Thread.sleep(forTimeInterval: 0.15)
        XCTAssertEqual(launcher.launches, last)
        // Asleep before its turn came, it starts as the app wakes.
        bridge.sleep()
        bridge.wake()
        _ = launcher.waitForLink(last + 1)
        bridge.stop(signOut: false)
        heard.wait(for: "zunaStopped", times: 1)
    }

    func testAStartWithTheAppOutOfSightWaitsUntilItsBack() throws {
        let launcher = LivingHelper()
        let heard = Heard()
        let (bridge, directory) = try bridge(launcher, heard) { _ in }
        defer { try? FileManager.default.removeItem(at: directory) }
        // iOS started the app in the background, as for a push, and the core asks for its account.
        bridge.sleep()
        XCTAssertNil(bridge.start())
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(launcher.launches, 0, "nothing starts for an app out of sight")
        // Asked again there, as when the network comes back, it still waits.
        XCTAssertNil(bridge.start())
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(launcher.launches, 0)
        bridge.wake()
        XCTAssertTrue(launcher.waitForLink(1).started)
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(launcher.launches, 1, "and only once")
        XCTAssertEqual(heard.count("zunaFailed"), 0)
        bridge.stop(signOut: false)
        heard.wait(for: "zunaStopped", times: 1)
    }

    func testAHelperThatAnswersNothingIsEndedButNotWhileTheAppSleeps() throws {
        let launcher = LivingHelper()
        let heard = Heard()
        let (bridge, directory) = try bridge(launcher, heard) {
            $0.retryDelays = [0]
            $0.watchdogEvery = 0.2
            $0.watchdogWait = 0.1
            $0.watchdogLate = 5
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertNil(bridge.start())
        let first = launcher.waitForLink(1)
        first.waitForWatchdog(2)
        XCTAssertEqual(launcher.launches, 1, "a helper that answers is left alone")
        // Asleep, iOS holds the helper suspended: it answers nothing, and isn't asked or ended.
        bridge.sleep()
        first.answers = false
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(launcher.launches, 1, "a suspended helper hasn't stopped answering")
        XCTAssertFalse(first.closed)
        // Awake again, it's asked afresh, and answers as before.
        first.answers = true
        let asked = first.watchdogs
        bridge.wake()
        first.waitForWatchdog(asked + 2)
        XCTAssertEqual(launcher.launches, 1)
        // One that answers nothing while the app is awake is ended, and another started.
        first.answers = false
        let second = launcher.waitForLink(2)
        XCTAssertTrue(first.closed)
        second.waitForWatchdog(1)
        bridge.stop(signOut: false)
        heard.wait(for: "zunaStopped", times: 1)
    }

    private func bridge(_ launcher: any TelegramHelperLauncher, _ heard: Heard, _ change: (inout TelegramBridge.Configuration) -> Void) throws -> (TelegramBridge, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zuna-telegram-runs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var configuration = TelegramBridge.Configuration(credentials: TelegramBridge.Credentials(apiId: "1", apiHash: String(repeating: "0", count: 32), testDc: true)!, launcher: launcher, version: "0", system: "iOS", device: "iPhone")
        change(&configuration)
        return (TelegramBridge(configuration: configuration, dataDirectory: directory, cacheDirectory: directory, deviceKey: Data(repeating: 7, count: 32)) { heard.add($0) }, directory)
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

    /// A helper that starts and stays, answering the broker's watchdog, until the test ends it, as iOS does.
    private final class LivingHelper: TelegramHelperLauncher, @unchecked Sendable {
        private let condition = NSCondition()
        private var links: [LivingLink] = []
        var launches: Int { condition.withLock { links.count } }

        func launch(_ handlers: TelegramHelperHandlers) async throws -> any TelegramHelperLink {
            let link = LivingLink(handlers)
            condition.withLock {
                links.append(link)
                condition.broadcast()
            }
            return link
        }

        /// The helper of the launch with this number, from 1.
        func link(_ number: Int) -> LivingLink { condition.withLock { links[number - 1] } }

        /// Waits for that launch, and for the broker to have given its helper the start.
        func waitForLink(_ number: Int, file: StaticString = #filePath, line: UInt = #line) -> LivingLink {
            let deadline = Date().addingTimeInterval(10)
            condition.lock()
            while links.count < number, condition.wait(until: deadline) {}
            let found = links.count >= number ? links[number - 1] : nil
            condition.unlock()
            guard let found else {
                XCTFail("launch \(number) never came", file: file, line: line)
                return LivingLink(TelegramHelperHandlers(json: { _ in }, data: { _, _, taken in taken() }, ended: { _ in }))
            }
            while !found.started, Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
            return found
        }
    }

    private final class LivingLink: TelegramHelperLink, @unchecked Sendable {
        private let handlers: TelegramHelperHandlers
        private let lock = NSLock()
        private var state = (started: false, answers: true, watchdogs: 0, closed: false, over: false)
        init(_ handlers: TelegramHelperHandlers) { self.handlers = handlers }

        var started: Bool { lock.withLock { state.started } }
        var closed: Bool { lock.withLock { state.closed } }
        /// How many times the watchdog asked and was answered.
        var watchdogs: Int { lock.withLock { state.watchdogs } }
        var answers: Bool {
            get { lock.withLock { state.answers } }
            set { lock.withLock { state.answers = newValue } }
        }

        func waitForWatchdog(_ times: Int, file: StaticString = #filePath, line: UInt = #line) {
            let deadline = Date().addingTimeInterval(10)
            while watchdogs < times, Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            XCTAssertGreaterThanOrEqual(watchdogs, times, "the watchdog didn't ask", file: file, line: line)
        }

        /// The helper went, with nobody asking it to: ended by iOS, or crashed.
        func die() { end("Telegram's engine stopped.") }

        private func end(_ why: String) {
            let first = lock.withLock { () -> Bool in
                defer { state.over = true }
                return !state.over
            }
            if first { handlers.ended(why) }
        }

        func send(json: String) {
            if json.contains(#""zuna":"start""#) { lock.withLock { state.started = true } }
            guard json.contains("zuna:watchdog") else { return }
            let answer = lock.withLock { () -> Bool in
                guard state.answers, !state.over else { return false }
                state.watchdogs += 1
                return true
            }
            if answer { handlers.json(#"{"@type":"optionValueString","value":"1.8","@extra":"zuna:watchdog"}"#) }
        }

        func send(stream: UInt32, bytes: Data, taken: @escaping @Sendable (Bool) -> Void) { taken(false) }

        func open(path: String, done: @escaping @Sendable (Result<FileHandle, Error>) -> Void) {
            done(.failure(CoreError(description: "No files in tests.")))
        }

        func close() {
            lock.withLock { state.closed = true }
            end("stopped")
        }
    }

    /// What the broker told the core, in order.
    private final class Heard: @unchecked Sendable {
        private let condition = NSCondition()
        private var messages: [String] = []

        func add(_ json: String) {
            condition.withLock {
                messages.append(json)
                condition.broadcast()
            }
        }

        /// Waits until the broker has said this at least so many times.
        func wait(for kind: String, times: Int, file: StaticString = #filePath, line: UInt = #line) {
            let deadline = Date().addingTimeInterval(10)
            condition.lock()
            while messages.filter({ $0.contains(kind) }).count < times, condition.wait(until: deadline) {}
            let count = messages.filter { $0.contains(kind) }.count
            condition.unlock()
            XCTAssertGreaterThanOrEqual(count, times, "waited for \(kind)", file: file, line: line)
        }

        func count(_ kind: String) -> Int { condition.withLock { messages.filter { $0.contains(kind) }.count } }
        func first(_ kind: String) -> String? { condition.withLock { messages.first { $0.contains(kind) } } }
        /// Where the first of this kind came among everything said.
        func index(of kind: String) -> Int? { condition.withLock { messages.firstIndex { $0.contains(kind) } } }
    }
}
