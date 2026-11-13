import AVFoundation
import SwiftUI
import UniformTypeIdentifiers
import ZunaModels

/// The soundboard from a call's controls: the server's sounds, any of which plays to
/// everyone in the room, and how loud they are here. The desktop's SoundboardPanel.
struct SoundboardSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var voice = voice
        let server = voice.serverId.flatMap { model.servers[$0] }
        let sounds = server?.sounds ?? []
        let refusal = voice.soundRefusal
        let isAdmin = server?.me?.role == .owner || server?.me?.role == .admin
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if sounds.isEmpty {
                        Text(isAdmin ? "This server has no sounds yet. Add some below." : "This server has no sounds yet. Admins can add them.")
                            .foregroundStyle(Theme.text2)
                    } else {
                        if let refusal {
                            Text(refusal)
                                .font(.subheadline)
                                .foregroundStyle(Theme.text2)
                                .accessibilityIdentifier(A11y.Voice.soundRefusal)
                        }
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 8) {
                            ForEach(sounds) { sound in
                                Button {
                                    Task { await voice.playSound(sound.id) }
                                } label: {
                                    HStack(spacing: 6) {
                                        Text(sound.emoji.isEmpty ? "🔊" : sound.emoji)
                                        Text(sound.name).lineLimit(1)
                                        Spacer(minLength: 0)
                                    }
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.text1)
                                    .padding(.horizontal, 12)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(Theme.bg3, in: .rect(cornerRadius: 12, style: .continuous))
                                    .contentShape(.rect(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .disabled(refusal != nil)
                                .opacity(refusal != nil ? 0.5 : 1)
                                .accessibilityLabel(sound.name)
                                .accessibilityIdentifier(A11y.Voice.sound(sound.name))
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Volume")
                            Spacer()
                            Text(voice.settings.soundboardVolume == 0 ? "Off" : "\(Int((voice.settings.soundboardVolume * 100).rounded()))%").foregroundStyle(Theme.text2).monospacedDigit()
                        }
                        Slider(value: $voice.settings.soundboardVolume, in: 0...1)
                            .accessibilityLabel("Soundboard volume")
                    }
                    .padding(14)
                    .background(Theme.bg2, in: .rect(cornerRadius: 14, style: .continuous))
                    if isAdmin, let serverId = server?.entry.id {
                        NavigationLink {
                            SoundboardSettingsView(serverId: serverId)
                        } label: {
                            HStack {
                                Text("Add and change sounds")
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(Theme.text3)
                            }
                            .foregroundStyle(Theme.text1)
                            .padding(14)
                            .background(Theme.bg2, in: .rect(cornerRadius: 14, style: .continuous))
                        }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1)
            .navigationTitle("Soundboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.Voice.soundboard)
    }
}

/// The soundboard in a server's settings, for its admins: adding sounds, listening to them,
/// renaming and deleting them. The desktop's ServerSoundboardSection.
struct SoundboardSettingsView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @Environment(VoiceModel.self) private var voice
    @State private var name = ""
    @State private var emoji = ""
    @State private var picked: URL?
    @State private var choosing = false
    @State private var busy = false
    @State private var renaming: SoundView?
    @State private var player: AVAudioPlayer?

    /// What a server can hold, as the server says.
    private static let most = 50

    var body: some View {
        let sounds = model.servers[serverId]?.sounds ?? []
        List {
            Section {
                TextField("Emoji", text: $emoji, prompt: Text("🔊"))
                    .accessibilityIdentifier(A11y.Settings.soundEmoji)
                TextField("Name", text: $name, prompt: Text("Airhorn"))
                    .accessibilityIdentifier(A11y.Settings.soundName)
                Button(picked.map { "Sound: \($0.lastPathComponent)" } ?? "Choose a sound") { choosing = true }
                    .accessibilityIdentifier(A11y.Settings.chooseSound)
                Button("Add sound") { add() }
                    .disabled(picked == nil || name.trimmingCharacters(in: .whitespaces).isEmpty || busy || sounds.count >= Self.most)
                    .accessibilityIdentifier(A11y.Settings.addSound)
            } header: {
                Text("Add a sound")
            } footer: {
                Text(sounds.count >= Self.most ? "The soundboard is full. Delete a sound to add another." : "Sounds that anyone in a voice channel or call can play for everyone there. Each one is trimmed to five seconds and leveled to match the others. Their names and audio are encrypted, so the server can't hear them.")
            }
            if !sounds.isEmpty {
                Section("\(sounds.count) of \(Self.most) sounds") {
                    ForEach(sounds) { sound in
                        HStack(spacing: 10) {
                            Text(sound.emoji.isEmpty ? "🔊" : sound.emoji)
                            Text(sound.name).lineLimit(1)
                            Spacer()
                            Text(String(format: "%.1f s", Double(sound.durationMs) / 1000)).foregroundStyle(Theme.text2).monospacedDigit()
                            Button {
                                listen(sound)
                            } label: {
                                Image(systemName: "play.fill")
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Listen to \(sound.name)")
                        }
                        .accessibilityIdentifier(A11y.Settings.sound(sound.name))
                        .swipeActions {
                            Button("Delete", role: .destructive) { remove(sound) }
                            Button("Rename") { renaming = sound }
                        }
                        .contextMenu {
                            Button("Rename", systemImage: "pencil") { renaming = sound }
                            Button("Delete", systemImage: "trash", role: .destructive) { remove(sound) }
                        }
                    }
                }
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Soundboard")
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.audio]) { result in
            guard case let .success(url) = result else { return }
            picked = url
            if name.trimmingCharacters(in: .whitespaces).isEmpty { name = String(url.deletingPathExtension().lastPathComponent.prefix(32)) }
        }
        .sheet(item: $renaming) { sound in
            SoundRename(serverId: serverId, sound: sound)
        }
    }

    private func add() {
        guard let picked else { return }
        let session = model.core.session(serverId)
        let name = name.trimmingCharacters(in: .whitespaces)
        let emoji = emoji.trimmingCharacters(in: .whitespaces)
        busy = true
        Task {
            do {
                let wav = try SoundFile.wav(from: picked)
                defer { try? FileManager.default.removeItem(atPath: wav.path) }
                _ = try await session.addSound(wav, name: name, emoji: emoji)
                model.toast("Added \(name)")
                self.picked = nil
                self.name = ""
                self.emoji = ""
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
            busy = false
        }
    }

    private func listen(_ sound: SoundView) {
        let session = model.core.session(serverId)
        let volume = voice.settings.soundboardVolume
        Task {
            guard let file = try? await session.soundFile(sound.id), let data = try? Data(contentsOf: URL(fileURLWithPath: file.path)), let player = try? AVAudioPlayer(data: data) else { return }
            player.volume = Float(volume > 0 ? volume : 0.6)
            self.player = player
            player.play()
        }
    }

    private func remove(_ sound: SoundView) {
        let session = model.core.session(serverId)
        Task {
            do { try await session.deleteSound(sound.id) } catch { model.toast(ErrorText.describe(error), .error) }
        }
    }
}

/// A sound's name and emoji, changed for everyone.
private struct SoundRename: View {
    let serverId: String
    let sound: SoundView

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var emoji = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Emoji", text: $emoji, prompt: Text("🔊"))
                TextField("Name", text: $name)
            }
            .navigationTitle("Rename sound")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear {
            name = sound.name
            emoji = sound.emoji
        }
    }

    private func save() {
        let session = model.core.session(serverId)
        let changes = SoundChanges(name: name.trimmingCharacters(in: .whitespaces), emoji: emoji.trimmingCharacters(in: .whitespaces))
        busy = true
        Task {
            do {
                try await session.updateSound(sound.id, changes)
                dismiss()
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
            busy = false
        }
    }
}

/// What someone picked, as the core makes a sound from: WAV in one channel at 48 kHz, of no
/// more than its first 20 seconds. The core cuts the silence and the rest, as on the desktop.
enum SoundFile {
    private static let rate = 48_000.0
    private static let longest = 20.0

    static func wav(from url: URL) throws -> WireFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            throw SoundError.unreadable
        }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: file.processingFormat, to: format),
              let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(rate * longest)),
              let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else { throw SoundError.unreadable }
        // Any other channels are mixed into the one.
        converter.downmix = true
        var failure: NSError?
        let status = converter.convert(to: output, error: &failure) { _, state in
            input.frameLength = 0
            if (try? file.read(into: input)) == nil || input.frameLength == 0 {
                state.pointee = .endOfStream
                return nil
            }
            state.pointee = .haveData
            return input
        }
        guard status != .error, output.frameLength > 0, let channel = output.floatChannelData?[0] else { throw SoundError.unreadable }

        var samples = Data(capacity: Int(output.frameLength) * 2)
        for index in 0..<Int(output.frameLength) {
            var sample = Int16(max(-32768, min(32767, (channel[index] * 32768).rounded()))).littleEndian
            withUnsafeBytes(of: &sample) { samples.append(contentsOf: $0) }
        }
        var wav = Data()
        func append<T>(_ value: T) {
            var value = value
            withUnsafeBytes(of: &value) { wav.append(contentsOf: $0) }
        }
        wav.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + samples.count).littleEndian)
        wav.append(contentsOf: Array("WAVEfmt ".utf8))
        append(UInt32(16).littleEndian)
        append(UInt16(1).littleEndian)
        append(UInt16(1).littleEndian)
        append(UInt32(rate).littleEndian)
        append(UInt32(rate * 2).littleEndian)
        append(UInt16(2).littleEndian)
        append(UInt16(16).littleEndian)
        wav.append(contentsOf: Array("data".utf8))
        append(UInt32(samples.count).littleEndian)
        wav.append(samples)

        let folder = OutgoingFiles.folder
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let target = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension("wav")
        try wav.write(to: target, options: .completeFileProtection)
        return WireFile(path: target.path, type: "audio/wav")
    }

    enum SoundError: LocalizedError {
        case unreadable
        var errorDescription: String? { "That file isn't a sound Zuna can read." }
    }
}
