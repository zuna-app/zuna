import AVFoundation
import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import ZunaModels

/// Something picked in the attach menu's grid: a photo or video in the library, or one just taken.
enum AttachPick: Hashable {
    case asset(String)
    case taken(URL)
}

/// The attach menu, laid out as Telegram's: the camera, then this phone's photos and
/// videos, newest first, numbered in the order they're picked, with a caption and Send
/// once some are, and tabs below for files and this device's location. What Telegram
/// has there and Zuna doesn't, such as polls and contacts, isn't.
struct AttachSheet: View {
    let serverId: String
    let conversation: ConversationView
    /// What's written in the message box, which goes as the caption, as in Telegram.
    @Binding var caption: String
    /// How many more files the message can take, as some may wait in the message box already.
    let room: Int
    /// Puts files in the message box and sends it, as its Send does.
    let send: ([URL]) async -> Void
    /// Puts files in the message box, to send from there; scoped for ones from Files.
    let stage: (_ urls: [URL], _ scoped: Bool) async -> Void
    let paste: () -> Void

    enum Page: Hashable { case gallery, file, location }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Namespace private var tabs
    @State private var page = Page.gallery
    @State private var library = PhotoLibrary()
    /// The photos and videos picked, in the order they were.
    @State private var picked: [AttachPick] = []
    /// What the camera took here, newest first, shown after it in the grid.
    @State private var taken: [URL] = []
    @State private var feed = CameraFeed()
    @State private var shooting = false
    @State private var cameraProblem: String?
    @State private var sending = false
    @State private var choosingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var choosingFiles = false

    #if DEBUG
    /// UI tests take a made-up picture instead: the simulator has no camera.
    private var fakeCamera: Bool { VoiceTesting.fakeCamera }
    #else
    private var fakeCamera: Bool { false }
    #endif

    /// A phone without a camera, such as the simulator, shows no tile for it, as Telegram doesn't.
    private var hasCamera: Bool { fakeCamera || UIImagePickerController.isSourceTypeAvailable(.camera) }

    /// The camera's tile shows what it sees, unless something else has the camera.
    private var previewing: Bool { hasCamera && !fakeCamera && page == .gallery && !shooting && !model.voice.inCall }

