import CSQLite
import Foundation
import JavaScriptCore

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// The statements the core prepares, kept by number until it drops them or their
/// database closes: `__zunaDb.prepare`, `query`, `exec` and `drop`. They're called
/// through JavaScriptCore's C API, as wrapping each argument and row in Objective-C
/// cost more than the query: a lookup by key took 13.6 µs that way, 6.4 µs this way.
final class PreparedStatements {
    private struct Statement {
        let handle: Int
        let database: SQLiteDatabase
        let pointer: OpaquePointer
        /// The columns' names, made the first time it returns rows.
        var names: [JSStringRef]?
    }

    private enum Kind { case prepare, query, exec, drop }

    /// What each function points to. JavaScript owns it, and lets it go with the function.
    private final class Function {
        weak var owner: PreparedStatements?
        let kind: Kind

        init(owner: PreparedStatements, kind: Kind) {
            self.owner = owner
            self.kind = kind
        }
    }

    private let databases: (Int) -> SQLiteDatabase?
    private var statements: [Int: Statement] = [:]
    private var next = 1
    private let length = JSStringCreateWithUTF8CString("length")
    /// Text on its way to SQLite, which copies it.
    private var buffer = [CChar](repeating: 0, count: 4096)

    init(databases: @escaping (Int) -> SQLiteDatabase?) {
        self.databases = databases
    }

    deinit {
        dropAll()
        JSStringRelease(length)
    }

    func install(on object: JSValue, in context: JSContext) {
        let ctx = context.jsGlobalContextRef!
        var definition = kJSClassDefinitionEmpty
        definition.callAsFunction = { ctx, function, _, count, arguments, exception in
            guard let ctx, let function, let raw = JSObjectGetPrivate(function) else { return nil }
            let fn = Unmanaged<Function>.fromOpaque(raw).takeUnretainedValue()
            guard let owner = fn.owner else { return PreparedStatements.fail(ctx, "The database is closed.", exception) }
            return owner.call(fn.kind, ctx, count, arguments, exception)
        }
        definition.finalize = { function in
            guard let raw = JSObjectGetPrivate(function) else { return }
            Unmanaged<Function>.fromOpaque(raw).release()
        }
        let functionClass = JSClassCreate(&definition)
        defer { JSClassRelease(functionClass) }
        let target = JSValueToObject(ctx, object.jsValueRef, nil)
        for (name, kind) in [("prepare", Kind.prepare), ("query", .query), ("exec", .exec), ("drop", .drop)] {
            let fn = Unmanaged.passRetained(Function(owner: self, kind: kind))
            let value = JSObjectMake(ctx, functionClass, fn.toOpaque())
            let key = JSStringCreateWithUTF8CString(name)
            JSObjectSetProperty(ctx, target, key, value, JSPropertyAttributes(kJSPropertyAttributeNone), nil)
            JSStringRelease(key)
        }
    }

    /// Finalizes every statement of a database, before it closes or when the core lets them go.
    func drop(handle: Int) {
        for (id, statement) in statements where statement.handle == handle { finalize(id) }
    }

    func dropAll() {
        for id in Array(statements.keys) { finalize(id) }
    }

    private func finalize(_ id: Int) {
        guard let statement = statements.removeValue(forKey: id) else { return }
        sqlite3_finalize(statement.pointer)
        statement.names?.forEach { JSStringRelease($0) }
    }

