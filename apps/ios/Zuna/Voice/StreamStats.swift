import AVFoundation
import Foundation
import LiveKit
import ZunaModels

// What's really going out and coming in, for the stream stats. LiveKit reads WebRTC's
// running totals for a track once a second while asked to, so each reading is compared
// with the one before it. None of this runs unless the stats are open. The iPhone's
// counterpart of packages/ui/src/voice/stats.ts.

struct StatRow: Equatable, Identifiable {
    let label: String
    let value: String
    /// Something is holding this stream back.
    var warn = false

    var id: String { label }
}

struct StatSection: Equatable, Identifiable {
    enum Kind { case connection, video, audio }

    /// The frame rate to look at first, with how it's been lately.
    struct Headline: Equatable {
        let fps: Double?
        /// The rate frames are sent at, rather than decoded at.
        let sent: Bool
        let wanted: Int?
        let history: [Double]

        /// What the rate is, after the number: "fps sent of 60".
        var caption: String {
            switch (sent, wanted) {
            case let (true, wanted?): t("voice.stats.fpsSentOf", ["wanted": wanted])
            case (true, nil): t("voice.stats.fpsSent")
            case let (false, wanted?): t("voice.stats.fpsDecodedOf", ["wanted": wanted])
            case (false, nil): t("voice.stats.fpsDecoded")
            }
        }
    }

    let id: String
    let title: String
    let kind: Kind
    var headline: Headline?
    let rows: [StatRow]
}

/// Where this connection is, and everything going through it that can be read (`VoiceRoom.statsRoom`).
struct StatsRoom {
    struct Stream {
        let key: String
        let userId: String
        let local: Bool
        let source: Track.Source
        /// It comes from a native screen share on someone's computer.
        let native: Bool
        let track: Track
        let publication: TrackPublication
    }

    let url: String
    let serverVersion: String?
    let serverRegion: String?
    let serverNode: String?
    let people: Int
    let encrypted: Bool
    let keyIndex: Int32?
    let keyEpoch: Int?
    let streams: [Stream]
    /// Which way the call goes through the proxy set in Privacy, when one is.
    var proxy: String? = nil
}

/// This device's own share, as it was asked for.
struct StatsShare {
    /// How it goes out, in words.
    let through: String
    let terms: ScreenTerms
}

private let historyLength = 60
/// Packets lost, as a share of those sent, from where it starts to show.
private let noticeableLoss = 0.01

private func row(_ label: String, _ value: String?, warn: Bool = false) -> StatRow? {
    guard let value, !value.isEmpty else { return nil }
    return StatRow(label: label, value: value, warn: warn)
}

private func decimal(_ value: Double, _ digits: Int) -> String { String(format: "%.\(digits)f", value) }
private func fps(_ value: Double?) -> String? { value.map { t("voice.units.fps", ["value": decimal($0, 1)]) } }
private func ms(_ seconds: Double?, digits: Int = 1) -> String? { seconds.map { t("voice.units.ms", ["value": decimal($0 * 1000, digits)]) } }
private func bits(_ perSecond: Double?) -> String? {
    guard let perSecond else { return nil }
    return perSecond >= 1_000_000
        ? t("voice.units.mbitps", ["value": decimal(perSecond / 1_000_000, 1)])
        : t("voice.units.kbitps", ["value": Int((perSecond / 1000).rounded())])
}

private func size(_ width: UInt?, _ height: UInt?) -> String? {
    guard let width, let height, width > 0, height > 0 else { return nil }
    return "\(width)×\(height)"
}

private func count(_ value: (some BinaryInteger)?) -> String? {
    value.map { Int64($0).formatted(.number.locale(Locale(identifier: "en_US"))) }
}

private func seconds(_ value: Double?) -> String? { value.map { t("voice.units.seconds", ["value": decimal($0, 1)]) } }
private func percent(_ value: Double?) -> String? {
    value.map { "\(decimal($0 * 100, $0 > 0 && $0 < 0.1 ? 2 : 1))%" }
}