    var body: some View {
        NavigationStack {
            Group {
                switch page {
                case .gallery:
                    GalleryPage(
                        library: library,
                        picked: $picked,
                        taken: taken,
                        room: room,
                        camera: hasCamera ? (previewing ? .live(feed) : .still) : nil,
                        openCamera: { Task { await openCamera() } },
                        choosePhotos: { choosingPhotos = true }
                    )
                case .file:
                    filePage
                case .location:
                    AttachLocationPage(serverId: serverId, conversationKey: conversation.key)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if picked.isEmpty { tabBar } else { captionBar }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(sending) }
                ToolbarItem(placement: .principal) { title }.withoutSharedBackground()
            }
        }
        .presentationDetents([.medium, .large])
        .presentationContentInteraction(.resizes)
        .presentationBackground(Theme.bg1)
        .interactiveDismissDisabled(sending)
        .animation(.snappy(duration: 0.25), value: picked.isEmpty)
        .task { await library.start() }
        // The camera only runs while its tile can be seen, and lets go of it for the camera itself.
        .task(id: previewing) {
            if previewing { feed.start() } else { feed.stop() }
        }
        .onDisappear { feed.stop() }
        .fullScreenCover(isPresented: $shooting) {
            CameraPicker { url in
                shooting = false
                if let url { add(url) }
            }
            .ignoresSafeArea()
        }
        .alert(cameraProblem ?? "", isPresented: Binding(get: { cameraProblem != nil }, set: { if !$0 { cameraProblem = nil } })) {
            Button("OK", role: .cancel) {}
        }
        .photosPicker(isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: max(1, room), matching: .any(of: [.images, .videos]))
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            dismiss()
            Task {
                var urls: [URL] = []
                for item in items {
                    if let media = try? await item.loadTransferable(type: PickedMedia.self) { urls.append(media.url) }
                }
                await stage(urls, false)
            }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            dismiss()
            Task { await stage(urls, true) }
        }
        .accessibilityIdentifier(A11y.Attach.sheet)
    }

    // MARK: Title

    @ViewBuilder
    private var title: some View {
        switch page {
        case .gallery where library.allowed && !library.albums.isEmpty:
            // Which album the grid shows, as Telegram's Recents.
            Menu {
                Button("Recents") { library.album = nil }
                ForEach(library.albums) { album in
                    Button(album.title) { library.album = album }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(library.album?.title ?? "Recents").font(.headline).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold))
                }
                .foregroundStyle(Theme.text1)
            }
            .accessibilityIdentifier(A11y.Attach.albums)
        case .gallery:
            Text("Gallery").font(.headline).foregroundStyle(Theme.text1)
        case .file:
            Text("File").font(.headline).foregroundStyle(Theme.text1)
        case .location:
            Text("Location").font(.headline).foregroundStyle(Theme.text1)
        }
    }

    // MARK: Tabs

    private var tabBar: some View {
        HStack(spacing: 0) {
            tab(.gallery, "Gallery", "photo.fill")
            tab(.file, "File", "doc.fill")
            tab(.location, "Location", "location.fill")
        }
        .padding(4)
        .glassCapsule(interactive: false)
        .padding(.horizontal, 40)
        .padding(.bottom, 8)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func tab(_ which: Page, _ label: String, _ icon: String) -> some View {
        let selected = page == which
        return Button {
            withAnimation(.snappy(duration: 0.25)) { page = which }
        } label: {
            VStack(spacing: 2) {
                Image(systemName: icon).font(.system(size: 18)).frame(height: 24)
                Text(label).font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(selected ? model.settings.accent.text : Theme.text2)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background {
                if selected {
                    Capsule().fill(Color.white.opacity(0.1)).matchedGeometryEffect(id: "tab", in: tabs)
                }
            }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(A11y.Attach.tab(label))
    }

    // MARK: Caption and Send

    /// In place of the tabs once something's picked, as in Telegram.
    private var captionBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Add a caption…", text: $caption, axis: .vertical)
                .lineLimit(1...5)
                .font(.body)
                .foregroundStyle(Theme.text1)
                .padding(.vertical, 8)
                .padding(.horizontal, 14)
                .background(Theme.bg2, in: .rect(cornerRadius: 19, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(Theme.line))
                .accessibilityLabel("Caption")
                .accessibilityIdentifier(A11y.Attach.caption)
            Button(action: sendPicked) {
                ZStack {
                    if sending {
                        ProgressView().tint(model.settings.accent.onAccent)
                    } else {
                        Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
                    }
                }
                .foregroundStyle(model.settings.accent.onAccent)
                .frame(width: 36, height: 36)
                .background(model.settings.accent.color, in: .circle)
                .overlay(alignment: .topTrailing) {
                    Text("\(picked.count)")
                        .font(.system(size: 11, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(model.settings.accent.onAccent)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(model.settings.accent.color, in: .capsule)
                        .overlay(Capsule().stroke(Theme.bg1, lineWidth: 2))
                        .offset(x: 6, y: -6)
                        .contentTransition(.numericText())
                }
            }
            .buttonStyle(.plain)
            .disabled(sending)
            .padding(.bottom, 1)
            .accessibilityLabel(picked.count == 1 ? "Send 1 item" : "Send \(picked.count) items")
            .accessibilityIdentifier(A11y.Attach.send)
        }
        .padding(.leading, 8)
        // Room for the count, which stands out past Send.
        .padding(.trailing, 14)
        .padding(.vertical, 6)
        .background(Theme.bg1)
        .overlay(alignment: .top) { Divider().overlay(Theme.line) }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    /// Copies what's picked out of the library and sends it with the caption, which may take a moment for what's only in iCloud.
    private func sendPicked() {
        sending = true
        let picks = picked
        Task {
            var urls: [URL] = []
            for pick in picks {
                switch pick {
                case let .asset(id):
                    do {
                        urls.append(try await PhotoLibrary.export(id))
                    } catch {
                        model.toast("Couldn't add a photo or video: \(error.localizedDescription)", .error)
                    }
                case let .taken(url):
                    urls.append(url)
                }
            }
            guard !urls.isEmpty else {
                sending = false
                return
            }
            await send(urls)
            dismiss()
        }
    }

    // MARK: Camera

    /// The system's camera, for a photo or a video, asking for it the first time.
    private func openCamera() async {
        // A call has the camera and the microphone, as for video messages.
        if model.voice.inCall {
            cameraProblem = "You can't use the camera during a call."
            return
        }
        #if DEBUG
        if fakeCamera {
            if let url = CameraPicker.fakePhoto() { add(url) }
            return
        }
        #endif
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { return }
        case .denied, .restricted:
            cameraProblem = RoundRecorder.Failure.camera.errorDescription
            return
        default:
            break
        }
        shooting = true
    }

    /// What the camera took goes first after it in the grid, picked, as Telegram's does.
    private func add(_ url: URL) {
        withAnimation(.snappy(duration: 0.25)) {
            taken.insert(url, at: 0)
            if picked.count < room { picked.append(.taken(url)) }
        }
    }

    // MARK: File

    private var filePage: some View {
        ScrollView {
            VStack(spacing: 0) {
                fileRow("Choose from Photos", "photo.on.rectangle", A11y.Attach.photos) { choosingPhotos = true }
                Divider().overlay(Theme.line).padding(.leading, 60)
                fileRow("Choose from Files", "folder", A11y.Attach.files) { choosingFiles = true }
                if UIPasteboard.general.hasImages {
                    Divider().overlay(Theme.line).padding(.leading, 60)
                    fileRow("Paste image", "doc.on.clipboard", A11y.Attach.paste) {
                        paste()
                        dismiss()
                    }
                }
            }
            .background(Theme.bg2, in: .rect(cornerRadius: 12))
            .padding(16)
        }
    }

    private func fileRow(_ label: String, _ icon: String, _ id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(model.settings.accent.onAccent)
                    .frame(width: 32, height: 32)
                    .background(model.settings.accent.color, in: .rect(cornerRadius: 8, style: .continuous))
                Text(label).foregroundStyle(model.settings.accent.text)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

// MARK: Gallery

/// The camera's tile: what it sees, or only its icon while something else has it.
private enum CameraShown {
    case live(CameraFeed)
    case still

    var feed: CameraFeed? {
        if case let .live(feed) = self { feed } else { nil }
    }
}

/// The grid: the camera, what it took, then the library's photos and videos, or why there are none.
private struct GalleryPage: View {
    let library: PhotoLibrary
    @Binding var picked: [AttachPick]
    let taken: [URL]
    let room: Int
    /// The camera's tile, where the phone has a camera.
    let camera: CameraShown?
    let openCamera: () -> Void
    /// The system's photo picker, which needs no access to the library.
    let choosePhotos: () -> Void

    /// Three across on a phone, as Telegram's, and more on an iPad.
    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

    var body: some View {
        if library.status == .notDetermined {
            Color.clear
        } else {
            grid
        }
    }

    private var grid: some View {
        ScrollView {
            if library.status == .limited {
                HStack(spacing: 12) {
                    Text("You've let Zuna see only some of your photos.")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                    Spacer(minLength: 0)
                    Button("Manage") { library.manage() }
                        .font(.footnote.weight(.semibold))
                        .accessibilityIdentifier(A11y.Attach.manage)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            LazyVGrid(columns: columns, spacing: 2) {
                if let camera {
                    CameraTile(feed: camera.feed, open: openCamera)
                }
                ForEach(Array(taken.enumerated()), id: \.element) { index, url in
                    let number = number(.taken(url))
                    TakenTile(url: url, number: number, full: number == nil && picked.count >= room) {
                        toggle(.taken(url))
                    }
                    .accessibilityIdentifier(A11y.Attach.taken(index))
                }
                if library.allowed {
                    ForEach(0..<library.assets.count, id: \.self) { index in
                        let asset = library.assets.object(at: index)
                        let number = number(.asset(asset.localIdentifier))
                        GalleryTile(asset: asset, number: number, full: number == nil && picked.count >= room) {
                            toggle(.asset(asset.localIdentifier))
                        }
                        .accessibilityIdentifier(A11y.Attach.tile(index))
                    }
                }
            }
            if !library.allowed {
                denied
            } else if library.assets.count == 0 {
                Text(library.status == .limited ? "No photos or videos picked for Zuna yet." : "No photos or videos.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .padding(.top, 24)
            }
        }
        .sensoryFeedback(.selection, trigger: picked)
    }

    private func number(_ pick: AttachPick) -> Int? {
        picked.firstIndex(of: pick).map { $0 + 1 }
    }

    private func toggle(_ pick: AttachPick) {
        if let index = picked.firstIndex(of: pick) {
            picked.remove(at: index)
        } else if picked.count < room {
            picked.append(pick)
        }
    }

    private var denied: some View {
        VStack(spacing: 12) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 40))
                .foregroundStyle(Theme.text3)
            Text("Zuna can't see your photos")
                .font(.headline)
                .foregroundStyle(Theme.text1)
            Text("Allow it in Settings to pick them here, or choose some in Photos' own picker, which needs no access.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.text2)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            .font(.subheadline.weight(.semibold))
            .padding(.top, 4)
            Button("Choose from Photos", action: choosePhotos)
                .font(.subheadline.weight(.semibold))
                .accessibilityIdentifier(A11y.Attach.photos)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }
}

/// The grid's first square, as Telegram's: what the camera sees, once Zuna may use it, and a tap opens it.
private struct CameraTile: View {
    let feed: CameraFeed?
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            Theme.bg3
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let feed, feed.running {
                        CameraPreview(preview: feed.preview)
                    }
                }
                .clipped()
                .overlay {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.5), radius: 3)
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Camera")
        .accessibilityHint("Takes a photo or a video to send")
        .accessibilityIdentifier(A11y.Attach.camera)
    }
}

/// A square of the grid: a picture, a video's length, and the mark a tap toggles, numbered in the order picked.
private struct PickTile: View {
    let image: UIImage?
    /// A video's length, in its corner.
    let duration: Double?
    let number: Int?
    /// The message has all it can take, so this one can't be picked.
    let full: Bool
    let label: String
    let toggle: () -> Void

    @Environment(AppModel.self) private var model

    var body: some View {
        Button(action: toggle) {
            Theme.bg2
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    }
                }
                .clipped()
                .overlay(alignment: .bottomTrailing) {
                    if let duration {
                        Text(Format.duration(duration))
                            .font(.caption2.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.6), radius: 2)
                            .padding(5)
                    }
                }
                .overlay(alignment: .topTrailing) { check.padding(5) }
                .opacity(full ? 0.45 : 1)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(number.map { "Picked, number \($0)" } ?? "")
        .accessibilityAddTraits(number != nil ? .isSelected : [])
    }

    private var check: some View {
        ZStack {
            if let number {
                Circle().fill(model.settings.accent.color)
                Text("\(number)")
                    .font(.system(size: 13, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(model.settings.accent.onAccent)
            } else {
                Circle().fill(Color.black.opacity(0.15))
            }
            Circle().stroke(Color.white, lineWidth: 1.5)
        }
        .frame(width: 24, height: 24)
        .shadow(color: .black.opacity(0.25), radius: 2)
        .scaleEffect(number != nil ? 1 : 0.92)
        .animation(.spring(duration: 0.25, bounce: 0.4), value: number)
    }
}

/// A photo or video in the library.
private struct GalleryTile: View {
    let asset: PHAsset
    let number: Int?
    let full: Bool
    let toggle: () -> Void

    @State private var image: UIImage?

    private var video: Bool { asset.mediaType == .video }

    var body: some View {
        PickTile(image: image, duration: video ? asset.duration : nil, number: number, full: full, label: label, toggle: toggle)
            .task(id: asset.localIdentifier) { await load() }
    }

    private var label: String {
        let kind = video ? "Video, \(Format.duration(asset.duration))" : "Photo"
        guard let date = asset.creationDate else { return kind }
        return "\(kind), \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    /// A blurry picture at once and a sharp one when it's ready, as Photos gives them.
    private func load() async {
        let asset = asset
        let images = AsyncStream<UIImage> { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = true
            let request = PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 360, height: 360), contentMode: .aspectFill, options: options) { @Sendable image, info in
                if let image { continuation.yield(image) }
                let degraded = info?[PHImageResultIsDegradedKey] as? Bool ?? false
                if !degraded || info?[PHImageErrorKey] != nil || info?[PHImageCancelledKey] as? Bool == true { continuation.finish() }
            }
            continuation.onTermination = { _ in PHImageManager.default().cancelImageRequest(request) }
        }
        for await next in images { image = next }
    }
}

/// A photo or video the camera just took, which goes only into the message, not the library.
private struct TakenTile: View {
    let url: URL
    let number: Int?
    let full: Bool
    let toggle: () -> Void

    @State private var image: UIImage?
    @State private var duration: Double?

    private var video: Bool { UTType(filenameExtension: url.pathExtension)?.conforms(to: .movie) == true }

    var body: some View {
        PickTile(image: image, duration: duration, number: number, full: full, label: label, toggle: toggle)
            .task(id: url) { (image, duration) = await Self.preview(url, video: video) }
    }

    private var label: String {
        video ? "Video you took\(duration.map { ", \(Format.duration($0))" } ?? "")" : "Photo you took"
    }

    nonisolated private static func preview(_ url: URL, video: Bool) async -> (UIImage?, Double?) {
        if !video {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 360,
            ]
            let thumb = CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { CGImageSourceCreateThumbnailAtIndex($0, 0, options as CFDictionary) }
            return (thumb.map { UIImage(cgImage: $0) }, nil)
        }
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 360, height: 360)
        let frame = try? await generator.image(at: .zero).image
        let duration = try? await asset.load(.duration)
        return (frame.map { UIImage(cgImage: $0) }, duration.map(\.seconds))
    }
}

// MARK: The camera

/// What the back camera sees, live in its tile, as Telegram shows it. It only starts where Zuna
/// may use the camera already: the menu doesn't ask for it until the tile's tapped.
@MainActor
@Observable
final class CameraFeed {
    private(set) var running = false

    @ObservationIgnored private let session = AVCaptureSession()
    @ObservationIgnored private(set) lazy var preview: AVCaptureVideoPreviewLayer = {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        return layer
    }()
    @ObservationIgnored private let queue = DispatchQueue(label: "chat.zuna.camera-tile")
    /// Keeps the picture level with the screen as the phone turns.
    @ObservationIgnored private var rotation: AVCaptureDevice.RotationCoordinator?
    @ObservationIgnored private var rotationWatch: NSKeyValueObservation?

    func start() {
        guard !running, AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
        if session.inputs.isEmpty {
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
            session.beginConfiguration()
            session.sessionPreset = .medium
            session.addInput(input)
            session.commitConfiguration()
            let rotation = AVCaptureDevice.RotationCoordinator(device: camera, previewLayer: preview)
            self.rotation = rotation
            preview.connection?.videoRotationAngle = rotation.videoRotationAngleForHorizonLevelPreview
            rotationWatch = rotation.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] coordinator, _ in
                let angle = coordinator.videoRotationAngleForHorizonLevelPreview
                Task { @MainActor in self?.preview.connection?.videoRotationAngle = angle }
            }
        }
        running = true
        // Starting and stopping take a while, so they're done off the main thread, as Apple says.
        nonisolated(unsafe) let session = session
        queue.async { session.startRunning() }
    }

    func stop() {
        guard running else { return }
        running = false
        nonisolated(unsafe) let session = session
        queue.async { session.stopRunning() }
    }
}