    private func call(_ kind: Kind, _ ctx: JSContextRef, _ count: Int, _ arguments: UnsafePointer<JSValueRef?>?, _ exception: UnsafeMutablePointer<JSValueRef?>?) -> JSValueRef? {
        let id = count > 0 ? Int(JSValueToNumber(ctx, arguments?[0], nil)) : 0
        switch kind {
        case .prepare:
            guard let database = databases(id) else { return Self.fail(ctx, "The database is closed.", exception) }
            guard count > 1, copyText(ctx, arguments?[1]) != nil else { return Self.fail(ctx, "No SQL to prepare.", exception) }
            var pointer: OpaquePointer?
            guard sqlite3_prepare_v3(database.handle, buffer, -1, UInt32(SQLITE_PREPARE_PERSISTENT), &pointer, nil) == SQLITE_OK,
                  let pointer else {
                return Self.fail(ctx, database.lastError, exception)
            }
            let number = next
            next += 1
            statements[number] = Statement(handle: id, database: database, pointer: pointer)
            return JSValueMakeNumber(ctx, Double(number))
        case .drop:
            drop(handle: id)
            return JSValueMakeUndefined(ctx)
        case .query, .exec:
            guard let statement = statements[id] else { return Self.fail(ctx, "That statement was let go.", exception) }
            let pointer = statement.pointer
            defer { sqlite3_reset(pointer); sqlite3_clear_bindings(pointer) }
            if let error = bind(ctx, count > 1 ? arguments?[1] : nil, to: pointer, in: statement.database) {
                return Self.fail(ctx, error, exception)
            }
            if kind == .query { return rows(ctx, id, pointer, statement.database, exception) }
            var code = sqlite3_step(pointer)
            while code == SQLITE_ROW { code = sqlite3_step(pointer) }
            guard code == SQLITE_DONE else { return Self.fail(ctx, statement.database.lastError, exception) }
            return JSValueMakeUndefined(ctx)
        }
    }

    /// Copies a value's text into `buffer` as UTF-8, and gives its length without the terminator.
    private func copyText(_ ctx: JSContextRef, _ value: JSValueRef?) -> Int? {
        guard let text = JSValueToStringCopy(ctx, value, nil) else { return nil }
        defer { JSStringRelease(text) }
        let size = JSStringGetMaximumUTF8CStringSize(text)
        if buffer.count < size { buffer = [CChar](repeating: 0, count: size) }
        return JSStringGetUTF8CString(text, &buffer, size) - 1
    }

    private func bind(_ ctx: JSContextRef, _ params: JSValueRef?, to pointer: OpaquePointer, in database: SQLiteDatabase) -> String? {
        guard let params, JSValueIsObject(ctx, params), let array = JSValueToObject(ctx, params, nil) else { return nil }
        let count = Int(JSValueToNumber(ctx, JSObjectGetProperty(ctx, array, length, nil), nil))
        for offset in 0..<count {
            let index = Int32(offset + 1)
            let value = JSObjectGetPropertyAtIndex(ctx, array, UInt32(offset), nil)
            let code: Int32
            switch JSValueGetType(ctx, value) {
            case kJSTypeUndefined, kJSTypeNull:
                code = sqlite3_bind_null(pointer, index)
            case kJSTypeBoolean:
                code = sqlite3_bind_int64(pointer, index, JSValueToBoolean(ctx, value) ? 1 : 0)
            case kJSTypeNumber:
                let number = JSValueToNumber(ctx, value, nil)
                if number.rounded() == number, abs(number) <= 9_007_199_254_740_991 {
                    code = sqlite3_bind_int64(pointer, index, Int64(number))
                } else {
                    code = sqlite3_bind_double(pointer, index, number)
                }
            case kJSTypeBigInt:
                guard copyText(ctx, value) != nil, let number = buffer.withUnsafeBufferPointer({ Int64(String(cString: $0.baseAddress!)) }) else {
                    return "A number too big to store."
                }
                code = sqlite3_bind_int64(pointer, index, number)
            case kJSTypeObject where JSValueGetTypedArrayType(ctx, value, nil) != kJSTypedArrayTypeNone:
                code = bindBytes(ctx, value!, index, pointer)
            default:
                guard let written = copyText(ctx, value) else { return "A value SQLite can't store." }
                code = sqlite3_bind_text(pointer, index, buffer, Int32(written), SQLITE_TRANSIENT)
            }
            guard code == SQLITE_OK else { return database.lastError }
        }
        return nil
    }

