import CSQLite
import Foundation
import JavaScriptCore

struct SQLiteError: Error, CustomStringConvertible {
    let description: String
}

/// One SQLite database file. Only ever used from the core's queue.
final class SQLiteDatabase {
    let handle: OpaquePointer
    private var closed = false

    init(path: String) throws {
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "out of memory"
            sqlite3_close_v2(db)
            throw SQLiteError(description: "Couldn't open \(path): \(message)")
        }
        handle = db
        // WAL lets the notification extension read while the app writes.
        try execute("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16000;")
    }

    deinit {
        close()
    }

    func close() {
        guard !closed else { return }
        closed = true
        sqlite3_close_v2(handle)
    }

    /// Runs one or more statements without parameters, such as a migration.
    func execute(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(handle, sql, nil, nil, &error) != SQLITE_OK {
            let message = error.map { String(cString: $0) } ?? lastError
            sqlite3_free(error)
            throw SQLiteError(description: message)
        }
    }

    var lastError: String {
        String(cString: sqlite3_errmsg(handle))
    }
}

/// Installs `__zunaDb`, the native side of the core's synchronous `LocalDb`.
/// Rows come back as plain objects, with BLOBs as Uint8Array, like the
/// desktop's SQLite WebAssembly build returns them.
final class DatabaseBridge {
    private let directory: URL
    private var databases: [Int: SQLiteDatabase] = [:]
    private lazy var statements = PreparedStatements { [unowned self] in databases[$0] }
    private var names: [String: Int] = [:]
    private var nextHandle = 1

    init(directory: URL) {
        self.directory = directory
    }

    func path(for name: String) -> URL {
        directory.appendingPathComponent("\(name).sqlite")
    }

    func closeAll() {
        statements.dropAll()
        for database in databases.values { database.close() }
        databases.removeAll()
        names.removeAll()
    }

    func install(in context: JSContext) {
        let object = JSValue(newObjectIn: context)!

        let open: @convention(block) (String) -> JSValue = { [unowned self] name in
            let context = JSContext.current()!
            if let handle = names[name] { return JSValue(double: Double(handle), in: context) }
            do {
                let database = try SQLiteDatabase(path: path(for: name).path)
                let handle = nextHandle
                nextHandle += 1
                databases[handle] = database
                names[name] = handle
                return JSValue(double: Double(handle), in: context)
            } catch {
                return throwError("\(error)", in: context)
            }
        }
        object.setObject(open, forKeyedSubscript: "open" as NSString)

        // Statements with parameters are prepared once and called by number (PreparedStatements).
        let run: @convention(block) (Double, String) -> JSValue = { [unowned self] handle, sql in
            let context = JSContext.current()!
            guard let database = databases[Int(handle)] else { return throwError("The database is closed.", in: context) }
            do {
                try database.execute(sql)
                return JSValue(undefinedIn: context)
            } catch {
                return throwError("\(error)", in: context)
            }
        }
        object.setObject(run, forKeyedSubscript: "run" as NSString)

        let close: @convention(block) (Double) -> Void = { [unowned self] handle in
            statements.drop(handle: Int(handle))
            guard let database = databases.removeValue(forKey: Int(handle)) else { return }
            database.close()
            names = names.filter { $0.value != Int(handle) }
        }
        object.setObject(close, forKeyedSubscript: "close" as NSString)

        let remove: @convention(block) (String) -> Void = { [unowned self] name in
            if let handle = names.removeValue(forKey: name) {
                statements.drop(handle: handle)
                databases.removeValue(forKey: handle)?.close()
            }
            let base = path(for: name).path
            for suffix in ["", "-wal", "-shm", "-journal"] {
                try? FileManager.default.removeItem(atPath: base + suffix)
            }
        }
        object.setObject(remove, forKeyedSubscript: "remove" as NSString)

        statements.install(on: object, in: context)
        context.setObject(object, forKeyedSubscript: "__zunaDb" as NSString)
    }
}

/// Throws a JavaScript Error from inside a native call.
func throwError(_ message: String, in context: JSContext) -> JSValue {
    context.exception = JSValue(newErrorFromMessage: message, in: context)
    return JSValue(undefinedIn: context)
}