/// The system's camera, for a photo or a video, handing back a file of what it took, or nil.
private struct CameraPicker: UIViewControllerRepresentable {
    let done: (URL?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeHigh
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (URL?) -> Void

        init(done: @escaping (URL?) -> Void) {
            self.done = done
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(CameraPicker.save(info))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            done(nil)
        }
    }

    /// What was taken, in a file named for when: a photo drawn upright, as not every app reads
    /// which way a photo's turned from its tags, or the video as it is.
    static func save(_ info: [UIImagePickerController.InfoKey: Any]) -> URL? {
        if let movie = info[.mediaURL] as? URL {
            guard let target = file("Video", movie.pathExtension.isEmpty ? "mov" : movie.pathExtension.lowercased()),
                  (try? FileManager.default.copyItem(at: movie, to: target)) != nil else { return nil }
            return target
        }
        guard let image = info[.originalImage] as? UIImage else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let jpeg = UIGraphicsImageRenderer(size: image.size, format: format).jpegData(withCompressionQuality: 0.9) { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        return write(jpeg)
    }

    #if DEBUG
    /// Coloured bars in place of a photo, as the simulator has no camera.
    static func fakePhoto() -> URL? {
        let size = CGSize(width: 1200, height: 900)
        let colors: [UIColor] = [.systemRed, .systemOrange, .systemYellow, .systemGreen, .systemTeal, .systemBlue, .systemPurple]
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let jpeg = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.9) { context in
            let width = size.width / CGFloat(colors.count)
            for (index, color) in colors.enumerated() {
                color.setFill()
                context.fill(CGRect(x: CGFloat(index) * width, y: 0, width: width + 1, height: size.height))
            }
        }
        return write(jpeg)
    }
    #endif

