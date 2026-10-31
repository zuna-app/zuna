// Draws the emote fixtures for the fake 7TV: a static emote, an animated one
// and a zero-width one, as WebP with transparency like real 7TV emotes. The
// output is committed; run this again only to change it:
//
//   swift tests/e2e/fixtures/make-emotes.swift
//
// Needs img2webp (brew install webp).

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let output = here.appendingPathComponent("emotes")
let work = FileManager.default.temporaryDirectory.appendingPathComponent("zuna-emotes-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

func frame(size: Int, draw: (CGContext, CGFloat) -> Void) -> CGImage {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    draw(context, CGFloat(size))
    return context.makeImage()!
}

func png(_ image: CGImage, _ name: String) -> String {
    let url = work.appendingPathComponent(name)
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination))
    return url.path
}

func webp(_ frames: [String], _ name: String, animated: Bool) {
    let tool = Process()
    tool.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/img2webp")
    tool.arguments = (animated ? ["-loop", "0", "-d", "120"] : []) + ["-lossless"] + frames + ["-o", output.appendingPathComponent(name).path]
    try! tool.run()
    tool.waitUntilExit()
    precondition(tool.terminationStatus == 0)
}

func face(_ color: CGColor) -> (CGContext, CGFloat) -> Void {
    { context, size in
        context.setFillColor(color)
        context.fillEllipse(in: CGRect(x: size * 0.1, y: size * 0.1, width: size * 0.8, height: size * 0.8))
        context.setFillColor(CGColor(gray: 0.1, alpha: 1))
        context.fillEllipse(in: CGRect(x: size * 0.32, y: size * 0.55, width: size * 0.1, height: size * 0.12))
        context.fillEllipse(in: CGRect(x: size * 0.58, y: size * 0.55, width: size * 0.1, height: size * 0.12))
    }
}

for scale in 1...4 {
    let size = 28 * scale
    // A static emote.
    webp([png(frame(size: size, draw: face(CGColor(srgbRed: 0.98, green: 0.78, blue: 0.2, alpha: 1))), "static-\(scale).png")],
         "static-\(scale)x.webp", animated: false)
    // An animated emote: three colors in turn.
    let colors = [CGColor(srgbRed: 0.95, green: 0.35, blue: 0.4, alpha: 1), CGColor(srgbRed: 0.3, green: 0.75, blue: 0.45, alpha: 1), CGColor(srgbRed: 0.3, green: 0.55, blue: 0.95, alpha: 1)]
    webp(colors.enumerated().map { png(frame(size: size, draw: face($0.element)), "animated-\(scale)-\($0.offset).png") },
         "animated-\(scale)x.webp", animated: true)
    // A zero-width emote: a translucent ring drawn over the emote before it.
    webp([png(frame(size: size) { context, size in
        context.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.8))
        context.setLineWidth(size * 0.08)
        context.strokeEllipse(in: CGRect(x: size * 0.08, y: size * 0.08, width: size * 0.84, height: size * 0.84))
    }, "zero-\(scale).png")], "zero-width-\(scale)x.webp", animated: false)
}
try? FileManager.default.removeItem(at: work)
print("wrote \(output.path)")