private func joined(_ parts: String?...) -> String { parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ") }
private func hardware(_ efficient: Bool?) -> String? { efficient.map { $0 ? t("voice.stats.hardware") : t("voice.stats.software") } }
/// Hardware decoders report nothing here, which comes through as zero.
private func quantizer(_ value: Double?) -> String? { value.flatMap { $0 > 0 ? decimal($0, 1) : nil } }
private func encryption(_ publication: TrackPublication) -> StatRow? {
    let encrypted = publication.encryptionType != .none
    return row(t("voice.stats.encryption"), encrypted ? t("voice.stats.endToEnd") : t("common.off"), warn: !encrypted)
}

/// How much each total has moved since the reading before.
private struct Movement<S: Statistics> {
    let now: S
    let before: S?

    /// LiveKit's timestamps are in microseconds.
    private var taken: Double { before.map { (now.timestamp - $0.timestamp) / 1_000_000 } ?? 0 }

    func change(_ path: KeyPath<S, (some BinaryInteger)?>) -> Double? {
        guard let before, taken > 0 else { return nil }
        return Double(now[keyPath: path] ?? 0) - Double(before[keyPath: path] ?? 0)
    }

    func change(_ path: KeyPath<S, Double?>) -> Double? {
        guard let before, taken > 0 else { return nil }
        return (now[keyPath: path] ?? 0) - (before[keyPath: path] ?? 0)
    }

    func perSecond(_ path: KeyPath<S, (some BinaryInteger)?>) -> Double? { change(path).map { $0 / taken } }

    /// One total over another, like the time spent decoding over the frames decoded.
    func each(_ total: KeyPath<S, Double?>, of items: KeyPath<S, (some BinaryInteger)?>) -> Double? {
        guard let moved = change(total), let items = change(items), items != 0 else { return nil }
        return moved / items
    }

    func each(_ total: KeyPath<S, (some BinaryInteger)?>, of items: KeyPath<S, (some BinaryInteger)?>) -> Double? {
        guard let moved = change(total), let items = change(items), items != 0 else { return nil }
        return moved / items
    }

    func bitsPerSecond(_ bytes: UInt64, before beforeBytes: UInt64?) -> Double? {
        guard let beforeBytes, taken > 0, bytes >= beforeBytes else { return nil }
        return Double(bytes - beforeBytes) * 8 / taken
    }
}

/// A count of lost packets can go down, when one that was given up on turns up after all.
private func lossOf(_ lost: Double?, _ received: Double?) -> Double? {
    guard let lost, let received else { return nil }
    let gone = max(0, lost)
    return gone + received > 0 ? gone / (gone + received) : nil
}

private func codecOf(_ statistics: TrackStatistics, _ codecId: String?) -> String? {
    guard let codec = statistics.codec.first(where: { $0.id == codecId }) else { return nil }
    return joined(codec.mimeType?.replacingOccurrences(of: #"^(video|audio)/"#, with: "", options: .regularExpression), codec.sdpFmtpLine)
}

private func titleOf(_ stream: StatsRoom.Stream, nameOf: (String) -> String) -> String {
    let (mine, theirs): (String, String) = switch stream.source {
    case .microphone: (mark("voice.stats.yourMicrophone"), mark("voice.stats.theirMicrophone"))
    case .camera: (mark("voice.stats.yourCamera"), mark("voice.stats.theirCamera"))
    case .screenShareVideo: (mark("voice.stage.yourScreen"), mark("voice.stage.theirScreen"))
    case .screenShareAudio: (mark("voice.stats.yourSound"), mark("voice.stats.theirSound"))
    default: (mark("voice.stats.yourStream"), mark("voice.stats.theirStream"))
    }
    return stream.local ? t(mine) : t(theirs, ["name": nameOf(stream.userId)])
}

/// How the microphone's sound is cleaned up before it goes out: by the system, which the desktop does itself.
@MainActor
private var micFilters: String {
    let audio = AudioManager.shared
    guard audio.isPlatformVoiceProcessingAllowed, !audio.isVoiceProcessingBypassed else { return t("voice.stats.nothing") }
    return AVCaptureDevice.activeMicrophoneMode == .voiceIsolation ? t("voice.stats.appleVoiceIsolation") : t("voice.stats.appleVoice")
}

/// Reads every stream while the stats are open, asking LiveKit for each track's statistics until it's closed.
@MainActor
final class StreamStats {
    private struct Reading {
        let statistics: TrackStatistics
        let section: StatSection?
    }

    /// The latest reading of each stream, which the next is compared with.
    private var readings: [String: Reading] = [:]
    private var histories: [String: [Double]] = [:]
    /// Tracks asked to report, with whatever they'd read before then, which is too old to show.
    private var asked: [ObjectIdentifier: (track: Track, stale: ObjectIdentifier?)] = [:]
    private var closed = false

    /// Stops the tracks reporting, unless they did before.
    func close() {
        closed = true
        for (track, _) in asked.values {
            Task { await track.set(reportStatistics: VoiceRoom.reportsStatistics) }
        }
        asked = [:]
    }

    /// `status` is how the connection is, in words, and `connected` whether that's as it should be.
    func read(_ room: StatsRoom, status: String, connected: Bool, share: StatsShare?, nameOf: (String) -> String) -> [StatSection] {
        guard !closed else { return [] }
        var fresh: [(stream: StatsRoom.Stream, statistics: TrackStatistics)] = []
        for stream in room.streams {
            let id = ObjectIdentifier(stream.track)
            guard let entry = asked[id] else {
                asked[id] = (stream.track, stream.track.statistics.map(ObjectIdentifier.init))
                Task { await stream.track.set(reportStatistics: true) }
                continue
            }
            if let statistics = stream.track.statistics, ObjectIdentifier(statistics) != entry.stale {
                fresh.append((stream, statistics))
            }
        }
        // What's being sent first, and pictures before sound, each person's camera before their screen, in an order
        // that holds from one reading to the next. A camera that's off stays published, with nothing in it to read.
        let rank = { (stream: StatsRoom.Stream) in (stream.local ? 0 : 1, stream.userId, stream.source == .screenShareVideo ? 1 : 0, stream.key) }
        fresh.sort { rank($0.stream) < rank($1.stream) }
        let isVideo = { (stream: StatsRoom.Stream) in stream.source == .camera || stream.source == .screenShareVideo }
        let videos = fresh.filter { isVideo($0.stream) && !$0.stream.publication.isMuted }.compactMap { section(for: $0.stream, $0.statistics, share: share, nameOf: nameOf) }
        let sounds = fresh.filter { !isVideo($0.stream) }.compactMap { section(for: $0.stream, $0.statistics, share: share, nameOf: nameOf) }
        let sending = fresh.first { $0.stream.local }?.statistics
        let receiving = fresh.first { !$0.stream.local }?.statistics
        let here = Set(room.streams.map(\.key))
        readings = readings.filter { here.contains($0.key) }
        histories = histories.filter { here.contains($0.key) }
        return videos + [connection(room, status: status, connected: connected, sending: sending, receiving: receiving)] + sounds
    }

    /// A stream's section from a reading it hasn't had before, or as it was if nothing new has come in since.
    private func section(for stream: StatsRoom.Stream, _ statistics: TrackStatistics, share: StatsShare?, nameOf: (String) -> String) -> StatSection? {
        let before = readings[stream.key]
        if let before, before.statistics === statistics { return before.section }
        let title = titleOf(stream, nameOf: nameOf)
        let previous = before?.statistics
        let made: StatSection? = switch (stream.source == .camera || stream.source == .screenShareVideo, stream.local) {
        case (true, true): sentVideo(stream, statistics, previous, title: title, share: share)
        case (true, false): receivedVideo(stream, statistics, previous, title: title)
        case (false, true): sentAudio(stream, statistics, previous, title: title)
        case (false, false): receivedAudio(stream, statistics, previous, title: title)
        }
        readings[stream.key] = Reading(statistics: statistics, section: made)
        return made
    }

    private func history(_ key: String, _ value: Double?) -> [Double] {
        var list = histories[key] ?? []
        if let value { list.append(value) }
        if list.count > historyLength { list.removeFirst(list.count - historyLength) }
        histories[key] = list
        return list
    }

    // MARK: The connection

    /// How one direction's packets travel. This device's own address is left out, for pasting this somewhere.
    private func path(_ statistics: TrackStatistics?, sending: Bool, allows: KeyPath<IceCandidatePairStatistics, Double?>) -> [StatRow] {
        guard let statistics else { return [] }
        let transport = statistics.transportStats
        let pair = statistics.iceCandidatePair.first { $0.id == transport?.selectedCandidatePairId } ?? statistics.iceCandidatePair.first { $0.nominated == true }
        let local = statistics.localIceCandidate.flatMap { $0.id == pair?.localCandidateId ? $0 : nil }
        let remote = statistics.remoteIceCandidate.flatMap { $0.id == pair?.remoteCandidateId ? $0 : nil }
        let port = remote?.port
        // WebRTC doesn't always say the address, and then says it's empty.
        let host = remote?.address.flatMap { $0.isEmpty ? nil : $0 }
        let address = host.map { "\($0):\(port.map(String.init) ?? "?")" } ?? port.map { t("voice.stats.port", ["port": $0]) }
        let kind = local?.candidateType
        let how = kind == .relay ? t("voice.stats.relayedOver", ["protocol": local?.relayProtocol?.rawValue ?? "TURN"]) : kind?.rawValue
        return [
            row(sending ? t("voice.stats.sendingPath") : t("voice.stats.receivingPath"), address.map { joined(local?.protocol?.uppercased(), how, t("voice.stats.to", ["address": $0])) }, warn: kind == .relay),
            row(sending ? t("voice.stats.sendingRoundTrip") : t("voice.stats.receivingRoundTrip"), ms(pair?.currentRoundTripTime, digits: 0)),
            row(sending ? t("voice.stats.sendingAllows") : t("voice.stats.receivingAllows"), bits(pair?[keyPath: allows])),
            row(sending ? t("voice.stats.sendingCipher") : t("voice.stats.receivingCipher"), transport?.srtpCipher),
        ].compactMap { $0 }
    }

    private func connection(_ room: StatsRoom, status: String, connected: Bool, sending: TrackStatistics?, receiving: TrackStatistics?) -> StatSection {
        let host = URL(string: room.url).flatMap { url in url.host.map { host in url.port.map { "\(host):\($0)" } ?? host } } ?? room.url
        let endToEnd = room.keyIndex.map { index in t("voice.stats.endToEndKey", ["key": index, "epoch": room.keyEpoch.map(String.init) ?? "?"]) } ?? t("voice.stats.endToEnd")
        let rows: [StatRow?] = [
            row(t("voice.stats.status"), status, warn: !connected),
            row(t("voice.stats.mediaServer"), host),
            row("LiveKit", joined(room.serverVersion, room.serverRegion, room.serverNode)),
            row(t("voice.stats.inRoom"), String(room.people)),
            row(t("voice.stats.encryption"), room.encrypted ? endToEnd : t("common.off"), warn: !room.encrypted),
            room.proxy.flatMap { row(t("voice.stats.proxy"), $0) },
        ]
        return StatSection(
            id: "connection",
            title: t("voice.stats.connection"),
            kind: .connection,
            rows: rows.compactMap { $0 } + path(sending, sending: true, allows: \.availableOutgoingBitrate) + path(receiving, sending: false, allows: \.availableIncomingBitrate)
        )
    }

    // MARK: Video going out

    private func sentVideo(_ stream: StatsRoom.Stream, _ statistics: TrackStatistics, _ previous: TrackStatistics?, title: String, share: StatsShare?) -> StatSection? {
        let layers = statistics.outboundRtpStream
        guard let rtp = layers.max(by: { ($0.frameWidth ?? 0) < ($1.frameWidth ?? 0) }) else { return nil }
        let moved = Movement(now: rtp, before: previous?.outboundRtpStream.first { $0.id == rtp.id })
        let bytes = layers.reduce(UInt64(0)) { $0 + ($1.bytesSent ?? 0) }
        let bytesBefore = previous.map { $0.outboundRtpStream.reduce(UInt64(0)) { $0 + ($1.bytesSent ?? 0) } }
        let capture = statistics.videoSource.first
        let remote = statistics.remoteInboundRtpStream.first { $0.localId == rtp.id }
        let share = stream.source == .screenShareVideo ? share : nil
        let sentFps = moved.perSecond(\.framesSent) ?? rtp.framesPerSecond
        let reason = rtp.qualityLimitationReason
        let durations = rtp.qualityLimitationDurations
        let limitedFor = [("cpu", durations?.cpu), ("bandwidth", durations?.bandwidth), ("other", durations?.other)]
            .compactMap { name, time in time.flatMap { $0 > 0.5 ? "\(name) \(t("voice.units.seconds", ["value": decimal($0, 0)]))" : nil } }
            .joined(separator: ", ")
        let lost = remote?.fractionLost
        let held: [String] = share.map { share in
            share.terms.held.map { limit -> String in
                switch limit {
                case .height: VoiceSettingsView.heightName(share.terms.height)
                case .fps: t("voice.units.fps", ["value": share.terms.fps])
                case .kbps: VoiceSettingsView.bitrateName(share.terms.kbps)
                }
            }
        } ?? []
        let rows: [StatRow?] = [
            row(t("voice.stats.encodedBy"), share?.through),
            row(t("voice.stats.requestedFromCapture"), share.map { share in
                share.terms.height > 0
                    ? t("voice.stats.fpsUpToLines", ["fps": share.terms.fps, "lines": share.terms.height])
                    : t("voice.units.fps", ["value": share.terms.fps])
            }),
            row(t("voice.stats.limitedByServer"), held.isEmpty ? nil : held.joined(separator: ", ")),
            row(t("voice.stats.capturing"), fps(capture?.framesPerSecond)),
            row(t("voice.stats.encoding"), fps(moved.perSecond(\.framesEncoded))),
            row(t("voice.stats.sending"), fps(sentFps)),
            row(t("voice.stats.picture"), joined(size(capture?.width, capture?.height), layers.count > 1 ? size(rtp.frameWidth, rtp.frameHeight).map { t("voice.stats.layers", ["size": $0, "layers": layers.count]) } : nil)),
            row(t("voice.stats.sentAs"), layers.count > 1 ? nil : size(rtp.frameWidth, rtp.frameHeight)),
            row(t("voice.stats.codec"), codecOf(statistics, rtp.codecId)),
            row(t("voice.stats.encoder"), joined(rtp.encoderImplementation, hardware(rtp.powerEfficientEncoder), rtp.scalabilityMode)),
            row(t("voice.stats.bitrate"), bits(moved.bitsPerSecond(bytes, before: bytesBefore))),
            row(t("voice.stats.maxBitrate"), share.flatMap { bits(Double($0.terms.kbps) * 1000) }),
            row(t("voice.stats.targetBitrate"), bits(rtp.targetBitrate)),
            row(t("voice.stats.encodeTime"), ms(moved.each(\.totalEncodeTime, of: \.framesEncoded))),
            row(t("voice.stats.quantizer"), quantizer(moved.each(\.qpSum, of: \.framesEncoded))),
            row(t("voice.stats.limitedBy"), reason.map { $0 == .none ? t("voice.stats.nothing") : $0.rawValue }, warn: reason != nil && reason != QualityLimitationReason.none),
            row(t("voice.stats.limitedSoFar"), limitedFor),
            row(t("voice.stats.lowerSizes"), (rtp.qualityLimitationResolutionChanges ?? 0) > 0 ? count(rtp.qualityLimitationResolutionChanges) : nil),
            row(t("voice.stats.keyframes"), joined(count(rtp.keyFramesEncoded), t("voice.stats.askedFor", ["count": count(rtp.pliCount) ?? "0"]), (moved.change(\.firCount) ?? 0) != 0 ? "\(count(rtp.firCount) ?? "0") FIR" : nil)),
            row(t("voice.stats.hugeFrames"), (rtp.hugeFramesSent ?? 0) > 0 ? count(rtp.hugeFramesSent) : nil),
            row(t("voice.stats.packets"), joined(count(rtp.packetsSent), t("voice.stats.sentAgain", ["count": count(rtp.retransmittedPacketsSent) ?? "0"]), "\(count(rtp.nackCount) ?? "0") NACK")),
            row(t("voice.stats.packetLoss"), percent(lost), warn: (lost ?? 0) > noticeableLoss),
            row(t("voice.stats.roundTrip"), ms(remote?.roundTripTime, digits: 0)),
            encryption(stream.publication),
        ]
        return StatSection(
            id: stream.key,
            title: title,
            kind: .video,
            headline: .init(fps: sentFps, sent: true, wanted: share?.terms.fps, history: history(stream.key, sentFps)),
            rows: rows.compactMap { $0 }
        )
    }

    // MARK: Video coming in

    private func receivedVideo(_ stream: StatsRoom.Stream, _ statistics: TrackStatistics, _ previous: TrackStatistics?, title: String) -> StatSection? {
        guard let rtp = statistics.inboundRtpStream.first else { return nil }
        let moved = Movement(now: rtp, before: previous?.inboundRtpStream.first { $0.id == rtp.id })
        let decoded = moved.perSecond(\.framesDecoded) ?? rtp.framesPerSecond
        let spacing: String? = {
            guard let frames = moved.change(\.framesDecoded), frames > 0,
                  let total = moved.change(\.totalInterFrameDelay), let squares = moved.change(\.totalSquaredInterFrameDelay) else { return nil }
            let mean = total / frames
            let spread = (max(0, (squares - total * total / frames) / frames)).squareRoot()
            return t("voice.stats.spacing", ["mean": ms(mean) ?? "", "spread": ms(spread) ?? ""])
        }()
        let dropping = moved.perSecond(\.framesDropped) ?? 0
        let loss = lossOf(moved.change(\.packetsLost), moved.change(\.packetsReceived))
        let rows: [StatRow?] = [
            row(t("voice.stats.encodedBy"), stream.source == .screenShareVideo && stream.native ? t("voice.stats.theirDesktopApp") : nil),
            row(t("voice.stats.receiving"), fps(moved.perSecond(\.framesReceived))),
            row(t("voice.stats.decoding"), fps(decoded)),
            row(t("voice.stats.framesDropped"), joined(count(rtp.framesDropped), dropping > 0 ? t("voice.stats.perSecond", ["count": decimal(dropping, 1)]) : nil), warn: dropping > 0),
            row(t("voice.stats.picture"), size(rtp.frameWidth, rtp.frameHeight)),
            row(t("voice.stats.codec"), codecOf(statistics, rtp.codecId)),
            row(t("voice.stats.decoder"), joined(rtp.decoderImplementation, hardware(rtp.powerEfficientDecoder))),
            row(t("voice.stats.bitrate"), bits(moved.bitsPerSecond(rtp.bytesReceived ?? 0, before: moved.before?.bytesReceived))),
            row(t("voice.stats.decodeTime"), ms(moved.each(\.totalDecodeTime, of: \.framesDecoded))),
            row(t("voice.stats.displayDelay"), ms(moved.each(\.totalProcessingDelay, of: \.framesDecoded))),
            row(t("voice.stats.quantizer"), quantizer(moved.each(\.qpSum, of: \.framesDecoded))),
            row(t("voice.stats.jitterBuffer"), ms(moved.each(\.jitterBufferDelay, of: \.jitterBufferEmittedCount))),
            row(t("voice.stats.targetBuffer"), ms(moved.each(\.jitterBufferTargetDelay, of: \.jitterBufferEmittedCount))),
            row(t("voice.stats.networkJitter"), ms(rtp.jitter)),
            row(t("voice.stats.frameSpacing"), spacing),
            row(t("voice.stats.freezes"), joined(count(rtp.freezeCount), seconds(rtp.totalFreezesDuration)), warn: (moved.change(\.freezeCount) ?? 0) > 0),
            row(t("voice.stats.pauses"), joined(count(rtp.pauseCount), seconds(rtp.totalPausesDuration))),
            row(t("voice.stats.keyframes"), joined(count(rtp.keyFramesDecoded), t("voice.stats.askedFor", ["count": count(rtp.pliCount) ?? "0"]), (moved.change(\.firCount) ?? 0) != 0 ? "\(count(rtp.firCount) ?? "0") FIR" : nil)),
            row(t("voice.stats.packets"), joined(count(rtp.packetsReceived), "\(count(rtp.nackCount) ?? "0") NACK", t("voice.stats.resent", ["count": count(rtp.retransmittedPacketsReceived) ?? "0"]))),
            row(t("voice.stats.lost"), joined(count(rtp.packetsLost), percent(loss)), warn: (loss ?? 0) > noticeableLoss),
            encryption(stream.publication),
        ]
        return StatSection(
            id: stream.key,
            title: title,
            kind: .video,
            headline: .init(fps: decoded, sent: false, wanted: nil, history: history(stream.key, decoded)),
            rows: rows.compactMap { $0 }
        )
    }

    // MARK: Sound

    private func sentAudio(_ stream: StatsRoom.Stream, _ statistics: TrackStatistics, _ previous: TrackStatistics?, title: String) -> StatSection? {
        guard let rtp = statistics.outboundRtpStream.first else { return nil }
        let moved = Movement(now: rtp, before: previous?.outboundRtpStream.first { $0.id == rtp.id })
        let remote = statistics.remoteInboundRtpStream.first
        let lost = remote?.fractionLost
        let rows: [StatRow?] = [
            row(t("voice.stats.muted"), stream.publication.isMuted ? t("voice.stats.yes") : nil),
            row(t("voice.stats.processing"), stream.source == .microphone ? micFilters : nil),
            row(t("voice.stats.codec"), codecOf(statistics, rtp.codecId)),
            row(t("voice.stats.bitrate"), bits(moved.bitsPerSecond(rtp.bytesSent ?? 0, before: moved.before?.bytesSent))),
            row(t("voice.stats.targetBitrate"), bits(rtp.targetBitrate)),
            row(t("voice.stats.packets"), count(rtp.packetsSent)),
            row(t("voice.stats.packetLoss"), percent(lost), warn: (lost ?? 0) > noticeableLoss),
            row(t("voice.stats.roundTrip"), ms(remote?.roundTripTime, digits: 0)),
            encryption(stream.publication),
        ]
        return StatSection(id: stream.key, title: title, kind: .audio, rows: rows.compactMap { $0 })
    }

    private func receivedAudio(_ stream: StatsRoom.Stream, _ statistics: TrackStatistics, _ previous: TrackStatistics?, title: String) -> StatSection? {
        guard let rtp = statistics.inboundRtpStream.first else { return nil }
        let moved = Movement(now: rtp, before: previous?.inboundRtpStream.first { $0.id == rtp.id })
        // What's made up over silence, as while they're muted or quiet with DTX, is comfort
        // noise, not a gap anyone hears.
        let samples = moved.change(\.totalSamplesReceived) ?? 0
        let concealed: Double? = samples > 0 ? max(0, (moved.change(\.concealedSamples) ?? 0) - (moved.change(\.silentConcealedSamples) ?? 0)) / samples : nil
        let muted = stream.publication.isMuted
        let loss = lossOf(moved.change(\.packetsLost), moved.change(\.packetsReceived))
        let rows: [StatRow?] = [
            row(t("voice.stats.muted"), muted ? t("voice.stats.yes") : nil),
            row(t("voice.stats.codec"), codecOf(statistics, rtp.codecId)),
            row(t("voice.stats.bitrate"), bits(moved.bitsPerSecond(rtp.bytesReceived ?? 0, before: moved.before?.bytesReceived))),
            row(t("voice.stats.jitterBuffer"), ms(moved.each(\.jitterBufferDelay, of: \.jitterBufferEmittedCount))),
            row(t("voice.stats.networkJitter"), ms(rtp.jitter)),
            row(t("voice.stats.concealed"), percent(concealed), warn: !muted && (concealed ?? 0) > noticeableLoss),
            row(t("voice.stats.packets"), count(rtp.packetsReceived)),
            row(t("voice.stats.lost"), joined(count(rtp.packetsLost), percent(loss)), warn: (loss ?? 0) > noticeableLoss),
            encryption(stream.publication),
        ]
        return StatSection(id: stream.key, title: title, kind: .audio, rows: rows.compactMap { $0 })
    }

    /// The headline as a line of text: "sent: 59.8 fps (wanted 60)".
    private static func headlineText(_ headline: StatSection.Headline) -> String {
        let rate = fps(headline.fps) ?? "?"
        return switch (headline.sent, headline.wanted) {
        case let (true, wanted?): t("voice.stats.copySentOf", ["fps": rate, "wanted": wanted])
        case (true, nil): t("voice.stats.copySent", ["fps": rate])
        case let (false, wanted?): t("voice.stats.copyDecodedOf", ["fps": rate, "wanted": wanted])
        case (false, nil): t("voice.stats.copyDecoded", ["fps": rate])
        }
    }

    /// All of it as text, for pasting somewhere.
    static func asText(_ sections: [StatSection]) -> String {
        sections.map { section in
            let headline = section.headline.map { [headlineText($0)] } ?? []
            return (["# \(section.title)"] + headline + section.rows.map { "\($0.label): \($0.value)\($0.warn ? "  (!)" : "")" }).joined(separator: "\n")
        }
        .joined(separator: "\n\n")
    }
}
