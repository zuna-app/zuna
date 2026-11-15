import Foundation

/// Which process runs the client core on this device's data: the app while it
/// runs, and the share extension while the app doesn't. Two cores at once would
/// each hold their own copy of the MLS groups in memory, and the one written
/// last would undo the other's.
///
/// A file lock in the App Group, which the system lets go of when a process
/// ends. It counts how often it's been taken, so a process taking it again can
/// tell whether another had it meanwhile, and read everything again. The app
/// holds it only through `LockKeeper`, which lets go of it before iOS suspends
/// the app, as iOS ends a process suspended holding a lock in a shared
/// container. The file is open only while it's held:
/// iOS also ends a suspended process that has a locked file there open, without
/// asking whose lock it is, as when the extension takes it while the app still
/// runs in the background.
public final class CoreLock: @unchecked Sendable {
    public enum Holder: UInt8, Sendable {
        case app = 1
        case share = 2
    }

    private let path: String
    /// The file, while this process holds the lock, and -1 otherwise.
    private var descriptor: Int32 = -1
    private let queue = DispatchQueue(label: "chat.zuna.core-lock")
    private let state = NSLock()
    /// The count this process left when it last took the lock, or nil if it never has.
    private var taken: UInt64?
    private var holding = false

    public init(directory: URL) throws {
        path = directory.appendingPathComponent("core.lock").path
        let file = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw CocoaError(.fileWriteUnknown) }
        close(file)
    }

    deinit {
        if descriptor >= 0 { close(descriptor) }
    }

    public var isHeld: Bool { state.withLock { holding } }

    /// Takes it only if nobody else holds it: nil if somebody does, and otherwise
    /// true if another process held it since this one last did, so what's in
    /// memory is behind. It never waits, so that it's never handed to this
    /// process while iOS has it suspended: whoever waits asks again.
    public func tryTake(as holder: Holder) -> Bool? {
        queue.sync {
            if state.withLock({ holding }) { return false }
            let file = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard file >= 0 else { return nil }
            guard flock(file, LOCK_EX | LOCK_NB) == 0 else {
                close(file)
                return nil
            }
            descriptor = file
            return claim(as: holder)
        }
    }

    /// Who holds it now, as they wrote when they took it.
    public func holder() -> Holder? {
        let file = open(path, O_RDONLY | O_CLOEXEC)
        guard file >= 0 else { return nil }
        defer { close(file) }
        var record = Record()
        guard pread(file, &record, MemoryLayout<Record>.size, 0) == MemoryLayout<Record>.size else { return nil }
        return Holder(rawValue: record.holder)
    }

    public func release() {
        queue.sync {
            guard state.withLock({ holding }) else { return }
            var record = read()
            record.holder = 0
            write(record)
            state.withLock { holding = false }
            flock(descriptor, LOCK_UN)
            close(descriptor)
            descriptor = -1
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
