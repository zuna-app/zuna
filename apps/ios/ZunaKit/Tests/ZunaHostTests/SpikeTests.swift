import CoreGraphics
import Foundation
import ImageIO
import JavaScriptCore
import UniformTypeIdentifiers
import XCTest

/// F0 spike: code highlighting with the desktop's Shiki setup in JavaScriptCore.
/// Run through apps/ios/spikes/highlight.mjs, which builds the bundle and the
/// golden tokens from Node.
final class HighlightSpikeTests: XCTestCase {
    func testHighlightsExactlyLikeTheDesktop() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let bundlePath = environment["ZUNA_HIGHLIGHT_BUNDLE"], let goldenPath = environment["ZUNA_HIGHLIGHT_GOLDEN"] else {
            throw XCTSkip("Run apps/ios/spikes/highlight.mjs")
        }
        let context = JSContext()!
        var failure: String?
        context.exceptionHandler = { _, exception in failure = exception?.toString() }
        let log: @convention(block) (JSValue) -> Void = { _ in }
        context.evaluateScript("var console = {}")
        for level in ["log", "warn", "error", "info", "debug"] {
            context.objectForKeyedSubscript("console").setObject(log, forKeyedSubscript: level as NSString)
        }
        context.evaluateScript(try String(contentsOfFile: bundlePath, encoding: .utf8))
        XCTAssertNil(failure)

        struct Sample: Decodable { let language: String; let code: String; let tokens: String }
        let samples = try JSONDecoder().decode([Sample].self, from: Data(contentsOf: URL(fileURLWithPath: goldenPath)))
        for sample in samples {
            var result: String?
            var error: String?
            let done: @convention(block) (JSValue, JSValue) -> Void = { value, problem in
                result = value.isNull ? nil : value.toString()
                error = problem.isNull ? nil : problem.toString()
            }
            let start = Date()
            context.objectForKeyedSubscript("__zunaHighlight").call(withArguments: [sample.code, sample.language, done as Any])
            // Shiki's promises settle on JavaScriptCore's microtask queue, drained when the call returns.
            XCTAssertNil(error, sample.language)
            XCTAssertEqual(result, sample.tokens, sample.language)
            print("[spike] highlighted \(sample.language) in \(Int(Date().timeIntervalSince(start) * 1000)) ms")
        }
    }
}

/// F0 spike: 7TV emotes are animated WebP. ImageIO must decode their frames and
/// timing, so the app needs no third-party image library.
final class AnimatedWebPSpikeTests: XCTestCase {
    func testDecodesAndAnimatesAnimatedWebP() throws {
        let work = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }

        // Three translucent frames, like an emote.
        var frames: [String] = []
        for (index, color) in [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)].enumerated() {
            let context = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(CGColor(srgbRed: color.0, green: color.1, blue: color.2, alpha: 0.6))
            context.fillEllipse(in: CGRect(x: 8, y: 8, width: 48, height: 48))
            let url = work.appendingPathComponent("frame\(index).png")
            let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
            CGImageDestinationAddImage(destination, context.makeImage()!, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
            frames.append(url.path)
        }
        let webp = work.appendingPathComponent("emote.webp")
        let tool = Process()
        tool.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/img2webp")
        tool.arguments = ["-loop", "0", "-lossy", "-d", "80"] + frames + ["-o", webp.path]
        try tool.run()
        tool.waitUntilExit()
        XCTAssertEqual(tool.terminationStatus, 0)

        let source = try XCTUnwrap(CGImageSourceCreateWithURL(webp as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.webP.identifier)
        XCTAssertEqual(CGImageSourceGetCount(source), 3)
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 1, nil) as? [CFString: Any]
        let webpProperties = properties?[kCGImagePropertyWebPDictionary] as? [CFString: Any]
        let delay = (webpProperties?[kCGImagePropertyWebPUnclampedDelayTime] ?? webpProperties?[kCGImagePropertyWebPDelayTime]) as? Double
        XCTAssertEqual(delay ?? 0, 0.08, accuracy: 0.005)
        let frame = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 2, nil))
        XCTAssertEqual(frame.width, 64)
        XCTAssertNotEqual(frame.alphaInfo, .none)

        // The system animator plays it, so emotes can animate without decoding frames by hand.
        let played = expectation(description: "frames")
        played.expectedFulfillmentCount = 3
        played.assertForOverFulfill = false
        var seen = Set<Int>()
        let status = CGAnimateImageAtURLWithBlock(webp as CFURL, nil) { index, _, stop in
            if seen.insert(index).inserted { played.fulfill() }
            if seen.count == 3 { stop.pointee = true }
        }
        XCTAssertEqual(status, noErr)
        wait(for: [played], timeout: 5)
    }
}
