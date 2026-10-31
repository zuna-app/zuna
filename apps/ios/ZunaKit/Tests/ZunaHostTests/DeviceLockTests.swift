import Foundation
import XCTest
@testable import ZunaHost

final class DeviceLockTests: XCTestCase {
    private let deviceKey = Data((0..<32).map { UInt8($0) })

    func testAnyAccountsPasswordUnlocksTheKey() throws {
        var lock = DeviceLock()
        try lock.add(deviceKey: deviceKey, password: "first password", serverUrl: "https://a.example", username: "alice", serverName: "A")
        try lock.add(deviceKey: deviceKey, password: "second password", serverUrl: "https://b.example", username: "alice", serverName: "B")
        XCTAssertEqual(lock.entries.count, 2)
        XCTAssertEqual(DeviceLock.unlock(lock.entries[0], password: "first password"), deviceKey)
        XCTAssertEqual(DeviceLock.unlock(lock.entries[1], password: "second password"), deviceKey)
        XCTAssertNil(DeviceLock.unlock(lock.entries[0], password: "second password"))
    }

    func testNormalizesPasswordsLikeTheCore() throws {
        var lock = DeviceLock()
        let password = "Zażółć gęślą jaźń"
        try lock.add(deviceKey: deviceKey, password: password, serverUrl: "https://a.example", username: "zofia", serverName: "A")
        XCTAssertEqual(DeviceLock.unlock(lock.entries[0], password: password.decomposedStringWithCanonicalMapping), deviceKey)
    }

    func testReplacesAnAccountsEntryAndRemovesIt() throws {
        var lock = DeviceLock()
        try lock.add(deviceKey: deviceKey, password: "old password", serverUrl: "https://a.example", username: "Alice", serverName: "A")
        try lock.add(deviceKey: deviceKey, password: "new password", serverUrl: "https://a.example", username: "alice", serverName: "A")
        XCTAssertEqual(lock.entries.count, 1)
        XCTAssertNil(DeviceLock.unlock(lock.entries[0], password: "old password"))
        XCTAssertEqual(DeviceLock.unlock(lock.entries[0], password: "new password"), deviceKey)
        lock.remove(serverUrl: "https://a.example", username: "ALICE")
        XCTAssertTrue(lock.entries.isEmpty)
    }

    func testRejectsEntriesMovedToAnotherAccountOrWeakened() throws {
        var lock = DeviceLock()
        try lock.add(deviceKey: deviceKey, password: "password", serverUrl: "https://a.example", username: "alice", serverName: "A")
        var moved = lock.entries[0]
        moved.username = "mallory"
        XCTAssertNil(DeviceLock.unlock(moved, password: "password"))
        var weakened = lock.entries[0]
        weakened.memory = 8
        XCTAssertNil(DeviceLock.unlock(weakened, password: "password"))
    }

    func testSavesAndLoadsAndDeletesTheFileWhenEmpty() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var lock = DeviceLock()
        try lock.add(deviceKey: deviceKey, password: "password", serverUrl: "https://a.example", username: "alice", serverName: "A")
        try lock.save(to: directory)
        XCTAssertEqual(DeviceLock.load(from: directory), lock)
        lock.entries.removeAll()
        try lock.save(to: directory)
        XCTAssertNil(DeviceLock.load(from: directory))
    }

    func testBootSessionIsStable() {
        XCTAssertNotEqual(BootSession.current, "unknown")
        XCTAssertEqual(BootSession.current, BootSession.current)
    }
}
