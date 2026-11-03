import SwiftUI
import ZunaModels

/// Making a channel, or changing one, for a server admin, as the desktop's
/// ChannelDialog: for a voice channel, also its sound, how many fit, and how
/// many can share a screen there.
struct ChannelEditor: View {
    enum Target: Identifiable, Hashable {
        case new(ChannelType, category: String)
        case edit(channelId: String)

        var id: String {
            switch self {
            case let .new(type, category): "new-\(type.rawValue)-\(category)"
            case let .edit(channelId): "edit-\(channelId)"
            }
        }
    }

    let serverId: String
    let target: Target
    /// A text channel opens once it's made, as on the desktop.
    var opensWhenMade = true

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var type = ChannelType.text
    @State private var name = ""
    @State private var topic = ""
    @State private var category = ""
    @State private var bitrate = 0
    @State private var userLimit = 0
    @State private var screenLimit = 0
    @State private var loaded = false
    @State private var busy = false
    @State private var confirmingDelete = false

    private var server: AppModel.ServerState? { model.servers[serverId] }

    private var channel: ChannelView? {
        guard case let .edit(id) = target else { return nil }
        return server?.channels.first { $0.id == id }
    }

    /// As the desktop offers them (AUDIO_QUALITIES in ChannelDialog.tsx), in kbit/s, 0 being the usual.
    private static let audioQualities: [(kbps: Int, label: String)] = [
        (0, "Usual (64 kbit/s)"), (96, "Better (96 kbit/s)"), (128, "Great (128 kbit/s)"), (256, "Best (256 kbit/s)"),
    ]

    /// How many may share a screen at once (SCREEN_LIMITS in ChannelDialog.tsx): 0 is the server's rules, -1 nobody.
    private static func screenLimitName(_ limit: Int) -> String {
        switch limit {
        case 0: "As the server's rules say"
        case -1: "Off in this channel"
        case 1: "One at a time"
        default: "Up to \(limit) at once"
        }
    }

    private var screenLimits: [Int] {
        let offered = [0, -1, 1, 2, 3, 4, 5, 10]
        return offered.contains(screenLimit) ? offered : offered + [screenLimit]
    }

    /// Text channels go by lowercase names with dashes, as in Discord, which also keeps them easy to mention.
    static func textName(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: #"\s+"#, with: "-", options: .regularExpression)
            .replacingOccurrences(of: #"-{2,}"#, with: "-", options: .regularExpression)
    }

    private var finalName: String {
        if type == .text {
            return Self.textName(name).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        }
        return name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                if channel == nil {
                    Section {
                        Picker("Type", selection: $type) {
                            Label("Text", systemImage: ChannelType.text.symbol).tag(ChannelType.text)
                            Label("Voice", systemImage: ChannelType.voice.symbol).tag(ChannelType.voice)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier(A11y.Channels.editorType)
                    } footer: {
                        Text(type == .text ? "Messages, pictures and files." : (server?.info?.voice ?? 0) > 0
                            ? "Talk, share a camera or a screen."
                            : "This server has no media server yet, so nobody can join voice channels. Whoever runs it can set up LiveKit.")
                    }
                }
                Section {
                    TextField(type == .text ? "new-channel" : "Lounge", text: Binding(get: { name }, set: { name = String($0.prefix(100)) }))
                        .textInputAutocapitalization(type == .text ? .never : .sentences)
                        .autocorrectionDisabled(type == .text)
                        .accessibilityIdentifier(A11y.Channels.editorName)
                } header: {
                    Text("Name")
                } footer: {
                    // Rewriting the field as it's typed would move the cursor, so it says what the name becomes instead.
                    if type == .text, !finalName.isEmpty, finalName != name {
                        Text("It'll be #\(finalName)")
                            .accessibilityIdentifier(A11y.Channels.editorFinalName)
                    }
                }
                Section("Topic") {
                    TextField("What it's for", text: Binding(get: { topic }, set: { topic = String($0.prefix(1024)) }), axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier(A11y.Channels.editorTopic)
                }
                Section {
                    TextField(type == .text ? "Text channels" : "Voice channels", text: Binding(get: { category }, set: { category = String($0.prefix(100)) }))
                        .accessibilityIdentifier(A11y.Channels.editorHeading)
                    let headings = Array(Set((server?.channels ?? []).map(\.category).filter { !$0.isEmpty })).sorted()
                    if !headings.isEmpty {
                        Menu("Use a heading there is") {
                            ForEach(headings, id: \.self) { heading in
                                Button(heading) { category = heading }
                            }
                        }
                    }
                } header: {
                    Text("Heading")
                } footer: {
                    Text("Channels with the same heading are listed together under it.")
                }
                if type == .voice {
                    voiceSection
                }
                if channel != nil {
                    Section {
                        Button("Delete channel", role: .destructive) { confirmingDelete = true }
                            .accessibilityIdentifier(A11y.Channels.delete)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle(channel == nil ? "New channel" : "Edit channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button(channel == nil ? "Create" : "Save", action: save)
                            .disabled(finalName.isEmpty)
                            .accessibilityIdentifier(A11y.Channels.editorSave)
                    }
                }
            }
            .confirmationDialog("Delete #\(channel?.title ?? "")? Its messages go for everyone.", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete channel", role: .destructive, action: remove)
            }
        }
        .accessibilityIdentifier(A11y.Channels.editor)
        .onAppear(perform: load)
    }

    private var voiceSection: some View {
        Section {
            Picker("Audio quality", selection: $bitrate) {
                ForEach(Self.audioQualities, id: \.kbps) { quality in
                    Text(quality.label).tag(quality.kbps)
                }
            }
            .accessibilityIdentifier(A11y.Channels.editorBitrate)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("People who fit")
                    Spacer()
                    Text(userLimit == 0 ? "No limit" : "\(userLimit)").foregroundStyle(Theme.text2).monospacedDigit()
                }
                Slider(value: Binding(get: { Double(userLimit) }, set: { userLimit = Int($0.rounded()) }), in: 0...99, step: 1)
                    .accessibilityLabel("People who fit")
                    .accessibilityValue(userLimit == 0 ? "No limit" : "\(userLimit)")
                    .accessibilityIdentifier(A11y.Channels.editorUserLimit)
            }
            Picker("Screen sharing", selection: $screenLimit) {
                ForEach(screenLimits, id: \.self) { limit in
                    Text(Self.screenLimitName(limit)).tag(limit)
                }
            }
            .accessibilityIdentifier(A11y.Channels.editorScreenLimit)
        } header: {
            Text("Voice")
        } footer: {
            Text("Screen sharing can be held to fewer at once here than the server's rules allow, or be off.")
        }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        switch target {
        case let .new(newType, newCategory):
            type = newType
            category = newCategory
        case .edit:
            guard let channel else { return }
            type = channel.type
            name = channel.name
            topic = channel.topic
            category = channel.category
            bitrate = channel.bitrate
            userLimit = channel.userLimit
            screenLimit = channel.screenLimit
        }
    }

