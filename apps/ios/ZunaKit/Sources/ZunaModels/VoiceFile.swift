import Foundation

// Voice messages as files. Chromium's MediaRecorder writes MP4 in fragments, and gives
// the last sample of each a duration of its own reckoning, 1008 at 48 kHz, whatever
// the sample holds. For AAC's frames of 1024 that's nothing, but Opus comes in 60 ms
// packets of 2880, so a voice message from the Linux desktop (Opus, as Chromium has no
// AAC encoder there) adds up to an eighth shorter than its sound. AVFoundation goes by
// those durations, and stops playing it that much early.

public enum VoiceFile {
    /// The file with each Opus sample's duration taken from its packet, or nil when it
    /// isn't Opus in fragmented MP4, can't be read as such, or has nothing to put right.
    public static func fixingOpusDurations(_ file: Data) -> Data? {
        var bytes = [UInt8](file)
        guard let top = boxes(bytes, 0, bytes.count),
              let moov = top.first(where: { $0.type == "moov" }),
              let timescale = opusTimescale(bytes, moov) else { return nil }
        var changed = false
        for moof in top where moof.type == "moof" {
            guard let trafs = boxes(bytes, moof.body, moof.end)?.filter({ $0.type == "traf" }) else { return nil }
            for traf in trafs {
                guard let fixed = fixFragment(&bytes, moof: moof, traf: traf, only: trafs.count == 1, timescale: timescale) else { return nil }
                changed = changed || fixed
            }
        }
        return changed ? Data(bytes) : nil
    }

    private struct Box {
        let type: String
        let start: Int
        let body: Int
        let end: Int
    }

    /// The boxes from one offset to another, or nil if one runs past the end.
    private static func boxes(_ bytes: [UInt8], _ from: Int, _ to: Int) -> [Box]? {
        var list: [Box] = []
        var at = from
        while at < to {
            guard to - at >= 8 else { return nil }
            var size = Int(u32(bytes, at))
            var body = at + 8
            if size == 1 {
                guard to - at >= 16 else { return nil }
                let large = u64(bytes, at + 8)
                guard large <= UInt64(to - at) else { return nil }
                size = Int(large)
                body = at + 16
            } else if size == 0 {
                size = to - at
            }
            guard size >= body - at, size <= to - at else { return nil }
            list.append(Box(type: String(decoding: bytes[(at + 4)..<(at + 8)], as: UTF8.self), start: at, body: body, end: at + size))
            at += size
        }
        return list
    }

    private static func child(_ bytes: [UInt8], _ box: Box, _ type: String, skipping: Int = 0) -> Box? {
        guard box.body + skipping <= box.end else { return nil }
        return boxes(bytes, box.body + skipping, box.end)?.first { $0.type == type }
    }

    /// The timescale of a file's one track, if that's Opus.
    private static func opusTimescale(_ bytes: [UInt8], _ moov: Box) -> UInt32? {
        guard let traks = boxes(bytes, moov.body, moov.end)?.filter({ $0.type == "trak" }), traks.count == 1,
              let mdia = child(bytes, traks[0], "mdia"),
              let mdhd = child(bytes, mdia, "mdhd"),
              let minf = child(bytes, mdia, "minf"),
              let stbl = child(bytes, minf, "stbl"),
              let stsd = child(bytes, stbl, "stsd"),
              // Its version, flags and count come before its entries.
              child(bytes, stsd, "Opus", skipping: 8) != nil,
              mdhd.body < mdhd.end else { return nil }
        let at = mdhd.body + (bytes[mdhd.body] == 1 ? 20 : 12)
        guard at + 4 <= mdhd.end else { return nil }
        let timescale = u32(bytes, at)
        return timescale > 0 ? timescale : nil
    }

