import AVFoundation
import Foundation

/// The small sounds a voice channel makes, made from the same notes as the
/// desktop's (packages/ui/src/voice/sounds.ts), so no audio files are bundled.
@MainActor
final class VoiceSounds {
    enum Sound: CaseIterable {
        case join, leave, selfJoin, selfLeave, mute, unmute, deafen, undeafen

        /// When each note starts and how long it lasts, in seconds, and its pitch.
        fileprivate var notes: [(offset: Double, frequency: Double, length: Double)] {
            switch self {
            case .join: [(0, 523.25, 0.1), (0.08, 783.99, 0.16)]
            case .leave: [(0, 783.99, 0.1), (0.08, 523.25, 0.16)]
            case .selfJoin: [(0, 587.33, 0.09), (0.07, 739.99, 0.09), (0.14, 987.77, 0.18)]
            case .selfLeave: [(0, 987.77, 0.09), (0.07, 739.99, 0.09), (0.14, 587.33, 0.18)]
            case .mute: [(0, 493.88, 0.09)]
            case .unmute: [(0, 659.25, 0.09)]
            case .deafen: [(0, 493.88, 0.08), (0.07, 392, 0.1)]
            case .undeafen: [(0, 493.88, 0.08), (0.07, 659.25, 0.1)]
            }
        }
    }

    private var players: [AVAudioPlayer] = []

    func play(_ sound: Sound) {
        // Sounds aren't essential.
        guard let player = try? AVAudioPlayer(data: Self.wave(sound.notes)) else { return }
        players.removeAll { !$0.isPlaying }
        players.append(player)
        player.play()
    }

    private static let rate = 48_000.0

    /// The notes as a WAV file: sines that swell in 10 ms and fade away, as the desktop's do.
    private static func wave(_ notes: [(offset: Double, frequency: Double, length: Double)]) -> Data {
        let end = notes.map { $0.offset + $0.length + 0.02 }.max() ?? 0
        var samples = [Double](repeating: 0, count: Int(end * rate))
        let peak = 0.08, floor = 0.0001
        for note in notes {
            let start = Int(note.offset * rate)
            let count = Int((note.length + 0.02) * rate)
            for index in 0..<count where start + index < samples.count {
                let time = Double(index) / rate
                // Exponential ramps from almost nothing to the peak in 10 ms, then down to almost nothing by the note's end.
                let gain = time < 0.01
                    ? floor * pow(peak / floor, time / 0.01)
                    : time < note.length ? peak * pow(floor / peak, (time - 0.01) / (note.length - 0.01)) : 0
                samples[start + index] += gain * sin(2 * .pi * note.frequency * time)
            }
        }
        var pcm = Data(capacity: samples.count * 2)
        for sample in samples {
            var value = Int16(max(-1, min(1, sample)) * 32767).littleEndian
            withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
        }
        var header = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { header.append(contentsOf: $0) }
        }
        header.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + pcm.count))
        header.append(contentsOf: Array("WAVEfmt ".utf8))
        append(UInt32(16))
        append(UInt16(1))
        append(UInt16(1))
        append(UInt32(rate))
        append(UInt32(rate * 2))
        append(UInt16(2))
        append(UInt16(16))
        header.append(contentsOf: Array("data".utf8))
        append(UInt32(pcm.count))
        return header + pcm
    }
}
