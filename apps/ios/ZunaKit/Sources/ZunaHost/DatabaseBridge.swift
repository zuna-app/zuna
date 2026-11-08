import CSQLite
import Foundation
import JavaScriptCore

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct SQLiteError: Error, CustomStringConvertible {
    let description: String
}

/// One SQLite database file. Only ever used from the core's queue.
final class SQLiteDatabase {
    private let handle: OpaquePointer
    private var statements: [String: OpaquePointer] = [:]

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
        for statement in statements.values { sqlite3_finalize(statement) }
        statements.removeAll()
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

    /// A prepared statement for `sql`, cached because the core repeats the same queries constantly.
    func statement(_ sql: String) throws -> OpaquePointer {
        if let cached = statements[sql] { return cached }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v3(handle, sql, -1, UInt32(SQLITE_PREPARE_PERSISTENT), &statement, nil) == SQLITE_OK,
              let statement else {
            throw SQLiteError(description: lastError)
        }
        if statements.count >= 200 {
            for cached in statements.values { sqlite3_finalize(cached) }
            statements.removeAll()
        }
        statements[sql] = statement
        return statement
    }
}

/// Installs `__zunaDb`, the native side of the core's synchronous `LocalDb`.
/// Rows come back as plain objects, with BLOBs as Uint8Array, like the
/// desktop's SQLite WebAssembly build returns them.
final class DatabaseBridge {
    private let directory: URL
    private var databases: [Int: SQLiteDatabase] = [:]
    private var names: [String: Int] = [:]
    private var nextHandle = 1

    init(directory: URL) {
        self.directory = directory
    }

    func path(for name: String) -> URL {
        directory.appendingPathComponent("\(name).sqlite")
    }

    func closeAll() {
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

        let run: @convention(block) (Double, String, JSValue) -> JSValue = { [unowned self] handle, sql, params in
            let context = JSContext.current()!
            guard let database = databases[Int(handle)] else { return throwError("The database is closed.", in: context) }
            do {
                let values = params.isUndefined || params.isNull ? [] : params.arrayElements
                if values.isEmpty {
                    try database.execute(sql)
                } else {
                    let statement = try database.statement(sql)
                    defer { sqlite3_reset(statement); sqlite3_clear_bindings(statement) }
                    try bind(values, to: statement, in: database)
                    var code = sqlite3_step(statement)
                    while code == SQLITE_ROW { code = sqlite3_step(statement) }
                    guard code == SQLITE_DONE else { throw SQLiteError(description: database.lastError) }
                }
                return JSValue(undefinedIn: context)
            } catch {
                return throwError("\(error)", in: context)
            }
        }
        object.setObject(run, forKeyedSubscript: "run" as NSString)

        let all: @convention(block) (Double, String, JSValue) -> JSValue = { [unowned self] handle, sql, params in
            let context = JSContext.current()!
            guard let database = databases[Int(handle)] else { return throwError("The database is closed.", in: context) }
            do {
                let statement = try database.statement(sql)
                defer { sqlite3_reset(statement); sqlite3_clear_bindings(statement) }
                let values = params.isUndefined || params.isNull ? [] : params.arrayElements
                try bind(values, to: statement, in: database)
                return try rows(of: statement, in: database, context: context)
            } catch {
                return throwError("\(error)", in: context)
            }
        }
        object.setObject(all, forKeyedSubscript: "all" as NSString)

        let close: @convention(block) (Double) -> Void = { [unowned self] handle in
            guard let database = databases.removeValue(forKey: Int(handle)) else { return }
            database.close()
            names = names.filter { $0.value != Int(handle) }
        }
        object.setObject(close, forKeyedSubscript: "close" as NSString)

        let remove: @convention(block) (String) -> Void = { [unowned self] name in
            if let handle = names.removeValue(forKey: name) {
                databases.removeValue(forKey: handle)?.close()
            }
            let base = path(for: name).path
            for suffix in ["", "-wal", "-shm", "-journal"] {
                try? FileManager.default.removeItem(atPath: base + suffix)
            }
        }
        object.setObject(remove, forKeyedSubscript: "remove" as NSString)

        context.setObject(object, forKeyedSubscript: "__zunaDb" as NSString)
    }

