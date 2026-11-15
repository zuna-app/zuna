import Foundation

/// The app's hold on `CoreLock`, which iOS must never find held as it suspends
/// the app: it ends a process suspended holding a file lock in the App Group
/// (0xDEAD10CC), whatever was meant to keep it running, such as a call, or a
/// share being sent. So the lock is taken only while a background task is held
/// for it, during which iOS doesn't suspend the process, and that task ends only
/// once the lock has gone: when it's released, or as the task's time runs out,
/// which iOS says shortly before it would suspend the process.
@MainActor
public final class LockKeeper {
    /// Asks the system to keep the process running, as
    /// `UIApplication.beginBackgroundTask` does, calling `expiring` shortly
    /// before it stops. Nil if it won't.
    public typealias KeepRunning = (_ expiring: @escaping @MainActor () -> Void) -> Int?

    private let lock: CoreLock
    private let holder: CoreLock.Holder
    private let keepRunning: KeepRunning
    private let stopRunning: (Int) -> Void
    /// What `keepRunning` began, while it lasts, and which of them it was.
    private var running: (task: Int, turn: Int)?
    private var turns = 0
    /// Called once the lock has gone as the time ran out, so whatever used it
    /// stops, before what kept the process running for it ends.
    public var onLost: (() -> Void)?

    public init(lock: CoreLock, as holder: CoreLock.Holder, keepRunning: @escaping KeepRunning, stopRunning: @escaping (Int) -> Void) {
        self.lock = lock
        self.holder = holder
        self.keepRunning = keepRunning
        self.stopRunning = stopRunning
    }

    public var isHeld: Bool { lock.isHeld }

    /// Waits until no other process holds the lock, then takes it: true if
    /// another held it since this one last did, as `CoreLock.tryTake` says.
    /// Each try is made with the process kept running, and while the system
    /// won't keep it running, it waits.
    public func take() async -> Bool {
        while true {
            if keptRunning(), let moved = lock.tryTake(as: holder) { return moved }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// Lets go of the lock, then of what kept the process running for it.
    public func release() {
        lock.release()
        stop()
    }

    private func keptRunning() -> Bool {
        if running != nil { return true }
        turns += 1
        let turn = turns
        guard let task = keepRunning({ [weak self] in self?.expired(turn) }) else { return false }
        running = (task, turn)
        return true
    }

    /// The time's up, and the system suspends the process once the task ends.
    private func expired(_ turn: Int) {
        guard let running, running.turn == turn else { return }
        self.running = nil
        let held = lock.isHeld
        lock.release()
        if held { onLost?() }
        stopRunning(running.task)
    }

    private func stop() {
        guard let running else { return }
        self.running = nil
        stopRunning(running.task)
    }
}