    private func save() {
        let session = model.core.session(serverId)
        let voice = type == .voice
        let made = NewChannel(
            type: type,
            name: finalName,
            topic: topic.trimmingCharacters(in: .whitespacesAndNewlines),
            category: category.trimmingCharacters(in: .whitespacesAndNewlines),
            bitrate: voice ? bitrate : nil,
            userLimit: voice ? userLimit : nil,
            screenLimit: voice ? screenLimit : nil
        )
        let channel = channel
        busy = true
        Task {
            defer { busy = false }
            do {
                if let channel {
                    try await session.updateChannel(channel.id, ChannelChanges(name: made.name, topic: made.topic, category: made.category, bitrate: made.bitrate, userLimit: made.userLimit, screenLimit: made.screenLimit))
                    dismiss()
                } else {
                    let id = try await session.createChannel(made)
                    dismiss()
                    // Opening a voice channel is coming into it, which making one isn't asking for.
                    if made.type == .text, opensWhenMade { model.openChat("group:\(id)") }
                }
            } catch {
                model.toast(OnboardingText.describe(error), .error)
            }
        }
    }

    private func remove() {
        guard let channel else { return }
        let session = model.core.session(serverId)
        busy = true
        Task {
            defer { busy = false }
            do {
                try await session.deleteChannel(channel.id)
                if model.chatPath.contains(where: { $0 == .chat(channel.key) || $0 == .details(channel.key) }) { model.chatPath = [] }
                dismiss()
            } catch {
                model.toast(OnboardingText.describe(error), .error)
            }
        }
    }
}

/// A server's channels, for its admins: in order, to drag into another, and to
/// make, change or delete one.
struct ChannelsSettingsView: View {
    let serverId: String

    @Environment(AppModel.self) private var model
    @State private var editing: ChannelEditor.Target?
    /// While a row is being dragged, the order shown; otherwise, what the server says.
    @State private var order: [String]?

    var body: some View {
        let channels = model.servers[serverId]?.channels ?? []
        let byId = Dictionary(channels.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let shown = order.map { $0.compactMap { byId[$0] } } ?? channels
        List {
            Section {
                ForEach(shown) { channel in
                    Button {
                        editing = .edit(channelId: channel.id)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: channel.type.symbol)
                                .foregroundStyle(Theme.channelMuted)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(channel.title).foregroundStyle(Theme.text1)
                                Text(channel.category.isEmpty ? (channel.type == .voice ? "Voice channels" : "Text channels") : channel.category)
                                    .font(.caption)
                                    .foregroundStyle(Theme.text3)
                            }
                            Spacer()
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(channel.unreadable)
                    .accessibilityIdentifier(A11y.Channels.row(channel.id))
                }
                .onMove { source, destination in
                    var ids = shown.map(\.id)
                    ids.move(fromOffsets: source, toOffset: destination)
                    order = ids
                    Task {
                        do {
                            try await model.core.session(serverId).reorderChannels(ids)
                        } catch {
                            model.toast(OnboardingText.describe(error), .error)
                        }
                        order = nil
                    }
                }
                if channels.isEmpty {
                    Text("No channels yet. Everyone on the server can see and join the ones you make.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                }
            } footer: {
                Text("Everyone on the server can see and join every channel. Names and topics are encrypted, so the server can't read them. Drag to change the order, under Edit.")
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle("Channels")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editing = .new(.text, category: "")
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("New channel")
                .accessibilityIdentifier(A11y.Channels.newChannel)
            }
            if !channels.isEmpty {
                ToolbarItem(placement: .topBarTrailing) { EditButton() }
            }
        }
        .sheet(item: $editing) { target in
            ChannelEditor(serverId: serverId, target: target, opensWhenMade: false)
        }
        .accessibilityIdentifier(A11y.Channels.manage)
    }
}
