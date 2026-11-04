import Foundation

/// Which process runs the client core on this device's data: the app while it
/// runs, and the share extension while the app doesn't. Two cores at once would
/// each hold their own copy of the MLS groups in memory, and the one written
/// last would undo the other's.
///
/// A file lock in the App Group, which the system lets go of when a process
/// ends. It counts how often it's been taken, so a process taking it again can
/// tell whether another had it meanwhile, and read everything again. The app
/// lets go of it before iOS suspends it, which would otherwise end the app for
/// holding a lock in a shared container.
final class CoreLock: @unchecked Sendable {
    enum Holder: UInt8, Sendable {
        case app = 1
        case share = 2
    }

    private let descriptor: Int32
    private let queue = DispatchQueue(label: "chat.zuna.core-lock")
    private let state = NSLock()
    /// The count this process left when it last took the lock, or nil if it never has.
    private var taken: UInt64?
    private var holding = false

    init(directory: URL) throws {
        let path = directory.appendingPathComponent("core.lock").path
        descriptor = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
    }

    deinit {
        close(descriptor)
    }

    var isHeld: Bool { state.withLock { holding } }

    /// Waits until no other process holds it, then takes it. True if another
    /// process held it since this one last did, so what's in memory is behind.
    ///
    /// It asks again and again rather than blocking, so that it's never handed
    /// to this process while iOS has it suspended.
    func take(as holder: Holder) async -> Bool {
        while true {
            if let moved = tryTake(as: holder) { return moved }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// Takes it only if nobody else holds it. Nil if somebody does, otherwise as `take`.
    func tryTake(as holder: Holder) -> Bool? {
        queue.sync {
            if state.withLock({ holding }) { return false }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return nil }
            return claim(as: holder)
        }
    }

    /// Who holds it now, as they wrote when they took it.
    func holder() -> Holder? {
        var record = Record()
        guard pread(descriptor, &record, MemoryLayout<Record>.size, 0) == MemoryLayout<Record>.size else { return nil }
        return Holder(rawValue: record.holder)
    }

    func release() {
        queue.sync {
            guard state.withLock({ holding }) else { return }
            var record = read()
            record.holder = 0
            write(record)
            state.withLock { holding = false }
            flock(descriptor, LOCK_UN)
        }
    }

    private struct Record {
        var count: UInt64 = 0
        var holder: UInt8 = 0
    }

    private func claim(as holder: Holder) -> Bool {
        var record = read()
        let moved = state.withLock { taken.map { $0 != record.count } ?? false }
        record.count &+= 1
        record.holder = holder.rawValue
        write(record)
        state.withLock {
            taken = record.count
            holding = true
        }
        return moved
    }

    private func read() -> Record {
        var record = Record()
        _ = pread(descriptor, &record, MemoryLayout<Record>.size, 0)
        return record
    }

    private func write(_ record: Record) {
        var record = record
        _ = pwrite(descriptor, &record, MemoryLayout<Record>.size, 0)
        fsync(descriptor)
    }
}
