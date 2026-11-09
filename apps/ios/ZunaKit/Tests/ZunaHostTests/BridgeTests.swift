import JavaScriptCore
import Network
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
            __zunaDb.run(db, 'CREATE TABLE t (k TEXT PRIMARY KEY, v BLOB, n INTEGER); CREATE TABLE u (x INTEGER);');
            const insert = __zunaDb.prepare(db, 'INSERT INTO t(k, v, n) VALUES(?, ?, ?)');
            __zunaDb.exec(insert, ['a', new Uint8Array([0, 255, 7]).subarray(1), 1700000000000]);
            __zunaDb.exec(insert, ['b', null, 2.5]);
            __zunaDb.exec(insert, ['c', new Uint8Array(0), 10n]);
            const rows = __zunaDb.query(__zunaDb.prepare(db, 'SELECT k, v, n FROM t ORDER BY k'), []);
            [rows.length, rows[0].v instanceof Uint8Array, rows[0].v.join(','), rows[0].n, rows[1].v, rows[1].n,
             rows[2].v instanceof Uint8Array && rows[2].v.length, rows[2].n].join('|')
            """)
        XCTAssertEqual(result.toString(), "3|true|255,7|1700000000000||2.5|0|10")
    }

    func testStatementsAreKeptUntilDroppedOrClosed() throws {
        let result = try run("""
            const db = __zunaDb.open('kept');
            __zunaDb.run(db, 'CREATE TABLE t (k TEXT); INSERT INTO t VALUES (\\'é ✓\\');');
            const select = __zunaDb.prepare(db, 'SELECT k FROM t WHERE k = ?');
            const first = __zunaDb.query(select, ['é ✓']).length;
            // A change to the schema compiles it again, with the columns it has now.
            __zunaDb.run(db, 'ALTER TABLE t ADD COLUMN n INTEGER DEFAULT 3');
            const star = __zunaDb.prepare(db, 'SELECT * FROM t');
            const before = Object.keys(__zunaDb.query(star, [])[0]).join(',');
            __zunaDb.run(db, 'ALTER TABLE t ADD COLUMN m TEXT');
            const after = Object.keys(__zunaDb.query(star, [])[0]).join(',');
            __zunaDb.drop(db);
            let dropped = false;
            try { __zunaDb.query(select, ['x']); } catch (error) { dropped = error instanceof Error; }
            const again = __zunaDb.prepare(db, 'SELECT k FROM t');
            __zunaDb.close(db);
            let closed = false;
            try { __zunaDb.query(again, []); } catch (error) { closed = error instanceof Error; }
            [first, before, after, dropped, closed].join('|')
            """)
        XCTAssertEqual(result.toString(), "1|k,n|k,n,m|true|true")
    }

    func testFullTextSearchWithContentlessDelete() throws {
        // The core's search index needs FTS5 with contentless_delete (SQLite 3.43+).
        let result = try run("""
            const db = __zunaDb.open('search');
            __zunaDb.run(db, "CREATE VIRTUAL TABLE search USING fts5(tokens, content='', contentless_delete=1)");
            const insert = __zunaDb.prepare(db, 'INSERT INTO search(rowid, tokens) VALUES(?, ?)');
            __zunaDb.exec(insert, [1, 'habc hdef']);
            __zunaDb.exec(insert, [2, 'habc']);
            __zunaDb.exec(__zunaDb.prepare(db, 'DELETE FROM search WHERE rowid = ?'), [2]);
            __zunaDb.query(__zunaDb.prepare(db, 'SELECT rowid FROM search WHERE search MATCH ?'), ['"habc"']).map(r => r.rowid).join(',')
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

    /// A name checked beforehand can lead somewhere else by the time it's fetched, so it's where the fetch went that counts.
    func testPreviewsOnlyKeepWhatCameFromSomewherePublic() {
        XCTAssertTrue(WebBridge.wentPublic([(host: "example.com", address: "93.184.216.34", proxy: false)]))
        XCTAssertFalse(WebBridge.wentPublic([(host: "example.com", address: "127.0.0.1", proxy: false)]))
        XCTAssertFalse(WebBridge.wentPublic([
            (host: "example.com", address: "93.184.216.34", proxy: false),
            (host: "example.org", address: "fd00::1", proxy: false),
        ]))
        XCTAssertFalse(WebBridge.wentPublic([(host: "example.com", address: "::ffff:10.0.0.1", proxy: false)]))
        // A proxy's own address is no answer, and neither is none at all: those go by the check beforehand.
        XCTAssertTrue(WebBridge.wentPublic([(host: "example.com", address: "10.0.0.8", proxy: true)]))
        XCTAssertTrue(WebBridge.wentPublic([(host: "example.com", address: nil, proxy: false)]))
    }

    /// The real thing, over a real connection: a page comes back once where it came from is known.
    /// Test builds may fetch this machine's own pages, as `isTestPage` says.
    func testAPreviewArrivesOnceItsConnectionIsChecked() throws {
        let page = "<title>Here</title>"
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: \(page.utf8.count)\r\nConnection: close\r\n\r\n\(page)"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let ready = expectation(description: "listening")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.start(queue: .global())
        wait(for: [ready], timeout: 5)
        defer { listener.cancel() }

        let queue = DispatchQueue(label: "web-test")
        let done = expectation(description: "the page")
        var result: [Any] = []
        let bridge = WebBridge(queue: queue) { _, arguments in
            result = arguments
            done.fulfill()
        }
        let context = JSContext()!
        let object = JSValue(newObjectIn: context)!
        bridge.install(into: object)
        let address = "http://127.0.0.1:\(listener.port!.rawValue)/"
        queue.async { _ = object.objectForKeyedSubscript("webFetch").call(withArguments: [1, address, 60000]) }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(result.count, 5)
        XCTAssertTrue(result.last is NSNull, "\(result)")
        XCTAssertEqual(result[1] as? String, address)
        XCTAssertEqual((result[3] as? Data).map { String(decoding: $0, as: UTF8.self) }, page)
    }

    func testDatabaseErrorsBecomeExceptions() throws {
        XCTAssertThrowsError(try run("__zunaDb.prepare(__zunaDb.open('bad'), 'SELECT * FROM missing')"))
        XCTAssertThrowsError(try run("""
            const bad = __zunaDb.open('bad');
            __zunaDb.run(bad, 'CREATE TABLE u (x INTEGER PRIMARY KEY)');
            const insert = __zunaDb.prepare(bad, 'INSERT INTO u VALUES (?)');
            __zunaDb.exec(insert, [1]);
            __zunaDb.exec(insert, [1]);
            """))
    }
}
