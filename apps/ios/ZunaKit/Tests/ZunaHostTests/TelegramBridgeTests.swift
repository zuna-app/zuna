import Darwin
import Foundation
import XCTest
@testable import ZunaHost

/// The broker for a linked Telegram account's TDLib (TelegramBridge.swift), as the desktop's is
/// tested in apps/desktop/src/telegram: what may be asked of the engine, where the door goes, the
/// key to the engine's database, sealed with the device key, and how TDLib's clients are started
/// and stopped, on a fake engine. The door is tried on this machine's loopback.
final class TelegramBridgeTests: XCTestCase {
    func testWhatsListedGoesAndNothingElse() {
        XCTAssertNil(TelegramFunctions.refusal(["@type": "getChats", "limit": 20]))
        XCTAssertNil(TelegramFunctions.refusal(["@type": "sendMessage", "chat_id": 1]))
        for kind in ["deleteAccount", "setPassword", "terminateAllOtherSessions", "terminateSession", "changePhoneNumber", "importContacts", "addProxy", "setTdlibParameters", "logOut", "destroy", "sendPaymentForm", "setLoginEmailAddress", "setNetworkType", "setLogStream", "testProxy"] {
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
        XCTAssertFalse(TelegramDoor.allowed(host: "::ffff:127.0.0.1", port: 443), "a mapped address is judged as itself")
        XCTAssertFalse(TelegramDoor.allowed(host: "2001:4860:4860::8888", port: 443))
        XCTAssertFalse(TelegramDoor.allowed(host: "dns.google", port: 443), "a name, which the door never resolves")
    }

    func testTheDoorTakesOnlyItsOwnPasswordAndAddressesOfTelegrams() throws {
        let door = try TelegramDoor(moved: { _ in })
        defer { door.close() }
        let user = Array(door.username.utf8)
        let password = Array(door.password.utf8)
        let login = [1, UInt8(user.count)] + user + [UInt8(password.count)] + password
        let ipv4: ([UInt8], [UInt8]) -> [UInt8] = { address, port in [5, 1, 0, 1] + address + port }

        // No method but the password one.
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 0], 2)]), [5, 0xff])
        // A wrong password, or a wrong username, as long as its own.
        let wrong = Array(String(repeating: "0", count: password.count).utf8)
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), ([1, UInt8(user.count)] + user + [UInt8(wrong.count)] + wrong, 2)]), [1, 1])
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), ([1, 4] + Array("zuna".utf8) + [UInt8(password.count)] + password, 2)]), [1, 1])
        // A name, which the door never resolves: "address type not supported".
        let name = Array("dns.google".utf8)
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), (login, 2), ([5, 1, 0, 3, UInt8(name.count)] + name + [1, 187], 10)]).prefix(2), [5, 8])
        // An address outside Telegram's, one of Telegram's on a port it doesn't use, and this machine: "not allowed by ruleset".
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), (login, 2), (ipv4([8, 8, 8, 8], [1, 187]), 10)]).prefix(2), [5, 2])
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), (login, 2), (ipv4([149, 154, 167, 40], [0, 22]), 10)]).prefix(2), [5, 2])
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), (login, 2), (ipv4([127, 0, 0, 1], [1, 187]), 10)]).prefix(2), [5, 2])
        // Nothing but CONNECT: "command not supported".
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), (login, 2), ([5, 3, 0, 1, 149, 154, 167, 40, 1, 187], 10)]).prefix(2), [5, 7])
        // And what got this far was the login it was made with.
        XCTAssertEqual(try Socks.talk(door.port, [([5, 1, 2], 2), (login, 2)]), [1, 0])
    }

    func testTheDoorListensAgainWhenItsSocketIsTakenAndOnlyThenSaysItLooked() throws {
        let door = try TelegramDoor(moved: { _ in })
        defer { door.close() }
        let port = door.port
        XCTAssertEqual(try Socks.talk(port, [([5, 1, 2], 2)]), [5, 2])
        door.reclaim()
        let looked = expectation(description: "looked")
        door.look { looked.fulfill() }
        // Well before its next look, which would have been in five seconds.
        wait(for: [looked], timeout: 1)
        // By now the listener is one again, on the port TDLib was told, which was free.
        XCTAssertEqual(door.port, port)
        XCTAssertEqual(try Socks.talk(port, [([5, 1, 2], 2)]), [5, 2])
    }

    func testTheDatabaseKeyIsSealedAndComesBack() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let bridge = { (deviceKey: Data) in
            TelegramBridge(configuration: Self.configuration(FakeEngine(), directory), dataDirectory: directory, deviceKey: deviceKey) { _ in }
        }
        let first = try bridge(Data(repeating: 7, count: 32)).databaseKey()
        XCTAssertEqual(first.count, 32)
        XCTAssertEqual(try bridge(Data(repeating: 7, count: 32)).databaseKey(), first)
        let sealed = try Data(contentsOf: bridge(Data(repeating: 7, count: 32)).keyFile)
        XCTAssertNil(sealed.range(of: first), "the key is kept sealed")
        // Another device key opens nothing.
        XCTAssertThrowsError(try bridge(Data(repeating: 8, count: 32)).databaseKey()) { XCTAssertEqual($0 as? TelegramBridge.KeyProblem, .unopenable) }
    }

    func testAKeyThatCantBeReadNowIsNeitherReplacedNorWhatWasLinkedErased() throws {
        let launch = try Launch()
        defer { launch.clean() }
        try launch.makeDatabase()
        let key = try launch.bridge.databaseKey()
        // There, and not to be read, as a file kept from an app until its phone is unlocked.
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: launch.bridge.keyFile.path)
        XCTAssertThrowsError(try launch.bridge.databaseKey()) { error in
            guard case .unreadable = error as? TelegramBridge.KeyProblem else { return XCTFail("\(error)") }
        }
        // The core is told why, and nothing starts.
        XCTAssertTrue(launch.bridge.start(linked: true)?.contains("telegram.engine.keyNotReadable") == true)
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(launch.engine.made, 0)
        // Readable again, it's the key it was, and TDLib starts with it.
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: launch.bridge.keyFile.path)
        XCTAssertEqual(try launch.bridge.databaseKey(), key)
        XCTAssertNil(launch.bridge.start(linked: true))
        let client = launch.engine.client(1)
        XCTAssertEqual(client.parameters?["database_encryption_key"] as? String, key.base64EncodedString())
        XCTAssertTrue(launch.hasDatabase, "nothing was erased")
    }

    func testCredentialsAreOnlyWhatTelegramGives() {
        XCTAssertNotNil(TelegramBridge.Credentials(apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef", testDc: false))
        XCTAssertNil(TelegramBridge.Credentials(apiId: "", apiHash: "0123456789abcdef0123456789abcdef", testDc: false), "a build without them has no Telegram")
        XCTAssertNil(TelegramBridge.Credentials(apiId: "$(TELEGRAM_API_ID)", apiHash: "", testDc: false))
        XCTAssertNil(TelegramBridge.Credentials(apiId: "12345", apiHash: "not hex", testDc: false))
    }

    func testAFileIsReadWhereTDLibKeptItAndNowhereElse() throws {
        let launch = try Launch()
        defer { launch.clean() }
        let files = launch.folder.appendingPathComponent("files/photos", isDirectory: true)
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        let photo = files.appendingPathComponent("1_2.jpg")
        try Data("jpeg".utf8).write(to: photo)
        let outside = launch.directory.appendingPathComponent("telegram-key.sealed")
        try Data("secret".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: files.appendingPathComponent("link.jpg"), withDestinationURL: outside)

        XCTAssertEqual(try launch.file(photo.path).get(), photo.resolvingSymlinksInPath().path, "TDLib's own file, read where it is")
        XCTAssertThrowsError(try launch.file(outside.path).get(), "a file outside TDLib's folder")
        XCTAssertThrowsError(try launch.file(files.appendingPathComponent("link.jpg").path).get(), "a link from inside it to outside")
        XCTAssertThrowsError(try launch.file(files.appendingPathComponent("../../../telegram-key.sealed").path).get(), "a way out of it")
        XCTAssertThrowsError(try launch.file(files.path).get(), "a folder")
        XCTAssertThrowsError(try launch.file(files.appendingPathComponent("gone.jpg").path).get(), "nothing")
    }

    func testTheDoorIsGivenBeforeTheParametersWhichSayWhatTheyDid() throws {
        let launch = try Launch()
        defer { launch.clean() }
        XCTAssertNil(launch.bridge.start(linked: false))
        let client = launch.engine.client(1)
        client.waitFor("setTdlibParameters")
        let kinds = client.sent.map { $0["@type"] as? String ?? "" }
        XCTAssertEqual(Array(kinds.prefix(2)), ["addProxy", "setTdlibParameters"], "the way out before anything is opened or reached")
        let proxy = try XCTUnwrap(client.door)
        XCTAssertEqual(proxy.server, "127.0.0.1")
        XCTAssertEqual(proxy.username.count, 32)
        XCTAssertEqual(proxy.password.count, 32)
        let parameters = try XCTUnwrap(client.parameters)
        XCTAssertEqual(parameters["database_directory"] as? String, launch.folder.appendingPathComponent("db").path)
        XCTAssertEqual(parameters["files_directory"] as? String, launch.folder.appendingPathComponent("files").path)
        XCTAssertEqual(parameters["database_encryption_key"] as? String, try launch.bridge.databaseKey().base64EncodedString())
        XCTAssertEqual(parameters["device_model"] as? String, "iPhone")
        XCTAssertEqual(parameters["system_version"] as? String, "iOS")
        XCTAssertEqual(parameters["application_version"] as? String, "0")
        XCTAssertEqual(parameters["use_test_dc"] as? Bool, true)
        XCTAssertEqual(parameters["use_secret_chats"] as? Bool, false)
        XCTAssertEqual(parameters["api_id"] as? Int, 1)
        // What TDLib answers, the core hears, but not what it says to the broker's own requests.
        launch.heard.wait(for: "authorizationStateWaitPhoneNumber", times: 1)
        XCTAssertEqual(launch.heard.count("zuna:"), 0)
        // The folder is made as the app's own data is.
        XCTAssertEqual(try launch.folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        // The core's own requests go to TDLib, but not those on no list, and not with the broker's labels.
        launch.bridge.send(#"{"@type":"getChats","limit":20,"@extra":"c1"}"#)
        client.waitFor("getChats")
        launch.bridge.send(#"{"@type":"setNetworkType","type":{"@type":"networkTypeNone"},"@extra":"c2"}"#)
        launch.bridge.send(#"{"@type":"getChats","limit":20,"@extra":"zuna:door"}"#)
        launch.heard.wait(for: #""c2""#, times: 1)
        launch.heard.wait(for: "the app's own", times: 1)
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(client.sent.filter { $0["@type"] as? String == "setNetworkType" }.count, 0)
        XCTAssertEqual(client.sent.filter { $0["@type"] as? String == "getChats" }.count, 1)
    }

    func testAStartWithTheAppOutOfSightWaitsUntilItsBack() throws {
        let launch = try Launch()
        defer { launch.clean() }
        // iOS started the app in the background, as for a push, and the core asks for its account.
        launch.bridge.sleep()
        XCTAssertNil(launch.bridge.start())
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(launch.engine.made, 0, "nothing starts for an app out of sight")
        // Asked again there, as when the network comes back, it still waits.
        XCTAssertNil(launch.bridge.start())
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(launch.engine.made, 0)
        launch.bridge.wake()
        launch.engine.client(1).waitFor("setTdlibParameters")
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(launch.engine.made, 1, "and only once")
        XCTAssertEqual(launch.heard.count("zunaFailed"), 0)
    }

    func testWakingHasTheDoorLookAndTDLibConnectAgainAtOnce() throws {
        let launch = try Launch()
        defer { launch.clean() }
        XCTAssertNil(launch.bridge.start())
        let client = launch.engine.client(1)
        launch.heard.wait(for: "authorizationStateWaitPhoneNumber", times: 1)
        let port = try XCTUnwrap(client.door).port
        // Leaving the screen tells TDLib nothing.
        launch.bridge.sleep()
        Thread.sleep(forTimeInterval: 0.1)
        let before = client.sent.count
        XCTAssertEqual(client.sent.count, before)
        // iOS takes back the door's sockets while the app is suspended.
        XCTAssertTrue(launch.bridge.reclaim())
        launch.bridge.wake()
        // Told the network changed, once the door listens again, rather than at its next look.
        client.waitFor("setNetworkType", within: 2)
        XCTAssertEqual(try Socks.talk(port, [([5, 1, 2], 2)]), [5, 2], "the door listens again, on its port")
        let network = try XCTUnwrap(client.sent.last { $0["@type"] as? String == "setNetworkType" })
        XCTAssertEqual((network["type"] as? [String: Any])?["@type"] as? String, "networkTypeOther")
        // Waking with nothing out of sight changes nothing.
        launch.bridge.wake()
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(client.sent.filter { $0["@type"] as? String == "setNetworkType" }.count, 1)
    }

    func testRefusedParametersEraseNothingOfALinkedAccount() throws {
        // The folder holds a database the account's key doesn't open.
        let launch = try Launch(refusal: "Wrong database encryption key")
        defer { launch.clean() }
        try launch.makeDatabase()
        let key = try launch.bridge.databaseKey()
        XCTAssertNil(launch.bridge.start(linked: true))
        // Its client is closed rather than left on a TDLib that never starts, and the core told why, once.
        launch.heard.wait(for: "zunaFailed", times: 1)
        let failed = try XCTUnwrap(launch.heard.first("zunaFailed"))
        XCTAssertTrue(failed.contains("telegram.engine.wrongKey"), failed)
        XCTAssertFalse(failed.contains("retrying"), "nothing tries again by itself")
        XCTAssertTrue(launch.engine.client(1).isClosed)
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(launch.engine.made, 1)
        XCTAssertEqual(launch.heard.count("zunaFailed"), 1)
        XCTAssertTrue(launch.hasDatabase, "nothing of a linked account is erased")
        XCTAssertEqual(try launch.bridge.databaseKey(), key, "and its key is the one it had")
    }

    func testADatabaseNoKeyOpensIsErasedToLinkFromNothingOnce() throws {
        // What an account unlinked while its folder couldn't be erased leaves: its database, and no key to it.
        let launch = try Launch(refusal: "Wrong database encryption key", refusesOnlyAnOldDatabase: true)
        defer { launch.clean() }
        try launch.makeDatabase()
        XCTAssertNil(launch.bridge.start(linked: false))
        let first = launch.engine.client(1)
        // TDLib refuses the key, the folder is erased with the key once its client has closed, and
        // one more start is from nothing, which TDLib takes.
        let second = launch.engine.client(2)
        XCTAssertTrue(first.isClosed)
        XCTAssertNotEqual(first.parameters?["database_encryption_key"] as? String, second.parameters?["database_encryption_key"] as? String, "a new key, for a new database")
        launch.heard.wait(for: "authorizationStateWaitPhoneNumber", times: 1)
        XCTAssertEqual(launch.heard.count("zunaFailed"), 0)
        XCTAssertEqual(launch.engine.mostOpen, 1)

        // One that refuses again after that is told to the core, and nothing more is tried.
        let again = try Launch(refusal: "Wrong database encryption key")
        defer { again.clean() }
        try again.makeDatabase()
        XCTAssertNil(again.bridge.start(linked: false))
        again.heard.wait(for: "zunaFailed", times: 1)
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(again.engine.made, 2)
        XCTAssertEqual(again.heard.count("zunaFailed"), 1)
    }

    func testAnEngineThatCantOpenItsDataIsClosedWithNothingErased() throws {
        let launch = try Launch(refusal: "Can't open binlog: Operation not permitted")
        defer { launch.clean() }
        try launch.makeDatabase()
        XCTAssertNil(launch.bridge.start(linked: false))
        launch.heard.wait(for: "zunaFailed", times: 1)
        XCTAssertTrue(try XCTUnwrap(launch.heard.first("zunaFailed")).contains("telegram.engine.cantOpenData error=Can't open binlog"))
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(launch.engine.made, 1)
        XCTAssertTrue(launch.hasDatabase)
        // Asked again, as when the app comes back, it's started again.
        launch.engine.refusal = nil
        XCTAssertNil(launch.bridge.start(linked: false))
        launch.engine.client(2).waitFor("setTdlibParameters")
    }

    func testALinkedAccountWithNoDatabaseIsntStarted() throws {
        let launch = try Launch()
        defer { launch.clean() }
        let key = try launch.bridge.databaseKey()
        // What everyone who linked before TDLib moved into the app has: the key, and the core saying linked.
        XCTAssertNil(launch.bridge.start(linked: true))
        launch.heard.wait(for: "zunaFailed", times: 1)
        let failed = try XCTUnwrap(launch.heard.first("zunaFailed"))
        XCTAssertTrue(failed.contains("telegram.engine.noDatabase"), failed)
        XCTAssertFalse(failed.contains("retrying"))
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(launch.engine.made, 0, "TDLib isn't started, so it makes no empty database")
        XCTAssertEqual(try launch.bridge.databaseKey(), key, "and nothing is erased")
        // Coming back asks again, and is told the same.
        XCTAssertNil(launch.bridge.start(linked: true))
        launch.heard.wait(for: "zunaFailed", times: 2)
        XCTAssertEqual(launch.engine.made, 0)
        // Unlinking, which is the way out, erases it, and linking again starts from nothing.
        launch.bridge.stop(signOut: true)
        launch.heard.wait(for: "zunaStopped", times: 1)
        XCTAssertTrue(try XCTUnwrap(launch.heard.first("zunaStopped")).contains(#""erased":true"#))
        XCTAssertFalse(FileManager.default.fileExists(atPath: launch.bridge.keyFile.path))
        XCTAssertNil(launch.bridge.start(linked: false))
        launch.engine.client(1).waitFor("setTdlibParameters")
    }

    func testStoppingClosesTDLibAndUnlinkingErasesItAll() throws {
        let launch = try Launch(state: "authorizationStateReady")
        defer { launch.clean() }
        try launch.makeDatabase()
        XCTAssertNil(launch.bridge.start(linked: true))
        launch.heard.wait(for: "authorizationStateReady", times: 1)
        // Stopped, it's closed, which saves what it has, and nothing is erased.
        launch.bridge.stop(signOut: false)
        launch.heard.wait(for: "zunaStopped", times: 1)
        XCTAssertTrue(try XCTUnwrap(launch.heard.first("zunaStopped")).contains(#""erased":false"#))
        XCTAssertTrue(launch.engine.client(1).sent.contains { $0["@type"] as? String == "close" })
        XCTAssertFalse(launch.engine.client(1).sent.contains { $0["@type"] as? String == "logOut" })
        XCTAssertTrue(launch.hasDatabase)
        // Unlinked, it signs out at Telegram, then the key and the folder go.
        XCTAssertNil(launch.bridge.start(linked: true))
        launch.heard.wait(for: "authorizationStateReady", times: 2)
        launch.bridge.stop(signOut: true)
        launch.heard.wait(for: "zunaStopped", times: 2)
        let stopped = try XCTUnwrap(launch.heard.last("zunaStopped"))
        XCTAssertTrue(stopped.contains(#""erased":true"#), stopped)
        XCTAssertTrue(stopped.contains(#""signedOut":true"#), stopped)
        XCTAssertTrue(launch.engine.client(2).sent.contains { $0["@type"] as? String == "logOut" })
        XCTAssertFalse(FileManager.default.fileExists(atPath: launch.folder.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: launch.bridge.keyFile.path))
        // With nothing running, unlinking erases all the same.
        try launch.makeDatabase()
        launch.bridge.stop(signOut: true)
        launch.heard.wait(for: "zunaStopped", times: 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: launch.folder.path))
        XCTAssertEqual(launch.engine.mostOpen, 1)
    }

    func testNoClientIsMadeBeforeTheOneBeforeClosed() throws {
        let launch = try Launch()
        defer { launch.clean() }
        launch.engine.closeAfter = 0.5
        XCTAssertNil(launch.bridge.start())
        launch.engine.client(1).waitFor("setTdlibParameters")
        launch.bridge.stop(signOut: false)
        // Asked to start at once, as when linking starts over, it waits for TDLib to close.
        XCTAssertNil(launch.bridge.start())
        Thread.sleep(forTimeInterval: 0.25)
        XCTAssertEqual(launch.engine.made, 1, "two clients on one folder fight over its database")
        launch.engine.client(2).waitFor("setTdlibParameters")
        XCTAssertTrue(launch.engine.client(1).isClosed)
        XCTAssertEqual(launch.engine.mostOpen, 1)
        // And unlinking erases the folder only once it has closed, before the next start makes it again.
        launch.bridge.stop(signOut: true)
        XCTAssertNil(launch.bridge.start())
        launch.engine.client(3).waitFor("setTdlibParameters")
        XCTAssertTrue(launch.engine.client(2).isClosed)
        XCTAssertEqual(launch.engine.mostOpen, 1)
        XCTAssertEqual(launch.heard.count("zunaStopped"), 2)
    }

    func testTwoStartsThatEndedTheAppKeepTheThirdFromBeingMade() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        // A TDLib that ends the app as it opens its database: here, one that never says it has, and
        // the app ended before it would, as the next launch finds.
        for launchNumber in 1...TelegramBridge.mostMarks {
            let launch = try Launch(directory: directory, silent: true)
            XCTAssertNil(launch.bridge.start(linked: false))
            launch.engine.client(1).waitFor("setTdlibParameters")
            XCTAssertEqual(launch.bridge.marks.read().starts, launchNumber, "left before the parameters")
        }
        let blocked = try Launch(directory: directory)
        XCTAssertNil(blocked.bridge.start(linked: false))
        blocked.heard.wait(for: "zunaFailed", times: 1)
        let failed = try XCTUnwrap(blocked.heard.first("zunaFailed"))
        XCTAssertTrue(failed.contains("telegram.engine.endedTheApp"), failed)
        XCTAssertFalse(failed.contains("retrying"))
        XCTAssertEqual(blocked.engine.made, 0)
        // The app coming back isn't the person acting: asked again, it's still not made.
        XCTAssertNil(blocked.bridge.start(linked: false))
        blocked.heard.wait(for: "zunaFailed", times: 2)
        let later = try Launch(directory: directory)
        XCTAssertNil(later.bridge.start(linked: false))
        later.heard.wait(for: "zunaFailed", times: 1)
        XCTAssertEqual(later.engine.made, 0, "nor at the next launch")
        // Unlinking erases it with everything else, and the next start is made.
        later.bridge.stop(signOut: true)
        later.heard.wait(for: "zunaStopped", times: 1)
        XCTAssertEqual(later.bridge.marks.read().starts, 0)
        XCTAssertNil(later.bridge.start(linked: false))
        later.engine.client(1).waitFor("setTdlibParameters")
    }

    func testAStartThatOpenedItsDatabaseTakesItsMarkBack() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        for _ in 1...(TelegramBridge.mostMarks + 1) {
            let launch = try Launch(directory: directory)
            XCTAssertNil(launch.bridge.start(linked: false))
            launch.heard.wait(for: "authorizationStateWaitPhoneNumber", times: 1)
            let deadline = Date().addingTimeInterval(2)
            while launch.bridge.marks.read().starts != 0, Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            XCTAssertEqual(launch.bridge.marks.read().starts, 0, "taken back once TDLib said where the account stands")
            // Then the app ends, as iOS ends it, with nothing said.
        }
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("telegram").path)), [], "nothing left")
    }

    func testWhatTDLibSaysAsItEndsTheAppIsKeptAndCounts() throws {
        let directory = try temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        // A start that got through, and then TDLib ended the app on purpose, its own checks having failed.
        let first = try Launch(directory: directory)
        XCTAssertNil(first.bridge.start(linked: false))
        first.heard.wait(for: "authorizationStateWaitPhoneNumber", times: 1)
        Thread.sleep(forTimeInterval: 0.1)
        first.engine.endTheApp("[ 0][t 4][1731700000.123456789][td_db.cpp:42][#1][!Td]\tCheck `status.is_ok()` failed")
        XCTAssertEqual(first.bridge.marks.read(), StartMarks.Mark(starts: 1, said: "Check `status.is_ok()` failed"))
        // The next one ends the app as it starts, and what was said is kept.
        let second = try Launch(directory: directory, silent: true)
        XCTAssertNil(second.bridge.start(linked: false))
        second.engine.client(1).waitFor("setTdlibParameters")
        XCTAssertEqual(second.bridge.marks.read(), StartMarks.Mark(starts: 2, said: "Check `status.is_ok()` failed"))
        let third = try Launch(directory: directory)
        XCTAssertNil(third.bridge.start(linked: false))
        third.heard.wait(for: "zunaFailed", times: 1)
        let failed = try XCTUnwrap(third.heard.first("zunaFailed"))
        XCTAssertTrue(failed.contains("telegram.engine.endedTheAppSaying said=Check `status.is_ok()` failed"), failed)
        XCTAssertEqual(third.engine.made, 0)
    }

    // MARK: Helpers

    private func temporary() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zuna-telegram-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// What the broker is given in the tests: TDLib's test servers, and its words as their keys and
    /// what fills them in, so a test can tell which it was.
    fileprivate static func configuration(_ engine: FakeEngine, _ directory: URL) -> TelegramBridge.Configuration {
        var configuration = TelegramBridge.Configuration(
            credentials: TelegramBridge.Credentials(apiId: "1", apiHash: String(repeating: "0", count: 32), testDc: true)!,
            engine: engine,
            folder: directory.appendingPathComponent("telegram", isDirectory: true),
            version: "0",
            system: "iOS",
            device: "iPhone"
        )
        configuration.words = { key, values in ([key] + values.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }).joined(separator: " ") }
        return configuration
    }

    /// One launch of the app: a broker on a fake engine, in a folder of its own unless it's given
    /// one, as a launch after another finds what that left.
    private final class Launch {
        let directory: URL
        let engine: FakeEngine
        let heard = Heard()
        let bridge: TelegramBridge
        private let owned: Bool

        init(directory: URL? = nil, refusal: String? = nil, refusesOnlyAnOldDatabase: Bool = false, state: String = "authorizationStateWaitPhoneNumber", silent: Bool = false) throws {
            if let directory {
                self.directory = directory
                owned = false
            } else {
                self.directory = FileManager.default.temporaryDirectory.appendingPathComponent("zuna-telegram-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
                owned = true
            }
            engine = FakeEngine()
            engine.refusal = refusal
            engine.state = state
            engine.silent = silent
            let folder = self.directory.appendingPathComponent("telegram", isDirectory: true)
            if refusesOnlyAnOldDatabase { engine.refusesWhile = { FileManager.default.fileExists(atPath: folder.appendingPathComponent("db/td_test.binlog").path) } }
            let heard = heard
            bridge = TelegramBridge(configuration: TelegramBridgeTests.configuration(engine, self.directory), dataDirectory: self.directory, deviceKey: Data(repeating: 7, count: 32)) { heard.add($0) }
        }

        var folder: URL { directory.appendingPathComponent("telegram", isDirectory: true) }
        var hasDatabase: Bool { FileManager.default.fileExists(atPath: folder.appendingPathComponent("db/td_test.binlog").path) }

        /// What TDLib would have left of an account here.
        func makeDatabase() throws {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent("db"), withIntermediateDirectories: true)
            try Data("binlog".utf8).write(to: folder.appendingPathComponent("db/td_test.binlog"))
        }

        func file(_ path: String) -> Result<String, Error> {
            let found = Box<Result<String, Error>?>(nil)
            bridge.file(path: path) { found.value = $0 }
            return found.value ?? .failure(CoreError(description: "no answer"))
        }

        func clean() {
            if owned { try? FileManager.default.removeItem(at: directory) }
        }
    }

    /// TDLib's clients, as the broker sees them: each answers its parameters as it's told to, and
    /// closes when it's asked, saying so as TDLib does.
    fileprivate final class FakeEngine: TelegramEngine, @unchecked Sendable {
        private let condition = NSCondition()
        private var clients: [FakeClient] = []
        private var open = 0
        private var most = 0
        private var said: (@Sendable (String) -> Void)?
        private var settings = (refusal: String?.none, state: "authorizationStateWaitPhoneNumber", silent: false, closeAfter: 0.0)
        var refusesWhile: (@Sendable () -> Bool)?

        /// What TDLib says of its parameters instead of taking them.
        var refusal: String? {
            get { condition.withLock { settings.refusal } }
            set { condition.withLock { settings.refusal = newValue } }
        }
        /// Where the account stands once they're taken.
        var state: String {
            get { condition.withLock { settings.state } }
            set { condition.withLock { settings.state = newValue } }
        }
        /// It never answers them, as a TDLib that ends the app before it can.
        var silent: Bool {
            get { condition.withLock { settings.silent } }
            set { condition.withLock { settings.silent = newValue } }
        }
        /// How long it takes to close.
        var closeAfter: TimeInterval {
            get { condition.withLock { settings.closeAfter } }
            set { condition.withLock { settings.closeAfter = newValue } }
        }

        var made: Int { condition.withLock { clients.count } }
        /// The most clients that were open at once.
        var mostOpen: Int { condition.withLock { most } }

        func makeClient(heard: @escaping @Sendable (String) -> Void, closed: @escaping @Sendable () -> Void) -> any TelegramClient {
            let client = FakeClient(engine: self, heard: heard, closed: closed)
            condition.withLock {
                clients.append(client)
                open += 1
                most = max(most, open)
                condition.broadcast()
            }
            client.say(#"{"@type":"updateAuthorizationState","authorization_state":{"@type":"authorizationStateWaitTdlibParameters"}}"#)
            return client
        }

        func execute(_ json: String) -> String? { nil }

        func onLastWords(_ said: @escaping @Sendable (String) -> Void) {
            condition.withLock { self.said = said }
        }

        /// TDLib ends the app on purpose, saying why first.
        func endTheApp(_ words: String) {
            condition.withLock { said }?(words)
        }

        /// The client made with this number, from 1, once it's made.
        func client(_ number: Int, file: StaticString = #filePath, line: UInt = #line) -> FakeClient {
            let deadline = Date().addingTimeInterval(10)
            condition.lock()
            while clients.count < number, condition.wait(until: deadline) {}
            let found = clients.count >= number ? clients[number - 1] : nil
            condition.unlock()
            guard let found else {
                XCTFail("client \(number) was never made", file: file, line: line)
                return FakeClient(engine: self, heard: { _ in }, closed: {})
            }
            return found
        }

        fileprivate func closed() {
            condition.withLock { open -= 1 }
        }

        fileprivate func answer(_ parameters: [String: Any]) -> (refusal: String?, state: String, silent: Bool, closeAfter: TimeInterval) {
            let settings = condition.withLock { self.settings }
            let refusing = settings.refusal != nil && (refusesWhile?() ?? true)
            return (refusing ? settings.refusal : nil, settings.state, settings.silent, settings.closeAfter)
        }

        fileprivate var closeDelay: TimeInterval { condition.withLock { settings.closeAfter } }
    }

    fileprivate final class FakeClient: TelegramClient, @unchecked Sendable {
        private unowned let engine: FakeEngine
        private let heard: @Sendable (String) -> Void
        private let closedHandler: @Sendable () -> Void
        private let condition = NSCondition()
        private var requests: [[String: Any]] = []
        private var over = false
        /// TDLib's own thread, which says everything in order.
        private let thread = DispatchQueue(label: "fake-td")

        init(engine: FakeEngine, heard: @escaping @Sendable (String) -> Void, closed: @escaping @Sendable () -> Void) {
            self.engine = engine
            self.heard = heard
            closedHandler = closed
        }

        var sent: [[String: Any]] { condition.withLock { requests } }
        var isClosed: Bool { condition.withLock { over } }
        var parameters: [String: Any]? { sent.first { $0["@type"] as? String == "setTdlibParameters" } }
        var door: (server: String, port: UInt16, username: String, password: String)? {
            guard let proxy = sent.first(where: { $0["@type"] as? String == "addProxy" })?["proxy"] as? [String: Any],
                  let type = proxy["type"] as? [String: Any] else { return nil }
            return (proxy["server"] as? String ?? "", UInt16(proxy["port"] as? Int ?? 0), type["username"] as? String ?? "", type["password"] as? String ?? "")
        }

        func waitFor(_ kind: String, within seconds: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
            let deadline = Date().addingTimeInterval(seconds)
            condition.lock()
            while !requests.contains(where: { $0["@type"] as? String == kind }), condition.wait(until: deadline) {}
            let found = requests.contains { $0["@type"] as? String == kind }
            condition.unlock()
            XCTAssertTrue(found, "\(kind) was never sent", file: file, line: line)
        }

        func say(_ json: String) {
            thread.async { [heard] in heard(json) }
        }

        func send(_ json: String) {
            guard let request = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
            let closed = condition.withLock { () -> Bool in
                requests.append(request)
                condition.broadcast()
                return over
            }
            let extra = (request["@extra"] as? String).map { #","@extra":"\#($0)""# } ?? ""
            if closed { return say(#"{"@type":"error","code":500,"message":"Request aborted"\#(extra)}"#) }
            switch request["@type"] as? String {
            case "setTdlibParameters":
                let answer = engine.answer(request)
                if answer.silent { return }
                if let refusal = answer.refusal {
                    say(#"{"@type":"error","code":400,"message":"\#(refusal)"\#(extra)}"#)
                } else {
                    say(#"{"@type":"ok"\#(extra)}"#)
                    say(#"{"@type":"updateAuthorizationState","authorization_state":{"@type":"\#(answer.state)"}}"#)
                }
            case "close", "logOut":
                let delay = engine.closeDelay
                thread.asyncAfter(deadline: .now() + delay) { [self] in
                    let first = condition.withLock { () -> Bool in
                        defer { over = true }
                        return !over
                    }
                    guard first else { return }
                    heard(#"{"@type":"updateAuthorizationState","authorization_state":{"@type":"authorizationStateClosing"}}"#)
                    heard(#"{"@type":"updateAuthorizationState","authorization_state":{"@type":"authorizationStateClosed"}}"#)
                    engine.closed()
                    closedHandler()
                }
            case "addProxy":
                say(#"{"@type":"proxy","id":1\#(extra)}"#)
            default:
                say(#"{"@type":"ok"\#(extra)}"#)
            }
        }
    }

    /// A SOCKS5 client of the test's own, on this machine's loopback.
    private enum Socks {
        /// Connects to the door, then sends each part and reads so many bytes of its answer, and
        /// gives the last answer, cut short where the door closed.
        static func talk(_ port: UInt16, _ steps: [([UInt8], Int)]) throws -> [UInt8] {
            let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            defer { Darwin.close(socket) }
            var time = timeval(tv_sec: 3, tv_usec: 0)
            setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
            var yes: Int32 = 1
            setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_addr.s_addr = in_addr_t(INADDR_LOOPBACK).bigEndian
            address.sin_port = port.bigEndian
            let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            guard connected == 0 else { throw CoreError(description: "couldn't connect to the door: \(String(cString: strerror(errno)))") }
            var answer: [UInt8] = []
            for (part, count) in steps {
                _ = part.withUnsafeBytes { send(socket, $0.baseAddress, $0.count, 0) }
                var bytes = [UInt8](repeating: 0, count: count)
                var got = 0
                while got < count {
                    let read = bytes.withUnsafeMutableBytes { recv(socket, $0.baseAddress! + got, count - got, 0) }
                    if read <= 0 { break }
                    got += read
                }
                answer = Array(bytes[0..<got])
            }
            return answer
        }
    }

    private final class Box<Value>: @unchecked Sendable {
        var value: Value
        init(_ value: Value) { self.value = value }
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
        func last(_ kind: String) -> String? { condition.withLock { messages.last { $0.contains(kind) } } }
    }
}
