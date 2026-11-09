import AVFoundation
import UniformTypeIdentifiers
import ZunaModels

/// A video sent in a message, played as it comes, as in Telegram, rather than once all of it is
/// here: AVPlayer asks for the bytes it needs, and the chunks that hold them are fetched and
/// decrypted through the core (`downloadChunk`), a few ahead of where it reads. They're kept in
/// one file in the decrypted cache, which once whole is the video's, for Share and for playing
/// it again.
final class VideoStream: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    /// What each chunk holds but the last: the core's `CHUNK_SIZE` (packages/core/src/session/shared.ts).
    static let chunkSize = 1 << 20
    /// Chunks on their way at once ahead of where AVPlayer reads, as the core downloads a file (`UPLOAD_CONCURRENCY`).
    private static let ahead = 3

    enum Failure: LocalizedError {
        case malformed
        var errorDescription: String? { "This video isn't what it should be." }
    }

    let attachment: Attachment
    private let chunks: ChunkStore
    private let queue = DispatchQueue(label: "chat.zuna.video-stream")
    /// AVPlayer's requests being answered, which it may call off. Only touched on `queue`.
    private var answering: [ObjectIdentifier: Task<Void, Never>] = [:]
    private let lock = NSLock()
    /// Fetching all of it, in order, beside what's playing.
    private var filling: Task<URL, Error>?

    /// Nil for a file whose size and chunks don't agree, which plays once all of it is here.
    init?(_ attachment: Attachment, session: SessionCalls) {
        guard attachment.size > 0, attachment.chunks == (attachment.size + Self.chunkSize - 1) / Self.chunkSize else { return nil }
        self.attachment = attachment
        chunks = ChunkStore(attachment, session: session)
    }

    /// An asset that reads through this stream. AVFoundation holds its loader's delegate weakly, so this has to be kept.
    func asset() -> AVURLAsset {
        let asset = AVURLAsset(url: URL(string: "zuna-video://file/\(attachment.fileId)")!)
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    /// All of it, for Share and to play again: fetched in order beside what's playing.
    func whole() async throws -> URL {
        let task = lock.withLock {
            if let filling { return filling }
            let task = Task { [chunks] in try await chunks.fill() }
            filling = task
            return task
        }
        do {
            return try await task.value
        } catch {
            lock.withLock { if filling == task { filling = nil } }
            throw error
        }
    }

    /// Stops fetching what nothing's waiting for, as the video closes. What's here stays for next time.
    func pause() {
        lock.withLock {
            filling?.cancel()
            filling = nil
        }
    }

    // MARK: AVAssetResourceLoaderDelegate

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        let id = ObjectIdentifier(loadingRequest)
        let request = Request(value: loadingRequest)
        // Its end is heard on this queue after this returns, so it's always there to remove.
        answering[id] = Task { [weak self] in
            guard let self else { return }
            await answer(request)
            queue.async { self.answering[id] = nil }
        }
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest) {
        answering.removeValue(forKey: ObjectIdentifier(loadingRequest))?.cancel()
    }

    private struct Request: @unchecked Sendable {
        let value: AVAssetResourceLoadingRequest
    }

    /// What it is and how big, then the bytes asked for, a chunk at a time as each comes.
    private func answer(_ request: Request) async {
        let loading = request.value
        if let info = loading.contentInformationRequest {
            info.contentType = UTType(mimeType: attachment.mime)?.identifier ?? AVFileType.mp4.rawValue
            info.contentLength = Int64(attachment.size)
            info.isByteRangeAccessSupported = true
        }
        guard let data = loading.dataRequest else {
            loading.finishLoading()
            return
        }
        let size = attachment.size
        let end = data.requestsAllDataToEndOfResource ? size : min(size, Int(data.requestedOffset) + data.requestedLength)
        var offset = Int(data.currentOffset)
        do {
            while offset < end {
                try Task.checkCancellation()
                let index = offset / Self.chunkSize
                // The next few are on their way while this one plays.
                await chunks.prefetch(index + 1 ..< min(index + Self.ahead, attachment.chunks))
                let chunk = try await chunks.chunk(index)
                try Task.checkCancellation()
                let start = offset - index * Self.chunkSize
                let stop = min(chunk.count, end - index * Self.chunkSize)
                guard start < stop else { throw Failure.malformed }
                data.respond(with: chunk.subdata(in: start ..< stop))
                offset += stop - start
            }
            loading.finishLoading()
        } catch is CancellationError {
            // AVPlayer called it off, and doesn't want to hear any more of it.
        } catch {
            loading.finishLoading(with: error)
        }
    }
}

/// The chunks of one video fetched so far, in one file the size of the whole in the decrypted
/// cache, and those on their way, each fetched once whoever asks for it.
private actor ChunkStore {
    private let attachment: Attachment
    private let session: SessionCalls
    private var file: URL?
    private var handle: FileHandle?
    private var here = Set<Int>()
    private var fetching: [Int: Task<Data, Error>] = [:]

    init(_ attachment: Attachment, session: SessionCalls) {
        self.attachment = attachment
        self.session = session
    }

    func chunk(_ index: Int) async throws -> Data {
        if here.contains(index) { return try read(index) }
        return try await (fetching[index] ?? fetch(index)).value
    }

    func prefetch(_ indices: Range<Int>) {
        for index in indices where !here.contains(index) && fetching[index] == nil {
            _ = fetch(index)
        }
    }

    /// All of it, in order, a chunk ahead, as it plays.
    func fill() async throws -> URL {
        for index in 0 ..< attachment.chunks {
            try Task.checkCancellation()
            prefetch(index + 1 ..< min(index + 2, attachment.chunks))
            _ = try await chunk(index)
        }
        guard let file, let handle else { throw VideoStream.Failure.malformed }
        try handle.synchronize()
        return file
    }

    private func fetch(_ index: Int) -> Task<Data, Error> {
        let task = Task { try await self.keep(index) }
        fetching[index] = task
        return task
    }

    /// Fetches a chunk through the core, which checks it's the one in that place, and keeps it.
    private func keep(_ index: Int) async throws -> Data {
        defer { fetching[index] = nil }
        let part = URL(fileURLWithPath: try await session.downloadChunk(attachment, index: index).path)
        defer { try? FileManager.default.removeItem(at: part) }
        let data = try Data(contentsOf: part)
        let last = index == attachment.chunks - 1
        guard data.count == (last ? attachment.size - index * VideoStream.chunkSize : VideoStream.chunkSize) else { throw VideoStream.Failure.malformed }
        let handle = try handle ?? open(beside: part)
        try handle.seek(toOffset: UInt64(index * VideoStream.chunkSize))
        try handle.write(contentsOf: data)
        here.insert(index)
        return data
    }

    /// The video's file, beside the core's chunk in the decrypted cache, which is emptied as the app starts.
    private func open(beside part: URL) throws -> FileHandle {
        let url = part.deletingLastPathComponent().appendingPathComponent("video-\(UUID().uuidString).\(part.pathExtension)")
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let handle = try FileHandle(forUpdating: url)
        try handle.truncate(atOffset: UInt64(attachment.size))
        file = url
        self.handle = handle
        return handle
    }

    private func read(_ index: Int) throws -> Data {
        guard let handle else { throw VideoStream.Failure.malformed }
        let length = min(VideoStream.chunkSize, attachment.size - index * VideoStream.chunkSize)
        try handle.seek(toOffset: UInt64(index * VideoStream.chunkSize))
        return try handle.read(upToCount: length) ?? Data()
    }
}
