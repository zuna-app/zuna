import Foundation
import XCTest
@testable import ZunaHost

/// The app holds the core's lock only while a background task keeps it running, and that task ends only
/// once the lock has gone, so iOS never suspends the app holding it (0xDEAD10CC). A second `CoreLock` on
/// the same file stands in for the share extension: `flock` locks belong to each open file, so two in one
/// process keep each other out as two processes do.
@MainActor
final class LockKeeperTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("lock-keeper-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testTakesTheLockOnlyWhileKeptRunning() async throws {
        let system = FakeSystem()
        let keeper = try makeKeeper(system)
        system.grants = false
        let taking = Task { await keeper.take() }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(keeper.isHeld)
        XCTAssertNil(system.held)
        // Nobody holds the file meanwhile.
        let share = try CoreLock(directory: directory)
        XCTAssertNotNil(share.tryTake(as: .share))
        share.release()

        system.grants = true
        _ = await taking.value
        XCTAssertTrue(keeper.isHeld)
        XCTAssertNotNil(system.held)
    }

    func testReleasingEndsTheTaskOnceTheLockHasGone() async throws {
        let system = FakeSystem()
        let keeper = try makeKeeper(system)
        _ = await keeper.take()
        keeper.release()
        XCTAssertFalse(keeper.isHeld)
        XCTAssertNil(system.held)
        XCTAssertEqual(system.endedHolding, [false])
        XCTAssertNotNil(try CoreLock(directory: directory).tryTake(as: .share))
    }

    func testTheTimeRunningOutLetsGoOfTheLockFirst() async throws {
        let system = FakeSystem()
        let keeper = try makeKeeper(system)
        var lost: (held: Bool, taskRunning: Bool)?
        keeper.onLost = { lost = (keeper.isHeld, system.held != nil) }
        _ = await keeper.take()
        system.expire()
        // Told after the lock went, and before the task ended, after which iOS may suspend the app.
        XCTAssertEqual(lost?.held, false)
        XCTAssertEqual(lost?.taskRunning, true)
        XCTAssertEqual(system.endedHolding, [false])
        XCTAssertNil(system.held)
        XCTAssertNotNil(try CoreLock(directory: directory).tryTake(as: .share))
        // Going to sleep after that ends nothing twice.
        keeper.release()
    }

    /// The app waits for the share extension as its time runs out, and the extension lets go just
    /// after: the lock isn't taken until the app is kept running again.
    func testATakeWaitingWhenTheTimeRunsOutWaitsToBeKeptRunningAgain() async throws {
        let system = FakeSystem()
        let keeper = try makeKeeper(system)
        var lostCount = 0
        keeper.onLost = { lostCount += 1 }
        _ = await keeper.take()
        keeper.release()
        let share = try CoreLock(directory: directory)
        XCTAssertNotNil(share.tryTake(as: .share))

        let taking = Task { await keeper.take() }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNotNil(system.held, "it waits kept running")
        system.grants = false
        system.expire()
        XCTAssertEqual(lostCount, 0, "it held nothing to lose")
        share.release()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(keeper.isHeld)

        system.grants = true
        let moved = await taking.value
        XCTAssertTrue(moved, "the extension had it meanwhile")
        XCTAssertTrue(keeper.isHeld)
        XCTAssertNotNil(system.held)
        XCTAssertEqual(system.endedHolding, [false, false])
    }

    /// Only the task the lock is held with lets it go as it runs out, not one ended before.
    func testAnEndedTaskRunningOutLeavesTheLockHeld() async throws {
        let system = FakeSystem()
        let keeper = try makeKeeper(system)
        _ = await keeper.take()
        let first = try XCTUnwrap(system.held)
        let stale = try XCTUnwrap(system.handlers[first])
        keeper.release()
        _ = await keeper.take()
        stale()
        XCTAssertTrue(keeper.isHeld)
        XCTAssertNotNil(system.held)
    }

    private func makeKeeper(_ system: FakeSystem) throws -> LockKeeper {
        let keeper = LockKeeper(
            lock: try CoreLock(directory: directory),
            as: .app,
            keepRunning: { system.begin($0) },
            stopRunning: { system.end($0) }
        )
        system.isHeld = { keeper.isHeld }
        return keeper
    }
}

/// Stands in for UIKit's background tasks: begins them or refuses to, and runs out their time when told.
@MainActor
private final class FakeSystem {
    var grants = true
    var isHeld: () -> Bool = { false }
    /// Each task begun, by its number, with what to call when its time runs out.
    private(set) var handlers: [Int: @MainActor () -> Void] = [:]
    private var running: Set<Int> = []
    /// Whether the lock was still held as each task ended, which iOS may suspend the process at.
    private(set) var endedHolding: [Bool] = []
    private var next = 1

    /// The one task running, if any.
    var held: Int? {
        XCTAssertLessThanOrEqual(running.count, 1)
        return running.first
    }

    func begin(_ expiring: @escaping @MainActor () -> Void) -> Int? {
        guard grants else { return nil }
        let task = next
        next += 1
        handlers[task] = expiring
        running.insert(task)
        return task
    }

    func end(_ task: Int) {
        XCTAssertNotNil(running.remove(task), "a task ended twice, or one never begun")
        endedHolding.append(isHeld())
    }

    /// As iOS does shortly before the time is up.
    func expire() {
        for task in running.sorted() { handlers[task]?() }
    }
}