    private func bind(_ values: [JSValue], to statement: OpaquePointer, in database: SQLiteDatabase) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let code: Int32
            if let bytes = JSBytes.read(value) {
                code = bytes.withUnsafeBytes { raw in
                    sqlite3_bind_blob(statement, index, raw.baseAddress, Int32(bytes.count), SQLITE_TRANSIENT)
                }
            } else if value.isNull || value.isUndefined {
                code = sqlite3_bind_null(statement, index)
            } else if value.isBoolean {
                code = sqlite3_bind_int64(statement, index, value.toBool() ? 1 : 0)
            } else if value.isNumber {
                let number = value.toDouble()
                if number.rounded() == number, abs(number) <= 9_007_199_254_740_991 {
                    code = sqlite3_bind_int64(statement, index, Int64(number))
                } else {
                    code = sqlite3_bind_double(statement, index, number)
                }
            } else if value.isBigInt, let text = value.toString(), let number = Int64(text) {
                code = sqlite3_bind_int64(statement, index, number)
            } else {
                code = sqlite3_bind_text(statement, index, value.toString() ?? "", -1, SQLITE_TRANSIENT)
            }
            guard code == SQLITE_OK else { throw SQLiteError(description: database.lastError) }
        }
    }

    /// Builds the result rows directly with the C API, which is much faster
    /// than converting through Objective-C collections.
    private func rows(of statement: OpaquePointer, in database: SQLiteDatabase, context: JSContext) throws -> JSValue {
        let ctx = context.jsGlobalContextRef!
        let columns = Int(sqlite3_column_count(statement))
        let names = (0..<columns).map { JSStringCreateWithUTF8CString(sqlite3_column_name(statement, Int32($0))) }
        defer { names.forEach { JSStringRelease($0) } }

        let result = JSObjectMakeArray(ctx, 0, nil, nil)!
        var index: UInt32 = 0
        var code = sqlite3_step(statement)
        while code == SQLITE_ROW {
            let row = JSObjectMake(ctx, nil, nil)
            for column in 0..<columns {
                let c = Int32(column)
                let value: JSValueRef
                switch sqlite3_column_type(statement, c) {
                case SQLITE_INTEGER:
                    value = JSValueMakeNumber(ctx, Double(sqlite3_column_int64(statement, c)))
                case SQLITE_FLOAT:
                    value = JSValueMakeNumber(ctx, sqlite3_column_double(statement, c))
                case SQLITE_TEXT:
                    let text = JSStringCreateWithUTF8CString(sqlite3_column_text(statement, c).map { UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self) })
                    value = JSValueMakeString(ctx, text)
                    JSStringRelease(text)
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(statement, c))
                    let bytes = sqlite3_column_blob(statement, c)
                    let data = count > 0 && bytes != nil ? Data(bytes: bytes!, count: count) : Data()
                    value = JSBytes.make(data, in: context).jsValueRef
                default:
                    value = JSValueMakeNull(ctx)
                }
                JSObjectSetProperty(ctx, row, names[column], value, JSPropertyAttributes(kJSPropertyAttributeNone), nil)
            }
            JSObjectSetPropertyAtIndex(ctx, result, index, row, nil)
            index += 1
            code = sqlite3_step(statement)
        }
        guard code == SQLITE_DONE else { throw SQLiteError(description: database.lastError) }
        return JSValue(jsValueRef: result, in: context)
    }
}

/// Throws a JavaScript Error from inside a native call.
func throwError(_ message: String, in context: JSContext) -> JSValue {
    context.exception = JSValue(newErrorFromMessage: message, in: context)
    return JSValue(undefinedIn: context)
}