    private static func write(_ jpeg: Data) -> URL? {
        guard let target = file("Photo", "jpg"), (try? jpeg.write(to: target)) != nil else { return nil }
        return target
    }

    /// "Photo 2026-11-07 at 16.05.12.jpg", in a folder of its own.
    private static func file(_ kind: String, _ type: String) -> URL? {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return folder.appendingPathComponent("\(kind) \(formatter.string(from: .now)).\(type)")
    }
}

// MARK: The library

/// This phone's photos and videos, for the grid, once Zuna may see them.
@MainActor
@Observable
final class PhotoLibrary: NSObject, PHPhotoLibraryChangeObserver {
    struct Album: Identifiable {
        let id: String
        let title: String
        let collection: PHAssetCollection
    }

    private(set) var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    private(set) var assets = PHFetchResult<PHAsset>()
    private(set) var albums: [Album] = []
    /// The album shown, or nil for Recents: everything, newest first.
    var album: Album? {
        didSet { fetch() }
    }
    private var observing = false

    var allowed: Bool { status == .authorized || status == .limited }

    /// Asks to see the library the first time, as Telegram does when its menu opens.
    func start() async {
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard allowed else { return }
        if !observing {
            PHPhotoLibrary.shared().register(self)
            observing = true
        }
        loadAlbums()
        fetch()
    }

