import CoreGraphics
import Foundation
import ImageIO
import JavaScriptCore
import UniformTypeIdentifiers
import XCTest

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
