import Foundation
import XCTest
@testable import ZunaHost
@testable import ZunaModels

/// The host the core bundle runs on, through the web APIs it's given and the calls the app and
/// its extensions make: timers, text, files, account events, and what a notification shows.
final class CoreRuntimeTests: XCTestCase {
    private var directory: URL!
    private var runtime: CoreRuntime!
    private let accountEvents = Locked<[AccountEvent]>([])

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var options = CoreRuntime.Options(dataDirectory: directory, deviceKey: Data(repeating: 5, count: 32), deviceName: "Runtime")
        options.logToStandardError = true
        options.listsBots = true
        options.onAccountEvent = { [accountEvents] event in accountEvents.value.append(event) }
        runtime = try CoreRuntime(options: options)
        try await runtime.start()
    }

    override func tearDown() async throws {
        runtime = nil
        try? FileManager.default.removeItem(at: directory)
    }

    /// The value of a script run in the core's context, as text.
    private func evaluate(_ script: String) async -> String {
        await withCheckedContinuation { continuation in
            runtime.evaluateForTesting(script) { continuation.resume(returning: $0) }
        }
    }

    func testTimersFireRepeatAndCanBeCleared() async throws {
        let set = await evaluate("""
            globalThis.ticks = 0; globalThis.fired = 0; globalThis.cleared = 0;
            setTimeout((a, b) => { fired += a + b; }, 5, 1, 2);
            const interval = setInterval(() => { if (++ticks === 3) clearInterval(interval); }, 5);
            clearTimeout(setTimeout(() => { cleared++; }, 1));
            // One that throws is reported, and the others go on.
            setTimeout(() => { throw new Error('from a timer'); }, 0);
            'set'
            """)
        XCTAssertEqual(set, "set")
        var seen = ""
        for _ in 0..<200 {
            seen = await evaluate("[ticks, fired, cleared].join(',')")
            if seen == "3,3,0" { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(seen, "3,3,0")
        try await Task.sleep(for: .milliseconds(50))
        let after = await evaluate("[ticks, cleared].join(',')")
        XCTAssertEqual(after, "3,0")
    }

    func testTextAndBase64GoThroughTheHost() async {
        let text = await evaluate("""
            const bytes = new TextEncoder().encode('zażółć ✓');
            const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
            [bytes.length, new TextDecoder().decode(bytes), new TextDecoder().decode(withMark), new TextDecoder().decode(),
             btoa('hi'), atob('aGk='), Uint8Array.fromBase64('AQID').join(','), new Uint8Array([1, 2, 3]).toBase64()].join('|')
            """)
        XCTAssertEqual(text, "14|zażółć ✓|zażółć ✓||aGk=|hi|1,2,3|AQID")
        let refused = await evaluate("""
            const bad = (body) => { try { body(); return 'no'; } catch (error) { return error.message; } };
            [bad(() => atob('*')), bad(() => btoa('✓'))].join('|')
            """)
        XCTAssertEqual(refused, "The string to be decoded is not correctly encoded.|The string to be encoded contains characters outside of the Latin1 range.")
        // What the console is given goes to the log, at its level, whatever it is.
        let logged = await evaluate("""
            const circular = {}; circular.self = circular;
            console.log('info', { a: 1 }); console.warn('warn'); console.error(new Error('an error')); console.debug('debug', circular, undefined);
            'logged'
            """)
        XCTAssertEqual(logged, "logged")
    }

    func testFilesAreReadAChunkAtATimeAndWrittenToTheCache() async throws {
        let file = directory.appendingPathComponent("send.bin")
        try Data((0..<200).map { UInt8($0) }).write(to: file)
        let read = await evaluate("""
            [__zunaHost.fileSize('\(file.path)'), __zunaHost.fileSize('/nowhere/at/all'),
             __zunaHost.fileRead('\(file.path)', 10, 14).join(','), __zunaHost.fileRead('\(file.path)', 198, 400).join(',')].join('|')
            """)
        XCTAssertEqual(read, "200|0|10,11,12,13|198,199")
        let missing = await evaluate("try { __zunaHost.fileRead('/nowhere/at/all', 0, 1); 'read' } catch (error) { error.message }")
        XCTAssertEqual(missing, "Couldn't open a file to send.")

        let path = await evaluate("__zunaHost.fileAssemble([new Uint8Array([1, 2]), new Uint8Array([3]), 'not bytes'], 'bin')")
        XCTAssertTrue(path.hasPrefix(runtime.options.cacheDirectory.path), path)
        XCTAssertTrue(path.hasSuffix(".bin"), path)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data([1, 2, 3]))

        // The cache is emptied each time the core starts again.
        let again = try CoreRuntime(options: runtime.options)
        try await again.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testAccountEventsReachTheAppAndBroadcastsReachEveryChannel() async throws {
        let sent = await evaluate("""
            __zunaHost.accountEvent(JSON.stringify({ type: 'signedIn', serverUrl: 'https://chat.example', username: 'someone', serverName: 'Chat', password: 'pw' }));
            __zunaHost.accountEvent('not json');
            __zunaHost.accountEvent(JSON.stringify({ type: 'somethingElse' }));
            'sent'
            """)
        XCTAssertEqual(sent, "sent")
        let reached = await eventually { self.accountEvents.value.count == 1 }
        XCTAssertTrue(reached)
        XCTAssertEqual(accountEvents.value.first?.type, .signedIn)
        XCTAssertEqual(accountEvents.value.first?.password, "pw")

        let first = Locked<[String]>([]), second = Locked<[String]>([])
        let one = runtime.connect { first.value.append($0) }
        let two = runtime.connect { second.value.append($0) }
        _ = await evaluate("__zunaHost.post(0, 'to everyone'); __zunaHost.post(\(two.id), 'to the second'); 'posted'")
        let delivered = await eventually { first.value == ["to everyone"] && second.value == ["to everyone", "to the second"] }
        XCTAssertTrue(delivered, "\(first.value) \(second.value)")
        // A closed channel hears nothing more.
        one.close()
        _ = await evaluate("__zunaHost.post(0, 'after'); 'posted'")
        let after = await eventually { second.value.last == "after" }
        XCTAssertTrue(after)
        XCTAssertEqual(first.value, ["to everyone"])
        two.close()
    }

    func testTheBundleKnowsWhatTheHostOffers() async {
        let offered = await evaluate("[!!__zunaHost.listsBots, !!__zunaHost.testHooks, typeof __zunaTest.setClockOffset].join(',')")
        XCTAssertEqual(offered, "true,true,function")
    }

    func testNotificationsOnAServerThisDeviceHasntJoinedAreRefused() async throws {
        // As the notification extension calls it: without booting a client.
        let extensionRuntime = try CoreRuntime(options: .init(dataDirectory: directory.appendingPathComponent("extension"),
                                                              deviceKey: Data(repeating: 5, count: 32), deviceName: "Extension"))
        for runtime in [runtime!, extensionRuntime] {
            do {
                _ = try await runtime.pushPreview(serverId: "nowhere", groupId: "g", messageId: "m", pictures: true)
                XCTFail("a message on no server was previewed")
            } catch let error as CoreError {
                XCTAssertFalse(error.description.isEmpty)
            }
            do {
                _ = try await runtime.stillNotified(serverId: "nowhere")
                XCTFail("a server this device isn't on was asked")
            } catch let error as CoreError {
                XCTAssertFalse(error.description.isEmpty)
            }
            do {
                _ = try await runtime.callPreview(serverId: "nowhere", groupId: "g", callerId: "u")
                XCTFail("a call on no server was previewed")
            } catch let error as CoreError {
                XCTAssertFalse(error.description.isEmpty)
            }
        }
    }

    func testTestHooksMakeTheNetworkFailAndCanBeUndone() async throws {
        let server = try await LocalHTTP.start { _ in HTTPResponse(body: Data(#"{"ok":true}"#.utf8)) }
        defer { server.stop() }
        let fetch = { [self] () async -> String in
            _ = await evaluate("""
                globalThis.fetched = 'waiting';
                fetch('\(server.base)/thing').then(r => r.text()).then(t => { fetched = t; }, e => { fetched = 'failed: ' + e.message; });
                'started'
                """)
            for _ in 0..<300 {
                let value = await evaluate("fetched")
                if value != "waiting" { return value }
                try? await Task.sleep(for: .milliseconds(10))
            }
            return "never answered"
        }
        let online = await fetch()
        XCTAssertEqual(online, #"{"ok":true}"#)
        runtime.setOffline(true)
        let offline = await fetch()
        XCTAssertTrue(offline.hasPrefix("failed"), offline)
        runtime.setOffline(false)
        runtime.networkChanged()
        // A pattern that matches nothing never stops the process.
        runtime.crashOnResponse(method: "GET", urlPattern: "^nothing-matches-this$")
        runtime.crashOnResponse(method: "GET", urlPattern: "(unclosed")
        let back = await fetch()
        XCTAssertEqual(back, #"{"ok":true}"#)
    }
}
