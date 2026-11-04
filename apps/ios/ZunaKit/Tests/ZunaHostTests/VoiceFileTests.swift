import AVFoundation
import XCTest
import ZunaModels

/// Voice messages from the Linux desktop are Opus in MP4 as Chromium writes it, whose
/// durations add up shorter than the sound. The fixture is 5 s from Chromium's fake
/// microphone, recorded by the desktop's Electron (45, Chromium 156) as lib/voice.ts
/// records on Linux: `audio/mp4;codecs=opus` at 48 kb/s, in 250 ms pieces.
final class VoiceFileTests: XCTestCase {
    private func fixture() throws -> Data {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/chromium-opus.m4a")
        return try Data(contentsOf: url)
    }

    private func duration(_ data: Data) async throws -> Double {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        return try await AVURLAsset(url: url).load(.duration).seconds
    }

    func testPutsChromiumsOpusDurationsRight() async throws {
        let recorded = try fixture()
        // 83 packets of 60 ms, but one sample in each fragment says 21 ms.
        let before = try await duration(recorded)
        XCTAssertEqual(before, 4.32, accuracy: 0.02)
        let fixed = try XCTUnwrap(VoiceFile.fixingOpusDurations(recorded))
        XCTAssertEqual(fixed.count, recorded.count)
        let after = try await duration(fixed)
        XCTAssertEqual(after, 4.98, accuracy: 0.02)
        // Once right, it stays as it is.
        XCTAssertNil(VoiceFile.fixingOpusDurations(fixed))
    }

    func testLeavesAACAlone() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)!
        buffer.frameLength = 48_000
        do {
            let file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1])
            try file.write(from: buffer)
        }
        XCTAssertNil(VoiceFile.fixingOpusDurations(try Data(contentsOf: url)))
    }

    /// The file comes from someone else, so nothing in it may crash the app.
    func testReadsBrokenFilesWithoutCrashing() throws {
        let recorded = try fixture()
        XCTAssertNil(VoiceFile.fixingOpusDurations(Data()))
        XCTAssertNil(VoiceFile.fixingOpusDurations(Data("not a voice message".utf8)))
        for length in stride(from: 0, to: recorded.count, by: 101) {
            _ = VoiceFile.fixingOpusDurations(recorded.prefix(length))
        }
        var random = SystemRandomNumberGenerator()
        for _ in 0..<2000 {
            var broken = [UInt8](recorded)
            for _ in 0..<Int.random(in: 1...8, using: &random) {
                broken[Int.random(in: 0..<min(broken.count, 1200), using: &random)] = UInt8.random(in: 0...255, using: &random)
            }
            _ = VoiceFile.fixingOpusDurations(Data(broken))
        }
    }
}
