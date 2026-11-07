import Photos
import PhotosUI
import SwiftUI
import ZunaModels

/// The attach menu, laid out as Telegram's: this phone's photos and videos, newest
/// first, numbered in the order they're picked, with a caption and Send once some
/// are, and tabs below for files and this device's location. What Telegram has
/// there and Zuna doesn't, such as the camera, polls and contacts, isn't.
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
    /// The photos and videos picked, by their identifiers in the library, in the order they were.
    @State private var picked: [String] = []
    @State private var sending = false
    @State private var choosingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var choosingFiles = false

    var body: some View {
        NavigationStack {
            Group {
                switch page {
                case .gallery:
                    GalleryPage(library: library, picked: $picked, room: room) { choosingPhotos = true }
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
        let ids = picked
        Task {
            var urls: [URL] = []
            for id in ids {
                do {
                    urls.append(try await PhotoLibrary.export(id))
                } catch {
                    model.toast("Couldn't add a photo or video: \(error.localizedDescription)", .error)
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

/// The grid of photos and videos, or why there isn't one.
private struct GalleryPage: View {
    let library: PhotoLibrary
    @Binding var picked: [String]
    let room: Int
    /// The system's photo picker, which needs no access to the library.
    let choosePhotos: () -> Void

    /// Three across on a phone, as Telegram's, and more on an iPad.
    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

    var body: some View {
        switch library.status {
        case .notDetermined:
            Color.clear
        case .denied, .restricted:
            denied
        default:
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
            if library.assets.count == 0 {
                Text(library.status == .limited ? "No photos or videos picked for Zuna yet." : "No photos or videos.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .padding(.top, 40)
            }
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(0..<library.assets.count, id: \.self) { index in
                    let asset = library.assets.object(at: index)
                    let number = picked.firstIndex(of: asset.localIdentifier).map { $0 + 1 }
                    GalleryTile(asset: asset, number: number, full: number == nil && picked.count >= room) {
                        toggle(asset.localIdentifier)
                    }
                    .accessibilityIdentifier(A11y.Attach.tile(index))
                }
            }
        }
        .sensoryFeedback(.selection, trigger: picked)
    }

    private func toggle(_ id: String) {
        if let index = picked.firstIndex(of: id) {
            picked.remove(at: index)
        } else if picked.count < room {
            picked.append(id)
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A photo or video in the grid: a tap picks it, and its number says in which order.
private struct GalleryTile: View {
    let asset: PHAsset
    let number: Int?
    /// The message has all it can take, so this one can't be picked.
    let full: Bool
    let toggle: () -> Void

    @Environment(AppModel.self) private var model
    @State private var image: UIImage?

    private var video: Bool { asset.mediaType == .video }

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
                    if video {
                        Text(Format.duration(asset.duration))
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
        .task(id: asset.localIdentifier) { await load() }
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