    deinit {
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in
            self.loadAlbums()
            self.fetch()
        }
    }

    /// Where only some photos are shared, lets the person change which.
    func manage() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        if let top { PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top) }
    }

    private static var mediaOptions: PHFetchOptions {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        return options
    }

    private func fetch() {
        guard allowed else { return }
        if let album {
            assets = PHAsset.fetchAssets(in: album.collection, options: Self.mediaOptions)
        } else {
            assets = PHAsset.fetchAssets(with: Self.mediaOptions)
        }
    }

    /// Favorites, the kinds Photos sorts out, and the person's own albums, leaving out empty ones.
    private func loadAlbums() {
        var collections: [PHAssetCollection] = []
        for subtype: PHAssetCollectionSubtype in [.smartAlbumFavorites, .smartAlbumVideos, .smartAlbumSelfPortraits, .smartAlbumScreenshots] {
            PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: subtype, options: nil).enumerateObjects { collection, _, _ in
                collections.append(collection)
            }
        }
        PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil).enumerateObjects { collection, _, _ in
            collections.append(collection)
        }
        let any = Self.mediaOptions
        any.fetchLimit = 1
        albums = collections
            .filter { PHAsset.fetchAssets(in: $0, options: any).count > 0 }
            .map { Album(id: $0.localIdentifier, title: $0.localizedTitle ?? "Album", collection: $0) }
        if let album, !albums.contains(where: { $0.id == album.id }) { self.album = nil }
    }

    /// Copies a photo or video out of the library as its file, edited if it was, from iCloud if it's only there.
    nonisolated static func export(_ id: String) async throws -> URL {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            throw CocoaError(.fileNoSuchFile)
        }
        let video = asset.mediaType == .video
        let resources = PHAssetResource.assetResources(for: asset)
        let original = resources.first { $0.type == (video ? .video : .photo) }
        guard let resource = resources.first(where: { $0.type == (video ? .fullSizeVideo : .fullSizePhoto) }) ?? original else {
            throw CocoaError(.fileNoSuchFile)
        }
        // An edit's file is called FullSizeRender, so it takes the original's name.
        let base = ((original ?? resource).originalFilename as NSString).deletingPathExtension
        let name = base + "." + (resource.originalFilename as NSString).pathExtension
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(name)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await PHAssetResourceManager.default().writeData(for: resource, toFile: target, options: options)
        return target
    }
}