    /// Puts one fragment's durations right: whether it changed any, or nil if it can't be read.
    private static func fixFragment(_ bytes: inout [UInt8], moof: Box, traf: Box, only: Bool, timescale: UInt32) -> Bool? {
        guard let parts = boxes(bytes, traf.body, traf.end), let tfhd = parts.first(where: { $0.type == "tfhd" }),
              tfhd.body + 8 <= tfhd.end else { return nil }
        let headerFlags = u32(bytes, tfhd.body) & 0xFFFFFF
        var at = tfhd.body + 8
        var base = moof.start
        if headerFlags & 0x1 != 0 {
            guard at + 8 <= tfhd.end, u64(bytes, at) <= UInt64(bytes.count) else { return nil }
            base = Int(u64(bytes, at))
            at += 8
        } else if headerFlags & 0x20000 == 0 && !only {
            // Its data would follow the track before's, which nothing here writes.
            return nil
        }
        if headerFlags & 0x2 != 0 { at += 4 }
        if headerFlags & 0x8 != 0 { at += 4 }
        var defaultSize: Int?
        if headerFlags & 0x10 != 0 {
            guard at + 4 <= tfhd.end else { return nil }
            defaultSize = Int(u32(bytes, at))
        }

        var changed = false
        for trun in parts where trun.type == "trun" {
            guard trun.body + 8 <= trun.end else { return nil }
            let flags = u32(bytes, trun.body) & 0xFFFFFF
            let count = Int(u32(bytes, trun.body + 4))
            // Durations from a default are all the same, so there's nothing of Chromium's to put right.
            guard flags & 0x100 != 0 else { continue }
            guard flags & 0x1 != 0, trun.body + 12 <= trun.end else { return nil }
            var sample = base + Int(Int32(bitPattern: u32(bytes, trun.body + 8)))
            var entry = trun.body + 12 + (flags & 0x4 != 0 ? 4 : 0)
            let fields = [0x100, 0x200, 0x400, 0x800].filter { flags & UInt32($0) != 0 }.count
            guard count <= (trun.end - entry) / (fields * 4) else { return nil }
            for _ in 0..<count {
                let durationAt = entry
                entry += 4
                var size = defaultSize
                if flags & 0x200 != 0 {
                    size = Int(u32(bytes, entry))
                    entry += 4
                }
                entry += (flags & 0x400 != 0 ? 4 : 0) + (flags & 0x800 != 0 ? 4 : 0)
                guard let size, size > 0, sample >= 0, size <= bytes.count - sample,
                      let samples = packetSamples(bytes, sample, size) else { return nil }
                let duration = UInt32(UInt64(samples) * UInt64(timescale) / 48_000)
                if u32(bytes, durationAt) != duration {
                    put(&bytes, durationAt, duration)
                    changed = true
                }
                sample += size
            }
        }
        return changed
    }

    /// How many samples at 48 kHz an Opus packet holds, from its first byte or two (RFC 6716, 3.1).
    private static func packetSamples(_ bytes: [UInt8], _ at: Int, _ size: Int) -> Int? {
        let toc = bytes[at]
        let config = Int(toc >> 3)
        let frame = config < 12 ? [480, 960, 1920, 2880][config % 4]
            : config < 16 ? [480, 960][config % 2]
            : [120, 240, 480, 960][config % 4]
        let frames: Int
        switch toc & 0x3 {
        case 0: frames = 1
        case 1, 2: frames = 2
        default:
            guard size >= 2 else { return nil }
            frames = Int(bytes[at + 1] & 0x3F)
        }
        // A packet is at most 120 ms.
        guard frames > 0, frame * frames <= 5760 else { return nil }
        return frame * frames
    }

    private static func u32(_ bytes: [UInt8], _ at: Int) -> UInt32 {
        UInt32(bytes[at]) << 24 | UInt32(bytes[at + 1]) << 16 | UInt32(bytes[at + 2]) << 8 | UInt32(bytes[at + 3])
    }

    private static func u64(_ bytes: [UInt8], _ at: Int) -> UInt64 {
        UInt64(u32(bytes, at)) << 32 | UInt64(u32(bytes, at + 4))
    }

    private static func put(_ bytes: inout [UInt8], _ at: Int, _ value: UInt32) {
        for index in 0..<4 { bytes[at + index] = UInt8(truncatingIfNeeded: value >> (24 - 8 * index)) }
    }
}