    /// Binds the bytes a typed array or ArrayBuffer holds, empty ones as an empty blob, not NULL.
    private func bindBytes(_ ctx: JSContextRef, _ value: JSValueRef, _ index: Int32, _ pointer: OpaquePointer) -> Int32 {
        guard let object = JSValueToObject(ctx, value, nil) else { return sqlite3_bind_null(pointer, index) }
        let count: Int
        let bytes: UnsafeMutableRawPointer?
        if JSValueGetTypedArrayType(ctx, value, nil) == kJSTypedArrayTypeArrayBuffer {
            count = JSObjectGetArrayBufferByteLength(ctx, object, nil)
            bytes = count > 0 ? JSObjectGetArrayBufferBytesPtr(ctx, object, nil) : nil
        } else {
            count = JSObjectGetTypedArrayByteLength(ctx, object, nil)
            // The pointer is to the start of the underlying buffer, not of this view.
            bytes = count > 0 ? JSObjectGetTypedArrayBytesPtr(ctx, object, nil).map { $0 + JSObjectGetTypedArrayByteOffset(ctx, object, nil) } : nil
        }
        guard let bytes else { return sqlite3_bind_zeroblob(pointer, index, 0) }
        return sqlite3_bind_blob(pointer, index, bytes, Int32(count), SQLITE_TRANSIENT)
    }

    /// The rows as plain objects, with BLOBs as Uint8Array, as the desktop's SQLite returns them.
    private func rows(_ ctx: JSContextRef, _ id: Int, _ pointer: OpaquePointer, _ database: SQLiteDatabase, _ exception: UnsafeMutablePointer<JSValueRef?>?) -> JSValueRef? {
        var code = sqlite3_step(pointer)
        // After the step, as a change to the schema compiles the statement again, maybe with other columns.
        let columns = Int(sqlite3_column_count(pointer))
        let names: [JSStringRef]
        if let known = statements[id]?.names, known.count == columns {
            names = known
        } else {
            statements[id]?.names?.forEach { JSStringRelease($0) }
            names = (0..<columns).map { JSStringCreateWithUTF8CString(sqlite3_column_name(pointer, Int32($0))) }
            statements[id]?.names = names
        }
        let result = JSObjectMakeArray(ctx, 0, nil, nil)!
        var index: UInt32 = 0
        while code == SQLITE_ROW {
            let row = JSObjectMake(ctx, nil, nil)
            for column in 0..<columns {
                let c = Int32(column)
                let value: JSValueRef
                switch sqlite3_column_type(pointer, c) {
                case SQLITE_INTEGER:
                    value = JSValueMakeNumber(ctx, Double(sqlite3_column_int64(pointer, c)))
                case SQLITE_FLOAT:
                    value = JSValueMakeNumber(ctx, sqlite3_column_double(pointer, c))
                case SQLITE_TEXT:
                    let text = JSStringCreateWithUTF8CString(sqlite3_column_text(pointer, c).map { UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self) })
                    value = JSValueMakeString(ctx, text)
                    JSStringRelease(text)
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(pointer, c))
                    let array = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeUint8Array, count, nil)!
                    if count > 0, let source = sqlite3_column_blob(pointer, c), let bytes = JSObjectGetTypedArrayBytesPtr(ctx, array, nil) {
                        (bytes + JSObjectGetTypedArrayByteOffset(ctx, array, nil)).copyMemory(from: source, byteCount: count)
                    }
                    value = array
                default:
                    value = JSValueMakeNull(ctx)
                }
                JSObjectSetProperty(ctx, row, names[column], value, JSPropertyAttributes(kJSPropertyAttributeNone), nil)
            }
            JSObjectSetPropertyAtIndex(ctx, result, index, row, nil)
            index += 1
            code = sqlite3_step(pointer)
        }
        guard code == SQLITE_DONE else { return Self.fail(ctx, database.lastError, exception) }
        return result
    }

    /// Throws a JavaScript Error from inside a call.
    private static func fail(_ ctx: JSContextRef, _ message: String, _ exception: UnsafeMutablePointer<JSValueRef?>?) -> JSValueRef? {
        let text = JSStringCreateWithUTF8CString(message)
        defer { JSStringRelease(text) }
        var argument: JSValueRef? = JSValueMakeString(ctx, text)
        exception?.pointee = JSObjectMakeError(ctx, 1, &argument, nil)
        return JSValueMakeUndefined(ctx)
    }
}
