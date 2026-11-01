import JavaScriptCore
import XCTest
@testable import ZunaHost

/// The native bridges, exercised from JavaScript the way the core uses them.
final class BridgeTests: XCTestCase {
    private var context: JSContext!
    private var directory: URL!
    private var database: DatabaseBridge!

    override func setUpWithError() throws {
        context = JSContext()!
        context.exceptionHandler = { context, exception in context?.exception = exception }
        CryptoBridge().install(in: context)
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        database = DatabaseBridge(directory: directory)
        database.install(in: context)
    }

    override func tearDownWithError() throws {
        database.closeAll()
        try? FileManager.default.removeItem(at: directory)
    }

    @discardableResult
    private func run(_ script: String) throws -> JSValue {
        let value = context.evaluateScript(script)!
        if let exception = context.exception {
            context.exception = nil
            throw CoreError(description: exception.toString() ?? "exception")
        }
        return value
    }

    func testReadsTypedArrayViewsAtTheirOffset() throws {
        // The core slices buffers constantly, for example `sealed.subarray(64)`.
        let view = try run("new Uint8Array([1, 2, 3, 4, 5]).subarray(2, 4)")
        XCTAssertEqual(JSBytes.read(view), Data([3, 4]))
        let bytes = JSBytes.make(Data([9, 8, 7]), in: context)
        context.setObject(bytes, forKeyedSubscript: "made" as NSString)
        XCTAssertEqual(try run("made instanceof Uint8Array && made.join(',')").toString(), "9,8,7")
    }

    func testSealsAndOpensAndThrowsOnTampering() throws {
        let result = try run("""
            const key = __zunaCrypto.randomBytes(32);
            const aad = new Uint8Array([1, 2]);
            const sealed = __zunaCrypto.aeadSeal(key, new Uint8Array([104, 105]), aad);
            const opened = __zunaCrypto.aeadOpen(key, sealed, aad);
            let threw = false;
            try { __zunaCrypto.aeadOpen(key, sealed, new Uint8Array([3])); } catch (error) { threw = error instanceof Error; }
            [opened.join(','), threw].join('|')
            """)
        XCTAssertEqual(result.toString(), "104,105|true")
    }

    func testSignaturesAndKeyPairs() throws {
        let result = try run("""
            const pair = __zunaCrypto.signingKeygen();
            const message = new Uint8Array([5, 6, 7]);
            const signature = __zunaCrypto.sign(pair.secretKey, message);
            [pair.publicKey.length, signature.length, __zunaCrypto.verify(pair.publicKey, message, signature),
             __zunaCrypto.verify(pair.publicKey, new Uint8Array([5]), signature)].join(',')
            """)
        XCTAssertEqual(result.toString(), "32,64,true,false")
    }

    func testDatabaseRunsMigrationsAndRoundTripsBlobs() throws {
        let result = try run("""
            const db = __zunaDb.open('test');
            __zunaDb.run(db, 'CREATE TABLE t (k TEXT PRIMARY KEY, v BLOB, n INTEGER); CREATE TABLE u (x INTEGER);', []);
            __zunaDb.run(db, 'INSERT INTO t(k, v, n) VALUES(?, ?, ?)', ['a', new Uint8Array([0, 255, 7]).subarray(1), 1700000000000]);
            __zunaDb.run(db, 'INSERT INTO t(k, v, n) VALUES(?, ?, ?)', ['b', null, 2.5]);
            const rows = __zunaDb.all(db, 'SELECT k, v, n FROM t ORDER BY k', []);
            [rows.length, rows[0].v instanceof Uint8Array, rows[0].v.join(','), rows[0].n, rows[1].v, rows[1].n].join('|')
            """)
        XCTAssertEqual(result.toString(), "2|true|255,7|1700000000000||2.5")
    }

    func testFullTextSearchWithContentlessDelete() throws {
        // The core's search index needs FTS5 with contentless_delete (SQLite 3.43+).
        let result = try run("""
            const db = __zunaDb.open('search');
            __zunaDb.run(db, "CREATE VIRTUAL TABLE search USING fts5(tokens, content='', contentless_delete=1)", []);
            __zunaDb.run(db, 'INSERT INTO search(rowid, tokens) VALUES(?, ?)', [1, 'habc hdef']);
            __zunaDb.run(db, 'INSERT INTO search(rowid, tokens) VALUES(?, ?)', [2, 'habc']);
            __zunaDb.run(db, 'DELETE FROM search WHERE rowid = ?', [2]);
            __zunaDb.all(db, 'SELECT rowid FROM search WHERE search MATCH ?', ['"habc"']).map(r => r.rowid).join(',')
            """)
        XCTAssertEqual(result.toString(), "1")
    }

    /// The whole of tests/e2e/fixtures/addresses.json, the list the core and the web host go by.
    func testPrivateAddressesMatchTheCore() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/e2e/fixtures/addresses.json")
        let addresses = try JSONDecoder().decode([String: [String]].self, from: Data(contentsOf: url))
        let refused = try XCTUnwrap(addresses["private"])
        let allowed = try XCTUnwrap(addresses["public"])
        XCTAssertFalse(refused.isEmpty)
        XCTAssertFalse(allowed.isEmpty)
        for address in refused + ["::bad::"] {
            XCTAssertTrue(WebBridge.privateAddress(address), address)
        }
        for address in allowed {
            XCTAssertFalse(WebBridge.privateAddress(address), address)
        }
    }

    func testPreviewsOnlyGoToTheUsualPort() {
        XCTAssertFalse(WebBridge.previewable(URL(string: "https://example.com:8443/")))
        XCTAssertFalse(WebBridge.previewable(URL(string: "https://me:secret@example.com/")))
        XCTAssertTrue(WebBridge.previewable(URL(string: "https://example.com:443/")))
    }

    func testDatabaseErrorsBecomeExceptions() throws {
        XCTAssertThrowsError(try run("__zunaDb.all(__zunaDb.open('bad'), 'SELECT * FROM missing', [])"))
    }
}
