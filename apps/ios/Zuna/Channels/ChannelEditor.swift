import SwiftUI
import ZunaModels

/// Making a channel, or changing one, for a server admin, as the desktop's
/// ChannelDialog: its slow mode, and for a voice channel also its sound, how many
/// fit, and how many can share a screen there.
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
    @State private var sounds = true
    @State private var watch = true
    @State private var adminOnly = false
    @State private var slowOn = false
    /// Slow mode's time, in seconds, kept while it's off so turning it on again brings it back.
    @State private var slowMode = 30
    @State private var loaded = false
    @State private var busy = false
    @State private var confirmingDelete = false
    /// Deleted from here, which isn't news to tell.
    @State private var removed = false

    private var server: AppModel.ServerState? { model.servers[serverId] }

    private var channel: ChannelView? {
        guard case let .edit(id) = target else { return nil }
        return server?.channels.first { $0.id == id }
    }

    /// Making one, rather than changing one, which stays so if the channel goes meanwhile.
    private var isNew: Bool {
        if case .new = target { true } else { false }
    }

    /// As the desktop offers them (AUDIO_QUALITIES in ChannelDialog.tsx), in kbit/s, 0 being the usual, each with its name's key.
    private static let audioQualities: [(kbps: Int, label: String)] = [
        (0, mark("channels.audio.standard")), (96, mark("channels.audio.better")),
        (128, mark("channels.audio.great")), (256, mark("channels.audio.best")),
    ]

    /// How many may share a screen at once (SCREEN_LIMITS in ChannelDialog.tsx): 0 is the server's rules, -1 nobody.
    private static func screenLimitName(_ limit: Int) -> String {
        switch limit {
        case 0: t("channels.dialog.screenDefault")
        case -1: t("common.off")
        case 1: t("channels.dialog.screenOne")
        default: t("channels.editor.screenUpTo", ["count": limit])
        }
    }

    private var screenLimits: [Int] {
        let offered = [0, -1, 1, 2, 3, 4, 5, 10]
        return offered.contains(screenLimit) ? offered : offered + [screenLimit]
    }

    private var slowModes: [Int] {
        Format.slowModeTimes.contains(slowMode) ? Format.slowModeTimes : Format.slowModeTimes + [slowMode]
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
                if isNew {
                    Section {
                        Picker(t("channels.form.type"), selection: $type) {
                            Label(t("channels.form.text"), systemImage: ChannelType.text.symbol).tag(ChannelType.text)
                            Label(t("channels.form.voice"), systemImage: ChannelType.voice.symbol).tag(ChannelType.voice)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier(A11y.Channels.editorType)
                    } footer: {
                        Text(type == .text ? t("channels.editor.textHint") : (server?.info?.voice ?? 0) > 0
                            ? t("channels.editor.voiceHint")
                            : t("channels.editor.noMediaServer"))
                    }
                }
                Section {
                    TextField(type == .text ? t("channels.dialog.textPlaceholder") : t("channels.dialog.voicePlaceholder"), text: Binding(get: { name }, set: { name = String($0.prefix(100)) }))
                        .textInputAutocapitalization(type == .text ? .never : .sentences)
                        .autocorrectionDisabled(type == .text)
                        .accessibilityIdentifier(A11y.Channels.editorName)
                } header: {
                    Text(t("common.name"))
                } footer: {
                    // Rewriting the field as it's typed would move the cursor, so it says what the name becomes instead.
                    if type == .text, !finalName.isEmpty, finalName != name {
                        Text(t("channels.editor.finalName", ["name": finalName]))
                            .accessibilityIdentifier(A11y.Channels.editorFinalName)
                    }
                }
                Section(t("channels.form.topic")) {
                    TextField(t("channels.form.topicPlaceholder"), text: Binding(get: { topic }, set: { topic = String($0.prefix(1024)) }), axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier(A11y.Channels.editorTopic)
                }
                Section {
                    TextField(type == .text ? t("channels.textChannels") : t("channels.voiceChannels"), text: Binding(get: { category }, set: { category = String($0.prefix(100)) }))
                        .accessibilityIdentifier(A11y.Channels.editorHeading)
                    let headings = Array(Set((server?.channels ?? []).map(\.category).filter { !$0.isEmpty })).sorted()
                    if !headings.isEmpty {
                        Menu(t("channels.editor.useHeading")) {
                            ForEach(headings, id: \.self) { heading in
                                Button(heading) { category = heading }
                            }
                        }
                    }
                } header: {
                    Text(t("channels.form.heading"))
                } footer: {
                    Text(t("channels.editor.headingHint"))
                }
                Section {
                    Toggle(t("channels.adminsOnly"), isOn: $adminOnly)
                        .accessibilityIdentifier(A11y.Channels.editorAdminOnly)
                } footer: {
                    Text(adminOnly && channel?.adminOnly == false ? t("channels.editor.adminOnlyNow") : t("channels.form.adminOnlyHint"))
                }
                Section {
                    Toggle(t("channels.form.slowMode"), isOn: $slowOn)
                        .accessibilityIdentifier(A11y.Channels.editorSlowMode)
                    if slowOn {
                        Picker(t("channels.form.slowModeTime"), selection: $slowMode) {
                            ForEach(slowModes, id: \.self) { seconds in
                                Text(Format.timer(seconds)).tag(seconds)
                            }
                        }
                        .accessibilityIdentifier(A11y.Channels.editorSlowModeTime)
                    }
                } footer: {
                    Text(t("channels.form.slowModeHint"))
                }
                if type == .voice {
                    voiceSection
                }
                if !isNew {
                    Section {
                        Button(t("channels.delete"), role: .destructive) { confirmingDelete = true }
                            .accessibilityIdentifier(A11y.Channels.delete)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg1)
            .navigationTitle(isNew ? t("channels.new") : t("channels.edit"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(t("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button(isNew ? t("common.create") : t("common.save"), action: save)
                            .disabled(finalName.isEmpty)
                            .accessibilityIdentifier(A11y.Channels.editorSave)
                    }
                }
            }
            .confirmationDialog(t("channels.deleteConfirm", ["name": channel?.title ?? ""]), isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button(t("channels.delete"), role: .destructive, action: remove)
            }
        }
        .accessibilityIdentifier(A11y.Channels.editor)
        .onAppear(perform: load)
        // Deleted by another admin meanwhile: there's nothing left to change.
        .onChange(of: !isNew && loaded && channel == nil) { _, gone in
            guard gone, !busy, !removed else { return }
            model.toast(t("channels.editor.deletedMeanwhile"))
            dismiss()
        }
    }

    private var voiceSection: some View {
        Section {
            Picker(t("channels.form.audioQuality"), selection: $bitrate) {
                ForEach(Self.audioQualities, id: \.kbps) { quality in
                    Text(t(quality.label)).tag(quality.kbps)
                }
            }
            .accessibilityIdentifier(A11y.Channels.editorBitrate)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(t("channels.editor.maxPeople"))
                    Spacer()
                    Text(userLimit == 0 ? t("common.noLimit") : "\(userLimit)").foregroundStyle(Theme.text2).monospacedDigit()
                }
                Slider(value: Binding(get: { Double(userLimit) }, set: { userLimit = Int($0.rounded()) }), in: 0...99, step: 1)
                    .accessibilityLabel(t("channels.editor.maxPeople"))
                    .accessibilityValue(userLimit == 0 ? t("common.noLimit") : "\(userLimit)")
                    .accessibilityIdentifier(A11y.Channels.editorUserLimit)
            }
            Picker(t("channels.form.screenSharing"), selection: $screenLimit) {
                ForEach(screenLimits, id: \.self) { limit in
                    Text(Self.screenLimitName(limit)).tag(limit)
                }
            }
            .accessibilityIdentifier(A11y.Channels.editorScreenLimit)
            Toggle(t("channels.form.soundboard"), isOn: $sounds)
                .accessibilityIdentifier(A11y.Channels.editorSounds)
            Toggle(t("channels.form.watch"), isOn: $watch)
                .accessibilityIdentifier(A11y.Channels.editorWatch)
        } header: {
            Text(t("channels.form.voice"))
        } footer: {
            Text(t("channels.editor.voiceFooter"))
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
            sounds = channel.sounds
            watch = channel.watch
            adminOnly = channel.adminOnly
            slowOn = channel.slowMode > 0
            if channel.slowMode > 0 { slowMode = channel.slowMode }
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
            screenLimit: voice ? screenLimit : nil,
            sounds: voice ? sounds : nil,
            watch: voice ? watch : nil,
            adminOnly: adminOnly,
            slowMode: slowOn ? slowMode : nil
        )
        let channel = channel
        guard isNew || channel != nil else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                if let channel {
                    try await session.updateChannel(channel.id, ChannelChanges(name: made.name, topic: made.topic, category: made.category, bitrate: made.bitrate, userLimit: made.userLimit, screenLimit: made.screenLimit, sounds: made.sounds, watch: made.watch, adminOnly: adminOnly, slowMode: slowOn ? slowMode : 0))
                    dismiss()
                } else {
                    let id = try await session.createChannel(made)
                    dismiss()
                    // Opening a voice channel is coming into it, which making one isn't asking for.
                    if made.type == .text, opensWhenMade { model.openChat("group:\(id)", channel: true) }
                }
            } catch {
                model.toast(ErrorText.describe(error), .error)
            }
        }
    }

    private func remove() {
        guard let channel else { return }
        let session = model.core.session(serverId)
        busy = true
        removed = true
        Task {
            defer { busy = false }
            do {
                try await session.deleteChannel(channel.id)
                if model.chatPath.contains(where: { $0 == .chat(channel.key) || $0 == .details(channel.key) }) { model.chatPath = [] }
                dismiss()
            } catch {
                model.toast(ErrorText.describe(error), .error)
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
                                Text(channel.category.isEmpty ? (channel.type == .voice ? t("channels.voiceChannels") : t("channels.textChannels")) : channel.category)
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
                            model.toast(ErrorText.describe(error), .error)
                        }
                        order = nil
                    }
                }
                if channels.isEmpty {
                    Text(t("channels.settings.empty"))
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                }
            } footer: {
                Text(t("channels.settings.footer"))
            }
        }
        .listRowBackground(Theme.bg2)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
        .navigationTitle(t("channels.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editing = .new(.text, category: "")
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel(t("channels.new"))
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
